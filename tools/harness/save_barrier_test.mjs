import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const dwf = read("src/dwf.cpp");
const barrier = read("src/save_barrier.cpp");
const http = read("src/http_server.cpp");
const lua = read("src/lua_bridge.cpp");

assert.match(dwf, /plugin_save_site_data[\s\S]*save_barrier_begin/,
  "DFHack's authoritative pre-save callback must engage the barrier");
assert.match(dwf, /plugin_onupdate[\s\S]*save_barrier_update/,
  "core updates must own post-save barrier release");
assert.match(barrier, /autosave_request/);
assert.match(barrier, /do_manual_save/);
assert.match(barrier, /viewscreen_savegamest/);
assert.match(barrier, /\+\+g_clear_frames < 3/,
  "barrier must survive multiple completed cleanup frames");
assert.match(http, /if \(save_barrier_active\(\)\)[\s\S]*res\.status = 503/,
  "all HTTP routes must fail busy while saving");
assert.match(lua, /CoreSuspender suspend;[\s\S]*if \(save_barrier_active\(\)\) return false/,
  "queued Lua world writes must re-check after acquiring the core lock");

console.log("PASS save barrier lifecycle and queued-write recheck");
