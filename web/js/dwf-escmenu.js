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

// WD-27 (part 2/2 -- see dwf-worldmap.js for the World screen half): DF's real Esc menu
// (23-esc-menu.png), client-scoped per the decision (docs/superpowers/plans/
// 2026-07-07-overnight-run-orders.md, "morning 07-07"): Save-and-return / Save-and-continue /
// Retire / Abandon / Quit-without-saving are COSMETIC ONLY -- the host saves in their own Steam
// client window, NOT through this browser UI, and no `/host-action` endpoint is being built
// (explicitly ruled out). Settings / Return to game stay fully functional.
//
// HOST DETECTION (WD-27 follow-up, landed): a real host-identity signal now exists. The server
// computes it once per WebSocket connection from the ACCEPTED SOCKET's real TCP peer address
// (websocket.cpp's socket_is_loopback_peer(): true iff the peer is 127.0.0.0/8 or ::1 -- nothing
// a client can spoof via headers/URL params) and surfaces it in `hello_ack`'s `isHost` field
// (the "existing per-player JSON" every v1 connection already receives), also mirrored in
// `/diag`'s per-player rows for out-of-browser verification. dwf-ws.js tracks the latest
// value and exposes it as `DwfWS.isHost()`.
//
// Per the scope call (docs/superpowers/plans/2026-07-07-overnight-run-orders.md, "morning
// 07-07"): Retire/Abandon/Quit and DF's OWN two save-and-exit rows stay COSMETIC-ONLY for EVERY
// client, host included -- no `/host-action` endpoint for those. So `isHostClient()` below wires
// the real signal through, and those five session rows remain hard-disabled regardless of what it
// returns -- see the render() tooltip logic, which does not branch their disabled state on `host`.
//
// UPDATE (approved 2026-07-07, "HOST CAN SAVE FROM THE WEB -- SAVE-ONLY, no load"): a SINGLE
// genuinely functional row -- "Save the fortress" (`webSave: true`) -- now DOES gate on
// isHostClient(). It POSTs /save, which quicksaves WITHOUT exiting (the DFHack autosave-request
// pathway; server route in http_server.cpp, host-gated by the same peer-loopback test the pause
// arbiter uses). It never triggers a load. The saving-in-progress feedback reuses the existing
// WP-B busy banner (dwf-pause.js) -- this menu only adds a confirm + a result toast.
//
// THE MUSIC STRIP (23-esc-menu.png, below the window: a SEPARATE gold-framed strip carrying
// "Track playing: <title> - <artist>" / "Last interlude: <title> - <artist>"). It is still omitted,
// but the OLD reason recorded here -- "dwf has no audio system to report on" -- was STALE and
// is deleted: dwf-audio.js IS a full audio director and DOES know the current track
// (state.musicTrack + trackLabel()). The two REAL blockers, as of Wave-5 gate C:
//   1. NO "last interlude" DATUM EXISTS. Our director's quiet phase is a `gap` MODE (silence), not a
//      played interlude track, and no track/artist is retained for it. Half the strip would have to
//      be fabricated, and fabricated native chrome is the defect this programme exists to kill.
//   2. The strip is a SECOND framed box stacked BELOW the menu window; #escMenu is a centred flex
//      row and .esc-panel/.esc-music carry no stacking or padding rules. Landing it faithfully needs
//      CSS, and CSS is frozen this wave (strangler: structure first).
// Neither is an evidence gap -- the oracle is clear. Both are tracked for the CSS wave. Until then
// the now-playing line lives, truthfully, in the audio popover (dwf-audio.js).

