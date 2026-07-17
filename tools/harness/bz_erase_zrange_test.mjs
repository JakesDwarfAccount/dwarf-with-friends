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

// B187/B193 z-range designations. Run: node tools/harness/bz_erase_zrange_test.mjs
//
// B193 (native DF check 2026-07-10): every rectangle designation is TWO-CLICK -- click one
// corner, the box rubber-bands to the cursor with the button up (Shift+wheel mid-flow spans z,
// the B186 z-range semantics in two-click form), click again to commit the previewed volume.
// Click-drag no longer commits a designation; the B186 held-drag cells this file used to pin
// were deliberately replaced 2026-07-11 (this supersedes B186's gesture, not its z semantics).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const controls = read("web", "js", "dwf-controls-placement.js");
const core = read("web", "js", "dwf-core.js");
const html = read("web", "index.html");
const css = read("web", "css", "dwf.css");
const placement = read("src", "placement.cpp");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + ": " + (err?.stack || err)); }
}

// --- shared z-range matrix + submitter -------------------------------------------------------
check("all designation rectangle families join the audited z-range matrix", () => {
  // `traffic` joined the rectangle-designation family once it was fully wired (backendToolFor
  // -> traffic-{level}, DesignationKind::Traffic in placement.cpp): it paints des.bits.traffic
  // per tile inside the same z_lo..z_hi loop every other non-stair kind uses, so it spans z
  // identically and belongs in the audited matrix. Order mirrors rangeDesignationTools (after
  // fortify, before claim).
  const expected = ["dig", "stairs", "ramp", "channel", "remove", "erase",
    "convertmarker", "convertstandard", "chop", "gather", "smooth", "engrave", "track",
    "fortify", "traffic", "claim", "forbid", "dump", "undump", "melt", "unmelt", "hide", "unhide"];
  const source = controls.match(/const rangeDesignationTools = new Set\(\[[\s\S]*?\]\);/)?.[0] || "";
  const box = {};
  vm.createContext(box);
  vm.runInContext(source + "\nthis.tools = [...rangeDesignationTools];", box);
  assert.deepEqual(JSON.parse(JSON.stringify(box.tools)), expected);
});
check("the shared submitter resolves erase to clear and carries a signed z span", () => {
  const fn = controls.match(/  async function submitDesignationRange\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(fn, /backendToolFor\(designationTool\)/);
  assert.match(fn, /tool=\$\{encodeURIComponent\(rangeTool\)\}/);
  assert.match(fn, /zlevels=\$\{values\[4\] - values\[5\]\}/);
});
// Edited 2026-07-11 (B193): this cell used to REQUIRE the B186 held-drag branch
// (`if (pdown && active)` / `active.shifted = true`). Held-drag is no longer a designation
// gesture, so the wheel hook now fires ONLY for an armed two-click anchor and declines
// otherwise (camera z-step falls through in core).
check("Shift+wheel is intercepted only while a two-click anchor is armed", () => {
  const fn = controls.match(/  function designationRangeWheel\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(fn, /if \(!event \|\| !event\.shiftKey \|\| !twoClickArmed\(\)\) return false/);
  assert.match(fn, /queueMove\(0, 0, dz\)/);
  assert.doesNotMatch(fn, /pdown|shifted/, "the B186 held-drag branch is gone from the hook");
  assert.match(core, /if \(typeof window\.DFDesignationRangeWheel === "function"[\s\S]*?window\.DFDesignationRangeWheel\(event\)\) return/);
  assert.match(core, /if \(event\.shiftKey\)[\s\S]*?DFDesignationRangeWheel[\s\S]*?queueMove\(0, 0, event\.deltaY/);
});
// Edited 2026-07-11 (B193): the old cell VM-drove the held-drag endpoint mutation
// (designationDragRange.endZ). Same behavioral guarantee, two-click form: the wheel steps the
// camera z AND re-extends the pending preview from the last hovered tile; with no anchor armed
// it declines so core's plain camera z-step runs.
check("Shift+wheel re-extends the armed preview's z and no-ops with no anchor", () => {
  const src = ["twoClickEligible", "twoClickArmed", "twoClickRangeMerge", "designationRangeWheel"]
    .map(n => controls.match(new RegExp(`  function ${n}\\([^]*?\\n  \\}`))?.[0] || "")
    .join("\n");
  const moves = [];
  const previews = [];
  const rendered = { oz: 20 };
  const box = {
    zstep: 1,
    currentTool: "dig",
    selectedDesignation: "dig",
    paintMode: "rect",
    rangeDesignationTools: new Set(["dig", "erase", "stairs"]),
    stairRangeStart: { x1: 5, y1: 5, x2: 5, y2: 5, z: 20, tool: "dig" },
    stairRangePreview: { z1: 20, z2: 20 },
    twoClickCursor: { x: 100, y: 80 },
    queueMove(dx, dy, dz) { moves.push([dx, dy, dz]); rendered.oz += dz; },
    renderedImageRect() { return rendered; },
    designationWorldSelection() {
      return { x1: 8, y1: 7, x2: 8, y2: 7, z: rendered.oz, w: 80, h: 50 };
    },
    showDesignationRangePreview(sel, endZ) { previews.push({ sel, endZ }); },
    updateToolModeLabel() {},
  };
  vm.createContext(box);
  vm.runInContext(src + "\nthis.wheel = designationRangeWheel;", box);
  assert.equal(box.wheel({ shiftKey: true, deltaY: 1 }), true);
  assert.deepEqual(moves, [[0, 0, -1]]);
  const p = previews.at(-1);
  assert.deepEqual([p.sel.x1, p.sel.y1, p.sel.x2, p.sel.y2], [5, 5, 8, 7],
    "the re-extended preview still spans anchor -> last hovered tile");
  assert.equal(p.sel.z, 20, "z1 stays anchored to the first click's z");
  assert.equal(p.endZ, 19, "z2 follows the stepped camera");
  box.stairRangeStart = null;
  assert.equal(box.wheel({ shiftKey: true, deltaY: -1 }), false, "no anchor -> hook declines");
  assert.equal(moves.length, 1);
});
check("plain wheel keeps map zoom while a designation is pending", () => {
  assert.match(core, /if \(event\.shiftKey\) \{[\s\S]*?\} else \{\s*\/\/ Plain wheel[\s\S]*?zoomView/);
});
// Edited 2026-07-11 (B193): this cell used to pin the held-drag release commit
// (completedRange.shifted / completedRange). Click-drag no longer commits a designation --
// pointerup routes EVERY rect-mode rectangle designation through the two-click handler.
check("pointerup routes every rect-mode rectangle designation through the two-click handler", () => {
  const fn = controls.match(/view\.addEventListener\("pointerup"[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.match(fn,
    /rangeDesignationTools\.has\(selectedDesignation\) && paintMode === "rect"\) \{\s*designateTwoClickRange\(downX, downY, event\.clientX, event\.clientY\);/);
  assert.doesNotMatch(fn, /completedRange/, "the held-drag commit path is fully removed");
});

// --- B187 payload semantics ----------------------------------------------------------------
function erasePayload(start, camera, footprint) {
  return { px: start.x1 - camera.x, py: start.y1 - camera.y,
    px2: start.x2 - camera.x, py2: start.y2 - camera.y,
    w: footprint.w, h: footprint.h, zlevels: start.z - camera.z, tool: "clear" };
}
function assertSpan(p) {
  assert.equal(p.tool, "clear");
  assert.notEqual(p.px, p.px2);   // area preserved (both corners), not collapsed
  assert.notEqual(p.py, p.py2);
  assert.notEqual(p.zlevels, 0);  // a genuine multi-z span, the whole point of B187
}
check("erase over a 3-level span submits distinct corners + a nonzero signed zlevels", () => {
  const start = { x1: 47, y1: 61, x2: 52, y2: 71, z: 169 };
  const p = erasePayload(start, { x: 40, y: 55, z: 166 }, { w: 80, h: 50 });
  assert.equal(p.zlevels, 3);
  assertSpan(p);
});
check("(test-the-test) a collapsed single-z erase payload is rejected as not-a-span", () => {
  // The pre-B187 failure mode: erase could only touch the camera level (zlevels 0, and older
  // code even collapsed px2->px). If that regressed back, assertSpan must catch it.
  assert.throws(() => assertSpan({ tool: "clear", px: 7, py: 6, px2: 7, py2: 6, zlevels: 0 }),
    "seeded-bad collapsed/single-level erase payload must fail the span assertion");
});

// --- B187 server oracle: DF's own /designate clears across the whole z-range ----------------
// The authoritative surface is src/placement.cpp's tile pass. The z-loop applies req.dig at
// EVERY level for the Clear kind; the up/updown/down retyping is gated to stair dig-types only.
check("server z-loop applies the designation across z_lo..z_hi for every kind (not stair-gated)", () => {
  assert.match(placement, /for \(int z = z_lo; z <= z_hi; \+\+z\) \{/);
  const loop = placement.match(/for \(int z = z_lo; z <= z_hi; \+\+z\) \{[\s\S]*?\n    \}/)?.[0] || "";
  // Clear runs the tile designation pass every level (Clear is not Chop/Gather/ItemFlag).
  assert.match(loop, /req\.kind != DesignationKind::Chop && req\.kind != DesignationKind::Gather &&\s*req\.kind != DesignationKind::ItemFlag\)\s*changed = apply_tile_designations_at/);
  // The stair retyping is the ONLY thing gated behind is_stair -- clearing is uniform per level.
  assert.match(loop, /if \(is_stair && z_hi > z_lo\) \{/);
});
check("(test-the-test) the per-level designation pass is NOT wrapped inside if (is_stair)", () => {
  const loop = placement.match(/for \(int z = z_lo; z <= z_hi; \+\+z\) \{[\s\S]*?\n    \}/)?.[0] || "";
  // If a future edit gated the whole apply pass behind is_stair, erase would silently stop
  // spanning z. Assert the apply call sits at loop scope, after the is_stair block closes.
  const stairAt = loop.indexOf("if (is_stair && z_hi > z_lo)");
  const applyAt = loop.indexOf("apply_tile_designations_at");
  assert.ok(stairAt >= 0 && applyAt > stairAt, "clear's apply pass runs at loop scope, past the stair-only retype");
});

// --- B193 two-click flow (was: B187/B58 two-release compatibility) ---------------------------
// Edited 2026-07-11 (B193): the old cell required pointerup to special-case stairs/erase into
// the two-release path while dig/ramp/etc. committed held drags. The two-click handler is now
// the ONLY rect commit path, tool-agnostic; only stairs keeps its same-z hold (a stair
// designation is meaningless without a level span -- every other tool's same-z second click
// commits the common single-level rect).
check("the two-click handler is tool-agnostic; only stairs holds on a same-z second click", () => {
  const pointer = controls.match(/view\.addEventListener\("pointerup"[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.doesNotMatch(pointer, /=== "stairs" \|\| selectedDesignation === "erase"/,
    "pointerup no longer special-cases stairs/erase routing");
  const fn = controls.match(/  async function designateTwoClickRange\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(fn, /const isStairs = selectedDesignation === "stairs";/);
  assert.match(fn, /if \(start\.z === pointZ && isStairs\)/);
  // B196: the second click commits the rubber-banded bbox(anchor, this click), not the
  // frozen anchor footprint, so the committed rect equals exactly what the cursor previewed.
  assert.match(fn, /const rect = twoClickRangeMerge\(start, selection\)/);
  assert.match(fn, /await submitDesignationRange\(rect, pointZ\)/);
});
// B193 acceptance: EVERY converted tool completes a two-click rect through the shared submitter
// (one commit, merged corners, the tool's own name on the selection). Runs the REAL
// designateTwoClickRange + twoClickRangeMerge sources per tool.
check("every rectangle designation tool completes a two-click rect (one commit each)", () => {
  const src = ["twoClickRangeMerge"]
    .map(n => controls.match(new RegExp(`  function ${n}\\([^]*?\\n  \\}`))?.[0]).join("\n") +
    "\n" + (controls.match(/  async function designateTwoClickRange\([\s\S]*?\n  \}/)?.[0] || "");
  assert.ok(src.includes("designateTwoClickRange"), "handler source extracted");
  const tools = ["dig", "stairs", "ramp", "channel", "remove", "erase",
    "convertmarker", "convertstandard", "chop", "gather", "smooth", "engrave", "track",
    "fortify", "traffic", "claim", "forbid", "dump", "undump", "melt", "unmelt", "hide", "unhide"];
  for (const tool of tools) {
    const commits = [];
    let clickAt = { x1: 10, y1: 10, x2: 10, y2: 10, z: 30 };
    const box = {
      selectedDesignation: tool,
      stairRangeStart: null,
      twoClickCursor: null,
      designationWorldSelection() { return { ...clickAt, w: 80, h: 50, tool }; },
      showDesignationRangePreview() {},
      updateDesignationButtons() {},
      async submitDesignationRange(rect, endZ) { commits.push({ rect, endZ }); return true; },
    };
    vm.createContext(box);
    vm.runInContext(src + "\nthis.click = designateTwoClickRange;", box);
    box.click(100, 100, 100, 100);              // click 1: arm the corner
    assert.equal(commits.length, 0, `${tool}: first click arms, never commits`);
    assert.equal(box.stairRangeStart.tool, tool);
    // click 2 at the opposite corner; stairs needs a z change to commit (same-z holds).
    clickAt = { x1: 14, y1: 17, x2: 14, y2: 17, z: tool === "stairs" ? 27 : 30 };
    box.click(140, 170, 140, 170);
    assert.equal(commits.length, 1, `${tool}: second click commits exactly once`);
    const { rect, endZ } = commits[0];
    assert.deepEqual([rect.x1, rect.y1, rect.x2, rect.y2], [10, 10, 14, 17],
      `${tool}: commit spans click1 -> click2`);
    assert.equal(rect.z, 30, `${tool}: z1 anchored to the first click`);
    assert.equal(endZ, tool === "stairs" ? 27 : 30);
    assert.equal(rect.tool, tool);
  }
});
check("(test-the-test) stairs same-z second click holds instead of committing", () => {
  const src = (controls.match(/  function twoClickRangeMerge\([^]*?\n  \}/)?.[0] || "") + "\n" +
    (controls.match(/  async function designateTwoClickRange\([\s\S]*?\n  \}/)?.[0] || "");
  const commits = [];
  const box = {
    selectedDesignation: "stairs",
    stairRangeStart: null,
    twoClickCursor: null,
    designationWorldSelection() { return { x1: 4, y1: 4, x2: 4, y2: 4, z: 30, w: 80, h: 50, tool: "stairs" }; },
    showDesignationRangePreview() {},
    updateDesignationButtons() {},
    async submitDesignationRange(rect, endZ) { commits.push({ rect, endZ }); return true; },
  };
  vm.createContext(box);
  vm.runInContext(src + "\nthis.click = designateTwoClickRange;", box);
  box.click(40, 40, 40, 40);
  box.click(40, 40, 40, 40);
  assert.equal(commits.length, 0, "same-z stairs keeps waiting for the other z-level");
  assert.ok(box.stairRangeStart, "the anchor survives the held same-z click");
});

// --- B209 dead-second-click (win32, 2026-07-11) --------------------------------------------
// "the eraser tool ... doesnt seem to click as responsive as the mining tool ... the second click
// does nothing and you have to hit esc to cancel the tool use, its inconsistent." Root cause: erase
// resolves to tool=clear; clearing an area with no live designation (the common eraser case -- and
// every RE-erase of a tile whose glyph the server un-ship staleness left on screen, B209 defect a)
// makes the server return "no valid tiles" (non-ok). The OLD commit leg reset stairRangeStart only
// on the submit SUCCESS path, so a rejected second click left the anchor armed and the rubber-band
// frozen -- the tool never released and Esc was the only way out. Dig felt fine only because a fresh
// dig almost always hits diggable walls (ok). The fix disarms the anchor on the second (commit)
// click UNCONDITIONALLY, BEFORE awaiting the POST, so the gesture always closes like a committed dig
// regardless of the server's answer. The disarm sits AFTER the stairs same-z hold guard, so the one
// tool that legitimately holds (stairs, covered by the cell just above) is untouched.
check("B209: a rejected second-click erase STILL closes the gesture (no frozen box, no Esc needed)", () => {
  const src = (controls.match(/  function twoClickRangeMerge\([^]*?\n  \}/)?.[0] || "") + "\n" +
    (controls.match(/  async function designateTwoClickRange\([\s\S]*?\n  \}/)?.[0] || "");
  const box = {
    selectedDesignation: "erase",
    stairRangeStart: null,
    twoClickCursor: null,
    designationWorldSelection() { return { x1: 4, y1: 4, x2: 4, y2: 4, z: 22, w: 80, h: 50, tool: "erase" }; },
    showDesignationRangePreview() {},
    updateDesignationButtons() {},
    // Server rejects the erase (nothing to clear) -- the exact case that used to strand the tool.
    async submitDesignationRange() { return false; },
  };
  vm.createContext(box);
  vm.runInContext(src + "\nthis.click = designateTwoClickRange;", box);
  box.click(40, 40, 40, 40);              // click 1: arm the anchor
  assert.ok(box.stairRangeStart, "first click arms the anchor");
  // click 2, SAME z: erase must commit-and-close (only stairs holds same-z). The disarm runs
  // synchronously before the awaited POST, so it is observable without awaiting the rejection.
  box.click(40, 40, 40, 40);
  assert.equal(box.stairRangeStart, null, "a rejected second click still disarms -- gesture closed, no Esc");
  assert.equal(box.twoClickCursor, null, "the pending two-click cursor is cleared too");
});
check("(test-the-test) the second-click disarm PRECEDES the POST (can't regress to reset-only-on-success)", () => {
  const fn = controls.match(/  async function designateTwoClickRange\([\s\S]*?\n  \}/)?.[0] || "";
  const disarmAt = fn.indexOf("stairRangeStart = null");
  const submitAt = fn.indexOf("await submitDesignationRange(rect, pointZ)");
  assert.ok(disarmAt >= 0, "the commit leg clears stairRangeStart");
  assert.ok(submitAt >= 0, "the commit leg awaits the shared submitter");
  assert.ok(disarmAt < submitAt,
    "the anchor is cleared BEFORE the POST is awaited -- otherwise a non-ok erase strands the box");
});

// --- B196/B193 live rubber-band between the two clicks (native cursor-following box) ---------
// Edited 2026-07-11 (B193): the old cell's scope guard asserted dig was EXCLUDED from the
// two-click gesture (B196 shipped it for erase/stairs only, pending the native check). The owner
// verified natively that ALL rectangle designations are two-click, so the guard inverts:
// every rangeDesignationTools member arms; free paint, missing anchors, tool-mismatched
// anchors, and unwired tools still do not.
check("(B193) an armed two-click anchor is recognized for EVERY rect-mode designation tool", () => {
  const src = ["twoClickEligible", "twoClickArmed"]
    .map(n => controls.match(new RegExp(`  function ${n}\\([^]*?\\n  \\}`))?.[0] || "").join("\n");
  assert.ok(src.includes("twoClickArmed"), "two-click helpers exist");
  const mk = (over) => Object.assign({
    stairRangeStart: { tool: "erase" }, selectedDesignation: "erase", currentTool: "clear",
    paintMode: "rect",
    rangeDesignationTools: new Set(["erase", "stairs", "dig", "ramp", "claim"]),
  }, over);
  const run = (box) => { vm.createContext(box); vm.runInContext(src + "\nthis.a = twoClickArmed();", box); return box.a; };
  assert.equal(run(mk({})), true, "erase, rect, anchor set -> armed");
  assert.equal(run(mk({ selectedDesignation: "stairs", currentTool: "stairs", stairRangeStart: { tool: "stairs" } })), true);
  assert.equal(run(mk({ selectedDesignation: "dig", currentTool: "dig", stairRangeStart: { tool: "dig" } })), true,
    "dig joins the two-click flow (B193)");
  assert.equal(run(mk({ selectedDesignation: "claim", currentTool: "claim", stairRangeStart: { tool: "claim" } })), true,
    "item-designation rectangles join the two-click flow (B193)");
  assert.equal(run(mk({ stairRangeStart: null })), false, "no anchor -> not armed");
  assert.equal(run(mk({ paintMode: "free" })), false, "free paint keeps its drag stroke -> not armed");
  assert.equal(run(mk({ selectedDesignation: "dig", currentTool: "dig" })), false,
    "an anchor captured by a DIFFERENT tool never arms the new tool");
  assert.equal(run(mk({ selectedDesignation: "hauling", currentTool: null, stairRangeStart: { tool: "hauling" } })), false,
    "a mode tool with no backend wire (currentTool null, e.g. hauling) never arms");
});
check("(B196) preview follows the cursor: bbox(anchor, cursor) grows from a 1x1 first click", () => {
  const src = controls.match(/  function twoClickRangeMerge\([\s\S]*?\n  \}/)?.[0] || "";
  assert.ok(src, "twoClickRangeMerge helper exists");
  const box = { selectedDesignation: "erase" };
  vm.createContext(box);
  vm.runInContext(src + "\nthis.merge = twoClickRangeMerge;", box);
  // Plain first click => anchor is the single tile (10,10); cursor at (14,17) => exact A->cursor.
  const anchor = { x1: 10, y1: 10, x2: 10, y2: 10, z: 100, tool: "erase" };
  const r = box.merge(anchor, { x1: 14, y1: 17, x2: 14, y2: 17, z: 97, w: 80, h: 50 });
  assert.deepEqual([r.x1, r.y1, r.x2, r.y2], [10, 10, 14, 17], "box tracks to the cursor tile");
  assert.equal(r.z, 100, "z1 stays anchored to the first click's z (z2 comes from live camera)");
  assert.equal(r.tool, "erase");
  // (test-the-test) a merge that ignored the cursor and returned the frozen anchor is rejected.
  const frozen = (a) => ({ ...a });
  assert.throws(() => assert.deepEqual(
    (({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])(frozen(anchor)), [10, 10, 14, 17]),
    "the pre-B196 frozen-anchor commit must not equal the cursor-followed rect");
});
check("(B196) the second click completes EXACTLY the previewed rect (commit == preview path)", () => {
  // updateTwoClickRubberBand previews twoClickRangeMerge(anchor, cursor); designateTwoClickRange
  // commits twoClickRangeMerge(start, selection). Same builder, same last cursor => identical rect.
  const upd = controls.match(/  function updateTwoClickRubberBand\([\s\S]*?\n  \}/)?.[0] || "";
  const fn = controls.match(/  async function designateTwoClickRange\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(upd, /twoClickRangeMerge\(stairRangeStart, cursorSel\)/, "preview uses the shared builder");
  assert.match(fn, /twoClickRangeMerge\(start, selection\)/, "commit uses the same shared builder");
});
// Edited 2026-07-11 (B193): the wiring used to gate on `!pdown` (held moves belonged to the
// held-drag preview). With held-drag gone the rubber band tracks the cursor unconditionally --
// including through a held second press, whose release commits bbox(anchor, release point).
check("(B193) the rubber-band is wired to every pointermove while armed", () => {
  const move = controls.match(/view\.addEventListener\("pointermove"[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.match(move, /if \(twoClickArmed\(\)\) updateTwoClickRubberBand/,
    "armed move repaints the box (no pdown gate)");
});
check("(B196) mid-flow z-change re-extends the pending preview from the last cursor", () => {
  const src = controls.match(/  function designationRangeWheel\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(src, /!twoClickArmed\(\)\) return false/);
  assert.match(src, /const cursorSel = twoClickCursor[\s\S]*?twoClickRangeMerge\(stairRangeStart, cursorSel\)/,
    "the between-clicks wheel rebuilds the preview at the new camera z from twoClickCursor");
});
check("(B196) Escape backs out a pending two-click box before deselecting the tool", () => {
  // The two-click cancel branch must appear BEFORE the broad deselect branch so one Escape backs
  // out the pending box (tool stays armed) and a second Escape drops the tool -- native DF order.
  const cancelAt = controls.indexOf("} else if (twoClickArmed()) {");
  const deselectAt = controls.indexOf(
    "} else if (digMenuOpen || plantMenuOpen || smoothMenuOpen || itemDesigMenuOpen || selectedDesignation || currentTool) {");
  assert.ok(cancelAt >= 0, "an Escape branch cancels the pending two-click box");
  assert.ok(deselectAt > cancelAt, "the pending-box cancel is checked before the tool-deselect branch");
  const branch = controls.slice(cancelAt, deselectAt);
  assert.match(branch, /stairRangeStart = null;[\s\S]*?twoClickCursor = null;/);
});
check("numeric z control is completely removed", () => {
  for (const source of [controls, core, html, css])
    assert.doesNotMatch(source, /digZLevels|buildZLevelsControl|dwfGetZLevels|dig-zlevels/);
  assert.doesNotMatch(controls, /digOptsQuery\(\)[\s\S]{0,300}zlevels=/);
});
check("(test-the-test) a reintroduced old stepper is rejected", () => {
  const rejectStepper = source => assert.doesNotMatch(source, /digZLevels|buildZLevelsControl/);
  assert.throws(() => rejectStepper("let digZLevels = 0; buildZLevelsControl(toolbar);"));
});
// Edited 2026-07-11 (B193): replaces the old "(test-the-test) a shifted drag that falls back to
// single-z" cell -- with held-drag gone the seeded-bad case is a REVIVED held-drag commit, which
// must fail the two-click routing assertion above.
check("(test-the-test) a revived held-drag commit is rejected by the two-click routing cell", () => {
  const requireTwoClickRouting = source => {
    assert.match(source, /paintMode === "rect"\) \{\s*designateTwoClickRange/);
    assert.doesNotMatch(source, /completedRange/);
  };
  requireTwoClickRouting(controls.match(/view\.addEventListener\("pointerup"[\s\S]*?\n  \}\);/)?.[0] || "");
  assert.throws(() => requireTwoClickRouting(
    'if (rangeDesignationTools.has(selectedDesignation) && paintMode === "rect") {' +
    ' if (completedRange && completedRange.shifted)' +
    ' submitDesignationRange(completedRange.selection, completedRange.endZ); }'));
});

// --- B193 paint-family regression: drag-paint tools are deliberately UNTOUCHED ---------------
// the directive converts only the RECTANGLE-DESIGNATION family; free paint and the
// stockpile/zone/burrow paint modes are legitimately drag-driven and keep their gestures.
check("(B193 regression) free paint keeps its per-cell drag stroke", () => {
  const down = controls.match(/view\.addEventListener\("pointerdown"[\s\S]*?\n  \}\);/)?.[0] || "";
  const move = controls.match(/view\.addEventListener\("pointermove", event => \{\s*\/\/ B196\/B193[\s\S]*?\n  \}\);/)?.[0] || "";
  const up = controls.match(/view\.addEventListener\("pointerup"[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.match(down, /if \(freePaintActive\(\)\) \{\s*freePaintCells = new Set\(\);/);
  assert.match(move, /if \(freePaintCells\) freePaintTo\(cur\);/);
  assert.match(up, /if \(freePaintCells\) \{ freePaintCells = null; freePaintLastCell = null; \}/);
});
check("(B193 regression) stockpile/zone/burrow/repaint drags still commit from pointerup", () => {
  const up = controls.match(/view\.addEventListener\("pointerup"[\s\S]*?\n  \}\);/)?.[0] || "";
  // (2026-07-17 stockpile repaint session) repaintStockpileDrag was replaced by
  // stageStockRepaintDrag, which stages from the same full down->up drag and commits on Accept.
  for (const call of ["zonePaintDrag", "createStockpileDrag", "burrowPaintDrag",
    "stageStockRepaintDrag", "stockEraseDrag", "zoneEraseDrag"]) {
    assert.match(up, new RegExp(`${call}\\(downX, downY, event\\.clientX, event\\.clientY\\)`),
      `${call} still receives the full down->up drag`);
  }
});

if (failed) {
  console.error(`\nFAIL ${failed} B187/B193 z-range designation cell(s)`);
  process.exit(1);
}
console.log("\nPASS two-click rectangle designations, z-range semantics, and paint-family regression");
