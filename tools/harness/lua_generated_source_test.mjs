import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(path.join(root, "lua", "dwf.parts.json"), "utf8"));
assert.equal(manifest.parts.length, 6, "the initial extraction must expose real domain seams");
const combined = Buffer.concat(manifest.parts.map((part) => readFileSync(path.join(root, part))));
assert(combined.equals(readFileSync(path.join(root, manifest.output))),
  "the installed single Lua module must be exactly the ordered source bytes");
const names = manifest.parts.map((part) => path.basename(part));
assert.deepEqual(names, [...names].sort(), "part names must make load order obvious");
const bridge = readFileSync(path.join(root, "src", "lua_bridge.cpp"), "utf8");
assert.match(bridge, /bool validate_named_returns[\s\S]*?no registered Lua return signature/,
  "the generated source workflow must retain the frozen C++-visible export registry");
console.log(`PASS lua_generated_source_test (${manifest.parts.length} parts, byte-identical artifact, frozen exports)`);
