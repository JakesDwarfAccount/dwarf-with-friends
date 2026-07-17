// tx17_planned_construction_test.mjs -- acceptance for PLANNED (not-yet-built) CONSTRUCTIONS
// rendering as DF's authored planned-preview art instead of the blue MISSING_BUILDING "b" glyph
// (the TX17 report: a planned wall showed a raw ASCII building glyph on a cyan cell).
//
// ROOT CAUSE: a df::building of type "Construction" in world->buildings.all is ALWAYS a planned/
// in-progress construction (DF removes the building and lays a real construction TILE once it
// completes). It rides the wire with type="Construction" + subtype=<construction_type ordinal>
// (world_stream.cpp BldRec.subtype). The client's buildingEntry only tried "Construction:<st>"
// and bare "Construction" -- neither exists in building_map.json (which is keyed by DF's
// PLANNED_CONSTRUCTION_* tokens) -- so every planned construction fell to MISSING_BUILDING
// (defaults.png 0:1, the blue "b"). TX17 maps subtype -> PLANNED_CONSTRUCTION_* token.
//
// This is a CLIENT-ONLY fix: the wire already carries type/subtype/stage/built. No DLL change.
//
// ORACLE (completeness-protocol rule 2): the token->col:row truth is DF's own
// vanilla_buildings_graphics/graphics_planned_constructions.txt. This test reads that file and
// differentially checks building_map.json against it for EVERY token in the fix's table, so a
// wrong ordinal->token mapping or a drifted generated map fails here, not live.
//
// FULL FAMILY (rule 1 -- enumerate before you fix): the construction_type enum has 38 members
// (Fortification, Wall, Floor, 3 stairs, Ramp, ReinforcedWall, + 30 track / track-ramp variants).
// The matrix section below exercises ALL 38, not just the reported wall.
//
// Run: node tools/harness/tx17_planned_construction_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { dfRootOrSkip } from "../lib/dfroot.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const realBuildingMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/building_map.json"), "utf8"));
// W1: resolved, never hardcoded. No DF install -> this suite SKIPs (exit 0),
// because its ground truth IS the raws: without them there is nothing to check against.
const DF_ROOT_W1 = dfRootOrSkip("tx17_planned_construction_test.mjs");
const DF_PLANNED = path.join(DF_ROOT_W1, "data/vanilla/vanilla_buildings_graphics/graphics/graphics_planned_constructions.txt");

let failures = 0;
function section(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}
const MISS = (e) => !!e && e.sheet === "defaults.png" && e.col === 0 && e.row === 1;
function firstCell(e) {
  // building_map entries are {cells:[[{col,row}]],sheet} (multi-cell) or {sheet,col,row} (flat).
  if (!e) return null;
  if (Array.isArray(e.cells) && e.cells[0] && e.cells[0][0]) return { sheet: e.sheet, col: e.cells[0][0].col, row: e.cells[0][0].row };
  if (typeof e.col === "number") return { sheet: e.sheet, col: e.col, row: e.row };
  return null;
}

