// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// TX16: natural layer-stone wall faces must use the material's STATE_COLOR palette row.
// Siltstone is ECRU in DF's inorganic raws; the pre-fix natural-wall path returned no row and
// drew every rough/smoothed/worn/engraved face in the authored default grey palette.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGL, loadTiles } from "./groundart_fixture_support.mjs";

import { dfRootOrSkip } from "../lib/dfroot.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// W1: resolved, never hardcoded. No DF install -> this suite SKIPs (exit 0),
// because its ground truth IS the raws: without them there is nothing to check against.
const DF_ROOT_W1 = dfRootOrSkip("tx16_stone_wall_tint_test.mjs");
const DF_ROOT = path.join(DF_ROOT_W1, "data/vanilla");
const LAYER_RAW = path.join(DF_ROOT, "vanilla_materials/objects/inorganic_stone_layer.txt");
const GFX_RAW = path.join(DF_ROOT, "vanilla_environment/graphics/graphics_tiles.txt");
const materialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));
const layerText = fs.readFileSync(LAYER_RAW, "latin1");
const gfxText = fs.readFileSync(GFX_RAW, "latin1");

const layerHeaders = [...layerText.matchAll(/^\[INORGANIC:([^\]]+)\]/gm)];
assert.equal(layerHeaders.length, 25, "authoritative vanilla layer-stone matrix must contain 25 materials");
const layerColors = new Map(layerHeaders.map((m, i) => {
  const end = i + 1 < layerHeaders.length ? layerHeaders[i + 1].index : layerText.length;
  const block = layerText.slice(m.index, end);
  const c = /\[STATE_COLOR:ALL_SOLID:([^\]]+)\]/.exec(block);
  assert.ok(c, m[1] + " must declare STATE_COLOR:ALL_SOLID");
  return [m[1], c[1]];
}));
const byId = new Map(materialMap.inorganic.map((m, i) => [m.id, { ...m, index: i }]));

const T = loadTiles();
T._setMaterialMapForTest(materialMap);
const GL = loadGL();
const G = GL.createSceneBuilder({ materialMap });

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function wall(id, extra = {}) {
  const m = byId.get(id);
  assert.ok(m, "material_map must contain " + id);
  return { tt: 1, ttname: "StoneWall", shape: "WALL", mat: "STONE", base_mt: 0, base_mi: m.index, ...extra };
}

// Oracle guard: every wall-face art family covered by TX16 exists in DF's own graphics raw.
const pageCounts = {
  WALL_STONE: 40,
  WALL_WORN1_STONE: 40,
  WALL_WORN2_STONE: 40,
  WALL_WORN3_STONE: 40,
  WALL_STONE_SMOOTHED: 19,
  WALL_STONE_ENGRAVED: 19,
};
for (const [page, expected] of Object.entries(pageCounts)) {
  const count = [...gfxText.matchAll(new RegExp("\\[TILE_GRAPHICS:" + page + ":[^\\]]+\\]", "g"))].length;
  assert.equal(count, expected, page + " authoritative cell count");
}

// Full material matrix: all 25 layer stones resolve through their raw STATE_COLOR, in both renderers.
for (const [id, color] of layerColors) {
  const m = byId.get(id);
  assert.ok(m, "material_map missing layer stone " + id);
  const expectedRow = materialMap.palette.byname[color];
  assert.equal(m.row, expectedRow, id + " material_map row must match raw " + color);
  assert.equal(T._wallJoinPalRowForTest(wall(id)), expectedRow, id + " canvas wall row");
  assert.equal(G._wallJoinPalRowForTest(wall(id)), expectedRow, id + " GL wall row");
}

// Reported cell: SILTSTONE is raw ECRU (row 41), not the default grey wall palette.
const ecruRow = materialMap.palette.byname.ECRU;
const ecruRgb = materialMap.palette.rows[ecruRow][7];
assert.equal(layerColors.get("SILTSTONE"), "ECRU", "DF raw oracle: SILTSTONE is ECRU");
assert.equal(ecruRow, 41, "DF palette oracle: ECRU row");
assert.deepEqual(ecruRgb, [191, 178, 138], "shipped DF ECRU palette representative RGB");
assert.equal(T._wallJoinPalRowForTest(wall("SILTSTONE")), ecruRow, "siltstone canvas wall face uses ECRU");
assert.equal(G._wallJoinPalRowForTest(wall("SILTSTONE")), ecruRow, "siltstone GL wall face uses ECRU");
assert.notEqual(ecruRow, 0, "test-the-test: pre-fix/default palette must not satisfy siltstone");

