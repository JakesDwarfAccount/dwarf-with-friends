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

globalThis.window = { setTimeout, addEventListener() {} };
globalThis.fetch = async () => ({ ok: false });
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.unitImagesEnabled = true;
// The profile body is a DWFUI grid now (the composition rule: the GRID owns the dividers, a cell
// draws nothing), so the renderers need the shared layer in scope exactly as the live client does.
globalThis.DWFUI = (await import("../../web/js/dwf-ui-components.js")).default;
globalThis.window.DWFUI = globalThis.DWFUI;

const { renderUnitTabBody, renderUnitLaborPanel } =
  await import("../../web/js/dwf-unit-hud-notifications.js");

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("PASS " + label); }
  catch (error) { console.log("FAIL " + label); throw error; }
}

function checkPlain(tab, detail, field, text) {
  const unit = { [field]: [text] };
  const html = renderUnitTabBody(unit, tab, detail);
  assert.match(html, /unit-list-grid-unboxed/);
  assert.match(html, /unit-list-row-unboxed/);
  assert.equal((html.match(new RegExp(text, "g")) || []).length, 1);
  assert.doesNotMatch(html, /condition/);
}

console.log("# native empty-state wording and chrome");
check("Health Status is one plain 'No health problems' line", () =>
  checkPlain("Health", "Status", "healthStatusLines", "No health problems"));
check("Health Wounds wording is exact and unboxed", () =>
  checkPlain("Health", "Wounds", "healthWoundLines", "No evaluated wounds"));
check("Health Treatment wording is exact and unboxed", () =>
  checkPlain("Health", "Treatment", "healthTreatmentLines", "No treatment scheduled"));
check("Health History wording is exact and unboxed", () =>
  checkPlain("Health", "History", "healthHistoryLines", "No medical history"));
check("Military Squad keeps its text but removes the generic row box", () =>
  checkPlain("Military", "Squad", "militarySquadLines", "No squad assigned"));

const unit = {
  id: 42,
  laborWorkshopLines: ["No dedicated workshop assignments"],
  laborLocationLines: ["No location assignments"],
  laborWorkAnimalLines: ["No assigned or assignable work animals"]
};
const labor = { details: [], rows: [{ id: 42, specialist: false, assignedTo: "" }] };
for (const [detail, wording] of [
  ["Workshops", "No dedicated workshop assignments"],
  ["Locations", "No location assignments"],
  ["Work animals", "No assigned or assignable work animals"]
]) {
  check(`Labor ${detail} keeps the specialist header and exact unboxed empty state`, () => {
    const html = renderUnitLaborPanel(unit, detail, labor);
    assert.match(html, /unit-wd-header/);
    assert.match(html, /Will do available tasks anywhere/);
    assert.match(html, /unit-list-grid-unboxed/);
    assert.match(html, new RegExp(wording));
  });
}

console.log("# server display-string source guards");
const cpp = readFileSync(new URL("../../src/unit_sheet.cpp", import.meta.url), "utf8");
for (const wording of [
  "No health problems", "No evaluated wounds", "No treatment scheduled", "No medical history",
  "No dedicated workshop assignments", "No location assignments",
  "No assigned or assignable work animals", "No squad assigned"
]) {
  check(`server emits '${wording}'`, () => assert.ok(cpp.includes(`\"${wording}\"`)));
}
check("Status filters attribute-derived rows before choosing the healthy empty state", () => {
  assert.match(cpp, /attribute_rows[\s\S]*?\"Disease-prone\", \"Recovers quickly\"/);
  assert.match(cpp, /unit->body\.wounds\.empty\(\) && actual_conditions\.empty\(\)/);
});

console.log(`\ncharprofile wording: ${passed} passed`);
