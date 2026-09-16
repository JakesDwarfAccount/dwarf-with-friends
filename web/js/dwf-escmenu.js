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

// dwf-escmenu.js -- DF's Esc menu. The session rows (retire/abandon/quit and DF's own two
// save-and-exit rows) are COSMETIC for every client; only Settings, Return and Save are wired.

(function () {
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("escmenu", ["windowHtml", "plaqueBtnHtml", "bitmapTextHtml"]);

  // Only `webSave`, `settings` and `return` do anything: the other five rows are COSMETIC mirrors of
  // DF's own Esc menu, which still happens in the host's Steam window.
  const ROWS = [
    { key: "web-save", label: "Save the fortress", hostOnly: false, webSave: true },
    { key: "save-title", label: "Save and return to title menu", hostOnly: true },
    { key: "save-continue", label: "Save and continue playing", hostOnly: true },
    { key: "retire", label: "Retire the fortress (for the time being)", hostOnly: true },
    { key: "abandon", label: "Abandon the fortress to ruin", hostOnly: true },
    { key: "quit", label: "Quit without saving", hostOnly: true },
    { key: "settings", label: "Settings", hostOnly: false },
    { key: "return", label: "Return to game", hostOnly: false },
  ];

  // Module-level so it survives the menu closing and re-opening mid-save. The server also refuses a
  // concurrent save, so this is defence in depth rather than the only guard.
  let saveInFlight = false;

  // Kept as its own function so the day a host-only action does need gating, only this call site changes.
  function isHostClient() {
    try {
      return !!(window.DwfWS && typeof window.DwfWS.isHost === "function" && window.DwfWS.isHost());
    } catch (err) {
      DwfErr.report("esc-menu.host-check", err);
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
    // isHostClient() remains relevant to the five cosmetic host-session rows and Host settings.
    // The functional quicksave row is different: every player who passed the join gate can use it.
    const preview = options || null;
    const host = preview && typeof preview.host === "boolean" ? preview.host : isHostClient();
    const rowsHtml = ROWS.map(row => {
      // The save row is available to every joined player, disabled only while this client's save is in flight.
      if (row.webSave) {
        const disabled = saveInFlight;
        const label = saveInFlight ? "Saving…" : row.label;
        const title = saveInFlight
          ? "A save is already in progress."
          : "Save the fortress to disk now. Does not exit -- the game keeps running for everyone.";
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
      // The <h2> tag and the `.esc-panel h2` rule are the seam and stay; only the TEXT moves to bitmap text.
      bodyHtml: `<h2>${window.DWFUI.bitmapTextHtml("Dwarf Fortress")}</h2>` +
        `<div class="esc-rows">${rowsHtml}</div>`,
    });
  }

  // Every native Esc row is a full-width grey slab plaque, and `cls: "esc-row"` keeps the pinned class
  // and the [data-esc-row] delegation. Exported so dwf-hostpanel.js emits the SAME plaque, not a copy.
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
    // dwf-hostpanel.js injects its own host-only row here: a no-op for spectators, idempotent on repaint.
    try { if (window.DwfHostPanel) window.DwfHostPanel.attachEscMenu(el); }
    catch (err) { DwfErr.report("esc-menu.host-row.attach", err); }
    el.querySelectorAll("[data-esc-row]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        const key = button.dataset.escRow;
        if (key === "return") { closeEscMenu(); return; }
        if (key === "web-save") { doWebSave(); return; }
        if (key === "settings") {
          closeEscMenu();
          // DF's own settings screen is unreachable over HTTP, so this opens the client's Settings panel.
          if (window.DFSettings && typeof window.DFSettings.open === "function") window.DFSettings.open();
          else document.getElementById("settingsMenu")?.classList.add("open");
          return;
        }
      });
    });
  }

  function openEscMenu() {
    // DF's own Esc menu is a game-level screen -- close any client panel/tool state under it
    // first (mirrors the Escape-cascade rule this is the last stop of: tool -> panel -> menu).
    if (typeof window.clearBuildPlacement === "function") window.clearBuildPlacement(false);
    if (typeof window.closeClientPanel === "function") window.closeClientPanel();
    if (typeof window.closeSelection === "function") window.closeSelection();
    if (typeof window.setActiveToolbar === "function") window.setActiveToolbar(null);
    paintMenu();
    ensureMenuEl().classList.add("open");
  }

  // Reuses the pause module's single toast host rather than duplicating one, and degrades to a console
  // line when that module is absent -- never an intrusive alert.
  function saveToast(text) {
    try {
      if (window.DwfPause && typeof window.DwfPause.toast === "function") {
        window.DwfPause.toast(text);
        return;
      }
    } catch { return logSaveStatus(text); }
    logSaveStatus(text);
  }

  function logSaveStatus(text) {
    try { console.log("[dwf] " + text); return true; }
    catch { return false; }
  }

  // The blocking "saving..." feedback is the shared busy banner, not anything here.
  async function doWebSave() {
    if (saveInFlight) return;                 // in-flight: ignore double-click / menu-reopen re-fire
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
      // needed). 200 => save requested; 401 => not joined; 409 => world state refused it.
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      ok = r.ok && body && body.ok === true;
      if (!ok) errText = (body && body.err) ? String(body.err) : ("HTTP " + r.status);
    } catch {
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
    const view = document.getElementById("view");
    if (view) {
      try { view.focus({ preventScroll: true }); }
      catch { return; }
    }
  }

  window.escMenuOpen = isOpen;
  window.openEscMenu = openEscMenu;
  window.closeEscMenu = closeEscMenu;
  // `rowHtml` is exported so dwf-hostpanel.js's attachEscMenu() injects the SAME native plaque
  // this menu builds -- one row grammar, one definition.
  window.DwfEscMenu = { storyMarkup: escMenuMarkup, rowHtml: escRowHtml };
})();
