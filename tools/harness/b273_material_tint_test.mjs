// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// B273: material color is a palette substitution on palette-authored sprite classes, not a
// scene-wide multiply. This gate samples the installed game's real PNG pixels and then asserts
// that every material-bearing renderer path carries DF's STATE_COLOR palette row.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { dfRootOrSkip } from "../lib/dfroot.mjs";
import { loadGL, loadTiles } from "./groundart_fixture_support.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DF_ROOT = dfRootOrSkip("b273_material_tint_test.mjs");
const VANILLA = path.join(DF_ROOT, "data", "vanilla");
const ENV_IMAGES = path.join(VANILLA, "vanilla_environment", "graphics", "images");
const ENV_GRAPHICS_RAW = path.join(VANILLA, "vanilla_environment", "graphics", "graphics_tiles.txt");
const BLD_IMAGES = path.join(VANILLA, "vanilla_buildings_graphics", "graphics", "images");
const materialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "material_map.json"), "utf8"));
const buildingMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "building_map.json"), "utf8"));
const byId = new Map(materialMap.inorganic.map((m, index) => [m.id, { ...m, index }]));

// Minimal zero-dependency PNG reader: enough for DF's 8-bit RGB/RGBA sprite sheets and the
// committed oracle screenshots. Keeping the decoder here makes the pixel assertions real without
// adding an npm dependency or shelling out to Python from a Node suite.
function readPng(file) {
  const src = fs.readFileSync(file);
  assert.deepEqual([...src.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], path.basename(file) + " PNG signature");
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, plte = null, trns = null;
  const idat = [];
  while (off < src.length) {
    const len = src.readUInt32BE(off); off += 4;
    const type = src.toString("ascii", off, off + 4); off += 4;
    const data = src.subarray(off, off + len); off += len + 4; // data + CRC
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      assert.equal(data[12], 0, path.basename(file) + " must be non-interlaced");
    } else if (type === "PLTE") plte = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  assert.equal(bitDepth, 8, path.basename(file) + " bit depth");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0;
  assert.ok(channels, path.basename(file) + " must be RGB, RGBA, or indexed color");
  if (colorType === 3) assert.ok(plte && plte.length >= 3, path.basename(file) + " indexed palette");
  const packed = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const raw = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0, si = 0; y < height; y++) {
    const filter = packed[si++], ro = y * stride, prev = ro - stride;
    for (let x = 0; x < stride; x++, si++) {
      const a = x >= channels ? raw[ro + x - channels] : 0;
      const b = y ? raw[prev + x] : 0;
      const c = y && x >= channels ? raw[prev + x - channels] : 0;
      const f = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b :
        filter === 3 ? ((a + b) >> 1) : filter === 4 ? paeth(a, b, c) : NaN;
      assert.ok(Number.isFinite(f), path.basename(file) + " PNG filter " + filter);
      raw[ro + x] = (packed[si] + f) & 255;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < raw.length; i += channels, j += 4) {
    if (colorType === 3) {
      const pi = raw[i], po = pi * 3;
      rgba[j] = plte[po]; rgba[j + 1] = plte[po + 1]; rgba[j + 2] = plte[po + 2];
      rgba[j + 3] = trns && pi < trns.length ? trns[pi] : 255;
    } else {
      rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2];
      rgba[j + 3] = channels === 4 ? raw[i + 3] : 255;
    }
  }
  return { width, height, data: rgba };
}

const rgbKey = (r, g, b) => (r << 16) | (g << 8) | b;
const defaultKeys = new Set(materialMap.default_row.map((c) => rgbKey(c[0], c[1], c[2])));
function paletteStats(file) {
  const png = readPng(file);
  let opaque = 0, palette = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (!png.data[i + 3]) continue;
    opaque++;
    if (defaultKeys.has(rgbKey(png.data[i], png.data[i + 1], png.data[i + 2]))) {
      palette++;
    }
  }
  return { ...png, opaque, palette };
}

