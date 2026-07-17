// fog_canvas_test.mjs -- measured see-down fog acceptance (docs/superpowers/specs/
// 2026-07-07-WB-renderer-spec.md WB-4's held-back fog item, completed per the sweep #2
// verdict: docs/reference/fogparams.json `seeDown`, docs/superpowers/specs/
// 2026-07-06-fog-lighting-report.md §7). Loads the REAL web/js/dwf-tiles.js module
// (verbatim, via vm.runInThisContext) in a minimally-mocked DOM-less environment -- same
// convention as tools/harness/wc4_building_test.mjs -- and exercises its two debug-only fog
// test hooks:
//   - _fogAlphaForDepthForTest(depth) -- the canvas2d client's re-expression of the fitted
//     seeDown alpha-by-depth curve (intercept + depth*rate, clamped 0..1)
//   - _fogColorForTest()              -- the fitted asymptotic fog color
//
// Asserts, against the REAL committed docs/reference/fogparams.json:
//   (a) fog color matches fogColorRgb exactly;
//   (b) fog alpha at depths 1/3/5/10 matches the measured/derived table within a tight
//       tolerance (the task's named spot-check depths -- 10 is beyond the measured table's
//       max of 9, so it exercises the clip-to-1.0 tail instead);
//   (c) depth 0 (camera plane, never fogged) and negative/non-numeric depth all fog to 0;
//   (d) the curve is monotonically non-decreasing and never exceeds 1.
//
// Run: node tools/harness/fog_canvas_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const TILES_PATH = path.join(ROOT, "web/js/dwf-tiles.js");
const FOGPARAMS_PATH = path.join(ROOT, "docs/reference/fogparams.json");

const fog = JSON.parse(fs.readFileSync(FOGPARAMS_PATH, "utf8")).seeDown;
assert.ok(fog && fog.alphaByDepth && fog.fogColorRgb, "fixture assumption broken: fogparams.json's seeDown shape changed");

// ---- minimal DOM-less globals (just enough for the module to load without throwing; the
// fog hooks themselves are pure functions, so init()/boot() are never exercised here). ----
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
globalThis.Image = class { set src(_v) {} get src() { return ""; } };
globalThis.fetch = async () => ({ ok: false, json: async () => null });

vm.runInThisContext(fs.readFileSync(TILES_PATH, "utf8"), { filename: TILES_PATH });
const DwfTiles = globalThis.DwfTiles;
assert.ok(DwfTiles, "dwf-tiles.js did not install window.DwfTiles");
assert.equal(typeof DwfTiles._fogAlphaForDepthForTest, "function", "fog alpha test hook missing");
assert.equal(typeof DwfTiles._fogColorForTest, "function", "fog color test hook missing");

const canvasEl = new FakeCanvasEl();
const result = DwfTiles.init({ canvas: canvasEl, managePoll: false, manageCamera: false });
assert.ok(result, "init() returned null (canvas/context stub rejected)");

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}`); }
}

console.log("Measured see-down fog: canvas2d client curve/color vs fogparams.json");

// (a) fog color
const color = DwfTiles._fogColorForTest();
check("fog color RGB matches fogparams.json fogColorRgb " + JSON.stringify(fog.fogColorRgb),
  Array.isArray(color) && color.length === 3 &&
  color[0] === fog.fogColorRgb[0] && color[1] === fog.fogColorRgb[1] && color[2] === fog.fogColorRgb[2]);

// (b) named spot-check depths: 1, 3, 5 (measured table) and 10 (beyond the table's max of 9,
// exercising the clip-to-1.0 tail the same way depths 8/9 do).
const TOL = 0.01;
for (const depth of [1, 3, 5]) {
  const got = DwfTiles._fogAlphaForDepthForTest(depth);
  const want = fog.alphaByDepth[String(depth)];
  check(`depth ${depth}: fog alpha ${got.toFixed(4)} within ${TOL} of measured ${want}`,
    Math.abs(got - want) < TOL);
}
check("depth 10 (beyond the measured table's max of 9) clips to full fog (1.0)",
  DwfTiles._fogAlphaForDepthForTest(10) === 1);

// (c) camera plane / non-fogged inputs never fog.
check("depth 0 (camera plane) fogs to 0", DwfTiles._fogAlphaForDepthForTest(0) === 0);
check("negative depth fogs to 0 (defensive clamp)", DwfTiles._fogAlphaForDepthForTest(-3) === 0);
check("non-numeric depth (undefined) fogs to 0", DwfTiles._fogAlphaForDepthForTest(undefined) === 0);

// (d) every measured, non-clipped table entry (depth 1..7) is tracked to within TOL, and the
// curve is monotonically non-decreasing across the full measured range plus the clip tail.
let allTracked = true;
for (const depthStr of Object.keys(fog.alphaByDepth)) {
  const depth = Number(depthStr);
  const got = DwfTiles._fogAlphaForDepthForTest(depth);
  const want = fog.alphaByDepth[depthStr];
  if (Math.abs(got - want) >= TOL) {
    allTracked = false;
    console.log(`    mismatch at depth ${depth}: got ${got.toFixed(4)}, want ${want}`);
  }
}
check("every fogparams.json alphaByDepth entry (0..9) tracked within " + TOL, allTracked);

let monotone = true;
let prev = -1;
for (let d = 0; d <= 12; d++) {
  const v = DwfTiles._fogAlphaForDepthForTest(d);
  if (v < prev - 1e-9 || v > 1 + 1e-9) monotone = false;
  prev = v;
}
check("curve is monotonically non-decreasing and never exceeds 1 across depth 0..12", monotone);

console.log(failed === 0 ? "PASS (0 failures)" : `FAIL (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
