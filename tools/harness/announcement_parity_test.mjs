// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = path => readFileSync(join(root, path), "utf8");
const js = read("web/js/dwf-unit-hud-notifications.js");
const reports = read("web/js/dwf-announcements.js");
const html = read("web/index.html");
const css = read("web/css/dwf.css");
let failed = 0;
function check(name, fn) { try { fn(); console.log("PASS " + name); } catch (e) { failed++; console.error("FAIL " + name + ": " + e.message); } }

// ---- WAVE-5: THE POPUP'S CONTROLS ARE NOW ASSERTED ON THE EMITTED MARKUP, NOT ON SOURCE TEXT ----
// Two checks below used to grep the SOURCE for the hand-rolled string
// ``pinned && line.report ? `<div class="alert-popup-actions"`` and for the literal `data-popup-center=`.
// A source regex is not proof (a green `assert.match(source, /DWFUI/)` once reported "0 queued" while
// 467 controls bypassed the layer), and both regexes pinned markup that the DWFUI migration correctly
// stopped hand-writing -- the datasets are now built by actionButtonsHtml from `dataset:{popupCenter}`.
// So the module is IMPORTED and the real HTML is rendered: the assertions are STRICTLY STRONGER --
// they prove the attribute actually reaches the DOM, that the pinned/hover split still holds, that the
// builder is what draws it, and that the two Unicode arrows are gone in favour of DF's own sprites.
globalThis.window = { setTimeout, addEventListener() {} };
globalThis.fetch = async () => ({ ok: false });
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.DWFUI = (await import("../../web/js/dwf-ui-components.js")).default;
const M = await import("../../web/js/dwf-unit-hud-notifications.js");

const POPUP_ALERT = {
  type: 21, dismissKey: "a:21", iconIndex: 3,
  reports: [
    { id: 41, text: "Urist has been struck down.", color: 4, bright: true, pos: { x: 10, y: 20, z: 5 } },
    { id: 42, text: "A vile force of darkness has arrived!", color: 4, bright: false },
  ],
  unitReports: [],
};
const pinnedPopup = M.alertPopupMarkup(POPUP_ALERT, true);
const hoverPopup = M.alertPopupMarkup(POPUP_ALERT, false);

