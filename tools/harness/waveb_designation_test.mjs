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

// waveb_designation_test.mjs -- offline fixture cells for B35, B75, and B78.
// Run: node tools/harness/waveb_designation_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const worldStream = read("src", "world_stream.cpp");
const placement = read("src", "placement.cpp");
const controls = read("web", "js", "dwf-controls-placement.js");
const core = read("web", "js", "dwf-core.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + ": " + (err?.stack || err)); }
}
function cell(v) { return Array.from(v?.cell || []); }

// Load real renderer resolver functions without a browser/GPU.
const glbox = { self: null, performance: { now: () => 0 } };
glbox.self = glbox;
vm.createContext(glbox);
vm.runInContext(read("web", "js", "dwf-gl.js"), glbox, { filename: "dwf-gl.js" });
const GL = glbox.DwfGL;
assert.ok(GL?.resolveDjob, "GL djob resolver must export");

class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    if (key === "measureText") return () => ({ width: 8 });
    return () => {};
  }, set(target, key, value) { target[key] = value; return true; } }); }
}
const store = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = String(value); } };
globalThis.Image = class { set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });
vm.runInThisContext(read("web", "js", "dwf-tiles.js"), { filename: "dwf-tiles.js" });
const Tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });
assert.equal(typeof Tiles._resolveDjobForTest, "function", "canvas djob resolver hook must export");

const djobMatrix = [
  [5, [0, 8], "chop"],
  [6, [0, 9], "gather"],
];
for (const [kind, wantedCell, wantedCat] of djobMatrix) check(`B35 ${wantedCat} claimed-job glyph maps in both renderers`, () => {
  const gl = GL.resolveDjob(kind, null), c2d = Tiles._resolveDjobForTest(kind, null);
  assert.deepEqual(cell(gl), wantedCell); assert.deepEqual(cell(c2d), wantedCell);
  assert.equal(gl.cat, wantedCat); assert.equal(c2d.cat, wantedCat);
});
check("B35 seeded-bad unknown djob kind remains invisible", () => {
  assert.equal(GL.resolveDjob(99, null), null);
  assert.equal(Tiles._resolveDjobForTest(99, null), null);
});
check("B35 additive AUX producer tags both claimed plant job types", () => {
  assert.match(worldStream, /case df::job_type::FellTree:\s+kind = 5/);
  const gatherCase = worldStream.match(/case df::job_type::GatherPlants:[\s\S]*?kind = 6; break;/)?.[0] || "";
  assert.match(gatherCase, /Maps::getTileBlock\(job->pos\)/);
  assert.match(gatherCase, /tiletype_shape::SHRUB/);
  assert.match(worldStream, /djobs/);
});

check("B75 erase payload remains tool=clear and cancels claimed smooth jobs", () => {
  assert.match(controls, /erase:\s*"clear"/);
  assert.match(controls, /tool=\$\{encodeURIComponent\(currentTool\)\}/);
  const jobs = placement.match(/bool is_designation_job\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(jobs, /case df::job_type::SmoothWall:/);
  assert.match(jobs, /case df::job_type::SmoothFloor:/);
  assert.match(placement, /if \(kind == DesignationKind::Clear/);
});
check("B75 seeded-bad legacy remove-construction mapping is not used for erase", () => {
  assert.doesNotMatch(controls, /erase:\s*"remove-construction"/);
});

const boundsSource = core.match(/  function zonePreviewBounds\(preview\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(boundsSource, "zone preview bounds helper must be present");
const boundsBox = {};
vm.createContext(boundsBox);
vm.runInContext(boundsSource + "\nthis.bounds = zonePreviewBounds;", boundsBox, { filename: "dwf-core.js" });
check("B78 zone preview state normalizes live drag corners", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(boundsBox.bounds({ x1: 9, y1: 4, x2: 2, y2: 7 }))),
    { x1: 2, y1: 4, x2: 9, y2: 7 });
  assert.equal(boundsBox.bounds(null), null);
});
check("B78 pending selection is retained through Accept and drawn before zone-sheet gating", () => {
  assert.match(controls, /zonePaintPreview = \{ \.\.\.zonePaintBBox \};/);
  assert.match(controls, /zonePaintPreview = \{ x1: dragAnchor\.x, y1: dragAnchor\.y, x2: cur\.x, y2: cur\.y \};/);
  const overlay = core.match(/  function renderZoneOverlay\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  const drawAt = overlay.indexOf("drawZonePaintPreview(ctx)");
  const gateAt = overlay.indexOf("if (!zoneOverlayEnabled");
  assert.ok(drawAt >= 0 && gateAt > drawAt, "pending preview must draw independently of the existing-zone sheet");
});
check("B78 seeded-bad preview rejects non-numeric coordinates", () => {
  assert.equal(boundsBox.bounds({ x1: 1, y1: 2, x2: "no", y2: 4 }), null);
});

if (failed) {
  console.error(`\nFAIL ${failed} Wave B designation fixture cell(s)`);
  process.exit(1);
}
console.log("\nPASS Wave B designation fixture cells");
