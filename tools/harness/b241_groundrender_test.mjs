// dwf -- multiplayer Dwarf Fortress in the browser
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// B241 GROUND-RENDER GATE (07-14, paired oracle tools/orchestrator/attachments/
// B241-broken-ours.png vs B241-oracle-native.png). Three defects, pinned in BOTH renderers:
//
//  (1) PEBBLES: a *Pebbles tile with no positive grass tail renders its OWN dense
//      pebble-floor art -- one of the FOUR authored variants (FLOOR_PEBBLES cols 0-3 =
//      PEBBLES_FLOOR_5/5B/5C/5D, graphics_tiles.txt L118-121; all fully opaque, measured
//      1024/1024) keyed off the tiletype's VAR_1..4 digit via the regenerated token map.
//      The old B37 arm painted borrowed grass + 6-140px speckles instead: invisible.
//  (2) BOULDER GROUND BACKING: the boulder sprite is 50-65% opaque (terrain_boulders.png,
//      measured 502-670/1024 opaque px/cell); native composites the tile's REAL ground
//      beneath it (oracle: rock directly on grass; ours drew a flat MAT_COLOR square).
//      Backing priority: own grass tail (true floor, DLL-gated) > ring-1 borrowed live
//      grass (the accepted B62-r2 trunk rule) > rough stone floor (STONE_FLOOR_5).
//  (3) BOULDER VARIANTS: the raws bind EIGHT cells to the one BOULDER token (4x2 grid);
//      the pick is a stable hash of the tile's WORLD coords -- it must never change when
//      the viewport pans, and both renderers must agree.
//
// Run: node tools/harness/b241_groundrender_test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadTiles, loadGL, makeAtlas } from "./groundart_fixture_support.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const realTokenMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/tiletype_token_map.json"), "utf8"));

// fixture-assumption guards: the committed token map must still route these ttnames this way.
assert.equal(realTokenMap.StoneBoulder && realTokenMap.StoneBoulder.token, "BOULDER",
  "fixture assumption broken: StoneBoulder no longer maps to BOULDER");
for (const [tt, tok] of [["StonePebbles1", "PEBBLES_FLOOR_5"], ["StonePebbles2", "PEBBLES_FLOOR_5B"],
                         ["StonePebbles3", "PEBBLES_FLOOR_5C"], ["StonePebbles4", "PEBBLES_FLOOR_5D"]]) {
  assert.equal(realTokenMap[tt] && realTokenMap[tt].token, tok,
    "fixture assumption broken: " + tt + " must map to " + tok);
}

const T = loadTiles();
const G = loadGL();
function hashXY(x, y) { return ((x * 374761393 + y * 668265263) ^ (x >> 3)) >>> 0; }

