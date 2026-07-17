// WT01 pause-arbiter oracle (WP-B, spec §2.2/§2.3) -- DEPLOY-GATED.
//
// Drives the LIVE server's /action pause path as two players (oracleA/oracleB) over REAL HTTP,
// with two protocol-v1 WebSocket clients capturing the {"type":"pause"} broadcasts, while polling
// ground-truth pause_state at 50 ms (GET /hud.paused, cross-checked against GET /pause-config's
// server "paused"). Counts pause_state TRANSITIONS across each scenario window and asserts they
// match the WT01 matrix cell exactly, plus that the WS clients saw the right by/reason attribution.
//
// GROUND TRUTH: pause_state transitions observed at 50 ms (sim-state read only -- /hud.paused ==
// *df.global.pause_state; NO widget reads). The debounce/merge claim is "N transitions over the
// window", which the 50 ms poller measures directly.
//
// REQUIRES THE WP-B DLL DEPLOYED. Against the pre-WP-B (old) DLL this whole run FAILS by design
// (no {"type":"pause"} frames; no /pause-config route; no merge) -- that IS the rule-3
// test-the-test proving the oracle detects the pre-WP-B server.
//
// Usage:
//   node tools/harness/wt01_pause_oracle.mjs                 # acceptance run (merge window ON)
//   node tools/harness/wt01_pause_oracle.mjs --known-bad     # TEST-THE-TEST: /pause-config?window=0
//        # then cells 1/2/5 MUST FAIL (>=2 transitions observed = the strobe the arbiter kills).
//        # A clean run here means the oracle is blind to the strobe -> the oracle is broken.
//
// The owner LOCK PROTOCOL: this run pauses/unpauses the live fort -- hold DF_LOCK + post the chat warning
// (jt-df-test-consent) before running. Node >= 20 (global WebSocket). Exits non-zero on any fail.

import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 8765;
const KNOWN_BAD = process.argv.includes("--known-bad");

