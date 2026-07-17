// wt30_status_full_test.mjs -- offline WT30+WT31 FULL overhead-status round-trip fixture.
// Run: node tools/harness/wt30_status_full_test.mjs
//
// WT30 widened the per-unit `st` int from 6 bits + the WT29 mood nibble to ALL of DF's overhead
// UNIT_STATUS bubbles we could ground in a crisp df-structures field (20 new bits, 0x200..0x10000000).
// WT31 (BUBBLE-CAL) adds a SECOND status word `st2` (a fresh int, bits 0x1..0x800) for the bubbles
// WT30 could not ground -- `st` was full at bit 28 and JS `&` coercion makes bits >= 31 unusable.
// This fixture drives the full loop for every shipped status in BOTH words: seed the bit the DLL
// sets -> assert BOTH renderers (dwf-tiles.js canvas2d + dwf-gl.js WebGL) select the
// correct graphics_interface.txt row/token AND agree. It also pins the one-bubble priority order,
// the encoding safety envelope (positive int32), old-DLL back-compat (absent st2 == pre-WT31), and
// ties every assertion back to the real sources so a silent drop or a bit-position drift turns red.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

// ---- load BOTH renderers (same harness shape as wt29_mood_subtype_test.mjs) ---------------------
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

const glIcon = (st, st2) => GL.unitStatusIconForBits(st, st2);
const tilesIcon = (st, st2) => Tiles._unitStatusIconForTest(st, st2);
const plain = (o) => o && { sheet: o.sheet, col: o.col, row: o.row, token: o.token };

// ---- the WT30 bit map: mirror of src/unit_status.h kUStat* (the ONE shared computation) ---------
// [const-name, bit, row, token-suffix]. Existing pre-WT30 single-bit statuses first, then WT30.
const STATUS = [
  ["SLEEPING",       0x00000001,  8, "SLEEPING"],
  ["UNCONSCIOUS",    0x00000002, 30, "UNCONSCIOUS"],
  ["STRESSED",       0x00000004,  6, "STRESSED"],
  ["WINDED",         0x00000200, 29, "WINDED"],
  ["STUNNED",        0x00000400, 27, "STUNNED"],
  ["NAUSEA",         0x00000800, 28, "NAUSEA"],
  ["WEBBED",         0x00001000, 39, "WEBBED"],
  ["PARALYZED",      0x00002000, 26, "PARALYZED"],
  ["FEVERED",        0x00004000, 31, "FEVERED"],
  ["GROUNDED",       0x00008000, 38, "GROUNDED"],
  ["PROJECTILE",     0x00010000, 37, "PROJECTILE"],
  ["CLIMBING",       0x00020000, 40, "CLIMBING"],
  ["MELANCHOLY",     0x00040000, 18, "MELANCHOLY"],
  ["MADNESS",        0x00080000, 17, "MADNESS"],
  ["BERSERK",        0x00100000, 19, "BERSERK"],
  ["MARTIAL_TRANCE", 0x00200000, 21, "MARTIAL_TRANCE"],
  ["ENRAGED",        0x00400000, 20, "ENRAGED"],
  ["TANTRUM",        0x00800000, 14, "TANTRUM"],
  ["DEPRESSION",     0x01000000, 16, "DEPRESSION"],
  ["OBLIVIOUS",      0x02000000, 15, "OBLIVIOUS"],
  ["HUNGRY",         0x04000000,  3, "HUNGRY"],
  ["THIRSTY",        0x08000000,  4, "THIRSTY"],
  ["DROWSY",         0x10000000,  5, "DROWSY"],
];

// ---- the WT31 second-word bit map: mirror of src/unit_status.h kUStat2* --------------------------
// [const-name, bit, row, token-suffix]. NO_DESTINATION is the client-mapped, server-RESERVED bit
// (probe P3 gates the server enable) -- it is still round-tripped here so a client-side drop turns red.
const STATUS2 = [
  ["MIGRANT",              0x00000001,  0, "MIGRANT"],
  ["NO_JOB",               0x00000002,  1, "NO_JOB"],
  ["NO_DESTINATION",       0x00000004,  2, "NO_DESTINATION"],
  ["DISTRACTED",           0x00000008,  7, "DISTRACTED"],
  ["TERRIFIED",            0x00000010, 22, "TERRIFIED"],
  ["WRESTLING",            0x00000020, 23, "WRESTLING"],
  ["MINOR_INJURY",         0x00000040, 24, "MINOR_INJURY"],
  ["MAJOR_INJURY",         0x00000080, 25, "MAJOR_INJURY"],
  ["PLAYING_MAKE_BELIEVE", 0x00000100, 33, "PLAYING_MAKE_BELIEVE"],
  ["TELLING_A_STORY",      0x00000200, 34, "TELLING_A_STORY"],
  ["RECITING_POETRY",      0x00000400, 35, "RECITING_POETRY"],
  ["PERFORMING",           0x00000800, 36, "PERFORMING"],
];

