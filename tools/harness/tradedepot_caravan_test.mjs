// tradedepot_caravan_test.mjs -- DEPLOY-GATED (+ partly CARAVAN-GATED) oracle-differential
// acceptance for the W-F trade/depot skeleton. Every mutation is issued over the LIVE plugin
// HTTP server, then READ BACK via dfhack-run lua against the actual df structures and asserted
// EXACT -- the MECHANISM (real struct writes / real jobs) is verified, not the JSON echo
// (completeness rule 2). Seeded-bad cases (rule 3) confirm the oracle discriminates.
//
// Run AFTER the trade_depot DLL is deployed + a fort with a BUILT trade depot is loaded:
//   node tools/harness/tradedepot_caravan_test.mjs   [--host http://localhost:8765]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN (server unreachable / dfhack-run missing / no depot).
//
// SECTIONS:
//   * D (broker/flags) + C (mark goods) run with NO caravan -- deploy-gated only.
//   * B (caravan roster) + E (trade session) are CARAVAN-GATED: they SKIP (reported, not
//     failed) with an explicit [NOT-VERIFIED: caravan-gated] line + this exact re-run command
//     when no active caravan is on the map. Re-run the moment a caravan arrives.
//
// dfhack-run inline `lua <code>` chokes on multi-statement chunks; write to an ABSOLUTE temp
// file and run with `-f` (CP437 stdout, but every value printed here is ASCII bool/number).

import process from "node:process";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireLiveOptIn } from "./live_guard.mjs";

import { defaultDfhackRun } from "../lib/dfroot.mjs";   // W1: resolved, never hardcoded
const argHost = (() => {
  const i = process.argv.indexOf("--host");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "http://localhost:8765";
})();
const BASE = argHost.replace(/\/+$/, "");

// B242: a live oracle must be asked for on purpose -- port 8765 may be a fort someone is playing.
requireLiveOptIn("tradedepot_caravan_test.mjs", BASE);
const DFHACK_RUN = defaultDfhackRun();

