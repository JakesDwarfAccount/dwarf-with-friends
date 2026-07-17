// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// R2 born-red fixture: BLOCK_SET dirt patches one chunk plus its neighbor ring without a
// full scene build. Clean CPU segments retain identity. Run:
// node tools/harness/r2_chunk_patch_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sandbox = { self: null, performance: { now: () => Number(process.hrtime.bigint()) / 1e6 } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8"), sandbox,
  { filename: "dwf-gl.js" });
const GL = sandbox.DwfGL;

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   - ${name}`);
  else { failures++; console.log(`  FAIL - ${name}${detail ? ` (${detail})` : ""}`); }
}
function atlas() {
  const ids = new Map(); let next = 1;
  return {
    resolve(sheet, col, row) {
      const key = `${sheet}|${col}|${row}`;
      if (!ids.has(key)) ids.set(key, next++);
      return ids.get(key);
    },
    pageCount: () => 1, getTexture: () => null,
  };
}
function fakeGL() {
  const noop = () => {};
  return {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, UNIFORM_BUFFER: 6, DYNAMIC_DRAW: 7, FLOAT: 8, UNSIGNED_SHORT: 9,
    UNSIGNED_BYTE: 10, INVALID_INDEX: 0xFFFFFFFF, COLOR_BUFFER_BIT: 0x4000,
    TEXTURE0: 0, TEXTURE_2D_ARRAY: 11, BLEND: 12, ONE: 1, ONE_MINUS_SRC_ALPHA: 13,
    TRIANGLES: 14, drawingBufferWidth: 640, drawingBufferHeight: 480,
    createShader: () => ({}), shaderSource: noop, compileShader: noop, getShaderParameter: () => true,
    getShaderInfoLog: () => "", deleteShader: noop, createProgram: () => ({}), attachShader: noop,
    linkProgram: noop, getProgramParameter: () => true, getProgramInfoLog: () => "", deleteProgram: noop,
    createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray: noop, bindBuffer: noop,
    enableVertexAttribArray: noop, vertexAttribPointer: noop, vertexAttribDivisor: noop,
    vertexAttribIPointer: noop, bufferData: noop, getUniformBlockIndex: () => 0xFFFFFFFF,
    uniformBlockBinding: noop, bindBufferBase: noop, getUniformLocation: () => ({}), bufferSubData: noop,
    viewport: noop, clearColor: noop, clear: noop, useProgram: noop, activeTexture: noop,
    bindTexture: noop, uniform1i: noop, uniform2f: noop, uniform3f: noop, uniform1f: noop,
    enable: noop, blendFunc: noop, drawArraysInstanced: noop, deleteBuffer: noop,
    deleteVertexArray: noop, deleteProgram: noop,
  };
}

let designated = false;
const versions = new Map();
const dirtyCallbacks = [];
const chunkKey = (bx, by) => bx * 4096 + by;
function tile(wx, wy) {
  const t = { x: wx, y: wy, tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE",
    hidden: false, outside: 1, flow: 0, liquid: "none" };
  if (wx === 32 && wy === 32) {
    t.ttname = "StoneWall"; t.shape = "WALL";
    if (designated) t.desig = { dig: "Default", marker: 0 };
  }
  return t;
}
const cacheReader = {
  windowView(ox, oy, z, width, height) {
    const tiles = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) tiles.push(tile(ox + x, oy + y));
    let version = 0;
    for (let by = Math.floor(oy / 16); by <= Math.floor((oy + height - 1) / 16); by++) {
      for (let bx = Math.floor(ox / 16); bx <= Math.floor((ox + width - 1) / 16); bx++) {
        version = Math.max(version, versions.get(`${z}:${chunkKey(bx, by)}`) || 1);
      }
    }
    return { origin: { x: ox, y: oy, z }, width, height, tiles, version };
  },
  getChunk(z, key) {
    if (z !== 100) return null;
    return { ver: versions.get(`${z}:${key}`) || 1 };
  },
  onDirty(cb) {
    dirtyCallbacks.push(cb);
    return () => { const i = dirtyCallbacks.indexOf(cb); if (i >= 0) dirtyCallbacks.splice(i, 1); };
  },
};
function fireDirty(ver) {
  const key = chunkKey(2, 2);
  versions.set(`100:${key}`, ver);
  for (const cb of dirtyCallbacks.slice()) cb(100, [key], {});
}
function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function isPatchOnly(before, after) {
  return after.sceneBuildCount === before.sceneBuildCount &&
    after.chunkPatchCount === before.chunkPatchCount + after.lastPatchChunks && after.lastPatchChunks === 9;
}

console.log("R2 -- per-chunk patch-don't-rebuild");
const sharedAtlas = atlas();
const renderer = GL.create(fakeGL(), { atlas: sharedAtlas, cacheReader, freezeAnim: true });
renderer.setCamera({ cell: 8 });
const initial = cacheReader.windowView(32, 32, 100, 32, 32);
initial.contentVersion = 1; initial.buildings = []; initial.players = []; initial.djobs = [];
renderer.buildScene(initial);

const builder = renderer._builder;
const dirtyBefore = builder._getTerrainSegmentForTest(2, 2, 100);
const cleanBefore = builder._getTerrainSegmentForTest(4, 4, 100);
const ringBefore = builder._getTerrainSegmentForTest(1, 1, 100);
const statsBefore = renderer.getStats();
check("initial padded 32x32 view is retained as sixteen terrain chunks",
  statsBefore.sceneBuildCount === 1 && statsBefore.terrainChunkCount === 16,
  JSON.stringify(statsBefore));

designated = true;
fireDirty(2);
const statsAfter = renderer.getStats();
const dirtyAfter = builder._getTerrainSegmentForTest(2, 2, 100);
const cleanAfter = builder._getTerrainSegmentForTest(4, 4, 100);
const ringAfter = builder._getTerrainSegmentForTest(1, 1, 100);
console.log(`  patch stats: chunks=${statsAfter.lastPatchChunks} last=${statsAfter.lastPatchMs.toFixed(3)}ms p95=${statsAfter.patchP95Ms.toFixed(3)}ms batch=${statsAfter.lastPatchBatchMs.toFixed(3)}ms`);
check("dirty BLOCK_SET patches without incrementing full sceneBuildCount", isPatchOnly(statsBefore, statsAfter),
  `before=${JSON.stringify(statsBefore)} after=${JSON.stringify(statsAfter)}`);
check("dirty chunk CPU segment is replaced and contains the designation change",
  dirtyAfter !== dirtyBefore && !sameBytes(dirtyAfter.bytes, dirtyBefore.bytes));
check("8-neighbor dependency ring is rebuilt", ringAfter !== ringBefore && ringAfter.builds === ringBefore.builds + 1);
check("clean chunk outside the dependency ring is untouched (same object and byte array)",
  cleanAfter === cleanBefore && cleanAfter.bytes === cleanBefore.bytes);
check("patch latency stats are exposed for the live <=2ms G3 gate",
  Number.isFinite(statsAfter.lastPatchMs) && Number.isFinite(statsAfter.patchP95Ms) && statsAfter.chunkBuildCount >= 9);

const oracle = GL.createSceneBuilder({ atlas: sharedAtlas });
const oracleView = cacheReader.windowView(16, 16, 100, 64, 64);
oracleView.buildings = []; oracleView.players = []; oracleView.djobs = []; oracleView.freezeAnim = true;
oracle.buildScene(oracleView);
const patchedStatic = new Uint8Array(builder.buffer, 0, builder.staticCount * GL.INSTANCE_BYTES);
const rebuiltStatic = new Uint8Array(oracle.buffer, 0, oracle.staticCount * GL.INSTANCE_BYTES);
check("patched static bytes are identical to a fresh full-build oracle",
  builder.staticCount === oracle.staticCount && sameBytes(patchedStatic, rebuiltStatic));

designated = false;
fireDirty(3);
const cleared = builder._getTerrainSegmentForTest(2, 2, 100);
check("B29 both directions: clearing dirt patches back to the original terrain bytes",
  sameBytes(cleared.bytes, dirtyBefore.bytes));

const beforeZoomBuilds = renderer.getStats().sceneBuildCount;
renderer.setCamera({ cell: 16 });
const zoomView = cacheReader.windowView(32, 32, 100, 32, 32);
zoomView.contentVersion = 3; zoomView.buildings = []; zoomView.players = []; zoomView.djobs = [];
renderer.buildScene(zoomView);
check("zoom is uniform-only under R2", renderer.getStats().sceneBuildCount === beforeZoomBuilds);

renderer.setMaps({ spriteMap: null });
renderer.buildScene(zoomView);
check("rare map changes remain a full scene-build boundary",
  renderer.getStats().sceneBuildCount === beforeZoomBuilds + 1);

const seededBad = { ...statsAfter, sceneBuildCount: statsAfter.sceneBuildCount + 1,
  chunkPatchCount: statsAfter.chunkPatchCount, lastPatchChunks: 16 };
check("TEST-THE-TEST: seeded full-rebuild regression is rejected by the patch-only oracle",
  !isPatchOnly(statsAfter, seededBad));

renderer._setChunkPatchingEnabledForTest(false);
const suppressedBefore = builder._getTerrainSegmentForTest(2, 2, 100);
designated = true;
fireDirty(4);
const suppressedAfter = builder._getTerrainSegmentForTest(2, 2, 100);
check("TEST-THE-TEST: suppressing onDirty leaves the designation undelivered",
  suppressedAfter === suppressedBefore && renderer.getStats().chunkPatchCount === 18);

renderer.dispose();
console.log(failures ? `FAIL R2 (${failures} failures)` : "PASS R2 (0 failures)");
process.exit(failures ? 1 : 0);
