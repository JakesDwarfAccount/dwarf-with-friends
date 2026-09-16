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

  function resolve(k, t, cells, trackCells) {
    switch (k) {
      case 1: return { cell: cells.smooth, cat: "smooth" };
      case 2: return { cell: cells.engrave, cat: "engrave" };
      case 3: return { cell: cells.fortify, cat: "fortify" };
      case 5: return { cell: cells.chop, cat: "chop" };
      case 6: return { cell: cells.gather, cat: "gather" };
      case 7: return { cell: cells.dig, cat: "dig" };
      case 8: return { cell: cells.stairUp, cat: "stair" };
      case 9: return { cell: cells.stairDown, cat: "stair" };
      case 10: return { cell: cells.stairUpDown, cat: "stair" };
      case 11: return { cell: cells.ramp, cat: "ramp" };
      case 12: return { cell: cells.channel, cat: "channel" };
      case 13: return { cell: cells.removeConstruction, cat: "removeConstruction" };
      case 4: {
        var m = (t && t.desig && t.desig.track) ? (t.desig.track & 15) : 15;
        return { cell: trackCells[m] || trackCells[15], cat: "track" };
      }
    }
    return null;
  }

  function setToolStateOverlay(overlays, kind, on) {
    if (Object.prototype.hasOwnProperty.call(overlays, kind)) {
      overlays[kind] = !!on;
    }
  }

  function toolStateOverlayVisible(overlays, kind) {
    return !!overlays[kind];
  }

  root.DwfDesignationJob = Object.freeze({
    resolve: resolve,
    setToolStateOverlay: setToolStateOverlay,
    toolStateOverlayVisible: toolStateOverlayVisible,
  });
})(typeof window !== "undefined" ? window : globalThis);