// Return a real source pixel for which this material row differs from row 0. That makes the
// pre-fix failure explicit: blitting the source sheet unchanged produces `source`, but native's
// material palette requires `expected`.
function changingPaletteSample(stats, palRow) {
  for (let off = 0; off < stats.data.length; off += 4) {
    if (!stats.data[off + 3]) continue;
    const source = [...stats.data.slice(off, off + 4)];
    // Native's duplicate-swatch differential below establishes FIRST-match precedence.
    const wantIndex = materialMap.default_row.findIndex((c) =>
      c[0] === source[0] && c[1] === source[1] && c[2] === source[2]);
    if (wantIndex < 0) continue;
    const expected = materialMap.palette.rows[palRow][wantIndex];
    if (source[0] !== expected[0] || source[1] !== expected[1] || source[2] !== expected[2]) {
      return { source, expected };
    }
  }
  return null;
}

// TEST THE PRECEDENCE AGAINST NATIVE DF, NOT AGAINST EITHER RENDERER. Default indices 0 and 9
// have identical source RGB but different targets in most material rows. TINT-fort2-NATIVE is a
// committed native-window capture; its Masons workshop is the 120x120 crop at (334,761), scaled
// from the real installed 3x3 workshops.png cells. Score only unobscured base pixels whose source
// RGB names exactly one palette index: AQUA wins with 1,532 exact pixels and every other row gets
// zero. Then inspect the unobscured duplicate-source pixels: native contains 12 exact AQUA index-0
// targets and zero index-9 targets. A last-binding implementation therefore fails this evidence.
const duplicateRgb = materialMap.default_row[0];
assert.deepEqual(materialMap.default_row[9], duplicateRgb, "default palette indices 0 and 9 duplicate RGB");
const nativeFort2 = readPng(path.join(ROOT, "evidence", "oracles", "tinting", "TINT-fort2-NATIVE.png"));
const workshopSheet = readPng(path.join(BLD_IMAGES, "workshops.png"));
const masons = buildingMap["Workshop:Masons"];
const aquaRow = materialMap.palette.byname.AQUA;
assert.ok(masons && masons.w === 3 && masons.h === 3 && masons.cells && masons.overlay,
  "generated Masons base/overlay cells are available for native alignment");
const nativeRgbAt = (png, x, y) => {
  const off = (y * png.width + x) * 4;
  return [png.data[off], png.data[off + 1], png.data[off + 2], png.data[off + 3]];
};
const paletteIndices = (rgb) => {
  const out = [];
  materialMap.default_row.forEach((c, i) => {
    if (c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]) out.push(i);
  });
  return out;
};
const nativeRowScores = materialMap.palette.rows.map(() => 0);
let nativeUniquePixels = 0, nativeDuplicatePixels = 0, nativeFirstHits = 0, nativeLastHits = 0;
for (let dy = 0; dy < 120; dy++) {
  const sy = Math.floor((dy + 0.5) * 96 / 120);
  const cellY = Math.floor(sy / 32), localY = sy & 31;
  for (let dx = 0; dx < 120; dx++) {
    const sx = Math.floor((dx + 0.5) * 96 / 120);
    const cellX = Math.floor(sx / 32), localX = sx & 31;
    const baseCell = masons.cells[cellY][cellX];
    const overlayCell = masons.overlay[cellY][cellX];
    const base = nativeRgbAt(workshopSheet, baseCell.col * 32 + localX, baseCell.row * 32 + localY);
    const overlay = nativeRgbAt(workshopSheet, overlayCell.col * 32 + localX, overlayCell.row * 32 + localY);
    if (base[3] !== 255 || overlay[3] !== 0) continue;
    const observed = nativeRgbAt(nativeFort2, 334 + dx, 761 + dy);
    const indices = paletteIndices(base);
    if (indices.length === 1) {
      nativeUniquePixels++;
      const sourceIndex = indices[0];
      materialMap.palette.rows.forEach((r, ri) => {
        const target = r[sourceIndex];
        if (observed[0] === target[0] && observed[1] === target[1] && observed[2] === target[2]) {
          nativeRowScores[ri]++;
        }
      });
    } else if (indices.length === 2 && indices[0] === 0 && indices[1] === 9) {
      nativeDuplicatePixels++;
      const firstTarget = materialMap.palette.rows[aquaRow][0];
      const lastTarget = materialMap.palette.rows[aquaRow][9];
      if (observed[0] === firstTarget[0] && observed[1] === firstTarget[1] && observed[2] === firstTarget[2]) nativeFirstHits++;
      if (observed[0] === lastTarget[0] && observed[1] === lastTarget[1] && observed[2] === lastTarget[2]) nativeLastHits++;
    }
  }
}
const nativeBestScore = Math.max(...nativeRowScores);
const nativeBestRow = nativeRowScores.indexOf(nativeBestScore);
assert.equal(nativeUniquePixels, 9705, "native Masons crop exposes 9,705 unambiguous source-mask pixels");
assert.equal(nativeBestRow, aquaRow, "native Masons crop independently selects AQUA row");
assert.equal(nativeBestScore, 1532, "native Masons crop has 1,532 unambiguous AQUA target pixels");
assert.equal(nativeDuplicatePixels, 663, "native Masons crop exposes 663 duplicate-source pixels");
assert.equal(nativeFirstHits, 12, "native duplicate-source pixels include exact index-0 targets");
assert.equal(nativeLastHits, 0, "last-match hypothesis has zero exact index-9 targets in native crop");

