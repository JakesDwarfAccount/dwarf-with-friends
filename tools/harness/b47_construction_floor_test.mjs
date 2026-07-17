// b47_construction_floor_test.mjs -- acceptance for B47 material-family CONSTRUCTION FLOOR/TRACK
// art (the full-range native cons:floor 51/51 + cons:track_ns/nsew 51/51 top-decile finding).
//
// ROOT CAUSE under test: the offline tiletype_token_map is material-BLIND (its enum `material`
// attr is just "CONSTRUCTION"), so EVERY constructed floor/track routed to the single grey
// FLOOR_STONE_BLOCK. DF actually draws the BUILT-FROM material's own floor sheet -- wood parquet
// (WOOD_FLOOR), metal diamond-plate (METAL_FLOOR) recolored per-metal, glass variants
// (GLASS_{GREEN,CLEAR,CRYSTAL}_FLOOR), dressed stone (FLOOR_STONE_BLOCK) recolored per-stone. The
// built-from material rides the wire per-tile (base_mt/base_mi, src/wire_v1.cpp B47). This test
// proves, WITHOUT a browser, that the client's material-family PLAN (constructionFloorPlan)
// reproduces that mapping:
//   (1) MATRIX (protocol rule 1): every shape {floor, track_ns, track_nsew, shoddy} x every
//       material family {wood, metal(iron/gold/copper), glass(green/clear/crystal), stone
//       (marble/orthoclase)} -> the native art class token + the per-material palette row.
//   (2) ORACLE-DIFFERENTIAL (rule 2): every token the plan emits EXISTS in DF's own graphics
//       raws (graphics_tiles.txt) -- never a fabricated cell.
//   (3) PARITY: canvas2d (dwf-tiles.js) and GL (dwf-gl.js) produce BYTE-IDENTICAL
//       plans for every matrix cell -- the anti-drift guard for the mirrored resolver.
//   (4) TEST-THE-TEST (rule 3): the material-BLIND behaviour (every floor -> FLOOR_STONE_BLOCK,
//       the pre-fix bug) is asserted to FAIL here for wood/metal/glass.
//   (5) NON-AUTHOR COUNTEREXAMPLE (rule 5): base_mt<0 (no wire material) -> null (falls to the
//       stone default, NOT invented art); a STONE construction -> FLOOR_STONE_BLOCK (DF's real
//       dressed-block look for stone, not a fabricated per-stone sprite -- stone floors differ
//       from wood/metal only by palette color, which the plan carries as palRow).
//   (6) TRACK MASK: the ttname direction suffix -> the DESIG_TRACK_CELL adjacency mask, over the
//       full set of direction subsets (N=1 S=2 E=4 W=8), gl==c2d.
//
// Run: node tools/harness/b47_construction_floor_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { dfRootOrSkip } from "../lib/dfroot.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const realMaterialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));
// W1: resolved, never hardcoded. No DF install -> this suite SKIPs (exit 0),
// because its ground truth IS the raws: without them there is nothing to check against.
const DF_ROOT_W1 = dfRootOrSkip("b47_construction_floor_test.mjs");
const DF_GFX = path.join(DF_ROOT_W1, "data/vanilla/vanilla_environment/graphics/graphics_tiles.txt");

// ---- oracle: the TOKENs that actually exist in DF's graphics raws (read-only) --------------
const gfxText = fs.readFileSync(DF_GFX, "utf8");
const availableTokens = new Set();
{
  const re = /TILE_GRAPHICS:[^:\]]+:\d+:\d+:([A-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(gfxText))) availableTokens.add(m[1]);
}
for (const t of ["FLOOR_STONE_BLOCK", "WOOD_FLOOR", "METAL_FLOOR", "GLASS_GREEN_FLOOR", "GLASS_CLEAR_FLOOR", "GLASS_CRYSTAL_FLOOR"]) {
  assert.ok(availableTokens.has(t), "oracle guard: DF graphics_tiles.txt must define token " + t);
}

