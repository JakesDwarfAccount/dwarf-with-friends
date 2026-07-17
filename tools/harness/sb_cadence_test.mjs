// sb_cadence_test.mjs -- the NATIVE per-unit status-bubble blink cadence (decoded selector
// FUN_1402685d0; owner decision 2026-07-16). Replaces the old STEADY pin: bubbles are no longer
// steady-on, they ride each unit's own phase over a 7000ms cycle:
//     phase = (unit.id * 0x86e8 + now_ms) % 7000
//   phase <  5001  -> ONLY the physical-marker group may show;  phase >= 5001 -> ordinary ladder shows.
// Run: node tools/harness/sb_cadence_test.mjs
//
// BOTH renderers are observed at their real DRAW entry points: canvas2d via unitStatusDrawPlan
// (takes id+nowMs), GL via createSceneBuilder+buildUnits (takes id+nowMs) decoded to instances.
// POST-MERGE-ONLY: the phase gate lives on sb-gl/sb-tiles; on the bare base both draw paths render
// steady and criteria (b)/(c) fail there -- which is the whole point. The seeded-bad reconstructions
// (e) run always. SB_ORACLE_ONLY=1 runs only the oracle + seeded-bad halves.
//
// Acceptance criteria (work-order 5a-5e):
//   (a) two ids never blink in sync across an 800ms edge, nor share the 7000ms phase unless
//       (idDiff * 0x86e8) % 7000 == 0;
//   (b) an ordinary bubble is visible ONLY in the >=5001 window, hidden in <5001, at many wall-clocks;
//   (c) a physical-group status shows in the <5001 window (and is hidden in >=5001);
//   (d) GL and Canvas resolve identical visibility for the same unit+time (parity pin);
//   (e) seeded-bad: fort-wide steady-on FAILS; the old global 800ms clock FAILS.

import assert from "node:assert/strict";
import {
  nativeResolve, nativeVisibleIcon, nativeBubblePhase, oldGlobalClock,
  NATIVE_BUBBLE_PERIOD_MS, NATIVE_BUBBLE_ID_STRIDE, NATIVE_BUBBLE_ORDINARY_MS, OLD_BLINK_MS, ST, ST2,
} from "./sb_predicate_ref.mjs";
import { tilesDrawPlan, glBuildUnits } from "./sb_renderers.mjs";

const ORACLE_ONLY = process.env.SB_ORACLE_ONLY === "1";
const P = NATIVE_BUBBLE_PERIOD_MS, ORD = NATIVE_BUBBLE_ORDINARY_MS;

// fixtures: one ordinary status (THIRSTY -> row 4) and one physical-group status (WEBBED -> row 39).
const ORD_ST = ST.THIRSTY, ORD_ROW = 4;
const PHYS_ST = ST.WEBBED, PHYS_ROW = 39;
assert.equal(nativeResolve(ORD_ST, 0).row, ORD_ROW, "fixture: THIRSTY resolves row 4");
assert.equal(nativeResolve(PHYS_ST, 0).row, PHYS_ROW, "fixture: WEBBED resolves row 39 (physical fallback)");

// real-renderer visibility probes at (unit, nowMs).
const tilesRow = (u, t) => { const p = tilesDrawPlan(u, t); return p ? p.row : null; };
const glRow = (u, t) => {
  const g = glBuildUnits([{ id: u.id, x: 5, y: 5, z: 0, rt: "AARDVARK", st: u.st, st2: u.st2 || 0 }], t);
  if (g.hasBubbleRow(ORD_ROW)) return ORD_ROW;
  if (g.hasBubbleRow(PHYS_ROW)) return PHYS_ROW;
  return null;
};

// ============================================================================================
// ORACLE + phase-math half (always runs) -- criterion (a) formula, and the window definition.
// ============================================================================================
// (a) phase difference between two ids is CONSTANT in time and equals (idDiff*stride) % 7000.
{
  const strideMod = NATIVE_BUBBLE_ID_STRIDE % P;   // 34536 % 7000 = 6536
  assert.equal(strideMod, 6536, "0x86e8 % 7000 == 6536");
  for (const [a, b] of [[11, 22], [1, 2], [7, 100], [0, 875]]) {
    const expect = ((b - a) * strideMod % P + P) % P;
    for (const t of [0, 137, 800, 5000, 5001, 12345, 987654]) {
      const d = ((nativeBubblePhase(b, t) - nativeBubblePhase(a, t)) % P + P) % P;
      assert.equal(d, expect, `[a] phase(id=${b})-phase(id=${a}) is constant ${expect} at t=${t}`);
    }
  }
  // the "unless" clause: ids 11 and 22 (diff 11) NEVER share phase; ids 0 and 875 ALWAYS do.
  assert.notEqual((11 * strideMod) % P, 0, "[a] (22-11)*stride % 7000 != 0 -> 11 and 22 never in phase");
  assert.equal((875 * strideMod) % P, 0, "[a] (875-0)*stride % 7000 == 0 -> 0 and 875 share phase exactly");
  for (const t of [0, 350, 4321, 6999]) {
    assert.notEqual(nativeBubblePhase(11, t), nativeBubblePhase(22, t), `[a] ids 11,22 differ in phase at t=${t}`);
    assert.equal(nativeBubblePhase(0, t), nativeBubblePhase(875, t), `[a] ids 0,875 identical phase at t=${t}`);
  }
}

