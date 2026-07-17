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

// B92 acceptance: dense grass on the FULL detailed-stone *Pebbles family (Stone/Mineral/
// Lava/Feature) composites grass-over-pebble in BOTH renderers, not the bare PEBBLES_FLOOR_5
// gray gravel cell. Root cause: the grass-under whitelist matched only StonePebbles while the
// server (wire_v1.cpp) sends a grass tail for EVERY outside FLOOR with grass_amt>0, so grass
// growing over the three mechanically-identical sibling pebble floors fell through to bare
// gravel (friend: "dense zoysia / dense satintail ... show up as pebbles"). zoysia/satintail
// are ordinary vanilla grasses (data/vanilla .../plant_grasses.txt) that render on the standard
// grass.png cells -- the species never changes the art, only the underlying floor tiletype does.
//
// Run: node tools/harness/grass_under_pebbles_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const tilesSource = fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8");

let failed = 0;
function check(name, fn) { try { fn(); console.log("PASS " + name); } catch (e) { failed++; console.error("FAIL " + name + ": " + (e.stack || e)); } }

// The four detailed-stone floor prefixes that DF renders as pebble rubble (tiletype_token_map.json
// maps every StonePebbles/MineralPebbles/LavaPebbles/FeaturePebbles variant to PEBBLES_FLOOR_5 when
// bare). Each has a 1..4 variant digit that keys the SPARSE overlay cell (PEBBLES_FLOOR_1..4).
const PEBBLE_PREFIXES = ["Stone", "Mineral", "Lava", "Feature"];

// A mock sprite map: PEBBLES_FLOOR_1..5 + STONE_FLOOR_5 on floors.png (arbitrary but stable cells).
// GRASS_1..4 come from the renderers' own TOKEN_CELL_OVERRIDE (grass.png), not this map.
const SPRITE_MAP = {
  PEBBLES_FLOOR_1: { sheet: "floors.png", col: 0, row: 4 },
  PEBBLES_FLOOR_2: { sheet: "floors.png", col: 1, row: 4 },
  PEBBLES_FLOOR_3: { sheet: "floors.png", col: 2, row: 4 },
  PEBBLES_FLOOR_4: { sheet: "floors.png", col: 3, row: 4 },
  PEBBLES_FLOOR_5: { sheet: "floors.png", col: 4, row: 4 },
  STONE_FLOOR_5:   { sheet: "floors.png", col: 5, row: 4 },
};
// tiletype -> token, for the bare (no-tail) fall-through path.
const TOKEN_MAP = {};
for (const p of PEBBLE_PREFIXES) for (let v = 1; v <= 4; v++) TOKEN_MAP[p + "Pebbles" + v] = { token: "PEBBLES_FLOOR_5" };
TOKEN_MAP.StoneFloor1 = { token: "STONE_FLOOR_5" }; // rough stone floor (NOT a pebble family member)

function tile(o = {}) {
  return Object.assign({ tt: 1, ttname: "StonePebbles1", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
}

// ---------------------------------------------------------------------------
// GL renderer (loaded in its own VM context, mock atlas that assigns a stable id per cell).
// ---------------------------------------------------------------------------
const glbox = { self: null, performance: { now: () => 0 } }; glbox.self = glbox;
vm.createContext(glbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glbox, { filename: f });
const GL = glbox.DwfGL;
assert.ok(GL, "GL export loads");

function makeAtlas() {
  const ids = new Map(); let next = 1;
  return {
    resolve(sheet, col, row) { const key = sheet + "|" + col + "|" + row; if (!ids.has(key)) ids.set(key, next++); return ids.get(key); },
    resolvePalette(sheet, col, row) { return this.resolve(sheet, col, row); },
    setSheetGeometry() {},
  };
}
function glBuilder() {
  const atlas = makeAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: SPRITE_MAP, tokenMap: TOKEN_MAP });
  return { atlas, b };
}
// hashXY must match the renderer's variant pick so we can predict the grass base cell.
function hashXY(x, y) { return ((x * 374761393 + y * 668265263) ^ (x >> 3)) >>> 0; }

const GX = 3, GY = 5; // fixed sample coord (any; the pick is deterministic in hashXY)

