// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

// Renderer-wave acceptance: B54/B56/B57/B58/TX1/TX2/TX3.
// Run: node tools/harness/renderer_wave_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const buildingMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/building_map.json"), "utf8"));
const spatterMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/spatter_map.json"), "utf8"));
const itemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const interfaceMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/interface_map.json"), "utf8"));
const glSource = fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8");
const tilesSource = fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8");

const glbox = { self: null, performance: { now: () => 0 } }; glbox.self = glbox;
vm.createContext(glbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glbox, { filename: f });
const GL = glbox.DwfGL;
assert.ok(GL, "GL export loads");

class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
}
const store = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
globalThis.Image = class { constructor() { this.onload = null; this.onerror = null; } set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });
vm.runInThisContext(tilesSource, { filename: "web/js/dwf-tiles.js" });
const Tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });
assert.equal(typeof Tiles._resolveDesigForTest, "function", "canvas designation hook loads");

let failed = 0;
function cell(v) { return Array.from(v.cell || []); }
function check(name, fn) { try { fn(); console.log("PASS " + name); } catch (e) { failed++; console.error("FAIL " + name + ": " + (e.stack || e)); } }
function makeAtlas() {
  const ids = new Map(); let next = 1;
  return {
    resolve(sheet, col, row) { const key = sheet + "|" + col + "|" + row; if (!ids.has(key)) ids.set(key, next++); return ids.get(key); },
    resolvePalette(sheet, col, row) { return this.resolve(sheet, col, row); },
  };
}
function decode(b) {
  const f = new Float32Array(b.buffer), u = new Uint16Array(b.buffer), c = new Uint8Array(b.buffer), out = [];
  for (let i = 0; i < b.count; i++) out.push({ i, x: f[i * 4], y: f[i * 4 + 1], cell: u[i * 8 + 4], attr: u[i * 8 + 5], a: c[i * 16 + 15] });
  return out;
}
function tile(o = {}) { return Object.assign({ tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o); }
function view(w, h) { return { origin: { x: 0, y: 0, z: 150 }, width: w, height: h, tiles: Array.from({ length: w * h }, () => tile()) }; }

const nativeDesignationTokens = {
  dig: "DESIGNATION_DIG_STANDARD", channel: "DESIGNATION_DIG_CHANNEL", ramp: "DESIGNATION_DIG_RAMP",
  stairUp: "DESIGNATION_DIG_STAIR_UP", stairDown: "DESIGNATION_DIG_STAIR_DOWN",
  stairUpDown: "DESIGNATION_DIG_STAIR_UPDOWN", removeConstruction: "DESIGNATION_DIG_REMOVE_CONSTRUCTION",
  chop: "DESIGNATION_CHOP", gather: "DESIGNATION_GATHER", smooth: "DESIGNATION_SMOOTH",
  engrave: "DESIGNATION_ENGRAVE", fortify: "DESIGNATION_FORTIFY", trafficLow: "DESIGNATION_TRAFFIC_LOW",
  trafficHigh: "DESIGNATION_TRAFFIC_HIGH", trafficRes: "DESIGNATION_TRAFFIC_RESTRICTED",
};
for (const [kind, token] of Object.entries(nativeDesignationTokens)) check("B56 native graphics raw cell " + kind, () => {
  const e = interfaceMap[token];
  assert.ok(e && e.img === "designations.png", token + " must be authored on the native designation sheet");
  assert.deepEqual(Array.from(GL.DESIG_CELL[kind]), [e.cx / 32, e.cy / 32]);
});
const nativeTrackTokens = {
  1: "N", 2: "S", 3: "NS", 4: "E", 5: "NE", 6: "SE", 7: "NSE", 8: "W",
  9: "NW", 10: "SW", 11: "NSW", 12: "WE", 13: "NWE", 14: "SWE", 15: "NSWE",
};
for (const [mask, suffix] of Object.entries(nativeTrackTokens)) check("B56 native graphics raw track mask " + mask, () => {
  const e = interfaceMap["DESIGNATION_TRACK_" + suffix];
  assert.ok(e && e.img === "designations.png");
  assert.deepEqual(Array.from(GL.DESIG_TRACK_CELL[mask]), [e.cx / 32, e.cy / 32]);
});

const matrix = [
  ["dig", { dig: "Default" }, tile(), GL.DESIG_CELL.dig, "dig"],
  ["channel", { dig: "Channel" }, tile(), GL.DESIG_CELL.channel, "channel"],
  ["ramp", { dig: "Ramp" }, tile(), GL.DESIG_CELL.ramp, "ramp"],
  ["up stair", { dig: "UpStair" }, tile(), GL.DESIG_CELL.stairUp, "stair"],
  ["down stair", { dig: "DownStair" }, tile(), GL.DESIG_CELL.stairDown, "stair"],
  ["up/down stair", { dig: "UpDownStair" }, tile(), GL.DESIG_CELL.stairUpDown, "stair"],
  ["remove construction", { dig: "Default" }, tile({ mat: "CONSTRUCTION" }), GL.DESIG_CELL.removeConstruction, "removeConstruction"],
  ["chop tree", { dig: "Default" }, tile({ mat: "TREE" }), GL.DESIG_CELL.chop, "chop"],
  ["chop tree root via plant tail", { dig: "Default" }, tile({ shape: "WALL", mat: "ROOT", plant: { part: "TRUNK" } }), GL.DESIG_CELL.chop, "chop"],
  ["gather shrub", { dig: "Default" }, tile({ shape: "SHRUB", mat: "PLANT", plant: { part: "SHRUB" } }), GL.DESIG_CELL.gather, "gather"],
  ["smooth", { dig: "No", smooth: 1 }, tile({ shape: "WALL" }), GL.DESIG_CELL.smooth, "smooth"],
  ["engrave", { dig: "No", smooth: 2 }, tile({ shape: "WALL" }), GL.DESIG_CELL.engrave, "engrave"],
  ["traffic low", { dig: "No", traffic: 1 }, tile(), GL.DESIG_CELL.trafficLow, "traffic"],
  ["traffic high", { dig: "No", traffic: 2 }, tile(), GL.DESIG_CELL.trafficHigh, "traffic"],
  ["traffic restricted", { dig: "No", traffic: 3 }, tile(), GL.DESIG_CELL.trafficRes, "traffic"],
];
for (const [name, d, t, wantCell, wantCat] of matrix) check("B56 map " + name + " in both renderers", () => {
  const a = GL.resolveDesig(d, t), b = Tiles._resolveDesigForTest(d, t);
  assert.deepEqual(cell(a), Array.from(wantCell)); assert.deepEqual(cell(b), Array.from(wantCell));
  assert.equal(a.cat, wantCat); assert.equal(b.cat, wantCat);
});
for (const [mask, want] of Object.entries(GL.DESIG_TRACK_CELL)) check("B56 track mask " + mask + " in both renderers", () => {
  const d = { dig: "No", track: Number(mask) }, t = tile();
  assert.deepEqual(cell(GL.resolveDesig(d, t)), Array.from(want));
  assert.deepEqual(cell(Tiles._resolveDesigForTest(d, t)), Array.from(want));
});
check("B56 marker changes opacity, never glyph identity", () => {
  assert.deepEqual(cell(GL.resolveDesig({ dig: "Default", marker: 1 }, tile())), Array.from(GL.DESIG_CELL.dig));
});
check("B56 test-the-test: arbitrary plant tail is not guessed as gather", () => {
  assert.equal(GL.resolveDesig({ dig: "Default" }, tile({ plant: { part: "FRUIT" } })).cat, "dig");
  assert.equal(Tiles._resolveDesigForTest({ dig: "Default" }, tile({ plant: { part: "FRUIT" } })).cat, "dig");
});
check("B56 djob audit covers smooth/engrave/fortify/track", () => {
  const wants = [GL.DESIG_CELL.smooth, GL.DESIG_CELL.engrave, GL.DESIG_CELL.fortify, GL.DESIG_TRACK_CELL[15]];
  for (let k = 1; k <= 4; k++) assert.deepEqual(cell(GL.resolveDjob(k, tile())), Array.from(wants[k - 1]));
});

check("B54 exposed wall glyph is emitted ABOVE its open-face edge", () => {
  const atlas = makeAtlas();
  const spriteMap = {};
  for (const dir of ["N", "S", "W", "E", "N_S", "N_W", "N_E", "S_W", "S_E", "W_E", "N_S_W", "N_S_E", "N_W_E", "S_W_E", "N_S_W_E"])
    for (let v = 1; v <= 4; v++) spriteMap["SOIL_WALL_" + dir + "_" + v] = { sheet: "edge.png", col: dir.length, row: v };
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap: {}, shadowCellMap: {}, adjacency: glbox.DwfAdjacency });
  const x = 1, y = 1, v = view(3, 3); v.tiles[y * 3 + x] = tile({ shape: "WALL", mat: "SOIL", desig: { dig: "Default" } });
  v.tiles[y * 3 + x + 1] = tile({ shape: "FLOOR", mat: "SOIL" });
  b.buildScene(v); const inst = decode(b), glyph = atlas.resolve("designations.png", 0, 1);
  const gi = inst.findIndex(e => e.x === x && e.y === y && e.cell === glyph);
  const edgeIndices = inst.filter(e => e.x === x && e.y === y && e.cell !== glyph && e.cell !== GL.SOLID_CELL).map(e => e.i);
  assert.ok(gi >= 0, "glyph instance present"); assert.ok(edgeIndices.length, "edge instance present");
  assert.ok(gi > Math.max(...edgeIndices), "glyph index is later than every face texture at the tile");
  b.rebuildBuildings(Object.assign({}, v, { buildings: [{ type: "Wagon", x1: 5, y1: 5, x2: 7, y2: 7, z: 150 }] }));
  const after = decode(b), gi2 = after.findIndex(e => e.x === x && e.y === y && e.cell === glyph);
  assert.ok(gi2 > after.filter(e => e.x === x && e.y === y && e.cell !== glyph && e.cell !== GL.SOLID_CELL).reduce((m, e) => Math.max(m, e.i), -1), "H1 building rebuild preserves overlay-above-edge order");
  const wallCall = tilesSource.indexOf("drawWallJoin(t, px, py, cell, gx, gy, wallOpenMask);");
  const overlayPass = tilesSource.indexOf("OVERLAY LAYER (wire:5): designations + presence");
  const designationCall = tilesSource.indexOf("drawDesignation(t, gx * cell, gy * cell, cell, dk, designationNowMs,", overlayPass);
  assert.ok(wallCall >= 0 && overlayPass > wallCall && designationCall > overlayPass,
    "canvas2d open-face call precedes its final designation overlay pass");
});

