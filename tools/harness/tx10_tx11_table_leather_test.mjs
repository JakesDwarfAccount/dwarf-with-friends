// tx10_tx11_table_leather_test.mjs -- TX10 table-legs composite + TX11 leather/cloth guard,
// plus a TX12 documentation case. Loads the real maps and both resolver twins (canvas2d
// DwfTiles + GL DwfGL) and asserts:
//   TX10/B183: a table of ANY material (STONE/WOOD/METAL/GLASS) resolves its own row of
//         the baked item_table_composite.png via the matvariant step (its live render
//         path) -- TX10 shipped STONE only (registry B183: "only applied to one type of
//         table"); B183 extends the same mechanical leg-overlay bake to the other three
//         materials' already-pinned base cells. No material renders the bare legless
//         item_table.png base anymore.
//   TX11: a tanned-skin item resolves bytype.SKIN_TANNED = item_cloth.png(0,1) (the pick),
//         and CLOTH stays a DISTINCT cell -- the export's dangerous bytoken.ITEM_CLOTH
//         reroute was rejected so cloth is never repainted as leather.
//   TX12: documented, not fixed -- ident WEED_RAT already resolves via the ident path, but
//         a mismatched/absent ident falls through to the generic plump-helmet bytype.PLANT.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const itemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const materialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));
const plantMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/plant_map.json"), "utf8"));

function idxOf(id) {
  const a = materialMap.inorganic;
  for (let i = 0; i < a.length; i++) if (a[i].id === id) return i;
  throw new Error("no inorganic id " + id);
}
function cellEq(a, b) { return !!a && !!b && a.sheet === b.sheet && a.col === b.col && a.row === b.row; }
const COMPOSITE = { sheet: "item_table_composite.png", col: 0, row: 0 };
const COMPOSITE_ROW = { STONE: 0, WOOD: 1, METAL: 2, GLASS: 3 };
function compositeFor(mat) { return { sheet: "item_table_composite.png", col: 0, row: COMPOSITE_ROW[mat] }; }

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
  if (u.indexOf("item_map.json") !== -1) return { ok: true, json: async () => itemMap };
  if (u.indexOf("plant_map.json") !== -1) return { ok: true, json: async () => plantMap };
  if (u.indexOf("material_map.json") !== -1) return { ok: true, json: async () => materialMap };
  return { ok: false, json: async () => null };
};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), { filename: "dwf-tiles.js" });
const T = globalThis.DwfTiles;
if (!T) { console.error("dwf-tiles.js did not install DwfTiles"); process.exit(1); }
T.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });

const glbox = {}; glbox.self = glbox; glbox.performance = { now: () => 0 };
vm.createContext(glbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glbox, { filename: f });
}
const GL = glbox.DwfGL;
if (!GL) { console.error("sandbox must export DwfGL"); process.exit(1); }
const gl = GL.createSceneBuilder({ itemMap, materialMap, plantMap });

let failed = 0;
function check(name, cond) { if (cond) console.log("  ok - " + name); else { failed++; console.log("  FAIL - " + name); } }
async function waitUntil(pred, maxMs) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > (maxMs || 3000)) throw new Error("waitUntil timed out"); await new Promise((r) => setTimeout(r, 2)); } }

