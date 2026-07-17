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

// dwf-adjacency.js -- WB-6 (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md,
// "shared 8-neighbor adjacency + wall-join upgrade"). ONE renderer-agnostic, worker-loadable
// primitive for every "does this tile have a wall/hidden/whatever neighbor in direction D"
// question in the client: wall-join sprite selection (dwf-tiles.js's drawWallJoin),
// the WB-7 shadow-decal tables (wall/ramp/vision), and (per RECONCILE-WA §0) the SAME
// function W-A's ingest worker will eventually run over chunk+ring to populate a
// `derived.joinMask` field once the world cache lands -- so this file intentionally does
// NOT close over any renderer/DOM/cache state; it is pure functions of a caller-supplied
// `lookup(x, y) -> tile|null` accessor.
//
// DUAL-MODE FILE (same convention as dwf-cache-worker.js): a plain <script> in the
// browser (`window.DwfAdjacency`), a dedicated Worker (`self.DwfAdjacency`), or
// loaded via vm.runInThisContext in a Node unit test (tools/spikes/webgl/adjacency-test.mjs).
//
// Bit order (fog report §1 / render-buffer verdict): shadow_flag bits 2..9 decode to
// wall-at N,S,W,E,NW,NE,SW,SE, in that exact order -- BIT.N is bit index 0 of mask8,
// matching shadow_flag bit 2; BIT.SE is bit index 7, matching shadow_flag bit 9. Keeping the
// SAME order here means a mask8 value can be compared directly (mask8 << 2) against a raw
// tiledump's shadow_flag for the empirical cross-check scripts (WB-7 acceptance).
(function (root) {
  "use strict";

  const DIR = { N: 0, S: 1, W: 2, E: 3, NW: 4, NE: 5, SW: 6, SE: 7 };
  const BIT = {
    N: 1 << DIR.N, S: 1 << DIR.S, W: 1 << DIR.W, E: 1 << DIR.E,
    NW: 1 << DIR.NW, NE: 1 << DIR.NE, SW: 1 << DIR.SW, SE: 1 << DIR.SE,
  };
  // (dx,dy) offsets in the same N,S,W,E,NW,NE,SW,SE order (screen/world convention: +y south).
  const DELTA = [
    [0, -1], [0, 1], [-1, 0], [1, 0],
    [-1, -1], [1, -1], [-1, 1], [1, 1],
  ];
  const DIR_NAMES = ["N", "S", "W", "E", "NW", "NE", "SW", "SE"];
  const CARDINAL_BITS = BIT.N | BIT.S | BIT.W | BIT.E;
  const DIAGONAL_BITS = BIT.NW | BIT.NE | BIT.SW | BIT.SE;

  // Default join predicate (coverage §1.1 wallnbr semantics, carried forward unchanged):
  // only shape==="WALL" neighbors join. Fortifications are a DISTINCT shape ("FORTIFICATION")
  // and closed doors/bridges are BUILDINGS overlaid on a non-WALL floor tile -- neither ever
  // satisfies this check, so both are correctly excluded without special-casing them here.
  function isJoiningWall(t) {
    return !!t && t.shape === "WALL";
  }

  // Hidden-neighbor predicate (WB-7's vision-shadow table uses the identical machinery with
  // this predicate instead of isJoiningWall).
  function isHiddenTile(t) {
    return !!t && !!t.hidden;
  }

  // B36 wall-face predicate: DF's directional wall cells (SOIL_WALL_N / _W_E / _N_S_W_E, the
  // corner NW..SE, etc.) draw the rocky texture strip on the EXPOSED faces -- the edges where
  // the wall borders open, passable space -- NOT on the faces buried against another wall. So
  // wall-cell selection feeds this predicate's mask (the INVERSE of isJoiningWall) to
  // cardinalSuffix/diagOnlyToken. A wall tile is "open toward" a neighbour when that neighbour
  // exists, is discovered, and is not itself a joining wall. A null/unaddressable neighbour
  // (viewport edge) and a still-hidden neighbour both count as NOT open (treated as solid) so
  // no spurious rock edge is drawn at the window boundary or along the fog-of-war line -- the
  // same safe-direction handling of the 1-tile edge artifact both renderers already use.
  function isOpenNeighbor(t) {
    if (!t || t.hidden || t.shape === "WALL") return false;
    // WT25's in-bounds tt<0 cache placeholder is undiscovered rock, but has no `hidden` bit.
    // Treating it as open paints a false material-coloured wall face toward every cache hole.
    return typeof t.tt !== "number" || t.tt >= 0;
  }

  // B36: given a wall tile's 8-bit OPEN-neighbour mask (computeMask8 with isOpenNeighbor, or the
  // equivalent grid mask), return the DF wall-cell direction infix -- the exposed-cardinal join
  // ("N", "N_S", "W_E", "N_S_W_E", ...) when any cardinal face is exposed, else a lone exposed
  // corner ("NW".."SE"), else null when the wall is FULLY BURIED (no exposed cardinal or corner
  // -> the renderer draws only the darkened base fill, DF's dark wall interior). Shared by both
  // renderers so their wall-cell choice is byte-identical for the same adjacency.
  function wallCellSuffix(openMask8) {
    var s = cardinalSuffix(openMask8);
    if (s) return s;
    return diagOnlyToken(openMask8); // null when fully buried
  }

  // Compute the 8-bit adjacency mask around (x,y) via a caller-supplied lookup(x,y) -> tile|
  // null accessor (today: a closure over the screen-window tileBuf; once W-A's cache lands:
  // a chunk+ring reader run inside the ingest worker -- this function must not care which).
  // `predicate(tile) -> boolean` decides whether a given neighbor counts (default: wall-join
  // rule above). A neighbor outside the caller's addressable window (lookup returns null/
  // undefined) never sets its bit -- the same 1-tile viewport-edge artifact DF itself shows
  // (render-buffer §B), not a bug to fix here.
  function computeMask8(lookup, x, y, predicate) {
    const pred = predicate || isJoiningWall;
    let mask = 0;
    for (let i = 0; i < 8; i++) {
      const d = DELTA[i];
      let t;
      try { t = lookup(x + d[0], y + d[1]); } catch (_) { t = null; }
      if (pred(t)) mask |= (1 << i);
    }
    return mask;
  }

  // Cardinal-only suffix string in DF's own token order (N,S,W,E), e.g. mask8 with N|E set
  // -> "N_E" (matches STONE_WALL_N_E / ORE_VEIN_WALL_N_E / VISION_SHADOW_N_E, ...). Returns
  // "" when no cardinal bit is set (today's 4-bit wallSuffix, unchanged, just fed by mask8).
  function cardinalSuffix(mask8) {
    const parts = [];
    if (mask8 & BIT.N) parts.push("N");
    if (mask8 & BIT.S) parts.push("S");
    if (mask8 & BIT.W) parts.push("W");
    if (mask8 & BIT.E) parts.push("E");
    return parts.join("_");
  }

  // Bare corner-cap token (coverage #10: "_NE/_SE/..." need the 4 diagonals") for the
  // DIAGONAL-ONLY case: a tile whose only DF-adjacent neighbor (of the same joining kind) is
  // at a corner, no cardinal neighbor at all -- the old 4-bit mask had no bit to represent
  // this, so these tiles always fell back to the default/no-decal art. Priority when more
  // than one diagonal bit is set with zero cardinals (rare, undocumented in the raws): NW,
  // NE, SW, SE in that order -- any single real corner sprite beats the previous "" bail.
  function diagOnlyToken(mask8) {
    if (mask8 & CARDINAL_BITS) return null;   // cardinal case handled by cardinalSuffix
    if (mask8 & BIT.NW) return "NW";
    if (mask8 & BIT.NE) return "NE";
    if (mask8 & BIT.SW) return "SW";
    if (mask8 & BIT.SE) return "SE";
    return null;
  }

  const api = {
    DIR, BIT, DELTA, DIR_NAMES, CARDINAL_BITS, DIAGONAL_BITS,
    isJoiningWall, isHiddenTile, isOpenNeighbor,
    computeMask8, cardinalSuffix, diagOnlyToken, wallCellSuffix,
  };

  try { root.DwfAdjacency = api; } catch (_) { /* non-browser/worker context */ }
  // CommonJS export path for the Node unit test's alternate require() convenience (the test
  // itself uses the vm.runInThisContext + globalThis convention like the other harness tests,
  // but exporting here too costs nothing and keeps this module importable either way).
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
