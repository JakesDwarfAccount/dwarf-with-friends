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
// B296: direct A/B parity for Creatures -> Residents.
// Native oracle: evidence/oracles/creatures-list/RESIDENTS-NATIVE-20260715.png
// Ours oracle:   evidence/oracles/creatures-list/RESIDENTS-OURS-20260715.png

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);
const clientPath = join(root, "web", "js", "dwf-build-info-panels.js");
const cppPath = join(root, "src", "info_panel.cpp");
const headerPath = join(root, "src", "info_panel.h");
const activityPath = join(root, "src", "unit_activity.h");
const cssPath = join(root, "web", "css", "dwf.css");

globalThis.window = globalThis;
globalThis.DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
globalThis.escapeHtml = s => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
globalThis.dfTokenMatch = (hay, needle) => String(hay || "").toLowerCase().includes(String(needle || "").toLowerCase());
globalThis.unitPortraitMarkup = (row, cls) => `<span class="${cls}" data-stub-portrait="${row.unitId}"></span>`;
globalThis.infoRowPos = row => row?.hasPos ? { x: row.x, y: row.y, z: row.z } : null;
globalThis.rowTone = () => "";

const Info = require(clientPath);
const cpp = fs.readFileSync(cppPath, "utf8");
const header = fs.readFileSync(headerPath, "utf8");
const activity = fs.readFileSync(activityPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("PASS " + label); }
  catch (error) { console.log("FAIL " + label); throw error; }
}

const resident = {
  unitId: 7,
  name: "Atis Gembishkonos",
  profession: "Bard",
  professionColor: 5,
  category: "Dwarf",
  sex: "male",
  status: "Worship!",
  jobNeedDriven: false,
  jobColor: 13,
  jobId: 101,
  hasPos: true, x: 1, y: 2, z: 3,
  specialized: false,
  workDetails: [{ name: "Performers", icon: "NONE" }],
  moodCategory: 2,
};

function rowBody(row = resident) {
  const html = Info.creatureRowsMarkup([row], { detail: "residents" });
  return html.slice(html.indexOf('<div class="info-row creature-row'));
}

