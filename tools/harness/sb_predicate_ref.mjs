// sb_predicate_ref.mjs -- REFERENCE ORACLE for the V1 status-bubble native predicate table.
// NOT a *_test.mjs (so the CI harness runner never executes it as a suite). It is imported by the
// sb_*_test.mjs suites as the spec oracle.
//
// AUTHORITY. Every value here is transcribed from a verified predicate table (internal analysis
// notes, not included in this distribution) which was itself decoded from the native
// graphics-mode overhead selector FUN_1402685d0 (a private decompilation workspace; per the
// rules-ledger policy, no decompiled excerpts are committed). Table row citations are given as "sel:N" /
// "table §X" in the comments. This module encodes the TABLE, not the current shipped code -- the
// current code is the thing under test and (on the pre-merge base) DISAGREES with this oracle.
//
// WHY AN ORACLE AND NOT JUST HARD-CODED EXPECTATIONS. status_truth_test.mjs's B280 doctrine: a test
// that asserts what we wrote proves nothing. So the executable expectations here are cross-checked
// three ways by the suites that import them:
//   (1) against BOTH real renderers' resolvers  (post-merge: they must match nativeResolve);
//   (2) against src/unit_status.h via source-pin regex  (post-merge: the C++ must implement the
//       same fields + boundaries this oracle uses);
//   (3) against the OLD implementations reconstructed here (oldResolve/oldPredicate/oldGlobalClock)
//       which MUST diverge -- the seeded-bad guard that proves the fixtures actually exercise the bug.
//
// The oracle deliberately mirrors the *scoped* v1 change (work-order + my handoff): the danger /
// mood / activity tiers of the ladder are UNCHANGED from the current client resolver; ONLY the
// needs/stress/distracted subgroup is reordered to the proven native order
//   THIRSTY > HUNGRY > DROWSY > STRESSED > DISTRACTED
// (table §NATIVE PRIORITY step 13, "PROVEN: THIRSTY>HUNGRY>DROWSY"). That is exactly what the two
// renderer workers implement, so post-merge nativeResolve == both renderers for every supported row.

// ---------------------------------------------------------------------------------------------
// BIT CONSTANTS -- mirror of src/unit_status.h kUStat* / kUStat2* and the renderers' USTAT_* .
// ---------------------------------------------------------------------------------------------
export const ST = {
  SLEEPING: 0x00000001, UNCONSCIOUS: 0x00000002, STRESSED: 0x00000004,
  WINDED: 0x00000200, STUNNED: 0x00000400, NAUSEA: 0x00000800, WEBBED: 0x00001000,
  PARALYZED: 0x00002000, FEVERED: 0x00004000, GROUNDED: 0x00008000, PROJECTILE: 0x00010000,
  CLIMBING: 0x00020000, MELANCHOLY: 0x00040000, MADNESS: 0x00080000, BERSERK: 0x00100000,
  MARTIAL_TRANCE: 0x00200000, ENRAGED: 0x00400000, TANTRUM: 0x00800000, DEPRESSION: 0x01000000,
  OBLIVIOUS: 0x02000000, HUNGRY: 0x04000000, THIRSTY: 0x08000000, DROWSY: 0x10000000,
  // pre-WT29 mood nibble
  STRANGE_MOOD: 0x00000008, MOOD_MASK: 0x000001C0, MOOD_SHIFT: 6,
  CAGED: 0x00000010, CHAINED: 0x00000020,
};
export const ST2 = {
  MIGRANT: 0x00000001, NO_JOB: 0x00000002, NO_DESTINATION: 0x00000004, DISTRACTED: 0x00000008,
  TERRIFIED: 0x00000010, WRESTLING: 0x00000020, MINOR_INJURY: 0x00000040, MAJOR_INJURY: 0x00000080,
  MAKE_BELIEVE: 0x00000100, TELLING_A_STORY: 0x00000200, RECITING_POETRY: 0x00000400, PERFORMING: 0x00000800,
};

// Native per-need timer boundaries (table rows THIRSTY/HUNGRY/DROWSY; sel:173/176/179).
export const NEED = { THIRST: 25000, HUNGER: 50000, SLEEP: 57600 };
// Native scalar boundaries.
export const BOUND = { STRESS: 10000, PARALYSIS: 100, FOCUS_PCT: 80 };

