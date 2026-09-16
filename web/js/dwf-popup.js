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

// dwf-popup.js -- the native popup mirror: shows DF's modal announcement popups to every
// browser player and lets any of them acknowledge via POST /popup/dismiss.
(function () {
  "use strict";

  var HAS_DWFUI = typeof DWFUI !== "undefined";
  if (HAS_DWFUI && typeof DWFUI.require === "function")
    DWFUI.require("popup", ["messageBoxHtml"]);

  // Frames are seq-ordered: a stale or duplicate seq is ignored, so an out-of-order sticky resync can
  // never resurrect a popup the live wire already cleared.
  function applyPopupFrame(state, msg) {
    state = state || { seq: -1, popups: [] };
    if (!msg || msg.type !== "popup" || !Number.isFinite(Number(msg.seq)))
      return { changed: false, state: state };
    var seq = Number(msg.seq);
    if (seq <= state.seq)
      return { changed: false, state: state };
    var popups = Array.isArray(msg.popups) ? msg.popups.filter(function (p) {
      return p && Number.isFinite(Number(p.id));
    }) : [];
    return { changed: true, state: { seq: seq, popups: popups } };
  }

  // The BOX is DWFUI.messageBoxHtml -- the decoded native widget tree lives there. This screen supplies
  // only the wire data and its own pinned class and dataset hooks.
  function popupModalMarkup(popup, queuedCount) {
    if (!popup) return "";
    var lines = Array.isArray(popup.text) ? popup.text : [];
    // portraitHfid, color and bright are read DEFENSIVELY: absent fields produce the absent-field layout,
    // never an invented one, so an old server gets the plain box and a newer one needs no client change.
    var portraitHfid = Number(popup.portraitHfid);
    return DWFUI.messageBoxHtml({
      lines: lines,
      queued: Number(queuedCount) || 0,
      color: popup.color, bright: popup.bright,
      portraitReserved: Number.isFinite(portraitHfid) && portraitHfid >= 0,
      ariaLabel: "Announcement",
      cls: "df-native-popup", textCls: "df-popup-text", lineCls: "df-popup-line",
      dataset: { popupId: popup.id, popupKind: popup.kind || "" },
      acknowledge: { cls: "df-popup-dismiss", dataset: { popupDismiss: popup.id } },
    });
  }

  // ---- live state -------------------------------------------------------------------------------
  var state = { seq: -1, popups: [] };
  var dismissInFlight = {};   // id -> true while a POST is out (double-click = one request)
  var overlayEl = null;

  function playerName() {
    try { return window.playerName || ""; } catch { return ""; }
  }

  function toast(text) {
    try {
      if (window.DwfPause && typeof DwfPause.toast === "function")
        DwfPause.toast(text);
    } catch (error) { DwfErr.report("popup.toast", error); }
  }

  function overlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.getElementById("dfPopupMirror");
    if (!overlayEl) {
      overlayEl = document.createElement("div");
      overlayEl.id = "dfPopupMirror";
      ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "pointerdown", "pointerup",
       "touchstart", "touchend"].forEach(function (type) {
        overlayEl.addEventListener(type, function (event) { event.stopPropagation(); },
          { passive: type === "touchstart" || type === "touchend" });
      });
      overlayEl.addEventListener("click", function (event) {
        var btn = event.target && event.target.closest
          ? event.target.closest("[data-popup-dismiss]") : null;
        if (btn) sendDismiss(Number(btn.dataset.popupDismiss), btn);
      });
      document.body.appendChild(overlayEl);
    }
    return overlayEl;
  }

  // UI-DIV-004: the blocking box is draggable and remembers where it was left. Registered
  // `chromeless: true`, so the framework generates NO title bar and NO close control.
  function popupBox() {
    var host = overlay();
    var box = document.getElementById("dfPopupBox");
    if (!box) {
      box = document.createElement("div");
      box.id = "dfPopupBox";
      host.appendChild(box);
      try {
        if (window.DFPanelFrame && typeof window.DFPanelFrame.register === "function")
          window.DFPanelFrame.register({
            key: "popupBox", el: function () { return document.getElementById("dfPopupBox"); },
            title: "Announcement", movable: true, chromeless: true, closable: false, menu: false,
            zBand: false, escClosable: false, persistOpen: false, cssDocked: true,
            isOpen: function () { var h = document.getElementById("dfPopupMirror");
              return !!h && h.classList.contains("show"); },
          });
      } catch (error) { DwfErr.report("popup.panel-register", error); }
    }
    return box;
  }
  // The default placement is native's centre, recomputed per popup because the box's geometry changes
  // with its text; the framework then substitutes the player's remembered rect if there is one.
  function placeBox() {
    var box = popupBox();
    box.style.removeProperty("--df-popup-left");
    box.style.removeProperty("--df-popup-top");
    var rect = box.getBoundingClientRect();
    box.style.setProperty("--df-popup-left",
      Math.max(0, Math.round((window.innerWidth - rect.width) / 2)) + "px");
    box.style.setProperty("--df-popup-top",
      Math.max(0, Math.round((window.innerHeight - rect.height) / 2)) + "px");
    try {
      if (window.DFPanelFrame && typeof window.DFPanelFrame.syncOpenState === "function")
        window.DFPanelFrame.syncOpenState("popupBox", true);
    } catch (error) { DwfErr.report("popup.panel-open-sync", error); }
  }

  // Offline production viewport hook: the shipping path calls placeBox() after writing markup.
  // Atlas already owns a static #dfPopupBox, so it needs only the same centering arithmetic.
  function placePreviewBox(targetDocument) {
    var doc = targetDocument || document;
    var box = doc.getElementById("dfPopupBox");
    var view = doc.defaultView;
    if (!box || !view) return;
    box.style.removeProperty("--df-popup-left");
    box.style.removeProperty("--df-popup-top");
    var rect = box.getBoundingClientRect();
    box.style.setProperty("--df-popup-left",
      Math.max(0, Math.round((view.innerWidth - rect.width) / 2)) + "px");
    box.style.setProperty("--df-popup-top",
      Math.max(0, Math.round((view.innerHeight - rect.height) / 2)) + "px");
  }

  function render() {
    var el = overlay(), box = popupBox();
    if (!state.popups.length) {
      // ORDER MATTERS: tell the framework FIRST, then hide. It measures the panel on close, and a box
      // inside a display:none overlay measures 0x0.
      try {
        if (window.DFPanelFrame && typeof window.DFPanelFrame.syncOpenState === "function")
          window.DFPanelFrame.syncOpenState("popupBox", false);
      } catch (error) { DwfErr.report("popup.panel-close-sync", error); }
      el.classList.remove("show");
      box.innerHTML = "";
      return;
    }
    // Mirror the native behavior: ONE popup at a time (the front of the queue), the rest counted.
    var front = state.popups[0];
    box.innerHTML = popupModalMarkup(front, state.popups.length - 1);
    el.classList.add("show");
    placeBox();
    try { if (HAS_DWFUI && typeof DWFUI.paintSprites === "function") DWFUI.paintSprites(el); }
    catch (error) { DwfErr.report("popup.paint-sprites", error); }
  }

  function sendDismiss(id, btn) {
    if (!Number.isFinite(id) || dismissInFlight[id]) return;
    dismissInFlight[id] = true;
    if (btn) btn.setAttribute("disabled", "disabled");
    var params = new URLSearchParams();
    params.set("player", playerName());
    params.set("id", String(id));
    fetch("/popup/dismiss?" + params.toString(), { method: "POST", cache: "no-store" })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, body: j }; }); })
      .then(function (r) {
        delete dismissInFlight[id];
        if (!r.ok || r.body.ok === false) {
          if (btn) btn.removeAttribute("disabled");
          toast("Could not dismiss the popup" + (r.body && r.body.error ? ": " + r.body.error : ""));
          return;
        }
        // Optimistic local advance so the UI feels immediate; the server's own {"type":"popup"}
        // broadcast (sent right after the apply) remains authoritative and will reconcile.
        state.popups = state.popups.filter(function (p) { return Number(p.id) !== id; });
        render();
      })
      .catch(function () {
        delete dismissInFlight[id];
        if (btn) btn.removeAttribute("disabled");
        toast("Could not dismiss the popup (network error)");
      });
  }

  function onPopup(msg) {
    var result = applyPopupFrame(state, msg);
    if (!result.changed) return;
    state = result.state;
    if (msg.by && !state.popups.length)
      toast("Announcement dismissed by " + msg.by);
    render();
  }

  if (typeof window !== "undefined") window.DwfPopup = {
    onPopup: onPopup,
    // pure pieces for the offline harness:
    applyPopupFrame: applyPopupFrame,
    popupModalMarkup: popupModalMarkup,
    ensureStyle: function () {},
    placePreviewBox: placePreviewBox,
  };
  if (typeof module !== "undefined" && module.exports)
    module.exports = { applyPopupFrame: applyPopupFrame, popupModalMarkup: popupModalMarkup };
})();
