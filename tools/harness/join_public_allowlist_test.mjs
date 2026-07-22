// Explicit pre-login asset policy: extensions never grant authorization.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(path.join(root, "src", "http_server.cpp"), "utf8");
const body = source.slice(source.indexOf("bool join_public_path"), source.indexOf("bool local_diagnostic_path"));

assert.match(body, /kPublicPrefixes/, "public directory prefixes must be explicit");
assert.match(body, /kPublicFiles/, "public root files must be explicit");
assert.doesNotMatch(body, /kExt|path\.compare\(path\.size\(\) - el|\.jpg.*\.jpeg/,
  "a static-looking extension must not grant pre-login access");
for (const protectedPath of ["/frame.jpg", "/tiledump", "/diag", "/texture-lab.html", "/tiles.html"])
  assert(!body.includes(`\"${protectedPath}\"`), `${protectedPath} must not be public`);
for (const required of ["/js/", "/css/", "/fonts/", "/index.html", "/interface_map.json"])
  assert(body.includes(`\"${required}\"`), `${required} is required by the pre-login shell`);

const legacyAllows = (candidate) => /\.(?:js|css|json|png|html|jpg)$/.test(candidate);
assert(legacyAllows("/secret-diagnostic.jpg"),
  "TEST-THE-TEST: the removed extension policy would expose an arbitrary diagnostic");

console.log("PASS join_public_allowlist_test (explicit shell assets; extension bypass removed)");
