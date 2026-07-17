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

// construction_remainder_test.mjs -- offline guards for the final construction-remainder deck.
// Covers fortification open-face variant selection, material multiply tint, b47 floor controls,
// seeded-bad checks, and canvas2d/GL parity without launching DF or a browser.
//
// Run: node tools/harness/construction_remainder_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { dfRootOrSkip } from "../lib/dfroot.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const realMaterialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));
const review = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/construction-remainder-review.json"), "utf8"));
// W1: resolved, never hardcoded. No DF install -> this suite SKIPs (exit 0),
// because its ground truth IS the raws: without them there is nothing to check against.
const DF_ROOT_W1 = dfRootOrSkip("construction_remainder_test.mjs");
const DF_GFX = path.join(DF_ROOT_W1, "data/vanilla/vanilla_environment/graphics/graphics_tiles.txt");
const gfxText = fs.readFileSync(DF_GFX, "utf8");

const tokenCells = new Map();
{
  const re = /TILE_GRAPHICS:([^:\]]+):(\d+):(\d+):([A-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(gfxText))) tokenCells.set(m[4], { sheet: m[1], col: Number(m[2]), row: Number(m[3]) });
}
function rawCell(token) { const c = tokenCells.get(token); assert.ok(c, "DF graphics raw must define " + token); return c; }

function idxOf(id) { const a = realMaterialMap.inorganic; for (let i = 0; i < a.length; i++) if (a[i].id === id) return i; throw new Error("no inorganic id " + id); }
const IRON = idxOf("IRON");
const GOLD = idxOf("GOLD");
const MARBLE = idxOf("MARBLE");
const MICROCLINE = idxOf("MICROCLINE");
const OAK = realMaterialMap.plant_ids.indexOf("OAK");
const MANGROVE = realMaterialMap.plant_ids.indexOf("MANGROVE");
assert.notEqual(OAK, -1, "material_map plant_ids must include OAK");
assert.notEqual(MANGROVE, -1, "material_map plant_ids must include MANGROVE");
const rowOf = (i) => realMaterialMap.inorganic[i].row;
const rgbOfRow = (r) => realMaterialMap.palette.rows[r][7];
function plantWoodRgb(id) { return rgbOfRow(realMaterialMap.plant[id].WOOD); }
function sameRgb(a, b) { return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }
function planEq(a, b) { if (!a && !b) return true; if (!a || !b) return false; return a.token === b.token && (a.palRow === b.palRow || (a.palRow == null && b.palRow == null)) && a.mask === b.mask && JSON.stringify(a.multiplyRgb || null) === JSON.stringify(b.multiplyRgb || null); }

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
function check(name, cond) { if (cond) console.log("  ok - " + name); else { failed++; console.log("  FAIL - " + name); } }
function plan(ttname, mt, mi, openMask = 0) {
  const c = T._constructionFloorPlanForTest(ttname, mt, mi, openMask);
  const g = glB._constructionFloorPlanForTest(ttname, mt, mi, openMask);
  check("gl==c2d " + ttname + " mt=" + mt + " mi=" + mi + " open=" + openMask, planEq(c, g));
  return c;
}

console.log("(0) Review deck enumeration guard");
const reviewCards = Array.isArray(review) ? review : review.cards;
assert.ok(Array.isArray(reviewCards), "review JSON must be an array or {cards}");
const broken = reviewCards.filter((c) => c.verdict === "broken" && /^cons\|(?:fortification|ramp|floor)\|/.test(c.ident));
const counts = new Map();
for (const c of broken) counts.set(c.ident.split("|")[1], (counts.get(c.ident.split("|")[1]) || 0) + 1);
check("the owner construction remainder has 83 cards", broken.length === 83);
check("fortification/ramp/floor counts are 48/19/16", counts.get("fortification") === 48 && counts.get("ramp") === 19 && counts.get("floor") === 16);

console.log("(1) Fortification open-neighbour variants match native graphics raw tokens/cells");
const fortCases = [
  { mask: 15, token: "FORTIFICATION_OPEN_NSWE", sheet: "FORTIFICATION", col: 2, row: 0 },
  { mask: 3, token: "FORTIFICATION_OPEN_NS", sheet: "FORTIFICATION", col: 1, row: 0 },
  { mask: 12, token: "FORTIFICATION_OPEN_WE", sheet: "FORTIFICATION", col: 0, row: 0 },
  // Asymmetric masks: adjacency bits are N=1,S=2,W=4,E=8, and the raw _OPEN_<letters> art
  // carves its openings on exactly the named edges -- so the suffix letters must equal the
  // set bits (the original E/W-mirrored table shipped mask 9 (N|E) as _OPEN_NW, etc.).
  { mask: 9, token: "FORTIFICATION_OPEN_NE", sheet: "FORTIFICATION", col: 3, row: 2 },
  { mask: 5, token: "FORTIFICATION_OPEN_NW", sheet: "FORTIFICATION", col: 2, row: 2 },
  { mask: 10, token: "FORTIFICATION_OPEN_SE", sheet: "FORTIFICATION", col: 0, row: 2 },
  { mask: 6, token: "FORTIFICATION_OPEN_SW", sheet: "FORTIFICATION", col: 1, row: 2 },
  { mask: 11, token: "FORTIFICATION_OPEN_NSE", sheet: "FORTIFICATION", col: 0, row: 1 },
  { mask: 7, token: "FORTIFICATION_OPEN_NSW", sheet: "FORTIFICATION", col: 2, row: 1 },
  { mask: 13, token: "FORTIFICATION_OPEN_NWE", sheet: "FORTIFICATION", col: 3, row: 1 },
  { mask: 14, token: "FORTIFICATION_OPEN_SWE", sheet: "FORTIFICATION", col: 1, row: 1 },
  { mask: 15, prefix: "FORTIFICATION_WOOD", token: "FORTIFICATION_WOOD_OPEN_NSWE", sheet: "FORTIFICATION_WOOD", col: 2, row: 0 },
];
for (const f of fortCases) {
  const prefix = f.prefix || "FORTIFICATION";
  const raw = rawCell(f.token);
  check(f.token + " raw texpos " + f.sheet + ":" + f.col + "," + f.row, raw.sheet === f.sheet && raw.col === f.col && raw.row === f.row);
  check("canvas2d helper " + prefix + " mask=" + f.mask + " -> " + f.token, T._fortificationOpenTokenForTest(prefix, f.mask) === f.token);
  check("GL helper " + prefix + " mask=" + f.mask + " -> " + f.token, glB._fortificationOpenTokenForTest(prefix, f.mask) === f.token);
  const p = plan("ConstructedFortification", prefix.endsWith("WOOD") ? 420 : 0, prefix.endsWith("WOOD") ? OAK : IRON, f.mask);
  check("plan emits " + f.token, p && p.token === f.token);
}
check("seeded bad: ignoring mask would have produced plain FORTIFICATION", plan("ConstructedFortification", 0, IRON, 15).token !== "FORTIFICATION");

