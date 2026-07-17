// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function plan(points, width, height, mapW, mapH) {
  const unique = [...new Set(points.map(p => p.join(",")))].map(s => s.split(",").map(Number));
  unique.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  const covered = new Array(unique.length).fill(false);
  const out = [];
  const clamp = (v, size, max) => Math.max(0, Math.min(v, Math.max(0, max - size)));
  for (let i = 0; i < unique.length; i++) {
    if (covered[i]) continue;
    const [x, y, z] = unique[i];
    const box = { x: clamp(x - Math.floor(width / 2), width, mapW),
                  y: clamp(y - Math.floor(height / 2), height, mapH), z };
    for (let j = i; j < unique.length; j++) {
      const [px, py, pz] = unique[j];
      if (pz === z && px >= box.x && px < box.x + width && py >= box.y && py < box.y + height)
        covered[j] = true;
    }
    out.push(box);
  }
  return out;
}

function runTick(state, { interacting = false, render = true } = {}) {
  if (!state.steps.length || interacting) return { steps: 0, camera: state.camera };
  const saved = { ...state.camera };
  const target = state.steps[0];
  state.camera = { ...target };
  if (render) state.steps.shift();
  state.camera = saved;
  return { steps: 1, camera: state.camera };
}

function assertSafeTick(state, options) {
  const before = { ...state.camera };
  const result = runTick(state, options);
  assert.ok(result.steps <= 1, "at most one viewport step per tick");
  assert.deepEqual(state.camera, before, "host camera restored exactly");
}

console.log("# box planner");
const boxes = plan([[40, 30, 5], [55, 38, 5], [40, 30, 5], [260, 30, 5], [40, 30, 6]],
                   80, 50, 400, 300);
assert.equal(boxes.length, 3, "clusters on one z share one viewport; a distant/z-separated point does not");
for (const [x, y, z] of [[40, 30, 5], [55, 38, 5], [260, 30, 5], [40, 30, 6]]) {
  assert.ok(boxes.some(b => b.z === z && x >= b.x && x < b.x + 80 && y >= b.y && y < b.y + 50),
            "every candidate is covered");
}
assert.deepEqual(plan([], 80, 50, 400, 300), [], "all-baked input emits zero boxes");

console.log("# scheduler");
const state = { camera: { x: 17, y: 23, z: 4 },
                steps: [{ x: 40, y: 30, z: 5 }, { x: 260, y: 30, z: 5 }] };
assertSafeTick(state);
assert.equal(state.steps.length, 1, "one paced step is consumed");
assertSafeTick(state, { interacting: true });
assert.equal(state.steps.length, 1, "host interaction defers all remaining steps");

console.log("# test the test");
const unpaced = { camera: { x: 17, y: 23, z: 4 }, steps: [{ x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }] };
const brokenTick = s => { const saved = { ...s.camera }; while (s.steps.length) s.steps.shift(); s.camera = saved; return 2; };
assert.throws(() => assert.ok(brokenTick(unpaced) <= 1, "at most one viewport step per tick"),
              "seeded unpaced sweep is detected");
const noRestore = { camera: { x: 17, y: 23, z: 4 }, steps: [{ x: 40, y: 30, z: 5 }] };
assert.throws(() => {
  const before = { ...noRestore.camera };
  noRestore.camera = noRestore.steps.shift();
  assert.deepEqual(noRestore.camera, before, "host camera restored exactly");
}, "seeded camera leak is detected");

console.log("# implementation contract");
const sweep = readFileSync(new URL("../../src/bake_sweep.cpp", import.meta.url), "utf8");
const capture = readFileSync(new URL("../../src/sdl_capture.cpp", import.meta.url), "utf8");
assert.match(sweep, /kMaxStepsPerTick = 1/, "implementation caps a tick at one step");
assert.match(sweep, /bake_sweep_render_step/, "scheduler delegates to guarded render primitive");
assert.match(capture, /getViewscreenByType<df::viewscreen_dwarfmodest>/, "render primitive retains live-fort gate");
assert.match(capture, /note_host_camera\(saved\)/, "render primitive warms saved host camera");
assert.match(capture, /bake_sweep_render_step/, "guarded bake render primitive is present");

console.log("PASS bake sweep planner and pacing/camera-restore fixture");
