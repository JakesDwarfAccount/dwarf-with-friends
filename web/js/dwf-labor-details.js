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

  // ---- Interactive Labor tab (Work details), backed by /labor* endpoints ----
  let laborSelected = 0; // index of the selected work detail
  let laborEditingTasks = false;
  let laborSortKey = "skill";
  let laborSearch = "";
  let laborCreatingDetail = false;
  let laborCreateName = "";
  let laborRenderToken = 0;
  let laborSelectStartedAt = null;
  const LABOR_SELECT_MEASURE = "dwf-ui-f08-work-detail-select";
  const LABOR_INITIAL_ROWS = 0;
  const LABOR_APPEND_ROWS = 24;

  // THE one failure test: a response failed if the status is non-2xx OR its body says ok:false.
  // Every write on this screen routes through here, so a 500 can never read as success.
  async function laborPost(url, label) {
    const r = await fetch(url, { method: "POST", cache: "no-store" });
    let data = null;
    try { data = await r.json(); } catch { globalThis.DwfErr?.count("labor-details.post-response-parse"); }
    if (!r.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || `${label || "Labor update"} failed (HTTP ${r.status})`);
    }
    return data || {};
  }

  function laborCategoryColor(task) {
    // The category-name -> hue table formerly here was inherited guesswork. Only accept a future
    // server-provided native index; the current payload therefore falls back to uncoloured text.
    const idx = task && task.color;
    return Number.isInteger(idx) && idx >= 0 && idx <= 15 ? DWFUI.dfColor(idx) : "";
  }
  function laborProfessionColorStyle(row) {
    const idx = row && row.professionColor;
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) return "";
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }

  async function openLaborPanel() {
    setActiveToolbar("labor");
    activeInfoPanel = "labor";
    clientPanel.className = "visible info-panel";
    if (!clientPanel.querySelector(".labor-grid, .labor-task-panel")) {
      panelContent(clientPanel).innerHTML = DWFUI.windowHtml({ primaryTabs: infoTabRowHtml("labor"),
        bodyHtml: `<div class="info-body"><div class="info-message">Loading labor...</div></div>` });
      wireInfoTabRow(clientPanel);
    }
    try {
      const r = await fetch(`/labor?detail=${laborSelected}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error("labor failed");
      renderLaborPanel(await r.json());
    } catch {
      panelContent(clientPanel).innerHTML = DWFUI.windowHtml({ primaryTabs: infoTabRowHtml("labor"),
        bodyHtml: `<div class="info-body"><div class="info-message">Labor data unavailable.</div></div>` });
      wireInfoTabRow(clientPanel);
    }
  }

  const LABOR_SECTIONS = ["Work Details", "Standing orders", "Kitchen", "Stone use"];
  function laborSectionTabsHtml(active = "Work Details") {
    return DWFUI.tabsHtml({
      cls: "info-section-tabs", tabCls: "info-tab", dataAttr: "labor-section", level: "subtab",
      ariaLabel: "Labor section", active,
      tabs: LABOR_SECTIONS.map(label => ({ key: label, label })),
    });
  }

  // Native's grey slab with green copy is the SAME control Squads uses for Positions / Equip /
  // Schedule. Keep one renderer: all chrome belongs to DWFUI.plaqueBtnHtml.
  function laborAddDetailButtonHtml() {
    return DWFUI.plaqueBtnHtml({
      label: "Add new work detail", tone: "green", artTone: "neutral",
      cls: "labor-add", dataset: { laborAdd: "" },
    });
  }

  // /labor-create takes the name, so no temporary "Custom Detail" exists between create and rename.
  function laborCreateDetailHtml(name) {
    const input = DWFUI.textInputHtml({
      cls: "labor-name-input", id: "laborCreateName", value: name || "", maxLength: 64,
      placeholder: "Work detail name", ariaLabel: "New work detail name",
      dataset: { laborCreateName: "" },
    });
    const cancel = DWFUI.plaqueBtnHtml({
      label: "Cancel", tone: "grey", artTone: "neutral", cls: "labor-create-cancel",
      dataset: { laborCreateCancel: "" },
    });
    const create = DWFUI.plaqueBtnHtml({
      label: "Create", tone: "green", artTone: "confirm", cls: "labor-create-confirm",
      dataset: { laborCreateConfirm: "" },
    });
    return `<div class="labor-create-detail" data-labor-create-panel>` +
      `<div class="labor-create-prompt">${DWFUI.bitmapTextHtml("Name the new work detail")}</div>` +
      `<div class="labor-create-row">${input}<div class="labor-head-actions">${cancel}${create}</div></div>` +
      `</div>`;
  }

  function laborFilterRows(rows, needle) {
    const list = Array.isArray(rows) ? rows : [];
    const query = String(needle == null ? "" : needle).trim();
    if (!query) return list.slice();
    const matcher = typeof dfTokenMatch === "function"
      ? dfTokenMatch
      : (value, term) => String(value || "").toLowerCase().includes(String(term || "").toLowerCase());
    return list.filter(row => matcher(
      `${row.name || ""} ${row.skillLabel || ""} ${row.assignedTo || ""}`, query));
  }

  function laborSearchHtml(value) {
    return DWFUI.searchHtml({
      cls: "info-search labor-search", inputCls: "info-search-input",
      placement: "footer", magnifier: true, type: "search", dataAttr: "labor-search",
      value: value || "", ariaLabel: "Search citizens in this work detail",
      preserveKey: "labor-work-detail-units",
    });
  }

  function laborSortedRows(data, options = {}) {
    const rows = laborFilterRows(data?.rows, options.search);
    const sortKey = ["name", "skill"].includes(options.sortKey) ? options.sortKey : "skill";
    return rows.slice().sort((a, b) => {
      if (sortKey === "skill") {
        const delta = (Number(b.skill) || 0) - (Number(a.skill) || 0);
        if (delta) return delta;
      }
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  // ---- One call site per native control. ----
  const LABOR_MODE_OPTIONS = [
    { key: "1", label: "Everybody does this" },
    { key: "3", label: "Only selected do this" },
    { key: "2", label: "Nobody does this" },
  ];
  function laborModeRowHtml(mode) {
    return DWFUI.segmentedHtml({
      cls: "labor-mode-row", dataAttr: "labor-mode", ariaLabel: "Who does this work detail",
      active: String(mode), options: LABOR_MODE_OPTIONS,
    });
  }
  // `specialist` = "only does its assigned work details" = WORKER_ONLY_DO_ASSIGNED_JOBS (red, closed).
  function laborSpecLatchHtml(r) {
    return DWFUI.latchHtml({
      cls: "labor-spec", on: !!r.specialist,
      sprite: "WORKER_DO_ANY_AVAILABLE_JOB", activeSprite: "WORKER_ONLY_DO_ASSIGNED_JOBS",
      dataset: { laborSpec: r.id, spec: r.specialist ? 1 : 0 }, hotkey: "Ctrl+z",
      title: r.specialist
        ? "Locked: only does its assigned work details (click to allow any free task)"
        : "Unlocked: does any free task (click to lock to assigned work)",
    });
  }
  function laborAssignCheckHtml(r, onlySel) {
    return DWFUI.checkHtml({
      cls: "labor-check", checked: !!r.assigned, disabled: !onlySel,
      sprite: "LABOR_WORKER_UNASSIGNED", activeSprite: "LABOR_WORKER_ASSIGNED",
      dataset: { laborToggle: r.id, on: r.assigned ? 1 : 0 },
      title: onlySel ? "Toggle assignment" : "Set mode to 'Only selected' to assign individuals",
    });
  }
  function laborTaskCheckHtml(t) {
    return DWFUI.checkHtml({
      cls: "labor-task-check", checked: !!t.allowed,
      sprite: "LABOR_WORKER_UNASSIGNED", activeSprite: "LABOR_WORKER_ASSIGNED",
      dataset: { laborTask: Number(t.id), on: t.allowed ? 1 : 0 },
      title: t.allowed ? "Task allowed" : "Task not allowed",
    });
  }
  // The header cluster: quill = rename, gear = edit work detail (both attested in the oracle).
  // Protected built-ins may edit their allowed task set, but their name and existence stay locked.
  function laborHeadActionsHtml(sel, editingTasks) {
    const quill = DWFUI.artBtnHtml({
      spriteCrop: "quillTile", cls: "labor-icon-btn", dataset: { laborSaveName: "" },
      title: "Rename work detail", ariaLabel: "Rename work detail", disabled: !!sel.noModify,
    });
    const gear = DWFUI.artBtnHtml({
      sprite: "LABOR_EDIT_WORK_DETAIL", cls: "labor-icon-btn", active: !!editingTasks,
      dataset: { laborEditTasks: "" }, title: "Select tasks", ariaLabel: "Select tasks",
    });
    const del = sel.noModify ? ""
      : DWFUI.plaqueBtnHtml({
          label: "Delete", tone: "red", artTone: "destructive", cls: "labor-delete",
          dataset: { laborDelete: "" }, title: "Delete work detail",
        });
    return `<div class="labor-head-actions">${quill}${gear}${del}</div>`;
  }

  function laborRowHtml(r, onlySel) {
    const portrait = typeof unitPortraitMarkup === "function"
      ? unitPortraitMarkup(
          { id: r.id, name: r.name, portraitTexpos: r.portraitTexpos },
          "info-portrait-small")
      : `<span class="info-portrait-small" aria-hidden="true">${escapeHtml(String(r.name || "?").charAt(0))}</span>`;
    return DWFUI.rowHtml({
      cls: "labor-row", copyCls: "labor-copy",
      icon: portrait,
      labelHtml: `<span class="labor-name" data-unit-id="${escapeHtml(r.id)}"${laborProfessionColorStyle(r)}>${DWFUI.bitmapTextHtml(r.name || "")}</span>`,
      sub: r.assignedTo
        ? { cls: "labor-assigned", html: DWFUI.bitmapTextHtml(r.assignedTo) }
        : null,
      cells: [
        { cls: "labor-skill", html: DWFUI.bitmapTextHtml(r.skillLabel || "") },
        { cls: "labor-col-spec", html: laborSpecLatchHtml(r) },
        { cls: "labor-col-do", html: laborAssignCheckHtml(r, onlySel) },
      ],
    });
  }

  function laborPanelMarkup(data, options = {}) {
    const details = Array.isArray(data?.details) ? data.details : [];
    const selected = data?.selected;
    const sel = details.find(d => d.index === selected) || null;
    const mode = sel ? sel.mode : 0;
    const onlySel = mode === 3;
    const sortKey = ["name", "skill"].includes(options.sortKey) ? options.sortKey : "skill";
    const sortedRows = laborSortedRows(data, options);
    const rowLimit = Number.isInteger(options.rowLimit)
      ? Math.max(0, options.rowLimit) : sortedRows.length;
    const mountedRows = sortedRows.slice(0, rowLimit);
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    const editingTasks = !!options.editingTasks && !!sel;
    const sectionTabs = laborSectionTabsHtml("Work Details");
    const detailRows = details.map(d => `
      <div class="info-side-item labor-wd${d.index === selected ? " selected dwfui-focus-brackets" : ""}" data-labor-detail="${d.index}">${DWFUI.workDetailIconHtml(d.iconKey, { cls: "labor-wd-icon", alt: d.name || "Work detail" }) || `<span></span>`}<strong class="labor-wd-name">${escapeHtml(d.name)}</strong></div>`).join("");
    const sideList = `<div class="info-side-list labor-side">${laborAddDetailButtonHtml()}${DWFUI.scrollHtml({
      cls: "labor-wd-list", rows: ".labor-wd", preserveKey: "labor-work-details", ariaLabel: "Work details",
    }, detailRows)}</div>`;
    const modeRow = sel ? laborModeRowHtml(mode) : "";
    const grid = mountedRows.map(r => laborRowHtml(r, onlySel)).join("") ||
      (String(options.search || "").trim()
      ? `<div class="dwfui-text--empty labor-empty">${DWFUI.bitmapTextHtml("No matches.")}</div>` : "");
    let lastTaskCat = "";
    const taskRows = tasks.map(t => {
      const cat = t.category || "Other";
      const color = laborCategoryColor(t);
      // A missing task.color means the server has not supplied DF's draw color. currentColor keeps
      // both copy and rule neutral instead of falling through to the old hand-picked category hue.
      const colorStyle = ` style="--labor-cat:${color || "currentColor"}"`;
      const heading = cat !== lastTaskCat ? `<div class="labor-task-cat"${colorStyle}>${escapeHtml(cat)}</div>` : "";
      lastTaskCat = cat;
      return `${heading}<div class="labor-task-row"${colorStyle}><div class="labor-task-name">${escapeHtml(t.name || t.key || `Labor ${t.id}`)}</div><div class="labor-task-meta">${escapeHtml(t.skillName || t.key || "")}</div><div class="labor-task-native">${DWFUI.workDetailIconHtml(t.iconKey, { alt: t.name || t.key || "Labor" })}</div>${laborTaskCheckHtml(t)}</div>`;
    }).join("") || `<div class="dwfui-text--empty labor-empty">No tasks available.</div>`;
    const header = sel ? `<div class="labor-detail-head"><div class="labor-name-wrap">${DWFUI.textInputHtml({ cls: "labor-name-input", id: "laborNameInput", value: sel.name, maxLength: 64, ariaLabel: "Work detail name", disabled: !!sel.noModify })}${sel.skillName ? `<span class="labor-detail-skill">${escapeHtml(sel.skillName)}</span>` : ""}</div>${laborHeadActionsHtml(sel, editingTasks)}</div>` : `<div class="info-message">Select a work detail.</div>`;
    const tasksDone = DWFUI.plaqueBtnHtml({
      label: "Done", tone: "red", cls: "labor-tasks-done",
      dataset: { laborTasksDone: "" }, title: "Done",
    });
    const taskPanel = sel ? `<div class="labor-task-panel"><div class="labor-task-toolbar"><div class="labor-task-title">${DWFUI.bitmapTextHtml("Tasks")}</div>${tasksDone}</div>${DWFUI.scrollHtml({
      cls: "labor-task-list", rows: ".labor-task-row", ariaLabel: "Work detail tasks",
      preserveKey: `labor-tasks-${selected}`,
    }, taskRows)}</div>` : "";
    const sortHeader = sel ? DWFUI.sortHeaderHtml({
      cls: "labor-grid-head", active: sortKey, dataAttr: "labor-sort", ariaLabel: "Sort citizens",
      columns: [
        { key: "name", label: "Name" },
        { key: "skill", title: "Sort by skill" },
      ],
    }) : "";
    // The name track (column 1) yields on a narrow pane, so skill, latch and check stay in view.
    const assignmentPanel = modeRow + sortHeader + DWFUI.scrollHtml({
      cls: "labor-grid", rows: ".labor-row", ariaLabel: "Citizens in this work detail",
      dataset: {
        dwfuiTable: ".labor-row", dwfuiTableYield: 1, dwfuiTableHead: ".labor-grid-head",
        laborRowsTotal: sortedRows.length, laborRowsMounted: mountedRows.length,
      },
      preserveKey: `labor-detail-${selected}`,
    }, grid);
    const creatingDetail = !!options.creatingDetail;
    const mainContent = creatingDetail
      ? laborCreateDetailHtml(options.createName)
      : (editingTasks ? taskPanel : `${header}${assignmentPanel}`);
    return DWFUI.windowHtml({
      ariaLabel: "Labor", primaryTabs: infoTabRowHtml("labor"), sectionTabs,
      bodyHtml: `<div class="info-body with-side">${sideList}<div class="info-main${editingTasks && !creatingDetail ? " labor-task-host" : ""}" data-dwfui-scroll-key="labor-details">${mainContent}</div></div>`,
      footerHtml: `${creatingDetail ? "" : laborSearchHtml(options.search)}<div>Changes apply to the host fort immediately.</div>`,
    });
  }

  // mountTableColumns is handed the grid's PARENT: its querySelectorAll cannot match the host node.
  // Paint first: an unpainted latch/check measures ~8px and the measured template sticks.
  function laborApplyColumns(grid) {
    if (!grid || !grid.isConnected) return;
    try { DWFUI.paintSprites(grid); } catch { globalThis.DwfErr?.count("labor-details.sprite-paint"); }
    try { DWFUI.mountTableColumns(grid.parentElement || clientPanel); } catch { globalThis.DwfErr?.count("labor-details.table-columns"); }
  }

  function appendLaborRosterBatches(data, options, token) {
    const details = Array.isArray(data?.details) ? data.details : [];
    const selected = data?.selected;
    const sel = details.find(d => d.index === selected) || null;
    if (!sel || options.editingTasks || options.creatingDetail) return;
    const rows = laborSortedRows(data, options);
    if (rows.length <= LABOR_INITIAL_ROWS) return;
    const onlySel = sel.mode === 3;
    const grid = clientPanel.querySelector(".labor-grid");
    if (!grid) return;
    let offset = LABOR_INITIAL_ROWS;
    const schedule = callback => {
      const raf = window.requestAnimationFrame;
      if (typeof raf === "function") raf(callback);
      else window.setTimeout(callback, 0);
    };
    const append = () => {
      if (token !== laborRenderToken || !grid.isConnected) return;
      const end = Math.min(rows.length, offset + LABOR_APPEND_ROWS);
      const template = grid.style.gridTemplateColumns;
      grid.insertAdjacentHTML(
        "beforeend", rows.slice(offset, end).map(r => laborRowHtml(r, onlySel)).join(""));
      offset = end;
      grid.dataset.laborRowsMounted = String(offset);
      // Measure on the first batch and again on the last -- only a late long name can widen a column.
      if (!template || offset >= rows.length) laborApplyColumns(grid);
      else grid.querySelectorAll(".labor-row").forEach(row => {
        if (row.style.gridTemplateColumns !== template) row.style.gridTemplateColumns = template;
      });
      if (offset < rows.length) schedule(append);
    };
    schedule(append);
  }

  function renderLaborPanel(data) {
    const details = Array.isArray(data.details) ? data.details : [];
    const selected = data.selected;
    const sel = details.find(d => d.index === selected) || null;
    if (!sel) laborEditingTasks = false;

    const renderToken = ++laborRenderToken;
    const renderOptions = {
      editingTasks: laborEditingTasks,
      sortKey: laborSortKey,
      search: laborSearch,
      creatingDetail: laborCreatingDetail,
      createName: laborCreateName,
      rowLimit: (!laborEditingTasks && !laborCreatingDetail) ? LABOR_INITIAL_ROWS : undefined,
    };

    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = laborPanelMarkup(data, renderOptions);

    wireInfoTabRow(clientPanel);
    DWFUI.restoreScroll(clientPanel);
    function laborSwitchSection(btn, loaderFn) {
      clientPanel.querySelectorAll("[data-labor-section]").forEach(x => x.classList.toggle("active", x === btn));
      const body = clientPanel.querySelector(".info-body");
      if (body) {
        body.classList.remove("with-side");
        body.innerHTML = `<div class="info-main"></div>`;
      }
      // Clear the WHOLE Work Details footer when leaving that section: the other sections have none.
      const footer = clientPanel.querySelector(".info-footer");
      if (footer) footer.replaceChildren();
      loaderFn();
    }
    clientPanel.querySelectorAll("[data-labor-section]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const section = b.dataset.laborSection || "";
      if (section === "Work Details") {
        laborCreatingDetail = false;
        laborCreateName = "";
        laborEditingTasks = false;
        openLaborPanel();
        return;
      }
      laborCreatingDetail = false;
      laborCreateName = "";
      if (section === "Kitchen") { laborSwitchSection(b, refreshKitchen); return; }
      if (section === "Standing orders") { laborSwitchSection(b, window.openStandingOrdersPanel); return; }
      if (section === "Stone use") { laborSwitchSection(b, window.openStoneUsePanel); return; }
      laborSwitchSection(b, () => {
        const main = clientPanel.querySelector(".info-main");
        if (main) main.innerHTML = `<div class="info-message">Ask host to set these up</div>`;
      });
    }));
    clientPanel.querySelector("[data-labor-add]")?.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      laborCreatingDetail = true;
      laborEditingTasks = false;
      openLaborPanel();
    });
    const createNameInput = clientPanel.querySelector("[data-labor-create-name]");
    const cancelLaborCreate = () => {
      laborCreatingDetail = false;
      laborCreateName = "";
      openLaborPanel();
    };
    let laborCreateSubmitting = false;
    const submitLaborCreate = async () => {
      if (laborCreateSubmitting) return;
      const name = String(createNameInput?.value || laborCreateName || "").trim();
      if (!name) {
        createNameInput?.focus();
        createNameInput?.setCustomValidity?.("Enter a work detail name.");
        createNameInput?.reportValidity?.();
        return;
      }
      createNameInput?.setCustomValidity?.("");
      laborCreateSubmitting = true;
      if (createNameInput) createNameInput.disabled = true;
      const createButton = clientPanel.querySelector("[data-labor-create-confirm]");
      if (createButton) createButton.disabled = true;
      try {
        const created = await laborPost(`/labor-create?name=${encodeURIComponent(name)}`);
        if (Number.isInteger(Number(created.index))) laborSelected = Number(created.index);
        laborCreatingDetail = false;
        laborCreateName = "";
        laborEditingTasks = false;
      } catch (err) {
        laborCreateSubmitting = false;
        window.alert(err.message || "Could not create work detail");
      }
      openLaborPanel();
    };
    createNameInput?.addEventListener("input", () => {
      laborCreateName = createNameInput.value || "";
      createNameInput.setCustomValidity?.("");
    });
    createNameInput?.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        cancelLaborCreate();
      } else if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        submitLaborCreate();
      }
    });
    clientPanel.querySelector("[data-labor-create-cancel]")?.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      cancelLaborCreate();
    });
    clientPanel.querySelector("[data-labor-create-confirm]")?.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      submitLaborCreate();
    });
    clientPanel.querySelectorAll("[data-labor-detail]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      laborSelectStartedAt = performance.now();
      performance.clearMeasures?.(LABOR_SELECT_MEASURE);
      laborSelected = Number(b.dataset.laborDetail);
      laborCreatingDetail = false;
      laborCreateName = "";
      laborEditingTasks = false;
      openLaborPanel();
    }));
    clientPanel.querySelectorAll("[data-labor-sort]").forEach(button => button.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      laborSortKey = button.dataset.laborSort || "name";
      openLaborPanel();
    }));
    const laborSearchInput = clientPanel.querySelector("[data-labor-search]");
    laborSearchInput?.addEventListener("input", () => {
      laborSearch = laborSearchInput.value || "";
      renderLaborPanel(data);
      const next = clientPanel.querySelector("[data-labor-search]");
      if (next) {
        next.focus();
        try { next.setSelectionRange(next.value.length, next.value.length); } catch { globalThis.DwfErr?.count("labor-details.create-search-caret"); }
      }
    });
    const nameInput = clientPanel.querySelector("#laborNameInput");
    const saveLaborName = async () => {
      if (!sel || !nameInput || sel.noModify) return;
      const name = String(nameInput.value || "").trim();
      if (!name) {
        nameInput.value = sel.name || "";
        return;
      }
      try {
        await laborPost(`/labor-rename?detail=${selected}&name=${encodeURIComponent(name)}`);
      } catch (err) {
        window.alert(err.message || "Could not rename work detail");
      }
      openLaborPanel();
    };
    clientPanel.querySelector("[data-labor-save-name]")?.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      saveLaborName();
    });
    nameInput?.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        saveLaborName();
      }
    });
    clientPanel.querySelector("[data-labor-edit-tasks]")?.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      if (!sel) return;
      laborEditingTasks = !laborEditingTasks;
      openLaborPanel();
    });
    clientPanel.querySelector("[data-labor-tasks-done]")?.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      laborEditingTasks = false;
      openLaborPanel();
    });
    clientPanel.querySelector("[data-labor-delete]")?.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      if (!sel || sel.noModify) return;
      if (!window.confirm(`Delete ${sel.name}?`)) return;
      try {
        await laborPost(`/labor-delete?detail=${selected}`);
        laborSelected = details.length > 1 ? Math.max(0, selected - 1) : 0;
        laborEditingTasks = false;
      } catch (err) {
        window.alert(err.message || "Could not delete work detail");
      }
      openLaborPanel();
    });
    clientPanel.querySelectorAll("[data-labor-task]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      const id = Number(b.dataset.laborTask);
      const newOn = b.dataset.on === "1" ? 0 : 1;
      try {
        await laborPost(`/labor-task-toggle?detail=${selected}&labor=${id}&on=${newOn}`);
      } catch (err) {
        window.alert(err.message || "Could not update task");
      }
      laborEditingTasks = true;
      openLaborPanel();
    }));
    clientPanel.querySelectorAll("[data-labor-mode]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      try { await laborPost(`/labor-mode?detail=${selected}&mode=${Number(b.dataset.laborMode)}`, "Work-detail mode"); }
      catch (err) { globalThis.DwfOrder.lost("labor.mode", err, "That work-detail mode change"); }
      openLaborPanel();
    }));
    const laborGrid = clientPanel.querySelector(".labor-grid");
    laborGrid?.addEventListener("click", async e => {
      const b = e.target?.closest?.(
        "[data-labor-toggle], [data-labor-spec], .labor-name[data-unit-id]");
      if (!b || !laborGrid.contains(b)) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.matches("[data-labor-toggle]")) {
        if (b.classList.contains("disabled")) return;
        const id = Number(b.dataset.laborToggle);
        const newOn = b.dataset.on === "1" ? 0 : 1;
        try {
          await laborPost(`/labor-toggle?detail=${selected}&unit=${id}&on=${newOn}`, "Labour change");
        } catch (err) { globalThis.DwfOrder.lost("labor.toggle", err, "That labour change"); }
        openLaborPanel();
        return;
      }
      if (b.matches("[data-labor-spec]")) {
        const id = Number(b.dataset.laborSpec);
        const newOn = b.dataset.spec === "1" ? 0 : 1;
        try {
          await laborPost(`/labor-specialist?unit=${id}&on=${newOn}`, "Specialist change");
        } catch (err) { globalThis.DwfOrder.lost("labor.specialist", err, "That specialist change"); }
        openLaborPanel();
        return;
      }
      const id = Number(b.dataset.unitId);
      if (Number.isInteger(id) && id >= 0) openUnitById(id);
    });

    appendLaborRosterBatches(data, renderOptions, renderToken);
    if (laborSelectStartedAt != null) {
      const selectDuration = performance.now() - laborSelectStartedAt;
      const measuredGrid = clientPanel.querySelector(".labor-grid");
      if (measuredGrid) measuredGrid.dataset.laborSelectMs = selectDuration.toFixed(3);
      try {
        performance.measure(LABOR_SELECT_MEASURE, {
          start: laborSelectStartedAt,
          end: performance.now(),
        });
      } catch { globalThis.DwfErr?.count("labor.perf-measure"); }
      laborSelectStartedAt = null;
    }
  }


  if (typeof module !== "undefined" && module.exports) {
    Object.assign(module.exports, {
      laborPanelMarkup, laborCreateDetailHtml, laborFilterRows, laborSearchHtml,
      laborSortedRows, laborRowHtml, LABOR_INITIAL_ROWS, LABOR_APPEND_ROWS,
    });
  }
