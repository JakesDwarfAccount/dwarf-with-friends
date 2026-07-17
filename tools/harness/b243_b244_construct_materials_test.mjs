// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-only
//
// B243 ("materials for constructing floors show plants and other weird things") and B244 (the
// escalation: "ALL constructions have wrong material selections -- rock, blocks, wood, bars").
//
// WHAT THIS TEST IS. There is no Lua VM in the offline harness and no live DF here, so it cannot
// call item_matches_filter() directly. Instead it EXTRACTS the accepted-item-class table and the
// buildmat gate out of dwf.lua and runs seeded items through them -- including a plant, which
// must be rejected. Against the pre-fix code the extraction finds no gate, the simulation therefore
// says "everything matches" (which is exactly the bug), and the plant assertions FAIL. Verified
// failing-first: see the SEEDED-BAD section, which reproduces the pre-fix source and asserts the
// checker still rejects it.
//
// It also cross-checks our accepted-class table against DFHack's own source when the dfhack
// checkout is present, so the table is pinned to an oracle rather than to my opinion.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lua = readFileSync(join(root, "dwf.lua"), "utf8");
const js = readFileSync(join(root, "web", "js", "dwf-build-info-panels.js"), "utf8");
const DFHACK = process.env.DFHACK_SRC || "";

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

// ---------------------------------------------------------------------------
// Extraction: pull the construction-material policy out of the Lua source.
// ---------------------------------------------------------------------------

