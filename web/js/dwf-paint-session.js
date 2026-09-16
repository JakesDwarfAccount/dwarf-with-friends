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
// ---- The shared paint/repaint session state: one region's EFFECTIVE shape while it is being edited. ----
// State only, no DOM: committed extents with staged edits folded in, which every renderer draws as normal art.
(function (root) {
  "use strict";

  // Native's "no anchor" value, mirrored from selection_rect.start_x so a caller can hand us the
  // sentinel safely instead of inventing its own idea of "nothing selected".
  var SENTINEL = -30000;

  // { kind, id, shape: {x1,y1,x2,y2,z,extents} | null, erasing }. `shape` is the region as it would look
  // if the session were accepted right now, which is what makes painted art appear immediately.
  var session = null;

  // Renderers that early-out on an unchanged fingerprint MUST fold this revision in, or a staged edit
  // will not repaint until something else on the map happens to move.
  var revision = 0;

  function clone(shape) {
    if (!shape) return null;
    return { x1: Number(shape.x1), y1: Number(shape.y1), x2: Number(shape.x2), y2: Number(shape.y2),
      z: Number(shape.z), extents: String(shape.extents || "") };
  }

  // `shape` may be null while the committed shape is still loading; renderers then draw the region normally.
  function publish(kind, id, shape, erasing) {
    session = { kind: String(kind), id: Number(id), shape: clone(shape), erasing: !!erasing };
    revision++;
  }

  function clear() {
    if (!session) return;
    session = null;
    revision++;
  }

  // Returns null unless this is the region being painted, so exactly one region is ever affected.
  function shapeFor(kind, id) {
    if (!session || !session.shape) return null;
    if (session.kind !== String(kind)) return null;
    if (Number(session.id) !== Number(id)) return null;
    return session.shape;
  }

  // True while any paint or repaint mode is open; native dims the whole viewport in this state.
  function modeOpen() { return !!session; }

  function active() { return session ? { kind: session.kind, id: session.id, erasing: session.erasing } : null; }

  root.DwfPaintSession = {
    SENTINEL: SENTINEL,
    publish: publish,
    clear: clear,
    shapeFor: shapeFor,
    modeOpen: modeOpen,
    active: active,
    revision: function () { return revision; },
  };
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
