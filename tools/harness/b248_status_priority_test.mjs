// b248_status_priority_test.mjs -- B248: sleeping dwarves showed a gray face, not the Zz bubble;
// thirsty dwarves showed no droplet at all. Run: node tools/harness/b248_status_priority_test.mjs
//
// WHAT B248 ACTUALLY WAS. Every hop of the overhead-status pipeline was already correct:
//   * the SHEET exists and is complete -- data/vanilla/vanilla_interface/graphics/images/
//     unit_status.png is 32x1312 (41 rows of 32px; tile_page_interface.txt PAGE_DIM_PIXELS 32:1312)
//     and graphics_interface.txt maps all 41 rows, MIGRANT=0 .. CLIMBING=40. Row 8 IS the Zz.
//   * the client's bit->row map matches those raws exactly, in BOTH renderers (wt30 pins that).
//   * BOTH serializers ship `st`/`st2` (B222 + WT31), and the deployed DLL carries them.
// The break was that a unit is in SEVERAL of these states at once and the resolver returns ONE
// icon, so the PRIORITY ORDER decides what the player sees -- and it let the BYPRODUCTS of sleep
// beat sleep itself:
//   * flags1.on_ground ("laying on the floor") is true for a dwarf in a bed -> GROUNDED (row 38).
//   * DFHack siren.lua's wake_unit() clears counters.unconscious on a unit whose job_type==Sleep,
//     i.e. DF keeps that counter ticking while a dwarf sleeps -> UNCONSCIOUS (row 30).
//   * DFHack timestream.cpp only DECREMENTS counters2.sleepiness_timer while the Sleep job runs,
//     and a dwarf goes to bed at ~57600 -- so it stays above any sane threshold through most of a
//     sleep -> DROWSY (row 5), which is EXACTLY the gray neutral face the owner reported.
// All three outranked SLEEPING. Whichever fired first, the sleeper never showed the Zz.
//
// The THIRSTY half is the same disease: DISTRACTED (personality.flags.has_unmet_needs -- true for
// a large fraction of any real fort) outranked the concrete physiological needs it is CAUSED BY,
// so a thirsty dwarf rendered the vague yellow "distracted" face (or nothing recognisable as
// thirst) while native showed the droplet. Plus the server graded all three needs off ONE flat
// threshold (kUStatNeedTimer=50000) although every DFHack source puts thirst FAR below hunger
// (siege-engine.cpp: hunger>=50000, thirst>=25000, sleepiness>=57600).
//
// ============================================================================================
// SB-TESTS REWRITE (2026-07-16) -- REPINNED TO THE VERIFIED NATIVE LADDER.
// The v1 evidence lead decoded the native graphics selector FUN_1402685d0 and found the client's
// danger tier was partly INVENTED. Two §3 pins below encoded that invention and are REMOVED here,
// each annotated with the native table row that disproves it:
//   * "webbed still outranks nausea"  -- REMOVED. Native puts WEBBED in the PHYSICAL FALLBACK tier
//     (table §NATIVE PRIORITY step 17; WEBBED row 39), well BELOW NAUSEA (danger step 7, row 28).
//     Native winner for WEBBED|NAUSEA is NAUSEA. (This is the exact pin the GL worker flagged.)
//   * "grounded still outranks fever" -- REMOVED. GROUNDED is also physical fallback (step 17, row
//     38); FEVERED is the illness tier (step 11, row 31). Native winner is FEVERED.
// And the proven need order is now THIRSTY > HUNGRY > DROWSY (table step 12; sel:173/176/179),
// where the OLD client had HUNGRY before THIRSTY -- so this file now PINS thirsty-first.
// Everything in §1 (sleep first), §2 (concrete needs beat DISTRACTED), §4 (per-need thresholds) and
// §5 (raws cross-check) remains valid under the native table and is unchanged.
// This fixture is POST-MERGE: it turns green only once the sb-gl/sb-tiles native ladder is merged.
// ============================================================================================

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { resolveDfRoot } from "../lib/dfroot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

// ---- load BOTH renderers (same harness shape as wt30_status_full_test.mjs) ----------------------
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

// src/unit_status.h bit values (kUStat* / kUStat2*).
const SLEEPING = 0x00000001, UNCONSCIOUS = 0x00000002, STRESSED = 0x00000004;
const WEBBED = 0x00001000, GROUNDED = 0x00008000, NAUSEA = 0x00000800, FEVERED = 0x00004000;
const STUNNED = 0x00000400, PROJECTILE = 0x00010000;   // SB-TESTS: native-ladder danger-tier pins
const HUNGRY = 0x04000000, THIRSTY = 0x08000000, DROWSY = 0x10000000;
const S2_DISTRACTED = 0x00000008, S2_MINOR_INJURY = 0x00000040, S2_NO_JOB = 0x00000002;

