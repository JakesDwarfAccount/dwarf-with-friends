// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Local, dependency-free setup/repair wizard. All mutations happen only after an
// explicit browser action; getSetupState() is read-only and fixture-testable.

import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DFHACK_VERSION, autodetectDfRoot, checkDfhack, inspectDfhackVersion, readReceipt,
} from "./hostlib.mjs";
import { bakeSprites, spriteBakeState } from "./bake_sprites.mjs";
import { fetchCloudflared, fetchDfhack, loadDownloadManifest, sha256File } from "./fetchers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DWF_ROOT = path.dirname(HERE);
const RELEASE_DIR = existsSync(path.join(DWF_ROOT, "release"))
  ? path.join(DWF_ROOT, "release") : path.join(HERE, "release");
const PANEL_LAUNCHER = path.join(DWF_ROOT, "Dwarf With Friends.cmd");
const SHORTCUT_NAME = "Dwarf With Friends.lnk";
const shortcutCandidates = () => [
  path.join(os.homedir(), "Desktop", SHORTCUT_NAME),
  path.join(process.env.OneDrive || path.join(os.homedir(), "OneDrive"), "Desktop", SHORTCUT_NAME),
];
const shortcutPath = () => shortcutCandidates().find((file) => existsSync(file)) || shortcutCandidates()[0];
const IS_WIN = process.platform === "win32";

let selectedDfRoot = "";
let allowWrongVersion = false;

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 120000, ...options },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout || "", stderr: stderr || "", error }));
  });
}

export function validateDfRoot(candidate, exists = existsSync) {
  const value = String(candidate || "").trim().replace(/^"|"$/g, "");
  if (!value) return { ok: false, error: "Paste the folder that contains Dwarf Fortress.exe." };
  if (!exists(value)) return { ok: false, error: `That folder does not exist: ${value}` };
  if (!exists(path.join(value, "Dwarf Fortress.exe"))) {
    return { ok: false, error: `That folder does not contain Dwarf Fortress.exe: ${value}` };
  }
  return { ok: true, dfRoot: value };
}

// Steam's DFHack app lives beside Dwarf Fortress and/or has app manifest 2346660.
// This is a warning, not proof that the separate app is currently wired into DF.
export function detectSteamDfhack(dfRoot, exists = existsSync) {
  if (!dfRoot) return { detected: false, markers: [] };
  const common = path.dirname(dfRoot);
  const steamapps = path.dirname(common);
  const candidates = [
    path.join(common, "DFHack"),
    path.join(steamapps, "appmanifest_2346660.acf"),
  ];
  const markers = candidates.filter((p) => exists(p));
  return { detected: markers.length > 0, markers };
}

export function cloudflaredState(dwfRoot = HERE, exists = existsSync, manifest = loadDownloadManifest()) {
  const executable = path.join(dwfRoot, "cloudflared.exe");
  if (!exists(executable)) return { ok: false, executable, note: "cloudflared is not installed yet." };
  try {
    const expected = String(manifest.cloudflared?.sha256 || "").toLowerCase();
    const actual = sha256File(executable).toLowerCase();
    return expected.length === 64 && actual === expected
      ? { ok: true, executable, note: "cloudflared is installed and verified." }
      : { ok: false, executable, note: "cloudflared is present but does not match the verified release. Repair it." };
  } catch (error) {
    return { ok: false, executable, note: `Could not verify cloudflared: ${error.message}` };
  }
}

