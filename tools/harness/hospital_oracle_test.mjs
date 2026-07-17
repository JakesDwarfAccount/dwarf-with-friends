// hospital_oracle_test.mjs -- DEPLOY-GATED oracle-differential acceptance for the Wave 3.3
// hospital supply-maxima mutation (POST /hospital-supply). Every write is issued over the LIVE
// plugin HTTP server, then READ BACK via dfhack-run lua straight out of the real df struct
// (abstract_building_hospitalst:getContents() -> abstract_building_contents.desired_* + the
// need_more bitfield) and asserted EXACT: the mechanism (real DF struct writes, scaled by DF's
// internal multiplier) is verified, not just the JSON echo (completeness rule 2). The GET
// /hospital-info read surface is cross-checked against the same struct. Seeded-bad / test-the-test
// rows (rule 3) confirm the oracle discriminates a wrong expected value.
//
// Run AFTER the dwf DLL is deployed + a fort WITH A HOSPITAL LOCATION is loaded:
//   node tools/harness/hospital_oracle_test.mjs   [--host http://localhost:8765]
//                                                 [--dfhack-run <path to dfhack-run.exe>]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN (server unreachable / dfhack-run missing / no hospital).
//
// SIDE EFFECTS: rewrites supply maxima on ONE live hospital, then RESTORES each field's exact
// pre-test raw value + need_more bit (baseline captured via lua, reapplied via lua). Never injures
// a dwarf. Covered by the standing consent for DF-interrupting tests; run only inside a
// deploy/test window, never while the owner is mid-edit.

import process from "node:process";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireLiveOptIn } from "./live_guard.mjs";

import { defaultDfhackRun } from "../lib/dfroot.mjs";   // W1: resolved, never hardcoded
const BASE = (() => {
  const i = process.argv.indexOf("--host");
  return (i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "http://localhost:8765").replace(/\/+$/, "");
})();

// B242: a live oracle must be asked for on purpose -- port 8765 may be a fort someone is playing.
requireLiveOptIn("hospital_oracle_test.mjs", BASE);
const DFHACK_RUN = (() => {
  const i = process.argv.indexOf("--dfhack-run");
  return i >= 0 && process.argv[i + 1]
    ? process.argv[i + 1]
    : defaultDfhackRun();
})();