function bothResolveTo(st, st2, token, why) {
  const g = glIcon(st, st2), t = tilesIcon(st, st2);
  assert.ok(g, `GL returned no bubble at all: ${why}`);
  assert.ok(t, `Tiles returned no bubble at all: ${why}`);
  assert.equal(g.token, "UNIT_STATUS:" + token, `GL: ${why}`);
  assert.equal(t.token, "UNIT_STATUS:" + token, `Tiles: ${why}`);
  assert.equal(g.row, t.row, `renderer parity: ${why}`);
}

// ---- 1) THE BUG the owner SAW: a real sleeping dwarf carries the byproduct bits too ---------------------
// Every combination below is a state DF genuinely puts a sleeping dwarf in. All must read Zz (row 8).
bothResolveTo(SLEEPING | DROWSY, 0, "SLEEPING",
  "a sleeper is still above the drowsiness threshold that sent him to bed -> must NOT read DROWSY (the gray neutral face)");
bothResolveTo(SLEEPING | GROUNDED, 0, "SLEEPING",
  "a dwarf in a bed is laying on the floor (flags1.on_ground) -> must NOT read GROUNDED");
bothResolveTo(SLEEPING | UNCONSCIOUS, 0, "SLEEPING",
  "DF keeps counters.unconscious ticking while asleep (siren.lua wake_unit clears it) -> must NOT read UNCONSCIOUS");
bothResolveTo(SLEEPING | UNCONSCIOUS | GROUNDED | DROWSY, 0, "SLEEPING",
  "the full real-world sleeping-dwarf bit set must render the Zz");
bothResolveTo(SLEEPING | UNCONSCIOUS | GROUNDED | DROWSY | HUNGRY | THIRSTY, S2_DISTRACTED | S2_MINOR_INJURY,
  "SLEEPING", "sleep wins over every co-carried need/injury/distraction state");
// The Zz row is row 8 (graphics_interface.txt:2447 UNIT_STATUS:SLEEPING) -- pin the number, not just the token.
assert.equal(glIcon(SLEEPING | UNCONSCIOUS | GROUNDED | DROWSY, 0).row, 8, "sleeping resolves to sheet row 8 (the Zz)");

// A genuine knock-out has NO Sleep job, so UNCONSCIOUS must still win when SLEEPING is absent.
bothResolveTo(UNCONSCIOUS | GROUNDED | DROWSY, 0, "UNCONSCIOUS",
  "a real KO (no Sleep job) still reads UNCONSCIOUS");

// ---- 2) THE THIRSTY HALF: a concrete need must beat the vague 'has unmet needs' distraction ------
bothResolveTo(THIRSTY, S2_DISTRACTED, "THIRSTY",
  "a thirsty dwarf almost always ALSO has has_unmet_needs -- the droplet must win, not the yellow face");
bothResolveTo(HUNGRY, S2_DISTRACTED, "HUNGRY", "same for hunger");
bothResolveTo(DROWSY, S2_DISTRACTED, "DROWSY", "same for drowsiness");
bothResolveTo(THIRSTY, S2_DISTRACTED | S2_NO_JOB, "THIRSTY", "a thirsty idler still reads THIRSTY");
// DISTRACTED still renders when no concrete need explains it (that is its whole purpose).
bothResolveTo(0, S2_DISTRACTED, "DISTRACTED", "distraction with no physiological cause still shows");
assert.equal(glIcon(THIRSTY, S2_DISTRACTED).row, 4, "thirsty resolves to sheet row 4 (the droplet)");

// ---- 3) THE NATIVE LADDER (repinned) -- danger tier corrected, need order proven ----------------
// A KO still tops a minor injury (UNCONSCIOUS danger step 2 > MINOR_INJURY step 10).
bothResolveTo(UNCONSCIOUS, S2_MINOR_INJURY, "UNCONSCIOUS", "a KO still tops a minor injury");
// REMOVED INVENTED PINS, replaced by the native winners (see the rewrite banner above):
bothResolveTo(WEBBED | NAUSEA, 0, "NAUSEA",
  "NATIVE: WEBBED is physical fallback (step 17, row 39) -- NAUSEA (danger step 7) wins, not WEBBED");
bothResolveTo(GROUNDED | FEVERED, 0, "FEVERED",
  "NATIVE: GROUNDED is physical fallback (step 17, row 38) -- FEVERED (illness step 11) wins, not GROUNDED");
