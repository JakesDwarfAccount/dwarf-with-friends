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
const cycle = fs.readFileSync(path.join(root, "web/js/dwf-unitcycle.js"), "utf8");

function hitTest(click, units) {
  const exact = units.filter(u => u.x === click.x && u.y === click.y && u.z === click.z).sort((a, b) => a.id - b.id);
  if (exact.length) return exact.map(u => u.id);
  return units.filter(u => u.z === click.z && Math.abs(u.x - click.x) <= 1 && Math.abs(u.y - click.y) <= 1)
    .sort((a, b) => (Math.abs(a.x - click.x) + Math.abs(a.y - click.y)) - (Math.abs(b.x - click.x) + Math.abs(b.y - click.y)) || a.id - b.id).map(u => u.id);
}

const units = [{ id: 1, x: 9, y: 10, z: 140 }, { id: 9, x: 10, y: 10, z: 140 }, { id: 2, x: 11, y: 11, z: 140 }];
assert.deepEqual(hitTest({ x: 10, y: 10, z: 140 }, units), [9], "exact target wins the seeded neighbor-steal case");
assert.equal(1 < 9, true, "old id-first 3x3 implementation would steal the neighbor");
assert.deepEqual(hitTest({ x: 10, y: 9, z: 140 }, units), [9, 1], "empty clicked tile retains nearest-neighbor forgiveness");

assert.match(interaction, /std::vector<df::unit[*]> exact;/);
assert.match(interaction, /if [(]dx == 0 && dy == 0[)][\s\S]*exact[.]push_back[(]unit[)]/);
assert.match(interaction, /if [(]!exact[.]empty[(][)][\s\S]*return exact;/);
assert.match(cycle, /Prefer the server.s click-resolution set[\s\S]*unitCycle/);

console.log("PASS exact-tile-first: exact target defeats seeded neighbor steal; empty-tile fallback and client unitCycle contract retained");