// ---- 1) round-trip: each status bit alone -> its row/token, in BOTH renderers, in agreement ------
for (const [name, bit, row, token] of STATUS) {
  const want = { sheet: "unit_status.png", col: 0, row, token: "UNIT_STATUS:" + token };
  assert.deepEqual(plain(glIcon(bit)), want, `GL: ${name} (0x${bit.toString(16)}) -> row ${row}`);
  assert.deepEqual(plain(tilesIcon(bit)), want, `Tiles: ${name} -> row ${row}`);
  assert.equal(glIcon(bit).row, tilesIcon(bit).row, `parity: ${name} both renderers agree`);
}
// WT31 second word: each st2 bit alone (st=0) -> its row/token, both renderers, in agreement.
for (const [name, bit, row, token] of STATUS2) {
  const want = { sheet: "unit_status.png", col: 0, row, token: "UNIT_STATUS:" + token };
  assert.deepEqual(plain(glIcon(0, bit)), want, `GL: st2 ${name} (0x${bit.toString(16)}) -> row ${row}`);
  assert.deepEqual(plain(tilesIcon(0, bit)), want, `Tiles: st2 ${name} -> row ${row}`);
  assert.equal(glIcon(0, bit).row, tilesIcon(0, bit).row, `parity: st2 ${name} both renderers agree`);
}
// strange mood (nibble) still resolves as before (WT29 owns the subtype; WT30/WT31 left it intact).
assert.equal(glIcon(0x08).row, 9, "bare has_mood still row 9 (GL)");
assert.equal(tilesIcon(0x08).row, 9, "bare has_mood still row 9 (Tiles)");

// ---- 1b) OLD-DLL BACK-COMPAT: an absent st2 (undefined) must behave EXACTLY like st2==0 ----------
// This is the two-halves-deploy-in-either-order contract: a new client fed a pre-WT31 server record
// (no st2 field) must render precisely what it did before WT31 for every WT30/legacy bit.
for (const [name, bit] of STATUS) {
  assert.deepEqual(plain(glIcon(bit, undefined)), plain(glIcon(bit, 0)),
    `GL: absent st2 == st2:0 for ${name}`);
  assert.deepEqual(plain(tilesIcon(bit, undefined)), plain(tilesIcon(bit, 0)),
    `Tiles: absent st2 == st2:0 for ${name}`);
}
assert.equal(glIcon(0), null, "GL: st=0,st2 absent -> no bubble");
assert.equal(tilesIcon(0), null, "Tiles: st=0,st2 absent -> no bubble");

// ---- 2) encoding safety: every bit is a distinct single bit, positive after |0 -------------------
const seen = new Set();
for (const [name, bit] of STATUS) {
  assert.equal(bit & 0xFFFFFFFF, bit, `${name}: fits 32 bits`);
  assert.ok((bit | 0) > 0, `${name}: st|0 stays a POSITIVE int32 (bit 31 sign never reached)`);
  assert.ok(bit <= 0x10000000, `${name}: within the WT30 envelope (<= bit 28)`);
  assert.equal(bit & (bit - 1), 0, `${name}: exactly one bit set`);
  assert.ok(!seen.has(bit), `${name}: bit 0x${bit.toString(16)} is unique`);
  seen.add(bit);
}
// WT31 second word: same envelope discipline, independent bit space (its own uniqueness set).
const seen2 = new Set();
for (const [name, bit] of STATUS2) {
  assert.equal(bit & 0xFFFFFFFF, bit, `st2 ${name}: fits 32 bits`);
  assert.ok((bit | 0) > 0, `st2 ${name}: st2|0 stays a POSITIVE int32`);
  assert.ok(bit <= 0x10000000, `st2 ${name}: within the int32-safe envelope`);
  assert.equal(bit & (bit - 1), 0, `st2 ${name}: exactly one bit set`);
  assert.ok(!seen2.has(bit), `st2 ${name}: bit 0x${bit.toString(16)} is unique`);
  seen2.add(bit);
}
// the pre-WT30 nibble (0x1C0) must not collide with any WT30 single bit.
for (const [name, bit] of STATUS) assert.equal(bit & 0x1C0, 0, `${name} does not overlap the mood nibble`);

