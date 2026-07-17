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

// TX14 -- the announcements gate.
//
// TX14's claim is a BEHAVIOUR, not a file: DF announcements carry a SECOND location
// (pos2 / zoom_type2) and an explicit NONE zoom type (-1), so the "Center" button must appear on
// far more announcements AND must vanish on the ones DF says have no location.  It also stitches
// DF's wrapped continuation lines back into one message, ships the full 37-entry category table,
// and plumbs speaker_id / activity_id / activity_event_id end to end.
//
// SO THIS GATE NEVER ASSERTS THAT A FILE EXISTS OR CONTAINS THE STRING "pos2".  Every rule either
//   (a) renders the REAL production markup and asserts on the RESULT -- the announcements/reports
//       SCREEN's rows (dwf-announcements.js repRows; the per-report Center surface since
//       B232 R2 deleted the dashboard) and the alert popup
//       (dwf-unit-hud-notifications.js alertPopupMarkup), or
//   (b) drives the REAL shared module (dwf-announcement-format.js) directly.
//
// Each rule is paired with a SEEDED-BAD: the module is swapped for LEGACY, a faithful
// reconstruction of the PRE-TX14 behaviour (target = report.pos, no NONE check, no pos2, no
// stitching, an 8-entry category table).  Under --selftest every rule must REJECT it.
// A rule that still passes against LEGACY cannot fail, and is reported as a FAILURE.
//
//   node tools/harness/tx14_announce_test.mjs             # gate
//   node tools/harness/tx14_announce_test.mjs --selftest  # prove each rule catches its seeded-bad
//
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const SELFTEST = process.argv.includes("--selftest");

const p = (...parts) => join(root, ...parts);
const read = (...parts) => readFileSync(p(...parts), "utf8");

// ---------------------------------------------------------------------------------------------
// Load the REAL client. unit-hud is the production owner of the announcements panel + the alert
// popup; it reads the shared format module off the global at CALL time, which is exactly what lets
// --selftest swap the module underneath the SAME production markup functions.
// ---------------------------------------------------------------------------------------------
globalThis.window = { setTimeout, addEventListener() {} };
globalThis.fetch = async () => ({ ok: false });
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.DWFUI = (await import("../../web/js/dwf-ui-components.js")).default;
globalThis.window.DWFUI = globalThis.DWFUI;

const FORMAT = (await import("../../web/js/dwf-announcement-format.js")).default;
const HUD = await import("../../web/js/dwf-unit-hud-notifications.js");

// dwf-announcements.js is a plain browser script: in the page it shares one global scope with
// unit-hud. Under node it gets its own module scope, so re-publish the handful of helpers it reads
// as free identifiers. These are the PRODUCTION functions (from unit-hud), not reimplementations --
// only escapeHtml is a local shim, because unit-hud does not export it.
globalThis.escapeHtml = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
globalThis.alertIconStyle = HUD.alertIconStyle;
globalThis.dfTextColor = HUD.dfTextColor;
globalThis.reportText = HUD.reportText;
globalThis.activeInfoPanel = null;
globalThis.clientPanel = { classList: { contains: () => false } };
const ANN = (await import("../../web/js/dwf-announcements.js")).default;

const hudSrc = read("web", "js", "dwf-unit-hud-notifications.js");
const annSrc = read("web", "js", "dwf-announcements.js");
const announceCpp = read("src", "announcements.cpp");
const announceH = read("src", "announcements.h");
const notifyCpp = read("src", "notifications.cpp");
const notifyH = read("src", "notifications.h");

// ---------------------------------------------------------------------------------------------
// LEGACY: the pre-TX14 behaviour, reconstructed. This is the SEEDED-BAD every rule must reject.
// ---------------------------------------------------------------------------------------------
const LEGACY_NAMES = ["General", "Era Change", "Underground", "Migrants",
                      "Monster", "Ambush", "Trade", "Noble"];   // the old short table
const LEGACY = {
  ALERT_NAMES: LEGACY_NAMES,
  categoryName: (t) => LEGACY_NAMES[Number(t)] || "Other",
  reportText: FORMAT.reportText,
  isCombatAlert: FORMAT.isCombatAlert,
  fightingLabel: FORMAT.fightingLabel,
  combatUnitRows: FORMAT.combatUnitRows,
  groupReports: (reports) => (Array.isArray(reports) ? reports : []),   // no stitching
  zoomTarget: (r) => (r && r.pos ? r.pos : null),                       // no NONE, no pos2
};
// A second seeded-bad, for the round-trip rule only: grouping that keeps the text but throws the
// identity fields away -- the classic "I stitched the strings and rebuilt the object" regression.
const LOSSY = Object.assign({}, FORMAT, {
  groupReports: (reports) => FORMAT.groupReports(reports)
    .map(m => ({ id: m.id, text: m.text, lineCount: m.lineCount, pos: m.pos, zoomType: m.zoomType })),
});

