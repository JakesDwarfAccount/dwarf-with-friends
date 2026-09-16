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

// Renderer-neutral item sprite selection.
(function (root) {
  "use strict";

  var CRAFT_TYPES = {
    FIGURINE: 1, AMULET: 1, SCEPTER: 1, CROWN: 1, RING: 1,
    EARRING: 1, BRACELET: 1, TOTEM: 1, TOY: 1,
  };
  var ARMOR_TYPES = { ARMOR: 1, HELM: 1, GLOVES: 1, SHOES: 1, PANTS: 1 };
  var inorganicById = null;
  var indexedInorganic = null;

  function inorganic(materialMap, item) {
    if (!materialMap || !materialMap.inorganic || !item || item.mat_type !== 0) return null;
    if (item.identKind === 3 && item.ident) {
      if (indexedInorganic !== materialMap.inorganic) {
        indexedInorganic = materialMap.inorganic;
        inorganicById = new Map();
        for (var index = 0; index < indexedInorganic.length; index++) {
          var identified = indexedInorganic[index];
          if (identified) inorganicById.set(identified.id, identified);
        }
      }
      return inorganicById.get(item.ident) || null;
    }
    var materialIndex = item.mat_index;
    if (typeof materialIndex !== "number" || materialIndex < 0 ||
        materialIndex >= materialMap.inorganic.length) return null;
    return materialMap.inorganic[materialIndex] || null;
  }

  function isMetal(materialMap, item) {
    if (!item || item.mat_type !== 0) return false;
    var entry = inorganic(materialMap, item);
    return !!(entry && entry.family === "METAL");
  }

  function isLeather(item) {
    return !!item && item.mat_type >= 19 && item.mat_type <= 218;
  }

  function containerPeekToken(container, peek, materialMap) {
    if (!container || !peek || !peek.type) return null;
    var type = peek.type;
    if (container.type === "BARREL") {
      if (type === "MEAT") return "ITEM_BARREL_TOP_MEAT";
      if (type === "FISH" || type === "FISH_RAW") return "ITEM_BARREL_TOP_FISH";
      if (type === "CHEESE") return "ITEM_BARREL_TOP_CHEESE";
      if (type === "FOOD") return "ITEM_BARREL_TOP_MEAL";
      if (type === "PLANT" || type === "PLANT_GROWTH")
        return (peek.cflags & 0x01)
          ? "ITEM_BARREL_TOP_PLANT_SUBTERRANEAN" : "ITEM_BARREL_TOP_PLANT";
      if (type === "BOX") return "ITEM_BARREL_TOP_BAG";
      if (type === "DRINK" || type === "LIQUID_MISC")
        return isMetal(materialMap, container)
          ? "LIQUID_FOR_BARREL_METAL" : "LIQUID_FOR_BARREL_WOOD";
      return null;
    }
    if (container.type !== "BIN") return null;
    if (type === "AMMO") return "ITEM_BIN_TOP_AMMO";
    if (type === "BAR") return peek.mat_type === 7 ? "ITEM_BIN_TOP_COAL" : "ITEM_BIN_TOP_BARS";
    if (type === "BLOCKS") return "ITEM_BIN_TOP_BLOCKS";
    if (type === "POWDER_MISC") return "ITEM_BIN_TOP_POWDERS";
    if (type === "COIN") return "ITEM_BIN_TOP_COINS";
    if (type === "GEM" || type === "SMALLGEM" || type === "ROUGH") return "ITEM_BIN_TOP_GEMS";
    if (type === "TRAPPARTS") return "ITEM_BIN_TOP_MECHANISMS";
    if (type === "BOX") return "ITEM_BIN_TOP_BAGS";
    if (type === "BOOK") return "ITEM_BIN_TOP_BOOKS";
    if (type === "SHEET") return "ITEM_BIN_TOP_SHEETS";
    if (type === "CLOTH") return "ITEM_BIN_TOP_CLOTH";
    if (type === "SKIN_TANNED") return "ITEM_BIN_TOP_LEATHER";
    if (type === "WEAPON") return "ITEM_BIN_TOP_WEAPONS";
    if (type === "TRAPCOMP") return "ITEM_BIN_TOP_TRAP_COMPS";
    if (type === "CHAIN")
      return isMetal(materialMap, peek) ? "ITEM_BIN_TOP_CHAINS" : "ITEM_BIN_TOP_ROPES";
    if (ARMOR_TYPES[type])
      return isMetal(materialMap, peek) ? "ITEM_BIN_TOP_ARMOR_METAL"
        : (isLeather(peek) ? "ITEM_BIN_TOP_ARMOR_LEATHER" : "ITEM_BIN_TOP_CLOTHING");
    if (CRAFT_TYPES[type]) return "ITEM_BIN_TOP_CRAFTS";
    return null;
  }

  function containerPeekEntry(container, peek, itemMap, materialMap) {
    var token = containerPeekToken(container, peek, materialMap);
    if (!token || !itemMap || !itemMap.bytoken) return null;
    var entry = itemMap.bytoken[token];
    return entry && entry.sheet ? entry : null;
  }

  root.DwfItemSelection = Object.freeze({
    containerPeekToken: containerPeekToken,
    containerPeekEntry: containerPeekEntry,
  });
})(typeof window !== "undefined" ? window : globalThis);
