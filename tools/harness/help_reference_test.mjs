// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// B207 HELP-TOOLTIPS fixture suite. OFFLINE: no DF, no server, no browser.
//
// Verifies the ? help reference end-to-end from source:
//   - EXTRACTOR ROUND-TRIP: a fresh harvest of the source tree deep-equals the committed baked
//     corpus (web/js/dwf-help-corpus.js). This is the anti-drift cell in BOTH directions --
//     a tooltip that exists in source but not the reference (or vice versa) makes them differ and
//     fails the build. A test-the-test seeded mutation proves the comparison actually rejects a
//     mismatch.
//   - HARVEST COVERAGE: each structured source (toolbar tooltips, tool-mode labels, DF guides,
//     the keymap) and a representative static title literal all land in the corpus.
//   - PANEL RENDER: renders every surface as its own section; the hotkey section stays intact;
//     search filters; curated notes render and never orphan.
//
//   node tools/harness/help_reference_test.mjs
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { extractCorpus, resolveTemplate, hasStaticWords } from "./help_corpus_extractor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);

const committed = require(join(root, "web/js/dwf-help-corpus.js"));
const curated = require(join(root, "web/js/dwf-help-curated.js"));
const panel = require(join(root, "web/js/dwf-help-panel.js"));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
}
const surfaceById = (corpus, id) => corpus.surfaces.find(s => s.id === id);
const entryTexts = surf => surf.entries.map(e => e.text || e.title);

// ---- extractor round-trip (drift guard, both directions) -------------------------------------

check("round-trip: fresh extract deep-equals the committed baked corpus", () => {
  const fresh = extractCorpus(root);
  assert.deepEqual(fresh, committed,
    "web/js/dwf-help-corpus.js is stale -- run `node tools/harness/help_corpus_extractor.mjs`");
});

check("test-the-test: an entry present in source-but-not-reference (or vice versa) is detected", () => {
  const fresh = extractCorpus(root);
  // Simulate a source tooltip missing from the reference: add one to the fresh (source) side only.
  const mutated = JSON.parse(JSON.stringify(fresh));
  mutated.surfaces[0].entries.push({ control: "", text: "__seeded_drift__", hotkey: "" });
  assert.notDeepEqual(mutated, committed, "round-trip compare failed to notice an added tooltip");
  // And the reverse: a reference entry with no source counterpart.
  const mutated2 = JSON.parse(JSON.stringify(committed));
  mutated2.surfaces[0].entries.push({ control: "", text: "__ghost_reference__", hotkey: "" });
  assert.notDeepEqual(mutated2, fresh, "round-trip compare failed to notice a ghost reference entry");
});

// ---- harvest coverage ------------------------------------------------------------------------

check("harvest: the three structured surfaces (hotkeys, tools, guides) are present and non-empty", () => {
  for (const id of ["hotkeys", "tools", "guides"]) {
    const s = surfaceById(committed, id);
    assert.ok(s, `missing surface ${id}`);
    assert.ok(s.entries.length > 0, `surface ${id} is empty`);
  }
});

check("harvest: a known TOOLBAR_TOOLTIPS entry (itemdesig, hotkey i) is in the tools surface", () => {
  const tools = surfaceById(committed, "tools");
  const e = tools.entries.find(x => x.control === "itemdesig");
  assert.ok(e, "itemdesig tool tip not harvested");
  assert.equal(e.hotkey, "i");
  assert.match(e.text, /dumping and melting/i);
});

check("harvest: DF's Burrows guide is harvested with its multi-paragraph body", () => {
  const guides = surfaceById(committed, "guides");
  const g = guides.entries.find(x => x.title === "Burrows");
  assert.ok(g, "Burrows guide not harvested");
  assert.ok(Array.isArray(g.body) && g.body.length >= 3, "guide body not captured");
  assert.match(g.body.join(" "), /work and living areas/i);
  assert.equal(g.body.join(" ").includes("{{"), false, "guide keyword braces should be stripped");
});

