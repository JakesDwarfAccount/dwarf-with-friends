// WT02/WT05/WT03(a) roster DATA oracle (WP-A, spec §3.4/§7.3).
//
// Drives TWO protocol-v1 WebSocket clients (oracleA, oracleB) against the LIVE server with
// DISTINCT interest windows, decodes their AUX frames, and asserts the presence roster
// (players[]) reflects BOTH players and that each sees the OTHER's EXACT cam window
// (camx/camy/camz/camw/camh) + an rtt field + idle:1 (neither sends a cursor). This is the
// cross-client differential the spec's protocol rule 2 asks for: A's view of B is checked
// against what B actually SENT, not against A's own state.
//
// The viewbox fields come from the v1 connection's real zoom-aware interest window
// (WsConnection cam_*), NOT hud.viewport (the B25 zoom bug). Because A and B send DIFFERENT
// window sizes, a B25-style impl that sourced viewboxes from the shared server capture grid
// would make BOTH clients report the SAME camw -- so the per-window inequality below is exactly
// the differential that catches that bug class.
//
// Usage:
//   node tools/harness/wt02_wt05_roster_oracle.mjs                 # normal acceptance run
//   node tools/harness/wt02_wt05_roster_oracle.mjs --expect-viewport-bug
//        # TEST-THE-TEST (rule 3): flips the expectation to the B25 symptom (both clients see
//        # the SAME camw). Against a CORRECT server this run MUST FAIL -- proving the oracle
//        # distinguishes real per-player windows from the viewport-sourced bug.
//
// Requires Node >= 20 (global WebSocket). Exits non-zero on any failed assertion.

import zlib from "node:zlib";
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 8765;
const DUR_MS = 9000;
const EXPECT_VIEWPORT_BUG = process.argv.includes("--expect-viewport-bug");

// Distinct interest windows -- the whole point of the differential. z values are distinct too
// (WT02: triangles at different heights). Positions are driven via POST /camera (the browser's
// real pan path); dims via the WS cam message (the browser's real zoom path).
const CLIENTS = [
  { name: "oracleA", x: 10, y: 10, z: 140, w: 60, h: 34 },
  { name: "oracleB", x: 100, y: 90, z: 152, w: 120, h: 68 },
];

function fetchCameraZ(player) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: `/camera?player=${player}`, timeout: 4000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({ x: 0, y: 0, z: 100 }); } });
    });
    req.on("error", () => resolve({ x: 0, y: 0, z: 100 }));
    req.on("timeout", () => { req.destroy(); resolve({ x: 0, y: 0, z: 100 }); });
  });
}

// POST /camera -- the interest-window POSITION authority (§0.8 / world_stream.cpp ~:648: the
// streamed frame's origin comes from camera_for_player, NOT the WS cam message, whose xyz is
// advisory-only; real browsers pan via this HTTP route and send dims-only cam messages). The
// roster's camx/camy/camz must reflect THIS position, composed with the WS cam DIMS.
function postCamera(player, x, y, z) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, method: "POST",
      path: `/camera?player=${player}&x=${x}&y=${y}&z=${z}`, timeout: 4000 }, (res) => {
      res.resume(); res.on("end", resolve);
    });
    req.on("error", resolve);
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.end();
  });
}

function decodeAux(buf) {
  // buf: Uint8Array WS binary payload = a D5 frame. Header: 'D','5',?,type,flags,?,seq(4 LE).
  if (buf.length < 10 || buf[0] !== 0x44 || buf[1] !== 0x35) return null;
  const type = buf[3], flags = buf[4];
  const seq = buf[6] | (buf[7] << 8) | (buf[8] << 16) | (buf[9] << 24);
  if (type !== 0x02) return { type, seq, aux: null };   // only AUX carries players[]
  let body = Buffer.from(buf.subarray(10));
  if (flags & 0x01) { try { body = zlib.inflateSync(body); } catch { return { type, seq, aux: null }; } }
  let aux = null;
  try { aux = JSON.parse(body.toString("utf-8")); } catch { aux = null; }
  return { type, seq, aux };
}

async function runClient(cfg) {
  // Position authority: POST /camera (what a real browser's pan/z does). The WS hello/cam
  // below carries dims (authoritative) + advisory xyz, exactly like the browser client.
  await postCamera(cfg.name, cfg.x, cfg.y, cfg.z);
  const url = `ws://${HOST}:${PORT}/ws?player=${cfg.name}&w=${cfg.w}&h=${cfg.h}&proto=1`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const state = { name: cfg.name, sentZ: cfg.z, lastPlayers: null, auxCount: 0, ack: 0 };

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", proto: 1, player: cfg.name, have: 0,
      cam: { x: cfg.x, y: cfg.y, z: cfg.z, w: cfg.w, h: cfg.h } }));
    // Dims-only cam re-assert -- the exact message shape a real browser sends on zoom/resize.
    ws.send(JSON.stringify({ type: "cam", w: cfg.w, h: cfg.h }));
  });

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      let m = null; try { m = JSON.parse(ev.data); } catch {}
      if (m && m.type === "ping") ws.send(JSON.stringify({ type: "pong", ts: m.ts, tc: Date.now() }));
      return;
    }
    const buf = new Uint8Array(ev.data);
    const dec = decodeAux(buf);
    if (!dec) return;
    ws.send(JSON.stringify({ type: "ack", seq: dec.seq, t: Date.now() }));   // ack EVERY binary frame
    state.ack++;
    if (dec.type === 0x02 && dec.aux && Array.isArray(dec.aux.players)) {
      state.auxCount++;
      state.lastPlayers = dec.aux.players;
    }
  });

  ws.addEventListener("error", () => {});
  return { ws, state };
}

