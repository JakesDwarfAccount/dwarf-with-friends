// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// host/hostlib.mjs -- WT17 host-tooling core (the PURE, fixture-tested half).
//
// Everything the one-click installer (install.mjs) and the host management panel
// (host_panel.mjs) share: manifest resolution, DFHack detection, DF auto-detect,
// install-receipt read/write, round-tripping of the three plugin config files, the
// cloudflared-URL parser, atomic writes, and port fallback. Zero npm dependencies
// (node >= 18 stdlib only) -- the same constraint the game client lives under.
//
// The config-file names + semantics MIRROR the plugin source (single source of truth
// noted per constant); if the plugin changes a filename this file must change with it.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  statSync, readdirSync, renameSync, copyFileSync,
} from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- plugin file names
// All are read by the plugin relative to DF's WORKING DIRECTORY (the DF root). Each constant
// MIRRORS a C++ constant EXACTLY (single source of truth cited with file:line). The mixed
// `dfcapture` / `dwf` stems below are BY DESIGN, not drift: the ratified W9 rebrand renames only the
// PLUGIN-FILE identity (dll, lua bridge files, web dir) to `dwf`; the RUNTIME identifiers -- console
// commands (capture-stream-*, capture-join-password) and the config FILES they name -- deliberately
// stay `dfcapture` this wave. So hostlib mirrors each C++ constant VERBATIM; do NOT "fix" a name
// here without changing the paired C++ constant, or the host tooling and the running plugin would
// read/write different files.

// src/auth.h:63  kPasswordFile = "dfcapture_join_password.txt" -- first non-blank, non-'#' line ==
// the shared join passphrase. Loaded at plugin init and on `capture-join-password reload`; empty
// file => auth DISABLED. RUNTIME identifier -- stays `dfcapture` (ratified W9 scope); mirror it.
export const PASSWORD_FILE = "dfcapture_join_password.txt";

// src/pause_arbiter.cpp:421  kHostFlagsFile = "dwf_host_flags.txt" -- two `key=on|off` lines. Loaded
// ONCE at plugin init (compiled defaults: hostunpause off, autopause on); a rewrite takes effect on
// next DF restart. Already on the `dwf` stem in the C++; hostlib agrees.
export const HOST_FLAGS_FILE = "dwf_host_flags.txt";

// src/sound_route.cpp:43  kConfigPath = "dfhack-config/dfcapture.json" -- {"audio_remote": bool}.
// DEFAULT ON; only an explicit `false` disables. Re-read live on a 3s TTL, so an edit here takes
// effect WITHOUT a restart. RUNTIME identifier -- stays `dfcapture` (ratified W9 scope); mirror it.
export const SOUND_CONFIG_FILE = path.join("dfhack-config", "dfcapture.json");
// Host-tooling only (no C++ reader): the host panel's own port config.
export const PANEL_CONFIG_FILE = path.join("dfhack-config", "dwf-host-panel.json");

// Install receipt (written by install.mjs into the DF root so state travels with the install).
// Host-tooling only (no C++ reader).
export const RECEIPT_FILE = "dwf_install_receipt.json";

// The game server the plugin serves.
export const SERVER_PORT = 8765;
export const AUTH_COOKIE = "dfcap_auth";   // src/http_server.cpp:451,499 cookie_value(..., "dfcap_auth")
export const DFHACK_VERSION = "53.15-r2";

