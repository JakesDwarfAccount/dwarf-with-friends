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

let failures = 0;
function check(label, ok) {
  if (ok) console.log("PASS " + label);
  else { failures++; console.log("FAIL " + label); }
}

const timers = [];
globalThis.window = {
  setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
  addEventListener() {}
};
globalThis.fetch = async () => ({ ok: false });
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.escapeHtml = value => String(value);
globalThis.unitImagesEnabled = true;
// B242: the squad surface builds its rows out of DWFUI plaques now (dwf-squads.js), and the
// live client always has DWFUI in scope (ui-components.js loads first and publishes the global).
// This bootstrap did not, so the squad-portrait section died with a ReferenceError -- a broken
// TEST, not a broken client. Give it the same global the browser has.
globalThis.DWFUI = (await import("../../web/js/dwf-ui-components.js")).default;
globalThis.window.DWFUI = globalThis.DWFUI;

const { unitPortraitMarkup } = await import("../../web/js/dwf-unit-hud-notifications.js");

console.log("# native portrait markup");
const ready = unitPortraitMarkup(
  { id: 42, name: "Urist", portraitTexpos: 17, sheetIconTexpos: 23 },
  "info-portrait-small"
);
check("positive portraitTexpos renders an image cell", ready.includes('class="native-portrait-img"'));
check("small identity surfaces reuse the profile bust rather than a separate icon/full-body sprite",
  ready.includes('/unit-portrait?id=42&amp;mode=portrait&amp;tex=17&amp;sheet=23&amp;try=0') &&
  !ready.includes('mode=icon') && !ready.includes('/unit-sprite/'));
const knownBadUrl = ready.replace('&amp;tex=17', '&amp;tex=99');
check("harness rejects a deliberately wrong sprite URL", !knownBadUrl.includes('/unit-portrait?id=42&amp;mode=portrait&amp;tex=17&amp;sheet=23&amp;try=0'));

const missing = unitPortraitMarkup(
  { id: 43, name: "Domas", portraitTexpos: 0, sheetIconTexpos: 9 },
  "info-portrait-small"
);
check("zero portraitTexpos keeps the letter fallback visible",
  missing.includes('portrait-glyph">D</div>') && !missing.includes("has-native-portrait"));
check("pending small portraits retry the same profile-bust route",
  missing.includes('/unit-portrait?id=43&amp;mode=portrait&amp;tex=0&amp;sheet=9&amp;try=0') &&
  !missing.includes('mode=icon'));
const unavailable = unitPortraitMarkup({ id: 44, name: "Kogan", portraitTexpos: -1 }, "info-portrait-small");
check("unavailable portraitTexpos is glyph-only", unavailable.includes('portrait-glyph">K</div>') && !unavailable.includes("native-portrait-img"));

console.log("# late bake");
const classes = new Set();
const box = {
  isConnected: true,
  classList: { add(x) { classes.add(x); }, remove(x) { classes.delete(x); } },
  setAttribute(name, value) { this[name] = value; },
  removeAttribute(name) { delete this[name]; }
};
const image = { parentElement: box, naturalWidth: 32, naturalHeight: 32 };
window.dfcPortraitLoad(image);
check("late image load swaps glyph to portrait", classes.has("has-native-portrait"));
const retryImage = {
  parentElement: box,
  isConnected: true,
  dataset: { unitId: "43", portraitSource: "native", srcBase: "/unit-portrait?id=43", portraitRetry: "0" },
  remove() { this.removed = true; }
};
window.dfcPortraitError(retryImage);
check("failed lazy portrait schedules spritefresh cadence", timers.length === 1 && timers[0].ms === 3000);
timers[0].fn();
check("scheduled retry keeps the existing portrait route", retryImage.src.startsWith("/unit-portrait?id=43&retry=1&_="));

const terminalClasses = new Set();
const terminalBox = {
  isConnected: true,
  classList: { add(x) { terminalClasses.add(x); }, remove(x) { terminalClasses.delete(x); } },
  setAttribute(name, value) { this[name] = value; }
};
const terminalImage = {
  parentElement: terminalBox,
  dataset: { unitId: "430", portraitSource: "native", srcBase: "/unit-portrait?id=430&mode=portrait&tex=0&sheet=1", portraitRetry: "0" },
  remove() { this.removed = true; }
};
const timersBeforeExhaustion = timers.length;
for (let i = 0; i < 4; i++) window.dfcPortraitError(terminalImage);
check("failed portrait stops after three retries",
  timers.length - timersBeforeExhaustion === 3 && terminalImage.removed === true);
check("exhausted portrait exposes a flagged glyph",
  terminalBox["data-df-identity-missing"] === "portrait:retry-exhausted");
const exhausted = unitPortraitMarkup(
  { id: 430, name: "Deler", portraitState: "pending", portraitKind: "native", portraitTexpos: 0, sheetIconTexpos: 1 },
  "info-portrait-small"
);
check("rerender does not restart an exhausted portrait request",
  !exhausted.includes("native-portrait-img") && exhausted.includes('data-df-identity-missing="portrait:retry-exhausted"'));
const recovered = unitPortraitMarkup(
  { id: 430, name: "Deler", portraitState: "ready", portraitKind: "native", portraitTexpos: 1, sheetIconTexpos: 1 },
  "info-portrait-small"
);
check("a changed portrait source can recover after exhaustion", recovered.includes("native-portrait-img"));

console.log("# squad portrait surface");
globalThis.unitPortraitMarkup = row => "[portrait " + (row.id ?? row.unitId) + ":" + row.portraitTexpos + "]";
const squads = await import("../../web/js/dwf-squads.js");
const member = { idx: 0, filled: true, unitId: 7, name: "Mistem", portraitTexpos: 5, positionName: "Leader" };
const candidate = { unitId: 8, name: "Vucar", profession: "Axedwarf", portraitTexpos: 0 };
check("squad position member renders portrait markup", squads.sqPositionRows([member]).includes("[portrait 7:5]"));
check("squad candidate renders portrait markup", squads.sqCandidateRows([candidate]).includes("[portrait 8:0]"));
check("squad uniform member renders portrait markup", squads.sqUniformAssignRows([member], []).includes("[portrait 7:5]"));

if (failures) process.exitCode = 1;
