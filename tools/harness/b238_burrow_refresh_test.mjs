// b238_burrow_refresh_test.mjs -- B238 acceptance (burrow overlay: missing tiles, live refresh).
//
// THE BUG the owner REPORTED: "the burrows are invisible when painted in the browser but they do show up
// in the steam client. The first time I painted it in browser, HALF of it showed up. The second time
// I designated one in browser it didn't show up at all."
//
// THAT IS NOT A STALE OVERLAY. The client ALREADY refetches /burrows 120ms after a paint stroke
// (scheduleBurrowRefresh, B230) -- the tiles it drew were the tiles the server SENT. The server was
// sending fewer than it should:
//
//   build_burrows_json clipped each burrow's `rects` to `effective_capture_viewport_dims` -- DF's
//   OWN native viewport (gps->main_viewport, scaled by the player's zoom) -- anchored at the
//   camera's top-left. The browser's rendered window is a COMPLETELY different rectangle: it is
//   derived from the canvas size / cell size (its tile dims are what the client sends to /mapdata
//   and /zones as &w=&h=), and when the browser is zoomed out it is WIDER and TALLER than DF's
//   native viewport. Every burrow tile past the native viewport's width/height was therefore
//   dropped from the payload, while the tiles nearer the camera origin survived:
//
//       paint near the top-left of your view  -> the burrow shows
//       paint across your view                -> HALF of it shows      <- the first burrow
//       paint further right/down              -> NONE of it shows      <- the second burrow
//
//   The native Steam client renders the real burrow, so it showed both in full. The write was
//   always correct. This is the same bug class /designate, /placement-cursor, /stockpile-repaint,
//   /hauling and /burrow-PAINT itself were each already fixed for ("was clamping/rescaling against
//   effective_capture_viewport_dims instead of the client's real frame_w/frame_h") -- /burrows was
//   the one that never got the fix, and it is the only one that had no user-visible symptom until
//   B230 finally drew the rects it returns.
//
// THE FIX (root, not a shorter polling window): /burrows stops clipping to a window at all. It emits
// the burrow's tiles on the camera's z in WORLD coordinates and lets the client cull them to
// whatever window it is actually rendering (the overlay planner already does exactly that, and is
// already tested for it in b230). A rect the client cannot see costs a handful of bytes; a rect the
// server never sent is an invisible burrow.
//
// AND THE MULTIPLAYER HALF: burrow state had NO change-broadcast. Another player's paint could not
// appear on your screen -- /burrows was fetched on panel-open and on YOUR OWN mutations, nothing
// else. Burrows now carry a revision that every mutating route bumps, broadcast as
// {"type":"burrows","seq":N} on the vote/popup sticky change-only pattern, which the client turns
// into a refetch while burrow mode is open.
//
// Run: node tools/harness/b238_burrow_refresh_test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const CPP = read("src/burrows_panel.cpp");
const HDR = read("src/burrows_panel.h");
const HTTP = read("src/http_server.cpp");
const WS = read("web/js/dwf-ws.js");
const PLACEMENT = read("web/js/dwf-controls-placement.js");

// ---------------------------------------------------------------------------------------------
// 1. THE ROOT CAUSE: /burrows must not clip its rects to DF's native viewport.
// ---------------------------------------------------------------------------------------------
check("C++: the burrow rect builder takes NO view window (the clip was the bug)", () => {
  const fn = /std::vector<BurrowRect> burrow_[a-z_0-9]*rects[a-z_0-9]*\(([^)]*)\)/.exec(CPP);
  assert.ok(fn, "the per-burrow rect builder must exist");
  assert.doesNotMatch(fn[1], /view_w|view_h/,
    "rects must not be built against a server-chosen window -- that window is not the client's");
});

check("C++: build_burrows_json never consults effective_capture_viewport_dims", () => {
  const body = /ApiResult<std::string> build_burrows_json\([\s\S]*?\n\}\n/.exec(CPP);
  assert.ok(body, "build_burrows_json must exist");
  assert.doesNotMatch(body[0], /effective_capture_viewport_dims/,
    "DF's native viewport is NOT the browser's window: clipping to it drops the tiles the player " +
    "painted on the outer part of their view (the half-a-burrow / no-burrow)");
});

