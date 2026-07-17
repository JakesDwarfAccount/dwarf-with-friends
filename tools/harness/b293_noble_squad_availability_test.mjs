// Run: node tools/harness/b293_noble_squad_availability_test.mjs
// B293 offline regression: noble rows and squad-creation choices consume DF's own current
// possible_appointable state instead of treating every entity_position/raw NUMBER as available.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fortAdmin = fs.readFileSync(path.join(root, "src/fort_admin.cpp"), "utf8");
const squads = fs.readFileSync(path.join(root, "src/squads.cpp"), "utf8");
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, "tools/harness/fixtures/b293-noble-availability.json"), "utf8"));

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  assert.fail(`unterminated ${signature}`);
}

const oldVisible = fixture.positionsOwn.map(position => position.code);
assert.ok(oldVisible.includes("CAPTAIN_OF_THE_GUARD"),
  "failing-first witness: iterating positions.own exposes Captain of the Guard at population 15");

const offeredIds = new Set(fixture.possibleAppointable.map(offer => offer.positionId));
const activeIds = new Set(fixture.assignments
  .filter(assignment => assignment.histfig >= 0 || assignment.squadId >= 0)
  .map(assignment => assignment.positionId));
const visible = fixture.positionsOwn
  .filter(position => !position.hasBeenReplaced &&
    (position.requiresPopulation <= 0 || position.hasMetPopulationRequirement) &&
    (activeIds.has(position.id) || offeredIds.has(position.id)))
  .sort((a, b) => a.precedence - b.precedence)
  .map(position => position.code);

assert.deepEqual(visible, fixture.expectedVisibleCodes,
  "native offer fixture includes active/possible positions in precedence order");
for (const code of fixture.expectedHiddenCodes)
  assert.ok(!visible.includes(code), `${code} is excluded when DF does not currently offer it`);

const adminOffer = functionBody(fortAdmin,
  "bool position_is_possible_appointable(df::historical_entity* fort, int32_t position_id)");
assert.match(adminOffer, /fort->positions\.possible_appointable/,
  "fort admin reads DF's possible_appointable vector");
const adminVisible = functionBody(fortAdmin,
  "bool position_is_noble_screen_visible(df::historical_entity* fort, int32_t position_id)");
assert.match(adminVisible, /histfig >= 0 \|\| assignment->squad_id >= 0/,
  "held/squad-linked positions remain visible even when no longer vacant offers");
assert.match(adminVisible, /HAS_BEEN_REPLACED[\s\S]*requires_population[\s\S]*HAS_MET_POP_REQ/,
  "active positions still obey DF's replacement and population-eligibility state");
assert.match(adminVisible, /position_is_possible_appointable/,
  "vacant noble rows require DF's current appointment offer");
const noblesJson = functionBody(fortAdmin, "std::string build_nobles_json");
assert.match(noblesJson, /position_is_noble_screen_visible/,
  "noble payload filters positions.own through current DF availability");
assert.match(noblesJson, /stable_sort[\s\S]*precedence/,
  "noble payload follows native precedence order");
assert.match(functionBody(fortAdmin, "std::string build_noble_candidates_json"),
  /position is not currently offered by DF/,
  "candidate endpoint refuses hidden positions");
assert.match(functionBody(fortAdmin, "bool do_noble_assign"),
  /position is not currently offered by DF/,
  "direct noble write refuses hidden positions before mutation");
assert.match(functionBody(fortAdmin, "bool do_position_create"),
  /position_is_possible_appointable[\s\S]*position_is_as_needed_squad_appointable/,
  "seat creation accepts DF's current offer or the squad-only AS_NEEDED exception");

const squadState = functionBody(squads, "bool build_squad_state");
assert.match(squadState, /squad_leader_seat_is_available/,
  "free squad seats are gated by active/currently-offered DF state");
assert.match(squadState,
  /position_is_possible_appointable[\s\S]*position_is_as_needed_squad_appointable/,
  "new squad-leading positions accept DF's current offer or native AS_NEEDED squad capacity");
