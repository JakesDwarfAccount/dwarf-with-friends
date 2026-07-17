// b74_b93_surfaces_test.mjs -- SURFACES wave acceptance/regression gate.
//
// Two friend/bug reports, one mechanism family (a player-transformed surface resolves to the
// UNtransformed art because a resolver ignored the transform):
//
//   B74 "no textures for smoothed walls or floors": smoothing a wall/floor produces a DISTINCT
//        df::tiletype (special=SMOOTH; worn-down smoothed walls carry special=WORN_1..3) that DF
//        draws from a dedicated art family. The client ignored that:
//          - WALLS resolve via wallPrefix()->wallJoinBaseToken (resolveSprite returns null for
//            shape WALL), which keyed ONLY on material -> every smoothed/worn stone wall drew the
//            rough STONE_WALL (or ORE_VEIN/MAGMA) family. Fix: wallDetailPrefix() routes
//            *WallSmooth<dirs> -> SMOOTHED_STONE_WALL_* / SMOOTHED_ICE_WALL_* and *WallWorn{n} ->
//            WORN{n}_STONE_WALL_* (no worn-ice art in the raws -> worn ice degrades to smoothed
//            ice), reusing the SAME open-face infix + variant cascade. Both renderers.
//          - FLOORS resolve via tiletype_token_map.json; build_tiletype_token_map.py collapsed
//            smoothed stone floors (StoneFloorSmooth/Mineral/Feature/Lava) onto the rough
//            STONE_FLOOR_5+overlay because classify() ignored special=SMOOTH. Fix: -> SMOOTH_FLOOR
//            (the dedicated smoothed-stone floor cell; ICE already routed to SMOOTH_ICE_FLOOR).
//
//   B93 "missing textures for constructed roads": roads are df::building_type RoadPaved/RoadDirt
//        (NOT tiletypes), resolved via buildingMap[type]; no road key was ever emitted, so both
//        fell to MISSING_BUILDING (the friend's "?"/box screenshot). Fix: build_building_map.py
//        emits RoadPaved/RoadDirt pointing at DF's own road cells (BLD_PAVED_ROAD =
//        paved_block_roads.png:0:0, BLD_DIRT_ROAD = floors.png:6:1).
//
// Protocol compliance:
//  (1) MATRIX: every smoothed/worn family x material (stone/mineral/feature/obsidian/ice), plus
//      the rough + constructed walls that must stay on their existing family.
//  (2) ORACLE-DIFFERENTIAL: every token this fix emits EXISTS in DF's own graphics raws
//      (graphics_tiles.txt) -- never a fabricated cell.
//  (3) TEST-THE-TEST: each assertion encodes the POST-fix value and FAILS against the pre-fix
//      behaviour (smoothed wall -> rough STONE_WALL; smoothed floor -> STONE_FLOOR_5; road ->
//      absent/MISSING_BUILDING). The _wallDetailPrefixForTest hooks do not exist pre-fix.
//  (5) PARITY: canvas2d (dwf-tiles.js) and GL (dwf-gl.js) agree on wallDetailPrefix
//      for every matrix cell.
//
// Run: node tools/harness/b74_b93_surfaces_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { dfRootOrSkip } from "../lib/dfroot.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const ADJ_PATH = path.join(ROOT, "web/js/dwf-adjacency.js");
const TILES_PATH = path.join(ROOT, "web/js/dwf-tiles.js");
const GL_PATH = path.join(ROOT, "web/js/dwf-gl.js");
// W1: resolved, never hardcoded. No DF install -> this suite SKIPs (exit 0),
// because its ground truth IS the raws: without them there is nothing to check against.
const DF_ROOT_W1 = dfRootOrSkip("b74_b93_surfaces_test.mjs");
const DF_GFX = path.join(DF_ROOT_W1, "data/vanilla/vanilla_environment/graphics/graphics_tiles.txt");

let failed = 0;
function check(name, cond) { if (cond) console.log("  ok   - " + name); else { failed++; console.log("  FAIL - " + name); } }