// ---- 3) priority order -- REPINNED TO THE SHIPPED 18-STEP NATIVE LADDER (SB-TESTS 2026-07-16) ----
// The evidence lead decoded native FUN_1402685d0; the sb-gl/sb-tiles workers ship its exact order
// (table §NATIVE PRIORITY): 1 SLEEPING 2 UNCONSCIOUS 3 PARALYZED 4 activity(34>35>36>33) 5 WRESTLING
// 6 NAUSEA 7 STUNNED 8 WINDED 9 MAJOR 10 MINOR 11 FEVERED 12 THIRSTY>HUNGRY>DROWSY>STRESSED>DISTRACTED
// 13 soldier(21>20>14>16>15) 14 NO_JOB>NO_DEST 15 insane(BERSERK>MADNESS>MELANCHOLY>nibble>TERRIFIED)
// 16 MIGRANT 17 physical fallback(PROJECTILE>GROUNDED>CLIMBING>WEBBED) 18 caged/chained->null.
// INVENTED ORDER PINS REMOVED (old winner -> native winner, with the step that disproves the old):
//   * PROJECTILE|WEBBED|STUNNED  PROJECTILE->STUNNED  (PROJECTILE/WEBBED demoted to physical step 17)
//   * BERSERK|STRESSED           BERSERK->STRESSED     (needs/stress step 12 > insane mood step 15)
//   * CLIMBING|STRESSED          CLIMBING->STRESSED    (CLIMBING physical step 17 < STRESSED step 12)
//   * STRESSED|HUNGRY            STRESSED->HUNGRY      (concrete need precedes STRESSED within step 12)
//   * HUNGRY|THIRSTY|DROWSY      HUNGRY->THIRSTY       (proven need order thirsty first, sel:173)
//   * PARALYZED+MAJOR_INJURY     MAJOR_INJURY->PARALYZED (PARALYZED step 3 > MAJOR step 9)
//   * WINDED+MAJOR+WRESTLING     MAJOR_INJURY->WRESTLING (WRESTLING step 5 > WINDED 8 > MAJOR 9)
//   * NAUSEA+TERRIFIED           TERRIFIED->NAUSEA     (NAUSEA step 6 > TERRIFIED step 15)
//   * TERRIFIED+MINOR_INJURY     TERRIFIED->MINOR_INJURY (MINOR step 10 > TERRIFIED step 15)
//   * BERSERK+TELLING_A_STORY    BERSERK->TELLING_A_STORY (activity step 4 > insane step 15)
//   * MIGRANT|NO_JOB|NO_DEST     MIGRANT->NO_JOB      (NO_JOB step 14 > MIGRANT step 16)
const U = {}; for (const [name, bit] of STATUS) U[name] = bit;
const U2 = {}; for (const [name, bit] of STATUS2) U2[name] = bit;
// [combined st, combined st2, winner token, why]
const PRIO = [
  [U.UNCONSCIOUS | U.HUNGRY | U.DROWSY, 0,                "UNCONSCIOUS", "danger outranks needs"],
  [U.PROJECTILE | U.WEBBED | U.STUNNED, 0,                "STUNNED",    "NATIVE: PROJECTILE+WEBBED are physical fallback; STUNNED (danger) wins"],
  [U.PARALYZED | U.STUNNED | U.WINDED,  0,                "PARALYZED",  "paralyzed (step 3) over lesser incapacitation"],
  [U.NAUSEA | U.SLEEPING,               0,                "SLEEPING",   "B248: a nauseous sleeper still shows the Zz"],
  [U.SLEEPING | U.GROUNDED,             0,                "SLEEPING",   "a dwarf in a bed is on_ground -- still the Zz"],
  [U.SLEEPING | U.UNCONSCIOUS,          0,                "SLEEPING",   "DF keeps the unconscious counter ticking during sleep"],
  [U.SLEEPING | U.DROWSY,               0,                "SLEEPING",   "a sleeper is still over the drowsiness cut"],
  [U.SLEEPING | U.WEBBED,               0,                "SLEEPING",   "sleep is FIRST -- nothing masks the Zz"],
  [U.UNCONSCIOUS | U.GROUNDED,          0,                "UNCONSCIOUS","a real KO (no Sleep job) reads UNCONSCIOUS; GROUNDED is physical fallback"],
  [U.SLEEPING | U.STRESSED,             0,                "SLEEPING",   "sleeping over stress"],
  [U.SLEEPING | U.HUNGRY,               0,                "SLEEPING",   "sleep over needs"],
  [U.BERSERK | U.STRESSED,              0,                "STRESSED",   "NATIVE: needs/stress (step 12) outrank insane mood (step 15)"],
  [U.BERSERK | 0x08,                    0,                "BERSERK",    "insanity outranks the strange-mood nibble within step 15"],
  [U.ENRAGED | U.OBLIVIOUS,             0,                "ENRAGED",    "soldier-mood internal order 20>15"],
  [U.MARTIAL_TRANCE | U.ENRAGED,        0,                "MARTIAL_TRANCE","soldier-mood internal order 21>20"],
  [U.CLIMBING | U.STRESSED,             0,                "STRESSED",   "NATIVE: CLIMBING is physical fallback (step 17); STRESSED (step 12) wins"],
  [U.STRESSED | U.HUNGRY,               0,                "HUNGRY",     "NATIVE: a concrete need precedes STRESSED"],
  [U.HUNGRY | U.THIRSTY | U.DROWSY,     0,                "THIRSTY",    "NATIVE need order thirsty>hungry>drowsy (sel:173/176/179)"],
  [U.THIRSTY | U.DROWSY,                0,                "THIRSTY",    "thirsty over drowsy"],
  // --- WT31 additions (native winners) ---
  [U.UNCONSCIOUS,           U2.MAJOR_INJURY,              "UNCONSCIOUS", "KO (step 2) still tops even a major injury"],
  [U.PARALYZED,             U2.MAJOR_INJURY,              "PARALYZED",  "NATIVE: PARALYZED (step 3) outranks MAJOR_INJURY (step 9)"],
  [U.WINDED,                U2.MAJOR_INJURY | U2.WRESTLING, "WRESTLING", "NATIVE: WRESTLING (step 5) > WINDED (8) > MAJOR (9)"],
  [U.WINDED,                U2.WRESTLING,                 "WRESTLING",  "wrestling ranks above winded"],
  [U.NAUSEA,                U2.TERRIFIED,                 "NAUSEA",     "NATIVE: NAUSEA (step 6) outranks TERRIFIED (step 15)"],
  [0,                       U2.TERRIFIED | U2.MINOR_INJURY, "MINOR_INJURY", "NATIVE: MINOR_INJURY (step 10) outranks TERRIFIED (step 15)"],
  [U.SLEEPING,              U2.MINOR_INJURY,              "SLEEPING",   "B248: a minor injury no longer masks the Zz"],
  [U.SLEEPING,              U2.MIGRANT | U2.NO_JOB,       "SLEEPING",   "sleep over idle/arrival"],
  [U.BERSERK,               U2.TELLING_A_STORY,           "TELLING_A_STORY","NATIVE: activity (step 4) outranks insane mood (step 15)"],
  [U.CLIMBING,              U2.TELLING_A_STORY,           "TELLING_A_STORY","story ranks above climbing"],
  [0,                       U2.TELLING_A_STORY | U2.RECITING_POETRY | U2.PERFORMING | U2.PLAYING_MAKE_BELIEVE,
                                                          "TELLING_A_STORY","performance internal order story>poetry>music>make-believe"],
  [0,                       U2.RECITING_POETRY | U2.PERFORMING, "RECITING_POETRY","poetry over music"],
  [0,                       U2.PERFORMING | U2.PLAYING_MAKE_BELIEVE, "PERFORMING","music over make-believe"],
  [U.STRESSED,              U2.DISTRACTED,                "STRESSED",   "stress over distraction (within step 12)"],
  [0,                       U2.DISTRACTED,                "DISTRACTED", "distraction alone"],
  [U.HUNGRY,                U2.DISTRACTED,                "HUNGRY",     "a CONCRETE need outranks the vague distraction it causes"],
  [U.THIRSTY,               U2.DISTRACTED,                "THIRSTY",    "the thirst droplet is no longer masked by DISTRACTED"],
  [U.HUNGRY,                U2.MIGRANT | U2.NO_JOB,       "HUNGRY",     "a real need (step 12) outranks idle/arrival"],
  [U.MARTIAL_TRANCE,        U2.NO_JOB,                    "MARTIAL_TRANCE","soldier mood (step 13) outranks idle NO_JOB (step 14)"],
  [U.BERSERK,               U2.NO_JOB,                    "NO_JOB",     "NATIVE: idle NO_JOB (step 14) outranks insane mood (step 15)"],
  [0,                       U2.MIGRANT | U2.NO_JOB | U2.NO_DESTINATION, "NO_JOB", "NATIVE idle order: NO_JOB (step 14) precedes MIGRANT (step 16)"],
  [0,                       U2.NO_JOB | U2.NO_DESTINATION, "NO_JOB",    "no_job over no_destination"],
  [U.PROJECTILE,            U2.MIGRANT,                   "MIGRANT",    "NATIVE: MIGRANT (step 16) outranks the physical fallback (step 17)"],
  [U.PROJECTILE | U.GROUNDED | U.CLIMBING | U.WEBBED, 0,  "PROJECTILE", "physical fallback internal order 37>38>40>39"],
];
for (const [st, st2, winTok, why] of PRIO) {
  assert.equal(glIcon(st, st2).token, "UNIT_STATUS:" + winTok, `GL priority: ${why} (st=0x${(st>>>0).toString(16)},st2=0x${(st2>>>0).toString(16)})`);
  assert.equal(tilesIcon(st, st2).token, "UNIT_STATUS:" + winTok, `Tiles priority: ${why}`);
}
// pre-WT30 nibble precedence pins (identical to wt29 §3) still hold after the widening.
assert.equal(glIcon(0x08 | 0x01).token, "UNIT_STATUS:SLEEPING", "0x08|0x01 -> sleeping (GL)");
assert.equal(tilesIcon(0x08 | 0x02).token, "UNIT_STATUS:UNCONSCIOUS", "0x08|0x02 -> unconscious (Tiles)");
assert.equal(glIcon(0x10), null, "caged still no overhead cell (GL)");
assert.equal(tilesIcon(0x20), null, "chained still no overhead cell (Tiles)");
// injuries are mutually exclusive in the resolver order: major wins if both were somehow set.
assert.equal(glIcon(0, U2.MAJOR_INJURY | U2.MINOR_INJURY).token, "UNIT_STATUS:MAJOR_INJURY",
  "major beats minor if both bits set (GL)");
