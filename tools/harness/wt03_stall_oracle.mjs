// WT03(d2) saving/world-busy indicator oracle (WP-B, spec §4.4) -- DEPLOY-GATED + FREEZE-CONSENTED.
//
// Reproduces a save-class core stall SYNTHETICALLY by scheduling a lua callback on DF's
// core update loop. A direct dfhack-run RPC busy-wait only blocks its RPC worker, not the
// heartbeat being observed; the scheduled callback is the part that actually models a save.
// The oracle asserts the two WS clients both
// receive {"type":"busy","state":"start"} within ~threshold+slack and {"type":"busy","state":
// "clear"} within ~1 s of release. The busy watchdog lives on ws_cursor_loop (never takes
// CoreSuspender) precisely so it keeps flowing while the core is blocked -- this oracle proves it.
//
// REQUIRES THE WP-B DLL DEPLOYED. Freezes the sim for the stall duration -> the owner LOCK PROTOCOL:
// hold DF_LOCK + post the chat warning (jt-df-test-consent) before running.
//
// Modes:
//   node tools/harness/wt03_stall_oracle.mjs                 # 3 s stall, default threshold: DETECT
//   node tools/harness/wt03_stall_oracle.mjs --threshold-high
//        # TEST-THE-TEST: /pause-config?busy=10000 then a 3 s stall -> NO busy broadcast (proves
//        # the oracle isn't passing vacuously).
//   node tools/harness/wt03_stall_oracle.mjs --brief
//        # TEST-THE-TEST: 1 s stall at the default 1500 ms threshold -> NO broadcast (debounce).
//
// The synthetic callback runs via `dfhack-run lua -f <ABSOLUTE file>` (inline multi-statement lua
// fails with "unexpected symbol near 'local'" -- the milequip harness lesson). `--self-test`
// validates the generated core-loop callback without spawning a process or contacting DF. Node >= 20.

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultDfhackRun } from "../lib/dfroot.mjs";   // W1: resolved, never hardcoded
import { requireLiveOptIn } from "./live_guard.mjs";

// W1 drive-by: this oracle drives a REAL DF host on :8765 (it even spawns dfhack-run to stall the
// game). B242 put every other live oracle behind an explicit opt-in, but this file is named
// *_oracle.mjs, not *_test.mjs, so the sweep's glob never saw it and neither did that audit. Port
// 8765 is the fort when he is playing. Same gate as the rest, for the same reason.
requireLiveOptIn("wt03_stall_oracle.mjs", "http://127.0.0.1:8765");

const HOST = "127.0.0.1";
const PORT = 8765;
const THRESHOLD_HIGH = process.argv.includes("--threshold-high");
const BRIEF = process.argv.includes("--brief");
const SELF_TEST = process.argv.includes("--self-test");
const STALL_S = BRIEF ? 1 : 3;
const EXPECT_DETECT = !THRESHOLD_HIGH && !BRIEF;
const DFHACK_RUN = process.env.DFHACK_RUN ||
  defaultDfhackRun();

function httpJson(method, path) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, method, path, timeout: 4000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", () => resolve({ status: 0, json: null }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function busyClient(name) {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/ws?player=${name}&w=40&h=24&proto=1`);
  ws.binaryType = "arraybuffer";
  const st = { name, ws, busies: [] };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", proto: 1, player: name, have: 0, cam: { x: 0, y: 0, z: 0, w: 40, h: 24 } })));
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      let m = null; try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.type === "ping") { ws.send(JSON.stringify({ type: "pong", ts: m.ts, tc: Date.now() })); return; }
      if (m && m.type === "busy") st.busies.push({ t: Date.now(), ...m });
      return;
    }
    const b = new Uint8Array(ev.data);
    if (b.length >= 10 && b[0] === 0x44 && b[1] === 0x35) {
      const seq = b[6] | (b[7] << 8) | (b[8] << 16) | (b[9] << 24);
      ws.send(JSON.stringify({ type: "ack", seq, t: Date.now() }));
    }
  });
  ws.addEventListener("error", () => {});
  return st;
}

