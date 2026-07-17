// b221_workshopstall_profile.mjs -- LIVE profile for B221 (craftsdwarf workshop_info core stall).
//
//   node tools/harness/b221_workshopstall_profile.mjs --id <craftsdwarfBuildingId> [--host http://localhost:8765] [--n 8]
//
// Requires a RUNNING dwf server (a loaded fort with a built Craftsdwarf's Workshop). This is
// the gate the fix (commit on wave/workshop-stall) must clear BEFORE deploy.
//
// WHY: GET /workshop-info runs under lua_bridge run_lua_locked's full CoreSuspender; for a craftsdwarf
// the Lua scans ALL raws reactions twice + itemdefs on every open, freezing every player past the
// 1500 ms busy watchdog. The fix caches the static native tree per world, so repeat opens skip the scan.
//
// HOW TO FIND A CRAFTSDWARF id: open one in the browser client and read the id from the
// /workshop-info request in devtools/network, or from the panel. Any built Craftsdwarf's Workshop.
//
// PROTOCOL for the orchestrator (before/after, deploy is restart-gated):
//   1. BEFORE (current deployed build):     node ...profile.mjs --id <id>
//        Expect: FIRST and REPEAT opens BOTH high (hundreds-to->1500 ms on a real fort). Record.
//   2. Deploy dwf.lua -> <DF>/hack/lua/plugins/dwf.lua and RESTART the plugin/server
//        (never hot-reload the plugin -- it is restart-gated like the DLL).
//   3. AFTER, as the VERY FIRST craftsdwarf open post-restart (cache cold):
//        node ...profile.mjs --id <id>
//        Expect: FIRST open still pays one raws scan; REPEAT opens collapse to well under 1500 ms
//        (typically a few ms -- pure item-availability pass). That gap IS the cache working.
//   VERDICT: PASS when repeat-open median < 1500 ms (target: << that). The busy banner must not fire
//   on repeat opens. If FIRST open alone still trips 1500 ms on a huge fort, flag it -- a follow-up
//   could move the one-time build to world-load, but repeat opens (the reported symptom) are fixed.

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const HOST = opt("--host", "http://localhost:8765").replace(/\/$/, "");
const ID = opt("--id", null);
const N = parseInt(opt("--n", "8"), 10);
const THRESHOLD_MS = 1500;

if (!ID) { console.error("ERROR: --id <craftsdwarfBuildingId> is required."); process.exit(2); }

async function timeGet(pathname) {
  const t0 = performance.now();
  const res = await fetch(`${HOST}${pathname}`, { cache: "no-store" });
  const body = await res.text();               // fully drain so timing covers serialize+transfer
  const ms = performance.now() - t0;
  let ok = false;
  try { ok = JSON.parse(body).ok === true; } catch (_) {}
  return { ms, status: res.status, ok };
}
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

(async () => {
  try {
    const h = await fetch(`${HOST}/health`);
    if (!h.ok) throw new Error(`/health ${h.status}`);
  } catch (e) {
    console.error(`CANNOT RUN - no server at ${HOST} (${e.message}). Start a fort with a craftsdwarf.`);
    process.exit(3);
  }

  const route = `/workshop-info?id=${encodeURIComponent(ID)}`;
  const first = await timeGet(route);
  if (!first.ok) {
    console.error(`ERROR: ${route} did not return ok:true (status ${first.status}). Is id=${ID} a built workshop?`);
    process.exit(2);
  }
  const repeats = [];
  for (let i = 0; i < N; i++) repeats.push((await timeGet(route)).ms);

  const rMed = median(repeats), rMin = Math.min(...repeats), rMax = Math.max(...repeats);
  console.log(`# B221 live profile  host=${HOST}  id=${ID}  n=${N}`);
  console.log(`  first open   : ${first.ms.toFixed(1)} ms`);
  console.log(`  repeat opens : median ${rMed.toFixed(1)} ms  (min ${rMin.toFixed(1)}, max ${rMax.toFixed(1)})`);
  const pass = rMed < THRESHOLD_MS;
  console.log(`  verdict      : ${pass ? "PASS" : "FAIL"} (repeat median < ${THRESHOLD_MS} ms busy watchdog)`);
  if (first.ms >= THRESHOLD_MS) console.log(`  note         : FIRST open >= ${THRESHOLD_MS} ms -- the one-time raws build; only relevant on the very first open after a restart.`);
  process.exit(pass ? 0 : 1);
})();
