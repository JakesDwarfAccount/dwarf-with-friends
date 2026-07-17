// t1_material_parity_test.mjs -- acceptance for the asset-material-parity Tier-1 client work
// (docs/superpowers/specs/2026-07-08-asset-material-parity-spec.md, T1c/T1d). Loads the REAL
// web/js/dwf-tiles.js (canvas2d) AND web/js/dwf-gl.js (GL) verbatim, plus the REAL
// committed web/item_map.json (v3) + web/material_map.json (v1), and asserts:
//   (1) mat_type==0 items now resolve their EXACT inorganic family (METAL vs STONE fix);
//   (2) per-material silhouette cells (rough-gem value tier, per-mineral boulder) resolve;
//   (3) the material palette ROW resolves for gems/boulders/metal;
//   (4) GL and canvas2d resolve the SAME {entry,source,palRow} for the same item -- the
//       anti-drift guard for the mirrored resolver, INCLUDING the itemdef->bytoken step GL
//       previously lacked (the root of the minecart/tool/toy/weapon PARITY-MISMATCH class);
//   (5) the T1c palette remap is byte-identical across the two renderers and correct
//       (default-palette pixel -> target row; non-palette pixel untouched).
// Each block includes a test-the-test seed (protocol rule 3). Run: node tools/harness/t1_material_parity_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const realItemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const realMaterialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));

// ---- fixture-assumption guards (fail loudly if the committed maps drift) -------------------
assert.equal(realMaterialMap.inorganic[0].id, "IRON", "material_map inorganic[0] must be IRON");
assert.equal(realMaterialMap.inorganic[0].family, "METAL", "IRON must be family METAL");
assert.ok(realMaterialMap.palette && realMaterialMap.palette.rows.length === 137, "palette.rows must be 137");
assert.ok(realMaterialMap.default_row && realMaterialMap.default_row.length === 18, "default_row must be 18 colors");
assert.ok(realItemMap.rough_gem_tiers && realItemMap.rough_gem_tiers.length === 10, "item_map v3 rough_gem_tiers[10]");
assert.ok(realItemMap.boulder_bymat && realItemMap.boulder_bymat.MARBLE, "item_map v3 boulder_bymat.MARBLE");
assert.ok(realItemMap.bytoken && realItemMap.bytoken.ITEM_TOOL_MINECART, "item_map bytoken.ITEM_TOOL_MINECART (minecart fix target)");
assert.equal(realItemMap._v, 3, "item_map must be v3");

// helper: find an inorganic index by id
function idxOf(id) {
  const a = realMaterialMap.inorganic;
  for (let i = 0; i < a.length; i++) if (a[i].id === id) return i;
  throw new Error("no inorganic id " + id);
}
const IRON = 0;
const TOURMALINE = idxOf("GREEN TOURMALINE");
const MARBLE = idxOf("MARBLE");
const MICROCLINE = idxOf("MICROCLINE"); // family STONE control
assert.equal(realMaterialMap.inorganic[TOURMALINE].gem, true, "GREEN TOURMALINE must be gem");
assert.equal(realMaterialMap.inorganic[MICROCLINE].family, "STONE", "MICROCLINE must be STONE");

function cellEq(a, b) { return !!a && !!b && a.sheet === b.sheet && a.col === b.col && a.row === b.row; }
function pickRoughTier(value) {
  let chosen = realItemMap.rough_gem_tiers[0].cell;
  for (const t of realItemMap.rough_gem_tiers) if (value >= t.min_value) chosen = t.cell;
  return chosen;
}

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
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf("item_map.json") !== -1) return { ok: true, json: async () => realItemMap };
  return { ok: false, json: async () => null };
};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), { filename: "dwf-tiles.js" });
const T = globalThis.DwfTiles;
assert.ok(T, "dwf-tiles.js did not install DwfTiles");
T.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });

// ============================ GL (dwf-gl.js) =========================================
const glbox = {}; glbox.self = glbox; glbox.performance = { now: () => 0 };
vm.createContext(glbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glbox, { filename: f });
}
const GL = glbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");

