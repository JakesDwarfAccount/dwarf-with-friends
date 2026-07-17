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

// b108_claimed_designation_blink_test.mjs -- offline B108 claimed-mining blink fixture.
// Run: node tools/harness/b108_claimed_designation_blink_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const glbox = { self: null, performance: { now: () => 0 } };
glbox.self = glbox; vm.createContext(glbox);
vm.runInContext(read("web", "js", "dwf-gl.js"), glbox, { filename: "dwf-gl.js" });
const GL = glbox.DwfGL;

class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) {
    if (p in t) return t[p];
    if (p === "measureText") return () => ({ width: 8 });
    return () => {};
  }, set(t, p, v) { t[p] = v; return true; } }); }
}
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; },
  createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
globalThis.Image = class { set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });
vm.runInThisContext(read("web", "js", "dwf-tiles.js"), { filename: "dwf-tiles.js" });
const Tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });

function atlas() {
  const ids = new Map(); let next = 1;
  return { resolve(sheet, col, row) {
    const k = sheet + "|" + col + "|" + row;
    if (!ids.has(k)) ids.set(k, next++);
    return ids.get(k);
  }, resolvePalette(sheet, col, row) { return this.resolve(sheet, col, row); } };
}
function cells(builder) {
  const u = new Uint16Array(builder.buffer);
  return Array.from({ length: builder.count }, (_, i) => u[i * 8 + 4]);
}
const floor = { tt: 1, ttname: "StoneFloor", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 0 };
function glyphAt(nowMs, djobs, tile = floor, units) {
  const a = atlas();
  const b = GL.createSceneBuilder({ atlas: a, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 150 }, width: 1, height: 1, tiles: [tile], djobs,
    units, designationNowMs: nowMs });
  return cells(b).includes(a.resolve("designations.png", 0, 1));
}

// ---------------------------------------------------------------------------------------
// B135 three-state cadence (live observation of native, 07-10). DF posts designation
// jobs that sit WORKERLESS in the job list -- native keeps those STEADY (the first B135
// cut over-blinked them; that regression is what state 0 kills). Wire discriminator: the
// djob's additive `w:1` (UNIT_WORKER general ref attached, world_stream.cpp DJobRec).
//   state 0  job, no worker        -> steady glyph
//   state 1  worker en-route       -> pulse on the shared 800ms beat
//   state 2  unit ON the work tile -> pulse on the 400ms half-beat + dwarf<->object
//            alternation (unit takes the anti-phase half)
// Both cadences divide the SAME perf-epoch clock: phase-locked, no second timer.
// ---------------------------------------------------------------------------------------
const BEAT = GL.UNIT_STATUS_BLINK_MS;          // 800
const HALF = GL.DESIG_ACTIVE_BLINK_MS;         // 400
assert.equal(HALF * 2, BEAT, "GL half-beat divides the shared clock exactly in two");
assert.equal(Tiles._DESIG_ACTIVE_BLINK_MS * 2, BEAT, "canvas2d half-beat divides the shared clock exactly in two");

