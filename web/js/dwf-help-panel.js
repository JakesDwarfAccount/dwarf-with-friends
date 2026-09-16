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

// dwf-help-panel.js -- the ? help panel: the whole harvested tooltip corpus, browsable and
// searchable in one place.

(function (root) {
  "use strict";

  var DWFUI = root.DWFUI || (typeof module === "object" && module.require
    ? module.require("./dwf-ui-components.js") : null);

  // ---- corpus helpers (pure) -----------------------------------------------------------------

  // The curated note for a harvested entry, matched EXACTLY on {surface, text}. "" when none.
  function curatedNote(curated, surfaceId, text) {
    var notes = curated && curated.notes && curated.notes[surfaceId];
    return (notes && Object.prototype.hasOwnProperty.call(notes, text)) ? notes[text] : "";
  }

  // Searches tooltip text, control name, hotkey, group, guide body and any curated note, so a player can
  // find a tooltip by any word they remember. An empty query matches everything.
  function entryMatches(entry, note, q) {
    if (!q) return true;
    var hay = [
      entry.text, entry.title, entry.control, entry.hotkey, entry.group, note,
      Array.isArray(entry.body) ? entry.body.join(" ") : "",
    ].join(" ").toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  // ---- render (pure) -------------------------------------------------------------------------

  // A hotkey badge is a SHORT native-style token ("Ctrl+Z") -> bitmap text, like every other label.
  function keyBadge(control) {
    return '<span class="help-ref-key">' + DWFUI.bitmapTextHtml(String(control == null ? "" : control)) + "</span>";
  }

  // A DECLARED bypass: bitmap text is a single-run label, so multi-paragraph guide copy pushed through
  // it would produce one unwrappable run per paragraph. rawHtml() refuses to emit without a reason.
  function guideHtml(entry) {
    var paras = (entry.body || []).map(function (p) { return "<p>" + DWFUI.esc(p) + "</p>"; }).join("");
    return DWFUI.rawHtml(
      "first-open guide text is flowing multi-paragraph prose (h4 + wrapped <p> copy), not a label run",
      '<div class="help-guide"><h4>' + DWFUI.esc(entry.title) + "</h4>" + paras + "</div>");
  }

  function entryRowHtml(surface, entry, note) {
    if (surface.kind === "guides") return guideHtml(entry);

    var isHotkey = surface.kind === "hotkeys";
    // Hotkeys: the control IS the key -> render it as a badge; the text is the description.
    var icon = isHotkey ? keyBadge(entry.control) : "";
    var trailing = (!isHotkey && entry.hotkey)
      ? '<span class="help-ref-hotkey">' + DWFUI.esc(entry.hotkey) + "</span>" : "";
    var sub = note ? { text: note, cls: "help-ref-note" } : null;
    var label = isHotkey ? entry.text : (entry.text || entry.control);
    return DWFUI.rowHtml({
      cls: "help-ref-row" + (isHotkey ? " hk" : ""),
      icon: icon, label: label, sub: sub, trailing: trailing,
    });
  }

  // Group hotkey entries by their `group` (Camera/System/...) so the section keeps DF's own
  // sub-grouping; other surfaces render as a flat list.
  function sectionInnerHtml(surface, curated, q) {
    if (surface.kind === "hotkeys") {
      var groups = [];
      var byGroup = {};
      surface.entries.forEach(function (e) {
        var note = "";
        if (!entryMatches(e, note, q)) return;
        var g = e.group || "";
        if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
        byGroup[g].push(e);
      });
      if (!groups.length) return "";
      return groups.map(function (g) {
        var rows = byGroup[g].map(function (e) { return entryRowHtml(surface, e, ""); }).join("");
        return (g ? '<div class="help-ref-group">' + DWFUI.esc(g) + "</div>" : "") + rows;
      }).join("");
    }
    var out = surface.entries.map(function (e) {
      var note = curatedNote(curated, surface.id, e.text);
      if (!entryMatches(e, note, q)) return "";
      return entryRowHtml(surface, e, note);
    }).join("");
    return out;
  }

  // Full reference body: one <section> per surface, empty sections dropped (so search collapses
  // the page to only matching surfaces). Returns { html, count } so the caller can show a tally.
  function renderBody(corpus, curated, query) {
    var q = String(query || "").trim().toLowerCase();
    var count = 0;
    var sections = (corpus && corpus.surfaces || []).map(function (surface) {
      var inner = sectionInnerHtml(surface, curated, q);
      if (!inner) return "";
      // count visible entries for the tally
      surface.entries.forEach(function (e) {
        if (entryMatches(e, curatedNote(curated, surface.id, e.text), q)) count++;
      });
      return '<section class="help-ref-section" data-surface="' + DWFUI.esc(surface.id) + '">' +
        "<h3>" + DWFUI.esc(surface.label) + "</h3>" + inner + "</section>";
    }).join("");
    if (!sections) sections = '<div class="help-ref-empty">No tooltips match &ldquo;' + DWFUI.esc(query) + "&rdquo;.</div>";
    return { html: sections, count: count };
  }

  // The panel shell keeps its ARIA dialog role by hand: windowHtml stamps `.info-window`, whose
  // height:100% and gold inset frame would stretch this panel and draw a second border over `.hotkey-panel`.
  function render(corpus, curated, query) {
    var body = renderBody(corpus, curated, query);
    var header = DWFUI.headerHtml({
      cls: "hotkey-head help-ref-head",
      titleTag: "h2", title: "Help — all tooltips",
      tools: '<span class="help-ref-count">' + body.count + " entries</span>",
      close: { cls: "hotkey-close", data: "help-close", title: "Close" },
    });
    var search = DWFUI.searchHtml({ cls: "help-ref-search", inputCls: "help-ref-search-input", magnifier: true,
      dataAttr: "help-search", value: query || "", placeholder: "Search every tooltip, guide, and shortcut…" });
    var scrollInner = '<div class="help-ref-scroll-inner" data-help-body>' + body.html + "</div>";
    var scroll = DWFUI.scrollHtml({ cls: "help-ref-body" }, scrollInner);
    return '<div class="hotkey-panel help-ref-panel" role="dialog" aria-label="Help reference">' +
      header + search + scroll +
      '<div class="hotkey-foot help-ref-foot">Every tooltip the game shows lives here. ' +
      "Press <b>Shift+H</b> for the compact hotkey card, or <b>Esc</b> to close.</div></div>";
  }

  // ---- browser glue --------------------------------------------------------------------------

  var overlayEl = null;
  var open = false;

  function corpus() { return root.DFHelpCorpus || (typeof module !== "undefined" && { surfaces: [] }); }
  function curated() { return root.DFHelpCurated || { notes: {} }; }

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    if (typeof document === "undefined") return null;
    overlayEl = document.getElementById("helpReference");
    if (!overlayEl) {
      overlayEl = document.createElement("div");
      overlayEl.id = "helpReference";
      document.body.appendChild(overlayEl);
    }
    // Backdrop click closes -- bound ONCE on the persistent container (paint() replaces innerHTML,
    // so per-render bindings on children die with their nodes, but this one must not accumulate).
    overlayEl.addEventListener("pointerdown", function (ev) { if (ev.target === overlayEl) close(); });
    return overlayEl;
  }

  function paint(query) {
    var el = ensureOverlay();
    if (!el) return;
    el.innerHTML = render(corpus(), curated(), query || "");
    el.querySelector("[data-help-close]") &&
      el.querySelector("[data-help-close]").addEventListener("click", close);
    var input = el.querySelector("[data-help-search]");
    if (input) {
      input.addEventListener("input", function () { repaintBody(input.value); });
    }
  }

  // Re-render only the scrolling body + the count on each keystroke, so the search input keeps
  // focus and caret position (the caret-restore idiom the info shells use).
  function repaintBody(query) {
    var el = ensureOverlay();
    if (!el) return;
    var body = renderBody(corpus(), curated(), query || "");
    var host = el.querySelector("[data-help-body]");
    if (host) host.innerHTML = body.html;
    var count = el.querySelector(".help-ref-count");
    if (count) count.textContent = body.count + " entries";
  }

  function openPanel() {
    var el = ensureOverlay();
    if (!el) return;
    paint("");
    el.classList.add("open");
    open = true;
    var input = el.querySelector("[data-help-search]");
    if (input) tryFocus(input, false);
  }
  function tryFocus(target, preventScroll) {
    try {
      if (preventScroll) target.focus({ preventScroll: true });
      else target.focus();
      return true;
    }
    catch { return false; }
  }
  function close() {
    if (overlayEl) overlayEl.classList.remove("open");
    open = false;
    var view = document.getElementById("view");
    if (view) tryFocus(view, true);
  }
  function toggle() { if (open) close(); else openPanel(); }
  function isOpen() { return open; }

  if (typeof document !== "undefined") {
    try { root.DwfModeStack && root.DwfModeStack.register({
      id: "help-reference", flow: "global-overlays", depth: 60,
      active: isOpen,
      pop: function () { close(); return true; },
    }); } catch (err) { DwfErr.report("mode-stack.register", err); }
    // #helpBtn and the ?/F1 keys are wired in dwf-controls-placement.js; this module must NOT also bind
    // #helpBtn, or the button double-toggles.
  }

  root.DFHelpPanel = { render: render, renderBody: renderBody, open: openPanel, close: close, toggle: toggle, isOpen: isOpen };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { render: render, renderBody: renderBody, entryMatches: entryMatches, curatedNote: curatedNote };
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
