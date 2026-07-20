// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// SPDX-License-Identifier: AGPL-3.0-only
//
// Dependency-free, SHA-256-pinned downloads used by setup.mjs and host_panel.mjs.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { get as httpsGet } from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DFHACK_VERSION, checkDfhack, dfhackMarkers, inspectDfhackVersion,
  IS_WIN, DF_EXE_NAME, CLOUDFLARED_BIN,
} from "./hostlib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOWNLOAD_MANIFEST_PATH = path.join(HERE, "download-manifest.json");

export function loadDownloadManifest(file = DOWNLOAD_MANIFEST_PATH) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Manifest schema 2 nests per-platform {url, sha256} under "windows"/"linux"; schema 1 kept them
// flat (Windows-only). Resolve either shape to a flat {version, manualUrl, url, sha256}.
export function platformManifestItem(item = {}) {
  const plat = IS_WIN ? item.windows : item.linux;
  return plat ? { ...item, ...plat } : item;
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

export function sha256File(file) {
  const hash = createHash("sha256");
  for (const chunk of readChunks(file)) hash.update(chunk);
  return hash.digest("hex");
}

function* readChunks(file) {
  const data = readFileSync(file);
  const size = 1024 * 1024;
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

function tempBeside(dest, suffix = "part") {
  return `${dest}.${suffix}-${process.pid}-${Date.now()}`;
}

function friendlyFailure(error, manualUrl, destination) {
  const detail = String(error?.message || error || "download failed").replace(/\s+/g, " ").trim();
  return {
    ok: false,
    error: `Automatic download did not finish (${detail}). You can download it manually from ${manualUrl} and put it in ${destination}.`,
    manual: { url: manualUrl, destination },
  };
}

// Default transport. Redirects are followed only over HTTPS and a failed/truncated response
// rejects pipeline(), leaving cleanup to downloadVerified().
export function downloadHttps(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { "User-Agent": "Dwarf-With-Friends-Setup" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error("too many redirects"));
        const next = new URL(res.headers.location, url);
        if (next.protocol !== "https:") return reject(new Error("download redirected away from HTTPS"));
        return downloadHttps(next.href, dest, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GitHub returned HTTP ${res.statusCode}`));
      }
      pipeline(res, createWriteStream(dest, { flags: "wx" })).then(resolve, reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error("download timed out")));
    req.on("error", reject);
  });
}

export async function downloadVerified({ url, sha256, destination, download = downloadHttps }) {
  if (!validSha256(sha256)) {
    return friendlyFailure("this package has no valid baked SHA-256", url, destination);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const part = tempBeside(destination);
  try {
    await download(url, part);
    if (!existsSync(part)) throw new Error("download produced no file");
    const actual = sha256File(part);
    if (actual.toLowerCase() !== sha256.toLowerCase()) {
      throw new Error(`checksum mismatch: expected ${sha256.toLowerCase()}, got ${actual}`);
    }
    replaceFile(part, destination);
    return { ok: true, destination, sha256: actual };
  } catch (error) {
    rmSync(part, { force: true });
    return friendlyFailure(error, url, destination);
  }
}

function replaceFile(source, destination) {
  const old = tempBeside(destination, "old");
  let movedOld = false;
  try {
    if (existsSync(destination)) { renameSync(destination, old); movedOld = true; }
    renameSync(source, destination);
    if (movedOld) rmSync(old, { force: true });
  } catch (error) {
    if (movedOld && !existsSync(destination) && existsSync(old)) renameSync(old, destination);
    throw error;
  }
}

function runFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve();
    });
  });
}

export async function extractArchive(archive, destination, run = runFile) {
  if (!IS_WIN) {
    // GNU tar handles the Linux DFHack .tar.bz2 natively.
    mkdirSync(destination, { recursive: true });
    await run("tar", ["-xf", archive, "-C", destination]);
    return { tool: "tar" };
  }
  return extractZipWindows(archive, destination, run);
}

export async function extractZipWindows(archive, destination, run = runFile) {
  mkdirSync(destination, { recursive: true });
  try {
    await run("tar.exe", ["-xf", archive, "-C", destination]);
    return { tool: "tar.exe" };
  } catch (tarError) {
    try {
      const escapedArchive = archive.replace(/'/g, "''");
      const escapedDest = destination.replace(/'/g, "''");
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDest}' -Force`]);
      return { tool: "PowerShell Expand-Archive" };
    } catch (powershellError) {
      throw new Error(`could not unzip with tar.exe or PowerShell (${powershellError.message || tarError.message})`);
    }
  }
}