// row/token map for the rows this oracle can return (unit_status.png / graphics_interface.txt).
const ROW = {
  MIGRANT: [0, "MIGRANT"], NO_JOB: [1, "NO_JOB"], NO_DESTINATION: [2, "NO_DESTINATION"],
  HUNGRY: [3, "HUNGRY"], THIRSTY: [4, "THIRSTY"], DROWSY: [5, "DROWSY"], STRESSED: [6, "STRESSED"],
  DISTRACTED: [7, "DISTRACTED"], SLEEPING: [8, "SLEEPING"],
  TANTRUM: [14, "TANTRUM"], OBLIVIOUS: [15, "OBLIVIOUS"], DEPRESSION: [16, "DEPRESSION"],
  MADNESS: [17, "MADNESS"], MELANCHOLY: [18, "MELANCHOLY"], BERSERK: [19, "BERSERK"],
  ENRAGED: [20, "ENRAGED"], MARTIAL_TRANCE: [21, "MARTIAL_TRANCE"], TERRIFIED: [22, "TERRIFIED"],
  WRESTLING: [23, "WRESTLING"], MINOR_INJURY: [24, "MINOR_INJURY"], MAJOR_INJURY: [25, "MAJOR_INJURY"],
  PARALYZED: [26, "PARALYZED"], STUNNED: [27, "STUNNED"], NAUSEA: [28, "NAUSEA"], WINDED: [29, "WINDED"],
  UNCONSCIOUS: [30, "UNCONSCIOUS"], FEVERED: [31, "FEVERED"], PLAYING_MAKE_BELIEVE: [33, "PLAYING_MAKE_BELIEVE"],
  TELLING_A_STORY: [34, "TELLING_A_STORY"], RECITING_POETRY: [35, "RECITING_POETRY"], PERFORMING: [36, "PERFORMING"],
  PROJECTILE: [37, "PROJECTILE"], GROUNDED: [38, "GROUNDED"], WEBBED: [39, "WEBBED"], CLIMBING: [40, "CLIMBING"],
};
// nibble tokens transcribed from both renderers' MOOD_CELL (dwf-gl.js:1139) -- verified GL==Tiles.
const MOOD_NIBBLE_ROW = { 1: [9, "FEY_MOOD"], 2: [10, "POSSESSED"], 3: [11, "SECRETIVE_MOOD"], 4: [12, "FELL_MOOD"], 5: [13, "MACABRE_MOOD"] };
const cell = (k) => ({ sheet: "unit_status.png", col: 0, row: ROW[k][0], token: "UNIT_STATUS:" + ROW[k][1] });