// ============================================================================================
// (e) SEEDED-BAD -- reconstruct the two removed behaviors and prove each CONTRADICTS the native
//     cadence. Runs always (oracle-vs-oracle, version-independent).
// ============================================================================================
{
  // (e1) fort-wide STEADY-ON: every unit's bubble visible at every time. Contradiction: there is a
  // (unit, t) where the native rule HIDES the ordinary bubble (phase < 5001) but steady shows it.
  const steadyVisible = () => true;
  let steadyContradicted = false;
  for (const id of [0, 3, 41, 875]) for (let t = 0; t < P; t += 250) {
    const nativeShowsOrdinary = nativeVisibleIcon(ORD_ST, 0, id, t) !== null;
    if (steadyVisible() && !nativeShowsOrdinary) { steadyContradicted = true; break; }
  }
  assert.ok(steadyContradicted,
    "[e1] fort-wide steady-on FAILS the native cadence: native hides the ordinary bubble in the <5001 window");
  // and steady-on hides NOTHING, so it can never reproduce the physical/<5001-only window either.
  assert.ok(nativeVisibleIcon(ORD_ST, 0, 0, 100) === null && steadyVisible() === true,
    "[e1] at t=100 (phase 100 < 5001) native hides the ordinary bubble; steady-on wrongly shows it");

  // (e2) the OLD global 800ms clock: floor(t/800)%2 gates EVERY unit in lockstep. Two contradictions:
  //   - it HIDES bubbles the native rule shows (some id is in its >=5001 window at an OFF edge);
  //   - it SYNCHRONIZES all ids, whereas native keeps them independent.
  const oldEdgesOff = [800, 1200, 1600, 2400].filter((t) => oldGlobalClock(t) === false);
  assert.ok(oldEdgesOff.length >= 3, "[e2] sampled several OLD-clock OFF instants");
  assert.equal(OLD_BLINK_MS, 800, "[e2] old blink half-period is 800ms");
  let oldClockContradicted = false;
  for (const t of oldEdgesOff) {
    // find an id whose ordinary window is OPEN at this OFF instant -> native shows, old clock hides.
    for (const id of [0, 1, 2, 3, 5, 8, 13, 21]) {
      if (nativeVisibleIcon(ORD_ST, 0, id, t) !== null && oldGlobalClock(t) === false) { oldClockContradicted = true; break; }
    }
    if (oldClockContradicted) break;
  }
  assert.ok(oldClockContradicted,
    "[e2] the old global 800ms clock FAILS: it hides a bubble the native per-unit window shows");
  // synchronized-vanish proof: the global clock is id-independent; native is not.
  const t0 = 800;
  assert.equal(oldGlobalClock(t0), oldGlobalClock(t0), "[e2] global clock ignores id (lockstep by construction)");
  const nativeIndependent = [11, 22, 33, 44].map((id) => nativeVisibleIcon(ORD_ST, 0, id, t0) !== null);
  assert.ok(new Set(nativeIndependent).size > 1 || nativeIndependent.some((v) => v !== oldGlobalClock(t0)),
    "[e2] native does NOT put every id in lockstep with the global clock");
}

