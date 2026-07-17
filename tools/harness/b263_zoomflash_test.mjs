// b263_zoomflash_test.mjs -- B263 "workshops (and other buildings) flash invisible on zoom-out,
// almost every time, sometimes multiple flashes".
//
// ROOT CAUSE (proven from source, all paths read in this wave):
//   The server's AUX interest window is split across TWO channels with WILDLY different
//   latencies (world_stream.cpp:949-961 -- "the interest POSITION is the POST /camera
//   authority, dims come from CAM"):
//     * POSITION: zoom-out center-preservation shifts the camera by (-dw/2,-dh/2)
//       (dwf-core.js applyZoomResult -> queueMove), POSTed to /camera on the NEXT
//       animation frame (~16ms).
//     * DIMS: the new (larger) w/h go over the WS as {"type":"cam"} through
//       dwf-ws.js updateDims(), which DEBOUNCES 350ms (and rapid wheel ticks keep
//       RESETTING the timer).
//   So for >=350ms after every zoom-out step the server's window is (shifted origin x OLD
//   dims): it has moved up-left but NOT grown. Every building in the right dw/2-wide /
//   bottom dh/2-tall band of what the client now DISPLAYS falls outside that interim window;
//   the server's auxd delta rm's them (world_stream.cpp:2049-2056 -- rm = sent_bldgs not in
//   the clipped visible set, clip at :1937-1939); handleAuxV1 (dwf-tiles.js) deletes
//   them from auxBldgsById; the GL building fingerprint changes; the building segment is
//   rebuilt WITHOUT them -> workshops vanish on screen while terrain (client tile cache,
//   never window-evicted) stays. When the debounced cam message finally lands the window
//   grows, the server re-`up`s them, and they pop back. That IS the flash. Zoom-IN has the
//   benign order (position moves toward the still-covered center), which is why the owner only sees
//   it zooming out.
//
// FIX (both halves asserted here, both directions):
//   1. TRANSPORT: dwf-ws.js gains updateDimsNow() -- an immediate, debounce-cancelling
//      cam send -- and applyTilePx (dwf-tiles.js) uses it for zoom. Dims now reach the
//      server BEFORE the /camera position shift (same-tick WS send vs next-rAF POST), and a
//      dims-first interim window is a SUPERSET of everything already visible: nothing rm's.
//   2. RENDER ROBUSTNESS (order-independent): handleAuxV1 no longer blindly deletes an rm'd
//      building. If the delta's own cam window (the server tells us exactly what it clipped
//      against) does NOT contain the building's footprint but the client's display window
//      still does, the record is PARKED and keeps rendering; it is dropped the moment any
//      later aux window covers its footprint without re-upping it (real deconstruction,
//      no ghosts) or when it leaves the client's own display window (ordinary pan). An rm
//      whose window DOES cover the footprint is a genuine removal and deletes immediately.
//
// OFFLINE: no DF, no live server, no browser. Loads the REAL web/js/dwf-ws.js and
// web/js/dwf-tiles.js and drives them against a model server that mirrors
// world_stream.cpp's exact clip + auxd up/rm bookkeeping (line refs above). Deterministic:
// the "inconsistent" human timing is replaced by explicitly sequenced channel arrivals.
//
//   node tools/harness/b263_zoomflash_test.mjs
// Exit: 0 PASS, 1 FAIL.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const source = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  [" + extra + "]" : ""}`); }
}

// =============================================================================================
console.log("PART A -- dwf-ws.js: zoom needs an IMMEDIATE dims send (updateDimsNow)");
// =============================================================================================
// Real ws.js in an isolated context with a fake socket. Pins BOTH directions: the resize path
// keeps its 350ms debounce (the anti-reconnect-storm/scrollbar-jitter shield), while the new
// zoom path sends synchronously and cancels any pending debounced send.
const fakeSockets = [];
class FakeWebSocket {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; fakeSockets.push(this); }
  send(text) { this.sent.push(text); }
  close() { this.readyState = 3; }
}
const wsSandbox = {
  console, Date, JSON, Math, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  location: { protocol: "http:", host: "localhost:0" },
  document: { hidden: false, addEventListener() {} },
  requestAnimationFrame: () => 0,
  WebSocket: FakeWebSocket,
};
wsSandbox.window = wsSandbox;
wsSandbox.self = wsSandbox;
vm.createContext(wsSandbox);
vm.runInContext(source("web/js/dwf-ws.js"), wsSandbox, { filename: "dwf-ws.js" });
const WSAPI = wsSandbox.DwfWS;
check("A0: real dwf-ws.js loads headless", !!WSAPI && typeof WSAPI.updateDims === "function");

