// cim_justice_test.mjs -- OFFLINE fixture for R3 (CIM-justice-*.jpg): master-detail helpers +
// Intelligence tab chrome. No DF/server: seeded /justice crime + convict records.
//   node tools/harness/cim_justice_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const webJs = name => join(here, "..", "..", "web", "js", name);
const modPath = webJs("dwf-fort-admin.js");

// W5: justiceBody() now renders through the DWFUI component layer, so the fixture boots the same
// globals the concatenated browser bundle provides -- including the REAL fortUnitRef out of
// dwf-fort-panels.js, so a drift in that shared helper cannot hide behind a stub here.
globalThis.DWFUI = require(webJs("dwf-ui-components.js"));
globalThis.escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const P = require(webJs("dwf-fort-panels.js"));
globalThis.fortUnitRef = P.fortUnitRef;
globalThis.fortPrettyKey = P.fortPrettyKey;
// The browser supplies this from the unit-sheet module; the row falls back to a letter tile without
// it, and the letter path is a declared BLOCKER, not a fallback -- so mimic the real bundle.
globalThis.unitPortraitMarkup = (u, cls) =>
  `<span class="${cls}" data-portrait-unit="${u.unitId}"></span>`;

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);
const pretty = s => String(s).replace(/([a-z])([A-Z])/g, "$1 $2"); // stand-in for fortPrettyKey

console.log("\n# Intelligence tab chrome (rename + verbatim)");
const intel = M.JUSTICE_MODES.find(m => m.key === "counterintel");
check("6th sub-tab labelled 'Intelligence' (not Counterintelligence)", intel && intel.label === "Intelligence");
check("Intelligence verbatim empty state pinned", intel && intel.empty === "There is no intelligence information yet.");
check("server mode KEY unchanged ('counterintel' contract preserved)", !!intel && intel.key === "counterintel");

console.log("\n# crime-mode labels (CIM-justice-closed cases.jpg)");
check("production-order enum -> 'Violation of production order'", M.justiceCrimeModeLabel("ProductionOrderViolation", pretty) === "Violation of production order");
check("export enum -> 'Violation of export prohibition'", M.justiceCrimeModeLabel("ExportProhibitionViolation", pretty) === "Violation of export prohibition");
check("unknown enum -> prettyFn fallback (no fabrication)", M.justiceCrimeModeLabel("Vandalism", pretty) === "Vandalism");

console.log("\n# case detail lines (closed / open)");
// Closed case: sentenced, has victim + criminal (CIM-justice-closed cases.jpg).
const closed = { mode: "ProductionOrderViolation", sentenced: true, victim: "Tobul Oddomguz, duchess of Wanesword", victimId: 12, criminal: "Ducim Tulontolun, Bone Doctor", criminalId: 88, accused: "Ducim Tulontolun", accusedId: 88 };
const cl = M.justiceCaseDetailLines(closed);
check("closed case -> Injured party then Convicted", cl.map(l => l.kind).join(",") === "injured,convicted");
check("injured party is the victim", cl[0].name.startsWith("Tobul") && cl[0].unitId === 12);
check("convicted is the criminal", cl[1].name.startsWith("Ducim") && cl[1].label === "Convicted");

// Open case: not sentenced, accused known, no victim.
const open = { mode: "ProductionOrderViolation", sentenced: false, victim: "", victimId: -1, criminal: "", criminalId: -1, accused: "Sibrek Thestarerib", accusedId: 5 };
const op = M.justiceCaseDetailLines(open);
check("open case (unsentenced, accused only) -> single Accused line", op.length === 1 && op[0].kind === "accused" && op[0].unitId === 5);