check("OVL1 painter order is deterministic and native (bottom-over-top) in both renderers", () => {
  // Native paints BACK-TO-FRONT: up-screen (smaller y1) first, down-screen (larger y1, nearer)
  // LAST, so id 2 (lower) paints after id 1 (upper) -> [1, 2].
  const upper = { id: 1, y1: 1 }, lower = { id: 2, y1: 4 }, source = [upper, lower];
  assert.deepEqual(GL.buildingsInPaintOrder(source).map(x => x.id), [1, 2]);
  assert.deepEqual(Tiles._buildingsInPaintOrderForTest(source).map(x => x.id), [1, 2]);
  assert.deepEqual(source.map(x => x.id), [1, 2], "source AUX order not mutated");
});
check("OVL1 y-sort is stable and input-order-independent in both renderers", () => {
  // The lower (down-screen, larger y1, nearer) building must paint LAST so its overhang covers
  // the upper one -- regardless of the order the server sends them, and regardless of ties.
  // Feed BOTH permutations plus a tie and confirm the y1-ascending (native) result.
  const upper = { id: 1, y1: 1 }, lower = { id: 2, y1: 4 };
  for (const src of [[upper, lower], [lower, upper]]) {
    assert.deepEqual(GL.buildingsInPaintOrder(src).map(x => x.id), [1, 2], "GL: lower paints last");
    assert.deepEqual(Tiles._buildingsInPaintOrderForTest(src).map(x => x.id), [1, 2], "canvas: lower paints last");
  }
  // Ties (same y1) preserve source order in both renderers (stable sort, no flicker).
  const tie = [{ id: 7, y1: 3 }, { id: 8, y1: 3 }];
  assert.deepEqual(GL.buildingsInPaintOrder(tie).map(x => x.id), [7, 8]);
  assert.deepEqual(Tiles._buildingsInPaintOrderForTest(tie).map(x => x.id), [7, 8]);
});
check("OVL1 test-the-test: a reversed (down-screen-first) raw order is corrected by the y-sort", () => {
  // The seeded-bad case: the server sends the lower (down-screen) building FIRST, so a naive
  // unsorted pass would paint the lower's overhang UNDER the upper's body (the inverted defect
  // the prior wave shipped). The y-sort must REORDER it to bottom-over-top -- prove the sort is
  // load-bearing by confirming its output differs from the raw order and equals native.
  const seededBad = [{ id: 2, y1: 4 }, { id: 1, y1: 1 }]; // down-screen (lower) sent first
  for (const R of [GL.buildingsInPaintOrder, Tiles._buildingsInPaintOrderForTest]) {
    assert.notDeepEqual(seededBad.map(x => x.id), R(seededBad).map(x => x.id),
      "y-sort reorders the seeded-bad raw order (a no-op only if the sort were absent)");
    assert.deepEqual(R(seededBad).map(x => x.id), [1, 2], "corrected to native bottom-over-top");
  }
});
check("OVL1 adjacent lower overhang paints OVER upper workshop bottom row (native down-screen-over)", () => {
  const atlas = makeAtlas(), b = GL.createSceneBuilder({ atlas, buildingMap }); const v = view(8, 8);
  v.buildings = [
    { type: "Workshop", subtype: 2, x1: 1, y1: 1, x2: 3, y2: 3, z: 150 },
    { type: "Workshop", subtype: 2, x1: 1, y1: 4, x2: 3, y2: 6, z: 150 },
  ];
  b.buildScene(v); const inst = decode(b), e = buildingMap["Workshop:Masons"];
  const lowerOverhang = atlas.resolve(e.sheet, e.overhang[0].col, e.overhang[0].row);
  const upperBottom = atlas.resolve(e.sheet, e.cells[2][0].col, e.cells[2][0].row);
  const oi = inst.findIndex(q => q.x === 1 && q.y === 3 && q.cell === lowerOverhang);
  const bi = inst.findIndex(q => q.x === 1 && q.y === 3 && q.cell === upperBottom);
  // The lower (down-screen, nearer) workshop paints LAST, so its overhang lands AFTER the upper
  // workshop's real bottom row at the shared tile -> overhang covers upper (bottom-over-top).
  assert.ok(oi >= 0 && bi >= 0); assert.ok(oi > bi, "lower overhang paints after (over) upper footprint at collision row");
});
check("B58 kiln authored extent is full 3x4 plus matching overlay", () => {
  const e = buildingMap["Furnace:Kiln"];
  assert.equal(e.w, 3); assert.equal(e.h, 3); assert.equal(e.cells.length, 3); assert.equal(e.overhang.length, 3);
  assert.equal(e.overlay.length, 3); assert.equal(e.overlayOverhang.length, 3);
  const atlas = makeAtlas(), b = GL.createSceneBuilder({ atlas, buildingMap }), v = view(6, 6);
  v.buildings = [{ type: "Furnace", subtype: 3, x1: 1, y1: 1, x2: 3, y2: 3, z: 150 }];
  b.buildScene(v);
  const topCells = new Set([...e.overhang.map(c => atlas.resolve(e.sheet, c.col, c.row)),
    ...e.overlayOverhang.map(c => atlas.resolve(e.overlaySheet, c.col, c.row))]);
  const top = decode(b).filter(q => q.y === 0 && q.x >= 1 && q.x <= 3 && topCells.has(q.cell));
  assert.equal(top.length, 6, "three base-overhang + three overlay-overhang instances emitted outside 3x3 footprint");
});

