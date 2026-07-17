// geld_oracle_test.mjs -- DEPLOY-GATED oracle-differential acceptance for the Pets/Livestock GELD
// action (POST /livestock-action?action=geld). Every mutation is issued over the LIVE plugin HTTP
// server, then READ BACK via dfhack-run lua against the real df struct (unit.flags3.marked_for_gelding)
// and asserted EXACT -- the mechanism (the real struct write) is verified, not just the JSON echo
// (completeness rule 2). Seeded-bad / test-the-test rows (rule 3) confirm the oracle discriminates,
// and a non-geldable animal is asserted to reject 400 with NO flag written (counterexample, rule 5).
//
// ⚠ LIVE / DF-INTERRUPTING -- run BY EXPLICIT NAME ONLY, never via a tools/harness/*.mjs glob, and
// only inside a deploy/test window (DF_LOCK + chat warning). Requires the dwf DLL that ships
// the geld action deployed + a fort with a geldable male animal (e.g. a bull/stallion/boar) loaded.
//   node tools/harness/geld_oracle_test.mjs   [--host http://localhost:8765]
//                                             [--dfhack-run <path to dfhack-run.exe>]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN (server unreachable / dfhack-run missing / old DLL / no geldable animal).
//
// SIDE EFFECTS: toggles marked_for_gelding on ONE live geldable animal, restoring its pre-test flag
// at the end (baseline captured + reapplied).

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
requireLiveOptIn("geld_oracle_test.mjs", BASE);
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
  const tmp = join(tmpdir(), `geld_lua_${process.pid}_${_luaSeq++}.lua`);
  writeFileSync(tmp, code, "utf8");
  return execFileSync(DFHACK_RUN, ["lua", "-f", tmp], { encoding: "utf8" }).trim();
}

// ORACLE: read the live gelding flag straight out of the df struct. Returns "true"/"false"/"none".
function readGeldFlag(unitId) {
  return lua(`local u=df.unit.find(${unitId}) if not u then print('none') else print(tostring(u.flags3.marked_for_gelding)) end`);
}

(async () => {
  try { const h = await fetch(`${BASE}/health`); if (!h.ok) throw new Error(`/health ${h.status}`); }
  catch (e) { console.log(`CANNOT RUN - server unreachable at ${BASE} (${e.message}). Deploy + load a fort first.`); process.exit(2); }
  try { if (lua("print(df.global.world ~= nil)") !== "true") throw new Error("world nil"); }
  catch (e) { console.log(`CANNOT RUN - dfhack-run lua unavailable at ${DFHACK_RUN} (${e.message}).`); process.exit(2); }

  const panel = await getJson(`/panel?panel=citizens&section=creatures&detail=pets`);
  if (!panel || !Array.isArray(panel.rows)) { console.log("CANNOT RUN - /panel pets returned no rows."); process.exit(2); }
  const withLs = panel.rows.filter(r => r && r.livestock && Number(r.unitId) >= 0);

  // OLD-DLL GUARD: if no livestock row carries the `geldable` field at all, the deployed DLL predates
  // this feature -- report CANNOT-RUN rather than a misleading FAIL.
  const hasGeldField = withLs.some(r => Object.prototype.hasOwnProperty.call(r.livestock, "geldable"));
  if (!hasGeldField) { console.log("CANNOT RUN - deployed DLL has no `geldable` field in livestock JSON (pre-husbandry build)."); process.exit(2); }

  const geldable = withLs.filter(r => r.livestock.geldable === true);
  const notGeldable = withLs.filter(r => r.livestock.geldable === false);
  console.log(`SUBJECTS: ${withLs.length} livestock rows, ${geldable.length} geldable, ${notGeldable.length} non-geldable.`);

  const target = geldable[0];
  if (!target) {
    console.log("CANNOT RUN - no geldable, not-yet-gelded animal in the fort. Bring a geldable male animal (bull/stallion/boar) and re-run.");
    if (!notGeldable.length) process.exit(2);
  }

  const animalId = target ? Number(target.unitId) : -1;
  const baseline = target ? readGeldFlag(animalId) : null; // "true"|"false"

  if (target) {
    // JSON envelope shape check.
    check("livestock JSON carries geld+geldable booleans",
      typeof target.livestock.geld === "boolean" && typeof target.livestock.geldable === "boolean");

    // Normalize to unmarked, then toggle ON, then OFF, asserting the ORACLE each step.
    if (baseline === "true") await post(`/livestock-action?unit=${animalId}&action=geld`);
    check("normalize: animal starts UNMARKED for gelding", readGeldFlag(animalId) === "false");

    console.log("MATRIX: mark for gelding");
    {
      const r = await post(`/livestock-action?unit=${animalId}&action=geld`);
      check("mark: HTTP 200", r.status === 200, `status=${r.status}`);
      check("mark: ORACLE flags3.marked_for_gelding == true", readGeldFlag(animalId) === "true");
      check("mark: JSON echo geld=true", r.data && r.data.livestock && r.data.livestock.geld === true);
      check("mark: JSON echo geldable=true (still geldable after marking)", r.data && r.data.livestock && r.data.livestock.geldable === true);
      checkSeededBad("mark: expecting ORACLE flag == false", readGeldFlag(animalId) === "false");
    }

    console.log("MATRIX: unmark (toggle back off)");
    {
      const r = await post(`/livestock-action?unit=${animalId}&action=geld`);
      check("unmark: HTTP 200", r.status === 200, `status=${r.status}`);
      check("unmark: ORACLE flags3.marked_for_gelding == false", readGeldFlag(animalId) === "false");
      check("unmark: JSON echo geld=false", r.data && r.data.livestock && r.data.livestock.geld === false);
    }
  }

  // COUNTEREXAMPLE (rule 5): geld on a non-geldable animal -> 400, NO flag written.
  console.log("MATRIX: reject geld on a non-geldable animal");
  if (notGeldable.length) {
    for (const row of notGeldable.slice(0, 2)) {
      const id = Number(row.unitId);
      const before = readGeldFlag(id);
      const r = await post(`/livestock-action?unit=${id}&action=geld`);
      check(`reject(unit ${id}): HTTP 400`, r.status === 400, `status=${r.status}`);
      check(`reject(unit ${id}): ORACLE flag UNCHANGED`, readGeldFlag(id) === before);
    }
  } else {
    skip("reject non-geldable", "no non-geldable livestock row present");
  }

  // REJECT invalid unit id -> 400.
  console.log("MATRIX: reject invalid unit id");
  { const r = await post(`/livestock-action?unit=999999999&action=geld`); check("invalid-unit: HTTP 400", r.status === 400, `status=${r.status}`); }

  // SEEDED-BAD: the oracle reports 'none' for a nonexistent unit.
  console.log("SEEDED-BAD: oracle discrimination");
  checkSeededBad("readGeldFlag(-1) claims a real flag value", readGeldFlag(-1) !== "none");

  // Restore baseline.
  if (target && baseline !== null) {
    if (readGeldFlag(animalId) !== baseline) await post(`/livestock-action?unit=${animalId}&action=geld`);
    check("restore: animal returned to its pre-test gelding flag", readGeldFlag(animalId) === baseline,
      `baseline=${baseline} now=${readGeldFlag(animalId)}`);
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
