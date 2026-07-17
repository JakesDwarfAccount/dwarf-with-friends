// marker_recolor_test.mjs -- MARKER-COLOR: pins the fitted native marker-mode recolour constants
// in BOTH renderers and asserts they are byte-equal. Ground truth: a live native probe of a
// normal vs marker-mode dig designation on adjacent identical wall tiles
// (tools/orchestrator/attachments/MARKER-COLOR-{1,2}.png). See dwf-gl.js's MARKER_RECOLOR
// banner for the full fit (blue preserved byte-exactly; wash multiply R x0.43 G x0.68 B x1.00;
// no global transform fits the whole cell -> fixed blue palette).
// Run: node tools/harness/marker_recolor_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + ": " + (err?.stack || err)); }
}
// GL loads in a separate vm realm, so its arrays have a cross-realm prototype that trips
// assert.deepEqual's strict prototype check. Normalise every array to this realm before comparing.
const a = (x) => Array.from(x);

// ---- load GL module (CommonJS export) ------------------------------------------------------
const glbox = { self: null, performance: { now: () => 0 }, module: { exports: {} } };
glbox.self = glbox;
vm.createContext(glbox);
vm.runInContext(read("web", "js", "dwf-gl.js"), glbox, { filename: "dwf-gl.js" });
const GL = glbox.DwfGL;

// ---- load canvas2d module (needs window/document stubs, same as waveb_designation_test) -----
const store = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {}, getContext() { return {}; } }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
globalThis.Image = class { set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });
class FakeCanvas { constructor() { this.width = 800; this.height = 600; this.style = {}; } addEventListener() {} removeEventListener() {} getContext() { return new Proxy({}, { get(t, k) { if (k in t) return t[k]; if (k === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, k, v) { t[k] = v; return true; } }); } }
vm.runInThisContext(read("web", "js", "dwf-tiles.js"), { filename: "dwf-tiles.js" });
const Tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });

// ---- the fitted constants (single source of truth for the harvest diff) --------------------
const EXPECT = {
  MARKER_RECOLOR: [0.43, 0.68, 1.0],   // native per-channel multiply (blue exact)
  MARKER_GLYPH_TINT: [110, 173, 255],  // round(255 * MARKER_RECOLOR)
  MARKER_WASH_RGB: [32, 50, 78],       // native measured marker-wash colour (flat cell)
  DESIG_WASH_ALPHA_MARKER: 0.5,
};

check("GL exposes the fitted marker constants", () => {
  assert.deepEqual(a(GL.MARKER_RECOLOR), EXPECT.MARKER_RECOLOR);
  assert.deepEqual(a(GL.MARKER_GLYPH_TINT), EXPECT.MARKER_GLYPH_TINT);
  assert.deepEqual(a(GL.MARKER_WASH_RGB), EXPECT.MARKER_WASH_RGB);
  assert.equal(GL.DESIG_WASH_ALPHA_MARKER, EXPECT.DESIG_WASH_ALPHA_MARKER);
});

check("canvas2d exposes the fitted marker constants", () => {
  assert.deepEqual(Tiles._MARKER_RECOLOR, EXPECT.MARKER_RECOLOR);
  assert.deepEqual(Tiles._MARKER_GLYPH_TINT, EXPECT.MARKER_GLYPH_TINT);
  assert.deepEqual(Tiles._MARKER_WASH_RGB, EXPECT.MARKER_WASH_RGB);
  assert.equal(Tiles._DESIG_WASH_ALPHA_MARKER, EXPECT.DESIG_WASH_ALPHA_MARKER);
});

check("both renderers agree byte-for-byte (parity)", () => {
  assert.deepEqual(a(Tiles._MARKER_RECOLOR), a(GL.MARKER_RECOLOR), "MARKER_RECOLOR equal");
  assert.deepEqual(a(Tiles._MARKER_GLYPH_TINT), a(GL.MARKER_GLYPH_TINT), "MARKER_GLYPH_TINT equal");
  assert.deepEqual(a(Tiles._MARKER_WASH_RGB), a(GL.MARKER_WASH_RGB), "MARKER_WASH_RGB equal");
  assert.equal(Tiles._DESIG_WASH_ALPHA_MARKER, GL.DESIG_WASH_ALPHA_MARKER, "marker wash alpha equal");
  assert.equal(Tiles._DESIG_WASH_ALPHA, GL.DESIG_WASH_ALPHA, "active wash alpha equal");
});

check("glyph tint is exactly round(255 * MARKER_RECOLOR)", () => {
  const r = a(GL.MARKER_RECOLOR);
  assert.deepEqual(a(GL.MARKER_GLYPH_TINT), [Math.round(255 * r[0]), Math.round(255 * r[1]), Math.round(255 * r[2])]);
});

check("blue channel is preserved exactly by the fit (multiplier == 1.0)", () => {
  // The probe's headline invariant: Bmarker == Bnormal for all 2304 sampled pixel pairs.
  assert.equal(GL.MARKER_RECOLOR[2], 1.0, "blue multiplier must be exactly 1.0 (blue preserved)");
});

check("fitted multiply reproduces the banked native wash anchor to +-2", () => {
  // Native flat wash: normal (76,73,78) -> marker (32,50,78). This anchor validated cell alignment.
  const n = [76, 73, 78], want = [32, 50, 78], r = GL.MARKER_RECOLOR;
  const got = n.map((v, i) => Math.round(v * r[i]));
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i] - want[i]) <= 2, `channel ${i}: ${got[i]} vs ${want[i]}`);
});

if (failed) { console.error(`\nFAIL ${failed} marker-recolor fixture(s)`); process.exit(1); }
console.log("\nPASS MARKER-COLOR recolour constants (both renderers, parity)");
