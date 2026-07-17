// window13_component_tint_test.mjs -- window #13 client-half acceptance.
// CONTRACT CORRECTED 2026-07-09 (workshoptint): the building tint source is the component-derived
// `b.crgb` ONLY; the HEADER material color `b.rgb` NEVER tints. The previous contract's
// "fall back to header rgb" ladder was the root cause of the five blue-workshop reports:
// live native evidence (tintprobe differential, 2026-07-09) shows a component-less
// microcline-HEADER workshop/furnace renders GRAY (authored art, cyan-frac .00) in native DF
// while the header fallback tinted the browser cyan (.26-.56). Native's material recolors
// (dark jet furnaces, material-colored doors) all derive from COMPONENT items -- a door's
// component IS the door item, so its color merely coincides with the header.
//
// This test loads BOTH real renderers verbatim and asserts the client half:
//   1. RULE (pure pickBuildingTintRgb): crgb-when-valid, else NULL -- rgb never consulted.
//   2. HEADER-NEVER-TINTS: every rgb-only cell (valid or not) returns null.
//   3. BYTE-PARITY: canvas2d (dwf-tiles.js) and GL (dwf-gl.js) return IDENTICAL
//      picks across the whole input matrix, and their buildingTintRgb multiply factors match.
//   4. TEST-THE-TEST: the OLD ladder (crgb else header rgb) MUST fail the matrix -- proving
//      the assertions discriminate the corrected header-never-tints behavior.
//
// Run: node tools/harness/window13_component_tint_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// ---- load GL verbatim in an isolated sandbox (pure export, no DOM/GL) -------------------
const glSandbox = {};
glSandbox.self = glSandbox;
glSandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(glSandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glSandbox, { filename: f });
}
const GL = glSandbox.DwfGL;
assert.ok(GL && typeof GL.pickBuildingTintRgb === "function", "GL must export pickBuildingTintRgb");
const glPick = GL.pickBuildingTintRgb;

// ---- boot canvas2d verbatim (DOM-less mocks, same convention as wc4_building_test.mjs) --
class FakeImage { constructor() { this.onload = null; this.onerror = null; this._src = ""; } set src(v) { this._src = v; } get src() { return this._src; } }
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
}
const store = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
globalThis.Image = FakeImage;
globalThis.fetch = async () => ({ ok: false, json: async () => null });

vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), { filename: "dwf-tiles.js" });
const Tiles = globalThis.DwfTiles;
assert.ok(Tiles, "dwf-tiles.js did not install window.DwfTiles");
const api = Tiles.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });
assert.ok(api && typeof api._pickBuildingTintRgbForTest === "function", "tiles must expose _pickBuildingTintRgbForTest");
const tilesPick = api._pickBuildingTintRgbForTest;

// ---- the input matrix (spans the corrected rule + edge cells) ---------------------------
const CYAN = [0, 200, 200];   // microcline header descriptor (the WRONG source native ignores)
const GRAY = [120, 120, 120]; // component-derived (what native actually shows)
const cases = [
  { name: "no crgb, valid rgb -> NULL (header NEVER tints; the blue workshops)", b: { rgb: CYAN }, want: null },
  { name: "valid crgb + valid rgb -> component crgb", b: { crgb: GRAY, rgb: CYAN }, want: GRAY },
  { name: "valid crgb, no rgb -> component crgb", b: { crgb: GRAY }, want: GRAY },
  { name: "invalid crgb (short) + valid rgb -> null (never the header)", b: { crgb: [1, 2], rgb: CYAN }, want: null },
  { name: "invalid crgb (NaN) + valid rgb -> null (never the header)", b: { crgb: [0, NaN, 0], rgb: CYAN }, want: null },
  { name: "invalid crgb (not array) + valid rgb -> null (never the header)", b: { crgb: "gray", rgb: CYAN }, want: null },
  { name: "neither crgb nor rgb -> null (no tint)", b: {}, want: null },
  { name: "invalid rgb (short), no crgb -> null", b: { rgb: [1, 2] }, want: null },
  { name: "null building -> null", b: null, want: null },
];

let failed = 0;
const check = (n, ok) => { if (ok) console.log(`  ok - ${n}`); else { failed++; console.log(`  FAIL - ${n}`); } };
const eq = (a, b) => (a === null || b === null) ? a === b : (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));

console.log("window #13: building component-tint client-half (fallback ladder + byte-parity)");

// 1-3: correctness + dormant-safe + byte-parity, on the REAL pickers.
for (const c of cases) {
  const t = tilesPick(c.b);
  const g = glPick(c.b);
  check(`c2d  ${c.name}`, eq(t, c.want));
  check(`gl   ${c.name}`, eq(g, c.want));
  check(`parity: c2d===gl for [${c.name}]`, eq(t, g));
}

// 3b: BYTE-PARITY of the multiply factor itself (both renderers must lerp crgb toward white
// with the SAME B14 alpha, or a component-tinted cell diverges between GL and canvas2d).
const tilesFactor = api._buildingTintRgbForTest;
assert.ok(typeof tilesFactor === "function", "tiles must expose _buildingTintRgbForTest");
assert.ok(typeof GL.buildingTintRgb === "function", "GL must export buildingTintRgb");
for (const rgb of [[0, 200, 200], [120, 120, 120], [0, 51, 102], [255, 255, 255], [0, 0, 0]]) {
  check(`factor parity: buildingTintRgb([${rgb}]) c2d===gl`,
    eq(JSON.parse(JSON.stringify(tilesFactor(rgb))), JSON.parse(JSON.stringify(GL.buildingTintRgb(rgb)))));
}

// 4: TEST-THE-TEST. The OLD ladder (crgb else header rgb -- the shipped defect) MUST fail the
// matrix -- proving the assertions discriminate the corrected header-never-tints behavior and
// would catch a regression that reintroduced the header fallback.
function brokenOldLadder(b) {
  if (!b) return null;
  const valid = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (valid(b.crgb)) return b.crgb;
  if (valid(b.rgb)) return b.rgb;   // the removed header fallback
  return null;
}
const headerCase = cases.find((c) => c.name.indexOf("NEVER tints") !== -1);
const brokenPassesAll = cases.every((c) => eq(brokenOldLadder(c.b), c.want));
check("test-the-test: the old crgb->rgb ladder FAILS the matrix (assertions discriminate)", brokenPassesAll === false);
check("test-the-test: specifically the 'header NEVER tints' cell catches it",
  !eq(brokenOldLadder(headerCase.b), headerCase.want));

console.log(failed === 0 ? "PASS (0 failures)" : `FAIL (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
