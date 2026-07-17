// b227_justice_ui_test.mjs -- OFFLINE fixture for B227's BROWSER surface: the guard-aware justice
// screen (open-case list, named parties, convict/interrogate actions).
//   node tools/harness/b227_justice_ui_test.mjs   (exit 0 PASS / 1 FAIL)
//
// The engine (native drive + probe flags) shipped in wave/host-writes and is covered by
// hostwrites_fixture_test.mjs. What THIS suite pins is the client contract that wave left open:
//
//   * the two drives are locked behind host flags (`justice_convict` / `justice_interrogate` in
//     dfcapture-hostwrites.json -- a MISSING file means everything off), and a locked action must
//     render VISIBLY DISABLED with its flag name and an honest reason -- never a live-looking
//     button that 501s after the click;
//   * the flags ride a live poll of GET /justice-convict, so flipping one on the host lights the
//     button up on its own -- no reload, no rebuild;
//   * the browser only ever offers the case's NAMED parties on OPEN cases (v1 scope);
//   * the client's guard key names actually match the ones the server emits (a rename on either
//     side would silently disable every button forever -- that is the bug this contract check
//     exists to catch).
//
// No DF, no server, no network: seeded /justice + /justice-convict payloads.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const webJs = name => join(here, "..", "..", "web", "js", name);
const repo = name => join(here, "..", "..", name);
const modPath = webJs("dwf-fort-admin.js");

// Same bundle bootstrap the other CIM fixtures use (real DWFUI + real fort-panels helpers, so a
// drift in a shared helper cannot hide behind a stub here).
globalThis.DWFUI = require(webJs("dwf-ui-components.js"));
globalThis.escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const P = require(webJs("dwf-fort-panels.js"));
globalThis.fortUnitRef = P.fortUnitRef;
globalThis.fortPrettyKey = P.fortPrettyKey;
globalThis.unitPortraitMarkup = (u, cls) => `<span class="${cls}" data-portrait-unit="${u.unitId}"></span>`;

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);
const src = readFileSync(modPath, "utf8");
const lua = readFileSync(repo("dwf.lua"), "utf8");

// ---- seeded payloads ---------------------------------------------------------------------------
// GET /justice?mode=open -- two open cases, one with a distinct accused + criminal.
const CASES = [
  { id: 12, mode: "ProductionOrderViolation", sentenced: false, discovered: true, needsTrial: true,
    year: 205, prisonTime: 0, hammerstrikes: 0, witnessCount: 1,
    accusedId: 77, accused: "Urist McSuspect", criminalId: -1, criminal: "",
    victimId: 5, victim: "Litast Bookkeeper" },
  { id: 13, mode: "Theft", sentenced: false, discovered: true, needsTrial: true,
    year: 205, prisonTime: 0, hammerstrikes: 0, witnessCount: 0,
    accusedId: 80, accused: "Kib Accused", criminalId: 81, criminal: "Zon Criminal",
    victimId: -1, victim: "" },
];
// GET /justice-convict -- hw_justice_state's shape (dwf.lua).
const hostState = (convict, interrogate) => ({
  ok: true, guards: { justiceConvict: convict, justiceInterrogate: interrogate },
  infoOpen: false, justiceMode: false, currentTab: "OPEN_CASES", convicting: false,
  interrogating: false, convictCrimeIds: [], caseRows: 2,
});
const ON = hostState(true, true);
const OFF = hostState(false, false);

// ================================================================================================
console.log("\n# guard state: fails CLOSED on every unknown");
check("no host state at all (endpoint unreachable) -> convict LOCKED",
  M.justiceActionState(null, "convict").enabled === false);
check("...and the reason blames the host, not the player",
  /not reporting its justice action flags/.test(M.justiceActionState(null, "convict").reason));
check("host answered but the flag is off -> LOCKED, and the reason NAMES the flag + the file",
  (() => { const s = M.justiceActionState(OFF, "convict");
    return s.enabled === false && /"justice_convict"/.test(s.reason) &&
      /dfcapture-hostwrites\.json/.test(s.reason); })());
check("interrogate names ITS OWN flag (not the convict one)",
  (() => { const s = M.justiceActionState(OFF, "interrogate");
    return /"justice_interrogate"/.test(s.reason) && !/"justice_convict"/.test(s.reason); })());
