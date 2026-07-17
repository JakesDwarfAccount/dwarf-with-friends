// pause_anim_test.mjs -- B206 PAUSE-ANIM acceptance.
//
// Bug (live): "miasma animation does not stop when game is paused". TX18 put miasma on the
// client's shared 4Hz animation clock and WB-15 put fire/water/machine frames on the GL u_timeMs
// clock -- both tick on WALL time, ignoring the game's pause. Native DF freezes every game-WORLD
// animation on pause; UI feedback (status-icon blink, designation blink, cursor pulses) keeps
// running.
//
// The fix: dwf-animclock.js (window.DFAnimClock) tracks paused wall-time as a pure offset;
// both renderers subtract it from their WORLD clocks (miasma/flow frame cycle + machine frames)
// so those FREEZE while paused and RESUME with no jump, while UI clocks keep raw wall time.
//
// This test loads the REAL modules (no DOM/GL) and covers:
//   (1) DFAnimClock: offset math -- frozen while paused, seamless resume, idempotent, epoch-
//       agnostic; TEST-THE-TEST that a running clock DOES advance (freeze asserts aren't vacuous).
//   (2) canvas2d (tiles.js): worldAnimMs freezes the miasma frame cycle (resolveFlowFrameCell)
//       AND drawFlows' blitted frame while paused; resumes cleanly; machineFrameParity freezes;
//       the UI status-icon blink is NOT frozen (rides raw wall time).
//   (3) GL (gl.js): worldNow freezes animFrameIndexForTest (the shader's frame-select mirror) and
//       machineFrameParityGL while paused; resumes cleanly.
//   (4) WIRING guards (source-level, like wb15's shader-source checks): the renderers feed the
//       WORLD clock to flows/machines and the RAW clock to UI blink; pause.js + hud drive the
//       clock from SERVER pause state.
//
// Run: node tools/harness/pause_anim_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

let pass = 0;
function check(name, ok) {
  if (ok) { pass++; console.log("  ok  " + name); }
  else { console.error("FAIL  " + name); process.exitCode = 1; }
}

// =============================================================================================
// (1) DFAnimClock offset math, in an isolated sandbox (no window -> attaches to self/module).
// =============================================================================================
const clockBox = { self: null, module: { exports: {} } };
clockBox.self = clockBox;
vm.createContext(clockBox);
vm.runInContext(read("web", "js", "dwf-animclock.js"), clockBox, { filename: "dwf-animclock.js" });
const Clock = clockBox.self.DFAnimClock;
assert.ok(Clock && typeof Clock.setPaused === "function", "animclock must export setPaused/offset/now");

{
  Clock._reset();
  // Running from t=1000: the world clock == wall clock (offset 0).
  check("running clock: offset 0, world == wall", Clock.offset(1000) === 0 && Clock.now(1000) === 1000);

  // Pause at t=1300 (held world value = 1300). Wall keeps advancing; world must stay 1300.
  Clock.setPaused(true, 1300);
  const held = Clock.now(1300);
  check("pause holds the world clock at the pause instant", held === 1300);
  check("world clock FROZEN while paused (wall +200ms -> same value)", Clock.now(1500) === 1300);
  check("world clock still frozen much later (wall +2700ms -> same value)", Clock.now(4000) === 1300);
  check("offset grows at the wall rate during pause (so any wall-rate clock freezes)",
        Clock.offset(1500) === 200 && Clock.offset(4000) === 2700);

  // Epoch-agnostic: a Date.now()-epoch consumer (huge absolute value) also freezes.
  const dateEpoch = 1.7e12;
  Clock.setPaused(false, 4000);           // resume: fold the 2700ms paused span in once
  Clock.setPaused(true, dateEpoch);       // re-pause in a different epoch
  check("epoch-agnostic: a Date.now-epoch consumer also freezes",
        (dateEpoch + 500 - Clock.offset(dateEpoch + 500)) === (dateEpoch - Clock.offset(dateEpoch)));
  Clock.setPaused(false, dateEpoch);
}
{
  // Resume continuity: after a paused span, the world clock CONTINUES from the held value plus
  // only the RUNNING time since resume -- never a jump to where wall time drifted.
  Clock._reset();
  Clock.now(1000);                        // running, world=1000
  Clock.setPaused(true, 1000);            // hold at 1000
  check("resume setup: frozen at 1000 across a 2000ms pause", Clock.now(3000) === 1000);
  Clock.setPaused(false, 3000);           // resume at wall=3000
  check("resume: world continues from the HELD value (no jump)", Clock.now(3000) === 1000);
  check("resume: world advances by RUNNING time only (+200ms -> 1200, not wall 3200)",
        Clock.now(3200) === 1200);
  // TEST-THE-TEST: with no pause at all, the very same wall span DOES advance the clock -- proving
  // the frozen-equality asserts above are sensitive, not vacuously true.
  Clock._reset();
  check("TEST-THE-TEST: a never-paused clock advances 1000->3200 (freeze asserts are sensitive)",
        Clock.now(1000) === 1000 && Clock.now(3200) === 3200);
}
{
  // Idempotent: re-asserting the current state (the 1s hud poll) opens no spurious span.
  Clock._reset();
  Clock.setPaused(false, 500);            // already running -> no-op
  check("idempotent: redundant setPaused(false) is a no-op", Clock.offset(900) === 0);
  Clock.setPaused(true, 1000);
  Clock.setPaused(true, 1200);            // already paused -> must NOT re-anchor pauseStart to 1200
  check("idempotent: redundant setPaused(true) does not re-anchor the pause start",
        Clock.now(2000) === 1000);
  Clock._reset();
}

