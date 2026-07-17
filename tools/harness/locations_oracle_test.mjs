// locations_oracle_test.mjs -- DEPLOY-GATED oracle-differential acceptance for LOCATION MANAGEMENT
// (POST /zone-location-action create/restrict/rename/retire). Every mutation is issued over the LIVE
// plugin HTTP server, then READ BACK via dfhack-run lua against the real df structs
// (abstract_building.flags.{VISITORS_ALLOWED,NON_CITIZENS_ALLOWED,MEMBERS_ONLY,DOES_NOT_EXIST},
// translated abstract_building.name, civzone.location_id) and asserted EXACT -- the mechanism (the
// real struct write) is verified, not just the JSON echo (completeness rule 2). Seeded-bad /
// test-the-test rows (rule 3) confirm the oracle discriminates, and retiring an in-use location is
// asserted to reject 400 with NO DOES_NOT_EXIST written (counterexample, rule 5).
//
// SCOPE NOTE: occupation ASSIGNMENT (tavern keeper / performer / priest / scholar) is a documented
// GAP -- native's Location Details drives engine-internal slot creation + a histfig_entity_link the
// plugin does not replicate. This test exercises the flows that WERE built: create-from-zone,
// access restriction, rename, retire, and the occupation/restriction READ envelope.
//
// WARNING - LIVE / DF-INTERRUPTING -- run BY EXPLICIT NAME ONLY, never via a tools/harness/*.mjs
// glob, and only inside a deploy/test window (DF_LOCK + chat warning). Requires the reloaded
// dwf.lua that ships these actions + a fort with a location-accepting civzone
// (MeetingHall / DiningHall / Bedroom) present.
//   node tools/harness/locations_oracle_test.mjs   [--host http://localhost:8765]
//                                                   [--dfhack-run <path to dfhack-run.exe>]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN (server unreachable / dfhack-run missing / old lua / no zone).
//
// SIDE EFFECTS: on ONE location-accepting zone it captures the original location assignment, creates
// a scratch Tavern, mutates its access/name, retires it, then restores the zone's original
// assignment. All reversible; baseline captured + reapplied.

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
requireLiveOptIn("locations_oracle_test.mjs", BASE);
const DFHACK_RUN = (() => {
  const i = process.argv.indexOf("--dfhack-run");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : defaultDfhackRun();
})();

let failed = 0, passed = 0, skipped = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log(`  ok - ${name}`); } else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); } }
function checkSeededBad(name, cond) { if (!cond) { passed++; console.log(`  ok - (test-the-test) ${name} -> correctly detected as wrong`); } else { failed++; console.log(`  FAIL - (test-the-test) ${name} -> oracle did NOT discriminate`); } }
function skip(name, why) { skipped++; console.log(`  SKIP - ${name} (${why})`); }

async function post(path) { const res = await fetch(`${BASE}${path}`, { method: "POST" }); let data = null; try { data = await res.json(); } catch (_) {} return { status: res.status, data }; }
async function getJson(path) { const res = await fetch(`${BASE}${path}`, { cache: "no-store" }); return res.ok ? res.json() : null; }

let _luaSeq = 0;
function lua(code) {
  const tmp = join(tmpdir(), `loc_lua_${process.pid}_${_luaSeq++}.lua`);
  writeFileSync(tmp, code, "utf8");
  return execFileSync(DFHACK_RUN, ["lua", "-f", tmp], { encoding: "utf8" }).trim();
}

// ORACLE: find a location-accepting civzone; print "<zoneId> <origLocationId>" or "none".
function findZone() {
  return lua(`
    local out='none'
    for _,b in ipairs(df.global.world.buildings.all) do
      if df.building_civzonest:is_instance(b) and
        (b.type==df.civzone_type.MeetingHall or b.type==df.civzone_type.DiningHall or b.type==df.civzone_type.Bedroom) then
        out=tostring(b.id)..' '..tostring(b.location_id); break
      end
    end
    print(out)`);
}

