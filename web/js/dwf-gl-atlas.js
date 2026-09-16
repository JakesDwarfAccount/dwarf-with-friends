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

  var clamp = (root.DwfUtil || (typeof module !== "undefined" && module.require ? module.require("./dwf-util.js") : null)).clamp;

  // ---- constants -----------------------------------------------------------------------------
  var CELL_SIZE = 32;              // sprite pixel size (uniform across every known sheet)
  var GUTTER = 1;                  // duplicated-edge pixels per side
  var CELL_PITCH = CELL_SIZE + GUTTER * 2;               // 34
  var PAGE_SIZE = 2048;                                  // WebGL2-guaranteed 2D array layer size
  var CELLS_PER_ROW = Math.floor(PAGE_SIZE / CELL_PITCH); // 60
  var CELLS_PER_PAGE = CELLS_PER_ROW * CELLS_PER_ROW;     // 3600
  var MAX_PAGES = 16;
  var MAX_CELLS = CELLS_PER_PAGE * MAX_PAGES;             // 57600
  var PENDING = 0;                 // == the reserved transparent cell; "unresolved sheet => cell 0"
  var DEFAULT_DYNAMIC_MAX_CELLS = 512; // budget reserved for content-addressed unit composites

  // ---- pure pixel helper: a 32x32 atlas cell with a 1px duplicated edge ------------------------
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

  function globalIndexToLocation(globalIdx) {
    var page = Math.floor(globalIdx / CELLS_PER_PAGE);
    var local = globalIdx % CELLS_PER_PAGE;
    var col = local % CELLS_PER_ROW;
    var row = Math.floor(local / CELLS_PER_ROW);
    return { page: page, col: col, row: row };
  }

  // ---- in-memory sink (Node tests, or any host without a real GL context) ----------------------
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
      // test helper: read back a full 34x34 padded cell (or just the inner 32x32) at a global index.
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

  // ---- real GL sink (browser) -------------------------------------------------------------
  function makeGLSink(gl, pages) {
    var layers = Math.max(1, Math.min(MAX_PAGES, (pages | 0) || MAX_PAGES));
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    // texStorage3D is immutable: the layer count can never be raised after this call, so the ceiling
    // has to be reserved here rather than grown as pages fill.
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, PAGE_SIZE, PAGE_SIZE, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var minLinear = false;
    return {
      kind: "gl",
      texture: tex,
      setMinifying: function (on) {
        var want = !!on;
        if (want === minLinear) return;
        minLinear = want;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, want ? gl.LINEAR : gl.NEAREST);
      },
      isMinifying: function () { return minLinear; },
      ensurePage: function () {}, // storage already covers every reserved layer
      uploadCell: function (page, col, row, padded) {
        // UNPACK_PREMULTIPLY_ALPHA_WEBGL is legal only from an image-like TexImageSource: a raw typed-array
        // texSubImage3D errors 0x502 with it set, so buildPaddedCell's output is wrapped in an ImageData.
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
      pageCount: function () { return layers; },
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
    // Default caching, like every other sheet consumer: /sprites/img answers with a content ETag and
    // `Cache-Control: no-cache`, and force-cache would serve a stale sheet without revalidating.
    return fetch("/sprites/img/" + name).then(function (resp) {
      if (!resp.ok) {
        var err = new Error("sheet fetch failed: " + name + " (" + resp.status + ")");
        if (resp.status === 404) err.dwfPermanent = true;
        throw err;
      }
      return resp.blob();
    }).then(function (blob) { return createImageBitmap(blob); })
      .then(bitmapToImageSource);
  }

  function fetchDynamicReal(url) {
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
    // Cell ceiling, in lockstep with the pages the SINK reserved: an index past them would sample a
    // page that does not exist, so cap here and let the allocation fail cleanly into onAtlasFull.
    var maxCells = CELLS_PER_PAGE * Math.max(1, Math.min(MAX_PAGES, (opts.maxPages | 0) || MAX_PAGES));
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
    var SHEET_RETRY_DELAY_MS = 2000;
    // A /unit-sprite/<hash>.png can 404 until the server bakes the composite, so a portrait that missed
    // retries on this slower cadence, lazily on its next per-frame reference.
    var DYNAMIC_RETRY_DELAY_MS = 3000;

    var nextGlobalIndex = 1; // 0 is the reserved transparent cell
    var allocationFailed = false;
    var visibleCells = new Set(); // atlas index -> at least one source texel has alpha > 0

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
        try { readyListeners[i](name); }
        catch (error) { DwfErr.report("gl-atlas.ready-listener", error); }
      }
    }
    function notifyFull() {
      for (var i = 0; i < fullListeners.length; i++) {
        try { fullListeners[i](); }
        catch (error) { DwfErr.report("gl-atlas.full-listener", error); }
      }
    }

    function allocCells(n) {
      if (allocationFailed) return -1;
      if (nextGlobalIndex + n > maxCells) {
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
      var visible = false;
      for (var i = 3; i < padded.data.length; i += 4) {
        if (padded.data[i] !== 0) { visible = true; break; }
      }
      if (visible) visibleCells.add(globalIdx);
      else visibleCells.delete(globalIdx);
      sink.uploadCell(loc.page, loc.col, loc.row, padded);
    }

    function isCellVisible(base, count) {
      var n = Math.max(1, count | 0);
      for (var i = 0; i < n; i++) if (visibleCells.has(base + i)) return true;
      return false;
    }

    // Blank the reserved transparent cell 0 explicitly, so the invariant never depends on zero-init.
    (function initReservedCell() {
      var blank = { width: CELL_SIZE, height: CELL_SIZE, data: new Uint8ClampedArray(CELL_SIZE * CELL_SIZE * 4) };
      uploadCellAt(0, blank, 0, 0, CELL_SIZE, CELL_SIZE);
    })();

    function getSheetImage(name) {
      var e = imageCache.get(name);
      if (e) return e;
      e = { state: "pending", img: null, waiters: [], erroredAt: 0, permanent: false };
      imageCache.set(name, e);
      Promise.resolve().then(function () { return fetchSheet(name); }).then(function (img) {
        e.img = img;
        e.state = "ready";
        var waiters = e.waiters; e.waiters = [];
        waiters.forEach(function (fn) { fn(); });
      }).catch(function (err) {
        e.state = "error";
        e.erroredAt = nowFn();  // retry eligibility clock
        // A sheet the server says does not exist is never coming: do not re-request it every 2s forever.
        e.permanent = !!(err && err.dwfPermanent);
        var waiters = e.waiters; e.waiters = [];
        waiters.forEach(function (fn) { fn(); });
      });
      return e;
    }

    function fetchRetryDue(name) {
      var e = imageCache.get(name);
      return !!e && e.state === "error" && !e.permanent &&
        (nowFn() - e.erroredAt) >= SHEET_RETRY_DELAY_MS;
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
      // Only a FETCH failure is retryable: bad image dims or a full atlas cannot change on a re-fetch.
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

    // Regular grid resolve: one sheet cell -> one atlas cell, at the sheet's own native stride.
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

    // Renderer-neutral sheet/col/row refs enter here, so GL cannot reinterpret a shared selection.
    function resolveRef(ref) {
      if (!ref || typeof ref.sheet !== "string" || !Number.isInteger(ref.col) || !Number.isInteger(ref.row)) return PENDING;
      return resolve(ref.sheet, ref.col, ref.row);
    }

    function resolveAnimated(key, sheet, frameCells) {
      var a = animRuns.get(key);
      // Same retryable-on-fetch-failure recovery as ensureSheet above.
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

    // ---- palette-swap resolve --------------------------------------------------------------------
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
          try { remap(cellData, CELL_SIZE, CELL_SIZE); }
          catch { /* the unmodified source pixels remain valid atlas content */ }
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

    // ---- runtime COMPOSITE cell: art DF builds at runtime out of one or more cells ----------------
    var compositeRuns = new Map();  // "sheet|col|row|key" -> {state, base, retryable}
    function resolveComposite(sheet, col, row, key, compose) {
      var ck = sheet + "|" + col + "|" + row + "|" + key;
      var cr = compositeRuns.get(ck);
      if (cr && cr.state === "error" && cr.retryable && fetchRetryDue(sheet)) {
        compositeRuns.delete(ck); imageCache.delete(sheet); cr = null;
      }
      if (!cr) {
        cr = { state: "pending", base: -1, retryable: false };
        compositeRuns.set(ck, cr);
        var imgEntry = getSheetImage(sheet);
        var proceed = function () {
          if (imgEntry.state === "error") { cr.state = "error"; cr.retryable = true; return; }
          var img = imgEntry.img;
          var gd = gridDims(img, "sheet \"" + sheet + "\"", sheet);
          var sx = col * gd.cellW, sy = row * gd.cellH;
          if (sx < 0 || sy < 0 || sx + gd.cellW > img.width || sy + gd.cellH > img.height) {
            cr.state = "error"; cr.retryable = false; return;
          }
          // Native-size, unscaled extraction of the source cell.
          var src = new Uint8ClampedArray(gd.cellW * gd.cellH * 4);
          for (var y = 0; y < gd.cellH; y++) {
            var srow = ((sy + y) * img.width + sx) * 4;
            src.set(img.data.subarray(srow, srow + gd.cellW * 4), y * gd.cellW * 4);
          }
          var dst = new Uint8ClampedArray(CELL_SIZE * CELL_SIZE * 4);
          try { compose(dst, CELL_SIZE, CELL_SIZE, src, gd.cellW, gd.cellH); }
          catch { cr.state = "error"; cr.retryable = false; return; }
          var base = allocCells(1);
          if (base < 0) { cr.state = "error"; cr.retryable = false; return; }
          uploadCellAt(base, { width: CELL_SIZE, height: CELL_SIZE, data: dst }, 0, 0, CELL_SIZE, CELL_SIZE);
          cr.base = base; cr.state = "ready";
          notifyReady(ck);
        };
        if (imgEntry.state === "ready" || imgEntry.state === "error") proceed();
        else imgEntry.waiters.push(proceed);
      }
      return cr.state === "ready" ? cr.base : PENDING;
    }

    // ---- synthetic stamp cell -------------------------------------------------------------
    var stampRuns = new Map();  // key -> {state, base}
    function resolveStamp(key, painter) {
      var st = stampRuns.get(key);
      if (!st) {
        st = { state: "pending", base: -1 };
        stampRuns.set(key, st);
        var data = new Uint8ClampedArray(CELL_SIZE * CELL_SIZE * 4);
        try { painter(data, CELL_SIZE); }
        catch { /* the allocated synthetic cell stays transparent */ }
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
      // Budget too small to ever fit `span`: allocate past it rather than silently drawing nothing.
      var base3 = allocCells(span);
      if (base3 >= 0) dynamicCellsUsed += span;
      return base3;
    }

    function registerDynamicSheet(key, url) {
      var d = dynamicEntries.get(key);
      if (d && d.state === "error" && d.retryable && (nowFn() - d.erroredAt) >= DYNAMIC_RETRY_DELAY_MS) {
        dynamicEntries.delete(key); // held no cells; a fresh fetch is issued below
        d = null;
      }
      if (d) { d.lastUsed = ++lruTick; return d.state === "ready"; }
      d = { state: "pending", cols: 0, rows: 0, base: -1, span: 0, lastUsed: ++lruTick, erroredAt: 0, retryable: false };
      dynamicEntries.set(key, d);
      stats.dynamicEntriesLive++;
      Promise.resolve().then(function () { return fetchDynamic(url); }).then(function (img) {
        // Evicted or superseded before the round-trip landed: drop it, a later register re-fetches fresh.
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
        // 404 (not baked yet) or a transient network error: retryable after the backoff, NOT deleted.
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
      resolveRef: resolveRef,
      resolveAnimated: resolveAnimated,
      resolvePalette: resolvePalette,
      resolveComposite: resolveComposite,
      resolveStamp: resolveStamp,
      registerDynamicSheet: registerDynamicSheet,
      setSheetGeometry: setSheetGeometry,
      onSheetReady: onSheetReady,
      onAtlasFull: onAtlasFull,
      getSheetInfo: getSheetInfo,
      getDynamicInfo: getDynamicInfo,
      getStats: getStats,
      getTexture: function () { return sink.texture; },
      // forwarded to the GL sink's MIN-filter seam; a no-op on the in-memory sink, which has no sampler
      setMinifying: function (on) { if (sink.setMinifying) sink.setMinifying(on); },
      isMinifying: function () { return sink.isMinifying ? sink.isMinifying() : false; },
      pageCount: function () { return sink.pageCount ? sink.pageCount() : 0; },
      isCellVisible: isCellVisible,
      PENDING: PENDING,
    };
  }

  function create(options) {
    options = options || {};
    var sink = options.sink || (options.gl ? makeGLSink(options.gl, options.maxPages) : makeMemorySink());
    return createAtlas({
      sink: sink,
      fetchSheet: options.fetchSheet,
      fetchDynamic: options.fetchDynamic,
      dynamicMaxCells: options.dynamicMaxCells,
      maxPages: options.maxPages,
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
      maxPages: options.maxPages,
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
