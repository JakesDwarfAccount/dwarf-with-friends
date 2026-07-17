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

// B294: offline, rendered-path coverage for every profession-coloured unit-name surface wired by
// the color-parity wave. This deliberately asserts the resulting dfColor value in production HTML,
// then separately pins the C++/Lua source-to-wire fields for the async-only burrow transport.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("  ok - " + label); }
  catch (e) { failed++; console.log("  FAIL - " + label + "\n      " + e.message); }
}

globalThis.escapeHtml = value => String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[ch]));
globalThis.dfTokenMatch = (haystack, needle) => String(haystack).toLowerCase().includes(String(needle).toLowerCase());
globalThis.unitPortraitMarkup = unit => `<span data-test-portrait="${Number(unit?.id ?? unit?.unitId ?? -1)}"></span>`;
globalThis.infoTabRowHtml = () => "";
globalThis.infoSearchBoxHtml = () => "";
globalThis.fortUnitRef = (id, name) => `<span data-unit-id="${Number(id)}">${escapeHtml(name)}</span>`;
globalThis.fortPrettyKey = value => String(value || "");

const DWFUI = require("../../web/js/dwf-ui-components.js");
globalThis.DWFUI = DWFUI;

const Info = require("../../web/js/dwf-build-info-panels.js");
const Labor = require("../../web/js/dwf-labor-work-orders.js");
const Admin = require("../../web/js/dwf-fort-admin.js");
const Squads = require("../../web/js/dwf-squads.js");
const Hospital = require("../../web/js/dwf-hospital-panel.js");
const Location = require("../../web/js/dwf-location-panel.js");
const Building = require("../../web/js/dwf-building-zone-stockpile-panels.js");
globalThis.dfTextColor = report => DWFUI.dfColor(Number(report?.color) + (report?.bright ? 8 : 0));
const Combat = require("../../web/js/dwf-combatlog-panel.js");
const Diplo = require("../../web/js/dwf-diplo.js");

const color = i => `style="color:${DWFUI.dfColor(i)}"`;
const hasColor = (html, i) => assert.ok(String(html).includes(color(i)), `missing ${color(i)} in ${html}`);

check("Creatures Residents/Pets/Other/Dead row name renders professionColor", () => {
  for (const detail of ["residents", "pets", "other", "dead"]) {
    const html = Info.creatureRowsMarkup([{ unitId: 1, name: `Unit-${detail}`,
      profession: "Planter", professionColor: 9 }], { detail });
    hasColor(html, 9);
  }
});

check("Tasks unit-name cell renders professionColor", () => {
  hasColor(Info.taskRowsHtml([{ unitId: 2, name: "Task worker", profession: "Bone Carver",
    professionColor: 6, job: "Carve bone" }]), 6);
});

check("Labor work-detail roster renders professionColor", () => {
  const html = Labor.laborPanelMarkup({ selected: 0,
    details: [{ index: 0, name: "Everybody", mode: 0 }],
    rows: [{ id: 3, name: "Laborer", professionColor: 11 }], tasks: [] });
  hasColor(html, 11);
});

check("Nobles holder and mandate owner render their profession colors", () => {
  const html = Admin.noblesBody({ positions: [{ name: "Manager", positionId: 1,
    assignmentId: 1, filled: true, unitId: 4, holder: "Noble", professionColor: 14 }],
    mandates: [{ type: "Mandate", by: "Mandater", byUnitId: 5, byProfessionColor: 13 }] });
  hasColor(html, 14);
  hasColor(html, 13);
});

check("Justice case parties, convict/guard identity, and victim render profession colors", () => {
  const caseHtml = Admin.justiceBody({ crimes: [{ id: 10, mode: "Theft", victim: "Victim",
    victimId: 6, victimProfessionColor: 12, accused: "Accused", accusedId: 7,
    accusedProfessionColor: 10 }] }, { mode: "open", selectedCase: 10, hostState: {} });
  hasColor(caseHtml, 12);
  hasColor(caseHtml, 10);
  const convict = { crimeId: 11, unitId: 8, name: "Convict", profession: "Miner",
    professionColor: 7, victim: "Other victim", victimId: 9, victimProfessionColor: 5,
    mode: "Theft", prisonTime: 1 };
  const convictHtml = Admin.justiceBody({ convicts: [convict] }, { mode: "convicts", selectedCase: 11 });
  hasColor(convictHtml, 7);
  hasColor(convictHtml, 5);
  hasColor(Admin.justiceBody({ guard: { members: [{ unitId: 10, name: "Guard",
    profession: "Axedwarf", professionColor: 4 }] } }, { mode: "guard" }), 4);
});

check("Squad positions, candidates, and uniform roster render professionColor", () => {
  const member = { idx: 1, filled: true, unitId: 11, name: "Soldier",
    positionName: "Militia", professionColor: 2 };
  hasColor(Squads.sqPositionRows([member]), 2);
  hasColor(Squads.sqCandidateRows([{ unitId: 12, name: "Recruit", professionColor: 3 }]), 3);
  hasColor(Squads.sqUniformAssignRows([member], []), 2);
});

