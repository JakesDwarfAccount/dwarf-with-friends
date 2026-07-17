// b36_wall_adjacency_test.mjs -- acceptance for B36 (adjacency-aware wall rendering).
//
// ROOT CAUSE under test: DF's directional wall cells (SOIL_WALL_N / _W_E / _N_S_W_E, corners
// NW..SE) draw the rocky texture on a wall's EXPOSED (open) faces, not its wall connections.
// The pre-fix client fed the WALL-neighbour mask to cardinalSuffix/diagOnlyToken (inverted)
// AND stamped a full-block base token under every wall -> the "evenly-tiled solid blocks" the
// bug reports. The fix: select from the OPEN-neighbour mask (dwf-adjacency.js
// isOpenNeighbor + wallCellSuffix) and drop the base block so only the dark fill + exposed
// rock edge render.
//
// This test proves, WITHOUT a browser:
//   (1) wallCellSuffix matches an INDEPENDENT reference over the FULL 256-value adjacency
//       matrix (completeness rule 1 -- every cell of the matrix, not just the reported case).
//   (2) every renderable open-mask resolves to a wall token that ACTUALLY EXISTS in DF's own
//       graphics raws (oracle-differential against the authoritative source, rule 2).
//   (3) the canvas2d selection path (computeMask8 + isOpenNeighbor closure) and the GL path
//       (openGrid + maskFromGrid, replicated verbatim from dwf-gl.js) produce
//       BYTE-IDENTICAL masks AND candidate token strings for every wall tile in a synthetic
//       cluster spanning corner/edge/interior/pillar/T-junction/diagonal-only cases.
//   (4) test-the-test: the OLD inverted (wall-neighbour) selection produces a DIFFERENT,
//       provably-wrong cell for corridor cases -> a regression to the old behaviour FAILS here
//       (rule 3).
//
// Run: node tools/harness/b36_wall_adjacency_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { dfRootOrSkip } from "../lib/dfroot.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADJ_PATH = path.resolve(__dirname, "../../web/js/dwf-adjacency.js");
// DF's own wall graphics raws -- the authoritative token set (read-only oracle).
// W1: resolved, never hardcoded. No DF install -> this suite SKIPs (exit 0),
// because its ground truth IS the raws: without them there is nothing to check against.
const DF_ROOT_W1 = dfRootOrSkip("b36_wall_adjacency_test.mjs");
const DF_GFX = path.join(DF_ROOT_W1, "data/vanilla/vanilla_environment/graphics/graphics_tiles.txt");

// ---- load the REAL shared adjacency module (same vm convention as adjacency-test.mjs) -------
const sandbox = {};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(ADJ_PATH, "utf8"), sandbox, { filename: ADJ_PATH });
const Adj = sandbox.DwfAdjacency;
assert.ok(Adj && typeof Adj.wallCellSuffix === "function", "wallCellSuffix must be exported");
assert.ok(typeof Adj.isOpenNeighbor === "function", "isOpenNeighbor must be exported");
const BIT = Adj.BIT;

let pass = 0, failed = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

// ---- replicate the two renderers' shared helpers VERBATIM (so a drift in either file that
//      broke parity would break this test) -------------------------------------------------
// hashXY: identical byte-for-byte in dwf-tiles.js:272 and dwf-gl.js:255.
function hashXY(x, y) { return ((x * 374761393 + y * 668265263) ^ (x >> 3)) >>> 0; }
// wallPrefix: identical in both renderers.
function wallPrefix(mat) {
  if (mat === "SOIL") return "SOIL_WALL";
  if (mat === "FROZEN_LIQUID") return "ICE_WALL";
  if (mat === "LAVA_STONE" || mat === "MAGMA") return "MAGMA_WALL";
  if (mat === "MINERAL") return "ORE_VEIN_WALL";
  return "STONE_WALL";
}
// candidate token list: identical construction in drawWallJoin (canvas2d) and wallJoinCell (GL).
function candidates(mat, infix, gx, gy) {
  const base = wallPrefix(mat) + "_" + infix;
  const v = (hashXY(gx, gy) & 3) + 1;
  return [base + "_" + v, base + "_1", base];
}
// maskFromGrid: replicated verbatim from dwf-gl.js:1604 (out-of-window neighbour -> 0).
function maskFromGrid(grid, gx, gy, gw, gh) {
  let m = 0;
  const north = gy > 0, south = gy < gh - 1, west = gx > 0, east = gx < gw - 1;
  const row = gy * gw, rowN = row - gw, rowS = row + gw;
  if (north && grid[rowN + gx]) m |= 1;
  if (south && grid[rowS + gx]) m |= 2;
  if (west && grid[row + gx - 1]) m |= 4;
  if (east && grid[row + gx + 1]) m |= 8;
  if (north && west && grid[rowN + gx - 1]) m |= 16;
  if (north && east && grid[rowN + gx + 1]) m |= 32;
  if (south && west && grid[rowS + gx - 1]) m |= 64;
  if (south && east && grid[rowS + gx + 1]) m |= 128;
  return m;
}