const T = loadTiles();
T._setMaterialMapForTest(materialMap);
const GL = loadGL();
const G = GL.createSceneBuilder({ materialMap });
for (const [renderer, remap] of [
  ["canvas", T._paletteRemapForTest(aquaRow)],
  ["GL", G._paletteRemapForTest(aquaRow)],
]) {
  const px = new Uint8ClampedArray([...duplicateRgb, 255]);
  remap(px, 1, 1);
  assert.deepEqual([...px.slice(0, 3)], materialMap.palette.rows[aquaRow][0],
    renderer + " follows native first-match precedence for duplicate default swatch");
}
const row = (id) => {
  const m = byId.get(id);
  assert.ok(m && typeof m.row === "number", "material row for " + id);
  return m.row;
};
const tile = (id, mat, shape = "WALL", ttname = mat + "Wall") => {
  const m = byId.get(id);
  return { tt: 1, ttname, shape, mat, base_mt: 0, base_mi: m.index, x: 13, y: 17 };
};

// Failing-first policy matrix. Before B273 only layer-stone + inorganic construction walls
// carried a row; soil/mineral walls, terrain boulders, engraved floors, real wood, and buildings
// were flat/default or approximate RGB multiplies.
for (const [name, t] of [
  ["layer wall", tile("SILTSTONE", "STONE")],
  ["soil wall", tile("CLAY", "SOIL")],
  ["mineral wall", tile("HEMATITE", "MINERAL")],
]) {
  const want = row(name === "layer wall" ? "SILTSTONE" : name === "soil wall" ? "CLAY" : "HEMATITE");
  assert.equal(T._wallJoinPalRowForTest(t), want, name + " canvas palette row");
  assert.equal(G._wallJoinPalRowForTest(t), want, name + " GL palette row");
}

const boulder = tile("MICROCLINE", "STONE", "BOULDER", "StoneBoulder");
assert.equal(T._terrainSpritePalRowForTest(boulder, "BOULDER"), row("MICROCLINE"), "terrain boulder canvas row");
assert.equal(G._terrainSpritePalRowForTest(boulder, "BOULDER"), row("MICROCLINE"), "terrain boulder GL row");
for (const [name, t, token, want] of [
  ["pebble floor", tile("CONGLOMERATE", "STONE", "PEBBLES", "StonePebbles2"), "PEBBLES_FLOOR_5B", row("CONGLOMERATE")],
  ["natural fortification", tile("DOLOMITE", "STONE", "FORTIFICATION", "StoneFortification"), "FORTIFICATION", row("DOLOMITE")],
]) {
  assert.equal(T._terrainSpritePalRowForTest(t, token), want, name + " canvas row");
  assert.equal(G._terrainSpritePalRowForTest(t, token), want, name + " GL row");
}

const engraved = tile("DOLOMITE", "STONE", "FLOOR", "StoneFloorSmooth");
for (const [name, plan] of [
  ["canvas", T._engravingFloorPlanForTest(engraved)],
  ["GL", G._engravingFloorPlanForTest(engraved)],
]) {
  assert.equal(plan.token, "FLOOR_STONE_ENGRAVED_PALETTE", name + " engraved floor uses tintable art");
  assert.equal(plan.palRow, row("DOLOMITE"), name + " engraved floor material row");
}

