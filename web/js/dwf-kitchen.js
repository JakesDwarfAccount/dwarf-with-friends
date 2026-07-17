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

  // WS3 Kitchen / food prefs panel. Lists seed-bearing plants and lets you allow
  // or forbid cooking their seeds (the classic "stop cooking my planting stock"
  // control). Reads /kitchen, toggles /kitchen-toggle.
  let kitchenData = null;
  let kitchenFilter = "";
  let kitchenTypeFilter = "";   // W6 `< All >` cycler: "" == All, else an item `category`
  let kitchenSort = "type";     // W7a sort header: the active column key
  // W8 column mass-toggle: per-column "hide this column's CANNOT (grey) rows". A VIEW filter only --
  // see kitchenMassToggleHtml. Never sent to the server, never written back onto a row.
  let kitchenHideCannot = { cook: false, brew: false };

  // Kitchen is a production DWFUI consumer. The app-level startup contract guarantees these
  // builders exist before any surface script runs; this declaration also records live usage for
  // diagnostics without making the offline module fixture depend on a browser window.
  if (typeof DWFUI !== "undefined") DWFUI.require("labor-kitchen",
    ["searchHtml", "scrollHtml", "rowHtml", "latchHtml", "iconHtml", "sortHeaderHtml", "artBtnHtml", "cyclerHtml"]);

  async function openKitchenPanel() {
    setActiveToolbar("kitchen");
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    fortLoadingShell("Kitchen");
    await refreshKitchen();
  }

  async function refreshKitchen() {
    try {
      kitchenData = await fortFetchJson(`/kitchen?player=${encodeURIComponent(player)}&t=${Date.now()}`);
    } catch (err) {
      kitchenData = { error: err.message || "unavailable" };
    }
    renderKitchenPanel();
  }

  // ---- WAVE 4 / S3: THE KITCHEN CELL IS A TRI-STATE, NOT A BOOLEAN --------------------------------
  // the oracle (`Menu Oracle Screenshots/kitchen all three states.png`, native, declared) shows
  // THREE distinct cells in BOTH the cook and the brew column:
  //   GREEN  ALLOWED     LABOR_KITCHEN_{COOK,BREW}_ALLOWED     (Prepared cat intestines: cook green)
  //   RED    RESTRICTED  LABOR_KITCHEN_{COOK,BREW}_RESTRICTED  (the seed rows: cookable, FORBIDDEN by
  //                                                            the player; Plump helmets: brew red)
  //   GREY   CANNOT      LABOR_KITCHEN_{COOK,BREW}_CANNOT      (Rope reeds / Rice plants / Pig tails:
  //                                                            cook IMPOSSIBLE; intestines: brew ditto)
  // The old code modelled this as `allowed ? "on" : "off"` -- so "you forbade this" and "this is
  // impossible" were INDISTINGUISHABLE and RESTRICTED was UNRENDERABLE. That is a CONTENT-MODEL bug,
  // not a paint bug, and it is fixed here by making the state 3-valued at the source.
  //
  // The wire now serves both capability booleans. Optional reads remain for compatibility with an
  // older DLL: absent cookCapable preserves its historical allowed/restricted interpretation,
  // while an absent/falsy brewCapable remains the honest CANNOT state.
  const KITCHEN_CELL_SPRITES = {
    cook: {
      allowed: "LABOR_KITCHEN_COOK_ALLOWED", restricted: "LABOR_KITCHEN_COOK_RESTRICTED",
      cannot: "LABOR_KITCHEN_COOK_CANNOT",
    },
    brew: {
      allowed: "LABOR_KITCHEN_BREW_ALLOWED", restricted: "LABOR_KITCHEN_BREW_RESTRICTED",
      cannot: "LABOR_KITCHEN_BREW_CANNOT",
    },
  };
  // 'allowed' | 'restricted' | 'cannot'. Row shape is the wire's: plants carry seedCookAllowed +
  // brewCapable + brewAllowed; item rows carry cookAllowed + both capability booleans.
  function kitchenCellState(row, kind) {
    const r = row || {};
    if (kind === "brew") {
      if (!r.brewCapable) return "cannot";
      return r.brewAllowed ? "allowed" : "restricted";
    }
    if (r.cookCapable === false) return "cannot";
    const allowed = Object.prototype.hasOwnProperty.call(r, "cookAllowed")
      ? !!r.cookAllowed : !!r.seedCookAllowed;
    return allowed ? "allowed" : "restricted";
  }
  // CANNOT is NOT A CONTROL: native renders a real grey tile you cannot click (and the server
  // rejects the toggle anyway -- kitchen_panel.cpp:135 "plant cannot be brewed"). It therefore gets
  // iconHtml and NO data-kitchen-* attribute. ALLOWED/RESTRICTED are the two faces of one latch.
  function kitchenCellHtml(row, kind, dataset) {
    const state = kitchenCellState(row, kind);
    const art = KITCHEN_CELL_SPRITES[kind];
    const name = String((row && row.name) || "This item");
    const verb = kind === "brew" ? "brewed" : "cooked";
    if (state === "cannot")
      return DWFUI.iconHtml({ sprite: art.cannot, nativeCell: true, cls: "kitchen-cell-cannot",
        alt: `${name} cannot be ${verb}`, title: `${name} cannot be ${verb}.` });
    const allowed = state === "allowed";
    const label = kind === "brew"
      ? (allowed ? "Brewing allowed (click to forbid)" : "Brewing forbidden (click to allow)")
      : (allowed ? "Cooking allowed (click to forbid)" : "Cooking forbidden (click to allow)");
    return DWFUI.latchHtml({
      on: allowed,
      sprite: art.restricted,            // OFF face  == RESTRICTED (red)
      activeSprite: art.allowed,         // ON  face  == ALLOWED (green)
      cls: "kitchen-cell-latch",
      dataset: Object.assign({}, dataset, { kitchenMode: kind, kitchenOn: allowed ? 0 : 1 }),
      title: label, ariaLabel: `${name}: ${label}`,
    });
  }

  // WD-18: per-item cook + brew tiles (the `kitchen all three states.png`) -- one row per
  // seed-bearing plant. The brew tile is only a CONTROL for plants DF can actually brew
  // (plant_raw_flags::DRINK, see kitchen_panel.cpp plant_brew_capable); otherwise it is the native
  // CANNOT tile. Retained data contract: data-kitchen-toggle / -mode / -on.
  function kitchenToggleButton(p, kind) {
    return kitchenCellHtml(p, kind, { kitchenToggle: p.id });
  }

  // R5 (CIM-labor-kitchen.jpg): the native Kitchen screen lists ALL cookable stock (meat, fish,
  // prepared organs, cheese...) with a per-item count and a cook toggle, not only seed plants.
  // Server now serves `items:[{type,mat,matIndex,name,count,cookAllowed,category}]` (grouped stock)
  // alongside the legacy `plants` array. Rows degrade gracefully on an old DLL (no `items` → only
  // the plant rows render, exactly as before).
  const KITCHEN_CATEGORY_LABELS = {
    MEAT: "Meat", FISH: "Fish", FISH_RAW: "Raw fish", EGG: "Egg",
    CHEESE: "Cheese", PLANT_GROWTH: "Plant growth", GLOB: "Fat",
  };
  function kitchenPrettyCategory(cat) {
    const c = String(cat || "");
    if (KITCHEN_CATEGORY_LABELS[c]) return KITCHEN_CATEGORY_LABELS[c];
    return c ? c.charAt(0) + c.slice(1).toLowerCase().replace(/_/g, " ") : "";
  }
  // Item rows are addressed by (type, mat, matIndex) -- the same addressing the /kitchen-toggle route
  // already takes for BOTH modes. A cell with no addressing would be a dead button.
  function kitchenItemDataset(i) {
    return { kitchenItemType: i.type, kitchenMat: i.mat, kitchenMatindex: i.matIndex };
  }
  function kitchenItemCookButton(i) {
    return kitchenCellHtml(i, "cook", kitchenItemDataset(i));
  }
  // The count is GOLD in native (`#FFBF01`); the old row painted it with an inline hex literal --
  // an R1 drift violation. It now rides the F1 numeric text role.
  function kitchenCountCell(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0
      ? `<span class="dwfui-num kitchen-count">${DWFUI.bitmapTextHtml(String(n))}</span>` : "";
  }
  // Native shows the ITEM'S OWN sprite in the 48px tile. Kitchen uses the same shared spriteRef
  // channel as every other item surface; species-specific rows carry identKind+ident so seeds,
  // plants, and fish resolve from their stable raw token rather than a world-order numeric index.
  function kitchenItemRowHtml(i) {
    const cat = kitchenPrettyCategory(i.category);
    return DWFUI.rowHtml({
      chassis: "table", cls: "kitchen-item-row",
      iconCfg: { item: i.spriteRef, size: 48, alt: i.name },
      labelHtml: DWFUI.bitmapTextHtml(String(i.name || "")),
      sub: cat ? { html: DWFUI.bitmapTextHtml(cat), cls: "dwfui-sub kitchen-cat" } : null,
      cells: [
        { html: kitchenCountCell(i.count), cls: "kitchen-count-cell", width: 60 },
        { html: kitchenItemCookButton(i), cls: "kitchen-cell" },
        { html: kitchenCellHtml(i, "brew", kitchenItemDataset(i)), cls: "kitchen-cell" },
      ],
    });
  }
  function kitchenPlantRowHtml(p) {
    return DWFUI.rowHtml({
      chassis: "table", cls: "kitchen-plant-row",
      iconCfg: { item: p.spriteRef, size: 48, alt: p.name },
      labelHtml: DWFUI.bitmapTextHtml(String(p.name || "")),
      cells: [
        { html: "", cls: "kitchen-count-cell", width: 60 },
        { html: kitchenToggleButton(p, "cook"), cls: "kitchen-cell" },
        { html: kitchenToggleButton(p, "brew"), cls: "kitchen-cell" },
      ],
    });
  }

  // ---- W6 `< All >` type cycler + W7a sort header ------------------------------------------------
  // The old `.kitchen-paging` was three INERT unicode arrows and the old `.kitchen-head` was two
  // emoji captions. Both are gone. The cycler is now a real filter over the item `category` the wire
  // already serves, and the sort header is the native SORT_* radiogroup.
  function kitchenCategories(data) {
    const seen = [];
    (Array.isArray(data?.items) ? data.items : []).forEach(i => {
      const cat = String(i.category || "");
      if (cat && seen.indexOf(cat) === -1) seen.push(cat);
    });
    return seen.sort();
  }
  function kitchenTypeCycleHtml(data, active) {
    const label = active ? kitchenPrettyCategory(active) : "All";
    return DWFUI.cyclerHtml({
      label, cls: "kitchen-cycler", ariaLabel: "Item type filter",
      previous: { dataset: { kitchenCycle: -1 }, title: "Previous item type" },
      next: { dataset: { kitchenCycle: 1 }, title: "Next item type" },
    });
  }
  // ---- W8 COLUMN MASS-TOGGLE (the control the owner found MISSING ENTIRELY) -----------------------------
  // The owner, from his live game: "in the kitchen tab we are missing these blue arrow buttons entirely, if
  // you click them they filter out all the gray state options, from food or drink respectively."
  // Native (`kitchen all three states.png`) puts ONE button above the COOK column and ONE above the
  // BREW column, each with the sort caret beneath it. Clicking one collapses the list to the rows
  // that column can ACTUALLY act on -- it hides that column's CANNOT (grey) rows, and ONLY that
  // column's: hiding the un-cookable rows must not hide the un-brewable ones.
  //
  // *** IT IS A VIEW FILTER. IT MUST NOT MUTATE GAME STATE. *** There is no /kitchen-toggle here and
  // no write-back onto a row: it flips one client-side boolean and re-renders. The name is chosen to
  // say so -- `hideCannot`, not `setCannot`. (A "mass toggle" that ALLOWED every cookable row would
  // be a mass WRITE, which is not what native does and not what the owner described.)
  //
  // The two faces are the two native sprites, and the greyness they filter on is read back through
  // kitchenCellState -- the SAME function the cells paint with, so the button can never disagree with
  // the tiles it sits above.
  const KITCHEN_MASS_COLUMNS = [
    { kind: "cook", noun: "cookable" },
    { kind: "brew", noun: "brewable" },
  ];
  function kitchenMassToggleHtml(kind, hidden) {
    const noun = (KITCHEN_MASS_COLUMNS.find(c => c.kind === kind) || {}).noun || kind;
    const label = hidden
      ? `Show all rows again (currently showing only ${noun} items)`
      : `Show only ${noun} items (hide the greyed-out rows)`;
    return DWFUI.artBtnHtml({
      // COLLAPSED -> offer EXPAND; EXPANDED -> offer CONTRACT. Both are self-framed native cells, so
      // artBtnHtml emits data-dwfui-self-framed and the css gives them NO second chassis.
      sprite: hidden ? "EXPAND_LIST" : "CONTRACT_LIST",
      cls: "kitchen-mass-btn",
      active: !!hidden,
      dataset: { kitchenMass: kind, kitchenMassOn: hidden ? 0 : 1 },
      title: label, ariaLabel: `${kind === "brew" ? "Brew" : "Cook"} column: ${label}`,
    });
  }
  function kitchenMassStripHtml(hide) {
    const h = hide || {};
    return `<div class="kitchen-mass" role="group" aria-label="Column filters">` +
      KITCHEN_MASS_COLUMNS.map(c => kitchenMassToggleHtml(c.kind, !!h[c.kind])).join("") +
      `</div>`;
  }

  // The caret beneath each mass-toggle is native's SORT_DESCENDING for that column -- so cook and brew
  // are two more columns of the ONE existing sort radiogroup (bare: native gives them no caption).
  // They are NOT a second header: sortHeaderHtml still owns every caret on this screen.
  const KITCHEN_SORT_COLUMNS = [
    { key: "type", label: "Type", sort: "desc", title: "Sort by item type" },
    { key: "name", label: "Name", sort: "desc", title: "Sort by name" },
    { key: "count", label: "", sort: "desc", title: "Sort by count" },
    { key: "cook", label: "", sort: "desc", title: "Sort by cooking state" },
    { key: "brew", label: "", sort: "desc", title: "Sort by brewing state" },
  ];
  // Descending = the most permissive state first, which is what the native caret shows.
  const KITCHEN_STATE_RANK = { allowed: 2, restricted: 1, cannot: 0 };
  function kitchenSortHeaderHtml(active) {
    return DWFUI.sortHeaderHtml({
      cls: "kitchen-sort", dataAttr: "kitchen-sort", ariaLabel: "Sort kitchen items",
      active: KITCHEN_SORT_COLUMNS.some(c => c.key === active) ? active : "type",
      columns: KITCHEN_SORT_COLUMNS,
    });
  }
  function kitchenSortRows(rows, key, nameOf, keyOf) {
    const copy = rows.slice();
    if (key === "name") copy.sort((a, b) => String(nameOf(a)).localeCompare(String(nameOf(b))));
    else if (key === "count") copy.sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
    else if (key === "cook" || key === "brew") {
      const rank = r => KITCHEN_STATE_RANK[kitchenCellState(r, key)] || 0;
      copy.sort((a, b) => rank(b) - rank(a) ||
        String(nameOf(a)).localeCompare(String(nameOf(b))));
    } else copy.sort((a, b) => String(keyOf(a)).localeCompare(String(keyOf(b))) ||
      String(nameOf(a)).localeCompare(String(nameOf(b))));
    return copy;
  }

  // The one filter+sort pipeline. Every caller (initial render, search input, cycler, sort header,
  // W8 mass-toggle, toggle re-render) goes through it, so the list can never disagree with the header
  // and no narrowing control gets a second, parallel filter path of its own.
  function kitchenVisibleRows(data, opts) {
    const o = opts || {};
    const term = String(o.filter || "");
    const type = String(o.typeFilter || "");
    const sort = String(o.sort || "type");
    const hide = o.hideCannot || {};
    const match = value => !term ? true : (typeof dfTokenMatch === "function"
      ? dfTokenMatch(value, term)
      : term.toLowerCase().split(/\s+/).every(token => String(value || "").toLowerCase().includes(token)));
    // W8: hide the rows this column CANNOT act on. Greyness is read through kitchenCellState -- the
    // same function that paints the cell -- so "grey" here means exactly what the player sees grey.
    // Cook and brew are independent: hiding un-cookable rows must not hide un-brewable ones.
    const massOk = row => KITCHEN_MASS_COLUMNS.every(c =>
      !hide[c.kind] || kitchenCellState(row, c.kind) !== "cannot");
    let items = (Array.isArray(data?.items) ? data.items : []).filter(i => match(i.name) && massOk(i));
    let plants = (Array.isArray(data?.plants) ? data.plants : []).filter(p => match(p.name) && massOk(p));
    if (type) {
      items = items.filter(i => String(i.category || "") === type);
      plants = [];   // the plant rows carry no `category`; a type filter excludes them
    }
    items = kitchenSortRows(items, sort, i => i.name, i => i.category || "");
    plants = kitchenSortRows(plants, sort, p => p.name, () => "PLANT");
    return { items, plants };
  }
  function kitchenRowsMarkup(data, opts) {
    const { items, plants } = kitchenVisibleRows(data, opts);
    if (!items.length && !plants.length) return `<div class="info-message">No matching cookable items.</div>`;
    return items.map(kitchenItemRowHtml).join("") + plants.map(kitchenPlantRowHtml).join("");
  }
  function kitchenRows() {
    return kitchenRowsMarkup(kitchenData, { filter: kitchenFilter, typeFilter: kitchenTypeFilter,
      sort: kitchenSort, hideCannot: kitchenHideCannot });
  }

  function kitchenBodyMarkup(data, filter = "", opts = {}) {
    const term = String(filter || "");
    const typeFilter = String(opts.typeFilter != null ? opts.typeFilter : (data?.typeFilter || ""));
    const sort = String(opts.sort != null ? opts.sort : (data?.sort || "type"));
    const hideCannot = opts.hideCannot || {};
    const rows = kitchenRowsMarkup(data, { filter: term, typeFilter, sort, hideCannot });
    const scroll = DWFUI.scrollHtml({ cls: "kitchen-scroll", ariaLabel: "Kitchen items" }, rows);
    // PB-09: Kitchen keeps its one wired BODY search (the shell footer is removed for this tab), but
    // its visuals are the same shared native DWFUI search used by Justice and every information
    // footer. Consumer hooks may place it; they must never replace the shared input/button classes.
    const search = DWFUI.searchHtml({
      cls: "kitchen-search-row",
      id: "kitchenSearch",
      type: "search",
      value: term,
      ariaLabel: "Filter kitchen items",
      magnifier: true,
      placement: "footer",
      preserveKey: "kitchen-items",
    });
    // Native's column header is TWO stacked strips over the cook/brew columns: the W8 mass-toggle
    // buttons, and the sort carets directly beneath them. `.kitchen-headbar` is that stack. It adds
    // NO frame of its own -- the buttons are self-framed native cells and own their gold border, and
    // chrome belongs to the outermost owner (the panel), not to every component we drop in.
    return `${kitchenTypeCycleHtml(data, typeFilter)}` +
      `<div class="kitchen-headbar">${kitchenMassStripHtml(hideCannot)}${kitchenSortHeaderHtml(sort)}</div>` +
      `<div id="fortStatus" class="info-message fort-status" style="display:none"></div>${scroll}${search}`;
  }

  function renderKitchenPanel() {
    if (kitchenData && kitchenData.error) {
      fortRenderWindow({ title: "Kitchen", body: `<div class="info-message">Kitchen unavailable: ${escapeHtml(kitchenData.error)}</div>` });
      return;
    }
    // WAVE 4 restyle (`kitchen all three states.png`): a REAL `< All >` type cycler over the served
    // item categories, the native SORT_* column header, DWFUI table rows with the tri-state cook and
    // brew tiles, and the search field at the BOTTOM (DF's layout), not the top.
    const kitchenBody = kitchenBodyMarkup(kitchenData, kitchenFilter,
      { typeFilter: kitchenTypeFilter, sort: kitchenSort, hideCannot: kitchenHideCannot });

    // Check if we're rendering within the labor panel (Kitchen section)
    const isInLaborPanel = clientPanel.classList.contains("visible") &&
                           clientPanel.querySelector(".info-section-tabs [data-labor-section=\"Kitchen\"]") !== null;

    if (isInLaborPanel) {
      // Kitchen owns its native bottom search. Remove the generic Labor footer search so the
      // composed screen has one search field, not two (parity review 2026-07-11).
      clientPanel.querySelector(".info-footer .info-search")?.remove();
      // Render within the labor panel's info-main area
      const main = clientPanel.querySelector(".info-main");
      if (main) {
        main.innerHTML = kitchenBody;
      }
      // Mark the Kitchen tab as active
      clientPanel.querySelectorAll("[data-labor-section]").forEach(x =>
        x.classList.toggle("active", x.dataset.laborSection === "Kitchen"));
      bindKitchenPanel();
    } else {
      // Render as a standalone panel
      fortRenderWindow({ title: "Kitchen", body: kitchenBody, onRender: bindKitchenPanel });
    }
  }

  // Re-render just the list (search / cycler / sort / a toggle) and re-bind it. The item-sprite
  // channel is a SEPARATE DOM pass from DWFUI.mountDom's observer, so it must be issued explicitly.
  function kitchenRepaintRows() {
    const scroll = clientPanel.querySelector(".kitchen-scroll");
    if (!scroll) return;
    scroll.innerHTML = kitchenRows();
    if (typeof DWFUI !== "undefined" && DWFUI.paintItemSprites) DWFUI.paintItemSprites(scroll);
    bindKitchenToggles();
  }

  function bindKitchenPanel() {
    const search = clientPanel.querySelector("#kitchenSearch");
    if (search) search.addEventListener("input", event => {
      kitchenFilter = String(event.target.value || "");
      kitchenRepaintRows();
    });
    // W6 `< All >` cycler: a REAL filter over the served item categories (the old one was three
    // inert unicode arrows).
    clientPanel.querySelectorAll("[data-kitchen-cycle]").forEach(b =>
      b.addEventListener("click", () => {
        const cats = ["", ...kitchenCategories(kitchenData)];
        const at = Math.max(0, cats.indexOf(kitchenTypeFilter));
        const step = Number(b.dataset.kitchenCycle) || 1;
        kitchenTypeFilter = cats[(at + step + cats.length) % cats.length];
        renderKitchenPanel();
      }));
    // W7a sort header: a radiogroup over columns. It SORTS -- it is not decoration.
    clientPanel.querySelectorAll("[data-kitchen-sort]").forEach(b =>
      b.addEventListener("click", () => {
        kitchenSort = String(b.dataset.kitchenSort || "type");
        renderKitchenPanel();
      }));
    // W8 column mass-toggle. A VIEW filter: it flips one boolean and re-renders. NO fetch, NO
    // /kitchen-toggle, NO write-back onto a row -- collapsing the list must never cook anything.
    clientPanel.querySelectorAll("[data-kitchen-mass]").forEach(b =>
      b.addEventListener("click", () => {
        const kind = String(b.dataset.kitchenMass || "");
        if (!KITCHEN_MASS_COLUMNS.some(c => c.kind === kind)) return;
        kitchenHideCannot = Object.assign({}, kitchenHideCannot, { [kind]: !kitchenHideCannot[kind] });
        renderKitchenPanel();
      }));
    if (typeof DWFUI !== "undefined" && DWFUI.paintItemSprites) DWFUI.paintItemSprites(clientPanel);
    bindKitchenToggles();
  }

  function bindKitchenToggles() {
    clientPanel.querySelectorAll("[data-kitchen-toggle]").forEach(b =>
      b.addEventListener("click", () => kitchenToggle(Number(b.dataset.kitchenToggle), Number(b.dataset.kitchenOn), b.dataset.kitchenMode || "cook")));
    // R5: full-list item cook toggles (addressed by item type+material).
    clientPanel.querySelectorAll("[data-kitchen-item-type]").forEach(b =>
      b.addEventListener("click", () => kitchenItemToggle(
        Number(b.dataset.kitchenItemType), Number(b.dataset.kitchenMat), Number(b.dataset.kitchenMatindex),
        Number(b.dataset.kitchenOn), b.dataset.kitchenMode || "cook")));
  }

  async function kitchenItemToggle(type, mat, matIndex, on, mode = "cook") {
    if (!(type >= 0)) return;
    try {
      await fortFetchJson(`/kitchen-toggle?player=${encodeURIComponent(player)}&type=${type}&mat=${mat}&matIndex=${matIndex}&on=${on}&mode=${encodeURIComponent(mode)}&t=${Date.now()}`, { method: "POST" });
      const item = (kitchenData.items || []).find(i => i.type === type && i.mat === mat && i.matIndex === matIndex);
      if (item) { if (mode === "brew") item.brewAllowed = on !== 0; else item.cookAllowed = on !== 0; }
      kitchenRepaintRows();
      fortSetStatus(on !== 0
        ? (mode === "brew" ? "Brewing allowed." : "Cooking allowed.")
        : (mode === "brew" ? "Brewing forbidden." : "Cooking forbidden."), false);
    } catch (err) { fortSetStatus(err.message || "Toggle failed.", true); }
  }

  // Node export for the offline CIM fixture (harmless in the browser: `module` is undefined).
  // B157: row/toggle renderers exported so the fixture can pin the cook+brew cell contract.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { kitchenPrettyCategory, kitchenToggleButton, kitchenItemCookButton,
      kitchenPlantRowHtml, kitchenItemRowHtml, kitchenBodyMarkup,
      kitchenCellState, kitchenCellHtml, kitchenCategories, kitchenVisibleRows,
      kitchenMassToggleHtml, kitchenMassStripHtml, kitchenSortHeaderHtml,
      KITCHEN_CELL_SPRITES, KITCHEN_MASS_COLUMNS, KITCHEN_SORT_COLUMNS };
  }

  async function kitchenToggle(id, on, mode = "cook") {
    if (!(id >= 0)) return;
    try {
      await fortFetchJson(`/kitchen-toggle?player=${encodeURIComponent(player)}&id=${encodeURIComponent(id)}&on=${on}&mode=${encodeURIComponent(mode)}&t=${Date.now()}`, { method: "POST" });
      // Update local state and re-render (preserve scroll/filter).
      const plant = (kitchenData.plants || []).find(p => p.id === id);
      if (plant) { if (mode === "brew") plant.brewAllowed = on !== 0; else plant.seedCookAllowed = on !== 0; }
      kitchenRepaintRows();
      fortSetStatus(on !== 0
        ? (mode === "brew" ? "Brewing allowed." : "Cooking allowed.")
        : (mode === "brew" ? "Brewing forbidden." : "Cooking forbidden."), false);
    } catch (err) { fortSetStatus(err.message || "Toggle failed.", true); }
  }