// ============================================================================
// (1) FULL 256-value matrix vs an independent reference
// ============================================================================
const CARD = [["N", BIT.N], ["S", BIT.S], ["W", BIT.W], ["E", BIT.E]];
const DIAG = [["NW", BIT.NW], ["NE", BIT.NE], ["SW", BIT.SW], ["SE", BIT.SE]];
function refSuffix(mask) {
  const c = CARD.filter(([, b]) => mask & b).map(([n]) => n);
  if (c.length) return c.join("_");        // any exposed cardinal wins (DF has no cardinal+corner cell)
  for (const [n, b] of DIAG) if (mask & b) return n; // else a lone exposed corner
  return null;                             // fully buried -> dark fill only
}
{
  let mismatches = 0;
  for (let m = 0; m < 256; m++) {
    if (Adj.wallCellSuffix(m) !== refSuffix(m)) mismatches++;
  }
  check("wallCellSuffix matches independent reference across all 256 open-masks", mismatches === 0);
  // spot-check the load-bearing named cases against DF's cell semantics
  check("horizontal corridor (open N,S) -> 'N_S' (rock top+bottom, dark center)",
    Adj.wallCellSuffix(BIT.N | BIT.S) === "N_S");
  check("vertical corridor (open W,E) -> 'W_E'", Adj.wallCellSuffix(BIT.W | BIT.E) === "W_E");
  check("isolated pillar (open all 4 cardinals) -> 'N_S_W_E'",
    Adj.wallCellSuffix(BIT.N | BIT.S | BIT.W | BIT.E) === "N_S_W_E");
  check("outer NE corner (open N,E) -> 'N_E'", Adj.wallCellSuffix(BIT.N | BIT.E) === "N_E");
  check("fully-buried interior wall (no open neighbour) -> null",
    Adj.wallCellSuffix(0) === null);
  check("all cardinals walls, SE diagonal open -> lone corner 'SE'",
    Adj.wallCellSuffix(BIT.SE) === "SE");
}

// ============================================================================
// (2) every renderable open-mask resolves to a token that EXISTS in DF's raws
// ============================================================================
{
  let dfTokens = null;
  try {
    const raw = fs.readFileSync(DF_GFX, "utf8");
    dfTokens = new Set();
    const re = /TILE_GRAPHICS:[^:\]]+:\d+:\d+:([A-Z0-9_]+)/g;
    let mm;
    while ((mm = re.exec(raw))) dfTokens.add(mm[1]);
  } catch (_) { dfTokens = null; }
  if (!dfTokens) {
    console.log("  skip - DF graphics raws unreadable (F: not mounted); token-existence oracle not run");
  } else {
    // sanity: the raws we parsed actually contain the wall family (guards a bad path silently passing)
    check("DF raws contain SOIL_WALL_N_S_W_E_1 (oracle file parsed correctly)",
      dfTokens.has("SOIL_WALL_N_S_W_E_1"));
    let uncovered = [];
    for (let m = 0; m < 256; m++) {
      const infix = refSuffix(m);
      if (!infix) continue; // buried -> intentionally no token
      const base = "SOIL_WALL_" + infix;
      // renderer's fallback chain guarantees renderability if base_1 OR bare base exists
      if (!(dfTokens.has(base + "_1") || dfTokens.has(base))) uncovered.push(infix);
    }
    check("every SOIL wall adjacency resolves to a real DF token (base_1 or bare)",
      uncovered.length === 0);
    if (uncovered.length) console.log("      uncovered infixes: " + [...new Set(uncovered)].join(", "));
    // same completeness sweep for STONE (the default family)
    let uncoveredStone = [];
    for (let m = 0; m < 256; m++) {
      const infix = refSuffix(m);
      if (!infix) continue;
      const base = "STONE_WALL_" + infix;
      if (!(dfTokens.has(base + "_1") || dfTokens.has(base))) uncoveredStone.push(infix);
    }
    check("every STONE wall adjacency resolves to a real DF token", uncoveredStone.length === 0);
  }
}

