// b35_djobs_test.mjs -- B35 acceptance (bug list B35: smooth/engrave/detail/carve
// designation glyphs DROP in-browser once DF converts the designation into a JOB and clears
// the tile's designation bits -- native keeps drawing from the live job). Server adds an
// additive AUX array `djobs:[{x,y,z,k}]` (world_stream.cpp); both renderers draw the matching
// glyph for a djob tile EVEN WHEN t.desig is null/cleared. This test loads the REAL
// web/js/dwf-gl.js verbatim via vm.runInContext (same convention as wb14_overlay_test.mjs)
// and exercises the GL renderer's djob path -- resolveDjob resolution + buildScene emission on
// cleared-bit tiles + the "prefer live bits, fall back to job" precedence.
//
// Run: node tools/harness/b35_djobs_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const sandbox = {};
sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8"), sandbox, { filename: "web/js/dwf-gl.js" });
const GL = sandbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");
assert.ok(typeof GL.resolveDjob === "function", "DwfGL must export resolveDjob (B35)");

// The kind codes are the server DJobRec contract: 1=smooth 2=engrave 3=fortify 4=track
// 5=chop 6=gather. designations.png cell layout (DESIG_CELL): smooth [0,10], engrave
// [0,11], fortify [0,12], chop [0,8], gather [0,9]; DESIG_TRACK_CELL[15] (all-directions)
// = [1,14].
const SMOOTH_CELL = [0, 10], ENGRAVE_CELL = [0, 11], FORTIFY_CELL = [0, 12], TRACK_ALL_CELL = [1, 14];
const CHOP_CELL = [0, 8], GATHER_CELL = [0, 9];

function makeMockAtlas() {
  const ids = new Map();
  let next = 1;
  return { resolve(sheet, col, row) { const k = sheet + "|" + col + "|" + row; if (!ids.has(k)) ids.set(k, next++); return ids.get(k); } };
}
function decode(builder) {
  const buf = builder.buffer, n = builder.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4], attr: u16[k * 8 + 5],
      r: u8[k * 16 + 12], g: u8[k * 16 + 13], b: u8[k * 16 + 14], a: u8[k * 16 + 15],
    });
  }
  return out;
}
function tile(o) {
  return Object.assign({ tt: 1, ttname: "", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
}
let failures = 0;
function section(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}
function assertResolve(actual, cell, cat) {
  assert.ok(actual, "resolveDjob returned null unexpectedly");
  assert.equal(actual.cat, cat);
  assert.equal(actual.cell[0], cell[0]); assert.equal(actual.cell[1], cell[1]);
}

// =============================================================================================
// resolveDjob: kind -> designations.png cell/category (mirrors dwf-tiles.js's resolveDjob).
// =============================================================================================
section("resolveDjob: kinds 1..6 map to native designation cells", () => {
  assertResolve(GL.resolveDjob(1, null), SMOOTH_CELL, "smooth");
  assertResolve(GL.resolveDjob(2, null), ENGRAVE_CELL, "engrave");
  assertResolve(GL.resolveDjob(3, null), FORTIFY_CELL, "fortify");
  assertResolve(GL.resolveDjob(4, null), TRACK_ALL_CELL, "track"); // no residual mask -> all-dirs
  assertResolve(GL.resolveDjob(5, null), CHOP_CELL, "chop");
  assertResolve(GL.resolveDjob(6, null), GATHER_CELL, "gather");
});
section("resolveDjob: a track djob reuses a residual tile track mask when present", () => {
  // If the tile still carries a track adjacency mask (e.g. bits not fully cleared), use it.
  const r = GL.resolveDjob(4, { desig: { track: 1 } }); // mask 1 -> DESIG_TRACK_CELL[1] = [1,0]
  assert.equal(r.cat, "track");
  assert.equal(r.cell[0], 1); assert.equal(r.cell[1], 0);
});
section("resolveDjob: an unknown kind resolves to nothing (seeded-bad)", () => {
  assert.equal(GL.resolveDjob(0, null), null);
  assert.equal(GL.resolveDjob(99, null), null);
});

// =============================================================================================
// buildScene: a djob draws its glyph on a tile whose designation bits are CLEARED (t.desig null).
// =============================================================================================
section("buildScene: a smooth djob emits the smooth glyph on a bits-cleared tile (the B35 fix)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  // tile has NO desig (bits cleared on job pickup); djob array flags it at world (0,0).
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({})],
                 djobs: [{ x: 0, y: 0, z: 0, k: 1 }] });
  const inst = decode(b);
  const glyphCell = atlas.resolve("designations.png", SMOOTH_CELL[0], SMOOTH_CELL[1]);
  const wash = inst.find((i) => i.cell === GL.SOLID_CELL && i.r === 90 && i.g === 150 && i.b === 235);
  assert.ok(wash, "smooth category wash present for the djob tile");
  assert.ok(inst.some((i) => i.cell === glyphCell), "smooth glyph present for the bits-cleared djob tile");
});
section("buildScene: an engrave djob emits the engrave glyph on a bits-cleared tile", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 5, y: 7, z: 3 }, width: 3, height: 3,
                 tiles: Array.from({ length: 9 }, () => tile({})),
                 djobs: [{ x: 6, y: 8, z: 3, k: 2 }] }); // grid (1,1)
  const inst = decode(b);
  const glyphCell = atlas.resolve("designations.png", ENGRAVE_CELL[0], ENGRAVE_CELL[1]);
  const g = inst.find((i) => i.cell === glyphCell);
  assert.ok(g, "engrave glyph present");
  // R1 world-anchored instances retain world coordinates; the projection subtracts origin later.
  assert.equal(g.x, 6, "glyph retains its world x before projection");
  assert.equal(g.y, 8, "glyph retains its world y before projection");
});

