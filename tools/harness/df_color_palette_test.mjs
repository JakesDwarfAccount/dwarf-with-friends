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

// Text-color: the native color PIPELINE gate. Exercises the REAL production code paths (not source
// strings): DWFUI.dfColor / applyPalette, the notifications module's dfTextColor, and the actual
// rendered markup for thoughts (emotion span color) and skills (profession color). Spec:
// docs/superpowers/specs/2026-07-14-native-text-color-spec.md §2.1/§2.5/§3.1/§3.2/§3.4.
//
//   node tools/harness/df_color_palette_test.mjs             # gate
//   node tools/harness/df_color_palette_test.mjs --selftest  # seeded-bad rejection
//
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("  ok - " + label); }
  catch (e) { failed++; console.log("  FAIL - " + label + "\n      " + (e && e.message)); }
}

// ---- minimal DOM double so applyPalette has a :root to write, and modules load --------------
const rootStyle = {
  _p: new Map(),
  setProperty(k, v) { this._p.set(k, v); },
  getPropertyValue(k) { return this._p.get(k) || ""; },
};
globalThis.document = {
  documentElement: { style: rootStyle },
  querySelectorAll: () => [],
  getElementById: () => null,
};
globalThis.window = { setTimeout, addEventListener() {} };
globalThis.fetch = async () => ({ ok: false });
globalThis.unitImagesEnabled = true;

const DWFUI = (await import("../../web/js/dwf-ui-components.js")).default;
globalThis.DWFUI = DWFUI;
globalThis.window.DWFUI = DWFUI;
const DwfDfMarkup = require("../../web/js/dwf-df-markup.js");
globalThis.DwfDfMarkup = DwfDfMarkup;
globalThis.window.DwfDfMarkup = DwfDfMarkup;
const M = await import("../../web/js/dwf-unit-hud-notifications.js");

// ---- dfColor: index -> live-var-with-default -------------------------------------------------
check("dfColor(i) returns var(--df-cI, <default df16 hex>) for 0..15", () => {
  const df16 = DWFUI.TOKENS.palette.df16;
  for (let i = 0; i < 16; i++) {
    assert.equal(DWFUI.dfColor(i), `var(--df-c${i}, ${df16[i]})`);
  }
});

check("dfColor out-of-range -> light-gray default, never an invented color", () => {
  assert.equal(DWFUI.dfColor(-1), DWFUI.TOKENS.palette.df16[7]);
  assert.equal(DWFUI.dfColor(99), DWFUI.TOKENS.palette.df16[7]);
  assert.equal(DWFUI.dfColor("x"), DWFUI.TOKENS.palette.df16[7]);
});

check("df16 is the 16-color curses-order table (index 0 black .. 15 white)", () => {
  const df16 = DWFUI.TOKENS.palette.df16;
  assert.equal(df16.length, 16);
  assert.equal(df16[0], "#000000");
  assert.equal(df16[6], "#aa5500");   // brown (UNEASINESS color)
  assert.equal(df16[10], "#55ff55");  // bright green (SATISFACTION color)
  assert.equal(df16[15], "#ffffff");
});

// ---- applyPalette: publishes gps->uccolor onto :root as --df-cN -------------------------------
check("applyPalette sets --df-c0..15 from a [[r,g,b]x16] payload", () => {
  const pal = Array.from({ length: 16 }, (_, i) => [i, i * 2, i * 3]);
  assert.equal(DWFUI.applyPalette(pal), true);
  assert.equal(rootStyle.getPropertyValue("--df-c0"), "rgb(0,0,0)");
  assert.equal(rootStyle.getPropertyValue("--df-c6"), "rgb(6,12,18)");
  assert.equal(rootStyle.getPropertyValue("--df-c15"), "rgb(15,30,45)");
});

check("applyPalette clamps bytes and ignores malformed/empty palettes", () => {
  assert.equal(DWFUI.applyPalette([[300, -5, 128]]), true);
  assert.equal(rootStyle.getPropertyValue("--df-c0"), "rgb(255,0,128)");
  assert.equal(DWFUI.applyPalette([]), false);      // empty ("[]" from a headless plugin)
  assert.equal(DWFUI.applyPalette(null), false);
});

// ---- dfTextColor: report {color,bright} -> curses index via dfColor --------------------------
check("dfTextColor routes report color+bright through dfColor(fg + bright*8)", () => {
  assert.equal(M.dfTextColor({ color: 6, bright: false }), DWFUI.dfColor(6));   // brown
  assert.equal(M.dfTextColor({ color: 6, bright: true }), DWFUI.dfColor(14));   // yellow
  assert.equal(M.dfTextColor({ color: 7, bright: true }), DWFUI.dfColor(15));   // white
  assert.equal(M.dfTextColor({ color: 2, bright: true }), DWFUI.dfColor(10));   // bright green
});

