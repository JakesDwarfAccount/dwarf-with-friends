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

// dwf-voxel-mesh.js -- WT11 (3D world viewer), the MESH stage. PURE: voxel-field-in,
// typed-mesh-arrays-out. No DOM, no WebGL. Per-face culling: a solid voxel emits a face on a
// given side ONLY when the neighbor on that side is empty or unexplored (out of the field). No
// interior faces, so a solid mass costs only its surface area. Faces are two triangles (6 verts)
// of position+normal+color; the whole field is one contiguous buffer (one drawArrays for the
// renderer). Greedy merging is intentionally deferred (see the WT11 DEFERRED roadmap) -- per-face
// culling already removes the dominant cost (interior faces) and is exactly assertable in a
// fixture (face counts), which is what the completeness protocol wants for this slice.
//
// A neighbor OUT OF the field counts as air -> the box's outer shell and its see-into cross-section
// are drawn (honest: you are looking at a cut slab of the world). This rule is deterministic and
// is what the face-count test pins.
//
// Chunking: buildMesh(field, {zStart,zEnd}) meshes only the z-slabs in [zStart,zEnd) but still
// culls against the FULL field, so slab boundaries cull correctly and concatenating consecutive
// slabs (in ascending z) is byte-identical to a single full build. createBuilder() drives that
// slab-by-slab over multiple frames to keep any single main-thread step small (PERF guardrail).

(function (root) {
  "use strict";

  // Six faces. Each: normal + the 4 corner offsets of the face on the unit cube [0,1]^3, wound
  // counter-clockwise as seen from OUTSIDE (front face, so back-face culling keeps them). A voxel
  // at (x,y,z) occupies [x,x+1] x [y,y+1] x [z,z+1] in grid space; the renderer maps grid->world.
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

  function idx(field, x, y, z) { return x + field.dimX * (y + field.dimY * z); }
  function solidAt(field, x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= field.dimX || y >= field.dimY || z >= field.dimZ) return false;
    return field.solid[idx(field, x, y, z)] === 1;
  }

  // Count exposed faces in z-slabs [zStart,zEnd). Used to preallocate exact typed arrays.
  function countFaces(field, zStart, zEnd) {
    var faces = 0;
    for (var z = zStart; z < zEnd; z++) {
      for (var y = 0; y < field.dimY; y++) {
        var rowBase = field.dimX * (y + field.dimY * z);
        for (var x = 0; x < field.dimX; x++) {
          if (field.solid[rowBase + x] !== 1) continue;
          for (var f = 0; f < 6; f++) {
            var d = FACES[f].d;
            if (!solidAt(field, x + d[0], y + d[1], z + d[2])) faces++;
          }
        }
      }
    }
    return faces;
  }

  // Build the mesh for z-slabs [zStart,zEnd) (default: whole field). Returns:
  //   { positions:Float32Array(faces*18), normals:Float32Array(faces*18),
  //     colors:Uint8Array(faces*18), faceCount, vertCount }
  // Positions are in GRID space (voxel units). The renderer translates by the field center and
  // scales to world units.
  function buildMesh(field, opts) {
    var o = opts || {};
    var zStart = typeof o.zStart === "number" ? Math.max(0, o.zStart | 0) : 0;
    var zEnd = typeof o.zEnd === "number" ? Math.min(field.dimZ, o.zEnd | 0) : field.dimZ;
    if (zEnd < zStart) zEnd = zStart;

    var faceCount = countFaces(field, zStart, zEnd);
    var vertCount = faceCount * 6;
    var positions = new Float32Array(vertCount * 3);
    var normals = new Float32Array(vertCount * 3);
    var colors = new Uint8Array(vertCount * 3);

    var vp = 0; // vertex write cursor (in vec3 units)
    for (var z = zStart; z < zEnd; z++) {
      for (var y = 0; y < field.dimY; y++) {
        var rowBase = field.dimX * (y + field.dimY * z);
        for (var x = 0; x < field.dimX; x++) {
          var vi = rowBase + x;
          if (field.solid[vi] !== 1) continue;
          var cbase = vi * 3;
          var r = field.color[cbase], g = field.color[cbase + 1], b = field.color[cbase + 2];
          for (var f = 0; f < 6; f++) {
            var face = FACES[f];
            var d = face.d;
            if (solidAt(field, x + d[0], y + d[1], z + d[2])) continue; // culled: neighbor solid
            var nx = face.n[0], ny = face.n[1], nz = face.n[2];
            for (var k = 0; k < 6; k++) {
              var corner = face.c[TRI[k]];
              var p3 = vp * 3;
              positions[p3] = x + corner[0];
              positions[p3 + 1] = y + corner[1];
              positions[p3 + 2] = z + corner[2];
              normals[p3] = nx; normals[p3 + 1] = ny; normals[p3 + 2] = nz;
              colors[p3] = r; colors[p3 + 1] = g; colors[p3 + 2] = b;
              vp++;
            }
          }
        }
      }
    }

    return {
      positions: positions, normals: normals, colors: colors,
      faceCount: faceCount, vertCount: vertCount,
      zStart: zStart, zEnd: zEnd,
    };
  }

  // Concatenate slab meshes (ascending, contiguous z) into one -- what createBuilder accumulates.
  function concatMeshes(parts) {
    var faceCount = 0, vertCount = 0;
    for (var i = 0; i < parts.length; i++) { faceCount += parts[i].faceCount; vertCount += parts[i].vertCount; }
    var positions = new Float32Array(vertCount * 3);
    var normals = new Float32Array(vertCount * 3);
    var colors = new Uint8Array(vertCount * 3);
    var off = 0;
    for (var j = 0; j < parts.length; j++) {
      positions.set(parts[j].positions, off);
      normals.set(parts[j].normals, off);
      colors.set(parts[j].colors, off);
      off += parts[j].vertCount * 3;
    }
    return { positions: positions, normals: normals, colors: colors, faceCount: faceCount, vertCount: vertCount };
  }

  // Chunked builder: meshes `slabZ` z-levels per step() so no single call blocks the main thread
  // for long. step() returns true while more work remains; result() concatenates when done.
  // Equivalent (byte-identical) to buildMesh(field) over the whole field -- the mesh-equivalence
  // test asserts exactly that.
  function createBuilder(field, opts) {
    var o = opts || {};
    var slabZ = Math.max(1, (o.slabZ | 0) || 2);
    var z = 0;
    var parts = [];
    return {
      done: function () { return z >= field.dimZ; },
      step: function () {
        if (z >= field.dimZ) return false;
        var zEnd = Math.min(field.dimZ, z + slabZ);
        parts.push(buildMesh(field, { zStart: z, zEnd: zEnd }));
        z = zEnd;
        return z < field.dimZ;
      },
      result: function () { return concatMeshes(parts); },
      progress: function () { return field.dimZ ? z / field.dimZ : 1; },
    };
  }

  var api = {
    buildMesh: buildMesh,
    countFaces: countFaces,
    createBuilder: createBuilder,
    concatMeshes: concatMeshes,
    FACES: FACES,
  };

  try { root.DFVoxelMesh = api; } catch (_) { /* non-browser */ }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
