// b269_mining_indicators_test.mjs -- B269 acceptance ("when a mining task gets cancelled
// because it's discovered that it's a damp tile, it gets this drop icon over it in mine (hotkey m)
// mode. Ours does not have that icon.")
// Oracle: evidence/oracles/designations/DESIG-DAMP-TILE-CANCEL-native.png
//
// DF'S REAL MODEL (established, not guessed):
//   * The sprites exist in DF's own raws and ALREADY in our web/interface_map.json:
//       data/vanilla/vanilla_interface/graphics/graphics_interface.txt:3300-3301
//         [TILE_GRAPHICS:MINING_INDICATORS:0:0:DAMP_STONE_WARNING]   -> mining_indicators.png (0,0) blue drop
//         [TILE_GRAPHICS:MINING_INDICATORS:1:0:WARM_STONE_WARNING]   -> mining_indicators.png (1,0) heat waves
//       tile_page_interface.txt:200 -> images/mining_indicators.png, TILE_DIM 32:32, 64x32.
//     They are served today by /sprites/img/<name> (src/http_server.cpp:844 already scans
//     vanilla_interface/graphics/images) -- no DLL change was ever needed for the ART.
//   * DF stores NO per-tile "this dig was cancelled for damp" marker. Exhaustive search of
//     df-structures (tile_designation, tile_occupancy, block_flags, map_block,
//     designation_interfacest) finds nothing. The overlay is therefore DERIVED from map state,
//     which is why it survives the designation being cleared on cancellation -- and why, with no
//     icon of our own, the designation simply VANISHES for our players with no explanation.
//   * The predicate is the one DFHack's `dig` plugin uses to replicate DF's own cancel rule
//     (dfhack/plugins/dig.cpp):
//       is_wet(x,y,z) := (liquid_type==Water && flow_size>=1) || is_aquifer   [dig.cpp:291]
//       is_aquifer    := designation.water_table && rough WALL tiletype       [dig.cpp:262]
//       is_damp(pos)  := is_wet over the 8 HORIZONTAL neighbours at z, PLUS the tile at z+1  [dig.cpp:302]
//       is_warm(pos)  := block->temperature_1[x&15][y&15] >= 10075  (SELF check, not neighbours) [dig.cpp:235]
//     Our client cannot evaluate that: it never receives z+1 (see-down only descends) and the
//     aquifer/temperature bits were not on the wire. So the server evaluates it and ships two
//     additive flags2 bits (kFlag2Damp 0x0800 / kFlag2Warm 0x1000, src/wire_v1.h).
//
// WHAT THIS TEST PINS: both renderers, in MINE MODE, draw the mining indicator over a revealed
// diggable WALL that the server flagged damp (or warm). Gated: no mine mode -> nothing; hidden
// tile -> nothing; non-wall -> nothing (a floor cannot be mined, so DF never warns about it).
//
// Run: node tools/harness/b269_mining_indicators_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------------------------
// 0. The sprite is REAL and is already in our own map (the standing rule: the art is always
//    already there). Assert against web/interface_map.json + DF's raws, so a future map rebuild
//    that drops the tokens fails loudly instead of silently blanking the overlay.
// ---------------------------------------------------------------------------------------------
const IFACE = JSON.parse(fs.readFileSync(path.join(ROOT, "web/interface_map.json"), "utf8"));
let failures = 0;
function section(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + ((err && err.stack) || err)); }
}

section("SPRITE: DAMP_STONE_WARNING / WARM_STONE_WARNING are in interface_map.json", () => {
  assert.deepEqual(IFACE.DAMP_STONE_WARNING, { cx: 0, cy: 0, h: 32, img: "mining_indicators.png", w: 32 },
    "DAMP_STONE_WARNING must resolve to mining_indicators.png cell (0,0)");
  assert.deepEqual(IFACE.WARM_STONE_WARNING, { cx: 32, cy: 0, h: 32, img: "mining_indicators.png", w: 32 },
    "WARM_STONE_WARNING must resolve to mining_indicators.png cell (1,0)");
});

// ---------------------------------------------------------------------------------------------
// 1. GL renderer: the scene builder emits the indicator instance.
// ---------------------------------------------------------------------------------------------
const sandbox = {};
sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8"), sandbox,
  { filename: "web/js/dwf-gl.js" });
const GL = sandbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");

const MINING_SHEET = "mining_indicators.png";
const DAMP_CELL = [0, 0];
const WARM_CELL = [1, 0];

