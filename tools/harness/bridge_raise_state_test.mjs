// bridge_raise_state_test.mjs -- "a raised drawbridge renders as a lowered one".
//
// THE DEFECT: buildingEntry()/buildingEntryGL() resolved EVERY bridge -- any material, raised or
// lowered, retracting or raising -- to building_map.json's flat `Bridge` key. The generator fills
// that key with the STONE `NS_CENTER` lowered-deck cell and leaves a note calling the rest a
// "client upgrade" (build_building_map.py, _emit_bytype_defaults); the nested `bridges` family it
// emits alongside -- every authored raise-state and per-footprint-tile cell -- had no reader at
// all. The material tint still resolved, so a raised bridge looked correctly-materialed and
// simply never went up.
//
// Loads the REAL web/js/dwf-gl.js and web/js/dwf-tiles.js verbatim via vm.runInContext and the
// REAL committed web/building_map.json (same convention as wb12_buildings_test.mjs), so every
// assertion below is against shipped data, not a synthetic fixture.
//
// Run: node tools/harness/bridge_raise_state_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const realBuildingMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/building_map.json"), "utf8"));

let failures = 0;
function section(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}

// df::building_bridgest.direction (df-structures df.building.xml:1177-1183, original-name
// `anchor`): Retracting=-1, Left=0, Right=1, Up=2, Down=3. `bst` bit0 = gate_flags.raised.
const RETRACT = -1, LEFT_W = 0, RIGHT_E = 1, UP_N = 2, DOWN_S = 3;
const MATS = ["WOOD", "STONE", "METAL", "GLASS"];

// =============================================================================================
// (0) DATA GUARD: the committed `bridges` family must carry all 77 authored cells per material.
// Five of them (`1x1_RAISE_{N,S,E,W}`, `RETRACT_1x1`) spell a size with a LOWERCASE 'x' and were
// silently dropped for the life of the file by build_building_map.py's uppercase-only token
// class. If this regresses, bridgeEntry's all-or-nothing guard sends bridges back to the flat
// stamp and this whole feature quietly disappears again.
// =============================================================================================
section("data: building_map.bridges carries all 77 authored cells for every material", () => {
  assert.ok(realBuildingMap.bridges, "building_map.json has a `bridges` family");
  for (const mat of MATS) {
    const fam = realBuildingMap.bridges[mat];
    assert.ok(fam, "bridges." + mat + " exists");
    assert.equal(Object.keys(fam).length, 77,
      "bridges." + mat + " must have 77 cells (4 1x1_RAISE + 4 NS + 4 WE + 16 RAISE + 16 " +
      "RAISE_END + 16 RAISED + 1 CONSTRUCTION + 16 RETRACT)");
    for (const k of Object.keys(fam)) {
      assert.equal(fam[k].sheet, "bridges.png", "bridges." + mat + "." + k + " sits on bridges.png");
      assert.equal(typeof fam[k].col, "number");
      assert.equal(typeof fam[k].row, "number");
    }
  }
});

section("data: the five lowercase-'x' tokens the old generator regex dropped are present", () => {
  for (const mat of MATS) {
    const fam = realBuildingMap.bridges[mat];
    for (const tok of ["1x1_RAISE_N", "1x1_RAISE_S", "1x1_RAISE_E", "1x1_RAISE_W", "RETRACT_1x1"]) {
      assert.ok(fam[tok], "bridges." + mat + "." + tok + " must exist");
      // Cross-check against the flat top-level key the generic pass emitted for the same raw
      // line -- they are the same TILE_GRAPHICS row, so the cells must agree exactly.
      const flat = realBuildingMap["BLD_BRIDGE_" + mat + "_" + tok];
      assert.ok(flat, "flat BLD_BRIDGE_" + mat + "_" + tok + " exists");
      const fc = flat.cells[0][0];
      assert.deepEqual([fam[tok].col, fam[tok].row], [fc.col, fc.row],
        "nested and flat cells for " + mat + " " + tok + " must be the same sheet cell");
    }
  }
});

// ---- sandboxes: the REAL renderers -----------------------------------------------------------
const glSandbox = {};
glSandbox.self = glSandbox;
glSandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(glSandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glSandbox, { filename: f });
}
const GL = glSandbox.DwfGL;
assert.ok(GL, "gl sandbox must export DwfGL");

