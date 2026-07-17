// Opening the stockpile settings editor must be one read-only snapshot, never a request/render
// waterfall and never an implicit Ammo write.
import assert from "node:assert/strict";
import fs from "node:fs";

const lua = fs.readFileSync(new URL("../../dwf.lua", import.meta.url), "utf8");
const bridge = fs.readFileSync(new URL("../../src/lua_bridge.cpp", import.meta.url), "utf8");
// B212: the stockpile routes live in register_stockpile_routes (src/stockpile_panel.cpp) now.
const http = fs.readFileSync(new URL("../../src/stockpile_panel.cpp", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../../web/js/dwf-building-zone-stockpile-panels.js", import.meta.url), "utf8");

const snapStart = lua.indexOf("function stockpile_settings_snapshot");
const snapEnd = lua.indexOf("\nend", snapStart) + 4;
assert.ok(snapStart >= 0, "Lua snapshot exists");
const snap = lua.slice(snapStart, snapEnd);
assert.doesNotMatch(snap, /sp_group_set|stockpile_toggle|import_settings|settings\.flags\[[^\]]+\]\s*=/,
  "snapshot cannot mutate stockpile settings");
assert.match(lua, /local function sp_group_peek[\s\S]*?if g\.fixed or idx < #vec/,
  "snapshot reads short vectors without extending them");
assert.match(bridge, /stockpile_settings_snapshot_via_lua[\s\S]*?stockpile_settings_snapshot/);
assert.match(http, /server\.Get\("\/stockpile-settings-snapshot"/);

const openStart = client.indexOf("function openSpEditor");
const openEnd = client.indexOf("async function speFetchSnapshot", openStart);
const open = client.slice(openStart, openEnd);
assert.match(open, /await speFetchSnapshot\(seq\)/, "open waits for one snapshot");
assert.doesNotMatch(open, /stockpile-set|toggleSpe|postStockpile/, "open has no write path");
assert.doesNotMatch(client, /function spePumpAll|progressive FINAL paints/,
  "serial subgroup waterfall is gone");
assert.match(client, /function speDefaultCat\(\)[\s\S]*?return SP_EDIT_CATS\[0\]\[1\]/,
  "selection does not depend on enabled flags");

console.log("stockpile settings snapshot: PASS (one atomic read, no waterfall, no auto-enable)");
