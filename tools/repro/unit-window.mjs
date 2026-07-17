// tools/repro/unit-window.mjs — WS5 crash repro: host has a unit's native
// sheet open (driven via view_sheets, same recipe as src/unit_portrait.cpp)
// while two remote players hammer /unit for the SAME unit. Zero crashes and
// >=90% HTTP 200 over the run = pass. /unit-portrait only with --portraits
// (portraits are a known-crashy surface kept OFF by default, spec section 4).
// Part of Dwarf With Friends (dwf). License: AGPL-3.0-only. Node >= 18, zero external deps.
//
// Usage: node tools/repro/unit-window.mjs --df "C:\...\Dwarf Fortress"
//          [--url http://127.0.0.1:8765] [--duration 60] [--portraits] [--password pw]

import {
  HttpClient, sleep, parseArgs, dfhackRun, findDFPid, pidAlive, mapLoaded,
} from "../lib/mdutil.mjs";

const args = parseArgs(process.argv.slice(2), {
  url: "http://127.0.0.1:8765", df: "", duration: "60",
  password: "", exe: "Dwarf Fortress.exe", portraits: false,
});
if (!args.df) {
  console.error("usage: node tools/repro/unit-window.mjs --df <DF dir> [--duration 60] [--portraits]");
  process.exit(2);
}
const DURATION_S = parseInt(args.duration, 10);
const client = new HttpClient(args.url);

const PICK_UNIT_LUA =
  "local us=dfhack.units.getCitizens and dfhack.units.getCitizens(true) or {};" +
  "local u=us[1] or df.global.world.units.active[0];" +
  "print(u and u.id or -1)";

// Mirrors src/unit_portrait.cpp:693-709 field-for-field.
const openSheetLua = (id) =>
  "local vs=df.global.game.main_interface.view_sheets;" +
  `local u=df.unit.find(${id});` +
  "vs.open=true;" +
  "vs.context=df.view_sheets_context_type.REGULAR_PLAY;" +
  "vs.active_sheet=df.view_sheet_type.UNIT;" +
  "vs.active_id=u.id;" +
  "vs.viewing_unid:resize(0);vs.viewing_unid:insert('#',u.id);" +
  "vs.viewing_itid:resize(0);vs.viewing_bldid=-1;" +
  "vs.viewing_x=u.pos.x;vs.viewing_y=u.pos.y;vs.viewing_z=u.pos.z;" +
  "vs.scroll_position=0;vs.scrolling=false;vs.active_sub_tab=0;vs.last_tick_update=0;" +
  "print('sheet-open '..u.id)";
const CLOSE_SHEET_LUA =
  "df.global.game.main_interface.view_sheets.open=false;print('sheet-closed')";

(async () => {
  if (args.password) await client.auth(args.password);
  const pid = await findDFPid(args.exe);
  if (!pid) { console.error(`repro: no "${args.exe}" process`); process.exit(2); }
  if (!(await mapLoaded(args.df))) { console.error("repro: no fort loaded"); process.exit(2); }

  const idOut = await dfhackRun(args.df, ["lua", PICK_UNIT_LUA]);
  const unitId = parseInt(idOut.match(/-?\d+/)?.[0] ?? "-1", 10);
  if (unitId < 0) { console.error("repro: no unit found on map"); process.exit(2); }
  console.log(`unit-window: DF pid ${pid}, unit id ${unitId}, ${DURATION_S}s, portraits=${!!args.portraits}`);

  const opened = await dfhackRun(args.df, ["lua", openSheetLua(unitId)]);
  if (!opened.includes("sheet-open")) { console.error(`repro: could not open native sheet: ${opened}`); process.exit(2); }

  let ok = 0, bad = 0;
  let running = true;
  const hammer = (name) => (async () => {
    while (running) {
      const r = await client.json("GET", `/unit?player=${name}&id=${unitId}`, { timeoutMs: 10000 })
        .catch(() => ({ status: 0 }));
      if (r.status === 200) ok++; else bad++;
      if (args.portraits) {
        const p = await client.request("GET", `/unit-portrait?player=${name}&id=${unitId}`, { timeoutMs: 10000 })
          .catch(() => ({ status: 0 }));
        if (p.status === 200) ok++; else bad++;
      }
      await sleep(200); // ~5 Hz per worker
    }
  })();
  const workers = [hammer("repro-unit-a"), hammer("repro-unit-b")];

  const t0 = Date.now();
  let crashed = false;
  while (Date.now() - t0 < DURATION_S * 1000) {
    await sleep(5000);
    if (!pidAlive(pid)) { crashed = true; break; }
    // Re-assert the sheet (DF or the host may close it as the game runs).
    await dfhackRun(args.df, ["lua", openSheetLua(unitId)]).catch(() => {});
  }
  running = false;
  await Promise.all(workers);
  await dfhackRun(args.df, ["lua", CLOSE_SHEET_LUA]).catch(() => {});

  if (crashed || !pidAlive(pid)) { console.error(`FAIL: DF crashed (ok=${ok} bad=${bad})`); process.exit(1); }
  const okPct = ok + bad === 0 ? 0 : (100 * ok) / (ok + bad);
  if (okPct < 90) { console.error(`FAIL: only ${okPct.toFixed(1)}% of ${ok + bad} requests succeeded`); process.exit(1); }
  console.log(`PASS unit-window: pid ${pid} alive, ${ok}/${ok + bad} requests OK (${okPct.toFixed(1)}%)`);
  process.exit(0);
})().catch((e) => { console.error("repro: fatal:", e); process.exit(2); });