check("C++: the rects are world-space and the payload says so (+ the z they are for)", () => {
  assert.match(CPP, /\\"worldRects\\":true/,
    "the client must be able to tell a world-rect payload from an old DLL's window-clipped one");
  assert.match(CPP, /\\"z\\":/,
    "rects are per-z; the payload must stamp the z it was built for so the client can gate on it");
});

check("C++: same-row runs are merged across block boundaries (payload size, unclipped)", () => {
  assert.match(CPP, /merge_row_runs|merge adjacent runs/i,
    "unclipped runs are emitted per 16-wide block row; without a merge a wide burrow ships " +
    "one rect per block instead of one per row");
});

// ---------------------------------------------------------------------------------------------
// 2. THE MULTIPLAYER HALF: a burrow revision + a change-only broadcast.
// ---------------------------------------------------------------------------------------------
check("C++: every mutating burrow route bumps the revision", () => {
  assert.match(CPP, /bump_burrow_seq\(\)/, "the revision bump must exist");
  // Each write path: create / rename / unit / action / symbol / delete / paint.
  for (const fn of ["create_burrow", "rename_burrow", "set_burrow_member", "apply_burrow_action",
                    "set_burrow_symbol", "delete_burrow", "paint_burrow"]) {
    const body = new RegExp(`ApiResult<[^>]+> ${fn}\\([\\s\\S]*?\\n\\}`).exec(CPP);
    assert.ok(body, `${fn} must exist`);
    assert.match(body[0], /bump_burrow_seq\(\)/,
      `${fn} changes burrow state -- without a bump, other players never learn it changed`);
  }
});

check("C++: burrow_push_tick broadcasts change-only, with sticky late-join sync", () => {
  assert.match(HDR, /void burrow_push_tick\(\);/, "the tick must be declared for the push loop");
  const body = /void burrow_push_tick\(\)[\s\S]*?\n\}\n/.exec(CPP);
  assert.ok(body, "burrow_push_tick must exist");
  assert.match(body[0], /\\"type\\":\\"burrows\\"/, "the broadcast frame must be typed");
  assert.match(body[0], /broadcast_to_player/, "it must actually reach the other players");
  assert.match(body[0], /g_burrow_synced/,
    "late-join sync (vote/popup pattern): a player who reconnects must be told the current seq");
  assert.doesNotMatch(body[0], /CoreSuspender/,
    "the tick is a plugin-memory counter compare -- it must never take a suspender (AGENTS.md rule 5)");
});

check("C++: the push loop actually calls it", () => {
  assert.match(HTTP, /burrow_push_tick\(\);/,
    "a tick nobody calls is a tick that never broadcasts");
});

// ---------------------------------------------------------------------------------------------
// 3. THE CLIENT: consume the broadcast, and refetch when the window/z it was built for changes.
// ---------------------------------------------------------------------------------------------
check("client: dwf-ws.js routes {\"type\":\"burrows\"} to the burrow module", () => {
  assert.match(WS, /msg\.type === "burrows"/, "the frame must be dispatched");
  assert.match(WS, /DFBurrowSync[\s\S]{0,60}onBurrows\(msg\)/,
    "routed to the burrow panel's sync hook (inert if the module isn't loaded)");
});

check("client: a remote burrow change refetches while burrow mode is open", () => {
  assert.match(PLACEMENT, /window\.DFBurrowSync = \{/, "the hook the socket calls must be published");
  const hook = /window\.DFBurrowSync = \{[\s\S]*?\n  \};/.exec(PLACEMENT);
  assert.ok(hook, "DFBurrowSync must be an object literal");
  assert.match(hook[0], /burrowMode/, "a refetch is only useful while the overlay is live");
  assert.match(hook[0], /scheduleBurrowRefresh\(\)/, "the change must pull the new rects");
});

check("client: a z change refetches (rects are built for ONE z, server-side)", () => {
  assert.match(PLACEMENT, /function burrowWindowWatch\(\)/,
    "something must notice the camera's z/window moved under an open burrow panel");
  const watch = /function burrowWindowWatch\(\)[\s\S]*?\n  \}/.exec(PLACEMENT);
  assert.match(watch[0], /renderWindowSig\(\)[\s\S]*?scheduleBurrowRefresh\(\)/,
    "a changed window signature must pull fresh rects");
  const sig = /function renderWindowSig\(\)[\s\S]*?\n  \}/.exec(PLACEMENT);
  assert.ok(sig, "the window signature must exist");
  assert.match(sig[0], /rr\.oz/, "the z the rects were built for is the thing that goes stale");
  assert.match(sig[0], /burrowsWorldRects \? `z\$\{rr\.oz\}`/,
    "with world rects a PAN needs no refetch (the planner culls them); only z does");
  assert.match(watch[0], /burrowMode/, "the watch is only meaningful while the overlay is live");
});

