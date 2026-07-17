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

// wt20_touch_test.mjs -- WT20 mobile touch layer: gesture->camera mapping (pure state machine
// driven with synthesized pointer records + mock camera hooks), viewport/keyboard-inset math,
// and the static source contracts (viewport meta, coarse-pointer CSS layer, chat inset var,
// core DFTouchNav hook, controls-placement DFPlacementArmed export, no-UA-sniff rule).
//
//   node tools/harness/wt20_touch_test.mjs
// Exit: 0 PASS, 1 FAIL. No DF, no server, no browser. Real pinch PHYSICS (browser-synthesized
// touch streams, palm rejection, iOS quirks) cannot be expressed here -- the pure math is
// tested directly and live phone verification is listed in the WT20 report.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const webjs = name => path.resolve(here, "../../web/js", name);
const read = p => fs.readFileSync(path.resolve(here, "../..", p), "utf8");

let passed = 0, failed = 0;
function check(value, name) {
  if (value) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

// ---- module loads + parses -------------------------------------------------------------------
console.log("# module load");
try {
  execFileSync(process.execPath, ["--check", webjs("dwf-touch.js")], { stdio: "pipe" });
  check(true, "dwf-touch.js passes node --check");
} catch (e) {
  check(false, "dwf-touch.js passes node --check: " + (e.stderr ? e.stderr.toString() : e.message));
}
const T = require(webjs("dwf-touch.js"));
check(["panTileStep", "classifyTwoFinger", "pinchZoomPx", "zSwipeSteps", "isTap",
       "keyboardInsetPx", "createTouchController"].every(k => typeof T[k] === "function"),
  "module exports the pure gesture API");

// ---- pure math: grab-pan ----------------------------------------------------------------------
console.log("# panTileStep (grab-pan: content follows the finger)");
{
  // finger moves RIGHT 100 css px at 25 px/tile -> camera moves LEFT 4 tiles (dx = -4)
  const s = T.panTileStep(200, 300, 300, 300, 25);
  check(s.dxTiles === -4 && s.dyTiles === 0, "100px right @25px/tile -> dxTiles -4 (content follows finger)");
  check(s.anchorX === 200 - (-4) * 25 && s.anchorY === 300, "anchor keeps sub-tile remainder");
  // finger moves UP 60 px at 24 -> dyTiles +3 (round(60/24)=3) -> camera down? NO: up-finger =
  // content up = camera moves DOWN in screen terms = +y in map coords (queueMove(0,+3) shows
  // tiles further down/south). Mirrors core.js middle-drag exactly: dy = round((anchor-cur)/cell).
  const v = T.panTileStep(100, 300, 100, 240, 24);
  check(v.dyTiles === 3 && v.dxTiles === 0, "60px up @24px/tile -> dyTiles +3 (same sign math as core middle-drag)");
  // seeded-bad: an implementation that panned the WRONG WAY (content flees the finger) would
  // return dxTiles +4 for the first case; assert that fails this suite's expectation.
  check(s.dxTiles !== 4, "(test-the-test) inverted-pan implementation would be rejected");
  // sub-tile move commits nothing
  const t = T.panTileStep(100, 100, 108, 105, 24);
  check(t.dxTiles === 0 && t.dyTiles === 0 && t.anchorX === 100 && t.anchorY === 100,
    "sub-tile movement commits no tiles and keeps the anchor");
  // degenerate cell -> falls back to 24, never divides by zero
  const d = T.panTileStep(0, 0, -48, 0, 0);
  check(d.dxTiles === 2, "cellPx<=0 falls back to 24px/tile (never NaN)");
}

// ---- pure math: two-finger classification ------------------------------------------------------
console.log("# classifyTwoFinger");
{
  check(T.classifyTwoFinger(100, 104, 200, 203) === null, "small deltas -> undecided (no premature lock)");
  check(T.classifyTwoFinger(100, 160, 200, 205) === "pinch", "distance delta dominates -> pinch");
  check(T.classifyTwoFinger(100, 104, 200, 260) === "zswipe", "vertical mid delta dominates -> zswipe");
  // seeded-bad: equal deltas past threshold must pick ONE deterministically (pinch), never flap
  check(T.classifyTwoFinger(100, 150, 200, 250) === "pinch", "(test-the-test) tie is deterministic (pinch)");
}

// ---- pure math: pinch + zswipe + tap + keyboard inset ------------------------------------------
console.log("# pinch / zswipe / tap / keyboard-inset math");
{
  check(T.pinchZoomPx(24, 100, 200) === 48, "spread x2 doubles px/tile (zoom in)");
  check(T.pinchZoomPx(24, 200, 100) === 12, "close x0.5 halves px/tile (zoom out)");
  check(T.pinchZoomPx(24, 0, 100) === 24, "zero start distance -> unchanged (no Infinity)");

  const z1 = T.zSwipeSteps(130, 56);
  check(z1.steps === 2 && Math.abs(z1.remainder - 18) < 1e-9, "130px @56px/step -> 2 steps, 18px remainder");
  const z2 = T.zSwipeSteps(-130, 56);
  check(z2.steps === -2, "negative accumulation -> negative steps (descend)");
  check(T.zSwipeSteps(55, 56).steps === 0, "below one step -> nothing (no jitter stepping)");

  check(T.isTap(10, 10, 1000, 14, 12, 1200) === true, "small+quick -> tap");
  check(T.isTap(10, 10, 1000, 40, 10, 1200) === false, "(test-the-test) 30px slide is NOT a tap");
  check(T.isTap(10, 10, 1000, 11, 11, 1600) === false, "(test-the-test) 600ms hold is NOT a tap");

  check(T.keyboardInsetPx(800, 500, 0) === 300, "overlay keyboard: inset = hidden height");
  check(T.keyboardInsetPx(800, 800, 0) === 0, "no keyboard -> 0");
  check(T.keyboardInsetPx(500, 500, 0) === 0, "resized layout viewport (Android) -> 0");
  check(T.keyboardInsetPx(NaN, 500, 0) === 0, "garbage inputs -> 0, never NaN leaks into CSS");
}

// ---- controller: synthesized gesture streams vs mock camera hooks ------------------------------
console.log("# gesture controller (synthesized TouchEvents -> camera calls)");
function mockHooks(overrides) {
  const calls = { pan: [], z: [], zoomTo: [], tap: [] };
  let t = 1000;
  const hooks = Object.assign({
    placementArmed: () => false,
    cellPx: () => 24,
    getZoomPx: () => 24,
    panTiles: (dx, dy) => calls.pan.push([dx, dy]),
    zStep: dz => calls.z.push(dz),
    zoomToPx: px => calls.zoomTo.push(px),
    tap: (x, y) => calls.tap.push([x, y]),
    now: () => t,
    _tick: ms => { t += ms; },
  }, overrides || {});
  return { hooks, calls };
}
const pt = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y });

