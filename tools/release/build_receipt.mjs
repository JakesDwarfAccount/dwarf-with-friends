// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// A machine-readable receipt tying a built native plugin to this checkout's source identity.
//   node tools/release/build_receipt.mjs --dfhack-build <dir> [--platform windows|linux] [--out <file>]

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
};
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const dfhackTag = JSON.parse(readFileSync(path.join(root, "host", "download-manifest.json"), "utf8")).dfhack.version;

const buildArg = arg("--dfhack-build") || process.env.DWF_DFHACK_BUILD;
if (!buildArg) throw new Error("pass --dfhack-build or set DWF_DFHACK_BUILD");
const buildRoot = path.resolve(buildArg);
const platform = arg("--platform") || (process.platform === "win32" ? "windows" : "linux");
if (!["windows", "linux"].includes(platform)) throw new Error("platform must be windows or linux");
const name = platform === "windows" ? "dwf.plug.dll" : "dwf.plug.so";
const binary = ["", "Release"].map(dir => path.join(buildRoot, "plugins", "external", "multi-dwarf", dir, name)).find(existsSync);
if (!binary) throw new Error(`native binary not found: ${name}`);

const cache = readFileSync(path.join(buildRoot, "CMakeCache.txt"), "utf8");
const sourceRoot = cache.match(/^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$/m)?.[1]?.trim();
if (!sourceRoot) throw new Error("DFHack source path missing from CMake cache");
const dfhackGit = (...args) => execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trim();
const dfhackCommit = dfhackGit("rev-parse", "HEAD");
if (dfhackCommit !== dfhackGit("rev-parse", `${dfhackTag}^{commit}`)) throw new Error(`DFHack source is not pinned to ${dfhackTag}`);
const externalPath = path.join(sourceRoot, "plugins", "external", "multi-dwarf");
if (realpathSync(externalPath) !== realpathSync(root)) throw new Error("build uses a different plugin checkout");

const commit = git("rev-parse", "HEAD");
const stamp = cache.match(/^DFCAPTURE_BUILD_STAMP:[^=]+=(.+)$/m)?.[1]?.trim();
if (stamp && stamp !== commit) throw new Error("build stamp does not match source commit");
const bytes = readFileSync(binary);
if (!bytes.includes(Buffer.from(stamp || git("rev-parse", "--short=9", "HEAD")))) {
  throw new Error("source identity not found in binary; rebuild this candidate");
}

// Hash the native build inputs as they are on disk, including new files not yet committed: a new
// .cpp can be compiled while absent from `git ls-files`.
const sourceFiles = git("ls-files", "--cached", "--others", "--exclude-standard", "--", "CMakeLists.txt", "src", "third_party")
  .split(/\r?\n/).filter(Boolean).sort();
const sourceHash = createHash("sha256");
for (const file of sourceFiles) {
  sourceHash.update(file.replaceAll("\\", "/"));
  sourceHash.update("\0");
  sourceHash.update(readFileSync(path.join(root, file)));
  sourceHash.update("\0");
}
const receipt = {
  schemaVersion: 3,
  commit,
  platform,
  nativeCandidateSourceSha256: sourceHash.digest("hex"),
  nativeCandidateFileCount: sourceFiles.length,
  workingTreeDirty: git("status", "--porcelain") !== "",
  dfhackTag,
  dfhackCommit,
  target: "dfcapture_public",
  binary: { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
};
const text = `${JSON.stringify(receipt, null, 2)}\n`;
const output = arg("--out");
if (output) writeFileSync(path.resolve(output), text);
else process.stdout.write(text);