assert.equal(tilesIcon(0, U2.MAJOR_INJURY | U2.MINOR_INJURY).token, "UNIT_STATUS:MAJOR_INJURY",
  "major beats minor if both bits set (Tiles)");

// ---- 4) canvas2d DRAW-PLAN pin for representative new bits (real draw entry point) ---------------
// wb13/wt29/wt30 pin the helper + draw plan; pin the WT31 st2 draw path too so a regression that
// null'd the plan for a new st2 bit (the B222 symptom class) fails here. cell=24. SB-TESTS
// (2026-07-16 native cadence): bubbles ride each unit's own phase = (id*0x86e8 + now) % 7000. With
// id=0 the phase is just now % 7000, so we sample each bit INSIDE its own window: ordinary bits at
// t=6000 (phase 6000 >= 5001), physical-group bits at t=800 (phase 800 < 5001). Full cross-renderer
// cadence coverage lives in sb_cadence_test.mjs.
const T_ORD = 6000, T_PHYS = 800;
const isPhysRow = (row) => row === 37 || row === 38 || row === 39 || row === 40;
const drawPlanFor = (st, st2, row) =>
  Tiles._unitStatusDrawPlanForTest({ id: 0, x: 5, y: 5, st, st2 }, 0, 0, 24, isPhysRow(row) ? T_PHYS : T_ORD, 1);