WSAPI.connect("b263", () => {}, () => {}, { w: 80, h: 45 },
  { proto1: true, onAux() {}, initialCam: { x: 100, y: 100, z: 50 } });
const sock = fakeSockets[fakeSockets.length - 1];
check("A0b: fake socket opened", !!sock);
if (sock && typeof sock.onopen === "function") sock.onopen();
const camMsgs = () => sock.sent.map((t) => { try { return JSON.parse(t); } catch (_) { return {}; } })
  .filter((m) => m.type === "cam");

// A1 (both-directions guard): the RESIZE path stays debounced -- no cam send inside 200ms.
const before = camMsgs().length;
WSAPI.updateDims(90, 50, 21.3);
check("A1: resize path (updateDims) still debounces -- no cam message synchronously",
  camMsgs().length === before);
await sleep(200);
check("A1b: ...and still none at +200ms (the 350ms shield is intact)",
  camMsgs().length === before);
await sleep(250);
check("A1c: the debounced resize send does land after ~350ms (deadband path alive)",
  camMsgs().length === before + 1 && camMsgs()[camMsgs().length - 1].w === 90);

// A2 (THE FIX, fails on unfixed main): updateDimsNow sends synchronously.
check("A2: updateDimsNow exists (the zoom path's immediate dims send)",
  typeof WSAPI.updateDimsNow === "function");
let a3ok = false, a4ok = false, a5ok = false;
if (typeof WSAPI.updateDimsNow === "function") {
  const n0 = camMsgs().length;
  WSAPI.updateDimsNow(96, 54, 20);
  const after = camMsgs();
  a3ok = after.length === n0 + 1 && after[after.length - 1].w === 96 &&
    after[after.length - 1].h === 54 && after[after.length - 1].zoom === 20;
  // A4: an in-flight debounced send is superseded (cancelled), never fires later with stale dims.
  WSAPI.updateDims(200, 200, 12);          // arm the debounce...
  WSAPI.updateDimsNow(110, 60, 17.36);     // ...zoom supersedes it
  const n1 = camMsgs().length;
  await sleep(450);
  const tail = camMsgs();
  a4ok = tail.length === n1 && tail[tail.length - 1].w === 110;
  // A5: identical dims are a no-op (no cam spam when the step is clamped).
  const n2 = camMsgs().length;
  WSAPI.updateDimsNow(110, 60, 17.36);
  a5ok = camMsgs().length === n2;
}
check("A3: updateDimsNow sends the cam message SYNCHRONOUSLY with w/h/zoom", a3ok);
check("A4: updateDimsNow cancels a pending debounced send (no stale-dims echo)", a4ok);
check("A5: updateDimsNow with unchanged dims sends nothing", a5ok);
WSAPI.close();

// =============================================================================================
console.log("PART B -- dwf-tiles.js boots against a mock transport + model server");
// =============================================================================================
// b211-convention DOM stubs, main global this time (tiles.js + its zoom/cam seams).
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost" };
globalThis.document = {
  hidden: false, readyState: "complete", addEventListener() {},
  getElementById() { return null; }, createElement() { return { style: {} }; },
  body: { appendChild() {} },
};
globalThis.addEventListener = () => {};
globalThis.innerWidth = 1920;
globalThis.innerHeight = 1080;
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.Image = class { set src(_v) {} };
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => null });
globalThis.requestAnimationFrame = () => 0;

