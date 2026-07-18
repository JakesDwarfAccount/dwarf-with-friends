// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// host/host_panel.mjs -- local host management panel for dwf. Plain node, ZERO npm deps
// (a single-file stdlib http server).
//
//   node host/host_panel.mjs [--df-root "<path>"] [--port <n>] [--open]
//
// Binds 127.0.0.1 ONLY (never 0.0.0.0 -- this is a control surface, not a public page), picks a
// free port near a random base, and prints the URL. One page, three headed sections (no tabs --
// this is a single-purpose page and lays out like one):
//   STATUS         Start hosting + DF running? stream answering (/version)? world loaded
//                  (/host-state), player count (/diag).
//   FRIEND ACCESS  the friend link BIG with one-click copy, and the join password beside it
//                  (show/hide, copy, set/change/turn off -- LIVE via the plugin's host-only
//                  POST /join-password route; file dfcapture_join_password.txt for cold starts).
//   TUNNEL & CONTROLS  start/stop cloudflared (stop CONFIRMS the process exited before claiming
//                  the link is dead), start/stop DF, open game view, log tail, advanced config.
//
// To reach the game server's protected endpoints (/host-state, /diag) the panel reads the join
// password from disk and sends it as the dfcap_auth cookie -- exactly what a browser client does.
//
// Windows-first (tasklist/taskkill/Start-Process). Degrades politely elsewhere (process controls
// disabled, everything else works).

import http from "node:http";
import {
  readFileSync, existsSync, createWriteStream,
  openSync, closeSync, fstatSync, readSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  SERVER_PORT, AUTH_COOKIE,
  checkDfhack, autodetectDfRoot, dfhackMarkers,
  readPassword, writePassword, passwordFilePath, generatePassword,
  readHostFlags, writeHostFlags,
  readAudioRemote, writeSoundConfig,
  readPanelConfig, writePanelConfig, validServerPort,
  parseCloudflaredUrl, tunnelWaitVerdict, LINK_WAIT_TIMEOUT_MS,
  inspectDfhackVersion, explainStreamStartFailure,
  tunnelWrapperCommand,
} from "./hostlib.mjs";
import { fetchCloudflared } from "./fetchers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const CF_LOG = path.join(HERE, "cloudflared.log");

// ---------------------------------------------------------------- join-password DEFAULT POLICY
// What a FRESH install starts with, applied ONCE at panel startup and ONLY when the password file
// does not exist yet (an existing file -- even an explicitly empty one -- is the host's choice and
// is never overwritten). OWNER-RATIFIED default: "open".
//   "open"     -- no join password. Friends join with just the link; the trycloudflare URL is
//                 itself unguessable, and the panel shows the open state honestly with a
//                 one-click "Set a password" control (never a silently-empty unlabeled field).
//   "generate" -- auto-create a short memorable password (word-word-NN) at first start instead.
// Flip this one string to change the shipped default.
const DEFAULT_PASSWORD_POLICY = "open";
function applyDefaultPasswordPolicy() {
  if (!DF_ROOT || existsSync(passwordFilePath(DF_ROOT))) return;
  writePassword(DF_ROOT, DEFAULT_PASSWORD_POLICY === "generate" ? generatePassword() : "");
}

