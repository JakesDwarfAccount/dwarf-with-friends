// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-only
//
// =============================================================================
// B280 -- THE BUBBLE-vs-SHEET CROSS-CHECK.
//
// THE PROBLEM THIS EXISTS TO SOLVE. Seven times in one day a green test on this project masked a
// dead or wrong feature. Every one of them had the same shape: the test asserted WHAT WE WROTE.
// A scrollbar guard read its allow-list out of our own stylesheet and asserted the list contained
// itself. Three test pins encoded a bug as correct. A wire wrapper silently dropped the field
// carrying most statuses -- every bubble dead in the game, every fixture green. A test grepped our
// source for a line of code while the row it "verified" was never served to anybody.
//
// You cannot fix that class of bug by writing a better assertion, because the assertion and the
// code come from the same head. You fix it by getting the EXPECTED VALUES FROM SOMEWHERE THAT IS
// NOT US.
//
// So: the overhead status bubble is OUR claim about a dwarf (we read counters, we apply a
// threshold, we draw a droplet). The word in DF's own unit-sheet Overview box -- "Thirsty" -- is
// DF'S claim about the same dwarf. They are computed by different programs from the same ground
// truth. THEY MUST AGREE. Where they disagree, one of them is lying, and it is not DF.
//
// THE THREE INPUTS, and why none of them is us marking our own homework:
//
//   [DF]     fixtures/df-status-ladder.json -- decoded out of `Dwarf Fortress.exe` by
//            df_status_ladder.py. DF's words, DF's fields, DF's constants. We cannot edit this
//            into agreement with ourselves; it is regenerated from the game.
//   [OURS]   src/unit_status.h + src/unit_status_words.h -- parsed HERE, from the real shipped
//            source. Not a copy of the constants, not a re-declaration in the test: the actual
//            lines the DLL compiles. Change the constant, and this test sees the change.
//   [STATE]  fixtures/status-truth-units.json -- unit states to evaluate: a swept grid across
//            every DF band boundary, plus the one native oracle capture we have.
//
// The test then asserts, for every unit state:  BUBBLE(state) == (DF prints the matching word).
//
// NON-VACUITY IS THE WHOLE POINT, so it is itself tested. `--selftest` seeds each of our
// thresholds with a deliberately wrong value and requires the cross-check to go RED for every
// one. A cross-check that cannot fail is the bug it was built to prevent, wearing a lab coat.
//
//   node tools/harness/status_truth_test.mjs                 # offline: DF ladder vs our source
//   node tools/harness/status_truth_test.mjs --selftest      # prove it can fail
//   node tools/harness/status_truth_test.mjs --live http://127.0.0.1:8765 [--password PW]
//                                                            # live fort: DF's own per-unit state
//                                                            # via GET /statustruth, same assertions
//
// LIVE MODE IS NOT RUN BY THE AGENT THAT WROTE IT. It talks to a real server; the orchestrator
// runs it, holding DF_LOCK, never against a fort the owner is playing.
// =============================================================================
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The client module is a browser script; give it the globals the panel gives it, exactly as
// charprofile_structured_test.mjs does, then drive the REAL markup builder.
globalThis.window = { setTimeout, addEventListener() {} };
globalThis.fetch = async () => ({ ok: false });
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.unitImagesEnabled = true;
globalThis.DWFUI = (await import("../../web/js/dwf-ui-components.js")).default;
const { unitSheetMarkup, renderUnitStatusWords } =
  await import("../../web/js/dwf-unit-hud-notifications.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const LADDER = join(HERE, "fixtures", "df-status-ladder.json");
const UNITS = join(HERE, "fixtures", "status-truth-units.json");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

let pass = 0;
const failures = [];
const ok = (cond, msg) => (cond ? pass++ : failures.push(msg));

// ---------------------------------------------------------------------------
// [OURS] -- read the thresholds we actually SHIP, out of the actual source files.
//
// Deliberately NOT `import`ed from a shared JS constants module: there is no such module, and
// creating one would mean this test checks a copy of the number instead of the number the C++
// compiles. Regex over the real header is the honest coupling. If the constant is renamed away,
// the parse fails loudly rather than silently defaulting.
// ---------------------------------------------------------------------------
function readOurThresholds(overrides = {}) {
  const src = readFileSync(join(REPO, "src", "unit_status.h"), "utf8");
  const grab = (name) => {
    const m = src.match(new RegExp(`constexpr\\s+int\\s+${name}\\s*=\\s*(-?\\d+)\\s*;`));
    if (!m) throw new Error(`src/unit_status.h no longer declares ${name} -- the cross-check ` +
      `cannot read what we ship, which means it cannot check it. Fix the parse, do not delete it.`);
    return Number(m[1]);
  };
  const out = {
    hunger: grab("kUStatHungerTimer"),
    thirst: grab("kUStatThirstTimer"),
    sleep: grab("kUStatSleepTimer"),
    stress: grab("kUStatStressLevel"),
  };
  return { ...out, ...overrides };
}

// The bubble bits our server sets, reimplemented from src/unit_status.h's predicates. This is the
// one place the test restates our logic -- but the NUMBERS come from the source (above) and the
// EXPECTATIONS come from DF (below), so a wrong constant still cannot pass.
function bubbleStates(u, th) {
  return {
    HUNGRY: (u.hunger_timer ?? 0) >= th.hunger,
    THIRSTY: (u.thirst_timer ?? 0) >= th.thirst,
    DROWSY: (u.sleepiness_timer ?? 0) >= th.sleep,
    STRESSED: (u.longterm_stress ?? 0) >= th.stress,
    UNCONSCIOUS: (u.unconscious ?? 0) > 0,
    STUNNED: (u.stunned ?? 0) > 0,
    NAUSEA: (u.nausea ?? 0) > 0,
    WINDED: (u.winded ?? 0) > 0,
    WEBBED: (u.webbed ?? 0) > 0,
    PARALYZED: (u.paralysis ?? 0) > 0,
    FEVERED: (u.fever ?? 0) > 0,
  };
}

// ---------------------------------------------------------------------------
// [DF] -- what words DF's own sheet prints for this unit, straight off the decoded ladder.
// Nothing here is typed by hand: the fields, the words and the constants all come out of the JSON
// the extractor wrote from the game binary.
// ---------------------------------------------------------------------------
const FIELD_KEY = {
  "counters2.hunger_timer": "hunger_timer",
  "counters2.thirst_timer": "thirst_timer",
  "counters2.sleepiness_timer": "sleepiness_timer",
  "counters2.paralysis": "paralysis",
  "counters2.fever": "fever",
  "counters2.numbness": "numbness",
  "counters2.exhaustion": "exhaustion",
  "counters.unconscious": "unconscious",
  "counters.stunned": "stunned",
  "counters.nausea": "nausea",
  "counters.dizziness": "dizziness",
  "counters.winded": "winded",
  "counters.webbed": "webbed",
  "counters.pain": "pain",
  "soul.personality.longterm_stress": "longterm_stress",
};

// Which overhead bubble each DF word corresponds to. A word maps to a bubble when DF's own
// UNIT_STATUS row (data/vanilla/vanilla_interface/graphics/graphics_interface.txt) names the same
// state -- HUNGRY row 3, THIRSTY row 4, DROWSY row 5, STRESSED row 6, and so on. Words with no
// row (Dehydrated, Starving, Very drowsy, Haggard, Harrowed) are DF's *higher bands* of the same
// state, so they map to the same bubble: DF drawing "Dehydrated" and us drawing the thirst droplet
// is agreement, not disagreement. Words DF prints for states with no bubble at all are listed as
// null and are not asserted on.
const WORD_TO_BUBBLE = {
  Hungry: "HUNGRY", Starving: "HUNGRY",
  Thirsty: "THIRSTY", Dehydrated: "THIRSTY",
  Drowsy: "DROWSY", "Very drowsy": "DROWSY",
  Stressed: "STRESSED", Haggard: "STRESSED", Harrowed: "STRESSED",
  Unconscious: "UNCONSCIOUS",
  Stunned: "STUNNED",
  Nauseous: "NAUSEA",
  Winded: "WINDED",
  Webbed: "WEBBED", "Partially webbed": "WEBBED",
  Fever: "FEVERED",
  Paralyzed: "PARALYZED", "Partially paralyzed": "PARALYZED", Sluggish: "PARALYZED",
  // DF prints these; DF ships no overhead row for them. Not asserted, not forgotten.
  Tired: null, "Over-exerted": null, Exhausted: null,
  Dizzy: null, Pain: null, "Extreme pain": null, Numb: null,
};

function dfWordsFor(unit, ladder) {
  // group the fortress gates by field, walk each ladder top-down, take the first word that fires.
  const byField = new Map();
  for (const row of ladder.fortress) {
    if (!row.field) continue;
    if (!byField.has(row.field)) byField.set(row.field, []);
    byField.get(row.field).push(row);
  }
  const words = [];
  for (const [field, gates] of byField) {
    const key = FIELD_KEY[field];
    if (!key) continue;
    const v = unit[key] ?? 0;
    const sorted = [...gates].sort((a, b) => b.min - a.min);
    for (const g of sorted) {
      // DF's own test: `>= min`, except a min of 0 which is DF testing the field truthily (`> 0`).
      if (g.min === 0 ? v > 0 : v >= g.min) { words.push(g.word); break; }
    }
  }
  return words;
}

// ---------------------------------------------------------------------------
// THE ASSERTION.  bubble-state == sheet-word, for every unit, in both directions.
// ---------------------------------------------------------------------------
function crossCheck(units, ladder, th, label) {
  const disagreements = [];
  for (const u of units) {
    const words = dfWordsFor(u, ladder);
    const bubbles = bubbleStates(u, th);
    const dfSays = new Set(words.map((w) => WORD_TO_BUBBLE[w]).filter(Boolean));
    for (const [bubble, weSay] of Object.entries(bubbles)) {
      const dfSaysIt = dfSays.has(bubble);
      if (weSay === dfSaysIt) continue;
      disagreements.push({
        unit: u.name || u.id || "(fixture)",
        bubble,
        we: weSay ? "BUBBLE ON" : "bubble off",
        df: dfSaysIt ? `sheet says ${words.filter((w) => WORD_TO_BUBBLE[w] === bubble).join("/")}`
                     : "sheet says nothing",
        state: Object.fromEntries(Object.entries(u).filter(([k, v]) =>
          typeof v === "number" && v !== 0 && k !== "id")),
      });
    }
  }
  ok(disagreements.length === 0,
    `${label}: ${disagreements.length} unit(s) where OUR BUBBLE DISAGREES WITH DF'S OWN SHEET\n` +
    disagreements.slice(0, 12).map((d) =>
      `      ${d.unit}: ${d.bubble} -- we ${d.we}, DF ${d.df}  ${JSON.stringify(d.state)}`).join("\n"));
  return disagreements;
}

// ---------------------------------------------------------------------------
function main() {
  if (!existsSync(LADDER)) {
    console.log("SKIP status_truth_test -- no fixtures/df-status-ladder.json.\n" +
      "  Regenerate on a machine with DF installed:\n" +
      "    python tools/harness/df_status_ladder.py --write");
    return 0;
  }
  const ladder = JSON.parse(readFileSync(LADDER, "utf8"));
  const units = JSON.parse(readFileSync(UNITS, "utf8")).units;
  const th = readOurThresholds();

  // --- 1. our shipped constants must BE DF's onset constants ---------------------------------
  // The direct form of the question the owner asked. Not "is our constant the one the comment cites" --
  // "is our constant the number DF itself compares against".
  const wantOnset = {
    hunger: ["counters2.hunger_timer", "Hungry"],
    thirst: ["counters2.thirst_timer", "Thirsty"],
    sleep: ["counters2.sleepiness_timer", "Drowsy"],
    stress: ["soul.personality.longterm_stress", "Stressed"],
  };
  for (const [ours, [field, word]] of Object.entries(wantOnset)) {
    const df = ladder.onset[field];
    ok(df && df.word === word && df.min === th[ours],
      `threshold drift: we fire the ${ours.toUpperCase()} bubble at ${th[ours]}, but DF prints ` +
      `"${df ? df.word : "?"}" at ${df ? df.min : "?"} (${field}). DF wins.`);
  }

  // --- 2. the full cross-check over the swept state grid --------------------------------------
  crossCheck(units, ladder, th, "swept state grid");

  // --- 3. every DF fortress word must be one we have classified --------------------------------
  // Stops the silent-omission failure mode: a word DF can print that we never mapped would
  // otherwise just never be compared, and the suite would stay green while a state went unmodelled.
  const unmapped = [...new Set(ladder.fortress.map((r) => r.word))]
    .filter((w) => !(w in WORD_TO_BUBBLE));
  ok(unmapped.length === 0,
    `DF can print ${unmapped.length} status word(s) this test never classified: ${unmapped.join(", ")}. ` +
    `Map each to a bubble or to null (explicitly "no overhead row"), never leave it unlisted.`);

  // --- 4. the words our C++ emits must be exactly DF's words ------------------------------------
  const wordsSrc = readFileSync(join(REPO, "src", "unit_status_words.h"), "utf8");
  const emitted = new Set([...wordsSrc.matchAll(/out\.push_back\("([^"]+)"\)/g)].map((m) => m[1]));
  // every word DF's binary contains -- including the ones the extractor could not gate (it found
  // the string and the branch, just not a single comparable field). A word we emit that is in NONE
  // of these lists is a word we made up.
  const dfWords = new Set([...ladder.fortress, ...ladder.adventure, ...ladder.ungated]
    .map((r) => r.word));
  const invented = [...emitted].filter((w) => !dfWords.has(w));
  ok(invented.length === 0,
    `src/unit_status_words.h emits ${invented.length} word(s) that are NOT in DF's binary: ` +
    `${invented.join(", ")}. That is invented data -- the B255 failure mode.`);

  // --- 5. the CLIENT renders DF's words, and never invents one ---------------------------------
  // The wire wrapper that silently dropped the status field was green in every fixture because no
  // test ever rendered the actual markup. This one does: it drives the real unitSheetMarkup().
  {
    const overview = (unit) => unitSheetMarkup({ unit }, { tab: "Overview", detail: null });
    const thirsty = overview({ id: 1, statusWords: ["Thirsty"] });
    ok(thirsty.includes("Thirsty"),
      "the Overview does not render DF's status word: the sheet cell dropped `statusWords`.");
    ok(!thirsty.includes("No health problems"),
      "the Overview still shows the old 'No health problems' Health cell for a unit DF calls " +
      "Thirsty -- the native oracle has no Health title in that box, it has the status word.");
    // the status CELL itself, isolated -- an assertion over the whole sheet would be satisfied (or
    // broken) by any other cell's text, which is how a test ends up measuring the wrong thing.
    const content = renderUnitStatusWords({ id: 2, statusWords: [] });
    for (const invented of ["Healthy", "No health problems", "Fine", "OK"]) {
      ok(!content.includes(invented),
        `the Overview status box invents the word "${invented}" for a dwarf DF says nothing about. ` +
        `DF's box is a list of conditions; an empty list is an empty box. Do not fill it in.`);
    }
    ok(renderUnitStatusWords({ id: 1, statusWords: ["Very drowsy", "Stressed"] })
      .match(/Very drowsy[\s\S]*Stressed/),
      "the status box must render every word DF emits, in DF's order -- not just the first.");
    const oldDll = renderUnitStatusWords({ id: 3, bodySummary: "No health problems" }); // no field
    ok(oldDll.includes("No health problems"),
      "a pre-B280 DLL sends no statusWords and the client must keep drawing the old cell rather " +
      "than blanking the grid. The fallback is gone.");
  }

  // --- 6. --selftest: PROVE THE CROSS-CHECK CAN FAIL --------------------------------------------
  if (flag("--selftest")) {
    const before = failures.length;
    let caught = 0;
    for (const key of ["hunger", "thirst", "sleep", "stress"]) {
      const bad = readOurThresholds({ [key]: th[key] + 5000 });
      const probe = [];
      const savedFailures = failures.length;
      const d = crossCheckSilent(units, ladder, bad);
      if (d.length > 0) caught++;
      else probe.push(key);
      failures.length = savedFailures;
      ok(d.length > 0,
        `SELFTEST FAILED: seeding a WRONG ${key} threshold (${th[key]} -> ${th[key] + 5000}) ` +
        `produced ZERO disagreements. The cross-check cannot fail, so it is proving nothing. ` +
        `The state grid is not exercising this band -- add fixtures across its boundary.`);
    }
    ok(failures.length === before + (4 - caught),
      "selftest bookkeeping");
    console.log(`  selftest: ${caught}/4 seeded-wrong thresholds were caught RED`);
  }

  console.log(failures.length === 0
    ? `PASS status_truth_test -- ${pass} checks; ${units.length} unit states cross-checked against ` +
      `DF's own ladder (${ladder.fortress.length} gates decoded from ${ladder.exe})`
    : `FAIL status_truth_test -- ${failures.length} failure(s):\n` +
      failures.map((f) => "  - " + f).join("\n"));
  return failures.length === 0 ? 0 : 1;
}

function crossCheckSilent(units, ladder, th) {
  const saved = failures.length;
  const d = crossCheck(units, ladder, th, "selftest");
  failures.length = saved;
  return d;
}

// ---------------------------------------------------------------------------
// LIVE MODE -- same assertions, against a real fort. The server's GET /statustruth hands back,
// per unit, DF's raw counters AND the st/st2 bits it actually shipped to the browser, so this
// compares the bubble the CLIENT WILL DRAW against the word DF'S OWN SHEET WOULD PRINT for the
// same dwarf at the same instant. No fixture in between.
// ---------------------------------------------------------------------------
async function live(base) {
  const ladder = JSON.parse(readFileSync(LADDER, "utf8"));
  const password = opt("--password");
  const headers = password ? { Cookie: `dfcap_auth=${password}` } : {};
  if (password) await fetch(`${base}/join?password=${encodeURIComponent(password)}`, { headers });
  const res = await fetch(`${base}/statustruth`, { headers });
  if (!res.ok) {
    console.log(`FAIL status_truth_test --live -- GET /statustruth returned ${res.status}`);
    return 1;
  }
  const payload = await res.json();
  const th = readOurThresholds();
  const d = crossCheck(payload.units, ladder, th, `live fort (${payload.units.length} units)`);

  // The server also reports the st/st2 bits it really emitted. Assert those against the same
  // thresholds -- this catches a DLL that is stale relative to the source this test just parsed,
  // which is a failure mode no source-only test can ever see.
  for (const u of payload.units) {
    const want = bubbleStates(u, th);
    // SB-TESTS (2026-07-16): the STRESSED *bubble* bit changed fields. bubbleStates() keeps grading
    // the unit-SHEET word off longterm_stress >= kUStatStressLevel(20000) -- correct for the B280
    // sheet cross-check and UNCHANGED. But the overhead bubble bit (st & 0x04) now reflects the
    // native overhead selector's RAW accumulator personality.stress >= 10000 (kUStatBubbleStress;
    // table row 6, sel:184). /statustruth ships BOTH numbers (status_truth.cpp:80-81), so compare the
    // shipped bit against the raw-stress rule it is actually computed from -- not the sheet rule.
    const wantBits = {
      HUNGRY: want.HUNGRY, THIRSTY: want.THIRSTY, DROWSY: want.DROWSY,
      STRESSED: (typeof u.stress === "number" ? u.stress : 0) >= 10000,
    };
    const got = {
      HUNGRY: !!(u.st & 0x04000000), THIRSTY: !!(u.st & 0x08000000),
      DROWSY: !!(u.st & 0x10000000), STRESSED: !!(u.st & 0x04),
    };
    for (const k of Object.keys(got)) {
      ok(got[k] === wantBits[k],
        `live: unit ${u.id} (${u.name}) -- the DLL shipped ${k}=${got[k]} but the current source ` +
        `says ${wantBits[k]} (${JSON.stringify(u)}). The deployed DLL is stale, or the source changed ` +
        `without a rebuild. (STRESSED bubble uses raw stress>=10000, NOT sheet longterm_stress.)`);
    }
  }
  console.log(failures.length === 0
    ? `PASS status_truth_test --live -- ${payload.units.length} live dwarves, ${pass} checks, ` +
      `0 bubble/sheet disagreements`
    : `FAIL status_truth_test --live -- ${failures.length} failure(s):\n` +
      failures.map((f) => "  - " + f).join("\n"));
  return failures.length === 0 ? 0 : 1;
}

const liveBase = opt("--live");
process.exit(liveBase ? await live(liveBase) : main());
