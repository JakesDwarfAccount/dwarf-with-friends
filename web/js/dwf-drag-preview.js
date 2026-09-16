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
// ---- The shared drag-preview MODEL: readout arithmetic, palette and label placement, nothing else. ----
// The painter lives in dwf-core.js drawDragPreview; the flows publish intent through window.DFDragIntent.
(function (root) {
  "use strict";

  var SENTINEL = -30000; // native's "no anchor" value, mirrored so a flow can hand it to us safely

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function placed(point) {
    if (!point) return false;
    var x = num(point.x), y = num(point.y);
    if (x === null || y === null) return false;
    return x !== SENTINEL && y !== SENTINEL;
  }

  // Inclusive span, native's rule: |cursor - anchor| + 1 per axis. A flow that cannot span z omits z on
  // both points and gets d === 1, the truthful answer for a single-level selection.
  function dims(anchor, cursor) {
    if (!placed(anchor) || !placed(cursor)) return null;
    var ax = num(anchor.x), ay = num(anchor.y), az = num(anchor.z);
    var bx = num(cursor.x), by = num(cursor.y), bz = num(cursor.z);
    var d = 1;
    if (az !== null && bz !== null) d = Math.abs(bz - az) + 1;
    return {
      w: Math.abs(bx - ax) + 1,
      h: Math.abs(by - ay) + 1,
      d: d,
      right: bx >= ax,
      below: by >= ay,
    };
  }

  // Depth is appended only when the gesture actually spans levels. "" means draw nothing.
  function readout(size) {
    if (!size) return "";
    var w = num(size.w), h = num(size.h);
    if (w === null || h === null || w < 1 || h < 1) return "";
    var d = num(size.d);
    var text = w + " x " + h;
    if (d !== null && d > 1) text += " x " + d;
    return text;
  }

  // Convenience: anchor + cursor straight to the string, so a flow never re-derives the math.
  function readoutFor(anchor, cursor) {
    return readout(dims(anchor, cursor));
  }

  // The label follows the CURSOR corner, pushed out along the growth direction, so the numbers never
  // sit on the box being drawn.
  function labelPlacement(opts) {
    var o = opts || {};
    var box = o.box || {};
    var size = o.size || {};
    var pad = num(o.pad);
    if (pad === null) pad = 6;
    var left = num(box.left), top = num(box.top);
    var right = num(box.right), bottom = num(box.bottom);
    var w = num(size.w), h = num(size.h);
    if (left === null || top === null || right === null || bottom === null ||
        w === null || h === null) return null;
    var x = o.right ? right + pad : left - pad - w;
    var y = o.below ? bottom + pad + h : top - pad;
    if (o.clamp) {
      var c = o.clamp;
      var cx0 = num(c.left), cy0 = num(c.top), cx1 = num(c.right), cy1 = num(c.bottom);
      if (cx0 !== null && cx1 !== null) x = Math.max(cx0, Math.min(cx1 - w, x));
      if (cy0 !== null && cy1 !== null) y = Math.max(cy0 + h, Math.min(cy1, y));
    }
    return { x: x, y: y };
  }

  // One treatment per tool family, legible BEFORE the stroke commits. `dash` is the non-colour channel:
  // erase and remove are dashed and additive strokes solid, so they stay distinct without colour.
  var FAMILIES = {
    designate: { fill: "rgba(255, 196, 64, 0.16)", grid: "rgba(255, 210, 90, 0.22)",
                 border: "rgba(255, 214, 92, 0.95)", corner: "rgba(255, 236, 150, 1)", dash: [] },
    build:     { fill: "rgba(120, 235, 130, 0.16)", grid: "rgba(150, 245, 160, 0.24)",
                 border: "rgba(126, 230, 132, 0.95)", corner: "rgba(196, 255, 200, 1)", dash: [] },
    stockpile: { fill: "rgba(240, 176, 72, 0.18)", grid: "rgba(255, 200, 110, 0.26)",
                 border: "rgba(244, 186, 84, 0.95)", corner: "rgba(255, 226, 160, 1)", dash: [] },
    zone:      { fill: "rgba(96, 216, 232, 0.16)", grid: "rgba(130, 234, 246, 0.24)",
                 border: "rgba(104, 220, 236, 0.95)", corner: "rgba(190, 246, 252, 1)", dash: [] },
    burrow:    { fill: "rgba(176, 148, 244, 0.17)", grid: "rgba(198, 176, 250, 0.25)",
                 border: "rgba(182, 156, 246, 0.95)", corner: "rgba(226, 214, 255, 1)", dash: [] },
    select:    { fill: "rgba(255, 196, 64, 0.14)", grid: "rgba(255, 210, 90, 0.20)",
                 border: "rgba(255, 214, 92, 0.90)", corner: "rgba(255, 236, 150, 1)", dash: [] },
  };
  var ERASE = { fill: "rgba(236, 96, 84, 0.18)", grid: "rgba(255, 132, 118, 0.26)",
                border: "rgba(240, 104, 92, 0.95)", corner: "rgba(255, 176, 166, 1)", dash: [6, 4] };
  var REMOVE = { fill: "rgba(214, 54, 46, 0.24)", grid: "rgba(255, 108, 96, 0.30)",
                 border: "rgba(220, 62, 54, 1)", corner: "rgba(255, 154, 146, 1)", dash: [3, 3] };

  function familyNames() { return Object.keys(FAMILIES); }

  // intent: { family, erasing, removing }. Unknown families fall back to `select` (the generic
  // map rectangle) rather than throwing -- an overlay must never take the map down.
  function visualFor(intent) {
    var i = intent || {};
    var base = FAMILIES[i.family] || FAMILIES.select;
    var mode = "add";
    var skin = base;
    if (i.removing) { mode = "remove"; skin = REMOVE; }
    else if (i.erasing) { mode = "erase"; skin = ERASE; }
    return {
      family: FAMILIES[i.family] ? i.family : "select",
      mode: mode,
      fill: skin.fill, grid: skin.grid, border: skin.border, corner: skin.corner,
      dash: skin.dash.slice(),
    };
  }

  // The property the fixture pins: for one family, the ADD and the ERASE treatment must differ in
  // BOTH colour and dash, and never collapse onto each other.
  function visuallyDistinct(a, b) {
    if (!a || !b) return false;
    return a.fill !== b.fill && a.border !== b.border &&
      a.dash.join(",") !== b.dash.join(",");
  }

  root.DwfDragPreview = {
    SENTINEL: SENTINEL,
    placed: placed,
    dims: dims,
    readout: readout,
    readoutFor: readoutFor,
    labelPlacement: labelPlacement,
    visualFor: visualFor,
    visuallyDistinct: visuallyDistinct,
    familyNames: familyNames,
  };
})(typeof window !== "undefined" ? window : globalThis);
