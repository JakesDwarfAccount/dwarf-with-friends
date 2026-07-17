// sb_seeded_bad_test.mjs -- work-order criterion 9: SEEDED-BAD reconstructions of the three invented
// behaviors, each proven to FAIL the native table. Run: node tools/harness/sb_seeded_bad_test.mjs
//
// This is the "encode the bug and watch it go red" guard. It reconstructs each removed behavior from
// scratch (not by reading the shipped code) and asserts it CONTRADICTS the native table oracle:
//   (9a) the invented fort-wide clock  floor(now/800)%2  -- hides bubbles / vanishes units in lockstep;
//   (9b) broad has_unmet_needs DISTRACTED -- paints a whole busy fort yellow;
//   (9c) the invented need priority (HUNGRY before THIRSTY, STRESSED before needs).
// STANDALONE-PASSING (oracle-vs-oracle): green pre- and post-merge. The complementary proof that the
// SHIPPED renderers no longer reproduce these lives in sb_predicate_test / sb_cadence_test /
// sb_resolver_parity_test (post-merge). Keeping this suite pure means the bug definition itself is
// version-independent and can never silently pass.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeResolve, oldResolve, nativePredicate, oldPredicate,
  oldGlobalClock, nativeVisibleIcon, nativeOrdinaryVisible, OLD_BLINK_MS, ST, ST2,
} from "./sb_predicate_ref.mjs";
const HARNESS = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HARNESS, ...p), "utf8");

const tok = (o) => (o ? o.token : null);

// =================================================================================================
// (9a) TWO REMOVED CADENCES, each proven to CONTRADICT the native per-unit cadence:
//   (i)  the invented fort-wide global clock  floor(now/800)%2  -- id-independent lockstep;
//   (ii) fort-wide STEADY-ON (every unit always visible) -- the intermediate v1 behavior, also wrong.
// Native gates each unit on phase = (id*0x86e8 + now) % 7000: ordinary bubble ONLY in [5001,7000).
// =================================================================================================
{
  // (i) reconstruct the old global clock verbatim (independent of any shipped code)
  const seededClock = (t) => (Math.floor(t / 800) % 2) === 0;
  assert.equal(seededClock(0), oldGlobalClock(0), "reconstruction matches the documented old clock (ON at 0)");
  assert.equal(OLD_BLINK_MS, 800, "old blink half-period is 800ms");
  // CONTRADICTION A -- the global clock HIDES a bubble the native window shows. At t=800 it is OFF
  // (hides EVERY unit), but native id 3 is in its ordinary window (phase 6408 >= 5001) and shows.
  assert.equal(seededClock(800), false, "9a(i): the old clock is OFF at t=800 (synchronized vanish)");
  assert.ok(nativeOrdinaryVisible(3, 800),
    "9a(i): native SHOWS id 3's ordinary bubble at t=800 -- the global clock wrongly hides it (contradiction)");
  // CONTRADICTION B -- SYNCHRONIZED vanish: the global clock is id-independent; native is not. At the
  // same OFF instant native puts different ids in different states (some visible, some hidden).
  for (const t of [800, 1200, 2400].filter((x) => seededClock(x) === false)) {
    const states = [0, 3, 11, 22].map((id) => nativeOrdinaryVisible(id, t));
    assert.ok(new Set(states).size > 1,
      `9a(i): at OFF-edge t=${t} native ids are NOT in lockstep (visible set: ${JSON.stringify(states)}) -- the global clock forces them all off together`);
  }

  // (ii) fort-wide STEADY-ON: always visible for every id. Contradiction: native HIDES the ordinary
  // bubble whenever phase < 5001 -- e.g. id 0 at t=100 (phase 100). Steady-on wrongly keeps it up.
  const steadyVisible = () => true;
  let steadyContradicted = false;
  for (const id of [0, 1, 5, 42]) for (let t = 0; t < 7000; t += 200) {
    if (steadyVisible() && nativeVisibleIcon(ST.THIRSTY, 0, id, t) === null) { steadyContradicted = true; break; }
  }
  assert.ok(steadyContradicted,
    "9a(ii): fort-wide steady-on FAILS -- native hides the ordinary bubble in every unit's <5001 window");
}

