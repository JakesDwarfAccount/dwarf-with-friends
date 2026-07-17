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
// SPDX-License-Identifier: AGPL-3.0-only

// dwf-voxelizer.js -- WT11 (3D world viewer), the DATA stage. PURE: cache-in, typed-arrays
// out. No DOM, no WebGL, no fetch. Converts the cached world-addressed tiles around a camera into
// a dense voxel field (solidity bitmap + per-voxel RGB), reusing the EXACT 2D material-color path
// via an injected colorFn (dwf-tiles.js's tileColor, WALLSFIX/TX16) so 3D colors match 2D.
//
// The world data source is injected as readTile(wx,wy,wz) -> a legacy-shaped tile object
// ({tt,shape,mat,hidden,base_mt,base_mi,flow,liquid,...}) or null for a void/unloaded tile. In the
// live client the panel builds readTile over DwfCache.windowView() per z-slice; the fixture
// tests inject a synthetic readTile. This module never knows where tiles come from -- that is the
// strangler seam that keeps it pure and unit-testable.
//
// Voxel-grid index convention: idx = x + dimX*(y + dimY*z). A z-slice is contiguous. Grid z index
// increases UPWARD in world z: world z of grid cell z is (oz + z).
//
// The z-window is TWO-SIDED (WT11 reopen -- the #1): `zDown` layers at-and-below the camera z
// (zDown=1 is the camera plane alone) plus `zUp` layers strictly ABOVE it. The box therefore spans
// world z [cz-(zDown-1) .. cz+zUp]. zUp defaults to 0, which reproduces the original
// descend-only box exactly -- callers that pass only zDown are unaffected.