// TX3 (wagon 3x3 art broken AGAIN -- B47 reopen). The DF raws author WAGON_BLD as a
// 3-wide x 3-tall footprint (subtile_x 0,1,2 -- graphics_buildings.txt L371-382) plus a
// row-0 overhang. The old build_building_map.py mis-read the 2-param `col:row` grammar as
// `variant:row` and max()-collapsed the art to column 2 only, so the client centered a
// 1-wide strip and left 2 of the 3 footprint columns blank on screen ("2 column of the
// 3x3 are blank"). The fix is DATA (generator disambiguates col:row from stage:row), so the
// wagon body must now fill ALL THREE columns with DISTINCT art -- and stay filled across the
// H1 building-segment rebuild path (2861db9), which the old build-only test never exercised.
function wagonBodyCells(atlas) {
  const e = buildingMap.Wagon, s = new Set();
  for (const row of e.cells) for (const c of row) s.add(atlas.resolve(e.sheet, c.col, c.row));
  return s;
}
function wagonShape(inst, cells) {
  const body = inst.filter(q => cells.has(q.cell));
  return {
    count: body.length,
    xs: [...new Set(body.map(q => q.x))].sort((a, b) => a - b),
    ys: [...new Set(body.map(q => q.y))].sort((a, b) => a - b),
  };
}
check("TX3 wagon Wagon entry is the raws-derived 3-wide art, 3 distinct columns per row", () => {
  const e = buildingMap.Wagon;
  assert.equal(e.sheet, "wagons.png");
  assert.equal(e.w, 3, "wagon footprint art is 3 columns wide (not the collapsed 1-wide strip)");
  assert.equal(e.h, 3);
  assert.equal(e.cells.length, 3);
  for (const row of e.cells) {
    assert.equal(row.length, 3, "every footprint row spans all 3 columns");
    const cols = new Set(row.map(c => c.col));
    assert.equal(cols.size, 3, "the 3 columns are DISTINCT art, not one strip repeated");
  }
  assert.ok(Array.isArray(e.overhang) && e.overhang.length === 3, "overhang row is 3-wide too");
});
check("TX3 wagon fills all 3 columns in GL -- on initial build AND across H1 segment rebuild", () => {
  const atlas = makeAtlas(), b = GL.createSceneBuilder({ atlas, buildingMap }), v = view(8, 8);
  v.buildings = [{ type: "Wagon", x1: 1, y1: 1, x2: 3, y2: 3, z: 150 }];
  b.buildScene(v);
  const cells = wagonBodyCells(atlas);
  const want = { count: 9, xs: [1, 2, 3], ys: [1, 2, 3] };
  assert.deepEqual(wagonShape(decode(b), cells), want, "initial build: full 3x3, no blank columns");
  // H1: the machine-beat rebuild re-emits ONLY the building segment. Exercise that path.
  b.rebuildBuildings(Object.assign({}, v, { machineParity: 1 }));
  assert.deepEqual(wagonShape(decode(b), cells), want, "post-rebuild segment: still full 3x3, no columns dropped");
});
check("TX3 test-the-test: a collapsed 1-wide wagon entry is caught as blank columns", () => {
  // Seed the historical bad data (art collapsed to column 2 only) and confirm the shape
  // assertion above FAILS on it -- proving the test detects the regression, not a tautology.
  const badMap = JSON.parse(JSON.stringify(buildingMap));
  const strip = c => c[2] ? [c[2]] : [c[c.length - 1]];
  badMap.Wagon = Object.assign({}, buildingMap.Wagon, { w: 1, cells: buildingMap.Wagon.cells.map(strip) });
  const atlas = makeAtlas(), b = GL.createSceneBuilder({ atlas, buildingMap: badMap }), v = view(8, 8);
  v.buildings = [{ type: "Wagon", x1: 1, y1: 1, x2: 3, y2: 3, z: 150 }];
  b.buildScene(v);
  const cells = new Set();
  for (const row of badMap.Wagon.cells) for (const c of row) cells.add(atlas.resolve(badMap.Wagon.sheet, c.col, c.row));
  const shape = wagonShape(decode(b), cells);
  assert.equal(shape.xs.length, 1, "seeded-bad strip renders a single column (2 of 3 blank) -- the exact reported defect");
  assert.notDeepEqual(shape, { count: 9, xs: [1, 2, 3], ys: [1, 2, 3] });
});
check("TX3 both renderers only center art NARROWER than footprint (3-wide art on 3-wide wagon is not centered)", () => {
  // Data parity: both renderers consume the same building_map.json and gate centering on the
  // identical guard `gw2 < bfw`. With the fixed 3-wide art on a 3-wide footprint, gw2 == bfw,
  // so offX == 0 in BOTH -> every footprint column is drawn. This is the shared invariant that
  // makes the canvas2d wagon match the GL wagon proven above (the harness cannot resolve
  // canvas building cells without a live map, so assert the load-bearing source in both).
  const guard = "(multiCell && gw2 < bfw) ? ((bfw - gw2) >> 1) : 0";
  assert.ok(tilesSource.includes("offX = " + guard), "canvas2d offX uses the narrower-than-footprint guard");
  assert.ok(glSource.includes("offX = " + guard), "GL offX uses the identical guard");
});

