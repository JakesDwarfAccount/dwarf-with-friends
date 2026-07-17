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

// dwf-world3d-model.js -- WT11 (3D world viewer), the MODEL stage. PURE: no DOM, no WebGL.
// Two state machines the VIEW stage (dwf-world3d.js) drives from input events:
//
//   DFWorld3DModel.cam  -- an orbit camera (yaw/pitch/dist around a WORLD-space target) with
//                          orbit / pan / zoom / framing and hard limits, plus frame-rate-independent
//                          exponential smoothing toward a goal (calm, never overshoots).
//   DFWorld3DModel.slab -- the z-window: `down` layers at-and-below the camera z and `up` layers
//                          above it, clamped to the world's z bounds and a total-layer ceiling.
//
// WHY PURE: the WT11 reopen found that every control in the 3D viewer was dead, and the shipped
// tests could not have caught it -- they grepped the source as a STRING. Camera math and slab
// clamping now live here, where a node fixture can execute them (wt11_camera_test.mjs).
//
// The camera target is WORLD space (not voxel-grid space) on purpose: the renderer applies a model
// matrix that translates the grid by the field origin, so re-voxelizing around a moved camera (or
// growing the slab) shifts the field origin WITHOUT yanking the view off the spot you were looking
// at. That is the root fix for "Refresh jumps my camera".

