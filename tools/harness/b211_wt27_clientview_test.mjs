// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// b211_wt27_clientview_test.mjs -- client view/camera UX.
//   B211 (2026-07-14, scope REVERSED by the owner): the far / "world-map" overview zoom stage and its
//         resistance band are DELETED. Zoom is ONE regime: a plain 1.2x wheel/[ ] step clamped
//         to [12, 64] px/tile. This pins the single-regime curve and guards against a second
//         stage (friction, hysteresis, LOD ladder) coming back.
//   WT27: LoL/Dota-style location-ping splash -- spawns, animates (ease-out, fade), reaps
//         cleanly, uses the pinging player's cursor color, and is triggered by a live
//         location-token chat message (dwf-chat.js emitPingSplashes).
// Pure/seam-driven: no canvas, no RAF, no transport. Run: node tools/harness/b211_wt27_clientview_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const source = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok - " + name); }
  catch (err) { failed++; console.error("  FAIL - " + name + ": " + err.message); }
}

// ---- boot the real modules in a shared globalThis (mirrors overview_zoom_test) ---------------
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.__DWF_STORY_MODE = true;   // skip chat.js DOM auto-boot
globalThis.location = { search: "", protocol: "http:", host: "localhost" };
globalThis.document = { hidden: false, readyState: "complete", addEventListener() {},
  getElementById() { return null; }, createElement() { return { style: {} }; },
  body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.Image = class { set src(_v) {} };
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => null });
globalThis.requestAnimationFrame = () => 0;   // non-null id -> startCursorOverlay arms once, never ticks

vm.runInThisContext(source("web/js/dwf-tiles.js"), { filename: "dwf-tiles.js" });
vm.runInThisContext(source("web/js/dwf-chat.js"), { filename: "dwf-chat.js" });

const T = globalThis.DwfTiles;
const C = globalThis.DwfChat;
assert.ok(T && C, "tiles + chat modules load");
const K = T._zoomConstantsForTest();
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// =============================================================================================
console.log("# B211 -- single-regime zoom curve (one clean motion, one cap)");

check("constants: cap=12, max=64, default=24, one step factor=1.2", () => {
  assert.equal(K.min, 12);      // the old normal-regime floor (overview's former ENTER_PX): the
                                // smallest px/tile that still renders real sprites per tile
  assert.equal(K.max, 64);
  assert.equal(K.def, 24);
  assert.equal(K.factor, 1.2);
  assert.equal(K.threshold, undefined, "no normal<->far boundary exists any more");
  assert.equal(K.resist, undefined, "no resistance factor exists any more");
  assert.equal(K.resistLo, undefined, "no resistance band exists any more");
});

check("every tick in range uses the SAME 1.2 step -- no second regime, no friction", () => {
  for (const px of [64, 48, 32, 24, 20, 16, 14.4, 13]) {
    const out = T._zoomStepPxForTest(px, "out");
    assert.ok(near(out, Math.max(12, px / 1.2)), px + " out steps by exactly 1.2 (got " + out + ")");
  }
  for (const px of [12, 13, 16, 24, 40, 50]) {
    const inn = T._zoomStepPxForTest(px, "in");
    assert.ok(near(inn, Math.min(64, px * 1.2)), px + " in steps by exactly 1.2 (got " + inn + ")");
  }
});

check("zooming out from the default reaches the cap in a handful of even ticks", () => {
  let px = 24, ticks = 0;
  const seen = [];
  while (px > 12 && ticks < 50) { px = T._zoomStepPxForTest(px, "out"); seen.push(px); ticks++; }
  assert.equal(px, 12, "settles exactly on the cap");
  assert.ok(ticks <= 5, "24 -> 12 is <=5 ticks (no friction band to grind through), got " + ticks);
});

check("cap: no amount of zooming out passes 12, and it settles exactly at 12", () => {
  let px = 64;
  for (let i = 0; i < 200; i++) px = T._zoomStepPxForTest(px, "out");
  assert.equal(px, 12, "clamps to the zoom-out cap");
  assert.equal(T._zoomStepPxForTest(12.5, "out"), 12, "a step that would overshoot the cap lands on it");
  assert.equal(T._zoomStepPxForTest(12, "out"), 12, "already at the cap stays put");
  assert.ok(T._zoomStepPxForTest(12, "in") > 12, "zooming IN from the cap is allowed");
});

check("max: cannot zoom in past 64", () => {
  let px = 12;
  for (let i = 0; i < 200; i++) px = T._zoomStepPxForTest(px, "in");
  assert.equal(px, 64);
  assert.equal(T._zoomStepPxForTest(64, "in"), 64);
});

