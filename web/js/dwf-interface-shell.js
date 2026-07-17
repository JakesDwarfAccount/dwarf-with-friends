// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// SPDX-License-Identifier: AGPL-3.0-only

// Shared production markup for the persistent Steam-style fortress chrome. The live page hydrates
// its stable host elements from these builders before any controller captures DOM references;
// Parity Studio calls the same builders with deterministic HUD data.
(function (root) {
  "use strict";

  root.DWFUI.require("fortress-chrome",
    ["toolButtonHtml", "artBtnHtml", "plaqueBtnHtml", "iconHtml", "bitmapTextHtml", "rawHtml"]);

  function esc(value) { return root.DWFUI.esc(value == null ? "" : value); }
  function n(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }

  // A native-art square button. The `square-button` class stays the pinned CSS/controller hook; the
  // BUTTON is DWFUI's and the ART is a real interface_map token instead of a Unicode stand-in.
  function sqArt(cfg) {
    const icon = root.DWFUI.iconHtml({ sprite: cfg.sprite, size: cfg.size || 22, alt: cfg.ariaLabel || cfg.title });
    return root.DWFUI.toolButtonHtml({
      id: cfg.id, cls: `square-button${cfg.cls ? " " + cfg.cls : ""}`, dataset: cfg.dataset,
      title: cfg.title, ariaLabel: cfg.ariaLabel,
      labelHtml: root.DWFUI.rawHtml("a native sprite tile, not text", icon),
    });
  }
  // The five topbar buttons with NO native analog: DF is single-player, so it has no lobby, no
  // fortress-activity board, no 3-D viewer and no vote -- and its DFHack console is a separate
  // native window, not a fortress-chrome control. KEEP SUPERSETS, DRESS THEM NATIVE -- but there
  // is no DF sprite to dress them IN, and fabricating one would be inventing an identity.
  // They keep their mark, routed through the declared bitmap-text escape hatch, and are reported
  // as an ART GAP (they need a capture/asset decision, not a guess).
  const SUPERSET_MARK = {
    lobby: "&#9787;", analytics: "&#128202;", world3d: "&#9638;", vote: "&#9745;", console: "&#8250;_",
  };
  function sqSuperset(id, key, title, ariaLabel) {
    return root.DWFUI.toolButtonHtml({
      id, cls: "square-button", title, ariaLabel,
      labelHtml: root.DWFUI.rawHtml(
        "multiplayer superset with no native DF sprite: DF has no lobby / activity board / 3-D viewer / vote / browser console",
        SUPERSET_MARK[key]),
    });
  }

  function topbarMarkup(state) {
    const s = state || {};
    const moods = Array.isArray(s.moods) ? s.moods.slice(0, 7) : [];
    while (moods.length < 7) moods.push(0);
    const stocks = s.stocks || {};
    const date = s.date || {};
    // BUTTON_STRESS_0..6 -- the seven real DF mood faces, painted by DWFUI instead of stamped over
    // the markup by the controller at boot.
    const moodCells = moods.map((count, index) =>
      `<span class="mood-cell">${root.DWFUI.iconHtml({ sprite: `BUTTON_STRESS_${index}`, size: 20, cls: "mood-icon", dataset: { moodIcon: index }, alt: `Stress level ${index}` })}<span class="mood-n">${n(count, 0)}</span></span>`).join("");
    return `
      <div class="fort-lines"><div id="fortName">${esc(s.fortName || "Fortress")}</div><div id="siteName">${esc(s.siteName || "Site")}</div><div id="rankName">${esc(s.rankName || "Outpost")}</div></div>
      <div class="status-group" id="popGroup"><span class="mood-cell pop-cell"><span class="label">Pop</span><span id="population" class="mood-n">${n(s.population, 0)}</span></span><div class="moods" id="moods">${moodCells}</div></div>
      ${root.DWFUI.plaqueBtnHtml({ cls: "top-button", dataset: { panel: "stocks" }, label: "Stocks", title: "Stock levels and item management.\nHotkey: k" })}
      <div class="stock-counts">${[["food","Food"],["drink","Drink"],["seeds","Seeds"],["meat","Meat"],["fish","Fish"]].map(([key,label]) => `<div class="status-group hide-small"><span class="label stock-${key}">${label}</span><span id="${key}" class="stock-val">${esc(stocks[key] ?? "~0")}</span></div>`).join("")}</div>
      <div class="moon" id="moon" title="Weather" aria-label="${esc(s.weather || "Weather")}"></div>
      <div class="fort-lines"><div><span id="dateDay">${esc(date.day || "1st")}</span> <span id="dateMonth">${esc(date.month || "Granite")}</span></div><div id="dateSeason">${esc(date.season || "Early Spring")}</div><div>Year <span id="dateYear">${n(date.year, 0)}</span></div></div>
      <div class="topbar-controls">
        ${sqArt({ dataset: { action: "pause" }, sprite: "BUTTON_PAUSE_INACTIVE", title: "Pause", ariaLabel: "Pause" })}
        ${sqArt({ dataset: { action: "play" }, sprite: "BUTTON_PLAY_ACTIVE", title: "Play", ariaLabel: "Play" })}
        ${sqSuperset("lobbyBtn", "lobby", "Players / lobby", "Players and lobby")}
        ${sqSuperset("analyticsBtn", "analytics", "Fortress activity", "Fortress activity")}
        ${sqSuperset("world3dBtn", "world3d", "3D world viewer (Shift+V)", "3D world viewer")}
        ${sqSuperset("voteBtn", "vote", "Fortress vote", "Fortress vote")}
        ${sqSuperset("consoleBtn", "console", "Command console (DFHack)", "Command console")}
        ${sqArt({ id: "settingsBtn", sprite: "BUTTON_SETTINGS", title: "Settings", ariaLabel: "Settings" })}
        ${sqArt({ id: "helpBtn", sprite: "BUTTON_HELP", title: "Help", ariaLabel: "Help" })}
      </div>`;
  }

  function minimapMarkup(state) {
    const s = state || {};
    // The +/- elevation steppers are DF's own z-move controls; interface_map has no sprite for them
    // (they are keyboard/scroll actions in native), so they stay bitmap TEXT, not art.
    const moveZ = (delta, label, title) => root.DWFUI.toolButtonHtml({
      cls: "square-button", dataset: { moveZ: delta }, title, ariaLabel: title, label,
    });
    // B245: the column matches the native oracle (B243-oracle-native-icon.png) top-to-bottom:
    // RECENTER_HOTKEYS (the recenter-locations panel opener -- native's entry point; there is NO
    // vertical LOCATIONS tab in native), RECENTER_SURFACE, RECENTER_DEEPEST, then the two 16x24
    // pair rows. Every sprite cell is a COMPLETE native control (frame baked in): the buttons are
    // bare hosts (css #minimapToolCol .square-button), never a second gold box.
    //
    // #followBtn (clear player/unit camera tracking) is a multiplayer SUPERSET with no native
    // column slot; it wears native's own clear-tracking X (RECENTER_REMOVE_OR_CLEAR) and is
    // hidden while nothing is tracked -- it sits LAST so its appearance never shifts the native
    // five. `hidden` is real now: the CSS `[hidden]` rule beat was lost to `display:inline-grid`
    // before B245, which is why the owner saw a dead off-centre red X in the top slot.
    return `
      <div id="minimapToolCol">
        ${sqArt({ id: "recenterLocationsBtn", sprite: "RECENTER_HOTKEYS", title: "Recenter locations (saved camera bookmarks)", ariaLabel: "Recenter locations" })}
        ${sqArt({ dataset: { recenter: "surface" }, sprite: "RECENTER_SURFACE", title: "Recenter on the surface at this location", ariaLabel: "Recenter on surface" })}
        ${sqArt({ dataset: { recenter: "deepest" }, sprite: "RECENTER_DEEPEST", title: "Recenter on the deepest discovered area", ariaLabel: "Recenter on deepest discovered area" })}
        <div class="tool-col-pair">${moveZ("1", "+", "Up one elevation")}${sqArt({ id: "liquidNumbersBtn", sprite: "LIQUID_NUMBERS_OFF", title: "Toggle liquid numerals", ariaLabel: "Toggle liquid numerals" })}</div>
        <div class="tool-col-pair">${moveZ("-1", "-", "Down one elevation")}${sqArt({ id: "rampArrowsBtn", sprite: "RAMP_ARROWS_OFF", title: "Toggle ramp-down arrows", ariaLabel: "Toggle ramp-down arrows" })}</div>
        ${sqArt({ id: "followBtn", sprite: "RECENTER_REMOVE_OR_CLEAR", title: "Stop following / clear camera lock", ariaLabel: "Stop following or clear camera lock" })}
      </div>
      <div id="minimap" class="df-panel"><canvas id="minimapGrid" title="Click to center your camera here" aria-label="Fortress minimap"></canvas><div id="elevation">Elevation ${n(s.elevation, 0)}</div></div>`;
  }

  function zScrollbarMarkup(state) {
    const s = state || {};
    const surface = Math.max(0, Math.min(100, n(s.surfacePercent, 12)));
    const camera = Math.max(0, Math.min(100, n(s.cameraPercent, 48)));
    return `<div id="zScrollTrack"><div id="zScrollSurfaceTick" class="z-tick" style="top:${surface}%"></div><div id="zScrollCamMarker" class="z-marker" style="top:${camera}%"></div></div>`;
  }

  function toolModeMarkup(label) {
    return `<div class="mode-label-plate${label ? " visible" : ""}" aria-live="polite">${esc(label || "")}</div>`;
  }

  function fortressChromeMarkup(state) {
    const s = state || {};
    return `<div class="fortress-chrome-preview"><div id="leftBadges"><button type="button" class="badge alert-badge" aria-label="Announcements"><span class="alert-badge-text" aria-hidden="true">ALERT</span></button></div>${toolModeMarkup(s.toolMode || "")}<div id="topbar" class="df-panel">${topbarMarkup(s)}</div><div id="rightHud">${minimapMarkup(s)}</div><div id="zScrollbar">${zScrollbarMarkup(s)}</div></div>`;
  }

  // hydrate() OVERWRITES the innerHTML of #topbar / #rightHud / #zScrollbar. Anything index.html
  // declares inside those hosts and this file does NOT re-emit is DESTROYED at boot -- silently,
  // before any player or any source-reading test can see it.
  //
  // That is not hypothetical. It ate the DFHack console button (#consoleBtn, WT26): index.html
  // shipped it, hydrate() blew it away, csInstallButton() then found nothing to hook, and the
  // console became unreachable in the browser while `dfConsole.open()` still worked perfectly from
  // the JS console -- so every source-level test stayed green and the feature was dead. W23 later
  // built a host-flag reveal (csApplyGuard flips #consoleBtn's display) ON TOP of a button that no
  // longer existed, and recorded in its merge note that "index.html ships a live one". It did. The
  // SCREEN did not. `screen_truth_browser_test.mjs --case=console-reachability` is the cell that
  // catches this, and it asserts against the real hydrated DOM for exactly this reason.
  //
  // RULE: a control declared in index.html under one of these hosts MUST also be emitted here.
  // Visibility may be owned elsewhere (the console panel's host guard hides/reveals #consoleBtn);
  // EXISTENCE is owned here, and a guard cannot reveal an element that was never emitted.
  function hydrate() {
    const topbar = root.document?.getElementById("topbar");
    const rightHud = root.document?.getElementById("rightHud");
    const zScrollbar = root.document?.getElementById("zScrollbar");
    if (topbar) topbar.innerHTML = topbarMarkup({});
    if (rightHud) rightHud.innerHTML = minimapMarkup({});
    if (zScrollbar) zScrollbar.innerHTML = zScrollbarMarkup({});
    // The vote button stays hidden until dwf-vote.js finds the vote routes (unchanged wire;
    // toolButtonHtml has no inline-style slot, so the initial hidden state is set here).
    const vote = root.document?.getElementById("voteBtn");
    if (vote) vote.style.display = "none";
    // B245: the clear-tracking X is only present while something is tracked (native's own rule for
    // this art). controls-placement re-evaluates it once the follow locks are wired.
    const follow = root.document?.getElementById("followBtn");
    if (follow) follow.hidden = true;
  }

  const api = { topbarMarkup, minimapMarkup, zScrollbarMarkup, toolModeMarkup, fortressChromeMarkup, hydrate };
  root.DwfInterfaceShell = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root.__DWF_STORY_MODE) hydrate();
})(typeof window !== "undefined" ? window : globalThis);