check("harvest: a static index.html title literal (the 3D world viewer button) lands in topbar", () => {
  const topbar = surfaceById(committed, "topbar");
  assert.ok(topbar, "topbar surface missing");
  assert.ok(entryTexts(topbar).some(t => /3D world viewer/i.test(t)), "index.html title not harvested");
});

check("harvest: a multiline 'Hotkey: k' title splits text from the hotkey badge", () => {
  const topbar = surfaceById(committed, "topbar");
  const stocks = topbar.entries.find(e => /Stock levels/i.test(e.text));
  assert.ok(stocks, "Stocks tooltip not harvested");
  assert.equal(stocks.hotkey, "k", "Hotkey line not split off");
  assert.equal(stocks.text.includes("Hotkey"), false, "Hotkey line leaked into the body text");
});

check("harvest: templated `${...}` titles are NOT harvested (they are runtime data, not a reference)", () => {
  for (const s of committed.surfaces)
    for (const e of s.entries)
      assert.equal(String(e.text || e.title || "").includes("${"), false, `templated leak: ${e.text}`);
});

// ---- panel render ----------------------------------------------------------------------------

check("render: every surface becomes its own <section> with its label heading", () => {
  const html = panel.render(committed, curated, "");
  for (const s of committed.surfaces) {
    assert.ok(html.includes('data-surface="' + s.id + '"'), `no section for ${s.id}`);
    assert.ok(html.includes(">" + s.label.replace(/&/g, "&amp;")) || html.includes(s.label.split(" ")[0]),
      `label missing for ${s.id}`);
  }
});

check("render: the hotkey section is intact -- a known key row renders with its key badge", () => {
  const html = panel.render(committed, curated, "");
  const hk = surfaceById(committed, "hotkeys");
  const spacePause = hk.entries.find(e => /pause/i.test(e.text));
  assert.ok(spacePause, "no pause row in the keymap");
  assert.ok(html.includes("help-ref-key"), "hotkey key badges not rendered");
  assert.ok(html.includes(">Space<") || html.includes(spacePause.control), "the Space/Pause row is missing");
});

check("render: a guide renders as prose (h4 title + paragraphs), not a flat row", () => {
  const html = panel.render(committed, curated, "");
  assert.ok(html.includes("help-guide"), "guide block class missing");
  assert.ok(/<h4>Burrows<\/h4>/.test(html), "Burrows guide title not rendered as a heading");
});

check("render: uses the shared DWFUI row/header/search structure (dwfui-* classes present)", () => {
  const html = panel.render(committed, curated, "");
  for (const cls of ["dwfui-row", "dwfui-copy", "dwfui-label", "dwfui-scroll", "dwfui-search"])
    assert.ok(html.includes(cls), `expected DWFUI class ${cls} in the rendered panel`);
});

// ---- search ----------------------------------------------------------------------------------

check("search: a query filters the body down to matching entries only", () => {
  const all = panel.renderBody(committed, curated, "");
  const some = panel.renderBody(committed, curated, "burrow");
  assert.ok(some.count > 0, "expected some matches for 'burrow'");
  assert.ok(some.count < all.count, "search did not reduce the entry count");
  assert.ok(some.html.toLowerCase().includes("burrow"), "matches don't contain the query");
});

check("search: a query matching nothing yields the empty-state, zero entries", () => {
  const none = panel.renderBody(committed, curated, "zzxqq-no-such-tooltip");
  assert.equal(none.count, 0);
  assert.ok(none.html.includes("help-ref-empty"), "no empty-state shown");
});

