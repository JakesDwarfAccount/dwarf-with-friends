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
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

// B232 -- the full announcements/reports SCREEN.
//
// THE CENTRAL FACT THIS GATE EXISTS TO PIN:
//   DF HAS NO `SIEGE` ANNOUNCEMENT TOKEN, AND NO `ARTIFACT_CREATED` ONE EITHER.
// B160 shipped its two "special sections" as `typeKey === "SIEGE"` and `typeKey ===
// "ARTIFACT_CREATED"`. Both matched exactly zero reports, forever, and the ui-lab fixture agreed
// with the bug because it INVENTED those tokens too. So this file checks the taxonomy against DF's
// OWN RAWS (data/init/announcements.txt) rather than against anybody's belief about them.
//
// Five things are gated, one per line of the brief:
//   1. the raws-derived CLASSIFICATION (and that C++ and JS agree on it, token for token)
//   2. the WIRE SHAPE  (what /reports emits)
//   3. PAGING           (before/since cursors, and that backfill always makes progress)
//   4. SECTION FILTERING
//   5. CENTER-ON-EVENT-ONLY-ON-CLICK (B216)
//
// Every rule that can be seeded is paired with a SEEDED-BAD -- under --selftest the rule must
// REJECT it. A rule that still passes against its seeded-bad cannot fail, and is reported FAILED.
//
//   node tools/harness/b232_announce_screen_test.mjs
//   node tools/harness/b232_announce_screen_test.mjs --selftest
//
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveDfRoot } from "../lib/dfroot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const SELFTEST = process.argv.includes("--selftest");
const p = (...parts) => join(root, ...parts);
const read = (...parts) => readFileSync(p(...parts), "utf8");