// ---------------------------------------------------------------- manifest resolution
// Release layout (what a packaged dwf release contains, post-W9 rename):
//   <release>/dwf.plug.dll          (CMake OUTPUT_NAME dwf -> dwf.plug.dll)
//   <release>/dwf.lua               (DFHack matches the lua module to the plugin BY FILENAME)
//   <release>/gui/dwf.lua           (the `gui/dwf` launcher script)
//   <release>/web/**                (the whole client tree)
// Deploy targets under <dfRoot>:
//   hack/plugins/dwf.plug.dll
//   hack/lua/plugins/dwf.lua        (the REAL path the plugin require()s)
//   hack/scripts/dwf.lua            (legacy path; kept in sync so the drift check stays green)
//   hack/scripts/gui/dwf.lua        (the `gui/dwf` launcher -- what users type to open the panel)
//   hack/dfcapture-web/**           (served web root)
// The web dir is deliberately NOT renamed to dwf-web (ratified wave-wide): the shipped plugin serves
// from a HARD-CODED path (src/web_assets.cpp:31  kWebRoot = "hack/dfcapture-web") that the pkg-rename
// lane was told NOT to touch this wave. Deploying to hack/dwf-web would make the running plugin 404
// index.html and fall back to its "web UI not found" stub. The deployed dir name MUST match what the
// plugin opens -> stays dfcapture-web.
// PURE: path arithmetic only -- resolvable and testable with no files on disk.
export function resolveManifest(dfRoot, releaseDir) {
  const j = path.join;
  return [
    { role: "dll", kind: "file",
      src: j(releaseDir, "dwf.plug.dll"),
      dest: j(dfRoot, "hack", "plugins", "dwf.plug.dll") },
    { role: "lua-plugins", kind: "file",
      src: j(releaseDir, "dwf.lua"),
      dest: j(dfRoot, "hack", "lua", "plugins", "dwf.lua") },
    { role: "lua-scripts", kind: "file",
      src: j(releaseDir, "dwf.lua"),
      dest: j(dfRoot, "hack", "scripts", "dwf.lua") },
    { role: "lua-gui", kind: "file",
      src: j(releaseDir, "gui", "dwf.lua"),
      dest: j(dfRoot, "hack", "scripts", "gui", "dwf.lua") },
    { role: "web", kind: "dir",
      src: j(releaseDir, "web"),
      dest: j(dfRoot, "hack", "dfcapture-web") },   // NOT dwf-web -- see note above (web_assets.cpp:31)
  ];
}

// ---------------------------------------------------------------- DFHack detection
export function dfhackMarkers(dfRoot) {
  return {
    dfRoot,
    dfExe:          path.join(dfRoot, "Dwarf Fortress.exe"),
    dfhackExe:      path.join(dfRoot, "dfhack.exe"),
    dfhackDll:      path.join(dfRoot, "dfhack.dll"),
    hackDir:        path.join(dfRoot, "hack"),
    hackPluginsDir: path.join(dfRoot, "hack", "plugins"),
    hackLuaPlugins: path.join(dfRoot, "hack", "lua", "plugins"),
  };
}

// Returns { ok, problems:[human strings], markers }. `exists` is injectable for tests.
export function checkDfhack(dfRoot, exists = existsSync) {
  const m = dfhackMarkers(dfRoot);
  const problems = [];
  if (!dfRoot) {
    problems.push("No Dwarf Fortress folder given. Pass one, e.g.  node host/install.mjs --df-root \"C:\\...\\Dwarf Fortress\"");
    return { ok: false, problems, markers: m };
  }
  if (!exists(dfRoot)) {
    problems.push(`That folder does not exist: ${dfRoot}`);
    return { ok: false, problems, markers: m };
  }
  if (!exists(m.dfExe)) {
    problems.push(`This does not look like a Dwarf Fortress install -- "Dwarf Fortress.exe" is not in ${dfRoot}.`);
  }
  if (!exists(m.hackDir)) {
    problems.push("DFHack is not installed here (no \"hack\" folder). In Steam: right-click Dwarf Fortress -> Properties -> Betas is not needed; instead subscribe to DFHack, or install it from dfhack.org, then run this again.");
  } else if (!exists(m.hackPluginsDir)) {
    problems.push("DFHack looks incomplete -- the \"hack\\plugins\" folder is missing. Reinstall/repair DFHack, then run this again.");
  }
  return { ok: problems.length === 0, problems, markers: m };
}

