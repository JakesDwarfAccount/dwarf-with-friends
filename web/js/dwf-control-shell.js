// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// SPDX-License-Identifier: AGPL-3.0-only

// Shared production markup + native sprite vocabulary for the persistent bottom toolbar and
// designation paint rows. The live controller owns behavior; Parity Studio renders these exact
// builders and asks the same sprite painter to decorate them from interface_map.json.
(function (root) {
  "use strict";

  root.DWFUI.require("fortress-controls",
    ["toolButtonHtml", "artBtnHtml", "plaqueBtnHtml", "rowHtml", "iconHtml", "bitmapTextHtml", "rawHtml", "TOKENS"]);

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
    // B230: three DF burrow tokens that shipped in interface_map.json and were never bound to a
    // control. BURROW_REPAINT is DF's restyle glyph (now the symbol/colour picker); the two
    // WORKSHOPS tokens are the two states of burrow_flag.limit_workshops -- a real two-state
    // native pair, so no substitution is being made here.
    burrowRepaint:{normal:"BURROW_REPAINT"},
    burrowWorkshopsAll:{normal:"BURROW_WORKSHOPS_EVERYWHERE", active:"BURROW_WORKSHOPS_EVERYWHERE"},
    burrowWorkshopsOnly:{normal:"BURROW_WORKSHOPS_BURROW_ONLY", active:"BURROW_WORKSHOPS_BURROW_ONLY"},
    // The hauling row used to delete a STOP and a ROUTE with BURROW_DELETE. DF ships a token for
    // each (12-item-designations family); the wire is unchanged, only the art is now the right one.
    haulingDeleteStop:{normal:"HAULING_DELETE_STOP"}, haulingDeleteRoute:{normal:"HAULING_DELETE_ROUTE"},
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

  // 18 activity-zone icons. `interface_map.json` indexes the SAME sheet the palette used to reach
  // through a private CSS background-position -- a fifth, uncoordinated art channel. These are the
  // real tokens; the palette now paints through DWFUI's one sprite funnel.
  const ZONE_SPRITES = {
    meeting:"ZONE_MEETING", office:"ZONE_OFFICE", bedroom:"ZONE_BEDROOM", dormitory:"ZONE_DORMITORY",
    dining:"ZONE_DINING_HALL", barracks:"ZONE_BARRACKS", pen:"ZONE_PEN", archery:"ZONE_ARCHERY_RANGE",
    pond:"ZONE_PIT", dump:"ZONE_DUMP", water:"ZONE_WATER_SOURCE", training:"ZONE_ANIMAL_TRAINING",
    dungeon:"ZONE_DUNGEON", tomb:"ZONE_TOMB", fishing:"ZONE_FISHING", gather:"ZONE_GATHER",
    sand:"ZONE_SAND", clay:"ZONE_CLAY",
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
    icon.style.cssText = `width:${boxW}px;height:${boxH}px;image-rendering:pixelated;`;
    root.DFChrome.updateIcon(icon, active && tokens.active ? tokens.active : tokens.normal, Math.max(boxW, boxH));
    button.classList.toggle("active", !!active);
    // Native carries "selected" in the SPRITE (a green outline baked into the _ACTIVE variant --
    // 01-dig.png, 04-smooth.png, 11-traffic.png). ~12 of our tokens have no _ACTIVE variant at all,
    // so after 3dc0c9eb they rendered selected exactly like unselected. Declare which tiles own
    // their selected paint; the stylesheet draws the same green outline on the ones that do not.
    if (tokens.active && tokens.active !== tokens.normal) button.setAttribute("data-df-active-art", "");
    else button.removeAttribute("data-df-active-art");
    return true;
  }

  // Native draws a gold 1px frame around each toolbar/submenu CLUSTER (00-base-map.png: the four
  // centre sub-groups are framed, the left info group and the right squads/world group are not;
  // 01-dig.png: the dig-tool cluster and the paint-mode pair are each framed, the expander is bare).
  // Chrome belongs to the OUTERMOST owner -- the tiles inside draw no border of their own.
  function subgroup(cls, inner) {
    return `<div class="tool-subgroup${cls ? " " + cls : ""}">${inner}</div>`;
  }

  // W23: a tile for a probe-guarded write. Fail closed off window.DFWriteGuards: when the flag
  // is not literally enabled (or the guards are unreachable), the tile renders DISABLED with the
  // shared plain-English reason as its title -- a locked write must never look live.
  function tile(dataset, title, sprite, active, cls, labelHtml) {
    return root.DWFUI.toolButtonHtml({
      // `data-dwfui-sprite` is reserved for a REAL interface_map token. `sprite` here is a
      // semantic control-shell key ("stockpile", "dig", ...), resolved through SPRITE_TOKENS.
      // Sharing the attribute made DWFUI flag valid toolbar art as missing and paint a plum box.
      cls, dataset: { ...(dataset || {}), dfControlSprite: sprite, dfControlSpriteActive: active ? "1" : "0" },
      title, ariaLabel: title, active, labelHtml,
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

  // SUPERSET, kept and dressed honestly: DF has no warm/damp dig toggle, so interface_map.json has
  // no token for it (`&warmdamp=` -> src/http_server.cpp:920). A placeholder tile states that
  // outright instead of inventing art or a hotkey line.
  function warmDampTile(on) {
    return root.DWFUI.toolButtonHtml({
      cls: `dig-opt dwfui-btn--placeholder${on ? " active" : ""}`, dataset: { digOpt:"warmdamp" }, active: !!on,
      title: "Dig through damp or warm tiles (multiplayer superset -- DF has no such toolbar button, so there is no native sprite for it)",
      ariaLabel: "Dig through damp or warm tiles",
    });
  }

  const DIG_MODES = [[0,"All","digModeAll"],[1,"Auto","digModeAuto"],[2,"Ore","digModeOre"],[3,"Gem","digModeGem"]];
  function digSubmenuMarkup(state) {
    const s = state || {}, selected = s.selected || "dig", open = !!s.advanced;
    const tools = [
      ["dig","Regular dig"],["stairs","Dig stairs: select both z-level endpoints"],["ramp","Dig ramp"],
      // B268: DF's OWN tooltip, verbatim from the native capture
      // (evidence/oracles/designations/DESIG-REMOVE-CONSTRUCTIONS-native-tooltip.png). Ours used to
      // say only "remove construction", which is why nobody expected it to work on a slope -- and it
      // didn't, because we had named a MINING designation after a BUILDING job. DF's own words say
      // plainly that the one designation does both.
      ["channel","Dig channel"],
      ["remove","Designate constructed walls, floors, and other constructed tiles to be removed by miners. This also designates all stairwells and ramps."],
    ].map(([key,title]) => tile({ digTool:key }, title, key, selected === key)).join("");
    const modes = subgroup("dig-modes", DIG_MODES
      .map(([key,label,sprite]) => tile({ digMode:String(key) }, `Dig mode: ${label}`, sprite, Number(s.mineMode || 0) === key, "dig-mode"))
      .join(""));
    return `${subgroup("dig-tools", tools)}${paintPair(s.paintMode)}${expander({ digExpand:"" }, "More dig options", open)}` +
      `<div class="dig-adv${open ? " open" : ""}">${modes}` +
      `${tile({ digOpt:"marker" }, "Marker mode", "markerToggle", !!s.marker, "dig-opt")}` +
      `${warmDampTile(s.warmDamp)}` +
      `${priorityMarkup(s.priority)}${tile({ digTool:"convertmarker" }, "Convert to marker mode", "convertmarker", selected === "convertmarker")}` +
      `${tile({ digTool:"convertstandard" }, "Convert to standard mode", "convertstandard", selected === "convertstandard")}</div>`;
  }

  function plantSubmenuMarkup(state) {
    const s = state || {}, selected = s.selected === "gather" ? "gather" : "chop", open = s.advanced !== false;
    return `${subgroup("plant-tools", tile({ plantTool:selected }, selected === "chop" ? "Set tree chopping orders" : "Set plant gathering orders", selected, true))}` +
      `${paintPair(s.paintMode)}${expander({ plantExpand:"" }, "More plant order options", open)}` +
      `<div class="dig-adv plant-adv${open ? " open" : ""}">${priorityMarkup(s.priority)}</div>`;
  }

  function smoothSubmenuMarkup(state) {
    const s = state || {}, selected = s.selected || "smooth", open = s.advanced !== false;
    const tools = [["smooth","Smooth rough stone"],["engrave","Engrave artwork"],["track","Carve minecart track"],["fortify","Carve fortification"]]
      .map(([key,title]) => tile({ smoothTool:key }, title, key, selected === key)).join("");
    return `${subgroup("smooth-tools", tools)}${paintPair(s.paintMode)}${expander({ smoothExpand:"" }, "More smoothing options", open)}` +
      `<div class="dig-adv smooth-adv${open ? " open" : ""}">${tile({ digOpt:"marker" }, "Marker mode", "markerToggle", !!s.marker, "dig-opt")}${priorityMarkup(s.priority)}</div>`;
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

  function zoneSubmenuMarkup(state) {
    const s = state || {};
    return `${paintPair(s.paintMode)}${subgroup("zone-tools", tile({ zoneErase:"" }, "Erase-paint an existing zone", "zoneErase", !!s.erase) + tile({ zoneRemoveExisting:"" }, "Remove an existing zone", "zoneRemoveExisting", !!s.remove))}`;
  }

  // [key, sprite key, title, default pathfinding weight]. The glyph column ("»»»", "-") is gone:
  // 11-traffic.png shows four real DF sprites, and a sprite always beats a Unicode stand-in.
  const TRAFFIC_LEVELS = [
    ["high", "trafficHigh", "High traffic", 1], ["normal", "trafficNormal", "Normal traffic", 2],
    ["low", "trafficLow", "Low traffic", 5], ["restricted", "trafficRestricted", "Restricted traffic", 25],
  ];
  function trafficSubmenuMarkup(state) {
    const s = state || {}, level = s.level || "high", weights = s.weights || {};
    const levels = subgroup("traffic-levels", TRAFFIC_LEVELS
      .map(([key,sprite,title]) => tile({ trafficLevel:key }, title, sprite, level === key, "traffic-level"))
      .join(""));
    // B233-4: the cost sliders are LIVE. They write DF's real per-fort pathfinding costs --
    // plotinfo.main.traffic_cost_{high,normal,low,restricted} (df.plotinfo.xml:1064-1067), the same
    // four fields native's traffic menu edits -- through POST /traffic-costs (src/placement.cpp).
    // They were `disabled` only because no route existed; the fields always did.
    const weightRows = TRAFFIC_LEVELS.map(([key,,title,defaultWeight]) => {
      const value = Number(weights[key]) || defaultWeight;
      return `<label class="traffic-weight-row"><span>${title}</span><input type="range" min="1" max="50" value="${value}" data-traffic-weight="${key}" title="Pathfinding cost DF pays to step on a ${title.toLowerCase()} tile (native default ${defaultWeight})"><output>${value}</output></label>`;
    }).join("");
    return `${levels}${paintPair(s.paintMode)}<div class="traffic-weight-panel"><div class="traffic-weight-title">Traffic costs</div>${weightRows}<div class="traffic-weight-note" data-traffic-cost-note>Costs are DF's live pathfinding weights (defaults 1/2/5/25).</div></div>`;
  }

  const LEFT = ["citizens","orders","locations","labor","workorders","nobles","objects","justice"];
  function bottomToolbarMarkup(state) {
    const s = state || {}, active = s.active || "";
    const panel = key => tile({ dfBtn:"", panel:key }, key, key, active === key);
    const designation = [
      tile({ dfBtn:"", digMenu:"" }, "Dig", active === "dig" ? "lowerMenu" : "digMenu", active === "dig"),
      ...["chop","gather","smooth","erase"].map(key => tile({ dfBtn:"", designationTool:key }, key, active === key ? "lowerMenu" : key, active === key)),
    ].join("");
    const structures = ["build","stockpile","zone"].map(panel).join("");
    const modes = ["burrow","hauling","traffic"].map(key => tile({ dfBtn:"", modeTool:key }, key, key, active === key)).join("");
    const item = tile({ dfBtn:"", modeTool:"itemdesig" }, "Item designations", "itemdesig", active === "itemdesig");
    return `<div class="tool-group" id="leftTools">${LEFT.map(panel).join("")}</div>` +
      `<div class="tool-group" id="centerTools"><div class="tool-subgroup" id="designationBar">${designation}</div>` +
      `<div class="tool-subgroup" id="structureTools">${structures}</div><div class="tool-subgroup" id="modeTools">${modes}</div>` +
      `<div class="tool-subgroup" id="itemDesigTools">${item}</div></div>` +
      `<div class="tool-group" id="rightTools">${panel("squads")}${panel("worldmap")}</div>`;
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

  // Native submenu rows start directly above the toolbar button that opened them; they are not
  // centered on the viewport. Align LEFT EDGES after layout so the rule survives browser zoom,
  // interface scale, Studio transforms, and responsive toolbar grouping. Reset the old shift before
  // measuring so repeated updates can never accumulate drift.
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

  function hydrate() {
    const byId = id => root.document?.getElementById(id);
    const bottom = byId("bottomBar");
    if (bottom) bottom.innerHTML = bottomToolbarMarkup({});
    Object.entries(SUBMENU_IDS).forEach(([kind,id]) => {
      const host = byId(id);
      if (host) host.innerHTML = SUBMENU_BUILDERS[kind]({});
    });
  }

  const ZONE_TYPES = [
    ["Meeting Area","meeting",5,10],["Office","office",6,9],["Bedroom","bedroom",6,7],
    ["Dormitory","dormitory",6,12],["Dining Hall","dining",6,8],["Barracks","barracks",6,11],
    ["Pen/Pasture","pen",5,6],["Archery Range","archery",6,10],["Pit/Pond","pond",5,7],
    ["Garbage Dump","dump",5,5],["Water Source","water",5,2],["Animal Training","training",5,12],
    ["Dungeon","dungeon",6,13],["Tomb","tomb",6,14],["Fishing","fishing",5,3],
    ["Gather Fruit","gather",5,4],["Sand","sand",5,8],["Clay","clay",5,9],
  ];

  function zonePaletteMarkup(selected) {
    const buttons = ZONE_TYPES.map(([label,key]) => root.DWFUI.rowHtml({
      tag: "button", cls: `zone-type-btn${selected === key ? " active" : ""}`, selected: selected === key,
      layout: "icon",   // B270: DWFUI owns the icon+label layout now (scale-correct icon column + gap);
                        // the palette no longer hand-rolls a private grid that hardcodes the icon track.
      dataset: { zoneType:key }, title: label, label,
      // B217 r2: native draws every palette icon inside a gold box (Z12-jt-1/3, the barracks
      // oracle); .zone-type-iconbox carries that border.
      iconCfg: { sprite: ZONE_SPRITES[key], size: 32, alt: label, cls: "zone-type-iconbox" },
    })).join("");
    return `<div class="zone-plate">Select a type below to add a zone.</div><div class="zone-type-panel"><div class="zone-type-title">Click an icon to add a new zone.</div><div class="zone-type-grid">${buttons}</div></div>`;
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
      // SUPERSET with NO ORACLE: DF has no per-burrow civilian-alert control, so interface_map.json
      // has no token for it. A placeholder tile says so; inventing SQUADS_CHANGE_ALERT here would be
      // fabricating an identity. Reported as an art gap.
      `${root.DWFUI.artBtnHtml({ cls: `burrow-tool${b.civAlert ? " on" : ""}`, dataset: { burrowCivalert:id },
        placeholder: true, active: !!b.civAlert, ariaLabel: "Civilian alert",
        title: "Civilian alert (multiplayer superset -- DF has no per-burrow civilian-alert button, so there is no native sprite for it)" })}` +
      // B230: the OTHER burrow_flag bit (limit_workshops). DF ships real art for BOTH states --
      // BURROW_WORKSHOPS_BURROW_ONLY / BURROW_WORKSHOPS_EVERYWHERE -- so this is a genuine
      // two-state native button, not a substitution: the sprite itself says which state you are in.
      `${tool({ burrowWorkshops:id }, b.limitWorkshops
          ? "Workshops: burrow only (click for everywhere)"
          : "Workshops: everywhere (click for burrow only)",
        b.limitWorkshops ? "burrowWorkshopsOnly" : "burrowWorkshopsAll", !!b.limitWorkshops)}` +
      // B230: symbol/colour picker (df::burrow symbol_index + fg_color/bg_color). BURROW_REPAINT is
      // DF's own "restyle this burrow" glyph and was sitting unused in interface_map.json.
      `${tool({ burrowSymbol:id }, "Symbol and colour", "burrowRepaint", false)}` +
      `${tool({ burrowCitizens:id }, "Assign citizens", "burrowAddUnit", false)}` +
      `${tool({ burrowDelete:id }, "Delete burrow", "burrowDelete", false, "danger")}</div></div>`;
  }

  // B230 SYMBOL/COLOUR PICKER (a burrow sub-view, same shape as the citizens sub-view).
  //
  // Three strips, matching the three fields DF's own picker writes (df.burrow.xml):
  //   symbol -> burrow.symbol_index (0..22, a CUSTOM_SYMBOLS cell -- rendered here as the REAL DF
  //             glyph via DWFUI's burrowSymbol<i> sprite crops, not a stand-in),
  //   fg/bg  -> burrow.fg_color / bg_color (0..15, DF's curses palette).
  //
  // The 16 colour swatches are the one place this panel does NOT use native art: DF's burrow colour
  // picker is a grid of flat colour chips, and a flat chip IS the identity -- there is no sprite to
  // reproduce. They are painted from the burrow's own resolved RGB, which the SERVER reads out of
  // DF's live palette (gps->uccolor) and ships on each burrow, so the browser never guesses a colour
  // and a player with a custom colors.txt gets their own. `paletteRgb` is that palette, passed in.
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

    // A colour chip has no sprite to reproduce -- the colour IS the identity -- so it goes through
    // DWFUI's `swatch` channel (added for exactly this case) rather than a hand-rolled raw button.
    // A palette DF did not give us renders NO chips at all: an invented colour would be a lie about
    // what the game would actually paint.
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

    // The picker knowingly does NOT expose df::burrow.tile (the legacy ASCII character). DF v50
    // renders burrows from symbol_index + the texture RGB, and we have no oracle mapping a symbol
    // index back to its CP437 character -- so the server leaves `tile` alone rather than inventing
    // one. Documented in the closeout, not silently dropped.
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

  // ---- B231: hauling depth -------------------------------------------------------------------
  // A route used to be an empty shell: you could create it, drop stops on the map, and type a raw
  // item id at it. The three things that make a minecart route actually DO something --
  //   * what each stop wants loaded   (df::hauling_stop.settings, a full stockpile_settings)
  //   * when the cart leaves a stop   (df::stop_depart_condition)
  //   * where the cart goes           (df::stop_depart_condition.guide_path)
  // -- had NO client surface at all. The depart-condition endpoints even existed server-side and
  // nothing ever called them. These three helpers are that surface.

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

  // One departure condition, in the player's words rather than DF's field names. `desired` gates
  // on the stop's item filter (DESIRED_ITEMS); `atMost` inverts the fullness test (USE_LESS), which
  // is how "leave once emptied" is expressed. guide_path is DF-authored and read-only.
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

  // The stop's expanded editor: desired items (opens the shared stockpile filter, pointed at the
  // stop), the departure-condition list, and the add-condition form.
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
      <div class="burrow-section-title">Desired items</div>
      <div class="hauling-desired">
        <span class="hauling-stop-name">${root.DWFUI.esc(haulingDesiredSummary(s))}</span>
        ${plaque("hauling-desired-edit", { haulingDesiredEdit: key }, "Choose items", "Choose what this stop loads")}
      </div>
      <div class="burrow-section-title">Departure conditions</div>
      ${root.DWFUI.scrollHtml({ cls: "hauling-cond-list", preserveKey: `haul-cond-${key}`, ariaLabel: "Departure conditions" }, condList)}
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
    return `<div class="hauling-stop-row" data-hauling-stop-row="${Number(s.id)}">` +
      `${plaque("hauling-stop-open", { haulingStopOpen: `${Number(r.id)}:${Number(s.id)}` }, `${s.name || `Stop ${s.id}`} (${Number(s.x)},${Number(s.y)},${Number(s.z)})`, "Edit this stop's items and departure conditions")}` +
      `<span class="burrow-members">${summary}</span>` +
      `${tile({ haulingStopRemove:`${Number(r.id)}:${Number(s.id)}` }, "Remove stop", "haulingDeleteStop", false, "burrow-tool danger")}</div>` +
      (open ? haulingStopDetailMarkup(r, s, st) : "");
  }

  // The assigned carts, plus a PICKER over the free ones. Before B231 this was a bare
  // A numeric field once asked the player to type a minecart's raw item id -- an id the client
  // gave them no way to discover, for a write that was broken anyway (it stored the item id in a
  // vector of df::vehicle ids). /hauling-vehicles now serves the free-cart pool by name.
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
      ${root.DWFUI.scrollHtml({ cls: "hauling-vehicle-list", preserveKey: `haul-veh-${id}`, ariaLabel: "Free minecarts" }, pickable)}
    </div>`;
  }

  function haulingRouteRowMarkup(route, state) {
    const r = route || {}, s = state || {}, id = Number(r.id);
    const armed = id === Number(s.armedRouteId), selected = id === Number(s.selectedRouteId);
    const stops = Array.isArray(r.stops) ? r.stops : [], vehicles = Array.isArray(r.vehicleIds) ? r.vehicleIds : [];
    const detail = selected ? `<div class="burrow-cit-row" style="display:block">${stops.length ? stops.map(stop => haulingStopRowMarkup(r, stop, s)).join("") : '<div class="hauling-stop-row">No stops yet.</div>'}${haulingVehiclesMarkup(r, s)}</div>` : "";
    return `<div class="burrow-row${armed ? " armed" : ""}" data-hauling-route-row="${id}"><div class="burrow-row-main">${plaque("burrow-name", { haulingSelect:id }, r.name || `Route ${id}`, "Show this route's stops")}<span class="burrow-members">${stops.length} stop${stops.length === 1 ? "" : "s"} &middot; ${vehicles.length} cart${vehicles.length === 1 ? "" : "s"}</span></div><div class="burrow-row-tools">${plaque(`burrow-tool hauling-stop-arm${armed ? " on" : ""}`, { haulingStopArm:id }, armed ? "Placing..." : "Add stop", armed ? "Stop placing stops" : "Add stop (click the map)")}${tile({ haulingRouteRemove:id }, "Remove route", "haulingDeleteRoute", false, "burrow-tool danger")}</div>${detail}</div>`;
  }

  function haulingPanelMarkup(state) {
    const s = state || {}, routes = Array.isArray(s.routes) ? s.routes : [];
    const armed = routes.find(route => Number(route.id) === Number(s.armedRouteId));
    const paintBar = Number(s.armedRouteId) >= 0 ? `<div class="burrow-paint-bar"><div class="burrow-paint-label">Placing stops: ${root.DWFUI.esc(armed?.name || `Route ${s.armedRouteId}`)}</div><div class="burrow-paint-tools">${plaque("burrow-done", { haulingStopDone:"" }, "Done placing stops", "Stop placing stops on this route", "red")}</div></div>` : "";
    return `<div class="burrow-head">${plaque("burrow-add", { haulingAdd:"" }, "Add new route", "Create a new hauling route", "green")}</div>${paintBar}<div class="burrow-list">${routes.length ? routes.map(route => haulingRouteRowMarkup(route, s)).join("") : '<div class="burrow-empty"></div>'}</div><div class="stock-palette-status${s.statusError ? " err" : ""}" data-hauling-status>${root.DWFUI.esc(s.status || "")}</div>`;
  }

  const api = { SPRITE_TOKENS, paintSprite, paintControlIcons, alignControlSubmenus, priorityMarkup, digSubmenuMarkup,
    plantSubmenuMarkup, smoothSubmenuMarkup, itemSubmenuMarkup, stockSubmenuMarkup, zoneSubmenuMarkup, trafficSubmenuMarkup,
    bottomToolbarMarkup, submenuFrame, previewMarkup, hydrate, ZONE_TYPES, zonePaletteMarkup,
    burrowRowMarkup, burrowPanelMarkup, burrowSymbolMarkup, haulingStopRowMarkup, haulingRouteRowMarkup,
    haulingPanelMarkup, haulingStopDetailMarkup, haulingVehiclesMarkup, haulingConditionText,
    haulingDesiredSummary, HAUL_GROUPS, HAUL_MODES, HAUL_DIRS,
    BURROW_COLOR_NAMES, TRAFFIC_LEVELS };
  root.DwfControlShell = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root.__DWF_STORY_MODE) hydrate();
})(typeof window !== "undefined" ? window : globalThis);