// ---- oracle: TOKENs that actually exist in DF's graphics raws (read-only) ------------------
const gfxText = fs.readFileSync(DF_GFX, "utf8");
const availableTokens = new Set();
{
  const re = /TILE_GRAPHICS:[^:\]]+:\d+:\d+:([A-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(gfxText))) availableTokens.add(m[1]);
}
// A wall base token resolves in the renderer via the [base+"_"+v, base+"_1", base] variant
// cascade (drawWallJoin/wallJoinCell). The FULL 4-way cells ship ONLY with a variant digit
// (STONE_WALL_N_S_W_E_1..4, WORN{n}_STONE_WALL_N_S_W_E_1..4 -- no bare form), while partial/
// diagonal cells (N, N_S, NW, ...) and the whole SMOOTHED_* family ship bare. hasCell() mirrors
// exactly what the renderer will find, so the oracle proves a real drawable cell either way.
function hasCell(base) { return availableTokens.has(base) || availableTokens.has(base + "_1"); }

// ---- DOM-less globals (same shape as b62_trunk_walljoin_test.mjs) --------------------------
class FakeImage { constructor() { this.onload = null; this.onerror = null; this._src = ""; this.width = 32; this.height = 32; } set src(v) { this._src = v; } get src() { return this._src; } }
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
}
const storageBacking = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: (k) => (k in storageBacking ? storageBacking[k] : null), setItem: (k, v) => { storageBacking[k] = String(v); } };
globalThis.Image = FakeImage;
globalThis.fetch = async () => ({ ok: false, json: async () => null });

// Load adjacency (wallJoinBaseToken reads window.DwfAdjacency), then the canvas2d renderer.
vm.runInThisContext(fs.readFileSync(ADJ_PATH, "utf8"), { filename: ADJ_PATH });
const Adj = globalThis.DwfAdjacency;
assert.ok(Adj && typeof Adj.wallCellSuffix === "function", "adjacency must export wallCellSuffix");
vm.runInThisContext(fs.readFileSync(TILES_PATH, "utf8"), { filename: TILES_PATH });
const T = globalThis.DwfTiles;
assert.ok(T, "dwf-tiles.js did not install DwfTiles");
assert.ok(typeof T._wallDetailPrefixForTest === "function", "missing _wallDetailPrefixForTest hook (B74 fix not applied?)");
assert.ok(typeof T._wallJoinBaseTokenForTest === "function", "missing _wallJoinBaseTokenForTest hook");

// Load the GL renderer in its own sandbox (same convention as b62).
const glSandbox = { self: {}, performance: { now: () => 0 } };
glSandbox.self = glSandbox;
vm.createContext(glSandbox);
vm.runInContext(fs.readFileSync(GL_PATH, "utf8"), glSandbox, { filename: "dwf-gl.js" });
const GL = glSandbox.DwfGL;
assert.ok(GL && typeof GL.wallDetailPrefix === "function", "GL missing _wallDetailPrefixForTest hook (B74 fix not applied?)");

// full-cardinal open-face mask (N|S|W|E) -> infix "N_S_W_E", present in every wall family
const OPEN_ALL = 1 | 2 | 4 | 8;
const INFIX_ALL = Adj.wallCellSuffix(OPEN_ALL);
check("adjacency full-open mask -> N_S_W_E infix (sanity)", INFIX_ALL === "N_S_W_E");