// ---------------------------------------------------------------------------------------------
// nativeResolve(st, st2) -> {sheet,col,row,token} | null
// THE SHIPPED 18-STEP NATIVE LADDER, as reported final by the finished GL renderer worker
// (coordination msg 2026-07-16) and matching table §NATIVE PRIORITY. BOTH renderers implement
// exactly this order, so post-merge nativeResolve == GL == Canvas for every supported row. Any
// divergence here would (correctly) turn the renderer-parity assertions red.
//   1 SLEEPING 2 UNCONSCIOUS 3 PARALYZED 4 activity(34>35>36>33) 5 WRESTLING 6 NAUSEA 7 STUNNED
//   8 WINDED 9 MAJOR_INJURY 10 MINOR_INJURY 11 FEVERED
//   12 THIRSTY>HUNGRY>DROWSY>STRESSED>DISTRACTED
//   13 soldier MARTIAL_TRANCE(21)>ENRAGED(20)>TANTRUM(14)>DEPRESSION(16)>OBLIVIOUS(15)
//   14 NO_JOB(1)>NO_DESTINATION(2)
//   15 insane BERSERK(19)>MADNESS(17)>MELANCHOLY(18)>nibble(9-13)>default TERRIFIED(22)
//   16 MIGRANT(0)   17 physical PROJECTILE(37)>GROUNDED(38)>CLIMBING(40)>WEBBED(39)   18 caged/chained -> null
// KEY MOVES vs the old base ladder (the two expected pre-merge failures GL called out): WEBBED and
// PROJECTILE dropped OUT of the danger tier into the physical fallback (step 17); needs now precede
// stress/distraction and the mood groups.
// ---------------------------------------------------------------------------------------------
export function nativeResolve(st, st2) {
  st = st | 0; st2 = st2 | 0;
  if (st & ST.SLEEPING) return cell("SLEEPING");                 // 1
  if (st & ST.UNCONSCIOUS) return cell("UNCONSCIOUS");           // 2
  if (st & ST.PARALYZED) return cell("PARALYZED");              // 3
  if (st2 & ST2.TELLING_A_STORY) return cell("TELLING_A_STORY"); // 4 (PREACHER lands here server-side)
  if (st2 & ST2.RECITING_POETRY) return cell("RECITING_POETRY");
  if (st2 & ST2.PERFORMING) return cell("PERFORMING");
  if (st2 & ST2.MAKE_BELIEVE) return cell("PLAYING_MAKE_BELIEVE");
  if (st2 & ST2.WRESTLING) return cell("WRESTLING");            // 5
  if (st & ST.NAUSEA) return cell("NAUSEA");                    // 6
  if (st & ST.STUNNED) return cell("STUNNED");                  // 7
  if (st & ST.WINDED) return cell("WINDED");                    // 8
  if (st2 & ST2.MAJOR_INJURY) return cell("MAJOR_INJURY");      // 9
  if (st2 & ST2.MINOR_INJURY) return cell("MINOR_INJURY");      // 10
  if (st & ST.FEVERED) return cell("FEVERED");                  // 11
  // 12 needs / stress / distraction (proven native order)
  if (st & ST.THIRSTY) return cell("THIRSTY");
  if (st & ST.HUNGRY) return cell("HUNGRY");
  if (st & ST.DROWSY) return cell("DROWSY");
  if (st & ST.STRESSED) return cell("STRESSED");
  if (st2 & ST2.DISTRACTED) return cell("DISTRACTED");
  // 13 soldier mood
  if (st & ST.MARTIAL_TRANCE) return cell("MARTIAL_TRANCE");
  if (st & ST.ENRAGED) return cell("ENRAGED");
  if (st & ST.TANTRUM) return cell("TANTRUM");
  if (st & ST.DEPRESSION) return cell("DEPRESSION");
  if (st & ST.OBLIVIOUS) return cell("OBLIVIOUS");
  // 14 idle work-state
  if (st2 & ST2.NO_JOB) return cell("NO_JOB");
  if (st2 & ST2.NO_DESTINATION) return cell("NO_DESTINATION");
  // 15 insane mood + strange-mood nibble + TERRIFIED default
  if (st & ST.BERSERK) return cell("BERSERK");
  if (st & ST.MADNESS) return cell("MADNESS");
  if (st & ST.MELANCHOLY) return cell("MELANCHOLY");
  if (st & ST.STRANGE_MOOD) {
    const mc = MOOD_NIBBLE_ROW[(st & ST.MOOD_MASK) >> ST.MOOD_SHIFT] || MOOD_NIBBLE_ROW[1];
    return { sheet: "unit_status.png", col: 0, row: mc[0], token: "UNIT_STATUS:" + mc[1] };
  }
  if (st2 & ST2.TERRIFIED) return cell("TERRIFIED");
  // 16 arrival
  if (st2 & ST2.MIGRANT) return cell("MIGRANT");
  // 17 physical fallback (WEBBED/PROJECTILE now live HERE, not the danger tier)
  if (st & ST.PROJECTILE) return cell("PROJECTILE");
  if (st & ST.GROUNDED) return cell("GROUNDED");
  if (st & ST.CLIMBING) return cell("CLIMBING");
  if (st & ST.WEBBED) return cell("WEBBED");
  // 18 caged/chained -> no overhead cell
  return null;
}