export function setupSnapshot({ dfRoot, exists = existsSync, installOk = null,
  receipt = undefined, sprites = undefined, cloudflared = undefined, shortcutExists = undefined } = {}) {
  const root = dfRoot || "";
  const df = validateDfRoot(root, exists);
  const hack = df.ok ? checkDfhack(root, exists) : { ok: false, problems: [] };
  const version = hack.ok ? inspectDfhackVersion(root, exists) : { detected: false, compatible: null };
  const steam = df.ok ? detectSteamDfhack(root, exists) : { detected: false, markers: [] };
  const rec = receipt === undefined && df.ok ? readReceipt(root, exists) : receipt;
  const sprite = sprites || { bakeable: false, missingSources: [], missingBaked: [], bakedPresent: [] };
  const installComplete = installOk === true || (installOk == null && !!rec);
  const spriteComplete = installComplete && (!sprite.bakeable || sprite.missingBaked.length === 0);
  return {
    dfRoot: root,
    allowWrongVersion,
    steps: {
      df: { ok: df.ok, error: df.ok ? null : (df.error || "Dwarf Fortress was not found."), dfRoot: root },
      dfhack: {
        ok: hack.ok && (version.compatible !== false || allowWrongVersion), installed: hack.ok,
        missing: df.ok && !hack.ok, wrongVersion: hack.ok && version.compatible === false,
        version, steam, problems: hack.problems || [],
      },
      install: { ok: installComplete, receipt: rec || null },
      sprites: {
        ok: spriteComplete, classic: installComplete && !sprite.bakeable,
        state: sprite,
      },
      cloudflared: cloudflared || { ok: false, note: "cloudflared is not installed yet." },
      finish: { ok: shortcutExists === true, shortcut: shortcutPath() },
    },
  };
}

async function installCheck(dfRoot) {
  const result = await run(process.execPath, [path.join(HERE, "install.mjs"), "--df-root", dfRoot,
    "--release", RELEASE_DIR, "--check", "--json"]);
  try { return JSON.parse(result.stdout); } catch { return { ok: false }; }
}

export async function getSetupState() {
  if (!selectedDfRoot) selectedDfRoot = autodetectDfRoot() || "";
  const df = validateDfRoot(selectedDfRoot);
  if (!df.ok) return setupSnapshot({ dfRoot: selectedDfRoot });
  const install = await installCheck(selectedDfRoot);
  return setupSnapshot({
    dfRoot: selectedDfRoot,
    installOk: install.ok === true,
    receipt: readReceipt(selectedDfRoot),
    sprites: spriteBakeState({ dfRoot: selectedDfRoot }),
    cloudflared: cloudflaredState(),
    shortcutExists: shortcutCandidates().some((file) => existsSync(file)),
  });
}