check("search: entryMatches searches text, control, hotkey, group, and body", () => {
  assert.equal(panel.entryMatches({ text: "Justice." }, "", "justice"), true);
  assert.equal(panel.entryMatches({ control: "itemdesig", text: "x" }, "", "itemdesig"), true);
  assert.equal(panel.entryMatches({ text: "x", hotkey: "k" }, "", "k"), true);
  assert.equal(panel.entryMatches({ text: "x", group: "Camera" }, "", "camera"), true);
  assert.equal(panel.entryMatches({ title: "G", body: ["kidnapped citizens"] }, "", "kidnapped"), true);
  assert.equal(panel.entryMatches({ text: "Dig" }, "", "zzz"), false);       // test-the-test
});

// ---- curated supplements ---------------------------------------------------------------------

check("curated: a note renders as a dim sub-line under its harvested tooltip", () => {
  const html = panel.render(committed, curated, "");
  // "Justice." is terse in source; the curated note supplements it.
  assert.ok(html.includes("help-ref-note"), "curated note class not rendered");
  assert.ok(html.includes("Review crime reports"), "the Justice curated note is missing");
});

check("curated: every curated note key matches a REAL harvested tooltip (no orphans)", () => {
  const orphans = [];
  for (const [surfaceId, notes] of Object.entries(curated.notes)) {
    const surf = surfaceById(committed, surfaceId);
    for (const text of Object.keys(notes)) {
      const ok = surf && surf.entries.some(e => e.text === text);
      if (!ok) orphans.push(`${surfaceId} :: ${text}`);
    }
  }
  assert.deepEqual(orphans, [], "curated notes point at tooltips that no longer exist: " + orphans.join(", "));
});

check("curated test-the-test: a fabricated curated key is detected as an orphan", () => {
  const fake = { notes: { tools: { "__not_a_real_tooltip__": "x" } } };
  const surf = surfaceById(committed, "tools");
  const isOrphan = !surf.entries.some(e => e.text === "__not_a_real_tooltip__");
  assert.equal(isOrphan, true, "orphan detection would have missed a fabricated curated key");
});

check("curated: notes never REPLACE harvested text (headline stays the source string)", () => {
  const tools = surfaceById(committed, "tools");
  const justice = tools.entries.find(e => e.text === "Justice.");
  assert.ok(justice, "Justice tool tip should still be harvested verbatim");
  assert.equal(justice.text, "Justice.", "curated must not fork the harvested truth");
});

// ---- WAVE-5 GATE C: no hand-built controls, no raw-text bypass ----------------------------------
// This panel is a BROWSER-ONLY SUPERSET -- "a list of ALL of the tooltips in the game". It has
// no native analog, so it is judged against the FOUNDATION rather than an oracle.

