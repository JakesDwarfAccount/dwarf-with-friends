// b62_trunk_walljoin_test.mjs -- B62 acceptance/regression gate.
//
// The owner bug B62 (evidence pair 4.png native vs 5.png browser, 2026-07-08): ground-surface tree
// TRUNK slices rendered as GREY STONE RUBBLE SQUARES instead of the native round tan wood-ring
// cross-sections. Root mechanism (c): a surface trunk tile is tiletype_material TREE (mushroom
// caps: MUSHROOM) with tiletype_shape WALL, so it flowed through BOTH renderers' wall paths --
//   (1) tileColor's WALL branch darkened it to a near-black stone-wall interior, and
//   (2) drawWallJoin / wallJoinCell painted the STONE_WALL adjacency edge cell over it
//       (wallPrefix has no TREE/MUSHROOM case -> STONE_WALL). For a lone open-surrounded trunk
//       the edge cell is the near-full STONE_WALL_N_S_W_E rubble block, drawn AFTER drawTree,
//       so it overpainted the round trunk slice into a grey square.
// Fix: EXEMPT TREE/MUSHROOM WALL tiles from both the stone wall-edge and the wall-darken passes
// in BOTH renderers (they own their round drawTree/emitTree trunk/cap cell).
//
// This is a test-the-test gate: every TREE/MUSHROOM assertion below asserts the POST-fix value
// and would FAIL against the pre-fix code (which returned a STONE_WALL token / a darkened base
// for those tiles). The new _wallJoinBaseTokenForTest / _isTreeWallMatForTest hooks also do not
// exist pre-fix, so a reverted fix cannot silently pass.
//
// Run: node tools/harness/b62_trunk_walljoin_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADJ_PATH = path.resolve(__dirname, "../../web/js/dwf-adjacency.js");
const TILES_PATH = path.resolve(__dirname, "../../web/js/dwf-tiles.js");
const GL_PATH = path.resolve(__dirname, "../../web/js/dwf-gl.js");

// ---- minimal DOM-less globals (same shape as wc14_tree_test.mjs) --------------------------
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
const TREE_MAP_PATH = path.resolve(__dirname, "../../web/tree_map.json");
const realTreeMap = JSON.parse(fs.readFileSync(TREE_MAP_PATH, "utf8"));
globalThis.fetch = async (url) => {
  if (String(url).indexOf("tree_map.json") !== -1) return { ok: true, json: async () => realTreeMap };
  return { ok: false, json: async () => null };
};

// Load the REAL adjacency module first (drawWallJoin/wallJoinBaseToken read window.DwfAdjacency).
vm.runInThisContext(fs.readFileSync(ADJ_PATH, "utf8"), { filename: ADJ_PATH });
const Adj = globalThis.DwfAdjacency;
assert.ok(Adj && typeof Adj.wallCellSuffix === "function", "dwf-adjacency.js must export wallCellSuffix");

// Load the REAL canvas2d renderer.
vm.runInThisContext(fs.readFileSync(TILES_PATH, "utf8"), { filename: TILES_PATH });
const DwfTiles = globalThis.DwfTiles;
assert.ok(DwfTiles, "dwf-tiles.js did not install window.DwfTiles");
assert.ok(typeof DwfTiles._isTreeWallMatForTest === "function", "missing _isTreeWallMatForTest hook (B62 fix not applied?)");
assert.ok(typeof DwfTiles._wallJoinBaseTokenForTest === "function", "missing _wallJoinBaseTokenForTest hook (B62 fix not applied?)");
assert.ok(typeof DwfTiles._tileColorForTest === "function", "missing _tileColorForTest hook (B62 fix not applied?)");