function makeMockAtlas() {
  const ids = new Map();
  let next = 1;
  return {
    resolve(sheet, col, row) {
      const k = sheet + "|" + col + "|" + row;
      if (!ids.has(k)) ids.set(k, next++);
      return ids.get(k);
    },
  };
}
function decode(builder) {
  const buf = builder.buffer, n = builder.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4], attr: u16[k * 8 + 5],
      r: u8[k * 16 + 12], g: u8[k * 16 + 13], b: u8[k * 16 + 14], a: u8[k * 16 + 15],
    });
  }
  return out;
}
function tile(o) {
  return Object.assign(
    { tt: 1, ttname: "", shape: "WALL", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 0 }, o);
}
function buildOne(t, mineMode) {
  const atlas = makeMockAtlas();
  GL.setMineMode(!!mineMode);
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  GL.setMineMode(false);
  return { inst: decode(b), atlas };
}
function indicatorAt(inst, atlas, cell, gx, gy) {
  const c = atlas.resolve(MINING_SHEET, cell[0], cell[1]);
  return inst.find((i) => i.cell === c && i.x === gx && i.y === gy);
}

// THE BUG: a revealed diggable wall the server flagged damp shows NOTHING today.
section("GL/B269: mine mode + revealed damp WALL -> DAMP_STONE_WARNING drop is emitted", () => {
  const { inst, atlas } = buildOne(tile({ damp: true }), true);
  assert.ok(indicatorAt(inst, atlas, DAMP_CELL, 0, 0),
    "a damp diggable wall must emit mining_indicators.png (0,0) -- the blue drop from the native oracle");
});

section("GL/B269: mine mode + revealed warm WALL -> WARM_STONE_WARNING is emitted (same class)", () => {
  const { inst, atlas } = buildOne(tile({ warm: true }), true);
  assert.ok(indicatorAt(inst, atlas, WARM_CELL, 0, 0),
    "a warm (magma-heated) diggable wall must emit mining_indicators.png (1,0)");
});

section("GL/B269: a designated damp wall keeps its pick AND gains the drop", () => {
  // We do NOT suppress the designation: DF clears the dig designation itself on a damp cancel,
  // so in practice a designated tile only ever carries the drop as a PRE-warning (before a miner
  // has reached it). Showing both is strictly more information than DF-clears-it leaves us with.
  const { inst, atlas } = buildOne(tile({ damp: true, desig: { dig: "Default" } }), true);
  const pick = atlas.resolve("designations.png", 0, 1);
  assert.ok(inst.find((i) => i.cell === pick && i.x === 0 && i.y === 0), "pick glyph still emitted");
  assert.ok(indicatorAt(inst, atlas, DAMP_CELL, 0, 0), "drop emitted over the designated damp wall");
});

// ---- gates (each of these is a way the fix could go wrong and spam the map) -------------------
section("GL/B269 GATE: no mine mode -> no indicator (DF only shows these in mining designation mode)", () => {
  const { inst, atlas } = buildOne(tile({ damp: true }), false);
  assert.ok(!indicatorAt(inst, atlas, DAMP_CELL, 0, 0), "damp wall outside mine mode must stay clean");
});
section("GL/B269 GATE: a HIDDEN damp wall shows nothing (no fog-of-war leak)", () => {
  const { inst, atlas } = buildOne(tile({ damp: true, hidden: true }), true);
  assert.ok(!indicatorAt(inst, atlas, DAMP_CELL, 0, 0), "undiscovered rock must not advertise water behind it");
});
section("GL/B269 GATE: a damp FLOOR shows nothing (a floor is not mineable, so DF never warns)", () => {
  const { inst, atlas } = buildOne(tile({ damp: true, shape: "FLOOR" }), true);
  assert.ok(!indicatorAt(inst, atlas, DAMP_CELL, 0, 0), "non-wall terrain must not carry a mining indicator");
});
section("GL/B269 GATE: an undamp, unwarm wall shows nothing (isolation)", () => {
  const { inst, atlas } = buildOne(tile({}), true);
  assert.ok(!indicatorAt(inst, atlas, DAMP_CELL, 0, 0), "dry wall: no drop");
  assert.ok(!indicatorAt(inst, atlas, WARM_CELL, 0, 0), "cool wall: no heat waves");
});
section("GL/B269: damp WINS over warm when a tile is somehow both (one icon per tile)", () => {
  const { inst, atlas } = buildOne(tile({ damp: true, warm: true }), true);
  assert.ok(indicatorAt(inst, atlas, DAMP_CELL, 0, 0), "damp icon shown");
  assert.ok(!indicatorAt(inst, atlas, WARM_CELL, 0, 0), "warm icon suppressed -- native draws one 32x32 cell");
});

// ---------------------------------------------------------------------------------------------
// 2. canvas2d renderer: the same decision, byte-parity with GL (the two renderers must never
//    disagree about what the player sees -- the whole point of the mirrored tables in gl.js).
// ---------------------------------------------------------------------------------------------
const t2 = {};
t2.self = t2;
t2.window = t2;
t2.document = { createElement: () => ({ getContext: () => null, style: {} }),
                querySelector: () => null, addEventListener: () => {} };