check("client: the overlay is told which z its rects belong to", () => {
  assert.match(PLACEMENT, /setBurrows\(burrowsCache, burrowsZ\)/,
    "without the z, a payload from the old z paints its wash over the new one");
});

// ---------------------------------------------------------------------------------------------
// 4. THE OVERLAY PLANNER (pure, no DOM): z-gating + the geometry the fix depends on.
// ---------------------------------------------------------------------------------------------
const overlayGlobal = {};
new Function("window", "globalThis", read("web/js/dwf-burrow-overlay.js"))(undefined, overlayGlobal);
const plan = overlayGlobal.DwfBurrowOverlay.plan;

// A 60x30 browser window at world (100,200) on z=3 -- deliberately WIDER than DF's native viewport
// would be, which is the whole point: these are tiles an old server would never have sent.
const RR = { ox: 100, oy: 200, oz: 3, gw: 60, gh: 30, cell: 8, left: 0, top: 0 };

check("planner: tiles far out in the browser's window are drawn (they used to be clipped away)", () => {
  const burrow = { id: 1, rgb: [0, 255, 0], rects: [
    { x: 102, y: 202, w: 4, h: 1 },   // near the camera origin -- survived the old clip
    { x: 150, y: 225, w: 6, h: 1 },   // far right/down -- the half the owner never saw
  ] };
  const out = plan(RR, [burrow], 3);
  assert.equal(out.length, 2, "every rect inside the CLIENT's window must be planned");
  assert.equal(out[1].x, (150 - 100) * 8);
  assert.equal(out[1].width, 6 * 8);
});

check("planner: two burrows both render (the second burrow was not a special case)", () => {
  const out = plan(RR, [
    { id: 1, rects: [{ x: 101, y: 201, w: 2, h: 2 }] },
    { id: 2, rects: [{ x: 140, y: 220, w: 3, h: 1 }] },
  ], 3);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(p => p.burrow.id), [1, 2]);
});

check("planner: rects built for another z are NOT drawn on this one", () => {
  const list = [{ id: 1, rects: [{ x: 102, y: 202, w: 4, h: 1 }] }];
  assert.equal(plan(RR, list, 3).length, 1, "same z -> drawn");
  assert.equal(plan(RR, list, 2).length, 0, "payload z != camera z -> nothing (the refetch is in flight)");
  assert.equal(plan(RR, list).length, 1, "no z given (old DLL) -> unchanged behaviour, never a blank map");
});

check("planner: panning does not lose tiles from the model (world rects, client-side cull)", () => {
  const burrow = { id: 1, rects: [{ x: 300, y: 400, w: 5, h: 1 }] };
  assert.equal(plan(RR, [burrow], 3).length, 0, "off-window now");
  const panned = { ...RR, ox: 298, oy: 398 };
  assert.equal(plan(panned, [burrow], 3).length, 1,
    "the same payload must draw once the camera reaches it -- no refetch needed to pan");
});

// TEST-THE-TEST: each of the three fixture families must be able to fail.
check("TEST-THE-TEST: the fixtures are not vacuous", () => {
  const list = [{ id: 1, rects: [{ x: 150, y: 225, w: 6, h: 1 }] }];
  assert.throws(() => assert.equal(plan(RR, list, 3).length, 0),
    "a far-out rect IS planned -- if this ever passes, the 'used to be clipped' test is asserting nothing");
  assert.throws(() => assert.equal(plan(RR, list, 9).length, 1),
    "a wrong-z payload draws NOTHING -- if this ever passes, the z gate is asserting nothing");
  assert.throws(() => assert.match(CPP, /effective_capture_viewport_dims\(camera, view_w, view_h/),
    "the old window-clip call must really be gone from the file, not just from build_burrows_json");
});

console.log(`\nb238_burrow_refresh_test: ${passed} checks passed`);
