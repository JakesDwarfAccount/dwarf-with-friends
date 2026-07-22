// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Build the dependency-free, portable-Node release zip (--platform windows|linux).
// This script never downloads.

import { createHash } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZIP_ROOT = "DwarfWithFriends";
const PLACEHOLDER = /(?:BAKE_[A-Z0-9_]+|PLACEHOLDER|REPLACE_ME|TODO_SHA256)/i;
const REQUIRED_HOST_FILES = [
  "setup.mjs", "install.mjs", "hostlib.mjs", "fetchers.mjs", "host_panel.mjs",
  "panel.html", "panel.js", "panel.css", "download-manifest.json",
];
// Exported so the release fixture test can assert the installer's deploy contract (host/hostlib.mjs
// resolveManifest) ships EXACTLY these release files -- the guard that catches a future name drift
// like the dfcapture.* -> dwf.* split that shipped a mismatched zip and installer.
export const REQUIRED_RELEASE_FILES = ["dwf.plug.dll", "dwf.lua", "gui/dwf.lua"];
export function requiredReleaseFiles(platform) {
  return [platform === "linux" ? "dwf.plug.so" : "dwf.plug.dll", "dwf.lua", "gui/dwf.lua"];
}

// Everything platform-shaped in one table: the bundled Node binary's zip path, the plugin binary
// this platform deploys (the OTHER platform's binary is excluded from its zip), the launcher
// scripts, and the archive suffix. Windows output keeps its historical unsuffixed name.
const PLATFORMS = {
  windows: {
    nodeEntry: "node/node.exe",
    pluginBinary: "dwf.plug.dll",
    excludedPluginBinary: "dwf.plug.so",
    launchers: [["DWF Setup.cmd", "setup.mjs"], ["Dwarf With Friends.cmd", "host_panel.mjs"]],
    setupCommand: "Double-click DWF Setup.cmd.",
    unpackLine: "1. Unzip this folder anywhere on your Windows PC.",
    suffix: "",
  },
  linux: {
    nodeEntry: "node/node",
    pluginBinary: "dwf.plug.so",
    excludedPluginBinary: "dwf.plug.dll",
    launchers: [["dwf-setup.sh", "setup.mjs"], ["dwarf-with-friends.sh", "host_panel.mjs"]],
    setupCommand: "Run ./dwf-setup.sh from a terminal.",
    unpackLine: "1. Unzip this folder anywhere on your Linux PC (native Steam Dwarf Fortress).",
    suffix: "-linux",
  },
};

function fail(message) { throw new Error(message); }
function validSha(value) { return /^[a-f0-9]{64}$/i.test(String(value || "")); }
function normalizedVersion(value, label) {
  const version = String(value || "").replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`${label} must be a semantic version`);
  return version;
}
function sha256(data) { return createHash("sha256").update(data).digest("hex"); }

function walkFiles(root, relative = "") {
  const result = [];
  const dir = path.join(root, relative);
  for (const name of readdirSync(dir).sort()) {
    const rel = path.join(relative, name);
    const stat = statSync(path.join(root, rel));
    if (stat.isDirectory()) result.push(...walkFiles(root, rel));
    else if (stat.isFile()) result.push(rel.split(path.sep).join("/"));
  }
  return result;
}

function requireLayout(hostDir, releaseDir, platform) {
  for (const rel of REQUIRED_HOST_FILES) {
    if (!existsSync(path.join(hostDir, rel))) fail(`host tree is missing ${rel}`);
  }
  for (const rel of requiredReleaseFiles(platform)) {
    if (!existsSync(path.join(releaseDir, rel))) fail(`release tree is missing ${rel} (build only after W9)`);
  }
  const web = path.join(releaseDir, "web");
  if (!existsSync(web) || !statSync(web).isDirectory()) fail("release tree is missing web/");
  const forbidden = [...walkFiles(hostDir), ...walkFiles(releaseDir)]
    .find((rel) => ["cloudflared.exe", "cloudflared"].includes(path.posix.basename(rel).toLowerCase()));
  if (forbidden) fail(`cloudflared must be fetched by setup, not shipped (${forbidden})`);
}

function launcher(script, platform) {
  if (platform === "linux") {
    // Mirrors the .cmd contract: bundled node first, system node fallback, honest failure.
    return Buffer.from([
      "#!/bin/sh",
      "# This terminal is the DWF engine -- minimize it. Closing it stops DWF.",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'if [ -x "$DIR/node/node" ]; then',
      '  NODE="$DIR/node/node"',
      "elif command -v node >/dev/null 2>&1; then",
      "  NODE=node",
      "else",
      '  echo "Node.js 18+ is required. Install it from your package manager and re-run." >&2',
      "  exit 1",
      "fi",
      'echo "This window is the DWF engine -- minimize it. Closing it stops DWF."',
      `exec "$NODE" "$DIR/host/${script}"`,
      "",
    ].join("\n"), "utf8");
  }
  return Buffer.from([
    "@echo off",
    "setlocal",
    "echo This window is the DWF engine -- minimize it. Closing it stops DWF.",
    `"%~dp0node\\node.exe" "%~dp0host\\${script}"`,
    "set \"DWF_EXIT=%ERRORLEVEL%\"",
    "if not \"%DWF_EXIT%\"==\"0\" pause",
    "exit /b %DWF_EXIT%",
    "",
  ].join("\r\n"), "utf8");
}

