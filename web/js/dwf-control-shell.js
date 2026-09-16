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

// ---- Shared production markup and native sprite vocabulary for the bottom toolbar and paint rows. ----
(function (root) {
  "use strict";

  if (root.DWFUI && typeof root.DWFUI.require === "function") root.DWFUI.require("fortress-controls",
    ["toolButtonHtml", "artBtnHtml", "plaqueBtnHtml", "latchHtml", "rowHtml", "iconHtml", "bitmapTextHtml", "rawHtml", "TOKENS"]);

  const SPRITE_TOKENS = {
    lowerMenu:{normal:"BUTTON_LOWER_MENU"}, digMenu:{normal:"BUTTON_DIG"},
    dig:{normal:"BUTTON_DIG_DIG_INACTIVE",active:"BUTTON_DIG_DIG_ACTIVE"},
    stairs:{normal:"BUTTON_DIG_STAIRS_INACTIVE",active:"BUTTON_DIG_STAIRS_ACTIVE"},
    ramp:{normal:"BUTTON_DIG_RAMP_INACTIVE",active:"BUTTON_DIG_RAMP_ACTIVE"},
    channel:{normal:"BUTTON_DIG_CHANNEL_INACTIVE",active:"BUTTON_DIG_CHANNEL_ACTIVE"},
    remove:{normal:"BUTTON_DIG_REMOVE_STAIRS_RAMPS_INACTIVE",active:"BUTTON_DIG_REMOVE_STAIRS_RAMPS_ACTIVE"},
    chop:{normal:"BUTTON_DES_CHOP_INACTIVE",active:"BUTTON_DES_CHOP_ACTIVE"},
    gather:{normal:"BUTTON_DES_GATHER_INACTIVE",active:"BUTTON_DES_GATHER_ACTIVE"},
    smooth:{normal:"BUTTON_DES_SMOOTH_INACTIVE",active:"BUTTON_DES_SMOOTH_ACTIVE"},
    engrave:{normal:"BUTTON_DES_SMOOTH_ENGRAVE_INACTIVE",active:"BUTTON_DES_SMOOTH_ENGRAVE_ACTIVE"},
    track:{normal:"BUTTON_DES_SMOOTH_TRACK_INACTIVE",active:"BUTTON_DES_SMOOTH_TRACK_ACTIVE"},
    fortify:{normal:"BUTTON_DES_SMOOTH_FORTIFY_INACTIVE",active:"BUTTON_DES_SMOOTH_FORTIFY_ACTIVE"},
    erase:{normal:"BUTTON_DES_ERASE",active:"BUTTON_DES_ERASE"},
    build:{normal:"BUTTON_BUILDING_INACTIVE",active:"BUTTON_BUILDING_ACTIVE"},
    zone:{normal:"BUTTON_ZONE_INACTIVE",active:"BUTTON_ZONE_ACTIVE"},
    stockpile:{normal:"BUTTON_STOCKPILE_INACTIVE",active:"BUTTON_STOCKPILE_ACTIVE"},
    citizens:{normal:"BUTTON_INFO_CREATURES",active:"BUTTON_INFO_CREATURES_ACTIVE"},
    orders:{normal:"BUTTON_INFO_TASKS",active:"BUTTON_INFO_TASKS_ACTIVE"},
    locations:{normal:"BUTTON_INFO_PLACES",active:"BUTTON_INFO_PLACES_ACTIVE"},
    labor:{normal:"BUTTON_INFO_LABOR",active:"BUTTON_INFO_LABOR_ACTIVE"},
    workorders:{normal:"BUTTON_INFO_WORK_ORDERS",active:"BUTTON_INFO_WORK_ORDERS_ACTIVE"},
    nobles:{normal:"BUTTON_INFO_NOBLES",active:"BUTTON_INFO_NOBLES_ACTIVE"},
    objects:{normal:"BUTTON_INFO_OBJECTS",active:"BUTTON_INFO_OBJECTS_ACTIVE"},
    justice:{normal:"BUTTON_INFO_JUSTICE",active:"BUTTON_INFO_JUSTICE_ACTIVE"},
    squads:{normal:"BUTTON_SQUADS"}, worldmap:{normal:"BUTTON_WORLD"},
    burrow:{normal:"BUTTON_BURROW_INACTIVE",active:"BUTTON_BURROW_ACTIVE"},
    hauling:{normal:"BUTTON_HAULING_INACTIVE",active:"BUTTON_HAULING_ACTIVE"},
    traffic:{normal:"BUTTON_DES_TRAFFIC",active:"BUTTON_DES_TRAFFIC"},
    itemdesig:{normal:"BUTTON_DES_ITEM_BUILDING",active:"BUTTON_DES_ITEM_BUILDING"},
    paintRect:{normal:"BUTTON_PAINT_RECTANGLE_INACTIVE",active:"BUTTON_PAINT_RECTANGLE_ACTIVE"},
    paintFree:{normal:"BUTTON_FREE_PAINT_INACTIVE",active:"BUTTON_FREE_PAINT_ACTIVE"},
    markerToggle:{normal:"BUTTON_DES_BLUEPRINT_INACTIVE",active:"BUTTON_DES_BLUEPRINT_ACTIVE"},
    convertmarker:{normal:"BUTTON_DES_TO_BLUEPRINT_INACTIVE",active:"BUTTON_DES_TO_BLUEPRINT_ACTIVE"},
    convertstandard:{normal:"BUTTON_DES_FROM_BLUEPRINT_INACTIVE",active:"BUTTON_DES_FROM_BLUEPRINT_ACTIVE"},
    claim:{normal:"BUTTON_DES_CLAIM_INACTIVE",active:"BUTTON_DES_CLAIM_ACTIVE"},
    forbid:{normal:"BUTTON_DES_FORBID_INACTIVE",active:"BUTTON_DES_FORBID_ACTIVE"},
    dump:{normal:"BUTTON_DES_DUMP_INACTIVE",active:"BUTTON_DES_DUMP_ACTIVE"},
    undump:{normal:"BUTTON_DES_UNDUMP_INACTIVE",active:"BUTTON_DES_UNDUMP_ACTIVE"},
    melt:{normal:"BUTTON_DES_MELT_INACTIVE",active:"BUTTON_DES_MELT_ACTIVE"},
    unmelt:{normal:"BUTTON_DES_UNMELT_INACTIVE",active:"BUTTON_DES_UNMELT_ACTIVE"},
    unhide:{normal:"BUTTON_DES_UNHIDE_INACTIVE",active:"BUTTON_DES_UNHIDE_ACTIVE"},
    hide:{normal:"BUTTON_DES_HIDE_INACTIVE",active:"BUTTON_DES_HIDE_ACTIVE"},
    stockNew:{normal:"BUTTON_STOCKPILE_NEW"},
    stockErase:{normal:"STOCKPILE_ERASE_INACTIVE",active:"STOCKPILE_ERASE_ACTIVE"},
    stockRemoveExisting:{normal:"STOCKPILE_REMOVE_EXISTING"},
    zoneErase:{normal:"ZONE_ERASE_INACTIVE",active:"ZONE_ERASE_ACTIVE"},
    zoneRemoveExisting:{normal:"ZONE_REMOVE_EXISTING"}, zoneRepaint:{normal:"ZONE_REPAINT"},
    zonePrevious:{normal:"ZONE_PREVIOUS"}, zoneNext:{normal:"ZONE_NEXT"},
    burrowErase:{normal:"BUTTON_DES_ERASE",active:"BUTTON_DES_ERASE"},
    burrowSuspend:{normal:"BURROW_SUSPEND_INACTIVE",active:"BURROW_SUSPEND_ACTIVE"},
    burrowDelete:{normal:"BURROW_DELETE"}, burrowAddUnit:{normal:"BURROW_ADD_UNIT"},
    burrowRename:{normal:"BUTTON_FILTER_NAME"},
    burrowRepaint:{normal:"BURROW_REPAINT"},
    burrowRecenter:{normal:"BURROW_RECENTER"},   // DF's own recenter glyph
    burrowWorkshopsAll:{normal:"BURROW_WORKSHOPS_EVERYWHERE", active:"BURROW_WORKSHOPS_EVERYWHERE"},
    burrowWorkshopsOnly:{normal:"BURROW_WORKSHOPS_BURROW_ONLY", active:"BURROW_WORKSHOPS_BURROW_ONLY"},
    // The hauling row used to delete a STOP and a ROUTE with BURROW_DELETE. DF ships a token for
    // each (12-item-designations family); the wire is unchanged, only the art is now the right one.
    haulingDeleteStop:{normal:"HAULING_DELETE_STOP"}, haulingDeleteRoute:{normal:"HAULING_DELETE_ROUTE"},
    // There is no HAULING_RENAME_* token, so this resolves to DF's generic quill-capped rename tile.
    haulingRename:{normal:"BUTTON_FILTER_NAME"},
    // 01b-dig-expanded.png: the advanced expander is a gold arrow (-> closed / <- open), 16x36,
    // NOT a rotated CSS play glyph.
    expander:{normal:"BUTTON_EXPANDER_CLOSED",active:"BUTTON_EXPANDER_OPEN",box:[16,36]},
    // 01b-dig-expanded.png: dig priority is SEVEN NUMBER TILES, art not text.
    prio1:{normal:"BUTTON_PRIORITY_1_INACTIVE",active:"BUTTON_PRIORITY_1_ACTIVE"},
    prio2:{normal:"BUTTON_PRIORITY_2_INACTIVE",active:"BUTTON_PRIORITY_2_ACTIVE"},
    prio3:{normal:"BUTTON_PRIORITY_3_INACTIVE",active:"BUTTON_PRIORITY_3_ACTIVE"},
    prio4:{normal:"BUTTON_PRIORITY_4_INACTIVE",active:"BUTTON_PRIORITY_4_ACTIVE"},
    prio5:{normal:"BUTTON_PRIORITY_5_INACTIVE",active:"BUTTON_PRIORITY_5_ACTIVE"},
    prio6:{normal:"BUTTON_PRIORITY_6_INACTIVE",active:"BUTTON_PRIORITY_6_ACTIVE"},
    prio7:{normal:"BUTTON_PRIORITY_7_INACTIVE",active:"BUTTON_PRIORITY_7_ACTIVE"},
    digModeAll:{normal:"BUTTON_DIG_MODE_ALL_INACTIVE",active:"BUTTON_DIG_MODE_ALL_ACTIVE"},
    digModeAuto:{normal:"BUTTON_DIG_MODE_AUTO_INACTIVE",active:"BUTTON_DIG_MODE_AUTO_ACTIVE"},
    digModeOre:{normal:"BUTTON_DIG_MODE_ONLY_ORE_GEM_INACTIVE",active:"BUTTON_DIG_MODE_ONLY_ORE_GEM_ACTIVE"},
    digModeGem:{normal:"BUTTON_DIG_MODE_ONLY_GEM_INACTIVE",active:"BUTTON_DIG_MODE_ONLY_GEM_ACTIVE"},
    // 11-traffic.png: the four levels are real sprites (green/yellow/orange chevrons, red bar).
    trafficHigh:{normal:"BUTTON_DES_TRAFFIC_HIGH_INACTIVE",active:"BUTTON_DES_TRAFFIC_HIGH_ACTIVE"},
    trafficNormal:{normal:"BUTTON_DES_TRAFFIC_NORMAL_INACTIVE",active:"BUTTON_DES_TRAFFIC_NORMAL_ACTIVE"},
    trafficLow:{normal:"BUTTON_DES_TRAFFIC_LOW_INACTIVE",active:"BUTTON_DES_TRAFFIC_LOW_ACTIVE"},
    trafficRestricted:{normal:"BUTTON_DES_TRAFFIC_RESTRICTED_INACTIVE",active:"BUTTON_DES_TRAFFIC_RESTRICTED_ACTIVE"},
  };

  function paintSprite(button, key, active) {
    const tokens = SPRITE_TOKENS[key];
    if (!button || !tokens || !root.DFChrome?.updateIcon) return false;
    const [boxW, boxH] = tokens.box || [32, 36];
    let icon = button.querySelector("canvas.df-chrome-icon");
    if (!icon) {
      button.textContent = "";
      icon = root.document.createElement("canvas");
      icon.className = "df-chrome-icon";
      button.appendChild(icon);
    }
    // Only the BOX is computed (per-token, from SPRITE_TOKENS.box); the pixelated skin is a
    // constant and lives with .df-chrome-icon in the chrome layer.
    icon.style.setProperty("--df-chrome-icon-w", `${boxW}px`);
    icon.style.setProperty("--df-chrome-icon-h", `${boxH}px`);
    root.DFChrome.updateIcon(icon, active && tokens.active ? tokens.active : tokens.normal, Math.max(boxW, boxH));
    button.classList.toggle("active", !!active);
    // Native bakes "selected" into the _ACTIVE sprite, but ~12 tokens have no _ACTIVE variant. Declare
    // which tiles own their selected paint so the stylesheet can draw the outline on the ones that do not.
    if (tokens.active && tokens.active !== tokens.normal) button.setAttribute("data-df-active-art", "");
    else button.removeAttribute("data-df-active-art");
    return true;
  }

  // Chrome belongs to the OUTERMOST owner: the gold frame is drawn around a cluster, and the tiles
  // inside draw no border of their own.
  function subgroup(cls, inner) {
    return root.DWFUI.selectCellGroupHtml(
      { cls: `tool-subgroup${cls ? " " + cls : ""}` }, inner);
  }

  function tile(dataset, title, sprite, active, cls, labelHtml) {
    return root.DWFUI.toolButtonHtml({
      // `data-dwfui-sprite` is reserved for a REAL interface_map token; this is a semantic control-shell key
      // resolved through SPRITE_TOKENS. Sharing the attribute made DWFUI flag valid toolbar art as missing.
      cls, dataset: { ...(dataset || {}), dfControlSprite: sprite, dfControlSpriteActive: active ? "1" : "0" },
      title, ariaLabel: title, active, labelHtml,
    });
  }


  function latchTile(dataset, title, sprite, on, cls) {
    const tokens = SPRITE_TOKENS[sprite];
    return root.DWFUI.latchHtml({
      on: !!on, cls, dataset, title, ariaLabel: title,
      sprite: tokens.normal, activeSprite: tokens.active || tokens.normal,
    });
  }

  function priorityMarkup(active) {
    const value = Number(active) || 4;
    return subgroup("dig-prio", [1,2,3,4,5,6,7]
      .map(n => tile({ digPrio:String(n) }, `Designation priority ${n} (1 = highest, default 4)`, `prio${n}`, n === value))
      .join(""));
  }

  function paintPair(mode) {
    return subgroup("paint-pair",
      tile({ paintMode:"rect" }, "Paint mode: rectangle corners", "paintRect", mode !== "free") +
      tile({ paintMode:"free" }, "Paint mode: free-hand paint", "paintFree", mode === "free"));
  }

  // The advanced expander. `data-<kind>-expand` and the `.dig-expand` class are the pinned wire.
  function expander(dataset, title, open) {
    return tile(dataset, title, "expander", open, `dig-expand${open ? " open" : ""}`);
  }

  const DIG_MODES = [[0,"All","digModeAll"],[1,"Auto","digModeAuto"],[2,"Ore","digModeOre"],[3,"Gem","digModeGem"]];
  function digSubmenuMarkup(state) {
    const s = state || {}, selected = s.selected || "dig", open = !!s.advanced;
    const tools = [
      ["dig","Regular dig"],["stairs","Dig stairs: select both z-level endpoints"],["ramp","Dig ramp"],
      ["channel","Dig channel"],
      ["remove","Designate constructed walls, floors, and other constructed tiles to be removed by miners. This also designates all stairwells and ramps."],
    ].map(([key,title]) => tile({ digTool:key }, title, key, selected === key)).join("");
    const modes = subgroup("dig-modes", DIG_MODES
      .map(([key,label,sprite]) => tile({ digMode:String(key) }, `Dig mode: ${label}`, sprite, Number(s.mineMode || 0) === key, "dig-mode"))
      .join(""));
    return `${subgroup("dig-tools", tools)}${paintPair(s.paintMode)}${expander({ digExpand:"" }, "More dig options", open)}` +
      `<div class="dig-adv${open ? " open" : ""}">${modes}` +
      `${latchTile({ digOpt:"marker" }, "Marker mode", "markerToggle", !!s.marker, "dig-opt")}` +
      `${priorityMarkup(s.priority)}${tile({ digTool:"convertmarker" }, "Convert to marker mode", "convertmarker", selected === "convertmarker")}` +
      `${tile({ digTool:"convertstandard" }, "Convert to standard mode", "convertstandard", selected === "convertstandard")}</div>`;
  }

  function plantSubmenuMarkup(state) {
    const s = state || {}, selected = s.selected === "gather" ? "gather" : "chop", open = s.advanced !== false;
    return `${subgroup("plant-tools", tile({ plantTool:selected }, selected === "chop" ? "Set tree chopping orders" : "Set plant gathering orders", selected, true))}` +
      `${paintPair(s.paintMode)}${expander({ plantExpand:"" }, "More plant order options", open)}` +
      `<div class="dig-adv plant-adv${open ? " open" : ""}">${latchTile({ digOpt:"marker" }, "Marker mode", "markerToggle", !!s.marker, "dig-opt")}` +
      `${priorityMarkup(s.priority)}${tile({ digTool:"convertmarker" }, "Convert to marker mode", "convertmarker", selected === "convertmarker")}` +
      `${tile({ digTool:"convertstandard" }, "Convert to standard mode", "convertstandard", selected === "convertstandard")}</div>`;
  }

  function smoothSubmenuMarkup(state) {
    const s = state || {}, selected = s.selected || "smooth", open = s.advanced !== false;
    const tools = [["smooth","Smooth rough stone"],["engrave","Engrave artwork"],["track","Carve minecart track"],["fortify","Carve fortification"]]
      .map(([key,title]) => tile({ smoothTool:key }, title, key, selected === key)).join("");
    return `${subgroup("smooth-tools", tools)}${paintPair(s.paintMode)}${expander({ smoothExpand:"" }, "More smoothing options", open)}` +
      `<div class="dig-adv smooth-adv${open ? " open" : ""}">${latchTile({ digOpt:"marker" }, "Marker mode", "markerToggle", !!s.marker, "dig-opt")}${priorityMarkup(s.priority)}</div>`;
  }

  function itemSubmenuMarkup(state) {
    const s = state || {}, selected = s.selected || "claim";
    const labels = { claim:"Claim forbidden items and buildings", forbid:"Forbid items and buildings", dump:"Designate items for dumping", undump:"Cancel dump designations", melt:"Designate items for melting", unmelt:"Cancel melt designations", unhide:"Set items visible", hide:"Hide items" };
    return `${subgroup("itemdesig-tools", Object.keys(labels).map(key => tile({ itemdesigTool:key }, labels[key], key, selected === key)).join(""))}${paintPair(s.paintMode)}`;
  }

  function stockSubmenuMarkup(state) {
    const s = state || {};
    if (s.stage !== "paint") return subgroup("stock-tools", tile({ stockNew:"" }, "New stockpile", "stockNew", false));
    return `${paintPair(s.paintMode)}${subgroup("stock-tools", tile({ stockErase:"" }, "Erase-paint an existing stockpile", "stockErase", !!s.erase) + tile({ stockRemoveExisting:"" }, "Remove an existing stockpile", "stockRemoveExisting", !!s.remove))}`;
  }

  // Keep the WHOLE finite submenu inventory mounted: the placement controller caches these nodes once,
  // and rebuilding them destroys the references and handlers it has already acquired.
  function stockSubmenuInventoryMarkup() {
    return stockSubmenuMarkup({ stage:"menu" }) + stockSubmenuMarkup({ stage:"paint" });
  }

  function setHydratedStockStage(host, stage) {
    if (!host || !host.querySelectorAll) return;
    const painting = stage === "paint";
    host.querySelectorAll("[data-stock-new]").forEach(button => { button.hidden = painting; });
    host.querySelectorAll("[data-paint-mode],[data-stock-erase],[data-stock-remove-existing]")
      .forEach(button => { button.hidden = !painting; });
  }

  function zoneSubmenuMarkup(state) {
    const s = state || {};
    return `${paintPair(s.paintMode)}${subgroup("zone-tools", tile({ zoneErase:"" }, "Erase-paint an existing zone", "zoneErase", !!s.erase) + tile({ zoneRemoveExisting:"" }, "Remove an existing zone", "zoneRemoveExisting", !!s.remove))}`;
  }

  // [key, sprite key, label, default pathfinding weight, native hover text]. Row order and hover text
  // are DF's own, lifted from the game's hover-instruction table rather than paraphrased.
  const TRAFFIC_LEVELS = [
    ["high", "trafficHigh", "High traffic", 1,
     "Set a high traffic area. Use this in wide central passages."],
    ["normal", "trafficNormal", "Normal traffic", 2,
     "Set a normal traffic area, the default state."],
    ["low", "trafficLow", "Low traffic", 5,
     "Set a low traffic area. Citizens will look for better routes."],
    ["restricted", "trafficRestricted", "Restricted traffic", 25,
     "Set a restricted traffic area. Citizens will look hard for better routes. They will still " +
     "use the area if other routes do not exist or are too long."],
  ];
  // Native's traffic menu is four type buttons plus the usual paint-style pair plus an ADVANCED wing,
  // closed by default -- not a menu with the weights bolted permanently to the bottom.
  function trafficSubmenuMarkup(state) {
    const s = state || {}, level = s.level || "high", weights = s.weights || {};
    // Closed by default (R5 items 104/105) -- note the `!!`, where dig/plant/smooth use
    // `!== false`. Native's traffic wing starts shut; theirs start open.
    const open = !!s.advanced;
    const levels = subgroup("traffic-levels", TRAFFIC_LEVELS
      .map(([key,sprite,,,hover]) => tile({ trafficLevel:key }, hover, sprite, level === key, "traffic-level"))
      .join(""));
    const weightRows = TRAFFIC_LEVELS.map(([key,,,defaultWeight]) => {
      const value = Number(weights[key]) || defaultWeight;
      return `<div class="traffic-band" data-traffic-band="${key}">` +
        `<span class="tool-button" data-traffic-band-icon="${key}" aria-hidden="true"></span>` +
        `<input type="range" min="1" max="100" step="1" value="${value}" data-traffic-weight="${key}" title="Set the exact weight in steps of a traffic type (native default ${defaultWeight})">` +
        root.DWFUI.textInputHtml({ cls: "traffic-cost-entry", value,
          dataset: { trafficEntry:key }, ariaLabel:`${key} traffic path cost value`,
          title:`Path cost of ${key} traffic. Type an exact value.` }) +
        `</div>`;
    }).join("");
    return `${levels}${paintPair(s.paintMode)}` +
      `${expander({ trafficExpand:"" }, open ? "Hide advanced options." : "Show advanced options.", open)}` +
      `<div class="dig-adv traffic-adv${open ? " open" : ""}">` +
      `${weightRows}<div class="traffic-cost-note" role="status" aria-live="polite" data-traffic-cost-note></div></div>`;
  }

  // The ten global open-menu buttons. Keep the browser-facing panel keys stable: the live controller
  // binds behaviour through data-panel and paints through the matching semantic sprite.
  const GLOBAL_OPEN_MENU = Object.freeze([
    Object.freeze({ key:"citizens", label:"Creatures", sprite:"citizens", hoverId:"0xbd", side:"left" }),
    Object.freeze({ key:"orders", label:"Tasks", sprite:"orders", hoverId:"0xbe", side:"left" }),
    Object.freeze({ key:"locations", label:"Places", sprite:"locations", hoverId:"0xbf", side:"left" }),
    Object.freeze({ key:"labor", label:"Labor", sprite:"labor", hoverId:"0xc0", side:"left" }),
    Object.freeze({ key:"workorders", label:"Work Orders", sprite:"workorders", hoverId:"0xc1", side:"left" }),
    Object.freeze({ key:"nobles", label:"Nobles", sprite:"nobles", hoverId:"0xc2", side:"left" }),
    Object.freeze({ key:"objects", label:"Objects", sprite:"objects", hoverId:"0xc3", side:"left" }),
    Object.freeze({ key:"justice", label:"Justice", sprite:"justice", hoverId:"0xc6", side:"left" }),
    Object.freeze({ key:"squads", label:"Squads", sprite:"squads", hoverId:"0xc4", side:"right" }),
    Object.freeze({ key:"worldmap", label:"World", sprite:"worldmap", hoverId:"0xc5", side:"right" }),
  ]);
  function bottomToolbarMarkup(state) {
    const s = state || {}, active = s.active || "";
    const panel = key => tile({ dfBtn:"", panel:key }, key, key, active === key);
    const globalButton = item => tile(
      { dfBtn:"", panel:item.key, dwfHoverId:item.hoverId },
      item.label, item.sprite, active === item.key);
    const globalLeft = GLOBAL_OPEN_MENU.filter(item => item.side === "left").map(globalButton).join("");
    const globalRight = GLOBAL_OPEN_MENU.filter(item => item.side === "right").map(globalButton).join("");
    const designation = [
      tile({ dfBtn:"", digMenu:"" }, "Dig", active === "dig" ? "lowerMenu" : "digMenu", active === "dig"),
      ...["chop","gather","smooth","erase"].map(key => tile({ dfBtn:"", designationTool:key }, key, active === key ? "lowerMenu" : key, active === key)),
    ].join("");
    const structures = ["build","stockpile","zone"].map(panel).join("");
    const modes = ["burrow","hauling","traffic"].map(key => tile({ dfBtn:"", modeTool:key }, key, key, active === key)).join("");
    const item = tile({ dfBtn:"", modeTool:"itemdesig" }, "Item designations", "itemdesig", active === "itemdesig");
    return `<div class="tool-group" id="leftTools">${globalLeft}</div>` +
      `<div class="tool-group" id="centerTools"><div class="tool-subgroup" id="designationBar">${designation}</div>` +
      `<div class="tool-subgroup" id="structureTools">${structures}</div><div class="tool-subgroup" id="modeTools">${modes}</div>` +
      `<div class="tool-subgroup" id="itemDesigTools">${item}</div></div>` +
      `<div class="tool-group" id="rightTools">${globalRight}</div>`;
  }

  const SUBMENU_BUILDERS = { dig:digSubmenuMarkup, plant:plantSubmenuMarkup, smooth:smoothSubmenuMarkup, item:itemSubmenuMarkup, stock:stockSubmenuMarkup, zone:zoneSubmenuMarkup, traffic:trafficSubmenuMarkup };
  const SUBMENU_IDS = { dig:"digSubmenu", plant:"plantSubmenu", smooth:"smoothSubmenu", item:"itemDesigSubmenu", stock:"stockSubmenu", zone:"zoneSubmenu", traffic:"trafficSubmenu" };

  function submenuFrame(kind, state) {
    const id = SUBMENU_IDS[kind];
    return `<div id="${id}" class="tool-group visible" aria-hidden="false">${SUBMENU_BUILDERS[kind](state)}</div>`;
  }

  function previewMarkup(state) {
    const s = state || {}, kind = s.kind || "toolbar";
    const submenu = SUBMENU_BUILDERS[kind] ? submenuFrame(kind, s) : "";
    const label = s.label ? `<div class="mode-label-plate visible">${root.DWFUI.esc(s.label)}</div>` : "";
    return `<div class="control-shell-preview">${label}${submenu}<div id="bottomBar">${bottomToolbarMarkup({ active:s.active || kind })}</div></div>`;
  }

  function paintControlIcons(scope) {
    const host = scope || root.document;
    host.querySelectorAll("[data-df-control-sprite]").forEach(button =>
      paintSprite(button, button.dataset.dfControlSprite, button.dataset.dfControlSpriteActive === "1"));
    alignControlSubmenus(host);
  }

  // Align LEFT EDGES after layout, and reset the old shift before measuring so repeated updates cannot
  // accumulate drift. Native submenu rows start above the button that opened them, never centred.
  const SUBMENU_ANCHORS = [
    ["#digSubmenu", "[data-dig-menu]"],
    ["#plantSubmenu", "[data-designation-tool].active"],
    ["#smoothSubmenu", '[data-designation-tool="smooth"]'],
    ["#itemDesigSubmenu", '[data-mode-tool="itemdesig"]'],
    ["#stockSubmenu", '[data-panel="stockpile"]'],
    ["#zoneSubmenu", '[data-panel="zone"]'],
    ["#trafficSubmenu", '[data-mode-tool="traffic"]'],
  ];
  function alignControlSubmenus(scope) {
    const host = scope || root.document;
    if (!host?.querySelector) return;
    for (const [submenuSel, anchorSel] of SUBMENU_ANCHORS) {
      const submenu = host.querySelector(submenuSel);
      const anchor = host.querySelector(anchorSel);
      if (!submenu || !anchor || !submenu.classList.contains("visible")) continue;
      submenu.style.setProperty("--dwfui-submenu-shift", "0px");
      const subRect = submenu.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const nativeWidth = Number(anchor.offsetWidth) || 32;
      const scale = anchorRect.width > 0 ? anchorRect.width / nativeWidth : 1;
      const shift = (anchorRect.left - subRect.left) / Math.max(scale, 0.01);
      submenu.style.setProperty("--dwfui-submenu-shift", `${shift}px`);
    }
  }

  function stockRemoveBuildingId(info) {
    if (!info || String(info.kind || "").toLowerCase() !== "stockpile") return -1;
    const direct = Number(info.buildingId ?? info.building_id ?? -1);
    if (Number.isInteger(direct) && direct >= 0) return direct;
    const lines = Array.isArray(info.lines) ? info.lines : [];
    for (const line of lines) {
      const match = String(line || "").match(/\bBuilding id:\s*(\d+)/i);
      if (match) return Number(match[1]);
    }
    return -1;
  }

  function stockpileBuildingAt(buildings, worldX, worldY, worldZ) {
    if (!Array.isArray(buildings) || ![worldX, worldY, worldZ].every(Number.isFinite)) return -1;
    for (let i = buildings.length - 1; i >= 0; i--) {
      const row = buildings[i];
      if (!row || String(row.type || "").toLowerCase() !== "stockpile") continue;
      if (Number(row.z) !== Number(worldZ)) continue;
      const x1 = Number(row.x1), y1 = Number(row.y1), x2 = Number(row.x2), y2 = Number(row.y2);
      if (![x1, y1, x2, y2].every(Number.isFinite) ||
          worldX < x1 || worldX > x2 || worldY < y1 || worldY > y2) continue;
      const width = x2 - x1 + 1;
      const index = (worldY - y1) * width + (worldX - x1);
      const extents = typeof row.ext === "string" ? row.ext : "";
      if (extents && extents[index] !== "1") continue;
      const id = Number(row.id);
      if (Number.isInteger(id) && id >= 0) return id;
    }
    return -1;
  }

  function stockRemoveConfirmMarkup(label) {
    const name = String(label || "this stockpile");
    return `<div class="stock-remove-confirm-copy">${
      root.DWFUI.bitmapTextHtml(`Remove ${name}? This cannot be undone.`)
    }</div><div class="stock-remove-confirm-actions">${
      root.DWFUI.plaqueBtnHtml({
        label: "Cancel", tone: "red", dataset: { stockRemoveCancel: "" },
        title: "Keep this stockpile",
      })
    }${
      root.DWFUI.plaqueBtnHtml({
        label: "Remove", tone: "red", dataset: { stockRemoveConfirm: "" },
        title: "Confirm stockpile removal",
      })
    }</div>`;
  }

  // Consume the map release BEFORE it reaches the placement controller's immediate-write handler, and
  // require an explicit Confirm/Cancel through the shared DwfConfirmGate.
  function installStockpilePaintSafety() {
    const doc = root.document;
    if (!doc?.addEventListener || doc.documentElement?.dataset?.dwfStockpilePaintSafety === "1") return;
    if (doc.documentElement?.dataset) doc.documentElement.dataset.dwfStockpilePaintSafety = "1";
    let choice = null;
    let pendingNewId = -1;
    let pendingCreate = Promise.resolve();
    const baseFetch = typeof root.fetch === "function" ? root.fetch.bind(root) : null;

    // Remember the inert pile id created by the first painted cell, so Cancel can discard the staged
    // footprint instead of leaking a blank pile into the save.
    if (baseFetch) {
      root.fetch = async (input, init = {}) => {
        const url = typeof input === "string" ? input : input?.url;
        const method = String(init.method || input?.method || "GET").toUpperCase();
        let isNewPile = false;
        try {
          isNewPile = method === "POST" &&
            new URL(String(url || ""), root.location?.href || "http://localhost/").pathname === "/stockpile";
        } catch (err) { DwfErr.report("control-shell.stockpile-url", err); }
        const response = await baseFetch(input, init);
        if (isNewPile && response.ok) {
          pendingCreate = response.clone().json().then(body => {
            const id = Number(body?.id);
            if (Number.isInteger(id) && id >= 0) pendingNewId = id;
          }).catch(err => DwfErr.report("control-shell.stockpile-create-body", err));
          await pendingCreate;
        }
        return response;
      };
    }

    const confirmHost = () => {
      let host = doc.querySelector("[data-stock-remove-confirm-host]");
      if (host) return host;
      const palette = doc.getElementById("stockPalette");
      if (!palette) return null;
      host = doc.createElement("div");
      host.className = "stock-remove-confirm";
      host.dataset.stockRemoveConfirmHost = "";
      host.hidden = true;
      palette.appendChild(host);
      host.addEventListener("click", async event => {
        const cancel = event.target.closest("[data-stock-remove-cancel]");
        const confirm = event.target.closest("[data-stock-remove-confirm]");
        if (!cancel && !confirm) return;
        event.preventDefault();
        event.stopPropagation();
        if (cancel) {
          try { root.DwfConfirmGate?.disarm(); root.DwfConfirmGate?.notifyChanged(); }
          catch (err) { DwfErr.report("control-shell.confirm-cancel", err); }
          choice = null;
          host.hidden = true;
          return;
        }
        if (!choice) return;
        const gate = root.DwfConfirmGate;
        if (!gate || gate.press(choice.key) !== "commit") {
          host.innerHTML = stockRemoveConfirmMarkup(choice.label);
          try { root.DWFUI.mountDom(host); } catch (err) { DwfErr.report("control-shell.confirm-mount", err); }
          return;
        }
        let removed = false;
        try {
          const response = await root.fetch(`/stockpile-remove?id=${choice.id}`,
            { method: "POST", cache: "no-store" });
          if (response.ok) {
            const body = await response.json().catch(() => ({}));
            removed = !body || body.ok !== false;
          }
        } catch (err) { DwfErr.report("control-shell.stockpile-remove", err); }
        const status = doc.querySelector("#stockPalette [data-stock-status]");
        if (status) status.textContent = removed ? "Stockpile removed." : "Remove failed -- the stockpile is unchanged.";
        choice = null;
        host.hidden = true;
      });
      return host;
    };

    const clearChoice = () => {
      choice = null;
      const host = doc.querySelector("[data-stock-remove-confirm-host]");
      if (host) host.hidden = true;
    };
    try {
      root.DwfConfirmGate?.onChange(() => {
        if (choice && !root.DwfConfirmGate.isArmed(choice.key)) clearChoice();
      });
    } catch (err) { DwfErr.report("control-shell.stockpile-safety-install", err); }

    // A new-pile Cancel removes the inert object the first brush stroke created, then routes through the
    // central back-out ladder.
    doc.addEventListener("click", async event => {
      if (event.target?.closest?.("[data-stock-new]")) {
        pendingNewId = -1;
        pendingCreate = Promise.resolve();
        return;
      }
      const accept = event.target?.closest?.("[data-stock-accept]");
      if (accept) {
        const summary = doc.querySelector("#stockPalette [data-stock-repaint-summary]");
        if (summary?.hidden) pendingNewId = -1;
        return;
      }
      const cancel = event.target?.closest?.("[data-stock-cancel]");
      if (!cancel) return;
      const summary = doc.querySelector("#stockPalette [data-stock-repaint-summary]");
      if (!summary || !summary.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      await pendingCreate.catch(err => DwfErr.report("control-shell.pending-create", err));
      if (pendingNewId >= 0 && baseFetch) {
        const who = typeof player !== "undefined" ? player : "";
        let removed = false;
        try {
          const response = await baseFetch(`/stockpile-remove?id=${pendingNewId}` +
            `&player=${encodeURIComponent(who)}`, { method: "POST", cache: "no-store" });
          if (response.ok) {
            const body = await response.json().catch(() => ({}));
            removed = !body || body.ok !== false;
          }
        } catch (err) { DwfErr.report("control-shell.cancel-new-stockpile", err); }
        if (!removed) {
          const status = doc.querySelector("#stockPalette [data-stock-status]");
          if (status) status.textContent = "Cancel failed -- the staged stockpile is unchanged.";
          return;
        }
        pendingNewId = -1;
      }
      try { root.DFBackOut?.("button", "stockpile-paint"); }
      catch (err) { DwfErr.report("control-shell.stockpile-back-out", err); }
    }, true);

    doc.addEventListener("pointerdown", event => {
      if (!choice || event.target?.closest?.("[data-stock-remove-confirm-host],#view")) return;
      try { root.DwfConfirmGate?.disarm(); root.DwfConfirmGate?.notifyChanged(); }
      catch (err) { DwfErr.report("control-shell.confirm-outside", err); }
      clearChoice();
    }, true);

    doc.addEventListener("pointerup", event => {
      const removeButton = doc.querySelector("#stockSubmenu [data-stock-remove-existing]");
      if (!event.target?.closest?.("#view") || !removeButton?.classList.contains("active")) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      void (async () => {
        let pixel = null;
        try {
          if (typeof imagePixelFromEvent === "function") pixel = imagePixelFromEvent(event);
        } catch (_) { DwfErr.count("control-shell.stockpile-pixel"); }
        if (!pixel) return;
        const who = typeof player !== "undefined" ? player : "";
        try {
          const response = await root.fetch(`/inspect?player=${encodeURIComponent(who)}` +
            `&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}`, { cache: "no-store" });
          const info = response.ok ? await response.json() : null;
          const id = stockRemoveBuildingId(info);
          if (id < 0) {
            const status = doc.querySelector("#stockPalette [data-stock-status]");
            if (status) status.textContent = "No stockpile there.";
            return;
          }
          const gate = root.DwfConfirmGate;
          const key = gate?.key("stockpile-remove", id);
          if (!gate || !key) return;
          gate.press(key);
          choice = {
            id, key,
            label: String(info.displayName || info.name || `Stockpile #${info.number ?? id}`),
          };
          const host = confirmHost();
          if (!host) return;
          host.innerHTML = stockRemoveConfirmMarkup(choice.label);
          host.hidden = false;
          try { root.DWFUI.mountDom(host); } catch (err) { DwfErr.report("control-shell.guard-mount", err); }
        } catch (_) {
          const status = doc.querySelector("#stockPalette [data-stock-status]");
          if (status) status.textContent = "Could not inspect that stockpile.";
        }
      })();
    }, true);
  }

  function hydrate() {
    const byId = id => root.document?.getElementById(id);
    const bottom = byId("bottomBar");
    if (bottom) bottom.innerHTML = bottomToolbarMarkup({});
    Object.entries(SUBMENU_IDS).forEach(([kind,id]) => {
      const host = byId(id);
      if (!host) return;
      if (kind === "stock") {
        host.innerHTML = stockSubmenuInventoryMarkup();
        setHydratedStockStage(host, "menu");
      } else {
        host.innerHTML = SUBMENU_BUILDERS[kind]({});
      }
    });
    installStockpilePaintSafety();
  }

  const ZONE_TYPES = [
    ["Meeting Area","meeting"],["Office","office"],["Bedroom","bedroom"],
    ["Dormitory","dormitory"],["Dining Hall","dining"],["Barracks","barracks"],
    ["Pen/Pasture","pen"],["Archery Range","archery"],["Pit/Pond","pond"],
    ["Garbage Dump","dump"],["Water Source","water"],["Animal Training","training"],
    ["Dungeon","dungeon"],["Tomb","tomb"],["Fishing","fishing"],
    ["Gather Fruit","gather"],["Sand","sand"],["Clay","clay"],
  ];

  function zonePaletteMarkup(selected) {
    const buttons = ZONE_TYPES.map(([label,key]) => root.DWFUI.rowHtml({
      tag: "button", cls: `zone-type-btn${selected === key ? " active" : ""}`, selected: selected === key,
      layout: "icon",   // DWFUI owns the icon+label layout now (scale-correct icon column + gap);
                        // the palette no longer hand-rolls a private grid that hardcodes the icon track.
      dataset: { zoneType:key }, title: label, label,
      // native draws every palette icon inside a gold box (Z12-jt-1/3, the barracks
      // oracle); .zone-type-iconbox carries that border.
      iconCfg: { sprite: root.DWFUI.zoneSprite(key), size: 32, alt: label, cls: "zone-type-iconbox" },
    })).join("");
    return `<div class="zone-plate">Select a type below to add a zone.</div><div class="zone-type-panel"><div class="zone-type-title">Click an icon to add a new zone.</div><div class="zone-type-grid">${buttons}</div></div>`;
  }

  // The citizen feed carries no ALL/MILITARY/CIVILIAN bit, so the controller joins /squads' filled
  // positions before calling this pure shaper. Sort stays explicit, never the server's incidental order.
  function burrowMembershipRows(citizens, memberIds, militaryIds, state) {
    const s = state || {};
    const members = memberIds instanceof Set ? memberIds : new Set(memberIds || []);
    const military = militaryIds instanceof Set ? militaryIds : new Set(militaryIds || []);
    const militaryKnown = s.militaryKnown !== false;
    const filter = militaryKnown && (s.filter === "military" || s.filter === "civilian")
      ? s.filter : "all";
    const tokens = String(s.search || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = (Array.isArray(citizens) ? citizens : []).filter(Boolean).map(row => {
      const unitId = Number(row.unitId);
      return Object.assign({}, row, {
        unitId,
        assigned: members.has(unitId),
        military: militaryKnown ? military.has(unitId) : null,
      });
    }).filter(row => {
      if (filter === "military" && row.military !== true) return false;
      if (filter === "civilian" && row.military !== false) return false;
      if (!tokens.length) return true;
      const haystack = `${row.name || ""} ${row.profession || ""}`.toLowerCase();
      return tokens.every(token => haystack.includes(token));
    });
    const sort = s.sort === "profession" || s.sort === "membership" ? s.sort : "name";
    rows.sort((a, b) => {
      if (sort === "membership" && a.assigned !== b.assigned) return a.assigned ? -1 : 1;
      const av = String(sort === "profession" ? a.profession || "" : a.name || "");
      const bv = String(sort === "profession" ? b.profession || "" : b.name || "");
      return av.localeCompare(bv, undefined, { sensitivity: "base" }) ||
        String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }) ||
        a.unitId - b.unitId;
    });
    return rows;
  }

  function burrowMembershipControlsMarkup(citizens, militaryIds, state) {
    const list = Array.isArray(citizens) ? citizens : [];
    const military = militaryIds instanceof Set ? militaryIds : new Set(militaryIds || []);
    const s = state || {};
    const militaryKnown = s.militaryKnown !== false;
    const chips = root.DWFUI.filterChipsHtml({
      cls: "burrow-cit-filters", dataAttr: "burrow-cit-filter",
      active: s.filter === "military" ? 1 : s.filter === "civilian" ? 2 : 0,
      ariaLabel: "Citizen category",
      chips: [
        { key: "all", label: "All", count: list.length },
        { key: "military", label: "Military",
          count: militaryKnown ? list.filter(row => military.has(Number(row && row.unitId))).length : null,
          disabled: !militaryKnown },
        { key: "civilian", label: "Civilian",
          count: militaryKnown ? list.filter(row => !military.has(Number(row && row.unitId))).length : null,
          disabled: !militaryKnown },
      ],
    });
    const sort = root.DWFUI.sortHeaderHtml({
      cls: "burrow-cit-sort", dataAttr: "burrow-cit-sort",
      active: s.sort === "profession" || s.sort === "membership" ? s.sort : "name",
      ariaLabel: "Sort citizens",
      columns: [
        { key: "name", label: "Name", sort: "text" },
        { key: "profession", label: "Profession", sort: "text" },
        { key: "membership", label: "Member", sort: "desc" },
      ],
    });
    const unavailable = militaryKnown ? "" : root.DWFUI.statusHtml({
      cls: "burrow-cit-filter-status", tone: "dim",
      text: "Military categories unavailable: the squad roster could not be read.",
    });
    return `<div class="burrow-cit-controls">${chips}${sort}${unavailable}</div>`;
  }

  // Text plaques (Add / Save / Done / a burrow's own name). `cls` keeps the classname the existing
  // CSS and the live controllers pin; the plaque itself is now DWFUI's.
  function plaque(cls, dataset, label, title, tone) {
    return root.DWFUI.plaqueBtnHtml({ cls, dataset, label, title, tone });
  }

  function burrowRowMarkup(burrow, state) {
    const b = burrow || {}, s = state || {}, id = Number(b.id);
    const armed = id === Number(s.paintId);
    const renaming = id === Number(s.renamingId);
    const name = root.DWFUI.esc(b.name || `Burrow ${id}`);
    // Editable text remains a DOM input, but DWFUI owns its shared field structure while the
    // existing class and data hook retain the burrow controller's styling and behaviour.
    const nameCell = renaming
      ? root.DWFUI.textInputHtml({ cls: "burrow-rename-input", dataset: { burrowRenameInput: id },
          value: b.name || `Burrow ${id}`, placeholder: "Burrow name...", maxLength: 64 }) +
        plaque("burrow-done", { burrowRenameSave:id }, "Save", "Save the new burrow name")
      : plaque("burrow-name", { burrowPaint:id }, b.name || `Burrow ${id}`,
          `Paint this burrow's tiles (add${armed ? "; active" : ""})`);
    const tool = (dataset,title,sprite,active,cls) => tile(dataset, title, sprite, active, `burrow-tool${cls ? " " + cls : ""}`);
    return `<div class="burrow-row${armed ? " armed" : ""}" data-burrow-row="${id}"><div class="burrow-row-main">${nameCell}<span class="burrow-members">${Number(b.memberCount) || 0} citizen${Number(b.memberCount) === 1 ? "" : "s"}</span></div><div class="burrow-row-tools">` +
      `${tool({ burrowRename:id }, "Rename burrow", "burrowRename", false)}` +
      `${tool({ burrowSuspend:id }, "Suspend/resume burrow", "burrowSuspend", !!b.suspended, b.suspended ? "on" : "")}` +
      // SUPERSET with no oracle: DF has no per-burrow civilian-alert control, so a placeholder tile says so
      // rather than borrowing SQUADS_CHANGE_ALERT and fabricating an identity.
      `${root.DWFUI.artBtnHtml({ cls: `burrow-tool${b.civAlert ? " on" : ""}`, dataset: { burrowCivalert:id },
        placeholder: true, active: !!b.civAlert, ariaLabel: "Civilian alert",
        title: "Civilian alert (multiplayer superset -- DF has no per-burrow civilian-alert button, so there is no native sprite for it)" })}` +
      `${tool({ burrowWorkshops:id }, b.limitWorkshops
          ? "Workshops: burrow only (click for everywhere)"
          : "Workshops: everywhere (click for burrow only)",
        b.limitWorkshops ? "burrowWorkshopsOnly" : "burrowWorkshopsAll", !!b.limitWorkshops)}` +
      // symbol/colour picker (df::burrow symbol_index + fg_color/bg_color). BURROW_REPAINT is
      // DF's own "restyle this burrow" glyph and was sitting unused in interface_map.json.
      `${tool({ burrowSymbol:id }, "Symbol and colour", "burrowRepaint", false)}` +
      `${tool({ burrowCitizens:id }, "Assign citizens", "burrowAddUnit", false)}` +
      // A burrow's rects are fetched for the camera's z only, so an off-level burrow is invisible without
      // this recenter tile.
      `${tool({ burrowRecenter:id }, "Recenter the map on this burrow", "burrowRecenter", false)}` +
      `${tool({ burrowDelete:id }, "Delete burrow", "burrowDelete", false, "danger")}</div></div>`;
  }

  const BURROW_SYMBOLS = 23;
  const BURROW_COLORS = 16;
  const BURROW_COLOR_NAMES = ["Black","Blue","Green","Cyan","Red","Magenta","Brown","Light gray",
    "Dark gray","Light blue","Light green","Light cyan","Light red","Light magenta","Yellow","White"];

  function burrowSymbolMarkup(state) {
    const s = state || {};
    const burrow = s.burrow || {};
    const id = Number(burrow.id);
    const curSymbol = Number(burrow.symbolIndex) || 0;
    const curFg = Number(burrow.fgColor);
    const curBg = Number(burrow.bgColor);
    const palette = Array.isArray(s.paletteRgb) ? s.paletteRgb : [];

    const symbols = Array.from({ length: BURROW_SYMBOLS }, (_, i) => root.DWFUI.artBtnHtml({
      cls: `burrow-symbol-cell${i === curSymbol ? " on" : ""}`,
      dataset: { burrowSymbolPick: i },
      active: i === curSymbol,
      spriteCrop: `burrowSymbol${i}`,
      size: 32,
      ariaLabel: `Symbol ${i + 1}`,
      title: `Symbol ${i + 1} of ${BURROW_SYMBOLS}`,
    })).join("");

    // A colour chip has no sprite -- the colour IS the identity -- so it goes through DWFUI's `swatch`
    // channel. A palette DF did not give us renders NO chips: an invented colour would be a lie.
    const swatches = (channel, current) => Array.from({ length: BURROW_COLORS }, (_, i) => {
      const rgb = palette[i];
      if (!Array.isArray(rgb) || rgb.length !== 3) return "";
      const css = `rgb(${Number(rgb[0]) | 0},${Number(rgb[1]) | 0},${Number(rgb[2]) | 0})`;
      const name = BURROW_COLOR_NAMES[i] || `Colour ${i}`;
      return root.DWFUI.artBtnHtml({
        cls: `burrow-swatch${i === current ? " on" : ""}`,
        dataset: { burrowColorChannel: channel, burrowColorIndex: i },
        active: i === current,
        swatch: css,
        ariaLabel: name,
        title: name,
      });
    }).join("");

    // df::burrow.tile (the legacy ASCII character) is deliberately not exposed: no oracle maps a symbol
    // index back to its CP437 character, so the server leaves the field alone rather than inventing one.
    return `<div class="burrow-head">
        ${root.DWFUI.artBtnHtml({ cls: "burrow-add burrow-back", dataset: { burrowSymbolBack: "" }, sprite: "BUTTON_CLOSE_LEFT", title: "Back to the burrow list", ariaLabel: "Back to the burrow list" })}
        <div class="burrow-cit-title">${root.DWFUI.esc(burrow.name || `Burrow ${id}`)}: symbol</div>
      </div>
      <div class="burrow-symbol-body">
        <div class="burrow-section-title">Symbol</div>
        <div class="burrow-symbol-grid">${symbols}</div>
        <div class="burrow-section-title">Colour</div>
        <div class="burrow-swatch-grid">${swatches("fg", curFg)}</div>
        <div class="burrow-section-title">Background</div>
        <div class="burrow-swatch-grid">${swatches("bg", curBg)}</div>
      </div>
      <div class="stock-palette-status${s.statusError ? " err" : ""}" data-burrow-status>${root.DWFUI.esc(s.status || "")}</div>`;
  }

  function burrowPanelMarkup(state) {
    const s = state || {}, rows = Array.isArray(s.burrows) ? s.burrows : [];
    const painting = Number(s.paintId) >= 0;
    const armed = rows.find(row => Number(row.id) === Number(s.paintId));
    const paintBar = painting ? `<div class="burrow-paint-bar"><div class="burrow-paint-label">Painting: ${root.DWFUI.esc(armed?.name || `Burrow ${s.paintId}`)}</div><div class="burrow-paint-tools">${paintPair(s.paintMode)}${subgroup("burrow-tools", tile({ burrowErase:"" }, "Erase burrow tiles", "burrowErase", !!s.erase))}${plaque("burrow-done", { burrowPaintDone:"" }, "Done painting", "Stop painting this burrow", "red")}</div></div>` : "";
    return `<div class="burrow-head">${plaque("burrow-add", { burrowAdd:"" }, "Add new burrow", "Create a new burrow", "green")}</div>${paintBar}<div class="burrow-list">${rows.length ? rows.map(row => burrowRowMarkup(row, s)).join("") : '<div class="burrow-empty"></div>'}</div><div class="stock-palette-status${s.statusError ? " err" : ""}" data-burrow-status>${root.DWFUI.esc(s.status || "")}</div>`;
  }

  // ---- hauling depth -------------------------------------------------------------------------

  const HAUL_GROUPS = ["animals", "food", "furniture", "corpses", "refuse", "stone", "ammo",
    "coins", "bars_blocks", "gems", "finished_goods", "leather", "cloth", "wood", "weapons",
    "armor", "sheet"];
  const HAUL_GROUP_LABEL = { bars_blocks: "bars/blocks", finished_goods: "finished goods" };
  const HAUL_MODES = ["push", "ride", "guide"];
  const HAUL_DIRS = ["north", "south", "east", "west"];

  // "wants: stone, wood" -- the stop's desired-items filter, summarised from the 17 group bits.
  function haulingDesiredSummary(stop) {
    const d = (stop && stop.desired) || {};
    const on = HAUL_GROUPS.filter(k => d[k]);
    if (!on.length) return "Wants nothing yet - the cart will not load here.";
    return "Wants: " + on.map(k => HAUL_GROUP_LABEL[k] || k).join(", ");
  }

  // `desired` gates on the stop's item filter; `atMost` inverts the fullness test, which is how "leave
  // once emptied" is expressed. guide_path is DF-authored and read-only.
  function haulingConditionText(c) {
    const cond = c || {};
    const pct = Number(cond.loadPercent) || 0;
    const what = cond.desired ? "the desired items" : "cargo";
    const fill = cond.atMost
      ? `at most ${pct}% ${what}`
      : `at least ${pct}% ${what}`;
    const wait = Number(cond.timeout) > 0 ? `, or after ${Number(cond.timeout)} ticks` : "";
    const path = Array.isArray(cond.guidePath) && cond.guidePath.length
      ? ` [guided path: ${cond.guidePath.length} tiles]`
      : "";
    return `${root.DWFUI.sentenceCase(String(cond.mode || "push"))} ${String(cond.direction || "north")} when ${fill}${wait}${path}`;
  }

  function haulingConditionRowMarkup(route, stop, cond) {
    const r = route || {}, s = stop || {}, c = cond || {};
    return `<div class="hauling-cond-row"><span class="hauling-stop-name">${root.DWFUI.esc(haulingConditionText(c))}</span>` +
      `${tile({ haulingCondRemove: `${Number(r.id)}:${Number(s.id)}:${Number(c.index)}` }, "Remove this departure condition", "haulingDeleteStop", false, "burrow-tool danger")}</div>`;
  }

  function haulingStockpileLinkRowMarkup(route, stop, link) {
    const r = route || {}, s = stop || {}, l = link || {};
    const buildingId = Number(l.buildingId);
    const key = `${Number(r.id)}:${Number(s.id)}:${buildingId}`;
    const direction = l.take && l.give ? "Takes from and gives to"
      : l.take ? "Takes from" : l.give ? "Gives to" : "No direction";
    const controls = `<div class="hauling-stockpile-link-tools">
      <label class="hauling-link-check">
        ${root.DWFUI.checkHtml({ checked: !!l.take, dataset: { haulingLinkToggle: `${key}:take` },
          title: "Take desired items from this stockpile", ariaLabel: `Take from stockpile ${buildingId}` })}
        <span>Take from</span>
      </label>
      <label class="hauling-link-check">
        ${root.DWFUI.checkHtml({ checked: !!l.give, dataset: { haulingLinkToggle: `${key}:give` },
          title: "Give unloaded items to this stockpile", ariaLabel: `Give to stockpile ${buildingId}` })}
        <span>Give to</span>
      </label>
      ${tile({ haulingLinkRemove: key }, "Remove this stockpile link", "haulingDeleteStop", false, "burrow-tool danger")}
    </div>`;
    return root.DWFUI.rowHtml({
      cls: "hauling-stockpile-link",
      label: `Stockpile #${buildingId}`,
      sub: { text: direction, cls: "hauling-stockpile-link-direction" },
      trailing: controls,
    });
  }

  // Native draws two add modes, TAKE and GIVE. EXCHANGE is a data value, not a third drawn control --
  // do not manufacture an Exchange button here.
  function haulingStockpileLinksMarkup(route, stop, state) {
    const r = route || {}, s = stop || {}, st = state || {};
    const key = `${Number(r.id)}:${Number(s.id)}`;
    const links = Array.isArray(s.stockpiles) ? s.stockpiles : [];
    const armed = st.linkArmed && Number(st.linkArmed.route) === Number(r.id) &&
      Number(st.linkArmed.stop) === Number(s.id) ? st.linkArmed : null;
    const rows = links.length
      ? links.map(link => haulingStockpileLinkRowMarkup(r, s, link)).join("")
      : '<div class="hauling-stockpile-link-empty">No stockpile links yet.</div>';
    const addControls = armed
      ? `${plaque("hauling-link-done", { haulingLinkDone: key }, "Done linking", "Stop choosing stockpiles", "red")}
         <span class="hauling-link-armed">Click stockpiles on the map to ${armed.mode === "take" ? "take from" : "give to"} them.</span>`
      : `${plaque("hauling-link-arm", { haulingLinkArm: `${key}:take` }, "Take from stockpile", "Click stockpiles to take desired items from them")}
         ${plaque("hauling-link-arm", { haulingLinkArm: `${key}:give` }, "Give to stockpile", "Click stockpiles to give unloaded items to them")}`;
    return `<div class="hauling-stockpile-links">
      <div class="burrow-section-title">Stockpile links</div>
      ${root.DWFUI.scrollHtml({ cls: "hauling-stockpile-link-list", rows: ".hauling-stockpile-link",
        preserveKey: `haul-links-${key}`, ariaLabel: "Linked stockpiles" }, rows)}
      <div class="hauling-stockpile-link-add">${addControls}</div>
    </div>`;
  }

  // The stop's expanded editor: desired items (opens the shared stockpile filter, pointed at the
  // stop), stockpile links, the departure-condition list, and the add-condition form.
  function haulingStopDetailMarkup(route, stop, state) {
    const r = route || {}, s = stop || {}, st = state || {};
    const key = `${Number(r.id)}:${Number(s.id)}`;
    const conds = Array.isArray(s.conditions) ? s.conditions : [];
    const draft = st.condDraft || {};
    const mode = HAUL_MODES.includes(draft.mode) ? draft.mode : "push";
    const dir = HAUL_DIRS.includes(draft.direction) ? draft.direction : "north";
    const load = [0, 50, 100].includes(Number(draft.loadPercent)) ? Number(draft.loadPercent) : 100;

    const condList = conds.length
      ? conds.map(c => haulingConditionRowMarkup(r, s, c)).join("")
      : '<div class="hauling-cond-row"><span class="hauling-stop-name">No departure condition - the cart will wait here forever.</span></div>';

    // load_percent is snapped to 0/50/100 on the server: df-structures marks any other value
    // "broken display". Offering only the three DF itself offers keeps the UI honest.
    const loadSeg = root.DWFUI.segmentedHtml({
      cls: "hauling-cond-seg", dataAttr: "hauling-cond-load",
      options: [0, 50, 100].map(v => ({ key: String(v), label: `${v}%` })),
      active: String(load),
      ariaLabel: "How full the cart must be",
    });
    const modeSeg = root.DWFUI.segmentedHtml({
      cls: "hauling-cond-seg", dataAttr: "hauling-cond-mode",
      options: HAUL_MODES.map(m => ({ key: m, label: root.DWFUI.sentenceCase(m) })),
      active: mode,
      ariaLabel: "How the cart leaves",
    });
    const dirSeg = root.DWFUI.segmentedHtml({
      cls: "hauling-cond-seg", dataAttr: "hauling-cond-dir",
      options: HAUL_DIRS.map(d => ({ key: d, label: root.DWFUI.sentenceCase(d) })),
      active: dir,
      ariaLabel: "Which way the cart leaves",
    });

    return `<div class="hauling-stop-detail">
      ${haulingStockpileLinksMarkup(r, s, st)}
      <div class="burrow-section-title">Desired items</div>
      <div class="hauling-desired">
        <span class="hauling-stop-name">${root.DWFUI.esc(haulingDesiredSummary(s))}</span>
        ${plaque("hauling-desired-edit", { haulingDesiredEdit: key }, "Choose items", "Choose what this stop loads")}
      </div>
      <div class="burrow-section-title">Departure conditions</div>
      ${root.DWFUI.scrollHtml({ cls: "hauling-cond-list", rows: ".hauling-cond-row", preserveKey: `haul-cond-${key}`, ariaLabel: "Departure conditions" }, condList)}
      <div class="hauling-cond-form">
        ${modeSeg}${dirSeg}${loadSeg}
        <div class="hauling-cond-checks">
          ${root.DWFUI.checkHtml({ checked: !!draft.atMost, dataset: { haulingCondAtmost: key }, title: "Leave when the cart is at MOST this full (i.e. once it has been emptied here)", ariaLabel: "At most this full" })}
          <span class="hauling-stop-name">Leave once emptied (at most)</span>
        </div>
        <div class="hauling-cond-checks">
          ${root.DWFUI.checkHtml({ checked: !!draft.desired, dataset: { haulingCondDesired: key }, title: "Measure only the desired items above, not the cart's bulk fullness", ariaLabel: "Only desired items" })}
          <span class="hauling-stop-name">Count only the desired items</span>
        </div>
        ${plaque("hauling-cond-add", { haulingCondAdd: key }, "Add condition", "Add this departure condition to the stop", "green")}
      </div>
    </div>`;
  }

  function haulingStopRowMarkup(route, stop, state) {
    const r = route || {}, s = stop || {}, st = state || {};
    const open = String(st.openStopKey || "") === `${Number(r.id)}:${Number(s.id)}`;
    const conds = Array.isArray(s.conditions) ? s.conditions : [];
    const summary = `${conds.length} condition${conds.length === 1 ? "" : "s"}`;
    const key = `${Number(r.id)}:${Number(s.id)}`;
    // /hauling-stop-rename is new, so an older server greys the quill rather than posting into a 404:
    // unknown reads as unavailable, which is the safe direction.
    const renameReady = typeof root.dwfHasServerFeature === "function" &&
      root.dwfHasServerFeature("hauling-stop-rename");
    const renaming = renameReady && String(st.renamingStopKey || "") === key;
    const nameCell = renaming
      ? root.DWFUI.textInputHtml({ cls: "hauling-rename-input", dataset: { haulingStopRenameInput: key },
          value: s.name || `Stop ${s.id}`, placeholder: "Stop name...", maxLength: 64 }) +
        plaque("burrow-done", { haulingStopRenameSave: key }, "Save", "Save the new stop name")
      : plaque("hauling-stop-open", { haulingStopOpen: key }, `${s.name || `Stop ${s.id}`} (${Number(s.x)},${Number(s.y)},${Number(s.z)})`, "Edit this stop's items and departure conditions");
    return `<div class="hauling-stop-row" data-hauling-stop-row="${Number(s.id)}">` +
      `<div class="hauling-stop-main">${nameCell}<span class="burrow-members">${summary}</span></div>` +
      `<div class="hauling-stop-tools">${tile({ haulingStopRename: key }, renameReady ? "Rename stop"
        : "Renaming a stop needs a newer server than this one", "haulingRename", false,
        "burrow-tool" + (renameReady ? "" : " is-disabled"))}` +
      `${tile({ haulingStopRemove: key }, "Remove stop", "haulingDeleteStop", false, "burrow-tool danger")}</div></div>` +
      (open ? haulingStopDetailMarkup(r, s, st) : "");
  }

  function haulingVehiclesMarkup(route, state) {
    const r = route || {}, s = state || {}, id = Number(r.id);
    const carts = Array.isArray(r.vehicles) ? r.vehicles : [];
    const free = Array.isArray(s.freeVehicles) ? s.freeVehicles : [];
    const stops = Array.isArray(r.stops) ? r.stops : [];

    const assigned = carts.length
      ? carts.map(v => {
          const at = Number(v.stopIndex) >= 0 ? ` - at stop ${Number(v.stopIndex) + 1}` : "";
          return `<div class="hauling-cond-row"><span class="hauling-stop-name">Minecart #${Number(v.itemId)}${at}</span>` +
            `${tile({ haulingVehicleRemove: `${id}:${Number(v.itemId)}` }, "Take this minecart off the route", "haulingDeleteStop", false, "burrow-tool danger")}</div>`;
        }).join("")
      : '<div class="hauling-cond-row"><span class="hauling-stop-name">No minecart assigned - nothing will move.</span></div>';

    // DFHack's assign-minecarts.lua refuses a stopless route, and so does the server; say so here
    // rather than letting the player click into a 400.
    if (!stops.length)
      return `<div class="hauling-vehicles"><div class="burrow-section-title">Minecart</div>${assigned}` +
        `<div class="hauling-stop-name">Add a stop before assigning a minecart.</div></div>`;

    const pickable = free.length
      ? free.map(v => `<div class="hauling-cond-row">${plaque("hauling-vehicle-pick", { haulingVehicleAdd: `${id}:${Number(v.itemId)}` }, v.name || `Minecart #${v.itemId}`, "Assign this minecart to the route", "green")}</div>`).join("")
      : '<div class="hauling-cond-row"><span class="hauling-stop-name">No free minecarts. Build one, or free one from another route.</span></div>';

    return `<div class="hauling-vehicles">
      <div class="burrow-section-title">Minecart</div>
      ${assigned}
      <div class="burrow-section-title">Free minecarts</div>
      ${root.DWFUI.scrollHtml({ cls: "hauling-vehicle-list", rows: ".hauling-cond-row", preserveKey: `haul-veh-${id}`, ariaLabel: "Free minecarts" }, pickable)}
    </div>`;
  }

  function haulingRouteRowMarkup(route, state) {
    const r = route || {}, s = state || {}, id = Number(r.id);
    const armed = id === Number(s.armedRouteId), selected = id === Number(s.selectedRouteId);
    const stops = Array.isArray(r.stops) ? r.stops : [], vehicles = Array.isArray(r.vehicleIds) ? r.vehicleIds : [];
    const detail = selected ? `<div class="burrow-cit-row is-expanded">${stops.length ? stops.map(stop => haulingStopRowMarkup(r, stop, s)).join("") : '<div class="hauling-stop-row">No stops yet.</div>'}${haulingVehiclesMarkup(r, s)}</div>` : "";
    // /hauling-route-rename has existed since the panel was written and only the control was missing, so
    // this one is live rather than feature-gated.
    const renaming = id === Number(s.renamingRouteId);
    const nameCell = renaming
      ? root.DWFUI.textInputHtml({ cls: "hauling-rename-input", dataset: { haulingRouteRenameInput: id },
          value: r.name || `Route ${id}`, placeholder: "Route name...", maxLength: 64 }) +
        plaque("burrow-done", { haulingRouteRenameSave:id }, "Save", "Save the new route name")
      : plaque("burrow-name", { haulingSelect:id }, r.name || `Route ${id}`, "Show this route's stops");
    return `<div class="burrow-row${armed ? " armed" : ""}" data-hauling-route-row="${id}"><div class="burrow-row-main">${nameCell}<span class="burrow-members">${stops.length} stop${stops.length === 1 ? "" : "s"} &middot; ${vehicles.length} cart${vehicles.length === 1 ? "" : "s"}</span></div><div class="burrow-row-tools">${plaque(`hauling-stop-arm${armed ? " on" : ""}`, { haulingStopArm:id }, armed ? "Placing..." : "Add stop", armed ? "Stop placing stops" : "Add stop (click the map)")}${tile({ haulingRouteRename:id }, "Rename route", "haulingRename", false, "burrow-tool")}${tile({ haulingRouteRemove:id }, "Remove route", "haulingDeleteRoute", false, "burrow-tool danger")}</div>${detail}</div>`;
  }

  function haulingPanelMarkup(state) {
    const s = state || {}, routes = Array.isArray(s.routes) ? s.routes : [];
    const armed = routes.find(route => Number(route.id) === Number(s.armedRouteId));
    const paintBar = Number(s.armedRouteId) >= 0 ? `<div class="burrow-paint-bar"><div class="burrow-paint-label">Placing stops: ${root.DWFUI.esc(armed?.name || `Route ${s.armedRouteId}`)}</div><div class="burrow-paint-tools">${plaque("burrow-done", { haulingStopDone:"" }, "Done placing stops", "Stop placing stops on this route", "red")}</div></div>` : "";
    return `<div class="burrow-head">${plaque("burrow-add", { haulingAdd:"" }, "Add new route", "Create a new hauling route", "green")}</div>${paintBar}<div class="burrow-list">${routes.length ? routes.map(route => haulingRouteRowMarkup(route, s)).join("") : '<div class="burrow-empty"></div>'}</div><div class="stock-palette-status${s.statusError ? " err" : ""}" data-hauling-status>${root.DWFUI.esc(s.status || "")}</div>`;
  }

  const api = { SPRITE_TOKENS, GLOBAL_OPEN_MENU, paintSprite, paintControlIcons, alignControlSubmenus, priorityMarkup, digSubmenuMarkup,
    plantSubmenuMarkup, smoothSubmenuMarkup, itemSubmenuMarkup, stockSubmenuMarkup,
    stockSubmenuInventoryMarkup, setHydratedStockStage, stockRemoveBuildingId, stockpileBuildingAt,
    stockRemoveConfirmMarkup, installStockpilePaintSafety,
    zoneSubmenuMarkup, trafficSubmenuMarkup,
    bottomToolbarMarkup, submenuFrame, previewMarkup, hydrate, ZONE_TYPES, zonePaletteMarkup,
    burrowMembershipRows, burrowMembershipControlsMarkup,
    burrowRowMarkup, burrowPanelMarkup, burrowSymbolMarkup, haulingStopRowMarkup, haulingRouteRowMarkup,
    haulingPanelMarkup, haulingStopDetailMarkup, haulingVehiclesMarkup, haulingConditionText,
    haulingStockpileLinksMarkup, haulingStockpileLinkRowMarkup,
    haulingDesiredSummary, HAUL_GROUPS, HAUL_MODES, HAUL_DIRS,
    BURROW_COLOR_NAMES, TRAFFIC_LEVELS };
  root.DwfControlShell = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root.__DWF_STORY_MODE) hydrate();
})(typeof window !== "undefined" ? window : globalThis);
