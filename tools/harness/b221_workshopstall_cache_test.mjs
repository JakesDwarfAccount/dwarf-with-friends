// b221_workshopstall_cache_test.mjs -- B221 "craftsdwarf workshop_info stalls the core >1.5s".
//
//   node tools/harness/b221_workshopstall_cache_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// ROOT CAUSE (from the B213 wave, verified in code): GET /workshop-info -> building_zone.cpp ->
// lua_bridge run_lua_locked holds a FULL CoreSuspender -> dwf.lua workshop_info -> for a
// craftsdwarf, native_menu_tree(b) -> craftsdwarf_tree runs getJobs + cd_reaction_cat scanning ALL
// raws reactions TWICE (INSTRUMENT_PIECE + INSTRUMENT) + itemdefs, on EVERY panel open, while the
// sim is suspended. On a real fort this exceeds the 1500 ms busy watchdog -> every player freezes.
//
// FIX (this wave): the native add-task tree derives ONLY from world raws + the fort entity, which are
// FIXED for a world session, so it is STATIC. Split the pure build into native_build_tree and cache
// its result per (shop_key,type,subtype), scoped to the loaded save (cur_savegame.save_dir). Live
// per-leaf availability stays OUT of the cache -- annotate_native_avail runs fresh in workshop_info on
// every open -- so the served JSON is byte-identical to the un-cached path, just without the raws scan.
//
// This is a SOURCE-TIE test (no live DF here). It pins the caching structure and the live/static
// split. LIVE-PROFILE on the host before deploy: time GET /workshop-info?id=<craftsdwarf>
// first open vs repeat opens, before vs after -- repeat opens must land well under 1500 ms (no banner).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const lua = read("dwf.lua");

let passed = 0, failed = 0;
function check(fn, name) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { failed++; console.log(`  FAIL - ${name}: ${err.message}`); }
}

// Slice a top-level `function name(...)` / `local function name(...)` body: from its header to the
// FIRST line that is exactly `end` at column 0 (all the native builders are column-0 functions).
function sliceFn(src, header) {
  const start = src.indexOf(header);
  assert.notEqual(start, -1, `could not find ${header}`);
  const rest = src.slice(start);
  const m = rest.match(/\nend\b/);
  assert.ok(m, `could not find end of ${header}`);
  return rest.slice(0, m.index + m[0].length);
}

console.log("# the pure builder is separated from the cache wrapper");
check(() => assert.match(lua, /local function native_build_tree\(b\)/),
  "native_build_tree exists (the pure, cacheable static-tree builder)");
check(() => assert.match(lua, /function native_menu_tree\(b\)/),
  "native_menu_tree exists (the caching wrapper callers use)");
check(() => {
  const build = sliceFn(lua, "local function native_build_tree(b)");
  assert.match(build, /craftsdwarf_tree\(bt, st\)/, "builder still dispatches craftsdwarf_tree");
  assert.match(build, /smelter_tree\(bt, st\)/, "builder still dispatches smelter_tree");
}, "native_build_tree still routes every native shop (craftsdwarf/smelter/kennels/entity)");

console.log("# native_menu_tree caches the static tree, keyed and world-scoped");
const wrap = sliceFn(lua, "function native_menu_tree(b)");
check(() => assert.match(lua, /local _native_tree_cache = \{\}/),
  "a module-level cache table _native_tree_cache exists");
check(() => assert.match(lua, /local _native_tree_cache_save/),
  "a world-scope guard _native_tree_cache_save exists");
check(() => assert.match(wrap, /cur_savegame\.save_dir/),
  "cache scope is the loaded save (cur_savegame.save_dir)");
check(() => assert.match(wrap, /if save ~= _native_tree_cache_save then[\s\S]*_native_tree_cache = \{\}/),
  "a different save (world change / reload) DROPS the whole cache -- invalidation is explicit");
check(() => assert.match(wrap, /shop_subtype_key\(b\) \.\. ':' \.\. tostring\(b:getType\(\)\) \.\. ':' \.\. tostring\(b:getSubtype\(\)\)/),
  "cache key = (shop_key, building type, subtype) -- unique per static tree");
check(() => assert.match(wrap, /local hit = _native_tree_cache\[key\][\s\S]*if hit ~= nil then return hit end/),
  "a cache HIT returns immediately -- repeat opens skip native_build_tree (the raws scan)");
check(() => assert.match(wrap, /local tree = native_build_tree\(b\)[\s\S]*_native_tree_cache\[key\] = tree/),
  "a cache MISS builds once via native_build_tree, then stores it");

console.log("# live per-leaf availability is NEVER cached (byte-identical output invariant)");
check(() => {
  const build = sliceFn(lua, "local function native_build_tree(b)");
  assert.doesNotMatch(build, /annotate_native_avail/,
    "native_build_tree must not annotate availability into the cached tree");
  assert.doesNotMatch(build, /build_presence/,
    "native_build_tree must not read live IN_PLAY items");
}, "the cached builder holds NO live fort state (no annotate, no item scan)");
check(() => assert.doesNotMatch(wrap, /annotate_native_avail/),
  "native_menu_tree (the cache) never annotates -- availability is applied outside it");
check(() => assert.match(lua, /native_root = ws_section\('native_menu_tree'/),
  "workshop_info fetches the (cached) tree as native_root");
check(() => assert.match(lua, /annotate_native_avail\(native_root\)/),
  "workshop_info annotates native_root FRESH on every open (live availability)");
check(() => {
  // annotate must derive availability from a live IN_PLAY item pass, so avail tracks current fort state.
  const ann = sliceFn(lua, "annotate_native_avail = function(root)");
  assert.match(ann, /build_presence\(\)/, "annotate reads live presence via build_presence()");
}, "annotate_native_avail computes availability from live items, not from the cache");

console.log("# TEST-THE-TEST");
check(() => {
  // If the cache-hit early return were removed, the "cache HIT returns immediately" assertion must fail.
  const broken = wrap.replace(/if hit ~= nil then return hit end/, "-- (removed)");
  assert.doesNotMatch(broken, /if hit ~= nil then return hit end/);
}, "removing the cache-hit early return would be caught");
check(() => {
  // If someone moved annotate INTO the cached builder, the "builder holds no live state" check catches it.
  const poisoned = "local function native_build_tree(b)\n  annotate_native_avail(x)\nend";
  const build = sliceFn(poisoned, "local function native_build_tree(b)");
  assert.match(build, /annotate_native_avail/); // proves the slice would SEE such a regression
}, "annotate leaking into the cached builder would be caught");

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