for (const name of ["WEBBED", "PROJECTILE", "BERSERK", "MARTIAL_TRANCE", "HUNGRY", "CLIMBING"]) {
  const [, bit, row, token] = STATUS.find((s) => s[0] === name);
  const p = drawPlanFor(bit, 0, row);
  assert.ok(p, `${name}: canvas2d emits a draw plan inside its native phase window`);
  assert.equal(p.row, row, `${name}: draw plan row ${row}`);
  assert.equal(p.token, "UNIT_STATUS:" + token, `${name}: draw plan token`);
  assert.equal(p.dy, (5 - 0 - 1) * 24, `${name}: icon drawn one tile above the unit`);
}
for (const name of ["MAJOR_INJURY", "WRESTLING", "TERRIFIED", "PERFORMING", "MIGRANT", "NO_JOB"]) {
  const [, bit, row, token] = STATUS2.find((s) => s[0] === name);
  const p = drawPlanFor(0, bit, row);   // all ordinary -> T_ORD
  assert.ok(p, `st2 ${name}: canvas2d emits a draw plan inside its native phase window`);
  assert.equal(p.row, row, `st2 ${name}: draw plan row ${row}`);
  assert.equal(p.token, "UNIT_STATUS:" + token, `st2 ${name}: draw plan token`);
}
// SB-TESTS REWRITE: the old pin asserted STEADY (present at any nowMs). Native gates per unit: an
// ordinary bubble (WRESTLING) is SHOWN in the >=5001 window and HIDDEN in the <5001 physical window.
assert.ok(Tiles._unitStatusDrawPlanForTest({ id: 0, x: 5, y: 5, st: 0, st2: U2.WRESTLING }, 0, 0, 24, T_ORD, 1),
  "native: WRESTLING (ordinary) draws inside its >=5001 window");