t2.performance = { now: () => 0 };
t2.location = { search: "", href: "http://x/" };
t2.navigator = { userAgent: "node" };
t2.fetch = () => Promise.reject(new Error("no fetch in harness"));
t2.URLSearchParams = URLSearchParams;
t2.localStorage = { getItem: () => null, setItem: () => {} };
t2.requestAnimationFrame = () => 0;
vm.createContext(t2);
let TILES = null;
try {
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), t2,
    { filename: "web/js/dwf-tiles.js" });
  TILES = t2.DwfTiles;
} catch (_e) { /* tiles.js needs a DOM it may not get here; the predicate check below reports it */ }

// The two renderers live in separate vm realms, so their Array prototypes differ and
// deepStrictEqual would reject an identical [col,row] on prototype identity alone. Compare cells
// by VALUE -- the thing that actually has to match is which sheet cell the player sees.
const cellEq = (a, b) => Array.isArray(a) && a.length === 2 && a[0] === b[0] && a[1] === b[1];

section("2D/B269: the mining-indicator decision function exists and mirrors GL exactly", () => {
  assert.ok(TILES, "dwf-tiles.js must load headless (it exports DwfTiles)");
  const f = TILES._miningIndicatorCellForTest;
  assert.equal(typeof f, "function",
    "dwf-tiles.js must export _miningIndicatorCellForTest(t, mineMode) -> [col,row]|null");
  assert.ok(cellEq(f({ shape: "WALL", hidden: false, damp: true }, true), DAMP_CELL), "damp wall -> drop");
  assert.ok(cellEq(f({ shape: "WALL", hidden: false, warm: true }, true), WARM_CELL), "warm wall -> heat waves");
  assert.equal(f({ shape: "WALL", hidden: false, damp: true }, false), null, "no mine mode -> null");
  assert.equal(f({ shape: "WALL", hidden: true, damp: true }, true), null, "hidden -> null");
  assert.equal(f({ shape: "FLOOR", hidden: false, damp: true }, true), null, "floor -> null");
  assert.equal(f({ shape: "WALL", hidden: false }, true), null, "dry cool wall -> null");
  assert.ok(cellEq(f({ shape: "WALL", hidden: false, damp: true, warm: true }, true), DAMP_CELL), "damp wins");
});

section("2D/B269 PARITY: the 2D and GL decision functions agree on every case (no renderer drift)", () => {
  const g = GL._miningIndicatorCellForTest, f = TILES._miningIndicatorCellForTest;
  const cases = [
    [{ shape: "WALL", hidden: false, damp: true }, true],
    [{ shape: "WALL", hidden: false, warm: true }, true],
    [{ shape: "WALL", hidden: false, damp: true, warm: true }, true],
    [{ shape: "WALL", hidden: false, damp: true }, false],
    [{ shape: "WALL", hidden: true, damp: true }, true],
    [{ shape: "FLOOR", hidden: false, damp: true }, true],
    [{ shape: "WALL", hidden: false }, true],
    [null, true],
  ];
  for (const [t, m] of cases) {
    const a = g(t, m), b = f(t, m);
    const same = (a === null && b === null) || (a && b && cellEq(a, b));
    assert.ok(same, `renderers disagree for ${JSON.stringify(t)} mineMode=${m}: GL=${JSON.stringify(a)} 2D=${JSON.stringify(b)}`);
  }
});

// ---------------------------------------------------------------------------------------------
// 3. The wire bits reach the tile object the renderers actually see.
// ---------------------------------------------------------------------------------------------
section("WIRE/B269: wire_v1.h defines the two additive flags2 bits", () => {
  const h = fs.readFileSync(path.join(ROOT, "src/wire_v1.h"), "utf8");
  assert.match(h, /kFlag2Damp\s*=\s*0x0800/, "kFlag2Damp = 0x0800 (additive: first free flags2 bit)");
  assert.match(h, /kFlag2Warm\s*=\s*0x1000/, "kFlag2Warm = 0x1000");
});
section("WIRE/B269: the server computes damp with DFHack's is_damp neighbourhood (8 horiz + z+1)", () => {
  const c = fs.readFileSync(path.join(ROOT, "src/wire_v1.cpp"), "utf8");
  assert.match(c, /kFlag2Damp/, "wire_v1.cpp must set kFlag2Damp");
  assert.match(c, /kFlag2Warm/, "wire_v1.cpp must set kFlag2Warm");
  assert.match(c, /water_table/, "damp must include the aquifer (water_table) case -- dig.cpp is_aquifer");
  assert.match(c, /temperature_1/, "warm must be the tile's own temperature -- dig.cpp is_warm");
});
section("CACHE/B269: decodeTile surfaces flags2 damp/warm onto the tile the renderers read", () => {
  const src = fs.readFileSync(path.join(ROOT, "web/js/dwf-cache.js"), "utf8");
  assert.match(src, /FLAG2_DAMP\s*=\s*0x0800/, "cache must name the damp bit");
  assert.match(src, /FLAG2_WARM\s*=\s*0x1000/, "cache must name the warm bit");
  assert.match(src, /out\.damp\s*=/, "decodeTile must set out.damp");
  assert.match(src, /out\.warm\s*=/, "decodeTile must set out.warm");
});

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nb269_mining_indicators_test: all sections pass");
