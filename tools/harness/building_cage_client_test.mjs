// building_cage_client_test.mjs -- OFFLINE fixture for the built cage / terrarium browser panel
// helpers. No DF, no server: exercises the pure summary and action-label gates exported from
// dwf-building-zone-stockpile-panels.js, including dormant-safe old-DLL input and seeded-bad
// cases proving the fixture discriminates.
//   node tools/harness/building_cage_client_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-building-zone-stockpile-panels.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

const M = require(modPath);
check("exports buildingCageSummary", typeof M.buildingCageSummary === "function");
check("exports buildingCageActionLabel", typeof M.buildingCageActionLabel === "function");

const summary = M.buildingCageSummary;
const label = M.buildingCageActionLabel;

console.log("\n# cage summary gate");
check("old DLL / non-cage -> null", summary({ built: true }) === null);
check("cage with no assignments -> 0 assigned", (() => { const s = summary({ isCage: true }); return s && s.total === 0 && s.label === "0 assigned"; })());
check("unit + item assignments are both counted", (() => { const s = summary({ isCage: true, cageAssignedUnits: 2, cageAssignedItems: 1 }); return s && s.units === 2 && s.items === 1 && s.total === 3 && s.label === "3 assigned"; })());
check("singular copy", summary({ isCage: true, cageAssignedUnits: 1, cageAssignedItems: 0 }).label === "1 assigned");
check("bad numeric fields clamp to zero", summary({ isCage: true, cageAssignedUnits: -4, cageAssignedItems: "x" }).total === 0);

console.log("\n# action labels");
check("assigned occupant -> Release", label({ assigned: true }) === "Release");
check("assigned elsewhere -> Move here", label({ assignedElsewhere: true }) === "Move here");
check("unassigned candidate -> Assign", label({ assigned: false, assignedElsewhere: false }) === "Assign");
check("null row -> Assign", label(null) === "Assign");

console.log("\n# TEST-THE-TEST (seeded-bad helpers must be discriminated)");
const mutantSummaryIgnoresItems = info => info && info.isCage ? { total: Number(info.cageAssignedUnits) || 0 } : null;
guard("a summary that ignores assigned items miscounts mixed cage rows", mutantSummaryIgnoresItems({ isCage: true, cageAssignedUnits: 2, cageAssignedItems: 1 }).total !== summary({ isCage: true, cageAssignedUnits: 2, cageAssignedItems: 1 }).total);
const mutantLabelAssigned = row => row && row.assigned ? "Unassign" : "Assign";
guard("a label that says Unassign for caged captives differs from Release", mutantLabelAssigned({ assigned: true }) !== label({ assigned: true }));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