{ // tap
  const { hooks, calls } = mockHooks();
  const c = T.createTouchController(hooks);
  check(c.handleDown(pt(7, 120, 140)) === true, "tap: pointerdown consumed");
  hooks._tick(80);
  check(c.handleUp(pt(7, 123, 141)) === true, "tap: pointerup consumed");
  check(calls.tap.length === 1 && calls.tap[0][0] === 123 && calls.tap[0][1] === 141,
    "tap fires ONE synthetic click at the release point");
  check(calls.pan.length === 0 && calls.z.length === 0 && calls.zoomTo.length === 0,
    "tap moves no camera");
}
{ // one-finger pan
  const { hooks, calls } = mockHooks();
  const c = T.createTouchController(hooks);
  c.handleDown(pt(1, 300, 300));
  c.handleMove(pt(1, 252, 300));   // 48px left @24 -> 2 tiles right (content follows finger)
  c.handleMove(pt(1, 204, 300));   // another 48px
  hooks._tick(200);
  c.handleUp(pt(1, 204, 300));
  check(calls.pan.length === 2 && calls.pan[0][0] === 2 && calls.pan[1][0] === 2,
    "drag left pans camera +2 tiles per 48px step (grab-pan)");
  check(calls.tap.length === 0, "a pan never also taps");
}
{ // pinch
  const { hooks, calls } = mockHooks();
  const c = T.createTouchController(hooks);
  c.handleDown(pt(1, 100, 300));
  c.handleDown(pt(2, 200, 300));   // startDist 100
  c.handleMove(pt(2, 300, 300));   // dist 200 -> pinch, zoomTo 24*2=48
  check(calls.zoomTo.length === 1 && Math.abs(calls.zoomTo[0] - 48) < 1e-9,
    "spread x2 -> zoomToPx(48)");
  c.handleMove(pt(2, 300.5, 300)); // px/tile delta ~0.12 -> throttled away
  check(calls.zoomTo.length === 1, "sub-threshold pinch move does not spam zoomToPx");
  check(calls.z.length === 0 && calls.tap.length === 0, "pinch never z-steps or taps");
}
{ // two-finger vertical swipe = z
  const { hooks, calls } = mockHooks();
  const c = T.createTouchController(hooks);
  c.handleDown(pt(1, 100, 400));
  c.handleDown(pt(2, 160, 400));
  c.handleMove(pt(1, 100, 360));   // mid moves up 20 -> not classified yet (< 28)
  c.handleMove(pt(2, 160, 340));   // mid now up 50 -> zswipe locks
  c.handleMove(pt(1, 100, 240));   // keep swiping up past a full step
  c.handleMove(pt(2, 160, 220));
  check(calls.z.length > 0 && calls.z.every(dz => dz > 0), "two-finger swipe UP ascends (+z, mirrors Shift+wheel-up)");
  check(calls.zoomTo.length === 0, "locked zswipe never zooms");
  const total = calls.z.reduce((a, b) => a + b, 0);
  check(total >= 1 && total <= 4, "z steps proportional to swipe distance (no runaway)");
}
{ // two-finger swipe DOWN descends (fingers alternate in small steps, like a real stream --
  // one big single-finger jump would transiently read as a distance change and lock pinch)
  const { hooks, calls } = mockHooks();
  const c = T.createTouchController(hooks);
  c.handleDown(pt(1, 100, 200));
  c.handleDown(pt(2, 160, 200));
  c.handleMove(pt(1, 100, 260));
  c.handleMove(pt(2, 160, 270));
  c.handleMove(pt(1, 100, 330));
  c.handleMove(pt(2, 160, 340));
  check(calls.z.length > 0 && calls.z.every(dz => dz < 0), "two-finger swipe DOWN descends (-z)");
}
{ // armed placement tool -> single-finger passthrough (existing designation path owns it)
  const { hooks, calls } = mockHooks({ placementArmed: () => true });
  const c = T.createTouchController(hooks);
  check(c.handleDown(pt(3, 50, 50)) === false, "armed: pointerdown NOT consumed (flows to designation)");
  check(c.handleMove(pt(3, 90, 90)) === false, "armed: pointermove NOT consumed");
  check(c.handleUp(pt(3, 90, 90)) === false, "armed: pointerup NOT consumed");
  check(calls.pan.length === 0 && calls.tap.length === 0, "armed: touch layer stays fully inert");
}
{ // second finger cancels tap; lifting back to one continues as pan, ends without tap
  const { hooks, calls } = mockHooks();
  const c = T.createTouchController(hooks);
  c.handleDown(pt(1, 100, 100));
  c.handleDown(pt(2, 200, 100));
  c.handleUp(pt(2, 200, 100));     // back to one finger
  c.handleMove(pt(1, 52, 100));    // continues as pan from current spot
  hooks._tick(50);
  c.handleUp(pt(1, 52, 100));
  check(calls.tap.length === 0, "finger that survived a two-finger gesture can never tap");
  check(calls.pan.length === 1 && calls.pan[0][0] === 2, "surviving finger re-anchors and pans");
}
{ // pointercancel resets cleanly
  const { hooks, calls } = mockHooks();
  const c = T.createTouchController(hooks);
  c.handleDown(pt(1, 100, 100));
  check(c.handleCancel(pt(1, 100, 100)) === true, "cancel consumed for a tracked touch");
  hooks._tick(10);
  check(c.handleUp(pt(1, 100, 100)) === false, "post-cancel events for that id are ignored");
  check(calls.tap.length === 0, "cancel never taps");
  check(c._state().touches === 0, "cancel leaves no tracked touches");
}

