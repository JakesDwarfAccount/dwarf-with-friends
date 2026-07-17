// b63_workshop_test.mjs -- B63 acceptance/regression gate.
//
// The owner bug B63: "siege and soap maker workshops have generic blue box fallback textures".
// Root mechanism -- the ART WAS IN THE MAP, under keys the client resolver never constructs:
//   (a) SIEGE: the raws carry full 5x5 WORKSHOP_SIEGE art and the generator emitted it under
//       that raw key, but the generator's hand-list ALIASES table had no
//       "WORKSHOP_SIEGE" -> "Workshop:Siege" row, and buildingEntry() only tries
//       "Workshop:<df::workshop_type key>" (Siege = subtype 9) -> MISSING_BUILDING blue box.
//       Fixed in tools/ws2/build_building_map.py (alias) + regenerated web/building_map.json.
//   (b) SOAP_MAKER (custom-raws workshop): art lives under "WORKSHOP_CUSTOM:SOAP_MAKER", but
//       the wire ships only type=Workshop subtype=Custom(23) -- the def id is NOT on the wire
//       (world_stream.cpp BldRec has no custom_type; a `cdef` wire field is the perfect-version
//       DLL item). Fixed client-side by DATA-DRIVEN footprint match against WORKSHOP_CUSTOM:*
//       entries (vanilla sizes are distinct: SOAP_MAKER 3x3, SCREW_PRESS 1x1 -- exact pick).
//
// Test-the-test: every assertion below encodes the post-fix value and fails against the
// pre-fix map/client (pre-fix: "Workshop:Siege" absent from the map; a Custom-subtype
// building resolved to MISSING_BUILDING for any footprint).
//
// Run: node tools/harness/b63_workshop_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILES_PATH = path.resolve(__dirname, "../../web/js/dwf-tiles.js");
const GL_PATH = path.resolve(__dirname, "../../web/js/dwf-gl.js");
const BUILDING_MAP_PATH = path.resolve(__dirname, "../../web/building_map.json");

const realBuildingMap = JSON.parse(fs.readFileSync(BUILDING_MAP_PATH, "utf8"));
// Map-level fixture guards (fail loudly if the generator regresses).
assert.ok(realBuildingMap["WORKSHOP_SIEGE"], "map lost the WORKSHOP_SIEGE raw entry");
assert.ok(realBuildingMap["Workshop:Siege"], "map lost the Workshop:Siege alias (B63 generator fix reverted?)");
assert.ok(realBuildingMap["WORKSHOP_CUSTOM:SOAP_MAKER"], "map lost WORKSHOP_CUSTOM:SOAP_MAKER");
assert.ok(realBuildingMap["WORKSHOP_CUSTOM:SCREW_PRESS"], "map lost WORKSHOP_CUSTOM:SCREW_PRESS");
assert.equal(realBuildingMap["WORKSHOP_CUSTOM:SOAP_MAKER"].w, 3, "SOAP_MAKER is no longer 3x3 -- footprint match needs revisiting");
assert.equal(realBuildingMap["WORKSHOP_CUSTOM:SCREW_PRESS"].w, 1, "SCREW_PRESS is no longer 1x1 -- footprint match needs revisiting");

// ---- minimal DOM-less globals (wc4_building_test.mjs convention) --------------------------
class FakeImage {
  constructor() { this.onload = null; this.onerror = null; this._src = ""; this.width = 32; this.height = 32; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
}
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {}
  removeEventListener() {}
  getContext() {
    return new Proxy({}, {
      get(t, prop) {
        if (prop in t) return t[prop];
        if (prop === "measureText") return () => ({ width: 8 });
        return (..._args) => {};
      },
      set(t, prop, v) { t[prop] = v; return true; },
    });
  }
}
const storageBacking = {};
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
globalThis.sessionStorage = {
  getItem: (k) => (k in storageBacking ? storageBacking[k] : null),
  setItem: (k, v) => { storageBacking[k] = String(v); },
};
globalThis.Image = FakeImage;
globalThis.fetch = async (url) => {
  if (String(url).indexOf("building_map.json") !== -1) return { ok: true, json: async () => realBuildingMap };
  return { ok: false, json: async () => null };
};

vm.runInThisContext(fs.readFileSync(TILES_PATH, "utf8"), { filename: TILES_PATH });
const DwfTiles = globalThis.DwfTiles;
assert.ok(DwfTiles, "dwf-tiles.js did not install window.DwfTiles");
DwfTiles.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });

