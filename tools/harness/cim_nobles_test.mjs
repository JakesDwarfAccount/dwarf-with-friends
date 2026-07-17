// cim_nobles_test.mjs -- OFFLINE fixture for R4 (CIM-Nobles and administrators.jpg): room-requirement
// icon states, demand/mandate icons (derived from served mandates), bookkeeper precision selector.
// No DF/server: seeded /nobles position + mandate records.
//   node tools/harness/cim_nobles_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const webJs = name => join(here, "..", "..", "web", "js", name);
const modPath = webJs("dwf-fort-admin.js");

// W5: the renderers now go through the DWFUI component layer, so the fixture boots the same globals
// the concatenated browser bundle provides. fortUnitRef/fortPrettyKey are the REAL ones out of
// dwf-fort-panels.js (not re-implemented stubs -- a stub would let the file drift while this
// stayed green, which is the precise failure mode this programme exists to kill).
globalThis.DWFUI = require(webJs("dwf-ui-components.js"));
globalThis.escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const P = require(webJs("dwf-fort-panels.js"));
globalThis.fortUnitRef = P.fortUnitRef;
globalThis.fortPrettyKey = P.fortPrettyKey;

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);

console.log("\n# room icon states (5 icons office/bedroom/dining/tomb/box)");
// Monarch analog: office/bedroom/dining/tomb all required AND satisfied; box not required.
const monarch = {
  filled: true, unitId: 12,
  rooms: { office: 100, bedroom: 100, dining: 100, tomb: 100, box: 0 },
  roomsSatisfied: { office: true, bedroom: true, dining: true, tomb: true },
};
const mst = M.nobleRoomIconStates(monarch);
check("returns 5 icon states in native order", mst.map(s => s.kind).join(",") === "office,bedroom,dining,tomb,box");
check("required+satisfied office -> green (required && satisfied===true)", mst[0].required === true && mst[0].satisfied === true);
check("not-required box -> gray (required===false)", mst[4].required === false);
check("box never carries a satisfaction bool (no server signal)", mst[4].satisfied === null);

// Mayor analog: office/bedroom/dining required & satisfied, tomb required but NOT satisfied (red-!).
const mayor = {
  filled: true, unitId: 40,
  rooms: { office: 50, bedroom: 50, dining: 50, tomb: 50, box: 0 },
  roomsSatisfied: { office: true, bedroom: true, dining: true, tomb: false },
};
const yst = M.nobleRoomIconStates(mayor);
check("required && !satisfied tomb -> red (satisfied===false)", yst[3].required === true && yst[3].satisfied === false);

console.log("\n# graceful degradation (old DLL served no room data)");
check("no `rooms` object -> [] (caller falls back to legacy text)", M.nobleRoomIconStates({ filled: true, unitId: 1 }).length === 0);

console.log("\n# demand / mandate icons (derived from served mandates by unitId)");
const mandates = [
  { mode: "Export", unitId: 12, hammerstrikes: 3 },   // Monarch: export ban w/ hammering -> red hammer
  { mode: "Make", unitId: 40, hammerstrikes: 0 },     // Mayor: make mandate -> red demand chest
  { mode: "Guild", unitId: 77, hammerstrikes: 0 },    // yellow hammer (no hammerstrikes)
];
const mi = M.nobleMandateIcons(monarch, mandates);
check("Monarch export mandate -> hammer red, no demand", mi.mandate === "red" && mi.demand === null);
const my = M.nobleMandateIcons(mayor, mandates);
check("Mayor make mandate -> demand red chest, no hammer", my.demand === "red" && my.mandate === null);
const guild = M.nobleMandateIcons({ filled: true, unitId: 77 }, mandates);
check("Guild mandate w/o hammerstrikes -> yellow hammer", guild.mandate === "yellow");
const none = M.nobleMandateIcons({ filled: true, unitId: 999 }, mandates);
check("no matching mandate -> both icons null (gray, never fabricated)", none.demand === null && none.mandate === null);

console.log("\n# bookkeeper precision selector (enum 0..4 -> button 1..5)");
check("precision 4 (all_accurate) -> button 5 highlighted", M.noblePrecisionActiveButton(4) === 5);
check("precision 0 (nearest_10) -> button 1 highlighted", M.noblePrecisionActiveButton(0) === 1);
check("precision -1 (NONE) -> no button highlighted", M.noblePrecisionActiveButton(-1) === -1);
check("out-of-range precision -> no highlight", M.noblePrecisionActiveButton(9) === -1);

