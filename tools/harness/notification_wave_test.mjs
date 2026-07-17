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

// notification_wave_test.mjs -- B65/B67 offline structural fixture.
// Run: node tools/harness/notification_wave_test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = rel => readFileSync(join(root, rel), "utf8");
const cpp = read("src/notifications.cpp");
const announcementsCpp = read(`src/announcements.cpp`);
const js = read("web/js/dwf-unit-hud-notifications.js");
const css = read("web/css/dwf.css");
let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + ": " + (error.stack || error)); }
}

function pruneModel(alert, dismissed) {
  const dismissedReport = report => report.id >= 0 && dismissed.has("r:" + report.id);
  return {
    reports: alert.reports.filter(report => !dismissedReport(report)),
    unitReports: alert.unitReports.map(ref => ({ ...ref, reports: ref.reports.filter(report => !dismissedReport(report)) }))
      .filter(ref => ref.reports.length || !dismissed.has(ref.dismissKey)),
  };
}

check("B65 keeps only reports since the selected alert was dismissed", () => {
  const original = {
    reports: [{ id: 41, text: "old combat" }, { id: 42, text: "new combat" }],
    unitReports: [{ dismissKey: "u:7:0", reports: [{ id: 41, text: "old combat" }, { id: 42, text: "new combat" }] }],
  };
  const pruned = pruneModel(original, new Set(["r:41", "u:7:0"]));
  assert.deepEqual(pruned.reports.map(r => r.id), [42]);
  assert.deepEqual(pruned.unitReports[0].reports.map(r => r.id), [42]);
});

check("B65 test-the-test: an unpruned history fails the since-dismiss assertion", () => {
  const unpruned = [{ id: 41 }, { id: 42 }];
  assert.notDeepEqual(unpruned.map(r => r.id), [42]);
});

check("B65 server prunes both alert rows and unit-category rows before serialization", () => {
  assert.match(cpp, /void prune_dismissed_alert_content[\s\S]*?alert\.reports\.erase[\s\S]*?ref\.reports\.erase[\s\S]*?alert\.unit_refs\.erase/);
  assert.match(cpp, /for \(auto& alert : state\.alerts\)\s*\n\s*prune_dismissed_alert_content\(alert, dismissed\);/);
  assert.match(cpp, /report_dismiss_key\(report\.id\)/);
});

check("B65 test-the-test: removing the prune call is detected", () => {
  const seededBroken = cpp.replace(/\s*for \(auto& alert : state\.alerts\)\s*\n\s*prune_dismissed_alert_content\(alert, dismissed\);/, "");
  assert.doesNotMatch(seededBroken, /prune_dismissed_alert_content\(alert, dismissed\);/);
});

function resolveHistfigReferences(text, figures) {
  return text.replace(/\bHF (\d+)\b/g, (matched, id) => figures.get(Number(id)) ?? matched);
}