function assert(results, cond, msg) {
  results.push({ ok: !!cond, msg });
  return !!cond;
}

async function main() {
  console.log(`roster oracle -> ${HOST}:${PORT}  (mode: ${EXPECT_VIEWPORT_BUG ? "EXPECT-VIEWPORT-BUG / test-the-test" : "acceptance"})`);
  const a = await runClient(CLIENTS[0]);
  const b = await runClient(CLIENTS[1]);
  await new Promise((r) => setTimeout(r, DUR_MS));

  const results = [];
  const pa = a.state.lastPlayers, pb = b.state.lastPlayers;

  assert(results, a.state.auxCount > 0, `oracleA received AUX frames with players[] (got ${a.state.auxCount})`);
  assert(results, b.state.auxCount > 0, `oracleB received AUX frames with players[] (got ${b.state.auxCount})`);

  const find = (arr, nm) => Array.isArray(arr) ? arr.find((p) => p && p.name === nm) : null;
  const aSeesB = find(pa, "oracleB");
  const bSeesA = find(pb, "oracleA");
  const aSeesSelf = find(pa, "oracleA");

  assert(results, !!aSeesB, "oracleA's roster contains oracleB (roster reflects BOTH players)");
  assert(results, !!bSeesA, "oracleB's roster contains oracleA");
  assert(results, !!aSeesSelf && aSeesSelf.self === 1, "oracleA sees itself with self=1");

  if (aSeesB) {
    assert(results, aSeesB.camw === CLIENTS[1].w, `A sees B.camw == ${CLIENTS[1].w} (got ${aSeesB.camw}) -- B's REAL window, not hud.viewport`);
    assert(results, aSeesB.camh === CLIENTS[1].h, `A sees B.camh == ${CLIENTS[1].h} (got ${aSeesB.camh})`);
    assert(results, aSeesB.camx === CLIENTS[1].x, `A sees B.camx == ${CLIENTS[1].x} (got ${aSeesB.camx}) -- POST /camera position authority`);
    assert(results, aSeesB.camy === CLIENTS[1].y, `A sees B.camy == ${CLIENTS[1].y} (got ${aSeesB.camy})`);
    assert(results, aSeesB.camz === CLIENTS[1].z, `A sees B.camz == ${CLIENTS[1].z} (got ${aSeesB.camz}) -- WT02 triangle elevation source`);
    assert(results, typeof aSeesB.rtt === "number", `A sees B.rtt present (got ${aSeesB.rtt})`);
    assert(results, aSeesB.idle === 1, `A sees B.idle==1 (B never sent a cursor) (got ${aSeesB.idle})`);
    assert(results, aSeesB.x === undefined, `A sees B with NO cursor x (cursor-less roster entry) (got ${aSeesB.x})`);
  }
  if (bSeesA) {
    assert(results, bSeesA.camw === CLIENTS[0].w, `B sees A.camw == ${CLIENTS[0].w} (got ${bSeesA.camw})`);
    assert(results, bSeesA.camh === CLIENTS[0].h, `B sees A.camh == ${CLIENTS[0].h} (got ${bSeesA.camh})`);
  }

  // The differential: per-player windows must DIFFER between clients. A correct server reports
  // B's 120 to A and A's 60 to B. A B25 viewport-sourced impl would report the same shared grid
  // width to both. --expect-viewport-bug flips this to the bug's symptom so the oracle must fail
  // on a correct build (test-the-test).
  if (aSeesB && bSeesA) {
    const distinct = aSeesB.camw !== bSeesA.camw;
    if (EXPECT_VIEWPORT_BUG) {
      assert(results, !distinct,
        `TEST-THE-TEST: expected B25 symptom (A.camw==B.camw). Correct server has distinct windows ` +
        `(A sees ${aSeesB.camw}, B sees ${bSeesA.camw}) -> this MUST fail on a good build.`);
    } else {
      assert(results, distinct,
        `per-player windows differ (A sees B=${aSeesB.camw}, B sees A=${bSeesA.camw}) -- viewbox is the ` +
        `real interest window, NOT a shared viewport grid (the B25 differential)`);
    }
  }

  try { a.ws.close(); b.ws.close(); } catch {}

  let fails = 0;
  for (const r of results) { console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.msg}`); if (!r.ok) fails++; }
  console.log(`\n${results.length - fails}/${results.length} assertions passed`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error("oracle error:", e); process.exit(2); });