// ---- fixture guards (fail loudly if the committed material map drifts) ----------------------
assert.equal(realMaterialMap.inorganic[0].id, "IRON", "material_map inorganic[0] must be IRON");
function idxOf(id) {
  const a = realMaterialMap.inorganic;
  for (let i = 0; i < a.length; i++) if (a[i].id === id) return i;
  throw new Error("no inorganic id " + id);
}
const IRON = 0;
const GOLD = idxOf("GOLD");
const COPPER = idxOf("COPPER");
const MARBLE = idxOf("MARBLE");
const ORTHOCLASE = idxOf("ORTHOCLASE");
assert.equal(realMaterialMap.inorganic[IRON].family, "METAL");
assert.equal(realMaterialMap.inorganic[GOLD].family, "METAL");
assert.equal(realMaterialMap.inorganic[MARBLE].family, "STONE");
const rowOf = (i) => realMaterialMap.inorganic[i].row;

// ============================ canvas2d (dwf-tiles.js) =================================
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
}
const storageBacking = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { width: 0, height: 0, style: {}, getContext() { return { imageSmoothingEnabled: true, drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(32 * 32 * 4) }; }, putImageData() {} }; } }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: (k) => (k in storageBacking ? storageBacking[k] : null), setItem: (k, v) => { storageBacking[k] = String(v); } };
globalThis.Image = class { constructor() { this.onload = null; this.onerror = null; this.width = 32; this.height = 32; } set src(v) {} get src() { return ""; } };
globalThis.fetch = async () => ({ ok: false, json: async () => null });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), { filename: "dwf-tiles.js" });
const T = globalThis.DwfTiles;
assert.ok(T, "dwf-tiles.js did not install DwfTiles");
T.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });
T._setMaterialMapForTest(realMaterialMap);

// ============================ GL (dwf-gl.js) =========================================
const glbox = {}; glbox.self = glbox; glbox.performance = { now: () => 0 };
vm.createContext(glbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glbox, { filename: f });
}
const GL = glbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");
const glB = GL.createSceneBuilder({ materialMap: realMaterialMap });

let failed = 0;
function check(name, cond) { if (cond) console.log("  ok - " + name); else { failed++; console.log("  FAIL - " + name); } }
function planEq(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.token === b.token && (a.palRow === b.palRow || (a.palRow == null && b.palRow == null)) && a.mask === b.mask;
}
// evaluate BOTH renderers' pure plan and assert byte-parity, return the (agreed) plan
function plan(ttname, mt, mi) {
  const c = T._constructionFloorPlanForTest(ttname, mt, mi);
  const g = glB._constructionFloorPlanForTest(ttname, mt, mi);
  check("PARITY gl==c2d for [" + ttname + " mt=" + mt + " mi=" + mi + "]", planEq(c, g));
  return c;
}

console.log("(1) MATRIX: shape x material family -> native art token + per-material palette row");
const SHAPES = [
  { tt: "ConstructedFloor", mask: 0 },
  { tt: "ShoddyConstructedFloor1", mask: 0 },
  { tt: "ConstructedFloorTrackNS", mask: 3 },
  { tt: "ConstructedFloorTrackNSEW", mask: 15 },
];
const MATS = [
  { name: "wood", mt: 420, mi: 7, token: "WOOD_FLOOR", palRow: null },
  { name: "glass-green", mt: 3, mi: 0, token: "GLASS_GREEN_FLOOR", palRow: null },
  { name: "glass-clear", mt: 4, mi: 0, token: "GLASS_CLEAR_FLOOR", palRow: null },
  { name: "glass-crystal", mt: 5, mi: 0, token: "GLASS_CRYSTAL_FLOOR", palRow: null },
  { name: "metal-iron", mt: 0, mi: IRON, token: "METAL_FLOOR", palRow: rowOf(IRON) },
  { name: "metal-gold", mt: 0, mi: GOLD, token: "METAL_FLOOR", palRow: rowOf(GOLD) },
  { name: "metal-copper", mt: 0, mi: COPPER, token: "METAL_FLOOR", palRow: rowOf(COPPER) },
  { name: "stone-marble", mt: 0, mi: MARBLE, token: "FLOOR_STONE_BLOCK", palRow: rowOf(MARBLE) },
  { name: "stone-orthoclase", mt: 0, mi: ORTHOCLASE, token: "FLOOR_STONE_BLOCK", palRow: rowOf(ORTHOCLASE) },
];
for (const s of SHAPES) {
  for (const mat of MATS) {
    const p = plan(s.tt, mat.mt, mat.mi);
    check(s.tt + " / " + mat.name + " -> " + mat.token + " palRow=" + mat.palRow + " mask=" + s.mask,
      !!p && p.token === mat.token && (p.palRow === mat.palRow || (p.palRow == null && mat.palRow == null)) && p.mask === s.mask);
    // (2) ORACLE-DIFFERENTIAL: the emitted token exists in DF's own graphics raws
    check("  oracle: token " + mat.token + " exists in graphics_tiles.txt", availableTokens.has(mat.token));
    // metal must recolor (palRow present); gold != iron proves it's PER-metal not one grey
    if (mat.name === "metal-gold") check("  gold palRow != iron palRow (per-metal recolor)", p.palRow !== rowOf(IRON));
  }
}

