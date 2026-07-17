// dwf -- multiplayer Dwarf Fortress in the browser
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// B71-r3 SCENE-WIDE GRASS-TINT GATE (07-14 escalation: "everything is tinted green, the
// boulders even are transparent and green looking").
//
// MEASURED ROOT CAUSE (paired oracle, tools/orchestrator/attachments/B71-oracle-native.png vs
// B71-broken-ours.png): the GL renderer's WB-11 #5 "floor-edge (grass-creep) decal" painted a
// grass.png cell OVER the finished terrain sprite of EVERY non-grass tile bordering grass, at
// alpha min(140, 40 + 18*grassNeighbors)/255 -- 55% for a tile embedded in a lawn. Solving
// ours = beta*grass + (1-beta)*sprite on the boulder's white highlight gave beta = 0.69/0.73/0.72
// per channel (R/G/B) -- a plain untinted grass-cell composite ON TOP of the sprite; the pebble
// clusters' flat (89,104,78) squares reproduce as dense-pebble-cell + 0.549 grass overlay. The
// native oracle shows boulders/pebbles/dirt beside grass FULLY OPAQUE. canvas2d never drew this
// decal. Fix: the decal is DELETED from dwf-gl.js (same "measured false content -> delete"
// class as the see-above canopy and indoor-wash deletions).
//
// Previous two B71 waves fixed grassBackingCell (tree-trunk backing reach/sources) -- a REAL but
// DIFFERENT mechanism that only touches TREE/MUSHROOM tiles. This gate pins the sprite-level
// invariants the escalation is actually about, in both renderers:
//   (1) a BOULDER tile's sprite is emitted opaque and untinted even when surrounded by grass,
//       and NO grass art rides anywhere in its instance stack;
//   (2) the grass-under composite (B37/B92 pebbles-over-grass) keeps grass BENEATH the sprite
//       art, never over it;
//   (3) a non-grass floor bordering grass gains no grass instance at all (decal absence).
//
// Run: node tools/harness/b71_grasstint_test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadTiles, loadGL, makeAtlas } from "./groundart_fixture_support.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const realTokenMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/tiletype_token_map.json"), "utf8"));

// fixture-assumption guards: the committed token map must still route these ttnames this way,
// or the fixtures below stop testing what they claim to test.
assert.equal(realTokenMap.StoneBoulder && realTokenMap.StoneBoulder.token, "BOULDER",
  "fixture assumption broken: StoneBoulder no longer maps to BOULDER");
assert.equal(realTokenMap.StoneBoulder.tint, null,
  "fixture assumption broken: StoneBoulder now carries a tint (boulders must be untinted)");
assert.equal(realTokenMap.GrassLightFloor1 && realTokenMap.GrassLightFloor1.token, "GRASS_1",
  "fixture assumption broken: GrassLightFloor1 no longer maps to GRASS_1");

const T = loadTiles();
const G = loadGL();

