// tools/loadtest.mjs — WS5 load-test harness for Dwarf With Friends (dwf).
// Simulates N players (stream consumption + random pan/designate), measures
// per-player fps / input->frame latency / bandwidth and the host-FPS delta,
// and exits non-zero when a spec acceptance threshold is breached.
// Part of Dwarf With Friends (dwf). License: AGPL-3.0-only. Node >= 18, zero external deps.
//
// Live:    node tools/loadtest.mjs --url http://127.0.0.1:8765 --players 4 \
//            --duration 30 --thresholds ws1 --baseline-fps <polling-fps> \
//            --df "C:\...\Dwarf Fortress" [--password pw]
// Dry-run: node tools/stub-server.mjs --port 8770        (second terminal)
//          node tools/loadtest.mjs --url http://127.0.0.1:8770 --players 4 \
//            --duration 10 --steady 5 --idle 5 --baseline-fps 5 --stub-pause

import {
  HttpClient, openStream, sleep, pct, fmtTable, parseArgs,
  dfhackRun, readHostFps, findDFPid, pidAlive,
} from "./lib/mdutil.mjs";

// Spec acceptance numbers. Sources: spec §6-WS1 and §6-WS2
// (docs/superpowers/specs/2026-07-04-multiplayer-rework-design.md).
// activeFpsAbsMin is a CHOSEN floor (spec gives only the 1.5x relative number)
// used only when --baseline-fps is not supplied.
const THRESHOLDS = {
  ws1: {
    activeFpsRatioMin: 1.5,        // >= 1.5x polling baseline   (spec WS1)
    activeFpsAbsMin: 6,            // chosen floor, see plan header
    idleBytesPerSecMax: 5 * 1024,  // < 5 KB/s/player idle       (spec WS1)
    latencyP95MsMax: 250,          // < 250 ms input->visible    (spec WS1)
    hostFpsDropPctMax: null,       // not specified for WS1
    steadyBytesPerSecMax: null,    // not specified for WS1
  },
  ws2: {
    activeFpsRatioMin: 1.5,
    activeFpsAbsMin: 6,
    idleBytesPerSecMax: 5 * 1024,
    latencyP95MsMax: 250,
    hostFpsDropPctMax: 5,          // host FPS within 5% w/ 4 clients (spec WS2)
    steadyBytesPerSecMax: 10 * 1024, // <= 10 KB/s/player steady      (spec WS2)
  },
};

const args = parseArgs(process.argv.slice(2), {
  url: "http://127.0.0.1:8765",
  players: "4", duration: "30", steady: "15", idle: "15",
  "cadence-ms": "500", "designate-rate": "0.15", "latency-timeout-ms": "2500",
  thresholds: "ws1", "baseline-fps": "", df: "", password: "",
  exe: "Dwarf Fortress.exe", "stub-pause": false, w: "1280", h: "720",
});

function die(msg) { console.error(`loadtest: ${msg}`); process.exit(2); }

const T = THRESHOLDS[args.thresholds];
if (!T) die(`unknown --thresholds ${args.thresholds} (ws1|ws2)`);
const N = parseInt(args.players, 10);
const DURATION_S = parseInt(args.duration, 10);
const STEADY_S = parseInt(args.steady, 10);
const IDLE_S = parseInt(args.idle, 10);
const CADENCE_MS = parseInt(args["cadence-ms"], 10);
const DESIGNATE_RATE = parseFloat(args["designate-rate"]);
const LAT_TIMEOUT = parseInt(args["latency-timeout-ms"], 10);
const FRAME_W = parseInt(args.w, 10);
const FRAME_H = parseInt(args.h, 10);
if (!(N > 0 && DURATION_S > 0)) die("--players and --duration must be > 0");

const client = new HttpClient(args.url);
let phase = "warmup"; // warmup -> active -> steady -> idle -> done

