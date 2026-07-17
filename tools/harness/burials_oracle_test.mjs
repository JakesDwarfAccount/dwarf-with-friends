// burials_oracle_test.mjs -- DEPLOY-GATED oracle-differential acceptance for Phase 5 burial/memorial.
//
// LIVE / DF-INTERRUPTING -- run BY EXPLICIT NAME ONLY, never via a tools/harness/*.mjs glob, and
// only inside a deploy/test window (DF_LOCK + live-warning header). Requires the DLL that ships
// /burial-coffin, /burial-coffin-action, and /memorial-slab, plus a loaded fort with a built coffin,
// one living citizen, and preferably one dead own-group unit.
//   node tools/harness/burials_oracle_test.mjs --i-understand-live-mutation [--host http://localhost:8765]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN.
//
// SIDE EFFECTS: temporarily creates/restores a memorial manager order for one dead unit when present,
// and temporarily changes one coffin tomb owner/automatic-burial flags, restoring the baseline.

import process from "node:process";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireLiveOptIn } from "./live_guard.mjs";

import { defaultDfhackRun } from "../lib/dfroot.mjs";   // W1: resolved, never hardcoded
const argHost = (() => { const i = process.argv.indexOf("--host"); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "http://localhost:8765"; })();
const BASE = argHost.replace(/\/+$/, "");

// B242: a live oracle must be asked for on purpose -- port 8765 may be a fort someone is playing.
// This comes FIRST so an offline sweep gets a clean SKIP (exit 0) rather than the mutation guard's
// exit 2, which read as a red suite forever. The mutation guard below is the SECOND lock: --live
// says "yes, talk to a host", --i-understand-live-mutation says "yes, and WRITE to that host".
requireLiveOptIn("burials_oracle_test.mjs", BASE);

if (!process.argv.includes("--i-understand-live-mutation")) {
  console.log("CANNOT RUN - live mutation guard missing. Re-run with --i-understand-live-mutation inside a deploy/test window.");
  process.exit(2);
}
const DFHACK_RUN = (() => { const i = process.argv.indexOf("--dfhack-run"); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : defaultDfhackRun(); })();

let failed = 0, passed = 0, skipped = 0, seq = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log(`  ok - ${name}`); } else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); } }
function guard(name, cond) { if (!cond) { passed++; console.log(`  ok - (test-the-test) ${name} -> correctly detected as wrong`); } else { failed++; console.log(`  FAIL - (test-the-test) ${name} -> oracle did NOT discriminate`); } }
function skip(name, why) { skipped++; console.log(`  SKIP - ${name} (${why})`); }
function lua(code) { const tmp = join(tmpdir(), `burials_lua_${process.pid}_${seq++}.lua`); writeFileSync(tmp, code, "utf8"); return execFileSync(DFHACK_RUN, ["lua", "-f", tmp], { encoding: "utf8" }).trim(); }
const HEADERS = { Cookie: "dfcap_auth=123" };
async function post(path) { const res = await fetch(`${BASE}${path}`, { method: "POST", headers: HEADERS }); let data = null; try { data = await res.json(); } catch (_) {} return { status: res.status, data }; }
async function get(path) { const res = await fetch(`${BASE}${path}`, { cache: "no-store", headers: HEADERS }); let data = null; try { data = await res.json(); } catch (_) {} return { status: res.status, data }; }

