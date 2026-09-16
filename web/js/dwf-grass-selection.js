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

// ---- The one shared grass-body selection for both canvas2d and WebGL. ----
// The generated grass_colors.json is the authority; the vanilla fallbacks below cover the load interval.
(function (root) {
  "use strict";

  var VANILLA_SPECIAL = {
    "FLOOR FUNGI": { sheet: "cavern_grass.png", row: 0 },
    "CAVE MOSS": { sheet: "cavern_grass.png", row: 1 },
    "UNDERLICHEN": { sheet: "cavern_grass.png", row: 2 },
    "BABY TOES SUCCULENT": { sheet: "grass_other.png", row: 0 },
    "PEBBLE PLANTS": { sheet: "grass_other.png", row: 1 },
    "BUBBLE BULBS": { sheet: "grass_other.png", row: 2 },
    "DOWNY GRASS": { sheet: "grass_other.png", row: 3 },
    "EYEBALL": { sheet: "grass_other.png", row: 4 },
    "WORMY TENDRILS": { sheet: "grass_other.png", row: 5 },
  };

  function speciesSpec(colors, id) {
    if (!id) return { sheet: "grass.png", row: 0 };
    var mapped = colors && colors.plants && colors.plants[id] && colors.plants[id].sprite;
    if (mapped && typeof mapped.sheet === "string" && Number.isInteger(mapped.row)) {
      return { sheet: mapped.sheet, row: mapped.row };
    }
    // Once the generated catalog is present it is authoritative, including an absent id.
    if (colors && colors.plants) return null;
    var known = VANILLA_SPECIAL[id];
    if (known) return { sheet: known.sheet, row: known.row };
    // A present but unknown id is authoritative. Do not turn it into generic green surface grass.
    return null;
  }

  function variantIndex(ttname, plantOccupied) {
    if (plantOccupied) return 0;
    var match = /(?:Floor)?([1-4])$/.exec(ttname || "");
    return match ? Number(match[1]) - 1 : 0;
  }

  function isPlantOccupied(tile) {
    return !!(tile && /^(PLANT|TREE|MUSHROOM)$/.test(tile.mat || ""));
  }

  function select(colors, tile, plantOccupied) {
    if (!tile || !tile.grass) return null;
    var spec = speciesSpec(colors, tile.grass.id);
    if (!spec) return null;
    var occupied = plantOccupied === undefined ? isPlantOccupied(tile) : !!plantOccupied;
    return {
      sheet: spec.sheet,
      row: spec.row,
      col: variantIndex(tile.ttname, occupied),
      tint: spec.sheet === "grass.png" ? "grassSummer" : null,
      plantOccupied: occupied,
    };
  }

  root.DwfGrassSelection = {
    VANILLA_SPECIAL: VANILLA_SPECIAL,
    speciesSpec: speciesSpec,
    variantIndex: variantIndex,
    isPlantOccupied: isPlantOccupied,
    select: select,
  };
})(typeof window !== "undefined" ? window : self);
