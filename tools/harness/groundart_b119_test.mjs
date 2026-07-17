// dwf -- multiplayer Dwarf Fortress in the browser
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
// B119: material identity disambiguates SoilFloor<n>; white sand must select sand_floor.png.
import assert from "node:assert/strict";
import { loadTiles, loadGL, makeAtlas } from "./groundart_fixture_support.mjs";
const materialMap = { inorganic: [{ id: "LOAM" }, { id: "SAND_WHITE" }, { id: "SAND_RED" }] };
const white = { base_mt: 0, base_mi: 1 }, loam = { base_mt: 0, base_mi: 0 }, red = { base_mt: 0, base_mi: 2 };
const T = loadTiles(); T._setMaterialMapForTest(materialMap);
const c2dWhite = T._sandFloorPlanForTest(white, "SoilFloor3"); assert.equal(c2dWhite.token, "SAND_WHITE_FLOOR_5", "canvas white sand native base"); assert.equal(c2dWhite.overlay, "SAND_WHITE_FLOOR_3", "canvas white sand native detail");
assert.equal(T._sandFloorPlanForTest(loam, "SoilFloor3"), null, "seeded non-sand soil must not use sand art");
const G = loadGL(), b = G.createSceneBuilder({ atlas: makeAtlas(), materialMap });
const plan = b._sandFloorPlanForTest(white, "SoilFloor3"); assert.equal(plan.token, "SAND_WHITE_FLOOR_5", "GL white sand token"); assert.equal(plan.overlay, "SAND_WHITE_FLOOR_3", "GL native detail token");
assert.equal(b._sandFloorPlanForTest(red, "SoilFloor3").token, "SAND_RED_FLOOR_5", "matrix edge: red sand family");
console.log("PASS B119 sand-floor fixture (white/red + non-sand counterexample)");
