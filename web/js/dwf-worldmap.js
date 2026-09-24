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

// ---- DF's World screen (Shift+Y). A full-screen takeover: it owns #worldScreen, not #clientPanel. ----

  let worldMapData = null;
  let worldScreenOpenState = false;
  let worldPanelMode = null; // null | civs | missions | news | reports
  let worldSelectedCivId = -1;
  let worldHoverSiteId = null;  // null = the pointer is not resting on a world tile: no card at all
  let worldReportsView = "list"; // list | playback | rumour
  // The region centre, in world tiles (ledger 0084 R13). null until the payload lands and we can
  // centre on the fort; from then on it is whatever the drag/step pan last computed.
  let worldViewCentre = null;
  let worldPanAnchor = null;    // non-null only while a drag native would have accepted is in flight
  let worldPanMoved = false;    // did this gesture actually pan? a panning gesture is not a click
  // Per-tab scroll state (0084 R3: every tab press resets ITS OWN pair, and nothing else's).
  let worldTabState = worldInitialTabState();

  async function openWorldMapPanel() {
    if (typeof window.clearBuildPlacement === "function") window.clearBuildPlacement(false);
    if (typeof window.closeClientPanel === "function") window.closeClientPanel();
    if (typeof window.closeSelection === "function") window.closeSelection();
    if (typeof window.setActiveToolbar === "function") window.setActiveToolbar("worldmap");
    worldScreenOpenState = true;
    worldPanelMode = null;
    worldSelectedCivId = -1;
    ensureWorldScreenEl().classList.add("open");
    renderWorldScreenShell("Loading world map...");
    try {
      worldMapData = await globalThis.fortFetchJson(
        `/world-map?player=${encodeURIComponent(globalThis.playerName)}&t=${Date.now()}`);
    } catch (err) {
      worldMapData = { error: err.message || "unavailable" };
    }
    renderWorldScreenShell();
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("world");
  }

  function worldScreenOpen() { return worldScreenOpenState; }

  function closeWorldScreen() {
    worldScreenOpenState = false;
    worldPanelMode = null;
    worldSelectedCivId = -1;
    worldHoverSiteId = null;
    worldReportsView = "list";
    worldViewCentre = null;   // a reopened world screen re-centres on the fort
    worldPanAnchor = null;
    worldPanMoved = false;
    worldTabState = worldInitialTabState();
    missionsData = null;      // a reopened Missions panel re-reads DF; it never shows a stale
    missionsSelectedId = -1;
    resetMissionFlow();      // roster of who is away.
    const el = document.getElementById("worldScreen");
    if (el) { el.classList.remove("open"); el.innerHTML = ""; }
    if (typeof window.setActiveToolbar === "function") window.setActiveToolbar(null);
    const view = document.getElementById("view");
    if (view) {
      try { view.focus({ preventScroll: true }); }
      catch { return; }
    }
  }

  // R1 DEFERRAL, DELIBERATE. WORLD_SITE_COLORS + WORLD_TERRAIN_COLORS are the only two hex tables
  // left in this module, and they are NOT DOM chrome: they are raster data->colour maps consumed by
  // canvas ctx.fillStyle in drawWorldCanvas (a biome/site palette, not a button or a border). Their
  // correct home is a named biome palette under DWFUI.TOKENS.palette -- but dwf-ui-components.js
  // is LOCKED to this lane, so there is nowhere legal to put them, and inventing a second private
  // palette here would be strictly worse. They stay, and the drift baseline keeps its 2 R1 entries
  // for this file. Reported in the closeout as a foundation-owned follow-up.
  const WORLD_SITE_COLORS = {
    PlayerFortress: "#ffd54f", Fortress: "#b0bec5", DarkFortress: "#8e24aa",
    Town: "#66bb6a", MountainHalls: "#a1887f", ForestRetreat: "#43a047",
    Cave: "#6d4c41", Camp: "#bcaaa4", Monument: "#90a4ae",
  };

  function worldSiteColor(type, own) {
    if (own) return "#ff5252";
    return WORLD_SITE_COLORS[type] || "#78909c";
  }

  // Biome char -> colour. The alphabet is classified server-side; an unknown char draws nothing.
  const WORLD_TERRAIN_COLORS = {
    "~": "#274b6e", // ocean (salt water)
    "l": "#356a8a", // lake / fresh water
    "^": "#6b5f50", // mountain
    "T": "#2f5a2c", // forest (heavy vegetation)
    ".": "#4e7638", // grassland / light vegetation
    "d": "#b9a566", // desert (arid, sparse vegetation)
    "n": "#6d6a53", // barren / rock
    "f": "#3f5f3a", // wetland / marsh (fallback greenish)
  };
  function worldTerrainColor(ch) {
    return WORLD_TERRAIN_COLORS[ch] || "";
  }

  // terrain: { w, h, step, rows:["<w chars>", ...] } with rows.length === h; null when absent or malformed.
  function decodeWorldTerrain(terrain) {
    if (!terrain || typeof terrain !== "object") return null;
    const rows = Array.isArray(terrain.rows) ? terrain.rows : null;
    const w = Number(terrain.w), h = Number(terrain.h);
    const step = Math.max(1, Number(terrain.step) || 1);
    if (!rows || !rows.length) return null;
    if (!(w > 0) || !(h > 0)) return null;
    if (rows.length !== h) return null;
    return { w, h, step, rows };
  }

  // NOT the screen's transform: native's world map is a viewport at a fixed pitch, not a fit-to-frame
  // thumbnail. Kept for the drag-free fallback and the offline fixture callers.
  function worldMapLayout(worldW, worldH, cssW, cssH) {
    const w = Math.max(1, Number(worldW) || 1);
    const h = Math.max(1, Number(worldH) || 1);
    const cw = Math.max(1, Number(cssW) || 1);
    const ch = Math.max(1, Number(cssH) || 1);
    const scale = Math.min(cw / w, ch / h);
    return { scale, ox: (cw - w * scale) / 2, oy: (ch - h * scale) / 2 };
  }

  // ---- Pan model: centre = anchor_centre - trunc((mouse - anchor_mouse) / 16), clamped to the world. ----
  // ABSOLUTE from the anchor, never incremental: an incremental form truncates every sub-16px move to zero.
  const WORLD_PAN_PX_PER_TILE = 16;

  // C's integer division truncates TOWARD ZERO. Math.floor does not (it floors toward -Infinity),
  // and the two disagree for every negative sub-tile delta -- i.e. for half of every drag.
  function worldPanTrunc(value) {
    const n = Number(value) || 0;
    const truncated = n < 0 ? Math.ceil(n) : Math.floor(n);
    return truncated === 0 ? 0 : truncated;   // Math.ceil(-0.9) is -0; C's truncation is not
  }

  function worldClampCentre(x, y, worldW, worldH) {
    const w = Math.max(1, Number(worldW) || 1);
    const h = Math.max(1, Number(worldH) || 1);
    const cx = Math.min(w - 1, Math.max(0, Math.round(Number(x) || 0)));
    const cy = Math.min(h - 1, Math.max(0, Math.round(Number(y) || 0)));
    return { x: cx, y: cy };
  }

  // null when native would refuse the drag: a refused begin is no drag at all, so a later move must not pan.
  function worldPanBegin(press) {
    const p = press || {};
    if (p.tracking === false) return null;
    const port = p.port || {};
    const left = Number(port.left) || 0, top = Number(port.top) || 0;
    const width = Number(port.width) || 0, height = Number(port.height) || 0;
    const mx = Number(p.mouseX), my = Number(p.mouseY);
    if (!Number.isFinite(mx) || !Number.isFinite(my)) return null;
    if (!(width > 0 && height > 0)) return null;
    if (mx < left || my < top || mx >= left + width || my >= top + height) return null;
    const centre = p.centre || {};
    return { centreX: Number(centre.x) || 0, centreY: Number(centre.y) || 0, mouseX: mx, mouseY: my };
  }

  // Absolute from the anchor, never incremental. `anchor` is whatever worldPanBegin returned.
  function worldPanCentre(anchor, mouseX, mouseY, worldW, worldH) {
    if (!anchor) return null;
    const dx = (Number(mouseX) || 0) - anchor.mouseX;
    const dy = (Number(mouseY) || 0) - anchor.mouseY;
    return worldClampCentre(
      anchor.centreX - worldPanTrunc(dx / WORLD_PAN_PX_PER_TILE),
      anchor.centreY - worldPanTrunc(dy / WORLD_PAN_PX_PER_TILE),
      worldW, worldH);
  }

  // Stepwise (arrow key / wheel) panning. Shares worldClampCentre with the drag and nothing else.
  function worldPanStep(centre, stepX, stepY, worldW, worldH) {
    const c = centre || {};
    return worldClampCentre((Number(c.x) || 0) + (Number(stepX) || 0),
      (Number(c.y) || 0) + (Number(stepY) || 0), worldW, worldH);
  }

  // The draw pitch and the pan constant are the same constant, or a 16px drag would not move exactly one tile.
  function worldPortLayout(centre, cssW, cssH) {
    const c = centre || {};
    const scale = WORLD_PAN_PX_PER_TILE;
    return {
      scale,
      ox: (Math.max(1, Number(cssW) || 1) / 2) - (Number(c.x) || 0) * scale,
      oy: (Math.max(1, Number(cssH) || 1) / 2) - (Number(c.y) || 0) * scale,
    };
  }

  // The layout the screen is actually drawn with: the viewport when we know where we are looking,
  // the whole-world fit when we do not (no centre has been established yet).
  function worldActiveLayout(data, centre, cssW, cssH) {
    if (centre && Number.isFinite(Number(centre.x)) && Number.isFinite(Number(centre.y)))
      return worldPortLayout(centre, cssW, cssH);
    return worldMapLayout(data?.width, data?.height, cssW, cssH);
  }

  // Mission positions are MID-LEVEL tiles: centre * 3 + 1, since one world tile is 3x3 MLT.
  // WIRE GAP, DECLARED. DEF-036: /world-map sends a site's x,y only, so that centre is one tile.
  const WORLD_MLT_PER_TILE = 3;

  function worldSiteCentreTile(site) {
    const s = site || {};
    const rect = s.rect;
    if (rect && Number.isFinite(Number(rect.x1)) && Number.isFinite(Number(rect.x2)))
      return { x: Math.floor((Number(rect.x1) + Number(rect.x2)) / 2),
               y: Math.floor((Number(rect.y1) + Number(rect.y2)) / 2) };
    return { x: Number(s.x) || 0, y: Number(s.y) || 0 };
  }

  function worldMissionPositionMlt(site) {
    const c = worldSiteCentreTile(site);
    return { x: c.x * WORLD_MLT_PER_TILE + 1, y: c.y * WORLD_MLT_PER_TILE + 1 };
  }

  // MLT -> canvas pixels through whatever layout is in force. The third-of-a-tile offset survives
  // the conversion, which is the entire point of carrying MLT rather than rounding at the source.
  function worldMltToPx(mlt, layout) {
    const l = layout || { scale: 1, ox: 0, oy: 0 };
    return {
      px: l.ox + ((Number(mlt?.x) || 0) / WORLD_MLT_PER_TILE) * l.scale,
      py: l.oy + ((Number(mlt?.y) || 0) / WORLD_MLT_PER_TILE) * l.scale,
    };
  }

  // A hard cap matching native's overlay capacity; the overflow is reported to the caller, never dropped.
  const WORLD_OVERLAY_MARKER_CAP = 1000;
  const WORLD_OVERLAY_LINE_CAP = 1000;

  function worldOverlayMarkers(data) {
    const missions = Array.isArray(data?.missions) ? data.missions : [];
    const sites = Array.isArray(data?.sites) ? data.sites : [];
    const all = [];
    for (const mission of missions) {
      const site = sites.find(s => Number(s.id) === Number(mission?.targetSiteId));
      if (!site) continue;
      all.push({ missionId: mission.id, siteId: site.id, mlt: worldMissionPositionMlt(site) });
    }
    return { markers: all.slice(0, WORLD_OVERLAY_MARKER_CAP), dropped: Math.max(0, all.length - WORLD_OVERLAY_MARKER_CAP) };
  }

  function ensureWorldScreenEl() {
    let el = document.getElementById("worldScreen");
    if (!el) {
      el = document.createElement("div");
      el.id = "worldScreen";
      document.body.appendChild(el);
    }
    return el;
  }

  // Bottom-right button stack, DF's exact order (22-world.png): Center on fort / Missions /
  // News and rumors / Civilizations / Missing citizens / Artifacts / Reports / Done.
  //
  // THE FOUR EMPTY-LIST GATES (screen.world-map.json plaque-stack, feed @ 0x1401d3660). Native
  // makes FOUR plaques inert when their backing vector is empty -- missions, missing citizens,
  // artifacts and reports -- because each one's hit test requires a non-empty vector. We used to
  // gate only missions. The differ cannot catch this (all eight plaques share one selector and it
  // accepts the group as honoured when ANY member is ever disabled), which is exactly why it is
  // written out longhand here.
  //
  // WHY `countOf` RETURNS null RATHER THAN 0 WHEN THE FIELD IS ABSENT. An older DLL does not send
  // the three new counts. Reading absent-as-zero would grey out three working buttons and call it
  // parity. Absent means WE DO NOT KNOW, and an unknown count leaves the plaque live -- the one
  // failure direction that cannot hide a working screen from the player.
  const WORLD_BUTTONS = [
    { key: "center", label: "Center on fort", enabled: true, tone: "green" },
    { key: "missions", label: "Missions", tone: "red", countField: "missions",
      disabledTitle: "No expedition is afoot, so there is nothing to review." },
    { key: "news", label: "News and rumors", enabled: true, tone: "green" },
    { key: "civs", label: "Civilizations", enabled: true, tone: "green" },
    { key: "missing", label: "Missing citizens", tone: "red", countField: "missingCitizenCount",
      disabledTitle: "Nobody from this fortress is unaccounted for." },
    { key: "artifacts", label: "Artifacts", tone: "green", countField: "artifactCount",
      disabledTitle: "Your civilization knows of no artifacts yet." },
    { key: "reports", label: "Reports", tone: "red", countField: "reportCount",
      disabledTitle: "No expedition or tribute report has been filed." },
    { key: "done", label: "Done", enabled: true, tone: "green" },
  ];

  // The backing count for a gated plaque, or null when this payload does not carry one.
  // `missions` is an array on the wire; the other three are plain integers the server derives.
  function worldPlaqueCount(data, field) {
    if (!data || !field) return null;
    const raw = data[field];
    if (Array.isArray(raw)) return raw.length;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function worldPlaqueEnabled(data, button) {
    if (!button.countField) return typeof button.enabled === "function" ? button.enabled(data) : button.enabled !== false;
    const count = worldPlaqueCount(data, button.countField);
    return count === null ? true : count > 0;
  }

  // ---- The tab strip is a TOGGLE strip, not a radio group: pressing the active plaque returns to the map. ----
  // One predicate drives both the painter and this state machine, and a press on a disabled plaque is inert.
  const WORLD_TAB_KEYS = ["missions", "news", "civs", "missing", "artifacts", "reports"];

  function worldInitialTabState() {
    // One scroll PAIR per tab, exactly as native carries them: a position and a scrolling flag.
    const pair = () => ({ top: 0, scrolling: false });
    return {
      missions: pair(), news: pair(), civs: pair(),
      missing: pair(), artifacts: pair(), reports: pair(),
      // The two per-tab extras native resets alongside the pair.
      newsFocusedOnLastHoverRumor: false,
      reportsActiveMission: null,
      reportsActiveTribute: null,
    };
  }

  function worldResetTabScroll(tabState, key) {
    const next = { ...tabState, [key]: { top: 0, scrolling: false } };
    if (key === "news") next.newsFocusedOnLastHoverRumor = false;
    if (key === "reports") { next.reportsActiveMission = null; next.reportsActiveTribute = null; }
    return next;
  }

  // Every mode that counts as "already in missions" for the toggle test: the list (2), the details
  // (3) and the composer (8).
  function worldModeIsMissions(view) {
    return view?.panel === "missions";
  }

  // Returns {view, tabs, route}: route is "screen", "panel" (hand off elsewhere) or "inert" (refused press).
  function worldTabPress(view, tabs, key, data) {
    const current = view || {};
    if (!WORLD_TAB_KEYS.includes(key)) return { view: current, tabs, route: "inert" };
    const button = WORLD_BUTTONS.find(b => b.key === key);
    if (button && !worldPlaqueEnabled(data, button))
      return { view: current, tabs, route: "inert" };   // inert AND non-destructive: no reset.

    const resetTabs = worldResetTabScroll(tabs, key);
    const closed = { panel: null, missionsView: "list", selectedMissionId: -1 };

    if (key === "missions") {
      if (worldModeIsMissions(current)) return { view: closed, tabs: resetTabs, route: "screen" };
      // R4, the adaptive plaque: 0 does nothing at all, 1 SKIPS the list, 2+ opens the list.
      const target = worldMissionsOpenTarget(data);
      if (target.mode === "none") return { view: current, tabs, route: "inert" };
      return {
        view: { panel: "missions", missionsView: "list",
                selectedMissionId: target.mode === "details" ? target.missionId : -1 },
        tabs: resetTabs, route: "screen",
      };
    }

    const routeKind = worldButtonRoute(key).kind === "panel" ? "panel" : "screen";
    if (current.panel === key && routeKind === "screen")
      return { view: closed, tabs: resetTabs, route: "screen" };
    return {
      view: routeKind === "panel" ? current : { ...closed, panel: key },
      tabs: resetTabs, route: routeKind,
    };
  }

  // Native's world_view_mode_type; the numbers are carried because two parity rules below are stated in them.
  const WORLD_VIEW_MODE = {
    map: 0, civilizations: 1, missionsList: 2, missionDetails: 3, news: 4,
    reports: 5, citizens: 6, artifacts: 7, newMission: 8,
  };

  function worldViewModeCode(options) {
    const o = options || {};
    if (o.panel === "missions") {
      if (o.missionsView === "new") return WORLD_VIEW_MODE.newMission;
      if (o.missionsView === "pending") return WORLD_VIEW_MODE.missionDetails;
      if (Number(o.selectedMissionId) >= 0) return WORLD_VIEW_MODE.missionDetails;
      return WORLD_VIEW_MODE.missionsList;
    }
    if (o.panel === "reports") return WORLD_VIEW_MODE.reports;
    if (o.panel === "news") return WORLD_VIEW_MODE.news;
    if (o.panel === "civs" || o.civsOpen) return WORLD_VIEW_MODE.civilizations;
    return WORLD_VIEW_MODE.map;
  }

  // The whole plaque stack is suppressed in the two mission-composing modes on a screen 66 rows or shorter.
  const WORLD_SHORT_SCREEN_ROWS = 66;
  const WORLD_CAPTURE_GRID_ROWS = 78;

  function worldPlaqueStackVisible(viewMode, gridY) {
    // Reject an unknown height BEFORE the numeric test: Number(null) is 0, which reads as a zero-row screen.
    const known = gridY !== null && gridY !== undefined && gridY !== "" && Number.isFinite(Number(gridY));
    const rows = known ? Number(gridY) : WORLD_CAPTURE_GRID_ROWS;
    const composing = viewMode === WORLD_VIEW_MODE.missionDetails || viewMode === WORLD_VIEW_MODE.newMission;
    return !composing || rows > WORLD_SHORT_SCREEN_ROWS;
  }

  // Exactly one expedition opens its details directly; zero swallows the click; two or more open the list.
  function worldMissionsOpenTarget(data) {
    const missions = Array.isArray(data?.missions) ? data.missions : [];
    if (!missions.length) return { mode: "none", missionId: -1 };
    if (missions.length === 1) {
      const id = Number(missions[0]?.id);
      return { mode: "details", missionId: Number.isFinite(id) ? id : -1 };
    }
    return { mode: "list", missionId: -1 };
  }

  function worldButtonRoute(key) {
    // Reports is view_mode 5 of THIS screen, not a jump to the fortress announcements panel.
    if (key === "reports") return { kind:"reports" };
    if (key === "artifacts") return { kind:"panel", name:"objects" };
    if (key === "missing") return { kind:"panel", name:"citizens", section:"creatures", detail:"dead" };
    if (key === "civs") return { kind:"civs" };
    if (key === "missions") return { kind:"missions" };
    if (key === "news") return { kind:"news" };
    if (key === "center") return { kind:"center" };
    if (key === "done") return { kind:"done" };
    return { kind:"blocked" };
  }

  function renderWorldScreenShell(loadingText) {
    const el = ensureWorldScreenEl();
    if (loadingText) {
      el.innerHTML = DWFUI.statusHtml({ cls: "world-loading", text: loadingText, role: "status", live: "polite" });
      return;
    }
    if (worldMapData && worldMapData.error) {
      el.innerHTML = `
        ${DWFUI.statusHtml({ cls: "world-loading world-error", tone: "danger", text: `World map unavailable: ${worldMapData.error}`, role: "status" })}
        <div class="world-btn-stack">${worldButtonsHtml(worldMapData)}</div>
      `;
      wireWorldScreenButtons(el);
      return;
    }
    el.innerHTML = worldScreenMarkup(worldMapData, {
      panel: worldPanelMode, selectedCivId: worldSelectedCivId,
      hoverSiteId: worldHoverSiteId,
      missionsView, selectedMissionId: missionsSelectedId,
      reportsView: worldReportsView,
      gridY: worldGridRows(),
    });
    wireWorldScreenButtons(el);
    drawWorldScreenCanvas();
  }

  // dwf-grid.js owns cells -> pixels for the whole client: never divide innerHeight by a bare cell size
  // here, it ignores the interface scale. Off-DOM this returns null and the rule falls back to 78 rows.
  function worldGridRows() {
    if (typeof window === "undefined" || !Number(window.innerHeight)) return null;
    const grid = window.DwfGrid;
    if (!grid) return null;
    try { return Math.max(1, grid.refresh(document).gridY); } catch { return null; }
  }

  function worldScreenMarkup(data, options) {
    options = options || {};
    const viewMode = worldViewModeCode(options);
    const stackHtml = worldPlaqueStackVisible(viewMode, options.gridY)
      ? `<div class="world-btn-stack">${worldButtonsHtml(data, options.panel || (options.civsOpen ? "civs" : null))}</div>`
      : "";
    // Native draws nothing in this corner unless the pointer rests on a world tile: a hover card, not a plate.
    const panelHtml =
      options.panel === "missions" ? worldMissionsPanelHtml(data, options)
      : options.panel === "reports" ? worldReportsPanelHtml(data, options.reportsView)
      : options.panel === "news" ? worldNewsPanelHtml(data, options.hoverSiteId != null)
      : (options.panel === "civs" || options.civsOpen) ? worldCivsPanelHtml(data, options.selectedCivId)
      : "";
    return `
      ${DWFUI.scrollHtml(
        { cls: "world-map-input-owner", ariaLabel: "World map sites" },
        '<canvas id="worldScreenCanvas" tabindex="0" contenteditable="true" spellcheck="false" aria-label="World map sites"></canvas>'
      )}
      <div id="worldHoverMount">${worldHoverCardHtml(data, options.hoverSiteId)}</div>
      ${stackHtml}
      ${panelHtml}
    `;
  }

  // ---- The hover information card. No hover is NO CARD, not an empty one. ----
  // Unserved lines are drawn RED-disabled with a reason, and the population is printed BANDED, never exact.
  const WORLD_HOVER_REGION_BUDGET = 49;
  const WORLD_HOVER_TRAVEL_BUDGET = 40;

  function worldTruncate(text, budget) {
    const cap = Math.max(1, Number(budget) || 1);
    const ui = (typeof DWFUI !== "undefined" && DWFUI) || null;
    // Cold-load guard only (this file evaluated, dwf-ui-components.js did not): the same law,
    // inline, rather than a blank hover line.
    if (!ui || !ui.TextLaw) {
      const s = String(text == null ? "" : text);
      return s.length <= cap ? s : (cap <= 3 ? ".".repeat(cap) : s.slice(0, cap - 3) + "...");
    }
    return ui.TextLaw.hardCutDots(text, cap);
  }

  const WORLD_TRAVEL_PHRASE = {
    brief: "a brief walk away",
    "half-day": "about half a day away",
    "near-day": "the better part of a day away",
    day: "about a day away",
    "over-day": "more than a day away",
    unreachable: "no route is known",
  };

  function worldTravelPhrase(site) {
    if (!site) return "";
    const band = String(site.travelBand || "");
    const days = Number(site.travelDays);
    if (band === "days" && Number.isFinite(days) && days > 0)
      return `roughly ${days} day${days === 1 ? "" : "s"} of travel away`;
    return WORLD_TRAVEL_PHRASE[band] || "travel time is not known";
  }

  function worldSiteDiplomacy(data, site) {
    const civs = Array.isArray(data?.civs) ? data.civs : [];
    const civ = civs.find(c => Number(c.id) === Number(site?.civId));
    if (!civ || !civ.relation) return "";
    return worldPrettyKey(civ.relation);
  }

  function worldHoverSite(data, hoverSiteId) {
    if (hoverSiteId == null || hoverSiteId === "") return null;
    const sites = Array.isArray(data?.sites) ? data.sites : [];
    return sites.find(s => Number(s.id) === Number(hoverSiteId)) || null;
  }

  // One card line. `text` empty + `unserved` set draws the honest disabled form.
  function worldHoverLineHtml(cls, text, unserved) {
    if (unserved) {
      return DWFUI.statusHtml({
        cls: `world-hover-line ${cls} world-hover-unserved`, tone: "danger", role: "note",
        text: unserved,
      });
    }
    return DWFUI.statusHtml({ cls: `world-hover-line ${cls}`, role: "note", text: text });
  }

  function worldHoverCardHtml(data, hoverSiteId) {
    const site = worldHoverSite(data, hoverSiteId);
    if (!site) return "";   // not tracking a world tile: native draws nothing here, frame included.

    const regionName = String(site.regionName || "");
    const kind = worldSiteKind(site);
    const siteName = site.name || "An unnamed place";
    const band = site.populationBand && site.populationBand.advertised ? String(site.populationBand.advertised) : "";
    const government = site.hasGovernment && site.govName ? String(site.govName) : "";
    const civName = site.civName ? String(site.civName) : "";
    const diplomacy = worldSiteDiplomacy(data, site);
    const own = site.own === true;

    const lines = [
      regionName
        ? worldHoverLineHtml("world-hover-region-name", worldTruncate(regionName, WORLD_HOVER_REGION_BUDGET))
        : worldHoverLineHtml("world-hover-region-name", "", "This tile's region has no recorded name."),
      // Native's second area name for the same tile. Not on our wire, and not guessable from the
      // first one -- see the header note.
      worldHoverLineHtml("world-hover-region-name-2", "", "A second area name for this tile is not read yet."),
      worldHoverLineHtml("world-hover-travel-time", worldTruncate(worldTravelPhrase(site), WORLD_HOVER_TRAVEL_BUDGET)),
      DWFUI.statusHtml({
        cls: "world-hover-line world-hover-site-name", role: "note",
        textHtml: DWFUI.rawHtml(
          "the kind-of-place word is its own ledger-0064 span so the differ can grade it separately",
          `${DWFUI.esc(siteName)} <span class="world-hover-site-kind">${DWFUI.esc(kind)}</span>`),
      }),
      own
        ? worldHoverLineHtml("world-hover-site-population", "This is your own fortress")
        : band
        ? worldHoverLineHtml("world-hover-site-population", `Roughly ${band} live here`)
        : worldHoverLineHtml("world-hover-site-population", "Nobody is recorded as living here"),
      own && !government
        ? worldHoverLineHtml("world-hover-site-government", "",
          "Your fortress's government is not carried on the world-map wire.")
        : government
        ? worldHoverLineHtml("world-hover-site-government", `Ruled by ${government}`)
        : worldHoverLineHtml("world-hover-site-government", "No government holds this place"),
      own && !civName
        ? worldHoverLineHtml("world-hover-site-civilization", "",
          "Your fortress's civilization is not carried on the world-map wire.")
        : civName
        ? worldHoverLineHtml("world-hover-site-civilization", `Part of ${civName}`)
        : worldHoverLineHtml("world-hover-site-civilization", "Belongs to no civilization"),
      own
        ? worldHoverLineHtml("world-hover-diplomacy", "This is your own place")
        : diplomacy
        ? worldHoverLineHtml("world-hover-diplomacy", `They regard your fortress as: ${diplomacy}`)
        : worldHoverLineHtml("world-hover-diplomacy", "", "No standing toward your fortress is recorded."),
      worldHoverLineHtml("world-hover-economic-link", "", "Trade ties for this place are not read yet."),
    ].join("");

    return `<div class="world-hover-card" role="note">${lines}</div>`;
  }

  // Held as a literal `title:` PROPERTY, never inlined into the ternary: help_corpus_extractor.mjs harvests
  // tooltips by scanning source for `title=` / `title:` plus a quoted literal, and a buried string vanishes.
  const WORLD_BTN_PENDING = { title: "Not implemented yet -- read endpoint pending (WD-31 backlog)." };

  // Three-way plaque state -- ACTIVE / enabled / disabled -- whose disabled arm evaluates the same
  // emptiness predicate the feed uses. There is no separate greyed flag, so do not carry one.
  function worldButtonsHtml(data, activePanel) {
    return WORLD_BUTTONS.map(b => {
      const enabled = worldPlaqueEnabled(data, b);
      const active = enabled && activePanel != null && activePanel === b.key;
      return DWFUI.plaqueBtnHtml({
      label: b.label, tone: b.tone,
      cls: "world-btn" + (enabled ? "" : " world-btn-disabled") + (active ? " world-btn-active" : ""),
      dataset: { worldBtn: b.key },
      disabled: !enabled,
      title: enabled ? "" : (b.disabledTitle || WORLD_BTN_PENDING.title),
    });
    }).join("");
  }

  // df-structures enum ids come SNAKE_CASE and CamelCase: split on both, or "Mountainhalls" stays one word.
  function worldPrettyKey(value) {
    return String(value || "Unknown")
      .replace(/_/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/(^|\s)\S/g, c => c.toUpperCase());
  }

  // Prefer `subtypeKey` when present. The dwarven and town population splits are NOT handled: those
  // branches are described only by raw offsets, so serving a word for them would be a guess.
  function worldSiteKind(site) {
    if (!site) return worldPrettyKey(null);
    if (site.subtypeKey) return worldPrettyKey(site.subtypeKey);
    return worldPrettyKey(site.type);
  }

  // ---- Civilization detail card: identity, standing, war fatigue, trade, tribute, agreements, envoys. ----
  // The trade block is hard-gated on an appraisal-skilled broker, and civs[].population is never printed here.
  function worldCivBlockHtml(cls, label, rowsHtml, unserved) {
    const body = unserved
      ? DWFUI.statusHtml({ cls: `world-civ-unserved ${cls}-unserved`, tone: "danger", role: "note", text: unserved })
      : rowsHtml;
    return DWFUI.rowGroupHtml({ cls: `world-civ-block ${cls}`, header: { label }, rows: [body] });
  }

  function worldCivIdentityHtml(civ) {
    const rows = [
      DWFUI.rowHtml({ cls: "world-civ-fact world-civ-identity-relation", label: "Relationship",
        trailing: DWFUI.esc(worldPrettyKey(civ.relation)) }),
    ];
    if (typeof civ.race === "string" && civ.race && !/^\d+$/.test(civ.race))
      rows.push(DWFUI.rowHtml({ cls: "world-civ-fact world-civ-identity-race", label: "People",
        trailing: DWFUI.esc(worldPrettyKey(civ.race)) }));
    else if (civ.race != null)
      rows.push(DWFUI.statusHtml({ cls: "world-civ-fact world-civ-identity-race world-civ-unserved",
        tone: "danger", role: "note",
        text: "This people's name is not resolved on the world-map wire." }));
    return worldCivBlockHtml("world-civ-identity", civ.name || "Civilization", rows.join(""));
  }

  function worldCivStandingHtml(civ) {
    const standing = civ.standing;
    if (!standing || typeof standing !== "object")
      return worldCivBlockHtml("world-civ-standing", "Standing", "",
        "Whether tribute is offered or accepted, and whether an alliance stands, is not read yet.");
    const row = (cls, label, value) => DWFUI.rowHtml({
      cls: `world-civ-fact ${cls}`, label,
      trailing: DWFUI.esc(value ? "Yes" : "No"),
    });
    return worldCivBlockHtml("world-civ-standing", "Standing",
      row("world-civ-standing-offering", "Offering tribute", standing.offeringTribute) +
      row("world-civ-standing-accepting", "Accepting tribute", standing.acceptingTribute) +
      row("world-civ-standing-alliance", "Alliance", standing.alliance));
  }

  function worldCivWarFatigueHtml(civ) {
    if (civ.warFatigueWord)
      return worldCivBlockHtml("world-civ-warfatigue", "War weariness",
        DWFUI.statusHtml({ cls: "world-civ-fact world-civ-warfatigue-word", role: "note",
          text: String(civ.warFatigueWord) }));
    return worldCivBlockHtml("world-civ-warfatigue", "War weariness", "",
      "The game reports a war-weariness figure, but this screen prints a magnitude word and the " +
      "wording is not read yet. A bare number is not what the game shows.");
  }

  function worldCivTradeHtml(civ) {
    // The hard gate. FALSE is a real answer and gets native's two-line explanation; ABSENT is not
    // an answer at all and must not be dressed up as one.
    if (civ.hasAppraisalBroker === false)
      return worldCivBlockHtml("world-civ-trade", "Trade",
        DWFUI.statusHtml({ cls: "world-civ-fact world-civ-trade-nobroker", role: "note", columns: 42,
          text: "You have nobody able to appraise goods. Assign a broker skilled in appraisal " +
                "before this fortress can read another people's trade standing." }));
    const trade = civ.trade;
    if (!trade || typeof trade !== "object")
      return worldCivBlockHtml("world-civ-trade", "Trade", "",
        "Trade standing is not read yet, and whether anyone here can appraise goods is not read " +
        "either -- so neither the block nor its refusal can be shown honestly.");
    const goods = Array.isArray(trade.goods) ? trade.goods : [];
    return worldCivBlockHtml("world-civ-trade", "Trade",
      DWFUI.rowHtml({ cls: "world-civ-fact world-civ-trade-agreement", label: "Trade agreement",
        trailing: DWFUI.esc(trade.agreementActive ? "In force" : "None") }) +
      (goods.length
        ? goods.map(good => DWFUI.rowHtml({ cls: "world-civ-fact world-civ-trade-good",
            label: String(good.label || "Goods"), trailing: DWFUI.esc(String(good.count ?? "")) })).join("")
        : DWFUI.statusHtml({ cls: "world-civ-trade-empty", role: "note", text: "No goods are recorded." })));
  }

  function worldCivTributeHtml(civ) {
    const cadence = civ.tributeCadence;
    if (!cadence || typeof cadence !== "object")
      return worldCivBlockHtml("world-civ-tribute", "Tribute", "",
        "How often tribute changes hands is not read yet.");
    const every = Number(cadence.everyNSeasons) || 0;
    return worldCivBlockHtml("world-civ-tribute", "Tribute",
      DWFUI.rowHtml({ cls: "world-civ-fact world-civ-tribute-cadence", label: "Cadence",
        trailing: DWFUI.esc(every > 1 ? `Every ${every} seasons` : worldPrettyKey(cadence.seasonKey)) }));
  }

  function worldCivAgreementRow(agreement) {
    // `pending` is native's own per-row byte. It is NEVER derived from the year.
    const pending = agreement.pending === true;
    return DWFUI.rowHtml({
      cls: "world-civ-fact world-civ-agreement" + (pending ? " world-civ-agreement-pending" : ""),
      label: worldPrettyKey(agreement.kindKey),
      sub: { text: [agreement.requestKey ? worldPrettyKey(agreement.requestKey) : "",
        Number(agreement.agreedYear) >= 0 ? `Agreed in year ${Number(agreement.agreedYear)}` : ""]
        .filter(Boolean).join(" · ") },
      trailing: pending
        ? DWFUI.statusHtml({ tag: "span", tone: "warn", text: "Pending" })
        : "",
    });
  }

  function worldCivAgreementsHtml(civ) {
    const agreements = civ.agreements;
    if (!Array.isArray(agreements))
      return worldCivBlockHtml("world-civ-agreements", "Agreements", "",
        "Agreements with this people are not read yet.");
    if (!agreements.length)
      return worldCivBlockHtml("world-civ-agreements", "Agreements",
        DWFUI.statusHtml({ cls: "world-civ-agreements-empty", role: "note",
          text: "No agreements stand with this people." }));
    return worldCivBlockHtml("world-civ-agreements", "Agreements",
      agreements.map(worldCivAgreementRow).join(""));
  }

  function worldCivEnvoysHtml(civ) {
    const envoys = civ.envoys;
    if (!Array.isArray(envoys))
      return worldCivBlockHtml("world-civ-envoys", "Leaders and envoys", "",
        "This people's leaders and envoys are not read yet.");
    if (!envoys.length)
      return worldCivBlockHtml("world-civ-envoys", "Leaders and envoys",
        DWFUI.statusHtml({ cls: "world-civ-envoys-empty", role: "note",
          text: "Nobody from this people has presented themselves." }));
    return worldCivBlockHtml("world-civ-envoys", "Leaders and envoys",
      envoys.map(envoy => DWFUI.rowHtml({
        cls: "world-civ-fact world-civ-envoy", label: envoy.name || "An unnamed envoy",
        sub: { text: envoy.positionKey ? worldPrettyKey(envoy.positionKey) : "" },
        trailing: Number(envoy.arrivedYear) >= 0 ? DWFUI.esc(`Year ${Number(envoy.arrivedYear)}`) : "",
      })).join(""));
  }

  // Our own derived counts, labelled as ours so nobody grades them as parity. The exact population is not among them.
  function worldCivExtensionHtml(civ) {
    return worldCivBlockHtml("world-civ-extension", "Beyond the game's own card",
      DWFUI.rowHtml({ cls: "world-civ-fact world-civ-known-sites", label: "Known sites",
        trailing: DWFUI.esc(String(Number(civ.siteCount) || 0)) }) +
      DWFUI.rowHtml({ cls: "world-civ-fact world-civ-mapped-sites", label: "Mapped sites",
        trailing: DWFUI.esc(String(Number(civ.knownSiteCount) || 0)) }) +
      DWFUI.rowHtml({ cls: "world-civ-fact world-civ-meetings", label: "Diplomatic meetings",
        trailing: DWFUI.esc(String(Number(civ.meetingCount) || 0)) }) +
      DWFUI.statusHtml({ cls: "world-civ-extension-note", tone: "muted", role: "note", columns: 42,
        text: "These three counts are this client's own; the game's own card does not show them." }));
  }

  function worldCivDetailBlocksHtml(civ) {
    if (!civ) return "";
    return worldCivIdentityHtml(civ) + worldCivStandingHtml(civ) + worldCivWarFatigueHtml(civ) +
      worldCivTradeHtml(civ) + worldCivTributeHtml(civ) + worldCivAgreementsHtml(civ) +
      worldCivEnvoysHtml(civ) + worldCivExtensionHtml(civ);
  }

  function worldCivsPanelHtml(data, selectedId) {
    const source = data || worldMapData;
    const civs = Array.isArray(source?.civs) ? source.civs : [];
    const selected = civs.find(c => Number(c.id) === Number(selectedId));
    if (selected) {
      const facts = worldCivDetailBlocksHtml(selected);
      const head = DWFUI.headerHtml({ cls: "world-civs-head", title: selected.name || "Civilization", titleCls: "world-civs-title", back: { dataset: { worldCivBack: "" }, title: "Back to civilizations" }, close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" } });
      return `<div class="world-civs-panel world-civ-detail">${head}${DWFUI.scrollHtml({ cls: "world-civs-list", rows: ".world-civ-fact", ariaLabel: "Civilization details" }, facts)}</div>`;
    }
    const rows = civs.length
      ? civs.map(c => DWFUI.rowHtml({
          tag: "button", cls: "world-civ-row", dataset: { worldCivId: c.id },
          label: c.name, trailing: DWFUI.bitmapTextHtml(worldPrettyKey(c.relation)),
        })).join("")
      : `<div class="info-message">No civilizations recorded.</div>`;
    const head = DWFUI.headerHtml({ cls: "world-civs-head", title: "Civilizations", titleCls: "world-civs-title", close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" } });
    return `<div class="world-civs-panel">${head}${DWFUI.scrollHtml({ cls: "world-civs-list", rows: ".world-civ-row", ariaLabel: "Civilizations" }, rows)}</div>`;
  }

  // ---- Missions: existing expeditions are read-only, and goal selection expects the server's 501. ----
  // No browser response is ever treated as proof that an expedition exists.

  let missionsData = null;
  let missionsSelectedId = -1;
  let missionsView = "list";       // "list" | "new" | "pending"
  let missionPending = null;       // site-first goal plus locally staged squad assignments

  function resetMissionFlow() {
    missionsView = "list";
    missionPending = null;
  }

  function missionMapSite(siteId) {
    return (Array.isArray(worldMapData?.sites) ? worldMapData.sites : [])
      .find(site => Number(site.id) === Number(siteId)) || null;
  }

  function openNewMissionAtSite(siteId) {
    worldPanelMode = "missions";
    missionsSelectedId = -1;
    missionsView = "new";
    missionPending = { siteId: Number(siteId), goal: "", squadIds: [], result: null, error: "", busy: false };
    missionsData = null;
    renderWorldScreenShell();
    loadMissions();
  }

  async function chooseMissionGoal(goal) {
    if (!missionPending || missionPending.busy) return;
    missionPending = { ...missionPending, goal: String(goal || ""), squadIds: [], result: null, error: "", busy: true };
    missionsView = "pending";
    renderWorldScreenShell();
    const query = `goal=${encodeURIComponent(missionPending.goal)}&site=${encodeURIComponent(missionPending.siteId)}&phase=goal&player=${encodeURIComponent(globalThis.playerName)}&t=${Date.now()}`;
    try {
      const response = await fetch(`/mission-create?${query}`, { method: "POST", cache: "no-store" });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      // A goal selection is allowed to reach only the native-only wall. Even an unexpected 2xx is
      // kept pending: the browser cannot prove that an army controller entered DF's world state.
      missionPending = { ...missionPending, busy: false, result: body || { ok: response.ok },
        error: body?.error || (response.ok ? "" : `request failed (${response.status})`) };
    } catch (err) {
      missionPending = { ...missionPending, busy: false, error: err.message || "The server could not check this expedition." };
    }
    renderWorldScreenShell();
  }

  function togglePendingSquad(squadId) {
    if (!missionPending) return;
    const ids = new Set((missionPending.squadIds || []).map(Number));
    if (ids.has(Number(squadId))) ids.delete(Number(squadId)); else ids.add(Number(squadId));
    missionPending = { ...missionPending, squadIds: Array.from(ids) };
    renderWorldScreenShell();
  }

  // The world-map overlay's small missions summary; the deep screen reads /missions. Neither may invent
  // a mission the other cannot see.
  function worldMissionsPanelHtml(data) {
    if (typeof window !== "undefined" && window.DwfMissions) {
      const siteId = missionPending?.siteId;
      const mapSite = missionMapSite(siteId);
      return window.DwfMissions.panelHtml(missionsData, missionsSelectedId, {
        mode: missionsView, siteId, pending: missionPending, mapSite,
        siteKind: worldSiteKind, diplomacy: worldSiteDiplomacy(data, mapSite),
      });
    }
    // Offline/old-load fallback only. Production index.html loads dwf-missions.js first.
    const missions = Array.isArray(data?.missions) ? data.missions : [];
    if (!missions.length) return "";
    const rows = missions.map(m => DWFUI.rowHtml({
      cls: "world-mission-row", label: worldPrettyKey(m.goal),
      sub: { text: m.targetSite || "Unknown destination" },
      trailing: `${Array.isArray(m.squadIds) ? m.squadIds.length : 0} squads`,
    })).join("");
    const head = DWFUI.headerHtml({ cls: "world-civs-head", title: "Missions", titleCls: "world-civs-title",
      close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" } });
    return `<div class="world-civs-panel world-missions-panel">${head}${rows}</div>`;
  }

  async function loadMissions() {
    try {
      missionsData = await globalThis.fortFetchJson(
        `/missions?player=${encodeURIComponent(globalThis.playerName)}&t=${Date.now()}`);
      missionsData.fetchedAt = Date.now();
      if (!Array.isArray(missionsData.active) || missionsData.active.length === 0) {
        if (worldMapData) worldMapData.missions = [];
        // A site-click creation flow is valid with zero existing expeditions; keep its payload and
        // panel open. Only the Missions plaque itself is gated by the active-list count.
        if (missionsView === "list") {
          missionsData = null;
          missionsSelectedId = -1;
          worldPanelMode = null;
        }
      }
    } catch (err) {
      missionsData = { active: [], squads: [], targets: [], missionTypes: [], rescue: {}, create: {},
                       error: err.message || "unavailable" };
    }
    renderWorldScreenShell();
  }

  const WORLD_TEXT_COLS = 52;   // a world list row's text width, in cells, inside the 58-cell panel

  // News text is a GRAMMAR, not a field: native composes each sentence from fragments, so it must be
  // generated once server-side as `news[].sentence`. Never print the enum key as if it were the sentence.
  function worldNewsRowHtml(item) {
    const source = item?.source || "Unknown source";
    const year = Number(item?.year) >= 0 ? `Year ${Number(item.year)}` : "";
    if (item && typeof item.sentence === "string" && item.sentence)
      return DWFUI.rowHtml({ chassis: "table", cls: "world-news-row",
        labelHtml: DWFUI.bitmapProseHtml(item.sentence, WORLD_TEXT_COLS),
        sub: { text: [source, year].filter(Boolean).join(" · ") } });
    return DWFUI.rowHtml({
      chassis: "table", cls: "world-news-row world-news-uncomposed",
      title: "Native composes each sentence from about twenty-one fragments; the server has to " +
             "compose it once, from the event record.",
      label: source,
      sub: [{ text: year }, { text: "The wording of this report is not composed yet.", tone: "danger" }],
    });
  }

  function worldNewsPanelHtml(data, hidden) {
    const news = Array.isArray(data?.news) ? data.news : [];
    const rows = news.length ? news.map(worldNewsRowHtml).join("")
      : `<div class="info-message">No news or rumors have reached the fortress.</div>`;
    const head = DWFUI.headerHtml({ cls: "world-civs-head", title: "News and rumors", titleCls: "world-civs-title", close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" } });
    return `<div class="world-civs-panel world-news-panel"${hidden ? " hidden" : ""}>${head}${DWFUI.scrollHtml({ cls: "world-civs-list", ariaLabel: "News and rumors" }, rows)}</div>`;
  }

  // ---- Reports (view_mode 5), drawn inside the world screen. ----
  // Only the filed-report LIST is on the wire; playback and rumour detail stay RED-disabled with their reason.
  const WORLD_REPORT_TITLE_BUDGET = 51;   // native's own truncation budget for a list title

  // `reports[]` when the DLL sends it; otherwise recovered from the mission entries' `reportTitle`.
  function worldReportEntries(data) {
    if (Array.isArray(data?.reports)) return data.reports;
    return (Array.isArray(data?.missions) ? data.missions : [])
      .filter(m => m && m.reportTitle)
      .map(m => ({ id: m.id, title: m.reportTitle, year: m.year, kind: "mission" }));
  }

  // Playback is a pure function of ELAPSED time, never an accumulator: a paused-and-resumed replay must
  // land on the frame the clock says. No body lines reach the wire today, so that body stays disabled.
  const WORLD_REPORT_MS_PER_LINE = 600;   // used ONLY when a served report omits its own cadence

  function worldReportPlaybackState(report, elapsedMs, paused) {
    const lines = Array.isArray(report?.lines) ? report.lines : [];
    const cadence = Math.max(1, Number(report?.msPerLine) || WORLD_REPORT_MS_PER_LINE);
    const colors = Array.isArray(report?.lineColors) ? report.lineColors : [];
    if (!lines.length) return { served: false, lines: [], revealed: 0, fading: -1, paused: !!paused, complete: true };
    const ticks = paused ? 0 : Math.max(0, Number(elapsedMs) || 0);
    const revealed = Math.min(lines.length, Math.floor(ticks / cadence) + 1);
    return {
      served: true,
      lines: lines.slice(0, revealed).map((text, i) => ({ text, color: colors[i] })),
      revealed,
      fading: revealed < lines.length ? revealed - 1 : -1,
      paused: !!paused,
      complete: revealed >= lines.length,
    };
  }

  function worldReportPlaybackHtml(state) {
    const rows = state.lines.map((line, i) => DWFUI.statusHtml({
      cls: "world-report-line" + (i === state.fading ? " world-report-line-fading" : ""),
      role: "note", text: line.text,
    })).join("");
    return `<div class="world-reports-body world-reports-playback">${rows}${
      DWFUI.statusHtml({ cls: "world-report-playback-state", tone: state.paused ? "warn" : "muted",
        role: "status", text: state.paused ? "The reading is paused."
          : state.complete ? "The account is finished." : "The account is being read back." })}</div>`;
  }

  function worldReportsBodyHtml(data, view, playback) {
    if (view === "playback") {
      const state = playback && playback.served ? playback : null;
      if (state) return worldReportPlaybackHtml(state);
      return DWFUI.statusHtml({
        cls: "world-reports-body world-reports-playback world-reports-unserved", tone: "danger", role: "status",
        text: "Reading a report back line by line is not available: the server sends each report's heading only, never its text.",
      });
    }
    if (view === "rumour") {
      return DWFUI.statusHtml({
        cls: "world-reports-body world-reports-rumour world-reports-unserved", tone: "danger", role: "status",
        text: "Rumour details are not available: the server sends what kind of rumour it was and when, but none of its wording.",
      });
    }
    const entries = worldReportEntries(data);
    if (!entries.length) {
      return DWFUI.statusHtml({
        cls: "world-reports-body world-reports-empty", role: "status",
        text: "Nothing has been reported back to the fortress yet.",
      });
    }
    const rows = entries.map(entry => DWFUI.rowHtml({
      chassis: "table", cls: "world-report-row",
      label: worldTruncate(entry.title || "An untitled account", WORLD_REPORT_TITLE_BUDGET),
      sub: { text: [entry.kind === "tribute" ? "Tribute" : "Expedition",
        Number(entry.year) >= 0 ? `Year ${entry.year}` : ""].filter(Boolean).join(" · ") },
    })).join("");
    return `<div class="world-reports-body world-reports-list">${
      DWFUI.scrollHtml({ cls: "world-civs-list", rows: ".world-report-row", ariaLabel: "Reports" }, rows)}</div>`;
  }

  function worldReportsPanelHtml(data, view, playback) {
    const head = DWFUI.headerHtml({
      cls: "world-civs-head", title: "Reports", titleCls: "world-civs-title",
      close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" },
    });
    return `<div class="world-civs-panel world-reports-panel">${head}${worldReportsBodyHtml(data, view, playback)}</div>`;
  }

  function wireWorldScreenButtons(root) {
    root.querySelectorAll("[data-world-btn]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const key = button.dataset.worldBtn;
        const route = worldButtonRoute(key);
        if (route.kind === "done") { closeWorldScreen(); return; }
        if (route.kind === "center") { worldCenterOnFort(); return; }

        // Every other plaque goes through the ONE toggle state machine -- per-plaque branches are how it drifted.
        const before = { panel: worldPanelMode, missionsView, selectedMissionId: missionsSelectedId };
        const press = worldTabPress(before, worldTabState, key, worldMapData);
        if (press.route === "inert") return;   // a disabled or zero-mission plaque resets nothing
        worldTabState = press.tabs;

        if (press.route === "panel") {
          closeWorldScreen();
          if (typeof window.openPanel === "function") window.openPanel(route.name, route.section, route.detail);
          return;
        }

        const opening = press.view.panel;
        worldPanelMode = opening;
        worldSelectedCivId = -1;   // the press resets this tab's own selection, whichever tab it is
        if (opening === "reports") worldReportsView = "list";
        if (opening === "missions") {
          resetMissionFlow();
          missionsSelectedId = press.view.selectedMissionId;
          renderWorldScreenShell();
          loadMissions();
          return;
        }
        if (!opening) {
          missionsData = null;
          missionsSelectedId = -1;
          resetMissionFlow();
        }
        renderWorldScreenShell();
      });
    });
    root.querySelector("[data-world-civs-close]")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      worldPanelMode = null;
      worldSelectedCivId = -1;
      missionsData = null;
      resetMissionFlow();
      renderWorldScreenShell();
    });
    root.querySelector("[data-world-civ-back]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); worldSelectedCivId = -1; renderWorldScreenShell();
    });
    root.querySelectorAll("[data-world-civ-id]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); worldSelectedCivId = Number(button.dataset.worldCivId); renderWorldScreenShell();
    }));
    window.DwfMissions.wire(root, {
      select(id) { missionsSelectedId = id; renderWorldScreenShell(); },
      retry() { missionsData = null; missionsSelectedId = -1; renderWorldScreenShell(); loadMissions(); },
      backToMap() { worldPanelMode = null; missionsData = null; resetMissionFlow(); renderWorldScreenShell(); },
      backToGoals() { missionsView = "new"; if (missionPending) missionPending = { ...missionPending, goal: "", result: null, error: "", busy: false }; renderWorldScreenShell(); },
      chooseGoal: chooseMissionGoal,
      togglePendingSquad,
    });
  }

  // The world screen draws NO legend: this family writes zero to the shared painter's legend count.
  function drawWorldCanvas(canvas, data, cssWidth, cssHeight, pixelRatio, view) {
    if (!canvas || !data) return;
    const sites = Array.isArray(data.sites) ? data.sites : [];
    const w = Math.max(1, Number(data.width) || 1);
    const h = Math.max(1, Number(data.height) || 1);
    // Fill the overlay (minus the button stack column) at device pixel ratio, matching the
    // full-bleed world canvas in 22-world.png (this replaces the WHOLE view, not a small panel).
    const dpr = Math.max(1, Number(pixelRatio) || 1);
    const cssW = Math.max(200, Number(cssWidth) || 200);
    const cssH = Math.max(200, Number(cssHeight) || 200);
    if (canvas.style && typeof canvas.style.setProperty === "function") {
      canvas.style.setProperty("--dwf-world-canvas-w", `${cssW}px`);
      canvas.style.setProperty("--dwf-world-canvas-h", `${cssH}px`);
    }
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#14110c";
    ctx.fillRect(0, 0, cssW, cssH);
    const layout = worldActiveLayout(data, view?.centre, cssW, cssH);
    const { scale, ox, oy } = layout;

    const terrain = decodeWorldTerrain(data.terrain);
    if (terrain) {
      const cell = terrain.step * scale;
      const cw = Math.ceil(cell) + 1; // +1 avoids hairline seams between cells
      for (let ty = 0; ty < terrain.h; ty++) {
        const row = terrain.rows[ty] || "";
        const py = oy + ty * terrain.step * scale;
        for (let tx = 0; tx < terrain.w; tx++) {
          const color = worldTerrainColor(row.charAt(tx));
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(ox + tx * terrain.step * scale, py, cw, Math.ceil(cell) + 1);
        }
      }
    } else {
      // No terrain data: draw the world bounds as an ocean-toned plate with a border so the sites
      // sit on an intentional map surface rather than a black void (client-side resilience).
      ctx.fillStyle = "#1b2836";
      ctx.fillRect(ox, oy, w * scale, h * scale);
    }
    // World-bounds frame (matches DF's bordered world plate; also orients the viewer).
    ctx.strokeStyle = "rgba(217,152,43,0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, w * scale - 1, h * scale - 1);

    for (const s of sites) {
      const px = ox + s.x * scale;
      const py = oy + s.y * scale;
      const r = s.own ? 5 : 2.5;
      if (s.own) {
        // Own fort: a filled marker with a bright ring so it stands out over terrain.
        ctx.fillStyle = worldSiteColor(s.type, true);
        ctx.fillRect(px - r, py - r, r * 2, r * 2);
        ctx.strokeStyle = "#fff3c4";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px - r - 1.5, py - r - 1.5, r * 2 + 3, r * 2 + 3);
      } else {
        ctx.fillStyle = worldSiteColor(s.type, false);
        ctx.fillRect(px - r, py - r, r * 2, r * 2);
      }
    }

    // Mission markers are placed in MID-LEVEL tiles so native's third-of-a-tile offset survives into pixels.
    const overlay = worldOverlayMarkers(data);
    for (const marker of overlay.markers) {
      const { px, py } = worldMltToPx(marker.mlt, layout);
      ctx.strokeStyle = "#ffd54f";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px - 4, py - 4); ctx.lineTo(px + 4, py + 4);
      ctx.moveTo(px + 4, py - 4); ctx.lineTo(px - 4, py + 4);
      ctx.stroke();
    }
  }

  // The fort's own tile, which is where "Center on fort" goes and where the view starts.
  function worldFortCentre(data) {
    const sites = Array.isArray(data?.sites) ? data.sites : [];
    const own = sites.find(site => site.own) || sites[0];
    if (!own) return null;
    return worldClampCentre(Number(own.x) || 0, Number(own.y) || 0, data?.width, data?.height);
  }

  function worldCenterOnFort() {
    const centre = worldFortCentre(worldMapData);
    if (centre) worldViewCentre = centre;
    drawWorldScreenCanvas();
  }

  function drawWorldScreenCanvas() {
    const canvas = document.getElementById("worldScreenCanvas");
    if (!worldViewCentre) worldViewCentre = worldFortCentre(worldMapData);
    const result = drawWorldCanvas(canvas, worldMapData, innerWidth - 4, innerHeight - 4,
      window.devicePixelRatio || 1, { centre: worldViewCentre });
    wireWorldSiteTooltip(canvas, worldMapData);
    wireWorldMapPan(canvas);
    return result;
  }

  // Repaint the hover card in place: re-rendering the shell on pointermove would rebuild the canvas and
  // drop every listener on it several times a second.
  function paintWorldHoverCard() {
    const mount = document.getElementById("worldHoverMount");
    if (!mount) return;
    mount.innerHTML = worldHoverCardHtml(worldMapData, worldHoverSiteId);
    // The hover card replaces the news list; `hidden` keeps the list mounted so its scroll position survives.
    const news = document.querySelector("#worldScreen .world-news-panel");
    if (news) news.hidden = worldPanelMode === "news" && worldHoverSiteId != null;
    DWFUI.mountDom(mount);
  }

  // Native puts ONE card in the top-right corner; it does not drag a card around under the pointer.
  function worldSiteHitTest(canvas, data, clientX, clientY, centre) {
    const sites = Array.isArray(data?.sites) ? data.sites : [];
    if (!canvas || !sites.length) return null;
    const rect = canvas.getBoundingClientRect();
    // The hit test MUST read the same layout the paint used, or the card and the marker disagree
    // the moment the map is panned -- the classic "clickable area drifts away from the art" bug.
    const layout = worldActiveLayout(data, centre, rect.width, rect.height);
    let closest = null, best = 81;
    for (const site of sites) {
      const dx = Number(clientX) - rect.left - (layout.ox + Number(site.x) * layout.scale);
      const dy = Number(clientY) - rect.top - (layout.oy + Number(site.y) * layout.scale);
      const distance = dx * dx + dy * dy;
      if (distance < best) { best = distance; closest = site; }
    }
    return closest;
  }

  function wireWorldSiteTooltip(canvas, data) {
    const sites = Array.isArray(data?.sites) ? data.sites : [];
    if (!canvas || !sites.length || canvas.dataset.worldSiteTooltipWired === "1") return;
    canvas.dataset.worldSiteTooltipWired = "1";
    const setHover = id => {
      if (worldHoverSiteId === id) return;   // only repaint when the hovered tile actually changed
      worldHoverSiteId = id;
      paintWorldHoverCard();
    };
    canvas.addEventListener("pointermove", event => {
      if (worldPanAnchor) return;   // a drag in flight is a pan, not a hover
      const site = worldSiteHitTest(canvas, data, event.clientX, event.clientY, worldViewCentre);
      setHover(site ? site.id : null);
    });
    canvas.addEventListener("click", event => {
      // Native enters NEW_MISSION only from NORMAL map mode. Reuse the exact hover hit-test so a
      // site's readable card and clickable area cannot disagree at marker edges.
      if (worldPanelMode !== null) return;
      // Do not consume-and-clear this bit here: every click listener must see the same gesture verdict.
      if (worldPanMoved) return;  // a drag that panned is not a click
      const site = worldSiteHitTest(canvas, data, event.clientX, event.clientY, worldViewCentre);
      if (site) openNewMissionAtSite(site.id);
    });
    canvas.addEventListener("pointerleave", () => setHover(null));
    // The keyboard path: focusing the map reads out the fort's own tile, so the card is reachable
    // without a mouse.
    canvas.addEventListener("focus", () => {
      const own = sites.find(site => site.own) || sites[0];
      setHover(own ? own.id : null);
    });
    canvas.addEventListener("blur", () => setHover(null));
  }

  // ---- The drag pan, wired: worldPanBegin / worldPanCentre own the arithmetic. ----
  // No lastX/lastY and no accumulator here on purpose -- see the anchor rule above.
  function createWorldPanGesture({ world, port, getCentre, setCentre, onChange }) {
    let anchor = null;
    let moved = false;
    return {
      get anchor() { return anchor; },
      get moved() { return moved; },
      down(event) {
        moved = false;
        anchor = worldPanBegin({
          mouseX: event.clientX, mouseY: event.clientY,
          centre: getCentre() || { x: 0, y: 0 }, port: port(), tracking: true,
        });
        return anchor;
      },
      move(event) {
        // ABSOLUTE FROM THE ANCHOR: there is deliberately no previous-position variable in this closure.
        if (!anchor) return null;
        const bounds = world();
        const next = worldPanCentre(anchor, event.clientX, event.clientY, bounds.width, bounds.height);
        if (!next) return null;
        const current = getCentre();
        if (current && next.x === current.x && next.y === current.y) return next;
        moved = true;
        setCentre(next);
        if (onChange) onChange(next);
        return next;
      },
      up() { anchor = null; },
    };
  }

  function wireWorldMapPan(canvas) {
    if (!canvas || canvas.dataset.worldPanWired === "1") return;
    canvas.dataset.worldPanWired = "1";
    const gesture = createWorldPanGesture({
      world: () => ({ width: worldMapData?.width, height: worldMapData?.height }),
      port: () => {
        const rect = canvas.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      },
      getCentre: () => worldViewCentre,
      setCentre: centre => { worldViewCentre = centre; worldPanMoved = true; },
      onChange: () => drawWorldScreenCanvas(),
    });
    canvas.addEventListener("pointerdown", event => {
      worldPanMoved = false;
      if (!worldViewCentre) worldViewCentre = worldFortCentre(worldMapData);
      worldPanAnchor = gesture.down(event);
      // A refused begin (off-screen press) leaves the anchor null, and every later move is then a
      // hover -- exactly native's behaviour, which is that no drag ever started.
      if (worldPanAnchor && canvas.setPointerCapture) {
        try { canvas.setPointerCapture(event.pointerId); }
        catch { return; }
      }
    });
    canvas.addEventListener("pointermove", event => { gesture.move(event); });
    const end = () => { gesture.up(); worldPanAnchor = null; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("lostpointercapture", end);
    // The keyboard pans through worldPanStep, so it lands on the same clamp as the drag.
    canvas.addEventListener("keydown", event => {
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!step) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!worldViewCentre) worldViewCentre = worldFortCentre(worldMapData);
      worldViewCentre = worldPanStep(worldViewCentre || { x: 0, y: 0 }, step[0], step[1],
        worldMapData?.width, worldMapData?.height);
      drawWorldScreenCanvas();
    });
    canvas.onwheel = event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const horizontal = Math.abs(Number(event.deltaX) || 0) > Math.abs(Number(event.deltaY) || 0);
      const delta = horizontal ? Number(event.deltaX) : Number(event.deltaY);
      if (!delta) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!worldViewCentre) worldViewCentre = worldFortCentre(worldMapData);
      worldViewCentre = worldPanStep(worldViewCentre || { x: 0, y: 0 },
        horizontal ? Math.sign(delta) : 0, horizontal ? 0 : Math.sign(delta),
        worldMapData?.width, worldMapData?.height);
      drawWorldScreenCanvas();
    };
  }

  if (typeof window !== "undefined") {
    window.openWorldMapPanel = openWorldMapPanel;
    window.worldScreenOpen = worldScreenOpen;
    window.addEventListener("resize", () => { if (worldScreenOpenState) drawWorldScreenCanvas(); });
  }

  // Node export for the offline fixture test; in the browser these are already ordinary globals.
  const WORLD_EXPORTS = { worldSiteColor, worldTerrainColor, decodeWorldTerrain, worldMapLayout, worldButtonRoute,
      worldScreenMarkup, worldCivsPanelHtml, worldMissionsPanelHtml, worldNewsPanelHtml, worldButtonsHtml, drawWorldCanvas,
      // F12 world-screen parity (all pure, so every rule below is checkable without a browser)
      WORLD_BUTTONS, WORLD_VIEW_MODE, worldPlaqueCount, worldPlaqueEnabled, worldViewModeCode,
      worldPlaqueStackVisible, worldMissionsOpenTarget, worldSiteHitTest, worldTruncate, worldTravelPhrase,
      worldSiteDiplomacy, worldHoverCardHtml, worldReportEntries, worldReportsBodyHtml,
      worldReportsPanelHtml, worldSiteKind,
      WORLD_PAN_PX_PER_TILE, WORLD_MLT_PER_TILE, WORLD_OVERLAY_MARKER_CAP, WORLD_OVERLAY_LINE_CAP,
      WORLD_TAB_KEYS, worldPanTrunc, worldClampCentre, worldPanBegin, worldPanCentre, worldPanStep,
      worldPortLayout, worldActiveLayout, worldFortCentre,
      worldSiteCentreTile, worldMissionPositionMlt, worldMltToPx, worldOverlayMarkers,
      worldInitialTabState, worldResetTabScroll, worldTabPress, createWorldPanGesture,
      worldGridRows,
      worldCivDetailBlocksHtml, worldNewsRowHtml, worldReportPlaybackState, worldReportPlaybackHtml };

  if (typeof module !== "undefined" && module.exports) module.exports = WORLD_EXPORTS;
  if (typeof window !== "undefined") window.DFWorldMapMarkup = { worldScreenMarkup, worldCivsPanelHtml, worldMissionsPanelHtml, worldNewsPanelHtml, worldButtonsHtml, drawWorldCanvas, worldButtonRoute, worldReportsPanelHtml, worldHoverCardHtml };
