// dropstale_test.mjs -- WA-4 acceptance deliverable (docs/superpowers/specs/
// 2026-07-07-WA-foundation-spec.md, "drop-stale delivery + rAF-batched draw + F3 backlog
// metrics"). Replays a burst fixture through the REAL web/js/dwf-ws.js module (loaded
// verbatim, unmodified, via vm.runInThisContext -- not reimplemented/duplicated) with:
//   - a hand-mocked WebSocket (full control over exactly which frames "arrive" and when)
//   - a hand-mocked, MANUALLY-STEPPED requestAnimationFrame (so the test decides exactly
//     when the drop-stale drain runs -- this is what lets a burst of messages delivered in
//     a tight synchronous loop pile up in the module's internal pend[] queue BEFORE any
//     policy evaluation, reproducing the real "many frames arrive within one animation
//     frame interval" coalescing mechanism deterministically)
//   - the REAL DecompressionStream/CompressionStream/Response/TextDecoder (Node >=18/21
//     ships the actual browser Web Streams implementations of these as globals -- using them
//     as-is exercises the module's genuine async binary/inflate code path end-to-end rather
//     than re-implementing a fake one; only the transport (WebSocket) and paint clock
//     (requestAnimationFrame) need synthetic control for a deterministic test)
//
// Fixture: tools/harness/fixtures/dropstale_burst.json -- synthetic (small window, minimal
// tile fields) but wire-shape-faithful: 60 back-to-back deltas with NO rescuing keyframe
// (the lag_lab.py "stall 2s-every-8s" class from specs/2026-07-06-ws-transport-report.md
// §evidence: 982ms -> 89ms median display lag under exactly this pattern), followed by the
// server's fresh keyframe answering the client's reqkey escape hatch, followed by a small
// trickle of ordinary deltas.
//
// Run: node tools/harness/dropstale_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS_PATH = path.resolve(__dirname, "../../web/js/dwf-ws.js");
const FIXTURE_PATH = path.resolve(__dirname, "fixtures/dropstale_burst.json");

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

// ---- mock: WebSocket ------------------------------------------------------------
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.binaryType = "blob";
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.lastInstance = this;
  }
  send(text) { this.sent.push(text); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    if (typeof this.onclose === "function") this.onclose();
  }
}
FakeWebSocket.lastInstance = null;

// ---- mock: manually-stepped requestAnimationFrame -------------------------------
let rafQueue = [];
function fakeRaf(cb) { rafQueue.push(cb); return rafQueue.length; }
function fakeCaf() { /* callbacks are consumed by stepFrame(); nothing to cancel by id */ }
function stepFrame() {
  const q = rafQueue;
  rafQueue = [];
  for (let i = 0; i < q.length; i++) q[i]();
}

// ---- minimal browser-shaped globals (module only touches these) ----------------
globalThis.window = globalThis;
globalThis.location = { protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {} };
globalThis.WebSocket = FakeWebSocket;
globalThis.requestAnimationFrame = fakeRaf;
globalThis.cancelAnimationFrame = fakeCaf;
// DecompressionStream/Response/TextDecoder/CompressionStream: REAL Node globals, untouched.

const src = fs.readFileSync(WS_PATH, "utf8");
vm.runInThisContext(src, { filename: WS_PATH });
const DwfWS = globalThis.DwfWS;
assert.ok(DwfWS, "dwf-ws.js did not install window.DwfWS");

// ---- helpers ---------------------------------------------------------------------
function envelope(mode, tiles) {
  return JSON.stringify({
    type: "map", mode: mode,
    map: { origin: fixture.origin, width: fixture.width, height: fixture.height,
           z: fixture.origin.z, tiles: tiles },
  });
}
async function deflateToArrayBuffer(text) {
  const cs = new CompressionStream("deflate");
  const stream = new Response(text).body.pipeThrough(cs);
  return await new Response(stream).arrayBuffer();
}
async function waitUntil(pred, maxMs) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > (maxMs || 1000)) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}
function applyTilesInto(state, tiles) {
  for (const t of tiles) {
    const gx = t.x - fixture.origin.x, gy = t.y - fixture.origin.y;
    if (gx < 0 || gy < 0 || gx >= fixture.width || gy >= fixture.height) continue;
    state[gy * fixture.width + gx] = t.v;
  }
}

let failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}`); }
}

// ==================================================================================
// TEST 1 -- rule 2: a keyframe supersedes every older pending map message unapplied.
// ==================================================================================
async function testSupersede() {
  console.log("TEST 1: keyframe supersedes pending deltas (rule 2)");
  const applied = [];
  DwfWS.connect("t1", (msg) => applied.push(msg.mode), () => {}, { w: fixture.width, h: fixture.height });
  const sock = FakeWebSocket.lastInstance;
  sock.readyState = 1;
  sock.onopen();

  const before = DwfWS.getStats();
  // Two deltas queue up WITHOUT a frame tick in between (still-pending, unapplied).
  sock.onmessage({ data: envelope("delta", [fixture.burstDeltas[0][0]]) });
  sock.onmessage({ data: envelope("delta", [fixture.burstDeltas[1][0]]) });
  check("2 deltas pending before any drain", DwfWS.getStats().pendingMaps === 2);
  check("nothing applied yet (no frame tick ran)", applied.length === 0);

  // A keyframe arrives next -- it must supersede both pending deltas immediately (at
  // enqueue time, not drain time).
  sock.onmessage({ data: envelope("key", fixture.rescueKeyframe) });
  const afterSupersede = DwfWS.getStats();
  check("pend collapsed to just the keyframe", afterSupersede.pendingMaps === 1);
  check("the 2 superseded deltas were counted as dropped",
    afterSupersede.droppedStale - before.droppedStale === 2);

  stepFrame();
  check("exactly the keyframe got applied", applied.length === 1 && applied[0] === "key");

  DwfWS.close();
}

// ==================================================================================
// TEST 2 -- rule 4 (big backlog -> drop + one latched reqkey) then rule 3 (small
// backlog -> apply all, single drain) once the rescue keyframe + trailing deltas land.
// This is the fixture's headline scenario: 60 deltas + 1 keyframe.
// ==================================================================================
async function testBurstThenRescue() {
  console.log("TEST 2: big-backlog drop+reqkey, then rescue keyframe + trailing deltas");
  const applied = [];
  const refState = new Array(fixture.width * fixture.height).fill(null);
  let dirty = false;
  let drawCount = 0;
  function onMessage(msg) {
    applied.push(msg.mode);
    applyTilesInto(refState, msg.map.tiles || []);
    dirty = true;   // mirrors dwf-tiles.js: mapDirty=true, NOT a synchronous draw
  }
  DwfWS.connect("t2", onMessage, () => {}, { w: fixture.width, h: fixture.height });
  const sock = FakeWebSocket.lastInstance;
  sock.readyState = 1;
  sock.onopen();

  const before = DwfWS.getStats();

  // --- the burst: 60 deltas delivered back-to-back, no frame tick in between (exactly
  // how a stall-then-flush burst arrives: many WS message events fire well inside one
  // animation-frame interval). ---
  for (let i = 0; i < fixture.burstDeltas.length; i++) {
    sock.onmessage({ data: envelope("delta", fixture.burstDeltas[i]) });
  }
  check("60 deltas queued, none applied pre-drain", applied.length === 0);

  stepFrame();   // one animation frame's worth of drain
  const afterBurst = DwfWS.getStats();
  check("rule 4 fired: nothing from the burst was applied", applied.length === 0);
  check("all 60 dropped unapplied",
    afterBurst.droppedStale - before.droppedStale === fixture.burstDeltas.length);
  check("exactly one reqkey escape sent", afterBurst.resyncs - before.resyncs === 1);
  const reqkeys = sock.sent.filter((s) => { try { return JSON.parse(s).type === "reqkey"; } catch (_) { return false; } });
  check("exactly one reqkey frame on the wire", reqkeys.length === 1);
  check("queue drained empty", afterBurst.pendingMaps === 0);

  // A second burst arriving before the rescue keyframe must NOT spam more reqkeys (the
  // latch holds until a keyframe actually arrives).
  for (let i = 0; i < 5; i++) sock.onmessage({ data: envelope("delta", [fixture.burstDeltas[i][0]]) });
  stepFrame();
  const afterSecondBurst = DwfWS.getStats();
  check("reqkey latch prevents a second reqkey while still starved",
    afterSecondBurst.resyncs === afterBurst.resyncs);

  // --- the rescue keyframe: sent as a COMPRESSED BINARY frame (the real wire only ever
  // compresses keyframes) -- exercises the genuine async inflate path. ---
  const kfText = envelope("key", fixture.rescueKeyframe);
  const compressed = await deflateToArrayBuffer(kfText);
  sock.onmessage({ data: compressed });
  check("an inflate is now in flight", DwfWS.getStats().pendingInflates === 1);
  await waitUntil(() => DwfWS.getStats().pendingInflates === 0, 2000);

  // --- trailing trickle: 2 ordinary deltas after the keyframe, still within budget. ---
  for (const tiles of fixture.trailingDeltas) sock.onmessage({ data: envelope("delta", tiles) });
  check("small backlog before its drain", DwfWS.getStats().pendingMaps === 1 + fixture.trailingDeltas.length);

  const preDrawApplied = applied.length;
  stepFrame();
  const gotThisFrame = applied.slice(preDrawApplied);
  check("rule 3: keyframe + both trailing deltas all applied in order",
    gotThisFrame.length === 3 &&
    gotThisFrame[0] === "key" && gotThisFrame[1] === "delta" && gotThisFrame[2] === "delta");

  // "draws once" -- a separate mock draw tick (mirroring dwf-tiles.js's OWN
  // independent rAF+dirty-flag loop) must fire at most once for this frame no matter how
  // many onMessage calls happened inside drainOnce().
  if (dirty) { drawCount++; dirty = false; }
  check("draws exactly once for the whole batch", drawCount === 1);

  // --- final-state equivalence: drop-stale result === naive full-serial-apply result. ---
  // A keyframe always fully rebuilds state, so the reference model (apply EVERY message,
  // including the 60 dropped ones, in arrival order) converges on the SAME final state as
  // the drop-stale model, because whatever the 60 deltas wrote gets overwritten by the
  // keyframe either way.
  const serialRef = new Array(fixture.width * fixture.height).fill(null);
  for (const tiles of fixture.burstDeltas) applyTilesInto(serialRef, tiles);
  applyTilesInto(serialRef, fixture.rescueKeyframe);
  for (const tiles of fixture.trailingDeltas) applyTilesInto(serialRef, tiles);
  check("final buffer state === serial-apply reference state",
    JSON.stringify(refState) === JSON.stringify(serialRef));

  DwfWS.close();
}

(async function main() {
  await testSupersede();
  await testBurstThenRescue();
  console.log(failed === 0 ? `PASS (0 failures)` : `FAIL (${failed} failures)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error("FATAL:", err && err.stack || err);
  process.exit(1);
});