// =============================================================================================
// (2) canvas2d (tiles.js): miasma + machine freeze on the world clock; UI blink exempt.
// =============================================================================================
// Minimal browser harness (same shape as flows_miasma_test.mjs) in the MAIN context, so
// window.DFAnimClock (attached by animclock.js) and DwfTiles share one global.
const drawcalls = [];
class RecordingCtx {
  constructor() { this.globalAlpha = 1; }
  createRadialGradient() { const g = { stops: [], addColorStop() {} }; return g; }
  drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) { drawcalls.push({ img, sx, sy, dx, dy }); }
  fillRect() {} clearRect() {} save() {} restore() {} beginPath() {} arc() {} fill() {} stroke() {}
  strokeRect() {} measureText() { return { width: 8 }; } fillText() {} setLineDash() {}
  createLinearGradient() { return { addColorStop() {} }; } getImageData() { return { data: [] }; }
  translate() {} scale() {} clip() {} rect() {} moveTo() {} lineTo() {} closePath() {}
}
class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; this._ctx = new RecordingCtx(); }
  addEventListener() {} removeEventListener() {}
  getContext() { return this._ctx; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
}
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; },
  createElement() { return { style: {}, getContext: () => new RecordingCtx() }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
globalThis.Image = class { set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });

// Load the pause clock FIRST (attaches window.DFAnimClock = globalThis.DFAnimClock), then tiles.js.
vm.runInThisContext(read("web", "js", "dwf-animclock.js"), { filename: "dwf-animclock.js" });
assert.ok(globalThis.DFAnimClock, "animclock must attach window.DFAnimClock in the browser harness");
vm.runInThisContext(read("web", "js", "dwf-tiles.js"), { filename: "dwf-tiles.js" });
const Tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });
const AC = globalThis.DFAnimClock;

// Wire the native miasma sheet (4 frames) so resolveFlowFrameCell / drawFlows take the sprite path.
const FRAMES = [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }];
Tiles._setSpriteMapForTest({ FLOW_MIASMA: { sheet: "event_flows.png", col: 0, row: 0, frames: FRAMES } });
const fakeImg = { _tag: "event_flows" };
Tiles._setSheetForTest("event_flows.png", { img: fakeImg, loaded: true, failed: false, failedAt: 0 });

