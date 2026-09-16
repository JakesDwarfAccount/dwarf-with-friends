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
// ---- The shared rectangle-gesture spine: per-family world anchors, one step(), one world->window map. ----
(function (root) {
  "use strict";

  // Native's "no anchor" sentinel, mirrored from selection_rect so a flow can hand us one safely.
  var SENTINEL = -30000;
  // A press that moves less than this is a CLICK, not a drag. Same number the back-out ladder
  // uses to tell a right-click from a right grab-pan, deliberately: one slop for one hand.
  var SLOP_PX = 6;

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // x/y/z are MAP tiles; w/h are the viewport frame dims the window-addressed routes still want, carried
  // along rather than re-derived at commit.
  function valid(sel) {
    if (!sel) return false;
    var xs = [num(sel.x1), num(sel.y1), num(sel.x2), num(sel.y2), num(sel.z)];
    for (var i = 0; i < xs.length; i++) if (xs[i] === null || xs[i] === SENTINEL) return false;
    return true;
  }

  // One anchor per FAMILY, never a shared global: DWF can hold a zone session open while a designation
  // tool is armed, which native never has to do.
  var anchors = Object.create(null);

  function arm(family, sel) {
    if (!family || !valid(sel)) return null;
    anchors[family] = {
      x1: num(sel.x1), y1: num(sel.y1), x2: num(sel.x2), y2: num(sel.y2),
      z: num(sel.z), w: num(sel.w), h: num(sel.h),
      tool: sel.tool === undefined ? null : sel.tool,
      family: family,
    };
    return anchors[family];
  }
  function armed(family) { return anchors[family] || null; }
  function clear(family) {
    if (!anchors[family]) return false;
    delete anchors[family];
    return true;
  }
  function clearAll() {
    var any = false;
    for (var key in anchors) { delete anchors[key]; any = true; }
    return any;
  }
  function armedFamily() {
    for (var key in anchors) return key;
    return null;
  }
  function armedFamilies() { return Object.keys(anchors); }

  // "commit" = the release completes a rectangle; "hold" = it was click 1. `armedThisPress` keeps them
  // apart: without it, arming on pointerdown makes click 1's own release commit a 1x1 rectangle.
  function step(state) {
    var s = state || {};
    var slop = num(s.slopPx);
    if (slop === null) slop = SLOP_PX;
    var moved = num(s.movedPx);
    if (moved === null) moved = 0;
    if (moved > slop) return "commit";
    if (s.armedBefore && !s.armedThisPress) return "commit";
    return "hold";
  }

  // The un-normalised anchor and cursor ride along: normalising alone throws away which corner the player
  // clicked first, and the shared readout must sit away from the growth direction.
  function merge(anchor, cursorSel) {
    if (!valid(anchor)) return null;
    var cur = valid(cursorSel) ? cursorSel : anchor;
    return {
      x1: Math.min(num(anchor.x1), num(cur.x1)), y1: Math.min(num(anchor.y1), num(cur.y1)),
      x2: Math.max(num(anchor.x2), num(cur.x2)), y2: Math.max(num(anchor.y2), num(cur.y2)),
      anchorX: num(anchor.x1), anchorY: num(anchor.y1),
      cursorX: num(cur.x1), cursorY: num(cur.y1),
      z: num(anchor.z), z2: num(cur.z),
      w: num(cur.w) === null ? num(anchor.w) : num(cur.w),
      h: num(cur.h) === null ? num(anchor.h) : num(cur.h),
      tool: anchor.tool === undefined ? null : anchor.tool,
      family: anchor.family || (cursorSel && cursorSel.family) || null,
    };
  }

  // Inclusive spans, native's rule (|delta| + 1 per axis). Depth comes from the anchor's z and
  // the cursor's z, which is how a gesture that spans levels reports three numbers instead of two.
  function dims(rect) {
    if (!rect) return null;
    var x1 = num(rect.x1), y1 = num(rect.y1), x2 = num(rect.x2), y2 = num(rect.y2);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    var z1 = num(rect.z), z2 = num(rect.z2);
    var d = (z1 === null || z2 === null) ? 1 : Math.abs(z2 - z1) + 1;
    return { w: Math.abs(x2 - x1) + 1, h: Math.abs(y2 - y1) + 1, d: d };
  }

  // `outside` is true when a corner was panned off-screen between the two clicks: these routes cannot
  // express a tile the frame does not contain, and the server would clamp silently.
  function toWindow(rect, view) {
    if (!rect || !view) return null;
    var ox = num(view.ox), oy = num(view.oy);
    var gw = num(view.gw), gh = num(view.gh);
    if (ox === null || oy === null) return null;
    var px1 = num(rect.x1) - ox, py1 = num(rect.y1) - oy;
    var px2 = num(rect.x2) - ox, py2 = num(rect.y2) - oy;
    var outside = false;
    if (gw !== null && gh !== null) {
      outside = px1 < 0 || py1 < 0 || px2 < 0 || py2 < 0 ||
        px1 > gw - 1 || px2 > gw - 1 || py1 > gh - 1 || py2 > gh - 1;
    }
    var clampX = function (v) { return gw === null ? v : Math.max(0, Math.min(gw - 1, v)); };
    var clampY = function (v) { return gh === null ? v : Math.max(0, Math.min(gh - 1, v)); };
    return {
      px1: Math.min(clampX(px1), clampX(px2)), py1: Math.min(clampY(py1), clampY(py2)),
      px2: Math.max(clampX(px1), clampX(px2)), py2: Math.max(clampY(py1), clampY(py2)),
      w: gw, h: gh, z: num(rect.z), outside: outside,
    };
  }

  // A single hovered tile as a world selection, so callers building a cursor never hand-roll the
  // shape (and so the fixture can too).
  function pointSelection(view, gx, gy, tool) {
    if (!view) return null;
    var ox = num(view.ox), oy = num(view.oy), oz = num(view.oz);
    var x = num(gx), y = num(gy);
    if (ox === null || oy === null || x === null || y === null) return null;
    return { x1: ox + x, y1: oy + y, x2: ox + x, y2: oy + y, z: oz,
      w: num(view.gw), h: num(view.gh), tool: tool === undefined ? null : tool };
  }

  var api = {
    SENTINEL: SENTINEL,
    SLOP_PX: SLOP_PX,
    valid: valid,
    arm: arm,
    armed: armed,
    clear: clear,
    clearAll: clearAll,
    armedFamily: armedFamily,
    armedFamilies: armedFamilies,
    step: step,
    merge: merge,
    dims: dims,
    toWindow: toWindow,
    pointSelection: pointSelection,
  };

  root.DwfGesture = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