// The accepted item classes for a flags2.building_material job_item.
function parseBuildmatClasses(luaText) {
  const block = luaText.match(/BUILDMAT_ITEM_TYPES\s*=\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return null;
  const names = [...block[1].matchAll(/\[df\.item_type\.([A-Z_]+)\]/g)].map(m => m[1]);
  return names.length ? new Set(names) : null;
}

// Is the buildmat gate actually wired into item_matches_filter (not merely defined nearby)?
function parseMatchFn(luaText) {
  const fn = luaText.match(/function item_matches_filter\(filter, item\)([\s\S]*?)\nend\n/);
  return fn ? fn[1] : "";
}
function hasBuildmatGate(luaText) {
  const body = parseMatchFn(luaText);
  return /filter_wants_buildmat\(filter\)/.test(body) &&
    /buildmat_item_types\(\)\[item:getType\(\)\]/.test(body) &&
    /isBuildMat/.test(body);
}
function hasMetalGate(luaText) {
  const body = parseMatchFn(luaText);
  return /filter\.flags3[\s\S]*?\.metal/.test(body) && /mat_is_metal/.test(body);
}

// Simulate item_matches_filter() for a construction job_item -- i.e. the filter DFHack hands us:
// { item_type=-1, item_subtype=-1, mat_type=-1, mat_index=-1, flags2={building_material=true} }.
// If the source has no gate, every field the old code checked is -1, so it matched everything:
// that "true" IS the bug, faithfully reproduced.
const CONSTRUCTION_FILTER = {
  item_type: -1, item_subtype: -1, mat_type: -1, mat_index: -1,
  flags2: { building_material: true, non_economic: true },
};
function simulateMatches(luaText, filter, item) {
  if (filter.item_type >= 0 && item.type !== filter.item_type) return false;
  if (filter.flags2 && filter.flags2.building_material) {
    if (!hasBuildmatGate(luaText)) return true;      // pre-fix: no item-class filtering at all
    const classes = parseBuildmatClasses(luaText);
    if (!classes || !classes.has(item.type)) return false;
    if (!item.isBuildMat) return false;
  }
  if (filter.flags3 && filter.flags3.metal) {
    if (!hasMetalGate(luaText)) return true;
    if (!item.isMetal) return false;
  }
  if (filter.mat_type >= 0 && item.matType !== filter.mat_type) return false;
  return true;
}

// The candidate list, with a plant seeded into it exactly as B243 reported seeing.
const CANDIDATES = [
  { name: "granite boulder",   type: "BOULDER",       isBuildMat: true,  accept: true },
  { name: "microcline blocks", type: "BLOCKS",        isBuildMat: true,  accept: true },
  { name: "oak log",           type: "WOOD",          isBuildMat: true,  accept: true },
  { name: "steel bar",         type: "BAR",           isBuildMat: true,  isMetal: true, accept: true },
  // --- everything below is what B243/B244 saw offered as floor material and must not be ---
  { name: "plump helmet (PLANT)",   type: "PLANT",        isBuildMat: false, accept: false },
  { name: "quarry bush leaves",     type: "PLANT_GROWTH", isBuildMat: false, accept: false },
  { name: "prepared meal (FOOD)",   type: "FOOD",         isBuildMat: false, accept: false },
  { name: "dwarf corpse",           type: "CORPSE",       isBuildMat: false, accept: false },
  { name: "pig tail sock",          type: "SHOES",        isBuildMat: false, accept: false },
  { name: "cat (VERMIN)",           type: "VERMIN",       isBuildMat: false, accept: false },
  { name: "rock nut (SEEDS)",       type: "SEEDS",        isBuildMat: false, accept: false },
  { name: "wooden door",            type: "DOOR",         isBuildMat: false, accept: false },
];

console.log("# B243/B244 construction material selection");

// ---- 1. the plants bug, stated as a behavior ----------------------------------------------
console.log("## accepted item classes for a construction (flags2.building_material) filter");
for (const c of CANDIDATES) {
  const got = simulateMatches(lua, CONSTRUCTION_FILTER, c);
  check(`${c.accept ? "accepts" : "REJECTS"} ${c.name}`, got === c.accept);
}

// The single assertion B243 is about.
const plant = CANDIDATES.find(c => c.type === "PLANT");
check("B243: a plant is not a construction material", simulateMatches(lua, CONSTRUCTION_FILTER, plant) === false);

// ---- 2. the class table itself -------------------------------------------------------------
const classes = parseBuildmatClasses(lua);
check("buildmat class table exists", !!classes);
check("buildmat classes are exactly BLOCKS/BOULDER/WOOD/BAR",
  !!classes && classes.size === 4 &&
  ["BLOCKS", "BOULDER", "WOOD", "BAR"].every(t => classes.has(t)));
check("buildmat classes contain no plant/food/refuse class",
  !!classes && !["PLANT", "PLANT_GROWTH", "FOOD", "CORPSE", "SEEDS", "MEAT"].some(t => classes.has(t)));

// ---- 3. cross-check the table against DFHack's own source (offline oracle) ------------------
const bpCpp = join(DFHACK, "plugins", "buildingplan", "buildingplan.cpp");
const bpCycle = join(DFHACK, "plugins", "buildingplan", "buildingplan_cycle.cpp");
const bldLua = join(DFHACK, "library", "lua", "dfhack", "buildings.lua");
if (existsSync(bpCpp) && existsSync(bpCycle) && existsSync(bldLua)) {
  const gv = readFileSync(bpCpp, "utf8").match(/getVectorIds[\s\S]*?building_material\)\s*\{([\s\S]*?)\n\s{4}\}/);
  const vectors = gv ? new Set([...gv[1].matchAll(/job_item_vector_id::([A-Z_]+)/g)].map(m => m[1])) : null;
  check("oracle: DFHack getVectorIds() searches exactly BLOCKS/BOULDER/WOOD/BAR for a buildmat filter",
    !!vectors && vectors.size === 4 && ["BLOCKS", "BOULDER", "WOOD", "BAR"].every(v => vectors.has(v)));
  check("oracle: our accepted-class table equals DFHack's vector set",
    !!vectors && !!classes && [...classes].every(c => vectors.has(c)) && vectors.size === classes.size);
  check("oracle: DFHack rejects non-buildmat items for a buildmat filter (matchesFilters)",
    /flags2\.bits\.building_material\s*&&\s*!item->isBuildMat\(\)/.test(readFileSync(bpCycle, "utf8")));
  const bl = readFileSync(bldLua, "utf8");
  check("oracle: every Construction uses the building_material filter (buildings.lua)",
    /building_type\.Construction[\s\S]{0,400}?flags2=\{\s*building_material=true/.test(bl));
  check("oracle: Bridge / RoadPaved / TradeDepot / Support / ArcheryTarget use it too",
    ["Bridge", "RoadPaved", "TradeDepot", "Support", "ArcheryTarget"].every(b =>
      new RegExp(`building_type\\.${b}\\][^\\n]*building_material=true`).test(bl)));
  check("oracle: DFHack clears non_economic once a material is pinned (augment_input)",
    /rv\.mat_index and safe_index\(rv, 'flags2', 'non_economic'\)[\s\S]{0,80}?non_economic = false/.test(bl));
} else {
  console.log(`  SKIP - dfhack source oracle (not found at ${DFHACK}; set DFHACK_SRC)`);
}

// ---- 4. write path: the pick must produce a job DF can actually satisfy ---------------------
console.log("## write path");
const applyFn = lua.match(/function apply_chosen_materials\(filters, opts\)([\s\S]*?)\nend\n/);
const applyBody = applyFn ? applyFn[1] : "";
check("pinned material clears flags2.non_economic (else the job is unsatisfiable)",
  /non_economic = false/.test(applyBody));
check("pinned material is only applied for a concrete mat_index",
  /mat_index >= 0/.test(applyBody));
check("3-part pick pins the item class too", /\^\(-\?%d\+\):\(-\?%d\+\):\(-\?%d\+\)\$/.test(applyBody) &&
  /filter\.item_type = itn/.test(applyBody));
check("legacy 2-part pick still parses", /\^\(-\?%d\+\):\(-\?%d\+\)\$/.test(applyBody));
check('"closest" resolves to class+material, not material alone',
  /best:getType\(\)[\s\S]{0,120}best:getMaterial\(\)/.test(lua));

// ---- 5. chooser (display) -------------------------------------------------------------------
console.log("## chooser");
check("server emits the item class per material entry",
  /'\{"itemType":'/.test(lua) && /"className":/.test(lua));
check("server groups by class AND material (rock vs blocks are separate picks)",
  /local key = tostring\(it\) \.\. ':' \.\. tostring\(mt\) \.\. ':' \.\. tostring\(mi\)/.test(lua));
check("client offers the class in the label (rock / blocks / wood / bars)",
  /matPickLabel/.test(js) && /m\.className/.test(js));
check("client pick value carries the class", /matPickValue/.test(js) &&
  /\$\{Number\(m\.itemType\)\}:\$\{Number\(m\.matType\)\}:\$\{Number\(m\.matIndex\)\}/.test(js));
check("client accepts both 3-part and legacy 2-part picks",
  /MAT_PICK_RE = \/\^-\?\\d\+:-\?\\d\+\(:-\?\\d\+\)\?\$\//.test(js));
check("B148 grammar kept: one select per requirement, no reintroduced closest option",
  /Any material \(\$\{total\} on hand\)/.test(js) && !/Closest to placement<\/option>/.test(js));

// ---- 6. SEEDED-BAD: prove the checks above are not vacuous ----------------------------------
// Reconstruct the pre-fix source and assert this test rejects it. If any of these "still passes"
// then the corresponding check above cannot fail and is worthless.
console.log("## seeded-bad (test-the-test)");

// (a) the actual pre-fix item_matches_filter, verbatim in shape: no flags handling at all.
const PREFIX_LUA = `
function item_matches_filter(filter, item)
    if filter.item_type ~= nil and filter.item_type >= 0 and item:getType() ~= filter.item_type then
        return false
    end
    if filter.mat_type ~= nil and filter.mat_type >= 0 then
        if item:getMaterial() ~= filter.mat_type then return false end
    end
    return true
end
`;
check("pre-fix code offers a plant as floor material (the bug reproduces)",
  simulateMatches(PREFIX_LUA, CONSTRUCTION_FILTER, plant) === true);
check("pre-fix code has no accepted-class table", parseBuildmatClasses(PREFIX_LUA) === null);
check("pre-fix code fails the B243 assertion",
  simulateMatches(PREFIX_LUA, CONSTRUCTION_FILTER, plant) !== false);

// (b) gate defined but not wired into item_matches_filter -> must not count as fixed.
const UNWIRED = lua.replace(/if filter_wants_buildmat\(filter\) then[\s\S]*?\n    end\n/, "");
check("a buildmat gate that is not wired into item_matches_filter is not accepted",
  hasBuildmatGate(UNWIRED) === false && simulateMatches(UNWIRED, CONSTRUCTION_FILTER, plant) === true);

// (c) seed a plant INTO the accepted-class table -> the class-table checks must fail. (The
// simulated match still rejects the plant, because isBuildMat() is a second, independent gate --
// that is the defense-in-depth working, and is itself asserted below.)
const SEEDED_PLANT = lua.replace(/\[df\.item_type\.BLOCKS\] = 'Blocks',/,
  "[df.item_type.BLOCKS] = 'Blocks',\n            [df.item_type.PLANT] = 'Plant',");
const seededClasses = parseBuildmatClasses(SEEDED_PLANT);
check("a plant seeded into the class table is detected by the class-table checks",
  !!seededClasses && seededClasses.has("PLANT") && seededClasses.size !== 4);
check("isBuildMat() still rejects the plant even if the class table is corrupted (2 gates)",
  simulateMatches(SEEDED_PLANT, CONSTRUCTION_FILTER, plant) === false);

// (c2) a would-be buildmat whose class is NOT in the table is rejected by the table gate alone.
check("class table is load-bearing: a DOOR claiming isBuildMat is still rejected",
  simulateMatches(lua, CONSTRUCTION_FILTER, { type: "DOOR", isBuildMat: true }) === false);

// (d) drop the non_economic clear -> the write-path check must fail.
const NO_NONECON = lua.replace(/filter\.flags2\.non_economic = false/, "-- removed");
const noneconBody = (NO_NONECON.match(/function apply_chosen_materials\(filters, opts\)([\s\S]*?)\nend\n/) || ["", ""])[1];
check("removing the non_economic clear is detected", !/non_economic = false/.test(noneconBody));

console.log(`\n# ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
