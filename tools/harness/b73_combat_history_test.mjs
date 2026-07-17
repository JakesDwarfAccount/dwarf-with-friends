// b73_combat_history_test.mjs -- offline acceptance for B73 (combat history reachable from a
// creature's profile menu; native parity: unit sheet -> that unit's combat log).
//
// Two halves:
//   (1) STRUCTURAL -- the unit sheet (dwf-unit-hud-notifications.js) renders a
//       [data-unit-combatlog] header button whose handler calls window.openCombatLogPanel({unitId})
//       (the existing native combat-log flow, dwf-combatlog-panel.js STATE B).
//   (2) BEHAVIOURAL -- load the REAL combat-log panel under a tiny DOM mock, invoke the exposed
//       window.openCombatLogPanel({unitId:42}), and assert it fetches THAT unit's per-unit combat
//       log (/combat-reports?unit=42) -- i.e. the entry point wires to the right unit, not a
//       fort-wide dump. (rule 2: verified against the real module's behaviour, not a claim.)
//
// Run: node tools/harness/b73_combat_history_test.mjs        (zero-dep, Node >= 18)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const unitPath = join(root, "web", "js", "dwf-unit-hud-notifications.js");
const clPath = join(root, "web", "js", "dwf-combatlog-panel.js");
const dwfuiPath = join(root, "web", "js", "dwf-ui-components.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };

for (const p of [unitPath, clPath]) {
  try { execFileSync(process.execPath, ["--check", p], { stdio: "pipe" }); check(`${p.split(/[\\/]/).pop()} node --check`, true); }
  catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }
}