let failed = 0, passed = 0, skipped = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function checkSeededBad(name, cond) {
  if (!cond) { passed++; console.log(`  ok - (test-the-test) ${name} -> correctly detected as wrong`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name} -> oracle did NOT discriminate`); }
}
function skip(name, why) { skipped++; console.log(`  SKIP - ${name} (${why})`); }

async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: "POST" });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}
async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  return res.ok ? res.json() : null;
}

// dfhack-run's inline `lua <code>` form chokes on multi-statement chunks; write to an ABSOLUTE
// temp file and run with `-f`. Each call is a fresh one-shot file (single pass over the fort's
// small buildings vector -- NOT a poll loop).
let _luaSeq = 0;
function lua(code) {
  const tmp = join(tmpdir(), `hosp_lua_${process.pid}_${_luaSeq++}.lua`);
  writeFileSync(tmp, code, "utf8");
  return execFileSync(DFHACK_RUN, ["lua", "-f", tmp], { encoding: "utf8" }).trim();
}

// Shared lua prologue: locate the first hospital location in the current fort site. Prints
// 'nosite' / 'nohosp' when the precondition is unmet (drives an auto-SKIP).
const FIND_HOSP =
  "local pi=df.global.plotinfo local wd=df.global.world.world_data local site=nil " +
  "for _,s in ipairs(wd.sites) do if s.id==pi.site_id then site=s break end end " +
  "if not site then print('nosite') return end " +
  "local hosp=nil for _,b in ipairs(site.buildings) do " +
  "if df.abstract_building_hospitalst:is_instance(b) then hosp=b break end end " +
  "if not hosp then print('nohosp') return end local c=hosp:getContents() ";

// Read one supply's raw desired value + its need_more bit straight from the struct.
function readSupply(desiredField, needBit) {
  const out = lua(FIND_HOSP +
    `print(string.format('%d %d %s', hosp.id, c.${desiredField}, tostring(c.need_more.${needBit})))`);
  if (out === "nosite" || out === "nohosp") return { missing: out };
  const [id, raw, need] = out.split(/\s+/);
  return { locationId: Number(id), raw: Number(raw), need: need === "true" };
}

// Restore a field's exact pre-test raw value + need_more bit directly (one-shot struct write).
function restoreSupply(desiredField, needBit, raw, need) {
  lua(FIND_HOSP +
    `c.${desiredField}=${raw} c.need_more.${needBit}=${need ? "true" : "false"} print('ok')`);
}

// The scale matrix: one supply per internal multiplier class (x1, x150, x15000) to prove the
// route writes level*scale for every class -- desired field name + need_more bit + DF scale.
const SUPPLIES = [
  { key: "splints", field: "desired_splints", bit: "splints", scale: 1 },
  { key: "plaster", field: "desired_powder",  bit: "powder",  scale: 150 },
  { key: "thread",  field: "desired_thread",  bit: "thread",  scale: 15000 },
];

async function main() {
  // Preflight: server reachable?
  let reachable = false;
  try { await fetch(`${BASE}/hospital-info?location=-1`, { cache: "no-store" }); reachable = true; } catch (_) {}
  if (!reachable) { console.log("CANNOT-RUN: server unreachable at " + BASE); process.exit(2); }
  // Preflight: dfhack-run present + hospital exists?
  let probe;
  try { probe = readSupply("desired_splints", "splints"); }
  catch (e) { console.log("CANNOT-RUN: dfhack-run failed (" + (e.message || e) + ")"); process.exit(2); }
  if (probe.missing === "nosite") { console.log("CANNOT-RUN: no active fort site"); process.exit(2); }
  if (probe.missing === "nohosp") {
    skip("all supply-mutation rows", "no hospital location in this fort (precondition-gated)");
    console.log(`\nSKIP-ONLY - ${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(failed === 0 ? 0 : 1);
  }
  const locationId = probe.locationId;
  console.log(`Hospital location id ${locationId} found -- running oracle.`);

  for (const s of SUPPLIES) {
    console.log(`TEST: ${s.key} (scale x${s.scale}, ${s.field})`);
    const base = readSupply(s.field, s.bit);
    try {
      // level > 0: desired == level*scale, need_more set.
      const level = 7;
      const r1 = await post(`/hospital-supply?location=${locationId}&supply=${s.key}&level=${level}`);
      check(`${s.key} POST level ${level} ok`, r1.status === 200 && r1.data && r1.data.ok === true, JSON.stringify(r1.data));
      const after = readSupply(s.field, s.bit);
      check(`${s.key} desired == ${level}*${s.scale} (=${level * s.scale}) in struct`, after.raw === level * s.scale, `got ${after.raw}`);
      check(`${s.key} need_more set true for level>0`, after.need === true);
      // Cross-check the GET read surface reports desiredLevel == level.
      const info = await getJson(`/hospital-info?location=${locationId}&t=${Date.now()}`);
      const row = info && Array.isArray(info.supplies) ? info.supplies.find(x => x.key === s.key) : null;
      check(`${s.key} /hospital-info desiredLevel == ${level}`, row && Number(row.desiredLevel) === level, JSON.stringify(row));
      check(`${s.key} /hospital-info needMore true`, row && row.needMore === true);
      checkSeededBad(`${s.key} desired (wrongly) == level*WRONGSCALE`, after.raw === level * (s.scale === 1 ? 2 : 1));

      // level == 0: desired zeroed, need_more cleared.
      const r0 = await post(`/hospital-supply?location=${locationId}&supply=${s.key}&level=0`);
      check(`${s.key} POST level 0 ok`, r0.status === 200);
      const zero = readSupply(s.field, s.bit);
      check(`${s.key} desired == 0 after level 0`, zero.raw === 0, `got ${zero.raw}`);
      check(`${s.key} need_more cleared for level 0`, zero.need === false);
    } finally {
      restoreSupply(s.field, s.bit, base.raw, base.need);
      const restored = readSupply(s.field, s.bit);
      check(`${s.key} baseline restored (raw ${base.raw}, need ${base.need})`,
        restored.raw === base.raw && restored.need === base.need, `got raw ${restored.raw} need ${restored.need}`);
    }
  }

  // Clamp check: level 999 clamps to 99 (max desired == 99*scale).
  const cs = SUPPLIES[0];
  const cbase = readSupply(cs.field, cs.bit);
  await post(`/hospital-supply?location=${locationId}&supply=${cs.key}&level=999`);
  const clamped = readSupply(cs.field, cs.bit);
  check(`${cs.key} level 999 clamps to 99 (desired ${99 * cs.scale})`, clamped.raw === 99 * cs.scale, `got ${clamped.raw}`);
  restoreSupply(cs.field, cs.bit, cbase.raw, cbase.need);

  // Unknown supply key -> 400, no struct change.
  const bad = await post(`/hospital-supply?location=${locationId}&supply=bogus&level=5`);
  check("unknown supply key -> 400", bad.status === 400);

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.log("CANNOT-RUN: " + (e.stack || e.message || e)); process.exit(2); });