// ---------------------------------------------------------------------------------------------
// oldResolve(st, st2) -- the CURRENT (pre-merge) BASE client ladder, transcribed verbatim from
// dwf-gl.js:1201-1250 on practical/v1-candidate. Used ONLY by the seeded-bad guards to prove the
// native reorder changes observable outcomes. On the pre-merge base this MUST equal the real
// renderers (a standalone test-the-test); post-merge the real renderers move to nativeResolve. NOT
// the spec.
// ---------------------------------------------------------------------------------------------
export function oldResolve(st, st2) {
  st = st | 0; st2 = st2 | 0;
  if (st & ST.SLEEPING) return cell("SLEEPING");
  if (st & ST.UNCONSCIOUS) return cell("UNCONSCIOUS");
  if (st & ST.PROJECTILE) return cell("PROJECTILE");           // OLD: projectile in danger tier
  if (st2 & ST2.MAJOR_INJURY) return cell("MAJOR_INJURY");
  if (st & ST.PARALYZED) return cell("PARALYZED");
  if (st & ST.WEBBED) return cell("WEBBED");                   // OLD: webbed in danger tier
  if (st2 & ST2.WRESTLING) return cell("WRESTLING");
  if (st & ST.GROUNDED) return cell("GROUNDED");
  if (st & ST.STUNNED) return cell("STUNNED");
  if (st & ST.WINDED) return cell("WINDED");
  if (st2 & ST2.TERRIFIED) return cell("TERRIFIED");
  if (st & ST.FEVERED) return cell("FEVERED");
  if (st & ST.NAUSEA) return cell("NAUSEA");
  if (st2 & ST2.MINOR_INJURY) return cell("MINOR_INJURY");
  if (st & ST.BERSERK) return cell("BERSERK");
  if (st & ST.MADNESS) return cell("MADNESS");
  if (st & ST.MELANCHOLY) return cell("MELANCHOLY");
  if (st & ST.ENRAGED) return cell("ENRAGED");
  if (st & ST.MARTIAL_TRANCE) return cell("MARTIAL_TRANCE");
  if (st & ST.TANTRUM) return cell("TANTRUM");
  if (st & ST.DEPRESSION) return cell("DEPRESSION");
  if (st & ST.OBLIVIOUS) return cell("OBLIVIOUS");
  if (st & ST.STRANGE_MOOD) {
    const mc = MOOD_NIBBLE_ROW[(st & ST.MOOD_MASK) >> ST.MOOD_SHIFT] || MOOD_NIBBLE_ROW[1];
    return { sheet: "unit_status.png", col: 0, row: mc[0], token: "UNIT_STATUS:" + mc[1] };
  }
  if (st2 & ST2.TELLING_A_STORY) return cell("TELLING_A_STORY");
  if (st2 & ST2.RECITING_POETRY) return cell("RECITING_POETRY");
  if (st2 & ST2.PERFORMING) return cell("PERFORMING");
  if (st2 & ST2.MAKE_BELIEVE) return cell("PLAYING_MAKE_BELIEVE");
  if (st & ST.CLIMBING) return cell("CLIMBING");
  if (st & ST.STRESSED) return cell("STRESSED");               // OLD: stress before needs
  if (st & ST.HUNGRY) return cell("HUNGRY");                   // OLD: hungry before thirsty
  if (st & ST.THIRSTY) return cell("THIRSTY");
  if (st & ST.DROWSY) return cell("DROWSY");
  if (st2 & ST2.DISTRACTED) return cell("DISTRACTED");
  if (st2 & ST2.MIGRANT) return cell("MIGRANT");
  if (st2 & ST2.NO_JOB) return cell("NO_JOB");
  if (st2 & ST2.NO_DESTINATION) return cell("NO_DESTINATION");
  return null;
}