async function createShortcut() {
  if (!IS_WIN) return { ok: false, error: "Desktop shortcut creation is available on Windows only." };
  if (!existsSync(PANEL_LAUNCHER)) {
    return { ok: false, error: `The launcher is missing: ${PANEL_LAUNCHER}. Re-extract the DWF zip, then run setup again.` };
  }
  const escapedTarget = PANEL_LAUNCHER.replace(/'/g, "''");
  const script = `$w=New-Object -ComObject WScript.Shell;` +
    `$desktop=$w.SpecialFolders.Item('Desktop');$shortcut=Join-Path $desktop '${SHORTCUT_NAME}';` +
    `$s=$w.CreateShortcut($shortcut);$s.TargetPath='${escapedTarget}';` +
    `$s.WorkingDirectory='${DWF_ROOT.replace(/'/g, "''")}';$s.Save();Write-Output $shortcut`;
  // Resolve powershell.exe by absolute path: a trimmed PATH turns bare "powershell.exe" into a
  // raw "spawn powershell.exe ENOENT". %SystemRoot%\System32\WindowsPowerShell\v1.0 is always present.
  const powershellExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const result = await run(powershellExe, ["-NoProfile", "-NonInteractive", "-Command", script]);
  const created = result.stdout.trim();
  if (result.ok && created && existsSync(created)) return { ok: true, note: "Desktop shortcut created." };
  const detail = String(result.stderr || result.error?.message || "Windows did not create the shortcut.").replace(/\s+/g, " ").trim();
  return { ok: false, error: `Could not create the desktop shortcut automatically (${detail}). You can still host: double-click "${PANEL_LAUNCHER}", or make a shortcut to it yourself.` };
}

async function action(body) {
  const name = body.action;
  if (name === "choose-df") {
    const checked = validateDfRoot(body.path);
    if (!checked.ok) return checked;
    selectedDfRoot = checked.dfRoot; allowWrongVersion = false;
    return { ok: true, note: "Dwarf Fortress folder found." };
  }
  const df = validateDfRoot(selectedDfRoot);
  if (!df.ok) return df;
  if (name === "install-dfhack") return fetchDfhack({ dfRoot: selectedDfRoot });
  if (name === "proceed-wrong-dfhack") {
    allowWrongVersion = true;
    return { ok: true, note: `Continuing with the installed DFHack version. DWF is built for exactly ${DFHACK_VERSION}; repair this if the mod does not load.` };
  }
  if (name === "install-mod") {
    const hack = checkDfhack(selectedDfRoot);
    const version = inspectDfhackVersion(selectedDfRoot);
    if (!hack.ok || (version.compatible === false && !allowWrongVersion)) {
      return { ok: false, error: "Finish the DFHack step before installing Dwarf With Friends." };
    }
    const result = await run(process.execPath, [path.join(HERE, "install.mjs"), "--df-root", selectedDfRoot,
      "--release", RELEASE_DIR, "--yes", "--json"]);
    try { return JSON.parse(result.stdout); }
    catch { return { ok: false, error: (result.stderr || "The mod installer did not return a result.").trim() }; }
  }
  if (name === "bake-sprites") {
    const result = bakeSprites({ dfRoot: selectedDfRoot });
    if (result.ok) return { ...result, note: `Baked ${result.written.length} sprite files from your Dwarf Fortress art.` };
    const classic = result.problems.some((p) => /DF art|graphical/i.test(p));
    return classic
      ? { ok: true, classic: true, note: "Premium art was not found (DF Classic). DWF still works; friends will see simple placeholders for these sprites." }
      : { ...result, error: result.problems.join(" ") };
  }
  if (name === "fetch-cloudflared") return fetchCloudflared({ dwfRoot: HERE });
  if (name === "create-shortcut") return createShortcut();
  if (name === "open-panel") {
    const child = spawn(process.execPath, [path.join(HERE, "host_panel.mjs"), "--df-root", selectedDfRoot, "--open"],
      { cwd: DWF_ROOT, detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return { ok: true, note: "Host panel opened." };
  }
  return { ok: false, error: `Unknown setup action: ${name}` };
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body);
}
function serve(res, file, type) {
  try { send(res, 200, readFileSync(file), type); } catch { send(res, 404, "not found", "text/plain"); }
}
function readBody(req) {
  return new Promise((resolve) => { let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } }); });
}

async function main() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (url.pathname === "/" || url.pathname === "/setup.html") return serve(res, path.join(HERE, "setup.html"), "text/html; charset=utf-8");
      if (url.pathname === "/setup.js") return serve(res, path.join(HERE, "setup.js"), "text/javascript; charset=utf-8");
      if (url.pathname === "/panel.css") return serve(res, path.join(HERE, "panel.css"), "text/css; charset=utf-8");
      if (url.pathname === "/api/setup" && req.method === "GET") return send(res, 200, JSON.stringify(await getSetupState()));
      if (url.pathname === "/api/setup" && req.method === "POST") return send(res, 200, JSON.stringify(await action(await readBody(req))));
      send(res, 404, JSON.stringify({ ok: false, error: "not found" }));
    } catch (error) { send(res, 500, JSON.stringify({ ok: false, error: String(error.message || error) })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  console.log(`\n  Dwarf With Friends setup  ->  ${url}`);
  console.log("  This wizard also verifies and repairs an existing install.\n");
  if (IS_WIN) run("cmd", ["/c", "start", "", url]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
