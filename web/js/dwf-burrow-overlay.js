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

// dwf-burrow-overlay.js -- draws each burrow's assigned tiles on its own canvas above the map.
(function (root) {
  "use strict";

  // Burrows the panel published for drawing. Empty means dormant: DF shows burrow tiles only inside
  // burrow mode, so there is no permanent wash of every burrow over the map.
  var burrows = [];
  var burrowZ = null;

  function rgbaOf(burrow, alpha) {
    var c = burrow && burrow.rgb;
    var r = 145, g = 225, b = 255; // fallback: the client's usual selection cyan
    if (Array.isArray(c) && c.length === 3 &&
        c.every(function (n) { return typeof n === "number" && isFinite(n); })) {
      if (c[0] || c[1] || c[2]) { r = c[0]; g = c[1]; b = c[2]; }
    }
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  // Pure planner: world-tile rects -> screen rects, culled to the rendered window. A finite `z` that
  // disagrees with the camera's z means every rect belongs to another level, so plan NOTHING.
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
        // The server already clipped these to this player's window and to the camera's z, so there is no
        // per-rect z to re-check here; the window cull below keeps a stale payload honest.
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

  var overlayCanvas = null, lastSig = " ";

  function ensureCanvas() {
    if (overlayCanvas) return overlayCanvas.canvas;
    var boxes = document.getElementById("overlayBoxes");
    var zoneOv = document.getElementById("zoneOverlay");
    var anchor = boxes || zoneOv || document.getElementById("view");
    overlayCanvas = root.DwfOverlayCanvas.create({
      id: "burrowOverlay", anchor: anchor, defaultZ: 6, zAfterAnchor: anchor,
      pointerEvents: "none"
    });
    return overlayCanvas.canvas;
  }

  function resize() {
    ensureCanvas();
    return overlayCanvas.resizeViewport();
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

    var ctx = resize();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!rr || !burrows.length) { lastSig = sig; return; }

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
    lastSig = sig;
  }

  function tick() {
    try { draw(); }
    catch { /* a failed draw retries on the next scheduled frame */ }
    requestAnimationFrame(tick);
  }
  addEventListener("resize", function () { lastSig = " "; });
  requestAnimationFrame(tick);
})(typeof window !== "undefined" ? window : globalThis);