// ---------------------------------------------------------------------------------------------
// nativePredicate(raw) -> {st, st2}  --  RAW native unit fields -> the two status words.
// This is the SERVER's job (src/unit_status.h). It cannot be executed from the C++, so this JS
// mirror encodes the same fields+boundaries; sb_predicate_source_test.mjs pins the C++ to match.
// `raw` fields (all optional, default 0 / -1 for the mood gates):
//   hunger_timer, thirst_timer, sleepiness_timer   (counters2.*)
//   focus_current, focus_undistracted              (soul.cur_focus / undistracted_focus)  -> focus%
//   stress                                         (soul.personality.stress, RAW not longterm)
//   paralysis, stunned, dizziness, nausea, winded, fever, unconscious, webbed
//   on_ground, projectile                          (flags1.*)
//   emotionally_overloaded                         (flags3 bit25 -- TERRIFIED named-approx gate)
//   mood (int16, -1=none), soldier_mood (int16, -1=none)
//   job                 ("Sleep" | "Rest" | other)
//   performance_role    ("PREACHER" | 0 | 1 | 2 | 3 | "MAKE_BELIEVE" | null)
// ---------------------------------------------------------------------------------------------
export function nativePredicate(raw) {
  const r = raw || {};
  let st = 0, st2 = 0;
  const g = (k, d) => (typeof r[k] === "number" ? r[k] : (r[k] === undefined ? d : 0));
  const mood = (r.mood === undefined ? -1 : r.mood);
  const soldierMood = (r.soldier_mood === undefined ? -1 : r.soldier_mood);
  const moodGate = (mood === -1 && soldierMood === -1);   // STRESSED/DISTRACTED self-gate (sel:184/188)

  // danger / physical
  if (g("paralysis", 0) >= BOUND.PARALYSIS) st |= ST.PARALYZED;                 // sel:78 >=100
  if (g("stunned", 0) > 0 || g("dizziness", 0) > 0) st |= ST.STUNNED;           // sel:156 stunned OR dizziness
  if (g("nausea", 0) > 0) st |= ST.NAUSEA;
  if (g("winded", 0) > 0 && !r.drowning) st |= ST.WINDED;                       // sel:159 winded>0 && !flags1.drowning
  if (g("fever", 0) > 0) st |= ST.FEVERED;
  if (r.on_ground) st |= ST.GROUNDED;
  if (r.projectile) st |= ST.PROJECTILE;
  if (g("webbed", 0) > 9) st |= ST.WEBBED;                                       // sel:44 native boundary > 9 (>=10)

  // sleep vs KO (sel:60-70): unconscious + Sleep|Rest job -> SLEEPING, else UNCONSCIOUS
  if (g("unconscious", 0) > 0) {
    if (r.job === "Sleep" || r.job === "Rest") st |= ST.SLEEPING;              // v1 named-approx: Sleep OR Rest
    else st |= ST.UNCONSCIOUS;
  }

  // performance role (sel:130-132): PREACHER(6)+role0 -> TELLING_A_STORY(34)
  switch (r.performance_role) {
    case "PREACHER": case 0: st2 |= ST2.TELLING_A_STORY; break;
    case 1: st2 |= ST2.RECITING_POETRY; break;
    case 2: case 3: st2 |= ST2.PERFORMING; break;
    case "MAKE_BELIEVE": st2 |= ST2.MAKE_BELIEVE; break;
    default: break;                                                            // roles 4/5 spectators -> none
  }

  // TERRIFIED: named-approx, flags3 bit25 gate ONLY (NO dominant-emotion walk) -- table row TERRIFIED
  if (r.emotionally_overloaded) st2 |= ST2.TERRIFIED;

  // graded needs (sel:173/176/179)
  if (g("thirst_timer", 0) >= NEED.THIRST) st |= ST.THIRSTY;
  if (g("hunger_timer", 0) >= NEED.HUNGER) st |= ST.HUNGRY;
  if (g("sleepiness_timer", 0) >= NEED.SLEEP) st |= ST.DROWSY;

  // STRESSED: raw stress >= 10000, gated (sel:184)
  if (moodGate && g("stress", 0) >= BOUND.STRESS) st |= ST.STRESSED;

  // DISTRACTED: focus% <= 80, gated (sel:188-198). NOT has_unmet_needs.
  if (moodGate && focusPct(r) !== null && focusPct(r) <= BOUND.FOCUS_PCT) st2 |= ST2.DISTRACTED;

  return { st: st >>> 0, st2: st2 >>> 0 };
}
export function focusPct(raw) {
  const r = raw || {};
  const cur = r.focus_current, und = r.focus_undistracted;
  if (typeof cur !== "number" || typeof und !== "number") return null;   // fields absent -> unknown
  if (und < 1) return 100;   // server rule: undistracted_focus < 1 forces ratio to 100 (never distracted)
  return (cur * 100) / und;
}

// ---------------------------------------------------------------------------------------------
// oldPredicate(raw) -- the INVENTED pre-merge server predicate. DISTRACTED from has_unmet_needs
// (true for a huge fraction of any fort); STRESSED from longterm_stress>=20000; PARALYSIS>0; no
// dizziness branch; SLEEPING only on job=="Sleep". Used by the seeded-bad + crowded guards to prove
// the fixture actually triggers the mass-yellow bug under the old rules. NOT the spec.
// ---------------------------------------------------------------------------------------------
export function oldPredicate(raw) {
  const r = raw || {};
  let st = 0, st2 = 0;
  const g = (k, d) => (typeof r[k] === "number" ? r[k] : (r[k] === undefined ? d : 0));
  if (g("paralysis", 0) > 0) st |= ST.PARALYZED;                 // OLD boundary
  if (g("stunned", 0) > 0) st |= ST.STUNNED;                     // OLD: no dizziness branch
  if (g("nausea", 0) > 0) st |= ST.NAUSEA;
  if (g("winded", 0) > 0) st |= ST.WINDED;
  if (g("fever", 0) > 0) st |= ST.FEVERED;
  if (r.on_ground) st |= ST.GROUNDED;
  if (r.projectile) st |= ST.PROJECTILE;
  if (g("webbed", 0) > 0) st |= ST.WEBBED;
  if (g("unconscious", 0) > 0) { if (r.job === "Sleep") st |= ST.SLEEPING; else st |= ST.UNCONSCIOUS; }
  if (g("thirst_timer", 0) >= NEED.THIRST) st |= ST.THIRSTY;
  if (g("hunger_timer", 0) >= NEED.HUNGER) st |= ST.HUNGRY;
  if (g("sleepiness_timer", 0) >= NEED.SLEEP) st |= ST.DROWSY;
  if (g("longterm_stress", 0) >= 20000) st |= ST.STRESSED;       // OLD field + boundary
  if (r.has_unmet_needs) st2 |= ST2.DISTRACTED;                  // OLD: the mass-yellow root cause
  return { st: st >>> 0, st2: st2 >>> 0 };
}

