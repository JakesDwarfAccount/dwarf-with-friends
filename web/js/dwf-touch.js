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

// WT20 (mobile): touch-gesture layer for the map canvas.
//
// The owner: "Make it work on mobile!!" -- this module is the INPUT half of the first cut. It maps
// touch gestures on #view onto the SAME camera/selection primitives mouse+keyboard use
// (nothing is forked; see the hooks table):
//
//   one-finger drag            -> grab-pan (window.DFTouchNav.panTiles -> core queueMove; the
//                                 identical tile-delta+remainder math as core's middle-drag pan)
//   pinch                      -> continuous view zoom (DFTouchNav.zoomToPx -> tileRenderer
//                                 zoomTo + core applyZoomResult, center-on-view like [ ])
//   two-finger vertical swipe  -> z-level change (DFTouchNav.zStep -> queueMove(0,0,dz); swipe
//                                 up = ascend, mirroring Shift+wheel-up = +z)
//   tap                        -> the EXACT click the mouse makes: re-dispatches a synthetic
//                                 pointerdown+pointerup pair on #view so the existing
//                                 controls-placement pointerup chain (inspect / zone select /
//                                 armed squad-kill / ws-link click...) runs unchanged.
//
// FEATURE DETECTION, NEVER UA-SNIFFING: the listeners are attached unconditionally but act
// only on events whose pointerType === "touch" -- a device that never produces touch pointers
// never enters this code path, so desktop mouse/pen behavior is PROVABLY unchanged (the
// listeners early-return before touching any state).
//
// PLACEMENT PASS-THROUGH: while a placement/designation tool is armed
// (window.DFPlacementArmed(), exported by dwf-controls-placement.js), single-finger
// touches are NOT intercepted -- they flow into the existing designation drag path, which
// already works via pointer events. Touch-first designation ERGONOMICS are explicitly
// deferred (WT20 scope); this keeps tools functional without forking their input path.
// Two-finger gestures are always camera gestures, armed or not.
//
// Also owns the on-screen-keyboard inset: a --dfvv-kb-inset CSS var maintained from
// visualViewport so bottom-anchored chrome (chat) rides above the keyboard on browsers that
// overlay it (iOS) instead of resizing the layout viewport (Android w/ resizes-content).
//
// Pure gesture math + the controller state machine are node-exported at the bottom for
// tools/harness/wt20_touch_test.mjs (no DOM needed -- the controller takes plain
// {pointerId,clientX,clientY} objects and calls injected hooks).

