// wb15_anim_test.mjs -- WB-15 acceptance (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md,
// "GL animation clock: flows/fire/water shimmer/shore foam/machine frames/ANIMATED creatures").
// Loads the REAL web/js/dwf-adjacency.js + dwf-gl.js verbatim (vm.runInThisContext,
// same convention as gl_core_test.mjs) and exercises, with NO DOM/GL:
//   (1) the animFrames/animRate attr encoding (encodeAnimAttr) and its 4/3-bit round trip;
//   (2) the pure JS mirror of the shader's frame-select formula (animFrameIndexForTest) --
//       cycling, wraparound, per-tile phase decorrelation, freeze (frameCount<=1 or
//       globalEnabled=false always -> 0);
//   (3) tokenCell()'s generic "a token with >1 authored frames resolves through
//       atlas.resolveAnimated" behaviour (the mechanism that makes liquid shimmer/waves and
//       fire/campfire "just work" off /sprites/map.json's `frames` array with zero hardcoded
//       token names) -- and that a plain (0-1 frame) token is UNAFFECTED;
//   (4) resolveSprite()/buildScene() actually threading animAttr into the emitted instance's
//       attr bits, distinct from (and OR-able with) WB-10's seeDownAttr bits;
//   (5) shore-foam synthesis (emitShoreFoam): direction from water-adjacency, tokens from the
//       real graphics_fluids.txt UNDERWATER_EDGE_*/UNDERMAGMA_EDGE_* names, capped, and a no-op
//       on a brook/river/interior-pool tile with no land neighbor.
//
// Run: node tools/harness/wb15_anim_test.mjs

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
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}
const GL = sandbox.DwfGL;
const Adj = sandbox.DwfAdjacency;
assert.ok(GL, "DwfGL must export onto the sandbox global");

let failures = 0;
function section(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}

// ---- mock atlas: assign a stable positive cell id per (sheet,col,row); resolveAnimated bump-
// allocates a CONSECUTIVE run per (key) the first time it's asked, mirroring WB-8's real
// contract (frame i == base+i, forever, for the life of the "session") closely enough for this
// item's own tests (WB-8's gl_atlas_test.mjs already proves the real allocator's pixel-copy
// correctness in depth -- this mock only needs to prove dwf-gl.js CALLS it correctly).
function makeMockAtlas() {
  const ids = new Map();
  let next = 1;
  const animRuns = new Map();
  let animNext = 1000; // disjoint range from the plain resolve() ids, purely for readability
  return {
    resolve(sheet, col, row) {
      const k = sheet + "|" + col + "|" + row;
      if (!ids.has(k)) ids.set(k, next++);
      return ids.get(k);
    },
    resolveAnimated(key, sheet, frameCells) {
      let a = animRuns.get(key);
      if (!a) { a = { base: animNext, count: frameCells.length }; animNext += frameCells.length; animRuns.set(key, a); }
      return a.base;
    },
    _animRunsCalls: [],
  };
}

// =============================================================================================
// (1) encodeAnimAttr round trip
// =============================================================================================
section("encodeAnimAttr: frameCount<=1 -> 0 (no animation, no branch needed downstream)", () => {
  assert.equal(GL.encodeAnimAttr(0, 3), 0);
  assert.equal(GL.encodeAnimAttr(1, 3), 0);
});
section("encodeAnimAttr: frameCount 2..16 round-trips through the 4-bit animFrames field", () => {
  for (let fc = 2; fc <= 16; fc++) {
    const attr = GL.encodeAnimAttr(fc, 0);
    const decodedCount = (attr & GL.ATTR_ANIMFRAMES_MASK) + 1;
    assert.equal(decodedCount, fc, "frameCount " + fc + " round-trips");
  }
});
section("encodeAnimAttr: rateCode round-trips through the 3-bit animRate field, never collides with animFrames", () => {
  for (let rc = 0; rc <= 7; rc++) {
    const attr = GL.encodeAnimAttr(8, rc);
    const decodedRate = (attr >> GL.ATTR_ANIMRATE_SHIFT) & GL.ATTR_ANIMRATE_MASK;
    assert.equal(decodedRate, rc);
    const decodedCount = (attr & GL.ATTR_ANIMFRAMES_MASK) + 1;
    assert.equal(decodedCount, 8, "animFrames bits untouched by rateCode " + rc);
  }
});
section("encodeAnimAttr: never sets ADDITIVE(bit7)/MARKER(bit8) or WB-10's seeDown bits (9-12)", () => {
  const attr = GL.encodeAnimAttr(16, 7); // max of both fields
  assert.equal(attr & GL.ATTR_ADDITIVE, 0);
  assert.equal(attr & GL.ATTR_MARKER, 0);
  assert.equal((attr >> GL.ATTR_SEEDOWN_SHIFT) & GL.ATTR_SEEDOWN_MASK, 0);
  assert.ok(attr <= 0x7F, "animFrames|animRate never exceeds bits 0-6");
});

