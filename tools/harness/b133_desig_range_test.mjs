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

// B133: a designation drag may cross cache-unloaded chunks. Offline only: real client helpers,
// real REQ_BLOCKS queue/cache ingest, no browser and no Dwarf Fortress.
// Run: node tools/harness/b133_desig_range_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const controls = read("web/js/dwf-controls-placement.js");
const core = read("web/js/dwf-core.js");
const tiles = read("web/js/dwf-tiles.js");
const placement = read("src/placement.cpp");

function functionSource(source, name) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`));
  assert.ok(match, `${name} must exist in the real client source`);
  return match[0];
}

console.log("# full rectangle POST + targeted refill");
const fetches = [];
const refills = [];
const dragBox = {
  currentTool: "dig",
  player: "host",
  window: { DwfCache: { requestBlockRect(...args) { refills.push(args); } } },
  imagePixelClamped(x) {
    return x === 10 ? { x: 35, y: 22, w: 48, h: 30 } : { x: 4, y: 6, w: 48, h: 30 };
  },
  renderedImageRect() { return { ox: 160, oy: 96, oz: 20 }; },
  digOptsQuery() { return ""; },
  warnIfPendingEndpoint() {},
  async fetch(url, options) { fetches.push({ url, options }); return { ok: true }; },
};
vm.createContext(dragBox);
vm.runInContext([
  functionSource(controls, "designationDragRect"),
  functionSource(controls, "requestDesignationWorldBlocks"),
  functionSource(controls, "requestDesignationBlocks"),
  functionSource(controls, "designateDrag"),
  "this.runDrag = designateDrag; this.makeRect = designationDragRect;",
].join("\n"), dragBox, { filename: "dwf-controls-placement.js:B133" });

await dragBox.runDrag(10, 20, 30, 40);
assert.equal(fetches.length, 1);
const payload = new URL(fetches[0].url, "http://dwf.test").searchParams;
assert.deepEqual(
  Object.fromEntries(["px", "py", "px2", "py2", "w", "h"].map(k => [k, Number(payload.get(k))])),
  { px: 4, py: 6, px2: 35, py2: 22, w: 48, h: 30 },
  "POST must retain the full user rectangle beyond the seeded loaded x<=15 extent",
);
assert.deepEqual(refills, [[164, 102, 195, 118, 20]],
  "successful POST must request exactly the world rectangle it changed");

console.log("# black/cache-empty canvas cells remain valid input coordinates");
const hitBox = {
  canvas: { width: 480, getBoundingClientRect() { return { left: 0, top: 0, width: 480 }; } },
  // Geometry covers the camera window; deliberately provide no tile/cache records at all.
  geom: { cell: 10, gw: 48, gh: 30 },
};
vm.createContext(hitBox);
vm.runInContext(functionSource(tiles, "screenToGrid") + "\nthis.hit = screenToGrid;", hitBox,
  { filename: "dwf-tiles.js:B133-input" });
assert.deepEqual(JSON.parse(JSON.stringify(hitBox.hit(355, 225, true))),
  { gx: 35, gy: 22, gw: 48, gh: 30 },
  "hit testing must use viewport geometry, not whether gx=35 has a loaded tile");

console.log("# preview cells remain visible beyond loaded chunks");
const previewBox = {};
vm.createContext(previewBox);
vm.runInContext(functionSource(core, "dragPreviewBounds") + "\nthis.bounds = dragPreviewBounds;",
  previewBox, { filename: "dwf-core.js:B133" });
const preview = JSON.parse(JSON.stringify(previewBox.bounds({ ax: 4, ay: 6, bx: 35, by: 22 })));
assert.deepEqual(preview, { gx0: 4, gy0: 6, gx1: 36, gy1: 23 });
const previewCells = Array.from({ length: preview.gx1 - preview.gx0 }, (_, i) => preview.gx0 + i);
assert.ok(previewCells.includes(35) && previewCells.filter(x => x > 15).length === 20,
  "preview must include every cell past the seeded loaded extent");

function requireFullRect(rect) {
  assert.deepEqual(JSON.parse(JSON.stringify(rect)),
    { x1: 4, y1: 6, x2: 35, y2: 22, w: 48, h: 30 });
}
requireFullRect(dragBox.makeRect(
  { x: 35, y: 22, w: 48, h: 30 }, { x: 4, y: 6, w: 48, h: 30 }));
const seededClamped = { x1: 4, y1: 6, x2: Math.min(35, 15), y2: 22, w: 48, h: 30 };
assert.throws(() => requireFullRect(seededClamped),
  "seeded-bad loaded-extent clamp must fail the full-rectangle oracle");

console.log("# first-release mining volume POST + cross-z unloaded-block refill");
const volumeFetches = [];
const volumeRefills = [];
const volumeBox = {
  player: "host",
  selectedDesignation: "dig",
  stairRangeStart: null,
  stairRangePreview: {},
  digPriority: 4,
  markerMode: false,
  warmDampMode: false,
  digMineMode: 0,
  window: { DwfCache: { requestBlockRect(...args) { volumeRefills.push(args); } } },
  backendToolFor(tool) { return tool; },
  renderedImageRect() { return { ox: 160, oy: 96, oz: 20, gw: 48, gh: 30 }; },
  whenCameraMovesFlushed() { return Promise.resolve(); },
  renderZoneOverlay() {},
  updateDesignationButtons() {},
  warnIfPendingEndpoint() {},
  async fetch(url, options) { volumeFetches.push({ url, options }); return { ok: true }; },
};
volumeBox.window.window = volumeBox.window;
vm.createContext(volumeBox);
vm.runInContext([
  functionSource(controls, "requestDesignationWorldBlocks"),
  functionSource(controls, "submitDesignationRange"),
  "this.submit = submitDesignationRange;",
].join("\n"), volumeBox, { filename: "dwf-controls-placement.js:B133-volume" });
await volumeBox.submit({ x1: 164, y1: 102, x2: 195, y2: 118, z: 23, tool: "dig" }, 20);
assert.equal(volumeFetches.length, 1, "one release must issue one designation POST");
const volumePayload = new URL(volumeFetches[0].url, "http://dwf.test").searchParams;
assert.deepEqual(
  Object.fromEntries(["px", "py", "px2", "py2", "w", "h", "zlevels"]
    .map(k => [k, Number(volumePayload.get(k))])),
  { px: 4, py: 6, px2: 35, py2: 22, w: 48, h: 30, zlevels: 3 },
  "the unclamped world rectangle and signed z span must share one POST");
assert.deepEqual(volumeRefills, [20, 21, 22, 23].map(z => [164, 102, 195, 118, z]),
  "every touched unloaded chunk plane must be requested after the write");

// Edited 2026-07-11 (B193, supersedes this cell's B133-era contract): The owner verified in native DF
// that rectangle designations are TWO-CLICK ("click drag is not a native thing"), so dig/ramp
// now DO route through the two-click handler -- the exact reroute the old test-the-test
// rejected. The "two-click limbo" the old cell guarded against (a first release that commits
// nothing and gives no way forward) is prevented differently now: the first click arms a
// rubber-banded preview and the SECOND click always commits for non-stair tools, including the
// common same-z rectangle -- asserted behaviorally below with the real handler source.
const pointerUp = controls.match(/view\.addEventListener\("pointerup"[\s\S]*?\n  \}\);/)?.[0] || "";
assert.match(pointerUp,
  /rangeDesignationTools\.has\(selectedDesignation\) && paintMode === "rect"\) \{\s*designateTwoClickRange\(downX, downY, event\.clientX, event\.clientY\);/,
  "dig/ramp/etc. route through the two-click handler (B193)");
{
  const twoClickSrc = (controls.match(/  function twoClickRangeMerge\([^]*?\n  \}/)?.[0] || "") +
    "\n" + (controls.match(/  async function designateTwoClickRange\([\s\S]*?\n  \}/)?.[0] || "");
  const commits = [];
  let corner = { x1: 164, y1: 102, x2: 164, y2: 102, z: 20 };
  const clickBox = {
    selectedDesignation: "dig",
    stairRangeStart: null,
    twoClickCursor: null,
    designationWorldSelection() { return { ...corner, w: 48, h: 30, tool: "dig" }; },
    showDesignationRangePreview() {},
    updateDesignationButtons() {},
    async submitDesignationRange(rect, endZ) { commits.push({ rect, endZ }); return true; },
  };
  vm.createContext(clickBox);
  vm.runInContext(twoClickSrc + "\nthis.click = designateTwoClickRange;", clickBox,
    { filename: "dwf-controls-placement.js:B193" });
  clickBox.click(0, 0, 0, 0);                       // click 1 arms; commits nothing
  assert.equal(commits.length, 0, "first click arms the corner without a POST");
  corner = { x1: 195, y1: 118, x2: 195, y2: 118, z: 20 };
  clickBox.click(0, 0, 0, 0);                       // click 2, SAME z: must commit (no limbo)
  assert.equal(commits.length, 1, "a same-z second click commits a mining rectangle (no limbo)");
  assert.deepEqual(
    [commits[0].rect.x1, commits[0].rect.y1, commits[0].rect.x2, commits[0].rect.y2, commits[0].endZ],
    [164, 102, 195, 118, 20], "the commit spans both clicked corners on one level");
}
const requireTwoClickRelease = source => assert.match(source,
  /designateTwoClickRange\(downX, downY, event\.clientX, event\.clientY\)/);
assert.throws(() => requireTwoClickRelease(
  "if (completedRange) submitDesignationRange(completedRange.selection, completedRange.endZ);"),
  "test-the-test: a revived held-drag release must fail this cell");

assert.match(placement,
  /if \(!des\.bits\.hidden\)[\s\S]*?return false;[\s\S]*?return true;/,
  "server dig eligibility accepts hidden tiles after validating their real map block");

console.log("# existing REQ_BLOCKS path covers chunks and late blocks replace stale void state");
const clock = { now: 10000 };
const sent = [];
const cacheBox = {
  console,
  document: { getElementsByTagName() { return []; } },
  Date: { now() { return clock.now; } },
  setTimeout,
  clearTimeout,
};
cacheBox.window = cacheBox;
cacheBox.DwfWS = { send(message) { sent.push(JSON.parse(JSON.stringify(message))); return true; } };
vm.createContext(cacheBox);
vm.runInContext(read("web/js/dwf-cache-worker.js"), cacheBox,
  { filename: "dwf-cache-worker.js" });
vm.runInContext(read("web/js/dwf-cache.js"), cacheBox, { filename: "dwf-cache.js" });
const cache = cacheBox.DwfCache;
assert.equal(cache._backend(), "sync");
assert.equal(cache.requestBlockRect(164, 102, 195, 118, 20), 6,
  "world rectangle crosses exactly six 16x16 blocks");
assert.deepEqual(sent, [{ type: "reqblocks", blocks: [
  [10, 6, 20], [10, 7, 20], [11, 6, 20], [11, 7, 20], [12, 6, 20], [12, 7, 20],
] }], "covered chunks must use the existing batched reqblocks message");

cache.setTiletypeMeta([[2, "StoneWall", "WALL", "STONE", "NORMAL"]]);
cache.ingest({
  origin: { x: 164, y: 102, z: 20 }, width: 1, height: 1, z: 20,
  tiles: [{ x: 164, y: 102, tt: 2, base_mt: 0, base_mi: 1, hidden: 1,
    flow: 0, liquid: "none", desig: { dig: "Default", smooth: 0, marker: false, traffic: 0, track: 0 } }],
});
const arrived = cache.windowView(164, 102, 20, 1, 1).tiles[0];
assert.equal(arrived.desig.dig, "Default",
  "a designation carried by a block arriving after the write must render from fresh cache data");

// The dirty callback receives packed chunk keys; it must clear the matching bx,by,bz request.
clock.now += 251;
cache.requestBlockRect(164, 102, 164, 102, 20);
assert.equal(sent.length, 2, "late block arrival must clear in-flight dedupe for a fresh refill");
cache._resetForTest();

console.log("PASS B133 cache-independent input, first-release volume POST, refill, and render");
