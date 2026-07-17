// sb_resolver_parity_test.mjs -- work-order criterion 7: GL and Canvas resolve the SAME native row
// for EVERY supported status, both driven from the SAME status words. Also pins the shipped 18-step
// native priority for representative multi-bit combos (the one-bubble arbitration).
// Run: node tools/harness/sb_resolver_parity_test.mjs
//
// POST-MERGE-ONLY (renderer half): the shipped ladder lives on sb-gl/sb-tiles; on the bare base the
// old ladder resolves several rows differently (WEBBED/PROJECTILE in the danger tier, HUNGRY before
// THIRSTY). The nativeResolve ORACLE half runs always and passes standalone (it verifies the fixture
// declares the same winners the table specifies). SB_ORACLE_ONLY=1 runs only that half.

import assert from "node:assert/strict";
import { nativeResolve } from "./sb_predicate_ref.mjs";
import { glIcon, tilesIcon, plain, read } from "./sb_renderers.mjs";

const ORACLE_ONLY = process.env.SB_ORACLE_ONLY === "1";
const F = JSON.parse(read("tools", "harness", "fixtures", "sb-supported-rows.json"));
const tok = (o) => (o ? o.token : null);
let n = 0;

function check(entry, tag) {
  const st = Number(entry.st), st2 = Number(entry.st2);
  const want = { sheet: "unit_status.png", col: 0, row: entry.row, token: entry.token };
  // ORACLE: the fixture's declared winner IS what the native table produces (test-the-test).
  assert.equal(tok(nativeResolve(st, st2)), entry.token, `${tag} oracle winner: ${entry.name} (${entry.why || ""})`);
  assert.equal(nativeResolve(st, st2).row, entry.row, `${tag} oracle row: ${entry.name}`);
  if (!ORACLE_ONLY) {
    const g = glIcon(st, st2), t = tilesIcon(st, st2);
    assert.deepEqual(plain(g), want, `${tag} GL: ${entry.name} -> row ${entry.row}`);
    assert.deepEqual(plain(t), want, `${tag} Tiles: ${entry.name} -> row ${entry.row}`);
    // the criterion itself: the two renderers resolve the IDENTICAL row for this status.
    assert.equal(g.row, t.row, `${tag} GL==Canvas row parity: ${entry.name}`);
    assert.equal(g.token, t.token, `${tag} GL==Canvas token parity: ${entry.name}`);
  }
  n++;
}

for (const e of F.singles) check(e, "[7/single]");
for (const e of F.priority) check(e, "[7/priority]");

// coverage guard: the fixture must cover the full supported row set (0..40 minus the known gaps).
const rows = new Set(F.singles.map((e) => e.row));
for (let r = 0; r <= 40; r++) {
  if (r === 32) continue;   // YIELDING -- excluded per v1 scope (adventure-mode)
  assert.ok(rows.has(r), `criterion 7 must exercise supported unit_status row ${r}`);
}

// test-the-test: a seeded row/token mismatch is rejected, and a resolver blind to st2 would be caught.
assert.throws(() => check({ name: "seeded", st: "0x8000000", st2: "0x0", row: 3, token: "UNIT_STATUS:HUNGRY" }, "[seed]"),
  "harness rejects a wrong row/token pairing");
if (!ORACLE_ONLY) {
  assert.notEqual(glIcon(0, 0x200), null, "real GL decoder actually consumes st2 (TELLING_A_STORY)");
  assert.notEqual(tilesIcon(0, 0x200), null, "real Tiles decoder actually consumes st2");
}

console.log(`sb_resolver_parity_test: PASS (${n} statuses/combos${ORACLE_ONLY ? ", ORACLE-ONLY" : ", GL==Canvas verified"})`);
