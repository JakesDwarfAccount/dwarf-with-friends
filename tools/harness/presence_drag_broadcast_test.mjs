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
//
// -drag1 REGRESSION TEST: remote live drag-rectangle presence for two-click designations.
//
// Owner repro (2026-07-16): dragging out a mining designation showed the yellow box locally,
// but a second browser watching that player saw only the labeled cursor + committed tiles --
// never the growing box. ROOT CAUSE: B193 (48acd83d) converted every rectangle designation to
// the native two-click gesture and, with the held-drag gesture, also removed its drag=1
// presence broadcast (the two-click rubber band got NO presence send at all). The server relay
// (presence_json) and both remote draw paths survived intact; the sender was the broken link.
//
// This test pins the whole chain sender -> wire fields -> server relay -> remote draw in BOTH
// renderers. Seeded-bad checks (verified during authoring): deleting sendTwoClickPresence's
// drag=1 send, dwf-tiles drawPresence's drag block, or dwf-gl emitPresence's drag loop each
// FAILS this test.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const controls = read("../../web/js/dwf-controls-placement.js");
const tiles = read("../../web/js/dwf-tiles.js");
const gl = read("../../web/js/dwf-gl.js");
const httpServer = read("../../src/http_server.cpp");
const placementCpp = read("../../src/placement.cpp");
const indexHtml = read("../../web/index.html");

let sections = 0;
function section(name, fn) { sections++; fn(); console.log("  ok - " + name); }

// ---------------------------------------------------------------------------------------
// (1) SENDER: sendTwoClickPresence broadcasts drag=1 + the armed anchor while a two-click
//     box is pending, and degrades to the plain drag=0 cursor when unarmed.
// ---------------------------------------------------------------------------------------
const sendUiSrc = controls.match(/  function sendPlacementUi\([\s\S]*?\n  \}/)?.[0];
const sendTcSrc = controls.match(/  function sendTwoClickPresence\([\s\S]*?\n  \}/)?.[0];
assert.ok(sendUiSrc, "sendPlacementUi exists");
assert.ok(sendTcSrc, "sendTwoClickPresence exists (the -drag1 sender fix)");

