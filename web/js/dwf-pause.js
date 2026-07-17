// dwf - WP-B pause-arbiter client consumer (WT01 pause line + WT03 saving indicator)
//
// Self-contained consumer for the server's two WP-B broadcasts, routed here from dwf-ws.js:
//   {"type":"pause","paused":<bool>,"by":"<actor>","reason":"player|external|leave"[,"who":"<n>"]}
//   {"type":"busy","state":"start|clear","autosave":<bool>,"ms":<age>,"stallMs":<total>}
//
// Responsibilities:
//   * Pause broadcast -> set window.__dfPauseByBroadcast (so renderHud stops overwriting the
//     lobby line from the 1 s /hud poll), update the topbar pause/play shading IMMEDIATELY,
//     drive DwfLobby.setPauseText("Paused by X"/"Running"), and show a 3 s toast.
//   * Busy broadcast -> a non-blocking top-center banner ("Host is busy... (Ns)" for a plain core
//     stall, upgraded to "Autosaving... (Ns)" ONLY when the server saw the autosave_request flag),
//     held >=800 ms to avoid flicker, cleared on `busy clear` or a 60 s failsafe. B213: a non-save
//     stall must NOT say "saving" -- autosave:false is provably not a save (see paintBanner).
//
// Inert-graceful against an OLD deployed DLL that never sends these frames: the module simply
// never runs, and renderHud keeps its WP-A Running/Paused behavior. Zero console noise.
(function () {
  "use strict";

  // DWFUI contract -- see dwf-escmenu.js. This family consumed DWFUI with ZERO require()
  // declarations, so a removed component failed SILENTLY, mid-render. Presence-guarded, but NOT
  // throw-swallowing. (This module was already fully migrated -- statusHtml for both the toast and
  // the busy banner -- and its style block holds too few colour literals to trip R1. It needs the
  // declaration and nothing else.)
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("pause", ["statusHtml"]);

  // ---- shared style (injected once, self-contained: no external CSS dependency) --------------
  function ensureStyle() {
    if (document.getElementById("dfPauseStyle")) return;
    const st = document.createElement("style");
    st.id = "dfPauseStyle";
    st.textContent = `
      #dfPauseToasts{position:fixed;top:52px;left:50%;transform:translateX(-50%);
        z-index:9000;display:flex;flex-direction:column;gap:6px;align-items:center;
        pointer-events:none;font-family:inherit}
      .df-pause-toast{background:rgba(20,23,28,0.94);color:#e8e2d4;border:1px solid #4a4640;
        border-radius:6px;padding:6px 14px;font-size:13px;letter-spacing:.02em;
        box-shadow:0 3px 12px rgba(0,0,0,.5);opacity:0;transition:opacity .2s ease;white-space:nowrap}
      .df-pause-toast.show{opacity:1}
      #dfBusyBanner{position:fixed;top:96px;left:50%;transform:translateX(-50%);z-index:8990;
        display:none;background:rgba(40,30,16,0.95);color:#ffd98a;border:1px solid #b0842c;
        border-radius:7px;padding:8px 18px;font-size:14px;font-weight:600;letter-spacing:.02em;
        box-shadow:0 3px 14px rgba(0,0,0,.55);font-family:inherit;
        animation:dfBusyPulse 1.4s ease-in-out infinite}
      #dfBusyBanner.show{display:block}
      @keyframes dfBusyPulse{0%,100%{opacity:1}50%{opacity:.55}}`;
    (document.head || document.documentElement).appendChild(st);
  }

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
      `<div id="dfBusyBanner" class="show" style="display:block">${busyMarkup(label, secs)}</div>`;
  }
  function showToast(text) {
    try {
      ensureStyle();
      const el = document.createElement("div");
      el.className = "df-pause-toast";
      el.innerHTML = toastMarkup(text);
      toastHost().appendChild(el);
      requestAnimationFrame(() => el.classList.add("show"));
      setTimeout(() => {
        el.classList.remove("show");
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
      }, 3000);
    } catch (_) {}
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

    // B206 PAUSE-ANIM: the WP-B broadcast is the SERVER-GLOBAL pause state (the game is paused
    // for every player) -> drive the world animation clock so miasma/flows/fire/water/machine
    // frames FREEZE with the game, immediately (not on the 1s /hud poll). Inert if the clock
    // module isn't loaded (older page).
    try { if (window.DFAnimClock) window.DFAnimClock.setPaused(!!msg.paused); } catch (_) {}

    // Topbar shading, IMMEDIATELY (don't wait for the 1 s /hud poll).
    try {
      const pauseBtn = document.querySelector('#topbar [data-action="pause"]');
      const playBtn = document.querySelector('#topbar [data-action="play"]');
      if (pauseBtn) pauseBtn.classList.toggle("sb-active", msg.paused);
      if (playBtn) playBtn.classList.toggle("sb-active", !msg.paused);
      if (typeof window.DFRefreshPauseIcons === "function") window.DFRefreshPauseIcons(msg.paused);
    } catch (_) {}

    // Lobby pause line.
    try {
      if (window.DwfLobby && typeof DwfLobby.setPauseText === "function")
        DwfLobby.setPauseText(lobbyLine(msg));
    } catch (_) {}

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
    // B213: the server only SAVES on the /save (Esc-menu) or native-autosave path -- both of which
    // set plotinfo.main.autosave_request, so g_autosave_seen (lastAutosave) is true for a real save.
    // A workshop interaction (the craftsdwarf report) NEVER reaches a save path; it only stalls
    // the core-suspended push loop long enough to trip this 1.5s busy watchdog. Calling that "saving"
    // told a playtester the game saves on every craftsdwarf click. When autosave is false it is provably NOT
    // saving -> say "Host is busy", never "saving". "Autosaving" is reserved for the real flag.
    const label = lastAutosave ? "Autosaving" : "Host is busy";
    // DF's bitmap atlas does not contain the single-character ellipsis. Three native periods keep
    // this live-updating status in the bitmap renderer instead of silently falling back to a TTF.
    try { banner().innerHTML = window.DWFUI.statusHtml({ tag: "span", cls: "df-busy-copy", tone: "warn", text: `${label}... (${secs}s)`, role: "status", live: "polite" }); } catch (_) {}
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
      try { banner().classList.remove("show"); banner().style.display = "none"; } catch (_) {}
    };
    if (force) { doHide(); return; }
    // Hold the banner >=800 ms even if `clear` arrives almost immediately (anti-flicker).
    const heldFor = Date.now() - shownAt;
    if (heldFor >= 800) doHide();
    else setTimeout(doHide, 800 - heldFor);
  }

  function onBusy(msg) {
    if (!msg || typeof msg.state !== "string") return;
    ensureStyle();
    if (msg.state === "start") {
      lastAutosave = !!msg.autosave;
      const ageMs = (typeof msg.ms === "number" && msg.ms >= 0) ? msg.ms : 0;
      if (!busyActive) {
        busyActive = true;
        stallStartWall = Date.now() - ageMs;   // back-date so (Ns) is honest from the first paint
        shownAt = Date.now();
        try { banner().classList.add("show"); banner().style.display = "block"; } catch (_) {}
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

  // `toast` is exported so other modules (e.g. the Esc-menu host-save flow) reuse this one toast
  // host + style instead of duplicating it. The saving BANNER stays owned by onBusy() -- callers
  // that trigger a world write get the banner for free from the WP-B busy broadcast; they only use
  // this toast for the success/failure result line.
  window.DwfPause = { onPause, onBusy, toast: showToast, storyMarkup: pauseStoryMarkup, preparePreview: ensureStyle };
})();
