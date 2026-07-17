// treegrass_ghost_tint_test.mjs -- TREEGRASS wave acceptance for:
//   * B98 RIDER (ghost tint): a unit with wire flag gh:1 must get the SAME spectral-green
//     multiply + DF ghost translucency in BOTH renderers, across every sprite tier and the
//     tier-5 fallback dot. Seeded-bad (test-the-test): a LIVING unit (gh absent / gh:0) must
//     get NO tint (white 255, full alpha) -- so the tint is conditional, not unconditional.
//   * B83 / B103 (tree-body species): proves the CLIENT contract the wire fix depends on --
//     a trunk tile whose PLANT tail carries a real species id (e.g. WILLOW) resolves that
//     species' own trunk cell, while an EMPTY id (the pre-fix state for every non-root tree
//     tile) collapses to tree_map._default. Shipping the species id from the server
//     (wire_v1.cpp tree_info body/roots lookup) is therefore exactly what removes the
//     "willow trunk looks like a foreign species" / "upper canopy looks like mushrooms" bug.
//
// GL is loaded in its own vm context (wb13 convention); the canvas2d module is loaded via
// runInThisContext with the wc14 DOM-less stubs. Real committed web/creatures_map.json +
// web/tree_map.json -- no synthetic maps.
//
// Run: node tools/harness/treegrass_ghost_tint_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const realCreaturesMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/creatures_map.json"), "utf8"));
const realTreeMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/tree_map.json"), "utf8"));

// ---- fixture-assumption guards -------------------------------------------------------------
assert.ok(realCreaturesMap.races && realCreaturesMap.races.AARDVARK &&
  realCreaturesMap.races.AARDVARK.sheet, "fixture broken: AARDVARK is no longer a flat sheet race");
assert.ok(realTreeMap.WILLOW, "fixture broken: tree_map.json no longer has WILLOW");
assert.ok(realTreeMap._default, "fixture broken: tree_map.json no longer has _default");

let failures = 0;
function section(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}
// Element-wise numeric-array equality -- assert.deepEqual checks prototype identity, which
// differs for arrays created inside the GL vm context (a separate realm), so a plain
// deepEqual on GL.GHOST_TINT_RGB spuriously fails even when the numbers match.
function sameNums(a, b, msg) {
  assert.ok(a && b && a.length === b.length, msg + " (length)");
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], msg + " [" + i + "]");
}

// =============================================================================================
// GL renderer (own vm context, wb13 convention)
// =============================================================================================
const glSandbox = {};
glSandbox.self = glSandbox;
glSandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(glSandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8"), glSandbox,
  { filename: "web/js/dwf-gl.js" });
const GL = glSandbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");
assert.ok(Array.isArray(GL.GHOST_TINT_RGB) && typeof GL.GHOST_ALPHA === "number",
  "DwfGL must export GHOST_TINT_RGB + GHOST_ALPHA");

function makeUnitMockAtlas(readySet) {
  readySet = readySet || new Set();
  const ids = new Map();
  let next = 1;
  return {
    registerDynamicSheet(key) { return readySet.has(key); },
    resolve(sheetOrKey, col, row) {
      const k = sheetOrKey + "|" + col + "|" + row;
      if (!ids.has(k)) ids.set(k, next++);
      return ids.get(k);
    },
    // tier-5 fallback dot goes through resolveStamp in buildUnits
    resolveStamp(key) {
      if (!ids.has(key)) ids.set(key, next++);
      return ids.get(key);
    },
  };
}
function glInstances(builder) {
  const buf = builder.buffer, n = builder.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4],
      r: u8[k * 16 + 12], g: u8[k * 16 + 13], b: u8[k * 16 + 14], a: u8[k * 16 + 15],
    });
  }
  return out;
}
const [GR, GG, GB] = GL.GHOST_TINT_RGB;
const GHOST_A255 = Math.round(GL.GHOST_ALPHA * 255);

section("GL tier-3 flat race: a ghost (gh:1) instance carries the green multiply + ghost alpha", () => {
  const b = GL.createSceneBuilder({ atlas: makeUnitMockAtlas(), creaturesMap: realCreaturesMap });
  b.buildUnits([{ id: 1, x: 4, y: 4, z: 5, rt: "AARDVARK", gh: 1 }], 0, 0, 5);
  const inst = glInstances(b).filter((i) => i.cell > 0);
  assert.ok(inst.length >= 1, "ghost unit should emit at least one instance");
  const g = inst[0];
  assert.deepEqual([g.r, g.g, g.b], [GR, GG, GB], "ghost instance tint must be GHOST_TINT_RGB");
  assert.equal(g.a, GHOST_A255, "ghost instance alpha must be GHOST_ALPHA*255");
});

section("GL tier-3 LIVING unit is NOT tinted (test-the-test: white 255, full alpha)", () => {
  const b = GL.createSceneBuilder({ atlas: makeUnitMockAtlas(), creaturesMap: realCreaturesMap });
  b.buildUnits([{ id: 1, x: 4, y: 4, z: 5, rt: "AARDVARK" }], 0, 0, 5);           // no gh
  const inst = glInstances(b).filter((i) => i.cell > 0);
  assert.ok(inst.length >= 1);
  const g = inst[0];
  assert.deepEqual([g.r, g.g, g.b], [255, 255, 255], "living unit must be untinted white");
  assert.equal(g.a, 255, "living unit must be fully opaque");
});