for (const [name, visible, unitVisible, blinkState, hasBlinking] of [
  ["GL", GL.designationGlyphVisible, GL.workedTileUnitVisible, GL.designationBlinkState, GL.hasBlinkingDesignationJob],
  ["canvas2d", Tiles._designationGlyphVisibleForTest, Tiles._workedTileUnitVisibleForTest,
    Tiles._designationBlinkStateForTest, Tiles._hasBlinkingDesignationJobForTest],
]) {
  // State model resolution.
  assert.equal(blinkState(7, false, false), 0, name + " workerless djob is state 0");
  assert.equal(blinkState(7, false, true), 0, name + " a bystander unit cannot promote a workerless djob");
  assert.equal(blinkState(7, true, false), 1, name + " worker en-route is state 1");
  assert.equal(blinkState(7, true, true), 2, name + " worker on the tile is state 2");
  assert.equal(blinkState(0, true, true), 0, name + " kind 0 (no djob) never blinks");
  for (let k = 1; k <= 13; k++) {
    // State 0 -- THE regression kill: an unclaimed job is steady at every phase.
    for (const t of [0, HALF, BEAT, BEAT + HALF, 3 * BEAT]) {
      assert.equal(visible(k, t, false, false), true,
        name + " kind " + k + " UNCLAIMED job glyph is steady at t=" + t);
    }
    // State 1 -- 800ms beat; the 400ms boundary must NOT flip it (phase-lock).
    assert.equal(visible(k, 0, true, false), true, name + " kind " + k + " state-1 glyph shows at beat-on");
    assert.equal(visible(k, HALF, true, false), true, name + " kind " + k + " state-1 glyph ignores the half-beat boundary");
    assert.equal(visible(k, BEAT, true, false), false, name + " kind " + k + " state-1 glyph hides at beat-off");
    assert.equal(visible(k, BEAT + HALF, true, false), false, name + " kind " + k + " state-1 glyph stays hidden mid-beat-off");
    // State 2 -- 400ms half-beat.
    assert.equal(visible(k, 0, true, true), true, name + " kind " + k + " state-2 glyph shows at half-beat-on");
    assert.equal(visible(k, HALF, true, true), false, name + " kind " + k + " state-2 glyph hides at half-beat-off");
    assert.equal(visible(k, BEAT, true, true), true, name + " kind " + k + " state-2 glyph re-shows on the next half-beat");
  }
  // Idle designation (kind 0, no djob at all) is steady.
  assert.equal(visible(0, 0), true, name + " idle designation is steady at beat-on");
  assert.equal(visible(0, BEAT), true, name + " idle designation is steady at beat-off");
  // Anti-phase invariant: in state 2, at every instant exactly ONE of {glyph, unit} shows.
  for (const t of [0, HALF, BEAT, BEAT + HALF, 3 * BEAT]) {
    assert.equal(unitVisible(t), !visible(6, t, true, true),
      name + " worked-tile unit visibility is the exact anti-phase of the state-2 glyph at t=" + t);
  }
  // The rAF repaint gate only arms when a WORKER-claimed djob exists.
  assert.equal(hasBlinking([{ x: 0, y: 0, z: 150, k: 7 }]), false,
    name + " workerless djobs do not arm the blink repaint loop");
  assert.equal(hasBlinking([{ x: 0, y: 0, z: 150, k: 7, w: 1 }]), true,
    name + " a worker-claimed djob arms the blink repaint loop");
}

// GL end-to-end, state 0: an unclaimed djob's glyph survives every phase (regression kill).
const dj0 = [{ x: 0, y: 0, z: 150, k: 7 }];
assert.equal(glyphAt(0, dj0), true, "GL unclaimed djob glyph at beat-on");
assert.equal(glyphAt(BEAT, dj0), true, "GL unclaimed djob glyph STEADY at beat-off");
assert.equal(glyphAt(HALF, dj0), true, "GL unclaimed djob glyph STEADY at half-beat-off");
// GL end-to-end, state 1: worker claimed, nobody on the tile -> the shared 800ms beat.
const dj1 = [{ x: 0, y: 0, z: 150, k: 7, w: 1 }];
assert.equal(glyphAt(0, dj1), true, "GL state-1 djob emits its glyph at beat-on");
assert.equal(glyphAt(HALF, dj1), true, "GL state-1 djob ignores the half-beat boundary");
assert.equal(glyphAt(BEAT, dj1), false, "GL state-1 djob removes its glyph at beat-off");
// GL end-to-end, state 2: a unit stands ON the claimed tile -> the 400ms half-beat.
const onTile = [{ id: 1, x: 0, y: 0, z: 150 }];
assert.equal(glyphAt(0, dj1, floor, onTile), true, "GL state-2 djob emits its glyph at half-beat-on");
assert.equal(glyphAt(HALF, dj1, floor, onTile), false, "GL state-2 djob removes its glyph at half-beat-off");
assert.equal(glyphAt(BEAT, dj1, floor, onTile), true, "GL state-2 djob re-emits on the next half-beat");
assert.equal(glyphAt(HALF, dj0, floor, onTile), true,
  "GL a unit standing on an UNCLAIMED djob tile does not start the half-beat (still steady)");
// Idle desig bits stay steady.
const idle = { ...floor, desig: { dig: "Default" } };
assert.equal(glyphAt(0, [], idle), true, "GL idle desig glyph is visible at beat-on");
assert.equal(glyphAt(BEAT, [], idle), true, "GL idle desig glyph is steady at beat-off");

