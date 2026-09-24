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

  const FARM_SEASON_NAMES = ["Spring", "Summer", "Autumn", "Winter"];
  const FARM_SEASON_CELLS = Object.freeze([
    Object.freeze({ x: 0, w: 15 }), Object.freeze({ x: 15, w: 15 }),
    Object.freeze({ x: 30, w: 15 }), Object.freeze({ x: 45, w: 14 }),
  ]);
  const FARM_CROP_VISIBLE_ROWS = 7;
  const FARM_CROP_ROW_CELLS = 3;
  const FARM_CROP_SCROLLBAR_CELLS = Object.freeze({ w: 2, h: 21 });
  const FARM_CROP_CONTROL_CELLS = Object.freeze({ w: 4, h: 3, overflowShift: -2 });

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
    let cell;
    if (kind === "fallow" || kind === "plot") {
      cell = plotSprites && (plotSprites.FURROWED_SOIL_1 || plotSprites.FARMPLOT || plotSprites.FARMPLOT_PLANTED);
      // The terrain map can arrive after the panel opens; retain the known furrow sprite until it does.
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

  if (typeof window !== "undefined") window.FARM_SEED_STACK_WIRE_CAP = 200;

  // Aggregate only rows whose visible identity AND action flags agree, so a marked stack never
  // disappears into an unmarked total.
  function farmAggregateSeedStocks(seedStocks) {
    const groups = new Map();
    (Array.isArray(seedStocks) ? seedStocks : []).forEach(seed => {
      const key = [
        String(seed.token || ""), String(seed.name || ""),
        seed.forbidden ? 1 : 0, seed.dump ? 1 : 0, seed.hidden ? 1 : 0,
      ].join("\u001f");
      const group = groups.get(key) || {
        token: String(seed.token || ""), name: String(seed.name || "Seeds"),
        count: 0, stacks: 0, ids: [],
        forbidden: !!seed.forbidden, dump: !!seed.dump, hidden: !!seed.hidden,
      };
      group.count += Math.max(0, Number(seed.count) || 0);
      group.stacks++;
      group.ids.push(Number(seed.id));
      groups.set(key, group);
    });
    return Array.from(groups.values());
  }

  function farmCellMarkup(token, kind, className = "farm-sprite-cell", backingSize = 32) {
    const cell = farmSpriteCell(token, kind);
    if (!cell) return `<span class="${className} farm-sprite-missing" data-df-identity-missing="farm:${encodeURIComponent(kind)}:${encodeURIComponent(token || "unknown")}" aria-hidden="true"></span>`;
    const backing = Math.max(cell.size, Math.round(Number(backingSize) || cell.size));
    return `<canvas class="${className}" width="${backing}" height="${backing}"` +
      ` data-farm-sprite-sheet="${DWFUI.esc(cell.sheet)}" data-farm-sprite-col="${cell.col}"` +
      ` data-farm-sprite-row="${cell.row}" data-farm-sprite-size="${cell.size}" aria-hidden="true"></canvas>`;
  }

  function paintFarmCells(rootNode) {
    if (!rootNode || !rootNode.querySelectorAll || typeof Image === "undefined") return 0;
    const cells = rootNode.querySelectorAll("canvas[data-farm-sprite-sheet]");
    cells.forEach(canvas => {
      const size = Number(canvas.dataset.farmSpriteSize);
      const col = Number(canvas.dataset.farmSpriteCol);
      const row = Number(canvas.dataset.farmSpriteRow);
      if (!(size > 0) || !Number.isFinite(col) || !Number.isFinite(row)) return;
      const image = new Image();
      image.onload = () => {
        const context = canvas.getContext && canvas.getContext("2d");
        if (!context) return;
        context.imageSmoothingEnabled = false;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, -col * size, -row * size);
      };
      image.src = `/sprites/img/${encodeURIComponent(canvas.dataset.farmSpriteSheet)}`;
    });
    return cells.length;
  }

  // ---- farm-plot surfaces ---------------------------------------------------------------------
  function farmCropDisplayName(name) { return DWFUI.sentenceCase(name); }

  function farmSeasonTabsHtml(state) {
    return DWFUI.tabsHtml({
      cls: "farm-season-tabs", tabCls: "farm-season-tab", dataAttr: "farm-season",
      level: "primary", cellGrid: { cols: 59, rows: 2 }, gapCells: 0,
      ariaLabel: "Farm plot season", active: state.activeSeason,
      tabs: state.seasons.map((season, index) => ({
        key: season.season, label: season.name, x: FARM_SEASON_CELLS[index].x, y: 0,
        w: FARM_SEASON_CELLS[index].w, h: 2,
        title: season.season === state.currentSeason ? `${season.name} (now)` : season.name,
      })),
    });
  }

  function farmCropRowHtml(crop, active, overflow = false) {
    const selected = crop.id === active.plantId;
    const fallow = crop.id < 0;
    return DWFUI.rowHtml({
      tag: "button", cls: "farm-crop-row", selected, role: "radio", checked: selected,
      dataset: { farmCrop: crop.id, farmRowHeightCells: FARM_CROP_ROW_CELLS },
      icon: farmCellMarkup(crop.token, fallow ? "fallow" : "crop", "farm-crop-icon"),
      copyCls: "farm-crop-copy", labelCls: "farm-crop-name",
      label: fallow ? "Leave fallow" : farmCropDisplayName(crop.name),
      sub: !fallow && crop.seedCount === 0 ? { text: "No seeds", cls: "farm-no-seeds" } : null,
      trailing: `<span class="farm-crop-control" data-farm-width-cells="${FARM_CROP_CONTROL_CELLS.w}"` +
        ` data-farm-height-cells="${FARM_CROP_CONTROL_CELLS.h}"` +
        ` data-farm-shift-cells="${overflow ? FARM_CROP_CONTROL_CELLS.overflowShift : 0}" aria-hidden="true">` +
        `${selected ? DWFUI.triState.markHtml("all", { cls: "farm-crop-tick", cssSized: true }) : ""}</span>`,
    });
  }

  function bindFarmCropRows(mount, onSelect, focus) {
    if (!mount || typeof mount.querySelectorAll !== "function") return 0;
    const rows = Array.from(mount.querySelectorAll("[data-farm-crop]"));
    rows.forEach(rowButton => rowButton.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const plant = Number(rowButton.dataset.farmCrop);
      if (!Number.isInteger(plant)) return;
      rows.forEach(button => { button.disabled = true; });
      try {
        await onSelect(plant);
      } finally {
        if (typeof focus === "function") focus();
      }
    }));
    return rows.length;
  }

  function farmCropListHtml(state) {
    const active = state.seasons[state.activeSeason];
    // A scheduled crop that the server no longer offers must remain selectable and visible.
    const currentMissing = active.plantId >= 0 && !active.crops.some(crop => crop.id === active.plantId);
    const cropRows = currentMissing
      ? [{ id: active.plantId, token: active.plantToken, name: active.plantName, seedCount: 0 }, ...active.crops]
      : active.crops;
    const choices = [{ id: -1, token: "", name: "Fallow", seedCount: 0 }, ...cropRows];
    const overflow = choices.length > FARM_CROP_VISIBLE_ROWS;
    const list = DWFUI.scrollHtml({
      cls: `farm-crop-list${overflow ? " farm-crop-list--overflow" : ""}`,
      rows: ".farm-crop-row", preserveKey: `farm-crops-${active.season}`,
      ariaLabel: `${active.name} crop`,
      dataset: {
        farmVisibleRows: FARM_CROP_VISIBLE_ROWS, farmOverflow: overflow ? 1 : 0,
        farmScrollbarWidthCells: overflow ? FARM_CROP_SCROLLBAR_CELLS.w : 0,
        farmScrollbarHeightCells: FARM_CROP_SCROLLBAR_CELLS.h,
      },
    }, choices.map(crop => farmCropRowHtml(crop, active, overflow)).join(""));
    return `<div class="farm-crop-chooser" role="radiogroup" aria-label="${DWFUI.esc(active.name)} crop">${list}</div>`;
  }

  // Seed rows share the stock item sheet's action vocabulary and route. This row is a SUPERSET of the
  // four-button itemActions preset -- it also has a follow -- so the sprites are named per item.
  function farmSeedRowHtml(seed) {
    const stacks = Math.max(1, Number(seed.stacks) || 1);
    if (stacks > 1) {
      const flags = [
        seed.forbidden ? "forbidden" : "",
        seed.dump ? "marked for dumping" : "",
        seed.hidden ? "hidden" : "",
      ].filter(Boolean).join(", ");
      return DWFUI.rowHtml({
        cls: "farm-seed-row farm-seed-row-aggregate",
        icon: farmCellMarkup(seed.token, "seed", "farm-seed-icon"),
        copyCls: "farm-seed-name",
        labelHtml: DWFUI.rawHtml("seed name plus honest aggregate stack and item totals",
          `${escapeHtml(seed.name)} <span class="farm-seed-count">` +
          `(${Math.max(0, Number(seed.count) || 0)} seeds in ${stacks} stacks)</span>`),
        trailing: flags ? `<span class="farm-seed-flags">${escapeHtml(flags)}</span>` : "",
      });
    }
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

  // ---- the farm header tool cluster ------------------------------------------------------------
  function farmHeaderHtml(info = {}) {
    return DWFUI.headerHtml({
      cls: "farm-native-head",
      icon: farmCellMarkup("", "plot", "farm-head-icon", 40),
      title: "Farm Plot", titleCls: "farm-head-title",
      toolsCls: "farm-head-tools",
      tools: [
        { role: "quill", placeholder: true, dataset: { farmRename: "" },
          title: "Rename farm plot -- UNVERIFIED: the server exposes no farm-plot rename route yet" },
        ...(info.markedForRemoval ? [] : [{ role: "removeBuilding", dataset: { bldAct: "cancel" },
          title: "Remove this farm plot", ariaLabel: "Remove this farm plot" }]),
      ],
      close: false,
    });
  }

  async function fetchFarmPlotInfo(id) {
    try {
      const r = await fetch(`/farm-plot?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      return data && data.isFarmPlot ? data : null;
    } catch { globalThis.DwfErr?.count("farm-plot-panel.info"); }
    return null;
  }

  async function postFarmPlotSeasonCrop(id, season, plant) {
    const r = await fetch(`/farm-plot-action?id=${id}&season=${season}&plant=${plant}&t=${Date.now()}`, {
      method: "POST", cache: "no-store"
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("farm-plot-panel.crop-response-parse"); }
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "farm plot action failed");
    return data;
  }

  async function postFarmPlotSeasonalFertilize(id, seasonal) {
    const r = await fetch(`/farm-plot-fertilize-action?id=${id}&seasonal=${seasonal ? 1 : 0}&t=${Date.now()}`, {
      method: "POST", cache: "no-store"
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("farm-plot-panel.fertilize-response-parse"); }
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

  if (typeof window !== "undefined") Object.assign(window, { bindFarmCropRows, farmAggregateSeedStocks, farmCropListHtml, farmHeaderHtml, paintFarmCells, farmPlotPanelState, farmSeasonTabsHtml, farmSeedRowHtml, farmSeedStocksForCrop, fetchFarmPlotInfo, postFarmPlotSeasonCrop, postFarmPlotSeasonalFertilize, postFarmSeedAction });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { FARM_SEASON_NAMES, farmPlotPanelState, farmSpriteCell, farmSeedStocksForCrop, farmAggregateSeedStocks, farmCellMarkup, paintFarmCells, bindFarmCropRows, farmCropDisplayName, farmSeasonTabsHtml, farmCropRowHtml, farmCropListHtml, farmSeedRowHtml, farmHeaderHtml, fetchFarmPlotInfo, postFarmPlotSeasonCrop, postFarmPlotSeasonalFertilize, postFarmSeedAction, FARM_SEASON_CELLS, FARM_CROP_VISIBLE_ROWS, FARM_CROP_ROW_CELLS, FARM_CROP_SCROLLBAR_CELLS, FARM_CROP_CONTROL_CELLS, FARM_SEED_STACK_WIRE_CAP: 200 });