// The AUTHORITATIVE construction_type -> graphics token map (df.building.xml enum ordinals; the
// graphics tokens reorder E-before-W vs the enum names). Kept here INDEPENDENTLY of the client so
// a copy-paste slip in the client table is caught by disagreement, not mirrored.
const EXPECT_TOKEN = [
  "PLANNED_CONSTRUCTION_FORTIFICATION", "PLANNED_CONSTRUCTION_WALL", "PLANNED_CONSTRUCTION_FLOOR",
  "PLANNED_CONSTRUCTION_STAIR_UP", "PLANNED_CONSTRUCTION_STAIR_DOWN", "PLANNED_CONSTRUCTION_STAIR_UPDOWN",
  "PLANNED_CONSTRUCTION_RAMP",
  "PLANNED_CONSTRUCTION_TRACK_N", "PLANNED_CONSTRUCTION_TRACK_S", "PLANNED_CONSTRUCTION_TRACK_E",
  "PLANNED_CONSTRUCTION_TRACK_W", "PLANNED_CONSTRUCTION_TRACK_NS", "PLANNED_CONSTRUCTION_TRACK_NE",
  "PLANNED_CONSTRUCTION_TRACK_NW", "PLANNED_CONSTRUCTION_TRACK_SE", "PLANNED_CONSTRUCTION_TRACK_SW",
  "PLANNED_CONSTRUCTION_TRACK_WE", "PLANNED_CONSTRUCTION_TRACK_NSE", "PLANNED_CONSTRUCTION_TRACK_NSW",
  "PLANNED_CONSTRUCTION_TRACK_NWE", "PLANNED_CONSTRUCTION_TRACK_SWE", "PLANNED_CONSTRUCTION_TRACK_NSWE",
  "PLANNED_CONSTRUCTION_TRACK_RN", "PLANNED_CONSTRUCTION_TRACK_RS", "PLANNED_CONSTRUCTION_TRACK_RE",
  "PLANNED_CONSTRUCTION_TRACK_RW", "PLANNED_CONSTRUCTION_TRACK_RNS", "PLANNED_CONSTRUCTION_TRACK_RNE",
  "PLANNED_CONSTRUCTION_TRACK_RNW", "PLANNED_CONSTRUCTION_TRACK_RSE", "PLANNED_CONSTRUCTION_TRACK_RSW",
  "PLANNED_CONSTRUCTION_TRACK_RWE", "PLANNED_CONSTRUCTION_TRACK_RNSE", "PLANNED_CONSTRUCTION_TRACK_RNSW",
  "PLANNED_CONSTRUCTION_TRACK_RNWE", "PLANNED_CONSTRUCTION_TRACK_RSWE", "PLANNED_CONSTRUCTION_TRACK_RNSWE",
  "PLANNED_CONSTRUCTION_REINFORCED_WALL",
];
// The reported family + the two most-common members, named so a regression names the victim.
const FAMILY = { Fortification: 0, Wall: 1, Floor: 2, UpStair: 3, DownStair: 4, UpDownStair: 5, Ramp: 6, ReinforcedWall: 37 };

// =============================================================================================
// (0) ORACLE-DIFFERENTIAL: building_map.json's PLANNED_CONSTRUCTION_* cells must equal DF's own
// graphics_planned_constructions.txt (TILE_GRAPHICS:PLANNED_CONSTRUCTIONS:<col>:<row>:<TOKEN>).
// =============================================================================================
section("oracle: building_map.json planned-construction cells match DF graphics_planned_constructions.txt", () => {
  const txt = fs.readFileSync(DF_PLANNED, "utf8");
  const oracle = new Map();
  const re = /TILE_GRAPHICS:PLANNED_CONSTRUCTIONS:(\d+):(\d+):([A-Z0-9_]+)/g;
  let m; while ((m = re.exec(txt))) oracle.set(m[3], { col: +m[1], row: +m[2] });
  assert.ok(oracle.size >= 38, "oracle guard: DF file must define >=38 planned-construction tokens (got " + oracle.size + ")");
  for (const tok of EXPECT_TOKEN) {
    const o = oracle.get(tok);
    assert.ok(o, "DF oracle is missing " + tok + " -- fix's token spelling disagrees with DF");
    const e = firstCell(realBuildingMap[tok]);
    assert.ok(e, "building_map.json is missing a usable entry for " + tok);
    assert.equal(e.sheet, "planned_constructions.png", tok + " must live on planned_constructions.png");
    assert.deepEqual({ col: e.col, row: e.row }, o, tok + " col:row must match DF (" + o.col + ":" + o.row + ")");
  }
  console.log("    verified " + EXPECT_TOKEN.length + " tokens against the DF oracle");
});

// =============================================================================================
// Load BOTH render paths' real resolvers.
// =============================================================================================
const glSandbox = {};
glSandbox.self = glSandbox;
glSandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(glSandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glSandbox, { filename: f });
const GL = glSandbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");
const glB = GL.createSceneBuilder({ atlas: { resolve: () => 1 }, buildingMap: realBuildingMap });

