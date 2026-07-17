// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// B122/B124: GatherPlants AUX recovery must never create a glyph on a non-shrub tile.
import assert from "node:assert/strict";
import fs from "node:fs";
const world = fs.readFileSync("src/world_stream.cpp", "utf8");
const gatherCase = world.match(/case df::job_type::GatherPlants:[\s\S]*?kind = 6; break;/)?.[0] || "";
assert.match(gatherCase, /Maps::getTileBlock\(job->pos\)/, "GatherPlants job validates its live map position");
assert.match(gatherCase, /tileShape[\s\S]*?tiletype_shape::SHRUB/, "only a live SHRUB tile can emit djob kind 6");
assert.match(gatherCase, /if \(!block \|\|[\s\S]*?continue;/, "missing/non-shrub positions are rejected, not rendered");
assert.doesNotMatch(gatherCase, /kind = 6; break;\s*\/\/ gather\s*$/m, "test-the-test rejects the pre-fix enum-only mapping");
console.log("PASS B122/B124 GatherPlants jobs are shrub-position validated; phantom ground glyphs cannot enter AUX");