// Best-effort version detection for existing installs. DFHack distributions have changed their
// docs layout over time, so inspect a small set of known text markers. Unknown is distinct from
// compatible: callers can warn without falsely identifying an install as the wrong version.
export function inspectDfhackVersion(dfRoot, exists = existsSync, read = readFileSync) {
  const candidates = [
    path.join(dfRoot, ".dwf-dfhack-version"),
    path.join(dfRoot, "dfhack-version.txt"),
    path.join(dfRoot, "hack", "dfhack-version.txt"),
    // Official 53.15 zips ship NO docs pages at all, but hack/news.rst always opens with
    // "DFHack <version>" -- without this marker a stock manual install is undetectable, and an
    // undetected wrong version sailed straight through setup (issue #1).
    path.join(dfRoot, "hack", "news.rst"),
    path.join(dfRoot, "hack", "docs", "docs", "index.html"),
    path.join(dfRoot, "hack", "docs", "docs", "about", "Changelog.html"),
  ];
  for (const file of candidates) {
    if (!exists(file)) continue;
    try {
      const text = String(read(file, "utf8")).slice(0, 256 * 1024);
      const match = text.match(/(?:DFHack[\s:/-]*)?(\d+\.\d+-r\d+)/i);
      if (match) return { detected: true, version: match[1], compatible: match[1] === DFHACK_VERSION, source: file };
    } catch { /* try the next marker */ }
  }
  return { detected: false, version: null, compatible: null, source: null };
}

// ---------------------------------------------------------------- DF auto-detect
// Common Steam locations across the usual drive letters. PURE list builder (no disk touch).
export function steamDfCandidates(drives = ["C", "D", "E", "F", "G", "H"]) {
  const tails = [
    "SteamLibrary\\steamapps\\common\\Dwarf Fortress",
    "Steam\\steamapps\\common\\Dwarf Fortress",
    "Program Files (x86)\\Steam\\steamapps\\common\\Dwarf Fortress",
    "Program Files\\Steam\\steamapps\\common\\Dwarf Fortress",
    "Games\\Dwarf Fortress",
  ];
  const out = [];
  for (const d of drives) for (const t of tails) out.push(`${d}:\\${t}`);
  return out;
}

// Steam records every library folder it knows about in libraryfolders.vdf. Reading it finds
// installs on drives/paths the fixed list above never guesses (the whole point: strangers do not
// have their library where we do). PURE-ish: file readers are injectable for tests.
export const STEAM_VDFS = [
  "C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf",
  "C:\\Program Files\\Steam\\steamapps\\libraryfolders.vdf",
];
export function steamLibraryDfCandidates(
  exists = existsSync,
  readText = (p) => readFileSync(p, "utf8"),
  vdfs = STEAM_VDFS,
) {
  const out = [];
  for (const vdf of vdfs) {
    if (!exists(vdf)) continue;
    let text;
    try { text = readText(vdf); } catch { continue; }
    for (const m of String(text).matchAll(/"path"\s*"([^"]+)"/g)) {
      const lib = m[1].replace(/\\\\/g, "\\");
      out.push(path.join(lib, "steamapps", "common", "Dwarf Fortress"));
    }
  }
  return out;
}

// A folder is a DF install if it holds the game exe OR the vanilla raws. Deliberately WIDER than
// checkDfhack: the raws/art oracles in tools/ need only `data/vanilla`, not a DFHack install.
export function isDfRoot(dfRoot, exists = existsSync) {
  if (!dfRoot) return false;
  return exists(path.join(dfRoot, "Dwarf Fortress.exe")) ||
         exists(path.join(dfRoot, "data", "vanilla"));
}

// Steam's own library list FIRST (authoritative on a stranger's machine), then the fixed guesses.
export function dfCandidates(exists = existsSync, readText = (p) => readFileSync(p, "utf8")) {
  return [...steamLibraryDfCandidates(exists, readText), ...steamDfCandidates()];
}