assert.equal(Tiles._unitStatusDrawPlanForTest({ id: 0, x: 5, y: 5, st: 0, st2: U2.WRESTLING }, 0, 0, 24, T_PHYS, 1), null,
  "native: WRESTLING (ordinary) is HIDDEN in the <5001 physical window (per-unit phase gate, not the old 800ms clock)");

// ---- 5) test-the-test: seeded wrong expectations + a bit-blind resolver are rejected -------------
assert.throws(() => assert.equal(glIcon(U.BERSERK).row, 9),
  "seeded wrong row (BERSERK!=19) is correctly rejected");
// a resolver that ignored the st2 word (only knew st) would return null for every WT31 bit; prove
// the real decoder does NOT, i.e. the second word is actually consumed.
for (const [name, bit, row] of STATUS2) {
  assert.notEqual(glIcon(0, bit), null, `real GL decoder consumes st2 ${name} (row ${row})`);
  assert.notEqual(tilesIcon(0, bit), null, `real Tiles decoder consumes st2 ${name}`);
}

// ---- 6) SERVER source pins: every predicate + constant lives in the shared src/unit_status.h -----
const ustat = read("src", "unit_status.h");
const SRC_PINS = [
  [/kUStatWinded\s*=\s*0x00000200/, "kUStatWinded 0x200"],
  [/kUStatDrowsy\s*=\s*0x10000000/, "kUStatDrowsy 0x10000000 (top of envelope)"],
  // B248: the ONE flat need threshold became three per-need ones (see b248_status_priority_test.mjs).
  [/kUStatHungerTimer\s*=\s*50000/, "PROVISIONAL hunger threshold = 50000"],
  [/kUStatThirstTimer\s*=\s*25000/, "PROVISIONAL thirst threshold = 25000 (DFHack siege-engine)"],
  [/kUStatSleepTimer\s*=\s*57600/, "PROVISIONAL sleepiness threshold = 57600 (DF must-sleep tick)"],
  // SB-SERVER (table, sel:159/156/44/78): WINDED gains the drowning split, STUNNED the dizziness
  // branch, WEBBED the > 9 boundary, PARALYZED the >= 100 (full-paralysis) boundary.
  [/u->counters\.winded > 0 && !u->flags1\.bits\.drowning\) st \|= kUStatWinded/, "WINDED predicate (drowning split, sel:159)"],
  [/u->counters\.stunned > 0 \|\| u->counters\.dizziness > 0\) st \|= kUStatStunned/, "STUNNED predicate (+dizziness, sel:156)"],
  [/u->counters\.nausea > 0\)\s*st \|= kUStatNausea/, "NAUSEA predicate"],
  [/u->counters\.webbed > 9\)\s*st \|= kUStatWebbed/, "WEBBED predicate (> 9, sel:44)"],
  [/u->counters2\.paralysis >= 100\) st \|= kUStatParalyzed/, "PARALYZED predicate (>= 100, sel:78)"],
  [/u->counters2\.fever > 0\)\s*st \|= kUStatFevered/, "FEVERED predicate"],
  [/u->flags1\.bits\.on_ground\)\s*st \|= kUStatGrounded/, "GROUNDED predicate"],
  [/u->flags1\.bits\.projectile\)\s*st \|= kUStatProjectile/, "PROJECTILE predicate"],
  [/act->type == df::unit_action_type::Climb.*st \|= kUStatClimbing/, "CLIMBING action-walk predicate"],
  [/case df::mood_type::Melancholy: st \|= kUStatMelancholy/, "MELANCHOLY from unit->mood"],
  [/case df::mood_type::Raving:\s*st \|= kUStatMadness/, "MADNESS from unit->mood == Raving"],
  [/case df::mood_type::Berserk:\s*st \|= kUStatBerserk/, "BERSERK from unit->mood"],
  [/case df::soldier_mood_type::MartialTrance: st \|= kUStatMartialTrance/, "MARTIAL_TRANCE from soldier_mood"],
  [/case df::soldier_mood_type::Enraged:\s*st \|= kUStatEnraged/, "ENRAGED from soldier_mood"],
  [/case df::soldier_mood_type::Oblivious:\s*st \|= kUStatOblivious/, "OBLIVIOUS from soldier_mood"],
  [/hunger_timer\s*>=\s*kUStatHungerTimer\) st \|= kUStatHungry/, "HUNGRY graded predicate"],
  [/thirst_timer\s*>=\s*kUStatThirstTimer\) st \|= kUStatThirsty/, "THIRSTY graded predicate"],
  [/sleepiness_timer >= kUStatSleepTimer\)\s*st \|= kUStatDrowsy/, "DROWSY graded predicate"],
  // --- WT31 second-word constants ---
  [/kUStat2Migrant\s*=\s*0x00000001/, "kUStat2Migrant 0x1"],
  [/kUStat2Performing\s*=\s*0x00000800/, "kUStat2Performing 0x800 (top of st2)"],
  [/kUStat2NoDestination\s*=\s*0x00000004/, "kUStat2NoDestination reserved bit defined"],
  // --- WT31 second-word predicates ---
  [/misc_trait_type::Migrant[\s\S]*?mt->value > 0\) st2 \|= kUStat2Migrant/, "MIGRANT from misc_trait"],
  [/Units::isJobAvailable\(u, false\)\)\s*\n?\s*st2 \|= kUStat2NoJob/, "NO_JOB uses DFHack isJobAvailable"],
  // SB-SERVER (table row 7 DISTRACTED, sel:188-198): the has_unmet_needs read (the mass-yellow-face
  // root cause) is replaced by the native aggregate focus ratio <= 80, gated on no active mood.
  [/focus_pct <= 80\) st2 \|= kUStat2Distracted/, "DISTRACTED from focus ratio <= 80 (sel:188-198)"],
  // SB-SERVER (table row 22 TERRIFIED, sel:262-284): the invented dominant-emotion==TERROR walk is
  // removed; the honest NAMED-APPROXIMATION fires on emotionally_overloaded alone (R1).
  [/emotionally_overloaded\)\s*\n?\s*st2 \|= kUStat2Terrified/, "TERRIFIED from emotionally_overloaded (NAMED-APPROX, R1)"],
  [/w->unit != -1\) \{ st2 \|= kUStat2Wrestling/, "WRESTLING from status.wrestle_items vs a real opponent"],
  [/u->body\.wounds\.empty\(\)/, "INJURY reads the transient wound vector"],
  [/severe \? kUStat2MajorInjury : kUStat2MinorInjury/, "INJURY major/minor partition"],
  [/activity_event_type::MakeBelieve\) \{\s*\n?\s*st2 \|= kUStat2MakeBelieve/, "MAKE_BELIEVE from main social event"],
  [/performance_participant_type::STORYTELLER:\s*\n?\s*st2 \|= kUStat2TellingStory/, "STORYTELLER -> telling a story"],
  [/performance_participant_type::POEM_RECITER:\s*\n?\s*st2 \|= kUStat2RecitingPoetry/, "POEM_RECITER -> reciting poetry"],
  [/performance_participant_type::DANCER:\s*\n?\s*st2 \|= kUStat2Performing/, "MUSICAL_VOICE/DANCER -> performing"],
];
for (const [re, label] of SRC_PINS) assert.match(ustat, re, `unit_status.h: ${label}`);
// the server MUST NOT set the reserved NO_DESTINATION bit (probe-gated): no `st2 |= kUStat2NoDestination`.
assert.doesNotMatch(ustat, /st2 \|= kUStat2NoDestination/,
  "unit_status.h: NO_DESTINATION stays RESERVED (server never sets it until probe P3)");
