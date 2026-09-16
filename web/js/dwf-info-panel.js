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

  // The nested subtab row of Creatures / Places / Objects is the SHORT_SUBTAB grammar.
  function infoDetailTabRowHtml(tabs, activeId) {
    if (!Array.isArray(tabs) || !tabs.length) return "";
    return DWFUI.tabsHtml({
      cls: "info-detail-tabs", tabCls: "info-tab", dataAttr: "info-detail", level: "subtab",
      ariaLabel: "Information section", active: activeId,
      tabs: tabs.map(tab => ({ key: tab.id, label: tab.label })),
    });
  }

  // Monotonic request token guarding openPanel's /panel fetch against a rapid-tab-switch race.
  let infoPanelRequestSeq = 0;

  // The ONE persistent 8-tab row every info destination shares, in DF's info_interface_mode_type
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

  // The primary nav is the tall gold TAB grammar, above the silver SHORT_SUBTAB row.
  function infoTabRowHtml(activeKey) {
    return DWFUI.tabsHtml({
      cls: "info-tab-row", tabCls: "info-tab", dataAttr: "info-tab", level: "primary",
      ariaLabel: "Fortress information", active: activeKey,
      tabs: INFO_TABS.map(tab => ({ key: tab.key, label: tab.label, title: `${tab.label}\nHotkey: ${tab.hotkey}` })),
    });
  }

  // Wires the shared row wherever it is mounted; innerHTML replacement means every render needs its
  // own listener pass, as with the rest of this file's [data-*] wiring.
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

  // Always DWFUI's shared native search grammar: one field abutting the real BUTTON_FILTER sprite.
  function infoSearchBoxHtml() {
    return DWFUI.searchHtml({
      cls: "info-search", placement: "footer", magnifier: true,
      placeholder: "...", ariaLabel: "Search this information view",
    });
  }

  // The data-attribute is parameterised so the generic info panels can reuse the same input with
  // their own `data-info-search` hook.
  function infoSearchInputHtml(value, attr) {
    const a = attr || "creature-search";
    return DWFUI.searchHtml({
      cls: "info-search", inputCls: "dwfui-search-input info-search-input",
      placement: "footer", magnifier: true, type: "search", dataAttr: a,
      value: value || "", ariaLabel: "Search this information view", preserveKey: `info-${a}`,
    });
  }

  function rowTone(text) {
    // The payload carries no draw colour yet, and English-word matching is not DF state: leave these
    // cells uncoloured until the server ships an authoritative index.
    void text;
    return "";
  }

  // A Tasks row that names no entity has an EMPTY icon column in native -- a different thing from a
  // row whose art we genuinely could not resolve, and the two must not render the same.
  function infoRowHasPlaceArt(row) {
    const sheet = String(row?.iconSheet || "");
    return sheet === "zone" || sheet === "stockpile" || !!String(row?.iconKey || "");
  }

  // Zone rows ship no type key (pixel address until the server names the type -> DWFUI.zoneSprite);
  // building rows draw below the native cell, so both stay raw spans rather than painted tokens.
  function infoPlaceIconMarkup(row) {
    const sheet = String(row?.iconSheet || "");
    const ui = window.dwfuiAccessor();
    if (sheet === "zone") {
      const ix = Math.max(0, Number(row.iconX) || 0);
      const iy = Math.max(0, Number(row.iconY) || 0);
      return `<span class="info-place-icon zone-icon" style="background-position:-${ix * 32}px -${iy * 32}px"></span>`;
    }
    if (sheet === "stockpile" && ui) {
      const rowIdx = Math.max(0, Number(row.iconRow) || 0);
      return ui.iconHtml({ spriteCrop: ui.stockpileIconCrop(rowIdx), cls: "info-place-icon" });
    }
    const iconKey = String(row?.iconKey || "");
    const bldStyle = iconKey ? window.bldIconStyle(iconKey, 32) : "";
    if (bldStyle)
      return `<span class="info-place-icon" style="${bldStyle}"></span>`;
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
    // Tasks rows get a cancel button ahead of the zoom button; other rows carry no jobId, so it is a no-op.
    const canCancel = jobId >= 0;
    if (!canOpen && !canCenter && !canCancel) return "";
    // The cluster order, the .info-row-action classnames and all three data-* hooks are contracts:
    // every handler in wireInfoBody dispatches off them.
    const ui = window.dwfuiAccessor();
    if (!ui) return "";
    const S = ui.TOKENS.sprites;
    const items = [];
    if (canCancel) items.push({ action: "cancelJob", sprite: S.cancelJob,
      dataset: { infoCancelJob: jobId }, title: "Cancel job" });
    if (canCenter) items.push({ action: "recenter", sprite: S.recenter,
      dataset: { infoCenter: "" }, title: "Center and flash" });
    if (canOpen) items.push({ action: "view", sprite: S.view,
      dataset: { infoOpen: "" }, title: "Open / manage" });
    return ui.actionButtonsHtml(items,
      { cls: "info-row-actions", btnCls: "info-row-action", ariaLabel: "Row actions" });
  }

  // The server passes every label through DF2UTF, so a source-authored UTF-8 middle dot arrives as
  // two CP437 glyphs. Rows must never expose that transport accident as player-facing text.
  function infoText(text) {
    return String(text == null ? "" : text)
      .replace(/\u252c\u2556/g, "\u00b7")
      .replace(/\u00c2\u00b7/g, "\u00b7");
  }

  function placeIdentity(row) {
    const kind = String(row?.kind || "");
    if (kind !== "zone")
      return { label: infoText(row?.name), sub: infoText(row?.subtitle), status: infoText(row?.status) };
    const label = infoText(row?.category) || "Zone";
    const name = infoText(row?.name);
    const status = infoText(row?.status);
    // Native names the zone TYPE first; the server's coordinate subtitle is not native row copy.
    const generic = !name || /^(?:activity\s+)?zone(?:\s*#?\d+)?$/i.test(name) ||
      name.toLowerCase() === label.toLowerCase();
    return { label, sub: [generic ? "" : name, status].filter(Boolean).join(" \u00b7 "), status: "" };
  }

  // Places has its own row recipe. Sharing Objects' five-column table invented Name/Cat/Prof headings
  // on Places and made the native width-gated detail impossible.
  function placeRowsHtml(rows) {
    if (!Array.isArray(rows) || !rows.length)
      return "";
    const rowsHtml = rows.map(row => {
      const kind = String(row.kind || "");
      const unitId = Number(row.unitId ?? -1);
      const locationId = Number(row.locationId ?? -1);
      const buildingId = Number(row.buildingId ?? -1);
      const itemId = Number(row.itemId ?? -1);
      const pos = infoRowPos(row);
      const clickable = unitId >= 0 || locationId >= 0 || itemId >= 0 ||
        (buildingId >= 0 && kind);
      const badges = Array.isArray(row.badges) ? row.badges : [];
      const identity = placeIdentity(row);
      const status = identity.status;
      const job = infoText(row.job);
      const detailHtml = `${status ? DWFUI.bitmapTextHtml(status, { cls: "info-status" }) : ""}` +
        `${job ? DWFUI.bitmapTextHtml(job, { cls: "info-muted" }) : ""}` +
        `${badges.length ? `<span class="info-badges">${badges.map(badge =>
          DWFUI.bitmapTextHtml(badge, { cls: "info-badge" })).join("")}</span>` : ""}`;
      const dataset = {
        unitId, placeKind: kind, locationId, buildingId, itemId,
      };
      if (pos) Object.assign(dataset, { posX: pos.x, posY: pos.y, posZ: pos.z });
      return DWFUI.rowHtml({
        cls: `info-row info-place-row${clickable ? " clickable" : ""}${row.muted ? " info-muted" : ""}`,
        icon: infoPlaceIconMarkup(row),
        labelHtml: DWFUI.bitmapTextHtml(identity.label, { cls: "info-name-main" }),
        sub: identity.sub
          ? { html: DWFUI.bitmapTextHtml(identity.sub, { cls: "info-subtitle" }) }
          : null,
        cells: [{ cls: "info-place-detail info-badges", html: detailHtml }],
        trailing: infoRowActions(row),
        dataset,
      });
    }).join("");
    return DWFUI.scrollHtml({
      cls: "info-table info-place-table", rows: ".info-place-row", ariaLabel: "Places",
    }, rowsHtml);
  }

  // Measure the mounted `.info-main`, not window.innerWidth: the client panel can be narrow in a wide page.
  function infoPlaceDetailWide(widthPx, interfaceScale = 1) {
    const width = Number(widthPx) || 0;
    const scale = Math.max(0.5, Math.min(4, Number(interfaceScale) || 1));
    return width >= 135 * 8 * scale;
  }

  function syncInfoPlaceDetailWidth(scope) {
    const root = scope || clientPanel;
    const main = root?.matches?.(".info-main") ? root : root?.querySelector?.(".info-main");
    if (!main) return false;
    const scale = typeof DWFUI.interfaceScale === "function"
      ? DWFUI.interfaceScale(main.ownerDocument) : 1;
    const wide = infoPlaceDetailWide(main.clientWidth, scale);
    main.dataset.infoPlaceWide = wide ? "true" : "false";
    return wide;
  }

  let infoPlaceWidthObserver = null;
  function watchInfoPlaceDetailWidth(scope) {
    if (infoPlaceWidthObserver) {
      infoPlaceWidthObserver.disconnect();
      infoPlaceWidthObserver = null;
    }
    if (activeInfoSection !== "places") return;
    const root = scope || clientPanel;
    const main = root?.matches?.(".info-main") ? root : root?.querySelector?.(".info-main");
    if (!main) return;
    syncInfoPlaceDetailWidth(main);
    const ResizeCtor = main.ownerDocument?.defaultView?.ResizeObserver ||
      (typeof ResizeObserver === "function" ? ResizeObserver : null);
    if (!ResizeCtor) return;
    infoPlaceWidthObserver = new ResizeCtor(() => syncInfoPlaceDetailWidth(main));
    infoPlaceWidthObserver.observe(main);
  }

  function renderInfoRows(rows) {
    if (!Array.isArray(rows) || !rows.length)
      return "";
    const rowsHtml = rows.map(row => {
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
            ${DWFUI.bitmapTextHtml(row.name || "", { cls: "info-name-main" })}
            ${row.subtitle ? DWFUI.bitmapTextHtml(row.subtitle, { cls: "info-subtitle" }) : ""}
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
    }).join("");
    return `
      <div class="info-table-head">
        <span></span><span>Name</span><span>Cat</span><span>Prof</span><span>Job / Status</span>
      </div>
      ${DWFUI.scrollHtml({ cls: "info-table", rows: ".info-row", ariaLabel: "Places and objects" }, rowsHtml)}
    `;
  }
  // Functional bottom search for the generic info panels, same token-filter convention as Creatures.
  // The query resets whenever the active section changes.
  let infoSearch = "";
  let infoSearchSection = "";
  let infoRowsRaw = [];
  let infoMessageHtml = "";
  let infoIsTasks = false;

  function infoRowSearchText(row) {
    return `${row.name || ""} ${row.profession || ""} ${row.category || ""} ${row.status || ""} ${row.job || ""} ${row.subtitle || ""}`.toLowerCase();
  }

  // Pure, so the offline fixture can assert match and no-match behaviour; an empty query returns every row.
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
    const rowsHtml = infoIsTasks ? window.taskRowsHtml(filtered)
      : (activeInfoSection === "places" ? placeRowsHtml(filtered) : renderInfoRows(filtered));
    return `${infoMessageHtml}${rowsHtml}`;
  }

  // Extracted so a search re-render, which rebuilds only .info-main, can re-attach the same handlers.
  function wireInfoBody(scope) {
    const root = scope || clientPanel;
    watchInfoPlaceDetailWidth(root);
    root.querySelectorAll("[data-unit-id]").forEach(row => {
      row.addEventListener("click", event => {
        if (event.target.closest("[data-info-open], [data-info-center], [data-info-cancel-job], [data-info-job-control]")) return;
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
          window.openItemPanel(itemId);
          return;
        }
        // A Places > Locations row is a LOCATION first: clicking it opens the location, not the civzone.
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
          window.openItemPanel(itemId);
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
        const pos = window.livePosForRow(row);
        if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))
          await centerAndFlashMapPos(pos);
      });
    });
    // Cancel then refresh this tab in place, matching DF: the job disappears from the list immediately.
    root.querySelectorAll("[data-info-cancel-job]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const jobId = Number(button.dataset.infoCancelJob);
        if (!Number.isInteger(jobId) || jobId < 0) return;
        button.disabled = true;
        try {
          const response = await fetch(`/task-cancel?player=${encodeURIComponent(player)}&job=${jobId}&t=${Date.now()}`, {
            method: "POST", cache: "no-store"
          });
          if (!response.ok) throw new Error(`task cancellation failed (${response.status})`);
        } catch (err) { globalThis.DwfOrder.lost("tasks.cancel", err, "That task cancellation"); }
        openPanel(activeInfoPanel || "orders", activeInfoSection || "tasks", activeInfoDetail || "");
      });
    });
    // Every non-cancel Tasks-row tile shares one server route, and the server rechecks the native
    // availability gate against current DF state, so a stale panel can never force a write.
    root.querySelectorAll("[data-info-job-control]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const control = String(button.dataset.infoJobControl || "");
        const action = window.TASK_JOB_ACTION[control];
        const jobId = Number(button.dataset.infoJobId);
        // jobDetails stays an honest deferral: there is no editor or write route to fake.
        if (!action || !Number.isInteger(jobId) || jobId < 0 || button.disabled) return;
        button.disabled = true;
        const query = new URLSearchParams({
          player: String(player || ""), job: String(jobId), action,
        });
        try {
          const response = await fetch(`/task-action?${query}`, { method: "POST", cache: "no-store" });
          if (!response.ok) {
            button.disabled = false;
            return;
          }
          const result = await response.json();
          if (control === "recenterBuilding") {
            const pos = result && result.pos;
            if (pos && [pos.x, pos.y, pos.z].every(Number.isFinite))
              await centerAndFlashMapPos({ x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) });
            button.disabled = false;
            return;
          }
          openPanel(activeInfoPanel || "orders", activeInfoSection || "tasks", activeInfoDetail || "");
        } catch {
          button.disabled = false;
        }
      });
    });
  }

  function renderInfoPanel(data) {
    if ((data.panel || "") === "stocks" || (data.section || "") === "stocks") {
      window.renderStocksPanel(data);
      return;
    }
    activeInfoPanel = data.panel || activeInfoPanel || "citizens";
    activeInfoSection = data.section || activeInfoSection || defaultSectionForPanel(activeInfoPanel);
    activeInfoDetail = data.detail || "";
    // A REAL navigation starts the list at the top; everything else keeps its place. This function is
    // the only thing that changes which list the panel is showing, so the rule is stated once, here.
    const infoNavKey = `${activeInfoPanel}|${activeInfoSection}|${activeInfoDetail}`;
    if (infoNavKey !== window.DFBuildInfoController.lastInfoNavKey) {
      window.DFBuildInfoController.lastInfoNavKey = infoNavKey;
      try { DWFUI.resetList(window.CREATURE_LIST_KEY, document); } catch { globalThis.DwfErr?.count("info-panel.list-reset"); }
    }
    // The server still emits primaryTabs/sectionTabs, but the shared INFO_TABS row supersedes them.
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
    // The Creatures tab has its own row anatomy; every other tab still uses the generic renderInfoRows.
    const isCreatures = (data.panel || "") === "citizens";
    if (isCreatures) {
      window.DFBuildInfoController.creatureRowsRaw = Array.isArray(data.rows) ? data.rows : [];
      window.DFBuildInfoController.creatureTrainers = Array.isArray(data.trainers) ? data.trainers : [];
      // The fortress-wide training-knowledge panel, not a per-animal value.
      window.DFBuildInfoController.creatureTrainingKnowledge = Array.isArray(data.trainingKnowledge) ? data.trainingKnowledge : [];
      // Native builds the bar and its page only under the livestock sub-list, so leaving it pops the page.
      if (activeInfoDetail !== "pets") window.DFBuildInfoController.creatureTrainingPageOpen = false;
      window.DFBuildInfoController.creatureMessageHtml = messageHtml;
      const needsLaborFallback = activeInfoDetail === "residents" && window.DFBuildInfoController.creatureRowsRaw.length > 0 &&
        !Object.prototype.hasOwnProperty.call(window.DFBuildInfoController.creatureRowsRaw[0], "specialized");
      if (needsLaborFallback) window.fetchCreatureLaborFallback();
      else window.DFBuildInfoController.creatureLabor = null;
    } else {
      // Reset the query whenever the section changes, so a Places filter is not still applied on Objects.
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
            ${isCreatures ? `${window.DFBuildInfoController.creatureMessageHtml}${window.creatureRowsHtml()}` : infoBodyHtml()}
          </div>
        </div>`,
      footerHtml: `${isCreatures ? infoSearchInputHtml(window.DFBuildInfoController.creatureSearch) : infoSearchInputHtml(infoSearch, "info-search")}` +
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
      window.wireCreatureBody(clientPanel.querySelector(".info-main"));
      const searchInput = clientPanel.querySelector("[data-creature-search]");
      if (searchInput) searchInput.addEventListener("input", () => {
        window.DFBuildInfoController.creatureSearch = searchInput.value || "";
        window.renderCreatureBody();
        const next = clientPanel.querySelector("[data-creature-search]");
        if (next) { next.focus(); try { next.setSelectionRange(next.value.length, next.value.length); } catch { globalThis.DwfErr?.count("info-panel.creature-search-caret"); } }
      });
      return;
    }
    wireInfoBody(clientPanel);
    // Re-render only .info-main and re-attach the row handlers, so scroll position and the input's own
    // listener survive the keystroke.
    const infoSearchInput = clientPanel.querySelector("[data-info-search]");
    if (infoSearchInput) infoSearchInput.addEventListener("input", () => {
      infoSearch = infoSearchInput.value || "";
      const main = clientPanel.querySelector(".info-main");
      if (main) main.innerHTML = infoBodyHtml();
      wireInfoBody(clientPanel);
      const next = clientPanel.querySelector("[data-info-search]");
      if (next) { next.focus(); try { next.setSelectionRange(next.value.length, next.value.length); } catch { globalThis.DwfErr?.count("info-panel.search-caret"); } }
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
    } catch { globalThis.DwfErr?.count("info-panel.unit-open"); }
  }

  async function openPanel(name, section = null, detail = null) {
    setActiveToolbar(name);
    if (name !== "zone" && typeof zonePalette !== "undefined") {
      zonePalette.hidden = true;
      zoneOverlayEnabled = false;
      zonePreset = null;
      currentZones = [];
      renderZoneOverlay();
    }
    if (name === "stockpile") { toggleStockPalette(); return; }
    if (name === "zone") { toggleZonePalette(); return; }
    if (name === "build") { window.openBuildPanel(); return; }
    if (name === "workorders") { openWorkOrdersPanel(); return; }
    // The alert button opens the native alert box, not a full-screen dashboard.
    if (name === "alerts") { openNotificationsPanel(); return; }
    // Reports is not a toolbar destination: it is reached from the alert box's log icon and the world
    // map's Reports plaque.
    if (name === "reports") { openReportsPanel(); return; }
    if (name === "squads") { openSquadsPanel(); return; }
    if (name === "nobles") { openNoblesPanel(); return; }
    if (name === "justice") { openJusticePanel(); return; }
    if (name === "petitions") { openPetitionsPanel(); return; }
    if (name === "obligations") { openObligationsPanel(); return; }   // client-only aggregate board
    if (name === "kitchen") { openKitchenPanel(); return; }
    if (name === "worldmap") { openWorldMapPanel(); return; }
    window.clearBuildPlacement(false);
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
    // A fresh Stocks open never carries a search: without clearing the leftover query, a reopen renders
    // plain category rows under a stale "Search results" heading with the old term still in the box.
    if (name === "stocks") stocksSearchQuery = "";
    // requestSeq discards any /panel response that is not the most recent request by the time it lands,
    // so a slower earlier fetch cannot stomp a newer tab's render.
    const requestSeq = ++infoPanelRequestSeq;
    clientPanel.className = "visible info-panel";
    // Keep the shared tab row mounted and clickable while this tab's own fetch is in flight.
    panelContent(clientPanel).innerHTML = DWFUI.windowHtml({ primaryTabs: infoTabRowHtml(activeInfoSection), bodyHtml: `<div class="info-body"><div class="info-message">Loading...</div></div>` });
    wireInfoTabRow(clientPanel);
    try {
      const url = `/panel?player=${encodeURIComponent(player)}&panel=${encodeURIComponent(name)}&section=${encodeURIComponent(activeInfoSection)}&detail=${encodeURIComponent(activeInfoDetail)}&t=${Date.now()}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("panel failed");
      const data = await response.json();
      if (requestSeq !== infoPanelRequestSeq) return;
      renderInfoPanel(data);
    } catch {
      if (requestSeq !== infoPanelRequestSeq) return;
      clientPanel.className = "visible info-panel";
      panelContent(clientPanel).innerHTML = DWFUI.windowHtml({ primaryTabs: infoTabRowHtml(activeInfoSection), bodyHtml: `<div class="info-body"><div class="info-message">Panel data unavailable.</div></div>` });
      wireInfoTabRow(clientPanel);
    }
  }

  if (typeof window !== "undefined") Object.assign(window, {
    rowTone, infoRowHasPlaceArt, infoPlaceIconMarkup, infoRowPos, infoRowActions, infoText,
    placeIdentity, placeRowsHtml, infoPlaceDetailWide, renderInfoRows, infoRowSearchText,
    infoFilterRows, infoDetailTabRowHtml, infoSearchInputHtml, openInfoPlace, openUnitById,
    openPanel, renderInfoPanel,
  });

  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, {
    infoDetailTabRowHtml, infoTabRowHtml, infoSearchBoxHtml, infoSearchInputHtml, rowTone,
    infoRowHasPlaceArt, infoPlaceIconMarkup, infoRowPos, infoRowActions, infoText, placeIdentity,
    placeRowsHtml, infoPlaceDetailWide, renderInfoRows, infoRowSearchText, infoFilterRows,
  });