// First candidate that passes checkDfhack; else first that is a DF install; else null.
export function autodetectDfRoot(candidates = null, exists = existsSync,
                                 readText = (p) => readFileSync(p, "utf8")) {
  const list = candidates || dfCandidates(exists, readText);
  for (const c of list) if (checkDfhack(c, exists).ok) return c;
  for (const c of list) if (isDfRoot(c, exists)) return c;   // DF, but no DFHack
  for (const c of list) if (exists(c)) return c;             // last resort: the folder is there
  return null;
}

// ---------------------------------------------------------------- DFHack build-tree auto-detect
// W22 uses the same split as DF-root resolution: this shipped host library owns the detection
// engine; tools/lib/dfroot.* owns argv/env precedence and failure policy.
export const DFHACK_BUILD_NAMES = ["build-msvc", "build", "build-vs2022", "build-vs2026"];

export function dfhackBuildCandidates(repoRoot = process.cwd()) {
  const out = [];
  const add = (p) => { if (!out.includes(p)) out.push(p); };
  let dir = path.resolve(repoRoot);
  for (let depth = 0; depth < 6; depth++) {
    for (const name of DFHACK_BUILD_NAMES) add(path.join(dir, name));
    // The common standalone layout is <workspace>/dfhack/<build-name> beside this repo.
    for (const name of DFHACK_BUILD_NAMES) add(path.join(dir, "dfhack", name));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function isDfhackBuild(buildRoot, exists = existsSync) {
  if (!buildRoot) return false;
  return exists(path.join(buildRoot, "CMakeCache.txt")) ||
         exists(path.join(buildRoot, "plugins", "external", "multi-dwarf", "Release",
                          "dwf.plug.dll"));   // CMake OUTPUT_NAME dwf (W9) -> dwf.plug.dll
}

export function autodetectDfhackBuild(candidates, exists = existsSync) {
  for (const c of candidates) if (isDfhackBuild(c, exists)) return c;
  return null;
}

// ---------------------------------------------------------------- atomic writes
export function atomicWrite(file, data) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, data);
  renameSync(tmp, file);   // atomic on the same filesystem
}
export function atomicWriteJSON(file, obj) {
  atomicWrite(file, JSON.stringify(obj, null, 2) + "\n");
}

// ---------------------------------------------------------------- install receipt
export function receiptPath(dfRoot) { return path.join(dfRoot, RECEIPT_FILE); }

export function makeReceipt({ dfRoot, releaseDir, entries = [], versions = {}, backupDir = null }) {
  return {
    schema: 1,
    tool: "dwf-host-installer",
    installedAt: new Date().toISOString(),
    dfRoot,
    releaseDir,
    versions,
    backupDir,
    files: entries.map((e) => ({ role: e.role, dest: e.dest })),
  };
}

