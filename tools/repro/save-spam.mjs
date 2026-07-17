// tools/repro/save-spam.mjs — WS5 crash repro: force-save while spamming
// /designate, 20 cycles. Reproduces the interact-during-save crash the WS0
// save-gate fixes; post-fix it must run crash-free (spec §6-WS0 acceptance).
// Part of Dwarf With Friends (dwf). License: AGPL-3.0-only. Node >= 18, zero external deps.
//
// Usage: node tools/repro/save-spam.mjs --df "C:\...\Dwarf Fortress"
//          [--url http://127.0.0.1:8765] [--cycles 20] [--password pw] [--exe "Dwarf Fortress.exe"]

import {
  HttpClient, sleep, parseArgs, dfhackRun, findDFPid, pidAlive, mapLoaded,
} from "../lib/mdutil.mjs";

const args = parseArgs(process.argv.slice(2), {
  url: "http://127.0.0.1:8765", df: "", cycles: "20",
  password: "", exe: "Dwarf Fortress.exe",
});
if (!args.df) {
  console.error("usage: node tools/repro/save-spam.mjs --df <DF dir> [--url ...] [--cycles 20]");
  process.exit(2);
}
const CYCLES = parseInt(args.cycles, 10);
const client = new HttpClient(args.url);

async function saveInProgress() {
  const out = await dfhackRun(args.df,
    ["lua", "print(df.global.plotinfo.main.autosave_request)"], { timeoutMs: 20000 });
  return /true/.test(out);
}

(async () => {
  if (args.password) await client.auth(args.password);
  const pid = await findDFPid(args.exe);
  if (!pid) { console.error(`repro: no "${args.exe}" process found`); process.exit(2); }
  if (!(await mapLoaded(args.df))) { console.error("repro: no fort loaded"); process.exit(2); }
  const st = await client.json("GET", "/stats");
  if (st.status !== 200) { console.error(`repro: /stats HTTP ${st.status}`); process.exit(2); }
  console.log(`save-spam: DF pid ${pid}, ${CYCLES} cycles, server ${args.url}`);

  let totalDesignates = 0, total503 = 0, totalBlocked = 0;

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    let spamOn = true;
    const spam = (async () => {
      while (spamOn) {
        const base = `player=repro-savespam&px=200&py=200&px2=230&py2=230&w=1280&h=720`;
        try {
          const r = await client.json("GET", `/designate?${base}&tool=dig&marker=1`, { timeoutMs: 10000 });
          if (r.status === 503 && r.json && r.json.saving) total503++;
          else if (r.status === 200) {
            totalDesignates++;
            await client.json("GET", `/designate?${base}&tool=erase`, { timeoutMs: 10000 })
              .catch(() => { totalBlocked++; });
          }
        } catch (_) { totalBlocked++; } // request blocked during save = expected
        await sleep(50); // 20 Hz
      }
    })();

    await dfhackRun(args.df, ["quicksave"], { timeoutMs: 30000 });

    // Wait for the save to finish: autosave_request goes false (quicksave.lua
    // sets it true; DF clears it when done). Timeout 120s; lua probes may
    // themselves block while DF saves — tolerate individual probe failures.
    const t0 = Date.now();
    let saving = true;
    while (saving && Date.now() - t0 < 120000) {
      await sleep(1000);
      try { saving = await saveInProgress(); } catch (_) { /* DF busy saving */ }
    }
    spamOn = false;
    await spam;
    if (saving) {
      console.error(`cycle ${cycle}: FAIL — save did not complete within 120s (hang?)`);
      process.exit(1);
    }
    await sleep(500);

    if (!pidAlive(pid)) {
      console.error(`cycle ${cycle}: FAIL — DF process ${pid} died (CRASH)`);
      process.exit(1);
    }
    const post = await client.json("GET", "/stats", { timeoutMs: 30000 }).catch(() => null);
    if (!post || post.status !== 200) {
      console.error(`cycle ${cycle}: FAIL — server unresponsive after save`);
      process.exit(1);
    }
    console.log(`cycle ${cycle}/${CYCLES}: OK (designates=${totalDesignates} 503saving=${total503} blocked=${totalBlocked})`);
  }

  if (total503 === 0)
    console.warn("save-spam: WARN zero 503 {saving:true} responses seen — save-gate never engaged (saves too fast, or gate missing?)");
  console.log(`PASS save-spam: ${CYCLES}/${CYCLES} cycles, zero crashes, DF pid ${pid} alive`);
  process.exit(0);
})().catch((e) => { console.error("repro: fatal:", e); process.exit(2); });