// =============================================================================================
// (2) animFrameIndexForTest -- pure JS mirror of the shader's frame-select math
// =============================================================================================
section("animFrameIndexForTest: frameCount<=1 always returns 0 (static sprite, no-op)", () => {
  assert.equal(GL.animFrameIndexForTest(12345, GL.encodeAnimAttr(1, 3), 7, 9, true), 0);
  assert.equal(GL.animFrameIndexForTest(12345, 0, 7, 9, true), 0);
});
section("animFrameIndexForTest: globalEnabled=false always returns 0 regardless of time/attr (kill-switch)", () => {
  const attr = GL.encodeAnimAttr(8, 2);
  assert.equal(GL.animFrameIndexForTest(999999, attr, 3, 4, false), 0);
});
section("animFrameIndexForTest: result always in [0, frameCount)", () => {
  const attr = GL.encodeAnimAttr(5, 1);
  for (let ms = 0; ms < 20000; ms += 137) {
    const idx = GL.animFrameIndexForTest(ms, attr, 11, 22, true);
    assert.ok(idx >= 0 && idx < 5, "idx " + idx + " in range at t=" + ms);
  }
});
section("animFrameIndexForTest: advances over time (not stuck at one frame)", () => {
  const attr = GL.encodeAnimAttr(8, 2); // 8 frames, rate code 2 -> 8 Hz
  const seen = new Set();
  for (let ms = 0; ms < 2000; ms += 50) seen.add(GL.animFrameIndexForTest(ms, attr, 1, 1, true));
  assert.ok(seen.size > 1, "more than one distinct frame index observed over 2s at 8 Hz");
});
section("animFrameIndexForTest: per-tile phase differs across (gx,gy) at the SAME instant (prevents lockstep)", () => {
  const attr = GL.encodeAnimAttr(16, 2);
  const t = 4000;
  const idxs = new Set();
  for (let gx = 0; gx < 12; gx++) for (let gy = 0; gy < 12; gy++) idxs.add(GL.animFrameIndexForTest(t, attr, gx, gy, true));
  assert.ok(idxs.size > 3, "a 12x12 tile block shows several distinct phases at one instant, not a single lockstep value (saw " + idxs.size + ")");
});
section("animFrameIndexForTest: t=0 is deterministic and repeatable (same inputs -> same output)", () => {
  const attr = GL.encodeAnimAttr(6, 1);
  const a = GL.animFrameIndexForTest(0, attr, 5, 5, true);
  const b = GL.animFrameIndexForTest(0, attr, 5, 5, true);
  assert.equal(a, b);
});

// =============================================================================================
// (3) tokenCell(): the generic frames-aware resolution (liquid shimmer / fire / campfire, no
// hardcoded token names -- purely data-driven off spriteMap[token].frames)
// =============================================================================================
const animSpriteMap = {
  BROOK_BED_E: { sheet: "flows.png", col: 0, row: 6, frames: Array.from({ length: 16 }, (_, i) => ({ col: i, row: 6 })) },
  CAMPFIRE_TOP: { sheet: "tiles.png", col: 0, row: 0, frames: [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }] },
  STONE_FLOOR_5: { sheet: "floors.png", col: 1, row: 4 }, // no frames -- ordinary static token
};
const animTokenMap = {
  BrookE: { token: "BROOK_BED_E", tint: null },
  StoneFloor5: { token: "STONE_FLOOR_5", tint: null },
};
const shadowCellMap = { wallShadow: {}, visionShadow: {}, rampShadowOnRamp: {} };

