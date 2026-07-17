// dwf - PAUSE-ANIM: server-driven pause-aware WORLD animation clock (B206)
//
// TX18 put miasma (and every other EVENT_FLOWS art) on the client's shared 4Hz animation
// clock, and WB-15 put fire / water shimmer / machine frames / animated creatures on the GL
// u_timeMs clock. BOTH of those clocks tick on WALL time (performance.now / Date.now), so they
// kept animating while the GAME was paused -- The owner: "miasma animation does not stop when game is
// paused". Native DF freezes every game-WORLD animation on pause (the whole model tick halts);
// only UI feedback (status-icon blink, active-designation blink, cursor pulses, presence
// cursors) keeps moving.
//
// This module is the single source of truth for "how much wall time has been spent paused".
// A world-animation clock is simply `wallMs - offset(wallMs)`:
//   * offset() grows at exactly the wall rate WHILE paused, so subtracting it from ANY
//     wall-rate clock (perf.now OR Date.now) freezes that clock -> the current frame is HELD.
//   * on resume, the paused span is folded into `accumMs` once, so the world clock CONTINUES
//     from the exact value it held -- no jump, no skipped frames.
// Because offset() is a pure DURATION it is epoch-agnostic: the GL renderer (perf.now epoch)
// and the canvas2d machine clock (Date.now epoch) can each subtract it correctly. The frozen
// constant differs per epoch, but each animation is independent (floor(t/period) % frames), so
// a constant per-clock offset is invisible; only the freeze + resume-continuity matter.
//
// Pause STATE is the SERVER's, never a local button guess:
//   * dwf-pause.js onPause() -> setPaused(msg.paused)  (WP-B pause-arbiter broadcast; the
//     game is paused server-globally for every player, so this is authoritative + immediate);
//   * dwf-unit-hud-notifications.js renderHud() -> setPaused(hud.paused) as the fallback
//     for an old DLL with no broadcast, and to seed the state before the first broadcast.
//
// Inert-graceful: if this module never loads, both renderers fall back to raw wall time (the
// pre-B206 behaviour) -- offset() reads as 0, nothing throws.
(function () {
  "use strict";

  function pnow() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  var paused = false;
  var accumMs = 0;        // total wall time spent in COMPLETED paused spans (a pure duration)
  var pauseStartMs = 0;   // wall clock (pnow epoch) at the start of the CURRENT paused span

  // Total wall time to subtract so paused spans don't advance the world clock. During an open
  // pause span this includes the in-progress span (pnow()-pauseStartMs), which grows at the wall
  // rate -- that is what freezes `wallMs - offset(wallMs)`.
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