console.log("# resident identity is one native NAME_PROF cell");
check("one profession-colored name+profession cell; no duplicate profession/race/gender columns", () => {
  const html = rowBody();
  assert.match(html, /class="creature-identity"[^>]*>[\s\S]*Atis Gembishkonos, Bard/);
  assert.equal((html.match(/class="creature-identity"/g) || []).length, 1);
  assert.equal((html.match(/data-dwfui-bitmap-text="Atis Gembishkonos, Bard"/g) || []).length, 1,
    "the identity must be one bitmap-text value even though its accessible fallback repeats it in markup");
  assert.equal((html.match(/>Bard</g) || []).length, 0, "profession must not get a second standalone cell");
  assert.doesNotMatch(html, />Dwarf</);
  assert.doesNotMatch(html, /creature-sex-glyph|&#979[24];/);
  assert.match(html, new RegExp(`class="creature-identity"[^>]*style="color:${DWFUI.dfColor(5).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});
check("the server sends the untranslated visible name and DF's race-aware profession label", () => {
  assert.match(cpp, /Translation::translateName\(Units::getVisibleName\(unit\)\)/);
  assert.match(cpp, /row\.profession = Units::getProfessionName\(unit\)/);
  assert.match(cpp, /row\.name = unit_list_name\(unit\)/);
});
check("Pets/Other/Dead retain gender plus standalone Cat and Prof columns", () => {
  for (const detail of ["pets", "other", "dead"]) {
    const html = Info.creatureRowsMarkup([resident], { detail });
    const body = html.slice(html.indexOf('<div class="info-row creature-row'));
    assert.match(body, /class="creature-sex-glyph" title="Male">&#9794;<\/span>/, `${detail}: gender`);
    assert.match(body, /<div>Dwarf<\/div>\s*<div>Bard<\/div>/, `${detail}: Cat/Prof columns`);
  }
});

console.log("# native column order and headers");
check("row order is portrait, identity, recenter/sheet, job, task controls, activity details, mood, specialization, work details", () => {
  const html = rowBody();
  const tokens = ["data-stub-portrait", "creature-identity", "creature-actions", "creature-job-text",
    "creature-job-controls", "creature-activity-details", "creature-mood-slot", "creature-spec", "creature-workdetails"];
  let at = -1;
  for (const token of tokens) {
    const next = html.indexOf(token, at + 1);
    assert.ok(next > at, `${token} is absent or out of native order`);
    at = next;
  }
});
check("five sort controls cover Name/Cat/Prof plus native job and happiness columns", () => {
  const html = Info.creatureRowsMarkup([resident], { detail: "residents" });
  assert.equal((html.match(/data-creature-sort=/g) || []).length, 5);
  for (const key of ["name", "category", "profession", "status", "moodCategory"])
    assert.match(html, new RegExp(`data-creature-sort="${key}"`));
});
check("the two bare headers actually sort current job text and numeric happiness", () => {
  const rows = [
    { ...resident, unitId: 1, name: "Zan", status: "Worship", moodCategory: 6 },
    { ...resident, unitId: 2, name: "Atis", status: "Drink", moodCategory: 0 },
  ];
  const byJob = Info.creatureRowsMarkup(rows, { detail: "residents", sortKey: "status" });
  const byMood = Info.creatureRowsMarkup(rows, { detail: "residents", sortKey: "moodCategory" });
  assert.ok(byJob.indexOf('data-unit-id="2"') < byJob.indexOf('data-unit-id="1"'));
  assert.ok(byMood.indexOf('data-unit-id="2"') < byMood.indexOf('data-unit-id="1"'));
});
check("Residents track 5 is fixed-width and shared by the sort header", () => {
  const tracks = css.match(/--resident-grid-columns:\s*([^;]+);/s);
  assert.ok(tracks, "the parent must own the resident grid track definition");
  assert.match(tracks[1], /minmax\(220px, \.9fr\)\s*calc\(170px \* var\(--dwfui-interface-scale, 1\)\)/,
    "track 5 must be fixed at a scale-coupled 170px, not content-sized per row");
  assert.doesNotMatch(tracks[1], /minmax\(0,\s*170px\)/);
  const rule = css.match(/\.creature-row\.resident-row,\s*\.dwfui-sort-head\.info-sort-head-row\s*\{[^}]*grid-template-columns:\s*([^;]+);/s);
  assert.ok(rule, "Residents rows and header must share one grid declaration");
  assert.equal(rule[1].trim(), "var(--resident-grid-columns)");
});
check("five header controls align by resident grid columns without margin/padding offsets", () => {
  assert.match(css, /\.dwfui-sort-head\.info-sort-head-row\s*\{[^}]*display:grid;[^}]*gap:0;/s,
    "the shared tracks must not inherit DWFUI's flex-header gap");
  for (const [key, column] of [["name", 2], ["category", 2], ["profession", 2], ["status", 4], ["moodCategory", 7]])
    assert.match(css, new RegExp(`\\[data-creature-sort="${key}"\\]\\s*\\{[^}]*grid-column:${column}`, "s"));
  assert.doesNotMatch(css, /\.info-sort-head-row[^{}]*\{[^}]*padding-left:/s);
  assert.doesNotMatch(css, /\.info-sort-head-row \[data-creature-sort="(?:status|moodCategory)"\][^{}]*\{[^}]*(?:margin-left|margin-right):/s);
});

console.log("# job colors and need punctuation are served data");
check("served jobColor alone drives DWFUI.dfColor; evidence-free idle stays uncolored", () => {
  const colored = rowBody({ ...resident, status: "Gather plants", jobNeedDriven: false, jobColor: 11 });
  const idle = rowBody({ ...resident, status: "No job", jobNeedDriven: false, jobColor: -1 });
  assert.match(colored, new RegExp(`creature-job-text[^>]*style="color:${DWFUI.dfColor(11).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(idle, /creature-job-text[^>]*style=/);
});
check("a trailing ! appears only when the served jobNeedDriven flag is true", () => {
  assert.match(rowBody({ ...resident, status: "Worship!", jobNeedDriven: false }), /data-dwfui-bitmap-text="Worship"/);
  assert.doesNotMatch(rowBody({ ...resident, status: "Worship!", jobNeedDriven: false }), /data-dwfui-bitmap-text="Worship!"/);
  assert.match(rowBody({ ...resident, status: "Worship", jobNeedDriven: true }), /data-dwfui-bitmap-text="Worship!"/);
});
check("wire carries native-derived need state and the source-bucket color index", () => {
  assert.match(header, /int8_t job_color = -1/);
  assert.match(header, /bool job_need_driven = false/);
  assert.match(cpp, /Units::hasUnbailableSocialActivity\(unit\)/);
  assert.match(cpp, /\\\"jobColor\\\"/);
  assert.match(cpp, /\\\"jobNeedDriven\\\"/);
  assert.match(activity, /struct UnitCurrentTask\s*\{[\s\S]*UnitTaskColorBucket color_bucket/);
  assert.match(activity, /if \(unit->job.current_job\)\s*return \{std::move\(name\), UnitTaskColorBucket::Job\}/);
  assert.match(cpp, /resident_job_bucket_color\(task\.color_bucket\)/);
  assert.doesNotMatch(cpp, /resident_job_oracle_color|label\s*==/,
    "resident colors must never be re-derived from final label text");

  const sourceColor = { Job: 11, Social: 10, Need: 13, Training: 14 };
  for (const [bucket, color] of Object.entries(sourceColor))
    assert.match(cpp, new RegExp("case UnitTaskColorBucket::" + bucket + ": return " + color));

  // All ten original oracle pins still pass, but labels are test data only -- production sees the
  // source bucket. Eat and Sleep prove uncaptured df::job wording no longer falls through to white.
  const oraclePairs = [
    ["Drink", "Job", 11],
    ["Gather plants", "Job", 11],
    ["Store item in stockpile", "Job", 11],
    ["Store item in barrel", "Job", 11],
    ["Make shell crafts", "Job", 11],
    ["Socialize", "Social", 10],
    ["Worship", "Need", 13],
    ["Worship!", "Need", 13],
    ["Watch Dodging Demonstration", "Training", 14],
    ["Lead Dodging Demonstration", "Training", 14],
  ];
  for (const [label, bucket, expected] of oraclePairs)
    assert.equal(sourceColor[bucket], expected, label);
  for (const uncapturedJob of ["Eat", "Sleep"])
    assert.equal(sourceColor.Job, 11, uncapturedJob + " must inherit the df::job source bucket");
});
check("all 28 activity event sources have an explicit non-white nature bucket", () => {
  const expected = {
    TrainingSession: "Training", CombatTraining: "Training",
    SkillDemonstration: "Training", IndividualSkillDrill: "Training",
    Sparring: "Training", RangedPractice: "Training",
    Harassment: "Social", Conversation: "Social", Conflict: "Social", Reunion: "Social",
    Socialize: "Social", Performance: "Social", DiscussTopic: "Social", TeachTopic: "Social",
    Read: "Social", Play: "Social", MakeBelieve: "Social", PlayWithToy: "Social",
    Encounter: "Social",
    Prayer: "Need", Worship: "Need",
    Guard: "Job", Research: "Job", PonderTopic: "Job", FillServiceOrder: "Job",
    Write: "Job", CopyWrittenContent: "Job", StoreObject: "Job",
    NONE: "None",
  };
  const body = activity.match(
    /inline UnitTaskColorBucket activity_task_color_bucket[\s\S]*?\n}\n\n\/\/ Return DF's exact/);
  assert.ok(body, "source-bucket switch must remain inspectable");
  const actual = {};
  let pending = [];
  for (const line of body[0].split(/\r?\n/)) {
    const event = line.match(/case df::activity_event_type::(\w+):/);
    if (event) pending.push(event[1]);
    const bucket = line.match(/return UnitTaskColorBucket::(\w+);/);
    if (bucket) {
      for (const type of pending) actual[type] = bucket[1];
      pending = [];
    }
  }
  assert.deepEqual(actual, expected);
  for (const [type, bucket] of Object.entries(actual))
    if (type !== "NONE") assert.notEqual(bucket, "None", type);
});

console.log("# per-label ACTIVITY_DETAILS controls use only established native actions");
check("Store item in stockpile gets task-building recenter plus plain-job cancel", () => {
  const html = rowBody({ ...resident, status: "Store item in stockpile",
    jobHasPos: true, jobX: 44, jobY: 55, jobZ: 6 });
  assert.match(html, /data-resident-job-center=""/);
  assert.match(html, /data-resident-job-x="44"/);
  assert.match(html, /data-resident-job-y="55"/);
  assert.match(html, /data-resident-job-z="6"/);
  assert.match(html, /data-info-cancel-job="101"/);
  assert.match(html, /data-dwfui-sprite="BUILDING_JOBS_REMOVE_WORKER"/);
  assert.ok(html.indexOf("data-resident-job-center") < html.indexOf("data-info-cancel-job"));
  assert.match(header, /bool job_has_pos = false/);
  assert.match(cpp, /row\.job == "Store item in stockpile"[\s\S]{0,240}?building_stockpilest/);
  for (const key of ["jobHasPos", "jobX", "jobY", "jobZ"])
    assert.match(cpp, new RegExp(`\\\\"${key}\\\\"`));
});
check("Store item in barrel preserves native's no-controls quirk even with a supplied target", () => {
  const html = rowBody({ ...resident, status: "Store item in barrel",
    jobHasPos: true, jobX: 44, jobY: 55, jobZ: 6 });
  assert.match(html, /class="creature-job-controls" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(html, /data-resident-job-center|data-info-cancel-job|data-resident-job-action/);
});
check("Socialize/Worship do not miswire native activity-details magnifiers as recenter", () => {
  for (const status of ["Socialize", "Worship"]) {
    const html = rowBody({ ...resident, status, jobId: -1 });
    assert.match(html, /class="creature-job-controls" aria-hidden="true"><\/span>/, status);
    assert.match(html, /class="creature-activity-details" aria-hidden="true"><\/span>/, status);
    assert.doesNotMatch(html, /data-resident-job-center|data-info-cancel-job|data-resident-job-action/, status);
  }
});
check("workshop current jobs reuse repeat/priority/suspend/cancel state and endpoint hooks", () => {
  const html = rowBody({ ...resident, jobBuildingId: 44, jobRepeat: true, jobSuspended: false, jobDoNow: true });
  for (const action of ["repeat", "priority", "suspend"])
    assert.match(html, new RegExp(`data-resident-job-action="${action}"`));
  assert.match(html, /data-info-cancel-job="101"/);
  assert.match(html, /data-resident-job-building="44"/);
  assert.match(header, /int32_t job_building_id = -1/);
  assert.match(cpp, /Job::getHolder\(/);
});

console.log(`b296-residents-parity: ${passed} passed`);
