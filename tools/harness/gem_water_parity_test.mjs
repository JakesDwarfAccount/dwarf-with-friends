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

// gem_water_parity_test.mjs -- targeted regression tests for the 2026-07-09
// small-gem sheet geometry and liquid-edge renderer parity fixes.
// Run: node tools/harness/gem_water_parity_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const realItemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const realMaterialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));

function eqCell(a, b) { return !!a && !!b && a.sheet === b.sheet && a.col === b.col && a.row === b.row; }
function fail(msg) { throw new Error(msg); }

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}

// ---- load GL + adjacency in a pure sandbox ----------------------------------------------
const glbox = {}; glbox.self = glbox; glbox.performance = { now: () => 0 };
vm.createContext(glbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glbox, { filename: f });
}
const GL = glbox.DwfGL;
const Adj = glbox.DwfAdjacency;
assert.ok(GL && Adj, "GL and adjacency exports must load");

// ---- boot canvas2d in a DOM-less host ----------------------------------------------------
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() {
    return new Proxy({}, {
      get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; },
      set(t, p, v) { t[p] = v; return true; },
    });
  }
}
const store = {};
globalThis.window = globalThis;
globalThis.DwfAdjacency = Adj;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = {
  hidden: false,
  addEventListener() {},
  getElementById() { return null; },
  createElement() { return { width: 0, height: 0, style: {}, getContext() { return { imageSmoothingEnabled: true, drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(32 * 32 * 4) }; }, putImageData() {} }; } }; },
  body: { appendChild() {} },
};
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
globalThis.Image = class { constructor() { this.onload = null; this.onerror = null; this.width = 32; this.height = 32; } set src(v) {} get src() { return ""; } };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf("item_map.json") !== -1) return { ok: true, json: async () => realItemMap };
  return { ok: false, json: async () => null };
};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), { filename: "dwf-tiles.js" });
const T = globalThis.DwfTiles;
assert.ok(T, "canvas2d export must load");
T.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });
async function waitUntil(pred, maxMs) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > (maxMs || 2000)) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}
await waitUntil(() => !!T._resolveItemVisualForTest({ type: "AMMO", mat_type: -1 }), 2000);
T._setMaterialMapForTest(realMaterialMap);

check("item_map carries real smallgems geometry and keeps gem/boulder controls", () => {
  assert.equal(realItemMap._v, 3, "item_map schema stays v3/additive");
  assert.deepEqual(realItemMap.sheet_geometry["smallgems.png"], { cell_h: 16, cell_w: 16, page_h: 16, page_w: 352 });
  assert.deepEqual(realItemMap.sheet_geometry["gems.png"], { cell_h: 32, cell_w: 32, page_h: 32, page_w: 736 });
  const small = realItemMap.gem_shapes.OVAL_CABOCHON.small;
  const large = realItemMap.gem_shapes.OVAL_CABOCHON.large;
  assert.deepEqual(small, { sheet: "smallgems.png", col: 7, row: 0 }, "small gem control cell id");
  assert.deepEqual(large, { sheet: "gems.png", col: 8, row: 0 }, "large gem control cell id");
  assert.deepEqual(realItemMap.boulder_bymat.MARBLE, { sheet: "boulders.png", col: 0, row: 4 }, "rough-gem boulder control unchanged");
});

check("SMALLGEM logical sprite is identical in canvas2d and GL", () => {
  const tourmaline = realMaterialMap.inorganic.findIndex((m) => m.id === "GREEN TOURMALINE");
  if (tourmaline < 0) fail("GREEN TOURMALINE fixture missing");
  const it = { type: "SMALLGEM", mat_type: 0, mat_index: tourmaline, subtype: -1, shape: 13 };
  const c = T._resolveItemVisualForTest(it);
  const g = GL.createSceneBuilder({ itemMap: realItemMap, materialMap: realMaterialMap })._resolveItemVisualForTest(it);
  assert.equal(c.source, "material");
  assert.equal(g.source, "material");
  assert.ok(eqCell(c.entry, realItemMap.gem_shapes.OVAL_CABOCHON.small));
  assert.ok(eqCell(c.entry, g.entry), "canvas2d and GL resolve the same smallgems cell");
});

function tile(o) { return Object.assign({ flow: 0, liquid: "none" }, o || {}); }
function lookupFromGrid(grid, ox, oy) {
  return (gx, gy) => {
    const x = gx - ox, y = gy - oy;
    if (y < 0 || y >= grid.length || x < 0 || x >= grid[y].length) return null;
    return grid[y][x];
  };
}
function normTokens(a) { return Array.from(a); }
function tokensC(t, gx, gy, lookup) { return normTokens(T._liquidEdgeTokensForTest(t, gx, gy, lookup, Adj)); }
function tokensG(t, gx, gy, lookup) { return normTokens(GL.liquidEdgeTokens(t, gx, gy, lookup, Adj)); }

check("water edge tokens match GL for a fixture shore neighborhood", () => {
  const W = tile({ flow: 7, liquid: "water" });
  const L = tile({ flow: 0, liquid: "none" });
  const grid = [[L, L, L], [W, W, W], [W, W, W]];
  const lookup = lookupFromGrid(grid, 10, 20);
  const c = tokensC(W, 11, 21, lookup);
  const g = tokensG(W, 11, 21, lookup);
  assert.deepEqual(c, ["UNDERWATER_EDGE_N", "UNDERWATER_EDGE_NW", "UNDERWATER_EDGE_NE"]);
  assert.deepEqual(c, g, "canvas2d/GL water edge token parity");
});

check("magma edge tokens use the same overlay family and match GL", () => {
  const M = tile({ flow: 4, liquid: "magma" });
  const L = tile({ flow: 0, liquid: "none" });
  const grid = [[M, M, M], [L, M, M], [L, M, M]];
  const lookup = lookupFromGrid(grid, 30, 40);
  const c = tokensC(M, 31, 41, lookup);
  const g = tokensG(M, 31, 41, lookup);
  assert.deepEqual(c, ["UNDERMAGMA_EDGE_W", "UNDERMAGMA_EDGE_SW"]);
  assert.deepEqual(c, g, "canvas2d/GL magma edge token parity");
});

check("full-surrounded deep liquid emits no overlay tokens", () => {
  const W = tile({ flow: 7, liquid: "water" });
  const grid = [[W, W, W], [W, W, W], [W, W, W]];
  const lookup = lookupFromGrid(grid, 0, 0);
  assert.deepEqual(tokensC(W, 1, 1, lookup), []);
  assert.deepEqual(tokensG(W, 1, 1, lookup), []);
});

if (failed > 0) {
  console.error(failed + " section(s) FAILED");
  process.exit(1);
}
console.log("all gem_water_parity_test.mjs sections PASSED");
