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

// dwf-adjacency.js -- the shared 8-neighbour adjacency primitive: pure functions of a
// caller-supplied `lookup(x, y) -> tile|null`, with no renderer, DOM or cache state closed over.
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
  const ENG_W = 0x0002, ENG_E = 0x0004, ENG_N = 0x0008, ENG_S = 0x0010,
        ENG_NW = 0x0040, ENG_NE = 0x0080, ENG_SW = 0x0100, ENG_SE = 0x0200;
  const ENG_CARDINAL_BITS = ENG_N | ENG_S | ENG_W | ENG_E;

  // Only shape === "WALL" joins. Fortifications are a distinct shape and closed doors and bridges are
  // buildings over a non-WALL floor, so both are excluded without special-casing them here.
  function isJoiningWall(t) {
    return !!t && t.shape === "WALL";
  }

  // Hidden-neighbor predicate (the vision-shadow table uses the identical machinery with
  // this predicate instead of isJoiningWall).
  function isHiddenTile(t) {
    return !!t && !!t.hidden;
  }

  // The INVERSE of isJoiningWall. A null or still-hidden neighbour counts as SOLID, so no spurious rock
  // face is drawn at the window boundary or along the fog-of-war line.
  function isOpenNeighbor(t) {
    if (!t || t.hidden || t.shape === "WALL") return false;
    // An in-bounds tt<0 cache placeholder is undiscovered rock with no `hidden` bit: treating it as open
    // paints a false material-coloured wall face toward every cache hole.
    return typeof t.tt !== "number" || t.tt >= 0;
  }

  // Returns the DF wall-cell direction infix: the exposed-cardinal join, else a lone exposed corner,
  // else null when the wall is FULLY BURIED. Shared so both renderers pick the same cell.
  function wallCellSuffix(openMask8) {
    var s = cardinalSuffix(openMask8);
    if (s) return s;
    return diagOnlyToken(openMask8); // null when fully buried
  }

  function engravingWallToken(mask) {
    const cardinal = mask & ENG_CARDINAL_BITS;
    if (cardinal) {
      const parts = [];
      if (cardinal & ENG_N) parts.push("N");
      if (cardinal & ENG_S) parts.push("S");
      if (cardinal & ENG_W) parts.push("W");
      if (cardinal & ENG_E) parts.push("E");
      return "ENGRAVED_STONE_WALL_" + parts.join("_");
    }
    if (mask & ENG_NW) return "ENGRAVED_STONE_WALL_NW";
    if (mask & ENG_NE) return "ENGRAVED_STONE_WALL_NE";
    if (mask & ENG_SW) return "ENGRAVED_STONE_WALL_SW";
    if (mask & ENG_SE) return "ENGRAVED_STONE_WALL_SE";
    return null;
  }

  // A neighbour outside the caller's addressable window never sets its bit -- the same one-tile viewport
  // edge artifact DF itself shows, not a bug to fix here.
  function computeMask8(lookup, x, y, predicate) {
    const pred = predicate || isJoiningWall;
    let mask = 0;
    for (let i = 0; i < 8; i++) {
      const d = DELTA[i];
      let t;
      try { t = lookup(x + d[0], y + d[1]); } catch { t = null; }
      if (pred(t)) mask |= (1 << i);
    }
    return mask;
  }

  // Cardinal-only suffix in DF's own token order (N,S,W,E); "" when no cardinal bit is set.
  function cardinalSuffix(mask8) {
    const parts = [];
    if (mask8 & BIT.N) parts.push("N");
    if (mask8 & BIT.S) parts.push("S");
    if (mask8 & BIT.W) parts.push("W");
    if (mask8 & BIT.E) parts.push("E");
    return parts.join("_");
  }

  // The DIAGONAL-ONLY case: no cardinal neighbour at all. With several diagonals set the priority is
  // NW, NE, SW, SE -- any real corner sprite beats the previous empty bail.
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
    computeMask8, cardinalSuffix, diagOnlyToken, wallCellSuffix, engravingWallToken,
  };

  try { root.DwfAdjacency = api; } catch { /* Node loads through module.exports below */ }
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