console.log("\n# TEST-THE-TEST (seeded-bad must be discriminated)");
// A crime with NO injured party must yield ZERO injured lines -- never "Injured party: .".
const noVictim = { mode: "ProductionOrderViolation", sentenced: true, victim: "", victimId: -1, criminal: "X", criminalId: 3, accused: "X", accusedId: 3 };
const nv = M.justiceCaseDetailLines(noVictim);
guard("null victim produces NO injured-party line", nv.some(l => l.kind === "injured") === false);
guard("null victim still shows the convicted line", nv.some(l => l.kind === "convicted") === true);
// The bad shape (would-be blank name) must be excluded, not rendered blank.
const blank = { sentenced: false, victim: "   ", victimId: -1, accused: "", accusedId: -1 };
guard("whitespace-only victim + no accused -> zero lines (no blank-name rows)", M.justiceCaseDetailLines(blank).length === 0);

// ---------------------------------------------------------------------------------------------
// W5 ADOPTION: THE EMITTED MARKUP. The builder must APPEAR IN THE EMITTED MARKUP -- a green
// pure-function test says nothing about what the screen actually draws.
// ---------------------------------------------------------------------------------------------
console.log("\n# W5 emitted markup: the Fortress guard branch is the CONVICT UNIT ROW");
// Native (CIM-justice-Fortress guard.jpg) draws a guard member with the IDENTICAL anatomy as a
// convict -- portrait, name, [recenter][magnifier]. This branch used to hand-build a bare name row.
const guardData = { guard: { squadId: 2, members: [
  { unitId: 61, name: "Kogan Ducimtulon" }, { unitId: 62, name: "Sibrek Thestarerib" }] } };
const gb = M.justiceBody(guardData, { mode: "guard" });
check("guard rows now render the shared convict unit row (not a hand-built .fort-row)",
  /justice-convict-row/.test(gb) && !/<div class="fort-row">/.test(gb));
check("guard rows carry the portrait tile", /data-portrait-unit="61"/.test(gb));
check("guard rows carry the [recenter] tile, wired to the camera+profile hook",
  /data-justice-recenter="61"/.test(gb) && /data-dwfui-sprite="STOCKS_RECENTER"/.test(gb));
check("guard rows carry the [magnifier] tile as STOCKS_VIEW_ITEM (opens a sheet; never `inspect`)",
  /data-dwfui-sprite="STOCKS_VIEW_ITEM"/.test(gb) && /data-unit-id="62"/.test(gb));
check("guard member names render through the bitmap-text layer",
  /data-dwfui-bitmap-text="Kogan Ducimtulon"/.test(gb));
// WIRE GAP: mode=guard serves {unitId,name} only -- no profession. Native OMITS a cell it has no
// data for. An omitted cell must render NOTHING, never a blank one.
check("no profession cell is invented for guard members (the wire serves none)",
  !/dwfui-sub/.test(gb));

const oracleGuard = M.justiceBody({ guard: { desiredCurrent: 0, desiredTotal: 38,
  selectedUnitId: 61, members: [
    { unitId: 61, name: "Mistem Ishashducim", profession: "captain of the guard" },
    { unitId: 62, name: "Catten Ledbhem", profession: "hammerer" },
  ] } }, { mode: "guard" });
check("exact guard anatomy includes the desired-cages count and native sort strip",
  /Desired metal cages and chains in dungeons: 0 of 38/.test(oracleGuard) &&
  /class="dwfui-sort-head justice-sort"/.test(oracleGuard));
