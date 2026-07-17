// burials_client_test.mjs -- OFFLINE fixture for Phase 5 burial/memorial browser gates.
// No DF, no server: exercises pure helpers exported from the existing panel modules.
//   node tools/harness/burials_client_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const buildInfoPath = join(here, "..", "..", "web", "js", "dwf-build-info-panels.js");
const bzsPath = join(here, "..", "..", "web", "js", "dwf-building-zone-stockpile-panels.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

const Info = require(buildInfoPath);
const BZS = require(bzsPath);
check("exports memorialButtonSpec", typeof Info.memorialButtonSpec === "function");
check("exports coffinBurialSummary", typeof BZS.coffinBurialSummary === "function");

const memorial = Info.memorialButtonSpec;
const coffin = BZS.coffinBurialSummary;

console.log("\n# memorial button gate");
check("dead detail + unit row -> Slab button", (() => { const s = memorial({ unitId: 42 }, "dead"); return s && s.unitId === 42 && s.label === "Slab"; })());
check("residents detail -> no memorial button", memorial({ unitId: 42 }, "residents") === null);
check("dead detail but no unit id -> no memorial button", memorial({ unitId: -1 }, "dead") === null);
check("old/malformed row -> no memorial button", memorial({}, "dead") === null && memorial(null, "dead") === null);

console.log("\n# coffin burial summary");
check("old DLL / non-coffin -> null", coffin({ built: true }) === null);
check("unbuilt coffin -> null", coffin({ isCoffin: true, built: false }) === null);
check("built unzoned coffin -> create label", (() => { const s = coffin({ isCoffin: true, built: true, tombId: -1 }); return s && !s.hasTomb && s.manageLabel === "Create tomb and assign" && s.label === "No tomb zone"; })());
check("zoned ownerless coffin -> Any citizen + citizens right", (() => { const s = coffin({ isCoffin: true, built: true, tombId: 7, owner: { id: -1 }, tomb: { citizens: true, pets: false } }); return s && s.hasTomb && s.ownerName === "Any citizen" && s.rights.join(",") === "citizens"; })());
check("zoned owned coffin -> owner + both rights", (() => { const s = coffin({ isCoffin: true, built: true, tombId: 8, owner: { id: 12, name: "Urist" }, tomb: { citizens: true, pets: true } }); return s && s.ownerName === "Urist" && s.label === "Urist - citizens/pets"; })());

console.log("\n# TEST-THE-TEST (seeded-bad helpers must be discriminated)");
const mutantMemorialEverywhere = row => row && Number(row.unitId) >= 0 ? { unitId: Number(row.unitId) } : null;
guard("a memorial gate that ignores active detail wrongly renders outside the Dead tab", mutantMemorialEverywhere({ unitId: 42 }) !== null && memorial({ unitId: 42 }, "residents") === null);
const mutantCoffinNoBuiltGate = info => info && info.isCoffin ? { hasTomb: true } : null;
guard("a coffin summary that ignores built state wrongly renders on unbuilt coffins", mutantCoffinNoBuiltGate({ isCoffin: true, built: false }) !== null && coffin({ isCoffin: true, built: false }) === null);

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
