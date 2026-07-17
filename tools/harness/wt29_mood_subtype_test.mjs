// wt29_mood_subtype_test.mjs -- offline WT29 strange-mood SUBTYPE round-trip fixture.
// Run: node tools/harness/wt29_mood_subtype_test.mjs
//
// The server (src/world_stream.cpp) packs WHICH strange mood into the reserved 0x1C0 nibble of the
// per-unit `st` int; both renderers (dwf-tiles.js canvas2d + dwf-gl.js WebGL) decode it
// to pick the correct unit_status.png row. This fixture drives the FULL loop: seed each df mood_type
// enum value -> pack st the way the DLL does -> assert BOTH renderers select the graphics_interface.txt
// row. It also pins backward-compat in both directions and ties the assertions to the real sources.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

// ---- load BOTH renderers exactly like b108_claimed_designation_blink_test.mjs -------------------
const glbox = { self: null, performance: { now: () => 0 } };
glbox.self = glbox; vm.createContext(glbox);
vm.runInContext(read("web", "js", "dwf-gl.js"), glbox, { filename: "dwf-gl.js" });
const GL = glbox.DwfGL;

class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) {
    if (p in t) return t[p];
    if (p === "measureText") return () => ({ width: 8 });
    return () => {};
  }, set(t, p, v) { t[p] = v; return true; } }); }
}
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; },
  createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
globalThis.Image = class { set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });
vm.runInThisContext(read("web", "js", "dwf-tiles.js"), { filename: "dwf-tiles.js" });
const Tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });

const glIcon = (st) => GL.unitStatusIconForBits(st);
const tilesIcon = (st) => Tiles._unitStatusIconForTest(st);

// ---- SERVER-SIDE ENCODE (mirror of src/world_stream.cpp WT29 block) -----------------------------
// df mood_type enum values (df.d_basics.xml): None=-1 Fey=0 Secretive=1 Possessed=2 Macabre=3 Fell=4
// Melancholy=5 Raving=6 Berserk=7 Baby=8 Traumatized=9. Only the five overhead-relevant moods get a
// 1-based subtype code; everything else stays 0 and rides has_mood's row-9 fallback.
const DF_MOOD = { None: -1, Fey: 0, Secretive: 1, Possessed: 2, Macabre: 3, Fell: 4,
                  Melancholy: 5, Raving: 6, Berserk: 7, Baby: 8, Traumatized: 9 };
const USTAT_STRANGE_MOOD = 0x08, MOOD_SHIFT = 6, MOOD_MASK = 0x7 << MOOD_SHIFT;
function moodCodeFor(moodEnumVal) {
  switch (moodEnumVal) {
    case DF_MOOD.Fey:       return 1;
    case DF_MOOD.Possessed: return 2;
    case DF_MOOD.Secretive: return 3;
    case DF_MOOD.Fell:      return 4;
    case DF_MOOD.Macabre:   return 5;
    default:                return 0;  // non-overhead mood / None -> row-9 fallback
  }
}
// packSt reproduces the DLL: has_mood always sets 0x08, the subtype nibble is additive on top.
function packSt(moodEnumVal, hasMood = true) {
  let st = 0;
  if (hasMood) { st |= USTAT_STRANGE_MOOD; st |= (moodCodeFor(moodEnumVal) << MOOD_SHIFT) & MOOD_MASK; }
  return st;
}

