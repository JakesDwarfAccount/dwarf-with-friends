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

// DF rich-text markup parser (the [C:fg:bg:bright] color-escape grammar).
//
// This is a faithful port of DFHack's Gui::MTB_parse -- itself reverse-engineered from DF's own
// markup_text_boxst::process_string_to_lines (v50 win64) -- from the plugin's build tree at
// <DFHACK_ROOT>, library/modules/Gui.cpp:2286-2569 and grab_token_string_pos in
// library/MiscUtils.cpp:434. The grammar is FROZEN by that citation. Do NOT invent tokens or
// colors here: DF's parser is the whole specification. Spec:
// docs/superpowers/specs/2026-07-14-native-text-color-spec.md §2.2, §5.
//
// It exists because several DF surfaces (thoughts, personality, health, needs, legends/help/hover)
// ship their text with [C:] color tokens embedded (spec §5, live-verified: raw sheet strings carry
// e.g. "[C:7:0:0]She was [C:6:0:0]uneasy [C:7:0:0]after ..."). Whenever the plugin forwards one of
// those raw strings, this parser recovers the native per-word color DF itself assigned -- never a
// guessed word list.
//
// ONE DELIBERATE DIVERGENCE FROM MTB_parse, and it changes no color: DF splits body text into one
// word entry PER whitespace-delimited word (each carries the same color). We instead COALESCE runs
// of text that share a color into a single span, preserving the original spacing. Color only ever
// changes at a [C:] token, so every character still receives EXACTLY the index DF's per-word split
// would give it; coalescing only affects how many spans a uniform-color run becomes, which is what
// makes the output convenient to render as HTML. spansToText() reconstructs the visible string.
(function (root) {
  "use strict";

  // DF's curses index for a parsed word = fg + (bright ? 8 : 0). bg is carried separately (it is
  // NOT folded into the index -- DF stores screenb on its own). Initial state is DF's:
  // fg = White (7), bg = Black (0), bright = false  (Gui.cpp:2321).
  const DEFAULT_FG = 7, DEFAULT_BG = 0, DEFAULT_BRIGHT = false;

  // grab_token_string_pos(source, pos, compc): capture until compc (':' unless noted), ']', or end.
  // Verbatim behavior of MiscUtils.cpp:434.
  function grabToken(source, pos, compc) {
    let out = "";
    for (let s = pos; s < source.length; s++) {
      const ch = source[s];
      if (ch === compc || ch === "]") break;
      out += ch;
    }
    return out;
  }

  // Parse a DF markup string into color-attributed spans.
  //
  // Returns { spans: [...] } where each span is one of:
  //   { text, fg, bg, bright, index, link }   -- a run of visible text; `index` = fg + bright*8;
  //                                              `link` (or null) = { type, id, subid } inside LPAGE
  //   { br: true }        -- [R]  hard newline
  //   { blank: true }     -- [B]  blank line
  //   { indent: true }    -- [P]  paragraph indent
  //   { key: true, keyId, index: 10 }  -- [KEY:n] keybinding token (always bright green = index 10).
  //                                       text is not resolved client-side (needs DF's key table);
  //                                       our sheet surfaces do not use it. Present for completeness.
  //
  // Unknown/unimplemented bracket tokens ([C:VAR:...], [VAR:...], and any unrecognized [X]) are
  // consumed and produce no output -- exactly as MTB_parse does.
  function parse(input) {
    const spans = [];
    const text = String(input == null ? "" : input);
    const n = text.length;

    // MTB_parse: an empty string yields a single NEW_LINE word (Gui.cpp:2310-2316).
    if (n === 0) return { spans: [{ br: true }] };

    // Current color state.
    let fg = DEFAULT_FG, bg = DEFAULT_BG, bright = DEFAULT_BRIGHT;
    let linkIndex = -1;
    const links = [];          // link_index -> {type,id,subid}
    let run = "";              // accumulating text at the current color

    function curIndex() { return fg + (bright ? 8 : 0); }
    function flushRun() {
      if (!run) return;
      spans.push({
        text: run,
        fg, bg, bright,
        index: curIndex(),
        link: linkIndex >= 0 ? links[linkIndex] : null,
      });
      run = "";
    }

    let i = 0;
    let guard = 0;
    while (i < n) {
      if (++guard > n * 4 + 16) break;   // defensive: the source's lone-']' path can spin; never hang.

      let useChar = true;
      let charToken = null;      // an explicit literal char (from [CHAR:...])
      let noSplitSpace = false;  // (kept for fidelity; spacing is preserved by coalescing anyway)

      const c = text[i];

      if (c === "]") {
        // "]]" -> literal ']'. A lone ']' is skipped (DF re-checks it and effectively drops it).
        if (i + 1 >= n) break;
        if (text[i + 1] !== "]") { i++; continue; }
        // fall through with useChar=true; the char appended below is the second ']' at i+1
        i++;
      } else if (c === "[") {
        if (i + 1 >= n) break;
        i++;
        const nx = text[i];
        if (nx === "." || nx === ":" || nx === "?" || nx === " " || nx === "!") {
          noSplitSpace = true; // useChar stays true; the char at i is appended below
        } else if (nx !== "[") {
          useChar = false;
          const token = grabToken(text, i, ":");
          i += token.length;

          if (token === "CHAR") {
            if (++i >= n) break;                 // skip ':'
            const buff = grabToken(text, i, ":");
            i += buff.length;
            // "~c" -> literal c; otherwise a CP437 code point.
            charToken = (buff.length > 1 && buff[0] === "~")
              ? buff[1]
              : String.fromCharCode(parseInt(buff, 10) || 0);
            noSplitSpace = true;
            useChar = true;
          } else if (token === "LPAGE") {
            if (++i >= n) break;                 // skip ':'
            const buffType = grabToken(text, i, ":");
            i += buffType.length;
            if (++i >= n) break;                 // skip ':'
            const buffId = grabToken(text, i, ":");
            i += buffId.length;
            const TYPES = { HF: "HIST_FIG", SITE: "SITE", ARTIFACT: "ARTIFACT", BOOK: "BOOK",
              SR: "SUBREGION", FL: "FEATURE_LAYER", ENT: "ENTITY", AB: "ABSTRACT_BUILDING",
              EPOP: "ENTITY_POPULATION", ART_IMAGE: "ART_IMAGE", ERA: "ERA", HEC: "HEC" };
            const linkType = TYPES[buffType] || "NONE";
            let id = parseInt(buffId, 10) || 0;
            let subid = -1;
            if (linkType === "ABSTRACT_BUILDING" || linkType === "ART_IMAGE") {
              if (++i >= n) break;               // skip ':'
              const buffSub = grabToken(text, i, ":");
              i += buffSub.length;
              subid = parseInt(buffSub, 10) || 0;
            }
            if (linkType !== "NONE") {
              flushRun();
              links.push({ type: linkType, id, subid });
              linkIndex = links.length - 1;
            }
          } else if (token === "/LPAGE") {
            flushRun();
            linkIndex = -1;
          } else if (token === "C") {
            flushRun();
            if (++i >= n) break;                 // skip ':'
            const b1 = grabToken(text, i, ":"); i += b1.length;
            if (++i >= n) break;                 // skip ':'
            const b2 = grabToken(text, i, ":"); i += b2.length;
            if (++i >= n) break;                 // skip ':'
            const b3 = grabToken(text, i, ":"); i += b3.length;
            if (b1 === "VAR") {
              // dipscript color var -- unimplemented in DF's own parser too. State unchanged.
            } else {
              fg = parseInt(b1, 10) || 0;
              bg = parseInt(b2, 10) || 0;
              bright = !!(parseInt(b3, 10) || 0);
            }
          } else if (token === "KEY") {
            flushRun();
            if (++i >= n) break;                 // skip ':'
            const buff = grabToken(text, i, ":");
            i += buff.length;
            spans.push({ key: true, keyId: parseInt(buff, 10) || 0, index: 10 }); // bright green
          } else if (token === "VAR") {
            // dipscript variable -- unimplemented in DF's own parser. Consume its three fields.
            for (let f = 0; f < 3; f++) {
              if (++i >= n) { i = n; break; }    // skip ':'
              const b = grabToken(text, i, ":");
              i += b.length;
            }
          } else if (token === "R" || token === "B" || token === "P") {
            flushRun();
            if (token === "R") spans.push({ br: true });
            else if (token === "B") spans.push({ blank: true });
            else spans.push({ indent: true });
          }
          // else: unknown token -> consumed, no output (MTB_parse falls through).
        }
        // else "[[" -> useChar stays true; the char appended below is the second '[' at i
      }

      if (useChar) {
        const ch = charToken == null ? text[i] : charToken;
        // DF splits words on spaces; we keep the space in the run (see header note). noSplitSpace
        // is honored implicitly because we never split anyway.
        void noSplitSpace;
        run += ch;
      }

      i++;
    }

    flushRun();
    return { spans };
  }

  // Visible text of a parse result (spaces preserved; control spans render as newlines/space).
  function spansToText(parsed) {
    const spans = (parsed && parsed.spans) || [];
    let out = "";
    for (const s of spans) {
      if (s.br) out += "\n";
      else if (s.blank) out += "\n\n";
      else if (s.indent) out += "";
      else if (s.key) out += "";
      else if (typeof s.text === "string") out += s.text;
    }
    return out;
  }

  const api = { parse, spansToText, DEFAULT_FG, DEFAULT_BG };
  root.DwfDfMarkup = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