check("hover uses native read-only instruction and click uses native interactive instruction", () => {
  assert.match(js, /Left click for recenter and expand options\. Right click to dismiss\./);
  assert.match(js, /You can recenter on certain announcements\. Right click to close\./);
  // the copy is verbatim-native (ALERTS-2 / ALERTS-3) and reaches the rendered popup
  assert.match(hoverPopup, /Left click for recenter and expand options\. Right click to dismiss\./);
  assert.match(pinnedPopup, /You can recenter on certain announcements\. Right click to close\./);
  // the per-line action cluster is PINNED-ONLY -- the hover popup is read-only
  assert.match(pinnedPopup, /class="dwfui-actions alert-popup-actions"/);
  assert.doesNotMatch(hoverPopup, /alert-popup-actions/);
});
check("test-the-test: old generic instruction is rejected", () => {
  assert.doesNotMatch(js, /Left click to recenter\.\s*&nbsp;Right click to dismiss\./);
});
check("click rows have individual dismiss and recenter hooks", () => {
  // the WIRE, proved on the emitted markup rather than on a source string
  assert.match(pinnedPopup, /data-popup-center="41"/);
  assert.match(pinnedPopup, /data-popup-dismiss="r:41"/);
  assert.match(pinnedPopup, /data-popup-dismiss="r:42"/);
  assert.match(js, /dismissAlertKeys/);
  assert.doesNotMatch(js, /button\.addEventListener\("click"[\s\S]{0,180}recenterOnAlert\(alert\)/);
});
check("WAVE-5: popup controls are native SPRITES, not Unicode arrows, and are built by DWFUI", () => {
  // recenter -> RECENTER_RECENTER; dismiss -> BUILDING_JOBS_REMOVE (TOKENS.sprites.close)
  assert.match(pinnedPopup, /data-dwfui-sprite="RECENTER_RECENTER"/);
  assert.match(pinnedPopup, /data-dwfui-sprite="BUILDING_JOBS_REMOVE"/);
  // both are complete native control cells -> self-framed, so no generic button box is drawn
  assert.match(pinnedPopup, /data-dwfui-self-framed="true"/);
  // the emoji/Unicode stand-ins are GONE from the rendered popup
  assert.doesNotMatch(pinnedPopup, /&#8594;/);
  assert.doesNotMatch(pinnedPopup, /&times;/);
});
check("WAVE-5: a report with NO zoom target keeps its recenter tile DISABLED (gap reserved, not collapsed)", () => {
  // ALERTS-2: rows with no target show no tile. `.alert-popup-action:disabled{visibility:hidden}`
  // reserves the gap, so the tiles on neighbouring rows do not shift. Report 42 has no pos.
  assert.match(pinnedPopup, /data-popup-center="42"[^>]*disabled|disabled[^>]*data-popup-center="42"/);
  assert.match(css, /\.alert-popup-action:disabled\s*\{\s*visibility:\s*hidden/);
});
check("WAVE-5: the whole-alert Dismiss superset survives the migration as a native text plaque", () => {
  assert.match(pinnedPopup, /data-popup-dismiss-alert/);
  assert.match(pinnedPopup, /class="dwfui-plaque[^"]*alerts-action alert-dismiss-all"/);
  assert.doesNotMatch(hoverPopup, /data-popup-dismiss-alert/);   // pinned-only, as before
});
check("no bottom-left announcement stream exists", () => {
  for (const source of [html, css, js]) assert.doesNotMatch(source, /announceTicker/);
});

check("reports window uses the shared DWFUI shell, header, and scroll region", () => {
  assert.match(reports, /DWFUI\.windowHtml\(/);
  assert.match(reports, /DWFUI\.headerHtml\(/);
  assert.match(reports, /DWFUI\.scrollHtml\(\{ cls: "info-body rep-list"/);
});
check("test-the-test: a seeded ticker is caught", () => {
  assert.match(html + '<div id="announceTicker"></div>', /announceTicker/);
});
check("B232 R2: the siege/artifact strips live ONLY in the reports screen, keyed on the raws taxonomy", () => {
  // The dashboard's copy filtered on `typeKey === "SIEGE"` / `"ARTIFACT_CREATED"` -- tokens DF
  // does not have (B160's dead code). It is deleted with the dashboard. The comments in both
  // files deliberately QUOTE the dead code, so scan CODE, not prose.
  const code = source => source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const source of [js, reports]) {
    assert.doesNotMatch(code(source), /typeKey\s*===\s*"(SIEGE|ARTIFACT_CREATED)"/);
    assert.doesNotMatch(source, /includes\([^)]*(siege|artifact)/i);
  }
  // the REAL strips: repSpecialSections, taxonomy-keyed, failing open when a strip is empty
  assert.match(reports, /function repSpecialSections/);
  assert.match(reports, /repSectionOf\(report\) === key/);
  assert.match(reports, /if \(!rows\.length\) return ""/);
});
check("DF_COLORS private table is gone and the shared DWFUI palette resolver is used", () => {
  assert.doesNotMatch(js, /\bDF_COLORS\b/);
  // dfTextColor now routes report color+bright through DWFUI.dfColor -- the single native-color
  // resolver (text-color spec §3.2), which itself reads DWFUI.TOKENS.palette / the live --df-cN
  // vars. No local 16-color table is kept in this file (drift rule R1).
  assert.match(js, /DWFUI\.dfColor\(/);
  assert.doesNotMatch(js, /\[\[p\.dfBlack,\s*p\.dfDarkGray\]/); // the old inline 8x2 rows table is gone
});

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