// SKIPPED YIELDING must not have leaked in as a predicate (only mentioned as skipped in the banner).
assert.doesNotMatch(ustat, /kUStat2Yield|st2 \|= .*[Yy]ield/,
  "unit_status.h: YIELDING stays dropped (adventure-mode, per the owner scope trim)");
// the shared header is still the ONLY home of the computation (B222): the serializers just call it.
assert.match(read("src", "world_stream.cpp"), /r\.st = unit_status_bits\(u\);/, "world_stream uses the shared st helper");
assert.match(read("src", "world_stream.cpp"), /r\.st2 = unit_status_bits2\(u\);/, "world_stream uses the shared st2 helper");
assert.match(read("src", "tile_map_dump.cpp"), /unit_status_bits2\(u\)/, "tile_map_dump uses the shared st2 helper");
// st2 rides the aux JSON only when non-zero (byte-neutral for a content unit), in BOTH serializers.
assert.match(read("src", "world_stream.cpp"), /if \(u\.st2\) a << ",\\"st2\\":" << u\.st2;/, "world_stream emits st2 only when non-zero");
assert.match(read("src", "tile_map_dump.cpp"), /if \(st2\) js << ",\\"st2\\":" << st2;/, "tile_map_dump emits st2 only when non-zero");
// B222 fold pin: st2 MUST be folded, or an st2-only change never re-ships on the aux delta.
assert.match(read("src", "world_stream.cpp"), /s4_fold_add\(h, u\.st2\)/, "st2 folded into s4_unit_fold (B222)");