// How long "waiting for the friend link" may spin before the panel surfaces the log + a Retry.
// Env override exists so the harness can exercise the timeout without a 30-second test.
const LINK_TIMEOUT_MS = parseInt(process.env.DWF_LINK_TIMEOUT_MS ?? "", 10) || LINK_WAIT_TIMEOUT_MS;

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const out = { dfRoot: "", port: 0, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--df-root") out.dfRoot = argv[++i] ?? "";
    else if (a === "--port") out.port = parseInt(argv[++i] ?? "0", 10) || 0;
    else if (a === "--open") out.open = true;
    else if (a === "--help" || a === "-h") { console.log("node host/host_panel.mjs [--df-root <path>] [--port <n>] [--open]"); process.exit(0); }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------- DF root resolution
let DF_ROOT = ARGS.dfRoot || autodetectDfRoot() || "";
const DF_OK = DF_ROOT ? checkDfhack(DF_ROOT).ok : false;
let GAME_PORT = DF_ROOT ? readPanelConfig(DF_ROOT).port : SERVER_PORT;
applyDefaultPasswordPolicy();   // fresh install only -- see DEFAULT_PASSWORD_POLICY above

// ---------------------------------------------------------------- small promise wrappers
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

// GET a path on the game server (127.0.0.1:8765) with the auth cookie. Short timeout so a dead
// server fails fast. Returns { ok, status, json|null, error|null }.
function gameGet(pathname, { withAuth = true, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (withAuth && DF_ROOT) {
      const pw = readPassword(DF_ROOT);
      if (pw) headers["Cookie"] = `${AUTH_COOKIE}=${encodeURIComponent(pw)}`;
    }
    const req = http.get({ host: "127.0.0.1", port: GAME_PORT, path: pathname, headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* not json */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, body });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, json: null, error: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, status: 0, json: null, error: e.code || e.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST a form to the game server (the plugin's own host-only routes, e.g. /join-password).
// `cookiePw` must be the password the server CURRENTLY has in memory -- i.e. the OLD one when
// changing passwords -- or the pre-routing auth gate rejects us.
function gamePostForm(pathname, form, { cookiePw = "", timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const body = new URLSearchParams(form).toString();
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    };
    if (cookiePw) headers["Cookie"] = `${AUTH_COOKIE}=${encodeURIComponent(cookiePw)}`;
    const req = http.request(
      { host: "127.0.0.1", port: GAME_PORT, path: pathname, method: "POST", headers, timeout: timeoutMs },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(b); } catch { /* not json */ }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
        });
      });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, json: null, error: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, status: 0, json: null, error: e.code || e.message }));
    req.end(body);
  });
}

// tasklist-based process presence (Windows). Returns true/false; false on non-Windows.
async function processRunning(imageName) {
  if (!IS_WIN) return false;
  const r = await run("tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/NH", "/FO", "CSV"]);
  return r.stdout.toLowerCase().includes(imageName.toLowerCase());
}

// The command line of a running process (Windows, via wmic/CIM). Best-effort; "" if unavailable.
async function processCmdline(imageName) {
  if (!IS_WIN) return "";
  // PowerShell CIM query is more reliable than deprecated wmic on modern Windows.
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${imageName}'" | Select-Object -ExpandProperty CommandLine`;
  const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  return r.ok ? r.stdout.trim() : "";
}

// ---------------------------------------------------------------- cloudflared helpers
function cloudflaredUrlFromLog() {
  try {
    if (existsSync(CF_LOG)) return parseCloudflaredUrl(readFileSync(CF_LOG, "utf8"));
  } catch { /* ignore */ }
  return null;
}

