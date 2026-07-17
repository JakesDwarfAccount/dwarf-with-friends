// building_cage_oracle_test.mjs -- DEPLOY-GATED oracle-differential acceptance for built cage
// occupant management. Mutations are issued over the LIVE plugin HTTP server, then READ BACK via
// dfhack-run lua against df::building_cagest::assigned_units. The test proves view occupants,
// release/unassign, and reassign use the real native cage vector, with old-server and precondition
// guards plus counterexamples.
//
// LIVE / DF-INTERRUPTING -- run BY EXPLICIT NAME ONLY, never via a tools/harness/*.mjs glob, and
// only inside a deploy/test window (DF_LOCK + chat warning). Requires a deployed DLL that ships
// /building-cage and a fort with a built cage/terrarium containing at least one assigned unit.
//   node tools/harness/building_cage_oracle_test.mjs [--host http://localhost:8765]
//                                                     [--dfhack-run <path to dfhack-run.exe>]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN.
//
// SIDE EFFECTS: removes one unit id from one built cage's assigned_units, then re-adds/restores
// it before exit. It does not clear CONTAINED_IN_ITEM refs; DF owns physical release completion.

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
requireLiveOptIn("building_cage_oracle_test.mjs", BASE);
const DFHACK_RUN = (() => {
  const i = process.argv.indexOf("--dfhack-run");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : defaultDfhackRun();
})();
const HEADERS = { Cookie: "dfcap_auth=123" };

let failed = 0, passed = 0, skipped = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log(`  ok - ${name}`); } else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); } }
function checkSeededBad(name, cond) { if (!cond) { passed++; console.log(`  ok - (test-the-test) ${name} -> correctly detected as wrong`); } else { failed++; console.log(`  FAIL - (test-the-test) ${name} -> oracle did NOT discriminate`); } }
function skip(name, why) { skipped++; console.log(`  SKIP - ${name} (${why})`); }
function cannotRun(msg) { console.log(`CANNOT RUN - ${msg}`); process.exit(2); }

async function post(path) { const res = await fetch(`${BASE}${path}`, { method: "POST", headers: HEADERS }); let text = ""; try { text = await res.text(); } catch (_) {} return { status: res.status, text }; }
async function getJson(path) { const res = await fetch(`${BASE}${path}`, { cache: "no-store", headers: HEADERS }); let data = null; try { data = await res.json(); } catch (_) {} return { status: res.status, data }; }

let _luaSeq = 0;
function lua(code) {
  const tmp = join(tmpdir(), `building_cage_lua_${process.pid}_${_luaSeq++}.lua`);
  writeFileSync(tmp, code, "utf8");
  return execFileSync(DFHACK_RUN, ["lua", "-f", tmp], { encoding: "utf8" }).trim();
}

function cageUnits(cageId) {
  const out = lua(`local b=df.building.find(${cageId}) if not b or not df.building_cagest:is_instance(b) then print('none') return end local t={} for i=0,#b.assigned_units-1 do table.insert(t, tostring(b.assigned_units[i])) end print(table.concat(t, ','))`);
  if (out === "none") return null;
  return out ? out.split(",").map(Number) : [];
}

function findBuiltCageWithAssignedUnit() {
  const out = lua(`for _,b in ipairs(df.global.world.buildings.other.CAGE) do if b and b:getBuildStage()==b:getMaxBuildStage() and #b.assigned_units > 0 then print(tostring(b.id)..':'..tostring(b.assigned_units[0])) return end end print('none')`);
  if (out === "none") return null;
  const [cage, unit] = out.split(":").map(Number);
  return Number.isInteger(cage) && Number.isInteger(unit) ? { cage, unit } : null;
}

function findUncagedHostile() {
  const code = `
local function has_ref(u, ty)
  for _,r in ipairs(u.general_refs) do if r:getType() == ty then return true end end
  return false
end
local function in_built_cage(u)
  for _,b in ipairs(df.global.world.buildings.other.CAGE) do
    for i=0,#b.assigned_units-1 do if b.assigned_units[i] == u.id then return true end end
  end
  return false
end
for _,u in ipairs(df.global.world.units.active) do
  if u and not dfhack.units.isDead(u) and not u.flags1.caged and not dfhack.units.isTame(u)
     and not dfhack.units.isOwnCiv(u) and not dfhack.units.isOwnRace(u)
     and not has_ref(u, df.general_ref_type.CONTAINED_IN_ITEM) and not in_built_cage(u)
     and u.pos.x >= 0 and u.pos.y >= 0 and u.pos.z >= 0 then
    print(u.id)
    return
  end
end
print('none')`;
  const out = lua(code);
  return out === "none" ? null : Number(out);
}