// canvas2d path (DOM-less sandbox, building_map fetched async -- same idiom as wb12's reconcile).
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
  s.requestAnimationFrame = () => 0; s.cancelAnimationFrame = () => {};
  s.setTimeout = setTimeout; s.clearTimeout = clearTimeout; s.console = console; s.Image = FakeImage;
  s.fetch = async (url) => (String(url).indexOf("building_map.json") !== -1)
    ? { ok: true, json: async () => realBuildingMap } : { ok: false, json: async () => null };
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
const T = await loadTiles();

const bld = (st) => ({ type: "Construction", subtype: st, x1: 5, y1: 5, x2: 5, y2: 5, z: 100, built: false });

// =============================================================================================
// (1) FULL MATRIX (all 38 construction_type members): every planned construction resolves to its
// OWN PLANNED_CONSTRUCTION_* art -- never the blue MISSING_BUILDING glyph -- on BOTH render paths.
// =============================================================================================
section("MATRIX: all 38 planned construction subtypes resolve to planned art (not the blue 'b'), c2d==GL", () => {
  for (let st = 0; st < EXPECT_TOKEN.length; st++) {
    const want = firstCell(realBuildingMap[EXPECT_TOKEN[st]]);
    const c = T._buildingEntryForTest(bld(st));
    const g = glB._buildingEntryForTest(bld(st));
    assert.ok(!MISS(c), "subtype " + st + " (" + EXPECT_TOKEN[st] + ") must NOT be MISSING_BUILDING on canvas2d");
    assert.ok(!MISS(g), "subtype " + st + " (" + EXPECT_TOKEN[st] + ") must NOT be MISSING_BUILDING on GL");
    assert.deepEqual(firstCell(c), want, "canvas2d subtype " + st + " -> " + EXPECT_TOKEN[st]);
    assert.deepEqual(firstCell(g), want, "GL subtype " + st + " -> " + EXPECT_TOKEN[st]);
  }
  console.log("    38/38 planned construction subtypes render authored art on both paths");
});

// =============================================================================================
// (1b) NAMED FAMILY (rule 1): the reported wall + each planned-construction sibling, spelled out.
// =============================================================================================
section("FAMILY: wall/floor/ramp/stairs(x3)/fortification/reinforced-wall each render their own planned art", () => {
  for (const [name, st] of Object.entries(FAMILY)) {
    const c = T._plannedConstructionEntryForTest(bld(st));
    assert.ok(c && !MISS(c), "planned " + name + " (subtype " + st + ") must resolve to real planned art");
    assert.deepEqual(firstCell(c), firstCell(realBuildingMap[EXPECT_TOKEN[st]]), "planned " + name + " -> " + EXPECT_TOKEN[st]);
  }
});

// =============================================================================================
// (2) TEST-THE-TEST (rule 3): if the fix were absent, a Construction building falls to
// MISSING_BUILDING. We prove the assertion above is load-bearing two ways:
//   (a) an older building_map WITHOUT the planned token -> feature-detect degrade to MISSING (no crash);
//   (b) the raw pre-fix resolution ("Construction:<st>" / "Construction" keys) yields MISSING.
// =============================================================================================
section("[test-the-test] a building_map missing PLANNED_CONSTRUCTION_WALL degrades the planned wall to MISSING_BUILDING", () => {
  const badMap = JSON.parse(JSON.stringify(realBuildingMap));
  delete badMap.PLANNED_CONSTRUCTION_WALL;
  const glBad = GL.createSceneBuilder({ atlas: { resolve: () => 1 }, buildingMap: badMap });
  const e = glBad._buildingEntryForTest(bld(1));
  assert.ok(MISS(e), "without the token the fix must feature-detect and fall back to MISSING_BUILDING, not throw or mis-map");
});
section("[test-the-test] pre-fix resolution: 'Construction:1'/'Construction' keys do not exist in the real map", () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(realBuildingMap, "Construction"), "no bare 'Construction' key (would have masked the bug)");
  assert.ok(!Object.prototype.hasOwnProperty.call(realBuildingMap, "Construction:1"), "no 'Construction:1' key -- this is WHY it fell to MISSING pre-fix");
});

