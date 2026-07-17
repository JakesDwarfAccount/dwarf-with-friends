// wallsfix_construction_test.mjs -- acceptance for constructed WALLS, RAMPS, STAIRS and
// FORTIFICATIONS rendering from the built material rather than one generic grey sprite.
//
// B273 update: ramps are pre-colored and retain their material-channel multiply. The installed
// fortification sheets are 72-89% exact default-palette pixels, so fortifications now use the
// same exact material-row substitution as floors, stairs, and walls.
//
// Run: node tools/harness/wallsfix_construction_test.mjs

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
const DF_ROOT_W1 = dfRootOrSkip("wallsfix_construction_test.mjs");
const DF_GFX = path.join(DF_ROOT_W1, "data/vanilla/vanilla_environment/graphics/graphics_tiles.txt");

const gfxText = fs.readFileSync(DF_GFX, "utf8");
const availableTokens = new Set();
{
  const re = /TILE_GRAPHICS:[^:\]]+:\d+:\d+:([A-Z0-9_]+)/g;
  let m; while ((m = re.exec(gfxText))) availableTokens.add(m[1]);
}
for (const t of ["PALETTE_STAIR_UP", "PALETTE_STAIR_DOWN", "PALETTE_STAIR_UPDOWN",
                 "FORTIFICATION_OPEN_NSWE", "FORTIFICATION_WOOD_OPEN_NSWE", "STONE_RAMP_OTHER",
                 "METAL_FLOOR", "FLOOR_STONE_BLOCK", "WOOD_FLOOR",
                 "ROCK_BLOCKS_WALL_N_S_W_E", "WOODEN_WALL_N_S_W_E"]) {
  assert.ok(availableTokens.has(t), "oracle guard: DF graphics must define " + t);
}

function idxOf(id) { const a = realMaterialMap.inorganic; for (let i = 0; i < a.length; i++) if (a[i].id === id) return i; throw new Error("no inorganic id " + id); }
const IRON = idxOf("IRON"), GOLD = idxOf("GOLD"), COPPER = idxOf("COPPER"), MARBLE = idxOf("MARBLE"), ORTHOCLASE = idxOf("ORTHOCLASE");
const rowOf = (i) => realMaterialMap.inorganic[i].row;
const rgbOfRow = (r) => realMaterialMap.palette.rows[r][7];
const GLASS_GREEN_ROW = realMaterialMap.builtin["3"].row;
const GLASS_CLEAR_ROW = realMaterialMap.builtin["4"].row;
const WOOD_INDEX = realMaterialMap.plant_ids.indexOf("OAK");
const WOOD_ROW = realMaterialMap.plant.OAK.WOOD;
assert.ok(WOOD_INDEX >= 0 && typeof WOOD_ROW === "number", "OAK wood row fixture");
function sameRgb(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length >= 3 && b.length >= 3 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }

class FakeCanvasEl { constructor() { this.width = 800; this.height = 600; this.style = {}; } addEventListener() {} removeEventListener() {} getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); } }
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

const glbox = {}; glbox.self = glbox; glbox.performance = { now: () => 0 };
vm.createContext(glbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glbox, { filename: f });
}
const GL = glbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");
const glB = GL.createSceneBuilder({ materialMap: realMaterialMap });

let failed = 0;
function check(name, cond) { if (cond) console.log("  ok  - " + name); else { failed++; console.log("  FAIL- " + name); } }
function planEq(a, b) { if (!a && !b) return true; if (!a || !b) return false; return a.token === b.token && (a.palRow === b.palRow || (a.palRow == null && b.palRow == null)) && a.mask === b.mask && JSON.stringify(a.multiplyRgb || null) === JSON.stringify(b.multiplyRgb || null); }
function plan(ttname, mt, mi, openMask = 0) {
  const c = T._constructionFloorPlanForTest(ttname, mt, mi, openMask);
  const g = glB._constructionFloorPlanForTest(ttname, mt, mi, openMask);
  check("PARITY gl==c2d [" + ttname + " mt=" + mt + " mi=" + mi + " open=" + openMask + "]", planEq(c, g));
  return c;
}
const eqPlan = (p, token, palRow, mask) => !!p && p.token === token && (p.palRow === palRow || (p.palRow == null && palRow == null)) && p.mask === (mask || 0);

