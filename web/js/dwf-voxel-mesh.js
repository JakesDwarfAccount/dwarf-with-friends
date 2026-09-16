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

// A neighbour outside the field counts as AIR, never as solid: that is what gives a windowed build
// faces on its own boundary instead of an open shell.

(function (root) {
  "use strict";

  // Six faces: normal + the 4 corner offsets on the unit cube, wound counter-clockwise as seen from
  // OUTSIDE so back-face culling keeps them. A voxel at (x,y,z) occupies [x,x+1]x[y,y+1]x[z,z+1].
  var FACES = [
    { // +X (east)
      d: [1, 0, 0], n: [1, 0, 0],
      c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    },
    { // -X (west)
      d: [-1, 0, 0], n: [-1, 0, 0],
      c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
    },
    { // +Y (south, +y)
      d: [0, 1, 0], n: [0, 1, 0],
      c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    },
    { // -Y (north, -y)
      d: [0, -1, 0], n: [0, -1, 0],
      c: [[1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 0, 0]],
    },
    { // +Z (up)
      d: [0, 0, 1], n: [0, 0, 1],
      c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    },
    { // -Z (down)
      d: [0, 0, -1], n: [0, 0, -1],
      c: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]],
    },
  ];

  // The two triangles of a quad, as indices into the face's 4 corners (0,1,2)+(0,2,3).
  var TRI = [0, 1, 2, 0, 2, 3];

  // ---- per-vertex FLAGS (one byte) -----------------------------------------------------------------
  var FLAG_FLIPV = 2;
  var FLAG_SWAPUV = 4;
  var SLICE_REGULAR = 0;
  var SLICE_TOP_CAP = 1;
  var SLICE_BOTTOM_CAP = 2;
  // DERIVED from the real FACES corner lists, never hand-written, so they cannot disagree with it.
  var FACE_SWAP_UV = FACES.map(function (f, i) { return (i < 4 && f.c[0][2] !== f.c[1][2]) ? 1 : 0; });
  var FACE_FLIP_V = FACES.map(function (f, i) { return (i < 4 && f.c[0][2] === 0) ? 1 : 0; });
  // The four SIDE faces, in FACES order: +X, -X, +Y, -Y.
  var SIDE_FACES = 4;

  function idx(field, x, y, z) { return x + field.dimX * (y + field.dimY * z); }
  function solidAt(field, x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= field.dimX || y >= field.dimY || z >= field.dimZ) return false;
    return field.cells.has(idx(field, x, y, z));
  }
  function kindAt(field, x, y, z) {
    if (!solidAt(field, x, y, z)) return -1;
    return (field.kinds && field.kinds.has(idx(field, x, y, z)))
      ? field.kinds.get(idx(field, x, y, z)) : 0;
  }
  function isFullKind(k) { return k === 0 || k === 1 || k === 2; }
  function boxesForKind(k) {
    if (k === 3) return [[0, 0, 5 / 6, 1, 1, 1]]; // FLOOR: a thin plate at the cell top
    if (k === 4) return [ // TREE: trunk plus a deliberately chunky canopy
      [0.35, 0.35, 0, 0.65, 0.65, 1],
      [0.08, 0.08, 0.55, 0.92, 0.92, 1],
    ];
    if (k === 5) return [ // SAPLING/SHRUB: short stem plus leaves
      [0.42, 0.42, 0, 0.58, 0.58, 0.7],
      [0.18, 0.18, 0.32, 0.82, 0.82, 0.8],
    ];
    // STAIR: a bottom-anchored half-height tread. ONE box on purpose -- a single-box kind stays in the
    // per-face cull path, and half height reads as a step to climb rather than as another floor.
    if (k === 6) return [[0, 0, 0, 1, 1, 0.5]];
    // RAMP (kind 7) falls through to the unit box: its wedge is that cube with each TOP corner pulled down.
    return [[0, 0, 0, 1, 1, 1]];
  }

  // ---- RAMPS: a wedge is the cube with every TOP corner dropped to its own height ------------------
  var RAMP_N = 1, RAMP_S = 2, RAMP_W = 4, RAMP_E = 8;
  // Corner heights as [NW, NE, SW, SE] -- index (cy * 2 + cx) for local corner (cx, cy).
  function rampHeights(mask) {
    var n = (mask & RAMP_N) ? 1 : 0, s = (mask & RAMP_S) ? 1 : 0;
    var w = (mask & RAMP_W) ? 1 : 0, e = (mask & RAMP_E) ? 1 : 0;
    if (!(n || s || w || e)) return [1, 1, 1, 1];
    return [n > w ? n : w, n > e ? n : e, s > w ? s : w, s > e ? s : e];
  }
  function rampCornerH(h, cx, cy) { return h[(cy ? 2 : 0) + (cx ? 1 : 0)]; }
  function rampHeightsAt(field, vi) {
    return rampHeights(field.rampDirs ? (field.rampDirs.get(vi) | 0) : 0);
  }
  // The z a corner is emitted at: floor corners stay on the floor, top corners drop to their height.
  function rampCornerZ(h, corner) {
    return corner[2] ? rampCornerH(h, corner[0], corner[1]) : 0;
  }
  // A side face survives only while at least one of its two top corners is off the floor.
  function rampFaceLive(h, f) {
    if (f >= 4) return true; // +Z (the slope) and -Z (the base) always exist
    var c = FACES[f].c;
    for (var i = 0; i < 4; i++) {
      if (c[i][2] && rampCornerH(h, c[i][0], c[i][1]) > 0) return true;
    }
    return false;
  }
  function rampFaceCount(h) {
    var n = 0;
    for (var f = 0; f < 6; f++) if (rampFaceLive(h, f)) n++;
    return n;
  }
  // The sloped face's normal is computed per TRIANGLE: an inside-corner wedge is not planar.
  function rampTopNormal(h, tri, out) {
    var c = FACES[4].c;
    var a = c[TRI[tri * 3]], b = c[TRI[tri * 3 + 1]], d = c[TRI[tri * 3 + 2]];
    var az = rampCornerH(h, a[0], a[1]), bz = rampCornerH(h, b[0], b[1]), dz = rampCornerH(h, d[0], d[1]);
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = bz - az;
    var vx = d[0] - a[0], vy = d[1] - a[1], vz = dz - az;
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
    return out;
  }
  // A floor is not a level-sized cube. It only hides a neighbouring floor/full voxel along its
  // thin side band, and a full voxel directly above hides its top. It never hides the level below.
  function faceHidden(field, x, y, z, kind, f) {
    var d = FACES[f].d, nk = kindAt(field, x + d[0], y + d[1], z + d[2]);
    if (nk < 0 || nk === 4 || nk === 5) return false;
    if (kind === 3) {
      if (f < 4) return nk === 3 || isFullKind(nk);
      return f === 4 && isFullKind(nk);
    }
    return isFullKind(kind) && isFullKind(nk);
  }
  function faceRole(field, x, y, z, kind, f, residentSlices) {
    if (!faceHidden(field, x, y, z, kind, f)) return SLICE_REGULAR;
    if (!residentSlices || f < 4) return -1;
    return f === 4 ? SLICE_TOP_CAP : SLICE_BOTTOM_CAP;
  }
  function voxelFaceCount(field, x, y, z, kind, residentSlices) {
    if (kind === 4 || kind === 5) return 12;
    // A wedge drops the side faces that collapsed, so its count is a pure function of its heights.
    // countFaces() preallocates from this, so it MUST read the same rampDirs the emitter will.
    if (kind === 7) return rampFaceCount(rampHeightsAt(field, idx(field, x, y, z)));
    var n = 0;
    for (var f = 0; f < 6; f++) if (faceRole(field, x, y, z, kind, f, residentSlices) >= 0) n++;
    return n;
  }
  // The voxels of one z-slice, ascending. Empty (or missing) slices cost nothing.
  function slice(field, z) {
    var s = field.slices && field.slices[z];
    return s || EMPTY_SLICE;
  }
  var EMPTY_SLICE = new Int32Array(0);

  function sliceRange(field, z, zStart, zEnd, nStart, nEnd) {
    var list = slice(field, z);
    var lo = 0, hi = list.length;
    if (z === zStart && nStart > 0) lo = Math.min(nStart, hi);
    if (z === zEnd - 1 && nEnd >= 0) hi = Math.min(nEnd, hi);
    return hi > lo ? [lo, hi] : [0, 0];
  }

  // Count exposed faces in z-slabs [zStart,zEnd), used to preallocate exact typed arrays.
  function countFaces(field, zStart, zEnd, nStart, nEnd, residentSlices) {
    var faces = 0;
    if (nStart === undefined) nStart = 0;
    if (nEnd === undefined) nEnd = -1;
    for (var z = zStart; z < zEnd; z++) {
      var list = slice(field, z), planeBase = field.dimX * field.dimY * z;
      var rg = sliceRange(field, z, zStart, zEnd, nStart, nEnd);
      for (var n = rg[0]; n < rg[1]; n++) {
        var rel = list[n] - planeBase;
        var y = (rel / field.dimX) | 0, x = rel - y * field.dimX;
        faces += voxelFaceCount(field, x, y, z, kindAt(field, x, y, z), residentSlices);
      }
    }
    return faces;
  }

  function buildMesh(field, opts) {
    var o = opts || {};
    var zStart = typeof o.zStart === "number" ? Math.max(0, o.zStart | 0) : 0;
    var zEnd = typeof o.zEnd === "number" ? Math.min(field.dimZ, o.zEnd | 0) : field.dimZ;
    if (zEnd < zStart) zEnd = zStart;

    // sideCellFn(x,y,z) -> the atlas cell the four SIDE faces sample; injected so this stage stays pure.
    // Asked only for a voxel that actually emits a side face, and memoised per voxel in field.sideCells.
    var sideCellFn = (o.sideCellFn && field.sideCells) ? o.sideCellFn : null;
    var sideCells = field.sideCells || null;

    var nStart = typeof o.nStart === "number" ? Math.max(0, o.nStart | 0) : 0;
    var nEnd = typeof o.nEnd === "number" ? (o.nEnd | 0) : -1;
    var includeMarkers = o.includeMarkers !== false;
    var markersOnly = o.markersOnly === true;
    var residentSlices = o.residentSlices === true;

    var faceCount = markersOnly ? 0 : countFaces(field, zStart, zEnd, nStart, nEnd, residentSlices);
    var markerList = includeMarkers && Array.isArray(field.markers)
      ? field.markers.filter(function (m) { return m.z >= zStart && m.z < zEnd; }) : [];
    faceCount += markerList.length * 6;
    var vertCount = faceCount * 6;
    var positions = new Float32Array(vertCount * 3);
    var normals = new Float32Array(vertCount * 3);
    var colors = new Uint8Array(vertCount * 3);
    var cells = new Uint16Array(vertCount);
    var flags = new Uint8Array(vertCount);
    var layers = new Uint16Array(vertCount);
    var sliceRoles = new Uint8Array(vertCount);
    // Null, not empty, when nothing is textured: a field built with no cellFn then skips the lookup.
    var tops = (field.topCells && field.topCells.size) ? field.topCells : null;
    var kinds = (field.kinds && field.kinds.size) ? field.kinds : null;
    var spriteFaceCount = 0, sideSpriteFaceCount = 0;

    var rampN = [0, 0, 1]; // scratch for the sloped face's computed normal (one per buildMesh call)
    var vp = 0; // vertex write cursor (in vec3 units)
    for (var z = zStart; !markersOnly && z < zEnd; z++) {
      var list = slice(field, z), planeBase = field.dimX * field.dimY * z;
      var rg = sliceRange(field, z, zStart, zEnd, nStart, nEnd);
      for (var n = rg[0]; n < rg[1]; n++) {
        var vi = list[n];
        var rel = vi - planeBase;
        var y = (rel / field.dimX) | 0, x = rel - y * field.dimX;
        var packed = field.cells.get(vi);
        var r = (packed >> 16) & 255, g = (packed >> 8) & 255, b = packed & 255;
        var kind = kinds && kinds.has(vi) ? kinds.get(vi) : 0;
        var sideCell = -1;   // -1 = not asked yet for this voxel (lazily resolved, once)
        var ramp = kind === 7 ? rampHeightsAt(field, vi) : null;
        var boxes = boxesForKind(kind);
        for (var q = 0; q < boxes.length; q++) {
          var box = boxes[q];
          for (var f = 0; f < 6; f++) {
          var face = FACES[f];
          if (ramp && !rampFaceLive(ramp, f)) continue; // a collapsed wedge side
          var role = boxes.length === 1
            ? faceRole(field, x, y, z, kind, f, residentSlices) : SLICE_REGULAR;
          if (role < 0) continue;
          var nx = face.n[0], ny = face.n[1], nz = face.n[2];
          // +Z samples the voxel's TOP cell and the four SIDE faces its side cell; 0 is the flat-colour fallback.
          var cell = 0;
          if ((f === 4 && q === boxes.length - 1) || f < SIDE_FACES) {
            if (f === 4) cell = tops ? (tops.get(vi) || 0) : 0;
            if (!cell && sideCells) {
              if (sideCell < 0) {
                sideCell = sideCells.has(vi) ? (sideCells.get(vi) | 0)
                  : (sideCellFn ? (sideCellFn(x, y, z) | 0) : 0);
                if (sideCellFn) sideCells.set(vi, sideCell);
              }
              cell = sideCell > 0 ? sideCell : 0;
            }
            if (cell) { if (f === 4) spriteFaceCount++; else sideSpriteFaceCount++; }
          }
          var fl = (FACE_FLIP_V[f] ? FLAG_FLIPV : 0) | (FACE_SWAP_UV[f] ? FLAG_SWAPUV : 0);
          for (var k = 0; k < 6; k++) {
            var corner = face.c[TRI[k]];
            var p3 = vp * 3;
            positions[p3] = x + (corner[0] ? box[3] : box[0]);
            positions[p3 + 1] = y + (corner[1] ? box[4] : box[1]);
            positions[p3 + 2] = z + (ramp ? rampCornerZ(ramp, corner) : (corner[2] ? box[5] : box[2]));
            // The sloped face carries a per-triangle normal; k<3 is TRI's first triangle, k>=3 its second.
            if (ramp && f === 4 && (k === 0 || k === 3)) {
              rampTopNormal(ramp, k === 0 ? 0 : 1, rampN);
              nx = rampN[0]; ny = rampN[1]; nz = rampN[2];
            }
            normals[p3] = nx; normals[p3 + 1] = ny; normals[p3 + 2] = nz;
            colors[p3] = r; colors[p3 + 1] = g; colors[p3 + 2] = b;
            if (cell) cells[vp] = cell;   // already 0 otherwise
            if (fl) flags[vp] = fl;
            layers[vp] = field.oz + z;
            if (role) sliceRoles[vp] = role;
            vp++;
          }
        }
        }
      }
    }
    for (var mi = 0; mi < markerList.length; mi++) {
      var mark = markerList[mi], mc = mark.color || [226, 128, 54], markCell = mark.cell | 0;
      var mb = mark.type === "unit"
        ? [0.3, 0.3, 0.9, 0.7, 0.7, 1.22]
        : [0.14, 0.14, 0.9, 0.86, 0.86, 1.1];
      for (var mf = 0; mf < 6; mf++) {
        var mface = FACES[mf];
        for (var mk = 0; mk < 6; mk++) {
          var mcorner = mface.c[TRI[mk]], mp3 = vp * 3;
          positions[mp3] = mark.x + (mcorner[0] ? mb[3] : mb[0]);
          positions[mp3 + 1] = mark.y + (mcorner[1] ? mb[4] : mb[1]);
          positions[mp3 + 2] = mark.z + (mcorner[2] ? mb[5] : mb[2]);
          normals[mp3] = mface.n[0]; normals[mp3 + 1] = mface.n[1]; normals[mp3 + 2] = mface.n[2];
          colors[mp3] = mc[0]; colors[mp3 + 1] = mc[1]; colors[mp3 + 2] = mc[2];
          if (mf === 4 && markCell > 0) cells[vp] = markCell;
          layers[vp] = field.oz + mark.z;
          vp++;
        }
      }
    }

    return {
      positions: positions, normals: normals, colors: colors, cells: cells, flags: flags,
      layers: layers, sliceRoles: sliceRoles,
      faceCount: faceCount, spriteFaceCount: spriteFaceCount,
      sideSpriteFaceCount: sideSpriteFaceCount, vertCount: vertCount,
      zStart: zStart, zEnd: zEnd,
    };
  }

  // Concatenate slab meshes (ascending, contiguous z) into one -- what createBuilder accumulates.
  function concatMeshes(parts) {
    var faceCount = 0, vertCount = 0, spriteFaceCount = 0, sideSpriteFaceCount = 0;
    for (var i = 0; i < parts.length; i++) {
      faceCount += parts[i].faceCount; vertCount += parts[i].vertCount;
      spriteFaceCount += parts[i].spriteFaceCount || 0;
      sideSpriteFaceCount += parts[i].sideSpriteFaceCount || 0;
    }
    var positions = new Float32Array(vertCount * 3);
    var normals = new Float32Array(vertCount * 3);
    var colors = new Uint8Array(vertCount * 3);
    var cells = new Uint16Array(vertCount);
    var flags = new Uint8Array(vertCount);
    var layers = new Uint16Array(vertCount);
    var sliceRoles = new Uint8Array(vertCount);
    var off = 0, offV = 0;
    for (var j = 0; j < parts.length; j++) {
      positions.set(parts[j].positions, off);
      normals.set(parts[j].normals, off);
      colors.set(parts[j].colors, off);
      cells.set(parts[j].cells, offV);
      if (parts[j].flags) flags.set(parts[j].flags, offV);
      if (parts[j].layers) layers.set(parts[j].layers, offV);
      if (parts[j].sliceRoles) sliceRoles.set(parts[j].sliceRoles, offV);
      off += parts[j].vertCount * 3;
      offV += parts[j].vertCount;
    }
    return { positions: positions, normals: normals, colors: colors, cells: cells, flags: flags,
      layers: layers, sliceRoles: sliceRoles,
      faceCount: faceCount, spriteFaceCount: spriteFaceCount,
      sideSpriteFaceCount: sideSpriteFaceCount, vertCount: vertCount };
  }

  function createBuilder(field, opts) {
    var o = opts || {};
    var slabZ = Math.max(1, (o.slabZ | 0) || 2);
    var sideCellFn = typeof o.sideCellFn === "function" ? o.sideCellFn : null;
    var residentSlices = o.residentSlices === true;
    var includeMarkers = o.includeMarkers !== false;
    // The ceiling on ONE step, in voxels: capping by work bounds the worst step whatever the fort's density.
    var maxVoxels = Math.max(1, (o.maxVoxelsPerStep | 0) || 2000);
    var z = 0, n = 0;   // next plane, and the next entry within that plane
    var parts = [];
    function planeLen(zi) { return (field.slices && field.slices[zi]) ? field.slices[zi].length : 0; }
    return {
      done: function () { return z >= field.dimZ; },
      step: function () {
        if (z >= field.dimZ) return false;
        var len = planeLen(z);
        if (n >= len) {                       // this plane is finished (or was empty)
          // Empty planes cost nothing, so absorb a whole slab of them in one step.
          var zEnd = Math.min(field.dimZ, z + slabZ);
          while (zEnd < field.dimZ && planeLen(zEnd) === 0 && zEnd - z < slabZ) zEnd++;
          if (n === 0 && len === 0) {
            parts.push(buildMesh(field, { zStart: z, zEnd: zEnd, sideCellFn: sideCellFn,
              includeMarkers: false, residentSlices: residentSlices }));
            z = zEnd;
          } else { z++; }
          n = 0;
          return z < field.dimZ;
        }
        var take = Math.min(maxVoxels, len - n);
        parts.push(buildMesh(field, {
          zStart: z, zEnd: z + 1, nStart: n, nEnd: n + take, sideCellFn: sideCellFn,
          includeMarkers: false, residentSlices: residentSlices,
        }));
        n += take;
        if (n >= len) { z++; n = 0; }
        return z < field.dimZ;
      },
      result: function () {
        var all = parts;
        if (includeMarkers && field.markers && field.markers.length) {
          all = parts.concat([buildMesh(field, { markersOnly: true, includeMarkers: true })]);
        }
        return concatMeshes(all);
      },
      progress: function () { return field.dimZ ? z / field.dimZ : 1; },
    };
  }

  // Which corner of the sprite cell is vertex k (0..5) of a TOP face -- derived from FACES[+Z] and TRI,
  // never hand-written. The vertex shader recomputes it from gl_VertexID % 6, so no UV attribute ships.
  var TOP_FACE = FACES[4];
  function topFaceCornerUV(k) {
    var c = TOP_FACE.c[TRI[k % 6]];
    return [c[0], c[1]];
  }

  function sideFaceCornerUV(f, k) {
    var uv = topFaceCornerUV(k);
    var u = uv[0], v = uv[1];
    if (FACE_SWAP_UV[f]) { var t = u; u = v; v = t; }
    if (FACE_FLIP_V[f]) v = 1 - v;
    return [u, v];
  }
  function sideFaceCornerZ(f, k) { return FACES[f].c[TRI[k % 6]][2]; }

  var api = {
    buildMesh: buildMesh,
    countFaces: countFaces,
    topFaceCornerUV: topFaceCornerUV,
    sideFaceCornerUV: sideFaceCornerUV,
    sideFaceCornerZ: sideFaceCornerZ,
    rampHeights: rampHeights,
    rampFaceCount: rampFaceCount,
    RAMP_N: RAMP_N, RAMP_S: RAMP_S, RAMP_W: RAMP_W, RAMP_E: RAMP_E,
    FACE_FLIP_V: FACE_FLIP_V,
    FACE_SWAP_UV: FACE_SWAP_UV,
    FLAG_FLIPV: FLAG_FLIPV,
    FLAG_SWAPUV: FLAG_SWAPUV,
    SLICE_REGULAR: SLICE_REGULAR,
    SLICE_TOP_CAP: SLICE_TOP_CAP,
    SLICE_BOTTOM_CAP: SLICE_BOTTOM_CAP,
    createBuilder: createBuilder,
    concatMeshes: concatMeshes,
    FACES: FACES,
  };

  try { root.DFVoxelMesh = api; } catch { /* Node loads through module.exports below */ }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
