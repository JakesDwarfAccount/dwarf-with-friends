// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Offline inventory guard for the strict C++/Lua return boundary. It cannot replace executing Lua,
// but it prevents a new bridge call or renamed Lua export from bypassing the signature registry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bridge = readFileSync(path.join(root, "src", "lua_bridge.cpp"), "utf8");
const orders = readFileSync(path.join(root, "src", "work_orders.cpp"), "utf8");
const lua = readFileSync(path.join(root, "dwf.lua"), "utf8");

const registeredBody = bridge.match(/bool validate_named_returns\([\s\S]*?\n}\n\ntemplate <typename Fn>/)?.[0];
assert(registeredBody, "validate_named_returns registry must exist before the lock wrapper");

const names = new Set();
for (const match of bridge.matchAll(/(?:call_lua|json_returning_lua(?:_int)?|bool_error_lua_int(?:_string)?)\("([a-z0-9_]+)"/g)) {
  names.add(match[1]);
}
for (const match of orders.matchAll(/register_json_route\([^\n]*"\/[^"]+",\s*"([a-z0-9_]+)"/g)) {
  names.add(match[1]);
}
for (const match of orders.matchAll(/order_json_via_lua_str\("([a-z0-9_]+)"/g)) names.add(match[1]);

assert(names.size >= 45, `expected the complete bridge surface, found only ${names.size} names`);
for (const name of [...names].sort()) {
  assert(registeredBody.includes(`"${name}"`), `${name} is called but has no strict return signature`);
  assert.match(lua, new RegExp(`(?:function\\s+${name}\\s*\\(|${name}\\s*=\\s*function\\s*\\()`),
    `${name} is registered in C++ but has no visible dwf.lua function definition`);
}

assert.match(bridge, /case 'b': matches = actual == LUA_TBOOLEAN;/,
  "boolean validation must reject merely truthy values");
assert.match(bridge, /case 'n': matches = actual == LUA_TNUMBER;/,
  "number validation must reject numeric strings");
assert.match(bridge, /case 's': matches = actual == LUA_TSTRING;/,
  "string validation must reject Lua's number-to-string coercion");
assert.match(bridge, /lua-bridge signature mismatch:/,
  "signature failures must be diagnostic, not silent defaults");
assert.match(bridge, /g_lua_signature_failures\.fetch_add\(1/,
  "signature failures must increment bridge health");
const server = readFileSync(path.join(root, "src", "http_server.cpp"), "utf8");
assert.match(server, /luaBridge[\s\S]*?signatureFailures/,
  "/diag must expose Lua bridge and signature-failure health");

const seededMissing = registeredBody.replace(`"${[...names][0]}"`, '"seeded_missing_export"');
assert(!seededMissing.includes(`"${[...names][0]}"`),
  "TEST-THE-TEST: deleting a called name from the registry is detected");

console.log(`PASS lua_bridge_signature_test (${names.size} called exports registered, strict primitive types, Lua definitions present, seeded missing export detected)`);
