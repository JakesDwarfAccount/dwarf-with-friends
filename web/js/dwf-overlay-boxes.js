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

// dwf-overlay-boxes.js -- the renderer-agnostic BUILDING OVERLAY pass on its own canvas above
// the map, plus stockpileLayerIndex(), the shared edge-set/layer table both renderers consume.
(function (root) {
  "use strict";

  // `ext` is the wire's row-major "0"/"1" string over the bounding box; with no bitmap the pile is a
  // plain rectangle and every in-box tile is a member.
  function memberAt(ext, bw, bh, lx, ly) {
    if (lx < 0 || ly < 0 || lx >= bw || ly >= bh) return false;
    if (!ext) return true;                       // no bitmap -> rectangular pile, all in
    return ext.charAt(lx + ly * bw) === "1";
  }

  // Mask of PRESENT neighbours: N=1, S=2, W=4, E=8, the same convention as dwf-core.js's zoneShapeRow.
  // A CLEAR bit means that side is a perimeter EDGE and must carry a rope piece.
  function neighbourMask(ext, bw, bh, lx, ly) {
    return (memberAt(ext, bw, bh, lx, ly - 1) ? 1 : 0)
         | (memberAt(ext, bw, bh, lx, ly + 1) ? 2 : 0)
         | (memberAt(ext, bw, bh, lx - 1, ly) ? 4 : 0)
         | (memberAt(ext, bw, bh, lx + 1, ly) ? 8 : 0);
  }

  // The vanilla stockpile.png cells. Token -> cell is MODDABLE: a tileset may rebind it, so this is the
  // vanilla default, not a law.
  var STOCKPILE_CELLS = {
    STOCKPILE_FLOOR: { col: 0, row: 1 },
    STOCKPILE_N_UP:  { col: 0, row: 2 },
    STOCKPILE_N:     { col: 0, row: 3 },
    STOCKPILE_S:     { col: 0, row: 4 },
    STOCKPILE_W_UP:  { col: 0, row: 5 },
    STOCKPILE_W:     { col: 0, row: 6 },
    STOCKPILE_E_UP:  { col: 0, row: 7 },
    STOCKPILE_E:     { col: 0, row: 8 }
  };

  // EVERY member tile carries STOCKPILE_FLOOR, including the single-direction rim tiles: the rim sprites
  // carry no floor tint of their own, so omitting it stops the checker at the pile's outer rim.
  function stockpilePieces(mask) {
    var nEdge = !(mask & 1), sEdge = !(mask & 2), wEdge = !(mask & 4), eEdge = !(mask & 8);
    var body = [], overhang = [];
    body.push("STOCKPILE_FLOOR");                // R3 as amended: the checker is unconditional
    if (nEdge) body.push("STOCKPILE_N");
    if (sEdge) body.push("STOCKPILE_S");
    if (wEdge) body.push("STOCKPILE_W");
    if (eEdge) body.push("STOCKPILE_E");
    if (nEdge) {
      overhang.push("STOCKPILE_N_UP");
      if (wEdge) overhang.push("STOCKPILE_W_UP");
      if (eEdge) overhang.push("STOCKPILE_E_UP");
    }
    return { body: body, overhang: overhang };
  }

  // Per-tile draw plan for one stockpile. Pure: no canvas, no DOM -- the suite drives this
  // directly. `ext` is the building's own bitmap ONLY (R1: never consult a neighbouring pile).
  function stockpileTilePlans(b) {
    if (!b || typeof b !== "object") return [];
    var x1 = Number(b && b.x1), y1 = Number(b && b.y1);
    var x2 = Number(b && b.x2), y2 = Number(b && b.y2);
    if (![x1, y1, x2, y2].every(isFinite)) return [];
    var bw = x2 - x1 + 1, bh = y2 - y1 + 1;
    if (!(bw > 0) || !(bh > 0)) return [];
    var ext = (typeof b.ext === "string" && b.ext.length === bw * bh) ? b.ext : null;
    var plans = [];
    for (var ly = 0; ly < bh; ly++) {
      for (var lx = 0; lx < bw; lx++) {
        if (!memberAt(ext, bw, bh, lx, ly)) continue;
        var pieces = stockpilePieces(neighbourMask(ext, bw, bh, lx, ly));
        plans.push({ wx: x1 + lx, wy: y1 + ly, body: pieces.body, overhang: pieces.overhang });
      }
    }
    return plans;
  }

  // Substitutes the shared paint session's effective shape ONLY for the pile actually being repainted.
  function paintedShapeOf(b) {
    var S = root.DwfPaintSession;
    if (!S || !b || b.id == null) return b;
    var shape;
    try { shape = S.shapeFor("stockpile", b.id); } catch { return b; }
    if (!shape) return b;
    return { id: b.id, type: b.type, built: b.built, z: shape.z,
      x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2, ext: shape.extents };
  }

  // ---- the two draw layers a stockpile tile occupies ------------------------------------------
  function tileKey(wx, wy) { return wx + "," + wy; }
  function stockpileLayerIndex(buildings, oz) {
    var index = new Map();
    if (!Array.isArray(buildings)) return index;
    function slot(wx, wy) {
      var k = tileKey(wx, wy), e = index.get(k);
      if (!e) { e = { wx: wx, wy: wy, floor: [], rope: [] }; index.set(k, e); }
      return e;
    }
    for (var i = 0; i < buildings.length; i++) {
      var b = buildings[i];
      if (!b || b.type !== "Stockpile") continue;
      if (typeof b.z === "number" && Number(b.z) !== Number(oz)) continue;
      var plans = stockpileTilePlans(paintedShapeOf(b));
      for (var j = 0; j < plans.length; j++) {
        var tp = plans[j], own = slot(tp.wx, tp.wy);
        for (var k2 = 0; k2 < tp.body.length; k2++) {
          var tok = tp.body[k2];
          if (tok === "STOCKPILE_FLOOR") own.floor.push(tok);
          else own.rope.push(tok);
        }
        if (tp.overhang.length) {
          var above = slot(tp.wx, tp.wy - 1);
          for (var k3 = 0; k3 < tp.overhang.length; k3++) above.rope.push(tp.overhang[k3]);
        }
      }
    }
    return index;
  }

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

  root.DwfOverlayBoxes = {
    plan: overlayBoxPlans,
    // ledger 0022 surface, exported for the boundary suites (pure, no DOM):
    stockpileCells: STOCKPILE_CELLS,
    neighbourMask: neighbourMask,
    stockpilePieces: stockpilePieces,
    stockpileTilePlans: stockpileTilePlans,
    // R10: consumed by BOTH renderers, which draw floor under items and rope over them.
    stockpileLayerIndex: stockpileLayerIndex,
    paintedShapeOf: paintedShapeOf
  };
  if (typeof window === "undefined" || typeof document === "undefined" || root.__DWF_STORY_MODE) return;

  var overlayCanvas = null;

  function ensureCanvas() {
    if (overlayCanvas) return overlayCanvas.canvas;
    var zoneOv = document.getElementById("zoneOverlay");
    var anchor = zoneOv || document.getElementById("view");
    overlayCanvas = root.DwfOverlayCanvas.create({
      id: "overlayBoxes", anchor: anchor, defaultZ: 5, zAfterAnchor: zoneOv,
      pointerEvents: "none"
    });
    return overlayCanvas.canvas;
  }

  function resize() {
    ensureCanvas();
    return overlayCanvas.resizeViewport();
  }

  // The singleton the whole overlay stack reads geometry/decoded-window from.
  function renderApi() {
    var T = window.DwfTiles;
    if (T && typeof T.getRenderRect === "function" && typeof T.getLatest === "function") return T;
    return null;
  }

  // Cheap change detection so the rAF loop early-outs when nothing moved -- no clear or paint on an idle map.
  var lastSig = " ";
  function signature(rr, data) {
    if (!rr) return "none";
    var s = rr.ox + "," + rr.oy + "," + rr.oz + "," + rr.cell + "," + rr.left + "," + rr.top;
    // The paint session's revision belongs in the fingerprint: a staged edit touches neither the camera
    // window nor the buildings payload, so without it the new art waits for the map to move.
    try { if (root.DwfPaintSession) s += "|p" + root.DwfPaintSession.revision(); }
    catch { /* the world signature still invalidates overlay geometry */ }
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

    var ctx = resize();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!rr || !data || !Array.isArray(data.buildings)) return;

    var oz = Number(rr.oz);
    var camX = Number(rr.ox) || 0, camY = Number(rr.oy) || 0;
    var cell = rr.cell, left = rr.left, top = rr.top, gw = rr.gw, gh = rr.gh;
    if (!(cell > 0)) return;
    ctx.imageSmoothingEnabled = false;

    // Geometry handed to the sprite blitter; whole-pixel snapping matches the zone overlay's
    // rounding so rope pieces land on exactly the same tile grid as the map underneath.
    var plans = overlayBoxPlans(rr, data);
    for (var i = 0; i < plans.length; i++) {
      var b = plans[i].building;
      if (!b) continue;
      // only draw on the plane the map is actually rendering
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

      // NO stockpile art here: the checker must sit UNDER the pile's items, so both renderers draw it in
      // their own per-tile stacks. `isStock` only keeps the z-gate and the fingerprint seeing the pile.
      if (isPending) {
        // Queued or unbuilt building: a dashed blueprint box in DF's planned-construction cyan.
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
    try { draw(); }
    catch { /* the previous overlay pixels remain until the next scheduled draw */ }
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
