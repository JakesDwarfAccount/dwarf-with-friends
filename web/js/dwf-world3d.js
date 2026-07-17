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

// dwf-world3d.js -- WT11 (3D world viewer), the VIEW stage. Browser-only: hand-rolled WebGL2
// (matching dwf-gl.js's idiom -- no three.js, no external deps, CSP/offline-safe), a
// full-canvas overlay with a DWFUI header, orbit/pan/zoom, an adjustable z-slab, flat shading + one
// directional light + z-depth fog.
//
// It composes three stages: DFWorld3DModel (PURE camera + slab state machines), DFVoxelizer (cache
// -> voxel field) and DFVoxelMesh (field -> mesh, chunked over frames so a rebuild never stalls the
// main thread). World data comes from DwfCache.windowView() per z-slice; the live camera from
// DwfTiles; the world's z-extent from DwfCache.mapDims().
//
// ---- WT11 REOPEN (the punch list: orbit dead, zoom dead, Refresh dead) --------------------
// Every control here was WRITTEN but never RECEIVED AN EVENT. Two independent causes, both fixed:
//
//   RC-1 (CSS, dwf.css): `.world3d-fallback` set `display:grid` unconditionally while being
//   toggled with the `hidden` ATTRIBUTE. An author `display` rule beats the UA stylesheet's
//   `[hidden]{display:none}` (author origin wins over user-agent origin), so the WebGL-error pane --
//   `position:absolute; inset:0`, no `pointer-events:none`, and LAST in the DOM -- stayed in the
//   layout as an INVISIBLE full-screen glass pane over the canvas AND the header. It swallowed every
//   pointerdown (orbit/pan) and every click (Refresh). Esc still worked, which is exactly why the
//   viewer looked "mostly fine": Esc is a document keydown and never touches the DOM.
//
//   RC-2 (input ownership, dwf-core.js): core binds `wheel` and `keydown` on WINDOW in the
//   CAPTURE phase and calls stopImmediatePropagation() to drive the 2D map. Capture on window runs
//   before anything this file can bind, so the canvas's own wheel listener never fired (zoom dead)
//   and W/A/S/D/E/C were eaten (3D pan dead) -- while silently panning the 2D game camera BEHIND
//   the overlay. Fixed by making those handlers YIELD while the viewer is open, which is this
//   codebase's established remedy for the hazard (see core.js's `.dwfui-scroll` wheel yield).
//
// Both were invisible to the original tests because they asserted on the source as a STRING. The
// camera/slab math is now a pure module with executable fixtures, and a DOM fixture drives the real
// controls end-to-end (wt11_camera_test.mjs, wt11_world3d_dom_test.mjs).
//
// ---- B237 (07-14: "bottom of screen has two sets of controls overlapping each other") -------
// Two collisions, both in the bottom-left column, neither a stacking bug:
//   1. The viewer's own readouts. `.world3d-status` (bottom:34) and `.world3d-hint` (bottom:8) were
//      two absolutely-positioned boxes with hardcoded offsets, and the hint's 143-character legend
//      WRAPS to two lines at any width -- so it grew to ~41px and rode up through the status box.
//      Boxes docked by `bottom` cannot know each other's height; the overlap was structural.
//   2. `#dfChatToggle` (dwf-chat.js: fixed, left:8, bottom:52, z8980) floats above EVERY
//      screen in this client -- the 3D overlay's z122 included -- and landed on the status box.
// Fix: the viewer's chrome is now ONE top-anchored flex column (header + readouts). A column cannot
// self-overlap however its text wraps, and the bottom-left lane -- which belongs to the client's
// global chat dock -- is left empty at every viewport size. Opening the viewer also puts <body> into
// `world3d-mode`, which takes the 2D client's interactive chrome OUT OF THE LAYOUT (display:none --
// see the CSS): the 3D view is a MODE, not a window taped over the game. The mode is one class and
// the viewer never writes to a node it does not own, so close() restores the client exactly.

