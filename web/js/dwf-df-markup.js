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

// DF rich-text markup parser (the [C:fg:bg:bright] color-escape grammar), ported from DFHack's
// Gui::MTB_parse. Do NOT invent tokens or colors here: DF's parser is the whole specification.
(function (root) {
  "use strict";

  // DF's curses index for a parsed word = fg + (bright ? 8 : 0). bg is carried separately, never folded in.
  const DEFAULT_FG = 7, DEFAULT_BG = 0, DEFAULT_BRIGHT = false;

  // grabToken(source, pos, compc): capture until compc (':' unless noted), ']', or end of input.
  function grabToken(source, pos, compc) {
    let out = "";
    for (let s = pos; s < source.length; s++) {
      const ch = source[s];
      if (ch === compc || ch === "]") break;
      out += ch;
    }
    return out;
  }

  // Returns { spans }: visible runs { text, fg, bg, bright, index, link }, plus { br } / { blank } /
  // { indent } / { key }. Unknown bracket tokens are consumed and produce no output, exactly as DF does.
  function parse(input) {
    const spans = [];
    const text = String(input == null ? "" : input);
    const n = text.length;

    // An empty string yields a single NEW_LINE word.
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

  // ---- html(): the shared prose renderer for any verbatim native string. ----
  // Colour resolves through DWFUI.dfColor, the live palette and never a literal; with no dfColor the text stays uncoloured.
  function html(input) {
    const UI = (typeof window !== "undefined" && window.DWFUI)
      || (typeof globalThis !== "undefined" && globalThis.DWFUI)
      || (typeof require === "function" ? require("./dwf-ui-components.js") : null);
    const dfColor = UI && typeof UI.dfColor === "function" ? UI.dfColor : null;
    return parse(input).spans.map(span => {
      if (span.br) return "<br>";
      if (span.blank) return "<br><br>";
      if (span.indent) return "&nbsp;&nbsp;&nbsp;&nbsp;";
      // A [KEY:n] label needs DF's live binding table, which the client does not have. DF prints
      // the bound key here; printing a guess would be worse than printing nothing.
      if (span.key) return "";
      const idx = Number(span.index);
      const style = dfColor && Number.isInteger(idx) && idx >= 0 && idx <= 15
        ? ` style="color:${dfColor(idx)}"` : "";
      return `<span${style}>${UI.esc(span.text || "")}</span>`;
    }).join("");
  }

  // ---- bitmapHtml(): the same prose in the player's own CP437 glyphs. ----
  // The colour rides on the wrapper span, because paintNow reads getComputedStyle(node).color off the label.
  const RESET_TOKEN = "[C:7:0:0]";
  const RESET_INDEX = 7;   // DEFAULT_FG + (DEFAULT_BRIGHT ? 8 : 0)

  function bitmapHtml(input, opts) {
    const o = opts || {};
    const UI = (typeof window !== "undefined" && window.DWFUI)
      || (typeof globalThis !== "undefined" && globalThis.DWFUI) || null;
    if (!UI || typeof UI.bitmapTextHtml !== "function") return html(input);
    const dfColor = typeof UI.dfColor === "function" ? UI.dfColor : null;
    return parse(input).spans.map(span => {
      if (span.br) return "<br>";
      if (span.blank) return "<br><br>";
      if (span.indent) return "&nbsp;&nbsp;&nbsp;&nbsp;";
      if (span.key) return "";                       // needs DF's live binding table; see html()
      const text = span.text || "";
      if (!text) return "";
      const idx = Number(span.index);
      const style = dfColor && Number.isInteger(idx) && idx >= 0 && idx <= 15
        ? ` style="color:${dfColor(idx)}"` : "";
      // The colour sits on the WRAPPER and the bitmap label inherits it, which is what paintNow reads back.
      return `<span class="dwfui-markup-run"${style}>` +
        UI.bitmapTextHtml(text, { scale: o.scale, eager: o.eager }) + `</span>`;
    }).join("");
  }

  const api = { parse, spansToText, html, bitmapHtml, RESET_TOKEN, RESET_INDEX,
    DEFAULT_FG, DEFAULT_BG };
  root.DwfDfMarkup = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
