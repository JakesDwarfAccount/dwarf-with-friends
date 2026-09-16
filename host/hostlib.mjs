// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Host-tooling core: everything install.mjs and host_panel.mjs share (the PURE, fixture-tested half).

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  statSync, readdirSync, renameSync, copyFileSync,
} from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- plugin file names

// Each name mirrors a C++ constant; renaming one here without its C++ pair makes the host
// tooling and the running plugin read and write different files.

export const PASSWORD_FILE = "dfcapture_join_password.txt";

// Loaded ONCE at plugin init; a rewrite takes effect on the next DF restart.
export const HOST_FLAGS_FILE = "dwf_host_flags.txt";

export const SOUND_CONFIG_FILE = path.join("dfhack-config", "dfcapture.json");
// Host-tooling only (no C++ reader): the host panel's own port config.
export const PANEL_CONFIG_FILE = path.join("dfhack-config", "dwf-host-panel.json");

// Install receipt, written into the DF root so state travels with the install.
export const RECEIPT_FILE = "dwf_install_receipt.json";

// The game server the plugin serves.
export const SERVER_PORT = 8765;
export const AUTH_COOKIE = "dfcap_auth";
export const DFHACK_VERSION = "53.16-r1";

// ---------------------------------------------------------------- platform names
export const IS_WIN = process.platform === "win32";
export const PLUGIN_BINARY = IS_WIN ? "dwf.plug.dll" : "dwf.plug.so";
export const DF_EXE_NAME = IS_WIN ? "Dwarf Fortress.exe" : "dwarfort";
export const DFHACK_LAUNCHER = IS_WIN ? "dfhack.exe" : "dfhack";
export const CLOUDFLARED_BIN = IS_WIN ? "cloudflared.exe" : "cloudflared";

// ---------------------------------------------------------------- manifest resolution

// The served web-root dir name must match the plugin's hard-coded kWebRoot; any other name
// makes the running plugin 404 index.html and serve its "web UI not found" stub.
export function resolveManifest(dfRoot, releaseDir) {
  const j = path.join;
  return [
    { role: "dll", kind: "file",
      src: j(releaseDir, PLUGIN_BINARY),
      dest: j(dfRoot, "hack", "plugins", PLUGIN_BINARY) },
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
      dest: j(dfRoot, "hack", "dfcapture-web") },
  ];
}

// ---------------------------------------------------------------- DFHack detection
export function dfhackMarkers(dfRoot) {
  return {
    dfRoot,
    dfExe:          path.join(dfRoot, DF_EXE_NAME),
    dfhackExe:      path.join(dfRoot, DFHACK_LAUNCHER),
    dfhackDll:      IS_WIN ? path.join(dfRoot, "dfhack.dll") : path.join(dfRoot, "libdfhooks.so"),
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
    problems.push(`This does not look like a Dwarf Fortress install -- "${DF_EXE_NAME}" is not in ${dfRoot}.`);
  }
  if (!exists(m.hackDir)) {
    problems.push("DFHack is not installed here (no \"hack\" folder). In Steam: right-click Dwarf Fortress -> Properties -> Betas is not needed; instead subscribe to DFHack, or install it from dfhack.org, then run this again.");
  } else if (!exists(m.hackPluginsDir)) {
    problems.push("DFHack looks incomplete -- the \"hack\\plugins\" folder is missing. Reinstall/repair DFHack, then run this again.");
  }
  return { ok: problems.length === 0, problems, markers: m };
}

