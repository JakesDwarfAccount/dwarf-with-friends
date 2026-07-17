// dwf-burrow-overlay.js -- B230 burrow tile overlay
//
// Draws each burrow's assigned tiles on the map while burrow mode is open. This closes a hole that
// the server side had ALREADY paid for and nobody spent: /burrows has shipped a per-burrow `rects`
// array (its tiles clipped to the requesting player's window -- src/burrows_panel.cpp
// burrow_visible_tile_rects) since WD-13, and the client's only response was a console.warn saying
// the endpoint was pending. It wasn't. So burrows were, in practice, INVISIBLE: you painted tiles
// and got no feedback that any tile had been painted, which makes "did that click land?" unknowable
// and makes an emergency civ-alert burrow a leap of faith.
//
// Shape deliberately copies dwf-overlay-boxes.js (B08/B18), for the reason stated there: a
// pass that lives in NEITHER renderer reaches canvas2d and WebGL parity for free, and the
// GL/canvas2d split is a paid-for bug class. Same geometry singleton (window.DwfTiles ->
// getRenderRect), same own-z discipline (B03), same idle-signature early-out, same
// pointer-events:none canvas.
//
// COLOUR: each rect is tinted with the burrow's OWN colour, which the server resolves for us from
// DF's live curses palette (df::global::gps->uccolor -- see the apply_burrow_symbol banner in
// src/burrows_panel.cpp) and ships as `rgb`. The browser therefore never carries a duplicate copy
// of DF's palette, and a player who has edited data/init/colors.txt sees their own colours.
//
// B216: this pass is READ-ONLY with respect to the camera. It renders whatever window the map is
// already showing and never recenters -- opening the burrow panel cannot move the view.
//
// Self-contained, guarded, additive: every failure mode is a no-op and never touches the map.
(function (root) {
  "use strict";

  // Burrows whose tiles should be drawn, published by the burrow panel (controls-placement.js).
  // Empty => the overlay is dormant and paints nothing, which is the state whenever burrow mode is
  // closed. We do NOT draw burrows all the time: DF only shows burrow tiles inside burrow mode, and
  // a permanent wash of every burrow over the map is not something anyone asked for.
  var burrows = [];
  // B238: the z the server built these rects FOR. /burrows returns a burrow's tiles on ONE z (the
  // requesting player's camera z), so a payload from z=12 must not paint its wash over z=11 while
  // the refetch is in flight. null == the server did not say (an old DLL, pre-B238): keep the old
  // ungated behaviour rather than going blank -- degrading to "sometimes shows the wrong z" beats
  // degrading to "shows nothing".
  var burrowZ = null;

  function rgbaOf(burrow, alpha) {
    var c = burrow && burrow.rgb;
    var r = 145, g = 225, b = 255; // fallback: the client's usual selection cyan
    if (Array.isArray(c) && c.length === 3 &&
        c.every(function (n) { return typeof n === "number" && isFinite(n); })) {
      // A burrow whose texture bytes are all zero is one created before the B230 create-fix (it
      // renders black-on-black in DF too). Painting it pure black here would hide it on the map
      // exactly like DF hides it -- accurate, but useless as feedback. Fall back to the tint.
      if (c[0] || c[1] || c[2]) { r = c[0]; g = c[1]; b = c[2]; }
    }
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  // Pure planner (mirrors DwfOverlayBoxes.plan): world-tile rects -> screen rects, culled to
  // the rendered window. Exported so the harness can assert geometry with no DOM and no canvas.
  // `z` (optional) is the z the rects were built for -- see the burrowZ note above. A finite z that
  // disagrees with the camera's z means every rect in `list` belongs to a level the player is no
  // longer looking at: plan NOTHING (the panel's refetch is already in flight).
  function burrowOverlayPlans(rr, list, z) {
    if (!rr || !Array.isArray(list) || !(Number(rr.cell) > 0)) return [];
    if (z !== null && z !== undefined && isFinite(Number(z)) && Number(rr.oz) !== Number(z)) return [];
    var plans = [];
    var cell = Number(rr.cell), left = Number(rr.left) || 0, top = Number(rr.top) || 0;
    var camX = Number(rr.ox) || 0, camY = Number(rr.oy) || 0;
    var gw = Number(rr.gw) || 0, gh = Number(rr.gh) || 0;
    for (var i = 0; i < list.length; i++) {
      var burrow = list[i];
      if (!burrow || !Array.isArray(burrow.rects)) continue;
      for (var j = 0; j < burrow.rects.length; j++) {
        var rect = burrow.rects[j];
        if (!rect) continue;
        var x = Number(rect.x), y = Number(rect.y);
        var w = Number(rect.w), h = Number(rect.h);
        if (!isFinite(x) || !isFinite(y) || !(w > 0) || !(h > 0)) continue;
        // The server already clipped these to this player's window AND to the camera's z (it only
        // walks blocks whose map_pos.z == camera.z), so there is no per-rect z to re-check here --
        // the window-cull below is what keeps a stale payload from a just-changed camera honest.
        var tx = x - camX, ty = y - camY;
        if (tx + w <= 0 || ty + h <= 0 || tx >= gw || ty >= gh) continue; // fully off-window
        var cx = Math.max(0, tx), cy = Math.max(0, ty);
        var cw = Math.min(gw, tx + w) - cx, ch = Math.min(gh, ty + h) - cy;
        if (!(cw > 0) || !(ch > 0)) continue;
        plans.push({
          burrow: burrow,
          x: left + cx * cell,
          y: top + cy * cell,
          width: cw * cell,
          height: ch * cell
        });
      }
    }
    return plans;
  }

  // Publish the burrows to draw. Called by the burrow panel on every refresh, and with [] when the
  // panel closes. Returns nothing; a bad argument simply clears the overlay.
  function setBurrows(list, z) {
    burrows = Array.isArray(list) ? list : [];
    burrowZ = (z === null || z === undefined || !isFinite(Number(z))) ? null : Number(z);
    lastSig = " "; // force one repaint: the burrow set changed even if the camera did not
  }

  root.DwfBurrowOverlay = { plan: burrowOverlayPlans, setBurrows: setBurrows };
  if (typeof window === "undefined" || typeof document === "undefined" || root.__DWF_STORY_MODE) return;

  var canvas = null, ctx = null, lastSig = " ";

  function ensureCanvas() {
    if (canvas) return canvas;
    var boxes = document.getElementById("overlayBoxes");
    var zoneOv = document.getElementById("zoneOverlay");
    canvas = document.createElement("canvas");
    canvas.id = "burrowOverlay";
    canvas.setAttribute("aria-hidden", "true");
    var s = canvas.style;
    s.position = "fixed";
    s.left = "0";
    s.top = "0";
    s.pointerEvents = "none"; // purely visual -- burrow PAINT clicks must reach the map.
    // Sit one layer above the building boxes (which already sit above the civzone overlay), so a
    // burrow reads on top of a stockpile box rather than under it -- while burrow mode is open the
    // burrow is the thing being edited, so it wins.
    var anchor = boxes || zoneOv || document.getElementById("view");
    var zi = 6;
    try {
      if (anchor) {
        var ai = parseInt(getComputedStyle(anchor).zIndex, 10);
        if (!isNaN(ai)) zi = ai + 1;
      }
    } catch (_) { /* computed-style unavailable -> default z */ }
    s.zIndex = String(zi);
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

  function renderApi() {
    var T = window.DwfTiles;
    if (T && typeof T.getRenderRect === "function") return T;
    return null;
  }

  // Idle early-out: fingerprint the camera window + the burrow set we would draw, so a still map
  // with an open burrow panel costs one string compare per frame, not a clear+repaint.
  function signature(rr) {
    if (!rr || !burrows.length) return burrows.length ? "nocam" : "empty";
    var s = rr.ox + "," + rr.oy + "," + rr.oz + "," + rr.cell + "," + rr.left + "," + rr.top +
            "," + (burrowZ === null ? "-" : burrowZ);
    var acc = burrows.length;
    for (var i = 0; i < burrows.length; i++) {
      var b = burrows[i];
      if (!b) continue;
      var rects = Array.isArray(b.rects) ? b.rects : [];
      acc += Number(b.id) * 7 + rects.length * 13 + (Number(b.symbolIndex) || 0) * 31;
      for (var j = 0; j < rects.length; j++) {
        var r = rects[j];
        if (r) acc += (Number(r.x) || 0) + (Number(r.y) || 0) * 3 + (Number(r.w) || 0) * 5;
      }
    }
    return s + "|" + acc;
  }

  function draw() {
    var T = renderApi();
    if (!T) return;
    var rr = T.getRenderRect();
    var sig = signature(rr);
    if (sig === lastSig) return; // idle: no repaint
    lastSig = sig;

    resize();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!rr || !burrows.length) return;

    ctx.imageSmoothingEnabled = false;
    var plans = burrowOverlayPlans(rr, burrows, burrowZ);
    for (var i = 0; i < plans.length; i++) {
      var p = plans[i];
      ctx.fillStyle = rgbaOf(p.burrow, 0.28);
      ctx.fillRect(p.x, p.y, p.width, p.height);
    }
    // Stroke AFTER every fill so one burrow's wash cannot wash out another's outline.
    var lw = Math.max(1, Number(rr.cell) / 16);
    ctx.lineWidth = lw;
    for (var k = 0; k < plans.length; k++) {
      var q = plans[k];
      ctx.strokeStyle = rgbaOf(q.burrow, 0.95);
      ctx.strokeRect(q.x + lw / 2, q.y + lw / 2,
                     Math.max(1, q.width - lw), Math.max(1, q.height - lw));
    }
  }

  function tick() {
    try { draw(); } catch (_) { /* an overlay must never take the map down */ }
    requestAnimationFrame(tick);
  }
  addEventListener("resize", function () { lastSig = " "; });
  requestAnimationFrame(tick);
})(typeof window !== "undefined" ? window : globalThis);
