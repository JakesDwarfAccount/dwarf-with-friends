// dwf -- multiplayer Dwarf Fortress in the browser
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// B71 ("transparent green band spreading around grass cells") ==
// B107 ("tree trunks have a visible mis-shaded grass square around them").
//
// ROOT CAUSE: grassBackingCell / grassBackingCellGL fill a TREE/MUSHROOM tile's base with a
// borrowed grass composite (grass.png cell + grassSummer wash) so grass "shows through" the
// trunk sprite's transparent pixels. Two over-reaches made it paint grass where NATIVE draws
// the trunk's actual (non-grass) ground -- a green square/band around trunks that native lacks:
//   (1) REACH rings 1..3  -> a trunk on dirt up to 3 tiles from a meadow borrowed that grass,
//       so a treeline on non-grass ground painted a grass band "spreading around" the grass.
//   (2) B107 SOURCE broadening -> dry/dead grass and any outside SoilFloor/*Pebbles with a
//       trace grass amount also counted as sources, so nearly every above-ground trunk lit up
//       bright summer green even over tan/brown ground (re-review FAIL, registry B107).
// The prior machine "disprove" (cdp_probe at a pure grass field, 2026-07-11) missed it: where
// every tree already sits on ring-1 grass the backing square matches its surroundings and is
// invisible. The artifact only appears at forest edges / trees on non-grass ground near grass.
//
// FIX (wave/green-band): backing sources = LIVE GRASS_LIGHT/GRASS_DARK only; reach = ring 1
// only. A trunk truly embedded in a grass field (grass at ring 1) still shows grass (the
// B62-accepted "trunk is not a brown box" case); a trunk on/near non-grass ground does not
// invent a grass square. This gate pins that invariant in BOTH renderers.
//
// Run: node tools/harness/b71_grass_band_test.mjs

import assert from "node:assert/strict";
import { loadTiles, loadGL } from "./groundart_fixture_support.mjs";

const T = loadTiles();
const G = loadGL();

let failed = 0;
function check(name, cond) {
  if (cond) { console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

// grid: { "gx,gy": tileObj } -> lookup(x,y)
function gridLookup(grid) { return (x, y) => grid[x + "," + y] || null; }
const gbc = T._grassBackingCellForTest;                 // canvas2d (t, gx, gy, lookup) -> cell|null
const TREE = { shape: "WALL", mat: "TREE" };
const MUSH = { shape: "WALL", mat: "MUSHROOM" };
const STONE = { shape: "WALL", mat: "STONE" };

assert.ok(typeof gbc === "function", "canvas2d must export _grassBackingCellForTest");
assert.ok(typeof T._isGrassBackingSourceForTest === "function", "canvas2d must export _isGrassBackingSourceForTest");
assert.ok(typeof G.isGrassBackingSource === "function", "GL must export isGrassBackingSource");
assert.ok(Array.isArray(G.GRASS_BACK_OFFSETS), "GL must export GRASS_BACK_OFFSETS");

console.log("B71 canvas2d: reach is ring 1 only (band no longer spreads)");
// The B62-accepted case survives: a trunk with live grass immediately adjacent shows grass.
check("ring-1 cardinal GRASS_LIGHT -> backing (B62 case preserved)",
  !!gbc(TREE, 5, 5, gridLookup({ "5,4": { mat: "GRASS_LIGHT" } })));
check("ring-1 diagonal GRASS_DARK -> backing (B62 case preserved)",
  !!gbc(TREE, 5, 5, gridLookup({ "6,6": { mat: "GRASS_DARK" } })));
// The reported band: a trunk on non-grass ground with grass only 2-3 tiles away MUST NOT paint grass.
check("ring-2 grass only -> NO backing (this is the band that used to spread)",
  gbc(TREE, 5, 5, gridLookup({ "7,5": { mat: "GRASS_LIGHT" } })) === null);
check("ring-3 grass only -> NO backing",
  gbc(TREE, 5, 5, gridLookup({ "8,5": { mat: "GRASS_LIGHT" } })) === null);
check("mushroom trunk obeys the same ring-1 reach",
  gbc(MUSH, 5, 5, gridLookup({ "7,5": { mat: "GRASS_LIGHT" } })) === null &&
  !!gbc(MUSH, 5, 5, gridLookup({ "5,4": { mat: "GRASS_LIGHT" } })));

console.log("B71 canvas2d: sources are LIVE grass only (B107 broadening reverted)");
check("ring-1 dry+dead grass -> NO backing (summer wash != native tan/brown)",
  gbc(TREE, 5, 5, gridLookup({ "5,4": { mat: "GRASS_DRY" }, "4,5": { mat: "GRASS_DEAD" } })) === null);
check("ring-1 trace-grass MineralPebbles floor -> NO backing",
  gbc(TREE, 5, 5, gridLookup({ "5,4": { outside: 1, ttname: "MineralPebbles2", grass: { amount: 1 } } })) === null);
check("ring-1 trace-grass SoilFloor -> NO backing",
  gbc(TREE, 5, 5, gridLookup({ "5,4": { outside: 1, ttname: "SoilFloor1", grass: { amount: 1 } } })) === null);
check("non-tree (STONE wall) beside live grass -> NO backing (unchanged)",
  gbc(STONE, 5, 5, gridLookup({ "5,4": { mat: "GRASS_LIGHT" } })) === null);
check("hidden live-grass neighbor -> NO backing (unchanged)",
  gbc(TREE, 5, 5, gridLookup({ "5,4": { mat: "GRASS_LIGHT", hidden: true } })) === null);

console.log("B71 GL parity: same governing inputs in the WebGL renderer");
check("GL GRASS_BACK_OFFSETS is ring 1 only (8 offsets, all Chebyshev 1)",
  G.GRASS_BACK_OFFSETS.length === 8 &&
  G.GRASS_BACK_OFFSETS.every((o) => Math.max(Math.abs(o[0]), Math.abs(o[1])) === 1));
const SRC = [
  [{ mat: "GRASS_LIGHT" }, true],
  [{ mat: "GRASS_DARK" }, true],
  [{ mat: "GRASS_DRY" }, false],
  [{ mat: "GRASS_DEAD" }, false],
  [{ outside: 1, ttname: "MineralPebbles2", grass: { amount: 1 } }, false],
  [{ outside: 1, ttname: "SoilFloor1", grass: { amount: 1 } }, false],
  [{ mat: "GRASS_LIGHT", hidden: true }, false],
];
let parityBad = 0;
for (const [tile, want] of SRC) {
  if (G.isGrassBackingSource(tile) !== want) parityBad++;
  if (T._isGrassBackingSourceForTest(tile) !== G.isGrassBackingSource(tile)) parityBad++;
}
check("GL isGrassBackingSource matches the corrected predicate AND agrees with canvas2d", parityBad === 0);

console.log(failed === 0 ? "\nB71 PASS" : `\nB71 FAIL (${failed} assertion(s))`);
process.exit(failed === 0 ? 0 : 1);
