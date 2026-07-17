// b27a_farmplot_test.mjs -- acceptance for B27a (farm plots invisible).
//
// ROOT CAUSE under test: texsweep emitted a null-cell FarmPlot building_map entry
// (cells:[[null]]) on the theory that a tilled-soil tiletype + the crop plant already drew the
// bed -- but farm-plot tiles carry no such tiletype, so empty plots rendered NOTHING (invisible).
// Fix: farmPlotEntry / farmPlotEntryGL resolve DF's own farm bed art from the WC-6 wire field
// b.bextra (= plant_id for the current season, 0xFFFF when fallow): FURROWED_SOIL_1..4 (fallow,
// per-tile hashed variant) or FARMPLOT_PLANTED (a crop is set).
//
// Proves, without a browser:
//   (1) a fallow plot resolves to real FURROWED_SOIL cells across its whole footprint (never a
//       null cell -- the exact regression), with per-tile variety.
//   (2) a planted plot (bextra != 0xFFFF) resolves to the FARMPLOT_PLANTED cell.
//   (3) canvas2d farmPlotEntry and GL farmPlotEntryGL return BYTE-IDENTICAL entries for the same
//       building (shared hashXY variant -> identical cell grids).
//   (4) non-FarmPlot buildings are untouched (returns null -> the normal resolver runs).
//   (5) test-the-test: the old null-cell shape (a cell === null anywhere in the footprint) FAILS
//       the "every footprint cell is a real {col,row}" assertion.
//
// Run: node tools/harness/b27a_farmplot_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// mock /sprites/map.json farm tokens (verified live against the served map this session)
const spriteMap = {
  FURROWED_SOIL_1: { sheet: "floor_furrowed_soil.png", col: 0, row: 0 },
  FURROWED_SOIL_2: { sheet: "floor_furrowed_soil.png", col: 1, row: 0 },
  FURROWED_SOIL_3: { sheet: "floor_furrowed_soil.png", col: 2, row: 0 },
  FURROWED_SOIL_4: { sheet: "floor_furrowed_soil.png", col: 3, row: 0 },
  FARMPLOT_PLANTED: { sheet: "floor_farm_planted.png", col: 0, row: 0 },
  FARMPLOT: { sheet: "floors.png", col: 6, row: 1 },
};

// ---- canvas2d (dwf-tiles.js) ---------------------------------------------------------
const boxSandbox = {
  window: {}, document: { createElement: () => ({ getContext: () => ({}) }) },
  location: { search: "", protocol: "http:", host: "localhost:8765" },
  URLSearchParams, URL, TextEncoder, TextDecoder, fetch: async () => ({ ok: false }),
  addEventListener: () => {}, setTimeout, clearTimeout, console,
};
boxSandbox.self = boxSandbox; boxSandbox.globalThis = boxSandbox;
vm.createContext(boxSandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-adjacency.js"), "utf8"), boxSandbox, { filename: "adjacency" });
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), boxSandbox, { filename: "tiles" });
const T = boxSandbox.window.DwfTiles || boxSandbox.DwfTiles;
assert.ok(T && typeof T._farmPlotEntryForTest === "function", "canvas2d _farmPlotEntryForTest must export");
T._setSpriteMapForTest(spriteMap);

// ---- GL (dwf-gl.js) ------------------------------------------------------------------
const glSandbox = {};
glSandbox.self = glSandbox;
glSandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(glSandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glSandbox, { filename: f });
}
const GL = glSandbox.DwfGL;
const mockAtlas = { resolve: () => 1 };
const builder = GL.createSceneBuilder({ atlas: mockAtlas, spriteMap, tokenMap: {}, shadowCellMap: {}, adjacency: glSandbox.DwfAdjacency });
assert.ok(typeof builder._farmPlotEntryForTest === "function", "GL _farmPlotEntryForTest must export");

let pass = 0, failed = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}
function everyCellReal(e) {
  if (!e || !Array.isArray(e.cells)) return false;
  for (const row of e.cells) for (const c of row) if (!c || typeof c.col !== "number" || typeof c.row !== "number") return false;
  return true;
}

const plot3x2 = { type: "FarmPlot", x1: 10, y1: 20, x2: 12, y2: 21 }; // 3 wide x 2 tall

// ---- (1) fallow plot: real FURROWED_SOIL cells across the whole footprint ------------------
{
  const b = { ...plot3x2, bextra: 0xFFFF };
  const e = T._farmPlotEntryForTest(b);
  check("fallow: entry is non-null (not the old invisible null-cell)", !!e);
  check("fallow: sheet is floor_furrowed_soil.png", e && e.sheet === "floor_furrowed_soil.png");
  check("fallow: footprint is 3x2 (w,h from b.x1..x2/y1..y2)", e && e.w === 3 && e.h === 2);
  check("fallow: EVERY footprint cell is a real {col,row} (regression guard)", everyCellReal(e));
  // per-tile variety: at least two distinct furrow columns are used across the 6 tiles
  const cols = new Set(); if (e) for (const row of e.cells) for (const c of row) cols.add(c.col);
  check("fallow: uses >1 furrow variant across the footprint (per-tile hash)", cols.size >= 2);
}

// ---- (2) planted plot -> FARMPLOT_PLANTED --------------------------------------------------
{
  const b = { ...plot3x2, bextra: 173 }; // plant_id 173 (matches the live blddump this session)
  const e = T._farmPlotEntryForTest(b);
  check("planted: sheet is floor_farm_planted.png", e && e.sheet === "floor_farm_planted.png");
  check("planted: cell is FARMPLOT_PLANTED (0,0)", e && e.cells[0][0].col === 0 && e.cells[0][0].row === 0);
  check("planted: every cell real", everyCellReal(e));
}

// ---- (3) canvas2d == GL, byte-identical, for both states -----------------------------------
{
  for (const bextra of [0xFFFF, 173, 0]) { // fallow, planted(173), planted(0 -- a valid plant_id)
    const b = { ...plot3x2, bextra };
    const e2d = T._farmPlotEntryForTest(b);
    const egl = builder._farmPlotEntryForTest(b);
    check("canvas2d == GL entry for bextra=" + bextra, JSON.stringify(e2d) === JSON.stringify(egl));
  }
  // bextra=0 must be treated as PLANTED (plant_id 0 is a real crop, only 0xFFFF is fallow)
  const e0 = T._farmPlotEntryForTest({ ...plot3x2, bextra: 0 });
  check("bextra=0 is planted (plant_id 0 valid; only 0xFFFF is fallow)", e0 && e0.sheet === "floor_farm_planted.png");
}

// ---- (4) non-FarmPlot buildings untouched --------------------------------------------------
{
  check("Workshop building -> null (farmPlotEntry does not hijack it)",
    T._farmPlotEntryForTest({ type: "Workshop", subtype: 0, x1: 0, y1: 0, x2: 2, y2: 2, bextra: 5 }) === null);
  check("missing bextra fallows to a visible furrowed bed (never invisible)",
    everyCellReal(T._farmPlotEntryForTest({ ...plot3x2 })));
}

// ---- (5) TEST-THE-TEST: the old null-cell shape must FAIL everyCellReal ---------------------
{
  const oldNullEntry = { sheet: "workshops_1x1.png", w: 1, h: 1, cells: [[null]] };
  check("test-the-test: the pre-fix null-cell entry FAILS the every-cell-real guard",
    everyCellReal(oldNullEntry) === false);
}

console.log(`\n${pass} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
