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
  // Places grid space in the world, scaling by (sx,sy,sz) first -- used to exaggerate z (Z_SCALE).
  function mScaleTranslate(sx, sy, sz, x, y, z) {
    return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
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
  var VERT_SRC =
    "#version 300 es\n" +
    "layout(location=0) in vec3 a_pos;\n" +
    "layout(location=1) in vec3 a_normal;\n" +
    "layout(location=2) in vec3 a_color;\n" +
    "layout(location=3) in float a_cell;\n" +
    "layout(location=4) in float a_flags;\n" +
    "layout(location=5) in float a_layer;\n" +
    "layout(location=6) in float a_sliceRole;\n" +
    "uniform mat4 u_mvp;\n" +
    "flat out vec3 v_normal;\n" +
    "flat out vec3 v_color;\n" +
    "flat out float v_sprite;\n" +
    "flat out float v_layer;\n" +
    "flat out float v_sliceRole;\n" +
    "out vec3 v_uvp;\n" +
    "void main(){\n" +
    "  gl_Position = u_mvp * vec4(a_pos, 1.0);\n" +
    "  v_normal = vec3(a_normal.x, -a_normal.y, a_normal.z);\n" +
    "  v_color = a_color;\n" +
    "  v_sprite = a_cell > 0.5 ? 1.0 : 0.0;\n" +
    "  v_layer = a_layer;\n" +
    "  v_sliceRole = a_sliceRole;\n" +
    "  int fl = int(a_flags + 0.5);\n" +
    "  int k = gl_VertexID % 6;\n" +
    "  vec2 corner = vec2(float(k==1||k==2||k==4), float(k==2||k==4||k==5));\n" +
    // A side face needs two per-vertex corrections from the mesh stage: FLAG_SWAPUV (the Y faces step
    // vertically first), then FLAG_FLIPV. That order is what DFVoxelMesh.sideFaceCornerUV() applies.
    "  if ((fl & 4) != 0) corner = corner.yx;\n" +
    "  if ((fl & 2) != 0) corner.y = 1.0 - corner.y;\n" +
    "  float page = floor(a_cell / 3600.0);\n" +
    "  float local = a_cell - page * 3600.0;\n" +
    "  vec2 originPx = vec2(mod(local, 60.0), floor(local / 60.0)) * 34.0 + 1.0;\n" +
    "  v_uvp = vec3((originPx + corner * 32.0) / 2048.0, page);\n" +
    "}\n";
  var FRAG_SRC =
    "#version 300 es\n" +
    "precision highp float;\n" +
    "precision highp sampler2DArray;\n" +
    "flat in vec3 v_normal;\n" +
    "flat in vec3 v_color;\n" +
    "flat in float v_sprite;\n" +
    "flat in float v_layer;\n" +
    "flat in float v_sliceRole;\n" +
    "in vec3 v_uvp;\n" +
    "uniform vec3 u_lightDir;\n" +   // pre-normalized, pointing FROM surface TO light
    "uniform float u_ambient;\n" +
    "uniform sampler2DArray u_atlas;\n" +
    "uniform float u_hasAtlas;\n" +  // 0 = no atlas bound: a pure flat-colour renderer, as before
    "uniform float u_zBot;\n" +
    "uniform float u_zTop;\n" +
    "out vec4 o;\n" +
    // Every voxel face is opaque: water and magma already carry the 2D renderer's depth-aware colour.
    "void main(){\n" +
    "  if (v_layer < u_zBot - 0.5 || v_layer > u_zTop + 0.5) discard;\n" +
    "  if (v_sliceRole > 0.5 && v_sliceRole < 1.5 && abs(v_layer - u_zTop) > 0.5) discard;\n" +
    "  if (v_sliceRole > 1.5 && abs(v_layer - u_zBot) > 0.5) discard;\n" +
    "  vec3 base = v_color;\n" +
    // Atlas texels are PREMULTIPLIED, so a sprite composites over the tile's flat material colour as
    // src + dst*(1-a): DF's near-transparent floor detail reads as detail, not as a hole.
    "  if (v_sprite > 0.5 && u_hasAtlas > 0.5) {\n" +
    "    vec4 s = texture(u_atlas, v_uvp);\n" +
    "    base = s.rgb + v_color * (1.0 - s.a);\n" +
    "  }\n" +
    "  float d = max(dot(normalize(v_normal), u_lightDir), 0.0);\n" +
    "  vec3 lit = base * (u_ambient + (1.0 - u_ambient) * d);\n" +
    "  o = vec4(lit, 1.0);\n" +
    "}\n";

  // ---- module state ---------------------------------------------------------------------------
  var el = null, canvas = null, statusEl = null, hintEl = null, slabEl = null, bgEl = null;
  var presetEl = null, noteEl = null, zsliderEl = null;
  var slabNote = "";     // why the last z-range request could not be honoured in full ("" = it was)
  var gl = null, program = null, vao = null, vboPos = null, vboNorm = null, vboColor = null;
  var vboCell = null, vboFlags = null, vboLayer = null, vboSliceRole = null;
  var markerVao = null, markerBuffers = null, markerVertCount = 0, markerSignature = "";
  var uni = null;
  // This viewer's OWN atlas: a GL texture cannot be shared across contexts, so the ground sheets are
  // packed a second time, small. null -> the shader's u_hasAtlas is 0 and every face draws flat.
  var atlas = null;
  var atlasDirtyAt = 0;     // debounce deadline for a re-resolve after a sheet lands (0 = none)
  var GROUND_ATLAS_PAGES = 4;   // 4 x 2048^2 x RGBA = 67 MB, 14,400 cells -- ample for floor sheets
  var ATLAS_DEBOUNCE_MS = 250;  // sheets land in bursts during boot; coalesce them into one rebuild
  var CACHE_DIRTY_DEBOUNCE_MS = 100;
  var open = false;
  var rafId = 0;
  var needsRender = true;
  var vertCount = 0;
  var currentMesh = null;
  var field = null;        // the field the CURRENT mesh was built from (what draw() positions by)
  var pending = null;      // a finished field whose mesh is still building (swapped in at the end)
  var voxBuilder = null;   // in-flight chunked VOXEL builder (or null when idle)
  var builder = null;      // in-flight chunked MESH builder (or null when idle)
  var pendingFrame = false; // this rebuild should re-frame the camera once it completes
  var buildNote = "";      // what the content budget had to leave out ("" = nothing)
  var scanChunks = 0;       // sparse-scan cost readout
  var buildStartMs = 0;
  var lastBuildMs = 0;
  var lastFrameMs = 0;
  var maxStepMs = 0;       // PERF: worst single main-thread build step of this rebuild
  var built = null;        // the {cx,cy,cz,up,down} the CURRENT mesh was built for
  var buildMode = "resident";
  var residentRejected = false;
  var cacheDirtyAt = 0;
  var unsubscribeDirty = null;
  var autoAt = 0;          // debounce deadline for auto-refresh (0 = nothing pending)
  var drag = null;         // {mode:'orbit'|'pan'|'zoom', x, y}

  // Camera: `goal` is what input writes; `cur` is the smoothed camera actually rendered.
  var goal = null, cur = null, slab = null;

  var BG_PRESETS = [
    { id: "onyx", label: "Onyx", rgb: [0.055, 0.05, 0.04] },
    { id: "warm", label: "Warm gray", rgb: [0.24, 0.22, 0.19] },
    { id: "slate", label: "Slate", rgb: [0.14, 0.16, 0.19] },
    { id: "stone", label: "Stone", rgb: [0.32, 0.30, 0.27] },
    { id: "sky", label: "Sky", rgb: [0.55, 0.63, 0.72] },
    { id: "white", label: "White", rgb: [0.92, 0.92, 0.90] },
  ];
  var BG_DEFAULT_ID = "warm";
  var BG_STORE_KEY = "dwf.world3d.bgColor";
  var DwfUtil = root.DwfUtil || (typeof module !== "undefined" && module.require ? module.require("./dwf-util.js") : null);
  var lsGet = DwfUtil.lsGet, lsSet = DwfUtil.lsSet;
  function bgPreset(id) {
    for (var i = 0; i < BG_PRESETS.length; i++) if (BG_PRESETS[i].id === id) return BG_PRESETS[i];
    return null;
  }
  var bgSaved = lsGet(BG_STORE_KEY);
  var bgId = bgPreset(bgSaved) ? bgSaved : BG_DEFAULT_ID;
  var BG_COLOR = bgPreset(bgId).rgb;
  var LIGHT_DIR = vNorm([0.5, 0.35, 0.8]);
  var BUILD_BUDGET_MS = 6;   // PERF: main-thread ceiling per FRAME for meshing (< half a 60fps frame)
  var AUTO_DEBOUNCE_MS = 400;
  // A DISPLAY-ONLY exaggeration of the z axis so adjacent layers stay legible; the pure voxelizer and
  // mesh data never see it. Applied to the model matrix AND the camera (stretchZ), so they agree.
  var Z_SCALE = 1.5;

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
      lightDir: gl.getUniformLocation(program, "u_lightDir"),
      ambient: gl.getUniformLocation(program, "u_ambient"),
      atlas: gl.getUniformLocation(program, "u_atlas"),
      hasAtlas: gl.getUniformLocation(program, "u_hasAtlas"),
      zBot: gl.getUniformLocation(program, "u_zBot"),
      zTop: gl.getUniformLocation(program, "u_zTop"),
    };
    vao = gl.createVertexArray();
    vboPos = gl.createBuffer(); vboNorm = gl.createBuffer(); vboColor = gl.createBuffer();
    vboCell = gl.createBuffer(); vboFlags = gl.createBuffer();
    vboLayer = gl.createBuffer(); vboSliceRole = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboPos); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboNorm); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboColor); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    // The atlas cell index as an UNNORMALIZED float attribute: 1234 arrives at the shader as 1234.0.
    gl.bindBuffer(gl.ARRAY_BUFFER, vboCell); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.UNSIGNED_SHORT, false, 0, 0);
    // Per-vertex side-UV flags, unnormalized, so the shader's integer mask reads the bit values directly.
    gl.bindBuffer(gl.ARRAY_BUFFER, vboFlags); gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboLayer); gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.UNSIGNED_SHORT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboSliceRole); gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.bindVertexArray(null);
    markerVao = gl.createVertexArray();
    markerBuffers = [];
    gl.bindVertexArray(markerVao);
    var markerAttribs = [
      [3, gl.FLOAT, false], [3, gl.FLOAT, false], [3, gl.UNSIGNED_BYTE, true],
      [1, gl.UNSIGNED_SHORT, false], [1, gl.UNSIGNED_BYTE, false],
      [1, gl.UNSIGNED_SHORT, false], [1, gl.UNSIGNED_BYTE, false],
    ];
    for (var ai = 0; ai < markerAttribs.length; ai++) {
      var ab = gl.createBuffer(); markerBuffers.push(ab);
      gl.bindBuffer(gl.ARRAY_BUFFER, ab); gl.enableVertexAttribArray(ai);
      gl.vertexAttribPointer(ai, markerAttribs[ai][0], markerAttribs[ai][1],
        markerAttribs[ai][2], 0, 0);
    }
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CW);
    initAtlas();
    // clearColor is re-applied every frame in draw(): BG_COLOR can change live from the picker.
  }

  function initAtlas() {
    atlas = null;
    if (!root.DwfGLAtlas || typeof root.DwfGLAtlas.createForGL !== "function") return;
    try {
      atlas = root.DwfGLAtlas.createForGL(gl, { maxPages: GROUND_ATLAS_PAGES });
      atlas.onSheetReady(function () { atlasDirtyAt = now() + ATLAS_DEBOUNCE_MS; });
    } catch { atlas = null; }
  }

  function uploadMesh(mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, vboPos); gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboNorm); gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboColor); gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboCell); gl.bufferData(gl.ARRAY_BUFFER, mesh.cells, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboFlags);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.flags || new Uint8Array(mesh.vertCount), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboLayer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.layers || new Uint16Array(mesh.vertCount), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboSliceRole);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.sliceRoles || new Uint8Array(mesh.vertCount), gl.STATIC_DRAW);
    vertCount = mesh.vertCount;
    currentMesh = mesh;
    needsRender = true;
  }

  function uploadMarkers(mesh) {
    if (!markerBuffers) return;
    var arrays = [mesh.positions, mesh.normals, mesh.colors, mesh.cells, mesh.flags,
      mesh.layers, mesh.sliceRoles];
    for (var i = 0; i < markerBuffers.length; i++) {
      gl.bindBuffer(gl.ARRAY_BUFFER, markerBuffers[i]);
      gl.bufferData(gl.ARRAY_BUFFER, arrays[i], gl.DYNAMIC_DRAW);
    }
    markerVertCount = mesh.vertCount;
    needsRender = true;
  }

  function syncMarkers(force) {
    if (!field) return;
    var world = currentMarkers();
    var sig = JSON.stringify(world);
    if (!force && sig === markerSignature) return;
    markerSignature = sig;
    var local = [];
    for (var i = 0; i < world.length; i++) {
      var m = world[i], x = m.x - field.ox, y = m.y - field.oy, z = m.z - field.oz;
      if (x < 0 || y < 0 || z < 0 || x >= field.dimX || y >= field.dimY || z >= field.dimZ) continue;
      local.push({ x: x, y: y, z: z, type: m.type, color: m.color, cell: m.cell });
    }
    field.markers = local;
    uploadMarkers(Mesh.buildMesh(field, { markersOnly: true, includeMarkers: true }));
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
    } catch { return null; }
    return null;
  }

  // The world's z-level count, for clamping the slab. 0 pre-hello_ack means "ceiling unknown".
  function worldZ() {
    try {
      var d = root.DwfCache && root.DwfCache.mapDims && root.DwfCache.mapDims();
      return (d && typeof d.z === "number" && d.z > 0) ? d.z : 0;
    } catch { return 0; }
  }

  // ---- the sparse scan ------------------------------------------------------------------------
  function makeWholeCandidate(cx, cy, zBot, zTop) {
    var cache = root.DwfCache;
    scanChunks = 0;
    if (!cache || typeof cache.forEachChunk !== "function" || typeof cache.tileAt !== "function") {
      return { cx: cx, cy: cy, boxW: 1, boxH: 1,
        source: function () { /* no cache: an empty world, honestly */ } };
    }
    if (typeof cache.requestAllKnownBlocks === "function") {
      try { cache.requestAllKnownBlocks(zBot, zTop); }
      catch (error) { DwfErr.report("world3d.request-known-blocks", error); }
    }
    var byZ = new Map(), minBx = null, maxBx = null, minBy = null, maxBy = null;
    try {
      cache.forEachChunk(function (z, chunk, key) {
        if (z < zBot || z > zTop || !chunk || !chunk.tt || !chunk.bits ||
            typeof key !== "number") return;
        var bx = Math.floor(key / 4096), by = key - bx * 4096;
        var a = byZ.get(z);
        if (!a) { a = []; byZ.set(z, a); }
        a.push({ chunk: chunk, bx: bx, by: by });
        if (minBx === null || bx < minBx) minBx = bx;
        if (maxBx === null || bx > maxBx) maxBx = bx;
        if (minBy === null || by < minBy) minBy = by;
        if (maxBy === null || by > maxBy) maxBy = by;
      });
    } catch { /* the successfully visited chunks remain the retained candidate */ }
    if (minBx === null) {
      minBx = maxBx = cx >> 4; minBy = maxBy = cy >> 4;
    }
    var ox = minBx << 4, oy = minBy << 4;
    var boxW = (maxBx - minBx + 1) << 4, boxH = (maxBy - minBy + 1) << 4;
    var source = function (z, emit) {
      var chunks = byZ.get(z) || [];
      for (var i = 0; i < chunks.length; i++) source.processChunk(z, chunks[i], emit);
    };
    source.chunksAt = function (z) { return byZ.get(z) || []; };
    source.processChunk = function (z, rec, emit) {
      var chunk = rec.chunk, tt = chunk.tt, bits = chunk.bits;
      scanChunks++;
      var baseX = rec.bx << 4, baseY = rec.by << 4;
      var n = Math.min(tt.length, bits.length);
      for (var i = 0; i < n; i++) {
        if (!Vox.isCandidateSlot(tt[i], bits[i])) continue;
        var wx = baseX + (i & 15), wy = baseY + (i >> 4), t;
        try { t = cache.tileAt(z, wx, wy); } catch { t = null; }
        if (t && typeof Vox.withOwnLiquid === "function") t = Vox.withOwnLiquid(t, bits[i]);
        if (t) emit(wx, wy, t);
      }
    };
    return {
      cx: ox + (boxW >> 1), cy: oy + (boxH >> 1),
      boxW: boxW, boxH: boxH, source: source,
    };
  }

  function makeColorFn() {
    var T = root.DwfTiles;
    var fn = (T && typeof T.voxelColor === "function") ? T.voxelColor
      : (T && typeof T.tileColor === "function") ? function (t) { return T.tileColor(t, true); }
      : null;
    if (!fn) return function () { return null; };
    return function (t) { try { return fn(t); } catch { return null; } };
  }

  function atlasCell(ref) {
    if (!atlas || !ref) return 0;
    try {
      if (ref.dynamicKey && ref.url && typeof atlas.registerDynamicSheet === "function") {
        return atlas.registerDynamicSheet(ref.dynamicKey, ref.url) ? (atlas.resolve(ref.dynamicKey, 0, 0) | 0) : 0;
      }
      return ref.sheet ? (atlas.resolve(ref.sheet, ref.col, ref.row) | 0) : 0;
    } catch { return 0; }
  }

  // Markers reuse the 2D renderer's renderer-neutral refs; an unresolved entity keeps a smaller marker.
  function currentMarkers() {
    var latest, out = [];
    try { latest = root.DwfTiles && root.DwfTiles.getLatest && root.DwfTiles.getLatest(); }
    catch { latest = null; }
    if (!latest) return out;
    var units = Array.isArray(latest.units) ? latest.units : [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u && typeof u.x === "number" && typeof u.y === "number" && typeof u.z === "number") {
        var uc = 0, refs;
        try { refs = root.DwfTiles.unitSpriteRefs ? root.DwfTiles.unitSpriteRefs(u) : []; }
        catch { refs = []; }
        for (var ur = 0; ur < refs.length && !uc; ur++) uc = atlasCell(refs[ur]);
        out.push({ x: u.x, y: u.y, z: u.z, type: "unit", cell: uc });
      }
    }
    var buildings = Array.isArray(latest.buildings) ? latest.buildings : [];
    for (var j = 0; j < buildings.length; j++) {
      var b = buildings[j];
      if (!b) continue;
      var x = typeof b.x === "number" ? b.x :
        (typeof b.x1 === "number" && typeof b.x2 === "number" ? Math.floor((b.x1 + b.x2) / 2) : null);
      var y = typeof b.y === "number" ? b.y :
        (typeof b.y1 === "number" && typeof b.y2 === "number" ? Math.floor((b.y1 + b.y2) / 2) : null);
      var z = typeof b.z === "number" ? b.z : b.z1;
      if (typeof x === "number" && typeof y === "number" && typeof z === "number") {
        var bc, bref;
        try { bref = root.DwfTiles.buildingSpriteRef ? root.DwfTiles.buildingSpriteRef(b) : null; }
        catch { bref = null; }
        bc = atlasCell(bref);
        out.push({ x: x, y: y, z: z, type: "building", cell: bc });
      }
    }
    return out;
  }

  // ---- ground sprites --------------------------------------------------------------------------
  var TREE_SHAPES = { TREE: 1, TRUNK_BRANCH: 1, BRANCH: 1, TWIG: 1 };
  var PLANT_SHAPES = { SAPLING: 1, SHRUB: 1 };
  function cellFn(t, wx, wy) {
    if (!atlas || !t) return 0;
    var ref = null;
    var shape = t.shape || "";
    try {
      if (TREE_SHAPES[shape] && typeof root.DwfTiles.treeSpriteRef === "function")
        ref = root.DwfTiles.treeSpriteRef(t, wx, wy);
      else if (PLANT_SHAPES[shape] && typeof root.DwfTiles.plantSpriteRef === "function")
        ref = root.DwfTiles.plantSpriteRef(t);
      else if (shape !== "WALL" && typeof root.DwfTiles.terrainSpriteRef === "function")
        ref = root.DwfTiles.terrainSpriteRef(t, wx, wy);
    } catch { return 0; }
    if (!ref) return 0;
    var c;
    try { c = atlas.resolve(ref.sheet, ref.col, ref.row); } catch { return 0; }
    return c > 0 ? c : 0;
  }

  // ---- wall side faces -------------------------------------------------------------------------
  function makeSideCellFn(f) {
    var cache = root.DwfCache;
    var Adj = root.DwfAdjacency;
    if (!atlas || !cache || !Adj || typeof cache.tileAt !== "function") return null;
    if (!root.DwfTiles || typeof root.DwfTiles.wallSpriteRef !== "function") return null;
    var lookup = null, lookupZ = null;
    return function (gx, gy, gz) {
      var wx = f.ox + gx, wy = f.oy + gy, wz = f.oz + gz;
      var t;
      try { t = cache.tileAt(wz, wx, wy); } catch { return 0; }
      if (!t) return 0;
      var shape = t.shape || "";
      if (shape !== "WALL") return cellFn(t, wx, wy);
      // One closure per z-plane rather than per call: the mesher walks a whole plane before moving on.
      if (lookupZ !== wz) {
        lookupZ = wz;
        lookup = function (x, y) { return cache.tileAt(lookupZ, x, y); };
      }
      var mask;
      try { mask = Adj.computeMask8(lookup, wx, wy, Adj.isOpenNeighbor); } catch { mask = 0; }
      var ref;
      try { ref = root.DwfTiles.wallSpriteRef(t, wx, wy, mask, wz); } catch { return 0; }
      if (!ref) return 0;
      var c;
      try { c = atlas.resolve(ref.sheet, ref.col, ref.row); } catch { return 0; }
      return c > 0 ? c : 0;
    };
  }

  // A ramp's slope is not on its own tile: DF reads it from the walls beside it. Answered at VOXELIZE
  // time because dwf-voxel-mesh.js countFaces() preallocates off the same field.rampDirs the emitter reads.
  function makeRampDirFn() {
    var cache = root.DwfCache;
    var Adj = root.DwfAdjacency;
    if (!cache || !Adj || typeof cache.tileAt !== "function") return null;
    // One closure per z-plane, as makeSideCellFn does: the walls steering a ramp are on its own level.
    var lookup = null, lookupZ = null;
    return function (wx, wy, wz) {
      if (lookupZ !== wz) {
        lookupZ = wz;
        lookup = function (x, y) { return cache.tileAt(lookupZ, x, y); };
      }
      try { return Adj.computeMask8(lookup, wx, wy, Adj.isJoiningWall) | 0; } catch { return 0; }
    };
  }

  function startBuild(range, mode, opts) {
    if (!loaded() || !gl) return;
    var o = opts || {};
    var camc = currentCamera();
    if (!camc) { setStatus("No live camera yet -- open the map first, then Refresh."); return; }

    if (voxBuilder) voxBuilder.cancel();
    voxBuilder = null; builder = null; pending = null;

    slab = Model.slab.clamp(slab || Model.slab.create(), camc.cz, worldZ());
    var whole = makeWholeCandidate(camc.cx, camc.cy, range.zBot, range.zTop);

    var scanCz = Math.max(range.zBot, Math.min(range.zTop, camc.cz));
    voxBuilder = Vox.createVoxelBuilder({
      eachCandidate: whole.source,
      colorFn: makeColorFn(),
      cellFn: cellFn,
      rampDirFn: makeRampDirFn(),
      markers: currentMarkers(),
      cx: whole.cx, cy: whole.cy, cz: scanCz,
      boxW: whole.boxW, boxH: whole.boxH,
      zDown: scanCz - range.zBot + 1, zUp: range.zTop - scanCz,
    });
    pendingFrame = !!o.frame || !cur;
    buildMode = mode;
    built = { cx: camc.cx, cy: camc.cy, cz: camc.cz, wz: worldZ() };
    autoAt = 0;
    atlasDirtyAt = 0;   // this build resolves against the atlas as it stands right now
    buildStartMs = now();
    maxStepMs = 0;
    needsRender = true;
    renderSlabUI();
  }

  function rebuildWindowed(opts) {
    var camc = currentCamera();
    if (!camc) return;
    slab = Model.slab.clamp(slab || Model.slab.create(), camc.cz, worldZ());
    startBuild(Model.slab.range(slab, camc.cz), "windowed", opts);
  }

  function rebuildResident(opts) {
    var wz = worldZ();
    if (!wz) {
      setStatus("Waiting for world dimensions before building the resident 3D view.");
      return;
    }
    var camc = currentCamera();
    if (!camc) return;
    startBuild({ zBot: 0, zTop: wz - 1 }, "resident", opts);
  }

  // Genuine terrain changes enter here. Range controls use applyVisibleRange() and never call it.
  function rebuild(opts) {
    var o = opts || {};
    if (built && built.wz !== worldZ()) residentRejected = false;
    if (o.retryResident) residentRejected = false;
    if (residentRejected) rebuildWindowed(o); else rebuildResident(o);
  }

  function stepBuild(budgetMs) {
    if (!voxBuilder && !builder) return false;
    var start = now();
    do {
      var s0 = now(), more;
      if (voxBuilder) {
        more = voxBuilder.step();
        if (!more && voxBuilder.done()) {
          pending = voxBuilder.result();
          voxBuilder = null;
          if (buildMode === "resident" && pending.trimmed) {
            var wantFrame = pendingFrame;
            pending = null;
            residentRejected = true;
            buildNote = "whole-fort resident cache exceeds the 700,000-voxel guard; z changes rebuild the selected window";
            rebuildWindowed({ frame: wantFrame });
            return true;
          }
          builder = Mesh.createBuilder(pending, { slabZ: 1, sideCellFn: makeSideCellFn(pending),
            residentSlices: buildMode === "resident", includeMarkers: false });
        }
      } else {
        more = builder.step();
        if (!more && builder.done()) {
          var mesh = builder.result();
          builder = null;
          field = pending; pending = null;
          if (pendingFrame) {
            goal = Model.cam.frame(goal || Model.cam.create(), field, Z_SCALE);
            cur = Model.cam.copy(goal);
            pendingFrame = false;
          }
          uploadMesh(mesh);
          syncMarkers(true);
          lastBuildMs = Math.round(now() - buildStartMs);
          buildNote = residentRejected
            ? "whole-fort resident cache exceeds the 700,000-voxel guard; z changes rebuild the selected window"
            : field.trimmed
            ? ("content guard stopped after " + field.count.toLocaleString() +
              " voxels in this pathological world; narrow the z-range")
            : "";
          renderSlabUI();
          setStatus(summary(mesh));
          return false;
        }
      }
      var stepMs = now() - s0;
      if (stepMs > maxStepMs) maxStepMs = stepMs;
    } while ((voxBuilder || builder) && (now() - start) < budgetMs);
    if (voxBuilder || builder) setStatus("Building view… " + Math.round(buildProgress() * 100) + "%");
    return true;
  }
  // Honest two-stage progress: voxelizing is the first half, meshing the second.
  function buildProgress() {
    if (voxBuilder) return 0.5 * voxBuilder.progress();
    if (builder) return 0.5 + 0.5 * builder.progress();
    return 1;
  }

  // ---- render ---------------------------------------------------------------------------------
  function resize() {
    if (!canvas) return;
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; needsRender = true; }
  }

  // Stretch a world point's z by Z_SCALE, anchored at oz -- the same map the model matrix applies.
  function stretchZ(p, oz) { return [p[0], p[1], oz + (p[2] - oz) * Z_SCALE]; }

  function draw() {
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(BG_COLOR[0], BG_COLOR[1], BG_COLOR[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!vertCount || !field || !cur) return;
    var aspect = canvas.width / Math.max(1, canvas.height);
    var proj = mPerspective(50 * Math.PI / 180, aspect, 0.5, 6000);
    var model = mScaleTranslate(1, -1, Z_SCALE, field.ox, -field.oy, field.oz); // DF +Y is screen-down; render space is right-handed
    var view = mLookAt(stretchZ(Model.cam.eye(cur), field.oz), stretchZ(cur.target, field.oz), [0, 0, 1]);
    var mv = mMul(view, model);
    gl.useProgram(program);
    gl.uniformMatrix4fv(uni.mvp, false, mMul(proj, mv));
    gl.uniform3fv(uni.lightDir, LIGHT_DIR);
    gl.uniform1f(uni.ambient, 0.35);
    var liveCamera = currentCamera();
    var visible = Model.slab.range(slab, liveCamera ? liveCamera.cz : (built ? built.cz : 0));
    gl.uniform1f(uni.zBot, visible.zBot);
    gl.uniform1f(uni.zTop, visible.zTop);
    // Bind this viewer's own atlas on unit 0; no atlas -> u_hasAtlas 0 and the shader draws flat colours.
    var tex = null;
    if (atlas) { try { tex = atlas.getTexture(); } catch { tex = null; } }
    if (tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.uniform1i(uni.atlas, 0);
    }
    gl.uniform1f(uni.hasAtlas, tex ? 1 : 0);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, vertCount);
    if (markerVertCount) {
      gl.bindVertexArray(markerVao);
      gl.drawArrays(gl.TRIANGLES, 0, markerVertCount);
    }
    gl.bindVertexArray(null);
  }

  function frame() {
    rafId = 0;
    if (!open) return;
    if (doc.hidden) { scheduleFrame(); return; } // paused: keep the loop alive but do no GL work

    var t = now();
    var dt = lastFrameMs ? Math.min(100, t - lastFrameMs) : 16;
    lastFrameMs = t;

    if (voxBuilder || builder) { stepBuild(BUILD_BUDGET_MS); needsRender = true; }

    // Camera smoothing: a pure exponential decay toward the goal -- calm, and it cannot overshoot.
    if (cur && goal && !Model.cam.settled(cur, goal)) {
      Model.cam.smooth(cur, goal, dt);
      needsRender = true;
    }

    // Genuine data/atlas changes rebuild only while the pipeline is idle; range inputs already applied.
    if (!builder && !voxBuilder && !maybeReresolveSprites(t) && !maybeCacheDirty(t))
      maybeAutoRefresh(t);
    if (!builder && !voxBuilder) syncMarkers(false);

    if (needsRender) {
      needsRender = false;
      try { draw(); } catch { /* retained GPU state stays visible until the next requested frame */ }
    }
    scheduleFrame();
  }
  function scheduleFrame() { if (open && !rafId) rafId = root.requestAnimationFrame(frame); }

  function maybeReresolveSprites(t) {
    if (!atlasDirtyAt || t < atlasDirtyAt) return false;
    atlasDirtyAt = 0;
    rebuild();
    return true;
  }

  function maybeCacheDirty(t) {
    if (!cacheDirtyAt || t < cacheDirtyAt) return false;
    cacheDirtyAt = 0;
    rebuild();
    return true;
  }

  function maybeAutoRefresh(t) {
    var camc = currentCamera();
    if (!camc || !built) return;
    if (buildMode === "resident") {
      if (camc.cz !== built.cz) {
        slab = Model.slab.clamp(slab || Model.slab.create(), camc.cz, worldZ());
        built.cz = camc.cz;
        applyVisibleRange();
      }
      built.cx = camc.cx; built.cy = camc.cy;
      autoAt = 0;
      return;
    }
    var moved = camc.cx !== built.cx || camc.cy !== built.cy || camc.cz !== built.cz;
    if (!moved) { autoAt = 0; return; }
    if (!autoAt) { autoAt = t + AUTO_DEBOUNCE_MS; return; } // still moving: wait for it to settle
    if (t >= autoAt) rebuild();                             // settled: rebuild, camera preserved
  }

  // ---- status / slab chrome -------------------------------------------------------------------
  function summary(mesh) {
    var parts = [];
    if (field) {
      var sc = currentCamera(), vr = sc ? Model.slab.range(slab, sc.cz)
        : { zBot: field.zBot, zTop: field.zTop };
      var inside = sc && sc.cz >= vr.zBot && sc.cz <= vr.zTop;
      parts.push("z " + vr.zBot + "\u2013" + vr.zTop + (inside
        ? " (" + (sc.cz - vr.zBot + 1) + " at/below \u00b7 " + (vr.zTop - sc.cz) + " above)"
        : " (" + (vr.zTop - vr.zBot + 1) + " layers)"));
      parts.push(field.dimX + "×" + field.dimY);
      parts.push(field.count.toLocaleString() + " voxels");
      if (field.markers && field.markers.length)
        parts.push(field.markers.length.toLocaleString() + " AUX markers");
      if (field.liquidCount) parts.push(field.liquidCount.toLocaleString() + " liquid");
      parts.push("scanned " + field.scanned.toLocaleString() + " of " +
        (field.dimX * field.dimY * field.dimZ).toLocaleString() + " cells in " +
        scanChunks.toLocaleString() + " cached chunks");
    }
    if (mesh) {
      parts.push(mesh.faceCount.toLocaleString() + " faces");
      if (mesh.spriteFaceCount) parts.push(mesh.spriteFaceCount.toLocaleString() + " sprite tops");
      if (mesh.sideSpriteFaceCount) parts.push(mesh.sideSpriteFaceCount.toLocaleString() + " sprite sides");
    }
    parts.push("built in " + lastBuildMs + "ms (max step " + maxStepMs.toFixed(1) + "ms)");
    return parts.join("  ·  ");
  }
  function setStatus(s) { if (statusEl) statusEl.textContent = s; }

  // ---- the fort's z-extent (fit-to-fort) -----------------------------------------------------------
  var FORT_TTL_MS = 4000;
  var fortAt = 0, fortVal = null, fortEver = false;
  function fortExtent() {
    var t = now();
    if (fortEver && (t - fortAt) < FORT_TTL_MS) return fortVal;
    var cache = root.DwfCache;
    var val = null;
    if (cache && typeof cache.forEachChunk === "function" && Vox && Vox.fortZExtent) {
      try { val = Vox.fortZExtent({ eachChunk: cache.forEachChunk }); } catch { val = null; }
    }
    fortAt = t; fortVal = val; fortEver = true;
    return val;
  }

  // A fit control that CANNOT do anything (no fort extent yet) is DISABLED, never a silent no-op.
  function renderSlabUI() {
    if (!slabEl || !slab) return;
    var camc = currentCamera();
    var cz = camc ? camc.cz : 0, wz = worldZ();
    var bounds = Model.slab.bounds(cz, wz);
    var r = Model.slab.range(slab, cz);

    // min/max BEFORE value: an input clamps a value it is given against the bounds it has.
    var lo = slabEl.querySelector("[data-world3d-zbot]");
    var hi = slabEl.querySelector("[data-world3d-ztop]");
    if (lo) { lo.min = String(bounds.zMin); lo.max = String(bounds.zMax); lo.value = String(r.zBot); }
    if (hi) { hi.min = String(bounds.zMin); hi.max = String(bounds.zMax); hi.value = String(r.zTop); }
    setRangeReadout(r.zBot, r.zTop);

    // Two things can need saying, ranked: what the REQUEST could not have, then what the BUILD left out.
    var note = slabNote || buildNote;
    if (noteEl) {
      if (root.DWFUI) root.DWFUI.setBitmapText(noteEl, note); else noteEl.textContent = note;
      noteEl.hidden = !note;
    }

    var fort = fortExtent();
    if (presetEl) {
      var chips = presetEl.querySelectorAll("[data-world3d-zpreset]");
      for (var i = 0; i < chips.length; i++) {
        var pr = Model.slab.presetRange(chips[i].getAttribute("data-world3d-zpreset"),
          { cz: cz, fort: fort });
        chips[i].disabled = !pr;
        // Mark the preset that IS the window now, compared against what it would ACTUALLY apply, so a
        // "Whole fort" the world's own bounds had to shorten still reads as in effect.
        var same = false;
        if (pr) {
          var applied = Model.slab.range(Model.slab.fromRange(pr.zBot, pr.zTop, cz, wz), cz);
          same = applied.zBot === r.zBot && applied.zTop === r.zTop;
        }
        chips[i].classList[same ? "add" : "remove"]("active");
        chips[i].setAttribute("aria-pressed", same ? "true" : "false");
      }
    }
    var fitLo = slabEl.querySelector("[data-world3d-fit-base]");
    var fitHi = slabEl.querySelector("[data-world3d-fit-top]");
    if (fitLo) fitLo.disabled = !fort;
    if (fitHi) fitHi.disabled = !fort;
  }

  // Split out because DRAGGING a handle previews the range live, and the preview writes here.
  function setRangeReadout(zBot, zTop) {
    var out = slabEl && slabEl.querySelector("[data-world3d-zread]");
    if (!out) return;
    var n = Math.abs(zTop - zBot) + 1;
    out.textContent = "z " + Math.min(zBot, zTop) + "–" + Math.max(zBot, zTop) +
      " · " + n + " layer" + (n === 1 ? "" : "s");
  }

  function applyRange(zBot, zTop) {
    var camc = currentCamera();
    if (!camc || !slab) return;
    var cz = camc.cz, wz = worldZ();
    var wantBot = Math.min(zBot, zTop), wantTop = Math.max(zBot, zTop);
    var next = Model.slab.fromRange(wantBot, wantTop, cz, wz);
    var got = Model.slab.range(next, cz);
    // Explicit input wins over camera containment; only the world's real bounds can shorten it.
    slabNote = (got.zBot === wantBot && got.zTop === wantTop) ? "" : "clamped to the world";
    if (Model.slab.equals(slab, next)) { renderSlabUI(); return; }
    slab = next;
    applyVisibleRange();
  }

  function applyVisibleRange() {
    renderSlabUI();
    needsRender = true;
    if (buildMode === "windowed") rebuildWindowed();
    else if (currentMesh) setStatus(summary(currentMesh));
  }

  function sliderRange() {
    var lo = slabEl && slabEl.querySelector("[data-world3d-zbot]");
    var hi = slabEl && slabEl.querySelector("[data-world3d-ztop]");
    if (!lo || !hi) return null;
    return { zBot: parseInt(lo.value, 10) || 0, zTop: parseInt(hi.value, 10) || 0 };
  }

  function onSliderPreview() {
    var r = sliderRange();
    if (!r) return;
    applyRange(r.zBot, r.zTop);
  }
  function onSliderCommit() {
    var r = sliderRange();
    if (r) applyRange(r.zBot, r.zTop);
  }

  // aim-bot/aim-top exist only for dwf-chrome.css, which reads them to make the LOSING thumb
  // click-through. With neither class set the later input in the DOM takes every press.
  function clearSliderAim() {
    if (!zsliderEl || !zsliderEl.classList) return;
    zsliderEl.classList.remove("aim-bot");
    zsliderEl.classList.remove("aim-top");
  }
  function onSliderAim(e) {
    if (!zsliderEl || !zsliderEl.classList || !zsliderEl.getBoundingClientRect) return;
    var lo = slabEl && slabEl.querySelector("[data-world3d-zbot]");
    var hi = slabEl && slabEl.querySelector("[data-world3d-ztop]");
    if (!lo || !hi) return;
    var box = zsliderEl.getBoundingClientRect();
    if (!box.width) return;
    var min = parseInt(lo.min, 10) || 0, max = parseInt(lo.max, 10) || 0;
    if (max <= min) return;
    var vBot = parseInt(lo.value, 10) || 0, vTop = parseInt(hi.value, 10) || 0;
    // Where the cursor is, in z. This only has to pick a winner, not place a value.
    var at = min + ((e.clientX - box.left) / box.width) * (max - min);
    var dBot = Math.abs(at - vBot), dTop = Math.abs(at - vTop);
    var wantBot = dBot < dTop || (dBot === dTop && at < vBot);
    zsliderEl.classList[wantBot ? "add" : "remove"]("aim-bot");
    zsliderEl.classList[wantBot ? "remove" : "add"]("aim-top");
  }

  function applyPreset(id) {
    var camc = currentCamera();
    if (!camc) return;
    var r = Model.slab.presetRange(id, { cz: camc.cz, fort: fortExtent() });
    if (r) applyRange(r.zBot, r.zTop);
  }
  // ---- per-edge steppers -----------------------------------------------------------------------
  function stepEdge(edge, delta) {
    var camc = currentCamera();
    if (!camc || !slab) return;
    var r = Model.slab.range(slab, camc.cz);
    if (edge === "base") applyRange(Math.min(r.zTop, r.zBot + delta), r.zTop);
    else applyRange(r.zBot, Math.max(r.zBot, r.zTop + delta));
  }

  // Snap ONE edge of the window to the fort, leaving the other where the player put it.
  function fitEdge(edge) {
    var fort = fortExtent(), camc = currentCamera();
    if (!fort || !camc || !slab) return;
    var r = Model.slab.range(slab, camc.cz);
    if (edge === "base") applyRange(fort.zBot, r.zTop);
    else applyRange(r.zBot, fort.zTop);
  }

  // Apply a slab mutation (from a key). A no-op at a bound does NOT trigger a rebuild.
  function applySlab(fn) {
    var camc = currentCamera();
    if (!camc || !slab) return;
    var next = fn(slab, camc.cz, worldZ());
    slabNote = "";
    if (Model.slab.equals(slab, next)) { renderSlabUI(); return; }
    slab = next;
    applyVisibleRange();
  }

  // Mark the current swatch `active`; DWFUI's artBtnHtml already styles an `.active` chip.
  function renderBgUI() {
    if (!bgEl) return;
    var nodes = bgEl.querySelectorAll("[data-world3d-bg-pick]");
    for (var i = 0; i < nodes.length; i++) {
      var isActive = nodes[i].getAttribute("data-world3d-bg-pick") === bgId;
      nodes[i].classList[isActive ? "add" : "remove"]("active");
      nodes[i].setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }

  // Pick a background preset: no rebuild needed (it never touches world data), just a redraw.
  function setBg(id) {
    var preset = bgPreset(id);
    if (!preset) return;
    bgId = id;
    BG_COLOR = preset.rgb;
    lsSet(BG_STORE_KEY, id);
    renderBgUI();
    needsRender = true;
  }

  // ---- input ----------------------------------------------------------------------------------
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
  function onPointerUp(e) {
    drag = null;
    if (canvas.releasePointerCapture) try { canvas.releasePointerCapture(e.pointerId); }
    catch { /* the drag state is already cleared when capture has expired */ }
  }
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
    // A focused z-range handle owns its own arrow keys; stealing them makes the slider keyboard-dead.
    var tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" && e.key !== "Escape") return;
    var handled = true;
    switch (e.key) {
      case "Escape": close(); break;
      case "r": case "R": rebuild({ retryResident: true }); break;
      case "f": case "F":
        if (field) {
          goal = Model.cam.frame(goal || Model.cam.create(), field, Z_SCALE);
          cur = Model.cam.copy(goal); needsRender = true;
        }
        break;
      // e/c mirror DF's own CURSOR_UP_Z / CURSOR_DOWN_Z; q/z remove the layer the same side added.
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

  // ---- chrome: built through the shared DWFUI factories, never hand-copied markup ------------------
  // The z-range slider stays a raw <input type=range>: DF owns no continuous-value control to mimic.
  function slabToolsHtml(C) {
    function fitBtn(name, label, title) {
      var key = name.replace(/-([a-z])/g, function (_, ch) { return ch.toUpperCase(); });
      var ds = {}; ds[key] = "";
      return C.plaqueBtnHtml({ label: label, cls: "world3d-step", dataset: ds, title: title });
    }
    // The per-edge single-step buttons flank the track they act on: base on the left, top on the right.
    function stepBtn(edge, delta, label, title) {
      return C.plaqueBtnHtml({
        label: label, cls: "world3d-zstep",
        dataset: { world3dZstep: edge + ":" + delta }, title: title,
      });
    }
    return '<span class="world3d-slab">' +
      '<span class="world3d-slab-lbl">' + C.bitmapTextHtml("Z-range") + '</span>' +
      stepBtn("base", -1, "−", "Lower the bottom of the window by one z-level") +
      stepBtn("base", 1, "+", "Raise the bottom of the window by one z-level") +
      '<span class="world3d-zslider">' +
        '<input type="range" class="world3d-zhandle" data-world3d-zbot min="0" max="1" step="1" value="0"' +
        ' aria-label="Lowest z-level shown">' +
        '<input type="range" class="world3d-zhandle" data-world3d-ztop min="0" max="1" step="1" value="0"' +
        ' aria-label="Highest z-level shown">' +
      '</span>' +
      stepBtn("top", -1, "−", "Lower the top of the window by one z-level") +
      stepBtn("top", 1, "+", "Raise the top of the window by one z-level") +
      '<span class="world3d-slab-n" data-world3d-zread></span>' +
      // The clamp note is emitted onto the readouts row; anything growing here re-wraps the whole header.
      fitBtn("world3d-fit-base", "Fit base",
        "Drop the bottom of the window to the lowest z-level your fort has dug or built on") +
      fitBtn("world3d-fit-top", "Fit top",
        "Raise the top of the window to the highest z-level your fort has dug or built on") +
      "</span>";
  }

  // Three whole windows, one question each. The two that need the fort's z-extent disable themselves.
  var Z_PRESETS = [
    { id: "surface", label: "Surface", title: "The top 8 z-levels of your fort" },
    { id: "fort", label: "Whole fort",
      title: "Every cached map chunk across every z-level your fort has dug or built on" },
    { id: "camera", label: "Around camera", title: "8 layers above and 8 below the live camera" },
  ];
  function presetToolsHtml(C) {
    var chips = Z_PRESETS.map(function (p) {
      return C.plaqueBtnHtml({
        label: p.label, cls: "world3d-chip",
        dataset: { world3dZpreset: p.id }, title: p.title,
      });
    }).join("");
    return '<span class="world3d-zpresets">' +
      '<span class="world3d-slab-lbl">' + C.bitmapTextHtml("Show") + '</span>' + chips + "</span>";
  }

  function bgToolsHtml(C) {
    var chips = BG_PRESETS.map(function (p) {
      var css = "rgb(" + Math.round(p.rgb[0] * 255) + "," + Math.round(p.rgb[1] * 255) + "," + Math.round(p.rgb[2] * 255) + ")";
      return C.artBtnHtml({
        cls: "world3d-bg-swatch", dataset: { world3dBgPick: p.id },
        swatch: css, ariaLabel: p.label, title: p.label,
      });
    }).join("");
    return '<span class="world3d-bg">' +
      '<span class="world3d-slab-lbl">' + C.bitmapTextHtml("Background") + '</span>' + chips + "</span>";
  }

  function headHtml() {
    var C = root.DWFUI;
    if (C && C.headerHtml && C.plaqueBtnHtml) {
      // The two action plaques are ONE wrap unit; loose in the flex run, Refresh orphaned onto its own row.
      var actions = '<span class="world3d-actions">' +
        C.plaqueBtnHtml({
          label: "Fit", cls: "world3d-fit",
          dataset: { world3dFit: "" }, title: "Re-frame the whole slab (F)",
        }) +
        C.plaqueBtnHtml({
          label: "Refresh", cls: "world3d-refresh",
          dataset: { world3dRefresh: "" }, title: "Rebuild from the current world state (R)",
        }) + "</span>";
      var tools = slabToolsHtml(C) + presetToolsHtml(C) + bgToolsHtml(C) + actions;
      return C.headerHtml({
        cls: "world3d-head", title: "3D world viewer", tools: tools,
        close: { data: "world3d-close", title: "Close (Esc)" },
      });
    }
    // Minimal non-DWFUI fallback (no shared classes, so no drift), reached only if DWFUI failed to load.
    return '<div class="world3d-head"><div class="world3d-title">3D world viewer</div>' +
      '<button class="world3d-btn" data-world3d-refresh title="Rebuild (R)">Refresh</button>' +
      '<button class="world3d-btn" data-world3d-close title="Close (Esc)">&#10005;</button></div>';
  }

  var HINT = "drag: orbit · right-drag: pan · middle-drag / wheel: zoom · " +
    "WASD: move · z-range: drag either handle (updates live), −/+ for one level, or a Show preset · " +
    "E/Q: layer above · C/Z: layer below · F: fit · R: refresh · Esc: close";

  var LIVE_TEXT = "the copy is rewritten from JS on every frame of a chunked build; re-assembling a " +
    "bitmap-atlas string 60x a second is not what the glyph layer is for";
  var NOTE_HTML = '<span class="world3d-slab-note" data-world3d-znote hidden></span>';
  function readoutHtml(C) {
    // No DWFUI means no readouts: copying `.dwfui-status` markup is exactly the drift the guard stops.
    if (!C || !C.statusHtml || !C.rawHtml) return '<div class="world3d-readout-line">' + NOTE_HTML + "</div>";
    var note = '<span class="world3d-slab-note" data-world3d-znote hidden>' + C.bitmapTextHtml("") + "</span>";
    return '<div class="world3d-readout-line">' + C.statusHtml({
      cls: "world3d-status", dataset: { world3dStatus: "" }, live: "polite",
      textHtml: root.DWFUI.rawHtml(LIVE_TEXT, ""),
    }) + note + "</div>" + C.statusHtml({
      cls: "world3d-hint", tone: "dim", dataset: { world3dHint: "" },
      textHtml: root.DWFUI.rawHtml(LIVE_TEXT, ""),
    });
  }

  function ensureEl() {
    if (el) return el;
    var C = root.DWFUI;
    el = doc.createElement("div");
    el.id = "world3dScreen";
    // ONE top-anchored chrome column: header, then readouts. Nothing here docks to the bottom of the screen.
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
    presetEl = el.querySelector(".world3d-zpresets");
    noteEl = el.querySelector("[data-world3d-znote]");
    zsliderEl = el.querySelector(".world3d-zslider");
    bgEl = el.querySelector(".world3d-bg");
    if (hintEl) hintEl.textContent = HINT;

    on("[data-world3d-close]", function () { close(); });
    on("[data-world3d-refresh]", function () { rebuild({ retryResident: true }); });
    on("[data-world3d-fit]", function () {
      if (field) {
        goal = Model.cam.frame(goal || Model.cam.create(), field, Z_SCALE);
        cur = Model.cam.copy(goal); needsRender = true;
      }
    });
    onAll("[data-world3d-zstep]", function (node) {
      var spec = (node.getAttribute("data-world3d-zstep") || "").split(":");
      stepEdge(spec[0], parseInt(spec[1], 10) || 0);
    });
    on("[data-world3d-fit-base]", function () { fitEdge("base"); });
    on("[data-world3d-fit-top]", function () { fitEdge("top"); });
    onAll("[data-world3d-zpreset]", function (node) { applyPreset(node.getAttribute("data-world3d-zpreset")); });
    // `input` previews (cheap), `change` commits (one rebuild per drag) -- see slabToolsHtml.
    ["[data-world3d-zbot]", "[data-world3d-ztop]"].forEach(function (sel) {
      onEach(sel, "input", onSliderPreview);
      onEach(sel, "change", onSliderCommit);
    });
    // Which handle a press lands on is decided BEFORE the press, by where the cursor is.
    if (zsliderEl && zsliderEl.addEventListener) {
      zsliderEl.addEventListener("pointermove", onSliderAim);
      zsliderEl.addEventListener("pointerdown", onSliderAim);
      zsliderEl.addEventListener("pointerleave", clearSliderAim);
    }
    onAll("[data-world3d-bg-pick]", function (node) { setBg(node.getAttribute("data-world3d-bg-pick")); });
    renderBgUI();

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

  // Wire a control and complain LOUDLY if it is missing: a silently-absent button is the failure mode.
  function on(sel, fn) {
    var node = el.querySelector(sel);
    if (!node) {
      if (root.console && typeof root.console.warn === "function")
        root.console.warn("world3d: control not found: " + sel);
      return;
    }
    node.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
  }
  // Same as on(), but for an event other than click (the z-range handles listen to input+change).
  function onEach(sel, type, fn) {
    var nodes = el.querySelectorAll(sel);
    if (!nodes.length) {
      if (root.console && typeof root.console.warn === "function")
        root.console.warn("world3d: control not found: " + sel);
      return;
    }
    for (var i = 0; i < nodes.length; i++) nodes[i].addEventListener(type, function () { fn(); });
  }
  // Same as on(), but for a REPEATED control; fn receives the specific node that was clicked.
  function onAll(sel, fn) {
    var nodes = el.querySelectorAll(sel);
    if (!nodes.length) {
      if (root.console && typeof root.console.warn === "function")
        root.console.warn("world3d: control not found: " + sel);
      return;
    }
    for (var i = 0; i < nodes.length; i++) {
      (function (node) {
        node.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); fn(node); });
      })(nodes[i]);
    }
  }

  // ---- open / close ---------------------------------------------------------------------------
  function setMode(enter) {
    try { doc.body.classList[enter ? "add" : "remove"]("world3d-mode"); }
    catch (error) { DwfErr.report("world3d.set-mode", error); }
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
    if (!unsubscribeDirty && root.DwfCache && typeof root.DwfCache.onDirty === "function") {
      unsubscribeDirty = root.DwfCache.onDirty(function () {
        if (open) cacheDirtyAt = now() + CACHE_DIRTY_DEBOUNCE_MS;
      });
    }
    rebuild({ frame: true }); // first open: frame the fort. Later rebuilds preserve the camera.
    scheduleFrame();
  }

  function close() {
    open = false;
    if (el) el.classList.remove("open");
    setMode(false); // the 2D chrome comes back, untouched and hit-testable

    if (rafId) { root.cancelAnimationFrame(rafId); rafId = 0; }
    if (voxBuilder) voxBuilder.cancel();
    voxBuilder = null; builder = null; pending = null;
    atlasDirtyAt = 0; cacheDirtyAt = 0; autoAt = 0;  // no deadline survives a closed viewer
    if (unsubscribeDirty) { unsubscribeDirty(); unsubscribeDirty = null; }
    drag = null;
    try { doc.getElementById("view") && doc.getElementById("view").focus({ preventScroll: true }); }
    catch (error) { DwfErr.report("world3d.restore-map-focus", error); }
  }

  function isOpen() { return open; }

  // The keys the 2D client claims in the CAPTURE phase are released only by dwf-core.js YIELDING on
  // DFWorld3D.isOpen() while we are open -- this listener alone is not enough.
  doc.addEventListener("keydown", function (e) {
    if (open) { onKey(e); return; }
    var help = doc.getElementById("helpPopup");
    if (help && help.classList.contains("open")) return;
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