class Player {
  constructor(idx) {
    this.name = `loadtest-${idx}`;
    this.parts = { active: 0, steady: 0, idle: 0 };
    this.hb = 0;
    this.latencies = [];
    this.waiters = []; // {x,y,z,t0,timer,done}
    this.designates = 0;
    this.saving503 = 0;
    this.errors = [];
    this.streamErr = null;
    this.byteMarks = {};
    this.stream = openStream(client, this.name,
      (part) => this.onPart(part),
      (err) => { if (phase !== "done") this.streamErr = err || new Error("stream ended early"); });
  }
  onPart(part) {
    if (part.heartbeat) { this.hb++; return; }
    if (phase in this.parts) this.parts[phase]++;
    if (part.camera) {
      for (const w of this.waiters) {
        if (!w.done && w.x === part.camera.x && w.y === part.camera.y && w.z === part.camera.z) {
          w.done = true; clearTimeout(w.timer);
          this.latencies.push(part.tRecv - w.t0);
        }
      }
      this.waiters = this.waiters.filter((w) => !w.done);
    }
  }
  mark(label) { this.byteMarks[label] = this.stream.bytes(); }
  bytesBetween(a, b) { return (this.byteMarks[b] ?? 0) - (this.byteMarks[a] ?? 0); }

  async panProbe() {
    const dx = (Math.floor(Math.random() * 8) + 1) * (Math.random() < 0.5 ? -1 : 1);
    const dy = (Math.floor(Math.random() * 8) + 1) * (Math.random() < 0.5 ? -1 : 1);
    const t0 = Date.now();
    const r = await client.json("POST",
      `/camera?player=${encodeURIComponent(this.name)}&dx=${dx}&dy=${dy}`);
    if (r.status !== 200 || !r.json || typeof r.json.x !== "number") {
      this.errors.push(`camera HTTP ${r.status}`);
      return;
    }
    await new Promise((resolve) => {
      const w = {
        x: r.json.x, y: r.json.y, z: r.json.z, t0, done: false,
        timer: setTimeout(() => {
          if (!w.done) { w.done = true; this.latencies.push(LAT_TIMEOUT); }
          resolve();
        }, LAT_TIMEOUT),
      };
      const origPush = this.latencies.push.bind(this.latencies);
      // resolve as soon as onPart records this waiter's latency
      w.resolveHook = resolve;
      this.waiters.push(w);
      // poll-free resolution: onPart sets done; check on a short interval
      const iv = setInterval(() => {
        if (w.done) { clearInterval(iv); clearTimeout(w.timer); resolve(); }
      }, 10);
      setTimeout(() => clearInterval(iv), LAT_TIMEOUT + 100);
    });
  }

  async designateProbe() {
    // Marker-dig a 3x3 pixel box then erase it: exercises the full placement
    // path while leaving the fort unchanged (erase also cancels jobs in the
    // box -- keep --designate-rate 0 on forts that matter).
    const px = 100 + Math.floor(Math.random() * (FRAME_W - 200));
    const py = 100 + Math.floor(Math.random() * (FRAME_H - 200));
    const base = `player=${encodeURIComponent(this.name)}&px=${px}&py=${py}` +
      `&px2=${px + 48}&py2=${py + 48}&w=${FRAME_W}&h=${FRAME_H}`;
    const dig = await client.json("GET", `/designate?${base}&tool=dig&marker=1`);
    if (dig.json && dig.json.saving) { this.saving503++; return; }
    if (dig.status !== 200) { this.errors.push(`designate HTTP ${dig.status}`); return; }
    this.designates++;
    const er = await client.json("GET", `/designate?${base}&tool=erase`);
    if (er.status !== 200 && !(er.json && er.json.saving))
      this.errors.push(`erase HTTP ${er.status}`);
  }

  async inputLoop() {
    while (phase === "active" || phase === "warmup") {
      await sleep(CADENCE_MS * (0.75 + Math.random() * 0.5));
      if (phase !== "active") continue;
      try {
        if (Math.random() < DESIGNATE_RATE) await this.designateProbe();
        else await this.panProbe();
      } catch (e) { this.errors.push(String(e.message || e)); }
    }
  }
}

