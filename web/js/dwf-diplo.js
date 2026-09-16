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

// dwf-diplo.js -- consumer for the server's {"type":"diplo"} broadcast: the petitions/diplomacy
// attention plaques and the diplomacy meeting mirror.
(function () {
  "use strict";

  var HAS_DWFUI = typeof DWFUI !== "undefined";
  if (HAS_DWFUI && typeof DWFUI.require === "function")
    DWFUI.require("diplo", ["modalHtml", "plaqueBtnHtml", "lightPlaqueHtml", "rowHtml", "scrollHtml", "tabsHtml"]);

  // Frames are seq-ordered: a stale or duplicate seq is ignored, so an out-of-order resync can never
  // resurrect a cleared plaque or a closed meeting.
  function applyDiploFrame(state, msg) {
    state = state || { seq: -1, petitionsPending: 0, meetingsQueued: 0, open: false, meeting: null };
    if (!msg || msg.type !== "diplo" || !Number.isFinite(Number(msg.seq)))
      return { changed: false, state: state };
    var seq = Number(msg.seq);
    if (seq <= state.seq)
      return { changed: false, state: state };
    return { changed: true, state: {
      seq: seq,
      petitionsPending: Math.max(0, Number(msg.petitionsPending) || 0),
      meetingsQueued: Math.max(0, Number(msg.meetingsQueued) || 0),
      open: msg.open === true,
      meeting: (msg.meeting && typeof msg.meeting === "object") ? msg.meeting : null,
    } };
  }

  // markup_text_wordst flags: NEW_LINE starts a line, BLANK_LINE precedes one, INDENT is a paragraph
  // indent. A word's colour is whitelisted to #rrggbb before it may touch a style attribute.
  function wordLines(words) {
    var lines = [];
    var line = [];
    var flush = function () { lines.push(line); line = []; };
    (Array.isArray(words) ? words : []).forEach(function (w) {
      if (!w || typeof w.t !== "string") return;
      if (w.blank) { if (line.length) flush(); lines.push([]); }
      else if (w.nl && line.length) flush();
      var seg = { t: w.t };
      if (typeof w.c === "string" && /^#[0-9a-f]{6}$/i.test(w.c)) seg.c = w.c.toLowerCase();
      if (w.ind && !line.length) seg.ind = 1;
      line.push(seg);
    });
    if (line.length) flush();
    return lines;
  }

  function wordLinesHtml(words) {
    var lines = wordLines(words);
    if (!lines.length)
      return '<div class="diplomacy-line diplomacy-line-empty">(no dialogue text)</div>';
    return lines.map(function (segs) {
      if (!segs.length) return '<div class="diplomacy-line diplomacy-line-blank">&nbsp;</div>';
      var body = segs.map(function (seg, i) {
        var text = DWFUI.esc(seg.t) + (i < segs.length - 1 ? " " : "");
        return seg.c ? '<span class="diplomacy-word-color" data-diplo-color="' +
          DWFUI.esc(seg.c) + '">' + text + "</span>" : text;
      }).join("");
      return '<div class="diplomacy-line' + (segs[0].ind ? " diplomacy-line-indent" : "") + '">' +
        body + "</div>";
    }).join("");
  }

  // ---- meeting screen markup (pure; exported for the harness) -----------------------------------
  function meetingBodyHtml(state) {
    if (!state.open || !state.meeting) {
      // The browser cannot open native's dialog, so say the meeting is queued rather than pretending.
      return '<div class="diplomacy-line">A diplomat is ready to meet' +
        (state.meetingsQueued > 1 ? " (" + state.meetingsQueued + " meetings queued)" : "") +
        '.</div><div class="diplomacy-line diplomacy-note">The meeting dialog opens on the host PC;' +
        " it will mirror here the moment it is open.</div>";
    }
    var m = state.meeting;
    var parts = [wordLinesHtml(m.words)];
    if (m.mode === "landHolder" && m.landHolder) {
      var lh = m.landHolder;
      parts.push('<div class="diplomacy-section">' +
        '<div class="diplomacy-line">Position offered: ' +
        DWFUI.esc((Array.isArray(lh.positions) ? lh.positions : []).join(", ") || "(unknown)") + "</div>" +
        (Array.isArray(lh.candidates) ? lh.candidates : []).map(function (c) {
          return DWFUI.rowHtml({ cls: "diplomacy-candidate", label: c && c.name || "Unknown",
            dataset: { diploCandidate: c && c.hfid != null ? c.hfid : -1 } });
        }).join("") +
        '<div class="diplomacy-line diplomacy-note">Choosing the holder is made at the host PC in' +
        " this version.</div></div>");
    }
    if (m.mode === "requests" && m.requests) {
      var tabs = Array.isArray(m.requests.tabs) ? m.requests.tabs : [];
      var requestTabs = tabs.map(function (tab) {
        var prio = (tab && Array.isArray(tab.priorities)) ? tab.priorities : [];
        var requested = prio.filter(function (v) { return Number(v) > 0; }).length;
        return { key: tab && tab.cat != null ? tab.cat : -1,
          label: (tab && tab.name || "?") + " - " + prio.length + " goods, " + requested + " requested" };
      });
      parts.push('<div class="diplomacy-section">' + DWFUI.tabsHtml({
        cls: "diplomacy-reqtab", level: "subtab", dataAttr: "diplo-reqtab",
        active: m.requests.selectedTab, tabs: requestTabs, ariaLabel: "Export request category",
      }) +
        '<div class="diplomacy-line diplomacy-note">Export-agreement details are edited at the host' +
        " PC in this version (the browser mirrors the counts live).</div></div>");
    }
    return parts.join("");
  }

  function meetingModalMarkup(state) {
    var m = state.meeting;
    var header = m && (m.actor || m.target)
      ? "Diplomacy - " + [m.actor, m.target].filter(Boolean).join(" & ")
      : "Diplomacy";
    var body = DWFUI.scrollHtml({ cls: "diplomacy-text", ariaLabel: "Meeting dialogue" },
      meetingBodyHtml(state));
    // The Okay advance is HOST-NATIVE in v1 (wire: advanceHostNative). Disabled placeholder,
    // per the placeholder doctrine: the title says exactly what evidence is missing.
    var okay = state.open ? DWFUI.plaqueBtnHtml({
      label: "Okay", tone: "grey", cls: "diplomacy-okay", disabled: true,
      dataset: { diploOkay: "" },
      title: "Advancing the meeting from the browser is not wired yet - the native Okay " +
        "transition still needs a live struct-diff capture. Advance it at the host PC.",
    }) : "";
    var footer = okay + DWFUI.plaqueBtnHtml({
      label: "Close", tone: "red", cls: "diplomacy-close",
      dataset: { diploClose: "" },
      title: "Close this mirror (the native meeting stays open on the host)",
    });
    return DWFUI.modalHtml({
      prompt: header,
      cls: "diplomacy-screen",
      ariaLabel: "Diplomacy meeting",
      dataset: { diploOpen: state.open ? "1" : "0" },
      footerHtml: footer,
    }, body);
  }

  // ---- plaque stack markup (pure; exported for the harness) --------------------------------------
  function plaqueStackMarkup(state) {
    var out = [];
    if (state.open || state.meetingsQueued > 0)
      out.push(DWFUI.lightPlaqueHtml({
        token: "DIPLOMACY_LIGHT", label: "DIPLOMACY", cls: "df-plaque-diplomacy",
        dataset: { diploPlaque: "diplomacy" },
        title: state.open ? "A diplomacy meeting is underway - view it"
                          : "A diplomat is ready to meet",
        ariaLabel: "Diplomacy",
      }));
    if (state.petitionsPending > 0)
      out.push(DWFUI.lightPlaqueHtml({
        token: "PETITIONS_LIGHT", label: "PETITIONS", cls: "df-plaque-petitions",
        dataset: { diploPlaque: "petitions" },
        title: state.petitionsPending + " petition" + (state.petitionsPending === 1 ? "" : "s") +
          " awaiting a decision",
        ariaLabel: "Petitions",
      }));
    return out.join("");
  }

  // ---- live state ---------------------------------------------------------------------------------
  var state = { seq: -1, petitionsPending: 0, meetingsQueued: 0, open: false, meeting: null };
  var mirrorOpen = false;   // the user opened (or auto-followed) the meeting mirror
  var plaquesEl = null;
  var mirrorEl = null;

  function swallow(el) {
    // nothing that happens inside may reach the map input handlers.
    ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "pointerdown", "pointerup",
     "wheel", "touchstart", "touchend"].forEach(function (type) {
      el.addEventListener(type, function (event) { event.stopPropagation(); },
        { passive: type === "wheel" || type === "touchstart" || type === "touchend" });
    });
  }

  function plaques() {
    if (plaquesEl) return plaquesEl;
    plaquesEl = document.getElementById("dfDiploPlaques");
    if (!plaquesEl) {
      plaquesEl = document.createElement("div");
      plaquesEl.id = "dfDiploPlaques";
      swallow(plaquesEl);
      plaquesEl.addEventListener("click", function (event) {
        var btn = event.target && event.target.closest
          ? event.target.closest("[data-diplo-plaque]") : null;
        if (!btn) return;
        if (btn.dataset.diploPlaque === "petitions") {
          // The petitions screen's entry point -- dwf-info-panel.js.
          try { if (typeof window.openPanel === "function") window.openPanel("petitions"); }
          catch (err) { DwfErr.report("diplo.petitions.open", err); }
        } else if (btn.dataset.diploPlaque === "diplomacy") {
          mirrorOpen = true;
          renderMirror();
        }
      });
      document.body.appendChild(plaquesEl);
    }
    return plaquesEl;
  }

  function mirror() {
    if (mirrorEl) return mirrorEl;
    mirrorEl = document.getElementById("dfDiploMirror");
    if (!mirrorEl) {
      mirrorEl = document.createElement("div");
      mirrorEl.id = "dfDiploMirror";
      swallow(mirrorEl);
      mirrorEl.addEventListener("click", function (event) {
        var close = event.target && event.target.closest
          ? event.target.closest("[data-diplo-close]") : null;
        if (close) { mirrorOpen = false; renderMirror(); }
      });
      document.body.appendChild(mirrorEl);
    }
    return mirrorEl;
  }

  function renderPlaques() {
    var el = plaques();
    var html = plaqueStackMarkup(state);
    el.innerHTML = html;
    el.classList.toggle("show", !!html);
    document.body.classList.toggle("df-plaques-visible", !!html);
    if (html) {
      paintSurface(el, "plaques");
      // The canvas gets its box once the interface map has loaded; a measured 0 re-measures shortly after.
      var measure = function () {
        try {
          var h = el.getBoundingClientRect().height;
          document.body.style.setProperty("--df-plaque-stack-h", (h ? h + 3 : 0) + "px");
          return h > 0;
        } catch (err) {
          DwfErr.report("diplo.plaques.measure", err);
          return true;
        }
      };
      if (!measure()) setTimeout(measure, 400);
    } else {
      document.body.style.setProperty("--df-plaque-stack-h", "0px");
    }
  }

  function paintSurface(el, family) {
    el.querySelectorAll("[data-diplo-color]").forEach(function (word) {
      word.style.setProperty("--diplo-word-color", word.dataset.diploColor);
    });
    try {
      if (HAS_DWFUI && typeof DWFUI.paintSprites === "function") DWFUI.paintSprites(el);
    } catch (err) { DwfErr.report("diplo." + family + ".paint-sprites", err); }
    try {
      if (HAS_DWFUI && typeof DWFUI.paintBitmapText === "function") {
        var pending = DWFUI.paintBitmapText(el);
        if (pending && typeof pending.catch === "function")
          pending.catch(function (err) { DwfErr.report("diplo." + family + ".paint-bitmap-text", err); });
      }
    } catch (err) { DwfErr.report("diplo." + family + ".paint-bitmap-text", err); }
  }

  function renderMirror() {
    var el = mirror();
    // The mirror closes itself when there is nothing left to show (meeting ended AND queue
    // empty) -- and, like native, it never blocks anything else in the browser.
    if (!mirrorOpen || (!state.open && state.meetingsQueued === 0)) {
      mirrorOpen = false;
      el.classList.remove("show");
      el.innerHTML = "";
      return;
    }
    el.innerHTML = meetingModalMarkup(state);
    el.classList.add("show");
    paintSurface(el, "mirror");
  }

  function onDiplo(msg) {
    var result = applyDiploFrame(state, msg);
    if (!result.changed) return;
    var wasOpen = state.open;
    state = result.state;
    // Auto-surface the mirror on the meeting's rising edge -- the native dialog just opened
    // and is sim-blocking; every browser player should SEE it (popup-mirror doctrine).
    if (state.open && !wasOpen) mirrorOpen = true;
    renderPlaques();
    renderMirror();
  }

  if (typeof window !== "undefined") window.DwfDiplo = {
    onDiplo: onDiplo,
    // pure pieces for the offline harness:
    applyDiploFrame: applyDiploFrame,
    wordLines: wordLines,
    wordLinesHtml: wordLinesHtml,
    meetingBodyHtml: meetingBodyHtml,
    meetingModalMarkup: meetingModalMarkup,
    plaqueStackMarkup: plaqueStackMarkup,
  };
  if (typeof module !== "undefined" && module.exports)
    module.exports = { applyDiploFrame: applyDiploFrame, wordLines: wordLines,
      wordLinesHtml: wordLinesHtml, meetingBodyHtml: meetingBodyHtml,
      meetingModalMarkup: meetingModalMarkup, plaqueStackMarkup: plaqueStackMarkup };
})();