// ---- static source contracts -------------------------------------------------------------------
console.log("# static contracts (viewport / CSS / wiring)");
const html = read("web/index.html");
const css = read("web/css/dwf.css");
const core = read("web/js/dwf-core.js");
const controls = read("web/js/dwf-controls-placement.js");
const chat = read("web/js/dwf-chat.js");
const touchSrc = read("web/js/dwf-touch.js");

check(/name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"/.test(html),
  "viewport meta: device-width + viewport-fit=cover + interactive-widget=resizes-content");
check(/<script src="\/js\/dwf-touch\.js\?v=/.test(html), "index.html loads the touch layer");

check(/@media \(pointer: coarse\)/.test(css), "shared CSS has ONE coarse-pointer layer");
const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
check(/#view, #zoneOverlay \{ touch-action: none; \}/.test(coarse), "coarse layer pins touch-action:none on the map surfaces");
check(/\.pf-head \{ touch-action: none; min-height: 40px; \}/.test(coarse), "panel headers are touch-draggable with a 40px floor");
check(/\.pf-x, \[data-pf-close\][\s\S]*?min-width: 40px;\s*min-height: 40px;/.test(coarse),
  "close-button vocabulary gets the 40px hit floor");
check(/min-height: min|max-height: min\(72vh, calc\(100dvh - 108px\)\)/.test(coarse),
  "panels are capped to the (keyboard-aware) viewport and scroll within themselves");
check(/font-size: 16px/.test(coarse), "chat input >=16px on coarse pointers (defeats iOS focus-zoom)");
check(/input\[type="text"\], input\[type="search"\][\s\S]*?font-size: max\(16px, 1em\)/.test(coarse),
  "EVERY text-entry surface floors at 16px (iOS focus-zoom persists after blur -- must never trigger)");
check(/overscroll-behavior: none/.test(css), "overscroll never chains into pull-to-refresh");
check(/touch-action:\s*none/.test(css.slice(0, css.indexOf("@media (pointer: coarse)"))),
  "base sheet keeps body touch-action:none (browser gesture hijack blocked everywhere)");

check(/window\.DFTouchNav = \{[\s\S]*?panTiles:[\s\S]*?zStep:[\s\S]*?zoomToPx:[\s\S]*?getZoomPx,[\s\S]*?cellPx:/.test(core),
  "core exports DFTouchNav {panTiles,zStep,zoomToPx,getZoomPx,cellPx}");
check(/panTiles: \(dx, dy\) => queueMove\(dx \| 0, dy \| 0, 0\)/.test(core),
  "touch pan drives the SAME queueMove as keyboard/middle-drag (no forked camera path)");
check(/const d = tileRenderer\.zoomTo\(px\);\s*\n\s*if \(getZoomPx\(\) !== before\) applyZoomResult\(d\);/.test(core),
  "pinch zoom drives tileRenderer.zoomTo through applyZoomResult (center-on-view, like [ ])");
check(/const before = getZoomPx\(\);/.test(core),
  "clamped pinch (at zoom min/max) never spams refreshMap refetches");

check(/function placementArmed\(\)/.test(controls) && /window\.DFPlacementArmed = placementArmed/.test(controls),
  "controls-placement exports the armed-placement predicate");
check((controls.match(/placementArmed\(\)/g) || []).length >= 3,
  "both drag handlers use the ONE extracted predicate (no drifting duplicate conditions)");
check(/try \{ view\.setPointerCapture\(event\.pointerId\); \} catch \(_\) \{\}/.test(controls),
  "left-button setPointerCapture is guarded (synthetic tap ids cannot throw)");

check(/bottom:calc\(52px \+ var\(--dfvv-kb-inset, 0px\)\)/.test(chat) &&
      (chat.match(/--dfvv-kb-inset/g) || []).length >= 2,
  "chat toggle AND panel ride the keyboard inset var");
check(/--dfvv-kb-inset/.test(touchSrc) && /visualViewport/.test(touchSrc),
  "touch layer maintains the inset var from visualViewport");

check(/pointerType !== "touch"/.test(touchSrc), "touch layer acts only on pointerType===touch events");
check(!/navigator\.userAgent|navigator\.platform|navigator\.vendor|navigator\.appVersion/.test(touchSrc),
  "NO UA sniffing anywhere in the touch layer (feature-detect only)");
check(/__dfTouchSynthetic/.test(touchSrc) && /dispatchEvent/.test(touchSrc),
  "tap re-dispatches marked synthetic events through the existing #view handlers");
check(/stopImmediatePropagation/.test(touchSrc) && /capture: true/.test(touchSrc),
  "consumed gestures are stopped in the capture phase before desktop handlers see them");

// ---- DPR-aware backing store (coarse-only, desktop-identity) -----------------------------------
console.log("# dpr backing store (coarse-pointer only)");
const tiles = read("web/js/dwf-tiles.js");
const render = read("web/js/dwf-render.js");
for (const [name, src] of [["tiles", tiles], ["render", render]]) {
  const m = src.match(/function mobileBackingScale\(\) \{[\s\S]*?\n  [ ]*\}/);
  check(!!m, `${name}: has mobileBackingScale`);
  const fn = m ? m[0] : "";
  check(/matchMedia.*pointer: coarse/.test(fn), `${name}: scale is GATED on (pointer: coarse) -- desktop always 1`);
  check(/return 1/.test(fn) && /Math\.min\(2, window\.devicePixelRatio/.test(fn),
    `${name}: scale capped at 2 with fine-pointer identity`);
  check(/dwf\.mobiledpr/.test(fn), `${name}: kill switch honored`);
}
check(/canvas\.width = Math\.max\(1, Math\.round\(window\.innerWidth \* backingDpr\)\)/.test(tiles),
  "tiles: backing store scales by the gated dpr");
check(/\(canvas && canvas\.width\) \? canvas\.width \/ backingDpr : \(window\.innerWidth \|\| 0\)/.test(tiles),
  "tiles: desiredWinDims divides the scale back out (requested tile window identical to 1x)");
check(/const scale = canvas\.width \? \(rect\.width \/ canvas\.width\) : 1;/.test(tiles),
  "tiles: screenToGrid already normalizes CSS-vs-backing scale (hit-testing scale-transparent)");
// seeded-bad: if someone re-inlines an ungated dpr (the classic desktop-breaking mistake),
// resizeCanvas must not reference devicePixelRatio outside mobileBackingScale.
{
  const rc = tiles.match(/function resizeCanvas\(\) \{[\s\S]*?\n  \}/);
  check(!!rc && !/devicePixelRatio/.test(rc[0]),
    "(test-the-test) resizeCanvas never reads devicePixelRatio directly (only via the gate)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