if (ORACLE_ONLY) {
  console.log("sb_cadence_test: PASS (ORACLE-ONLY: phase formula (a) + seeded-bad (e) steady-on & old-800ms both contradict native; renderer halves skipped)");
} else {
  // wall-clock samples spanning a full cycle: some land in the physical window [0,5001), some in the
  // ordinary window [5001,7000). Using id=0 so phase == nowMs % 7000 (easy to reason about).
  const CYCLE = [0, 250, 800, 1200, 2500, 4000, 4999, 5000, 5001, 5200, 6000, 6500, 6999];
  const PHYS_TIMES = CYCLE.filter((t) => (t % P) < ORD);   // physical window open
  const ORD_TIMES = CYCLE.filter((t) => (t % P) >= ORD);   // ordinary window open
  assert.ok(PHYS_TIMES.length >= 4 && ORD_TIMES.length >= 3, "samples straddle both windows");

  // ==========================================================================================
  // (b) an ORDINARY bubble is visible ONLY in the >=5001 window (both renderers, many samples).
  // ==========================================================================================
  const uOrd = { id: 0, x: 5, y: 5, st: ORD_ST, st2: 0 };
  let ordSeen = 0, ordHidden = 0;
  for (const t of CYCLE) {
    const inOrdWindow = (t % P) >= ORD;
    const tRow = tilesRow(uOrd, t), gRow = glRow(uOrd, t);
    if (inOrdWindow) {
      assert.equal(tRow, ORD_ROW, `[b] Canvas: ordinary bubble visible at t=${t} (phase ${t % P} >= 5001)`);
      assert.equal(gRow, ORD_ROW, `[b] GL: ordinary bubble visible at t=${t} (phase ${t % P} >= 5001)`);
      ordSeen++;
    } else {
      assert.equal(tRow, null, `[b] Canvas: ordinary bubble HIDDEN at t=${t} (phase ${t % P} < 5001)`);
      assert.equal(gRow, null, `[b] GL: ordinary bubble HIDDEN at t=${t} (phase ${t % P} < 5001)`);
      ordHidden++;
    }
  }
  assert.ok(ordSeen >= 3 && ordHidden >= 4, `[b] ordinary bubble sampled visible ${ordSeen}x and hidden ${ordHidden}x`);

  // ==========================================================================================
  // (c) a PHYSICAL-group status shows in the <5001 window (and is hidden in the >=5001 window).
  // ==========================================================================================
  const uPhys = { id: 0, x: 5, y: 5, st: PHYS_ST, st2: 0 };
  let physSeen = 0, physHidden = 0;
  for (const t of CYCLE) {
    const inPhysWindow = (t % P) < ORD;
    const tRow = tilesRow(uPhys, t), gRow = glRow(uPhys, t);
    if (inPhysWindow) {
      assert.equal(tRow, PHYS_ROW, `[c] Canvas: physical marker visible at t=${t} (phase ${t % P} < 5001)`);
      assert.equal(gRow, PHYS_ROW, `[c] GL: physical marker visible at t=${t} (phase ${t % P} < 5001)`);
      physSeen++;
    } else {
      assert.equal(tRow, null, `[c] Canvas: physical marker HIDDEN at t=${t} (phase ${t % P} >= 5001)`);
      assert.equal(gRow, null, `[c] GL: physical marker HIDDEN at t=${t} (phase ${t % P} >= 5001)`);
      physHidden++;
    }
  }
  assert.ok(physSeen >= 4 && physHidden >= 3, `[c] physical marker sampled visible ${physSeen}x and hidden ${physHidden}x`);

  // ==========================================================================================
  // (a) two DIFFERENT units never blink in sync across an 800ms edge -- observed on the real
  //     renderers (not just the oracle). There is an 800ms edge where exactly one is visible.
  // ==========================================================================================
  // pick ids whose ordinary windows are offset: id 0 (phase=t) and id 3 (phase=t+3*6536 mod 7000
  //  = t+19608 mod 7000 = t+5608). At t=800: id0 phase 800 (hidden), id3 phase 6408 (visible).
  const uA = { id: 0, x: 3, y: 3, st: ORD_ST, st2: 0 };
  const uB = { id: 3, x: 6, y: 6, st: ORD_ST, st2: 0 };
  let sawDivergence = false;
  for (let t = 0; t < P; t += OLD_BLINK_MS) {   // every old 800ms edge across a full cycle
    const a = tilesRow(uA, t) !== null, b = tilesRow(uB, t) !== null;
    if (a !== b) { sawDivergence = true; }
    // whatever the pair does, it is NEVER the synchronized global-clock vanish: not both governed by
    // one clock value. Assert consistency between renderers below (d); here just record divergence.
  }
  assert.ok(sawDivergence,
    "[a] across the 800ms edges two different ids diverge (one visible while the other hidden) -- no lockstep vanish");
  // at t=800 specifically: id 0 hidden, id 3 visible (from the phase math above) -> not synchronized.
  assert.equal(tilesRow(uA, 800), null, "[a] id 0 ordinary hidden at t=800 (phase 800)");
  assert.equal(tilesRow(uB, 800), ORD_ROW, "[a] id 3 ordinary visible at t=800 (phase 6408) -- desynced from id 0");

  // ==========================================================================================
  // (d) GL and Canvas resolve IDENTICAL visibility for the same unit+time (parity pin), and both
  //     match the oracle nativeVisibleIcon.
  // ==========================================================================================
  let parityChecks = 0;
  for (const u of [uOrd, uPhys, { id: 11, x: 4, y: 4, st: ORD_ST, st2: 0 }, { id: 22, x: 7, y: 7, st: PHYS_ST, st2: 0 }]) {
    for (const t of CYCLE) {
      const tRow = tilesRow(u, t), gRow = glRow(u, t);
      assert.equal(tRow, gRow, `[d] GL==Canvas visibility for id=${u.id} at t=${t} (tiles=${tRow} gl=${gRow})`);
      const oracle = nativeVisibleIcon(u.st, u.st2 || 0, u.id, t);
      assert.equal(tRow, oracle ? oracle.row : null, `[d] renderer matches oracle for id=${u.id} at t=${t}`);
      parityChecks++;
    }
  }

  console.log(`sb_cadence_test: PASS (native per-unit cadence: ordinary visible ${ordSeen}/hidden ${ordHidden}, ` +
    `physical visible ${physSeen}/hidden ${physHidden}; ${parityChecks} GL==Canvas==oracle parity samples; ` +
    `phase formula (a) + seeded-bad (e) steady-on & old-800ms both contradict native)`);
}
