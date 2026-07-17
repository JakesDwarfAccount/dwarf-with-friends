// dwf-overlay-boxes.js -- WC-7 residual + B08 + B18 (overlay-executor)
//
// Renderer-agnostic BUILDING OVERLAY pass drawn on a self-owned <canvas> above the map, so the
// canvas2d AND WebGL renderers reach parity for FREE -- this pass lives in NEITHER renderer (the
// GL/canvas2d split is a paid-for bug class). It reads the live decoded window through the
// window.DwfTiles singleton (getRenderRect + getLatest), the SAME geometry source that
// dwf-core.js's civzone overlay already trusts (so alignment is identical).
//
//   B08 -- stockpile designation box. DF draws a bordered floor tint under every stockpile;
//          the filed bug was "no box around stockpiles" (they were EXCLUDED from the building-art
//          pass by isOverlayOnlyBuildingType and nothing replaced them). Always visible.
//   B18 -- queued/unbuilt construction (and any unbuilt building) gets a dashed blueprint box.
//          Gated on the server's `built` flag (world_stream BldRec, additive JSON). DORMANT
//          until that field ships in the next DLL deploy: with today's wire `b.built` is
//          undefined so `b.built === false` is never true -> zero behavior change until deploy.
//   B03 -- own-z discipline: every box is z-checked against the rendered plane (rr.oz), so a
//          stale AUX frame (persisting a frame after a z-switch) can never ghost a box onto the
//          wrong level. Mirrors the renderer-side own-z gate for buildings/units.
//
// Self-contained, guarded, additive: every failure mode is a no-op and never touches the map.
(function (root) {
  "use strict";

  function overlayBoxPlans(rr, data) {
    if (!rr || !data || !Array.isArray(data.buildings) || !(Number(rr.cell) > 0)) return [];
    var plans = [], oz = Number(rr.oz), camX = Number(rr.ox) || 0, camY = Number(rr.oy) || 0;
    for (var i = 0; i < data.buildings.length; i++) {
      var b = data.buildings[i];
      if (!b || (typeof b.z === "number" && Number(b.z) !== oz)) continue;
      var isStock = b.type === "Stockpile", isPending = b.built === false;
      if (!isStock && !isPending) continue;
      var x1 = Number(b.x1), y1 = Number(b.y1), x2 = Number(b.x2), y2 = Number(b.y2);
      if (![x1, y1, x2, y2].every(isFinite)) continue;
      var tx1 = x1 - camX, ty1 = y1 - camY, tx2 = x2 - camX, ty2 = y2 - camY;
      if (tx2 < 0 || ty2 < 0 || tx1 >= rr.gw || ty1 >= rr.gh) continue;
      plans.push({ building: b, isStock: isStock, isPending: isPending,
        x: rr.left + tx1 * rr.cell, y: rr.top + ty1 * rr.cell,
        width: (tx2 - tx1 + 1) * rr.cell, height: (ty2 - ty1 + 1) * rr.cell });
    }
    return plans;
  }

  root.DwfOverlayBoxes = { plan: overlayBoxPlans };
  if (typeof window === "undefined" || typeof document === "undefined" || root.__DWF_STORY_MODE) return;

  var canvas = null, ctx = null;

  function ensureCanvas() {
    if (canvas) return canvas;
    var zoneOv = document.getElementById("zoneOverlay");
    canvas = document.createElement("canvas");
    canvas.id = "overlayBoxes";
    canvas.setAttribute("aria-hidden", "true");
    var s = canvas.style;
    s.position = "fixed";
    s.left = "0";
    s.top = "0";
    s.pointerEvents = "none"; // boxes are purely visual -- clicks pass through to the map.
    // Sit one layer above the civzone overlay so boxes render over the map but under panels.
    var zi = 5;
    try {
      if (zoneOv) {
        var czi = parseInt(getComputedStyle(zoneOv).zIndex, 10);
        if (!isNaN(czi)) zi = czi + 1;
      }
    } catch (_) { /* computed-style unavailable -> default z */ }
    s.zIndex = String(zi);
    var anchor = zoneOv || document.getElementById("view");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(canvas, anchor.nextSibling);
    else document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
    return canvas;
  }

  function resize() {
    ensureCanvas();
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var w = Math.max(1, Math.ceil(window.innerWidth));
    var h = Math.max(1, Math.ceil(window.innerHeight));
    if (canvas.width !== Math.ceil(w * dpr) || canvas.height !== Math.ceil(h * dpr)) {
      canvas.width = Math.ceil(w * dpr);
      canvas.height = Math.ceil(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  // The singleton the whole overlay stack reads geometry/decoded-window from.
  function renderApi() {
    var T = window.DwfTiles;
    if (T && typeof T.getRenderRect === "function" && typeof T.getLatest === "function") return T;
    return null;
  }

  // Cheap change-detection so the rAF loop is a near-free early-out when nothing moved (respect
  // the perf gate -- no clear/paint on an idle map). Fingerprint = camera window + a rolling sum
  // over the boxes we actually draw (so a new/removed stockpile also triggers a repaint).
  var lastSig = " ";
  function signature(rr, data) {
    if (!rr) return "none";
    var s = rr.ox + "," + rr.oy + "," + rr.oz + "," + rr.cell + "," + rr.left + "," + rr.top;
    var buildings = data && data.buildings;
    if (Array.isArray(buildings)) {
      var acc = buildings.length, oz = Number(rr.oz);
      for (var i = 0; i < buildings.length; i++) {
        var b = buildings[i];
        if (!b) continue;
        if (b.type === "Stockpile" || b.built === false) {
          if (typeof b.z === "number" && Number(b.z) !== oz) continue;
          acc += (Number(b.x1) || 0) + (Number(b.y1) || 0) * 7 +
                 (Number(b.x2) || 0) * 13 + (Number(b.y2) || 0) * 31 +
                 (b.built === false ? 100000 : 0) +
                 (typeof b.ext === "string" ? b.ext.length + b.ext.charCodeAt(0) : 0);
        }
      }
      s += "|" + acc;
    }
    return s;
  }

  function draw() {
    var T = renderApi();
    if (!T) return;
    var rr = T.getRenderRect();
    var data = T.getLatest();
    var sig = signature(rr, data);
    if (sig === lastSig) return; // idle: no repaint
    lastSig = sig;

    resize();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!rr || !data || !Array.isArray(data.buildings)) return;

    var oz = Number(rr.oz);
    var camX = Number(rr.ox) || 0, camY = Number(rr.oy) || 0;
    var cell = rr.cell, left = rr.left, top = rr.top, gw = rr.gw, gh = rr.gh;
    if (!(cell > 0)) return;
    ctx.imageSmoothingEnabled = false;

    var plans = overlayBoxPlans(rr, data);
    for (var i = 0; i < plans.length; i++) {
      var b = plans[i].building;
      if (!b) continue;
      // own-z (B03): only draw on the plane the map is actually rendering.
      if (typeof b.z === "number" && Number(b.z) !== oz) continue;
      var isStock = b.type === "Stockpile";
      var isPending = (b.built === false); // dormant until the server ships `built`
      if (!isStock && !isPending) continue;

      var x1 = Number(b.x1), y1 = Number(b.y1), x2 = Number(b.x2), y2 = Number(b.y2);
      if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) continue;
      var tx1 = x1 - camX, ty1 = y1 - camY, tx2 = x2 - camX, ty2 = y2 - camY;
      if (tx2 < 0 || ty2 < 0 || tx1 >= gw || ty1 >= gh) continue; // fully off-window

      var sx1 = left + tx1 * cell, sy1 = top + ty1 * cell;
      var sx2 = left + (tx2 + 1) * cell, sy2 = top + (ty2 + 1) * cell;
      var bw = sx2 - sx1, bh = sy2 - sy1;
      var lw = Math.max(1, cell / 16);
      var bwT = x2 - x1 + 1, bhT = y2 - y1 + 1;

      if (isStock) {
        // DF's stockpile look: a bordered floor tint (warm amber). When the server supplies the
        // per-tile footprint bitmap (b.ext -- row-major over the bbox; stockpiles are often
        // painted into irregular/L shapes), render the TRUE outline: fill in-pile tiles and stroke
        // only the boundary edges (neighbor out-of-pile). Otherwise fall back to the bbox box
        // (correct for rectangular piles; over-inclusive for irregular ones -- see closeout).
        var ext = (typeof b.ext === "string" && b.ext.length === bwT * bhT) ? b.ext : null;
        ctx.fillStyle = "rgba(228,201,116,0.10)";
        ctx.strokeStyle = "rgba(232,206,120,0.85)";
        ctx.lineWidth = lw;
        if (ext) {
          var inPile = function (lx, ly) {
            if (lx < 0 || ly < 0 || lx >= bwT || ly >= bhT) return false;
            return ext.charAt(lx + ly * bwT) === "1";
          };
          ctx.beginPath();
          for (var ly = 0; ly < bhT; ly++) {
            for (var lx = 0; lx < bwT; lx++) {
              if (!inPile(lx, ly)) continue;
              var px = left + (tx1 + lx) * cell, py = top + (ty1 + ly) * cell;
              ctx.fillRect(px, py, cell, cell);
              // stroke each edge that borders a non-pile tile -> the true outline.
              if (!inPile(lx, ly - 1)) { ctx.moveTo(px, py + 0.5); ctx.lineTo(px + cell, py + 0.5); }
              if (!inPile(lx, ly + 1)) { ctx.moveTo(px, py + cell - 0.5); ctx.lineTo(px + cell, py + cell - 0.5); }
              if (!inPile(lx - 1, ly)) { ctx.moveTo(px + 0.5, py); ctx.lineTo(px + 0.5, py + cell); }
              if (!inPile(lx + 1, ly)) { ctx.moveTo(px + cell - 0.5, py); ctx.lineTo(px + cell - 0.5, py + cell); }
            }
          }
          ctx.stroke();
        } else {
          ctx.fillRect(sx1, sy1, bw, bh);
          ctx.strokeRect(sx1 + 0.5, sy1 + 0.5, Math.max(1, bw - 1), Math.max(1, bh - 1));
        }
      }
      if (isPending) {
        // Queued/unbuilt building (B18): dashed blueprint box in DF's planned-construction cyan.
        ctx.save();
        ctx.strokeStyle = "rgba(120,200,240,0.9)";
        ctx.lineWidth = lw;
        if (ctx.setLineDash) ctx.setLineDash([Math.max(2, cell / 5), Math.max(2, cell / 5)]);
        ctx.strokeRect(sx1 + 0.5, sy1 + 0.5, Math.max(1, bw - 1), Math.max(1, bh - 1));
        ctx.restore();
      }
    }
  }

  var raf = 0;
  function loop() {
    try { draw(); } catch (_) { /* best-effort: never break the map */ }
    raf = requestAnimationFrame(loop);
  }
  function start() {
    if (raf) return;
    ensureCanvas();
    window.addEventListener("resize", function () { lastSig = " "; });
    raf = requestAnimationFrame(loop);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