function copyTreeMerge(source, destination) {
  const st = statSync(source);
  if (st.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) copyTreeMerge(path.join(source, name), path.join(destination, name));
  } else {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function extractedRoot(stage) {
  if (existsSync(path.join(stage, "hack"))) return stage;
  const children = readdirSync(stage).filter((name) => statSync(path.join(stage, name)).isDirectory());
  if (children.length === 1 && existsSync(path.join(stage, children[0], "hack"))) return path.join(stage, children[0]);
  return null;
}

export async function fetchDfhack({
  dfRoot, manifest = loadDownloadManifest(), download = downloadHttps, extract = extractArchive,
} = {}) {
  const item = platformManifestItem(manifest.dfhack || {});
  const manualUrl = item.manualUrl || item.url || "https://github.com/DFHack/dfhack/releases/tag/53.15-r2";
  if (item.version !== DFHACK_VERSION) {
    return friendlyFailure(`download manifest names DFHack ${item.version || "without a version"}; expected ${DFHACK_VERSION}`,
      manualUrl, dfRoot || "your Dwarf Fortress folder");
  }
  const markers = dfhackMarkers(dfRoot || "");
  if (!dfRoot || !existsSync(dfRoot) || !existsSync(markers.dfExe)) {
    return { ok: false, error: `Choose the Dwarf Fortress folder that contains "${DF_EXE_NAME}" before installing DFHack.`,
      manual: { url: manualUrl, destination: dfRoot || "your Dwarf Fortress folder" } };
  }
  const current = checkDfhack(dfRoot);
  if (current.ok) {
    const version = inspectDfhackVersion(dfRoot);
    if (version.detected && !version.compatible) {
      return { ok: false, wrongVersion: true,
        error: `DFHack ${version.version} is installed, but Dwarf With Friends requires exactly ${DFHACK_VERSION}. Remove or update that DFHack install before continuing.`,
        manual: { url: manualUrl, destination: dfRoot }, version };
    }
    if (version.compatible) return { ok: true, alreadyInstalled: true, dfRoot, version };
  }
  const archive = tempBeside(path.join(path.dirname(dfRoot), "dfhack.zip"));
  const stage = tempBeside(path.join(path.dirname(dfRoot), "dfhack-extract"));
  try {
    const got = await downloadVerified({ url: item.url, sha256: item.sha256, destination: archive, download });
    if (!got.ok) return { ...got, manual: { url: manualUrl, destination: dfRoot },
      error: got.error.replace(`put it in ${archive}`, `extract it into ${dfRoot}`) };
    await extract(archive, stage);
    const root = extractedRoot(stage);
    const launcherPresent = root && (IS_WIN
      ? (existsSync(path.join(root, "dfhack.exe")) || existsSync(path.join(root, "dfhack.dll")))
      : existsSync(path.join(root, "dfhack")));
    if (!root || !existsSync(path.join(root, "hack", "plugins")) || !launcherPresent) {
      throw new Error(`the archive did not contain a complete ${IS_WIN ? "Windows" : "Linux"} DFHack install`);
    }
    copyTreeMerge(root, dfRoot);
    writeFileSync(path.join(dfRoot, ".dwf-dfhack-version"), DFHACK_VERSION + "\n");
    return { ok: true, installed: true, dfRoot, version: DFHACK_VERSION };
  } catch (error) {
    return friendlyFailure(error, manualUrl, dfRoot);
  } finally {
    rmSync(archive, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function fetchCloudflared({
  dwfRoot = HERE, manifest = loadDownloadManifest(), download = downloadHttps,
} = {}) {
  const item = platformManifestItem(manifest.cloudflared || {});
  const destination = path.join(dwfRoot, CLOUDFLARED_BIN);
  if (existsSync(destination) && validSha256(item.sha256) &&
      sha256File(destination).toLowerCase() === item.sha256.toLowerCase()) {
    return { ok: true, alreadyInstalled: true, destination, sha256: item.sha256.toLowerCase() };
  }
  const result = await downloadVerified({ url: item.url, sha256: item.sha256, destination, download });
  // The Linux asset is a raw binary; a fresh download has no exec bit.
  if (result.ok && !IS_WIN) chmodSync(destination, 0o755);
  return result;
}