// Best-effort version detection: unknown is distinct from compatible, so callers can warn
// without falsely identifying an install as the wrong version.
export function inspectDfhackVersion(dfRoot, exists = existsSync, read = readFileSync) {
  const candidates = [
    path.join(dfRoot, ".dwf-dfhack-version"),
    path.join(dfRoot, "dfhack-version.txt"),
    path.join(dfRoot, "hack", "dfhack-version.txt"),
    // Official 53.15 zips ship no docs pages, but hack/news.rst always opens with "DFHack <version>";
    // without this marker a stock manual install is undetectable.
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
export function steamDfCandidates(drives = ["C", "D", "E", "F", "G", "H"]) {
  if (!IS_WIN) {
    const home = process.env.HOME || "";
    return [
      path.join(home, ".local", "share", "Steam", "steamapps", "common", "Dwarf Fortress"),
      path.join(home, ".steam", "steam", "steamapps", "common", "Dwarf Fortress"),
      path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam",
                "steamapps", "common", "Dwarf Fortress"),   // Flatpak Steam
      path.join(home, "Games", "Dwarf Fortress"),
    ];
  }
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

// Steam records every library folder it knows about in libraryfolders.vdf, which finds installs
// the fixed list above never guesses.
export const STEAM_VDFS = IS_WIN ? [
  "C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf",
  "C:\\Program Files\\Steam\\steamapps\\libraryfolders.vdf",
] : [
  path.join(process.env.HOME || "", ".local", "share", "Steam", "steamapps", "libraryfolders.vdf"),
  path.join(process.env.HOME || "", ".steam", "steam", "steamapps", "libraryfolders.vdf"),
  path.join(process.env.HOME || "", ".var", "app", "com.valvesoftware.Steam", ".local", "share",
            "Steam", "steamapps", "libraryfolders.vdf"),
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

// A folder is a DF install if it holds the game exe OR the vanilla raws -- deliberately wider
// than checkDfhack, because the raws oracles need only data/vanilla.
export function isDfRoot(dfRoot, exists = existsSync) {
  if (!dfRoot) return false;
  return exists(path.join(dfRoot, DF_EXE_NAME)) ||
         exists(path.join(dfRoot, "data", "vanilla"));
}

// An explicit DWF_DF_ROOT wins, then Steam's own library list, then the fixed guesses.
export function dfCandidates(exists = existsSync, readText = (p) => readFileSync(p, "utf8")) {
  const env = process.env.DWF_DF_ROOT ? [process.env.DWF_DF_ROOT] : [];
  return [...env, ...steamLibraryDfCandidates(exists, readText), ...steamDfCandidates()];
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

// This shipped host library owns the detection engine; tools/lib/dfroot.* owns argv/env
// precedence and failure policy.
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
                          "dwf.plug.dll")) ||   // CMake OUTPUT_NAME dwf -> dwf.plug.dll
         exists(path.join(buildRoot, "plugins", "external", "multi-dwarf", "dwf.plug.so"));
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
// Not a cryptographic secret: it gates a friends-only tunnel URL that is itself unguessable.
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
export function parseCloudflaredUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return m ? m[0] : null;
}
// Verdicts: "ready", "no-tunnel", "unreadable" (a foreign cloudflared with no readable log --
// waiting would deadlock forever), "timeout", "wait".
export const LINK_WAIT_TIMEOUT_MS = 30000;
export function tunnelWaitVerdict({ url, running, logExists, startedByPanel, waitedMs,
                                    timeoutMs = LINK_WAIT_TIMEOUT_MS }) {
  if (url) return "ready";
  if (!running) return "no-tunnel";
  if (!logExists && !startedByPanel) return "unreadable";
  if (waitedMs >= timeoutMs) return "timeout";
  return "wait";
}

// A "not a recognized command" reply means the dwf plugin never loaded; returns null when the
// output is not that failure, so the caller keeps its own message.
export function explainStreamStartFailure({ output, dllDeployed, version }) {
  if (!/not a recognized command/i.test(String(output || ""))) return null;
  if (version?.detected && version.compatible === false) {
    return `The Dwarf With Friends plugin did not load: DFHack ${version.version} is installed, but this ` +
      `build needs exactly DFHack ${DFHACK_VERSION}. Run DWF Setup to install DFHack ${DFHACK_VERSION}, ` +
      `then restart Dwarf Fortress and try again.`;
  }
  if (dllDeployed === false) {
    return `The Dwarf With Friends plugin (${PLUGIN_BINARY}) is not installed in DFHack. ` +
      "Run DWF Setup to install the mod, then restart Dwarf Fortress and try again.";
  }
  return `DFHack did not load the Dwarf With Friends plugin. This usually means the installed DFHack ` +
    `is not the version this build needs (exactly ${DFHACK_VERSION}). Look for a plugin version error in ` +
    `the DFHack console or stderr.log, or run DWF Setup to repair the install.`;
}

// ---------------------------------------------------------------- job-object tunnel wrapper (Windows)

// cloudflared must never outlive the panel, so it runs inside a wrapper holding the only handle
// to a KILL_ON_JOB_CLOSE job: when the wrapper dies by any means the kernel kills cloudflared.
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
// POSIX twin of the job-object wrapper: a sh loop that polls the panel pid with kill -0.
// A SIGKILLed wrapper orphans the tunnel, so the panel's own exit handlers remain the path.
const TUNNEL_WRAPPER_SH = `
"$DWF_TUNNEL_EXE" "$@" &
cf=$!
trap 'kill "$cf" 2>/dev/null; exit 0' TERM INT HUP
while kill -0 "$DWF_PANEL_PID" 2>/dev/null && kill -0 "$cf" 2>/dev/null; do
  sleep 0.3
done
kill "$cf" 2>/dev/null
wait "$cf" 2>/dev/null
exit 0
`;
// Args are pre-quoted into ONE string because ProcessStartInfo.Arguments is a raw command line.
function quoteArg(a) { return /[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a); }
export function tunnelWrapperCommand({ exe, args, panelPid }) {
  if (process.platform !== "win32") {
    return {
      file: "/bin/sh",
      args: ["-c", TUNNEL_WRAPPER_SH, "dwf-tunnel-wrapper", ...(args || [])],
      env: {
        DWF_TUNNEL_EXE: String(exe),
        DWF_PANEL_PID: String(panelPid),
      },
    };
  }
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

// ---------------------------------------------------------------- recursive copy (installer)
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

// A filesystem-safe timestamp for backup dir names.
export function tsStamp(d = new Date()) {
  return d.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}