check("TX2 flooded mud emits spatter before liquid in GL and source order matches canvas2d", () => {
  const atlas = makeAtlas(), b = GL.createSceneBuilder({ atlas, spatterMap });
  const v = { origin: { x: 0, y: 0, z: 150 }, width: 1, height: 1, tiles: [tile({ flow: 1, liquid: "water", spatters: [{ mat_type: 12, mat_index: -1, state: 0, amount: 255 }] })] };
  b.buildScene(v); const inst = decode(b), liquid = atlas.resolve("liquids.png", 0, 6);
  const mud = spatterMap.families.MUD, mudCells = new Set(Object.values(mud.cells).map(c => atlas.resolve(mud.sheet, c.col, c.row)));
  const si = inst.findIndex(q => mudCells.has(q.cell)), li = inst.findIndex(q => q.cell === liquid);
  assert.ok(si >= 0 && li >= 0); assert.ok(si < li, "liquid instance is above mud instance");
  const pre = tilesSource.indexOf("drawSpatter(t, px, py, cell, gx, gy);", tilesSource.indexOf("} else if (liquidSprite)"));
  const water = tilesSource.indexOf("ctx.drawImage(liquidSprite.img", pre);
  assert.ok(pre >= 0 && water > pre, "canvas2d calls spatter before liquid blit");
  assert.ok(tilesSource.includes("if (!liquidSprite) drawSpatter(t, px, py, cell, gx, gy);"), "flooded spatter is not repainted above liquid");
});

