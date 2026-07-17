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
// SPDX-License-Identifier: AGPL-3.0-only
//
// UIPOLISH2 wave: B117 (zone title = type + zone repaint), B120 (unit-sheet nickname de-dupe),
// WT18 (top-bar layout at UI scale). Pure client logic is replicated + exercised here (with a
// test-the-test seeded on each pre-fix behavior); source ties keep the shipped files honest.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = relative => readFileSync(join(root, relative), "utf8");

const zonePanels = read("web/js/dwf-building-zone-stockpile-panels.js");
const controls = read("web/js/dwf-controls-placement.js");
const notifications = read("web/js/dwf-unit-hud-notifications.js");
const css = read("web/css/dwf.css");
const buildingZone = read("src/building_zone.cpp");

// ---------------------------------------------------------------------------
// B120 -- unit-sheet nickname de-duplication (mirrors dwf-unit-hud-notifications.js)
// ---------------------------------------------------------------------------
function stripEmbeddedNickname(name) {
  const s = String(name || "");
  const out = s.replace(/'[^']*'/, "").replace(/\s{2,}/g, " ").replace(/^\s*,\s*/, "").trim();
  return out || s;
}
function unitNameLine(unit) {
  const name = String((unit && unit.name) || "");
  return (unit && unit.nickname) ? stripEmbeddedNickname(name) : name;
}

// The reported case: readable name embeds a STALE nickname ('Thintownsss') while the live
// nickname line reads "Thintowns". After the fix line 1 carries no nickname; line 2 is the only,
// live one -- no duplicate, no disagreement.
const reported = { name: "'Thintownsss' Elisamost, Weaponsmith", nickname: "Thintowns" };
assert.equal(unitNameLine(reported), "Elisamost, Weaponsmith",
  "B120: embedded (stale) nickname token dropped from the name line, title kept");
assert.ok(!unitNameLine(reported).includes("'"),
  "B120: no single-quoted nickname token survives on the name line");
assert.ok(!unitNameLine(reported).includes("Thintownsss"),
  "B120: the stale nickname string is gone from the name line");

// Never-nicknamed unit: nothing to strip, name is untouched.
assert.equal(unitNameLine({ name: "Urist Elisamost, Weaponsmith", nickname: "" }),
  "Urist Elisamost, Weaponsmith", "B120: a unit without a nickname keeps its full name");

// A nickname that only exists embedded (e.g. a legends nickname, no fort nickname -> empty
// nickname line) must NOT be stripped away -- there is no line-2 to defer to.
assert.equal(unitNameLine({ name: "'Legend' Bob", nickname: "" }), "'Legend' Bob",
  "B120: sole (embedded-only) nickname is preserved when there is no live nickname line");

// Test-the-test: the OLD render (unit.name verbatim) reproduces the reported double display.
const oldLine1 = reported.name;
assert.ok(oldLine1.includes("Thintownsss") && reported.nickname === "Thintowns",
  "B120 seed: pre-fix name line duplicated the nickname and disagreed with the live one");

// ---------------------------------------------------------------------------
// B117 -- zone title uses the zone TYPE when the name is DFHack's generic auto name
// (mirrors dwf-building-zone-stockpile-panels.js)
// ---------------------------------------------------------------------------
function zoneIsAutoNamed(name) {
  return !name || /^activity zone\b/i.test(String(name).trim());
}
function zoneDisplayName(name, typeLabel) {
  return zoneIsAutoNamed(name) ? typeLabel : name;
}
function zoneTitle(info, typeLabel) { return zoneDisplayName(info.name, typeLabel); }
function zoneStatus(info, typeLabel) {
  const auto = zoneIsAutoNamed(info.name);
  const assigned = info.assignedUnits ? `${info.assignedUnits} assigned` : "";
  return auto ? assigned : `${typeLabel}${assigned ? ` · ${assigned}` : ""}`;
}

// Reported case: an Office zone served as "Activity Zone #3" -> show "Office".
assert.equal(zoneTitle({ name: "Activity Zone #3" }, "Office"), "Office",
  "B117: generic 'Activity Zone #N' title is replaced by the zone type");
assert.equal(zoneStatus({ name: "Activity Zone #3", assignedUnits: 0 }, "Office"), "",
  "B117: type is not repeated in the status line when it is already the title");
assert.equal(zoneStatus({ name: "Activity Zone #3", assignedUnits: 2 }, "Office"), "2 assigned",
  "B117: auto-named zone status shows just the assigned count");

for (const generic of ["Activity Zone", "activity zone #12", "  Activity Zone #7  ", ""]) {
  assert.equal(zoneTitle({ name: generic }, "Bedroom"), "Bedroom",
    `B117: '${generic}' is treated as auto-generated`);
}

// A zone the player actually renamed keeps its custom name, and the status still carries the type.
assert.equal(zoneTitle({ name: "War Room" }, "Office"), "War Room",
  "B117: a custom zone name is preserved as the title");
assert.equal(zoneStatus({ name: "War Room", assignedUnits: 1 }, "Office"), "Office · 1 assigned",
  "B117: custom-named zone status carries the type + assigned count");