const asNeededSquad = functionBody(squads,
  "bool position_is_as_needed_squad_appointable(df::historical_entity* fort,");
assert.match(asNeededSquad, /squad_size <= 0 \|\| position->number >= 0/,
  "the fallback is restricted to AS_NEEDED squad positions");
assert.match(asNeededSquad, /HAS_BEEN_REPLACED[\s\S]*HAS_MET_POP_REQ[\s\S]*REQUIRES_MARKET[\s\S]*HAS_MET_MARKET_REQ/,
  "the AS_NEEDED fallback preserves replacement, population, and market requirements");
assert.match(asNeededSquad, /appointed_by[\s\S]*assignment->histfig >= 0/,
  "an AS_NEEDED squad office still requires a held appointing office");
const adminAsNeededSquad = functionBody(fortAdmin,
  "bool position_is_as_needed_squad_appointable(df::historical_entity* fort,");
assert.equal(adminAsNeededSquad.replace(/\s+/g, " "), asNeededSquad.replace(/\s+/g, " "),
  "the squad payload and position-create write use identical AS_NEEDED eligibility rules");
assert.match(functionBody(squads, "bool squad_leader_seat_is_available"),
  /position_is_as_needed_squad_appointable/,
  "a synthesized vacant AS_NEEDED assignment remains usable by squad creation");
const positionCreate = functionBody(fortAdmin, "bool do_position_create");
assert.match(positionCreate,
  /position_is_possible_appointable[\s\S]*position_is_as_needed_squad_appointable/,
  "the position-create write accepts the same AS_NEEDED squad capacity advertised by the read");

// Live-fort regression model: native offers a new militia captain while possible_appointable is
// empty. The Nobles vector cannot represent this Create Squad-only AS_NEEDED capacity.
const live = fixture.asNeededSquadCase;
const byId = new Map(live.positions.map(position => [position.id, position]));
const offered = new Set(live.possibleAppointable.map(assignment => assignment.positionId));
const basicEligible = position => !position.hasBeenReplaced &&
  (position.requiresPopulation <= 0 || position.hasMetPopulationRequirement) &&
  (!position.requiresMarket || position.hasMetMarketRequirement);
const hasHeldAppointer = position => position.appointedBy.some(appointerId =>
  live.assignments.some(assignment => assignment.positionId === appointerId && assignment.histfig >= 0));
const asNeededAvailable = position => basicEligible(position) && position.squadSize > 0 &&
  position.number < 0 && position.appointedBy.length > 0 && hasHeldAppointer(position);
const freeAssignmentIds = live.assignments.filter(assignment => {
  const position = byId.get(assignment.positionId);
  return position && basicEligible(position) && assignment.squadId === -1 &&
    (assignment.histfig >= 0 || offered.has(position.id) || asNeededAvailable(position));
}).map(assignment => assignment.id);
const creatablePositionIds = live.positions.filter(position => basicEligible(position) &&
  position.squadSize > 0 && (offered.has(position.id) || asNeededAvailable(position)) &&
  (position.number < 0 || live.assignments.filter(a => a.positionId === position.id).length < position.number))
  .map(position => position.id);
assert.deepEqual(freeAssignmentIds, live.expectedFreeAssignmentIds,
  "a vacant militia-captain assignment remains a native-usable free squad seat");
assert.deepEqual(creatablePositionIds, live.expectedCreatablePositionIds,
  "MILITIA_CAPTAIN remains creatable while capped/unmet Captain of the Guard stays hidden");
const squadAssign = functionBody(squads, "bool do_squad_assign");
assert.match(squadAssign, /for \(size_t i = 1;/,
  "automatic squad placement skips guarded commander position 0");
assert.match(squadAssign, /squad position is out of range/,
  "crafted slot indexes are rejected before DFHack's write");

console.log("PASS B293: noble offers stay gated; AS_NEEDED militia captains remain native-creatable; safe non-commander auto-slot is wired");