check("B97 material spatter threshold is parity-gated in both renderers", () => {
  const atlas = makeAtlas(), b = GL.createSceneBuilder({ atlas, spatterMap });
  assert.equal(b._spatterVisibleAmountForTest, 25, "GL owns the documented B97 cutoff");
  assert.equal(Tiles._spatterVisibleAmountForTest, 25, "canvas owns the documented B97 cutoff");
  for (const [name, visible] of [["GL", b._spatterVisibleForTest], ["canvas", Tiles._spatterVisibleForTest]]) {
    assert.equal(visible(24), false, name + " hides the final sub-threshold material spatter");
    assert.equal(visible(25), true, name + " draws the first visible material spatter");
    assert.equal(visible(24, 0), true, name + " seeded-bad threshold=0 would redraw the reported clutter");
  }
  const low = view(1, 1); low.tiles[0].spatters = [{ mat_type: 12, mat_index: -1, state: 0, amount: 24 }];
  b.buildScene(low);
  const mud = spatterMap.families.MUD;
  const mudCells = new Set(Object.values(mud.cells).map(c => atlas.resolve(mud.sheet, c.col, c.row)));
  assert.equal(decode(b).some(q => mudCells.has(q.cell)), false, "GL fixture: below threshold emits no material-spatter draw");
  const high = view(1, 1); high.tiles[0].spatters = [{ mat_type: 12, mat_index: -1, state: 0, amount: 25 }];
  b.buildScene(high);
  assert.equal(decode(b).some(q => mudCells.has(q.cell)), true, "GL fixture: above threshold emits its material-spatter draw");
  assert.ok(tilesSource.includes("if (!sp || !spatterVisible(sp.amount)) continue;"), "canvas draw loop uses its threshold helper");
  assert.ok(tilesSource.includes("drawSpatterFallbackWash(firstVisibleSpatter(arr), px, py, cell)"), "canvas fallback cannot redraw a hidden first spatter");
});