let failed = 0;
function check(name, cond) {
  if (cond) { console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

// The vanilla-shaped sprite map: BOULDER bound at terrain_boulders.png (0,0) exactly as
// sprite_map.cpp publishes it (first raw binding), pebble cells as the raws lay them out.
const spriteMap = {
  BOULDER: { sheet: "terrain_boulders.png", col: 0, row: 0 },
  PEBBLES_FLOOR_5: { sheet: "floor_pebbles.png", col: 0, row: 0 },
  PEBBLES_FLOOR_5B: { sheet: "floor_pebbles.png", col: 1, row: 0 },
  PEBBLES_FLOOR_5C: { sheet: "floor_pebbles.png", col: 2, row: 0 },
  PEBBLES_FLOOR_5D: { sheet: "floor_pebbles.png", col: 3, row: 0 },
  PEBBLES_FLOOR_2: { sheet: "floor_pebbles.png", col: 6, row: 0 },
  STONE_FLOOR_5: { sheet: "floors.png", col: 1, row: 4 },
};

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
function grassTile() {
  return { tt: 1, ttname: "GrassLightFloor1", shape: "FLOOR", mat: "GRASS_LIGHT", hidden: false, flow: 0, liquid: "none", outside: 1 };
}
function stoneFloorTile() {
  return { tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 };
}
function boulderTile(o = {}) {
  return Object.assign({ tt: 1, ttname: "StoneBoulder", shape: "BOULDER", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
}
function scene3x3(centerTile, neighborFactory) {
  const atlas = makeAtlas();
  const b = G.createSceneBuilder({ atlas, spriteMap, tokenMap: realTokenMap, shadowCellMap: { wallShadow: {}, visionShadow: {}, rampShadowOnRamp: {} } });
  const tiles = [];
  for (let i = 0; i < 9; i++) tiles.push(neighborFactory());
  tiles[4] = centerTile;
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 3, height: 3, tiles });
  return { atlas, center: decode(b).filter((i) => i.x === 1 && i.y === 1) };
}
const grassCells = (atlas) => new Set([0, 1, 2, 3].map((c) => atlas.resolve("grass.png", c, 0)));
const expectedBoulderCell = (atlas, wx, wy) => {
  const h = hashXY(wx, wy);
  return atlas.resolve("terrain_boulders.png", h & 3, (h >> 2) & 1);
};

// =============================================================================================
console.log("B241 (1) GL: bare pebbles render their own DENSE variant art, no grass");
{
  for (let v = 1; v <= 4; v++) {
    const peb = { tt: 1, ttname: "StonePebbles" + v, shape: "PEBBLES", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 };
    const { atlas, center } = scene3x3(peb, grassTile);
    const dense = atlas.resolve("floor_pebbles.png", v - 1, 0);
    const gset = grassCells(atlas);
    check("StonePebbles" + v + " (no tail, 8 grass neighbors) emits dense cell col " + (v - 1),
      center.some((i) => i.cell === dense));
    check("StonePebbles" + v + " emits NO grass art in its stack",
      !center.some((i) => gset.has(i.cell)));
  }
}

console.log("B241 (1) GL: pebbles WITH a real grass tail keep the B92 grass+sparse composite");
{
  const peb = { tt: 1, ttname: "StonePebbles2", shape: "PEBBLES", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1, grass: { amount: 150 } };
  const { atlas, center } = scene3x3(peb, grassTile);
  const gset = grassCells(atlas);
  const sparse = atlas.resolve("floor_pebbles.png", 6, 0); // PEBBLES_FLOOR_2
  const iG = center.findIndex((i) => gset.has(i.cell));
  const iS = center.findIndex((i) => i.cell === sparse);
  check("grass base present", iG >= 0);
  check("sparse overlay present, drawn after the grass", iS > iG);
  check("dense cell NOT emitted on a grass-covered pebble tile",
    !center.some((i) => i.cell === atlas.resolve("floor_pebbles.png", 1, 0)));
}

console.log("B241 (2) GL: boulder backing = the tile's true floor");
{
  // (a) own grass tail (the DLL-gated wire arm) -> grass backing even with NO grass neighbors
  const withTail = boulderTile({ x: 7, y: 9, grass: { amount: 90 } });
  let { atlas, center } = scene3x3(withTail, stoneFloorTile);
  let gset = grassCells(atlas);
  let iB = center.findIndex((i) => i.cell === expectedBoulderCell(atlas, 7, 9));
  let iG = center.findIndex((i) => gset.has(i.cell));
  check("(a) boulder sprite present (variant cell for world 7,9)", iB >= 0);
  check("(a) own-grass-tail backing rides BENEATH the boulder", iG >= 0 && iG < iB);
  check("(a) grassSummer wash between backing and boulder (a<255)",
    center.slice(iG + 1, iB).some((i) => i.a > 0 && i.a < 255));

  // (b) no tail, lawn neighbors -> ring-1 borrowed grass backing
  ({ atlas, center } = scene3x3(boulderTile({ x: 7, y: 9 }), grassTile));
  gset = grassCells(atlas);
  iB = center.findIndex((i) => i.cell === expectedBoulderCell(atlas, 7, 9));
  iG = center.findIndex((i) => gset.has(i.cell));
  check("(b) ring-1 borrowed grass backing beneath the boulder", iG >= 0 && iB > iG);
  check("(b) no grass at/after the boulder sprite", !center.slice(iB).some((i) => gset.has(i.cell)));

  // (c) no tail, no grass anywhere -> rough stone floor backing, unwashed
  ({ atlas, center } = scene3x3(boulderTile({ x: 7, y: 9 }), stoneFloorTile));
  gset = grassCells(atlas);
  iB = center.findIndex((i) => i.cell === expectedBoulderCell(atlas, 7, 9));
  const iF = center.findIndex((i) => i.cell === atlas.resolve("floors.png", 1, 4));
  check("(c) STONE_FLOOR_5 backing beneath the boulder", iF >= 0 && iB > iF);
  check("(c) stone backing carries NO grass wash (nothing translucent before the boulder)",
    !center.slice(iF + 1, iB).some((i) => i.a > 0 && i.a < 255));
  check("(c) no grass invented on a grassless plateau", !center.some((i) => gset.has(i.cell)));
  check("(c) no flat MAT_COLOR solid under the boulder (backing replaced the box)",
    !center.some((i) => i.cell === G.SOLID_CELL && i.a === 255 && i.r === 128 && i.g === 128 && i.b === 128));
}

console.log("B241 (3) GL: boulder variant pick is world-stable and 8-way");
{
  // pan-stability: SAME world coords, different position in the viewport -> same cell
  const atlas = makeAtlas();
  const b = G.createSceneBuilder({ atlas, spriteMap, tokenMap: realTokenMap, shadowCellMap: { wallShadow: {}, visionShadow: {}, rampShadowOnRamp: {} } });
  const c1 = b._boulderVariantForTest(boulderTile({ x: 31, y: 17 }), 0, 0);
  const c2 = b._boulderVariantForTest(boulderTile({ x: 31, y: 17 }), 5, 8); // "panned": other gx/gy
  check("same world coords -> same variant cell regardless of viewport position", c1 > 0 && c1 === c2);
  // 8-way fan-out: a sweep of world coords reaches >= 4 distinct cells (8 exist)
  const seen = new Set();
  for (let x = 0; x < 20; x++) for (let y = 0; y < 20; y++) seen.add(b._boulderVariantForTest(boulderTile({ x, y }), 0, 0));
  check("world-coord sweep reaches multiple variant cells (got " + seen.size + " of 8)", seen.size >= 4 && seen.size <= 8);
  // modded-raws guard: BOULDER bound elsewhere -> no fan-out (keeps its single authored cell)
  const b2 = G.createSceneBuilder({ atlas: makeAtlas(), spriteMap: { BOULDER: { sheet: "custom.png", col: 5, row: 3 } }, tokenMap: realTokenMap });
  check("non-vanilla BOULDER binding gets NO variant fan-out (guard)",
    b2._boulderVariantForTest(boulderTile({ x: 3, y: 3 }), 0, 0) === 0);
}

// =============================================================================================
console.log("B241 canvas2d: routing parity");
{
  T._setSpriteMapForTest(spriteMap);
  T._setTiletypeTokenMapForTest(realTokenMap);
  const load = (n) => T._setSheetForTest(n, { img: { width: 512, height: 512 }, loaded: true, failed: false });
  load("terrain_boulders.png"); load("floor_pebbles.png"); load("floors.png"); load("grass.png");
  const rs = T._resolveSpriteForTest;

  // (1) bare pebbles -> dense variant cells, no tint/overlay
  for (let v = 1; v <= 4; v++) {
    const s = rs({ tt: 1, ttname: "StonePebbles" + v, shape: "PEBBLES", mat: "STONE", outside: 1 }, 2, 3);
    check("StonePebbles" + v + " -> dense floor_pebbles col " + (v - 1),
      !!s && s.col === v - 1 && s.row === 0 && !s.tint && !s.overlay);
  }
  // worn-bare tail on a pebble tile keeps the dense art (null is grass-mat-only)
  const worn = rs({ tt: 1, ttname: "StonePebbles3", shape: "PEBBLES", mat: "STONE", outside: 1, grass: { amount: 0 } }, 2, 3);
  check("worn-bare (amount=0) pebble keeps its dense art", !!worn && worn.col === 2);
  // worn-bare on a GRASS tile still nulls to the flat-color path (unchanged WC-17 gate)
  check("worn-bare grass-mat tile still falls to flat color (WC-17 gate intact)",
    rs({ tt: 1, ttname: "GrassLightFloor1", shape: "FLOOR", mat: "GRASS_LIGHT", outside: 1, grass: { amount: 0 } }, 2, 3) === null);

  // (3) boulder variant: world-coord pick, parity with GL's (h&3, h>>2&1)
  const bt = { tt: 1, ttname: "StoneBoulder", shape: "BOULDER", mat: "STONE", outside: 1, x: 31, y: 17 };
  const h = hashXY(31, 17);
  const s1 = rs(bt, 0, 0), s2 = rs(bt, 5, 8);
  check("StoneBoulder resolves to variant (col,row)=(" + (h & 3) + "," + ((h >> 2) & 1) + ") from WORLD coords",
    !!s1 && s1.col === (h & 3) && s1.row === ((h >> 2) & 1));
  check("variant is pan-stable (same world coords, different gx/gy)",
    !!s2 && s2.col === s1.col && s2.row === s1.row);
  const bv = T._boulderVariantForTest(bt, 0, 0);
  check("canvas2d/GL parity: _boulderVariantForTest agrees with the GL formula",
    !!bv && bv.col === (h & 3) && bv.row === ((h >> 2) & 1));

  // (2) ground backing arms via the exported hook
  const gbTail = T._groundBackingCellForTest({ shape: "BOULDER", mat: "STONE", grass: { amount: 90 } }, 2, 3, () => null);
  check("backing (a): own grass tail -> grass.png cell + wash",
    !!gbTail && gbTail.sheet === "grass.png" && gbTail.wash === true);
  const lawn = (x, y) => (x === 2 && y === 3) ? null : { mat: "GRASS_LIGHT" };
  const gbBorrow = T._groundBackingCellForTest({ shape: "BOULDER", mat: "STONE" }, 2, 3, lawn);
  check("backing (b): no tail + ring-1 live grass -> borrowed grass + wash",
    !!gbBorrow && gbBorrow.sheet === "grass.png" && gbBorrow.wash === true);
  const gbStone = T._groundBackingCellForTest({ shape: "BOULDER", mat: "STONE" }, 2, 3, () => ({ mat: "STONE" }));
  check("backing (c): grassless -> STONE_FLOOR_5, unwashed",
    !!gbStone && gbStone.sheet === "floors.png" && gbStone.col === 1 && gbStone.row === 4 && gbStone.wash === false);
  const gbWorn = T._groundBackingCellForTest({ shape: "BOULDER", mat: "STONE", grass: { amount: 0 } }, 2, 3, lawn);
  check("backing: a worn-bare tail is authoritative -- NO borrowing, stone floor backing",
    !!gbWorn && gbWorn.sheet === "floors.png" && gbWorn.wash === false);
  const gbFloor = T._groundBackingCellForTest({ shape: "FLOOR", mat: "STONE" }, 2, 3, lawn);
  check("backing: a plain FLOOR tile gets NO backing (B71: no grass creep onto floors)", gbFloor === null);
  const gbTree = T._groundBackingCellForTest({ shape: "WALL", mat: "TREE" }, 2, 3, lawn);
  check("backing: TREE trunk keeps its B62-r2 borrowed-grass rule through the same hook",
    !!gbTree && gbTree.sheet === "grass.png" && gbTree.wash === true);
}

console.log(failed === 0 ? "\nB241 PASS" : `\nB241 FAIL (${failed} assertion(s))`);
process.exit(failed === 0 ? 0 : 1);
