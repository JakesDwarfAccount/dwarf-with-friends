// wc14_tree_test.mjs -- WC-14 acceptance deliverable (docs/superpowers/specs/
// 2026-07-07-WC-coverage-spec.md chunk E, "tree part/direction/dead derivation from ttname").
// Loads the REAL web/js/dwf-tiles.js module (verbatim, via vm.runInThisContext) in a
// minimally-mocked DOM-less environment, same convention as wc4_building_test.mjs/
// wc3_we4_wc12_apply_test.mjs, and exercises its debug-only test hooks:
//   - _parseTreeTtnameForTest(ttname)               -- ttname -> {family,variant,dead,...}
//   - _resolveTreeCellForTest(sel, id, gx, gy)       -- selector -> real tree_map.json cell
//
// Fixture data: a set of REAL (ttname, tiletype_material) pairs pulled from the live DF
// session's /tiletype_meta.json this session (df::tiletype is a fixed static enum -- these
// values do not change between saves/sessions, see http_server.cpp's build_tiletype_meta_json,
// which iterates ALL 1000 enum slots unconditionally, not just tiles seen in the current world).
//
// Asserts, against the REAL committed web/tree_map.json:
//   (a) exact family+variant derivation for a representative slice of the ~160 tree tiletypes
//       (directional trunk/branch/thick-trunk/cap-wall/cap-floor/pillar/twigs/dead), including
//       the two direction-letter-order gotchas found this session (the tiletype enum's own
//       PascalCase name is NOT always in DF's canonical N,S,W,E order -- TreeTrunkEW/NEW/SEW
//       must resolve to tree_map's WE/NWE/SWE keys, not a literal EW/NEW/SEW miss) and the
//       underscore-joined CAP_WALL (non-THICK) family (WALL_N_S_W_E, not WALL_NSWE);
//   (b) a `...Dead` ttname resolves to a LEAFLESS_TWIGS cell, never the live TWIGS cell;
//   (c) TreeCapRamp/TreeDeadCapRamp resolve to `skip` (DF's own raws mark these "uses empty
//       tile" -- no art, the true floor/ramp underneath must show through);
//   (d) a captured "one tree" fixture (a plausible single MAPLE crown: pillar/thick trunk on
//       4 sides + interior, 2 branch directions, isolated twigs) resolves to >=8 DISTINCT
//       (sheet,col,row) cells -- the old code (one flat cell per {TRUNK,BRANCH,CANOPY,LEAVES})
//       could never exceed 4 for the same fixture, which this test also proves directly by
//       showing every one of those ttnames' OLD flat-key cell collapses to just 4 distinct
//       values while the new per-ttname resolution does not.
//
// Run: node tools/harness/wc14_tree_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILES_PATH = path.resolve(__dirname, "../../web/js/dwf-tiles.js");
const TREE_MAP_PATH = path.resolve(__dirname, "../../web/tree_map.json");

const realTreeMap = JSON.parse(fs.readFileSync(TREE_MAP_PATH, "utf8"));
assert.ok(realTreeMap.MAPLE && realTreeMap.MAPLE.TREE_TRUNK && realTreeMap.MAPLE.TREE_TRUNK.NSWE,
  "fixture assumption broken: tree_map.json's MAPLE no longer has TREE_TRUNK.NSWE");
assert.ok(realTreeMap.TOWER_CAP && realTreeMap.TOWER_CAP.TREE_CAP,
  "fixture assumption broken: tree_map.json's TOWER_CAP no longer has a TREE_CAP family");

// ---- minimal DOM-less globals (same shape as wc4_building_test.mjs / wc3_we4_wc12_apply_test.mjs) --
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
  const u = String(url);
  if (u.indexOf("tree_map.json") !== -1) return { ok: true, json: async () => realTreeMap };
  return { ok: false, json: async () => null };
};

const src = fs.readFileSync(TILES_PATH, "utf8");
vm.runInThisContext(src, { filename: TILES_PATH });
const DwfTiles = globalThis.DwfTiles;
assert.ok(DwfTiles, "dwf-tiles.js did not install window.DwfTiles");
assert.ok(typeof DwfTiles._parseTreeTtnameForTest === "function", "missing _parseTreeTtnameForTest hook");
assert.ok(typeof DwfTiles._resolveTreeCellForTest === "function", "missing _resolveTreeCellForTest hook");

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

