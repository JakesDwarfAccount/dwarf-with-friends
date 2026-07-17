// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// G2 born-red gate: H1 machine beats rebuild/upload only the building segment.
// Run: node tools/harness/g2_machine_segment_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const buildingMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/building_map.json"), "utf8"));
let fakeNow = 0;
class FakeDate extends Date { static now() { return fakeNow; } }
const sandbox = { self: null, Date: FakeDate,
  performance: { now: () => Number(process.hrtime.bigint()) / 1e6 } };
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
  const ids = new Map(); let next = 1;
  return {
    resolve(sheet, col, row) { const key = `${sheet}|${col}|${row}`; if (!ids.has(key)) ids.set(key, next++); return ids.get(key); },
    pageCount: () => 1, getTexture: () => null,
  };
}
function fakeGL(uploads) {
  const noop = () => {};
  return {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, UNIFORM_BUFFER: 6, DYNAMIC_DRAW: 7, FLOAT: 8, UNSIGNED_SHORT: 9,
    UNSIGNED_BYTE: 10, INVALID_INDEX: 0xFFFFFFFF, COLOR_BUFFER_BIT: 0x4000,
    TEXTURE0: 0, TEXTURE_2D_ARRAY: 11, BLEND: 12, ONE: 1, ONE_MINUS_SRC_ALPHA: 13,
    TRIANGLES: 14, drawingBufferWidth: 64, drawingBufferHeight: 64,
    createShader: () => ({}), shaderSource: noop, compileShader: noop, getShaderParameter: () => true,
    getShaderInfoLog: () => "", deleteShader: noop, createProgram: () => ({}), attachShader: noop,
    linkProgram: noop, getProgramParameter: () => true, getProgramInfoLog: () => "", deleteProgram: noop,
    createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray: noop, bindBuffer: noop,
    enableVertexAttribArray: noop, vertexAttribPointer: noop, vertexAttribDivisor: noop,
    vertexAttribIPointer: noop, bufferData: noop, getUniformBlockIndex: () => 0xFFFFFFFF,
    uniformBlockBinding: noop, bindBufferBase: noop, getUniformLocation: () => ({}),
    bufferSubData(_target, offset, data) { uploads.push({ offset, bytes: data.byteLength }); },
    viewport: noop, clearColor: noop, clear: noop, useProgram: noop, activeTexture: noop,
    bindTexture: noop, uniform1i: noop, uniform2f: noop, uniform3f: noop, uniform1f: noop,
    enable: noop, blendFunc: noop, drawArraysInstanced: noop, deleteBuffer: noop,
    deleteVertexArray: noop, deleteProgram: noop,
  };
}

console.log("G2 -- machine beat updates only the building segment");
const uploads = [];
const renderer = GL.create(fakeGL(uploads), { atlas: atlas(), buildingMap });
const activeMachine = { type: "GearAssembly", bst: 1, x1: 32, y1: 48, x2: 32, y2: 48, z: 100 };
const view = {
  origin: { x: 32, y: 48, z: 100 }, width: 1, height: 1,
  tiles: [{ x: 32, y: 48, tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false }],
  buildings: [activeMachine], players: [],
};

fakeNow = 0;
renderer.buildScene(view);
renderer.render(0); // upload the initial full scene
uploads.length = 0;
const before = renderer.getStats();
const terrainBytes = (before.terrainInstances || 0) * GL.INSTANCE_BYTES;

fakeNow = 500;
renderer.render(500);
const after = renderer.getStats();
check("machine beat does not increment full sceneBuildCount",
  before.sceneBuildCount === 1 && after.sceneBuildCount === 1,
  `before=${before.sceneBuildCount} after=${after.sceneBuildCount}`);
check("machine beat increments buildingBuildCount only",
  before.buildingBuildCount === 0 && after.buildingBuildCount === 1,
  `before=${before.buildingBuildCount} after=${after.buildingBuildCount}`);
check("scene exposes non-empty terrain and building segments",
  before.terrainInstances > 0 && before.buildingInstances > 0,
  `terrain=${before.terrainInstances} buildings=${before.buildingInstances}`);
check("terrain segment size is stable across the beat",
  after.terrainInstances === before.terrainInstances,
  `before=${before.terrainInstances} after=${after.terrainInstances}`);
check("beat upload starts after the terrain prefix",
  uploads.length === 1 && uploads[0].offset === terrainBytes && uploads[0].bytes > 0,
  JSON.stringify(uploads));
check("beat upload is smaller than the full static scene",
  uploads.length === 1 && uploads[0].bytes < after.lastBuildInstances * GL.INSTANCE_BYTES,
  JSON.stringify(uploads));

console.log(failed ? `FAIL G2 (${failed} failures)` : "PASS G2 (0 failures)");
process.exit(failed ? 1 : 0);