section("tokenCell: a token with >1 frames resolves through atlas.resolveAnimated, not the plain grid resolve", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: animSpriteMap, tokenMap: animTokenMap, shadowCellMap, adjacency: Adj });
  const cell = b._tokenCellForTest("BROOK_BED_E");
  const expected = atlas.resolveAnimated("BROOK_BED_E", "flows.png", animSpriteMap.BROOK_BED_E.frames);
  assert.equal(cell, expected, "resolves to resolveAnimated's base index");
  const plainWouldBe = atlas.resolve("flows.png", 0, 6);
  assert.notEqual(cell, plainWouldBe, "NOT the plain single-cell resolve (that would collapse the whole 16-frame run to frame 0's neighbor id space)");
});
section("tokenCell: a plain (0-1 frame) token is UNAFFECTED -- same resolve() path as before WB-15", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: animSpriteMap, tokenMap: animTokenMap, shadowCellMap, adjacency: Adj });
  const cell = b._tokenCellForTest("STONE_FLOOR_5");
  assert.equal(cell, atlas.resolve("floors.png", 1, 4));
});
section("animAttrForToken: 0 for a static token, encodeAnimAttr(frames.length, ...) for an animated one", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: animSpriteMap, tokenMap: animTokenMap, shadowCellMap, adjacency: Adj });
  assert.equal(b._animAttrForTokenForTest("STONE_FLOOR_5"), 0);
  const brookAttr = b._animAttrForTokenForTest("BROOK_BED_E");
  assert.equal((brookAttr & GL.ATTR_ANIMFRAMES_MASK) + 1, 16, "16-frame series encodes frameCount=16");
  const campfireAttr = b._animAttrForTokenForTest("CAMPFIRE_TOP");
  assert.equal((campfireAttr & GL.ATTR_ANIMFRAMES_MASK) + 1, 4, "4-frame series encodes frameCount=4");
  // fire reads faster than water shimmer (defaultAnimRateCodeForToken's documented heuristic)
  const brookHz = GL.ANIM_RATE_HZ[(brookAttr >> GL.ATTR_ANIMRATE_SHIFT) & GL.ATTR_ANIMRATE_MASK];
  const campfireHz = GL.ANIM_RATE_HZ[(campfireAttr >> GL.ATTR_ANIMRATE_SHIFT) & GL.ATTR_ANIMRATE_MASK];
  assert.ok(campfireHz > brookHz, "campfire's default rate is faster than the brook bed's");
});

// =============================================================================================
// (4) buildScene threads animAttr into the emitted instance, distinct from seeDownAttr
// =============================================================================================
function tile(o) {
  return Object.assign({ tt: 1, ttname: "", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
}
function decode(builder) {
  const buf = builder.buffer, n = builder.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf);
  const out = [];
  for (let k = 0; k < n; k++) out.push({ x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4], attr: u16[k * 8 + 5] });
  return out;
}
section("buildScene: an animated-token floor tile emits its sprite instance with the animAttr bits set", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: animSpriteMap, tokenMap: animTokenMap, shadowCellMap, adjacency: Adj });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ ttname: "BrookE" })] };
  b.buildScene(view);
  const inst = decode(b);
  const spriteCell = atlas.resolveAnimated("BROOK_BED_E", "flows.png", animSpriteMap.BROOK_BED_E.frames);
  const sprite = inst.find((i) => i.cell === spriteCell);
  assert.ok(sprite, "the animated sprite instance is present");
  assert.equal((sprite.attr & GL.ATTR_ANIMFRAMES_MASK) + 1, 16, "its attr carries the 16-frame count");
});
section("buildScene: a STATIC-token floor tile emits animFrames=0 (no animation bits) in its attr", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: animSpriteMap, tokenMap: animTokenMap, shadowCellMap, adjacency: Adj });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ ttname: "StoneFloor5" })] };
  b.buildScene(view);
  const inst = decode(b);
  const spriteCell = atlas.resolve("floors.png", 1, 4);
  const sprite = inst.find((i) => i.cell === spriteCell);
  assert.ok(sprite);
  assert.equal(sprite.attr & GL.ATTR_ANIMFRAMES_MASK, 0);
});

// =============================================================================================
// (5) shore foam synthesis
// =============================================================================================
const foamSpriteMap = {
  UNDERWATER_EDGE_N: { sheet: "liquids.png", col: 5, row: 0 },
  UNDERWATER_EDGE_S: { sheet: "liquids.png", col: 5, row: 2 },
  UNDERWATER_EDGE_W: { sheet: "liquids.png", col: 4, row: 1 },
  UNDERWATER_EDGE_E: { sheet: "liquids.png", col: 6, row: 1 },
  UNDERWATER_EDGE_NW: { sheet: "liquids.png", col: 4, row: 0 },
  UNDERWATER_EDGE_NE: { sheet: "liquids.png", col: 6, row: 0 },
  UNDERWATER_EDGE_SW: { sheet: "liquids.png", col: 4, row: 2 },
  UNDERWATER_EDGE_SE: { sheet: "liquids.png", col: 6, row: 2 },
  UNDERMAGMA_EDGE_N: { sheet: "liquids.png", col: 5, row: 3 },
};
function waterTile(o) { return Object.assign({ tt: 1, ttname: "", shape: "FLOOR", mat: "POOL", hidden: false, flow: 4, liquid: "water", outside: 1 }, o); }
function landTile(o) { return Object.assign({ tt: 1, ttname: "", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o); }

// emitShoreFoam is called directly (not through buildScene), so the builder's instance buffer
// needs capacity allocated first -- a throwaway 1x1 void-tile buildScene() call does that (same
// ensureCapacity() path a real buildScene would use) without emitting anything itself, leaving
// the write cursor at 0 for the direct call that follows.
function warmCapacity(b) {
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [{ tt: -1 }] });
}