// =============================================================================================
// (3) NON-AUTHOR COUNTEREXAMPLES (rules 4/5): the override must be tightly scoped + null-guarded.
// =============================================================================================
section("counterexample: Construction subtype -1 (NONE) -> null override, falls to MISSING_BUILDING (guarded)", () => {
  assert.equal(T._plannedConstructionEntryForTest({ type: "Construction", subtype: -1 }), null, "c2d NONE -> null");
  assert.equal(glB._plannedConstructionEntryForTest({ type: "Construction", subtype: -1 }), null, "GL NONE -> null");
  assert.ok(MISS(T._buildingEntryForTest({ type: "Construction", subtype: -1 })), "NONE subtype falls to MISSING, not a wrong sprite");
});
section("counterexample: Construction subtype out of range (999) -> null override, MISSING_BUILDING", () => {
  assert.equal(T._plannedConstructionEntryForTest({ type: "Construction", subtype: 999 }), null);
  assert.equal(glB._plannedConstructionEntryForTest({ type: "Construction", subtype: 999 }), null);
  assert.ok(MISS(T._buildingEntryForTest({ type: "Construction", subtype: 999 })), "out-of-range -> MISSING, no invented art");
});
section("counterexample: Construction with NO subtype field (old/degenerate wire) -> guarded, no crash", () => {
  assert.equal(T._plannedConstructionEntryForTest({ type: "Construction" }), null, "missing subtype -> null (null-guarded)");
  assert.ok(MISS(T._buildingEntryForTest({ type: "Construction" })), "missing subtype -> MISSING, never throws");
});
section("counterexample: the override fires ONLY for type=='Construction' -- other building types untouched", () => {
  // A Workshop's subtype 1 must NOT be captured by the construction table (it would be Wall).
  assert.equal(T._plannedConstructionEntryForTest({ type: "Workshop", subtype: 1 }), null, "Workshop is not a Construction");
  const ws = T._buildingEntryForTest({ type: "Workshop", subtype: 2, x1: 0, y1: 0, x2: 2, y2: 2 });
  assert.equal(ws.sheet, "workshops.png", "Workshop:Masons still resolves to its own sheet (regression: built/other buildings unchanged)");
  const bed = T._buildingEntryForTest({ type: "Bed" });
  assert.ok(!MISS(bed) && bed.sheet !== "planned_constructions.png", "Bed unaffected by the construction override");
});
section("regression: TradeDepot + Furnace resolve exactly as before (the fix is additive)", () => {
  assert.equal(firstCell(T._buildingEntryForTest({ type: "TradeDepot" })).sheet, firstCell(realBuildingMap.TradeDepot).sheet);
  assert.deepEqual(firstCell(T._buildingEntryForTest({ type: "Furnace", subtype: 1 })), firstCell(realBuildingMap["Furnace:Smelter"]));
});

// =============================================================================================
// (4) BUILT-WALL note (blast radius "built wall unchanged"): a COMPLETED construction is a
// tiletype (terrain), not a df::building -- it never reaches buildingEntry, so it renders through
// the WALLSFIX/TX16 material path (wallsfix_construction_test.mjs). This test asserts the negative:
// the planned override cannot leak onto the built-wall terrain path because it keys on the
// "Construction" BUILDING type, which a finished wall no longer has.
// =============================================================================================
section("built wall unchanged: the override is a building-type key, orthogonal to the terrain wall path", () => {
  // A finished wall would arrive as a terrain tile (ttname StoneWall/ConstructedWall...), never as
  // a {type:'Construction'} building; buildingEntry is only called for building records.
  assert.equal(T._plannedConstructionEntryForTest({ type: "StoneWall", subtype: 1 }), null,
    "a non-'Construction' type (however wall-ish) never triggers the planned override");
});

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nAll TX17 planned-construction checks passed.");