function cellEq(a, b) {
  return !!a && !!b && a.sheet === b.sheet && a.col === b.col && a.row === b.row;
}
function cellKey(c) {
  return c ? `${c.sheet}:${c.col}:${c.row}` : "<null>";
}

(async function main() {
  console.log("WC-14: tree part/direction/dead derivation from ttname");

  // tree_map.json loads asynchronously; wait for a known family/variant to stop being null.
  await waitUntil(() => {
    const sel = DwfTiles._parseTreeTtnameForTest("TreeTrunkNSWE");
    const cell = sel && DwfTiles._resolveTreeCellForTest(sel, "MAPLE");
    return !!cell;
  }, 2000);

  // ---- (a) exact family+variant derivation against the REAL tree_map.json -------------------
  const CASES = [
    // [ttname, species, expectedFamily.variant path in tree_map.json]
    ["TreeTrunkNSWE", "MAPLE", ["TREE_TRUNK", "NSWE"]],
    ["TreeTrunkN", "MAPLE", ["TREE_TRUNK", "N"]],
    // direction-letter-order gotcha: the tiletype enum spells this "EW" (E before W); DF's own
    // canonical order (matching every tree_map.json multi-letter key) is "WE".
    ["TreeTrunkEW", "MAPLE", ["TREE_TRUNK", "WE"]],
    ["TreeTrunkNEW", "MAPLE", ["TREE_TRUNK", "NWE"]],
    ["TreeTrunkSEW", "MAPLE", ["TREE_TRUNK", "SWE"]],
    ["TreeTrunkThickNW", "MAPLE", ["TREE_TRUNK_THICK", "NW"]],
    ["TreeTrunkInterior", "MAPLE", ["TREE_TRUNK_THICK", "INTERIOR"]],
    ["TreeTrunkPillar", "MAPLE", ["TREE_TRUNK_PILLAR", "_"]],
    ["TreeBranchNS", "MAPLE", ["TREE_BRANCH", "NS"]],
    ["TreeTrunkBranchN", "MAPLE", ["TREE_BASE", "TRUNK_N"]],
    // the mushroom-only CAP family: non-THICK CAP_WALL is underscore-joined per direction
    // letter in the raws (verified) -- WALL_N_S_W_E, not WALL_NSWE.
    ["TreeCapWallNSWE", "TOWER_CAP", ["TREE_CAP", "WALL_N_S_W_E"]],
    ["TreeCapWallThickSW", "TOWER_CAP", ["TREE_CAP", "WALL_THICK_SW"]],
    ["TreeCapInterior", "TOWER_CAP", ["TREE_CAP", "THICK_INTERIOR"]],
    ["TreeCapFloor2", "TOWER_CAP", ["TREE_CAP", "FLOOR_2"]],
    ["TreeCapPillar", "TOWER_CAP", ["TREE_CAP", "PILLAR"]],
  ];
  for (const [ttname, species, [fam, variant]] of CASES) {
    const sel = DwfTiles._parseTreeTtnameForTest(ttname);
    check(`${ttname} parses to family ${fam}`, !!sel && sel.family === fam);
    const expected = realTreeMap[species] && realTreeMap[species][fam] && realTreeMap[species][fam][variant];
    assert.ok(expected, `fixture assumption broken: tree_map.json's ${species}.${fam}.${variant} no longer exists`);
    const got = DwfTiles._resolveTreeCellForTest(sel, species);
    check(`${ttname} (${species}) resolves to the REAL tree_map.json ${fam}.${variant} cell (${cellKey(expected)})`,
      cellEq(got, expected));
  }

  // ---- (b) dead ttname -> LEAFLESS_TWIGS, never the live TWIGS cell -------------------------
  const deadSel = DwfTiles._parseTreeTtnameForTest("TreeDeadTwigs");
  check("TreeDeadTwigs parses dead=true, family TREE_LEAFLESS_TWIGS",
    !!deadSel && deadSel.dead === true && deadSel.family === "TREE_LEAFLESS_TWIGS");
  const deadCell = DwfTiles._resolveTreeCellForTest(deadSel, "MAPLE");
  const liveSel = DwfTiles._parseTreeTtnameForTest("TreeTwigs");
  const liveCell = DwfTiles._resolveTreeCellForTest(liveSel, "MAPLE");
  check("TreeDeadTwigs resolves to tree_map.json's real TREE_LEAFLESS_TWIGS._ cell",
    cellEq(deadCell, realTreeMap.MAPLE.TREE_LEAFLESS_TWIGS._));
  check("a dead twigs cell is NEVER the live TWIGS cell (snow/dead != leafy, generalized)",
    !cellEq(deadCell, liveCell));

  // ---- (c) TreeCapRamp / TreeDeadCapRamp -> skip (no art; raws say "uses empty tile") -------
  check("TreeCapRamp parses to {skip:true}", DwfTiles._parseTreeTtnameForTest("TreeCapRamp").skip === true);
  check("TreeDeadCapRamp parses to {skip:true}", DwfTiles._parseTreeTtnameForTest("TreeDeadCapRamp").skip === true);
  check("resolveTreeCell on a skip selector returns null (nothing drawn)",
    DwfTiles._resolveTreeCellForTest({ skip: true }, "MAPLE") == null);

  // ---- (d) one MAPLE tree -> >=8 distinct cells (vs <=4 for the old flat 4-part collapse) ---
  const oneTreeTtnames = [
    "TreeTrunkPillar", "TreeTrunkThickN", "TreeTrunkThickS", "TreeTrunkThickE", "TreeTrunkThickW",
    "TreeTrunkInterior", "TreeBranchN", "TreeBranchE", "TreeTwigs",
  ];
  const newCells = oneTreeTtnames.map((tt) => {
    const sel = DwfTiles._parseTreeTtnameForTest(tt);
    return DwfTiles._resolveTreeCellForTest(sel, "MAPLE");
  });
  const distinctNew = new Set(newCells.map(cellKey));
  check(`one-tree fixture (${oneTreeTtnames.length} ttnames) resolves to >=8 distinct cells (got ${distinctNew.size})`,
    distinctNew.size >= 8);

  // The old (pre-WC-14) code keyed purely on the wire's coarse `plant.part` (TRUNK/BRANCH/
  // CANOPY/LEAVES) via a flat treeMap[id][part] lookup -- model that directly against the SAME
  // fixture and prove it collapses to <=4 distinct cells, so the >=8 above is a real ratchet,
  // not just a different number.
  const OLD_PART_FOR_TTNAME = {
    TreeTrunkPillar: "TRUNK", TreeTrunkThickN: "TRUNK", TreeTrunkThickS: "TRUNK",
    TreeTrunkThickE: "TRUNK", TreeTrunkThickW: "TRUNK", TreeTrunkInterior: "TRUNK",
    TreeBranchN: "BRANCH", TreeBranchE: "BRANCH", TreeTwigs: "LEAVES",
  };
  const oldCells = oneTreeTtnames.map((tt) => realTreeMap.MAPLE[OLD_PART_FOR_TTNAME[tt]]);
  const distinctOld = new Set(oldCells.map(cellKey));
  check(`the SAME fixture under the old flat-part lookup collapses to <=4 distinct cells (got ${distinctOld.size}), proving the ratchet`,
    distinctOld.size <= 4);

  // ---- (e) B47: GL parser PARITY with canvas2d -- the GL copy had drifted (no canonicalDirs
  // re-sort, "Interior" instead of "TrunkInterior", CAP_WALL letters not underscore-joined),
  // so those tiles fell to flat fallbacks in GL only. Load the REAL dwf-gl.js and
  // assert byte-identical selector output for every ttname exercised above + the drift cases.
  const GL_PATH = path.resolve(__dirname, "../../web/js/dwf-gl.js");
  const glSandbox = { self: {}, performance: { now: () => 0 } };
  glSandbox.self = glSandbox;
  vm.createContext(glSandbox);
  vm.runInContext(fs.readFileSync(GL_PATH, "utf8"), glSandbox, { filename: "dwf-gl.js" });
  const GL = glSandbox.DwfGL;
  assert.ok(GL && GL.parseTreeTtname, "dwf-gl.js must export parseTreeTtname");
  const PARITY_TTNAMES = CASES.map((c) => c[0]).concat([
    "TreeTrunkInterior", "TreeTrunkEW", "TreeTrunkNEW", "TreeTrunkSEW", "TreeBranchEW",
    "TreeCapWallNS", "TreeCapWallNSWE", "TreeDeadTwigs", "TreeCapRamp", "TreeTwigs",
    "TreeTrunkSloping", "TreeRoots", "TreeBranches",
  ]);
  let parityBad = 0;
  for (const tt of PARITY_TTNAMES) {
    const a = DwfTiles._parseTreeTtnameForTest(tt);
    const g = GL.parseTreeTtname(tt);
    if (JSON.stringify(a) !== JSON.stringify(g)) {
      parityBad++;
      console.log(`  parity mismatch ${tt}: c2d=${JSON.stringify(a)} gl=${JSON.stringify(g)}`);
    }
  }
  check(`[B47] GL parseTreeTtname is selector-identical to canvas2d for all ${PARITY_TTNAMES.length} ttnames (drift cases included)`,
    parityBad === 0);

  // ---- (f) B47: TREE_OVERLEAVES overlay (canopy leaves over live directional trunk/branch
  // cells -- the "trunks render as rocks" canopy fix). Both renderers must resolve the SAME
  // per-species overlay cell; dead selectors and non-directional variants resolve nothing.
  check("[fixture guard][B47] tree_map's MAPLE carries TREE_OVERLEAVES TRUNK_/HEAVY_BRANCH_ variants",
    !!(realTreeMap.MAPLE.TREE_OVERLEAVES && realTreeMap.MAPLE.TREE_OVERLEAVES.TRUNK_NS &&
       realTreeMap.MAPLE.TREE_OVERLEAVES.HEAVY_BRANCH_NS));
  const trunkSel = DwfTiles._parseTreeTtnameForTest("TreeTrunkNS");
  const overC2d = DwfTiles._resolveOverleavesForTest(trunkSel, "MAPLE");
  check("[B47] canvas2d resolves TreeTrunkNS (MAPLE, live) to the TREE_OVERLEAVES.TRUNK_NS leaf overlay",
    cellEq(overC2d, realTreeMap.MAPLE.TREE_OVERLEAVES.TRUNK_NS));
  const overGL = GL.resolveOverleavesGL(realTreeMap, GL.parseTreeTtname("TreeTrunkNS"), "MAPLE");
  check("[B47] GL resolves the SAME overlay cell (renderer parity)", cellEq(overGL, overC2d));
  const branchSel = DwfTiles._parseTreeTtnameForTest("TreeBranchNS");
  check("[B47] a directional BRANCH cell resolves its HEAVY_BRANCH_ overlay",
    cellEq(DwfTiles._resolveOverleavesForTest(branchSel, "MAPLE"), realTreeMap.MAPLE.TREE_OVERLEAVES.HEAVY_BRANCH_NS));
  const deadTrunkSel = DwfTiles._parseTreeTtnameForTest("TreeDeadTrunkNS");
  check("[test-the-test][B47] a DEAD trunk resolves NO overlay (leafless trees stay leafless)",
    DwfTiles._resolveOverleavesForTest(deadTrunkSel, "MAPLE") == null);
  const pillarSel = DwfTiles._parseTreeTtnameForTest("TreeTrunkPillar");
  check("[test-the-test][B47] a non-directional variant (TrunkPillar '_') resolves NO overlay (no such raw cell -- never fabricated)",
    DwfTiles._resolveOverleavesForTest(pillarSel, "MAPLE") == null);

  console.log(failed === 0 ? "PASS (0 failures)" : `FAIL (${failed} failures)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error("FATAL:", err && err.stack || err);
  process.exit(1);
});