// GL end-to-end alternation: buildScene stages a WORKER-claimed gather djob, buildUnits
// stands a unit on it. Glyph half of the half-beat -> zero unit instances; unit half ->
// the unit renders. A bystander off the tile renders on BOTH halves, and a unit standing
// on a WORKERLESS djob tile is never suppressed (state 0 does not alternate).
function unitInstanceCount(nowMs, unitX, djobs) {
  const a = atlas();
  const b = GL.createSceneBuilder({ atlas: a, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  const us = [{ id: 1, x: unitX, y: 0, z: 150 }];
  b.buildScene({ origin: { x: 0, y: 0, z: 150 }, width: 2, height: 1, tiles: [floor, floor],
    djobs, units: us, designationNowMs: nowMs });
  return b.buildUnits(us, 0, 0, 150, nowMs).count;
}
const gatherW = [{ x: 0, y: 0, z: 150, k: 6, w: 1 }];
const gather0 = [{ x: 0, y: 0, z: 150, k: 6 }];
assert.equal(unitInstanceCount(0, 0, gatherW), 0, "GL unit on a worker-claimed djob tile yields the glyph half");
assert.ok(unitInstanceCount(HALF, 0, gatherW) > 0, "GL unit on a worker-claimed djob tile renders on the unit half");
assert.ok(unitInstanceCount(0, 1, gatherW) > 0, "GL bystander unit off the djob tile renders at half-beat-on");
assert.ok(unitInstanceCount(HALF, 1, gatherW) > 0, "GL bystander unit off the djob tile renders at half-beat-off");
assert.ok(unitInstanceCount(0, 0, gather0) > 0, "GL unit on a WORKERLESS djob tile is never suppressed (on-half)");
assert.ok(unitInstanceCount(HALF, 0, gather0) > 0, "GL unit on a WORKERLESS djob tile is never suppressed (off-half)");
assert.equal(glyphAt(0, [{ x: 0, y: 0, z: 150, k: 5, w: 1 }],
  { ...floor, ttname: "Tree", shape: "WALL" }), false,
  "resolveDjob kind 5 (chop) resolves its own cell, not the dig cell (sanity: glyph lookup below is kind-specific)");
assert.equal(cellsIncludeChop(0), true, "GL claimed chop djob emits its glyph at beat-on");
assert.equal(cellsIncludeChop(BEAT), false, "GL claimed chop djob removes its glyph at beat-off");
function cellsIncludeChop(nowMs) {
  const a = atlas();
  const b = GL.createSceneBuilder({ atlas: a, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 150 }, width: 1, height: 1, tiles: [floor],
    djobs: [{ x: 0, y: 0, z: 150, k: 5, w: 1 }], designationNowMs: nowMs });
  return cells(b).includes(a.resolve("designations.png", 0, 8));
}

// Seeded-bad guards.
// (a) An unclaimed job must NOT blink: the pre-B135 implementation (blink on kind alone,
// ignoring the worker flag) must fail the state-0 steady requirement.
function requiresUnclaimedSteady(visible) {
  for (const t of [0, HALF, BEAT]) assert.equal(visible(7, t, false, false), true);
}
assert.throws(() => requiresUnclaimedSteady(
  (k, t) => !GL.isBlinkingDesignationJob(k) || GL.unitStatusBlinkVisible(t)),
  "seeded-bad: the old worker-blind blink (every djob pulses) must fail state-0 steady");
// (b) A blink applied to idle designations (kind 0) must fail.
function requiresIdleSteady(visible) {
  assert.equal(visible(0, 0), true);
  assert.equal(visible(0, BEAT), true);
}
assert.throws(() => requiresIdleSteady((_, nowMs) => GL.unitStatusBlinkVisible(nowMs)),
  "seeded-bad: a blink applied to idle designations must fail");
// (c) Alternation: hiding the unit on BOTH halves (tile flashes empty), or drawing it IN
// phase with the glyph, must fail the state-2 anti-phase invariant.
function requiresAntiPhase(unitVisible, glyphVisible) {
  for (const t of [0, HALF]) assert.equal(unitVisible(t), !glyphVisible(6, t, true, true));
}
assert.throws(() => requiresAntiPhase(() => false, GL.designationGlyphVisible),
  "seeded-bad: hiding the worked-tile unit on both halves must fail");
assert.throws(() => requiresAntiPhase((t) => GL.activeBlinkVisible(t), GL.designationGlyphVisible),
  "seeded-bad: drawing the unit IN phase with the glyph must fail");
// (d) State 1 running on the half-beat (a second effective cadence) must fail phase-lock.
function requiresState1OnTheBeat(visible) {
  assert.equal(visible(7, HALF, true, false), true);
}
assert.throws(() => requiresState1OnTheBeat((k, t) => GL.activeBlinkVisible(t)),
  "seeded-bad: state 1 stepping at the half-beat must fail");

console.log("PASS B108/B135 three-state designation cadence (steady / 800ms beat / 400ms half-beat + dwarf<->object alternation): both renderers");
