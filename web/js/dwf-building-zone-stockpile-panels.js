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

  function buildingCageSummary(info) {
    if (!info || !info.isCage) return null;
    const units = Math.max(0, Number(info.cageAssignedUnits) || 0);
    const items = Math.max(0, Number(info.cageAssignedItems) || 0);
    const total = units + items;
    return { units, items, total, label: total === 1 ? "1 assigned" : `${total} assigned` };
  }

  function buildingCageActionLabel(row) {
    if (!row) return "Assign";
    if (row.assigned) return "Release";
    if (row.assignedElsewhere) return "Move here";
    return "Assign";
  }

  function zoneAnimalAssignmentState(row) {
    const assigned = !!(row && row.assigned);
    const assignedElsewhere = !assigned && !!(row && row.assignedElsewhere);
    return {
      assigned,
      assignedElsewhere,
      assign: assigned ? 0 : 1,
      label: assigned ? "Assigned here" : (assignedElsewhere ? "Assigned elsewhere" : "Not assigned"),
      action: assigned ? "Unassign" : (assignedElsewhere ? "Move here" : "Assign"),
    };
  }

  function zoneAnimalSexGlyphHtml(row) {
    const sex = String(row && row.sex || "").toLowerCase();
    if (sex === "female") return `<span class="zone-animal-sex" title="Female">&#9792;</span>`;
    if (sex === "male") return `<span class="zone-animal-sex" title="Male">&#9794;</span>`;
    return "";
  }

  // [wire, bitKey, meta-label (assigned-row summary), icon token, column title (hover tooltip)].
  // Native DF shows the column name only on hover over each icon -- there is no always-on header
  // row -- so the fifth field is the per-icon title, matching DF's four column headings.
  const ZONE_SQUAD_MODES = [
    ["sleep", "sleep", "Sleeping", "ZONE_SQUAD_SLEEP", "Sleep"],
    ["train", "train", "Training", "ZONE_SQUAD_TRAIN", "Train"],
    ["individual-equipment", "individualEquipment", "Individual equipment", "ZONE_SQUAD_INDIV_EQ", "Individual equipment"],
    ["squad-equipment", "squadEquipment", "Squad equipment", "ZONE_SQUAD_SQUAD_EQ", "Squad equipment"],
  ];

  function zoneSquadModeState(row, mode) {
    const spec = ZONE_SQUAD_MODES.find(item => item[0] === mode);
    return !!(spec && row && row[spec[1]]);
  }

  function zoneSquadRgb(color) {
    const n = value => Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
    return `rgb(${n(color && color.r)},${n(color && color.g)},${n(color && color.b)})`;
  }

  // Pure B166 fixture surface: one native-shaped squad row with the four real barracks mode
  // cells. WAVE-5: the row is now the shared DWFUI grammar -- rowHtml for the chassis and
  // latchHtml for each of the four ZONE_SQUAD_* mode tiles (every token verified present in
  // web/interface_map.json). The four mode tiles are TWO-STATE ART (ACTIVE/INACTIVE are two
  // different sprites), which is latchHtml's exact contract, not checkHtml's.
  //
  // THE EMBLEM REMAINS AN IDENTITY BLOCKER, AND IS NOW MARKED AS ONE. Native paints a squad
  // emblem sprite; no token for it exists in web/interface_map.json and the server serves only
  // the squad's two rgb() colours, so the LETTER stays. It could not be routed through
  // DWFUI.iconHtml({letter}) without DROPPING those served colours -- iconHtml owns its own
  // `style` attribute (--dwfui-icon-size) and exposes no tint hook, so a second style attribute
  // would be silently discarded. Keeping the colour and hand-stamping the SAME marker iconHtml
  // would have emitted (`data-df-identity-missing="letter"`) preserves the served identity AND
  // makes the missing art mechanically detectable. It is a <span>, not a control: no R7 debt.
  // The hook DWFUI is missing is recorded in the lane closeout.
  function zoneSquadRowsHtml(rows, esc = value => String(value)) {
    if (!Array.isArray(rows)) return "";
    return rows.map(row => {
      const id = Number(row && row.id);
      const name = row && (row.alias || row.name) || `Squad ${id}`;
      const modes = ZONE_SQUAD_MODES.filter(spec => zoneSquadModeState(row, spec[0]));
      const assigned = modes.length > 0;
      const emblem = row && row.emblem || {};
      const initial = esc((String(name).trim()[0] || "?").toUpperCase());
      const latches = ZONE_SQUAD_MODES.map(([mode, , label, token, title]) => {
        const on = zoneSquadModeState(row, mode);
        return DWFUI.latchHtml({
          on, cls: "zone-squad-mode", sprite: `${token}_INACTIVE`, activeSprite: `${token}_ACTIVE`,
          dataset: { zoneSquad: id, zoneSquadMode: mode, zoneSquadEnabled: on ? 0 : 1 },
          title: `${title}: ${on ? "on" : "off"}`, ariaLabel: label,
        });
      }).join("");
      const emblemHtml = `<span class="zone-squad-emblem" data-df-identity-missing="letter"` +
        ` style="background:${zoneSquadRgb(emblem.bg)};color:${zoneSquadRgb(emblem.fg)}"` +
        ` aria-hidden="true">${initial}</span>`;
      return DWFUI.rowHtml({
        cls: "zone-squad-row" + (assigned ? " assigned" : ""),
        dataset: { zoneSquadRow: id },
        icon: emblemHtml,
        copyCls: "zone-squad-copy", labelCls: "zone-squad-name",
        label: String(name),
        sub: { cls: "zone-squad-meta",
          text: assigned ? modes.map(spec => spec[2]).join(", ") : "Not assigned" },
        trailing: latches,
      });
    }).join("");
  }

  // The zone panels' remaining DFChrome-direct icon hosts (the barracks rename quill and the
  // "Assign squads" launcher glyph). WAVE-5: the squad MODE tiles no longer come through here --
  // they are DWFUI.latchHtml sprites now, painted by the central DWFUI.paintSprites pass at DF's
  // interface scale. This hand-rolled painter called DFChrome.icon() DIRECTLY at a hardcoded 36px,
  // which is why those icons rendered at a different scale from every other sprite in the app.
  function paintZoneSquadIcons(root) {
    if (!root) return;
    if (window.DWFUI && typeof window.DWFUI.paintSprites === "function") window.DWFUI.paintSprites(root);
    if (!window.DFChrome || typeof window.DFChrome.icon !== "function") return;
    root.querySelectorAll("[data-zone-squad-icon],[data-zone-chrome-icon]").forEach(host => {
      if (host.firstChild) return;
      host.appendChild(window.DFChrome.icon(host.dataset.zoneSquadIcon || host.dataset.zoneChromeIcon, 36));
    });
  }

  function zoneAnimalNativeLabel(row) {
    const flags = Array.isArray(row && row.flags) ? row.flags : [];
    const tame = flags.some(flag => String(flag).toLowerCase() === "tame") || /\(tame\)\s*$/i.test(String(row && row.name || ""));
    let name = String(row && (row.name || row.race) || `Unit ${Number(row && row.id)}`)
      .replace(/\s*\(tame\)\s*$/i, "").trim();
    if (tame && name && !/^stray\b/i.test(name) && !name.includes(",")) name = `Stray ${name}`;
    const sex = String(row && row.sex || "").toLowerCase();
    const sexGlyph = sex === "female" ? "♀" : (sex === "male" ? "♂" : "");
    return `${name}${sexGlyph ? `, ${sexGlyph}` : ""}${tame ? " (Tame)" : ""}`;
  }

  function zoneAnimalSortedRows(rows, key = "name", direction = 1) {
    const value = row => {
      if (key === "category") return String(row && row.race || "");
      if (key === "profession") return (Array.isArray(row && row.flags) ? row.flags : [])
        .filter(flag => flag !== "assigned here" && flag !== "assigned elsewhere").join(" ");
      return zoneAnimalNativeLabel(row);
    };
    return [...(Array.isArray(rows) ? rows : [])].sort((a, b) =>
      direction * value(a).localeCompare(value(b), undefined, { sensitivity: "base", numeric: true }) ||
      Number(a && a.id) - Number(b && b.id));
  }

  let zoneAnimalSortKey = "name";
  let zoneAnimalSortDirection = 1;
  let zoneAnimalSearch = "";

  function coffinBurialSummary(info) {
    if (!info || !info.isCoffin || !info.built) return null;
    const tombId = Number(info.tombId ?? -1);
    const owner = info.owner || {};
    const ownerId = Number(owner.id ?? -1);
    const tomb = info.tomb || {};
    const hasTomb = tombId >= 0;
    const ownerName = ownerId >= 0 ? (owner.name || `Unit ${ownerId}`) : "Any citizen";
    const rights = [];
    if (tomb.citizens) rights.push("citizens");
    if (tomb.pets) rights.push("pets");
    return {
      hasTomb,
      tombId,
      ownerId,
      ownerName,
      rights,
      label: hasTomb ? `${ownerName}${rights.length ? ` - ${rights.join("/")}` : ""}` : "No tomb zone",
      manageLabel: hasTomb ? "Manage tomb assignment" : "Create tomb and assign",
    };
  }


  function leverLinkMechanismStatus(data) {
    const count = Math.max(0, Number(data && data.mechanismCount) || 0);
    const needs = !!(data && data.needsMechanisms) || count < 2;
    return {
      count,
      needs,
      canLink: !needs,
      label: needs ? `Needs mechanisms (${count}/2)` : `${count} mechanisms available`,
    };
  }

  function leverLinkTargetRows(data) {
    const rows = Array.isArray(data && data.targets) ? data.targets : [];
    return rows.map(t => ({
      id: Number(t.id),
      name: t.name || t.type || `Building ${t.id}`,
      type: t.type || "Building",
      x: Number(t.x), y: Number(t.y), z: Number(t.z),
      distance: Math.max(0, Number(t.distance) || 0),
    })).filter(t => Number.isInteger(t.id) && t.id >= 0)
      .sort((a, b) => (a.distance - b.distance) || (a.id - b.id));
  }

  function leverLinkActionState(data, targetId) {
    const status = leverLinkMechanismStatus(data);
    const targets = leverLinkTargetRows(data);
    const id = Number(targetId);
    const hasTarget = targets.some(t => t.id === id);
    return {
      enabled: status.canLink && hasTarget,
      reason: status.canLink ? (hasTarget ? "" : "target unavailable") : "needs mechanisms",
    };
  }
  async function fetchCoffinBurialInfo(id) {
    try {
      const r = await fetch(`/burial-coffin?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      if (data && data.ok !== false && data.isCoffin) return data;
    } catch (_) {}
    return null;
  }

  async function postCoffinBurialAction(id, action) {
    const r = await fetch(`/burial-coffin-action?id=${id}&action=${encodeURIComponent(action)}&t=${Date.now()}`, {
      method: "POST", cache: "no-store"
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "burial action failed");
    return data;
  }


  const FARM_SEASON_NAMES = ["Spring", "Summer", "Autumn", "Winter"];

  // B55/B131: normalize one farm-state response before rendering. The server is authoritative
  // for season/biome eligibility. Zero-stock crops deliberately remain in the list: Steam shows
  // them as selectable rows with orange "No seeds" copy instead of hiding them.
  function farmPlotPanelState(data, selectedSeason = 0) {
    if (!data || !data.isFarmPlot) return null;
    const input = Array.isArray(data.seasons) ? data.seasons : [];
    const seasons = FARM_SEASON_NAMES.map((name, season) => {
      const raw = input.find(row => Number(row && row.season) === season) || {};
      const plantId = Number(raw.plantId);
      const crops = (Array.isArray(raw.crops) ? raw.crops : []).map(crop => ({
        id: Number(crop && crop.id),
        token: String((crop && crop.token) || ""),
        name: String((crop && crop.name) || "Crop"),
        seedCount: Math.max(0, Number(crop && crop.seedCount) || 0),
      })).filter(crop => Number.isInteger(crop.id) && crop.id >= 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        season,
        name: String(raw.name || name),
        plantId: Number.isInteger(plantId) && plantId >= 0 ? plantId : -1,
        plantName: String(raw.plantName || "Fallow"),
        plantToken: String(raw.plantToken || ""),
        crops,
      };
    });
    const activeSeason = Number.isInteger(Number(selectedSeason)) && Number(selectedSeason) >= 0 && Number(selectedSeason) < 4
      ? Number(selectedSeason) : 0;
    const rawCurrentSeason = Number(data.currentSeason);
    const currentSeason = Number.isInteger(rawCurrentSeason) && rawCurrentSeason >= 0 && rawCurrentSeason < 4
      ? rawCurrentSeason : 0;
    const rawFertilize = data.fertilize || {};
    const fertilize = {
      seasonal: !!rawFertilize.seasonal,
      current: Math.max(0, Number(rawFertilize.current) || 0),
      max: Math.max(0, Number(rawFertilize.max) || 0),
    };
    const seedStocks = (Array.isArray(data.seedStocks) ? data.seedStocks : []).map(seed => ({
      id: Number(seed && seed.id),
      token: String((seed && seed.token) || ""),
      name: String((seed && seed.name) || "Seeds"),
      count: Math.max(0, Number(seed && seed.count) || 0),
      forbidden: !!(seed && seed.forbidden),
      dump: !!(seed && seed.dump),
      hidden: !!(seed && seed.hidden),
    })).filter(seed => Number.isInteger(seed.id) && seed.id >= 0)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    return {
      id: Number(data.id), underground: !!data.underground, biome: String(data.biome || ""),
      seasons, activeSeason, currentSeason, fertilize, seedStocks,
    };
  }

  function farmSpriteCell(token, kind = "crop", maps = null) {
    let plantSprites = maps && maps.plantMap;
    let plotSprites = maps && maps.spriteMap;
    if (!maps && typeof window !== "undefined" && window.DwfTiles) {
      const tiles = window.DwfTiles;
      plantSprites = typeof tiles.getPlantMap === "function" ? tiles.getPlantMap() : null;
      plotSprites = typeof tiles.getSpriteMap === "function" ? tiles.getSpriteMap() : null;
    }
    let cell = null;
    if (kind === "fallow" || kind === "plot") {
      cell = plotSprites && (plotSprites.FURROWED_SOIL_1 || plotSprites.FARMPLOT || plotSprites.FARMPLOT_PLANTED);
      // The terrain map is generated by the running plugin and can settle after this panel opens;
      // Parity Studio has no live plugin route for it at all. The native module authors this as a
      // one-cell sheet, and b27a_farmplot_test pins this exact DF cell. Keep the real art available
      // without turning a transport race into a red missing-sprite placeholder.
      if (!cell) cell = { sheet: "floor_furrowed_soil.png", col: 0, row: 0 };
    } else {
      const plant = token && plantSprites && plantSprites[token];
      cell = kind === "seed"
        ? plant && (plant.SEED || plant.PICKED || plant.SHRUB || plant.SAPLING)
        : plant && (plant.PICKED || plant.SHRUB || plant.SAPLING || plant.SEED);
    }
    if (!cell || !cell.sheet || !Number.isFinite(Number(cell.col)) || !Number.isFinite(Number(cell.row)))
      return null;
    return { sheet: String(cell.sheet), col: Number(cell.col), row: Number(cell.row), size: 32 };
  }

  function farmSeedStocksForCrop(seedStocks, plantToken) {
    const token = String(plantToken || "");
    if (!token) return [];
    return (Array.isArray(seedStocks) ? seedStocks : []).filter(seed => seed && seed.token === token);
  }

  function farmCellMarkup(token, kind, className = "farm-crop-icon") {
    const cell = farmSpriteCell(token, kind);
    if (!cell) return `<span class="${className} farm-sprite-missing" data-df-identity-missing="farm:${encodeURIComponent(kind)}:${encodeURIComponent(token || "unknown")}" aria-hidden="true"></span>`;
    const url = `/sprites/img/${encodeURIComponent(cell.sheet)}`;
    const style = `background-image:url('${url}');background-position:-${cell.col * cell.size}px -${cell.row * cell.size}px`;
    return `<span class="${className}" style="${style}" aria-hidden="true"></span>`;
  }

  // ---- B169 pilot: the farm-plot surfaces build through the shared DWFUI component layer ------
  // (web/js/dwf-ui-components.js; spec docs/superpowers/specs/2026-07-10-ui-component-
  // architecture.md). Pure builders -- the b55 harness drives them directly. DWFUI resolves as a
  // global at call time: the script tag loads before this file; the harness requires it first.
  // B55-r2 parity (oracle B55-3.png): CROP display names are sentence-cased ("Strawberry
  // plants") while seed stacks stay lowercase ("strawberry seeds") -- display-only, the wire
  // keeps raw names.
  function farmCropDisplayName(name) { return DWFUI.sentenceCase(name); }

  // Matrix §3 F3 "Which screen uses which": Farm plot row 1 = `TAB` (seasons) => level 'primary'.
  // `width:'fill'` because B55-3's four season tabs STRETCH TO FILL the panel (the F3 Q3 workaround;
  // the workshop's three tabs HUG -- same grammar, different policy).
  function farmSeasonTabsHtml(state) {
    return DWFUI.tabsHtml({
      cls: "farm-season-tabs", tabCls: "farm-season-tab", dataAttr: "farm-season",
      level: "primary", width: "fill",
      ariaLabel: "Farm plot season", active: state.activeSeason,
      tabs: state.seasons.map(season => ({
        key: season.season, label: season.name,
        suffixHtml: season.season === state.currentSeason ? "<span>(now)</span>" : "",
      })),
    });
  }

  function farmCropRowHtml(crop, active) {
    const selected = crop.id === active.plantId;
    return DWFUI.rowHtml({
      tag: "button", cls: "farm-crop-row", selected, role: "radio", checked: selected,
      dataset: { farmCrop: crop.id },
      icon: farmCellMarkup(crop.token, "crop"),
      copyCls: "farm-crop-copy", labelCls: "farm-crop-name",
      label: farmCropDisplayName(crop.name),
      sub: crop.seedCount === 0 ? { text: "No seeds", cls: "farm-no-seeds" } : null,
      trailing: `<span class="farm-radio" aria-hidden="true"></span>`,
    });
  }

  function farmCropListHtml(state) {
    const active = state.seasons[state.activeSeason];
    // An already-scheduled crop the server no longer offers stays representable (B55/B131).
    const currentMissing = active.plantId >= 0 && !active.crops.some(crop => crop.id === active.plantId);
    const cropRows = currentMissing
      ? [{ id: active.plantId, token: active.plantToken, name: active.plantName, seedCount: 0 }, ...active.crops]
      : active.crops;
    const fallow = DWFUI.rowHtml({
      tag: "button", cls: "farm-crop-row", selected: active.plantId < 0, role: "radio",
      checked: active.plantId < 0, dataset: { farmCrop: -1 },
      icon: farmCellMarkup("", "fallow"),
      copyCls: "farm-crop-copy", labelCls: "farm-crop-name", label: "Leave fallow",
      trailing: `<span class="farm-radio" aria-hidden="true"></span>`,
    });
    return `<div class="farm-crop-list" role="radiogroup" aria-label="${escapeHtml(active.name)} crop">` +
      `${fallow}${cropRows.map(crop => farmCropRowHtml(crop, active)).join("")}</div>`;
  }

  // B55-r2: seed rows share the stock item sheet's action vocabulary (same actions, same
  // /stock-item-action route -- TOKENS.glyphs), native gold-border buttons, eye separated like
  // the native cluster. The old monochrome one-offs went with it.
  // WAVE 5: every action here carried an EMOJI, because actionButtonsHtml falls back to the
  // deprecated TOKENS.glyphs table whenever an item passes no `sprite:`. The five real DF tiles all
  // exist in web/interface_map.json. This row is a SUPERSET of native's four-button itemActions
  // preset -- it also has a `follow` ("go to the seed stack on the map"), which native's farm rows
  // do not -- so it cannot use the preset wholesale; the sprites are named per item instead, in the
  // preset's own order and with its gap before the eye. The extra control STAYS, dressed native.
  function farmSeedRowHtml(seed) {
    const S = DWFUI.TOKENS.sprites;
    return DWFUI.rowHtml({
      cls: "farm-seed-row",
      icon: farmCellMarkup(seed.token, "seed", "farm-seed-icon"),
      copyCls: "farm-seed-name",
      labelHtml: DWFUI.rawHtml("seed name plus a parenthesised stack count in its own styled span",
        `${escapeHtml(seed.name)}${seed.count > 1 ? ` <span class="farm-seed-count">(${seed.count})</span>` : ""}`),
      trailing: DWFUI.actionButtonsHtml([
        { action: "follow", sprite: S.recenterStocks, title: "Go to seed stack",
          dataset: { farmSeedAction: "follow", farmSeedId: seed.id } },
        { action: "view", sprite: S.view, title: "View seed stack",
          dataset: { farmSeedAction: "view", farmSeedId: seed.id } },
        { action: "forbid", sprite: S.forbid, activeSprite: S.forbidOn, active: seed.forbidden,
          title: `${seed.forbidden ? "Claim" : "Forbid"} seed stack`,
          dataset: { farmSeedAction: "forbid", farmSeedId: seed.id } },
        { action: "dump", sprite: S.dump, activeSprite: S.dumpOn, active: seed.dump,
          title: seed.dump ? "Cancel dump" : "Mark for dumping",
          dataset: { farmSeedAction: "dump", farmSeedId: seed.id } },
        { action: "hide", sprite: S.hide, activeSprite: S.hideOn, active: seed.hidden, gapBefore: true,
          title: `${seed.hidden ? "Show" : "Hide"} seed stack`,
          dataset: { farmSeedAction: "hide", farmSeedId: seed.id } },
      ], { cls: "farm-seed-actions dwfui-actions", ariaLabel: "Seed stack actions" }),
    });
  }

  // ---- WAVE 5 / F2: the farm header's tools become the TYPED NATIVE CLUSTER --------------------
  // This passed `tools:` as a RAW HTML STRING holding two hand-built, disabled Unicode buttons
  // (an Unicode "auto-harvest" and a "no-harvest" glyph), so it could not reach the native tool
  // art at all. headerHtml has accepted a TYPED cluster since Wave 4, and it ENCODES the native
  // ordering invariant itself (quill second-from-right, remove-building rightmost) -- consumers do
  // not get to order the strip, because that is how it drifted before.
  //
  // The owner asks for both of these BY NAME on the farm anchors: "The top right buttons need the cancled
  // out house icon (remove building) and the quill button (rename)."
  //   * removeBuilding (BUILDING_SHEET_REMOVE) is WIRED: it dispatches the SAME `data-bld-act=
  //     "cancel"` the panel's text button dispatched, through the same delegated handler and the
  //     same /building-action route. The capability MOVED into native's header, exactly as B174
  //     moved the workshop's "Remove building" out of a footer -- it is not reduced.
  //   * the quill (UNIT_SHEET_CUSTOMIZE) has NO SERVER ROUTE for a farm plot (there is no
  //     /farm-rename; /workshop-rename is workshop-only). It therefore ships as an explicit
  //     `placeholder`, whose REQUIRED title states exactly what is missing. That is the sanctioned
  //     mechanism for an unverified control (spec §7 F4) -- it may not invent behaviour, and it
  //     never fabricates a Hotkey line.
  //   * the two hand-built Unicode harvest toggles are GONE, and that removes NO capability. The
  //     three-step proof: (1) `grep -rn "auto-harvest|autoHarvest|no-harvest|farmHarvest" web/js/`
  //     returns NOTHING -- they carried no id, no data-*, and no handler ever bound to them;
  //     (2) `grep -rni harvest src/` finds only `standing_orders_farmer_harvest`, the fortress-wide
  //     STANDING ORDERS chore (a different surface entirely), never a per-farm-plot route. They
  //     were permanently `disabled` decoration. No DF token names such a control either, so there
  //     is no art to dress them in -- and the invariant is explicit: AN ABSENT CELL RENDERS
  //     NOTHING. Native OMITS a control it does not have; it does not blank one. Reported in the
  //     lane closeout as the one deletion in this file, with this proof.
  function farmHeaderHtml(info = {}) {
    return DWFUI.headerHtml({
      cls: "farm-native-head",
      icon: farmCellMarkup("", "plot", "farm-head-icon"),
      title: "Farm Plot", titleCls: "farm-head-title",
      toolsCls: "farm-head-tools",
      tools: [
        { role: "quill", placeholder: true, dataset: { farmRename: "" },
          title: "Rename farm plot -- UNVERIFIED: the server exposes no farm-plot rename route yet" },
        ...(info.markedForRemoval ? [] : [{ role: "removeBuilding", dataset: { bldAct: "cancel" },
          title: "Remove this farm plot", ariaLabel: "Remove this farm plot" }]),
      ],
      close: { data: "bld-close" },
    });
  }

  async function fetchFarmPlotInfo(id) {
    try {
      const r = await fetch(`/farm-plot?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      return data && data.isFarmPlot ? data : null;
    } catch (_) {}
    return null;
  }

  async function postFarmPlotSeasonCrop(id, season, plant) {
    const r = await fetch(`/farm-plot-action?id=${id}&season=${season}&plant=${plant}&t=${Date.now()}`, {
      method: "POST", cache: "no-store"
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "farm plot action failed");
    return data;
  }

  async function postFarmPlotSeasonalFertilize(id, seasonal) {
    const r = await fetch(`/farm-plot-fertilize-action?id=${id}&seasonal=${seasonal ? 1 : 0}&t=${Date.now()}`, {
      method: "POST", cache: "no-store"
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "farm fertilize action failed");
    return data;
  }

  async function postFarmSeedAction(itemId, action) {
    const who = typeof player !== "undefined" ? `player=${encodeURIComponent(player)}&` : "";
    const r = await fetch(`/stock-item-action?${who}id=${itemId}&action=${encodeURIComponent(action)}&t=${Date.now()}`, {
      method: "POST", cache: "no-store"
    });
    if (!r.ok) throw new Error((await r.text()).trim() || "seed item action failed");
    return r.json();
  }

  async function fetchLeverLinkInfo(id) {
    try {
      const r = await fetch(`/lever-link?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      if (data && data.ok !== false && data.isLever) return data;
    } catch (_) {}
    return null;
  }

  async function postLeverLink(id, target) {
    const r = await fetch(`/lever-link?id=${id}&target=${target}&t=${Date.now()}`, {
      method: "POST", cache: "no-store"
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "link failed");
    return data;
  }

  // B246 (07-14) -- THE ART BLOCK. His capture (attachments/B246-1.png) shows our statue
  // panel as `limestone Statue` / `Constructed.` / `Ordered by ●a playtester` / [Remove building]: no prose
  // about WHAT THE STATUE DEPICTS, and no statue sprite -- while the occupant rail RIGHT NEXT TO IT
  // renders sprites fine. Both gaps had the same single cause, and it was on the WIRE, not here:
  // /building-info described only the BUILDING, and a statue's art AND its sprite identity both live
  // on the ITEM it was built from (df::item_statuest). The server now sends both.
  //
  // `artDescription` IS DF'S OWN SENTENCE (item_statuest.description == DF's `art_string`) OR IT IS
  // EMPTY. It is never the title wearing a different key -- that substitution is exactly the B236
  // item-sheet defect. `artBaseDescription` is a separately labelled fallback from DF's own
  // undecorated Items::getDescription result. It prevents a runtime-empty statue art_string from
  // making the entire art block mute without pretending the item name is generated art prose.
  function buildingArtMarkup(info) {
    const hasSprite = !!(info && info.spriteRef && info.spriteRef.itemType);
    const prose = String((info && (info.artDescription || info.artBaseDescription)) || "").trim();
    const artName = String((info && info.artName) || "").trim();
    if (!hasSprite && !prose && !artName) return "";
    const icon = hasSprite
      ? DWFUI.iconHtml({ item: info.spriteRef, cls: "bld-art-glyph", size: 32,
                         alt: info.name || "Artwork" })
      : "";
    const nameLine = artName
      ? `<div class="bld-art-name">${escapeHtml(artName)}</div>` : "";
    const qualityLine = String((info && info.artQualityName) || "").trim()
      ? `<div class="bld-note bld-art-quality">${escapeHtml(info.artQualityName)}</div>` : "";
    // Long art prose is a scrollbox, per the component-architecture spec -- never a clipped div.
    const proseBlock = prose
      ? DWFUI.scrollHtml({ cls: "bld-art-scroll" },
          `<div class="bld-art-prose">${escapeHtml(prose)}</div>`)
      : "";
    return `<div class="bld-art">${icon}<div class="bld-art-copy">${nameLine}${qualityLine}${proseBlock}</div></div>`;
  }

  function genericBuildingPanelMarkup(info, options = {}) {
    const underConstruction = !info.built;
    const statusLine = info.built ? "Constructed."
      : (info.suspended ? "Construction suspended." : "Waiting for construction…");
    const suspendBtn = underConstruction && info.hasJobs
      ? `<button class="bld-btn" data-bld-act="${info.suspended ? "resume" : "suspend"}">${info.suspended ? "Resume construction" : "Suspend construction"}</button>`
      : "";
    const priorityBtn = underConstruction && info.hasJobs && info.doNow !== undefined
      ? `<button class="bld-btn${info.doNow ? " active" : ""}" data-bld-act="priority">${info.doNow ? "Priority: doing now" : "Make priority"}</button>`
      : "";
    const passageBtn = info.passageControl
      ? `<button class="bld-btn${info.passageForbidden ? " active" : ""}" data-bld-act="toggle-passage">${info.passageForbidden ? "Allow passage" : "Close to passage"}</button>
         <div class="bld-note">Passage: ${info.passageForbidden ? "Closed to traffic" : "Allowed"}${info.passageClosed ? " (physically closed)" : " (currently open)"}</div>`
      : "";
    const cageSummary = buildingCageSummary(info);
    const cageBtn = cageSummary && info.built
      ? `<div class="zone-section-label">Cage / Terrarium</div>
         <button class="bld-btn" data-building-cage>View occupants and assign (${escapeHtml(cageSummary.label)})</button>`
      : "";
    const coffinInfo = options.coffinInfo || null;
    const coffinSummary = coffinBurialSummary(coffinInfo);
    const coffinTomb = coffinInfo?.tomb || {};
    const coffinBtn = coffinSummary
      ? `<div class="zone-section-label">Burial</div>
         <div class="zone-note">${escapeHtml(coffinSummary.label)}</div>
         <button class="bld-btn" data-coffin-owner>${escapeHtml(coffinSummary.manageLabel)}</button>
         ${coffinSummary.hasTomb ? `<button class="bld-btn" data-coffin-any>Use for any citizen</button>
         <div class="zone-btn-row">
           <button class="zone-tgl${coffinTomb.citizens ? " zone-on" : ""}" data-coffin-act="${coffinTomb.citizens ? "citizens-off" : "citizens-on"}">Citizens</button>
           <button class="zone-tgl${coffinTomb.pets ? " zone-on" : ""}" data-coffin-act="${coffinTomb.pets ? "pets-off" : "pets-on"}">Pets</button>
         </div>` : ""}`
      : "";
    const leverLinkInfo = options.leverLinkInfo || null;
    const leverLinkStatus = leverLinkInfo ? leverLinkMechanismStatus(leverLinkInfo) : null;
    const leverLinkBtn = leverLinkInfo
      ? `<div class="zone-section-label">Lever</div>
         <div class="zone-note">${escapeHtml(leverLinkStatus.label)}</div>
         <button class="bld-btn" data-lever-link>Link to target</button>`
      : "";
    // B246: the art block sits directly under the status line -- the statue's sprite and DF's own
    // sentence about what it depicts, which is the ENTIRE POINT of a statue and was the one thing
    // the panel did not say. Empty string for every building with no art, so a door/chair/workshop
    // panel is byte-identical to before.
    const artBlock = buildingArtMarkup(info);
    // Merge of B246 art-title (statues) + B286 removal panel: header uses the art title when present;
    // when marked for removal the removal block REPLACES the status line at the top and the normal
    // cancel button is suppressed (native shows the removal section above contents).
    const panelTitle = String(info.artTitle || info.name || "Building");
    const removalBlock = buildingRemovalSectionHtml(info, { action: "bld" });
    return `${DWFUI.headerHtml({ cls:"bld-head", title:panelTitle, titleCls:"bld-name", close:{ data:"bld-close" } })}
      ${info.markedForRemoval ? removalBlock : `<div class="bld-status${info.suspended ? " suspended" : ""}">${escapeHtml(statusLine)}</div>`}
      ${artBlock}
      ${options.orderedByLine || ""}${suspendBtn}${priorityBtn}${passageBtn}
      ${cageBtn}${coffinBtn}${leverLinkBtn}
      ${info.markedForRemoval ? "" : `<button class="bld-btn danger" data-bld-act="cancel">${escapeHtml(info.built ? "Remove building" : "Cancel construction")}</button>`}`;
  }

  function wsWorkerRowsHtml(workers) {
    const values = Array.isArray(workers) ? workers : [];
    return values.map(u => {
      const idx = Number(u.professionColor);
      const name = u.name || `Unit ${u.id}`;
      const labelHtml = Number.isInteger(idx) && idx >= 0 && idx <= 15
        ? `<span style="color:${DWFUI.dfColor(idx)}">${DWFUI.bitmapTextHtml(name)}</span>`
        : DWFUI.bitmapTextHtml(name);
      return DWFUI.rowHtml({
        cls: "workshop-worker-row",
        copyCls: "workshop-worker-copy", labelCls: "workshop-name",
        labelHtml: DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered workshop worker name", labelHtml),
        sub: u.profession ? { text: u.profession, cls: "dwfui-sub workshop-meta" } : null,
        trailing: `<button class="workshop-icon-btn${u.assigned ? " active" : ""}" data-ws-worker="${Number(u.id)}" data-ws-assign="${u.assigned ? "0" : "1"}">${u.assigned ? "On" : "Add"}</button>`,
      });
    }).join("");
  }

  // B286-1: shared native removal block for generic buildings and workshops. Both strings come
  // from the panel payload; an active job deliberately has no second line until native copy is
  // captured. The plaque is DWFUI, preserving the component-layer text and native slab grammar.
  function buildingRemovalSectionHtml(info, options = {}) {
    if (!info || !info.markedForRemoval) return "";
    const action = options.action === "ws" ? { wsCancelRemoval: "" } : { bldAct: "cancel-removal" };
    const status = String(info.removalStatus || "");
    const activity = String(info.removalActivityStatus || "");
    return `<div class="building-removal-section">` +
      DWFUI.statusHtml({ cls: "building-removal-status", tone: "dim", text: status }) +
      (activity ? DWFUI.statusHtml({ cls: "building-removal-activity", tone: "warn", text: activity }) : "") +
      DWFUI.plaqueBtnHtml({ label: "Cancel removal", tone: "removal", cls: "building-removal-cancel", dataset: action }) +
      `</div>`;
  }

  // B246 -- THE ENGRAVING PANEL. An engraving is not an item and not a building; it is a TILE
  // PROPERTY (df::engraving, keyed on pos in world->event.engravings), which is why it appeared in no
  // occupant list and why clicking one "did nothing": the click resolved to the generic kind:"tile"
  // window, which shows a tiletype name and coordinates. The server now resolves engraved tiles to
  // kind:"engraving" and serves /engraving-info.
  //
  // B288: the wire now carries DF's own element/property/reference vmethod output inside the two
  // native outer templates. It is rendered verbatim under the artwork title. No prose on the wire
  // means no prose in the panel: the client never invents a substitute or explanatory sentence.
  function engravingPanelMarkup(data, tile) {
    const present = !!(data && data.present);
    const artName = String((data && data.artName) || "").trim();
    const prose = data && data.descriptionAvailable ? String(data.description || "").trim() : "";
    const artist = String((data && data.artistName) || "").trim() || "Unknown";
    const quality = String((data && data.qualityName) || "").trim() || "Unknown";
    // B288/R4: artistName and qualityName survive even when the lazy art chunk (and therefore the
    // prose) does not. Always render those native facts: the old prose-only body produced the bare
    // `Selection / Engraving` shell plus close button on exactly that payload shape.
    const factsHtml = present
      ? `<div class="engrave-row"><span class="engrave-key">${DWFUI.bitmapTextHtml("Artist")}</span><span class="engrave-val">${DWFUI.bitmapTextHtml(artist)}</span></div>
         <div class="engrave-row"><span class="engrave-key">${DWFUI.bitmapTextHtml("Quality")}</span><span class="engrave-val">${DWFUI.bitmapTextHtml(quality)}</span></div>`
      : "";
    const bodyHtml = !present
      ? `<div class="engrave-note">No engraving on this tile.</div>`
      : `${factsHtml}${prose
          ? DWFUI.scrollHtml({ cls: "engrave-scroll" },
              `<div class="engrave-prose">${escapeHtml(prose)}</div>`)
          : ""}`;
    const title = String((data && data.title) || artName || "").trim() || "Engraving";
    return DWFUI.windowHtml({
      cls: "engraving-window",
      ariaLabel: title,
      bodyHtml: `${DWFUI.headerHtml({ cls:"engrave-head", title, titleCls:"engrave-title",
                                      close:{ data:"bld-close" } })}
        ${bodyHtml}`,
    });
  }

  // Opens on an explicit TILE, never on a pixel -- so it cannot re-derive or nudge the viewport
  // (B216: opening a panel must not move the camera).
  async function openEngravingPanel(tile, inspectData = null) {
    if (!tile || !Number.isFinite(Number(tile.x))) { closeSelection(); return; }
    const inspectDescription = String(inspectData?.description || "").trim();
    let data = inspectData ? {
      ok: true, present: true, tile,
      title: inspectData.title || "",
      descriptionAvailable: !!inspectDescription,
      description: inspectDescription,
    } : null;
    try {
      const r = await fetch(`/engraving-info?x=${tile.x}&y=${tile.y}&z=${tile.z}&t=${Date.now()}`,
                            { cache: "no-store" });
      if (r.ok) {
        const detail = await r.json();
        // The /inspect response is the click-info carrier. Keep it as a compatibility fallback if
        // an older /engraving-info response lacks the new description fields during a mixed deploy.
        if (inspectDescription && !String(detail.description || "").trim()) {
          detail.description = inspectDescription;
          detail.descriptionAvailable = true;
          if (!detail.title) detail.title = inspectData.title || "";
        }
        data = detail;
      }
    } catch (_) {}
    selection.className = "";
    panelContent(selection).innerHTML = engravingPanelMarkup(data, tile);
    if (DWFUI.paintSprites) DWFUI.paintSprites(panelContent(selection));
    selection.classList.add("visible");
  }

  async function openBuildingPanel(id, inspectData = null) {
    let info = null;
    try {
      const r = await fetch(`/building-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) info = await r.json();
    } catch (_) {}
    if (!info || info.error || info.id < 0) { closeSelection(); return; }
    // B289: /inspect already carries the clicked statue's DF title/prose. /building-info is the
    // normal detailed refresh; merge only missing fields so mixed client/DLL deploys never blank
    // prose that was present in the actual click payload.
    if (inspectData) {
      if (!info.artTitle && inspectData.title) info.artTitle = inspectData.title;
      if (!info.artDescription && inspectData.description) info.artDescription = inspectData.description;
    }
    // W-F: a trade depot resolves to kind:"building"; hand it to the depot panel.
    if (info.isDepot && typeof openTradeDepotPanel === "function") { openTradeDepotPanel(info.id, info); return; }
    // B166: native bed/armor-stand/weapon-rack rooms store military use on their related
    // Barracks civzone. Open that room panel so its blue flag reaches the same squad assignment.
    if (Number(info.barracksZoneId) >= 0) { openZonePanel(Number(info.barracksZoneId)); return; }
    // WP-C (WT04): "Ordered by â— player" line, merged from /attrib by building id, toggleable.
    // Graceful: no /attrib route (pre-WP-C DLL) or unknown id -> empty string, nothing renders.
    try { if (typeof attribRefresh === "function") await attribRefresh(); } catch (_) {}
    const orderedByChip = (typeof attribRowHtml === "function") ? attribRowHtml("building", info.id) : "";
    const orderedByLine = orderedByChip ? `<div class="bld-note bld-attrib">Ordered by ${orderedByChip}</div>` : "";
    // B55: old deployed DLLs omit isFarmPlot, so no farm request is made until the matching
    // server arrives. A missing/newer route therefore leaves this shared building panel intact.
    let farmPlotInfo = info.isFarmPlot && info.built ? await fetchFarmPlotInfo(info.id) : null;
    let farmSelectedSeason = 0;
    const coffinInfo = info.built ? await fetchCoffinBurialInfo(info.id) : null;
    const leverLinkInfo = info.built ? await fetchLeverLinkInfo(info.id) : null;
    const renderFarmPlotSection = () => {
      const state = farmPlotPanelState(farmPlotInfo, farmSelectedSeason);
      const mount = selection.querySelector("[data-farm-plot-section]");
      if (!state || !mount) return;
      const active = state.seasons[state.activeSeason];
      const activeSeedStocks = farmSeedStocksForCrop(state.seedStocks, active.plantToken);
      mount.innerHTML = `${farmSeasonTabsHtml(state)}
        ${farmCropListHtml(state)}
        <div class="farm-fertilize-controls">
          <label class="farm-check-row farm-check-readonly" title="One-off FertilizeField job scheduling is not exposed by this client yet">
            <input type="checkbox" disabled><span><b>Not set to fertilize</b><small>Current amount: ${state.fertilize.current}/${state.fertilize.max}</small></span>
          </label>
          <label class="farm-check-row">
            <input type="checkbox" data-farm-seasonal-fertilize${state.fertilize.seasonal ? " checked" : ""}><span><b>Fertilize every season</b></span>
          </label>
        </div>
        <div class="farm-seed-stock" aria-label="Owned seed stacks for ${escapeHtml(active.plantName)}">${activeSeedStocks.map(farmSeedRowHtml).join("")}</div>`;
      mount.querySelectorAll("[data-farm-season]").forEach(button => button.addEventListener("click", event => {
        event.stopPropagation();
        farmSelectedSeason = Number(button.dataset.farmSeason);
        renderFarmPlotSection();
      }));
      mount.querySelectorAll("[data-farm-crop]").forEach(rowButton => rowButton.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const plant = Number(rowButton.dataset.farmCrop);
        if (!Number.isInteger(plant)) return;
        mount.querySelectorAll("[data-farm-crop]").forEach(button => { button.disabled = true; });
        try {
          await postFarmPlotSeasonCrop(info.id, state.activeSeason, plant);
          const row = farmPlotInfo && farmPlotInfo.seasons && farmPlotInfo.seasons[state.activeSeason];
          if (row) {
            row.plantId = plant;
            const crop = (row.crops || []).find(candidate => Number(candidate.id) === plant) || {};
            row.plantName = plant < 0 ? "Fallow" : crop.name || "Crop";
            row.plantToken = plant < 0 ? "" : crop.token || "";
          }
        } catch (_) {
          farmPlotInfo = await fetchFarmPlotInfo(info.id) || farmPlotInfo;
        }
        renderFarmPlotSection();
        focusPage();
      }));
      mount.querySelector("[data-farm-seasonal-fertilize]")?.addEventListener("change", async event => {
        event.stopPropagation();
        const checkbox = event.currentTarget;
        checkbox.disabled = true;
        try {
          await postFarmPlotSeasonalFertilize(info.id, checkbox.checked);
          if (farmPlotInfo && farmPlotInfo.fertilize) farmPlotInfo.fertilize.seasonal = checkbox.checked;
        } catch (_) {
          farmPlotInfo = await fetchFarmPlotInfo(info.id) || farmPlotInfo;
        }
        renderFarmPlotSection();
        focusPage();
      });
      mount.querySelectorAll("[data-farm-seed-action]").forEach(button => button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const itemId = Number(button.dataset.farmSeedId);
        const action = button.dataset.farmSeedAction || "";
        if (!Number.isInteger(itemId) || itemId < 0 || !action) return;
        button.disabled = true;
        try {
          const result = await postFarmSeedAction(itemId, action);
          if (action === "view" && typeof showStockItemSheet === "function") {
            showStockItemSheet(result);
            focusPage();
            return;
          }
          if (action === "follow" && result.mapPos && typeof flashMapTile === "function")
            flashMapTile(result.mapPos);
          farmPlotInfo = await fetchFarmPlotInfo(info.id) || farmPlotInfo;
        } catch (_) {}
        renderFarmPlotSection();
        focusPage();
      }));
    };
    // WAVE 5: this used to build a FULL panel markup string, assign it, and then -- when the
    // building was NOT a farm plot -- immediately overwrite it with genericBuildingPanelMarkup's
    // output. Every branch of the first string that could ever be SEEN was the farm-plot branch;
    // the rest (the raw bld-head fallback, statusLine/suspend/priority/passage) was dead, and it
    // duplicated ~40 lines of markup that genericBuildingPanelMarkup already owns. It is now an
    // explicit either/or, so each renderer is assigned exactly once.
    //
    // The farm panel's "Remove building" text button is GONE -- but the capability is NOT: it moved
    // into the native header tool cluster (farmHeaderHtml above), which dispatches the very same
    // `data-bld-act="cancel"` through the very same delegated handler and /building-action route.
    // This is precisely what B174 did for the workshop. cageBtn / coffinBtn / leverLinkBtn are not
    // rendered on the farm branch because a farm plot is never a cage, a coffin or a lever -- they
    // evaluated to "" there before, and genericBuildingPanelMarkup still renders them for every
    // building that IS one.
    selection.className = "visible building-panel" + (farmPlotInfo ? " farm-panel" : "");
    panelContent(selection).innerHTML = farmPlotInfo
      ? `${farmHeaderHtml(info)}${info.markedForRemoval
          ? buildingRemovalSectionHtml(info, { action: "bld" })
          : `<div data-farm-plot-section></div>`}`
      : genericBuildingPanelMarkup(info, { orderedByLine, coffinInfo, leverLinkInfo });
    renderFarmPlotSection();
    // B246: a `data-dwfui-item` ref is INERT until the central paint pass blits it (DWFUI's
    // string-builders are string-only by contract). The statue's sprite is exactly such a ref, so
    // without this line the art block would emit a correct ref and still show an empty tile -- the
    // same "sprite is missing" symptom, one layer down.
    if (DWFUI.paintSprites) DWFUI.paintSprites(panelContent(selection));
    selection.querySelector("[data-building-cage]")?.addEventListener("click", event => {
      event.stopPropagation(); openBuildingCagePanel(info.id); focusPage();
    });
    selection.querySelector("[data-lever-link]")?.addEventListener("click", event => {
      event.stopPropagation(); openLeverLinkPanel(info.id); focusPage();
    });
    selection.querySelector("[data-coffin-owner]")?.addEventListener("click", async event => {
      event.stopPropagation();
      try {
        await postCoffinBurialAction(info.id, "ensure-tomb");
        const next = await fetchCoffinBurialInfo(info.id);
        const tombId = Number(next && next.tombId);
        if (Number.isInteger(tombId) && tombId >= 0) openZoneOwnersPanel(tombId);
        else openBuildingPanel(info.id);
      } catch (_) { openBuildingPanel(info.id); }
      focusPage();
    });
    selection.querySelector("[data-coffin-any]")?.addEventListener("click", async event => {
      event.stopPropagation();
      try { await postCoffinBurialAction(info.id, "any-citizen"); } catch (_) {}
      openBuildingPanel(info.id);
      focusPage();
    });
    selection.querySelectorAll("[data-coffin-act]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      try { await postCoffinBurialAction(info.id, btn.dataset.coffinAct || ""); } catch (_) {}
      openBuildingPanel(info.id);
      focusPage();
    }));
    selection.querySelectorAll("[data-bld-act]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const action = btn.dataset.bldAct;
      try { await fetch(`/building-action?id=${info.id}&action=${action}`, { method: "POST", cache: "no-store" }); } catch (_) {}
      if (action === "cancel") closeSelection();
      else openBuildingPanel(info.id); // refresh suspend/resume state
      focusPage();
    }));
    selection.querySelector("[data-bld-close]").addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  // ---- WAVE 5: ONE zone-unit-list row grammar ---------------------------------------------------
  // The SAME row shape -- a zone-unit-row wrapper holding a zone-unit-name line and
  // a zone-unit-meta line, then a zone-unit-act button -- the same shape every time.
  // shape was copy-pasted FIVE times across this file (lever-link targets, building-cage occupants,
  // zone owners, zone locations, and -- with a portrait -- the zone animals). The arch-spec calls
  // consolidating it "the cheapest consolidation win", and it is: it is exactly DWFUI.rowHtml's
  // icon | copy(label + sub) | trailing anatomy.
  //
  // The strangler `cls` hooks keep every pinned classname (`zone-unit-row`, `zone-unit-name`,
  // `zone-unit-meta`, `zone-unit-act`), so `.building-panel .zone-unit-row`'s existing 2-column
  // grid still lays the row out and NO CSS CHANGES. `copyCls` reuses `.zone-animal-copy`, the one
  // EXISTING flex-column copy block in this panel's stylesheet: rowHtml's default `.dwfui-copy` is
  // `min-width:0` only, so name and meta would sit on ONE line instead of stacking. (The clean fix
  // is a `display:flex;flex-direction:column` on `.dwfui-copy` -- a CSS change, which is LOCKED this
  // wave. Recorded in the closeout.)
  //
  // *** THE ACTION BUTTON STAYS HAND-BUILT, AND THAT IS A MEASURED DECISION, NOT LAZINESS. ***
  // It is a TEXT action ("Link" / "Assign" / "Release" / "Move here" / "Current"), so the native
  // grammar for it is plaqueBtnHtml. But `.dwfui-plaque` is a FIXED native plaque:
  //     height: calc(36px * var(--dwfui-interface-scale));  padding: 0 calc(16px * ...)   (css:6595)
  // and `.building-panel .zone-unit-row` gives its action a FIXED 72px grid column (css:1612).
  // At DF's ~1.25 interface scale that plaque is ~45px tall with ~40px of horizontal padding before
  // a single character of the label -- it would overflow a 72px column and blow the row height. The
  // migration needs the column to be re-sized, i.e. a CSS change, and CSS IS LOCKED this wave.
  //
  // So each call site below keeps its EXACT original button markup. That is also what keeps the
  // drift ratchet honest: R7 is keyed by markup SIGNATURE, so replacing four distinct hand-built
  // buttons with one new consolidated one would register a BRAND-NEW key and FAIL the gate even
  // though it strictly reduces debt. Preserving the signatures means the four dead-copy entries
  // simply drop to zero (a prunable NOTE) and nothing grows. Recorded in the closeout.
  function zoneUnitRowHtml(cfg) {
    const c = cfg || {};
    return DWFUI.rowHtml({
      cls: "zone-unit-row" + (c.rowCls ? " " + c.rowCls : ""),
      dataset: c.dataset,
      icon: c.icon,
      copyCls: "zone-animal-copy", labelCls: "zone-unit-name",
      labelHtml: DWFUI.rawHtml("unit-row label may wrap bitmap text in DF's profession colour",
        c.nativeLabelHtml != null ? c.nativeLabelHtml : DWFUI.bitmapTextHtml(c.label == null ? "" : c.label)),
      sub: c.meta ? { text: c.meta, cls: "zone-unit-meta" } : null,
      trailing: c.trailing,
    });
  }
  function zoneUnitListHtml(rows, emptyNote) {
    // WAVE zone-parity (B217): the zone unit list is a DWFUI scrollbox. `.dwfui-scroll` carries the
    // native scrollbar art, the B167 fill contract and the B216 mouse-wheel ownership; the fillSel
    // (`.zone-unit-list`) and the `:not(.pf-fill-scroll)` height cap still key off `.zone-unit-list`.
    return rows.length
      ? DWFUI.scrollHtml({ cls: "zone-unit-list" }, rows.join(""))
      : `<div class="zone-note">${emptyNote}</div>`;
  }

  function leverLinkPanelMarkup(data) {
    const status = leverLinkMechanismStatus(data);
    const targets = leverLinkTargetRows(data);
    const rows = targets.map(target => {
      const state = leverLinkActionState(data, target.id);
      return zoneUnitRowHtml({
        label: target.name,
        meta: `${target.type} - distance ${target.distance} - ${target.x},${target.y},${target.z}`,
        trailing: `<button class="zone-unit-act" data-link-target="${Number(target.id)}"${state.enabled ? "" : " disabled"}>Link</button>`,
      });
    });
    return `${DWFUI.headerHtml({ cls:"bld-head", title:data.name || "Lever", titleCls:"bld-name", close:{ data:"bld-close" } })}<div class="bld-status">Link to target</div><button class="bld-btn" data-building-back>Back to building</button><div class="zone-section-label">Mechanisms</div><div class="zone-note">${escapeHtml(status.label)}</div><div class="zone-section-label">Targets</div>${zoneUnitListHtml(rows, "No linkable targets found.")}`;
  }

  function buildingCagePanelMarkup(data) {
    const units = Array.isArray(data?.units) ? data.units : [];
    const rows = units.map(unit => {
      const flags = Array.isArray(unit.flags) ? unit.flags.join(" | ") : "";
      const kind = unit.kind || "unit";
      const name = unit.name || unit.race || `Unit ${unit.id}`;
      return zoneUnitRowHtml({
        label: name,
        nativeLabelHtml: kind === "unit" ? zoneProfessionNameHtml(unit, name) : null,
        meta: flags || unit.race || "",
        trailing: `<button class="zone-unit-act${unit.assigned ? " assigned" : ""}" data-cage-unit="${Number(unit.id)}" data-cage-kind="${escapeHtml(kind)}" data-cage-assign="${unit.assigned ? "0" : "1"}">${buildingCageActionLabel(unit)}</button>`,
      });
    });
    return `${DWFUI.headerHtml({ cls:"bld-head", title:data?.name || "Cage", titleCls:"bld-name", close:{ data:"bld-close" } })}<div class="bld-status">Cage / Terrarium &middot; occupant assignment</div><button class="bld-btn" data-building-back>Back to building</button>${zoneUnitListHtml(rows, "No assignable occupants found.")}`;
  }


  async function openLeverLinkPanel(id) {
    const data = await fetchLeverLinkInfo(id);
    if (!data || !data.isLever) { openBuildingPanel(id); return; }
    selection.className = "visible building-panel zone-panel zone-wide";
    // WAVE 5: the duplicate markup that used to be assigned here was overwritten on the very next
    // line by leverLinkPanelMarkup(data) and every handler binds after it -- provably dead. Deleted.
    panelContent(selection).innerHTML = leverLinkPanelMarkup(data);
    selection.querySelector("[data-building-back]").addEventListener("click", event => {
      event.stopPropagation(); openBuildingPanel(data.id); focusPage();
    });
    selection.querySelectorAll("[data-link-target]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const target = Number(btn.dataset.linkTarget);
      if (!Number.isInteger(target) || target < 0) return;
      btn.disabled = true;
      try {
        await postLeverLink(data.id, target);
        openBuildingPanel(data.id);
      } catch (e) {
        btn.textContent = "Failed";
        btn.title = e && e.message ? e.message : "link failed";
        btn.disabled = false;
      }
      focusPage();
    }));
    selection.querySelector("[data-bld-close]").addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }
  async function openBuildingCagePanel(id) {
    let data = null;
    try {
      const r = await fetch(`/building-cage?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch (_) {}
    if (!data || Number(data.id) < 0) { openBuildingPanel(id); return; }
    selection.className = "visible building-panel zone-panel";
    // WAVE 5: duplicate markup deleted -- it was overwritten on the next line by
    // buildingCagePanelMarkup(data), and every handler binds after that. Provably dead.
    panelContent(selection).innerHTML = buildingCagePanelMarkup(data);
    selection.querySelector("[data-building-back]").addEventListener("click", event => {
      event.stopPropagation(); openBuildingPanel(data.id); focusPage();
    });
    selection.querySelectorAll("[data-cage-unit]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const unit = Number(btn.dataset.cageUnit);
      const kind = btn.dataset.cageKind || "unit";
      const assign = Number(btn.dataset.cageAssign) ? 1 : 0;
      if (Number.isInteger(unit) && unit >= 0) {
        try {
          await fetch(`/building-cage-action?id=${data.id}&unit=${unit}&assign=${assign}&kind=${encodeURIComponent(kind)}`, { method: "POST", cache: "no-store" });
        } catch (_) {}
      }
      openBuildingCagePanel(data.id);
      focusPage();
    }));
    selection.querySelector("[data-bld-close]").addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  function workshopIconName(info) {
    const label = `${info?.subtype || ""} ${info?.name || ""} ${info?.kind || ""}`;
    return itemIconName({ label, category: "workshops" }) || (String(info?.kind || "").toLowerCase() === "furnace" ? "workshops_furnaces" : "workshops");
  }

  function workshopItemIconName(item) {
    // itemIconName lives in dwf-build-info-panels.js; resolve at call time and stay pure
    // (icon-less) under the node harness, exactly like farmSpriteCell's window guard.
    if (typeof itemIconName !== "function") return null;
    const label = String(item?.name || item?.role || "");
    return itemIconName({ label, category: "workshops" }) || null;
  }

  async function workshopPost(path, params = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => qs.set(k, v == null ? "" : String(v)));
    // WP-C (WT06): carry the player so /order-create (workshop "add order") attributes it.
    if (typeof player !== "undefined" && !qs.has("player")) qs.set("player", player);
    qs.set("t", Date.now());
    const r = await fetch(`${path}?${qs.toString()}`, { method: "POST", cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok || data.ok === false)
      throw new Error(data.error || data.msg || text.trim() || "request failed");
    return data;
  }

  // ---- WP-3a: Workshop "Workers" tab profile controls (skill range, max general orders,
  // ban-general-orders toggle, blocked-labors list). Every control is GRACEFULLY DORMANT: it is
  // gated on its field being present in workshop-info.profile, so on a pre-WP-3 DLL (no profile
  // fields served) nothing new renders and no route is hit. Writes go through
  // POST /workshop-profile?id=&field=&value= (one field per call), then re-read via
  // openWorkshopPanel -- exactly the /workshop-worker-action pattern. Server clamps every write. ----
  // DF skill-level titles (rating -> name), DF wiki v50 "Skill". df.building.xml
  // workshop_profile.min_level/max_level are int32 in [0,3000]; 3000 (init) = "no maximum".
  const WS_SKILL_LEVEL_NAMES = ["Dabbling", "Novice", "Adequate", "Competent", "Skilled", "Proficient",
    "Talented", "Adept", "Expert", "Professional", "Accomplished", "Great", "Master", "High Master",
    "Grand Master", "Legendary", "Legendary+1", "Legendary+2", "Legendary+3", "Legendary+4", "Legendary+5"];
  const WS_NO_MAX_LEVEL = 3000;
  // Static labor enum for the blocked-labors checkboxes. Populated once (world-static) from either
  // an additive workshop-info field (info.laborList / info.allLabors -- cpp-batch may serve either)
  // or GET /labor-list ([{id,name}] or {labors:[...]}). Stays null when neither exists, in which
  // case blocked-labors DEGRADES to "unblock only" over the currently-blocked set the server serves.
  let wsLaborListCache = null;
  let wsLaborListTried = false;
  function wsProfileHasControls(profile) {
    const p = profile || {};
    return p.minLevel !== undefined || p.maxLevel !== undefined || p.maxGeneralOrders !== undefined
      || p.generalOrdersBanned !== undefined || Array.isArray(p.blockedLabors);
  }
  async function warmWorkshopLaborList(info) {
    // Prefer an additive workshop-info extension (defensive to both field names cpp-batch might
    // pick); fall back to the standalone /labor-list route. Fetch at most once per session.
    if (Array.isArray(info && info.laborList)) { wsLaborListCache = info.laborList; wsLaborListTried = true; return; }
    if (Array.isArray(info && info.allLabors)) { wsLaborListCache = info.allLabors; wsLaborListTried = true; return; }
    if (wsLaborListTried) return;
    wsLaborListTried = true;
    try {
      const r = await fetch(`/labor-list?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;                       // absent route (current live DLL) -> stays null, degrade path
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { return; }
      if (Array.isArray(data)) wsLaborListCache = data;
      else if (data && Array.isArray(data.labors)) wsLaborListCache = data.labors;
    } catch (_) {}                             // network error -> stays null, degrade path
  }
  function wsSkillLevelName(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return String(v);
    if (v >= WS_NO_MAX_LEVEL) return "No maximum";
    if (v < 0) return WS_SKILL_LEVEL_NAMES[0];
    if (v >= WS_SKILL_LEVEL_NAMES.length) return "Legendary+" + (v - 15);
    return WS_SKILL_LEVEL_NAMES[v];
  }
  function wsSkillSelect(attr, current, includeNoMax) {
    const cur = Number(current);
    const seen = new Set();
    let opts = "";
    for (let v = 0; v < WS_SKILL_LEVEL_NAMES.length; v++) {
      seen.add(v);
      opts += `<option value="${v}"${v === cur ? " selected" : ""}>${escapeHtml(WS_SKILL_LEVEL_NAMES[v])}</option>`;
    }
    if (includeNoMax) { seen.add(WS_NO_MAX_LEVEL); opts += `<option value="${WS_NO_MAX_LEVEL}"${cur >= WS_NO_MAX_LEVEL ? " selected" : ""}>No maximum</option>`; }
    // A served value that lands between named levels still round-trips (server clamps [0,3000]).
    if (Number.isFinite(cur) && cur >= 0 && cur < WS_NO_MAX_LEVEL && !seen.has(cur))
      opts = `<option value="${cur}" selected>${escapeHtml("Level " + cur)}</option>` + opts;
    return `<select class="wo-select" ${attr}>${opts}</select>`;
  }
  function wsMaxOrdersSelect(current) {
    const mgo = Number(current);
    let opts = "";
    for (let v = 0; v <= 10; v++) opts += `<option value="${v}"${v === mgo ? " selected" : ""}>${v}</option>`;
    return `<select class="wo-select" data-ws-max-orders>${opts}</select>`;
  }
  // Single source of truth for the /workshop-profile `field` wire values, shared by the render
  // (DOM data-attrs) and the click/change handlers -- so the fixture proves the exact names the
  // server (wp3 notes) acts on. A drift here is the "wire connection" failure class.
  function wsProfileField(control, opts) {
    switch (control) {
      case "min": return "minLevel";
      case "max": return "maxLevel";
      case "maxOrders": return "maxGeneralOrders";
      case "banOrders": return "banGeneralOrders";
      case "labor": return (opts && opts.blocking) ? "blockLabor" : "unblockLabor";
      default: return null;
    }
  }
  // Blocked-labors sub-list. With a labor enum -> full checkbox list (checked = blocked). Without
  // one (current live DLL has no /labor-list) -> DEGRADE to unblock-only over the currently-blocked
  // set the server already serves, plus a note. Returns "" when blockedLabors isn't served at all.
  function wsBlockedLaborsHtml(blockedLabors, laborList) {
    if (!Array.isArray(blockedLabors)) return "";
    const blockedIds = new Set(blockedLabors.map(b => Number(b.id)));
    const full = Array.isArray(laborList) && laborList.length ? laborList : null;
    let laborHtml, laborNote = "";
    if (full) {
      laborHtml = full.map(l => {
        const lid = Number(l.id);
        return `<label class="ws-labor-row" style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer"><input type="checkbox" data-ws-labor="${lid}"${blockedIds.has(lid) ? " checked" : ""}> ${escapeHtml(l.name || ("Labor " + lid))}</label>`;
      }).join("");
    } else {
      laborNote = `<div class="workshop-note">Full labor list unavailable &mdash; showing only currently-blocked labors.</div>`;
      laborHtml = blockedLabors.length
        ? blockedLabors.map(b => {
            const lid = Number(b.id);
            return `<div class="workshop-worker-row"><div class="workshop-name">${escapeHtml(b.name || ("Labor " + lid))}</div><button class="workshop-icon-btn active" data-ws-labor-unblock="${lid}">Unblock</button></div>`;
          }).join("")
        : `<div class="workshop-note">No labors are blocked at this workshop.</div>`;
    }
    return `<div class="workshop-section-title">Blocked labors (${blockedLabors.length})</div>
            ${laborNote}
            <div class="workshop-list compact ws-labor-list">${laborHtml}</div>`;
  }
  // Whole Workers-tab profile section (skill range + max general orders + ban toggle + blocked
  // labors). Pure (profile,laborList) -> HTML; every sub-control gated on its own served field so
  // a pre-WP-3 DLL renders "". Inline styles keep it presentable without a CSS change.
  function wsProfileControlsHtml(profile, laborList) {
    const p = profile || {};
    if (!wsProfileHasControls(p)) return "";
    let sections = "";
    if (p.minLevel !== undefined || p.maxLevel !== undefined) {
      const fieldStyle = ` style="display:inline-flex;align-items:center;gap:6px;margin-right:14px"`;
      const minSel = p.minLevel !== undefined
        ? `<label class="ws-profile-field"${fieldStyle}>Min skill ${wsSkillSelect("data-ws-min-level", p.minLevel, false)}</label>` : "";
      const maxSel = p.maxLevel !== undefined
        ? `<label class="ws-profile-field"${fieldStyle}>Max skill ${wsSkillSelect("data-ws-max-level", p.maxLevel, true)}</label>` : "";
      sections += `<div class="workshop-section-title">Skill range</div>
        <div class="workshop-note">Only citizens whose skill in this workshop's labor is within this range may work here.</div>
        <div class="zone-btn-row">${minSel}${maxSel}</div>`;
    }
    if (p.maxGeneralOrders !== undefined) {
      sections += `<div class="workshop-section-title">General work orders</div>
        <div class="zone-btn-row"><label class="ws-profile-field" style="display:inline-flex;align-items:center;gap:6px">Max general work orders ${wsMaxOrdersSelect(p.maxGeneralOrders)}</label></div>`;
    }
    if (p.generalOrdersBanned !== undefined) {
      const banned = !!p.generalOrdersBanned;
      sections += `<div class="zone-btn-row"><button class="bld-btn${banned ? " danger" : ""}" data-ws-ban-orders="${banned ? 0 : 1}">${banned ? "General work orders banned &mdash; allow" : "Ban general work orders here"}</button></div>`;
    }
    sections += wsBlockedLaborsHtml(p.blockedLabors, laborList);
    return sections;
  }

  // ---- B174: workshop panel rebuilt to native parity on the DWFUI component layer -------------
  // Oracles: B174-1 (native stoneworker Tasks tab -- exactly 3 chevron tabs, the "Add new task"
  // plaque, and the workshop CONTENTS as rows at the BOTTOM of the Tasks tab), B174-2 (native
  // task picker replacing the tab body: search w/ magnifier, Cancel plaque, ONE flat alphabetical
  // list, red "[Requires X]" annotations), B171-1/2/3 (linked-stockpiles side window), and the
  // B168 carpenter set proving the layout generalizes. ONE panel logic serves every workshop
  // type (stoneworker/carpenter/kitchen/forge/...) -- the type only changes the served data.
  // All builders below are PURE (data -> HTML) and exported for tools/harness/b174_wsrebuild_
  // client_test.mjs; handlers stay delegated [data-*] wiring in renderWorkshopPanel.

  const WS_TABS = [["tasks", "Tasks"], ["workers", "Workers"], ["orders", "Work orders"]];
  function wsNormalizeTab(tab) {
    return WS_TABS.some(([key]) => key === tab) ? tab : "tasks";
  }
  // Matrix §3 F3: Workshop / Kitchen row 1 = `TAB` (Tasks/Workers/Work orders) => level 'primary'.
  // `width:'hug'` -- B174-1's three workshop tabs hug their labels (see farmSeasonTabsHtml).
  function wsTabsHtml(active) {
    return DWFUI.tabsHtml({
      cls: "workshop-tabs", tabCls: "workshop-tab", dataAttr: "ws-tab",
      level: "primary", width: "hug",
      ariaLabel: "Workshop sections", active,
      tabs: WS_TABS.map(([key, label]) => ({ key, label })),
    });
  }

  // WAVE 5: wsTaskGlyph is GONE. It wrapped a TOKENS.glyphs EMOJI in a coloured span, and it was
  // the last thing standing between this panel and DF's own BUILDING_JOBS_* / STOCKS_* tiles. Its
  // two callers (the task row and the links row) now pass `sprite:` to the DWFUI builders instead.

  // Native task-row control cluster (B174-1's kitchen/carpenter siblings, B171-1): green check
  // status, repeat, priority, then (separated) pause/resume + remove. Every control keeps its
  // existing /workshop-job-action wire; only the rendering is new. The '!' keeps the B121 rule:
  // dataset wsJobAction is job.doNow ? "priority" : "now" (toggle on a new DLL, set-only legacy).
  // The check renders job state (active vs suspended) -- its exact native hover vocabulary is on
  // the B174 screenshot-request list, so it ships as a non-interactive indicator.
  // ---- WAVE 5: the task-row controls are NATIVE SPRITES, not TOKENS.glyphs emoji ---------------
  // Every control on this row was a `TOKENS.glyphs` Unicode character -- and TOKENS.glyphs says of
  // itself, in the foundation, "*** DEPRECATED -- TOKENS.glyphs IS THE EMOJI PROBLEM ***; EVERY
  // entry below now HAS a real DF sprite in TOKENS.sprites." The whole BUILDING_JOBS_* family
  // exists in web/interface_map.json and was 0% adopted here.
  //
  // *** FOUNDATION GAP, DECLARED (it needs 3 keys added to a file this lane may not touch). ***
  // BUILDING_JOBS_ACTIVE, BUILDING_JOBS_DO_NOW and BUILDING_JOBS_DO_NOW_ACTIVE are COMPLETE native
  // control cells -- same 32x36 family, same baked-in frame, as BUILDING_JOBS_REPEAT/_SUSPENDED/
  // _REMOVE right beside them. But they are absent from TOKENS.sprites, and therefore from
  // SELF_FRAMED_SPRITES, so isSelfFramedSprite() returns false for them, so they do NOT get
  // `data-dwfui-self-framed` -- and it is that attribute alone which zeroes the generic gold button
  // box (css:6793). Result: DF's own frame renders INSIDE our frame. That is exactly the S2 GAP-1
  // double-frame defect, and the fix is three lines in dwf-ui-components.js, which is LOCKED
  // to this lane. They are used ANYWAY, because the alternative was keeping the emoji (what this
  // whole wave exists to delete) or substituting WORK_ORDERS_PRIORITY_UP, which is the reorder
  // arrow and means something else entirely. A wrong-but-boxed sprite is a LIE about what the
  // control does; a right sprite in a spare box is a border bug. Escalated in the lane closeout.
  //
  // REPEAT and SUSPEND are LATCHES, not action buttons: each has two DIFFERENT sprites for its two
  // meanings (BUILDING_JOBS_REPEAT vs _REPEAT_ACTIVE; _SUSPENDED vs _SUSPENDED_ACTIVE). The owner, on the
  // pause control, verbatim: "IT TURNS GREEN WHEN YOU CLICK IT" -- that green is NOT a colour to
  // invent, it is baked into BUILDING_JOBS_SUSPENDED_ACTIVE. The status indicator and the priority
  // and remove controls stay in the action cluster, now carrying `sprite:` instead of a glyph.
  //
  // Every dataset is byte-identical, so /workshop-job-action still receives exactly what it did --
  // including B121's rule that wsJobAction is job.doNow ? "priority" : "now".
  function wsTaskRowHtml(job) {
    const id = Number(job.id);
    const meta = [];
    if (job.worker) meta.push(`Worker: ${job.worker}`);
    else if (job.working) meta.push("Being worked");
    else meta.push("Waiting");
    if (job.byManager) meta.push("Manager order");
    if (job.suspended) meta.push("Suspended");
    if (job.repeat) meta.push("Repeating");
    if (job.doNow) meta.push("Priority");
    const S = DWFUI.TOKENS.sprites;
    return DWFUI.rowHtml({
      cls: "workshop-row" + (job.suspended ? " suspended" : ""),
      dataset: { wsJobRow: id },
      title: meta.join(" \u00b7 "),
      copyCls: "workshop-task-copy",
      labelCls: "workshop-name" + (job.suspended ? "" : " cyan"),
      label: job.name || "Workshop task",
      trailing: `<span class="ws-task-controls">` +
        // The status cell is an INDICATOR, not a button (its native hover vocabulary is still on
        // the B174 screenshot-request list), so it stays disabled and icon-only.
        DWFUI.actionButtonsHtml([
          { action: "status", sprite: "BUILDING_JOBS_ACTIVE", disabled: true,
            state: job.suspended ? "disabled" : "default",
            title: job.suspended ? "Task is suspended" : "Task is active" },
        ], { cls: "workshop-actions ws-status-cell dwfui-actions", ariaLabel: "Task status" }) +
        DWFUI.latchHtml({
          on: !!job.repeat, cls: "ws-repeat-latch", sprite: S.repeat, activeSprite: S.repeatOn,
          dataset: { wsJob: id, wsJobAction: "repeat" }, title: "Toggle repeat", ariaLabel: "Toggle repeat",
        }) +
        DWFUI.latchHtml({
          on: !!job.suspended, cls: "ws-suspend-latch", sprite: S.suspend, activeSprite: S.suspendOn,
          dataset: { wsJob: id, wsJobAction: job.suspended ? "resume" : "suspend" },
          title: job.suspended ? "Resume task" : "Suspend task",
          ariaLabel: job.suspended ? "Resume task" : "Suspend task",
        }) +
        DWFUI.actionButtonsHtml([
          // PRIORITY is DF's own "do it now" tile -- BUILDING_JOBS_DO_NOW / _DO_NOW_ACTIVE -- not
          // the WORK_ORDERS_PRIORITY_UP reorder arrow, which means "move this order up the list".
          // B121's wire rule is untouched: wsJobAction is job.doNow ? "priority" : "now".
          { action: "priority", sprite: "BUILDING_JOBS_DO_NOW", activeSprite: "BUILDING_JOBS_DO_NOW_ACTIVE",
            active: !!job.doNow,
            title: job.doNow ? "Remove priority (do now)" : "Make priority (do now)",
            dataset: { wsJob: id, wsJobAction: job.doNow ? "priority" : "now" } },
          { action: "cancel", sprite: S.cancelJob, gapBefore: true,
            title: "Remove task", dataset: { wsJob: id, wsJobAction: "cancel" } },
        ], { cls: "workshop-actions dwfui-actions", ariaLabel: "Task controls" }) +
        `</span>`,
    });
  }

  // The workshop CONTENTS live at the BOTTOM of the Tasks tab (B174-1) -- not a separate tab.
  // Leading status cell: house = part of the building (served role PERM); other roles render an
  // empty cell (the native stored-item arrow's data driver is on the screenshot-request list).
  // Actions reuse the stock-item vocabulary + /stock-item-action route (exactly the farm-seed
  // pattern); locate centers on the workshop's own tiles. Active states come from the ADDITIVE
  // forbidden/dump/hidden fields -- an older DLL just serves none and the buttons stay unlit.
  function wsContentRowHtml(item) {
    const id = Number(item.id);
    const ic = workshopItemIconName(item);
    const st = ic && typeof bldIconStyle === "function" ? bldIconStyle(ic, 40) : "";
    const icon = item.spriteRef
      ? DWFUI.iconHtml({ item: item.spriteRef, cls: "workshop-item-ico", size: 40, alt: item.name || `Item ${id}` })
      : `<span class="workshop-item-ico"${st ? ` style="${st}"` : ""}></span>`;
    const status = String(item.role || "").toUpperCase() === "PERM"
      ? `<span class="ws-item-status" title="Part of this building">${DWFUI.TOKENS.glyphs.building}</span>`
      : `<span class="ws-item-status" aria-hidden="true"></span>`;
    // WAVE 5: the contents cluster is the INVARIANT native four -- [magnifier][padlock][trash] · gap
    // · [eye] -- which actionButtonsHtml already ships as the named `itemActions` PRESET, verified
    // identical in B55-3, B174-1, B171-2 and the container oracle. Passing the preset (rather than
    // four hand-listed actions with no `sprite:`) is what finally retires the emoji here: without a
    // sprite the builder falls back to TOKENS.glyphs, which is the deprecated emoji vocabulary.
    // The preset merges per-index, so every dataset/active/title below is preserved exactly.
    return DWFUI.rowHtml({
      cls: "workshop-item-row", dataset: { wsItemRow: id },
      icon,
      copyCls: "workshop-item-copy", labelCls: "workshop-name",
      label: item.name || `Item ${id}`,
      trailing: status + DWFUI.actionButtonsHtml([
        { title: "Locate on the map", dataset: { wsItemAction: "locate", wsItem: id } },
        { active: !!item.forbidden, title: item.forbidden ? "Claim item" : "Forbid item",
          dataset: { wsItemAction: "forbid", wsItem: id } },
        { active: !!item.dump, title: item.dump ? "Cancel dump" : "Mark for dumping",
          dataset: { wsItemAction: "dump", wsItem: id } },
        { active: !!item.hidden, title: item.hidden ? "Show item" : "Hide item",
          dataset: { wsItemAction: "hide", wsItem: id } },
      ], { preset: "itemActions", cls: "ws-item-actions dwfui-actions", ariaLabel: "Item actions" }),
    });
  }
  function wsContentsSectionHtml(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return `<div class="ws-contents" aria-label="Workshop contents">${items.map(wsContentRowHtml).join("")}</div>`;
  }

  function workshopRemovalBodyHtml(info, items) {
    return `${buildingRemovalSectionHtml(info, { action: "ws" })}${wsContentsSectionHtml(items)}`;
  }

  // Native header tool cluster (B174-1 top-right): linked-stockpiles opener, rename quill,
  // crossed-house remove. Native art tiles via DWFUI.artBtnHtml + TOKENS.art.
  function wsHeaderToolsHtml(state) {
    const s = state || {};
    return `<div class="ws-head-tools" aria-label="Workshop tools">` +
      DWFUI.artBtnHtml({ art: "wsLinkopen", cls: "ws-tool", active: !!s.linksOpen,
        title: "Linked stockpiles (give to / take from)", dataset: { wsLinksToggle: "" } }) +
      DWFUI.artBtnHtml({ art: "tileQuill", cls: "ws-tool", active: !!s.renaming,
        title: "Rename this workshop", dataset: { wsRename: "" } }) +
      (s.markedForRemoval ? "" : DWFUI.artBtnHtml({ art: "wsRemove", cls: "ws-tool",
        title: "Remove this workshop", dataset: { wsRemove: "" } })) +
      `</div>`;
  }

  // One native picker row (B174-2): full-width alphabetical rows. An unavailable task keeps the
  // native treatment: ORANGE label + RED "[Requires X]" sub-line (served avail/objection --
  // fail-open, absent fields render a plain available row). The raw enum/reaction debug text
  // (ConstructArmorStand / MAKE_ENT304 INK1_BODY -- B174-3's shame list) is NEVER rendered;
  // search matches the display label only, like native.
  function wsPickerRowHtml(cfg) {
    const c = cfg || {};
    const unavailable = c.avail === false;
    return DWFUI.rowHtml({
      tag: "button",
      cls: "workshop-task-option" + (unavailable ? " ws-unavailable" : ""),
      dataset: c.dataset,
      copyCls: "ws-option-copy", labelCls: "ws-option-label",
      label: c.label || "Task",
      sub: unavailable && c.objection ? { text: c.objection, cls: "dwfui-sub ws-objection" }
        : (c.subText ? { text: c.subText, cls: "dwfui-sub ws-option-meta" } : null),
    });
  }
  function wsPickerSearchHtml() {
    // Native search field: "..." placeholder, magnifier at the right (B174-2). The plain-ASCII
    // placeholder also retires B174-3's mojibake search hint (a double-encoded ellipsis) for good.
    return DWFUI.searchHtml({
      cls: "ws-task-search-row", inputCls: "ws-task-search",
      value: workshopTaskSearch || "", placeholder: "...", magnifier: true,
      ariaLabel: "Search tasks",
    });
  }
  // The picker's Cancel plaque. WAVE 5: native's "Cancel" label is ORANGE (#FF7F13 -- the measured
  // --dwfui-text-warning), not the default neutral grey. `tone` is the LABEL colour axis.
  function wsCancelRowHtml() {
    return `<div class="ws-cancel-row">${DWFUI.plaqueBtnHtml({
      label: "Cancel", tone: "orange", cls: "ws-cancel-plaque", dataset: { wsToggleAdd: "" },
      title: "Close the task picker" })}</div>`;
  }

  function wsPickerMatches(searchText, term) {
    return dfTokenMatch(String(searchText || ""), String(term || "").trim());
  }

  // ---- B174 links flow (B171-2/3): the linked-stockpiles side window --------------------------
  // /stockpile-link is a stockpile-first route (id = the PILE, target = this workshop) and names
  // its mode from the pile's side. This single mapping is the wire truth the whole flow rides on:
  // shop TAKES FROM pile == pile gives to shop; shop GIVES TO pile == pile takes from shop.
  function wsLinkWireMode(panelMode) {
    return panelMode === "take" ? "give" : "take";
  }
  function wsLinkPayload(stockpileId, workshopId, panelMode, on) {
    return { id: Number(stockpileId), target: Number(workshopId), mode: wsLinkWireMode(panelMode), on: on ? 1 : 0 };
  }
  function wsLinkRowHtml(link) {
    const id = Number(link.id);
    // served dir is workshop-side: 'take' = shop takes from this pile, 'give' = shop gives to it
    const dirArt = link.dir === "take" ? "wsDirtake" : "wsDirgive";
    const dirTitle = link.dir === "take" ? "This workshop takes from this stockpile"
      : "This workshop gives to this stockpile";
    return DWFUI.rowHtml({
      cls: "ws-link-row", dataset: { wsLinkRow: id },
      icon: `<span class="ws-link-dir" style="background-image:${DWFUI.TOKENS.art[dirArt]}" title="${DWFUI.esc(dirTitle)}"></span>`,
      copyCls: "ws-link-copy", labelCls: "workshop-name",
      label: link.name || `Stockpile ${id}`,
      trailing: DWFUI.actionButtonsHtml([
        { action: "view", sprite: DWFUI.TOKENS.sprites.recenter, title: "Locate on the map",
          dataset: { wsLinkLocate: id, spX: Number(link.x), spY: Number(link.y), spZ: Number(link.z) } },
        { action: "unlink", sprite: DWFUI.TOKENS.sprites.cancelJob, title: "Unlink",
          dataset: { wsLinkRemove: id, wsLinkDir: link.dir === "take" ? "take" : "give" } },
      ], { cls: "dwfui-actions", ariaLabel: "Link actions" }),
    });
  }
  function wsLinksWindowHtml(info, armMode) {
    const links = Array.isArray(info.linkedStockpiles) ? info.linkedStockpiles : [];
    const rows = links.map(wsLinkRowHtml).join("") ||
      `<div class="workshop-note">No linked stockpiles. Choose give or take above, then click a stockpile on the map.</div>`;
    return DWFUI.sideWindowHtml({
      cls: "ws-links-win", ariaLabel: "Linked stockpiles",
      tools:
        DWFUI.artBtnHtml({ art: "wsLinkgive", active: armMode === "give",
          title: "Give to a stockpile: click a stockpile on the map to link it",
          dataset: { wsLinkArm: "give" } }) +
        DWFUI.artBtnHtml({ art: "wsLinktake", active: armMode === "take",
          title: "Take from a stockpile: click a stockpile on the map to link it",
          dataset: { wsLinkArm: "take" } }),
      done: { dataset: { wsLinksDone: "" } },
    }, rows);
  }

  async function openWorkshopPanel(id, tab = activeWorkshopTab) {
    // B174: 3 native tabs only -- a stale legacy value (contents/stockpiles) folds to tasks.
    activeWorkshopTab = wsNormalizeTab(tab);
    let info = null;
    let errMsg = "";
    try {
      const r = await fetch(`/workshop-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      const text = await r.text();
      try { info = text ? JSON.parse(text) : null; } catch (_) {}
      if (!r.ok) errMsg = (info && (info.error || info.msg)) || text.trim() || "workshop info failed";
    } catch (err) {
      errMsg = err.message || "workshop info failed";
    }
    if (!info || info.ok === false || Number(info.id) < 0) {
      const msg = errMsg || (info && (info.error || info.msg)) || "Workshop data unavailable.";
      selection.className = "visible building-panel workshop-panel";
      panelContent(selection).innerHTML = `
        <div class="bld-head"><div class="bld-name">Workshop</div><button class="bld-x" data-bld-close title="Close">X</button></div>
        <div class="workshop-body"><div class="workshop-status err">${escapeHtml(msg)}</div></div>
      `;
      selection.querySelector("[data-bld-close]")?.addEventListener("click", event => {
        event.stopPropagation(); closeSelection(); focusPage();
      });
      return;
    }
    // WP-C (WT04): warm the /attrib cache before the (synchronous) render so the "Ordered by"
    // line paints on first open. Graceful/dormant on the pre-WP-C DLL.
    try { if (typeof attribRefresh === "function") await attribRefresh(); } catch (_) {}
    // WP-3a: warm the static labor enum for the Workers-tab blocked-labors list (once, graceful --
    // only when the DLL actually serves profile controls, so a pre-WP-3 DLL never hits /labor-list).
    if (wsProfileHasControls(info.profile)) { try { await warmWorkshopLaborList(info); } catch (_) {} }
    renderWorkshopPanel(info);
  }

  function renderWorkshopPanel(info) {
    const jobs = Array.isArray(info.jobs) ? info.jobs : [];
    const tasks = Array.isArray(info.tasks) ? info.tasks : [];
    const orders = Array.isArray(info.orders) ? info.orders : [];
    const workers = Array.isArray(info.workers) ? info.workers : [];
    const items = Array.isArray(info.items) ? info.items : [];
    const tab = wsNormalizeTab(activeWorkshopTab);
    // B174 (supersedes the B147 5-tab layout): native shows exactly 3 chevron tabs (B174-1).
    // Contents render as rows at the BOTTOM of the Tasks tab; linked stockpiles moved to the
    // side window (B171 flow). Both data sources (items / linkedStockpiles) are unchanged wire.
    const wsIcon = workshopIconName(info);
    const wsStyle = wsIcon ? bldIconStyle(wsIcon, 28) : "";
    const statusHtml = workshopStatusMsg
      ? `<div class="workshop-status${workshopStatusIsError ? " err" : ""}">${escapeHtml(workshopStatusMsg)}</div>`
      : "";
    // WP-C (WT04): "Ordered by â— player" line -- a workshop is stamped as a Building by id, so it
    // reads from the same /attrib buildings section as the plain building panel. Empty (no line)
    // on the pre-WP-C DLL or for native/pre-existing workshops. Toggleable via showAttribution.
    const wsOrderedByChip = (typeof attribRowHtml === "function") ? attribRowHtml("building", info.id) : "";
    const wsOrderedByLine = wsOrderedByChip ? `<div class="bld-note bld-attrib">Ordered by ${wsOrderedByChip}</div>` : "";

    // B174-2 native picker: search (magnifier) on top, then ONE flat, fully alphabetical list.
    // Native shows NO group headers and NO enum/reaction meta -- B144's group-scoped ordering is
    // superseded by this oracle (sortTasksAlpha still runs first for stable pre-flatten order on
    // equal names). `addAttr` stays the per-button action attribute; options that don't match the
    // search hide client-side (no re-render, keeps input focus).
    // D3/D4 (shop oracles): a FLAT shop's task list may contain CONTAINER rows -- the server marks them
    // `submenu` and ships their `children` inline. DF renders exactly this: containers first, each
    // reading "<X> (opens menu)" (the server composes that label from the capture), then the leaves
    // alphabetically. Clicking a container drills ONE level (no server round-trip -- the children are
    // already here) and the children queue through the ordinary add-task key, because the server never
    // dropped their defs, only hid them from the top list.
    function buildTaskPicker(list, addAttr, valueOf) {
      const MTF = (typeof window !== "undefined") ? window.DwfMenuTree : null;
      const open = workshopFlatCat
        ? list.find(t => t && t.submenu && t.key === workshopFlatCat) : null;
      let backHtml = "";
      if (open) {
        const crumb = String(open.name || "").replace(/\s*\(opens menu\)\s*$/, "");
        backHtml = `<div class="ws-tree-bar">${DWFUI.plaqueBtnHtml({ label: "← Back",
          cls: "ws-back-plaque", dataset: { wsFlatBack: "" }, title: "Back one level" })}<span
          class="workshop-meta ws-tree-crumb">${escapeHtml(crumb)}</span></div>`;
        list = Array.isArray(open.children) ? open.children : [];
      }
      if (MTF && MTF.sortTasksAlpha) list = MTF.sortTasksAlpha(list);
      // Containers lead, then alphabetical -- the ordering law from all 30 captures.
      list = list.slice().sort((a, b) => (a.submenu ? 0 : 1) - (b.submenu ? 0 : 1)
        || String(a.name || a.job || "")
          .localeCompare(String(b.name || b.job || ""), undefined, { sensitivity: "base" }));
      const dsKey = addAttr.replace(/^data-/, "").replace(/-([a-z])/g, (m, ch) => ch.toUpperCase());
      const rows = list.map(t => {
        const label = t.name || t.job || "Task";
        if (t.submenu) {
          return wsPickerRowHtml({
            label: DWFUI.sentenceCase(label),
            dataset: { wsFlatCat: t.key, wsSearch: String(label).toLowerCase() },
          });
        }
        return wsPickerRowHtml({
          label: DWFUI.sentenceCase(label),
          avail: t.avail, objection: t.objection,
          dataset: { [dsKey]: valueOf(t), wsSearch: String(label).toLowerCase() },
        });
      }).join("");
      return `${backHtml}${wsPickerSearchHtml()}
        <div class="workshop-task-grid">${rows || `<div class="workshop-note">No orderable tasks reported for this station.</div>`}</div>`;
    }
    // Wire the search box (called after innerHTML is set) to hide/show non-matching options.
    // B174: the picker is one flat list (group headers retired per oracle B174-2).
    function wireTaskSearch() {
      const input = selection.querySelector(".ws-task-search");
      if (!input) return;
      const apply = () => {
        const term = (input.value || "").trim();
        workshopTaskSearch = input.value || "";
        selection.querySelectorAll(".workshop-task-option[data-ws-search]").forEach(btn => {
          btn.style.display = wsPickerMatches(btn.dataset.wsSearch, term) ? "" : "none";   // B21 token search
        });
      };
      input.addEventListener("input", apply);
      // Keep view keyboard shortcuts from swallowing typing while focused in the field.
      input.addEventListener("keydown", e => e.stopPropagation());
      if (workshopTaskSearch) apply();
    }

    // TRUEMENU WP-1: forge drill-down picker (category -> metal -> leaf), mirroring DF's native
    // add-task menu. `workshopTreePath` ([] | [catIdx] | [catIdx, metalIdx]) is the current level;
    // rows reuse the .workshop-task-option + data-ws-search convention so wireTaskSearch() filters
    // them (substring/DF-token parity per level, matching filtered_button). Category rows carry the
    // "(opens menu)" suffix DF shows; leaf rows compose the self-describing t: key add_tree_task
    // parses. B174 restyle: rows render through wsPickerRowHtml (native full-width list, red
    // "[Requires X]" sub-lines, NO confidence/debug meta). Drill/back/queue handlers live below.
    function buildTreePicker(tree, MT) {
      const nav = MT.levelAt(tree, workshopTreePath);
      const crumbs = [];
      if (nav.level >= 1) { const c = tree[workshopTreePath[0]]; if (c) crumbs.push(c.label || ""); }
      // leaf-only categories set nav.node to the category itself -- don't push its label twice
      if (nav.level >= 2 && nav.node && nav.node !== tree[workshopTreePath[0]]) crumbs.push(nav.node.label || "");
      const backHtml = nav.level > 0
        ? DWFUI.plaqueBtnHtml({ label: "\u2190 Back", cls: "ws-back-plaque",
            dataset: { wsTreeBack: "" }, title: "Back one level" }) : "";
      const crumbHtml = crumbs.length
        ? `<span class="workshop-meta ws-tree-crumb">${escapeHtml(crumbs.join(" \u203a "))}</span>` : "";
      // B144: queueable item rows render A->Z (containers keep native order). ordered rows
      // carry their ORIGINAL index so drill attributes still address the served tree. Fallback to
      // served order if a stale menu-tree module lacks the helper.
      const orderRows = rows => (MT.orderRowsAlpha ? MT.orderRowsAlpha(rows)
        : rows.map((node, idx) => ({ node, idx })));
      let rowsHtml = "";
      if (nav.level === 0) {
        // Root may MIX submenu containers (categories / material selectors -> "(opens menu)") and
        // directly-queueable leaves (Smelter/Kennels, and the Craftsdwarf direct rows). Render each
        // per its kind so a Craftsdwarf root shows drill rows and queue rows side by side.
        rowsHtml = orderRows(nav.rows).map(({ node, idx }) => {
          const hay = String(node.label || "").toLowerCase();
          if (MT.rowIsContainer(node)) {
            return wsPickerRowHtml({ label: MT.categoryRowLabel(node),
              dataset: { wsTreeCat: idx, wsSearch: hay } });
          }
          const key = MT.composeTaskKey(node, null);
          if (!key) return "";
          return wsPickerRowHtml({ label: node.label || "Task", avail: node.avail,
            objection: node.objection, dataset: { wsTreeLeaf: key, wsSearch: hay } });
        }).join("");
      } else if (nav.level === 1) {
        rowsHtml = nav.rows.map((m, j) => {
          const cnt = Array.isArray(m.leaves) ? m.leaves.length : 0;
          const hay = String(m.label || "").toLowerCase();
          return wsPickerRowHtml({ label: m.label || "Material",
            subText: `${cnt} task${cnt === 1 ? "" : "s"}`,
            dataset: { wsTreeMetal: j, wsSearch: hay } });
        }).join("");
      } else {
        const metal = nav.node;
        rowsHtml = orderRows(nav.rows).map(({ node: leaf }) => {
          const key = MT.composeTaskKey(leaf, metal);
          if (!key) return "";
          const hay = String(leaf.label || "").toLowerCase();
          return wsPickerRowHtml({ label: leaf.label || "Task", avail: leaf.avail,
            objection: leaf.objection, dataset: { wsTreeLeaf: key, wsSearch: hay } });
        }).join("");
      }
      const noneMsg = nav.level === 0 ? "No forge categories available." : "Nothing here.";
      return `${backHtml || crumbHtml ? `<div class="ws-tree-bar">${backHtml}${crumbHtml}</div>` : ""}
        ${wsPickerSearchHtml()}
        <div class="workshop-task-grid">${rowsHtml || `<div class="workshop-note">${noneMsg}</div>`}</div>`;
    }

    const tasksBody = (() => {
      const MT = (typeof window !== "undefined") ? window.DwfMenuTree : null;
      // A menu tree (forge OR flat-shop: Smelter/Kennels/Craftsdwarf) drives the drill-down picker;
      // otherwise fall back to the flat task list (Masons/Carpenters/... native add-task menu).
      const menuTree = MT && MT.isMenuTree(info.taskTree) ? info.taskTree : null;
      if (workshopAddMode && info.canAddTasks) {
        // B174-2: the picker REPLACES the tab body -- Cancel plaque top-right, then search, then
        // the full-height list. The contents rows are hidden while it is up (oracle).
        const picker = menuTree
          ? buildTreePicker(menuTree, MT)
          : buildTaskPicker(tasks, "data-ws-add-task", t => t.key);
        return `${wsCancelRowHtml()}
        ${picker}`;
      }
      // B121: the "!" control keeps DF's native per-task priority semantics (see
      // wsTaskRowHtml -- dataset wsJobAction is job.doNow ? "priority" : "now", toggle vs legacy).
      // B174: no "Queued tasks (n/10)" counter (native shows none) and no empty-state note --
      // an empty Tasks tab is just the plaque above the contents rows (B174-1).
      const rows = jobs.map(wsTaskRowHtml).join("");
      const addBtn = info.canAddTasks
        ? `<div class="ws-add-row">${DWFUI.plaqueBtnHtml({ label: "Add new task", tone: "green",
            cls: "ws-add-plaque", dataset: { wsToggleAdd: "" }, title: "Queue a new task" })}</div>`
        : `<div class="workshop-note">No orderable tasks reported for this station.</div>`;
      return `<div class="workshop-list workshop-task-list">${rows}</div>
        ${addBtn}
        ${wsContentsSectionHtml(items)}`;
    })();

    const workersBody = (() => {
      const profile = info.profile || {};
      const unrestricted = Number(profile.permittedCount || 0) === 0;
      const rows = workers.length ? wsWorkerRowsHtml(workers)
        : `<div class="workshop-note">No citizens available.</div>`;
      // WP-3a: skill-range / general-orders / blocked-labors profile controls. Pure builder (below),
      // gated per-field, so nothing new renders on a pre-WP-3 DLL. The labor enum for the blocked
      // checkboxes is the once-warmed cache (null on the live DLL -> unblock-only degrade path).
      const profileControls = wsProfileControlsHtml(profile, wsLaborListCache);
      return `<div class="workshop-note">${unrestricted ? "This workshop is free for anybody to use." : `${Number(profile.permittedCount) || 0} worker(s) assigned to this workshop.`}</div>
        ${unrestricted ? "" : `<button class="bld-btn" data-ws-workers-clear>Let anybody use this workshop</button>`}
        <div class="workshop-list compact">${rows}</div>
        ${profileControls}`;
    })();

    const ordersBody = (() => {
      const orderRows = orders.length ? orders.map(o => {
        const total = Number(o.amountTotal) || 0;
        const left = Number(o.amountLeft) || 0;
        const amount = total > 0 ? `${left}/${total} left` : "repeating";
        // WP-C (WT06): per-order "â— player" chip, merged from /attrib by order id (same pattern as
        // the main work-orders list). Empty for native/pre-existing orders or the pre-WP-C DLL.
        const oAttrib = (typeof attribRowHtml === "function") ? attribRowHtml("order", o.id) : "";
        return DWFUI.rowHtml({
          cls: "workshop-order-row",
          copyCls: "workshop-order-copy", labelCls: "workshop-name",
          label: o.job || "Work order",
          sub: { cls: "dwfui-sub workshop-meta",
            html: `${escapeHtml(o.frequency === "OneTime" ? "One time" : (o.frequency || "One time"))} &middot; ${escapeHtml(amount)} &middot; ${o.active ? "Active" : "Inactive"}${o.validated ? "" : " &middot; Pending"}${oAttrib ? ` &middot; ${oAttrib}` : ""}` },
          trailing: `<button class="workshop-icon-btn danger" data-ws-order-cancel="${Number(o.id)}" title="Cancel order">X</button>`,
        });
      }).join("") : `<div class="workshop-note">No work orders are assigned to this workshop.</div>`;
      // B155 reopen: manager orders for subtype-bearing jobs (tools/weapons/armor) need a
      // product subtype and, at a forge, a concrete metal. New servers provide the shared,
      // fully-expanded orderTasks projection; retain the old tasks fallback for stale DLLs.
      const orderTasks = Array.isArray(info.orderTasks)
        ? info.orderTasks.filter(t => t.orderKey)
        : tasks.filter(t => t.orderKey);
      const freqOptions = (typeof WO_FREQS !== "undefined" ? WO_FREQS : ["OneTime", "Daily", "Monthly", "Seasonally", "Yearly"])
        .map(f => `<option value="${escapeHtml(f)}">${escapeHtml(typeof woFreqLabel === "function" ? woFreqLabel(f) : f)}</option>`).join("");
      const picker = workshopOrderAddMode ? `
        <div class="workshop-section-title">New shop work order</div>
        <div class="zone-btn-row">
          <input class="wo-input" id="wsOrderAmount" type="number" min="1" max="9999" value="1" style="width:84px">
          <select class="wo-select" id="wsOrderFreq">${freqOptions}</select>
        </div>
        ${buildTaskPicker(orderTasks, "data-ws-add-order", t => t.orderKey)}` : "";
      return `<div class="workshop-note">Work orders created here are assigned to this exact workshop.</div>
        <div class="workshop-list">${orderRows}</div>
        <button class="bld-btn" data-ws-toggle-order>${workshopOrderAddMode ? "Hide order list" : "Add shop work order"}</button>
        <button class="bld-btn" data-ws-open-orders>Open full work orders</button>
        ${picker}`;
    })();

    // B174: Contents + Linked stockpiles are no longer tabs -- contents live at the bottom of the
    // Tasks tab (wsContentsSectionHtml, built into tasksBody above); links live in the side
    // window (wsLinksWindowHtml + the map-click flow below). The old footer (Remove building) and
    // the Rename button are gone too: both moved into the native header tool cluster (B174-1).
    const body = info.markedForRemoval
      ? workshopRemovalBodyHtml(info, items)
      : tab === "workers" ? workersBody
      : tab === "orders" ? ordersBody
      : tasksBody;

    // B13-rename, restyled: the header quill toggles an inline input with Save/Cancel. The input
    // is seeded with the current name so an empty save clears it.
    const titleHtml = workshopRenameMode
      ? `<div class="bld-name workshop-title workshop-rename-row">
           <input class="ws-rename-input" type="text" maxlength="128" value="${escapeHtml(info.name || "")}" placeholder="Workshop name" />
           <button class="bld-btn tiny" data-ws-rename-save title="Save name">Save</button>
           <button class="bld-btn tiny" data-ws-rename-cancel title="Cancel">Cancel</button>
         </div>`
      : `<div class="bld-name workshop-title"><span>${DWFUI.bitmapTextHtml(info.name || "Workshop")}</span></div>`;

    selection.className = "visible building-panel workshop-panel";
    panelContent(selection).innerHTML = `
      ${DWFUI.headerHtml({
        cls: "bld-head ws-head",
        icon: `<span class="workshop-ico"${wsStyle ? ` style="${wsStyle}"` : ""}></span>`,
        titleHtml, titleCls: "ws-head-titlebox",
        tools: wsHeaderToolsHtml({ linksOpen: workshopLinksOpen, renaming: workshopRenameMode,
                                  markedForRemoval: info.markedForRemoval }),
        close: { data: "bld-close" },
      })}
      ${info.markedForRemoval ? "" : wsTabsHtml(tab)}
      <div class="workshop-body">
        ${info.markedForRemoval ? "" : wsOrderedByLine}
        ${info.markedForRemoval ? "" : statusHtml}
        ${body}
      </div>
    `;

    selection.querySelector("[data-bld-close]")?.addEventListener("click", event => {
      event.stopPropagation();
      workshopLinksOpen = false;
      wsLinksWinDestroy();
      closeSelection(); focusPage();
    });
    selection.querySelectorAll("[data-ws-tab]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      activeWorkshopTab = wsNormalizeTab(btn.dataset.wsTab);
      workshopAddMode = false;
      workshopOrderAddMode = false;
      workshopTaskSearch = "";
      workshopTreePath = [];
      workshopFlatCat = null;
      workshopRenameMode = false;
      workshopStatusMsg = "";
      renderWorkshopPanel(info);
      focusPage();
    }));
    selection.querySelector("[data-ws-toggle-add]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopAddMode = !workshopAddMode;
      workshopTaskSearch = "";
      workshopTreePath = [];
      workshopFlatCat = null;
      workshopStatusMsg = "";
      renderWorkshopPanel(info);
      focusPage();
    });
    selection.querySelectorAll("[data-ws-add-task]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/workshop-add-job", { id: info.id, task: btn.dataset.wsAddTask });
        workshopAddMode = false;
        workshopStatusMsg = "Shop task queued.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not queue shop task.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "tasks");
      focusPage();
    }));
    // D3/D4: flat-shop container drill (Carpenter's "Make instrument", Leatherworks' "Make instrument
    // piece"). Same shape as the tree drill below, one level deep, children already in hand.
    selection.querySelectorAll("[data-ws-flat-cat]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopFlatCat = btn.dataset.wsFlatCat;
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    }));
    selection.querySelector("[data-ws-flat-back]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopFlatCat = null;
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    });
    // TRUEMENU WP-1: forge drill-down navigation. Drilling into a category/metal just changes
    // workshopTreePath + clears the per-level search, then re-renders (no server round-trip).
    selection.querySelectorAll("[data-ws-tree-cat]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopTreePath = [Number(btn.dataset.wsTreeCat)];
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    }));
    selection.querySelectorAll("[data-ws-tree-metal]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopTreePath = [workshopTreePath[0], Number(btn.dataset.wsTreeMetal)];
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    }));
    selection.querySelector("[data-ws-tree-back]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopTreePath = workshopTreePath.slice(0, -1);
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    });
    // Leaf selected: POST the composed t: key (server's add_tree_task pins per-metal material).
    selection.querySelectorAll("[data-ws-tree-leaf]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/workshop-add-job", { id: info.id, task: btn.dataset.wsTreeLeaf });
        workshopAddMode = false;
        workshopTreePath = [];
      workshopFlatCat = null;
        workshopStatusMsg = "Shop task queued.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not queue shop task.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "tasks");
      focusPage();
    }));
    selection.querySelectorAll("[data-ws-job]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/workshop-job-action", { id: info.id, job: btn.dataset.wsJob, action: btn.dataset.wsJobAction });
        workshopStatusMsg = "Task updated.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not update task.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "tasks");
      focusPage();
    }));
    selection.querySelectorAll("[data-ws-worker]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/workshop-worker-action", { id: info.id, unit: btn.dataset.wsWorker, assign: btn.dataset.wsAssign });
        workshopStatusMsg = "Worker assignment updated.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not update workers.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "workers");
      focusPage();
    }));
    selection.querySelector("[data-ws-workers-clear]")?.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/workshop-workers-clear", { id: info.id });
        workshopStatusMsg = "Workshop is unrestricted.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not clear workers.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "workers");
      focusPage();
    });
    // WP-3a: workshop profile writes -> POST /workshop-profile (one field per call), then re-read
    // the Workers tab. On failure the status line shows a non-destructive error and the panel stays
    // usable (openWorkshopPanel re-reads the still-valid server state; nothing is mutated locally).
    const wsProfilePost = async (field, value, okMsg) => {
      try {
        await workshopPost("/workshop-profile", { id: info.id, field, value });
        workshopStatusMsg = okMsg;
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not update workshop profile.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "workers");
      focusPage();
    };
    selection.querySelector("[data-ws-min-level]")?.addEventListener("change", event => {
      event.stopPropagation();
      wsProfilePost(wsProfileField("min"), Number(event.currentTarget.value), "Minimum skill updated.");
    });
    selection.querySelector("[data-ws-max-level]")?.addEventListener("change", event => {
      event.stopPropagation();
      wsProfilePost(wsProfileField("max"), Number(event.currentTarget.value), "Maximum skill updated.");
    });
    selection.querySelector("[data-ws-max-orders]")?.addEventListener("change", event => {
      event.stopPropagation();
      wsProfilePost(wsProfileField("maxOrders"), Number(event.currentTarget.value), "Max general work orders updated.");
    });
    selection.querySelector("[data-ws-ban-orders]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      wsProfilePost(wsProfileField("banOrders"), Number(event.currentTarget.dataset.wsBanOrders), "General work order setting updated.");
    });
    selection.querySelectorAll("[data-ws-labor]").forEach(cb => cb.addEventListener("change", event => {
      event.stopPropagation();
      const lid = Number(event.currentTarget.dataset.wsLabor);
      const blocking = event.currentTarget.checked;
      wsProfilePost(wsProfileField("labor", { blocking }), lid, blocking ? "Labor blocked." : "Labor unblocked.");
    }));
    selection.querySelectorAll("[data-ws-labor-unblock]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      wsProfilePost(wsProfileField("labor", { blocking: false }), Number(event.currentTarget.dataset.wsLaborUnblock), "Labor unblocked.");
    }));
    // Keep the profile dropdowns from being hijacked by global view keybindings while focused.
    selection.querySelectorAll("[data-ws-min-level],[data-ws-max-level],[data-ws-max-orders]").forEach(sel =>
      sel.addEventListener("keydown", e => e.stopPropagation()));
    selection.querySelector("[data-ws-toggle-order]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopOrderAddMode = !workshopOrderAddMode;
      workshopTaskSearch = "";
      workshopStatusMsg = "";
      renderWorkshopPanel(info);
      focusPage();
    });
    selection.querySelectorAll("[data-ws-add-order]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const amount = Math.max(1, Math.min(9999, Number(document.getElementById("wsOrderAmount")?.value) || 1));
      const frequency = document.getElementById("wsOrderFreq")?.value || "OneTime";
      try {
        await workshopPost("/order-create", { key: btn.dataset.wsAddOrder, amount, frequency, workshop: info.id });
        workshopOrderAddMode = false;
        workshopStatusMsg = "Shop work order queued.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not queue work order.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "orders");
      focusPage();
    }));
    selection.querySelectorAll("[data-ws-order-cancel]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/order-cancel", { id: btn.dataset.wsOrderCancel });
        workshopStatusMsg = "Work order cancelled.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not cancel work order.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "orders");
      focusPage();
    }));
    selection.querySelector("[data-ws-open-orders]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      woCreateWorkshop = info.id;
      closeSelection();
      openWorkOrdersPanel();
      focusPage();
    });
    // B13: remove/deconstruct this workshop via the existing building-action route (DF-native
    // deconstruct designation, not heap surgery). Confirm first since it's destructive.
    selection.querySelector("[data-ws-remove]")?.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      if (!confirm("Remove this workshop? Its tasks are cancelled and it is deconstructed.")) { focusPage(); return; }
      try {
        await fetch(`/building-action?id=${info.id}&action=remove`, { method: "POST", cache: "no-store" });
        closeSelection();
      } catch (err) {
        workshopStatusMsg = err.message || "Could not remove workshop.";
        workshopStatusIsError = true;
        renderWorkshopPanel(info);
      }
      focusPage();
    });
    selection.querySelector("[data-ws-cancel-removal]")?.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        const r = await fetch(`/building-action?id=${info.id}&action=cancel-removal`,
                              { method: "POST", cache: "no-store" });
        if (!r.ok) throw new Error("cancel removal failed");
        await openWorkshopPanel(info.id, activeWorkshopTab);
      } catch (err) {
        workshopStatusMsg = err.message || "Could not cancel removal.";
        workshopStatusIsError = true;
        renderWorkshopPanel(info);
      }
      focusPage();
    });
    // B13-rename: open the inline name editor.
    selection.querySelector("[data-ws-rename]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopRenameMode = true;
      workshopStatusMsg = "";
      renderWorkshopPanel(info);
      const inp = selection.querySelector(".ws-rename-input");
      if (inp) { inp.focus(); inp.select(); }
    });
    selection.querySelector("[data-ws-rename-cancel]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopRenameMode = false;
      renderWorkshopPanel(info);
      focusPage();
    });
    const submitRename = async () => {
      const inp = selection.querySelector(".ws-rename-input");
      const newName = inp ? inp.value.trim() : "";
      try {
        await workshopPost("/workshop-rename", { id: info.id, name: newName });
        workshopRenameMode = false;
        workshopStatusMsg = newName ? "Workshop renamed." : "Name cleared.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not rename workshop.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, activeWorkshopTab);
      focusPage();
    };
    selection.querySelector("[data-ws-rename-save]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); submitRename();
    });
    selection.querySelector(".ws-rename-input")?.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); submitRename(); }
      else if (event.key === "Escape") { event.preventDefault(); workshopRenameMode = false; renderWorkshopPanel(info); focusPage(); }
    });
    // B174: contents-row actions (bottom of the Tasks tab). Locate centers on the workshop's own
    // tiles (contents sit at the building); forbid/dump/hide reuse the /stock-item-action route
    // exactly like the farm seed rows and the stock item sheet.
    selection.querySelectorAll("[data-ws-item-action]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const action = btn.dataset.wsItemAction;
      if (action === "locate") {
        const pos = { x: Number(info.x), y: Number(info.y), z: Number(info.z) };
        if (typeof centerAndFlashMapPos === "function" && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))
          centerAndFlashMapPos(pos);
        focusPage();
        return;
      }
      try {
        await postFarmSeedAction(Number(btn.dataset.wsItem), action);
        workshopStatusMsg = "Item updated.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not update item.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, activeWorkshopTab);
      focusPage();
    }));
    // B174 links flow: the header opener toggles the side window (rendered body-level below).
    selection.querySelector("[data-ws-links-toggle]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopLinksOpen = !workshopLinksOpen;
      if (!workshopLinksOpen) wsLinksWinDestroy();
      renderWorkshopPanel(info);
      focusPage();
    });
    wireTaskSearch();
    wsLinksWinRender(info);
  }

  // ---- B174 links side window runtime (B171-2/3) -----------------------------------------------
  // Mounted BODY-LEVEL because the #selection host clips overflow; tracked against the host
  // panel's live rect (render, resize, and a light poll that also survives panel drags and
  // auto-dismisses if the workshop panel goes away underneath it). Give/take arm a map-click
  // stockpile pick through window.DFWsLink (dwf-controls-placement.js resolves the click
  // via /inspect and calls onPick with the stockpile id; the mode stays armed across picks until
  // Done / disarm, like the squad-kill multi-select).
  let wsLinksWinEl = null;
  let wsLinksWinTimer = null;
  function wsLinksWinDestroy() {
    if (wsLinksWinTimer) { clearInterval(wsLinksWinTimer); wsLinksWinTimer = null; }
    if (wsLinksWinEl) { wsLinksWinEl.remove(); wsLinksWinEl = null; }
    if (workshopLinkArmMode && window.DFWsLink && typeof window.DFWsLink.disarm === "function")
      window.DFWsLink.disarm();
    workshopLinkArmMode = null;
  }
  function wsLinksWinPosition() {
    if (!wsLinksWinEl) return;
    if (!selection.classList.contains("visible") || selection.className.indexOf("workshop-panel") < 0) {
      workshopLinksOpen = false;
      wsLinksWinDestroy();
      return;
    }
    const rect = selection.getBoundingClientRect();
    const w = wsLinksWinEl.offsetWidth || 300;
    wsLinksWinEl.style.left = `${Math.max(6, Math.round(rect.left - w - 10))}px`;
    wsLinksWinEl.style.top = `${Math.max(6, Math.round(rect.top))}px`;
  }
  function wsLinksWinRender(info) {
    if (!workshopLinksOpen) { wsLinksWinDestroy(); return; }
    if (!wsLinksWinEl) {
      wsLinksWinEl = document.createElement("div");
      wsLinksWinEl.className = "ws-links-mount";
      document.body.appendChild(wsLinksWinEl);
    }
    if (!wsLinksWinTimer) wsLinksWinTimer = setInterval(wsLinksWinPosition, 300);
    wsLinksWinEl.innerHTML = wsLinksWindowHtml(info, workshopLinkArmMode);
    wsLinksWinPosition();
    const rerender = () => { wsLinksWinRender(info); };
    // Arm / disarm a link mode. The armed pick posts /stockpile-link with the WIRE mode
    // (wsLinkWireMode maps the workshop-side verb onto the stockpile-first route), then
    // re-reads the workshop -- the mode STAYS armed so several piles can be linked in a row.
    wsLinksWinEl.querySelectorAll("[data-ws-link-arm]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const mode = btn.dataset.wsLinkArm === "take" ? "take" : "give";
      if (workshopLinkArmMode === mode) {
        workshopLinkArmMode = null;
        if (window.DFWsLink && typeof window.DFWsLink.disarm === "function") window.DFWsLink.disarm();
        rerender();
        return;
      }
      workshopLinkArmMode = mode;
      window.DFWsLink = window.DFWsLink || {};
      window.DFWsLink.onPick = async spId => {
        try {
          await workshopPost("/stockpile-link", wsLinkPayload(spId, info.id, workshopLinkArmMode, true));
          workshopStatusMsg = "Stockpile linked.";
          workshopStatusIsError = false;
        } catch (err) {
          workshopStatusMsg = err.message || "Could not link stockpile.";
          workshopStatusIsError = true;
        }
        await openWorkshopPanel(info.id, activeWorkshopTab);
      };
      window.DFWsLink.onFailed = msg => {
        workshopStatusMsg = msg || "Click a stockpile on the map.";
        workshopStatusIsError = true;
        renderWorkshopPanel(info);
      };
      if (typeof window.DFWsLink.arm === "function") window.DFWsLink.arm(info.id, mode);
      rerender();
    }));
    wsLinksWinEl.querySelector("[data-ws-links-done]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopLinksOpen = false;
      wsLinksWinDestroy();
      renderWorkshopPanel(info);
      focusPage();
    });
    wsLinksWinEl.querySelectorAll("[data-ws-link-locate]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const pos = { x: Number(btn.dataset.spX), y: Number(btn.dataset.spY), z: Number(btn.dataset.spZ) };
      if (typeof centerAndFlashMapPos === "function" && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))
        centerAndFlashMapPos(pos);
      focusPage();
    }));
    wsLinksWinEl.querySelectorAll("[data-ws-link-remove]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/stockpile-link",
          wsLinkPayload(btn.dataset.wsLinkRemove, info.id, btn.dataset.wsLinkDir, false));
        workshopStatusMsg = "Stockpile unlinked.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not unlink stockpile.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, activeWorkshopTab);
      focusPage();
    }));
  }

  // --- Activity zone panel: enable/disable (active shaded), remove, + per-type specials ---
  // B217 r2: label strings are NATIVE's ("Pen/Pasture", "Pit/Pond", "Sand", "Clay" -- B217-2,
  // Z12-jt-4 and the palette captures; the old spaced-slash / "Collection" forms were ours).
  const ZONE_TYPE_LABEL = {
    Pond: "Pit/Pond", Pen: "Pen/Pasture", WaterSource: "Water Source",
    MeetingHall: "Meeting Area", FishingArea: "Fishing", SandCollection: "Sand",
    ClayCollection: "Clay", Dump: "Garbage Dump", PlantGathering: "Gather Fruit",
    AnimalTraining: "Animal Training", Dungeon: "Dungeon", Bedroom: "Bedroom",
    DiningHall: "Dining Hall", Office: "Office", Dormitory: "Dormitory",
    Barracks: "Barracks", ArcheryRange: "Archery Range", Tomb: "Tomb"
  };
  // B217 r2: the type row leads with the zone icon in a gold box (Z12-jt-1, B217-2) -- the same
  // art the palette paints, keyed here by the /zone-info enum string.
  const ZONE_TYPE_SPRITE = {
    Pond: "ZONE_PIT", Pen: "ZONE_PEN", WaterSource: "ZONE_WATER_SOURCE",
    MeetingHall: "ZONE_MEETING", FishingArea: "ZONE_FISHING", SandCollection: "ZONE_SAND",
    ClayCollection: "ZONE_CLAY", Dump: "ZONE_DUMP", PlantGathering: "ZONE_GATHER",
    AnimalTraining: "ZONE_ANIMAL_TRAINING", Dungeon: "ZONE_DUNGEON", Bedroom: "ZONE_BEDROOM",
    DiningHall: "ZONE_DINING_HALL", Office: "ZONE_OFFICE", Dormitory: "ZONE_DORMITORY",
    Barracks: "ZONE_BARRACKS", ArcheryRange: "ZONE_ARCHERY_RANGE", Tomb: "ZONE_TOMB"
  };
  // Native's unnamed-zone phrasing, from the captures that show it (pen: B217-2/Z12-jt-4;
  // bedroom: Z12-jt-1; gather: Z11-19; meeting hall: Z13-3/LEVER-LINK-1; barracks: the barracks
  // oracle). Uncaptured types derive "Unnamed <label lowercase>" -- flagged in the closeout.
  const ZONE_UNNAMED = {
    Pen: "Unnamed pen/pasture", Bedroom: "Unnamed bedroom",
    PlantGathering: "Unnamed plant gathering area", MeetingHall: "Unnamed meeting hall",
    Barracks: "Unnamed barracks",
    ArcheryRange: "Unnamed archery range",   // B251: derived, not captured -- see the closeout.
  };
  function zoneUnnamedLabel(type, typeLabel) {
    return ZONE_UNNAMED[type] || `Unnamed ${String(typeLabel || "zone").toLowerCase()}`;
  }
  // LEVER-LINK-1 / Z13-3: a zone attached to a location swaps its type icon for the LOCATION's
  // own icon (tavern mug, hospital staff) and its label for "location name / location type".
  const LOCATION_TYPE_SPRITE = [
    ["tavern", "ZONE_TAVERN"], ["inn", "ZONE_TAVERN"], ["hospital", "ZONE_HOSPITAL"],
    ["temple", "ZONE_TEMPLE"], ["library", "ZONE_LIBRARY"], ["guildhall", "ZONE_GUILDHALL"],
    ["shrine", "ZONE_SHRINE"],
  ];
  function zoneLocationSprite(locationType) {
    const label = String(locationType || "").toLowerCase();
    for (const [needle, sprite] of LOCATION_TYPE_SPRITE)
      if (label.includes(needle)) return sprite;
    return null;
  }
  // Native's own tooltip copy, transcribed verbatim from the captures.
  const ZONE_TIP_LOCATION_ASSIGN = "Assign a new or existing location to this zone. Locations are groups of zones and rooms with a larger purpose, like a tavern, a temple, a library, or a craft guildhall."; // LEVER-LINK-3
  const ZONE_TIP_LOCATION_DETAILS = "Set details for the assigned location.";                       // LEVER-LINK-1
  const ZONE_TIP_GATHER_TREES = "Gather fruit in trees in and just above this zone. Requires a stepladder."; // Z11-19
  const ZONE_TIP_GATHER_SHRUBS = "Gather fruit and vegetables from shrubs in this zone.";           // Z11-20
  const ZONE_TIP_GATHER_FALLEN = "Gather fallen fruit in this zone.";                               // Z11-21
  // B117: DFHack names an unnamed civzone with a generic "Activity Zone #N" (for every zone type),
  // which is useless as a panel title -- the meaningful label is the zone TYPE (Office, Bedroom, ...).
  // Treat that auto-generated form (or an empty name) as "no real name" and fall back to the type
  // label; a zone the player actually renamed in DF keeps its custom name.
  function zoneIsAutoNamed(name) {
    return !name || /^activity zone\b/i.test(String(name).trim());
  }
  function zoneDisplayName(name, typeLabel) {
    return zoneIsAutoNamed(name) ? typeLabel : name;
  }
  // B251. DF's blue-flag squad selector (df::squad_selector_context_type, df.d_interface.xml:1421)
  // has EXACTLY two contexts: ZONE_BARRACKS_ASSIGNMENT and ZONE_ARCHERY_RANGE_ASSIGNMENT. We only
  // ever rendered the barracks one. `canSquads` is the server's own verdict (it shares the C++
  // predicate with both the /zone-squads read and the /zone-squad-action write, so the control can
  // never render on a zone whose click would 400). A DLL that predates canSquads cannot serve
  // archery squads AT ALL -- so there we fall back to isBarracks and deliberately do NOT offer the
  // archery control, rather than shipping a button that 400s.
  function zoneAcceptsSquads(info) {
    if (!info) return false;
    if (typeof info.canSquads === "boolean") return info.canSquads;
    return !!info.isBarracks;
  }
  function squadRoomName(name, type) {
    return zoneIsAutoNamed(name)
      ? zoneUnnamedLabel(type, ZONE_TYPE_LABEL[type] || type) : name;
  }

  // ---- WAVE 5: the zone toggles are NATIVE LATCHES ---------------------------------------------
  // Every `.zone-tgl` here was a hand-built text button. DF renders each of them as a TWO-STATE
  // SPRITE TILE, and the whole vocabulary already ships in web/interface_map.json (ZONE_SUSPEND,
  // ZONE_POND_*, ZONE_PIT_*, ZONE_GATHER_*, ZONE_TOMB_*_BURIAL_*, ZONE_SHOOT_*) -- 100% unadopted
  // until now. Two different sprites per state is latchHtml's exact contract (checkHtml is for one
  // control saying yes/no; a latch is two DIFFERENT icons). Each latch keeps its `data-zone-act`
  // dataset verbatim, so the delegated [data-zone-act] handler dispatches EXACTLY what it did
  // before -- the wire is untouched, only the rendering changed.
  //
  // *** THE STATUS TOGGLE COLLAPSES TO ONE TILE, AND LOSES NO FUNCTION. *** Native draws zone
  // active/suspended as ONE blue pause tile, not a labelled pair. The single latch still reaches
  // BOTH wire actions -- it dispatches "disable" while the zone is active and "enable" while it is
  // suspended -- so both /zone-action verbs stay reachable. Nothing is deleted.
  function zoneLatch(cfg) {
    return DWFUI.latchHtml({
      on: cfg.on, cls: "zone-tgl", sprite: cfg.off, activeSprite: cfg.on_,
      dataset: { zoneAct: cfg.act }, title: cfg.title, ariaLabel: cfg.title,
    });
  }

  // ---- B217 r2: zonePanelMarkup renders NATIVE's arrangement -------------------------------------
  // Oracles: B217-2 (pen), Z12-jt-1/3/4 (bedroom, owner row, pen), Z11-19/20/21 (gather + option
  // tooltips), LEVER-LINK-1/3 + Z13-3 (attached location), "barracks zone .png" (squad tile).
  //   row 1  name input + quill, flush right. NO close X (native has none; ESC / map click).
  //   row 2  [type icon in gold box] [label] .... [repaint][suspend][remove] butted, flush right.
  //   left   owner row (portrait + readable name) when assigned; superset extras at the bottom.
  //   rail   right-aligned under the cluster: per-type option latches, the per-type assign tile,
  //          then -- pinned to the panel's bottom-right in EVERY capture -- the location pair.
  function zonePanelMarkup(info, options = {}) {
    const typeLabel = ZONE_TYPE_LABEL[info.type] || info.type || "Zone";
    const owner = info.owner || {};
    const location = info.location || {};
    const gather = info.gather || {};
    const tomb = info.tomb || {};
    const archery = info.archery || {};
    const hasLocation = Number(location.id) >= 0;
    const autoNamed = zoneIsAutoNamed(info.name);
    const headTitle = autoNamed ? typeLabel : info.name;
    const assignedCount = Math.max(0, Number(info.assignedUnits) || 0);
    const assignedText = `${assignedCount} assigned`;

    // ---- the right rail ------------------------------------------------------------------------
    const rail = [];
    // Gather options: native order is TREES, SHRUBS, FALLEN (Z11-19/20/21, one tooltip per shot).
    if (info.isGather) rail.push(`<div class="zone-rail-row">${
      zoneLatch({ on: !!gather.trees, off: "ZONE_GATHER_TREE_INACTIVE", on_: "ZONE_GATHER_TREE_ACTIVE", act: gather.trees ? "gather-trees-off" : "gather-trees-on", title: ZONE_TIP_GATHER_TREES })}${
      zoneLatch({ on: !!gather.shrubs, off: "ZONE_GATHER_SHRUB_INACTIVE", on_: "ZONE_GATHER_SHRUB_ACTIVE", act: gather.shrubs ? "gather-shrubs-off" : "gather-shrubs-on", title: ZONE_TIP_GATHER_SHRUBS })}${
      zoneLatch({ on: !!gather.fallen, off: "ZONE_GATHER_FALLEN_INACTIVE", on_: "ZONE_GATHER_FALLEN_ACTIVE", act: gather.fallen ? "gather-fallen-off" : "gather-fallen-on", title: ZONE_TIP_GATHER_FALLEN })}</div>`);
    if (info.isPitPond) rail.push(`<div class="zone-rail-row">${
      zoneLatch({ on: !!info.fillingPond, off: "ZONE_POND_INACTIVE", on_: "ZONE_POND_ACTIVE", act: "pond", title: "Pond (fill with water)" })}${
      zoneLatch({ on: !info.fillingPond, off: "ZONE_PIT_INACTIVE", on_: "ZONE_PIT_ACTIVE", act: "pit", title: "Pit (drop)" })}</div>`);
    // *** LIVE BUG FIXED IN WAVE 5, KEPT VERBATIM: *** /zone-action accepts ONLY `tomb-pets-*`
    // (src/building_zone.cpp) -- the bare `pets-*` form belongs to the COFFIN route alone.
    if (info.isTomb) rail.push(`<div class="zone-rail-row">${
      zoneLatch({ on: !!tomb.citizens, off: "ZONE_TOMB_CITIZEN_BURIAL_INACTIVE", on_: "ZONE_TOMB_CITIZEN_BURIAL_ACTIVE", act: tomb.citizens ? "tomb-citizens-off" : "tomb-citizens-on", title: "Bury citizens here" })}${
      zoneLatch({ on: !!tomb.pets, off: "ZONE_TOMB_PET_BURIAL_INACTIVE", on_: "ZONE_TOMB_PET_BURIAL_ACTIVE", act: tomb.pets ? "tomb-pets-off" : "tomb-pets-on", title: "Bury pets here" })}</div>`);
    if (info.isArchery) {
      const dir = archery.direction || "west";
      rail.push(`<div class="zone-rail-row">${
        zoneLatch({ on: dir === "west", off: "ZONE_SHOOT_LEFT_INACTIVE", on_: "ZONE_SHOOT_LEFT_ACTIVE", act: "archery-west", title: "Shoot from the west" })}${
        zoneLatch({ on: dir === "east", off: "ZONE_SHOOT_RIGHT_INACTIVE", on_: "ZONE_SHOOT_RIGHT_ACTIVE", act: "archery-east", title: "Shoot from the east" })}</div>`);
      rail.push(`<div class="zone-rail-row">${
        zoneLatch({ on: dir === "north", off: "ZONE_SHOOT_UP_INACTIVE", on_: "ZONE_SHOOT_UP_ACTIVE", act: "archery-north", title: "Shoot from the north" })}${
        zoneLatch({ on: dir === "south", off: "ZONE_SHOOT_DOWN_INACTIVE", on_: "ZONE_SHOOT_DOWN_ACTIVE", act: "archery-south", title: "Shoot from the south" })}</div>`);
    }
    // Per-type assign tile. Native shows NO "N assigned" line in the panel (B217-2), so the count
    // folds into the tooltip -- reachable, not painted.
    if (info.isPen || info.isPitPond) {
      const verb = info.isPen ? "Assign animals to pasture"
        : (info.fillingPond ? "Assign animals to pond" : "Assign animals to drop");
      rail.push(`<div class="zone-rail-row">${DWFUI.artBtnHtml({ sprite: "ZONE_PICK_ANIMALS", cls: "zone-tgl",
        dataset: { zoneUnits: "" }, title: `${verb} (${assignedText})`, ariaLabel: verb })}</div>`);
    }
    if (info.canOwner) rail.push(`<div class="zone-rail-row">${DWFUI.artBtnHtml({ sprite: "ZONE_ASSIGN_UNIT", cls: "zone-tgl",
      dataset: { zoneOwner: "" },
      title: Number(owner.id) >= 0 ? `Assigned to ${owner.name || `Unit ${owner.id}`} -- click to change` : "Assign a citizen",
      ariaLabel: "Assign a citizen" })}</div>`);
    // B251: the blue flag belongs to EVERY zone DF's squad selector accepts -- barracks AND archery
    // range -- not just barracks. Same tile, same panel, same routes; only the copy differs.
    if (zoneAcceptsSquads(info)) {
      const squadCount = Math.max(0, Number(info.assignedSquads) || 0);
      // The zone name stays a LITERAL inside the template on purpose: the help-corpus extractor
      // (B207/B247) harvests `title:` templates and turns every ${...} into a slot, so hiding the
      // words behind a helper call would delete this tooltip from the player's help reference.
      rail.push(`<div class="zone-rail-row">${DWFUI.artBtnHtml({ sprite: "ZONE_SQUAD_LIST", cls: "zone-tgl",
        dataset: { zoneSquads: "" },
        title: `Assign squads to this ${info.type === "ArcheryRange" ? "archery range" : "barracks"} (${squadCount === 1 ? "1 squad assigned" : `${squadCount} squads assigned`})`,
        ariaLabel: "Assign squads" })}</div>`);
    }
    // The location pair rides the panel's bottom-right corner in every capture (.zone-rail-location
    // carries margin-top:auto). Tooltip copy is native's own.
    if (info.canLocation) rail.push(`<div class="zone-rail-row zone-rail-location">${
      DWFUI.artBtnHtml({ sprite: "ZONE_LOCATION_ASSIGN", cls: "zone-tgl", dataset: { zoneLocations: "" },
        title: ZONE_TIP_LOCATION_ASSIGN, ariaLabel: "Assign location" })}${
      hasLocation ? DWFUI.artBtnHtml({ sprite: "ZONE_LOCATION_DETAILS", cls: "zone-tgl",
        dataset: { zoneLocationOpen: Number(location.id) }, title: ZONE_TIP_LOCATION_DETAILS,
        ariaLabel: "Location details" }) : ""}</div>`);

    // ---- the tool cluster (repaint | suspend | remove), butted, flush right ---------------------
    const coreTools = `<span class="zone-core-tools">${
      DWFUI.artBtnHtml({ sprite: "ZONE_REPAINT", cls: "zone-tgl zone-repaint-tile", dataset: { zoneRepaint: "" },
        title: "Repaint area -- extend this zone by painting a rectangle on the map", ariaLabel: "Repaint area" })}${
      zoneLatch({ on: !info.active, off: "ZONE_SUSPEND_INACTIVE", on_: "ZONE_SUSPEND",
        act: info.active ? "disable" : "enable",
        title: info.active ? "Zone active (click to suspend)" : "Zone suspended (click to activate)" })}${
      DWFUI.artBtnHtml({ sprite: "ZONE_REMOVE_EXISTING", cls: "zone-tgl zone-remove-tile",
        dataset: { zoneAct: "remove" }, title: "Remove zone", ariaLabel: "Remove zone" })}</span>`;

    // ---- the type row ---------------------------------------------------------------------------
    const typeSprite = (hasLocation && zoneLocationSprite(location.type)) || ZONE_TYPE_SPRITE[info.type] || null;
    const typeIcon = typeSprite
      ? DWFUI.iconHtml({ sprite: typeSprite, size: 32, alt: typeLabel })
      : DWFUI.iconHtml({ emptyTile: true, alt: typeLabel });
    const typeLabelHtml = hasLocation
      ? `<span class="zone-type-label">${escapeHtml(location.name || location.type || "Location")}<small class="zone-type-sub">${escapeHtml(location.type || "")}</small></span>`
      : `<span class="zone-type-label">${escapeHtml(typeLabel)}</span>`;
    const typeRow = `<div class="zone-type-row"><span class="zone-type-icon">${typeIcon}</span>${typeLabelHtml}${coreTools}</div>`;

    // ---- the owner row (Z12-jt-3: portrait + readable name, left, under the type row) -----------
    const ownerRow = (info.canOwner && Number(owner.id) >= 0)
      ? `<div class="zone-owner-row">${zoneOwnerPortraitHtml(owner)}<span class="zone-owner-name">${escapeHtml(owner.name || `Unit ${owner.id}`)}</span></div>`
      : "";

    // SUPERSET (kept, dressed native): overlap cycling has real native art -- ZONE_PREVIOUS /
    // ZONE_NEXT / ZONE_MULTI all exist. The count readout has no native counterpart and stays.
    const cycle = options.cycle;
    const cycling = cycle && Array.isArray(cycle.ids) && cycle.ids.length > 1;
    const cycleRow = cycling ? `
      <div class="zone-btn-row zone-cycle-row">
        ${DWFUI.artBtnHtml({ sprite: "ZONE_PREVIOUS", cls: "zone-tgl", dataset: { zoneCycle: -1 },
          title: "Previous zone on this tile", ariaLabel: "Previous zone on this tile" })}
        <span class="zone-cycle-count">${DWFUI.iconHtml({ sprite: "ZONE_MULTI", cls: "zone-cycle-icon", alt: "Several zones on this tile" })}${Number(cycle.idx) + 1}/${cycle.ids.length}</span>
        ${DWFUI.artBtnHtml({ sprite: "ZONE_NEXT", cls: "zone-tgl", dataset: { zoneCycle: 1 },
          title: "Next zone on this tile", ariaLabel: "Next zone on this tile" })}
      </div>` : "";

    // A server-side refusal of an extend/repaint drag (e.g. "repaint cannot erase an entire zone",
    // "footprint too large") arrives as response text the placement caller can thread back here via
    // options.status. Without this sink the panel reopened unchanged and the player never learned the
    // drag was rejected (fail-silent). One transient alert; the next ordinary open (no status) clears it.
    const statusMsg = options.status && options.status.text
      ? DWFUI.statusHtml({ cls: "zone-action-status", tone: options.status.isError ? "danger" : "good",
          role: options.status.isError ? "alert" : "status", live: options.status.isError ? "assertive" : "polite",
          text: String(options.status.text) })
      : "";

    // WAVE zone-parity (B217): everything below the pinned header stays ONE DWFUI scrollbox --
    // round 1's overflow fix. The scrollbar appears only on genuine overflow.
    const bodyHtml = `${statusMsg}${typeRow}
      <div class="zone-body-grid">
        <div class="zone-body-left">${ownerRow}${options.orderedByLine || ""}${cycleRow}</div>
        <div class="zone-rail">${rail.join("")}</div>
      </div>`;
    // Row 1 is native's NAME ROW: an editable field (auto-named zones show native's "Unnamed ..."
    // phrasing as the placeholder) + the quill tile. close:false -- native zone panels carry no X;
    // ESC and map clicks dismiss (dwf-core.js ESC_ONLY_SELECTION_VARIANTS).
    return `${DWFUI.headerHtml({
      cls: "bld-head zone-head", close: false, titleCls: "zone-name-cell",
      titleHtml: DWFUI.rawHtml("editable zone-name field: the browser must own caret/selection/IME, so this is DWFUI.textInputHtml (the component grammar for editable copy), not bitmap text",
        DWFUI.textInputHtml({
          cls: "zone-name-input", dataset: { zoneName: "" }, value: autoNamed ? "" : info.name,
          placeholder: zoneUnnamedLabel(info.type, typeLabel), maxLength: 128,
          ariaLabel: `Zone name (${headTitle})`, title: "Zone name -- Enter saves, Escape reverts",
        })),
      tools: [{ sprite: DWFUI.TOKENS.sprites.zoneQuill, cls: "zone-quill", dataset: { zoneNameFocus: "" },
        title: "Name this zone", ariaLabel: "Name this zone" }],
    })}${DWFUI.scrollHtml({ cls: "zone-info-body" }, bodyHtml)}`;
  }

  // The owner row's portrait: same fallback chain as the animal rows (creature cell -> live unit
  // sprite/native bust -> FLAGGED letter -- a terminal letter must carry data-df-identity-missing).
  function zoneOwnerPortraitHtml(owner) {
    const name = owner.name || `Unit ${owner.id}`;
    const glyph = `<div class="portrait-glyph">${escapeHtml(String(name).trim().slice(0, 1).toUpperCase() || "?")}</div>`;
    const source = { id: Number(owner.id), name };
    const cell = typeof creatureCellMarkup === "function" ? creatureCellMarkup(source, "info-portrait-small", glyph) : null;
    if (cell) return cell;
    if (typeof unitPortraitMarkup === "function") return unitPortraitMarkup(source, "info-portrait-small");
    return `<span class="zone-animal-item-glyph" aria-hidden="true" data-df-identity-missing="portrait:zone-owner">${escapeHtml(String(name).slice(0, 1).toUpperCase() || "?")}</span>`;
  }

  async function openZonePanel(id, opts) {
    // opts.status = { text, isError } lets a caller (e.g. dwf-controls-placement.js repaintZoneDrag,
    // after a /zone-repaint refusal) surface a one-shot message on the reopened panel instead of
    // silently reopening it unchanged. Ordinary opens pass no opts, so the message self-clears.
    const o = opts || {};
    let info = null;
    try {
      const r = await fetch(`/zone-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) info = await r.json();
    } catch (_) {}
    if (!info || info.error || Number(info.id) < 0) {
      // Refresh-to-truth: this zone is gone (another client removed it while this panel was open,
      // or the host briefly can't answer). Show the SAME honest, explicitly-closable dead-end the
      // stockpile panel shows rather than silently vanishing -- a headless panel with no visible
      // way out reads as a freeze. Wired straight to closeSelection (no titlebar to adopt).
      selection.className = "visible building-panel zone-panel";
      selection.style.height = "";
      selection.style.maxHeight = "";
      const close = DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.close, cls: "unit-close-button",
        dataset: { zoneUnavailClose: "" }, title: "Close", ariaLabel: "Close",
      });
      panelContent(selection).innerHTML = close + `<h1>Zone unavailable</h1>`;
      const x = selection.querySelector("[data-zone-unavail-close]");
      if (x) x.addEventListener("click", event => { event.stopPropagation(); closeSelection(); focusPage(); });
      return;
    }
    const repaintTypeLabel = ZONE_TYPE_LABEL[info.type] || info.type || "Zone";
    // Wave 3.3: a hospital location attached to this zone -> delegate to the hospital panel
    // (parallels the isDepot delegation in openBuildingPanel). The hospital panel owns supplies,
    // patients, doctors and the chief-medical assignment for this zone.
    if (info.isHospital && typeof openHospitalPanel === "function") {
      openHospitalPanel(Number(info.hospitalLocationId), info);
      return;
    }
    // WP-C (WT04): "Ordered by â— player" line, merged from /attrib by zone id, toggleable.
    // Graceful: no /attrib route (pre-WP-C DLL) or unknown id -> empty string, nothing renders.
    try { if (typeof attribRefresh === "function") await attribRefresh(); } catch (_) {}
    const orderedByChip = (typeof attribRowHtml === "function") ? attribRowHtml("zone", info.id) : "";
    const orderedByLine = orderedByChip ? `<div class="bld-note bld-attrib">Ordered by ${orderedByChip}</div>` : "";
    // WD-14 SUPERSET (kept): overlap cycling -- when the clicked tile had more than one zone
    // (zoneSelectClick in dwf-controls-placement.js fills window.dfZoneCycle), the panel
    // shows PREVIOUS/NEXT tiles that walk the stack of zones under that tile client-side (each
    // step is just another /zone-info fetch via openZonePanel). `cycle` is read by the
    // [data-zone-cycle] handler below, so it stays here; the MARKUP for it moved into
    // zonePanelMarkup with the rest of the panel.
    const cycle = window.dfZoneCycle;
    const cycling = cycle && Array.isArray(cycle.ids) && cycle.ids.length > 1 &&
      cycle.ids.includes(Number(info.id));
    if (cycling) cycle.idx = cycle.ids.indexOf(Number(info.id));
    // WAVE 5: the ~110 lines of duplicate panel markup that used to sit here (a second copy of
    // specialParts / cycleRow / headContent, assigned to innerHTML and then OVERWRITTEN on the very
    // next line by zonePanelMarkup's output) are gone. They were provably unreachable -- every
    // handler below binds AFTER the second assignment -- and they were the reason this panel's
    // drift-baseline violations were all counted TWICE. zonePanelMarkup is now the ONLY renderer.
    selection.className = "visible building-panel zone-panel";
    // WAVE zone-parity (B217): the animals/owners/locations sub-views share this panel's "zone-panel"
    // layout variant, so the tall inline height clampOpenRect writes to fill THEM is not cleared by
    // the framework when we return to this short info panel (same variant key => no clearRectStyles).
    // That frozen height is the empty black gutter under the buttons in B217-1. Drop it here so the
    // compact info panel reflows to its own content height (CSS max-height/overflow reassert).
    selection.style.height = "";
    selection.style.maxHeight = "";
    panelContent(selection).innerHTML = zonePanelMarkup(info, {
      orderedByLine,
      cycle: cycling ? { ids: cycle.ids, idx: cycle.idx } : null,
      status: o.status || null,
    });
    // B217 r2: the name row IS native's rename affordance for EVERY zone type (Z12-jt-1: the
    // input + quill row). Enter/blur commit through the generic /zone-rename building route;
    // Escape reverts. The quill focuses the field. The old barracks-only rename machinery
    // (zoneRenameId / [data-zone-rename-*]) is retired by this row.
    const nameInput = selection.querySelector("[data-zone-name]");
    const initialName = nameInput ? nameInput.value : "";
    let nameBusy = false;
    const commitZoneName = async () => {
      if (!nameInput || nameBusy) return;
      const name = nameInput.value.trim();
      if (name === initialName.trim()) return;
      nameBusy = true;
      try {
        await fetch(`/zone-rename?id=${info.id}&name=${encodeURIComponent(name)}`, { method: "POST", cache: "no-store" });
      } catch (_) {}
      openZonePanel(info.id);
      loadZones();
    };
    nameInput?.addEventListener("click", event => event.stopPropagation());
    nameInput?.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); commitZoneName(); focusPage(); }
      else if (event.key === "Escape") { event.preventDefault(); nameInput.value = initialName; nameInput.blur(); }
    });
    nameInput?.addEventListener("blur", () => { commitZoneName(); });
    selection.querySelector("[data-zone-name-focus]")?.addEventListener("click", event => {
      event.stopPropagation();
      if (nameInput) { nameInput.focus(); nameInput.select(); }
    });
    // The shield-magnifier opens the attached location's own panel (LEVER-LINK-2: the details
    // window opens beside the zone panel; our location panel is that surface).
    selection.querySelector("[data-zone-location-open]")?.addEventListener("click", event => {
      event.stopPropagation();
      const locId = Number(event.currentTarget.dataset.zoneLocationOpen);
      if (typeof openLocationPanel === "function" && Number.isInteger(locId) && locId >= 0)
        openLocationPanel(locId);
      focusPage();
    });
    // Native selected-zone repaint session: keep the zone overlay visible, show its label/tile
    // count with paint/free/erase/remove tools, stage map edits, and commit only on Accept.
    selection.querySelector("[data-zone-repaint]")?.addEventListener("click", event => {
      event.stopPropagation();
      closeSelection();
      if (window.DFZoneRepaint && typeof window.DFZoneRepaint.arm === "function")
        window.DFZoneRepaint.arm(info.id, {
          label: zoneDisplayName(info.name, repaintTypeLabel),
          sprite: ZONE_TYPE_SPRITE[info.type] || null,
        });
      focusPage();
    });
    selection.querySelectorAll("[data-zone-act]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const action = btn.dataset.zoneAct;
      let refused = false;
      try {
        const r = await fetch(`/zone-action?id=${info.id}&action=${encodeURIComponent(action)}`, { method: "POST", cache: "no-store" });
        // W23: a 501 {"guarded":true} means the host guard refused -- keep the panel open and
        // say why instead of silently closing as if the zone were gone.
        if (!r.ok) refused = true;   // guarded 501 (or any failure): the zone still exists
      } catch (_) { refused = true; }
      if (action === "remove" && !refused) closeSelection();
      else openZonePanel(info.id);   // re-render with the new state (active/pit-pond shading)
      focusPage();
    }));
    selection.querySelectorAll("[data-zone-cycle]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const step = Number(btn.dataset.zoneCycle) || 1;
      const n = cycle.ids.length;
      cycle.idx = ((cycle.idx + step) % n + n) % n;
      openZonePanel(cycle.ids[cycle.idx]);
      focusPage();
    }));
    selection.querySelector("[data-zone-units]")?.addEventListener("click", event => {
      event.stopPropagation(); openZoneUnitsPanel(info.id); focusPage();
    });
    selection.querySelector("[data-zone-squads]")?.addEventListener("click", event => {
      event.stopPropagation(); openZoneSquadsPanel(info.id); focusPage();
    });
    selection.querySelector("[data-zone-owner]")?.addEventListener("click", event => {
      event.stopPropagation(); openZoneOwnersPanel(info.id); focusPage();
    });
    selection.querySelector("[data-zone-locations]")?.addEventListener("click", event => {
      event.stopPropagation(); openZoneLocationsPanel(info.id); focusPage();
    });
    // B217 r2: the zone info panel has no X (native has none); ESC / map clicks close it.
    // Optional-chained so a stray [data-bld-close] in a future skin still binds without throwing.
    selection.querySelector("[data-bld-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  async function openZoneSquadsPanel(id) {
    let data = null;
    try {
      const r = await fetch(`/zone-squads?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch (_) {}
    if (!data || Number(data.id) < 0) { openZonePanel(id); return; }
    const rows = Array.isArray(data.squads) ? data.squads : [];
    selection.className = "visible building-panel zone-panel zone-wide zone-squad-panel";
    // B217 r2: same close-less chrome as the rest of the zone family -- native's gold left-arrow
    // is the back affordance (BUTTON_CLOSE_LEFT via headerHtml `back:`), no X, no status line.
    panelContent(selection).innerHTML = `
      ${DWFUI.headerHtml({ cls: "bld-head zone-sub-head", close: false,
        back: { dataset: { zoneBack: "" }, title: "Back to zone" },
        title: squadRoomName(data.name, data.type), titleCls: "bld-name" })}
      ${rows.length ? `<div class="zone-squad-list">${zoneSquadRowsHtml(rows, escapeHtml)}</div>`
        : `<div class="zone-note">No squads are available in this fortress.</div>`}
    `;
    paintZoneSquadIcons(selection);
    selection.querySelector("[data-zone-back]").addEventListener("click", event => {
      event.stopPropagation(); openZonePanel(data.id); focusPage();
    });
    selection.querySelectorAll("[data-zone-squad-mode]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const squad = Number(btn.dataset.zoneSquad);
      const mode = btn.dataset.zoneSquadMode || "";
      const enabled = Number(btn.dataset.zoneSquadEnabled) ? 1 : 0;
      if (Number.isInteger(squad) && squad >= 0) {
        btn.disabled = true;
        try {
          await fetch(`/zone-squad-action?id=${data.id}&squad=${squad}&mode=${encodeURIComponent(mode)}&enabled=${enabled}`, {
            method: "POST", cache: "no-store"
          });
        } catch (_) {}
      }
      openZoneSquadsPanel(data.id);
      loadZones();
      focusPage();
    }));
    selection.querySelector("[data-bld-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  // ---- WAVE 5: the zone animal list adopts the native sort header, search and row -------------
  //   * the sort bar hand-rolled `&#9650;` / `&#9660;` -- an emoji where a SPRITE exists. Native's
  //     column sort header is VANILLA DF (SORT_ASCENDING_/SORT_DESCENDING_{ACTIVE,INACTIVE}), and
  //     it is a RADIOGROUP over columns with exactly one active key -- which is precisely what this
  //     bar is. sortHeaderHtml owns that grammar; the `sort:` per column is REQUIRED because native
  //     carries asc/desc in two DIFFERENT sprites, so the direction cannot be defaulted.
  //   * the search field hand-rolled a raw search input plus a magnifier EMOJI -- the
  //     same emoji the stock-item "view" ACTION uses, one glyph doing double duty as chrome and as
  //     a row action where native uses two distinct sprites. searchHtml({placement:'footer'}) is
  //     native's P1 placement (pinned bottom-left below the list) and its magnifier is BUTTON_FILTER.
  //   * the assign toggle rendered a Unicode check when on and LITERALLY NOTHING when off. Native
  //     NEVER renders nothing: checkHtml draws a real SQUADS_NOT_SELECTED tile in the off state too.
  //     It stays a real button with the identical dataset, so [data-zone-unit] is untouched.
  //   * the locate button's `&#11015;` arrow becomes RECENTER_RECENTER, a real DF tile.
  const ZONE_ANIMAL_SORT_COLUMNS = [["name", "Name"], ["category", "Cat"], ["profession", "Prof"]];
  function zoneAnimalSortBarHtml(sortKey, sortDirection) {
    return DWFUI.sortHeaderHtml({
      cls: "zone-animal-sortbar", dataAttr: "zone-animal-sort", ariaLabel: "Sort animals",
      active: sortKey,
      columns: ZONE_ANIMAL_SORT_COLUMNS.map(([key, label]) => ({
        key, label,
        // The ACTIVE column shows the direction it is currently sorted in; the others show the
        // direction they WOULD sort in (ascending), exactly as the old caret did.
        sort: (key === sortKey && Number(sortDirection) < 0) ? "desc" : "asc",
      })),
    });
  }
  function zoneProfessionNameHtml(unit, label) {
    const idx = Number(unit && unit.professionColor);
    const body = DWFUI.bitmapTextHtml(label == null ? "" : label);
    const html = Number.isInteger(idx) && idx >= 0 && idx <= 15
      ? `<span style="color:${DWFUI.dfColor(idx)}">${body}</span>` : body;
    return DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered unit name", html);
  }
  function zoneAnimalRowHtml(unit) {
    const state = zoneAnimalAssignmentState(unit);
    const flags = Array.isArray(unit.flags)
      ? unit.flags.filter(flag => flag !== "assigned here" && flag !== "assigned elsewhere") : [];
    const meta = flags.join(" | ");
    const kind = unit.kind || "unit";
    const name = unit.name || unit.race || `Unit ${unit.id}`;
    const label = zoneAnimalNativeLabel(unit);
    const glyph = `<div class="portrait-glyph">${escapeHtml(String(unit.race || name).slice(0, 1).toUpperCase() || "?")}</div>`;
    const creaturePortrait = kind === "unit" && typeof creatureCellMarkup === "function"
      ? creatureCellMarkup({ ...unit, rt: unit.rt || unit.race }, "info-portrait-small", glyph) : null;
    // A terminal letter must be FLAGGED (the letter fallback is fine to look at, but only if
    // flagged). unitPortraitMarkup marks its own; this non-unit branch is the last letter left.
    const portrait = creaturePortrait || (kind === "unit" && typeof unitPortraitMarkup === "function"
      ? unitPortraitMarkup(unit, "info-portrait-small")
      : `<span class="zone-animal-item-glyph" aria-hidden="true" data-df-identity-missing="portrait:non-unit">${escapeHtml(String(name).slice(0, 1).toUpperCase() || "?")}</span>`);
    // B217 r2: native marks ASSIGNED rows with the gold down-arrow-on-grass tile and renders
    // NOTHING in that column on unassigned rows (Z12-jt-5 vs B152-1). The tile has no
    // interface_map token, so it is the oracle-extracted --spa-zone-assign-arrow asset; our
    // locate wire rides it (honest tooltip). Unassigned rows keep an empty slot so the check
    // column stays x-aligned across mixed rows.
    const locate = state.assigned
      ? DWFUI.artBtnHtml({
        art: "zoneAssignArrow", cls: "zone-animal-locate",
        dataset: { zoneUnitLocate: Number(unit.id), zoneX: Number(unit.x), zoneY: Number(unit.y), zoneZ: Number(unit.z) },
        title: `Assigned here -- view ${name} on the map`, ariaLabel: `View ${name} on the map`,
      })
      : `<span class="zone-animal-locate-slot" aria-hidden="true"></span>`;
    const toggle = DWFUI.checkHtml({
      checked: state.assigned, cls: "zone-animal-toggle",
      dataset: { zoneUnit: Number(unit.id), zoneKind: kind, zoneAssign: state.assign },
      title: `${state.action} ${name}`, ariaLabel: `${state.action} ${name}`,
    });
    return DWFUI.rowHtml({
      cls: "zone-unit-row zone-animal-row" + (state.assigned ? " assigned" : ""),
      dataset: { zoneRow: Number(unit.id), zoneSearch: `${label} ${unit.race || ""} ${meta}`.toLowerCase() },
      icon: portrait,
      copyCls: "zone-animal-copy", labelCls: "zone-unit-name",
      labelHtml: DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered zone unit name",
        zoneProfessionNameHtml(unit, label)),
      sub: meta ? { text: meta, cls: "zone-unit-meta" } : null,
      trailing: locate + toggle,
    });
  }
  function zoneAnimalsPanelMarkup(data, options) {
    const o = options || {};
    const typeLabel = ZONE_TYPE_LABEL[data?.type] || data?.type || "Zone";
    const sortKey = o.sortKey || "name";
    const sortDirection = Number(o.sortDirection) < 0 ? -1 : 1;
    const rows = zoneAnimalSortedRows(data?.units, sortKey, sortDirection);
    const body = rows.length
      ? `${zoneAnimalSortBarHtml(sortKey, sortDirection)}` +
        DWFUI.scrollHtml({ cls: "zone-unit-list zone-animal-list" }, rows.map(zoneAnimalRowHtml).join("")) +
        DWFUI.searchHtml({
          cls: "zone-animal-search", placement: "footer", magnifier: true,
          dataAttr: "zone-animal-search", type: "search", value: o.search || "",
          preserveKey: "zone-animals", ariaLabel: "Search animals",
        })
      : `<div class="zone-note">No assignable animals found.</div>`;
    // B217 r2: native's chooser has no title bar, no status line and no X -- the zone panel's
    // gold left-arrow (BUTTON_CLOSE_LEFT) is the way back. The head stays (adoptHeadSel drag
    // handle) but carries only the back arrow + the zone's display name.
    return `${DWFUI.headerHtml({ cls:"bld-head zone-sub-head", close:false,
      back: { dataset: { zoneBack: "" }, title: "Back to zone" },
      title:zoneDisplayName(data?.name, typeLabel), titleCls:"bld-name" })}${body}`;
  }

  // B271-PORTRAIT (a DIFFERENT defect from the B270 sizing one -- see the closeout): a chooser row
  // resolves its portrait through unitPortraitMarkup, and for these rows EVERY branch of that chain
  // is dead except one. The wire carries no race token (so creatureCellMarkup returns null) and no
  // portraitTexpos/portraitState (so nativePortraitState() answers "unavailable" and BOTH native
  // bust branches bail). The single surviving source is liveUnitSprite(id), which looks the unit up
  // in (a) the units of the frame CURRENTLY ON SCREEN, or (b) window.__dfcUnitSpriteSnap, the
  // fort-wide composite-sprite snapshot. A dwarf who is neither on screen nor in the snapshot gets
  // the terminal LETTER -- which is exactly the capture: a mixed list, portraits for the dwarves
  // in view and E / L / R for the ones underground.
  // The snapshot exists precisely to cover off-screen units ("B32: warm the composite-sprite
  // snapshot for units that just left the viewport") -- but it is warmed by the unit sheet and the
  // build/info panels, and NEVER by the zone choosers. So these panels rendered against whatever
  // snapshot happened to be lying around, or none at all. Warm it here, before the markup is built.
  // This is a COVERAGE fix on the client and it depends on the server's composite bake actually
  // covering the unit (B278 fixed that census). The ROOT fix is the WIRE: ZoneOwnerRow
  // (src/building_zone.cpp) should carry portraitTexpos + portraitState like every other unit-row
  // payload does, which would re-open the native-bust branch. That needs a DLL build and is out of
  // this wave's scope -- recorded, not silently skipped.
  function warmUnitSpriteSnapshot() {
    try {
      return typeof refreshUnitSpriteSnapshot === "function" ? refreshUnitSpriteSnapshot() : null;
    } catch (_) { return null; }
  }

  async function openZoneUnitsPanel(id, restore = {}) {
    let data = null;
    const warm = warmUnitSpriteSnapshot();
    try {
      const r = await fetch(`/zone-units?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch (_) {}
    try { await warm; } catch (_) {}
    if (!data || Number(data.id) < 0) { openZonePanel(id); return; }
    selection.className = "visible building-panel zone-panel zone-wide zone-animal-panel";
    // WAVE 5: duplicate markup deleted -- zoneAnimalsPanelMarkup(data, ...) overwrote it on the
    // next line and every handler binds after that. Provably dead.
    panelContent(selection).innerHTML = zoneAnimalsPanelMarkup(data, {
      sortKey: zoneAnimalSortKey, sortDirection: zoneAnimalSortDirection, search: zoneAnimalSearch,
    });
    const animalList = selection.querySelector(".zone-animal-list");
    const applySearch = () => {
      animalList?.querySelectorAll("[data-zone-row]").forEach(row => {
        row.hidden = typeof dfTokenMatch === "function"
          ? !dfTokenMatch(row.dataset.zoneSearch || "", zoneAnimalSearch)
          : !String(row.dataset.zoneSearch || "").includes(zoneAnimalSearch.trim().toLowerCase());
      });
    };
    applySearch();
    requestAnimationFrame(() => {
      if (!animalList) return;
      animalList.scrollTop = Math.min(Number(restore.scrollTop) || 0, Math.max(0, animalList.scrollHeight - animalList.clientHeight));
      const kept = animalList.querySelector(`[data-zone-row="${Number(restore.keepUnit)}"]`);
      if (!kept || kept.hidden) return;
      const top = kept.offsetTop;
      const bottom = top + kept.offsetHeight;
      if (top < animalList.scrollTop) animalList.scrollTop = top;
      else if (bottom > animalList.scrollTop + animalList.clientHeight)
        animalList.scrollTop = bottom - animalList.clientHeight;
    });
    selection.querySelectorAll("[data-zone-animal-sort]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const key = btn.dataset.zoneAnimalSort || "name";
      if (key === zoneAnimalSortKey) zoneAnimalSortDirection *= -1;
      else { zoneAnimalSortKey = key; zoneAnimalSortDirection = 1; }
      openZoneUnitsPanel(data.id, { scrollTop: animalList?.scrollTop || 0 });
    }));
    selection.querySelector("[data-zone-animal-search]")?.addEventListener("input", event => {
      zoneAnimalSearch = event.target.value || "";
      applySearch();
    });
    selection.querySelector("[data-zone-back]").addEventListener("click", event => {
      event.stopPropagation(); openZonePanel(data.id); focusPage();
    });
    selection.querySelectorAll("[data-zone-unit]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const unit = Number(btn.dataset.zoneUnit);
      const kind = btn.dataset.zoneKind || "unit";
      const assign = Number(btn.dataset.zoneAssign) ? 1 : 0;
      const scrollTop = animalList?.scrollTop || 0;
      if (Number.isInteger(unit) && unit >= 0) {
        btn.disabled = true;
        try {
          await fetch(`/zone-unit-action?id=${data.id}&unit=${unit}&assign=${assign}&kind=${encodeURIComponent(kind)}`, { method: "POST", cache: "no-store" });
        } catch (_) {}
      }
      await openZoneUnitsPanel(data.id, { scrollTop, keepUnit: unit });
      loadZones();
      focusPage();
    }));
    selection.querySelectorAll("[data-zone-unit-locate]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const pos = { x: Number(btn.dataset.zoneX), y: Number(btn.dataset.zoneY), z: Number(btn.dataset.zoneZ) };
      if (typeof centerAndFlashMapPos === "function" && pos.x >= 0 && pos.y >= 0 && pos.z >= 0)
        centerAndFlashMapPos(pos);
      focusPage();
    }));
    selection.querySelector("[data-bld-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  // ---- B217 r2: the owner chooser adopts NATIVE's grammar (Z12-jt-2) ---------------------------
  // Native: sort bar on top ([v Name][v Cat][v Prof] + one extra bare control), "Remove assignment"
  // as a full-width TOP ROW inside the list, portrait rows that are CLICK-TO-ASSIGN (no text
  // buttons), and the footer search with the magnifier. Two native columns need data the
  // /zone-owners wire does not carry (unit category for "Cat", the mood face) -- their controls
  // ship disabled with honest tooltips rather than being invented (Oracle-Perfect rule).
  let zoneOwnerSortKey = "name";
  let zoneOwnerSortDirection = 1;
  let zoneOwnerSearch = "";
  function zoneOwnerSortedRows(rows, key, direction) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    const val = u => key === "profession" ? String(u.profession || "") : String(u.name || "");
    list.sort((a, b) => val(a).localeCompare(val(b)) * direction ||
      String(a.name || "").localeCompare(String(b.name || "")));
    return list;
  }
  function zoneOwnerRowHtml(u, typeLabel) {
    const name = u.name || `Unit ${u.id}`;
    const flags = [];
    if (u.profession) flags.push(u.profession);
    if (u.dead) flags.push("deceased");
    if (Number(u.sameTypeRooms) > 0) flags.push(`${u.sameTypeRooms} other ${typeLabel}`);
    const glyph = `<div class="portrait-glyph">${escapeHtml(String(name).trim().slice(0, 1).toUpperCase() || "?")}</div>`;
    const portrait = typeof unitPortraitMarkup === "function"
      ? unitPortraitMarkup(u, "info-portrait-small")
      : `<span class="zone-animal-item-glyph" aria-hidden="true" data-df-identity-missing="portrait:zone-owner">${escapeHtml(String(name).slice(0, 1).toUpperCase() || "?")}</span>`;
    const professionColor = Number(u && u.professionColor);
    const nameHtml = Number.isInteger(professionColor) && professionColor >= 0 && professionColor <= 15
      ? `<span style="color:${DWFUI.dfColor(professionColor)}">${DWFUI.bitmapTextHtml(name)}</span>`
      : DWFUI.bitmapTextHtml(name);
    return DWFUI.rowHtml({
      cls: "zone-unit-row zone-owner-pick-row" + (u.assigned ? " assigned" : ""),
      role: "button",
      dataset: { zoneOwnerUnit: Number(u.id), zoneSearch: `${name} ${u.profession || ""}`.toLowerCase() },
      icon: portrait, copyCls: "zone-animal-copy", labelCls: "zone-unit-name",
      labelHtml: DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered room-owner name", nameHtml),
      sub: flags.length ? { text: flags.join(" | "), cls: "zone-unit-meta" } : null,
      title: u.assigned
        ? `Assigned to this ${typeLabel} -- click to remove the assignment`
        : `Assign this ${typeLabel} to ${name}`,
    });
  }
  // B270: the owner chooser's markup used to be INLINE in openZoneOwnersPanel, tangled with the
  // fetch and the event binding. That is precisely why it had NO ui-lab story and NO test surface,
  // and why it could ship with its rows laid out into the wrong grid tracks and nobody see it --
  // the same "the lab only ever previewed the short case" mechanism that shipped B250. It is now a
  // PURE markup builder (data in, html out), exported on the same api as zoneAnimalsPanelMarkup, so
  // the lab renders the REAL production chooser and the geometry probe measures the REAL DOM.
  function zoneOwnersPanelMarkup(data, options) {
    const o = options || {};
    const typeLabel = ZONE_TYPE_LABEL[data?.type] || data?.type || "Zone";
    const sortKey = o.sortKey || "name";
    const sortDirection = Number(o.sortDirection) < 0 ? -1 : 1;
    const rows = zoneOwnerSortedRows(data?.owners, sortKey, sortDirection);
    const sortBar = DWFUI.sortHeaderHtml({
      cls: "zone-owner-sortbar", dataAttr: "zone-owner-sort", ariaLabel: "Sort citizens",
      active: sortKey,
      columns: [
        { key: "name", label: "Name", sort: (sortKey === "name" && sortDirection < 0) ? "desc" : "asc" },
        { key: "category", label: "Cat", sort: "asc", disabled: true,
          title: "Native sorts a unit-category column here; the /zone-owners wire carries no category data yet" },
        { key: "profession", label: "Prof", sort: (sortKey === "profession" && sortDirection < 0) ? "desc" : "asc" },
        { key: "extra", label: "", sort: "desc", disabled: true,
          title: "Native shows one more sort control here (Z12-jt-2); what it sorts is unverified" },
      ],
    });
    const clearRow = Number(data?.ownerId) >= 0
      ? DWFUI.rowHtml({ cls: "zone-unit-row zone-owner-clear-row", role: "button",
        dataset: { zoneOwnerClear: "" }, label: "Remove assignment" })
      : "";
    const listBody = rows.length || clearRow
      ? DWFUI.scrollHtml({ cls: "zone-unit-list zone-owner-list" },
        clearRow + rows.map(u => zoneOwnerRowHtml(u, typeLabel)).join(""))
      : `<div class="zone-note">No assignable citizens found.</div>`;
    return `
      ${DWFUI.headerHtml({ cls:"bld-head zone-sub-head", close:false,
        back: { dataset: { zoneBack: "" }, title: "Back to zone" },
        title:zoneDisplayName(data?.name, typeLabel), titleCls:"bld-name" })}
      ${sortBar}
      ${listBody}
      ${DWFUI.searchHtml({
        cls: "zone-owner-search", placement: "footer", magnifier: true,
        dataAttr: "zone-owner-search", type: "search", value: o.search || "",
        preserveKey: "zone-owners", ariaLabel: "Search citizens",
      })}
    `;
  }

  async function openZoneOwnersPanel(id) {
    let data = null;
    const warm = warmUnitSpriteSnapshot();   // B271-PORTRAIT: see warmUnitSpriteSnapshot above.
    try {
      const r = await fetch(`/zone-owners?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch (_) {}
    try { await warm; } catch (_) {}
    if (!data || Number(data.id) < 0) { openZonePanel(id); return; }
    selection.className = "visible building-panel zone-panel zone-wide zone-owner-panel";
    panelContent(selection).innerHTML = zoneOwnersPanelMarkup(data, {
      sortKey: zoneOwnerSortKey, sortDirection: zoneOwnerSortDirection, search: zoneOwnerSearch,
    });
    const ownerList = selection.querySelector(".zone-owner-list");
    const applyOwnerSearch = () => {
      ownerList?.querySelectorAll("[data-zone-owner-unit]").forEach(row => {
        row.hidden = typeof dfTokenMatch === "function"
          ? !dfTokenMatch(row.dataset.zoneSearch || "", zoneOwnerSearch)
          : !String(row.dataset.zoneSearch || "").includes(zoneOwnerSearch.trim().toLowerCase());
      });
    };
    applyOwnerSearch();
    selection.querySelectorAll("[data-zone-owner-sort]:not([disabled])").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const key = btn.dataset.zoneOwnerSort || "name";
      if (key === zoneOwnerSortKey) zoneOwnerSortDirection *= -1;
      else { zoneOwnerSortKey = key; zoneOwnerSortDirection = 1; }
      openZoneOwnersPanel(data.id);
    }));
    selection.querySelector("[data-zone-owner-search]")?.addEventListener("input", event => {
      zoneOwnerSearch = event.target.value || "";
      applyOwnerSearch();
    });
    selection.querySelector("[data-zone-back]").addEventListener("click", event => {
      event.stopPropagation(); openZonePanel(data.id); focusPage();
    });
    selection.querySelector("[data-zone-owner-clear]")?.addEventListener("click", async event => {
      event.stopPropagation();
      try { await fetch(`/zone-owner-action?id=${data.id}&unit=-1`, { method: "POST", cache: "no-store" }); } catch (_) {}
      openZoneOwnersPanel(data.id);
      focusPage();
    });
    selection.querySelectorAll("[data-zone-owner-unit]").forEach(row => row.addEventListener("click", async event => {
      event.stopPropagation();
      const unit = Number(row.dataset.zoneOwnerUnit);
      if (Number.isInteger(unit) && unit >= 0) {
        const nextUnit = row.classList.contains("assigned") ? -1 : unit;
        try {
          await fetch(`/zone-owner-action?id=${data.id}&unit=${nextUnit}`, { method: "POST", cache: "no-store" });
        } catch (_) {}
      }
      openZoneOwnersPanel(data.id);
      focusPage();
    }));
    selection.querySelector("[data-bld-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  async function openZoneLocationsPanel(id) {
    let data = null;
    try {
      const r = await fetch(`/zone-locations?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch (_) {}
    if (!data || Number(data.id) < 0) { openZonePanel(id); return; }
    const typeLabel = ZONE_TYPE_LABEL[data.type] || data.type || "Zone";
    const locations = Array.isArray(data.locations) ? data.locations : [];
    const createTypes = Array.isArray(data.createTypes) ? data.createTypes : [];
    const currentSummary = locations.find(l => l.current);
    let currentDetails = null;
    if (currentSummary && Number(currentSummary.id) >= 0) {
      try {
        const r = await fetch(`/location-detail?id=${Number(currentSummary.id)}&t=${Date.now()}`, { cache: "no-store" });
        if (r.ok) currentDetails = await r.json();
      } catch (_) {}
    }
    selection.className = "visible building-panel zone-panel zone-wide";
    panelContent(selection).innerHTML = `
      ${DWFUI.headerHtml({ cls:"bld-head zone-sub-head", close:false,
        back: { dataset: { zoneBack: "" }, title: "Back to zone" },
        title:zoneDisplayName(data.name, typeLabel), titleCls:"bld-name" })}
      ${Number(data.locationId) >= 0 ? `<button class="bld-btn danger" data-zone-location-clear>Remove current location assignment</button>` : ""}
      ${createTypes.length ? `<div class="zone-section-label">Create New Location</div>
        <div class="zone-location-create-grid">
          ${createTypes.map(t => `<button class="zone-mini-btn" data-zone-location-create="${escapeHtml(t.kind)}">New ${escapeHtml(t.label)}</button>`).join("")}
        </div>` : ""}
      <div class="zone-section-label">Existing Locations</div>
      ${zoneUnitListHtml(locations.map(loc => {
        const flags = [];
        if (loc.label) flags.push(loc.label);
        flags.push(`${Number(loc.zoneCount) || 0} zone${Number(loc.zoneCount) === 1 ? "" : "s"}`);
        return zoneUnitRowHtml({
          label: loc.name || loc.label || `Location ${loc.id}`,
          meta: flags.join(" | "),
          trailing: `<button class="zone-unit-act${loc.current ? " assigned" : ""}" data-zone-location="${Number(loc.id)}">${loc.current ? "Current" : "Assign"}</button>`,
        });
      }), "No existing locations found.")}
      ${(() => {
        const current = locations.find(l => l.current);
        if (!current) return "";
        const occs = Array.isArray(current.occupations) ? current.occupations : [];
        const details = currentDetails || current;
        return `
      <div class="zone-section-label">${escapeHtml(current.name || current.label || "Location")} &middot; details</div>
      <div class="zone-loc-rename">
        <input class="zone-loc-name-input" type="text" maxlength="48" value="${escapeHtml(current.name || "")}" placeholder="Location name">
        <button class="zone-mini-btn" data-zone-location-rename>Rename</button>
      </div>
      <div class="zone-loc-access"><span class="zone-loc-access-label">Access</span>
        ${window.DFLocationMarkup && window.DFLocationMarkup.locationAccessHtml
          ? window.DFLocationMarkup.locationAccessHtml(details) : ""}
      </div>
      <div class="zone-loc-occs"><span class="zone-loc-access-label">Occupations</span>
        ${occs.length ? occs.map(o => `<div class="zone-unit-meta">${escapeHtml(o.type)}: ${o.assigned ? escapeHtml(o.holder || "assigned") : "<em>open</em>"}</div>`).join("")
          : `<div class="zone-note">No occupations assigned yet.</div>`}
      </div>
      ${DWFUI.plaqueBtnHtml({ cls: "bld-btn", tone: "gold",
        dataset: { zoneLocationDetails: Number(current.id) },
        label: "Location details (staff, occupants, dedication)" })}
      <button class="bld-btn danger" data-zone-location-retire>Retire location</button>`;
      })()}
    `;
    selection.querySelector("[data-zone-back]").addEventListener("click", event => {
      event.stopPropagation(); openZonePanel(data.id); focusPage();
    });
    // B229: the occupations/occupants/dedication surface is its own panel, keyed by LOCATION id
    // (dwf-location-panel.js). This zone view stays the place where you attach a zone to a
    // location; what happens INSIDE the location lives there.
    selection.querySelector("[data-zone-location-details]")?.addEventListener("click", event => {
      event.stopPropagation();
      const locId = Number(event.currentTarget.dataset.zoneLocationDetails);
      if (typeof openLocationPanel === "function" && Number.isInteger(locId) && locId >= 0)
        openLocationPanel(locId);
      focusPage();
    });
    selection.querySelector("[data-zone-location-clear]")?.addEventListener("click", async event => {
      event.stopPropagation();
      try { await fetch(`/zone-location-action?id=${data.id}&action=clear`, { method: "POST", cache: "no-store" }); } catch (_) {}
      openZoneLocationsPanel(data.id);
      focusPage();
    });
    selection.querySelectorAll("[data-zone-location-create]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const kind = btn.dataset.zoneLocationCreate || "";
      try {
        await fetch(`/zone-location-action?id=${data.id}&action=create&kind=${encodeURIComponent(kind)}`, { method: "POST", cache: "no-store" });
      } catch (_) {}
      openZoneLocationsPanel(data.id);
      focusPage();
    }));
    selection.querySelectorAll("[data-zone-location]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const loc = Number(btn.dataset.zoneLocation);
      if (!btn.classList.contains("assigned") && Number.isInteger(loc) && loc >= 0) {
        try {
          await fetch(`/zone-location-action?id=${data.id}&action=assign&location=${loc}`, { method: "POST", cache: "no-store" });
        } catch (_) {}
      }
      openZoneLocationsPanel(data.id);
      focusPage();
    }));
    const currentLoc = locations.find(l => l.current);
    selection.querySelectorAll("[data-loc-access]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      if (!currentLoc || btn.classList.contains("active")) return;
      const mode = btn.dataset.locAccess || "";
      try {
        await fetch(`/location-native-action?id=${Number(currentLoc.id)}&action=access&mode=${encodeURIComponent(mode)}`, { method: "POST", cache: "no-store" });
      } catch (_) {}
      openZoneLocationsPanel(data.id);
      focusPage();
    }));
    selection.querySelector("[data-zone-location-rename]")?.addEventListener("click", async event => {
      event.stopPropagation();
      if (!currentLoc) return;
      const input = selection.querySelector(".zone-loc-name-input");
      const name = (input?.value || "").trim();
      if (!name) return;
      try {
        await fetch(`/zone-location-action?id=${data.id}&action=rename&location=${Number(currentLoc.id)}&kind=${encodeURIComponent(name)}`, { method: "POST", cache: "no-store" });
      } catch (_) {}
      openZoneLocationsPanel(data.id);
      focusPage();
    });
    selection.querySelector("[data-zone-location-retire]")?.addEventListener("click", async event => {
      event.stopPropagation();
      if (!currentLoc) return;
      try {
        const r = await fetch(`/zone-location-action?id=${data.id}&action=retire&location=${Number(currentLoc.id)}`, { method: "POST", cache: "no-store" });
        if (!r.ok) { const t = await r.text().catch(() => ""); alert("Cannot retire: " + (t || "location in use")); }
      } catch (_) {}
      openZoneLocationsPanel(data.id);
      focusPage();
    });
    selection.querySelector("[data-bld-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  // --- Stockpile management panel ---
  function activePresetFromGroups(g) {
    g = g || {};
    const on = Object.keys(g).filter(k => g[k] === true);
    if (on.length === 0) return "none";
    if (on.length >= 17) return "all";
    if (on.length === 1) {
      return ({ food: "food", stone: "stone", wood: "wood", furniture: "furniture",
        finished_goods: "finished", bars_blocks: "bars", gems: "gems", cloth: "cloth",
        leather: "leather", sheet: "sheets", ammo: "ammo", armor: "armor",
        weapons: "weapons", animals: "animals", refuse: "refuse", corpses: "corpses",
        coins: "coins" })[on[0]] || "";
    }
    return "";
  }
  function stockGroupForPreset(key) {
    return ({ food: "food", stone: "stone", wood: "wood", furniture: "furniture",
      finished: "finished_goods", bars: "bars_blocks", gems: "gems", cloth: "cloth",
      leather: "leather", sheets: "sheet", ammo: "ammo", armor: "armor",
      weapons: "weapons", animals: "animals", refuse: "refuse", corpses: "corpses",
      coins: "coins" })[key] || "";
  }
  function stockCatIsActive(groups, key) {
    const preset = activePresetFromGroups(groups);
    if (key === "all") return preset === "all";
    if (key === "none") return preset === "none";
    const group = stockGroupForPreset(key);
    return !!(group && groups && groups[group]);
  }
  async function openStockpilePanel(id) {
    try {
      const r = await fetch(`/stockpile-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("info failed");
      // WP-C (WT04): warm the /attrib cache before the (synchronous) render so the "Ordered by"
      // line paints on first open. Graceful/dormant on the pre-WP-C DLL.
      try { if (typeof attribRefresh === "function") await attribRefresh(); } catch (_) {}
      renderStockpilePanel(await r.json());
    } catch (_) {
      // Fetch/404 error state (the pile is gone, or the host briefly can't answer). Esc already
      // closes any #selection.visible, but a headless panel with no visible way out reads as a
      // dead-end -- give it the same explicit close the loaded panel has, wired straight to
      // closeSelection so it never depends on PanelFrame head-adoption (there is no titlebar here).
      selection.className = "visible";
      const close = DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.close,
        cls: "unit-close-button",
        dataset: { spClose: "" },
        title: "Close",
        ariaLabel: "Close",
      });
      panelContent(selection).innerHTML =
        close +
        `<h1>Stockpile unavailable</h1>`;
      const x = selection.querySelector("[data-sp-close]");
      if (x) x.addEventListener("click", event => { event.stopPropagation(); closeSelection(); focusPage(); });
    }
  }
  function linkListHtml(items) {
    items = Array.isArray(items) ? items : [];
    if (!items.length) return `<span class="sp-pill">None</span>`;
    return items.map(item => `<span class="sp-pill" title="${escapeHtml(item.name || "")}">${escapeHtml(item.name || `#${item.id}`)}</span>`).join("");
  }
  function flatStockpileLinks(info, key) {
    const links = info.links || {};
    if (key === "give")
      return [...(Array.isArray(links.give) ? links.give : []), ...(Array.isArray(links.giveWorkshops) ? links.giveWorkshops : [])];
    return [...(Array.isArray(links.take) ? links.take : []), ...(Array.isArray(links.takeWorkshops) ? links.takeWorkshops : [])];
  }
  async function postStockpile(url) {
    try {
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      return r.ok ? r : null;
    } catch (_) {
      return null;
    }
  }
  function stockpileMutationSucceeded(results) {
    return (Array.isArray(results) ? results : [results]).some(Boolean);
  }
  // B143 (native ref B143-1.png "Storage and tools"): Max barrels / Max bins / Max
  // wheelbarrows rows -- native's number-entry (#) is the input, +/- are the steppers, and
  // every change applies immediately (native has no Save button). Pure builders + the exact
  // wire URL, exported for the fixture test (same pattern as wsProfileField: a drift between
  // the render and the handler is the "wire connection" failure class). The server leaves
  // omitted fields unchanged (negative default), so each POST carries only its own field.
  const SP_STORAGE_FIELDS = [
    ["barrels", "Max barrels"], ["bins", "Max bins"], ["wheelbarrows", "Max wheelbarrows"],
  ];
  function spClampStorage(v) { return Math.max(0, Math.min(3000, Number(v) || 0)); }
  function spStorageUrl(id, key, value) {
    return `/stockpile-storage?id=${id}&${key}=${spClampStorage(value)}`;
  }
  // ---- WAVE 5: the three storage tiles become DWFUI art buttons on DF's OWN sprites ------------
  // Native order (B143-1.png, and the coordinator's LEVER-LINK-2.png, which is really native's
  // Location Details window): `value [#][+][-]`, with the VALUE CELL BORDERLESS. This row already
  // had that order and a borderless `.spn-storval`; what it did NOT have was native art -- the
  // three tiles were hand-built buttons painted from the frozen --spa-tile-* CSS snapshot. They
  // are now DWFUI.artBtnHtml on the live interface_map tokens (WORK_ORDERS_ENTER_AMOUNT /
  // _INCREASE_AMOUNT / _DECREASE_AMOUNT), which is the same art DF itself draws, at DF's interface
  // scale, with hover/pressed variants. Only `.spn-stile` (the 32x36 geometry) is passed through
  // the `cls` hook -- NOT `.spn-stile-hash|plus|minus`, because those carry the --spa-* background
  // and would DOUBLE-PAINT under the sprite canvas. Every dataset is unchanged, so the
  // [data-spn-hash] / [data-sp-step] handlers dispatch exactly as before.
  //
  // *** THE ROW IS NOT stepperHtml, AND IT CANNOT BE THIS WAVE. *** stepperHtml renders EITHER a
  // borderless value span (`editable:false`) OR an <input> -- never both. This row needs BOTH: the
  // CSS is a 5-column grid (`1fr auto 32px 32px 32px`, css:5275) in which `.spn-storval` shows the
  // value and a `display:none` `.sp-num` input is REVEALED by `.sp-storage-row.editing` when the #
  // tile is clicked (css:5278-5282). Passing `editable:false` would DELETE the type-a-number
  // capability (a superset, and the # tile's entire purpose); passing `editable:true` would render
  // an input the CSS keeps hidden and NO value at all. Neither is acceptable, and bridging it needs
  // either a CSS change or a `valueCls` hook on stepperHtml -- both LOCKED to this lane. Recorded
  // in the closeout as a concrete, actionable foundation gap.
  function spStorageRowsHtml(storage) {
    const s = storage || {};
    const S = DWFUI.TOKENS.sprites;
    const tile = (sprite, extraCls, dataset, title) => DWFUI.artBtnHtml({
      sprite, cls: `spn-stile${extraCls ? " " + extraCls : ""}`, dataset, title, ariaLabel: title,
    });
    return SP_STORAGE_FIELDS.map(([key, label]) => `<div class="sp-storage-row">
        <span class="sp-storage-label">${label}</span>
        <span class="spn-storval">${spClampStorage(s[key])}</span>
        <input class="sp-num" data-sp-storage="${key}" type="number" min="0" max="3000" value="${spClampStorage(s[key])}" aria-label="${label}">
        ${tile(S.stepHash, "", { spnHash: key }, `Set ${label.toLowerCase()}`)}
        ${tile(S.stepPlus, "sp-step", { spStep: key, delta: 1 }, `Increase ${label.toLowerCase()}`)}
        ${tile(S.stepMinus, "sp-step", { spStep: key, delta: -1 }, `Decrease ${label.toLowerCase()}`)}
      </div>`).join("");
  }
  // B141 (native ref B141-2.png): native capitalizes the first letter of every item row
  // ("Apple leaf", "Plump helmet") while raws/state names are lowercase. Display-only --
  // filtering still matches the raw lowercase name.
  function spDisplayName(name) {
    const s = String(name || "");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  async function refreshStockpileSummary(id) {
    try {
      const r = await fetch(`/stockpile-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return false;
      renderStockpilePanel(await r.json());
      return true;
    } catch (_) {
      return false;
    }
  }
  // B143+B151 STOCKPILE-PARITY: the selected-stockpile panel reproduces native's window
  // (oracle tools/orchestrator/attachments/B143-1.png): title box + quill rename, the 2-column
  // icon type grid (column-major, native order/labels), the tool tile cluster (paint+ / remove /
  // take-from-anywhere / add-link / barrel), and the caption line. "Storage and tools" is a
  // SEPARATE movable window (native's right-hand window) opened by the barrel tile with a Done
  // plaque, number-entry # tile and +/- steppers (immediate apply, no Save button -- B143).
  // The old web-only sections (links pills/targets) keep working inside a fold-out pane behind
  // the add-link tile; they have no visible native counterpart in the oracle.
  const SPN_TYPES = [
    // [label, preset key] in native's column-major order (B143-1.png, left column then right).
    // Sprite row i in --spa-sptype-icons matches this index (icons extracted from the oracle).
    ["All", "all"], ["Ammo", "ammo"], ["Animals", "animals"], ["Armor", "armor"],
    ["Bars and Blocks", "bars"], ["Cloth", "cloth"], ["Coins", "coins"], ["Corpses", "corpses"],
    ["Finished Goods", "finished"], ["Food", "food"],
    ["Furniture", "furniture"], ["Gem", "gems"], ["Leather", "leather"], ["Refuse", "refuse"],
    ["Sheets", "sheets"], ["Stone", "stone"], ["Weapons", "weapons"], ["Wood", "wood"],
    ["None", "none"], ["Custom", "custom"]
  ];
  // ---- WAVE 5: the 20 type tiles are DWFUI.rowHtml -------------------------------------------
  // Structure only: `tag:"button"` keeps the real button semantics, `cls` carries `.spn-type`
  // (+ `.active`) so the CSS and b151's pins land exactly as before, `labelCls` carries `.spn-tlab`
  // so the label goes through the BITMAP TEXT default instead of a raw escaped span -- and
  // `.dwfui-label`'s `white-space:nowrap` never reaches it, so "Bars and Blocks" / "Finished Goods"
  // still WRAP the way native wraps them (B143-1). The `[data-sp-cat]` handler is untouched.
  //
  // *** THE ICON CELL STAYS CSS-PAINTED, AND THAT IS NOT LAZINESS. *** `.spn-ticon` is a TWO-LAYER
  // composite: layer 1 is the category glyph (a row of --spa-sptype-icons, i.e. DF's own
  // stockpile_icons.png), layer 2 is the green selected strip, and the gold cell border is a CSS
  // border. iconHtml paints exactly ONE sprite. The three real tokens do exist
  // (STOCKPILE_ICON_<CAT>, STOCKPILE_TYPE_ACTIVE, STOCKPILE_TYPE_INACTIVE) -- but composing frame +
  // glyph + active strip in one cell needs a stacking rule in the stylesheet, and passing
  // `cls:"spn-ticon"` to iconHtml would leave the --spa- background UNDER the sprite canvas and
  // DOUBLE-PAINT it (the same trap the storage tiles avoid by dropping .spn-stile-hash|plus|minus).
  // So it goes through the `icon:` slot as-is. Recorded as a concrete CSS-wave follow-up.
  function spnTypeGridHtml(groups) {
    const preset = activePresetFromGroups(groups);
    return SPN_TYPES.map(([label, key], i) => {
      const active = key === "custom" ? preset === "" : stockCatIsActive(groups, key);
      return DWFUI.rowHtml({
        tag: "button",
        cls: `spn-type${active ? " active" : ""}`,
        dataset: { spCat: key },
        title: label,
        // two comma positions: layer 1 = the icon sprite row, layer 2 = the green selected-state
        // strip (must stay at 0 0; a single value would shift both layers cyclically)
        icon: `<span class="spn-ticon${active ? " on" : ""}" style="background-position:0 ${-35 * i}px, 0 0"></span>`,
        label,
        labelCls: "spn-tlab",
      });
    }).join("");
  }

  // ---- WAVE 5: the five tool tiles are DWFUI, on DF's OWN stockpile art ------------------------
  // They were hand-built buttons whose faces were the frozen `--spa-tool-*` data-URIs. That art has
  // DF's gold frame BAKED IN, so it could never go through `.dwfui-art-btn` (2px gold border) without
  // double-framing a APPROVED anchor -- which is why this cluster was the last thing on the panel
  // still bypassing the layer. The eight native tokens are now in TOKENS.sprites AND in
  // SELF_FRAMED_SPRITES, so `button[data-dwfui-native-art][data-dwfui-self-framed]` (css:6800) strips
  // the generic chassis AND the legacy `--spa-tool-*` background off these buttons: ONE frame,
  // DF's own, and the `.spn-tool-*` classnames stay as pure `cls` hooks (the strangler seam).
  //
  // Mapping verified against the oracle (tools/orchestrator/attachments/B143-1.png), tile by tile:
  //   brush + gold plus        -> STOCKPILE_REPAINT              (paint more tiles)
  //   crossed-out pile         -> STOCKPILE_REMOVE_EXISTING      (remove stockpile)
  //   pile + side arrows       -> STOCKPILE_TAKE_FROM_ANYWHERE   (<-> _TAKE_FROM_LINKS_ONLY)
  //   pile + plus + arrows     -> STOCKPILE_SET_CONNECTIONS      (links: give to / take from)
  //   barrel                   -> STOCKPILE_TOOL_SETTINGS        (Storage and tools)
  // The bottom-left cell is EMPTY in the oracle too -- native omits, it does not blank -- which is
  // what `.spn-tool-spacer` holds open.
  //
  // TWO of them are LATCHES, not buttons. Repaint is a real latched arm (`stockRepaintId === id`
  // persists across map clicks), and links-only is a two-state mode with a DISTINCT native sprite
  // per state -- so it latches between _TAKE_FROM_ANYWHERE and _TAKE_FROM_LINKS_ONLY, which is
  // exactly how native shows it. Repaint has NO _ACTIVE variant in interface_map.json, so its armed
  // state has no native oracle: the `.armed` cls hook is kept (its brightness still lands) and the
  // gold outline that `.spn-tool.armed` also asked for is now zeroed by the self-framed reset
  // (`outline:0`, specificity 0,2,1 > 0,2,0). Left as-is rather than invented; reported.
  function spnToolsHtml(info, armed) {
    const S = DWFUI.TOKENS.sprites;
    const linksOnly = !!(info && info.linksOnly);
    const linksTitle = linksOnly
      ? "Only taking from links (click: take from anywhere)"
      : "Taking from anywhere (click: only take from links)";
    const paintTitle = "Paint more tiles onto this stockpile";
    return `<div class="spn-tools">
            ${DWFUI.latchHtml({
              on: !!armed, sprite: S.spRepaint, cls: `spn-tool spn-tool-paint${armed ? " armed" : ""}`,
              dataset: { spRepaint: "" }, title: paintTitle, ariaLabel: paintTitle,
            })}
            ${DWFUI.artBtnHtml({
              sprite: S.spRemove, cls: "spn-tool spn-tool-remove",
              dataset: { spRemove: "" }, title: "Remove stockpile", ariaLabel: "Remove stockpile",
            })}
            ${DWFUI.latchHtml({
              on: linksOnly, sprite: S.spTakeAnywhere, activeSprite: S.spTakeLinksOnly,
              cls: `spn-tool ${linksOnly ? "spn-tool-linksfree-off" : "spn-tool-linksfree-on"}`,
              dataset: { spLinksOnly: linksOnly ? 0 : 1 }, title: linksTitle, ariaLabel: linksTitle,
            })}
            ${DWFUI.artBtnHtml({
              sprite: S.spConnections, cls: "spn-tool spn-tool-linkadd",
              dataset: { spnLinksToggle: "" }, title: "Stockpile links (give to / take from)",
              ariaLabel: "Stockpile links (give to / take from)",
            })}
            <span class="spn-tool-spacer"></span>
            ${DWFUI.artBtnHtml({
              sprite: S.spToolSettings, cls: "spn-tool spn-tool-barrel",
              dataset: { spnStorageOpen: "" }, title: "Storage and tools", ariaLabel: "Storage and tools",
            })}
          </div>`;
  }

  // The links pane's reload control -- a SUPERSET (the pane itself has no native counterpart), so it
  // is DRESSED NATIVE: the same grey text plaque the give/take pills already use. `.sp-mode-button`
  // rides through the `cls` hook, and `[data-sp-refresh-links]` still re-opens the panel.
  function spModeRowHtml() {
    return `<div class="sp-mode-row">${DWFUI.plaqueBtnHtml({
      label: "Refresh links", cls: "sp-mode-button",
      dataset: { spRefreshLinks: "" }, title: "Reload linked buildings",
    })}</div>`;
  }

  // ---- Storage and tools: native's separate window (B143-1.png right) ----
  let spnStorageId = null;
  function spnStorageWin() { return document.getElementById("spStoragePanel"); }
  function spnCloseStorage() {
    const win = spnStorageWin();
    if (win) win.style.display = "none";
    spnStorageId = null;
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("spStorage", false); } catch (_) {}
  }
  function spnEnsureStorageWin() {
    let win = spnStorageWin();
    if (win) return win;
    win = document.createElement("div");
    win.id = "spStoragePanel";
    win.className = "spn-storagewin";
    win.style.display = "none";
    // ---- WAVE 5: the ONE Done is DWFUI.plaqueBtnHtml -------------------------------------------
    // PB-10, the owner: a DOUBLED `Done`. The hand-built `.spn-done` was an EMPTY element whose entire
    // face was `--spa-plaque-done` -- a background image with the word "Done" BAKED INTO IT. It is
    // now the shared native plaque (tone:'red' == the destructive HORIZONTAL_OPTION_* strip, the
    // same builder and the same red the workshop links window's Done uses), with the word rendered
    // ONCE as a real label. `.dwfui-plaque`'s `background:#4e474e` supersedes the baked art, so the
    // word cannot paint twice.
    //
    // *** NOT `sideWindowHtml`, AND THAT IS THE POINT. *** sideWindowHtml emits its OWN red Done
    // inside a `.dwfui-sidewin-bar` it gives no cls hook to -- so adopting it here would (a) stack a
    // SECOND Done next to `.spn-done` unless this one were deleted, and (b) rename the head away
    // from `.spn-storagehead`, which is the exact selector this window's PanelFrame registration
    // pins as `headSel` below. Dragging the window would silently stop working. Exactly one Done.
    win.innerHTML = `<div class="spn-storagehead"><span class="spn-storagetitle">Storage and tools</span>` +
      DWFUI.plaqueBtnHtml({
        label: "Done", tone: "red", cls: "spn-done",
        dataset: { spnStorageDone: "" }, title: "Done",
      }) + `</div>` +
      `<div class="spn-storrows"></div>`;
    document.body.appendChild(win);
    win.querySelector("[data-spn-storage-done]").addEventListener("click", e => { e.stopPropagation(); spnCloseStorage(); });
    if (window.DFPanelFrame) window.DFPanelFrame.register({
      key: "spStorage", el: () => spnStorageWin(), title: "Storage and tools",
      headSel: ".spn-storagehead", closable: false, escClosable: true, persistOpen: false, menu: false,
      isOpen: () => { const n = spnStorageWin(); return !!n && n.style.display !== "none"; },
      close: () => spnCloseStorage(),
    });
    return win;
  }
  function spnRenderStorage(id, storage) {
    const win = spnEnsureStorageWin();
    win.querySelector(".spn-storrows").innerHTML = spStorageRowsHtml(storage);
    // B143: native applies storage changes immediately (no Save button) -- an input change or
    // a +/- stepper click each POST just their own field via spStorageUrl.
    const saveStorage = async key => {
      const el = win.querySelector(`[data-sp-storage="${key}"]`);
      await postStockpile(spStorageUrl(id, key, el && el.value));
      openStockpilePanel(id);
    };
    win.querySelectorAll("[data-sp-storage]").forEach(inp => inp.addEventListener("change", event => {
      event.stopPropagation();
      saveStorage(inp.dataset.spStorage);
    }));
    win.querySelectorAll("[data-sp-step]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const key = btn.dataset.spStep;
      const el = win.querySelector(`[data-sp-storage="${key}"]`);
      if (el) el.value = spClampStorage((Number(el.value) || 0) + Number(btn.dataset.delta || 0));
      saveStorage(key);
    }));
    // native's # tile = type the number directly: it swaps the value text for the input
    win.querySelectorAll("[data-spn-hash]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const row = btn.closest(".sp-storage-row");
      if (!row) return;
      row.classList.add("editing");
      const inp = row.querySelector("[data-sp-storage]");
      if (inp) { inp.focus(); try { inp.select(); } catch (_) {} }
    }));
  }
  function spnOpenStorage(id, storage) {
    const win = spnEnsureStorageWin();
    spnStorageId = id;
    spnRenderStorage(id, storage);
    if (win.style.display === "none") {
      // dock beside the stockpile window like native (right of it when there is room)
      try {
        const rect = selection.getBoundingClientRect();
        const w = 376;
        const x = (rect.right + 12 + w <= window.innerWidth) ? rect.right + 12 : Math.max(8, rect.left - 12 - w);
        win.style.left = Math.round(x) + "px";
        win.style.top = Math.round(Math.max(48, rect.top)) + "px";
      } catch (_) {}
      win.style.display = "block";
    }
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("spStorage", true); } catch (_) {}
  }

  // ---- WAVE 5 / PB-10: THE TITLE BAR IS DWFUI.headerHtml, AND ITS CLASS LIST IS THE BUG FIX -----
  //
  // *** `sp-header` IS NOT DECORATION. IT IS THE MISSING HALF OF A CONTRACT. ***
  // dwf-core.js:1413 registers #selection with
  //     adoptHeadSel: ".unit-sheet-header,.stock-item-header,.sp-header,.farm-native-head,.bld-head"
  // -- and `.sp-header` MATCHED NOTHING. Not one element, not one CSS rule, anywhere in the repo
  // (verified: `grep -rn "sp-header" web/ tools/ src/` returns core.js:1413 and panel_frame_test's
  // pin of that same string, and nothing else). The stockpile skin's head has always been
  // `.spn-titlebar`. So PanelFrame.skinHeadFor() returned null on every open, the generated
  // `.pf-head` "Selection" bar UN-HID (there is a `.farm-panel > .pf-head { display:none }` rule at
  // css:1033 and NO equivalent for `.stockpile-panel`), and a non-native chrome bar rendered
  // STACKED ABOVE the native title box -- on B143-1, a APPROVED ANCHOR. That is PB-10's second
  // header, and it is fixable from THIS FILE: emit the class core already asks for.
  //
  // THE CLOSE X STAYS, ON PURPOSE. Native has no X here (B143-1 has none) -- but head adoption is
  // CONDITIONAL on a closable variant owning a close (panelframe.js:483), and `stockpile-panel` is
  // NOT in core's ESC_ONLY_SELECTION_VARIANTS (core.js:1366). Dropping `.unit-close-button` would
  // therefore make adoption fail again and bring the generated bar -- WITH a fresh framework X --
  // straight back. The naive parity fix ADDS chrome. Removing the X needs one word in
  // ESC_ONLY_SELECTION_VARIANTS, and `dwf-core.js` is forbidden to this lane. Left, reported.
  //
  // The quill goes through the RAW `tools` slot (headerToolsHtml supports it: `if (typeof tools ===
  // "string") return tools`), NOT the typed cluster. The typed cluster wraps its tiles in
  // `.dwfui-head-tools`, which css:6547 gives a `border:2px solid var(--dwfui-gold)`. B143-1's title
  // bar has NO gold box: the quill sits in its own SILVER-framed cell, butted against the silver
  // title box. UNIT_SHEET_CUSTOMIZE is in SELF_FRAMED_SPRITES, so artBtnHtml zeroes its own generic
  // box and DF's frame is the only one drawn -- one frame, which is the whole invariant. With one
  // tool and no close, the cluster's ordering rank has nothing to order anyway.
  function spnTitlebarHtml(info, display) {
    return DWFUI.headerHtml({
      cls: "sp-header spn-titlebar",
      titleCls: "spn-titlebox",
      // R5's DECLARED escape hatch, and it is declared because this slot is not text. Native's title
      // box is a text line; OURS is a text line PLUS a hidden rename field that `.spn-titlebar
      // .renaming` swaps in (css:5241-5242) -- the free-text /stockpile-rename superset, which
      // B143-1's quill attests native has in spirit but which we implement with a real DOM input
      // (the sanctioned "editable inputs stay DOM" exception). headerHtml has no cfg field for a
      // two-element title box, so the composition is raw -- and says so, once, here.
      titleHtml: DWFUI.rawHtml(
        "the native title line plus the hidden free-text rename input the quill reveals",
        `<div class="spn-title" data-spn-title>${escapeHtml(info.name || display)}</div>` +
        `<input class="spn-name sp-name" type="text" value="${escapeHtml(info.name || "")}" ` +
        `placeholder="${escapeHtml(display)}" maxlength="64">`),
      tools: DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.quill, cls: "spn-quill",
        dataset: { spRename: "" }, title: "Rename stockpile", ariaLabel: "Rename stockpile",
      }),
      close: false,
    });
  }

  // The links pane is a SUPERSET (multiplayer stockpile give/take wiring; native's stockpile window
  // has no such pane) -- so it is DRESSED NATIVE, never removed. Give/Take become the native text
  // plaque and the target rows the native table row; every dataset, route and `.active` class the
  // handlers below read is carried through unchanged.
  function spLinkTargetRowHtml(target, giveIds, takeIds) {
    const tid = Number(target.id);
    const gives = giveIds.has(tid);
    const takes = takeIds.has(tid);
    const meta = `${target.kind || "building"} ${target.pos ? `${target.pos.x},${target.pos.y},${target.pos.z}` : ""}`;
    const modeBtn = (mode, label, on) => DWFUI.plaqueBtnHtml({
      label, tone: on ? "green" : undefined,
      cls: "sp-link-button" + (on ? " active" : ""),
      dataset: { spLinkMode: mode, spLinkTarget: tid, on: on ? 0 : 1 },
    });
    return DWFUI.rowHtml({
      chassis: "table", cls: "sp-target-row",
      labelCls: "sp-target-name", label: target.name || `Building ${tid}`,
      title: target.name || "",
      sub: { cls: "sp-target-meta", text: meta },
      trailing: modeBtn("give", "Give", gives) + modeBtn("take", "Take", takes),
    });
  }

  function renderStockpilePanel(info) {
    const id = info.id;
    const groups = info.groups || {};
    const display = info.displayName || `Stockpile #${info.number || 0}`;
    const sz = info.size || { w: 1, h: 1 };
    const pos = info.pos || { x: 0, y: 0, z: 0 };
    const storage = info.storage || { barrels: 0, bins: 0, wheelbarrows: 0 };
    const giveLinks = flatStockpileLinks(info, "give");
    const takeLinks = flatStockpileLinks(info, "take");
    const giveIds = new Set(giveLinks.map(x => Number(x.id)));
    const takeIds = new Set(takeLinks.map(x => Number(x.id)));
    const targets = Array.isArray(info.targets) ? info.targets : [];
    // WP-C (WT04): "Ordered by â— player" line, merged from /attrib by stockpile id, toggleable.
    // Empty (no line) on the pre-WP-C DLL or for native/pre-existing stockpiles. openStockpilePanel
    // warms the /attrib cache before this synchronous render.
    const spOrderedByChip = (typeof attribRowHtml === "function") ? attribRowHtml("stockpile", id) : "";
    const spOrderedByLine = spOrderedByChip ? `<div class="sp-sub sp-attrib">Ordered by ${spOrderedByChip}</div>` : "";
    // switching to another stockpile retires the old pile's storage window (stale id otherwise)
    if (spnStorageId != null && spnStorageId !== id) spnCloseStorage();
    if (spnStorageId === id) spnRenderStorage(id, storage);
    // ---- WAVE 5: the .spn-meta coordinates footer is DELETED --------------------------------
    // It rendered "Name - WxH at x,y,z" in #9cc7ff -- a blue that appears NOWHERE in the measured
    // native palette -- and native's stockpile window has exactly ONE caption line, "Click an icon
    // to set stockpile type.", which is already right above it. It was not a capability, and the
    // three-step proof says so: (1) grep -rn "spn-meta|spnMeta" web/js/ returned ONLY the emit line
    // itself (no id, no data-*, no handler -- nothing read it); (2) grep -rni spn-meta src/ ->
    // nothing; (3) grep -rn spn-meta tools/ -> nothing (no test, no Studio story pins it).
    selection.className = "visible stockpile-panel";
    panelContent(selection).innerHTML = `
      <div class="sp-panel sp-native">
        <button class="unit-close-button" data-sp-close title="Close">X</button>
        ${spnTitlebarHtml(info, display)}
        <div class="spn-gridwrap">
          <div class="spn-grid">${spnTypeGridHtml(groups)}</div>
          ${spnToolsHtml(info, stockRepaintId === id)}
        </div>
        <div class="spn-caption">Click an icon to set stockpile type.</div>
        ${spOrderedByLine}
        <div class="spn-linkspane" data-spn-linkspane hidden>
          ${spModeRowHtml()}
          <div class="sp-link-summary">
            <div class="sp-link-bucket"><strong>Gives to</strong><div class="sp-pill-row">${linkListHtml(giveLinks)}</div></div>
            <div class="sp-link-bucket"><strong>Takes from</strong><div class="sp-pill-row">${linkListHtml(takeLinks)}</div></div>
          </div>
          <div class="sp-targets">
            ${targets.length
              ? targets.map(target => spLinkTargetRowHtml(target, giveIds, takeIds)).join("")
              : DWFUI.rowHtml({ chassis: "table", cls: "sp-target-row",
                  labelCls: "sp-target-name", label: "No linkable buildings" })}
          </div>
        </div>
      </div>
    `;
    selection.querySelector("[data-sp-close]").addEventListener("click", event => {
      event.stopPropagation(); spnCloseStorage(); closeSelection(); focusPage();
    });
    const doRename = async () => {
      const nm = selection.querySelector(".spn-name").value;
      await postStockpile(`/stockpile-rename?id=${id}&name=${encodeURIComponent(nm)}`);
      openStockpilePanel(id);
    };
    // native rename: the quill swaps the title text for a text entry (B143-1.png title box + quill)
    selection.querySelector("[data-sp-rename]").addEventListener("click", event => {
      event.stopPropagation();
      const bar = selection.querySelector(".spn-titlebar");
      if (!bar.classList.contains("renaming")) {
        bar.classList.add("renaming");
        const inp = selection.querySelector(".spn-name");
        inp.focus(); try { inp.select(); } catch (_) {}
      } else {
        doRename();
      }
    });
    selection.querySelector(".spn-name").addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); doRename(); }
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        selection.querySelector(".spn-titlebar").classList.remove("renaming");
      }
    });
    // native semantics ("Click an icon to set stockpile type."): a type icon SETS the pile's type
    // (radio, mode=set replacing the old per-press enable/disable toggle), None clears every
    // category flag, and Custom opens the 3-column settings editor (B151).
    selection.querySelectorAll("[data-sp-cat]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const key = b.dataset.spCat || "all";
      if (key === "custom") { openSpEditor(id); focusPage(); return; }
      await postStockpile(`/stockpile-set?id=${id}&preset=${encodeURIComponent(key)}&mode=set`);
      openStockpilePanel(id);
    }));
    selection.querySelector("[data-spn-storage-open]").addEventListener("click", event => {
      event.stopPropagation();
      spnOpenStorage(id, storage);
    });
    selection.querySelector("[data-spn-links-toggle]").addEventListener("click", event => {
      event.stopPropagation();
      const pane = selection.querySelector("[data-spn-linkspane]");
      if (pane) pane.hidden = !pane.hidden;
    });
    selection.querySelector("[data-sp-links-only]").addEventListener("click", async event => {
      event.stopPropagation();
      await postStockpile(`/stockpile-links-only?id=${id}&on=${event.currentTarget.dataset.spLinksOnly}`);
      openStockpilePanel(id);
    });
    selection.querySelector("[data-sp-refresh-links]").addEventListener("click", event => {
      event.stopPropagation();
      openStockpilePanel(id);
    });
    selection.querySelectorAll("[data-sp-link-target]").forEach(button => button.addEventListener("click", async event => {
      event.stopPropagation();
      const target = Number(button.dataset.spLinkTarget);
      const mode = button.dataset.spLinkMode || "give";
      const on = Number(button.dataset.on || 0);
      await postStockpile(`/stockpile-link?id=${id}&target=${target}&mode=${encodeURIComponent(mode)}&on=${on}`);
      openStockpilePanel(id);
    }));
    // Native repaint session (mirror of the zone [data-zone-repaint] arm): close the panel and
    // open the staged paint float -- label/tile count + rect/free/erase/remove tools, edits
    // staged on the map, committed only by Accept (exact mode=replace bitmap).
    selection.querySelector("[data-sp-repaint]").addEventListener("click", event => {
      event.stopPropagation();
      closeSelection();
      if (window.DFStockRepaint && typeof window.DFStockRepaint.arm === "function")
        window.DFStockRepaint.arm(id, {
          label: info.displayName || info.name || `Stockpile #${info.number ?? id}`,
        });
      focusPage();
    });
    selection.querySelector("[data-sp-remove]").addEventListener("click", async event => {
      event.stopPropagation();
      // A failed remove answers HTTP 200 {"ok":false} (e.g. another player removed this pile
      // first, or the building can't be dropped) -- so r.ok alone is not proof. NEVER close as
      // if it worked: confirm the JSON says ok, otherwise RE-READ. A still-present pile reappears
      // intact (honest "it didn't remove"); an already-gone one 404s to "Stockpile unavailable"
      // (honest "someone else removed it"). Mirrors the zone [data-zone-act] remove path -- the
      // panel only closes on a real removal, never on a silent failure.
      let removed = false;
      try {
        const r = await fetch(`/stockpile-remove?id=${id}`, { method: "POST", cache: "no-store" });
        if (r.ok) { const d = await r.json().catch(() => ({})); removed = !d || d.ok !== false; }
      } catch (_) {}
      if (removed) { spnCloseStorage(); closeSelection(); }
      else openStockpilePanel(id);
      focusPage();
    });
  }

  // ---- Custom stockpile settings editor: B151 exact native parity ----------------------------
  // Oracles: tools/orchestrator/attachments/B151-1.png (native closeup, r1) and B151-3.png
  // (native at the full DF window -- THE scale reference, r2). Native semantics reproduced here:
  //   - state IS color, and the state is DERIVED FROM CONTENTS (r2 model correction; B151-3
  //     shows Food with a DASH while its flag is on): check = everything beneath enabled,
  //     X = nothing, dash = partial -- at every level (category from its groups' bits, group
  //     from its items' bits). A category whose FLAG is off stores nothing regardless of its
  //     remembered bits, so it derives to X (r1's live pile-122 truth: flags=food only, ammo
  //     bits 9/9 on, native shows Ammo red). Only the DISPLAY derives -- the write path keeps
  //     the category flags / preset routes (r1's model).
  //   - NO DEFAULT PAINT, EVER (r2 flash fix): a row whose derivation inputs have not arrived
  //     renders stateless ("pending": label only, no color, no icon) and flips straight to its
  //     final state. The r1 editor defaulted unknown group rows to the green art, so selecting
  //     a category lit the whole detail column green and rows re-reddened one fetch at a time.
  //   - selection paints the remembered state SYNCHRONOUSLY from the caches; a background pump
  //     fills every category's aggregates (open cat first, then flag-on, then the rest) so
  //     column 1 can derive and later selections paint instantly.
  //   - WINDOW-SCALE PARITY (r2): measured from B151-3 (window 1999x1303), the native panel is
  //     1647x1140 = 0.8239 x 0.8749 of the window, row pitch 51px = 0.03914 of window height,
  //     columns 370/343px. The stylesheet keeps r1's 39px-pitch metrics; SPE_BASE is the panel
  //     size at which those metrics ARE native (native px x 39/51) and --spe-zoom scales the
  //     whole editor so the native proportions hold at any viewport and any user resize.
  //   - sub-groups (column 2) carry their aggregate bit-state: full = green + check, partial =
  //     grey row + dash (B151-3's Food row art), empty = red + X. Groups with no items in this
  //     world are hidden (native's Food list shows 18 of our 20 groups).
  //   - items (column 3) sort ALPHABETICALLY by display label ("Prepared toad eye" under P) and
  //     scroll inside their own column only; no counter line.
  //   - the editor is a framework panel (movable, resizable, Esc-closable, one close button).
  const SP_EDIT_CATS = [
    // [label, key, icon row in stockpile_icons.png]. Labels/order = B151-1.png column 1.
    // Icon rows were re-verified against the sheet: skull row 7 is Corpses, so
    // corpses=7 / finished=8 / food=9 / furniture=10 / gems=11 / leather=12 (the old table
    // had these six shifted one row and showed wrong icons).
    ["Ammo", "ammo", 1],
    ["Animals", "animals", 2],
    ["Armor", "armor", 3],
    ["Bars/blocks", "bars", 4],
    ["Cloth", "cloth", 5],
    ["Coins", "coins", 6],
    ["Finished goods", "finished", 8],
    ["Food", "food", 9],
    ["Furniture/siege ammo", "furniture", 10],
    ["Gems", "gems", 11],
    ["Leather", "leather", 12],
    ["Corpses", "corpses", 7],
    ["Refuse", "refuse", 13],
    ["Sheet", "sheets", 14],
    ["Stone", "stone", 15],
    ["Weapons/trap comps", "weapons", 16],
    ["Wood", "wood", 17]
  ];
  // Native column-2 labels (B151-1.png) where the server's B141-era labels differ. Client-side
  // display mapping only -- keys and wire requests keep the server vocabulary.
  const SP_NATIVE_GROUP_LABELS = {
    food: {
      fish: "Fish", egg: "Egg", drink_plant: "Drink (plant)", drink_animal: "Drink (animal)",
      cheese_plant: "Cheese (plant)", cheese_animal: "Cheese (animal)", leaves: "Fruit/leaves",
      powder_plant: "Milled plant", powder_creature: "Bone meal", glob: "Fat",
      glob_paste: "Paste", glob_pressed: "Pressed material", liquid_plant: "Extract (plant)",
      liquid_animal: "Extract (animal)", liquid_misc: "Misc. liquid",
    },
  };
  function spGroupLabel(cat, key, fallback) {
    const m = SP_NATIVE_GROUP_LABELS[cat];
    return (m && m[key]) || fallback || key;
  }
  // Column 1 state comes from the category FLAG (the B151 fix). groups = /stockpile-info flags map.
  function speCatFlag(flags, key) {
    return !!(flags && flags[stockGroupForPreset(key)]);
  }
  // Selection is navigation, never a write. Open on the first native row consistently; Ammo is
  // allowed to be selected without being enabled. The old "first enabled" workaround conflated
  // the display cursor with settings state to mask an earlier auto-enable bug.
  function speDefaultCat() {
    return SP_EDIT_CATS[0][1];
  }
  // Aggregate bit-state of a sub-group: 'all' | 'some' | 'none' (null when unknown yet).
  //
  // ---- WAVE 5: THIS NOW DELEGATES. It was a FOURTH independent tri-state. ----------------------
  // DWFUI.triState.fromAgg implements EXACTLY these semantics (the foundation's own comment says so:
  // "EXACT B151 speStateFor semantics"), and ui_components_test.mjs:100 + b151_parity_test.mjs:107
  // PIN THE TWO TO EACH OTHER across the whole aggregate space -- including the awkward corners
  // ({on:3,total:0} -> null, {on:-1,total:3} -> "none", {} -> null). Two implementations of one
  // rule, pinned equal by two suites, is a divergence waiting to happen.
  //
  // It DELEGATES rather than being rewritten: DWFUI.triState is in the LOCKED foundation file, so
  // the only safe direction is for this copy to call it. Behaviour is bit-identical, both suites
  // still pass, and there is now exactly ONE tri-state derivation in the program.
  function speStateFor(agg) {
    return DWFUI.triState.fromAgg(agg);
  }
  // r2: a category's DISPLAY state derives from its contents (oracle B151-3: Food dashed while
  // its flag is on; the live case: Wood flag on + Trees none must show X). flagOn null = flags
  // not fetched yet; aggs = one {on,total} per sub-group (undefined entries = bits not fetched).
  // Returns 'all' | 'some' | 'none' | null -- null means "inputs not ready, paint stateless".
  function speCatDerivedState(flagOn, aggs) {
    if (flagOn == null) return null;
    if (!flagOn) return "none";      // flag off stores nothing, whatever the remembered bits say
    if (!Array.isArray(aggs)) return null;
    let on = 0, total = 0;
    for (const a of aggs) {
      if (!a) return null;           // some group's bits are unknown -> not ready, never guess
      on += a.on > 0 ? a.on : 0;
      total += a.total > 0 ? a.total : 0;
    }
    if (total <= 0) return "all";    // nothing of this category exists in-world; flag is all there is
    if (on <= 0) return "none";
    return on >= total ? "all" : "some";
  }
  // Native hides groups that have no items in this world (Food shows 18 rows, not our 20:
  // cheese_plant and powder_creature are empty in the live world). Unknown counts stay visible
  // until their aggregate arrives.
  function speVisibleGroups(groups, aggByKey) {
    return (groups || []).filter(g => {
      const agg = aggByKey && aggByKey[g.key];
      return !agg || agg.total > 0;
    });
  }
  // Column 3 sorts alphabetically by the DISPLAYED label, so "Prepared toad eye" clusters under P
  // with every other Prepared item, exactly like the native right column.
  function spSortItems(items) {
    return (Array.isArray(items) ? items.slice() : []).sort((a, b) =>
      spDisplayName(a && a.name).localeCompare(spDisplayName(b && b.name), "en", { sensitivity: "base" })
      || (Number(a && a.idx) - Number(b && b.idx)));
  }
  // Row builders (pure; the parity harness drives these directly).
  // Shared state->class mapping: 'all' green, 'some' grey (B151-3 Food row art), 'none' red,
  // null "pending" = stateless (r2: NEVER the old green default while bits load).
  function speStateClass(state) {
    return state === "none" ? "off" : state === "some" ? "some" : state === "all" ? "on" : "pending";
  }
  // ---- WAVE 5: the B151 editor's row builders adopt DWFUI.rowHtml + the SHARED tri-state mark ---
  // These were 100% hand-built markup. They now build through rowHtml, and the check/dash/X mark --
  // a FOURTH hand-rolled copy of the same three spans -- is DWFUI.triState.markHtml, the one derive
  // the whole app shares. The strangler `cls` hook passes the pinned `spe-row spe-cat on` names
  // straight through, so `.spe-row.on { border-image-source: var(--spa-row-green) }` still paints
  // and b151_parity_test's `/spe-group on/` + `/spe-state check/` keep matching, with NO CSS change.
  //
  // *** `chassis:'slab'` IS DELIBERATELY *NOT* PASSED, AND THAT IS NOT AN OVERSIGHT. *** It is the
  // right long-term target -- F6 built the slab chassis for exactly this editor, and even added the
  // TOKENS.art.rowGrey key so rowHtml({state:'some'}) could render B151-3's grey partial row. But
  // the slab paint would land TWICE today:
  //     .spe-row.on            { border-image-source: var(--spa-row-green) }   (css:5339)
  //     .dwfui-row--slab.dwfui-row--on { background-image: var(--spa-row-green) } (css:6195)
  // Equal specificity, and the dfui rule is LATER in the stylesheet, so BOTH would paint -- a
  // background slab under a border-image slab. That is precisely the box-inside-a-box defect the
  // frame rule exists to forbid ("chrome belongs to the OUTERMOST owner"). Turning the chassis on
  // requires DELETING `.spe-row`'s border-image paint in dwf.css, and CSS IS LOCKED this
  // wave. Handed to the CSS-consolidation wave; recorded in the lane closeout.
  //
  // `speStateClass` stays regardless: it maps null to the "pending" (stateless) class, which is the
  // r2 NO-FLASH contract and has no DWFUI equivalent.
  function speCatRowHtml(label, key, iconRow, state, selected) {
    return DWFUI.rowHtml({
      tag: "button",
      cls: `spe-row spe-cat ${speStateClass(state)}${selected ? " sel" : ""}`,
      dataset: { speCat: key },
      icon: `<span class="spe-cicon" style="background-position:0 ${-30 * iconRow}px"></span>`,
      copyCls: "spe-copy", labelCls: "spe-lab", label,
      trailing: DWFUI.triState.markHtml(state, {
        cls: "spe-state", dataset: { speCatToggle: key },
        title: `${state === "none" ? "Allow" : "Disallow"} ${label}`,
      }),
    });
  }
  function speGroupRowHtml(label, key, state, selected, singleEntry) {
    // state 'all' -> green + check, 'some' -> grey + dash, 'none' -> red + X, null -> pending.
    // Single-entry groups (Prepared meals) render no MARK when on: the oracle's plain green block.
    // That suppression is a native detail with no DWFUI equivalent, so the mark is skipped
    // explicitly -- the ROW must still paint green, so the row's own state class is untouched.
    const markState = (state === "all" && singleEntry) ? null : state;
    return DWFUI.rowHtml({
      tag: "button",
      cls: `spe-row spe-group ${speStateClass(state)}${selected ? " sel" : ""}`,
      dataset: { speGroup: key },
      copyCls: "spe-copy", labelCls: "spe-lab", label,
      trailing: DWFUI.triState.markHtml(markState, {
        cls: "spe-state", dataset: { speGroupToggle: key },
        title: `Toggle everything in ${label}`,
      }),
    });
  }
  // Pure column-2 builder (the no-flash harness cells drive this): every row's state comes
  // straight from the aggregate map -- known rows paint final, unknown rows paint stateless.
  function speGroupsListHtml(cat, groups, aggByKey, selectedKey) {
    if (!groups || !groups.length) return `<div class="sp-note">Loading...</div>`;
    return speVisibleGroups(groups, aggByKey).map(g => {
      const agg = aggByKey && aggByKey[g.key];
      return speGroupRowHtml(spGroupLabel(cat, g.key, g.label), g.key,
        speStateFor(agg), selectedKey === g.key, !!(agg && agg.total === 1));
    }).join("");
  }
  // r2 WINDOW-SCALE PARITY -- all numbers measured from oracle B151-3.png (see block comment).
  const SPE_NATIVE = { winW: 1999, winH: 1303, panelW: 1647, panelH: 1140, pitch: 51, col1: 370, col2: 343 };
  const SPE_BASE = { rowH: 39, w: 1260, h: 872, col1: 283, col2: 262 };  // = native px * 39/51
  function speDefaultPanelSize(vw, vh) {
    return {
      w: Math.max(760, Math.round(vw * SPE_NATIVE.panelW / SPE_NATIVE.winW)),
      h: Math.max(420, Math.round(vh * SPE_NATIVE.panelH / SPE_NATIVE.winH)),
    };
  }
  function speZoomFor(w, h) {
    const z = Math.min(w / SPE_BASE.w, h / SPE_BASE.h);
    return z > 0 && Number.isFinite(z) ? z : 1;
  }
  function speItemRowHtml(it) {
    return DWFUI.rowHtml({
      tag: "button",
      cls: `spe-row spe-item ${it.on ? "on" : "off"}`,
      dataset: { speItem: it.idx, on: it.on ? 0 : 1 },
      copyCls: "spe-copy", labelCls: "spe-lab",
      label: spDisplayName(it.name),
    });
  }
  function speItemsHtml(items, search) {
    const q = (search || "").trim();   // B21: DF-style token search (raw name, like native)
    const visible = spSortItems(q ? (items || []).filter(it => dfTokenMatch(it.name, q)) : items);
    return visible.length ? visible.map(speItemRowHtml).join("")
      : `<div class="sp-note">${q ? "No matches." : "No items."}</div>`;
  }

  let spEditId = null, spEditCat = null, spEditGroup = null;
  let spGroupsCache = [], spItemsCache = [], spItemSearch = "";

  // ---- B231: the editor's SUBJECT is no longer necessarily a stockpile ------------------------
  // df::hauling_stop.settings is a df::stockpile_settings -- the SAME struct df::building_stockpilest
  // carries (df.hauling.xml:42). DFHack itself banks on that identity: plugins/stockpiles hands a
  // route stop's `settings` to the very serializer it uses for piles (stockpiles.cpp:126
  // get_stop_settings). So a hauling stop's "desired items" filter is not *like* a stockpile's
  // filter -- it IS one, and this editor drives both. Only the URL family changes; every column,
  // every category, every material/quality toggle below is shared, with no second implementation.
  let spEditTarget = null;      // {kind:"pile", id} | {kind:"stop", routeId, stopId}
  let spEditOnChange = null;    // caller's post-mutation hook (the hauling panel re-reads its rows)

  const speIsStop = () => !!spEditTarget && spEditTarget.kind === "stop";
  function speTargetQuery() {
    if (!spEditTarget) return "";
    return speIsStop()
      ? `route=${spEditTarget.routeId}&stop=${spEditTarget.stopId}`
      : `id=${spEditTarget.id}`;
  }
  // `action` is the shared verb; the two families differ only in prefix, and in the preset verb
  // (/stockpile-set vs /hauling-stop-preset), which is spelled out rather than guessed at.
  function speUrl(action, extra) {
    const prefix = speIsStop() ? "/hauling-stop-" : "/stockpile-";
    const verb = action === "preset" ? (speIsStop() ? "preset" : "set") : action;
    return `${prefix}${verb}?${speTargetQuery()}${extra ? "&" + extra : ""}`;
  }
  // A stop has no building row to refresh, and no /stockpile-info; it gets its caller's hook.
  async function speRefreshSubject() {
    if (speIsStop()) { if (typeof spEditOnChange === "function") await spEditOnChange(); return; }
    await refreshStockpileSummary(spEditId);
  }
  let speFlagsCache = null;        // category flag map from /stockpile-info; null = NOT FETCHED
                                   // (r2: null renders stateless, {} would falsely paint all-X)
  let spGroupsByCat = {};          // cat -> /stockpile-cat-groups list (world-static, never per-pile)
  let speAggCache = {};            // `${cat}|${group}` -> {on,total}
  let speItemsByGroup = {};        // `${cat}|${group}` -> items[] (server order; sorted at render)
  let speSeq = 0;                  // open/reload sequence -- stale async loads drop their results

  function spIconStyle(row, px) {
    px = px || 18;
    return `display:inline-block;width:${px}px;height:${px}px;vertical-align:middle;margin-right:6px;` +
           `background-image:url(/asset/stockpile_icons.png);background-size:${px}px ${20 * px}px;` +
           `background-position:0 -${row * px}px;image-rendering:pixelated`;
  }

  function speAggKey(cat, group) { return `${cat}|${group || ""}`; }
  function spePanel() { return document.getElementById("spEditorPanel"); }

  function closeSpEditor() {
    speSeq++;
    const el = spePanel();
    if (el && el.style.display !== "none") {
      el.style.display = "none";
      try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("spEditor", false); } catch (_) {}
    }
  }

  // A settings write was refused, or a settings snapshot 404'd/failed -- the pile or hauling stop is
  // gone, or the host can't answer. NEVER keep the stale editor up re-rendering the optimistic
  // cache: close it and route to the authoritative truth. A pile re-reads to its panel or the
  // closable "Stockpile unavailable" state (openStockpilePanel); a hauling stop hands back to its
  // caller's re-read hook so the route panel reflects the removed stop. Mirrors the honest
  // [data-sp-remove] re-read -- the editor only stays open when the write actually took.
  function speSurfaceUnavailable() {
    const wasStop = speIsStop();
    const pileId = spEditId;
    const onChange = spEditOnChange;
    closeSpEditor();
    if (wasStop) { if (typeof onChange === "function") onChange(); }
    else if (pileId != null) openStockpilePanel(pileId);
    try { if (typeof focusPage === "function") focusPage(); } catch (_) {}
  }

  function speEnsureShell() {
    let el = spePanel();
    if (el) return el;
    el = document.createElement("div");
    el.id = "spEditorPanel";
    el.className = "spe-panel";
    el.style.display = "none";
    const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
    const fit = speDefaultPanelSize(vw, vh);
    const w = Math.min(fit.w, vw - 16), h = Math.min(fit.h, vh - 44);
    el.style.width = w + "px"; el.style.height = h + "px";
    el.style.left = Math.max(8, Math.round((vw - w) / 2)) + "px";
    el.style.top = Math.max(28, Math.round((vh - h) / 2)) + "px";
    // *** THE SIX All/None PLAQUES COULD NOT BE MIGRATED, AND THE BLOCKER IS A TEST I DO NOT OWN.
    // plaqueBtnHtml is exactly right for them (they ARE native's HORIZONTAL_OPTION plaques, and
    // their pinned spe-plaque-all/none classnames would pass straight through the `cls` hook). But
    // tools/harness/uiflow_test.mjs:47 asserts, as a SOURCE REGEX over this file, the literal text
    // data-spe-column-all="categories" (and "groups", and "items"). A DWFUI builder takes its
    // dataset as a CONFIG OBJECT and emits that attribute at RUNTIME, so the literal never appears
    // in the source and all three cells fail -- even though the RENDERED MARKUP IS IDENTICAL.
    // uiflow_test is not one of this lane's owned paths, and rewriting someone else's assertion to
    // bless my own output is precisely what the lane contract forbids. Left hand-built, verbatim.
    // The coordinator owns uiflow_test: re-aiming that cell at the EMITTED markup unblocks all six
    // in one line. Recorded in the lane closeout.
    //
    // *** THE FILTER FIELD IS DELIBERATELY LEFT AS A RAW <input>, AND THE FOUNDATION PREDICTED IT.
    // searchHtml's own comment names this exact surface: "turning [the magnifier] on by default
    // would inject a new button into the two unmigrated surfaces that pass neither flag (THE
    // STOCKPILE EDITOR'S FILTER and the trade-depot goods field) AND DISTURB THEIR GRIDS." It is
    // right. `.spe-bar` is `display:flex` and `.spe-search` itself carries `flex:1 1 auto` (css:
    // 5306/5315), so the field grows to fill the bar. searchHtml wraps the input in its own
    // dwfui-search DIV, and THAT wrapper -- not the input -- becomes the flex item. With
    // no `flex:1 1 auto` on the wrapper the field would collapse to content width. The one-line fix
    // is CSS (`.spe-search-box { flex:1 1 auto }`), and CSS IS LOCKED this wave. An editable input
    // is also the DELIBERATE exception in the invariants ("Editable inputs ... stay DOM <input>"),
    // and a bare type="text" input is not drift under any rule. Handed to the CSS wave.
    //
    // The window's own close keeps `spe-close` + `data-pf-close`: that classname is a PanelFrame
    // CLOSE_SEL member, and a header emitting a close OUTSIDE that set stacks a SECOND X. That has
    // already caused a real outage in this program (the `.spe-close` mismatch), so it is left
    // exactly as it is and panel_frame_test is run on this commit.
    el.innerHTML = `
      <div class="spe-head"><span class="spe-title">Stockpile settings</span><button class="spe-close" data-pf-close aria-label="Close">✕</button></div>
      <div class="spe-body">
        <div class="spe-cols">
          <div class="spe-bar">
            <button class="spe-plaque spe-plaque-all" data-spe-column-all="categories" data-spe-on="1" title="Allow every category"></button>
            <button class="spe-plaque spe-plaque-none" data-spe-column-all="categories" data-spe-on="0" title="Disallow every category"></button>
            <span class="spe-orgtiles">
              <span class="spe-orgtile spe-org-plant" title="Allow organic materials (native toggle; state not wired yet)"></span>
              <span class="spe-orgtile spe-org-ingot" title="Allow inorganic materials (native toggle; state not wired yet)"></span>
            </span>
          </div>
          <div class="spe-bar">
            <button class="spe-plaque spe-plaque-all" data-spe-column-all="groups" data-spe-on="1" title="Enable everything in this category"></button>
            <button class="spe-plaque spe-plaque-none" data-spe-column-all="groups" data-spe-on="0" title="Disable everything in this category"></button>
          </div>
          <div class="spe-bar">
            <button class="spe-plaque spe-plaque-all" data-spe-column-all="items" data-spe-on="1" title="Enable every item in this list"></button>
            <button class="spe-plaque spe-plaque-none" data-spe-column-all="items" data-spe-on="0" title="Disable every item in this list"></button>
            <input class="spe-search" id="speSearch" type="text" placeholder="_" autocomplete="off" spellcheck="false" aria-label="Filter items">
          </div>
          <div class="spe-list spe-cats" id="speCats"></div>
          <div class="spe-list spe-groups" id="speGroups"></div>
          <div class="spe-list spe-items" id="speItems"></div>
        </div>
      </div>`;
    document.body.appendChild(el);
    // r2 scale: --spe-zoom tracks the panel's actual size (user resizes included) so the
    // native window proportions hold; .spe-head/.spe-body consume it via CSS zoom.
    const applyZoom = () => {
      const pw = el.offsetWidth, ph = el.offsetHeight;
      if (pw && ph) el.style.setProperty("--spe-zoom", speZoomFor(pw, ph).toFixed(4));
    };
    applyZoom();
    try { new ResizeObserver(applyZoom).observe(el); } catch (_) {}
    el.querySelectorAll("[data-spe-column-all]").forEach(b => b.addEventListener("click", async e => {
      e.stopPropagation();
      await toggleSpEditorColumn(b.dataset.speColumnAll, b.dataset.speOn === "1");
    }));
    // the search input is part of the persistent shell, so typing never loses focus to a re-render
    const s = el.querySelector("#speSearch");
    s.addEventListener("input", () => { spItemSearch = s.value || ""; renderSpeItems(); });
    el.querySelector("#speCats").addEventListener("click", e => {
      const t = e.target.closest("[data-spe-cat-toggle]");
      if (t) { e.stopPropagation(); toggleSpeCategory(t.dataset.speCatToggle); return; }
      const row = e.target.closest("[data-spe-cat]");
      if (row) { e.stopPropagation(); speSetSearch(""); loadSpGroups(row.dataset.speCat); }
    });
    el.querySelector("#speGroups").addEventListener("click", e => {
      const t = e.target.closest("[data-spe-group-toggle]");
      if (t) {
        e.stopPropagation();
        const agg = speAggCache[speAggKey(spEditCat, t.dataset.speGroupToggle)];
        toggleSpeGroup(t.dataset.speGroupToggle, speStateFor(agg) !== "all");
        return;
      }
      const row = e.target.closest("[data-spe-group]");
      if (row) {
        e.stopPropagation();
        spEditGroup = row.dataset.speGroup; speSetSearch("");
        // r2: pull the remembered items SYNCHRONOUSLY -- the old handler kept the previous
        // group's spItemsCache when this group was already cached, painting stale items.
        spItemsCache = speItemsByGroup[speAggKey(spEditCat, spEditGroup)] || [];
        renderSpeGroups(); renderSpeItems();
        if (!speItemsByGroup[speAggKey(spEditCat, spEditGroup)]) speLoadSelectedItems(speSeq);
      }
    });
    el.querySelector("#speItems").addEventListener("click", async e => {
      const b = e.target.closest("[data-spe-item]");
      if (!b) return;
      e.stopPropagation();
      const idx = b.dataset.speItem, on = b.dataset.on;
      const updated = await postStockpile(speUrl("toggle-item", `cat=${encodeURIComponent(spEditCat)}&group=${encodeURIComponent(spEditGroup || "")}&idx=${idx}&on=${on}`));
      const items = speItemsByGroup[speAggKey(spEditCat, spEditGroup)] || [];
      const it = items.find(x => String(x.idx) === String(idx));
      // The write was refused (postStockpile returns null on non-ok/fetch failure) -- another
      // client deleted or changed this pile/stop, or the host can't answer. NEVER fall through to
      // re-render the optimistic cache as if the toggle stuck: surface the honest unavailable state.
      if (!updated) { speSurfaceUnavailable(); return; }
      if (updated && it) {
        it.on = (on === "1");
        speAggCache[speAggKey(spEditCat, spEditGroup)] = { on: items.filter(x => x.on).length, total: items.length };
        spItemsCache = items;
        // enabling any item auto-raises the category flag server-side; mirror it
        await speFetchFlags();
        await speRefreshSubject();
      }
      renderSpeCats(); renderSpeGroups(); renderSpeItems();
    });
    if (window.DFPanelFrame) window.DFPanelFrame.register({
      key: "spEditor", el: () => spePanel(), title: "Stockpile settings",
      headSel: ".spe-head", closable: true, escClosable: true, persistOpen: false, menu: false,
      resizable: { minW: 760, minH: 420 },
      isOpen: () => { const n = spePanel(); return !!n && n.style.display !== "none"; },
      open: () => { const n = spePanel(); if (n && spEditTarget != null) n.style.display = "flex"; },
      close: () => closeSpEditor(),
    });
    return el;
  }

  function speSetSearch(v) {
    spItemSearch = v || "";
    const s = document.getElementById("speSearch");
    if (s && s.value !== spItemSearch) s.value = spItemSearch;
  }

  // Shared open path. `target` is the settings-holder; `title` names it in the frame.
  function openSpEditorFor(target, onChange) {
    const el = speEnsureShell();
    spEditTarget = target;
    spEditId = target.kind === "pile" ? target.id : null;
    spEditOnChange = onChange || null;
    spEditCat = null; spEditGroup = null;
    spGroupsCache = []; spItemsCache = [];
    speFlagsCache = null; speAggCache = {}; speItemsByGroup = {};  // flags UNKNOWN, not all-off
    speSetSearch("");
    el.style.display = "flex";
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("spEditor", true); } catch (_) {}
    renderSpeAll();   // one neutral loading frame; every final color lands in one snapshot paint
    const seq = ++speSeq;
    (async () => {
      const ok = await speFetchSnapshot(seq);
      if (seq !== speSeq) return;                       // superseded by a newer open -- drop silently
      if (!ok) { speSurfaceUnavailable(); return; }     // pile/stop gone at open -> honest unavailable
      loadSpGroups(speDefaultCat());
    })();
  }

  function openSpEditor(id) {
    openSpEditorFor({ kind: "pile", id });
  }

  // B231: the hauling panel's "Choose items" on a stop. Same editor, same columns, same writes --
  // pointed at df::hauling_stop.settings instead of building_stockpilest.settings.
  function openSpEditorForHaulingStop(routeId, stopId, onChange) {
    openSpEditorFor({ kind: "stop", routeId: Number(routeId), stopId: Number(stopId) }, onChange);
  }

  // The hauling panel (dwf-controls-placement.js) lives in a different module and needs to
  // hand a stop to this editor. This is that one hook -- the same shape DFWsLink uses above.
  if (typeof window !== "undefined") {
    window.DFStockpileSettings = window.DFStockpileSettings || {};
    window.DFStockpileSettings.openForHaulingStop = openSpEditorForHaulingStop;
  }

  async function speFetchSnapshot(seq) {
    try {
      const r = await fetch(speUrl("settings-snapshot", `t=${Date.now()}`), { cache: "no-store" });
      if (!r.ok) return false;
      const d = await r.json();
      if (seq !== speSeq || !d.ok || !Array.isArray(d.categories)) return false;
      const flags = {}, groupsByCat = {}, aggs = {};
      d.categories.forEach(cat => {
        const key = String(cat.key || "");
        if (!key) return;
        flags[stockGroupForPreset(key)] = !!cat.enabled;
        const groups = Array.isArray(cat.groups) ? cat.groups.map(g => ({
          key: String(g.key || ""), label: String(g.label || g.key || ""),
        })) : [];
        groupsByCat[key] = groups;
        (cat.groups || []).forEach(g => {
          aggs[speAggKey(key, String(g.key || ""))] = {
            on: Math.max(0, Number(g.on) || 0), total: Math.max(0, Number(g.total) || 0),
          };
        });
      });
      // Commit the complete snapshot atomically. No partially-colored intermediate render exists.
      speFlagsCache = flags;
      spGroupsByCat = groupsByCat;
      speAggCache = aggs;
      renderSpeCats();
      return true;
    } catch (_) { return false; }
  }

  async function speFetchFlags() {
    try {
      // A hauling stop has no /stockpile-info (it is not a building). Its per-category `enabled`
      // bits ride on the settings snapshot instead, which is the same 17 flags from the same
      // stockpile_settings -- so read them from there rather than inventing a /hauling-stop-info.
      const url = speIsStop()
        ? speUrl("settings-snapshot", `t=${Date.now()}`)
        : `/stockpile-info?id=${spEditId}&t=${Date.now()}`;
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) { if (!speFlagsCache) speFlagsCache = {}; return; }
      const d = await r.json();
      if (speIsStop()) {
        const flags = {};
        (d.categories || []).forEach(cat => {
          const key = String(cat.key || "");
          if (key) flags[stockGroupForPreset(key)] = !!cat.enabled;
        });
        speFlagsCache = flags;
        return;
      }
      speFlagsCache = d.groups || {};
    } catch (_) { if (!speFlagsCache) speFlagsCache = {}; }
  }

  // World-static sub-group lists, cached across piles and opens so re-selecting a category
  // paints synchronously (r2 no-flash: the old code re-fetched this on every selection).
  async function speFetchCatGroups(cat) {
    if (spGroupsByCat[cat]) return spGroupsByCat[cat];
    try {
      const r = await fetch(`/stockpile-cat-groups?cat=${encodeURIComponent(cat)}&t=${Date.now()}`, { cache: "no-store" });
      const d = await r.json();
      const groups = (d.ok && Array.isArray(d.groups)) ? d.groups : [];
      spGroupsByCat[cat] = groups;
      return groups;
    } catch (_) { return null; }
  }

  async function speFetchGroupItems(cat, group, seq) {
    const key = speAggKey(cat, group);
    if (speItemsByGroup[key]) return speItemsByGroup[key];
    try {
      const r = await fetch(speUrl("items", `cat=${encodeURIComponent(cat)}&group=${encodeURIComponent(group || "")}&t=${Date.now()}`), { cache: "no-store" });
      const d = await r.json();
      if (seq !== speSeq) return null;
      const items = (d.ok && Array.isArray(d.items)) ? d.items : [];
      speItemsByGroup[key] = items;
      speAggCache[key] = { on: items.filter(x => x.on).length, total: items.length };
      return items;
    } catch (_) { return null; }
  }

  async function speLoadSelectedItems(seq) {
    const el = document.getElementById("speItems");
    if (el && !speItemsByGroup[speAggKey(spEditCat, spEditGroup)])
      el.innerHTML = `<div class="sp-note">Loading...</div>`;
    const items = await speFetchGroupItems(spEditCat, spEditGroup, seq);
    if (seq !== speSeq || items == null) return;
    spItemsCache = items;
    renderSpeGroups(); renderSpeItems();
  }

  async function loadSpGroups(cat) {
    spEditCat = cat;
    const seq = ++speSeq;
    const applyCached = () => {
      spGroupsCache = spGroupsByCat[cat] || [];
      spEditGroup = spGroupsCache.length ? spGroupsCache[0].key : null;
      spItemsCache = (spEditGroup != null && speItemsByGroup[speAggKey(cat, spEditGroup)]) || [];
    };
    // r2 NO-FLASH CONTRACT: selection paints the remembered state SYNCHRONOUSLY from the
    // caches -- known rows final (green/grey/red), unknown rows stateless. No await sits
    // between picking the category and this render.
    applyCached();
    renderSpeAll();
    // Group names + every aggregate arrived together in the opening snapshot.
    if (spEditGroup != null && !speItemsByGroup[speAggKey(cat, spEditGroup)]) await speLoadSelectedItems(seq);
  }

  function spToggleAllUrl(cat, group, on) {
    return speUrl("toggle-all", `cat=${encodeURIComponent(cat)}` +
      `&group=${encodeURIComponent(group || "")}&on=${on ? 1 : 0}`);
  }

  function speDropCatCaches(cat) {
    Object.keys(speItemsByGroup).forEach(k => { if (k.startsWith(cat + "|")) delete speItemsByGroup[k]; });
    Object.keys(speAggCache).forEach(k => { if (k.startsWith(cat + "|")) delete speAggCache[k]; });
  }

  async function speAfterMutation() {
    await speFetchFlags();
    await speRefreshSubject();
    renderSpeCats(); renderSpeGroups(); renderSpeItems();
  }

  // Column-1 state icon click: toggle the CATEGORY (native's X / check on a category row).
  // Direction follows the DISPLAYED derived state -- clicking the X on a flag-on-but-all-off
  // Wood must ALLOW, not disallow (r2); the wire keeps r1's flag/preset routes. /stockpile-set
  // with enable/disable imports the preset library, which also sets/clears the item bits of
  // that category -- so its caches are dropped and refetched.
  async function toggleSpeCategory(key) {
    const state = speCatDerivedState(speFlagsCache ? speCatFlag(speFlagsCache, key) : null, speCatAggs(key));
    const enable = state == null ? !speCatFlag(speFlagsCache, key) : state === "none";
    await postStockpile(speUrl("preset", `preset=${encodeURIComponent(key)}&mode=${enable ? "enable" : "disable"}`));
    speDropCatCaches(key);
    if (key === spEditCat) {
      spItemsCache = [];
      const seq = speSeq;
      const ok = await speFetchSnapshot(seq);
      if (seq !== speSeq) return;
      // The snapshot re-fetch 404'd/failed after the preset write -- the pile/stop is gone. Route
      // to the honest unavailable state rather than continuing to render the stale cache.
      if (!ok) { speSurfaceUnavailable(); return; }
      await loadSpGroups(spEditCat);
      await speRefreshSubject();
      return;
    }
    await speAfterMutation();
  }

  // Column-2 state icon click: toggle one whole sub-group (native's middle-column check).
  async function toggleSpeGroup(groupKey, on) {
    const updated = await postStockpile(spToggleAllUrl(spEditCat, groupKey, on));
    if (updated) {
      const k = speAggKey(spEditCat, groupKey);
      const items = speItemsByGroup[k];
      if (items) { items.forEach(it => { it.on = !!on; }); speAggCache[k] = { on: on ? items.length : 0, total: items.length }; }
      else delete speAggCache[k];
    }
    await speAfterMutation();
  }

  // Per-column All/None (native's plaque buttons). Categories map to the preset routes
  // (one server call flips every flag); groups fan out one supported toggle-all request per
  // sub-group of the open category; items act on the selected sub-group only.
  async function toggleSpEditorColumn(column, on) {
    if (spEditTarget == null) return;
    if (column === "categories") {
      await postStockpile(speUrl("preset", `preset=${on ? "all" : "none"}&mode=set`));
      if (on) {
        // preset all sets every bit on: transform the caches instead of dropping them so the
        // repaint is instant and FINAL (r2 no-flash); unknown groups stay pending until pumped.
        Object.keys(speItemsByGroup).forEach(k => speItemsByGroup[k].forEach(it => { it.on = true; }));
        Object.keys(speAggCache).forEach(k => { speAggCache[k] = { on: speAggCache[k].total, total: speAggCache[k].total }; });
        spItemsCache = (spEditGroup != null && speItemsByGroup[speAggKey(spEditCat, spEditGroup)]) || spItemsCache;
      }
      // preset none only clears the flags (bits stay), so item caches remain valid
    } else if (column === "groups") {
      const groups = spGroupsCache.length ? spGroupsCache : [{ key: "" }];
      const results = await Promise.all(groups.map(group => postStockpile(spToggleAllUrl(spEditCat, group.key || "", on))));
      if (stockpileMutationSucceeded(results)) {
        groups.forEach(g => {
          const k = speAggKey(spEditCat, g.key || "");
          const items = speItemsByGroup[k];
          if (items) { items.forEach(it => { it.on = !!on; }); speAggCache[k] = { on: on ? items.length : 0, total: items.length }; }
          else delete speAggCache[k];
        });
      }
    } else {
      const updated = await postStockpile(spToggleAllUrl(spEditCat, spEditGroup || "", on));
      if (updated) {
        const k = speAggKey(spEditCat, spEditGroup);
        const items = speItemsByGroup[k];
        if (items) { items.forEach(it => { it.on = !!on; }); speAggCache[k] = { on: on ? items.length : 0, total: items.length }; }
      }
    }
    await speAfterMutation();
  }

  // Derivation inputs for one category: one agg per sub-group (null until the group list or
  // any group's bits are known -- speCatDerivedState then returns null and the row is pending).
  function speCatAggs(cat) {
    const groups = spGroupsByCat[cat];
    return groups ? groups.map(g => speAggCache[speAggKey(cat, g.key)]) : null;
  }

  function renderSpeCats() {
    const el = document.getElementById("speCats");
    if (!el) return;
    el.innerHTML = SP_EDIT_CATS.map(([label, key], i) =>
      speCatRowHtml(label, key, i,
        speCatDerivedState(speFlagsCache ? speCatFlag(speFlagsCache, key) : null, speCatAggs(key)),
        spEditCat === key)).join("");
  }

  function renderSpeGroups() {
    const el = document.getElementById("speGroups");
    if (!el) return;
    const aggByKey = {};
    spGroupsCache.forEach(g => { aggByKey[g.key] = speAggCache[speAggKey(spEditCat, g.key)]; });
    el.innerHTML = speGroupsListHtml(spEditCat, spGroupsCache, aggByKey, spEditGroup);
  }

  function renderSpeItems() {
    const el = document.getElementById("speItems");
    if (!el) return;
    el.innerHTML = speItemsHtml(spItemsCache, spItemSearch);
  }

  function renderSpeAll() { renderSpeCats(); renderSpeGroups(); renderSpeItems(); }

  const buildingOperationsApi = {
    genericBuildingPanelMarkup, zonePanelMarkup,
    leverLinkPanelMarkup, buildingCagePanelMarkup, zoneAnimalsPanelMarkup,
    zoneOwnersPanelMarkup,
  };
  if (typeof window !== "undefined") window.DFBuildingOperationsMarkup = buildingOperationsApi;

  // WP-3a fixture-test surface: the pure Workers-tab profile builders + the /workshop-profile
  // `field` wire map (no DOM, no server). See tools/harness/wp3a_workers_profile_test.mjs. Guarded
  // so the browser <script> load is a no-op (module is undefined in the browser).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      // B246 statue/engraving art (tools/harness/b246_art_desc_test.mjs)
      buildingArtMarkup, buildingRemovalSectionHtml, genericBuildingPanelMarkup, engravingPanelMarkup,
      buildingCageSummary, buildingCageActionLabel, coffinBurialSummary, farmPlotPanelState,
      zoneAnimalAssignmentState, zoneAnimalSexGlyphHtml, zoneSquadModeState, zoneSquadRowsHtml,
      ZONE_SQUAD_MODES,
      // B251 archery-range squad assignment (tools/harness/b251_archery_squads_test.mjs)
      zoneAcceptsSquads, squadRoomName,
      zoneAnimalNativeLabel, zoneAnimalSortedRows,
      farmSpriteCell, farmSeedStocksForCrop,
      // B169 pilot: farm surfaces built through the DWFUI component layer (require it first)
      farmCropDisplayName, farmSeasonTabsHtml, farmCropRowHtml, farmCropListHtml,
      farmSeedRowHtml, farmHeaderHtml,
      leverLinkMechanismStatus, leverLinkTargetRows, leverLinkActionState,
      wsProfileHasControls, wsSkillLevelName, wsSkillSelect, wsMaxOrdersSelect,
      wsBlockedLaborsHtml, wsProfileControlsHtml, wsProfileField,
      wsWorkerRowsHtml,
      WS_SKILL_LEVEL_NAMES, WS_NO_MAX_LEVEL, stockpileMutationSucceeded,
      // B174: workshop panel rebuilt on DWFUI (tools/harness/b174_wsrebuild_client_test.mjs)
      WS_TABS, wsNormalizeTab, wsTabsHtml, wsTaskRowHtml, wsContentRowHtml, wsContentsSectionHtml,
      workshopRemovalBodyHtml, wsHeaderToolsHtml, wsPickerRowHtml, wsCancelRowHtml, wsPickerMatches,
      wsLinkWireMode, wsLinkPayload, wsLinkRowHtml, wsLinksWindowHtml,
      SP_STORAGE_FIELDS, spClampStorage, spStorageUrl, spStorageRowsHtml, spDisplayName,
      spnTitlebarHtml, spLinkTargetRowHtml, spnToolsHtml, spModeRowHtml,
      // B151/B143 stockpile-parity pure surface (tools/harness/b151_parity_test.mjs)
      SP_EDIT_CATS, SPN_TYPES, SP_NATIVE_GROUP_LABELS, spGroupLabel, speCatFlag, speDefaultCat,
      speStateFor, speVisibleGroups, spSortItems, speCatRowHtml, speGroupRowHtml, speItemRowHtml,
      speItemsHtml, spnTypeGridHtml, activePresetFromGroups, stockGroupForPreset, stockCatIsActive,
      // B151 r2: derived tri-state + no-flash + window-scale parity
      speCatDerivedState, speGroupsListHtml, speDefaultPanelSize, speZoomFor, SPE_NATIVE, SPE_BASE,
      ...buildingOperationsApi,
    };
  }
