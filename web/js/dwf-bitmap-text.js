// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// Assemble arbitrary labels from the player's own 8x12 CP437 atlas at runtime. The atlas is loaded
// once; rendered labels use a bounded LRU cache. Real DOM text remains as the accessible, fail-open
// layer and is hidden visually only after a complete bitmap label has rendered successfully.
//
// ===================================================================================================
// THE INTERFACE SCALE -- WHY THIS FILE NO LONGER ASSUMES 1x NEAREST-NEIGHBOUR.
//
// The foundation's D1 font contract asserted that DF "INTEGER SCALEs ONLY -- never sub-sample", and
// so this renderer drew every label at exactly 8x12 with imageSmoothingEnabled = false. MEASURED
// against the lossless oracle (Menu Oracle Screenshots/unit profiles/Steam relations.png), by
// least-squares fitting DF's OWN source cells back onto the capture, that assertion is FALSE:
//
//   fitted scale      what was fitted                                     source
//   -------------     ---------------------------------------------      ---------------------
//   1.245 / 1.245 / 1.240   tab labels "Military" / "Thoughts" / "Groups"  curses_640x300.png cells
//   1.230             SHORT_TAB tab art (40x24)                            interface_bits.png
//   1.260 / 1.240 / 1.240   UNIT_SHEET_VIEW_REPORTS / _CUSTOMIZE /
//                     _CAMERA_INACTIVE toolbar icons (32x36 -> 40x45)      interface_bits_*.png
//
// Two facts fall out, and they are the whole design of this module:
//   1. DF draws its interface at a NON-INTEGER scale WITH FILTERING. Its glyph edges carry partial
//      alpha in a LOSSLESS PNG; a nearest-neighbour blit cannot produce that.
//   2. DF draws its SPRITE ART and its TEXT at THE SAME SCALE, on ONE grid. Art and text fit the
//      same factor to within 1%. DF's interface art is authored on this very 8x12 text cell
//      (SHORT_TAB is 40x24 = 5x2 cells; TAB is 40x36 = 5x3 cells), so this is not a coincidence:
//      the text cell and the art cell ARE the same cell.
//
// So the text scale is NOT a constant -- DF rescales its whole interface with the window and the
// display, and the oracle's ~1.245 belongs to the oracle's DF window, nothing more. Hard-coding it
// would be right on one screenshot and wrong on every other. The scale is DERIVED, from fact 2:
//
//      interfaceScale(document) = drawnPixels / nativePixels of the DF sprite art on that document
//
// i.e. exactly the scale DFChrome is already painting the surrounding interface art at. Text then
// tracks the art for free, on any window size, forever. See interfaceScale() below.
//
// ---------------------------------------------------------------------------------------------------
// THE SOFTENING (after reviewing a rendered 0% / 35% / 50% / 70% / 100% ladder): 50%.
//
// Full bilinear (100%) was judged TOO SOFT, "especially on straight vertical/horizontal strokes";
// pure nearest (0%) was too hard. The shipped glyph is therefore a LINEAR BLEND of the two:
//
//      glyph = (1 - SOFTEN) * nearest(cell, s)  +  SOFTEN * bilinear(cell, s)          SOFTEN = 0.5
//
// The blend CANNOT be baked into the 8x12 atlas -- it is scale-dependent (at s == 1 the two
// operands are byte-identical, so an atlas-baked blend would be the identity). It IS baked ONCE PER
// SCALE, into a PRE-SCALED ATLAS built the moment a new interface scale first appears (bakeAtlas()).
// Everything downstream of that is a 1:1 nearest blit:
//
//      atlas load  ->  padded 8x12 atlas (once)
//      scale seen  ->  PRE-SCALED, PRE-BLENDED atlas at cw x ch  (once per scale; 512 blits)
//      cache miss  ->  ONE nearest drawImage per glyph, out of the pre-scaled atlas
//      draw path   ->  ONE drawImage per label, of the LRU-cached label canvas.  ZERO getImageData.
//
// So the draw path carries no filtering cost at all, and the per-label draw-call count is EXACTLY
// what the 6.8ms-p95 benchmark measured. SOFTEN is the one tunable; it is exported on the API.
// ===================================================================================================
(function (root) {
  "use strict";

  const CELL_W = 8, CELL_H = 12, CACHE_LIMIT = 256;
  // the decision, off a rendered ladder. 0 = pure nearest (today, and what the D1 contract assumed
  // DF did); 1 = pure bilinear (what DF's edges look closest to, but reads too soft on straight
  // stems). This is the ONLY taste number in this file and it is meant to be turned.
  const SOFTEN = 0.5;
  const SCALED_ATLAS_LIMIT = 4;   // one per live interface scale; a resize churns at most a few
  const MAX_LIVE_CANVASES = 50;
  const MAX_DIRTY_ROOTS_PER_FRAME = 25;
  const PREFETCH_MARGIN = 96;
  // Padded atlas: each 8x12 cell gets a 1px fully-transparent gutter, so the cell pitch is 10x14.
  // This exists ONLY because we now sample the atlas with bilinear filtering at non-integer scales.
  // A filtered drawImage of a tight 8x12 sub-rect bleeds the NEIGHBOURING glyph's ink in along the
  // shared edge; with a transparent gutter the filter blends toward alpha 0 instead, which is the
  // correct boundary condition and is what DF's own per-glyph quads do. Built ONCE at atlas load.
  const PAD = 1, PITCH_W = CELL_W + PAD * 2, PITCH_H = CELL_H + PAD * 2;
  const MIN_SCALE = 0.5, MAX_SCALE = 8;
  // The query is deliberately versioned. The bytes still come from the player's own DF install;
  // no Bay 12 art is copied into this repository. Both the plugin and Studio routes ignore the
  // query while the browser gets an explicit cache identity for this renderer contract.
  const ATLAS_URL = "/dfart/curses_640x300.png?v=dwfui-bitmap-v1";
  const CP437 = [
    0x0000,0x263a,0x263b,0x2665,0x2666,0x2663,0x2660,0x2022,0x25d8,0x25cb,0x25d9,0x2642,0x2640,0x266a,0x266b,0x263c,
    0x25ba,0x25c4,0x2195,0x203c,0x00b6,0x00a7,0x25ac,0x21a8,0x2191,0x2193,0x2192,0x2190,0x221f,0x2194,0x25b2,0x25bc,
    0x0020,0x0021,0x0022,0x0023,0x0024,0x0025,0x0026,0x0027,0x0028,0x0029,0x002a,0x002b,0x002c,0x002d,0x002e,0x002f,
    0x0030,0x0031,0x0032,0x0033,0x0034,0x0035,0x0036,0x0037,0x0038,0x0039,0x003a,0x003b,0x003c,0x003d,0x003e,0x003f,
    0x0040,0x0041,0x0042,0x0043,0x0044,0x0045,0x0046,0x0047,0x0048,0x0049,0x004a,0x004b,0x004c,0x004d,0x004e,0x004f,
    0x0050,0x0051,0x0052,0x0053,0x0054,0x0055,0x0056,0x0057,0x0058,0x0059,0x005a,0x005b,0x005c,0x005d,0x005e,0x005f,
    0x0060,0x0061,0x0062,0x0063,0x0064,0x0065,0x0066,0x0067,0x0068,0x0069,0x006a,0x006b,0x006c,0x006d,0x006e,0x006f,
    0x0070,0x0071,0x0072,0x0073,0x0074,0x0075,0x0076,0x0077,0x0078,0x0079,0x007a,0x007b,0x007c,0x007d,0x007e,0x2302,
    0x00c7,0x00fc,0x00e9,0x00e2,0x00e4,0x00e0,0x00e5,0x00e7,0x00ea,0x00eb,0x00e8,0x00ef,0x00ee,0x00ec,0x00c4,0x00c5,
    0x00c9,0x00e6,0x00c6,0x00f4,0x00f6,0x00f2,0x00fb,0x00f9,0x00ff,0x00d6,0x00dc,0x00a2,0x00a3,0x00a5,0x20a7,0x0192,
    0x00e1,0x00ed,0x00f3,0x00fa,0x00f1,0x00d1,0x00aa,0x00ba,0x00bf,0x2310,0x00ac,0x00bd,0x00bc,0x00a1,0x00ab,0x00bb,
    0x2591,0x2592,0x2593,0x2502,0x2524,0x2561,0x2562,0x2556,0x2555,0x2563,0x2551,0x2557,0x255d,0x255c,0x255b,0x2510,
    0x2514,0x2534,0x252c,0x251c,0x2500,0x253c,0x255e,0x255f,0x255a,0x2554,0x2569,0x2566,0x2560,0x2550,0x256c,0x2567,
    0x2568,0x2564,0x2565,0x2559,0x2558,0x2552,0x2553,0x256b,0x256a,0x2518,0x250c,0x2588,0x2584,0x258c,0x2590,0x2580,
    0x03b1,0x00df,0x0393,0x03c0,0x03a3,0x03c3,0x00b5,0x03c4,0x03a6,0x0398,0x03a9,0x03b4,0x221e,0x03c6,0x03b5,0x2229,
    0x2261,0x00b1,0x2265,0x2264,0x2320,0x2321,0x00f7,0x2248,0x00b0,0x2219,0x00b7,0x221a,0x207f,0x00b2,0x25a0,0x00a0,
  ];
  const unicodeToCell = new Map(CP437.map((cp, cell) => [cp, cell]));
  const cache = new Map();
  const scaledAtlases = new Map();       // "1.2450" -> { canvas, cw, ch }  -- the pre-blended bakes
  const documentStates = new WeakMap();
  let atlas = null, loadPromise = null, loadError = null;
  let loadMilliseconds = null, cacheHits = 0, cacheMisses = 0;
  const MAX_REVIEW_CANVASES = 120;       // Studio only: one visible fidelity board, never the game
  let budgetDeferrals = 0, canvasEvictions = 0, scheduledBatches = 0;
  let liveCanvases = 0, liveCanvasBytes = 0, unchangedSkips = 0;
  let atlasBakes = 0, atlasBakeMilliseconds = 0;

  function cellsFor(text) {
    const cells = [];
    for (const char of String(text == null ? "" : text)) {
      const cell = unicodeToCell.get(char.codePointAt(0));
      if (cell == null || cell === 0) return null;
      cells.push(cell);
    }
    return cells;
  }

  function load(doc) {
    if (atlas) return Promise.resolve(atlas);
    if (loadPromise) return loadPromise;
    if (!doc || !doc.createElement || typeof root.Image !== "function")
      return Promise.reject(new Error("bitmap text needs a browser document"));
    const clock = root.performance && root.performance.now ? root.performance : Date;
    const loadStarted = clock.now();
    loadPromise = new Promise((resolve, reject) => {
      const image = new root.Image();
      image.addEventListener("load", () => {
        try {
          if (image.naturalWidth !== 128 || image.naturalHeight !== 192)
            throw new Error(`unexpected DF glyph atlas size ${image.naturalWidth}x${image.naturalHeight}`);
          const canvas = doc.createElement("canvas");
          canvas.width = 128; canvas.height = 192;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, 128, 192);
          for (let p = 0; p < pixels.data.length; p += 4) {
            const on = pixels.data[p + 3] >= 128 &&
              (0.299 * pixels.data[p] + 0.587 * pixels.data[p + 1] + 0.114 * pixels.data[p + 2]) >= 128;
            pixels.data[p] = pixels.data[p + 1] = pixels.data[p + 2] = 255;
            pixels.data[p + 3] = on ? 255 : 0;
          }
          ctx.putImageData(pixels, 0, 0);
          // ONCE, at load: re-lay the 256 cells onto the gutter-padded pitch. This is the ONLY
          // readback/blit pass in the module and it never runs again -- no getImageData and no
          // per-glyph work ever happens on the draw path.
          const padded = doc.createElement("canvas");
          padded.width = 16 * PITCH_W; padded.height = 16 * PITCH_H;
          const pctx = padded.getContext("2d");
          pctx.imageSmoothingEnabled = false;
          for (let cell = 0; cell < 256; cell++) {
            const sx = (cell % 16) * CELL_W, sy = Math.floor(cell / 16) * CELL_H;
            const dx = (cell % 16) * PITCH_W + PAD, dy = Math.floor(cell / 16) * PITCH_H + PAD;
            pctx.drawImage(canvas, sx, sy, CELL_W, CELL_H, dx, dy, CELL_W, CELL_H);
          }
          atlas = padded; loadError = null; loadMilliseconds = clock.now() - loadStarted; resolve(padded);
        } catch (error) { loadError = error; reject(error); }
      }, { once: true });
      image.addEventListener("error", () => {
        loadError = new Error(`could not load DF glyph atlas at ${ATLAS_URL}`);
        reject(loadError);
      }, { once: true });
      image.src = ATLAS_URL;
    });
    return loadPromise;
  }

  function touch(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return value;
  }

  function clampScale(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, n));
  }
  function isIntegral(s) { return Math.abs(s - Math.round(s)) < 1e-6; }

  // The scale DFChrome is ACTUALLY painting DF's interface art at, on this document. A sprite canvas
  // is sized rec.w x rec.h times the scale DFChrome chose, so drawn/native IS that scale, read back
  // off the DOM -- no new source of truth, no constant, and it moves when DF's window moves. Cropped
  // blits (data-dwfui-sprite-crop) are sub-rects of a cell, not scaled cells, so they are not samples.
  function measureSpriteScale(doc) {
    const chrome = root && root.DFChrome;
    if (!doc || !doc.querySelectorAll || !chrome || !chrome.getCell) return null;
    const canvases = doc.querySelectorAll("canvas.df-chrome-icon");
    for (const canvas of canvases) {
      const host = canvas.parentNode;
      if (!host || !host.getAttribute || host.getAttribute("data-dwfui-sprite-crop")) continue;
      const token = host.getAttribute("data-dwfui-sprite");
      const rec = token && chrome.getCell(token);
      if (!rec || !rec.w || !rec.h || !canvas.width || !canvas.height) continue;
      const sx = canvas.width / rec.w, sy = canvas.height / rec.h;
      // A letterboxed or clipped blit is not a uniform scale and must not be believed.
      if (!Number.isFinite(sx) || !Number.isFinite(sy) || Math.abs(sx - sy) > 0.02) continue;
      return clampScale(sx);
    }
    return null;
  }

  // Precedence: an explicit document override (the interface owner's ONE knob, and the only place a
  // number may be stated) beats the measurement; the measurement beats a 1:1 fail-open. Memoised per
  // document, and retried only while the art has not painted yet, so this costs one querySelectorAll
  // per paint PASS -- never per label, never per glyph.
  // ---- THE IN-CLIENT UI-SCALE SLIDER ------------------------------------------------------------
  // dwf.css applies `zoom: var(--ui-scale)` to #hud/#clientPanel/... -- so whatever we hand the
  // browser gets RESAMPLED by the slider on top of DF's interface scale. Rasterising at 1x and then
  // zooming is the worst case for sharpness (it is a plain bilinear upscale of a finished bitmap).
  // So we rasterise the label at interfaceScale x zoom into the canvas BACKING STORE and pin its CSS
  // box to the unzoomed size: the zoom then scales a box we already drew at its target density --
  // the same trick a HiDPI canvas plays with devicePixelRatio. The slider gets CRISPER, not blurrier,
  // and it still MULTIPLIES cleanly on top of the base interface scale.
  function zoomFor(doc) {
    const view = doc && doc.defaultView;
    const el = doc && doc.documentElement;
    if (!view || !el || typeof view.getComputedStyle !== "function") return 1;
    let raw = null;
    try { raw = view.getComputedStyle(el).getPropertyValue("--ui-scale"); } catch (_) { return 1; }
    const n = Number(String(raw == null ? "" : raw).trim());
    return Number.isFinite(n) && n > 0 ? clampScale(n) : 1;
  }

  function interfaceScale(doc) {
    const d = doc || (root && root.document);
    if (!d) return 1;
    const state = stateFor(d);
    const el = d.documentElement;
    const raw = el && el.getAttribute ? el.getAttribute("data-dwfui-interface-scale") : null;
    if (raw != null && raw !== "" && Number.isFinite(Number(raw)) && Number(raw) > 0)
      return (state.scale = clampScale(Number(raw)));
    if (state.scale != null) return state.scale;
    const measured = measureSpriteScale(d);
    if (measured == null) return 1;   // art not painted yet: fail open at 1:1 and retry next pass
    return (state.scale = measured);
  }

  // ---- THE BAKE. Once per interface scale; NEVER on the draw path. ------------------------------
  // A 16x16 grid of cells already AT the target size and already carrying the 50% blend, so every
  // later glyph blit is a 1:1 nearest copy of a finished cell.
  //
  // The blend is a TRUE LINEAR interpolation: both layers are drawn with globalCompositeOperation
  // "lighter" (additive on PREMULTIPLIED pixels) at complementary alphas, which yields exactly
  //     (1 - SOFTEN) * nearest(cell, s)  +  SOFTEN * bilinear(cell, s)
  // in colour AND in alpha. Drawing the soft layer over the hard one with plain source-over would
  // NOT be that: source-over can only ADD coverage, never remove it, so it produces a HALOED nearest
  // glyph instead of the blend the owner reviewed on the ladder. The atlas is pre-tinted pure white, so the
  // additive pass can neither overflow nor fringe.
  //
  // AT AN INTEGER SCALE THERE IS NO BLEND: nearest and bilinear are the same image there, and we
  // never invent softness DF does not have. That is what keeps the approved 1x FONT card exact.
  function bakeAtlas(doc, s) {
    const key = s.toFixed(4);
    const hit = scaledAtlases.get(key);
    if (hit) { scaledAtlases.delete(key); scaledAtlases.set(key, hit); return hit; }
    const clock = root.performance && root.performance.now ? root.performance : Date;
    const started = clock.now();
    const cw = Math.max(1, Math.round(CELL_W * s)), ch = Math.max(1, Math.round(CELL_H * s));
    const canvas = doc.createElement("canvas");
    canvas.width = 16 * cw; canvas.height = 16 * ch;
    const ctx = canvas.getContext("2d");
    const soften = isIntegral(s) ? 0 : SOFTEN;
    ctx.globalCompositeOperation = "lighter";
    for (let cell = 0; cell < 256; cell++) {
      // Source out of the GUTTER-PADDED atlas: a FILTERED read of a tight 8x12 sub-rect bleeds the
      // neighbouring glyph's ink in along the shared edge. The transparent gutter makes the filter
      // blend toward alpha 0 instead -- the correct boundary, and what DF's own per-glyph quads do.
      const sx = (cell % 16) * PITCH_W + PAD, sy = Math.floor(cell / 16) * PITCH_H + PAD;
      const dx = (cell % 16) * cw, dy = Math.floor(cell / 16) * ch;
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 1 - soften;
      ctx.drawImage(atlas, sx, sy, CELL_W, CELL_H, dx, dy, cw, ch);
      if (soften > 0) {
        ctx.imageSmoothingEnabled = true;
        ctx.globalAlpha = soften;
        ctx.drawImage(atlas, sx, sy, CELL_W, CELL_H, dx, dy, cw, ch);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    const baked = { canvas, cw, ch, scale: s, soften };
    scaledAtlases.set(key, baked);
    while (scaledAtlases.size > SCALED_ATLAS_LIMIT) scaledAtlases.delete(scaledAtlases.keys().next().value);
    atlasBakes++; atlasBakeMilliseconds += clock.now() - started;
    return baked;
  }

  function render(doc, text, color, scale, ifaceScale) {
    const cells = cellsFor(text);
    if (!cells || !atlas) return null;
    // The attribute scale stays exactly what it always was: an INTEGER label multiplier (a 2x
    // header). DF's interface scale multiplies it. Neither is a magic number; both are derived.
    const mul = Math.max(1, Math.min(4, Math.round(Number(scale) || 1)));
    const s = clampScale(mul * (ifaceScale == null ? interfaceScale(doc) : clampScale(ifaceScale)));
    const key = `${s}\u0000${color}\u0000${text}`;
    if (cache.has(key)) { cacheHits++; return touch(key, cache.get(key)); }
    cacheMisses++;
    const baked = bakeAtlas(doc, s);
    const canvas = doc.createElement("canvas");
    // DF's cell IS the advance: one integer step per glyph, exactly as a fixed-cell grid works, and
    // at the oracle's scale it lands on the measured 10x15 cell. Stepping by a FRACTIONAL advance
    // instead would leave glyphs on half-pixels and re-blur what the bake just fixed.
    canvas.width = Math.max(1, cells.length * baked.cw);
    canvas.height = baked.ch;
    const ctx = canvas.getContext("2d");
    // 1:1 out of the PRE-SCALED, PRE-BLENDED atlas -- NO resampling happens here, at any scale. All
    // of the filtering cost, and the 50% blend, was paid once in bakeAtlas().
    ctx.imageSmoothingEnabled = false;
    cells.forEach((cell, i) => ctx.drawImage(baked.canvas,
      (cell % 16) * baked.cw, Math.floor(cell / 16) * baked.ch, baked.cw, baked.ch,
      i * baked.cw, 0, baked.cw, baked.ch));
    // source-in keeps the (now partial) alpha and replaces only RGB, so a blended edge pixel emerges
    // as the ink colour at partial coverage -- exactly what DF composites. COLOUR IS NOT THE BUG and
    // is NOT touched: native tab labels are pure #ffffff and so are ours, before and after.
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color || "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
    return touch(key, canvas);
  }

  function nodesWithin(host) {
    const nodes = [];
    if (host && host.matches && host.matches("[data-dwfui-bitmap-text]")) nodes.push(host);
    if (host && host.querySelectorAll)
      host.querySelectorAll("[data-dwfui-bitmap-text]").forEach(node => nodes.push(node));
    return nodes;
  }

  function stateFor(doc) {
    let state = documentStates.get(doc);
    if (!state) {
      state = { maxLive: MAX_LIVE_CANVASES, live: new Map(), observer: null,
        pending: new Set(), frame: 0, waiters: [], scale: null };
      documentStates.set(doc, state);
    }
    return state;
  }

  function isConnected(node) {
    return typeof node.isConnected === "boolean" ? node.isConnected : true;
  }

  function isNearViewport(node, doc) {
    if (node && node.hasAttribute && node.hasAttribute("data-dwfui-bitmap-eager")) return true;
    if (!node || typeof node.getBoundingClientRect !== "function") return true;
    const rect = node.getBoundingClientRect();
    const view = (doc && doc.defaultView) || root;
    const width = Number(view && view.innerWidth) || Number(doc && doc.documentElement && doc.documentElement.clientWidth) || 0;
    const height = Number(view && view.innerHeight) || Number(doc && doc.documentElement && doc.documentElement.clientHeight) || 0;
    if (!width || !height) return true;
    return rect.bottom >= -PREFETCH_MARGIN && rect.right >= -PREFETCH_MARGIN &&
      rect.top <= height + PREFETCH_MARGIN && rect.left <= width + PREFETCH_MARGIN;
  }

  // ---- THE INFINITE REPAINT LOOP (idempotent deferral writes) ----------------------------------
  // MEASURED on an IDLE page: long tasks doubling 361 -> 1,654 -> 3,639 -> 7,287 -> 23,138 ms,
  // Runtime.evaluate timing out, and 180,720 MutationObserver records in 10 seconds -- ALL of them
  // `class`, ALL with IDENTICAL old and new values. A JS busy-loop, not a raster problem.
  //
  // THE MECHANISM. A label we DEFER -- because it is over the 50-canvas budget, or merely SCROLLED
  // OFFSCREEN -- used to be marked unconditionally:
  //     node.classList.remove("dwfui-bitmap-text--ready");        // even when the token is ABSENT
  //     node.setAttribute("data-dwfui-bitmap-fallback", reason);  // even when the value is UNCHANGED
  // `DOMTokenList.remove()` RE-SERIALISES the `class` attribute even when the token was not there,
  // and setAttribute fires a record even when the value does not change. DWFUI's document-wide
  // MutationObserver watches `class`, so: defer a label -> rewrite its class -> the observer
  // repaints it -> it defers again -> forever. The deferral path runs on EVERY pass, so every
  // frame re-armed the loop.
  //
  // THIS IS NOT A STUDIO-ONLY BUG. Any bitmap label scrolled below the fold in the live game takes
  // exactly this path, so ANY SCROLLABLE LIST COULD WEDGE THE PLAYER'S TAB.
  //
  // THE FIX: the deferral writes are IDEMPOTENT. Touch the DOM only when the DOM would actually
  // change. (mountDom's observer additionally drops no-op attribute records -- belt and braces.)
  // Measured after: scheduledBatches 163,844 -> 11.
  function markFallback(node, reason) {
    if (!node) return;
    if (node.classList && node.classList.contains &&
        node.classList.contains("dwfui-bitmap-text--ready"))
      node.classList.remove("dwfui-bitmap-text--ready");
    if (reason && node.setAttribute && node.getAttribute &&
        node.getAttribute("data-dwfui-bitmap-fallback") !== reason)
      node.setAttribute("data-dwfui-bitmap-fallback", reason);
  }

  function noteCanvasRemoved(node, state, reason) {
    const canvas = node && node.querySelector && node.querySelector("canvas.dwfui-bitmap-canvas");
    if (canvas) {
      liveCanvases = Math.max(0, liveCanvases - 1);
      liveCanvasBytes = Math.max(0, liveCanvasBytes - canvas.width * canvas.height * 4);
      if (canvas.parentNode && canvas.parentNode.removeChild) canvas.parentNode.removeChild(canvas);
      else if (node.canvas === canvas) node.canvas = null; // deterministic harness fallback
      canvasEvictions++;
    }
    state.live.delete(node);
    markFallback(node, reason);
  }

  function prune(state, doc, keepOffscreen) {
    for (const [node] of state.live) {
      if (!isConnected(node)) noteCanvasRemoved(node, state, null);
      else if (!node.querySelector("canvas.dwfui-bitmap-canvas")) state.live.delete(node);
      else if (!keepOffscreen && !isNearViewport(node, doc)) noteCanvasRemoved(node, state, "offscreen-deferred");
    }
  }

  function reserve(node, state, doc, limit) {
    if (state.live.has(node)) {
      state.live.delete(node); state.live.set(node, true);
      return true;
    }
    const ceiling = limit == null ? state.maxLive : limit;
    prune(state, doc, ceiling === Infinity);
    if (state.live.size >= ceiling) {
      for (const [candidate] of state.live) {
        if (!isNearViewport(candidate, doc)) {
          noteCanvasRemoved(candidate, state, "offscreen-deferred");
          break;
        }
      }
    }
    if (state.live.size >= ceiling) {
      budgetDeferrals++;
      // IDEMPOTENT (see markFallback): this runs on EVERY pass for every over-budget label, so an
      // unconditional class rewrite here is the same infinite-repaint loop by another door.
      markFallback(node, "canvas-budget-deferred");
      return false;
    }
    state.live.set(node, true);
    return true;
  }

  function observeNodes(nodes, state, doc) {
    const IO = root && root.IntersectionObserver;
    if (!IO) return;
    if (!state.observer) {
      state.observer = new IO(entries => entries.forEach(entry => {
        if (entry.isIntersecting || entry.target.hasAttribute("data-dwfui-bitmap-eager")) schedule(entry.target);
        else noteCanvasRemoved(entry.target, state, "offscreen-deferred");
      }), { root: null, rootMargin: `${PREFETCH_MARGIN}px` });
    }
    nodes.forEach(node => state.observer.observe(node));
  }

  function reportStatus(doc, ok, error) {
    const rootElement = doc && doc.documentElement;
    if (rootElement && rootElement.setAttribute)
      rootElement.setAttribute("data-dwfui-bitmap-text-status", ok ? "native" : "fallback");
    if (!ok && doc && !doc.__dwfuiBitmapWarningLogged) {
      doc.__dwfuiBitmapWarningLogged = true;
      if (root.console && root.console.error)
        root.console.error("DWFUI bitmap text fell back to DOM text:", error && (error.message || error));
    }
  }

  function paint(rootNode, options) {
    const doc = (rootNode && rootNode.ownerDocument) ||
      (rootNode && rootNode.nodeType === 9 ? rootNode : root.document);
    const nodes = nodesWithin(rootNode || doc);
    if (!nodes.length) return Promise.resolve(0);
    const state = stateFor(doc);
    const unbounded = !!(options && options.unboundedBenchmark);
    if (!unbounded) observeNodes(nodes, state, doc);
    return load(doc).then(() => {
      reportStatus(doc, true);
      // ONCE per paint pass -- not per label. Everything on a document shares DF's one interface
      // scale, exactly as DF itself does. The slider's zoom is read once here too.
      const iface = interfaceScale(doc);
      const zoom = zoomFor(doc);
      const raster = clampScale(iface * zoom);
      let painted = 0;
      for (const node of nodes) {
        if (!isConnected(node)) continue;
        if (!unbounded && !isNearViewport(node, doc)) {
          noteCanvasRemoved(node, state, "offscreen-deferred");
          continue;
        }
        const text = node.getAttribute("data-dwfui-bitmap-text") || "";
        const mul = node.getAttribute("data-dwfui-bitmap-scale") || "1";
        // The dirty key tracks the EFFECTIVE RASTER scale. If it tracked only the label multiplier, a
        // DF window resize -- or a nudge of the UI-scale slider -- would change every glyph's size and
        // leave every cached label stale.
        const scale = `${mul}@${raster.toFixed(4)}`;
        if (!cellsFor(text)) {
          markFallback(node, "unsupported-character");   // IDEMPOTENT -- runs on every pass
          continue;
        }
        const style = root.getComputedStyle ? root.getComputedStyle(node) : null;
        const color = style ? style.color : "#fff";
        const key = `${scale}\u0000${color}\u0000${text}`;
        if (node.__dwfuiBitmapKey === key && node.querySelector("canvas.dwfui-bitmap-canvas")) {
          unchangedSkips++;
          reserve(node, state, doc, unbounded ? Infinity : null);
          continue;
        }
        if (!reserve(node, state, doc, unbounded ? Infinity : null)) continue;
        const source = render(doc, text, color, mul, raster);
        if (!source) continue;
        let target = node.querySelector("canvas.dwfui-bitmap-canvas");
        if (!target) {
          target = doc.createElement("canvas");
          target.className = "dwfui-bitmap-canvas";
          target.setAttribute("aria-hidden", "true");
          node.appendChild(target);
          liveCanvases++;
        } else {
          liveCanvasBytes = Math.max(0, liveCanvasBytes - target.width * target.height * 4);
        }
        target.width = source.width; target.height = source.height;
        liveCanvasBytes += target.width * target.height * 4;
        // Pin the CSS box to the UNZOOMED size so the slider's `zoom` scales a canvas we already
        // rasterised at its target density. With zoom == 1 the box is the backing store, exactly as
        // before -- no layout change on the default path.
        if (target.style) {
          target.style.width = zoom === 1 ? "" : `${source.width / zoom}px`;
          target.style.height = zoom === 1 ? "" : `${source.height / zoom}px`;
        }
        const ctx = target.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.drawImage(source, 0, 0);
        node.__dwfuiBitmapKey = key;
        node.removeAttribute("data-dwfui-bitmap-fallback");
        node.classList.add("dwfui-bitmap-text--ready");
        painted++;
      }
      return painted;
    }).catch(error => {
      reportStatus(doc, false, error);
      nodes.forEach(node => markFallback(node, "atlas-unavailable"));   // IDEMPOTENT
      return 0;
    });
  }

  // The decision lab intentionally measures hostile 500/1,200-canvas cases. Keep that bypass
  // impossible on a production page: it requires both the Studio pathname and its dedicated stage.
  function paintBenchmark(rootNode) {
    const doc = rootNode && rootNode.ownerDocument;
    const pathname = String(doc && doc.location && doc.location.pathname || "");
    const isStage = rootNode && rootNode.hasAttribute && rootNode.hasAttribute("data-fnd-benchmark-stage");
    if (!isStage || !/\/tools\/ui-lab\//.test(pathname))
      return Promise.reject(new Error("unbounded bitmap painting is restricted to the Parity Studio benchmark stage"));
    return paint(rootNode, { unboundedBenchmark: true });
  }

  // Coalesce DOM mutation bursts into one paint pass per animation frame. Direct paint() remains
  // available for deterministic tests and explicit callers; production DWFUI uses schedule().
  function schedule(rootNode) {
    const doc = (rootNode && rootNode.ownerDocument) ||
      (rootNode && rootNode.nodeType === 9 ? rootNode : root.document);
    if (!doc) return Promise.resolve(0);
    const state = stateFor(doc);
    state.pending.add(rootNode || doc);
    return new Promise(resolve => {
      state.waiters.push(resolve);
      if (state.frame) return;
      const request = run => {
        const raf = (doc.defaultView && doc.defaultView.requestAnimationFrame) || root.requestAnimationFrame;
        if (typeof raf === "function") state.frame = raf(run);
        else { state.frame = 1; Promise.resolve().then(run); }
      };
      const run = async () => {
        state.frame = 0; scheduledBatches++;
        const pending = [...state.pending].slice(0, MAX_DIRTY_ROOTS_PER_FRAME);
        pending.forEach(node => state.pending.delete(node));
        let count = 0;
        try {
          for (const node of pending) count += await paint(node);
        } catch (error) {
          reportStatus(doc, false, error);
        }
        if (state.pending.size) {
          request(run);
          return;
        }
        const waiters = state.waiters.splice(0);
        waiters.forEach(done => done(count));
      };
      request(run);
    });
  }

  function configure(doc, options) {
    const state = stateFor(doc);
    const requested = Number(options && options.maxLiveCanvases);
    const pathname = String(doc && doc.location && doc.location.pathname || "");
    const ceiling = /\/tools\/ui-lab\//.test(pathname) ? MAX_REVIEW_CANVASES : MAX_LIVE_CANVASES;
    state.maxLive = Number.isFinite(requested) ? Math.max(1, Math.min(ceiling, Math.floor(requested))) : MAX_LIVE_CANVASES;
    // An explicit interface scale, or `null` to drop the memo and re-measure the art next pass.
    if (options && "interfaceScale" in options)
      state.scale = options.interfaceScale == null ? null : clampScale(options.interfaceScale);
    prune(state, doc, false);
    return state.maxLive;
  }

  function stats(doc) {
    const d = doc || (root && root.document);
    const documentState = d ? stateFor(d) : null;
    return { loaded: !!atlas, error: loadError && loadError.message, loadMilliseconds,
      cacheSize: cache.size, cacheLimit: CACHE_LIMIT, cacheHits, cacheMisses,
      maxLiveCanvases: documentState ? documentState.maxLive : MAX_LIVE_CANVASES,
      productionMaxLiveCanvases: MAX_LIVE_CANVASES, liveCanvases, liveCanvasBytes,
      budgetDeferrals, canvasEvictions, scheduledBatches, unchangedSkips,
      soften: SOFTEN, atlasBakes, atlasBakeMilliseconds,
      scaledAtlases: [...scaledAtlases.values()].map(a => `${a.scale}:${a.cw}x${a.ch}`),
      interfaceScale: d ? interfaceScale(d) : 1, uiZoom: d ? zoomFor(d) : 1 };
  }
  // The scaled atlases are a function of the ATLAS and the scale, not of the label set, so a label
  // cache clear must drop them too or a test that reseeds the atlas keeps blitting the stale bake.
  function clearCache() {
    cache.clear(); scaledAtlases.clear();
    cacheHits = 0; cacheMisses = 0;
  }
  async function benchmark(doc, opts) {
    const o = opts || {};
    const count = Math.max(1, Math.round(Number(o.count) || 1200));
    const unique = Math.max(1, Math.round(Number(o.unique) || 400));
    await load(doc);
    clearCache();
    const clock = root.performance && root.performance.now ? root.performance : Date;
    const start = clock.now();
    for (let i = 0; i < count; i++) render(doc, `Dwarf ${i % unique} current task`, "rgb(255,255,255)", 1);
    return { count, unique, milliseconds: clock.now() - start, cacheSize: cache.size, cacheLimit: CACHE_LIMIT };
  }
  const api = { CELL_W, CELL_H, CACHE_LIMIT, MAX_LIVE_CANVASES, MAX_REVIEW_CANVASES, MAX_DIRTY_ROOTS_PER_FRAME,
    PREFETCH_MARGIN, ATLAS_URL, PAD, PITCH_W, PITCH_H, MIN_SCALE, MAX_SCALE, SOFTEN,
    CP437, cellsFor, load, render, paint, paintBenchmark, schedule, configure, benchmark, stats,
    clearCache, interfaceScale, measureSpriteScale, zoomFor, bakeAtlas };
  root.DFBitmapText = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