// ---- 1) round-trip: each overhead mood enum -> its graphics_interface.txt row, in BOTH renderers -
const EXPECT = [
  { mood: "Fey",       enumVal: DF_MOOD.Fey,       row: 9,  token: "UNIT_STATUS:FEY_MOOD" },
  { mood: "Possessed", enumVal: DF_MOOD.Possessed, row: 10, token: "UNIT_STATUS:POSSESSED" },
  { mood: "Secretive", enumVal: DF_MOOD.Secretive, row: 11, token: "UNIT_STATUS:SECRETIVE_MOOD" },
  { mood: "Fell",      enumVal: DF_MOOD.Fell,       row: 12, token: "UNIT_STATUS:FELL_MOOD" },
  { mood: "Macabre",   enumVal: DF_MOOD.Macabre,    row: 13, token: "UNIT_STATUS:MACABRE_MOOD" },
];
for (const e of EXPECT) {
  const st = packSt(e.enumVal);
  const g = glIcon(st), t = tilesIcon(st);
  assert.equal(g.row, e.row, `GL: ${e.mood} -> row ${e.row}`);
  assert.equal(t.row, e.row, `Tiles: ${e.mood} -> row ${e.row}`);
  assert.equal(g.token, e.token, `GL: ${e.mood} token`);
  assert.equal(t.token, e.token, `Tiles: ${e.mood} token`);
  assert.equal(g.row, t.row, `parity: ${e.mood} both renderers agree`);
  // has_mood (0x08) MUST stay set so an old client still recognizes the mood.
  assert.ok(st & USTAT_STRANGE_MOOD, `${e.mood}: STRANGE_MOOD 0x08 co-set`);
}

// ---- 2) backward-compat BOTH directions -> FEY_MOOD row 9 ---------------------------------------
// (a) old DLL: ships bare 0x08 with no subtype nibble.
for (const st of [0x08]) {
  assert.equal(glIcon(st).row, 9, "old-DLL bare has_mood -> GL row 9");
  assert.equal(tilesIcon(st).row, 9, "old-DLL bare has_mood -> Tiles row 9");
}
// (b) new DLL, mood with NO overhead cell (e.g. Melancholy) -> code 0 -> row 9.
for (const m of ["Melancholy", "Raving", "Berserk", "Baby", "Traumatized"]) {
  const st = packSt(DF_MOOD[m]);
  assert.equal(st, 0x08, `${m} packs to bare has_mood (code 0)`);
  assert.equal(glIcon(st).row, 9, `${m} -> GL row 9 fallback`);
  assert.equal(tilesIcon(st).row, 9, `${m} -> Tiles row 9 fallback`);
}
// (c) unknown/out-of-range code (forward-compat: a future 6/7) also falls back, never throws/null.
for (const code of [6, 7]) {
  const st = 0x08 | ((code << MOOD_SHIFT) & MOOD_MASK);
  assert.equal(glIcon(st).row, 9, `unknown code ${code} -> GL row 9`);
  assert.equal(tilesIcon(st).row, 9, `unknown code ${code} -> Tiles row 9`);
}

// ---- 3) precedence: sleeping/unconscious still outrank mood; caged/chained still null ------------
assert.equal(glIcon(0x08 | 0x01).token, "UNIT_STATUS:SLEEPING", "sleeping outranks mood (GL)");
assert.equal(tilesIcon(0x08 | 0x02).token, "UNIT_STATUS:UNCONSCIOUS", "unconscious outranks mood (Tiles)");
assert.equal(glIcon(0x10), null, "caged still no overhead cell (GL)");

// ---- 4) test-the-test: a subtype-blind decoder reproduces the pre-WT29 always-FEY bug -----------
// The old behavior ignored the nibble and returned row 9 for every mood. If our decode were still
// blind, Possessed/Fell/etc would all land on row 9 -- so an assertion that they DON'T must hold now.
assert.notEqual(glIcon(packSt(DF_MOOD.Possessed)).row, 9, "seeded: Possessed must NOT still be row 9 (GL)");
assert.notEqual(tilesIcon(packSt(DF_MOOD.Macabre)).row, 9, "seeded: Macabre must NOT still be row 9 (Tiles)");
// And a seeded WRONG expectation (Fey claimed at row 10) must fail against the real renderer.
assert.throws(() => assert.equal(glIcon(packSt(DF_MOOD.Fey)).row, 10),
  "seeded wrong row (Fey!=9) is correctly rejected");
// A subtype-blind reference decoder proves the fixture would catch a regression to old behavior.
const blindDecode = (st) => (st & USTAT_STRANGE_MOOD) ? 9 : null;
assert.equal(blindDecode(packSt(DF_MOOD.Fell)), 9, "blind decoder mis-maps Fell to 9 (the bug)");
assert.notEqual(glIcon(packSt(DF_MOOD.Fell)).row, blindDecode(packSt(DF_MOOD.Fell)),
  "real GL decoder diverges from the blind one -> subtype is actually consumed");

