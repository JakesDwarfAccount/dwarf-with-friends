// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Build the dependency-free, portable-Node release zip (--platform windows|linux).
// This script never downloads.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { requireDoc } from "../lib/docpath.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZIP_ROOT = "DwarfWithFriends";
const PUBLIC_REPO = "https://github.com/JakesDwarfAccount/dwarf-with-friends";
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
    setupName: "DWF Setup.cmd",
    hostAgainLine: "To host again, open the Dwarf With Friends shortcut or Dwarf With Friends.cmd in this folder.",
    unpackLine: "1. Unzip this folder anywhere on your Windows PC.",
    suffix: "",
  },
  linux: {
    nodeEntry: "node/node",
    pluginBinary: "dwf.plug.so",
    excludedPluginBinary: "dwf.plug.dll",
    launchers: [["dwf-setup.sh", "setup.mjs"], ["dwarf-with-friends.sh", "host_panel.mjs"]],
    setupCommand: "Run ./dwf-setup.sh from a terminal.",
    setupName: "./dwf-setup.sh",
    hostAgainLine: "To host again, open Dwarf With Friends from your applications menu or run ./dwarf-with-friends.sh in this folder.",
    steamLine: "For Steam hosting, set Dwarf Fortress Launch Options to: sh -c 'exec \"./dfhack\"' %command%",
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
function sourceCommit(explicit) {
  if (explicit) return String(explicit);
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); }
  catch { fail("source commit is unavailable; pass --source-commit"); }
}

// The staged release/web tree is a copy of the repository's web/, so a gitignored asset or scratch
// file left there is on disk at packaging time; only the tracked set is publishable. host/ ships
// as-is, so an untracked file there is refused outright.
function trackedPayloadFiles() {
  let listed;
  try { listed = execFileSync("git", ["ls-files", "-z", "--", "web", "host"], { cwd: ROOT, encoding: "utf8" }); }
  catch (error) { fail(`cannot list the git-tracked payload files (${error.message}); packaging requires git so untracked files stay out of the release`); }
  const tracked = new Set(listed.split("\0").filter(Boolean));
  if (!["web/", "host/"].every(prefix => [...tracked].some(file => file.startsWith(prefix)))) {
    fail("git must list both web/ and host/ files; refusing to package an unverifiable payload");
  }
  return tracked;
}

