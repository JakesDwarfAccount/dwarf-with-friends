// hospital_fixture_test.mjs -- OFFLINE fixture test for the Wave 3.3 hospital panel's pure
// data-shapers (supplyRows / furnitureText / chiefMedicalText / doctorRows / patientRows /
// queueRows). Runs with NO Dwarf Fortress and NO server: it exercises the client rendering logic
// against SEEDED JSON -- good rows AND deliberately-bad rows (completeness rule 3, "test the
// test") -- and asserts graceful, honest output (no throw, correct exclusions, clamped levels).
//
//   node tools/harness/hospital_fixture_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// The panel file browser-safe-exports its shapers behind `typeof module !== 'undefined'`, so a
// CommonJS require pulls them in without executing any DOM/fetch code.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const panelPath = join(here, "..", "..", "web", "js", "dwf-hospital-panel.js");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
// A seeded-bad assertion is EXPECTED false; the test passes iff it is correctly detected false.
function checkSeededBad(name, cond) {
  if (!cond) { passed++; console.log(`  ok - (test-the-test) ${name} -> correctly detected`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name} -> NOT discriminated`); }
}
function noThrow(name, fn) {
  try { const v = fn(); passed++; console.log(`  ok - ${name} (no throw)`); return v; }
  catch (e) { failed++; console.log(`  FAIL - ${name} threw: ${e.message}`); return undefined; }
}

// node --check on the panel file (syntax gate).
try {
  execFileSync(process.execPath, ["--check", panelPath], { stdio: "pipe" });
  passed++; console.log("  ok - dwf-hospital-panel.js passes node --check");
} catch (e) {
  failed++; console.log(`  FAIL - node --check: ${e.stderr ? e.stderr.toString() : e.message}`);
}

// WAVE 5: the supply steppers render through DWFUI.stepperHtml({art:true}), so the fixture must mirror the
// BROWSER LOAD ORDER (ui-components loads first). Requiring it also publishes globalThis.DWFUI,
// which is how the panel resolves it at call time.
globalThis.DWFUI = require(join(here, "..", "..", "web", "js", "dwf-ui-components.js"));
const M = require(panelPath);
check("module exports the 6 shapers",
  ["supplyRows", "furnitureText", "chiefMedicalText", "doctorRows", "patientRows", "queueRows"]
    .every(k => typeof M[k] === "function"));

// ---------------- supplyRows (scale/level display + clamp + needMore) ----------------
console.log("TEST: supplyRows");
// The server already divides raw by scale and sends desiredLevel/countLevel. These fixtures
// mirror the seven supplies (matrix: each scale class -- x1, x15000, x10000, x150) at level 5.
const infoSupplies = {
  ok: true,
  supplies: [
    { key: "splints",  label: "Splints",  scale: 1,     desiredRaw: 5,     countRaw: 2,     desiredLevel: 5,  countLevel: 2, needMore: true },
    { key: "thread",   label: "Thread",   scale: 15000, desiredRaw: 75000, countRaw: 30000, desiredLevel: 5,  countLevel: 2, needMore: true },
    { key: "cloth",    label: "Cloth",    scale: 10000, desiredRaw: 50000, countRaw: 0,     desiredLevel: 5,  countLevel: 0, needMore: true },
    { key: "plaster",  label: "Plaster",  scale: 150,   desiredRaw: 750,   countRaw: 150,   desiredLevel: 5,  countLevel: 1, needMore: true },
    { key: "buckets",  label: "Buckets",  scale: 1,     desiredRaw: 0,     countRaw: 0,     desiredLevel: 0,  countLevel: 0, needMore: false },
  ],
};
const srows = noThrow("supplyRows on good payload", () => M.supplyRows(infoSupplies));
check("supplyRows returns 5 rows", srows && srows.length === 5);
check("level echoed from desiredLevel (thread=5)", srows.find(r => r.key === "thread").level === 5);
check("count echoed from countLevel (plaster=1)", srows.find(r => r.key === "plaster").count === 1);
check("needMore true propagated", srows.find(r => r.key === "cloth").needMore === true);
check("level 0 clears needMore (buckets)", srows.find(r => r.key === "buckets").needMore === false);
check("inc target = level+1 clamped (splints 5->6)", srows.find(r => r.key === "splints").inc === 6);
check("dec target = level-1 (splints 5->4)", srows.find(r => r.key === "splints").dec === 4);
check("dec floors at 0 (buckets 0->0)", srows.find(r => r.key === "buckets").dec === 0);
// inc ceiling at 99.
check("inc ceils at 99", M.supplyRows({ supplies: [{ key: "soap", desiredLevel: 99 }] })[0].inc === 99);
// Seeded-bad: NaN level -> 0 (no NaN leaks into the stepper).
const nanRow = noThrow("supplyRows on NaN level", () => M.supplyRows({ supplies: [{ key: "thread", desiredLevel: "abc", countLevel: NaN }] }));
check("NaN desiredLevel coerced to 0", nanRow[0].level === 0);
check("NaN countLevel coerced to 0", nanRow[0].count === 0);
check("bad: null info -> [] no throw", noThrow("supplyRows(null)", () => M.supplyRows(null)).length === 0);
check("bad: supplies not array -> []", M.supplyRows({ supplies: "nope" }).length === 0);
check("bad: null entries filtered", M.supplyRows({ supplies: [null, { key: "soap", desiredLevel: 1 }] }).length === 1);
check("bad: keyless entry dropped", M.supplyRows({ supplies: [{ desiredLevel: 3 }] }).length === 0);
checkSeededBad("NaN level (wrongly) survives as NaN", Number.isNaN(nanRow[0].level));
checkSeededBad("negative level (wrongly) not clamped", M.supplyRows({ supplies: [{ key: "soap", desiredLevel: -4 }] })[0].level < 0);

// ---------------- furnitureText ----------------
console.log("TEST: furnitureText");
check("furnitureText pluralises", /2 beds/.test(M.furnitureText({ furniture: { beds: 2, tables: 1, tractionBenches: 1, containers: 3 } })));
check("furnitureText singular bed", /1 bed\b/.test(M.furnitureText({ furniture: { beds: 1 } })));
check("furnitureText traction plural is 'benches'", /traction benches/.test(M.furnitureText({ furniture: { tractionBenches: 2 } })));
check("bad: missing furniture -> zeros no throw", /0 beds/.test(noThrow("furnitureText({})", () => M.furnitureText({}))));

// ---------------- chiefMedicalText ----------------
console.log("TEST: chiefMedicalText");
check("no position -> create-in-nobles line", /No Chief Medical Dwarf position/.test(M.chiefMedicalText({ chiefMedical: { found: false } })));
check("found+filled -> name", /Urist/.test(M.chiefMedicalText({ chiefMedical: { found: true, filled: true, name: "Urist" } })));
check("found+vacant -> vacant line", /vacant/i.test(M.chiefMedicalText({ chiefMedical: { found: true, filled: false } })));
check("bad: null info -> create line no throw", noThrow("chiefMedicalText(null)", () => M.chiefMedicalText(null)).length > 0);

// ---------------- doctorRows ----------------
console.log("TEST: doctorRows");
const docInfo = { doctors: [
  { unitId: 10, name: "Doc A", profession: "Doctor", labors: ["diagnose", "surgery"] },
  { unitId: 11, name: "Doc B", profession: "Bone Doctor", labors: ["bonesetting"] },
]};
const drows = noThrow("doctorRows good", () => M.doctorRows(docInfo));
check("doctorRows returns 2", drows.length === 2);
check("labor keys mapped to labels", drows[0].labors.includes("Diagnosis") && drows[0].labors.includes("Surgery"));
check("unknown labor key passes through", M.doctorRows({ doctors: [{ unitId: 1, labors: ["mystery"] }] })[0].labors[0] === "mystery");
check("bad: negative unitId dropped", M.doctorRows({ doctors: [{ unitId: -1, labors: [] }] }).length === 0);
check("bad: doctors not array -> []", M.doctorRows({ doctors: 5 }).length === 0);
check("bad: non-array labors -> [] labors no throw", noThrow("doctorRows bad labors", () => M.doctorRows({ doctors: [{ unitId: 2, labors: "x" }] }))[0].labors.length === 0);

// ---------------- patientRows ----------------
console.log("TEST: patientRows");
const patData = { patients: [
  { unitId: 20, name: "Wounded One", profession: "Miner", woundCount: 3, inTraction: true, flags: ["Needs surgery", "Needs suturing"] },
  { unitId: 21, name: "Sick Two", profession: "Farmer", woundCount: 0, inTraction: false, flags: ["Needs diagnosis"] },
]};
const prows = noThrow("patientRows good", () => M.patientRows(patData));
check("patientRows returns 2", prows.length === 2);
check("woundCount preserved", prows[0].woundCount === 3);
check("inTraction propagated", prows[0].inTraction === true);
check("flags array preserved", prows[0].flags.length === 2);
check("bad: missing patients array -> [] (zero-patient fort)", M.patientRows({ ok: true }).length === 0);
check("bad: null data -> [] no throw", noThrow("patientRows(null)", () => M.patientRows(null)).length === 0);
check("bad: negative woundCount coerced to 0", M.patientRows({ patients: [{ unitId: 5, woundCount: -2 }] })[0].woundCount === 0);
check("bad: non-array flags -> [] flags", M.patientRows({ patients: [{ unitId: 6, flags: "x" }] })[0].flags.length === 0);
check("bad: negative unitId patient dropped", M.patientRows({ patients: [{ unitId: -3 }] }).length === 0);

// ---------------- queueRows ----------------
console.log("TEST: queueRows");
const qData = { queue: [
  { jobType: "Surgery", worker: "Doc A", patient: "Wounded One" },
  { jobType: "Diagnose", worker: "", patient: "Sick Two" },
]};
const qrows = noThrow("queueRows good", () => M.queueRows(qData));
check("queueRows returns 2", qrows.length === 2);
check("jobType preserved", qrows[0].jobType === "Surgery");
check("empty worker tolerated", qrows[1].worker === "");
check("bad: empty queue (no active jobs) -> []", M.queueRows({ queue: [] }).length === 0);
check("bad: missing queue -> []", M.queueRows({}).length === 0);
check("bad: null entry filtered", M.queueRows({ queue: [null, { jobType: "Suture" }] }).length === 1);

// ---------------- summary ----------------
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