check("flag on -> enabled, no reason", M.justiceActionState(ON, "convict").enabled === true &&
  M.justiceActionState(ON, "convict").reason === "");
check("the two flags are INDEPENDENT (convict on, interrogate off)",
  (() => { const half = hostState(true, false);
    return M.justiceActionState(half, "convict").enabled === true &&
      M.justiceActionState(half, "interrogate").enabled === false; })());
guard("a truthy-but-not-true flag ('true', 1) does NOT unlock (strict === true, like the server)",
  M.justiceActionState({ ok: true, guards: { justiceConvict: "true" } }, "convict").enabled === false &&
  M.justiceActionState({ ok: true, guards: { justiceConvict: 1 } }, "convict").enabled === false);
guard("guards:{} (host wrote an empty flag file) is NOT read as 'all on'",
  M.justiceActionState({ ok: true, guards: {} }, "convict").enabled === false);

console.log("\n# the locked copy is honest, plain English, and actionable");
const reason = M.JUSTICE_GUARD_COPY.convict;
check("it says the feature EXISTS and is locked (not 'unsupported', not a 501 code)",
  /locked/.test(reason) && !/501/.test(reason) && !/unsupported/i.test(reason));
check("it promises the live unlock (no reload) -- which is what the poll delivers",
  /unlocks live/.test(reason) && /no reload/.test(reason));
check("it states who does the writing: Dwarf Fortress itself",
  /Dwarf Fortress itself performs the conviction/.test(reason));

console.log("\n# the action strip (open cases only)");
const stripOff = M.justiceCaseActionsHtml(CASES[0], "open", OFF);
const stripOn = M.justiceCaseActionsHtml(CASES[0], "open", ON);
check("locked: both buttons carry the HTML `disabled` attribute (a disabled button fires no click)",
  (stripOff.match(/ disabled>/g) || []).length === 2);
check("locked: the reason is on each button's title AND in a visible note (no hover on touch)",
  /title="[^"]*justice_convict[^"]*"/.test(stripOff) && /justice-guard-note/.test(stripOff));
check("locked: BOTH reasons are noted when both flags are off (convict + interrogate)",
  /justice_convict/.test(stripOff) && /justice_interrogate/.test(stripOff));
check("unlocked: no disabled attribute, and no locked note is printed",
  !/disabled/.test(stripOn) && !/justice-guard-note/.test(stripOn));
check("unlocked: the wire datasets are the crime id + the unit id the server expects",
  /data-justice-convict="12" data-justice-unit="77"/.test(stripOn) &&
  /data-justice-interrogate="12" data-justice-unit="77"/.test(stripOn));
// A button tag is "live" iff it has no `disabled` attribute. Used by the half-locked case and by
// the test-the-test below, so both talk about the same thing.
const buttonTags = html => (html.match(/<button[^>]*data-justice-(?:convict|interrogate)[^>]*>/g) || []);
const liveTags = html => buttonTags(html).filter(b => !/ disabled>/.test(b));
check("half-locked: convict live, interrogate disabled (each flag gates only its own button)",
  (() => { const half = M.justiceCaseActionsHtml(CASES[0], "open", hostState(true, false));
    const live = liveTags(half);
    return buttonTags(half).length === 2 && live.length === 1 &&
      /data-justice-convict/.test(live[0]) && /justice_interrogate/.test(half); })());
check("v1 scope holds: no actions on closed/cold cases, none on a sentenced case",
  M.justiceCaseActionsHtml(CASES[0], "closed", ON) === "" &&
  M.justiceCaseActionsHtml(CASES[0], "cold", ON) === "" &&
  M.justiceCaseActionsHtml(Object.assign({}, CASES[0], { sentenced: true }), "open", ON) === "");

console.log("\n# the parties the browser is allowed to offer");
check("a case with a distinct accused AND criminal offers both, accused first",
  (() => { const p = M.justiceCaseParties(CASES[1]);
    return p.length === 2 && p[0].id === 80 && p[1].id === 81; })());
check("accused == criminal collapses to ONE party", M.justiceCaseParties(
  { accusedId: 8, accused: "A", criminalId: 8, criminal: "A" }).length === 1);