// Palette remap has teeth: a representative default-palette wall pixel becomes ECRU in both paths.
const defaultRgb = materialMap.default_row[7];
for (const [name, remap] of [["canvas", T._paletteRemapForTest(ecruRow)], ["GL", G._paletteRemapForTest(ecruRow)]]) {
  const px = new Uint8ClampedArray([...defaultRgb, 255]);
  remap(px, 1, 1);
  assert.deepEqual(Array.from(px.slice(0, 3)), ecruRgb, name + " remaps default wall pixel to ECRU");
}

// Subvariant matrix: rough, smoothed, worn 1-3, and engraved wall faces retain the same row.
for (const ttname of ["StoneWall", "StoneWallSmoothLRUD", "StoneWallWorn1", "StoneWallWorn2", "StoneWallWorn3"]) {
  const t = wall("SILTSTONE", { ttname });
  assert.equal(T._wallJoinPalRowForTest(t), ecruRow, ttname + " canvas row");
  assert.equal(G._wallJoinPalRowForTest(t), ecruRow, ttname + " GL row");
}
const engraved2d = T._engravingWallPlanForTest(wall("SILTSTONE"), 0x0008);
const engravedGl = G._engravingWallPlanForTest(wall("SILTSTONE"), 0x0008);
assert.equal(engraved2d.token, "ENGRAVED_STONE_WALL_N");
assert.equal(engraved2d.palRow, ecruRow, "siltstone engraved canvas face uses ECRU");
assert.ok(same(engraved2d, engravedGl), "engraved siltstone plan is byte-identical across renderers");

// B281: the transparent center behind NATURAL wall art is the installed hidden-rock texture,
// never the face's material row. tileColor is only its dark fallback if that sheet is not ready;
// b273_material_tint_test.mjs performs the real-PNG face/backing pixel proof.
const darkBackingFallback = [6, 6, 8];
assert.ok(same(T._tileColorForTest(wall("SILTSTONE"), true), darkBackingFallback), "canvas siltstone dark backing fallback");
assert.ok(same(G._tileColor(wall("SILTSTONE"), true), darkBackingFallback), "GL siltstone dark backing fallback");
assert.match(T._wallBackingTokenForTest(wall("SILTSTONE"), 13, 17, 15), /^HIDDEN_ROCK_[1-5]$/,
  "canvas siltstone uses hidden-rock backing art");
assert.match(G._wallBackingTokenForTest(wall("SILTSTONE"), 13, 17, 15), /^HIDDEN_ROCK_[1-5]$/,
  "GL siltstone uses hidden-rock backing art");

// Regression guard: the already-correct constructed-marble wall keeps its existing material row.
const marble = byId.get("MARBLE");
const constructedMarble = { tt: 1, ttname: "ConstructedWall", shape: "WALL", mat: "CONSTRUCTION", base_mt: 0, base_mi: marble.index };
assert.equal(T._wallJoinPalRowForTest(constructedMarble), marble.row, "constructed marble canvas row unchanged");
assert.equal(G._wallJoinPalRowForTest(constructedMarble), marble.row, "constructed marble GL row unchanged");
assert.equal(T._wallBackingTokenForTest(constructedMarble, 13, 17), null,
  "constructed marble does not acquire natural hidden-rock backing");
assert.equal(G._wallBackingTokenForTest(constructedMarble, 13, 17), null,
  "constructed marble GL does not acquire natural hidden-rock backing");
const constructedFill = materialMap.palette.rows[marble.row][7].map((c) => Math.round(c * 0.45));
assert.ok(same(T._tileColorForTest(constructedMarble, true), constructedFill),
  "constructed marble canvas built-material fill unchanged");
assert.ok(same(G._tileColor(constructedMarble, true), constructedFill),
  "constructed marble GL built-material fill unchanged");

// B273 broadening: the same raw-derived mechanism now covers the other palette-authored natural
// wall classes. Use physically valid material pairs (soil raw for SOIL, ore raw for MINERAL).
for (const [id, mat] of [["CLAY", "SOIL"], ["HEMATITE", "MINERAL"]]) {
  const m = byId.get(id);
  const t = { ...wall("SILTSTONE"), mat, base_mi: m.index };
  assert.equal(T._wallJoinPalRowForTest(t), m.row, id + " " + mat + " canvas wall row");
  assert.equal(G._wallJoinPalRowForTest(t), m.row, id + " " + mat + " GL wall row");
}
assert.equal(T._wallJoinPalRowForTest({ ...wall("SILTSTONE"), mat: "TREE" }), null, "tree wall unchanged");
assert.equal(T._wallJoinPalRowForTest({ ...wall("SILTSTONE"), base_mi: 999999 }), null, "unknown material stays untinted");

console.log("PASS TX16/B273: 25 layer stones plus soil/mineral walls; siltstone ECRU rough/smooth/worn/engraved faces; constructed-marble regression");