const woodId = "PINE"; // deliberately not the old generic wood-brown row 6
const woodIndex = materialMap.plant_ids.indexOf(woodId);
const woodRow = materialMap.plant[woodId].WOOD;
assert.ok(woodIndex >= 0 && typeof woodRow === "number" && woodRow !== 6, woodId + " distinct wood material row");
for (const [name, plan] of [
  ["canvas floor", T._constructionFloorPlanForTest("ConstructedFloor", 419, woodIndex, 0)],
  ["GL floor", G._constructionFloorPlanForTest("ConstructedFloor", 419, woodIndex, 0)],
  ["canvas stair", T._constructionFloorPlanForTest("ConstructedStairU", 419, woodIndex, 0)],
  ["GL stair", G._constructionFloorPlanForTest("ConstructedStairU", 419, woodIndex, 0)],
  ["canvas fortification", T._constructionFloorPlanForTest("ConstructedFortification", 419, woodIndex, 0)],
  ["GL fortification", G._constructionFloorPlanForTest("ConstructedFortification", 419, woodIndex, 0)],
]) assert.equal(plan.palRow, woodRow, name + " uses actual " + woodId + " row");
const woodWall = { tt: 1, ttname: "ConstructedWall", shape: "WALL", mat: "CONSTRUCTION", base_mt: 419, base_mi: woodIndex };
assert.equal(T._wallJoinPalRowForTest(woodWall), woodRow, "constructed " + woodId + " wall canvas row");
assert.equal(G._wallJoinPalRowForTest(woodWall), woodRow, "constructed " + woodId + " wall GL row");

const building = { cpal: "PALE_PINK", crgb: [255, 182, 193], rgb: [0, 255, 255] };
assert.equal(T._pickBuildingPalRowForTest(building), materialMap.palette.byname.PALE_PINK, "furniture/workshop canvas component row");
assert.equal(GL.pickBuildingPalRow(building, materialMap), materialMap.palette.byname.PALE_PINK, "furniture/workshop GL component row");
assert.equal(T._pickBuildingPalRowForTest({ cpal: "NO_SUCH_COLOR", crgb: [1, 2, 3] }), null, "unknown component palette degrades to RGB fallback");

// Actual installed sprite pixels: palette art changes by exact index substitution, while authored
// pre-colored floor pixels survive byte-for-byte. These are source PNG pixels, not synthetic RGBA.
const samples = [
  ["layer wall", path.join(ENV_IMAGES, "wall_stone.png"), row("SILTSTONE")],
  ["soil wall", path.join(ENV_IMAGES, "wall_soil.png"), row("CLAY")],
  ["mineral wall", path.join(ENV_IMAGES, "wall_ore_vein.png"), row("HEMATITE")],
  ["terrain boulder", path.join(ENV_IMAGES, "terrain_boulders.png"), row("MICROCLINE")],
  ["pebble floor", path.join(ENV_IMAGES, "floor_pebbles.png"), row("CONGLOMERATE")],
  ["engraved floor", path.join(ENV_IMAGES, "floor_stone_engraved_palette.png"), row("DOLOMITE")],
  ["wood construction", path.join(ENV_IMAGES, "wooden_floor.png"), woodRow],
  ["fortification", path.join(ENV_IMAGES, "fortification.png"), row("DOLOMITE")],
  ["workshop/furniture", path.join(BLD_IMAGES, "workshops.png"), materialMap.palette.byname.PALE_PINK],
];
for (const [name, file, palRow] of samples) {
  const s = paletteStats(file);
  assert.ok(s.palette > 0, name + " must contain real default-palette pixels");
  const sample = changingPaletteSample(s, palRow);
  assert.ok(sample, name + " must have a source pixel that its material row changes");
  assert.notDeepEqual(sample.source.slice(0, 3), sample.expected,
    name + " pre-fix unchanged source pixel is the wrong material color");
  for (const [renderer, remap] of [["canvas", T._paletteRemapForTest(palRow)], ["GL", G._paletteRemapForTest(palRow)]]) {
    const px = new Uint8ClampedArray(sample.source);
    remap(px, 1, 1);
    assert.deepEqual([...px.slice(0, 3)], sample.expected, renderer + " remaps actual " + name + " pixel");
  }
}

const fixedFloor = paletteStats(path.join(ENV_IMAGES, "floors.png"));
assert.equal(fixedFloor.palette, 0, "natural floor art is pre-colored, not a palette mask");
const before = fixedFloor.data.slice(0);
T._paletteRemapForTest(row("SILTSTONE"))(fixedFloor.data, fixedFloor.width, fixedFloor.height);
assert.deepEqual(fixedFloor.data, before, "exact substitution leaves every pre-colored floor pixel unchanged");

