// dwf - WT28/B218 native popup mirror client consumer
//
// Self-contained consumer for the server's {"type":"popup",...} broadcast (routed here from
// dwf-ws.js). The server mirrors DF's native modal announcement popups (mega/BOX boxes:
// megabeast, siege night-attack, first caravan, ...; and the announcement-alert window: caravan
// arrival etc.) that hard-pause AND wedge the sim until dismissed at the physical PC. This module
// shows the same popup to every browser player and lets ANY of them dismiss it via
// POST /popup/dismiss -- after which the ordinary shared unpause works again.
//
// Frame shape (sticky; late joiners get the current set on join, empty popups[] = all clear):
//   {"type":"popup","seq":N,"blocked":bool[,"by":"player"],
//    "popups":[{"id":1,"kind":"mega"|"alert","typeKey":"TRADE","title":"",
//               "text":["line",...],"pauses":true}]}
//
// DWFUI mandate: the modal is BUILT from DWFUI pieces (modalHtml + scrollHtml + plaqueBtnHtml) --
// no hand-rolled panel markup. The geometry (centered overlay, not the left-docked squad-dialog
// dock) is screen-owned CSS on the `df-native-popup` cls hook, colors resolved through the
// --dwfui-* tokens. PROVISIONAL PENDING ORACLE PARITY: native captures of these popups don't exist
// yet (they get forced with dfhack `force` at harvest) -- the structure is DWFUI so the parity
// pass can restyle without rework.
//
// B216 rule: dismissing (or any click inside the overlay) must NEVER move the camera -- the
// overlay swallows pointer/wheel events, and the text body is a .dwfui-scroll so the wheel works.
//
// Inert-graceful against an OLD server that never sends these frames: the module simply never
// renders anything.
(function () {
  "use strict";

  var HAS_DWFUI = typeof DWFUI !== "undefined";
  if (HAS_DWFUI && typeof DWFUI.require === "function")
    DWFUI.require("popup", ["modalHtml", "plaqueBtnHtml", "scrollHtml"]);

  function esc(s) {
    if (HAS_DWFUI && typeof DWFUI.esc === "function") return DWFUI.esc(s);
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---- pure state reducer (exported for the harness) -------------------------------------------
  // Frames are seq-ordered; a stale or duplicate seq is ignored so an out-of-order sticky resync
  // can never resurrect a popup the live wire already cleared. Returns {changed, state}.
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

  // Humanize an announcement_alert_type key ("TRADE" -> "Trade", "UNDEAD_ATTACK" -> "Undead attack").
  function typeLabel(typeKey) {
    var k = String(typeKey || "").trim();
    if (!k) return "";
    var words = k.toLowerCase().split("_").join(" ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function headerLine(popup) {
    // PROVISIONAL COPY (parity pass owns the final wording against forced-capture oracles):
    // the native mega box has no title bar; the alert window is titled by its alert type.
    if (popup && popup.kind === "alert") {
      var label = typeLabel(popup.typeKey);
      return label ? "Alert: " + label : "Alerts";
    }
    return "Announcement";
  }

  // ---- markup (pure; exported for the harness) --------------------------------------------------
  function popupModalMarkup(popup, queuedCount) {
    if (!popup) return "";
    var lines = Array.isArray(popup.text) ? popup.text : [];
    var bodyLines = lines.map(function (line) {
      return line === ""
        ? '<div class="df-popup-line df-popup-line-blank">&nbsp;</div>'
        : '<div class="df-popup-line">' + esc(line) + "</div>";
    }).join("");
    if (!bodyLines)
      bodyLines = '<div class="df-popup-line df-popup-line-empty">(no text)</div>';
    var body = DWFUI.scrollHtml(
      { cls: "df-popup-text", ariaLabel: "Announcement text" }, bodyLines);
    var queued = Number(queuedCount) > 0
      ? '<span class="df-popup-queued">' + esc("+" + Number(queuedCount) + " more") + "</span>"
      : "";
    var footer = queued + DWFUI.plaqueBtnHtml({
      label: "Dismiss", tone: "green", cls: "df-popup-dismiss",
      dataset: { popupDismiss: popup.id },
      title: "Dismiss this announcement for everyone (unpause works again after)",
    });
    return DWFUI.modalHtml({
      prompt: headerLine(popup),
      cls: "df-native-popup",
      ariaLabel: "Native announcement popup",
      dataset: { popupId: popup.id, popupKind: popup.kind || "" },
      footerHtml: footer,
    }, body);
  }

  // ---- shared style (injected once; geometry only -- colors come from --dwfui-* tokens) ----------
  function ensureStyle() {
    if (document.getElementById("dfPopupStyle")) return;
    var st = document.createElement("style");
    st.id = "dfPopupStyle";
    st.textContent = [
      // Overlay: centered, above the map + panels, below the pause toasts (9000).
      "#dfPopupMirror{position:fixed;inset:0;z-index:8980;display:none;",
      "  align-items:center;justify-content:center;background:rgba(0,0,0,0.35)}",
      "#dfPopupMirror.show{display:flex}",
      // Screen-owned geometry override of the left-docked .dwfui-modal dock: this mirror is a
      // CENTERED box (provisional pending the forced-capture oracles).
      "#dfPopupMirror .df-native-popup{position:static;width:min(560px,92vw);",
      "  height:auto;max-height:70vh}",
      "#dfPopupMirror .df-popup-text{padding:2px 0}",
      "#dfPopupMirror .df-popup-line{color:var(--dwfui-text-body);",
      "  font:var(--dwfui-font);white-space:pre-wrap}",
      "#dfPopupMirror .df-popup-line-empty{color:var(--dwfui-text-secondary)}",
      "#dfPopupMirror .dwfui-modal-footer{justify-content:flex-end}",
      "#dfPopupMirror .df-popup-queued{color:var(--dwfui-text-secondary);margin-right:auto}",
      "#dfPopupMirror .df-popup-dismiss[disabled]{opacity:.55;pointer-events:none}",
    ].join("\n");
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- live state -------------------------------------------------------------------------------
  var state = { seq: -1, popups: [] };
  var dismissInFlight = {};   // id -> true while a POST is out (double-click = one request)
  var overlayEl = null;

  function playerName() {
    try { return window.playerName || ""; } catch (_) { return ""; }
  }

  function toast(text) {
    try {
      if (window.DwfPause && typeof DwfPause.toast === "function")
        DwfPause.toast(text);
    } catch (_) {}
  }

  function overlay() {
    if (overlayEl) return overlayEl;
    ensureStyle();
    overlayEl = document.getElementById("dfPopupMirror");
    if (!overlayEl) {
      overlayEl = document.createElement("div");
      overlayEl.id = "dfPopupMirror";
      // B216: nothing that happens inside this overlay may reach the map input handlers --
      // dismissing must never move the camera, and the wheel belongs to the .dwfui-scroll body.
      ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "pointerdown", "pointerup",
       "wheel", "touchstart", "touchend"].forEach(function (type) {
        overlayEl.addEventListener(type, function (event) { event.stopPropagation(); },
          { passive: type === "wheel" || type === "touchstart" || type === "touchend" });
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

  function render() {
    var el = overlay();
    if (!state.popups.length) {
      el.classList.remove("show");
      el.innerHTML = "";
      return;
    }
    // Mirror the native behavior: ONE popup at a time (the front of the queue), the rest counted.
    var front = state.popups[0];
    el.innerHTML = popupModalMarkup(front, state.popups.length - 1);
    el.classList.add("show");
    try { if (HAS_DWFUI && typeof DWFUI.paintSprites === "function") DWFUI.paintSprites(el); } catch (_) {}
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
    typeLabel: typeLabel,
    headerLine: headerLine,
  };
  if (typeof module !== "undefined" && module.exports)
    module.exports = { applyPopupFrame: applyPopupFrame, popupModalMarkup: popupModalMarkup, typeLabel: typeLabel, headerLine: headerLine };
})();