section("emitShoreFoam: a water tile with land to the N gets the UNDERWATER_EDGE_N decal", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: foamSpriteMap, tokenMap: {}, shadowCellMap, adjacency: Adj });
  warmCapacity(b);
  // 1x2 column: land at y=0 (N of the water tile at y=1)
  const grid = [landTile(), waterTile()];
  const gw = 1, gh = 2;
  function lookupTile(x, y) { if (x < 0 || y < 0 || x >= gw || y >= gh) return null; return grid[y * gw + x]; }
  b._emitShoreFoamForTest(grid[1], 0, 1, lookupTile, 0);
  const inst = decode(b);
  const edgeCell = atlas.resolve("liquids.png", 5, 0); // UNDERWATER_EDGE_N
  assert.ok(inst.some((i) => i.cell === edgeCell), "UNDERWATER_EDGE_N decal emitted");
});

section("emitShoreFoam: an interior water tile (all 8 neighbors also water) emits nothing", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: foamSpriteMap, tokenMap: {}, shadowCellMap, adjacency: Adj });
  warmCapacity(b);
  const gw = 3, gh = 3;
  const grid = new Array(9).fill(null).map(() => waterTile());
  function lookupTile(x, y) { if (x < 0 || y < 0 || x >= gw || y >= gh) return null; return grid[y * gw + x]; }
  b._emitShoreFoamForTest(grid[4], 1, 1, lookupTile, 0); // center tile, all 8 neighbors water
  assert.equal(b.count, 0, "no foam decal on an interior liquid tile");
});

section("emitShoreFoam: a non-liquid tile is a no-op (flow<=0)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: foamSpriteMap, tokenMap: {}, shadowCellMap, adjacency: Adj });
  warmCapacity(b);
  const grid = [landTile(), landTile()];
  function lookupTile(x, y) { return grid[y] || null; }
  b._emitShoreFoamForTest(grid[1], 0, 1, lookupTile, 0);
  assert.equal(b.count, 0, "no foam on a dry tile");
});

section("emitShoreFoam: magma uses the UNDERMAGMA_EDGE_ prefix, not UNDERWATER_EDGE_", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: foamSpriteMap, tokenMap: {}, shadowCellMap, adjacency: Adj });
  warmCapacity(b);
  const magma = Object.assign({}, waterTile(), { mat: "MAGMA", liquid: "magma" });
  const grid = [landTile(), magma];
  function lookupTile(x, y) { if (x !== 0 || y < 0 || y > 1) return null; return grid[y]; }
  b._emitShoreFoamForTest(grid[1], 0, 1, lookupTile, 0);
  const inst = decode(b);
  const magmaEdgeCell = atlas.resolve("liquids.png", 5, 3); // UNDERMAGMA_EDGE_N
  assert.ok(inst.some((i) => i.cell === magmaEdgeCell), "UNDERMAGMA_EDGE_N decal emitted for magma");
});

// =============================================================================================
// (6) VERT_SRC/FRAG_SRC sanity: the uniforms/attr math this item requires actually exist in the
// shader source strings (a cheap guard against the wiring silently regressing without a
// browser/GPU -- the REAL behaviour is proven by tools/spikes/webgl/wb15-anim-bench.html).
// =============================================================================================
section("VERT_SRC declares u_timeMs and reads RenderParams.reserved0.w (the global kill-switch)", () => {
  assert.ok(GL.VERT_SRC.indexOf("uniform float u_timeMs;") >= 0);
  assert.ok(GL.VERT_SRC.indexOf("u_rp.reserved0.w") >= 0);
  assert.ok(GL.VERT_SRC.indexOf("frameCount") >= 0);
});
section("defaultRenderParams: reserved0.w defaults to 1 (animation ON by default)", () => {
  const rp = GL.defaultRenderParams();
  assert.equal(Array.from(rp.reserved0)[3], 1);
});

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nAll wb15_anim_test sections passed.");