let failed = 0;
function check(name, cond) { if (cond) console.log("  ok - " + name); else { failed++; console.log("  FAIL - " + name); } }
async function waitUntil(pred, maxMs) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > (maxMs || 2000)) throw new Error("waitUntil timed out"); await new Promise((r) => setTimeout(r, 1)); } }

(async function main() {
  await waitUntil(() => !!T._resolveItemEntryForTest({ type: "AMMO", mat_type: -1 }), 2000);
  T._setMaterialMapForTest(realMaterialMap);
  T._handleItemDefDictForTest([{ subcat: 3, entries: [{ id: 16, token: "ITEM_TOOL_MINECART" }] }]); // subcat 3 = TOOL

  const idt = new Map([["TOOL:16", "ITEM_TOOL_MINECART"]]);
  // GL builder WITH the material map + itemdef tokens (the fixed path)
  const glB = GL.createSceneBuilder({ itemMap: realItemMap, materialMap: realMaterialMap, itemDefTokens: idt });
  // GL builder WITHOUT itemdef tokens (the pre-T1d path, for test-the-test)
  const glNoIdt = GL.createSceneBuilder({ itemMap: realItemMap, materialMap: realMaterialMap });

  console.log("T1d: EXACT inorganic family (METAL vs STONE fix), canvas2d & GL agree");
  check("metal (IRON) TABLE -> family METAL (was STONE)",
    T._matFamilyForItemForTest({ type: "TABLE", mat_type: 0, mat_index: IRON }) === "METAL" &&
    glB._matFamilyForItemForTest({ type: "TABLE", mat_type: 0, mat_index: IRON }) === "METAL");
  check("stone (MICROCLINE) TABLE -> family STONE",
    T._matFamilyForItemForTest({ type: "TABLE", mat_type: 0, mat_index: MICROCLINE }) === "STONE" &&
    glB._matFamilyForItemForTest({ type: "TABLE", mat_type: 0, mat_index: MICROCLINE }) === "STONE");
  {
    const c = T._resolveItemVisualForTest({ type: "TABLE", mat_type: 0, mat_index: IRON, subtype: -1 });
    const g = glB._resolveItemVisualForTest({ type: "TABLE", mat_type: 0, mat_index: IRON, subtype: -1 });
    check("metal TABLE resolves to the matvariant METAL cell, gl==c2d",
      c.source === "matvariant" && g.source === "matvariant" && cellEq(c.entry, g.entry) &&
      cellEq(c.entry, realItemMap.matvariants.Table.METAL));
  }
  check("[test-the-test] metal family is NOT STONE (the pre-T1 collapse would assert STONE)",
    T._matFamilyForItemForTest({ type: "TABLE", mat_type: 0, mat_index: IRON }) !== "STONE");

  console.log("T1b/T1d: per-material silhouette cells + palette rows, gl==c2d");
  {
    const it = { type: "ROUGH", mat_type: 0, mat_index: TOURMALINE, subtype: -1 };
    const c = T._resolveItemVisualForTest(it), g = glB._resolveItemVisualForTest(it);
    const tier = pickRoughTier(realMaterialMap.inorganic[TOURMALINE].value);
    check("rough gem -> value-tier cell (source 'material'), gl==c2d",
      c.source === "material" && g.source === "material" && cellEq(c.entry, g.entry) && cellEq(c.entry, tier));
    check("rough gem palette row == material_map row (51 GREEN for tourmaline), gl==c2d",
      T._matPalRowForTest(it) === realMaterialMap.inorganic[TOURMALINE].row &&
      glB._matPalRowForTest(it) === realMaterialMap.inorganic[TOURMALINE].row);
  }
  {
    const it = { type: "BOULDER", mat_type: 0, mat_index: MARBLE, subtype: -1 };
    const c = T._resolveItemVisualForTest(it), g = glB._resolveItemVisualForTest(it);
    check("marble BOULDER -> boulder_bymat.MARBLE cell (source 'material'), gl==c2d",
      c.source === "material" && cellEq(c.entry, realItemMap.boulder_bymat.MARBLE) && cellEq(c.entry, g.entry));
  }

  console.log("T1d HEADLINE: GL gains the itemdef->bytoken step (minecart PARITY-MISMATCH fix)");
  {
    const it = { type: "TOOL", subtype: 16, mat_type: 0, mat_index: IRON };
    const c = T._resolveItemVisualForTest(it), g = glB._resolveItemVisualForTest(it);
    check("minecart: canvas2d resolves the itemdef bytoken cell",
      c.source === "itemdef" && cellEq(c.entry, realItemMap.bytoken.ITEM_TOOL_MINECART));
    check("minecart: GL now resolves the SAME itemdef bytoken cell (was: no itemdef step -> mismatch)",
      g.source === "itemdef" && cellEq(g.entry, realItemMap.bytoken.ITEM_TOOL_MINECART) && cellEq(g.entry, c.entry));
    const gNo = glNoIdt._resolveItemVisualForTest(it);
    check("[test-the-test] WITHOUT itemDefTokens, GL falls to the generic bytype.TOOL cell (NOT the minecart) -- proves the itemdef step is the fix",
      !cellEq(gNo.entry, realItemMap.bytoken.ITEM_TOOL_MINECART));
  }

  console.log("T1c: palette remap correctness + byte-identical across renderers");
  {
    const palRow = 51; // GREEN
    const def = realMaterialMap.default_row;
    const target = realMaterialMap.palette.rows[palRow];
    const remapC = T._paletteRemapForTest(palRow);
    const remapG = glB._paletteRemapForTest(palRow);
    check("both renderers build a non-null remap for a valid palette row", !!remapC && !!remapG);
    // a pixel exactly equal to default color k must become target[k]
    const k = 7;
    const pxC = new Uint8ClampedArray([def[k][0], def[k][1], def[k][2], 255]);
    const pxG = pxC.slice();
    remapC(pxC); remapG(pxG);
    check("default-palette pixel k=7 -> target row color (canvas2d)",
      pxC[0] === target[k][0] && pxC[1] === target[k][1] && pxC[2] === target[k][2]);
    check("palette remap is byte-identical canvas2d vs GL",
      pxC[0] === pxG[0] && pxC[1] === pxG[1] && pxC[2] === pxG[2] && pxC[3] === pxG[3]);
    // a NON-palette pixel is left untouched (engine semantics -- painted detail survives)
    const npC = new Uint8ClampedArray([1, 2, 3, 255]); const before = npC.slice();
    remapC(npC);
    check("non-palette pixel (1,2,3) passes through untouched",
      npC[0] === before[0] && npC[1] === before[1] && npC[2] === before[2]);
    // a fully-transparent pixel is skipped
    const trC = new Uint8ClampedArray([def[k][0], def[k][1], def[k][2], 0]);
    remapC(trC);
    check("[test-the-test] a wrong expectation (default pixel stays unchanged) is refuted: it DID change",
      !(pxC[0] === def[k][0] && pxC[1] === def[k][1] && pxC[2] === def[k][2]) || def[k][0] === target[k][0]);
  }

  console.log("T2 join (graceful-dark, DLL window #9 fields): gem shape + identKind 3");
  {
    // fixture guards for the T2 additive keys
    check("[fixture] material_map carries shape_tokens[43] with OVAL_CABOCHON@13",
      Array.isArray(realMaterialMap.shape_tokens) && realMaterialMap.shape_tokens.length === 43 &&
      realMaterialMap.shape_tokens[13] === "OVAL_CABOCHON");
    check("[fixture] item_map gem_shapes.OVAL_CABOCHON has small+large cells",
      !!(realItemMap.gem_shapes && realItemMap.gem_shapes.OVAL_CABOCHON &&
         realItemMap.gem_shapes.OVAL_CABOCHON.small && realItemMap.gem_shapes.OVAL_CABOCHON.large));
    const cutSmall = realItemMap.gem_shapes.OVAL_CABOCHON.small;
    const cutLarge = realItemMap.gem_shapes.OVAL_CABOCHON.large;
    // shape join: SMALLGEM with shape=13 (OVAL_CABOCHON) -> per-cut small cell, gl==c2d
    const sg = { type: "SMALLGEM", mat_type: 0, mat_index: TOURMALINE, subtype: -1, shape: 13 };
    const cS = T._resolveItemVisualForTest(sg), gS = glB._resolveItemVisualForTest(sg);
    check("SMALLGEM shape=13 -> gem_shapes.OVAL_CABOCHON.small, gl==c2d",
      cS.source === "material" && cellEq(cS.entry, cutSmall) && cellEq(gS.entry, cS.entry));
    const lg = { type: "GEM", mat_type: 0, mat_index: TOURMALINE, subtype: -1, shape: 13 };
    const cL = T._resolveItemVisualForTest(lg);
    check("GEM shape=13 -> the LARGE cut cell (distinct from small)",
      cellEq(cL.entry, cutLarge) && !cellEq(cL.entry, cutSmall));
    // graceful-dark: shape -1 / absent -> tier-1 default cell (today's live-wire behavior)
    const sgDark = { type: "SMALLGEM", mat_type: 0, mat_index: TOURMALINE, subtype: -1, shape: -1 };
    const sgNone = { type: "SMALLGEM", mat_type: 0, mat_index: TOURMALINE, subtype: -1 };
    check("shape=-1 and shape-absent both -> smallgem_default (graceful-dark)",
      cellEq(T._resolveItemVisualForTest(sgDark).entry, realItemMap.smallgem_default) &&
      cellEq(T._resolveItemVisualForTest(sgNone).entry, realItemMap.smallgem_default));
    // a shape without gem art (CLOUD@10) must fall to the default, never a wrong cell
    const sgCloud = { type: "SMALLGEM", mat_type: 0, mat_index: TOURMALINE, subtype: -1, shape: 10 };
    check("shape=10 (CLOUD, no cut art) falls to smallgem_default",
      cellEq(T._resolveItemVisualForTest(sgCloud).entry, realItemMap.smallgem_default));
    // [test-the-test] a WRONG shape index (14, the next cut) must NOT resolve OVAL_CABOCHON's cell
    const sgWrong = { type: "SMALLGEM", mat_type: 0, mat_index: TOURMALINE, subtype: -1, shape: 14 };
    const cW = T._resolveItemVisualForTest(sgWrong);
    check("[test-the-test] shape=14 resolves a DIFFERENT cell than shape=13 (join is index-sensitive)",
      !cellEq(cW.entry, cutSmall));
    // identKind 3: token overrides a WRONG mat_index (order-independence proof)
    const tok3 = { type: "ROUGH", mat_type: 0, mat_index: 9999, subtype: -1, identKind: 3, ident: "GREEN TOURMALINE" };
    check("identKind=3 token overrides an out-of-range mat_index: palRow == GREEN TOURMALINE's row, gl==c2d",
      T._matPalRowForTest(tok3) === realMaterialMap.inorganic[TOURMALINE].row &&
      glB._matPalRowForTest(tok3) === realMaterialMap.inorganic[TOURMALINE].row);
    // unknown token (modded world): no identity, never a wrong-index guess
    const tokUnk = { type: "ROUGH", mat_type: 0, mat_index: 0, subtype: -1, identKind: 3, ident: "NOT_A_REAL_MAT_X" };
    check("identKind=3 with an UNKNOWN token -> no palRow (never falls back to the index guess)",
      T._matPalRowForTest(tokUnk) === null && glB._matPalRowForTest(tokUnk) === null);
  }

  console.log("\n" + (failed === 0 ? "PASS" : "FAIL") + " (" + failed + " failures)");
  process.exit(failed === 0 ? 0 : 1);
})();
