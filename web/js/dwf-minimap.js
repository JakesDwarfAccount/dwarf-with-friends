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

  const MM_COLORS = ["#7a5a32","#c8803c","#6b6b6b","#3a3a3a","#4a4640","#8a8270","#b0a080",
    "#3b6fd4","#d8401a","#4f9a3a","#2f6b27","#9b8b3a","#e8f0f8","#9a948c","#64e0ff","#808080"];
  function mmDecode(ch) {
    if (ch >= 48 && ch <= 57) return ch - 48;      // '0'..'9'
    if (ch >= 97 && ch <= 102) return 10 + ch - 97; // 'a'..'f'
    return 14;
  }
  // MM_COLORS again as premultiplied RGB triples, for the putImageData terrain pass below.
  const MM_RGB = MM_COLORS.map(h => [parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  // The terrain layer is cached to an offscreen canvas keyed on (dims + cells) and drawn with one
  // putImageData, so it is independent of display size and survives a resize or DPR change.
  let mmTerrainCanvas = null, mmTerrainKey = "";
  function renderMinimap(hud) {
    const mm = hud.minimap || {};
    const W = Math.max(1, mm.w | 0), H = Math.max(1, mm.h | 0);
    const cells = typeof mm.cells === "string" ? mm.cells : "";
    const cv = hudEls.minimap;
    if (!cv || !cv.getContext) return;
    // Measure the element rather than naming a size: the backing store is exactly one pixel per
    // minimap cell, and the single magnification is unsmoothed nearest-neighbour.
    const rect = cv.getBoundingClientRect();
    const cssW = Math.round(rect.width), cssH = Math.round(rect.height);
    if (cssW < 1 || cssH < 1) return;      // not laid out yet; the 1 Hz /hud poll repaints it
    const dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
    const devW = Math.max(1, Math.round(cssW * dpr)), devH = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== devW || cv.height !== devH) { cv.width = devW; cv.height = devH; }
    const ctx = cv.getContext("2d");
    // CSS pixels from here down; the backing store stays at device resolution underneath.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dispW = cssW, dispH = cssH;
    const terrainKey = W + "x" + H + ":" + cells;   // 9k-char compare ≈ µs vs a full repaint
    if (!mmTerrainCanvas || mmTerrainKey !== terrainKey) {
      if (!mmTerrainCanvas) mmTerrainCanvas = document.createElement("canvas");
      if (mmTerrainCanvas.width !== W || mmTerrainCanvas.height !== H) {
        mmTerrainCanvas.width = W; mmTerrainCanvas.height = H;
      }
      const tctx = mmTerrainCanvas.getContext("2d");
      const img = tctx.createImageData(W, H);
      const d = img.data;
      for (let i = 0, n = W * H; i < n; i++) {
        const rgb = MM_RGB[mmDecode(cells.charCodeAt(i))] || MM_RGB[14];
        const o = i * 4;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
      }
      tctx.putImageData(img, 0, 0);
      mmTerrainKey = terrainKey;
    }
    ctx.clearRect(0, 0, dispW, dispH);
    // Anisotropic fill, deliberately: native scales the map to the field's cell box on both axes and
    // never letterboxes.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mmTerrainCanvas, 0, 0, dispW, dispH);
    // The viewport box must come from the renderer's LIVE zoom-aware window (ox/oy, gw/gh), never
    // hud.viewport -- that is the server's fixed capture grid and does not track client zoom.
    const map = hud.map || { w: 1, h: 1 };
    const mapW = Math.max(1, Number(map.w) || 1), mapH = Math.max(1, Number(map.h) || 1);
    const rr = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    let originX, originY, spanW, spanH;
    if (rr && Number.isFinite(rr.ox) && rr.gw > 0 && rr.gh > 0) {
      originX = rr.ox; originY = rr.oy; spanW = rr.gw; spanH = rr.gh;
    } else {
      const cam = hud.camera || { x: 0, y: 0 };
      const vp = hud.viewport || { w: 1, h: 1 };
      originX = Number(cam.x) || 0; originY = Number(cam.y) || 0;
      spanW = Number(vp.w) || 1; spanH = Number(vp.h) || 1;
    }
    const bx = (originX / mapW) * dispW;
    const by = (originY / mapH) * dispH;
    const bw = Math.max(3, (spanW / mapW) * dispW);
    const bh = Math.max(3, (spanH / mapH) * dispH);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    ctx.strokeStyle = "#ffdf4d";
    ctx.strokeRect(bx + 1.5, by + 1.5, bw - 2, bh - 2);

    // Other players' viewboxes come from the roster's interest window (camx/camy/camw/camh), never
    // hud.viewport. Solid on the viewer's z, dashed and faded on another.
    try {
      const P = window.DwfPresence;
      const roster = (P && Array.isArray(P.roster)) ? P.roster : [];
      const colorOf = (window.DwfTiles && typeof DwfTiles.playerColor === "function")
        ? DwfTiles.playerColor : null;
      const viewerZ = (hud.camera && typeof hud.camera.z === "number") ? hud.camera.z : null;
      const others = roster
        .filter(p => p && !p.self && typeof p.camx === "number" && typeof p.camy === "number"
                     && typeof p.camw === "number" && typeof p.camh === "number")
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const labelYUsed = [];
      ctx.save();
      for (const p of others) {
        const col = colorOf ? colorOf(p.name).fill : "#8cf";
        const obx = (p.camx / mapW) * dispW;
        const oby = (p.camy / mapH) * dispH;
        const obw = Math.max(3, (p.camw / mapW) * dispW);
        const obh = Math.max(3, (p.camh / mapH) * dispH);
        const sameZ = (viewerZ !== null && typeof p.camz === "number") ? (p.camz === viewerZ) : true;
        ctx.setLineDash(sameZ ? [] : [3, 2]);
        ctx.lineWidth = 1;
        ctx.globalAlpha = sameZ ? 0.9 : 0.4;
        ctx.strokeStyle = col;
        ctx.strokeRect(obx + 0.5, oby + 0.5, obw, obh);
        // name chip
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        // Anonymize raw session-key names through dwf-lobby's one canonical helper, so this chip matches
        // the cursor label. Raw p.name stays the roster key; only the DISPLAY changes.
        let label = ((window.DwfLobby && typeof DwfLobby.displayName === "function")
          ? DwfLobby.displayName(p.name).text : String(p.name == null ? "" : p.name)) || "?";
        if (label.length > 10) label = label.slice(0, 10);
        ctx.font = "9px monospace";
        const tw = ctx.measureText(label).width;
        let lx = obx;
        let ly = oby - 10;
        let nudge = 0;
        for (const y of labelYUsed) if (Math.abs(y - ly) < 9) nudge += 10;
        ly += nudge;
        labelYUsed.push(ly);
        if (ly < 0) ly = oby + 1;                         // clamp top (below the box edge)
        lx = Math.max(0, Math.min(lx, dispW - tw - 4));   // clamp left/right inside the canvas
        if (ly > dispH - 10) ly = dispH - 10;             // clamp bottom
        ctx.fillStyle = "rgba(0,0,0,0.72)";
        ctx.fillRect(lx, ly, tw + 4, 10);
        ctx.fillStyle = col;
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText(label, lx + 2, ly + 1);
      }
      ctx.restore();
    } catch { /* keep the local viewport when an optional roster viewbox cannot paint */ }
  }
  // A client-side zoom or resize changes gw/gh with no camera POST, so redraw on resize rather than
  // waiting for the one-second /hud poll.
  if (!window.__dwfMinimapResizeBound) {
    window.__dwfMinimapResizeBound = true;
    window.addEventListener("resize", () => {
      try { if (typeof currentHud !== "undefined" && currentHud) renderMinimap(currentHud); }
      catch { /* the one-second HUD cadence retries a failed resize repaint */ }
    });
  }
  // Redraw on roster change (other players' viewboxes), throttled to ~2 Hz.
  if (!window.__dwfMinimapRosterBound && window.DwfPresence
      && typeof window.DwfPresence.onChange === "function") {
    window.__dwfMinimapRosterBound = true;
    let mmThrottle = 0;
    window.DwfPresence.onChange(() => {
      const now = Date.now();
      if (now - mmThrottle < 500) return;
      mmThrottle = now;
      try { if (typeof currentHud !== "undefined" && currentHud) renderMinimap(currentHud); }
      catch { /* the one-second HUD cadence retries a failed roster repaint */ }
    });
  }

  if (typeof window !== "undefined") Object.assign(window, { renderMinimap });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { mmDecode, renderMinimap });