(function (root) {
  "use strict";

  // ---- camera -----------------------------------------------------------------------------------
  // pitch is clamped just inside +/- PI/2 so the view direction is never parallel to the [0,0,1] up
  // vector -- that degeneracy (not a true gimbal lock, but it reads as one) is what makes hand-rolled
  // orbit cameras flip over at the poles. Keeping EPS out of the pole makes lookAt's cross products
  // always well-conditioned.
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

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
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

  // Eye position on the orbit sphere. z is up (DF's world z), matching the renderer's up vector.
  function eye(c) {
    var cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    return [
      c.target[0] + c.dist * cp * Math.cos(c.yaw),
      c.target[1] + c.dist * cp * Math.sin(c.yaw),
      c.target[2] + c.dist * sp,
    ];
  }

  // Orbit by a pixel delta. Dragging DOWN tilts the model's top toward you (pitch rises), which is
  // the "grab the model and pull it" convention the grab cursor promises.
  function orbit(c, dx, dy) {
    c.yaw -= dx * ORBIT_SENS;
    c.pitch = clamp(c.pitch + dy * ORBIT_SENS, LIMITS.pitchMin, LIMITS.pitchMax);
    return c;
  }

  // Zoom by wheel ticks (positive = away). Exponential so each tick feels the same at any scale.
  function zoom(c, ticks) {
    c.dist = clamp(c.dist * Math.pow(ZOOM_BASE, ticks), LIMITS.distMin, LIMITS.distMax);
    return c;
  }
  // Drag-zoom (middle-drag / Ctrl-drag): vertical pixels -> ticks. Dragging DOWN zooms OUT.
  function dragZoom(c, dy) { return zoom(c, dy * DRAG_ZOOM_SENS); }

  // The camera's screen-plane basis (right, up), derived from the current orbit angles. Pure -- the
  // renderer builds its lookAt from the same yaw/pitch, so these agree with what's on screen.
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
  function pan(c, dx, dy) {
    var b = basis(c);
    var k = c.dist * PAN_SENS;
    for (var i = 0; i < 3; i++) c.target[i] += (-dx * b.right[i] + dy * b.up[i]) * k;
    return c;
  }

  // Walk the target along the ground plane (WASD): forward is the view direction flattened to z=0,
  // so W always goes "into the screen" regardless of pitch.
  function walk(c, forward, strafe) {
    var b = basis(c);
    var fl = Math.hypot(b.fwd[0], b.fwd[1]) || 1;
    var f = [b.fwd[0] / fl, b.fwd[1] / fl];
    var step = Math.max(2, c.dist * 0.06);
    c.target[0] += (f[0] * forward + b.right[0] * strafe) * step;
    c.target[1] += (f[1] * forward + b.right[1] * strafe) * step;
    return c;
  }

  // Frame a voxel field: center the target on the field's WORLD-space middle and back off far
  // enough to see the whole footprint.
  function frame(c, field) {
    if (!field) return c;
    c.target = [
      field.ox + field.dimX / 2,
      field.oy + field.dimY / 2,
      field.oz + field.dimZ / 2,
    ];
    c.dist = clamp(Math.max(field.dimX, field.dimY) * 1.4, LIMITS.distMin, LIMITS.distMax);
    return c;
  }

  // Frame-rate-independent exponential smoothing toward `goal`. alpha = 1 - exp(-rate*dt) makes the
  // approach identical at 30fps and 144fps. It is a pure decay -- it CANNOT overshoot, which is what
  // the house style asks for (calm, no springy bounce). Snaps when within epsilon so it settles.
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

  // ---- slab (the z-window) ----------------------------------------------------------------------
  // `down` counts layers AT AND BELOW the camera z (so down=1 is the camera plane alone, and it can
  // never be 0 -- there is always something to look at). `up` counts layers strictly ABOVE it.
  // the #1: before this, `up` did not exist and the box only ever descended from the camera.
  var SLAB = {
    minDown: 1,
    defaultDown: 20,
    defaultUp: 0,
    maxLayers: 48, // total (up + down). Guards the voxel budget: 96*96*48 is already past the cap,
                   // so the voxelizer would degrade the footprint -- this keeps the slab honest.
  };

  function slabCreate(opts) {
    var o = opts || {};
    return {
      down: isNum(o.down) ? Math.max(SLAB.minDown, o.down | 0) : SLAB.defaultDown,
      up: isNum(o.up) ? Math.max(0, o.up | 0) : SLAB.defaultUp,
    };
  }

  // Clamp a slab against the camera z and the world's z-level count. worldZ <= 0 means "unknown"
  // (pre-hello_ack): then only the floor (z>=0) and the layer ceiling apply.
  function slabClamp(s, cz, worldZ) {
    var down = Math.max(SLAB.minDown, s.down | 0);
    var up = Math.max(0, s.up | 0);
    if (isNum(cz)) {
      down = Math.min(down, cz + 1);                   // zBot = cz-(down-1) >= 0
      if (isNum(worldZ) && worldZ > 0) up = Math.min(up, Math.max(0, worldZ - 1 - cz)); // zTop <= worldZ-1
    }
    down = Math.max(SLAB.minDown, down);
    // Total ceiling: shave `up` first (the camera plane and what's under it is the point of the view).
    if (up + down > SLAB.maxLayers) up = Math.max(0, SLAB.maxLayers - down);
    if (up + down > SLAB.maxLayers) down = Math.max(SLAB.minDown, SLAB.maxLayers - up);
    return { down: down, up: up };
  }

  function slabRange(s, cz) {
    var down = Math.max(SLAB.minDown, s.down | 0), up = Math.max(0, s.up | 0);
    return { zBot: (cz | 0) - (down - 1), zTop: (cz | 0) + up, count: down + up };
  }

  // The four controls a playtester asked for. Each returns a NEW clamped slab; a no-op at a bound returns
  // an equal slab (the view stage compares to decide whether a rebuild is even needed).
  function slabAddAbove(s, cz, worldZ, n) { return slabClamp({ down: s.down, up: s.up + (n || 1) }, cz, worldZ); }
  function slabRemoveAbove(s, cz, worldZ, n) { return slabClamp({ down: s.down, up: s.up - (n || 1) }, cz, worldZ); }
  function slabAddBelow(s, cz, worldZ, n) { return slabClamp({ down: s.down + (n || 1), up: s.up }, cz, worldZ); }
  function slabRemoveBelow(s, cz, worldZ, n) { return slabClamp({ down: s.down - (n || 1), up: s.up }, cz, worldZ); }
  function slabEquals(a, b) { return !!a && !!b && a.up === b.up && a.down === b.down; }

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
      LIMITS: SLAB,
    },
  };

  try { root.DFWorld3DModel = api; } catch (_) { /* non-browser */ }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