check("B92 GL: every *Pebbles[1-4] with a grass tail composites grass + its SPARSE pebble overlay", () => {
  for (const prefix of PEBBLE_PREFIXES) {
    for (let v = 1; v <= 4; v++) {
      const { atlas, b } = glBuilder();
      const ttname = prefix + "Pebbles" + v;
      const t = tile({ ttname, mat: "STONE", grass: { id: "ZOYSIA", amount: 200 } });
      const s = b._resolveSprite(t, GX, GY);
      const grassCell = atlas.resolve("grass.png", hashXY(GX, GY) % 4, 0);
      const pebbleCell = atlas.resolve("floors.png", SPRITE_MAP["PEBBLES_FLOOR_" + v].col, 4);
      const bareGravel = atlas.resolve("floors.png", SPRITE_MAP.PEBBLES_FLOOR_5.col, 4);
      assert.ok(s, ttname + " resolved");
      assert.equal(s.cell, grassCell, ttname + " base is the grass.png cell, not bare gravel");
      assert.notEqual(s.cell, bareGravel, ttname + " base must NOT be the opaque PEBBLES_FLOOR_5 gravel");
      assert.equal(s.tintName, "grassSummer", ttname + " carries the summer grass wash");
      assert.equal(s.overlay, pebbleCell, ttname + " overlays the matching SPARSE PEBBLES_FLOOR_" + v);
    }
  }
});

check("B92 GL: SoilFloor keeps PLAIN grass (no pebble overlay)", () => {
  const { atlas, b } = glBuilder();
  const t = tile({ ttname: "SoilFloor2", mat: "SOIL", grass: { id: "ZOYSIA", amount: 120 } });
  const s = b._resolveSprite(t, GX, GY);
  assert.ok(s);
  assert.equal(s.cell, atlas.resolve("grass.png", hashXY(GX, GY) % 4, 0));
  assert.equal(s.tintName, "grassSummer");
  assert.equal(s.overlay, 0, "soil floors composite plain grass, no sparse pebble cell");
});

// B241 SUPERSEDES the old B37 arm here (07-14, eyeball: "limestone pebbles are not
// rendering at all"): a *Pebbles tile with NO positive grass tail draws its OWN dense
// pebble-floor art via the token map -- never a borrowed grass composite. The old B37
// checks pinned the opposite (grass base on tail-less exterior pebbles), which made every
// outside pebble floor render as plain lawn, because the wire never ships grass tails for
// PEBBLES-shape tiles at all (wire_v1.cpp gates on shape==FLOOR).
check("B241 GL: outside *Pebbles without a grass tail draws its OWN dense pebble art", () => {
  const { atlas, b } = glBuilder();
  const t = tile({ ttname: "MineralPebbles3", mat: "STONE" }); // no .grass
  const s = b._resolveSprite(t, GX, GY);
  const denseGravel = atlas.resolve("floors.png", SPRITE_MAP.PEBBLES_FLOOR_5.col, 4);
  const grassCell = atlas.resolve("grass.png", hashXY(GX, GY) % 4, 0);
  assert.ok(s, "tail-less pebble floor still resolves to real art");
  assert.equal(s.cell, denseGravel, "base is the dense pebble cell from the token map");
  assert.notEqual(s.cell, grassCell, "no invented grass on a tile the wire reports no grass for");
  assert.ok(!s.tintName, "dense pebble art carries no grass wash");
});

check("B241 GL: exterior *Pebbles with a worn-bare (amount=0) tail also keeps its dense art", () => {
  const { atlas, b } = glBuilder();
  const s = b._resolveSprite(tile({ ttname: "StonePebbles1", grass: { id: "ZOYSIA", amount: 0 } }), GX, GY);
  assert.ok(s, "worn-bare pebble floor still resolves (the flat-color null is grass-mat-only)");
  assert.equal(s.cell, atlas.resolve("floors.png", SPRITE_MAP.PEBBLES_FLOOR_5.col, 4),
    "amount=0 on a non-grass tile means 'no grass here', not 'suppress the floor art'");
});

check("B92 GL test-the-test: the fix is NOT over-broad -- a rough StoneFloor with a tail stays stone", () => {
  const { atlas, b } = glBuilder();
  const s = b._resolveSprite(tile({ ttname: "StoneFloor1", mat: "STONE", grass: { id: "ZOYSIA", amount: 200 } }), GX, GY);
  const stoneCell = atlas.resolve("floors.png", SPRITE_MAP.STONE_FLOOR_5.col, 4);
  const grassCell = atlas.resolve("grass.png", hashXY(GX, GY) % 4, 0);
  assert.ok(s);
  assert.equal(s.cell, stoneCell, "StoneFloor is not in the pebble family -> keeps its own art");
  assert.notEqual(s.cell, grassCell, "grass-under must only fire for the whitelisted floor families");
});

