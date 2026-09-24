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

  // ---- DF-style toolbar sprites and designation menu ----
  let stockPreset = null;
  let stockRepaintId = null;
  let stockRepaintMeta = null;        // {label}: session heading for the selected pile
  let stockRepaintDraft = null;       // {zone:{x,y,z,w,h,extents}, changes: Map<string,bool>}
  let stockRepaintFreeCells = null;   // per-drag free-paint stroke cells, or null when idle
  let stockRepaintFreeLast = null;
  let stockRepaintEraseArmed = false; // session erase tool (distinct from stockEraseArmed below,
  let stockRepaintRemoveArmed = false;// which drives the new-pile submenu's immediate trim)
  let zoneRepaintId = null;
  let zoneRepaintMeta = null;    // {label}: native repaint-session heading for the selected zone
  // Each entry is the desired FINAL membership for "worldX,worldY", so mixed add/erase strokes and
  // an interior hole stay representable; the source zone is untouched until Accept.
  let zoneRepaintDraft = null;   // {zone, changes: Map<string,bool>}, committed only by Accept
  let zoneRepaintFreeCells = null;
  let zoneRepaintFreeLast = null;
  let stockMode = null;
  let stockEraseArmed = false;  // erase tool armed: drag re-paints (trims) an EXISTING pile
  let stockRemoveArmed = false; // remove-existing tool armed: click a pile to delete it
  let stockPileId = -1;         // id of the in-progress NEW pile this paint session, or -1
  let stockPileBBox = null;     // running world-tile bbox {x1,y1,x2,y2} painted so far
  let stockFreeBBox = null;     // bbox accumulated during one in-progress free-paint drag
  let zonePreset = null;
  let zoneMode = null;
  let zoneEraseArmed = false;    // erase tool armed: drag trims an EXISTING zone (/zone-repaint mode=erase)
  let zoneRemoveArmed = false;   // remove-existing tool armed: click a zone to delete it
  // The zone a new-zone session created on its first stroke and keeps growing.
  let zoneLiveId = null;
  let zonePaintPreview = null;   // live + retained grid rect rendered by core's shared overlay
  let zoneFreeBBox = null;       // bbox accumulated during one in-progress free-paint drag
  let burrowMode = null;
  let burrowPaintId = -1;
  let burrowEraseArmed = false;
  let burrowFreeCells = null;    // per-drag dedup set for burrow free-paint, or null when idle
  let burrowFreeLast = null;
  // Armed squad id, or -1 when not armed.
  let squadMoveArmed = -1;
  let squadKillArmed = -1;
  let squadPatrolArmed = -1;
  let wsLinkArmed = null;
  let leverLinkArmed = null;
  let chatPingArmed = false;
  let haulingMode = null;
  let haulingStopArmedRoute = -1;
  let haulingLinkArmed = null;
  // Which route/stop currently has its name field open.
  let haulingRenamingRouteId = -1;
  let haulingRenamingStopKey = "";
  let currentTool = null; // backend-supported paint tool, or null for inspect/pan mode
  let selectedDesignation = null; // visual selection, including tools not wired yet
  const GESTURE = (typeof window !== "undefined" && window.DwfGesture) || null;
  function gestureArm(family, sel) {
    try { return GESTURE ? GESTURE.arm(family, sel) : null; } catch { return null; }
  }
  function gestureArmed(family) {
    try { return GESTURE ? GESTURE.armed(family) : null; } catch { return null; }
  }
  function gestureClear(family) {
    try { return GESTURE ? GESTURE.clear(family) : false; } catch { return false; }
  }
  function desigAnchor() { return gestureArmed("designation"); }
  let twoClickCursor = null;
  let digMenuOpen = false;
  let plantMenuOpen = false;
  let smoothMenuOpen = false;
  // item/building designations submenu (claim/forbid/dump/undump/melt/unmelt/hide/unhide).
  let itemDesigMenuOpen = false;
  let digPriority = 4;
  let markerMode = false;
  let digMineMode = 0;
  let advOpen = false;
  const PAINT_MODES = (typeof window !== "undefined" && window.DwfPaintModes) || null;
  // This order MUST agree with paintGestureFamily()'s, or the rect/free button writes one
  // subsystem's paint mode while the next gesture reads another's.
  function activePaintSubsystem() {
    if (zoneMode || zonePreset || zoneRepaintId != null || zoneEraseArmed || zoneRemoveArmed) return "zone";
    if (burrowMode || burrowPaintId >= 0) return "burrow";
    if (stockMode || stockPreset || stockRepaintId != null || stockEraseArmed || stockRemoveArmed) return "stockpile";
    return "designation";
  }
  function paintModeOf(subsystem) {
    try { return PAINT_MODES ? PAINT_MODES.get(subsystem) : "rect"; } catch { return "rect"; }
  }
  function setPaintModeOf(subsystem, mode) {
    try { if (PAINT_MODES) PAINT_MODES.set(subsystem, mode); }
    catch (err) { DwfErr.report("designation.paint-mode-set", err); }
  }
  let trafficLevel = "high";
  function placementActive() {
    return !!(currentTool || selectedDesignation || stockPreset || stockRepaintId ||
              zoneRepaintId || stockEraseArmed || stockRemoveArmed || window.bipSelBuild() || zonePreset ||
              zoneEraseArmed || zoneRemoveArmed || (burrowPaintId >= 0) ||
              (haulingStopArmedRoute >= 0) || !!haulingLinkArmed || squadMoveArmed >= 0 || squadKillArmed >= 0 || squadPatrolArmed >= 0 ||
              !!wsLinkArmed || !!leverLinkArmed);
  }
  let lastPlacementMode = null;
  function placementModeForActiveTool(active) {
    if (!active) return "none";
    return window.bipSelBuild() ? "build" : "dig";
  }
  function updatePlacementMode() {
    const active = placementActive();
    const mode = placementModeForActiveTool(active);
    if (mode === lastPlacementMode) return;
    lastPlacementMode = mode;
    // Hot path (every tool change / cursor move): count only. A rejected fetch and a non-2xx are the
    // same loss to this counter -- `fetch` rejects on network failure alone, never on HTTP 500.
    fetch(`/placement-mode?player=${encodeURIComponent(player)}&mode=${mode}`,
          { method: "POST", cache: "no-store" })
      .then(r => { if (!r || !r.ok) DwfErr.count("placement.mode-post"); })
      .catch(() => DwfErr.count("placement.mode-post"));
    if (!active) sendPlacementUi(-1, -1, 0, 0, false, 0, 0); // clear cursor/rect on deselect
  }
  let lastUiSend = 0;
  function sendPlacementUi(hx, hy, w, h, drag, dx, dy, force) {
    const now = performance.now();
    if (!force && now - lastUiSend < 55) return;
    lastUiSend = now;
    const bw = (window.bipSelBuild() && window.bipSelBuild().size && window.bipSelBuild().size.w) || 0;
    const bh = (window.bipSelBuild() && window.bipSelBuild().size && window.bipSelBuild().size.h) || 0;
    const q = `player=${encodeURIComponent(player)}&hx=${hx}&hy=${hy}&w=${w}&h=${h}` +
              `&drag=${drag ? 1 : 0}&dx=${dx}&dy=${dy}&bw=${bw}&bh=${bh}`;
    fetch(`/placement-cursor?${q}`, { method: "POST", cache: "no-store" })
      .then(r => { if (!r || !r.ok) DwfErr.count("placement.cursor-post"); })
      .catch(() => DwfErr.count("placement.cursor-post"));
  }
  function sendTwoClickPresence(cur, force) {
    if (!cur) return;
    const rendered = twoClickArmed() && (typeof renderedImageRect === "function")
      ? renderedImageRect() : null;
    if (!rendered || !desigAnchor()) {
      sendPlacementUi(cur.x, cur.y, cur.w, cur.h, false, 0, 0, force);
      return;
    }
    const ox = Number(rendered.ox), oy = Number(rendered.oy);
    const cwx = ox + cur.x, cwy = oy + cur.y;               // cursor in world coords
    const a = desigAnchor();
    const awx = Math.abs(cwx - a.x1) >= Math.abs(cwx - a.x2) ? a.x1 : a.x2;
    const awy = Math.abs(cwy - a.y1) >= Math.abs(cwy - a.y2) ? a.y1 : a.y2;
    const ax = Math.max(0, Math.min(cur.w - 1, awx - ox));
    const ay = Math.max(0, Math.min(cur.h - 1, awy - oy));
    sendPlacementUi(cur.x, cur.y, cur.w, cur.h, true, ax, ay, force);
  }
  function updateToolCursor() {
    if (stockMode && (currentTool || selectedDesignation || window.bipSelBuild() || zonePreset)) {
      window.closeStockMode();
    }
    // Same one-way auto-close for zone/burrow modes when any other placement tool activates.
    if (zoneMode && (currentTool || selectedDesignation || window.bipSelBuild() || stockMode ||
                     stockRepaintId)) {
      window.closeZoneMode();
    }
    if (burrowMode && (currentTool || selectedDesignation || window.bipSelBuild() || stockMode ||
                       stockRepaintId || zoneMode || haulingMode)) {
      window.closeBurrowMode();
    }
    if (haulingMode && (currentTool || selectedDesignation || window.bipSelBuild() || stockMode ||
                        stockRepaintId || zoneMode || burrowMode)) {
      window.closeHaulingMode();
    }
    view.dataset.dwfCursor = (currentTool || stockPreset || stockRepaintId || zoneRepaintId || stockEraseArmed ||
                          stockRemoveArmed || window.bipSelBuild() || zonePreset || zoneEraseArmed ||
                          zoneRemoveArmed || burrowPaintId >= 0 || squadMoveArmed >= 0 || squadKillArmed >= 0 || squadPatrolArmed >= 0 ||
                          haulingStopArmedRoute >= 0 || haulingLinkArmed || wsLinkArmed || leverLinkArmed || chatPingArmed) ? "crosshair" : "default";
    updatePlacementMode();
  }
  // Semantic control-shell keys for tiles whose selected state lives in a DF _ACTIVE sprite.
  const DIG_MODE_SPRITES = ["digModeAll", "digModeAuto", "digModeOre", "digModeGem"];
  const TRAFFIC_SPRITES = { high:"trafficHigh", normal:"trafficNormal", low:"trafficLow", restricted:"trafficRestricted" };
  let submenuAlignmentScheduled = false;
  function paintSprite(button, key, active = false) {
    const painted = window.DwfControlShell.paintSprite(button, key, active);
    if (!submenuAlignmentScheduled) {
      submenuAlignmentScheduled = true;
      requestAnimationFrame(() => {
        submenuAlignmentScheduled = false;
        window.DwfControlShell.alignControlSubmenus(document);
      });
    }
    return painted;
  }
  const TBICON = {
    citizens:"citizens", labor:"labor", locations:"locations", orders:"orders",
    workorders:"workorders", nobles:"nobles", objects:"objects", justice:"justice",
    build:"build", stockpile:"stockpile", zone:"zone", squads:"squads", worldmap:"worldmap"
  };
  function submenuOpenFor(key) {
    if (key === "stockpile") return !!stockMode;
    if (key === "zone") return !!zoneMode;
    return false;
  }
  let toolbarActiveName = "";
  function refreshToolbarSprites(activeName = "") {
    toolbarActiveName = activeName || "";
    repaintToolbarSprites();
  }
  // The mode flags flip AFTER setActiveToolbar() has already run (openPanel calls it first), so the
  // lowered-menu art has to be repaintable without re-deciding which panel is active.
  function repaintToolbarSprites() {
    document.querySelectorAll("#bottomBar [data-panel], #bottomBar [data-action]").forEach(button => {
      const key = button.dataset.panel || button.dataset.action;
      if (!TBICON[key]) return;
      const lowered = submenuOpenFor(key);
      paintSprite(button, lowered ? "lowerMenu" : TBICON[key], lowered || key === toolbarActiveName);
    });
  }
  refreshToolbarSprites();

  // Per-button hover text + the "Hotkey: X" line. `hotkey` is the single character DF's own tooltip
  // prints -- a bare letter whose case carries the shift state, never a "Shift+X" label of our own.
  const TOOLBAR_TOOLTIPS = {
    citizens: { text: "Citizen and creature information.", hotkey: "u", verified: true },
    orders: { text: "Fortress job list.", hotkey: "t", verified: true },
    locations: { text: "Place information.", hotkey: "P", verified: false },
    labor: { text: "Labor management.", hotkey: "y", verified: false },
    workorders: { text: "Open the work orders menu.", hotkey: "o", verified: true },
    nobles: { text: "Nobles and administrators.", hotkey: "n", verified: false },
    objects: { text: "Objects: artifacts, symbols, named items, written content.", hotkey: "O", verified: false },
    justice: { text: "Justice.", hotkey: "j", verified: false },  // DF's real D_JUSTICE key.
    digMenu: { text: "Finish setting dig orders.", hotkey: "m", verified: true },
    chop: { text: "Set tree chopping orders.", hotkey: "l", verified: false },  // DF's real D_DESIGNATE_CHOP key.
    gather: { text: "Set plant gathering orders.", hotkey: "g", verified: false },
    smooth: { text: "Finish setting wall orders.", hotkey: "v", verified: true },
    erase: { text: "Erase designations.", hotkey: "x", verified: false },
    build: { text: "Finish placing structures.", hotkey: "b", verified: true },
    stockpile: { text: "Finish placing stockpiles.", hotkey: "p", verified: true },
    zone: { text: "Designate a zone.", hotkey: "z", verified: false },
    burrow: { text: "Finish establishing burrows.", hotkey: "U", verified: true },
    hauling: { text: "Finish setting hauling routes.", hotkey: "h", verified: false },  // DF's real D_HAULING key.
    traffic: { text: "Set traffic designations.", hotkey: "T", verified: false },
    itemdesig: { text: "Designate items for dumping and melting, claim forbidden items and buildings, and set item visibility.", hotkey: "i", verified: true },
    squads: { text: "Military and squads.", hotkey: "q", verified: false },  // DF's real D_SQUADS key.
    worldmap: { text: "World and civilizations.", hotkey: "Y", verified: false }
    // "stocks" (D_STOCKS, hotkey k) is absent on purpose: its button lives in #topbar, not
    // #bottomBar, and carries its own title attribute in index.html.
  };
  window.DFToolbarTooltips = TOOLBAR_TOOLTIPS;
  function applyToolbarTooltips() {
    document.querySelectorAll("#bottomBar [data-df-btn]").forEach(button => {
      const key = button.dataset.panel || button.dataset.modeTool ||
                   (button.hasAttribute("data-dig-menu") ? "digMenu" : button.dataset.designationTool);
      const entry = key && TOOLBAR_TOOLTIPS[key];
      if (!entry) return;
      button.title = entry.hotkey ? `${entry.text}\nHotkey: ${entry.hotkey}` : entry.text;
    });
  }
  applyToolbarTooltips();

  const digSubmenu = document.getElementById("digSubmenu");
  const plantSubmenu = document.getElementById("plantSubmenu");
  const smoothSubmenu = document.getElementById("smoothSubmenu");
  const itemDesigSubmenu = document.getElementById("itemDesigSubmenu");
  const trafficSubmenu = document.getElementById("trafficSubmenu");

  const TRAFFIC_COST_DEFAULTS = { high: 1, normal: 2, low: 5, restricted: 25 };
  const trafficCosts = { ...TRAFFIC_COST_DEFAULTS };
  let trafficCostsLoaded = false;   // lazy: read DF's live costs the first time traffic mode opens
  if (trafficSubmenu && window.DwfControlShell &&
      typeof window.DwfControlShell.trafficSubmenuMarkup === "function" &&
      !trafficSubmenu.querySelector("[data-traffic-level]")) {
    trafficSubmenu.innerHTML = window.DwfControlShell.trafficSubmenuMarkup({
      level: "high", paintMode: "rect", weights: trafficCosts, advanced: advOpen,
    });
  }

  const digMenuButton = document.querySelector("[data-dig-menu]");

  // ---- palette DOM the shipped index.html does not have ------------------------------------
  try {
    if (window.DWFUI && DWFUI.hydrateDesignationPalettes)
      DWFUI.hydrateDesignationPalettes(document, TRAFFIC_COST_DEFAULTS);
  } catch (err) { DwfErr.report("designation.palette-hydrate", err); }
  const eraseSubmenu = document.getElementById("eraseSubmenu");


  // ---- the two geometry passes, both in DWFUI -------------------------------------------------
  function layoutDesignationPalettes() {
    try { if (window.DWFUI && DWFUI.mountDesignationPalettes) DWFUI.mountDesignationPalettes(document); }
    catch (err) { DwfErr.report("designation.palette-mount", err); }
  }
  function alignDesignationPalettes() {
    try { if (window.DWFUI && DWFUI.placeDesignationPalettes) return DWFUI.placeDesignationPalettes(document); }
    catch (err) { DwfErr.report("designation.palette-place", err); }
    return {};
  }
  layoutDesignationPalettes();
  window.addEventListener("resize", alignDesignationPalettes);


  function designationPaletteOpen() {
    return Object.keys((window.DWFUI && DWFUI.DESIGNATION_PALETTES) || {})
      .some(id => {
        const host = document.getElementById(id);
        return !!host && host.classList.contains("visible");
      });
  }
  function paletteAnchorFor(target) {
    if (!target || !target.closest) return null;
    const btn = target.closest("#bottomBar [data-df-btn]");
    if (!btn) return null;
    const open = Object.keys((window.DWFUI && DWFUI.DESIGNATION_PALETTES) || {})
      .map(id => document.getElementById(id))
      .find(host => host && host.classList.contains("visible"));
    if (!open) return null;
    const r = btn.getBoundingClientRect();
    // getBoundingClientRect ignores the negatively-offset traffic bands (they overflow the host),
    // so take the union with whatever the palette actually drew above itself.
    let top = Math.min(r.top, open.getBoundingClientRect().top);
    open.querySelectorAll("[data-traffic-band]").forEach(band => {
      const b = band.getBoundingClientRect();
      if (b.height > 0 && b.top < top) top = b.top;
    });
    return { left: r.left, top, right: r.right, bottom: r.bottom };
  }
  try {
    if (window.DFTooltip && window.DFTooltip.provideAnchor)
      window.DFTooltip.provideAnchor(paletteAnchorFor);
  } catch (err) { DwfErr.report("designation.tooltip-anchor", err); }

  const digTools = new Set(["dig", "stairs", "ramp", "channel", "remove",
                             "convertmarker", "convertstandard"]);
  const rangeDesignationTools = new Set([
    "dig", "stairs", "ramp", "channel", "remove", "erase",
    "convertmarker", "convertstandard", "chop", "gather",
    "smooth", "engrave", "track", "fortify", "traffic",
    "claim", "forbid", "dump", "undump", "melt", "unmelt", "hide", "unhide"
  ]);
  const plantTools = new Set(["chop", "gather"]);
  const smoothTools = new Set(["smooth", "engrave", "track", "fortify"]);
  // Wire tool= names are DF's own raw-token verbs, not the spec prose's shorthand.
  const itemDesigTools = new Set(["claim", "forbid", "dump", "undump", "melt", "unmelt", "hide", "unhide"]);
  function backendToolFor(tool) {
    if (tool === "traffic") return `traffic-${trafficLevel}`;
    return ({ dig:"dig", stairs:"stairs",
              ramp:"ramp", channel:"channel", remove:"remove-construction",
              erase:"clear", chop:"chop", gather:"gather", smooth:"smooth",
              engrave:"engrave", track:"track", fortify:"fortify",
              "convertmarker":"convert-to-marker", "convertstandard":"convert-to-standard",
              claim:"claim", forbid:"forbid", dump:"dump", undump:"undump",
              melt:"melt", unmelt:"unmelt", hide:"hide", unhide:"unhide" })[tool] || null;
  }
  const TOOL_MODE_LABELS = {
    dig: "Regular mining: click the first corner",
    stairs: "Dig stairs: select the first z-level",
    ramp: "Dig ramps: click the first corner",
    channel: "Dig channels: click the first corner",
    remove: "Remove constructions: click the first corner",
    convertmarker: "Converting to marker mode",
    convertstandard: "Converting to standard mode",
    // erase uses the two-click z-range gesture; the pending-state variant comes from updateToolModeLabel().
    erase: "Erase designations: click the first corner",
    chop: "Chopping trees",
    gather: "Gathering fruit and leaves",
    smooth: "Smoothing rough floors and walls",
    engrave: "Engraving smooth walls",
    track: "Carving minecart tracks",
    fortify: "Carving fortifications",
    claim: "Claiming forbidden items and buildings",
    forbid: "Forbidding items and buildings",
    dump: "Designating items for dumping",
    undump: "Cancelling dump designations",
    melt: "Designating items for melting",
    unmelt: "Cancelling melt designations",
    unhide: "Setting items visible",
    hide: "Hiding items",
    traffic: "Designating high traffic area"
  };
  const toolModeLabel = document.getElementById("toolModeLabel");
  function updateToolModeLabel() {
    if (!toolModeLabel) return;
    // erase has no submenu of its own, so it must be named here explicitly to get z-range guidance.
    const rangePending = rangeDesignationTools.has(selectedDesignation) && desigAnchor();
    const baseLabel = TOOL_MODE_LABELS[selectedDesignation];
    const label = (digMenuOpen || plantMenuOpen || smoothMenuOpen || itemDesigMenuOpen ||
                   selectedDesignation === "erase" || selectedDesignation === "traffic")
      ? (rangePending
          ? (selectedDesignation === "stairs"
              ? "Dig stairs: select the other z-level"
              : `${baseLabel.split(":")[0]}: click the opposite corner (Shift+wheel spans z-levels)`)
          : `${baseLabel}. Shift+wheel changes elevation`) : null;
    toolModeLabel.textContent = label || "";
    toolModeLabel.classList.toggle("visible", !!label);
  }
  function updateDesignationButtons() {
    const inMineMode = digMenuOpen || digTools.has(selectedDesignation);
    try { if (window.DwfTiles && window.DwfTiles.setMineMode) window.DwfTiles.setMineMode(inMineMode); }
    catch { DwfErr.count("designation.tiles-mine-mode"); }
    try { if (window.DwfGL && window.DwfGL.setMineMode) window.DwfGL.setMineMode(inMineMode); }
    catch { DwfErr.count("designation.gl-mine-mode"); }
    // Native draws traffic marks ONLY while a traffic paint mode is the active tool. This is the same
    // expression that opens the traffic submenu below, so overlay and menu cannot disagree.
    const inTrafficMode = selectedDesignation === "traffic";
    try { if (window.DwfTiles && window.DwfTiles.setToolStateOverlay) window.DwfTiles.setToolStateOverlay("traffic", inTrafficMode); }
    catch { DwfErr.count("designation.tiles-traffic-mode"); }
    try { if (window.DwfGL && window.DwfGL.setToolStateOverlay) window.DwfGL.setToolStateOverlay("traffic", inTrafficMode); }
    catch { DwfErr.count("designation.gl-traffic-mode"); }

    digSubmenu.classList.toggle("visible", digMenuOpen);
    digSubmenu.setAttribute("aria-hidden", digMenuOpen ? "false" : "true");
    plantSubmenu.classList.toggle("visible", plantMenuOpen);
    plantSubmenu.setAttribute("aria-hidden", plantMenuOpen ? "false" : "true");
    smoothSubmenu.classList.toggle("visible", smoothMenuOpen);
    smoothSubmenu.setAttribute("aria-hidden", smoothMenuOpen ? "false" : "true");
    itemDesigSubmenu.classList.toggle("visible", itemDesigMenuOpen);
    itemDesigSubmenu.setAttribute("aria-hidden", itemDesigMenuOpen ? "false" : "true");
    // erase has a lower menu of its own (the paint pair), on the same rule as every other tool.
    if (eraseSubmenu) {
      const open = selectedDesignation === "erase";
      eraseSubmenu.classList.toggle("visible", open);
      eraseSubmenu.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (trafficSubmenu) {
      const open = selectedDesignation === "traffic";
      if (open && !trafficCostsLoaded) { trafficCostsLoaded = true; loadTrafficCosts(); }
      trafficSubmenu.classList.toggle("visible", open);
      trafficSubmenu.setAttribute("aria-hidden", open ? "false" : "true");
      // Each traffic level is a real DF sprite whose _ACTIVE variant carries the selection.
      trafficSubmenu.querySelectorAll("[data-traffic-level]").forEach(button =>
        paintSprite(button, TRAFFIC_SPRITES[button.dataset.trafficLevel] || "trafficHigh",
                    button.dataset.trafficLevel === trafficLevel));
    }
    paintSprite(digMenuButton, digMenuOpen ? "lowerMenu" : "digMenu", digMenuOpen || digTools.has(selectedDesignation));
    document.querySelectorAll("[data-dig-tool]").forEach(button => {
      const tool = button.dataset.digTool;
      paintSprite(button, tool, selectedDesignation === tool);
    });
    document.querySelectorAll("[data-plant-tool]").forEach(button => {
      const tool = button.dataset.plantTool;
      button.hidden = plantMenuOpen && selectedDesignation !== tool;
      paintSprite(button, tool, selectedDesignation === tool);
    });
    document.querySelectorAll("[data-smooth-tool]").forEach(button => {
      const tool = button.dataset.smoothTool;
      paintSprite(button, tool, selectedDesignation === tool);
    });
    // All 8 item-designation buttons stay visible together, one of them highlighted.
    document.querySelectorAll("[data-itemdesig-tool]").forEach(button => {
      const tool = button.dataset.itemdesigTool;
      paintSprite(button, tool, selectedDesignation === tool);
    });
    document.querySelectorAll("[data-designation-tool]").forEach(button => {
      const tool = button.dataset.designationTool;
      if (tool === "chop" || tool === "gather") {
        const openForTool = plantMenuOpen && selectedDesignation === tool;
        paintSprite(button, openForTool ? "lowerMenu" : tool, openForTool || selectedDesignation === tool);
        return;
      }
      if (tool === "smooth") {
        paintSprite(button, smoothMenuOpen ? "lowerMenu" : "smooth",
                    smoothMenuOpen || smoothTools.has(selectedDesignation));
        return;
      }
      let active = selectedDesignation === tool;
      paintSprite(button, tool, active);
    });
    document.querySelectorAll("[data-mode-tool]").forEach(button => {
      const tool = button.dataset.modeTool;
      if (tool === "itemdesig") {
        const openForTool = itemDesigMenuOpen && itemDesigTools.has(selectedDesignation);
        paintSprite(button, openForTool ? "lowerMenu" : "itemdesig", openForTool || itemDesigTools.has(selectedDesignation));
        return;
      }
      // The burrow button highlights and lowers while burrow MODE is open: it is a mode, not a tool.
      if (tool === "burrow") {
        const open = !!burrowMode;
        paintSprite(button, open ? "lowerMenu" : "burrow", open);
        return;
      }
      if (tool === "hauling") {
        const open = !!haulingMode;
        paintSprite(button, open ? "lowerMenu" : "hauling", open);
        return;
      }
      if (tool === "traffic") {
        const open = selectedDesignation === "traffic";
        paintSprite(button, open ? "lowerMenu" : "traffic", open);
        return;
      }
      paintSprite(button, tool, selectedDesignation === tool);
    });
    repaintToolbarSprites();   // stockpile/zone lower to BUTTON_LOWER_MENU while their menu is open
    // Priority / dig-mode selection is carried by the sprite's _ACTIVE variant
    // (BUTTON_PRIORITY_n_ACTIVE, BUTTON_DIG_MODE_*_ACTIVE), never by a colour fill of our own.
    document.querySelectorAll("[data-dig-prio]").forEach(b =>
      paintSprite(b, `prio${Number(b.dataset.digPrio)}`, Number(b.dataset.digPrio) === digPriority));
    document.querySelectorAll("[data-dig-opt]").forEach(b => {
      if (b.dataset.digOpt === "marker") {
        paintSprite(b, "markerToggle", markerMode);
      }
    });
    document.querySelectorAll("[data-dig-mode]").forEach(b =>
      paintSprite(b, DIG_MODE_SPRITES[Number(b.dataset.digMode)] || "digModeAll",
                  Number(b.dataset.digMode) === digMineMode));
    document.querySelectorAll("[data-paint-mode]").forEach(b => {
      const mode = b.dataset.paintMode;
      paintSprite(b, mode === "free" ? "paintFree" : "paintRect", paintModeOf(activePaintSubsystem()) === mode);
    });
    updateToolModeLabel();
    // The expander is BUTTON_EXPANDER_CLOSED / _OPEN art, not a rotated glyph.
    const setExpander = (button, open) => {
      if (!button) return;
      button.classList.toggle("open", open);
      paintSprite(button, "expander", open);
    };
    // ONE flag drives every wing and every expander.
    document.querySelectorAll(".dig-adv").forEach(wing => wing.classList.toggle("open", advOpen));
    document.querySelectorAll("[data-dig-expand], [data-plant-expand], [data-smooth-expand]")
      .forEach(button => setExpander(button, advOpen));
    if (trafficSubmenu) {
      const trafficAdv = trafficSubmenu.querySelector(".traffic-adv");
      if (trafficAdv) trafficAdv.classList.toggle("open", advOpen);
      const trafficExpand = trafficSubmenu.querySelector("[data-traffic-expand]");
      setExpander(trafficExpand, advOpen);
      if (trafficExpand) trafficExpand.title = advOpen ? "Hide advanced options." : "Show advanced options.";
      trafficSubmenu.querySelectorAll("[data-traffic-band-icon]").forEach(icon =>
        paintSprite(icon, TRAFFIC_SPRITES[icon.dataset.trafficBandIcon] || "trafficHigh", false));
    }
    // Re-stamp the decoded columns and re-run the shove now that visibility is settled; both are idempotent.
    layoutDesignationPalettes();
    alignDesignationPalettes();
    updateToolCursor();
  }
  // Entering a designation tool is a hard modal switch: every back-out level outside
  // DESIGNATION_OWNED_FLOWS is popped, whether or not it is currently occupied.
  const DESIGNATION_OWNED_FLOWS = new Set(["designations", "paint-gesture", "screen-stack"]);
  function tearDownForDesignation() {
    let levels;
    try { levels = (window.MODE_STACK && window.MODE_STACK.all()) || []; }
    catch (err) { DwfErr.report("mode-stack.read", err); return; }
    levels
      .filter(level => level && !DESIGNATION_OWNED_FLOWS.has(level.flow))
      .sort((a, b) => (b.depth || 0) - (a.depth || 0))   // deepest first, exactly as Escape walks it
      .forEach(level => { try { window.MODE_STACK.popLevel(level.id, "designation-entered"); }
        catch (err) { DwfErr.report("mode-stack.pop-level", err); } });
  }
  function selectDesignation(tool) {
    clearBuildPlacement(false);
    window.closeStockMode();  // also cancels any armed existing-pile repaint
    window.closeZoneMode();
    window.closeBurrowMode();
    tearDownForDesignation();

    if (tool !== selectedDesignation) {
      gestureClear("designation");
      stairRangePreview = null;
      twoClickCursor = null;
      renderZoneOverlay();
    }
    selectedDesignation = tool;
    currentTool = backendToolFor(tool);
    digMenuOpen = digMenuOpen && digTools.has(tool);
    plantMenuOpen = plantMenuOpen && plantTools.has(tool);
    smoothMenuOpen = smoothMenuOpen && smoothTools.has(tool);
    itemDesigMenuOpen = itemDesigMenuOpen && itemDesigTools.has(tool);
    updateDesignationButtons();
  }
  digMenuButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (digMenuOpen) {
      // Closing the dig menu also deselects the tool (so the designation grid clears).
      digMenuOpen = false;
      selectedDesignation = null;
      currentTool = null;
      gestureClear("designation");
      stairRangePreview = null;
      twoClickCursor = null;
      renderZoneOverlay();
    } else {
      digMenuOpen = true;
      plantMenuOpen = false;
      smoothMenuOpen = false;
      itemDesigMenuOpen = false;
      if (!digTools.has(selectedDesignation))
        selectedDesignation = "dig";
      currentTool = backendToolFor(selectedDesignation);
    }
    updateDesignationButtons();
    focusPage();
  });
  document.querySelectorAll("[data-dig-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      // The marker-convert buttons carry data-dig-tool in the plant and smooth palettes too
      // (DWFUI.hydrateDesignationPalettes), so keep the palette that owns the clicked button open.
      const owner = button.closest(".tool-group");
      const ownerId = (owner && owner.id) || "digSubmenu";
      digMenuOpen = ownerId === "digSubmenu";
      plantMenuOpen = false;
      smoothMenuOpen = false;
      itemDesigMenuOpen = false;
      selectDesignation(button.dataset.digTool);
      if (ownerId === "plantSubmenu") { plantMenuOpen = true; updateDesignationButtons(); }
      else if (ownerId === "smoothSubmenu") { smoothMenuOpen = true; updateDesignationButtons(); }
      focusPage();
    });
  });
  // The paint-mode pair picks how the NEXT drag is read; it changes no tool and closes no menu.
  document.querySelectorAll("[data-paint-mode]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const paintSubsystem = activePaintSubsystem();
      gestureClear(paintSubsystem);
      setPaintModeOf(paintSubsystem, button.dataset.paintMode === "free" ? "free" : "rect");
      // Clicking rect/free inside the stockpile paint submenu re-arms new-pile paint.
      if (stockMode === "paint") {
        stockEraseArmed = false;
        stockRemoveArmed = false;
        stockPreset = true;
        window.updateStockButtons();
      }
      // Same re-arm inside the zone paint submenu (shared button, shared listener).
      if (zoneMode === "paint") {
        zoneEraseArmed = false;
        zoneRemoveArmed = false;
        window.updateZoneButtons();
      }
      updateDesignationButtons();
      focusPage();
    });
  });
  document.querySelectorAll("[data-plant-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      digMenuOpen = false;
      plantMenuOpen = true;
      smoothMenuOpen = false;
      itemDesigMenuOpen = false;
      selectDesignation(button.dataset.plantTool);
      focusPage();
    });
  });
  document.querySelectorAll("[data-smooth-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      digMenuOpen = false;
      plantMenuOpen = false;
      smoothMenuOpen = true;
      itemDesigMenuOpen = false;
      selectDesignation(button.dataset.smoothTool);
      focusPage();
    });
  });
  // item/building designation tool buttons: armDesignation opens this menu and closes the others.
  document.querySelectorAll("[data-itemdesig-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      window.armDesignation("itemdesig", button.dataset.itemdesigTool);
      focusPage();
    });
  });
  document.querySelectorAll("[data-traffic-level]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      trafficLevel = ["high", "normal", "low", "restricted"].includes(button.dataset.trafficLevel)
        ? button.dataset.trafficLevel : "high";
      selectedDesignation = "traffic";
      currentTool = backendToolFor("traffic");
      updateDesignationButtons();
      focusPage();
    });
  });

  function paintTrafficCostOutputs() {
    if (!trafficSubmenu) return;
    trafficSubmenu.querySelectorAll("[data-traffic-weight]").forEach(input => {
      const key = input.dataset.trafficWeight;
      const value = Number(trafficCosts[key]);
      if (!Number.isFinite(value)) return;
      // /traffic-costs clamps writes to 1..100; widen the track rather than let a larger value read
      // back from the host display as the track's max.
      if (value > Number(input.max || 100)) input.max = String(value);
      input.value = String(value);
      // The band's second control is an ENTRY BOX, not a readout: it mirrors the track and can set it.
      const entry = trafficEntryFor(key);
      if (entry) { entry.value = String(value); entry.classList.remove("traffic-cost-rejected"); }
    });
  }
  function trafficEntryFor(key) {
    return trafficSubmenu && trafficSubmenu.querySelector(`[data-traffic-entry="${key}"]`);
  }
  function setTrafficCostNote(text, isError, key) {
    const note = trafficSubmenu && trafficSubmenu.querySelector("[data-traffic-cost-note]");
    if (note) note.textContent = text || "";
    if (!key) return;
    const entry = trafficEntryFor(key);
    if (!entry) return;
    entry.classList.toggle("traffic-cost-rejected", !!isError);
    if (isError) entry.title = text;
    else entry.title = `Path cost of ${key} traffic. Type an exact value.`;
  }
  async function loadTrafficCosts() {
    if (!trafficSubmenu) return;
    try {
      const res = await fetch(`/traffic-costs?t=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      if (!data || !data.costs) return;   // old DLL without the route: keep the defaults, stay quiet
      Object.assign(trafficCosts, data.costs);
      paintTrafficCostOutputs();
    } catch { /* offline/older host: the sliders keep DF's documented defaults */ }
  }
  async function postTrafficCost(key, value) {
    try {
      const res = await fetch(
        `/traffic-costs?${encodeURIComponent(key)}=${encodeURIComponent(value)}&t=${Date.now()}`,
        { method: "POST", cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || "write failed");
      if (data.costs) Object.assign(trafficCosts, data.costs);
      paintTrafficCostOutputs();
      setTrafficCostNote("", false, key);
    } catch (err) {
      setTrafficCostNote(`Could not set the ${key} cost: ${err.message || err}`, true, key);
      loadTrafficCosts();   // re-read the truth rather than leave the slider showing a lie
    }
  }
  if (trafficSubmenu) {
    trafficSubmenu.querySelectorAll("[data-traffic-weight]").forEach(input => {
      input.addEventListener("input", () => {
        const entry = trafficEntryFor(input.dataset.trafficWeight);
        if (entry) entry.value = input.value;
      });
      input.addEventListener("change", () => {
        postTrafficCost(input.dataset.trafficWeight, Number(input.value));
        focusPage();
      });
    });
    trafficSubmenu.querySelectorAll("[data-traffic-entry]").forEach(entry => {
      entry.addEventListener("change", () => {
        const key = entry.dataset.trafficEntry;
        const value = Math.round(Number(entry.value));
        if (!Number.isFinite(value) || value < 1) { paintTrafficCostOutputs(); return; }
        const track = trafficSubmenu.querySelector(`[data-traffic-weight="${key}"]`);
        if (track) {
          if (value > Number(track.max || 100)) track.max = String(value);
          track.value = String(value);
        }
        postTrafficCost(key, value);
      });
      // Typing in the box must not reach the map's keyboard handlers.
      entry.addEventListener("keydown", event => event.stopPropagation());
    });
  }

  document.querySelectorAll("[data-designation-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const tool = button.dataset.designationTool;
      if (plantTools.has(tool)) {
        if (plantMenuOpen && selectedDesignation === tool) {
          plantMenuOpen = false;
          selectedDesignation = null;
          currentTool = null;
        } else {
          digMenuOpen = false;
          plantMenuOpen = true;
          smoothMenuOpen = false;
          itemDesigMenuOpen = false;
          selectDesignation(tool);
        }
      } else if (tool === "smooth") {
        if (smoothMenuOpen && smoothTools.has(selectedDesignation)) {
          smoothMenuOpen = false;
          selectedDesignation = null;
          currentTool = null;
        } else {
          digMenuOpen = false;
          plantMenuOpen = false;
          smoothMenuOpen = true;
          itemDesigMenuOpen = false;
          selectDesignation("smooth");
        }
      } else if (selectedDesignation === tool) {
        selectedDesignation = null;
        currentTool = null;
      } else {
        digMenuOpen = false;
        plantMenuOpen = false;
        smoothMenuOpen = false;
        itemDesigMenuOpen = false;
        selectDesignation(tool);
      }
      updateDesignationButtons();
      focusPage();
    });
  });
  document.querySelectorAll("[data-mode-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const tool = button.dataset.modeTool;
      if (tool === "burrow") {
        window.toggleBurrowPanel();
        focusPage();
        return;
      }
      if (tool === "hauling") {
        window.toggleHaulingPanel();
        focusPage();
        return;
      }
      if (tool === "itemdesig") {
        if (itemDesigMenuOpen) {
          itemDesigMenuOpen = false;
          selectedDesignation = null;
          currentTool = null;
          updateDesignationButtons();
        } else {
          // armDesignation() calls selectDesignation() internally, which already ends
          // in updateDesignationButtons() -- no extra call needed on this branch.
          window.armDesignation("itemdesig", itemDesigTools.has(selectedDesignation) ? selectedDesignation : "claim");
        }
      } else if (selectedDesignation === tool) {
        selectedDesignation = null;
        currentTool = null;
        updateDesignationButtons();
      } else {
        digMenuOpen = false;
        plantMenuOpen = false;
        smoothMenuOpen = false;
        itemDesigMenuOpen = false;
        selectDesignation(tool); // ends in updateDesignationButtons()
      }
      focusPage();
    });
  });
  document.querySelectorAll("[data-dig-prio]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      digPriority = Number(button.dataset.digPrio) || 4;
      updateDesignationButtons();
      focusPage();
    });
  });
  document.querySelectorAll("[data-dig-opt]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.digOpt === "marker") markerMode = !markerMode;
      updateDesignationButtons();
      focusPage();
    });
  });
  document.querySelectorAll("[data-dig-mode]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      digMineMode = Number(button.dataset.digMode) || 0;
      updateDesignationButtons();
      focusPage();
    });
  });
  document.querySelectorAll("[data-dig-expand], [data-plant-expand], [data-smooth-expand], [data-traffic-expand]")
    .forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      advOpen = !advOpen;
      updateDesignationButtons();
      focusPage();
    }));
  // Guarded because an uncaught throw here aborts this script and every pointer handler below
  // it never registers -- the whole map goes unresponsive rather than one toolbar losing paint.
  try { updateDesignationButtons(); }
  catch (e) { console.error("B199: init updateDesignationButtons failed (cross-script module missing?)", e); }

  function digOptsQuery() {
    return `&priority=${digPriority}&marker=${markerMode ? 1 : 0}&minemode=${digMineMode}`;
  }
  const PENDING_DESIGNATE_TOOLS = new Set([]);
  function warnIfPendingEndpoint(ok, tool) {
    if (!ok && PENDING_DESIGNATE_TOOLS.has(tool))
      console.warn(`[designate] /designate tool=${tool}: server endpoint pending (src/placement.cpp)`);
  }
  let designationRefusalAt = 0;
  let designationRefusalText = "";
  async function handleDesignationResponse(response, tool) {
    warnIfPendingEndpoint(response.ok, tool);
    if (response.ok) return true;
    let reason = "";
    try {
      const text = (await response.text()).trim();
      try {
        const data = text ? JSON.parse(text) : {};
        reason = String(data.error || "");
      } catch (err) {
        DwfErr.report("designation.error-detail-json", err);
        reason = text;
      }
    } catch (err) { DwfErr.report("designation.error-detail-read", err); }
    reason = reason.replace(/^designate (?:failed|refused):\s*/i, "").trim() ||
      "No valid tiles for that designation.";
    const now = Date.now();
    if (reason !== designationRefusalText || now - designationRefusalAt > 1200) {
      designationRefusalText = reason;
      designationRefusalAt = now;
      try {
        if (window.DwfPause && typeof DwfPause.toast === "function") DwfPause.toast(reason);
      } catch (err) { DwfErr.report("designation.error-toast", err); }
    }
    return false;
  }
  async function postMaybePending(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(url, { method: "POST", cache: "no-store", signal: ctl.signal });
      return r.ok ? r : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function designationDragRect(a, b) {
    if (!a || !b) return null;
    const values = [a.x, a.y, b.x, b.y, a.w, a.h].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return { x1: Math.min(values[0], values[2]), y1: Math.min(values[1], values[3]),
      x2: Math.max(values[0], values[2]), y2: Math.max(values[1], values[3]),
      w: values[4], h: values[5] };
  }

  function requestDesignationBlocks(rect) {
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!rect || !rendered) return;
    requestDesignationWorldBlocks({
      x1: Number(rendered.ox) + rect.x1, y1: Number(rendered.oy) + rect.y1,
      x2: Number(rendered.ox) + rect.x2, y2: Number(rendered.oy) + rect.y2,
      z: Number(rendered.oz)
    }, Number(rendered.oz));
  }

  function requestDesignationWorldBlocks(selection, endZ) {
    const cache = window.DwfCache;
    if (!selection || !cache || typeof cache.requestBlockRect !== "function") return;
    const values = [selection.x1, selection.y1, selection.x2, selection.y2,
      selection.z, endZ].map(Number);
    if (!values.every(Number.isFinite)) return;
    const z1 = Math.min(values[4], values[5]), z2 = Math.max(values[4], values[5]);
    for (let z = z1; z <= z2; z++)
      cache.requestBlockRect(values[0], values[1], values[2], values[3], z);
  }

  async function designateDrag(x1, y1, x2, y2) {
    if (!currentTool) return;
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    const rect = designationDragRect(a, b);
    if (!rect) return;
    try {
      const url = `/designate?player=${encodeURIComponent(player)}&px=${rect.x1}&py=${rect.y1}` +
        `&px2=${rect.x2}&py2=${rect.y2}&w=${rect.w}&h=${rect.h}&tool=${encodeURIComponent(currentTool)}` + digOptsQuery();
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      if (await handleDesignationResponse(r, currentTool)) requestDesignationBlocks(rect);
    } catch (err) { DwfOrder.lost("placement.designate-drag", err, "That designation"); }
  }

  function designationWorldSelection(x1, y1, x2, y2) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    const rect = designationDragRect(a, b);
    if (!rect || !rendered) return null;
    return { x1: Number(rendered.ox) + rect.x1, y1: Number(rendered.oy) + rect.y1,
      x2: Number(rendered.ox) + rect.x2, y2: Number(rendered.oy) + rect.y2,
      z: Number(rendered.oz), w: rect.w, h: rect.h, tool: selectedDesignation };
  }

  function showDesignationRangePreview(selection, endZ) {
    if (!selection) return;
    stairRangePreview = { ...selection, z1: Number(selection.z), z2: Number(endZ) };
    dragPreview = null;
    renderZoneOverlay();
  }

  function clearTransientDesignationRangePreview() {
    if (desigAnchor()) return; // an armed two-click first corner remains retryable
    stairRangePreview = null;
    renderZoneOverlay();
  }

  async function submitDesignationRange(selection) {
    if (!selection) return false;
    // Shift+wheel moves the camera through the normal queue. Await it so camera_for_player()
    // sees the active release level instead of racing a still-pending /camera request.
    if (typeof whenCameraMovesFlushed === "function") await whenCameraMovesFlushed();
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!rendered) return false;
    const pointZ = Number(rendered.oz);
    const values = [selection.x1, selection.y1, selection.x2, selection.y2,
      selection.z, pointZ, rendered.ox, rendered.oy, rendered.gw, rendered.gh].map(Number);
    if (!values.every(Number.isFinite)) return false;
    const px1 = values[0] - values[6], py1 = values[1] - values[7];
    const px2 = values[2] - values[6], py2 = values[3] - values[7];
    const designationTool = selection.tool || selectedDesignation;
    const rangeTool = designationTool === "stairs" ? "stairs" : backendToolFor(designationTool);
    if (!rangeTool) return false;
    try {
      const url = `/designate?player=${encodeURIComponent(player)}&px=${px1}&py=${py1}` +
        `&px2=${px2}&py2=${py2}&w=${values[8]}&h=${values[9]}&tool=${encodeURIComponent(rangeTool)}` +
        `&priority=${digPriority}&marker=${markerMode ? 1 : 0}` +
        `&minemode=${digMineMode}&zlevels=${values[4] - values[5]}`;
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      if (!await handleDesignationResponse(r, rangeTool)) {
        clearTransientDesignationRangePreview();
        return false;
      }
      requestDesignationWorldBlocks(selection, pointZ);
      if (!desigAnchor() || desigAnchor().tool === designationTool) gestureClear("designation");
      stairRangePreview = null;
      twoClickCursor = null;
      renderZoneOverlay();
      updateDesignationButtons();
      return true;
    } catch (err) {
      DwfOrder.lost("placement.designate-range", err, "That designation");
      clearTransientDesignationRangePreview();
      return false;
    }
  }

  function twoClickEligible() {
    return !!currentTool && rangeDesignationTools.has(selectedDesignation) &&
      paintModeOf("designation") === "rect";
  }
  function twoClickArmed() {
    return !!desigAnchor() && desigAnchor().tool === selectedDesignation && twoClickEligible();
  }
  function twoClickRangeMerge(anchor, cursorSel) {
    const merged = GESTURE ? GESTURE.merge(anchor, cursorSel) : null;
    if (!merged) return null;
    merged.tool = anchor.tool || selectedDesignation;
    return merged;
  }
  function updateTwoClickRubberBand(clientX, clientY) {
    if (!twoClickArmed()) return;
    const cursorSel = designationWorldSelection(clientX, clientY, clientX, clientY);
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!cursorSel || !rendered) return;
    twoClickCursor = { x: clientX, y: clientY };
    showDesignationRangePreview(twoClickRangeMerge(desigAnchor(), cursorSel), Number(rendered.oz));
    sendTwoClickPresence(imagePixelClamped(clientX, clientY));
  }

  function designationRangeWheel(event, dzIn) {
    if (!event || !twoClickArmed()) return false;
    const dz = Number.isFinite(dzIn) && dzIn !== 0
      ? dzIn
      : (event.deltaY < 0 ? zstep : -zstep);
    queueMove(0, 0, dz);
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    const endZ = rendered && Number.isFinite(Number(rendered.oz))
      ? Number(rendered.oz)
      : Number((stairRangePreview && stairRangePreview.z2) ?? desigAnchor().z) + dz;
    const cursorSel = twoClickCursor
      ? designationWorldSelection(twoClickCursor.x, twoClickCursor.y, twoClickCursor.x, twoClickCursor.y)
      : null;
    showDesignationRangePreview(
      cursorSel ? twoClickRangeMerge(desigAnchor(), cursorSel) : desigAnchor(), endZ);
    updateToolModeLabel();
    return true;
  }
  window.DFDesignationRangeWheel = designationRangeWheel;

  let freePaintCells = null; // Set of "x,y" keys already committed this drag, or null when idle
  let freePaintLastCell = null;
  // Every rectangle-designation tool takes the brush; all of them are 1x1-capable on /designate.
  function freePaintActive() {
    return paintModeOf("designation") === "free" && !!currentTool &&
      rangeDesignationTools.has(selectedDesignation);
  }
  async function designateCell(x, y, w, h) {
    try {
      const url = `/designate?player=${encodeURIComponent(player)}&px=${x}&py=${y}&px2=${x}&py2=${y}&w=${w}&h=${h}&tool=${encodeURIComponent(currentTool)}` + digOptsQuery();
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      await handleDesignationResponse(r, currentTool);
    } catch (err) { DwfOrder.lost("placement.designate-cell", err, "That designation"); }
  }
  function freePaintTo(cell) {
    if (!freePaintCells || !cell) return;
    const from = freePaintLastCell || cell;
    let x = from.x, y = from.y;
    const x1 = cell.x, y1 = cell.y;
    const dx = Math.abs(x1 - x), sx = x < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y), sy = y < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      const key = `${x},${y}`;
      if (!freePaintCells.has(key)) {
        freePaintCells.add(key);
        designateCell(x, y, cell.w, cell.h);
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    freePaintLastCell = cell;
  }

  if (typeof window !== "undefined") Object.assign(window, {
    gestureArm, gestureArmed, gestureClear, desigAnchor, activePaintSubsystem, paintModeOf, setPaintModeOf, placementActive, placementModeForActiveTool, sendPlacementUi, sendTwoClickPresence, updateToolCursor, paintSprite, designationPaletteOpen, updateToolModeLabel, updateDesignationButtons, selectDesignation, postMaybePending, designationDragRect, designateDrag, showDesignationRangePreview, submitDesignationRange, twoClickEligible, twoClickArmed, updateTwoClickRubberBand, freePaintActive, freePaintTo,
  });

  if (typeof window !== "undefined" && window.DFPlacementController) {
    Object.defineProperties(window.DFPlacementController, {
      GESTURE: { get: () => GESTURE, configurable: true },
      PAINT_MODES: { get: () => PAINT_MODES, configurable: true },
      stockPreset: { get: () => stockPreset, set: value => { stockPreset = value; }, configurable: true },
      stockRepaintId: { get: () => stockRepaintId, set: value => { stockRepaintId = value; }, configurable: true },
      stockRepaintMeta: { get: () => stockRepaintMeta, set: value => { stockRepaintMeta = value; }, configurable: true },
      stockRepaintDraft: { get: () => stockRepaintDraft, set: value => { stockRepaintDraft = value; }, configurable: true },
      stockRepaintFreeCells: { get: () => stockRepaintFreeCells, set: value => { stockRepaintFreeCells = value; }, configurable: true },
      stockRepaintFreeLast: { get: () => stockRepaintFreeLast, set: value => { stockRepaintFreeLast = value; }, configurable: true },
      stockRepaintEraseArmed: { get: () => stockRepaintEraseArmed, set: value => { stockRepaintEraseArmed = value; }, configurable: true },
      stockRepaintRemoveArmed: { get: () => stockRepaintRemoveArmed, set: value => { stockRepaintRemoveArmed = value; }, configurable: true },
      zoneRepaintId: { get: () => zoneRepaintId, set: value => { zoneRepaintId = value; }, configurable: true },
      zoneRepaintMeta: { get: () => zoneRepaintMeta, set: value => { zoneRepaintMeta = value; }, configurable: true },
      zoneRepaintDraft: { get: () => zoneRepaintDraft, set: value => { zoneRepaintDraft = value; }, configurable: true },
      zoneRepaintFreeCells: { get: () => zoneRepaintFreeCells, set: value => { zoneRepaintFreeCells = value; }, configurable: true },
      zoneRepaintFreeLast: { get: () => zoneRepaintFreeLast, set: value => { zoneRepaintFreeLast = value; }, configurable: true },
      stockMode: { get: () => stockMode, set: value => { stockMode = value; }, configurable: true },
      stockEraseArmed: { get: () => stockEraseArmed, set: value => { stockEraseArmed = value; }, configurable: true },
      stockRemoveArmed: { get: () => stockRemoveArmed, set: value => { stockRemoveArmed = value; }, configurable: true },
      stockPileId: { get: () => stockPileId, set: value => { stockPileId = value; }, configurable: true },
      stockPileBBox: { get: () => stockPileBBox, set: value => { stockPileBBox = value; }, configurable: true },
      stockFreeBBox: { get: () => stockFreeBBox, set: value => { stockFreeBBox = value; }, configurable: true },
      zonePreset: { get: () => zonePreset, set: value => { zonePreset = value; }, configurable: true },
      zoneMode: { get: () => zoneMode, set: value => { zoneMode = value; }, configurable: true },
      zoneEraseArmed: { get: () => zoneEraseArmed, set: value => { zoneEraseArmed = value; }, configurable: true },
      zoneRemoveArmed: { get: () => zoneRemoveArmed, set: value => { zoneRemoveArmed = value; }, configurable: true },
      zoneLiveId: { get: () => zoneLiveId, set: value => { zoneLiveId = value; }, configurable: true },
      zonePaintPreview: { get: () => zonePaintPreview, set: value => { zonePaintPreview = value; }, configurable: true },
      zoneFreeBBox: { get: () => zoneFreeBBox, set: value => { zoneFreeBBox = value; }, configurable: true },
      burrowMode: { get: () => burrowMode, set: value => { burrowMode = value; }, configurable: true },
      burrowPaintId: { get: () => burrowPaintId, set: value => { burrowPaintId = value; }, configurable: true },
      burrowEraseArmed: { get: () => burrowEraseArmed, set: value => { burrowEraseArmed = value; }, configurable: true },
      burrowFreeCells: { get: () => burrowFreeCells, set: value => { burrowFreeCells = value; }, configurable: true },
      burrowFreeLast: { get: () => burrowFreeLast, set: value => { burrowFreeLast = value; }, configurable: true },
      squadMoveArmed: { get: () => squadMoveArmed, set: value => { squadMoveArmed = value; }, configurable: true },
      squadKillArmed: { get: () => squadKillArmed, set: value => { squadKillArmed = value; }, configurable: true },
      squadPatrolArmed: { get: () => squadPatrolArmed, set: value => { squadPatrolArmed = value; }, configurable: true },
      wsLinkArmed: { get: () => wsLinkArmed, set: value => { wsLinkArmed = value; }, configurable: true },
      leverLinkArmed: { get: () => leverLinkArmed, set: value => { leverLinkArmed = value; }, configurable: true },
      chatPingArmed: { get: () => chatPingArmed, set: value => { chatPingArmed = value; }, configurable: true },
      haulingMode: { get: () => haulingMode, set: value => { haulingMode = value; }, configurable: true },
      haulingStopArmedRoute: { get: () => haulingStopArmedRoute, set: value => { haulingStopArmedRoute = value; }, configurable: true },
      haulingLinkArmed: { get: () => haulingLinkArmed, set: value => { haulingLinkArmed = value; }, configurable: true },
      haulingRenamingRouteId: { get: () => haulingRenamingRouteId, set: value => { haulingRenamingRouteId = value; }, configurable: true },
      haulingRenamingStopKey: { get: () => haulingRenamingStopKey, set: value => { haulingRenamingStopKey = value; }, configurable: true },
      currentTool: { get: () => currentTool, set: value => { currentTool = value; }, configurable: true },
      selectedDesignation: { get: () => selectedDesignation, set: value => { selectedDesignation = value; }, configurable: true },
      twoClickCursor: { get: () => twoClickCursor, set: value => { twoClickCursor = value; }, configurable: true },
      digMenuOpen: { get: () => digMenuOpen, set: value => { digMenuOpen = value; }, configurable: true },
      plantMenuOpen: { get: () => plantMenuOpen, set: value => { plantMenuOpen = value; }, configurable: true },
      smoothMenuOpen: { get: () => smoothMenuOpen, set: value => { smoothMenuOpen = value; }, configurable: true },
      itemDesigMenuOpen: { get: () => itemDesigMenuOpen, set: value => { itemDesigMenuOpen = value; }, configurable: true },
      digPriority: { get: () => digPriority, set: value => { digPriority = value; }, configurable: true },
      markerMode: { get: () => markerMode, set: value => { markerMode = value; }, configurable: true },
      digMineMode: { get: () => digMineMode, set: value => { digMineMode = value; }, configurable: true },
      advOpen: { get: () => advOpen, set: value => { advOpen = value; }, configurable: true },
      trafficLevel: { get: () => trafficLevel, set: value => { trafficLevel = value; }, configurable: true },
      lastPlacementMode: { get: () => lastPlacementMode, set: value => { lastPlacementMode = value; }, configurable: true },
      itemDesigTools: { get: () => itemDesigTools, configurable: true },
      freePaintCells: { get: () => freePaintCells, set: value => { freePaintCells = value; }, configurable: true },
      freePaintLastCell: { get: () => freePaintLastCell, set: value => { freePaintLastCell = value; }, configurable: true }
    });
  }
