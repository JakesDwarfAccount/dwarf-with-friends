// Produce a machine-readable receipt tying a native DLL to this checkout's source identity.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dfhackBuildOrDie } from "../lib/dfroot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// W1: resolved through the shared resolver (--dfhack-build / DWF_DFHACK_BUILD), never hardcoded.
const buildRoot = dfhackBuildOrDie("build_receipt");
const dll = path.join(buildRoot, "plugins", "external", "multi-dwarf", "Release", "dwf.plug.dll");
if (!existsSync(dll)) throw new Error(`native DLL not found: ${dll}`);

// Hash the actual native candidate, including newly created files that have not been committed yet.
// A tracked-only hash is misleading during review: a new .cpp can be compiled while being absent
// from `git ls-files`. Limit the set to native build inputs so the receipt does not hash itself.
const sourceFiles = git(
  "ls-files", "--cached", "--others", "--exclude-standard", "--",
  "CMakeLists.txt", "src", "third_party",
).split(/\r?\n/).filter(Boolean).sort();
const sourceHash = createHash("sha256");
for (const file of sourceFiles) {
  sourceHash.update(file.replaceAll("\\", "/"));
  sourceHash.update("\0");
  sourceHash.update(readFileSync(path.join(root, file)));
  sourceHash.update("\0");
}
const externalPath = path.resolve(buildRoot, "..", "plugins", "external", "multi-dwarf");
const canonicalExternalMatches = existsSync(externalPath) && realpathSync(externalPath) === realpathSync(root);
const dllBytes = readFileSync(dll);
const receipt = {
  schemaVersion: 2,
  commit: git("rev-parse", "HEAD"),
  shortCommit: git("rev-parse", "--short=9", "HEAD"),
  nativeCandidateSourceSha256: sourceHash.digest("hex"),
  nativeCandidateFileCount: sourceFiles.length,
  workingTreeDirty: git("status", "--porcelain") !== "",
  dfhackTag: "53.15-r2",
  target: "dfcapture_public",
  canonicalExternalMatches,
  dll: {
    path: dll.replaceAll("\\", "/"),
    bytes: dllBytes.length,
    sha256: sha256(dllBytes),
    modifiedUtc: statSync(dll).mtime.toISOString(),
  },
};
const text = `${JSON.stringify(receipt, null, 2)}\n`;
const output = arg("--out");
if (output) writeFileSync(path.resolve(output), text);
else process.stdout.write(text);
if (!canonicalExternalMatches) process.exitCode = 1;