export function readReceipt(dfRoot, exists = existsSync) {
  const p = receiptPath(dfRoot);
  if (!exists(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function writeReceipt(dfRoot, receipt) { atomicWriteJSON(receiptPath(dfRoot), receipt); }

// ---------------------------------------------------------------- join password
// Mirrors load_join_password_from_file(): first non-blank, non-'#' line, trimmed.
export function parsePassword(text) {
  if (text == null) return "";
  for (const raw of String(text).split(/\r?\n/)) {
    const t = raw.trim();
    if (t && t[0] !== "#") return t;
  }
  return "";
}
// Mirrors persist_password(): trimmed value + trailing newline, or empty file to DISABLE auth.
export function formatPassword(pw) {
  const t = String(pw ?? "").trim();
  return t ? t + "\n" : "";
}
export function passwordFilePath(dfRoot) { return path.join(dfRoot, PASSWORD_FILE); }
// A short memorable join password (word-word-NN). Not a cryptographic secret: it gates a
// friends-only tunnel URL that is itself unguessable; memorability beats entropy here.
const PW_ADJ = ["amber", "bold", "copper", "dusty", "flint", "golden", "iron", "jolly", "mossy", "rusty", "stone", "swift"];
const PW_NOUN = ["anvil", "badger", "beacon", "cavern", "dwarf", "forge", "hammer", "lantern", "marmot", "pick", "raven", "tunnel"];
export function generatePassword(rand = Math.random) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length];
  const nn = String(Math.floor(rand() * 90) + 10);
  return `${pick(PW_ADJ)}-${pick(PW_NOUN)}-${nn}`;
}
export function readPassword(dfRoot, exists = existsSync) {
  const p = passwordFilePath(dfRoot);
  return exists(p) ? parsePassword(readFileSync(p, "utf8")) : "";
}
export function writePassword(dfRoot, pw) { atomicWrite(passwordFilePath(dfRoot), formatPassword(pw)); }

// ---------------------------------------------------------------- host flags
// Mirrors pause_load_persisted_flags(): `key=on|off|1|true`. Compiled defaults below.
export function parseHostFlags(text) {
  const out = { hostunpause: false, autopause: true };
  if (text == null) return out;
  for (const raw of String(text).split(/\r?\n/)) {
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const k = raw.slice(0, eq).trim();
    const v = raw.slice(eq + 1).trim().toLowerCase();
    const on = v === "on" || v === "1" || v === "true";
    if (k === "hostunpause") out.hostunpause = on;
    else if (k === "autopause") out.autopause = on;
  }
  return out;
}
export function formatHostFlags(flags) {
  return `hostunpause=${flags.hostunpause ? "on" : "off"}\n` +
         `autopause=${flags.autopause ? "on" : "off"}\n`;
}
export function hostFlagsFilePath(dfRoot) { return path.join(dfRoot, HOST_FLAGS_FILE); }
export function readHostFlags(dfRoot, exists = existsSync) {
  const p = hostFlagsFilePath(dfRoot);
  return parseHostFlags(exists(p) ? readFileSync(p, "utf8") : null);
}
export function writeHostFlags(dfRoot, flags) { atomicWrite(hostFlagsFilePath(dfRoot), formatHostFlags(flags)); }

// ---------------------------------------------------------------- sound config (audio_remote)
// Mirrors scan_audio_remote(): DEFAULT ON; only an explicit `"audio_remote": false` disables.
export function parseAudioRemote(text) {
  if (text == null) return true;
  const m = String(text).match(/"audio_remote"\s*:\s*(true|false)/i);
  return m ? m[1].toLowerCase() === "true" : true;
}
export function formatSoundConfig(audioRemote) {
  return JSON.stringify({ audio_remote: !!audioRemote }, null, 2) + "\n";
}
export function soundConfigFilePath(dfRoot) { return path.join(dfRoot, SOUND_CONFIG_FILE); }
export function readAudioRemote(dfRoot, exists = existsSync) {
  const p = soundConfigFilePath(dfRoot);
  return parseAudioRemote(exists(p) ? readFileSync(p, "utf8") : null);
}
export function writeSoundConfig(dfRoot, audioRemote) {
  atomicWrite(soundConfigFilePath(dfRoot), formatSoundConfig(audioRemote));
}

// ---------------------------------------------------------------- host-panel config
export function validServerPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
export function panelConfigFilePath(dfRoot) { return path.join(dfRoot, PANEL_CONFIG_FILE); }
export function readPanelConfig(dfRoot, exists = existsSync) {
  const file = panelConfigFilePath(dfRoot);
  if (!exists(file)) return { port: SERVER_PORT };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { port: validServerPort(parsed.port) || SERVER_PORT };
  } catch { return { port: SERVER_PORT }; }
}
export function writePanelConfig(dfRoot, config) {
  atomicWriteJSON(panelConfigFilePath(dfRoot), { port: validServerPort(config.port) || SERVER_PORT });
}

