// combatlog_fixture_test.mjs -- OFFLINE fixture test for the combat-log panel's pure
// data-shapers (clGroupReports / clCombatRows / clUnitGroups / clMergeFollow / clLogLabel).
// Runs with NO Dwarf Fortress and NO server: it exercises the client grouping/merge logic
// against SEEDED JSON spanning the variant matrix (single/multi-line, has-pos/no-pos, per-log,
// live-follow overlap, empty) -- plus deliberately-bad rows (completeness rule 3, "test the
// test") that MUST be discriminated.
//
//   node tools/harness/combatlog_fixture_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// The panel browser-safe-exports its shapers behind `typeof module !== 'undefined'`, so a
// CommonJS require pulls them in without executing any DOM/fetch code.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const panelPath = join(here, "..", "..", "web", "js", "dwf-combatlog-panel.js");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
// A seeded-bad assertion: the GOOD behavior is `cond` true; the test-the-test passes iff the
// shaper correctly produced the good behavior on a malformed/edge input (i.e. cond is true).
function checkGuard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}
function noThrow(name, fn) {
  try { const v = fn(); passed++; console.log(`  ok - ${name} (no throw)`); return v; }
  catch (e) { failed++; console.log(`  FAIL - ${name} threw: ${e.message}`); return undefined; }
}

// node --check on the panel file (syntax gate).
try {
  execFileSync(process.execPath, ["--check", panelPath], { stdio: "pipe" });
  passed++; console.log("  ok - dwf-combatlog-panel.js passes node --check");
} catch (e) {
  failed++; console.log(`  FAIL - node --check: ${e.stderr ? e.stderr.toString() : e.message}`);
}

const M = require(panelPath);
check("module exports all pure shapers",
  ["clGroupReports", "clCombatRows", "clUnitGroups", "clUnitDrilldownGroups", "clMergeFollow",
   "clLogLabel", "clFightingLabel", "clAlertUnitRows", "clCombatAlertByType"].every(k => typeof M[k] === "function"));

// helper: a raw /reports-style report row.
const R = (id, text, cont, extra = {}) => ({
  id, text, continuation: !!cont, color: 7, bright: false, year: 250, time: 1000,
  hasPos: false, pos: null, repeatCount: 0, ...extra,
});

// ---------------- clGroupReports: continuation joining ----------------
console.log("\n# clGroupReports");

// single-line message -> one group, one line.
{
  const g = M.clGroupReports([R(1, "The goblin looks surprised.", false)]);
  check("single-line -> 1 group", g.length === 1);
  check("single-line lineCount == 1", g[0] && g[0].lineCount === 1);
  check("single-line leadId preserved", g[0] && g[0].leadId === 1);
}

// multi-line message (lead + 2 continuation lines) -> ONE group, joined text, lineCount 3.
{
  const g = M.clGroupReports([
    R(10, "The macedwarf strikes the goblin in the head", false),
    R(11, "with her copper mace and the severed part sails off", true),
    R(12, "in an arc!", true),
  ]);
  check("multi-line -> 1 group (not 3)", g.length === 1, `got ${g.length}`);
  check("multi-line lineCount == 3", g[0] && g[0].lineCount === 3);
  check("multi-line text joined with spaces",
    g[0] && g[0].text === "The macedwarf strikes the goblin in the head with her copper mace and the severed part sails off in an arc!");
  check("multi-line leadId is the LEAD id (10)", g[0] && g[0].leadId === 10);
}

// two separate single-line messages -> two groups (no accidental merge across leads).
{
  const g = M.clGroupReports([R(20, "A stabs B.", false), R(21, "C dodges D.", false)]);
  check("two leads -> 2 groups", g.length === 2);
}

// interleaved: lead, tail, new lead, tail -> exactly two groups with correct join.
{
  const g = M.clGroupReports([
    R(30, "Blow one part A", false), R(31, "part B", true),
    R(40, "Blow two part A", false), R(41, "part B", true),
  ]);
  check("interleaved runs -> 2 groups", g.length === 2, `got ${g.length}`);
  check("interleaved group1 joined", g[0] && g[0].text === "Blow one part A part B");
  check("interleaved group2 joined", g[1] && g[1].text === "Blow two part A part B");
}

// has-pos carried through onto the group.
{
  const g = M.clGroupReports([R(50, "Zoomable!", false, { hasPos: true, pos: { x: 5, y: 6, z: 7 } })]);
  check("hasPos carried onto group", g[0] && g[0].hasPos === true && g[0].pos && g[0].pos.z === 7);
}