// ---------------------------------------------------------------------------------------------
// CADENCE oracles -- the NATIVE per-unit blink cadence (decoded selector FUN_1402685d0; owner
// decision 2026-07-16). Native staggers EVERY unit's bubble on its own phase over a 7000ms cycle:
//     phase = (unit.id * 0x86e8 + now_ms) % 7000
//   phase <  5001  -> ONLY the physical-marker group (PROJECTILE/WEBBED/GROUNDED/CLIMBING) may show.
//   phase >= 5001  -> the main ordinary ladder shows (~2s window).
// There is NO fort-wide synchronization: two ids only ever share a phase when
// (idDiff * 0x86e8) % 7000 == 0. `nativeVisibleIcon` combines this window with nativeResolve so the
// oracle reports the exact icon a faithful renderer draws at (id, nowMs).
// oldGlobalClock(nowMs) -- the invented fort-wide gate that was REMOVED (table §CADENCE):
//   unitStatusBlinkVisible = floor(now/800)%2  -- every unit blinks in lockstep.
// ---------------------------------------------------------------------------------------------
export const OLD_BLINK_MS = 800;
export const NATIVE_BUBBLE_PERIOD_MS = 7000;
export const NATIVE_BUBBLE_ID_STRIDE = 0x86e8;
export const NATIVE_BUBBLE_ORDINARY_MS = 5001;
export function oldGlobalClock(nowMs) { return (Math.floor(nowMs / OLD_BLINK_MS) % 2) === 0; }
export function nativeBubblePhase(unitId, nowMs) {
  const id = (unitId >>> 0);
  const idPhase = ((id % NATIVE_BUBBLE_PERIOD_MS) * (NATIVE_BUBBLE_ID_STRIDE % NATIVE_BUBBLE_PERIOD_MS)) % NATIVE_BUBBLE_PERIOD_MS;
  let t = Math.floor(nowMs) % NATIVE_BUBBLE_PERIOD_MS; if (t < 0) t += NATIVE_BUBBLE_PERIOD_MS;
  return (idPhase + t) % NATIVE_BUBBLE_PERIOD_MS;
}
// the physical-marker group alone (native tier 18), intra-tier order PROJECTILE>GROUNDED>CLIMBING>WEBBED.
export function physicalResolve(st) {
  st = st | 0;
  if (st & ST.PROJECTILE) return cell("PROJECTILE");
  if (st & ST.GROUNDED) return cell("GROUNDED");
  if (st & ST.CLIMBING) return cell("CLIMBING");
  if (st & ST.WEBBED) return cell("WEBBED");
  return null;
}
// the ordinary ladder = nativeResolve minus the physical fallback (rows 37-40). The 37-40 strip is
// not derived from the renderers: it is pinned by external evidence (unit_status.h WEBBED/sel:44
// commentary + community-packet finding 2 for selector 0x1402685d0 — physical group is exactly
// {37,38,39,40}, complementary sub-windows).
export function ordinaryResolve(st, st2) {
  const full = nativeResolve(st, st2);
  if (!full) return null;
  if (full.row === 37 || full.row === 38 || full.row === 39 || full.row === 40) return null;
  return full;
}
// the exact icon a faithful renderer draws at (st, st2, unitId, nowMs) under the native window.
export function nativeVisibleIcon(st, st2, unitId, nowMs) {
  return (nativeBubblePhase(unitId, nowMs) < NATIVE_BUBBLE_ORDINARY_MS)
    ? physicalResolve(st)
    : ordinaryResolve(st, st2);
}
// is this unit's ORDINARY bubble visible right now? (true only inside the [5001,7000) window)
export function nativeOrdinaryVisible(unitId, nowMs) { return nativeBubblePhase(unitId, nowMs) >= NATIVE_BUBBLE_ORDINARY_MS; }
// is this unit's PHYSICAL marker window open right now? ([0,5001))
export function nativePhysicalVisible(unitId, nowMs) { return nativeBubblePhase(unitId, nowMs) < NATIVE_BUBBLE_ORDINARY_MS; }
