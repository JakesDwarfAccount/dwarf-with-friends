// sb_predicate_test.mjs -- NATIVE-TABLE predicate + resolution acceptance (work-order criteria
// 1, 2, 5, 6). Run: node tools/harness/sb_predicate_test.mjs
//
// WHAT THIS PINS, and against WHAT. The bubble a dwarf shows is two hops:
//   (A) SERVER  raw native fields -> the two status words st/st2   (src/unit_status.h)
//   (B) CLIENT  st/st2 -> one unit_status.png row                  (both renderers' resolver)
// (A) cannot be executed from C++, so sb_predicate_ref.nativePredicate is a faithful JS mirror of
// the native predicate table (internal analysis notes; see sb_predicate_ref.mjs); sb_predicate_source_test.mjs pins
// the C++ to the SAME fields+boundaries. (B) is executed against BOTH real renderers.
//
// PRE/POST MERGE. The nativePredicate + nativeResolve ORACLE assertions run always and pass on the
// bare base -- they verify the fixtures encode the table (test-the-test). The REAL-renderer
// assertions require the merged sb-gl/sb-tiles ladder and so are POST-MERGE-ONLY: on the pre-merge
// base they fail (old ladder puts HUNGRY before THIRSTY, etc). Set SB_ORACLE_ONLY=1 to run only the
// oracle half (exits 0 standalone) -- used to prove the expectations themselves are self-consistent.

import assert from "node:assert/strict";
import { nativePredicate, oldPredicate, nativeResolve, oldResolve, focusPct, ST, ST2, NEED, BOUND } from "./sb_predicate_ref.mjs";
import { glIcon, tilesIcon, read } from "./sb_renderers.mjs";

const ORACLE_ONLY = process.env.SB_ORACLE_ONLY === "1";
const tok = (o) => (o ? o.token : null);
const row = (o) => (o ? o.row : null);
let checks = 0;

// Assert a raw-field unit produces the expected two status words under the native table.
function bitsFromRaw(raw, expSt, expSt2, why) {
  const r = nativePredicate(raw);
  assert.equal(r.st >>> 0, expSt >>> 0, `nativePredicate st: ${why} (got 0x${(r.st>>>0).toString(16)} want 0x${(expSt>>>0).toString(16)})`);
  assert.equal(r.st2 >>> 0, expSt2 >>> 0, `nativePredicate st2: ${why} (got 0x${(r.st2>>>0).toString(16)} want 0x${(expSt2>>>0).toString(16)})`);
  checks++;
}
// Assert st/st2 resolve to expected row/token: ALWAYS via the oracle; POST-MERGE also both renderers.
function resolvesTo(st, st2, expRow, expToken, why) {
  assert.equal(tok(nativeResolve(st, st2)), expToken, `oracle resolve: ${why}`);
  assert.equal(row(nativeResolve(st, st2)), expRow, `oracle resolve row: ${why}`);
  if (!ORACLE_ONLY) {
    const g = glIcon(st, st2), t = tilesIcon(st, st2);
    assert.equal(tok(g), expToken, `GL resolve: ${why}`);
    assert.equal(tok(t), expToken, `Tiles resolve: ${why}`);
    assert.equal(row(g), row(t), `GL/Tiles row parity: ${why}`);
  }
  checks++;
}

// =================================================================================================
// CRITERION 6 -- boundary fixtures (raw fields -> words -> row), the native table's exact cutoffs.
// =================================================================================================
const B = JSON.parse(read("tools", "harness", "fixtures", "sb-boundaries.json"));
for (const c of B.cases) {
  const st = Number(c.expect.st), st2 = Number(c.expect.st2);
  bitsFromRaw(c.raw, st, st2, `[6/${c.crit}] ${c.name}`);
  resolvesTo(st, st2, c.expect.row, c.expect.token, `[6/${c.crit}] ${c.name}`);
}
// coverage guard: every criterion-6 sub-topic named by the work order is present in the fixture.
for (const crit of ["stress", "focus", "paralysis", "sleep_rest", "dizziness", "preacher", "terror"])
  assert.ok(B.cases.some((c) => c.crit === crit), `criterion 6 must cover '${crit}'`);

// =================================================================================================
// CRITERION 2 -- focus boundary trio (explicit, the mass-yellow-face root cause).
// A unit ABOVE the native focus cut gets NO yellow row-7; boundary and below-boundary units DO.
// =================================================================================================
assert.equal(focusPct({ focus_current: 81, focus_undistracted: 100 }), 81, "test-the-test: 81/100 == 81%");
bitsFromRaw({ focus_current: 81, focus_undistracted: 100 }, 0, 0, "[2] focus 81% is ABOVE the 80 cut -> no DISTRACTED bit");
resolvesTo(0, 0, null, null, "[2] focus 81% -> no bubble");
bitsFromRaw({ focus_current: 80, focus_undistracted: 100 }, 0, ST2.DISTRACTED, "[2] focus 80% is AT the cut -> DISTRACTED bit");
resolvesTo(0, ST2.DISTRACTED, 7, "UNIT_STATUS:DISTRACTED", "[2] focus 80% -> row 7");
bitsFromRaw({ focus_current: 40, focus_undistracted: 100 }, 0, ST2.DISTRACTED, "[2] focus 40% is BELOW the cut -> DISTRACTED bit");
resolvesTo(0, ST2.DISTRACTED, 7, "UNIT_STATUS:DISTRACTED", "[2] focus 40% -> row 7");
// the gate: an ordinary busy dwarf with unmet needs but HEALTHY focus draws nothing (the whole fix).
bitsFromRaw({ has_unmet_needs: true, focus_current: 95, focus_undistracted: 100 }, 0, 0,
  "[2] has_unmet_needs is IGNORED -- healthy focus -> no DISTRACTED");