// ============================ (1)+(5) WALL MATRIX + parity ==================================
console.log("(1) WALL MATRIX: smoothed/worn family x material, + rough/constructed unchanged");
// [ttname, mat, expected wallDetailPrefix (null = keep rough wallPrefix), expected base @ OPEN_ALL]
const WALLS = [
  // smoothed -> SMOOTHED_STONE_WALL (stone/mineral/feature/obsidian all smooth to plain stone)
  ["StoneWallSmoothLRUD",   "STONE",         "SMOOTHED_STONE_WALL", "SMOOTHED_STONE_WALL_N_S_W_E"],
  ["MineralWallSmoothLRUD", "MINERAL",       "SMOOTHED_STONE_WALL", "SMOOTHED_STONE_WALL_N_S_W_E"],
  ["FeatureWallSmoothLRUD", "FEATURE",       "SMOOTHED_STONE_WALL", "SMOOTHED_STONE_WALL_N_S_W_E"],
  ["LavaWallSmoothLRUD",    "LAVA_STONE",    "SMOOTHED_STONE_WALL", "SMOOTHED_STONE_WALL_N_S_W_E"],
  // smoothed ice -> SMOOTHED_ICE_WALL
  ["FrozenWallSmoothLRUD",  "FROZEN_LIQUID", "SMOOTHED_ICE_WALL",   "SMOOTHED_ICE_WALL_N_S_W_E"],
  // worn (weathered smoothed) -> WORN{n}_STONE_WALL
  ["StoneWallWorn1",        "STONE",         "WORN1_STONE_WALL",    "WORN1_STONE_WALL_N_S_W_E"],
  ["StoneWallWorn2",        "STONE",         "WORN2_STONE_WALL",    "WORN2_STONE_WALL_N_S_W_E"],
  ["StoneWallWorn3",        "STONE",         "WORN3_STONE_WALL",    "WORN3_STONE_WALL_N_S_W_E"],
  ["MineralWallWorn2",      "MINERAL",       "WORN2_STONE_WALL",    "WORN2_STONE_WALL_N_S_W_E"],
  // worn ice: no worn-ice art in the raws -> degrade to smoothed-ice (closest real cell)
  ["FrozenWallWorn1",       "FROZEN_LIQUID", "SMOOTHED_ICE_WALL",   "SMOOTHED_ICE_WALL_N_S_W_E"],
  // rough / constructed: wallDetailPrefix stays null, existing family kept (regression guard)
  ["StoneWall",             "STONE",         null,                  "STONE_WALL_N_S_W_E"],
  ["MineralWall",           "MINERAL",       null,                  "ORE_VEIN_WALL_N_S_W_E"],
  ["ConstructedWallRUD",    "CONSTRUCTION",  null,                  "ROCK_BLOCKS_WALL_N_S_W_E"],
];
for (const [ttname, mat, wantPrefix, wantBase] of WALLS) {
  const t = { shape: "WALL", mat, ttname };
  const cPrefix = T._wallDetailPrefixForTest(t);
  const gPrefix = GL.wallDetailPrefix(t);
  check(ttname + " detailPrefix === " + JSON.stringify(wantPrefix), cPrefix === wantPrefix);
  check(ttname + " PARITY gl==c2d detailPrefix", cPrefix === gPrefix);
  const base = T._wallJoinBaseTokenForTest(t, OPEN_ALL);
  check(ttname + " base @OPEN_ALL === " + wantBase, base === wantBase);
  // (2) ORACLE-DIFFERENTIAL: the emitted base token exists in DF's own graphics raws
  check("  oracle(cascade): " + wantBase + " resolves in graphics_tiles.txt", hasCell(wantBase));
}

// (3) TEST-THE-TEST: the pre-fix behaviour (smoothed/worn wall -> rough STONE_WALL family) MUST fail
console.log("(3) TEST-THE-TEST: smoothed/worn walls must NOT be the rough family");
check("[seed] smoothed stone wall base is NOT STONE_WALL_* (pre-fix bug)",
  T._wallJoinBaseTokenForTest({ shape: "WALL", mat: "STONE", ttname: "StoneWallSmoothLRUD" }, OPEN_ALL).indexOf("STONE_WALL_") !== 0);
check("[seed] worn stone wall base is NOT STONE_WALL_* (pre-fix bug)",
  T._wallJoinBaseTokenForTest({ shape: "WALL", mat: "STONE", ttname: "StoneWallWorn1" }, OPEN_ALL).indexOf("STONE_WALL_") !== 0);
check("[seed] smoothed mineral wall is NOT the rough ORE_VEIN family",
  T._wallJoinBaseTokenForTest({ shape: "WALL", mat: "MINERAL", ttname: "MineralWallSmoothLRUD" }, OPEN_ALL).indexOf("ORE_VEIN") !== 0);

// direction still flows from open-face adjacency (a partial mask keeps its infix, not N_S_W_E)
console.log("infix still driven by open-face adjacency (not the ttname's own SmoothLRUD dirs)");
for (const mask of [1, 2, 4, 8, 3, 12, 5, 7, 15]) {
  const infix = Adj.wallCellSuffix(mask);
  if (!infix) continue;
  const base = T._wallJoinBaseTokenForTest({ shape: "WALL", mat: "STONE", ttname: "StoneWallSmoothLRUD" }, mask);
  check("smoothed stone @mask " + mask + " -> SMOOTHED_STONE_WALL_" + infix, base === "SMOOTHED_STONE_WALL_" + infix);
  check("  oracle(cascade): SMOOTHED_STONE_WALL_" + infix + " resolves", hasCell("SMOOTHED_STONE_WALL_" + infix));
}
// fully-buried (mask 0) still draws nothing (darkened fill only), smoothed or not
check("fully-buried smoothed wall (mask 0) -> null (unchanged)",
  T._wallJoinBaseTokenForTest({ shape: "WALL", mat: "STONE", ttname: "StoneWallSmoothLRUD" }, 0) === null);
