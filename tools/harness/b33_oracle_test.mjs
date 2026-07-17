// b33_oracle_test.mjs -- DEPLOY-GATED oracle-differential acceptance for B33 (animal-trainer
// assignment: DF's "Assign a trainer to this creature" action, the ctrl+T workaround the owner hit).
// Every mutation is issued over the LIVE plugin HTTP server (POST /livestock-action), then READ
// BACK via dfhack-run lua against the real df struct (plotinfo.training.training_assignments) and
// asserted EXACT -- the mechanism (real struct writes) is verified, not just the JSON echo
// (completeness rule 2). Seeded-bad / test-the-test rows (rule 3) confirm the oracle discriminates.
//
// Run AFTER the dwf DLL is deployed + a fort with pets/livestock is loaded:
//   node tools/harness/b33_oracle_test.mjs   [--host http://localhost:8765]
//                                            [--dfhack-run <path to dfhack-run.exe>]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN (server unreachable / dfhack-run missing / no tameable animal).
//
// SIDE EFFECTS: assigns then unassigns a trainer on ONE live tameable animal, restoring it to
// its pre-test state at the end (baseline captured + reapplied). Covered by the standing consent
// for DF-interrupting tests; still run only inside a deploy/test window, never while the owner is mid-edit.

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
requireLiveOptIn("b33_oracle_test.mjs", BASE);
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
// A "seeded-bad" assertion is EXPECTED to be false; the oracle passes iff it correctly reports false.
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
// temp file and run with `-f`. Each call is a fresh one-shot file (single pass over the small
// training_assignments vector -- NOT a poll loop).
let _luaSeq = 0;
function lua(code) {
  const tmp = join(tmpdir(), `b33_lua_${process.pid}_${_luaSeq++}.lua`);
  writeFileSync(tmp, code, "utf8");
  return execFileSync(DFHACK_RUN, ["lua", "-f", tmp], { encoding: "utf8" }).trim();
}

// ORACLE: read the live assignment for one animal id straight out of the df struct.
// Returns null when no assignment exists, else {trainerId, anyTrainer, war, hunt, taming}.
function readAsg(animalId) {
  const out = lua(
    "local vec=df.global.plotinfo.training.training_assignments local A=" + animalId + " " +
    "local found=nil for i=0,#vec-1 do if vec[i].animal_id==A then found=vec[i] break end end " +
    "if not found then print('none') else local f=found.flags " +
    "print(string.format('%d %s %s %s', found.trainer_id, tostring(f.any_trainer), " +
    "tostring(f.train_war), tostring(f.train_hunt))) end");
  if (out === "none") return null;
  const [tid, any, war, hunt] = out.split(/\s+/);
  return {
    trainerId: Number(tid),
    anyTrainer: any === "true",
    war: war === "true",
    hunt: hunt === "true",
    taming: war === "false" && hunt === "false",
  };
}

