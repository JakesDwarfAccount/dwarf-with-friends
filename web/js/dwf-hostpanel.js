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

// ---- Host settings: pause permissions, join password, connected players, build stamp. ----
// Gated on DwfWS.isHost(); the server also refuses a non-loopback POST, so hiding is defence in depth.
(function () {
  "use strict";

  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("host-panel", ["headerHtml", "switchHtml", "plaqueBtnHtml", "rowHtml",
      "scrollHtml", "textInputHtml", "esc"]);

  function isHost() {
    try {
      return !!(window.DwfWS && typeof DwfWS.isHost === "function" && DwfWS.isHost());
    } catch {
      return false;
    }
  }

  // Never throws: callers branch on status (404 = host needs an update, 403 = not the host), so a
  // dormant or older server can only degrade this panel.
  function api(method, path) {
    return fetch(path, { method: method, credentials: "same-origin", cache: "no-store" })
      .then(r => r.text().then(t => {
        let j;
        try { j = t ? JSON.parse(t) : null; } catch { j = null; }
        return { ok: r.ok, status: r.status, json: j };
      }))
      .catch(() => ({ ok: false, status: 0, json: null }));
  }

  // ---- element scaffold ---------------------------------------------------------------------
  let backdrop = null, panel = null, refreshTimer = null;

  function ensureEls() {
    if (panel) return;
    backdrop = document.getElementById("hostPanelBackdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "hostPanelBackdrop";
      document.body.appendChild(backdrop);
      backdrop.addEventListener("pointerdown", ev => { if (ev.target === backdrop) close(); });
    }
    panel = document.getElementById("hostPanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "hostPanel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Host settings");
      backdrop.appendChild(panel);
    }
  }

  // ---- data + rendering ---------------------------------------------------------------------
  // Cached state so a toggle click can optimistically re-render before its round-trip lands.
  let pauseCfg = null;      // { hostUnpauseOnly, autopause, paused, by } from /pause-config
  let players = null;       // [] from /diag
  let versionInfo = null;   // { build, authRequired } from /version
  let audioInfo = null;     // { remote, allowed } from /sound-info (null => route absent)
  let consoleCfg = null;    // { enabled, host } from /console-config (null => route absent/old DLL)
  let joinRouteMissing = false; // set true once a POST /join-password returns 404

  function pauseSection(state) {
    const cfg = (state && state.pauseCfg) || pauseCfg || {};
    const paused = cfg.paused === true;
    const by = window.DWFUI.esc(cfg.by || "host");
    const stateText = paused ? `Paused by ${by}` : "Running";
    const huo = cfg.hostUnpauseOnly === true;
    const ap = cfg.autopause === true;
    // No `trackCls` or `knob` overrides here: they made this module render its private copy of the pill
    // instead of DWFUI's shared one. [data-hp-toggle] on the root is the wire.
    const hostSwitch = window.DWFUI.switchHtml({ cls: `host-panel-toggle${huo ? " on" : ""}`, checked: huo, rootDataset: { hpToggle: "hostunpause" }, copyCls: "host-panel-lbl", labelTag: "b", label: "Only the host can unpause", sub: "Anyone can pause, but only you (the host machine) can resume. Keeps a spectator from unpausing your world." });
    const autoSwitch = window.DWFUI.switchHtml({ cls: `host-panel-toggle${ap ? " on" : ""}`, checked: ap, rootDataset: { hpToggle: "autopause" }, copyCls: "host-panel-lbl", labelTag: "b", label: "Auto-pause when a player leaves", sub: "Pause automatically a few seconds after the last connection of a player drops, so nothing runs unattended." });
    return `
      <section>
        <h3>Pause &amp; permissions</h3>
        <div class="host-panel-state"><span class="host-panel-dot ${paused ? "host-panel-dot-warning" : "host-panel-dot-good"}"></span>${window.DWFUI.esc(stateText)}</div>
        ${hostSwitch}
        ${autoSwitch}
        <div class="host-panel-note">These apply immediately. With an updated host they persist across restarts; on an older host they reset when Dwarf Fortress restarts.</div>
      </section>`;
  }

  function joinSection(state) {
    const version = state && Object.prototype.hasOwnProperty.call(state, "versionInfo") ? state.versionInfo : versionInfo;
    const routeMissing = state && typeof state.joinRouteMissing === "boolean" ? state.joinRouteMissing : joinRouteMissing;
    const known = version != null;
    const on = known && version.authRequired === true;
    const status = !known
      ? `<span class="host-panel-checking">checking…</span>`
      : (on ? `<span class="host-panel-dot host-panel-dot-good"></span>On &mdash; a password is required to join`
            : `<span class="host-panel-dot host-panel-dot-warning"></span>Off &mdash; anyone who can reach the port can join`);
    const fallback = routeMissing ? `
      <div class="host-panel-fallback">This host build can't change the password from the browser yet.
        In the Dwarf Fortress console (DFHack), run <code>capture-join-password &lt;passphrase&gt;</code>
        to set one, or <code>capture-join-password off</code> to turn it off.</div>` : "";
    // A real DOM text input for caret, selection and IME behaviour, but DWFUI owns its field structure.
    const passwordInput = window.DWFUI.textInputHtml({
      id: "hpPw", autocomplete: "off", spellcheck: false,
      placeholder: on ? "New passphrase" : "Set a passphrase",
    });
    // The two ACTIONS are native text plaques -- grey to set/change, RED for the destructive
    // "turn off". The [data-hp-act] wire is byte-identical.
    const setBtn = window.DWFUI.plaqueBtnHtml({
      label: on ? "Change" : "Set", tone: "grey", cls: "host-panel-btn",
      dataset: { hpAct: "pw-set" }, title: on ? "Change the join password" : "Set a join password",
    });
    const offBtn = window.DWFUI.plaqueBtnHtml({
      label: "Turn off password", tone: "red", cls: "host-panel-btn host-panel-danger",
      dataset: { hpAct: "pw-off" }, disabled: !on,
      title: "Remove the join password -- anyone who can reach the port will be able to join",
    });
    return `
      <section>
        <h3>Join password</h3>
        <div class="host-panel-state">${status}</div>
        <div class="host-panel-pw-row">
          ${passwordInput}
          ${setBtn}
        </div>
        <div class="host-panel-pw-row host-panel-pw-row-end">${offBtn}</div>
        <div class="host-panel-msg" id="hpPwMsg"></div>
        ${fallback}
      </section>`;
  }

  // The DFHack-console setting is the ONLY write-guard flag left, and the only one the host flips here.
  function guardsSection(state) {
    const cc = state && Object.prototype.hasOwnProperty.call(state, "consoleCfg") ? state.consoleCfg : consoleCfg;
    if (cc == null) return "";   // old DLL without the route: show nothing rather than a dead switch
    const on = cc.enabled === true;
    const consoleSwitch = window.DWFUI.switchHtml({
      cls: `host-panel-toggle${on ? " on" : ""}`, checked: on, rootDataset: { hpToggle: "console" },
      copyCls: "host-panel-lbl", labelTag: "b",
      label: "Let players run DFHack commands on my PC (advanced)",
      sub: "Opens the in-browser DFHack console for every joined player. Commands run on YOUR " +
           "machine and can affect your game and files (a blocklist stops the worst, not " +
           "everything). Leave off unless you know you want it.",
    });
    return `
      <section>
        <h3>Remote commands</h3>
        ${consoleSwitch}
      </section>`;
  }

  function fmtAge(ms) {
    if (typeof ms !== "number" || ms < 0) return "&mdash;";
    if (ms < 1500) return "now";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    return m + "m ago";
  }

  function playersSection(state) {
    const playerRows = state && Array.isArray(state.players) ? state.players : players;
    let rows;
    if (playerRows == null) {
      rows = `<div class="host-panel-players-empty">loading…</div>`;
    } else if (!playerRows.length) {
      rows = `<div class="host-panel-players-empty">No players connected</div>`;
    } else {
      const self = state && typeof state.self === "string" ? state.self : (function () { try { return window.player || ""; } catch { return ""; } })();
      // Cells are RAW html because the name cell carries the "(you)" marker; every user-supplied value in
      // them still goes through DWFUI.esc.
      const R = window.DWFUI.rowHtml;
      const cell = (html, cls) => ({ html: html, cls: cls });
      const head = R({ chassis: "table", cls: "host-panel-head-row", copyCls: "host-panel-hidden-copy",
        cells: [cell("Player"), cell("Conns", "host-panel-num"), cell("Ping", "host-panel-num"),
          cell("Last seen", "host-panel-num")] });
      const body = playerRows.slice().sort((a, b) =>
        String(a && a.player).localeCompare(String(b && b.player))).map(p => {
        const name = window.DWFUI.esc(p.player);
        const you = p.player === self ? ' <span class="host-panel-you">(you)</span>' : "";
        const conns = (typeof p.connections === "number") ? p.connections : "&mdash;";
        const ping = (typeof p.rttMs === "number" && p.rttMs >= 0) ? p.rttMs + " ms" : "&mdash;";
        const seen = fmtAge(p.lastInboundAgeMs);
        return R({ chassis: "table", copyCls: "host-panel-hidden-copy",
          dataset: { hpPlayer: p.player == null ? "" : String(p.player) },
          cells: [cell(name + you), cell(String(conns), "host-panel-num"), cell(String(ping), "host-panel-num"),
            cell(seen, "host-panel-num")] });
      }).join("");
      rows = `<div class="host-panel-players">${head}${body}</div>`;
    }
    const count = playerRows == null ? "" : ` &mdash; ${playerRows.length}`;
    return `
      <section>
        <h3>Connected players${count}</h3>
        ${rows}
      </section>`;
  }

  function footer(state) {
    const version = state && state.versionInfo ? state.versionInfo : versionInfo;
    const audioState = state && Object.prototype.hasOwnProperty.call(state, "audioInfo") ? state.audioInfo : audioInfo;
    const build = window.DWFUI.esc((version && version.build) || window.DFCAPTURE_BUILD || "unknown");
    let audio = "";
    if (audioState) {
      audio = audioState.remote
        ? `<div>Remote game audio: <b>shared with remote players</b> (set in dfhack-config/dfcapture.json).</div>`
        : `<div>Remote game audio: <b>local host only</b> (enable <b>audio_remote</b> in dfhack-config/dfcapture.json to share, then restart).</div>`;
    }
    return `<div class="host-panel-foot"><div>Build ${build}</div>${audio}</div>`;
  }

  function hostPanelMarkup(state) {
    // No `close: { glyph }` here: headerHtml renders the NATIVE close tile through artBtnHtml, keeping the
    // pinned `.host-panel-close` class and the [data-hp-act="close"] wire.
    const head = window.DWFUI.headerHtml({
      cls: "host-panel-head", titleTag: "h2", title: "Host settings", titleCls: "host-panel-title",
      close: { cls: "host-panel-close", dataset: { hpAct: "close" }, title: "Close" },
    });
    // `preserveKey` keeps the player's scroll position across the panel's 2 s refresh re-render.
    const body = `<div class="host-panel-sub">Controls only you, the host, can change.</div>
       ${pauseSection(state)}
       ${joinSection(state)}
       ${guardsSection(state)}
       ${playersSection(state)}
       ${footer(state)}`;
    return head + window.DWFUI.scrollHtml({ cls: "host-panel-scroll", preserveKey: "hostpanel" }, body);
  }

  function render() {
    if (!panel) return;
    panel.innerHTML = hostPanelMarkup();
    wire();
  }

  function wire() {
    panel.querySelectorAll("[data-hp-toggle]").forEach(el => {
      el.addEventListener("click", () => onToggle(el.dataset.hpToggle));
    });
    panel.querySelectorAll("[data-hp-act]").forEach(el => {
      el.addEventListener("click", ev => {
        ev.preventDefault();
        const act = el.dataset.hpAct;
        if (act === "close") return close();
        if (act === "pw-set") return onSetPassword();
        if (act === "pw-off") return onTurnOffPassword();
      });
    });
    const input = panel.querySelector("#hpPw");
    if (input) input.addEventListener("keydown", ev => {
      if (ev.key === "Enter") { ev.preventDefault(); onSetPassword(); }
    });
  }

  // ---- actions ------------------------------------------------------------------------------
  function onToggle(which) {
    if (which === "console") {
      if (!consoleCfg) return;
      const next = consoleCfg.enabled !== true;
      consoleCfg.enabled = next;   // optimistic; reconciled from the response
      render();
      api("POST", `/console-config?enabled=${next ? "on" : "off"}`).then(res => {
        consoleCfg = (res.status === 200 && res.json) ? res.json : consoleCfg;
        if (res.status === 403) consoleCfg.enabled = !next; // not the host tab after all
        if (window.DFWriteGuards) window.DFWriteGuards.refresh();
        render();
      });
      return;
    }
    if (!pauseCfg) return; // haven't loaded state yet
    const cur = which === "hostunpause" ? pauseCfg.hostUnpauseOnly : pauseCfg.autopause;
    const next = !cur;
    const param = which === "hostunpause" ? "hostunpause" : "autopause";
    // Optimistic flip for instant feedback; reconciled from the response.
    if (which === "hostunpause") pauseCfg.hostUnpauseOnly = next; else pauseCfg.autopause = next;
    render();
    api("GET", `/pause-config?${param}=${next ? "on" : "off"}`).then(res => {
      if (res.json) pauseCfg = res.json;
      render();
    });
  }

  function pwMsg(text, cls) {
    const el = panel && panel.querySelector("#hpPwMsg");
    if (el) { el.textContent = text; el.className = "host-panel-msg" + (cls ? " " + cls : ""); }
  }

  function postJoinPassword(body) {
    return fetch("/join-password", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    }).then(r => r.text().then(t => {
      let j; try { j = t ? JSON.parse(t) : null; } catch { j = null; }
      return { ok: r.ok, status: r.status, json: j };
    })).catch(() => ({ ok: false, status: 0, json: null }));
  }

  function handleJoinResult(res, successText) {
    if (res.ok) {
      pwMsg(successText, "ok");
      const input = panel && panel.querySelector("#hpPw");
      if (input) input.value = "";
      // Refresh authRequired so the status line + button labels update.
      return loadVersion().then(render);
    }
    if (res.status === 404) {
      joinRouteMissing = true;
      render();
      pwMsg("This host build can't change the password from the browser -- see below.", "err");
      return;
    }
    if (res.status === 403) { pwMsg("Host only -- only the host machine can change the password.", "err"); return; }
    pwMsg("Could not update the password (the host may be busy). Try again.", "err");
  }

  function onSetPassword() {
    const input = panel && panel.querySelector("#hpPw");
    const val = input ? input.value : "";
    if (!val || !val.trim()) { pwMsg("Enter a passphrase first.", "err"); return; }
    pwMsg("Saving…", "");
    postJoinPassword("password=" + encodeURIComponent(val))
      .then(res => handleJoinResult(res, "Join password updated. Friends will use the new passphrase."));
  }

  function onTurnOffPassword() {
    if (!window.confirm("Turn off the join password? Anyone who can reach the port will be able to join."))
      return;
    pwMsg("Turning off…", "");
    postJoinPassword("off=1")
      .then(res => handleJoinResult(res, "Join password turned off. The server is now open."));
  }

  // ---- loaders ------------------------------------------------------------------------------
  function loadPauseConfig() {
    return api("GET", "/pause-config").then(res => { if (res.json) pauseCfg = res.json; });
  }
  function loadPlayers() {
    return api("GET", "/diag").then(res => {
      players = (res.json && Array.isArray(res.json.players)) ? res.json.players : [];
    });
  }
  function loadVersion() {
    return api("GET", "/version").then(res => { if (res.json) versionInfo = res.json; });
  }
  function loadAudio() {
    return api("GET", "/sound-info").then(res => {
      audioInfo = (res.status === 200 && res.json) ? res.json : null; // 404 => route absent, hide
    });
  }

  function loadConsoleCfg() {
    return api("GET", "/console-config").then(res => {
      consoleCfg = (res.status === 200 && res.json) ? res.json : null; // 404 => old DLL, hide
    });
  }

  function refresh() {
    // Only the cheap, live-changing bits on the interval; static-ish version/audio load once.
    return Promise.all([loadPauseConfig(), loadPlayers()]).then(render);
  }

  // ---- open / close -------------------------------------------------------------------------
  function isOpen() { return !!backdrop && backdrop.classList.contains("open"); }

  function open() {
    if (!isHost()) return;      // hard gate: non-host never opens the panel
    ensureEls();
    backdrop.classList.add("open");
    render();                   // paint immediately from cache (or "loading…")
    Promise.all([loadVersion(), loadAudio(), loadConsoleCfg(), loadPauseConfig(), loadPlayers()]).then(render);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (isOpen()) refresh(); }, 2000);
  }

  function close() {
    if (backdrop) backdrop.classList.remove("open");
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  function toggle() { if (isOpen()) close(); else open(); }

  try { window.DwfModeStack?.register({
    id: "host-settings", flow: "global-overlays", depth: 80,
    active: isOpen,
    pop: () => { close(); return true; },
  }); } catch (err) { DwfErr.report("mode-stack.register", err); }

  // ---- Esc-menu entry, host only. ----
  // Asks the Esc menu for its OWN row grammar, so there is exactly one definition of what a row is.
  function escRowNode() {
    const holder = document.createElement("div");
    const cfg = {
      key: "host-settings", label: "Host settings",
      title: "Host-only controls: pause permissions, join password, connected players.",
    };
    if (window.DwfEscMenu && typeof window.DwfEscMenu.rowHtml === "function")
      holder.innerHTML = window.DwfEscMenu.rowHtml(cfg);
    else
      holder.innerHTML = window.DWFUI.plaqueBtnHtml({
        label: cfg.label, tone: "grey", cls: "esc-row",
        dataset: { escRow: cfg.key }, title: cfg.title,
      });
    return holder.firstElementChild;
  }

  function attachEscMenu(escEl) {
    try {
      if (!isHost() || !escEl) return;
      const rows = escEl.querySelector(".esc-rows");
      if (!rows || rows.querySelector('[data-esc-row="host-settings"]')) return;
      const btn = escRowNode();
      if (!btn) return;
      // Sit it just above "Settings"/"Return to game" (the two always-enabled rows).
      const settingsRow = rows.querySelector('[data-esc-row="settings"]');
      rows.insertBefore(btn, settingsRow || null);
      btn.addEventListener("click", ev => {
        ev.preventDefault();
        try { if (typeof window.closeEscMenu === "function") window.closeEscMenu(); }
        catch (err) { DwfErr.report("host-panel.esc-close", err); }
        open();
      });
    } catch (err) { DwfErr.report("host-panel.esc-attach", err); }
  }

  window.DwfHostPanel = { open, close, toggle, isOpen, attachEscMenu, isHost,
    storyMarkup: hostPanelMarkup,
    preparePreview: function () {} };
})();
