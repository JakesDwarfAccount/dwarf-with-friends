// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// B170 source-contract fixture: hover enumerates live block flows and names them from the
// complete df::flow_type switch. A compiled/live oracle is intentionally outside this fixture.
import fs from "node:fs";
import assert from "node:assert/strict";

const src = fs.readFileSync(new URL("../../src/interaction.cpp", import.meta.url), "utf8");
const names = ["Miasma", "Steam", "Mist", "MaterialDust", "MagmaMist", "Smoke",
  "Dragonfire", "Fire", "Web", "MaterialGas", "MaterialVapor", "OceanWave", "SeaFoam", "ItemCloud"];

assert.match(src, /for \(auto flow : block->flows\)/, "hover must inspect block->flows");
assert.match(src, /flow->flags\.bits\.DEAD \|\| flow->density <= 0/, "dead flows must be ignored");
assert.match(src, /hover_push\(out, "flow", hover_flow_name\(hover_flow->type\)\)/,
  "flow result must enter the ordinary hover line path");
for (const name of names) assert.match(src, new RegExp(`flow_type::${name}`), `enum cell ${name}`);
assert.match(src, /case flow_type::Miasma:\s+return "Miasma";/, "Miasma must resolve natively");
assert.match(src, /default:\s+return "";/, "unknown future flow kinds must fail open");

const seededBad = src.replace(/case flow_type::Miasma:\s+return "Miasma";/, 'case flow_type::Miasma: return "";');
assert.doesNotMatch(seededBad, /case flow_type::Miasma:\s+return "Miasma";/,
  "TEST-THE-TEST: miasma resolving to nothing is rejected");

console.log("b170_flow_hover_test: PASS (20 checks)");