console.log("\n# TEST-THE-TEST (seeded-bad must be discriminated)");
// Spec R4 seeded-bad: a position with required_office>0 and NO holder office must render RED, not green.
const unmetOffice = {
  filled: true, unitId: 7,
  rooms: { office: 100, bedroom: 0, dining: 0, tomb: 0, box: 0 },
  roomsSatisfied: { office: false, bedroom: false, dining: false, tomb: false },
};
const uo = M.nobleRoomIconStates(unmetOffice);
guard("required office w/ no owned office -> red (satisfied===false), NOT green", uo[0].required === true && uo[0].satisfied === false && uo[0].satisfied !== true);
// A demand icon must NOT light up for a position whose unit has no mandate (guards a false-positive join).
guard("Mayor's Make mandate does NOT leak onto the Monarch's demand chest", M.nobleMandateIcons(monarch, mandates).demand === null);

console.log("\n# NON-AUTHOR COUNTEREXAMPLE CELL 1: Champion (filled, ALL requirements 0)");
// A filled honorary position with no room requirements: every icon gray, no green/red, no mandate.
const champion = {
  filled: true, unitId: 55,
  rooms: { office: 0, bedroom: 0, dining: 0, tomb: 0, box: 0 },
  roomsSatisfied: { office: false, bedroom: false, dining: false, tomb: false },
};
const ch = M.nobleRoomIconStates(champion);
check("Champion: no icon reads required", ch.every(s => s.required === false));
check("Champion: no icon renders a green check (satisfied never true when !required)", ch.every(s => s.satisfied !== true));
check("Champion: no mandate/demand icon lights up", (() => { const x = M.nobleMandateIcons(champion, mandates); return x.demand === null && x.mandate === null; })());

console.log("\n# NON-AUTHOR COUNTEREXAMPLE CELL 2: unfilled position");
// nobleMandateIcons must ignore an unfilled position even if a stray mandate references unitId -1.
check("unfilled position -> no icons (unitId<0 short-circuits)", (() => { const x = M.nobleMandateIcons({ filled: false, unitId: -1 }, [{ mode: "Make", unitId: -1 }]); return x.demand === null && x.mandate === null; })());

// ---------------------------------------------------------------------------------------------
// W5 ADOPTION: THE EMITTED MARKUP. A green pure-function test proves nothing about what the screen
// renders -- the whole point of this gate is that "the builder must APPEAR IN THE EMITTED MARKUP".
// These cells render noblesBody() for real and read the HTML back.
// ---------------------------------------------------------------------------------------------
console.log("\n# W5 emitted markup: the noble room strip is DF ART, not emoji");
const noblesData = {
  positions: [
    // Mayor: office/bedroom/dining satisfied, tomb required-but-NOT-satisfied, no coffer requirement.
    { name: "Mayor", positionId: 3, assignmentId: 1, filled: true, unitId: 40, holder: "Urist McMayor",
      rooms: { office: 50, bedroom: 50, dining: 50, tomb: 50, box: 0 },
      roomsSatisfied: { office: true, bedroom: true, dining: true, tomb: false } },
    // Bookkeeper: carries the 1..5 accounting-precision strip.
    { name: "Bookkeeper", positionId: 4, assignmentId: 2, filled: true, unitId: 41, holder: "Urist McBooks",
      rooms: { office: 10, bedroom: 0, dining: 0, tomb: 0, box: 0 },
      roomsSatisfied: { office: true, bedroom: false, dining: false, tomb: false } },
    // Baron: VACANT -- native draws no room icons here, but the [+] assign tile still renders.
    { name: "Baron", positionId: 5, assignmentId: -1, filled: false, unitId: -1, holder: "" },
  ],
  mandates: [{ mode: "Make", unitId: 40, hammerstrikes: 0, by: "Urist McMayor",
    amountTotal: 3, amountRemaining: 1, daysRemaining: 12, material: "iron", item: "short sword" }],
  bookkeeperPrecision: 4,
};
const nb = M.noblesBody(noblesData);

check("room icons render as NOBLES_* sprites through iconHtml",
  /data-dwfui-sprite="NOBLES_OFFICE_GOOD"/.test(nb) && /data-dwfui-sprite="NOBLES_BEDROOM_GOOD"/.test(nb));
check("required && !satisfied tomb -> NOBLES_TOMB_MISSING (not GOOD)",
  /data-dwfui-sprite="NOBLES_TOMB_MISSING"/.test(nb) && !/NOBLES_TOMB_GOOD/.test(nb));
check("not-required coffer -> NOBLES_FURN_NA (DF names the coffer family FURN)",
  /data-dwfui-sprite="NOBLES_FURN_NA"/.test(nb));
check("self-framed native cell: no generic icon box is drawn around DF's own frame",
  /dwfui-icon--native-cell/.test(nb));
