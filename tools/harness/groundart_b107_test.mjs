// dwf -- multiplayer Dwarf Fortress in the browser
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// B71/B107 SOURCE-LIST REGRESSION GATE.
//
// History: GROUNDART (2026-07-10) broadened the tree grass-backing source predicate to accept
// dry/dead grass AND any outside SoilFloor/*Pebbles tile with a trace grass amount, and this
// file originally LOCKED that broadening in. That change:
//   * made nearly every above-ground trunk paint a bright-summer-grass square even over
//     dirt/dry ground where native shows tan/brown -> "green where native shows none",
//   * was re-reviewed FAIL by a playtester (registry B107, 2026-07-10T20:02:19Z, "still broken"),
//   * and silently broke the b62_trunk_walljoin_test invariant ("dry/dead never trigger").
// B71 ("transparent green band spreading around grass cells") is the same artifact.
//
// Fix (wave/green-band): isGrassBackingSource reverts to the B62-r2 original -- LIVE
// GRASS_LIGHT/GRASS_DARK ONLY, never dry/dead, never invented biome grass. This gate now
// asserts the REVERTED predicate so a future re-broadening fails loudly. Note: grass-under
// compositing on the FLOOR tiles themselves (B37 exterior pebbles, B92 pebble family) is a
// SEPARATE server-tail-driven path in resolveSprite and is intentionally NOT covered here --
// this predicate only governs what a solid TREE/MUSHROOM tile borrows for its backing.
import assert from "node:assert/strict";
import { loadTiles, loadGL } from "./groundart_fixture_support.mjs";
const T = loadTiles(), G = loadGL();
const cases = [
  [{ mat: "GRASS_LIGHT" }, true, "live light grass"],
  [{ mat: "GRASS_DARK" }, true, "live dark grass"],
  [{ mat: "GRASS_DRY" }, false, "B71: dry grass no longer backs (summer wash != native tan)"],
  [{ mat: "GRASS_DEAD" }, false, "B71: dead grass no longer backs"],
  [{ outside: 1, ttname: "MineralPebbles2", grass: { amount: 1 } }, false, "B71: trace-grass pebble floor no longer backs"],
  [{ outside: 1, ttname: "SoilFloor1", grass: { amount: 1 } }, false, "B71: trace-grass soil floor no longer backs"],
  [{ outside: 1, ttname: "StoneFloor1", grass: { amount: 1 } }, false, "rough floor never backed"],
  [{ mat: "GRASS_LIGHT", hidden: true }, false, "hidden source never backs"],
];
for (const [tile, want, label] of cases) {
  assert.equal(T._isGrassBackingSourceForTest(tile), want, "canvas " + label);
  assert.equal(G.isGrassBackingSource(tile), want, "GL " + label);
}
console.log("PASS B71/B107 backing-source fixture (live grass only; dry/dead/trace-soil rejected in both renderers)");