const MATS = [
  { name: "wood", mt: 419, mi: WOOD_INDEX },
  { name: "glass-green", mt: 3, mi: -1 },
  { name: "glass-clear", mt: 4, mi: -1 },
  { name: "metal-iron", mt: 0, mi: IRON },
  { name: "metal-gold", mt: 0, mi: GOLD },
  { name: "metal-copper", mt: 0, mi: COPPER },
  { name: "stone-marble", mt: 0, mi: MARBLE },
  { name: "stone-orthoclase", mt: 0, mi: ORTHOCLASE },
];

console.log("(1a) MATRIX -- RAMP uses STONE_RAMP_OTHER + material multiply tint");
for (const m of MATS) {
  const p = plan("ConstructedRamp", m.mt, m.mi);
  check("ConstructedRamp / " + m.name + " -> STONE_RAMP_OTHER", eqPlan(p, "STONE_RAMP_OTHER", null, 0));
  check("  ramp carries multiply tint when material RGB resolves", !!p && (T._consMaterialRgbForTest(m.mt, m.mi) == null || sameRgb(p.multiplyRgb, T._consMaterialRgbForTest(m.mt, m.mi))));
  check("  oracle: STONE_RAMP_OTHER exists", availableTokens.has("STONE_RAMP_OTHER"));
}
check("ConstructedRampTrackNS / iron carries the track mask (3) too", eqPlan(plan("ConstructedRampTrackNS", 0, IRON), "STONE_RAMP_OTHER", null, 3));

console.log("(1b) MATRIX -- STAIR up/down/updown -> PALETTE_STAIR_<kind> + per-material swap");
const stairCases = [["ConstructedStairU", "PALETTE_STAIR_UP"], ["ConstructedStairD", "PALETTE_STAIR_DOWN"], ["ConstructedStairUD", "PALETTE_STAIR_UPDOWN"]];
for (const [tt, tok] of stairCases) {
  check(tt + " / iron -> " + tok + " swap=" + rowOf(IRON), eqPlan(plan(tt, 0, IRON), tok, rowOf(IRON), 0));
  check(tt + " / marble -> " + tok + " swap=" + rowOf(MARBLE), eqPlan(plan(tt, 0, MARBLE), tok, rowOf(MARBLE), 0));
  check(tt + " / glass-green -> " + tok + " swap=builtin " + GLASS_GREEN_ROW, eqPlan(plan(tt, 3, -1), tok, GLASS_GREEN_ROW, 0));
  check(tt + " / WOOD -> " + tok + " species row=" + WOOD_ROW, eqPlan(plan(tt, 419, WOOD_INDEX), tok, WOOD_ROW, 0));
  check("  oracle: " + tok + " exists", availableTokens.has(tok));
}

console.log("(1c) MATRIX -- FORTIFICATION chooses open-face variant + exact material palette row");
for (const m of MATS) {
  const tok = (m.name === "wood") ? "FORTIFICATION_WOOD_OPEN_NSWE" : "FORTIFICATION_OPEN_NSWE";
  const p = plan("ConstructedFortification", m.mt, m.mi, 15);
  const mat = T._consMaterialForTest(m.mt, m.mi);
  const wantRow = mat && mat.palRow;
  check("ConstructedFortification / " + m.name + " -> " + tok, eqPlan(p, tok, wantRow, 0));
  check("  fort carries palette row, not a full-cell multiply", !!p && p.palRow === wantRow && p.multiplyRgb == null);
  check("  oracle: " + tok + " exists", availableTokens.has(tok));
}

console.log("(1d) MATRIX -- WALL edge family + per-material swap row");
function wallEq(mat, base_mt, base_mi, expectPrefix, expectPal) {
  const cp = T._wallPrefixForTest(mat, base_mt), gp = glB._wallPrefixForTest(mat, base_mt);
  check("wallPrefix parity [" + mat + " mt=" + base_mt + "]", cp === gp);
  check("wallPrefix(" + mat + ",mt=" + base_mt + ") == " + expectPrefix, cp === expectPrefix);
  const cr = T._wallJoinPalRowForTest({ mat, base_mt, base_mi });
  check("wallJoinPalRow(" + mat + ",mi=" + base_mi + ") == " + expectPal, cr === expectPal || (cr == null && expectPal == null));
}
wallEq("CONSTRUCTION", 0, IRON, "ROCK_BLOCKS_WALL", rowOf(IRON));
wallEq("CONSTRUCTION", 0, MARBLE, "ROCK_BLOCKS_WALL", rowOf(MARBLE));
wallEq("CONSTRUCTION", 3, -1, "ROCK_BLOCKS_WALL", GLASS_GREEN_ROW);
wallEq("CONSTRUCTION", 419, WOOD_INDEX, "WOODEN_WALL", WOOD_ROW);
wallEq("SOIL", 0, idxOf("CLAY"), "SOIL_WALL", rowOf(idxOf("CLAY")));
wallEq("STONE", 0, IRON, "STONE_WALL", null);        // invalid natural pairing: metal is not layer stone