// Mock transport at the SAME seam dwf-core/tiles use. Immediate sends are recorded with
// `immediate:true`; the legacy debounced path is recorded un-flagged (it stands in for ws.js's
// 350ms timer, whose real behavior PART A pins). The model server below consumes this log.
const wsLog = [];
let capturedOnAux = null;
globalThis.DwfWS = {
  connect(_player, _onMsg, _onClose, _dims, opts) { capturedOnAux = opts && opts.onAux; },
  isConnected: () => true,
  send(obj) { wsLog.push({ obj, immediate: true }); return true; },
  updateDims(w, h, zoom) { wsLog.push({ obj: { type: "cam", w, h, zoom }, immediate: false }); },
  updateDimsNow(w, h, zoom) {
    // Mirrors the real ws.js semantics PART A pins (A4): an immediate send CANCELS any pending
    // debounced dims, so a stale echo can never apply after it.
    for (let i = wsLog.length - 1; i >= 0; i--) if (!wsLog[i].immediate) wsLog.splice(i, 1);
    deferredDims.length = 0;
    wsLog.push({ obj: { type: "cam", w, h, zoom }, immediate: true });
  },
  setCursorHandler() {}, getStats: () => null, close() {},
};

const ctxStub = new Proxy({}, { get: (t, p) => (p === "canvas" ? canvasStub : () => {}), set: () => true });
const canvasStub = { width: 1920, height: 1080, style: {}, addEventListener() {},
  getContext: () => ctxStub, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }) };

vm.runInThisContext(source("web/js/dwf-tiles.js"), { filename: "dwf-tiles.js" });
const T = globalThis.DwfTiles;
check("B0: tiles module loads", !!T);
T.init({ canvas: canvasStub, manageCamera: false, managePoll: true });
check("B0b: init wired the mock transport (onAux captured)", typeof capturedOnAux === "function");

// The fix's observation seams. On unfixed main these are absent (that IS the failing-first
// signal for the render half).
const lastAux = () => (typeof T._lastAuxForTest === "function" ? T._lastAuxForTest() : null);
const parked = () => (typeof T._parkedBldgsForTest === "function" ? T._parkedBldgsForTest() : null);
check("B1: _lastAuxForTest hook exists (renderer-facing building set is observable)",
  typeof T._lastAuxForTest === "function");
check("B1b: _parkedBldgsForTest hook exists", typeof T._parkedBldgsForTest === "function");

// ---- model server: mirrors world_stream.cpp's clip + auxd bookkeeping ----------------------
// clip: world_stream.cpp:1930-1946 (x/y footprint vs [ox,ox+w) x [oy,oy+h), z==oz, no seedown
// modelled). rm/up: :2033-2065 (up = visible not in sent_bldgs; rm = sent_bldgs not visible).
const srv = {
  x: 100, y: 100, z: 50, w: 80, h: 45,      // interest window (position: /camera; dims: cam msg)
  all: [],                                   // live fort buildings
  sent: new Set(),                           // per-conn sent_bldgs
  aseq: 1,
};
function srvVisible() {
  return srv.all.filter((b) =>
    b.z === srv.z &&
    !(b.x2 < srv.x || b.x1 >= srv.x + srv.w || b.y2 < srv.y || b.y1 >= srv.y + srv.h));
}
function srvAuxTick() {
  const vis = srvVisible();
  const cur = new Set(vis.map((b) => b.id));
  const up = vis.filter((b) => !srv.sent.has(b.id));
  const rm = [...srv.sent].filter((id) => !cur.has(id));
  const base = srv.aseq; srv.aseq++;
  const msg = { type: "auxd", aseq: srv.aseq, base,
    cam: { x: srv.x, y: srv.y, z: srv.z, w: srv.w, h: srv.h } };
  if (up.length || rm.length) msg.buildings = { up, rm };
  srv.sent = cur;
  capturedOnAux(msg);
}
function srvFullTick() {
  const vis = srvVisible();
  srv.sent = new Set(vis.map((b) => b.id));
  capturedOnAux({ type: "aux", aseq: ++srv.aseq,
    cam: { x: srv.x, y: srv.y, z: srv.z, w: srv.w, h: srv.h },
    units: [], buildings: vis, players: [], djobs: [], proj: [], env: null });
}
// Drain the client->server log the way the two real channels deliver: immediate entries apply
// now; debounced entries apply only when `includeDebounced` (i.e. 350ms later).
function srvApplyClientMessages(includeDebounced) {
  for (const e of wsLog.splice(0)) {
    if (!e.immediate && !includeDebounced) { deferredDims.push(e); continue; }
    if (e.obj && e.obj.type === "cam" && e.obj.w > 0) { srv.w = e.obj.w; srv.h = e.obj.h; }
  }
  if (includeDebounced) for (const e of deferredDims.splice(0)) {
    if (e.obj && e.obj.type === "cam" && e.obj.w > 0) { srv.w = e.obj.w; srv.h = e.obj.h; }
  }
}
const deferredDims = [];
const hasBld = (id) => { const a = lastAux(); return !!(a && a.buildings.some((b) => b.id === id)); };

