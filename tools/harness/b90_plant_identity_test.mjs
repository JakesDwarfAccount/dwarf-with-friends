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
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

// B90 plant identity regression guard. A map_block_column contains plants from every z-level
// in its x/y column. Both emitters must select the raw id from the exact x/y/z tile; x/y-only
// selection makes the result depend on column-vector order and swaps a plant sprite for one
// growing above/below it.
//
// Run: node tools/harness/b90_plant_identity_test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const wire = readFileSync(join(root, "src/wire_v1.cpp"), "utf8");
const legacy = readFileSync(join(root, "src/tile_map_dump.cpp"), "utf8");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err.stack || err)); }
}

function plantAt(plants, x, y, z) {
  return plants.find((plant) => plant && plant.x === x && plant.y === y && plant.z === z) || null;
}

const columnPlants = [
  { x: 12, y: 8, z: 140, id: "GUAVA" },
  { x: 12, y: 8, z: 141, id: "WATERMELON" },
  { x: 12, y: 8, z: 142, id: "JUTE" },
];

check("B90 exact-z selection chooses the rendered plant, not the first x/y match", () => {
  assert.equal(plantAt(columnPlants, 12, 8, 141)?.id, "WATERMELON");
});
check("B90 exact-z selection rejects a same-x/y plant on a different z-level", () => {
  assert.equal(plantAt(columnPlants, 12, 8, 143), null);
});
check("v1 BLOCK_SET plant tail matches x, y, and bz", () => {
  assert.match(wire, /pl->pos\.x == tx && pl->pos\.y == ty && pl->pos\.z == bz/);
});
check("legacy /mapdata plant field matches x, y, and fpos.z", () => {
  assert.match(legacy, /pl->pos\.x == fpos\.x && pl->pos\.y == fpos\.y && pl->pos\.z == fpos\.z/);
});
check("test-the-test: the old x/y-only predicate fails the v1 guard", () => {
  const old = wire.replace(" && pl->pos.z == bz", "");
  assert.doesNotMatch(old, /pl->pos\.x == tx && pl->pos\.y == ty && pl->pos\.z == bz/);
});
check("test-the-test: the old x/y-only predicate fails the legacy guard", () => {
  const old = legacy.replace(" && pl->pos.z == fpos.z", "");
  assert.doesNotMatch(old, /pl->pos\.x == fpos\.x && pl->pos\.y == fpos\.y && pl->pos\.z == fpos\.z/);
});

if (failures) {
  console.error("FAIL " + failures + " B90 plant identity checks");
  process.exit(1);
}
console.log("PASS B90 plant identity checks");