// ---- 5) source ties: the fixture cannot pass if the real encode/decode is removed ----------------
// B222: the encode (constants + predicates + WT29 nibble) moved from world_stream.cpp into the
// SHARED src/unit_status.h so BOTH unit serializers (world_stream's append_unit_json AND
// tile_map_dump's emit_units -- the one that never shipped st) compute one identical value. The
// encode pins target the header; serializer parity is b222_status_serializer_parity_test.mjs's.
const stream = read("src", "world_stream.cpp");
const ustat = read("src", "unit_status.h");
assert.match(ustat, /kUStatMoodShift\s*=\s*6/, "shared header defines the 0x40 mood shift");
assert.match(ustat, /kUStatMoodMask\s*=\s*0x7\s*<<\s*kUStatMoodShift/, "shared header defines the 0x1C0 mask");
assert.match(ustat, /case df::mood_type::Fey:\s*mood_code = kUMoodFey;/, "server encodes Fey");
assert.match(ustat, /case df::mood_type::Possessed:\s*mood_code = kUMoodPossessed;/, "server encodes Possessed");
assert.match(ustat, /case df::mood_type::Macabre:\s*mood_code = kUMoodMacabre;/, "server encodes Macabre");
assert.match(ustat, /st \|= \(mood_code << kUStatMoodShift\) & kUStatMoodMask;/, "server writes the nibble into st");
assert.match(ustat, /st \|= kUStatStrangeMood;/, "server keeps 0x08 STRANGE_MOOD for backward compat");
assert.match(stream, /r\.st = unit_status_bits\(u\);/, "world_stream consumes the shared helper");
for (const f of ["dwf-tiles.js", "dwf-gl.js"]) {
  const js = read("web", "js", f);
  assert.match(js, /USTAT_MOOD_MASK\s*=\s*0x7\s*<<\s*USTAT_MOOD_SHIFT/, `${f} defines the 0x1C0 mask`);
  assert.match(js, /MOOD_CELL\[\(st & USTAT_MOOD_MASK\) >> USTAT_MOOD_SHIFT\] \|\| MOOD_CELL\[1\]/, `${f} decodes the nibble with a row-9 fallback`);
  assert.match(js, /13[,:].*MACABRE_MOOD|MACABRE_MOOD.*13/, `${f} maps MACABRE to row 13`);
}

// ---- 6) B222 end-to-end DRAW pin: every status kind reaches the canvas2d draw plan ---------------
// wt29 above proved the icon HELPER picks the right row; wb13's GL sections prove buildUnits emits
// the instance. This pins the OTHER renderer's real draw entry point (unitStatusDrawPlan) for all
// four never-vs-observed kinds, so a regression that null'd the plan for non-mood bits (the B222
// symptom class: "only the mood bubble ever renders") would fail here. cell=24; the plan places the
// icon one tile ABOVE the unit (dy = (y-oy-1)*cell). Native cadence: id=0 so phase == nowMs % 7000;
// sample inside the ordinary window (t=6000, phase 6000 >= 5001) so these ordinary bubbles are shown.
const ORD_T = 6000;
const drawPlan = (st) => Tiles._unitStatusDrawPlanForTest({ id: 0, x: 5, y: 5, st }, 0, 0, 24, ORD_T, 1);
const DRAW_EXPECT = [
  { name: "sleeping",   st: 0x01, row: 8,  token: "UNIT_STATUS:SLEEPING" },
  { name: "unconscious",st: 0x02, row: 30, token: "UNIT_STATUS:UNCONSCIOUS" },
  { name: "stressed",   st: 0x04, row: 6,  token: "UNIT_STATUS:STRESSED" },
  { name: "mood",       st: 0x08, row: 9,  token: "UNIT_STATUS:FEY_MOOD" },
];
for (const e of DRAW_EXPECT) {
  const p = drawPlan(e.st);
  assert.ok(p, `${e.name}: canvas2d emits a draw plan (not null) inside its ordinary phase window`);
  assert.equal(p.row, e.row, `${e.name}: draw plan row ${e.row}`);
  assert.equal(p.token, e.token, `${e.name}: draw plan token`);
  assert.equal(p.dy, (5 - 0 - 1) * 24, `${e.name}: icon drawn one tile above the unit`);
  // both renderers must AGREE on the row for the same st (shared unit_status contract).
  assert.equal(glIcon(e.st).row, e.row, `${e.name}: GL agrees on row ${e.row}`);
}
// test-the-test: caged/chained have NO overhead cell -> the plan MUST be null even on the ON phase.
assert.equal(drawPlan(0x10), null, "caged has no draw plan");
assert.equal(drawPlan(0x00), null, "st=0 has no draw plan");

