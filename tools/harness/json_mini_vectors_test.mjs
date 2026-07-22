// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturePath = path.join(root, "tools", "harness", "fixtures", "json_mini_vectors.json");
const vectors = JSON.parse(readFileSync(fixturePath, "utf8"));
const parser = readFileSync(path.join(root, "src", "json_mini.cpp"), "utf8");
const socket = readFileSync(path.join(root, "src", "websocket.cpp"), "utf8");
const plugin = readFileSync(path.join(root, "src", "dwf.cpp"), "utf8");

for (const vector of vectors) {
  let nativeJsonValid = true;
  try { JSON.parse(vector.input); } catch { nativeJsonValid = false; }
  assert.equal(nativeJsonValid, vector.jsonValid ?? vector.valid,
    `${vector.name}: fixture validity disagrees with JSON grammar`);
}

assert.match(parser, /duplicate object key/, "duplicate keys must be rejected deterministically");
assert.match(parser, /maximum depth exceeded/, "nesting must be bounded");
assert.match(parser, /number out of range/, "non-finite numeric results must be rejected");
assert.match(parser, /missing low surrogate|unexpected low surrogate/, "Unicode surrogate pairs must be checked");
assert.match(parser, /input exceeds 4096 bytes/, "the parser must enforce the control-message byte cap");
assert.match(parser, /std::floor\(item\.number\) != item\.number/, "REQ_BLOCKS coordinates must be integers");
assert.match(socket, /const json_mini::Doc doc = json_mini::parse\(payload\);/,
  "each control frame must be parsed once into a document");
assert.match(socket, /json_mini::string\(doc\.root, "type", message_type\)/,
  "message dispatch must read the top-level type field");
assert.doesNotMatch(socket, /json_has_type|json_number\(|json_string\(|json_int_triples/,
  "ad-hoc substring field scrapers must not return");
assert.match(socket, /control_json_error_log_ok\(\)/,
  "malformed-message diagnostics must be rate limited per connection");
assert.match(plugin, /json_mini::selftest\(\)/,
  "the compiled parser must test its grammar and accessors before the plugin loads");

const nestedShadow = JSON.parse(vectors.find((v) => v.name === "nested type shadow").input);
assert.equal(nestedShadow.type, "hello", "TEST-THE-TEST: top-level type wins over nested shadow");
assert.notEqual(nestedShadow.type, nestedShadow.cam.type,
  "TEST-THE-TEST: the nested shadow is observably different");

console.log(`PASS json_mini_vectors_test (${vectors.length} grammar vectors; strict typed dispatch guarded)`);
