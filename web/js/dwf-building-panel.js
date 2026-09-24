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

  function viewSheetPanelMarkup(bodyHtml) {
    return `<div class="dwfui-view-sheet-frame-owner">${DWFUI.nativeFrameHtml("viewSheet",
      { cls: "dwfui-window-native-frame" })}</div>` +
      `<div class="dwfui-view-sheet-content">${bodyHtml || ""}</div>`;
  }

  function setViewSheetPanel(classNames, bodyHtml) {
    selection.className = `visible view-sheet-panel${classNames ? " " + classNames : ""}`;
    panelContent(selection).innerHTML = viewSheetPanelMarkup(bodyHtml);
  }

  function setSelectionPanel(classNames, bodyHtml) {
    selection.className = `visible${classNames ? " " + classNames : ""}`;
    panelContent(selection).innerHTML = bodyHtml || "";
  }

  function stockpilePanelMarkup(bodyHtml) {
    return `<div class="dwfui-stockpile-frame-owner">${DWFUI.nativeFrameHtml("viewSheet",
        { cls: "dwfui-window-native-frame" })}</div>` +
      `<div class="dwfui-stockpile-content">${bodyHtml || ""}</div>`;
  }

  function setStockpilePanel(bodyHtml) {
    setSelectionPanel("stockpile-panel", stockpilePanelMarkup(bodyHtml));
  }

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

  let buildingCageSearch = "";
  let buildingRestraintSearch = "";
  let buildingRestraintSortKey = "name";
  let buildingRestraintSortDirection = 1;

  async function fetchCoffinBurialInfo(id) {
    try {
      const r = await fetch(`/burial-coffin?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      if (data && data.ok !== false && data.isCoffin) return data;
    } catch { globalThis.DwfErr?.count("building-panel.coffin-info"); }
    return null;
  }

  async function postCoffinBurialAction(id, action) {
    const r = await fetch(`/burial-coffin-action?id=${id}&action=${encodeURIComponent(action)}&t=${Date.now()}`,
      { method: "POST", cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("building-panel.burial-response-parse"); }
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "burial action failed");
    return data;
  }

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


  function buildingArtMarkup(info) {
    const hasSprite = !!(info && info.spriteRef && info.spriteRef.itemType);
    const prose = String((info && (info.artDescription || info.artBaseDescription)) || "").trim();
    const artName = String((info && info.artName) || "").trim();
    if (!hasSprite && !prose && !artName) return "";
    const icon = hasSprite
      ? DWFUI.iconHtml({ item: info.spriteRef, cls: "building-art-glyph", size: 32,
                         alt: info.name || "Artwork" })
      : "";
    const nameLine = artName
      ? `<div class="building-art-name">${escapeHtml(artName)}</div>` : "";
    const qualityLine = String((info && info.artQualityName) || "").trim()
      ? `<div class="dwfui-text--note building-note building-art-quality">${escapeHtml(info.artQualityName)}</div>` : "";
    // Long art prose is a scrollbox, per the component-architecture spec -- never a clipped div.
    const proseBlock = prose
      ? DWFUI.scrollHtml({ cls: "building-art-scroll" },
          `<div class="building-art-prose">${escapeHtml(prose)}</div>`)
      : "";
    return `<div class="building-art">${icon}<div class="building-art-copy">${nameLine}${qualityLine}${proseBlock}</div></div>`;
  }

  function genericBuildingPanelMarkup(info, options = {}) {
    const underConstruction = !info.built;
    const statusLine = info.built ? "Constructed."
      : (info.suspended ? "Construction suspended." : "Waiting for construction…");
    const suspendBtn = underConstruction && info.hasJobs
      ? DWFUI.plaqueBtnHtml({ cls: "building-btn", dataset: { bldAct: info.suspended ? "resume" : "suspend" },
          label: info.suspended ? "Resume construction" : "Suspend construction" })
      : "";
    const priorityBtn = underConstruction && info.hasJobs && info.doNow !== undefined
      ? DWFUI.plaqueBtnHtml({ cls: "building-btn", size: "compact", on: !!info.doNow,
          dataset: { bldAct: "priority" }, label: info.doNow ? "Priority: doing now" : "Make priority" })
      : "";
    const passageBtn = info.passageControl
      ? DWFUI.plaqueBtnHtml({ cls: "building-btn", size: "compact", on: !!info.passageForbidden,
          dataset: { bldAct: "toggle-passage" }, label: info.passageForbidden ? "Allow passage" : "Close to passage" }) +
        `<div class="dwfui-text--note building-note">Passage: ${info.passageForbidden ? "Closed to traffic" : "Allowed"}${info.passageClosed ? " (physically closed)" : " (currently open)"}</div>`
      : "";
    const cageSummary = buildingCageSummary(info);
    const cageBtn = cageSummary && info.built
      ? `<div class="dwfui-text--section zone-section-label">Cage / Terrarium</div>` +
        DWFUI.plaqueBtnHtml({ cls: "building-btn", dataset: { buildingCage: "" },
          label: `View occupants and assign (${cageSummary.label})` })
      : "";
    const restraintBtn = info.isRestraint && info.built
      ? `<div class="dwfui-text--section zone-section-label">Chain / Restraint</div>` +
        DWFUI.plaqueBtnHtml({ cls: "building-btn", label: "Choose assigned creature",
          dataset: { buildingRestraint: "" } })
      : "";
    const coffinInfo = options.coffinInfo || null;
    const coffinSummary = coffinBurialSummary(coffinInfo);
    const coffinTomb = coffinInfo?.tomb || {};
    const coffinBtn = coffinSummary
      ? `<div class="dwfui-text--section zone-section-label">Burial</div>
         <div class="dwfui-text--note zone-note">${escapeHtml(coffinSummary.label)}</div>` +
        DWFUI.plaqueBtnHtml({ cls: "building-btn", dataset: { coffinOwner: "" }, label: coffinSummary.manageLabel }) +
        (coffinSummary.hasTomb
          ? DWFUI.plaqueBtnHtml({ cls: "building-btn", dataset: { coffinAny: "" }, label: "Use for any citizen" }) +
            `<div class="zone-btn-row">` +
            `<label>${DWFUI.checkHtml({ cls: "zone-tgl", checked: !!coffinTomb.citizens, ariaLabel: "Citizens",
              dataset: { coffinAct: coffinTomb.citizens ? "citizens-off" : "citizens-on" } })}Citizens</label>` +
            `<label>${DWFUI.checkHtml({ cls: "zone-tgl", checked: !!coffinTomb.pets, ariaLabel: "Pets",
              dataset: { coffinAct: coffinTomb.pets ? "pets-off" : "pets-on" } })}Pets</label>` +
            `</div>`
          : "")
      : "";
    const leverLinkInfo = options.leverLinkInfo || null;
    const leverLinkStatus = leverLinkInfo ? window.leverLinkMechanismStatus(leverLinkInfo) : null;
    const machineInfo = options.machineInfo || null;
    const machineChipText = machineInfo ? window.machinePanelState(machineInfo).machines
      .filter(m => m.id === Number(machineInfo.machineId)).map(m => m.chip.text)[0] : "";
    const machineBtn = machineInfo
      ? `<div class="dwfui-text--section zone-section-label">Power</div>
         <div class="dwfui-text--note zone-note">${escapeHtml(machineChipText || "Not connected to a network")}</div>
         <div class="dwfui-text--note zone-note">${escapeHtml(DWF_EXTENSION_LABEL)}: opens a fortress-wide overview with no native screen counterpart.</div>
         ${DWFUI.plaqueBtnHtml({ cls: "building-btn", label: "Open DWF power overview", dataset: { machineView: "" } })}`
      : "";
    const siegeInfo = options.siegeInfo || null;
    const siegeSummary = siegeInfo ? window.siegeEnginePanelState(siegeInfo) : null;
    const siegeBtn = siegeSummary
      ? `<div class="dwfui-text--section zone-section-label">Siege engine</div>
         <div class="dwfui-text--note zone-note">${escapeHtml(siegeSummary.built ? siegeSummary.actionLabel : "Still being built")}</div>
         ${DWFUI.plaqueBtnHtml({ cls: "building-btn", label: "Siege engine controls", dataset: { siegeView: "" } })}`
      : "";
    const leverLinkBtn = leverLinkInfo
      ? `<div class="dwfui-text--section zone-section-label">${escapeHtml(leverLinkInfo.sourceType || "Lever")}</div>
         <div class="dwfui-text--note zone-note">${escapeHtml(leverLinkStatus.label)}</div>
         ${DWFUI.plaqueBtnHtml({ cls: "building-btn", label: "Trigger controls", dataset: { leverLink: "" } })}`
      : "";
    const artBlock = buildingArtMarkup(info);
    const panelTitle = String(info.artTitle || info.name || "Building");
    const removalBlock = buildingRemovalSectionHtml(info, { action: "bld" });
    return `${DWFUI.headerHtml({ cls:"building-head", title:panelTitle, titleCls:"building-name", close:false })}
      ${info.markedForRemoval ? removalBlock : `<div class="building-status${info.suspended ? " suspended" : ""}">${escapeHtml(statusLine)}</div>`}
      ${artBlock}
      ${options.orderedByLine || ""}${suspendBtn}${priorityBtn}${passageBtn}
      ${cageBtn}${restraintBtn}${coffinBtn}${leverLinkBtn}${machineBtn}${siegeBtn}
      ${info.markedForRemoval ? "" : DWFUI.plaqueBtnHtml({ cls: "building-btn danger", tone: "red",
        dataset: { bldAct: "cancel" }, label: info.built ? "Remove building" : "Cancel construction" })}`;
  }

  // The candidate text a worker row is searched by: name + profession, lowercased, so "miner urist"
  // and "urist miner" both match.
  function wsWorkerSearchText(u) {
    const r = u || {};
    return `${r.name || ("Unit " + Number(r.id))} ${r.profession || ""}`.trim().toLowerCase();
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
        dataset: { wsWorkerSearch: wsWorkerSearchText(u) },
        copyCls: "workshop-worker-copy", labelCls: "workshop-name",
        labelHtml: DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered workshop worker name", labelHtml),
        sub: u.profession ? { text: u.profession, cls: "workshop-meta" } : null,
        trailing: DWFUI.plaqueBtnHtml({ cls: "workshop-icon-btn", size: "compact", on: !!u.assigned,
          dataset: { wsWorker: Number(u.id), wsAssign: u.assigned ? "0" : "1" }, label: u.assigned ? "On" : "Add" }),
      });
    }).join("");
  }

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

  function engravingPanelMarkup(data) {
    const present = !!(data && data.present);
    const artName = String((data && data.artName) || "").trim();
    const prose = data && data.descriptionAvailable ? String(data.description || "").trim() : "";
    const artist = String((data && data.artistName) || "").trim() || "Unknown";
    const quality = String((data && data.qualityName) || "").trim() || "Unknown";
    const fact = (label, value) => DWFUI.rowHtml({ cls: "engrave-row", label,
      cells: [{ html: DWFUI.bitmapTextHtml(value), numeric: true, cls: "engrave-value" }] });
    const factsHtml = present ? fact("Artist", artist) + fact("Quality", quality) : "";
    const bodyHtml = !present
      ? `<div class="dwfui-text--note engrave-note">No engraving on this tile.</div>`
      : `${factsHtml}${prose
          ? DWFUI.scrollHtml({ cls: "engrave-scroll" },
              `<div class="engrave-prose">${escapeHtml(prose)}</div>`)
          : ""}`;
    const title = String((data && data.title) || artName || "").trim() || "Engraving";
    return DWFUI.windowHtml({
      cls: "engraving-window", nativeFrame: "viewSheet",
      ariaLabel: title,
      bodyHtml: `${DWFUI.headerHtml({ cls:"engrave-head", title, titleCls:"engrave-title",
                                      close:false })}
        ${bodyHtml}`,
    });
  }

  // Opens on an explicit TILE, never a pixel, so it cannot nudge the viewport: opening a panel must
  // not move the camera.
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
        // Compatibility fallback for a mixed deploy where /engraving-info lacks the description fields.
        if (inspectDescription && !String(detail.description || "").trim()) {
          detail.description = inspectDescription;
          detail.descriptionAvailable = true;
          if (!detail.title) detail.title = inspectData.title || "";
        }
        data = detail;
      }
    } catch { globalThis.DwfErr?.count("building-panel.engraving-info"); }
    selection.className = "view-sheet-panel engraving-sheet-panel";
    panelContent(selection).innerHTML = engravingPanelMarkup(data);
    if (DWFUI.paintSprites) DWFUI.paintSprites(panelContent(selection));
    selection.classList.add("visible");
  }

  async function openBuildingPanel(id, inspectData = null) {
    let info = null;
    try {
      const r = await fetch(`/building-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) info = await r.json();
    } catch { globalThis.DwfErr?.count("building-panel.info"); }
    if (!info || info.error || info.id < 0) { closeSelection(); return; }
    if (inspectData) {
      if (!info.artTitle && inspectData.title) info.artTitle = inspectData.title;
      if (!info.artDescription && inspectData.description) info.artDescription = inspectData.description;
    }
    // W-F: a trade depot resolves to kind:"building"; hand it to the depot panel.
    if (info.isDepot && typeof openTradeDepotPanel === "function") { openTradeDepotPanel(info.id, info); return; }
    // Native bed / armor-stand / weapon-rack rooms store military use on their related Barracks
    // civzone, so open that room panel: its blue flag reaches the same squad assignment.
    if (Number(info.barracksZoneId) >= 0) { window.openZonePanel(Number(info.barracksZoneId)); return; }
    // The "Ordered by" line, merged from /attrib by building id. Graceful: no route or unknown id
    // yields an empty string and nothing renders.
    try { if (typeof attribRefresh === "function") await attribRefresh(); } catch { globalThis.DwfErr?.count("building-panel.attribution"); }
    const orderedByChip = (typeof attribRowHtml === "function") ? attribRowHtml("building", info.id) : "";
    const orderedByLine = orderedByChip ? `<div class="dwfui-text--note building-note building-attrib">Ordered by ${orderedByChip}</div>` : "";
    // Older hosts omit isFarmPlot, so no farm request is made until a matching server arrives.
    let farmPlotInfo = info.isFarmPlot && info.built ? await window.fetchFarmPlotInfo(info.id) : null;
    let farmSelectedSeason = 0;
    const coffinInfo = info.built ? await fetchCoffinBurialInfo(info.id) : null;
    const leverLinkInfo = info.built ? await window.fetchLeverLinkInfo(info.id) : null;
    // The route answers "not a machine part" cheaply, so this is one small request, not a scan.
    const machineInfo = info.built ? await window.fetchMachineInfo(info.id) : null;
    // Not gated on `built`, unlike the machine request: an unfinished siege engine still has a sheet
    // worth opening. The route answers "not a siege engine" cheaply for everything else.
    const siegeInfo = await window.fetchSiegeEngineInfo(info.id);
    const renderFarmPlotSection = () => {
      const state = window.farmPlotPanelState(farmPlotInfo, farmSelectedSeason);
      const mount = selection.querySelector("[data-farm-plot-section]");
      if (!state || !mount) return;
      const active = state.seasons[state.activeSeason];
      const activeSeedStocks = window.farmSeedStocksForCrop(state.seedStocks, active.plantToken);
      const seedGroups = window.farmAggregateSeedStocks(activeSeedStocks);
      const seedCount = activeSeedStocks.reduce((sum, seed) => sum + Math.max(0, Number(seed.count) || 0), 0);
      const seedCap = state.seedStocks.length >= FARM_SEED_STACK_WIRE_CAP
        ? ` The ${FARM_SEED_STACK_WIRE_CAP}-stack response cap was reached; the true total may be higher.`
        : "";
      mount.innerHTML = `${window.farmSeasonTabsHtml(state)}
        ${window.farmCropListHtml(state)}
        <div class="farm-fertilize-controls">
          <div class="farm-check-row">
            ${DWFUI.checkHtml({ checked: state.fertilize.seasonal,
              dataset: { farmSeasonalFertilize: 1 },
              title: "Toggle fertilizing this farm every season",
              ariaLabel: "Fertilize every season" })}
            <span><b>Fertilize every season</b><small>Current amount: ${state.fertilize.current}/${state.fertilize.max}</small></span>
          </div>
        </div>
        <div class="farm-seed-summary">${activeSeedStocks.length} stack${activeSeedStocks.length === 1 ? "" : "s"} · ${seedCount} seed${seedCount === 1 ? "" : "s"}.${seedCap}</div>
        <div class="farm-seed-stock" aria-label="Owned seed stacks for ${escapeHtml(active.plantName)}">${seedGroups.map(window.farmSeedRowHtml).join("")}</div>`;
      window.paintFarmCells(mount);
      mount.querySelectorAll("[data-farm-season]").forEach(button => button.addEventListener("click", event => {
        event.stopPropagation();
        farmSelectedSeason = Number(button.dataset.farmSeason);
        renderFarmPlotSection();
      }));
      window.bindFarmCropRows(mount, async plant => {
        try {
          await window.postFarmPlotSeasonCrop(info.id, state.activeSeason, plant);
          const row = farmPlotInfo && farmPlotInfo.seasons && farmPlotInfo.seasons[state.activeSeason];
          if (row) {
            row.plantId = plant;
            const crop = (row.crops || []).find(candidate => Number(candidate.id) === plant) || {};
            row.plantName = plant < 0 ? "Fallow" : crop.name || "Crop";
            row.plantToken = plant < 0 ? "" : crop.token || "";
          }
        } catch {
          farmPlotInfo = await window.fetchFarmPlotInfo(info.id) || farmPlotInfo;
        }
        renderFarmPlotSection();
      }, focusPage);
      mount.querySelector("[data-farm-seasonal-fertilize]")?.addEventListener("click", async event => {
        event.stopPropagation();
        const check = event.currentTarget;
        const next = check.getAttribute("aria-pressed") !== "true";
        check.disabled = true;
        try {
          await window.postFarmPlotSeasonalFertilize(info.id, next);
          if (farmPlotInfo && farmPlotInfo.fertilize) farmPlotInfo.fertilize.seasonal = next;
        } catch {
          farmPlotInfo = await window.fetchFarmPlotInfo(info.id) || farmPlotInfo;
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
          const result = await window.postFarmSeedAction(itemId, action);
          if (action === "view" && typeof showStockItemSheet === "function") {
            showStockItemSheet(result);
            focusPage();
            return;
          }
          if (action === "follow" && result.mapPos && typeof flashMapTile === "function")
            flashMapTile(result.mapPos);
          farmPlotInfo = await window.fetchFarmPlotInfo(info.id) || farmPlotInfo;
        } catch (err) { globalThis.DwfOrder.lost("building.farm-action", err, "That farm-plot change"); }
        renderFarmPlotSection();
        focusPage();
      }));
    };
    setViewSheetPanel("building-panel" + (farmPlotInfo ? " farm-panel" : ""), farmPlotInfo
      ? `${window.farmHeaderHtml(info)}${info.markedForRemoval
          ? buildingRemovalSectionHtml(info, { action: "bld" })
          : `<div data-farm-plot-section></div>`}`
      : genericBuildingPanelMarkup(info, { orderedByLine, coffinInfo, leverLinkInfo, machineInfo, siegeInfo }));
    renderFarmPlotSection();
    if (farmPlotInfo) window.paintFarmCells(selection.querySelector(".farm-native-head"));
    if (DWFUI.paintSprites) DWFUI.paintSprites(panelContent(selection));
    selection.querySelector("[data-building-cage]")?.addEventListener("click", event => {
      event.stopPropagation(); openBuildingCagePanel(info.id); focusPage();
    });
    selection.querySelector("[data-building-restraint]")?.addEventListener("click", event => {
      event.stopPropagation(); openBuildingRestraintPanel(info.id); focusPage();
    });
    selection.querySelector("[data-lever-link]")?.addEventListener("click", event => {
      event.stopPropagation(); window.openLeverLinkPanel(info.id); focusPage();
    });
    selection.querySelector("[data-siege-view]")?.addEventListener("click", event => {
      event.stopPropagation(); window.openSiegeEnginePanel(info.id); focusPage();
    });
    selection.querySelector("[data-machine-view]")?.addEventListener("click", event => {
      event.stopPropagation(); window.openMachinePanel(info.id); focusPage();
    });
    selection.querySelector("[data-coffin-owner]")?.addEventListener("click", async event => {
      event.stopPropagation();
      try {
        await postCoffinBurialAction(info.id, "ensure-tomb");
        const next = await fetchCoffinBurialInfo(info.id);
        const tombId = Number(next && next.tombId);
        if (Number.isInteger(tombId) && tombId >= 0) window.openZoneOwnersPanel(tombId);
        else openBuildingPanel(info.id);
      } catch { openBuildingPanel(info.id); }
      focusPage();
    });
    selection.querySelector("[data-coffin-any]")?.addEventListener("click", async event => {
      event.stopPropagation();
      try { await postCoffinBurialAction(info.id, "any-citizen"); } catch (err) { globalThis.DwfOrder.lost("building.coffin-access", err, "That burial setting"); }
      openBuildingPanel(info.id);
      focusPage();
    });
    selection.querySelectorAll("[data-coffin-act]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      try { await postCoffinBurialAction(info.id, btn.dataset.coffinAct || ""); } catch (err) { globalThis.DwfOrder.lost("building.coffin-access", err, "That burial setting"); }
      openBuildingPanel(info.id);
      focusPage();
    }));
    selection.querySelectorAll("[data-bld-act]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const action = btn.dataset.bldAct;
      try {
        const response = await fetch(`/building-action?id=${info.id}&action=${action}`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(`building action failed (${response.status})`);
      } catch (err) { globalThis.DwfOrder.lost("building.action", err, "That building change"); }
      if (action === "cancel") closeSelection();
      else openBuildingPanel(info.id); // refresh suspend/resume state
      focusPage();
    }));
  }

  // ---- the zone-unit-list row grammar -----------------------------------------------------------
  // The name fits its column at runtime (DWFUI.fitNativeLabel: squeeze, cut, then three periods), so
  // a narrow panel, a scrollbar or a wider button never cuts it mid-letter. `inkColor` is a DF palette
  // index for the name, as native colours a unit by profession.
  function zoneUnitRowHtml(cfg) {
    const c = cfg || {};
    // A meta line cannot wrap either, so a long one is cut to fit; `metaLines` stacks short lines.
    const lines = (Array.isArray(c.metaLines) ? c.metaLines : [{ text: c.meta }])
      .filter(line => line && line.text);
    const fullName = c.label == null ? "" : String(c.label);
    const ink = c.inkColor == null ? NaN : Number(c.inkColor);
    const name = DWFUI.bitmapTextHtml(fullName, { fitNativeLabel: { host: "parent" } });
    const nameHtml = Number.isInteger(ink) && ink >= 0 && ink <= 15
      ? `<span class="zone-unit-ink" style="color:${DWFUI.dfColor(ink)}">${name}</span>` : name;
    return DWFUI.rowHtml({
      cls: "zone-unit-row" + (c.rowCls ? " " + c.rowCls : ""),
      dataset: c.dataset,
      icon: c.icon,
      title: c.title != null ? c.title : [fullName, ...lines.map(line => line.text)].join(" - "),
      copyCls: "zone-animal-copy", labelCls: "zone-unit-name",
      labelHtml: c.nativeLabelHtml != null ? c.nativeLabelHtml
        : DWFUI.rawHtml("a unit name takes DF's profession colour", nameHtml),
      sub: lines.length
        ? lines.map(line => ({ cls: "zone-unit-meta", tone: line.tone,
            html: DWFUI.bitmapTextHtml(line.text, { fitNativeLabel: { host: "parent" } }) }))
        : null,
      trailing: c.trailing,
    });
  }
  function zoneUnitListHtml(rows, emptyNote) {
    return rows.length
      ? DWFUI.scrollHtml({ cls: "zone-unit-list", rows: ".zone-unit-row" }, rows.join(""))
      : `<div class="dwfui-text--note zone-note">${emptyNote}</div>`;
  }

  async function openBuildingCagePanel(id) {
    let data = null;
    try {
      const r = await fetch(`/building-cage?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch { globalThis.DwfErr?.count("building-panel.cage-info"); }
    if (!data || Number(data.id) < 0) { openBuildingPanel(id); return; }
    setSelectionPanel("building-panel zone-panel",
      window.buildingCagePanelMarkup(data, { search: buildingCageSearch }));
    // Cage candidate filtering, hide/show in place like the zone choosers.
    (() => {
      const input = selection.querySelector("[data-cage-search]");
      if (!input) return;
      const empty = selection.querySelector(".cage-unit-empty");
      const apply = () => {
        buildingCageSearch = input.value || "";
        const term = buildingCageSearch.trim();
        let shown = 0;
        selection.querySelectorAll("[data-cage-row]").forEach(row => {
          const hit = window.wsPickerMatches(row.dataset.cageSearch, term);
          row.hidden = !hit;
          if (hit) shown++;
        });
        if (empty) empty.hidden = shown > 0;
      };
      input.addEventListener("input", apply);
      input.addEventListener("keydown", e => e.stopPropagation());
      apply();
    })();
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
          const response = await fetch(`/building-cage-action?id=${data.id}&unit=${unit}&assign=${assign}&kind=${encodeURIComponent(kind)}`, { method: "POST", cache: "no-store" });
          if (!response.ok) throw new Error(`cage assignment failed (${response.status})`);
        } catch (err) { globalThis.DwfOrder.lost("building.cage-assignment", err, "That cage assignment"); }
      }
      openBuildingCagePanel(data.id);
      focusPage();
    }));
  }

  async function openBuildingRestraintPanel(id, cachedData = null, notice = null) {
    let data = cachedData;
    if (!data) {
      try {
        const r = await fetch(`/building-restraint?id=${id}&t=${Date.now()}`, { cache: "no-store" });
        if (r.ok) data = await r.json();
      } catch { globalThis.DwfErr?.count("building-panel.restraint-info"); }
    }
    if (!data || Number(data.id) < 0) { openBuildingPanel(id); return; }
    setSelectionPanel("building-panel zone-panel zone-wide", window.buildingRestraintPanelMarkup(data, {
      search: buildingRestraintSearch,
      sortKey: buildingRestraintSortKey,
      sortDirection: buildingRestraintSortDirection,
      notice,
    }));
    const input = selection.querySelector("[data-restraint-search]");
    if (input) {
      const empty = selection.querySelector(".restraint-unit-empty");
      const apply = () => {
        buildingRestraintSearch = input.value || "";
        let shown = 0;
        selection.querySelectorAll("[data-restraint-row]").forEach(row => {
          const hit = window.wsPickerMatches(row.dataset.restraintSearch, buildingRestraintSearch.trim());
          row.hidden = !hit;
          if (hit) shown++;
        });
        if (empty) empty.hidden = shown > 0;
      };
      input.addEventListener("input", apply);
      input.addEventListener("keydown", event => event.stopPropagation());
      apply();
    }
    selection.querySelectorAll("[data-zone-animal-sort]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        const key = button.dataset.zoneAnimalSort || "name";
        if (key === buildingRestraintSortKey)
          buildingRestraintSortDirection *= -1;
        else {
          buildingRestraintSortKey = key;
          buildingRestraintSortDirection = 1;
        }
        openBuildingRestraintPanel(data.id, data);
        focusPage();
      });
    });
    // One POST, then a fresh read: the server owns the whole cleanup transaction, so the client never
    // predicts the outcome. A refusal or a dead fetch becomes a visible warn line, never a silent win.
    selection.querySelectorAll("[data-restraint-unit]").forEach(btn => {
      if (btn.disabled) return;
      btn.addEventListener("click", async event => {
        event.stopPropagation();
        const unit = Number(btn.dataset.restraintUnit);
        if (!Number.isInteger(unit) || unit < 0) return;
        let notice = null;
        try {
          const r = await fetch(
            `/building-restraint-action?id=${Number(data.id)}&unit=${unit}`,
            { method: "POST", cache: "no-store" });
          if (!r.ok) {
            let why = `the game refused it (${r.status})`;
            try {
              const body = await r.json();
              if (body && body.error) why = String(body.error);
              else if (body && body.busy) why = "Dwarf Fortress is saving; try again in a moment";
            } catch { globalThis.DwfErr?.count("building-panel.restraint-response-parse"); }
            notice = { error: true, text: `Could not assign that creature: ${why}` };
          }
        } catch {
          notice = { error: true,
            text: "Could not assign that creature: the game did not answer. Nothing was changed." };
        }
        openBuildingRestraintPanel(Number(data.id), null, notice);
        focusPage();
      });
    });
    selection.querySelector("[data-building-back]")?.addEventListener("click", event => {
      event.stopPropagation(); openBuildingPanel(data.id); focusPage();
    });
    selection.querySelector("[data-building-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
    // Intentionally no assignment handler: every payload-bearing plaque is visibly disabled.
  }


  if (typeof window !== "undefined") window.DFBuildingOperationsMarkup = window.DFBuildingOperationsMarkup || {};
  if (typeof window !== "undefined") Object.assign(window.DFBuildingOperationsMarkup ||= {}, { genericBuildingPanelMarkup });

  if (typeof window !== "undefined") Object.assign(window, { buildingCageActionLabel, buildingRemovalSectionHtml, openBuildingPanel, setSelectionPanel, setStockpilePanel, setViewSheetPanel, wsWorkerRowsHtml, zoneUnitListHtml, zoneUnitRowHtml });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { viewSheetPanelMarkup, setViewSheetPanel, setSelectionPanel, stockpilePanelMarkup, setStockpilePanel, buildingCageSummary, buildingCageActionLabel, coffinBurialSummary, buildingArtMarkup, genericBuildingPanelMarkup, wsWorkerSearchText, wsWorkerRowsHtml, buildingRemovalSectionHtml, engravingPanelMarkup, openEngravingPanel, openBuildingPanel, zoneUnitRowHtml, zoneUnitListHtml, openBuildingCagePanel, openBuildingRestraintPanel });
