// Offline guard for the canonical fortress-entity resolver in dwf.lua.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lua = readFileSync(path.join(root, "dwf.lua"), "utf8");
const definitions = [...lua.matchAll(/\bfunction\s+fort_entity\s*\(\s*\)/g)];
assert.equal(definitions.length, 1, "dwf.lua must have one authoritative fort_entity definition");
const body = lua.slice(definitions[0].index, lua.indexOf("\nend", definitions[0].index) + 4);
assert.match(body, /plotinfo/);
assert.match(body, /main\.fortress_entity/,
  "canonical resolver must use DF's fortress_entity pointer, not reconstruct it from group_id");
assert.doesNotMatch(lua, /historical_entity\.find\(plotinfo\.group_id/,
  "the dead group-id resolver must not return");

const seeded = `${lua}\nfunction fort_entity() return nil end\n`;
assert.equal([...seeded.matchAll(/\bfunction\s+fort_entity\s*\(\s*\)/g)].length, 2,
  "TEST-THE-TEST: a duplicate definition is detected");

console.log("PASS lua_fort_entity_test (one canonical fortress_entity resolver; seeded duplicate detected)");
