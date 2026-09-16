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
// ---- Interface-sprite blit helper: /interface_map.json maps TOKEN -> {img, cx, cy, w, h} in pixels. ----
// Loads BEFORE dwf-controls-placement.js; classic scripts share one top-level scope.

  const DF_CHROME_MAP_URL = "/interface_map.json";
  const DF_CHROME_ASSET_BASE = "/asset/";

  let _dfChromeMap = null;
  let _dfChromeMapPromise = null;
  const _dfChromeImages = {}; // sheet basename -> Image

  function loadDfChromeMap() {
    if (_dfChromeMap) return Promise.resolve(_dfChromeMap);
    if (!_dfChromeMapPromise) {
      _dfChromeMapPromise = fetch(DF_CHROME_MAP_URL, { cache: "no-store" })
        .then(res => { if (!res.ok) throw new Error("interface_map.json " + res.status); return res.json(); })
        .then(json => { _dfChromeMap = json || {}; return _dfChromeMap; })
        .catch(err => {
          console.error("dwf-chrome: failed to load interface_map.json", err);
          _dfChromeMap = {};
          return _dfChromeMap;
        });
    }
    return _dfChromeMapPromise;
  }
  // Kick the fetch off immediately so most call sites (fired after DOM ready)
  // find the map already resolved.
  loadDfChromeMap();

  function dfChromeGetCell(token) {
    return _dfChromeMap ? _dfChromeMap[token] : undefined;
  }

  function _dfChromeSheetImage(basename) {
    let img = _dfChromeImages[basename];
    if (!img) {
      img = new Image();
      img.src = DF_CHROME_ASSET_BASE + basename;
      _dfChromeImages[basename] = img;
    }
    return img;
  }

  // Integer pixel-art scale, minimum 1: DF art is never sub-sampled below its native resolution.
  function _dfChromeScaleFor(rec, sizePx) {
    if (!rec || !rec.w || !rec.h) return 1;
    const target = sizePx || Math.max(rec.w, rec.h);
    return Math.max(1, Math.round(target / Math.max(rec.w, rec.h)));
  }

  function _dfChromePaint(canvas, rec, scale) {
    if (!rec) return;
    const w = rec.w * scale, h = rec.h * scale;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    const img = _dfChromeSheetImage(rec.img);
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, rec.cx, rec.cy, rec.w, rec.h, 0, 0, w, h);
    };
    if (img.complete && img.naturalWidth) draw();
    else img.addEventListener("load", draw, { once: true });
  }

  // Repaint an existing canvas (e.g. produced by dfChromeIcon / dfChromeIconFromCell)
  // in place -- used for active/inactive toggles on the same button element.
  function dfChromeUpdateIcon(canvas, token, sizePx) {
    if (!canvas) return;
    const apply = () => {
      const rec = dfChromeGetCell(token);
      if (!rec) return;
      _dfChromePaint(canvas, rec, _dfChromeScaleFor(rec, sizePx));
    };
    if (_dfChromeMap) apply();
    else loadDfChromeMap().then(apply);
  }

  // Paints a raw {img,cx,cy,w,h} cell instead of resolving a TOKEN. ONLY for a sub-cell of a real
  // token, which has no name of its own; anything named goes through dfChromeIcon/dfChromeUpdateIcon.
  function dfChromeUpdateIconFromCell(canvas, rec, sizePx) {
    if (!canvas || !rec) return;
    _dfChromePaint(canvas, rec, _dfChromeScaleFor(rec, sizePx));
  }

  // Safe to append immediately: if the map or sheet image has not loaded, the canvas starts blank and
  // repaints itself once the data arrives.
  function dfChromeIcon(token, sizePx) {
    const canvas = document.createElement("canvas");
    canvas.className = "df-chrome-icon";
    canvas.width = sizePx || 32;
    canvas.height = sizePx || 32;
    dfChromeUpdateIcon(canvas, token, sizePx);
    return canvas;
  }

  // Same as dfChromeIcon but for a raw {img,cx,cy,w,h} record (see
  // dfChromeUpdateIconFromCell).
  function dfChromeIconFromCell(rec, sizePx) {
    const canvas = document.createElement("canvas");
    canvas.className = "df-chrome-icon";
    canvas.width = (rec && rec.w) || sizePx || 32;
    canvas.height = (rec && rec.h) || sizePx || 32;
    dfChromeUpdateIconFromCell(canvas, rec, sizePx);
    return canvas;
  }

  window.DFChrome = {
    loadMap: loadDfChromeMap,
    getCell: dfChromeGetCell,
    sheetImage: _dfChromeSheetImage,
    icon: dfChromeIcon,
    iconFromCell: dfChromeIconFromCell,
    updateIcon: dfChromeUpdateIcon,
    updateIconFromCell: dfChromeUpdateIconFromCell,
  };
