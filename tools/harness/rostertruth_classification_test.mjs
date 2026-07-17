// Run: node tools/harness/rostertruth_classification_test.mjs
// Offline fixture for the ROSTER-TRUTH wave:
//   B214 - noble-assignment and squad candidate lists must exclude dead/ghost/inactive units.
//   B215 - accepted-petition long-term residents must count in the population total and appear
//          on the Residents screen (isCitizen alone drops them; isResident is DF's own test).
//
// This models the native truth DFHack encodes in citizensRange(): a unit is counted when it is
// active and not dead, AND it is either a fort citizen (isOwnGroup) or a long-term resident
// (isOwnCiv, not isOwnGroup). Candidate lists (nobles/squads/labor) stay citizen-only.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const info = fs.readFileSync(path.join(root, "src/info_panel.cpp"), "utf8");
const hud = fs.readFileSync(path.join(root, "src/hud.cpp"), "utf8");
const fortAdmin = fs.readFileSync(path.join(root, "src/fort_admin.cpp"), "utf8");
const squads = fs.readFileSync(path.join(root, "src/squads.cpp"), "utf8");

// --- Model of the native predicates (isDead already covers ghostly, kept explicit for clarity) ---
function livingActive(u) { return !!u && u.active && !u.dead && !u.ghost; }
// is_fort_citizen / is_assignable_citizen / is_counted_citizen(citizen leg): fort GROUP members.
function fortCitizen(u) { return livingActive(u) && u.citizen; }
// B215 union: citizens PLUS long-term residents (isResident: isOwnCiv && !isOwnGroup && !animal).
function resident(u) { return livingActive(u) && (u.citizen || u.longTermResident); }
function population(units) { return units.filter(resident).length; }
// Candidate lists are citizen-only and living-active (B214).
function nobleCandidate(u) { return fortCitizen(u); }
function squadCandidate(u) { return fortCitizen(u) && u.squadId === -1; }

// id 1 living citizen; 2 dead citizen (retained corpse); 3 ghost citizen; 4 inactive citizen;
// 5 living long-term resident (accepted petition: bard/mercenary); 6 dead long-term resident;
// 7 visiting petitioner not yet accepted (isVisiting -> neither citizen nor long-term resident);
// 8 living citizen already in a squad; 9 wild animal.
const matrix = [
  { id: 1, citizen: true,  longTermResident: false, active: true,  dead: false, ghost: false, squadId: -1 },
  { id: 2, citizen: true,  longTermResident: false, active: true,  dead: true,  ghost: false, squadId: -1 },
  { id: 3, citizen: true,  longTermResident: false, active: true,  dead: true,  ghost: true,  squadId: -1 },
  { id: 4, citizen: true,  longTermResident: false, active: false, dead: false, ghost: false, squadId: -1 },
  { id: 5, citizen: false, longTermResident: true,  active: true,  dead: false, ghost: false, squadId: -1 },
  { id: 6, citizen: false, longTermResident: true,  active: true,  dead: true,  ghost: false, squadId: -1 },
  { id: 7, citizen: false, longTermResident: false, active: true,  dead: false, ghost: false, squadId: -1 },
  { id: 8, citizen: true,  longTermResident: false, active: true,  dead: false, ghost: false, squadId: 4  },
  { id: 9, citizen: false, longTermResident: false, active: true,  dead: false, ghost: false, squadId: -1 },
];

// B215: living citizens + living long-term residents appear on the Residents screen.
assert.deepEqual(matrix.filter(resident).map(u => u.id), [1, 5, 8],
  "B215: Residents includes living citizens AND accepted-petition long-term residents");
// B215: population total counts the same set (bard/mercenary now included; dead/ghost/inactive out).
assert.equal(population(matrix), 3, "B215: population counts citizens + long-term residents, excludes dead/ghost/inactive");
// B214: noble candidates are living citizens only -- no dead(2), ghost(3), inactive(4), resident(5).
assert.deepEqual(matrix.filter(nobleCandidate).map(u => u.id), [1, 8],
  "B214: noble candidates exclude dead/ghost/inactive and long-term residents");
