// dwf -- multiplayer Dwarf Fortress in the browser
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
// B118: RampTop is DF's AIR/RAMPSPACE see-down tile, never a terrain-colored square.
import assert from "node:assert/strict";
import { loadTiles, loadGL, makeAtlas } from "./groundart_fixture_support.mjs";
const rampTop = { tt: 1, shape: "RAMP_TOP", mat: "AIR", hidden: false, flow: 0, liquid: "none" };
const ramp = { ...rampTop, shape: "RAMP" };
const T = loadTiles(); assert.equal(T._tileColorForTest(rampTop), null, "canvas RampTop transparent"); assert.notEqual(T._tileColorForTest(ramp), null, "seeded ordinary ramp remains drawable");
const G = loadGL(), b = G.createSceneBuilder({ atlas: makeAtlas() }); assert.equal(b._tileColor(rampTop), null, "GL RampTop transparent"); assert.notEqual(b._tileColor(ramp), null, "GL ordinary ramp remains drawable");
console.log("PASS B118 RampTop fixture (both renderers + ordinary-ramp counterexample)");
