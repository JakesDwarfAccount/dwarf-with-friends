// Run: node tools/harness/unitlist_classification_test.mjs
// Offline fixture for B72/B81/B96/B98. It spans living/dead/ghost/inactive,
// owned/foreign, and visible/ambush/undiscovered variants.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const info = fs.readFileSync(path.join(root, "src/info_panel.cpp"), "utf8");
const labor = fs.readFileSync(path.join(root, "src/labor.cpp"), "utf8");
const hud = fs.readFileSync(path.join(root, "src/hud.cpp"), "utf8");
const stream = fs.readFileSync(path.join(root, "src/world_stream.cpp"), "utf8");
const mapdata = fs.readFileSync(path.join(root, "src/tile_map_dump.cpp"), "utf8");

function livingActive(u) { return !!u && u.active && !u.dead && !u.ghost; }
function resident(u) { return livingActive(u) && u.citizen; }
function deadOrMissing(u) { return !!u && u.ownGroup && (!u.active || u.dead || u.ghost); }
function visibleToFort(u) { return !!u && !u.hiddenInAmbush && !u.hiddenAmbusher && !u.hiddenTile; }
function other(u) { return livingActive(u) && !u.citizen && !u.pet && visibleToFort(u); }
function population(units) { return units.filter(resident).length; }
function censusRecord(u) { const r = { id: u.id }; if (u.ghost) r.gh = 1; return r; }

const matrix = [
  { id: 1, citizen: true,  active: true,  dead: false, ghost: false, ownGroup: true,  hiddenInAmbush: false, hiddenAmbusher: false, hiddenTile: false, pet: false },
  { id: 2, citizen: true,  active: true,  dead: true,  ghost: false, ownGroup: true,  hiddenInAmbush: false, hiddenAmbusher: false, hiddenTile: false, pet: false },
  { id: 3, citizen: true,  active: true,  dead: true,  ghost: true,  ownGroup: true,  hiddenInAmbush: false, hiddenAmbusher: false, hiddenTile: false, pet: false },
  { id: 4, citizen: true,  active: false, dead: false, ghost: false, ownGroup: true,  hiddenInAmbush: false, hiddenAmbusher: false, hiddenTile: false, pet: false },
  { id: 5, citizen: false, active: true,  dead: false, ghost: false, ownGroup: false, hiddenInAmbush: false, hiddenAmbusher: false, hiddenTile: false, pet: false },
  { id: 6, citizen: false, active: true,  dead: false, ghost: false, ownGroup: false, hiddenInAmbush: true,  hiddenAmbusher: false, hiddenTile: false, pet: false },
  { id: 7, citizen: false, active: true,  dead: false, ghost: false, ownGroup: false, hiddenInAmbush: false, hiddenAmbusher: true,  hiddenTile: false, pet: false },
  { id: 8, citizen: false, active: true,  dead: false, ghost: false, ownGroup: false, hiddenInAmbush: false, hiddenAmbusher: false, hiddenTile: true,  pet: false },
  { id: 9, citizen: false, active: true,  dead: false, ghost: false, ownGroup: true,  hiddenInAmbush: false, hiddenAmbusher: false, hiddenTile: false, pet: true },
];

assert.deepEqual(matrix.filter(resident).map(u => u.id), [1], "B72: Residents excludes dead, ghost, inactive");
assert.deepEqual(matrix.filter(deadOrMissing).map(u => u.id), [2, 3, 4], "B72: Dead/Missing contains retained dead, ghost, inactive");
assert.deepEqual(matrix.filter(other).map(u => u.id), [5], "B96: Other contains only discovered creatures");
assert.equal(population(matrix), 1, "B81: population excludes dead/ghost/inactive");
assert.equal(resident(matrix[2]), false, "B72: ghost cannot be labor-assigned");
assert.equal(censusRecord(matrix[2]).gh, 1, "B98: ghost census record carries gh:1");
assert.equal(censusRecord(matrix[0]).gh, undefined, "B98: living record keeps additive shape");

// Test-the-test: the old citizen-only and unfiltered-other paths reproduce every reported leak.
const badResident = u => u.citizen;
const badOther = u => !u.citizen && !u.pet && u.active;
const badPopulation = units => units.filter(badResident).length;
const badCensus = u => ({ id: u.id });
assert.deepEqual(matrix.filter(badResident).map(u => u.id), [1, 2, 3, 4], "seeded B72 bad filter leaks retained units");
assert.equal(badPopulation(matrix), 4, "seeded B81 bad counter overcounts retained units");
assert.deepEqual(matrix.filter(badOther).map(u => u.id), [5, 6, 7, 8], "seeded B96 bad filter leaks hidden units");
assert.equal(badCensus(matrix[2]).gh, undefined, "seeded B98 bad serializer lacks gh");

// Source ties prevent the fixture model from passing if its server connection is removed.
assert.match(info, /bool is_living_active_unit[\s\S]*Units::isActive\(unit\)[\s\S]*!Units::isDead\(unit\)[\s\S]*!Units::isGhost\(unit\)/);
assert.match(info, /bool is_visible_to_fort[\s\S]*hidden_in_ambush[\s\S]*hidden_ambusher[\s\S]*designation.*bits\.hidden/);
assert.match(info, /bool is_dead_or_missing[\s\S]*!Units::isActive\(unit\)[\s\S]*Units::isDead\(unit\)[\s\S]*Units::isGhost\(unit\)/);
assert.match(labor, /bool is_assignable_citizen[\s\S]*Units::isActive\(unit\)[\s\S]*!Units::isDead\(unit\)[\s\S]*!Units::isGhost\(unit\)/);
assert.match(labor, /unit is not an assignable living citizen/);
assert.match(hud, /bool is_counted_citizen[\s\S]*isActive\(unit\)[\s\S]*!DFHack::Units::isDead\(unit\)[\s\S]*!DFHack::Units::isGhost\(unit\)/);
// B98 ghost wire invariant, asserted order-independently. The perfs345 AUX-cache refactor
// (commit d2e7fcf2) moved the append_unit_json serializer ABOVE the record-building loop, so
// the emit now appears in the source BEFORE the r.ghostly assignment -- but runtime order is
// unchanged (the record is populated at build time, then serialized). Both halves must exist:
// the record captures the ghost bit AND the serializer emits gh:1 for it. Order between them
// in the file text is irrelevant to correctness, so it is no longer asserted.
const wireSetsGhost = /r\.ghostly = Units::isGhost\(u\);/;
const wireEmitsGhost = /if \(u\.ghostly\) a << ",\\"gh\\":1";/;
assert.match(stream, wireSetsGhost, "B98: unit record captures the ghost bit");
assert.match(stream, wireEmitsGhost, "B98: unit serializer emits gh:1 when the record is ghostly");
// Test-the-test: a regression that dropped EITHER half must be caught. A source with only the
// serializer (record never set -> gh:1 never fires) fails wireSetsGhost; a source with only the
// assignment (bit set, never written -> ghosts invisible to the client) fails wireEmitsGhost.
assert.doesNotMatch('if (u.ghostly) a << ",\\"gh\\":1";', wireSetsGhost);
assert.doesNotMatch('r.ghostly = Units::isGhost(u);', wireEmitsGhost);
assert.match(mapdata, /if \(Units::isGhost\(u\)\) js << ",\\"gh\\":1";/);

console.log("PASS unitlist: B72 residents/labor, B81 population, B96 discovery, B98 ghost marker; seeded bad cases rejected");