// B281: a natural wall is two independent installed assets composited in order. The exposed
// rock FACE comes from wall_stone.png and contains transparent pixels; Native leaves the opaque,
// non-palette hidden_rock.png texture dark beneath those holes. The regression was coloring that
// backing from the wall's STATE_COLOR row, creating a one-tile material-colored halo around the
// fort. Prove the boundary with real pixels, then require both renderers to choose the same dark
// backing token without changing the already-correct face row. B282 tightens the compositing
// boundary: an open-face mask of zero has NO wall-face token at all, so painting an opaque
// hidden-rock cell there exposes the entire 32x32 backing as the reported dark rectangle.
const wallSheet = readPng(path.join(ENV_IMAGES, "wall_stone.png"));
const hiddenSheet = paletteStats(path.join(ENV_IMAGES, "hidden_rock.png"));
const environmentGraphicsRaw = fs.readFileSync(ENV_GRAPHICS_RAW, "latin1");
const stoneWallTokens = [...environmentGraphicsRaw.matchAll(
  /\[TILE_GRAPHICS:WALL_STONE:\d+:\d+:(STONE_WALL_[^\]]+)\]/g)].map((m) => m[1]);
assert.equal(stoneWallTokens.length, 40, "installed rough-stone wall sheet has 40 directional face cells");
assert.ok(stoneWallTokens.every((token) => /^STONE_WALL_(?:N|S|W|E)/.test(token)),
  "installed wall art has no directionless face for a fully buried wall");
assert.equal(hiddenSheet.opaque, hiddenSheet.width * hiddenSheet.height,
  "installed hidden-rock backing is fully opaque");
assert.equal(hiddenSheet.palette, 0, "installed hidden-rock backing has no default-palette pixels");
const wallCell = { col: 0, row: 7 }; // graphics_tiles.txt: STONE_WALL_N_S_W_E_1
let transparentLocal = null, faceLocal = null;
let wallCellOpaque = 0, wallCellPalette = 0;
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  const off = (((wallCell.row * 32 + y) * wallSheet.width) + wallCell.col * 32 + x) * 4;
  const px = [...wallSheet.data.slice(off, off + 4)];
  if (!transparentLocal && px[3] === 0) transparentLocal = { x, y };
  if (px[3]) {
    wallCellOpaque++;
    if (defaultKeys.has(rgbKey(px[0], px[1], px[2]))) wallCellPalette++;
  }
  if (!faceLocal && px[3] === 255 && defaultKeys.has(rgbKey(px[0], px[1], px[2]))) {
    const index = materialMap.default_row.findIndex((c) =>
      c[0] === px[0] && c[1] === px[1] && c[2] === px[2]);
    const target = materialMap.palette.rows[row("SILTSTONE")][index];
    if (target[0] !== px[0] || target[1] !== px[1] || target[2] !== px[2]) faceLocal = { x, y, px, target };
  }
}
assert.ok(transparentLocal, "installed wall face exposes transparent backing pixels");
assert.ok(faceLocal, "installed wall face exposes a changing default-palette pixel");
assert.equal(wallCellOpaque, 878, "installed STONE_WALL_N_S_W_E_1 has 878 opaque face pixels");
assert.equal(wallCellPalette, wallCellOpaque, "every opaque wall-face pixel belongs to the default palette");

// B282's load-bearing installed-art composite. The browser cell mounts these same real pages;
// this zero-DOM proof also runs in the ordinary Node sweep and carries its own failing-first
// mutation. The fixture is a 2x2 wall cluster inside tt<0 undiscovered rock, with mined floor to
// the south. Correct adjacency emits only the two open S faces. Restoring the old `tt<0 => open`
// predicate emits bright N/W/E material art into the hidden-facing bands.
function loadAdjacency(source) {
  const box = {}; box.self = box;
  vm.createContext(box);
  vm.runInContext(source, box, { filename: "dwf-adjacency.js" });
  return box.DwfAdjacency;
}
const adjacencySource = fs.readFileSync(path.join(ROOT, "web", "js", "dwf-adjacency.js"), "utf8");
const adjacency = loadAdjacency(adjacencySource);
const mutantAdjacencySource = adjacencySource.replace(
  '    return typeof t.tt !== "number" || t.tt >= 0;',
  '    return true; // B282 TEST MUTATION: tt<0 falsely counts as open');
