// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const interaction = fs.readFileSync(path.join(root, "src/interaction.cpp"), "utf8");
// B212: the /tile-occupants map-click route lives in register_interaction_routes
// (interaction.cpp) now; scope the route assertion to that function so the check still
// targets the ROUTE's filter, not interaction.cpp's own inspect path.
const routesStart = interaction.indexOf("void register_interaction_routes");
assert.ok(routesStart >= 0, "register_interaction_routes exists in interaction.cpp");
const http = interaction.slice(routesStart);
const cycle = fs.readFileSync(path.join(root, "web/js/dwf-unitcycle.js"), "utf8");

function mapClickable(unit) { return !!unit && !unit.hidden && (!unit.dead || unit.ghost); }

const ghost = { id: 41, dead: true, ghost: true, hidden: false };
const corpse = { id: 42, dead: true, ghost: false, hidden: false };
assert.equal(mapClickable(ghost), true, "native ghost remains a map-click candidate");
assert.equal(mapClickable(corpse), false, "seeded bad retained corpse remains excluded");
assert.equal((!ghost.dead), false, "old dead-only filter rejects the known-bad ghost");

assert.match(interaction, /Units::isDead[(]unit[)] && !Units::isGhost[(]unit[)]/);
assert.match(interaction, /result[.]kind = "unit";[\s\S]*result[.]unit = build_unit_sheet[(]unit[)]/);
assert.match(http, /Units::isDead[(]unit[)] && !Units::isGhost[(]unit[)]/);
assert.match(cycle, /if [(]kind === .unit.[)] return [{] flow: .unit., id: Number[(]candidate[.]id[)] [}];/);

console.log("PASS ghost clickable: ghost reaches inspect and standard unit sheet; seeded corpse rejection retained");