// repeatCount carried (native "x101").
{
  const g = M.clGroupReports([R(60, "It is raining.", false, { repeatCount: 100 })]);
  check("repeatCount carried", g[0] && g[0].repeatCount === 100);
}

// TEST-THE-TEST: an orphan continuation (tail with NO lead) must NOT vanish and must NOT be
// merged into an unrelated later group -- it becomes its own group flagged orphanContinuation.
{
  const g = M.clGroupReports([R(70, "orphan tail with no lead", true), R(71, "real lead", false)]);
  checkGuard("orphan continuation preserved as its own group", g.length === 2, `got ${g.length}`);
  checkGuard("orphan flagged orphanContinuation", g[0] && g[0].orphanContinuation === true);
  checkGuard("real lead NOT contaminated by the orphan's text",
    g[1] && g[1].text === "real lead" && g[1].orphanContinuation === false);
}

// TEST-THE-TEST: a continuation line whose lead ended the previous run still only attaches to
// the CURRENT open group, never re-opens a closed one.
{
  const g = M.clGroupReports([R(80, "lead", false), R(81, "tail", true)]);
  checkGuard("tail attaches to its immediate lead only", g.length === 1 && g[0].lineCount === 2);
}

// robustness: garbage inputs never throw.
noThrow("clGroupReports(null)", () => M.clGroupReports(null));
noThrow("clGroupReports([null, undefined, {}])", () => M.clGroupReports([null, undefined, {}]));
noThrow("clGroupReports(non-array)", () => M.clGroupReports(42));

// ---------------- clCombatRows: fort-wide payload, newest-first ----------------
console.log("\n# clCombatRows");
{
  const page = { reports: [R(100, "old fight", false), R(101, "new fight", false)] };
  const rows = M.clCombatRows(page);
  check("clCombatRows -> newest first", rows.length === 2 && rows[0].leadId === 101 && rows[1].leadId === 100);
}
{
  const rows = M.clCombatRows({ reports: [] });
  check("clCombatRows(empty) -> []", Array.isArray(rows) && rows.length === 0);
}
noThrow("clCombatRows(undefined)", () => M.clCombatRows(undefined));

// ---------------- clUnitGroups: per-unit payload, tagged + newest-first ----------------
console.log("\n# clUnitGroups");
{
  // /combat-reports wraps each report as {logType, logKey, report:{...}}.
  const E = (id, text, cont, logKey) => ({ logType: 0, logKey, report: R(id, text, cont) });
  const page = { unitFound: true, entries: [
    E(200, "Sparring bout begins", false, "Sparring"),
    E(201, "Combat strike lead", false, "Combat"),
    E(202, "combat strike tail", true, "Combat"),
  ]};
  const rows = M.clUnitGroups(page);
  check("clUnitGroups collapses the combat run", rows.length === 2, `got ${rows.length}`);
  check("clUnitGroups newest-first (combat group on top)", rows[0].leadId === 201);
  check("clUnitGroups keeps the logKey tag", rows[0].logKey === "Combat" && rows[1].logKey === "Sparring");
  check("clUnitGroups joined combat text",
    rows[0].text === "Combat strike lead combat strike tail" && rows[0].lineCount === 2);
}
{
  const rows = M.clUnitGroups({ unitFound: true, entries: [] });
  check("clUnitGroups(empty log) -> []", Array.isArray(rows) && rows.length === 0);
}

// ---------------- clMergeFollow: live-follow append + dedup ----------------
console.log("\n# clMergeFollow");
{
  const prev = M.clCombatRows({ reports: [R(300, "first", false)] });       // [{leadId:300}]
  const incoming = M.clCombatRows({ reports: [R(301, "second", false)] });  // [{leadId:301}]
  const merged = M.clMergeFollow(prev, incoming);
  check("merge appends the new group", merged.length === 2);
  check("merge preserves prior order (300 then 301)", merged[0].leadId === 300 && merged[1].leadId === 301);
}
// TEST-THE-TEST: an overlapping leadId (server re-sends a boundary report) must NOT double-append.
{
  const prev = [{ leadId: 400 }, { leadId: 401 }];
  const incoming = [{ leadId: 401 }, { leadId: 402 }]; // 401 overlaps
  const merged = M.clMergeFollow(prev, incoming);
  checkGuard("overlapping leadId deduped (no double 401)", merged.length === 3);
  checkGuard("dedup keeps single 401", merged.filter(g => g.leadId === 401).length === 1);
}
noThrow("clMergeFollow(null,null)", () => M.clMergeFollow(null, null));

