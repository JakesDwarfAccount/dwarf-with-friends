// hatch_cover_item_map_test.mjs -- HATCH_COVER native-model fixup guard.
// Loads the real item/material maps and both resolver twins, then verifies the
// adjudicated hatch materials resolve through item_map.hatch_cover_bymat while
// the known-good IRON control remains on the old matvariant family path.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const itemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const materialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));

assert.ok(itemMap.hatch_cover_bymat, "item_map.hatch_cover_bymat must exist");
assert.ok(itemMap.hatch_cover_bymat.COPPER, "fixture: COPPER hatch fixup must exist");
assert.ok(itemMap.hatch_cover_bymat.MARBLE, "fixture: MARBLE hatch fixup must exist");
assert.ok(itemMap.hatch_cover_bymat["PLANT_MAT:OAK:WOOD"], "fixture: OAK hatch fixup must exist");
assert.ok(!itemMap.hatch_cover_bymat.IRON, "known-good IRON control must not be in the fixup map");

function idxOf(id) {
  const a = materialMap.inorganic;
  for (let i = 0; i < a.length; i++) if (a[i].id === id) return i;
  throw new Error("no inorganic id " + id);
}
function cellEq(a, b) { return !!a && !!b && a.sheet === b.sheet && a.col === b.col && a.row === b.row; }

const COPPER = idxOf("COPPER");
const MARBLE = idxOf("MARBLE");
const IRON = idxOf("IRON");

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
  return { ok: false, json: async () => null };
};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), { filename: "dwf-tiles.js" });
const T = globalThis.DwfTiles;
assert.ok(T, "dwf-tiles.js did not install DwfTiles");
T.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });

const glbox = {}; glbox.self = glbox; glbox.performance = { now: () => 0 };
vm.createContext(glbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glbox, { filename: f });
}
const GL = glbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");
const gl = GL.createSceneBuilder({ itemMap, materialMap });

let failed = 0;
function check(name, cond) { if (cond) console.log("  ok - " + name); else { failed++; console.log("  FAIL - " + name); } }
async function waitUntil(pred, maxMs) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > (maxMs || 2000)) throw new Error("waitUntil timed out"); await new Promise((r) => setTimeout(r, 1)); } }

(async function main() {
  await waitUntil(() => !!T._resolveItemEntryForTest({ type: "AMMO", mat_type: -1 }), 2000);
  T._setMaterialMapForTest(materialMap);

  const cases = [
    ["metal COPPER", { type: "HATCH_COVER", mat_type: 0, mat_index: COPPER, subtype: -1 }, itemMap.hatch_cover_bymat.COPPER],
    ["stone MARBLE", { type: "HATCH_COVER", mat_type: 0, mat_index: MARBLE, subtype: -1 }, itemMap.hatch_cover_bymat.MARBLE],
    ["plant OAK", { type: "HATCH_COVER", mat_type: 419, mat_index: 0, subtype: -1, identKind: 1, ident: "OAK" }, itemMap.hatch_cover_bymat["PLANT_MAT:OAK:WOOD"]],
    ["generated DIVINE_5", { type: "HATCH_COVER", mat_type: 0, mat_index: 9999, subtype: -1, identKind: 3, ident: "DIVINE_5" }, itemMap.hatch_cover_bymat.DIVINE_5],
  ];
  for (const [name, it, expected] of cases) {
    const c = T._resolveItemVisualForTest(it);
    const g = gl._resolveItemVisualForTest(it);
    check(name + " resolves hatch_cover_bymat cell in canvas2d + GL",
      c.source === "material" && g.source === "material" && cellEq(c.entry, expected) && cellEq(g.entry, expected));
  }

  const iron = { type: "HATCH_COVER", mat_type: 0, mat_index: IRON, subtype: -1 };
  const ci = T._resolveItemVisualForTest(iron);
  const gi = gl._resolveItemVisualForTest(iron);
  check("known-good IRON control stays on matvariant METAL, unchanged",
    ci.source === "matvariant" && gi.source === "matvariant" &&
    cellEq(ci.entry, itemMap.matvariants.HatchCover.METAL) && cellEq(gi.entry, itemMap.matvariants.HatchCover.METAL));

  const dogMeat = { type: "MEAT", mat_type: 21, subtype: -1, identKind: 2, ident: "DOG" };
  const dogMeatC = T._resolveItemVisualForTest(dogMeat);
  const dogMeatG = gl._resolveItemVisualForTest(dogMeat);
  check("DOG MEAT uses the raws-derived standard-meat cell in canvas2d + GL",
    dogMeatC.source === "creaturefood" && dogMeatG.source === "creaturefood" &&
    cellEq(dogMeatC.entry, itemMap.creature_food.cells["MEAT:STANDARD"]) &&
    cellEq(dogMeatG.entry, itemMap.creature_food.cells["MEAT:STANDARD"]));

  const catTallow = { type: "GLOB", mat_type: 25, subtype: -1, identKind: 2, ident: "CAT" };
  const catTallowC = T._resolveItemVisualForTest(catTallow);
  const catTallowG = gl._resolveItemVisualForTest(catTallow);
  check("CAT TALLOW GLOB resolves the mapped raws-authored fat fallback in canvas2d + GL",
    catTallowC.source === "bytype" && catTallowG.source === "bytype" &&
    cellEq(catTallowC.entry, itemMap.bytype.GLOB) && cellEq(catTallowG.entry, itemMap.bytype.GLOB));

  const cowFat = { type: "GLOB", mat_type: 20, subtype: -1, identKind: 2, ident: "COW" };
  const cowFatG = gl._resolveItemVisualForTest(cowFat);
  check("[control] raw FAT GLOB uses the authored BODYPART_FAT cell",
    cowFatG.source === "creaturefood" &&
    cellEq(cowFatG.entry, itemMap.creature_food.cells["GLOB:FAT"]));

  const badMap = JSON.parse(JSON.stringify(itemMap));
  delete badMap.hatch_cover_bymat.COPPER;
  delete badMap.bytype.GLOB;
  const glBad = GL.createSceneBuilder({ itemMap: badMap, materialMap });
  const bad = glBad._resolveItemVisualForTest({ type: "HATCH_COVER", mat_type: 0, mat_index: COPPER, subtype: -1 });
  check("[seeded-bad] without COPPER fixup, resolver does NOT hit the corrected COPPER cell",
    !(bad.source === "material" && cellEq(bad.entry, itemMap.hatch_cover_bymat.COPPER)));
  const tallowBad = glBad._resolveItemVisualForTest(catTallow);
  check("[seeded-bad] without GLOB data, CAT TALLOW does NOT hit the corrected proxy cell",
    !(tallowBad.source === "bytype" && cellEq(tallowBad.entry, itemMap.bytype.GLOB)));

  console.log("\n" + (failed === 0 ? "PASS" : "FAIL") + " (" + failed + " failures)");
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