check("the far/world-map stage is GONE: no overview policy, no overview seams", () => {
  assert.equal(globalThis.DwfOverview, undefined, "dwf-overview.js no longer exists");
  assert.equal(typeof T._overviewStateForTest, "undefined", "no overview state seam");
  assert.equal(typeof T._paintOverviewForTest, "undefined", "no canvas2d overview painter");
  const tilesSource = source("web/js/dwf-tiles.js");
  assert.ok(!/overviewMode|ZOOM_RESIST|ZOOM_THRESHOLD/.test(tilesSource),
    "no overview mode / resistance constants remain in dwf-tiles.js");
  assert.ok(!/overviewDraw|overviewStride/.test(source("web/js/dwf-gl.js")),
    "no overview slab/LOD branch remains in the GL renderer");
  assert.ok(!/latest\.overview/.test(source("web/js/dwf-render.js")),
    "no overview branch remains in the renderer controller");
  assert.equal(T.getStats().overview, undefined, "getStats no longer reports an overview mode");
});

check("the whole zoom range asks the server for a window inside the 200-tile clamp", () => {
  // The far stage used to FREEZE the interest window at ENTER_PX and render the rest from cache.
  // With it gone, every zoom level requests a real window -- so the cap must keep that window
  // inside dimsAtTilePx()'s 200-tile clamp or the client would be asking for tiles it cannot get.
  // 1200x800 canvas (set above) at the 12px cap = 100x67 tiles. Comfortably inside 200.
  const d = T._windowDimsForTest();
  assert.ok(d.w <= 200 && d.h <= 200, "window dims stay within the clamp: " + JSON.stringify(d));
});

// =============================================================================================
console.log("# WT27 -- ping splash lifecycle (spawn / animate / reap / color)");

// A recording 2D context: captures every arc's alpha + stroke color so we can assert the
// splash animates (rings), fades over time, and paints in the player's cursor color.
function recordingCtx() {
  const ctx = {
    globalAlpha: 1, strokeStyle: "", fillStyle: "", lineWidth: 1,
    arcs: [], save() {}, restore() {}, beginPath() {},
    arc(x, y, r) { this.arcs.push({ x, y, r, alpha: this.globalAlpha, stroke: this.strokeStyle, fill: this.fillStyle }); },
    stroke() {}, fill() {},
  };
  return ctx;
}
// Place a deterministic geom so world tiles map to on-screen pixels.
T._setGeomForTest({ cell: 20, gw: 40, gh: 30, ox: 100, oy: 100, oz: 5 });

check("spawn: valid ping enters the queue, invalid coords are rejected", () => {
  while (T._pingSplashCountForTest() > 0) T._drawPingSplashesForTest(recordingCtx(), Date.now() + 1e9); // drain
  assert.equal(T._pingSplashCountForTest(), 0);
  assert.equal(T._pingSplashForTest(110, 108, 5, "guest"), true);
  assert.equal(T._pingSplashCountForTest(), 1);
  assert.equal(T._pingSplashForTest(NaN, 5, 5, "x"), false, "NaN coord rejected");
  assert.equal(T._pingSplashCountForTest(), 1, "queue unchanged by the rejected ping");
});

check("animate: rings paint in the player's cursor color and fade as the splash ages", () => {
  const base = Date.now();
  T._pingSplashForTest(110, 108, 5, "guest");
  const wantColor = T.playerColor("guest").fill;
  const early = recordingCtx(); T._drawPingSplashesForTest(early, base + 60);
  const late = recordingCtx();  T._drawPingSplashesForTest(late, base + 700);
  assert.ok(early.arcs.length >= 1, "early frame draws at least one ring/dot");
  assert.ok(early.arcs.some((a) => a.stroke === wantColor || a.fill === wantColor),
    "splash is painted in the pinging player's cursor color");
  const maxA = (c) => c.arcs.reduce((m, a) => Math.max(m, a.alpha), 0);
  assert.ok(maxA(late) < maxA(early), "opacity decreases over the splash's life (ease-out fade)");
});

check("reap: an expired splash is removed and paints nothing", () => {
  while (T._pingSplashCountForTest() > 0) T._drawPingSplashesForTest(recordingCtx(), Date.now() + 1e9);
  const base = Date.now();
  T._pingSplashForTest(110, 108, 5, "urist");
  assert.equal(T._pingSplashCountForTest(), 1);
  const dead = recordingCtx();
  const drawn = T._drawPingSplashesForTest(dead, base + 5000);   // well past PING_DURATION_MS
  assert.equal(drawn, 0, "nothing painted for the expired splash");
  assert.equal(T._pingSplashCountForTest(), 0, "expired splash reaped from the queue -> no leak");
});

check("z-fade: a ping many z-levels away is culled but NOT reaped early", () => {
  while (T._pingSplashCountForTest() > 0) T._drawPingSplashesForTest(recordingCtx(), Date.now() + 1e9);
  const base = Date.now();
  T._pingSplashForTest(110, 108, 60, "faraway");   // geom.oz=5 -> dz=55 >> CURSOR_ZFADE_N
  const ctx = recordingCtx();
  const drawn = T._drawPingSplashesForTest(ctx, base + 60);
  assert.equal(drawn, 0, "off-z ping draws nothing");
  assert.equal(T._pingSplashCountForTest(), 1, "but it stays queued (still within its lifetime)");
  while (T._pingSplashCountForTest() > 0) T._drawPingSplashesForTest(recordingCtx(), Date.now() + 1e9);
});