function walkFiles(root, relative = "") {
  const result = [];
  const dir = path.join(root, relative);
  for (const name of readdirSync(dir).sort()) {
    const rel = path.join(relative, name);
    const stat = lstatSync(path.join(root, rel));
    if (stat.isSymbolicLink()) fail(`payload symlinks are not allowed: ${rel}`);
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
    if (!existsSync(path.join(releaseDir, rel))) fail(`release tree is missing ${rel}`);
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

// Release-specific wording (known issues, a fallback version) lives in that release's notes, which
// ship beside this README; nothing here names a particular release.
function readme(version, platform, dfhackVersion) {
  const p = PLATFORMS[platform];
  const dfVersion = `0.${String(dfhackVersion).split("-")[0]}`;
  return Buffer.from([
    `Dwarf With Friends v${version}`,
    "",
    `Requires Dwarf Fortress ${dfVersion} and DFHack ${dfhackVersion}. Dwarf Fortress is not included.`,
    "Close Dwarf Fortress before installing or updating the mod.",
    "",
    p.unpackLine,
    `2. ${p.setupCommand}`,
    "3. Follow the setup page that opens in your browser.",
    "   If no page opens, the address is printed in the console window (http://127.0.0.1:<port>).",
    "The console window is the engine log; minimize it, but leave it open.",
    p.hostAgainLine,
    ...(p.steamLine ? [p.steamLine] : []),
    "Friends open the link shown in the host panel and enter the join password if you set one.",
    `Close Dwarf Fortress, then re-run ${p.setupName} to verify or repair the installation.`,
    "DFHack (the modding engine Dwarf With Friends runs on) is installed automatically by setup if it is missing.",
    "",
    `What changed in v${version}, and anything still rough: RELEASE-NOTES.md in this folder.`,
    "Something not working? See TROUBLESHOOTING.md in this folder.",
    "Installing by hand, or want Tailscale instead of the default tunnel? See MANUAL-INSTALL.md.",
    "Found a bug? See REPORTING-BUGS.md for how to report it well.",
    `Full docs and updates: ${PUBLIC_REPO}`,
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
      // the launchers, the node binary and the plugin so unzip restores runnable files, 0644 otherwise.
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
  const nodeLicense = path.resolve(options.nodeLicense || path.join(path.dirname(nodeExe), "LICENSE"));
  const outputDir = path.resolve(options.outputDir || ROOT);
  if (!existsSync(nodeExe) || !statSync(nodeExe).isFile()) fail(`Node binary not found: ${nodeExe}`);
  if (!existsSync(nodeLicense) || !statSync(nodeLicense).isFile()) {
    fail(`Node license not found: ${nodeLicense} (keep LICENSE beside node.exe or pass --node-license)`);
  }
  const nodeLicenseBytes = readFileSync(nodeLicense);
  if (nodeLicenseBytes.length === 0) fail(`Node license is empty: ${nodeLicense}`);
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

  const tracked = trackedPayloadFiles();
  const untrackedWeb = walkFiles(releaseDir).filter((rel) => rel.startsWith("web/") && !tracked.has(rel));
  const untrackedHost = walkFiles(hostDir).filter((rel) => !tracked.has(`host/${rel}`));
  if (untrackedHost.length) fail(`host tree contains unapproved files: ${untrackedHost.join(", ")}`);
  const releaseAllowed = new Set([...requiredReleaseFiles(platform), "VERSION.txt", plat.excludedPluginBinary]);
  const unexpectedRelease = walkFiles(releaseDir).filter((rel) => !rel.startsWith("web/") && !releaseAllowed.has(rel));
  if (unexpectedRelease.length) fail(`release tree contains unapproved files: ${unexpectedRelease.join(", ")}`);

  const entries = new Map();
  addTree(entries, hostDir, "host", new Set(["download-manifest.json"]));
  addTree(entries, releaseDir, "release",
          new Set(["VERSION.txt", plat.excludedPluginBinary, ...untrackedWeb]));
  entries.set(`${ZIP_ROOT}/host/download-manifest.json`, Buffer.from(manifestText));
  entries.set(`${ZIP_ROOT}/release/VERSION.txt`, Buffer.from(`v${version}\n`));
  entries.set(`${ZIP_ROOT}/${plat.nodeEntry}`, readFileSync(nodeExe));
  const executables = new Set([`${ZIP_ROOT}/${plat.nodeEntry}`, `${ZIP_ROOT}/release/${plat.pluginBinary}`]);
  entries.set(`${ZIP_ROOT}/NODE-LICENSE.txt`, nodeLicenseBytes);
  entries.set(`${ZIP_ROOT}/LICENSE`, readFileSync(path.join(ROOT, "LICENSE")));
  entries.set(`${ZIP_ROOT}/NOTICE`, readFileSync(path.join(ROOT, "NOTICE")));
  for (const [name, script] of plat.launchers) {
    entries.set(`${ZIP_ROOT}/${name}`, launcher(script, platform));
    executables.add(`${ZIP_ROOT}/${name}`);
  }
  const dfhackVersion = manifestItem("dfhack").version || manifest.dfhack?.version;
  if (!dfhackVersion) fail("download-manifest.json names no DFHack version; README.txt and the release manifest need it");
  entries.set(`${ZIP_ROOT}/README.txt`, readme(version, platform, dfhackVersion));
  // Player docs land at the zip root beside the launchers, so their links are flattened to siblings.
  // requireDoc finds each one in either the grouped dev tree or the flat public tree.
  const flattenDocLinks = (text) => String(text)
    .replace(/\]\((?:\.\.\/)*(?:[\w.-]+\/)*([\w.-]+\.(?:md|html))((?:#[^)\s]*)?)\)/g, "]($1$2)");
  const packagedDocs = new Map([
    ["TROUBLESHOOTING.md", "TROUBLESHOOTING.md"],
    ["docs/guides/MANUAL-INSTALL.md", "MANUAL-INSTALL.md"],
    ["docs/guides/REPORTING-BUGS.md", "REPORTING-BUGS.md"],
    ["docs/guides/CONFIG.md", "CONFIG.md"],
    [`docs/releases/RELEASE-NOTES-v${version}.md`, "RELEASE-NOTES.md"],
  ]);
  const sourceDestinations = new Map([["LICENSE", `${ZIP_ROOT}/LICENSE`], ["NOTICE", `${ZIP_ROOT}/NOTICE`]]);
  for (const [rel, name] of packagedDocs) {
    const abs = requireDoc(ROOT, rel);
    sourceDestinations.set(path.relative(ROOT, abs).split(path.sep).join("/"), `${ZIP_ROOT}/${name}`);
    entries.set(`${ZIP_ROOT}/${name}`, Buffer.from(flattenDocLinks(readFileSync(abs, "utf8")), "utf8"));
  }

  // Markdown inside host/ and release/web/ keeps working links: a packaged file becomes a relative
  // link, anything else a GitHub link pinned to the source commit.
  const packageSourceCommit = sourceCommit(options.sourceCommit);
  const copiedSources = new Map();
  for (const name of entries.keys()) {
    const relative = name.slice(`${ZIP_ROOT}/`.length);
    if (relative.startsWith("host/")) copiedSources.set(relative, name);
    else if (relative.startsWith("release/web/")) copiedSources.set(relative.slice("release/".length), name);
  }
  for (const [source, destination] of copiedSources) sourceDestinations.set(source, destination);
  for (const [source, destination] of copiedSources) {
    if (!source.endsWith(".md")) continue;
    const text = entries.get(destination).toString("utf8").replace(/\]\(([^)\s]+)\)/g, (link, target) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return link;
      const [file, fragment] = target.split("#", 2);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), file));
      if (resolved.startsWith("../") || !existsSync(path.join(ROOT, resolved))) {
        fail(`unresolved packaged documentation link: ${source} -> ${target}`);
      }
      const bundled = sourceDestinations.get(resolved);
      const url = bundled
        ? path.posix.relative(path.posix.dirname(destination), bundled)
        : `${PUBLIC_REPO}/blob/${packageSourceCommit}/${resolved.split("/").map(encodeURIComponent).join("/")}`;
      return `](${url}${fragment === undefined ? "" : `#${fragment}`})`;
    });
    entries.set(destination, Buffer.from(text));
  }

  // Immutable inventory of the candidate payload. The manifest deliberately excludes itself (a
  // file cannot contain its own hash); the independently returned packageSha256 closes the outer
  // zip. Install/release checks can therefore prove every DLL/.so, Lua, web, host, legal, and Node byte.
  const releaseManifest = {
    schemaVersion: 1,
    sourceCommit: packageSourceCommit,
    releaseVersion: version,
    platform,
    dfhackVersion,
    node: { version: nodeVersion, sha256: actualNodeSha },
    manifestSelfExcluded: true,
    files: [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({
      path: name.slice(`${ZIP_ROOT}/`.length), bytes: bytes.length, sha256: sha256(bytes),
    })),
  };
  entries.set(`${ZIP_ROOT}/RELEASE-MANIFEST.json`,
              Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8"));

  const output = path.join(outputDir, `DwarfWithFriends-v${version}${plat.suffix}.zip`);
  writeZip(output, entries, executables);
  return { output, version, nodeVersion, nodeSha256: actualNodeSha, platform, untrackedWeb,
           packageSha256: sha256(readFileSync(output)), releaseManifest,
           files: [...entries.keys()].sort() };
}

function parseArgs(argv) {
  const out = {};
  const names = new Map([
    ["--version", "version"], ["--node-version", "nodeVersion"], ["--node-exe", "nodeExe"],
    ["--node-license", "nodeLicense"],
    ["--node-sha256", "nodeSha256"], ["--dfhack-sha256", "dfhackSha256"],
    ["--cloudflared-sha256", "cloudflaredSha256"], ["--host", "hostDir"],
    ["--release", "releaseDir"], ["--output-dir", "outputDir"], ["--platform", "platform"],
    ["--source-commit", "sourceCommit"],
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
    for (const rel of result.untrackedWeb) console.log(`left out (not tracked in git): release/${rel}`);
    console.log(`Node v${result.nodeVersion} SHA-256 ${result.nodeSha256}`);
    console.log(`Package SHA-256 ${result.packageSha256}`);
  } catch (error) {
    console.error(`build_zip: ${error.message}`);
    process.exitCode = 1;
  }
}