function syntheticStallLua(seconds, markerPath) {
  // `frames` callbacks run from DFHack's core update path. Keeping the busy-wait INSIDE the
  // callback is load-bearing: doing it in the RPC lua invocation only stalls that RPC worker.
  const marker = markerPath.replaceAll("\\", "/");
  return `local seconds = ${seconds}\nlocal marker = [=[${marker}]=]\ndfhack.timeout(1, 'frames', function()\n  local t = os.clock()\n  while os.clock() - t < seconds do end\n  local f = assert(io.open(marker, 'w'))\n  f:write('stall done\\n')\n  f:close()\nend)\nprint('stall scheduled')\n`;
}

function runSyntheticPathSelfTest() {
  const source = syntheticStallLua(3, "C:/tmp/wt03.done");
  const callbackAt = source.indexOf("dfhack.timeout(1, 'frames', function()");
  const waitAt = source.indexOf("while os.clock() - t < seconds do end");
  const markerAt = source.indexOf("f:write('stall done\\n')");
  const checks = [
    [callbackAt >= 0, "synthetic stall is scheduled on the DF frame/core-update path"],
    [waitAt > callbackAt, "busy-wait is inside the scheduled callback, not the RPC invocation"],
    [markerAt > waitAt, "completion marker is written only after the synthetic core stall"],
  ];
  for (const [ok, message] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
  return checks.every(([ok]) => ok) ? 0 : 1;
}

async function fireStall(seconds) {
  const artifactDir = join(process.cwd(), ".tmp-codex-artifacts", "tooling");
  mkdirSync(artifactDir, { recursive: true });
  const stem = `wt03-stall-${Date.now()}`;
  const scriptPath = join(artifactDir, `${stem}.lua`);
  const markerPath = join(artifactDir, `${stem}.done`);
  writeFileSync(scriptPath, syntheticStallLua(seconds, markerPath));
  const launch = await new Promise((resolve) => {
    const p = spawn(DFHACK_RUN, ["lua", "-f", scriptPath], { stdio: "ignore" });
    p.on("close", (code) => resolve({ code, error: null }));
    p.on("error", (error) => resolve({ code: null, error }));
  });
  if (launch.error || launch.code !== 0) return { ok: false, detail: launch.error?.message || `dfhack-run exit ${launch.code}` };

  const deadline = Date.now() + (seconds * 1000) + 5000;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return { ok: true, detail: markerPath };
    await sleep(50);
  }
  return { ok: false, detail: `scheduled core callback did not write ${markerPath}` };
}

const results = [];
const check = (ok, msg) => { results.push({ ok: !!ok, msg }); console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); return !!ok; };

async function main() {
  const cfg = await httpJson("GET", "/pause-config");
  if (cfg.status !== 200) { console.log("FAIL  /pause-config absent -> pre-WP-B DLL; deploy the WP-B DLL first."); process.exit(1); }
  await httpJson("GET", `/pause-config?busy=${THRESHOLD_HIGH ? 10000 : 1500}`);
  console.log(`busy threshold = ${THRESHOLD_HIGH ? 10000 : 1500} ms; synthetic stall = ${STALL_S}s; expect ${EXPECT_DETECT ? "DETECT" : "NO detect"}`);

  const A = busyClient("stallA");
  const B = busyClient("stallB");
  await sleep(900);
  A.busies = []; B.busies = [];

  const fireT = Date.now();
  const stall = await fireStall(STALL_S);  // waits for the core-loop callback's completion marker
  check(stall.ok, `synthetic core-loop stall completed (${stall.detail})`);
  await sleep(1500);                       // allow the clear broadcast + client hold

  const startA = A.busies.find(x => x.state === "start");
  const startB = B.busies.find(x => x.state === "start");
  const clearA = A.busies.find(x => x.state === "clear");

  if (EXPECT_DETECT) {
    check(!!startA && !!startB, `both clients got busy:start (A=${!!startA} B=${!!startB})`);
    if (startA) check(startA.t - fireT < 1500 + 700, `busy:start latency ${startA.t - fireT}ms (< threshold+slack)`);
    check(!!clearA, `client got busy:clear after release`);
  } else {
    check(!startA && !startB, `NO busy:start (${THRESHOLD_HIGH ? "threshold raised above stall" : "sub-threshold brief stall"}) -- oracle not passing vacuously`);
  }

  await httpJson("GET", "/pause-config?busy=1500");
  try { A.ws.close(); B.ws.close(); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
if (SELF_TEST) process.exit(runSyntheticPathSelfTest());
main().catch((e) => { console.error(e); process.exit(2); });