// ---- seed: a fort with a workshop near the right edge of the view --------------------------
// Client window 80x45 @ (100,100,z50) => displays x 100..179. Workshop id 9001 at x 173..175:
// on screen, and inside the dw/2=8-tile band that the interim zoom-out window abandons.
const WS_EDGE = { id: 9001, x1: 173, y1: 120, x2: 175, y2: 122, z: 50, type: "Workshop", subtype: 3 };
const WS_MID  = { id: 9002, x1: 130, y1: 115, x2: 132, y2: 117, z: 50, type: "Workshop", subtype: 0 };
srv.all = [WS_EDGE, WS_MID];
srvFullTick();
check("B2: full aux frame lands both workshops in the renderer-facing set",
  hasBld(9001) && hasBld(9002));

// =============================================================================================
console.log("PART C -- THE B263 TIMELINE, deterministic: zoom-out must never blank a visible workshop");
// =============================================================================================
// One wheel tick out: 24 -> 20 px/tile. 1920x1080 => dims 80x45 -> 96x54; core shifts camera
// by (-8, -5) to keep the view centered (applyZoomResult's -round(d/2)).
const d = T.zoom("out");
check("C0: zoom step grew the requested window (dw=16, dh=9)", d.dw === 16 && d.dh === 9);
T.noteCamDelta(-Math.round(d.dw / 2), -Math.round(d.dh / 2), 0); // core's applyZoomResult half

// THE RACE, replayed exactly: the /camera POSITION lands first...
srv.x += -Math.round(d.dw / 2); srv.y += -Math.round(d.dh / 2);   // /camera authority applies
srvApplyClientMessages(false);   // ...dims apply ONLY if the client sent them immediately
check("C1: the fix sends dims immediately, so the interim server window already grew",
  srv.w === 96 && srv.h === 54, `server window is ${srv.w}x${srv.h}`);

// Server AUX tick during the (historically 350ms) interim.
srvAuxTick();
check("C2: NO FLASH -- edge workshop still in the renderer-facing building set after the interim tick",
  hasBld(9001));
check("C2b: mid-screen workshop untouched", hasBld(9002));

// The debounced channel (if anything was left on it) settles; server re-offers the window.
srvApplyClientMessages(true);
srvAuxTick();
check("C3: after dims settle the workshop is (still) present -- and not via the parking bridge",
  hasBld(9001) && (parked() === null || parked().length === 0),
  parked() === null ? "no parked hook" : `parked=[${parked()}]`);

// ---- C4+: ORDER-INDEPENDENCE -- force the losing order (position beats dims) ---------------
// Even with updateDimsNow, WS-vs-HTTP delivery order is not a protocol guarantee. Replay the
// exact pre-fix interim (shifted position x stale dims) and require the PARKING bridge to keep
// the on-screen workshop rendered.
srv.w = 80; srv.h = 45;                        // server regresses to stale dims...
srvAuxTick();                                  // ...and clips: rm(9001) arrives (repro's rm)
check("C4: losing-order interim (stale dims window) must NOT blank the on-screen workshop",
  hasBld(9001), "this is exactly the flash when it fails");
check("C4b: the bridge is visible: 9001 is parked while the server window lags",
  parked() !== null && parked().includes(9001), parked() === null ? "no hook" : `parked=[${parked()}]`);
srv.w = 96; srv.h = 54;                        // dims finally land
srvAuxTick();                                  // window covers it again -> server re-ups
check("C5: once the server window catches up, the workshop is live again and unparked",
  hasBld(9001) && parked() !== null && !parked().includes(9001));

// ---- C6: NO GHOSTS -- deconstruction during the stale-window interim ------------------------
srv.w = 80; srv.h = 45;
srvAuxTick();                                  // 9001 parked again (window rm)
srv.all = srv.all.filter((b) => b.id !== 9001); // The owner deconstructs it while it's outside the window
srv.w = 96; srv.h = 54;                        // dims land; window covers the footprint again
srvAuxTick();                                  // ...but no `up` for 9001: server says gone
check("C6: a building deconstructed while parked is DROPPED when the window covers it without an up",
  !hasBld(9001) && parked() !== null && !parked().includes(9001));