(async () => {
  try { const h = await fetch(`${BASE}/health`, { headers: HEADERS }); if (!h.ok) throw new Error(`/health ${h.status}`); }
  catch (e) { cannotRun(`server unreachable at ${BASE} (${e.message}). Deploy + load a fort first.`); }
  try { if (lua("print(df.global.world ~= nil)") !== "true") throw new Error("world nil"); }
  catch (e) { cannotRun(`dfhack-run lua unavailable at ${DFHACK_RUN} (${e.message}).`); }

  const subject = findBuiltCageWithAssignedUnit();
  if (!subject) cannotRun("no built cage/terrarium with an assigned unit exists in this fort.");
  console.log(`SUBJECT: cage ${subject.cage}, unit ${subject.unit}`);

  const info = await getJson(`/building-info?id=${subject.cage}&t=${Date.now()}`);
  if (!info.data || info.data.isCage !== true) cannotRun("deployed DLL has no isCage field on /building-info (pre-prisoner build). ");
  const cageView = await getJson(`/building-cage?id=${subject.cage}&t=${Date.now()}`);
  if (cageView.status === 404) cannotRun("deployed DLL has no /building-cage route (pre-prisoner build).");
  check("/building-cage HTTP 200", cageView.status === 200, `status=${cageView.status}`);
  check("/building-cage returns occupant rows", cageView.data && Array.isArray(cageView.data.units));
  check("assigned occupant appears in JSON", cageView.data && cageView.data.units.some(r => Number(r.id) === subject.unit && r.assigned === true));

  const baseline = cageUnits(subject.cage);
  if (!Array.isArray(baseline) || !baseline.includes(subject.unit)) cannotRun("oracle could not read baseline cage assigned_units.");

  console.log("MATRIX: release / unassign occupant from built cage");
  {
    const r = await post(`/building-cage-action?id=${subject.cage}&unit=${subject.unit}&assign=0&kind=unit`);
    check("release: HTTP 200", r.status === 200, `status=${r.status} ${r.text}`);
    check("release: ORACLE unit leaves cage assigned_units", !cageUnits(subject.cage).includes(subject.unit));
    checkSeededBad("release: expecting unit to still be in cage assigned_units", cageUnits(subject.cage).includes(subject.unit));
  }

  console.log("MATRIX: reassign same caged unit to built cage");
  {
    const r = await post(`/building-cage-action?id=${subject.cage}&unit=${subject.unit}&assign=1&kind=unit`);
    check("assign: HTTP 200", r.status === 200, `status=${r.status} ${r.text}`);
    check("assign: ORACLE unit returns to cage assigned_units", cageUnits(subject.cage).includes(subject.unit));
  }

  console.log("MATRIX: reject invalid unit id");
  { const before = cageUnits(subject.cage).join(","); const r = await post(`/building-cage-action?id=${subject.cage}&unit=999999999&assign=1&kind=unit`); check("invalid-unit: HTTP 400", r.status === 400, `status=${r.status}`); check("invalid-unit: ORACLE cage list unchanged", cageUnits(subject.cage).join(",") === before); }

  console.log("MATRIX: reject uncaged hostile if present");
  const hostile = findUncagedHostile();
  if (Number.isInteger(hostile)) {
    const before = cageUnits(subject.cage).join(",");
    const r = await post(`/building-cage-action?id=${subject.cage}&unit=${hostile}&assign=1&kind=unit`);
    check(`uncaged-hostile ${hostile}: HTTP 400`, r.status === 400, `status=${r.status}`);
    check(`uncaged-hostile ${hostile}: ORACLE cage list unchanged`, cageUnits(subject.cage).join(",") === before);
  } else {
    skip("uncaged hostile counterexample", "none active in this fort");
  }

  console.log("RESTORE: baseline cage assigned_units");
  const now = cageUnits(subject.cage);
  if (!now.includes(subject.unit)) await post(`/building-cage-action?id=${subject.cage}&unit=${subject.unit}&assign=1&kind=unit`);
  check("restore: subject unit is assigned as at baseline", cageUnits(subject.cage).includes(subject.unit));

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
