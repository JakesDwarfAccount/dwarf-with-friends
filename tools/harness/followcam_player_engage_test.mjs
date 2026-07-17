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
// B60 -- follow-player camera is unreliable to engage ("click it a bunch to work").
// Root cause: the lobby feeds render() at ~30 Hz and every render replaces the panel's
// innerHTML, detaching the Follow button between the user's pointerdown and pointerup. A native
// "click" only fires when both land on the same STILL-ATTACHED element, so a re-render mid-click
// swallows the click and follow never engages. Fix: bind the follow/jump action to pointerdown,
// which is dispatched synchronously at press before any async re-render can detach the target.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// --- Model of the browser's click-dispatch rule (born-red for the OLD click binding) ----------
// A physical click = pointerdown (at press) then pointerup/click (at release). The "click" event
// is dispatched ONLY if the element pressed is still in the tree at release. A 30 Hz re-render
// that replaces innerHTML between press and release detaches the pressed button -> no click.
function simulatePhysicalClick({ bindPhase, rerenderMidClick }) {
  let delivered = false;
  let pressedButton = { id: "btn-A", attached: true };
  const fire = (phase, target) => {
    if (phase === bindPhase && target && target.attached) delivered = true;
  };
  // press
  fire("pointerdown", pressedButton);
  // a roster tick lands mid-click and re-renders the panel, detaching the pressed button
  if (rerenderMidClick) {
    pressedButton.attached = false;      // old node removed by innerHTML replace
    pressedButton = { id: "btn-B", attached: true }; // fresh node now under the cursor
  }
  // release: the click event only reaches a handler if the ORIGINALLY pressed node survived
  const clickTarget = rerenderMidClick ? null : pressedButton; // detached press => no click event
  fire("click", clickTarget);
  return delivered;
}

// The bug: click-bound handler is swallowed exactly when a re-render straddles the click.
assert.equal(simulatePhysicalClick({ bindPhase: "click", rerenderMidClick: true }), false,
  "BORN-RED: click-bound follow is swallowed by a mid-click re-render (the reported bug)");
assert.equal(simulatePhysicalClick({ bindPhase: "click", rerenderMidClick: false }), true,
  "click-bound follow only works when no re-render straddles the click (intermittent)");
// The fix: pointerdown is delivered at press, before any re-render can detach the target.
assert.equal(simulatePhysicalClick({ bindPhase: "pointerdown", rerenderMidClick: true }), true,
  "pointerdown-bound follow engages on ONE press even when a re-render lands mid-click");
assert.equal(simulatePhysicalClick({ bindPhase: "pointerdown", rerenderMidClick: false }), true,
  "pointerdown-bound follow engages on ONE press with no re-render");

// --- The real lobby must adopt the pointerdown binding ----------------------------------------
const lobby = readFileSync("web/js/dwf-lobby.js", "utf8");

// The panel action handler is bound on pointerdown, and the follow toggle is invoked from it.
assert.match(lobby, /panel\.addEventListener\("pointerdown",\s*event\s*=>/,
  "lobby binds the panel follow/jump action on pointerdown");
assert.match(lobby, /spectate\.toggleFollow\(/, "lobby still calls DwfSpectate.toggleFollow");

// Guard against a double-toggle regression: the follow action must NOT also be bound on click
// (pointerdown + click on one physical press would toggle twice and net back to off). There must
// be no panel-level click listener at all now.
assert.doesNotMatch(lobby, /panel\.addEventListener\("click"/,
  "no panel click listener remains (pointerdown is the sole action binding)");
// toggleFollow appears exactly once (the pointerdown path), not duplicated into a click path.
const toggleCalls = (lobby.match(/spectate\.toggleFollow\(/g) || []).length;
assert.equal(toggleCalls, 1, "toggleFollow is invoked from exactly one code path");

// Primary-button guard so right/middle pointerdown does not toggle follow.
assert.match(lobby, /event\.button\s*!==\s*0/, "pointerdown action is gated to the primary button");

// Preserve the seams other suites depend on (spectate_client_test).
assert.match(lobby, /data-lobby-follow/, "lobby still renders the follow control");
assert.match(lobby, /jumpToPlayer/, "lobby row action still calls jumpToPlayer");

console.log("followcam_player_engage_test: PASS");
