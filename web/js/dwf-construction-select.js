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

(function (root) {
  "use strict";

  var PLANNED_TOKENS = [
    "PLANNED_CONSTRUCTION_FORTIFICATION",
    "PLANNED_CONSTRUCTION_WALL",
    "PLANNED_CONSTRUCTION_FLOOR",
    "PLANNED_CONSTRUCTION_STAIR_UP",
    "PLANNED_CONSTRUCTION_STAIR_DOWN",
    "PLANNED_CONSTRUCTION_STAIR_UPDOWN",
    "PLANNED_CONSTRUCTION_RAMP",
    "PLANNED_CONSTRUCTION_TRACK_N",
    "PLANNED_CONSTRUCTION_TRACK_S",
    "PLANNED_CONSTRUCTION_TRACK_E",
    "PLANNED_CONSTRUCTION_TRACK_W",
    "PLANNED_CONSTRUCTION_TRACK_NS",
    "PLANNED_CONSTRUCTION_TRACK_NE",
    "PLANNED_CONSTRUCTION_TRACK_NW",
    "PLANNED_CONSTRUCTION_TRACK_SE",
    "PLANNED_CONSTRUCTION_TRACK_SW",
    "PLANNED_CONSTRUCTION_TRACK_WE",
    "PLANNED_CONSTRUCTION_TRACK_NSE",
    "PLANNED_CONSTRUCTION_TRACK_NSW",
    "PLANNED_CONSTRUCTION_TRACK_NWE",
    "PLANNED_CONSTRUCTION_TRACK_SWE",
    "PLANNED_CONSTRUCTION_TRACK_NSWE",
    "PLANNED_CONSTRUCTION_TRACK_RN",
    "PLANNED_CONSTRUCTION_TRACK_RS",
    "PLANNED_CONSTRUCTION_TRACK_RE",
    "PLANNED_CONSTRUCTION_TRACK_RW",
    "PLANNED_CONSTRUCTION_TRACK_RNS",
    "PLANNED_CONSTRUCTION_TRACK_RNE",
    "PLANNED_CONSTRUCTION_TRACK_RNW",
    "PLANNED_CONSTRUCTION_TRACK_RSE",
    "PLANNED_CONSTRUCTION_TRACK_RSW",
    "PLANNED_CONSTRUCTION_TRACK_RWE",
    "PLANNED_CONSTRUCTION_TRACK_RNSE",
    "PLANNED_CONSTRUCTION_TRACK_RNSW",
    "PLANNED_CONSTRUCTION_TRACK_RNWE",
    "PLANNED_CONSTRUCTION_TRACK_RSWE",
    "PLANNED_CONSTRUCTION_TRACK_RNSWE",
    "PLANNED_CONSTRUCTION_REINFORCED_WALL",
  ];
  Object.freeze(PLANNED_TOKENS);

  var BRIDGE_ROW_SUFFIXES = [
    "1x1_RAISE_E", "1x1_RAISE_W", "1x1_RAISE_N", "1x1_RAISE_S",
    "NS_CENTER", "NS_1", "NS_W", "NS_E", "WE_CENTER", "WE_1", "WE_N", "WE_S",
    "RAISE_N_CENTER", "RAISE_N_1", "RAISE_N_W", "RAISE_N_E",
    "RAISE_S_CENTER", "RAISE_S_1", "RAISE_S_W", "RAISE_S_E",
    "RAISE_W_CENTER", "RAISE_W_1", "RAISE_W_N", "RAISE_W_S",
    "RAISE_E_CENTER", "RAISE_E_1", "RAISE_E_N", "RAISE_E_S",
    "RAISE_S_END_CENTER", "RAISE_S_END_1", "RAISE_S_END_W", "RAISE_S_END_E",
    "RAISE_N_END_CENTER", "RAISE_N_END_1", "RAISE_N_END_W", "RAISE_N_END_E",
    "RAISE_E_END_CENTER", "RAISE_E_END_1", "RAISE_E_END_N", "RAISE_E_END_S",
    "RAISE_W_END_CENTER", "RAISE_W_END_1", "RAISE_W_END_N", "RAISE_W_END_S",
    "RAISED_W_CENTER", "RAISED_E_CENTER", "RAISED_S_CENTER", "RAISED_N_CENTER",
    "RAISED_W_N", "RAISED_W_S", "RAISED_E_N", "RAISED_E_S",
    "RAISED_S_W", "RAISED_S_E", "RAISED_N_W", "RAISED_N_E",
    "RAISED_W_1", "RAISED_E_1", "RAISED_S_1", "RAISED_N_1",
    "CONSTRUCTION", "RETRACT_CENTER", "RETRACT_WE", "RETRACT_W", "RETRACT_E", "RETRACT_NS",
    "RETRACT_N", "RETRACT_S", "RETRACT_NWE", "RETRACT_SWE", "RETRACT_NSW",
    "RETRACT_NSE", "RETRACT_NE", "RETRACT_NW", "RETRACT_SW", "RETRACT_SE",
  ];
  Object.freeze(BRIDGE_ROW_SUFFIXES);
  var BRIDGE_TOKENS = {};
  ["WOOD", "STONE", "METAL", "GLASS"].forEach(function (material) {
    BRIDGE_TOKENS[material] = Object.freeze(BRIDGE_ROW_SUFFIXES.map(function (suffix) {
      return "BLD_BRIDGE_" + material + "_" + suffix;
    }));
  });
  Object.freeze(BRIDGE_TOKENS);

  function bridgeSheetRow(tileIndex) {
    return tileIndex < 0x3c ? tileIndex : tileIndex - 1;
  }

  function bridgeTileIndex(dir, raised, rx1, rx2, ry1, ry2, x, y) {
    var w1 = rx1 === rx2, h1 = ry1 === ry2;
    var fx = x === rx1, lx = x === rx2, fy = y === ry1, ly = y === ry2;
    if (raised) {
      if (dir === -1) return null;
      if (w1 && h1) return dir === 0 ? 0x38 : dir === 1 ? 0x39 : dir === 3 ? 0x3a : 0x3b;
      if (dir === 0) return fy ? 0x30 : ly ? 0x31 : 0x2c;
      if (dir === 1) return fy ? 0x32 : ly ? 0x33 : 0x2d;
      if (dir === 3) return fx ? 0x34 : lx ? 0x35 : 0x2e;
      return fx ? 0x36 : lx ? 0x37 : 0x2f;
    }
    if (dir === -1) {
      if (w1 && h1) return 0x3d;
      if (h1) return fx ? 0x47 : lx ? 0x48 : 0x42;
      if (w1) return fy ? 0x45 : ly ? 0x46 : 0x3f;
      if (fy) return fx ? 0x4a : lx ? 0x49 : 0x43;
      if (ly) return fx ? 0x4b : lx ? 0x4c : 0x44;
      return fx ? 0x40 : lx ? 0x41 : 0x3e;
    }
    if (w1 && h1) return dir === 1 ? 0x00 : dir === 0 ? 0x01 : dir === 2 ? 0x02 : 0x03;
    if (dir === 0) {
      if (h1) return fx ? 0x15 : lx ? 0x25 : 0x09;
      if (fx) return fy ? 0x16 : ly ? 0x17 : 0x14;
      if (lx) return fy ? 0x26 : ly ? 0x27 : 0x24;
      return fy ? 0x0a : ly ? 0x0b : 0x08;
    }
    if (dir === 1) {
      if (h1) return fx ? 0x29 : lx ? 0x19 : 0x09;
      if (lx) return fy ? 0x1a : ly ? 0x1b : 0x18;
      if (!fx) return fy ? 0x0a : ly ? 0x0b : 0x08;
      return fy ? 0x2a : ly ? 0x2b : 0x28;
    }
    if (dir === 2) {
      if (w1) return fy ? 0x0d : ly ? 0x1d : 0x05;
      if (fy) return fx ? 0x0e : lx ? 0x0f : 0x0c;
      if (ly) return fx ? 0x1e : lx ? 0x1f : 0x1c;
      return fx ? 0x06 : lx ? 0x07 : 0x04;
    }
    if (w1) return fy ? 0x21 : ly ? 0x11 : 0x05;
    if (ly) return fx ? 0x12 : lx ? 0x13 : 0x10;
    if (fy) return fx ? 0x22 : lx ? 0x23 : 0x20;
    return fx ? 0x06 : lx ? 0x07 : 0x04;
  }

  function plannedConstructionEntry(b, buildingMap) {
    if (!buildingMap || !b || b.type !== "Construction") return null;
    var st = (typeof b.subtype === "number") ? b.subtype : -1;
    if (st < 0 || st >= PLANNED_TOKENS.length) return null;
    var token = PLANNED_TOKENS[st];
    return (token && buildingMap[token]) ? buildingMap[token] : null;
  }

  root.DwfConstructionSelect = Object.freeze({
    PLANNED_TOKENS: PLANNED_TOKENS,
    BRIDGE_ROW_SUFFIXES: BRIDGE_ROW_SUFFIXES,
    BRIDGE_TOKENS: BRIDGE_TOKENS,
    bridgeSheetRow: bridgeSheetRow,
    bridgeTileIndex: bridgeTileIndex,
    plannedConstructionEntry: plannedConstructionEntry,
  });
})(typeof window !== "undefined" ? window : globalThis);