console.log("(1e) consMaterialRgb -- material multiply/fill RGB");
{
  const c = T._consMaterialRgbForTest(0, IRON), g = glB._consMaterialRgbForTest(0, IRON);
  const expect = rgbOfRow(rowOf(IRON));
  check("consMaterialRgb(iron) == palette row[7] gl==c2d", sameRgb(c, expect) && JSON.stringify(c) === JSON.stringify(g));
  const cw = T._consMaterialRgbForTest(420, 7);
  check("consMaterialRgb(unresolved plant wood) == generic wood brown [150,120,84]", JSON.stringify(cw) === JSON.stringify([150, 120, 84]));
  check("consMaterialRgb(unresolved inorganic) == null (no invented fill)", T._consMaterialRgbForTest(0, 999999) === null);
}

console.log("(4) TEST-THE-TEST: seeded pre-fix behaviours must FAIL here");
check("[seed-grey] iron ramp is the base ramp token but CARRIES multiply tint", plan("ConstructedRamp", 0, IRON).token === "STONE_RAMP_OTHER" && sameRgb(plan("ConstructedRamp", 0, IRON).multiplyRgb, rgbOfRow(rowOf(IRON))));
check("[seed-grey] iron stair is NOT the fixed-stone STONE_STAIR_UP token", plan("ConstructedStairU", 0, IRON).token !== "STONE_STAIR_UP");
check("[seed-grey] iron stair CARRIES a palette swap (pre-fix had none)", typeof plan("ConstructedStairU", 0, IRON).palRow === "number");
check("[seed-mask] open fortification is NOT the plain FORTIFICATION token", plan("ConstructedFortification", 0, GOLD, 15).token !== "FORTIFICATION");
check("[seed-grey] iron constructed wall edge is palette-swapped (pre-fix drew grey ROCK_BLOCKS)", typeof T._wallJoinPalRowForTest({ mat: "CONSTRUCTION", base_mt: 0, base_mi: IRON }) === "number");

console.log("(5) NON-AUTHOR COUNTEREXAMPLES: do not invent colour the wire/native does not give");
check("no wire material (base_mt=-1) -> null (all shapes fall to token-map default)",
  plan("ConstructedRamp", -1, -1) === null && plan("ConstructedStairU", -1, -1) === null && plan("ConstructedFortification", -1, -1) === null);
check("out-of-range inorganic ramp -> STONE_RAMP_OTHER, no tint (neutral default, not invented)",
  (() => { const p = plan("ConstructedRamp", 0, 999999); return eqPlan(p, "STONE_RAMP_OTHER", null, 0) && p.multiplyRgb == null; })());
check("out-of-range inorganic stair -> PALETTE_STAIR + palRow null (renders neutral, no wrong colour)",
  eqPlan(plan("ConstructedStairU", 0, 999999), "PALETTE_STAIR_UP", null, 0));
check("out-of-range inorganic wall -> null palRow (grey default edge, not invented)",
  T._wallJoinPalRowForTest({ mat: "CONSTRUCTION", base_mt: 0, base_mi: 999999 }) == null);
check("non-construction ttnames -> null (override only fires for constructions)",
  plan("StoneWall", 0, IRON) === null && plan("SoilFloor2", 0, MARBLE) === null && plan("Ramp", 0, IRON) === null);
check("natural stair ttname (UpStair) -> null (only CONSTRUCTED stairs recolour)", plan("UpStair", 0, IRON) === null);

console.log("(6) REGRESSION: b47 FLOOR cells unchanged by the broadened plan");
check("ConstructedFloor / iron -> METAL_FLOOR + rowOf(IRON) (unchanged)", eqPlan(plan("ConstructedFloor", 0, IRON), "METAL_FLOOR", rowOf(IRON), 0));
check("ConstructedFloorTrackNSEW / marble -> FLOOR_STONE_BLOCK mask 15 (unchanged)", eqPlan(plan("ConstructedFloorTrackNSEW", 0, MARBLE), "FLOOR_STONE_BLOCK", rowOf(MARBLE), 15));

if (failed) { console.error("\nFAILED: " + failed + " checks"); process.exit(1); }
console.log("\nAll WALLSFIX construction checks passed.");