// B214: squad candidates are living un-squadded citizens -- excludes dead(2)/ghost(3) and squadded(8).
assert.deepEqual(matrix.filter(squadCandidate).map(u => u.id), [1],
  "B214: squad candidates exclude dead/ghost/inactive/already-squadded");

// --- Test-the-test: the old citizen-only / unfiltered paths reproduce the reported leaks. ---
const badPopulation = units => units.filter(u => u.citizen).length; // pre-B215: isCitizen-only, drops residents
assert.equal(badPopulation(matrix), 5, "seeded B215 old counter drops residents (5,6) and leaks retained (2,3,4)");
const badNoble = u => u.citizen;                                    // pre-B214: isCitizen with no living gate
assert.deepEqual(matrix.filter(badNoble).map(u => u.id), [1, 2, 3, 4, 8],
  "seeded B214 old noble filter leaks dead/ghost/inactive citizens");
const badSquad = u => u.citizen && u.squadId === -1;                // pre-B214: no living gate
assert.deepEqual(matrix.filter(badSquad).map(u => u.id), [1, 2, 3, 4],
  "seeded B214 old squad filter leaks dead/ghost/inactive");

// --- Source ties: fail if the server predicates regress away from the model above. ---
// B215 residents/population union.
assert.match(info, /bool is_resident[\s\S]*Units::isCitizen\(unit, true\)[\s\S]*Units::isResident\(unit, true\)/,
  "info_panel is_resident must union isCitizen with isResident");
assert.match(info, /bool is_fort_citizen[\s\S]*is_living_active_unit\(unit\)[\s\S]*Units::isCitizen\(unit, true\)/,
  "info_panel must keep a citizen-only is_fort_citizen for labor/trainer paths");
assert.match(hud, /bool is_counted_citizen[\s\S]*isActive\(unit\)[\s\S]*!DFHack::Units::isDead\(unit\)[\s\S]*isCitizen\(unit, true\)[\s\S]*isResident\(unit, true\)/,
  "hud population counter must union isCitizen with isResident and exclude dead/inactive");
// B214 candidate-list living-active citizen gates. AUDIT-FIX 07-15: isCitizen(unit, true) passed
// include_insane=true, asymmetric with the squad side -- now isCitizen(unit) (insane excluded on
// both sides; flip both together if a native capture ever shows otherwise).
assert.match(fortAdmin, /bool is_assignable_citizen[\s\S]*isCitizen\(unit\)[\s\S]*isActive\(unit\)[\s\S]*!DFHack::Units::isDead\(unit\)[\s\S]*!DFHack::Units::isGhost\(unit\)/,
  "fort_admin must gate noble candidates on a living-active citizen predicate");
assert.doesNotMatch(fortAdmin, /bool is_assignable_citizen[\s\S]{0,400}isCitizen\(unit, true\)/,
  "noble candidates must not include insane citizens (squad/noble symmetry)");
assert.match(fortAdmin, /if \(!is_assignable_citizen\(unit\)\)\s*\n\s*continue;/,
  "fort_admin build_noble_candidates_json must use is_assignable_citizen");
assert.match(fortAdmin, /unit is not an assignable living citizen/,
  "fort_admin do_noble_assign must reject non-living-citizen assignment");
assert.match(squads, /!DFHack::Units::isCitizen\(unit\)[\s\S]*!DFHack::Units::isActive\(unit\)[\s\S]*DFHack::Units::isDead\(unit\)[\s\S]*military\.squad_id != -1/,
  "squads candidate loop must add the living-active gate");

console.log("PASS rostertruth: B214 noble/squad candidate living-citizen gate, B215 residents+population count long-term residents; seeded old cases rejected");
