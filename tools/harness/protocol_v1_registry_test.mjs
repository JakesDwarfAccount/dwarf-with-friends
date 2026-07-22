import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const registry = JSON.parse(readFileSync(path.join(root, "tools", "protocol", "v1-registry.json"), "utf8"));
const cpp = readFileSync(path.join(root, "src", "wire_v1.h"), "utf8");
const js = readFileSync(path.join(root, "web", "js", "dwf-wire-v1.js"), "utf8");
const cppNames = { BLOCK_SET:"kTypeBlockSet", AUX:"kTypeAux", ITEMDEF_DICT:"kTypeItemDefDict" };
const jsNames = { BLOCK_SET:"TYPE_BLOCK_SET", AUX:"TYPE_AUX", ITEMDEF_DICT:"TYPE_ITEMDEF_DICT" };
for (const [name, value] of Object.entries(registry.frameTypes)) {
  const hex = `0x${value.toString(16).padStart(2, "0")}`;
  assert(new RegExp(`${cppNames[name]}\\s*=\\s*${hex}`, "i").test(cpp), `C++ ${name} drifted`);
  assert(new RegExp(`${jsNames[name]}:\\s*${hex}`, "i").test(js), `JavaScript ${name} drifted`);
}
assert.match(cpp, new RegExp(`kHeaderSize\\s*=\\s*${registry.headerBytes}`));
assert.match(js, new RegExp(`HEADER_SIZE:\\s*${registry.headerBytes}`));
assert.match(cpp, new RegExp(`kTileRecordSize\\s*=\\s*${registry.tileRecordBytes}`));
assert.match(js, new RegExp(`TILE_RECORD_SIZE:\\s*${registry.tileRecordBytes}`));
for (const [name, value] of Object.entries(registry.tailKinds)) {
  const jsName = `TAIL_${name}`;
  const hex = `0x${value.toString(16).padStart(2, "0")}`;
  assert(new RegExp(`${jsName}:\\s*${hex}`, "i").test(js), `JavaScript tail ${name} drifted`);
}
console.log(`PASS protocol_v1_registry_test (${Object.keys(registry.frameTypes).length} frames, ${Object.keys(registry.tailKinds).length} tails)`);