(function (root) {
  "use strict";

  var DEFAULT_BOX_W = 96;
  var DEFAULT_BOX_H = 96;
  var DEFAULT_Z_DOWN = 20;
  // Perf guardrail (PERF section of the WT11 report): a hard cap on grid CELLS iterated/allocated.
  // 96*96*20 = 184,320 < this, so the honest default box never degrades; a caller asking for a
  // bigger box (or a future live-resize) degrades toward this ceiling. Chosen so the dense
  // Uint8Array allocations (solid: N bytes, color: 3N bytes) and the O(N) scan stay well under a
  // frame budget even in the synchronous voxelize pass -- the EXPENSIVE stage is meshing, which is
  // chunked separately (dwf-voxel-mesh.js).
  var DEFAULT_MAX_VOXELS = 240000;
  var MIN_BOX = 8;

  var FALLBACK_RGB = [110, 110, 116]; // only if colorFn returns null for a solid tile (shouldn't)

  // Open (non-solid) tile shapes: air / rampspace / no-tile. Everything else discovered is solid.
  // Kept as a set so the rule is one obvious list, not scattered string compares.
  var OPEN_SHAPES = { EMPTY: 1, NONE: 1, RAMP_TOP: 1 };

  function isFiniteNum(n) { return typeof n === "number" && isFinite(n); }

  // Solidity decision for ONE tile. Returns false for: void/unloaded (null or tt<0), unexplored
  // (hidden -> "unexplored omitted" per the WT11 brief), open air (EMPTY/NONE/RAMP_TOP or AIR
  // material). Everything else discovered -- walls, fortifications, floors, ramps, stairs,
  // boulders, pebbles, tree trunks -- is a solid voxel. Liquids are NOT voxelized in this slice
  // (a flooded OPEN tile stays empty; a floor UNDER liquid is solid via its own shape). Pure.
  function isSolidTile(t) {
    if (!t) return false;
    if (typeof t.tt === "number" && t.tt < 0) return false;
    if (t.hidden) return false;
    var shape = t.shape || "NONE";
    if (OPEN_SHAPES[shape]) return false;
    if ((t.mat || "") === "AIR") return false;
    return true;
  }

  // Degrade the requested box toward maxVoxels while preserving z-depth as long as possible, then
  // shaving z. Returns {W,H,D,degraded}. Pure integer math -- the test asserts exact outputs.
  function fitBox(boxW, boxH, zDown, maxVoxels) {
    // Honor an explicit request as-is when it fits -- MIN_BOX only bounds the DEGRADE shrink so a
    // degrade never collapses the footprint to a degenerate sliver; it must not inflate a small
    // request.
    var W = Math.max(1, boxW | 0);
    var H = Math.max(1, boxH | 0);
    var D = Math.max(1, zDown | 0);
    var cap = Math.max(1, maxVoxels | 0);
    if (W * H * D <= cap) return { W: W, H: H, D: D, degraded: false };
    // Shrink the horizontal footprint first (keep the depth the user cares about).
    var scale = Math.sqrt(cap / (W * H * D));
    W = Math.max(MIN_BOX, Math.floor(W * scale));
    H = Math.max(MIN_BOX, Math.floor(H * scale));
    // If the MIN_BOX-floored footprint still overflows, shave depth next...
    while (W * H * D > cap && D > 1) D--;
    // ...and only as a last resort drop the footprint below MIN_BOX.
    while (W * H * D > cap && (W > 1 || H > 1)) { if (W > 1) W--; if (H > 1 && W * H * D > cap) H--; }
    return { W: W, H: H, D: D, degraded: true };
  }

  // Build the voxel field. See the module banner for the opts/field contract.
  function voxelize(opts) {
    var o = opts || {};
    var readTile = typeof o.readTile === "function" ? o.readTile : function () { return null; };
    var colorFn = typeof o.colorFn === "function" ? o.colorFn : function () { return null; };
    var cx = isFiniteNum(o.cx) ? (o.cx | 0) : 0;
    var cy = isFiniteNum(o.cy) ? (o.cy | 0) : 0;
    var cz = isFiniteNum(o.cz) ? (o.cz | 0) : 0;
    var boxW = isFiniteNum(o.boxW) ? o.boxW : DEFAULT_BOX_W;
    var boxH = isFiniteNum(o.boxH) ? o.boxH : DEFAULT_BOX_H;
    var zDown = Math.max(1, isFiniteNum(o.zDown) ? (o.zDown | 0) : DEFAULT_Z_DOWN);
    var zUp = Math.max(0, isFiniteNum(o.zUp) ? (o.zUp | 0) : 0);
    var maxVoxels = isFiniteNum(o.maxVoxels) ? o.maxVoxels : DEFAULT_MAX_VOXELS;

    var fit = fitBox(boxW, boxH, zDown + zUp, maxVoxels);
    var dimX = fit.W, dimY = fit.H, dimZ = fit.D;

    // If the cap shaved DEPTH, give up the layers ABOVE the camera first -- the camera plane and
    // what lies under it is the point of the view. At least one at-or-below layer always survives.
    var upKept = Math.min(zUp, Math.max(0, dimZ - 1));
    var downKept = dimZ - upKept;

    // Center horizontally on the camera; the box spans [cz-(downKept-1) .. cz+upKept].
    var ox = cx - (dimX >> 1);
    var oy = cy - (dimY >> 1);
    var oz = cz - (downKept - 1);

    var n = dimX * dimY * dimZ;
    var solid = new Uint8Array(n);
    var color = new Uint8Array(n * 3);
    var count = 0;

    for (var z = 0; z < dimZ; z++) {
      var wz = oz + z;
      for (var y = 0; y < dimY; y++) {
        var wy = oy + y;
        var rowBase = dimX * (y + dimY * z);
        for (var x = 0; x < dimX; x++) {
          var t = readTile(ox + x, wy, wz);
          if (!isSolidTile(t)) continue;
          var i = rowBase + x;
          solid[i] = 1;
          var rgb = colorFn(t) || FALLBACK_RGB;
          var c = i * 3;
          color[c] = rgb[0] & 255;
          color[c + 1] = rgb[1] & 255;
          color[c + 2] = rgb[2] & 255;
          count++;
        }
      }
    }

    return {
      dimX: dimX, dimY: dimY, dimZ: dimZ,
      ox: ox, oy: oy, oz: oz,
      cx: cx, cy: cy, cz: cz,
      solid: solid, color: color, count: count,
      degraded: fit.degraded,
      zDown: downKept, zUp: upKept,
      zBot: oz, zTop: oz + dimZ - 1,
      requestedW: boxW | 0, requestedH: boxH | 0, requestedZ: zDown | 0, requestedUp: zUp | 0,
      maxVoxels: maxVoxels | 0,
      note: "showing " + dimX + "x" + dimY + "x" + dimZ + " around camera",
    };
  }

  // idx helper so consumers (mesher, renderer) never re-derive the layout by hand.
  function index(field, x, y, z) { return x + field.dimX * (y + field.dimY * z); }
  function inBounds(field, x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < field.dimX && y < field.dimY && z < field.dimZ;
  }
  function isSolidAt(field, x, y, z) {
    if (!inBounds(field, x, y, z)) return false;
    return field.solid[index(field, x, y, z)] === 1;
  }

  var api = {
    voxelize: voxelize,
    isSolidTile: isSolidTile,
    fitBox: fitBox,
    index: index,
    inBounds: inBounds,
    isSolidAt: isSolidAt,
    DEFAULT_BOX_W: DEFAULT_BOX_W,
    DEFAULT_BOX_H: DEFAULT_BOX_H,
    DEFAULT_Z_DOWN: DEFAULT_Z_DOWN,
    DEFAULT_MAX_VOXELS: DEFAULT_MAX_VOXELS,
  };

  try { root.DFVoxelizer = api; } catch (_) { /* non-browser */ }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
