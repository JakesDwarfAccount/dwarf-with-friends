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
      // Warm the /attrib cache before the synchronous render, so the "Ordered by" line paints on first open.
      try { if (typeof attribRefresh === "function") await attribRefresh(); } catch { globalThis.DwfErr?.count("stockpile-panel.attribution"); }
      renderStockpilePanel(await r.json());
    } catch {
      // The pile is gone, so its SIDE WINDOWS go too: a client that keeps one up on a dead id is
      // reading exactly the stale pointer native leaves dangling.
      spnCloseStorage(); spnCloseLinks();
      // Keep this family on its compact stockpile host, not the shared view-sheet chassis. CLOSE-LESS
      // BY EVIDENCE: the pile family draws no X -- do not re-add a close affordance here.
      window.setStockpilePanel(`<h1>Stockpile unavailable</h1>`);
    }
  }
  function linkListHtml(items) {
    items = Array.isArray(items) ? items : [];
    if (!items.length) return `<span class="stockpile-pill">None</span>`;
    return items.map(item => `<span class="stockpile-pill" title="${escapeHtml(item.name || "")}">${escapeHtml(item.name || `#${item.id}`)}</span>`).join("");
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
    } catch {
      return null;
    }
  }
  function stockpileMutationSucceeded(results) {
    return (Array.isArray(results) ? results : [results]).some(Boolean);
  }
  const SP_STORAGE_FIELDS = [
    ["barrels", "Max barrels"], ["bins", "Max bins"], ["wheelbarrows", "Max wheelbarrows"],
  ];
  // The three container caps clamp to the pile's LIVE TILE COUNT, so the ceiling MOVES when the pile
  // is repainted: derive it from the served extents bitmap every render, and never cache it.
  function spTileCount(info) {
    const ext = String((info && info.extents) || "");
    if (ext) {
      let n = 0;
      for (let i = 0; i < ext.length; i++) if (ext[i] === "1") n++;
      return n;
    }
    const size = (info && info.size) || null;
    return size ? Math.max(0, (Number(size.w) || 0) * (Number(size.h) || 0)) : 0;
  }
  function spClampStorage(v, cap) {
    const ceiling = Number.isFinite(Number(cap)) && Number(cap) >= 0 ? Math.min(3000, Number(cap)) : 3000;
    return Math.max(0, Math.min(ceiling, Number(v) || 0));
  }
  // Returns a NEW object every call: the clamp is a per-render derivation, never a cached ceiling.
  function spStorageClampedToTiles(storage, cap) {
    const s = storage || {};
    const out = {};
    SP_STORAGE_FIELDS.forEach(([key]) => { out[key] = spClampStorage(s[key], cap); });
    return out;
  }
  function spStorageUrl(id, key, value) {
    return `/stockpile-storage?id=${id}&${key}=${spClampStorage(value)}`;
  }
  // ---- the three storage tiles -----------------------------------------------------------------
  function spStorageRowsHtml(storage) {
    const s = storage || {};
    const S = DWFUI.TOKENS.sprites;
    const tile = (sprite, extraCls, dataset, title) => DWFUI.artBtnHtml({
      sprite, cls: `stockpile-panel-stile${extraCls ? " " + extraCls : ""}`, dataset, title, ariaLabel: title,
    });
    return SP_STORAGE_FIELDS.map(([key, label]) => `<div class="stockpile-storage-row">
        <span class="stockpile-storage-label">${label}</span>
        <span class="stockpile-panel-storval">${spClampStorage(s[key])}</span>
        ${DWFUI.numberEntryHtml({ cls: "stockpile-num-entry", inputCls: "stockpile-num", editing: true,
          value: spClampStorage(s[key]), text: String(spClampStorage(s[key])), min: 0, max: 3000,
          maxLength: 4, ariaLabel: label, dataset: { spStorage: key } })}
        ${tile(S.stepHash, "", { spnHash: key }, `Set ${label.toLowerCase()}`)}
        ${tile(S.stepPlus, "stockpile-step", { spStep: key, delta: 1 }, `Increase ${label.toLowerCase()}`)}
        ${tile(S.stepMinus, "stockpile-step", { spStep: key, delta: -1 }, `Decrease ${label.toLowerCase()}`)}
      </div>`).join("");
  }
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
    } catch {
      return false;
    }
  }
  const SPN_TYPES = [
    // [label, preset key, stockpile_icons.png row] in native's column-major order. Native's type
    // picker draws NO wooden plate, so the row resolves through the SIGNLESS half of the sheet.
    ["All", "all", 19], ["Ammo", "ammo", 1], ["Animals", "animals", 2], ["Armor", "armor", 3],
    ["Bars and Blocks", "bars", 4], ["Cloth", "cloth", 5], ["Coins", "coins", 6], ["Corpses", "corpses", 7],
    ["Finished Goods", "finished", 8], ["Food", "food", 9],
    ["Furniture", "furniture", 10], ["Gem", "gems", 11], ["Leather", "leather", 12], ["Refuse", "refuse", 13],
    ["Sheets", "sheets", 14], ["Stone", "stone", 15], ["Weapons", "weapons", 16], ["Wood", "wood", 17],
    ["None", "none", 0], ["Custom", "custom", 18]
  ];
  // ---- the 20 type tiles ---------------------------------------------------------------------
  function spnTypeGridHtml(groups) {
    const preset = activePresetFromGroups(groups);
    return SPN_TYPES.map(([label, key, iconRow]) => {
      const active = key === "custom" ? preset === "" : stockCatIsActive(groups, key);
      return DWFUI.rowHtml({
        tag: "button",
        chassis: "slab", selected: active, cls: "stockpile-panel-type",
        dataset: { spCat: key },
        title: label,
        icon: `<span class="stockpile-panel-ticon">` +
          DWFUI.iconHtml({ spriteCrop: DWFUI.stockpileIconCrop(iconRow, { signless: true }) }) +
          `</span>`,
        label,
        labelCls: "stockpile-panel-tlab",
      });
    }).join("");
  }

  // ---- the five tool tiles ---------------------------------------------------------------------
  function spnRemoveKey(id) {
    try {
      const gate = window.DwfConfirmGate;
      return gate ? gate.key("stockpile-remove", Number(id)) : "";
    } catch { return ""; }
  }
  function spnRemoveArmedFor(id) {
    try {
      const gate = window.DwfConfirmGate;
      const key = spnRemoveKey(id);
      return !!gate && !!key && gate.isArmed(key);
    } catch { return false; }
  }
  function spnRemovePress(id) {
    try {
      const gate = window.DwfConfirmGate;
      const key = spnRemoveKey(id);
      return gate && key ? gate.press(key) : "armed";
    } catch { return "armed"; }
  }
  function spnToolsHtml(info, armed, removeArmed) {
    const S = DWFUI.TOKENS.sprites;
    const linksOnly = !!(info && info.linksOnly);
    const linksTitle = linksOnly
      ? "Only taking from links (click: take from anywhere)"
      : "Taking from anywhere (click: only take from links)";
    const paintTitle = "Paint more tiles onto this stockpile";
    const removeTitle = removeArmed
      ? "Press again to confirm removing this stockpile"
      : "Remove stockpile";
    return `<div class="stockpile-panel-tools">
            ${DWFUI.latchHtml({
              on: !!armed, sprite: S.spRepaint, cls: `stockpile-panel-tool stockpile-panel-tool-paint${armed ? " armed" : ""}`,
              dataset: { spRepaint: "" }, title: paintTitle, ariaLabel: paintTitle,
            })}
            ${DWFUI.artBtnHtml({
              sprite: S.spRemove, cls: "stockpile-panel-tool stockpile-panel-tool-remove",
              state: removeArmed ? "active" : undefined,
              dataset: { spRemove: "" }, title: removeTitle, ariaLabel: removeTitle,
            })}
            ${DWFUI.latchHtml({
              on: linksOnly, sprite: S.spTakeAnywhere, activeSprite: S.spTakeLinksOnly,
              cls: `stockpile-panel-tool ${linksOnly ? "stockpile-panel-tool-linksfree-off" : "stockpile-panel-tool-linksfree-on"}`,
              dataset: { spLinksOnly: linksOnly ? 0 : 1 }, title: linksTitle, ariaLabel: linksTitle,
            })}
            ${DWFUI.artBtnHtml({
              sprite: S.spConnections, cls: "stockpile-panel-tool stockpile-panel-tool-linkadd",
              dataset: { spnLinksToggle: "" }, title: "Stockpile links (give to / take from)",
              ariaLabel: "Stockpile links (give to / take from)",
            })}
            <span class="stockpile-panel-tool-spacer"></span>
            ${DWFUI.artBtnHtml({
              sprite: S.spToolSettings, cls: "stockpile-panel-tool stockpile-panel-tool-barrel",
              dataset: { spnStorageOpen: "" }, title: "Storage and tools", ariaLabel: "Storage and tools",
            })}
          </div>`;
  }

  // A SUPERSET with no native counterpart, so it is DRESSED NATIVE: the same grey text plaque the
  // give/take pills use. `.stockpile-mode-button` rides through `cls`.
  function spModeRowHtml() {
    return `<div class="stockpile-mode-row">${DWFUI.plaqueBtnHtml({
      label: "Refresh links", cls: "stockpile-mode-button",
      dataset: { spRefreshLinks: "" }, title: "Reload linked buildings",
    })}</div>`;
  }

  // ================================================================================================
  const SPN_SIDE_COLUMNS = 41;      // panel_left+86 - (panel_left+46) = 40, i.e. 41 inclusive
  const SPN_SIDE_TOP_ROW = 4;       // both windows' top y
  const SPN_SIDE_ROWS = { storage: 18, links: 38, linksAdding: 13 };
  // Native's linking window loses 25 rows the moment "adding new link" is armed, and the back-out
  // ordering agrees: cancel the add first, close the window second.
  function spnSideRows(kind, adding) {
    if (kind === "storage") return SPN_SIDE_ROWS.storage;
    return adding ? SPN_SIDE_ROWS.linksAdding : SPN_SIDE_ROWS.links;
  }
  // Dock into the shared slot: right of the pile panel when there is room, mirrored left when not.
  // The pile body is never resized, moved or scrolled by this.
  function spnDockSideWindow(win) {
    if (!win) return;
    try {
      const rect = selection.getBoundingClientRect();
      const w = win.offsetWidth || 376;
      const x = (rect.right + 12 + w <= window.innerWidth) ? rect.right + 12 : Math.max(8, rect.left - 12 - w);
      win.style.left = Math.round(x) + "px";
      win.style.top = Math.round(Math.max(48, rect.top)) + "px";
    } catch { globalThis.DwfErr?.count("stockpile-panel.side-window-dock"); }
  }

  // ---- Storage and tools: native's separate window ----
  let spnStorageId = null;
  let spnStorageCap = 0;            // the live tile count, re-derived on every render
  function spnStorageWin() { return document.getElementById("spStoragePanel"); }
  function spnCloseStorage() {
    const win = spnStorageWin();
    if (win) win.classList.remove("stockpile-panel-sidewin-open");
    spnStorageId = null;
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("spStorage", false); } catch { globalThis.DwfErr?.count("stockpile-panel.storage-close-state"); }
  }
  function spnEnsureStorageWin() {
    let win = spnStorageWin();
    if (win) return win;
    win = document.createElement("div");
    win.id = "spStoragePanel";
    // An occupant of the shared side slot, so it carries the slot class and declares its own row count.
    win.className = "stockpile-panel-storagewin stockpile-panel-sidewin";
    win.dataset.spnSideRows = String(spnSideRows("storage", false));
    win.classList.remove("stockpile-panel-sidewin-open");
    // NOT `sideWindowHtml`: that emits its OWN red Done inside a bar with no cls hook, and would rename
    // the head away from `.stockpile-panel-storagehead`, which this window's PanelFrame registration pins as headSel.
    win.innerHTML = `<div class="stockpile-panel-storagehead"><span class="stockpile-panel-storagetitle">Storage and tools</span>` +
      DWFUI.plaqueBtnHtml({
        label: "Done", tone: "red", cls: "stockpile-panel-done",
        dataset: { spnStorageDone: "" }, title: "Done",
      }) + `</div>` +
      `<div class="stockpile-panel-storrows"></div>`;
    document.body.appendChild(win);
    // Native's close control eats the left button UNCONDITIONALLY, before any hit test, so this listener
    // consumes the event first and never conditions on anything.
    win.querySelector("[data-spn-storage-done]").addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      spnCloseStorage();
    });
    if (window.DFPanelFrame) window.DFPanelFrame.register({
      key: "spStorage", el: () => spnStorageWin(), title: "Storage and tools",
      headSel: ".stockpile-panel-storagehead", closable: false, escClosable: true, persistOpen: false, menu: false,
      isOpen: () => { const n = spnStorageWin(); return !!n && n.classList.contains("stockpile-panel-sidewin-open"); },
      close: () => spnCloseStorage(),
    });
    return win;
  }
  function spnRenderStorage(id, rawStorage, cap) {
    const win = spnEnsureStorageWin();
    // Recompute the ceiling on EVERY render and clamp the three caps to it: the row builder never sees
    // an unclampable value.
    spnStorageCap = Number.isFinite(Number(cap)) ? Number(cap) : spnStorageCap;
    const storage = spStorageClampedToTiles(rawStorage, spnStorageCap);
    win.querySelector(".stockpile-panel-storrows").innerHTML = spStorageRowsHtml(storage);
    // Native applies storage changes immediately: an input change or a stepper click POSTs its own field.
    const saveStorage = async key => {
      const el = win.querySelector(`[data-sp-storage="${key}"]`);
      // Native's increase button increments and then IMMEDIATELY clamps to the tile count; clamping the
      // field before the write reproduces that and keeps the call a plain one-field POST.
      if (el) el.value = spClampStorage(el.value, spnStorageCap);
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
      if (el) el.value = spClampStorage((Number(el.value) || 0) + Number(btn.dataset.delta || 0), spnStorageCap);
      saveStorage(key);
    }));
    // native's # tile = type the number directly: it swaps the value text for the input
    win.querySelectorAll("[data-spn-hash]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const row = btn.closest(".stockpile-storage-row");
      if (!row) return;
      row.classList.add("editing");
      const inp = row.querySelector("[data-sp-storage]");
      if (inp) { inp.focus(); try { inp.select(); } catch { globalThis.DwfErr?.count("stockpile-panel.storage-select"); } }
    }));
  }
  function spnOpenStorage(id, storage, cap) {
    const win = spnEnsureStorageWin();
    spnCloseLinks();                    // one slot, one occupant
    spnStorageId = id;
    spnRenderStorage(id, storage, cap);
    if (!win.classList.contains("stockpile-panel-sidewin-open")) {
      win.classList.add("stockpile-panel-sidewin-open");
      spnDockSideWindow(win);           // the shared 41-column slot, right of the pile body
    }
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("spStorage", true); } catch { globalThis.DwfErr?.count("stockpile-panel.storage-open-state"); }
  }

  // ONE FLAT LIST of all four link kinds -- give/take x pile/workshop -- because native's row count is
  // the SUM of the four vectors. EXCHANGE must not be invented in either direction: DEF-026.
  const SP_LINK_KINDS = [
    // [wire key on /stockpile-info.links, direction, counterparty]
    ["give", "give", "pile"], ["take", "take", "pile"],
    ["giveWorkshops", "give", "workshop"], ["takeWorkshops", "take", "workshop"],
  ];
  // The flat list, in one pass over the four vectors. Its length IS the native row count.
  function spFlatLinkRows(info) {
    const links = (info && info.links) || {};
    const rows = [];
    SP_LINK_KINDS.forEach(([key, direction, counterparty]) => {
      const vec = Array.isArray(links[key]) ? links[key] : [];
      vec.forEach(item => rows.push({
        id: Number(item && item.id), name: String((item && item.name) || ""),
        direction, counterparty,
      }));
    });
    return rows;
  }
  function spLinkRowCount(info) { return spFlatLinkRows(info).length; }
  function spLinkRowHtml(row) {
    const label = row.name || `#${row.id}`;
    const verb = row.direction === "give" ? "Gives to" : "Takes from";
    return DWFUI.rowHtml({
      chassis: "table", cls: `stockpile-link-row stockpile-link-${row.direction} stockpile-link-${row.counterparty}`,
      dataset: { spLinkRow: row.id, spLinkDirection: row.direction, spLinkCounterparty: row.counterparty },
      labelCls: "stockpile-link-name", label,
      title: `${verb} ${label}`,
      sub: { cls: "stockpile-link-meta", text: `${verb} (${row.counterparty})` },
    });
  }
  function spLinkListHtml(info) {
    const rows = spFlatLinkRows(info);
    if (!rows.length) return DWFUI.rowHtml({ chassis: "table", cls: "stockpile-link-row stockpile-link-empty",
      labelCls: "stockpile-link-name", label: "No links" });
    return rows.map(spLinkRowHtml).join("");
  }

  let spnLinksId = null;
  let spnLinksAdding = false;         // native's stockpile_link.adding_new_link
  let spnLinksInfo = null;
  function spnLinksWin() { return document.getElementById("spLinksPanel"); }
  function spnCloseLinks() {
    const win = spnLinksWin();
    if (win) win.classList.remove("stockpile-panel-sidewin-open");
    spnLinksId = null; spnLinksAdding = false; spnLinksInfo = null;
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("spLinks", false); } catch { globalThis.DwfErr?.count("stockpile-panel.links-close-state"); }
  }
  // One Escape while adding backs out of the add, not out of the window.
  function spnLinksBackOut() {
    if (spnLinksAdding) { spnLinksAdding = false; spnRenderLinks(); return true; }
    if (spnLinksWin() && spnLinksWin().classList.contains("stockpile-panel-sidewin-open")) { spnCloseLinks(); return true; }
    return false;
  }
  function spnEnsureLinksWin() {
    let win = spnLinksWin();
    if (win) return win;
    win = document.createElement("div");
    win.id = "spLinksPanel";
    win.className = "stockpile-panel-linkswin stockpile-panel-sidewin";
    win.dataset.spnSideRows = String(spnSideRows("links", false));
    win.classList.remove("stockpile-panel-sidewin-open");
    document.body.appendChild(win);
    win.addEventListener("click", async event => {
      const done = event.target.closest("[data-dwfui-sidewin-done]");
      if (done) { event.preventDefault(); event.stopPropagation(); spnLinksBackOut(); return; }
      const add = event.target.closest("[data-sp-link-add]");
      if (add) { event.stopPropagation(); spnLinksAdding = true; spnRenderLinks(); return; }
      const target = event.target.closest("[data-sp-link-target]");
      if (!target) return;
      event.stopPropagation();
      const id = spnLinksId;
      await postStockpile(`/stockpile-link?id=${id}&target=${Number(target.dataset.spLinkTarget)}` +
        `&mode=${encodeURIComponent(target.dataset.spLinkMode || "give")}&on=${Number(target.dataset.on || 0)}`);
      spnLinksAdding = false;
      openStockpilePanel(id);
    });
    if (window.DFPanelFrame) window.DFPanelFrame.register({
      key: "spLinks", el: () => spnLinksWin(), title: "Stockpile links",
      headSel: ".dwfui-sidewin-bar", closable: false, escClosable: true, persistOpen: false, menu: false,
      isOpen: () => { const n = spnLinksWin(); return !!n && n.classList.contains("stockpile-panel-sidewin-open"); },
      close: () => { spnLinksBackOut(); },
    });
    return win;
  }
  function spnLinksBodyHtml(info, adding) {
    if (!adding) return `${spModeRowHtml()}<div class="stockpile-panel-linklist">${spLinkListHtml(info)}</div>`;
    const targets = Array.isArray(info && info.targets) ? info.targets : [];
    const giveIds = new Set(spFlatLinkRows(info).filter(r => r.direction === "give").map(r => r.id));
    const takeIds = new Set(spFlatLinkRows(info).filter(r => r.direction === "take").map(r => r.id));
    return `<div class="stockpile-panel-linktargets">${targets.length
      ? targets.map(target => spLinkTargetRowHtml(target, giveIds, takeIds)).join("")
      : DWFUI.rowHtml({ chassis: "table", cls: "stockpile-target-row",
          labelCls: "stockpile-target-name", label: "No linkable buildings" })}</div>`;
  }
  function spnRenderLinks() {
    const win = spnEnsureLinksWin();
    const info = spnLinksInfo || {};
    win.dataset.spnSideRows = String(spnSideRows("links", spnLinksAdding));
    win.classList.toggle("adding", !!spnLinksAdding);
    win.innerHTML = DWFUI.sideWindowHtml({
      cls: "stockpile-panel-linkswin-inner", ariaLabel: "Stockpile links",
      tools: spnLinksAdding ? "" : DWFUI.plaqueBtnHtml({
        label: "Add link", cls: "stockpile-link-add-button",
        dataset: { spLinkAdd: "" }, title: "Add a give/take link",
      }),
      done: { label: spnLinksAdding ? "Cancel" : "Done" },
    }, spnLinksBodyHtml(info, spnLinksAdding));
    const id = spnLinksId;
    if (!spnLinksAdding) win.querySelector("[data-sp-refresh-links]").addEventListener("click", event => {
      event.stopPropagation();
      openStockpilePanel(id);
    });
    // No mountDom/paintSprites here: core.js boots the DOM half ONCE with a document-wide observer, and
    // a per-panel sprinkle is the failed fix dwfui_boot_test forbids.
  }
  function spnOpenLinks(info) {
    const win = spnEnsureLinksWin();
    spnCloseStorage();                  // one slot, one occupant
    spnLinksId = info && info.id;
    spnLinksInfo = info;
    spnLinksAdding = false;
    spnRenderLinks();
    if (!win.classList.contains("stockpile-panel-sidewin-open")) {
      win.classList.add("stockpile-panel-sidewin-open");
      spnDockSideWindow(win);
    }
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("spLinks", true); } catch { globalThis.DwfErr?.count("stockpile-panel.links-open-state"); }
  }

  // ---- the title bar ----------------------------------------------------------------------------
  function spnTitlebarHtml(info, display) {
    return DWFUI.headerHtml({
      cls: "stockpile-header stockpile-panel-titlebar",
      titleCls: "stockpile-panel-titlebox",
      titleHtml: DWFUI.rawHtml(
        "the native title line plus the hidden free-text rename input the quill reveals",
        `<div class="stockpile-panel-title" data-spn-title>${escapeHtml(info.name || display)}</div>` +
        DWFUI.textInputHtml({ cls: "stockpile-panel-name stockpile-name", value: info.name || "", placeholder: display, maxLength: 64 })),
      tools: DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.quill, cls: "stockpile-panel-quill",
        dataset: { spRename: "" }, title: "Rename stockpile", ariaLabel: "Rename stockpile",
      }),
      close: false,
    });
  }

  // A SUPERSET (native's stockpile window has no link pane), so it is DRESSED NATIVE, never removed:
  // every dataset, route and `.active` class the handlers read is carried through unchanged.
  function spLinkTargetRowHtml(target, giveIds, takeIds) {
    const tid = Number(target.id);
    const gives = giveIds.has(tid);
    const takes = takeIds.has(tid);
    const meta = `${target.kind || "building"} ${target.pos ? `${target.pos.x},${target.pos.y},${target.pos.z}` : ""}`;
    const modeBtn = (mode, label, on) => DWFUI.plaqueBtnHtml({
      label, tone: on ? "green" : undefined,
      cls: "stockpile-link-button" + (on ? " active" : ""),
      dataset: { spLinkMode: mode, spLinkTarget: tid, on: on ? 0 : 1 },
    });
    return DWFUI.rowHtml({
      chassis: "table", cls: "stockpile-target-row",
      labelCls: "stockpile-target-name", label: target.name || `Building ${tid}`,
      title: target.name || "",
      sub: { cls: "stockpile-target-meta", text: meta },
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
    // The "Ordered by" line, merged from /attrib by stockpile id; openStockpilePanel warms the cache.
    const spOrderedByChip = (typeof attribRowHtml === "function") ? attribRowHtml("stockpile", id) : "";
    const spOrderedByLine = spOrderedByChip ? `<div class="stockpile-sub stockpile-attrib">Ordered by ${spOrderedByChip}</div>` : "";
    // The ceiling for the three container caps is the pile's LIVE tile count, re-derived every render.
    const tileCount = spTileCount(info);
    const removeArmed = spnRemoveArmedFor(id);
    // switching to another stockpile retires the old pile's side windows (stale id otherwise)
    if (spnStorageId != null && spnStorageId !== id) spnCloseStorage();
    if (spnStorageId === id) spnRenderStorage(id, storage, tileCount);
    if (spnLinksId != null && spnLinksId !== id) spnCloseLinks();
    else if (spnLinksId === id) { spnLinksInfo = info; spnRenderLinks(); }
    // Stockpiles have their own compact panel renderer: they must not be wrapped in the shared
    // view-sheet compositor used by the unit, item and building sheet arms.
    window.setStockpilePanel(`
      <div class="stockpile-panel stockpile-native">
        ${spnTitlebarHtml(info, display)}
        <div class="stockpile-panel-gridwrap">
          <div class="stockpile-panel-grid">${spnTypeGridHtml(groups)}</div>
          ${spnToolsHtml(info, stockRepaintId === id, removeArmed)}
        </div>
        <div class="stockpile-panel-caption${removeArmed ? " stockpile-panel-remove-confirm" : ""}">${
          removeArmed
            ? "Press Remove again to confirm -- this cannot be undone."
            : "Click an icon to set stockpile type."
        }</div>
        ${spOrderedByLine}
      </div>
    `);
    // Native's linking window is a side window at the same top and edges as the storage window;
    // neither extends the pile body.
    const doRename = async () => {
      const nm = selection.querySelector(".stockpile-panel-name").value;
      await postStockpile(`/stockpile-rename?id=${id}&name=${encodeURIComponent(nm)}`);
      openStockpilePanel(id);
    };
    // native rename: the quill swaps the title text for a text entry
    selection.querySelector("[data-sp-rename]").addEventListener("click", event => {
      event.stopPropagation();
      const bar = selection.querySelector(".stockpile-panel-titlebar");
      if (!bar.classList.contains("renaming")) {
        bar.classList.add("renaming");
        const inp = selection.querySelector(".stockpile-panel-name");
        inp.focus(); try { inp.select(); } catch { globalThis.DwfErr?.count("stockpile-panel.rename-select"); }
      } else {
        doRename();
      }
    });
    selection.querySelector(".stockpile-panel-name").addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); doRename(); }
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        selection.querySelector(".stockpile-panel-titlebar").classList.remove("renaming");
      }
    });
    selection.querySelectorAll("[data-sp-cat]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const key = b.dataset.spCat || "all";
      if (key === "custom") { window.openSpEditor(id); focusPage(); return; }
      await postStockpile(`/stockpile-set?id=${id}&preset=${encodeURIComponent(key)}&mode=set`);
      openStockpilePanel(id);
    }));
    selection.querySelector("[data-spn-storage-open]").addEventListener("click", event => {
      event.stopPropagation();
      spnOpenStorage(id, storage, tileCount);
    });
    // The connections tile opens the LINKING SIDE WINDOW -- the other occupant of the one slot.
    selection.querySelector("[data-spn-links-toggle]").addEventListener("click", event => {
      event.stopPropagation();
      if (spnLinksId === id && spnLinksWin() && spnLinksWin().classList.contains("stockpile-panel-sidewin-open")) spnCloseLinks();
      else spnOpenLinks(info);
    });
    selection.querySelector("[data-sp-links-only]").addEventListener("click", async event => {
      event.stopPropagation();
      await postStockpile(`/stockpile-links-only?id=${id}&on=${event.currentTarget.dataset.spLinksOnly}`);
      openStockpilePanel(id);
    });
    // Native repaint session, mirroring the zone arm: close the panel, open the staged paint float, and
    // commit only on Accept.
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
      // A stockpile is shared fortress state: the first press only arms a visible confirmation, and only
      // a second press on this exact pile may reach the destructive route.
      if (spnRemovePress(id) !== "commit") {
        renderStockpilePanel(info);
        focusPage();
        return;
      }
      // A failed remove answers HTTP 200 {"ok":false}, so r.ok alone is not proof: confirm the JSON, or
      // RE-READ. The panel closes only on a real removal, never on a silent failure.
      let removed = false;
      try {
        const r = await fetch(`/stockpile-remove?id=${id}`, { method: "POST", cache: "no-store" });
        if (!r.ok) throw new Error(`stockpile removal failed (${r.status})`);
        const d = await r.json().catch(() => ({}));
        removed = !d || d.ok !== false;
        if (!removed) throw new Error(d.error || "stockpile removal failed");
      } catch (err) { globalThis.DwfOrder.lost("stockpile.remove", err, "That stockpile removal"); }
      // The side slot's other occupant goes with the pile too.
      if (removed) spnCloseLinks();
      if (removed) { spnCloseStorage(); closeSelection(); }
      else openStockpilePanel(id);
      focusPage();
    });
  }


  if (typeof window !== "undefined") Object.assign(window, { openStockpilePanel, postStockpile, refreshStockpileSummary, spDisplayName, stockGroupForPreset, stockpileMutationSucceeded });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { activePresetFromGroups, stockGroupForPreset, stockCatIsActive, openStockpilePanel, linkListHtml, flatStockpileLinks, postStockpile, stockpileMutationSucceeded, SP_STORAGE_FIELDS, spTileCount, spClampStorage, spStorageClampedToTiles, spStorageUrl, spStorageRowsHtml, spDisplayName, refreshStockpileSummary, SPN_TYPES, spnTypeGridHtml, spnRemoveKey, spnRemoveArmedFor, spnRemovePress, spnToolsHtml, spModeRowHtml, SPN_SIDE_COLUMNS, SPN_SIDE_TOP_ROW, SPN_SIDE_ROWS, spnSideRows, spnDockSideWindow, spnStorageWin, spnCloseStorage, spnEnsureStorageWin, spnRenderStorage, spnOpenStorage, SP_LINK_KINDS, spFlatLinkRows, spLinkRowCount, spLinkRowHtml, spLinkListHtml, spnLinksWin, spnCloseLinks, spnLinksBackOut, spnEnsureLinksWin, spnLinksBodyHtml, spnRenderLinks, spnOpenLinks, spnTitlebarHtml, spLinkTargetRowHtml, renderStockpilePanel });
