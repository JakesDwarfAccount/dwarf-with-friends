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

// dwf-gl-atlas.js -- WB-8 (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md,
// "GL atlas module"). A client-side packer for the ONE TEXTURE_2D_ARRAY atlas the WB-9 GL
// renderer samples every instance from (report §A / spec §1.4): 2048^2 pages, up to 8,
// 34x34 cell pitch (32x32 sprite + 1px duplicated-edge gutter on every side), append-only
// allocation (an index, once handed out, never moves for the session), cell 0 reserved as a
// fully-transparent 1-frame cell (both "not yet loaded" and "intentionally blank" resolve to
// it -- same visual result), lazy per-sheet fetch through the existing `/sprites/img/<name>`
// route (Cache-Control already long-lived server-side, licensing note below), NEAREST
// filtering, no mips, `UNPACK_PREMULTIPLY_ALPHA_WEBGL` at upload time (spec §1.2 blending
// contract).
//
// RECONCILE (spec §0 lineage / this item's own scope note): animation frames are NOT
// consecutive atlas cells in the source raws. WC-10's server-side `frames` array
// (`/sprites/map.json`, e.g. BROOK_TO_NW -> 16 frames down a column, FLOW_MIASMA -> 4 frames
// down a column, RIVER_TO_* -> frames across a row) gives the CORRECT per-frame {col,row}
// list, but those cells sit at their native sheet-grid stride (e.g. a token whose frames vary
// by ROW are `sheetCols` atlas cells apart once packed on the regular grid, not 1 apart) --
// the WB-15 shader trick (`cell += (time/rate + hash) % animFrames`, report §W11) needs each
// frame to be the PREVIOUS one's atlas index + 1. So this module exposes a second allocation
// path, `resolveAnimated(key, sheet, frameCells)`, that copies the same source pixels a
// second time into a freshly bump-allocated CONSECUTIVE run (duplication is cheap; the atlas
// is memory, not the bottleneck -- report §A). The regular per-cell `resolve(sheet,col,row)`
// grid path is untouched and still valid for every non-animated token.
//
// Unit composites (W-E baker, `/unit-sprite/<hash>.png`, `src/http_server.cpp:1459`) are
// content-addressed: a live fort can cycle through many thousands of distinct appearance
// hashes in a session (equipment changes, wounds, death), so treating them as regular
// append-only sheets would eventually starve the atlas. They get their OWN allocation path,
// `registerDynamicSheet(key, url)` + `resolve(key,col,row)`, backed by a bounded, LRU-evicted
// free-list (`dynamicMaxCells`) that is entirely separate from the static append-only region
// -- static indices still never move; only dynamic ones can be reclaimed, and only after
// eviction invalidates the old key (a fresh `registerDynamicSheet` re-fetches it).
//
// DUAL-MODE FILE (same convention as dwf-adjacency.js / dwf-cache-worker.js): a
// plain <script> in the browser (`window.DwfGLAtlas`), or loaded via
// vm.runInThisContext in a Node unit test (tools/harness/gl_atlas_test.mjs). The packing
// MATH (page/cell allocation, gutter construction, animated-run contiguity, dynamic
// eviction) is pure and DOM/GL-free -- `create({sink, fetchSheet, fetchDynamic})` takes
// injectable I/O so the Node harness can verify exact pixel content via an in-memory "sink"
// without a browser or GPU. The browser entry point (`createForGL(gl)`) supplies the real
// `texSubImage3D` sink and a `fetch` + `createImageBitmap` + scratch-canvas pixel reader.
//
// Licensing (spec §1.5, absolute): DF's PNGs are served from the user's own install at
// runtime and are NEVER committed to this repo; the packed atlas exists only in
// browser/GPU memory. This file contains no sprite pixels, only packing logic.
(function (root) {
  "use strict";

  // ---- constants (report §A / spec §1.4) --------------------------------------------------
  var CELL_SIZE = 32;              // sprite pixel size (uniform across every known sheet)
  var GUTTER = 1;                  // duplicated-edge pixels per side
  var CELL_PITCH = CELL_SIZE + GUTTER * 2;               // 34
  var PAGE_SIZE = 2048;                                  // WebGL2-guaranteed 2D array layer size
  var CELLS_PER_ROW = Math.floor(PAGE_SIZE / CELL_PITCH); // 60
  var CELLS_PER_PAGE = CELLS_PER_ROW * CELLS_PER_ROW;     // 3600
  // T1 capacity fix (2026-07-08, range re-sweep evidence): a FULL range sweep with the T1c
  // palette-swap cells enabled exhausted the old 8-page (28,800-cell) budget -- the last-loaded
  // niche creature sheets (night creatures/demons) failed allocation, went one-renderer-blank,
  // and the onAtlasFull listener DEMOTED the page to canvas2d mid-session. 16 pages = 57,600
  // cells (268MB via texStorage3D up front -- trivial on any discrete GPU, plain RAM on iGPUs);
  // WebGL2 guarantees MAX_ARRAY_TEXTURE_LAYERS >= 256, so 16 layers is always legal.
  var MAX_PAGES = 16;
  var MAX_CELLS = CELLS_PER_PAGE * MAX_PAGES;             // 57600
  var PENDING = 0;                 // == the reserved transparent cell; "unresolved sheet => cell 0"
  var DEFAULT_DYNAMIC_MAX_CELLS = 512; // budget reserved for content-addressed unit composites

  // ---- pure pixel helper: build a 32x32 atlas cell with a 1px duplicated edge --------------
  // `src` is {width, height, data} where data is a flat RGBA Uint8ClampedArray/Uint8Array,
  // row-major, straight (non-premultiplied) alpha -- exactly what CanvasRenderingContext2D's
  // getImageData() returns, and exactly what a Node test fixture can construct directly with
  // no decode step at all. Edge-clamped source sampling produces the gutter for free (dx=0 /
  // dy=0 clamp back to the first real row/col; dx=cellW+1 / dy=cellH+1 clamp to the last),
  // including exact corner duplication -- no special-cased corner code needed.
  function buildPaddedCell(src, srcX, srcY, cellW, cellH, dstW, dstH) {
    dstW = dstW || CELL_SIZE;
    dstH = dstH || CELL_SIZE;
    var pw = CELL_SIZE + 2 * GUTTER;
    var ph = CELL_SIZE + 2 * GUTTER;
    var out = new Uint8ClampedArray(pw * ph * 4);
    for (var dy = 0; dy < ph; dy++) {
      var innerY = clamp(dy - GUTTER, 0, CELL_SIZE - 1);
      var srcLocalY = Math.floor(innerY * cellH / dstH);
      var sy = srcY + clamp(srcLocalY, 0, cellH - 1);
      for (var dx = 0; dx < pw; dx++) {
        var innerX = clamp(dx - GUTTER, 0, CELL_SIZE - 1);
        var srcLocalX = Math.floor(innerX * cellW / dstW);
        var sx = srcX + clamp(srcLocalX, 0, cellW - 1);
        var si = (sy * src.width + sx) * 4;
        var di = (dy * pw + dx) * 4;
        out[di] = src.data[si];
        out[di + 1] = src.data[si + 1];
        out[di + 2] = src.data[si + 2];
        out[di + 3] = src.data[si + 3];
      }
    }
    return { width: pw, height: ph, data: out };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function globalIndexToLocation(globalIdx) {
    var page = Math.floor(globalIdx / CELLS_PER_PAGE);
    var local = globalIdx % CELLS_PER_PAGE;
    var col = local % CELLS_PER_ROW;
    var row = Math.floor(local / CELLS_PER_ROW);
    return { page: page, col: col, row: row };
  }

  // ---- in-memory sink (Node tests / any host without a real GL context) ------------------
  // Simulates the exact byte layout a real TEXTURE_2D_ARRAY would hold, so a test can read
  // back "what pixel ended up at atlas index N, local (dx,dy) inside its 34x34 cell" with no
  // GPU/DOM involved -- this is what makes the pack-correctness tests exact, not approximate.
  function makeMemorySink() {
    var pages = [];
    function ensurePage(p) {
      while (pages.length <= p) pages.push(new Uint8ClampedArray(PAGE_SIZE * PAGE_SIZE * 4));
    }
    function uploadCell(page, col, row, padded) {
      ensurePage(page);
      var buf = pages[page];
      var baseX = col * CELL_PITCH, baseY = row * CELL_PITCH;
      for (var y = 0; y < padded.height; y++) {
        var destRowStart = ((baseY + y) * PAGE_SIZE + baseX) * 4;
        var srcRowStart = y * padded.width * 4;
        buf.set(padded.data.subarray(srcRowStart, srcRowStart + padded.width * 4), destRowStart);
      }
    }
    return {
      kind: "memory",
      ensurePage: ensurePage,
      uploadCell: uploadCell,
      // test helper: read back a full 34x34 padded cell (or just the inner 32x32) at a
      // given GLOBAL atlas index.
      readCell: function (globalIdx, inner) {
        var loc = globalIndexToLocation(globalIdx);
        ensurePage(loc.page);
        var buf = pages[loc.page];
        var off = inner ? GUTTER : 0;
        var size = inner ? CELL_SIZE : CELL_PITCH;
        var baseX = loc.col * CELL_PITCH + off, baseY = loc.row * CELL_PITCH + off;
        var out = new Uint8ClampedArray(size * size * 4);
        for (var y = 0; y < size; y++) {
          var srcStart = ((baseY + y) * PAGE_SIZE + baseX) * 4;
          out.set(buf.subarray(srcStart, srcStart + size * 4), y * size * 4);
        }
        return { width: size, height: size, data: out };
      },
      pageCount: function () { return pages.length; },
    };
  }

  // ---- real GL sink (browser, WB-9 consumes .texture) -------------------------------------
  function makeGLSink(gl) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    // Immutable storage sized for the FULL 8-page ceiling up front (report §A: "allocated on
    // demand up to 8 pages" is a logical cap on how many layers ever get WRITTEN to, not a
    // reason to reallocate-and-relose-data as the array grows -- texStorage3D avoids that
    // failure mode entirely and costs nothing until a layer is actually written).
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, PAGE_SIZE, PAGE_SIZE, MAX_PAGES);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return {
      kind: "gl",
      texture: tex,
      ensurePage: function () {}, // storage already covers all MAX_PAGES layers
      uploadCell: function (page, col, row, padded) {
        // IMPORTANT: UNPACK_PREMULTIPLY_ALPHA_WEBGL (and UNPACK_FLIP_Y_WEBGL) are only
        // legal when the pixel source is an image-like TexImageSource (ImageData/
        // ImageBitmap/canvas/video) -- the WebGL spec mandates INVALID_OPERATION if either
        // is set true while uploading from a raw ArrayBufferView (verified empirically: a
        // plain Uint8Array texSubImage3D upload errors 0x502 the instant
        // UNPACK_PREMULTIPLY_ALPHA_WEBGL is true, even though every argument is otherwise
        // valid). `buildPaddedCell()`'s output is a raw typed array, so it is wrapped in an
        // `ImageData` here to use the image-source overload of texSubImage3D (which infers
        // width/height from the source and targets exactly one array layer at `zoffset`)
        // and get correct, spec-legal premultiplication.
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        var imageData = new ImageData(padded.data, padded.width, padded.height);
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY, 0,
          col * CELL_PITCH, row * CELL_PITCH, page,
          padded.width, padded.height, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, imageData
        );
      },
      pageCount: function () { return MAX_PAGES; },
    };
  }

  // ---- real browser fetchers (fetch + createImageBitmap + scratch-canvas pixel read) -----
  function scratchCanvas(w, h) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    var c = (typeof document !== "undefined") ? document.createElement("canvas") : null;
    if (!c) throw new Error("no canvas implementation available to decode sheet pixels");
    c.width = w; c.height = h;
    return c;
  }

  function bitmapToImageSource(bitmap) {
    var canvas = scratchCanvas(bitmap.width, bitmap.height);
    var ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    var id = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    if (bitmap.close) bitmap.close();
    return { width: id.width, height: id.height, data: id.data };
  }

  function fetchSheetReal(name) {
    // SECURITY / route contract: `/sprites/img/<bare-name>.png`, cache headers already
    // long-lived server-side (spec §1.5, http_server.cpp:1272-1311).
    return fetch("/sprites/img/" + name, { cache: "force-cache" }).then(function (resp) {
      if (!resp.ok) throw new Error("sheet fetch failed: " + name + " (" + resp.status + ")");
      return resp.blob();
    }).then(function (blob) { return createImageBitmap(blob); })
      .then(bitmapToImageSource);
  }

  function fetchDynamicReal(url) {
    // Content-addressed unit composites (`/unit-sprite/<hash>.png`) -- immutable per hash,
    // long cache lifetime server-side already (http_server.cpp:1459-1470).
    return fetch(url, { cache: "force-cache" }).then(function (resp) {
      if (!resp.ok) throw new Error("dynamic sheet fetch failed: " + url + " (" + resp.status + ")");
      return resp.blob();
    }).then(function (blob) { return createImageBitmap(blob); })
      .then(bitmapToImageSource);
  }

  // ---- core packer (pure; no DOM/GL) ------------------------------------------------------
  function createAtlas(opts) {
    opts = opts || {};
    var sink = opts.sink || makeMemorySink();
    var fetchSheet = opts.fetchSheet || fetchSheetReal;
    var fetchDynamic = opts.fetchDynamic || fetchDynamicReal;
    var dynamicMaxCells = opts.dynamicMaxCells || DEFAULT_DYNAMIC_MAX_CELLS;
    var sheetGeometry = new Map();
    function setSheetGeometry(map) {
      if (!map) return;
      Object.keys(map).forEach(function (name) {
        var g = map[name] || {};
        var cw = Math.max(1, Math.floor(g.cell_w || g.cellW || CELL_SIZE));
        var ch = Math.max(1, Math.floor(g.cell_h || g.cellH || CELL_SIZE));
        var pw = Math.max(0, Math.floor(g.page_w || g.pageW || 0));
        var ph = Math.max(0, Math.floor(g.page_h || g.pageH || 0));
        sheetGeometry.set(name, { cellW: cw, cellH: ch, pageW: pw, pageH: ph });
      });
    }
    setSheetGeometry(opts.sheetGeometry);
    var warn = opts.warn || (typeof console !== "undefined" ? function (m) { console.warn(m); } : function () {});
    var nowFn = opts.now || Date.now;
    // Designation-glyph GL bug (2026-07-07 ledger, "DESIGNATION OVERLAY BUGS"): a single
    // transient sheet-fetch failure (e.g. a dropped request over a flaky cloudflare tunnel)
    // used to leave that sheet's `sheets`/`animRuns` entry stuck at state "error" FOREVER --
    // `ensureSheet`/`resolveAnimated` both did `if (s) return s;` unconditionally, so `resolve()`
    // kept returning PENDING (0) for every sprite on that sheet for the rest of the browser
    // session, recoverable only by a full page reload (fresh `sheets`/`imageCache`/`animRuns`
    // Maps). Confirmed via a Node repro (tools/harness/gl_core_test.mjs, "designation glyph
    // survives a transient sheet-fetch failure") that a single simulated rejected fetch for
    // designations.png permanently blanked the glyph while wash/hidden-hatch/outline (other
    // sheets + SOLID_CELL) kept rendering fine -- exactly the reported symptom split. FIX:
    // bounded-retry -- a sheet/anim-run that failed because its UNDERLYING FETCH errored (not
    // because of bad image dims or atlas-full, neither of which retrying would fix) becomes
    // eligible for automatic retry after SHEET_RETRY_DELAY_MS, checked lazily on the next
    // resolve() call for that name (no polling timer needed -- buildScene() already re-invokes
    // resolve() every rebuild for anything still in view).
    var SHEET_RETRY_DELAY_MS = 2000;
    // AH-DEFECT client heal (live report 07-09): content-addressed unit composites are baked
    // by the server seconds-to-minutes AFTER a unit first appears -- DF only fills
    // texpos_currently_in_use once the unit RENDERS host-side, so a `/unit-sprite/<hash>.png`
    // referenced before that 404s, and the window #10 worker re-enqueues the bake later. A
    // portrait that 404'd pre-bake retries on THIS slower cadence (see registerDynamicSheet):
    // lazily on the next per-frame reference, so a visible-but-unbaked unit re-requests ~once
    // every few seconds and an off-screen or already-baked one never does (idle guard).
    var DYNAMIC_RETRY_DELAY_MS = 3000;

    var nextGlobalIndex = 1; // 0 is the reserved transparent cell
    var allocationFailed = false;

    var imageCache = new Map();   // sheetName -> {state, img, waiters:[fn]}
    var sheets = new Map();       // sheetName -> {state, cols, rows, base}
    var animRuns = new Map();     // key -> {state, base, count}
    var dynamicEntries = new Map();  // key -> {state, cols, rows, base, span, lastUsed}
    var dynamicFree = new Map();     // span -> [base, ...]  (freed dynamic blocks, reused by exact span)
    var dynamicCellsUsed = 0;
    var lruTick = 0;

    var readyListeners = [];
    var fullListeners = [];

    var stats = {
      sheetsLoaded: 0,
      sheetsPending: 0,
      sheetsError: 0,
      animRunsResolved: 0,
      animRunsPending: 0,
      dynamicEntriesLive: 0,
      dynamicEvictions: 0,
      cellsUsed: 0,
      pagesUsed: 0,
      allocationFailed: false,
    };

    function notifyReady(name) {
      for (var i = 0; i < readyListeners.length; i++) {
        try { readyListeners[i](name); } catch (_e) { /* listener errors must not break packing */ }
      }
    }
    function notifyFull() {
      for (var i = 0; i < fullListeners.length; i++) {
        try { fullListeners[i](); } catch (_e) { /* ignore */ }
      }
    }

    function allocCells(n) {
      if (allocationFailed) return -1;
      // Valid global indices run 0..MAX_CELLS-1 (MAX_CELLS total cell slots across all 8
      // pages); nextGlobalIndex is the next index to hand out, so allocating `n` more cells
      // is only safe while the LAST one they'd occupy (nextGlobalIndex + n - 1) still fits.
      if (nextGlobalIndex + n > MAX_CELLS) {
        allocationFailed = true;
        stats.allocationFailed = true;
        notifyFull();
        return -1;
      }
      var base = nextGlobalIndex;
      nextGlobalIndex += n;
      var lastIdx = nextGlobalIndex - 1;
      var pagesNeeded = Math.floor(lastIdx / CELLS_PER_PAGE) + 1;
      for (var p = 0; p < pagesNeeded; p++) sink.ensurePage(p);
      stats.cellsUsed = nextGlobalIndex - 1;
      stats.pagesUsed = pagesNeeded;
      return base;
    }

    function uploadCellAt(globalIdx, img, srcX, srcY, cw, ch) {
      var loc = globalIndexToLocation(globalIdx);
      var padded = buildPaddedCell(img, srcX, srcY, cw, ch);
      sink.uploadCell(loc.page, loc.col, loc.row, padded);
    }

    // Explicitly blank the reserved transparent cell 0. Belt-and-suspenders: immutable GL
    // storage is zero-initialized by spec, and a fresh typed array is zero-initialized in
    // JS, so this is a no-op in both real hosts today -- keeping it means the invariant does
    // not silently depend on that fact.
    (function initReservedCell() {
      var blank = { width: CELL_SIZE, height: CELL_SIZE, data: new Uint8ClampedArray(CELL_SIZE * CELL_SIZE * 4) };
      uploadCellAt(0, blank, 0, 0, CELL_SIZE, CELL_SIZE);
    })();

    function getSheetImage(name) {
      var e = imageCache.get(name);
      if (e) return e;
      e = { state: "pending", img: null, waiters: [], erroredAt: 0 };
      imageCache.set(name, e);
      Promise.resolve().then(function () { return fetchSheet(name); }).then(function (img) {
        e.img = img;
        e.state = "ready";
        var waiters = e.waiters; e.waiters = [];
        waiters.forEach(function (fn) { fn(); });
      }).catch(function () {
        e.state = "error";
        e.erroredAt = nowFn(); // retry eligibility clock -- see SHEET_RETRY_DELAY_MS banner above
        var waiters = e.waiters; e.waiters = [];
        waiters.forEach(function (fn) { fn(); });
      });
      return e;
    }

    // True once SHEET_RETRY_DELAY_MS has passed since `name`'s underlying image fetch itself
    // failed (a network-level error -- retrying might well succeed). Never true for a sheet
    // that hasn't failed yet, or whose entry has already been cleared for retry.
    function fetchRetryDue(name) {
      var e = imageCache.get(name);
      return !!e && e.state === "error" && (nowFn() - e.erroredAt) >= SHEET_RETRY_DELAY_MS;
    }

    function geometryFor(name) {
      return sheetGeometry.get(name) || { cellW: CELL_SIZE, cellH: CELL_SIZE, pageW: 0, pageH: 0 };
    }

    function gridDims(img, label, name) {
      var geom = geometryFor(name);
      var cw = geom.cellW || CELL_SIZE, ch = geom.cellH || CELL_SIZE;
      var usableW = geom.pageW || img.width;
      var usableH = geom.pageH || img.height;
      var cols = Math.floor(usableW / cw);
      var rows = Math.floor(usableH / ch);
      if (usableW % cw !== 0 || usableH % ch !== 0) {
        warn("[dwf-gl-atlas] " + label + " dims " + usableW + "x" + usableH +
          " are not a multiple of " + cw + "x" + ch + "px; rounding down to a " + cols + "x" + rows + " grid");
      }
      return { cols: cols, rows: rows, cellW: cw, cellH: ch };
    }

    function ensureSheet(name) {
      var s = sheets.get(name);
      // Retry path: a sheet stuck at "error" purely because its FETCH failed (retryable --
      // see SHEET_RETRY_DELAY_MS banner) gets one more attempt once the backoff has elapsed.
      // A sheet that failed for a non-network reason (bad image dims, atlas full) is NOT
      // retryable -- re-fetching the exact same already-decoded image can't change that
      // outcome, so `s.retryable` (set below) gates this instead of blindly retrying everything.
      if (s && s.state === "error" && s.retryable && fetchRetryDue(name)) {
        stats.sheetsError--;
        sheets.delete(name);
        imageCache.delete(name); // force a fresh fetchSheet() call, not the stale rejected one
        s = null;
      }
      if (s) return s;
      s = { state: "pending", cols: 0, rows: 0, base: 0, retryable: false };
      sheets.set(name, s);
      stats.sheetsPending++;
      var imgEntry = getSheetImage(name);
      function proceed() {
        if (imgEntry.state === "error") {
          s.state = "error"; s.retryable = true; stats.sheetsPending--; stats.sheetsError++;
          return;
        }
        var dims = gridDims(imgEntry.img, "sheet \"" + name + "\"", name);
        if (dims.cols <= 0 || dims.rows <= 0) {
          s.state = "error"; s.retryable = false; stats.sheetsPending--; stats.sheetsError++;
          return;
        }
        var base = allocCells(dims.cols * dims.rows);
        if (base < 0) { s.state = "error"; s.retryable = false; stats.sheetsPending--; stats.sheetsError++; return; }
        for (var r = 0; r < dims.rows; r++) {
          for (var c = 0; c < dims.cols; c++) {
            uploadCellAt(base + r * dims.cols + c, imgEntry.img, c * dims.cellW, r * dims.cellH, dims.cellW, dims.cellH);
          }
        }
        s.cols = dims.cols; s.rows = dims.rows; s.base = base; s.state = "ready";
        stats.sheetsPending--; stats.sheetsLoaded++;
        notifyReady(name);
      }
      if (imgEntry.state === "ready" || imgEntry.state === "error") proceed();
      else imgEntry.waiters.push(proceed);
      return s;
    }

    // Regular grid resolve: one sheet cell -> one atlas cell, at the sheet's own native
    // stride. Correct for every non-animated token, and also the underlying fetch/decode
    // path animated tokens and dynamic sheets share (via getSheetImage above).
    function resolve(sheetOrKey, col, row) {
      var dyn = dynamicEntries.get(sheetOrKey);
      if (dyn) {
        dyn.lastUsed = ++lruTick;
        if (dyn.state !== "ready") return PENDING;
        if (col < 0 || col >= dyn.cols || row < 0 || row >= dyn.rows) return PENDING;
        return dyn.base + row * dyn.cols + col;
      }
      var s = ensureSheet(sheetOrKey);
      if (s.state !== "ready") return PENDING;
      if (col < 0 || col >= s.cols || row < 0 || row >= s.rows) return PENDING;
      return s.base + row * s.cols + col;
    }

    // Animated-run resolve (RECONCILE): `frameCells` is the server's per-token `frames`
    // array verbatim (`[{col,row}, ...]`, `/sprites/map.json`) -- each element is looked up
    // in `sheet`'s OWN decoded pixels (shared decode/cache with the plain grid path) and
    // copied into a freshly bump-allocated CONSECUTIVE atlas run. Returns the base index of
    // frame 0; frame i is ALWAYS base+i once ready, for the life of the session (append-only,
    // same as everything else) -- this is what lets the WB-15 shader do `cell += phase %
    // animFrames` and land on the right pixels regardless of how scattered the frames were
    // in the source sheet.
    function resolveAnimated(key, sheet, frameCells) {
      var a = animRuns.get(key);
      // Same retryable-on-fetch-failure recovery as ensureSheet above (identical bug class:
      // an animated run's `a.state="error"` used to stick forever on one dropped fetch).
      if (a && a.state === "error" && a.retryable && fetchRetryDue(sheet)) {
        animRuns.delete(key);
        imageCache.delete(sheet);
        a = null;
      }
      if (!a) {
        a = { state: "pending", base: -1, count: frameCells.length, retryable: false };
        animRuns.set(key, a);
        stats.animRunsPending++;
        var imgEntry = getSheetImage(sheet);
        function proceed() {
          if (imgEntry.state === "error") {
            a.state = "error"; a.retryable = true; stats.animRunsPending--;
            return;
          }
          var base = allocCells(frameCells.length);
          if (base < 0) { a.state = "error"; a.retryable = false; stats.animRunsPending--; return; }
          for (var i = 0; i < frameCells.length; i++) {
            var fc = frameCells[i];
            var gd = gridDims(imgEntry.img, "sheet \"" + sheet + "\"", sheet);
            uploadCellAt(base + i, imgEntry.img, fc.col * gd.cellW, fc.row * gd.cellH, gd.cellW, gd.cellH);
          }
          a.base = base; a.state = "ready";
          stats.animRunsPending--; stats.animRunsResolved++;
          notifyReady(key);
        }
        if (imgEntry.state === "ready" || imgEntry.state === "error") proceed();
        else imgEntry.waiters.push(proceed);
      }
      if (a.state === "ready") return a.base;
      return PENDING;
    }

    // ---- T1c palette-swap resolve (asset-material-parity-spec §1.2 / §4-T1c) --------------
    // Allocates ONE fresh append-only atlas cell holding a palette-remapped copy of source
    // (sheet,col,row). Mirrors resolveAnimated's single-cell/shared-decode/retryable pattern.
    // `palKey` is a stable per-material key (e.g. the palette row index) so the same material
    // reuses one cell; `remap(cellData, w, h)` mutates the extracted 32x32 straight-alpha RGBA
    // in place (the GL renderer supplies the material_map default->target remap so this module
    // stays material-agnostic). Returns the atlas index of the swapped cell, PENDING until ready.
    var paletteRuns = new Map();  // "sheet|col|row|palKey" -> {state, base, retryable}
    function resolvePalette(sheet, col, row, palKey, remap) {
      var key = sheet + "|" + col + "|" + row + "|" + palKey;
      var pr = paletteRuns.get(key);
      if (pr && pr.state === "error" && pr.retryable && fetchRetryDue(sheet)) {
        paletteRuns.delete(key); imageCache.delete(sheet); pr = null;
      }
      if (!pr) {
        pr = { state: "pending", base: -1, retryable: false };
        paletteRuns.set(key, pr);
        var imgEntry = getSheetImage(sheet);
        var proceed = function () {
          if (imgEntry.state === "error") { pr.state = "error"; pr.retryable = true; return; }
          var img = imgEntry.img;
          var gd = gridDims(img, "sheet \"" + sheet + "\"", sheet);
          var sx = col * gd.cellW, sy = row * gd.cellH;
          if (sx < 0 || sy < 0 || sx + gd.cellW > img.width || sy + gd.cellH > img.height) {
            pr.state = "error"; pr.retryable = false; return;
          }
          var packed = buildPaddedCell(img, sx, sy, gd.cellW, gd.cellH);
          var cellData = new Uint8ClampedArray(CELL_SIZE * CELL_SIZE * 4);
          for (var y = 0; y < CELL_SIZE; y++) {
            var srcStart = ((y + GUTTER) * packed.width + GUTTER) * 4;
            cellData.set(packed.data.subarray(srcStart, srcStart + CELL_SIZE * 4), y * CELL_SIZE * 4);
          }
          try { remap(cellData, CELL_SIZE, CELL_SIZE); } catch (_e) { /* leave source pixels */ }
          var base = allocCells(1);
          if (base < 0) { pr.state = "error"; pr.retryable = false; return; }
          uploadCellAt(base, { width: CELL_SIZE, height: CELL_SIZE, data: cellData }, 0, 0, CELL_SIZE, CELL_SIZE);
          pr.base = base; pr.state = "ready";
          notifyReady(key);
        };
        if (imgEntry.state === "ready" || imgEntry.state === "error") proceed();
        else imgEntry.waiters.push(proceed);
      }
      return pr.state === "ready" ? pr.base : PENDING;
    }

    // ---- synthetic stamp cell (WC-22 GL proj/vehicle marker parity) -----------------------
    // Allocates ONE cell painted entirely in JS -- `painter(data, size)` fills a straight-alpha
    // 32x32 RGBA buffer (transparent-initialized). Lets the instanced pipeline draw SUB-CELL
    // vector glyphs (canvas2d's half-cell vehicle square / projectile dot) with exact geometry
    // instead of a full-tile emitSolid that occludes the tile's own item sprite (the root of
    // the 8 "gl-blank" minecart PARITY-MISMATCH cells: the full-tile opaque khaki quad buried
    // the cart art and read as blank to the sweep's foreground metric). Synchronous: no fetch,
    // ready on first call (or PENDING forever only if the atlas is full).
    var stampRuns = new Map();  // key -> {state, base}
    function resolveStamp(key, painter) {
      var st = stampRuns.get(key);
      if (!st) {
        st = { state: "pending", base: -1 };
        stampRuns.set(key, st);
        var data = new Uint8ClampedArray(CELL_SIZE * CELL_SIZE * 4);
        try { painter(data, CELL_SIZE); } catch (_e) { /* stays transparent on painter bugs */ }
        var base = allocCells(1);
        if (base >= 0) {
          uploadCellAt(base, { width: CELL_SIZE, height: CELL_SIZE, data: data }, 0, 0, CELL_SIZE, CELL_SIZE);
          st.base = base; st.state = "ready";
        } else {
          st.state = "error";
        }
      }
      return st.state === "ready" ? st.base : PENDING;
    }

    function evictLRUUntilSpanFree(span) {
      var live = [];
      dynamicEntries.forEach(function (d, k) { if (d.state === "ready") live.push([k, d]); });
      live.sort(function (a, b) { return a[1].lastUsed - b[1].lastUsed; });
      for (var i = 0; i < live.length; i++) {
        var k = live[i][0], d = live[i][1];
        dynamicEntries.delete(k);
        dynamicCellsUsed -= d.span;
        var list = dynamicFree.get(d.span) || [];
        list.push(d.base);
        dynamicFree.set(d.span, list);
        stats.dynamicEvictions++;
        stats.dynamicEntriesLive--;
        if ((dynamicFree.get(span) || []).length > 0) return;
      }
    }

    function allocDynamic(span) {
      var free = dynamicFree.get(span);
      if (free && free.length) return free.pop();
      if (dynamicCellsUsed + span <= dynamicMaxCells) {
        var base = allocCells(span);
        if (base >= 0) dynamicCellsUsed += span;
        return base;
      }
      evictLRUUntilSpanFree(span);
      var free2 = dynamicFree.get(span);
      if (free2 && free2.length) return free2.pop();
      // Budget too small to ever fit `span` (e.g. dynamicMaxCells smaller than one entry) --
      // fall through to a raw allocation past budget rather than silently drawing nothing;
      // this only happens under a pathological config, not in normal operation.
      var base3 = allocCells(span);
      if (base3 >= 0) dynamicCellsUsed += span;
      return base3;
    }

    // Content-addressed unit composites (spec §1.4 last line / W-E baker). `url` is the
    // exact fetch target (`/unit-sprite/<hash>.png`) -- callers pass it in because a content
    // hash is not a bare filename the standard `/sprites/img/` route would resolve. Safe (and
    // expected) to call every frame for every currently-visible unit: a hit just refreshes
    // the LRU touch; a miss kicks off the fetch. Returns true once ready (so a caller can
    // choose to skip drawing until then, though `resolve()` degrading to PENDING/cell-0 is
    // also always safe).
    function registerDynamicSheet(key, url) {
      var d = dynamicEntries.get(key);
      // Retry path (AH-DEFECT client heal, the owner live report 07-09): a portrait whose
      // `/unit-sprite/<hash>.png` 404'd because the server had not baked the composite yet used
      // to be DELETED on the failing fetch -- which made this function re-fetch the SAME missing
      // hash on EVERY per-frame reference (a request storm) and applied no backoff at all. Since
      // the bake lands seconds-to-minutes later (window #10 re-enqueue), a failed dynamic entry
      // is now KEPT in an "error" state and re-fetched only once DYNAMIC_RETRY_DELAY_MS has
      // elapsed, checked lazily here on the next reference for this key (buildUnits re-references
      // every visible unit every frame, so no polling timer is needed; a unit that leaves the
      // screen stops being referenced and stops retrying -- zero wakeups when nothing is missing).
      // Same retryable/backoff shape as ensureSheet's transient-fetch recovery: only a network/404
      // miss is retried -- a decoded-but-unusable image or an atlas-full rejection sets
      // retryable=false, because re-fetching the identical bytes cannot change either outcome.
      if (d && d.state === "error" && d.retryable && (nowFn() - d.erroredAt) >= DYNAMIC_RETRY_DELAY_MS) {
        dynamicEntries.delete(key); // held no cells; a fresh fetch is issued below
        d = null;
      }
      if (d) { d.lastUsed = ++lruTick; return d.state === "ready"; }
      d = { state: "pending", cols: 0, rows: 0, base: -1, span: 0, lastUsed: ++lruTick, erroredAt: 0, retryable: false };
      dynamicEntries.set(key, d);
      stats.dynamicEntriesLive++;
      Promise.resolve().then(function () { return fetchDynamic(url); }).then(function (img) {
        // Evicted (or its retry-slot superseded) before the network round-trip landed -- drop it
        // silently; a future registerDynamicSheet(key,...) call re-fetches fresh.
        if (dynamicEntries.get(key) !== d) return;
        var dims = gridDims(img, "unit sprite \"" + key + "\"", null);
        if (dims.cols <= 0 || dims.rows <= 0) {
          // decoded but unusable (truncated/blank bake) -- permanent, NOT a retryable fetch miss
          d.state = "error"; d.retryable = false; stats.dynamicEntriesLive--;
          return;
        }
        var span = dims.cols * dims.rows;
        var base = allocDynamic(span);
        if (base < 0) {
          // atlas full, not a fetch miss -- retrying the same bytes won't free space
          d.state = "error"; d.retryable = false; stats.dynamicEntriesLive--;
          return;
        }
        for (var r = 0; r < dims.rows; r++) {
          for (var c = 0; c < dims.cols; c++) {
            uploadCellAt(base + r * dims.cols + c, img, c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
          }
        }
        d.cols = dims.cols; d.rows = dims.rows; d.base = base; d.span = span; d.state = "ready";
        notifyReady(key);
      }).catch(function () {
        if (dynamicEntries.get(key) !== d) return;
        // 404 (composite not baked yet) or a transient network error -- retryable after the
        // backoff, NOT deleted. Holds no atlas cells, so it stops counting as a live entry.
        d.state = "error"; d.erroredAt = nowFn(); d.retryable = true; stats.dynamicEntriesLive--;
      });
      return false;
    }

    function onSheetReady(cb) { readyListeners.push(cb); }
    function onAtlasFull(cb) { fullListeners.push(cb); }

    function getSheetInfo(name) {
      var s = sheets.get(name);
      if (!s) return null;
      return { state: s.state, cols: s.cols, rows: s.rows, base: s.base };
    }
    function getDynamicInfo(key) {
      var d = dynamicEntries.get(key);
      if (!d) return null;
      return { state: d.state, cols: d.cols, rows: d.rows, base: d.base, span: d.span };
    }

    function getStats() {
      // shallow copy -- callers must not be able to mutate internal counters
      var out = {};
      for (var k in stats) out[k] = stats[k];
      return out;
    }

    return {
      resolve: resolve,
      resolveAnimated: resolveAnimated,
      resolvePalette: resolvePalette,
      resolveStamp: resolveStamp,
      registerDynamicSheet: registerDynamicSheet,
      setSheetGeometry: setSheetGeometry,
      onSheetReady: onSheetReady,
      onAtlasFull: onAtlasFull,
      getSheetInfo: getSheetInfo,
      getDynamicInfo: getDynamicInfo,
      getStats: getStats,
      getTexture: function () { return sink.texture; },
      pageCount: function () { return sink.pageCount ? sink.pageCount() : 0; },
      PENDING: PENDING,
    };
  }

  function create(options) {
    options = options || {};
    var sink = options.sink || (options.gl ? makeGLSink(options.gl) : makeMemorySink());
    return createAtlas({
      sink: sink,
      fetchSheet: options.fetchSheet,
      fetchDynamic: options.fetchDynamic,
      dynamicMaxCells: options.dynamicMaxCells,
      sheetGeometry: options.sheetGeometry,
      warn: options.warn,
      now: options.now,
    });
  }

  function createForGL(gl, options) {
    options = options || {};
    return create({
      gl: gl,
      fetchSheet: options.fetchSheet,
      fetchDynamic: options.fetchDynamic,
      dynamicMaxCells: options.dynamicMaxCells,
      sheetGeometry: options.sheetGeometry,
      warn: options.warn,
      now: options.now,
    });
  }

  var DwfGLAtlas = {
    create: create,
    createForGL: createForGL,
    makeMemorySink: makeMemorySink,
    buildPaddedCell: buildPaddedCell,
    globalIndexToLocation: globalIndexToLocation,
    CELL_SIZE: CELL_SIZE,
    GUTTER: GUTTER,
    CELL_PITCH: CELL_PITCH,
    PAGE_SIZE: PAGE_SIZE,
    CELLS_PER_ROW: CELLS_PER_ROW,
    CELLS_PER_PAGE: CELLS_PER_PAGE,
    MAX_PAGES: MAX_PAGES,
    MAX_CELLS: MAX_CELLS,
    PENDING: PENDING,
  };

  root.DwfGLAtlas = DwfGLAtlas;
})(typeof self !== "undefined" ? self : this);
