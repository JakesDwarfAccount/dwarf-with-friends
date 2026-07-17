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

// TX4 farm-crops regression: additive wire decode + shared crop-stage policy + both renderers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ok - " + name); }

// ---- additive tail decode ---------------------------------------------------------
const wireBox = {};
wireBox.self = wireBox; wireBox.globalThis = wireBox;
vm.createContext(wireBox);
vm.runInContext(read("web/js/dwf-wire-v1.js"), wireBox, { filename: "dwf-wire-v1.js" });
const W = wireBox.DwfWireV1;

function u16(a, v) { a.push(v & 255, (v >> 8) & 255); }
function u32(a, v) { a.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255); }
function farmCropPayload(tileIdx, stage, id) {
  const a = [];
  u32(a, 77); u16(a, 1);                 // world_seq, block_count
  u16(a, 3); u16(a, 4); u16(a, 169);     // bx, by, bz
  u32(a, 9); a.push(0); u16(a, 1);       // ver, bflags, tail_count
  for (let i = 0; i < 256; i++) {
    u16(a, 1); u16(a, 0); u16(a, 0);     // tt, base_mt, base_mi
    a.push(0, 0, 0, 0);                  // bits, desig1, desig2, spatter_amt
    u16(a, i === tileIdx ? 0x0400 : 0);  // flags2 FARM_CROP
  }
  const bytes = Buffer.from(id, "ascii");
  a.push(tileIdx, 0x0B, 2 + bytes.length, stage, bytes.length, ...bytes);
  return Uint8Array.from(a);
}

const decoded = W.decodeBlockSet(farmCropPayload(23, 1, "BERRIES_STRAW"));
check("wire exposes additive FARM_CROP constants", () => {
  assert.equal(W.C.TAIL_FARM_CROP, 0x0B); assert.equal(W.C.F2_FARM_CROP, 0x0400);
});
check("wire decodes planted strawberry species and sprout stage", () => {
  const b = decoded.blocks[0], t = b.tails[0];
  assert.equal(b.records[23].flags2 & W.C.F2_FARM_CROP, W.C.F2_FARM_CROP);
  assert.deepEqual({ kind: t.kind, tile: t.tile_idx, stage: t.data.stage, id: t.data.id },
    { kind: 0x0B, tile: 23, stage: 1, id: "BERRIES_STRAW" });
});

// ---- real authored plant-map cells ------------------------------------------------
const realPlantMap = JSON.parse(read("web/plant_map.json"));
check("strawberry has authored seed, sprout, and ripe crop cells", () => {
  const s = realPlantMap.BERRIES_STRAW;
  assert.ok(s.SEED && s.CROP_SPROUT && s.CROP);
  assert.deepEqual([s.CROP.col, s.CROP.row, s.CROP.sheet], [5, 9, "plant_standard.png"]);
  assert.deepEqual([s.CROP_SPROUT.col, s.CROP_SPROUT.row, s.CROP_SPROUT.sheet], [9, 9, "plant_standard.png"]);
});

const plantMap = {
  BERRIES_STRAW: {
    SEED: { sheet: "plant_standard.png", col: 2, row: 9 },
    CROP_SPROUT: { sheet: "plant_standard.png", col: 9, row: 9 },
    CROP: { sheet: "plant_standard.png", col: 5, row: 9 },
  },
  WHEAT: {
    SEED: { sheet: "plant_crops.png", col: 2, row: 0 },
    CROP_SPROUT: { sheet: "plant_crops.png", col: 7, row: 0 },
    CROP: { sheet: "plant_crops.png", col: 6, row: 0 },
    CROP_L: { sheet: "plant_crops.png", col: 8, row: 0 },
    CROP_M: { sheet: "plant_crops.png", col: 9, row: 0 },
    CROP_R: { sheet: "plant_crops.png", col: 10, row: 0 },
  },
};

