// dwf -- multiplayer Dwarf Fortress in the browser
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// B37 -> B241 REVERSAL (07-14 eyeball: "limestone pebbles are not rendering at all").
// The original B37 arm made every outside *Pebbles tile WITHOUT a grass tail composite
// borrowed grass + near-invisible sparse speckles. That was refuted by B241: the wire never
// ships grass tails for PEBBLES-shape tiles (src/wire_v1.cpp gates grass_under_floor on
// shape==FLOOR; StonePebbles* is shape PEBBLES per static.enums.inc), so the arm turned
// EVERY outside pebble floor into plain lawn. The B241 truth, pinned here in both renderers:
//   - no (positive) grass tail -> the tile's OWN dense pebble art via the token map;
//   - a real grass tail (amount>0) -> the B92-verified grass + sparse-overlay composite
//     (this fires for pebbles once the DLL-gated wire fix ships tails for PEBBLES shapes).
import assert from "node:assert/strict";
import { loadTiles, loadGL, makeAtlas } from "./groundart_fixture_support.mjs";
const map = { PEBBLES_FLOOR_3: { sheet: "floors.png", col: 3, row: 0 }, PEBBLES_FLOOR_5C: { sheet: "floor_pebbles.png", col: 2, row: 0 } };
const tokenMap = { StonePebbles3: { token: "PEBBLES_FLOOR_5C", tint: null } };
const bare = { tt: 1, ttname: "StonePebbles3", shape: "PEBBLES", mat: "STONE", outside: 1, hidden: false, flow: 0, liquid: "none" };
const grassed = Object.assign({}, bare, { grass: { id: "ZOYSIA", amount: 150 } });

const T = loadTiles(); T._setSpriteMapForTest(map); T._setTiletypeTokenMapForTest(tokenMap);
T._setSheetForTest && T._setSheetForTest("floor_pebbles.png", { img: { width: 384, height: 32 }, loaded: true, failed: false });
const c2dBare = T._resolveSpriteForTest(bare, 3, 5);
assert.ok(c2dBare && c2dBare.img, "canvas: bare exterior pebble resolves to real art");
assert.equal(c2dBare.col, 2, "canvas: bare pebble uses its DENSE variant cell (PEBBLES_FLOOR_5C), not grass");
assert.ok(!c2dBare.tint && !c2dBare.overlay, "canvas: dense pebble art is unwashed, no overlay");
const c2dGrassed = T._resolveSpriteForTest(grassed, 3, 5);
assert.ok(c2dGrassed && c2dGrassed.overlay && c2dGrassed.tint === "grassSummer",
  "canvas: pebble WITH a grass tail keeps the B92 grass+sparse composite (post-DLL path)");

const G = loadGL(), atlas = makeAtlas(), b = G.createSceneBuilder({ atlas, spriteMap: map, tokenMap });
const glBare = b._resolveSprite(bare, 3, 5);
assert.equal(glBare.cell, atlas.resolve("floor_pebbles.png", 2, 0), "GL: bare pebble uses its DENSE variant cell");
assert.notEqual(glBare.cell, atlas.resolve("grass.png", (((3 * 374761393 + 5 * 668265263) ^ (3 >> 3)) >>> 0) % 4, 0),
  "GL: no invented grass on a tile the wire reports no grass for");
const glGrassed = b._resolveSprite(grassed, 3, 5);
assert.equal(glGrassed.tintName, "grassSummer", "GL: grass-tailed pebble keeps the B92 composite");
assert.equal(glGrassed.overlay, atlas.resolve("floors.png", 3, 0), "GL: ...with its sparse PEBBLES_FLOOR_3 overlay");
console.log("PASS B241 pebble fixture (bare=dense own art, grass-tailed=B92 composite, both renderers)");