console.log("(4) TEST-THE-TEST: the material-blind pre-fix behaviour must FAIL here");
check("[seed-wrong] wood floor plan is NOT the grey stone default (would be the old bug)",
  plan("ConstructedFloor", 420, 7).token !== "FLOOR_STONE_BLOCK");
check("[seed-wrong] gold floor plan is NOT the grey stone default",
  plan("ConstructedFloor", 0, GOLD).token !== "FLOOR_STONE_BLOCK");
check("[seed-wrong] glass floor plan is NOT the grey stone default",
  plan("ConstructedFloor", 3, 0).token !== "FLOOR_STONE_BLOCK");

console.log("(5) NON-AUTHOR COUNTEREXAMPLE: don't invent art where the wire/native gives none");
check("no wire material (base_mt=-1) -> null (falls to token-map stone default, not invented art)",
  plan("ConstructedFloor", -1, -1) === null);
check("stone (marble) -> FLOOR_STONE_BLOCK (DF's real dressed block for stone, not a fake sprite)",
  plan("ConstructedFloor", 0, MARBLE).token === "FLOOR_STONE_BLOCK");
check("non-construction ttname (SoilFloor2) -> null (override only fires for constructions)",
  plan("SoilFloor2", 0, MARBLE) === null && plan("StoneWall", 0, IRON) === null);
check("out-of-range inorganic index -> STONE default, palRow null (no crash, no wrong guess)",
  (() => { const p = plan("ConstructedFloor", 0, 999999); return !!p && p.token === "FLOOR_STONE_BLOCK" && p.palRow == null; })());

console.log("(6) TRACK MASK: ttname direction suffix -> DESIG_TRACK_CELL adjacency mask (N1 S2 E4 W8)");
const DIRVAL = { N: 1, S: 2, E: 4, W: 8 };
// every non-empty subset of N,S,E,W in the DF-canonical NSEW spelling
const DIRS = ["N", "S", "E", "W"];
let maskCases = 0;
for (let bits = 1; bits < 16; bits++) {
  let suffix = "", expect = 0;
  for (let i = 0; i < 4; i++) if (bits & (1 << i)) { suffix += DIRS[i]; expect |= DIRVAL[DIRS[i]]; }
  const tt = "ConstructedFloorTrack" + suffix;
  const c = T._constructionTrackMaskForTest(tt);
  const g = glB._constructionTrackMaskForTest(tt);
  check("mask(" + tt + ")=" + expect + " gl==c2d", c === expect && g === expect);
  maskCases++;
}
check("track-mask matrix covered all 15 direction subsets", maskCases === 15);
check("plain ConstructedFloor has mask 0 (no rail overlay)", T._constructionTrackMaskForTest("ConstructedFloor") === 0);

if (failed) { console.error("\nFAILED: " + failed + " checks"); process.exit(1); }
console.log("\nAll b47 construction-floor checks passed.");