assert.notEqual(mutantAdjacencySource, adjacencySource, "B282 mutation anchor must exist");
const mutantAdjacency = loadAdjacency(mutantAdjacencySource);

const wallCells = new Map([...environmentGraphicsRaw.matchAll(
  /\[TILE_GRAPHICS:WALL_STONE:(\d+):(\d+):(STONE_WALL_[^\]]+)\]/g)]
  .map((m) => [m[3], { col: Number(m[1]), row: Number(m[2]) }]));
const siltstone = tile("SILTSTONE", "STONE");
const wallFixture = new Map();
const fixturePut = (x, y, value) => wallFixture.set(`${x},${y}`, { ...value, x, y, z: 100 });
for (let y = 17; y <= 20; y++) for (let x = 29; x <= 32; x++) fixturePut(x, y, { tt: -1 });
for (let y = 18; y <= 19; y++) for (let x = 30; x <= 31; x++) fixturePut(x, y, siltstone);
for (let x = 30; x <= 31; x++) fixturePut(x, 20, { tt: 2, shape: "FLOOR" });
const fixtureAt = (x, y) => wallFixture.get(`${x},${y}`) || null;
const hashXY = (x, y) => ((x * 374761393 + y * 668265263) ^ (x >> 3)) >>> 0;
const faceCell = (adj, x, y) => {
  const openMask = adj.computeMask8(fixtureAt, x, y, adj.isOpenNeighbor);
  const suffix = adj.wallCellSuffix(openMask);
  if (!suffix) return { openMask, token: null, data: null };
  const base = `STONE_WALL_${suffix}`, variant = (hashXY(x, y) & 3) + 1;
  const token = [`${base}_${variant}`, `${base}_1`, base].find((candidate) => wallCells.has(candidate));
  assert.ok(token, `installed wall sheet resolves ${base}`);
  const cell = wallCells.get(token), data = new Uint8ClampedArray(32 * 32 * 4);
  for (let py = 0; py < 32; py++) {
    const source = (((cell.row * 32 + py) * wallSheet.width) + cell.col * 32) * 4;
    data.set(wallSheet.data.subarray(source, source + 32 * 4), py * 32 * 4);
  }
  T._paletteRemapForTest(row("SILTSTONE"))(data, 32, 32);
  return { openMask, token, data };
};
const brightIn = (face, x0, y0, x1, y1) => {
  if (!face.data) return 0;
  let bright = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const off = (y * 32 + x) * 4;
    if (face.data[off + 3] && Math.max(face.data[off], face.data[off + 1], face.data[off + 2]) > 76) bright++;
  }
  return bright;
};
function wallFixtureComposite(adj) {
  const nw = faceCell(adj, 30, 18), ne = faceCell(adj, 31, 18);
  const sw = faceCell(adj, 30, 19), se = faceCell(adj, 31, 19);
  const hiddenFacing = brightIn(nw, 0, 0, 32, 13) + brightIn(ne, 0, 0, 32, 13) +
    brightIn(nw, 0, 0, 13, 32) + brightIn(sw, 0, 0, 13, 13) +
    brightIn(ne, 19, 0, 32, 32) + brightIn(se, 19, 0, 32, 13);
  const openFacing = brightIn(sw, 0, 20, 32, 32) + brightIn(se, 0, 20, 32, 32);
  return { hiddenFacing, openFacing, masks: [nw, ne, sw, se].map((face) => face.openMask),
    tokens: [nw, ne, sw, se].map((face) => face.token) };
}
const fixedWallComposite = wallFixtureComposite(adjacency);
const mutantWallComposite = wallFixtureComposite(mutantAdjacency);
assert.equal(fixedWallComposite.hiddenFacing, 0,
  "B282 fixed installed-art composite has no bright hidden-facing halo pixels");
assert.ok(fixedWallComposite.openFacing > 0,
  "B282 fixed installed-art composite preserves bright open-south wall faces");
assert.ok(mutantWallComposite.hiddenFacing > 0,
  "B282 failing-first control: restoring tt<0 => open makes the real-art hidden bands bright");
