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
// B279: jobs and activities are separate DF concepts. This fixture pins both halves of the
// contract: the server must ask DF's activity_event vmethod for the per-unit native label, and the
// real residents/unit-sheet renderers must carry that served label all the way to visible markup.
// A mapping-table-only implementation cannot satisfy the getName() contract, and a dead server
// field cannot satisfy the production-renderer checks.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);

const activityHeaderPath = join(root, "src", "unit_activity.h");
const infoCppPath = join(root, "src", "info_panel.cpp");
const sheetCppPath = join(root, "src", "unit_sheet.cpp");
const activityHeader = existsSync(activityHeaderPath) ? readFileSync(activityHeaderPath, "utf8") : "";
const infoCpp = readFileSync(infoCppPath, "utf8");
const sheetCpp = readFileSync(sheetCppPath, "utf8");

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.fetch = async () => ({ ok: false });
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.unitImagesEnabled = true;
globalThis.DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
globalThis.window.DWFUI = globalThis.DWFUI;
globalThis.escapeHtml = s => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
globalThis.dfTokenMatch = (hay, needle) => String(hay || "").toLowerCase().includes(String(needle || "").toLowerCase());
globalThis.unitPortraitMarkup = (row, cls) => `<span class="${cls}" data-stub-portrait="${row.unitId}"></span>`;
globalThis.infoRowPos = () => null;
globalThis.rowTone = () => "";
globalThis.creatureNameColor = () => "";

const infoPanel = require(join(root, "web", "js", "dwf-build-info-panels.js"));
const unitProfile = await import("../../web/js/dwf-unit-hud-notifications.js");

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("PASS " + label); }
  catch (error) { console.log("FAIL " + label); throw error; }
}

