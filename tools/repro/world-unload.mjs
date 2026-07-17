// tools/repro/world-unload.mjs — WS5 crash repro: keep 4 clients streaming and
// panning while the host exits to title, then reloads a fort. Verifies the
// WS0 Task 5 unload hygiene (no crash, no stale-fort frames, clean resume).
// OPERATOR-ASSISTED: prompts for the exit-to-title / reload steps and detects
// them via dfhack.isMapLoaded(); requires no keyboard input to this script.
// Part of Dwarf With Friends (dwf). License: AGPL-3.0-only. Node >= 18, zero external deps.
//
// Usage: node tools/repro/world-unload.mjs --df "C:\...\Dwarf Fortress"
//          [--url http://127.0.0.1:8765] [--players 4] [--password pw] [--exe "Dwarf Fortress.exe"]

import {
  HttpClient, openStream, sleep, parseArgs, findDFPid, pidAlive, mapLoaded,
} from "../lib/mdutil.mjs";

const args = parseArgs(process.argv.slice(2), {
  url: "http://127.0.0.1:8765", df: "", players: "4",
  password: "", exe: "Dwarf Fortress.exe",
});
if (!args.df) {
  console.error("usage: node tools/repro/world-unload.mjs --df <DF dir> [--url ...] [--players 4]");
  process.exit(2);
}
const N = parseInt(args.players, 10);
const client = new HttpClient(args.url);

async function waitFor(cond, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await cond()) return true; } catch (_) { /* DF busy */ }
    await sleep(2000);
  }
  console.error(`repro: timeout waiting for ${label}`);
  return false;
}

(async () => {
  if (args.password) await client.auth(args.password);
  const pid = await findDFPid(args.exe);
  if (!pid) { console.error(`repro: no "${args.exe}" process`); process.exit(2); }
  if (!(await mapLoaded(args.df))) { console.error("repro: no fort loaded — load one first"); process.exit(2); }

  let unloadedAt = 0;
  let staleFrames = 0;
  const streams = [];
  let panOn = true;
  for (let i = 1; i <= N; i++) {
    const name = `repro-unload-${i}`;
    const s = { name, frames: 0, err: null };
    s.handle = openStream(client, name, (part) => {
      if (part.heartbeat) return;
      s.frames++;
      // Any image frame delivered AFTER the world unloaded is stale-fort leakage.
      if (unloadedAt && part.tRecv > unloadedAt + 2000) staleFrames++;
    }, (err) => { s.err = err; });
    streams.push(s);
    // background pan loop per player
    (async () => {
      while (panOn) {
        await client.json("POST", `/camera?player=${name}&dx=${i}&dy=-1`).catch(() => {});
        await sleep(400);
      }
    })();
  }
  await sleep(3000);
  if (!streams.every((s) => s.frames > 0)) {
    console.error("repro: not all streams delivered a first frame — aborting (server not ready?)");
    process.exit(2);
  }
  console.log(`\n>>> OPERATOR: in DF, ESC -> "Save and exit to title". Watching (up to 300s)...\n`);
  if (!(await waitFor(async () => !(await mapLoaded(args.df)), 300000, "world unload"))) process.exit(2);
  unloadedAt = Date.now();
  console.log("world unloaded; holding connections 10s...");
  panOn = false;
  await sleep(10000);

  if (!pidAlive(pid)) { console.error("FAIL: DF crashed during/after unload"); process.exit(1); }
  const st = await client.json("GET", "/stats", { timeoutMs: 15000 }).catch(() => null);
  if (!st || st.status !== 200) { console.error("FAIL: server unresponsive after unload"); process.exit(1); }
  if (staleFrames > 0) { console.error(`FAIL: ${staleFrames} stale-fort frames streamed after unload (WS0 Task 5 hygiene)`); process.exit(1); }

  console.log(`\n>>> OPERATOR: load any fort now. Watching (up to 600s)...\n`);
  if (!(await waitFor(() => mapLoaded(args.df), 600000, "world reload"))) process.exit(2);
  await sleep(3000);

  // Fresh client must stream frames from the NEW world.
  let postFrames = 0;
  const post = openStream(client, "repro-postload", (p) => { if (!p.heartbeat) postFrames++; }, () => {});
  await client.json("POST", "/camera?player=repro-postload&dx=2&dy=2").catch(() => {});
  await sleep(8000);
  post.stop();
  for (const s of streams) s.handle.stop();

  if (!pidAlive(pid)) { console.error("FAIL: DF crashed after reload"); process.exit(1); }
  if (postFrames === 0) { console.error("FAIL: no frames streamed after reload"); process.exit(1); }
  console.log(`PASS world-unload: pid ${pid} alive, 0 stale frames, ${postFrames} post-reload frames`);
  process.exit(0);
})().catch((e) => { console.error("repro: fatal:", e); process.exit(2); });