// ---- test-the-test / seeded-bad rows -------------------------------------------------------
section("SEEDED-BAD: a djob OUTSIDE the render window emits NO glyph", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 2, height: 2,
                 tiles: Array.from({ length: 4 }, () => tile({})),
                 djobs: [{ x: 50, y: 50, z: 0, k: 1 }] }); // far off-window
  const inst = decode(b);
  const glyphCell = atlas.resolve("designations.png", SMOOTH_CELL[0], SMOOTH_CELL[1]);
  assert.ok(!inst.some((i) => i.cell === glyphCell), "off-window djob must not draw (window-clipped)");
});
section("SEEDED-BAD: no djob array -> a bits-cleared tile stays glyph-free (baseline unchanged)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({})] });
  const inst = decode(b);
  const glyphCell = atlas.resolve("designations.png", SMOOTH_CELL[0], SMOOTH_CELL[1]);
  assert.ok(!inst.some((i) => i.cell === glyphCell), "no djobs, no bits -> no glyph (isolates the djob path)");
});
section("PRECEDENCE: a tile that STILL has its smooth desig bit is not double-drawn by a djob", () => {
  // When the map bit is still present AND a djob covers the same tile, the desig-bit pass
  // already drew the glyph; the djob pass must skip it (no duplicate glyph instance).
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1,
                 tiles: [tile({ desig: { smooth: 1 } })],
                 djobs: [{ x: 0, y: 0, z: 0, k: 1 }] });
  const inst = decode(b);
  const glyphCell = atlas.resolve("designations.png", SMOOTH_CELL[0], SMOOTH_CELL[1]);
  const glyphs = inst.filter((i) => i.cell === glyphCell);
  assert.equal(glyphs.length, 1, "exactly ONE smooth glyph (bits path wins, djob path skips the already-drawn tile)");
});
section("MIXED: a bits-present tile and a bits-cleared djob tile both draw, in one scene", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 2, height: 1,
                 tiles: [tile({ desig: { smooth: 2 } }), tile({})], // (0,0) engrave bit, (1,0) cleared
                 djobs: [{ x: 1, y: 0, z: 0, k: 1 }] });            // djob smooth at (1,0)
  const inst = decode(b);
  const engraveCell = atlas.resolve("designations.png", ENGRAVE_CELL[0], ENGRAVE_CELL[1]);
  const smoothCell = atlas.resolve("designations.png", SMOOTH_CELL[0], SMOOTH_CELL[1]);
  const engrave = inst.find((i) => i.cell === engraveCell);
  const smooth = inst.find((i) => i.cell === smoothCell);
  assert.ok(engrave && engrave.x === 0, "bit-driven engrave glyph at (0,0)");
  assert.ok(smooth && smooth.x === 1, "djob-driven smooth glyph at the bits-cleared (1,0)");
});

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nALL B35 DJOBS CHECKS PASSED");
