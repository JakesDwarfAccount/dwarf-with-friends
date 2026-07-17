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

// Text-color: the [C:fg:bg:bright] markup parser gate. The parser is a port of DFHack's
// Gui::MTB_parse (itself reverse-engineered from DF's own process_string_to_lines). This gate
// asserts the parser against the EXACT raw strings the LIVE game emitted in the text-color spec's
// probe sessions (docs/superpowers/specs/2026-07-14-native-text-color-spec.md §5) -- i.e. screen
// truth, not a source string we invented -- and cross-checks the recovered emotion color index
// against DF's binary-extracted df::emotion_type::color attr (df.d_basics.xml).
//
//   node tools/harness/df_markup_test.mjs             # gate
//   node tools/harness/df_markup_test.mjs --selftest  # prove each rule rejects a seeded-bad parse
//
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);
const { parse, spansToText } = require(join(root, "web/js/dwf-df-markup.js"));

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("  ok - " + label); }
  catch (e) { failed++; console.log("  FAIL - " + label + "\n      " + (e && e.message)); }
}

// Only text spans, as {text, index} -- drops control/link spans for readable assertions.
function textSpans(str) {
  return parse(str).spans.filter(s => typeof s.text === "string").map(s => ({ text: s.text, index: s.index }));
}

// ---- Live-probe: thoughts (spec §5, unit 1792, thoughts tab) ---------------------------------
check("thoughts raw string -> exact per-run color (uneasy = brown 6)", () => {
  const raw = "[C:7:0:0]She was [C:6:0:0]uneasy [C:7:0:0]after being unable to pray to Anan Stardreams for too long.";
  assert.deepEqual(textSpans(raw), [
    { text: "She was ", index: 7 },
    { text: "uneasy ", index: 6 },
    { text: "after being unable to pray to Anan Stardreams for too long.", index: 7 },
  ]);
  // The visible text is reconstructed byte-for-byte (spacing preserved).
  assert.equal(spansToText(parse(raw)), "She was uneasy after being unable to pray to Anan Stardreams for too long.");
});

// Cross-check the recovered index against DF's own emotion attr table for the emotions the spec
// says were colored 6 in the live game (UNEASINESS/ANNOYANCE/GROUCHINESS color=6, df.d_basics.xml).
check("recovered emotion index equals df::emotion_type::color for the probed words", () => {
  for (const word of ["uneasy", "annoyed", "grouchy"]) {
    const raw = `[C:7:0:0]She was [C:6:0:0]${word} [C:7:0:0]after.`;
    const emoSpan = parse(raw).spans.find(s => s.text && s.text.startsWith(word));
    assert.equal(emoSpan.index, 6, `${word} should be curses index 6 (brown), DF's UNEASINESS/ANNOYANCE/GROUCHINESS color`);
  }
});

// ---- Live-probe: personality (spec §5, second session) ---------------------------------------
check("personality valence clauses: good = green 2, bad = red 4", () => {
  const raw = "[C:2:0:0]She has a natural inclination toward language[C:4:0:0], but she has very bad intuition.";
  assert.deepEqual(textSpans(raw), [
    { text: "She has a natural inclination toward language", index: 2 },
    { text: ", but she has very bad intuition.", index: 4 },
  ]);
});

check("personality trait paragraph: [P] indent then bright white ([C:7:0:1] = index 15)", () => {
  const { spans } = parse("[P][C:7:0:1]She has a great deal of willpower.");
  assert.equal(spans[0].indent, true);
  const t = spans.find(s => typeof s.text === "string");
  assert.equal(t.index, 15);          // 7 + bright*8
  assert.equal(t.bright, true);
  assert.equal(t.bg, 0);
});

check("token-free string -> single default-white run (parser default index 7)", () => {
  // spec §5: quirk lines are token-free -> parser default white.
  assert.deepEqual(textSpans("She has a fear of imprisonment."), [
    { text: "She has a fear of imprisonment.", index: 7 },
  ]);
});

// ---- Live-probe: health + needs (spec §2.7, §5) ----------------------------------------------
check("health raw string: [C:7:0:0]No health problems -> index 7", () => {
  assert.deepEqual(textSpans("[C:7:0:0]No health problems"), [{ text: "No health problems", index: 7 }]);
});

check("needs bands: satisfied = bright green ([C:2:0:1] = index 10)", () => {
  // spec §5 cross-check #4: "satisfied" = [C:2:0:1] = 10, matching the SATISFACTION attr.
  assert.deepEqual(textSpans("[C:2:0:1]satisfied"), [{ text: "satisfied", index: 10 }]);
  // distracted = 6+bright = 14 (spec §2.7).
  assert.deepEqual(textSpans("[C:6:0:1]distracted"), [{ text: "distracted", index: 14 }]);
});

// ---- Grammar edge cases frozen by Gui.cpp ----------------------------------------------------
check("[R]/[B]/[P] emit control spans; color state persists across them", () => {
  const { spans } = parse("[C:4:0:0]line one[R]line two[B][C:2:0:0]line three");
  assert.equal(spans[0].text, "line one"); assert.equal(spans[0].index, 4);
  assert.equal(spans[1].br, true);
  assert.equal(spans[2].text, "line two"); assert.equal(spans[2].index, 4); // color persisted
  assert.equal(spans[3].blank, true);
  assert.equal(spans[4].text, "line three"); assert.equal(spans[4].index, 2);
});

check("escaped brackets: [[ -> literal '[', ]] -> literal ']'", () => {
  assert.equal(spansToText(parse("a [[b]] c")), "a [b] c");
});

check("initial color state is White (index 7) before any [C:]", () => {
  assert.equal(textSpans("plain")[0].index, 7);
});

check("[C:VAR:...] (dipscript) is ignored -> color unchanged", () => {
  // VAR color is unimplemented in DF's parser; state must not move.
  assert.deepEqual(textSpans("[C:3:0:0]cyan[C:VAR:x:y]still cyan"), [
    { text: "cyan", index: 3 }, { text: "still cyan", index: 3 },
  ]);
});

check("unknown bracket token is consumed, produces no output", () => {
  assert.equal(spansToText(parse("a[BOGUS]b")), "ab");
});

check("KEY token -> a bright-green (index 10) key span, no crash", () => {
  const key = parse("press [KEY:5] now").spans.find(s => s.key);
  assert.equal(key.index, 10);
});

check("empty string -> a single newline control span (matches MTB_parse empty path)", () => {
  const { spans } = parse("");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].br, true);
});

// ---- Self-test: prove the assertions reject a seeded-bad result -------------------------------
if (process.argv.includes("--selftest")) {
  check("selftest: a mis-parse (wrong index) is caught", () => {
    assert.throws(() => {
      const spans = textSpans("[C:6:0:0]uneasy");
      assert.equal(spans[0].index, 7); // WRONG on purpose (it is 6)
    });
  });
  check("selftest: dropping color state across [R] would be caught", () => {
    assert.throws(() => {
      const { spans } = parse("[C:4:0:0]a[R]b");
      assert.equal(spans[2].index, 7); // WRONG: color persists, so it is 4
    });
  });
}

console.log(`\n${failed ? "FAIL" : "PASS"} df_markup_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