check("B200 amount->shape ladder: GL matches spatter_map.json, canvas shares the identical map-driven mechanism", () => {
  const atlas = makeAtlas(), b = GL.createSceneBuilder({ atlas, spatterMap });
  // GL band matrix (the canvas equivalent, with a loaded map, is pinned in wc3_we4_wc12).
  const bands = [[25, "PARTIAL_1"], [49, "PARTIAL_1"], [50, "PARTIAL_2"], [98, "PARTIAL_2"],
                 [109, "PARTIAL_2"], [110, "PARTIAL_3"], [159, "PARTIAL_3"], [160, "PARTIAL_4"],
                 [209, "PARTIAL_4"], [210, "FULL"], [255, "FULL"]];
  for (const [amt, want] of bands) assert.equal(b._spatterShapeForTest(amt), want, `GL amount ${amt} -> ${want}`);
  // Parity of mechanism: both renderers select the shape by scanning the SAME data table
  // (spatter_map.json amount_thresholds_default), so a data-only recalibration moves them in
  // lockstep -- the GL/canvas divergence bug class the ledger already paid for cannot recur.
  assert.ok(glSource.includes("amount_thresholds_default"), "GL shape ladder is data-driven from the map");
  assert.ok(tilesSource.includes("amount_thresholds_default"), "canvas shape ladder is data-driven from the map");
});