{
  AC._reset();
  const wm = Tiles._worldAnimMsForTest;
  // Running until t=1300 -> pause. Held world = 1300 -> miasma frame floor(1300/250)%4 = 5%4 = 1.
  wm(1300);
  AC.setPaused(true, 1300);
  const heldWorld = wm(1300);
  check("tiles: worldAnimMs frozen while paused (wall 1300->3000 same)", wm(1300) === wm(3000) && wm(3000) === heldWorld);

  const heldFrame = Tiles._resolveFlowFrameCellForTest("FLOW_MIASMA", wm(1300));
  let allHeld = true;
  for (const wall of [1550, 2000, 2750, 3999]) {
    const f = Tiles._resolveFlowFrameCellForTest("FLOW_MIASMA", wm(wall));
    if (!f || f.col !== heldFrame.col) { allHeld = false; break; }
  }
  check("tiles: miasma frame HELD across the whole paused span (world clock frozen)", allHeld);

  // TEST-THE-TEST: the SAME wall times fed RAW (no offset) hit a DIFFERENT frame -- so the freeze
  // is doing real work, not passing because the frame is coincidentally constant.
  let rawDiffers = false;
  for (const wall of [1550, 2000, 2750, 3999]) {
    const f = Tiles._resolveFlowFrameCellForTest("FLOW_MIASMA", wall);   // raw wall, not wm()
    if (f && f.col !== heldFrame.col) { rawDiffers = true; break; }
  }
  check("tiles TEST-THE-TEST: raw wall time WOULD advance the frame (freeze is not vacuous)", rawDiffers);

  // drawFlows: the blit samples the HELD frame while paused.
  drawcalls.length = 0;
  const gw = 4, cell = 16;
  const tile = () => ({ tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false });
  const tiles = [tile(), { ...tile(), cloud: { type: 0, density: 13 } }, tile(), tile()];
  Tiles._drawFlowsForTest(tiles, tiles.length, gw, cell, wm(3000));   // paused: world still 1300
  check("tiles: drawFlows blits the HELD miasma frame while paused",
        drawcalls.length === 1 && drawcalls[0].sx === heldFrame.col * 32);

  // Machine frames freeze on the same clock.
  const heldParity = Tiles._machineFrameParityForTest(wm(1300));
  check("tiles: machineFrameParity frozen while paused",
        Tiles._machineFrameParityForTest(wm(2100)) === heldParity &&
        Tiles._machineFrameParityForTest(wm(3300)) === heldParity);

  // UI status-icon blink is NOT frozen: it rides RAW wall time and keeps toggling under pause.
  const blinkA = Tiles._unitStatusBlinkVisibleForTest(1300);
  const blinkB = Tiles._unitStatusBlinkVisibleForTest(1300 + 800);   // one full 800ms blink beat later
  check("tiles: UI status-icon blink is EXEMPT (raw wall clock toggles under pause)", blinkA !== blinkB);

  // Resume: the frame continues from the held value forward by running time only (no jump).
  AC.setPaused(false, 3000);
  check("tiles: worldAnimMs resumes from the held value (no jump)", wm(3000) === heldWorld);
  check("tiles: worldAnimMs advances by running time after resume (+250ms -> next frame)",
        Tiles._resolveFlowFrameCellForTest("FLOW_MIASMA", wm(3250)).col === ((heldFrame.col + 1) % 4) * 1);
  AC._reset();
  Tiles._setSpriteMapForTest(null);
}

// =============================================================================================
// (3) GL (gl.js): world clock freezes the shader frame-select mirror + machine parity.
// =============================================================================================
const glbox = { self: null, window: null, performance: { now: () => 0 }, Date, console };
glbox.self = glbox; glbox.window = glbox;
vm.createContext(glbox);
vm.runInContext(read("web", "js", "dwf-animclock.js"), glbox, { filename: "dwf-animclock.js" });
for (const f of ["dwf-adjacency.js", "dwf-gl.js"])
  vm.runInContext(read("web", "js", f), glbox, { filename: f });
const GL = glbox.window.DwfGL;
const GAC = glbox.window.DFAnimClock;
assert.ok(GL && typeof GL._worldNowForTest === "function", "gl.js must export _worldNowForTest");
assert.ok(GAC, "animclock must attach to the gl sandbox window");