check("Hospital chief, doctors, patients, and treatment names render professionColor", () => {
  const html = Hospital.hospitalPanelMarkup({ zoneName: "Hospital", patientsOpen: true,
    info: { ok: true, name: "Hospital", supplies: {}, furniture: {},
      chiefMedical: { found: true, filled: true, positionId: 1, name: "Chief", professionColor: 1 },
      doctors: [{ unitId: 13, name: "Doctor", professionColor: 2, labors: ["Diagnose"] }] },
    patients: { ok: true,
      patients: [{ unitId: 14, name: "Patient", professionColor: 3, flags: [] }],
      queue: [{ jobType: "Diagnose", worker: "Doctor", workerProfessionColor: 2,
        patient: "Patient", patientProfessionColor: 3 }] } });
  for (const i of [1, 2, 3]) hasColor(html, i);
});

check("Location occupation candidate renders professionColor", () => {
  hasColor(Location.locationCandidateNameHtml({ name: "Performer", professionColor: 8 }), 8);
});

check("Location holder, renter, and appointed-position names render professionColor", () => {
  const html = Location.locationPanelMarkup({ data: { name: "Tavern", label: "Tavern", zones: [],
    occupations: [{ id: 1, typeKey: "PERFORMER", label: "Performer", assigned: true,
      holder: "Musician", unitId: 21, professionColor: 11 }],
    rooms: { canWrite: false, rooms: [{ id: 1, label: "Room", rented: true,
      renter: "Guest", renterProfessionColor: 6, owed: 2 }] },
    positions: [{ positionId: 1, name: "Priest", holder: "Cleric", professionColor: 13 }] } });
  for (const i of [11, 6, 13]) hasColor(html, i);
});

check("Room/zone owner chooser renders professionColor", () => {
  hasColor(Building.zoneOwnersPanelMarkup({ type: "Bedroom", owners: [{ id: 15,
    name: "Owner", profession: "Carpenter", professionColor: 14 }] }), 14);
});

check("Pasture/pit/pond and cage unit choosers render professionColor", () => {
  const unit = { id: 151, kind: "unit", name: "Stray yak", race: "Yak",
    professionColor: 10, flags: [] };
  hasColor(Building.zoneAnimalsPanelMarkup({ type: "PenPasture", units: [unit] }), 10);
  hasColor(Building.buildingCagePanelMarkup({ name: "Cage", units: [unit] }), 10);
});

check("Workshop permitted-worker chooser renders professionColor", () => {
  hasColor(Building.wsWorkerRowsHtml([{ id: 16, name: "Worker", professionColor: 6 }]), 6);
});

check("Burrow assignment transport and renderer both carry professionColor", () => {
  const cpp = readFileSync(new URL("../../src/burrows_panel.cpp", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../src/info_panel.cpp", import.meta.url), "utf8");
  const client = readFileSync(new URL("../../web/js/dwf-controls-placement.js", import.meta.url), "utf8");
  assert.match(cpp, /professionColor/);
  assert.match(cpp, /getProfessionColor\(unit\)/);
  assert.match(panel, /profession_color\s*=\s*Units::getProfessionColor\(unit\)/);
  assert.match(client, /professionColor[\s\S]{0,240}DWFUI\.dfColor\(professionColor\)/);
});

check("combat list and detail report colors survive to rendered text", () => {
  const list = Combat.clListRowsHtml([{ unitId: 1, label: "The dog is fighting!",
    reports: [{ color: 6, bright: true }] }]);
  const detail = Combat.clDetailRowsHtml([{ text: "The dog bites!", color: 2, bright: true }]);
  hasColor(list, 14);
  hasColor(detail, 10);
  const source = readFileSync(new URL("../../web/js/dwf-combatlog-panel.js", import.meta.url), "utf8");
  assert.match(source, /\.cl-list \.cl-text\{color:inherit/);
});

check("diplomacy word-stream RGB reaches the rendered word exactly", () => {
  const html = Diplo.wordLinesHtml([{ t: "Welcome", c: "#123abc" }]);
  assert.match(html, /style="color:#123abc">Welcome/);
});

check("tooltip hotkey uses the live DF palette and unknown help-link hues inherit", () => {
  const css = readFileSync(new URL("../../web/css/dwf.css", import.meta.url), "utf8");
  const tooltip = readFileSync(new URL("../../web/js/dwf-tooltip.js", import.meta.url), "utf8");
  assert.match(css, /\.df-tt-hotkey \{ color: var\(--df-c10, #55ff55\)/);
  assert.match(tooltip, /class="df-help-kw" style="color:inherit"/);
});

check("composed combat alert rows no longer invent orange", () => {
  const source = readFileSync(new URL("../../web/js/dwf-unit-hud-notifications.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /color:\s*"#ff8d1d"/);
});

check("no English keyword/category color guesses remain on audited list surfaces", () => {
  const info = readFileSync(new URL("../../web/js/dwf-build-info-panels.js", import.meta.url), "utf8");
  const labor = readFileSync(new URL("../../web/js/dwf-labor-work-orders.js", import.meta.url), "utf8");
  assert.doesNotMatch(info, /CREATURE_NAME_COLOR_KW|creatureNameColor/);
  assert.doesNotMatch(labor, /LABOR_CATEGORY_COLOR_KEY/);
});

console.log(`\n${failed ? "FAIL" : "PASS"} color_surface_parity_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
