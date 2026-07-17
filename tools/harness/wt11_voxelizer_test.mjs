// wt11_voxelizer_test.mjs -- offline fixture acceptance for WT11 (3D world viewer), DATA stage.
//
// Asserts the PURE voxelizer (web/js/dwf-voxelizer.js): the solidity rules (walls/floors
// solid; air/unexplored/void empty), the box-fit / cap-degrade math, and -- the completeness-
// protocol keystone -- that each solid voxel's color is BYTE-IDENTICAL to the 2D map's material
// color (dwf-tiles.js's tileColor, the WALLSFIX/TX16 path), not a re-implemented palette.
//
// Run: node tools/harness/wt11_voxelizer_test.mjs   (zero-dep, Node >= 18)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { loadTiles } from "./groundart_fixture_support.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-voxelizer.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);
const eqRgb = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("dwf-voxelizer.js node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const V = require(modPath);
check("exports the voxelizer API", ["voxelize", "isSolidTile", "fitBox", "isSolidAt"].every(k => typeof V[k] === "function"));

// ---- solidity rules --------------------------------------------------------------------------
const floor = { tt: 5, shape: "FLOOR", mat: "SOIL" };
const wall = { tt: 6, shape: "WALL", mat: "STONE", base_mt: -1, base_mi: -1 };
const air = { tt: 7, shape: "EMPTY", mat: "AIR" };
const rampTop = { tt: 8, shape: "RAMP_TOP", mat: "AIR" };
const hiddenWall = { tt: 6, shape: "WALL", mat: "STONE", hidden: 1 };
const voidTile = { tt: -1 };

check("floor is solid", V.isSolidTile(floor) === true);
check("wall is solid", V.isSolidTile(wall) === true);
check("open air is empty", V.isSolidTile(air) === false);
check("ramp-top (rampspace) is empty", V.isSolidTile(rampTop) === false);
check("unexplored (hidden) wall is omitted", V.isSolidTile(hiddenWall) === false);
check("void tile (tt<0) is empty", V.isSolidTile(voidTile) === false);
check("null tile is empty", V.isSolidTile(null) === false);
guard("a NONE-shape tile is not solid", V.isSolidTile({ tt: 1, shape: "NONE", mat: "STONE" }) === false);

// ---- box fit / cap degrade -------------------------------------------------------------------
const noDeg = V.fitBox(96, 96, 20, 240000);
check("default 96x96x20 does not degrade (< cap)", noDeg.degraded === false && noDeg.W === 96 && noDeg.H === 96 && noDeg.D === 20);
const deg = V.fitBox(200, 200, 20, 240000);
check("oversized box degrades", deg.degraded === true);
check("degraded box stays within the cap", deg.W * deg.H * deg.D <= 240000, `${deg.W}x${deg.H}x${deg.D}`);
check("degrade preserves z-depth when it can", deg.D === 20, `D=${deg.D}`);
guard("degrade shaves z only after the footprint hits the floor",
  (() => { const r = V.fitBox(8, 8, 100000, 240000); return r.W === 8 && r.H === 8 && r.D < 100000 && r.W * r.H * r.D <= 240000; })());

// ---- voxelize a tiny hand-built world --------------------------------------------------------
// A 3x3 column stack: z=cz (top) is all air; z=cz-1 is a floor plate; below that a wall block at
// center only. readTile is the injected data source (the strangler seam).
const T = loadTiles();
const world = new Map();
const key = (x, y, z) => `${x},${y},${z}`;
function put(x, y, z, t) { world.set(key(x, y, z), t); }
const CX = 100, CY = 100, CZ = 50;
// top plane: air everywhere (nothing solid)
// cz-1 plane: 3x3 floor
for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) put(CX + dx, CY + dy, CZ - 1, { tt: 5, shape: "FLOOR", mat: "SOIL" });
// cz-2 plane: single center wall
put(CX, CY, CZ - 2, { tt: 6, shape: "WALL", mat: "STONE", base_mt: -1, base_mi: -1 });
const readTile = (x, y, z) => world.get(key(x, y, z)) || null;

const field = V.voxelize({
  readTile, colorFn: (t) => T.tileColor(t, true),
  cx: CX, cy: CY, cz: CZ, boxW: 3, boxH: 3, zDown: 3, maxVoxels: 240000,
});
check("field dims match the requested box", field.dimX === 3 && field.dimY === 3 && field.dimZ === 3);
check("top slice (camera z) is the last z index", field.oz + field.dimZ - 1 === CZ);
check("solid count = 9 floors + 1 wall", field.count === 10, `count=${field.count}`);
check("center wall voxel is solid", V.isSolidAt(field, 1, 1, 0));
check("a top-plane cell is empty (open air)", !V.isSolidAt(field, 1, 1, 2));
check("note reports the box size", field.note === "showing 3x3x3 around camera");

// ---- MATERIAL-COLOR PARITY vs the 2D path (completeness keystone) ----------------------------
// The stored voxel color MUST equal what the 2D map draws for the same tile.
function voxelRgbAt(f, x, y, z) { const i = V.index(f, x, y, z) * 3; return [f.color[i], f.color[i + 1], f.color[i + 2]]; }
const floorExpect = T.tileColor(floor, true);      // SOIL floor base color from the 2D path
const wallExpect = T.tileColor(wall, true);        // STONE wall -> darken(matRgb(STONE), WALL_DARKEN)
check("2D path gives the SOIL floor its material color", eqRgb(floorExpect, [120, 82, 48]), JSON.stringify(floorExpect));
check("2D path darkens the STONE wall below its floor tone", wallExpect[0] < 128 && wallExpect[0] === wallExpect[2], JSON.stringify(wallExpect));
// The voxelized floor plane cells carry the 2D floor color exactly:
check("voxel floor color == 2D floor color", eqRgb(voxelRgbAt(field, 0, 0, 1), floorExpect), JSON.stringify(voxelRgbAt(field, 0, 0, 1)));
// The voxelized center wall carries the 2D wall color exactly:
check("voxel wall color == 2D wall color (WALLSFIX/TX16 path)", eqRgb(voxelRgbAt(field, 1, 1, 0), wallExpect), JSON.stringify(voxelRgbAt(field, 1, 1, 0)));
check("wall voxel is visibly darker than floor voxel (real material dispatch, not a constant)",
  voxelRgbAt(field, 1, 1, 0)[0] < voxelRgbAt(field, 0, 0, 1)[0]);
guard("a WRONG colorFn changes the stored color (the field really stores colorFn's output)",
  (() => {
    const bad = V.voxelize({ readTile, colorFn: () => [1, 2, 3], cx: CX, cy: CY, cz: CZ, boxW: 3, boxH: 3, zDown: 3 });
    return eqRgb(voxelRgbAt(bad, 0, 0, 1), [1, 2, 3]) && !eqRgb(voxelRgbAt(bad, 0, 0, 1), floorExpect);
  })());

// ---- cap forces a degrade end-to-end ---------------------------------------------------------
const capped = V.voxelize({ readTile, colorFn: () => [9, 9, 9], cx: CX, cy: CY, cz: CZ, boxW: 400, boxH: 400, zDown: 40, maxVoxels: 50000 });
check("end-to-end degrade sets the flag + honest note", capped.degraded === true && /showing \d+x\d+x\d+ around camera/.test(capped.note));
check("degraded field stays within its own cap", capped.dimX * capped.dimY * capped.dimZ <= 50000);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