// PROJECTILE is likewise demoted out of the danger tier: STUNNED (danger step 7) now outranks it.
bothResolveTo(PROJECTILE | STUNNED, 0, "STUNNED",
  "NATIVE: PROJECTILE is physical fallback (step 17, row 37) -- STUNNED (danger step 7) wins");
// The proven need order: THIRSTY > HUNGRY > DROWSY (was HUNGRY-first in the old client).
bothResolveTo(THIRSTY | HUNGRY | DROWSY, 0, "THIRSTY", "NATIVE need order: thirsty first (sel:173)");
bothResolveTo(HUNGRY | DROWSY, 0, "HUNGRY", "NATIVE need order: hungry over drowsy");
// A concrete need now also outranks STRESSED (needs are step 12 THIRSTY>HUNGRY>DROWSY>STRESSED).
bothResolveTo(STRESSED | HUNGRY, 0, "HUNGRY", "NATIVE: a concrete need outranks the STRESSED bubble");

// ---- 4) SERVER: the three graded needs must NOT share one threshold -----------------------------
// A flat kUStatNeedTimer=50000 was the reason the THIRSTY bit never fired (native's droplet appears
// well below it) while HUNGRY/DROWSY over-fired. Grounded per-need in DFHack's own canon --
// dfhack/plugins/siege-engine.cpp:1471-1473: thirst>=25000, hunger>=50000, sleepiness>=57600.
const src = read("src", "unit_status.h");
const need = (name) => {
  const m = src.match(new RegExp("constexpr int " + name + "\\s*=\\s*(\\d+)"));
  assert.ok(m, `src/unit_status.h must define ${name} (the per-need threshold split)`);
  return Number(m[1]);
};
const hunger = need("kUStatHungerTimer");
const thirst = need("kUStatThirstTimer");
const sleepy = need("kUStatSleepTimer");
assert.ok(thirst < hunger, `thirst threshold (${thirst}) must be BELOW hunger (${hunger}) -- every DFHack source has it so`);
assert.ok(sleepy > hunger, `sleepiness threshold (${sleepy}) must be ABOVE hunger (${hunger}) -- dwarves go to bed at ~57600`);
assert.ok(!/constexpr int kUStatNeedTimer/.test(src),
  "the flat kUStatNeedTimer constant must be gone -- one threshold cannot grade three different needs");
for (const [field, konst] of [["hunger_timer", "kUStatHungerTimer"], ["thirst_timer", "kUStatThirstTimer"], ["sleepiness_timer", "kUStatSleepTimer"]])
  assert.ok(new RegExp(`counters2\\.${field}\\s*>=\\s*${konst}`).test(src), `${field} must be graded against ${konst}`);

// ---- 5) the sheet really does ship every row we map (DF install present -> hard check) ----------
// the standing rule: never claim a sprite is absent without running the search. This one runs it.
const DF = resolveDfRoot().root || "";   // W1 resolver; "" => this block soft-skips below
const gfx = DF && path.join(DF, "data/vanilla/vanilla_interface/graphics/graphics_interface.txt");
if (gfx && fs.existsSync(gfx)) {
  const rows = new Map();
  for (const m of fs.readFileSync(gfx, "utf8").matchAll(/\[TILE_GRAPHICS:UNIT_STATUS:0:(\d+):UNIT_STATUS:(\w+)\]/g))
    rows.set(Number(m[1]), m[2]);
  // every row the client resolver can return must be a real declared UNIT_STATUS row
  for (const [st, st2] of [[SLEEPING, 0], [THIRSTY, 0], [HUNGRY, 0], [DROWSY, 0], [UNCONSCIOUS, 0],
                           [GROUNDED, 0], [NAUSEA, 0], [FEVERED, 0], [STRESSED, 0], [0, S2_DISTRACTED]]) {
    const ic = glIcon(st, st2);
    assert.equal("UNIT_STATUS:" + rows.get(ic.row), ic.token,
      `row ${ic.row} must be ${ic.token} in the game's own graphics_interface.txt`);
  }
  assert.equal(rows.get(8), "SLEEPING", "the Zz IS in the raws at UNIT_STATUS row 8");
  assert.equal(rows.get(4), "THIRSTY", "the droplet IS in the raws at UNIT_STATUS row 4");
  assert.equal(rows.get(5), "DROWSY", "row 5 (the gray neutral face the owner saw) is DROWSY");
  assert.equal(rows.size, 41, "the sheet declares 41 UNIT_STATUS rows");
  const png = fs.statSync(path.join(DF, "data/vanilla/vanilla_interface/graphics/images/unit_status.png"));
  assert.ok(png.size > 0, "unit_status.png exists on disk");
} else {
  console.log("  (skip) DF install not mounted -- raws cross-check skipped");
}

console.log("b248_status_priority_test: PASS");
