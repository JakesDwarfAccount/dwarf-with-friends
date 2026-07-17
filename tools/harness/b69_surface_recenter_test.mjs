// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3.
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

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const helperSource = read("src/surface_z.h");
const hudSource = read("src/hud.cpp");
const clientStateSource = read("src/client_state.cpp");
const httpSource = read("src/http_server.cpp");
const controlsSource = read("web/js/dwf-controls-placement.js");

function functionBody(source, start, next) {
  const from = source.indexOf(start);
  const to = source.indexOf(next, from);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return source.slice(from, to);
}

// Mirrors the complete material x shape matrix in DFHack 53.15-r1's df.d_basics.xml. Leaves
// decorate these tree-part tiletypes; there is no separate LEAF tiletype material.
const treeShapes = new Set(["WALL", "RAMP", "BRANCH", "TRUNK_BRANCH", "TWIG"]);
const mushroomCapShapes = new Set(["WALL", "RAMP", "FLOOR"]);
function isCanopy(tile) {
  return (tile.material === "TREE" && treeShapes.has(tile.shape)) ||
    (tile.material === "MUSHROOM" && mushroomCapShapes.has(tile.shape));
}

function surfaceZ(column, canopyPredicate = isCanopy) {
  for (const tile of [...column].sort((a, b) => b.z - a.z)) {
    if (tile.basic === "Open" || tile.basic === "None") continue;
    if (canopyPredicate(tile)) continue;
    return tile.z;
  }
  return 0;
}

const grass = { z: 169, material: "GRASS_LIGHT", shape: "FLOOR", basic: "Floor" };
const air = { z: 170, material: "AIR", shape: "EMPTY", basic: "Open" };

console.log("# failing recenter column: canopy z=171, air z=170, grass z=169");
for (const shape of treeShapes) {
  const basic = shape === "TWIG" ? "Open" : shape === "WALL" ? "Wall" : shape === "RAMP" ? "Ramp" : "Floor";
  const column = [{ z: 171, material: "TREE", shape, basic }, air, grass];
  assert.equal(surfaceZ(column), 169, `TREE/${shape} must not become surfaceZ`);
}
for (const shape of mushroomCapShapes) {
  const basic = shape === "WALL" ? "Wall" : shape === "RAMP" ? "Ramp" : "Floor";
  const column = [{ z: 171, material: "MUSHROOM", shape, basic }, air, grass];
  assert.equal(surfaceZ(column), 169, `MUSHROOM/${shape} cap must not become surfaceZ`);
}

console.log("# controls: non-canopy surfaces remain eligible");
assert.equal(surfaceZ([{ z: 171, material: "ROOT", shape: "WALL", basic: "Wall" }, grass]), 171,
  "tree roots are terrain, not canopy");
assert.equal(surfaceZ([{ z: 171, material: "CONSTRUCTION", shape: "FLOOR", basic: "Floor" }, grass]), 171,
  "constructed floors remain valid surfaces");

console.log("# TEST-THE-TEST: shipped TREE-only fix must fail the mushroom-cap row");
const mushroomFloorColumn = [
  { z: 171, material: "MUSHROOM", shape: "FLOOR", basic: "Floor" },
  air,
  grass,
];
const oldTreeOnlyPredicate = tile => tile.material === "TREE";
assert.equal(surfaceZ(mushroomFloorColumn, oldTreeOnlyPredicate), 171,
  "seed sanity: the old TREE-only predicate reproduces the reopened failure");
assert.throws(() => assert.equal(surfaceZ(mushroomFloorColumn, oldTreeOnlyPredicate), 169),
  "the acceptance assertion must fail against the old TREE-only implementation");

console.log("# real button-to-producer path contracts");
assert.match(controlsSource, /const z = which === "deepest"[^\n]*mm[.]surfaceZ/,
  "surface button must consume currentHud.minimap.surfaceZ");
assert.match(controlsSource, /fetch[(]`[/]camera[?][^`]*[&]z=[$][{]z[}]/,
  "recenter must post that surfaceZ to /camera");
assert.match(httpSource, /server[.]Get[(]"[/]hud"[\s\S]*hud_on_render_thread[(]camera, hud, [&]err[)][\s\S]*hud_json[(]player, hud[)]/,
  "/hud must build and serialize the same HudState");
assert.match(hudSource, /hud[.]surface_z = compute_surface_z[(]camera[.]x, camera[.]y, world[)];/,
  "HudState.surface_z must come from compute_surface_z");
assert.match(hudSource, /"surfaceZ[^\n]*hud[.]surface_z/,
  "hud_json must expose HudState.surface_z as minimap.surfaceZ");

const hudSurface = functionBody(hudSource, "int compute_surface_z", "bool is_counted_citizen");
const initialSurface = functionBody(clientStateSource, "int surface_z_for_initial_camera", "bool seed_first_join_camera");
for (const [name, source] of [["HUD recenter", hudSurface], ["first-join camera", initialSurface]]) {
  assert.match(source, /surface_z_skips_canopy[(][*](?:ttp|tile)[)]/,
    `${name} must use the shared complete canopy predicate`);
  assert.doesNotMatch(source, /tileMaterial[(][*](?:ttp|tile)[)] == df::tiletype_material::TREE/,
    `${name} must not retain the incomplete TREE-only predicate`);
}

console.log("# shared C++ predicate carries the authoritative matrix");
assert.match(helperSource, /material == df::tiletype_material::TREE/);
assert.match(helperSource, /material == df::tiletype_material::MUSHROOM/);
for (const shape of [...treeShapes, ...mushroomCapShapes]) {
  assert.match(helperSource, new RegExp(`df::tiletype_shape::${shape}\\b`), `missing C++ canopy shape ${shape}`);
}

console.log("PASS B69 surface recenter: real /hud path, full canopy matrix, z171->z169, seeded TREE-only failure");