// init() kicks off the async map loads (tree_map.json via the fetch mock above); wait for it.
DwfTiles.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });
{
  const t0 = Date.now();
  while (true) {
    const sel0 = DwfTiles._parseTreeTtnameForTest("TreeTrunkPillar");
    if (DwfTiles._resolveTreeCellForTest(sel0, "MAPLE")) break;
    if (Date.now() - t0 > 2000) break; // resolution assertions below will report the failure
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Load the REAL GL renderer in its own sandbox (same convention as wc14_tree_test.mjs).
const glSandbox = { self: {}, performance: { now: () => 0 } };
glSandbox.self = glSandbox;
vm.createContext(glSandbox);
vm.runInContext(fs.readFileSync(GL_PATH, "utf8"), glSandbox, { filename: "dwf-gl.js" });
const GL = glSandbox.DwfGL;
assert.ok(GL && typeof GL.isTreeWallMat === "function", "dwf-gl.js must export isTreeWallMat (B62 parity)");
assert.ok(typeof GL.wallPrefix === "function", "dwf-gl.js must export wallPrefix");

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}`); }
}
const rgbEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 &&
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// Full cardinal open-face mask (N|S|W|E) -> a lone surface trunk's "all 4 sides exposed" case,
// exactly the STONE_WALL_N_S_W_E rubble block that overpainted the trunks pre-fix.
const OPEN_ALL = 1 | 2 | 4 | 8;

console.log("B62 canvas2d: predicate");
check("isTreeWallMat(TREE) === true", DwfTiles._isTreeWallMatForTest("TREE") === true);
check("isTreeWallMat(MUSHROOM) === true", DwfTiles._isTreeWallMatForTest("MUSHROOM") === true);
check("isTreeWallMat(STONE) === false", DwfTiles._isTreeWallMatForTest("STONE") === false);
check("isTreeWallMat(SOIL) === false", DwfTiles._isTreeWallMatForTest("SOIL") === false);

console.log("B62 canvas2d: wall-join edge token (the grey rubble block)");
const stoneTok = DwfTiles._wallJoinBaseTokenForTest({ shape: "WALL", mat: "STONE" }, OPEN_ALL);
check("STONE WALL still gets a STONE_WALL_* edge token", typeof stoneTok === "string" && stoneTok.indexOf("STONE_WALL_") === 0);
// The core regression: a TREE/MUSHROOM trunk must get NO stone edge token (pre-fix: STONE_WALL_N_S_W_E).
check("TREE WALL trunk gets NO wall-join token (was STONE_WALL_* pre-fix)",
  DwfTiles._wallJoinBaseTokenForTest({ shape: "WALL", mat: "TREE" }, OPEN_ALL) === null);
check("MUSHROOM WALL cap gets NO wall-join token",
  DwfTiles._wallJoinBaseTokenForTest({ shape: "WALL", mat: "MUSHROOM" }, OPEN_ALL) === null);
check("non-WALL (FLOOR) never gets a wall-join token",
  DwfTiles._wallJoinBaseTokenForTest({ shape: "FLOOR", mat: "STONE" }, OPEN_ALL) === null);
check("fully-buried STONE WALL (mask 0) gets no token",
  DwfTiles._wallJoinBaseTokenForTest({ shape: "WALL", mat: "STONE" }, 0) === null);

console.log("B62 canvas2d: base-fill corner color (the near-black box vs natural wood)");
const stoneBase = DwfTiles._tileColorForTest({ tt: 5, shape: "WALL", mat: "STONE" }, true);
const treeBase = DwfTiles._tileColorForTest({ tt: 5, shape: "WALL", mat: "TREE" }, true);
check("STONE WALL base is DARKENED (unchanged behaviour)", rgbEq(stoneBase, [58, 58, 58]));
// Pre-fix TREE base was darken([86,66,40],0.45) = [39,30,18] (near-black); post-fix it is the
// natural wood tone [86,66,40] so the round trunk's transparent corners read as wood, not a box.
check("TREE WALL base is the natural wood tone [86,66,40] (was near-black [39,30,18] pre-fix)",
  rgbEq(treeBase, [86, 66, 40]));

console.log("B62 GL parity");
check("GL isTreeWallMat(TREE) === true", GL.isTreeWallMat("TREE") === true);
check("GL isTreeWallMat(MUSHROOM) === true", GL.isTreeWallMat("MUSHROOM") === true);
check("GL isTreeWallMat(STONE) === false", GL.isTreeWallMat("STONE") === false);
check("GL/canvas2d predicate agree for TREE", GL.isTreeWallMat("TREE") === DwfTiles._isTreeWallMatForTest("TREE"));
// Documents that BOTH renderers' exemption -- not a wallPrefix change -- is what saves trees:
// wallPrefix still maps TREE -> STONE_WALL, so the guard in the wall-join is load-bearing.
check("GL wallPrefix(TREE) is still STONE_WALL (the guard, not wallPrefix, is the fix)",
  GL.wallPrefix("TREE") === "STONE_WALL");

// ============================================================================================
// B62-r2 (follow-up, evidence pair 7.png browser vs 8.png native):
//   (1) TAIL-LESS TREE TILES -- see-down-substituted tree tiles (and live trunks whose wire
//       plant-pos lookup missed) ship NO plant tail; drawTree/emitTree's `if (!p) return`
//       guard left a bare brown box ("trunks overdrawn by the brown box"). Post-fix, the part
//       is derived from shape/mat (the wire's own mapping) and species falls to _default.
//   (2) GRASS BACKING -- tree tiles' backing must read as GRASS (borrowed from real
//       GRASS_LIGHT/GRASS_DARK neighbors, Chebyshev rings 1..3), never the flat wood-tone
//       "brown box", and never invented grass when no grass-mat neighbor exists.
// Test-the-test: every hook below is absent pre-r2, and each behavioural assertion encodes
// the post-fix value (pre-fix: no derivation hook, no backing hook, GL scene emits only a
// brown solid for a tail-less tree tile).
// ============================================================================================

console.log("B62-r2 canvas2d: derivedTreePart (the wire's shape/mat -> part mapping)");
assert.ok(typeof DwfTiles._derivedTreePartForTest === "function", "missing _derivedTreePartForTest (B62-r2 fix not applied?)");
assert.ok(typeof DwfTiles._grassBackingCellForTest === "function", "missing _grassBackingCellForTest (B62-r2 fix not applied?)");
const dp = DwfTiles._derivedTreePartForTest;
const PART_MATRIX = [
  [{ shape: "WALL", mat: "TREE" }, "TRUNK"],
  [{ shape: "WALL", mat: "MUSHROOM" }, "TRUNK"],
  [{ shape: "TRUNK_BRANCH", mat: "TREE" }, "TRUNK"],
  [{ shape: "BRANCH", mat: "TREE" }, "BRANCH"],
  [{ shape: "TWIG", mat: "TREE" }, "LEAVES"],
  [{ shape: "FLOOR", mat: "TREE" }, "CANOPY"],
  [{ shape: "RAMP", mat: "TREE" }, "CANOPY"],
  [{ shape: "WALL", mat: "STONE" }, null],
  [{ shape: "SHRUB", mat: "PLANT" }, null],   // drawPlant's domain, never derived
];
for (const [t, want] of PART_MATRIX) {
  check(`derivedTreePart(${t.shape}/${t.mat}) === ${JSON.stringify(want)}`, dp(t) === want);
}
// A tail-less pillar must still resolve real art through the normal chain with a null species
// (this is exactly what drawTree does post-fix; pre-fix it bailed before resolution).
{
  const sel = DwfTiles._parseTreeTtnameForTest("TreeTrunkPillar");
  const cellR = DwfTiles._resolveTreeCellForTest(sel, null);
  check("tail-less TreeTrunkPillar resolves the _default pillar cell (trees.png:11:12)",
    !!cellR && cellR.sheet === "trees.png" && cellR.col === 11 && cellR.row === 12);
}

console.log("B62-r2 canvas2d: grass backing (borrowed neighbor grass, ring 1 only -- B71/B107 reach fix)");
const gbc = DwfTiles._grassBackingCellForTest;
function gridLookup(grid) {
  // grid: { "gx,gy": tileObj } fixture
  return (x, y) => grid[x + "," + y] || null;
}
const TREE_T = { shape: "WALL", mat: "TREE" };
{
  const g = { "5,4": { mat: "GRASS_LIGHT" } }; // cardinal ring-1 neighbor
  const cellB = gbc(TREE_T, 5, 5, gridLookup(g));
  check("ring-1 GRASS_LIGHT neighbor -> grass.png backing cell",
    !!cellB && cellB.sheet === "grass.png" && cellB.row === 0 && cellB.col >= 0 && cellB.col <= 3);
}
check("ring-1 diagonal GRASS_DARK neighbor -> backing found",
  !!gbc(TREE_T, 5, 5, gridLookup({ "6,6": { mat: "GRASS_DARK" } })));
check("B71/B107: ring-2 grass is OUT of range -> null (band no longer spreads past ring 1)",
  gbc(TREE_T, 5, 5, gridLookup({ "7,5": { mat: "GRASS_LIGHT" } })) === null);
check("distance-3+ grass is OUT of range -> null (no invented grass)",
  gbc(TREE_T, 5, 5, gridLookup({ "8,5": { mat: "GRASS_LIGHT" } })) === null);
check("dry/dead grass neighbors never trigger the backing",
  gbc(TREE_T, 5, 5, gridLookup({ "5,4": { mat: "GRASS_DRY" }, "4,5": { mat: "GRASS_DEAD" } })) === null);
check("hidden grass neighbor never triggers the backing",
  gbc(TREE_T, 5, 5, gridLookup({ "5,4": { mat: "GRASS_LIGHT", hidden: true } })) === null);
check("no neighbors at all -> null (wood-tone fill keeps ownership)",
  gbc(TREE_T, 5, 5, gridLookup({})) === null);
check("non-tree tile (STONE wall) never gets grass backing even beside grass",
  gbc({ shape: "WALL", mat: "STONE" }, 5, 5, gridLookup({ "5,4": { mat: "GRASS_LIGHT" } })) === null);
{
  const g = gridLookup({ "5,4": { mat: "GRASS_LIGHT" } });
  const a = gbc(TREE_T, 5, 5, g), b = gbc(TREE_T, 5, 5, g);
  check("variant pick is deterministic per tile (hashXY)", !!a && !!b && a.col === b.col);
}

console.log("B62-r2 GL parity: module-level helpers");
assert.ok(typeof GL.derivedTreePart === "function", "GL must export derivedTreePart (B62-r2)");
assert.ok(typeof GL.isGrassBackingSource === "function", "GL must export isGrassBackingSource (B62-r2)");
assert.ok(Array.isArray(GL.GRASS_BACK_OFFSETS), "GL must export GRASS_BACK_OFFSETS (B62-r2)");
{
  let bad = 0;
  for (const [t, want] of PART_MATRIX) if (GL.derivedTreePart(t) !== want) bad++;
  check("GL derivedTreePart is value-identical to canvas2d across the matrix", bad === 0);
}
check("B71/B107: GRASS_BACK_OFFSETS is ring 1 ONLY (8 offsets, was 48 across rings 1..3)",
  GL.GRASS_BACK_OFFSETS.length === 8);
check("every GRASS_BACK_OFFSET is Chebyshev distance 1 (no reach past immediate neighbors)",
  GL.GRASS_BACK_OFFSETS.every((o) => Math.max(Math.abs(o[0]), Math.abs(o[1])) === 1));
check("GL isGrassBackingSource accepts live GRASS_LIGHT/GRASS_DARK, rejects dry/dead/hidden",
  GL.isGrassBackingSource({ mat: "GRASS_LIGHT" }) && GL.isGrassBackingSource({ mat: "GRASS_DARK" }) &&
  !GL.isGrassBackingSource({ mat: "GRASS_DRY" }) && !GL.isGrassBackingSource({ mat: "GRASS_DEAD" }) &&
  !GL.isGrassBackingSource({ mat: "GRASS_LIGHT", hidden: true }) && !GL.isGrassBackingSource(null));

console.log("B62-r2 GL integration: a TAIL-LESS tree tile beside grass emits grass backing + trunk art");
{
  // Mock atlas assigning stable ids (gl_core_test convention).
  const ids = new Map(); let next = 1;
  const atlas = { resolve(sheet, col, row) { const k = sheet + "|" + col + "|" + row; if (!ids.has(k)) ids.set(k, next++); return ids.get(k); } };
  const treeMapFix = { _default: { TREE_TRUNK_PILLAR: { _: { sheet: "trees.png", col: 11, row: 12 } }, TRUNK: { sheet: "trees.png", col: 11, row: 12 } } };
  const spriteMapFix = {};
  const tokenMapFix = { GrassLightFloor1: { token: "GRASS_1", tint: "grassSummer" } };
  const b = GL.createSceneBuilder({ atlas, spriteMap: spriteMapFix, tokenMap: tokenMapFix, shadowCellMap: { wallShadow: {}, visionShadow: {}, rampShadowOnRamp: {} }, adjacency: glSandbox.DwfAdjacency, treeMap: treeMapFix });
  const mk = (o) => Object.assign({ tt: 1, ttname: "", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
  const grass = () => mk({ ttname: "GrassLightFloor1", mat: "GRASS_LIGHT" });
  // NOTE: no `plant` key on the tree tile -- the pre-fix code emits ONLY the brown solid here.
  const treeTile = mk({ tt: 93, ttname: "TreeTrunkPillar", shape: "WALL", mat: "TREE" });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 3, height: 1, tiles: [grass(), treeTile, grass()] });
  const buf = b.buffer, n = b.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf);
  const midInstances = [];
  for (let k = 0; k < n; k++) if (f32[k * 4] === 1 && f32[k * 4 + 1] === 0) midInstances.push(u16[k * 8 + 4]);
  const pillarCell = atlas.resolve("trees.png", 11, 12);
  const grassCells = [0, 1, 2, 3].map((c) => atlas.resolve("grass.png", c, 0));
  const hasPillar = midInstances.indexOf(pillarCell) !== -1;
  const grassIdx = midInstances.findIndex((c) => grassCells.indexOf(c) !== -1);
  check("tail-less tree tile emits its _default pillar art (pre-fix: nothing)", hasPillar);
  check("tail-less tree tile emits a grass.png backing cell (pre-fix: brown solid only)", grassIdx !== -1);
  check("grass backing draws BEFORE the pillar art (painter order)",
    grassIdx !== -1 && hasPillar && grassIdx < midInstances.indexOf(pillarCell));
}

console.log(failed === 0 ? "\nB62 PASS" : `\nB62 FAIL (${failed} assertion(s))`);
process.exit(failed === 0 ? 0 : 1);
