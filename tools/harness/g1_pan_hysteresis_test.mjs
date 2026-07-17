// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// G1 born-red gate: R1 world-anchored instances + chunk-margin pan hysteresis.
// Run: node tools/harness/g1_pan_hysteresis_test.mjs

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

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}${detail ? ` (${detail})` : ""}`); }
}

function atlas() {
  return { resolve: () => 1, pageCount: () => 1, getTexture: () => null };
}
function fakeGL() {
  const noop = () => {};
  return {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, UNIFORM_BUFFER: 6, DYNAMIC_DRAW: 7, FLOAT: 8, UNSIGNED_SHORT: 9,
    UNSIGNED_BYTE: 10, INVALID_INDEX: 0xFFFFFFFF, COLOR_BUFFER_BIT: 0x4000,
    TEXTURE0: 0, TEXTURE_2D_ARRAY: 11, BLEND: 12, ONE: 1, ONE_MINUS_SRC_ALPHA: 13,
    TRIANGLES: 14, drawingBufferWidth: 320, drawingBufferHeight: 200,
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
function tile(x, y) {
  return { x, y, tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE",
    hidden: false, outside: 1, flow: 0, liquid: "none" };
}
function view(ox, oy, version = 7) {
  const width = 4, height = 4, tiles = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) tiles.push(tile(ox + x, oy + y));
  return { origin: { x: ox, y: oy, z: 100 }, width, height, tiles,
    contentVersion: version, buildings: [], players: [], freezeAnim: true };
}

console.log("G1 -- world coordinates and chunk-margin pan hysteresis");

const pure = GL.createSceneBuilder({ atlas: atlas() });
pure.buildScene(view(40, 50));
const pureF32 = new Float32Array(pure.buffer);
check("scene instances are world-anchored", pureF32[0] === 40 && pureF32[1] === 50,
  `first=(${pureF32[0]},${pureF32[1]}) expected=(40,50)`);

const windowCalls = [];
let cacheVersion = 7;
const dirtyCallbacks = [];
const cacheReader = {
  windowView(ox, oy, z, width, height) {
    windowCalls.push({ ox, oy, z, width, height });
    const tiles = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) tiles.push(tile(ox + x, oy + y));
    return { origin: { x: ox, y: oy, z }, width, height, tiles, version: cacheVersion };
  },
  getChunk() { return { ver: cacheVersion }; },
  onDirty(cb) { dirtyCallbacks.push(cb); return () => {}; },
};
const renderer = GL.create(fakeGL(), { atlas: atlas(), cacheReader, freezeAnim: true });
renderer.setCamera({ cell: 8 });
renderer.buildScene(view(40, 50));
let stats = renderer.getStats();
check("first scene uses chunk-aligned + one-chunk-margin build rect",
  windowCalls.length === 1 && windowCalls[0].ox === 16 && windowCalls[0].oy === 32 &&
    windowCalls[0].width === 48 && windowCalls[0].height === 48,
  JSON.stringify(windowCalls[0] || null));
check("stats expose the padded build rect",
  stats.buildRect && stats.buildRect.x0 === 16 && stats.buildRect.y0 === 32 &&
    stats.buildRect.x1 === 64 && stats.buildRect.y1 === 80,
  JSON.stringify(stats.buildRect || null));

renderer.buildScene(view(41, 51));
stats = renderer.getStats();
check("pan inside the padded rect does not rebuild", stats.sceneBuildCount === 1,
  `sceneBuildCount=${stats.sceneBuildCount}`);
check("pan updates world-space scroll uniforms", stats.scrollX === 41 && stats.scrollY === 51,
  `scroll=(${stats.scrollX},${stats.scrollY})`);

renderer.buildScene(view(61, 51)); // viewport x1=65 leaves the first rect's x1=64
stats = renderer.getStats();
check("R2 builds only entering chunks when leaving the padded rect", stats.sceneBuildCount === 1,
  `sceneBuildCount=${stats.sceneBuildCount}`);
check("crossing rebuild mints the next chunk-aligned rect",
  stats.buildRect && stats.buildRect.x0 === 32 && stats.buildRect.x1 === 96,
  JSON.stringify(stats.buildRect || null));

cacheVersion = 8;
for (const cb of dirtyCallbacks) cb(100, [3 * 4096 + 3], {});
renderer.buildScene(view(62, 51, 8));
stats = renderer.getStats();
check("a real cache version bump patches inside the rect without a full rebuild (B29 direction)",
  stats.sceneBuildCount === 1 && stats.chunkPatchCount === stats.lastPatchChunks && stats.lastPatchChunks > 0,
  `sceneBuildCount=${stats.sceneBuildCount} chunkPatchCount=${stats.chunkPatchCount}`);

console.log(failed ? `FAIL G1 (${failed} failures)` : "PASS G1 (0 failures)");
process.exit(failed ? 1 : 0);
