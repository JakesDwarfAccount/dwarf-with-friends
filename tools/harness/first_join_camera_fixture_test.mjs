// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(root, "src/client_state.cpp"), "utf8");

function seedCamera(saved, buildings, map) {
  if (saved) return saved;
  const wagon = buildings.find(b => b.type === "Wagon");
  if (wagon) return { x: wagon.x - 40, y: wagon.y - 25, z: wagon.z };
  return { x: Math.floor(map.width / 2) - 40, y: Math.floor(map.height / 2) - 25, z: map.surfaceZ };
}

const wagon = seedCamera(null, [{ type: "Workshop", x: 1, y: 2, z: 9 }, { type: "Wagon", x: 97, y: 53, z: 142 }], { width: 400, height: 320, surfaceZ: 125 });
assert.deepEqual(wagon, { x: 57, y: 28, z: 142 }, "first join centers the 80x50 view on the wagon and keeps its embark z");
const fallback = seedCamera(null, [], { width: 400, height: 320, surfaceZ: 125 });
assert.deepEqual(fallback, { x: 160, y: 135, z: 125 }, "no wagon falls back to fort surface center");
assert.deepEqual(seedCamera({ x: 7, y: 8, z: 9 }, [{ type: "Wagon", x: 97, y: 53, z: 142 }], {}), { x: 7, y: 8, z: 9 }, "returning player keeps saved camera");
assert.notEqual(wagon.z, 12, "seeded deep-host-camera bad case is rejected");

assert.match(source, /bool seed_first_join_camera[(]Camera& camera[)]/);
assert.match(source, /building->getType[(][)] != df::building_type::Wagon/);
assert.match(source, /camera[.]x = building->centerx - kInitialHalfWidth;[\s\S]*camera[.]z = building->z/);
assert.match(source, /camera[.]z = surface_z_for_initial_camera[(]center_x, center_y, world[)];/);
assert.match(source, /if [(]it != g_player_cameras[.]end[(][)][)]/);

console.log("PASS first-join camera: wagon center/z, surface fallback, saved-camera preservation; seeded deep-host case rejected");