let passed = 0, failed = 0;
function rule(name, fn, seedBad) {
  try {
    fn();
    if (SELFTEST && seedBad) {
      let rejected = false;
      try { seedBad(); } catch (_) { rejected = true; }
      if (!rejected) {
        console.log(`  SELFTEST FAIL - ${name}: the rule PASSED its seeded-bad, so it cannot fail`);
        failed++; return;
      }
    }
    console.log(`  ok - ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL - ${name}\n        ${err.message.split("\n")[0]}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------------------------
// Load the real modules.
// ---------------------------------------------------------------------------------------------
globalThis.window = { setTimeout, setInterval, clearInterval, addEventListener() {} };
globalThis.fetch = async () => ({ ok: false });
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.DWFUI = (await import("../../web/js/dwf-ui-components.js")).default;
globalThis.window.DWFUI = globalThis.DWFUI;

const TAX = (await import("../../web/js/dwf-announce-taxonomy.js")).default;
globalThis.DwfAnnounceTaxonomy = TAX;
globalThis.window.DwfAnnounceTaxonomy = TAX;

const FORMAT = (await import("../../web/js/dwf-announcement-format.js")).default;
globalThis.DwfAnnouncementFormat = FORMAT;
globalThis.window.DwfAnnouncementFormat = FORMAT;

const HUD = await import("../../web/js/dwf-unit-hud-notifications.js");
globalThis.escapeHtml = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
globalThis.alertIconStyle = HUD.alertIconStyle;
globalThis.dfTextColor = HUD.dfTextColor;
globalThis.reportText = HUD.reportText;
globalThis.activeInfoPanel = null;
globalThis.clientPanel = { classList: { contains: () => false } };
const ANN = (await import("../../web/js/dwf-announcements.js")).default;

const announceCpp = read("src", "announcements.cpp");
const announceH = read("src", "announcements.h");
const taxonomyH = read("src", "announce_taxonomy.gen.h");
const annSrc = read("web", "js", "dwf-announcements.js");
const hudSrc = read("web", "js", "dwf-unit-hud-notifications.js");
const indexHtml = read("web", "index.html");
// The client's comments deliberately QUOTE the dead B160 code (`typeKey === "SIEGE"`) so the next
// agent can see what was wrong and why. So the "is the dead filter gone" rules must scan the CODE,
// not the prose -- otherwise the explanation of the bug would read as the bug.
const annCode = annSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const hudCode = hudSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------------------------------------
// 1. THE RAWS-DERIVED CLASSIFICATION.
// ---------------------------------------------------------------------------------------------
console.log("\n1. classification (derived from DF's own announcements.txt)");

// The hard evidence, restated as an assertion. If a future DF ever DOES add a SIEGE token, this
// rule fires and tells the next agent to re-derive the taxonomy instead of silently mis-sectioning.
rule("DF has NO `SIEGE` and NO `ARTIFACT_CREATED` token -- B160's two sections matched nothing", () => {
  assert.equal(TAX.BY_KEY.SIEGE, undefined,
    "a SIEGE announcement token now exists -- the sieges section must be re-derived from it");
  assert.equal(TAX.BY_KEY.ARTIFACT_CREATED, undefined,
    "an ARTIFACT_CREATED token now exists -- re-derive the artifacts section");
  // ...and the ones that DO exist, which is what the sections are actually built from.
  assert.ok(TAX.BY_KEY.MADE_ARTIFACT, "MADE_ARTIFACT is the real 'an artifact was created' token");
  assert.ok(TAX.BY_KEY.NAMED_ARTIFACT, "NAMED_ARTIFACT is real");
  assert.ok(TAX.BY_KEY.AMBUSH_AMBUSHER, "the AMBUSH_* family is the real invasion family");
  assert.ok(TAX.BY_KEY.MEGABEAST_ARRIVAL && TAX.BY_KEY.UNDEAD_ATTACK, "and so are these");
});

rule("the seven sections exist and `misc` is id 0 (an unknown token degrades to Misc, never elsewhere)", () => {
  assert.deepEqual(TAX.SECTIONS.map(s => s.key),
    ["misc", "combat", "sieges", "artifacts", "trade", "nobles", "deaths"]);
  assert.equal(TAX.SECTIONS[0].key, "misc");
  assert.equal(TAX.sectionId("A_TOKEN_DF_HAS_NEVER_HEARD_OF", 0), 0, "unknown token + GENERAL -> Misc");
});

rule("every section a human asked for actually classifies its headline tokens", () => {
  const want = {
    // sieges/invasions -- the family DF really has, since it has no SIEGE token
    AMBUSH_AMBUSHER: "sieges", AMBUSH_THIEF: "sieges", BEAST_AMBUSH: "sieges",
    MEGABEAST_ARRIVAL: "sieges", WEREBEAST_ARRIVAL: "sieges", UNDEAD_ATTACK: "sieges",
    NIGHT_ATTACK_STARTS: "sieges", CITIZEN_SNATCHED: "sieges",
    // artifacts -- B160's actual intent
    MADE_ARTIFACT: "artifacts", NAMED_ARTIFACT: "artifacts", ARTIFACT_BEGUN: "artifacts",
    STRANGE_MOOD: "artifacts", MASTERPIECE_CRAFTED: "artifacts",
    // deaths outrank combat: CITIZEN_DEATH carries UCR_A, and a death belongs in Deaths
    CITIZEN_DEATH: "deaths", PET_DEATH: "deaths", CITIZEN_MISSING: "deaths",
    // combat -- DF's OWN marker is the UCR / UCR_A flag
    COMBAT_DODGE: "combat", COMBAT_PARRY: "combat", CAUGHT_IN_FLAMES: "combat",
    // trade & diplomacy
    CARAVAN_ARRIVAL: "trade", MERCHANTS_NEED_DEPOT: "trade", DIPLOMAT_ARRIVAL: "trade",
    // nobles & mandates
    NEW_MANDATE: "nobles", MONARCH_ARRIVAL: "nobles", ELECTION_RESULTS: "nobles",
    // and the fallthrough really is misc
    WEATHER_BECOMES_RAIN: "misc", SEASON_SPRING: "misc",
  };
  for (const [token, section] of Object.entries(want)) {
    assert.equal(TAX.sectionKey(token, 0), section, `${token} must classify as ${section}`);
  }
});

rule("COMBAT is DF's UCR/UCR_A flag, not a name prefix -- so it catches the tokens that do not say COMBAT", () => {
  // These are combat-log lines that do NOT begin with COMBAT_. A name-prefix classifier drops them
  // all on the floor and combat reads as a wall of fragments -- which is TX14's complaint.
  for (const token of ["CAUGHT_IN_WEB", "PAIN_KO", "KNOCKED_OUT_BY_STRESS_DUMMY_IGNORED"]) {
    if (!TAX.BY_KEY[token]) continue;
    assert.ok((TAX.flagsFor(token) & (TAX.FLAGS.UCR | TAX.FLAGS.UCR_ACTIVE)) !== 0 ||
      TAX.sectionKey(token, 0) === "combat", `${token}`);
  }
  assert.equal(TAX.sectionKey("CAUGHT_IN_FLAMES", 0), "combat",
    "CAUGHT_IN_FLAMES carries UCR_A and must be combat even though its name does not say COMBAT");
  assert.ok((TAX.flagsFor("COMBAT_DODGE") & TAX.FLAGS.UCR) !== 0, "COMBAT_DODGE carries UCR");
});

rule("the ALERT-TYPE RESCUE is fail-open: it can only move a row OUT of Misc, never between sections", () => {
  // DF's siege banner is HARDCODED outside the raws. If it arrives with an unknown token but an
  // AMBUSH alert type, the rescue still lands it in Sieges rather than losing it in Misc.
  assert.equal(TAX.sectionKey("SOME_FUTURE_SIEGE_TOKEN", 5), "sieges",
    "unknown token + AMBUSH alert type must be rescued into sieges");
  assert.equal(TAX.sectionKey("SOME_FUTURE_TOKEN", 21), "deaths", "+ DEATH alert type -> deaths");
  assert.equal(TAX.sectionKey("SOME_FUTURE_TOKEN", 34), "combat", "+ COMBAT alert type -> combat");
  // The rescue must NOT be able to override a token the raws already classified.
  assert.equal(TAX.sectionKey("CITIZEN_DEATH", 34), "deaths",
    "a COMBAT alert type must NOT drag CITIZEN_DEATH out of Deaths -- the raws win");
  assert.equal(TAX.sectionKey("MADE_ARTIFACT", 5), "artifacts",
    "an AMBUSH alert type must NOT drag MADE_ARTIFACT into Sieges");
});

// THE CROSS-SYNC. Two tables, one generator: if they ever disagree, the server pages one section
// and the browser labels another, and nothing else in the suite would notice.
rule("the C++ table and the JS table agree token-for-token (one generator, two outputs)", () => {
  const cppRows = [...taxonomyH.matchAll(/\{\s*"([A-Z0-9_]+)",\s*SECTION_([A-Z]+),\s*(\d+)\s*\}/g)]
    .map(m => [m[1], m[2].toLowerCase(), Number(m[3])]);
  assert.ok(cppRows.length > 300, `expected the full enum in the C++ table, saw ${cppRows.length}`);
  assert.equal(cppRows.length, Object.keys(TAX.BY_KEY).length,
    "the C++ and JS tables must have the same number of tokens");
  for (const [token, section, flags] of cppRows) {
    const js = TAX.BY_KEY[token];
    assert.ok(js, `${token} is in the C++ table but not the JS one`);
    assert.equal(TAX.SECTIONS[js[0]].key, section, `${token}: section disagrees (js vs c++)`);
    assert.equal(js[1], flags, `${token}: flags disagree (js vs c++)`);
  }
});

rule("the generated tables are IN SYNC WITH THE RAWS ON DISK (the generator is idempotent)", () => {
  // If DF ever changes announcements.txt under us, or somebody hand-edits a generated file, this
  // is the rule that says so. Skipped (not failed) when DF is not installed on this machine.
  const dfRoot = resolveDfRoot().root;   // W1: resolved, never hardcoded
  if (!dfRoot || !existsSync(join(dfRoot, "data", "init", "announcements.txt"))) {
    console.log("        (skipped: no Dwarf Fortress install found -- pass --df-root or set DWF_DF_ROOT)");
    return;
  }
  execFileSync("python", [p("tools", "harness", "gen_announce_taxonomy.py"), "--check"],
    { cwd: root, encoding: "utf8", stdio: "pipe" });
});

rule("the BOX flag matches DF's raws exactly (35 tokens box + hard-pause; there is no SIEGE among them)", () => {
  const boxed = Object.keys(TAX.BY_KEY).filter(k => TAX.isBox(k)).sort();
  assert.equal(boxed.length, 35, `announcements.txt defines 35 BOX tokens, table has ${boxed.length}`);
  for (const t of ["MADE_ARTIFACT", "NAMED_ARTIFACT", "MEGABEAST_ARRIVAL", "UNDEAD_ATTACK",
                   "AMBUSH_HERO", "MOUNTAINHOME", "DEITY_CURSE", "STRUCK_DEEP_METAL"])
    assert.ok(boxed.includes(t), `${t} must carry BOX`);
  // Ambushes carry ALERT, not BOX -- they light the alert button, they do not stop the game.
  assert.ok(!TAX.isBox("AMBUSH_THIEF") && TAX.isAlert("AMBUSH_THIEF"),
    "AMBUSH_THIEF carries ALERT, not BOX");
});

// ---------------------------------------------------------------------------------------------
// 2. THE WIRE SHAPE.
// ---------------------------------------------------------------------------------------------
console.log("\n2. wire shape (/reports)");

rule("the C++ EMITS section / sectionId / box / alert on every report", () => {
  for (const key of ["\\\"section\\\":", "\\\"sectionId\\\":", "\\\"taxonomyFlags\\\":",
                     "\\\"box\\\":", "\\\"alert\\\":"])
    assert.ok(announceCpp.includes(key), `announcements.cpp must emit ${key}`);
});

rule("the C++ EMITS the paging + counts envelope the screen needs", () => {
  for (const key of ["\\\"nextBeforeId\\\":", "\\\"reachedOldest\\\":", "\\\"budgetExhausted\\\":",
                     "\\\"scanned\\\":", "\\\"totalReports\\\":", "\\\"counts\\\":", "\\\"sections\\\":"])
    assert.ok(announceCpp.includes(key), `announcements.cpp must emit ${key}`);
});

rule("the route READS before / section / counts (not just since / category)", () => {
  assert.match(announceCpp, /query_int\(req,\s*"before"/, "the route must read `before`");
  assert.match(announceCpp, /query_int\(req,\s*"counts"/, "the route must read `counts`");
  assert.match(announceCpp, /resolve_section_param\(req\)/, "the route must resolve `section`");
  assert.match(announceH, /resolve_section_param/, "and declare it");
});

rule("the C++ pulls the taxonomy from the GENERATED header, not from a hand-typed list", () => {
  assert.match(announceCpp, /#include "announce_taxonomy\.gen\.h"/);
  assert.match(announceCpp, /taxonomy::section_for\(/);
  assert.match(taxonomyH, /GENERATED BY tools\/harness\/gen_announce_taxonomy\.py -- DO NOT EDIT/);
  // B160's dead FILTERS must be gone. (The token NAMES survive in comments, on purpose -- the next
  // agent needs to know why they are not there. So this checks for the CODE, not the string.)
  assert.ok(!announceCpp.includes('"SIEGE"'), "no hand-typed SIEGE token in the C++");
  assert.ok(!/typeKey\s*===\s*"(SIEGE|ARTIFACT_CREATED)"/.test(annCode),
    "B160's dead typeKey filter must be gone from the client CODE");
  assert.ok(!/"ARTIFACT_CREATED"/.test(annCode), "and so must the token it invented");
});

rule("the client loads the taxonomy BEFORE the panel that uses it", () => {
  const tax = indexHtml.indexOf("dwf-announce-taxonomy.js");
  const panel = indexHtml.indexOf("dwf-announcements.js");
  assert.ok(tax > 0, "index.html must load the taxonomy module");
  assert.ok(tax < panel, "the taxonomy must load BEFORE dwf-announcements.js");
});

// ---------------------------------------------------------------------------------------------
// 3. PAGING.
// ---------------------------------------------------------------------------------------------
console.log("\n3. paging");

// The backward walk, transcribed to JS so the ALGORITHM is testable without a live DF. It mirrors
// build_reports_page(): only a LEAD can match, a lead drags its continuation tail, and
// next_before_id is the oldest EXAMINED id (not the oldest MATCHED one).
function serverPage(reports, { since = -1, before = -1, section = -1, max = 200, budget = 20000 } = {}) {
  const out = { reports: [], scanned: 0, truncated: false, budgetExhausted: false,
                reachedOldest: false, nextBeforeId: before, totalReports: reports.length };
  let leads = 0;
  const collected = [];
  for (let i = reports.length - 1; i >= 0; i--) {
    const r = reports[i];
    if (!r) continue;
    if (before >= 0 && r.id >= before) continue;
    if (r.id <= since) break;
    if (out.scanned >= budget) { out.budgetExhausted = true; break; }
    const candidate = !r.continuation &&
      (section < 0 || TAX.sectionId(r.typeKey, r.alertType) === section);
    // The full-page break is BEFORE the entry is consumed -- see the comment in the C++. Advancing
    // the cursor past a report we did not return drops it forever.
    if (candidate && leads >= max) { out.truncated = true; break; }
    out.scanned++;
    out.nextBeforeId = r.id;
    if (i === 0) out.reachedOldest = true;
    if (!candidate) continue;
    leads++;
    const msg = [r];
    for (let j = i + 1; j < reports.length && reports[j] && reports[j].continuation; j++) msg.push(reports[j]);
    for (let k = msg.length - 1; k >= 0; k--) collected.push(msg[k]);
  }
  if (reports.length === 0) out.reachedOldest = true;
  out.reports = collected.reverse();
  return out;
}

// A fort's log: 1200 reports, one siege buried near the very beginning.
const LOG = [];
for (let i = 0; i < 1200; i++) {
  const combat = i % 3 === 0;
  LOG.push({
    id: 100 + i, continuation: false, year: 250, time: i * 300,
    typeKey: i === 5 ? "AMBUSH_AMBUSHER" : combat ? "COMBAT_DODGE" : "WEATHER_BECOMES_RAIN",
    alertType: i === 5 ? 5 : combat ? 34 : 24,
    text: i === 5 ? "A vile force of darkness has arrived!" : `event ${i}`,
    pos: { x: 1, y: 2, z: 3 }, zoomType: 0,
  });
}

rule("the FIRST page is the NEWEST page, and it is capped -- not the whole vector", () => {
  const page = serverPage(LOG, { max: 200 });
  assert.equal(page.reports.length, 200, "200 messages, not 1200");
  assert.ok(page.truncated, "and it says there is more");
  assert.equal(page.reports[page.reports.length - 1].id, 1299, "newest report is last (oldest -> newest)");
  assert.ok(!page.reachedOldest, "and it has NOT reached the beginning of the log");
});

rule("`before` BACKFILLS: paging older eventually reaches the beginning, and every page makes progress", () => {
  let before = -1, pages = 0, seen = 0, last = Infinity;
  for (;;) {
    const page = serverPage(LOG, { before, max: 200 });
    pages++;
    seen += page.reports.length;
    assert.ok(page.nextBeforeId < last, "the cursor must strictly DECREASE or paging never ends");
    last = page.nextBeforeId;
    if (page.reachedOldest) break;
    before = page.nextBeforeId;
    assert.ok(pages < 50, "backfill did not terminate");
  }
  assert.equal(seen, 1200, "backfill must eventually surface EVERY report in the log");
  assert.equal(pages, 6, "1200 reports / 200 per page");
});

rule("backfill makes progress even when the SECTION FILTER matches nothing in the window", () => {
  // The one siege is at id 105 -- 1194 reports back. A cursor that only advanced on a MATCH would
  // stall here forever and the client would hammer /reports. `nextBeforeId` is the oldest EXAMINED.
  const page = serverPage(LOG, { section: TAX.sectionId("AMBUSH_AMBUSHER", 5), max: 200, budget: 300 });
  assert.equal(page.reports.length, 0, "no siege within the first 300 scanned");
  assert.ok(page.budgetExhausted, "and it says why it stopped");
  assert.ok(page.nextBeforeId < 1299 && page.nextBeforeId > 100,
    "the cursor still ADVANCED, so the next call resumes instead of re-scanning the same tail");
  // ...and continuing from it does find the siege.
  let before = page.nextBeforeId, found = null;
  for (let i = 0; i < 20 && !found; i++) {
    const next = serverPage(LOG, { before, section: 2, max: 200, budget: 300 });
    if (next.reports.length) found = next.reports[0];
    if (next.reachedOldest) break;
    before = next.nextBeforeId;
  }
  assert.ok(found, "resuming from the cursor must eventually reach the siege at the start of the log");
  assert.equal(found.typeKey, "AMBUSH_AMBUSHER");
});

rule("the SCAN BUDGET bounds the work per request (B221: nothing slow under the core lock)", () => {
  const page = serverPage(LOG, { budget: 50 });
  assert.equal(page.scanned, 50, "a request must never examine more than its budget");
  assert.ok(page.budgetExhausted);
  assert.match(announceCpp, /scan_budget/, "and the real C++ must have the budget too");
  assert.match(announceH, /scan_budget/);
});

rule("a MESSAGE arrives whole: a page can never open on an orphan continuation line", () => {
  // DF wraps a long combat line into a lead + continuations. The old code matched ANY entry, so a
  // page boundary could land mid-sentence. This is the rest of TX14's "combat is especially bad".
  const wrapped = [
    { id: 1, continuation: false, typeKey: "COMBAT_DODGE", alertType: 34, text: "The goblin" },
    { id: 2, continuation: true, typeKey: "COMBAT_DODGE", alertType: 34, text: "strikes the dwarf" },
    { id: 3, continuation: true, typeKey: "COMBAT_DODGE", alertType: 34, text: "in the head!" },
    { id: 4, continuation: false, typeKey: "COMBAT_PARRY", alertType: 34, text: "It parries." },
  ];
  const page = serverPage(wrapped, { max: 1 });
  assert.equal(page.reports[0].id, 4, "max:1 must return the newest LEAD");
  assert.ok(!page.reports.some(r => r.continuation && r.id === 3),
    "and must NOT return a continuation whose lead it excluded");
  // With room for both, the lead drags its whole tail -- tails do not count against max.
  const both = serverPage(wrapped, { max: 2 });
  assert.deepEqual(both.reports.map(r => r.id), [1, 2, 3, 4], "the wrapped message arrives whole");
  const grouped = FORMAT.groupReports(both.reports);
  assert.equal(grouped.length, 2, "and the client stitches it back into TWO messages, not four");
  assert.equal(grouped[0].lineCount, 3);
  assert.match(grouped[0].text, /The goblin strikes the dwarf in the head!/);
});

// ---------------------------------------------------------------------------------------------
// 4. SECTION FILTERING (and that it reaches the real rendered panel).
// ---------------------------------------------------------------------------------------------
console.log("\n4. section filtering + the rendered screen");

const SECTIONS_WIRE = TAX.SECTIONS.map(s => ({ id: s.id, key: s.key, label: s.label }));
const R_SIEGE = { id: 702, typeKey: "AMBUSH_AMBUSHER", alertType: 5, section: "sieges",
                  text: "A vile force of darkness has arrived!", year: 253, time: 11700,
                  color: 4, bright: true, zoomType: 0, pos: { x: 151, y: 73, z: 162 },
                  box: false, alert: true, continuation: false };
const R_ARTIFACT = { id: 703, typeKey: "MADE_ARTIFACT", alertType: 19, section: "artifacts",
                     text: "Deler has created The Granite Standard!", year: 253, time: 12240,
                     color: 6, bright: true, zoomType: -1, pos: null, box: true, alert: false,
                     continuation: false };
const R_DEATH = { id: 704, typeKey: "CITIZEN_DEATH", alertType: 21, section: "deaths",
                  text: "Urist McMiner has bled to death.", year: 253, time: 13010, color: 4,
                  zoomType: 0, pos: { x: 109, y: 101, z: 155 }, box: false, alert: true,
                  continuation: false };
const LOG3 = [R_SIEGE, R_ARTIFACT, R_DEATH];
const STATE = { log: LOG3, section: "all", sections: SECTIONS_WIRE, total: 3, reachedOldest: true,
                counts: { misc: 0, combat: 0, sieges: 1, artifacts: 1, trade: 0, nobles: 0, deaths: 1 } };

rule("the CHIPS are the sections, with WHOLE-FORT counts (not 'how many happen to be loaded')", () => {
  const chips = ANN.repChips(SECTIONS_WIRE, "all", STATE.counts);
  for (const label of ["Combat", "Sieges & invasions", "Artifacts & masterworks",
                       "Trade & diplomacy", "Nobles & mandates", "Deaths", "Misc"])
    assert.ok(chips.includes(label) || chips.includes(label.replace(/&/g, "&amp;")),
      `a chip for ${label}`);
  assert.match(chips, /data-rep-filter="sieges"/, "and it filters by section KEY");
  assert.match(chips, /Sieges &amp; invasions 1|Sieges & invasions 1/, "carrying the fort-wide count");
  assert.match(chips, /rep-chip-empty/, "an empty section is dimmed, not hidden (the row must not jump)");
});

rule("B160 DELIVERED: the siege + artifact HIGHLIGHT strips render from REAL tokens", () => {
  const html = ANN.repSpecialSections(LOG3, "all");
  assert.ok(html.includes("Sieges") && html.includes("Artifacts"), "both strips render");
  assert.match(html, /A vile force of darkness/, "the siege row is in the siege strip");
  assert.match(html, /Granite Standard/, "the artifact row is in the artifact strip");
  assert.ok(!html.includes("bled to death"), "and the death is NOT (it is not one of the two strips)");
  // The seeded-bad: B160's own code. It filtered on typeKeys DF does not have.
}, () => {
  const b160 = (reports) => ["SIEGE", "ARTIFACT_CREATED"]
    .map(key => (reports || []).filter(r => r?.typeKey === key))
    .filter(rows => rows.length).map(rows => rows[0].text).join("");
  const html = b160(LOG3);
  assert.match(html, /A vile force of darkness/,
    "B160's dead filter must NOT find the siege -- that is the whole bug");
});

rule("a section filter shows only that section, and drops the highlight strips (no double-render)", () => {
  const html = ANN.reportsPanelMarkup(Object.assign({}, STATE, { section: "deaths", log: [R_DEATH] }));
  assert.match(html, /bled to death/);
  assert.ok(!html.includes("vile force"), "the siege is not in the Deaths section");
  assert.ok(!html.includes("alerts-section-title"),
    "and the highlight strips are suppressed -- a filtered view must not render a row twice");
  assert.match(html, /Deaths/, "the footer names the selected section");
});

rule("the row carries DF's OWN flags: what PAUSED the game, and what lit the ALERT button", () => {
  const html = ANN.repRowHtml(R_ARTIFACT);
  assert.match(html, /rep-badge-box/, "MADE_ARTIFACT carries BOX -- it stopped the game");
  assert.ok(!html.includes("rep-badge-alert"), "and it does not carry ALERT");
  const siege = ANN.repRowHtml(R_SIEGE);
  assert.match(siege, /rep-badge-alert/, "an ambush lights the alert button");
  assert.ok(!siege.includes("rep-badge-box"), "but does NOT box+pause -- there is no SIEGE BOX token");
});

rule("a row is dated to the DAY, not just the year (you cannot order a siege inside a year otherwise)", () => {
  assert.equal(ANN.repDate({ year: 253, time: 0 }), "Granite 1, 253");
  assert.equal(ANN.repDate({ year: 253, time: 33600 }), "Slate 1, 253");
  assert.equal(ANN.repDate({ year: 253, time: 11700 }), "Granite 10, 253");
  assert.equal(ANN.repDate({ year: 253 }), "Year 253", "a report with no tick still renders");
});

rule("the scrollbox is the SHARED DWFUI one -- which is what styles the scrollbar (TX14)", () => {
  const html = ANN.reportsPanelMarkup(STATE);
  assert.match(html, /class="dwfui-scroll info-body rep-list"/,
    "DWFUI.scrollHtml -> .dwfui-scroll is what paints the native scrollbar art");
  assert.match(annSrc, /DWFUI\.scrollHtml\(\{ cls: "info-body rep-list"/);
  assert.match(html, /dwfui-window/, "and the window is the shared shell");
});

rule("the BACKFILL control exists exactly when there IS an older page, and sits at the TOP", () => {
  const more = ANN.reportsPanelMarkup(Object.assign({}, STATE, { reachedOldest: false }));
  assert.match(more, /data-rep-older/, "an older page exists -> the control is there");
  // Inside the SCROLLBOX, above the scrollbox's own rows. (The highlight strips live outside it and
  // above it, so the check has to be scoped to the scroll region or it measures the wrong thing.)
  const scroll = more.slice(more.indexOf(`class="dwfui-scroll info-body rep-list"`));
  const olderAt = scroll.indexOf("data-rep-older");
  const firstRow = scroll.indexOf("data-rep-id");
  assert.ok(olderAt > 0, "the backfill control must be INSIDE the scrollbox");
  assert.ok(olderAt < firstRow,
    "and ABOVE the rows -- where the older rows will appear, so pressing it does not shove your place");
  const done = ANN.reportsPanelMarkup(STATE);
  assert.ok(!done.includes("data-rep-older"), "reached the beginning -> no control");
  assert.match(done, /Beginning of the log/);
});

// ---------------------------------------------------------------------------------------------
// 5. CENTER-ON-EVENT ONLY ON CLICK (B216).
// ---------------------------------------------------------------------------------------------
console.log("\n5. center-on-event fires ONLY on an explicit click (B216)");

rule("the ONLY camera affordance is the Center BUTTON -- the row itself is inert", () => {
  const html = ANN.reportsPanelMarkup(STATE);
  assert.match(html, /data-rep-center="702"/, "the siege has a location -> it gets a Center button");
  assert.ok(!html.includes('data-rep-center="703"'),
    "the artifact has NO location (zoomType -1) -> no Center button, per TX14");
  // The row must carry NO camera hook of its own: no onclick, no data-center, nothing but its id.
  const row = ANN.repRowHtml(R_SIEGE);
  const rowOpen = row.slice(0, row.indexOf(">") + 1);
  assert.ok(!/onclick|data-center|data-zoom|data-goto/i.test(rowOpen),
    "the ROW element must carry no camera affordance -- opening/clicking an entry must never move the camera");
});

rule("centerAndFlashMapPos is reachable from ONE place in this file, and it is the button handler", () => {
  const hits = [...annSrc.matchAll(/centerAndFlashMapPos\s*\(/g)];
  assert.equal(hits.length, 1, `the camera must be moved from exactly one place; found ${hits.length}`);
  // ...and that one place is inside the [data-rep-center] listener, not a row listener.
  const centerBlock = annSrc.slice(annSrc.indexOf("[data-rep-center]"));
  assert.ok(centerBlock.includes("centerAndFlashMapPos"),
    "the single call site must be the Center button's click handler");
  // No listener may be attached to the row.
  assert.ok(!/\[data-rep-id\][^\n]*addEventListener/.test(annSrc),
    "no click listener may be bound to a log row");
  assert.ok(!/querySelectorAll\("\[data-rep-id\]"\)/.test(annSrc),
    "the rows are not even collected for wiring -- there is nothing to accidentally hook up");
}, () => {
  // Seeded-bad: a row-level handler, the exact regression B216 was filed for.
  const bad = annSrc + `\nclientPanel.querySelectorAll("[data-rep-id]").forEach(r => r.addEventListener("click", () => centerAndFlashMapPos(x)));`;
  const hits = [...bad.matchAll(/centerAndFlashMapPos\s*\(/g)];
  assert.equal(hits.length, 1, "a second call site must be caught");
});

rule("a report DF says has NO location gets NO Center button (it cannot fabricate a camera move)", () => {
  const noPos = ANN.repRowHtml(R_ARTIFACT);
  assert.ok(!noPos.includes("data-rep-center"), "zoomType -1 => no button");
  assert.equal(FORMAT.zoomTarget(R_ARTIFACT), null);
  const yesPos = ANN.repRowHtml(R_DEATH);
  assert.match(yesPos, /data-rep-center="704"/);
});

// ---------------------------------------------------------------------------------------------
// 6. THE ALERT BUTTON OPENS THE NATIVE ALERT BOX (B232 REOPEN -- friend-review FAIL).
//
// The owner, on the live build: "we have this insane full screen alerts screen when you click the alerts
// button in browser but the native game only looks like this." The oracle
// (tools/orchestrator/attachments/B232-oracle-native.png) shows a MODEST MODAL BOX over the map:
//   - a bordered panel, dark interior
//   - the hint line "You can recenter on certain announcements.  Right click to close."
//     (TWO spaces between the sentences -- measured on the capture)
//   - the alert announcement lines themselves, in DF's own text colour (yellow)
//   - exactly TWO small icon buttons at the top-right: DF's own
//     ANNOUNCEMENT_OPEN_ALL_ANNOUNCEMENTS (open the full log) above RECENTER_RECENTER
//     (both cells verified against web/interface_map.json + the vanilla sheets)
//   - NOTHING ELSE. No title, no tabs, no total count, no "Active alerts" section, no per-row
//     buttons, no red Dismiss, no footer, no close X. Right click closes it.
//
// Round 1 built a full-screen dashboard nobody asked for and wired it to the ALERT button. These
// rules pin the native structure and MUST FAIL against the round-1 markup.
// ---------------------------------------------------------------------------------------------
console.log("\n6. the ALERT button opens the NATIVE ALERT BOX (reopen: oracle B232-oracle-native.png)");

const BOX_ALERT_TRADE = {
  type: 4, iconIndex: 9, dismissKey: "a:4", dismissKeys: ["a:4"], latestReportId: 12,
  reports: [{ id: 12, text: "The merchants need a trade depot to unload their goods.",
              typeKey: "MERCHANTS_NEED_DEPOT", alertType: 4, color: 6, bright: true, year: 253,
              time: 9000, repeatCount: 0, continuation: false,
              zoomType: 0, hasPos: true, pos: { x: 10, y: 20, z: 5 } }],
  unitReports: [],
};
const BOX_ALERT_NO_TARGET = {
  type: 11, iconIndex: 11, dismissKey: "a:11", dismissKeys: ["a:11"], latestReportId: 13,
  reports: [{ id: 13, text: "A diplomat could not complete a meeting and has left unhappy.",
              typeKey: "DIPLOMAT_UNHAPPY", alertType: 11, color: 6, bright: true, year: 253,
              time: 9500, repeatCount: 0, continuation: false,
              zoomType: -1, hasPos: false, pos: null }],
  unitReports: [],
};
const BOX_STATE = { alerts: [BOX_ALERT_TRADE, BOX_ALERT_NO_TARGET], recent: [], reportCount: 435 };
const NATIVE_HINT = "You can recenter on certain announcements.&nbsp; Right click to close.";

// The structural check, factored so the selftest can prove it REJECTS the round-1 dashboard.
function assertNativeAlertBoxShape(html) {
  assert.ok(html.includes(NATIVE_HINT),
    "the native hint line (with native's two-space sentence gap) must render");
  // negative space -- everything the round-1 dashboard invented must be ABSENT
  for (const [needle, why] of [
    ["data-announce-mode", "no Alerts/Reports tab row -- native has no tabs on this box"],
    ["total reports", "no report count -- native shows none"],
    ["Active alerts", "no 'Active alerts' section title"],
    ["Recent reports", "no 'Recent reports' feed"],
    ["dwfui-plaque", "no text plaques at all -- native has no Center/Dismiss buttons here"],
    ["data-alert-dismiss", "no per-row Dismiss"],
    ["data-alert-center", "no per-row Center"],
    ["data-report-center", "no per-report Center"],
    ["info-header", "no title bar"],
    ["info-footer", "no footer"],
    ["alerts-row", "no dashboard category rows"],
  ]) assert.ok(!html.includes(needle), `${why} (found "${needle}")`);
  // exactly the two native icon buttons, by DF's OWN tokens
  const sprites = [...html.matchAll(/data-dwfui-sprite="([A-Z0-9_]+)"/g)].map(m => m[1]);
  assert.deepEqual(sprites.sort(),
    ["ANNOUNCEMENT_OPEN_ALL_ANNOUNCEMENTS", "RECENTER_RECENTER"],
    "exactly two icon buttons: open-the-log + recenter, both DF's own cells");
}

rule("the invented dashboard is GONE and the native alert box is what renders", () => {
  assert.equal(typeof HUD.alertBoxMarkup, "function",
    "alertBoxMarkup must exist -- the ALERT button opens the native box now");
  assert.ok(!hudCode.includes("notificationsPanelMarkup"),
    "the round-1 full-screen dashboard markup must be deleted, not just unplugged");
  assert.match(hudCode, /alertBoxMarkup\(notificationState\)/,
    "the renderer must draw the BOX from the live notification state");
});

rule("ORACLE: the hint line is verbatim-native, two-space sentence gap included", () => {
  const html = HUD.alertBoxMarkup(BOX_STATE);
  assertNativeAlertBoxShape(html);
  assert.ok(html.includes(NATIVE_HINT), "hint line");
}, () => {
  // Seeded-bad: the round-1 dashboard's own shape (tabs + count + sections + Center/Dismiss
  // plaques + rows). The structural check must REJECT it outright.
  assertNativeAlertBoxShape(
    `<div class="dwfui-window"><div class="info-header">Announcements</div>` +
    `<div class="info-top-tabs announce-mode-tabs"><button data-announce-mode="alerts">Alerts</button></div>` +
    `<div class="alerts-head"><div class="info-muted">435 total reports</div></div>` +
    `<div class="alerts-section-title">Active alerts</div>` +
    `<div class="alerts-row"><button class="dwfui-plaque" data-alert-center="a:4">Center</button>` +
    `<button class="dwfui-plaque red" data-alert-dismiss="a:4">Dismiss</button></div>` +
    `<div class="alerts-section-title">Recent reports</div><div class="info-footer"></div></div>`);
});

rule("ORACLE: the alert lines render as plain text lines in DF's own colour (native yellow here)", () => {
  const html = HUD.alertBoxMarkup(BOX_STATE);
  assert.match(html, /The merchants need a trade depot to unload their goods\./,
    "the announcement text itself is the content of the box");
  const yellow = HUD.dfTextColor({ color: 6, bright: true });
  assert.ok(html.includes(yellow),
    `the merchants line is DF colour 6+bright -> ${yellow} (the oracle's yellow)`);
  // the lines are LINES, not dashboard rows: no icon cell, no grid row chassis
  assert.ok(!html.includes("alerts-icon"), "no per-line category icon -- native shows bare text");
});

rule("ORACLE: the box scrolls through the shared DWFUI scrollbox (native scrollbar art)", () => {
  const html = HUD.alertBoxMarkup(BOX_STATE);
  assert.match(html, /class="dwfui-scroll[^"]*alertbox-lines"/,
    "DWFUI.scrollHtml -> .dwfui-scroll paints the native scrollbar");
});

rule("RIGHT CLICK CLOSES the box (the hint line's own contract)", () => {
  const box = hudCode.slice(hudCode.indexOf("function renderAlertBox"));
  assert.ok(box.includes(`addEventListener("contextmenu"`),
    "the box must handle contextmenu");
  const ctx = box.slice(box.indexOf(`addEventListener("contextmenu"`));
  assert.ok(ctx.slice(0, 300).includes("closeClientPanel"),
    "and right click must CLOSE it, not open a browser menu");
});

rule("the LOG icon is the reports affordance: it opens the full announcements screen (census 76/M27)", () => {
  const box = hudCode.slice(hudCode.indexOf("function renderAlertBox"));
  const wire = box.slice(box.indexOf("[data-alertbox-log]"));
  assert.ok(box.includes("[data-alertbox-log]"), "the open-log button must be wired");
  assert.ok(wire.slice(0, 300).includes("openReportsPanel"),
    "and it must open the reports screen -- that is where the round-1 full log now lives");
});

rule("B216: the LINES are inert; the recenter ICON is the single explicit camera affordance", () => {
  const html = HUD.alertBoxMarkup(BOX_STATE);
  // every alert line's open tag carries no handler hook of any kind
  for (const m of html.matchAll(/<div class="alertbox-line[^>]*>/g))
    assert.ok(!/onclick|data-[a-z]/i.test(m[0]),
      `an alert line must carry no handler hook at all: ${m[0]}`);
  const box = hudCode.slice(hudCode.indexOf("function renderAlertBox"),
                            hudCode.indexOf("function openNotificationsPanel"));
  const hits = [...box.matchAll(/centerAndFlashMapPos\s*\(/g)];
  assert.equal(hits.length, 1,
    `the box wiring must move the camera from exactly ONE place (the recenter icon); found ${hits.length}`);
  const recenter = box.slice(box.indexOf("[data-alertbox-recenter]"));
  assert.ok(recenter.includes("centerAndFlashMapPos"),
    "and that one place is the recenter icon's click handler");
}, () => {
  // Seeded-bad: a line-level camera handler -- the exact B216 regression.
  const bad = hudCode + `\nclientPanel.querySelectorAll(".alertbox-line").forEach(l => l.addEventListener("click", () => centerAndFlashMapPos(t)));`;
  const box = bad.slice(bad.indexOf("function renderAlertBox"));
  const hits = [...box.matchAll(/centerAndFlashMapPos\s*\(/g)];
  assert.equal(hits.length, 1, "a second camera call site must be caught");
});

rule("the recenter icon is honest: enabled only when some alert actually has a map target", () => {
  const withTarget = HUD.alertBoxMarkup(BOX_STATE);
  const btn = withTarget.match(/<button[^>]*data-alertbox-recenter[^>]*>/);
  assert.ok(btn && !btn[0].includes("disabled"), "a targetable alert -> the icon is live");
  const without = HUD.alertBoxMarkup({ alerts: [BOX_ALERT_NO_TARGET], recent: [], reportCount: 1 });
  const btn2 = without.match(/<button[^>]*data-alertbox-recenter[^>]*>/);
  assert.ok(btn2 && btn2[0].includes("disabled"),
    "no alert has a target -> the icon is disabled, never a fabricated camera move");
});

rule("the UN-MERGE is complete: no Alerts/Reports tab row survives anywhere", () => {
  assert.ok(!hudCode.includes("announceModeTabs"), "the tab builder must be gone from the HUD file");
  assert.ok(!annCode.includes("announceModeTabs"), "and from the reports screen");
  assert.ok(!hudCode.includes("data-announce-mode") && !annCode.includes("data-announce-mode"),
    "no announce-mode dataset is emitted or wired anywhere");
  // the reports screen itself SURVIVES (census 76/M27) -- only its tab row is gone
  assert.match(annCode, /function openReportsPanel/, "the full-log screen still exists");
});

// ---------------------------------------------------------------------------------------------
console.log("");
if (failed) {
  console.log(`B232 announce screen: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`B232 announce screen: ${passed} passed, 0 failed${SELFTEST ? " (selftest: every seeded-bad rejected)" : ""}`);