section("GL tier-5 fallback dot ALSO greens for a ghost (unknown race + gh:1)", () => {
  const b = GL.createSceneBuilder({ atlas: makeUnitMockAtlas(), creaturesMap: realCreaturesMap });
  b.buildUnits([{ id: 1, x: 2, y: 2, z: 5, rt: "TOTALLY_MADE_UP_RACE", gh: 1 }], 0, 0, 5);
  const inst = glInstances(b).filter((i) => i.cell > 0);
  assert.ok(inst.length >= 1, "fallback dot should emit an instance");
  const g = inst[0];
  assert.deepEqual([g.r, g.g, g.b], [GR, GG, GB], "ghost fallback dot must carry the green tint");
  assert.equal(g.a, GHOST_A255, "ghost fallback dot alpha must be GHOST_ALPHA*255");
});

// =============================================================================================
// canvas2d renderer (globalThis stubs, wc14 convention) -- loaded AFTER GL so its globalThis
// installs don't perturb the GL sandbox (which has its own context).
// =============================================================================================
class FakeImage { constructor() { this.onload = null; this.onerror = null; this._src = ""; this.width = 32; this.height = 32; } set src(v) { this._src = v; } get src() { return this._src; } }
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
}
const storageBacking = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = {
  hidden: false, addEventListener() {}, getElementById() { return null; },
  createElement() { return new FakeCanvasEl(); }, body: { appendChild() {} },
};
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: (k) => (k in storageBacking ? storageBacking[k] : null), setItem: (k, v) => { storageBacking[k] = String(v); } };
globalThis.Image = FakeImage;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf("tree_map.json") !== -1) return { ok: true, json: async () => realTreeMap };
  if (u.indexOf("creatures_map.json") !== -1) return { ok: true, json: async () => realCreaturesMap };
  return { ok: false, json: async () => null };
};

vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"),
  { filename: "web/js/dwf-tiles.js" });
const Tiles = globalThis.DwfTiles;
assert.ok(Tiles, "dwf-tiles.js must install window.DwfTiles");
Tiles.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });

section("canvas2d ghost constants are byte-identical to the GL renderer's", () => {
  sameNums(Tiles._ghostTintRgbForTest, GL.GHOST_TINT_RGB, "GHOST_TINT_RGB must match across renderers");
  assert.equal(Tiles._ghostAlphaForTest, GL.GHOST_ALPHA, "GHOST_ALPHA must match across renderers");
});

section("canvas2d unitGhostPlan: ghost -> green plan, living -> null (test-the-test)", () => {
  const plan = Tiles._unitGhostPlanForTest({ gh: 1 });
  assert.ok(plan, "gh:1 must return a ghost plan");
  sameNums(plan.rgb, GL.GHOST_TINT_RGB, "ghost plan rgb");
  assert.equal(plan.alpha, GL.GHOST_ALPHA);
  assert.equal(Tiles._unitGhostPlanForTest({}), null, "a unit with no gh flag must NOT be tinted");
  assert.equal(Tiles._unitGhostPlanForTest({ gh: 0 }), null, "gh:0 (explicit living) must NOT be tinted");
});

// =============================================================================================
// B83 / B103: the client contract the wire tree_info fix delivers against.
// =============================================================================================
async function waitUntil(pred, maxMs) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > (maxMs || 1500)) throw new Error("waitUntil timed out"); await new Promise((r) => setTimeout(r, 1)); }
}

(async function main() {
  // tree_map.json loads async through the stubbed fetch.
  try {
    await waitUntil(() => {
      const c = Tiles._resolveTreeCellForTest({ family: "TREE_TRUNK", variant: "NSWE" }, "WILLOW");
      return !!c;
    }, 1500);
  } catch (_) { /* fall through: the section below will fail loudly if the map never loaded */ }

  section("B83/B103: a WILLOW trunk resolves WILLOW's OWN cell, distinct from tree_map._default", () => {
    const sel = { family: "TREE_TRUNK", variant: "NSWE" };
    const willow = Tiles._resolveTreeCellForTest(sel, "WILLOW");
    const dflt = Tiles._resolveTreeCellForTest(sel, null);   // empty id == every non-root tree tile pre-fix
    assert.ok(willow, "WILLOW trunk cell must resolve");
    assert.ok(dflt, "empty-id trunk must resolve to a _default cell");
    const key = (c) => `${c.sheet}:${c.col}:${c.row}`;
    assert.notEqual(key(willow), key(dflt),
      "species id is load-bearing: WILLOW's trunk cell must differ from _default -- so shipping the " +
      "id from the server (wire_v1.cpp tree_info body lookup) is what fixes the wrong-trunk bug");
  });

  section("B83/B103: empty id (pre-fix non-root tree tile) collapses to _default == the reported bug", () => {
    const sel = { family: "TREE_TRUNK", variant: "NSWE" };
    const dflt = Tiles._resolveTreeCellForTest(sel, "");
    const dfltNull = Tiles._resolveTreeCellForTest(sel, null);
    assert.ok(dflt, "empty-string id must still resolve (to _default)");
    const key = (c) => `${c.sheet}:${c.col}:${c.row}`;
    assert.equal(key(dflt), key(dfltNull), "empty-string and null id both fall to the same _default cell");
  });

  if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
  console.log("\nAll treegrass ghost-tint + tree-body fixtures passed.");
})();
