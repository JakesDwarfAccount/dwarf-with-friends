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

  // DEF-079: the item wire does not serialize a stockpiled BIN's holder, so join ONLY the exact native
  // `<#N>` container marker to the exact `... #N` stockpile row. No match means no row and no dead button.
  const STOCKPILE_TOKEN_BY_INFO_ROW = Object.freeze({
    0: "STOCKPILE_ICON_AMMO", 1: "STOCKPILE_ICON_ANIMALS", 2: "STOCKPILE_ICON_ARMOR",
    3: "STOCKPILE_ICON_BARS", 4: "STOCKPILE_ICON_CLOTH", 5: "STOCKPILE_ICON_COINS",
    6: "STOCKPILE_ICON_FINISHED_GOODS", 7: "STOCKPILE_ICON_FOOD",
    8: "STOCKPILE_ICON_FURNITURE", 9: "STOCKPILE_ICON_GEMS", 10: "STOCKPILE_ICON_LEATHER",
    11: "STOCKPILE_ICON_CORPSES", 12: "STOCKPILE_ICON_REFUSE", 13: "STOCKPILE_ICON_SHEETS",
    15: "STOCKPILE_ICON_STONE", 16: "STOCKPILE_ICON_WEAPONS", 17: "STOCKPILE_ICON_WOOD",
  });
  function stockItemPileNumber(result) {
    const match = /<#(\d+)>/.exec(String(result?.title || ""));
    return match ? Number(match[1]) : -1;
  }
  function resolveStockItemPileLocation(result, places) {
    if (!result || Number(result.locationId ?? -1) >= 0 ||
        result.locationSpriteToken || result.locationSpriteRef) return result;
    const number = stockItemPileNumber(result);
    if (number < 0) return result;
    const rows = Array.isArray(places?.rows) ? places.rows : [];
    const row = rows.find(candidate =>
      String(candidate?.kind || "").toLowerCase() === "stockpile" &&
      Number(candidate?.buildingId ?? -1) >= 0 &&
      new RegExp(`#${number}\\s*$`).test(String(candidate?.name || "")));
    if (!row) return result;
    return Object.assign({}, result, {
      locationId: Number(row.buildingId),
      location: String(row.name || `Stockpile #${number}`),
      locationSpriteToken: STOCKPILE_TOKEN_BY_INFO_ROW[Number(row.iconRow)] || "",
    });
  }
  async function withStockItemPileLocation(result, loadPlaces) {
    if (stockItemPileNumber(result) < 0 || Number(result?.locationId ?? -1) >= 0 ||
        result?.locationSpriteToken || result?.locationSpriteRef) return result;
    try {
      let places;
      if (typeof loadPlaces === "function") places = await loadPlaces();
      else {
        const url = `/panel?player=${encodeURIComponent(player)}&panel=locations&section=places` +
          `&detail=stockpiles&t=${Date.now()}`;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return result;
        places = await response.json();
      }
      return resolveStockItemPileLocation(result, places);
    } catch {
      return result;
    }
  }
  async function showResolvedStockItemSheet(result, opts) {
    showStockItemSheet(await withStockItemPileLocation(result), opts);
  }

  // The read-only "info" action, so opening the panel moves no camera and toggles no flags.
  async function openItemPanel(id, siblings) {
    try {
      const r = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${id}&action=info&t=${Date.now()}`,
        { method: "POST", cache: "no-store" });
      // Co-located loose items become side-tabs on the one sheet, so tabbing between items on a crowded
      // tile never reopens the chooser.
      if (r.ok) {
        await showResolvedStockItemSheet(await r.json(),
          { siblings: Array.isArray(siblings) ? siblings : null });
        return;
      }
    } catch { globalThis.DwfErr?.count("item-panel.open"); }
    closeSelection();
  }

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
  // ---- the native prose sentence ----------------------------------------------------------------
  const QUALITY_ADJECTIVE = {
    "-": "well-crafted",       // the quality marks, in order: "", -, +, *, =, and the sun glyph
    "+": "finely-crafted",     // oracle-pinned (steam barrel-bin contents sheet.png)
    "*": "superior quality",   // oracle-pinned (ITEMSHEET-oracle-native.png)
    "≡": "exceptional",
    "☼": "masterful",
  };
  // The symmetric decoration wrappers DF adds -- forbid, foreign, improvement, wear -- are stripped
  // from the prose name; the TITLE keeps every mark verbatim.
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
    const baseUi = window.dwfuiAccessor();
    // returns. The two chassis owners are named explicitly so the answer-key scanner can see them.
    const ui = baseUi && Object.assign(Object.create(baseUi), {
      headerHtml: config => (typeof DWFUI !== "undefined" && DWFUI
        ? DWFUI.headerHtml(config) : baseUi.headerHtml(config)),
      actionButtonsHtml: (actions, config) => (typeof DWFUI !== "undefined" && DWFUI
        ? DWFUI.actionButtonsHtml(actions, config) : baseUi.actionButtonsHtml(actions, config)),
    });
    const options = opts || {};
    // Prefer an explicit `siblings` option, including an explicit empty list, then the co-located state,
    // so all four recorded situations reach the same rail.
    const siblingSource = Array.isArray(options.siblings) ? options.siblings
      : (Array.isArray(result?.siblings) ? result.siblings : []);
    const siblings = siblingSource.filter(s =>
      s && Number.isFinite(Number(s.id)) && Number(s.id) >= 0);
    const title = result?.title || "Item";
    const lines = Array.isArray(result?.lines) ? result.lines : [];
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
    // The banded tool cluster MUST come from headerHtml({toolRows}): string-writing DWFUI's own
    // structural markup is drift, and ui_drift_guard_test rejects it. The active look is the _ACTIVE sprite.
    const flagTitle = (on, onTitle, offTitle) => (on ? onTitle : offTitle);
    const toolRows = ui ? [
      [
        { sprite: result?.forbidden ? S.forbidOn : S.forbid, active: !!result?.forbidden,
          dataset: { itemToggle: "forbid" },
          title: flagTitle(result?.forbidden, "Unforbid item", "Forbid item") },
        { sprite: result?.dump ? S.dumpOn : S.dump, active: !!result?.dump,
          dataset: { itemToggle: "dump" },
          title: flagTitle(result?.dump, "Cancel dump", "Mark for dumping") },
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
    // Native item sheets own no close X: this variant is Esc-only, so PanelFrame adopts the skin header.
    const header = ui ? ui.headerHtml({
      cls: "stock-item-header",
      icon: ui.iconHtml({ item: result?.spriteRef, cls: "stock-item-glyph", size: 32, alt: title }),
      titleHtml: `<div class="stock-item-title">${escapeHtml(title)}</div>${itemMetaLine(result)}`,
      titleCls: "stock-item-headcopy",
      toolRows,
      close: false,
    }) : "";
    // `chassis:'slab'` is the SHARED slab-plaque variant -- grey fill, green text -- not an item-sheet
    // override, and it has no hover or lit-click state in native.
    const locId = Number(result?.locationId ?? -1);
    const locBtn = ui && Number.isFinite(locId) && locId >= 0
      ? ui.plaqueBtnHtml({ label: "View stockpile", tone: "green", chassis: "slab",
          cls: "stock-item-loc-btn", dataset: { stockItemPlace: locId }, title: "Open this stockpile" })
      : "";
    // The location tile has TWO art channels and they NEVER both apply: `locationSpriteToken` is
    // INTERFACE art for a stockpile sign, `locationSpriteRef` is ITEM art for a container.
    const locToken = typeof result?.locationSpriteToken === "string" ? result.locationSpriteToken : "";
    const isPileRow = locBtn !== "" || locToken !== "";
    // A real pile identity ALWAYS renders the row: this is the pile's only reachable surface from the
    // sheet, so requiring a non-empty label would wire a button and throw away the row it lives in.
    const hasLocationRow = isPileRow || (!!result?.location && !!result?.locationSpriteRef);
    const pileFallbackName = locId >= 0 ? `Stockpile #${locId}` : "";
    // Native prints the BARE pile name, so the wire's "In <name>" prefix is dropped on stockpile rows
    // only; container rows keep the wire text.
    const locName = isPileRow
      ? (String(result?.location || "").replace(/^In /, "") || pileFallbackName)
      : result?.location;
    const locIcon = { cls: "stock-item-loc-icon", size: 30, alt: locName };
    const locationRow = ui && hasLocationRow ? ui.rowHtml({
      cls: "stock-item-loc-row",
      iconCfg: locToken
        ? Object.assign({ sprite: locToken }, locIcon)
        : Object.assign({ item: result?.locationSpriteRef }, locIcon),
      copyCls: "stock-item-loc-copy", labelCls: "stock-item-loc-name", label: locName,
      trailing: locBtn,
    }) : "";
    // The cluster is DWFUI's `preset:'itemActions'`, which is byte-for-byte native's order and gap.
    // ONE ROW PER CONTAINED ITEM STACK: native repeats names and does not aggregate or dedupe.
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
    // No "Contains N" heading and no "(empty)" row: native shows an empty container as an empty area.
    const contentsBlock = contents.length
      ? `<div class="stock-item-contents">${contents.map(contentRow).join("")}</div>` : "";
    // Superset kept: item -> holder/owner navigation is real wire data and exists nowhere else on the sheet.
    const unitBlock = unit ? `
      <div class="stock-item-unit">
        <div>
          <div class="stock-item-label">${holder ? "With" : "Owned by"}</div>
          <div class="stock-item-unit-name">${escapeHtml(unit.name || `Unit ${unit.id}`)}</div>
        </div>
        ${ui.plaqueBtnHtml({ label: "View", tone: "green", chassis: "slab", cls: "stock-item-view-unit",
            dataset: { stockItemUnit: unit.id }, title: "View this unit" })}
      </div>` : "";
    return {
      className: "visible view-sheet-panel stock-item-panel",
      siblings,
      html: `
      <div class="dwfui-view-sheet-frame-owner">${ui.nativeFrameHtml("viewSheet",
        { cls: "dwfui-window-native-frame" })}</div>
      <div class="dwfui-view-sheet-content stock-item-frame">
        <div class="stock-item-sheet">
          ${header}
          <div class="stock-item-body">
            ${description ? `<div class="stock-item-description">${escapeHtml(description)}</div>` : ""}
            ${locationRow}
            ${unitBlock}
            ${contentsBlock}
          </div>
        </div>
      </div>
    ` };
  }

  // Honest item-gone fallback, on the same close-less view-sheet chassis; Esc and right-click dismiss.
  function showStockItemUnavailable() {
    selection.className = "visible view-sheet-panel stock-item-panel";
    panelContent(selection).innerHTML =
      `<div class="dwfui-view-sheet-frame-owner">${DWFUI.nativeFrameHtml("viewSheet",
        { cls: "dwfui-window-native-frame" })}</div>` +
      `<div class="dwfui-view-sheet-content"><h1>Item unavailable</h1></div>`;
  }

  // Re-read the item after a refused mutation: a still-present item repaints to truth, a gone one
  // surfaces the honest unavailable state -- never a silent no-op that leaves a stale sheet up.
  async function reReadStockItemOrUnavailable(id, siblings) {
    try {
      const r = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${id}&action=info&t=${Date.now()}`,
        { method: "POST", cache: "no-store" });
      if (r.ok) { await showResolvedStockItemSheet(await r.json(), { siblings }); return; }
    } catch (_) {}
    showStockItemUnavailable();
  }

  function showStockItemSheet(result, opts) {
    const rendered = stockItemSheetMarkup(result, opts);
    const siblings = rendered.siblings;
    selection.className = rendered.className;
    // Identity stamp for the occupant rail's shown-content guard: the class alone cannot tell WHICH sheet.
    try { selection.dataset.dfcItemId = String(Number(result?.id ?? -1)); } catch { globalThis.DwfErr?.count("item-panel.identity-stamp"); }
    // This sheet already holds art the rail may still be missing on older hosts.
    try {
      if (window.DFTileList && typeof DFTileList.noteOccupantArt === "function") {
        DFTileList.noteOccupantArt("item", Number(result?.id ?? -1), { spriteRef: result?.spriteRef || null });
        if (Number(result?.locationId ?? -1) >= 0 && result?.locationSpriteToken)
          DFTileList.noteOccupantArt("stockpile", Number(result.locationId), { spriteToken: result.locationSpriteToken });
      }
    } catch { globalThis.DwfErr?.count("item-panel.occupant-art"); }
    panelContent(selection).innerHTML = rendered.html;
    // Contained-item actions act on that item, then the container sheet re-fetches: contents-row state
    // is server-blind, so re-read the whole container rather than patch a row.
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
          const response = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${id}&action=${encodeURIComponent(action)}&t=${Date.now()}`,
            { method: "POST", cache: "no-store" });
          if (!response.ok) throw new Error(`contained-item action failed (${response.status})`);
          if (Number.isInteger(containerId) && containerId >= 0) {
            const rr = await fetch(`/stock-item-action?player=${encodeURIComponent(player)}&id=${containerId}&action=info&t=${Date.now()}`,
              { method: "POST", cache: "no-store" });
            if (rr.ok) await showResolvedStockItemSheet(await rr.json(), { siblings });
          }
        } catch (err) { globalThis.DwfOrder.lost("item.contained-action", err, "That contained-item change"); }
        focusPage();
      });
    });
    selection.querySelectorAll("[data-stock-item-place]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(button.dataset.stockItemPlace);
        if (Number.isInteger(id) && id >= 0 && typeof openInfoPlace === "function")
          window.openInfoPlace("stockpile", id);
      });
    });
    selection.querySelectorAll("[data-stock-item-unit]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(button.dataset.stockItemUnit);
        if (Number.isInteger(id) && id >= 0)
          window.openUnitById(id);
      });
    });
    // Toggle then re-render with the new state, keeping the co-located side-tabs across the refresh.
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
          if (r.ok) {
            await showResolvedStockItemSheet(await r.json(), { siblings });
            focusPage();
            return;
          }
        } catch (_) {}
        // The flag write did not take -- another client acted, or the host cannot answer. NEVER swallow
        // it and leave the stale sheet up: re-read the item authoritatively.
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
          if (!r.ok) throw new Error(`item follow action failed (${r.status})`);
          const res = await r.json();
          // The server recomputes `following` after toggling this player's latch, so trust the response
          // verbatim: a client-side toggle guess paints the wrong latch whenever follow state diverged.
          await showResolvedStockItemSheet(res, { siblings });
          if (res.mapPos) flashMapTile(res.mapPos);
        } catch (err) { globalThis.DwfOrder.lost("item.action", err, "That item change"); }
        focusPage();
      });
    }
  }

  if (typeof window !== "undefined") Object.assign(window, {
    stockItemPileNumber, resolveStockItemPileLocation, withStockItemPileLocation, openItemPanel,
    stockItemSheetMarkup, showStockItemSheet, showResolvedStockItemSheet,
  });

  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, {
    stockItemPileNumber, resolveStockItemPileLocation, withStockItemPileLocation, stockItemSheetMarkup,
  });
