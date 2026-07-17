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

// TX4 shared planted-crop policy. Both renderers consume this exact table and resolver.
(function (root) {
  "use strict";

  var STAGE = Object.freeze({ SEED: 0, SPROUT: 1, GROWN: 2 });
  var TOKENS = Object.freeze({
    0: Object.freeze(["SEED", "CROP_SPROUT", "CROP"]),
    1: Object.freeze(["CROP_SPROUT", "CROP", "SEED"]),
    2: Object.freeze(["CROP", "SHRUB", "CROP_SPROUT"]),
  });

  function sameGrown(tile, crop) {
    var other = tile && tile.farmCrop;
    return !!(other && (other.stage | 0) === STAGE.GROWN && other.id === crop.id);
  }

  function resolve(crop, plantMap, leftTile, rightTile) {
    if (!crop || !crop.id || !plantMap) return null;
    var species = plantMap[crop.id];
    if (!species) return null;
    var stage = crop.stage | 0;
    var order = (TOKENS[stage] || TOKENS[STAGE.SEED]).slice();
    if (stage === STAGE.GROWN) {
      var left = sameGrown(leftTile, crop), right = sameGrown(rightTile, crop);
      // Native's authored L/M/R cells join adjacent ripe crops into one row. CROP remains
      // the isolated/fallback cell, and species without L/M/R (strawberries) use it directly.
      if (left && right) order.unshift("CROP_M");
      else if (right) order.unshift("CROP_L");
      else if (left) order.unshift("CROP_R");
    }
    for (var i = 0; i < order.length; i++) {
      var cell = species[order[i]];
      if (cell && cell.sheet && typeof cell.col === "number" && typeof cell.row === "number")
        return { token: order[i], cell: cell };
    }
    return null;
  }

  function collect(tiles, width, height, plantMap) {
    var out = [];
    if (!Array.isArray(tiles) || width <= 0 || height <= 0) return out;
    var n = Math.min(tiles.length, width * height);
    for (var i = 0; i < n; i++) {
      var tile = tiles[i], crop = tile && tile.farmCrop;
      if (!crop) continue;
      var gx = i % width, gy = (i - gx) / width;
      var found = resolve(crop, plantMap, gx > 0 ? tiles[i - 1] : null,
        gx + 1 < width ? tiles[i + 1] : null);
      if (found) out.push({ gx: gx, gy: gy, id: crop.id, stage: crop.stage | 0,
        token: found.token, cell: found.cell });
    }
    return out;
  }

  // TX4 reopen: this is the shared painter contract, not a timing convention. A renderer may
  // rebuild either callback's backing data first, but the final composite always executes the
  // farm bed/building layer before the planted-crop layer.
  function paintAboveBuildings(paintBuildings, paintCrops) {
    try {
      if (typeof paintBuildings === "function") paintBuildings();
    } finally {
      if (typeof paintCrops === "function") paintCrops();
    }
  }

  root.DwfFarmCrops = { STAGE: STAGE, TOKENS: TOKENS, resolve: resolve, collect: collect,
    paintAboveBuildings: paintAboveBuildings };
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