// tree/mushroom exemption is preserved even if a bogus smooth ttname is attached
check("TREE wall stays exempt (null) regardless of ttname",
  T._wallJoinBaseTokenForTest({ shape: "WALL", mat: "TREE", ttname: "StoneWallSmoothLRUD" }, OPEN_ALL) === null);

// ============================ SMOOTHED FLOORS (token map) ===================================
console.log("(1) SMOOTHED FLOORS: tiletype_token_map.json routes special=SMOOTH stone -> SMOOTH_FLOOR");
const tokenMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/tiletype_token_map.json"), "utf8"));
for (const ttname of ["StoneFloorSmooth", "MineralFloorSmooth", "FeatureFloorSmooth", "LavaFloorSmooth"]) {
  const e = tokenMap[ttname];
  check(ttname + " -> SMOOTH_FLOOR (no rough overlay)", !!e && e.token === "SMOOTH_FLOOR" && !e.overlay);
  check("  oracle: SMOOTH_FLOOR exists in graphics_tiles.txt", availableTokens.has("SMOOTH_FLOOR"));
}
// the ICE parallel that was ALREADY correct -- guards against a regression of the sibling
check("FrozenFloorSmooth -> SMOOTH_ICE_FLOOR (already-correct ice parallel)",
  tokenMap.FrozenFloorSmooth && tokenMap.FrozenFloorSmooth.token === "SMOOTH_ICE_FLOOR");
// (3) TEST-THE-TEST: pre-fix smoothed floors were STONE_FLOOR_5 (rough); rough floor unchanged
console.log("(3) TEST-THE-TEST: smoothed floor must NOT be the rough STONE_FLOOR_5");
check("[seed] StoneFloorSmooth is NOT STONE_FLOOR_5 (pre-fix bug)", tokenMap.StoneFloorSmooth.token !== "STONE_FLOOR_5");
check("rough StoneFloor1 UNCHANGED -> STONE_FLOOR_5 + STONE_FLOOR_1 overlay",
  tokenMap.StoneFloor1 && tokenMap.StoneFloor1.token === "STONE_FLOOR_5" && tokenMap.StoneFloor1.overlay === "STONE_FLOOR_1");

// ============================ B93 CONSTRUCTED ROADS (building map) ==========================
console.log("(1) B93: building_map.json routes RoadPaved/RoadDirt to DF's road art");
const bmap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/building_map.json"), "utf8"));
function firstCell(e) { return e && Array.isArray(e.cells) && e.cells[0] && e.cells[0][0]; }
{
  const rp = bmap.RoadPaved, rc = firstCell(rp);
  check("RoadPaved -> paved_block_roads.png cell 0,0 (BLD_PAVED_ROAD)",
    !!rp && rp.sheet === "paved_block_roads.png" && !!rc && rc.col === 0 && rc.row === 0);
  const rd = bmap.RoadDirt, dc = firstCell(rd);
  check("RoadDirt -> floors.png cell 6,1 (BLD_DIRT_ROAD)",
    !!rd && rd.sheet === "floors.png" && !!dc && dc.col === 6 && dc.row === 1);
  // (2) ORACLE: the road tokens DF binds those exact cells to exist in the raws
  check("  oracle: BLD_PAVED_ROAD exists in graphics_tiles.txt", availableTokens.has("BLD_PAVED_ROAD"));
  check("  oracle: BLD_DIRT_ROAD exists in graphics_tiles.txt", availableTokens.has("BLD_DIRT_ROAD"));
  // 1x1 entry => pattern-tiles across the whole road footprint (client's documented 1x1 stamp path)
  check("RoadPaved is a 1x1 entry (footprint pattern-tile, like bridges)", rp.w === 1 && rp.h === 1);
  check("RoadDirt is a 1x1 entry", rd.w === 1 && rd.h === 1);
}
// (3) TEST-THE-TEST: pre-fix both road types were absent -> MISSING_BUILDING fallback
console.log("(3) TEST-THE-TEST: roads were absent pre-fix (fell to MISSING_BUILDING)");
check("[seed] RoadPaved key now present (was undefined -> MISSING_BUILDING)", bmap.RoadPaved !== undefined);
check("[seed] RoadDirt key now present (was undefined -> MISSING_BUILDING)", bmap.RoadDirt !== undefined);

if (failed) { console.error("\nFAILED: " + failed + " checks"); process.exit(1); }
console.log("\nAll B74/B93 SURFACES checks passed.");
