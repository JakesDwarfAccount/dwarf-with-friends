// wt11_voxel_mesh_test.mjs -- offline fixture acceptance for WT11 (3D world viewer), MESH stage.
//
// Asserts the PURE per-face-culled mesher (web/js/dwf-voxel-mesh.js): exact exposed-face
// counts on hand-computable fixtures (a single voxel, an adjacent pair, a solid cube, and a
// box-boundary case), that interior faces are culled and box-boundary faces are emitted, and that
// the chunked builder is byte-identical to a single full build (PERF: mesh over multiple frames
// without changing the result).
//
// Run: node tools/harness/wt11_voxel_mesh_test.mjs   (zero-dep, Node >= 18)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-voxel-mesh.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("dwf-voxel-mesh.js node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);
check("exports the mesher API", ["buildMesh", "countFaces", "createBuilder", "concatMeshes"].every(k => typeof M[k] === "function"));

// A field is {dimX,dimY,dimZ,solid:Uint8Array,color:Uint8Array}. Helper to build a solid box of a
// given size with every voxel filled, plus a sparse setter.
function idx(f, x, y, z) { return x + f.dimX * (y + f.dimY * z); }
function makeField(dx, dy, dz) {
  const n = dx * dy * dz;
  return { dimX: dx, dimY: dy, dimZ: dz, solid: new Uint8Array(n), color: new Uint8Array(n * 3) };
}
function setSolid(f, x, y, z, r, g, b) {
  const i = idx(f, x, y, z); f.solid[i] = 1;
  f.color[i * 3] = r || 200; f.color[i * 3 + 1] = g || 200; f.color[i * 3 + 2] = b || 200;
}

// ---- single voxel: all 6 faces exposed (surrounded by air/out-of-field) ----------------------
const one = makeField(3, 3, 3); setSolid(one, 1, 1, 1);
check("single interior voxel exposes 6 faces", M.countFaces(one, 0, one.dimZ) === 6);
const oneMesh = M.buildMesh(one);
check("6 faces -> 36 verts", oneMesh.vertCount === 36 && oneMesh.faceCount === 6);
check("positions buffer sized faces*18", oneMesh.positions.length === 6 * 18);

// ---- adjacent pair: the shared face is culled on BOTH sides ----------------------------------
const pair = makeField(3, 1, 1); setSolid(pair, 0, 0, 0); setSolid(pair, 1, 0, 0);
check("adjacent pair exposes 10 faces (12 - 2 shared)", M.countFaces(pair, 0, 1) === 10);

// ---- 2x2x2 solid cube: only the 24 surface faces, all 24 interior-shared culled --------------
const cube = makeField(2, 2, 2);
for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) setSolid(cube, x, y, z);
check("2x2x2 cube exposes 24 surface faces (interior culled)", M.countFaces(cube, 0, 2) === 24, `${M.countFaces(cube, 0, 2)}`);
guard("if interior faces were NOT culled it would be 48 -- confirm we culled",
  M.countFaces(cube, 0, 2) !== 8 * 6);

// ---- box boundary: a voxel flush against the field edge still emits its outward face ----------
const edge = makeField(1, 1, 1); setSolid(edge, 0, 0, 0);
check("a 1x1x1 field (voxel touches every boundary) emits all 6 faces", M.countFaces(edge, 0, 1) === 6);

// ---- normals + winding sanity: +Z (up) face normal points up --------------------------------
// The up face of the single voxel: find a vertex whose z is the top (2.0 for voxel at z=1) with
// normal (0,0,1).
(() => {
  let sawUp = false;
  for (let v = 0; v < oneMesh.vertCount; v++) {
    if (oneMesh.normals[v * 3 + 2] === 1 && oneMesh.positions[v * 3 + 2] === 2) sawUp = true;
  }
  check("up-face verts carry a +Z normal at the voxel top", sawUp);
})();

// ---- CHUNKED build == full build (PERF: mesh across frames, same bytes) -----------------------
// A larger mixed field so slabs span solid and air.
const big = makeField(6, 6, 8);
for (let z = 0; z < 8; z++) for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
  if ((x + y + z) % 3 !== 0) setSolid(big, x, y, z, x * 30, y * 30, z * 20);
}
const full = M.buildMesh(big);
const builder = M.createBuilder(big, { slabZ: 2 });
let steps = 0;
while (builder.step()) { steps++; if (steps > 100) break; }
const chunked = builder.result();
check("chunked builder ran multiple slabs", steps >= 2, `steps=${steps}`);
check("chunked faceCount == full faceCount", chunked.faceCount === full.faceCount, `${chunked.faceCount} vs ${full.faceCount}`);
check("chunked vertCount == full vertCount", chunked.vertCount === full.vertCount);
const posEq = full.positions.length === chunked.positions.length && full.positions.every((v, i) => v === chunked.positions[i]);
const colEq = full.colors.length === chunked.colors.length && full.colors.every((v, i) => v === chunked.colors[i]);
const nrmEq = full.normals.length === chunked.normals.length && full.normals.every((v, i) => v === chunked.normals[i]);
check("chunked positions byte-identical to full", posEq);
check("chunked colors byte-identical to full", colEq);
check("chunked normals byte-identical to full", nrmEq);
guard("the fixture actually produced faces (not an empty no-op equivalence)", full.faceCount > 50, `${full.faceCount}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
