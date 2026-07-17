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

// B291 offline placement truth: local rubber-band state, click/click + held-drag convergence,
// cancellation, and the rectangle-placement audit. Before B291, the two acceptance predicates
// at the bottom both fail: building placement was excluded by instantDrag(), and pointerup called
// placeBuildDrag immediately with no persistent corner.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const controls = read("web", "js", "dwf-controls-placement.js");
const builds = read("web", "js", "dwf-build-info-panels.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + ": " + (err?.stack || err)); }
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} closes`);
}

const boundsBox = {};
vm.createContext(boundsBox);
vm.runInContext(functionSource(builds, "buildPlacementBounds") +
  "\nthis.bounds = buildPlacementBounds;", boundsBox);

check("farm/build rectangle corners normalize identically in either gesture direction", () => {
  const a = { x: 9, y: 7, w: 80, h: 50 };
  const b = { x: 3, y: 2, w: 80, h: 50 };
  const wanted = { x1: 3, y1: 2, x2: 9, y2: 7, w: 80, h: 50 };
  assert.deepEqual(JSON.parse(JSON.stringify(boundsBox.bounds(a, b))), wanted);
  assert.deepEqual(JSON.parse(JSON.stringify(boundsBox.bounds(b, a))), wanted);
});

check("held-drag and click/click converge on the one tile-corner commit path", () => {
  assert.match(controls, /placeBuildCells\(anchor, cur\);/,
    "second click commits the persistent corner through placeBuildCells");
  assert.match(controls, /placeBuildCells\(releasedDragAnchor, cur\);/,
    "held-drag commits its pressed corner through the same placeBuildCells");
  assert.match(builds, /async function placeBuildDrag[\s\S]*?await placeBuildCells\(a, b\);/,
    "legacy callers are also only a wrapper around the shared tile commit");
});

check("farm and every other area:true building get live dragPreview from press through hover", () => {
  assert.match(controls, /function areaBuildSelected\(\) \{ return !!bipSelBuild\(\)\?\.area; \}/);
  assert.match(controls, /function localDragPreviewActive\(\)[\s\S]*?areaBuildSelected\(\)/);
  assert.match(controls, /const previewAnchor = areaBuildAnchor \|\| dragAnchor;\s*setDragPreview\(previewAnchor, dragAnchor\);/);
  assert.match(controls, /if \(areaBuildAnchor && areaBuildSelected\(\)\)[\s\S]*?setDragPreview\(areaBuildAnchor, cur\);/,
    "button-up pointermove rubber-bands the anchored preview");
});

check("a short first click anchors instead of submitting; a second click submits", () => {
  assert.match(controls, /else if \(clickDistance < 8\) \{\s*areaBuildAnchor = releasedDragAnchor;\s*setDragPreview\(areaBuildAnchor, cur\);/);
  const secondClickAt = controls.indexOf("if (areaBuildAnchor) {", controls.indexOf('view.addEventListener("pointerup"'));
  const commitAt = controls.indexOf("placeBuildCells(anchor, cur);", secondClickAt);
  assert.ok(secondClickAt >= 0 && commitAt > secondClickAt);
});

check("Escape, right-click, tool change, and pointercancel clear the anchored preview", () => {
  assert.match(controls, /event\.button === 2 && cancelAreaBuildAnchor\(\)/);
  assert.match(controls, /else if \(areaBuildAnchor\) \{[\s\S]*?cancelAreaBuildAnchor\(\);[\s\S]*?handledEscape = true;/);
  assert.match(controls, /stairRangePreview = stairRangeStart[^\n]*\n\s*areaBuildAnchor = null;\s*\n\s*if \(dragPreview\)/,
    "pointercancel clears both anchor and overlay");
  assert.match(builds, /function clearBuildPlacement[\s\S]*?DFCancelBuildCornerAnchor\(\)/);
  assert.match(builds, /function selectBuildItem[\s\S]*?DFCancelBuildCornerAnchor\(\)/);
});

check("rectangle audit: zones, stockpiles/repaint/erase, and burrows always use dragPreview", () => {
  const rect = functionSource(controls, "rectanglePaintSelected");
  for (const state of ["stockPreset", "stockRepaintId", "stockEraseArmed", "zonePreset",
    "zoneRepaintId", "zoneEraseArmed", "burrowPaintId"])
    assert.ok(rect.includes(state), `${state} is in the local rectangle-preview family`);
  assert.match(controls, /else if \(localDragPreviewActive\(\)\)[\s\S]*?setDragPreview\(previewAnchor, cur\);/);
});

check("designation two-click and instant-mode/z-range machinery stay on their existing paths", () => {
  assert.match(controls, /function instantDrag\(\) \{ return instantDesignate && !bipSelBuild\(\); \}/);
  assert.match(controls, /if \(twoClickArmed\(\)\) updateTwoClickRubberBand/);
  assert.match(controls, /if \(event\.shiftKey && designationRangeWheel\(event\)\) return;/);
});

function hasFarmPreview(source) {
  return /\bareaBuildSelected\b/.test(source) && /setDragPreview\(areaBuildAnchor, cur\)/.test(source);
}
function hasFarmTwoClick(source) {
  return /clickDistance < 8/.test(source) && /placeBuildCells\(anchor, cur\)/.test(source);
}
check("test-the-test: the pre-B291 no-preview shape is rejected", () => {
  assert.equal(hasFarmPreview(controls.replaceAll("areaBuildSelected", "removedAreaBuildSelected")), false);
});
check("test-the-test: the pre-B291 immediate pointerup shape is rejected", () => {
  // replaceAll: the click-vs-drag threshold appears at BOTH pointerup sites; a single replace
  // left the mutant alive at the second site and failed this seeded-bad check post-merge.
  assert.equal(hasFarmTwoClick(controls.replaceAll("clickDistance < 8", "false")), false);
});

if (failed) process.exit(1);
console.log("\nPASS B291 farm placement preview, two-click parity, and rectangle audit");