// ---------------- clLogLabel ----------------
console.log("\n# clLogLabel");
check("label combat", M.clLogLabel("Combat") === "Combat" && M.clLogLabel("combat") === "Combat");
check("label sparring/hunting", M.clLogLabel("SPARRING") === "Sparring" && M.clLogLabel("hunting") === "Hunting");
check("label fallback", M.clLogLabel(null) === "Combat log" && M.clLogLabel("weird") === "Combat log");

// ---------------- clUnitDrilldownGroups: CHRONOLOGICAL (native full-report order) ----------------
console.log("\n# clUnitDrilldownGroups");
{
  const E = (id, text, cont) => ({ logType: 0, logKey: "Combat", report: R(id, text, cont) });
  const page = { unitFound: true, entries: [
    E(500, "first strike", false),
    E(501, "first strike tail", true),
    E(510, "second strike", false),
    E(520, "third strike", false),
  ]};
  const groups = M.clUnitDrilldownGroups(page);
  check("drilldown collapses continuation run", groups.length === 3, `got ${groups.length}`);
  // TEST-THE-TEST: native shows OLDEST first (newest at the bottom). If anyone reversed it to
  // match the newest-first LIST order, this fails -- the two orderings are deliberately different.
  checkGuard("drilldown is chronological oldest-first (500,510,520)",
    groups[0].leadId === 500 && groups[1].leadId === 510 && groups[2].leadId === 520,
    `got ${groups.map(g => g.leadId).join(",")}`);
  checkGuard("drilldown != clUnitGroups order (which is newest-first)",
    M.clUnitGroups(page)[0].leadId === 520 && groups[0].leadId === 500);
}
noThrow("clUnitDrilldownGroups(undefined)", () => M.clUnitDrilldownGroups(undefined));

// ---------------- clFightingLabel: DF banner composition (oracle-verified) ----------------
// Ground truth = the exact strings in the 3 the owner combat-log screenshots vs the live
// /notifications `unitName` (DFHack getReadableName) that produced them.
console.log("\n# clFightingLabel");
const LABEL_ORACLE = [
  ['Sigun Matlolok "Bendgranite", Metalcrafter', "combat", "The Metalcrafter Sigun Matlolok is fighting!"],
  ['Urdim Zegrith "Tattoobells", expedition leader', "combat", "The expedition leader Urdim Zegrith is fighting!"],
  ['Sodel Rulustuth "Mutedfence", Mason', "combat", "The Mason Sodel Rulustuth is fighting!"],
  ["Gray Langur", "combat", "The Gray Langur is fighting!"],
  ["Dog (tame)", "combat", "The Dog is fighting!"],
  ["Coati", "combat", "The Coati is fighting!"],
];
for (const [name, cat, want] of LABEL_ORACLE) {
  check(`label "${name}" -> "${want}"`, M.clFightingLabel(name, cat) === want,
    `got "${M.clFightingLabel(name, cat)}"`);
}
// Sparring/Hunting verbs end in a PERIOD, not "!" -- the DF binary's own report-tab strings
// ("sparring." / "hunting." vs the "fighting!" banner), extracted from Dwarf Fortress.exe.
check("sparring category -> is sparring.", M.clFightingLabel("Gray Langur", "Sparring") === "The Gray Langur is sparring.");
check("hunting category -> is hunting.", M.clFightingLabel("Cat (tame)", "hunting") === "The Cat is hunting.");
check("unknown category defaults to fighting", M.clFightingLabel("Elk Bird", "weird") === "The Elk Bird is fighting!");
// TEST-THE-TEST: malformed / edge names must never throw and must not emit a broken banner.
checkGuard("empty name -> nameless fallback, not 'The  is fighting!'",
  M.clFightingLabel("", "combat") === "Is fighting!");
checkGuard("nickname-only leftover handled", M.clFightingLabel('"Ironblood"', "combat") === "Is fighting!");
checkGuard("multi-comma name uses LAST role split",
  M.clFightingLabel('Ast Somer "X", Y, Militia Captain', "combat") === "The Militia Captain Ast Somer, Y is fighting!");
noThrow("clFightingLabel(null,null)", () => M.clFightingLabel(null, null));