function readme(version, platform) {
  const p = PLATFORMS[platform];
  return Buffer.from([
    `Dwarf With Friends v${version}`,
    "",
    p.unpackLine,
    `2. ${p.setupCommand}`,
    "3. Follow the setup page that opens in your browser.",
    "   If no page opens, the address is printed in the console window (http://127.0.0.1:<port>).",
    "The console window is the engine log; minimize it, but leave it open.",
    "After setup, use the Dwarf With Friends shortcut to host again.",
    "Friends need only the link and password shown in the host panel.",
    `Re-run ${platform === "linux" ? "dwf-setup.sh" : "DWF Setup.cmd"} at any time to verify or repair the installation.`,
    "Dwarf Fortress is required and is not included.",
    "DFHack (the modding engine Dwarf With Friends runs on) is installed automatically by setup if it is missing.",
    "",
    "Something not working? See TROUBLESHOOTING.md in this folder.",
    "Installing by hand, or want Tailscale instead of the default tunnel? See MANUAL-INSTALL.md.",
    "Found a bug? See REPORTING-BUGS.md for how to report it well.",
    "Full docs and updates: https://github.com/JakesDwarfAccount/dwarf-with-friends",
    "",
  ].join("\r\n"), "utf8");
}

function addTree(entries, sourceDir, zipDir, except = new Set()) {
  for (const rel of walkFiles(sourceDir)) {
    if (!except.has(rel)) entries.set(`${ZIP_ROOT}/${zipDir}/${rel}`, readFileSync(path.join(sourceDir, rel)));
  }
}

// CRC-32 and raw DEFLATE keep the build dependency-free. Fixed metadata and ordering make it stable.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; }
function writeAll(fd, chunks) { for (const chunk of chunks) writeSync(fd, chunk); }

function writeZip(output, sourceEntries, executables = new Set()) {
  const entries = new Map(sourceEntries);
  for (const name of [...entries.keys()]) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/") + "/";
      if (!entries.has(dir)) entries.set(dir, Buffer.alloc(0));
    }
  }
  const sorted = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  mkdirSync(path.dirname(output), { recursive: true });
  const fd = openSync(output, "w");
  const central = [];
  let offset = 0;
  try {
    for (const [name, data] of sorted) {
      const filename = Buffer.from(name, "utf8");
      const crc = crc32(data);
      const deflated = name.endsWith("/") ? data : deflateRawSync(data, { level: 9 });
      const compressed = deflated.length < data.length ? deflated : data;
      const method = compressed === deflated && deflated !== data ? 8 : 0;
      // Unix mode in the external-attr high word (version-made-by is already 3=Unix): 0755 for
      // the Linux launchers + node binary so unzip restores runnable files, 0644 otherwise.
      const mode = name.endsWith("/") ? 0o755 : executables.has(name) ? 0o755 : 0o644;
      const externalAttrs = ((mode | (name.endsWith("/") ? 0o040000 : 0o100000)) << 16) >>> 0 |
                            (name.endsWith("/") ? 0x10 : 0);
      // DOS date 1980-01-01, time 00:00:00. UTF-8 names.
      const local = Buffer.concat([
        u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(0), u16(0x0021),
        u32(crc), u32(compressed.length), u32(data.length), u16(filename.length), u16(0), filename,
      ]);
      writeAll(fd, [local, compressed]);
      central.push(Buffer.concat([
        u32(0x02014b50), u16(0x0314), u16(20), u16(0x0800), u16(method), u16(0), u16(0x0021),
        u32(crc), u32(compressed.length), u32(data.length), u16(filename.length), u16(0), u16(0),
        u16(0), u16(0), u32(externalAttrs), u32(offset), filename,
      ]));
      offset += local.length + compressed.length;
    }
    const centralOffset = offset;
    writeAll(fd, central);
    const centralSize = central.reduce((sum, item) => sum + item.length, 0);
    if (sorted.length > 0xffff || centralOffset + centralSize > 0xffffffff) fail("release is too large for non-ZIP64 output");
    writeAll(fd, [Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(sorted.length), u16(sorted.length),
      u32(centralSize), u32(centralOffset), u16(0),
    ])]);
  } finally { closeSync(fd); }
}