console.log("# server activity model");
check("one shared activity helper exists for every current-task surface", () => {
  assert.ok(activityHeader, "src/unit_activity.h is missing");
  assert.match(infoCpp, /#include "unit_activity\.h"/);
  assert.match(sheetCpp, /#include "unit_activity\.h"/);
});
check("DF, not a local lookup table, composes the exact per-unit activity label", () => {
  assert.match(activityHeader, /event->getName\(unit->id, &name\)/);
  // B296-r3 narrowed this pin: the enum switch inside activity_task_color_bucket() picks a COLOR
  // bucket only (labels still come exclusively from getName). Forbid enum switches anywhere ELSE
  // in the header, and forbid the bucket switch from ever producing a string.
  const bucketFn = activityHeader.match(
    /inline UnitTaskColorBucket activity_task_color_bucket[\s\S]*?\n\}/);
  assert.ok(bucketFn, "activity_task_color_bucket must exist (B296-r3 source-bucket colors)");
  assert.doesNotMatch(bucketFn[0], /"|std::string/,
    "the color-bucket switch must never produce label text");
  const outsideBucket = activityHeader.replace(bucketFn[0], "");
  assert.doesNotMatch(outsideBucket, /case\s+df::activity_(?:entry|event)_type::/,
    "a label-side enum switch would turn this systemic fix back into a label table");
});
check("all live unit-owned activity links are considered; ignored activities stay ignored", () => {
  assert.match(activityHeader, /Units::getMainSocialEvent\(unit\)/,
    "social_activities must flow through DFHack's canonical helper");
  for (const field of ["individual_drills", "conversations", "activities"])
    assert.ok(activityHeader.includes(field), `missing unit.${field}`);
  assert.doesNotMatch(activityHeader, /unit->ignored_activities/);
});
check("residents and unit sheets both consume the shared task label", () => {
  // B292-r2: the resolver gained the per-pass world-activity index parameter.
  // B296-r3: info_panel consumes the struct form (label + colour bucket) of the same resolver.
  assert.match(infoCpp, /unit_current_task\(unit, &world_activities\)/);
  assert.match(infoCpp, /row\.status = row\.job;/,
    "the residents response must actually serve the computed label in its visible status field");
  assert.match(sheetCpp, /unit_current_task_name\(unit, &world_activities\)/);
  assert.match(sheetCpp, /sheet\.current_job = unit_current_job_label\(unit, world_activities\);/,
    "the unit response must actually serve the computed label as currentJob");
});

console.log("# the served field is the field the client reads (no silent drop)");
// B277's lesson: every fixture called the resolver BELOW the layer that dropped the field, so a
// dead feature stayed green. These cells walk the actual wire keys on BOTH sides of the socket, so
// renaming/omitting the field on either end fails here even though the renderers still "work".
check("residents: C++ serves the label in a key the residents renderer actually reads", () => {
  assert.match(infoCpp, /\\"job\\":" << json_string\(row\.job\)/,
    "info rows must serialize row.job");
  assert.match(infoCpp, /row\.status = row\.job;/,
    "the residents branch must move the computed label into the visible status field");
  const src = readFileSync(join(root, "web", "js", "dwf-build-info-panels.js"), "utf8");
  assert.match(src, /function residentJobText\(row\)[\s\S]{0,300}?row\?\.status \|\| row\?\.job/,
    "the Residents label helper must still read the served status/job field");
  assert.match(src, /const jobText = isResidents \? residentJobText\(row\)/,
    "creatureRowsMarkup must route Residents through the served-label helper");
});
check("unit sheet: C++ serves currentJob and the sheet header still reads unit.currentJob", () => {
  assert.match(sheetCpp, /\\"currentJob\\":" << json_string\(unit\.current_job\)/,
    "the unit response must serialize current_job as currentJob");
  assert.match(sheetCpp, /sheet\.current_job = unit_current_job_label\(unit, world_activities\);/);
  const src = readFileSync(join(root, "web", "js", "dwf-unit-hud-notifications.js"), "utf8");
  assert.match(src, /unit && unit\.currentJob/, "unitActivityLine must read unit.currentJob");
  assert.match(src, /unitActivityLine\(unit\)/, "the sheet header must call unitActivityLine");
});
check("the idle-only mapping never swallows a real activity label", () => {
  // B159's client-side "No job" -> "No activity" rewrite must pass activities through untouched,
  // including DF's trailing '!' state punctuation.
  for (const label of ["Worship!", "Socialize", "Play Make Believe", "Individual Combat Drill",
                       "Pray to Armok", "Go to Sparring Match"]) {
    const html = unitProfile.unitSheetMarkup({ unit: { id: 9, name: "X", currentJob: label } },
                                             { tab: "Overview" });
    assert.ok(html.includes(`class="unit-job-line">${label}<`), `sheet dropped/rewrote "${label}"`);
  }
});

console.log("# labels reach the production renderers");
// The exact wire shape info_panel.cpp emits for the residents detail: label in `status`, `job`
// cleared (build_creatures_panel's residents branch).
const residentsWire = JSON.parse(JSON.stringify([
  { unitId: 1, name: "Vabok", profession: "Miner", status: "Worship!", job: "" },
  { unitId: 2, name: "Lor", profession: "manager", status: "Socialize", job: "" },
  { unitId: 3, name: "Edem", profession: "Dwarven Child", status: "Play Make Believe", job: "" },
]));
const residentsHtml = infoPanel.creatureRowsMarkup(residentsWire, { detail: "residents" });
check("residents render the served activity words and punctuation, not No job", () => {
  for (const label of ["Worship!", "Socialize", "Play Make Believe"])
    assert.match(residentsHtml, new RegExp(`data-dwfui-bitmap-text="${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.doesNotMatch(residentsHtml, />No job</);
});

const sheetWire = JSON.parse(JSON.stringify({
  title: "Rith Dumatsheshek",
  unit: { id: 3, name: "Rith Dumatsheshek", profession: "Dwarven Child", currentJob: "Play" },
}));
const sheetHtml = unitProfile.unitSheetMarkup(sheetWire, { tab: "Overview" });
check("unit-sheet header renders the same served activity field", () => {
  assert.match(sheetHtml, /class="unit-job-line">Play<\/div>/);
  assert.doesNotMatch(sheetHtml, /class="unit-job-line">No activity<\/div>/);
});
check("test-the-test: the old idle wire is visibly different on both surfaces", () => {
  const oldResidents = infoPanel.creatureRowsMarkup([
    { unitId: 1, name: "Vabok", profession: "Miner", status: "No job" },
  ], { detail: "residents" });
  const oldSheet = unitProfile.unitSheetMarkup({ unit: { id: 3, name: "Rith", currentJob: "No job" } }, { tab: "Overview" });
  assert.match(oldResidents, /data-dwfui-bitmap-text="No job"/);
  assert.match(oldSheet, /class="unit-job-line">No activity<\/div>/);
  assert.notEqual(oldResidents, residentsHtml);
  assert.notEqual(oldSheet, sheetHtml);
});

console.log(`b279-activity-task: ${passed} passed`);