const useFormat = (impl) => { globalThis.DwfAnnouncementFormat = impl; globalThis.window.DwfAnnouncementFormat = impl; };

// ---------------------------------------------------------------------------------------------
// Fixtures -- shaped exactly like the /notifications + /reports payloads the C++ now emits.
// ---------------------------------------------------------------------------------------------
const POS2 = { x: 40, y: 41, z: 42 };
const POS1 = { x: 10, y: 11, z: 12 };

// The announcement TX14 exists for: DF gave it NO primary location, only a SECOND one.
const R_POS2_ONLY = { id: 101, text: "A vile force of darkness has arrived!", typeKey: "AMBUSH",
                      alertType: 5, color: 4, year: 250, time: 9, repeatCount: 0,
                      zoomType: -1, hasPos: false, pos: null,
                      zoomType2: 0, hasPos2: true, pos2: POS2,
                      speakerId: -1, activityId: -1, activityEventId: -1 };

// DF's explicit NONE: a stale pos is present in the struct, but zoom_type says there is nowhere
// to go. The old client happily fabricated a Center button from it and jumped the camera.
const R_NONE = { id: 102, text: "Urist McMiner has grown to be a Legendary Miner.", typeKey: "SKILL",
                 alertType: 11, color: 7, year: 250, time: 10, repeatCount: 0,
                 zoomType: -1, hasPos: false, pos: POS1,
                 zoomType2: -1, hasPos2: false, pos2: null,
                 speakerId: -1, activityId: -1, activityEventId: -1 };

const R_PLAIN = { id: 103, text: "A masterwork has been created.", typeKey: "MASTERPIECE",
                  alertType: 19, color: 7, year: 250, time: 11, repeatCount: 0,
                  zoomType: 0, hasPos: true, pos: POS1,
                  zoomType2: -1, hasPos2: false, pos2: null,
                  speakerId: -1, activityId: -1, activityEventId: -1 };

// One conversation, wrapped by DF across three report rows. Native shows ONE message.
// The identity fields live on the LEAD line -- they must survive the stitch.
const WRAP_LEAD = { id: 201, text: "Urist McMayor, Mayor:", typeKey: "CONVERSATION", alertType: 7,
                    color: 7, year: 250, time: 20, repeatCount: 0, continuation: false,
                    zoomType: 0, hasPos: true, pos: POS1, zoomType2: -1, hasPos2: false, pos2: null,
                    speakerId: 777, activityId: 888, activityEventId: 999 };
const WRAP_C1 = Object.assign({}, WRAP_LEAD, { id: 202, text: "We must discuss the",
                    continuation: true, speakerId: -1, activityId: -1, activityEventId: -1 });
const WRAP_C2 = Object.assign({}, WRAP_LEAD, { id: 203, text: "state of the fortress.",
                    continuation: true, speakerId: -1, activityId: -1, activityEventId: -1 });
const WRAPPED = [WRAP_LEAD, WRAP_C1, WRAP_C2];
const WRAPPED_JOINED = "Urist McMayor, Mayor: We must discuss the state of the fortress.";

// The REAL production announcements screen's rows (B232 R2: the dashboard is gone; the
// reports screen is the surface that renders per-report Center buttons -- oracle-mandated, the
// native ALERT box has no per-line controls at all).
const panel = (reports) => ANN.repRows(reports, "all");
const popup = (reports) => HUD.alertPopupMarkup(
  { type: 7, iconIndex: 7, dismissKey: "a:7", dismissKeys: ["a:7"], reports }, true);