export function buildReleaseZip(options) {
  const platform = options.platform || "windows";
  const plat = PLATFORMS[platform];
  if (!plat) fail(`--platform must be one of: ${Object.keys(PLATFORMS).join(", ")}`);
  const version = normalizedVersion(options.version, "release version");
  const nodeVersion = normalizedVersion(options.nodeVersion, "Node version");
  const hostDir = path.resolve(options.hostDir || path.join(ROOT, "host"));
  const releaseDir = path.resolve(options.releaseDir || path.join(ROOT, "release"));
  const nodeExe = path.resolve(options.nodeExe || "");
  const outputDir = path.resolve(options.outputDir || ROOT);
  if (!existsSync(nodeExe) || !statSync(nodeExe).isFile()) fail(`Node binary not found: ${nodeExe}`);
  if (!validSha(options.nodeSha256)) fail("--node-sha256 must be a baked 64-digit SHA-256");
  const actualNodeSha = sha256(readFileSync(nodeExe));
  if (actualNodeSha !== options.nodeSha256.toLowerCase()) fail(`Node SHA-256 mismatch: expected ${options.nodeSha256}, got ${actualNodeSha}`);
  requireLayout(hostDir, releaseDir, platform);

  const manifest = JSON.parse(readFileSync(path.join(hostDir, "download-manifest.json"), "utf8"));
  // Schema 2 nests per-platform {url, sha256} under "windows"/"linux"; schema 1 was flat
  // (Windows-only). Overrides and the release blocker below target whichever shape is present.
  const manifestItem = (name) => manifest[name]?.[platform] || manifest[name] || {};
  if (options.dfhackSha256) manifestItem("dfhack").sha256 = options.dfhackSha256.toLowerCase();
  if (options.cloudflaredSha256) manifestItem("cloudflared").sha256 = options.cloudflaredSha256.toLowerCase();
  manifest.package = { version, nodeVersion, nodeSha256: actualNodeSha };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  // RELEASE BLOCKER: a placeholder checksum means the fetcher verifies against nothing useful.
  if (PLACEHOLDER.test(manifestText)) fail("refusing to package: download-manifest.json still contains a placeholder");
  for (const name of ["dfhack", "cloudflared"]) {
    if (!validSha(manifestItem(name).sha256)) fail(`refusing to package: ${name} SHA-256 is not baked for ${platform}`);
  }

  const entries = new Map();
  addTree(entries, hostDir, "host", new Set(["download-manifest.json"]));
  addTree(entries, releaseDir, "release", new Set(["VERSION.txt", plat.excludedPluginBinary]));
  entries.set(`${ZIP_ROOT}/host/download-manifest.json`, Buffer.from(manifestText));
  entries.set(`${ZIP_ROOT}/release/VERSION.txt`, Buffer.from(`v${version}\n`));
  entries.set(`${ZIP_ROOT}/${plat.nodeEntry}`, readFileSync(nodeExe));
  const executables = new Set([`${ZIP_ROOT}/${plat.nodeEntry}`]);
  for (const [name, script] of plat.launchers) {
    entries.set(`${ZIP_ROOT}/${name}`, launcher(script, platform));
    executables.add(`${ZIP_ROOT}/${name}`);
  }
  entries.set(`${ZIP_ROOT}/README.txt`, readme(version, platform));
  // Most players only ever open this zip, never the git repo -- so the player-facing docs must
  // ship here too, not just in source control. ALL of them land at the zip ROOT (owner call,
  // beta.2): a player browsing the unzipped folder should see TROUBLESHOOTING next to the
  // launchers, not tucked in docs/. The repo keeps its docs/ layout, so the inter-doc relative
  // links ("docs/X.md" from root, "../TROUBLESHOOTING.md" from docs/) are rewritten to flat
  // siblings in the bundled copies only.
  const flattenDocLinks = (text) => String(text)
    .replaceAll("](docs/", "](")
    .replaceAll("](../", "](");
  for (const rel of ["TROUBLESHOOTING.md", "docs/MANUAL-INSTALL.md", "docs/REPORTING-BUGS.md", "docs/CONFIG.md"]) {
    const base = rel.split("/").pop();
    entries.set(`${ZIP_ROOT}/${base}`, Buffer.from(flattenDocLinks(readFileSync(path.join(ROOT, rel), "utf8")), "utf8"));
  }

  const output = path.join(outputDir, `DwarfWithFriends-v${version}${plat.suffix}.zip`);
  writeZip(output, entries, executables);
  return { output, version, nodeVersion, nodeSha256: actualNodeSha, platform, files: [...entries.keys()].sort() };
}

function parseArgs(argv) {
  const out = {};
  const names = new Map([
    ["--version", "version"], ["--node-version", "nodeVersion"], ["--node-exe", "nodeExe"],
    ["--node-sha256", "nodeSha256"], ["--dfhack-sha256", "dfhackSha256"],
    ["--cloudflared-sha256", "cloudflaredSha256"], ["--host", "hostDir"],
    ["--release", "releaseDir"], ["--output-dir", "outputDir"], ["--platform", "platform"],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const key = names.get(argv[i]);
    if (!key) fail(`unknown argument: ${argv[i]}`);
    if (!argv[i + 1]) fail(`${argv[i]} needs a value`);
    out[key] = argv[++i];
  }
  for (const key of ["version", "nodeVersion", "nodeExe", "nodeSha256"]) if (!out[key]) fail(`--${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} is required`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildReleaseZip(parseArgs(process.argv.slice(2)));
    console.log(`built ${result.output}`);
    console.log(`Node v${result.nodeVersion} SHA-256 ${result.nodeSha256}`);
  } catch (error) {
    console.error(`build_zip: ${error.message}`);
    process.exitCode = 1;
  }
}
