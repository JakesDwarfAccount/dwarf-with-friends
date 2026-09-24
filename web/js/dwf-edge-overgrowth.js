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

// Rules ledger 0028: floor-family overgrowth. This module owns the pure family/side/corner
// policy so canvas2d and GL cannot drift. Renderers own only their native blit/instance calls.
(function (root) {
  "use strict";

  // Native side-code order in screentexpos_floor_flag: S, W, E, N.
  var SIDE = [
    { name: "S", dx: 0, dy: 1, shift: 0, slot: 1 },
    { name: "W", dx: -1, dy: 0, shift: 8, slot: 5 },
    { name: "E", dx: 1, dy: 0, shift: 16, slot: 3 },
    { name: "N", dx: 0, dy: -1, shift: 24, slot: 7 },
  ];
  var CORNER = [
    { a: "S", b: "W", slot: 2 },
    { a: "S", b: "E", slot: 0 },
    { a: "N", b: "W", slot: 8 },
    { a: "N", b: "E", slot: 6 },
  ];

  // Vanilla CUSTOM_EDGING indices 0..4 (raw token values 1..5). Slot 4 is intentionally absent.
  var CUSTOM = {
    "FLOOR FUNGI": { code: 10, index: 0, sheet: "cavern_grass.png", row: 0 },
    "CAVE MOSS": { code: 11, index: 1, sheet: "cavern_grass.png", row: 1 },
    "UNDERLICHEN": { code: 12, index: 2, sheet: "cavern_grass.png", row: 2 },
    "BUBBLE BULBS": { code: 13, index: 3, sheet: "grass_other.png", row: 2 },
    "DOWNY GRASS": { code: 14, index: 4, sheet: "grass_other.png", row: 3 },
  };
  // Page columns 4..11 are W,E,S,N,NW,NE,SW,SE; table slots are the 3x3 offset grid.
  var SLOT_COL = { 0: 11, 1: 6, 2: 10, 3: 5, 5: 4, 6: 9, 7: 7, 8: 8 };
  var ART_BY_CODE = Object.create(null);
  Object.keys(CUSTOM).forEach(function (id) { ART_BY_CODE[CUSTOM[id].code] = CUSTOM[id]; });

  function terrainShape(t) {
    var s = (t && t.shape) || "";
    return s === "FLOOR" || s === "PEBBLES" || s === "BOULDER" ||
      s === "STAIR_UP" || s === "STAIR_DOWN" || s === "STAIR_UPDOWN" || s === "RAMP";
  }

  function soilCode(t) {
    // Synthetic fixtures and a future richer wire may carry native's already-classified code.
    var explicit = t && (t.edge_code != null ? t.edge_code : t.edgeCode);
    if (explicit >= 3 && explicit <= 7) return explicit | 0;
    // The material map carries palette rows, not the descriptor-pattern RGB native thresholds on, so keep
    // the neutral bucket rather than inventing thresholds.
    return 4;
  }

  function family(code, index, name) { return { code: code, index: index, name: name }; }

  function familiesForTile(t) {
    // Native routes shrub, sapling and plant tiletypes through the same grass lookup as exposed floors:
    // the standing plant neither suppresses the species nor stops it claiming a neighbour side.
    if (!t || t.hidden || (!terrainShape(t) && !t.plant)) return [];
    var out = [];
    if (t.grass && t.grass.amount > 0) {
      var c = CUSTOM[t.grass.id];
      // Plain grass is native code 1 and loses every custom-edger contest. Its block is not
      // resolved to a shipped page by ledger 0028, so it participates but artFor() returns null.
      out.push(c ? family(c.code, c.index, t.grass.id) : family(1, 32, "PLAIN GRASS"));
    }
    var shape = t.shape || "", mat = t.mat || "";
    if (mat === "SOIL") {
      var sc = soilCode(t);
      out.push(family(sc, sc, "SOIL " + sc));
    } else if (shape === "PEBBLES") {
      out.push(family(8, 8, "PEBBLES"));
    } else if (mat === "STONE" && (shape === "FLOOR" || shape.indexOf("STAIR") === 0 || shape === "RAMP")) {
      out.push(family(9, 9, "STONE"));
    }
    return out;
  }

  function pickFamily(candidates) {
    var incumbent = null;
    for (var i = 0; i < (candidates || []).length; i++) {
      var c = candidates[i];
      if (!c || !(c.code > 0) || typeof c.index !== "number") continue;
      // Strictly lower wins. Equal index deliberately keeps the first incumbent.
      if (!incumbent || c.index < incumbent.index) incumbent = c;
    }
    return incumbent;
  }

  function sideCodes(lookup, x, y) {
    var out = { S: 0, W: 0, E: 0, N: 0 };
    for (var i = 0; i < SIDE.length; i++) {
      var d = SIDE[i];
      var f = pickFamily(familiesForTile(lookup(x + d.dx, y + d.dy)));
      out[d.name] = f ? f.code : 0;
    }
    return out;
  }

  function packSideCodes(codes) {
    var word = 0;
    for (var i = 0; i < SIDE.length; i++) word |= ((codes[SIDE[i].name] || 0) & 255) << SIDE[i].shift;
    return word >>> 0;
  }

  function plan(lookup, x, y) {
    var codes = sideCodes(lookup, x, y);
    var draws = [];
    var i, d, code;
    for (i = 0; i < SIDE.length; i++) {
      d = SIDE[i]; code = codes[d.name];
      if (code) draws.push({ kind: "side", code: code, slot: d.slot });
    }
    for (i = 0; i < CORNER.length; i++) {
      d = CORNER[i]; code = codes[d.a];
      // Corners derive only from orthogonal side pairs. Diagonal tiles are never inspected.
      if (code && code === codes[d.b]) draws.push({ kind: "corner", code: code, slot: d.slot });
    }
    return { codes: codes, packed: packSideCodes(codes), draws: draws };
  }

  function artFor(code, slot) {
    var a = ART_BY_CODE[code], col = SLOT_COL[slot];
    return a && col != null ? { sheet: a.sheet, col: col, row: a.row } : null;
  }

  root.DwfEdgeOvergrowth = {
    SIDE: SIDE, CORNER: CORNER, CUSTOM: CUSTOM, SLOT_COL: SLOT_COL,
    soilCode: soilCode, familiesForTile: familiesForTile, pickFamily: pickFamily,
    sideCodes: sideCodes, packSideCodes: packSideCodes, plan: plan, artFor: artFor,
  };
})(typeof window !== "undefined" ? window : self);
