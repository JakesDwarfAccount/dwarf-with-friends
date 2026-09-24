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

(function (root) {
  "use strict";

  if (root.DWFUI && typeof root.DWFUI.require === "function") root.DWFUI.require("fortress-chrome",
    ["toolButtonHtml", "artBtnHtml", "plaqueBtnHtml", "iconHtml", "bitmapTextHtml", "rawHtml",
      "nativeCellRunsHtml"]);

  function n(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }

  // A native-art square button. The `square-button` class stays the pinned CSS/controller hook; the
  // BUTTON is DWFUI's and the ART is a real interface_map token instead of a Unicode stand-in.
  function sqArt(cfg) {
    const icon = root.DWFUI.iconHtml({
      sprite: cfg.sprite, size: cfg.size || 22, states: cfg.states,
      alt: cfg.ariaLabel || cfg.title,
    });
    return root.DWFUI.toolButtonHtml({
      id: cfg.id, cls: `square-button${cfg.cls ? " " + cfg.cls : ""}`, dataset: cfg.dataset,
      title: cfg.title, ariaLabel: cfg.ariaLabel, hidden: cfg.hidden,
      labelHtml: root.DWFUI.rawHtml("a native sprite tile, not text", icon),
    });
  }
  // DECLARED ART GAP. DEF-032: DF has no lobby, activity board, 3-D viewer or in-chrome console, so
  // there is no sprite to dress these four in; they keep their mark through the bitmap-text escape hatch.
  const SUPERSET_MARK = {
    lobby: "&#9787;", analytics: "&#128202;", world3d: "&#9638;", console: "&#8250;_",
  };
  const TOP_STOCKS = [
    ["food", "Food"],
    ["drink", "Drink"],
    ["seeds", "Seeds"],
    ["meat", "Meat"],
    ["fish", "Fish"],
    ["plant", "Plant"],
    ["other", "Other"],
  ];
  function sqSuperset(id, key, title, ariaLabel) {
    return root.DWFUI.toolButtonHtml({
      id, cls: "square-button", title, ariaLabel,
      labelHtml: root.DWFUI.rawHtml(
        "multiplayer superset with no native DF sprite: DF has no lobby / activity board / 3-D viewer / browser console",
        SUPERSET_MARK[key]),
    });
  }
  function stockCountText(value) {
    if (value == null || value === "") return "None";
    const raw = String(value).trim();
    if (raw === "None" || raw === "0" || raw === "~0") return "None";
    const count = Number(raw);
    if (Number.isFinite(count)) return count > 0 ? `~${count}` : "None";
    return raw;
  }

  function topbarMarkup(state) {
    const s = state || {};
    const text = value => root.DWFUI.bitmapTextHtml(value);
    const moods = Array.isArray(s.moods) ? s.moods.slice(0, 7) : [];
    while (moods.length < 7) moods.push(0);
    const stocks = s.stocks || {};
    const date = s.date || {};
    // BUTTON_STRESS_0..6 -- the seven real DF mood faces, painted by DWFUI instead of stamped over
    // the markup by the controller at boot.
    const moodCells = moods.map((count, index) =>
      `<span class="mood-cell">${root.DWFUI.iconHtml({ sprite: `BUTTON_STRESS_${index}`, size: 20, cls: "mood-icon", dataset: { moodIcon: index }, alt: `Stress level ${index}` })}<span class="mood-n">${text(n(count, 0))}</span></span>`).join("");
    return `
      <div class="fort-lines top-status-identity" data-dwf-status-zone="identity"><div id="fortName" data-dwf-row="0">${text(s.fortName || "Fortress")}</div><div id="siteName" data-dwf-row="1">${text(s.siteName || "Site")}</div><div id="rankName" data-dwf-row="2">${text(s.rankName || "Outpost")}</div></div>
      <div class="status-group top-status-population" id="popGroup" data-dwf-status-zone="population"><span class="mood-cell pop-cell"><span class="label">${text("Pop")}</span><span id="population" class="mood-n">${text(n(s.population, 0))}</span></span><div class="moods" id="moods">${moodCells}</div></div>
      ${root.DWFUI.plaqueBtnHtml({ cls: "top-button", dataset: { panel: "stocks", dwfRow: 1, dwfStatusZone: "stocks-label" }, label: "Stocks", title: "Stock levels and item management.\nHotkey: k" })}
      <div class="stock-counts" data-dwf-status-zone="resources">${TOP_STOCKS.map(([key, label]) => `<div class="status-group top-stock-cell" data-dwf-stock="${key}"><span class="label stock-${key}" data-dwf-row="0">${text(label)}</span><span id="${key}" class="stock-val" data-dwf-row="2">${text(stockCountText(stocks[key]))}</span></div>`).join("")}</div>
      <div class="moon top-status-weather" id="moon" data-dwf-status-zone="weather" data-dwf-cols="4" data-dwf-rows="3" title="Weather" aria-label="${root.DWFUI.esc(s.weather || "Weather")}"></div>
      <div class="fort-lines top-status-date" data-dwf-status-zone="date"><div data-dwf-row="0">${root.DWFUI.bitmapTextHtml(date.day || "1st", { id: "dateDay" })}${root.DWFUI.bitmapTextHtml(date.month || "Granite", { id: "dateMonth" })}</div><div data-dwf-row="1">${root.DWFUI.bitmapTextHtml(date.season || "Early Spring", { id: "dateSeason" })}</div><div data-dwf-row="2">${root.DWFUI.bitmapTextHtml(`Year ${n(date.year, 0)}`, { id: "dateYear" })}</div></div>
      <div class="topbar-controls" data-dwf-status-zone="controls">
        ${sqArt({ dataset: { action: "pause" }, sprite: "BUTTON_PAUSE_INACTIVE", title: "Pause", ariaLabel: "Pause" })}
        ${sqArt({ dataset: { action: "play" }, sprite: "BUTTON_PLAY_ACTIVE", title: "Play", ariaLabel: "Play" })}
        ${sqSuperset("lobbyBtn", "lobby", "Players / lobby", "Players and lobby")}
        ${sqSuperset("analyticsBtn", "analytics", "Fortress activity", "Fortress activity")}
        ${sqSuperset("world3dBtn", "world3d", "3D world viewer (Shift+V)", "3D world viewer")}
        ${sqSuperset("consoleBtn", "console", "Command console (DFHack)", "Command console")}
        ${sqArt({ id: "settingsBtn", sprite: "BUTTON_SETTINGS", title: "Settings", ariaLabel: "Settings" })}
        ${sqArt({ id: "helpBtn", sprite: "BUTTON_HELP", title: "Help", ariaLabel: "Help" })}
      </div>`;
  }

  // The cluster's frame is native sprite art on exactly TWO edges: a left border column with a
  // bottom-left cap, and a footer whose lower row is the only horizontal rule. No top edge, no right edge.
  const RIGHT_CHROME_FRAME_RUNS = [
    { token: "HOVER_RECTANGLE", grid: [3, 3], cell: [0, 1], col: 0, row: 0, repeat: 17, axis: "y" },
    { token: "HOVER_RECTANGLE", grid: [3, 3], cell: [0, 2], col: 0, row: 17 },
    { token: "HOVER_RECTANGLE", grid: [3, 3], cell: [1, 1], col: 1, row: 16, repeat: 24, axis: "x" },
    { token: "HOVER_RECTANGLE", grid: [3, 3], cell: [1, 2], col: 1, row: 17, repeat: 24, axis: "x" },
  ];
  function rightChromeFrameHtml() {
    return root.DWFUI.nativeCellRunsHtml({
      cls: "right-chrome-frame-art", cols: 25, rows: 18, runs: RIGHT_CHROME_FRAME_RUNS,
    });
  }

  // ---- 0077 R8: the z-strip is a three-state sliding DEPTH GAUGE ------------------------------
  //
  // Native paints two SCROLLBAR cap rows and then one of three per-row band cells between them --
  // above ground / the surface row / underground -- with the camera's z pinned to the strip's
  // vertical CENTRE, so the terrain slides past a fixed camera rather than a thumb sliding down a
  // track. The band tokens are DF's own SCROLLBAR_SKY / SCROLLBAR_GROUND / SCROLLBAR_UNDERGROUND
  // (2 cells wide, 1 row tall each), and the caps are the top and bottom rows of the 2x3 SCROLLBAR
  // table -- 0077 R8's `tex2[0x470]/[0x473]` and `[0x472]/[0x475]` under 0073's x-class-first
  // stride.
  //
  // *** PENDING REGISTER DECISION -- DO NOT REMOVE THE MARKER OR THE TICK. *** 0077's own §5
  // records that native draws NO thumb, marker, arrow or tick anywhere in this block, and files
  // that as a BEHAVIOUR DIVERGENCE for JT to rule on rather than a defect to fix. DWF's camera
  // marker and surface tick are shipped multiplayer behaviour (they also carry the OTHER players'
  // elevations, which native has no concept of), so the bands land UNDERNEATH them and both stay.
  // Whoever gets JT's ruling owns removing them, not this change.
  const Z_BAND_TOKENS = { sky: "SCROLLBAR_SKY", surface: "SCROLLBAR_GROUND", under: "SCROLLBAR_UNDERGROUND" };
  function zBandToken(rowZ, surfaceZ) {
    if (rowZ > surfaceZ) return Z_BAND_TOKENS.sky;
    if (rowZ === surfaceZ) return Z_BAND_TOKENS.surface;
    return Z_BAND_TOKENS.under;
  }
  // rows = the strip's height in native rows (caps included). cameraZ sits on the centre body row.
  function zStripRuns(rows, cameraZ, surfaceZ) {
    const total = Math.max(3, Math.round(rows) || 3);
    const camZ = n(cameraZ, 0), surfZ = n(surfaceZ, camZ);
    const runs = [
      { token: "SCROLLBAR", grid: [2, 3], cell: [0, 0], col: 0, row: 0 },
      { token: "SCROLLBAR", grid: [2, 3], cell: [1, 0], col: 1, row: 0 },
      { token: "SCROLLBAR", grid: [2, 3], cell: [0, 2], col: 0, row: total - 1 },
      { token: "SCROLLBAR", grid: [2, 3], cell: [1, 2], col: 1, row: total - 1 },
    ];
    const centre = (1 + (total - 2)) / 2;
    // Band runs carry their `grid` and `cell` EXPLICITLY: renderZStripBands writes JSON straight onto the
    // canvas and never re-enters nativeCellRunsHtml, so an implicit grid paints nothing live.
    for (let row = 1; row <= total - 2; row++)
      runs.push({
        token: zBandToken(camZ + Math.round(centre - row), surfZ),
        grid: [1, 1], cell: [0, 0], col: 0, row, repeat: 1, axis: "y",
      });
    return runs;
  }
  // Never read `--dwfui-cell-drawn-h`: it resolves to a `calc()` STRING and parseFloat returns NaN.
  // Floor the row count so the remainder sits under the bottom cap rather than painting a clipped band.
  function zStripRowsForHeight(trackHeightPx, doc) {
    const D = root.DWFUI;
    const d = doc || root.document;
    if (!D || typeof D.interfaceScale !== "function") return 0;
    const cellH = D.TOKENS.font.cell.h * D.interfaceScale(d) * D.uiZoom(d);
    const height = n(trackHeightPx, 0);
    if (!(height > 0) || !(cellH > 0)) return 0;
    return Math.max(3, Math.floor(height / cellH));
  }
  // Lives here, beside the markup builder, so the strip a player sees and the strip a test measures
  // cannot disagree about its shape.
  function zStripSpecJson(rows, cameraZ, surfaceZ) {
    const total = Math.max(3, Math.round(rows) || 3);
    return JSON.stringify({ cols: 2, rows: total, runs: zStripRuns(total, cameraZ, surfaceZ) });
  }
  function zStripArtHtml(rows, cameraZ, surfaceZ) {
    const total = Math.max(3, Math.round(rows) || 3);
    return root.DWFUI.nativeCellRunsHtml({
      id: "zScrollBands", cls: "z-strip-art", cols: 2, rows: total,
      runs: zStripRuns(total, cameraZ, surfaceZ),
    });
  }

  function minimapMarkup(state) {
    const s = state || {};
    const rightTool = (cfg, hoverId, hoverText) => sqArt(Object.assign({}, cfg, {
      dataset: Object.assign({}, cfg.dataset, {
        dwfHoverId: hoverId, dwfHoverReplaceMinimap: "true", dwfHoverText: hoverText,
      }),
    }));
    // Exact viewscreen_dwarfmodest right-tool order. The two left pair cells are zoom, not
    // elevation: z navigation belongs to the full-height strip below this 18-row cluster.
    return `
      ${rightChromeFrameHtml()}
      <div id="minimapToolCol">
        ${rightTool({ id: "recenterLocationsBtn", sprite: "RECENTER_HOTKEYS", title: "Recenter locations (saved camera bookmarks)", ariaLabel: "Recenter locations" }, "0x176", "Recenter locations (saved camera bookmarks)")}
        ${rightTool({ dataset: { recenter: "surface" }, sprite: "RECENTER_SURFACE", title: "Recenter on the surface at this location", ariaLabel: "Recenter on surface" }, "0x177", "Recenter on the surface at this location")}
        ${rightTool({ dataset: { recenter: "deepest" }, sprite: "RECENTER_DEEPEST", title: "Recenter on the deepest discovered area", ariaLabel: "Recenter on deepest discovered area" }, "0x178", "Recenter on the deepest discovered area")}
        <div class="tool-col-pair">
          ${rightTool({ id: "minimapZoomInBtn", dataset: { mapZoom: "in" }, sprite: "ZOOM_IN_ON", states: "zoomIn", title: "Zoom in ([)", ariaLabel: "Zoom in" }, "0x17f", "Zoom in ([)")}
          ${rightTool({ id: "liquidNumbersBtn", sprite: "LIQUID_NUMBERS_OFF", title: "Toggle liquid numerals", ariaLabel: "Toggle liquid numerals" }, "0x17d", "Toggle liquid numerals")}
        </div>
        <div class="tool-col-pair">
          ${rightTool({ id: "minimapZoomOutBtn", dataset: { mapZoom: "out" }, sprite: "ZOOM_OUT_ON", states: "zoomOut", title: "Zoom out (])", ariaLabel: "Zoom out" }, "0x180", "Zoom out (])")}
          ${rightTool({ id: "rampArrowsBtn", sprite: "RAMP_ARROWS_OFF", title: "Toggle ramp-down arrows", ariaLabel: "Toggle ramp-down arrows" }, "0x17e", "Toggle ramp-down arrows")}
        </div>
        <div class="right-chrome-supersets">${sqArt({ id: "followBtn", sprite: "RECENTER_REMOVE_OR_CLEAR", title: "Stop following / clear camera lock", ariaLabel: "Stop following or clear camera lock", hidden: true })}</div>
      </div>
      <div id="minimap" class="df-panel"><canvas id="minimapGrid" title="Click to center your camera here" aria-label="Fortress minimap"></canvas><div id="minimapToolHover" hidden aria-live="polite" aria-atomic="true"></div>${root.DWFUI.bitmapTextHtml(`Elevation ${n(s.elevation, 0)}`, { id: "elevation" })}</div>`;
  }

  function zScrollbarMarkup(state) {
    const s = state || {};
    const surface = Math.max(0, Math.min(100, n(s.surfacePercent, 12)));
    const camera = Math.max(0, Math.min(100, n(s.cameraPercent, 48)));
    // The row count is a function of window height, so the strip is re-emitted on resize; this default
    // keeps the art correct before the first /hud.
    return `<div id="zScrollTrack">${zStripArtHtml(n(s.zRows, 24), n(s.cameraZ, 0), n(s.surfaceZ, 0))}` +
      `<div id="zScrollSurfaceTick" class="z-tick" style="top:${surface}%"></div>` +
      `<div id="zScrollCamMarker" class="z-marker" style="top:${camera}%"></div></div>`;
  }

  function toolModeMarkup(label) {
    return `<div class="mode-label-plate${label ? " visible" : ""}" aria-live="polite">${root.DWFUI.esc(label || "")}</div>`;
  }

  function alertBadgeMarkup() {
    return `<span class="alert-badge-text" aria-hidden="true">${root.DWFUI.bitmapTextHtml("ALERT")}</span>`;
  }

  function fortressChromeMarkup(state) {
    const s = state || {};
    return `<div class="fortress-chrome-preview"><div id="leftBadges"><button type="button" class="badge alert-badge" aria-label="Announcements">${alertBadgeMarkup()}</button></div>${toolModeMarkup(s.toolMode || "")}<div id="topbar" class="df-panel">${topbarMarkup(s)}</div><div id="rightHud">${minimapMarkup(s)}</div><div id="zScrollbar">${zScrollbarMarkup(s)}</div></div>`;
  }

  // RULE: a control declared in index.html under #topbar / #rightHud / #zScrollbar / the ALERT badge MUST
  // also be emitted here. hydrate() overwrites their innerHTML; a guard cannot reveal what was never emitted.
  function hydrate() {
    const topbar = root.document?.getElementById("topbar");
    const rightHud = root.document?.getElementById("rightHud");
    const zScrollbar = root.document?.getElementById("zScrollbar");
    const alertBadge = root.document?.querySelector("#leftBadges .alert-badge");
    if (alertBadge) alertBadge.innerHTML = alertBadgeMarkup();
    if (topbar) topbar.innerHTML = topbarMarkup({});
    if (rightHud) rightHud.innerHTML = minimapMarkup({});
    if (zScrollbar) zScrollbar.innerHTML = zScrollbarMarkup({});
    // the clear-tracking X is only present while something is tracked (native's own rule for
    // this art). controls-placement re-evaluates it once the follow locks are wired.
    const follow = root.document?.getElementById("followBtn");
    if (follow) follow.hidden = true;
  }

  const api = { topbarMarkup, minimapMarkup, zScrollbarMarkup, zStripArtHtml, zStripRuns,
    zStripSpecJson, zStripRowsForHeight, toolModeMarkup, fortressChromeMarkup, hydrate };
  root.DwfInterfaceShell = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root.__DWF_STORY_MODE) hydrate();
})(typeof window !== "undefined" ? window : globalThis);
