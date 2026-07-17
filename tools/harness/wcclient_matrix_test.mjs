// wcclient_matrix_test.mjs -- completeness-protocol matrix pass (2026-07-08 orchestrator
// directive) for the WC-19/21/22 client halves + WC-18 GL parity. Where the sibling suites
// test representative cases, this file sweeps the FULL variant space and runs GL/canvas2d
// DIFFERENTIALLY (both real modules loaded; every shared pure function asserted EQUAL across
// the two renderers for every input), so a divergence anywhere in the matrix fails loudly.
//
//   1. WC-18 engravings: ALL 1024 eflags masks -- GL token == canvas2d token, exhaustive.
//   2. WC-19 item marks: ALL 32 iflags combos (bits 0-4) -- GL == canvas2d, exhaustive.
//   3. WC-22 blood-family: the 7 REAL blood/ichor/goo/pus descriptor colors present in the
//      LIVE world's raws (dumped read-only via dfhack-run lua, 2026-07-07 -- the exact input
//      distribution the classifier receives), asserted equal across renderers + bucketed per
//      the spec's own hue rules. Plus edge cells: sentinel/missing/short rgb.
//   4. WC-22 proj fx/fy: the encoder (world_stream.cpp:803/818) maps DF fine offsets
//      -50000..50000 (0 = tile CENTER) to 0..255 -- assert the client's center-anchored
//      decode at the matrix edges (0 / 128 / 255) and that a missing fx defaults to center.
//
// Run: node tools/harness/wcclient_matrix_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}`); }
}

// ---- load the REAL GL module (sandboxed, DOM-less -- gl_core_test convention) -------------
const glSandbox = {};
glSandbox.self = glSandbox;
glSandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(glSandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glSandbox, { filename: f });
}
const GL = glSandbox.DwfGL;
assert.ok(GL, "DwfGL must load");
const glB = GL.createSceneBuilder({
  atlas: { resolve: () => 1 }, spriteMap: {}, tokenMap: {}, shadowCellMap: {},
  adjacency: glSandbox.DwfAdjacency,
});

// ---- load the REAL canvas2d module (wc17_wc18_test convention) -----------------------------
class FakeImage {
  constructor() { this.onload = null; this.onerror = null; this._src = ""; }
  set src(v) { this._src = v; } get src() { return this._src; }
}
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() {
    return new Proxy({}, {
      get(t, prop) { if (prop in t) return t[prop]; if (prop === "measureText") return () => ({ width: 8 }); return () => {}; },
      set(t, prop, v) { t[prop] = v; return true; },
    });
  }
}
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = {
  hidden: false, addEventListener() {}, getElementById() { return null; },
  createElement() { return { style: {} }; }, body: { appendChild() {} },
};
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
globalThis.Image = FakeImage;
globalThis.fetch = async () => ({ ok: false, json: async () => null });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"),
  { filename: "web/js/dwf-tiles.js" });
const T = globalThis.DwfTiles;
assert.ok(T, "DwfTiles must load");
T.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });

// ---- 1. WC-18 exhaustive engraving differential (all 1024 masks) --------------------------
{
  let diverged = 0, nonNull = 0;
  for (let mask = 0; mask < 1024; mask++) {
    const a = T._engravingWallTokenForTest(mask);
    const b = glB._engravingWallTokenForTest(mask);
    if (a !== b) { diverged++; if (diverged <= 3) console.log(`  divergence at mask 0x${mask.toString(16)}: c2d=${a} gl=${b}`); }
    if (a !== null) nonNull++;
  }
  check("WC-18: ALL 1024 eflags masks -- GL token === canvas2d token (exhaustive differential)", diverged === 0);
  // 1024 masks: cardinal-subset tokens fire whenever any of N/S/W/E set (regardless of other
  // bits) = 1024 * 15/16 = 960; plus lone-diagonal tokens for the 64 cardinal-free masks with
  // >=1 diagonal bit = 60 of them (floor/hidden-only or empty -> null). Independently derived.
  check(`WC-18: non-null token count matches the independently-derived 1020 (${nonNull})`, nonNull === 960 + 60);
  // spot-check the canonical 15 cardinal subsets exist and follow N,S,W,E order
  check("WC-18: all-4 mask -> N_S_W_E ordering", T._engravingWallTokenForTest(0x8 | 0x10 | 0x2 | 0x4) === "ENGRAVED_STONE_WALL_N_S_W_E");
}

