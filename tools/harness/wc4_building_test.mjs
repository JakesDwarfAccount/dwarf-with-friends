// wc4_building_test.mjs -- WC-4 acceptance deliverable (docs/superpowers/specs/
// 2026-07-07-WC-coverage-spec.md, "kill the _default workshop stamp -> MISSING_BUILDING
// handling"). Loads the REAL web/js/dwf-tiles.js module (verbatim, via
// vm.runInThisContext) in a minimally-mocked DOM-less environment and exercises its two
// debug-only test hooks (added alongside the WC-4 change, same convention as
// dwf-render.js's `_impls`):
//   - _buildingEntryForTest(b)               -- the wire-building -> building_map lookup
//   - _isOverlayOnlyBuildingTypeForTest(type) -- the Stockpile/Civzone exclusion predicate
//
// Asserts, against the REAL committed web/building_map.json:
//   (a) a Bed building resolves to the MISSING_BUILDING cell (defaults.png 0:1) -- Bed has
//       no building_map entry pre-WC-5 furniture generation, so this exercises the fallback
//       that used to be the workshops_1x1.png (0,0) stamp;
//   (b) Stockpile/Civzone are classified overlay-only (excluded from the building-art loop
//       by construction -- the loop's early `continue` uses this SAME predicate, so "zero
//       building-art instances" for those types follows directly);
//   (c) a real Workshop building (which DOES have a building_map entry) still resolves to
//       its normal sprite cell, not to MISSING_BUILDING -- proving the fallback is scoped
//       correctly and doesn't shadow real art.
//
// Run: node tools/harness/wc4_building_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILES_PATH = path.resolve(__dirname, "../../web/js/dwf-tiles.js");
const BUILDING_MAP_PATH = path.resolve(__dirname, "../../web/building_map.json");

const realBuildingMap = JSON.parse(fs.readFileSync(BUILDING_MAP_PATH, "utf8"));
// texsweep: Bed/Door/... ARE real top-level entries now (v3 furniture defaults). "Shop"
// stands in as the guaranteed-unmapped MISSING_BUILDING example this test still needs.
assert.ok(Object.prototype.hasOwnProperty.call(realBuildingMap, "Bed"),
  "fixture assumption broken: building_map.json no longer has the v3 furniture default 'Bed'");
assert.ok(!Object.prototype.hasOwnProperty.call(realBuildingMap, "Shop"),
  "fixture assumption broken: building_map.json now has a 'Shop' entry -- pick another " +
  "unmapped building_type for the MISSING_BUILDING assertion");

// ---- minimal DOM-less globals (just enough for boot() to complete without throwing;
// boot()'s body is one big try/catch, so anything it swallows is fine as long as
// buildingMap still gets populated from our fetch stub before we assert). ----
class FakeImage {
  constructor() { this.onload = null; this.onerror = null; this._src = ""; }
  set src(v) { this._src = v; /* never auto-fires: sprite pixels are irrelevant here */ }
  get src() { return this._src; }
}
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {}
  removeEventListener() {}
  getContext() { return new Proxy({}, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === "measureText") return () => ({ width: 8 });
      return (..._args) => {};
    },
    set(t, prop, v) { t[prop] = v; return true; },
  }); }
}
const storageBacking = {};
const fakeStorage = {
  getItem: (k) => (k in storageBacking ? storageBacking[k] : null),
  setItem: (k, v) => { storageBacking[k] = String(v); },
};

globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = {
  hidden: false,
  addEventListener() {},
  getElementById() { return null; },
  createElement() { return { style: {} }; },
  body: { appendChild() {} },
};
globalThis.addEventListener = () => {};
globalThis.sessionStorage = fakeStorage;
globalThis.Image = FakeImage;
globalThis.fetch = async (url) => {
  if (String(url).indexOf("building_map.json") !== -1) {
    return { ok: true, json: async () => realBuildingMap };
  }
  return { ok: false, json: async () => null };
};