// ---- REAL render: emotion span carries native color index (spec §3.4) ------------------------
check("thoughts render applies span.color via inline dfColor style", () => {
  const unit = { thoughts: { recent: [{
    category: "recent", order: 0,
    spans: [
      { text: "She feels ", role: "neutral" },
      { text: "satisfaction", role: "emotion-positive", color: 10 }, // SATISFACTION attr
      { text: ".", role: "neutral" },
    ],
  }] } };
  const html = M.renderUnitTabBody(unit, "Thoughts", "Recent");
  // The emotion word must be wrapped with the native color; a role-only span must NOT be.
  assert.match(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(10))}"[^>]*>satisfaction`));
  assert.doesNotMatch(html, new RegExp(`style="color:[^"]*">She feels`));
});

// ---- REAL render: skill row colored by native profession color (spec §2.5) -------------------
check("skills render applies skill.color (profession color) to the caption", () => {
  const unit = { skills: [
    { id: 0, category: "Labor", caption: "Miner", ratingCaption: "Competent", rating: 3, color: 7, colorRole: "attention", order: 0 },
  ] };
  const html = M.renderUnitTabBody(unit, "Skills", "Labor");
  assert.match(html, new RegExp(`class="unit-skill-caption" style="color:${escapeRe(DWFUI.dfColor(7))}"`));
});

check("skills render with NO native color -> no invented inline color (old DLL)", () => {
  const unit = { skills: [
    { id: 0, category: "Labor", caption: "Miner", ratingCaption: "Competent", rating: 3, colorRole: "attention", order: 0 },
  ] };
  const html = M.renderUnitTabBody(unit, "Skills", "Labor");
  assert.doesNotMatch(html, /unit-skill-caption" style="color:/);
});

// ---- REAL render: unit identity and relation names carry profession color --------------------
check("unit-sheet identity name applies unit.professionColor through dfColor", () => {
  const html = M.unitSheetMarkup({ unit: { id: 1, name: "Domas", profession: "Planter",
    professionColor: 9 } }, { tab: "Overview" });
  assert.match(html, new RegExp(`unit-name-line" style="color:${escapeRe(DWFUI.dfColor(9))}"`));
});

check("overview uses structured skill, relation, and thought native colors", () => {
  const html = M.unitSheetMarkup({ unit: {
    id: 1, name: "Domas", professionColor: 9,
    relations: [{ name: "Lor", label: "Spouse", professionColor: 6, order: 0 }],
    skills: [{ caption: "Planter", ratingCaption: "Skilled", color: 2, order: 0 }],
    thoughts: { recent: [{ order: 0, spans: [
      { text: "felt ", role: "neutral" },
      { text: "satisfied", role: "emotion-positive", color: 10 },
    ] }] },
  } }, { tab: "Overview" });
  assert.match(html, new RegExp(`>Lor</span>`));
  assert.match(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(6))}">Lor`));
  assert.match(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(2))}">Skilled Planter`));
  assert.match(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(10))}">satisfied`));
});

check("living relation name applies relation.professionColor through dfColor", () => {
  const html = M.renderUnitRelations({ relations: [{ name: "Lor", profession: "Bone Carver",
    professionColor: 6, colorRole: "family", order: 0 }] });
  assert.match(html, new RegExp(`unit-relation-name[^\"]*" style="color:${escapeRe(DWFUI.dfColor(6))}"`));
});

check("dead relation does not incorrectly reuse profession color or legacy role hue", () => {
  const html = M.renderUnitRelations({ relations: [{ name: "Urist", profession: "Miner",
    professionColor: 7, colorRole: "family", dead: true, order: 0 }] });
  assert.match(html, /unit-relation-name[^\"]*" style="color:inherit"/);
  assert.doesNotMatch(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(7))}"`));
});

// ---- REAL render: forwarded DF [C:] strings use the shared parser + live palette -------------
check("health raw [C:] markup reaches rendered spans through DwfDfMarkup + dfColor", () => {
  const html = M.renderUnitTabBody({ healthStatusLines: [
    "[C:7:0:0]She is [C:6:0:0]uneasy[C:7:0:0].",
  ] }, "Health", "Status");
  assert.match(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(6))}">uneasy`));
  assert.doesNotMatch(html, /\[C:/);
});