(function () {
  "use strict";

  // ---- tuning ---------------------------------------------------------------------------
  const TAP_SLOP_PX = 10;        // move less than this = still a tap
  const TAP_MAX_MS = 450;        // hold longer than this = not a tap (no accidental inspects)
  const TWO_FINGER_CLASSIFY_PX = 28;  // dominant-axis threshold before pinch-vs-zswipe locks
  const ZSWIPE_STEP_PX = 56;     // two-finger vertical px per one z-level step
  const PINCH_MIN_PX_DELTA = 0.75;    // don't spam zoomToPx for sub-pixel px/tile changes

  // ---- pure gesture math (node-testable) --------------------------------------------------

  // Grab-pan: content follows the finger. Same math as dwf-core's middle-drag pan --
  // whole-tile deltas are committed, the sub-tile remainder stays in the anchor for smoothness.
  function panTileStep(anchorX, anchorY, curX, curY, cellPx) {
    const cell = (Number.isFinite(cellPx) && cellPx > 0) ? cellPx : 24;
    const dxTiles = Math.round((anchorX - curX) / cell);
    const dyTiles = Math.round((anchorY - curY) / cell);
    return {
      dxTiles, dyTiles,
      anchorX: anchorX - dxTiles * cell,
      anchorY: anchorY - dyTiles * cell,
    };
  }

  function touchDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function touchMidY(a, b) { return (a.y + b.y) / 2; }

  // Two-finger classification: whichever axis first exceeds the threshold wins and LOCKS for
  // the rest of the gesture (no mid-gesture flip-flop between zoom and z).
  function classifyTwoFinger(startDist, curDist, startMidY, curMidY, threshold) {
    const t = (Number.isFinite(threshold) && threshold > 0) ? threshold : TWO_FINGER_CLASSIFY_PX;
    const distDelta = Math.abs(curDist - startDist);
    const midDelta = Math.abs(curMidY - startMidY);
    if (distDelta < t && midDelta < t) return null;      // not decisive yet
    return distDelta >= midDelta ? "pinch" : "zswipe";
  }

  // Pinch: view px/tile scales with the finger-distance ratio (natural direct-manipulation
  // feel: spread = zoom in). Clamping to the renderer's [min,max] happens in zoomTo itself.
  function pinchZoomPx(startPx, startDist, curDist) {
    if (!(startDist > 0) || !(curDist > 0) || !Number.isFinite(startPx)) return startPx;
    return startPx * (curDist / startDist);
  }

  // Z-swipe: accumulated two-finger vertical movement -> whole z steps + remainder.
  // Fingers moving UP (dy negative) = ascend (+z), mirroring Shift+wheel-up = +z.
  function zSwipeSteps(accumPx, stepPx) {
    const s = (Number.isFinite(stepPx) && stepPx > 0) ? stepPx : ZSWIPE_STEP_PX;
    const steps = Math.trunc(accumPx / s);
    return { steps, remainder: accumPx - steps * s };
  }

  function isTap(downX, downY, downT, upX, upY, upT, slop, maxMs) {
    const sl = (Number.isFinite(slop) && slop > 0) ? slop : TAP_SLOP_PX;
    const mm = (Number.isFinite(maxMs) && maxMs > 0) ? maxMs : TAP_MAX_MS;
    return Math.hypot(upX - downX, upY - downY) < sl && (upT - downT) < mm;
  }

  // Keyboard inset: how much of the layout viewport the on-screen keyboard covers. Zero when
  // the browser resizes the layout viewport instead (interactive-widget=resizes-content).
  function keyboardInsetPx(innerHeight, vvHeight, vvOffsetTop) {
    if (!Number.isFinite(innerHeight) || !Number.isFinite(vvHeight)) return 0;
    const off = Number.isFinite(vvOffsetTop) ? vvOffsetTop : 0;
    return Math.max(0, Math.round(innerHeight - vvHeight - off));
  }

  // ---- gesture controller (state machine; node-testable with injected hooks) ---------------
  //
  // hooks = {
  //   placementArmed(): bool          -- pass single-finger input through to designation
  //   cellPx(): number                -- CSS px per tile (for pan tile math)
  //   panTiles(dxTiles, dyTiles)      -- camera pan
  //   zStep(dz)                       -- camera z-level change
  //   zoomToPx(px), getZoomPx(): px   -- continuous view zoom
  //   tap(clientX, clientY)           -- synthesize the mouse-identical click
  //   now(): ms                       -- injectable clock (tests)
  // }
  //
  // handle*(pt) takes {pointerId, clientX, clientY} and returns TRUE when the event was
  // consumed (browser layer then preventDefault+stopImmediatePropagation's the real event)
  // and FALSE when it must flow through to the existing handlers untouched.
  function createTouchController(hooks) {
    const now = hooks.now || (() => Date.now());
    const touches = new Map();     // pointerId -> {x, y}
    const passthrough = new Set(); // pointerIds owned by the designation path
    let single = null;             // {id, downX, downY, downT, anchorX, anchorY, panning}
    let multi = null;              // {ids:[a,b], startDist, startMidY, lastMidY, mode, startPx, zAccum, lastSentPx}

    function reset() { touches.clear(); passthrough.clear(); single = null; multi = null; }

    function beginMulti() {
      const ids = Array.from(touches.keys()).slice(0, 2);
      const a = touches.get(ids[0]), b = touches.get(ids[1]);
      multi = {
        ids,
        startDist: touchDist(a, b),
        startMidY: touchMidY(a, b),
        lastMidY: touchMidY(a, b),
        mode: null,
        startPx: (hooks.getZoomPx && hooks.getZoomPx()) || 24,
        lastSentPx: (hooks.getZoomPx && hooks.getZoomPx()) || 24,
        zAccum: 0,
      };
      single = null; // a second finger always cancels tap/pan-in-progress
    }

    function handleDown(pt) {
      if (passthrough.size) return false; // a designation drag owns this gesture entirely
      if (touches.size === 0 && hooks.placementArmed && hooks.placementArmed()) {
        // Armed tool: existing designation pointer path handles this finger natively.
        passthrough.add(pt.pointerId);
        return false;
      }
      touches.set(pt.pointerId, { x: pt.clientX, y: pt.clientY });
      if (touches.size === 1) {
        single = {
          id: pt.pointerId,
          downX: pt.clientX, downY: pt.clientY, downT: now(),
          anchorX: pt.clientX, anchorY: pt.clientY,
          panning: false,
        };
      } else if (touches.size === 2) {
        beginMulti();
      }
      // 3+ fingers: tracked but inert (first two keep the gesture).
      return true;
    }

    function handleMove(pt) {
      if (passthrough.has(pt.pointerId)) return false;
      const t = touches.get(pt.pointerId);
      if (!t) return false;
      t.x = pt.clientX; t.y = pt.clientY;

      if (multi && multi.ids.indexOf(pt.pointerId) >= 0) {
        const a = touches.get(multi.ids[0]), b = touches.get(multi.ids[1]);
        if (!a || !b) return true;
        const dist = touchDist(a, b);
        const midY = touchMidY(a, b);
        if (!multi.mode) {
          multi.mode = classifyTwoFinger(multi.startDist, dist, multi.startMidY, midY);
          if (multi.mode === "zswipe") multi.lastMidY = midY; // measure from lock point
        }
        if (multi.mode === "pinch") {
          const px = pinchZoomPx(multi.startPx, multi.startDist, dist);
          if (Math.abs(px - multi.lastSentPx) >= PINCH_MIN_PX_DELTA && hooks.zoomToPx) {
            multi.lastSentPx = px;
            hooks.zoomToPx(px);
          }
        } else if (multi.mode === "zswipe") {
          // fingers up (negative dy) = ascend (+z)
          multi.zAccum += (multi.lastMidY - midY);
          multi.lastMidY = midY;
          const r = zSwipeSteps(multi.zAccum, ZSWIPE_STEP_PX);
          if (r.steps !== 0 && hooks.zStep) hooks.zStep(r.steps);
          multi.zAccum = r.remainder;
        }
        return true;
      }

      if (single && single.id === pt.pointerId) {
        if (!single.panning &&
            Math.hypot(pt.clientX - single.downX, pt.clientY - single.downY) >= TAP_SLOP_PX) {
          single.panning = true;
        }
        if (single.panning) {
          const cell = (hooks.cellPx && hooks.cellPx()) || 24;
          const s = panTileStep(single.anchorX, single.anchorY, pt.clientX, pt.clientY, cell);
          if ((s.dxTiles || s.dyTiles) && hooks.panTiles) hooks.panTiles(s.dxTiles, s.dyTiles);
          single.anchorX = s.anchorX;
          single.anchorY = s.anchorY;
        }
        return true;
      }
      return true; // tracked but inert (3rd finger)
    }

    function handleUp(pt) {
      if (passthrough.has(pt.pointerId)) { passthrough.delete(pt.pointerId); return false; }
      if (!touches.has(pt.pointerId)) return false;
      touches.delete(pt.pointerId);

      if (multi && multi.ids.indexOf(pt.pointerId) >= 0) {
        multi = null;
        // A remaining finger continues as a pan, re-anchored where it sits now (no tap risk).
        const rest = Array.from(touches.entries())[0];
        if (rest) {
          single = {
            id: rest[0],
            downX: rest[1].x, downY: rest[1].y, downT: 0, // downT 0 => never re-classifies as tap
            anchorX: rest[1].x, anchorY: rest[1].y,
            panning: true,
          };
        }
        return true;
      }

      if (single && single.id === pt.pointerId) {
        const wasTap = !single.panning &&
          isTap(single.downX, single.downY, single.downT,
                pt.clientX, pt.clientY, now(), TAP_SLOP_PX, TAP_MAX_MS);
        single = null;
        if (wasTap && hooks.tap) hooks.tap(pt.clientX, pt.clientY);
        return true;
      }
      return true;
    }

    function handleCancel(pt) {
      if (passthrough.has(pt.pointerId)) { passthrough.delete(pt.pointerId); return false; }
      if (!touches.has(pt.pointerId)) return false;
      touches.delete(pt.pointerId);
      if (multi && multi.ids.indexOf(pt.pointerId) >= 0) multi = null;
      if (single && single.id === pt.pointerId) single = null;
      return true;
    }

    return {
      handleDown, handleMove, handleUp, handleCancel,
      reset,
      _state: () => ({
        touches: touches.size,
        passthrough: passthrough.size,
        panning: !!(single && single.panning),
        multiMode: multi ? multi.mode : null,
      }),
    };
  }

  // ---- browser wiring ----------------------------------------------------------------------
  function bindBrowser() {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const view = document.getElementById("view");
    if (!view) return;

    const hooks = {
      placementArmed: () => {
        try { return !!(window.DFPlacementArmed && window.DFPlacementArmed()); }
        catch (_) { return false; }
      },
      cellPx: () => {
        try {
          const nav = window.DFTouchNav;
          return (nav && nav.cellPx && nav.cellPx()) || 24;
        } catch (_) { return 24; }
      },
      panTiles: (dx, dy) => { try { window.DFTouchNav && window.DFTouchNav.panTiles(dx, dy); } catch (_) {} },
      zStep: dz => { try { window.DFTouchNav && window.DFTouchNav.zStep(dz); } catch (_) {} },
      zoomToPx: px => { try { window.DFTouchNav && window.DFTouchNav.zoomToPx(px); } catch (_) {} },
      getZoomPx: () => {
        try { return (window.DFTouchNav && window.DFTouchNav.getZoomPx()) || 24; }
        catch (_) { return 24; }
      },
      // Tap = re-dispatch a synthetic pointerdown+pointerup pair on #view. The EXISTING
      // controls-placement handlers then run their normal pointerup chain (clickDistance 0 ->
      // inspect / zone select / armed click actions), identical to a mouse left-click. The
      // __dfTouchSynthetic marker keeps this layer from re-intercepting its own events.
      tap: (x, y) => {
        try {
          const init = {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0, buttons: 1,
            pointerId: 1, pointerType: "touch", isPrimary: true,
          };
          for (const type of ["pointerdown", "pointerup"]) {
            const ev = (typeof PointerEvent === "function")
              ? new PointerEvent(type, init)
              : new MouseEvent(type, init);
            try { ev.__dfTouchSynthetic = true; } catch (_) {}
            view.dispatchEvent(ev);
          }
        } catch (_) {}
      },
    };

    const ctrl = createTouchController(hooks);
    // Capture phase on window so this layer sees touch pointers BEFORE the target-phase map
    // handlers in dwf-core/controls-placement -- consumed gestures never reach them.
    const opts = { capture: true, passive: false };
    const route = (handler, requireViewTarget) => ev => {
      if (!ev || ev.pointerType !== "touch" || ev.__dfTouchSynthetic) return;
      if (requireViewTarget && ev.target !== view) return;
      const consumed = handler({ pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY });
      if (consumed) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    };
    window.addEventListener("pointerdown", route(ctrl.handleDown, true), opts);
    window.addEventListener("pointermove", route(ctrl.handleMove, false), opts);
    window.addEventListener("pointerup", route(ctrl.handleUp, false), opts);
    window.addEventListener("pointercancel", route(ctrl.handleCancel, false), opts);

    // ---- on-screen keyboard inset (visualViewport -> CSS var) ------------------------------
    // Browsers that OVERLAY the keyboard (iOS Safari) shrink visualViewport but not the layout
    // viewport; bottom-anchored chrome (chat) offsets itself by this var to stay visible.
    // Browsers that RESIZE the layout viewport (Android Chrome + interactive-widget=
    // resizes-content in index.html) yield inset 0 here and the normal resize path handles it.
    const vv = window.visualViewport;
    if (vv && document.documentElement) {
      const apply = () => {
        try {
          const inset = keyboardInsetPx(window.innerHeight, vv.height, vv.offsetTop);
          document.documentElement.style.setProperty("--dfvv-kb-inset", inset + "px");
        } catch (_) {}
      };
      vv.addEventListener("resize", apply);
      vv.addEventListener("scroll", apply);
      apply();
    }

    try { window.DFTouch = { _controller: ctrl }; } catch (_) {}
  }

  bindBrowser();

  // ---- node exports for the fixture harness -------------------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      panTileStep,
      classifyTwoFinger,
      pinchZoomPx,
      zSwipeSteps,
      isTap,
      keyboardInsetPx,
      createTouchController,
      TAP_SLOP_PX, TAP_MAX_MS, TWO_FINGER_CLASSIFY_PX, ZSWIPE_STEP_PX,
    };
  }
})();
