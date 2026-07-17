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
//
// UNITSHEET-LIVE wave:
//   B136 -- the open unit sheet was a point-in-time snapshot; the activity line and
//     every data-driven tab stayed frozen while the dwarf changed jobs. A live-refresh timer now
//     re-polls /unit while the sheet is open for the active unit, tearing down on close/switch and
//     preserving scroll + any in-progress interaction.
//   B176 -- an assigned Rooms row is click-to-view: reuse the camera jump + zone panel
//     opener, never a duplicate.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const core = readFileSync(new URL("../../web/js/dwf-unit-hud-notifications.js", import.meta.url), "utf8");

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("PASS " + label); }
  catch (error) { console.log("FAIL " + label); throw error; }
}

// ---------------------------------------------------------------------------------------------
// B136 -- refresh lifecycle: created on open, destroyed on close/switch, never leaked.
// ---------------------------------------------------------------------------------------------
console.log("# B136 live-refresh lifecycle");

check("the timer is (re)armed when a sheet opens (showUnitSheet)", () => {
  assert.match(core, /function showUnitSheet\(data\)\s*\{[\s\S]*?startUnitSheetRefresh\(Number\(data\?\.unit\?\.id/);
});
check("start stops any prior timer first, so switching units cannot leak an interval", () => {
  assert.match(core, /function startUnitSheetRefresh\([\s\S]*?\{\s*stopUnitSheetRefresh\(\);/);
});
check("start refuses a bad unit id (no interval for a phantom sheet)", () => {
  assert.match(core, /if \(!Number\.isInteger\(id\) \|\| id < 0\) return;\s*[\s\S]*?unitSheetRefreshTimer = window\.setInterval/);
});
check("stop clears the interval AND resets the tracked id", () => {
  assert.match(core, /function stopUnitSheetRefresh\(\)\s*\{[\s\S]*?window\.clearInterval\(unitSheetRefreshTimer\)[\s\S]*?unitSheetRefreshId = -1;/);
});
check("the explicit close button tears the timer down", () => {
  assert.match(core, /data-unit-close[\s\S]*?stopUnitSheetRefresh\(\);[^\n]*\n\s*closeSelection\(\);/);
});
check("the tick self-terminates when the sheet is no longer open for this unit (Esc / panel switch)", () => {
  assert.match(core, /if \(!unitSheetStillOpen\(unitSheetRefreshId\)\) \{ stopUnitSheetRefresh\(\); return; \}/);
});
check("still-open means visible + unit-sheet-panel + the SAME unit id", () => {
  assert.match(core, /function unitSheetStillOpen\(id\)[\s\S]*?unit-sheet-panel[\s\S]*?selectedUnitData\?\.unit\?\.id\) === id/);
});
check("a modest cadence (a few seconds), not a busy loop", () => {
  const m = core.match(/UNIT_SHEET_REFRESH_MS = (\d+)/);
  assert.ok(m, "refresh interval constant present");
  const ms = Number(m[1]);
  assert.ok(ms >= 2000 && ms <= 6000, `refresh cadence ${ms}ms is within a few seconds`);
});

console.log("# B136 non-disruption guarantees");
check("a refresh is skipped while a nickname edit is in progress", () => {
  assert.match(core, /function unitSheetInteractionBusy\(\)[\s\S]*?data-unit-nickname-editor/);
  assert.match(core, /if \(unitSheetInteractionBusy\(\)\) return;/);
});
check("scroll position is captured before and restored after the re-render", () => {
  assert.match(core, /const scroll = captureUnitSheetScroll\(\);\s*selectedUnitData = data;\s*renderUnitSheet\(\);\s*restoreUnitSheetScroll\(scroll\);/);
});
check("post-await re-guard: closed/switched/editor-opened during the fetch aborts the apply", () => {
  assert.match(core, /if \(unitSheetRefreshId < 0 \|\| !unitSheetStillOpen\(unitSheetRefreshId\) \|\|\s*Number\(data\?\.unit\?\.id\) !== unitSheetRefreshId \|\| unitSheetInteractionBusy\(\)\)\s*return;/);
});
check("a transient fetch failure leaves the current view in place (no blank-out)", () => {
  // !r.ok returns without touching selectedUnitData/render.
  assert.match(core, /if \(!r\.ok\) return;/);
});
check("overlapping ticks are prevented by a busy latch", () => {
  assert.match(core, /if \(unitSheetRefreshId < 0 \|\| unitSheetRefreshBusy\) return;/);
  assert.match(core, /unitSheetRefreshBusy = true;[\s\S]*?finally \{\s*unitSheetRefreshBusy = false;/);
});

// Logic model of one tick's "apply this refresh?" decision (mirrors the core guards), with a
// seeded-bad implementation that skips the guards -- the seeded case MUST diverge (test-the-test).
console.log("# B136 refresh-decision model (+ seeded-bad)");
function shouldApply({ open, busy, ok, sameUnit, editor }) {
  if (busy) return false;
  if (!open) return false;
  if (editor) return false;
  if (!ok) return false;
  if (!sameUnit) return false;
  return true;
}
const base = { open: true, busy: false, ok: true, sameUnit: true, editor: false };
check("applies only when open, idle, ok, same unit, and no editor", () => {
  assert.equal(shouldApply(base), true);
  assert.equal(shouldApply({ ...base, open: false }), false, "closed sheet never refreshes");
  assert.equal(shouldApply({ ...base, editor: true }), false, "an open editor is never clobbered");
  assert.equal(shouldApply({ ...base, ok: false }), false, "a failed fetch is a no-op");
  assert.equal(shouldApply({ ...base, sameUnit: false }), false, "a stale response for another unit is dropped");
  assert.equal(shouldApply({ ...base, busy: true }), false, "overlapping ticks are dropped");
});
check("test-the-test: a guard-less refresh would wrongly clobber an open editor", () => {
  const seededBad = () => true;   // ignores every guard
  assert.notEqual(seededBad(), shouldApply({ ...base, editor: true }),
    "seeded-bad refresh does not discriminate the editor-open case");
});

// ---------------------------------------------------------------------------------------------
// B176 -- assigned room row is click-to-view via the EXISTING flows (no duplication).
// ---------------------------------------------------------------------------------------------
console.log("# B176 room click reuses camera + zone opener");
check("openUnitRoom reuses setCameraToMapPos + flashMapTile for the camera jump", () => {
  assert.match(core, /async function openUnitRoom\(buildingId, pos\)[\s\S]*?setCameraToMapPos\(pos\)[\s\S]*?flashMapTile\(pos\)/);
});
check("openUnitRoom opens the zone panel through the shared openInfoPlace opener", () => {
  assert.match(core, /openInfoPlace\("zone", buildingId\)/);
});
check("openUnitRoom tears down the sheet's own follow + refresh timers before the zone panel replaces it", () => {
  assert.match(core, /async function openUnitRoom\(buildingId, pos\)\s*\{\s*stopUnitFollow\(\);\s*stopUnitSheetRefresh\(\);/);
});
check("the camera jump is fail-open: a missing room center still opens the zone panel", () => {
  // pos-guarded camera jump; openInfoPlace runs regardless of pos.
  assert.match(core, /if \(pos && Number\.isFinite\(pos\.x\)[\s\S]*?setCameraToMapPos/);
  const openIdx = core.indexOf('openInfoPlace("zone", buildingId)');
  const guardIdx = core.indexOf("if (pos && Number.isFinite(pos.x)");
  assert.ok(openIdx > guardIdx, "the zone-open is outside the pos guard (still runs without a center)");
});
check("the row + zoom button dispatch to openUnitRoom with the buildingId and optional center", () => {
  assert.match(core, /data-unit-room-open[\s\S]*?openUnitRoom\(bid, Number\.isFinite\(pos\.x\) \? pos : null\)/);
});
check("test-the-test: openUnitRoom must NOT call centerAndFlashMapPos (it closes the sheet, killing the zone open)", () => {
  const body = core.slice(core.indexOf("async function openUnitRoom"), core.indexOf("async function openUnitRoom") + 700);
  assert.doesNotMatch(body, /centerAndFlashMapPos/,
    "centerAndFlashMapPos closes #selection, so using it would race the zone panel open shut");
});

console.log(`\nunitsheet-live: ${passed} passed`);