{
  GAC._reset();
  const wn = GL._worldNowForTest;
  wn(1300);
  GAC.setPaused(true, 1300);
  const held = wn(1300);
  check("gl: worldNow frozen while paused", wn(1900) === held && wn(3500) === held);

  const attr = GL.encodeAnimAttr(4, GL.defaultAnimRateCodeForToken("FLOW_MIASMA")); // 4-frame flow
  const heldIdx = GL.animFrameIndexForTest(wn(1300), attr, 0, 0, true);
  let idxHeld = true;
  for (const wall of [1600, 2200, 3100, 3499]) {
    if (GL.animFrameIndexForTest(wn(wall), attr, 0, 0, true) !== heldIdx) { idxHeld = false; break; }
  }
  check("gl: shader frame-select index HELD across the paused span", idxHeld);

  // TEST-THE-TEST: raw wall time WOULD move the index within the same span.
  let rawMoves = false;
  for (const wall of [1600, 2200, 3100, 3499]) {
    if (GL.animFrameIndexForTest(wall, attr, 0, 0, true) !== heldIdx) { rawMoves = true; break; }
  }
  check("gl TEST-THE-TEST: raw wall time advances the index (freeze is not vacuous)", rawMoves);

  // Machine parity (Date.now epoch inside the renderer) also freezes on the same offset.
  const heldPar = GL.machineFrameParityGL(wn(1300), false);
  check("gl: machineFrameParityGL frozen while paused",
        GL.machineFrameParityGL(wn(2600), false) === heldPar &&
        GL.machineFrameParityGL(wn(3400), false) === heldPar);

  // Resume continuity.
  GAC.setPaused(false, 3500);
  check("gl: worldNow resumes from held value (no jump)", wn(3500) === held);
  check("gl: worldNow advances by running time after resume", wn(3750) === held + 250);
  GAC._reset();
}

// =============================================================================================
// (4) WIRING guards (source-level): world clock -> flows/machines; raw clock -> UI blink;
//     server pause state -> the clock.
// =============================================================================================
{
  const tilesSrc = read("web", "js", "dwf-tiles.js");
  check("wiring: tiles drawFlows is fed the WORLD clock (worldMs), not raw nowMs",
        /drawFlows\(tiles, n, gw, cell, worldMs\)/.test(tilesSrc));
  check("wiring: tiles machineFrameParity is fed the WORLD clock",
        /machineFrameParity\(worldMs\)/.test(tilesSrc));
  check("wiring: tiles UI status-icon blink phase still rides RAW wall nowMs (not worldMs)",
        /Math\.floor\(nowMs \/ UNIT_STATUS_BLINK_MS\)/.test(tilesSrc));
  check("wiring: tiles machine cadence loop uses the world clock",
        /machineCadenceStep\(latest\.buildings, worldAnimMs\(nowMs\)/.test(tilesSrc));

  const glSrc = read("web", "js", "dwf-gl.js");
  check("wiring: gl u_timeMs subtracts the paused offset (worldNow)",
        /u_timeMs, freezeAnim \? 0 : worldNow\(/.test(glSrc));
  check("wiring: gl machine frames ride machineNow() (world clock)",
        /machineCadenceStepGL\([^\n]*machineMs/.test(glSrc) && /var machineMs = machineNow\(\);/.test(glSrc));
  check("wiring: gl designation blink STILL uses the raw ts/now() clock (UI, not frozen)",
        /var designationNowMs = \(typeof ts === "number" && isFinite\(ts\)\) \? ts : now\(\);/.test(glSrc));

  const pauseSrc = read("web", "js", "dwf-pause.js");
  check("wiring: WP-B pause broadcast (server-global) drives the clock",
        /DFAnimClock\.setPaused\(!!msg\.paused\)/.test(pauseSrc));

  const hudSrc = read("web", "js", "dwf-unit-hud-notifications.js");
  check("wiring: hud.paused (server /hud poll) drives the clock as the old-DLL fallback",
        /DFAnimClock && !window\.__dfPauseByBroadcast\) window\.DFAnimClock\.setPaused\(isPaused\)/.test(hudSrc));

  const indexSrc = read("web", "index.html");
  const clockTag = indexSrc.search(/<script src="\/js\/dwf-animclock\.js/);
  const tilesTag = indexSrc.search(/<script src="\/js\/dwf-tiles\.js/);
  const glTag = indexSrc.search(/<script src="\/js\/dwf-gl\.js/);
  check("wiring: index.html loads the clock BEFORE both renderers",
        clockTag >= 0 && clockTag < tilesTag && clockTag < glTag);
}

console.log(`\npause_anim_test: ${pass} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
