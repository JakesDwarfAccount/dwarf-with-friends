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

  // ================================================================================================

  // All three columns share a top, a first row, a 3-row pitch and one visible-row count; the pitch is
  // exactly the height the control art is authored at.
  const SPE_COLUMN_KEYS = ["main_mode", "sub_mode", "spec_item"];
  const SPE_ROW_PITCH = 3;
  const SPE_FIRST_ROW_Y = 9;
  const SPE_COLUMN_TOP_Y = 4;
  const SPE_SCROLLBAR_GUTTER = 2;      // columns, and it shrinks the HIT rect -- not just the paint
  function spePageRows(G) {
    const rows = Math.floor((Number(G) - 16) / SPE_ROW_PITCH);
    return rows > 0 ? rows : 0;
  }
  function speColumnBottomY(G) { return Number(G) - 4; }
  function speRowY(row) { return SPE_FIRST_ROW_Y + Number(row) * SPE_ROW_PITCH; }
  // The WHEEL-HOVER rect is the whole column, header included: wheeling over the header still scrolls
  // that column, and the handler CONSUMES the input.
  function speColumnRect(index, X, R) {
    if (index === 0) return { x0: X, x1: X + 37 };
    if (index === 1) return { x0: X + 39, x1: X + 72 };
    return { x0: X + 74, x1: R };
  }
  // The ROW HIT rect is inset from the column and loses two more columns to the scrollbar gutter, which
  // is CONDITIONAL: it appears only when that column's list is longer than the visible row count.
  function speRowHitRect(index, X, R, overflow) {
    const base = index === 0 ? { x0: X + 2, x1: X + 36 }
      : index === 1 ? { x0: X + 40, x1: X + 71 }
      : { x0: X + 75, x1: R - 2 };
    return overflow ? { x0: base.x0, x1: base.x1 - SPE_SCROLLBAR_GUTTER } : base;
  }
  function speColumnOverflows(len, G) { return Number(len) > spePageRows(G); }
  function speScrollbarTrack(G) {
    return { y0: SPE_FIRST_ROW_Y + 1, y1: SPE_FIRST_ROW_Y + spePageRows(G) * SPE_ROW_PITCH - 2 };
  }
  // Each column's scroll position is clamped against its OWN list length; for column 3 that length is
  // the FILTERED row count, never the raw vector size.
  function speClampScroll(pos, len, G) {
    const max = Math.max(0, Number(len) - spePageRows(G));
    const p = Number(pos) || 0;
    return p < 0 ? 0 : p > max ? max : p;
  }

  // Three calls to the ONE shared list control: the independent scroll positions, the consuming wheel
  // and the conditional gutter are what it does for every caller, not anything stockpile-specific.
  function speColumnListHtml(cls, id, column) {
    return DWFUI.listHtml({
      cls: `stockpile-editor-list ${cls}`,
      id,
      rows: ".stockpile-editor-row, .stockpile-editor-cat",
      key: `spe.${column}`,
      preserveKey: `spe.${column}`,
      dataset: { speColumn: column },
    }, "");
  }

  // ---- R5: THE TOGGLE LAW ----------------------------------------------------------------------
  // Every click is `1 - current`. This is the one function all three columns' write paths go
  // through, so there is exactly one place a three-state cycle could ever be introduced -- and the
  // suites pin that this function's output is always 0 or 1 across the WHOLE input space, PARTIAL
  // included.
  //
  // `current` is the CALLER'S underlying boolean, deliberately: native's four write sites each flip
  // one specific byte, and each of this client's three superset controls has its own answer to
  // "which byte am I summarising?" -- a category summarises its FLAG (so a dashed category is
  // currently on, and flips off), a sub-group summarises its ITEM BITS (so a dashed group is not
  // fully on, and flips on), an item is itself. Passing the derived tri-state straight in would
  // silently pick one of those for all three. What the law owns is the ARITHMETIC: `1 - current`,
  // output always in {0,1}, no third value reachable from any input.
  function speBinaryToggle(current) {
    const on = current === true || current === 1 || current === "1" || current === "all";
    return 1 - (on ? 1 : 0);
  }

  // ---- the tri-state art -----------------------------------------------------------------------
  const SPE_TRI_SPRITE = { all: "STOCKPILE_ON", some: "STOCKPILE_PARTIAL", none: "STOCKPILE_OFF" };
  const SPE_TRI_CLASS = { all: "check", some: "dash", none: "x" };
  const SPE_TRI_CELL = { w: 4, h: 3 };
  function speDataAttrs(dataset) {
    if (!dataset) return "";
    return Object.keys(dataset).map(key =>
      ` data-${key.replace(/[A-Z]/g, m => "-" + m.toLowerCase())}="${escapeHtml(String(dataset[key]))}"`).join("");
  }
  function speTriMarkHtml(state, opts) {
    const kind = SPE_TRI_CLASS[state];
    if (!kind) return "";              // null == pending; r2's no-flash contract, unchanged
    const o = opts || {};
    return `<span class="stockpile-editor-state ${kind} stockpile-editor-tri" data-spe-tri="${state}"${speDataAttrs(o.dataset)}` +
      `${o.title ? ` title="${escapeHtml(o.title)}"` : ""}>` +
      DWFUI.iconHtml({ sprite: SPE_TRI_SPRITE[state], nativeCell: true, cls: "stockpile-editor-tri-art" }) +
      `</span>`;
  }

  // ---- R4 correction: `on` is the FILTER-MATCH flag, and column 3 scrolls FILTERED rows ---------
  // The ledger's loudest correction: `custom_stockpile_itemst.on` is NOT the enabled state -- it is
  // the filter-match / visible flag, and the row loop skips entries with `on` clear BEFORE they
  // consume a display slot. The enabled state lives behind `set_pointer`, and
  // `counted_cur_spec_item_sz` (the count of entries that pass the filter) is what drives the
  // scrollbar and the clamp. "A client that scrolls column 3 by raw index will drift as soon as a
  // filter is typed."
  //
  // AUDITED AGAINST THE DWF WIRE, and the two concepts are already separate here -- but they are
  // separated DIFFERENTLY, so the mapping is written down rather than assumed:
  //   * native `custom_stockpile_itemst.on`  ==  the lua `g.include(raw, i)` predicate in
  //     sp_item_list_on (dwf.lua). Entries that fail it are never put on the wire at all, so the
  //     client's list is ALREADY the filtered list -- there is no client-side equivalent of `on`.
  //   * native `*set_pointer`                ==  the wire's `items[].on`, written by sp_group_get /
  //     stockpile_toggle_item. THIS is the enabled state, and it is what speItemRowHtml paints and
  //     what the toggle flips. The name collision is real and is the trap the ledger warns about.
  //   * `counted_cur_spec_item_sz`           ==  speFilteredItems().length below: the wire list
  //     narrowed by the client's own text filter. Column 3's scroll space is THAT list, which is
  //     why typing in the filter resets the column to its top rather than keeping a raw offset.
  function speFilteredItems(items, search) {
    const q = (search || "").trim();
    return spSortItems(q ? (items || []).filter(it => dfTokenMatch(it.name, q)) : items);
  }
  function speCountedSpecItems(items, search) { return speFilteredItems(items, search).length; }

  // SELECT-CAN-ENABLE is a WIRE GAP, recorded rather than faked (DEF-027): native's category select can
  // turn the category on, and no DWF route does that without also rewriting the item bits.
  const SPE_WIRE_GAPS = [
    {
      id: "select-enables-category",
      ledger: "0076 R3",
      predicate: "select_category_can_enable_it",
      nativeBehaviour: "0x14035e7f0(custom_stockpile*, mode, flag): for a category value, sets " +
        "cur_main_mode/cur_main_mode_flag; then IF the category's bit is clear in the pile's " +
        "settings AND flag != 0, sets the bit (0x14030cb20) and initialises that category's " +
        "parameter block (settings+0x08 / +0x28 / +0x1f8 / ... one per flag bit).",
      clientToday: "category selection is a pure cursor move and issues no request",
      requirement: "A new route POST /stockpile-select-category?id=<pile>&cat=<key> (and the " +
        "hauling-stop twin /hauling-stop-select-category?route=&stop=&cat=) that mirrors the " +
        "primitive EXACTLY: set the category flag ONLY when it is currently clear, then " +
        "initialise that category's parameter block to DF's defaults -- and do NOT import the " +
        "preset library, which /stockpile-set mode=enable does and the native primitive does not. " +
        "It must answer with the same shape as /stockpile-settings-snapshot so the client can " +
        "repaint from one response. The 'additional options' category (stockpile_list 109) has no " +
        "group-set bit and must be a no-op.",
      doNotFake: "Never route selection through /stockpile-set mode=enable: that rewrites the " +
        "category's item bits, which native's selection path does not touch.",
    },
  ];

  // ---- custom stockpile settings editor ------------------------------------------------------
  const SP_EDIT_CATS = [
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
  // Native column-2 labels where the server's differ. Display mapping only: keys and wire requests keep
  // the server vocabulary.
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
  // Column 1 state comes from the category FLAG. groups = /stockpile-info flags map.
  function speCatFlag(flags, key) {
    return !!(flags && flags[window.stockGroupForPreset(key)]);
  }
  // Selection is navigation, never a write: open on the first native row consistently, and let Ammo be
  // selected without being enabled.
  function speDefaultCat() {
    return SP_EDIT_CATS[0][1];
  }
  function speStateFor(agg) {
    return DWFUI.triState.fromAgg(agg);
  }
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
  // Native hides groups with no items in this world; unknown counts stay visible until their aggregate
  // arrives.
  function speVisibleGroups(groups, aggByKey) {
    return (groups || []).filter(g => {
      const agg = aggByKey && aggByKey[g.key];
      return !agg || agg.total > 0;
    });
  }

  // A category change must select a subgroup whose third column is a real item list: a scalar one-entry
  // group merely echoes its own name and produces a false "opened" state.
  function speDefaultGroup(groups, cat, aggregates) {
    const byKey = aggregates || Object.fromEntries((groups || []).map(group =>
      [group.key, speAggCache[speAggKey(cat, group.key)]]));
    const visible = speVisibleGroups(groups, byKey);
    const list = visible.find(group => Math.max(0, Number(byKey[group.key]?.total) || 0) > 1);
    return (list || visible[0])?.key ?? null;
  }
  // Column 3 sorts alphabetically by the DISPLAYED label, so "Prepared toad eye" clusters under P.
  function spSortItems(items) {
    return (Array.isArray(items) ? items.slice() : []).sort((a, b) =>
      window.spDisplayName(a && a.name).localeCompare(window.spDisplayName(b && b.name), "en", { sensitivity: "base" })
      || (Number(a && a.idx) - Number(b && b.idx)));
  }
  function speStateClass(state) {
    return state === "none" ? "off" : state === "some" ? "some" : state === "all" ? "on" : "pending";
  }
  // ---- the settings editor's row builders -------------------------------------------------------
  function speCatRowHtml(label, key, iconRow, state, selected) {
    const row = {
      tag: "button",
      cls: `stockpile-editor-row stockpile-editor-cat ${speStateClass(state)}${selected ? " sel" : ""}`,
      chassis: "slab", state: speStateClass(state), selected,
      dataset: { speCat: key },
      // The category plaque, addressed by SP_EDIT_CATS' own sheet-row column.
      icon: DWFUI.iconHtml({
        spriteCrop: DWFUI.stockpileIconCrop((SP_EDIT_CATS[iconRow] || [])[2]),
        cls: "stockpile-editor-cicon",
      }),
      copyCls: "stockpile-editor-copy", labelCls: "stockpile-editor-lab", label,
      // The mark is a SUMMARY drawn from DF's own three-state art; the click below is a binary flip,
      // never a step through a three-state cycle.
      trailing: speTriMarkHtml(state, {
        dataset: { speCatToggle: key },
        title: `${state === "none" ? "Allow" : "Disallow"} ${label}`,
      }),
    };
    if (label === "Furniture/siege ammo") {
      row.labelHtml = DWFUI.rawHtml(
        "Native's longest stockpile category uses a reduced bitmap-text scale to clear its state cell.",
        DWFUI.bitmapTextHtml(label, { cls: "stockpile-editor-long-cat-label", scale: 0.8 }));
    }
    return DWFUI.rowHtml(row);
  }
  function speGroupRowHtml(label, key, state, selected, singleEntry) {
    // A single-entry group renders no MARK when on -- native's plain green block -- but the ROW must
    // still paint green, so its own state class is untouched.
    const markState = (state === "all" && singleEntry) ? null : state;
    return DWFUI.rowHtml({
      tag: "button",
      cls: `stockpile-editor-row stockpile-editor-group ${speStateClass(state)}${selected ? " sel" : ""}`,
      chassis: "slab", state: speStateClass(state), selected,
      dataset: { speGroup: key },
      copyCls: "stockpile-editor-copy", labelCls: "stockpile-editor-lab", label,
      trailing: speTriMarkHtml(markState, {
        dataset: { speGroupToggle: key },
        title: `Toggle everything in ${label}`,
      }),
    });
  }
  // Every row's state comes straight from the aggregate map: known rows paint final, unknown stateless.
  function speGroupsListHtml(cat, groups, aggByKey, selectedKey) {
    if (!groups || !groups.length) return `<div class="stockpile-note">Loading...</div>`;
    return speVisibleGroups(groups, aggByKey).map(g => {
      const agg = aggByKey && aggByKey[g.key];
      return speGroupRowHtml(spGroupLabel(cat, g.key, g.label), g.key,
        speStateFor(agg), selectedKey === g.key, !!(agg && agg.total === 1));
    }).join("");
  }
  // Window-scale parity constants.
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
      cls: `stockpile-editor-row stockpile-editor-item ${it.on ? "on" : "off"}`,
      chassis: "slab", state: it.on ? "on" : "off",
      dataset: { speItem: it.idx, on: it.on ? 0 : 1 },
      copyCls: "stockpile-editor-copy", labelCls: "stockpile-editor-lab",
      label: window.spDisplayName(it.name),
    });
  }
  function speItemsHtml(items, search) {
    // The VISIBLE list is column 3's whole index space: both the render and the scroll clamp read
    // speFilteredItems, so they cannot disagree.
    const q = (search || "").trim();
    const visible = speFilteredItems(items, search);
    return visible.length ? visible.map(speItemRowHtml).join("")
      : `<div class="stockpile-note">${q ? "No matches." : "No items."}</div>`;
  }

  let spEditId = null, spEditCat = null, spEditGroup = null;
  let spGroupsCache = [], spItemsCache = [], spItemSearch = "";

  // ---- the editor's subject -------------------------------------------------------------------
  let spEditTarget = null;      // {kind:"pile", id} | {kind:"stop", routeId, stopId}
  let spEditOnChange = null;    // caller's post-mutation hook (the hauling panel re-reads its rows)

  const speIsStop = () => !!spEditTarget && spEditTarget.kind === "stop";
  function speTargetQuery() {
    if (!spEditTarget) return "";
    return speIsStop()
      ? `route=${spEditTarget.routeId}&stop=${spEditTarget.stopId}`
      : `id=${spEditTarget.id}`;
  }
  // The two families differ only in prefix and in the preset verb, which is spelled out, not guessed at.
  function speUrl(action, extra) {
    const prefix = speIsStop() ? "/hauling-stop-" : "/stockpile-";
    const verb = action === "preset" ? (speIsStop() ? "preset" : "set") : action;
    return `${prefix}${verb}?${speTargetQuery()}${extra ? "&" + extra : ""}`;
  }
  // A stop has no building row to refresh, and no /stockpile-info; it gets its caller's hook.
  async function speRefreshSubject() {
    if (speIsStop()) { if (typeof spEditOnChange === "function") await spEditOnChange(); return; }
    await window.refreshStockpileSummary(spEditId);
  }
  let speFlagsCache = null;        // category flag map from /stockpile-info; null = NOT FETCHED
                                   // (null renders stateless; {} would falsely paint all-X)
  let spGroupsByCat = {};          // cat -> /stockpile-cat-groups list (world-static, never per-pile)
  let speAggCache = {};            // `${cat}|${group}` -> {on,total}
  let speItemsByGroup = {};        // `${cat}|${group}` -> items[] (server order; sorted at render)
  let speSeq = 0;                  // open/reload sequence -- stale async loads drop their results

  function speAggKey(cat, group) { return `${cat}|${group || ""}`; }
  function spePanel() { return document.getElementById("spEditorPanel"); }
  function speBackOutSurface(editorOpen, selectionOpen) {
    return editorOpen ? "settings" : selectionOpen ? "selection" : null;
  }
  function speSelectionBackOutLevel(editorFirst) {
    return {
      // Reuse the declared rung instead of adding a second Escape owner: while the editor is open it
      // temporarily outranks the underlying sheet, and closeSpEditor restores the ordinary depth.
      id: "selection-sheet", flow: "camera-selection", depth: editorFirst ? 25 : 10,
      active: () => !!speBackOutSurface(
        !!(spePanel() && spePanel().classList.contains("stockpile-editor-panel-open")),
        !!(selection && selection.classList.contains("visible"))),
      pop: () => {
        const surface = speBackOutSurface(
          !!(spePanel() && spePanel().classList.contains("stockpile-editor-panel-open")),
          !!(selection && selection.classList.contains("visible")));
        if (surface === "settings") closeSpEditor();
        else if (surface === "selection") closeSelection();
        else return false;
        return true;
      },
    };
  }
  function speRegisterSelectionBackOut(editorFirst) {
    try {
      if (window.DwfModeStack) window.DwfModeStack.register(speSelectionBackOutLevel(!!editorFirst));
    } catch { globalThis.DwfErr?.count("stockpile-settings.mode-register"); }
  }
  function speColumnPlaqueHtml(column, on, title) {
    return DWFUI.artBtnHtml({
      art: on ? "plaqueAll" : "plaqueNone", cls: `stockpile-editor-plaque stockpile-editor-plaque-${on ? "all" : "none"}`,
      dataset: { speColumnAll: column, speOn: on ? 1 : 0 }, title, ariaLabel: title,
    });
  }
  function wireSpeColumnPlaque(button, activate) {
    button.addEventListener("click", async event => {
      event.stopPropagation();
      await activate(button.dataset.speColumnAll, button.dataset.speOn === "1");
    });
  }

  function closeSpEditor(returnToSubject = true) {
    speSeq++;
    const returnPileId = returnToSubject && !speIsStop() ? spEditId : null;
    const el = spePanel();
    if (el && el.classList.contains("stockpile-editor-panel-open")) {
      el.classList.remove("stockpile-editor-panel-open");
      try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("spEditor", false); } catch { globalThis.DwfErr?.count("stockpile-settings.close-state"); }
    }
    if (el) el.remove();
    speRegisterSelectionBackOut(false);
    // Restore the pile only after the framework's one Escape/right-click path has closed this surface.
    if (returnPileId != null && typeof window.openStockpilePanel === "function")
      window.openStockpilePanel(Number(returnPileId));
  }

  // NEVER keep a stale editor up re-rendering the optimistic cache: close it and route to the
  // authoritative truth -- the pile's own panel, or the caller's re-read hook for a hauling stop.
  function speSurfaceUnavailable() {
    const wasStop = speIsStop();
    const pileId = spEditId;
    const onChange = spEditOnChange;
    closeSpEditor(false);
    if (wasStop) { if (typeof onChange === "function") onChange(); }
    else if (pileId != null) window.openStockpilePanel(pileId);
    try { if (typeof focusPage === "function") focusPage(); } catch { globalThis.DwfErr?.count("stockpile-settings.focus-return"); }
  }

  function speEnsureShell() {
    let el = spePanel();
    if (el) return el;
    el = document.createElement("div");
    el.id = "spEditorPanel";
    el.className = "stockpile-editor-panel";
    el.classList.remove("stockpile-editor-panel-open");
    const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
    const fit = speDefaultPanelSize(vw, vh);
    const w = Math.min(fit.w, vw - 16), h = Math.min(fit.h, vh - 44);
    el.style.width = w + "px"; el.style.height = h + "px";
    el.style.left = Math.max(8, Math.round((vw - w) / 2)) + "px";
    el.style.top = Math.max(28, Math.round((vh - h) / 2)) + "px";
    el.innerHTML = `
      <div class="stockpile-editor-body">
        <div class="stockpile-editor-cols">
          <div class="stockpile-editor-bar">
            ${speColumnPlaqueHtml("categories", true, "Allow every category")}
            ${speColumnPlaqueHtml("categories", false, "Disallow every category")}
            <span class="stockpile-editor-orgtiles">
              ${DWFUI.iconHtml({ spriteCrop: "stockpileOrganicOn", cls: "stockpile-editor-orgtile stockpile-editor-org-plant",
                title: "Allow organic materials (native toggle; state not wired yet)" })}
              ${DWFUI.iconHtml({ spriteCrop: "stockpileInorganicOn", cls: "stockpile-editor-orgtile stockpile-editor-org-ingot",
                title: "Allow inorganic materials (native toggle; state not wired yet)" })}
            </span>
          </div>
          <div class="stockpile-editor-bar">
            ${speColumnPlaqueHtml("groups", true, "Enable everything in this category")}
            ${speColumnPlaqueHtml("groups", false, "Disable everything in this category")}
          </div>
          <div class="stockpile-editor-bar">
            ${speColumnPlaqueHtml("items", true, "Enable every item in this list")}
            ${speColumnPlaqueHtml("items", false, "Disable every item in this list")}
            ${DWFUI.searchHtml({ cls: "stockpile-editor-search-box", inputCls: "stockpile-editor-search", id: "speSearch",
              placeholder: "---", magnifier: true, ariaLabel: "Filter items" })}
          </div>
          ${speColumnListHtml("stockpile-editor-cats", "speCats", "main_mode")}
          ${speColumnListHtml("stockpile-editor-groups", "speGroups", "sub_mode")}
          ${speColumnListHtml("stockpile-editor-items", "speItems", "spec_item")}
        </div>
      </div>`;
    document.body.appendChild(el);
    // `--spe-zoom` tracks the panel's actual size, user resizes included, so the window proportions hold.
    const applyZoom = () => {
      const pw = el.offsetWidth, ph = el.offsetHeight;
      if (pw && ph) el.style.setProperty("--spe-zoom", speZoomFor(pw, ph).toFixed(4));
    };
    applyZoom();
    try { new ResizeObserver(applyZoom).observe(el); } catch { globalThis.DwfErr?.count("stockpile-settings.resize-observer"); }
    el.querySelectorAll("[data-spe-column-all]").forEach(b =>
      wireSpeColumnPlaque(b, toggleSpEditorColumn));
    // Native's header and list are ONE container, so the wheel fires on the whole column rect. Here they
    // are two grid items, so the header's wheel is forwarded to that column's control by hand.
    DWFUI.mountLists(el);
    [...el.querySelectorAll(".stockpile-editor-bar")].forEach((bar, i) => {
      const host = el.querySelectorAll("[data-dwfui-list]")[i];
      if (!bar || !host) return;
      bar.addEventListener("wheel", event => {
        host.dispatchEvent(new WheelEvent("wheel", { deltaY: event.deltaY, shiftKey: event.shiftKey,
          bubbles: false, cancelable: true }));
        event.preventDefault();
        event.stopPropagation();
      }, { passive: false });
    });
    // the search input is part of the persistent shell, so typing never loses focus to a re-render
    const s = el.querySelector("#speSearch");
    s.addEventListener("input", () => {
      spItemSearch = s.value || "";
      renderSpeItems();
      // Column 3's scroll space is the FILTERED row count, so a retained position points at a different
      // entry after the filter changes. Ask for the reset by name rather than relying on an incidental one.
      DWFUI.resetList("spe.spec_item", el);
    });
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
        // A sub-group summarises its ITEM BITS, so only a FULL group is currently on; a dashed group flips on.
        const agg = speAggCache[speAggKey(spEditCat, t.dataset.speGroupToggle)];
        toggleSpeGroup(t.dataset.speGroupToggle, speBinaryToggle(speStateFor(agg) === "all") === 1);
        return;
      }
      const row = e.target.closest("[data-spe-group]");
      if (row) {
        e.stopPropagation();
        spEditGroup = row.dataset.speGroup; speSetSearch("");
        // Pull the remembered items SYNCHRONOUSLY, or an already-cached group paints the previous group's items.
        spItemsCache = speItemsByGroup[speAggKey(spEditCat, spEditGroup)] || [];
        renderSpeGroups(); renderSpeItems();
        if (!speItemsByGroup[speAggKey(spEditCat, spEditGroup)]) speLoadSelectedItems(speSeq);
      }
    });
    el.querySelector("#speItems").addEventListener("click", async e => {
      const b = e.target.closest("[data-spe-item]");
      if (!b) return;
      e.stopPropagation();
      // The row already carries the flipped value in its dataset; it still goes through the one toggle law
      // so the whole family has a single derivation.
      const idx = b.dataset.speItem;
      const on = String(speBinaryToggle(String(b.dataset.on) === "0"));
      const updated = await window.postStockpile(speUrl("toggle-item", `cat=${encodeURIComponent(spEditCat)}&group=${encodeURIComponent(spEditGroup || "")}&idx=${idx}&on=${on}`));
      const items = speItemsByGroup[speAggKey(spEditCat, spEditGroup)] || [];
      const it = items.find(x => String(x.idx) === String(idx));
      // The write was refused -- another client changed this pile, or the host cannot answer. NEVER fall
      // through and re-render the optimistic cache as if the toggle stuck.
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
    // UI-DIV-004 grants surface dragging and a remembered position, not manufactured chrome: native's
    // first row is the plaque row, so this registration is chromeless and Escape is its only close.
    if (window.DFPanelFrame) window.DFPanelFrame.register({
      key: "spEditor", el: () => spePanel(), title: "Item filters",
      chromeless: true, closable: false, escClosable: true, persistOpen: false, menu: false,
      resizable: { minW: 760, minH: 420 },
      isOpen: () => { const n = spePanel(); return !!n && n.classList.contains("stockpile-editor-panel-open"); },
      open: () => { const n = spePanel(); if (n && spEditTarget != null) n.classList.add("stockpile-editor-panel-open"); },
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
    el.setAttribute("aria-label", target.kind === "stop"
      ? "Hauling stop desired items" : "Stockpile item filters");
    spEditId = target.kind === "pile" ? target.id : null;
    spEditOnChange = onChange || null;
    spEditCat = null; spEditGroup = null;
    spGroupsCache = []; spItemsCache = [];
    speFlagsCache = null; speAggCache = {}; speItemsByGroup = {};  // flags UNKNOWN, not all-off
    speSetSearch("");
    speRegisterSelectionBackOut(true);
    // The editor replaces the pile sheet while open, so the hidden selection-sheet rung cannot steal
    // Escape before PanelFrame closes the topmost editor.
    if (target.kind === "pile" && typeof selection !== "undefined")
      selection.classList.remove("visible");
    el.classList.add("stockpile-editor-panel-open");
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("spEditor", true); } catch { globalThis.DwfErr?.count("stockpile-settings.open-state"); }
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

  // The hauling panel's "Choose items" on a stop: same editor, pointed at the stop's settings.
  function openSpEditorForHaulingStop(routeId, stopId, onChange) {
    openSpEditorFor({ kind: "stop", routeId: Number(routeId), stopId: Number(stopId) }, onChange);
  }

  // The one hook the hauling panel uses to hand a stop to this editor, the same shape DFWsLink uses.
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
        flags[window.stockGroupForPreset(key)] = !!cat.enabled;
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
    } catch { return false; }
  }

  async function speFetchFlags() {
    try {
      // A hauling stop is not a building, so its per-category bits ride on the settings snapshot -- the
      // same 17 flags from the same stockpile_settings.
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
          if (key) flags[window.stockGroupForPreset(key)] = !!cat.enabled;
        });
        speFlagsCache = flags;
        return;
      }
      speFlagsCache = d.groups || {};
    } catch { if (!speFlagsCache) speFlagsCache = {}; }
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
    } catch { return null; }
  }

  async function speLoadSelectedItems(seq) {
    const el = document.getElementById("speItems");
    if (el && !speItemsByGroup[speAggKey(spEditCat, spEditGroup)])
      el.innerHTML = `<div class="stockpile-note">Loading...</div>`;
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
      spEditGroup = speDefaultGroup(spGroupsCache, cat);
      spItemsCache = (spEditGroup != null && speItemsByGroup[speAggKey(cat, spEditGroup)]) || [];
    };
    // NO-FLASH CONTRACT: selection paints the remembered state SYNCHRONOUSLY from the caches, with no
    // await between picking the category and this render.
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

  // Direction follows the DISPLAYED derived state: clicking the X on a flag-on-but-all-off category must
  // ALLOW. /stockpile-set imports the preset library, so its caches are dropped and refetched.
  async function toggleSpeCategory(key) {
    // 0076 R5: the two lines below ARE `1 - current`, written out. A category's underlying boolean
    // is its FLAG, and X is the only displayed state meaning "this flag stores nothing" -- so
    // `!flag` and `state === "none"` are each exactly speBinaryToggle(current) === 1 for their
    // respective `current`. The pair must stay adjacent and verbatim (b151_parity_test pins the
    // exact text); stockpile_family_0076_test pins them EQUAL to the law across the whole input
    // space, so the shipped expression and the law cannot drift apart silently.
    const state = speCatDerivedState(speFlagsCache ? speCatFlag(speFlagsCache, key) : null, speCatAggs(key));
    const enable = state == null ? !speCatFlag(speFlagsCache, key) : state === "none";
    await window.postStockpile(speUrl("preset", `preset=${encodeURIComponent(key)}&mode=${enable ? "enable" : "disable"}`));
    speDropCatCaches(key);
    if (key === spEditCat) {
      spItemsCache = [];
      const seq = speSeq;
      const ok = await speFetchSnapshot(seq);
      if (seq !== speSeq) return;
      // The snapshot re-fetch failed after the preset write: route to the honest unavailable state rather
      // than continuing to render the stale cache.
      if (!ok) { speSurfaceUnavailable(); return; }
      await loadSpGroups(spEditCat);
      await speRefreshSubject();
      return;
    }
    await speAfterMutation();
  }

  // Column-2 state icon click: toggle one whole sub-group (native's middle-column check).
  async function toggleSpeGroup(groupKey, on) {
    const updated = await window.postStockpile(spToggleAllUrl(spEditCat, groupKey, on));
    if (updated) {
      const k = speAggKey(spEditCat, groupKey);
      const items = speItemsByGroup[k];
      if (items) { items.forEach(it => { it.on = !!on; }); speAggCache[k] = { on: on ? items.length : 0, total: items.length }; }
      else delete speAggCache[k];
    }
    await speAfterMutation();
  }

  // Categories map to the preset routes (one call flips every flag); groups fan out one toggle-all per
  // sub-group of the open category; items act on the selected sub-group only.
  async function toggleSpEditorColumn(column, on) {
    if (spEditTarget == null) return;
    if (column === "categories") {
      await window.postStockpile(speUrl("preset", `preset=${on ? "all" : "none"}&mode=set`));
      if (on) {
        // Preset-all sets every bit on: transform the caches instead of dropping them, so the repaint is
        // instant and final; unknown groups stay pending until pumped.
        Object.keys(speItemsByGroup).forEach(k => speItemsByGroup[k].forEach(it => { it.on = true; }));
        Object.keys(speAggCache).forEach(k => { speAggCache[k] = { on: speAggCache[k].total, total: speAggCache[k].total }; });
        spItemsCache = (spEditGroup != null && speItemsByGroup[speAggKey(spEditCat, spEditGroup)]) || spItemsCache;
      }
      // preset none only clears the flags (bits stay), so item caches remain valid
    } else if (column === "groups") {
      const groups = spGroupsCache.length ? spGroupsCache : [{ key: "" }];
      const results = await Promise.all(groups.map(group => window.postStockpile(spToggleAllUrl(spEditCat, group.key || "", on))));
      if (window.stockpileMutationSucceeded(results)) {
        groups.forEach(g => {
          const k = speAggKey(spEditCat, g.key || "");
          const items = speItemsByGroup[k];
          if (items) { items.forEach(it => { it.on = !!on; }); speAggCache[k] = { on: on ? items.length : 0, total: items.length }; }
          else delete speAggCache[k];
        });
      }
    } else {
      const updated = await window.postStockpile(spToggleAllUrl(spEditCat, spEditGroup || "", on));
      if (updated) {
        const k = speAggKey(spEditCat, spEditGroup);
        const items = speItemsByGroup[k];
        if (items) { items.forEach(it => { it.on = !!on; }); speAggCache[k] = { on: on ? items.length : 0, total: items.length }; }
      }
    }
    await speAfterMutation();
  }

  // One agg per sub-group, null until the group list or any group's bits are known -- the row is pending.
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


  if (typeof window !== "undefined") Object.assign(window, { openSpEditor });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { SPE_COLUMN_KEYS, SPE_ROW_PITCH, SPE_FIRST_ROW_Y, SPE_COLUMN_TOP_Y, SPE_SCROLLBAR_GUTTER, spePageRows, speColumnBottomY, speRowY, speColumnRect, speRowHitRect, speColumnOverflows, speScrollbarTrack, speClampScroll, speColumnListHtml, speBinaryToggle, SPE_TRI_SPRITE, SPE_TRI_CLASS, SPE_TRI_CELL, speDataAttrs, speTriMarkHtml, speFilteredItems, speCountedSpecItems, SPE_WIRE_GAPS, SP_EDIT_CATS, SP_NATIVE_GROUP_LABELS, spGroupLabel, speCatFlag, speDefaultCat, speStateFor, speCatDerivedState, speVisibleGroups, speDefaultGroup, spSortItems, speStateClass, speCatRowHtml, speGroupRowHtml, speGroupsListHtml, SPE_NATIVE, SPE_BASE, speDefaultPanelSize, speZoomFor, speItemRowHtml, speItemsHtml, speIsStop, speTargetQuery, speUrl, speRefreshSubject, speAggKey, spePanel, speBackOutSurface, speSelectionBackOutLevel, speRegisterSelectionBackOut, speColumnPlaqueHtml, wireSpeColumnPlaque, closeSpEditor, speSurfaceUnavailable, speEnsureShell, speSetSearch, openSpEditorFor, openSpEditor, openSpEditorForHaulingStop, speFetchSnapshot, speFetchFlags, speFetchGroupItems, speLoadSelectedItems, loadSpGroups, spToggleAllUrl, speDropCatCaches, speAfterMutation, toggleSpeCategory, toggleSpeGroup, toggleSpEditorColumn, speCatAggs, renderSpeCats, renderSpeGroups, renderSpeItems, renderSpeAll });
