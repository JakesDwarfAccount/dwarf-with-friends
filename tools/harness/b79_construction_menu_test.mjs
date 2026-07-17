// b79_construction_menu_test.mjs -- offline fixture acceptance for B79 (browser Build menu's
// "Constructions" category vs DF v50's NATIVE menu, oracle = friend screenshot B79-1).
//
// Exercises the PURE, DOM-free normalizeBuildCatalog() (web/js/dwf-build-info-panels.js),
// which re-buckets the /build-catalog payload the server already sends: it re-homes grates/bars/
// windows/Support/Bridge/Track-stop into Constructions, and collapses the 28 track pieces + 3
// stair variants behind "Track"/"Stairs" drill-down folders. Placement tokens are untouched.
//
// ENUMERATE-BEFORE-FIX (completeness protocol rule 1): the authoritative native Constructions
// list from B79-1 is asserted in full, and test-the-test rows (rule 3) confirm the grouping
// predicate discriminates Track stop (a direct entry) from the Track pieces.
//
// Run: node tools/harness/b79_construction_menu_test.mjs        (zero-dep, Node >= 18)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-build-info-panels.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("dwf-build-info-panels.js node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);
check("exports normalizeBuildCatalog + b79ConstructionGroupFor",
  typeof M.normalizeBuildCatalog === "function" && typeof M.b79ConstructionGroupFor === "function");

// ---- grouping predicate (rule 3: discriminates the reported example AND edge cells) ----------
const gf = M.b79ConstructionGroupFor;
check("Track direction pieces -> 'track'", gf("Track N") === "track" && gf("Track N-S-E") === "track");
check("Track ramp pieces -> 'track'", gf("Track ramp N") === "track" && gf("Track ramp N-S-E-W") === "track");
check("Stair variants -> 'stairs'", gf("Up stair") === "stairs" && gf("Down stair") === "stairs" && gf("Up/down stair") === "stairs");
guard("'Track stop' is NOT a track piece (direct entry)", gf("Track stop") === "");
guard("'Wall'/'Floor'/'Bridge' are direct entries", gf("Wall") === "" && gf("Floor") === "" && gf("Bridge") === "");

// ---- full catalog fixture (mirrors the real dwf.lua add_build_item output) --------------
const trackPieces = [
  "Track N", "Track S", "Track E", "Track W", "Track N-S", "Track E-W", "Track N-E", "Track S-W",
  "Track N-S-E", "Track S-E-W",
];
const trackRamps = ["Track ramp N", "Track ramp S", "Track ramp N-S", "Track ramp N-S-E-W"];
const allTrack = trackPieces.concat(trackRamps); // 14 pieces

function catalog() {
  const items = [];
  const add = (category, label) => items.push({ category, label, token: `t:${label}`, group: "" });
  // Doors/hatches (grates + bars are mis-filed here by the server)
  ["Door", "Hatch cover", "Wall grate", "Floor grate", "Vertical bars", "Floor bars"].forEach(l => add("doors", l));
  // Furniture (windows mis-filed here)
  ["Chair / Throne", "Bed", "Glass window", "Gem window"].forEach(l => add("furniture", l));
  // Machines/fluids (Support + Bridge mis-filed here)
  ["Screw pump", "Support", "Bridge", "Well", "Floodgate"].forEach(l => add("machines", l));
  // Traps (Track stop mis-filed here)
  ["Lever", "Track stop", "Cage trap"].forEach(l => add("traps", l));
  // Constructions (already correct base set + exploded stairs + exploded track)
  ["Wall", "Reinforced wall", "Floor", "Ramp", "Fortification", "Dirt road", "Paved road",
   "Up stair", "Down stair", "Up/down stair"].forEach(l => add("constructions", l));
  allTrack.forEach(l => add("constructions", l));
  const categories = [
    { id: "workshops", label: "Workshops", count: 0 },
    { id: "furniture", label: "Furniture", count: 4 },
    { id: "doors", label: "Doors/hatches", count: 6 },
    { id: "constructions", label: "Constructions", count: 10 + allTrack.length },
    { id: "machines", label: "Machines/fluids", count: 5 },
    { id: "traps", label: "Traps", count: 3 },
  ];
  return { ok: true, categories, items };
}

const c = M.normalizeBuildCatalog(catalog());
const byCat = id => c.items.filter(i => i.category === id);
const labelsIn = id => byCat(id).map(i => i.label);
const topLevel = id => byCat(id).filter(i => !i.group).map(i => i.label);
const catOf = id => c.categories.find(x => x.id === id);

// ---- re-home: the mis-filed items now live under Constructions ONLY --------------------------
const rehomed = ["Wall grate", "Floor grate", "Vertical bars", "Floor bars", "Glass window",
  "Gem window", "Support", "Bridge", "Track stop"];
for (const label of rehomed)
  check(`"${label}" is under Constructions`, labelsIn("constructions").includes(label));
check("Doors keeps only Door + Hatch cover", JSON.stringify(labelsIn("doors")) === JSON.stringify(["Door", "Hatch cover"]));
check("Furniture no longer holds windows", !labelsIn("furniture").some(l => /window/i.test(l)));
check("Machines no longer holds Support/Bridge", !labelsIn("machines").includes("Support") && !labelsIn("machines").includes("Bridge"));
check("Traps no longer holds Track stop", !labelsIn("traps").includes("Track stop"));

// ---- collapse: track + stair variants are grouped, everything else is direct ------------------
check("all track pieces tagged group='track'", allTrack.every(l => c.items.find(i => i.label === l).group === "track"));
check("all stair variants tagged group='stairs'",
  ["Up stair", "Down stair", "Up/down stair"].every(l => c.items.find(i => i.label === l).group === "stairs"));
check("Track stop stays a DIRECT construction entry", c.items.find(i => i.label === "Track stop").group === "");

// ---- native Constructions top-level (16 direct rows + 2 folders = 18), oracle B79-1 ----------
const NATIVE_DIRECT = new Set([
  "Wall", "Reinforced wall", "Floor", "Ramp", "Fortification", "Dirt road", "Paved road", "Bridge",
  "Wall grate", "Floor grate", "Vertical bars", "Floor bars", "Glass window", "Gem window",
  "Support", "Track stop",
]);
const direct = new Set(topLevel("constructions"));
check("Constructions direct rows == native set (16)",
  direct.size === NATIVE_DIRECT.size && [...NATIVE_DIRECT].every(l => direct.has(l)),
  `got: ${[...direct].sort().join(", ")}`);
const cons = catOf("constructions");
check("Constructions exposes exactly the Stairs + Track folders",
  Array.isArray(cons.groups) && cons.groups.length === 2 &&
  cons.groups.map(g => g.id).sort().join(",") === "stairs,track");
check("Track folder count == inserted track pieces", cons.groups.find(g => g.id === "track").count === allTrack.length);
check("Stairs folder count == 3", cons.groups.find(g => g.id === "stairs").count === 3);
check("Constructions badge counts ALL buildables (direct + grouped)",
  cons.count === byCat("constructions").length);
// top-level ROWS a player sees = direct entries + one folder per subgroup = native 18
check("top-level Constructions rows total 18 (16 direct + 2 folders)",
  topLevel("constructions").length + cons.groups.length === 18);

// ---- guard: normalize is null-safe -----------------------------------------------------------
guard("normalize tolerates junk input", (() => {
  try { M.normalizeBuildCatalog(null); M.normalizeBuildCatalog({}); M.normalizeBuildCatalog({ items: null, categories: null }); return true; }
  catch (_) { return false; }
})());

console.log(`\nB79 construction-menu: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