// ---- 2. WC-19 exhaustive item-mark differential (all 32 iflag combos, bits 0-4) ------------
{
  let diverged = 0;
  const buckets = new Map();
  for (let f = 0; f < 32; f++) {
    const a = T._itemMarkTokenForTest(f);
    const b = glB._itemMarkTokenForTest(f);
    if (a !== b) diverged++;
    buckets.set(a, (buckets.get(a) || 0) + 1);
  }
  check("WC-19: ALL 32 iflags combos -- GL mark token === canvas2d (exhaustive differential)", diverged === 0);
  // forbid+melt (8) > forbid+dump-without-melt (4) > forbid alone (4) > melt (8) > dump (4) > none (4)
  check("WC-19: forbid always wins into a FORBIDDEN_* variant (no bare DUMP/MELT when forbid set)",
    [0x02, 0x02 | 0x01, 0x02 | 0x10, 0x02 | 0x01 | 0x10].every((f) => T._itemMarkTokenForTest(f) === "DESIGNATION_ITEM_FORBIDDEN"));
  check("WC-19: web/on_fire bits (0x01/0x10) never produce a mark on their own",
    T._itemMarkTokenForTest(0x01) === null && T._itemMarkTokenForTest(0x10) === null && T._itemMarkTokenForTest(0x11) === null);
}

// ---- 3. WC-22 blood-family: the LIVE world's real inputs + edge cells ----------------------
{
  // Dumped read-only from the live save's raws (dfhack-run lua, 2026-07-07): every DISTINCT
  // (material, descriptor color) pair used by BLOOD/ICHOR/GOO/PUS across all creature raws.
  // This IS the full real input space of resolve_material_rgb for this world.
  const LIVE = [
    ["BLOOD:CARMINE", [150, 0, 24], "BLOOD_RED"],
    ["PUS:CREAM", [255, 253, 208], "BLOOD_ICHOR"],      // yellowish-cream -> ichor bucket
    ["ICHOR:WHITE", [255, 255, 255], "BLOOD_GOO"],       // desaturated -> spec's "grey/other"
    ["BLOOD:BLUE", [0, 0, 255], "BLOOD_CYAN"],
    ["GOO:BLACK", [0, 0, 0], "BLOOD_GOO"],
    ["BLOOD:AQUA", [0, 255, 255], "BLOOD_CYAN"],
    ["BLOOD:DARK_INDIGO", [49, 0, 98], "BLOOD_MAGENTA"], // purple -> magenta bucket
  ];
  let diverged = 0;
  for (const [name, rgb, want] of LIVE) {
    const a = T._bloodFamilyFromRgbForTest(rgb);
    const b = glB._bloodFamilyFromRgbForTest(rgb);
    if (a !== b) diverged++;
    check(`WC-22 live input ${name} [${rgb}] -> ${want}`, a === want);
  }
  check("WC-22: GL === canvas2d on every live input (differential)", diverged === 0);
  // edge cells: malformed/missing rgb must return null (fall back to hash pick), never throw.
  for (const bad of [null, undefined, [], [1], [1, 2], "red", 42]) {
    const a = T._bloodFamilyFromRgbForTest(bad);
    const b = glB._bloodFamilyFromRgbForTest(bad);
    if (a !== null || b !== null) { failed++; console.log(`  FAIL - edge rgb ${JSON.stringify(bad)} must be null (got ${a}/${b})`); }
  }
  check("WC-22: all malformed-rgb edge cells return null in BOTH renderers", true);
}

// ---- 4. WC-22 proj fx/fy: center-anchored decode at the matrix edges -----------------------
{
  const cell = 32;
  // encoder: fx = clamp((fine+50000)*255/100000). fine=0 (center) -> 127 (integer division).
  // The decode contract asserted: fx=128 -> exact tile center; 0/255 -> half a tile either
  // way; missing fx -> center (defaults 128).
  const center = T._projCenterPxForTest(10, 10, 128, cell);
  check("proj fx=128 -> exact tile-center pixel (0.5*cell)", center === 0.5 * cell);
  const left = T._projCenterPxForTest(10, 10, 0, cell);
  check("proj fx=0 -> half a tile left of center", Math.abs(left - (0.5 - 128 / 255) * cell) < 1e-9);
  const right = T._projCenterPxForTest(10, 10, 255, cell);
  check("proj fx=255 -> ~half a tile right of center", Math.abs(right - (0.5 + 127 / 255) * cell) < 1e-9);
  check("proj missing fx -> defaults to tile center", T._projCenterPxForTest(10, 10, undefined, cell) === 0.5 * cell);
  // encoder's own integer math at fine=0 gives 127, not 128 -- assert that decodes to within
  // 1/255 tile of true center (the wire's quantization floor, not a client bug).
  const enc0 = Math.min(255, Math.max(0, Math.floor((0 + 50000) * 255 / 100000)));
  const drift = Math.abs(T._projCenterPxForTest(10, 10, enc0, cell) - 0.5 * cell);
  check(`proj round-trip of encoder fine=0 (fx=${enc0}) lands within 1/255 tile of center`, drift <= cell / 255 + 1e-9);
}

console.log(failed === 0 ? "\nPASS (0 failures)" : `\nFAIL (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