let failed = 0, passed = 0, skipped = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function checkSeededBad(name, cond) {
  if (!cond) { passed++; console.log(`  ok - (test-the-test) ${name} -> correctly detected`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name} -> oracle did NOT discriminate`); }
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}
async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: "POST" });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

let _seq = 0;
function lua(code) {
  const tmp = join(tmpdir(), `tradedepot_lua_${process.pid}_${_seq++}.lua`);
  writeFileSync(tmp, code, "utf8");
  return execFileSync(DFHACK_RUN, ["lua", "-f", tmp], { encoding: "utf8" }).trim();
}
// Boolean expr with the depot building (B) + utils in scope.
function luaBool(id, expr) {
  return lua(`local utils=require('utils') local B=df.building.find(${id}) print(${expr})`) === "true";
}
function luaNum(id, expr) {
  return Number(lua(`local utils=require('utils') local B=df.building.find(${id}) print(${expr})`));
}
// True iff any BringItemToDepot job references item_id.
function hasBringJob(itemId) {
  return lua(`local utils=require('utils') local id=${itemId} local f=false ` +
    `for _,j in utils.listpairs(df.global.world.jobs.list) do ` +
    `if j.job_type==df.job_type.BringItemToDepot then ` +
    `for _,ir in ipairs(j.items) do if ir.item and ir.item.id==id then f=true end end end end print(f)`) === "true";
}

(async () => {
  // Preconditions.
  try {
    const h = await fetch(`${BASE}/health`);
    if (!h.ok) throw new Error(`/health ${h.status}`);
  } catch (e) {
    console.log(`CANNOT RUN - server unreachable at ${BASE} (${e.message}). Deploy + load a fort first.`);
    process.exit(2);
  }
  try {
    if (lua("print(df.global.world ~= nil)") !== "true") throw new Error("world nil");
  } catch (e) {
    console.log(`CANNOT RUN - dfhack-run lua unavailable (${e.message}).`);
    process.exit(2);
  }

  // Find a BUILT trade depot.
  const depotId = Number(lua(
    "local id=-1 for _,d in ipairs(df.global.world.buildings.other.TRADE_DEPOT) do " +
    "if d:getBuildStage()>=d:getMaxBuildStage() then id=d.id break end end print(id)"));
  if (!Number.isFinite(depotId) || depotId < 0) {
    console.log("CANNOT RUN - no BUILT trade depot on the map. Build one, then re-run.");
    process.exit(2);
  }
  console.log(`(using trade depot building ${depotId})`);

  // /depot-info reachable.
  const info0 = await get(`/depot-info?id=${depotId}`);
  check("depot-info returns ok+isDepot", info0.status === 200 && info0.data && info0.data.isDepot === true,
    JSON.stringify(info0.data));
  check("depot-info id matches", info0.data && info0.data.id === depotId);
  check("depot-info live wagon accessibility is boolean",
    info0.data && typeof info0.data.accessible === "boolean");
  check("depot-info storedAccessible matches caravan-maintained DF field",
    !!(info0.data && info0.data.storedAccessible) === luaBool(depotId, "B.accessible"));
  check("non-depot id -> 400", (await get(`/depot-info?id=999999`)).status === 400);

  // ===================== D: broker / flags (no caravan needed) =====================
  console.log("TEST: D -- broker request + flags");
  const req0 = luaBool(depotId, "B.trade_flags.trader_requested");
  await post(`/depot-broker?id=${depotId}&request=1`);
  check("D1 trader_requested set (lua)", luaBool(depotId, "B.trade_flags.trader_requested") === true);
  check("D1 depot-info reflects traderRequested", (await get(`/depot-info?id=${depotId}`)).data.traderRequested === true);
  await post(`/depot-broker?id=${depotId}&request=0`);
  check("D2 trader_requested cleared (lua)", luaBool(depotId, "B.trade_flags.trader_requested") === false);
  check("D2 no TradeAtDepot job remains", luaNum(depotId,
    "(function() local n=0 for _,j in ipairs(B.jobs) do if j.job_type==df.job_type.TradeAtDepot then n=n+1 end end return n end)()") === 0);

  const any0 = luaBool(depotId, "B.trade_flags.anyone_can_trade");
  await post(`/depot-broker?id=${depotId}&anyone=${any0 ? 0 : 1}`);
  check("D3 anyone_can_trade toggled (lua)", luaBool(depotId, "B.trade_flags.anyone_can_trade") === !any0);
  await post(`/depot-broker?id=${depotId}&anyone=${any0 ? 1 : 0}`);   // restore
  check("D3 anyone_can_trade restored", luaBool(depotId, "B.trade_flags.anyone_can_trade") === any0);

  check("D4/D5 broker block present", info0.data && typeof info0.data.broker === "object" && "found" in info0.data.broker);

  // D seeded-bad: after clearing, trader_requested is NOT true.
  checkSeededBad("D2 trader_requested is (wrongly) still set", luaBool(depotId, "B.trade_flags.trader_requested") === true);

  // ===================== C: mark goods for trade =====================
  // HARDENED TWICE after the window-#3 C1 live failure (item 458):
  // (1) the fort is LIVE, so a candidate can be grabbed by another job between the goods fetch
  //     and the mark POST -- markForTrade's only item-level failure is in_job
  //     (Job::attachJobItem, dfhack Job.cpp). So: lua-verify in_job==false pre-mark, CHECK the
  //     mark response, classify in_job-at-failure as a RACE, retry next candidate (<=5).
  // (2) ROOT CAUSE of the window-#3 red row (diagnosed live 07-08): DF SILENTLY CULLS
  //     BringItemToDepot jobs when no caravan trade window is open (no non-tribute caravan with
  //     time_remaining>0 Approaching/AtDepot) -- observed: mark ok:true + job present, then gone
  //     <1s later w/ in_job cleanly reset, no announcement; with a window open the same job
  //     persisted 15s+. Natively move-goods only exists while a caravan is around. So JOB
  //     PERSISTENCE is CARAVAN-GATED: mark-ok + instant-cull + no-window => honest SKIP, and
  //     only mark-ok + job-absent WITH a window open is a real bug.
  console.log("TEST: C -- mark / unmark goods (BringItemToDepot)");
  const hasTradeWindow = () => lua(
    "local ok=false for _,c in ipairs(df.global.plotinfo.caravans) do " +
    "if not c.flags.tribute and c.time_remaining>0 and " +
    "(c.trade_state==df.caravan_state.T_trade_state.Approaching or c.trade_state==df.caravan_state.T_trade_state.AtDepot) " +
    "then ok=true end end print(ok)") === "true";
  const goods = await get(`/depot-goods?id=${depotId}`);
  check("depot-goods returns ok+array", goods.status === 200 && goods.data && Array.isArray(goods.data.goods));
  const itemInJob = (id) =>
    lua(`local it=df.item.find(${id}) print(it and tostring(it.flags.in_job) or "gone")`);
  const candidates = (goods.data && goods.data.goods || [])
    .filter(g => g && !g.pending && !g.atDepot && g.id >= 0).slice(0, 5);
  if (!candidates.length) {
    console.log("  SKIP C mark tests - no un-marked reachable tradeable item found " +
      "(a fort with some loose goods near the depot is needed). [NOT-VERIFIED: precondition gap]");
    skipped += 4;
  } else {
    let done = false, races = 0;
    for (const target of candidates) {
      const pre = itemInJob(target.id);
      if (pre !== "false") {   // grabbed since the goods fetch (or gone) -> race, next candidate
        races++; console.log(`  (race) item ${target.id} in_job=${pre} before mark -- trying next candidate`);
        continue;
      }
      check("C0 target item has NO BringItemToDepot job yet", hasBringJob(target.id) === false, `item=${target.id}`);
      const mr = await post(`/depot-mark?id=${depotId}&item=${target.id}&on=1`);
      if (!(mr.status === 200 && mr.data && mr.data.ok === true)) {
        const postFlag = itemInJob(target.id);
        if (postFlag === "true") {  // lost the race exactly at mark time -> retry
          races++; console.log(`  (race) mark of ${target.id} failed w/ in_job=true (status ${mr.status}) -- trying next candidate`);
          continue;
        }
        check("C1 mark request accepted", false,
          `status=${mr.status} body=${JSON.stringify(mr.data)} in_job=${postFlag} item=${target.id} <- route bug, item was lua-verified free`);
        done = true; break;
      }
      const jobPresent = hasBringJob(target.id);
      if (!jobPresent && !hasTradeWindow()) {
        // DF culled the just-created job because no caravan window is open (see banner). The
        // MARK mechanism itself succeeded (route ok:true = markForTrade created the job);
        // persistence needs a caravan. Unmark for hygiene (noop if already culled).
        await post(`/depot-mark?id=${depotId}&item=${target.id}&on=0`);
        console.log("  SKIP C1/C3 persistence - mark accepted (ok:true) but DF culled the job: " +
          "no caravan trade window open. [NOT-VERIFIED: caravan-gated] Re-run with an active caravan:\n" +
          `    node tools/harness/tradedepot_caravan_test.mjs --host ${BASE}`);
        skipped += 3;
        done = true; break;
      }
      check("C1 mark -> BringItemToDepot job now references the item", jobPresent === true,
        `item=${target.id} (trade window open -> a missing job here IS a route bug)`);
      const ur = await post(`/depot-mark?id=${depotId}&item=${target.id}&on=0`);
      check("C3 unmark accepted + job removed", ur.status === 200 && hasBringJob(target.id) === false, `item=${target.id}`);
      // seeded-bad: after unmark, the job is NOT present.
      checkSeededBad("C3 BringItemToDepot job is (wrongly) still present", hasBringJob(target.id) === true);
      done = true; break;
    }
    if (!done) {
      console.log(`  SKIP C mark tests - all ${candidates.length} candidates were racing with live fort jobs ` +
        `(${races} races). Re-run when the haulers calm down. [NOT-VERIFIED: live-race precondition]`);
      skipped += 4;
    }
  }

  // ===================== B + E: caravan-gated =====================
  console.log("TEST: B/E -- caravan roster + trade session (caravan-gated)");
  const nCaravans = luaNum(depotId, "#df.global.plotinfo.caravans");
  const infoNow = await get(`/depot-info?id=${depotId}`);
  check("B: depot-info caravans[] length matches plotinfo.caravans", Array.isArray(infoNow.data.caravans) &&
    infoNow.data.caravans.length === nCaravans, `json=${infoNow.data.caravans && infoNow.data.caravans.length} lua=${nCaravans}`);

  const hasActive = luaBool(depotId,
    "(function() for _,c in ipairs(df.global.plotinfo.caravans) do " +
    "if not c.flags.tribute and c.time_remaining>0 and " +
    "(c.trade_state==df.caravan_state.T_trade_state.Approaching or c.trade_state==df.caravan_state.T_trade_state.AtDepot) " +
    "then return true end end return false end)()");
  if (!hasActive) {
    console.log("  SKIP B2-B8/E2 - no ACTIVE caravan on the map. " +
      "[NOT-VERIFIED: caravan-gated] Re-run when one arrives:\n" +
      `    node tools/harness/tradedepot_caravan_test.mjs --host ${BASE}`);
    skipped += 5;
  } else {
    check("B: hasActiveCaravan true", infoNow.data.hasActiveCaravan === true);
    const active = (infoNow.data.caravans || []).find(c => c.active);
    check("B2/B3 an active caravan row exists w/ state", active && typeof active.state === "string");
    check("B7 active caravan has an origin string", active && typeof active.origin === "string" && active.origin.length > 0);
    check("B8 daysRemaining matches lua (first active)", active &&
      Number(active.daysRemaining) === luaNum(depotId,
        "(function() for _,c in ipairs(df.global.plotinfo.caravans) do " +
        "if not c.flags.tribute and c.time_remaining>0 and " +
        "(c.trade_state==df.caravan_state.T_trade_state.Approaching or c.trade_state==df.caravan_state.T_trade_state.AtDepot) " +
        "then return math.floor(c.time_remaining/120) end end return -1 end)()"));
    const ts = await get(`/depot-trade-status?id=${depotId}`);
    check("E1/E2 trade-status open flag matches game.main_interface.trade.open", ts.data &&
      !!ts.data.tradeScreenOpen === (lua("print(df.global.game.main_interface.trade.open)") === "true"));
  }

  // /depot-trade is host-only.
  check("E3 /depot-trade returns 501 host-native", (await post(`/depot-trade?id=${depotId}&action=trade`)).status === 501);

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${passed} ok, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
})();