check(`B99 fighting alert dismisses its report and unit-combat keys under B65`, () => {
  const fightingAlert = {
    type: 34,
    typeKey: `COMBAT`,
    dismissKeys: [`r:900`, `u:77:0`],
    reports: [{ id: 900, text: `combat report` }],
    unitReports: [{ dismissKey: `u:77:0`, reports: [{ id: 900, text: `combat report` }] }],
  };
  const dismissed = new Set(fightingAlert.dismissKeys);
  const pruned = pruneModel(fightingAlert, dismissed);
  assert.deepEqual(pruned.reports, []);
  assert.deepEqual(pruned.unitReports, []);
  assert.ok(fightingAlert.dismissKeys.every(key => dismissed.has(key)));
  assert.match(cpp, /report_unit_announcement_category[\s\S]*?unit_report_dismiss_key/);
  assert.match(js, /action=dismiss&keys=\$\{encodeURIComponent\(keys\.join\(/);
});

check(`B100 resolves HF ids in notification and report serialization`, () => {
  const figures = new Map([[9008, `Rigoth Oslanan`]]);
  const input = `Blood of HF 9008, stains the floor.`;
  assert.equal(resolveHistfigReferences(input, figures), `Blood of Rigoth Oslanan, stains the floor.`);
  for (const source of [cpp, announcementsCpp]) {
    assert.match(source, /resolve_histfig_references[\s\S]*?df::historical_figure::find[\s\S]*?Translation::translateName/);
    assert.match(source, /out\.text = resolve_histfig_references\(report->text\);/);
  }
});

check("B67 retains a hovered alert through the polling-driven DOM rebuild", () => {
  assert.match(js, /let hoveredAlertKey = null;/);
  assert.match(js, /const retainedKey = pinnedAlertKey \|\| hoveredAlertKey;/);
  assert.match(js, /const retainedAlert = retainedKey && alerts\.find/);
  assert.match(js, /showAlertPopup\(retainedAlert, retainedButton, pinnedAlertKey === retainedAlert\.dismissKey\)/);
});

check("B67 measures the visible bounded popup before positioning it", () => {
  assert.match(js, /alertPopup\.style\.visibility = "hidden";[\s\S]*?alertPopup\.style\.display = "block";[\s\S]*?const popupHeight = alertPopup\.offsetHeight/);
  assert.match(js, /alertPopup\.style\.visibility = "visible";/);
  assert.match(css, /#alertPopup\s*\{[\s\S]*?max-height:\s*calc\(100vh - 66px\);[\s\S]*?overflow-y:\s*auto;/);
});

check("B67 test-the-test: a popup without a vertical bound is rejected", () => {
  const seededBroken = css.replace(/\s*max-height:\s*calc\(100vh - 66px\);\s*\n\s*overflow-y:\s*auto;/, "");
  assert.doesNotMatch(seededBroken, /#alertPopup\s*\{[\s\S]*?max-height:\s*calc\(100vh - 66px\);[\s\S]*?overflow-y:\s*auto;/);
});

// --- B192: the combat alert badge could not be dismissed (win30) ---
// Root cause: the interactive (pinned) popup only offered per-report dismiss buttons emitting
// `r:<id>` keys, and only for lines carrying a report. A combat alert also carries per-unit
// `u:<unit>:<cat>` keys in dismissKeys that have NO dismissible line, and the server drops an
// alert only when EVERY dismissKey is dismissed. So no sequence of per-line popup dismisses could
// ever clear a combat alert -- paused or not. The fix adds a whole-alert dismiss control to the
// pinned popup that emits ALL dismissKeys via dismissAlert(alert).
function allKeysDismissed(alert, dismissed) {
  // mirrors src/notifications.cpp all_alert_keys_dismissed(): empty keys never auto-dismiss,
  // otherwise every key must be in the dismissed set.
  if (!alert.dismissKeys.length) return false;
  return alert.dismissKeys.every(key => dismissed.has(key));
}
// What the per-line popup dismiss vocabulary can emit: `r:<id>` for each visible report line only.
const lineDismissKeys = alert => alert.reports.map(report => "r:" + report.id);

check("B192 per-line popup dismiss alone cannot clear a combat alert (the reported bug)", () => {
  const combat = {
    type: 34, typeKey: "COMBAT",
    dismissKeys: ["r:900", "u:77:0"],
    reports: [{ id: 900, text: "combat report" }],
    unitReports: [{ dismissKey: "u:77:0", reports: [{ id: 900, text: "combat report" }] }],
  };
  // Dismiss every visible report line -- the only thing the old popup could do.
  const dismissedViaLines = new Set(lineDismissKeys(combat));
  assert.deepEqual([...dismissedViaLines], ["r:900"]); // never emits the u: key
  assert.equal(allKeysDismissed(combat, dismissedViaLines), false); // u:77:0 keeps the badge alive
});

check("B192 whole-alert dismiss emits ALL keys and clears the combat alert", () => {
  const combat = {
    type: 34, typeKey: "COMBAT",
    dismissKeys: ["r:900", "u:77:0"],
    reports: [{ id: 900, text: "combat report" }],
    unitReports: [{ dismissKey: "u:77:0", reports: [{ id: 900, text: "combat report" }] }],
  };
  // dismissAlert(alert) sends the whole dismissKeys array (both r: and u: keys).
  const dismissed = new Set(combat.dismissKeys);
  assert.equal(allKeysDismissed(combat, dismissed), true);
});

check("B192 dismissal sticks across an identical paused re-poll", () => {
  const dismissed = new Set(["r:900", "u:77:0"]); // from a prior whole-alert dismiss
  // Paused: the very next /notifications poll rebuilds an identical alert (same keys, no new
  // reports). It must stay dismissed rather than re-raising.
  const rebuiltIdentical = { dismissKeys: ["r:900", "u:77:0"], reports: [], unitReports: [] };
  assert.equal(allKeysDismissed(rebuiltIdentical, dismissed), true);
});

check("B192 a pruned combat alert (reports gone, only a u: key left) is reachable only by whole-alert dismiss", () => {
  // After dismissing r:900, prune_dismissed_alert_content empties reports; the next poll serves a
  // bare unit alert whose ONLY key is u:77:0 and which has no report line to click.
  const pruned = { dismissKeys: ["u:77:0"], reports: [], unitReports: [{ dismissKey: "u:77:0", reports: [] }] };
  assert.deepEqual(lineDismissKeys(pruned), []); // no per-line dismiss possible at all
  assert.equal(allKeysDismissed(pruned, new Set(lineDismissKeys(pruned))), false); // permanently stuck without the fix
  assert.equal(allKeysDismissed(pruned, new Set(pruned.dismissKeys)), true); // whole-alert dismiss clears it
});

check("B192 the pinned popup wires a whole-alert dismiss control to dismissAlert", () => {
  // The interactive (pinned) popup carries a dismiss-all control; hover stays read-only.
  assert.match(js, /data-popup-dismiss-alert/);
  assert.match(js, /querySelector\("\[data-popup-dismiss-alert\]"\)\?\.addEventListener\("click", \(\) => dismissAlert\(alert\)\)/);
  // dismissAlert must forward the whole dismissKeys array, not a single key.
  assert.match(js, /async function dismissAlert\(alert\)\s*\{[\s\S]*?Array\.isArray\(alert\?\.dismissKeys\)/);
});

check("B192 test-the-test: a popup lacking the whole-alert dismiss wiring is rejected", () => {
  const seededBroken = js.replace(/querySelector\("\[data-popup-dismiss-alert\]"\)\?\.addEventListener\("click", \(\) => dismissAlert\(alert\)\)/, "/* removed */");
  assert.doesNotMatch(seededBroken, /querySelector\("\[data-popup-dismiss-alert\]"\)\?\.addEventListener\("click", \(\) => dismissAlert\(alert\)\)/);
});

check("B192 the whole-alert dismiss button is styled", () => {
  assert.match(css, /\.alert-dismiss-all\b/);
});

// --- B197 (win30): the combat alert popup listed every previous report ---
// the screenshot: one combat alert popup listing dozens of accumulated reports. The core
// re-listing (dismissed items coming back) is B192's territory -- his report predated that fix by
// minutes. These cells cover the residuals B192 does NOT address.

// (a) Display cap: even with working dismissal, a never-dismissed busy fort accumulates hundreds
// of report lines (server serves the full announcement window; the client dumped every one). The
// popup now caps to the newest N with a "+K earlier" summary; the full log stays in the panel.
const ALERT_POPUP_MAX_LINES = 24;
function cappedLinesModel(lines) {
  const all = Array.isArray(lines) ? lines : [];
  if (all.length <= ALERT_POPUP_MAX_LINES) return { shown: all, omitted: 0 };
  return { shown: all.slice(-ALERT_POPUP_MAX_LINES), omitted: all.length - ALERT_POPUP_MAX_LINES };
}

check("B197(a) popup caps to the newest N lines with an accurate older-count", () => {
  const lines = Array.from({ length: 60 }, (_, i) => ({ id: i }));
  const { shown, omitted } = cappedLinesModel(lines);
  assert.equal(shown.length, ALERT_POPUP_MAX_LINES);
  assert.equal(omitted, 60 - ALERT_POPUP_MAX_LINES);
  assert.equal(shown[0].id, 36);                       // newest 24 retained (tail = most recent)
  assert.equal(shown[shown.length - 1].id, 59);        // the very newest report is always shown
});

check("B197(a) a small alert renders in full with no overflow summary", () => {
  const { shown, omitted } = cappedLinesModel(Array.from({ length: 5 }, (_, i) => ({ id: i })));
  assert.equal(shown.length, 5);
  assert.equal(omitted, 0);
});

check("B197(a) test-the-test: an uncapped wall fails the bounded-popup assertion", () => {
  const uncapped = Array.from({ length: 60 }, (_, i) => ({ id: i })); // the pre-fix behavior
  assert.notEqual(uncapped.length, ALERT_POPUP_MAX_LINES);
});

check("B197(a) client wires the popup cap + overflow summary and styles it", () => {
  assert.match(js, /const ALERT_POPUP_MAX_LINES = \d+;/);
  assert.match(js, /function cappedAlertLines\(lines\)/);
  assert.match(js, /cappedAlertLines\(allLines\)/);
  assert.match(js, /alert-overflow-line/);
  assert.match(css, /\.alert-overflow-line\b/);
});

// (c) The pre-existing empty-dismissKeys edge (flagged in the B192 report): a contentless alert
// (no announcement_id, no unit refs) has no r:/u: keys, so all_alert_keys_dismissed could never
// clear it -- a stuck bare badge. The minimal server-side answer: honor the alert-level "a:<type>"
// key (which the client already sends as the empty-alert fallback) as the escape hatch.
function serverClearsAlert(alert, dismissed) {
  // mirrors the updated src/notifications.cpp all_alert_keys_dismissed()
  if (!alert.dismissKeys.length)
    return !!alert.dismissKey && dismissed.has(alert.dismissKey);
  return alert.dismissKeys.every(key => dismissed.has(key));
}

check("B197(c) an empty-key alert clears only once its alert-level a: key is dismissed", () => {
  const bare = { dismissKey: "a:34", dismissKeys: [] };
  assert.equal(serverClearsAlert(bare, new Set()), false);            // undismissed -> stays
  assert.equal(serverClearsAlert(bare, new Set(["a:34"])), true);     // a: key -> clears
});

check("B197(c) keyed alerts are unaffected (a: key alone never clears them)", () => {
  const keyed = { dismissKey: "a:34", dismissKeys: ["r:900", "u:77:0"] };
  assert.equal(serverClearsAlert(keyed, new Set(["a:34"])), false);
  assert.equal(serverClearsAlert(keyed, new Set(["r:900", "u:77:0"])), true);
});

check("B197(c) test-the-test: the old 'empty keys never clear' behavior is rejected", () => {
  const oldServerClears = (alert, dismissed) =>
    alert.dismissKeys.length ? alert.dismissKeys.every(k => dismissed.has(k)) : false;
  assert.equal(oldServerClears({ dismissKey: "a:34", dismissKeys: [] }, new Set(["a:34"])), false);
});

check("B197(c) server honors the empty-key a: fallback; client emits it", () => {
  assert.match(cpp, /if \(alert\.dismiss_keys\.empty\(\)\)\s*\n\s*return !alert\.dismiss_key\.empty\(\) &&\s*\n\s*dismissed\.find\(alert\.dismiss_key\)/);
  assert.match(js, /if \(!keys\.length && alert\?\.dismissKey\) keys\.push\(alert\.dismissKey\);/);
});

// (b) Dismissed-set growth: the per-player set is process-global and never cleared; only r:<id>
// keys accumulate freely. remember_dismissed_alert_keys now caps r: keys to the newest by id
// (dropped keys reference reports long since aged out of the world), always retaining u:/a: keys.
function pruneModelReportKeys(set, cap) {
  const rIds = [...set].filter(k => k.startsWith("r:")).map(k => Number(k.slice(2)));
  if (rIds.length <= cap) return new Set(set);
  const threshold = [...rIds].sort((a, b) => a - b)[rIds.length - cap];
  return new Set([...set].filter(k => !k.startsWith("r:") || Number(k.slice(2)) >= threshold));
}

check("B197(b) dismissed-set prune keeps newest r: keys and retains u:/a:", () => {
  const s = new Set(["r:1", "r:2", "r:3", "r:4", "r:5", "u:7:0", "a:34"]);
  const p = pruneModelReportKeys(s, 3);
  assert.ok(!p.has("r:1") && !p.has("r:2"));                    // oldest r: evicted
  assert.ok(p.has("r:3") && p.has("r:4") && p.has("r:5"));      // newest 3 kept
  assert.ok(p.has("u:7:0") && p.has("a:34"));                   // non-r: always retained
});

check("B197(b) prune is a no-op under the cap (dismissals survive)", () => {
  const s = new Set(["r:1", "r:2", "u:7:0"]);
  assert.deepEqual([...pruneModelReportKeys(s, 8192)].sort(), [...s].sort());
});

check("B197(b) server bounds the r: dismiss keys, retaining non-r: keys", () => {
  assert.match(cpp, /prune_report_dismiss_keys\(dismissed\);/);
  assert.match(cpp, /kMaxReportDismissKeys/);
  assert.match(cpp, /key\.rfind\("r:", 0\) == 0/);
});

if (failed) {
  console.error("\nFAIL " + failed + " notification-wave fixture cell(s)");
  process.exit(1);
}
console.log("\nPASS notification-wave fixtures");
