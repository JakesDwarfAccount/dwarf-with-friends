// dwf - HOST SETTINGS panel (host-only point-and-click for the existing host controls)
//
// A single overlay panel that surfaces the controls only the HOST (the machine running Dwarf
// Fortress) should touch, making the console-only / URL-only host knobs point-and-click:
//   1. Pause permissions -- toggle hostUnpauseOnly (GET /pause-config?hostunpause=on|off) and
//      autopause-on-player-leave (?autopause=on|off), plus the live pause state / who paused.
//   2. Join password -- set / change / turn off from the UI (POST /join-password, host-only,
//      loopback-gated server-side). Dormant-graceful: if the route 404s (host not yet updated)
//      the panel shows the `capture-join-password` console fallback inline.
//   3. Connected players (read-only, no kick) -- name, connection count, last-activity, ping,
//      from the /diag payload the client already exposes.
//   4. Footer -- server build stamp (version gate) + a read-only remote-audio note when the
//      audio route (/sound-info) is present.
//
// HOST GATING is the SAME signal the pause host-unpause gate uses: DwfWS.isHost(), which
// tracks the server's per-connection loopback-peer flag from hello_ack (nothing a client can
// spoof). The entry row is injected into DF's Esc menu ONLY for the host (attachEscMenu below),
// so a spectator never even sees it. The server ALSO refuses a non-loopback POST /join-password
// (403) -- UI-hiding is defence-in-depth, not the only guard.
//
// Self-contained: its own injected <style> (no shared-CSS edit), no new polling loop except a
// light 2 s refresh while the panel is OPEN (torn down on close). Every route is optional --
// a missing/older DLL degrades to a hint, never a broken panel or console noise.
(function () {
  "use strict";

  // DWFUI contract -- see dwf-escmenu.js. Presence-guarded, but NOT throw-swallowing.
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("host-panel", ["headerHtml", "switchHtml", "plaqueBtnHtml", "rowHtml",
      "scrollHtml", "textInputHtml", "esc", "TOKENS"]);

  // Was a private escapeHtml shim. DWFUI.esc IS the shared escaper (it defers to the app's own
  // escapeHtml at call time and falls back to a local copy); a per-module copy is exactly the
  // duplication this wave exists to retire.
  const esc = s => window.DWFUI.esc(s);
  // The shared measured palette (F1). This module states NO colour of its own.
  const PAL = window.DWFUI.TOKENS.palette;

  function isHost() {
    try {
      return !!(window.DwfWS && typeof DwfWS.isHost === "function" && DwfWS.isHost());
    } catch (_) {
      return false;
    }
  }

  // Same-origin fetch that always carries the dfcap_auth cookie (set by the join flow). Resolves
  // to { ok, status, json } and NEVER throws -- callers branch on status (404 => host needs an
  // update; 403 => not the host; anything else => transient) so a dormant/older server can only
  // degrade the panel, never break it.
  function api(method, path) {
    return fetch(path, { method: method, credentials: "same-origin", cache: "no-store" })
      .then(r => r.text().then(t => {
        let j = null;
        try { j = t ? JSON.parse(t) : null; } catch (_) {}
        return { ok: r.ok, status: r.status, json: j };
      }))
      .catch(() => ({ ok: false, status: 0, json: null }));
  }

  // ---- styles (injected once) ---------------------------------------------------------------
  // R1 (drift guard): this block used to carry 49 HARD-CODED HEX LITERALS -- a private palette, and
  // one built on the SUPERSEDED gold (#d89b27 / #ffd45c) rather than the MEASURED native gold
  // (--dwfui-gold = #ffbf01, F1). Every colour now resolves through the `--dwfui-*` custom properties
  // declared once in dwf.css :root, which is the same source TOKENS.palette reads. No colour
  // is stated here. GEOMETRY stays -- this is the strangler seam (structure first, CSS consolidation
  // is a later wave); what is deleted is the private COLOUR TABLE, not the layout.
  //
  // R4: `.hp-sw` -- the verbatim 34x18 gold pill -- IS DELETED. It was the second copy of a control
  // DWFUI already owns; switchHtml's own `.dwfui-switch-track` now paints it (pauseSection stops
  // passing `trackCls`/`knob:false`, so the shared track+knob is what renders). One pill, one place.
  function ensureStyle() {
    if (document.getElementById("dfHostPanelStyle")) return;
    const st = document.createElement("style");
    st.id = "dfHostPanelStyle";
    st.textContent = `
      #hostPanelBackdrop{position:fixed;inset:0;z-index:120;display:none;
        background:rgba(0,0,0,.5)}
      #hostPanelBackdrop.open{display:block}
      #hostPanel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
        width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);
        background:var(--dwfui-surface);border:2px solid var(--dwfui-gold);
        box-shadow:0 8px 28px rgba(0,0,0,.6);
        padding:14px 16px;z-index:121;display:flex;flex-direction:column;
        font:12px/1.4 ui-monospace,Consolas,monospace;color:var(--dwfui-text-body)}
      #hostPanel .hp-scroll{flex:1 1 auto;min-height:0}
      #hostPanel h2{margin:0 0 2px;font-size:15px;color:var(--dwfui-gold);font-weight:700;letter-spacing:.5px}
      #hostPanel .hp-sub{color:var(--dwfui-text-secondary);font-size:11px;margin:0 0 12px}
      #hostPanel h3{margin:14px 0 6px;font-size:12px;color:var(--dwfui-gold);font-weight:700;
        border-bottom:1px solid var(--dwfui-gold-bevel-dark);padding-bottom:4px;letter-spacing:.5px}
      #hostPanel section:first-of-type h3{margin-top:2px}
      .hp-close{position:absolute;top:10px;right:12px;background:none;border:none;
        line-height:1;cursor:pointer;padding:2px 6px}
      .hp-toggle{display:flex;align-items:flex-start;gap:9px;cursor:pointer;padding:6px 3px}
      .hp-toggle:hover{background:var(--dwfui-hatch)}
      .hp-toggle.hp-disabled{opacity:.5;cursor:default}
      .hp-toggle.hp-disabled:hover{background:none}
      .hp-lbl b{color:var(--dwfui-gold);font-weight:700}
      .hp-lbl span{display:block;color:var(--dwfui-text-secondary);font-size:11px;margin-top:2px}
      .hp-state{margin:2px 0 6px;color:var(--dwfui-text-body)}
      .hp-state .hp-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;
        vertical-align:middle}
      .hp-note{color:var(--dwfui-text-secondary);font-size:11px;margin:8px 3px 2px}
      .hp-pw-row{display:flex;gap:6px;margin:6px 3px 4px;align-items:center}
      .hp-pw-row input{flex:1 1 auto;min-width:0;background:var(--dwfui-ink);
        border:1px solid var(--dwfui-gold-bevel-dark);
        border-radius:0;box-sizing:content-box;color:var(--dwfui-text-body);padding:5px 7px;
        font:12px ui-monospace,Consolas,monospace}
      .hp-pw-row input:focus{outline:none;border-color:var(--dwfui-gold)}
      .hp-msg{font-size:11px;margin:4px 3px 0;min-height:14px}
      .hp-msg.ok{color:var(--dwfui-text-good)}
      .hp-msg.err{color:var(--dwfui-text-warning)}
      .hp-fallback{margin:6px 3px 0;padding:8px;border:1px dashed var(--dwfui-gold-bevel-dark);
        background:var(--dwfui-ink);color:var(--dwfui-text-secondary);font-size:11px}
      .hp-fallback code{color:var(--dwfui-gold);background:var(--dwfui-surface);padding:1px 4px}
      .hp-players{width:100%;margin:4px 0 2px;display:flex;flex-direction:column}
      .hp-players .dwfui-row{border-bottom:1px solid var(--dwfui-hatch);
        font-variant-numeric:tabular-nums;gap:6px;padding:4px 6px}
      .hp-players .hp-head-row .dwfui-cell{color:var(--dwfui-text-secondary);font-weight:700;font-size:11px}
      .hp-players .dwfui-cell{flex:1 1 0;min-width:0}
      .hp-players .hp-num{text-align:right;flex:0 0 68px}
      .hp-players .hp-hidden-copy{display:none}
      .hp-players-empty{color:var(--dwfui-text-secondary);font-size:11px;padding:6px 3px}
      .hp-you{color:var(--dwfui-text-secondary);font-weight:400}
      .hp-foot{margin-top:14px;padding-top:8px;border-top:1px solid var(--dwfui-hatch);
        color:var(--dwfui-text-secondary);
        font-size:10px;line-height:1.5;word-break:break-all}
      .hp-foot b{color:var(--dwfui-text-secondary);font-weight:400}`;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- element scaffold ---------------------------------------------------------------------
  let backdrop = null, panel = null, refreshTimer = null;

  function ensureEls() {
    if (panel) return;
    ensureStyle();
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
    const by = esc(cfg.by || "host");
    // Colours come from the ONE palette (F1), never from a literal in this file.
    const stateColor = paused ? PAL.textWarning : PAL.textGood;
    const stateText = paused ? `Paused by ${by}` : "Running";
    const huo = cfg.hostUnpauseOnly === true;
    const ap = cfg.autopause === true;
    // R4: `trackCls: "hp-sw"` + `knob: false` OVERRODE the shared pill with this module's private
    // copy of it -- the markup was migrated but the CONTROL still rendered from local CSS. Dropping
    // both keys lets DWFUI's own `.dwfui-switch-track` / `.dwfui-switch-knob` paint it. Same wire
    // ([data-hp-toggle] on the root, read by wire()), one pill.
    const hostSwitch = window.DWFUI.switchHtml({ cls: `hp-toggle${huo ? " on" : ""}`, checked: huo, rootDataset: { hpToggle: "hostunpause" }, copyCls: "hp-lbl", labelTag: "b", label: "Only the host can unpause", sub: "Anyone can pause, but only you (the host machine) can resume. Keeps a spectator from unpausing your world." });
    const autoSwitch = window.DWFUI.switchHtml({ cls: `hp-toggle${ap ? " on" : ""}`, checked: ap, rootDataset: { hpToggle: "autopause" }, copyCls: "hp-lbl", labelTag: "b", label: "Auto-pause when a player leaves", sub: "Pause automatically a few seconds after the last connection of a player drops, so nothing runs unattended." });
    return `
      <section>
        <h3>Pause &amp; permissions</h3>
        <div class="hp-state"><span class="hp-dot" style="background:${stateColor}"></span>${esc(stateText)}</div>
        ${hostSwitch}
        ${autoSwitch}
        <div class="hp-note">These apply immediately. With an updated host they persist across restarts; on an older host they reset when Dwarf Fortress restarts.</div>
      </section>`;
  }

  function joinSection(state) {
    const version = state && Object.prototype.hasOwnProperty.call(state, "versionInfo") ? state.versionInfo : versionInfo;
    const routeMissing = state && typeof state.joinRouteMissing === "boolean" ? state.joinRouteMissing : joinRouteMissing;
    const known = version != null;
    const on = known && version.authRequired === true;
    const status = !known
      ? `<span style="color:${PAL.textSecondary}">checking…</span>`
      : (on ? `<span class="hp-dot" style="background:${PAL.textGood}"></span>On &mdash; a password is required to join`
            : `<span class="hp-dot" style="background:${PAL.textWarning}"></span>Off &mdash; anyone who can reach the port can join`);
    const fallback = routeMissing ? `
      <div class="hp-fallback">This host build can't change the password from the browser yet.
        In the Dwarf Fortress console (DFHack), run <code>capture-join-password &lt;passphrase&gt;</code>
        to set one, or <code>capture-join-password off</code> to turn it off.</div>` : "";
    // The passphrase stays a real DOM text input for caret/selection/IME behavior, but DWFUI owns
    // its editable-field structure. Its id, browser editing attributes, placeholder, and wire stay
    // unchanged; the pinned host-panel CSS preserves the existing square 1 px field appearance.
    const passwordInput = window.DWFUI.textInputHtml({
      id: "hpPw", autocomplete: "off", spellcheck: false,
      placeholder: on ? "New passphrase" : "Set a passphrase",
    });
    // The two ACTIONS are native text plaques -- grey to set/change, RED for the destructive
    // "turn off". The [data-hp-act] wire is byte-identical.
    const setBtn = window.DWFUI.plaqueBtnHtml({
      label: on ? "Change" : "Set", tone: "grey", cls: "hp-btn",
      dataset: { hpAct: "pw-set" }, title: on ? "Change the join password" : "Set a join password",
    });
    const offBtn = window.DWFUI.plaqueBtnHtml({
      label: "Turn off password", tone: "red", cls: "hp-btn hp-danger",
      dataset: { hpAct: "pw-off" }, disabled: !on,
      title: "Remove the join password -- anyone who can reach the port will be able to join",
    });
    return `
      <section>
        <h3>Join password</h3>
        <div class="hp-state">${status}</div>
        <div class="hp-pw-row">
          ${passwordInput}
          ${setBtn}
        </div>
        <div class="hp-pw-row" style="justify-content:flex-end">${offBtn}</div>
        <div class="hp-msg" id="hpPwMsg"></div>
        ${fallback}
      </section>`;
  }

  // W23: the DFHack-console host setting. It is the ONE remaining write-guard flag and the only one
  // the host may flip from here (POST /console-config, host-tab-only server-side). Every probe guard
  // has been retired (the last, squad_pos0, was verified live 2026-07-17 and removed), so the panel
  // shows just this policy switch.
  function guardsSection(state) {
    const cc = state && Object.prototype.hasOwnProperty.call(state, "consoleCfg") ? state.consoleCfg : consoleCfg;
    if (cc == null) return "";   // old DLL without the route: show nothing rather than a dead switch
    const on = cc.enabled === true;
    const consoleSwitch = window.DWFUI.switchHtml({
      cls: `hp-toggle${on ? " on" : ""}`, checked: on, rootDataset: { hpToggle: "console" },
      copyCls: "hp-lbl", labelTag: "b",
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
      rows = `<div class="hp-players-empty">loading…</div>`;
    } else if (!playerRows.length) {
      rows = `<div class="hp-players-empty">No players connected</div>`;
    } else {
      const self = state && typeof state.self === "string" ? state.self : (function () { try { return window.player || ""; } catch (_) { return ""; } })();
      // The raw <table> becomes DWFUI's TABLE-chassis row (rowHtml({chassis:'table', cells})) --
      // the multi-column native list grammar. Cells are RAW html because the name cell carries the
      // "(you)" marker; every user-supplied value in them is still esc()'d.
      const R = window.DWFUI.rowHtml;
      const cell = (html, cls) => ({ html: html, cls: cls });
      const head = R({ chassis: "table", cls: "hp-head-row", copyCls: "hp-hidden-copy",
        cells: [cell("Player"), cell("Conns", "hp-num"), cell("Ping", "hp-num"),
          cell("Last seen", "hp-num")] });
      const body = playerRows.slice().sort((a, b) =>
        String(a && a.player).localeCompare(String(b && b.player))).map(p => {
        const name = esc(p.player);
        const you = p.player === self ? ' <span class="hp-you">(you)</span>' : "";
        const conns = (typeof p.connections === "number") ? p.connections : "&mdash;";
        const ping = (typeof p.rttMs === "number" && p.rttMs >= 0) ? p.rttMs + " ms" : "&mdash;";
        const seen = fmtAge(p.lastInboundAgeMs);
        return R({ chassis: "table", copyCls: "hp-hidden-copy",
          dataset: { hpPlayer: p.player == null ? "" : String(p.player) },
          cells: [cell(name + you), cell(String(conns), "hp-num"), cell(String(ping), "hp-num"),
            cell(seen, "hp-num")] });
      }).join("");
      rows = `<div class="hp-players">${head}${body}</div>`;
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
    const build = esc((version && version.build) || window.DFCAPTURE_BUILD || "unknown");
    let audio = "";
    if (audioState) {
      audio = audioState.remote
        ? `<div>Remote game audio: <b>shared with remote players</b> (set in dfhack-config/dfcapture.json).</div>`
        : `<div>Remote game audio: <b>local host only</b> (enable <b>audio_remote</b> in dfhack-config/dfcapture.json to share, then restart).</div>`;
    }
    return `<div class="hp-foot"><div>Build ${build}</div>${audio}</div>`;
  }

  function hostPanelMarkup(state) {
    // `close: { glyph: "&times;" }` ROUTED AROUND artBtnHtml and emitted a raw button element whose
    // only content was the &times; character -- a Unicode stand-in for art we already own. Dropping
    // that one key is the whole fix (it is the family-wide escape hatch): headerHtml now
    // renders the NATIVE close tile (BUILDING_JOBS_REMOVE, self-framed) through artBtnHtml, keeps the
    // pinned `.hp-close` class, and keeps the [data-hp-act="close"] wire.
    const head = window.DWFUI.headerHtml({
      cls: "hp-head", titleTag: "h2", title: "Host settings", titleCls: "hp-title",
      close: { cls: "hp-close", dataset: { hpAct: "close" }, title: "Close" },
    });
    // #hostPanel's raw `overflow:auto` rendered the BROWSER-DEFAULT scrollbar -- the "very important"
    // F5 complaint. scrollHtml puts the region on the shared native bar. `preserveKey` keeps the
    // player's scroll position across the panel's 2 s refresh re-render (which previously threw them
    // back to the top of a long player list every two seconds).
    const body = `<div class="hp-sub">Controls only you, the host, can change.</div>
       ${pauseSection(state)}
       ${joinSection(state)}
       ${guardsSection(state)}
       ${playersSection(state)}
       ${footer(state)}`;
    return head + window.DWFUI.scrollHtml({ cls: "hp-scroll", preserveKey: "hostpanel" }, body);
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
    if (el) { el.textContent = text; el.className = "hp-msg" + (cls ? " " + cls : ""); }
  }

  function postJoinPassword(body) {
    return fetch("/join-password", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    }).then(r => r.text().then(t => {
      let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
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

  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && isOpen()) { ev.preventDefault(); ev.stopPropagation(); close(); }
  }, true);

  // ---- Esc-menu entry (host only) -----------------------------------------------------------
  // Called from dwf-escmenu.js's openEscMenu (one-line hook). Injects a "Host settings" row
  // into the menu's row list -- but ONLY for the host, so a spectator's Esc menu is unchanged.
  // *** THIS FUNCTION AND dwf-escmenu.js MOVE TOGETHER. *** It used to hand-build a
  // a raw `.esc-row` button element with createElement -- so migrating the Esc menu's seven rows to native
  // plaques WITHOUT touching this would have left ONE hand-built web button sitting among seven
  // native slabs, re-injected on every repaint. It now asks the Esc menu for its OWN row grammar
  // (DwfEscMenu.rowHtml -> DWFUI.plaqueBtnHtml), so there is exactly one definition of what an
  // Esc-menu row IS. The fallback keeps this module dormant-safe if escmenu.js never loaded.
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
        try { if (typeof window.closeEscMenu === "function") window.closeEscMenu(); } catch (_) {}
        open();
      });
    } catch (_) {}
  }

  window.DwfHostPanel = { open, close, toggle, isOpen, attachEscMenu, isHost, storyMarkup: hostPanelMarkup, preparePreview: ensureStyle };
})();