const fixtureLua = `
local function first_built_coffin()
  for _, b in ipairs(df.global.world.buildings.other.COFFIN) do
    if b:getBuildStage() >= b:getMaxBuildStage() then return b.id end
  end
  return -1
end
local function living_citizen()
  for _, u in ipairs(df.global.world.units.all) do
    if dfhack.units.isOwnGroup(u) and dfhack.units.isAlive(u) then return u.id end
  end
  return -1
end
local function dead_own()
  for _, u in ipairs(df.global.world.units.all) do
    if dfhack.units.isOwnGroup(u) and not dfhack.units.isAlive(u) and u.hist_figure_id >= 0 then return u.id end
  end
  return -1
end
print(first_built_coffin() .. ',' .. living_citizen() .. ',' .. dead_own())`;
const readCoffinLua = id => `
local c=df.building.find(${id})
local t=nil
if c then for _,z in ipairs(c.relations) do if df.building_civzonest:is_instance(z) and z.type==df.civzone_type.Tomb then t=z end end end
if not t then print('none') else print(t.id .. ',' .. tostring(t.assigned_unit_id or -1) .. ',' .. tostring(t.zone_settings.tomb.flags.no_citizens) .. ',' .. tostring(t.zone_settings.tomb.flags.no_pets)) end`;
const setCoffinLua = (coffinId, tombId, owner, noCit, noPet) => `
local t=df.building.find(${tombId})
if t then t.assigned_unit_id=${owner}; t.owner_unit_cached_index=-1; t.zone_settings.tomb.flags.no_citizens=${noCit}; t.zone_settings.tomb.flags.no_pets=${noPet} end
print('ok')`;
const orderCountLua = unitId => `
local u=df.unit.find(${unitId}); local h=u and u.hist_figure_id or -1; local n=0
for _,o in ipairs(df.global.world.manager_orders.all) do if o.job_type==df.job_type.EngraveSlab and o.specdata.hist_figure_id==h then n=n+1 end end
print(n)`;
const removeOrderLua = unitId => `
local u=df.unit.find(${unitId}); local h=u and u.hist_figure_id or -1
for i=#df.global.world.manager_orders.all-1,0,-1 do local o=df.global.world.manager_orders.all[i]; if o.job_type==df.job_type.EngraveSlab and o.specdata.hist_figure_id==h then df.global.world.manager_orders.all:erase(i); pcall(function() o:delete() end) end end
print('ok')`;

(async () => {
  try { const h = await fetch(`${BASE}/health`); if (!h.ok) throw new Error(`/health ${h.status}`); } catch (e) { console.log(`CANNOT RUN - server unreachable at ${BASE} (${e.message}).`); process.exit(2); }
  try { if (lua("print(df.global.world ~= nil)") !== "true") throw new Error("world nil"); } catch (e) { console.log(`CANNOT RUN - dfhack-run lua unavailable at ${DFHACK_RUN} (${e.message}).`); process.exit(2); }
  const probe = await get("/burial-coffin?id=-1");
  if (probe.status === 404) { console.log("CANNOT RUN - deployed DLL has no burial routes."); process.exit(2); }

  const [coffinId, livingId, deadId] = lua(fixtureLua).split(",").map(Number);
  if (coffinId < 0 || livingId < 0) { console.log(`CANNOT RUN - needs built coffin and living citizen; got coffin=${coffinId} living=${livingId}.`); process.exit(2); }

  console.log("MATRIX: coffin tomb ensure + any-citizen clears owner");
  let r = await post(`/burial-coffin-action?id=${coffinId}&action=ensure-tomb`);
  check("ensure tomb: HTTP 200", r.status === 200, `status=${r.status}`);
  const baseline = lua(readCoffinLua(coffinId));
  check("ensure tomb: ORACLE tomb exists", baseline !== "none", baseline);
  const [tombId, oldOwner, oldNoCit, oldNoPet] = baseline.split(",");
  lua(setCoffinLua(coffinId, Number(tombId), livingId, "true", "true"));
  r = await post(`/burial-coffin-action?id=${coffinId}&action=any-citizen`);
  check("any-citizen: HTTP 200", r.status === 200, `status=${r.status}`);
  const after = lua(readCoffinLua(coffinId)).split(",");
  check("any-citizen: owner cleared", Number(after[1]) === -1, after.join(","));
  check("any-citizen: citizens enabled", after[2] === "false", after.join(","));
  check("any-citizen: pets disabled", after[3] === "true", after.join(","));
  guard("coffin owner remains assigned", Number(after[1]) === livingId);
  lua(setCoffinLua(coffinId, Number(tombId), Number(oldOwner), oldNoCit, oldNoPet));

  console.log("MATRIX: reject living unit memorial slab");
  const beforeLiving = lua(orderCountLua(livingId));
  r = await post(`/memorial-slab?unit=${livingId}`);
  check("living memorial: HTTP 400", r.status === 400, `status=${r.status}`);
  check("living memorial: no manager order created", lua(orderCountLua(livingId)) === beforeLiving);

  console.log("MATRIX: dead unit memorial slab order");
  if (deadId >= 0) {
    lua(removeOrderLua(deadId));
    r = await post(`/memorial-slab?unit=${deadId}`);
    check("dead memorial: HTTP 200", r.status === 200, `status=${r.status}`);
    check("dead memorial: ORACLE manager order exists", lua(orderCountLua(deadId)) === "1");
    guard("dead memorial order count stays zero", lua(orderCountLua(deadId)) === "0");
    lua(removeOrderLua(deadId));
    check("dead memorial: cleanup removed manager order", lua(orderCountLua(deadId)) === "0");
  } else {
    skip("dead unit memorial", "no dead own-group unit with historical figure id present");
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