const centersIn = (html) => [...html.matchAll(/data-rep-center="(\d+)"/g)].map(m => Number(m[1]));
const popupLines = (html) => (html.match(/class="alert-line/g) || []).length;

// ---------------------------------------------------------------------------------------------
// Rules. assertOn(impl) must PASS for the real module and THROW for its seeded-bad.
// ---------------------------------------------------------------------------------------------
const rules = [];
const rule = (label, assertOn, seedBad = () => LEGACY) => rules.push({ label, assertOn, seedBad });

rule("pos2/zoom_type2: an announcement with only a SECOND location yields a zoom target -> Center button",
  (impl) => {
    useFormat(impl);
    assert.deepEqual(impl.zoomTarget(R_POS2_ONLY), POS2,
      "an announcement whose only location is pos2 must resolve to pos2");
    const html = panel([R_POS2_ONLY]);
    assert.ok(centersIn(html).includes(101),
      "the rendered announcements panel must offer Center on the pos2-only report");
  });

rule("pos2 Center actually targets pos2 -- not the primary slot, not a fabricated origin",
  (impl) => {
    useFormat(impl);
    const t = impl.zoomTarget(R_POS2_ONLY);
    assert.ok(t && t.x === 40 && t.y === 41 && t.z === 42,
      `Center must jump to where the event happened (40,41,42), got ${JSON.stringify(t)}`);
    // and the primary slot still wins when DF gives a valid one
    assert.deepEqual(impl.zoomTarget(R_PLAIN), POS1, "a valid primary location still takes precedence");
  });

rule("NONE zoom type: NO target and NO Center button -- the camera is never sent somewhere DF did not point",
  (impl) => {
    useFormat(impl);
    assert.equal(impl.zoomTarget(R_NONE), null,
      "zoom_type NONE (-1) means DF has nowhere to send the camera, even with a stale pos in the struct");
    const html = panel([R_NONE]);
    assert.equal(centersIn(html).length, 0,
      "a NONE announcement must render NO Center button (the old client fabricated one from the stale pos)");
  });

rule("a NONE report and a locatable report in the SAME list: exactly one Center, on the right row",
  (impl) => {
    useFormat(impl);
    const html = panel([R_NONE, R_POS2_ONLY, R_PLAIN]);
    assert.deepEqual(centersIn(html).sort(), [101, 103],
      "Center appears on the pos2 report and the primary-pos report, and NOT on the NONE report");
  });

rule("wrapped continuation lines are stitched back into ONE message",
  (impl) => {
    useFormat(impl);
    const msgs = impl.groupReports(WRAPPED);
    assert.equal(msgs.length, 1, `DF wrapped this across 3 rows; native shows 1 message, got ${msgs.length}`);
    assert.equal(msgs[0].text, WRAPPED_JOINED, "the continuation text must be re-joined in order");
    assert.equal(msgs[0].lineCount, 3, "the message must remember it spanned 3 wire rows");
    assert.deepEqual(msgs[0].reportIds, [201, 202, 203], "and which rows it came from");
  });

rule("the stitch reaches the REAL popup: 3 wrapped rows render as 1 line, not 3",
  (impl) => {
    useFormat(impl);
    assert.equal(popupLines(popup(WRAPPED)), 1,
      "the production alert popup must show the stitched message as a single line");
    assert.ok(popup(WRAPPED).includes("state of the fortress."),
      "and it must not drop the tail of the wrapped text");
  });

rule("an ORPHAN continuation (no lead) is kept as its own message -- a malformed stream drops no text",
  (impl) => {
    useFormat(impl);
    const msgs = impl.groupReports([WRAP_C1]);
    assert.equal(msgs.length, 1, "an orphan continuation must survive as its own message");
    assert.equal(msgs[0].text, "We must discuss the", "with its text intact");
    assert.equal(msgs[0].orphanContinuation, true, "and flagged, so a malformed stream is visible");
  },
  // LEGACY's identity grouping keeps the text too -- so seed the LOSSY-style regression that
  // actually loses it: a stitcher that silently swallows a continuation with no open group.
  () => Object.assign({}, FORMAT, { groupReports: (rs) => (Array.isArray(rs) ? rs : []).filter(r => !r.continuation) }));

rule("the 37-entry category table maps known alert types to their names",
  (impl) => {
    useFormat(impl);
    assert.equal(impl.ALERT_NAMES.length, 37, "df::announcement_alert_type has 37 entries");
    assert.equal(impl.categoryName(34), "Combat", "34 = Combat");
    assert.equal(impl.categoryName(21), "Death", "21 = Death");
    assert.equal(impl.categoryName(36), "Hunting", "36 = Hunting");
    assert.equal(impl.categoryName(3), "Migrants", "3 = Migrants");
    assert.equal(impl.categoryName(99), "Other", "an unknown type must NOT throw or index past the table");
    assert.equal(impl.categoryName(undefined), "Other", "and neither must a missing one");
  });

rule("the category table reaches the REAL announcements panel (a Combat report reads 'Combat', not 'Other')",
  (impl) => {
    useFormat(impl);
    const rows = ANN.repRows([Object.assign({}, R_PLAIN, { alertType: 34, id: 301 })], -1);
    assert.ok(rows.includes("Combat"),
      "the announcements panel's category sub-line must name alert type 34 'Combat'");
    assert.ok(!rows.includes("Other"), "and must not fall through to 'Other' for a known type");
  });

rule("speaker_id / activity_id survive the CLIENT half of the round-trip (the stitch preserves identity)",
  (impl) => {
    useFormat(impl);
    const [msg] = impl.groupReports(WRAPPED);
    assert.equal(msg.speakerId, 777, "speakerId must survive continuation stitching");
    assert.equal(msg.activityId, 888, "activityId must survive continuation stitching");
    assert.equal(msg.activityEventId, 999, "activityEventId must survive continuation stitching");
    assert.deepEqual(msg.pos, POS1, "and so must the lead's location");
  },
  () => LOSSY);

// --- the SERVER half of the round-trip. Source-level, so it carries its own text seed. ---
const wireChecks = [
  {
    label: "the C++ EMITS the new wire fields on /notifications and /reports",
    // The JSON keys live inside C++ string literals, so they appear ESCAPED in the source:
    // `<< ",\"zoomType\":"`. Match that, not a bare "zoomType".
    assertOn: (aCpp, nCpp) => {
      for (const [name, src] of [["announcements.cpp", aCpp], ["notifications.cpp", nCpp]])
        for (const key of ["zoomType", "zoomType2", "hasPos2", "pos2",
                           "speakerId", "activityId", "activityEventId"])
          assert.ok(src.includes(`\\"${key}\\":`), `${name} must serialize the ${key} wire key`);
    },
    seedBad: (aCpp, nCpp) => [aCpp, nCpp.replace('\\"speakerId\\":', '\\"__gone\\":')],
  },
  {
    label: "the C++ HONOURS report_zoom_type::NONE instead of trusting a stale pos",
    assertOn: (aCpp, nCpp) => {
      for (const [name, src] of [["announcements.cpp", aCpp], ["notifications.cpp", nCpp]]) {
        assert.ok(src.includes("df/report_zoom_type.h"), `${name} must include the zoom-type enum`);
        assert.match(src, /zoom_type\s*!=\s*df::report_zoom_type::NONE\s*&&\s*valid_pos/,
          `${name}: has_pos must require a non-NONE zoom type, not just a valid pos`);
        assert.match(src, /zoom_type2\s*!=\s*df::report_zoom_type::NONE\s*&&\s*valid_pos/,
          `${name}: has_pos2 must do the same for the second location`);
      }
    },
    seedBad: (aCpp, nCpp) => [aCpp, nCpp.replace(/report->zoom_type != df::report_zoom_type::NONE && /, "")],
  },
  {
    label: "the C++ STRUCTS carry the second location + the identity fields",
    assertOn: (aH, nH) => {
      for (const [name, src] of [["announcements.h", aH], ["notifications.h", nH]])
        for (const field of ["zoom_type", "zoom_type2", "has_pos2", "pos2",
                             "activity_id", "activity_event_id", "speaker_id"])
          assert.match(src, new RegExp(`\\b${field}\\b`), `${name} must declare ${field}`);
    },
    seedBad: (aH, nH) => [aH, nH.replace(/\bspeaker_id\b/g, "spkr_gone")],
    args: () => [announceH, notifyH],
  },
];

// ---------------------------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------------------------
let passed = 0, failed = 0;
console.log("# TX14 announcements gate -- real module + real production markup\n");
for (const r of rules) {
  try { r.assertOn(FORMAT); passed++; console.log("  ok   - " + r.label); }
  catch (e) { failed++; console.log("  FAIL - " + r.label + "\n         " + (e && e.message)); }
}
for (const w of wireChecks) {
  const args = w.args ? w.args() : [announceCpp, notifyCpp];
  try { w.assertOn(...args); passed++; console.log("  ok   - " + w.label); }
  catch (e) { failed++; console.log("  FAIL - " + w.label + "\n         " + (e && e.message)); }
}

if (SELFTEST) {
  console.log("\n# --selftest: every rule must REJECT its seeded-bad (a rule that cannot fail is worse than none)");
  let caught = 0, missed = 0;
  for (const r of rules) {
    const bad = r.seedBad();
    let threw = false;
    try { r.assertOn(bad); } catch (_) { threw = true; }
    if (threw) { caught++; console.log("  ok   - REJECTED the pre-TX14 behaviour: " + r.label); }
    else { missed++; console.log("  FAIL - seeded-bad PASSED, the rule CANNOT FAIL: " + r.label); }
  }
  for (const w of wireChecks) {
    const args = w.args ? w.args() : [announceCpp, notifyCpp];
    const bad = w.seedBad(...args);
    assert.notEqual(JSON.stringify(bad), JSON.stringify(args),
      `seeded-bad for "${w.label}" changed nothing -- the seed is stale`);
    let threw = false;
    try { w.assertOn(...bad); } catch (_) { threw = true; }
    if (threw) { caught++; console.log("  ok   - REJECTED the pre-TX14 wire: " + w.label); }
    else { missed++; console.log("  FAIL - seeded-bad PASSED, the rule CANNOT FAIL: " + w.label); }
  }
  console.log(`\nselftest: ${caught} rules rejected their seeded-bad, ${missed} could not fail`);
  failed += missed;
  useFormat(FORMAT);
}

console.log(`\nTX14 announcements: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