// ---- 7) CLIENT source pins: both renderers define BOTH words + return the mapped rows ------------
for (const f of ["dwf-tiles.js", "dwf-gl.js"]) {
  const js = read("web", "js", f);
  assert.match(js, /USTAT_BERSERK = 0x00100000/, `${f} defines USTAT_BERSERK`);
  assert.match(js, /USTAT_DROWSY = 0x10000000/, `${f} defines USTAT_DROWSY`);
  assert.match(js, /if \(st & USTAT_PROJECTILE\) return usCell\(37, "PROJECTILE"\);/, `${f} maps PROJECTILE -> 37`);
  assert.match(js, /if \(st & USTAT_HUNGRY\) return usCell\(3, "HUNGRY"\);/, `${f} maps HUNGRY -> 3`);
  // the pre-WT29 mood nibble decode must survive intact.
  assert.match(js, /MOOD_CELL\[\(st & USTAT_MOOD_MASK\) >> USTAT_MOOD_SHIFT\] \|\| MOOD_CELL\[1\]/, `${f} keeps the mood nibble decode`);
  // WT31 second-word bits + mappings.
  assert.match(js, /USTAT2_MIGRANT = 0x00000001/, `${f} defines USTAT2_MIGRANT`);
  assert.match(js, /USTAT2_PERFORMING = 0x00000800/, `${f} defines USTAT2_PERFORMING`);
  assert.match(js, /if \(st2 & USTAT2_MAJOR_INJURY\) return usCell\(25, "MAJOR_INJURY"\);/, `${f} maps MAJOR_INJURY -> 25`);
  assert.match(js, /if \(st2 & USTAT2_TELLING_A_STORY\) return usCell\(34, "TELLING_A_STORY"\);/, `${f} maps TELLING_A_STORY -> 34`);
  assert.match(js, /if \(st2 & USTAT2_NO_JOB\) return usCell\(1, "NO_JOB"\);/, `${f} maps NO_JOB -> 1`);
  // the resolver takes st2 as a second arg and normalizes an absent one to 0 (back-compat).
  assert.match(js, /function unitStatusIconForBits\(st, st2\)/, `${f} resolver takes st2`);
  assert.match(js, /st2 = st2 \| 0;/, `${f} normalizes absent st2 -> 0`);
}

console.log(`PASS wt30+wt31: ${STATUS.length}+${STATUS2.length} status bits round-trip to their ` +
  "graphics_interface.txt rows in both renderers (full parity); two-word encoding envelope " +
  "positive-int32 & collision-free; absent-st2 old-DLL back-compat; " +
  `${PRIO.length} priority combos resolve to the SHIPPED 18-step NATIVE one-bubble winner across both words; ` +
  "WT31 draw plans reach the canvas2d entry point under the NATIVE per-unit phase cadence; server " +
  "predicates + reserved-bit + fold + client bit maps source-pinned against a silent drop");