async function sampleHostFps(seconds) {
  const samples = [];
  for (let i = 0; i < seconds; i++) {
    try { samples.push(await readHostFps(args.df)); } catch (e) { /* transient */ }
    await sleep(1000);
  }
  if (!samples.length) return null;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

async function setPaused(on) {
  if (args.df) {
    await dfhackRun(args.df, ["lua", `df.global.pause_state=${on ? "true" : "false"}`]);
    return true;
  }
  if (args["stub-pause"]) {
    await client.json("GET", `/stub/pause?on=${on ? 1 : 0}`);
    return true;
  }
  return false;
}

(async () => {
  // ---- preflight -----------------------------------------------------------
  if (args.password) await client.auth(args.password).catch((e) => die(e.message));
  const stats0 = await client.json("GET", "/stats").catch((e) => die(`server unreachable: ${e.message}`));
  if (stats0.status !== 200 || !stats0.json || !("players" in stats0.json) || !("uptimeSec" in stats0.json))
    die(`/stats missing or wrong shape (HTTP ${stats0.status}) — is WS0 Task 6 deployed?`);

  let dfPid = null;
  let pauseStateBefore = null;
  if (args.df) {
    dfPid = await findDFPid(args.exe).catch(() => null);
    if (!dfPid) console.warn(`loadtest: WARN no process named "${args.exe}" found; crash guard disabled`);
    try {
      pauseStateBefore = /true/.test(await dfhackRun(args.df, ["lua", "print(df.global.pause_state)"]));
    } catch (e) { console.warn(`loadtest: WARN cannot read pause_state: ${e.message}`); }
  }

  // ---- 0-client host baseline ---------------------------------------------
  let hostBaseline = null;
  if (args.df) {
    console.log("Sampling 0-client host FPS baseline (8s)…");
    hostBaseline = await sampleHostFps(8);
  }

  // ---- spawn players -------------------------------------------------------
  console.log(`Spawning ${N} players against ${args.url} (thresholds: ${args.thresholds})`);
  const players = Array.from({ length: N }, (_, i) => new Player(i + 1));
  await sleep(1500); // let streams connect + first frames land
  for (const p of players) p.mark("activeStart");

  // ---- ACTIVE phase --------------------------------------------------------
  phase = "active";
  const loops = players.map((p) => p.inputLoop());
  const hostLoadPromise = args.df ? sampleHostFps(DURATION_S) : Promise.resolve(null);
  await sleep(DURATION_S * 1000);
  phase = "steady";
  const hostUnderLoad = await hostLoadPromise;
  await Promise.all(loops);
  for (const p of players) p.mark("steadyStart");

  // ---- STEADY phase (no inputs, unpaused) ----------------------------------
  await sleep(STEADY_S * 1000);
  for (const p of players) p.mark("idleStart");

  // ---- IDLE phase (paused) -------------------------------------------------
  let idleMeasured = false;
  phase = "idle";
  try {
    idleMeasured = await setPaused(true);
    if (idleMeasured) await sleep(IDLE_S * 1000);
  } finally {
    if (idleMeasured) {
      await setPaused(args.df ? !!pauseStateBefore : false).catch(() => {});
    }
  }
  for (const p of players) p.mark("idleEnd");
  phase = "done";
  for (const p of players) p.stream.stop();

  // ---- results -------------------------------------------------------------
  const statsEnd = await client.json("GET", "/stats").catch(() => ({ json: null }));
  const rows = players.map((p) => ({
    player: p.name,
    "fps(active)": (p.parts.active / DURATION_S).toFixed(1),
    "lat p50ms": Math.round(pct(p.latencies, 50)) || "-",
    "lat p95ms": Math.round(pct(p.latencies, 95)) || "-",
    "active B/s": Math.round(p.bytesBetween("activeStart", "steadyStart") / DURATION_S),
    "steady B/s": Math.round(p.bytesBetween("steadyStart", "idleStart") / STEADY_S),
    "idle B/s": idleMeasured ? Math.round(p.bytesBetween("idleStart", "idleEnd") / IDLE_S) : "-",
    designates: p.designates,
    "503saving": p.saving503,
    hb: p.hb,
    streamErr: p.streamErr ? String(p.streamErr.message || p.streamErr) : "-",
  }));
  console.log("\n" + fmtTable(rows) + "\n");
  if (hostBaseline !== null && hostUnderLoad !== null) {
    const dropPct = ((hostBaseline - hostUnderLoad) / hostBaseline) * 100;
    console.log(`Host FPS: baseline(0 clients)=${hostBaseline.toFixed(1)}  under ${N}-client load=${hostUnderLoad.toFixed(1)}  delta=${dropPct.toFixed(1)}%`);
  }

  // ---- threshold evaluation ------------------------------------------------
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass, detail });
  const allLat = players.flatMap((p) => p.latencies);
  const minFps = Math.min(...players.map((p) => p.parts.active / DURATION_S));
  const baselineFps = parseFloat(args["baseline-fps"]);

  if (!isNaN(baselineFps) && baselineFps > 0) {
    check(`active fps >= ${T.activeFpsRatioMin}x baseline (${(T.activeFpsRatioMin * baselineFps).toFixed(1)})`,
      minFps >= T.activeFpsRatioMin * baselineFps, `min player fps ${minFps.toFixed(1)}`);
  } else {
    console.warn("loadtest: WARN no --baseline-fps; enforcing absolute floor instead of the spec 1.5x ratio");
    check(`active fps >= ${T.activeFpsAbsMin} (absolute floor)`,
      minFps >= T.activeFpsAbsMin, `min player fps ${minFps.toFixed(1)}`);
  }
  check(`latency p95 < ${T.latencyP95MsMax}ms`,
    allLat.length > 0 && pct(allLat, 95) < T.latencyP95MsMax,
    `p95 ${Math.round(pct(allLat, 95))}ms over ${allLat.length} probes`);
  if (idleMeasured) {
    const worstIdle = Math.max(...players.map((p) => p.bytesBetween("idleStart", "idleEnd") / IDLE_S));
    check(`idle < ${T.idleBytesPerSecMax} B/s/player (paused)`,
      worstIdle < T.idleBytesPerSecMax, `worst ${Math.round(worstIdle)} B/s`);
  } else {
    console.warn("loadtest: WARN idle-bandwidth check SKIPPED (no --df / --stub-pause to pause the game)");
  }
  if (T.steadyBytesPerSecMax !== null) {
    const worstSteady = Math.max(...players.map((p) => p.bytesBetween("steadyStart", "idleStart") / STEADY_S));
    check(`steady <= ${T.steadyBytesPerSecMax} B/s/player (unpaused)`,
      worstSteady <= T.steadyBytesPerSecMax, `worst ${Math.round(worstSteady)} B/s`);
  }
  if (T.hostFpsDropPctMax !== null) {
    if (hostBaseline !== null && hostUnderLoad !== null) {
      const dropPct = ((hostBaseline - hostUnderLoad) / hostBaseline) * 100;
      if (N < 4) console.warn(`loadtest: WARN host-FPS check specified for 4 clients; you ran ${N}`);
      check(`host FPS drop <= ${T.hostFpsDropPctMax}% with ${N} clients`,
        dropPct <= T.hostFpsDropPctMax, `drop ${dropPct.toFixed(1)}%`);
    } else {
      check(`host FPS drop <= ${T.hostFpsDropPctMax}%`, false, "not measured — --df required for ws2 thresholds");
    }
  }
  check("stream integrity (0 errors/disconnects)",
    players.every((p) => !p.streamErr && p.errors.length === 0),
    players.map((p) => p.streamErr || p.errors[0]).filter(Boolean).join("; ") || "clean");
  if (dfPid) check("DF process alive", pidAlive(dfPid), `pid ${dfPid}`);

  let failed = 0;
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  [${c.detail}]`);
    if (!c.pass) failed++;
  }
  console.log("RESULT_JSON: " + JSON.stringify({
    url: args.url, thresholds: args.thresholds, players: N,
    durationS: DURATION_S, rows, hostBaseline, hostUnderLoad,
    checks, serverStats: statsEnd.json, failed,
  }));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("loadtest: fatal:", e); process.exit(2); });