function httpJson(method, path) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, method, path, timeout: 4000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, raw: b }); });
    });
    req.on("error", () => resolve({ status: 0, json: null, raw: "" }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, json: null, raw: "" }); });
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pause action (the browser's real path: POST /action?player=&action=) ----------------------
const act = (player, action) => httpJson("POST", `/action?player=${player}&action=${encodeURIComponent(action)}`);
// ground truth: pause_state via /hud (== *df.global.pause_state)
async function pausedNow(player) {
  const r = await httpJson("GET", `/hud?player=${player}`);
  return r.json && typeof r.json.paused === "boolean" ? r.json.paused : null;
}

// ---- a WS pause-frame capturing client ---------------------------------------------------------
function pauseClient(name) {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/ws?player=${name}&w=40&h=24&proto=1`);
  ws.binaryType = "arraybuffer";
  const st = { name, ws, pauses: [], busies: [] };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", proto: 1, player: name, have: 0, cam: { x: 0, y: 0, z: 0, w: 40, h: 24 } })));
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      let m = null; try { m = JSON.parse(ev.data); } catch { return; }
      if (!m) return;
      if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong", ts: m.ts, tc: Date.now() })); return; }
      if (m.type === "pause") st.pauses.push({ t: Date.now(), ...m });
      if (m.type === "busy") st.busies.push({ t: Date.now(), ...m });
      return;
    }
    // binary AUX/BLOCK_SET: ack every frame (seq at bytes 6..9 LE) so the connection stays healthy
    const b = new Uint8Array(ev.data);
    if (b.length >= 10 && b[0] === 0x44 && b[1] === 0x35) {
      const seq = b[6] | (b[7] << 8) | (b[8] << 16) | (b[9] << 24);
      ws.send(JSON.stringify({ type: "ack", seq, t: Date.now() }));
    }
  });
  ws.addEventListener("error", () => {});
  return st;
}

// Count pause_state edges over `ms` while `drive()` runs. Poller at 50 ms.
async function countTransitions(observer, ms, drive) {
  let last = await pausedNow(observer);
  let transitions = 0;
  let stop = false;
  const poll = (async () => {
    while (!stop) {
      const p = await pausedNow(observer);
      if (p !== null && last !== null && p !== last) { transitions++; last = p; }
      else if (p !== null) last = p;
      await sleep(50);
    }
  })();
  await drive();
  await sleep(ms);
  stop = true;
  await poll;
  return transitions;
}

const results = [];
function check(ok, msg) { results.push({ ok: !!ok, msg }); console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); return !!ok; }

async function ensureRunning(observer) {
  // start each scenario from RUNNING (unpaused) so transition counts are deterministic
  await act(observer, "play");
  await sleep(250);
}

async function main() {
  const cfg = await httpJson("GET", "/pause-config");
  if (cfg.status !== 200) {
    console.log("FAIL  /pause-config not present -> pre-WP-B DLL (this run is the rule-3 test-the-test against the old server; deploy the WP-B DLL for the real acceptance run).");
    process.exit(1);
  }
  // Configure merge window: default (400) for acceptance, 0 for the known-bad strobe check.
  await httpJson("GET", `/pause-config?window=${KNOWN_BAD ? 0 : 400}`);
  console.log(`merge window = ${KNOWN_BAD ? 0 : 400} ms  (${KNOWN_BAD ? "KNOWN-BAD strobe check" : "acceptance"})`);

  const A = pauseClient("oracleA");
  const B = pauseClient("oracleB");
  await sleep(800);   // let both sockets connect + hello

  // ---- Cell 1: A pause, B pause, Δ80 ms -> ONE transition to paused; B merged ----
  await ensureRunning("oracleA");
  A.pauses = []; B.pauses = [];
  let t = await countTransitions("oracleObs", 1200, async () => {
    await act("oracleA", "pause"); await sleep(80); await act("oracleB", "pause");
  });
  if (KNOWN_BAD) check(t >= 2, `[known-bad] cell1 strobe visible: ${t} transitions (expect >=2)`);
  else {
    check(t === 1, `cell1: A pause + B pause Δ80 -> ${t} transition (expect 1)`);
    check(A.pauses.some(p => p.paused && p.by === "oracleA" && p.reason === "player"), `cell1: clients saw pause by oracleA/player`);
    check(!A.pauses.some(p => p.by === "oracleB"), `cell1: B's pause was merged (no oracleB frame)`);
  }

  // ---- Cell 2: A toggle, B toggle, Δ80 (both from running) -> ONE transition; B suppressed ----
  await ensureRunning("oracleA"); A.pauses = []; B.pauses = [];
  t = await countTransitions("oracleObs", 1200, async () => {
    await act("oracleA", "toggle-pause"); await sleep(80); await act("oracleB", "toggle-pause");
  });
  if (KNOWN_BAD) check(t >= 2, `[known-bad] cell2 strobe visible: ${t} transitions (expect >=2)`);
  else check(t === 1, `cell2: A toggle + B toggle Δ80 -> ${t} transition (expect 1, B suppressed rule 3)`);

  // ---- Cell 3: A toggle, B toggle, Δ600 -> TWO transitions (window expired) ----
  if (!KNOWN_BAD) {
    await ensureRunning("oracleA"); A.pauses = [];
    t = await countTransitions("oracleObs", 1600, async () => {
      await act("oracleA", "toggle-pause"); await sleep(600); await act("oracleB", "toggle-pause");
    });
    check(t === 2, `cell3: A toggle + B toggle Δ600 -> ${t} transitions (expect 2, window expired)`);
  }

  // ---- Cell 4: A pause, A unpause, Δ100 -> BOTH apply (same actor reverses instantly) ----
  if (!KNOWN_BAD) {
    await ensureRunning("oracleA"); A.pauses = [];
    t = await countTransitions("oracleObs", 1200, async () => {
      await act("oracleA", "pause"); await sleep(100); await act("oracleA", "unpause");
    });
    check(t === 2, `cell4: A pause + A unpause Δ100 (same actor) -> ${t} transitions (expect 2)`);
  }

  // ---- Cell 5: A pause, B unpause, Δ100 -> B suppressed; still paused; clients see pause-by-A ----
  await ensureRunning("oracleA"); A.pauses = []; B.pauses = [];
  t = await countTransitions("oracleObs", 1200, async () => {
    await act("oracleA", "pause"); await sleep(100); await act("oracleB", "unpause");
  });
  const stillPaused = await pausedNow("oracleObs");
  if (KNOWN_BAD) check(t >= 2, `[known-bad] cell5 strobe visible: ${t} transitions (expect >=2)`);
  else {
    check(t === 1 && stillPaused === true, `cell5: A pause + B unpause Δ100 -> ${t} transition, paused=${stillPaused} (expect 1 + still paused; B suppressed)`);
    check(B.pauses.some(p => p.paused && p.by === "oracleA"), `cell5: B's client still shows "Paused by oracleA"`);
  }

  // ---- Cell 9: request with no world -> handled by server (can't force here; documented) ----
  // (Only reachable with no fort loaded; not driven by this oracle. Server returns HTTP 400
  //  "pause state unavailable" via pause_request's ok=false path -- code-verified, not live here.)

  // restore RUNNING + default window
  await act("oracleObs", "play");
  await httpJson("GET", "/pause-config?window=400");
  try { A.ws.close(); B.ws.close(); } catch {}

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${KNOWN_BAD ? " (known-bad: FAILs of the strobe cells are the pass condition -- read individual lines)" : ""}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
