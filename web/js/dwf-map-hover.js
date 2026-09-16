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

  const hoverInfo = document.getElementById("hoverInfo");
  const HOVER_CACHE_TTL_MS = 2500;   // tile contents change slowly; re-hover within this is instant
  const HOVER_THROTTLE_MS = 45;      // coalesce pointermove bursts to ~22/s of tile sampling
  const hoverCache = new Map();      // "wx,wy,wz" -> { data, ts }
  let hoverTileKey = "";             // world-tile key currently displayed
  let hoverAt = 0;
  let hoverInFlight = false;         // single-flight guard
  let hoverWant = null;              // latest desired { key, px, py, w, h } queued behind a fetch
  // Latency instrumentation, published as window.__hoverStats.
  const hoverStats = { fetches: 0, cacheHits: 0, lastMs: 0, totalMs: 0, maxMs: 0,
    get avgMs() { return this.fetches ? this.totalMs / this.fetches : 0; } };
  try { window.__hoverStats = hoverStats; } catch (err) { DwfErr.report("hover.stats-export", err); }

  function renderHover(d) {
    if (!d) { hoverInfo.hidden = true; hoverTileKey = ""; return; }
    // d.kinds is a PARALLEL array to d.lines: index i tags line i, so the two must never be
    // filtered or sorted apart.
    const lines = (Array.isArray(d.lines) ? d.lines : []).filter(Boolean);
    const kinds = Array.isArray(d.kinds) ? d.kinds : [];
    let html = lines.map((l, i) =>
      `<div class="hv-line hv-${escapeHtml(String(kinds[i] || "unit"))}">${escapeHtml(l)}</div>`).join("");
    if (d.material && lines.indexOf(d.material) < 0)
      html += `<div class="hv-line hv-terrain">${escapeHtml(d.material)}</div>`;
    if (!html) { hoverInfo.hidden = true; hoverTileKey = ""; return; }
    hoverInfo.innerHTML = html;
    hoverInfo.hidden = false;
  }
  function worldTileKey(px, py) {
    const rr = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!rr) return `${px},${py},g`;   // geometry unknown -> fall back to grid-index key
    return `${rr.ox + px},${rr.oy + py},${rr.oz}`;
  }
  function paintFromCache(key) {
    const cached = hoverCache.get(key);
    if (!cached || (performance.now() - cached.ts) >= HOVER_CACHE_TTL_MS) return false;
    hoverStats.cacheHits++;
    hoverTileKey = key;
    renderHover(cached.data);
    return true;
  }
  function pumpHover() {
    if (hoverInFlight || !hoverWant) return;
    const want = hoverWant;
    hoverWant = null;
    if (paintFromCache(want.key)) return;               // fresh in cache -> no network
    hoverInFlight = true;
    const t0 = performance.now();
    const url = `/hover?player=${encodeURIComponent(player)}&px=${want.px}&py=${want.py}&w=${want.w}&h=${want.h}`;
    fetch(url, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        const ms = performance.now() - t0;
        hoverStats.fetches++; hoverStats.lastMs = ms; hoverStats.totalMs += ms;
        if (ms > hoverStats.maxMs) hoverStats.maxMs = ms;
        if (data) hoverCache.set(want.key, { data, ts: performance.now() });
        if (!hoverWant || hoverWant.key === want.key) {
          hoverTileKey = want.key;
          renderHover(data);
        }
      })
      .catch(() => DwfErr.count("hover.inspect"))
      .finally(() => {
        hoverInFlight = false;
        if (hoverWant) pumpHover();                     // chase the latest tile immediately
      });
  }
  function requestHover(px, py, w, h) {
    const key = worldTileKey(px, py);
    if (key === hoverTileKey) return;                   // already showing this exact tile
    if (paintFromCache(key)) return;                    // instant paint entering a cached tile
    hoverWant = { key, px, py, w, h };
    pumpHover();
  }
  view.addEventListener("pointermove", event => {
    if (window.DFPlacementController.pdown) return; // suppressed while click-dragging a designation
    const pixel = imagePixelFromEvent(event);
    if (!pixel) { hoverInfo.hidden = true; return; }
    window.sendPlacementUi(pixel.x, pixel.y, pixel.w, pixel.h, false, 0, 0);
    if (window.bipSelBuild()) {
      window.DFPlacementController.placementCursorTile = { gx: pixel.x, gy: pixel.y };
      renderZoneOverlay();
    } else if (window.DFPlacementController.placementCursorTile) {
      window.DFPlacementController.placementCursorTile = null;
      renderZoneOverlay();
    }
    const now = performance.now();
    if (now - hoverAt < HOVER_THROTTLE_MS) return;
    hoverAt = now;
    requestHover(pixel.x, pixel.y, pixel.w, pixel.h);
  });
  view.addEventListener("pointerleave", () => {
    hoverInfo.hidden = true;
    hoverTileKey = "";
    hoverWant = null;
    // PRESENCE: clear our cursor for other players when the pointer leaves the map.
    if (!window.DFPlacementController.pdown) window.sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true);
    if (window.DFPlacementController.placementCursorTile) { window.DFPlacementController.placementCursorTile = null; renderZoneOverlay(); } // drop the cursor
  });
  view.addEventListener("pointerdown", () => { hoverInfo.hidden = true; hoverTileKey = ""; });