// ---------------------------------------------------------------- cloudflared parsing
// Quick tunnels print a https://<random>.trycloudflare.com URL to stderr/log. Pull the first one.
export function parseCloudflaredUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return m ? m[0] : null;
}
// Decide what the hosting flow should do while a tunnel is up but no friend URL is known yet.
// PURE (all inputs injected) so the deadlock/timeout policy is fixture-testable:
//   "ready"      -- we have the URL.
//   "no-tunnel"  -- nothing is running; caller should start one.
//   "unreadable" -- a cloudflared we did NOT start is running and there is no log we can read:
//                   waiting would deadlock forever (the owner hit exactly this). Surface it NOW.
//   "timeout"    -- we have waited past timeoutMs; surface the log tail + a retry, never hang.
//   "wait"       -- keep polling.
export const LINK_WAIT_TIMEOUT_MS = 30000;
export function tunnelWaitVerdict({ url, running, logExists, startedByPanel, waitedMs,
                                    timeoutMs = LINK_WAIT_TIMEOUT_MS }) {
  if (url) return "ready";
  if (!running) return "no-tunnel";
  if (!logExists && !startedByPanel) return "unreadable";
  if (waitedMs >= timeoutMs) return "timeout";
  return "wait";
}

// When `capture-stream-start` fails, DFHack's raw output ("capture-stream-start is not a
// recognized command" -- issue #1) tells the host nothing actionable. That output means the dwf
// plugin never loaded; the two known causes are a DFHack version the DLL was not built for and a
// missing/never-installed DLL. PURE -- caller supplies the facts; returns null when the raw
// output is not a recognized-command failure (caller keeps its own message).
export function explainStreamStartFailure({ output, dllDeployed, version }) {
  if (!/not a recognized command/i.test(String(output || ""))) return null;
  if (version?.detected && version.compatible === false) {
    return `The Dwarf With Friends plugin did not load: DFHack ${version.version} is installed, but this ` +
      `build needs exactly DFHack ${DFHACK_VERSION}. Run DWF Setup to install DFHack ${DFHACK_VERSION}, ` +
      `then restart Dwarf Fortress and try again.`;
  }
  if (dllDeployed === false) {
    return "The Dwarf With Friends plugin (dwf.plug.dll) is not installed in DFHack. " +
      "Run DWF Setup to install the mod, then restart Dwarf Fortress and try again.";
  }
  return `DFHack did not load the Dwarf With Friends plugin. This usually means the installed DFHack ` +
    `is not the version this build needs (exactly ${DFHACK_VERSION}). Look for a plugin version error in ` +
    `the DFHack console or stderr.log, or run DWF Setup to repair the install.`;
}

// From a running cloudflared command line, recover the tunnel TARGET (`--url http://localhost:8765`),
// so the panel can tell "this cloudflared is pointing at our game server" vs. some other tunnel.
export function parseCloudflaredTarget(cmdline) {
  if (!cmdline) return null;
  const m = String(cmdline).match(/--url[=\s]+"?(https?:\/\/[^\s"]+)"?/i);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- job-object tunnel wrapper (Windows)
