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

// dwf-pause.js -- consumer for the server's pause and busy broadcasts: the topbar pause state,
// the lobby pause line and the busy/autosave banner.
(function () {
  "use strict";

  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("pause", ["statusHtml"]);

  // ---- toast --------------------------------------------------------------------------------
  function toastHost() {
    let h = document.getElementById("dfPauseToasts");
    if (!h) {
      h = document.createElement("div");
      h.id = "dfPauseToasts";
      document.body.appendChild(h);
    }
    return h;
  }
  function toastMarkup(text) {
    return window.DWFUI.statusHtml({ tag: "span", cls: "df-pause-toast-copy", text: text, role: "status", live: "polite" });
  }
  function busyMarkup(label, secs) {
    return window.DWFUI.statusHtml({ tag: "span", cls: "df-busy-copy", tone: "warn", text: `${label}... (${secs}s)`, role: "status", live: "polite" });
  }
  function pauseStoryMarkup(options) {
    options = options || {};
    const toast = options.toast || "Paused by Urist";
    const label = options.autosave ? "Autosaving" : "Host is busy";
    const secs = Number.isFinite(Number(options.secs)) ? Math.max(0, Math.round(Number(options.secs))) : 3;
    return `<div id="dfPauseToasts"><div class="df-pause-toast show">${toastMarkup(toast)}</div></div>` +
      `<div id="dfBusyBanner" class="show">${busyMarkup(label, secs)}</div>`;
  }
  function showToast(text) {
    try {
      const el = document.createElement("div");
      let fadeTimer = null;
      let removalTimer = null;
      el.className = "df-pause-toast";
      el.innerHTML = toastMarkup(text);
      toastHost().appendChild(el);
      const refresh = () => {
        if (!el.parentNode) return false;
        clearTimeout(fadeTimer);
        clearTimeout(removalTimer);
        el.classList.add("show");
        fadeTimer = setTimeout(() => {
          el.classList.remove("show");
          removalTimer = setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
        }, 3000);
        return true;
      };
      requestAnimationFrame(refresh);
      return { refresh };
    } catch (err) { DwfErr.report("pause.toast", err); }
    return null;
  }

  // ---- pause broadcast ----------------------------------------------------------------------
  function lobbyLine(msg) {
    if (msg.reason === "leave") return `Paused — ${msg.who || "a player"} left`;
    if (msg.paused) return `Paused by ${msg.by || "host"}`;
    return "Running";
  }
  function toastLine(msg) {
    if (msg.reason === "leave") return `Paused — ${msg.who || "a player"} left`;
    return `${msg.paused ? "Paused" : "Unpaused"} by ${msg.by || "host"}`;
  }

  function onPause(msg) {
    if (!msg || typeof msg.paused !== "boolean") return;
    // Broadcasts are now authoritative for the lobby pause line -> stop renderHud from
    // overwriting it from the slower /hud poll.
    window.__dfPauseByBroadcast = true;

    try { if (window.DFAnimClock) window.DFAnimClock.setPaused(!!msg.paused); }
    catch (err) { DwfErr.report("pause.animation-clock", err); }

    // Topbar shading, IMMEDIATELY (don't wait for the 1 s /hud poll).
    try {
      const pauseBtn = document.querySelector('#topbar [data-action="pause"]');
      const playBtn = document.querySelector('#topbar [data-action="play"]');
      if (pauseBtn) pauseBtn.classList.toggle("sb-active", msg.paused);
      if (playBtn) playBtn.classList.toggle("sb-active", !msg.paused);
      if (typeof window.DFRefreshPauseIcons === "function") window.DFRefreshPauseIcons(msg.paused);
    } catch (err) { DwfErr.report("pause.icons", err); }

    // Lobby pause line.
    try {
      if (window.DwfLobby && typeof DwfLobby.setPauseText === "function")
        DwfLobby.setPauseText(lobbyLine(msg));
    } catch (err) { DwfErr.report("pause.lobby-text", err); }

    showToast(toastLine(msg));
  }

  // ---- busy / saving indicator --------------------------------------------------------------
  let busyEl = null;
  let busyActive = false;
  let stallStartWall = 0;    // Date.now() when the stall began (server ms back-dates it)
  let lastAutosave = false;
  let shownAt = 0;           // when the banner was first shown (>=800 ms hold, no-flicker)
  let tickTimer = null;      // 1 s local counter so (Ns) advances between 2 s server re-broadcasts
  let failsafeTimer = null;  // 60 s hard hide even if `clear` never arrives

  function banner() {
    if (busyEl) return busyEl;
    busyEl = document.getElementById("dfBusyBanner");
    if (!busyEl) {
      busyEl = document.createElement("div");
      busyEl.id = "dfBusyBanner";
      document.body.appendChild(busyEl);
    }
    return busyEl;
  }
  function paintBanner() {
    const secs = Math.max(0, Math.round((Date.now() - stallStartWall) / 1000));
    const label = lastAutosave ? "Autosaving" : "Host is busy";
    // DF's bitmap atlas does not contain the single-character ellipsis. Three native periods keep
    // this live-updating status in the bitmap renderer instead of silently falling back to a TTF.
    try { banner().innerHTML = window.DWFUI.statusHtml({ tag: "span", cls: "df-busy-copy", tone: "warn", text: `${label}... (${secs}s)`, role: "status", live: "polite" }); }
    catch (err) { DwfErr.report("pause.busy-banner", err); }
  }
  function startTick() {
    stopTick();
    tickTimer = setInterval(() => { if (busyActive) paintBanner(); }, 1000);
  }
  function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }
  function armFailsafe() {
    if (failsafeTimer) clearTimeout(failsafeTimer);
    failsafeTimer = setTimeout(() => hideBanner(true), 60000);
  }
  function hideBanner(force) {
    const doHide = () => {
      busyActive = false;
      stopTick();
      if (failsafeTimer) { clearTimeout(failsafeTimer); failsafeTimer = null; }
      try { banner().classList.remove("show"); banner().hidden = true; }
      catch (err) { DwfErr.report("pause.busy-hide", err); }
    };
    if (force) { doHide(); return; }
    // Hold the banner >=800 ms even if `clear` arrives almost immediately (anti-flicker).
    const heldFor = Date.now() - shownAt;
    if (heldFor >= 800) doHide();
    else setTimeout(doHide, 800 - heldFor);
  }

  function onBusy(msg) {
    if (!msg || typeof msg.state !== "string") return;
    if (msg.state === "start") {
      lastAutosave = !!msg.autosave;
      const ageMs = (typeof msg.ms === "number" && msg.ms >= 0) ? msg.ms : 0;
      if (!busyActive) {
        busyActive = true;
        stallStartWall = Date.now() - ageMs;   // back-date so (Ns) is honest from the first paint
        shownAt = Date.now();
        try { banner().classList.add("show"); banner().hidden = false; }
        catch (err) { DwfErr.report("pause.busy-show", err); }
        startTick();
        armFailsafe();
      } else {
        // re-broadcast: refresh the age anchor (keeps the counter in sync with the server) + wording
        stallStartWall = Date.now() - ageMs;
        armFailsafe();
      }
      paintBanner();
    } else if (msg.state === "clear") {
      hideBanner(false);
    }
  }

  // `toast` is exported so other modules reuse this one toast host instead of duplicating it. The
  // saving BANNER stays owned by onBusy().
  window.DwfPause = { onPause, onBusy, toast: showToast, storyMarkup: pauseStoryMarkup, preparePreview: function () {} };
})();