check("B200 render witness: a 'smear' (amount 98) draws a PARTIAL cell, only a 'coating' (amount 220) draws a FULL cell", () => {
  const atlas = makeAtlas(), b = GL.createSceneBuilder({ atlas, spatterMap });
  const mud = spatterMap.families.MUD;
  const cellSet = pred => new Set(Object.entries(mud.cells)
    .filter(([k]) => pred(k)).map(([, c]) => atlas.resolve(mud.sheet, c.col, c.row)));
  const fullCells = cellSet(k => k.startsWith("FULL_"));
  const partialCells = cellSet(k => k.startsWith("PARTIAL_"));

  // amount 98 = native "A smear of" -- the exact reading behind the report. Must be a
  // light PARTIAL decal, never the edge-to-edge FULL coating that carpeted the map red.
  const smear = view(1, 1); smear.tiles[0].spatters = [{ mat_type: 12, mat_index: -1, state: 0, amount: 98 }];
  b.buildScene(smear);
  let q = decode(b);
  assert.equal(q.some(i => partialCells.has(i.cell)), true, "amount 98 emits a PARTIAL mud cell");
  assert.equal(q.some(i => fullCells.has(i.cell)), false, "amount 98 must NOT emit a FULL mud cell (the B200 regression)");

  // amount 220 = near-saturation coating -- this is where FULL is correct.
  const coat = view(1, 1); coat.tiles[0].spatters = [{ mat_type: 12, mat_index: -1, state: 0, amount: 220 }];
  b.buildScene(coat);
  q = decode(b);
  assert.equal(q.some(i => fullCells.has(i.cell)), true, "amount 220 emits a FULL mud cell (coating)");
});

check("TX1 prerequisite: authored empty/full/top cells exist but current wire input cannot select contents", () => {
  const empty = itemMap.bytoken.ITEM_BARREL_WOOD_EMPTY, full = itemMap.bytoken.ITEM_BARREL_WOOD_ITEM, top = itemMap.bytoken.ITEM_BARREL_TOP_MEAT;
  assert.notDeepEqual(empty, full); assert.ok(top && top.sheet === "containers.png");
  const b = GL.createSceneBuilder({ itemMap });
  const wireItem = { type: "BARREL", mat_type: 420, mat_index: 154, subtype: -1, iflags: 0, stack: 1 };
  assert.deepEqual(JSON.parse(JSON.stringify(b._resolveItemVisualForTest(wireItem).entry)), itemMap.bytype.BARREL);
  assert.equal(Object.prototype.hasOwnProperty.call(wireItem, "contents"), false, "no contents discriminator exists on the renderer input");
});

// ---- WT25: whole-map base state -- in-bounds undiscovered (tt<0) paints the hidden-rock hatch,
// off-map tt<0 stays black. Canvas2d (wantsHiddenHatch) and GL (buildScene emit) must agree.
const wt25Dims = { w: 16, h: 16, z: 4 };
const inBoundsVoid = { x: 5, y: 5, tt: -1 };            // undiscovered rock inside the footprint
const offMapVoid = { x: 40, y: 5, tt: -1 };            // real map edge / sky column
const shippedHidden = { x: 5, y: 5, tt: 2, hidden: 1 }; // pre-WT25 shipped-and-hidden tile
const realFloor = { x: 5, y: 5, tt: 2, hidden: 0 };     // discovered terrain