// =================================================================================================
// (9b) BROAD has_unmet_needs DISTRACTION -- the mass-yellow-face root cause.
// =================================================================================================
{
  // an ordinary busy dwarf: routine unmet need, but HEALTHY focus (95%). Old paints him yellow; native does not.
  const ordinary = { has_unmet_needs: true, focus_current: 95, focus_undistracted: 100 };
  assert.ok((oldPredicate(ordinary).st2 & ST2.DISTRACTED) !== 0,
    "9b: the OLD predicate marks an ordinary unmet-needs dwarf DISTRACTED (the bug)");
  assert.equal(nativePredicate(ordinary).st2 & ST2.DISTRACTED, 0,
    "9b: the NATIVE predicate does NOT -- healthy focus (95% > 80) means no yellow face");
  // fort-scale: across the crowded fixture, old yellow-count dwarfs native yellow-count.
  const T = JSON.parse(read("fixtures", "sb-crowded-tavern.json"));
  const yellow = (pred, res) => T.units.reduce((c, u) => {
    const { st, st2 } = pred(u); const ic = res(st, st2); return c + (ic && ic.row === 7 ? 1 : 0);
  }, 0);
  const oldY = yellow(oldPredicate, oldResolve), natY = yellow(nativePredicate, nativeResolve);
  assert.ok(oldY >= T.units.length * 0.6, `9b: OLD turns >=60% of the room yellow (got ${oldY}/${T.units.length})`);
  assert.ok(natY <= T.units.length * 0.15, `9b: NATIVE keeps yellow <=15% (got ${natY}/${T.units.length})`);
  assert.ok(oldY > natY * 3, `9b: the old rule fails the table -- ${oldY} yellow vs native ${natY}`);
}

// =================================================================================================
// (9c) THE INVENTED NEED PRIORITY -- HUNGRY before THIRSTY, STRESSED before the concrete needs.
// =================================================================================================
{
  // thirsty + hungry: old resolves HUNGRY, native resolves THIRSTY (the proven order).
  assert.equal(tok(oldResolve(ST.THIRSTY | ST.HUNGRY, 0)), "UNIT_STATUS:HUNGRY", "9c: OLD picks HUNGRY for a thirsty+hungry dwarf");
  assert.equal(tok(nativeResolve(ST.THIRSTY | ST.HUNGRY, 0)), "UNIT_STATUS:THIRSTY", "9c: NATIVE picks THIRSTY");
  assert.notEqual(tok(oldResolve(ST.THIRSTY | ST.HUNGRY, 0)), tok(nativeResolve(ST.THIRSTY | ST.HUNGRY, 0)),
    "9c: the old need order CONTRADICTS the native table");
  // stressed + hungry: old resolves STRESSED, native resolves HUNGRY (a concrete need outranks stress).
  assert.equal(tok(oldResolve(ST.STRESSED | ST.HUNGRY, 0)), "UNIT_STATUS:STRESSED", "9c: OLD picks STRESSED over a need");
  assert.equal(tok(nativeResolve(ST.STRESSED | ST.HUNGRY, 0)), "UNIT_STATUS:HUNGRY", "9c: NATIVE puts the concrete need first");
  assert.notEqual(tok(oldResolve(ST.STRESSED | ST.HUNGRY, 0)), tok(nativeResolve(ST.STRESSED | ST.HUNGRY, 0)),
    "9c: the old stress-over-needs order CONTRADICTS the native table");
}

// ---- test-the-test: the seeded reconstructions must be DISTINGUISHABLE from native (non-vacuous) --
// If someone "fixed" a reconstruction to equal native, these guards fire.
assert.notDeepEqual(
  [tok(oldResolve(ST.THIRSTY | ST.HUNGRY, 0)), (oldPredicate({ has_unmet_needs: true, focus_current: 95, focus_undistracted: 100 }).st2 & ST2.DISTRACTED)],
  [tok(nativeResolve(ST.THIRSTY | ST.HUNGRY, 0)), (nativePredicate({ has_unmet_needs: true, focus_current: 95, focus_undistracted: 100 }).st2 & ST2.DISTRACTED)],
  "the seeded-bad reconstructions genuinely differ from native (else the guard is vacuous)");

console.log("sb_seeded_bad_test: PASS (old global clock, broad-unmet-needs distraction, and inverted " +
  "need priority each reconstructed and proven to contradict the native table)");
