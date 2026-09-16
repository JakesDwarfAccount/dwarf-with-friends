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

// Voxel index is x + dimX*(y + dimY*z). dwf-voxel-mesh.js re-derives the same formula in its own
// idx() over the same Maps, so the two must change together or not at all.

(function (root) {
  "use strict";

  var DEFAULT_BOX_W = 96;
  var DEFAULT_BOX_H = 96;
  var DEFAULT_Z_DOWN = 20;

  // Content budget, counted in SOLID VOXELS -- the thing that costs memory downstream, not layers.
  var DEFAULT_MAX_SOLID = 700000;

  var FALLBACK_RGB = [110, 110, 116]; // only if colorFn returns null for a solid tile (shouldn't)

  // Open (non-solid) tile shapes: air / rampspace / no-tile. Everything else discovered is solid.
  var OPEN_SHAPES = { EMPTY: 1, NONE: 1, RAMP_TOP: 1 };

  // Bit positions inside dwf-cache.js's packed byte (decodeRaw: hidden is bit 5, outside is bit 6).
  var TILE_HIDDEN_BIT = 1 << 5;
  var TILE_OUTSIDE_BIT = 1 << 6;
  var VOID_TT = 0xFFFF;

  function isFiniteNum(n) { return typeof n === "number" && isFinite(n); }
  function isVoidTT(tt) { return !(tt >= 0) || tt === VOID_TT; }

  // Deliberately a SUPERSET of isSolidTile(): it keeps `outside` tiles and open air, rejected later.
  function isCandidateSlot(tt, bits) {
    if (isVoidTT(tt)) return false;
    if (bits & TILE_HIDDEN_BIT) return false;
    return true;
  }

  function isSolidTile(t) {
    if (!t) return false;
    if (typeof t.tt === "number" && t.tt < 0) return false;
    if (t.hidden) return false;
    if (t.depth) return false;
    var shape = t.shape || "NONE";
    if (OPEN_SHAPES[shape]) return false;
    if ((t.mat || "") === "AIR") return false;
    return true;
  }

  // ---- liquids ----------------------------------------------------------------------------------
  var LIQUID_BLOCKING_SHAPES = { WALL: 1, FORTIFICATION: 1 };
  function isLiquidTile(t) {
    if (!t) return false;
    if (typeof t.tt === "number" && t.tt < 0) return false;
    if (t.hidden) return false;
    if (t.depth) return false;
    if (!(t.flow > 0)) return false;
    if (LIQUID_BLOCKING_SHAPES[t.shape || "NONE"]) return false;
    var l = t.liquid || "none";
    return l === "water" || l === "magma";
  }
  // DwfCache.tileAt() see-down composites open space, so a channeled tile can describe the floor below.
  // Restore the slot's OWN flow before voxel classification, or open water/magma disappears.
  function withOwnLiquid(t, packedBits) {
    var flow = ((packedBits | 0) >> 2) & 7;
    if (!t || flow <= 0 || !t.depth) return t;
    var out = {};
    for (var k in t) if (k !== "depth") out[k] = t[k];
    // Do not let a borrowed FLOOR/WALL shape decide whether the current liquid voxel exists.
    out.shape = "EMPTY";
    out.mat = "AIR";
    out.flow = flow;
    out.liquid = ((packedBits | 0) & 3) === 2 ? "magma" : "water";
    return out;
  }
  // KIND is what the mesh stage needs and a colour cannot tell it. -1 = not a voxel at all.
  var KIND_SOLID = 0, KIND_WATER = 1, KIND_MAGMA = 2, KIND_FLOOR = 3;
  var KIND_TREE = 4, KIND_PLANT = 5, KIND_STAIR = 6, KIND_RAMP = 7;
  // Stairs are NOT a full kind: a full opaque cube culls the surrounding rock's faces, and a stairwell
  // then renders as unbroken stone. A ramp's slope direction is injected via rampDirFn, never re-derived.
  var TREE_SHAPES = { TREE: 1, TRUNK_BRANCH: 1, BRANCH: 1, TWIG: 1 };
  var PLANT_SHAPES = { SAPLING: 1, SHRUB: 1 };
  var STAIR_SHAPES = { STAIR_UP: 1, STAIR_DOWN: 1, STAIR_UPDOWN: 1 };
  function tileKind(t) {
    if (isLiquidTile(t)) return (t.liquid === "magma") ? KIND_MAGMA : KIND_WATER;
    if (!isSolidTile(t)) return -1;
    var shape = t.shape || "";
    if (shape === "FLOOR") return KIND_FLOOR;
    if (TREE_SHAPES[shape]) return KIND_TREE;
    if (PLANT_SHAPES[shape]) return KIND_PLANT;
    if (STAIR_SHAPES[shape]) return KIND_STAIR;
    if (shape === "RAMP") return KIND_RAMP;
    if (isSolidTile(t)) return KIND_SOLID;
    return -1;
  }
  function isVoxelTile(t) { return tileKind(t) >= 0; }

  // ---- the sparse voxel field ------------------------------------------------------------------------
  function index(f, x, y, z) { return x + f.dimX * (y + f.dimY * z); }
  function inBounds(f, x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < f.dimX && y < f.dimY && z < f.dimZ;
  }
  function makeField(dimX, dimY, dimZ, ox, oy, oz) {
    return {
      dimX: Math.max(1, dimX | 0), dimY: Math.max(1, dimY | 0), dimZ: Math.max(1, dimZ | 0),
      ox: ox | 0, oy: oy | 0, oz: oz | 0,
      cells: new Map(), slices: null, count: 0,
      // voxel index -> atlas cell for that voxel's TOP (+Z) face; sparse, an absent entry keeps flat colour.
      topCells: new Map(),
      // voxel index -> KIND_WATER/KIND_MAGMA; sparse, an absent entry is KIND_SOLID.
      kinds: new Map(),
      // voxel index -> atlas cell for its four SIDE faces. Filled by the MESH stage, never here.
      sideCells: new Map(),
      // voxel index -> the 8-bit wall-adjacency mask giving a ramp its slope; absent reads as mask 0.
      rampDirs: new Map(),
      markers: [],
    };
  }
  function setVoxel(f, x, y, z, r, g, b) {
    if (!inBounds(f, x, y, z)) return false;
    var i = index(f, x, y, z);
    if (!f.cells.has(i)) f.count++;
    f.cells.set(i, ((r & 255) << 16) | ((g & 255) << 8) | (b & 255));
    return true;
  }
  // Freeze the per-slice index lists. MUST be called before a field is meshed.
  function sealField(f) {
    var plane = f.dimX * f.dimY;
    var buckets = new Array(f.dimZ);
    for (var z = 0; z < f.dimZ; z++) buckets[z] = [];
    f.cells.forEach(function (_rgb, i) {
      var zz = (i / plane) | 0;
      if (zz >= 0 && zz < f.dimZ) buckets[zz].push(i);
    });
    for (var k = 0; k < f.dimZ; k++) {
      buckets[k].sort(function (a, b) { return a - b; });
      buckets[k] = Int32Array.from(buckets[k]);
    }
    f.slices = buckets;
    return f;
  }
  // GROUND SPRITES: set/read the atlas cell a voxel's TOP face samples. cell<=0 clears it.
  function setTopCell(f, x, y, z, cell) {
    if (!inBounds(f, x, y, z)) return false;
    var i = index(f, x, y, z);
    if (cell > 0) f.topCells.set(i, cell | 0); else f.topCells.delete(i);
    return true;
  }
  function topCellAt(f, x, y, z) {
    if (!inBounds(f, x, y, z)) return 0;
    return f.topCells.get(index(f, x, y, z)) || 0;
  }
  function isSolidAt(f, x, y, z) {
    if (!inBounds(f, x, y, z)) return false;
    return f.cells.has(index(f, x, y, z));
  }
  function colorAt(f, x, y, z) {
    if (!isSolidAt(f, x, y, z)) return null;
    var v = f.cells.get(index(f, x, y, z));
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // ---- building --------------------------------------------------------------------------------------
  // Planes are visited OUTWARD from the camera z, so a budget cut leaves a contiguous window, not a hole.
  function planeOrder(zBot, zTop, cz) {
    var c = cz < zBot ? zBot : (cz > zTop ? zTop : cz);
    var order = [c];
    for (var d = 1; ; d++) {
      var lo = c - d, hi = c + d, any = false;
      if (lo >= zBot) { order.push(lo); any = true; }
      if (hi <= zTop) { order.push(hi); any = true; }
      if (!any) break;
    }
    return order;
  }

  // The DENSE reference source: the oracle the sparse source is tested against, NOT what the viewer runs.
  function denseSource(readTile, ox, oy, dimX, dimY) {
    var rt = typeof readTile === "function" ? readTile : function () { return null; };
    return function (z, emit) {
      for (var y = 0; y < dimY; y++) {
        var wy = oy + y;
        for (var x = 0; x < dimX; x++) emit(ox + x, wy, rt(ox + x, wy, z));
      }
    };
  }

  // step() does ONE z-plane and returns true while work remains; cancel() abandons the build.
  function createVoxelBuilder(opts) {
    var o = opts || {};
    var colorFn = typeof o.colorFn === "function" ? o.colorFn : function () { return null; };
    // cellFn(t, wx, wy) -> an ALREADY-PACKED atlas cell for this tile's terrain art; 0 means none.
    var cellFn = typeof o.cellFn === "function" ? o.cellFn : null;
    // rampDirFn(wx, wy, wz) -> the wall-adjacency mask for a ramp. Asked ONLY for ramp tiles.
    var rampDirFn = typeof o.rampDirFn === "function" ? o.rampDirFn : null;
    var cx = isFiniteNum(o.cx) ? (o.cx | 0) : 0;
    var cy = isFiniteNum(o.cy) ? (o.cy | 0) : 0;
    var cz = isFiniteNum(o.cz) ? (o.cz | 0) : 0;
    var dimX = Math.max(1, (isFiniteNum(o.boxW) ? o.boxW : DEFAULT_BOX_W) | 0);
    var dimY = Math.max(1, (isFiniteNum(o.boxH) ? o.boxH : DEFAULT_BOX_H) | 0);
    var zDown = Math.max(1, isFiniteNum(o.zDown) ? (o.zDown | 0) : DEFAULT_Z_DOWN);
    var zUp = Math.max(0, isFiniteNum(o.zUp) ? (o.zUp | 0) : 0);
    var maxSolid = Math.max(1, (isFiniteNum(o.maxSolid) ? o.maxSolid : DEFAULT_MAX_SOLID) | 0);
    var markers = Array.isArray(o.markers) ? o.markers : [];

    var ox = cx - (dimX >> 1), oy = cy - (dimY >> 1);
    var zBot = cz - (zDown - 1), zTop = cz + zUp;
    var order = planeOrder(zBot, zTop, cz);
    var source = typeof o.eachCandidate === "function"
      ? o.eachCandidate
      : denseSource(o.readTile, ox, oy, dimX, dimY);

    var planes = new Map();   // z -> {idx:[in-plane index], rgb:[packed]}
    var at = 0, count = 0, scanned = 0, trimmed = false, cancelled = false;
    var keptLo = null, keptHi = null;

    // cellAt/cellVal are a SPARSE side-list: most solid voxels are rock with no ground sprite.
    var activePlane = null, activeChunks = null, activeChunkAt = 0;
    function beginPlane(z) {
      activePlane = { z: z, idx: [], rgb: [], cellAt: null, cellVal: null,
        kindAt: null, kindVal: null, rampAt: null, rampVal: null };
      activeChunks = source.chunksAt ? (source.chunksAt(z) || []) : null;
      activeChunkAt = 0;
    }
    function emitTile(wx, wy, t) {
        var p = activePlane;
        scanned++;
        var kind = tileKind(t);
        if (kind < 0) return;
        var gx = wx - ox, gy = wy - oy;
        if (gx < 0 || gy < 0 || gx >= dimX || gy >= dimY) return;
        var rgb = colorFn(t) || FALLBACK_RGB;
        p.idx.push(gx + dimX * gy);
        p.rgb.push(((rgb[0] & 255) << 16) | ((rgb[1] & 255) << 8) | (rgb[2] & 255));
        if (kind !== KIND_SOLID) {
          if (!p.kindAt) { p.kindAt = []; p.kindVal = []; }
          p.kindAt.push(p.idx.length - 1);
          p.kindVal.push(kind);
        }
        if (cellFn) {
          var c = cellFn(t, wx, wy) | 0;
          if (c > 0) {
            if (!p.cellAt) { p.cellAt = []; p.cellVal = []; }
            p.cellAt.push(p.idx.length - 1);
            p.cellVal.push(c);
          }
        }
        if (kind === KIND_RAMP && rampDirFn) {
          var rd = rampDirFn(wx, wy, p.z) | 0;
          if (rd) {
            if (!p.rampAt) { p.rampAt = []; p.rampVal = []; }
            p.rampAt.push(p.idx.length - 1);
            p.rampVal.push(rd);
          }
        }
    }
    function finishPlane() {
      var z = activePlane.z;
      planes.set(z, activePlane);
      count += activePlane.idx.length;
      if (keptLo === null || z < keptLo) keptLo = z;
      if (keptHi === null || z > keptHi) keptHi = z;
      activePlane = null; activeChunks = null; activeChunkAt = 0;
    }
    function fillPlane(z) {
      beginPlane(z);
      source(z, emitTile);
      finishPlane();
    }

    return {
      step: function () {
        if (cancelled || at >= order.length) return false;
        if (!activePlane) beginPlane(order[at]);
        if (activeChunks && typeof source.processChunk === "function") {
          if (activeChunkAt < activeChunks.length) {
            source.processChunk(order[at], activeChunks[activeChunkAt++], emitTile);
          }
          if (activeChunkAt < activeChunks.length) return true;
          finishPlane(); at++;
        } else {
          fillPlane(order[at++]);
        }
        // The budget is checked AFTER a plane, never during: the camera plane always survives whole.
        if (at < order.length && count >= maxSolid) { trimmed = true; at = order.length; }
        return at < order.length;
      },
      done: function () { return !cancelled && at >= order.length; },
      cancel: function () { cancelled = true; planes = new Map(); },
      cancelled: function () { return cancelled; },
      planes: function () { return order.length; },
      progress: function () { return order.length ? Math.min(1, at / order.length) : 1; },
      result: function () {
        if (cancelled) return null;
        var lo = keptLo === null ? cz : keptLo, hi = keptHi === null ? cz : keptHi;
        var f = makeField(dimX, dimY, hi - lo + 1, ox, oy, lo);
        var plane = dimX * dimY;
        for (var z = lo; z <= hi; z++) {
          var p = planes.get(z);
          if (!p) continue;
          var base = plane * (z - lo);
          for (var k = 0; k < p.idx.length; k++) {
            var gi = base + p.idx[k];
            if (!f.cells.has(gi)) f.count++;
            f.cells.set(gi, p.rgb[k]);
          }
          if (p.cellAt) {
            for (var m = 0; m < p.cellAt.length; m++) {
              f.topCells.set(base + p.idx[p.cellAt[m]], p.cellVal[m]);
            }
          }
          if (p.kindAt) {
            for (var q = 0; q < p.kindAt.length; q++) {
              f.kinds.set(base + p.idx[p.kindAt[q]], p.kindVal[q]);
            }
          }
          if (p.rampAt) {
            for (var ri = 0; ri < p.rampAt.length; ri++) {
              f.rampDirs.set(base + p.idx[p.rampAt[ri]], p.rampVal[ri]);
            }
          }
        }
        sealField(f);
        for (var mi = 0; mi < markers.length; mi++) {
          var mark = markers[mi];
          if (!mark || !isFiniteNum(mark.x) || !isFiniteNum(mark.y) || !isFiniteNum(mark.z)) continue;
          var mx = mark.x - f.ox, my = mark.y - f.oy, mz = mark.z - f.oz;
          if (mx < 0 || my < 0 || mz < 0 || mx >= f.dimX || my >= f.dimY || mz >= f.dimZ) continue;
          f.markers.push({
            x: mx, y: my, z: mz, type: mark.type === "unit" ? "unit" : "building",
            color: Array.isArray(mark.color) ? mark.color.slice(0, 3) :
              (mark.type === "unit" ? [245, 205, 72] : [226, 128, 54]),
            cell: mark.cell > 0 ? (mark.cell | 0) : 0,
          });
        }
        f.cx = cx; f.cy = cy; f.cz = cz;
        f.zDown = cz - lo + 1; f.zUp = hi - cz;
        f.zBot = lo; f.zTop = hi;
        f.requestedW = dimX; f.requestedH = dimY;
        f.requestedZ = zDown; f.requestedUp = zUp;
        f.maxSolid = maxSolid;
        f.liquidCount = 0;
        f.kinds.forEach(function (kind) {
          if (kind === KIND_WATER || kind === KIND_MAGMA) f.liquidCount++;
        });
        f.trimmed = trimmed;      // the content budget stopped the build short of the request
        f.scanned = scanned;      // cells the source actually OFFERED (the dense-vs-sparse number)
        f.note = "showing " + f.dimX + "x" + f.dimY + "x" + f.dimZ + " cached footprint";
        return f;
      },
    };
  }

  // Build the whole field in one go (fixtures, and anything that does not need to time-slice).
  function voxelize(opts) {
    var b = createVoxelBuilder(opts);
    while (b.step()) { /* drain */ }
    return b.result();
  }

  // ---- fort z-extent: a tile counts as fort when it is revealed, enclosed and a real tiletype --------
  var FORT_MIN_TILES = 8;   // per z-level: one stray revealed tile is not a floor of your fort

  function fortZExtent(opts) {
    var o = opts || {};
    if (typeof o.eachChunk !== "function") return null;
    var minTiles = isFiniteNum(o.minTiles) ? Math.max(1, o.minTiles | 0) : FORT_MIN_TILES;
    var perZ = Object.create(null);
    o.eachChunk(function (z, chunk) {
      if (!chunk || !chunk.bits || !chunk.tt) return;
      var bits = chunk.bits, tt = chunk.tt;
      var n = Math.min(bits.length, tt.length);
      var hits = 0;
      for (var i = 0; i < n; i++) {
        // isVoidTT, not `tt[i] < 0`: a real chunk's Uint16 void slots hold 0xFFFF, which is not negative, so a
        // `< 0` test lets a partially-written chunk's void slots count as fort.
        if (isVoidTT(tt[i])) continue;
        var b = bits[i];
        if (b & TILE_HIDDEN_BIT) continue;
        if (b & TILE_OUTSIDE_BIT) continue;
        hits++;
      }
      if (!hits) return;
      var key = z | 0;
      perZ[key] = (perZ[key] || 0) + hits;
    });
    var zBot = null, zTop = null, tiles = 0, levels = 0;
    Object.keys(perZ).forEach(function (k) {
      if (perZ[k] < minTiles) return;
      var z = Number(k);
      if (zBot === null || z < zBot) zBot = z;
      if (zTop === null || z > zTop) zTop = z;
      tiles += perZ[k];
      levels++;
    });
    if (zBot === null) return null;
    return { zBot: zBot, zTop: zTop, levels: levels, tiles: tiles };
  }

  var api = {
    voxelize: voxelize,
    createVoxelBuilder: createVoxelBuilder,
    isSolidTile: isSolidTile,
    isLiquidTile: isLiquidTile,
    withOwnLiquid: withOwnLiquid,
    isVoxelTile: isVoxelTile,
    tileKind: tileKind,
    KIND_SOLID: KIND_SOLID, KIND_WATER: KIND_WATER, KIND_MAGMA: KIND_MAGMA,
    KIND_FLOOR: KIND_FLOOR, KIND_TREE: KIND_TREE, KIND_PLANT: KIND_PLANT,
    KIND_STAIR: KIND_STAIR, KIND_RAMP: KIND_RAMP,
    LIQUID_BLOCKING_SHAPES: LIQUID_BLOCKING_SHAPES,
    isCandidateSlot: isCandidateSlot,
    fortZExtent: fortZExtent,
    FORT_MIN_TILES: FORT_MIN_TILES,
    makeField: makeField,
    setVoxel: setVoxel,
    setTopCell: setTopCell,
    topCellAt: topCellAt,
    sealField: sealField,
    index: index,
    inBounds: inBounds,
    isSolidAt: isSolidAt,
    colorAt: colorAt,
    planeOrder: planeOrder,
    TILE_HIDDEN_BIT: TILE_HIDDEN_BIT,
    TILE_OUTSIDE_BIT: TILE_OUTSIDE_BIT,
    VOID_TT: VOID_TT,
    DEFAULT_BOX_W: DEFAULT_BOX_W,
    DEFAULT_BOX_H: DEFAULT_BOX_H,
    DEFAULT_Z_DOWN: DEFAULT_Z_DOWN,
    DEFAULT_MAX_SOLID: DEFAULT_MAX_SOLID,
  };

  try { root.DFVoxelizer = api; } catch { /* Node loads through module.exports below */ }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