function senderBox({ armed, anchor, rendered }) {
  const box = {
    sent: [],
    performance: { now: () => box.clock },
    clock: 100000,
    fetch: (url) => { box.sent.push(String(url)); return { catch: () => {} }; },
    encodeURIComponent, Math, Number,
    player: "DragQA1",
    bipSelBuild: () => null,
    twoClickArmed: () => armed,
    stairRangeStart: anchor || null,
    renderedImageRect: () => rendered || null,
  };
  vm.createContext(box);
  vm.runInContext(
    "let lastUiSend = 0;\n" + sendUiSrc + "\n" + sendTcSrc +
    "\nthis.send = sendTwoClickPresence;", box);
  return box;
}
const q = (url) => Object.fromEntries(new URL("http://x/" + url.replace(/^\//, "")).searchParams);

section("armed anchor -> presence carries drag=1 with the anchor in window-grid coords", () => {
  const box = senderBox({
    armed: true,
    anchor: { x1: 50, y1: 60, x2: 50, y2: 60, z: 100 },
    rendered: { ox: 40, oy: 55, oz: 100 },
  });
  box.send({ x: 18, y: 12, w: 80, h: 50 });
  assert.equal(box.sent.length, 1, "exactly one /placement-cursor POST");
  const p = q(box.sent[0]);
  assert.match(box.sent[0], /^\/placement-cursor\?/);
  assert.equal(p.player, "DragQA1");
  assert.equal(p.drag, "1", "in-progress box broadcasts drag=1");
  assert.equal(p.hx, "18"); assert.equal(p.hy, "12");
  assert.equal(p.dx, "10", "anchor world x=50 - camera ox=40 = grid 10");
  assert.equal(p.dy, "5", "anchor world y=60 - camera oy=55 = grid 5");
});

section("anchor corner FARTHEST from the cursor is broadcast, so bbox spans the merged box", () => {
  const anchor = { x1: 50, y1: 60, x2: 52, y2: 63, z: 100 };
  const rendered = { ox: 40, oy: 55, oz: 100 };
  let box = senderBox({ armed: true, anchor, rendered });
  box.send({ x: 18, y: 12, w: 80, h: 50 });        // cursor world (58,67), right of the anchor
  let p = q(box.sent[0]);
  assert.equal(p.dx, "10", "cursor right of the footprint -> left corner x1=50 (grid 10)");
  assert.equal(p.dy, "5", "cursor below the footprint -> top corner y1=60 (grid 5)");
  box = senderBox({ armed: true, anchor, rendered });
  box.send({ x: 2, y: 1, w: 80, h: 50 });          // cursor world (42,56), left/above the anchor
  p = q(box.sent[0]);
  assert.equal(p.dx, "12", "cursor left of the footprint -> right corner x2=52 (grid 12)");
  assert.equal(p.dy, "8", "cursor above the footprint -> bottom corner y2=63 (grid 8)");
});

section("anchor off-window clamps to the window (server drops negative drag indices)", () => {
  const box = senderBox({
    armed: true,
    anchor: { x1: 10, y1: 20, x2: 10, y2: 20, z: 100 },  // world, left/above the camera window
    rendered: { ox: 40, oy: 55, oz: 100 },
  });
  box.send({ x: 5, y: 5, w: 80, h: 50 });
  const p = q(box.sent[0]);
  assert.equal(p.drag, "1");
  assert.equal(p.dx, "0", "10-40=-30 clamps to 0 -- presence_json requires drag_px >= 0");
  assert.equal(p.dy, "0", "20-55=-35 clamps to 0");
});

section("unarmed -> plain presence cursor (drag=0), exactly B193's behavior", () => {
  const box = senderBox({ armed: false });
  box.send({ x: 18, y: 12, w: 80, h: 50 });
  const p = q(box.sent[0]);
  assert.equal(p.drag, "0");
  assert.equal(p.dx, "0"); assert.equal(p.dy, "0");
});

section("throttle: a second armed send inside 55ms is coalesced; force bypasses", () => {
  const box = senderBox({
    armed: true,
    anchor: { x1: 50, y1: 60, x2: 50, y2: 60, z: 100 },
    rendered: { ox: 40, oy: 55, oz: 100 },
  });
  box.send({ x: 18, y: 12, w: 80, h: 50 });
  box.clock += 10;
  box.send({ x: 19, y: 12, w: 80, h: 50 });
  assert.equal(box.sent.length, 1, "10ms later: throttled (no remote flicker, ~18/s cadence)");
  box.send({ x: 19, y: 12, w: 80, h: 50 }, true);
  assert.equal(box.sent.length, 2, "force bypasses the throttle");
  box.clock += 60;
  box.send({ x: 20, y: 12, w: 80, h: 50 });
  assert.equal(box.sent.length, 3, "past 55ms: sent");
});

// Call sites: the three presence paths of the two-click gesture all route through the helper,
// and the Esc back-out force-clears the broadcast box.
section("call sites: rubber band + both twoClickEligible branches broadcast; Esc clears", () => {
  const rubber = controls.match(/  function updateTwoClickRubberBand\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(rubber, /sendTwoClickPresence\(imagePixelClamped\(clientX, clientY\)\)/,
    "the armed rubber band (button up -- the native gesture) mirrors the box to presence");
  const down = controls.match(/view\.addEventListener\("pointerdown", event => \{[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.match(down, /if \(twoClickEligible\(\)\) \{[\s\S]*?sendTwoClickPresence\(dragAnchor\);/,
    "pointerdown's rect-designation branch routes through the helper");
  const move = controls.match(/view\.addEventListener\("pointermove", event => \{[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.match(move, /if \(twoClickEligible\(\)\) \{[\s\S]*?sendTwoClickPresence\(cur\);/,
    "a held press on a rect designation keeps the remote box alive through the helper");
  assert.doesNotMatch(move.match(/if \(twoClickEligible\(\)\) \{[\s\S]*?\}/)?.[0] || "",
    /sendPlacementUi\([^)]*false, 0, 0\)/,
    "the old B193 drag=0 downgrade is gone from the held-press branch");
  const esc = controls.match(/\} else if \(twoClickArmed\(\)\) \{[\s\S]*?handledEscape = true;/)?.[0] || "";
  assert.match(esc, /sendPlacementUi\(-1, -1, 0, 0, false, 0, 0, true\)/,
    "Esc on an armed box force-clears the broadcast so no stale rect lingers remotely");
});

// ---------------------------------------------------------------------------------------
// (2) SERVER RELAY: /placement-cursor parses drag/dx/dy, and presence_json re-emits them in
//     world coords for every /mapdata + AUX frame (opaque to designation tool -- no server
//     change was needed for the fix; pin that contract so it stays true).
// ---------------------------------------------------------------------------------------
section("server: /placement-cursor parses drag/dx/dy and presence_json relays world coords", () => {
  assert.match(placementCpp, /query_int\(req, "drag", drag\);[\s\S]*?query_int\(req, "dx", drag_x\);[\s\S]*?query_int\(req, "dy", drag_y\);/,
    "placement.cpp reads the drag fields off the presence POST");
  assert.match(httpServer, /if \(cam->drag_active && cam->drag_px >= 0 && cam->drag_py >= 0\) \{\s*body << ",\\"drag\\":1"\s*<< ",\\"dx\\":" << \(cam->x \+ cam->drag_px\)\s*<< ",\\"dy\\":" << \(cam->y \+ cam->drag_py\);/,
    "presence_json converts the window-grid anchor to world coords for the players[] array");
});

// ---------------------------------------------------------------------------------------
// (3) REMOTE DRAW, canvas2d: dwf-tiles.js drawPresence paints another player's drag rect.
// ---------------------------------------------------------------------------------------
function tilesBox() {
  const playerColorSrc = tiles.match(/  function playerColor\(name\) \{[\s\S]*?\n  \}/)?.[0];
  const presenceLabelSrc = tiles.match(/  function presenceLabel\(name\) \{[\s\S]*?\n  \}/)?.[0];
  const drawSrc = tiles.match(/  function drawPresence\(data[\s\S]*?\n  \}/)?.[0];
  assert.ok(playerColorSrc && presenceLabelSrc && drawSrc, "tiles presence sources extracted");
  const calls = [];
  const rec = (op) => (...a) => calls.push([op, ...a]);
  const ctx = {
    save: rec("save"), restore: rec("restore"),
    fillRect: rec("fillRect"), strokeRect: rec("strokeRect"),
    beginPath: rec("beginPath"), moveTo: rec("moveTo"), lineTo: rec("lineTo"),
    closePath: rec("closePath"), fill: rec("fill"), fillText: rec("fillText"),
    measureText: () => ({ width: 30 }),
  };
  const box = { Math, String, Array, Number, window: {}, player: "DragQA2", ctx, calls };
  vm.createContext(box);
  vm.runInContext(playerColorSrc + "\n" + presenceLabelSrc + "\n" + drawSrc +
    "\nthis.draw = drawPresence;", box);
  return box;
}

section("canvas2d: a remote drag rect fills+strokes the bbox(cursor,anchor) in world tiles", () => {
  const box = tilesBox();
  // bob's cursor world (12,12), anchor (14,13); viewer window origin (10,10), cell 16.
  box.draw({ players: [{ name: "bob", x: 12, y: 12, z: 5, drag: 1, dx: 14, dy: 13 }] },
    10, 10, 5, 16, 40, 30);
  const fills = box.calls.filter(c => c[0] === "fillRect");
  const rectFill = fills.find(c => c[3] === 48 && c[4] === 32);
  assert.ok(rectFill, "the 3x2-tile drag rect gets one 48x32px fill (found: " +
    JSON.stringify(fills) + ")");
  assert.equal(rectFill[1], 32, "rect left = (min(12,14)-ox)*cell = 32px");
  assert.equal(rectFill[2], 32, "rect top = (min(12,13)-oy)*cell = 32px");
  const strokes = box.calls.filter(c => c[0] === "strokeRect");
  assert.ok(strokes.length >= 2, "rect border + cursor tile outline both stroke");
});

section("canvas2d: no drag fields -> cursor only; self and cursor-less entries draw nothing", () => {
  let box = tilesBox();
  box.draw({ players: [{ name: "bob", x: 12, y: 12, z: 5 }] }, 10, 10, 5, 16, 40, 30);
  assert.ok(!box.calls.some(c => c[0] === "fillRect" && c[4] > 16),
    "without drag/dx/dy no multi-tile rect is filled (label pill is 13px tall, rect is 32)");
  box = tilesBox();
  box.draw({ players: [{ name: "DragQA2", x: 12, y: 12, z: 5, drag: 1, dx: 14, dy: 13 }] },
    10, 10, 5, 16, 40, 30);
  assert.equal(box.calls.length, 0, "own name never draws (self-presence guard)");
});

// ---------------------------------------------------------------------------------------
// (4) REMOTE DRAW, GL: dwf-gl.js emitPresence emits per-tile fills for the drag rect.
// ---------------------------------------------------------------------------------------
function glBox() {
  const src = gl.match(/    function emitPresence\(players[\s\S]*?\n    \}/)?.[0];
  assert.ok(src, "gl emitPresence source extracted");
  const box = {
    Math, solids: [],
    PRESENCE_DRAG_MAX_TILES: 4096,
    playerColorRgb: () => [255, 0, 0],
    emitSolid: (gx, gy, rgb, a, z) => box.solids.push({ gx, gy, a }),
  };
  vm.createContext(box);
  vm.runInContext(src + "\nthis.emit = emitPresence;", box);
  return box;
}

section("gl: a remote drag rect emits one fill instance per covered tile + the cursor marker", () => {
  const box = glBox();
  box.emit([{ name: "bob", x: 2, y: 3, z: 0, drag: 1, dx: 4, dy: 4 }], 0, 0, 0, "DragQA2");
  const fillA = Math.round(0.16 * 255);
  const rect = box.solids.filter(s => s.a === fillA);
  assert.equal(rect.length, 6, "3x2 rect (2..4,3..4) fills 6 tiles at the same-z rect alpha");
  assert.deepEqual(rect.map(s => s.gx + "," + s.gy).sort(),
    ["2,3", "2,4", "3,3", "3,4", "4,3", "4,4"], "fills land on exactly the rect's tiles");
  assert.equal(box.solids.length, 7, "plus exactly one stronger cursor-tile marker");
});

section("gl: self skipped; no drag fields -> marker only", () => {
  let box = glBox();
  box.emit([{ name: "DragQA2", x: 2, y: 3, z: 0, drag: 1, dx: 4, dy: 4 }], 0, 0, 0, "DragQA2");
  assert.equal(box.solids.length, 0, "own presence never re-draws");
  box = glBox();
  box.emit([{ name: "bob", x: 2, y: 3, z: 0 }], 0, 0, 0, "DragQA2");
  assert.equal(box.solids.length, 1, "cursor marker only without drag fields");
});

// ---------------------------------------------------------------------------------------
// (4b) -drag2 REMOTE VISIBILITY: the always-on 2D cursor overlay paints the crisp rect over
//      the GL renderer, reading the AUX presence snapshot (lastAux.players) -- never the
//      25Hz fast-channel smoothCursors map, whose entries carry a drag BOOLEAN but no
//      dx/dy corners and cannot reconstruct the box.
// ---------------------------------------------------------------------------------------
const clientCpp = read("../../src/client_state.cpp");

function overlayBox({ glActive, players, selfName }) {
  const playerColorSrc = tiles.match(/  function playerColor\(name\) \{[\s\S]*?\n  \}/)?.[0];
  const drawSrc = tiles.match(/  function drawRemoteDragRects\(octx\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(drawSrc, "drawRemoteDragRects exists (the -drag2 overlay fix)");
  const calls = [];
  const rec = (op) => (...a) => calls.push([op, ...a]);
  const octx = { save: rec("save"), restore: rec("restore"),
    fillRect: rec("fillRect"), strokeRect: rec("strokeRect") };
  const box = {
    Math, String, Array, Number, calls, octx,
    player: selfName || "DragQA2",
    geom: { cell: 16, gw: 48, gh: 23, ox: 10, oy: 10, oz: 5 },
    cursorCanvas: { width: 768, height: 368 },
    lastAux: { players: players || [] },
    glOccludesCanvas2d: () => !!glActive,
  };
  vm.createContext(box);
  vm.runInContext(playerColorSrc + "\n" + drawSrc + "\nthis.draw = drawRemoteDragRects;", box);
  return box;
}

section("-drag2 overlay: over GL, an aux drag entry paints a stroked rect + light wash", () => {
  const box = overlayBox({ glActive: true,
    players: [{ name: "bob", x: 12, y: 12, z: 5, drag: 1, dx: 14, dy: 13 }] });
  box.draw(box.octx);
  const stroke = box.calls.find(c => c[0] === "strokeRect");
  assert.ok(stroke, "the overlay strokes the box (the visible border GL cannot emit)");
  assert.deepEqual(stroke.slice(1), [33, 33, 46, 30],
    "border at ((12-10)*16+1,(12-10)*16+1) sized (3*16-2)x(2*16-2)");
  const fill = box.calls.find(c => c[0] === "fillRect");
  assert.deepEqual(fill.slice(1), [32, 32, 48, 32], "light interior wash covers the box");
});

section("-drag2 overlay: a fast-channel-shaped entry (drag bool, NO dx/dy) draws nothing", () => {
  // This is the channel-merge regression guard: if anyone ever feeds the 25Hz smoothCursors
  // entries (drag boolean only) into this path -- or a merge drops the aux corners -- the
  // box must refuse to draw rather than paint garbage, and this test documents that the
  // overlay's source MUST stay the aux snapshot that carries the corners.
  const box = overlayBox({ glActive: true,
    players: [{ name: "bob", x: 12, y: 12, z: 5, drag: true }] });
  box.draw(box.octx);
  assert.equal(box.calls.length, 0, "no corners -> no rect (never a garbage box)");
});

section("-drag2 overlay: gated to GL-active (canvas2d's drawPresence owns the rect there); self skipped", () => {
  let box = overlayBox({ glActive: false,
    players: [{ name: "bob", x: 12, y: 12, z: 5, drag: 1, dx: 14, dy: 13 }] });
  box.draw(box.octx);
  assert.equal(box.calls.length, 0, "canvas2d visible -> overlay stays out (no double stroke)");
  box = overlayBox({ glActive: true, selfName: "bob",
    players: [{ name: "bob", x: 12, y: 12, z: 5, drag: 1, dx: 14, dy: 13 }] });
  box.draw(box.octx);
  assert.equal(box.calls.length, 0, "own box never re-draws");
});

section("-drag2 wiring: drawSmoothCursors composes the rects each RAF, from lastAux.players", () => {
  const smooth = tiles.match(/  function drawSmoothCursors\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(smooth, /drawRemoteDragRects\(octx\)/,
    "the 60fps overlay loop paints the remote boxes every frame");
  const drawSrc = tiles.match(/  function drawRemoteDragRects\(octx\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(drawSrc, /lastAux[\s\S]*?\.players/,
    "the overlay reads the AUX presence snapshot (has dx/dy corners)");
  assert.doesNotMatch(drawSrc, /smoothCursors/,
    "the overlay never reads the fast-channel map (drag boolean only, no corners)");
});

// ---------------------------------------------------------------------------------------
// (4c) CHANNEL ISOLATION (server): the 25Hz fast cursor channel must never shadow the
//      placement channel's drag corners. set_player_precise_cursor writes ONLY cur_*
//      fields; presence_json's drag/dx/dy read the placement-channel fields exclusively.
//      Live-probe evidence 2026-07-17: 58/58 /mapdata samples and 80/80 real v1 AUX
//      players sections kept drag+dx+dy while a 25Hz WS cursor stream interleaved with
//      18/s drag=1 placement posts.
// ---------------------------------------------------------------------------------------
section("server: set_player_precise_cursor cannot overwrite placement drag state", () => {
  const fn = clientCpp.match(/void set_player_precise_cursor\([\s\S]*?\n\}/)?.[0] || "";
  assert.ok(fn, "set_player_precise_cursor source extracted");
  assert.doesNotMatch(fn, /drag_px|drag_py|drag_active|hover_px|hover_py/,
    "the fast channel writes only cur_* fields -- placement drag corners survive interleave");
  assert.match(fn, /stored\.cur_drag = dragging \? 1 : 0;/,
    "fast-channel drag stays a separate cur_drag boolean (smooth-overlay only)");
});

// ---------------------------------------------------------------------------------------
// (5) Deploy hygiene: the sender fix ships behind a fresh cache buster.
// ---------------------------------------------------------------------------------------
section("the -drag1/-drag2 fixes are still shipped (source-pinned, buster-agnostic)", () => {
  // -drag1 must be PRESENT on the controls-placement buster, but need not be the LAST segment --
  // later fixes (e.g. -sprepaintctl1) legitimately accrete after it.
  assert.match(indexHtml, /dwf-controls-placement\.js\?v=[^"]*-drag1(?:-[^"]*)?"/,
    "the -drag1 buster is on the controls-placement script tag");
  // The tiles buster abandoned accrete-forever tokens in bf6ad3ec (reset to "8.4.2-automine"),
  // so a "-drag2" segment can no longer be required on the URL. Pin the FIX itself instead: the
  // remote drag-rect overlay draw must remain wired into the cursor-overlay pass.
  assert.match(tiles, /-drag2 \(owner regression follow-up 2026-07-17\)/,
    "the -drag2 remote drag-rect implementation block is still present in dwf-tiles.js");
  assert.match(tiles, /drawRemoteDragRects\(octx\)/,
    "the cursor-overlay pass still draws remote in-progress designation boxes");
});

// test-the-test: a payload the sender fix must never produce (drag=1 with no anchor coords)
// would fail the canvas2d assertions -- the guard is real, not vacuous.
section("test-the-test: drag without numeric dx/dy never draws a rect", () => {
  const box = tilesBox();
  box.draw({ players: [{ name: "bob", x: 12, y: 12, z: 5, drag: 1 }] }, 10, 10, 5, 16, 40, 30);
  assert.ok(!box.calls.some(c => c[0] === "fillRect" && c[4] > 16),
    "drawPresence requires numeric dx/dy before filling");
});

console.log("PASS presence_drag_broadcast (" + sections + " sections): two-click designation " +
  "boxes broadcast drag=1 presence and both renderers draw them for remote players");