// ---- (1) structural: the profile button + its handler ----------------------------------------
const unitSrc = readFileSync(unitPath, "utf8");
// WAVE 4 / S1: the header tool cluster moved from three hand-rolled emoji <button>s to native's
// banded DWFUI cluster (headerHtml toolRows -> UNIT_SHEET_VIEW_REPORTS / _CUSTOMIZE / _CAMERA_*), so
// the literal `data-unit-combatlog ... title="Combat history"` HTML no longer exists in the source --
// the attribute is now emitted by DWFUI from the `unitCombatlog` dataset key. This check follows the
// control, and additionally REJECTS the retired emoji (&#9876; crossed swords). The RENDERED proof --
// that the built markup really carries [data-unit-combatlog] on a UNIT_SHEET_VIEW_REPORTS tile -- is
// in tools/harness/wave4_unit_profile_test.mjs.
check("unit sheet renders a Combat history button through the native header cluster",
  /unitCombatlog:[\s\S]{0,80}title:\s*"Combat history"/.test(unitSrc) && !/&#9876;/.test(unitSrc));
check("handler opens the combat-log panel for THIS unit",
  /data-unit-combatlog[\s\S]{0,600}window\.openCombatLogPanel\(\{\s*unitId:\s*id/.test(unitSrc));
check("combat-log panel exposes window.openCombatLogPanel", /window\.openCombatLogPanel\s*=\s*openCombatLogPanel/.test(readFileSync(clPath, "utf8")));

// ---- (2) behavioural: the opener fetches the right unit's combat log --------------------------
const fetchUrls = [];
function fakeNode() {
  const n = {
    className: "", innerHTML: "", textContent: "", style: {}, scrollTop: 0, scrollHeight: 0,
    dataset: {},
    addEventListener() {}, removeEventListener() {}, remove() {}, appendChild() {}, focus() {},
    querySelector() { return fakeNode(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return n;
}
global.window = {};
global.DWFUI = require(dwfuiPath);
global.window.DWFUI = global.DWFUI;
global.document = {
  readyState: "complete",
  body: fakeNode(),
  head: fakeNode(),
  createElement() { return fakeNode(); },
  getElementById() { return null; },
  addEventListener() {}, removeEventListener() {},
};
global.setInterval = () => 0;
global.clearInterval = () => {};
global.setTimeout = (fn) => 0;   // don't actually re-run install hooks
global.fetch = (url) => {
  fetchUrls.push(String(url));
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ unitFound: true, entries: [], nextReportId: -1 }) });
};

require(clPath); // sets window.openCombatLogPanel + installs (guarded) hooks
check("window.openCombatLogPanel is callable after load", typeof global.window.openCombatLogPanel === "function");

const handle = global.window.openCombatLogPanel({ unitId: 42, unitName: "Urist McTest" });
check("opener returns a closeable handle", handle && typeof handle.close === "function");
const hit = fetchUrls.find(u => /\/combat-reports\?unit=42(\b|&)/.test(u));
check("entry point fetches THIS unit's combat log (/combat-reports?unit=42)", !!hit, `urls: ${JSON.stringify(fetchUrls)}`);
check("it is a per-unit log request, not a fort-wide /reports dump", !fetchUrls.some(u => /\/reports(\?|$)/.test(u)));
try { handle.close(); } catch (_) {}

// ---- WAVE-5 GATE C: the emitted markup, not the source text ------------------------------------
// A source regex for /DWFUI/ once reported "0 queued" while 467 controls bypassed the layer, so
// every claim below is asserted against the STRING THE PANEL ACTUALLY EMITS.
//
// Native oracles (both provenance "native"/"good" in tools/ui-lab/reference-provenance.json):
//   Menu Oracle Screenshots/combat log/combat log announcement click state.png      (report list)
//   Menu Oracle Screenshots/combat log/combat log announcement click unit drill down.png (full text)
// Both show ONE button per row, and its identity is what the row affords: the gold magnifier
// (STOCKS_VIEW_ITEM) on a row that references a UNIT, the recenter tile (RECENTER_RECENTER) on a row
// that references a PLACE. Never two buttons, and never a text button.
const CL = require(clPath);
const countButtons = html => (String(html).match(/<button/g) || []).length;

// Live fetched data used to replace the whole className and delete scrollHtml's `dwfui-scroll`
// membership. The static Studio card therefore looked correct while the shipping async path fell
// back to Chromium's scrollbar. Exercise both live modes through the real shared updater.
const liveRows = { className: "dwfui-scroll cl-rows cl-list" };
CL._clRenderDetail(liveRows, []);
check("live combat detail refresh preserves the shared DWFUI scrollbar class",
  liveRows.className.split(/\s+/).includes("dwfui-scroll") && liveRows.className.includes("cl-detail"), liveRows.className);
CL._clRenderList(liveRows, []);
check("live combat list refresh preserves the shared DWFUI scrollbar class",
  liveRows.className.split(/\s+/).includes("dwfui-scroll") && liveRows.className.includes("cl-list"), liveRows.className);
const seededBrowserFallback = { className: "dwfui-scroll cl-rows cl-list" };
seededBrowserFallback.className = "cl-rows cl-detail";
check("test-the-test: replacing the live className reproduces and detects the browser-scrollbar regression",
  !seededBrowserFallback.className.split(/\s+/).includes("dwfui-scroll"));

const unitRow = CL.clListRowsHtml([{ unitId: 7, label: "The Dog is fighting!", hasPos: true, reports: [] }]);
check("list row: exactly ONE button (native shows one per row, never a Zoom+Sheet pair)",
  countButtons(unitRow) === 1, unitRow);
check("list row referencing a UNIT is the gold magnifier STOCKS_VIEW_ITEM (native's sheet-open)",
  /data-dwfui-sprite="STOCKS_VIEW_ITEM"/.test(unitRow), unitRow);
check("list row keeps its sheet wire (.cl-sheet + data-i) so _clOpenSheet still dispatches",
  /class="[^"]*cl-sheet[^"]*"/.test(unitRow) && /data-i="0"/.test(unitRow), unitRow);
check("the raw 'Zoom'/'Sheet' TEXT buttons are gone",
  !/>Zoom</.test(unitRow) && !/>Sheet</.test(unitRow), unitRow);

// A row with no unit but a position keeps the ZOOM dispatch -- the handler is not stranded.
const placeRow = CL.clListRowsHtml([{ unitId: -1, label: "A place", hasPos: true, reports: [] }]);
check("list row referencing only a PLACE is the recenter tile RECENTER_RECENTER (zoom wire kept)",
  /data-dwfui-sprite="RECENTER_RECENTER"/.test(placeRow) && /class="[^"]*cl-zoom[^"]*"/.test(placeRow), placeRow);

// "An absent cell renders NOTHING. Native omits; it does not blank."
const bareRow = CL.clListRowsHtml([{ unitId: -1, label: "Nothing to do", hasPos: false, reports: [] }]);
check("a row that affords NEITHER renders no button at all (native omits, never blanks)",
  countButtons(bareRow) === 0, bareRow);

const detail = CL.clDetailRowsHtml([
  { text: "The dog bites!", hasPos: true, repeatCount: 0 },
  { text: "It is unmoved.", hasPos: false, repeatCount: 0 },
]);
check("drill-down: a POSITIONED line gets the recenter tile, an unpositioned one gets nothing",
  countButtons(detail) === 1 && /data-dwfui-sprite="RECENTER_RECENTER"/.test(detail), detail);
check("drill-down keeps its recenter wire (.cl-rc + data-i)",
  /class="[^"]*cl-rc[^"]*"/.test(detail) && /data-i="0"/.test(detail), detail);

// The instruction-line window: bitmap text, native art, and no hand-built glyph chrome.
const listPanel = CL.clPanelMarkup({ mode: "list", units: [] });
const unitPanel = CL.clPanelMarkup({ mode: "unit", groups: [] });
check("the instruction line is BITMAP text, not raw DOM text (the Studio/live divergence is closed)",
  /dwfui-bitmap-text/.test(listPanel) && /Select a report to view the full text/.test(listPanel), listPanel);
check("neither native combat-log state invents a back control",
  !/data-cl-back/.test(listPanel) && !/data-cl-back/.test(unitPanel), unitPanel);
check("neither native combat-log state invents a close tile",
  !/data-cl-close/.test(listPanel) && !/data-cl-close/.test(unitPanel), unitPanel);
check("both native combat-log states carry the upper-right report-sheet tile",
  /data-dwfui-sprite="UNIT_SHEET_VIEW_REPORTS"/.test(listPanel) &&
  /data-dwfui-sprite="UNIT_SHEET_VIEW_REPORTS"/.test(unitPanel), listPanel);

console.log(`\nB73 combat-history: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
