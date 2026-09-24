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

  let lastStocksData = null;
  let stocksSearchTimer = null;
  let stocksSearchRequestSeq = 0;
  // ---- a category body mounts by kind ----------------------------------------------------------
  const STOCKS_PAGE_ROWS = 120;      // ~1.6s at the measured cost -- the whole-pane mount budget
  const STOCKS_GROUP_BATCH = 16;     // rows per animation frame while one kind opens
  let stocksOpenGroups = new Set();  // the kinds the player opened in the pane now on screen
  let stocksOpenScope = "";          // category|query the open set belongs to (a change clears it)
  let stocksGroupSeq = 0;

    // Order is [recenter][view][forbid][dump] gap [hide]; the data-stock-action hooks and the
    // .stocks-item-action* classes are wiring and CSS contracts.
  function stocksActionCluster(item) {
    const ui = window.dwfuiAccessor();
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

  // The server already searches cross-category, so NEVER re-filter its results on the client. It sends
  // the UNDECORATED base name on every search row, so `name` IS the group key.
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

  function stockFlagName(action) {
    return action === "forbid" ? "forbidden" : (action === "dump" || action === "hide" ? action : "");
  }

  function stocksGroupActionCluster(group) {
    const ui = window.dwfuiAccessor();
    if (!ui) return "";
    const S = ui.TOKENS.sprites;
    const items = Array.isArray(group?.items) ? group.items : [];
    const active = flag => items.length > 0 && items.every(item => !!item[flag]);
    return ui.actionButtonsHtml([
      { action: "forbid", sprite: S.forbid, activeSprite: S.forbidOn, active: active("forbidden"),
        dataset: { stockGroupAction: "forbid" }, title: "Forbid / unforbid group" },
      { action: "dump", sprite: S.dump, activeSprite: S.dumpOn, active: active("dump"),
        dataset: { stockGroupAction: "dump" }, title: "Mark / cancel dump for group" },
      { action: "hide", sprite: S.hide, activeSprite: S.hideOn, active: active("hidden"), gapBefore: true,
        dataset: { stockGroupAction: "hide" }, title: "Hide / show group" },
    ], { cls: "stocks-group-actions", btnCls: "stocks-item-action", ariaLabel: "Group actions" });
  }

  function patchStockItemFlags(data, itemId, result) {
    const item = (Array.isArray(data?.stockItems) ? data.stockItems : [])
      .find(candidate => Number(candidate?.itemId) === Number(itemId));
    if (!item || !result) return false;
    item.forbidden = !!result.forbidden;
    item.dump = !!result.dump;
    item.hidden = !!result.hidden;
    return true;
  }

  function stockItemLabel(item) {
    return (window.DwfWireV1 && typeof DwfWireV1.formatItemName === "function")
      ? DwfWireV1.formatItemName(item.name || "", item) : String(item.name || "");
  }
  // Hoisted out of stocksPanelMarkup so a batched mount and a single-row refresh render the SAME row:
  // a second copy of this builder is how a refreshed row silently drifts from a rendered one.
  function stocksItemRowHtml(item) {
    const ui = window.dwfuiAccessor();
    if (!ui) return "";
    const label = stockItemLabel(item);
    const count = Number(item.count || 1) > 1 ? String(item.count) : "";
    return ui.rowHtml({
      cls: "stocks-item-row", chassis: "table", dataset: { stockItemId: item.itemId ?? -1 },
      iconCfg: { item: item.spriteRef, cls: "stocks-item-icon", size: 32, alt: label },
      labelCls: "stocks-item-name",
      label: item.status ? `${label} ${item.status}` : label,
      sub: item.subtitle ? { text: item.subtitle, cls: "stocks-item-subtitle" } : null,
      // An absent count renders NOTHING but the cell stays, so the action cluster cannot slide left.
      cells: [{ cls: "stocks-count", html: escapeHtml(count) }],
      trailing: stocksActionCluster(item),
    });
  }
  // The affordance AND the honest statement of what is not mounted; the count is native's group count.
  function stocksClosedGroupHtml(size) {
    const ui = window.dwfuiAccessor();
    const text = `Show ${size} ${size === 1 ? "item" : "items"}`;
    return `<div class="stocks-detail-line stocks-detail-muted stocks-group-closed">` +
      `${ui ? ui.bitmapTextHtml(text) : escapeHtml(text)}</div>`;
  }
  function stocksLoadingGroupHtml(done, size) {
    const ui = window.dwfuiAccessor();
    const text = `Loading ${done} of ${size}...`;
    return `<div class="stocks-detail-line stocks-detail-muted stocks-group-loading">` +
      `${ui ? ui.bitmapTextHtml(text) : escapeHtml(text)}</div>`;
  }

  function stocksPanelMarkup(data, options) {
    const ui = window.dwfuiAccessor();
    data = data || {};
    const opts = options || {};
    const rows = Array.isArray(data.rows) ? data.rows : [];
    let selectedCategory = opts.activeCategory || data.detail || "";
    const current = rows.find(row => row.job === selectedCategory) || rows[0] || null;
    selectedCategory = current ? (current.job || current.name || "") : "";
    const footer = data.footer || "";
    const selectedCount = current ? (current.status || "None") : "None";
    const query = String(opts.query || "").trim();
    // The server has already applied the query. NO SECOND CLIENT FILTER.
    const stockItems = Array.isArray(data.stockItems) ? data.stockItems : [];
    const openGroups = opts.openGroups instanceof Set ? opts.openGroups : new Set();
    const stockItemRowHtml = stocksItemRowHtml;
    const emptyLine = text => `<div class="stocks-detail-line stocks-detail-muted">${text}</div>`;
    let itemRows;
    let paneStatus = "";
    if (!stockItems.length) {
      // Native shows an empty pane here; we say why it is empty.
      itemRows = emptyLine(query ? "No items match your search." : "No visible items in this category.");
    } else {
      // The group header owns the reduced three-action cluster; members retain the full five-action row.
      const groups = stocksSearchGroups(stockItems);
      // Over budget the kinds render closed: the header, its count, its group actions, and one line
      // saying how many rows it is holding.
      const expandAll = stockItems.length <= STOCKS_PAGE_ROWS;
      itemRows = groups.map(group => {
        const open = expandAll || openGroups.has(group.key);
        return ui.rowGroupHtml({
          cls: `stocks-search-group${open ? "" : " stocks-group-shut"}`,
          dataset: { stockGroup: group.key, stockGroupSize: group.items.length, stockGroupOpen: open ? 1 : 0 },
          header: {
            cls: "stocks-group-head",
            label: group.key,
            count: group.items.length > 1 ? group.items.length : null,
            actionsHtml: stocksGroupActionCluster(group),
          },
          rows: open ? group.items.map(stockItemRowHtml) : [stocksClosedGroupHtml(group.items.length)],
        });
      }).join("");
      if (!expandAll) {
        const shown = groups.reduce((n, g) => n + (openGroups.has(g.key) ? g.items.length : 0), 0);
        paneStatus = `<div class="stocks-detail-line stocks-detail-muted stocks-pane-status">` +
          `${ui.bitmapTextHtml(`${stockItems.length} items in ${groups.length} kinds. ` +
            `Open a kind to list its items${shown ? ` (${shown} listed)` : ""}.`)}</div>`;
      }
    }
    const categoryRows = rows.length ? rows.map(row => {
      const key = row.job || row.name || "";
      const selected = key === selectedCategory ? " selected" : "";
      return `<div class="stocks-row${selected}${row.muted ? " muted" : ""}" data-stock-key="${escapeHtml(key)}"><span>${escapeHtml(row.name || "")}</span><span class="stocks-count">${escapeHtml(row.status || "None")}</span></div>`;
    }).join("") : emptyLine("No stock categories available.");
    const categoryList = ui.scrollHtml({ cls: "stocks-list", rows: ".stocks-row", ariaLabel: "Stock categories" }, categoryRows);
    // A PANE-HEADER search: it spans the top of the list pane it filters, with the magnifier abutting
    // its right edge.
    const search = ui.searchHtml({ cls: "stocks-search-row", inputCls: "stocks-search-box", buttonCls: "stocks-search-button", dataAttr: "stocks-search", placement: "pane-header", preserveKey: "stocks-search", value: query, placeholder: "...", ariaLabel: "Search every stock item", magnifier: true });
    const items = ui.scrollHtml({ cls: "stocks-item-list", rows: ".stocks-item-row", ariaLabel: query ? "Stock search results" : "Items in selected category" }, itemRows);
    const heading = query ? "Search results" : (current ? (current.name || "Stocks") : "Stocks");
    const count = query ? stockItems.length : selectedCount;
    const body = `<div class="stocks-body">${categoryList}<div class="stocks-main">${search}<div class="stocks-detail"><h2>${escapeHtml(heading)}</h2><div class="stocks-detail-line">Count: <strong>${escapeHtml(count)}</strong></div>${paneStatus}${items}</div></div></div>`;
    return { activeCategory: selectedCategory, html: ui.windowHtml({ cls: "stocks-window", ariaLabel: "Stocks", bodyHtml: body, footerHtml: footer ? `<div>${escapeHtml(footer)}</div>` : null }) };
  }

  // `detail` is sent only when there is NO query, because the server discards it whenever `search` is
  // non-empty. On clear, the category fallback stays: the server has no "all items, no query" route.
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
      if (next) { next.focus(); try { next.setSelectionRange(next.value.length, next.value.length); } catch { globalThis.DwfErr?.count("stocks-panel.search-caret"); } }
    } catch { globalThis.DwfErr?.count("stocks-panel.search-refresh"); }
  }

  function stocksGroupMembers(key) {
    return (Array.isArray(lastStocksData?.stockItems) ? lastStocksData.stockItems : [])
      .filter(item => String(item?.name || "") === String(key));
  }

  // Rows mount in bounded frame batches. The token is per-host so opening a second kind cannot cancel
  // the first, and a re-render stops the loop through `isConnected`.
  function stocksMountGroupRows(groupEl) {
    const host = groupEl?.querySelector(".dwfui-group-rows");
    const key = groupEl?.dataset.stockGroup || "";
    if (!host) return;
    const items = stocksGroupMembers(key);
    const token = ++stocksGroupSeq;
    host.__stocksToken = token;
    host.innerHTML = stocksLoadingGroupHtml(0, items.length);
    let offset = 0;
    const schedule = callback => {
      const raf = window.requestAnimationFrame;
      if (typeof raf === "function") raf(callback);
      else window.setTimeout(callback, 0);
    };
    const step = () => {
      if (host.__stocksToken !== token || !host.isConnected) return;
      const end = Math.min(items.length, offset + STOCKS_GROUP_BATCH);
      const marker = host.querySelector(".stocks-group-loading");
      const html = items.slice(offset, end).map(stocksItemRowHtml).join("");
      if (marker) marker.insertAdjacentHTML("beforebegin", html);
      else host.insertAdjacentHTML("beforeend", html);
      offset = end;
      host.querySelectorAll(".stocks-item-row").forEach(stocksBindItemRow);
      if (offset < items.length) {
        if (marker) marker.outerHTML = stocksLoadingGroupHtml(offset, items.length);
        schedule(step);
      } else if (marker) marker.remove();
      stocksUpdatePaneStatus();
    };
    schedule(step);
  }

  function stocksUpdatePaneStatus() {
    const status = clientPanel.querySelector(".stocks-pane-status");
    const ui = window.dwfuiAccessor();
    if (!status || !ui) return;
    const groups = clientPanel.querySelectorAll("[data-stock-group]").length;
    const total = (Array.isArray(lastStocksData?.stockItems) ? lastStocksData.stockItems : []).length;
    const listed = clientPanel.querySelectorAll(".stocks-item-row").length;
    status.innerHTML = ui.bitmapTextHtml(`${total} items in ${groups} kinds. ` +
      `Open a kind to list its items${listed ? ` (${listed} listed)` : ""}.`);
  }

  function stocksToggleGroup(groupEl) {
    const key = groupEl?.dataset.stockGroup || "";
    const host = groupEl?.querySelector(".dwfui-group-rows");
    if (!host) return;
    const open = groupEl.dataset.stockGroupOpen === "1";
    if (open) {
      stocksOpenGroups.delete(key);
      groupEl.dataset.stockGroupOpen = "0";
      groupEl.classList.add("stocks-group-shut");
      host.__stocksToken = ++stocksGroupSeq;         // cancel any in-flight mount
      host.innerHTML = stocksClosedGroupHtml(Number(groupEl.dataset.stockGroupSize) || 0);
      stocksUpdatePaneStatus();
      return;
    }
    stocksOpenGroups.add(key);
    groupEl.dataset.stockGroupOpen = "1";
    groupEl.classList.remove("stocks-group-shut");
    stocksMountGroupRows(groupEl);
  }

  // Replace only the row that was written and re-derive its group header's tri-state cluster: rebuilding
  // the whole pane after every flag write is a multi-second mount on a large category.
  function stocksRefreshItem(itemId) {
    const item = (Array.isArray(lastStocksData?.stockItems) ? lastStocksData.stockItems : [])
      .find(candidate => Number(candidate?.itemId) === Number(itemId));
    const row = clientPanel.querySelector(`.stocks-item-row[data-stock-item-id="${Number(itemId)}"]`);
    if (!item || !row) return false;
    const groupEl = row.closest("[data-stock-group]");
    const fresh = document.createElement("div");
    fresh.innerHTML = stocksItemRowHtml(item);
    const next = fresh.firstElementChild;
    if (!next) return false;
    row.replaceWith(next);
    stocksBindItemRow(next);
    stocksRefreshGroupHeader(groupEl);
    return true;
  }

  function stocksRefreshGroupHeader(groupEl) {
    const actions = groupEl?.querySelector(".stocks-group-actions");
    if (!actions) return;
    const key = groupEl.dataset.stockGroup || "";
    const fresh = document.createElement("div");
    fresh.innerHTML = stocksGroupActionCluster({ key, items: stocksGroupMembers(key) });
    const next = fresh.firstElementChild;
    if (!next) return;
    actions.replaceWith(next);
    stocksBindGroupActions(groupEl);
  }

  async function stocksItemAction(button) {
    const row = button.closest("[data-stock-item-id]");
    const id = Number(row?.dataset.stockItemId ?? -1);
    const action = button.dataset.stockAction || "";
    if (!Number.isInteger(id) || id < 0 || !action) return;
    try {
      const response = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${id}&action=${encodeURIComponent(action)}&t=${Date.now()}`, {
        method: "POST",
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`item action failed (${response.status})`);
      const result = await response.json();
      if (action === "view") {
        closeClientPanel();
        await window.showResolvedStockItemSheet(result);
        if (result.mapPos)
          flashMapTile(result.mapPos);
      }
      if (action === "zoom") {
        closeClientPanel();
        closeSelection();
        if (result.mapPos)
          flashMapTile(result.mapPos);
      }
      if (stockFlagName(action) && patchStockItemFlags(lastStocksData, id, result))
        stocksRefreshItem(id);
    } catch (err) { globalThis.DwfOrder.lost("stocks.item-action", err, "That item change"); }
  }

  async function stocksGroupAction(button) {
    const action = button.dataset.stockGroupAction || "";
    const flag = stockFlagName(action);
    const groupEl = button.closest("[data-stock-group]");
    const groupKey = groupEl?.dataset.stockGroup || "";
    const members = stocksGroupMembers(groupKey);
    if (!flag || !members.length) return;
    const target = !members.every(item => !!item[flag]);
    try {
      // Serialize only the mismatches so CoreSuspender is never fanned out concurrently.
      for (const item of members) {
        if (!!item[flag] === target) continue;
        const id = Number(item.itemId);
        if (!Number.isInteger(id) || id < 0) continue;
        const response = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${id}&action=${encodeURIComponent(action)}&t=${Date.now()}`, {
          method: "POST",
          cache: "no-store"
        });
        if (!response.ok) throw new Error(`group item action failed (${response.status})`);
        if (patchStockItemFlags(lastStocksData, id, await response.json())) stocksRefreshItem(id);
      }
      stocksRefreshGroupHeader(groupEl);
    } catch (err) { globalThis.DwfOrder.lost("stocks.group-action", err, "That group change"); }
  }

  // A batched or replaced row is not covered by a render-time querySelectorAll, so binding is per row.
  function stocksBindItemRow(row) {
    if (!row || row.__stocksBound) return;
    row.__stocksBound = true;
    row.querySelectorAll("[data-stock-action]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        stocksItemAction(button);
      });
    });
  }

  function stocksBindGroupActions(groupEl) {
    groupEl?.querySelectorAll("[data-stock-group-action]").forEach(button => {
      if (button.__stocksBound) return;
      button.__stocksBound = true;
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        stocksGroupAction(button);
      });
    });
  }

  function stocksBindGroup(groupEl) {
    stocksBindGroupActions(groupEl);
    if (groupEl.__stocksToggleBound) return;
    groupEl.__stocksToggleBound = true;
    // The header IS the control: its action tiles stop propagation, so a click anywhere else on it
    // opens and closes the kind.
    const toggle = event => {
      event.preventDefault();
      event.stopPropagation();
      stocksToggleGroup(groupEl);
    };
    groupEl.querySelector(".dwfui-group-head")?.addEventListener("click", toggle);
    groupEl.querySelector(".dwfui-group-rows")?.addEventListener("click", event => {
      if (event.target.closest(".stocks-group-closed")) toggle(event);
    });
  }

  function renderStocksPanel(data) {
    lastStocksData = data;
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("stocks");
    // The open set belongs to ONE pane: a different category or query starts its kinds closed.
    const scope = JSON.stringify([activeStockCategory, stocksSearchQuery]);
    if (scope !== stocksOpenScope) { stocksOpenScope = scope; stocksOpenGroups = new Set(); }
    const rendered = stocksPanelMarkup(data, {
      activeCategory: activeStockCategory, query: stocksSearchQuery, openGroups: stocksOpenGroups,
    });
    activeStockCategory = rendered.activeCategory;
    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = rendered.html;
    // Debounce one backend search rather than fetching per key; clearing the field re-requests the category.
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
        window.openPanel("stocks", "stocks", activeStockCategory);
      });
    });
    clientPanel.querySelectorAll(".stocks-item-row").forEach(stocksBindItemRow);
    clientPanel.querySelectorAll("[data-stock-group]").forEach(stocksBindGroup);
  }

  if (typeof window !== "undefined") Object.assign(window, {
    stocksSearchGroups, stocksGroupActionCluster, patchStockItemFlags, stocksPanelMarkup,
    renderStocksPanel,
  });

  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, {
    stocksSearchGroups, stocksGroupActionCluster, patchStockItemFlags, stocksPanelMarkup,
  });
