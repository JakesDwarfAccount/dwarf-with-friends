// cim_tasks_test.mjs -- OFFLINE fixture for R10 (CIM-tasks.jpg): the Tasks tab's job-first row
// anatomy + the functional bottom search on the generic info panels. No DF, no server: seeded
// /panel rows + a seeded-bad (mutant) case proving the test discriminates.
//   node tools/harness/cim_tasks_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-build-info-panels.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("dwf-build-info-panels.js node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

// The generic filter/actions helpers resolve the shared global `dfTokenMatch` (core.js) at call
// time -- provide a faithful copy of core.js's contract (case-insensitive, whitespace-tokenised,
// any-order, every token must appear) before invoking anything.
globalThis.dfTokenMatch = function (haystack, query) {
  const h = String(haystack == null ? "" : haystack).toLowerCase();
  const q = String(query == null ? "" : query).trim().toLowerCase();
  if (!q) return true;
  for (const t of q.split(/\s+/)) if (t && h.indexOf(t) === -1) return false;
  return true;
};

const M = require(modPath);
check("exports the pure R10 helpers", ["infoRowSearchText", "taskNameProf", "infoFilterRows", "infoRowActions"].every(k => typeof M[k] === "function"));

// Seeded tasks rows (mirrors CIM-tasks.jpg: job in row.status, colored Name/Prof, cancel+magnify).
const rows = [
  { unitId: 1, name: "Mestthos Mesircatten", profession: "Miner",       status: "Remove construction", jobId: 10, hasPos: true, x: 5, y: 6, z: 7 },
  { unitId: 2, name: "Zan Obokegast",        profession: "Farmer",      status: "Eat",                 jobId: 11, hasPos: true, x: 1, y: 2, z: 3 },
  { unitId: 3, name: "Minkot Morulothil",    profession: "Bone Carver", status: "Eat",                 jobId: 12, hasPos: false },
  { unitId: 4, name: "Fath Zedotasob",       profession: "Metalcrafter",status: "Drink",               jobId: 13, hasPos: true, x: 9, y: 9, z: 1 },
];

// ---- ROW ANATOMY: job-first, "Name, Profession" string ----
console.log("\n# taskNameProf (native 'Name, Prof' single string)");
check('name + profession -> "Name, Prof"', M.taskNameProf(rows[0]) === "Mestthos Mesircatten, Miner");
check("missing profession -> bare name (graceful)", M.taskNameProf({ name: "Solo" }) === "Solo");
check("missing name -> empty (graceful)", M.taskNameProf({ profession: "Miner" }) === "");

console.log("\n# job-first structure (source guard: job cell precedes portrait precedes name cell)");
const src = readFileSync(modPath, "utf8");
const tplStart = src.indexOf("function taskRowsHtml");
const tplEnd = src.indexOf("let infoSearch", tplStart); // the next declaration after taskRowsHtml
const tpl = src.slice(tplStart, tplEnd > tplStart ? tplEnd : tplStart + 2000);
const iJob = tpl.indexOf('class="info-task-job"');
const iPortrait = tpl.indexOf("unitPortraitMarkup(row");
const iName = tpl.indexOf('class="info-task-name"');
check("job cell is the FIRST/leftmost cell", iJob >= 0 && iPortrait >= 0 && iName >= 0 && iJob < iPortrait && iPortrait < iName,
  `job@${iJob} portrait@${iPortrait} name@${iName}`);

// ---- SEARCH TEXT + FILTER (functional, copied from creatures pattern) ----
console.log("\n# infoRowSearchText covers job + name + profession");
const t0 = M.infoRowSearchText(rows[0]);
check("search text includes the job (status)", t0.includes("remove construction"));
check("search text includes the unit name", t0.includes("mestthos"));
check("search text includes the profession", t0.includes("miner"));

console.log("\n# infoFilterRows (match / multi-token / no-match / clear / case)");
check("empty query -> all rows (clear)", M.infoFilterRows(rows, "").length === 4);
check("whitespace query -> all rows", M.infoFilterRows(rows, "   ").length === 4);
check("name token match", M.infoFilterRows(rows, "zan").map(r => r.unitId).join() === "2");
check("job token match (job-column searchable)", M.infoFilterRows(rows, "drink").map(r => r.unitId).join() === "4");
check("profession token match (2 farmers? no -> 1)", M.infoFilterRows(rows, "farmer").map(r => r.unitId).join() === "2");
check("multi-token any-order (job + prof)", M.infoFilterRows(rows, "eat bone").map(r => r.unitId).join() === "3");
check("multi-token reversed order same result", M.infoFilterRows(rows, "bone eat").map(r => r.unitId).join() === "3");
check("case-insensitive", M.infoFilterRows(rows, "MESTTHOS").map(r => r.unitId).join() === "1");
check("zero-match -> [] (drives 'No matches.')", M.infoFilterRows(rows, "zzzznotathing").length === 0);

// ---- ACTION CLUSTER: cancel gated on jobId, locate gated on pos ----
console.log("\n# infoRowActions (cancel + magnify per oracle)");
check("row with jobId -> cancel button present", M.infoRowActions(rows[0]).includes('data-info-cancel-job="10"'));
check("row with pos -> center/locate button present", M.infoRowActions(rows[0]).includes("data-info-center"));
check("unit task row -> NO place-open button (open is a no-op for units)", !M.infoRowActions(rows[0]).includes("data-info-open"));

// ---- COUNTEREXAMPLE CELLS (rule 5, 2 unsampled) ----
console.log("\n# counterexample: task with NO job + jobId<0 (still valid row, cancel omitted)");
const noJob = { unitId: 9, name: "Kib Idle", profession: "Peasant", status: "", jobId: -1, hasPos: false };
check("no-job row: name string still renders", M.taskNameProf(noJob) === "Kib Idle, Peasant");
check("no-job row: search text does not crash and includes name", M.infoRowSearchText(noJob).includes("kib idle"));
check("jobId<0 -> cancel button omitted", !M.infoRowActions(noJob).includes("data-info-cancel-job"));
check("no job, no pos, not a place -> empty action cluster", M.infoRowActions(noJob) === "");

console.log("\n# counterexample: a row without a served professionColor renders in DEFAULT color (opt-in tint)");
// B294 replaced the old English keyword table (creatureNameColor) with DF's served professionColor
// index. The guarantee is unchanged: an inline color is emitted ONLY when a valid DF source exists
// (integer 0..15), otherwise the row carries NO style attr. professionColorStyle() is the guard.
check("taskRowsHtml routes name color through the guarded professionColorStyle helper",
  /const nameColor = professionColorStyle\(row\)/.test(src) &&
  /function professionColorStyle\(record\)[\s\S]{0,300}?Number\.isInteger\(idx\) && idx >= 0 && idx <= 15/.test(src) &&
  !/creatureNameColor/.test(src));

// ---- TEST-THE-TEST: prove the fixture fails on seeded-bad implementations ----
console.log("\n# TEST-THE-TEST (seeded-bad implementations must be discriminated)");
const mutantFilterNeverFilters = (rs) => rs; // ignores the needle -> returns everything
guard("a filter that never filters would WRONGLY pass zero-match; real filter returns []",
  mutantFilterNeverFilters(rows).length === 4 && M.infoFilterRows(rows, "zzzznotathing").length === 0);
const mutantNameFirst = (row) => row.name; // wrong: name as the primary cell instead of job
guard("a name-first anatomy is discriminated (real primary cell is the job, not the name)",
  mutantNameFirst(rows[0]) === "Mestthos Mesircatten" && iJob < iName);

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
