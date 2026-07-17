// lever_link_client_test.mjs -- OFFLINE fixture for the lever target picker helpers.
// No DF, no server: exercises mechanism-count gating, target normalization/sorting, and action
// enablement including seeded-bad discriminators.
//   node tools/harness/lever_link_client_test.mjs   (exit 0 PASS / 1 FAIL)

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
check("exports leverLinkMechanismStatus", typeof M.leverLinkMechanismStatus === "function");
check("exports leverLinkTargetRows", typeof M.leverLinkTargetRows === "function");
check("exports leverLinkActionState", typeof M.leverLinkActionState === "function");

const status = M.leverLinkMechanismStatus;
const rows = M.leverLinkTargetRows;
const state = M.leverLinkActionState;

console.log("\n# mechanism gate");
check("old DLL / empty data -> needs mechanisms", status(null).needs === true && status(null).canLink === false);
check("one mechanism -> needs mechanisms", status({ mechanismCount: 1 }).label === "Needs mechanisms (1/2)");
check("two mechanisms -> can link", status({ mechanismCount: 2 }).canLink === true);
check("server needsMechanisms flag wins", status({ mechanismCount: 5, needsMechanisms: true }).canLink === false);

console.log("\n# target picker rows");
const data = {
  mechanismCount: 2,
  targets: [
    { id: 9, name: "far bridge", type: "Bridge", x: 10, y: 10, z: 0, distance: 20 },
    { id: 4, name: "near door", type: "Door", x: 3, y: 4, z: 0, distance: 7 },
    { id: "bad", name: "bad" },
    { id: 5, type: "Hatch", x: 2, y: 2, z: 1, distance: 7 },
  ],
};
const picked = rows(data);
check("invalid target ids are dropped", picked.length === 3);
check("targets sort by distance then id", picked.map(t => t.id).join(",") === "4,5,9", picked.map(t => t.id).join(","));
check("fallback name uses type/id", picked[1].name === "Hatch");

console.log("\n# action state");
check("valid target with mechanisms is enabled", state(data, 4).enabled === true);
check("missing target is disabled", state(data, 99).enabled === false && state(data, 99).reason === "target unavailable");
check("needs mechanisms disables valid target", state({ mechanismCount: 1, targets: [{ id: 4 }] }, 4).reason === "needs mechanisms");

console.log("\n# TEST-THE-TEST (seeded-bad helpers must be discriminated)");
const mutantStatusOneMechanismOk = d => ({ canLink: (Number(d && d.mechanismCount) || 0) >= 1 });
guard("a picker that allows one mechanism differs from real gate", mutantStatusOneMechanismOk({ mechanismCount: 1 }).canLink !== status({ mechanismCount: 1 }).canLink);
const mutantRowsNoSort = d => (d.targets || []).filter(t => Number.isInteger(Number(t.id)));
guard("an unsorted picker differs from real distance ordering", mutantRowsNoSort(data).map(t => Number(t.id)).join(",") !== picked.map(t => t.id).join(","));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
