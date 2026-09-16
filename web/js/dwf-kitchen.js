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

  // ---- Kitchen / food prefs: allow or forbid cooking seed-bearing plants. Reads /kitchen. ----
  let kitchenData = null;
  let kitchenFilter = "";
  let kitchenTypeFilter = "";   // `< All >` cycler: "" == All, else an item `category`
  let kitchenSort = "type";     // W7a sort header: the active column key
  // Per-column "hide this column's CANNOT rows". A VIEW filter only: never sent to the server.
  let kitchenHideCannot = { cook: false, brew: false };

  // Records live DWFUI usage for diagnostics without making the offline module fixture need a window.
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function") DWFUI.require("labor-kitchen",
    ["windowHtml", "searchHtml", "scrollHtml", "rowHtml", "latchHtml", "iconHtml", "sortHeaderHtml", "artBtnHtml", "cyclerHtml"]);

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

  // The kitchen cell is a TRI-STATE, not a boolean: ALLOWED / RESTRICTED (the player forbade it) /
  // CANNOT (impossible). Modelling it as a boolean makes RESTRICTED unrenderable.
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
  // CANNOT is NOT A CONTROL: it gets iconHtml and no data-kitchen-* attribute, and the server rejects
  // the toggle anyway. ALLOWED and RESTRICTED are the two faces of one latch.
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

  // The brew tile is only a CONTROL for plants DF can actually brew; otherwise it is the CANNOT tile.
  // Retained data contract: data-kitchen-toggle / -mode / -on.
  function kitchenToggleButton(p, kind) {
    return kitchenCellHtml(p, kind, { kitchenToggle: p.id });
  }

  // Rows degrade gracefully on an old DLL: with no `items` only the plant rows render.
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
  // Species-specific rows carry identKind+ident so seeds, plants and fish resolve from their stable raw
  // token rather than a world-order numeric index.
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

  // ---- `< All >` type cycler over the served item `category`, plus the native SORT_* sort header. ----
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
  // The mass-toggle IS A VIEW FILTER and must not mutate game state: it flips one client boolean and
  // re-renders. Cook and brew are independent -- hiding un-cookable rows must not hide un-brewable ones.
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

  // The carets are two more columns of the ONE sort radiogroup; sortHeaderHtml still owns every caret here.
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

  // The one filter+sort pipeline. Every caller goes through it, so no narrowing control gets a second,
  // parallel filter path of its own.
  function kitchenVisibleRows(data, opts) {
    const o = opts || {};
    const term = String(o.filter || "");
    const type = String(o.typeFilter || "");
    const sort = String(o.sort || "type");
    const hide = o.hideCannot || {};
    const match = value => !term ? true : (typeof dfTokenMatch === "function"
      ? dfTokenMatch(value, term)
      : term.toLowerCase().split(/\s+/).every(token => String(value || "").toLowerCase().includes(token)));
    // Greyness is read through kitchenCellState -- the same function that paints the cell -- so "grey"
    // here means exactly what the player sees grey.
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
    const scroll = DWFUI.scrollHtml({ cls: "kitchen-scroll", rows: ".kitchen-item-row, .kitchen-plant-row", ariaLabel: "Kitchen items" }, rows);
    // Consumers may place this search; they must never replace the shared input and button classes.
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
    // `.kitchen-headbar` adds NO frame of its own: the buttons are self-framed native cells that own their
    // gold border, and chrome belongs to the outermost owner.
    return `${kitchenTypeCycleHtml(data, typeFilter)}` +
      `<div class="kitchen-headbar">${kitchenMassStripHtml(hideCannot)}${kitchenSortHeaderHtml(sort)}</div>` +
      `<div id="fortStatus" class="info-message fort-status"></div>${scroll}${search}`;
  }

  // Standalone Kitchen owns a DWFUI window directly. The Labor tab deliberately does not call
  // this builder: it contributes kitchenBodyMarkup() to Labor's already-owned shared window.
  function kitchenStandaloneMarkup(body) {
    return DWFUI.windowHtml({
      ariaLabel: "Kitchen",
      bodyHtml: `<div class="info-header">
          <div class="info-title">${escapeHtml("Kitchen")}</div>
          ${fortCloseBtnHtml()}
        </div>
        <div class="info-body fort-body">${body || ""}</div>`,
    });
  }

  function renderKitchenStandalone(body, onRender) {
    clientPanel.className = "visible info-panel fort-window";
    panelContent(clientPanel).innerHTML = kitchenStandaloneMarkup(body);
    clientPanel.querySelector("[data-fort-close]")?.addEventListener("click", closeClientPanel);
    fortBindUnitLinks(clientPanel);
    if (typeof onRender === "function") onRender();
  }

  function renderKitchenPanel() {
    if (kitchenData && kitchenData.error) {
      renderKitchenStandalone(`<div class="info-message">Kitchen unavailable: ${escapeHtml(kitchenData.error)}</div>`);
      return;
    }
    const kitchenBody = kitchenBodyMarkup(kitchenData, kitchenFilter,
      { typeFilter: kitchenTypeFilter, sort: kitchenSort, hideCannot: kitchenHideCannot });

    // Check if we're rendering within the labor panel (Kitchen section)
    const isInLaborPanel = clientPanel.classList.contains("visible") &&
                           clientPanel.querySelector(".info-section-tabs [data-labor-section=\"Kitchen\"]") !== null;

    if (isInLaborPanel) {
      // Kitchen owns its native bottom search. Remove the generic Labor footer search so the
      // composed screen has one search field, not two (parity review).
      clientPanel.querySelector(".info-footer .info-search")?.remove();
      // Render within the labor panel's info-main area
      const main = clientPanel.querySelector(".info-main");
      if (main) {
        // Kitchen owns an inner DWFUI scroll, so mark the outer node a height-passing host instead of letting
        // the fill-scroll role cap the item list at the 46vh fallback.
        main.classList.add("info-main--kitchen-host");
        main.innerHTML = kitchenBody;
      }
      // Mark the Kitchen tab as active
      clientPanel.querySelectorAll("[data-labor-section]").forEach(x =>
        x.classList.toggle("active", x.dataset.laborSection === "Kitchen"));
      bindKitchenPanel();
    } else {
      // Render as a standalone panel
      renderKitchenStandalone(kitchenBody, bindKitchenPanel);
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
    // A VIEW filter: no fetch and no write-back -- collapsing the list must never cook anything.
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
  // row/toggle renderers exported so the fixture can pin the cook+brew cell contract.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { kitchenPrettyCategory, kitchenToggleButton, kitchenItemCookButton,
      kitchenPlantRowHtml, kitchenItemRowHtml, kitchenBodyMarkup,
      kitchenCellState, kitchenCellHtml, kitchenCategories, kitchenVisibleRows,
      kitchenMassToggleHtml, kitchenMassStripHtml, kitchenSortHeaderHtml,
      kitchenStandaloneMarkup,
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
