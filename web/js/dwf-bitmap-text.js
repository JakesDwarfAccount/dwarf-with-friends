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

// The real DOM text is the fail-open layer: dwf-dwfui.css hides it only under .dwfui-bitmap-text--ready,
// added once a bitmap label has painted. Hiding it up front loses every label when the atlas 404s.
(function (root) {
  "use strict";

  const DwfUtil = root.DwfUtil || (typeof module === "object" && module.require
    ? module.require("./dwf-util.js") : null);
  const CELL_W = 8, CELL_H = 12, CACHE_LIMIT = 256;
  // 0 = pure nearest, 1 = pure bilinear. The only taste number in this file.
  const SOFTEN = 0.5;
  const SCALED_ATLAS_LIMIT = 4;   // one per live interface scale; a resize churns at most a few
  const MAX_LIVE_CANVASES = 200;   // a full panel shows 60+ labels; each canvas is about 5 KB
  const MAX_DIRTY_ROOTS_PER_FRAME = 25;
  const PREFETCH_MARGIN = 96;
  // A 1px fully transparent gutter per cell, so the pitch is 10x14: bakeAtlas's soften pass reads with
  // smoothing ON, and a filtered read of a tight 8x12 sub-rect bleeds the neighbouring glyph's ink.
  const PAD = 1, PITCH_W = CELL_W + PAD * 2, PITCH_H = CELL_H + PAD * 2;
  const MIN_SCALE = 0.5, MAX_SCALE = 8;
  // The bytes come from the player's DF install, not this repo, so no content hash can bust this URL.
  const ATLAS_URL = "/dfart/curses_640x300.png";
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
  // ---- CP437 case fold --------------------------------------------------------------------------
  for (let cell = 0; cell < CP437.length; cell++) {
    const lower = String.fromCodePoint(CP437[cell]);
    const upper = lower.toUpperCase();
    if (upper === lower || Array.from(upper).length !== 1) continue;
    const cp = upper.codePointAt(0);
    if (!unicodeToCell.has(cp)) unicodeToCell.set(cp, cell);
  }
  const cache = new Map();
  const scaledAtlases = new Map();       // "1.2450" -> { canvas, cw, ch }  -- the pre-blended bakes
  const documentStates = new WeakMap();
  let atlas = null, loadPromise = null, loadError = null;
  let loadMilliseconds = null, cacheHits = 0, cacheMisses = 0;
  let budgetDeferrals = 0, canvasEvictions = 0, scheduledBatches = 0;
  let liveCanvases = 0, liveCanvasBytes = 0, unchangedSkips = 0;
  let atlasBakes = 0, atlasBakeMilliseconds = 0;

  // Keep cached canvases in the module document so removing a child iframe cannot invalidate them.
  function backingDocument(doc) {
    const stable = root && root.document;
    return stable && typeof stable.createElement === "function" ? stable : doc;
  }

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
          const canvas = backingDocument(doc).createElement("canvas");
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
          // ONCE, at load: re-lay the 256 cells onto the gutter-padded pitch. The only readback/blit pass.
          const padded = backingDocument(doc).createElement("canvas");
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
    return DwfUtil.clamp(n, MIN_SCALE, MAX_SCALE);
  }
  function isIntegral(s) { return Math.abs(s - Math.round(s)) < 1e-6; }
  // THE ONE CELL FORMULA. bakeAtlas, render() and measure() all step by it, so a measurement can
  // never disagree with the raster it is measuring.
  function cellPx(base, s) { return Math.max(1, Math.round(base * s)); }

  // The scale DFChrome is ACTUALLY painting DF's interface art at, read back off the DOM -- never a
  // constant. Cropped blits (data-dwfui-sprite-crop) are sub-rects of a cell, so they are not samples.
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

  function zoomFor(doc) {
    const view = doc && doc.defaultView;
    const el = doc && doc.documentElement;
    if (!view || !el || typeof view.getComputedStyle !== "function") return 1;
    let raw;
    try { raw = view.getComputedStyle(el).getPropertyValue("--ui-scale"); } catch { return 1; }
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

  // ---- THE BAKE. Once per interface scale; NEVER on the draw path. -------------------------------
  // Both layers composite with "lighter" at complementary alphas; source-over only ADDS coverage and haloes.
  function bakeAtlas(doc, s) {
    const key = s.toFixed(4);
    const hit = scaledAtlases.get(key);
    if (hit) { scaledAtlases.delete(key); scaledAtlases.set(key, hit); return hit; }
    const clock = root.performance && root.performance.now ? root.performance : Date;
    const started = clock.now();
    const cw = cellPx(CELL_W, s), ch = cellPx(CELL_H, s);
    const canvas = backingDocument(doc).createElement("canvas");
    canvas.width = 16 * cw; canvas.height = 16 * ch;
    const ctx = canvas.getContext("2d");
    const soften = isIntegral(s) ? 0 : SOFTEN;
    ctx.globalCompositeOperation = "lighter";
    for (let cell = 0; cell < 256; cell++) {
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

  // ---- MEASUREMENT ---------------------------------------------------------------------------------
  function glyphCell(doc, scale, ifaceScale) {
    const mul = Math.max(1, Math.min(4, Math.round(Number(scale) || 1)));
    const s = clampScale(mul * (ifaceScale == null ? interfaceScale(doc) : clampScale(ifaceScale)));
    return { mul, scale: s, cw: cellPx(CELL_W, s), ch: cellPx(CELL_H, s) };
  }

  function measure(text, opts) {
    const o = opts || {};
    const doc = o.doc || (root && root.document) || null;
    const value = String(text == null ? "" : text);
    const chars = Array.from(value).length;
    const iface = o.interfaceScale == null ? (doc ? interfaceScale(doc) : 1) : clampScale(o.interfaceScale);
    const zoom = o.zoom == null ? (doc ? zoomFor(doc) : 1) : clampScale(o.zoom);
    const raster = clampScale(iface * zoom);
    const cell = glyphCell(doc, o.scale, raster);
    return { text: value, cells: chars, renderable: !!cellsFor(value),
      labelScale: cell.mul, scale: cell.scale, interfaceScale: iface, zoom,
      cellW: cell.cw, cellH: cell.ch,
      width: chars * cell.cw, height: cell.ch,
      cssWidth: (chars * cell.cw) / zoom, cssHeight: cell.ch / zoom };
  }

  // The inverse: how many whole CP437 cells fit in a pixel box at this document's raster.
  function cellsInPx(pixels, opts) {
    const m = measure("", opts);
    const n = Math.floor(Number(pixels) / m.cellW);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function render(doc, text, color, scale, ifaceScale) {
    const cells = cellsFor(text);
    if (!cells || !atlas) return null;
    const s = glyphCell(doc, scale, ifaceScale).scale;
    const key = `${s}\u0000${color}\u0000${text}`;
    if (cache.has(key)) { cacheHits++; return touch(key, cache.get(key)); }
    cacheMisses++;
    const baked = bakeAtlas(doc, s);
    const canvas = backingDocument(doc).createElement("canvas");
    // DF's cell IS the advance: one integer step per glyph. A fractional advance would re-blur the bake.
    canvas.width = Math.max(1, cells.length * baked.cw);
    canvas.height = baked.ch;
    const ctx = canvas.getContext("2d");
    // 1:1 out of the PRE-SCALED, PRE-BLENDED atlas -- no resampling happens here, at any scale.
    ctx.imageSmoothingEnabled = false;
    cells.forEach((cell, i) => ctx.drawImage(baked.canvas,
      (cell % 16) * baked.cw, Math.floor(cell / 16) * baked.ch, baked.cw, baked.ch,
      i * baked.cw, 0, baked.cw, baked.ch));
    // source-in keeps the partial alpha and replaces only RGB, so a blended edge is ink at partial coverage.
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
      state = { live: new Map(), observer: null, pending: new Set(), frame: 0, waiters: [], scale: null };
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
    // A hidden subtree reports a 0x0 rect at the origin; counting it as near let hidden panels hold
    // every canvas slot while visible labels fell back to the plain font.
    if (!rect.width && !rect.height) return false;
    const view = (doc && doc.defaultView) || root;
    const width = Number(view && view.innerWidth) || Number(doc && doc.documentElement && doc.documentElement.clientWidth) || 0;
    const height = Number(view && view.innerHeight) || Number(doc && doc.documentElement && doc.documentElement.clientHeight) || 0;
    if (!width || !height) return true;
    return rect.bottom >= -PREFETCH_MARGIN && rect.right >= -PREFETCH_MARGIN &&
      rect.top <= height + PREFETCH_MARGIN && rect.left <= width + PREFETCH_MARGIN;
  }

  // ---- deferral writes -------------------------------------------------------------------------
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
    const ceiling = limit == null ? MAX_LIVE_CANVASES : limit;
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
      // IDEMPOTENT (see markFallback): this runs on EVERY pass, so an unconditional class rewrite here
      // is the same infinite-repaint loop by another door.
      markFallback(node, "canvas-budget-deferred");
      return false;
    }
    state.live.set(node, true);
    return true;
  }

  function observeNodes(nodes, state, doc) {
    const view = (doc && doc.defaultView) || root;
    const IO = view && view.IntersectionObserver;
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

  function docFor(rootNode) {
    return (rootNode && rootNode.ownerDocument) ||
      (rootNode && rootNode.nodeType === 9 ? rootNode : root.document);
  }

  function paintNow(doc, nodes, state, unbounded) {
    reportStatus(doc, true);
    // ONCE per paint pass, not per label: a document has one interface scale, exactly as DF does.
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
      // The dirty key tracks the EFFECTIVE RASTER scale, so a window resize or slider nudge invalidates it.
      const scale = `${mul}@${raster.toFixed(4)}`;
      if (!cellsFor(text)) {
        markFallback(node, "unsupported-character");   // IDEMPOTENT -- runs on every pass
        continue;
      }
      const view = (doc && doc.defaultView) || root;
      const style = view && view.getComputedStyle ? view.getComputedStyle(node) : null;
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
      // Pin the CSS box to the UNZOOMED size, so the slider's zoom scales a canvas already at that density.
      if (target.style && typeof target.style.setProperty === "function" &&
          typeof target.style.removeProperty === "function") {
        if (zoom === 1) {
          target.style.removeProperty("--dwf-bitmap-css-w");
          target.style.removeProperty("--dwf-bitmap-css-h");
        } else {
          target.style.setProperty("--dwf-bitmap-css-w", `${source.width / zoom}px`);
          target.style.setProperty("--dwf-bitmap-css-h", `${source.height / zoom}px`);
        }
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
  }

  function paint(rootNode, options) {
    const doc = docFor(rootNode);
    const nodes = nodesWithin(rootNode || doc);
    if (!nodes.length) return Promise.resolve(0);
    const state = stateFor(doc);
    const unbounded = !!(options && options.unboundedBenchmark);
    if (!unbounded) observeNodes(nodes, state, doc);
    return load(doc).then(() => paintNow(doc, nodes, state, unbounded)).catch(error => {
      reportStatus(doc, false, error);
      nodes.forEach(node => markFallback(node, "atlas-unavailable"));   // IDEMPOTENT
      return 0;
    });
  }

  // Unbounded painting only on the benchmark stage page, never on a production page.
  function paintBenchmark(rootNode) {
    const doc = rootNode && rootNode.ownerDocument;
    const pathname = String(doc && doc.location && doc.location.pathname || "");
    const isStage = rootNode && rootNode.hasAttribute && rootNode.hasAttribute("data-fnd-benchmark-stage");
    if (!isStage || !/\/tools\/ui-lab\//.test(pathname))
      return Promise.reject(new Error("unbounded bitmap painting is restricted to the Parity Studio benchmark stage"));
    return paint(rootNode, { unboundedBenchmark: true });
  }

  // Coalesce DOM mutation bursts into one paint pass per frame; production DWFUI uses schedule().
  function schedule(rootNode) {
    const doc = docFor(rootNode);
    if (!doc) return Promise.resolve(0);
    const state = stateFor(doc);
    state.pending.add(rootNode || doc);
    return new Promise(resolve => {
      state.waiters.push(resolve);
      if (state.frame) return;
      const request = run => {
        const raf = (doc.defaultView && doc.defaultView.requestAnimationFrame) || root.requestAnimationFrame;
        if (typeof raf === "function") state.frame = raf(run);
        else { state.frame = 1; root.setTimeout(run, 0); }
      };
      const run = async () => {
        state.frame = 0; scheduledBatches++;
        const pending = [...state.pending].slice(0, MAX_DIRTY_ROOTS_PER_FRAME);
        pending.forEach(node => state.pending.delete(node));
        let count = 0;
        // ONE DOM PASS PER FRAME: collect every dirty root's labels, await the atlas ONCE, then write.
        const batches = [];
        for (const node of pending) {
          const nodes = nodesWithin(node || doc);
          if (!nodes.length) continue;
          observeNodes(nodes, state, doc);
          batches.push(nodes);
        }
        try {
          if (batches.length) {
            await load(doc);
            for (const nodes of batches) count += paintNow(doc, nodes, state, false);
          }
        } catch (error) {
          reportStatus(doc, false, error);
          batches.forEach(nodes => nodes.forEach(node => markFallback(node, "atlas-unavailable")));
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

  // An explicit interface scale, or `null` to drop the memo and re-measure the art next pass.
  function configure(doc, options) {
    const state = stateFor(doc);
    if (options && "interfaceScale" in options)
      state.scale = options.interfaceScale == null ? null : clampScale(options.interfaceScale);
    prune(state, doc, false);
  }

  function stats(doc) {
    const d = doc || (root && root.document);
    return { loaded: !!atlas, error: loadError && loadError.message, loadMilliseconds,
      cacheSize: cache.size, cacheLimit: CACHE_LIMIT, cacheHits, cacheMisses,
      maxLiveCanvases: MAX_LIVE_CANVASES, liveCanvases, liveCanvasBytes,
      budgetDeferrals, canvasEvictions, scheduledBatches, unchangedSkips,
      soften: SOFTEN, atlasBakes, atlasBakeMilliseconds,
      scaledAtlases: [...scaledAtlases.values()].map(a => `${a.scale}:${a.cw}x${a.ch}`),
      interfaceScale: d ? interfaceScale(d) : 1, uiZoom: d ? zoomFor(d) : 1 };
  }
  // A label-cache clear must drop the scaled atlases too, or a reseeded atlas keeps blitting the old bake.
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
  const api = { CELL_W, CELL_H, CACHE_LIMIT, MAX_LIVE_CANVASES, MAX_DIRTY_ROOTS_PER_FRAME,
    PREFETCH_MARGIN, ATLAS_URL, PAD, PITCH_W, PITCH_H, MIN_SCALE, MAX_SCALE, SOFTEN,
    CP437, cellsFor, load, render, paint, paintBenchmark, schedule, configure, benchmark, stats,
    clearCache, interfaceScale, measureSpriteScale, zoomFor, bakeAtlas,
    cellPx, glyphCell, measure, cellsInPx };
  root.DFBitmapText = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
