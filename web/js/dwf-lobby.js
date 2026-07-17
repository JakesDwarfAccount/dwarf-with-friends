// dwf - WT03(a) multiplayer lobby panel (WP-A)
//
// A toggleable topbar panel listing every CONNECTED player in their color, with ping and an
// idle marker -- the "who's here" surface the owner asked for ("player count + names in their colors;
// show player ping"). Data source is the SAME roster the elevation triangles + minimap
// viewboxes read: window.DwfPresence (fed at the ~30 Hz AUX rate from dwf-tiles.js).
// NO new polling loop -- /diag stays diagnostics-only. Colors come from the ONE canonical
// helper (window.DwfTiles.playerColor) so a lobby row matches that player's presence
// cursor / elevation triangle / minimap box exactly.
//
// The pause line ("Running" / "Paused by guest") is populated opportunistically from hud.paused
// here (WP-A); WP-B's {"type":"pause"} broadcast upgrades the text to include the actor via
// window.DwfLobby.setPauseText(...).
(function () {
  "use strict";

  // DWFUI contract -- see dwf-escmenu.js. Presence-guarded (this file's pure half is required
  // by a Node harness with no DWFUI), but NOT throw-swallowing.
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("lobby", ["headerHtml", "rowHtml", "plaqueBtnHtml", "scrollHtml", "esc"]);

  // Was a private escapeHtml shim -> the shared DWFUI escaper.
  function esc(s) {
    return (typeof DWFUI !== "undefined" && DWFUI.esc)
      ? DWFUI.esc(s)
      : String(s == null ? "" : s).replace(/[&<>"]/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function colorFor(name) {
    try {
      if (window.DwfTiles && typeof DwfTiles.playerColor === "function")
        return DwfTiles.playerColor(name).fill;
    } catch (_) {}
    return "#8cf";
  }
  function finiteRosterNumber(v) { return (typeof v === "number" && Number.isFinite(v)) ? v : null; }
  // A tab that hasn't cleared the join gate connects under dwf-core.js's session-key fallback --
  // crypto.randomUUID() or `p-<time36>-<rand36>` -- and the server roster echoes that key as the
  // name. Raw session keys must never render as a player name (they overflow AND identify nobody):
  // they become "Guest <first-4>" with the full key kept on the title/dataset so follow/jump still
  // address the real roster entry.
  const ANON_NAME_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|p-[0-9a-z]+-[0-9a-z]+)$/i;
  function lobbyDisplayName(name) {
    const raw = String(name == null ? "" : name);
    if (!ANON_NAME_RE.test(raw)) return { text: raw, anon: false };
    return { text: "Guest " + raw.replace(/^p-/, "").slice(0, 4), anon: true };
  }
  function lobbyConnectionLabel(p) {
    const rtt = finiteRosterNumber(p && (p.rttMs ?? p.rtt));
    if (rtt !== null && rtt >= 0) return { text: `${Math.round(rtt)} ms`, title: "Measured websocket round trip" };
    const age = finiteRosterNumber(p && p.lastInboundAgeMs);
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
  function cameraFor(p) {
    if (!p) return null;
    const hasCamShape = p.camx !== undefined || p.camy !== undefined || p.camz !== undefined;
    let x = finiteRosterNumber(p.camx), y = finiteRosterNumber(p.camy), z = finiteRosterNumber(p.camz);
    if (hasCamShape) {
      if (x === null || y === null || z === null) return null;
    } else {
      x = finiteRosterNumber(p.x); y = finiteRosterNumber(p.y); z = finiteRosterNumber(p.z);
      if (x === null || y === null || z === null) return null;
    }
    return { x, y, z };
  }

  // Stable order: self first, then named players A-Z (case-insensitive on the DISPLAY name),
  // then unnamed pre-join guests last -- they identify nobody yet, so they never displace a
  // real name from the top of the list.
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
      const col = p.color || colorFor(rawName);
      const idle = p.idle ? " lobby-idle" : "";
      const ping = lobbyConnectionLabel(p);
      const cam = cameraFor(p);
      const canSpectate = !!cam && !p.self;
      const spectate = (typeof window !== "undefined" && window.DwfSpectate) || null;
      const st = options.followName !== undefined
        ? { following: !!options.followName, name: String(options.followName || "") }
        : (spectate && typeof spectate.getState === "function" ? spectate.getState() : null);
      const following = !!(st && st.following && st.name === rawName);
      // Host marking: the server only tells each CLIENT whether it itself is the host
      // (hello_ack.isHost -> DwfWS.isHost()); the roster carries no host field yet. So the tag is
      // data-driven -- p.host/p.isHost when a future wire field lands, else self+isHost() -- and
      // simply absent when the fact isn't known. Never guessed.
      const selfIsHost = !!(p.self && typeof window !== "undefined" && window.DwfWS &&
        typeof window.DwfWS.isHost === "function" && window.DwfWS.isHost());
      const isHost = !!(p.host || p.isHost || selfIsHost);
      const nameTitle = dn.anon ? `${rawName} (hasn't picked a name yet)` : rawName;
      const baseTitle = canSpectate ? `Click to jump to ${dn.text || "player"}` : (p.self ? "This is you" : "Camera not available yet");
      const rowTitle = `${baseTitle}. ${ping.title}`;
      const followTitle = following ? `Stop following ${dn.text || "player"}` : `Follow ${dn.text || "player"}'s camera`;
      // The roster row is DWFUI's TABLE-chassis row and the Follow control is a NATIVE PLAQUE
      // (grey -> green when engaged). Every hook the pointerdown delegation in boot() reads --
      // [data-lobby-player] on the row, [data-lobby-follow] on the control, .lobby-jumpable for the
      // jump test, and `disabled` when no camera is known -- is carried through unchanged.
      // Datasets carry the RAW roster name (datasetAttrs escapes for HTML): pre-escaping it here
      // made getAttribute() return the entity-encoded form, which can never match a roster name
      // containing & or quotes, silently breaking follow/jump for those players.
      const follow = window.DWFUI.plaqueBtnHtml({
        label: following ? "Stop" : "Follow",
        tone: following ? "green" : "grey",
        cls: `lobby-follow${following ? " active" : ""}`,
        dataset: { lobbyFollow: rawName },
        disabled: !canSpectate,
        title: followTitle,
      });
      // SELF ROW: you cannot follow yourself, so that fixed action column carries a RENAME
      // control instead of a dead disabled "Follow" plaque. It is a DWFUI plaque (no hand-built
      // control -- dwf-lobby stays handBuilt=0), and boot()'s pointerdown delegation routes
      // [data-lobby-rename] to dwf-join's rename dialog (same input + validation as the join card).
      // The actual rename RE-BROADCASTS via a WS control message so every other roster + your
      // cursor label update -- a local relabel alone is the documented __dwfAdoptName trap.
      const rename = p.self ? window.DWFUI.plaqueBtnHtml({
        label: "Rename",
        tone: "grey",
        cls: "lobby-rename",
        dataset: { lobbyRename: rawName },
        title: "Change your display name (others will see it)",
      }) : null;
      // Column grammar (fixed; the NAME cell is the only flexible one and clips with an
      // ellipsis, so no name length can ever push the ping/follow columns or overlap them):
      //   [swatch = cursor color] [name (+you/HOST tags)] [connection] [follow]
      return window.DWFUI.rowHtml({
        chassis: "table",
        cls: `lobby-row${idle}${canSpectate ? " lobby-jumpable" : " lobby-no-camera"}`,
        dataset: { lobbyPlayer: rawName },
        title: rowTitle,
        copyCls: "lobby-copy",
        cells: [
          { html: `<span class="lobby-swatch" style="background:${esc(col)}" title="Cursor color on the map"></span>`, cls: "lobby-swatch-cell" },
          {
            html: `<span class="lobby-name${dn.anon ? " lobby-anon" : ""}" style="color:${esc(col)}" title="${esc(nameTitle)}">${esc(dn.text)}</span>` +
              (p.self ? '<span class="lobby-you" title="This is you">(you)</span>' : "") +
              (isHost ? '<span class="lobby-host" title="Host: runs the fort">HOST</span>' : ""),
            cls: "lobby-name-cell",
          },
          { html: `<span class="lobby-ping" title="${esc(ping.title)}">${esc(ping.text)}</span>`, cls: "lobby-ping-cell" },
          { html: rename || follow, cls: "lobby-follow-cell" },
        ],
      });
    }).join("");
  }

  function lobbyPanelMarkup(options) {
    options = options || {};
    const roster = sortRoster(Array.isArray(options.roster) ? options.roster.slice() : []);
    const rows = lobbyRowsHtml(roster, options);
    // `.lobby-rows` was a raw `overflow-y:auto` region -> the BROWSER-DEFAULT scrollbar (the F5
    // complaint). scrollHtml puts it on the native bar; the `.lobby-rows` class is passed straight
    // through, so render()'s `querySelector(".lobby-rows")` still resolves the same element.
    const paused = !/^running$/i.test(String(options.pauseText || "Running"));
    return window.DWFUI.headerHtml({ tag: "h3", titleTag: "span", titleCls: "lobby-count", title: `Players - ${roster.length}`, close: false }) +
      `<div class="lobby-status${paused ? " lobby-status-paused" : ""}">` +
      '<span class="lobby-status-dot" aria-hidden="true"></span>' +
      `<span class="lobby-pause">${esc(options.pauseText || "Running")}</span></div>` +
      window.DWFUI.scrollHtml({ cls: "lobby-rows", ariaLabel: "Connected players" },
        rows || '<div class="lobby-empty">No players connected</div>');
  }

  let panel = null, btn = null, pauseText = "Running";

  function ensurePanel() {
    if (panel) return panel;
    panel = document.getElementById("lobbyPanel");
    return panel;
  }

  // WT07 M5: build the persistent shell once. h3 (the framework drag handle) and the
  // framework-appended X survive the ~30 Hz roster re-renders because only .lobby-count,
  // .lobby-pause, and .lobby-rows are updated in place.
  // R5: the empty raw-html title slot was a BYPASS of the bitmap-text channel (the drift guard's only
  // R5 hit in this family). The header's title is the plain `title` field now; render() still
  // overwrites .lobby-count imperatively at roster rate, a deliberate perf choice, not debt.
  function ensureShell(el) {
    if (el.querySelector(".lobby-rows")) return;
    el.innerHTML =
      window.DWFUI.headerHtml({ tag: "h3", titleTag: "span", titleCls: "lobby-count", title: "", close: false }) +
      '<div class="lobby-status"><span class="lobby-status-dot" aria-hidden="true"></span><span class="lobby-pause"></span></div>' +
      window.DWFUI.scrollHtml({ cls: "lobby-rows", ariaLabel: "Connected players" }, "");
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
      try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("lobby", true); } catch (_) {}
    }
  }
  function close() {
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("lobby", false); } catch (_) {}
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
      // B60: engage on POINTERDOWN, not click. The roster feeds render() at ~30 Hz, and every
      // render replaces this panel's innerHTML -- which detaches the Follow button the user just
      // pressed. A native "click" only fires when pointerdown AND pointerup land on the same
      // still-attached element, so a re-render between them SWALLOWS the click and the follow
      // never engages ("click it a bunch to work"). pointerdown is dispatched synchronously at
      // press, before any async re-render can detach the target, so ONE press engages reliably.
      // The action is bound to pointerdown ONLY (never also click) -- binding both would toggle
      // twice per physical click and net back to off.
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
          } catch (_) {}
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
    // WT07 M5: movable + X via the shared framework. This is the scaled-panel proof case --
    // #lobbyPanel lives inside #hud, so its drag/clamp math must divide by the ancestor's
    // --ui-scale zoom (framework effectiveZoom walk-up). Geometry persists, not open-state.
    // The private Escape listener is deleted here: DFPanelFrame.escCloseTopmost() (via the
    // controls-placement cascade) now owns close-topmost, so Esc backs out one layer at a time.
    // Build the persistent shell BEFORE registering so the framework adopts this real <h3> as the
    // drag handle. Registering first would make attach() find no h3, inject a throwaway .pf-head,
    // and the first render()'s ensureShell would then wipe that head + its X + drag binding.
    if (panel) ensureShell(panel);
    // Move-only + content-sized (B134): the framework never writes inline width/height here, so
    // the panel's box comes from #lobbyPanel's CSS -- 288px wide (a truncated name keeps ~14
    // readable characters beside the fixed connection + Follow columns) with a max-height that
    // makes .lobby-rows scroll instead of the panel outgrowing the viewport.
    if (panel && window.DFPanelFrame) window.DFPanelFrame.register({
      key: "lobby", el: () => panel, title: "Players",
      headSel: "h3", closable: true, persistOpen: false,
      defaultPos: (vw, vh) => ({ anchor: "tr", x: 212, y: 52, w: 288, h: 264 }),
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

  // Public seam: WP-B's pause broadcast calls this to show "Paused by guest"; WP-A wires it from
  // hud.paused (renderHud) as a plain Running/Paused until then.
  window.DwfLobby = {
    open, close, toggle, isOpen,
    storyMarkup: lobbyPanelMarkup,
    // The ONE canonical anonymizer for raw session-key roster names (see lobbyDisplayName /
    // ANON_NAME_RE above). Every on-map presence surface (cursor labels, minimap viewbox chips,
    // z-scrollbar tooltips, follow-cam banner) resolves display text through THIS so a guest reads
    // "Guest 1665" identically everywhere; the raw key stays in the roster for follow/jump/color.
    displayName: lobbyDisplayName,
    // All lobby styling lives in web/css/dwf.css (the ONE stylesheet Parity Studio also loads);
    // the runtime <style> injection this seam used to perform kept a second, divergent copy of
    // the row layout. The seam stays because stories.js calls it before rendering.
    preparePreview() {},
    setPauseText(text) { pauseText = String(text || "Running"); if (isOpen()) render(); },
  };

  if (!window.__DWF_STORY_MODE) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})();