(async () => {
  // ---- preconditions ----
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
    console.log(`CANNOT RUN - dfhack-run lua unavailable at ${DFHACK_RUN} (${e.message}).`);
    process.exit(2);
  }

  // ---- discover live subjects from the Pets/Livestock panel ----
  const panel = await getJson(`/panel?panel=citizens&section=creatures&detail=pets`);
  if (!panel || !Array.isArray(panel.rows)) {
    console.log("CANNOT RUN - /panel pets returned no rows.");
    process.exit(2);
  }
  const trainers = Array.isArray(panel.trainers) ? panel.trainers : [];
  const withLs = panel.rows.filter(r => r && r.livestock && Number(r.unitId) >= 0);
  const tameable = withLs.filter(r => r.livestock.tamable);
  const notTameable = withLs.filter(r => !r.livestock.tamable); // domesticated OR non-tameable caste
  const target = tameable[0];

  console.log(`SUBJECTS: ${withLs.length} livestock rows, ${tameable.length} tameable, ` +
    `${notTameable.length} non-tameable/domesticated, ${trainers.length} trainer-capable dwarves.`);

  // trainers[] envelope shape (B33 server addition).
  check("panel.trainers is an array (B33 envelope field present)", Array.isArray(panel.trainers));
  if (trainers.length)
    check("each trainer entry has {id:number, name:string}",
      trainers.every(t => Number.isInteger(Number(t.id)) && typeof t.name === "string"));

  if (!target) {
    console.log("CANNOT RUN - no tameable, not-yet-domesticated animal in the fort to exercise the " +
      "assign flow. Bring a wild-caught tameable animal into the fort and re-run.");
    // still run the invalid-unit + rejection rows below if we have material, else bail.
    if (!notTameable.length) process.exit(2);
  }

  const animalId = target ? Number(target.unitId) : -1;
  const specificTrainer = trainers.length ? Number(trainers[0].id) : -1;

  // capture baseline so we can restore the animal afterwards.
  const baseline = target ? readAsg(animalId) : null;

  if (target) {
    // normalize to unassigned before the matrix.
    await post(`/livestock-action?unit=${animalId}&action=unassign-trainer`);
    check("normalize: animal starts with NO assignment", readAsg(animalId) === null);

    // ---- 1) ASSIGN ANY-TRAINER ----
    console.log("MATRIX: assign any-trainer");
    {
      const r = await post(`/livestock-action?unit=${animalId}&action=assign-trainer`);
      check("assign-any: HTTP 200", r.status === 200, `status=${r.status}`);
      const o = readAsg(animalId);
      check("assign-any: ORACLE assignment now exists", !!o);
      check("assign-any: ORACLE any_trainer=true", o && o.anyTrainer === true);
      check("assign-any: ORACLE trainer_id=-1", o && o.trainerId === -1);
      check("assign-any: ORACLE is a plain taming (war=hunt=false)", o && o.taming === true);
      check("assign-any: JSON echo training=true", r.data && r.data.livestock && r.data.livestock.training === true);
      check("assign-any: JSON echo taming=true", r.data && r.data.livestock && r.data.livestock.taming === true);
      check("assign-any: JSON echo trainerId=-1", r.data && r.data.livestock && r.data.livestock.trainerId === -1);
      // test-the-test: the oracle must NOT falsely agree with a wrong expectation.
      checkSeededBad("assign-any: expecting any_trainer=false", o && o.anyTrainer === false);
    }

    // ---- 2) ASSIGN SPECIFIC TRAINER (also proves in-place update of an existing assignment) ----
    if (specificTrainer >= 0) {
      console.log(`MATRIX: assign specific trainer (unit ${specificTrainer})`);
      const r = await post(`/livestock-action?unit=${animalId}&action=assign-trainer&trainer=${specificTrainer}`);
      check("assign-specific: HTTP 200", r.status === 200, `status=${r.status}`);
      const o = readAsg(animalId);
      check("assign-specific: ORACLE trainer_id matches the chosen dwarf", o && o.trainerId === specificTrainer);
      check("assign-specific: ORACLE any_trainer=false", o && o.anyTrainer === false);
      check("assign-specific: still a plain taming (war=hunt=false, in-place update kept no war/hunt)",
        o && o.taming === true);
      check("assign-specific: JSON echo trainerId matches", r.data && r.data.livestock && r.data.livestock.trainerId === specificTrainer);
      // re-assign back to any-trainer, proving set_trainer updates in place (assignTrainer would refuse).
      const r2 = await post(`/livestock-action?unit=${animalId}&action=assign-trainer&trainer=-1`);
      const o2 = readAsg(animalId);
      check("reassign->any: HTTP 200 + ORACLE any_trainer=true (in-place trainer swap)",
        r2.status === 200 && o2 && o2.anyTrainer === true && o2.trainerId === -1);
    } else {
      skip("assign-specific", "no trainer-capable dwarf (Animal Training labor) in the fort");
    }

    // ---- 3) UNASSIGN ----
    console.log("MATRIX: unassign-trainer");
    {
      const r = await post(`/livestock-action?unit=${animalId}&action=unassign-trainer`);
      check("unassign: HTTP 200", r.status === 200, `status=${r.status}`);
      check("unassign: ORACLE assignment removed entirely", readAsg(animalId) === null);
      check("unassign: JSON echo training=false", r.data && r.data.livestock && r.data.livestock.training === false);
    }
  }

  // ---- 4) REJECTION: non-tameable / already-domesticated animal -> 400, no assignment written ----
  console.log("MATRIX: reject assign-trainer on non-tameable / domesticated animals");
  if (notTameable.length) {
    for (const row of notTameable.slice(0, 2)) {
      const id = Number(row.unitId);
      const before = readAsg(id);
      const r = await post(`/livestock-action?unit=${id}&action=assign-trainer`);
      check(`reject(unit ${id}): HTTP 400`, r.status === 400, `status=${r.status}`);
      check(`reject(unit ${id}): ORACLE created NO assignment`, JSON.stringify(readAsg(id)) === JSON.stringify(before));
    }
  } else {
    skip("reject non-tameable/domesticated", "no non-tameable livestock row present");
  }

  // ---- 5) REJECTION: invalid unit id -> 400 ----
  console.log("MATRIX: reject invalid unit id");
  {
    const r = await post(`/livestock-action?unit=999999999&action=assign-trainer`);
    check("invalid-unit: HTTP 400", r.status === 400, `status=${r.status}`);
  }

  // ---- 6) SEEDED-BAD: the oracle reports 'none' for a definitely-unassigned animal ----
  console.log("SEEDED-BAD: oracle discrimination");
  checkSeededBad("readAsg(-1) claims an assignment exists", readAsg(-1) !== null);

  // ---- restore baseline ----
  if (target) {
    await post(`/livestock-action?unit=${animalId}&action=unassign-trainer`);
    if (baseline) {
      await post(`/livestock-action?unit=${animalId}&action=assign-trainer&trainer=${baseline.anyTrainer ? -1 : baseline.trainerId}`);
    }
    const restored = readAsg(animalId);
    const ok = JSON.stringify(restored) === JSON.stringify(baseline) ||
      (!baseline && !restored);
    check("restore: animal returned to its pre-test assignment state", ok,
      `baseline=${JSON.stringify(baseline)} restored=${JSON.stringify(restored)}`);
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