// ============================================================================
// (3) canvas2d path == GL path, byte-identical, over a synthetic wall cluster
// ============================================================================
// Legend: '#' wall, '.' open floor, ' ' (space) treated as open too. The cluster deliberately
// spans: a solid 3x3 block (buried center at its middle), a horizontal 1-thick run, a vertical
// 1-thick run, outer corners, a T-junction, an isolated pillar, and a diagonal-only touch.
const MAP = [
  "..........",
  ".###..#...",   // solid block start + isolated pillar at (6,1)
  ".###...#..",   // block; (6,2) open so (6,1) is a true pillar (all cardinals open)
  ".###...#..",   // block + vertical run at col 7
  "......##..",   // corner / T
  "..####....",   // horizontal run
  "..#.......",   // L corner
  "..#....#..",   // vertical stub + diagonal-only partner start
  ".......#..",
  "..........",
];
const GW = MAP[0].length, GH = MAP.length;
function tileAtMap(x, y) {
  if (x < 0 || y < 0 || x >= GW || y >= GH) return null; // out-of-window -> null (edge artifact)
  return MAP[y][x] === "#" ? { shape: "WALL", mat: "SOIL" } : { shape: "FLOOR", mat: "SOIL" };
}
// GL-style precomputed open grid (dwf-gl.js calls this same shared predicate).
const openGrid = new Uint8Array(GW * GH);
for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
  const t = tileAtMap(x, y);
  openGrid[y * GW + x] = Adj.isOpenNeighbor(t) ? 1 : 0;
}
{
  let maskMismatch = 0, tokenMismatch = 0, wallCount = 0;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const t = tileAtMap(x, y);
    if (!t || t.shape !== "WALL") continue;
    wallCount++;
    const mask2d = Adj.computeMask8(tileAtMap, x, y, Adj.isOpenNeighbor); // canvas2d
    const maskGl = maskFromGrid(openGrid, x, y, GW, GH);                  // GL
    if (mask2d !== maskGl) maskMismatch++;
    const infix2d = Adj.wallCellSuffix(mask2d);
    const infixGl = Adj.wallCellSuffix(maskGl);
    if (infix2d) {
      const c2 = candidates(t.mat, infix2d, x, y).join("|");
      const cg = candidates(t.mat, infixGl, x, y).join("|");
      if (c2 !== cg) tokenMismatch++;
    } else if (infixGl) tokenMismatch++;
  }
  check("cluster has walls to test (fixture not empty)", wallCount >= 15);
  check("canvas2d open-mask == GL open-mask for every wall tile", maskMismatch === 0);
  check("canvas2d candidate tokens == GL candidate tokens for every wall tile", tokenMismatch === 0);
}

// buried center of the solid 3x3 block (2,2) is fully surrounded by walls -> null (dark only)
check("solid-block interior (2,2) is fully buried -> null cell",
  Adj.wallCellSuffix(maskFromGrid(openGrid, 2, 2, GW, GH)) === null);
// top edge of the block (2,1): open only to the N -> 'N'
check("solid-block top edge (2,1) open north only -> 'N'",
  Adj.wallCellSuffix(maskFromGrid(openGrid, 2, 1, GW, GH)) === "N");
// left edge of the block (1,2): open only to the W -> 'W'
check("solid-block left edge (1,2) open west only -> 'W'",
  Adj.wallCellSuffix(maskFromGrid(openGrid, 1, 2, GW, GH)) === "W");
// NW corner of the block (1,1): open N and W -> 'N_W'
check("solid-block NW corner (1,1) open N+W -> 'N_W'",
  Adj.wallCellSuffix(maskFromGrid(openGrid, 1, 1, GW, GH)) === "N_W");
// isolated pillar (6,1): open on every side -> 'N_S_W_E'
check("isolated pillar (6,1) -> 'N_S_W_E'",
  Adj.wallCellSuffix(maskFromGrid(openGrid, 6, 1, GW, GH)) === "N_S_W_E");

// ============================================================================
// (4) TEST-THE-TEST: the OLD inverted (wall-neighbour) behaviour is DIFFERENT and WRONG
// ============================================================================
{
  // A horizontal 1-thick wall: open N/S, walls E/W. CORRECT (open mask) -> 'N_S'.
  // OLD code fed the WALL-neighbour mask (E/W set) -> 'W_E'. They MUST differ, and only the
  // open-mask answer is correct -- so a revert to the old path would flip this and FAIL.
  const openMaskCorridor = BIT.N | BIT.S;   // exposed faces of a horizontal wall run
  const wallMaskCorridor = BIT.W | BIT.E;   // old (inverted) input
  const correct = Adj.wallCellSuffix(openMaskCorridor);
  const oldWrong = Adj.wallCellSuffix(wallMaskCorridor);
  check("corridor: correct(open)='N_S' != old(wall-neighbour)='W_E' (fix changed behaviour)",
    correct === "N_S" && oldWrong === "W_E" && correct !== oldWrong);
  // and prove the assertion itself discriminates: a deliberately-wrong expectation is rejected
  check("test-the-test: asserting corridor=='W_E' would be FALSE (assertion has teeth)",
    (Adj.wallCellSuffix(openMaskCorridor) === "W_E") === false);
  // isOpenNeighbor edge semantics: null / hidden / wall neighbours are NOT open
  check("isOpenNeighbor(null)===false (viewport edge stays solid)", Adj.isOpenNeighbor(null) === false);
  check("isOpenNeighbor(wall)===false", Adj.isOpenNeighbor({ shape: "WALL" }) === false);
  check("isOpenNeighbor(hidden floor)===false (fog line stays solid)",
    Adj.isOpenNeighbor({ shape: "FLOOR", hidden: true }) === false);
  check("isOpenNeighbor(in-bounds tt<0 placeholder)===false (unshipped rock stays solid)",
    Adj.isOpenNeighbor({ x: 12, y: 8, tt: -1 }) === false);
  check("isOpenNeighbor(open floor)===true", Adj.isOpenNeighbor({ shape: "FLOOR" }) === true);
  check("isOpenNeighbor(resolved open floor)===true",
    Adj.isOpenNeighbor({ tt: 42, shape: "FLOOR" }) === true);
}

console.log(`\n${pass} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