check("exact guard anatomy includes profession lines and selects the first native row",
  /captain of the guard/.test(oracleGuard) && /hammerer/.test(oracleGuard) &&
  /justice-convict-row[^\"]* dwfui-row--sel-outline/.test(oracleGuard));

console.log("\n# W5 emitted markup: convicts keep their case selection (Pardon depends on it)");
const convictData = { convicts: [
  { crimeId: 7, unitId: 88, name: "Ducim Tulontolun", mode: "ProductionOrderViolation",
    prisonTime: 120, hammerstrikes: 0, victim: "Tobul Oddomguz", victimId: 12 },
  { crimeId: 9, unitId: 90, name: "Aban Girtharlim", mode: "ExportProhibitionViolation",
    prisonTime: 0, hammerstrikes: 0, victim: "", victimId: -1 }] };
const cb = M.justiceBody(convictData, { mode: "convicts", selectedCase: 7 });
check("a convict row DOES carry data-justice-case (it drives the detail pane)",
  /data-justice-case="7"/.test(cb));
check("the selected convict row carries the gold OUTLINE, and the fill is not changed",
  /dwfui-row--sel-outline/.test(cb) && !/background:/.test(cb));
// NB: plaqueBtnHtml escapes the title, so the apostrophe arrives as &#39; -- match the escaped form.
check("SUPERSET PRESERVED: Pardon still renders for the serving convict, with its ledger tooltip",
  /data-justice-pardon="88"/.test(cb) && /dwfui-plaque grey justice-pardon/.test(cb) &&
  /clears any pending hammerstrikes/.test(cb));
check("detail lines render through the bitmap-text layer",
  /data-dwfui-bitmap-text="Injured party:"/.test(cb));

console.log("\n# W5 emitted markup: the master/detail split no longer inlines its layout");
check("justiceMasterDetailHtml emits NO inline style (the CSS owner already promoted the layout)",
  /class="justice-master-detail"/.test(cb) && !/justice-master-detail" style=/.test(cb));
check("the two mount points survive (they host the master list and Pardon)",
  /class="justice-case-list"/.test(cb) && /class="justice-case-detail"/.test(cb));
check("gridHtml's gold divider is NOT painted here (native shows no rule between the panes)",
  !/dwfui-grid/.test(cb));

const exactClosed = M.justiceBody({ crimes: [closed] }, { mode: "closed", selectedCase: 0 });
check("closed-case detail does not invent a repeated crime title or year",
  /Injured party:/.test(exactClosed) && /Convicted:/.test(exactClosed) &&
  !/justice-detail-title/.test(exactClosed) && !/Year /.test(exactClosed));

console.log("\n# W5: invented-but-approved empty states are PRESERVED (conflict C-5)");
const openEmpty = M.justiceBody({ crimes: [] }, { mode: "open" });
check("'No open cases.' survives (workshop-picker/no-results is a APPROVED anchor for no-result copy)",
  /No open cases\./.test(openEmpty));
check("'No cold cases.' survives", /No cold cases\./.test(M.justiceBody({ crimes: [] }, { mode: "cold" })));
check("Intelligence still reproduces its two verbatim native lines",
  /There is no intelligence information yet\./.test(M.justiceBody({}, { mode: "counterintel" })) &&
  /an interrogation may reveal the plot/.test(M.justiceBody({}, { mode: "counterintel" })));

console.log("\n# TEST-THE-TEST (W5 seeded-bad must be discriminated)");
// A guard member has NO crime. Emitting data-justice-case for one would make it falsely selectable
// and would push NaN into the shared selection state on click.
guard("a guard row does NOT emit data-justice-case (it is not a case)", !/data-justice-case/.test(gb));
guard("a guard row does NOT claim role=option (there is no listbox / no detail pane)",
  !/role="option"/.test(gb));
// The convict row is Gate-C approved: reusing it for guard must not have changed the convict output.
guard("reuse did not regress the convict row: it still carries BOTH case + option semantics",
  /data-justice-case="9"/.test(cb) && /role="option"/.test(cb));
// B227 UPDATE: [Convict]/[Interrogate] ARE now built -- on OPEN cases only, native-driven
// server-side (hostwrites_fixture_test.mjs covers them). The CONVICTS tab must still not carry
// them: a sentenced case cannot be re-convicted, so a convict row growing those controls would
// be a fabricated capability.
guard("no [Interrogate]/[Convict] control leaked onto the CONVICTS tab (sentenced cases)",
  !/data-justice-interrogate/.test(cb) && !/data-justice-convict=/.test(cb));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
