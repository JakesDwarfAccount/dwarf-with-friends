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

  // ---- Work orders (Manager), backed by /orders + /order-* endpoints ----
  let woShopCatalog = null;// [{shop, icon, items:[{key,label}]}] -- DF-style by-workshop picker
  let woSelShop = -1;      // -1 = "All tasks", else index into woShopCatalog
  let woPresets = null;    // [preset names] -- cached
  let woTargets = null;    // item condition targets
  let woWorkshops = null;  // workshop/furnace choices
  let woLastOrders = [];   // last fetched order list (for in-place re-render)
  let woHasManager = true; // /orders.hasManager -- gate the tab like native DF
  // woNow / woPopulation are optional /orders fields: a missing date can never satisfy WAITING, and a
  // missing population is `unknown`, never "below 20".
  let woNow = null;
  let woPopulation = null;
  let woMode = "list";     // "list" (base orders screen) | "new" (task picker) | "conditions"
  let woSelKey = null;
  let woSelOrderId = null;
  let woAmount = 1;
  let woFreq = "OneTime";
  let woSearch = "";
  let woCreateWorkshop = "-1";
  let woEditOrderId = null;
  let woEditAmount = 0;
  let woEditFreq = "OneTime";
  let woEditWorkshop = "-1";
  const WORK_ORDERS_ENABLED = true;

  // ---- Pure row-anatomy helpers (unit-testable, DOM-free). ----
  function woStatusIconKey(o, now) { return DWFUI.workOrderStatusKey(o, now === undefined ? woNow : now); }
  // Any-shop orders carry no bound workshop (workshop_id < 0). Native prints "Can use any shop";
  // bound orders print the workshop's name. Never render a bound name for an any-shop order.
  function woIsAnyShop(o) { return !(o && Number(o.workshopId) >= 0); }
  function woWorkshopLabel(o) {
    return woIsAnyShop(o) ? "Can use any shop" : String(o.workshopName || "Workshop");
  }
  function woStatusIconHtml(o, now) {
    return DWFUI.workOrderBadgeHtml(o, now === undefined ? woNow : now);
  }

  // The validated badge and its explanatory footer are ONE regime: both appear only at population >=
  // 20, and an unknown population keeps the pre-regime behaviour rather than deleting a shipped column.
  const WO_VALIDATION_POPULATION = 20;
  function woPopulationRegime(data) {
    // `== null` on purpose: Number(null) is 0, so reading an unserved field as a population of
    // ZERO would silently delete the validation column on every host that does not serve it.
    if (!data || data.population == null) return "unknown";
    const pop = Number(data.population);
    if (!Number.isFinite(pop)) return "unknown";
    return pop >= WO_VALIDATION_POPULATION ? "present" : "absent";
  }
  function woShowsValidationRegime(data) { return woPopulationRegime(data) !== "absent"; }

  // Three mutually exclusive bottom states, and THE REFUSAL WINS: test for a manager before the
  // population test is ever evaluated.
  function woBottomState(data) {
    if (!(data && data.hasManager !== false)) return "refusal";
    return woShowsValidationRegime(data) ? "footer" : "none";
  }

  const WO_FREQS = ["OneTime", "Daily", "Monthly", "Seasonally", "Yearly"];
  const WO_COMPARE_CYCLE = ["AtLeast", "AtMost", "GreaterThan", "LessThan", "Exactly", "Not"];
  // Keys must match the lua validator's CONDITION_ADJECTIVES set plus the explicit `empty` bit --
  // an unknown key is refused server-side.
  const WO_ADJECTIVES = [
    ["", "any"], ["empty", "empty"], ["metal", "metal"], ["wood", "wooden"], ["stone", "stone"],
    ["hard", "hard"], ["edged", "edged"], ["fire_safe", "fire-safe"], ["magma_safe", "magma-safe"],
    ["non_economic", "non-economic"], ["sharpenable", "sharpenable"], ["cookable", "cookable"],
    ["millable", "millable"], ["dyeable", "dyeable"],
  ];
  let woCondMaterials = [];   // materials for the current condition item type (from /condition-materials)
  let woCondMatItem = null;   // item type woCondMaterials was loaded for
  let woCondSuggestions = []; // exact server-sent suggestions for the selected order
  let woCondSuggestFor = null;
  let woCondPicker = null;    // {idx, tab:'type'|'mat'|'adj'} -- open chooser under a condition row
  let woOrderCondAdd = false; // the "new order condition" chooser panel is open
  let woOrderCondType = "Completed";

  function woConditionDuplicate(rows, candidate, kind) {
    const list = Array.isArray(rows) ? rows : [];
    if (kind === "order") return list.some(c => Number(c.other) === Number(candidate.other) && String(c.type || "") === String(candidate.type || ""));
    const aliases = [
      [["item", "item_type"], ""], [["itemSubtype", "item_subtype"], -1],
      [["matType", "mat_type"], -1], [["matIndex", "mat_index"], -1],
      [["flags1"], 0], [["flags2"], 0], [["flags3"], 0], [["flags4"], 0], [["flags5"], 0],
      [["reactionClass", "reaction_class"], ""],
      [["reactionProduct", "has_material_reaction_product", "reaction_product"], ""],
      [["metalOre", "metal_ore"], -1], [["minDimension", "min_dimension"], -1],
      [["reactionId", "reaction_id"], -1], [["toolUse", "has_tool_use"], ""],
      [["dyeColor", "dye_color"], -1],
    ];
    const value = (row, names, fallback) => {
      for (const name of names) if (row?.[name] !== undefined && row[name] !== null) return row[name];
      return fallback;
    };
    return list.some(current => aliases.every(([names, fallback]) =>
      String(value(current, names, fallback)) === String(value(candidate, names, fallback))));
  }

  function woFreqLabel(f) { return f === "OneTime" ? "One time" : (f || "One time"); }

  function woSelectedOrder() {
    return woLastOrders.find(o => Number(o.id) === Number(woSelOrderId)) || null;
  }

  function woOrderTitle(o) {
    if (!o) return "";
    const n = Number(o.pos);
    return `#${Number.isFinite(n) ? n + 1 : "?"} ${o.job || "Work order"}`;
  }

  function woWorkshopChoices(includeAnyLabel) {
    const choices = [["-1", includeAnyLabel || "General manager order"]];
    (woWorkshops || []).forEach(w => {
      choices.push([String(w.id), `${w.label || w.kind || "Workshop"} (${w.x},${w.y},${w.z})`]);
    });
    return choices;
  }

  function woCyclerHtml(key, choices, current, cfg = {}) {
    const list = Array.isArray(choices) ? choices : [];
    const found = list.findIndex(choice => String(choice[0]) === String(current));
    const at = found >= 0 ? found : 0;
    const choice = list[at] || ["", "(none)"];
    const adjacent = delta => list.length ? list[(at + delta + list.length) % list.length] : choice;
    const action = (next, title) => ({
      dataset: { woCycle: key, woValue: next[0] }, title,
    });
    return DWFUI.cyclerHtml({
      cls: cfg.cls, ariaLabel: cfg.ariaLabel || key, label: choice[1],
      previous: action(adjacent(-1), cfg.previousTitle || "Previous choice"),
      next: action(adjacent(1), cfg.nextTitle || "Next choice"),
    });
  }

  function woBeginOrderEdit(order) {
    if (!order) return;
    woEditOrderId = Number(order.id);
    woEditAmount = Number(order.amountTotal) || 0;
    woEditFreq = order.frequency || "OneTime";
    woEditWorkshop = String(order.workshopId == null ? -1 : order.workshopId);
  }

  async function woApi(path, params = {}) {
    const { response: r, text, data } = await globalThis.DwfCoreTransport.queryJson(path, params, {
      player: typeof player === "undefined" ? undefined : player,
      method: "POST", bust: true, includeEmpty: true,
    });
    if (!r.ok || data.ok === false) throw new Error(data.msg || text.trim() || "request failed");
    return data;
  }

  async function woFetchJson(path) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${path}${sep}t=${Date.now()}`, { cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("work-orders.response-parse"); }
    if (!r.ok || data.ok === false) throw new Error(data.error || data.msg || text.trim() || `${path} failed`);
    return data;
  }

  // ---- condition editor data loads -----------------------------------------------------------
  async function loadWoCondMaterials(item) {
    woCondMatItem = item;
    woCondMaterials = [];
    try {
      const d = await woFetchJson(`/condition-materials?item=${encodeURIComponent(item || "")}`);
      if (woCondMatItem === item) {
        woCondMaterials = Array.isArray(d.materials) ? d.materials : [];
        if (woMode === "conditions" && woCondPicker && woCondPicker.tab === "mat") renderWorkOrders();
      }
    } catch { globalThis.DwfErr?.count("work-orders.condition-materials"); }
  }
  // Only exact, server-sent suggestions render. The current server fails closed with an empty list
  // until it can bind an opaque add token to DF's transient native condition-editor vector.
  async function loadWoSuggestions(orderId) {
    woCondSuggestFor = orderId;
    woCondSuggestions = [];
    try {
      const d = await woFetchJson(`/order-suggested-conditions?id=${encodeURIComponent(orderId)}`);
      if (woCondSuggestFor !== orderId) return;
      woCondSuggestions = Array.isArray(d.suggestions) ? d.suggestions : [];
      if (woCondSuggestions.length && woMode === "conditions") renderWorkOrders();
    } catch { globalThis.DwfErr?.count("work-orders.suggestions"); }
  }

  async function loadWorkOrderAuxData() {
    const jobs = [];
    if (!woShopCatalog) jobs.push(["shop catalog", async () => { const d = await woFetchJson("/order-catalog-shops"); woShopCatalog = d.shops || []; }]);
    if (!woPresets) jobs.push(["presets", async () => { const d = await woFetchJson("/order-presets"); woPresets = d.presets || []; }]);
    if (!woTargets) jobs.push(["condition targets", async () => { const d = await woFetchJson("/condition-targets"); woTargets = d.targets || []; }]);
    if (!woWorkshops) jobs.push(["workshops", async () => { const d = await woFetchJson("/order-workshops"); woWorkshops = d.workshops || []; }]);
    for (const [label, fn] of jobs) {
      try {
        await fn();
        // Fire-and-forget prefetch: guard on still being the active tab, or a late resolve stomps another tab.
        if (activeInfoPanel === "workorders") renderWorkOrders();
      } catch (err) {
        if (activeInfoPanel === "workorders") woSetStatus(`Could not load ${label}: ${err.message || err}`, true);
      }
    }
  }

  async function openWorkOrdersPanel() {
    setActiveToolbar("workorders");
    clearBuildPlacement(false);
    activeInfoPanel = "workorders";
    woMode = "list";   // always open on the base orders screen
    clientPanel.className = "visible info-panel";
    if (!WORK_ORDERS_ENABLED) {
      panelContent(clientPanel).innerHTML = `
        <div class="info-window">
          <div class="info-body">
            <div class="info-message">Work Orders are temporarily disabled while the hang is isolated.</div>
          </div>
        </div>`;
      return;
    }
    if (!clientPanel.querySelector(".work-order-cols")) {
      panelContent(clientPanel).innerHTML = `<div class="info-window">${infoTabRowHtml("workorders")}<div class="info-body"><div class="info-message">Loading work orders...</div></div></div>`;
      wireInfoTabRow(clientPanel);
    }
    try {
      await refreshWorkOrders();
      loadWorkOrderAuxData();
    } catch {
      panelContent(clientPanel).innerHTML = `<div class="info-window">${infoTabRowHtml("workorders")}<div class="info-body"><div class="info-message">Work order data unavailable.</div></div></div>`;
      wireInfoTabRow(clientPanel);
    }
  }

  async function refreshWorkOrders() {
    // Awaited, not fire-and-forget: otherwise the first open renders before attribution lands.
    if (typeof attribRefresh === "function") { try { await attribRefresh(); } catch { globalThis.DwfErr?.count("work-orders.attribution"); } }
    const data = await woFetchJson("/orders");
    woHasManager = data.hasManager !== false;
    // Dormant on a host that does not serve them (see the 0082 wire requirements).
    woNow = (data.now && Number.isFinite(Number(data.now.year)))
      ? { year: Number(data.now.year), tick: Number(data.now.tick) } : null;
    woPopulation = Number.isFinite(Number(data.population)) ? Number(data.population) : null;
    woLastOrders = Array.isArray(data.orders) ? data.orders : [];
    if (!woSelectedOrder()) woSelOrderId = woLastOrders.length ? woLastOrders[0].id : null;
    renderWorkOrders();
  }

  function woSetStatus(msg, isErr) {
    const el = document.getElementById("woStatus");
    if (el) { el.textContent = msg || ""; el.className = "work-order-status" + (isErr ? " err" : ""); }
  }

  // ---- Base "list" screen: every order with inline quantity + reorder + conditions. ----
  // A reorder arrow at a list extreme is OMITTED, never blanked and never disabled in place.
  function woReorderHtml(o, index, total) {
    const items = [];
    if (index > 0) items.push({ action: "priorityUp", sprite: "WORK_ORDERS_PRIORITY_UP",
      title: "Move up", dataset: { woMove: o.id, dir: -1 } });
    if (index < total - 1) items.push({ action: "priorityDown", sprite: "WORK_ORDERS_PRIORITY_DOWN",
      title: "Move down", dataset: { woMove: o.id, dir: 1 } });
    if (!items.length) return "";
    return DWFUI.actionButtonsHtml(items, { cls: "dwfui-actions work-order-reorder", ariaLabel: "Order priority" });
  }
  // ---- the list has no standalone amount column -------------------------------------------------
  let woAmtEditId = null;
  // No `label:` -- stepperHtml renders it as a visible caption native does not have. `editId` is an
  // argument, not module state, so the fixture harness can reach the editing state with no DOM.
  function woQtyStepperHtml(o, editId) {
    if (editId != null && Number(editId) === Number(o.id)) {
      return DWFUI.stepperHtml({
        cls: "work-order-qty work-order-qty-editing", art: true, hash: true,
        value: Number(o.amountTotal) || 0, min: 0, max: 9999,
        dataset: { woAmt: o.id },
        plusDataset: { woAmtInc: o.id }, minusDataset: { woAmtDec: o.id },
        hashDataset: { woAmtEnter: o.id },
        ariaLabel: "Quantity",
        // a literal `title` so the hover hint survives the migration AND the ? help reference
        // (which harvests QUOTED LITERALS from source) can still see it. aria-label does neither.
        title: "Quantity (Enter to apply)",
      });
    }
    return `<div class="work-order-qty" role="group" aria-label="Quantity">` +
      DWFUI.actionButtonsHtml([
        { action: "amtEnter", sprite: "WORK_ORDERS_ENTER_AMOUNT", title: "Quantity (Enter to apply)",
          dataset: { woAmtEnter: o.id } },
        { action: "amtInc", sprite: "WORK_ORDERS_INCREASE_AMOUNT", title: "Increase quantity",
          dataset: { woAmtInc: o.id } },
        { action: "amtDec", sprite: "WORK_ORDERS_DECREASE_AMOUNT", title: "Decrease quantity",
          dataset: { woAmtDec: o.id } },
      ], { cls: "dwfui-actions work-order-qty-steps", ariaLabel: "Quantity" }) + `</div>`;
  }
  // The max-shops cell has five presentations: unlimited, singular, plural, editing, editing+hint.
  // Both editing states are keyed on woMaxEditId identity, so only the row under edit shows them.
  let woMaxEditId = null;
  let woMaxEditBuffer = "";
  function woMaxShopsPresentation(o, editId, buffer) {
    if (!woIsAnyShop(o)) return null;
    if (editId != null && Number(editId) === Number(o.id))
      return { state: "editing", text: String(buffer == null ? "" : buffer), hint: true };
    const maxN = Number(o.maxWorkshops) || 0;
    // The unlimited state prints nothing here: woWorkshopLabel already prints "Can use any shop".
    if (maxN < 1) return { state: "unlimited", text: "" };
    if (maxN > 1) return { state: "plural", text: `${maxN} workshops` };
    return { state: "singular", text: `${maxN} workshop` };
  }
  function woMaxShopsHtml(o) {
    const p = woMaxShopsPresentation(o, woMaxEditId, woMaxEditBuffer);
    if (!p) return "";
    const steps = DWFUI.actionButtonsHtml([
      { action: "maxInc", sprite: "WORK_ORDERS_INCREASE_AMOUNT", title: "More workshops", dataset: { woMaxInc: o.id } },
      { action: "maxDec", sprite: "WORK_ORDERS_DECREASE_AMOUNT", title: "Fewer workshops", dataset: { woMaxDec: o.id } },
    ], { cls: "dwfui-actions work-order-maxshops-steps", ariaLabel: "Max workshops" });
    // The cursor is a character in the buffer blinking on a WALL CLOCK, so it keeps blinking while the
    // game is paused; the keystrokes come from a visually-suppressed <input>, the editable exception.
    const value = p.state === "editing"
      ? `<span class="work-order-maxval work-order-maxval-editing">` +
        DWFUI.textInputHtml({ cls: "work-order-maxval-input", value: p.text, maxLength: 3,
          ariaLabel: "Max workshops", dataset: { woMaxInput: o.id } }) +
        `<span class="work-order-maxval-echo">${DWFUI.bitmapTextHtml(p.text)}</span>` +
        `<span class="work-order-text-cursor" data-wo-cursor="max-${o.id}"` +
        `${DWFUI.textCursorVisible() ? "" : " hidden"}>_</span>` +
        `<span class="work-order-maxval-bracket">]</span></span>`
      : `<span class="work-order-maxval">${DWFUI.bitmapTextHtml(p.text)}</span>`;
    // The hint is the row's THIRD GRID LINE and exists ONLY while editing.
    const hint = p.state === "editing"
      ? `<div class="work-order-maxshops-hint">${DWFUI.bitmapTextHtml("Zero means any number of workshops may run this order.")}</div>`
      : "";
    return `<div class="work-order-maxshops" data-wo-max-state="${p.state}" title="Max workshops that may run this order at once (0 = any)">` +
      `${value}<span class="work-order-hash" data-wo-max-edit="${o.id}">#</span>${steps}${hint}</div>`;
  }
  // R17 again: one shared ticker for every blinking text cursor currently mounted. Wall clock, not
  // game ticks -- there is deliberately no pause check here.
  let woCursorTimer = null;
  function mountWoCursors(root) {
    if (woCursorTimer) { clearInterval(woCursorTimer); woCursorTimer = null; }
    if (!root || typeof root.querySelectorAll !== "function") return;
    if (!root.querySelector("[data-wo-cursor]")) return;
    woCursorTimer = setInterval(() => {
      const cursors = root.querySelectorAll("[data-wo-cursor]");
      if (!cursors.length) { clearInterval(woCursorTimer); woCursorTimer = null; return; }
      const on = DWFUI.textCursorVisible();
      cursors.forEach(c => { c.hidden = !on; });
    }, 100);
  }
  function woRenderListScreen(orders, data, options = {}) {
    // The one row (if any) whose quantity is being typed. `options.amountEditId` is the fixture
    // seam; the live screen has no option object and falls through to the module's own state.
    const amtEditId = options.amountEditId !== undefined ? options.amountEditId : woAmtEditId;
    // `null` is filtered by rowHtml, so an off regime removes the column instead of drawing an empty box.
    const showValidation = woShowsValidationRegime(data);
    const rows = orders.length ? orders.map((o, i) => {
      const condN = (Array.isArray(o.itemConditions) ? o.itemConditions.length : 0) +
                    (Array.isArray(o.orderConditions) ? o.orderConditions.length : 0);
      const woAttrib = (typeof attribRowHtml === "function") ? attribRowHtml("order", o.id) : "";
      const amtTxt = Number(o.amountTotal) > 0 ? `${o.amountLeft}/${o.amountTotal}` : "repeating";
      const metaHtml = DWFUI.rawHtml(
        "the native work-order list shows the amount beneath the job name",
        `<span class="work-order-amt-tag">${escapeHtml(amtTxt)}</span>`);
      const sub = [{ cls: "work-order-meta", html: metaHtml }];
      if (woAttrib) sub.push({ cls: "work-order-meta work-order-attrib-line",
        html: DWFUI.rawHtml("multiplayer attribution chip -- a wired superset, kept as its own line", woAttrib) });
      // The conditions tile carries no count badge: native signals "has conditions" by drawing it at all.
      const condBtn = DWFUI.artBtnHtml({
        sprite: "WORK_ORDERS_CONDITIONS", cls: `work-order-icon work-order-cond-btn${condN ? " has" : ""}`,
        dataset: { woConditions: o.id }, title: "Conditions", ariaLabel: "Conditions",
      });
      const removeBtn = DWFUI.artBtnHtml({
        sprite: "WORK_ORDERS_REMOVE", cls: "work-order-icon danger work-order-remove-btn",
        dataset: { woCancel: o.id }, title: "Remove order", ariaLabel: "Remove order",
      });
      // An ABSENT cell renders NOTHING (native omits; it does not blank). `null` is filtered by
      // rowHtml; an empty-string html would still emit an empty cell box, so it must not be used.
      const reorder = woReorderHtml(o, i, orders.length);
      const maxShops = woMaxShopsHtml(o);
      const validation = showValidation ? DWFUI.iconHtml({
        sprite: o.validated === false ? "WORK_ORDERS_NOT_VALIDATED" : "WORK_ORDERS_VALIDATED",
        cls: "work-order-validation", alt: o.validated === false ? "Not validated" : "Manager validated",
      }) : "";
      // WIRE GAP, DECLARED. DEF-503: /orders serves only the current item/material label -- no native
      // eligibility predicate, no choices, and no order-material write route.
      return DWFUI.rowHtml({
        cls: "work-order-order", chassis: "table",
        dataset: { woRow: o.id },
        icon: woStatusIconHtml(o, data ? data.now : undefined),
        label: o.job, labelCls: "work-order-job", copyCls: "work-order-order-main", sub,
        cells: [
          validation ? { cls: "work-order-validation-cell", html: validation } : null,
          { cls: "work-order-qty-cell", html: woQtyStepperHtml(o, amtEditId) },
          reorder ? { cls: "work-order-reorder-cell", html: reorder } : null,
          { cls: "work-order-cond-cell", html: condBtn },
          { cls: "work-order-shop-col", html: escapeHtml(woWorkshopLabel(o)) },
          maxShops ? { cls: "work-order-maxshops-cell", html: maxShops } : null,
        ],
        trailing: removeBtn,
      });
    }).join("") : `<div class="work-order-empty">No work orders yet. Click "New work order" to add one.</div>`;
    const newBtn = DWFUI.artBtnHtml({
      sprite: "WORK_ORDERS_CREATE_NEW", cls: "work-order-new-btn",
      dataset: { woNewscreen: "" }, title: "New work order", ariaLabel: "New work order",
    });
    const list = DWFUI.scrollHtml({ cls: "work-order-list", rows: ".work-order-order", preserveKey: "work-orders-list" }, rows);
    return `
      <div class="work-order-screen">
        <div class="work-order-new-slot">${newBtn}</div>
        ${list}
        <div class="work-order-status" id="woStatus"></div>
      </div>`;
  }

  // The tasks shown in the right pane: filtered by search across all shops, else the selected shop.
  function woNewTaskList() {
    const shops = Array.isArray(woShopCatalog) ? woShopCatalog : [];
    const q = (woSearch || "").trim();
    const out = [], seen = new Set();
    const push = it => { if (!seen.has(it.key)) { seen.add(it.key); out.push(it); } };
    if (q) shops.forEach(s => (s.items || []).forEach(it => { if (dfTokenMatch(it.label, q)) push(it); }));
    else if (woSelShop < 0) shops.forEach(s => (s.items || []).forEach(push));
    else if (shops[woSelShop]) (shops[woSelShop].items || []).forEach(push);
    return out;
  }
  function woNewTasksHtml() {
    const tasks = woNewTaskList();
    if (!tasks.length) return `<div class="work-order-empty">No tasks here.</div>`;
    // The catalog is large (per-metal forge rows + every raws reaction); cap the DOM and let the
    // DF-style search narrow it.
    const CAP = 300;
    const shown = tasks.slice(0, CAP);
    const rows = shown.map(it => DWFUI.rowHtml({
      tag: "button", cls: "work-order-task", chassis: "slab", selected: it.key === woSelKey,
      dataset: { woTask: it.key }, label: it.label,
    })).join("");
    return tasks.length > shown.length
      ? rows + `<div class="work-order-empty">Showing ${shown.length} of ${tasks.length} &mdash; type to narrow (e.g. "iron cage").</div>`
      : rows;
  }

  function woBackButtonHtml() {
    return DWFUI.plaqueBtnHtml({
      label: "← Back", tone: "grey", cls: "work-order-btn secondary",
      dataset: { woBacklist: "" }, title: "Back to the order list",
    });
  }

  // ---- "new" screen: DF-style picker -- workshops (with icons) on the left, their tasks on the right ----
  function woRenderNewScreen() {
    const shops = Array.isArray(woShopCatalog) ? woShopCatalog : [];
    const freqChoices = WO_FREQS.map(f => [f, woFreqLabel(f)]);
    const shopRow = (shop, index, icon) => DWFUI.rowHtml({
      tag: "button", cls: "work-order-shop", chassis: "slab", selected: index === woSelShop,
      dataset: { woShop: index }, icon: `<span class="work-order-shop-icon" style="${bldIconStyle(icon, 18)}"></span>`,
      label: shop,
    });
    const shopBtns = [shopRow("All tasks", -1, "workshops")]
      .concat(shops.map((shop, index) => shopRow(shop.shop, index, shop.icon))).join("");
    // The task filter is the native PANE-HEADER search: it sits at the top of the list pane it
    // filters (F7 placement P2), and it carries the BUTTON_FILTER magnifier sprite, not an emoji.
    const taskSearch = DWFUI.searchHtml({
      cls: "work-order-task-search", inputCls: "work-order-search-input", id: "woSearch",
      placement: "pane-header", magnifier: true, preserveKey: "work-order-task-search",
      value: woSearch, placeholder: "Find a task...", ariaLabel: "Find a task",
    });
    return `
      <div class="work-order-screen">
        <div class="work-order-screen-head">
          ${woBackButtonHtml()}
          <div class="work-order-section-title">New work order</div>
        </div>
        <div class="work-order-newpick">
          ${DWFUI.scrollHtml({ cls: "work-order-shoplist", rows: ".work-order-shop", preserveKey: "work-order-shops" }, shopBtns)}
          <div class="work-order-taskpane">
            ${taskSearch}
            ${DWFUI.scrollHtml({ cls: "work-order-tasks", id: "woTasks", rows: ".work-order-task", preserveKey: "work-order-tasks" }, woNewTasksHtml())}
          </div>
        </div>
        <div class="work-order-form-row">
          <label>Amount</label>
          ${DWFUI.numberEntryHtml({ cls: "work-order-input", id: "woAmount", editing: true,
            text: String(woAmount), min: 1, max: 9999, maxLength: 4, ariaLabel: "Order amount" })}
          <label>Repeat</label>
          ${woCyclerHtml("newFrequency", freqChoices, woFreq,
            { cls: "work-order-frequency", ariaLabel: "Repeat frequency" })}
          ${woCyclerHtml("newWorkshop", woWorkshopChoices("General manager order"), woCreateWorkshop,
            { cls: "work-order-workshop", ariaLabel: "Workshop" })}
          ${DWFUI.plaqueBtnHtml({ label: "Queue order", tone: "green", artTone: "neutral", cls: "work-order-btn", dataset: { woQueue: "" } })}
        </div>
        <div class="work-order-status" id="woStatus"></div>
      </div>`;
  }
  // In-place refresh of just the task pane (so the search box keeps focus while typing).
  function woRefreshTaskPane() {
    const el = document.getElementById("woTasks");
    if (!el) return;
    el.innerHTML = woNewTasksHtml();
    el.querySelectorAll("[data-wo-task]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      woSelKey = b.dataset.woTask;
      el.querySelectorAll("[data-wo-task]").forEach(x => {
        const selected = x.dataset.woTask === woSelKey;
        x.classList.toggle("selected", selected);
        x.classList.toggle("dwfui-row--sel-brackets", selected);
        x.setAttribute("aria-selected", selected ? "true" : "false");
      });
    }));
  }

  const WO_SATISFACTION = {
    satisfied:   { text: "Satisfied for next check",     dfColor: 10 },
    unsatisfied: { text: "Not satisfied for next check", dfColor: 12 },
  };
  function woSatisfactionState(condition) {
    if (!condition || condition.satisfactionSource !== "df-ui") return null;
    if (condition.satisfied === true) return "satisfied";
    if (condition.satisfied === false) return "unsatisfied";
    return null;
  }
  function woSatisfactionHtml(condition) {
    const state = woSatisfactionState(condition);
    if (!state) return "";
    const spec = WO_SATISFACTION[state];
    return DWFUI.statusHtml({
      tag: "span", cls: `work-order-cond-status work-order-cond-status-${state}`,
      text: spec.text, dfColor: spec.dfColor,
      dataset: { woCondStatus: state },
    });
  }

  function woConditionRowHtml(condition, opts) {
    const o = opts || {};
    const kind = o.kind || "item";
    const description = condition?.description || condition?.label || "Condition";
    const state = woSatisfactionState(condition);
    const satisfied = state === "satisfied";
    const idx = Number(condition?.idx);
    const editable = o.editable !== false && o.orderId != null && Number.isFinite(idx);
    let cells = null;
    let trailing = null;
    if (editable) {
      trailing = DWFUI.artBtnHtml({
        sprite: "WORK_ORDERS_REMOVE", cls: "work-order-icon danger work-order-cond-remove",
        dataset: { woRemoveCond: o.orderId, kind, idx },
        title: "Remove condition", ariaLabel: "Remove condition",
      });
    }
    if (editable && kind === "order") {
      // R21: the order condition's ONE control. Two-way enum, so the tile cycles it.
      cells = [
        { cls: "work-order-cond-checktype-cell", html: DWFUI.artBtnHtml({
            sprite: "WORK_ORDERS_CHANGE_ORDER_CONDITION_CHECK_TYPE",
            cls: "work-order-icon work-order-cond-checktype",
            dataset: { woCondChecktype: idx, kind: "order" },
            title: String(condition.type) === "Activated"
              ? "Checks when that order activates (click for completed)"
              : "Checks when that order completes (click for activated)",
            ariaLabel: "Change check type" }) },
      ];
    }
    if (editable && kind === "item") {
      cells = [
        // native count cluster: value [#][+][-] -- same stepper anatomy as the order rows.
        { cls: "work-order-cond-qty-cell", html: DWFUI.stepperHtml({
            cls: "work-order-cond-qty", art: true, hash: true,
            value: Number(condition.value) || 0, min: 0, max: 999999,
            dataset: { woCondVal: idx },
            plusDataset: { woCondValInc: idx }, minusDataset: { woCondValDec: idx },
            hashDataset: { woCondValEnter: idx },
            ariaLabel: "Condition amount", title: "Condition amount (Enter to apply)",
          }) },
        // the native <>=# glyph (WORK_ORDERS_CONDITIONS is that exact cell); cycles the 6 values.
        { cls: "work-order-cond-cmp-cell", html: DWFUI.artBtnHtml({
            sprite: "WORK_ORDERS_CONDITIONS", cls: "work-order-icon work-order-cond-cmp",
            dataset: { woCondCmp: idx },
            title: "Change comparison", ariaLabel: "Change comparison" }) },
        // DF's own boxed-text Type/Mat/Adj tiles (interface_bits_work_orders.png row 3).
        { cls: "work-order-cond-tabs-cell", html: DWFUI.actionButtonsHtml([
            { action: "condType", sprite: "WORK_ORDERS_CHANGE_TYPE", title: "Change item type",
              dataset: { woCondTab: "type", idx } },
            { action: "condMat", sprite: "WORK_ORDERS_CHANGE_MAT", title: "Change material",
              dataset: { woCondTab: "mat", idx } },
            { action: "condAdj", sprite: "WORK_ORDERS_CHANGE_ADJ", title: "Change adjective",
              dataset: { woCondTab: "adj", idx } },
          ], { cls: "dwfui-actions work-order-cond-tabs", ariaLabel: "Condition target" }) },
      ];
    }
    // R25: the annotation is a CELL ON THE SAME LINE, immediately right of the sentence -- never a
    // second line, and never fused into the sentence's own markup (0003's absence guard).
    const annotation = woSatisfactionHtml(condition);
    const allCells = annotation
      ? [{ cls: "work-order-cond-status-cell", html: annotation }].concat(cells || [])
      : cells;
    return DWFUI.rowHtml({
      chassis: "table",
      state: satisfied ? "on" : null,
      cls: `work-order-condition-row${state ? ` is-${state}` : ""}`,
      label: description,
      ariaLabel: state ? `${description}. ${WO_SATISFACTION[state].text}` : description,
      cells: allCells && allCells.length ? allCells : null,
      trailing,
    });
  }

  // PURE for fixtures: `data` overrides the module caches; production callers omit it.
  function woCondPickerHtml(tab, cond, data) {
    const d = data || {};
    let options = [];
    if (tab === "type") {
      options = (d.targets || woTargets || []).map(t => ({ value: t.item, label: t.label,
        on: String(cond.item || "") === String(t.item) }));
    } else if (tab === "mat") {
      options = [{ value: "", label: "Any material", on: !cond.material }]
        .concat((d.materials || woCondMaterials || []).map(m => {
          const value = `${Number(m.matType)}:${Number(m.matIndex)}`;
          return { value, label: `${m.name || "material"} (${Number(m.count) || 0})`,
            on: String(cond.material || "") === value };
        }));
    } else if (tab === "adj") {
      options = WO_ADJECTIVES.map(([key, label]) => ({ value: key, label,
        on: String(cond.adjective || "") === key }));
    }
    const rows = options.map(opt => DWFUI.rowHtml({
      cls: "work-order-cond-pick", state: opt.on ? "on" : null, label: opt.label,
      dataset: { woCondPick: tab, idx: cond.idx, value: opt.value },
    })).join("");
    return `<div class="work-order-cond-picker">${DWFUI.scrollHtml({ cls: "work-order-cond-pick-list" }, rows)}</div>`;
  }

  // Only exact server-sent rows render: never reconstruct a native filter from prose or a field subset.
  function woSuggestionRowsHtml(suggestions, existingConditions) {
    const list = Array.isArray(suggestions) ? suggestions : [];
    const rows = list.map((s, i) => {
      const addAvailable = Boolean(s.token) && !woConditionDuplicate(existingConditions, s, "item");
      return DWFUI.rowHtml({
        chassis: "table", cls: "work-order-suggest-row", label: s.label || "",
        trailing: addAvailable ? DWFUI.artBtnHtml({
          sprite: "WORK_ORDERS_ADD_SUGGESTED_CONDITION", cls: "work-order-icon work-order-suggest-add",
          dataset: { woSuggest: i, woAddSuggestion: i }, title: "Add suggested condition",
          ariaLabel: "Add suggested condition",
        }) : null,
      });
    }).join("");
    const body = rows || `<div class="work-order-empty work-order-suggestions-empty">${DWFUI.bitmapTextHtml("No suggested conditions.")}</div>`;
    return `<div class="work-order-field work-order-suggest work-order-suggestions">` +
      `<div class="work-order-field-title">${DWFUI.bitmapTextHtml("Suggested conditions")}</div>` +
      `<div class="work-order-cond-list">${body}</div></div>`;
  }

  // Frequency renders as one of five full sentences, plus a narrow short set. The status badge groups
  // the same enum into two on purpose -- a five-way picker beside a two-group badge is native.
  const WO_FREQUENCY_SENTENCES = {
    OneTime:    { wide: "Runs once and is then removed; its conditions are checked daily until it can start.",
                  narrow: "Runs once and is then removed." },
    Daily:      { wide: "Restarts every day if it completed; its conditions are checked daily.",
                  narrow: "Restarts every day if it completed." },
    Monthly:    { wide: "Restarts every month if it completed; its conditions are checked daily.",
                  narrow: "Restarts every month if it completed." },
    Seasonally: { wide: "Restarts every season if it completed; its conditions are checked daily.",
                  narrow: "Restarts every season if it completed." },
    Yearly:     { wide: "Restarts every year if it completed; its conditions are checked daily.",
                  narrow: "Restarts every year if it completed." },
  };
  const WO_NARROW_CELLS = 60;
  function woUsableWidthCells() {
    return DWFUI.cellsForElementWidth(
      typeof clientPanel !== "undefined" ? clientPanel : null,
      { content: ".info-main, .info-body",
        document: typeof document !== "undefined" ? document : null,
        unavailable: Infinity });
  }
  function woFrequencySentence(frequency, usableCells) {
    const spec = WO_FREQUENCY_SENTENCES[String(frequency)] || WO_FREQUENCY_SENTENCES.OneTime;
    const cells = Number(usableCells);
    return (Number.isFinite(cells) && cells < WO_NARROW_CELLS) ? spec.narrow : spec.wide;
  }

  // ---- "conditions" screen: read view (wave 1) + in-place editor (wave 2) --------------------
  function woRenderConditionsScreen(selected, orders, suggestions, opts) {
    const editingDraft = Number(woEditOrderId) === Number(selected.id);
    const editAmount = editingDraft ? woEditAmount : (Number(selected.amountTotal) || 0);
    const editFreq = editingDraft ? woEditFreq : selected.frequency;
    const editWorkshop = editingDraft ? woEditWorkshop : selected.workshopId;
    const freqChoices = WO_FREQS.map(f => [f, woFreqLabel(f)]);
    const condRows = (rows, kind) => rows && rows.length
      ? rows.map(c => woConditionRowHtml(c, { orderId: selected.id, kind }) +
          (kind === "item" && woCondPicker && Number(woCondPicker.idx) === Number(c.idx)
            ? woCondPickerHtml(woCondPicker.tab, c) : "")).join("")
      : `<div class="work-order-empty">${DWFUI.bitmapTextHtml("None")}</div>`;
    const o = opts || {};
    // R19: all five frequencies get a sentence, and the narrow layout gets the short set.
    const frequencyDescription = woFrequencySentence(selected.frequency,
      o.usableCells === undefined ? woUsableWidthCells() : o.usableCells);
    // All three top-level controls VANISH while a sub-picker is open -- omitted, never disabled.
    const subPickerOpen = !!(woCondPicker || woOrderCondAdd);
    const condTools = subPickerOpen ? "" : DWFUI.actionButtonsHtml([
      { action: "frequency", sprite: "WORK_ORDERS_CHANGE_FREQUENCY",
        title: "Change how often this order repeats", dataset: { woFreqFocus: "" } },
      { action: "addItemCond", sprite: "WORK_ORDERS_ADD_ITEM_CONDITION",
        title: "New condition", dataset: { woAddItemCond: "" } },
      { action: "addOrderCond", sprite: "WORK_ORDERS_ADD_ORDER_CONDITION", active: woOrderCondAdd,
        title: "New order condition (after another order)", dataset: { woAddOrderCondOpen: "" } },
    ], { cls: "dwfui-actions work-order-cond-tools", ariaLabel: "Add condition" });
    // The "new order condition" chooser: pick the other order; Completed/Activated are DF's only
    // two workquota_order_condition_type values (df.workquota.xml:37).
    let orderCondChooser = "";
    if (woOrderCondAdd) {
      const others = (orders || []).filter(x => Number(x.id) !== Number(selected.id));
      // R18: EACH CANDIDATE ORDER CARRIES ITS OWN STATUS BADGE, under the same R13 law the list
      // uses. That is what makes the badge a shared component rather than a list decoration.
      const otherRows = others.length ? others.map(x => DWFUI.rowHtml({
        cls: "work-order-cond-pick", label: woOrderTitle(x), dataset: { woAddOrderCond: x.id },
        icon: DWFUI.workOrderBadgeHtml(x, o.now === undefined ? woNow : o.now),
      })).join("") : `<div class="work-order-empty">${DWFUI.bitmapTextHtml("No other orders")}</div>`;
      orderCondChooser = `<div class="work-order-cond-picker work-order-ordercond-picker">` +
        DWFUI.segmentedHtml({ dataAttr: "work-order-order-cond-type", active: woOrderCondType,
          ariaLabel: "Condition type", options: [
            { key: "Completed", label: "Completed", title: "Runs after that order completes" },
            { key: "Activated", label: "Activated", title: "Runs once that order activates" },
          ] }) +
        DWFUI.scrollHtml({ cls: "work-order-cond-pick-list" }, otherRows) + `</div>`;
    }
    return `
      <div class="work-order-screen">
        <div class="work-order-screen-head">
          ${woBackButtonHtml()}
          ${DWFUI.workOrderBadgeHtml(selected, o.now === undefined ? woNow : o.now, { cls: "work-order-detail-status" })}
          <div class="work-order-detail-title">${escapeHtml(woOrderTitle(selected))}</div>
          <div class="work-order-cond-tools-slot">${condTools}</div>
        </div>
        <div class="work-order-condition-frequency">${DWFUI.bitmapTextHtml(frequencyDescription)}</div>
        <div class="work-order-detail-grid">
          <div class="work-order-field">
            <div class="work-order-field-title">Amount and repeat</div>
            <div class="work-order-form-row">
              ${DWFUI.numberEntryHtml({ cls: "work-order-input", id: "woEditAmount", editing: true,
                text: String(editAmount), min: 0, max: 9999, maxLength: 4, ariaLabel: "Order amount" })}
              ${woCyclerHtml("editFrequency", freqChoices, editFreq,
                { cls: "work-order-edit-frequency", ariaLabel: "Repeat frequency" })}
              ${DWFUI.plaqueBtnHtml({ label: "Apply", tone: "green", artTone: "neutral", cls: "work-order-btn", dataset: { woApplyOrder: "" } })}
            </div>
          </div>
          <div class="work-order-field">
            <div class="work-order-field-title">Workshop control</div>
            <div class="work-order-form-row">
              ${woCyclerHtml("editWorkshop", woWorkshopChoices("Any matching workshop"), editWorkshop,
                { cls: "work-order-edit-workshop", ariaLabel: "Workshop" })}
              ${DWFUI.plaqueBtnHtml({ label: "Set", tone: "green", artTone: "neutral", cls: "work-order-btn", dataset: { woApplyWorkshop: "" } })}
            </div>
          </div>
        </div>
        <div class="work-order-field">
          <div class="work-order-field-title">${DWFUI.bitmapTextHtml("Conditions")}</div>
          <div class="work-order-cond-list">${condRows(selected.itemConditions || [], "item")}</div>
        </div>
        ${orderCondChooser}
        ${selected.orderConditions?.length ? `<div class="work-order-field">
          <div class="work-order-field-title">${DWFUI.bitmapTextHtml("Order conditions")}</div>
          <div class="work-order-cond-list">${condRows(selected.orderConditions, "order")}</div>
        </div>` : ""}
        ${woSuggestionRowsHtml(suggestions, selected.itemConditions || [])}
        <div class="work-order-status" id="woStatus"></div>`;
  }

  function workOrdersMarkup(data, options = {}) {
    const orders = Array.isArray(data?.orders) ? data.orders : [];
    const hasManager = data?.hasManager !== false;
    let mode = options.mode || "list";
    const selectedId = Number(options.selectedOrderId);
    const selected = orders.find(order => Number(order.id) === selectedId) || orders[0] || null;
    if (mode === "conditions" && !selected) mode = "list";
    // Order list OR conditions editor, never both: the editor replaces the list, it does not layer over it.
    let body;
    if (!hasManager) body = DWFUI.statusHtml({ cls: "work-order-manager-required", tone: "danger", columns: 48,
      text: "A manager is required to coordinate work orders." });
    else if (mode === "new") body = woRenderNewScreen();
    else if (mode === "conditions") body = woRenderConditionsScreen(selected, orders, options.suggestions,
      { now: data?.now, usableCells: options.usableCells });
    else body = woRenderListScreen(orders, data, { amountEditId: options.amountEditId });
    // Native work orders has NO search box -- never re-add infoSearchBoxHtml to this footer.
    // The footer is state 3 of three exclusive bottom states; woBottomState evaluates the refusal first.
    const bottom = woBottomState(data);
    const footer = bottom === "footer"
      ? `<div class="info-footer work-order-manager-note" data-wo-bottom="footer"><div>All work orders must be validated<br>by the manager before they become<br>active.</div></div>`
      : "";
    return `<div class="info-window" data-wo-bottom-state="${bottom}">${infoTabRowHtml("workorders")}<div class="info-body${hasManager ? "" : " work-order-empty-body"}">${body}</div>${footer}</div>`;
  }

  // Right-click pops exactly one level (chooser -> conditions -> list); activeInfoPanel guards it.
  try {
    const onWorkOrders = () => {
      try { return activeInfoPanel === "workorders"; } catch { return false; }
    };
    window.DwfModeStack.register({
      id: "work-order-chooser", flow: "work-orders", depth: 30,
      active: () => onWorkOrders() && !!(woCondPicker || woOrderCondAdd),
      pop: () => {
        if (!onWorkOrders() || !(woCondPicker || woOrderCondAdd)) return false;
        woCondPicker = null;
        woOrderCondAdd = false;
        renderWorkOrders();
        return true;
      },
    });
    window.DwfModeStack.register({
      id: "work-order-subscreen", flow: "work-orders", depth: 20,
      active: () => onWorkOrders() && (woMode === "conditions" || woMode === "new"),
      pop: () => {
        if (!onWorkOrders() || (woMode !== "conditions" && woMode !== "new")) return false;
        woMode = "list";
        woCondPicker = null;
        woOrderCondAdd = false;
        renderWorkOrders();
        return true;
      },
    });
  } catch { globalThis.DwfErr?.count("work-orders.mode-register"); }

  function renderWorkOrders() {
    const orders = woLastOrders;
    let selected = woSelectedOrder();

    // If we're on the conditions screen but the order vanished (cancelled), fall back to the list.
    if (woMode === "conditions" && !selected) woMode = "list";
    if (woMode === "conditions" && selected && Number(woEditOrderId) !== Number(selected.id))
      woBeginOrderEdit(selected);
    if (woHasManager && woMode !== "new" && woMode !== "conditions") woMode = "list";

    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = workOrdersMarkup(
      { orders, hasManager: woHasManager, population: woPopulation, now: woNow },
      { mode: woMode, selectedOrderId: selected?.id,
        suggestions: (selected && woCondSuggestFor === selected.id) ? woCondSuggestions : [] });
    // Suggestions are fetched once per selected order; woCondSuggestFor is set synchronously in
    // loadWoSuggestions, so the re-render it triggers cannot refetch (no loop).
    if (woMode === "conditions" && selected && woCondSuggestFor !== selected.id)
      loadWoSuggestions(selected.id);

    // ---- handlers (guarded by element/mode existence; absent ones simply no-op) ----
    wireInfoTabRow(clientPanel);
    const newBtn = clientPanel.querySelector("[data-wo-newscreen]");
    if (newBtn) newBtn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); woMode = "new"; woSelKey = null; renderWorkOrders(); });
    clientPanel.querySelectorAll("[data-wo-backlist]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); woMode = "list"; woEditOrderId = null; woCondPicker = null; woOrderCondAdd = false; renderWorkOrders(); }));
    clientPanel.querySelectorAll("[data-wo-conditions]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      woSelOrderId = Number(b.dataset.woConditions); woMode = "conditions";
      woBeginOrderEdit(orders.find(order => Number(order.id) === woSelOrderId));
      woCondPicker = null; woOrderCondAdd = false; renderWorkOrders();
    }));
    clientPanel.querySelectorAll("[data-wo-move]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      try { await woApi("/order-reorder", { id: b.dataset.woMove, dir: b.dataset.dir }); await refreshWorkOrders(); woSetStatus("Priority updated.", false); }
      catch (err) { woSetStatus(err.message || "Could not reorder.", true); }
    }));
    clientPanel.querySelectorAll("[data-wo-amt]").forEach(inp => {
      const apply = async () => {
        const o = orders.find(x => Number(x.id) === Number(inp.dataset.woAmt));
        if (!o) return;
        const amt = Math.max(0, Math.min(9999, Number(inp.value) || 0));
        if (amt === Number(o.amountTotal)) return;
        try { await woApi("/order-adjust", { id: inp.dataset.woAmt, amount: amt, frequency: o.frequency }); await refreshWorkOrders(); woSetStatus("Quantity updated.", false); }
        catch (err) { woSetStatus(err.message || "Could not update quantity.", true); }
      };
      inp.addEventListener("change", apply);
      // Enter commits (blur -> change), Escape abandons. Both leave the edit state, which is what
      // keeps the value cell TRANSIENT rather than a column that came back under another name.
      inp.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); woAmtEditId = null; renderWorkOrders(); }
      });
      inp.addEventListener("blur", () => { woAmtEditId = null; renderWorkOrders(); });
      inp.addEventListener("click", e => e.stopPropagation());
    });
    clientPanel.querySelectorAll("[data-wo-cancel]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      try { await woApi("/order-cancel", { id: Number(b.dataset.woCancel) }); await refreshWorkOrders(); woSetStatus("Order removed.", false); }
      catch (err) { woSetStatus(err.message || "Could not remove order.", true); }
    }));
    // R1: native quantity "# + -" cluster -- step amountTotal by 1 via the same /order-adjust path.
    const woStepAmount = async (id, delta) => {
      const o = orders.find(x => Number(x.id) === Number(id));
      if (!o) return;
      const amt = Math.max(0, Math.min(9999, (Number(o.amountTotal) || 0) + delta));
      if (amt === Number(o.amountTotal)) return;
      try { await woApi("/order-adjust", { id, amount: amt, frequency: o.frequency }); await refreshWorkOrders(); woSetStatus("Quantity updated.", false); }
      catch (err) { woSetStatus(err.message || "Could not update quantity.", true); }
    };
    clientPanel.querySelectorAll("[data-wo-amt-inc]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); woStepAmount(b.dataset.woAmtInc, +1);
    }));
    clientPanel.querySelectorAll("[data-wo-amt-dec]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); woStepAmount(b.dataset.woAmtDec, -1);
    }));
    // R1: per-order max-workshops "# + -" cluster (any-shop rows only), via /order-max-workshops.
    const woStepMaxShops = async (id, delta) => {
      const o = orders.find(x => Number(x.id) === Number(id));
      if (!o) return;
      const next = Math.max(0, Math.min(999, (Number(o.maxWorkshops) || 0) + delta));
      if (next === (Number(o.maxWorkshops) || 0)) return;
      try { await woApi("/order-max-workshops", { id, max: next }); await refreshWorkOrders(); woSetStatus("Max workshops updated.", false); }
      catch (err) { woSetStatus(err.message || "Could not update max workshops.", true); }
    };
    clientPanel.querySelectorAll("[data-wo-max-inc]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); woStepMaxShops(b.dataset.woMaxInc, +1);
    }));
    clientPanel.querySelectorAll("[data-wo-max-dec]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); woStepMaxShops(b.dataset.woMaxDec, -1);
    }));
    clientPanel.querySelectorAll("[data-wo-max-edit]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const id = Number(b.dataset.woMaxEdit);
      const o = orders.find(x => Number(x.id) === id);
      woMaxEditId = woMaxEditId != null && Number(woMaxEditId) === id ? null : id;
      woMaxEditBuffer = woMaxEditId == null ? "" : String(Number(o?.maxWorkshops) || 0);
      renderWorkOrders();
    }));
    const maxInput = clientPanel.querySelector("[data-wo-max-input]");
    if (maxInput) {
      maxInput.focus();
      maxInput.select?.();
      maxInput.addEventListener("input", () => {
        woMaxEditBuffer = String(maxInput.value || "").replace(/[^0-9]/g, "").slice(0, 3);
        if (maxInput.value !== woMaxEditBuffer) maxInput.value = woMaxEditBuffer;
        // Repaint the echo only -- a full re-render would steal focus mid-keystroke.
        const echo = maxInput.parentElement?.querySelector(".work-order-maxval-echo");
        if (echo) echo.outerHTML = `<span class="work-order-maxval-echo">${DWFUI.bitmapTextHtml(woMaxEditBuffer)}</span>`;
      });
      maxInput.addEventListener("keydown", async e => {
        e.stopPropagation();
        if (e.key === "Escape") { woMaxEditId = null; woMaxEditBuffer = ""; renderWorkOrders(); return; }
        if (e.key !== "Enter") return;
        e.preventDefault();
        const id = Number(maxInput.dataset.woMaxInput);
        const next = Math.max(0, Math.min(999, Number(woMaxEditBuffer) || 0));
        woMaxEditId = null; woMaxEditBuffer = "";
        try { await woApi("/order-max-workshops", { id, max: next }); await refreshWorkOrders(); woSetStatus("Max workshops updated.", false); }
        catch (err) { woSetStatus(err.message || "Could not update max workshops.", true); renderWorkOrders(); }
      });
    }
    mountWoCursors(clientPanel);

    // new-order screen wiring (DF-style workshop picker)
    clientPanel.querySelectorAll("[data-wo-shop]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      woSelShop = Number(b.dataset.woShop);
      clientPanel.querySelectorAll("[data-wo-shop]").forEach(x => {
        const selected = Number(x.dataset.woShop) === woSelShop;
        x.classList.toggle("selected", selected);
        x.classList.toggle("dwfui-row--sel-brackets", selected);
        x.setAttribute("aria-selected", selected ? "true" : "false");
      });
      woRefreshTaskPane();
    }));
    const searchIn = document.getElementById("woSearch");
    if (searchIn) searchIn.addEventListener("input", () => { woSearch = searchIn.value || ""; woRefreshTaskPane(); });
    const amtIn = document.getElementById("woAmount");
    if (amtIn) amtIn.addEventListener("input", () => { woAmount = Math.max(1, Math.min(9999, Number(amtIn.value) || 1)); });
    const editAmount = document.getElementById("woEditAmount");
    if (editAmount) editAmount.addEventListener("input", () => {
      woEditAmount = Math.max(0, Math.min(9999, Number(editAmount.value) || 0));
    });
    clientPanel.querySelectorAll("[data-wo-cycle]").forEach(slice => slice.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const value = slice.dataset.woValue;
      if (slice.dataset.woCycle === "newFrequency") woFreq = value;
      else if (slice.dataset.woCycle === "newWorkshop") woCreateWorkshop = value;
      else if (slice.dataset.woCycle === "editFrequency") woEditFreq = value;
      else if (slice.dataset.woCycle === "editWorkshop") woEditWorkshop = value;
      renderWorkOrders();
    }));
    if (woMode === "new") woRefreshTaskPane();
    clientPanel.querySelectorAll("[data-wo-amt-enter]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const id = b.dataset.woAmtEnter;
      const already = woAmtEditId != null && Number(woAmtEditId) === Number(id);
      woAmtEditId = already ? null : Number(id);
      renderWorkOrders();
      if (already) return;
      const inp = clientPanel.querySelector(`[data-wo-amt="${id}"]`);
      if (inp) { inp.focus(); inp.select?.(); }
    }));
    const queueBtn = clientPanel.querySelector("[data-wo-queue]");
    if (queueBtn) queueBtn.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      if (!woSelKey) { woSetStatus("Pick an item to make first.", true); return; }
      woSetStatus("Queuing...", false);
      try {
        const data = await woApi("/order-create", { key: woSelKey, amount: woAmount, frequency: woFreq, workshop: woCreateWorkshop });
        woMode = "list";
        await refreshWorkOrders();
        woSetStatus(data.msg || "Order queued.", false);
      } catch (err) { woSetStatus("Could not queue order: " + (err.message || err), true); }
    });

    // conditions screen wiring
    const applyOrder = clientPanel.querySelector("[data-wo-apply-order]");
    if (applyOrder && selected) applyOrder.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      try {
        await woApi("/order-adjust", { id: selected.id, amount: woEditAmount, frequency: woEditFreq });
        woEditOrderId = null;
        await refreshWorkOrders(); woSetStatus("Order updated.", false);
      } catch (err) { woSetStatus(err.message || "Could not update order.", true); }
    });
    const applyWorkshop = clientPanel.querySelector("[data-wo-apply-workshop]");
    if (applyWorkshop && selected) applyWorkshop.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      try { await woApi("/order-workshop", { id: selected.id, workshop: woEditWorkshop }); woEditOrderId = null; await refreshWorkOrders(); woSetStatus("Workshop updated.", false); }
      catch (err) { woSetStatus(err.message || "Could not update workshop.", true); }
    });
    // ---- condition editor wiring --------------------------------------------------------
    const woSelCond = idx => (selected?.itemConditions || []).find(c => Number(c.idx) === Number(idx));
    const woEditItemCond = async (cond, changes) => {
      if (!selected || !cond) return;
      // Edit-in-place carries the condition's FULL new state (same contract as the lua validator).
      const next = Object.assign({
        id: selected.id, idx: cond.idx,
        compare: cond.compare || "AtLeast", value: Number(cond.value) || 0,
        item: cond.item || "", material: cond.material || "", adjective: cond.adjective || "",
      }, changes);
      try { await woApi("/order-condition-item-edit", next); await refreshWorkOrders(); woSetStatus("Condition updated.", false); }
      catch (err) { woSetStatus(err.message || "Could not update condition.", true); }
    };
    clientPanel.querySelectorAll("[data-wo-cond-val]").forEach(inp => {
      const apply = () => {
        const cond = woSelCond(inp.dataset.woCondVal);
        if (!cond) return;
        const v = Math.max(0, Math.min(999999, Number(inp.value) || 0));
        if (v !== Number(cond.value)) woEditItemCond(cond, { value: v });
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
      inp.addEventListener("click", e => e.stopPropagation());
    });
    const woStepCondVal = (idx, delta) => {
      const cond = woSelCond(idx);
      if (!cond) return;
      const v = Math.max(0, Math.min(999999, (Number(cond.value) || 0) + delta));
      if (v !== Number(cond.value)) woEditItemCond(cond, { value: v });
    };
    clientPanel.querySelectorAll("[data-wo-cond-val-inc]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); woStepCondVal(b.dataset.woCondValInc, +1);
    }));
    clientPanel.querySelectorAll("[data-wo-cond-val-dec]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); woStepCondVal(b.dataset.woCondValDec, -1);
    }));
    // native's `#` tile means "enter the amount": focus+select the row's editable value cell.
    clientPanel.querySelectorAll("[data-wo-cond-val-enter]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const inp = clientPanel.querySelector(`[data-wo-cond-val="${b.dataset.woCondValEnter}"]`);
      if (inp) { inp.focus(); inp.select?.(); }
    }));
    // comparison toggle: cycle DF's 6 enum values in enum order.
    clientPanel.querySelectorAll("[data-wo-cond-cmp]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const cond = woSelCond(b.dataset.woCondCmp);
      if (!cond) return;
      const cur = WO_COMPARE_CYCLE.indexOf(String(cond.compare));
      woEditItemCond(cond, { compare: WO_COMPARE_CYCLE[(cur + 1) % WO_COMPARE_CYCLE.length] });
    }));
    // Type / Mat / Adj open the inline chooser under the row (click again to close).
    clientPanel.querySelectorAll("[data-wo-cond-tab]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const idx = Number(b.dataset.idx);
      const tab = b.dataset.woCondTab;
      woCondPicker = (woCondPicker && woCondPicker.idx === idx && woCondPicker.tab === tab)
        ? null : { idx, tab };
      if (woCondPicker && woCondPicker.tab === "mat") {
        const cond = woSelCond(idx);
        if (cond && woCondMatItem !== (cond.item || "")) loadWoCondMaterials(cond.item || "");
      }
      renderWorkOrders();
    }));
    clientPanel.querySelectorAll("[data-wo-cond-pick]").forEach(row => row.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const cond = woSelCond(row.dataset.idx);
      const tab = row.dataset.woCondPick;
      const value = row.dataset.value || "";
      woCondPicker = null;
      if (!cond) { renderWorkOrders(); return; }
      if (tab === "type") woEditItemCond(cond, { item: value, material: "" }); // mats belong to the old type
      else if (tab === "mat") woEditItemCond(cond, { material: value });
      else if (tab === "adj") woEditItemCond(cond, { adjective: value });
    }));
    // The default for a brand-new condition is not native-attested: a neutral placeholder, edited in place.
    const addItemCondBtn = clientPanel.querySelector("[data-wo-add-item-cond]");
    if (addItemCondBtn && selected) addItemCondBtn.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      const first = (Array.isArray(woTargets) && woTargets[0]) || { item: "BARREL" };
      try {
        const result = await woApi("/order-condition-item-add",
          { id: selected.id, item: first.item, compare: "AtLeast", value: 1 });
        await refreshWorkOrders(); woSetStatus(result.msg || "Condition added.", false);
      } catch (err) { woSetStatus(err.message || "Could not add condition.", true); }
    });
    clientPanel.querySelectorAll("[data-wo-cond-checktype]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      if (!selected) return;
      const idx = Number(b.dataset.woCondChecktype);
      const cond = (selected.orderConditions || []).find(c => Number(c.idx) === idx);
      if (!cond) return;
      const next = String(cond.type) === "Activated" ? "Completed" : "Activated";
      try {
        await woApi("/order-condition-order-edit", { id: selected.id, idx, type: next });
        await refreshWorkOrders(); woSetStatus("Check type updated.", false);
      } catch (err) { woSetStatus(err.message || "Could not change the check type.", true); await refreshWorkOrders(); }
    }));
    clientPanel.querySelectorAll("[data-wo-freq-focus]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      clientPanel.querySelector(".work-order-edit-frequency .dwfui-cycler-slice")?.focus();
    }));
    const addOrderCondOpen = clientPanel.querySelector("[data-wo-add-order-cond-open]");
    if (addOrderCondOpen && selected) addOrderCondOpen.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      woOrderCondAdd = !woOrderCondAdd; renderWorkOrders();
    });
    clientPanel.querySelectorAll("[data-wo-order-cond-type]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      woOrderCondType = b.dataset.woOrderCondType || "Completed"; renderWorkOrders();
    }));
    clientPanel.querySelectorAll("[data-wo-add-order-cond]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      if (!selected) return;
      const candidate = { id: selected.id, other: b.dataset.woAddOrderCond, type: woOrderCondType };
      if (woConditionDuplicate(selected.orderConditions, candidate, "order")) { woSetStatus("That dependency is already on this order.", false); return; }
      try {
        const result = await woApi("/order-condition-order-add", candidate);
        woOrderCondAdd = false;
        await refreshWorkOrders(); woSetStatus(result.msg || "Order condition added.", false);
      } catch (err) { woSetStatus(err.message || "Could not add dependency.", true); }
    }));
    clientPanel.querySelectorAll("[data-wo-suggest]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      if (!selected) return;
      const s = woCondSuggestions[Number(b.dataset.woSuggest)];
      if (!s?.token) { woSetStatus("That suggestion is no longer available.", true); return; }
      if (woConditionDuplicate(selected.itemConditions, s, "item")) { woSetStatus("That condition is already on this order.", false); return; }
      try {
        // The server must re-resolve this opaque token against DF's current same-order native
        // suggestion snapshot and deep-copy the complete filter. No reduced filter crosses back.
        const result = await woApi("/order-condition-suggested-add",
          { id: selected.id, token: s.token });
        await refreshWorkOrders(); woSetStatus(result.msg || "Suggested condition added.", false);
      } catch (err) { woSetStatus(err.message || "Could not add suggestion.", true); }
    }));
    clientPanel.querySelectorAll("[data-wo-remove-cond]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      try { await woApi("/order-condition-remove", { id: b.dataset.woRemoveCond, kind: b.dataset.kind, idx: b.dataset.idx }); await refreshWorkOrders(); woSetStatus("Condition removed.", false); }
      catch (err) { woSetStatus(err.message || "Could not remove condition.", true); }
    }));
  }

  if (typeof module !== "undefined" && module.exports) {
    Object.assign(module.exports, {
      woStatusIconKey, woIsAnyShop, woWorkshopLabel,
      woConditionDuplicate, woConditionRowHtml, woCondPickerHtml, woSuggestionRowsHtml,
      woPopulationRegime, woShowsValidationRegime, woBottomState, WO_VALIDATION_POPULATION,
      woMaxShopsPresentation, woMaxShopsHtml,
      woFrequencySentence, WO_FREQUENCY_SENTENCES, WO_NARROW_CELLS,
      woSatisfactionState, woSatisfactionHtml, WO_SATISFACTION,
      woRenderListScreen, woRenderConditionsScreen, workOrdersMarkup,
    });
  }
