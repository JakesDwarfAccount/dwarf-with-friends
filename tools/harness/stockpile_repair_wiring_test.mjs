#!/usr/bin/env node
// Stockpile save-repair WIRING test. The predecessor check (stockpile_settings_guard_test)
// proved repair_incomplete_stockpile_settings() existed -- and that let it sit uncalled with a
// missing holder for weeks. This test fails unless the repair is (a) actually invoked from the
// world-loaded plugin path and (b) covers ALL THREE places a save embeds df::stockpile_settings:
// stockpile buildings, hauling-route stops, and plotinfo.stockpile.custom_settings.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const part = readFileSync(join(root, "lua", "parts", "00-core.lua"), "utf8");
const built = readFileSync(join(root, "dwf.lua"), "utf8");
const plugin = readFileSync(join(root, "src", "dwf.cpp"), "utf8");
const bridge = readFileSync(join(root, "src", "lua_bridge.cpp"), "utf8");
const bridgeHeader = readFileSync(join(root, "src", "lua_bridge.h"), "utf8");

// --- (a) load-path wiring: the repair must run inside plugin_onstatechange's SC_WORLD_LOADED
// branch, not merely exist somewhere in the plugin.
const stateChange = plugin.slice(plugin.indexOf("plugin_onstatechange"));
assert.ok(stateChange.length > 20, "plugin_onstatechange exists in src/dwf.cpp");
const loadedBranch = stateChange.match(
  /if \(event == SC_WORLD_LOADED\) \{([\s\S]*?)\n    \}/);
assert.ok(loadedBranch, "plugin_onstatechange has a dedicated SC_WORLD_LOADED branch");
assert.match(loadedBranch[1], /repair_stockpile_settings_via_lua\(/,
  "the SC_WORLD_LOADED branch invokes the stockpile settings repair");
assert.match(loadedBranch[1], /diagnostics_log\("stockpile-repair-on-load/,
  "the repair reports a healed count to the diagnostics log");

// --- the bridge really calls the Lua function (and validates its two numeric returns).
assert.match(bridge, /call_lua\("repair_incomplete_stockpile_settings", std::make_tuple\(\), 2/,
  "bridge calls repair_incomplete_stockpile_settings expecting (holders, categories)");
assert.match(bridge,
  /"repair_incomplete_stockpile_settings"\) == 0\) \{\s*\n\s*return returns == 2/,
  "bridge registers the repair's return signature");
assert.match(bridgeHeader, /bool repair_stockpile_settings_via_lua\(/,
  "bridge exports repair_stockpile_settings_via_lua");

// --- (b) three-holder coverage, in BOTH the source part and the built dwf.lua artifact.
for (const [name, source] of [["lua/parts/00-core.lua", part], ["dwf.lua", built]]) {
  const fn = source.match(
    /function repair_incomplete_stockpile_settings\(\)([\s\S]*?)\nend\n/);
  assert.ok(fn, `${name}: repair_incomplete_stockpile_settings() exists`);
  const body = fn[1];
  assert.match(body, /df\.building_stockpilest:is_instance\(bld\)\s+then\s+repair\(bld\)/,
    `${name}: repair covers stockpile buildings`);
  assert.match(body, /route\.stops.*do\s+repair\(stop\)/,
    `${name}: repair covers hauling-route stops`);
  assert.match(body, /plotinfo\.stockpile\.custom_settings/,
    `${name}: repair reaches plotinfo.stockpile.custom_settings`);
  assert.match(body, /repair\(\{settings = custom\}\)/,
    `${name}: repair normalizes the custom-stockpile buffer (settings-object adapter)`);
}

console.log("PASS stockpile save-repair is wired to world load and covers all three holders");