// =================================================================================================
// CRITERION 5 -- a unit eligible for THIRSTY, HUNGRY and DROWSY resolves to THIRSTY in both renderers.
// =================================================================================================
const triple = nativePredicate({ thirst_timer: NEED.THIRST, hunger_timer: NEED.HUNGER, sleepiness_timer: NEED.SLEEP });
assert.equal(triple.st >>> 0, (ST.THIRSTY | ST.HUNGRY | ST.DROWSY) >>> 0, "[5] all three need bits set at their thresholds");
resolvesTo(triple.st, triple.st2, 4, "UNIT_STATUS:THIRSTY", "[5] thirsty+hungry+drowsy -> THIRSTY");

// =================================================================================================
// CRITERION 1 -- a realistic crowded tavern with ORDINARY unmet needs must NOT be mostly DISTRACTED.
// The core work-order scenario: a room of routine dwarves must produce FEW bubbles, not a wall of
// yellow. Driven from RAW fields through nativePredicate; the differential test-the-test proves the
// same room WOULD be a wall of yellow under the old has_unmet_needs predicate.
// =================================================================================================
const T = JSON.parse(read("tools", "harness", "fixtures", "sb-crowded-tavern.json"));
assert.equal(T.units.length, T.expect.population, "crowded fixture population matches its declared count");

function census(predicate, resolve) {
  let distracted = 0, bubbles = 0;
  for (const u of T.units) {
    const { st, st2 } = predicate(u);
    const ic = resolve(st, st2);
    if (ic) bubbles++;
    if (ic && ic.row === 7) distracted++;
  }
  return { distracted, bubbles, n: T.units.length };
}
// NATIVE: few bubbles, almost no yellow.
const nat = census(nativePredicate, nativeResolve);
assert.ok(nat.distracted / nat.n <= T.expect.native_distracted_max_fraction,
  `[1] NATIVE distracted ${nat.distracted}/${nat.n} must be <= ${T.expect.native_distracted_max_fraction} of the room`);
assert.ok(nat.bubbles / nat.n <= T.expect.native_total_bubble_max_fraction,
  `[1] NATIVE total bubbles ${nat.bubbles}/${nat.n} must be <= ${T.expect.native_total_bubble_max_fraction} of the room`);
// TEST-THE-TEST: the OLD predicate turns the SAME room into a wall of yellow -- proving the fixture
// genuinely exercises the bug and the native numbers above are not vacuous.
const old = census(oldPredicate, oldResolve);
assert.ok(old.distracted / old.n >= T.expect.old_distracted_min_fraction,
  `[1] guard: OLD predicate must make >= ${T.expect.old_distracted_min_fraction} of the room DISTRACTED (got ${old.distracted}/${old.n}) -- else the fixture doesn't trigger the bug`);
assert.ok(old.distracted > nat.distracted * 3,
  `[1] guard: old yellow count (${old.distracted}) must dwarf native's (${nat.distracted})`);

// POST-MERGE: the same native words rendered by the REAL renderers give the same small yellow count.
if (!ORACLE_ONLY) {
  let glYellow = 0, tiYellow = 0;
  for (const u of T.units) {
    const { st, st2 } = nativePredicate(u);
    if ((glIcon(st, st2) || {}).row === 7) glYellow++;
    if ((tilesIcon(st, st2) || {}).row === 7) tiYellow++;
  }
  assert.equal(glYellow, nat.distracted, "[1] GL yellow count matches the oracle census");
  assert.equal(tiYellow, nat.distracted, "[1] Tiles yellow count matches the oracle census");
}

// ---- test-the-test: a seeded-WRONG expectation must be rejected by this harness -----------------
assert.throws(() => bitsFromRaw({ stress: 9999 }, ST.STRESSED, 0, "seeded: stress 9999 wrongly claims STRESSED"),
  "harness rejects a raw->bits expectation that contradicts the table");
assert.throws(() => resolvesTo(ST.THIRSTY | ST.HUNGRY, 0, 3, "UNIT_STATUS:HUNGRY", "seeded: hungry-first"),
  "harness rejects the OLD hungry-first winner for a thirsty+hungry unit");

console.log(`sb_predicate_test: PASS (${checks} checks${ORACLE_ONLY ? ", ORACLE-ONLY" : ", incl. both renderers"}); ` +
  `crowded room native ${nat.distracted}/${nat.n} yellow vs old ${old.distracted}/${old.n}`);