(function () {
  // DWFUI contract. This family consumed DWFUI with ZERO require() declarations, so a component
  // removed from the layer failed SILENTLY, mid-render, as a half-painted panel. require() throws --
  // loudly, at load, naming the surface. The `typeof` guard is presence-only (the node harnesses
  // load this file with no DWFUI at all); it does NOT swallow the throw.
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("escmenu", ["windowHtml", "plaqueBtnHtml", "bitmapTextHtml"]);

  // The `webSave` row is the ONE genuinely functional host action in this menu (approved
  // 2026-07-07, SAVE-ONLY): it POSTs /save, which quicksaves the fortress WITHOUT exiting. It is
  // host-gated on the real isHostClient() signal (see below) -- enabled only for the loopback host,
  // disabled with a reason for everyone else. The five rows below it stay COSMETIC-ONLY mirrors of
  // DF's own Esc menu (save-and-return / save-and-continue / retire / abandon / quit) -- those
  // still happen in the host's Steam window, never through this browser (see file header). Only
  // `webSave` and `settings`/`return` do anything.
  const ROWS = [
    { key: "web-save", label: "Save the fortress", hostOnly: true, webSave: true },
    { key: "save-title", label: "Save and return to title menu", hostOnly: true },
    { key: "save-continue", label: "Save and continue playing", hostOnly: true },
    { key: "retire", label: "Retire the fortress (for the time being)", hostOnly: true },
    { key: "abandon", label: "Abandon the fortress to ruin", hostOnly: true },
    { key: "quit", label: "Quit without saving", hostOnly: true },
    { key: "settings", label: "Settings", hostOnly: false },
    { key: "return", label: "Return to game", hostOnly: false },
  ];

  // Module-level so it survives the menu being closed/re-opened mid-save: while a /save POST is in
  // flight the web-save row is disabled everywhere (double-click / re-open spam can't fire a second
  // save; the server ALSO refuses a concurrent save, so this is defence-in-depth, not the only
  // guard). Cleared when the POST settles (success or failure).
  let saveInFlight = false;

  // See file header -- real signal, sourced from DwfWS.isHost() (the client-side tracker
  // of the server's per-connection, peer-address-derived `hello_ack.isHost` field). Kept as its
  // own function (not inlined) so the day a host-only action DOES need gating, only this
  // function's call site needs to change -- not the render()/tooltip logic below, which
  // deliberately does NOT branch the disabled state on it yet (see file header).
  function isHostClient() {
    try {
      return !!(window.DwfWS && typeof DwfWS.isHost === "function" && DwfWS.isHost());
    } catch (_) {
      return false;
    }
  }

  let menuEl = null;
  function ensureMenuEl() {
    if (menuEl) return menuEl;
    menuEl = document.getElementById("escMenu");
    if (!menuEl) {
      menuEl = document.createElement("div");
      menuEl.id = "escMenu";
      document.body.appendChild(menuEl);
    }
    return menuEl;
  }

  function isOpen() {
    return !!menuEl && menuEl.classList.contains("open");
  }

  function escMenuMarkup(options) {
    // isHostClient() is a REAL signal now (see file header) but is deliberately NOT consulted
    // for `disabled` here: The owner ruled Save/Retire/Abandon/Quit cosmetic-only for every client,
    // host included (host saves through their own Steam client window). Only the tooltip
    // wording varies by host-ness, so the wired-through signal is visibly doing something
    // today, not just plumbing for later.
    const preview = options || null;
    const host = preview && typeof preview.host === "boolean" ? preview.host : isHostClient();
    const rowsHtml = ROWS.map(row => {
      // The functional host-save row: enabled ONLY for the loopback host, and only when no save is
      // already in flight from this client. Its label reflects the in-flight state so a re-opened
      // menu shows "Saving…" rather than an actionable-looking button.
      if (row.webSave) {
        const disabled = !host || saveInFlight;
        const label = saveInFlight ? "Saving…" : row.label;
        const title = !host
          ? "Host only -- only the host (the machine running Dwarf Fortress) can save the fortress."
          : (saveInFlight
              ? "A save is already in progress."
              : "Save the fortress to disk now. Does not exit -- the game keeps running (host stays where they are).");
        return escRowHtml({ key: row.key, label, disabled, title, extraCls: "esc-row-save" });
      }
      const disabled = row.hostOnly;
      const title = disabled
        ? (host
            ? "Cosmetic only -- save/retire/abandon/quit happen in your own Dwarf Fortress (Steam) window, not this browser."
            : "Host only -- save/retire/abandon/quit happen in the host's own Dwarf Fortress (Steam) window, not this browser.")
        : "";
      return escRowHtml({ key: row.key, label: row.label, disabled, title });
    }).join("");
    return window.DWFUI.windowHtml({
      cls: "esc-panel",
      role: "dialog",
      ariaLabel: "Dwarf Fortress menu",
      // NATIVE (23-esc-menu.png): a centred WHITE title in DF's bitmap font -- no icon, no close.
      // The <h2> tag and .esc-panel h2 rule are kept (strangler: the class is the seam); only the
      // TEXT is lifted onto the shared bitmap-text channel.
      bodyHtml: `<h2>${window.DWFUI.bitmapTextHtml("Dwarf Fortress")}</h2>` +
        `<div class="esc-rows">${rowsHtml}</div>`,
    });
  }

  // NATIVE ROW GRAMMAR (23-esc-menu.png, the ONE oracle this family has): every row of DF's Esc menu
  // is a FULL-WIDTH GREY SLAB PLAQUE -- HORIZONTAL_OPTION_INACTIVE art with a centred white label.
  // Not a bordered web button. plaqueBtnHtml IS that control, and `cls: "esc-row"` keeps the pinned
  // class, the CSS, and the [data-esc-row] delegation exactly as they were.
  //
  // SHARED with dwf-hostpanel.js's attachEscMenu(), which injects the host-only "Host settings"
  // row into this same list: both must emit the SAME plaque, or one hand-built row sits among seven
  // native ones. Exported below as DwfEscMenu.rowHtml so there is ONE definition, not two.
  function escRowHtml(cfg) {
    const c = cfg || {};
    return window.DWFUI.plaqueBtnHtml({
      label: c.label == null ? "" : c.label,
      tone: "grey",
      cls: "esc-row" + (c.extraCls ? " " + c.extraCls : "") + (c.disabled ? " esc-row-disabled" : ""),
      dataset: { escRow: c.key },
      disabled: !!c.disabled,
      title: c.title || undefined,
    });
  }

  // Paint the menu body and (re-)attach row listeners. Factored out of openEscMenu so doWebSave can
  // repaint in place to reflect the "Saving…" disabled state without reopening the menu.
  function paintMenu() {
    const el = ensureMenuEl();
    el.innerHTML = escMenuMarkup();
    // HOST SETTINGS entry (host-only, self-contained -- see dwf-hostpanel.js). Injects its
    // own "Host settings" row into this menu for the loopback host only; a no-op for spectators
    // and idempotent across repaints.
    try { if (window.DwfHostPanel) DwfHostPanel.attachEscMenu(el); } catch (_) {}
    el.querySelectorAll("[data-esc-row]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        const key = button.dataset.escRow;
        if (key === "return") { closeEscMenu(); return; }
        if (key === "web-save") { doWebSave(); return; }
        if (key === "settings") {
          closeEscMenu();
          // Phase-5: DF's own (inaccessible-over-HTTP) settings screen is stood in for by this
          // client's full Settings panel (dwf-settings.js: keybinds/interface/audio/info).
          // Dormant-safe fallback to the legacy top-bar cog menu if that module didn't load.
          if (window.DFSettings && typeof window.DFSettings.open === "function") window.DFSettings.open();
          else document.getElementById("settingsMenu")?.classList.add("open");
          return;
        }
        // Cosmetic hostOnly rows: buttons are `disabled` for non-host clients so this never fires
        // today (see isHostClient() above); left as a no-op rather than silently succeeding if that
        // ever changes without also wiring a real action.
      });
    });
  }

  function openEscMenu() {
    // DF's own Esc menu is a game-level screen -- close any client panel/tool state under it
    // first (mirrors the Escape-cascade rule this is the last stop of: tool -> panel -> menu).
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    if (typeof closeClientPanel === "function") closeClientPanel();
    if (typeof closeSelection === "function") closeSelection();
    if (typeof setActiveToolbar === "function") setActiveToolbar(null);
    paintMenu();
    ensureMenuEl().classList.add("open");
  }

  // Result line for the save flow. Reuses the pause module's single toast host/style (exported as
  // DwfPause.toast) rather than duplicating one; the SAVING BANNER itself is driven for free
  // by the WP-B busy broadcast once DF's world write stalls the push loop. Inert-graceful if the
  // pause module isn't loaded (old client): degrades to a console line, never an intrusive alert.
  function saveToast(text) {
    try {
      if (window.DwfPause && typeof DwfPause.toast === "function") {
        DwfPause.toast(text);
        return;
      }
    } catch (_) {}
    try { console.log("[dwf] " + text); } catch (_) {}
  }

  // Host-only Save action (approved 2026-07-07, SAVE-ONLY). Confirm -> POST /save -> result
  // toast. The blocking "saving…" feedback is the shared WP-B busy banner, not anything here.
  async function doWebSave() {
    if (saveInFlight) return;                 // in-flight: ignore double-click / menu-reopen re-fire
    if (!isHostClient()) {                    // defence-in-depth (the button is already disabled)
      saveToast("Host only — only the host can save the fortress.");
      return;
    }
    // Confirm (matches the window.confirm pattern used elsewhere in the client). The menu stays
    // open behind it; Cancel is a clean no-op.
    if (!window.confirm(
        "Save the fortress now?\n\nThis writes the game to disk. It does NOT exit — the game keeps " +
        "running. Saving briefly freezes the world for everyone while it writes.")) {
      return;
    }
    saveInFlight = true;
    if (isOpen()) paintMenu();                // reflect the disabled "Saving…" state immediately
    let ok = false, errText = "";
    try {
      const r = await fetch("/save", { method: "POST", cache: "no-store" });
      // Same-origin POST: the dfcap_auth cookie is attached automatically (no credentials opt-in
      // needed). 200 => save requested; 403 => not host; 409 => world state refused it.
      let body = null;
      try { body = await r.json(); } catch (_) {}
      ok = r.ok && body && body.ok === true;
      if (!ok) errText = (body && body.err) ? String(body.err) : ("HTTP " + r.status);
    } catch (e) {
      errText = "could not reach the host";
    } finally {
      saveInFlight = false;
      if (isOpen()) paintMenu();              // re-enable the row (or reflect it's gone/closed)
    }
    if (ok) {
      // "requested", not "finished": the banner covers the actual write; the toast confirms the
      // request landed. Keeping it truthful avoids implying the bytes are already on disk.
      saveToast("Saving the fortress…");
    } else if (errText === "save already in progress") {
      saveToast("A save is already in progress.");
    } else {
      saveToast("Save failed: " + errText);
    }
  }

  function closeEscMenu() {
    if (!menuEl) return;
    menuEl.classList.remove("open");
    menuEl.innerHTML = "";
    try { document.getElementById("view")?.focus({ preventScroll: true }); } catch (_) {}
  }

  window.escMenuOpen = isOpen;
  window.openEscMenu = openEscMenu;
  window.closeEscMenu = closeEscMenu;
  // `rowHtml` is exported so dwf-hostpanel.js's attachEscMenu() injects the SAME native plaque
  // this menu builds -- one row grammar, one definition.
  window.DwfEscMenu = { storyMarkup: escMenuMarkup, rowHtml: escRowHtml };
})();