let failed = 0;
function check(name, cond) {
  if (cond) { console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

// ---- GL: real dwf-gl.js scene build, instance-stream assertions ----------------------
const spriteMap = {
  BOULDER: { sheet: "boulders.png", col: 0, row: 0 },
  PEBBLES_FLOOR_5: { sheet: "floors.png", col: 5, row: 2 },
  PEBBLES_FLOOR_2: { sheet: "floors.png", col: 2, row: 2 },
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
function buildScene3x3(centerTile) {
  const atlas = makeAtlas();
  const b = G.createSceneBuilder({ atlas, spriteMap, tokenMap: realTokenMap, shadowCellMap: { wallShadow: {}, visionShadow: {}, rampShadowOnRamp: {} } });
  const tiles = [];
  for (let i = 0; i < 9; i++) tiles.push(grassTile());
  tiles[4] = centerTile; // center of the 3x3 lawn
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 3, height: 3, tiles });
  return { atlas, inst: decode(b), center: decode(b).filter((i) => i.x === 1 && i.y === 1) };
}
const grassCells = (atlas) => new Set([0, 1, 2, 3].map((c) => atlas.resolve("grass.png", c, 0)));

console.log("B71-r3 GL: boulder in a lawn stays opaque, untinted, grass-free");
{
  const boulder = { tt: 1, ttname: "StoneBoulder", shape: "BOULDER", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 };
  const { atlas, center } = buildScene3x3(boulder);
  const boulderCell = atlas.resolve("boulders.png", 0, 0);
  const gset = grassCells(atlas);
  const idxBoulder = center.findIndex((i) => i.cell === boulderCell);
  check("boulder sprite instance present (fixture is live, not vacuous)", idxBoulder >= 0);
  const bi = center[idxBoulder] || {};
  check("boulder sprite emitted OPAQUE (a=255)", bi.a === 255);
  check("boulder sprite emitted UNTINTED (rgb=255,255,255 -- shader multiply is identity)",
    bi.r === 255 && bi.g === 255 && bi.b === 255);
  // B241 amendment: the native oracle (B241-oracle-native.png) shows the tile's REAL ground
  // composited BENEATH the boulder -- grass backing BEFORE the boulder sprite is required,
  // not forbidden. The B71 invariant this gate exists for is narrower and still absolute:
  // no grass (or anything translucent) rides AT or AFTER the boulder sprite.
  check("grass ground-backing present BENEATH the boulder (B241: rock sits on its real floor)",
    center.slice(0, idxBoulder).some((i) => gset.has(i.cell)));
  check("NO grass.png instance at/after the boulder sprite (B71: nothing creeps over the rock)",
    !center.slice(idxBoulder).some((i) => gset.has(i.cell)));
  check("nothing translucent is drawn OVER the boulder sprite",
    !center.slice(idxBoulder + 1).some((i) => i.a > 0 && i.a < 255));
}

console.log("B71-r3 GL: grass-under composite keeps grass BENEATH the sprite art");
{
  const pebbles = { tt: 1, ttname: "StonePebbles2", shape: "PEBBLES", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1, grass: { amount: 120 } };
  const { atlas, center } = buildScene3x3(pebbles);
  const gset = grassCells(atlas);
  const pebbleCell = atlas.resolve("floors.png", 2, 2); // PEBBLES_FLOOR_2 sparse variant
  const idxGrass = center.findIndex((i) => gset.has(i.cell));
  const idxPebble = center.findIndex((i) => i.cell === pebbleCell);
  check("grass-under base present (B37/B92 composite still works)", idxGrass >= 0);
  check("sparse pebble overlay present", idxPebble >= 0);
  check("grass draws BENEATH the pebble art (base first, sprite on top -- never over)",
    idxGrass >= 0 && idxPebble >= 0 && idxGrass < idxPebble);
  check("pebble art itself is opaque and untinted",
    idxPebble >= 0 && center[idxPebble].a === 255 && center[idxPebble].r === 255);
  check("no grass instance AFTER the pebble art (the deleted decal used to add one)",
    !center.slice(idxPebble + 1).some((i) => gset.has(i.cell)));
}

console.log("B71-r3 GL: non-grass floor bordering grass gains NO grass instance (decal deleted)");
{
  const stone = { tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 };
  // synthetic tokenMap arm: real map has no StoneFloor5, add it so the floor draws real art
  const tm = Object.assign({}, realTokenMap, { StoneFloor5: { token: "STONE_FLOOR_5", tint: null } });
  const atlas = makeAtlas();
  const b = G.createSceneBuilder({ atlas, spriteMap, tokenMap: tm, shadowCellMap: { wallShadow: {}, visionShadow: {}, rampShadowOnRamp: {} } });
  const tiles = []; for (let i = 0; i < 9; i++) tiles.push(grassTile());
  tiles[4] = stone;
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 3, height: 3, tiles });
  const center = decode(b).filter((i) => i.x === 1 && i.y === 1);
  const gset = grassCells(atlas);
  const floorCell = atlas.resolve("floors.png", 1, 4);
  check("stone floor sprite present", center.some((i) => i.cell === floorCell));
  check("NO grass.png instance on a stone floor with 8 grass neighbors", !center.some((i) => gset.has(i.cell)));
  check("nothing translucent on the stone floor's stack at all",
    !center.some((i) => i.a > 0 && i.a < 255 && i.cell !== G.SOLID_CELL));
}

// ---- canvas2d: resolveSprite-level parity pins ----------------------------------------------
// canvas2d never had the floor-edge decal; these pins make sure the boulder/pebble routing that
// GUARANTEES the invariant there (boulder -> untinted BOULDER art; pebbles-with-grass -> grass
// as the BASE cell with the pebble art as the OVERLAY drawn on top of it) can't silently change.
console.log("B71-r3 canvas2d: boulder routes to untinted BOULDER art; grass-under stays base-then-overlay");
{
  T._setSpriteMapForTest(spriteMap);
  T._setTiletypeTokenMapForTest(realTokenMap);
  const loaded = (name) => T._setSheetForTest(name, { img: { width: 512, height: 512 }, loaded: true, failed: false });
  loaded("boulders.png"); loaded("floors.png"); loaded("grass.png");
  const rs = T._resolveSpriteForTest;
  const boulderSprite = rs({ tt: 1, ttname: "StoneBoulder", shape: "BOULDER", mat: "STONE", outside: 1 }, 1, 1);
  check("StoneBoulder resolves to the BOULDER cell (boulders.png), not grass",
    !!boulderSprite && boulderSprite.col === 0 && boulderSprite.row === 0);
  check("StoneBoulder carries NO tint (never routes through the grass tint path)",
    !!boulderSprite && !boulderSprite.tint);
  check("StoneBoulder carries NO overlay (nothing rides on top of the boulder art)",
    !!boulderSprite && !boulderSprite.overlay);
  const pebbleSprite = rs({ tt: 1, ttname: "StonePebbles2", shape: "PEBBLES", mat: "STONE", outside: 1, grass: { amount: 120 } }, 1, 1);
  check("StonePebbles2+grass resolves grass as the BASE cell (grass beneath, B37/B92)",
    !!pebbleSprite && pebbleSprite.tint === "grassSummer");
  check("...with the sparse pebble art as the OVERLAY drawn on top",
    !!pebbleSprite && !!pebbleSprite.overlay && pebbleSprite.overlay.col === 2 && pebbleSprite.overlay.row === 2);
}

console.log(failed === 0 ? "\nB71-r3 PASS" : `\nB71-r3 FAIL (${failed} assertion(s))`);
process.exit(failed === 0 ? 0 : 1);