check("the panel header is DWFUI-built: bitmap title + the native close SPRITE", () => {
  const html = panel.render(committed, curated, "");
  assert.match(html, /class="dwfui-head/, "header must come from DWFUI.headerHtml");
  assert.match(html, /dwfui-bitmap-text/, "the title must be bitmap text, not a raw <h2> string");
  assert.match(html, /data-help-close/, "the close wire must survive");
  assert.equal(/&times;/.test(html), false, "a raw multiplication-sign close glyph survived");
});

check("hotkey badges are bitmap text (the key is a label, not a raw DOM string)", () => {
  const html = panel.render(committed, curated, "");
  const badge = (html.match(/<span class="help-ref-key">.*?<\/span><\/span>/) || [""])[0];
  assert.match(badge, /dwfui-bitmap-text/, "help-ref-key still emits a raw browser-font string");
});

check("the dependency-free hand-rolled fallbacks are gone (drift R2: one copy of DWFUI's markup)", () => {
  const src = readFileSync(new URL("../../web/js/dwf-help-panel.js", import.meta.url), "utf8");
  assert.equal(/Dependency-free fallback/.test(src), false, "a hand-rolled DWFUI duplicate survived");
  assert.equal(/<button/.test(src), false, "a hand-built control survived in the help panel");
});

// ---- B247: template-literal titles -----------------------------------------------------------
// Controls whose tooltip is built with a template literal used to be skipped outright, so they had
// NO entry in the reference at all. They are now resolved: static text (including both arms of a
// ternary) is inlined, runtime values become named slots, and a tip with no fixed words is dropped
// rather than baked as garbage.

check("B247 resolve: a ternary between two strings shows BOTH states", () => {
  assert.equal(resolveTemplate('${seed.forbidden ? "Claim" : "Forbid"} seed stack'),
               "Claim/Forbid seed stack");
  assert.equal(resolveTemplate('${on ? "on" : "off"}'), "on/off");
});

check("B247 resolve: runtime values become NAMED slots, numbers become [N]", () => {
  assert.equal(resolveTemplate("Center the view on ${relation.name}"), "Center the view on [name]");
  assert.equal(resolveTemplate("Remove point ${index + 1}"), "Remove point [N]");
  assert.equal(resolveTemplate("Bookkeeper precision ${n}"), "Bookkeeper precision [N]");
  assert.equal(resolveTemplate("Back to ${activeCategoryLabel()}"), "Back to [active category label]");
  // Cosmetic wrappers still name the slot rather than collapsing to the anonymous one.
  assert.equal(resolveTemplate("Add a ${String(label).toLowerCase()} requirement"),
               "Add a [label] requirement");
});

check("B247 resolve: an emptied parenthetical never ships as \"( assigned)\"", () => {
  const tip = resolveTemplate(
    'Assign squads to this barracks (${squadCount === 1 ? "1 squad assigned" : `${squadCount} squads assigned`})');
  assert.equal(tip, "Assign squads to this barracks (1 squad assigned/[N] squads assigned)");
  assert.equal(/\(\s*\)/.test(tip), false, "an empty parenthetical survived");
});

check("B247 drop: a tip that is 100% runtime data has no static words and is skipped", () => {
  assert.equal(hasStaticWords("[action] [name]"), false);
  assert.equal(hasStaticWords("[name] cannot be [verb]."), true);
  const texts = committed.surfaces.flatMap(s => s.entries.map(e => e.text || e.title || ""));
  for (const t of texts)
    assert.ok(hasStaticWords(t), `a wordless slot-only tip was baked into the reference: ${JSON.stringify(t)}`);
});

check("B247 harvest: the barracks + unit-recenter template tooltips are now IN the reference", () => {
  const texts = committed.surfaces.flatMap(s => s.entries.map(e => e.text || e.title || ""));
  // B251: the blue-flag tip now serves BOTH squad-assignable zone types (df::squad_selector_context_type
  // has exactly two contexts), so the harvested template names both. The B247 intent is unchanged --
  // the tip must still reach the player's help with its WORDS intact, not collapsed into a slot.
  assert.ok(texts.some(t => /^Assign squads to this archery range\/barracks/.test(t)),
    "the squad-assign tip is missing (or its zone names collapsed into a runtime slot)");
  assert.ok(texts.some(t => /\bbarracks\b/.test(t) && /^Assign squads/.test(t)), "barracks tip still missing");
  assert.ok(texts.some(t => t === "Center the view on [name]"), "unit recenter tip still missing");
  assert.ok(texts.some(t => t === "Claim/Forbid seed stack"), "seed-stack toggle tip still missing");
});

check("B247 guard: a `title:` quoted inside a CODE COMMENT is never harvested as a tooltip", () => {
  // The repo's own comments say things like: scanning source for `title:` followed by a literal.
  // That is a literal backtick-title-colon and matched the naive pattern, baking C-comment prose
  // into the player's help. No entry may contain comment syntax or source-file names.
  const texts = committed.surfaces.flatMap(s => s.entries.map(e => e.text || e.title || ""));
  for (const t of texts) {
    assert.equal(/\/\/|\/\*/.test(t), false, `comment prose leaked into the corpus: ${JSON.stringify(t)}`);
    assert.equal(/help_corpus_extractor|\.mjs\b/.test(t), false, `a source path leaked in: ${JSON.stringify(t)}`);
  }
});

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