// The headline defect: 42 NOBLES_* sprites existed and the file drew EMOJI instead.
const EMOJI = /&#(129681|128719|127860|9904|128230|128188|128296|128081);/;
check("ZERO emoji entities remain in the emitted nobles markup", !EMOJI.test(nb));
check("ZERO inline hex colours remain in the emitted nobles markup",
  !/style="[^"]*#[0-9a-fA-F]{3,6}/.test(nb));

console.log("\n# W5 emitted markup: the mandate/demand clock cells");
check("Mayor's Make mandate -> the DEMANDS clock lights (not a briefcase emoji)",
  /data-dwfui-sprite="NOBLES_DEMANDS_TIME_WARN_3"/.test(nb));
check("no mandate for the Mayor -> MANDATES clock renders its real NA tile (native never renders nothing)",
  /data-dwfui-sprite="NOBLES_MANDATES_NA"/.test(nb));

console.log("\n# W5 emitted markup: bookkeeper precision strip (10 NOBLES_ACCOUNTING_* sprites)");
check("precision 4 -> step 5 renders its ACTIVE sprite",
  /data-dwfui-sprite="NOBLES_ACCOUNTING_5_ACTIVE"/.test(nb));
check("the other four steps render their INACTIVE sprites",
  /data-dwfui-sprite="NOBLES_ACCOUNTING_1_INACTIVE"/.test(nb) &&
  /data-dwfui-sprite="NOBLES_ACCOUNTING_4_INACTIVE"/.test(nb));
check("exactly ONE accounting step is active (it is a radiogroup)",
  (nb.match(/NOBLES_ACCOUNTING_\d_ACTIVE/g) || []).length === 1);

console.log("\n# W5 THE WIRE IS THE CONTRACT: every hook still dispatches");
check("[+] assign keeps data-noble-assign AND now renders NOBLES_ADD",
  /data-noble-assign="3"/.test(nb) && /data-dwfui-sprite="NOBLES_ADD"/.test(nb));
check("crown keeps its disabled placeholder + renders NOBLES_ASSIGN_SYMBOL",
  /data-dwfui-sprite="NOBLES_ASSIGN_SYMBOL"/.test(nb) && /dwfui-btn--placeholder/.test(nb));
check("precision buttons keep data-noble-precision (0..4 enum, unchanged)",
  /data-noble-precision="0"/.test(nb) && /data-noble-precision="4"/.test(nb));
check("rows go through DWFUI.rowHtml's table chassis", /dwfui-row--table/.test(nb));
check("the pinned classnames CSS + tests select on all survive",
  /fort-row-noble/.test(nb) && /fort-cell-who/.test(nb) && /fort-cell-sub/.test(nb) &&
  /fort-cell-main/.test(nb) && /fort-assign-btn/.test(nb) && /fort-crown-btn/.test(nb));
check("unit names render through the bitmap-text layer", /data-dwfui-bitmap-text="Urist McMayor"/.test(nb));
check("SUPERSET PRESERVED: the Active mandates list still renders its wire detail",
  /Active mandates/.test(nb) && /iron short sword/.test(nb) && /12 day\(s\) left/.test(nb));
check("NATIVE BLURB PRESERVED (visible in CIM-Nobles and administrators.jpg)",
  /Members of the nobility have required rooms/.test(nb));

console.log("\n# TEST-THE-TEST (W5 seeded-bad must be discriminated)");
// The fixed 5-track grid places children BY ORDER: dropping the empty sub cell would slide the crown
// into the sub column. A VACANT row has no icons and no requirements text -> its sub cell is EMPTY,
// and it must STILL be emitted.
const vacantRow = nb.slice(nb.indexOf("Baron"));
guard("VACANT row still emits its (empty) sub cell, so the 5-track grid does not shift",
  /fort-cell-sub/.test(vacantRow.slice(0, 900)));
guard("VACANT row STILL offers [+] (removing it would delete a wired capability)",
  /data-noble-assign="5"/.test(nb));
// A room that is required and unsatisfied must never reach the GOOD art.
const bk = M.nobleRoomIconHtml({ required: true, satisfied: false, art: "OFFICE", label: "Office" });
guard("required+unsatisfied never emits the GOOD sprite",
  /NOBLES_OFFICE_MISSING/.test(bk) && !/NOBLES_OFFICE_GOOD/.test(bk));
// The four-state is a FOUR-state: it must not be collapsed into a tri-state.
guard("all four room states are distinct tokens (GOOD/PARTIAL/MISSING/NA)",
  new Set(["GOOD", "PARTIAL", "MISSING", "NA"].map(s => M.nobleRoomSprite(
    { art: "OFFICE", required: s !== "NA", satisfied: s === "GOOD" ? true : s === "MISSING" ? false : null }))).size === 4);

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
