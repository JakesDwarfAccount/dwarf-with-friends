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

// dwf-animclock.js -- the pause-aware world animation clock: how much wall time has been spent
// paused, so any wall-rate clock minus offset() freezes on pause and resumes without a jump.
(function () {
  "use strict";

  function pnow() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  var paused = false;
  var accumMs = 0;        // total wall time spent in COMPLETED paused spans (a pure duration)
  var pauseStartMs = 0;   // wall clock (pnow epoch) at the start of the CURRENT paused span

  // During an open pause span this includes the in-progress span, which grows at the wall rate -- that
  // is what freezes `wallMs - offset(wallMs)`.
  function offset(wallMs) {
    if (!paused) return accumMs;
    var t = (typeof wallMs === "number" && isFinite(wallMs)) ? wallMs : pnow();
    return accumMs + (t - pauseStartMs);
  }

  // Convenience world clock in the perf.now epoch (GL renderer's native clock).
  function now(wallMs) {
    var b = (typeof wallMs === "number" && isFinite(wallMs)) ? wallMs : pnow();
    return b - offset(b);
  }

  // Idempotent: a repeated same-state call is a no-op (the 1s hud poll re-asserts the current
  // value every tick; only an actual edge opens/closes a paused span).
  function setPaused(p, wallMs) {
    p = !!p;
    if (p === paused) return;
    var t = (typeof wallMs === "number" && isFinite(wallMs)) ? wallMs : pnow();
    if (p) {
      paused = true;
      pauseStartMs = t;
    } else {
      // Fold the just-finished paused span into the accumulated offset ONCE. The world clock
      // then reads `wallMs - accumMs`, continuing seamlessly from the value it held while paused.
      accumMs += (t - pauseStartMs);
      paused = false;
    }
  }

  function isPaused() { return paused; }

  // Test seam: restore a virgin clock between fixture sections.
  function _reset() { paused = false; accumMs = 0; pauseStartMs = 0; }

  var api = { setPaused: setPaused, offset: offset, now: now, isPaused: isPaused, _reset: _reset };
  if (typeof window !== "undefined") window.DFAnimClock = api;
  if (typeof self !== "undefined" && self !== (typeof window !== "undefined" ? window : null)) self.DFAnimClock = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