check("WT25 canvas2d: in-bounds tt<0 wants the hatch; off-map tt<0 stays black", () => {
  assert.equal(Tiles._wantsHiddenHatchForTest(inBoundsVoid, wt25Dims), true);
  assert.equal(Tiles._wantsHiddenHatchForTest(offMapVoid, wt25Dims), false);
});
check("WT25 canvas2d: shipped-and-hidden still hatches; discovered terrain never does", () => {
  assert.equal(Tiles._wantsHiddenHatchForTest(shippedHidden, wt25Dims), true);
  assert.equal(Tiles._wantsHiddenHatchForTest(realFloor, wt25Dims), false);
});
check("WT25 canvas2d: no map dims (pre-hello) -> ONLY shipped-hidden hatches, tt<0 stays black", () => {
  assert.equal(Tiles._wantsHiddenHatchForTest(inBoundsVoid, null), false);
  assert.equal(Tiles._wantsHiddenHatchForTest(shippedHidden, null), true);
});
check("WT25 test-the-test: an off-map tt<0 must NOT hatch (would black-out the world edge if it did)", () => {
  // A bug that keyed on `tt<0` alone (ignoring bounds) would return true here.
  assert.notEqual(Tiles._wantsHiddenHatchForTest(offMapVoid, wt25Dims), true);
});
check("WT25 parity: GL inMapBounds agrees with canvas2d inMapBounds byte-for-byte", () => {
  const glb = GL.createSceneBuilder({ atlas: makeAtlas() });
  for (const t of [inBoundsVoid, offMapVoid, { x: 0, y: 0, tt: -1 }, { x: 16, y: 0, tt: -1 }, { x: 15, y: 15, tt: -1 }]) {
    assert.equal(glb._inMapBoundsForTest(t, wt25Dims), Tiles._inMapBoundsForTest(t, wt25Dims),
      `bounds parity at (${t.x},${t.y})`);
  }
  assert.equal(glb._inMapBoundsForTest(inBoundsVoid, null), false, "null dims -> not in bounds");
});
check("WT25 GL integration: buildScene emits a hidden_rock cell for an in-bounds tt<0 tile, none for off-map", () => {
  const spriteMap = { HIDDEN_ROCK_1: { sheet: "hidden_rock.png", col: 0, row: 0 },
    HIDDEN_ROCK_2: { sheet: "hidden_rock.png", col: 1, row: 0 }, HIDDEN_ROCK_3: { sheet: "hidden_rock.png", col: 2, row: 0 },
    HIDDEN_ROCK_4: { sheet: "hidden_rock.png", col: 3, row: 0 }, HIDDEN_ROCK_5: { sheet: "hidden_rock.png", col: 4, row: 0 } };
  const atlas = makeAtlas();
  const hiddenCells = new Set([0, 1, 2, 3, 4].map((c) => atlas.resolve("hidden_rock.png", c, 0)));
  const glb = GL.createSceneBuilder({ atlas, spriteMap, tokenMap: {}, shadowCellMap: {},
    adjacency: glbox.DwfAdjacency, mapDims: wt25Dims });
  // in-bounds tt<0 -> a hatch cell is emitted, over a HIDDEN_COLOR [6,6,8] backdrop
  glb.buildScene({ origin: { x: 0, y: 0, z: 2 }, width: 1, height: 1, tiles: [{ x: 5, y: 5, tt: -1 }] });
  const inb = decode(glb);
  assert.ok(inb.some((i) => hiddenCells.has(i.cell)), "in-bounds tt<0 emits a hidden_rock cell");
  // off-map tt<0 -> NO hatch (black); positioned outside [0,16) in x
  const glb2 = GL.createSceneBuilder({ atlas, spriteMap, tokenMap: {}, shadowCellMap: {},
    adjacency: glbox.DwfAdjacency, mapDims: wt25Dims });
  glb2.buildScene({ origin: { x: 40, y: 0, z: 2 }, width: 1, height: 1, tiles: [{ x: 40, y: 5, tt: -1 }] });
  assert.ok(!decode(glb2).some((i) => hiddenCells.has(i.cell)), "off-map tt<0 emits no hidden_rock cell");
});

if (failed) { console.error("\n" + failed + " renderer-wave section(s) FAILED"); process.exit(1); }
console.log("\nALL renderer-wave checks PASSED");
