// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// B126: gather rectangles classify targets by SHRUB tile shape, not tree_info absence.
import assert from "node:assert/strict";
import fs from "node:fs";
const placement = fs.readFileSync("src/placement.cpp", "utf8");
const fn = placement.match(/bool apply_plant_designations\([\s\S]*?\n\}/)?.[0] || "";
assert.match(fn, /for \(df::plant\* plant : world->plants\.all\)/, "rectangle visits the complete plant collection");
assert.match(fn, /DesignationKind::Gather[\s\S]*?Maps::getTileType\(pos\)[\s\S]*?!tiletype[\s\S]*?tileShape\(\*tiletype\) != df::tiletype_shape::SHRUB[\s\S]*?continue;/,
  "gather uses a null-checked live tiletype read to accept SHRUB tiles and exclude saplings");
assert.doesNotMatch(fn, /tileShape\(map\.tiletypeAt\(pos\)\)/,
  "gather must not snapshot MapCache before markPlant writes the live designation");
assert.doesNotMatch(fn, /DesignationKind::Gather && is_tree/, "tree_info proxy no longer misclassifies saplings as shrubs");
assert.match(fn, /pos\.x < wx1 \|\| pos\.x > wx2 \|\| pos\.y < wy1 \|\| pos\.y > wy2/, "selection uses both inclusive rectangle corners");
assert.match(fn, /Designations::markPlant\(plant\)/, "each accepted shrub is designated through DFHack's plant API");
assert.match(fn, /Designations::markPlant\(plant\)[\s\S]*?Maps::getTileDesignation\(pos\)[\s\S]*?Maps::getTileOccupancy\(pos\)[\s\S]*?!live_des \|\| !live_occ[\s\S]*?df::tile_designation des = \*live_des;[\s\S]*?df::tile_occupancy occ = \*live_occ;/,
  "post-mark designation and occupancy values come from null-checked live reads");
assert.doesNotMatch(fn, /map\.designationAt\(pos\)|map\.occupancyAt\(pos\)/,
  "post-mark reads must not use a block snapshot that can be stale for gather or chop");
console.log("PASS B126 gather rectangle designates all SHRUB tiles and excludes SAPLING tiles");