const src = fs.readFileSync(TILES_PATH, "utf8");
vm.runInThisContext(src, { filename: TILES_PATH });
const DwfTiles = globalThis.DwfTiles;
assert.ok(DwfTiles, "dwf-tiles.js did not install window.DwfTiles");

const canvasEl = new FakeCanvasEl();
const result = DwfTiles.init({ canvas: canvasEl, managePoll: false, manageCamera: false });
assert.ok(result, "init() returned null (canvas/context stub rejected)");

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}`); }
}

async function waitUntil(pred, maxMs) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > (maxMs || 1000)) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

(async function main() {
  console.log("WC-4: building fallback + Stockpile/Civzone exclusion");

  // building_map.json loads asynchronously (loadJsonMap -> fetch); wait for it to land by
  // polling until a Workshop lookup (known-present key) stops returning the pre-load
  // MISSING_BUILDING fallback.
  await waitUntil(() => {
    const e = DwfTiles._buildingEntryForTest({ type: "Workshop", subtype: 0 });
    return e && e.sheet !== "defaults.png";
  }, 2000);

  // texsweep: furniture buildings now resolve to a REAL sprite via the v3 top-level
  // building_type default keys (Door/Bed/Table/... in building_map.json). "Shop" is the
  // MISSING_BUILDING example now -- it has no vanilla in-world building sprite.
  const bed = DwfTiles._buildingEntryForTest({ type: "Bed" });
  check("Bed now resolves to a REAL sprite (v3 furniture default), NOT MISSING_BUILDING",
    !!bed && !(bed.sheet === "defaults.png" && bed.col === 0 && bed.row === 1));
  const shop = DwfTiles._buildingEntryForTest({ type: "Shop" });
  check("Shop (no vanilla building sprite) resolves to MISSING_BUILDING",
    !!shop && shop.sheet === "defaults.png" && shop.col === 0 && shop.row === 1);

  const totallyUnknown = DwfTiles._buildingEntryForTest({ type: "TotallyMadeUpType", subtype: 99 });
  check("an unknown type also resolves to MISSING_BUILDING (never the old workshop stamp)",
    !!totallyUnknown && totallyUnknown.sheet === "defaults.png" && totallyUnknown.col === 0 && totallyUnknown.row === 1);

  const workshop = DwfTiles._buildingEntryForTest({ type: "Workshop", subtype: 0 });
  check("a REAL mapped type (Workshop:Carpenters) still resolves to its own sprite, not MISSING_BUILDING",
    !!workshop && !(workshop.sheet === "defaults.png" && workshop.col === 0 && workshop.row === 1));

  check("Stockpile is classified overlay-only (excluded from building-art)",
    DwfTiles._isOverlayOnlyBuildingTypeForTest("Stockpile") === true);
  check("Civzone is classified overlay-only (excluded from building-art)",
    DwfTiles._isOverlayOnlyBuildingTypeForTest("Civzone") === true);
  check("Workshop is NOT classified overlay-only (still gets building-art)",
    DwfTiles._isOverlayOnlyBuildingTypeForTest("Workshop") === false);

  const rawAt1 = Math.max(0, 1 - DwfTiles._fogAlphaForDepthForTest(1));
  check("sd-tagged shallow below-camera building uses the raw terrain fog ladder",
    DwfTiles._buildingAlphaForZForTest({ z: 9, sd: 1 }, 10) === rawAt1);
  check("sd-tagged deep below-camera building has no unit-style 0.55 alpha floor",
    DwfTiles._buildingAlphaForZForTest({ z: 1, sd: 1 }, 10) === 0);
  check("untagged below-camera building is dropped as a stale AUX ghost",
    DwfTiles._buildingAlphaForZForTest({ z: 8 }, 10) === null);
  check("sd does not resurrect an above-camera building",
    DwfTiles._buildingAlphaForZForTest({ z: 12, sd: 1 }, 10) === null);

  console.log(failed === 0 ? "PASS (0 failures)" : `FAIL (${failed} failures)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error("FATAL:", err && err.stack || err);
  process.exit(1);
});
