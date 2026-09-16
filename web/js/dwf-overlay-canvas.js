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

// dwf-overlay-canvas.js -- canvas lifecycle shared by renderer-agnostic map overlays.
(function (root) {
  "use strict";

  function create(options) {
    var canvas = document.createElement("canvas");
    canvas.id = options.id;
    canvas.setAttribute("aria-hidden", "true");
    var s = canvas.style;
    s.position = "fixed";
    s.left = "0";
    s.top = "0";
    s.pointerEvents = options.pointerEvents;
    var zi = options.defaultZ;
    try {
      if (options.zAfterAnchor) {
        var anchorZ = parseInt(getComputedStyle(options.zAfterAnchor).zIndex, 10);
        if (!isNaN(anchorZ)) zi = anchorZ + 1;
      }
    } catch (_) { zi = options.defaultZ; }
    s.zIndex = String(zi);
    if (options.anchor && options.anchor.parentNode)
      options.anchor.parentNode.insertBefore(canvas, options.anchor.nextSibling);
    else document.body.appendChild(canvas);
    var context = canvas.getContext("2d");

    function resizeViewport() {
      var dpr = Math.max(1, window.devicePixelRatio || 1);
      var w = Math.max(1, Math.ceil(window.innerWidth));
      var h = Math.max(1, Math.ceil(window.innerHeight));
      if (canvas.width !== Math.ceil(w * dpr) || canvas.height !== Math.ceil(h * dpr)) {
        canvas.width = Math.ceil(w * dpr);
        canvas.height = Math.ceil(h * dpr);
        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      return context;
    }

    return { canvas: canvas, context: context, resizeViewport: resizeViewport };
  }

  root.DwfOverlayCanvas = { create: create };
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