// ---- 7) SB-TESTS (2026-07-16 native cadence) REWRITE: overhead bubbles ride the NATIVE per-unit
// phase, NOT any fort-wide clock. This section used to pin the invented global 800ms status gate
// (plan vanished on the OFF phase), then STEADY (always drawn). It now pins the native window: an
// ordinary bubble is shown when the unit's phase >= 5001 and hidden when < 5001. The shared 800ms
// clock FUNCTION survives for designation blink / flow breathing / pause animation
// (DESIG_ACTIVE_BLINK_MS = UNIT_STATUS_BLINK_MS/2) -- its toggle is still verified here; what changed
// is that the BUBBLE draw no longer consults it. Full coverage lives in sb_cadence_test.mjs.
const BLINK = GL.UNIT_STATUS_BLINK_MS;
assert.equal(BLINK, 800, "shared UI clock half-period is still 800ms (designation/flow/pause consume it)");
// the shared clock FUNCTION is NOT deleted (other animations depend on it) and still toggles.
for (const [t, on] of [[0, true], [BLINK - 1, true], [BLINK, false], [BLINK * 2 - 1, false], [BLINK * 2, true]]) {
  assert.equal(GL.unitStatusBlinkVisible(t), on, `shared UI clock fn toggles @${t} -> ${on} (GL)`);
  assert.equal(Tiles._unitStatusBlinkVisibleForTest(t), on, `shared UI clock fn toggles @${t} -> ${on} (Tiles)`);
}
// the BUBBLE draw now rides the native per-unit window: for id=0, phase == nowMs % 7000, so it is
// shown when phase >= 5001 and hidden when < 5001 -- decoupled from the shared 800ms clock above.
const P = GL.NATIVE_BUBBLE_PERIOD_MS, ORD = GL.NATIVE_BUBBLE_ORDINARY_MS;
for (const t of [0, 800, 5000, 5001, 6000, 6999, 12345, 123456]) {
  const plan = Tiles._unitStatusDrawPlanForTest({ id: 0, x: 5, y: 5, st: 0x01 }, 0, 0, 24, t, 1);
  if ((t % P) >= ORD) {
    assert.ok(plan, `native: sleeping Zz shown at wall-clock ${t} (phase ${t % P} >= 5001)`);
    assert.equal(plan.row, 8, `native: the Zz (row 8) draws at ${t}`);
  } else {
    assert.equal(plan, null, `native: sleeping Zz hidden at wall-clock ${t} (phase ${t % P} < 5001)`);
  }
}
// test-the-test: the ordinary bubble is gated OFF in the <5001 window and ON in the >=5001 window --
// a draw path still gated on the removed 800ms clock could not produce this per-unit split.
assert.equal(Tiles._unitStatusDrawPlanForTest({ id: 0, x: 5, y: 5, st: 0x01 }, 0, 0, 24, 800, 1), null,
  "native per-unit gate: ordinary bubble hidden in the <5001 window (t=800)");
assert.ok(Tiles._unitStatusDrawPlanForTest({ id: 0, x: 5, y: 5, st: 0x01 }, 0, 0, 24, 6000, 1),
  "native per-unit gate: ordinary bubble shown in the >=5001 window (t=6000)");