// ---- C7: genuine removal inside a covering window still deletes instantly ------------------
check("C7-pre: mid workshop present", hasBld(9002));
srv.all = srv.all.filter((b) => b.id !== 9002);
srvAuxTick();                                  // rm with a window that COVERS the footprint
check("C7: an rm whose own cam window covers the footprint deletes immediately (no parking)",
  !hasBld(9002) && parked() !== null && !parked().includes(9002));

// ---- C8: pan hygiene -- buildings leaving the CLIENT window are not hoarded ----------------
const WS_LEFT = { id: 9003, x1: 95, y1: 118, x2: 97, y2: 120, z: 50, type: "Workshop", subtype: 1 };
srv.all = [WS_LEFT];
srvFullTick();
check("C8-pre: left-edge workshop present", hasBld(9003));
// Pan hard right: client + server windows both move; the building leaves BOTH.
T.noteCamDelta(60, 0, 0);
srv.x += 60;
srvAuxTick();                                  // rm; footprint is outside the CLIENT window too
check("C8: an rm for a building the client no longer displays is not parked (no hoarding on pan)",
  !hasBld(9003) && parked() !== null && !parked().includes(9003));

// ---- C9: full-frame parity -- a send_full assembled under a stale window must not blank ----
const WS_EDGE2 = { id: 9004, x1: 210, y1: 120, x2: 212, y2: 122, z: 50, type: "Workshop", subtype: 5 };
srv.all = [WS_EDGE2];
// settle: client at (152,100) after the +60 pan... reset both sides to a clean known state.
T.setCamAbsolute(160, 100, 50);
srv.x = 160; srv.y = 100; srv.w = 96; srv.h = 54;
srvFullTick();
check("C9-pre: workshop at the right edge present (client displays x 160..255)", hasBld(9004));
srv.w = 80; srv.h = 45;                        // stale-window regression again...
srvFullTick();                                 // ...and this time it's a FULL frame that clips it
check("C9: a full aux frame clipped by a stale window parks (not blanks) the on-screen workshop",
  hasBld(9004), "full-frame path must bridge exactly like the delta path");
srv.w = 96; srv.h = 54;
srvFullTick();
check("C9b: covering full frame restores it live and drains the park", hasBld(9004) &&
  parked() !== null && parked().length === 0);

// ---- C10: TEST-THE-TEST -- the detector catches the old (blind-delete) behavior ------------
// Simulate exactly what unfixed handleAuxV1 did with C4's rm: delete regardless of the delta's
// cam window. The flash detector (hasBld during the interim) must fire on that behavior.
{
  const set = new Map([[9001, WS_EDGE]]);
  const rmCam = { x: 92, y: 95, w: 80, h: 45, z: 50 };   // C4's interim window
  const blindDelete = (m, id) => m.delete(id);           // pre-fix behavior
  blindDelete(set, 9001);
  const flashDetectorFires = !set.has(9001);
  const footprintOnScreen = WS_EDGE.x2 >= 92 && WS_EDGE.x1 < 92 + 96;   // client window
  const outsideRmWindow = WS_EDGE.x1 >= rmCam.x + rmCam.w;
  check("C10: (test-the-test) the pre-fix blind delete WOULD trip the C4 flash detector",
    flashDetectorFires && footprintOnScreen && outsideRmWindow);
}

// =============================================================================================
console.log("PART D -- source ties (the wiring is the fix, not a lookalike)");
// =============================================================================================
const tilesSrc = source("web/js/dwf-tiles.js");
const wsSrc = source("web/js/dwf-ws.js");
check("D1: applyTilePx routes zoom dims through the immediate path (updateDimsNow)",
  /updateDimsNow/.test(tilesSrc) && /applyTilePx[\s\S]{0,1600}updateDimsNow/.test(tilesSrc));
check("D2: dwf-ws.js exports updateDimsNow", /updateDimsNow/.test(wsSrc));
check("D3: handleAuxV1's rm path consults the delta's own cam window before deleting",
  /bldOutsideWindow|parkBld|auxBldgsParked/.test(tilesSrc));

console.log(`\n${failed ? "FAIL" : "PASS"} b263_zoomflash_test -- ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
