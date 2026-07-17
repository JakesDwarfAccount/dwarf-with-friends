// obligations_test.mjs -- OFFLINE fixture for WT15 (the summonable Obligations board). Exercises
// the pure aggregation of the two EXISTING wires (/nobles mandates + /petitions Location
// agreements) and the DWFUI-rendered rows. No DF process, network, or browser.
//   node tools/harness/obligations_test.mjs   (exit 0 PASS / 1 FAIL)
//
// DWFUI is loaded first so its `window.DWFUI` global is present when the obligations module's
// render helpers (rowHtml consumers) run under node -- same shape the browser sees.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..", "web", "js");
const modPath = join(web, "dwf-obligations.js");
const uiPath = join(web, "dwf-ui-components.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

for (const p of [uiPath, modPath]) {
  try { execFileSync(process.execPath, ["--check", p], { stdio: "pipe" }); check(`node --check ${p.split(/[\\/]/).pop()}`, true); }
  catch (e) { check(`node --check ${p.split(/[\\/]/).pop()}`, false, e.stderr ? e.stderr.toString() : e.message); }
}

// Load DWFUI onto the global so obligations' render helpers resolve `DWFUI` (browser parity).
const DWFUI = require(uiPath);
globalThis.DWFUI = DWFUI;
const M = require(modPath);

// ---------------------------------------------------------------------------------------------
console.log("\n# NOBLE MANDATES: normalize /nobles mandates array (who / item / made-required / time)");
const noblesPayload = {
  positions: [],
  mandates: [
    // Production mandate: 3 of 10 short swords still to make, 42 days left.
    { mode: "Make", unitId: 40, by: "Urist Mayor", material: "iron", item: "short sword",
      amountTotal: 10, amountRemaining: 3, daysRemaining: 42, hammerstrikes: 0 },
    // Export ban: standing (no deadline), punishes multiple offenders.
    { mode: "Export", unitId: 12, by: "The Monarch", material: "silver", item: "",
      amountTotal: 0, amountRemaining: 0, daysRemaining: -1, hammerstrikes: 3, punishMultiple: true },
  ],
};
const mand = M.mandateObligations(noblesPayload);
check("both mandates normalized", mand.length === 2);
check("production title reads 'Make <total> <material item>'", mand[0].title === "Make 10 iron short sword");
check("made/required progress = '<remaining>/<total> left'", mand[0].progressText === "3/10 left");
check("production time state = '<days> day(s) left'", mand[0].deadlineText === "42 day(s) left");
check("export ban title reads 'Do not export <material>'", mand[1].title === "Do not export silver");
check("export ban carries NO made/required (standing ban, not a count)", mand[1].progressText === "");
check("export ban with daysRemaining<0 is Ongoing", mand[1].ongoing === true && mand[1].deadlineText === "Ongoing");
check("mandate keeps unitId for the by-unit deep link", mand[0].unitId === 40 && mand[1].unitId === 12);

console.log("\n# NOBLE MANDATES: rendered row is a DWFUI row carrying the load-bearing text");
const mrow = M.mandateRowHtml(mand[0]);
check("mandate row is a DWFUI.rowHtml (dwfui-row + obl-mandate-row)", /class="dwfui-row obl-row obl-mandate-row"/.test(mrow));
check("row shows the made/required progress", mrow.includes("3/10 left"));
check("row shows the time state badge", mrow.includes("42 day(s) left") && mrow.includes("fort-badge"));
check("row shows who mandated it", mrow.includes("Urist Mayor"));

console.log("\n# graceful: /nobles error or no mandates");
check("no mandates array -> []", M.mandateObligations({ positions: [] }).length === 0);
check("nobles error object -> []", M.mandateObligations({ error: "world unavailable" }).length === 0);

// ---------------------------------------------------------------------------------------------
console.log("\n# GUILD HALLS & TEMPLES: filter Location agreements from /petitions, drop residents");
// New-server /petitions (B191): pending+continuing union. Location rows = guildhall/temple
// obligations; Residency/Citizenship rows are resident petitions that must NOT surface here.
const petPayload = {
  agreementCoverage: "pending+continuing",
  petitions: [
    { id: 12, summary: "Location", petitioner: "The Guild of Miners", site: "Boatmurdered",
      purpose: "", futurePolicy: "prompt", inPendingList: true, inContinuingList: false, pending: true, valid: true },
    { id: 13, summary: "Location", petitioner: "The Order of the Ash", site: "",
      purpose: "", futurePolicy: "", inPendingList: false, inContinuingList: true, pending: false, valid: true },
    { id: 20, summary: "Residency", petitioner: "Litast Bard", site: "Boatmurdered",
      purpose: "entertain people", inPendingList: true, inContinuingList: false, pending: true, valid: true },
    { id: 21, summary: "Citizenship", petitioner: "Zon Weaver", site: "Boatmurdered",
      purpose: "citizenship", inPendingList: false, inContinuingList: true, pending: false, valid: true },
  ],
};
const loc = M.locationObligations(petPayload);
check("feature detected via agreementCoverage witness", loc.supported === true);
check("only the 2 Location agreements surface (residents excluded)", loc.items.length === 2 && loc.items.every(i => i.id === 12 || i.id === 13));
check("pending Location -> 'Requested'", loc.items.find(i => i.id === 12).stateLabel === "Requested");
check("continuing Location -> 'Established'", loc.items.find(i => i.id === 13).stateLabel === "Established");
check("primary label prefers the site name when served", loc.items.find(i => i.id === 12).primary === "Boatmurdered");
check("primary falls back to petitioner when no site", loc.items.find(i => i.id === 13).primary === "The Order of the Ash");

console.log("\n# GUILD HALLS & TEMPLES: rendered rows");
const lrowP = M.locationRowHtml(loc.items.find(i => i.id === 12));
const lrowE = M.locationRowHtml(loc.items.find(i => i.id === 13));
check("location row is a DWFUI.rowHtml (dwfui-row + obl-location-row)", /class="dwfui-row obl-row obl-location-row"/.test(lrowP));
check("pending row shows the 'Requested' badge (open tone)", lrowP.includes("Requested") && lrowP.includes("fort-badge-open"));
check("established row shows the 'Established' badge (done tone)", lrowE.includes("Established") && lrowE.includes("fort-badge-done"));

console.log("\n# FEATURE DETECTION / HONEST DEGRADE");
// Old server: pending-only petitions, no agreementCoverage, no inContinuingList on rows.
const oldPet = { petitions: [
  { id: 5, summary: "Location", petitioner: "The Guild of Miners", site: "", purpose: "", pending: true },
] };
check("old server (no coverage witness, no inContinuingList) -> unsupported", M.obligationsFeatureSupported(oldPet) === false);
check("locationObligations reports supported=false on the old server", M.locationObligations(oldPet).supported === false);
// New server with zero location obligations still advertises coverage (witness present even empty).
const emptyNew = { agreementCoverage: "pending+continuing", petitions: [] };
check("new server with zero agreements is still supported (witness, not row-sniff)", M.obligationsFeatureSupported(emptyNew) === true);
check("supported + zero Location rows -> empty items, not an error", M.locationObligations(emptyNew).items.length === 0);
// Body renders the honest 'needs server update' line on the old server.
const bodyOld = M.obligationsBodyHtml(noblesPayload, oldPet);
check("body degrades honestly: guild/temple section shows 'need a server update'", /need a server update/.test(bodyOld));
check("body still renders the mandate section on the old server", bodyOld.includes("Make 10 iron short sword"));

console.log("\n# BODY: both sections present, DWFUI rows, no hand-rolled row grammar");
const body = M.obligationsBodyHtml(noblesPayload, petPayload);
check("body has the Noble mandates section title", body.includes("Noble mandates"));
check("body has the Guild halls & temples section title", body.includes("Guild halls"));
check("body mounts #obligationsRoot (the live-refresh open sentinel)", body.includes('id="obligationsRoot"'));
check("body renders both Location obligations", body.includes("Boatmurdered") && body.includes("The Order of the Ash"));

console.log("\n# feature detection via per-row flag (coverage witness absent but rows carry it)");
const rowFlagOnly = { petitions: [
  { id: 9, summary: "Location", petitioner: "X", inPendingList: false, inContinuingList: true, pending: false },
] };
check("inContinuingList on a row alone proves support", M.obligationsFeatureSupported(rowFlagOnly) === true);

console.log("\n# TEST-THE-TEST (seeded-bad must be discriminated)");
// 1) A resident (Citizenship/Residency) petition must NEVER be classified as a guildhall/temple.
guard("Residency petition is not a Location obligation", M.isLocationAgreement({ summary: "Residency" }) === false);
guard("Citizenship petition is not a Location obligation", M.isLocationAgreement({ summary: "Citizenship" }) === false);
// 2) A production mandate's made/required must not read the export-ban (empty) path.
guard("production mandate keeps a non-empty progress, unlike an export ban", mand[0].progressText !== "" && mand[1].progressText === "");
// 3) The old-server degrade must not silently invent 'Established' rows it cannot know about.
guard("old server never emits an Established/Requested Location row (unsupported gate)",
  M.locationObligations(oldPet).supported === false);
// 4) A continuing (non-pending) Location must be 'Established', not 'Requested' -- state-map guard.
guard("continuing Location maps to Established not Requested",
  loc.items.find(i => i.id === 13).stateLabel === "Established" && loc.items.find(i => i.id === 13).stateLabel !== "Requested");

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