console.log("(2) Multiply tint RGB for material classes");
const tintCases = [
  { name: "iron", mt: 0, mi: IRON, rgb: rgbOfRow(rowOf(IRON)) },
  { name: "microcline", mt: 0, mi: MICROCLINE, rgb: rgbOfRow(rowOf(MICROCLINE)) },
  { name: "glass-green", mt: 3, mi: -1, rgb: rgbOfRow(realMaterialMap.builtin["3"].row) },
  { name: "oak wood", mt: 420, mi: OAK, rgb: plantWoodRgb("OAK") },
  { name: "mangrove wood", mt: 420, mi: MANGROVE, rgb: plantWoodRgb("MANGROVE") },
];
for (const t of tintCases) {
  check("consMaterialRgb " + t.name, sameRgb(T._consMaterialRgbForTest(t.mt, t.mi), t.rgb) && sameRgb(glB._consMaterialRgbForTest(t.mt, t.mi), t.rgb));
  const ramp = plan("ConstructedRamp", t.mt, t.mi);
  check("ramp multiply tint " + t.name, ramp && ramp.token === "STONE_RAMP_OTHER" && sameRgb(ramp.multiplyRgb, t.rgb));
  // B273 (2026-07-14): fortifications NO LONGER carry a whole-sprite multiply. DF colours its
  // premium art by PALETTE SUBSTITUTION -- a material's STATE_COLOR selects one of 137 descriptor
  // rows and DF swaps the exact default-ramp pixels for that row's. The fortification sheets are
  // 72-89% exact default-palette pixels (measured), so they now take the palette row, and the
  // approximate multiply -- which also mangled the 11-28% of NON-palette detail pixels -- is gone.
  // This cell used to assert the multiply, i.e. it pinned the LESS CORRECT behaviour. Assert the
  // real contract instead: a fortification with a known material resolves a palette ROW.
  const fort = plan("ConstructedFortification", t.mt, t.mi, 15);
  check("fort palette row " + t.name,
    fort && typeof T._wallJoinPalRowForTest({ mat: "CONSTRUCTION", base_mt: t.mt, base_mi: t.mi }) === "number");
}
check("seeded bad: ramp tint skipped is detected", !!plan("ConstructedRamp", 0, GOLD).multiplyRgb);
check("seeded bad: fort with NO wire material resolves no palette row (cannot silently default)",
  T._wallJoinPalRowForTest({ mat: "CONSTRUCTION", base_mt: -1, base_mi: -1 }) === null);

console.log("(3) known-good construction controls remain unchanged");
let p = plan("ConstructedFloor", 0, IRON);
check("ConstructedFloor iron stays METAL_FLOOR + iron palRow", p && p.token === "METAL_FLOOR" && p.palRow === rowOf(IRON) && p.mask === 0 && p.multiplyRgb == null);
p = plan("ConstructedFloorTrackNSEW", 0, MARBLE);
check("ConstructedFloorTrackNSEW marble stays FLOOR_STONE_BLOCK + mask 15", p && p.token === "FLOOR_STONE_BLOCK" && p.palRow === rowOf(MARBLE) && p.mask === 15 && p.multiplyRgb == null);
p = plan("ConstructedStairU", 0, IRON);
check("ConstructedStairU still palette-swaps the stair sheet", p && p.token === "PALETTE_STAIR_UP" && p.palRow === rowOf(IRON) && p.multiplyRgb == null);

console.log("(4) No invented RGB for generated/out-of-range inorganics");
p = plan("ConstructedRamp", 0, 999999);
check("unresolved inorganic ramp keeps base sprite but no tint", p && p.token === "STONE_RAMP_OTHER" && p.multiplyRgb == null);
p = plan("ConstructedFortification", 0, 999999, 15);
check("unresolved inorganic fort keeps native variant but no tint", p && p.token === "FORTIFICATION_OPEN_NSWE" && p.multiplyRgb == null);

if (failed) { console.error("\nFAILED: " + failed + " checks"); process.exit(1); }
console.log("\nAll construction-remainder checks passed.");