// =============================================================================================
console.log("# WT27 -- chat is the ping channel (location token -> splash)");

check("emitPingSplashes routes each live location token to DwfTiles.pingSplash", () => {
  const calls = [];
  const realTiles = globalThis.DwfTiles;
  globalThis.DwfTiles = { pingSplash: (x, y, z, name) => { calls.push([x, y, z, name]); return true; } };
  try {
    C._emitPingSplashesForTest({ seq: 1, from: "guest", text: "over here [[loc:10,20,5]]" });
    assert.deepEqual(calls, [[10, 20, 5, "guest"]], "one location -> one splash at that tile, author's color");
    calls.length = 0;
    C._emitPingSplashesForTest({ seq: 2, from: "ada", text: "two spots [[loc:1,2,3]] and [[loc:4,5,6]]" });
    assert.deepEqual(calls, [[1, 2, 3, "ada"], [4, 5, 6, "ada"]], "multiple tokens -> multiple splashes");
    calls.length = 0;
    C._emitPingSplashesForTest({ seq: 3, system: true, text: "[[loc:9,9,9]]" });
    C._emitPingSplashesForTest({ seq: 4, from: "ada", text: "just chatting, no ping" });
    assert.equal(calls.length, 0, "system lines and plain messages never splash");
  } finally {
    globalThis.DwfTiles = realTiles;
  }
});

// B223: the splash must land on the PICKED TARGET. Before B223 the ping button stamped the CAMERA
// CENTRE into the composer, so the splash -- when the player remembered to press Send -- landed
// wherever the camera happened to be. Now the ping flow auto-sends a token for the tile (or unit)
// the player actually CLICKED, and both token kinds splash there.
check("B223: a picked-target ping splashes at the target -- tile token at the tile, unit token at " +
      "the unit's CURRENT tile", () => {
  const calls = [];
  const realTiles = globalThis.DwfTiles;
  const roster = [{ id: 42, name: "Urist McMiner", x: 77, y: 88, z: 4 }];
  globalThis.DwfTiles = {
    pingSplash: (x, y, z, name) => { calls.push([x, y, z, name]); return true; },
    getLatest: () => ({ units: roster }),
  };
  try {
    // The tile the player clicked -- NOT the camera. (chat auto-sends exactly this bare token.)
    C._emitPingSplashesForTest({ seq: 10, from: "guest", text: "[[loc:111,222,-3]]" });
    assert.deepEqual(calls, [[111, 222, -3, "guest"]], "a tile ping splashes at the clicked tile");

    // A unit token carries NO coordinates (that is what lets the link follow a walking dwarf), so
    // the splash resolves the id against the live roster -- the same resolution the link click uses.
    calls.length = 0;
    C._emitPingSplashesForTest({ seq: 11, from: "ada", text: "[[unit:42|Urist McMiner]]" });
    assert.deepEqual(calls, [[77, 88, 4, "ada"]], "a unit ping splashes at the unit's CURRENT tile");

    // THE MENTION GATE. A plain @mention expands to the same [[unit:]] token at send time. Splashing
    // those would fire the map effect on ordinary conversation. Only a BARE token is a ping.
    calls.length = 0;
    C._emitPingSplashesForTest({ seq: 12, from: "ada", text: "[[unit:42|Urist McMiner]] is hurt" });
    assert.equal(calls.length, 0, "a unit MENTION inside a sentence is not a ping and does not splash");

    // A unit that has walked out of the streamed AUX window resolves to nothing -> no splash, no
    // throw, and the chat line still renders (fail-closed, never an invented tile).
    calls.length = 0;
    C._emitPingSplashesForTest({ seq: 13, from: "ada", text: "[[unit:999|Ghost]]" });
    assert.equal(calls.length, 0, "an off-window unit ping fails closed instead of splashing at 0,0,0");

    // TEST-THE-TEST: the roster lookup is real -- move the dwarf, the splash moves with it.
    calls.length = 0;
    roster[0].x = 5; roster[0].y = 6; roster[0].z = 7;
    C._emitPingSplashesForTest({ seq: 14, from: "ada", text: "[[unit:42|Urist McMiner]]" });
    assert.deepEqual(calls, [[5, 6, 7, "ada"]],
      "(test-the-test) the unit splash tracks the LIVE roster position, not the token's label/author-time tile");
  } finally {
    globalThis.DwfTiles = realTiles;
  }
});

console.log(failed
  ? "FAIL B211/WT27 client view (" + failed + " failures)"
  : "PASS B211 single-regime zoom curve (one step, one cap, no world-map stage) + " +
    "WT27 ping splash (spawn/animate/reap/color/channel)");
process.exit(failed ? 1 : 0);
