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

// dwf-grid.js -- the one authority for cells -> pixels, and the only runtime writer of --dwfui-cell-*.

(function (root) {
  "use strict";

  // ---- 1. constants ------------------------------------------------------------------------------
  const BASE_CELL = { w: 8, h: 12 };
  // The window is clamped UP to this before anything else is computed.
  const WINDOW_MIN = { w: 912, h: 552 };
  // Five independent clamp sites; 114 is the global minimum grid width.
  const GRID_CLAMP = { xMin: 114, xMax: 768, yMin: 46, yMax: 256 };
  // Native's interface percentage; DWF spells the same knob as a float multiplier.
  const PCT = { min: 100, max: 400 };
  const EVENT = "dwf-grid-change";

  // Captured as locals: the browser-dependency inventory reads a `typeof root.X` compare as an
  // export, which would make DwfBoot.check() report this script loaded when it never was.
  const CustomEventCtor = (function () { try { return root.CustomEvent; } catch (_) { return null; } })();
  const MutationObserverCtor = (function () { try { return root.MutationObserver; } catch (_) { return null; } })();

  const finite = n => typeof n === "number" && isFinite(n);
  const num = (v, fallback) => (finite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  const clamp = (root.DwfUtil || (typeof require === "function" ? require("./dwf-util.js") : null)).clamp;
  // Native's integer division: C truncation toward zero.
  const idiv = (a, b) => Math.trunc(a / b);

  // ---- 2. THE ROUNDING SEAM: the grid solver, whole ------------------------------------------------
  function solveGrid(logicalW, logicalH, baseW, baseH, percentage) {
    const bw = Math.max(1, Math.trunc(num(baseW, BASE_CELL.w)));
    const bh = Math.max(1, Math.trunc(num(baseH, BASE_CELL.h)));
    const pct = clamp(Math.round(num(percentage, 100)), PCT.min, PCT.max);
    const W = Math.max(WINDOW_MIN.w, Math.trunc(num(logicalW, 0)));
    const H = Math.max(WINDOW_MIN.h, Math.trunc(num(logicalH, 0)));

    const naturalX = Math.max(1, idiv(W, bw));
    const naturalY = Math.max(1, idiv(H, bh));
    const xDrives = bw <= bh;
    const naturalDriving = xDrives ? naturalX : naturalY;

    // native's in-game zoom, which DWF does not expose
    const zoomSteps = 0;
    const desiredFor = extra => {
      const driving = Math.max(1, naturalDriving + zoomSteps + extra);
      const other = xDrives
        ? Math.max(1, Math.trunc(H * driving * bw / (W * bh)))
        : Math.max(1, Math.trunc(W * driving * bh / (H * bw)));
      return xDrives ? { x: driving, y: other } : { x: other, y: driving };
    };

    const target = idiv(naturalDriving * 100, pct);
    let steps = 0;
    while (naturalDriving + zoomSteps + steps > target) steps--;
    if (naturalDriving + zoomSteps + steps < target) steps++;
    // The clamp span bounds both terminal loops, so a pathological input can never spin.
    let desired = desiredFor(steps);
    for (let guard = 0; guard < GRID_CLAMP.xMax && (desired.x < GRID_CLAMP.xMin || desired.y < GRID_CLAMP.yMin); guard++)
      desired = desiredFor(++steps);
    for (let guard = 0; guard < GRID_CLAMP.xMax && (desired.x > GRID_CLAMP.xMax || desired.y > GRID_CLAMP.yMax); guard++)
      desired = desiredFor(--steps);

    let cw = idiv(W, Math.max(1, desired.x));
    let ch = idiv(H, Math.max(1, desired.y));
    ch = Math.min(ch, (cw / bw) * bh);
    cw = Math.min(cw, (ch / bh) * bw);
    const cellW = Math.trunc(Math.max(cw, 1));
    const cellH = Math.trunc(Math.max(ch, 1));

    const gridX = clamp(idiv(W, cellW), GRID_CLAMP.xMin, GRID_CLAMP.xMax);
    const gridY = clamp(idiv(H, cellH), GRID_CLAMP.yMin, GRID_CLAMP.yMax);
    const originX = Math.floor((W - gridX * cellW) / 2);
    const originY = Math.floor((H - gridY * cellH) / 2);
    return { cellW, cellH, gridX, gridY, originX, originY, windowW: W, windowH: H,
      percentage: pct, baseW: bw, baseH: bh, desiredX: desired.x, desiredY: desired.y };
  }

  // ---- 3. the pure derivation: viewportW/H are CSS px as the window reports them, uiZoom is the
  // stylesheet `zoom:` factor, so the logical window is viewport/zoom -----------------------------
  function compute(input) {
    const o = input || {};
    const scale = num(o.interfaceScale, 1);
    const zoom = num(o.uiZoom, 1);
    const solved = solveGrid(num(o.viewportW, 0) / zoom, num(o.viewportH, 0) / zoom,
      BASE_CELL.w, BASE_CELL.h, scale * 100);
    return Object.assign({}, solved, { interfaceScale: scale, uiZoom: zoom,
      viewportW: num(o.viewportW, 0), viewportH: num(o.viewportH, 0) });
  }

  // ---- 4. live measurement ---------------------------------------------------------------------
  function cssNumber(doc, prop, fallback) {
    const el = doc && doc.documentElement;
    const view = doc && doc.defaultView;
    if (!el || !view || typeof view.getComputedStyle !== "function") return fallback;
    let raw = null;
    try { raw = view.getComputedStyle(el).getPropertyValue(prop); } catch (_) { return fallback; }
    const n = Number(String(raw == null ? "" : raw).trim());
    return finite(n) && n > 0 ? n : fallback;
  }
  function docOf(doc) {
    if (doc) return doc;
    try { return root.document || null; } catch (_) { return null; }
  }
  // Headless (no document) returns neutral inputs so every consumer stays callable in Node. Never
  // read devicePixelRatio: native reads SDL's LOGICAL window size and there is no DPR term.
  function measure(doc) {
    const d = docOf(doc);
    const view = (d && d.defaultView) || (typeof root !== "undefined" ? root : null);
    return {
      viewportW: (view && Number(view.innerWidth)) || 0,
      viewportH: (view && Number(view.innerHeight)) || 0,
      interfaceScale: cssNumber(d, "--dwfui-interface-scale", 1),
      uiZoom: cssNumber(d, "--ui-scale", 1),
    };
  }

  // ---- 5. the published state ----------------------------------------------------------------------
  let state = compute({ viewportW: 0, viewportH: 0, interfaceScale: 1, uiZoom: 1 });

  function px(n) { return `${Math.round(Number(n) * 1000) / 1000}px`; }
  function publish(d, next) {
    const el = d && d.documentElement;
    if (!el || !el.style || typeof el.style.setProperty !== "function") return;
    el.style.setProperty("--dwfui-cell-w", px(next.baseW));
    el.style.setProperty("--dwfui-cell-h", px(next.baseH));
    el.style.setProperty("--dwfui-cell-drawn-w", px(next.cellW));
    el.style.setProperty("--dwfui-cell-drawn-h", px(next.cellH));
    el.style.setProperty("--dwfui-grid-x", String(next.gridX));
    el.style.setProperty("--dwfui-grid-y", String(next.gridY));
    el.style.setProperty("--dwfui-grid-origin-x", px(next.originX));
    el.style.setProperty("--dwfui-grid-origin-y", px(next.originY));
  }
  function same(a, b) {
    return a.cellW === b.cellW && a.cellH === b.cellH && a.gridX === b.gridX && a.gridY === b.gridY;
  }

  function refresh(doc) {
    const d = docOf(doc);
    const next = compute(measure(d));
    const changed = !same(state, next);
    state = next;
    publish(d, next);
    if (changed && d && typeof d.dispatchEvent === "function" && typeof CustomEventCtor === "function") {
      try { d.dispatchEvent(new CustomEventCtor(EVENT, { detail: Object.assign({}, next) })); }
      catch { /* resize cadence republishes the current grid on the next trigger */ }
    }
    return Object.assign({}, next);
  }

  // ---- 6. the API every consumer uses ----------------------------------------------------------------
  function cellFor(axis) { return String(axis) === "y" ? state.cellH : state.cellW; }
  function toPx(cells, axis) { return Number(cells) * cellFor(axis); }
  function toCells(pixels, axis) { return Number(pixels) / cellFor(axis); }
  function cellsIn(pixels, axis, min) {
    const n = Math.floor(toCells(pixels, axis));
    return Math.max(finite(Number(min)) ? Number(min) : 0, finite(n) ? n : 0);
  }
  function onChange(handler, doc) {
    const d = docOf(doc);
    if (!d || typeof d.addEventListener !== "function" || typeof handler !== "function") return () => {};
    d.addEventListener(EVENT, handler);
    return () => { try { d.removeEventListener(EVENT, handler); }
      catch (err) { DwfErr.report("grid.listener-remove", err); } };
  }

  // ---- 7. the recompute triggers -----------------------------------------------------------------
  let installed = false;
  function install(doc) {
    const d = docOf(doc);
    if (!d || installed) return;
    installed = true;
    const view = d.defaultView || root;
    const bump = () => { try { refresh(d); } catch (_) { DwfErr.count("grid.refresh-event"); } };
    if (view && typeof view.addEventListener === "function") {
      view.addEventListener("resize", bump);
      view.addEventListener("orientationchange", bump);
    }
    // No change event exists for CSS custom properties, so observe the one element carrying both.
    if (typeof MutationObserverCtor === "function" && d.documentElement) {
      try {
        new MutationObserverCtor(bump).observe(d.documentElement,
          { attributes: true, attributeFilter: ["style", "data-dwfui-interface-scale"] });
      } catch (err) { DwfErr.report("grid.mutation-observer", err); }
    }
    bump();
  }

  const api = {
    BASE_CELL, WINDOW_MIN, GRID_CLAMP, PCT, EVENT,
    // the solver and the pure law, for the offline gates
    solveGrid, compute, measure,
    // live state
    refresh, install,
    get: () => Object.assign({}, state),
    cellW: () => state.cellW, cellH: () => state.cellH,
    gridX: () => state.gridX, gridY: () => state.gridY,
    interfaceScale: () => state.interfaceScale, uiZoom: () => state.uiZoom,
    // the centred letterbox origin every cell is placed against
    originX: () => state.originX, originY: () => state.originY,
    toPx, toCells, cellsIn, onChange,
  };

  try { root.DwfGrid = api; } catch (_) { /* non-browser context */ }
  if (typeof module === "object" && module && module.exports) module.exports = api;

  try {
    if (root && root.document && root.document.documentElement && !root.__DWF_STORY_MODE) {
      // Install while the document is still parsing: stylesheet rules below this tag must resolve the
      // published cell, not the fallback. The DOMContentLoaded pass catches a late-settling viewport.
      install(root.document);
      if (root.document.readyState === "loading")
        root.document.addEventListener("DOMContentLoaded", () => {
          try { refresh(root.document); } catch (err) { DwfErr.report("grid.dom-ready-refresh", err); }
        });
    }
  } catch (err) { DwfErr.report("grid.boot-refresh", err); }
})(typeof self !== "undefined" ? self : this);