// THE GUARANTEE: cloudflared must NEVER outlive the host panel, no matter HOW the panel dies --
// Ctrl+C, cmd's "Terminate batch job (Y/N)?" answered Y (which force-kills node MID-cleanup),
// clicking the console window's X (CTRL_CLOSE_EVENT, which node surfaces unreliably and with a
// short OS deadline), a crash, or taskkill. Signal handlers cannot promise that: they only run
// for the signals node actually delivers, and 'exit' handlers must be synchronous. So the panel
// does not spawn cloudflared directly. It spawns THIS powershell wrapper as a plain (NOT
// detached) child, and the OS does the cleanup:
//
//   1. The wrapper creates a Win32 Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and holds
//      its ONLY handle. It assigns itself and the cloudflared it starts into that job.
//   2. When the wrapper process dies -- for ANY reason, graceful or TerminateProcess -- Windows
//      closes its handles. Closing the last job handle fires KILL_ON_JOB_CLOSE and the kernel
//      terminates every process in the job, i.e. cloudflared. No user code runs on this path.
//   3. The wrapper ties ITS lifetime to the panel's by polling the panel pid (HasExited): the
//      moment the panel is gone -- exited, killed, or terminated by the console closing -- the
//      wrapper exits, the job handle closes, cloudflared dies. Belt: it also Kill()s cloudflared
//      explicitly before exiting, so even a job-assignment failure still cleans up on this path.
//
// So the kill chain is panel dies (any means) -> wrapper notices (<=300ms) or is itself killed
// -> job handle closes -> KERNEL kills cloudflared. Nothing in the chain depends on which signal
// fired or on node running cleanup code. PURE builder (no spawn here) so it is fixture-testable;
// all variable data rides in env vars, never interpolated into the script (no quoting surface).
//
// TRADEOFF, on purpose: a tunnel started by the panel now ALWAYS dies with the panel, so a
// restarted panel can no longer adopt its previous run's tunnel (it is already dead). Adoption
// of a FOREIGN cloudflared (one the host started by hand) still surfaces via tunnelWaitVerdict's
// "unreadable" path. Guaranteed cleanup beats cross-restart adoption -- owner-ratified.
export const JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;   // winnt.h JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
const TUNNEL_WRAPPER_PS = `
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$src = @'
using System;
using System.Runtime.InteropServices;
public static class DwfJob {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMITS {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMITS {
    public BASIC_LIMITS BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(
    IntPtr j, int c, ref EXTENDED_LIMITS i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  public static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    EXTENDED_LIMITS info = new EXTENDED_LIMITS();
    info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMITS))))
      return IntPtr.Zero; // a job that cannot kill-on-close is useless to us
    return job;
  }
}
'@
$job = [IntPtr]::Zero
try {
  Add-Type -TypeDefinition $src -ErrorAction Stop
  $job = [DwfJob]::Create()
  if ($job -ne [IntPtr]::Zero) {
    [void][DwfJob]::AssignProcessToJobObject($job, [System.Diagnostics.Process]::GetCurrentProcess().Handle)
  }
} catch { $job = [IntPtr]::Zero }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:DWF_TUNNEL_EXE
$psi.Arguments = $env:DWF_TUNNEL_ARGS
$psi.UseShellExecute = $false
$cf = [System.Diagnostics.Process]::Start($psi)
if ($job -ne [IntPtr]::Zero) { [void][DwfJob]::AssignProcessToJobObject($job, $cf.Handle) }
$panel = $null
try { $panel = Get-Process -Id ([int]$env:DWF_PANEL_PID) -ErrorAction Stop } catch {}
while (($panel -ne $null) -and (-not $panel.HasExited) -and (-not $cf.HasExited)) {
  Start-Sleep -Milliseconds 300
}
if (-not $cf.HasExited) { try { $cf.Kill() } catch {} }
exit 0
`;
// Args are pre-quoted into ONE string because ProcessStartInfo.Arguments is a raw command line.
function quoteArg(a) { return /[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a); }
export function tunnelWrapperCommand({ exe, args, panelPid }) {
  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
           "-EncodedCommand", Buffer.from(TUNNEL_WRAPPER_PS, "utf16le").toString("base64")],
    env: {
      DWF_TUNNEL_EXE: String(exe),
      DWF_TUNNEL_ARGS: (args || []).map(quoteArg).join(" "),
      DWF_PANEL_PID: String(panelPid),
    },
  };
}

// ---------------------------------------------------------------- port fallback
// First p in [start, start+tries) for which isFree(p) is truthy; -1 if none. PURE (isFree injected).
export function pickPort(start, isFree, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const p = start + i;
    if (isFree(p)) return p;
  }
  return -1;
}

// ---------------------------------------------------------------- recursive copy (installer)
// Copy a file or directory tree src -> dest. Calls onFile(destPath) per file copied. Returns count.
export function copyTree(src, dest, onFile) {
  let n = 0;
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const e of readdirSync(src)) n += copyTree(path.join(src, e), path.join(dest, e), onFile);
  } else {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    if (onFile) onFile(dest);
    n = 1;
  }
  return n;
}

// A filesystem-safe timestamp for backup dir names: 2026-07-11T03-14-09-123Z
export function tsStamp(d = new Date()) {
  return d.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}