// building_map loads async; wait until a known entry resolves.
{
  const t0 = Date.now();
  while (true) {
    const e = DwfTiles._buildingEntryForTest({ type: "TradeDepot", subtype: -1 });
    if (e && e.sheet && e.sheet !== "defaults.png") break;
    if (Date.now() - t0 > 2000) break;
    await new Promise((r) => setTimeout(r, 5));
  }
}

// GL sandbox (module-level helpers + a scene builder for buildingEntryGL).
const glSandbox = { self: {}, performance: { now: () => 0 } };
glSandbox.self = glSandbox;
vm.createContext(glSandbox);
vm.runInContext(fs.readFileSync(GL_PATH, "utf8"), glSandbox, { filename: "dwf-gl.js" });
const GL = glSandbox.DwfGL;
const glb = GL.createSceneBuilder({
  atlas: { resolve: () => 1 }, spriteMap: {}, tokenMap: {},
  shadowCellMap: { wallShadow: {}, visionShadow: {}, rampShadowOnRamp: {} },
  buildingMap: realBuildingMap,
});
assert.ok(typeof glb._buildingEntryForTest === "function", "GL builder missing _buildingEntryForTest");

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}`); }
}
const isMissing = (e) => !!e && e.sheet === "defaults.png";

// Wire-shaped fixtures (the exact fields world_stream.cpp AUX emits).
const SIEGE = { type: "Workshop", subtype: 9, x1: 10, y1: 10, x2: 14, y2: 14 };   // 5x5
const SOAP = { type: "Workshop", subtype: 23, x1: 20, y1: 20, x2: 22, y2: 22 };   // Custom 3x3
const SCREW = { type: "Workshop", subtype: 23, x1: 30, y1: 30, x2: 30, y2: 30 };  // Custom 1x1
const CUSTOM_ODD = { type: "Workshop", subtype: 23, x1: 40, y1: 40, x2: 44, y2: 41 }; // Custom 5x2 (no match)
const MASONS = { type: "Workshop", subtype: 2, x1: 0, y1: 0, x2: 2, y2: 2 };

console.log("B63 canvas2d: buildingEntry resolution");
{
  const e = DwfTiles._buildingEntryForTest(SIEGE);
  check("Siege workshop (subtype 9) resolves the 5x5 workshops_5x5.png art (was blue box)",
    !isMissing(e) && e.sheet === "workshops_5x5.png" && e.w === 5 && e.h === 5);
  const s = DwfTiles._buildingEntryForTest(SOAP);
  check("Custom 3x3 workshop resolves WORKSHOP_CUSTOM:SOAP_MAKER (was blue box)",
    !isMissing(s) && s === realBuildingMap["WORKSHOP_CUSTOM:SOAP_MAKER"]);
  const p = DwfTiles._buildingEntryForTest(SCREW);
  check("Custom 1x1 workshop resolves WORKSHOP_CUSTOM:SCREW_PRESS",
    !isMissing(p) && p === realBuildingMap["WORKSHOP_CUSTOM:SCREW_PRESS"]);
  const o = DwfTiles._buildingEntryForTest(CUSTOM_ODD);
  check("Custom workshop with an unmatched footprint still falls back (never a wrong-size stamp)",
    isMissing(o) || o === realBuildingMap["Workshop"] || o == null || o === realBuildingMap["_default"]);
  const m = DwfTiles._buildingEntryForTest(MASONS);
  check("[regression] Masons still resolves its own 3x3 entry (custom match never hijacks named subtypes)",
    m === realBuildingMap["Workshop:Masons"]);
}

console.log("B63 GL parity: buildingEntryGL resolution");
{
  const e = glb._buildingEntryForTest(SIEGE);
  check("GL: Siege resolves the 5x5 art", !isMissing(e) && e.sheet === "workshops_5x5.png" && e.w === 5);
  const s = glb._buildingEntryForTest(SOAP);
  check("GL: Custom 3x3 resolves SOAP_MAKER", s === realBuildingMap["WORKSHOP_CUSTOM:SOAP_MAKER"]);
  const p = glb._buildingEntryForTest(SCREW);
  check("GL: Custom 1x1 resolves SCREW_PRESS", p === realBuildingMap["WORKSHOP_CUSTOM:SCREW_PRESS"]);
  const m = glb._buildingEntryForTest(MASONS);
  check("GL: [regression] Masons unchanged", m === realBuildingMap["Workshop:Masons"]);
  const c2d = DwfTiles._buildingEntryForTest(SOAP), gl = glb._buildingEntryForTest(SOAP);
  check("GL/canvas2d resolve the SAME soap-maker entry (renderer parity)", c2d === gl);
}

console.log(failed === 0 ? "\nB63 PASS" : `\nB63 FAIL (${failed} assertion(s))`);
process.exit(failed === 0 ? 0 : 1);
