import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const receipt = readFileSync(path.join(root, "tools", "release", "build_receipt.mjs"), "utf8");
const workflow = readFileSync(path.join(root, ".github", "workflows", "windows-native-build.yml"), "utf8");
assert.match(receipt, /nativeCandidateSourceSha256/, "receipt must fingerprint native candidate bytes");
assert.match(receipt, /"--others"/, "receipt must include new untracked native source files");
assert.match(receipt, /"CMakeLists\.txt", "src", "third_party"/,
  "receipt must define the native build-input boundary and avoid hashing itself");
assert.match(receipt, /canonicalExternalMatches/, "receipt must detect a stale/mirrored external plugin path");
assert.match(receipt, /sha256\(dllBytes\)/, "receipt must hash the compiled DLL");
assert.match(workflow, /ref: 53\.15-r2/, "CI must pin the supported DFHack tag");
assert.match(workflow, /add_subdirectory\(multi-dwarf\)/,
  "CI must register the project in a clean DFHack tag that has no external CMake file");
assert.match(workflow, /target dfcapture_public/, "CI must compile the actual plugin target");
assert.match(workflow, /actions\/upload-artifact@v4/, "CI must preserve the compiled artifact and receipt");
assert.doesNotMatch(workflow, /continue-on-error:\s*true/, "native compilation cannot be advisory green");
console.log("PASS native_build_receipt_test (pinned CI compile, source/DLL receipt, artifact upload)");