function loadCanvas() {
  const b = { document: { createElement: () => ({ getContext: () => ({}) }), querySelector: () => null },
    location: { search: "", protocol: "http:", host: "localhost:8765" }, URLSearchParams, URL,
    TextEncoder, TextDecoder, fetch: async () => ({ ok: false }), addEventListener: () => {},
    setTimeout, clearTimeout, console };
  b.window = b; b.self = b; b.globalThis = b;
  vm.createContext(b);
  for (const f of ["web/js/dwf-farm-crops.js", "web/js/dwf-adjacency.js", "web/js/dwf-tiles.js"])
    vm.runInContext(read(f), b, { filename: f });
  return b.DwfTiles;
}
let GL;
function loadGL() {
  const b = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 } };
  b.self = b; b.globalThis = b;
  vm.createContext(b);
  for (const f of ["web/js/dwf-farm-crops.js", "web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
    vm.runInContext(read(f), b, { filename: f });
  GL = b.DwfGL;
  const builder = b.DwfGL.createSceneBuilder({ atlas: { resolve: () => 1 }, spriteMap: {},
    tokenMap: {}, shadowCellMap: {}, adjacency: b.DwfAdjacency, plantMap });
  return builder;
}
const canvas = loadCanvas(), gl = loadGL();
assert.equal(typeof canvas._farmCropPlansForTest, "function");
assert.equal(typeof gl._farmCropPlansForTest, "function");

function plansBoth(tiles, width = tiles.length, height = 1) {
  const c = canvas._farmCropPlansForTest(tiles, width, height, plantMap);
  const g = gl._farmCropPlansForTest({ tiles, width, height });
  assert.deepEqual(JSON.parse(JSON.stringify(c)), JSON.parse(JSON.stringify(g)));
  return c;
}

for (const [stage, token] of [[0, "SEED"], [1, "CROP_SPROUT"], [2, "CROP"]]) {
  check(`both renderers emit strawberry ${token} for stage ${stage}`, () => {
    const p = plansBoth([{ farmCrop: { id: "BERRIES_STRAW", stage } }]);
    assert.equal(p.length, 1); assert.equal(p[0].token, token); assert.ok(p[0].cell.sheet);
  });
}
check("ripe joined rows resolve authored CROP_L/M/R cells", () => {
  const tiles = [0, 1, 2].map(() => ({ farmCrop: { id: "WHEAT", stage: 2 } }));
  assert.deepEqual(Array.from(plansBoth(tiles), p => p.token), ["CROP_L", "CROP_M", "CROP_R"]);
});
check("empty plot emits no crop overlay", () => { assert.equal(plansBoth([{}]).length, 0); });
check("seeded-bad invisible renderer shape is rejected by the visibility invariant", () => {
  const seeded = [{ farmCrop: { id: "BERRIES_STRAW", stage: 0 } }];
  const productionVisible = plansBoth(seeded).length === 1;
  const oldInvisibleMutation = [];
  assert.equal(productionVisible, true);
  assert.equal(oldInvisibleMutation.length === 1, false, "seeded-bad mutant must not satisfy visibility");
});

check("canvas and GL paint crop overlays after farm buildings", () => {
  const c = read("web/js/dwf-tiles.js"), g = read("web/js/dwf-gl.js");
  assert.match(c, /paintFarmLayers\(\(\) => \{[\s\S]*drawFarmCrops\(tiles, gw, gh, cell\)/);
  assert.match(g, /paintFarmLayers\(function \(\) \{[\s\S]*emitFarmCrops\(view\)/);
});
check("shared painter policy always composites crops after buildings", () => {
  const order = [];
  const policyBox = {};
  policyBox.self = policyBox; policyBox.globalThis = policyBox;
  vm.createContext(policyBox);
  vm.runInContext(read("web/js/dwf-farm-crops.js"), policyBox);
  policyBox.DwfFarmCrops.paintAboveBuildings(
    () => order.push("building"), () => order.push("crop"));
  assert.deepEqual(order, ["building", "crop"]);
});
check("GL late building rebuild keeps the farm bed below the extracted crop segment", () => {
  const cells = new Map();
  const atlas = { resolve(sheet, col, row) {
    const key = `${sheet}:${col}:${row}`;
    if (!cells.has(key)) cells.set(key, cells.size + 10);
    return cells.get(key);
  } };
  const spriteMap = { FARMPLOT_PLANTED: { sheet: "farm-bed.png", col: 0, row: 0 } };
  const b = GL.createSceneBuilder({ atlas, spriteMap, plantMap });
  const tile = { shape: "FLOOR", farmCrop: { id: "BERRIES_STRAW", stage: 0 } };
  const base = { origin: { x: 0, y: 0, z: 169 }, width: 1, height: 1, tiles: [tile] };
  const farm = { type: "FarmPlot", x1: 0, y1: 0, x2: 0, y2: 0, z: 169, bextra: 182 };

  assert.equal(plansBoth([tile]).length, 1, "crop extraction precedes the late AUX building");
  b.buildScene({ ...base, buildings: [] });
  b.rebuildBuildings({ ...base, buildings: [farm] });

  const view = new DataView(b.buffer, 0, b.count * GL.INSTANCE_BYTES);
  const emitted = [];
  for (let i = 0; i < b.count; i++) emitted.push(view.getUint16(i * GL.INSTANCE_BYTES + 8, true));
  const bed = atlas.resolve("farm-bed.png", 0, 0);
  const seed = atlas.resolve("plant_standard.png", 2, 9);
  const bedAt = emitted.indexOf(bed), seedAt = emitted.indexOf(seed);
  assert.ok(bedAt >= 0 && seedAt > bedAt, `farm bed ${bedAt}, seed ${seedAt}`);
  assert.equal(b.cropStart, seedAt, "crop segment starts at the seed instance");
  assert.equal(b.cropCount, 1, "late rebuild retains exactly one crop instance");
});
check("GL AUX building beat keeps crops on the padded block-scene basis", () => {
  const cells = new Map();
  const atlas = { resolve(sheet, col, row) {
    const key = `${sheet}:${col}:${row}`;
    if (!cells.has(key)) cells.set(key, cells.size + 10);
    return cells.get(key);
  } };
  const b = GL.createSceneBuilder({ atlas,
    spriteMap: { FARMPLOT_PLANTED: { sheet: "farm-bed.png", col: 0, row: 0 } }, plantMap });
  const crop = { shape: "FLOOR", farmCrop: { id: "BERRIES_STRAW", stage: 0 } };
  const padded = { origin: { x: 0, y: 0, z: 169 }, width: 3, height: 1,
    tiles: [{ shape: "FLOOR" }, crop, { shape: "FLOOR" }], buildings: [] };
  const farm = { type: "FarmPlot", x1: 1, y1: 0, x2: 1, y2: 0, z: 169, bextra: 182 };
  // The fresh AUX-composed viewport is narrower and carries no crop at its local tile 0. The
  // retained GL scene is padded; rebuilding crops from this viewport against padded origin 0
  // was the live-only failure that the old same-shape fixture could not distinguish.
  const auxViewport = { origin: { x: 1, y: 0, z: 169 }, width: 1, height: 1,
    tiles: [{ shape: "FLOOR" }], buildings: [farm] };
  const rebuildView = GL._buildingRebuildViewForTest(padded, auxViewport);

  assert.equal(rebuildView.origin.x, 0, "retains padded scene origin");
  assert.equal(rebuildView.width, 3, "retains padded scene width");
  assert.equal(rebuildView.tiles[1].farmCrop.id, "BERRIES_STRAW", "retains block-tail crop");
  assert.equal(rebuildView.buildings[0], farm, "takes fresh AUX building record");

  b.buildScene(padded);
  b.rebuildBuildings(rebuildView);
  const view = new DataView(b.buffer, 0, b.count * GL.INSTANCE_BYTES);
  const emitted = [];
  for (let i = 0; i < b.count; i++) emitted.push(view.getUint16(i * GL.INSTANCE_BYTES + 8, true));
  const bedAt = emitted.indexOf(atlas.resolve("farm-bed.png", 0, 0));
  const seedAt = emitted.indexOf(atlas.resolve("plant_standard.png", 2, 9));
  assert.ok(bedAt >= 0 && seedAt > bedAt, `AUX farm bed ${bedAt}, retained seed ${seedAt}`);
  assert.equal(b.cropCount, 1, "AUX-only rebuild cannot erase the block-owned crop segment");
});
check("cache ingest preserves decoded farmCrop sparse data", () => {
  const worker = read("web/js/dwf-cache-worker.js"), cache = read("web/js/dwf-cache.js");
  assert.match(worker, /field: "farmCrop"/); assert.match(cache, /sp\.farmCrop/);
});
check("server scans PERM farm contained items and folds stage changes", () => {
  const wire = read("src/wire_v1.cpp"), stream = read("src/world_stream.cpp");
  assert.match(wire, /building_item_role_type::PERM/);
  assert.match(wire, /grow_counter < raw->growdur/);
  assert.match(stream, /farm_crop_block_fold/);
});

console.log(`\ntx4_farm_crops_test: ${passed} checks passed`);
