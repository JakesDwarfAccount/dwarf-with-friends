// Run: node tools/harness/b290_child_assignment_guards_test.mjs
// B290 offline regression: children and babies are neither squad nor noble candidates, and both
// unit-bearing server writes revalidate the unit before mutating DF-owned state.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const squads = fs.readFileSync(path.join(root, "src/squads.cpp"), "utf8");
const fortAdmin = fs.readFileSync(path.join(root, "src/fort_admin.cpp"), "utf8");

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

const units = [
  { id: 1, citizen: true, active: true, dead: false, baby: false, child: false, squadId: -1 },
  { id: 2, citizen: true, active: true, dead: false, baby: true,  child: false, squadId: -1 },
  { id: 3, citizen: true, active: true, dead: false, baby: false, child: true,  squadId: -1 },
  { id: 4, citizen: true, active: true, dead: false, baby: false, child: false, squadId: 8 },
];
const oldNobleCandidate = u => u.citizen && u.active && !u.dead;
const oldSquadCandidate = u => oldNobleCandidate(u) && u.squadId === -1;
const adultCitizen = u => oldNobleCandidate(u) && !u.baby && !u.child;
const noblePayload = units.filter(adultCitizen).map(u => u.id);
const squadPayload = units.filter(u => adultCitizen(u) && u.squadId === -1).map(u => u.id);
const directAssign = u => adultCitizen(u) ? { ok: true } : { ok: false, error: "unit is a child" };

// Failing-first witnesses: the pre-B290 predicates accepted both juvenile professions.
assert.deepEqual(units.filter(oldNobleCandidate).map(u => u.id), [1, 2, 3, 4]);
assert.deepEqual(units.filter(oldSquadCandidate).map(u => u.id), [1, 2, 3]);

// Payload and direct-write behavior required by B290.
assert.deepEqual(noblePayload, [1, 4], "noble payload excludes babies and children only");
assert.deepEqual(squadPayload, [1], "squad payload excludes babies, children, and existing members");
for (const child of units.slice(1, 3)) {
  assert.deepEqual(directAssign(child), { ok: false, error: "unit is a child" },
    `direct write refuses juvenile unit ${child.id}`);
}

// Source ties: candidate payloads and load-bearing writes call DFHack's pinned predicates.
const noblePredicate = functionBody(fortAdmin, "bool is_assignable_citizen(df::unit* unit)");
assert.match(noblePredicate, /!DFHack::Units::isBaby\(unit\)/);
assert.match(noblePredicate, /!DFHack::Units::isChild\(unit\)/);
assert.match(functionBody(fortAdmin, "std::string build_noble_candidates_json"),
  /if \(!is_assignable_citizen\(unit\)\)\s*continue;/);

const squadSnapshot = functionBody(squads, "bool build_squad_state");
assert.match(squadSnapshot, /DFHack::Units::isBaby\(unit\)/);
assert.match(squadSnapshot, /DFHack::Units::isChild\(unit\)/);

const nobleWrite = functionBody(fortAdmin, "bool do_noble_assign");
assert.match(nobleWrite, /DFHack::Units::isBaby\(unit\) \|\| DFHack::Units::isChild\(unit\)/);
assert.ok(nobleWrite.indexOf("unit is a child") < nobleWrite.indexOf("create_assignment(fort, position_id)"),
  "noble child refusal happens before any missing assignment is created");

const squadWrite = functionBody(squads, "bool do_squad_assign");
assert.match(squadWrite, /DFHack::Units::isBaby\(unit\) \|\| DFHack::Units::isChild\(unit\)/);
assert.ok(squadWrite.indexOf("unit is a child") < squadWrite.indexOf("seat_leader_at_pos0"),
  "squad child refusal happens before either squad write path");
assert.ok(squadWrite.indexOf("unit is a child") < squadWrite.indexOf("Military::addToSquad"),
  "squad child refusal happens before DFHack's normal-member write");

console.log("PASS B290: child/baby squad+noble payload exclusions and direct-write refusals are wired before mutation");