console.log(`  B282 installed-art composite: hidden ${mutantWallComposite.hiddenFacing}->${fixedWallComposite.hiddenFacing}, ` +
  `open ${fixedWallComposite.openFacing}; mutant masks=${mutantWallComposite.masks.join(",")}`);

for (const [renderer, api] of [["canvas", T], ["GL", G]]) {
  assert.equal(typeof api._wallBackingTokenForTest, "function", renderer + " exposes natural-wall backing policy");
  assert.equal(api._wallBackingTokenForTest(siltstone, 13, 17, 0), null,
    renderer + " fully buried wall with no face cannot expose a full-cell hidden-rock box");
  const token = api._wallBackingTokenForTest(siltstone, 13, 17, 15);
  const match = /^HIDDEN_ROCK_([1-5])$/.exec(token || "");
  assert.ok(match, renderer + " natural wall uses an installed hidden-rock backing variant");
  assert.equal(api._wallJoinPalRowForTest(siltstone), row("SILTSTONE"),
    renderer + " natural wall face still uses its material palette row");

  const hiddenCol = Number(match[1]) - 1;
  const hiddenOff = ((transparentLocal.y * hiddenSheet.width) + hiddenCol * 32 + transparentLocal.x) * 4;
  const backing = [...hiddenSheet.data.slice(hiddenOff, hiddenOff + 4)];
  assert.equal(backing[3], 255, renderer + " transparent wall pixel resolves to opaque backing");
  assert.ok(Math.max(backing[0], backing[1], backing[2]) <= 64,
    renderer + " transparent wall pixel stays dark, got " + backing.slice(0, 3));

  const remappedFace = new Uint8ClampedArray(faceLocal.px);
  api._paletteRemapForTest(row("SILTSTONE"))(remappedFace, 1, 1);
  assert.deepEqual([...remappedFace.slice(0, 3)], faceLocal.target,
    renderer + " opaque rock-face pixel keeps exact STATE_COLOR substitution");
  assert.notDeepEqual(backing.slice(0, 3), faceLocal.target,
    renderer + " backing is not contaminated by the face palette row");
}

// The paired evidence itself: count only colors unique to one palette row. Native contains far
// more material ramps than the flat browser shots; this guards the visual symptom independently
// of any particular stone name or screen coordinate.
const colorOwners = new Map();
materialMap.palette.rows.forEach((r, ri) => r.forEach((c) => {
  const k = rgbKey(c[0], c[1], c[2]);
  if (!colorOwners.has(k)) colorOwners.set(k, []);
  colorOwners.get(k).push(ri);
}));
const uniqueByRow = materialMap.palette.rows.map((r) => r
  .map((c) => rgbKey(c[0], c[1], c[2])).filter((k) => colorOwners.get(k).length === 1));
function materialRowsInShot(file, minimumPixels = 10) {
  const counts = new Map();
  const d = readPng(file).data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const k = rgbKey(d[i], d[i + 1], d[i + 2]);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return uniqueByRow.filter((keys) => keys.reduce((n, k) => n + (counts.get(k) || 0), 0) >= minimumPixels).length;
}
for (const fort of [1, 2]) {
  const dir = path.join(ROOT, "evidence", "oracles", "tinting");
  const nativeRows = materialRowsInShot(path.join(dir, `TINT-fort${fort}-NATIVE.png`));
  const oursRows = materialRowsInShot(path.join(dir, `TINT-fort${fort}-OURS.png`));
  assert.ok(nativeRows > oursRows, `fort${fort} native material-row diversity ${nativeRows} > ours ${oursRows}`);
  console.log(`  oracle fort${fort}: native ${nativeRows} material rows, ours ${oursRows} (>=10 unique-row pixels)`);
}

// The server must preserve the canonical descriptor token, not just flatten it to one RGB.
const worldStream = fs.readFileSync(path.join(ROOT, "src", "world_stream.cpp"), "utf8");
assert.match(worldStream, /\\"cpal\\"/, "AUX building record carries component STATE_COLOR token");
assert.match(worldStream, /state_color\[df::matter_state::Solid\]/, "server color source is material solid STATE_COLOR");

console.log("PASS B273: native first-match precedence; systemic palette rows in both renderers; actual PNG substitution; pre-colored floors untouched");