(async function main() {
  await waitUntil(() => !!T._resolveItemEntryForTest({ type: "AMMO", mat_type: -1 }), 3000);
  T._setMaterialMapForTest(materialMap);

  const MARBLE = idxOf("MARBLE"), COPPER = idxOf("COPPER");

  // -- TX10: stone table gets the baked composite via matvariant, in BOTH renderers --
  const stoneTable = { type: "TABLE", mat_type: 0, mat_index: MARBLE, subtype: -1 };
  const cT = T._resolveItemVisualForTest(stoneTable);
  const gT = gl._resolveItemVisualForTest(stoneTable);
  check("stone TABLE -> item_table_composite(0,0) via matvariant (canvas2d + GL)",
    cT.source === "matvariant" && gT.source === "matvariant" &&
    cellEq(cT.entry, COMPOSITE) && cellEq(gT.entry, COMPOSITE));

  // -- B183: WOOD/METAL/GLASS tables now ALSO resolve to their own composited
  // (base+legs) row, in both renderers -- registry B183 was exactly this gap
  // (STONE fixed, other materials still legless).
  const woodTable = { type: "TABLE", mat_type: 419, subtype: -1 };
  const metalTable = { type: "TABLE", mat_type: 0, mat_index: COPPER, subtype: -1 };
  const glassTable = { type: "TABLE", mat_type: 3, subtype: -1 };
  const cWood = T._resolveItemVisualForTest(woodTable), gWood = gl._resolveItemVisualForTest(woodTable);
  const cMetal = T._resolveItemVisualForTest(metalTable), gMetal = gl._resolveItemVisualForTest(metalTable);
  const cGlass = T._resolveItemVisualForTest(glassTable), gGlass = gl._resolveItemVisualForTest(glassTable);
  check("WOOD table -> item_table_composite(0,1) via matvariant (canvas2d + GL)",
    cWood.source === "matvariant" && gWood.source === "matvariant" &&
    cellEq(cWood.entry, compositeFor("WOOD")) && cellEq(gWood.entry, compositeFor("WOOD")));
  check("METAL table -> item_table_composite(0,2) via matvariant (canvas2d + GL)",
    cMetal.source === "matvariant" && gMetal.source === "matvariant" &&
    cellEq(cMetal.entry, compositeFor("METAL")) && cellEq(gMetal.entry, compositeFor("METAL")));
  check("GLASS table -> item_table_composite(0,3) via matvariant (canvas2d + GL)",
    cGlass.source === "matvariant" && gGlass.source === "matvariant" &&
    cellEq(cGlass.entry, compositeFor("GLASS")) && cellEq(gGlass.entry, compositeFor("GLASS")));
  check("no table material renders the bare legless item_table.png base anymore",
    !cellEq(cWood.entry, { sheet: "item_table.png", col: 0, row: 0 }) &&
    !cellEq(cMetal.entry, { sheet: "item_table.png", col: 0, row: 2 }) &&
    !cellEq(cGlass.entry, { sheet: "item_table.png", col: 0, row: 3 }));

  // -- B183 (reopened): CHAIRS get the same leg-composite treatment (chairs never
  // had ANY composite before). A loose chair of each material resolves its own row
  // of item_chair_composite.png via the matvariant step, in both renderers.
  const CHAIR_ROW = { STONE: 0, WOOD: 1, METAL: 2, GLASS: 3 };
  function chairComp(mat) { return { sheet: "item_chair_composite.png", col: 0, row: CHAIR_ROW[mat] }; }
  const stoneChair = { type: "CHAIR", mat_type: 0, mat_index: MARBLE, subtype: -1 };
  const woodChair = { type: "CHAIR", mat_type: 419, subtype: -1 };
  const metalChair = { type: "CHAIR", mat_type: 0, mat_index: COPPER, subtype: -1 };
  const glassChair = { type: "CHAIR", mat_type: 3, subtype: -1 };
  for (const [label, it, mat] of [["STONE", stoneChair, "STONE"], ["WOOD", woodChair, "WOOD"],
                                   ["METAL", metalChair, "METAL"], ["GLASS", glassChair, "GLASS"]]) {
    const c = T._resolveItemVisualForTest(it), g = gl._resolveItemVisualForTest(it);
    check(label + " chair -> item_chair_composite(0," + CHAIR_ROW[mat] + ") via matvariant (canvas2d + GL)",
      c.source === "matvariant" && g.source === "matvariant" &&
      cellEq(c.entry, chairComp(mat)) && cellEq(g.entry, chairComp(mat)));
  }
  check("no chair material renders the bare legless item_chair.png base anymore",
    !cellEq(T._resolveItemVisualForTest(woodChair).entry, { sheet: "item_chair.png", col: 0, row: 0 }) &&
    !cellEq(T._resolveItemVisualForTest(metalChair).entry, { sheet: "item_chair.png", col: 0, row: 2 }) &&
    !cellEq(T._resolveItemVisualForTest(glassChair).entry, { sheet: "item_chair.png", col: 0, row: 3 }));

  // -- seeded-bad (chair): removing the chair matvariant redirect must break it --
  const badMapChair = JSON.parse(JSON.stringify(itemMap));
  badMapChair.matvariants.Chair.WOOD = { sheet: "item_chair.png", col: 0, row: 0 };
  const glBadChair = GL.createSceneBuilder({ itemMap: badMapChair, materialMap, plantMap });
  check("[seeded-bad] without the WOOD chair matvariant redirect, wood chair does NOT hit the composite",
    !cellEq(glBadChair._resolveItemVisualForTest(woodChair).entry, chairComp("WOOD")));

  // -- TX11: tanned skin resolves its own bytype cell (the pick), cloth stays distinct --
  const tannedSkin = { type: "SKIN_TANNED", mat_type: 121, subtype: -1, identKind: 2, ident: "CAT" };
  const cS = T._resolveItemVisualForTest(tannedSkin);
  const gS = gl._resolveItemVisualForTest(tannedSkin);
  check("SKIN_TANNED -> item_cloth.png(0,1) via bytype (canvas2d + GL)",
    cS.source === "bytype" && gS.source === "bytype" &&
    cellEq(cS.entry, itemMap.bytype.SKIN_TANNED) && cellEq(gS.entry, itemMap.bytype.SKIN_TANNED) &&
    cellEq(cS.entry, { sheet: "item_cloth.png", col: 0, row: 1 }));
  const cloth = { type: "CLOTH", mat_type: 419, subtype: -1, identKind: 1, ident: "COTTON" };
  const cC = T._resolveItemVisualForTest(cloth);
  check("CLOTH stays item_cloth.png(1,0) -- NOT repainted as leather",
    cellEq(cC.entry, { sheet: "item_cloth.png", col: 1, row: 0 }) &&
    !cellEq(cC.entry, itemMap.bytype.SKIN_TANNED));

  // -- TX12 (documented, not fixed): ident WEED_RAT already resolves; a bad ident falls to plump --
  const weedRat = { type: "PLANT", mat_type: 419, subtype: -1, identKind: 1, ident: "WEED_RAT" };
  const cW = T._resolveItemVisualForTest(weedRat);
  check("[TX12 doc] PLANT ident WEED_RAT already resolves plant_standard.png(1,12) via ident",
    cW.source === "ident" && cellEq(cW.entry, { sheet: "plant_standard.png", col: 1, row: 12 }));
  const badIdent = { type: "PLANT", mat_type: 419, subtype: -1, identKind: 1, ident: "RAT_WEED" };
  const cB = T._resolveItemVisualForTest(badIdent);
  check("[TX12 doc] mismatched ident falls to generic plump-helmet bytype.PLANT (the live symptom)",
    cB.source === "bytype" && cellEq(cB.entry, itemMap.bytype.PLANT));

  // -- seeded-bad: removing the composite redirect must break the table (fix is load-bearing) --
  const badMap = JSON.parse(JSON.stringify(itemMap));
  badMap.matvariants.Table.STONE = { sheet: "item_table.png", col: 0, row: 1 };
  const glBad = GL.createSceneBuilder({ itemMap: badMap, materialMap, plantMap });
  const bad = glBad._resolveItemVisualForTest(stoneTable);
  check("[seeded-bad] without the matvariant redirect, stone table does NOT hit the composite",
    !cellEq(bad.entry, COMPOSITE));

  // -- seeded-bad (B183, rule 3 "test the test"): same probe for WOOD -- proves the
  // WOOD assertion above is actually load-bearing on the new redirect, not a
  // coincidental pass from an unrelated code path.
  const badMapWood = JSON.parse(JSON.stringify(itemMap));
  badMapWood.matvariants.Table.WOOD = { sheet: "item_table.png", col: 0, row: 0 };
  const glBadWood = GL.createSceneBuilder({ itemMap: badMapWood, materialMap, plantMap });
  const badWood = glBadWood._resolveItemVisualForTest(woodTable);
  check("[seeded-bad] without the WOOD matvariant redirect, wood table does NOT hit the composite",
    !cellEq(badWood.entry, compositeFor("WOOD")));

  console.log("\n" + (failed === 0 ? "PASS" : "FAIL") + " (" + failed + " failures)");
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