// ---------------------------------------------------------------------------
// Canvas2d (tiles) renderer -- loaded in this context with an auto-loading Image mock so the
// grass.png / floors.png sheets report `loaded` and grassFallbackCell()/resolveCell() return cells.
// ---------------------------------------------------------------------------
class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
}
const store = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {}, getContext() { return { createImageData: () => ({ data: [] }), putImageData() {} }; } }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.sessionStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
// Auto-onload Image: getSheet() assigns .onload BEFORE setting .src, so firing synchronously in the
// src setter marks the sheet `loaded` (headless has no real network/decoder).
globalThis.Image = class { constructor() { this.onload = null; this.onerror = null; this._src = ""; } set src(v) { this._src = v; if (this.onload) this.onload(); } get src() { return this._src; } };
globalThis.fetch = async () => ({ ok: false, json: async () => null });
vm.runInThisContext(tilesSource, { filename: "web/js/dwf-tiles.js" });
const Tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });
Tiles._setSpriteMapForTest(SPRITE_MAP);
assert.equal(typeof Tiles._resolveSpriteForTest, "function", "canvas resolveSprite hook loads");

check("B92 canvas2d: every *Pebbles[1-4] with a grass tail composites grass + its SPARSE pebble overlay", () => {
  for (const prefix of PEBBLE_PREFIXES) {
    for (let v = 1; v <= 4; v++) {
      const ttname = prefix + "Pebbles" + v;
      const s = Tiles._resolveSpriteForTest(tile({ ttname, mat: "STONE", grass: { id: "SATINTAIL", amount: 200 } }), GX, GY);
      assert.ok(s && s.img, ttname + " resolved to a grass cell");
      assert.equal(s.tint, "grassSummer", ttname + " carries the summer grass wash");
      assert.ok(s.overlay && s.overlay.img, ttname + " has a sparse pebble overlay cell");
      assert.equal(s.overlay.col, SPRITE_MAP["PEBBLES_FLOOR_" + v].col, ttname + " overlay is PEBBLES_FLOOR_" + v);
      // The grass base is grass.png col hashXY%4; the bare gravel would have been floors.png PEBBLES_FLOOR_5.
      assert.equal(s.col, hashXY(GX, GY) % 4, ttname + " base is a grass.png variant cell");
    }
  }
});

check("B92 canvas2d: SoilFloor keeps PLAIN grass (no pebble overlay)", () => {
  const s = Tiles._resolveSpriteForTest(tile({ ttname: "SoilFloor3", mat: "SOIL", grass: { id: "ZOYSIA", amount: 120 } }), GX, GY);
  assert.ok(s && s.img);
  assert.equal(s.tint, "grassSummer");
  assert.ok(!s.overlay, "soil floors composite plain grass, no sparse pebble cell");
});

check("B241 canvas2d: exterior *Pebbles without positive grass draws its OWN dense pebble art", () => {
  // B241 supersedes the old B37 pin (see the GL section's banner): tail-less / worn-bare
  // pebbles route through the token map to the dense cell, never to borrowed grass.
  Tiles._setTiletypeTokenMapForTest(TOKEN_MAP);
  const bare = Tiles._resolveSpriteForTest(tile({ ttname: "MineralPebbles2" }), GX, GY);
  assert.ok(bare && bare.img, "tail-less pebble floor resolves to real art");
  assert.equal(bare.col, SPRITE_MAP.PEBBLES_FLOOR_5.col, "base is the dense pebble cell (token map)");
  assert.ok(!bare.tint, "no grass wash on the dense pebble art");
  const worn = Tiles._resolveSpriteForTest(tile({ ttname: "MineralPebbles2", grass: { id: "ZOYSIA", amount: 0 } }), GX, GY);
  assert.ok(worn && worn.img && worn.col === SPRITE_MAP.PEBBLES_FLOOR_5.col,
    "amount=0 on a non-grass tile means 'no grass here', not 'suppress the floor art'");
  Tiles._setTiletypeTokenMapForTest(null);
});

check("B92 canvas2d test-the-test: the fix is NOT over-broad -- a rough StoneFloor with a tail is not grassed", () => {
  // No tiletypeTokenMap is injected, so the grass-under arm is the ONLY thing that could return a
  // sprite here; a null result proves StoneFloor did NOT match the (broadened) grass-under regex.
  const s = Tiles._resolveSpriteForTest(tile({ ttname: "StoneFloor1", mat: "STONE", grass: { id: "ZOYSIA", amount: 200 } }), GX, GY);
  assert.equal(s, null, "StoneFloor is outside the pebble family -> grass-under must not fire");
});

// Source guard: both renderers must carry the identical broadened whitelist (parity is the wave's point).
check("B92 parity: both renderers share the broadened *Pebbles grass-under whitelist", () => {
  const re = "(?:Stone|Mineral|Lava|Feature)Pebbles";
  assert.ok(tilesSource.includes(re), "canvas2d source carries the broadened pebble-family regex");
  const glSource = fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8");
  assert.ok(glSource.includes(re), "GL source carries the broadened pebble-family regex");
});

if (failed) { console.error("\n" + failed + " B92 grass-under section(s) FAILED"); process.exit(1); }
console.log("\nALL B92 grass-under-pebbles checks PASSED");
