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

// ---- Multiplayer lobby: every CONNECTED player, in their cursor colour, from window.DwfPresence. ----
// DEF-500 WIRE GAP: the roster's only RTT field is permanently -1, so no live column is drawn.
(function () {
  "use strict";

  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("lobby", ["headerHtml", "rowHtml", "plaqueBtnHtml", "scrollHtml", "esc"]);

  // A raw session key must never render as a player name: it becomes "Guest <first-4>", with the full
  // key kept on the title and dataset so follow and jump still address the real roster entry.
  const ANON_NAME_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|p-[0-9a-z]+-[0-9a-z]+)$/i;
  function lobbyDisplayName(name) {
    const raw = String(name == null ? "" : name);
    if (!ANON_NAME_RE.test(raw)) return { text: raw, anon: false };
    return { text: "Guest " + raw.replace(/^p-/, "").slice(0, 4), anon: true };
  }
  function lobbyConnectionLabel(p) {
    const rtt = window.DwfCore.finiteRosterNumber(p && (p.rttMs ?? p.rtt));
    if (rtt !== null && rtt >= 0) return { text: `${Math.round(rtt)} ms`, title: "Measured websocket round trip" };
    const age = window.DwfCore.finiteRosterNumber(p && p.lastInboundAgeMs);
    if (age !== null && age >= 0) {
      const secs = Math.max(0, Math.round(age / 1000));
      return { text: secs <= 1 ? "live" : `${secs}s`, title: `Last inbound frame ${secs}s ago; RTT not sampled yet` };
    }
    return { text: "live", title: "Connected roster entry; RTT not sampled yet" };
  }
  if (typeof module !== "undefined" && module.exports && typeof document === "undefined") {
    module.exports = { lobbyConnectionLabel, lobbyDisplayName, lobbyRowsHtml, lobbyPanelMarkup };
    return;
  }
  // Stable order: self first, then named players A-Z on the DISPLAY name, then unnamed guests last.
  function sortRoster(roster) {
    return roster.sort((a, b) => {
      const as = a && a.self ? 0 : 1, bs = b && b.self ? 0 : 1;
      if (as !== bs) return as - bs;
      const da = lobbyDisplayName(a && a.name), db = lobbyDisplayName(b && b.name);
      if (da.anon !== db.anon) return da.anon ? 1 : -1;
      return da.text.localeCompare(db.text, undefined, { sensitivity: "base" }) ||
        String(a && a.name).localeCompare(String(b && b.name));
    });
  }

  function lobbyRowsHtml(roster, options) {
    options = options || {};
    return (Array.isArray(roster) ? roster : []).map(p => {
      if (!p) return "";
      const rawName = String(p.name == null ? "" : p.name);
      const dn = lobbyDisplayName(rawName);
      const col = p.color || window.DwfCore.playerColor(rawName);
      const idle = p.idle ? " lobby-idle" : "";
      const cam = window.DwfCore.presenceCamera(p, { round: false });
      const canSpectate = !!cam && !p.self;
      const spectate = (typeof window !== "undefined" && window.DwfSpectate) || null;
      const st = options.followName !== undefined
        ? { following: !!options.followName, name: String(options.followName || "") }
        : (spectate && typeof spectate.getState === "function" ? spectate.getState() : null);
      const following = !!(st && st.following && st.name === rawName);
      // The roster carries no host field, so the tag is data-driven and simply absent when the fact is
      // not known. Never guessed.
      const selfIsHost = !!(p.self && typeof window !== "undefined" && window.DwfWS &&
        typeof window.DwfWS.isHost === "function" && window.DwfWS.isHost());
      const isHost = !!(p.host || p.isHost || selfIsHost);
      const nameTitle = dn.anon ? `${rawName} (hasn't picked a name yet)` : rawName;
      const baseTitle = canSpectate ? `Click to jump to ${dn.text || "player"}` : (p.self ? "This is you" : "Camera not available yet");
      const rowTitle = `${baseTitle}. Full name: ${dn.text || rawName}`;
      const followTitle = following ? `Stop following ${dn.text || "player"}` : `Follow ${dn.text || "player"}'s camera`;
      // Datasets carry the RAW roster name -- datasetAttrs escapes for HTML, and pre-escaping here makes
      // getAttribute() return the entity form, which never matches a name containing & or a quote.
      const follow = window.DWFUI.plaqueBtnHtml({
        label: following ? "Stop" : "Follow",
        tone: following ? "green" : "grey",
        cls: `lobby-follow${following ? " active" : ""}`,
        dataset: { lobbyFollow: rawName },
        disabled: !canSpectate,
        title: followTitle,
      });
      // A rename RE-BROADCASTS over WS so every other roster and your cursor label update; a local relabel
      // alone is the documented __dwfAdoptName trap.
      const rename = p.self ? window.DWFUI.plaqueBtnHtml({
        label: "Rename",
        tone: "grey",
        cls: "lobby-rename",
        dataset: { lobbyRename: rawName },
        title: "Change your display name (others will see it)",
      }) : null;
      // Column grammar: [swatch] [name (+you/HOST tags)] [follow/rename]. Only the name cell flexes, and it
      // clips with an ellipsis, so no name length can push or overlap the action column.
      return window.DWFUI.rowHtml({
        chassis: "table",
        cls: `lobby-row${idle}${canSpectate ? " lobby-jumpable" : " lobby-no-camera"}`,
        dataset: { lobbyPlayer: rawName },
        title: rowTitle,
        copyCls: "lobby-copy",
        cells: [
          { html: `<span class="lobby-swatch" data-lobby-color="${DWFUI.esc(col)}" title="Cursor color on the map"></span>`, cls: "lobby-swatch-cell" },
          {
            html: `<span class="lobby-name${dn.anon ? " lobby-anon" : ""}" data-lobby-color="${DWFUI.esc(col)}" title="${DWFUI.esc(nameTitle)}">${DWFUI.esc(dn.text)}</span>` +
              (p.self ? '<span class="lobby-you" title="This is you">(you)</span>' : "") +
              (isHost ? '<span class="lobby-host" title="Host: runs the fort">HOST</span>' : ""),
            cls: "lobby-name-cell",
          },
          { html: rename || follow, cls: "lobby-follow-cell" },
        ],
      });
    }).join("");
  }

  function lobbyPanelMarkup(options) {
    options = options || {};
    const roster = sortRoster(Array.isArray(options.roster) ? options.roster.slice() : []);
    const rows = lobbyRowsHtml(roster, options);
    // The `.lobby-rows` class passes straight through scrollHtml, so render()'s querySelector still resolves it.
    const paused = !/^running$/i.test(String(options.pauseText || "Running"));
    return window.DWFUI.headerHtml({ tag: "h3", titleTag: "span", titleCls: "lobby-count", title: `Players - ${roster.length}`, close: false }) +
      `<div class="lobby-status${paused ? " lobby-status-paused" : ""}">` +
      '<span class="lobby-status-dot" aria-hidden="true"></span>' +
      `<span class="lobby-pause">${DWFUI.esc(options.pauseText || "Running")}</span></div>` +
      window.DWFUI.scrollHtml({ cls: "lobby-rows", rows: ".lobby-row", ariaLabel: "Connected players" },
        rows || '<div class="lobby-empty">No players connected</div>');
  }

  let panel = null, btn = null, pauseText = "Running";

  function ensurePanel() {
    if (panel) return panel;
    panel = document.getElementById("lobbyPanel");
    return panel;
  }

  // Build the persistent shell once: only .lobby-count, .lobby-pause and .lobby-rows are updated in
  // place, so the drag handle and the framework's X survive the ~30 Hz roster re-renders.
  function ensureShell(el) {
    if (el.querySelector(".lobby-rows")) return;
    el.innerHTML =
      window.DWFUI.headerHtml({ tag: "h3", titleTag: "span", titleCls: "lobby-count", title: "", close: false }) +
      '<div class="lobby-status"><span class="lobby-status-dot" aria-hidden="true"></span><span class="lobby-pause"></span></div>' +
      window.DWFUI.scrollHtml({ cls: "lobby-rows", rows: ".lobby-row", ariaLabel: "Connected players" }, "");
  }

  function render() {
    const el = ensurePanel();
    if (!el) return;
    ensureShell(el);
    const P = window.DwfPresence;
    const roster = sortRoster((P && Array.isArray(P.roster)) ? P.roster.slice() : []);
    const rows = lobbyRowsHtml(roster);
    el.querySelector(".lobby-count").textContent = `Players - ${roster.length}`;
    el.querySelector(".lobby-pause").textContent = pauseText;
    // The status strip is green "Running" / warning-orange anything else ("Paused by X",
    // "Paused -- X left"); the dot color is the paused-state signal, the text is the actor.
    const status = el.querySelector(".lobby-status");
    if (status) status.classList.toggle("lobby-status-paused", !/^running$/i.test(pauseText));
    el.querySelector(".lobby-rows").innerHTML = rows || '<div class="lobby-empty">No players connected</div>';
  }

  function isOpen() { return !!panel && panel.classList.contains("open"); }
  function open() {
    const el = ensurePanel();
    if (el) {
      el.classList.add("open"); render(); refreshBtn();
      try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("lobby", true); }
      catch (err) { DwfErr.report("lobby.panel-open", err); }
    }
  }
  function close() {
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("lobby", false); }
    catch (err) { DwfErr.report("lobby.panel-close", err); }
    if (panel) panel.classList.remove("open");
    refreshBtn();
  }
  function toggle() { if (isOpen()) close(); else open(); }
  function refreshBtn() { if (btn) btn.classList.toggle("sb-active", isOpen()); }

  function boot() {
    panel = document.getElementById("lobbyPanel");
    btn = document.getElementById("lobbyBtn");
    if (btn) {
      btn.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      });
    }
    if (panel) {
      // Engage on POINTERDOWN, not click: every render replaces this panel's innerHTML, and a re-render
      // between press and release swallows the click. Bind pointerdown ONLY -- both would toggle twice.
      panel.addEventListener("pointerdown", event => {
        if (typeof event.button === "number" && event.button !== 0) return; // primary button only
        // Rename control (self row only). Delegated -- like follow -- so the ~30 Hz roster
        // re-render can replace the button between press and release without swallowing it.
        const renameBtn = event.target.closest("[data-lobby-rename]");
        if (renameBtn) {
          event.preventDefault();
          event.stopPropagation();
          const cur = renameBtn.getAttribute("data-lobby-rename");
          try {
            if (window.DwfJoin && typeof window.DwfJoin.showRenameScreen === "function")
              window.DwfJoin.showRenameScreen(cur);
          } catch (err) { DwfErr.report("lobby.rename", err); }
          return;
        }
        const followBtn = event.target.closest("[data-lobby-follow]");
        const spectate = window.DwfSpectate;
        if (followBtn) {
          event.preventDefault();
          event.stopPropagation();
          if (!followBtn.disabled && spectate && typeof spectate.toggleFollow === "function") {
            spectate.toggleFollow(followBtn.getAttribute("data-lobby-follow"));
            render();
          }
          return;
        }
        const row = event.target.closest("[data-lobby-player]");
        if (!row || !row.classList.contains("lobby-jumpable")) return;
        event.preventDefault();
        if (spectate && typeof spectate.jumpToPlayer === "function")
          spectate.jumpToPlayer(row.getAttribute("data-lobby-player"));
      });
    }
    // Close on outside click, mirroring #settingsMenu.
    document.addEventListener("pointerdown", event => {
      if (!isOpen()) return;
      if (event.target.closest("#lobbyPanel, #lobbyBtn")) return;
      close();
    });
    // Build the shell BEFORE registering, so the framework adopts this real <h3> as the drag handle;
    // registering first makes attach() inject a throwaway head that the next ensureShell would wipe.
    if (panel) ensureShell(panel);
    if (panel && window.DFPanelFrame) window.DFPanelFrame.register({
      key: "lobby", el: () => panel, title: "Players",
      headSel: "h3", closable: true, persistOpen: false,
      defaultPos: (vw, vh) => ({ anchor: "tr", x: 212, y: 52, w: 360, h: 264 }),
      open, close, isOpen, escClosable: true,
    });
    // Live-update the open panel on roster change (cheap; only re-renders when visible).
    if (window.DwfPresence && typeof window.DwfPresence.onChange === "function") {
      window.DwfPresence.onChange(() => { if (isOpen()) render(); });
    }
    if (window.DwfSpectate && typeof window.DwfSpectate.onChange === "function") {
      window.DwfSpectate.onChange(() => { if (isOpen()) render(); });
    }
  }

  // Public seam: the pause broadcast calls setPauseText to show "Paused by guest".
  window.DwfLobby = {
    open, close, toggle, isOpen,
    storyMarkup: lobbyPanelMarkup,
    // The ONE canonical anonymizer: every presence surface resolves display text through this, so a guest
    // reads the same name everywhere while the raw key stays in the roster for follow, jump and colour.
    displayName: lobbyDisplayName,
    // All lobby styling lives in web/css; this seam stays only because stories.js calls it before rendering.
    preparePreview() {},
    setPauseText(text) { pauseText = String(text || "Running"); if (isOpen()) render(); },
  };

  if (!window.__DWF_STORY_MODE) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})();