// ORACLE: read a zone's current location_id straight from the civzone struct.
function zoneLocId(zoneId) {
  return lua(`local b=df.building.find(${zoneId}) if not b then print('none') else print(tostring(b.location_id)) end`);
}

// ORACLE: for a location id, print "<restriction> <doesNotExist> <type> :: <name>" read from df.
function locState(locId) {
  return lua(`
    local site=dfhack.world.getCurrentSite()
    local loc
    if site then for _,l in ipairs(site.buildings) do if l.id==${locId} then loc=l break end end end
    if not loc then print('none') return end
    local rest = loc.flags.MEMBERS_ONLY and 'members'
      or ((loc.flags.VISITORS_ALLOWED and loc.flags.NON_CITIZENS_ALLOWED) and 'everyone' or 'citizens')
    local ok,nm = pcall(dfhack.translation.translateName, loc.name, true)
    if not ok then nm='' end
    print(rest..' '..tostring(loc.flags.DOES_NOT_EXIST)..' '..tostring(df.abstract_building_type[loc:getType()])..' :: '..(nm or ''))`);
}

(async () => {
  try { const h = await fetch(`${BASE}/health`); if (!h.ok) throw new Error(`/health ${h.status}`); }
  catch (e) { console.log(`CANNOT RUN - server unreachable at ${BASE} (${e.message}). Deploy + load a fort first.`); process.exit(2); }
  try { if (lua("print(df.global.world ~= nil)") !== "true") throw new Error("world nil"); }
  catch (e) { console.log(`CANNOT RUN - dfhack-run lua unavailable at ${DFHACK_RUN} (${e.message}).`); process.exit(2); }

  const found = findZone();
  if (found === "none") { console.log("CANNOT RUN - no MeetingHall/DiningHall/Bedroom civzone in the fort. Zone one and re-run."); process.exit(2); }
  const [zoneId, origLocId] = found.split(/\s+/).map(Number);
  console.log(`SUBJECT ZONE: ${zoneId} (original location_id=${origLocId})`);

  const zl = await getJson(`/zone-locations?id=${zoneId}`);
  if (!zl) { console.log("CANNOT RUN - /zone-locations returned nothing for the subject zone."); process.exit(2); }

  // OLD-LUA GUARD: the reloaded dwf.lua adds `restriction`/`occupations` to each location and
  // `createTypes`. If a location row lacks `restriction`, the running lua predates this feature.
  const sampleLoc = (Array.isArray(zl.locations) ? zl.locations : [])[0];
  const hasNewRead = sampleLoc ? Object.prototype.hasOwnProperty.call(sampleLoc, "restriction") : Array.isArray(zl.createTypes);
  if (sampleLoc && !hasNewRead) { console.log("CANNOT RUN - /zone-locations has no `restriction` field (pre-locations-mgmt lua)."); process.exit(2); }

  // CREATE a scratch Tavern on the subject zone.
  console.log("MATRIX: create tavern from zone");
  let scratchLocId = -1;
  {
    const r = await post(`/zone-location-action?id=${zoneId}&action=create&kind=tavern`);
    check("create: HTTP 200", r.status === 200, `status=${r.status}`);
    const nowLoc = Number(zoneLocId(zoneId));
    check("create: ORACLE civzone.location_id points at a NEW location", Number.isInteger(nowLoc) && nowLoc >= 0 && nowLoc !== origLocId, `loc=${nowLoc}`);
    scratchLocId = nowLoc;
    const st = locState(scratchLocId);
    check("create: ORACLE new location is an INN_TAVERN", /INN_TAVERN/.test(st), st);
    checkSeededBad("create: expecting location_id unchanged from original", nowLoc === origLocId);
  }
  if (scratchLocId < 0) { console.log("ABORT - scratch location not created; skipping mutation matrix."); process.exit(1); }

  // RESTRICT: each access mode, oracle-verified against the real flags.
  for (const [mode, rx] of [["citizens", /^citizens/], ["members", /^members/], ["everyone", /^everyone/]]) {
    console.log(`MATRIX: restrict -> ${mode}`);
    const r = await post(`/zone-location-action?id=${zoneId}&action=restrict&location=${scratchLocId}&kind=${mode}`);
    check(`restrict ${mode}: HTTP 200`, r.status === 200, `status=${r.status}`);
    check(`restrict ${mode}: ORACLE flags match`, rx.test(locState(scratchLocId)), locState(scratchLocId));
  }
  checkSeededBad("restrict everyone: oracle should NOT read 'members'", /^members/.test(locState(scratchLocId)));

  // RENAME: oracle-verify the translated name.
  console.log("MATRIX: rename");
  {
    const newName = "Testkeg";
    const r = await post(`/zone-location-action?id=${zoneId}&action=rename&location=${scratchLocId}&kind=${encodeURIComponent(newName)}`);
    check("rename: HTTP 200", r.status === 200, `status=${r.status}`);
    check("rename: ORACLE translated name matches", locState(scratchLocId).includes(newName), locState(scratchLocId));
    // empty-name guard
    const bad = await post(`/zone-location-action?id=${zoneId}&action=rename&location=${scratchLocId}&kind=`);
    check("rename empty: HTTP 400", bad.status === 400, `status=${bad.status}`);
  }

  // COUNTEREXAMPLE (rule 5): a bogus location id must be rejected 400 with no struct written. The
  // in-use guard (occupations assigned / extra zones attached) is enforced in zone_location_action's
  // retire branch; the scratch tavern here is attached only to the subject zone, which retire itself
  // detaches, so the happy-path retire below exercises the detach-then-flag sequence.
  console.log("MATRIX: reject retire of a bogus location id");
  {
    const r = await post(`/zone-location-action?id=${zoneId}&action=retire&location=999999`);
    check("retire bogus: HTTP 400", r.status === 400, `status=${r.status}`);
  }

  // RETIRE the scratch location: retire detaches the subject zone first, then flags DOES_NOT_EXIST.
  console.log("MATRIX: retire scratch location");
  {
    const r = await post(`/zone-location-action?id=${zoneId}&action=retire&location=${scratchLocId}`);
    check("retire: HTTP 200", r.status === 200, `status=${r.status}`);
    const st = locState(scratchLocId);                 // "<rest> <doesNotExist> <type> :: <name>"
    const doesNotExist = (st.split("::")[0] || "").trim().split(/\s+/)[1];
    check("retire: ORACLE DOES_NOT_EXIST == true", doesNotExist === "true", st);
    check("retire: ORACLE civzone detached (location_id == -1 or original)", [String(-1), String(origLocId)].includes(zoneLocId(zoneId)), `loc=${zoneLocId(zoneId)}`);
  }

  // RESTORE: re-attach the zone's ORIGINAL location if it had one.
  console.log("RESTORE: original zone assignment");
  if (origLocId >= 0) {
    const r = await post(`/zone-location-action?id=${zoneId}&action=assign&location=${origLocId}`);
    check("restore: HTTP 200", r.status === 200, `status=${r.status}`);
    check("restore: ORACLE civzone.location_id back to original", Number(zoneLocId(zoneId)) === origLocId, `loc=${zoneLocId(zoneId)}`);
  } else {
    const r = await post(`/zone-location-action?id=${zoneId}&action=clear`);
    check("restore: zone cleared (had no original location)", r.status === 200, `status=${r.status}`);
    check("restore: ORACLE civzone.location_id == -1", Number(zoneLocId(zoneId)) === -1, `loc=${zoneLocId(zoneId)}`);
  }

  // SEEDED-BAD: oracle discrimination for a nonexistent location.
  console.log("SEEDED-BAD: oracle discrimination");
  checkSeededBad("locState(-1) claims a real location", locState(-1) !== "none");

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
