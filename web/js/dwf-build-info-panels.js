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

  // ---- Interactive Build menu, backed by /build-catalog and /build-place ----
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function") DWFUI.require("build-info-panels", [
    "actionButtonsHtml", "artBtnHtml", "bitmapTextHtml", "checkHtml", "headerHtml", "iconHtml", "latchHtml", "nonNativeTabsHtml",
    "plaqueBtnHtml", "rowGroupHtml", "rowHtml", "scrollHtml", "searchHtml", "sortHeaderHtml",
    "tabsHtml", "windowHtml", "TOKENS",
  ]);
  // The ONE handle on the component layer. In the browser DWFUI is a global (index.html loads
  // dwf-ui-components.js first). Under Node -- the offline fixtures in tools/harness require()
  // this module directly -- there is no such global, so resolve the sibling module instead. Without
  // this, every exported pure helper that now calls a builder (infoRowActions, taskRowsHtml,
  // creatureRowsMarkup, stocksPanelMarkup...) would ReferenceError inside the fixtures.
  const D = () => {
    if (typeof DWFUI !== "undefined" && DWFUI) return DWFUI;
    if (typeof window !== "undefined" && window && window.DWFUI) return window.DWFUI;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try { return require("./dwf-ui-components.js"); } catch (_) { return null; }
    }
    return null;
  };
  let buildCatalog = null;
  let activeBuildCategory = "";
  let buildSearch = "";
  let selectedBuild = null;
  let buildDirection = 0;
  let buildOptions = null;
  let buildStatus = "";
  let buildStatusError = false;
  // Set only after a tile click for buildings whose native flow picks a finished stock item.
  let pendingBuildPlacement = null;
  // DF-style material selection: available materials per requirement for the selected building,
  // and the player's per-requirement pick ("" = let DF choose any).
  //
  // B244: a pick is "itemType:matType:matIndex" -- the item CLASS is part of it, because "granite"
  // (a boulder) and "granite blocks" are different builds in DF and the player must be able to
  // choose between rock / blocks / wood / bars. The legacy 2-part "matType:matIndex" form is still
  // accepted end-to-end (server apply_chosen_materials parses both) so saved picks from before
  // this change keep working; it just means "that material, any class".
  const MAT_PICK_RE = /^-?\d+:-?\d+(:-?\d+)?$/;
  const matPickValue = m => (m && m.itemType !== undefined && m.itemType !== null)
    ? `${Number(m.itemType)}:${Number(m.matType)}:${Number(m.matIndex)}`
    : `${Number(m.matType)}:${Number(m.matIndex)}`;
  // "granite Rock" / "oak Wood" / "steel Bars" -- the class is what B244 asked to be selectable.
  const matPickLabel = m => (m && m.className)
    ? `${m.name || ""} ${m.className}`.trim()
    : String((m && m.name) || "");
  let buildMaterials = null;       // { requirements: [{index,label,quantity,pinned,materials:[...]}] }
  let buildMatPicks = {};          // reqIndex -> "itemType:matType:matIndex" | "closest"
  let buildMaterialsToken = "";    // token buildMaterials was loaded for (guards stale responses)
  let lastBuildPicksByToken = {};  // token -> last per-requirement picks (DF-style "use last material")
  // WD-15 / B79: some categories are flyouts with nested subgroup folders -- Workshops
  // (Clothing and leather / Farming / Furnaces, 06b-build-workshops.png) and, since B79,
  // Constructions (Stairs / Track). "" means the top-level view (direct entries + subgroup
  // folders); otherwise a subgroup id the user has drilled into. Reset to "" whenever the build
  // menu (re)opens or the active top category changes.
  let activeBuildGroup = "";
  // WD-15 placement panel (27-build-placement.png): "Select material after placement" (the
  // client's existing per-requirement picker, default) vs "Use closest material" (bulk-applies
  // closest-to-placement for every non-pinned requirement, see appendBuildOptions) -- and
  // "Keep building after placement" (re-arm the same tool after a successful build, DF's
  // default; unchecked = exit placement mode after one placement). Both are sticky session
  // preferences (not reset per building selection), matching DF's own checkbox behavior.
  let buildMaterialMode = "select"; // "select" | "closest"
  let keepBuildingAfterPlacement = true;

  function defaultBuildOptions() {
    return {
      hollow: 0,
      weapon_count: 1,
      plate_units: 1,
      plate_water: 0,
      plate_magma: 0,
      plate_track: 0,
      plate_citizens: 0,
      plate_resets: 1,
      unit_min: 1,
      unit_max: 1000000,
      water_min: 1,
      water_max: 7,
      magma_min: 1,
      magma_max: 7,
      track_min: 1,
      track_max: 1000000,
      track_dump: 0,
      dump_x: 0,
      dump_y: 0,
      friction: 50000,
      speed: 50000
    };
  }

  function allBuildItems() {
    return Array.isArray(buildCatalog?.items) ? buildCatalog.items : [];
  }

  function allBuildCategories() {
    return Array.isArray(buildCatalog?.categories) ? buildCatalog.categories : [];
  }

  // B79: match the browser Build menu's "Constructions" category to DF v50's NATIVE menu
  // (oracle: friend screenshot B79-1). Two defects were reported: (a) MISSING types -- grates,
  // bars, windows, Support, Bridge and Track stop live under Constructions in native DF, but the
  // server catalog (dfcapture.lua) filed them under Doors/Furniture/Machines/Traps; (b) EXTRA
  // clutter -- native shows a single "Track" and a single "Stairs" row that open a submenu, but
  // the catalog listed all 28 individual track pieces and 3 stair variants as separate top-level
  // Constructions rows. Both are fixed CLIENT-SIDE: the server already sends every item with the
  // correct token + placement metadata, so we only re-bucket for DISPLAY (placement is untouched)
  // and collapse the track/stair variants behind drill-down folders (the same flyout mechanism
  // Workshops already uses). No server/DLL change is required.
  const B79_CONSTRUCTION_REHOME = {
    "wall grate": true, "floor grate": true, "vertical bars": true, "floor bars": true, // Doors -> Constructions
    "glass window": true, "gem window": true,                                            // Furniture -> Constructions
    "support": true, "bridge": true,                                                     // Machines -> Constructions
    "track stop": true,                                                                  // Traps -> Constructions
  };
  // Collapsible subgroups inside Constructions (native shows one row that opens a submenu).
  const B79_CONSTRUCTION_GROUPS = [
    { id: "stairs", label: "Stairs" },
    { id: "track",  label: "Track" },
  ];
  function b79ConstructionGroupFor(label) {
    const s = String(label == null ? "" : label).toLowerCase();
    if (s === "up stair" || s === "down stair" || s === "up/down stair") return "stairs";
    if (s.startsWith("track ") && s !== "track stop") return "track"; // Track N / Track ramp N-S / ...
    return ""; // direct top-level Constructions entry
  }

  // Pure, DOM-free: re-bucket + regroup a /build-catalog payload in place (see B79 note above).
  // Node-exported for the offline fixture test (tools/harness/b79_construction_menu_test.mjs).
  function normalizeBuildCatalog(catalog) {
    if (!catalog || typeof catalog !== "object") return catalog;
    const items = Array.isArray(catalog.items) ? catalog.items : [];
    const cats = Array.isArray(catalog.categories) ? catalog.categories : [];
    // 1) Re-home the mis-filed items into Constructions, then tag every Construction item with
    //    its drill-down subgroup ("" = shown directly; "stairs"/"track" = collapsed behind a folder).
    for (const item of items) {
      if (!item) continue;
      const label = String(item.label == null ? "" : item.label).toLowerCase();
      if (B79_CONSTRUCTION_REHOME[label]) item.category = "constructions";
      if (item.category === "constructions") item.group = b79ConstructionGroupFor(item.label);
    }
    // 2) Recompute category totals (badge = total buildables, matching Workshops' existing badge)
    //    and Construction subgroup counts.
    const catCount = {};
    const consGroupCount = {};
    for (const item of items) {
      if (!item || !item.category) continue;
      catCount[item.category] = (catCount[item.category] || 0) + 1;
      if (item.category === "constructions" && item.group)
        consGroupCount[item.group] = (consGroupCount[item.group] || 0) + 1;
    }
    for (const cat of cats) {
      if (!cat) continue;
      cat.count = catCount[cat.id] || 0;
      if (cat.id === "constructions") {
        cat.groups = B79_CONSTRUCTION_GROUPS
          .filter(g => (consGroupCount[g.id] || 0) > 0)
          .map(g => ({ id: g.id, label: g.label, count: consGroupCount[g.id] }));
      }
    }
    return catalog;
  }

  function itemRequirements(item) {
    return Array.isArray(item?.requirements) ? item.requirements : [];
  }

  function buildItemMeta(item) {
    const size = item.area
      ? `${Number(item.limit?.w) || 31}x${Number(item.limit?.h) || 31}`
      : `${Number(item.size?.w) || 1}x${Number(item.size?.h) || 1}`;
    const reqs = itemRequirements(item);
    const req = reqs.length
      ? reqs.slice(0, 2).map(r => `${Number(r.quantity) < 0 ? "area" : Number(r.quantity) || 1} ${r.label || "material"}`).join(", ")
      : "no materials";
    return `${size} - ${req}`;
  }

  async function loadBuildMaterials(item) {
    const token = item && item.token;
    if (!token) { buildMaterials = null; buildMaterialsToken = ""; return; }
    try {
      const r = await fetch(`/build-materials?token=${encodeURIComponent(token)}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      // Ignore a stale response if the player has since picked a different building.
      if (selectedBuild && selectedBuild.token === token) {
        buildMaterials = data && data.ok ? data : null;
        buildMaterialsToken = token;
        // "Use last material": default each requirement to the player's previous pick for this
        // building, but only if that material is still on hand. B148: a saved per-requirement
        // "closest" is no longer restored -- that affordance now lives solely in the placement
        // panel's "Use closest material" toggle.
        const last = lastBuildPicksByToken[token];
        if (last && buildMaterials && Array.isArray(buildMaterials.requirements)) {
          buildMatPicks = {};
          for (const req of buildMaterials.requirements) {
            const v = last[req.index];
            if (!v || req.pinned) continue;
            const avail = Array.isArray(req.materials) &&
              req.materials.some(m => matPickValue(m) === v);
            if (avail) buildMatPicks[req.index] = v;
          }
        }
        if (clientPanel.classList.contains("build-panel")) renderBuildPanel();
      }
    } catch (_) {
      if (selectedBuild && selectedBuild.token === token) { buildMaterials = null; buildMaterialsToken = token; }
    }
  }

  function selectBuildItem(item, preserveOptions = false) {
    if (typeof window !== "undefined" && typeof window.DFCancelBuildCornerAnchor === "function")
      window.DFCancelBuildCornerAnchor();
    selectedBuild = item || null;
    buildOptions = preserveOptions && buildOptions ? buildOptions : defaultBuildOptions();
    buildMatPicks = {};
    buildMaterials = null;
    buildMaterialsToken = "";
    pendingBuildPlacement = null;
    if (item) loadBuildMaterials(item);
    const dirs = Array.isArray(item?.directions) ? item.directions : [];
    buildDirection = dirs.length ? Number(dirs[0].value) : 0;
    buildStatus = item ? item.label : "";
    buildStatusError = false;
    currentTool = null;
    selectedDesignation = null;
    digMenuOpen = false;
    plantMenuOpen = false;
    smoothMenuOpen = false;
    itemDesigMenuOpen = false; // WD-10: close the item/building-designations submenu too
    stockPreset = null;
    stockRepaintId = null;
    if (typeof stockPalette !== "undefined") stockPalette.style.display = "none";
    zonePreset = null;
    if (typeof zonePalette !== "undefined") zonePalette.style.display = "none";
    zoneOverlayEnabled = false;
    currentZones = [];
    renderZoneOverlay();
    updateDesignationButtons();
    updateToolCursor();
  }

  // WD-15 / B79: items "in view" for the current category/subgroup -- a flyout category's
  // top-level view shows direct entries only (group===""), a drilled-in subgroup shows just its
  // members, and a flat category (no subgroups) shows everything in it.
  function buildItemsInView() {
    return allBuildItems().filter(item =>
      item.category === activeBuildCategory && (item.group || "") === (activeBuildGroup || ""));
  }

  function chooseFirstBuildInCategory() {
    const items = buildItemsInView();
    if (!items.length) {
      selectedBuild = null;
      return;
    }
    const stillInView = selectedBuild && selectedBuild.category === activeBuildCategory &&
      (selectedBuild.group || "") === (activeBuildGroup || "");
    if (!stillInView) selectBuildItem(items[0]);
  }

  async function openBuildPanel() {
    setActiveToolbar("build");
    activeBuildGroup = "";
    clientPanel.className = "visible build-panel";
    panelContent(clientPanel).innerHTML = `<div class="build-window"><div class="build-head"><div class="build-title">Buildings</div>${buildCloseHtml()}</div></div>`;
    try {
      const r = await fetch(`/build-catalog?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      buildCatalog = normalizeBuildCatalog(await r.json()); // B79: DF-native Constructions bucketing
      const cats = allBuildCategories();
      if (!activeBuildCategory || !cats.some(c => c.id === activeBuildCategory))
        activeBuildCategory = cats[0]?.id || "";
      chooseFirstBuildInCategory();
      renderBuildPanel();
    } catch (err) {
      buildStatus = "Building catalog unavailable";
      buildStatusError = true;
      renderBuildPanel();
    }
  }

  // DF's real building-menu icons: building_icons.png (256x512 = 8 cols x 16 rows of 32px tiles),
  // served at /asset. Cell coords come straight from DF's graphics_building_icons.txt.
  const BLD_ICON_CELL = {
    workshops:[0,0], furniture:[1,0], doors_hatches:[2,0], walls_floors:[3,0], machines_fluids:[4,0],
    cages_restraint:[5,0], traps:[6,0], military:[7,0], trade_depot:[0,1], workshop_carpenter:[1,1],
    workshop_mason:[2,1], workshop_metalsmith:[3,1], workshops_furnaces:[4,1], workshop_crafts:[5,1],
    workshop_jeweler:[6,1], workshops_clothing:[7,1], workshops_farming:[0,2], workshop_bowyer:[1,2],
    workshop_mechanic:[2,2], workshop_siege:[3,2], workshop_ashery:[4,2], furnace_wood:[5,2],
    furnace_smelter:[6,2], furnace_glass:[7,2], furnace_kiln:[0,3], workshop_leather:[1,3],
    workshop_loom:[2,3], workshop_clothes:[3,3], workshop_dyer:[4,3], farm_plot:[5,3], workshop_still:[6,3],
    workshop_butcher:[7,3], workshop_tanner:[0,4], workshop_fishery:[1,4], workshop_kitchen:[2,4],
    workshop_farmer:[3,4], workshop_quern:[4,4], workshop_kennel:[5,4], nest_box:[6,4], hive:[7,4],
    bed:[0,5], chair:[1,5], table:[2,5], box:[3,5], cabinet:[4,5], coffin:[5,5], slab:[6,5], statue:[7,5],
    traction_bench:[0,6], bookcase:[1,6], display_furniture:[2,6], offering_place:[3,6], instrument:[4,6],
    door:[5,6], hatch:[6,6], wall:[7,6], floor:[0,7], ramp:[1,7], stairs:[2,7], bridge:[3,7],
    road_paved:[4,7], road_dirt:[5,7], fortification:[6,7], grate_wall:[7,7], grate_floor:[0,8],
    bars_vertical:[1,8], bars_floors:[2,8], window_glass:[3,8], window_gem:[4,8], support:[5,8],
    track:[6,8], track_stop:[7,8], lever:[0,9], well:[1,9], floodgate:[2,9], screw_pump:[3,9],
    water_wheel:[4,9], windmill:[5,9], gear_assembly:[6,9], axle_horizontal:[7,9], axle_vertical:[0,10],
    workshop_millstone:[1,10], rollers:[2,10], restraint:[3,10], cage:[4,10], animal_trap:[5,10],
    pressure_plate:[6,10], trap_stone:[7,10], trap_weapon:[0,11], trap_cage:[1,11], weapon:[2,11],
    archery_target:[3,11], weapon_rack:[4,11], armor_stand:[5,11], ballista:[6,11], catapult:[7,11],
    wagon:[0,12]
  };
  // WD-15: the 9 live DF top categories (06-build.png) -- furnaces/farming/clothing/siege/track
  // are no longer separate top-level ids (folded into Workshops' nested flyout / Constructions /
  // Military, see dfcapture.lua BUILD_CATEGORIES).
  const CAT_ICON = { workshops:"workshops", furniture:"furniture", doors:"doors_hatches",
    constructions:"walls_floors", machines:"machines_fluids", cages:"cages_restraint",
    traps:"traps", military:"military", trade:"trade_depot" };
  // WD-15 / B79: icons for the subgroup "folder" rows -- the 3 Workshops flyout folders plus the
  // 2 Constructions folders (Stairs / Track).
  const GROUP_ICON = { clothing:"workshops_clothing", farming:"workshops_farming", furnaces:"workshops_furnaces",
    stairs:"stairs", track:"track" };
  // Ordered keyword -> icon name; first substring match on the item label wins. Falls back to the
  // category icon, so every item still gets a sensible DF sprite.
  const ITEM_ICON_KW = [
    ["throne","chair"],["chair","chair"],["bed","bed"],["table","table"],["chest","box"],["coffer","box"],
    ["box","box"],["cabinet","cabinet"],["coffin","coffin"],["casket","coffin"],["slab","slab"],
    ["statue","statue"],["armor stand","armor_stand"],["weapon rack","weapon_rack"],["traction","traction_bench"],
    ["bookcase","bookcase"],["display","display_furniture"],["offering","offering_place"],["instrument","instrument"],
    ["hatch","hatch"],["door","door"],["floodgate","floodgate"],["floor grate","grate_floor"],["wall grate","grate_wall"],
    ["grate","grate_floor"],["vertical bars","bars_vertical"],["floor bars","bars_floors"],["bars","bars_vertical"],
    ["gem window","window_gem"],["glass window","window_glass"],["window","window_glass"],["nest","nest_box"],["hive","hive"],
    ["fortification","fortification"],["paved road","road_paved"],["dirt road","road_dirt"],["road","road_paved"],
    ["bridge","bridge"],["wall","wall"],["floor","floor"],["ramp","ramp"],["stair","stairs"],["support","support"],
    ["track stop","track_stop"],["rollers","rollers"],["track","track"],["lever","lever"],["pressure plate","pressure_plate"],
    ["well","well"],["screw pump","screw_pump"],["water wheel","water_wheel"],["windmill","windmill"],
    ["gear","gear_assembly"],["horizontal axle","axle_horizontal"],["vertical axle","axle_vertical"],["axle","axle_horizontal"],
    ["millstone","workshop_millstone"],["quern","workshop_quern"],
    ["cage trap","trap_cage"],["weapon trap","trap_weapon"],["stone-fall","trap_stone"],["stone fall","trap_stone"],
    ["animal trap","animal_trap"],["cage","cage"],["chain","restraint"],["rope","restraint"],["restraint","restraint"],
    ["archery","archery_target"],["weapon rack","weapon_rack"],["ballista","ballista"],["catapult","catapult"],
    ["carpenter","workshop_carpenter"],["mason","workshop_mason"],["metalsmith","workshop_metalsmith"],
    ["craftsdwarf","workshop_crafts"],["craft","workshop_crafts"],["jeweler","workshop_jeweler"],
    ["clothier","workshop_clothes"],["loom","workshop_loom"],["dyer","workshop_dyer"],["leather","workshop_leather"],
    ["tanner","workshop_tanner"],["still","workshop_still"],["kitchen","workshop_kitchen"],["butcher","workshop_butcher"],
    ["fishery","workshop_fishery"],["farmer","workshop_farmer"],["kennel","workshop_kennel"],["ashery","workshop_ashery"],
    ["bowyer","workshop_bowyer"],["mechanic","workshop_mechanic"],["siege","workshop_siege"],
    ["smelter","furnace_smelter"],["glass furnace","furnace_glass"],["kiln","furnace_kiln"],["wood furnace","furnace_wood"],
    ["farm plot","farm_plot"],["depot","trade_depot"]
  ];
  function bldIconStyle(name, px) {
    const c = BLD_ICON_CELL[name];
    if (!c) return "";
    return `background-image:url(/asset/building_icons.png);background-size:${8*px}px ${16*px}px;` +
           `background-position:-${c[0]*px}px -${c[1]*px}px;image-rendering:auto`;
  }
  function catIconName(cat) { return CAT_ICON[String((cat && cat.id) || "").toLowerCase()] || null; }
  function itemIconName(item) {
    const s = String((item && item.label) || "").toLowerCase();
    for (const [kw, name] of ITEM_ICON_KW) if (s.includes(kw)) return name;
    const c = (item && item.category) ? CAT_ICON[String(item.category).toLowerCase()] : null;
    return c || null;
  }
  function catGlyph(cat) {
    const s = String((cat && (cat.label || cat.id)) || "?").trim();
    return s ? s.charAt(0).toUpperCase() : "?";
  }
  // WD-15 / B79: the active category's "groups" metadata (label/count per subgroup). Workshops'
  // groups come from the server (dfcapture.lua WORKSHOP_GROUPS); Constructions' groups are added
  // client-side by normalizeBuildCatalog (B79). A flat category returns [].
  function currentCategoryGroups() {
    const cats = allBuildCategories();
    const cat = cats.find(c => c.id === activeBuildCategory);
    return Array.isArray(cat && cat.groups) ? cat.groups : [];
  }
  function activeCategoryLabel() {
    const cat = allBuildCategories().find(c => c.id === activeBuildCategory);
    return (cat && cat.label) || "Buildings";
  }

  // ---- WAVE-5 GATE C: the build menu is STRUCTURE-migrated, and ONLY structure. -----------------
  // Its single reference capture, tools/orchestrator/attachments/B79-1.png, is declared
  // `provenance: "unknown"` in tools/ui-lab/reference-provenance.json -- so it is NOT an oracle and
  // NO native layout is invented here. Every hand-built control below now comes from a DWFUI builder
  // and keeps its pinned classname through the builder's `cls`/`inputCls`/`copyCls` hook (the
  // sanctioned strangler seam, arch-spec 5.1/7.4). Not one CSS rule is touched this wave; not one
  // data-* hook, id or route changes.
  //
  // ART: building_icons.png is an ad-hoc background-position sheet (art channel 3), not an
  // interface_map token, so DWFUI cannot resolve it and the icon tiles stay raw spans passed through
  // rowHtml's `icon:` slot. That is a REPORTED art gap, not a silent one -- see the closeout.
  function buildCatRowHtml(cat, activeCategory) {
    const ic = catIconName(cat), st = ic ? bldIconStyle(ic, 26) : "";
    return DWFUI.rowHtml({
      tag: "button", cls: `build-cat${cat.id === activeCategory ? " active" : ""}`,
      dataset: { buildCat: cat.id },
      icon: `<span class="build-cat-ico"${st ? ` style="${st}"` : ""}>${st ? "" : escapeHtml(catGlyph(cat))}</span>`,
      copyCls: "build-cat-label", label: cat.label || cat.id,
      trailing: `<span class="build-count">${Number(cat.count) || 0}</span>`,
    });
  }

  function buildItemRowHtml(item, selectedToken) {
    const ic = itemIconName(item), st = ic ? bldIconStyle(ic, 30) : "";
    return DWFUI.rowHtml({
      tag: "button", cls: `build-item${item.token === selectedToken ? " active" : ""}`,
      dataset: { buildToken: item.token }, title: item.label || "",
      icon: `<span class="build-item-ico"${st ? ` style="${st}"` : ""}></span>`,
      copyCls: "build-item-text", labelCls: "build-item-name", label: item.label || "Building",
      sub: { text: buildItemMeta(item), cls: "build-item-meta" },
    });
  }

  // The build head's search field and close tile. `magnifier: false` on purpose: the build menu has
  // no usable oracle, and native's magnifier is only attested on the six search surfaces that carry
  // one -- turning it on here would INVENT a control.
  function buildSearchHtml(value) {
    return DWFUI.searchHtml({
      cls: "build-search-row", inputCls: "build-search", type: "search", dataAttr: "build-search",
      value: value || "", placeholder: "Search...", ariaLabel: "Search buildings",
    });
  }
  function buildCloseHtml() {
    // The literal `✕` / TOKENS.glyphs.close text glyph is retired: BUILDING_JOBS_REMOVE is DF's own
    // red close tile and it is already in TOKENS.sprites (verified in web/interface_map.json).
    return DWFUI.artBtnHtml({
      sprite: DWFUI.TOKENS.sprites.close, cls: "build-close",
      dataset: { buildClose: "" }, title: "Close", ariaLabel: "Close",
    });
  }
  function buildClearHtml() {
    return DWFUI.plaqueBtnHtml({ label: "Cancel", cls: "build-clear", dataset: { buildClear: "" } });
  }

  function buildPanelMarkup(view) {
    const v = view || {};
    const cats = Array.isArray(v.categories) ? v.categories : [];
    const items = Array.isArray(v.items) ? v.items : [];
    return `<div class="build-window"><div class="build-head"><div class="build-title">Build</div>` +
      `${buildSearchHtml(v.search)}${buildCloseHtml()}</div><div class="build-body"><div class="build-cats">` +
      `${cats.map(cat => buildCatRowHtml(cat, v.activeCategory)).join("")}</div>` +
      `<div class="build-items">${v.groupBackHtml || ""}${v.groupFoldersHtml || ""}` +
      `${items.map(item => buildItemRowHtml(item, v.selectedToken)).join("")}</div>` +
      `<div class="build-detail">${v.detailHtml || ""}</div></div><div class="build-footer"><div class="build-status${v.statusError ? " error" : ""}">${escapeHtml(v.status || "")}</div>${buildClearHtml()}</div></div>`;
  }

  function renderBuildPanel() {
    const cats = allBuildCategories();
    const items = allBuildItems();
    if (!activeBuildCategory && cats.length)
      activeBuildCategory = cats[0].id;
    const needle = buildSearch.trim();
    // B21: DF-style token search. When searching, span the WHOLE active category (all subgroups),
    // so a grouped item (e.g. a "Track N-S" piece, a Furnace) is findable by name from the top
    // level; otherwise honour the current subgroup drill-down.
    const searchPool = needle
      ? allBuildItems().filter(item => item.category === activeBuildCategory)
      : buildItemsInView();
    const shownItems = searchPool.filter(item => dfTokenMatch(item.label, needle));
    if (selectedBuild && !items.some(item => item.token === selectedBuild.token))
      selectedBuild = null;

    // WD-15 / B79: flyout chrome -- a category with subgroups shows its nested "folders" ahead of
    // its direct entries at the top level (no search in progress); drilling into one shows a
    // "back to <Category>" row instead. Folders aren't real catalog items, so they're rendered
    // separately from shownItems. Works for Workshops (Clothing/Farming/Furnaces) and, since B79,
    // Constructions (Stairs/Track).
    const groups = currentCategoryGroups();
    const showGroupFolders = groups.length > 0 && !activeBuildGroup && !needle;
    const showGroupBack = groups.length > 0 && !!activeBuildGroup;
    const groupNoun = activeBuildCategory === "workshops" ? "workshops" : "options";
    // The hand-typed leftwards-arrow entity retires: BUTTON_CLOSE_LEFT is DF's own gold left arrow.
    const groupBackHtml = showGroupBack ? DWFUI.rowHtml({
      tag: "button", cls: "build-item build-group-back", dataset: { buildGroup: "" },
      title: `Back to ${activeCategoryLabel()}`,
      icon: DWFUI.iconHtml({ sprite: DWFUI.TOKENS.sprites.back,
        cls: "build-item-ico build-group-back-ico", alt: "Back" }),
      copyCls: "build-item-text", labelCls: "build-item-name", label: activeCategoryLabel(),
      sub: { text: "Back", cls: "build-item-meta" },
    }) : "";
    const groupFoldersHtml = showGroupFolders ? groups.map(group => {
      const ic = GROUP_ICON[group.id], st = ic ? bldIconStyle(ic, 30) : "";
      return DWFUI.rowHtml({
        tag: "button", cls: "build-item build-group", dataset: { buildGroup: group.id },
        title: group.label || group.id,
        icon: `<span class="build-item-ico"${st ? ` style="${st}"` : ""}></span>`,
        copyCls: "build-item-text", labelCls: "build-item-name", label: group.label || group.id,
        sub: { text: `${Number(group.count) || 0} ${groupNoun}`, cls: "build-item-meta" },
      });
    }).join("") : "";

    const selectedToken = selectedBuild?.token || "";
    const detail = selectedBuild ? renderBuildDetail(selectedBuild) : "";
    clientPanel.className = "visible build-panel";
    // ONE write, from the ONE shared builder that Parity Studio also renders. (The duplicate inline
    // template that used to sit here -- written, then immediately overwritten by this same call --
    // was dead markup and a second, drifting copy of every control. It is gone.)
    panelContent(clientPanel).innerHTML = buildPanelMarkup({
      categories: cats, items: shownItems, activeCategory: activeBuildCategory, search: buildSearch,
      selectedToken, groupBackHtml, groupFoldersHtml, detailHtml: detail,
      status: buildStatus, statusError: buildStatusError,
    });
    clientPanel.querySelector("[data-build-close]").addEventListener("click", event => {
      event.stopPropagation();
      clearBuildPlacement(false);
      closeClientPanel();
      setActiveToolbar(null);
      focusPage();
    });
    clientPanel.querySelector("[data-build-clear]").addEventListener("click", event => {
      event.stopPropagation();
      clearBuildPlacement(true);
      focusPage();
    });
    clientPanel.querySelector("[data-build-search]").addEventListener("input", event => {
      const pos = event.currentTarget.selectionStart || 0;
      buildSearch = event.currentTarget.value || "";
      renderBuildPanel();
      const next = clientPanel.querySelector("[data-build-search]");
      if (next) {
        next.focus();
        try { next.setSelectionRange(pos, pos); } catch (_) {}
      }
    });
    clientPanel.querySelectorAll("[data-build-cat]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      activeBuildCategory = button.dataset.buildCat || activeBuildCategory;
      activeBuildGroup = ""; // WD-15/B79: switching top category always returns to its top-level view
      selectedBuild = null;
      chooseFirstBuildInCategory();
      renderBuildPanel();
      focusPage();
    }));
    // WD-15/B79: flyout navigation -- click a subgroup folder to drill in, or the "back" row
    // (empty data-build-group) to return to the top-level direct-entries view.
    clientPanel.querySelectorAll("[data-build-group]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      activeBuildGroup = button.dataset.buildGroup || "";
      selectedBuild = null;
      chooseFirstBuildInCategory();
      renderBuildPanel();
      focusPage();
    }));
    // WD-15 placement panel: material-mode toggle ("Select material after placement" / "Use
    // closest material") and the "Keep building after placement" checkbox (27-build-placement.png).
    clientPanel.querySelectorAll("[data-build-matmode]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      buildMaterialMode = button.dataset.buildMatmode === "closest" ? "closest" : "select";
      renderBuildPanel();
      focusPage();
    }));
    // WAVE-5: the raw DOM checkbox input is now DWFUI.checkHtml -- the 2-state native tile
    // (SQUADS_SELECTED / SQUADS_NOT_SELECTED), which renders a REAL TILE when unchecked too. It is a
    // a button carrying aria-pressed, so the `change` listener becomes a `click`; the flag it flips
    // (keepBuildingAfterPlacement) and the data-build-keep hook are unchanged.
    const keepBuildingCheckbox = clientPanel.querySelector("[data-build-keep]");
    if (keepBuildingCheckbox) keepBuildingCheckbox.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      keepBuildingAfterPlacement = !keepBuildingAfterPlacement;
      renderBuildPanel();
      focusPage();
    });
    clientPanel.querySelectorAll("[data-build-token]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const item = items.find(i => i.token === button.dataset.buildToken);
      selectBuildItem(item);
      renderBuildPanel();
      focusPage();
    }));
    clientPanel.querySelectorAll("[data-build-mat]").forEach(sel => sel.addEventListener("change", event => {
      const idx = Number(sel.dataset.buildMat);
      const v = sel.value || "";
      if (v) buildMatPicks[idx] = v; else delete buildMatPicks[idx];
      focusPage();
    }));
    clientPanel.querySelectorAll("[data-place-candidate]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      const pending = pendingBuildPlacement;
      const itemId = Number(button.dataset.placeCandidate);
      if (pending && Number.isInteger(itemId) && itemId >= 0) {
        submitBuildPlacement(pending.item, pending.params, itemId);
      }
    }));
    const fallbackPlacement = clientPanel.querySelector("[data-place-fallback]");
    if (fallbackPlacement) fallbackPlacement.addEventListener("click", event => {
      event.preventDefault();
      const pending = pendingBuildPlacement;
      if (pending) submitBuildPlacement(pending.item, pending.params);
    });
    const cancelPlacement = clientPanel.querySelector("[data-place-cancel]");
    if (cancelPlacement) cancelPlacement.addEventListener("click", event => {
      event.preventDefault();
      pendingBuildPlacement = null;
      renderBuildPanel();
    });
    clientPanel.querySelectorAll("[data-build-dir]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      buildDirection = Number(button.dataset.buildDir);
      renderBuildPanel();
      focusPage();
    }));
    clientPanel.querySelectorAll("[data-build-toggle]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const key = button.dataset.buildToggle;
      buildOptions[key] = Number(button.dataset.value || 0);
      renderBuildPanel();
      focusPage();
    }));
    clientPanel.querySelectorAll("[data-build-dump]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      buildOptions.dump_x = Number(button.dataset.dumpX || 0);
      buildOptions.dump_y = Number(button.dataset.dumpY || 0);
      renderBuildPanel();
      focusPage();
    }));
    clientPanel.querySelectorAll("[data-build-num]").forEach(input => {
      input.addEventListener("change", event => {
        const key = input.dataset.buildNum;
        const min = Number(input.min || 0);
        const max = Number(input.max || 1000000);
        const val = Math.max(min, Math.min(max, Math.floor(Number(input.value || 0))));
        buildOptions[key] = val;
        input.value = String(val);
      });
    });
  }

  function pendingPlaceCandidateHtml(item, pendingOverride) {
    const pending = pendingOverride === undefined ? pendingBuildPlacement : pendingOverride;
    if (!pending || pending.item !== item) return "";
    const candidates = Array.isArray(pending.candidates) ? pending.candidates : [];
    const list = candidates.length
      ? candidates.map(candidate => DWFUI.plaqueBtnHtml({
          cls: "build-toggle", dataset: { placeCandidate: Number(candidate.id) },
          label: `${candidate.material || "Unknown material"} (quality ${Number(candidate.quality) || 0}, #${Number(candidate.id)})`,
        })).join("")
      : `<div class="build-req-row"><span>No free ${escapeHtml(item.label || "building")} items are currently available.</span></div>`;
    return `
      <div class="build-placement">
        <div class="build-placement-msg">Choose the ${escapeHtml(item.label || "item")} to place.</div>
        <div class="build-toggle-row">${list}</div>
        <div class="build-toggle-row">
          ${DWFUI.plaqueBtnHtml({ cls: "build-toggle", dataset: { placeFallback: "" }, label: "Place with generic material filters" })}
          ${DWFUI.plaqueBtnHtml({ cls: "build-toggle", dataset: { placeCancel: "" }, label: "Cancel placement" })}
        </div>
      </div>`;
  }

  function renderBuildDetail(item, state) {
    const s = state || {};
    const materials = Object.prototype.hasOwnProperty.call(s, "materials") ? s.materials : buildMaterials;
    const materialsToken = Object.prototype.hasOwnProperty.call(s, "materialsToken") ? s.materialsToken : buildMaterialsToken;
    const matPicks = s.matPicks || buildMatPicks;
    const materialMode = s.materialMode || buildMaterialMode;
    const options = s.options || buildOptions || defaultBuildOptions();
    const direction = Object.prototype.hasOwnProperty.call(s, "direction") ? s.direction : buildDirection;
    const keepBuilding = Object.prototype.hasOwnProperty.call(s, "keepBuilding") ? !!s.keepBuilding : keepBuildingAfterPlacement;
    const reqs = itemRequirements(item);
    const dirs = Array.isArray(item.directions) ? item.directions : [];
    const qtyText = q => (Number(q) < 0 ? "area" : (Number(q) || 1));
    // Prefer the live material list (DF-style picker) when it matches this building; else fall back
    // to the catalog's plain "Material" text (e.g. while the list is still loading).
    const matReqs = (materials && materialsToken === item.token && Array.isArray(materials.requirements))
      ? materials.requirements : null;
    let reqHtml;
    if (matReqs && matReqs.length) {
      reqHtml = matReqs.map(req => {
        const idx = Number(req.index);
        if (req.pinned) {
          return `<div class="build-req-row"><span>${qtyText(req.quantity)}</span><span>${escapeHtml(req.label || "Material")}</span></div>`;
        }
        // B148: while the bulk "Use closest material" placement toggle is active, per-requirement
        // picks are ignored (appendBuildOptions bulk-overrides every non-pinned requirement), so
        // rendering live selects in that mode shipped a dead control right under the toggle that
        // does the same thing. Show the resolved state as plain text instead; the selects return
        // in "Select material after placement" mode.
        if (materialMode === "closest") {
          return `<div class="build-req-row"><span>${qtyText(req.quantity)}</span><span>${escapeHtml(req.label || "Material")}: closest to placement</span></div>`;
        }
        const mats = Array.isArray(req.materials) ? req.materials : [];
        const total = mats.reduce((a, m) => a + (Number(m.count) || 0), 0);
        // B148: the old "Closest to placement" option here duplicated the placement toggle one
        // section up -- two overlapping closest-material affordances. The toggle is the one
        // native-DF affordance (WD-15, 27-build-placement.png); the select now offers only
        // Any + specific materials.
        const pick = MAT_PICK_RE.test(matPicks[idx] || "") ? matPicks[idx] : "";
        const opts = [
          `<option value=""${pick === "" ? " selected" : ""}>Any material (${total} on hand)</option>`,
        ].concat(mats.map(m => {
            const val = matPickValue(m);
            const label = matPickLabel(m) || val;
            return `<option value="${val}"${pick === val ? " selected" : ""}>${escapeHtml(label)} (${Number(m.count) || 0})</option>`;
          }));
        return `<div class="build-req-row"><span>${qtyText(req.quantity)}</span><span class="build-req-mat"><select class="build-mat-select" data-build-mat="${idx}">${opts.join("")}</select></span></div>`;
      }).join("");
    } else {
      reqHtml = reqs.length
        ? reqs.map(req => `<div class="build-req-row"><span>${escapeHtml(qtyText(req.quantity))}</span><span>${escapeHtml(req.label || "Material")}</span></div>`).join("")
        : `<div class="build-req-row"><span>0</span><span>No materials</span></div>`;
    }
    const directionHtml = item.direction ? `
      <div class="build-section-title">Direction</div>
      <div class="build-dir-row">
        ${dirs.map(dir => DWFUI.plaqueBtnHtml({
          cls: `build-dir${Number(dir.value) === Number(direction) ? " active" : ""}`,
          dataset: { buildDir: Number(dir.value) }, label: String(dir.label || dir.value),
        })).join("")}
      </div>` : "";
    const hollowHtml = item.hollow ? `
      <div class="build-section-title">Area</div>
      <div class="build-toggle-row">
        ${toggleButton("hollow", "Hollow", options)}
      </div>` : "";
    const weaponHtml = item.weaponCount ? `
      <div class="build-section-title">Weapons</div>
      <div class="build-num-grid">
        ${numInput("weapon_count", "Count", 1, 10, options)}
      </div>` : "";
    const pressureHtml = item.pressure ? `
      <div class="build-section-title">Triggers</div>
      <div class="build-toggle-row">
        ${toggleButton("plate_units", "Units", options)}
        ${toggleButton("plate_water", "Water", options)}
        ${toggleButton("plate_magma", "Magma", options)}
        ${toggleButton("plate_track", "Minecart", options)}
        ${toggleButton("plate_citizens", "Citizens", options)}
        ${toggleButton("plate_resets", "Resets", options)}
      </div>
      <div class="build-num-grid">
        ${numInput("unit_min", "Unit min", 0, 1000000, options)}
        ${numInput("unit_max", "Unit max", 0, 1000000, options)}
        ${numInput("water_min", "Water min", 0, 7, options)}
        ${numInput("water_max", "Water max", 0, 7, options)}
        ${numInput("magma_min", "Magma min", 0, 7, options)}
        ${numInput("magma_max", "Magma max", 0, 7, options)}
        ${numInput("track_min", "Cart min", 0, 1000000, options)}
        ${numInput("track_max", "Cart max", 0, 1000000, options)}
      </div>` : "";
    const dumpDir = `${Number(options.dump_x) || 0},${Number(options.dump_y) || 0}`;
    const dumpButton = (label, dx, dy) => DWFUI.plaqueBtnHtml({
      cls: `build-dir${dumpDir === `${dx},${dy}` ? " active" : ""}`,
      dataset: { buildDump: "", dumpX: dx, dumpY: dy }, label,
    });
    const trackHtml = item.trackStop ? `
      <div class="build-section-title">Track stop</div>
      <div class="build-toggle-row">
        ${toggleButton("track_dump", "Dump", options)}
      </div>
      <div class="build-dir-row">
        ${dumpButton("None", 0, 0)}
        ${dumpButton("N", 0, -1)}
        ${dumpButton("E", 1, 0)}
        ${dumpButton("S", 0, 1)}
        ${dumpButton("W", -1, 0)}
      </div>
      <div class="build-num-grid">
        ${numInput("friction", "Friction", 0, 50000, options)}
      </div>` : "";
    const speedHtml = item.speed ? `
      <div class="build-section-title">Speed</div>
      <div class="build-num-grid">
        ${numInput("speed", "Speed", 1000, 100000, options)}
      </div>` : "";
    // WD-15 placement panel (27-build-placement.png): "Click a tile to place the X." + the
    // Select-material-after-placement / Use-closest-material toggle + the Keep-building-after-
    // placement checkbox. See appendBuildOptions (bulk "closest" override) and placeBuildDrag
    // (re-arm-or-exit on success) for where these two flags actually take effect.
    // The placement-mode pair uses the same plaque grammar as every other build option. uiflow_test
    // pins the stable data hook and label independently, so the component may own the markup without
    // weakening B148's exactly-one closest-material affordance guarantee.
    const placementHtml = `
      <div class="build-placement">
        <div class="build-placement-msg">Click a tile to place the ${escapeHtml(item.label || "building")}.</div>
        <div class="build-placement-toggle">
          ${DWFUI.plaqueBtnHtml({ cls: `build-toggle${materialMode === "select" ? " active" : ""}`,
            dataset: { "build-matmode": "select" },
            labelHtml: DWFUI.rawHtml("preserve the placement toggle's established plain-label rendering during component adoption", "Select material after placement") })}
          ${DWFUI.plaqueBtnHtml({ cls: `build-toggle${materialMode === "closest" ? " active" : ""}`,
            dataset: { "build-matmode": "closest" },
            labelHtml: DWFUI.rawHtml("preserve the placement toggle's established plain-label rendering during component adoption", "Use closest material") })}
        </div>
        <div class="build-keep-row">
          ${DWFUI.checkHtml({ checked: !!keepBuilding, dataset: { buildKeep: "" },
            title: "Keep building after placement", ariaLabel: "Keep building after placement" })}
          <span>Keep building after placement</span>
        </div>
      </div>`;
    const candidateHtml = pendingPlaceCandidateHtml(item, Object.prototype.hasOwnProperty.call(s, "pending") ? s.pending : undefined);
    return `
      ${candidateHtml}
      ${placementHtml}
      <div class="build-detail-title">${escapeHtml(item.label || "Building")}</div>
      <div class="build-section-title">Needs</div>
      <div class="build-req-list">${reqHtml}</div>
      ${directionHtml}
      ${hollowHtml}
      ${weaponHtml}
      ${pressureHtml}
      ${trackHtml}
      ${speedHtml}
    `;
  }

  function toggleButton(key, label, values) {
    const source = values || buildOptions || defaultBuildOptions();
    const on = Number(source[key] || 0) !== 0;
    return DWFUI.plaqueBtnHtml({
      cls: `build-toggle${on ? " active" : ""}`,
      dataset: { buildToggle: key, value: on ? 0 : 1 }, label,
    });
  }

  // NOT MIGRATED, and reported rather than faked: R7's hint for a raw number input is
  // DWFUI.stepperHtml. But this is an EDITABLE FIELD (a typed min/max threshold, 0..1,000,000), and
  // the invariants keep editable inputs as DOM inputs on purpose -- a +/- stepper over a
  // million-step range is not the same control, and swapping it would be a behaviour change, not a
  // structure migration. It stays, and the tension is filed in the closeout.
  function numInput(key, label, min, max, values) {
    const source = values || buildOptions || defaultBuildOptions();
    const value = Math.max(min, Math.min(max, Math.floor(Number(source[key] ?? min))));
    return `<label class="build-num-label">${escapeHtml(label)}<input class="build-num" data-build-num="${key}" type="number" min="${min}" max="${max}" value="${value}"></label>`;
  }

  function clearBuildPlacement(render = true) {
    if (typeof window !== "undefined" && typeof window.DFCancelBuildCornerAnchor === "function")
      window.DFCancelBuildCornerAnchor();
    selectedBuild = null;
    buildStatus = "";
    buildStatusError = false;
    pendingBuildPlacement = null;
    // Drop the browser-side footprint preview so it doesn't linger after cancel/place.
    if (typeof buildPreview !== "undefined" && buildPreview) { buildPreview = null; renderZoneOverlay(); }
    updateToolCursor();
    if (render && clientPanel.classList.contains("build-panel"))
      renderBuildPanel();
  }

  function appendBuildOptions(params, item) {
    const add = key => params.set(key, String(Math.floor(Number(buildOptions[key] ?? 0))));
    add("hollow");
    add("weapon_count");
    add("plate_units"); add("plate_water"); add("plate_magma"); add("plate_track");
    add("plate_citizens"); add("plate_resets");
    add("unit_min"); add("unit_max"); add("water_min"); add("water_max");
    add("magma_min"); add("magma_max"); add("track_min"); add("track_max");
    add("track_dump"); add("dump_x"); add("dump_y"); add("friction"); add("speed");
    // DF-style material picks: mat0..matN per requirement -> "matType:matIndex", or the literal
    // "closest" (backend resolves it to the nearest matching item's material at placement time).
    if (buildMaterialMode === "closest") {
      // WD-15: "Use closest material" placement-panel toggle -- bulk-apply closest-to-placement
      // to every non-pinned requirement, overriding any individual per-requirement picks (the
      // detail panel's material selects still show/edit buildMatPicks, but this mode ignores
      // them until switched back to "Select material after placement").
      const reqs = (buildMaterials && selectedBuild && buildMaterialsToken === selectedBuild.token &&
        Array.isArray(buildMaterials.requirements)) ? buildMaterials.requirements : [];
      for (const req of reqs) {
        if (!req.pinned) params.set(`mat${Number(req.index)}`, "closest");
      }
    } else {
      // B148: only concrete picks survive. A per-requirement "closest" value (removed from the
      // select; may linger in saved lastBuildPicksByToken entries) is dropped, matching what the
      // select now displays for it ("Any material"). B244: a pick is itemType:matType:matIndex
      // (2-part legacy picks still accepted).
      for (const [idx, val] of Object.entries(buildMatPicks)) {
        if (MAT_PICK_RE.test(val)) params.set(`mat${Number(idx)}`, val);
      }
    }
  }

  async function submitBuildPlacement(item, baseParams, itemId) {
    const params = new URLSearchParams(baseParams);
    if (Number.isInteger(itemId) && itemId >= 0) params.set("item_id", String(itemId));
    pendingBuildPlacement = null;
    try {
      const r = await fetch("/build-place?" + params.toString(), { method: "POST", cache: "no-store" });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text.trim() || "building failed");
      }
      const data = await r.json();
      buildStatus = item.label + ": " + (Number(data.count) || 1) + " job" +
        (Number(data.count) === 1 ? "" : "s");
      buildStatusError = false;
      if (item.token) lastBuildPicksByToken[item.token] = { ...buildMatPicks };
      if (!keepBuildingAfterPlacement) {
        selectedBuild = null;
        if (typeof buildPreview !== "undefined" && buildPreview) { buildPreview = null; renderZoneOverlay(); }
        updateToolCursor();
      }
      renderBuildPanel();
      loadHud();
    } catch (err) {
      buildStatus = String(err.message || err || "Building failed").replace(/^building failed:\s*/i, "");
      buildStatusError = true;
      renderBuildPanel();
    }
  }

  function buildPlacementBounds(a, b) {
    if (!a || !b) return null;
    const values = [a.x, a.y, b.x, b.y, a.w, a.h].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return { x1: Math.min(values[0], values[2]), y1: Math.min(values[1], values[3]),
      x2: Math.max(values[0], values[2]), y2: Math.max(values[1], values[3]),
      w: values[4], h: values[5] };
  }

  // B291: held-drag and click/click area placement both enter here with tile corners. Keeping
  // URL construction below this one boundary makes the two gestures incapable of drifting into
  // different farm/construction rectangles.
  async function placeBuildCells(a, b) {
    const item = selectedBuild;
    if (!item) return;
    const rect = buildPlacementBounds(a, b);
    if (!rect) return;
    const params = new URLSearchParams();
    params.set("player", player);
    params.set("px", String(rect.x1));
    params.set("py", String(rect.y1));
    params.set("px2", String(rect.x2));
    params.set("py2", String(rect.y2));
    params.set("w", String(rect.w));
    params.set("h", String(rect.h));
    params.set("token", item.token);
    params.set("direction", String(buildDirection));
    appendBuildOptions(params, item);

    // Native furniture placement chooses a finished item after the placement tile is clicked.
    // Non-furniture (and a failed additive lookup) continue through the legacy request unchanged.
    try {
      const r = await fetch("/place-candidates?token=" + encodeURIComponent(item.token), { cache: "no-store" });
      if (r.ok) {
        const data = await r.json();
        if (selectedBuild !== item) return; // ignore a stale post-click picker response
        if (data && data.ok && data.specificItem) {
          pendingBuildPlacement = {
            item,
            params,
            candidates: Array.isArray(data.candidates) ? data.candidates : []
          };
          buildStatus = "";
          buildStatusError = false;
          renderBuildPanel();
          return;
        }
      }
    } catch (_) {
      // This additive lookup must never block the established generic placement path.
    }
    await submitBuildPlacement(item, params);
  }

  async function placeBuildDrag(x1, y1, x2, y2) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    await placeBuildCells(a, b);
  }

  // WAVE-5: `infoTabButton()` was DELETED here. It was a dead, hand-built duplicate of DWFUI.tabsHtml
  // -- a raw hand-built `info-tab` button with NO consumer anywhere in web/ or tools/ (three-step proof:
  // `grep -rn "infoTabButton" web/ tools/` returns only its own definition and its module.exports
  // line; `grep -rni "infoTabButton" src/` is empty). Both live tab rows below (infoTabRowHtml,
  // infoDetailTabRowHtml) already go through DWFUI.tabsHtml, so nothing dispatched through it.

  // W3 of the info shell (matrix §3 F3 "Which screen uses which" + §4 S3): the nested subtab row of
  // Creatures / Places / Objects (Residents·Pets·Other·Dead, etc.) is the SHORT_SUBTAB grammar.
  function infoDetailTabRowHtml(tabs, activeId) {
    if (!Array.isArray(tabs) || !tabs.length) return "";
    return DWFUI.tabsHtml({
      cls: "info-detail-tabs", tabCls: "info-tab", dataAttr: "info-detail", level: "subtab",
      ariaLabel: "Information section", active: activeId,
      tabs: tabs.map(tab => ({ key: tab.id, label: tab.label })),
    });
  }

  // WD-16: monotonic request token guarding openPanel's /panel fetch below against a
  // rapid-tab-switch race (see the requestSeq comment at its call site).
  let infoPanelRequestSeq = 0;

  // WD-16: the ONE persistent 8-tab row every info destination shares, in DF's
  // info_interface_mode_type order (13-info-creatures.png ground truth: Creatures/Tasks/Places/
  // Labor/Work orders/Nobles and administrators/Objects/Justice). Single source of truth --
  // replaces three independent copies that used to exist (this file's old two-row primaryTabs/
  // sectionTabs split, and a duplicated MAIN_TABS/WO_MAIN_TABS literal in
  // dwf-labor-work-orders.js for the labor/work-orders screens). Nobles/Justice
  // (dwf-fort-admin.js) re-host into this same row via fort-panels.js's
  // renderInfoShellWindow. Hardcoded client-side (not server-driven) because the row itself
  // never changes shape -- only the active highlight and the body slot do.
  const INFO_TABS = [
    { key: "creatures",  label: "Creatures",                 panel: "citizens",  hotkey: "u" },
    { key: "tasks",      label: "Tasks",                     panel: "orders",    hotkey: "t" },
    { key: "places",     label: "Places",                    panel: "locations", hotkey: "Shift+P" },
    { key: "labor",      label: "Labor",                     panel: "labor",     hotkey: "y" },
    { key: "workorders", label: "Work orders",                panel: "workorders",hotkey: "o" },
    { key: "nobles",     label: "Nobles and administrators",  panel: "nobles",    hotkey: "n" },
    { key: "objects",    label: "Objects",                    panel: "objects",   hotkey: "Shift+O" },
    { key: "justice",    label: "Justice",                    panel: "justice",   hotkey: "j" },
  ];

  // W2 of the info shell: the PRIMARY nav is the tall `TAB` grammar (matrix §3 F3 "Information
  // window | row 1 = TAB", §4 S3 W2; oracle CIM-justice-convicts.jpg shows the gold TAB row above the
  // silver SHORT_SUBTAB row). It passed NO level until now, which is exactly what the owner was looking at:
  // a plain CSS box with browser text where native has gold tab art and the DF bitmap font.
  function infoTabRowHtml(activeKey) {
    return DWFUI.tabsHtml({
      cls: "info-tab-row", tabCls: "info-tab", dataAttr: "info-tab", level: "primary",
      ariaLabel: "Fortress information", active: activeKey,
      tabs: INFO_TABS.map(tab => ({ key: tab.key, label: tab.label, title: `${tab.label}\nHotkey: ${tab.hotkey}` })),
    });
  }

  // Wires the shared row's clicks wherever it's mounted (this file, labor-work-orders.js,
  // fort-admin.js via renderInfoShellWindow) -- innerHTML replacement means every render needs
  // its own listener pass, same pattern as the rest of this file's [data-*] wiring.
  function wireInfoTabRow(root) {
    (root || clientPanel).querySelectorAll("[data-info-tab]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const tab = INFO_TABS.find(t => t.key === button.dataset.infoTab);
        if (tab) openPanel(tab.panel);
      });
    });
  }

  // Bottom search field + magnifier button. Always use DWFUI's shared native search grammar: one
  // field abutting the real BUTTON_FILTER sprite. The old local markup duplicated the field and
  // rendered a magnifying-glass emoji, which let Justice drift from every other information menu.
  function infoSearchBoxHtml() {
    return DWFUI.searchHtml({
      cls: "info-search", placement: "footer", magnifier: true,
      placeholder: "...", ariaLabel: "Search this information view",
    });
  }

  // WD-17: the Creatures tab's search box is functional (filters the fetched row set
  // client-side, same convention as the build panel's live search input). R10 parameterises the
  // data-attribute so the generic info panels (Tasks/Places/Objects) can reuse the same input
  // with their own `data-info-search` hook instead of the dead placeholder.
  function infoSearchInputHtml(value, attr) {
    const a = attr || "creature-search";
    return DWFUI.searchHtml({
      cls: "info-search", inputCls: "dwfui-search-input info-search-input",
      placement: "footer", magnifier: true, type: "search", dataAttr: a,
      value: value || "", ariaLabel: "Search this information view", preserveKey: `info-${a}`,
    });
  }

  function rowTone(text) {
    // Native does colour some state/job strings, but the payload does not yet carry that draw
    // colour. English-word matching was not DF state and produced false hues. Leave these cells
    // uncoloured until the server can ship an authoritative index.
    void text;
    return "";
  }

  // Does this row name an entity at all? A Tasks row like `Dump item` (tasks screen.png) names NO
  // place, NO building and NO unit -- its icon column is EMPTY in native, not "art we failed to
  // find". That is a different thing from a Place/Object row whose art we genuinely could not
  // resolve, and the two must not render the same.
  function infoRowHasPlaceArt(row) {
    const sheet = String(row?.iconSheet || "");
    return sheet === "zone" || sheet === "stockpile" || !!String(row?.iconKey || "");
  }

  // WAVE-5 / S4 GAP-1, SECOND CHANNEL: this was the LAST silent first-letter fallback in the file --
  // the same class of bug as the (now removed) itemArtTile, still alive for PLACE icons. the "all
  // item icons are letters" was fixed for items in Wave 4; the place channel kept doing it.
  //
  // The three real art paths are ad-hoc background-position sheets (activity_zones.png,
  // stockpiles.png, building_icons.png -- art channel 3). They are NOT interface_map tokens, so
  // DWFUI cannot resolve them and they stay raw spans; converting them needs a sprite wire the
  // server does not send (REPORTED, not faked). What DOES change is the fallback: an unresolvable
  // place now FAILS LOUD through DWFUI.iconHtml -- the native empty tile plus
  // `data-df-identity-missing` -- and NEVER degrades to a letter. Native itself never substitutes a
  // letter for missing art (5.2.1 Select Bodywear Menu.PNG renders an empty tile).
  function infoPlaceIconMarkup(row) {
    const sheet = String(row?.iconSheet || "");
    if (sheet === "zone") {
      const ix = Math.max(0, Number(row.iconX) || 0);
      const iy = Math.max(0, Number(row.iconY) || 0);
      return `<span class="info-place-icon zone-icon" style="background-position:-${ix * 32}px -${iy * 32}px"></span>`;
    }
    if (sheet === "stockpile") {
      const rowIdx = Math.max(0, Number(row.iconRow) || 0);
      return `<span class="info-place-icon" style="${spIconStyle(rowIdx, 32)}"></span>`;
    }
    const iconKey = String(row?.iconKey || "");
    const bldStyle = iconKey ? bldIconStyle(iconKey, 32) : "";
    if (bldStyle)
      return `<span class="info-place-icon" style="${bldStyle}"></span>`;
    const ui = D();
    return ui ? ui.iconHtml({ cls: "info-place-icon", size: 32, alt: row?.name || row?.category || "" }) : "";
  }

  function infoRowPos(row) {
    if (!row || !row.hasPos) return null;
    const x = Number(row.x), y = Number(row.y), z = Number(row.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x, y, z };
  }

  function infoRowActions(row) {
    const kind = String(row?.kind || "");
    const id = Number(row?.buildingId ?? -1);
    const itemId = Number(row?.itemId ?? -1);
    const jobId = Number(row?.jobId ?? -1);
    const canOpenPlace = id >= 0 && ["stockpile", "workshop", "zone", "building"].includes(kind);
    const canOpenItem = itemId >= 0 && kind === "item";
    const canOpen = canOpenPlace || canOpenItem;
    const canCenter = !!infoRowPos(row);
    // WD-22: Tasks rows (14-info-tasks.png) get a cancel button ahead of the zoom/center
    // button -- Places/Objects rows never carry a jobId so this is a no-op for them.
    const canCancel = jobId >= 0;
    if (!canOpen && !canCenter && !canCancel) return "";
    // WAVE-5: THREE EMOJI BECOME THREE NATIVE SPRITES. This cluster used to hand-type the HTML
    // entities for a heavy multiplication X, a magnifying glass and a MOVIE CAMERA -- while DF's own tiles for
    // exactly these three actions have sat in TOKENS.sprites (and in web/interface_map.json) since
    // Wave 2. Verified present in the map: BUILDING_JOBS_REMOVE, STOCKS_VIEW_ITEM, RECENTER_RECENTER.
    // The cluster order, the `.info-row-actions`/`.info-row-action` classnames and all three
    // data-* hooks (data-info-cancel-job / data-info-open / data-info-center) are unchanged, so every
    // handler in wireInfoBody still dispatches exactly what it dispatched before.
    const ui = D();
    if (!ui) return "";
    const S = ui.TOKENS.sprites;
    const items = [];
    if (canCancel) items.push({ action: "cancelJob", sprite: S.cancelJob,
      dataset: { infoCancelJob: jobId }, title: "Cancel job" });
    if (canOpen) items.push({ action: "view", sprite: S.view,
      dataset: { infoOpen: "" }, title: "Open / manage" });
    if (canCenter) items.push({ action: "recenter", sprite: S.recenter,
      dataset: { infoCenter: "" }, title: "Center and flash" });
    return ui.actionButtonsHtml(items,
      { cls: "info-row-actions", btnCls: "info-row-action", ariaLabel: "Row actions" });
  }

  function renderInfoRows(rows) {
    if (!Array.isArray(rows) || !rows.length)
      return "";
    return `
      <div class="info-table-head">
        <span></span><span>Name</span><span>Cat</span><span>Prof</span><span>Job / Status</span>
      </div>
      <div class="info-table">
        ${rows.map(row => {
          const hasUnit = Number(row.unitId ?? -1) >= 0;
          const kind = String(row.kind || "");
          const buildingId = Number(row.buildingId ?? -1);
          const itemId = Number(row.itemId ?? -1);
          const clickable = (hasUnit || itemId >= 0 || (buildingId >= 0 && kind)) ? " clickable" : "";
          const status = row.status || "";
          const tone = rowTone(`${status} ${row.job || ""}`);
          const badges = Array.isArray(row.badges) ? row.badges : [];
          const pos = infoRowPos(row);
          return `
            <div class="info-row${clickable}${row.muted ? " info-muted" : ""}"
              data-unit-id="${escapeHtml(row.unitId ?? -1)}"
              data-place-kind="${escapeHtml(kind)}"
              data-building-id="${escapeHtml(row.buildingId ?? -1)}"
              data-item-id="${escapeHtml(row.itemId ?? -1)}"
              ${pos ? `data-pos-x="${escapeHtml(pos.x)}" data-pos-y="${escapeHtml(pos.y)}" data-pos-z="${escapeHtml(pos.z)}"` : ""}>
              ${hasUnit ? unitPortraitMarkup(row, "info-portrait-small") : infoPlaceIconMarkup(row)}
              <div>
                <div class="info-name-main">${escapeHtml(row.name || "")}</div>
                ${row.subtitle ? `<div class="info-subtitle">${escapeHtml(row.subtitle)}</div>` : ""}
              </div>
              <div>${escapeHtml(row.category || "")}</div>
              <div>${escapeHtml(row.profession || "")}</div>
              <div>
                ${status ? `<div class="info-status ${tone}">${escapeHtml(status)}</div>` : ""}
                ${row.job ? `<div class="info-muted">${escapeHtml(row.job)}</div>` : ""}
                ${badges.length ? `<div class="info-badges">${badges.map(badge => `<span class="info-badge">${escapeHtml(badge)}</span>`).join("")}</div>` : ""}
                ${infoRowActions(row)}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  // ---- WD-17: Creatures tab row anatomy (13-info-creatures.png) ----
  // Distinct from the generic renderInfoRows (still used by Tasks/Places/Objects, WD-22) because
  // the real DF row has extra elements those tabs don't: locate+view button pair, a mood face,
  // a labor-hammer shortcut, and a held-item glyph. Kept in a separate function so those other
  // (not-yet-restyled) tabs don't inherit chrome their own ground-truth captures don't show.
  let creatureSearch = "";
  let creatureSortKey = "name"; // native unit_list always has one active sort column
  let creatureSortDir = 1;    // 1 = ascending, -1 = descending
  let creatureRowsRaw = [];   // last-fetched rows for the active sub-tab (sort/search are local)
  let creatureTrainers = [];  // B33: trainer-capable dwarves for the Pets tab's assign-trainer picker
  // B254: the /labor snapshot, used ONLY as the old-DLL fallback for the residents row's SPECIALIZED
  // + WORK_DETAILS columns (see residentLaborState). Once the DLL carries those fields on the /info
  // row itself, this is ignored -- but it is what makes the feature work on the DLL that is running
  // right now, with no restart. null = never fetched / fetch failed -> the columns fail closed.
  let creatureLabor = null;
  let creatureMessageHtml = "";

  // One resolver for every unit row in the Information family. The plugin gets this byte from
  // Units::getProfessionColor; an absent/invalid byte intentionally produces no inline colour.
  function professionColorStyle(record) {
    const idx = record && record.professionColor;
    if (Number.isInteger(idx) && idx >= 0 && idx <= 15 && DWFUI && typeof DWFUI.dfColor === "function")
      return ` style="color:${DWFUI.dfColor(idx)}"`;
    return "";
  }

  // B296: unlike professionColor, DF exposes no resident-list job color byte. The server owns the
  // capture-pinned exact-label table and sends -1 for every unobserved label; the browser only
  // resolves that served palette index. Never infer a hue from English words here.
  function residentJobColorStyle(record) {
    const idx = record && record.jobColor;
    if (Number.isInteger(idx) && idx >= 0 && idx <= 15 && DWFUI && typeof DWFUI.dfColor === "function")
      return ` style="color:${DWFUI.dfColor(idx)}"`;
    return "";
  }

  function residentNameProfession(row) {
    const name = String(row?.name || "");
    const profession = String(row?.profession || "");
    if (!name) return profession;
    return profession ? `${name}, ${profession}` : name;
  }

  // New DLLs serve the real need state independently of DF's rendered punctuation. Normalize the
  // base label and let that boolean alone decide the suffix. Old DLLs omit the key, so their exact
  // already-composed string remains untouched until the next required plugin rebuild.
  function residentJobText(row) {
    const raw = String(row?.status || row?.job || "");
    if (!Object.prototype.hasOwnProperty.call(row || {}, "jobNeedDriven")) return raw;
    const base = raw.endsWith("!") ? raw.slice(0, -1) : raw;
    return row.jobNeedDriven && base ? `${base}!` : base;
  }

  function creatureRowSearchText(row) {
    return `${row.name || ""} ${row.profession || ""} ${row.category || ""} ${row.status || row.job || ""}`.toLowerCase();
  }

  function sortCreatureRows(rows) {
    if (!creatureSortKey) return rows;
    const key = creatureSortKey, dir = creatureSortDir;
    return rows.slice().sort((a, b) => compareCreatureRows(a, b, key, dir));
  }

  function compareCreatureRows(a, b, key, dir) {
    if (key === "moodCategory") {
      const av = Number(a?.moodCategory ?? -1);
      const bv = Number(b?.moodCategory ?? -1);
      return (av - bv) * dir;
    }
    const av = String(a?.[key] || "").toLowerCase();
    const bv = String(b?.[key] || "").toLowerCase();
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * dir;
  }

  // Held item: real inventory data from the server (row.heldItem -- empty when the unit holds
  // nothing). WAVE-5: this was the file's OTHER silent first-letter tile (a "D" box for a dagger),
  // the same blocker as itemArtTile and the place-icon fallback. It now goes through DWFUI.iconHtml
  // and FAILS LOUD: the native empty tile + `data-df-identity-missing`, never a letter.
  //
  // WIRE GAP, REPORTED NOT FAKED: `row.heldItem` is a NAME STRING. The server sends no spriteRef for
  // it, so there is nothing for the item channel to resolve -- iconHtml renders the honest empty tile
  // rather than inventing art. The tooltip still carries the item's real name, so no information is
  // lost; the tile lights up for free the day the wire carries the ref. (Compare the stocks rows,
  // which DO get a spriteRef and DO paint.)
  function creatureHeldItemHtml(row) {
    const name = String(row.heldItem || "");
    if (!name) return "";
    const ui = D();
    if (!ui) return "";
    return ui.iconHtml({ cls: "info-held-item", size: 22, title: name, alt: name });
  }

  function creatureSexGlyphHtml(row) {
    const raw = String(row?.sex || row?.gender || row?.ct || row?.casteToken || "").toLowerCase();
    if (raw === "female") return `<span class="creature-sex-glyph" title="Female">&#9792;</span>`;
    if (raw === "male") return `<span class="creature-sex-glyph" title="Male">&#9794;</span>`;
    return `<span class="creature-sex-glyph" aria-hidden="true"></span>`;
  }

  // B16: Pets/Livestock action buttons -- DF's own livestock screen exposes Slaughter, War/Hunt
  // training, and Make-available-for-adoption toggles per animal. Only rendered on the "pets"
  // sub-tab and only for rows the server flagged as livestock (row.livestock). War/Hunt buttons
  // appear only when the caste actually supports that training (trainableWar/Hunt); Make-pet is
  // hidden once the animal is already a pet. Each button reflects the current toggle state and
  // POSTs /livestock-action on click.
  // Husbandry: the Geld button spec for one animal's livestock state. Pure (no DOM, no globals) so
  // the offline husbandry_client_test can exercise the gate without a browser -- same convention as
  // dwf-menu-tree.js/composeTaskKey. Returns null when the animal isn't geldable: the server
  // sends geldable=false for a non-GELDABLE caste OR an already-gelded one, and an OLD DLL omits the
  // field entirely -- all three collapse to "no button". `active` reflects flags3.marked_for_gelding
  // so the button shows its toggle state and its title flips like the other livestock buttons.
  function geldButtonSpec(ls) {
    if (!ls || !ls.geldable) return null;
    return {
      action: "geld",
      active: !!ls.geld,
      label: "Geld",
      title: ls.geld ? "Marked for gelding (click to cancel)" : "Mark for gelding",
    };
  }

  function memorialButtonSpec(row, detail) {
    const unitId = Number((row && row.unitId) ?? -1);
    if (detail !== "dead" || !Number.isInteger(unitId) || unitId < 0) return null;
    return { unitId, label: "Slab", title: "Engrave memorial slab" };
  }

  function livestockActionsHtml(row, detail = activeInfoDetail, trainers = creatureTrainers) {
    if (detail !== "pets") return "";
    const ls = row && row.livestock;
    if (!ls) return "";
    const unitId = Number(row.unitId ?? -1);
    if (!(unitId >= 0)) return "";
    const ui = D();
    if (!ui) return "";
    // WAVE-5: the six livestock toggles are WIRED SUPERSETS (Slaughter / Geld / War / Hunt / Make pet
    // / Tame -- each POSTs /livestock-action) and every one is KEPT. They are dressed in the native
    // plaque now instead of a hand-built button element; `.livestock-btn`, the `.active` latch class and
    // both data-livestock-* hooks are unchanged, so each still dispatches exactly what it did before.
    const btn = (action, on, label, title) => ui.plaqueBtnHtml({
      cls: `livestock-btn${on ? " active" : ""}`, label, title,
      dataset: { livestockAction: action, livestockUnit: unitId },
    });
    let out = "";
    out += btn("slaughter", ls.slaughter, "Slaughter", ls.slaughter ? "Marked for slaughter (click to cancel)" : "Mark for slaughter");
    // Husbandry: Geld, immediately after Slaughter (native order is Butcher, Geld). Only geldable,
    // not-yet-gelded animals get the button; an OLD DLL omits `geldable` -> no button (dormant-safe).
    const geld = geldButtonSpec(ls);
    if (geld) out += btn(geld.action, geld.active, geld.label, geld.title);
    if (ls.trainableWar)
      out += btn("war", ls.war, "War", ls.war ? "War training assigned (click to cancel)" : "Train for war");
    if (ls.trainableHunt)
      out += btn("hunt", ls.hunt, "Hunt", ls.hunt ? "Hunt training assigned (click to cancel)" : "Train for hunting");
    if (!ls.pet)
      out += btn("pet", ls.adoption, "Make pet", ls.adoption ? "Available for adoption (click to cancel)" : "Make available for adoption");
    // B33: taming / trainer assignment -- DF's "Assign a trainer to this creature" action. Only for
    // a tameable animal not yet domesticated (ls.tamable). The Tame toggle assigns/cancels an
    // "any trainer" taming job; when trainer-capable dwarves exist, the dropdown re-targets the
    // assignment at a specific dwarf (or back to "Any trainer"). Server clamps: a non-tamable or
    // already-domesticated animal is rejected 400 even if the client ever mis-renders the control.
    if (ls.tamable) {
      out += btn(ls.training ? "unassign-trainer" : "assign-trainer", ls.training,
        ls.training ? "Taming" : "Tame",
        ls.training ? "Being tamed (click to cancel)" : "Assign a trainer to tame this animal");
      if (trainers.length) {
        const cur = Number(ls.trainerId ?? -1);
        const opts = [`<option value="-1"${cur === -1 ? " selected" : ""}>Any trainer</option>`]
          .concat(trainers.map(t => {
            const tid = Number(t.id);
            return `<option value="${escapeHtml(tid)}"${cur === tid ? " selected" : ""}>${escapeHtml(t.name || ("Unit " + tid))}</option>`;
          })).join("");
        out += `<select class="livestock-trainer" data-trainer-select data-livestock-unit="${escapeHtml(unitId)}" title="Assign a specific trainer">${opts}</select>`;
      }
    }
    return `<div class="livestock-actions">${out}</div>`;
  }

  // ---- WAVE-5: THE COLUMN SORT HEADER IS A NATIVE CONTROL, NOT A TYPED TRIANGLE ---------------
  // This hand-rolled head drew a BLACK DOWN-POINTING TRIANGLE character next to each caption and a
  // third, bare one at the end. DF's own sort art -- SORT_{ASCENDING,DESCENDING,TEXT}_{ACTIVE,
  // INACTIVE} -- is VANILLA DF (not a DFHack overlay), has been in TOKENS.sprites and in
  // web/interface_map.json since Wave 2, and had ZERO consumers while four production files
  // hand-rolled the triangle. DWFUI.sortHeaderHtml is the builder that owns it, and Creatures is one
  // of its four declared consumers.
  //
  // It is a RADIOGROUP over columns (exactly one active key), which is why it is neither
  // actionButtonsHtml nor tabsHtml. Our sort also carries a DIRECTION, and native encodes ascending
  // and descending in TWO DIFFERENT SPRITES -- so the active column reports `asc`/`desc` from
  // creatureSortDir and the inactive ones report `text` (they are text columns, unsorted).
  //
  // The `data-creature-sort` hook is unchanged, so wireCreatureBody's existing click handler (and its
  // toggle-direction-on-reclick behaviour) still dispatches exactly as before.
  function creatureSortHead(sortKey = creatureSortKey, sortDir = creatureSortDir, residents = false) {
    const ui = D();
    if (!ui) return "";
    const col = (key, label, title = `Sort by ${label}`) => ({
      key, label,
      sort: sortKey === key ? (Number(sortDir) === -1 ? "desc" : "asc") : "text",
      title,
    });
    const columns = [col("name", "Name"), col("category", "Cat"), col("profession", "Prof")];
    if (residents) columns.push(
      col("status", "", "Sort by current job"),
      col("moodCategory", "", "Sort by happiness"));
    return ui.sortHeaderHtml({
      cls: "info-sort-head-row", dataAttr: "creature-sort",
      ariaLabel: "Sort creatures", active: sortKey || null,
      columns,
    });
  }

  // WAVE-5: the Creatures row's action pair was a hand-typed curly return arrow and the
  // magnifying-glass EMOJI. Both have real DF tiles -- RECENTER_RECENTER and STOCKS_VIEW_ITEM
  // -- verified present in web/interface_map.json and already carried in TOKENS.sprites. The
  // `.info-row-actions`/`.creature-actions`/`.info-row-action` classnames and the
  // data-memorial-slab / data-info-center / data-info-open hooks are all preserved verbatim.
  //
  // SUPERSET KEPT: the memorial-slab shortcut is OURS, not DF's (native has no per-row "engrave a
  // slab" button on the Dead tab). Policy is KEEP SUPERSETS, DRESS THEM NATIVE -- so it stays, wired
  // to /memorial-slab exactly as before, and it now renders through the same builder as its
  // neighbours. It keeps its TEXT label ("Slab") because no DF tile attests this action; inventing a
  // sprite for a control DF does not have is precisely the fabrication this programme forbids.
  function creatureRowActionsHtml(row, memorial, pos) {
    const ui = D();
    if (!ui) return "";
    const S = ui.TOKENS.sprites;
    const items = [];
    if (memorial) items.push({ action: "memorial", glyph: escapeHtml(memorial.label),
      dataset: { memorialSlab: memorial.unitId }, title: memorial.title });
    if (pos) items.push({ action: "recenter", sprite: S.recenter,
      dataset: { infoCenter: "" }, title: "Locate on the map" });
    items.push({ action: "view", sprite: S.view, dataset: { infoOpen: "" }, title: "View" });
    return ui.actionButtonsHtml(items, { cls: "info-row-actions creature-actions",
      btnCls: "info-row-action", ariaLabel: "Creature actions" });
  }

  // ---- B254: the two columns DF actually puts here ---------------------------------------------
  //
  // The old code had a "labor shortcut" (a Unicode hammer-and-pick, U+2692, that opened the Labor
  // tab) and a "held item" tile in these two slots. BOTH WERE INVENTED, and the comments defending
  // them were wrong. DF's residents list is `widgets::unit_list`, and df-structures enumerates its
  // columns exactly (df.widgets.unit_list.xml:1-18, `unit_list_options`):
  //
  //     PORTRAIT  NAME_PROF  RECENTER  SHEET  CUR_JOB  ACTIVITY_DETAILS  HAPPINESS
  //     SPECIALIZED  WORK_DETAILS  ...
  //
  // There is no held-item column. The two slots are SPECIALIZED (the green/red padlocked hammer)
  // and WORK_DETAILS (one item tile per work detail the dwarf is on). Both sprites have been in
  // web/interface_map.json since it was built.
  //
  // `residentLaborState` is the pure read model, and it is CAPABILITY-GATED:
  //   * new DLL  -> the /info row carries `specialized` + `workDetails[]` (src/info_panel.cpp).
  //   * old DLL  -> neither field exists, so derive both from the /labor snapshot the Labor tab
  //                 already fetches: rows[].specialist and rows[].assignedTo (detail NAMES), keyed
  //                 back to details[].iconKey. This is why the feature works on the LIVE DLL today.
  //   * neither  -> known:false. The row then renders NO padlock at all. It never renders a live-
  //                 looking control over a state we cannot read -- a dead button that silently does
  //                 the wrong thing to a dwarf is worse than no button (B227's fail-closed rule).
  // Presence, not truthiness: `specialized:false` is a real answer; a MISSING key is not.
  function residentLaborState(row, labor) {
    const empty = { known: false, specialized: false, details: [] };
    const unitId = Number(row?.unitId ?? -1);
    if (!row || !Number.isInteger(unitId) || unitId < 0) return empty;

    if (Object.prototype.hasOwnProperty.call(row, "specialized") && Array.isArray(row.workDetails)) {
      return {
        known: true,
        specialized: !!row.specialized,
        details: row.workDetails
          .filter(d => d && d.name != null)
          .map(d => ({ name: String(d.name), icon: String(d.icon || "NONE") })),
      };
    }

    // Fallback. `assignedTo` is the detail names joined with ", " (src/labor.cpp:378-385). Names are
    // user-editable and CAN contain a comma, so do not trust a blind split: match the pieces against
    // the known vocabulary in details[], longest name first, and consume what matches. Anything left
    // over is still reported by name with no icon -- honest, never guessed.
    const laborRows = Array.isArray(labor?.rows) ? labor.rows : null;
    const laborDetails = Array.isArray(labor?.details) ? labor.details : [];
    if (!laborRows) return empty;
    const mine = laborRows.find(r => Number(r?.id ?? -1) === unitId);
    if (!mine) return empty;   // not an assignable citizen (a long-term resident, B215) -> unknown

    const assigned = String(mine.assignedTo || "").trim();
    const details = [];
    if (assigned) {
      const vocab = laborDetails
        .filter(d => d && d.name)
        .slice()
        .sort((a, b) => String(b.name).length - String(a.name).length);
      let rest = assigned;
      let guard = 0;
      while (rest && guard++ < 64) {
        const hit = vocab.find(d => rest === String(d.name) || rest.startsWith(String(d.name) + ", "));
        if (!hit) {
          const piece = rest.split(", ")[0];
          if (piece) details.push({ name: piece, icon: "NONE" });
          rest = rest.slice(piece.length).replace(/^, /, "");
          continue;
        }
        details.push({ name: String(hit.name), icon: String(hit.iconKey || "NONE") });
        rest = rest.slice(String(hit.name).length).replace(/^, /, "");
      }
    }
    return { known: true, specialized: !!mine.specialist, details };
  }

  // SPECIALIZED. DF's own two tooltips, verbatim from df.d_interface.xml:3776-3781
  // (INFO_UNIT_IS_SPECIALIZED / INFO_UNIT_IS_NOT_SPECIALIZED) -- copy DF's words, do not write our
  // own. Two states = two DIFFERENT sprites (green OPEN padlock vs red CLOSED padlock), which is
  // exactly what DWFUI.latchHtml is for; its own spec already lists "the residents-row
  // specialization hammer" as one of its five intended consumers. The write is the SAME endpoint the
  // Labor tab has POSTed since it shipped: /labor-specialist (src/labor.cpp:538,731). This wave adds
  // no new write surface -- it puts the existing one where DF puts it.
  //
  // The two captions are NAMED CONSTANTS assigned straight to `title:` on purpose. The help-corpus
  // extractor harvests `title: "literal"` and `title: NAMED_CONST` but CANNOT see a title built by a
  // ternary (help_corpus_extractor.mjs:104-121) -- which is why the Labor tab's identical padlock,
  // written as `title: r.specialist ? "..." : "..."`, has never appeared in the in-game "?" help
  // reference at all. Written this way, both states of this control DO.
  const SPEC_TIP_SPECIALIZED = "This worker is specialized and will only do tasks that match their workshop assignments, work details, and occupations. Click to toggle.";
  const SPEC_TIP_NOT_SPECIALIZED = "This worker is not specialized and will do any free tasks that become available. Click to toggle.";
  function residentSpecLatchHtml(unitId, state) {
    const ui = D();
    if (!ui || !state.known) return "";
    const cfg = {
      cls: "creature-spec", on: state.specialized, size: 22,
      sprite: ui.TOKENS.sprites.workerAny, activeSprite: ui.TOKENS.sprites.workerOnly,
      dataset: { residentSpec: unitId, spec: state.specialized ? 1 : 0 }, hotkey: "Ctrl+z",
      title: SPEC_TIP_NOT_SPECIALIZED,
    };
    if (state.specialized) cfg.title = SPEC_TIP_SPECIALIZED;
    return ui.latchHtml(cfg);
  }

  // WORK_DETAILS. One native tile per work detail the dwarf is assigned to, in the server's order.
  // A detail whose icon is NONE draws NOTHING (DF draws nothing) but still names itself in the
  // cell's tooltip, so no information is lost and no tile is invented. A dwarf on no detail gets an
  // empty cell -- which is exactly what the oracle's mason rows show.
  function creatureWorkDetailsHtml(state) {
    const ui = D();
    if (!ui || !state.known || !state.details.length) return "";
    const tiles = state.details
      .map(d => ({ d, token: ui.workDetailSprite(d.icon) }))
      .filter(x => x.token)
      .map(x => ui.iconHtml({ sprite: x.token, size: 22, cls: "creature-workdetail-icon",
        title: x.d.name, alt: x.d.name }))
      .join("");
    const title = state.details.map(d => d.name).join(", ");
    return `<span class="creature-workdetails" title="${escapeHtml(title)}">${tiles}</span>`;
  }

  // B296 ACTIVITY_DETAILS. The native five-cell cluster in the oracle belongs to the current
  // workshop job: active indicator, repeat, priority, suspend/resume, cancel. Repeat/priority/
  // suspend reuse /workshop-job-action; the final remove tile reuses /task-cancel.
  //
  // The reviewed stockpile-hauling pair is a separate native path. DF's generated hover metadata
  // establishes UNITLIST_RECENTER_JOB as "recenter on the task's building"; the server therefore
  // sends the real stockpile-holder center along with the existing cancellable job id. Preserve the
  // oracle's exact-label quirk: "Store item in barrel" gets no pair even if malformed input carries
  // a target. Socialize/Worship's magnifier is INFO_ACTIVITY_DETAILS ("View a detailed description
  // of this activity"), NOT recenter; it remains absent until native detail text/action is served.
  function residentJobControlsHtml(row) {
    const ui = D();
    const jobId = Number(row?.jobId ?? -1);
    if (!ui || !Number.isInteger(jobId) || jobId < 0)
      return `<span class="creature-job-controls" aria-hidden="true"></span>`;
    const buildingId = Number(row?.jobBuildingId ?? -1);
    const S = ui.TOKENS.sprites;
    if (!Number.isInteger(buildingId) || buildingId < 0) {
      const label = residentJobText(row);
      const pos = {
        x: Number(row?.jobX), y: Number(row?.jobY), z: Number(row?.jobZ),
      };
      const hasJobPos = row?.jobHasPos === true && Object.values(pos).every(Number.isFinite);
      if (label !== "Store item in stockpile" || !hasJobPos)
        return `<span class="creature-job-controls" aria-hidden="true"></span>`;
      return `<span class="creature-job-controls">` +
        ui.actionButtonsHtml([
          { action: "recenterJob", sprite: S.recenter,
            dataset: { residentJobCenter: "", residentJobX: pos.x,
              residentJobY: pos.y, residentJobZ: pos.z },
            title: "Recenter on the task's building" },
          { action: "cancel", sprite: S.jobRemoveWorker,
            dataset: { infoCancelJob: jobId }, title: "Cancel this task" },
        ], { cls: "resident-job-actions resident-hauling-actions",
          ariaLabel: "Stockpile hauling task actions" }) + `</span>`;
    }
    const data = action => ({ residentJob: jobId, residentJobBuilding: buildingId,
      residentJobAction: action });
    return `<span class="creature-job-controls">` +
      ui.actionButtonsHtml([{ action: "status", sprite: S.jobActive, disabled: true,
        title: row.jobSuspended ? "Task is suspended" : "Task is active" }],
        { cls: "resident-job-actions resident-job-status", ariaLabel: "Current job status" }) +
      ui.latchHtml({ on: !!row.jobRepeat, cls: "resident-job-repeat", sprite: S.repeat,
        activeSprite: S.repeatOn, dataset: data("repeat"), title: "Toggle repeat", ariaLabel: "Toggle repeat" }) +
      ui.actionButtonsHtml([{ action: "priority", sprite: S.jobDoNow,
        activeSprite: S.jobDoNowOn, active: !!row.jobDoNow,
        dataset: data("priority"), title: row.jobDoNow ? "Remove priority (do now)" : "Make priority (do now)" }],
        { cls: "resident-job-actions", ariaLabel: "Current job priority" }) +
      ui.latchHtml({ on: !!row.jobSuspended, cls: "resident-job-suspend", sprite: S.suspend,
        activeSprite: S.suspendOn, dataset: data(row.jobSuspended ? "resume" : "suspend"),
        title: row.jobSuspended ? "Resume task" : "Suspend task",
        ariaLabel: row.jobSuspended ? "Resume task" : "Suspend task" }) +
      ui.actionButtonsHtml([{ action: "cancel", sprite: S.cancelJob,
        dataset: { infoCancelJob: jobId }, title: "Remove task" }],
        { cls: "resident-job-actions", ariaLabel: "Remove current job" }) + `</span>`;
  }

  function creatureRowsMarkup(rows, options = {}) {
    const source = Array.isArray(rows) ? rows : [];
    const needle = String(options.search || "").trim();
    const filtered = needle ? source.filter(row => dfTokenMatch(creatureRowSearchText(row), needle)) : source;
    const sortKey = options.sortKey || "name";
    const sortDir = Number(options.sortDir) === -1 ? -1 : 1;
    const shown = sortKey ? filtered.slice().sort((a, b) => compareCreatureRows(a, b, sortKey, sortDir)) : filtered;
    if (!shown.length)
      return `<div class="info-message">${source.length ? "No matches." : ""}</div>`;
    const isResidentsList = (options.detail || "") === "residents";
    return `
      ${creatureSortHead(sortKey, sortDir, isResidentsList)}
      <div class="info-table">
        ${shown.map(row => {
          const isResidents = (options.detail || "") === "residents";
          const jobText = isResidents ? residentJobText(row) : (row.status || row.job || "");
          const tone = rowTone(jobText);
          const pos = infoRowPos(row);
          const nameColor = professionColorStyle(row);
          const unitId = Number(row.unitId ?? -1);
          const memorial = memorialButtonSpec(row, options.detail || "");
          // B254: SPECIALIZED + WORK_DETAILS are members of the RESIDENTS unit_list only. Native
          // does not pass those options for Pets/Other/Dead, and neither do we. The other tabs keep
          // the held-item cell they already had (a separate, still-open question -- see the B254
          // report; DF has no held-item column anywhere, but retiring it there needs its own oracle).
          const labor = isResidents ? residentLaborState(row, options.labor || null) : null;
          if (isResidents) {
            const ui = D();
            const identity = residentNameProfession(row);
            const identityHtml = ui ? ui.bitmapTextHtml(identity, { cls: "creature-identity-text" }) : escapeHtml(identity);
            const jobHtml = ui ? ui.bitmapTextHtml(jobText, { cls: "creature-job-bitmap" }) : escapeHtml(jobText);
            return `
              <div class="info-row creature-row resident-row${unitId >= 0 ? " clickable" : ""}${row.muted ? " info-muted" : ""}"
                data-unit-id="${escapeHtml(unitId)}"
                ${pos ? `data-pos-x="${escapeHtml(pos.x)}" data-pos-y="${escapeHtml(pos.y)}" data-pos-z="${escapeHtml(pos.z)}"` : ""}>
                ${unitPortraitMarkup(row, "info-portrait-small")}
                <div class="creature-identity"${nameColor}>${identityHtml}</div>
                ${creatureRowActionsHtml(row, memorial, pos)}
                <div class="creature-job-text"${residentJobColorStyle(row)}>${jobHtml}</div>
                ${residentJobControlsHtml(row)}
                <span class="creature-activity-details" aria-hidden="true"></span>
                <span class="creature-mood-slot" data-mood-slot="${Number(row.moodCategory ?? -1)}"></span>
                ${residentSpecLatchHtml(unitId, labor)}
                ${creatureWorkDetailsHtml(labor)}
              </div>`;
          }
          return `
            <div class="info-row creature-row${unitId >= 0 ? " clickable" : ""}${row.muted ? " info-muted" : ""}"
              data-unit-id="${escapeHtml(unitId)}"
              ${pos ? `data-pos-x="${escapeHtml(pos.x)}" data-pos-y="${escapeHtml(pos.y)}" data-pos-z="${escapeHtml(pos.z)}"` : ""}>
              ${unitPortraitMarkup(row, "info-portrait-small")}
              <div class="info-name-main"${nameColor}>${escapeHtml(row.name || "")}</div>
              ${creatureSexGlyphHtml(row)}
              ${creatureRowActionsHtml(row, memorial, pos)}
              <div>${escapeHtml(row.category || "")}</div>
              <div>${escapeHtml(row.profession || "")}</div>
              <div class="creature-job-cell">
                ${jobText ? `<div class="info-status ${tone}">${escapeHtml(jobText)}</div>` : ""}
                <span class="creature-mood-slot" data-mood-slot="${Number(row.moodCategory ?? -1)}"></span>
                ${labor ? residentSpecLatchHtml(unitId, labor) : ""}
                ${labor ? creatureWorkDetailsHtml(labor) : creatureHeldItemHtml(row)}
              </div>
              ${livestockActionsHtml(row, options.detail || "", options.trainers || [])}
            </div>`;
        }).join("")}
      </div>`;
  }

  function creatureRowsHtml() {
    return creatureRowsMarkup(creatureRowsRaw, {
      search: creatureSearch, sortKey: creatureSortKey, sortDir: creatureSortDir,
      detail: activeInfoDetail, trainers: creatureTrainers, labor: creatureLabor,
    });
  }

  // B254 old-DLL fallback fetch. In flight at most once at a time; a failure leaves creatureLabor
  // null, which makes residentLaborState() report known:false and the row render no padlock.
  let creatureLaborInFlight = false;
  async function fetchCreatureLaborFallback() {
    if (creatureLaborInFlight) return;
    creatureLaborInFlight = true;
    try {
      const res = await fetch("/labor", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      creatureLabor = (Array.isArray(data?.rows) && Array.isArray(data?.details)) ? data : null;
    } catch (_) {
      creatureLabor = null;
    }
    creatureLaborInFlight = false;
    if (activeInfoPanel === "citizens" && activeInfoDetail === "residents") renderCreatureBody();
  }

  function renderCreatureBody() {
    const main = clientPanel.querySelector(".info-main");
    if (!main) return;
    // B32: warm the composite-sprite snapshot so on/just-off-screen creature rows show sprites.
    if (typeof refreshUnitSpriteSnapshot === "function") refreshUnitSpriteSnapshot();
    main.innerHTML = `${creatureMessageHtml}${creatureRowsHtml()}`;
    wireCreatureBody(main);
  }

  function wireCreatureBody(root) {
    const scope = root || clientPanel;
    scope.querySelectorAll("[data-mood-slot]").forEach(slot => {
      const cat = Number(slot.dataset.moodSlot);
      if (!Number.isFinite(cat) || cat < 0 || !window.DFChrome) return;
      const icon = window.DFChrome.icon(`BUTTON_STRESS_${cat}`, 18);
      icon.className = "creature-mood-icon";
      slot.replaceWith(icon);
    });
    scope.querySelectorAll("[data-creature-sort]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const key = button.dataset.creatureSort;
      if (creatureSortKey === key) creatureSortDir = -creatureSortDir; else { creatureSortKey = key; creatureSortDir = 1; }
      renderCreatureBody();
      focusPage();
    }));
    scope.querySelectorAll("[data-unit-id]").forEach(row => row.addEventListener("click", event => {
      // B254: the padlock's hook replaces the retired labor-shortcut hook in this guard. Without an
      // entry here a click on the padlock would ALSO bubble to the row and open the unit sheet on
      // top of the toggle -- the control has to be able to eat its own click.
      if (event.target.closest("[data-info-open], [data-info-center], [data-info-cancel-job], [data-resident-job-center], [data-resident-job], [data-resident-spec], [data-memorial-slab]")) return;
      event.preventDefault(); event.stopPropagation();
      const id = Number(row.dataset.unitId);
      if (Number.isInteger(id) && id >= 0) openUnitById(id);
    }));
    scope.querySelectorAll("[data-info-open]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const row = button.closest(".info-row");
      const id = Number(row?.dataset.unitId ?? -1);
      if (Number.isInteger(id) && id >= 0) openUnitById(id);
    }));
    scope.querySelectorAll("[data-info-center]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const row = button.closest(".info-row");
      const pos = { x: Number(row?.dataset.posX), y: Number(row?.dataset.posY), z: Number(row?.dataset.posZ) };
      if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))
        await centerAndFlashMapPos(pos);
    }));
    scope.querySelectorAll("[data-resident-job-center]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const pos = { x: Number(button.dataset.residentJobX), y: Number(button.dataset.residentJobY),
        z: Number(button.dataset.residentJobZ) };
      if (Object.values(pos).every(Number.isFinite))
        await centerAndFlashMapPos(pos);
    }));
    scope.querySelectorAll("[data-info-cancel-job]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const jobId = Number(button.dataset.infoCancelJob);
      if (!Number.isInteger(jobId) || jobId < 0 || button.disabled) return;
      button.disabled = true;
      try {
        await fetch(`/task-cancel?player=${encodeURIComponent(player)}&job=${jobId}&t=${Date.now()}`,
          { method: "POST", cache: "no-store" });
      } catch (_) {}
      openPanel(activeInfoPanel || "citizens", activeInfoSection || "creatures", activeInfoDetail || "residents");
    }));
    scope.querySelectorAll("[data-resident-job]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const jobId = Number(button.dataset.residentJob);
      const buildingId = Number(button.dataset.residentJobBuilding);
      const action = String(button.dataset.residentJobAction || "");
      if (!Number.isInteger(jobId) || jobId < 0 || !Number.isInteger(buildingId) || buildingId < 0 || !action || button.disabled) return;
      button.disabled = true;
      const query = new URLSearchParams({ id: String(buildingId), job: String(jobId), action });
      try {
        await fetch(`/workshop-job-action?${query}`, { method: "POST", cache: "no-store" });
      } catch (_) {}
      openPanel(activeInfoPanel || "citizens", activeInfoSection || "creatures", activeInfoDetail || "residents");
    }));
    scope.querySelectorAll("[data-memorial-slab]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const id = Number(button.dataset.memorialSlab);
      if (!Number.isInteger(id) || id < 0) return;
      button.disabled = true;
      try {
        const r = await fetch(`/memorial-slab?player=${encodeURIComponent(player)}&unit=${id}&t=${Date.now()}`, {
          method: "POST", cache: "no-store"
        });
        const text = await r.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_) {}
        if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "Could not queue memorial slab.");
        creatureMessageHtml = `<div class="info-message">Memorial slab order queued.</div>`;
      } catch (err) {
        creatureMessageHtml = `<div class="info-message">${escapeHtml(err.message || "Could not queue memorial slab.")}</div>`;
      }
      renderCreatureBody();
      focusPage();
    }));
    // B254: the SPECIALIZED padlock. One POST to the endpoint the Labor tab has always used, then
    // patch the cached row and repaint -- no full panel re-fetch, so scroll/search/sort survive the
    // click (same pattern as the livestock buttons below). The button is optimistic-then-corrected:
    // on failure it reverts and says so, because a padlock that lies about a dwarf's state is the
    // one outcome worse than a padlock that refuses.
    scope.querySelectorAll("[data-resident-spec]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      if (button.disabled) return;
      const id = Number(button.dataset.residentSpec);
      if (!Number.isInteger(id) || id < 0) return;
      const next = button.dataset.spec === "1" ? 0 : 1;
      button.disabled = true;
      try {
        const res = await fetch(`/labor-specialist?unit=${id}&on=${next}`, { method: "POST", cache: "no-store" });
        if (!res.ok) throw new Error((await res.text()).trim() || "the game refused the change");
        // Patch BOTH sources of truth so the repaint agrees with the server whichever wire fed it.
        const row = creatureRowsRaw.find(rw => Number(rw.unitId ?? -1) === id);
        if (row && Object.prototype.hasOwnProperty.call(row, "specialized")) row.specialized = !!next;
        const lrow = Array.isArray(creatureLabor?.rows)
          ? creatureLabor.rows.find(r => Number(r?.id ?? -1) === id) : null;
        if (lrow) lrow.specialist = !!next;
        creatureMessageHtml = "";
      } catch (err) {
        creatureMessageHtml = `<div class="info-message">${escapeHtml(err.message || "Could not change specialization.")}</div>`;
      }
      renderCreatureBody();
    }));
    // B16: livestock action buttons (Slaughter / War / Hunt / Make pet). POST the toggle, then
    // patch the row's cached livestock state from the response and re-render so the button flips
    // without a full panel re-fetch (which would reset scroll/search).
    scope.querySelectorAll("[data-livestock-action]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const id = Number(button.dataset.livestockUnit);
      const action = button.dataset.livestockAction;
      if (!Number.isInteger(id) || id < 0 || !action) return;
      button.disabled = true;
      try {
        const r = await fetch(`/livestock-action?player=${encodeURIComponent(player)}&unit=${id}&action=${encodeURIComponent(action)}&t=${Date.now()}`,
          { method: "POST", cache: "no-store" });
        if (r.ok) {
          const res = await r.json();
          if (res && res.livestock) {
            const row = creatureRowsRaw.find(rw => Number(rw.unitId ?? -1) === id);
            if (row) row.livestock = res.livestock;
            renderCreatureBody();
          }
        }
      } catch (_) {}
      focusPage();
    }));

    // B33: specific-trainer dropdown -- POST assign-trainer with the chosen dwarf id (-1 = any),
    // then patch the cached livestock state so the row re-renders in place. Clicks on the select are
    // stopped so opening it doesn't also open the unit sheet (the row is clickable).
    scope.querySelectorAll("[data-trainer-select]").forEach(select => {
      select.addEventListener("click", event => event.stopPropagation());
      select.addEventListener("change", async event => {
        event.preventDefault(); event.stopPropagation();
        const id = Number(select.dataset.livestockUnit);
        const trainer = Number(select.value);
        if (!Number.isInteger(id) || id < 0 || !Number.isInteger(trainer)) return;
        select.disabled = true;
        try {
          const r = await fetch(`/livestock-action?player=${encodeURIComponent(player)}&unit=${id}&action=assign-trainer&trainer=${trainer}&t=${Date.now()}`,
            { method: "POST", cache: "no-store" });
          if (r.ok) {
            const res = await r.json();
            if (res && res.livestock) {
              const row = creatureRowsRaw.find(rw => Number(rw.unitId ?? -1) === id);
              if (row) row.livestock = res.livestock;
              renderCreatureBody();
            }
          }
        } catch (_) {}
        focusPage();
      });
    });
  }

  // Open the DF-style item window for a loose item on the ground (clicked on the map).
  // Uses the read-only "info" action so opening the panel doesn't move the camera or toggle flags.
  async function openItemPanel(id, siblings) {
    try {
      const r = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${id}&action=info&t=${Date.now()}`,
        { method: "POST", cache: "no-store" });
      // ITEMSHEET-PARITY: `siblings` (co-located loose items on the clicked tile, from the
      // tile-list chooser) become side-tabs on the one sheet -- pass them through so tabbing
      // between items on a crowded tile never reopens the chooser.
      if (r.ok) { showStockItemSheet(await r.json(), { siblings: Array.isArray(siblings) ? siblings : null }); return; }
    } catch (_) {}
    closeSelection();
  }

  // ITEMSHEET-PARITY (oracles: MOS/item sheets/steam barrel-bin contents sheet.png, the binding
  // CONTAINER oracle; MOS/item sheet flags active.png, the binding ACTIVE-FLAG oracle): the stock
  // item sheet rebuilt on the DWFUI component layer to native parity.
  //
  // *** WAVE 4 / S4 GAP-1 CLOSED: itemArtTile() IS GONE. *** It was a FIFTH, uncoordinated art
  // channel whose fallback was a SILENT LETTER -- the "all item icons are letters in browser right
  // now inside this menu". DWFUI now owns the item channel (`iconHtml({item: spriteRef})` ->
  // paintItemSprites, blitted from /sprites/img/<sheet> through DwfTiles.resolveItemSpriteRef,
  // the SAME resolver, now called once). An absent or unresolvable ref FAILS LOUD --
  // `data-df-identity-missing` + the native empty tile -- and NEVER degrades to a letter; iconHtml
  // THROWS if you pass `item` and `letter` together, so the fallback cannot be reinstated here.
  //
  // DATA GAPS (fail-open/fail-loud, never guessed). TWO OF THE THREE ARE NOW CLOSED BY THE C++ WIRE
  // BATCH (`dwf-wire-batch-W4-20260712`, src/interaction.cpp:1263-1345 -- deployed and live):
  //   * CLOSED -- the location row's art. The wire now sends `locationSpriteToken` (a STOCKPILE_ICON_*
  //     INTERFACE token, derived from the pile's stockpile_group_set) and `locationSpriteRef` (an ITEM
  //     ref, for when the location is a container). They never both apply; the row reads whichever the
  //     wire supplied. The FAIL-LOUD path is UNCHANGED and still live: neither channel => native empty
  //     tile + data-df-identity-missing, never a letter.
  //   * CLOSED -- `following`, so the camera tool takes its _ACTIVE (green) sprite. The ACTIVE look is
  //     the SPRITE VARIANT, never a CSS highlight we add.
  //   * STILL OPEN -- `opts.siblings` (co-located items) carry no sprite refs, so the co-located strip
  //     stays on the text-tab paint -- see the COMPONENT-GAP in the S4 closeout. It is WIRED and native
  //     HAS the control, so it is KEPT, not deleted.
  //
  // A FIXTURE THAT PREDATES A WIRE BATCH IS A LIE ABOUT THE SERVER, and it is what made this tile read
  // `MISSING SPRITE` in the Studio long after the server had started sending the art. The Studio
  // fixtures are held to the SERIALISER: wave4_info_stocks_test parses src/interaction.cpp and asserts
  // tools/ui-lab/fixtures/stock-item-sheet.json carries the fields the C++ actually emits.
  // (D() is declared once, at the top of this module -- see the Node/browser note there.)
  // Native's meta row is a VARIABLE FIELD LIST, not a fixed Weight+Value pair: `item sheet flags
  // active.png` shows `Weight:` with NO `Value:` at all, and the container oracle shows both on ONE
  // gold line with WEIGHT FIRST. Render the fields that are present, in native order; never blank one.
  //
  // B236 (07-14, ITEMSHEET-oracle-native.png): the fields carry NATIVE UNIT GLYPHS -- `Weight: 22Γ`
  // and `Value: ~20☼`. Γ (U+0393) and ☼ (U+263C) are DF's own weight/value marks; glyph_font_test:380-381
  // pins both to the traced face's CP437 cells, so they paint as the oracle's exact pixels. The live
  // wire sends the bare number (item_weight_text, src/interaction.cpp:182-195), so the glyph is
  // PRESENTATION, appended here -- and never doubled if a future wire ships it (endsWith guard).
  //
  // ---- `Material:` IS GONE FROM THE META ROW (B236 supersedes the W4-R2 fallback). --------------
  // R2 had parked `Material:` beside Weight/Value on the explicit fallback ruling ("if the logic of
  // material is too confusing ... move the material:alder wood next to weight and value"). B236's
  // paired oracle settles what R2 lacked evidence for: the native bed sheet shows Weight and Value
  // ONLY -- native has NO Material field anywhere, because the material is already in the title
  // (`*apricot wood bed*`) and in the prose (`This is a superior quality apricot wood bed.`).
  // DELETION LEDGER: the `Material:` field is dropped; the information survives on the sheet twice
  // (title + prose, both composed by DF/the prose bridge below). The title itself stays byte-for-byte
  // what the wire sends -- the R2 ban on inventing title-material logic is NOT reopened.
  function itemMetaLine(result) {
    const fields = [];
    if (result?.weight) {
      const weight = String(result.weight);
      fields.push(`Weight: ${escapeHtml(weight.endsWith("Γ") ? weight : weight + "Γ")}`);
    }
    if (Number.isFinite(Number(result?.value))) fields.push(`Value: ~${escapeHtml(result.value)}☼`);
    return fields.length
      ? `<div class="unit-meta-line stock-item-weight">${fields.join("&nbsp;&nbsp;&nbsp;")}</div>` : "";
  }
  // ---- B236: THE NATIVE PROSE SENTENCE -- a CLIENT BRIDGE over a proven wire gap. ---------------
  // Native writes a sentence (`This is a superior quality apricot wood bed.` -- the B236 oracle;
  // `This is a tower-cap splint.` -- steam single-item sheet.png; `This is pig tail cloth.` --
  // item sheet flags active.png). The wire does NOT carry it: `description` is
  // Items::getReadableDescription (src/interaction.cpp:1097), which dfhack Items.cpp:750-774 builds
  // as the DECORATED DISPLAY NAME -- i.e. exactly `title` for anything that is not a book/artifact/
  // unit-container. That echo is what rendered `*apricot wood bed*` as the "description" in
  // ITEMSHEET-broken-ours.png. The sentence's INGREDIENTS are on the wire, though: the quality affix
  // on the title maps to native's adjective (both mappings below are oracle-pinned: `+..+` ->
  // "finely-crafted", `*..*` -> "superior quality"), and the stripped title is the name native uses.
  //
  // THE BRIDGE ONLY FIRES ON THE ECHO (description === title / absent). The DLL half composes the
  // real sentence server-side with DF's OWN article logic (item vmethod add_article_to_string,
  // df.item.xml:897-900) -- the moment it ships, description !== title and the wire text renders
  // VERBATIM, including sentences this bridge cannot know ("The material is gray. It is coated
  // with water." -- the flags-active oracle).
  //
  // WHAT THE BRIDGE REFUSES TO INVENT (fail-safe, not guessed):
  //   * the article for a MASS NOUN: the flags-active oracle proves cloth takes none ("This is pig
  //     tail cloth."), so the known mass-noun item types are articled with "" -- never "a cloth".
  //   * the article for a STACK (`... [2]`): no oracle shows a stack's sheet; composed without an
  //     article rather than fabricating "a prickle berries". Screenshot requested from the owner.
  //   * artifacts/books: getReadableDescription already diverges from the title for those, so the
  //     bridge never sees them -- the wire text renders as-is.
  const QUALITY_ADJECTIVE = {
    "-": "well-crafted",       // dfhack Items.cpp addQuality marks: ["", -, +, *, ≡, ☼]
    "+": "finely-crafted",     // oracle-pinned (steam barrel-bin contents sheet.png)
    "*": "superior quality",   // oracle-pinned (ITEMSHEET-oracle-native.png)
    "≡": "exceptional",
    "☼": "masterful",
  };
  // Non-quality symmetric wrappers DF decorates names with (dfhack Items.cpp:700-728): forbid {},
  // foreign (), improvement «» (and its <</>> wire form), wear x..x / X..X / XX..XX. All stripped
  // from the prose name -- the oracles show the sentence undecorated ((tower-cap splint) -> "This
  // is a tower-cap splint.") -- while the TITLE keeps every mark verbatim.
  const NEUTRAL_WRAP = new Set(["{}", "()", "<>", "«»", "xx", "XX"]);
  const MASS_NOUN_TYPES = new Set(["CLOTH", "THREAD", "LIQUID_MISC", "POWDER_MISC", "GLOB", "MEAT"]);
  function nativeItemProse(result, title) {
    let name = String(title || "").trim();
    let quality = "";
    for (;;) {
      if (name.length > 4 && name.startsWith("XX") && name.endsWith("XX")) {
        name = name.slice(2, -2); continue;                    // tattered wear, double-X wrap
      }
      if (name.length < 3) break;
      const head = name[0], pair = head + name[name.length - 1];
      if (head === name[name.length - 1] && QUALITY_ADJECTIVE[head]) {
        quality = QUALITY_ADJECTIVE[head]; name = name.slice(1, -1); continue;
      }
      if (NEUTRAL_WRAP.has(pair)) { name = name.slice(1, -1); continue; }
      break;
    }
    name = name.trim();
    if (!name) return "";
    const mass = MASS_NOUN_TYPES.has(String(result?.spriteRef?.itemType || ""));
    const stack = /\]\s*$/.test(name);                         // "... [N]" -- no article invented
    const first = (quality || name).charAt(0).toLowerCase();
    const article = (mass || stack) ? "" : (/[aeiou]/.test(first) ? "an " : "a ");
    return `This is ${article}${quality ? quality + " " : ""}${name}.`;
  }
  function stockItemSheetMarkup(result, opts) {
    const ui = D();
    const options = opts || {};
    const siblings = Array.isArray(options.siblings) ? options.siblings.filter(s =>
      s && Number.isFinite(Number(s.id)) && Number(s.id) >= 0) : [];
    const title = result?.title || "Item";
    const lines = Array.isArray(result?.lines) ? result.lines : [];
    // B236: the wire's description is trusted VERBATIM when it is a real sentence; when it is the
    // getReadableDescription echo of the title (today's live wire -- see the bridge note above),
    // the native prose is composed from the title's own quality affix + name.
    const wireDescription = String(result?.description || lines[0] || "").trim();
    const description = wireDescription && wireDescription !== String(title).trim()
      ? wireDescription
      : (nativeItemProse(result, title) || wireDescription);
    const holder = result?.holderUnit || null;
    const owner = result?.ownerUnit || null;
    const unit = holder || owner;
    const hasMapPos = result?.mapPos &&
      Number.isFinite(Number(result.mapPos.x)) &&
      Number.isFinite(Number(result.mapPos.y)) &&
      Number.isFinite(Number(result.mapPos.z));
    const contents = Array.isArray(result?.contents) ? result.contents : [];
    const S = ui ? ui.TOKENS.sprites : null;
    // Header tool cluster -- NATIVE SPRITES, NOT EMOJI, and TWO BANDS. Both oracles agree:
    //   row 1: [forbid][dump] ... [hide]
    //   row 2: [camera], ALONE and RIGHT-ALIGNED on a second line beneath the hide
    // That is exactly `headerHtml({toolRows})` (DWFUI's banded cluster; `.dwfui-head-tools--rows` is
    // a right-aligned column). It MUST come from the FACTORY: string-writing DWFUI's own structural
    // markup into a rendered class attribute is R2 drift and ui_drift_guard_test rejects it.
    //
    // THE ACTIVE LOOK IS THE `_ACTIVE` SPRITE VARIANT, NOT A CSS HIGHLIGHT. `item sheet flags
    // active.png` shows the latched camera as a GREEN-FILLED TILE -- that green is baked into
    // UNIT_SHEET_CAMERA_ACTIVE, exactly as STOCKS_{FORBID,DUMP,HIDE}_ACTIVE bake in theirs. The tile
    // is SWAPPED, never tinted; css:6336-6343 also strips the generic box and the `.active` fill off
    // a self-framed native cell, so DF's own art is the only thing that changes.
    // Every data-item-toggle / data-item-follow hook is preserved: the wiring below is unchanged.
    const flagTitle = (on, onTitle, offTitle) => (on ? onTitle : offTitle);
    const toolRows = ui ? [
      [
        { sprite: result?.forbidden ? S.forbidOn : S.forbid, active: !!result?.forbidden,
          dataset: { itemToggle: "forbid" },
          title: flagTitle(result?.forbidden, "Unforbid item", "Forbid item") },
        { sprite: result?.dump ? S.dumpOn : S.dump, active: !!result?.dump,
          dataset: { itemToggle: "dump" },
          title: flagTitle(result?.dump, "Cancel dump", "Mark for dumping") },
        // B236: the eye is SET APART from the two destructive flags -- [forbid][dump] .. gap ..
        // [hide] (ITEMSHEET-oracle-native.png), the same native gap ITEM_ACTION_PRESET already
        // encodes for the contents rows. `gapBefore` rides the header path (W4/S4 GAP-B).
        { sprite: result?.hidden ? S.hideOn : S.hide, active: !!result?.hidden,
          gapBefore: true, dataset: { itemToggle: "hide" },
          title: flagTitle(result?.hidden, "Show item", "Hide item") },
      ],
      [
        { sprite: result?.following ? S.cameraOn : S.cameraOff, active: !!result?.following,
          disabled: !hasMapPos, dataset: { itemFollow: "" },
          title: hasMapPos ? "Move camera to this item" : "No map location",
          ariaLabel: "Move camera to this item" },
      ],
    ] : null;
    // Native item sheets own no close X. This selection variant is explicitly ESC-only, so
    // PanelFrame adopts the skin header without generating replacement chrome.
    const header = ui ? ui.headerHtml({
      cls: "stock-item-header",
      icon: ui.iconHtml({ item: result?.spriteRef, cls: "stock-item-glyph", size: 32, alt: title }),
      titleHtml: `<div class="stock-item-title">${escapeHtml(title)}</div>${itemMetaLine(result)}`,
      titleCls: "stock-item-headcopy",
      toolRows,
      close: false,
    }) : "";
    // Location row (oracle: stockpile art tile + name, right-aligned "View stockpile").
    //
    // `chassis:'slab'` -- The owner: "the view stockpile button is a green background not gray ... Its gray
    // background green text", and "It has no hover state in native i just checked ... right now it
    // has a weird click state that lights up, thats not native." Measured in the container oracle:
    // bg #4e474e (= --dwfui-slab), text #14ff6d (= --dwfui-text-good). This is the SHARED slab-plaque
    // variant, not an item-sheet override -- the same control with the same two colours is native's
    // `Create new squad` (Squad Menu UI/1. Squad Menu.PNG), which consumes the same variant. The
    // BUTTON AND ITS WIRE ARE UNTOUCHED: data-stock-item-place still opens the stockpile. Only the
    // invented paint (green fill, hover lift, lit click) goes.
    const locId = Number(result?.locationId ?? -1);
    const locBtn = ui && Number.isFinite(locId) && locId >= 0
      ? ui.plaqueBtnHtml({ label: "View stockpile", tone: "green", chassis: "slab",
          cls: "stock-item-loc-btn", dataset: { stockItemPlace: locId }, title: "Open this stockpile" })
      : "";
    // THE LOCATION TILE HAS TWO ART CHANNELS, AND THE WIRE PICKS WHICH ONE APPLIES.
    // src/interaction.cpp:1276-1288 (wire batch dwf-wire-batch-W4-20260712) serialises BOTH,
    // and documents that THEY NEVER BOTH APPLY:
    //   `locationSpriteToken`  an INTERFACE token, "STOCKPILE_ICON_*" (DF's own stockpile-sign art,
    //                          derived from the pile's stockpile_group_set -- interaction.cpp:192-228).
    //                          "" when the location is not a stockpile.
    //   `locationSpriteRef`    an ITEM ref {itemType,itemSubtype,materialType,materialIndex} for when
    //                          the location is a CONTAINER (a bin/barrel). null when it is not an item.
    // A stockpile's sign is INTERFACE art, not item art, so routing it through the item channel could
    // never have resolved it -- the tile was reading `locationSpriteRef` alone, which is null for
    // every stockpile, and correctly failed loud. THE FAIL-LOUD GUARD IS NOT TOUCHED: when the wire
    // sends neither channel we still hand `item: undefined` to iconHtml, which keeps `hasItem` true
    // (it tests PRESENCE, not truthiness), renders the native empty tile and stamps
    // `data-df-identity-missing`. It NEVER degrades to a letter, and it is never silenced.
    const locToken = typeof result?.locationSpriteToken === "string" ? result.locationSpriteToken : "";
    // B236: THE ROW RENDERS ONLY FOR A REAL PLACE -- a stockpile (id / token channel) or a container
    // (item-ref channel). `item sheet flags active.png` shows an item in neither: native draws NO
    // row in that region at all, and ITEMSHEET-broken-ours.png's blank-tile "On map" row is the
    // debug panel B236 kills. Nothing wired is lost: the camera tool still carries the go-to-map
    // capability, and the fail-loud missing-art guard is untouched for rows that DO render (a pile
    // id with neither art channel still paints the marked empty tile -- wave4 R3).
    const isPileRow = locBtn !== "" || locToken !== "";
    const hasLocationRow = !!result?.location && (isPileRow || result?.locationSpriteRef);
    // Native prints the BARE pile name (`Stockpile #1`, `Food Stockpile #6`); the holder-building
    // wire path (src/interaction.cpp:293-295) still says "In <name>", so the prefix is dropped on
    // stockpile rows only. Container rows keep the wire text -- no bare-name oracle for them yet.
    const locName = isPileRow ? String(result?.location || "").replace(/^In /, "") : result?.location;
    const locIcon = { cls: "stock-item-loc-icon", size: 30, alt: locName };
    const locationRow = ui && hasLocationRow ? ui.rowHtml({
      cls: "stock-item-loc-row",
      iconCfg: locToken
        ? Object.assign({ sprite: locToken }, locIcon)
        : Object.assign({ item: result?.locationSpriteRef }, locIcon),
      copyCls: "stock-item-loc-copy", labelCls: "stock-item-loc-name", label: locName,
      trailing: locBtn,
    }) : "";
    // Contents rows (container oracle): item sprite | name | [view][forbid][dump] · [hide] on the
    // native TABLE chassis (the diagonal hatch). The cluster is DWFUI's `preset:'itemActions'` --
    // ITEM_ACTION_PRESET is byte-for-byte the native order and gap, so it is never re-listed. ONE
    // ROW PER CONTAINED ITEM STACK: native repeats names and does NOT aggregate or dedupe.
    const contentRow = c => ui.rowHtml({
      cls: "stock-item-content-row", chassis: "table", dataset: { stockItemRow: c.id },
      iconCfg: { item: c.spriteRef, cls: "stock-item-content-icon", size: 32, alt: c.name },
      copyCls: "stock-item-content-copy", labelCls: "stock-item-content-name", label: c.name,
      trailing: ui.actionButtonsHtml([
        { dataset: { stockContentAction: "view", stockContentId: c.id }, title: "View this item" },
        { active: !!c.forbidden, dataset: { stockContentAction: "forbid", stockContentId: c.id }, title: "Forbid / unforbid" },
        { active: !!c.dump, dataset: { stockContentAction: "dump", stockContentId: c.id }, title: "Mark / cancel dump" },
        { active: !!c.hidden, dataset: { stockContentAction: "hide", stockContentId: c.id }, title: "Hide / show" },
      ], { preset: "itemActions", cls: "dwfui-actions", ariaLabel: "Contained item actions" }),
    });
    // NO "Contains N" heading and NO "(empty)" row: the container oracle runs the location row
    // straight into the contents rows, and native shows an empty container as an empty area.
    const contentsBlock = contents.length
      ? `<div class="stock-item-contents">${contents.map(contentRow).join("")}</div>` : "";
    // WIRED CAPABILITY, KEPT (superset policy): item -> holder/owner navigation and the display of
    // WHO holds or owns the item is real wire data (src/interaction.cpp:1232-1245) and exists
    // nowhere else on the sheet. The duplicate ► triangle in the header carried the SAME
    // data-stock-item-unit wire and is deleted; this one is dressed in the native green plaque.
    const unitBlock = unit ? `
      <div class="stock-item-unit">
        <div>
          <div class="stock-item-label">${holder ? "With" : "Owned by"}</div>
          <div class="stock-item-unit-name">${escapeHtml(unit.name || `Unit ${unit.id}`)}</div>
        </div>
        ${ui.plaqueBtnHtml({ label: "View", tone: "green", chassis: "slab", cls: "stock-item-view-unit",
            dataset: { stockItemUnit: unit.id }, title: "View this unit" })}
      </div>` : "";
    // B236: THE LABELLED FIELD DUMP IS DELETED. The wire's `lines` (Type/Material/Quality/Weight/
    // Wear/Container/Location/Position/Owner/Forbidden/Dump/Hidden -- src/interaction.cpp:1140-1167)
    // rendered as a debug panel that exists on NO native sheet (all four oracles). DELETION LEDGER,
    // field by field -- every capability survives on its native carrier:
    //   Quality/Wear     the decorated title (verbatim) + the prose adjective   [were already dropped]
    //   Material         the title + the prose sentence                         [see itemMetaLine note]
    //   Weight           the gold meta line (`Weight: 22Γ`)
    //   Type             the item sprite (header, the ONE item art channel)
    //   Container        the location row's container form (item-ref channel + name)
    //   Location         the location row (stockpile/container) -- native shows nothing for "On map"
    //   Position         the camera tool (data-item-follow), which native also uses for this
    //   Owner            the holder/owner block (`With` / `Owned by` + View plaque)
    //   Forbidden/Dump/Hidden  the three header toggles -- STATE is the _ACTIVE sprite variant
    // The `lines` array itself stays on the wire untouched (it is the server's concern; B236's DLL
    // half recomposes lines[0] as the native sentence).
    // Native co-located icon rail: one entry per loose item sharing the tile (WIRED -> openItemPanel).
    const fixtureSiblingRefs = result?.siblingSpriteRefs && typeof result.siblingSpriteRefs === "object"
      ? result.siblingSpriteRefs : {};
    const railSiblings = siblings.map(s => Object.assign({}, s, {
      spriteRef: s.spriteRef || (Number(s.id) === Number(result?.id) ? result?.spriteRef : null) ||
        fixtureSiblingRefs[String(s.id)] || null,
    }));
    const sideTabs = (ui && railSiblings.length > 1) ? ui.occupantRailHtml({
      cls: "stock-item-sidetabs", dataAttr: "stock-item-sibling",
      ariaLabel: "Items on this tile", active: String(result?.id ?? ""),
      // This is an icon strip, not a trapezoid tab row. Live siblings and Studio fixtures carry the
      // same sprite-ref shape, so both exercise the one production item resolver.
      tabs: railSiblings.map(s => ({
        key: String(s.id), title: s.name,
        iconHtml: ui.iconHtml({ item: s.spriteRef, cls: "dwfui-occupant-icon stock-item-sidetab-icon", size: 32, alt: s.name }),
      })),
    }) : "";
    return {
      className: "visible stock-item-panel" + (sideTabs ? " has-sidetabs" : ""),
      siblings,
      html: `
      <div class="stock-item-frame">
        <div class="stock-item-sheet">
          ${header}
          <div class="stock-item-body">
            ${description ? `<div class="stock-item-description">${escapeHtml(description)}</div>` : ""}
            ${locationRow}
            ${unitBlock}
            ${contentsBlock}
          </div>
        </div>
        ${sideTabs}
      </div>
    ` };
  }

  // Honest "item unavailable" fallback for the stock-item sheet. Native item sheets carry no close
  // X (they are ESC-only), but a headless #selection panel with no visible way out reads as a
  // dead-end -- so this mirrors the sibling "Stockpile unavailable" panel exactly: the same native
  // DWFUI close button wired straight to closeSelection (no PanelFrame head-adoption dependency --
  // there is no titlebar here), plus the honest heading. Reached when a flag write or a re-read
  // finds the item gone (another client forbade/dumped/consumed/removed it).
  function showStockItemUnavailable() {
    selection.className = "visible";
    const close = DWFUI.artBtnHtml({
      sprite: DWFUI.TOKENS.sprites.close,
      cls: "unit-close-button",
      dataset: { stockItemGone: "" },
      title: "Close",
      ariaLabel: "Close",
    });
    panelContent(selection).innerHTML =
      close +
      `<h1>Item unavailable</h1>`;
    const x = selection.querySelector("[data-stock-item-gone]");
    if (x) x.addEventListener("click", event => { event.stopPropagation(); closeSelection(); focusPage(); });
  }

  // Re-read the item authoritatively after a mutation the server refused (or a host hiccup): a
  // still-present item repaints to truth, a gone one (non-ok / fetch failure) surfaces the honest
  // unavailable state above -- never a silent no-op that leaves a stale sheet up indefinitely.
  async function reReadStockItemOrUnavailable(id, siblings) {
    try {
      const r = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${id}&action=info&t=${Date.now()}`,
        { method: "POST", cache: "no-store" });
      if (r.ok) { showStockItemSheet(await r.json(), { siblings }); return; }
    } catch (_) {}
    showStockItemUnavailable();
  }

  function showStockItemSheet(result, opts) {
    const rendered = stockItemSheetMarkup(result, opts);
    const siblings = rendered.siblings;
    selection.className = rendered.className;
    // B224: identity stamp for the occupant rail's shown-content guard (dwf-unitcycle.js
    // shownMatchesActive) -- the class alone cannot tell WHICH item sheet is up.
    try { selection.dataset.dfcItemId = String(Number(result?.id ?? -1)); } catch (_) {}
    // B224: this sheet already holds resolved art the rail may still be missing on pre-B224 hosts:
    // the item's own spriteRef, and the location row's STOCKPILE_ICON_* token for the pile under it.
    try {
      if (window.DFTileList && typeof DFTileList.noteOccupantArt === "function") {
        DFTileList.noteOccupantArt("item", Number(result?.id ?? -1), { spriteRef: result?.spriteRef || null });
        if (Number(result?.locationId ?? -1) >= 0 && result?.locationSpriteToken)
          DFTileList.noteOccupantArt("stockpile", Number(result.locationId), { spriteToken: result.locationSpriteToken });
      }
    } catch (_) {}
    panelContent(selection).innerHTML = rendered.html;
    // Side-tab switch: load the chosen sibling's sheet, preserving the sibling list.
    selection.querySelectorAll("[data-stock-item-sibling]").forEach(tab => {
      tab.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(tab.dataset.stockItemSibling);
        if (Number.isInteger(id) && id >= 0) openItemPanel(id, siblings);
      });
    });
    // Contained-item action buttons: view opens that item; forbid/dump/hide act on it, then the
    // container sheet re-fetches so counts/flags stay live (contents-row state is server-blind --
    // see DATA GAP note, so we re-read the whole container rather than patch a row).
    const containerId = Number(result?.id ?? -1);
    selection.querySelectorAll("[data-stock-content-action]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(button.dataset.stockContentId);
        const action = button.dataset.stockContentAction || "";
        if (!Number.isInteger(id) || id < 0 || !action) return;
        if (action === "view") { openItemPanel(id); return; }
        try {
          await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${id}&action=${encodeURIComponent(action)}&t=${Date.now()}`,
            { method: "POST", cache: "no-store" });
          if (Number.isInteger(containerId) && containerId >= 0) {
            const rr = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${containerId}&action=info&t=${Date.now()}`,
              { method: "POST", cache: "no-store" });
            if (rr.ok) showStockItemSheet(await rr.json(), { siblings });
          }
        } catch (_) {}
        focusPage();
      });
    });
    selection.querySelectorAll("[data-stock-item-place]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(button.dataset.stockItemPlace);
        if (Number.isInteger(id) && id >= 0 && typeof openInfoPlace === "function")
          openInfoPlace("stockpile", id);
      });
    });
    selection.querySelectorAll("[data-stock-item-unit]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(button.dataset.stockItemUnit);
        if (Number.isInteger(id) && id >= 0)
          openUnitById(id);
      });
    });
    // (Removed 2026-07-16, cleanup pack) The [data-stock-item-zoom] / [data-stock-item-close]
    // click handlers were dead: no markup ever emits those attributes, so both querySelectors
    // always returned null. The zoom/close affordances are driven elsewhere now.
    // Item flag buttons (forbid / dump / visibility) -- toggle then re-render with new state,
    // keeping the co-located side-tabs in place across the refresh.
    const itemId = Number(result?.id ?? -1);
    selection.querySelectorAll("[data-item-toggle]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (!Number.isInteger(itemId) || itemId < 0) return;
        const action = button.dataset.itemToggle;
        try {
          const r = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${itemId}&action=${encodeURIComponent(action)}&t=${Date.now()}`,
            { method: "POST", cache: "no-store" });
          if (r.ok) { showStockItemSheet(await r.json(), { siblings }); focusPage(); return; }
        } catch (_) {}
        // The flag write did not take: another client already forbade/dumped/consumed/removed this
        // item (a non-ok reply), or the host briefly can't answer. NEVER swallow it and leave the
        // stale sheet up as if the toggle worked -- re-read the item authoritatively. A still-present
        // item repaints to truth; a gone one surfaces the honest, closable "Item unavailable" state
        // (mirrors the [data-sp-remove] re-read and the "Stockpile unavailable" panel).
        await reReadStockItemOrUnavailable(itemId, siblings);
        focusPage();
      });
    });
    // Follow button: move this player's camera onto the item.
    const followBtn = selection.querySelector("[data-item-follow]");
    if (followBtn) {
      followBtn.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (!Number.isInteger(itemId) || itemId < 0) return;
        try {
          const r = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${itemId}&action=follow&t=${Date.now()}`,
            { method: "POST", cache: "no-store" });
          if (r.ok) {
            const res = await r.json();
            // The camera tool is a native LATCH (the green UNIT_SHEET_CAMERA_ACTIVE face in
            // `item sheet flags active.png`), so a click must flip its sprite immediately -- and
            // re-rendering the server payload does exactly that AUTHORITATIVELY. The server toggles
            // this player's follow latch (interaction.cpp:1724-1728) and THEN recomputes
            // `result.following = player_is_following(...)` at :1732, one statement before it
            // serializes at :1735 -- and the follow ops are synchronous mutex hash writes
            // (client_state.cpp:184-211), so res.following is the true POST-click state. Trust it
            // verbatim, exactly as the sibling forbid/dump/hide handler above trusts its response:
            // a client-side toggle guess would paint the wrong latch the moment follow state has
            // diverged (another client acted, a reconnect, a stale sheet). flashMapTile confirms
            // the pan.
            showStockItemSheet(res, { siblings });
            if (res.mapPos) flashMapTile(res.mapPos);
          }
        } catch (_) {}
        focusPage();
      });
    }
  }

  let lastStocksData = null;
  let stocksSearchTimer = null;
  let stocksSearchRequestSeq = 0;

  // WAVE 4 / S4: the Stocks row cluster now wears NATIVE SPRITES, not emoji. The order
  // `[recenter][view][forbid][dump] · gap · [hide]` was already correct and is preserved verbatim,
  // as are all five data-stock-action hooks and the .stocks-item-action* classes (wiring + CSS hold).
  // TWO paint bugs fixed: (1) every tile was a TOKENS.glyphs EMOJI while the real DF art sits in
  // interface_map.json; (2) the leading tile used the movie-camera glyph, but native's leading stocks
  // tile is STOCKS_RECENTER (an arrow-into-box), not a camera. forbid/dump/hide take their `_ACTIVE`
  // sprite variant when latched -- that is what native's "active" looks like.
  function stocksActionCluster(item) {
    const ui = D();
    if (!ui) return `<div class="stocks-item-actions"></div>`;
    const S = ui.TOKENS.sprites;
    const it = item || {};
    return ui.actionButtonsHtml([
      { action: "zoom", sprite: S.recenterStocks, dataset: { stockAction: "zoom" }, title: "Zoom to item" },
      { action: "view", sprite: S.view, dataset: { stockAction: "view" }, title: "View item" },
      { action: "forbid", sprite: S.forbid, activeSprite: S.forbidOn, active: !!it.forbidden,
        dataset: { stockAction: "forbid" }, title: "Forbid / unforbid" },
      { action: "dump", sprite: S.dump, activeSprite: S.dumpOn, active: !!it.dump,
        dataset: { stockAction: "dump" }, title: "Mark / cancel dump" },
      { action: "hide", sprite: S.hide, activeSprite: S.hideOn, active: !!it.hidden, gapBefore: true,
        dataset: { stockAction: "hide" }, title: "Hide / show" },
    ], { cls: "stocks-item-actions", btnCls: "stocks-item-action", ariaLabel: "Item actions" });
  }

  // ---- PB-02. THE SERVER WAS NEVER THE BLOCKER. ------------------------------------------------
  // The parity matrix filed cross-category stock search as "server-blocked: `detail=` locks you into
  // a category". That is WRONG, and the C++ says so: src/info_panel.cpp:657 `add_stock_items_for_search`
  // walks `world->items.all` with NO category filter, and :1899-1906 consults `panel.detail` ONLY in
  // the `else` (no-search) branch, while the category rows are pushed UNCONDITIONALLY. So B1
  // (cross-category), B2 (matches inside subcategories) and B3 (the master list is not filtered) were
  // ALREADY TRUE ON THE WIRE. Two things were wrong on the CLIENT, and both are fixed here:
  //
  // B4 -- NO GROUP HEADERS. `Menu Oracle Screenshots/native df searching stock.png` (provenance:
  //   native, E5-verified) renders search results as a GROUP-HEADER row per item type -- the type's
  //   name plus a `[N]` count when the group holds more than one -- with its matching items INDENTED
  //   BENEATH it. That is exactly DWFUI.rowGroupHtml (native row variant R8), which shipped in Wave 2
  //   and had ZERO consumers while this panel rendered one flat, ungrouped list. It is wired now.
  //
  // A REDUNDANT SECOND FILTER -- the panel re-filtered the SERVER'S OWN RESULTS through the client's
  //   `dfTokenMatch`, which is a DIFFERENT matcher from the C++ `stock_search_matches` (:640-655).
  //   Any legitimate server hit the two matchers disagreed about was silently DROPPED before it ever
  //   reached the screen. The server has already applied the query; filtering it again is not a
  //   safety net, it is a second opinion nobody asked for. It is gone.
  //
  // NOT RENDERED, AND REPORTED RATHER THAN FAKED: native's group header also carries a REDUCED action
  // set ([forbid][dump] . [hide] -- no magnifier, no recenter, no icon box) that acts on the WHOLE
  // GROUP. We have no group-level route: /stock-item-action takes ONE item id. Rendering the three
  // tiles anyway would ship three dead buttons -- fabricated UI, the exact defect this wave exists to
  // remove. The header ships label + count until the bulk route exists. (Native also prints an orange
  // sub-count beneath each category's white count; we have no such field on the wire, so we omit it.)
  //
  // Grouping key: the server sends the UNDECORATED base name (`stock_item_name`) on every search row
  // and sorts by it, so `name` IS the group. Members print the DECORATED name (quality/wear affixes)
  // via DwfWireV1.formatItemName -- which is exactly the native split: header `Alpaca wool
  // tunics [2]`, members `x(alpaca wool tunic)x` / `XX(alpaca wool tunic)XX`.
  function stocksSearchGroups(items) {
    const order = [];
    const byKey = new Map();
    for (const item of (Array.isArray(items) ? items : [])) {
      const key = String(item?.name || "");
      let group = byKey.get(key);
      if (!group) { group = { key, items: [] }; byKey.set(key, group); order.push(group); }
      group.items.push(item);
    }
    return order;
  }

  function stocksPanelMarkup(data, options) {
    const ui = D();
    data = data || {};
    const opts = options || {};
    const rows = Array.isArray(data.rows) ? data.rows : [];
    let selectedCategory = opts.activeCategory || data.detail || "";
    const current = rows.find(row => row.job === selectedCategory) || rows[0] || null;
    selectedCategory = current ? (current.job || current.name || "") : "";
    const footer = data.footer || "";
    const selectedCount = current ? (current.status || "None") : "None";
    const query = String(opts.query || "").trim();
    // The server has already applied the query (add_stock_items_for_search). NO SECOND CLIENT FILTER.
    const stockItems = Array.isArray(data.stockItems) ? data.stockItems : [];
    const itemLabel = item => (window.DwfWireV1 && typeof DwfWireV1.formatItemName === "function")
      ? DwfWireV1.formatItemName(item.name || "", item) : String(item.name || "");
    // The item row on the native TABLE chassis (the diagonal hatch), with its 5-tile action cluster.
    // `.stocks-item-row`, `.stocks-item-name`, `.stocks-item-subtitle`, `.stocks-count`,
    // `data-stock-item-id` and every data-stock-action hook survive untouched.
    const stockItemRowHtml = item => {
      const label = itemLabel(item);
      const count = Number(item.count || 1) > 1 ? String(item.count) : "";
      return ui.rowHtml({
        cls: "stocks-item-row", chassis: "table", dataset: { stockItemId: item.itemId ?? -1 },
        iconCfg: { item: item.spriteRef, cls: "stocks-item-icon", size: 32, alt: label },
        labelCls: "stocks-item-name",
        label: item.status ? `${label} ${item.status}` : label,
        sub: item.subtitle ? { text: item.subtitle, cls: "stocks-item-subtitle" } : null,
        // An absent count renders NOTHING -- but the cell stays, so the column keeps its width and
        // the action cluster does not slide left (invariant: native omits, it does not close up).
        cells: [{ cls: "stocks-count", html: escapeHtml(count) }],
        trailing: stocksActionCluster(item),
      });
    };
    const emptyLine = text => `<div class="stocks-detail-line stocks-detail-muted">${text}</div>`;
    let itemRows;
    if (!stockItems.length) {
      // `workshop-picker/no-results` is a APPROVED anchor (conflict C-5) -- the no-result copy
      // stays exactly as it reads today. Native shows an empty pane; we say why it is empty.
      itemRows = emptyLine(query ? "No items match your search." : "No visible items in this category.");
    } else if (query) {
      itemRows = stocksSearchGroups(stockItems).map(group => ui.rowGroupHtml({
        cls: "stocks-search-group",
        header: { label: group.key, count: group.items.length > 1 ? group.items.length : null },
        rows: group.items.map(stockItemRowHtml),
      })).join("");
    } else {
      itemRows = stockItems.map(stockItemRowHtml).join("");
    }
    // NOT MIGRATED, and reported: the category rail's rows stay hand-built <div>s. The native slab
    // (+ gold corner brackets on the selection) is DWFUI.rowHtml({chassis:'slab', selected}) -- but
    // tools/harness/ui_lab_test.mjs:415 pins this row by ADJACENCY, asserting the literal
    // `stocks-row selected" data-stock-key="weapons"`, i.e. that `selected` is the LAST class in the
    // attribute. No rowHtml output can satisfy that (the builder appends `dwfui-row--slab` and
    // `aria-selected` after it), and that file is not this lane's to edit. Keeping the classname is
    // not enough here, so the migration is BLOCKED ON A TEST PIN, not on evidence or on a builder.
    // See the closeout: it is a one-line regex relaxation in a file the coordinator owns.
    const categoryRows = rows.length ? rows.map(row => {
      const key = row.job || row.name || "";
      const selected = key === selectedCategory ? " selected" : "";
      return `<div class="stocks-row${selected}${row.muted ? " muted" : ""}" data-stock-key="${escapeHtml(key)}"><span>${escapeHtml(row.name || "")}</span><span class="stocks-count">${escapeHtml(row.status || "None")}</span></div>`;
    }).join("") : emptyLine("No stock categories available.");
    const categoryList = ui.scrollHtml({ cls: "stocks-list", ariaLabel: "Stock categories" }, categoryRows);
    // F7 P2: the stocks search is a PANE-HEADER search -- it spans the top of the list pane it
    // filters, with the BUTTON_FILTER magnifier abutting its right edge (native df searching
    // stock.png). It passed no `placement` at all, so it took neither of native's two placements.
    const search = ui.searchHtml({ cls: "stocks-search-row", inputCls: "stocks-search-box", buttonCls: "stocks-search-button", dataAttr: "stocks-search", placement: "pane-header", preserveKey: "stocks-search", value: query, placeholder: "Search stocks...", ariaLabel: "Search every stock item", magnifier: true });
    const items = ui.scrollHtml({ cls: "stocks-item-list", ariaLabel: query ? "Stock search results" : "Items in selected category" }, itemRows);
    const heading = query ? "Search results" : (current ? (current.name || "Stocks") : "Stocks");
    const count = query ? stockItems.length : selectedCount;
    const body = `<div class="stocks-body">${categoryList}<div class="stocks-main">${search}<div class="stocks-detail"><h2>${escapeHtml(heading)}</h2><div class="stocks-detail-line">Count: <strong>${escapeHtml(count)}</strong></div>${items}</div></div></div>`;
    return { activeCategory: selectedCategory, html: ui.windowHtml({ cls: "stocks-window", ariaLabel: "Stocks", bodyHtml: body, footerHtml: footer ? `<div>${escapeHtml(footer)}</div>` : null }) };
  }

  // PB-02 / B5 -- the CLIENT half, and only the client half.
  //
  // This request used to send `detail=<the selected category>` on EVERY keystroke, including while a
  // query was active. It is misleading at best: the server DISCARDS `detail` whenever `search` is
  // non-empty (info_panel.cpp:1899-1906 reads it only in the else branch), so the parameter said
  // "scope this to Bars" while the server searched the whole fort. Sending it is now conditional on
  // there being NO query, which makes the request say what the server actually does.
  //
  // THE OTHER HALF OF B5 IS A SERVER GAP AND IS NOT FIXED HERE. Native, on clearing the box, returns
  // you to the WHOLE STOCK LIST. Our server has NO route for that: with an empty query it can only
  // call `add_stock_items_for_type(panel, selected.type)`, which REQUIRES a category
  // (info_panel.cpp:1902-1905). There is no "all items, no query" path to ask for. Dropping `detail`
  // on clear would therefore not show the whole stock -- it would show an EMPTY PANE, which is
  // strictly worse than the category we show today. `src/` is outside this lane, so the honest move
  // is to leave the category fallback, say so, and file the missing route. See the closeout.
  async function refreshStocksSearch(query) {
    const requestSeq = ++stocksSearchRequestSeq;
    const scoped = String(query || "").trim() ? "" : (activeStockCategory || "");
    const url = `/panel?player=${encodeURIComponent(player)}&panel=stocks&section=stocks&detail=${encodeURIComponent(scoped)}&search=${encodeURIComponent(query)}&t=${Date.now()}`;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("stocks search failed");
      const data = await response.json();
      if (requestSeq !== stocksSearchRequestSeq || query !== stocksSearchQuery || activeInfoPanel !== "stocks") return;
      renderStocksPanel(data);
      const next = clientPanel.querySelector("[data-stocks-search]");
      if (next) { next.focus(); try { next.setSelectionRange(next.value.length, next.value.length); } catch (_) {} }
    } catch (_) {
      // A transient search failure keeps the current rows and the player's typed query in place.
    }
  }

  function renderStocksPanel(data) {
    lastStocksData = data;
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("stocks"); // WD-26 first-time help (25-stocks.png)
    const rendered = stocksPanelMarkup(data, { activeCategory: activeStockCategory, query: stocksSearchQuery });
    activeStockCategory = rendered.activeCategory;
    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = rendered.html;
    // Native search spans every stock category. Debounce one backend search instead of fetching
    // on every key; clearing the field requests the selected category's normal rows again.
    const searchInput = clientPanel.querySelector("[data-stocks-search]");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        stocksSearchQuery = searchInput.value || "";
        if (stocksSearchTimer) clearTimeout(stocksSearchTimer);
        stocksSearchTimer = setTimeout(() => refreshStocksSearch(stocksSearchQuery), 180);
      });
    }
    clientPanel.querySelectorAll("[data-stock-key]").forEach(row => {
      row.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        activeStockCategory = row.dataset.stockKey || "";
        stocksSearchQuery = "";
        ++stocksSearchRequestSeq;
        if (stocksSearchTimer) clearTimeout(stocksSearchTimer);
        openPanel("stocks", "stocks", activeStockCategory);
      });
    });
    clientPanel.querySelectorAll("[data-stock-action]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const row = button.closest("[data-stock-item-id]");
        const id = Number(row?.dataset.stockItemId ?? -1);
        const action = button.dataset.stockAction || "";
        if (!Number.isInteger(id) || id < 0 || !action) return;
        try {
          const response = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${id}&action=${encodeURIComponent(action)}&t=${Date.now()}`, {
            method: "POST",
            cache: "no-store"
          });
          if (!response.ok) return;
          const result = await response.json();
          if (action === "view") {
            closeClientPanel();
            showStockItemSheet(result);
            if (result.mapPos)
              flashMapTile(result.mapPos);
          }
          if (action === "zoom") {
            closeClientPanel();
            closeSelection();
            if (result.mapPos)
              flashMapTile(result.mapPos);
          }
          if (action === "forbid" || action === "dump" || action === "hide")
            openPanel("stocks", "stocks", activeStockCategory);
        } catch (_) {}
      });
    });
  }

  // R10 (CIM-TASKS): the Tasks tab is JOB-FIRST -- the job name is the primary LEFT column, then
  // portrait, then the unit's "Name, Profession" as a single profession-colored string, then the
  // cancel + locate action pair (CIM-tasks.jpg). This differs from the generic renderInfoRows
  // (Places/Objects), whose left column is the place/object name and which prints a Name/Cat/Prof
  // sort head the native Tasks screen does NOT show. Data contract (verified read-only against
  // info_panel.cpp build_tasks_panel :663): the job text is served in `row.status` (= job_name),
  // the unit carries `jobId` for the cancel action, and name/profession/portrait come from
  // row_for_unit. Everything is graceful when a field is absent (empty job cell, no cancel button).
  // Pure: the native "Name, Profession" single string (CIM-tasks.jpg). Graceful when either field
  // is absent -- empty name -> "", missing profession -> bare name.
  function taskNameProf(row) {
    if (!row || !row.name) return "";
    return row.profession ? `${row.name}, ${row.profession}` : String(row.name);
  }

  // ---- PB-04: AN ABSENT CELL RENDERS NOTHING. IT DOES NOT RENDER A BLANK BOX. -------------------
  // `Menu Oracle Screenshots/tasks screen.png` (provenance: native): the four `Dump item` rows carry
  // a job name and NOTHING ELSE -- no icon, no portrait, no name, no buttons. Their columns are
  // simply EMPTY. We were rendering `infoPlaceIconMarkup(row)` for every unit-less task row, and its
  // final fallback drew a gold-bordered 32px box containing the first letter of the job ("D" for
  // `Dump item`) -- a control native does not have, invented out of a missing-art fallback.
  //
  // THE GAP IS NOT CLOSED, EITHER. `.info-row.info-task-row` is a FIXED 4-column CSS grid, so the
  // cell must still EXIST to hold its column (dropping the element outright would slide the name
  // into the icon column). It emits an empty span: the column keeps its width, and nothing is drawn.
  // A task row that DOES name a place (a stockpile, a workshop, a zone -- the right-hand column in
  // the same capture) still gets its real place art; only the no-entity case goes blank.
  function taskPlaceCellHtml(row) {
    if (infoRowHasPlaceArt(row)) return infoPlaceIconMarkup(row);
    return `<span class="info-task-noicon"></span>`;
  }

  function taskRowsHtml(rows) {
    if (!Array.isArray(rows) || !rows.length)
      return "";
    return `
      <div class="info-table info-task-table">
        ${rows.map(row => {
          const job = row.status || row.job || "";
          const unitId = Number(row.unitId ?? -1);
          const pos = infoRowPos(row);
          const nameColor = professionColorStyle(row);
          const nameProf = taskNameProf(row);
          return `
            <div class="info-row info-task-row${unitId >= 0 || Number(row.locationId ?? -1) >= 0 ? " clickable" : ""}${row.muted ? " info-muted" : ""}"
              data-unit-id="${escapeHtml(unitId)}"
              data-place-kind="${escapeHtml(String(row.kind || ""))}"
              data-location-id="${escapeHtml(row.locationId ?? -1)}"
              data-building-id="${escapeHtml(row.buildingId ?? -1)}"
              data-item-id="${escapeHtml(row.itemId ?? -1)}"
              ${pos ? `data-pos-x="${escapeHtml(pos.x)}" data-pos-y="${escapeHtml(pos.y)}" data-pos-z="${escapeHtml(pos.z)}"` : ""}>
              <div class="info-task-job">${escapeHtml(job)}</div>
              ${unitId >= 0 ? unitPortraitMarkup(row, "info-portrait-small") : taskPlaceCellHtml(row)}
              <div class="info-task-name"${nameColor}>${escapeHtml(nameProf)}</div>
              ${infoRowActions(row)}
            </div>`;
        }).join("")}
      </div>`;
  }

  // R10: functional bottom search for the generic info panels (Tasks/Places/Objects) -- previously
  // a dead `infoSearchBoxHtml` placeholder. Same client-side token-filter convention as the
  // Creatures tab (dfTokenMatch over the full row text). State is module-level; the query is reset
  // whenever the active section changes so a filter typed on Places doesn't carry over to Objects.
  let infoSearch = "";
  let infoSearchSection = "";
  let infoRowsRaw = [];
  let infoMessageHtml = "";
  let infoIsTasks = false;

  function infoRowSearchText(row) {
    return `${row.name || ""} ${row.profession || ""} ${row.category || ""} ${row.status || ""} ${row.job || ""} ${row.subtitle || ""}`.toLowerCase();
  }

  // Pure: filter the fetched rows by the search box using the shared DF token matcher (empty query
  // returns every row). Kept separate so the offline fixture can assert match/no-match behavior.
  function infoFilterRows(rows, needle) {
    const q = String(needle == null ? "" : needle).trim();
    const list = Array.isArray(rows) ? rows : [];
    if (!q) return list.slice();
    const matcher = typeof dfTokenMatch === "function" ? dfTokenMatch : (value, query) => String(value || "").toLowerCase().includes(String(query || "").toLowerCase());
    return list.filter(row => matcher(infoRowSearchText(row), q));
  }

  function infoBodyHtml() {
    const needle = infoSearch.trim();
    const filtered = infoFilterRows(infoRowsRaw, needle);
    if (needle && !filtered.length)
      return `${infoMessageHtml}<div class="info-message">No matches.</div>`;
    const rowsHtml = infoIsTasks ? taskRowsHtml(filtered) : renderInfoRows(filtered);
    return `${infoMessageHtml}${rowsHtml}`;
  }

  // Row + action wiring for the generic info body (Places/Objects/Tasks). Extracted so a search
  // re-render (which rebuilds only .info-main) can re-attach the same handlers, mirroring the
  // Creatures tab's wireCreatureBody. Scoped to the passed root (defaults to clientPanel).
  function wireInfoBody(scope) {
    const root = scope || clientPanel;
    root.querySelectorAll("[data-unit-id]").forEach(row => {
      row.addEventListener("click", event => {
        if (event.target.closest("[data-info-open], [data-info-center], [data-info-cancel-job]")) return;
        event.preventDefault();
        event.stopPropagation();
        const id = Number(row.dataset.unitId);
        if (Number.isInteger(id) && id >= 0) {
          openUnitById(id);
          return;
        }
        const kind = row.dataset.placeKind || "";
        const buildingId = Number(row.dataset.buildingId ?? -1);
        const itemId = Number(row.dataset.itemId ?? -1);
        const locationId = Number(row.dataset.locationId ?? -1);
        if (Number.isInteger(itemId) && itemId >= 0) {
          closeClientPanel();
          openItemPanel(itemId);
          return;
        }
        // B229: a Places > Locations row is a LOCATION first and a zone second -- clicking it opens
        // the location (staff, occupants, deity/guild, rooms), not the civzone it happens to sit in.
        if (Number.isInteger(locationId) && locationId >= 0) {
          closeClientPanel();
          openLocationPanel(locationId);
          return;
        }
        if (Number.isInteger(buildingId) && buildingId >= 0 && kind)
          openInfoPlace(kind, buildingId);
      });
    });
    root.querySelectorAll("[data-info-open]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const row = button.closest(".info-row");
        const kind = row?.dataset.placeKind || "";
        const buildingId = Number(row?.dataset.buildingId ?? -1);
        const itemId = Number(row?.dataset.itemId ?? -1);
        if (Number.isInteger(itemId) && itemId >= 0) {
          closeClientPanel();
          openItemPanel(itemId);
          return;
        }
        if (Number.isInteger(buildingId) && buildingId >= 0)
          openInfoPlace(kind, buildingId);
      });
    });
    root.querySelectorAll("[data-info-center]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const row = button.closest(".info-row");
        const pos = {
          x: Number(row?.dataset.posX),
          y: Number(row?.dataset.posY),
          z: Number(row?.dataset.posZ)
        };
        if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))
          await centerAndFlashMapPos(pos);
      });
    });
    // WD-22: Tasks tab cancel button -- POST /task-cancel then refresh this same tab/section in
    // place (matches DF's own behavior: the job disappears from the list immediately).
    root.querySelectorAll("[data-info-cancel-job]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const jobId = Number(button.dataset.infoCancelJob);
        if (!Number.isInteger(jobId) || jobId < 0) return;
        button.disabled = true;
        try {
          await fetch(`/task-cancel?player=${encodeURIComponent(player)}&job=${jobId}&t=${Date.now()}`, {
            method: "POST", cache: "no-store"
          });
        } catch (_) {}
        openPanel(activeInfoPanel || "orders", activeInfoSection || "tasks", activeInfoDetail || "");
      });
    });
  }

  function renderInfoPanel(data) {
    if ((data.panel || "") === "stocks" || (data.section || "") === "stocks") {
      renderStocksPanel(data);
      return;
    }
    activeInfoPanel = data.panel || activeInfoPanel || "citizens";
    activeInfoSection = data.section || activeInfoSection || defaultSectionForPanel(activeInfoPanel);
    activeInfoDetail = data.detail || "";
    // WD-16: primaryTabs/sectionTabs (the server's nobles+objects+justice / creatures+tasks+
    // places+labor+workorders split) are superseded by the shared INFO_TABS row below -- the
    // server still emits them (info_panel.cpp, src/* not this item's territory) but the client
    // no longer renders them as two separate rows.
    const detailTabs = Array.isArray(data.detailTabs) ? data.detailTabs : [];
    const sideItems = Array.isArray(data.sideItems) ? data.sideItems : [];
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const footer = data.footer || "";
    const bodyClass = sideItems.length ? "info-body with-side" : "info-body";
    const messageHtml = messages.map(line => `<div class="info-message">${escapeHtml(line)}</div>`).join("");
    const sideHtml = sideItems.length ? `
      <div class="info-side-list">
        ${sideItems.map((item, index) => `
          <div class="info-side-item${index === 1 ? " selected" : ""}">
            <span>${index ? "" : "+"}</span><strong>${escapeHtml(item)}</strong>
          </div>
        `).join("")}
      </div>
    ` : "";
    // WD-17: the Creatures tab gets its own row anatomy (locate+view, mood face, labor-hammer,
    // held item -- see renderCreatureBody/creatureRowsHtml above) instead of the generic
    // renderInfoRows every other not-yet-restyled tab (Tasks/Places/Objects, WD-22) still uses.
    const isCreatures = (data.panel || "") === "citizens";
    if (isCreatures) {
      creatureRowsRaw = Array.isArray(data.rows) ? data.rows : [];
      creatureTrainers = Array.isArray(data.trainers) ? data.trainers : [];
      creatureMessageHtml = messageHtml;
      // B254: on an OLD DLL the /info row has no `specialized`/`workDetails`, so pull the same truth
      // out of /labor (which has served rows[].specialist + rows[].assignedTo + details[].iconKey
      // since the Labor tab shipped). Skipped entirely once the DLL carries the fields itself, so a
      // deployed-plugin upgrade silently drops the extra request. Never blocks the render: the
      // columns simply appear when it lands, and stay closed if it never does.
      const needsLaborFallback = activeInfoDetail === "residents" && creatureRowsRaw.length > 0 &&
        !Object.prototype.hasOwnProperty.call(creatureRowsRaw[0], "specialized");
      if (needsLaborFallback) fetchCreatureLaborFallback();
      else creatureLabor = null;
    } else {
      // R10: generic info panels (Tasks/Places/Objects) get the functional search + Tasks gets the
      // job-first row anatomy. Reset the query whenever the section changes so a Places filter is
      // not still applied after switching to Objects/Tasks.
      if (activeInfoSection !== infoSearchSection) { infoSearch = ""; infoSearchSection = activeInfoSection; }
      infoRowsRaw = Array.isArray(data.rows) ? data.rows : [];
      infoMessageHtml = messageHtml;
      infoIsTasks = (activeInfoSection === "tasks");
    }
    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = DWFUI.windowHtml({
      ariaLabel: `${activeInfoSection || "Information"} information`,
      primaryTabs: infoTabRowHtml(activeInfoSection),
      detailTabs: infoDetailTabRowHtml(detailTabs, activeInfoDetail),
      bodyHtml: `<div class="${bodyClass}">
          ${sideHtml}
          <div class="info-main">
            ${isCreatures ? `${creatureMessageHtml}${creatureRowsHtml()}` : infoBodyHtml()}
          </div>
        </div>`,
      footerHtml: `${isCreatures ? infoSearchInputHtml(creatureSearch) : infoSearchInputHtml(infoSearch, "info-search")}` +
        `${footer ? `<div>${escapeHtml(footer)}</div>` : ""}`,
    });
    wireInfoTabRow(clientPanel);
    clientPanel.querySelectorAll("[data-info-detail]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        openPanel(activeInfoPanel || "citizens", activeInfoSection || "", button.dataset.infoDetail || "");
      });
    });
    if (isCreatures) {
      wireCreatureBody(clientPanel.querySelector(".info-main"));
      const searchInput = clientPanel.querySelector("[data-creature-search]");
      if (searchInput) searchInput.addEventListener("input", () => {
        creatureSearch = searchInput.value || "";
        renderCreatureBody();
        const next = clientPanel.querySelector("[data-creature-search]");
        if (next) { next.focus(); try { next.setSelectionRange(next.value.length, next.value.length); } catch (_) {} }
      });
      return;
    }
    wireInfoBody(clientPanel);
    // R10: promote the bottom search box to a live filter (Tasks/Places/Objects). Re-render only
    // .info-main and re-attach the row handlers -- same in-place pattern as the Creatures search,
    // so scroll position and the input's own listener survive the keystroke.
    const infoSearchInput = clientPanel.querySelector("[data-info-search]");
    if (infoSearchInput) infoSearchInput.addEventListener("input", () => {
      infoSearch = infoSearchInput.value || "";
      const main = clientPanel.querySelector(".info-main");
      if (main) main.innerHTML = infoBodyHtml();
      wireInfoBody(clientPanel);
      const next = clientPanel.querySelector("[data-info-search]");
      if (next) { next.focus(); try { next.setSelectionRange(next.value.length, next.value.length); } catch (_) {} }
    });
  }

  function openInfoPlace(kind, id) {
    const k = String(kind || "").toLowerCase();
    closeClientPanel();
    if (k === "stockpile") { openStockpilePanel(id); return; }
    if (k === "workshop") { openWorkshopPanel(id); return; }
    if (k === "zone") { openZonePanel(id); return; }
    if (k === "building") { openBuildingPanel(id); return; }
  }

  async function openUnitById(id) {
    try {
      const response = await fetch(`/unit?player=${encodeURIComponent(player)}&id=${encodeURIComponent(id)}&t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("unit failed");
      const data = await response.json();
      showUnitSheet(data);
    } catch (_) {}
  }

  async function openPanel(name, section = null, detail = null) {
    setActiveToolbar(name);
    if (name !== "zone" && typeof zonePalette !== "undefined") {
      zonePalette.style.display = "none";
      zoneOverlayEnabled = false;
      zonePreset = null;
      currentZones = [];
      renderZoneOverlay();
    }
    if (name === "stockpile") { toggleStockPalette(); return; }
    if (name === "zone") { toggleZonePalette(); return; }
    if (name === "build") { openBuildPanel(); return; }
    if (name === "workorders") { openWorkOrdersPanel(); return; }
    // B232 R2: the ALERT button opens the NATIVE ALERT BOX (oracle B232-oracle-native.png), not
    // a full-screen dashboard. The full log stays a separate destination below.
    if (name === "alerts") { openNotificationsPanel(); return; }
    // Reports is not a toolbar destination (no data-panel="reports" button exists -- WD-1 deleted
    // it). Reachable via the alert box's log icon and the world map's Reports plaque
    // (dwf-announcements.js openReportsPanel).
    if (name === "reports") { openReportsPanel(); return; }
    if (name === "squads") { openSquadsPanel(); return; }
    if (name === "nobles") { openNoblesPanel(); return; }
    if (name === "justice") { openJusticePanel(); return; }
    // B225 ROOT CAUSE (petitions half): this case NEVER EXISTED. The B188 petitions screen
    // (dwf-fort-admin.js openPetitionsPanel) shipped with no caller -- the Shift+G keymap
    // entry routed here, fell through to renderLocalPanel("petitions"), and rendered the generic
    // "Panel shell is independent" stub; no sidebar plaque existed either. The plaque detector
    // now lives in dwf-diplo.js (left-rail PETITIONS light); both paths land here.
    if (name === "petitions") { openPetitionsPanel(); return; }
    if (name === "obligations") { openObligationsPanel(); return; }   // WT15 client-only aggregate board
    if (name === "kitchen") { openKitchenPanel(); return; }
    if (name === "worldmap") { openWorldMapPanel(); return; }
    clearBuildPlacement(false);
    const backendPanels = new Set(["citizens", "labor", "locations", "orders", "workorders", "objects", "stocks"]);
    if (!backendPanels.has(name)) {
      renderLocalPanel(name);
      return;
    }
    if (name === "labor" || section === "labor") {
      openLaborPanel();
      return;
    }
    activeInfoPanel = name;
    activeInfoSection = section || defaultSectionForPanel(name);
    activeInfoDetail = detail || "";
    // A fresh Stocks open never carries a search. The stocks search box lives only inside the
    // rendered panel and re-searches through refreshStocksSearch(), which calls renderStocksPanel
    // DIRECTLY and bypasses openPanel -- so every path that reaches here for stocks (the `k`
    // keybind, the top-bar Stocks button, a category-rail row, a forbid/dump/hide re-open, or
    // returning from another info tab) is a NON-search fetch that the server answers with the
    // selected category's rows. Without clearing the leftover query, a reopen after searching
    // renders those plain category rows under a stale "Search results" heading with the old term
    // still preloaded in the box -- a phantom search over the wrong list. Mirrors the generic
    // info-search reset in renderInfoPanel (activeInfoSection !== infoSearchSection).
    if (name === "stocks") stocksSearchQuery = "";
    // WD-16 finding: rapid tab-switching (clicking through the shared 8-tab row) could let an
    // earlier /panel fetch resolve AFTER a later one and stomp the newer tab's render (no
    // request correlation before this pass). requestSeq discards any response that isn't the
    // most recent request by the time it comes back -- same fix shape as the work-orders
    // aux-data guard in dwf-labor-work-orders.js.
    const requestSeq = ++infoPanelRequestSeq;
    clientPanel.className = "visible info-panel";
    // WD-16: keep the shared tab row mounted (and clickable) even while this tab's own fetch is
    // in flight -- a bare "Loading..." shell with no tab row briefly made the window
    // unresponsive to a second, faster click on a different tab.
    panelContent(clientPanel).innerHTML = DWFUI.windowHtml({ primaryTabs: infoTabRowHtml(activeInfoSection), bodyHtml: `<div class="info-body"><div class="info-message">Loading...</div></div>` });
    wireInfoTabRow(clientPanel);
    try {
      const url = `/panel?player=${encodeURIComponent(player)}&panel=${encodeURIComponent(name)}&section=${encodeURIComponent(activeInfoSection)}&detail=${encodeURIComponent(activeInfoDetail)}&t=${Date.now()}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("panel failed");
      const data = await response.json();
      if (requestSeq !== infoPanelRequestSeq) return;
      renderInfoPanel(data);
    } catch (_) {
      if (requestSeq !== infoPanelRequestSeq) return;
      clientPanel.className = "visible info-panel";
      panelContent(clientPanel).innerHTML = DWFUI.windowHtml({ primaryTabs: infoTabRowHtml(activeInfoSection), bodyHtml: `<div class="info-body"><div class="info-message">Panel data unavailable.</div></div>` });
      wireInfoTabRow(clientPanel);
    }
  }

  const buildPanelApi = { defaultBuildOptions, buildPanelMarkup, renderBuildDetail, normalizeBuildCatalog,
    b79ConstructionGroupFor, buildPlacementBounds };
  if (typeof window !== "undefined") window.DFBuildPanelMarkup = buildPanelApi;

  // Node export for the offline CIM fixture test (harmless in the browser: `module` is undefined).
  // Exposes only the pure, DOM-free R10 helpers. infoFilterRows/infoRowActions look up the shared
  // globals dfTokenMatch (core.js) at CALL time, so the fixture provides them before invoking.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { infoRowSearchText, taskNameProf, infoFilterRows, infoRowActions, geldButtonSpec, memorialButtonSpec, creatureSexGlyphHtml, creatureRowsMarkup, residentLaborState, professionColorStyle, stockItemSheetMarkup, stocksPanelMarkup,
      infoDetailTabRowHtml, infoTabRowHtml, infoSearchInputHtml, renderInfoRows, taskRowsHtml,
      stocksSearchGroups, taskPlaceCellHtml,
      ...buildPanelApi };
  }

// B199 diagnostic: proves this module executed to completion on a given page load.
if (typeof window !== "undefined") window.__BIP_OK = true;