// Test-the-test: the OLD title (`info.name || typeLabel`) leaked the generic name.
assert.equal(("Activity Zone #3" || "Office"), "Activity Zone #3",
  "B117 seed: pre-fix title fell through to the useless generic name");

// ---------------------------------------------------------------------------
// Source ties -- the shipped files must actually contain the fixes above.
// ---------------------------------------------------------------------------

// B120 client
assert.match(notifications, /function stripEmbeddedNickname\(name\)[\s\S]*?replace\(\/'\[\^'\]\*'\//,
  "B120: stripEmbeddedNickname removes the single-quoted nickname token");
assert.match(notifications, /function unitNameLine\(unit\)[\s\S]*?unit\.nickname\) \? stripEmbeddedNickname/,
  "B120: unitNameLine only strips when a live nickname line exists");
// B159 added a profession color hook; B294 moved it from a class to an inline DF-palette style
// (unitNameColorStyle -> dfColor(professionColor)). The B120 tie is unitNameLine itself.
assert.match(notifications, /class="unit-name-line"\$\{unitNameColorStyle\(unit\)\}>\$\{escapeHtml\(unitNameLine\(unit\)/,
  "B120: the unit-sheet name line renders through unitNameLine (B294: with the DF profession color style)");
assert.match(notifications, /function unitNameColorStyle\(unit\)[\s\S]{0,300}?professionColor[\s\S]{0,300}?dfColor/,
  "B294: unitNameColorStyle resolves the served professionColor through DWFUI.dfColor (guarded)");

// B117 client -- title/status + repaint button
assert.match(zonePanels, /function zoneIsAutoNamed\(name\)[\s\S]*?\^activity zone\\b/i,
  "B117: zoneIsAutoNamed matches DFHack's generic civzone name");
assert.match(zonePanels, /function zoneDisplayName\(name, typeLabel\)/,
  "B117: zoneDisplayName helper present");
// All three zone sub-panel headers (animals / owners / locations) still render their title through
// zoneDisplayName. The DWFUI native-parity reconstruction routed the animals header through
// DWFUI.headerHtml, which reads `data?.name` (optional-chained), while owners/locations pass
// `data.name`; the zone-parity wave then migrated owners/locations to DWFUI.headerHtml too. The count
// is what the B117 invariant guards -- match either spelling so the assertion tracks the contract
// (three headers) rather than one literal argument form.
assert.equal((zonePanels.match(/zoneDisplayName\(data\??\.name, typeLabel\)/g) || []).length, 3,
  "B117: all three zone sub-panel headers use zoneDisplayName");
assert.match(zonePanels, /const headTitle = autoNamed \? typeLabel : info\.name;/,
  "B117: main zone panel title prefers the type when auto-named");
assert.match(zonePanels, /data-zone-repaint[\s\S]*?window\.DFZoneRepaint[\s\S]*?\.arm\(info\.id,/,
  "B117: the zone panel has a Repaint button that arms zone repaint for this zone");

// B117 client -- placement plumbing (parity with the stockpile repaint arm)
assert.match(controls, /let zoneRepaintId = null;/, "B117: zoneRepaintId state exists");
assert.match(controls, /function setZoneRepaint\(id, meta\)[\s\S]*?zoneRepaintId = id;/,
  "B117: setZoneRepaint arms the id");
assert.match(controls, /window\.DFZoneRepaint = \{[\s\S]*?arm: setZoneRepaint/,
  "B117: the arm hook is exposed for the zone panel");
assert.match(controls, /async function commitZoneRepaintDraft[\s\S]*?\/zone-repaint\?[\s\S]*?mode=replace[\s\S]*?body: shape\.extents/,
  "B117: Accept commits one exact staged extent bitmap");
assert.match(controls, /else if \(zoneRepaintId != null && !zoneRemoveArmed\) \{\s*stageZoneRepaintDrag\(downX, downY/,
  "B117: pointerup stages the armed zone repaint without mutating immediately");
assert.match(controls, /if \(zoneMode === "repaint"\) await acceptZoneRepaint\(\)/,
  "B117: the native Accept plaque owns the repaint commit");

// B117 server -- the extend route the client relies on genuinely exists. B212 split the route
// monolith into per-domain modules, so the /zone-repaint registration now lives beside its handler
// in building_zone.cpp (was http_server.cpp's register_routes()).
assert.match(buildingZone, /server\.Post\("\/zone-repaint", zone_repaint_handler\)/,
  "B117: POST /zone-repaint is served (registered in building_zone.cpp since B212)");
assert.match(buildingZone, /mode != "add" && mode != "extend" && mode != "erase" && mode != "replace"/,
  "B117: plan_zone_repaint supports exact add/erase/replace modes and rejects unknown input");

// WT18 -- top-bar layout tightening + bigger control icons
assert.match(css, /#topbar\s*\{[\s\S]*?gap: 6px 12px;/,
  "WT18: #topbar uses tightened row/column gaps");
assert.match(css, /\.stock-counts \{ display: flex; gap: 10px; \}/,
  "WT18: stock-counts spacing tightened");
assert.match(css, /\.square-button \{[\s\S]*?width: 26px;[\s\S]*?height: 26px;/,
  "WT18: control icons nudged larger");

console.log("uipolish2_test: PASS");