// ---------------- clAlertUnitRows + clCombatAlertByType: State-A list from /notifications ----------------
console.log("\n# clAlertUnitRows / clCombatAlertByType");
{
  // A COMBAT alert shaped like the live /notifications payload, order = DF's report_unid order.
  const uref = (unitId, unitName, pos, reports) => ({
    unitId, category: 0, categoryKey: "Combat", unitName,
    dismissKey: `u:${unitId}:0`, pos: pos || null, reports: reports || [],
  });
  const combatAlert = { type: 34, typeKey: "COMBAT", unitReports: [
    uref(5513, "Dog (tame)", { x: 61, y: 65, z: 160 }, [R(1, "bite", false)]),
    uref(6132, "Gray Langur", null, []),
    uref(5508, 'Sigun Matlolok "Bendgranite", Metalcrafter', { x: 67, y: 67, z: 160 }, []),
  ]};
  const state = { alerts: [
    { type: 20, typeKey: "JOB_FAILED", unitReports: [] },
    combatAlert,
    { type: 35, typeKey: "SPARRING", unitReports: [uref(9001, "Recruit Someone", null, [])] },
  ]};

  const rows = M.clAlertUnitRows(combatAlert);
  check("alert rows: one per unit", rows.length === 3, `got ${rows.length}`);
  check("alert rows preserve DF order (Dog, Langur, Metalcrafter)",
    rows[0].unitId === 5513 && rows[1].unitId === 6132 && rows[2].unitId === 5508);
  check("alert rows compose the native label",
    rows[0].label === "The Dog is fighting!" && rows[2].label === "The Metalcrafter Sigun Matlolok is fighting!");
  check("alert row hasPos reflects the ref pos", rows[0].hasPos === true && rows[1].hasPos === false);
  check("alert row carries inline reports for the immediate drill-down paint",
    Array.isArray(rows[0].reports) && rows[0].reports.length === 1);
  // Prefer a future server-supplied combatLabel when present (graceful upgrade path).
  const withLabel = M.clAlertUnitRows({ type: 34, unitReports: [
    { unitId: 7, categoryKey: "Combat", unitName: "Whatever", combatLabel: "The Legend is fighting!" }]});
  checkGuard("server combatLabel overrides client composition",
    withLabel[0].label === "The Legend is fighting!");

  check("byType(34) finds the combat alert", M.clCombatAlertByType(state, 34) === combatAlert);
  check("byType(35) finds the sparring alert", M.clCombatAlertByType(state, 35).type === 35);
  check("byType(null) -> first combat-family alert (34)", M.clCombatAlertByType(state, null) === combatAlert);
  check("byType(21) with no such alert -> null", M.clCombatAlertByType(state, 21) === null);
  // TEST-THE-TEST: a non-combat alert must never be treated as combat-family.
  checkGuard("byType(null) skips the non-combat JOB_FAILED alert",
    M.clCombatAlertByType({ alerts: [{ type: 20, unitReports: [] }] }, null) === null);
}
noThrow("clAlertUnitRows(null)", () => M.clAlertUnitRows(null));
noThrow("clCombatAlertByType(null,null)", () => M.clCombatAlertByType(null, null));

// ---------------- B216 defect 1: opening the combat log must NOT move the camera ----------------
// The combat-family alert-click hook opens the panel; it used to ALSO recenterOnAlert(alert), which
// jerked the camera to the alert's surface z on every open. Opening a panel is not a jump-to-event.
{
  const src = readFileSync(panelPath, "utf8");
  const hook = /function _clCombatAlertClick\(e\) \{[\s\S]*?\n  \}/.exec(src);
  check("the combat-alert click hook exists in source", !!hook, hook ? "" : "regex missed _clCombatAlertClick");
  if (hook) {
    // Strip `//` comments first -- the code comment legitimately NAMES the removed call while
    // explaining the fix; the assertion must catch a real CALL, not a mention in prose.
    const hookCode = hook[0].replace(/\/\/[^\n]*/g, "");
    check("B216: combat-log open does NOT recenter the camera (no recenterOnAlert on click)",
      !/recenterOnAlert/.test(hookCode), "recenterOnAlert still called in the open hook");
    check("B216: the click hook still opens the combat log panel",
      /openCombatLogPanel\(\{\s*alertType/.test(hookCode));
    // TEST-THE-TEST: a seeded hook that recenters must be caught by the assertion above.
    checkGuard("a seeded recenter-on-open hook is detected as bad",
      /recenterOnAlert/.test('function _clCombatAlertClick(e) { recenterOnAlert(alert); openCombatLogPanel({ alertType: type }); }'
        .replace(/\/\/[^\n]*/g, "")));
  }
  // recenterOnAlert's only caller was this hook; it is removed from the notifications module too.
  const notifSrc = readFileSync(join(here, "..", "..", "web", "js", "dwf-unit-hud-notifications.js"), "utf8");
  check("B216: the now-dead recenterOnAlert definition is gone from the notifications module",
    !/function recenterOnAlert\b/.test(notifSrc));
}

// ---------------- summary ----------------
console.log(`\n${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
