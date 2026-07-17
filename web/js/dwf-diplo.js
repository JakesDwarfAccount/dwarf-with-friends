// dwf - B225 petitions/diplomacy detector + diplomacy meeting mirror (client)
//
// Self-contained consumer for the server's {"type":"diplo",...} broadcast (routed here from
// dwf-ws.js; src/diplo.cpp is the producer). Two jobs:
//
//   1. THE DETECTOR (the thing the owner reported missing outright): native's left-rail attention
//      plaques. PETITIONS (brown light, PETITIONS_LIGHT -- The owner: "brown petitions box above
//      announcements and below alert box") appears while any petition awaits a decision and
//      opens the existing B188 petitions screen (openPanel("petitions") ->
//      dwf-fort-admin.js openPetitionsPanel). DIPLOMACY (blue light, DIPLOMACY_LIGHT,
//      oracle B225-1) appears while a diplomat meeting is queued or underway and opens the
//      meeting mirror. Art is the real game art, nine-slice-tiled by DWFUI.lightPlaqueHtml
//      from the cells graphics_interface.txt maps ([TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS:
//      42:12:3:3:PETITIONS_LIGHT] / [...:29:12:3:3:DIPLOMACY_LIGHT]).
//
//   2. THE MEETING MIRROR: the native diplomacy dialog (main_interface.diplomacy -- oracle
//      B225-2: dark full window, narration + colored speech lines, Okay plaque), rebuilt from
//      the mirrored word stream (per-word native colors). v1 is READ-ONLY on the advance:
//      "advanceHostNative":true in the wire -- the Okay button renders disabled with an
//      honest title (the artBtnHtml placeholder doctrine: say what evidence is missing, never
//      invent behavior). The land-holder and requests sub-screens render their mirrored DATA
//      plainly; their native looks are unverified (no captures exist) and are NOT guessed --
//      B188's own precedent: "Non-residency petition types had no reference and were not
//      guessed." Screenshot requests are in the DIPLO-PETITIONS closeout.
//
// Frame shape (sticky; late joiners get the current state on join):
//   {"type":"diplo","seq":N,"petitionsPending":N,"meetingsQueued":N,"open":bool[,"by":p],
//    "meeting":null|{"mode":"text"|"landHolder"|"requests","actor":s,"target":s,
//                    "advanceHostNative":true,
//                    "words":[{"t":s[,"c":"#rrggbb"][,"nl":1][,"blank":1][,"ind":1]},...],
//                    ["landHolder":{"positions":[s],"candidates":[{"hfid":N,"name":s}]},]
//                    ["requests":{"selectedTab":N,"tabs":[{"cat":N,"name":s,
//                                                          "priorities":[0..4]}]},]
//                    "topics":[s]}}
//
// B216 rule: nothing inside the overlay may move the camera -- the overlay swallows pointer/
// wheel events; scrolling text lives in a .dwfui-scroll body. Plaques have NO hover and NO lit
// click state (on the petitions plaque, B188 review). Inert-graceful on an old server that
// never sends these frames: nothing renders.
(function () {
  "use strict";

  var HAS_DWFUI = typeof DWFUI !== "undefined";
  if (HAS_DWFUI && typeof DWFUI.require === "function")
    DWFUI.require("diplo", ["modalHtml", "plaqueBtnHtml", "lightPlaqueHtml", "rowHtml", "scrollHtml"]);

  function esc(s) {
    if (HAS_DWFUI && typeof DWFUI.esc === "function") return DWFUI.esc(s);
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---- pure state reducer (exported for the harness) --------------------------------------------
  // Frames are seq-ordered; a stale or duplicate seq is ignored so an out-of-order sticky resync
  // can never resurrect a cleared plaque or a closed meeting (dwf-popup.js discipline).
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

  // ---- word stream -> display lines (pure; exported for the harness) ----------------------------
  // markup_text_wordst flags: NEW_LINE = this word starts a new line; BLANK_LINE = a blank line
  // precedes it; INDENT = paragraph indent. Words on a line are space-joined (PROVISIONAL: the
  // native px offsets are not replayed; the parity pass owns exact spacing). A word's color is
  // whitelisted to #rrggbb before it may touch a style attribute.
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
      return '<div class="df-diplo-line df-diplo-line-empty">(no dialogue text)</div>';
    return lines.map(function (segs) {
      if (!segs.length) return '<div class="df-diplo-line df-diplo-line-blank">&nbsp;</div>';
      var body = segs.map(function (seg, i) {
        var text = esc(seg.t) + (i < segs.length - 1 ? " " : "");
        return seg.c ? '<span style="color:' + seg.c + '">' + text + "</span>" : text;
      }).join("");
      return '<div class="df-diplo-line' + (segs[0].ind ? " df-diplo-line-indent" : "") + '">' +
        body + "</div>";
    }).join("");
  }

  // ---- meeting screen markup (pure; exported for the harness) -----------------------------------
  function meetingBodyHtml(state) {
    if (!state.open || !state.meeting) {
      // Plaque lit but the dialog is not open yet: a diplomat reached the noble and the
      // meeting is QUEUED on the host (plotinfo.dipscript_popups). The browser cannot open
      // native's dialog; say so instead of pretending.
      return '<div class="df-diplo-line">A diplomat is ready to meet' +
        (state.meetingsQueued > 1 ? " (" + state.meetingsQueued + " meetings queued)" : "") +
        '.</div><div class="df-diplo-line df-diplo-note">The meeting dialog opens on the host PC;' +
        " it will mirror here the moment it is open.</div>";
    }
    var m = state.meeting;
    var parts = [wordLinesHtml(m.words)];
    if (m.mode === "landHolder" && m.landHolder) {
      var lh = m.landHolder;
      parts.push('<div class="df-diplo-section">' +
        '<div class="df-diplo-line">Position offered: ' +
        esc((Array.isArray(lh.positions) ? lh.positions : []).join(", ") || "(unknown)") + "</div>" +
        (Array.isArray(lh.candidates) ? lh.candidates : []).map(function (c) {
          return DWFUI.rowHtml({ cls: "df-diplo-candidate", label: c && c.name || "Unknown",
            dataset: { diploCandidate: c && c.hfid != null ? c.hfid : -1 } });
        }).join("") +
        '<div class="df-diplo-line df-diplo-note">Choosing the holder is made at the host PC in' +
        " this version (see the fortress vote for the group's advisory tally).</div></div>");
    }
    if (m.mode === "requests" && m.requests) {
      var tabs = Array.isArray(m.requests.tabs) ? m.requests.tabs : [];
      parts.push('<div class="df-diplo-section">' + tabs.map(function (tab) {
        var prio = (tab && Array.isArray(tab.priorities)) ? tab.priorities : [];
        var requested = prio.filter(function (v) { return Number(v) > 0; }).length;
        return DWFUI.rowHtml({ cls: "df-diplo-reqtab",
          label: (tab && tab.name || "?") + " - " + prio.length + " goods, " + requested + " requested",
          dataset: { diploReqtab: tab && tab.cat != null ? tab.cat : -1 } });
      }).join("") +
        '<div class="df-diplo-line df-diplo-note">Export-agreement details are edited at the host' +
        " PC in this version (the browser mirrors the counts live).</div></div>");
    }
    return parts.join("");
  }

  function meetingModalMarkup(state) {
    var m = state.meeting;
    var header = m && (m.actor || m.target)
      ? "Diplomacy - " + [m.actor, m.target].filter(Boolean).join(" & ")
      : "Diplomacy";
    var body = DWFUI.scrollHtml({ cls: "df-diplo-text", ariaLabel: "Meeting dialogue" },
      meetingBodyHtml(state));
    // The Okay advance is HOST-NATIVE in v1 (wire: advanceHostNative). Disabled placeholder,
    // per the placeholder doctrine: the title says exactly what evidence is missing.
    var okay = state.open ? DWFUI.plaqueBtnHtml({
      label: "Okay", tone: "grey", cls: "df-diplo-okay", disabled: true,
      dataset: { diploOkay: "" },
      title: "Advancing the meeting from the browser is not wired yet - the native Okay " +
        "transition still needs a live struct-diff capture. Advance it at the host PC.",
    }) : "";
    var footer = okay + DWFUI.plaqueBtnHtml({
      label: "Close", tone: "red", cls: "df-diplo-close",
      dataset: { diploClose: "" },
      title: "Close this mirror (the native meeting stays open on the host)",
    });
    return DWFUI.modalHtml({
      prompt: header,
      cls: "df-diplo-screen",
      ariaLabel: "Diplomacy meeting",
      dataset: { diploOpen: state.open ? "1" : "0" },
      footerHtml: footer,
    }, body);
  }

  // ---- plaque stack markup (pure; exported for the harness) --------------------------------------
  // Order matches the native description: (ALERT plate above, owned elsewhere) -> DIPLOMACY ->
  // PETITIONS -> announcement icons below. SIEGE_LIGHT exists in the same raws family but has no
  // detector wire yet -- out of B225's scope, not guessed.
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

  // ---- shared style (injected once; geometry only -- colors come from --dwfui-* tokens) ------------
  function ensureStyle() {
    if (document.getElementById("dfDiploStyle")) return;
    var st = document.createElement("style");
    st.id = "dfDiploStyle";
    st.textContent = [
      // The plaque stack: left rail, below the ALERT plate, above the announcement icon stack
      // (#alertStack top:58px is shifted down while plaques are visible -- native order per the owner:
      // alert box / plaques / announcements).
      "#dfDiploPlaques{position:fixed;left:0;top:58px;z-index:46;display:none;",
      "  flex-direction:column;gap:3px;pointer-events:auto}",
      "#dfDiploPlaques.show{display:flex}",
      "body.df-plaques-visible #alertStack{transform:translateY(var(--df-plaque-stack-h,0px))}",
      // The plaque control: art canvas + centered bitmap label; NO hover, NO lit click state
      // (B188: 'It just clicks and opens the right menu').
      "#dfDiploPlaques .dwfui-lightplaque{position:relative;display:block;padding:0;border:0;",
      "  background:transparent;cursor:pointer;line-height:0}",
      "#dfDiploPlaques .dwfui-lightplaque:hover,#dfDiploPlaques .dwfui-lightplaque:active{",
      "  background:transparent;filter:none}",
      "#dfDiploPlaques .dwfui-lightplaque-label{position:absolute;inset:0;display:flex;",
      "  align-items:center;justify-content:center;pointer-events:none;line-height:normal}",
      "#dfDiploPlaques .dwfui-lightplaque-label .dwfui-bitmap-fallback{color:#ffffff;",
      "  font:var(--dwfui-font)}",
      // The meeting mirror overlay (same stack posture as the popup mirror; the native meeting
      // window is LARGE -- B225-2 -- so this is a big centered box).
      "#dfDiploMirror{position:fixed;inset:0;z-index:8970;display:none;",
      "  align-items:center;justify-content:center;background:rgba(0,0,0,0.35)}",
      "#dfDiploMirror.show{display:flex}",
      "#dfDiploMirror .df-diplo-screen{position:static;width:min(860px,94vw);",
      "  height:auto;max-height:82vh;display:flex;flex-direction:column}",
      "#dfDiploMirror .df-diplo-text{padding:2px 0;flex:1 1 auto}",
      "#dfDiploMirror .df-diplo-line{color:var(--dwfui-text-body);font:var(--dwfui-font);",
      "  white-space:pre-wrap}",
      "#dfDiploMirror .df-diplo-line-indent{padding-left:2ch}",
      "#dfDiploMirror .df-diplo-line-empty,#dfDiploMirror .df-diplo-note{",
      "  color:var(--dwfui-text-secondary)}",
      "#dfDiploMirror .df-diplo-section{margin-top:8px}",
      "#dfDiploMirror .dwfui-modal-footer{justify-content:flex-end;gap:6px}",
      "#dfDiploMirror .df-diplo-okay[disabled]{opacity:.55;pointer-events:auto;cursor:help}",
    ].join("\n");
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- live state ---------------------------------------------------------------------------------
  var state = { seq: -1, petitionsPending: 0, meetingsQueued: 0, open: false, meeting: null };
  var mirrorOpen = false;   // the user opened (or auto-followed) the meeting mirror
  var plaquesEl = null;
  var mirrorEl = null;

  function swallow(el) {
    // B216: nothing that happens inside may reach the map input handlers.
    ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "pointerdown", "pointerup",
     "wheel", "touchstart", "touchend"].forEach(function (type) {
      el.addEventListener(type, function (event) { event.stopPropagation(); },
        { passive: type === "wheel" || type === "touchstart" || type === "touchend" });
    });
  }

  function plaques() {
    if (plaquesEl) return plaquesEl;
    ensureStyle();
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
          // The B188 screen's (now existing) entry point -- dwf-build-info-panels.js.
          try { if (typeof openPanel === "function") openPanel("petitions"); } catch (_) {}
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
    ensureStyle();
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
      try { if (HAS_DWFUI && typeof DWFUI.paintSprites === "function") DWFUI.paintSprites(el); } catch (_) {}
      try { if (HAS_DWFUI && typeof DWFUI.paintBitmapText === "function") DWFUI.paintBitmapText(el); } catch (_) {}
      // Push the announcement icon stack below us (native order). The canvas gets its box
      // synchronously once the interface map is loaded; on the very first render the map may
      // still be in flight (height 0), so a measured 0 re-measures once, shortly after.
      var measure = function () {
        try {
          var h = el.getBoundingClientRect().height;
          document.body.style.setProperty("--df-plaque-stack-h", (h ? h + 3 : 0) + "px");
          return h > 0;
        } catch (_) { return true; }
      };
      if (!measure()) setTimeout(measure, 400);
    } else {
      try { document.body.style.setProperty("--df-plaque-stack-h", "0px"); } catch (_) {}
    }
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
    try { if (HAS_DWFUI && typeof DWFUI.paintSprites === "function") DWFUI.paintSprites(el); } catch (_) {}
    try { if (HAS_DWFUI && typeof DWFUI.paintBitmapText === "function") DWFUI.paintBitmapText(el); } catch (_) {}
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