function makeMockAtlas() {
  const ids = new Map();
  let next = 1;
  return {
    resolve(sheet, col, row) { const k = sheet + "|" + col + "|" + row; if (!ids.has(k)) ids.set(k, next++); return ids.get(k); },
    resolvePalette(sheet, col, row, palRow) { return this.resolve(sheet + "#palette=" + palRow, col, row); },
  };
}
const glBuilder = GL.createSceneBuilder({ atlas: makeMockAtlas(), buildingMap: realBuildingMap });
assert.ok(typeof glBuilder._bridgeEntryForTest === "function", "dwf-gl.js exposes _bridgeEntryForTest");

async function loadTiles() {
  class FakeImage { constructor() { this.onload = null; this.onerror = null; this._src = ""; } set src(v) { this._src = v; } get src() { return this._src; } }
  class FakeCanvasEl {
    constructor() { this.width = 800; this.height = 600; this.style = {}; }
    addEventListener() {} removeEventListener() {}
    getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
  }
  const s = {};
  s.window = s; s.self = s;
  s.location = { search: "", protocol: "http:", host: "localhost:8765" };
  s.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
  s.addEventListener = () => {};
  s.sessionStorage = { getItem: () => null, setItem() {} };
  s.URLSearchParams = URLSearchParams;
  s.requestAnimationFrame = () => 0;
  s.cancelAnimationFrame = () => {};
  s.setTimeout = setTimeout; s.clearTimeout = clearTimeout;
  s.console = console;
  s.Image = FakeImage;
  s.fetch = async (url) => {
    if (String(url).indexOf("building_map.json") !== -1) return { ok: true, json: async () => realBuildingMap };
    return { ok: false, json: async () => null };
  };
  vm.createContext(s);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), s, { filename: "dwf-tiles.js" });
  const T = s.DwfTiles;
  T.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });
  const t0 = Date.now();
  while (T._buildingEntryForTest({ type: "Workshop", subtype: 0 }).sheet === "defaults.png") {
    if (Date.now() - t0 > 2000) throw new Error("dwf-tiles.js building_map.json load timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
  return T;
}
const Tiles = await loadTiles();
assert.ok(typeof Tiles._bridgeEntryForTest === "function", "dwf-tiles.js exposes _bridgeEntryForTest");

// A stone bridge (mat_type 0 -> STONE family) spanning x1..x2, y1..y2.
function bridge(o) {
  return Object.assign({ type: "Bridge", z: 100, mat_type: 0, mat_index: -1 }, o);
}
function entryTokens(b) {
  // Map a resolved entry's cells back to the `bridges` family suffixes, so assertions read as
  // the authored token grammar rather than as raw sheet coordinates.
  // The entry is built INSIDE the vm sandbox realm, so its arrays carry that realm's
  // Array.prototype and assert.deepEqual would reject value-identical grids on prototype
  // identity alone (the same cross-realm pitfall wb12_buildings_test.mjs documents). JSON
  // round-trip first, then map -- the result is a native array of native arrays.
  const e = Tiles._bridgeEntryForTest(b, realBuildingMap);
  if (!e) return null;
  const cells = JSON.parse(JSON.stringify(e.cells));
  const fam = realBuildingMap.bridges.STONE;
  const byCell = new Map();
  for (const k of Object.keys(fam)) byCell.set(fam[k].col + ":" + fam[k].row, k);
  return cells.map((row) => row.map((c) => (c ? (byCell.get(c.col + ":" + c.row) || "?") : null)));
}

// =============================================================================================
// (1) THE REPORTED BUG: raising a bridge must change what it draws. Before this path existed,
// the lowered and raised entries were byte-identical (both the flat `Bridge` stamp).
// =============================================================================================
section("REGRESSION: a raised bridge no longer draws the same cells as the lowered one", () => {
  for (const dir of [LEFT_W, RIGHT_E, UP_N, DOWN_S]) {
    const geom = { x1: 10, y1: 10, x2: 13, y2: 12 };
    const down = Tiles._bridgeEntryForTest(bridge({ ...geom, dir, bst: 0 }), realBuildingMap);
    const up = Tiles._bridgeEntryForTest(bridge({ ...geom, dir, bst: 1 }), realBuildingMap);
    assert.ok(down && up, "both states resolve for dir " + dir);
    assert.notDeepEqual(JSON.parse(JSON.stringify(up.cells)), JSON.parse(JSON.stringify(down.cells)),
      "dir " + dir + ": raised and lowered must not resolve to the same cells (this IS the bug)");
  }
});

section("REGRESSION: the raised entry is not the flat `Bridge` stamp any more", () => {
  const flat = realBuildingMap.Bridge.cells[0][0];
  const e = Tiles._bridgeEntryForTest(bridge({ x1: 0, y1: 0, x2: 3, y2: 2, dir: UP_N, bst: 1 }), realBuildingMap);
  assert.ok(e, "raised bridge resolves through the bridges family");
  const allFlat = e.cells.every((row) => row.every((c) => c && c.col === flat.col && c.row === flat.row));
  assert.ok(!allFlat, "a raised bridge must not resolve to the flat lowered-deck cell everywhere");
});

// =============================================================================================
// (2) RAISED ART: every footprint tile takes RAISED_<D>_<perp>, with <perp> along the axis
// PERPENDICULAR to the raise axis (the only axis the authored RAISED_* family varies on).
// =============================================================================================
section("raised, 4x3, anchored N: every tile is RAISED_N_<perp> keyed by its column", () => {
  const t = entryTokens(bridge({ x1: 10, y1: 10, x2: 13, y2: 12, dir: UP_N, bst: 1 }));
  assert.deepEqual(t, [
    ["RAISED_N_W", "RAISED_N_CENTER", "RAISED_N_CENTER", "RAISED_N_E"],
    ["RAISED_N_W", "RAISED_N_CENTER", "RAISED_N_CENTER", "RAISED_N_E"],
    ["RAISED_N_W", "RAISED_N_CENTER", "RAISED_N_CENTER", "RAISED_N_E"],
  ]);
});
section("raised, 3x4, anchored W: perp runs N/S (the raise axis is west-east)", () => {
  const t = entryTokens(bridge({ x1: 10, y1: 10, x2: 12, y2: 13, dir: LEFT_W, bst: 1 }));
  assert.deepEqual(t, [
    ["RAISED_W_N", "RAISED_W_N", "RAISED_W_N"],
    ["RAISED_W_CENTER", "RAISED_W_CENTER", "RAISED_W_CENTER"],
    ["RAISED_W_CENTER", "RAISED_W_CENTER", "RAISED_W_CENTER"],
    ["RAISED_W_S", "RAISED_W_S", "RAISED_W_S"],
  ]);
});
section("raised, single-tile-wide: perp collapses to the authored `_1` cell", () => {
  assert.deepEqual(entryTokens(bridge({ x1: 5, y1: 5, x2: 5, y2: 7, dir: DOWN_S, bst: 1 })),
    [["RAISED_S_1"], ["RAISED_S_1"], ["RAISED_S_1"]]);
  assert.deepEqual(entryTokens(bridge({ x1: 5, y1: 5, x2: 7, y2: 5, dir: RIGHT_E, bst: 1 })),
    [["RAISED_E_1", "RAISED_E_1", "RAISED_E_1"]]);
});

// =============================================================================================
// (3) LOWERED ART: the three-role decomposition along the raise axis -- the ANCHORED edge row
// (RAISE_<D>), the interior (NS_/WE_, keyed by axis only), and the FREE end row
// (RAISE_<D>_END). `direction`'s df-structures original-name is `anchor`, which is what makes
// the D-side row the RAISE_<D> one.
// =============================================================================================
section("lowered, 3x4 anchored N: anchor row N, interior NS_, free end row S", () => {
  const t = entryTokens(bridge({ x1: 10, y1: 10, x2: 12, y2: 13, dir: UP_N, bst: 0 }));
  assert.deepEqual(t, [
    ["RAISE_N_W", "RAISE_N_CENTER", "RAISE_N_E"],              // anchored (north) edge row
    ["NS_W", "NS_CENTER", "NS_E"],                              // interior
    ["NS_W", "NS_CENTER", "NS_E"],                              // interior
    ["RAISE_N_END_W", "RAISE_N_END_CENTER", "RAISE_N_END_E"],   // free end row
  ]);
});
section("lowered, anchored S: the anchor row flips to the SOUTH edge", () => {
  const t = entryTokens(bridge({ x1: 10, y1: 10, x2: 12, y2: 13, dir: DOWN_S, bst: 0 }));
  assert.deepEqual(t, [
    ["RAISE_S_END_W", "RAISE_S_END_CENTER", "RAISE_S_END_E"],
    ["NS_W", "NS_CENTER", "NS_E"],
    ["NS_W", "NS_CENTER", "NS_E"],
    ["RAISE_S_W", "RAISE_S_CENTER", "RAISE_S_E"],
  ]);
});
section("lowered, 4x3 anchored E: the decomposition runs along the WEST-EAST axis", () => {
  const t = entryTokens(bridge({ x1: 10, y1: 10, x2: 13, y2: 12, dir: RIGHT_E, bst: 0 }));
  assert.deepEqual(t, [
    ["RAISE_E_END_N", "WE_N", "WE_N", "RAISE_E_N"],
    ["RAISE_E_END_CENTER", "WE_CENTER", "WE_CENTER", "RAISE_E_CENTER"],
    ["RAISE_E_END_S", "WE_S", "WE_S", "RAISE_E_S"],
  ]);
});
section("lowered 1x1 raising bridge takes the authored `1x1_RAISE_<D>` cell", () => {
  for (const [dir, d] of [[UP_N, "N"], [DOWN_S, "S"], [LEFT_W, "W"], [RIGHT_E, "E"]]) {
    assert.deepEqual(entryTokens(bridge({ x1: 4, y1: 4, x2: 4, y2: 4, dir, bst: 0 })),
      [["1x1_RAISE_" + d]], "1x1 lowered, anchored " + d);
  }
});
// DF authors `1x1_RAISE_<D>` with no perpendicular variants, so a bridge one tile DEEP along
// its raise axis but WIDER than one has no authored lowered art at all: the anchor row and the
// free-end row are the same row. Rule 1 says fail closed rather than pick a winner, so the
// whole building declines to the previous flat stamp. The RAISED state of the same footprint
// is fully authored and must still resolve -- that asymmetry is the point.
section("lowered, 1 deep and wider than 1: declines (no authored art) instead of guessing", () => {
  for (const [dir, geom] of [
    [UP_N, { x1: 0, y1: 0, x2: 4, y2: 0 }], [DOWN_S, { x1: 0, y1: 0, x2: 4, y2: 0 }],
    [LEFT_W, { x1: 0, y1: 0, x2: 0, y2: 4 }], [RIGHT_E, { x1: 0, y1: 0, x2: 0, y2: 4 }],
  ]) {
    assert.equal(Tiles._bridgeEntryForTest(bridge({ ...geom, dir, bst: 0 }), realBuildingMap), null,
      "lowered 1-deep dir " + dir + " must decline to the flat stamp");
    assert.ok(Tiles._bridgeEntryForTest(bridge({ ...geom, dir, bst: 1 }), realBuildingMap),
      "the SAME footprint raised is fully authored and must still resolve (dir " + dir + ")");
  }
});

// =============================================================================================
// (4) RETRACTING BRIDGES. Lowered: an exhaustive 4-bit exposed-edge mask in canonical N,S,W,E
// order (the authored 3-edge tokens NSE/NSW/NWE/SWE pin that order). Raised: a retracting deck
// withdraws into its abutments and the tiles become open space, so it draws NOTHING -- that is
// its "up" appearance, and it is a different failure mode from an unresolved cell.
// =============================================================================================
section("retracting, lowered 3x3: the exhaustive edge mask (corners, edges, CENTER)", () => {
  const t = entryTokens(bridge({ x1: 10, y1: 10, x2: 12, y2: 12, dir: RETRACT, bst: 0 }));
  assert.deepEqual(t, [
    ["RETRACT_NW", "RETRACT_N", "RETRACT_NE"],
    ["RETRACT_W", "RETRACT_CENTER", "RETRACT_E"],
    ["RETRACT_SW", "RETRACT_S", "RETRACT_SE"],
  ]);
});
section("retracting, lowered 1-wide strips: the 3-edge tokens, canonical N,S,W,E order", () => {
  assert.deepEqual(entryTokens(bridge({ x1: 5, y1: 5, x2: 5, y2: 7, dir: RETRACT, bst: 0 })),
    [["RETRACT_NWE"], ["RETRACT_WE"], ["RETRACT_SWE"]]);
  assert.deepEqual(entryTokens(bridge({ x1: 5, y1: 5, x2: 7, y2: 5, dir: RETRACT, bst: 0 })),
    [["RETRACT_NSW", "RETRACT_NS", "RETRACT_NSE"]]);
});
section("retracting, lowered 1x1: all four edges exposed -> the authored `RETRACT_1x1` cell", () => {
  assert.deepEqual(entryTokens(bridge({ x1: 5, y1: 5, x2: 5, y2: 5, dir: RETRACT, bst: 0 })),
    [["RETRACT_1x1"]]);
});
section("retracting, RAISED: draws nothing (all-null cells), not a fallback stamp", () => {
  const e = Tiles._bridgeEntryForTest(bridge({ x1: 10, y1: 10, x2: 12, y2: 12, dir: RETRACT, bst: 1 }), realBuildingMap);
  assert.ok(e, "a retracted bridge still resolves an entry (so it never falls back to the flat stamp)");
  assert.equal(e.sheet, "bridges.png");
  assert.equal(e.cells.length, 3);
  for (const row of e.cells) {
    assert.equal(row.length, 3);
    for (const c of row) assert.equal(c, null, "every retracted tile must be an authored empty");
  }
});

// =============================================================================================
// (5) MATERIAL FAMILY: the bridge's own material picks the sheet COLUMN. This is what the flat
// `Bridge` key could never do -- it was hardcoded to STONE and leaned on the crgb multiply.
// =============================================================================================
section("material family: wood/glass bridges select their own authored column, not STONE's", () => {
  const geom = { x1: 0, y1: 0, x2: 2, y2: 2, dir: UP_N, bst: 1 };
  const stone = Tiles._bridgeEntryForTest(bridge({ ...geom, mat_type: 0, mat_index: -1 }), realBuildingMap);
  // mat_type >= 419 is the plant/wood range (matFamilyForItem); 3/4/5 are the glass builtins.
  const wood = Tiles._bridgeEntryForTest(bridge({ ...geom, mat_type: 420, mat_index: 1 }), realBuildingMap);
  const glass = Tiles._bridgeEntryForTest(bridge({ ...geom, mat_type: 3, mat_index: -1 }), realBuildingMap);
  assert.equal(stone.cells[0][0].col, realBuildingMap.bridges.STONE.RAISED_N_W.col, "stone column");
  assert.equal(wood.cells[0][0].col, realBuildingMap.bridges.WOOD.RAISED_N_W.col, "wood column");
  assert.equal(glass.cells[0][0].col, realBuildingMap.bridges.GLASS.RAISED_N_W.col, "glass column");
  assert.notEqual(wood.cells[0][0].col, stone.cells[0][0].col, "wood and stone are different columns");
});

// =============================================================================================
// (6) FAIL-CLOSED COMPATIBILITY: an old DLL ships no WC-6 dir/bst for buildings. Guessing an
// orientation there would be the invention this codebase's rule 1 forbids, so the bridge must
// fall through to the previous flat-key behaviour instead.
// =============================================================================================
section("old DLL (no dir/bst): bridgeEntry declines, buildingEntry's flat stamp still applies", () => {
  assert.equal(Tiles._bridgeEntryForTest(bridge({ x1: 0, y1: 0, x2: 2, y2: 2 }), realBuildingMap), null);
  assert.equal(Tiles._bridgeEntryForTest(bridge({ x1: 0, y1: 0, x2: 2, y2: 2, dir: UP_N }), realBuildingMap), null);
  const flat = Tiles._buildingEntryForTest({ type: "Bridge" });
  assert.ok(flat && flat.sheet === "bridges.png", "the flat Bridge key is still the fallback");
});
// An anchor value outside the enum must degrade to the flat stamp. The dangerous wrong answer
// is an all-null grid: that is the shape a RETRACTED deck uses, so the bridge would silently
// vanish under GL and (before the `blank` fix) sit under a permanent orange box under canvas2d.
section("out-of-enum dir declines to the flat stamp, never an all-null (vanished) grid", () => {
  for (const dir of [4, 7, -2, 2.5, NaN, -1.5]) {
    const b = bridge({ x1: 0, y1: 0, x2: 2, y2: 2, dir, bst: 0 });
    assert.equal(Tiles._bridgeEntryForTest(b, realBuildingMap), null, "canvas2d declines dir=" + dir);
    assert.equal(glBuilder._bridgeEntryForTest(b, realBuildingMap), null, "GL declines dir=" + dir);
  }
  // the real enum values must of course still resolve
  for (const dir of [RETRACT, LEFT_W, RIGHT_E, UP_N, DOWN_S]) {
    assert.ok(Tiles._bridgeEntryForTest(bridge({ x1: 0, y1: 0, x2: 2, y2: 2, dir, bst: 0 }), realBuildingMap),
      "control: dir=" + dir + " still resolves");
  }
});
section("non-bridge buildings are untouched by this path", () => {
  for (const type of ["Workshop", "TradeDepot", "Bed", "Well", "Stockpile"]) {
    assert.equal(Tiles._bridgeEntryForTest({ type, x1: 0, y1: 0, x2: 1, y2: 1, dir: 0, bst: 1 }, realBuildingMap), null,
      type + " must not resolve through the bridge path");
  }
});
section("an incomplete `bridges` family degrades to the flat stamp, never a partial grid", () => {
  // The draw loop edge-clamps a null sub-cell to the last cell in its row, so a partly-resolved
  // grid would stamp a neighbour's art. Drop one needed cell and assert the whole entry declines.
  const holed = JSON.parse(JSON.stringify(realBuildingMap));
  delete holed.bridges.STONE.RAISED_N_CENTER;
  assert.equal(Tiles._bridgeEntryForTest(bridge({ x1: 0, y1: 0, x2: 2, y2: 2, dir: UP_N, bst: 1 }), holed), null,
    "a missing authored cell must decline the whole building");
  assert.ok(Tiles._bridgeEntryForTest(bridge({ x1: 0, y1: 0, x2: 2, y2: 2, dir: UP_N, bst: 1 }), realBuildingMap),
    "control: the real map still resolves (the assertion above is load-bearing)");
});

// =============================================================================================
// (7) RENDERER PARITY. AGENTS.md: "When behavior differs between the GL and canvas renderers,
// it's a bug: shared logic must resolve identically in both." Sweep the whole grammar -- both
// raise states x all five directions x footprints that exercise 1x1, single-row, single-column,
// and interior tiles -- and require token-for-token agreement.
// =============================================================================================
section("PARITY: bridgeEntry and bridgeEntryGL agree across the whole grammar sweep", () => {
  const geoms = [
    { x1: 0, y1: 0, x2: 0, y2: 0 },   // 1x1
    { x1: 0, y1: 0, x2: 0, y2: 3 },   // 1 wide, 4 deep
    { x1: 0, y1: 0, x2: 3, y2: 0 },   // 4 wide, 1 deep (the documented residual)
    { x1: 0, y1: 0, x2: 1, y2: 1 },   // 2x2, no interior
    { x1: 7, y1: 9, x2: 11, y2: 13 }, // 5x5, full interior, non-zero origin
  ];
  const mats = [{ mat_type: 0, mat_index: -1 }, { mat_type: 420, mat_index: 1 }, { mat_type: 4, mat_index: -1 }];
  let compared = 0;
  for (const geom of geoms) {
    for (const dir of [RETRACT, LEFT_W, RIGHT_E, UP_N, DOWN_S]) {
      for (const bst of [0, 1]) {
        for (const mat of mats) {
          const b = bridge({ ...geom, ...mat, dir, bst });
          const mine = JSON.parse(JSON.stringify(Tiles._bridgeEntryForTest(b, realBuildingMap)));
          const theirs = JSON.parse(JSON.stringify(glBuilder._bridgeEntryForTest(b, realBuildingMap)));
          assert.deepEqual(theirs, mine, "bridgeEntryGL must match bridgeEntry for " + JSON.stringify(b));
          compared++;
        }
      }
    }
  }
  console.log("    parity comparisons: " + compared);
});

section("PARITY: the pure token functions agree tile-for-tile over an exhaustive sweep", () => {
  let compared = 0;
  for (const dir of [RETRACT, LEFT_W, RIGHT_E, UP_N, DOWN_S]) {
    for (const raised of [false, true]) {
      for (let w = 1; w <= 4; w++) {
        for (let h = 1; h <= 4; h++) {
          for (let ry = 0; ry < h; ry++) {
            for (let rx = 0; rx < w; rx++) {
              const mine = Tiles._bridgeCellTokenForTest(dir, raised, w, h, rx, ry);
              const theirs = glBuilder._bridgeCellTokenForTest(dir, raised, w, h, rx, ry);
              assert.equal(theirs, mine,
                `token mismatch dir=${dir} raised=${raised} ${w}x${h} @(${rx},${ry}): ${theirs} vs ${mine}`);
              compared++;
            }
          }
        }
      }
    }
  }
  console.log("    token comparisons: " + compared);
});

// =============================================================================================
// (8) CLOSURE -- A COMPLETENESS CHECK ONLY, NOT A PROOF OF ORIENTATION.
//
// Read this before treating the numbers below as grammar evidence: closure is INVARIANT under
// the orientation errors that matter. Swapping `RAISE_<D>` with `RAISE_<D>_END`, mirroring the
// compass (N<->S, E<->W), or inverting the retract mask all still consume 76 of 77 cells with
// CONSTRUCTION as the sole leftover. What this section actually proves is (a) the resolver
// never asks for a token the shipped map lacks -- the guard that would have caught the dropped
// lowercase-'x' cells at authoring time -- and (b) no authored cell besides CONSTRUCTION is
// dead. Which ROW the anchor sprite lands on is an inference from the `_END` suffix and is
// settled only by a native capture; see bridgeEntry's banner in dwf-tiles.js.
// =============================================================================================
section("closure: every token the resolver can emit exists in all four material families", () => {
  const emitted = new Set();
  for (const dir of [RETRACT, LEFT_W, RIGHT_E, UP_N, DOWN_S]) {
    for (const raised of [false, true]) {
      for (let w = 1; w <= 6; w++) {
        for (let h = 1; h <= 6; h++) {
          for (let ry = 0; ry < h; ry++) {
            for (let rx = 0; rx < w; rx++) {
              const tok = Tiles._bridgeCellTokenForTest(dir, raised, w, h, rx, ry);
              if (tok !== null) emitted.add(tok);
            }
          }
        }
      }
    }
  }
  for (const mat of MATS) {
    for (const tok of emitted) {
      assert.ok(realBuildingMap.bridges[mat][tok],
        "resolver can emit `" + tok + "` but bridges." + mat + " has no such cell");
    }
  }
  // CONSTRUCTION is the only authored cell this path never selects (bridges have no planned
  // preview path); everything else in the family must be reachable, or the grammar is wrong.
  const unreachable = Object.keys(realBuildingMap.bridges.STONE).filter((k) => !emitted.has(k));
  assert.deepEqual(unreachable, ["CONSTRUCTION"],
    "every authored bridge cell except CONSTRUCTION must be reachable; unreachable: " + JSON.stringify(unreachable));
  console.log("    distinct tokens emitted: " + emitted.size + " of 77 authored (CONSTRUCTION unused)");
});

// =============================================================================================
// (9) DRAW-PATH INTEGRATION. The sections above exercise the resolver; this one drives the real
// GL scene builder end to end, so a bridgeEntry that resolves correctly but is never reached
// from emitBuilding (the actual defect class here -- the `bridges` data existed all along and
// simply had no caller) still fails.
// =============================================================================================
function decode(builder) {
  const buf = builder.buffer, n = builder.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf);
  const out = [];
  for (let k = 0; k < n; k++) out.push({ x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4] });
  return out;
}
function tile() {
  return { tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 };
}
function sceneWithBridge(b, gw, gh) {
  const atlas = makeMockAtlas();
  const builder = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const tiles = new Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) tiles[i] = tile();
  builder.buildScene({ origin: { x: 0, y: 0, z: 100 }, width: gw, height: gh, tiles, buildings: [b] });
  return { inst: decode(builder), atlas };
}
section("draw path: buildScene emits the RAISED cells for a raised bridge", () => {
  const geom = { type: "Bridge", z: 100, mat_type: 0, mat_index: -1, x1: 1, y1: 1, x2: 3, y2: 3 };
  const fam = realBuildingMap.bridges.STONE;
  const { inst, atlas } = sceneWithBridge({ ...geom, dir: UP_N, bst: 1 }, 5, 5);
  // 3x3 anchored N, raised: west column RAISED_N_W, middle RAISED_N_CENTER, east RAISED_N_E.
  const expect = [
    [1, fam.RAISED_N_W], [2, fam.RAISED_N_CENTER], [3, fam.RAISED_N_E],
  ];
  for (const [wx, cell] of expect) {
    const id = atlas.resolve("bridges.png", cell.col, cell.row);
    const hits = inst.filter((i) => i.cell === id && i.x === wx);
    assert.equal(hits.length, 3, `column x=${wx} must emit its raised cell on all 3 rows`);
  }
  // and the lowered deck's own centre cell must be nowhere in the frame
  const lowered = atlas.resolve("bridges.png", fam.NS_CENTER.col, fam.NS_CENTER.row);
  assert.ok(!inst.some((i) => i.cell === lowered), "a raised bridge must emit no lowered-deck cell");
});
// CANVAS2D-ONLY, and the reason this section exists: the GL section above cannot see it.
// canvas2d strokes a BLD_OUTLINE box whenever a building blits no cell (the sheet-decoding
// safety net); GL has no such fallback. A retracted deck blits nothing BY DESIGN, so without
// suppression every retracted drawbridge would sit under a permanent orange rectangle in
// canvas2d and show clean floor in GL -- exactly the renderer divergence AGENTS.md calls a bug.
section("canvas2d outline: a retracted deck is `blank` and must NOT be outlined", () => {
  const retracted = Tiles._bridgeEntryForTest(
    bridge({ x1: 1, y1: 1, x2: 3, y2: 3, dir: RETRACT, bst: 1 }), realBuildingMap);
  assert.equal(retracted.blank, true, "a retracted deck declares itself intentionally blank");
  assert.equal(Tiles._shouldOutlineMissingArtForTest(retracted, false), false,
    "an intentionally-blank building must not get the orange fallback box");
  // the safety net must survive for its real case: a normal entry that painted nothing
  const lowered = Tiles._bridgeEntryForTest(
    bridge({ x1: 1, y1: 1, x2: 3, y2: 3, dir: RETRACT, bst: 0 }), realBuildingMap);
  assert.notEqual(lowered.blank, true, "a lowered deck is NOT blank -- it has art to paint");
  assert.equal(Tiles._shouldOutlineMissingArtForTest(lowered, false), true,
    "a building that SHOULD have painted but didn't still gets the outline (net intact)");
  assert.equal(Tiles._shouldOutlineMissingArtForTest(lowered, true), false, "painted -> no outline");
  assert.equal(Tiles._shouldOutlineMissingArtForTest(retracted, true), false);
  // and no non-retracted bridge ever claims blankness
  for (const dir of [LEFT_W, RIGHT_E, UP_N, DOWN_S]) {
    for (const bst of [0, 1]) {
      const e = Tiles._bridgeEntryForTest(bridge({ x1: 1, y1: 1, x2: 3, y2: 3, dir, bst }), realBuildingMap);
      assert.notEqual(e.blank, true, `dir ${dir} bst ${bst} must have art, not blankness`);
    }
  }
});
section("draw path: a retracted (raised) retracting bridge emits NO building cells at all", () => {
  const geom = { type: "Bridge", z: 100, mat_type: 0, mat_index: -1, x1: 1, y1: 1, x2: 3, y2: 3 };
  const down = sceneWithBridge({ ...geom, dir: RETRACT, bst: 0 }, 5, 5);
  const up = sceneWithBridge({ ...geom, dir: RETRACT, bst: 1 }, 5, 5);
  // 25 terrain base-fill instances in both; the lowered bridge adds its 9 footprint cells.
  assert.equal(up.inst.length, 25, "retracted: terrain only, zero bridge cells (got " + up.inst.length + ")");
  assert.equal(down.inst.length, 34, "lowered: terrain + 9 deck cells (got " + down.inst.length + ")");
});

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nAll bridge_raise_state_test sections passed.");