// ---- 8) SERVER predicate source pins: guard the three never-observed bits against a silent drop --
// The client (sections 1-7) is proven to render all four bits. These pin the exact predicates in
// the SHARED src/unit_status.h so a fold-cache/refactor cannot quietly drop a non-mood bit while
// leaving has_mood (the one that works) intact. Predicates verified against DFHack df-structures:
//  - sleeping  = current_job->job_type == Sleep   (matches DFHack siren.lua wake_unit sleep test)
//  - unconscious = counters.unconscious > 0        (unit.counters.unconscious, knocked-out counter)
//  - stressed  = soul->personality.longterm_stress >= kUStatStressLevel  (B280: DF'S OWN FIELD and
//    decoded out of Dwarf Fortress.exe -- the point at which DF's unit sheet prints "Stressed".
//    This pin USED to require DFHack's getStressCategory(u) <= 1, which is stress >= 25000: that
//    is DFHack's happiness BUCKETING, not DF's status threshold, and it left every dwarf in
//    [20000, 25000) reading "Stressed" on DF's own sheet with no bubble from us. The pin correctly
//    went red when the predicate was corrected; it now pins DF's.)
assert.match(ustat, /kUStatSleeping\s*=\s*0x01/, "shared header defines kUStatSleeping 0x01");
assert.match(ustat, /kUStatUnconscious\s*=\s*0x02/, "shared header defines kUStatUnconscious 0x02");
assert.match(ustat, /kUStatStressed\s*=\s*0x04/, "shared header defines kUStatStressed 0x04");
// SB-SERVER (table row 17, sel:60-70): SLEEPING extended from Sleep-only to Sleep OR Rest (the
// native occupied-bed ref subtypes 0x17/0x32 == job_type Sleep/Rest). Old pin was a proven subset.
assert.match(ustat, /job_type == df::job_type::Sleep[\s\S]*?job_type::Rest[\s\S]*?st \|= kUStatSleeping/,
  "server sets SLEEPING from a Sleep OR Rest current_job (sel:60-70, R2 named-approximation)");
assert.match(ustat, /u->counters\.unconscious > 0\)\s*st \|= kUStatUnconscious/,
  "server sets UNCONSCIOUS from counters.unconscious");
// SB-SERVER (table row 6, sel:184): the overhead STRESSED *bubble* fires on the RAW personality.stress
// accumulator >= 10000 with no active mood -- NOT longterm_stress (that is the unit-SHEET field, kept
// at kUStatStressLevel=20000 and cross-checked by status_truth_test). Old pin was the wrong field.
assert.match(ustat, /personality\.stress >= kUStatBubbleStress[\s\S]*?st \|= kUStatStressed/,
  "server sets the STRESSED bubble from DF's overhead selector field (raw stress >= 10000, sel:184)");
assert.match(ustat, /kUStatStressLevel\s*=\s*20000/,
  "kUStatStressLevel is DF's own 'Stressed' cutoff, decoded from the game binary (B280). " +
  "If DF changes it, tools/harness/df_status_ladder.py --write will say so.");
// and the whole st int must ride the fold (so a bit flip re-ships the unit) + the aux JSON.
assert.match(stream, /s4_fold_add\(h, u\.st\)/, "st folds into the per-unit rec_fold (bit change re-sends)");
assert.match(stream, /if \(u\.st\) a << ",\\"st\\":" << u\.st/, "st rides the aux unit JSON when non-zero");

console.log("PASS wt29: 5 mood subtypes round-trip to rows 9/10/11/12/13 in both renderers; " +
  "old-DLL + non-overhead + unknown codes fall back to row 9; 0x08 preserved; seeded bad cases rejected; " +
  "B222: all 4 status kinds pinned through the canvas2d draw plan + GL row agreement; blink cadence " +
  "(shared 800ms clock, both renderers, frozen-clock toggle) pinned; server sleeping/unconscious/stressed " +
  "predicates source-pinned against a silent drop");
