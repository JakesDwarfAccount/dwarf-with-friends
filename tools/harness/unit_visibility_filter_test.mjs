// unit_visibility_filter_test.mjs -- offline contract for server-side unit visibility.
// Run: node tools/harness/unit_visibility_filter_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const world = fs.readFileSync(path.join(root, "src/world_stream.cpp"), "utf8");
const tile = fs.readFileSync(path.join(root, "src/tile_map_dump.cpp"), "utf8");
const helperFilter = /if \(!Units::isGhost\(u\) &&\s+\(!Units::isActive\(u\) \|\| !Units::isAlive\(u\)\)\) continue;/;

function ships(unit) {
  return unit.ghostly || (unit.active && unit.alive);
}

const fixture = [
  { name: "living animal", active: true, alive: true, ghostly: false, ships: true },
  { name: "inactive retained corpse", active: false, alive: false, ghostly: false, ships: false },
  { name: "killed retained corpse", active: true, alive: false, ghostly: false, ships: false },
  { name: "real DF ghost", active: true, alive: false, ghostly: true, ships: true },
  { name: "inactive real DF ghost", active: false, alive: false, ghostly: true, ships: true },
];

for (const unit of fixture) assert.equal(ships(unit), unit.ships, unit.name);

// Test-the-test: the pre-fix active-vector assumption leaks the seeded killed corpse.
const seededBad = (unit) => unit.active;
assert.notDeepEqual(fixture.map(seededBad), fixture.map((unit) => unit.ships),
  "fixture must reject the active-vector-only implementation");
assert.equal(seededBad(fixture[2]), true, "seeded killed corpse exposes the old leak");
assert.equal(ships(fixture[2]), false, "fixed predicate drops the seeded killed corpse");

assert.match(world, helperFilter, "world stream must use the helper-based visibility filter");
assert.match(tile, helperFilter, "mapdata emitter must use the identical visibility filter");
assert.match(tile, /#include "modules\/Units\.h"/, "mapdata emitter must include Units helpers");
// B242: this used to pin the inline `if (Units::isAlive(u)) { int st = 0;` block in
// world_stream.cpp. B222 factored that computation into unit_status.h and BOTH serializers now
// call it -- the guard did not disappear, it moved. Pin it where it lives, and pin that both
// callers go through it, so the contract (non-living units never emit status bits) is still
// enforced wherever the computation is next moved to.
const status = fs.readFileSync(path.join(root, "src/unit_status.h"), "utf8");
assert.match(status, /inline int unit_status_bits\(df::unit\* u\) \{\s*if \(!u \|\| !DFHack::Units::isAlive\(u\)\) return 0;/,
  "unit_status_bits must return 0 for non-living units");
assert.match(status, /inline int unit_status_bits2\(df::unit\* u\) \{\s*if \(!u \|\| !DFHack::Units::isAlive\(u\)\) return 0;/,
  "unit_status_bits2 must return 0 for non-living units");
assert.match(world, /r\.st = unit_status_bits\(u\);/, "world stream takes status bits from the guarded helper");
assert.match(tile, /unit_status_bits\(u\)/, "mapdata emitter takes status bits from the guarded helper");

console.log("PASS unit visibility: living ships; inactive/killed drop; native ghost preserved; seeded bad rejected; st guarded in unit_status.h");