check("a nameless-but-real party is offered as 'unit N' (never a blank button)",
  M.justiceCaseParties({ accusedId: 9, accused: "", criminalId: -1 })[0].name === "unit 9");
guard("seeded-bad: a party with id -1 is NOT offered (there is nobody to convict)",
  M.justiceCaseParties({ accusedId: -1, accused: "Ghost", criminalId: -1, criminal: "" }).length === 0);

console.log("\n# justiceBody: the case list + the guarded detail pane");
const bodyOff = M.justiceBody({ crimes: CASES }, { mode: "open", selectedCase: 12, hostState: OFF });
const bodyOn = M.justiceBody({ crimes: CASES }, { mode: "open", selectedCase: 13, hostState: ON });
check("every open case is listed as a selectable case plaque",
  /data-justice-case="12"/.test(bodyOff) && /data-justice-case="13"/.test(bodyOff));
check("the crime kind is rendered natively ('Violation of production order')",
  /Violation of production order/.test(bodyOff.replace(/<[^>]+>/g, "")) ||
  /Violation of production order/.test(bodyOff));
check("the selected case's detail pane names the parties (Accused / Injured party)",
  /Accused/.test(bodyOff) && /Injured party/.test(bodyOff));
check("the detail pane's actions follow the selection (case 13 -> its own accused, unit 80)",
  /data-justice-convict="13" data-justice-unit="80"/.test(bodyOn));
check("with the flags off, NO live action button exists anywhere in the screen",
  buttonTags(bodyOff).length > 0 && liveTags(bodyOff).length === 0);
check("empty open-cases list is the native empty state, not a broken pane",
  /No open cases\./.test(M.justiceBody({ crimes: [] }, { mode: "open", hostState: ON })));
// TEST-THE-TEST: the "no live button" assertion above is only worth anything if the SAME predicate
// finds live buttons when the flags ARE on. If liveTags() were broken (e.g. a regex that never
// matches), the flags-off check would pass vacuously -- this is the discriminator.
// (Case 13 names an accused AND a distinct criminal -> two parties -> four buttons.)
guard("liveTags() DOES find live buttons with the flags on (the flags-off check is not vacuous)",
  buttonTags(bodyOn).length === 4 && liveTags(bodyOn).length === 4 &&
  liveTags(M.justiceBody({ crimes: CASES },
    { mode: "open", selectedCase: 13, hostState: null })).length === 0);

console.log("\n# client <-> server contract (the rename trap)");
check("the client READS the guards from GET /justice-convict (read-only; no POST to fetch state)",
  /\/justice-convict\?player=/.test(src) && /justiceHostState\s*=\s*\(state && state\.ok\)/.test(src));
check("the client POLLS, so a flag flip on the host unlocks the buttons with no reload",
  /justicePollTimer\s*=\s*setInterval/.test(src) && /refreshFortAdminData\(\)/.test(src));
check("the poll re-renders ONLY on change (an idle poll must not eat the selection)",
  /if \(now === last\) return;/.test(src));
check("the poll stops when the justice panel closes (no orphan timer hammering the server)",
  /justiceStopPoll\(\); return;/.test(src));
check("guard KEY NAMES match the server's emitted keys exactly (justiceConvict/justiceInterrogate)",
  /"justiceConvict":%s,"justiceInterrogate":%s/.test(lua) &&
  /guards\[key\] !== true/.test(src) && /justiceConvict" : "justiceInterrogate"/.test(src));
check("FLAG NAMES in the client copy match the server's flag file keys (justice_convict/_interrogate)",
  /justice_convict/.test(lua) && /justice_interrogate/.test(lua) &&
  /"justice_convict"/.test(M.JUSTICE_GUARD_COPY.convict) &&
  /"justice_interrogate"/.test(M.JUSTICE_GUARD_COPY.interrogate));
check("the drive refuses locally when locked (a stale render racing a flag flip cannot POST)",
  /const state = justiceActionState\(justiceHostState, kind\);[\s\S]{0,120}if \(!state\.enabled\)/.test(src));
guard("seeded-bad: renaming the server's guard key would break the contract check above",
  !/"justiceConvicted":%s/.test(lua));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
