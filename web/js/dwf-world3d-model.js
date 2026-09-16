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

// The camera target is stored in ABSOLUTE world coordinates, never field-local, so re-voxelizing
// around a moved camera cannot yank the view.

(function (root) {
  "use strict";

  // ---- camera ------------------------------------------------------------------------------------
  // pitch stays just inside +/- PI/2: at the pole the view direction parallels up and lookAt degenerates.
  var PITCH_EPS = 0.02;
  var LIMITS = {
    pitchMin: -(Math.PI / 2) + PITCH_EPS,
    pitchMax: (Math.PI / 2) - PITCH_EPS,
    distMin: 3,
    distMax: 3000,
  };
  var ORBIT_SENS = 0.0075;   // radians per pixel
  var PAN_SENS = 0.0016;     // world units per pixel, per unit of dist
  var ZOOM_BASE = 1.12;      // dist multiplier per wheel tick
  var DRAG_ZOOM_SENS = 0.01; // wheel-ticks-equivalent per pixel of vertical drag

  var clamp = (root.DwfUtil || (typeof module !== "undefined" && module.require ? module.require("./dwf-util.js") : null)).clamp;
  function isNum(n) { return typeof n === "number" && isFinite(n); }

  function create(opts) {
    var o = opts || {};
    return {
      yaw: isNum(o.yaw) ? o.yaw : -0.9,
      pitch: clamp(isNum(o.pitch) ? o.pitch : 0.85, LIMITS.pitchMin, LIMITS.pitchMax),
      dist: clamp(isNum(o.dist) ? o.dist : 120, LIMITS.distMin, LIMITS.distMax),
      target: [
        isNum(o.tx) ? o.tx : 0,
        isNum(o.ty) ? o.ty : 0,
        isNum(o.tz) ? o.tz : 0,
      ],
    };
  }
  function copy(c) { return { yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: [c.target[0], c.target[1], c.target[2]] }; }

  // Eye position on the orbit sphere; z is up, matching the renderer's up vector.
  function eye(c) {
    var cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    return [
      c.target[0] + c.dist * cp * Math.cos(c.yaw),
      c.target[1] + c.dist * cp * Math.sin(c.yaw),
      c.target[2] + c.dist * sp,
    ];
  }

  // Dragging DOWN raises pitch: the grab-and-pull convention the grab cursor promises.
  function orbit(c, dx, dy) {
    c.yaw -= dx * ORBIT_SENS;
    c.pitch = clamp(c.pitch + dy * ORBIT_SENS, LIMITS.pitchMin, LIMITS.pitchMax);
    return c;
  }

  // Zoom by wheel ticks, positive = away. Exponential, so each tick feels the same at any scale.
  function zoom(c, ticks) {
    c.dist = clamp(c.dist * Math.pow(ZOOM_BASE, ticks), LIMITS.distMin, LIMITS.distMax);
    return c;
  }
  // Drag-zoom (middle-drag / Ctrl-drag): vertical pixels -> ticks. Dragging DOWN zooms OUT.
  function dragZoom(c, dy) { return zoom(c, dy * DRAG_ZOOM_SENS); }

  // Screen-plane basis from the current orbit angles; the renderer's lookAt uses the same yaw/pitch.
  function basis(c) {
    var e = eye(c);
    var fx = c.target[0] - e[0], fy = c.target[1] - e[1], fz = c.target[2] - e[2];
    var fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    // right = normalize(fwd x worldUp); worldUp = [0,0,1]. Never degenerate thanks to PITCH_EPS.
    var rx = fy * 1 - fz * 0, ry = fz * 0 - fx * 1, rz = fx * 0 - fy * 0;
    var rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    // up = right x fwd
    var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    return { fwd: [fx, fy, fz], right: [rx, ry, rz], up: [ux, uy, uz] };
  }

  // Pan the target across the screen plane; scaled by dist so the world tracks the cursor at any
  // zoom. Dragging right moves the world right (the target moves LEFT), i.e. grab-and-drag.
  // KNOWN LIMITATION: this moves the target in UNSTRETCHED world space, same as the rest of this
  // pure module -- it does not know about dwf-world3d.js's Z_SCALE render-only z exaggeration. A
  // pan with a vertical (z) component therefore renders as slightly FASTER than an equal-sized
  // horizontal pan (by the Z_SCALE factor), since the renderer stretches only the z axis after the
  // fact. Low-severity (Z_SCALE is a modest 1.5x) and left alone rather than teaching this pure
  // camera module a render concept for a feel tweak nobody has actually reported yet.
  function pan(c, dx, dy) {
    var b = basis(c);
    var k = c.dist * PAN_SENS;
    for (var i = 0; i < 3; i++) c.target[i] += (-dx * b.right[i] + dy * b.up[i]) * k;
    return c;
  }

  // Walk the target along the ground plane (WASD): forward is the view direction flattened to z=0.
  function walk(c, forward, strafe) {
    var b = basis(c);
    var fl = Math.hypot(b.fwd[0], b.fwd[1]) || 1;
    var f = [b.fwd[0] / fl, b.fwd[1] / fl];
    var step = Math.max(2, c.dist * 0.06);
    c.target[0] += (f[0] * forward + b.right[0] * strafe) * step;
    c.target[1] += (f[1] * forward + b.right[1] * strafe) * step;
    return c;
  }

  function frame(c, field, zScale) {
    if (!field) return c;
    var zs = isNum(zScale) && zScale > 0 ? zScale : 1;
    c.target = [
      field.ox + field.dimX / 2,
      -(field.oy + field.dimY / 2),
      field.oz + field.dimZ / 2,
    ];
    c.dist = clamp(Math.max(field.dimX, field.dimY, field.dimZ * zs) * 1.4, LIMITS.distMin, LIMITS.distMax);
    return c;
  }

  function smooth(cur, goal, dtMs, rate) {
    var r = isNum(rate) ? rate : 18;
    var a = 1 - Math.exp(-r * Math.max(0, dtMs || 0) / 1000);
    if (a >= 1) a = 1;
    cur.yaw += (goal.yaw - cur.yaw) * a;
    cur.pitch += (goal.pitch - cur.pitch) * a;
    cur.dist += (goal.dist - cur.dist) * a;
    for (var i = 0; i < 3; i++) cur.target[i] += (goal.target[i] - cur.target[i]) * a;
    if (settled(cur, goal)) {
      cur.yaw = goal.yaw; cur.pitch = goal.pitch; cur.dist = goal.dist;
      cur.target = [goal.target[0], goal.target[1], goal.target[2]];
    }
    return cur;
  }
  function settled(a, b) {
    return Math.abs(a.yaw - b.yaw) < 1e-4 && Math.abs(a.pitch - b.pitch) < 1e-4 &&
      Math.abs(a.dist - b.dist) < 1e-3 &&
      Math.abs(a.target[0] - b.target[0]) < 1e-3 &&
      Math.abs(a.target[1] - b.target[1]) < 1e-3 &&
      Math.abs(a.target[2] - b.target[2]) < 1e-3;
  }

  // ---- slab (the z-window) -------------------------------------------------------------------------
  // No layer cap: the voxel field is sparse, so the only clamp is the world's real z-extent.
  var SLAB = {
    minDown: 1,
    defaultDown: 20,
    defaultUp: 0,
    // Slider travel for the top handle before hello_ack tells us the world's height.
    unknownHeadroom: 64,
  };

  function slabCreate(opts) {
    var o = opts || {};
    return {
      down: isNum(o.down) ? Math.max(SLAB.minDown, o.down | 0) : SLAB.defaultDown,
      up: isNum(o.up) ? Math.max(0, o.up | 0) : SLAB.defaultUp,
    };
  }

  // worldZ <= 0 means the ceiling is unknown (pre-hello_ack): then only the floor (z >= 0) applies.
  function slabClamp(s, cz, worldZ) {
    if (isNum(s.zBot) && isNum(s.zTop)) {
      var lo = Math.min(s.zBot | 0, s.zTop | 0), hi = Math.max(s.zBot | 0, s.zTop | 0);
      var max = isNum(worldZ) && worldZ > 0 ? (worldZ | 0) - 1 : Math.max(hi, (cz | 0) + SLAB.unknownHeadroom - 1);
      lo = clamp(lo, 0, max); hi = clamp(hi, 0, max);
      return { zBot: lo, zTop: hi };
    }
    var down = Math.max(SLAB.minDown, s.down | 0);
    var up = Math.max(0, s.up | 0);
    if (isNum(cz)) {
      down = Math.min(down, cz + 1);
      if (isNum(worldZ) && worldZ > 0) up = Math.min(up, Math.max(0, worldZ - 1 - cz));
    }
    return { down: Math.max(SLAB.minDown, down), up: up };
  }

  function slabRange(s, cz) {
    if (isNum(s.zBot) && isNum(s.zTop)) {
      var lo = Math.min(s.zBot | 0, s.zTop | 0), hi = Math.max(s.zBot | 0, s.zTop | 0);
      return { zBot: lo, zTop: hi, count: hi - lo + 1 };
    }
    var down = Math.max(SLAB.minDown, s.down | 0), up = Math.max(0, s.up | 0);
    return { zBot: (cz | 0) - (down - 1), zTop: (cz | 0) + up, count: down + up };
  }

  // ---- the z-window as an ABSOLUTE range (the dual-handle slider's language) -----------------------
  function slabFromRange(zBot, zTop, cz, worldZ) {
    var lo = zBot | 0, hi = zTop | 0;
    if (lo > hi) { var t = lo; lo = hi; hi = t; }
    return slabClamp({ zBot: lo, zTop: hi }, cz | 0, worldZ);
  }

  function slabBounds(cz, worldZ) {
    var c = cz | 0;
    var known = isNum(worldZ) && worldZ > 0;
    return { zMin: 0, zMax: known ? (worldZ | 0) - 1 : c + (SLAB.unknownHeadroom - 1) };
  }

  function slabSpan(zBot, zTop) {
    var lo = zBot | 0, hi = zTop | 0;
    if (lo > hi) { var t = lo; lo = hi; hi = t; }
    return hi - lo + 1;
  }

  // ---- presets -------------------------------------------------------------------------------------
  // A preset returns null when it cannot be answered honestly, so the view can DISABLE the chip.
  var SURFACE_LAYERS = 8;  // "Surface" = the fort's top level and the 7 under it
  var AROUND_CAMERA = 8;   // "Around camera" = 8 up and 8 down (17 layers)

  function slabPresetRange(id, ctx) {
    var o = ctx || {};
    var cz = o.cz | 0;
    var fort = o.fort && isNum(o.fort.zBot) && isNum(o.fort.zTop) ? o.fort : null;
    if (id === "camera") return { zBot: cz - AROUND_CAMERA, zTop: cz + AROUND_CAMERA };
    if (!fort) return null;
    if (id === "fort") return { zBot: fort.zBot, zTop: fort.zTop };
    if (id === "surface") return { zBot: fort.zTop - (SURFACE_LAYERS - 1), zTop: fort.zTop };
    return null;
  }

  // Each returns a NEW clamped slab; a no-op at a bound returns an equal slab, which the view compares.
  function slabMoveEdge(s, cz, worldZ, edge, delta) {
    var r = slabRange(s, cz), n = delta || 1;
    return slabFromRange(edge === "top" ? r.zBot : Math.min(r.zTop, r.zBot + n),
      edge === "top" ? Math.max(r.zBot, r.zTop + n) : r.zTop, cz, worldZ);
  }
  function slabAddAbove(s, cz, worldZ, n) { return slabMoveEdge(s, cz, worldZ, "top", n || 1); }
  function slabRemoveAbove(s, cz, worldZ, n) { return slabMoveEdge(s, cz, worldZ, "top", -(n || 1)); }
  function slabAddBelow(s, cz, worldZ, n) { return slabMoveEdge(s, cz, worldZ, "base", -(n || 1)); }
  function slabRemoveBelow(s, cz, worldZ, n) { return slabMoveEdge(s, cz, worldZ, "base", n || 1); }
  function slabEquals(a, b) {
    if (!a || !b) return false;
    if (isNum(a.zBot) || isNum(b.zBot)) return a.zBot === b.zBot && a.zTop === b.zTop;
    return a.up === b.up && a.down === b.down;
  }

  var api = {
    cam: {
      create: create, copy: copy, eye: eye, basis: basis,
      orbit: orbit, pan: pan, zoom: zoom, dragZoom: dragZoom, walk: walk,
      frame: frame, smooth: smooth, settled: settled,
      LIMITS: LIMITS, ORBIT_SENS: ORBIT_SENS, ZOOM_BASE: ZOOM_BASE,
    },
    slab: {
      create: slabCreate, clamp: slabClamp, range: slabRange, equals: slabEquals,
      addAbove: slabAddAbove, removeAbove: slabRemoveAbove,
      addBelow: slabAddBelow, removeBelow: slabRemoveBelow,
      fromRange: slabFromRange, bounds: slabBounds, span: slabSpan,
      presetRange: slabPresetRange,
      LIMITS: SLAB,
    },
  };

  try { root.DFWorld3DModel = api; } catch { /* Node loads through module.exports below */ }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