(function (root) {
  "use strict";

  var doc = root.document;
  if (!doc) return; // non-browser (test) context: the pure stages are tested separately.

  var Vox = root.DFVoxelizer;
  var Mesh = root.DFVoxelMesh;
  var Model = root.DFWorld3DModel;

  // ---- small mat4 helpers (column-major, WebGL order) -----------------------------------------
  function mMul(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        o[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }
  function mPerspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    var o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf;
    return o;
  }
  function mTranslate(x, y, z) {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  }
  function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vCross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function vNorm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function mLookAt(eye, center, up) {
    var z = vNorm(vSub(eye, center));
    var x = vNorm(vCross(up, z));
    var y = vCross(z, x);
    var o = new Float32Array(16);
    o[0] = x[0]; o[1] = y[0]; o[2] = z[0]; o[3] = 0;
    o[4] = x[1]; o[5] = y[1]; o[6] = z[1]; o[7] = 0;
    o[8] = x[2]; o[9] = y[2]; o[10] = z[2]; o[11] = 0;
    o[12] = -vDot(x, eye); o[13] = -vDot(y, eye); o[14] = -vDot(z, eye); o[15] = 1;
    return o;
  }

  // ---- shaders (WebGL2 / GLSL ES 3.00, dwf-gl.js idiom) ----------------------------------
  // u_mvp = proj * view * model, u_mv = view * model. The MODEL matrix translates the voxel grid to
  // its WORLD origin, so the camera target is a WORLD coordinate: re-voxelizing around a moved
  // camera (or a resized slab) shifts the grid origin without moving what you are looking at.
  var VERT_SRC =
    "#version 300 es\n" +
    "layout(location=0) in vec3 a_pos;\n" +
    "layout(location=1) in vec3 a_normal;\n" +
    "layout(location=2) in vec3 a_color;\n" +
    "uniform mat4 u_mvp;\n" +
    "uniform mat4 u_mv;\n" +
    "flat out vec3 v_normal;\n" +
    "flat out vec3 v_color;\n" +
    "out float v_dist;\n" +
    "void main(){\n" +
    "  gl_Position = u_mvp * vec4(a_pos, 1.0);\n" +
    "  v_normal = a_normal;\n" +
    "  v_color = a_color;\n" +
    "  v_dist = -(u_mv * vec4(a_pos, 1.0)).z;\n" + // view-space depth (positive in front)
    "}\n";
  var FRAG_SRC =
    "#version 300 es\n" +
    "precision highp float;\n" +
    "flat in vec3 v_normal;\n" +
    "flat in vec3 v_color;\n" +
    "in float v_dist;\n" +
    "uniform vec3 u_lightDir;\n" +   // pre-normalized, pointing FROM surface TO light
    "uniform float u_ambient;\n" +
    "uniform vec3 u_fogColor;\n" +
    "uniform vec2 u_fog;\n" +        // (near, far)
    "out vec4 o;\n" +
    "void main(){\n" +
    "  float d = max(dot(normalize(v_normal), u_lightDir), 0.0);\n" +
    "  vec3 lit = v_color * (u_ambient + (1.0 - u_ambient) * d);\n" +
    "  float fog = clamp((v_dist - u_fog.x) / max(u_fog.y - u_fog.x, 0.001), 0.0, 1.0);\n" +
    "  o = vec4(mix(lit, u_fogColor, fog), 1.0);\n" +
    "}\n";

  // ---- module state ---------------------------------------------------------------------------
  var el = null, canvas = null, statusEl = null, hintEl = null, slabEl = null;
  var gl = null, program = null, vao = null, vboPos = null, vboNorm = null, vboColor = null;
  var uni = null;
  var open = false;
  var rafId = 0;
  var needsRender = true;
  var vertCount = 0;
  var field = null;
  var builder = null;      // in-flight chunked mesh builder (or null when idle)
  var buildStartMs = 0;
  var lastBuildMs = 0;
  var lastFrameMs = 0;
  var maxStepMs = 0;       // PERF: worst single main-thread build step of this rebuild
  var built = null;        // the {cx,cy,cz,up,down} the CURRENT mesh was built for
  var autoAt = 0;          // debounce deadline for auto-refresh (0 = nothing pending)
  var drag = null;         // {mode:'orbit'|'pan'|'zoom', x, y}

  // Camera: `goal` is what input writes; `cur` is the smoothed camera actually rendered.
  var goal = null, cur = null, slab = null;

  var FOG_COLOR = [0.055, 0.05, 0.04];
  var LIGHT_DIR = vNorm([0.5, 0.35, 0.8]);
  var BUILD_BUDGET_MS = 6;   // PERF: main-thread ceiling per FRAME for meshing (< half a 60fps frame)
  var AUTO_DEBOUNCE_MS = 400;

  function loaded() { return !!(Vox && Mesh && Model); }
  function now() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }

  // ---- GL setup -------------------------------------------------------------------------------
  function compile(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { var log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error("shader: " + log); }
    return s;
  }
  function initGL() {
    gl = canvas.getContext("webgl2", { antialias: true, depth: true });
    if (!gl) throw new Error("WebGL2 unavailable");
    var vs = compile(gl.VERTEX_SHADER, VERT_SRC), fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(program));
    gl.deleteShader(vs); gl.deleteShader(fs);
    uni = {
      mvp: gl.getUniformLocation(program, "u_mvp"),
      mv: gl.getUniformLocation(program, "u_mv"),
      lightDir: gl.getUniformLocation(program, "u_lightDir"),
      ambient: gl.getUniformLocation(program, "u_ambient"),
      fogColor: gl.getUniformLocation(program, "u_fogColor"),
      fog: gl.getUniformLocation(program, "u_fog"),
    };
    vao = gl.createVertexArray();
    vboPos = gl.createBuffer(); vboNorm = gl.createBuffer(); vboColor = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboPos); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboNorm); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboColor); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW);
    gl.clearColor(FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2], 1);
  }

  function uploadMesh(mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, vboPos); gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboNorm); gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboColor); gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW);
    vertCount = mesh.vertCount;
    needsRender = true;
  }

  // ---- data -----------------------------------------------------------------------------------
  function currentCamera() {
    try {
      var latest = root.DwfTiles && root.DwfTiles.getLatest && root.DwfTiles.getLatest();
      if (latest && latest.origin) {
        return {
          cx: latest.origin.x + Math.floor((latest.width || 0) / 2),
          cy: latest.origin.y + Math.floor((latest.height || 0) / 2),
          cz: latest.origin.z,
        };
      }
    } catch (_) {}
    return null;
  }

  // The world's z-level count, for clamping the slab at the TRUE world bounds. 0 pre-hello_ack,
  // which the slab model reads as "ceiling unknown" (floor and layer-cap still apply).
  function worldZ() {
    try {
      var d = root.DwfCache && root.DwfCache.mapDims && root.DwfCache.mapDims();
      return (d && typeof d.z === "number" && d.z > 0) ? d.z : 0;
    } catch (_) { return 0; }
  }

  // Build a readTile(x,y,z) over per-z windowViews of the box -- spanning BELOW *and ABOVE* the
  // camera (zBot..zTop). Missing blocks are requested by windowView as a side effect, so a rebuild
  // is self-healing: the next one sees the blocks this one asked for.
  function makeReadTile(cx, cy, boxW, boxH, zBot, zTop) {
    var cache = root.DwfCache;
    if (!cache || typeof cache.windowView !== "function") return function () { return null; };
    var ox = cx - (boxW >> 1), oy = cy - (boxH >> 1);
    var slices = Object.create(null); // z -> {tiles,w,h,ox,oy}
    for (var z = zBot; z <= zTop; z++) {
      var view = null;
      try { view = cache.windowView(ox, oy, z, boxW, boxH); } catch (_) { view = null; }
      slices[z] = view ? { tiles: view.tiles, w: view.width, h: view.height, ox: ox, oy: oy } : null;
    }
    return function (x, y, zz) {
      var s = slices[zz];
      if (!s || !s.tiles) return null;
      var gx = x - s.ox, gy = y - s.oy;
      if (gx < 0 || gy < 0 || gx >= s.w || gy >= s.h) return null;
      return s.tiles[gy * s.w + gx] || null;
    };
  }

  function colorFn(t) {
    // The 2D material-color path, skipLiquidColor=true so a flooded floor uses its bed material.
    try { return root.DwfTiles.tileColor(t, true); } catch (_) { return null; }
  }

  // Rebuild the field + mesh from the CURRENT world state. `opts.frame` re-frames the camera; without
  // it the camera is preserved EXACTLY (world-space target + model matrix), which is what makes a
  // Refresh, an auto-refresh, and a slab change feel like the same scene instead of a jump cut.
  function rebuild(opts) {
    if (!loaded() || !gl) return;
    var o = opts || {};
    var camc = currentCamera();
    if (!camc) { setStatus("No live camera yet -- open the map first, then Refresh."); return; }

    slab = Model.slab.clamp(slab || Model.slab.create(), camc.cz, worldZ());
    var range = Model.slab.range(slab, camc.cz);
    var boxW = Vox.DEFAULT_BOX_W, boxH = Vox.DEFAULT_BOX_H;

    var readTile = makeReadTile(camc.cx, camc.cy, boxW, boxH, range.zBot, range.zTop);
    field = Vox.voxelize({
      readTile: readTile, colorFn: colorFn,
      cx: camc.cx, cy: camc.cy, cz: camc.cz,
      boxW: boxW, boxH: boxH, zDown: slab.down, zUp: slab.up,
    });
    built = { cx: camc.cx, cy: camc.cy, cz: camc.cz, up: slab.up, down: slab.down };
    autoAt = 0;

    if (o.frame || !cur) {
      goal = Model.cam.frame(goal || Model.cam.create(), field);
      cur = Model.cam.copy(goal);
    }
    // Start the CHUNKED mesh build -- stepped in the RAF loop so no single frame stalls.
    // slabZ=1 (ONE z-layer per step), not 2: measured on a 96x96 field, slabZ=2 pushed the worst
    // single step to 3.23ms -- past the 2ms guardrail -- on a fully-exposed (checkerboard) field.
    // At slabZ=1 the worst step is 1.76ms in that same synthetic worst case and <=0.9ms on realistic
    // fort geometry. Throughput is unchanged: the frame loop drains steps until BUILD_BUDGET_MS.
    builder = Mesh.createBuilder(field, { slabZ: 1 });
    buildStartMs = now();
    maxStepMs = 0;
    needsRender = true;
    renderSlabUI();
  }

  // ---- render ---------------------------------------------------------------------------------
  function resize() {
    if (!canvas) return;
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; needsRender = true; }
  }

  function draw() {
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!vertCount || !field || !cur) return;
    var aspect = canvas.width / Math.max(1, canvas.height);
    var proj = mPerspective(50 * Math.PI / 180, aspect, 0.5, 6000);
    var model = mTranslate(field.ox, field.oy, field.oz); // grid space -> world space
    var view = mLookAt(Model.cam.eye(cur), cur.target, [0, 0, 1]);
    var mv = mMul(view, model);
    gl.useProgram(program);
    gl.uniformMatrix4fv(uni.mvp, false, mMul(proj, mv));
    gl.uniformMatrix4fv(uni.mv, false, mv);
    gl.uniform3fv(uni.lightDir, LIGHT_DIR);
    gl.uniform1f(uni.ambient, 0.35);
    gl.uniform3fv(uni.fogColor, FOG_COLOR);
    // Fog spans roughly the far half of the framing distance so depth reads without hiding the model.
    gl.uniform2f(uni.fog, cur.dist * 0.6, cur.dist * 2.4);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, vertCount);
    gl.bindVertexArray(null);
  }

  function frame() {
    rafId = 0;
    if (!open) return;
    if (doc.hidden) { scheduleFrame(); return; } // paused: keep the loop alive but do no GL work

    var t = now();
    var dt = lastFrameMs ? Math.min(100, t - lastFrameMs) : 16;
    lastFrameMs = t;

    // Advance a chunked mesh build within a small time budget (PERF: never more than
    // BUILD_BUDGET_MS on the main thread per frame, so the render loop, the WS pump and the sim all
    // keep their slice).
    if (builder) {
      var start = now();
      var more = true;
      do {
        var s0 = now();
        more = builder.step();
        var stepMs = now() - s0;
        if (stepMs > maxStepMs) maxStepMs = stepMs;
      } while (more && (now() - start) < BUILD_BUDGET_MS);
      setStatus("Building 3D view... " + Math.round(builder.progress() * 100) + "%");
      if (!more && builder.done()) {
        var mesh = builder.result();
        uploadMesh(mesh);
        lastBuildMs = Math.round(now() - buildStartMs);
        builder = null;
        setStatus(summary(mesh));
      }
      needsRender = true;
    }

    // Camera smoothing: a pure exponential decay toward the goal -- calm, and it cannot overshoot.
    if (cur && goal && !Model.cam.settled(cur, goal)) {
      Model.cam.smooth(cur, goal, dt);
      needsRender = true;
    }

    // Auto-refresh: when the LIVE 2D camera has moved elsewhere, this view is stale. Rebuild once it
    // settles (debounced), preserving the 3D camera. No button press required.
    if (!builder) maybeAutoRefresh(t);

    if (needsRender) { needsRender = false; try { draw(); } catch (_) {} }
    scheduleFrame();
  }
  function scheduleFrame() { if (open && !rafId) rafId = root.requestAnimationFrame(frame); }

  function maybeAutoRefresh(t) {
    var camc = currentCamera();
    if (!camc || !built) return;
    var moved = camc.cx !== built.cx || camc.cy !== built.cy || camc.cz !== built.cz;
    if (!moved) { autoAt = 0; return; }
    if (!autoAt) { autoAt = t + AUTO_DEBOUNCE_MS; return; } // still moving: wait for it to settle
    if (t >= autoAt) rebuild();                             // settled: rebuild, camera preserved
  }

  // ---- status / slab chrome -------------------------------------------------------------------
  function summary(mesh) {
    var parts = [];
    if (field) {
      parts.push("z " + field.zBot + "–" + field.zTop +
        " (" + field.zDown + " at/below · " + field.zUp + " above)");
      parts.push(field.dimX + "×" + field.dimY + (field.degraded ? " (capped)" : ""));
      parts.push(field.count.toLocaleString() + " voxels");
    }
    if (mesh) parts.push(mesh.faceCount.toLocaleString() + " faces");
    parts.push("built in " + lastBuildMs + "ms (max step " + maxStepMs.toFixed(1) + "ms)");
    return parts.join("  ·  ");
  }
  function setStatus(s) { if (statusEl) statusEl.textContent = s; }

  // The live slab readout on the header. A button that CANNOT do anything (at the world's floor or
  // ceiling, or at the layer cap) is DISABLED rather than silently no-op'ing -- the affordance tells
  // the truth about the world's real z bounds.
  function renderSlabUI() {
    if (!slabEl || !slab) return;
    var camc = currentCamera();
    var cz = camc ? camc.cz : 0, wz = worldZ();
    var upEl = slabEl.querySelector("[data-world3d-up-count]");
    var downEl = slabEl.querySelector("[data-world3d-down-count]");
    if (upEl) upEl.textContent = String(slab.up);
    if (downEl) downEl.textContent = String(slab.down);
    var can = {
      "world3d-up-inc": Model.slab.addAbove(slab, cz, wz),
      "world3d-up-dec": Model.slab.removeAbove(slab, cz, wz),
      "world3d-down-inc": Model.slab.addBelow(slab, cz, wz),
      "world3d-down-dec": Model.slab.removeBelow(slab, cz, wz),
    };
    Object.keys(can).forEach(function (k) {
      var b = slabEl.querySelector("[data-" + k + "]");
      if (b) b.disabled = Model.slab.equals(slab, can[k]);
    });
  }

  // Apply a slab mutation (from a button or a key). A no-op at a bound does NOT trigger a rebuild.
  function applySlab(fn) {
    var camc = currentCamera();
    if (!camc || !slab) return;
    var next = fn(slab, camc.cz, worldZ());
    if (Model.slab.equals(slab, next)) { renderSlabUI(); return; }
    slab = next;
    rebuild();
  }

  // ---- input ----------------------------------------------------------------------------------
  // left = orbit, right/Shift = pan, middle/Ctrl = drag-zoom. Wheel = zoom.
  function onPointerDown(e) {
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    var mode = "orbit";
    if (e.button === 1 || e.ctrlKey) mode = "zoom";
    else if (e.button === 2 || e.shiftKey) mode = "pan";
    drag = { mode: mode, x: e.clientX, y: e.clientY };
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!drag || !goal) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.mode === "orbit") Model.cam.orbit(goal, dx, dy);
    else if (drag.mode === "pan") Model.cam.pan(goal, dx, dy);
    else Model.cam.dragZoom(goal, dy);
    needsRender = true;
  }
  function onPointerUp(e) { drag = null; if (canvas.releasePointerCapture) try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} }
  function onWheel(e) {
    if (!goal) return;
    Model.cam.zoom(goal, e.deltaY > 0 ? 1 : -1);
    needsRender = true;
    e.preventDefault();
    e.stopPropagation();
  }

  function onKey(e) {
    if (!open || !goal) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return; // never hijack browser shortcuts
    var handled = true;
    switch (e.key) {
      case "Escape": close(); break;
      case "r": case "R": rebuild(); break;
      case "f": case "F": rebuild({ frame: true }); break;
      // z-slab: e/c mirror DF's own CURSOR_UP_Z / CURSOR_DOWN_Z, so "add a layer above / below"
      // lands on the keys the 2D client already trains; q/z remove the layer the same side added.
      case "e": case "E": applySlab(Model.slab.addAbove); break;
      case "q": case "Q": applySlab(Model.slab.removeAbove); break;
      case "c": case "C": applySlab(Model.slab.addBelow); break;
      case "z": case "Z": applySlab(Model.slab.removeBelow); break;
      case "w": case "W": case "ArrowUp": Model.cam.walk(goal, 1, 0); break;
      case "s": case "S": case "ArrowDown": Model.cam.walk(goal, -1, 0); break;
      case "a": case "A": case "ArrowLeft": Model.cam.walk(goal, 0, -1); break;
      case "d": case "D": case "ArrowRight": Model.cam.walk(goal, 0, 1); break;
      default: handled = false;
    }
    if (handled) { needsRender = true; e.preventDefault(); e.stopPropagation(); }
  }

  // ---- chrome ---------------------------------------------------------------------------------
  // Built through the shared DWFUI factories (headerHtml + plaqueBtnHtml) so the 3D chrome inherits
  // the native panel head/close/plaque markup instead of copying it -- the ui-drift guard (R2)
  // enforces exactly this. DWFUI loads before this file in index.html.
  function slabToolsHtml(C) {
    function btn(name, label, title) {
      var key = name.replace(/-([a-z])/g, function (_, ch) { return ch.toUpperCase(); });
      var ds = {}; ds[key] = "";
      return C.plaqueBtnHtml({ label: label, cls: "world3d-step", dataset: ds, title: title });
    }
    return '<span class="world3d-slab">' +
      '<span class="world3d-slab-lbl">Above</span>' +
      btn("world3d-up-dec", "−", "Remove a layer above the camera (Q)") +
      '<span class="world3d-slab-n" data-world3d-up-count>0</span>' +
      btn("world3d-up-inc", "+", "Add a layer above the camera (E)") +
      '<span class="world3d-slab-lbl">Below</span>' +
      btn("world3d-down-dec", "−", "Remove a layer below the camera (Z)") +
      '<span class="world3d-slab-n" data-world3d-down-count>20</span>' +
      btn("world3d-down-inc", "+", "Add a layer below the camera (C)") +
      "</span>";
  }

  function headHtml() {
    var C = root.DWFUI;
    if (C && C.headerHtml && C.plaqueBtnHtml) {
      var tools = slabToolsHtml(C) +
        C.plaqueBtnHtml({
          label: "Fit", cls: "world3d-fit",
          dataset: { world3dFit: "" }, title: "Re-frame the whole slab (F)",
        }) +
        C.plaqueBtnHtml({
          label: "Refresh", cls: "world3d-refresh",
          dataset: { world3dRefresh: "" }, title: "Rebuild from the current world state (R)",
        });
      return C.headerHtml({
        cls: "world3d-head", title: "3D world viewer", tools: tools,
        close: { data: "world3d-close", title: "Close (Esc)" },
      });
    }
    // Minimal non-DWFUI fallback (no shared classes, so no drift): only reached if the component
    // layer somehow failed to load.
    return '<div class="world3d-head"><div class="world3d-title">3D world viewer</div>' +
      '<button class="world3d-btn" data-world3d-refresh title="Rebuild (R)">Refresh</button>' +
      '<button class="world3d-btn" data-world3d-close title="Close (Esc)">&#10005;</button></div>';
  }

  var HINT = "drag: orbit · right-drag: pan · middle-drag / wheel: zoom · " +
    "WASD: move · E/Q: layer above · C/Z: layer below · F: fit · R: refresh · Esc: close";

  // B237: the two readouts. DWFUI.statusHtml is the shared component for exactly this ("transient
  // HUD notices ... compact state badges") and, deliberately, it draws NO frame of its own -- the
  // frame belongs to the outermost owner, which here is .world3d-status / .world3d-hint.
  // The copy is written from JS (setStatus / the HINT constant), so the component is handed an EMPTY
  // text slot through the declared bitmap-text escape hatch rather than a silently-plain string.
  var LIVE_TEXT = "the copy is rewritten from JS on every frame of a chunked build; re-assembling a " +
    "bitmap-atlas string 60x a second is not what the glyph layer is for";
  function readoutHtml(C) {
    // No DWFUI => no readouts. This viewer does not carry a hand-rolled copy of the component's
    // markup: copying `.dwfui-status` structure is precisely the drift the R2 guard exists to stop.
    if (!C || !C.statusHtml || !C.rawHtml) return "";
    return C.statusHtml({
      cls: "world3d-status", dataset: { world3dStatus: "" }, live: "polite",
      textHtml: root.DWFUI.rawHtml(LIVE_TEXT, ""),
    }) + C.statusHtml({
      cls: "world3d-hint", tone: "dim", dataset: { world3dHint: "" },
      textHtml: root.DWFUI.rawHtml(LIVE_TEXT, ""),
    });
  }

  function ensureEl() {
    if (el) return el;
    var C = root.DWFUI;
    el = doc.createElement("div");
    el.id = "world3dScreen";
    // ONE top-anchored chrome column: header, then the readouts. Nothing the viewer owns is docked
    // to the bottom of the screen -- see the B237 note in dwf.css.
    el.innerHTML =
      '<canvas id="world3dCanvas"></canvas>' +
      '<div class="world3d-chrome">' +
        headHtml() +
        '<div class="world3d-readouts">' + readoutHtml(C) + '</div>' +
      '</div>' +
      '<div id="world3dFallback" class="world3d-fallback" hidden></div>';
    doc.body.appendChild(el);
    canvas = el.querySelector("#world3dCanvas");
    statusEl = copyOf(el.querySelector("[data-world3d-status]"));
    hintEl = copyOf(el.querySelector("[data-world3d-hint]"));
    slabEl = el.querySelector(".world3d-slab");
    if (hintEl) hintEl.textContent = HINT;

    on("[data-world3d-close]", function () { close(); });
    on("[data-world3d-refresh]", function () { rebuild(); });
    on("[data-world3d-fit]", function () { rebuild({ frame: true }); });
    on("[data-world3d-up-inc]", function () { applySlab(Model.slab.addAbove); });
    on("[data-world3d-up-dec]", function () { applySlab(Model.slab.removeAbove); });
    on("[data-world3d-down-inc]", function () { applySlab(Model.slab.addBelow); });
    on("[data-world3d-down-dec]", function () { applySlab(Model.slab.removeBelow); });

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); }); // right-drag pans
    return el;
  }
  // The writable text node of a DWFUI status: the component owns the box, we own the copy.
  function copyOf(node) { return node ? (node.querySelector(".dwfui-status-copy") || node) : null; }

  // Wire a control, and complain LOUDLY if it is missing: a silently-absent button is precisely the
  // failure mode this reopen exists to kill.
  function on(sel, fn) {
    var node = el.querySelector(sel);
    if (!node) { try { root.console.warn("world3d: control not found: " + sel); } catch (_) {} return; }
    node.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
  }

  // ---- open / close ---------------------------------------------------------------------------
  // B237: enter/leave the MODE. One class on <body>; the CSS does the rest (see the `body.world3d-mode`
  // block in dwf.css). The viewer NEVER writes to another module's element -- no style, no
  // class, no `hidden` -- so leaving the mode restores the 2D client exactly as it was, with no
  // suppressed-but-still-hit-testable pane left behind.
  function setMode(enter) {
    try { doc.body.classList[enter ? "add" : "remove"]("world3d-mode"); } catch (_) {}
  }

  function open3D() {
    if (!loaded()) return;
    ensureEl();
    el.classList.add("open");
    setMode(true);
    open = true;
    var fb = el.querySelector("#world3dFallback");
    if (!gl) {
      try { initGL(); }
      catch (e) {
        fb.hidden = false;
        fb.textContent = "3D view unavailable: " + (e && e.message ? e.message : "WebGL2 not supported by this browser.");
        return;
      }
    }
    fb.hidden = true;
    if (!slab) slab = Model.slab.create();
    if (!goal) goal = Model.cam.create();
    lastFrameMs = 0;
    rebuild({ frame: true }); // first open: frame the fort. Later rebuilds preserve the camera.
    scheduleFrame();
  }

  function close() {
    open = false;
    if (el) el.classList.remove("open");
    setMode(false); // the 2D chrome comes back, untouched and hit-testable

    if (rafId) { root.cancelAnimationFrame(rafId); rafId = 0; }
    builder = null;
    drag = null;
    try { doc.getElementById("view") && doc.getElementById("view").focus({ preventScroll: true }); } catch (_) {}
  }

  function isOpen() { return open; }

  // Global hotkey (Shift+V = 3D Voxel view). While OPEN this owns the keyboard; while closed it
  // touches nothing but its own opener. NOTE: the keys the 2D client claims in the CAPTURE phase
  // (core.js's WASD/E/C, and its wheel) can only be released by core.js YIELDING while we are open --
  // see RC-2 in the banner. This listener alone is NOT enough, and assuming otherwise is what
  // shipped broken.
  doc.addEventListener("keydown", function (e) {
    if (open) { onKey(e); return; }
    var tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
    if (e.key === "V" && e.shiftKey) { open3D(); e.preventDefault(); }
  });
  doc.addEventListener("visibilitychange", function () { if (open && !doc.hidden) { needsRender = true; lastFrameMs = 0; scheduleFrame(); } });
  root.addEventListener("resize", function () { if (open) { needsRender = true; } });

  // Toolbar affordance: wire the topbar button if present (index.html #world3dBtn).
  function wireToolbar() {
    var btn = doc.getElementById("world3dBtn");
    if (btn && !btn.__w3d) { btn.__w3d = 1; btn.addEventListener("click", open3D); }
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", wireToolbar);
  else wireToolbar();

  root.DFWorld3D = { open: open3D, close: close, isOpen: isOpen, rebuild: rebuild };
})(typeof window !== "undefined" ? window : this);