check("structured prose without a native index neutralizes legacy role hues", () => {
  const html = M.renderUnitTabBody({ personalityNarrative: { values: [{ spans: [
    { text: "values art", role: "personal-positive" },
  ] }] } }, "Personality", "Values");
  assert.match(html, /unit-prose-personal-positive" style="color:inherit">values art/);
});

check("plain health, personality, status, and need strings receive no guessed hue", () => {
  const health = M.renderUnitTabBody({ healthStatusLines: ["Weak and slow to heal"] }, "Health", "Status");
  assert.doesNotMatch(health, /\b(?:condition|positive)\b/);
  const overview = M.unitSheetMarkup({ unit: {
    id: 1, name: "Domas", statusWords: ["Thirsty"],
    overviewTraitLines: ["Strong and friendly"], overviewNeedLines: ["Unmet need: Pray"],
  } }, { tab: "Overview" });
  assert.doesNotMatch(overview, /unit-cell status|unit-cell-line condition|class="(?:healthy|condition)"/);
  assert.match(overview, /unit-need-line" style="color:inherit"/);
});

// ---- REAL render: needs band word carries its native curses color (spec §2.7, §5) -----------
// The band color is derived server-side from personality_needst.focus_level and stamped on the
// band span, shared by BOTH the top-level `needs` payload and personalityNarrative.needs.
check("personality Needs tab paints the native band color on the band word", () => {
  const html = M.renderUnitTabBody({ personalityNarrative: { needs: [
    { spans: [
      { text: "She is ", role: "neutral" },
      { text: "distracted", role: "attention", color: 14 },   // yellow (6 + bright), spec §2.7
      { text: " after being unable to pray.", role: "neutral" },
    ] },
  ] } }, "Personality", "Needs");
  assert.match(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(14))}">distracted`));
  assert.doesNotMatch(html, new RegExp(`style="color:[^"]*">She is`));
});

check("personality Needs: an unpinned band (no color index) is left uncolored, not guessed", () => {
  const html = M.renderUnitTabBody({ personalityNarrative: { needs: [
    { spans: [
      { text: "She is ", role: "neutral" },
      { text: "badly distracted", role: "negative" },   // unpinned band -> server ships no color
      { text: " after being unable to pray.", role: "neutral" },
    ] },
  ] } }, "Personality", "Needs");
  assert.match(html, /unit-prose-negative" style="color:inherit">badly distracted/);
});

// ---- REAL render: Overview NEEDS cell colors from the structured `needs` (Overview parity) -----
// Failing-first: before this wave the Overview needs cell rendered `overviewNeedLines` (plain
// strings, always color:inherit); the same payload now routes through the structured `needs`
// records, so the band word carries its native index and colors identically to the full tab.
check("overview needs cell paints the native band color from structured needs", () => {
  const html = M.unitSheetMarkup({ unit: {
    id: 1, name: "Domas",
    overviewNeedLines: ["Unmet need: Pray"],   // the old plain fallback, still present
    needs: [{ type: "PrayOrMeditate", focus: -1500, satisfactionBand: "unfocused", order: 0, spans: [
      { text: "She is ", role: "neutral" },
      { text: "unfocused", role: "warning", color: 6 },   // native brown (spec §2.7)
      { text: " after being unable to pray.", role: "neutral" },
    ] }],
  } }, { tab: "Overview" });
  assert.match(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(6))}">unfocused`));
});

check("overview needs falls back to plain color:inherit lines for a pre-color DLL (no `needs`)", () => {
  const html = M.unitSheetMarkup({ unit: {
    id: 1, name: "Domas", overviewNeedLines: ["Unmet need: Pray"],
  } }, { tab: "Overview" });
  assert.match(html, /unit-need-line" style="color:inherit"/);
  assert.doesNotMatch(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(6))}"`));
});

// ---- REAL render: personality Traits valence colors (aptitude green/red, facets bright white) --
check("personality Traits: aptitude valence renders green (strength) and red (weakness)", () => {
  const html = M.renderUnitTabBody({ personalityNarrative: { traits: [
    { spans: [
      { text: "She ", role: "neutral", color: 2 },
      { text: "has a natural analytical ability", role: "positive", color: 2 },   // green, spec §5
      { text: ".", role: "neutral", color: 2 },
      { text: " ", role: "neutral" },
      { text: "She ", role: "neutral", color: 4 },
      { text: "has very little willpower", role: "negative", color: 4 },           // red, spec §5
      { text: ".", role: "neutral", color: 4 },
    ] },
  ] } }, "Personality", "Traits");
  assert.match(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(2))}">has a natural analytical ability`));
  assert.match(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(4))}">has very little willpower`));
});

check("personality Traits: facet paragraph renders native bright white (15)", () => {
  const html = M.renderUnitTabBody({ personalityNarrative: { traits: [
    { spans: [
      { text: "She ", role: "neutral", color: 15 },
      { text: "is remarkably brave", role: "neutral", color: 15 },   // [C:7:0:1] -> 15, spec §5
      { text: ".", role: "neutral", color: 15 },
    ] },
  ] } }, "Personality", "Traits");
  assert.match(html, new RegExp(`style="color:${escapeRe(DWFUI.dfColor(15))}">is remarkably brave`));
});

// ---- the deleted word-list colorizers must be GONE from source --------------------------------
check("EMOTION_POS/NEG/NEU word sets and level-keyed skill colorizer are deleted", () => {
  const src = readFileSync(new URL("../../web/js/dwf-unit-hud-notifications.js", import.meta.url), "utf8");
  // The CODE constructs must be gone (the deletion note may still name them in prose).
  for (const dead of ["const EMOTION_POS", "const EMOTION_NEG", "const EMOTION_NEU",
                       "const SKILL_LEVELS", "function colorizeEmotionLine", "function colorizeSkillLine"]) {
    assert.equal(src.includes(dead), false, `\`${dead}\` must be gone`);
  }
});

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

if (process.argv.includes("--selftest")) {
  check("selftest: a wrong dfColor mapping would be caught", () => {
    assert.throws(() => assert.equal(DWFUI.dfColor(6), DWFUI.dfColor(7)));
  });
}

console.log(`\n${failed ? "FAIL" : "PASS"} df_color_palette_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