// Read from the end so a noisy/retrying tunnel can never make a panel refresh load an unbounded
// file into memory. The first partial line is discarded when the byte window starts mid-file.
function cloudflaredLogTail(maxBytes = 64 * 1024, maxLines = 120) {
  if (!existsSync(CF_LOG)) return { exists: false, text: "", truncated: false };
  let fd;
  try {
    fd = openSync(CF_LOG, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8").replace(/\r\n/g, "\n");
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    }
    const lines = text.split("\n");
    const lineTrimmed = lines.length > maxLines;
    if (lineTrimmed) text = lines.slice(-maxLines).join("\n");
    return { exists: true, text, truncated: start > 0 || lineTrimmed };
  } catch (error) {
    return { exists: true, text: "", truncated: false, error: String(error.message || error) };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}
async function cloudflaredOnPath() {
  const bundled = path.join(HERE, "cloudflared.exe");
  if (existsSync(bundled)) return bundled;
  const r = await run(IS_WIN ? "where" : "which", ["cloudflared"]);
  return r.ok && r.stdout.trim() ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

// ---------------------------------------------------------------- API handlers
async function apiStatus() {
  const dfRunning = (await processRunning("Dwarf Fortress.exe")) || (await processRunning("dfhack.exe"));
  const version = await gameGet("/version", { withAuth: false });
  const server = {
    answering: version.ok,
    build: version.json?.build ?? null,
    authRequired: version.json?.authRequired ?? null,
    error: version.error ?? null,
  };
  let world = { worldLoaded: null, mapLoaded: null, paused: null, error: null };
  let players = null;
  if (version.ok) {
    const hs = await gameGet("/host-state");
    if (hs.ok && hs.json) world = { worldLoaded: hs.json.worldLoaded, mapLoaded: hs.json.mapLoaded, paused: hs.json.paused, error: null };
    else world.error = hs.status === 401 ? "auth (set the join password below)" : (hs.error || `http ${hs.status}`);
    const dg = await gameGet("/diag");
    if (dg.ok && dg.json?.overall) players = dg.json.overall.players;
  }
  return { dfRoot: DF_ROOT, dfOk: DF_OK, dfRunning, port: GAME_PORT, server, world, players };
}

async function apiLinks() {
  const running = await processRunning("cloudflared.exe");
  const url = cloudflaredUrlFromLog();
  const installed = await cloudflaredOnPath();
  return {
    // 127.0.0.1, NOT localhost: cookies are host-scoped (not port-scoped), so any big cookie set
    // by another app on the shared "localhost" hostname (e.g. a ~2.5 KB Supabase auth-token from a
    // dev app on localhost:<other-port>) rides along on the /ws handshake and can overflow the
    // server's Upgrade-classifier header peek -> WS never connects -> the client silently drops to
    // terrain-less HTTP polling. The loopback IP literal carries no such foreign cookie jar, so the
    // host's own "open locally" link is robust regardless of what else the browser has on localhost.
    localUrl: `http://127.0.0.1:${GAME_PORT}/view`,
    cloudflared: {
      running,
      url: running ? url : null,
      installed: !!installed,
      installedPath: installed,
      target: `http://localhost:${GAME_PORT}`,
    },
  };
}

function apiAccess() {
  // `suggestion` feeds the UI's Generate button (same generator as DEFAULT_PASSWORD_POLICY
  // "generate", so a host-picked and a policy-picked password look alike).
  if (!DF_ROOT) return { dfRoot: null, password: "", authEnabled: false, suggestion: generatePassword() };
  const pw = readPassword(DF_ROOT);
  return { dfRoot: DF_ROOT, password: pw, authEnabled: !!pw, suggestion: generatePassword() };
}

function apiConfig() {
  if (!DF_ROOT) return { dfRoot: null };
  return {
    dfRoot: DF_ROOT,
    password: readPassword(DF_ROOT),
    hostFlags: readHostFlags(DF_ROOT),
    audioRemote: readAudioRemote(DF_ROOT),
    port: GAME_PORT,
  };
}

// ---- mutations ----
// LIVE password reset. Persist to disk (survives restarts, and the plugin loads it at init), then
// apply it to the RUNNING server via its host-only POST /join-password route (loopback-gated; the
// point-and-click twin of the console command) so NEW joins need the new password immediately.
// The route needs a cookie carrying the password the server currently holds, so read it FIRST.
// Honesty contract: already-connected players are NOT kicked by a password change -- their live
// WS session stands until they leave (kicking mid-session would need a plugin change). Say so.
async function setAccess(body) {
  if (!DF_ROOT) return { ok: false, error: "no DF root" };
  const next = String(body.password ?? "").trim();
  const prev = readPassword(DF_ROOT);
  writePassword(DF_ROOT, next);
  const posture = next
    ? "New joins need the new password. Players already connected keep playing until they leave."
    : "The password is off — anyone with the friend link can join.";
  const live = await gamePostForm("/join-password", next ? { password: next } : { off: "1" },
                                  { cookiePw: prev });
  if (live.ok && live.json?.ok) return { ok: true, applied: true, note: `Saved and live now. ${posture}` };
  // Server not running (or the route predates this build): the file is written, which is all a
  // cold start needs. Applies at next launch, or `capture-join-password reload` in the console.
  return { ok: true, applied: false,
    note: "Saved. The game server isn’t answering, so it takes effect when hosting starts " +
          "(or run `capture-join-password reload` in the DFHack console)." };
}

function setConfig(body) {
  if (!DF_ROOT) return { ok: false, error: "no DF root" };
  const notes = [];
  if (body.hostFlags) {
    writeHostFlags(DF_ROOT, {
      hostunpause: !!body.hostFlags.hostunpause,
      autopause: !!body.hostFlags.autopause,
    });
    notes.push("Host flags saved -- these load at DF startup (effective next restart).");
  }
  if (typeof body.audioRemote === "boolean") {
    writeSoundConfig(DF_ROOT, body.audioRemote);
    notes.push("Audio setting saved -- effective within a few seconds (no restart needed).");
  }
  if (body.port != null) {
    const port = validServerPort(body.port);
    if (!port) return { ok: false, error: "The game connection port must be a whole number from 1 to 65535." };
    GAME_PORT = port;
    writePanelConfig(DF_ROOT, { port });
    notes.push(`Game connection port saved as ${port} -- effective the next time hosting starts.`);
  }
  return { ok: true, note: notes.join(" ") };
}

async function launchDwarf() {
  if (!DF_OK) return { ok: false, error: "Dwarf Fortress or DFHack was not found. Run DWF Setup to verify and repair it." };
  if ((await processRunning("Dwarf Fortress.exe")) || (await processRunning("dfhack.exe"))) {
    return { ok: true, note: "Dwarf Fortress is already running." };
  }
  const markers = dfhackMarkers(DF_ROOT);
  const exe = existsSync(markers.dfhackExe) ? markers.dfhackExe : markers.dfExe;
  if (!existsSync(exe)) return { ok: false, error: `Dwarf Fortress launcher not found: ${exe}` };
  try {
    const child = spawn(exe, [], { cwd: DF_ROOT, detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return { ok: true, note: `Launched ${path.basename(exe)}.` };
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
}

async function serverAction(body) {
  const action = body.action;
  const confirm = body.confirm === true;
  const destructive = action === "stop-df" || action === "stop-cf" || action === "start-df";
  if (destructive && !confirm) return { ok: false, error: "confirmation required" };
  if (!IS_WIN) return { ok: false, error: "process controls are Windows-only on this build" };

  if (action === "start-df") {
    const result = await launchDwarf();
    if (result.ok) result.note += " Now load your fortress.";
    return result;
  }

  if (action === "stop-df") {
    const r1 = await run("taskkill", ["/IM", "Dwarf Fortress.exe", "/F"]);
    const r2 = await run("taskkill", ["/IM", "dfhack.exe", "/F"]);
    const killed = r1.ok || r2.ok;
    return { ok: true, note: killed ? "Stop signal sent to Dwarf Fortress." : "No running Dwarf Fortress process was found." };
  }

  if (action === "start-cf") {
    const cf = await cloudflaredOnPath();
    if (!cf) return { ok: false, error: "cloudflared is missing. Click Fetch cloudflared now, then start the tunnel again." };
    try {
      const logStream = createWriteStream(CF_LOG, { flags: "w" });
      await new Promise((res) => logStream.once("open", res));
      // NOT spawned directly, and NOT detached: cloudflared runs inside a powershell wrapper that
      // puts it in a kill-on-close Win32 Job Object and watches the panel pid (see hostlib.mjs,
      // tunnelWrapperCommand). If this panel process dies BY ANY MEANS -- Ctrl+C, the .cmd's
      // "Terminate batch job (Y/N)?" Y force-kill, the console window's X, a crash, taskkill --
      // the wrapper exits, the job handle closes, and the KERNEL kills cloudflared. The signal
      // handlers below remain the graceful path (friendly messages); this is the OS-level backstop.
      // The wrapper inherits our logStream, so cloudflared's output still lands in CF_LOG.
      const wrap = tunnelWrapperCommand({
        exe: cf, args: ["tunnel", "--url", `http://localhost:${GAME_PORT}`], panelPid: process.pid,
      });
      const child = spawn(wrap.file, wrap.args, {
        env: { ...process.env, ...wrap.env },
        stdio: ["ignore", logStream, logStream], windowsHide: true,
      });
      child.unref();   // never hold the event loop open; lifetime is tied by the job, not this handle
      TUNNEL.startedByPanel = true;   // fresh log, ours to read
      TUNNEL.pid = child.pid || 0;    // the WRAPPER pid: taskkill /PID /T takes wrapper + cloudflared
      if (!TUNNEL.linkWaitStartedAt) TUNNEL.linkWaitStartedAt = Date.now();
      return { ok: true, note: "cloudflared starting -- the friend link appears above in a few seconds." };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  if (action === "fetch-cf") {
    const result = await fetchCloudflared({ dwfRoot: HERE });
    if (result.ok) return { ok: true, note: result.alreadyInstalled
      ? "cloudflared is already installed and verified."
      : "cloudflared downloaded and SHA-256 verified. You can start the tunnel now." };
    return result;
  }

  if (action === "stop-cf") return stopCloudflaredConfirmed();

  return { ok: false, error: `unknown action: ${action}` };
}

// STOP MUST PROVE IT STOPPED: taskkill alone is a request, not a fact. Poll the process table
// until cloudflared is actually GONE before reporting "stopped" -- the UI flips to "friend link
// is dead" only on stopped:true, never on internal bookkeeping. (~5s worst case, then honest
// failure.) Also collapses the hosting flow so a stale friend URL can't linger on screen.
async function stopCloudflaredConfirmed() {
  const wasRunning = await processRunning("cloudflared.exe");
  // Pid-targeted first: kill OUR wrapper tree (powershell + its cloudflared). The /IM sweep stays
  // as the fallback for a link the panel presents without a pid (foreign/adopted cloudflared) --
  // the same fair-game set this button has always killed.
  if (TUNNEL.pid) await run("taskkill", ["/PID", String(TUNNEL.pid), "/T", "/F"]);
  await run("taskkill", ["/IM", "cloudflared.exe", "/F"]);
  let gone = !(await processRunning("cloudflared.exe"));
  for (let i = 0; !gone && i < 15; i++) {
    await sleep(300);
    gone = !(await processRunning("cloudflared.exe"));
  }
  if (gone) {
    setHosting("stopped", "Tunnel stopped — the friend link is dead.", { friendUrl: null });
    TUNNEL.startedByPanel = false;
    TUNNEL.linkWaitStartedAt = 0;
    TUNNEL.pid = 0;   // nothing left to clean up at exit (Stop button then Ctrl+C stays idempotent)
    return { ok: true, stopped: true,
      note: wasRunning ? "Tunnel stopped — the friend link is now dead."
                       : "No tunnel was running — the friend link is already dead." };
  }
  return { ok: false, stopped: false,
    error: "cloudflared is STILL RUNNING — the stop did not take. The friend link may still work. " +
           "Try again, or end cloudflared.exe in Task Manager." };
}

// ---------------------------------------------------------------- one-button hosting flow
const HOSTING = { phase: "idle", message: "Ready to host.", error: null, friendUrl: null };
// Tunnel bookkeeping: did WE spawn the current cloudflared (so its log is ours to read), when did
// the link wait start (so the wait can time out instead of spinning forever), and the SPECIFIC
// wrapper pid we spawned (so cleanup can taskkill /PID /T the wrapper+cloudflared tree instead of
// image-name-nuking a host's unrelated cloudflared). Note: since the job-object wrapper ties the
// tunnel's lifetime to THIS panel process, a panel-spawned tunnel can never survive into a later
// panel run -- startedByPanel:false + running:true now only means a FOREIGN cloudflared.
export const TUNNEL = { startedByPanel: false, linkWaitStartedAt: 0, pid: 0 };
let hostingTimer = null;
let hostingBusy = false;
function setHosting(phase, message, extra = {}) { Object.assign(HOSTING, { phase, message, error: null, ...extra }); }
function scheduleHosting(ms = 2000) {
  clearTimeout(hostingTimer);
  hostingTimer = setTimeout(hostingTick, ms);
  hostingTimer.unref?.();
}
async function hostingTick() {
  if (hostingBusy || !["waiting-world", "starting-stream", "starting-tunnel", "waiting-link"].includes(HOSTING.phase)) return;
  hostingBusy = true;
  try {
    const version = await gameGet("/version", { withAuth: false, timeoutMs: 900 });
    if (!version.ok && (HOSTING.phase === "waiting-world" || HOSTING.phase === "starting-stream")) {
      const dfhackRun = path.join(DF_ROOT, "hack", "dfhack-run.exe");
      if (!existsSync(dfhackRun)) throw new Error(`DFHack control tool is missing: ${dfhackRun}. Run DWF Setup to repair DFHack.`);
      const world = await run(dfhackRun, ["lua", "print(dfhack.world.isFortressMode())"], { timeout: 4000 });
      if (!world.ok || !/\btrue\b/i.test(world.stdout)) {
        setHosting("waiting-world", "Now load your fortress — I’ll wait.");
        return scheduleHosting();
      }
      setHosting("starting-stream", "Fortress loaded. Starting the browser stream…");
      const started = await run(dfhackRun, ["capture-stream-start", String(GAME_PORT), "127.0.0.1"], { timeout: 10000 });
      if (!started.ok) {
        const raw = (started.stderr || started.stdout || "").trim();
        // "not a recognized command" = the plugin never loaded (wrong DFHack version or missing
        // DLL, issue #1). Diagnose and say what to actually do instead of echoing DFHack.
        const explained = explainStreamStartFailure({
          output: raw,
          dllDeployed: existsSync(path.join(DF_ROOT, "hack", "plugins", "dwf.plug.dll")),
          version: inspectDfhackVersion(DF_ROOT),
        });
        throw new Error(explained || raw ||
          `Could not start the stream. In the DFHack console, run: capture-stream-start ${GAME_PORT} 127.0.0.1`);
      }
      return scheduleHosting(1000);
    }
    if (!version.ok) return scheduleHosting();

    const links = await apiLinks();
    if (!links.cloudflared.installed) throw new Error("cloudflared is missing. Run DWF Setup to repair step 5, then try again.");
    // NEVER a silent infinite wait: tunnelWaitVerdict (hostlib, fixture-tested) decides between
    // starting our own tunnel, waiting (bounded), and SURFACING the two stuck cases -- a foreign
    // cloudflared whose log we cannot read, and a wait that blew past the timeout.
    const verdict = tunnelWaitVerdict({
      url: links.cloudflared.url,
      running: links.cloudflared.running,
      logExists: existsSync(CF_LOG),
      startedByPanel: TUNNEL.startedByPanel,
      waitedMs: TUNNEL.linkWaitStartedAt ? Date.now() - TUNNEL.linkWaitStartedAt : 0,
      timeoutMs: LINK_TIMEOUT_MS,
    });
    if (verdict === "no-tunnel") {
      setHosting("starting-tunnel", "Stream is live. Starting the private link for your friends…");
      const tunnel = await serverAction({ action: "start-cf", confirm: true });
      if (!tunnel.ok) throw new Error(tunnel.error || "cloudflared did not start");
      TUNNEL.startedByPanel = true;
      TUNNEL.linkWaitStartedAt = Date.now();
      return scheduleHosting(1500);
    }
    if (verdict === "unreadable") {
      setHosting("link-stuck",
        "A tunnel is already running, but it wasn’t started here so I can’t read its link.",
        { error: "Found an existing cloudflared this panel can’t read. Restart the tunnel to get a fresh friend link (the old one stops working)." });
      return;   // no reschedule -- the host acts via Restart the tunnel
    }
    if (verdict === "timeout") {
      setHosting("link-stuck",
        `No friend link after ${Math.round(LINK_TIMEOUT_MS / 1000)} seconds.`,
        { error: "Cloudflare did not hand out a link in time. Check the tunnel log below, then hit Restart the tunnel." });
      return;   // no reschedule -- the host acts via Restart the tunnel
    }
    if (verdict === "wait") {
      if (!TUNNEL.linkWaitStartedAt) TUNNEL.linkWaitStartedAt = Date.now();
      setHosting("waiting-link", "Stream is live. Waiting for Cloudflare to make the friend link…");
      return scheduleHosting();
    }
    TUNNEL.linkWaitStartedAt = 0;
    setHosting("ready", "Your game is live. Send this to your friends.", { friendUrl: links.cloudflared.url });
  } catch (error) {
    setHosting("error", "Hosting stopped before the friend link was ready.", { error: String(error.message || error), friendUrl: null });
  } finally { hostingBusy = false; }
}

// Retry from a stuck link wait: confirmed-kill whatever cloudflared is there (ours or foreign),
// then spawn OUR OWN with a fresh log we can read, and resume the normal wait (with timeout).
async function retryLink() {
  if (!["link-stuck", "waiting-link", "error", "stopped"].includes(HOSTING.phase)) return hostingState();
  const stopped = await stopCloudflaredConfirmed();
  if (!stopped.ok) {
    setHosting("link-stuck", "Could not restart the tunnel.", { error: stopped.error });
    return hostingState();
  }
  setHosting("starting-tunnel", "Restarting the tunnel…");
  const tunnel = await serverAction({ action: "start-cf", confirm: true });
  if (!tunnel.ok) {
    setHosting("error", "The tunnel did not restart.", { error: tunnel.error });
    return hostingState();
  }
  TUNNEL.startedByPanel = true;
  TUNNEL.linkWaitStartedAt = Date.now();
  setHosting("waiting-link", "Tunnel restarted. Waiting for the fresh friend link…");
  scheduleHosting(1500);
  return hostingState();
}

async function startHosting() {
  if (!["idle", "error", "stopped"].includes(HOSTING.phase)) return hostingState();
  setHosting("launching", "Opening Dwarf Fortress…", { friendUrl: null });
  const launched = await launchDwarf();
  if (!launched.ok) {
    setHosting("error", "Dwarf Fortress did not open.", { error: launched.error });
    return hostingState();
  }
  setHosting("waiting-world", "Now load your fortress — I’ll wait.");
  scheduleHosting(500);
  return hostingState();
}
function hostingState() {
  return { ...HOSTING, password: DF_ROOT ? readPassword(DF_ROOT) : "", port: GAME_PORT };
}

// ---------------------------------------------------------------- HTTP server
function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function sendJSON(res, obj, status = 200) { send(res, status, JSON.stringify(obj)); }

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

function serveFile(res, file, type) {
  try { send(res, 200, readFileSync(file), type); }
  catch { send(res, 404, "not found", "text/plain"); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;
  try {
    if (p === "/" || p === "/index.html") return serveFile(res, path.join(HERE, "panel.html"), "text/html; charset=utf-8");
    if (p === "/panel.css") return serveFile(res, path.join(HERE, "panel.css"), "text/css; charset=utf-8");
    if (p === "/panel.js")  return serveFile(res, path.join(HERE, "panel.js"),  "text/javascript; charset=utf-8");

    if (p === "/api/status") return sendJSON(res, await apiStatus());
    if (p === "/api/links")  return sendJSON(res, await apiLinks());
    if (p === "/api/cloudflared-log") return sendJSON(res, cloudflaredLogTail());
    if (p === "/api/access") {
      if (req.method === "POST") return sendJSON(res, await setAccess(await readBody(req)));
      return sendJSON(res, apiAccess());
    }
    if (p === "/api/config") {
      if (req.method === "POST") return sendJSON(res, setConfig(await readBody(req)));
      return sendJSON(res, apiConfig());
    }
    if (p === "/api/hosting") {
      if (req.method === "POST") {
        const body = await readBody(req);
        return sendJSON(res, body.action === "retry-link" ? await retryLink() : await startHosting());
      }
      return sendJSON(res, hostingState());
    }
    if (p === "/api/server" && req.method === "POST") return sendJSON(res, await serverAction(await readBody(req)));

    send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e) {
    sendJSON(res, { ok: false, error: String(e.message || e) }, 500);
  }
});

// ---------------------------------------------------------------- listen with fallback
async function listen() {
  const base = ARGS.port || (8790 + Math.floor(Math.random() * 40));
  for (let i = 0; i < 60; i++) {
    const port = base + i;
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener("listening", onOk); reject(e); };
        const onOk = () => { server.removeListener("error", onErr); resolve(); };
        server.once("error", onErr);
        server.once("listening", onOk);
        server.listen(port, "127.0.0.1");
      });
      return port;
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
      if (ARGS.port) throw e; // an explicit port that's busy is a hard error
    }
  }
  throw new Error("no free port found near " + base);
}

// ---------------------------------------------------------------- terminal-exit tunnel cleanup
// The GRACEFUL half of shutdown. The GUARANTEED half is the job-object wrapper (hostlib.mjs
// tunnelWrapperCommand + the start-cf spawn above): the kernel kills cloudflared when this
// process dies by ANY means, including the paths no handler can cover -- cmd's "Terminate batch
// job (Y/N)?" answered Y (force-kills node MID-cleanup), the console window's X (CTRL_CLOSE_EVENT
// reaches node unreliably and with a short OS deadline), crashes, taskkill /F. These handlers
// exist so the COMMON exits (Ctrl+C, Ctrl+Break, SIGTERM, window close when SIGHUP does arrive)
// also print the honest "friend link is dead" message and exit 0 instead of relying on the
// backstop silently.
//
// Rules: pid-targeted (taskkill /PID <wrapper> /T /F takes the wrapper AND its cloudflared) so a
// host's unrelated cloudflared is never image-name-nuked -- the image-name kill is the fallback
// ONLY when the panel is presenting a friend link it has no pid for (a foreign tunnel, same
// fair-game set the Stop button already kills). Best-effort and CAPPED (hard-exit timer) -- a
// slow kill may never hang Ctrl+C -- and a SECOND Ctrl+C force-exits immediately. Idempotent
// with the Stop button: a confirmed stop clears TUNNEL.pid, so a later Ctrl+C just exits.
let SHUTTING_DOWN = false;
export async function stopTunnelOnExit() {
  if (!IS_WIN) return true;
  if (TUNNEL.pid) {
    await run("taskkill", ["/PID", String(TUNNEL.pid), "/T", "/F"], { timeout: 3000 });
  } else if (TUNNEL.startedByPanel || HOSTING.friendUrl) {
    await run("taskkill", ["/IM", "cloudflared.exe", "/F"], { timeout: 3000 });
  } else {
    return true;   // no tunnel of ours -- nothing to do
  }
  // Short capped confirm poll -- best effort on the exit path, never the Stop button's full 5s.
  let gone = !(await processRunning("cloudflared.exe"));
  for (let i = 0; !gone && i < 4; i++) { await sleep(250); gone = !(await processRunning("cloudflared.exe")); }
  // Keep TUNNEL.pid until the kill is CONFIRMED so the synchronous 'exit' fallback can retry it.
  if (gone) { TUNNEL.pid = 0; TUNNEL.startedByPanel = false; }
  return gone;
}
function shutdown(signal) {
  if (SHUTTING_DOWN) process.exit(1);   // impatient second Ctrl+C: force-exit NOW
  SHUTTING_DOWN = true;
  const hardStop = setTimeout(() => process.exit(1), 4000);   // cap: never hang the exit on a slow kill
  hardStop.unref?.();
  (async () => {
    try {
      if (IS_WIN && (TUNNEL.pid || TUNNEL.startedByPanel || HOSTING.friendUrl)) {
        console.log(`\n  ${signal}: stopping the tunnel so the friend link dies with the panel…`);
        const gone = await stopTunnelOnExit();
        console.log(gone ? "  Tunnel stopped — the friend link is dead."
                         : "  cloudflared may still be running — check Task Manager for cloudflared.exe.");
      }
    } catch { /* best effort -- exit anyway */ }
    process.exit(0);
  })();
}
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  try { process.on(sig, () => shutdown(sig)); } catch { /* not supported on this platform */ }
}
// Last-resort fallback: an exit no signal handler saw (process.exit elsewhere, fatal error) must
// still not orphan a tunnel we spawned. 'exit' handlers must be synchronous; pid-only, best-effort.
process.on("exit", () => {
  if (IS_WIN && TUNNEL.pid) {
    try { execFileSync("taskkill", ["/PID", String(TUNNEL.pid), "/T", "/F"], { stdio: "ignore", timeout: 3000 }); }
    catch { /* best effort */ }
  }
});

const port = await listen();
const uiUrl = `http://127.0.0.1:${port}/`;
console.log(`\n  dwf host panel  ->  ${uiUrl}`);
console.log(`  Dwarf Fortress:       ${DF_ROOT ? DF_ROOT + (DF_OK ? "" : "  (DFHack not detected)") : "NOT FOUND -- pass --df-root <path>"}`);
console.log(`  (localhost only; Ctrl+C to stop)\n`);
if (ARGS.open && IS_WIN) run("cmd", ["/c", "start", "", uiUrl]);
