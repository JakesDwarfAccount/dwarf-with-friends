// Offline lifecycle guard for world-stream caches and paused-idle snapshot invalidation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const stream = readFileSync(path.join(root, "src", "world_stream.cpp"), "utf8");
const plugin = readFileSync(path.join(root, "src", "dwf.cpp"), "utf8");

const reset = stream.match(/void reset_world_stream_state\(\) \{[\s\S]*?\n}/)?.[0];
assert(reset, "one world-stream reset function must own lifecycle cleanup");
for (const required of [
  "g_gms = GlobalMapState{}", "g_conn.clear()", "g_sig_scan_tick = 0",
  "g_paused_idle_ticks = 0", "g_itemdef_ready = false", "g_itemdef_frame.clear()",
  "g_unit_derived.clear()", "g_bld_derived.clear()", "g_race_caste_derived.clear()",
  "g_mat_rgb_derived.clear()", "g_last_read = LastReadState{}", "g_mapinfo = V1MapInfo{}",
]) assert(reset.includes(required), `world reset is missing ${required}`);

assert.match(plugin, /SC_WORLD_UNLOADED[\s\S]*?world_stream_set_world_loaded\(false\)/,
  "DFHack's world-unload event must close the stream gate");
assert.match(plugin, /SC_WORLD_LOADED[\s\S]*?world_stream_set_world_loaded\(true\)/,
  "DFHack's world-load event must reopen the stream gate");
assert.match(plugin, /plugin_init[\s\S]*?world_stream_set_world_loaded\(Core::getInstance\(\)\.isWorldLoaded\(\)\)/,
  "late plugin initialization must seed the gate from DFHack's current lifecycle state");
assert.match(stream, /void world_stream_set_world_loaded\(bool loaded\)[\s\S]*?g_world_loaded\.store\(loaded[\s\S]*?g_world_reset_requested\.store\(true/,
  "each lifecycle edge must publish the loaded gate before requesting a reset");
assert.match(stream, /lifecycle gate OPEN \(world loaded\)[\s\S]*?lifecycle gate CLOSED \(world unavailable\)/,
  "lifecycle edges must leave an explicit retest witness in the diagnostic log");
assert.match(stream, /g_world_reset_requested\.exchange\(false[\s\S]*?reset_world_stream_state\(\)/,
  "the push-thread owner must consume the cross-thread reset request");
assert.match(stream, /reset_world_stream_state\(\);[\s\S]*?if \(!g_world_loaded\.load\(std::memory_order_acquire\)\)[\s\S]*?return;[\s\S]*?auto conns = ws_v1_connections\(\)/,
  "an unloaded world must return before inspecting clients or taking DF locks");
assert.match(stream, /g_last_read\.valid = false;[\s\S]*?g_world_loaded\.load[\s\S]*?lock\(capture_mu\);[\s\S]*?g_world_loaded\.load[\s\S]*?CoreSuspender suspend;/,
  "the loaded gate must be rechecked around capture-lock acquisition before CoreSuspender");
assert.match(stream, /g_last_read\.valid = false;[\s\S]*?try \{[\s\S]*?g_last_read\.valid = true;/,
  "a fresh read must invalidate cached AUX before any early return and re-arm only after publish");
assert.match(stream, /if \(!Maps::IsValid\(\)\) \{[\s\S]*?reset_world_stream_state\(\);[\s\S]*?return;/,
  "an observed invalid map must reset even if the state-change callback was missed");

const seeded = reset.replace("g_mat_rgb_derived.clear();", "");
assert(!seeded.includes("g_mat_rgb_derived.clear();"),
  "TEST-THE-TEST: deleting one cache clear is detectable");

const ungated = stream.replace("if (!g_world_loaded.load(std::memory_order_acquire))\n        return;", "");
assert.notEqual(ungated, stream, "TEST-THE-TEST: deleting the unloaded-world return is detectable");

console.log("PASS world_reload_reset_test (unload gate, reload handoff, complete cache reset, stale-read invalidation, seeded omissions detected)");
