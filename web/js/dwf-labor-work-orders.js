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
  // WD-17: labor-hammer shortcut target (Creatures row -> "open Labor tab for this unit").
  // One-shot: if the unit is in the CURRENTLY selected work detail's roster, renderLaborPanel
  // scrolls to and flashes their row, then clears this; otherwise it's just plain navigation
  // (the unit may belong to a different work detail -- full auto-select-their-detail is
  // deferred, this shortcut still gets the player to the Labor tab).
  let laborFocusUnitId = -1;

  function focusLaborOnUnit(unitId) {
    laborFocusUnitId = Number(unitId);
    laborEditingTasks = false;
    openLaborPanel();
  }

  async function laborPost(url) {
    const r = await fetch(url, { method: "POST", cache: "no-store" });
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || "Labor update failed");
    }
    return data || {};
  }

  // Native DF work-detail icons from graphics_interface.txt:
  // INTERFACE_BITS_LABOR uses 8x12 cells; these coords are tile coords.
  const LABOR_ICON_CELL = {
    MINERS:[20,0], WOODCUTTERS:[24,0], HUNTERS:[28,0], PLANTERS:[20,6],
    FISHERMEN:[24,6], STONECUTTERS:[32,0], ENGRAVERS:[36,0],
    PLANT_GATHERERS:[40,0], HAULERS:[44,0], ORDERLIES:[48,0],
    SIEGE_OPERATORS:[12,6], CUSTOM_1:[20,3], CUSTOM_2:[24,3],
    CUSTOM_3:[28,3], CUSTOM_4:[32,3], CUSTOM_5:[36,3],
    CUSTOM_6:[40,3], CUSTOM_7:[44,3], CUSTOM_8:[48,3]
  };
  function laborIconStyle(iconKey, width = 32) {
    const key = String(iconKey || "").toUpperCase();
    const c = LABOR_ICON_CELL[key];
    if (!c) return "";
    const scale = width / 32;
    const height = 36 * scale;
    return `width:${width}px;height:${height}px;background-size:${416*scale}px ${144*scale}px;` +
      `background-position:-${c[0]*8*scale}px -${c[1]*12*scale}px`;
  }
  function laborIconMarkup(iconKey, cls, width = 32) {
    const st = laborIconStyle(iconKey, width);
    return st ? `<span class="${cls}" style="${st}"></span>` : "";
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
      // WD-16: keep the shared tab row mounted during the initial load too (same fix as
      // openPanel's /panel path in dwf-build-info-panels.js).
      panelContent(clientPanel).innerHTML = `<div class="info-window">${infoTabRowHtml("labor")}<div class="info-body"><div class="info-message">Loading labor...</div></div></div>`;
      wireInfoTabRow(clientPanel);
    }
    try {
      const r = await fetch(`/labor?detail=${laborSelected}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error("labor failed");
      renderLaborPanel(await r.json());
    } catch (_) {
      panelContent(clientPanel).innerHTML = `<div class="info-window">${infoTabRowHtml("labor")}<div class="info-body"><div class="info-message">Labor data unavailable.</div></div></div>`;
      wireInfoTabRow(clientPanel);
    }
  }

  const LABOR_SECTIONS = ["Work Details", "Standing orders", "Kitchen", "Stone use"];
  // Matrix §3 F3: Labor row 2 = `SHORT_SUBTAB` (Work details/Standing orders/Kitchen/Stone use);
  // §4 S3 W3. => level 'subtab'.
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

  // ---- W5 migration helpers: one call site per native control ------------------------------------
  // 16-labor-workdetails.png (clean vanilla oracle, no DFHack widget anywhere) is the anchor for
  // every control below: the segmented mode row (gold corner brackets on the selected segment), the
  // per-unit GREEN OPEN PADLOCK latch, the 2-state assignment check tile, and the header's
  // quill (rename) + gear (edit work detail) tiles.
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
  // PB-03. The two states are two DIFFERENT sprites, not one control saying yes/no -> latchHtml.
  // `specialist` = "only does its assigned work details" = WORKER_ONLY_DO_ASSIGNED_JOBS (red, closed).
  // Native attests Ctrl+z for this control in `residents specialty.png`; it is passed ONLY here.
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
  // The DELETE tile is OUR SUPERSET (native has no delete) and has no attested art token, so it
  // stays a hand-built tile rather than being dressed in a sprite that means something else.
  function laborHeadActionsHtml(sel, editingTasks) {
    const quill = DWFUI.artBtnHtml({
      art: "tileQuill", cls: "labor-icon-btn", dataset: { laborSaveName: "" },
      title: "Rename work detail", ariaLabel: "Rename work detail", disabled: !!sel.noModify,
    });
    const gear = DWFUI.artBtnHtml({
      sprite: "LABOR_EDIT_WORK_DETAIL", cls: "labor-icon-btn", active: !!editingTasks,
      dataset: { laborEditTasks: "" }, title: "Select tasks", ariaLabel: "Select tasks",
      disabled: !!sel.noModify,
    });
    const del = sel.noModify ? ""
      : `<button class="labor-icon-btn danger" data-labor-delete title="Delete work detail">&times;</button>`;
    return `<div class="labor-head-actions">${quill}${gear}${del}</div>`;
  }

  // Pure markup contract shared by the live Labor panel and Parity Studio. Keeping the complete
  // window in one DOM-free builder prevents the review workspace from drifting from production.
  function laborPanelMarkup(data, options = {}) {
    const details = Array.isArray(data?.details) ? data.details : [];
    const selected = data?.selected;
    const sel = details.find(d => d.index === selected) || null;
    const mode = sel ? sel.mode : 0;
    const onlySel = mode === 3;
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    const editingTasks = !!options.editingTasks && !!sel && !sel.noModify;
    const portrait = unit => typeof unitPortraitMarkup === "function"
      ? unitPortraitMarkup(unit, "info-portrait-small")
      : `<span class="info-portrait-small" aria-hidden="true">${escapeHtml(String(unit.name || "?").charAt(0))}</span>`;
    const sectionTabs = laborSectionTabsHtml("Work Details");
    const sideList = `<div class="info-side-list">${laborAddDetailButtonHtml()}${details.map(d => `
      <div class="info-side-item labor-wd${d.index === selected ? " selected" : ""}" data-labor-detail="${d.index}">${laborIconMarkup(d.iconKey, "labor-wd-icon", 32) || `<span></span>`}<strong class="labor-wd-name">${escapeHtml(d.name)}</strong></div>`).join("")}</div>`;
    const modeRow = sel ? laborModeRowHtml(mode) : "";
    const grid = rows.map(r => `<div class="labor-row">${portrait({ id: r.id, name: r.name, portraitTexpos: r.portraitTexpos })}<div class="labor-namecell"><div class="labor-name" data-unit-id="${r.id}"${laborProfessionColorStyle(r)}>${escapeHtml(r.name)}</div>${r.assignedTo ? `<div class="labor-assigned">${escapeHtml(r.assignedTo)}</div>` : ""}</div><div class="labor-skill">${escapeHtml(r.skillLabel || "")}</div>${laborSpecLatchHtml(r)}${laborAssignCheckHtml(r, onlySel)}</div>`).join("");
    let lastTaskCat = "";
    const taskRows = tasks.map(t => {
      const cat = t.category || "Other";
      const color = laborCategoryColor(t);
      // A missing task.color means the server has not supplied DF's draw color. currentColor keeps
      // both copy and rule neutral instead of falling through to the old hand-picked category hue.
      const colorStyle = ` style="--labor-cat:${color || "currentColor"}"`;
      const heading = cat !== lastTaskCat ? `<div class="labor-task-cat"${colorStyle}>${escapeHtml(cat)}</div>` : "";
      lastTaskCat = cat;
      return `${heading}<div class="labor-task-row"${colorStyle}><div class="labor-task-name">${escapeHtml(t.name || t.key || `Labor ${t.id}`)}</div><div class="labor-task-meta">${escapeHtml(t.skillName || t.key || "")}</div><div class="labor-task-native">${laborIconMarkup(t.iconKey, "labor-task-icon", 24)}</div>${laborTaskCheckHtml(t)}</div>`;
    }).join("") || `<div class="labor-empty">No tasks available.</div>`;
    const header = sel ? `<div class="labor-detail-head"><div class="labor-name-wrap"><input class="labor-name-input" id="laborNameInput" type="text" value="${escapeHtml(sel.name)}" maxlength="64" aria-label="Work detail name"${sel.noModify ? " disabled" : ""}>${sel.skillName ? `<span class="labor-detail-skill">${escapeHtml(sel.skillName)}</span>` : ""}</div>${laborHeadActionsHtml(sel, editingTasks)}</div>` : `<div class="info-message">Select a work detail.</div>`;
    const tasksDone = DWFUI.plaqueBtnHtml({
      label: "Done", tone: "red", cls: "labor-tasks-done",
      dataset: { laborTasksDone: "" }, title: "Done",
    });
    const taskPanel = sel ? `<div class="labor-task-panel"><div class="labor-task-toolbar"><div class="labor-task-title">Tasks</div>${tasksDone}</div><div class="labor-task-list">${taskRows}</div></div>` : "";
    const assignmentPanel = `${modeRow}${sel ? `<div class="labor-grid-head"><span></span><span>Name</span><span>Skill</span><span class="labor-col-spec">Lock</span><span class="labor-col-do">${onlySel ? "Do this" : ""}</span></div>` : ""}<div class="labor-grid">${grid}</div>`;
    return DWFUI.windowHtml({
      ariaLabel: "Labor", primaryTabs: infoTabRowHtml("labor"), sectionTabs,
      bodyHtml: `<div class="info-body with-side">${sideList}<div class="info-main">${header}${editingTasks ? taskPanel : assignmentPanel}</div></div>`,
      footerHtml: `${infoSearchBoxHtml()}<div>Changes apply to the host fort immediately.</div>`,
    });
  }

  function renderLaborPanel(data) {
    const details = Array.isArray(data.details) ? data.details : [];
    const selected = data.selected;
    const sel = details.find(d => d.index === selected) || null;
    if (!sel) laborEditingTasks = false;
    if (sel && sel.noModify) laborEditingTasks = false;

    // W5: this function used to hand-build a COMPLETE SECOND COPY of sideList / modeRow / grid /
    // taskRows / header / taskPanel / assignmentPanel and then render `laborPanelMarkup(...)`
    // instead, never reading any of them. The two copies had already drifted (laborPanelMarkup reads
    // `options.editingTasks`; the dead copy read the module-global `laborEditingTasks`), so an agent
    // editing the dead copy would have seen zero effect on screen. Deleted -- laborPanelMarkup is
    // the single builder and the exported test seam.

    // B66: the task/assignment lists live inside `.info-main` (the scroll container). Toggling a
    // custom-labor task checkbox re-fetches and rebuilds this whole panel, which would snap the
    // list back to the top on every click. Capture the current scroll offset from the OLD DOM
    // (still mounted at this point) and restore it after the rebuild below.
    const prevMainScroll = clientPanel.querySelector(".info-main")?.scrollTop || 0;

    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = laborPanelMarkup(data, { editingTasks: laborEditingTasks });

    wireInfoTabRow(clientPanel);
    // B66: restore the preserved scroll offset now that the new `.info-main` exists. A one-shot
    // scroll+flash below (laborFocusUnitId) intentionally runs AFTER this so an explicit "jump to
    // unit" request still wins over scroll preservation.
    if (prevMainScroll) {
      const restoredMain = clientPanel.querySelector(".info-main");
      if (restoredMain) restoredMain.scrollTop = prevMainScroll;
    }
    // BUGFIX-B (2026-07-07): Standing orders/Kitchen/Stone use are DF full-width panels with
    // NO Work-Details sidebar (ground truth 16b/16c/16d) -- only "Work Details" itself keeps the
    // sideList (16-labor-workdetails.png). The section click handlers used to leave the
    // ".info-body.with-side" wrapper + sideList mounted from the initial Work-Details render and
    // just swap ".info-main"'s contents, so the sidebar bled into every other section. Rebuild
    // the body wrapper per-section instead.
    function laborSwitchSection(btn, loaderFn) {
      clientPanel.querySelectorAll("[data-labor-section]").forEach(x => x.classList.toggle("active", x === btn));
      const body = clientPanel.querySelector(".info-body");
      if (body) {
        body.classList.remove("with-side");
        body.innerHTML = `<div class="info-main"></div>`;
      }
      // Native's Standing orders, Stone use and Kitchen screens have NO generic footer. Clear the
      // complete Work Details footer when leaving that section; removing only its inert search left
      // the invented "Changes apply..." sentence behind. Switching back rebuilds the full shell.
      const footer = clientPanel.querySelector(".info-footer");
      if (footer) footer.replaceChildren();
      loaderFn();
    }
    clientPanel.querySelectorAll("[data-labor-section]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const section = b.dataset.laborSection || "";
      if (section === "Work Details") {
        laborEditingTasks = false;
        openLaborPanel();
        return;
      }
      if (section === "Kitchen") { laborSwitchSection(b, refreshKitchen); return; }
      if (section === "Standing orders") { laborSwitchSection(b, openStandingOrdersPanel); return; }
      if (section === "Stone use") { laborSwitchSection(b, openStoneUsePanel); return; }
      laborSwitchSection(b, () => {
        const main = clientPanel.querySelector(".info-main");
        if (main) main.innerHTML = `<div class="info-message">Ask host to set these up</div>`;
      });
    }));
    clientPanel.querySelector("[data-labor-add]")?.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      try {
        const created = await laborPost("/labor-create");
        if (Number.isInteger(Number(created.index))) laborSelected = Number(created.index);
        laborEditingTasks = true;
      } catch (err) {
        window.alert(err.message || "Could not create work detail");
      }
      openLaborPanel();
    });
    clientPanel.querySelectorAll("[data-labor-detail]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      laborSelected = Number(b.dataset.laborDetail);
      laborEditingTasks = false;
      openLaborPanel();
    }));
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
      if (!sel || sel.noModify) return;
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
      try { await fetch(`/labor-mode?detail=${selected}&mode=${Number(b.dataset.laborMode)}`, { method: "POST", cache: "no-store" }); } catch (_) {}
      openLaborPanel();
    }));
    clientPanel.querySelectorAll("[data-labor-toggle]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      if (b.classList.contains("disabled")) return;
      const id = Number(b.dataset.laborToggle);
      const newOn = b.dataset.on === "1" ? 0 : 1;
      try { await fetch(`/labor-toggle?detail=${selected}&unit=${id}&on=${newOn}`, { method: "POST", cache: "no-store" }); } catch (_) {}
      openLaborPanel();
    }));
    clientPanel.querySelectorAll("[data-labor-spec]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      const id = Number(b.dataset.laborSpec);
      const newOn = b.dataset.spec === "1" ? 0 : 1;
      try { await fetch(`/labor-specialist?unit=${id}&on=${newOn}`, { method: "POST", cache: "no-store" }); } catch (_) {}
      openLaborPanel();
    }));
    clientPanel.querySelectorAll(".labor-name[data-unit-id]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const id = Number(b.dataset.unitId);
      if (Number.isInteger(id) && id >= 0) openUnitById(id);
    }));

    // WD-17 labor-hammer shortcut landing: one-shot scroll+flash of the target unit's row if
    // they're in the roster currently on screen.
    if (laborFocusUnitId >= 0) {
      const targetId = laborFocusUnitId;
      laborFocusUnitId = -1;
      const row = clientPanel.querySelector(`.labor-row [data-unit-id="${targetId}"]`)?.closest(".labor-row");
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.classList.add("labor-row-flash");
        window.setTimeout(() => row.classList.remove("labor-row-flash"), 1600);
      }
    }
  }

  // ---- WD-18: Labor -> Standing orders, backed by ENDPOINT-ADD /standing-orders ----
  let soData = null;      // { groups: [{id,label,items:[{key,label,value}]}] } -- cached
  let soActiveGroup = "workshops";
  let soLoadToken = 0;

  async function openStandingOrdersPanel() {
    const main = clientPanel.querySelector(".info-main");
    if (main) main.innerHTML = `<div class="info-message">Loading standing orders...</div>`;
    const token = ++soLoadToken;
    try {
      const r = await fetch(`/standing-orders?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error("standing-orders failed");
      soData = await r.json();
    } catch (_) {
      soData = null;
    }
    if (token !== soLoadToken) return;
    renderStandingOrdersPanel();
  }

  function soGroups() { return Array.isArray(soData?.groups) ? soData.groups : []; }

  // ---- R2 (CIM-labor-standing-orders-*.jpg): client-side native regrouping + verbatim labels ----
  // Keyed on the STABLE server keys (standing_orders.cpp:88-143), NEVER on display strings. The
  // server groups several flags into DFHack-ish categories that differ from base-DF's native tabs;
  // this table re-homes them to the native membership + order shown in the oracle screenshots.
  const SO_NATIVE_GROUPS = [
    { id: "workshops", label: "Workshops" },
    { id: "hauling",   label: "Hauling" },
    { id: "refuse",    label: "Refuse" },
    { id: "forbidding",label: "Forbidding" },
    { id: "petitions", label: "Petitions" },
    { id: "chores",    label: "Chores" },
    { id: "other",     label: "Other" },
  ];
  // key -> native group id (only the keys the server files under a non-native category).
  const SO_NATIVE_GROUP_OF = {
    gather_bodies: "hauling",
    gather_refuse: "refuse",
    gather_refuse_outside: "refuse",
    gather_vermin_remains: "refuse",
    zoneonly_drink: "other",
    zoneonly_fish: "other",
    farmer_harvest: "other",
    ignore_damp_stone: "other",
    ignore_warm_stone: "other",
    job_cancel_announce: "other",
    mix_food: "other",
  };
  // native display order within each group (oracle-pinned). Keys not listed keep server order after.
  const SO_NATIVE_ORDER = {
    workshops: ["auto_loom", "use_dyed_cloth", "auto_collect_webs", "auto_slaughter", "auto_butcher",
                "auto_fishery", "auto_kitchen", "auto_tan", "auto_smelter", "auto_kiln", "auto_other"],
    hauling: ["gather_animals", "gather_food", "gather_furniture", "gather_bodies", "gather_minerals", "gather_wood"],
    refuse: ["gather_refuse", "gather_refuse_outside", "gather_vermin_remains", "dump_corpses",
             "dump_skulls", "dump_bones", "dump_shells", "dump_skins", "dump_hair", "dump_other"],
    forbidding: ["forbid_used_ammo", "forbid_own_dead", "forbid_own_dead_items", "forbid_other_nohunt",
                 "forbid_other_dead_items", "forbid_floor_and_wall_cleaning", "forbid_trap_cleaning",
                 "forbid_rearming_traps", "forbid_cages_from_sprung_traps", "forbid_toppled_building_items"],
    other: ["job_cancel_announce", "ignore_damp_stone", "ignore_warm_stone", "farmer_harvest",
            "mix_food", "zoneonly_drink", "zoneonly_fish"],
  };
  // Verbatim {on,off} button text per stable key. The state SHOWN in the oracle is transcribed
  // exactly; the opposite state's verb is derived from the field-name polarity (e.g. dump_* set =>
  // "dump", clear => "save"). Polarity vs the live host is flagged NOT-VERIFIED
  // (a live toggle check requires driving a running DF, deliberately out of scope here).
  const SO_NATIVE_LABELS = {
    // Hauling (gather_* set => gather)
    gather_animals:   { on: "Workers gather animals",   off: "Workers ignore animals" },
    gather_food:      { on: "Workers gather food",      off: "Workers ignore food" },
    gather_furniture: { on: "Workers gather furniture", off: "Workers ignore furniture" },
    gather_bodies:    { on: "Workers gather bodies",    off: "Workers ignore bodies" },
    gather_minerals:  { on: "Workers gather minerals",  off: "Workers ignore minerals" },
    gather_wood:      { on: "Workers gather wood",      off: "Workers ignore wood" },
    // Refuse
    gather_refuse:         { on: "Workers gather refuse",                 off: "Workers ignore refuse" },
    gather_refuse_outside: { on: "Workers gather outdoor refuse",         off: "Workers ignore outdoor refuse" },
    gather_vermin_remains: { on: "Workers gather outdoor vermin remains", off: "Workers ignore outdoor vermin remains" },
    dump_corpses: { on: "Workers dump corpses",       off: "Workers save corpses" },
    dump_skulls:  { on: "Workers dump skulls",        off: "Workers save skulls" },
    dump_bones:   { on: "Workers dump bones",         off: "Workers save bones" },
    dump_shells:  { on: "Workers dump shells",        off: "Workers save shells" },
    dump_skins:   { on: "Workers dump skins",         off: "Workers save skins" },
    dump_hair:    { on: "Workers dump hair and wool", off: "Workers save hair and wool" },
    dump_other:   { on: "Workers dump other objects", off: "Workers save other objects" },
    // Forbidding (forbid_* set => forbid; own/other-dead flip to "Claim" when clear)
    forbid_used_ammo:       { on: "Forbid used ammunition",   off: "Collect used ammunition" },
    forbid_own_dead:        { on: "Forbid your dead",         off: "Claim your dead" },
    forbid_own_dead_items:  { on: "Forbid your death items",  off: "Claim your death items" },
    forbid_other_nohunt:    { on: "Forbid other dead",        off: "Claim other dead" },       // NOT-VERIFIED key/polarity
    forbid_other_dead_items:{ on: "Forbid other death items", off: "Claim other death items" },
    forbid_floor_and_wall_cleaning: { on: "Forbid floor/wall cleaning during sieges", off: "Allow floor/wall cleaning during sieges" },
    forbid_trap_cleaning:           { on: "Forbid trap cleaning during sieges",       off: "Allow trap cleaning during sieges" },
    forbid_rearming_traps:          { on: "Forbid trap rearming during sieges",       off: "Allow trap rearming during sieges" },
    forbid_cages_from_sprung_traps: { on: "Forbid cages from sprung traps during sieges", off: "Allow cages from sprung traps during sieges" },
    forbid_toppled_building_items:  { on: "Forbid toppled building items during sieges",  off: "Allow toppled building items during sieges" },
    // Other (ignore_*_stone set => mining continues; cleared => mining cancelled)
    job_cancel_announce: { on: "Announce some job cancellations", off: "Do not announce job cancellations" },
    ignore_damp_stone:   { on: "Mining continues near new damp stone", off: "Mining cancelled near new damp stone" },
    ignore_warm_stone:   { on: "Mining continues near new warm stone", off: "Mining cancelled near new warm stone" },
    farmer_harvest:      { on: "Everybody harvests",           off: "Only farmers harvest" },
    mix_food:            { on: "Mix similar foods in barrels",  off: "Do not mix foods in barrels" },
    zoneonly_drink:      { on: "Prefer zones for water drinking", off: "Use any water source for drinking" },
    zoneonly_fish:       { on: "Prefer zones for fishing",       off: "Fish anywhere" },
  };
  function soNativeGroupOf(item) { return SO_NATIVE_GROUP_OF[item.key] || item._serverGroup; }
  function soNativeLabel(key, value, serverLabel) {
    const pair = SO_NATIVE_LABELS[key];
    if (!pair) return serverLabel;      // workshops/petitions etc. keep the server label verbatim
    return value ? pair.on : pair.off;
  }
  // Re-home + reorder + relabel the served groups into native tabs. Pure (no DOM); server-graceful.
  function soRegroup(serverGroups) {
    const flat = [];
    for (const g of (serverGroups || [])) {
      const gid = g && g.id;
      for (const it of (Array.isArray(g && g.items) ? g.items : [])) flat.push({ ...it, _serverGroup: gid });
    }
    const byKey = new Map(flat.map(it => [it.key, it]));
    const out = [];
    for (const def of SO_NATIVE_GROUPS) {
      const items = [];
      const used = new Set();
      for (const key of (SO_NATIVE_ORDER[def.id] || [])) {
        const it = byKey.get(key);
        if (it && soNativeGroupOf(it) === def.id) { items.push(it); used.add(key); }
      }
      for (const it of flat) {
        if (used.has(it.key)) continue;
        if (soNativeGroupOf(it) === def.id) { items.push(it); used.add(it.key); }
      }
      out.push({
        id: def.id,
        label: def.label,
        // R9: carry raw (0/1/2) + tristate through so the petitions tab can render its 3-state
        // cycle; absent on an old DLL -> undefined -> falls back to the boolean toggle (graceful).
        items: items.map(it => ({
          key: it.key, value: !!it.value, raw: it.raw, tristate: !!it.tristate,
          label: soNativeLabel(it.key, !!it.value, it.label),
        })),
      });
    }
    return out;
  }

  // ---- R9 (CIM-labor-standing-orders-petitions.jpg): 3-state prompt/accept/reject cycle --------
  // Pure, DOM-free (unit-tested). raw is the server byte (0/1/2); the label suffix is client-side.
  const PETITION_STATES = ["prompt", "accept", "reject"];
  function petitionStateLabel(raw) {
    const n = Number(raw);
    return Number.isFinite(n) ? (PETITION_STATES[((n % 3) + 3) % 3] || "prompt") : "prompt";
  }
  function petitionNextRaw(raw) { return (((Number(raw) || 0) % 3) + 1) % 3; }
  function petitionRowLabel(item) {
    return `${item && item.label ? item.label : ""}: ${petitionStateLabel(item && item.raw)}`;
  }
  function soItemIsTristate(item) { return !!(item && item.tristate); }

  // ---- R8 (CIM-labor-standing-orders-chores.jpg): children roster + chore-type flags -----------
  // Native chore-type order (matches /chores + the oracle left-to-right/top-to-bottom).
  const CHORE_TYPE_ORDER = [
    "feed_patients_prisoners", "milking", "stone_hauling", "wood_hauling", "item_hauling",
    "burial", "food_hauling", "refuse_hauling", "furniture_hauling", "animal_hauling",
    "trade_good_hauling", "water_hauling", "cleaning", "lever_operation",
  ];
  // Pure, DOM-free normalizer (unit-tested): validates + normalizes the /chores payload. The server
  // already emits types in native order; we defensively re-sort to CHORE_TYPE_ORDER so a reordered
  // payload still paints the oracle order.
  function choresModel(data) {
    const rawTypes = Array.isArray(data && data.choreTypes) ? data.choreTypes : [];
    const byKey = new Map(rawTypes.map(t => [String(t.key), t]));
    const choreTypes = [];
    for (const key of CHORE_TYPE_ORDER) {
      const t = byKey.get(key);
      if (t) choreTypes.push({ key, label: String(t.label || ""), enabled: !!t.enabled });
    }
    for (const t of rawTypes) { // any server type not in the known order, appended after
      if (!CHORE_TYPE_ORDER.includes(String(t.key)))
        choreTypes.push({ key: String(t.key), label: String(t.label || ""), enabled: !!t.enabled });
    }
    const children = (Array.isArray(data && data.children) ? data.children : [])
      .map(c => ({
        unitId: Number(c.unitId), name: String(c.name || ""), enabled: !!c.enabled,
        portraitTexpos: Number(c.portraitTexpos ?? -1),
      }));
    return { childrenDoChores: !!(data && data.childrenDoChores), choreTypes, children };
  }
  // POST value that FLIPS a currently-`enabled` checkbox (0 turns off, 1 turns on).
  function choreToggleValue(enabled) { return enabled ? 0 : 1; }

  function soCurrentGroup() {
    const groups = soRegroup(soGroups());
    return groups.find(g => g.id === soActiveGroup) || groups[0] || null;
  }

  // R8: /chores payload cache (children roster + chore flags). Fetched lazily when the Chores tab
  // is opened; dormant-graceful when the route is absent on an old DLL (404 -> friendly message).
  let choresData = null;
  let choresLoadToken = 0;

  // DOM builder for the Chores two-pane (CIM-labor-standing-orders-chores.jpg): global do/don't
  // toggle pair up top, children roster left, chore-type list right, each row a green-check button.
  // W5: `.chore-check` had NO CSS AT ALL -- it was a bare browser button rendering a `&#10003;`
  // entity. It is the universal native 2-state check tile (a REAL tile when unchecked too).
  function choreCheckHtml(cfg) {
    return DWFUI.checkHtml({
      cls: "chore-check", checked: !!cfg.enabled,
      sprite: "LABOR_WORKER_UNASSIGNED", activeSprite: "LABOR_WORKER_ASSIGNED",
      dataset: cfg.dataset, title: cfg.title, ariaLabel: cfg.title,
    });
  }
  function choresRosterHtml(data) {
    const m = choresModel(data);
    const kids = m.children.length ? m.children.map(k => `
        <div class="chore-child-row">
          ${typeof unitPortraitMarkup === "function"
            ? unitPortraitMarkup({ unitId: k.unitId, name: k.name, portraitTexpos: k.portraitTexpos }, "info-portrait-small chore-child-portrait")
            : `<span class="info-portrait-small chore-child-portrait" data-parity-missing="portrait-helper"></span>`}
          <span class="chore-child-name">${escapeHtml(k.name)}, Dwarven Child</span>
          ${choreCheckHtml({ enabled: k.enabled, title: "Child does chores",
            dataset: { choreChild: k.unitId, choreOn: choreToggleValue(k.enabled) } })}
        </div>`).join("")
      : `<div class="info-message">There are no children in the fortress.</div>`;
    const types = m.choreTypes.map(t => `
        <div class="chore-type-row">
          <span class="chore-type-name">${escapeHtml(t.label)}</span>
          ${choreCheckHtml({ enabled: t.enabled, title: "Chore enabled",
            dataset: { choreType: t.key, choreOn: choreToggleValue(t.enabled) } })}
        </div>`).join("");
    // The do/don't pair is the native HORIZONTAL_OPTION_* segmented control, not two buttons.
    const head = DWFUI.segmentedHtml({
      cls: "chores-head", dataAttr: "chore-global", ariaLabel: "Children's chores",
      active: m.childrenDoChores ? "1" : "0",
      options: [{ key: "1", label: "Children do chores" }, { key: "0", label: "Children don't do chores" }],
    });
    const children = DWFUI.scrollHtml({
      cls: "chores-children", preserveKey: "labor-chores-children", ariaLabel: "Children",
    }, kids);
    return `
      ${head}
      <div class="chores-panes">
        ${children}
        <div class="chores-types">${types}</div>
      </div>`;
  }

  async function loadChoresBody() {
    const body = clientPanel.querySelector(".so-chores-body");
    if (!body) return;
    const token = ++choresLoadToken;
    try {
      const r = await fetch(`/chores?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error("chores route absent");
      const data = await r.json();
      if (token !== choresLoadToken) return;
      if (!data || data.ok === false) throw new Error("chores unavailable");
      choresData = data;
      body.innerHTML = choresRosterHtml(data);
      wireChoresBody(body);
    } catch (_) {
      if (token !== choresLoadToken) return;
      // Graceful-dormant on a host without the R8 route (old DLL): no errors, a plain message.
      body.innerHTML = `<div class="info-message">Children's chores need an updated host.</div>`;
    }
  }

  function wireChoresBody(body) {
    const post = async (qs) => {
      try { await fetch(`/chores?${qs}`, { method: "POST", cache: "no-store" }); } catch (_) {}
      await loadChoresBody();
      focusPage();
    };
    body.querySelectorAll("[data-chore-global]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); post(`global=${Number(b.dataset.choreGlobal)}`);
    }));
    body.querySelectorAll("[data-chore-type]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      post(`chore=${encodeURIComponent(b.dataset.choreType)}&value=${Number(b.dataset.choreOn)}`);
    }));
    body.querySelectorAll("[data-chore-child]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      post(`child=${Number(b.dataset.choreChild)}&value=${Number(b.dataset.choreOn)}`);
    }));
  }

  // R9: one standing-order button -- a 3-state petition cycle when tristate, else a boolean toggle.
  // W5: both are the native TEXT PLAQUE (16b-labor-standing-orders.png). Native carries the state IN
  // THE LABEL TEXT ITSELF ("Workers dump bones" / "Workers save bones"), which soNativeLabel and
  // petitionRowLabel already produce verbatim -- so the plaque needs no extra state affordance.
  // The `.so-toggle` / `.so-toggle.on` / `.so-petition` class hooks are passed through unchanged
  // (ui_lab_test pins `so-petition`).
  function soItemButtonHtml(item) {
    if (soItemIsTristate(item)) {
      return DWFUI.plaqueBtnHtml({
        label: petitionRowLabel(item), artTone: "neutral", cls: "so-toggle so-petition",
        dataset: { soKey: item.key, soRaw: petitionNextRaw(item.raw) },
      });
    }
    return DWFUI.plaqueBtnHtml({
      label: item.label, artTone: "neutral",
      cls: item.value ? "so-toggle on" : "so-toggle off",
      dataset: { soKey: item.key, soOn: item.value ? 0 : 1 },
    });
  }

  function standingOrdersMarkup(data, activeGroup = "workshops", options = {}) {
    const sourceGroups = Array.isArray(data?.groups) ? data.groups : [];
    const groups = soRegroup(sourceGroups);
    if (!groups.length || !groups.some(g => (g.items || []).length)) return `<div class="info-message">Standing orders unavailable.</div>`;
    if (!groups.some(g => g.id === "chores")) groups.splice(5, 0, { id: "chores", label: "Chores", items: [] });
    const selectedGroup = groups.some(g => g.id === activeGroup) ? activeGroup : groups[0].id;
    const group = groups.find(g => g.id === selectedGroup) || groups[0];
    const items = Array.isArray(group?.items) ? group.items : [];
    // THE TERTIARY TIER IS REAL. Matrix §3 F3 (Labor row 3) + §4 S3 W4: "Standing orders and Stone use
    // ONLY" render a third tab row, and it is the `SHORT_SUBSUBTAB` grammar (plum -> ORANGE). All three
    // of this file's third-row calls passed NO level; they rendered as generic boxes.
    const tabs = DWFUI.tabsHtml({ cls: "info-detail-tabs so-cat-tabs", tabCls: "info-tab", dataAttr: "so-group", level: "subsubtab", ariaLabel: "Standing order category", active: selectedGroup, tabs: groups.map(g => ({ key: g.id, label: g.label })) });
    if (selectedGroup === "chores") {
      const chores = options.choresData ? choresRosterHtml(options.choresData) : `<div class="info-message">Loading chores...</div>`;
      return `<div class="standing-orders-screen">${tabs}<div class="so-chores"><div class="so-chores-body">${chores}</div></div></div>`;
    }
    const footnote = selectedGroup === "forbidding" ? `<div class="info-message so-footnote">Forbidding of death objects occurs at time of death.</div>` : "";
    return `<div class="standing-orders-screen">${tabs}<div class="so-list">${items.length ? items.map(soItemButtonHtml).join("") : `<div class="info-message">No standing orders in this category.</div>`}</div>${footnote}</div>`;
  }

  function renderStandingOrdersPanel() {
    const main = clientPanel.querySelector(".info-main");
    if (!main) return;
    // R2: regroup the served flags into native tabs (membership + order) before rendering.
    const groups = soRegroup(soGroups());
    if (!groups.length || !groups.some(g => (g.items || []).length)) {
      main.innerHTML = `<div class="info-message">Standing orders unavailable.</div>`;
      return;
    }
    // R8: Chores is a native tab even though soRegroup files no boolean flags under it (its content
    // is the roster route). Ensure it's always selectable.
    if (!groups.some(g => g.id === "chores")) groups.splice(5, 0, { id: "chores", label: "Chores", items: [] });
    if (!groups.some(g => g.id === soActiveGroup)) soActiveGroup = groups[0].id;
    // W5: `group`, `items` and a SECOND, duplicate tab-row build were made here and never read --
    // standingOrdersMarkup (the exported test seam) builds the tab row and the list itself. Deleted.
    const wireTabs = () => main.querySelectorAll("[data-so-group]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      soActiveGroup = b.dataset.soGroup;
      renderStandingOrdersPanel();
      focusPage();
    }));

    // R8: the Chores tab is a two-pane roster fetched from /chores, not a flag list.
    if (soActiveGroup === "chores") {
      main.innerHTML = standingOrdersMarkup(soData, soActiveGroup);
      wireTabs();
      loadChoresBody();
      return;
    }

    // W5: a dead `footnote` local was built here and never read -- standingOrdersMarkup already
    // renders the Forbidding footnote itself. Deleted.
    main.innerHTML = standingOrdersMarkup(soData, soActiveGroup);
    wireTabs();
    main.querySelectorAll("[data-so-key]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      const key = b.dataset.soKey;
      // R9: tristate petitions POST the raw next-state (0/1/2); boolean orders POST 0/1.
      const isPetition = b.dataset.soRaw !== undefined;
      const value = isPetition ? Number(b.dataset.soRaw) : Number(b.dataset.soOn);
      try {
        await fetch(`/standing-orders?key=${encodeURIComponent(key)}&value=${value}`, { method: "POST", cache: "no-store" });
        // Optimistic update on the RAW server cache (soRegroup rebuilds fresh objects each render,
        // so mutate the source of truth, then re-render recomputes membership + the {on,off} label).
        for (const g of soGroups()) {
          const raw = (g.items || []).find(i => i.key === key);
          if (raw) { raw.value = value !== 0; if (isPetition) raw.raw = value; break; }
        }
        renderStandingOrdersPanel();
      } catch (_) {}
      focusPage();
    }));
  }

  // ---- WD-18: Labor -> Stone use, backed by ENDPOINT-ADD /stone-use ----
  let stoneData = null;   // { economic: [{matType,matIndex,name,magmaSafe,uses,selected}], other: [{name}] }
  let stoneActiveTab = "economic"; // "economic" | "other"
  let stoneLoadToken = 0;

  async function openStoneUsePanel() {
    const main = clientPanel.querySelector(".info-main");
    if (main) main.innerHTML = `<div class="info-message">Loading stone use...</div>`;
    const token = ++stoneLoadToken;
    try {
      const r = await fetch(`/stone-use?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error("stone-use failed");
      stoneData = await r.json();
    } catch (_) {
      stoneData = null;
    }
    if (token !== stoneLoadToken) return;
    renderStoneUsePanel();
  }

  // W5: the magma column was a Unicode `&#10003;` / `&#10007;` pair. DF ships both marks as real
  // sprites (LABOR_STONE_USE_MAGMA_SAFE / _MAGMA_UNSAFE) and 16d-labor-stone-use.png shows them.
  function stoneMagmaHtml(magmaSafe) {
    return DWFUI.iconHtml({
      sprite: magmaSafe ? "LABOR_STONE_USE_MAGMA_SAFE" : "LABOR_STONE_USE_MAGMA_UNSAFE",
      cls: "stone-magma", alt: magmaSafe ? "Magma-safe" : "Not magma-safe",
    });
  }
  function stoneCheckHtml(s) {
    return DWFUI.checkHtml({
      cls: "stone-check", checked: !!s.selected,
      sprite: "LABOR_STONE_USE_RESTRICTED", activeSprite: "LABOR_STONE_USE_ALLOWED",
      dataset: { stoneToggle: `${s.matType}:${s.matIndex}`, stoneOn: s.selected ? 0 : 1 },
      title: "Select to use in non-economic jobs",
    });
  }
  function stoneItemHtml(s) {
    const ref = s.spriteRef || {
      itemType: "BOULDER", itemSubtype: -1,
      materialType: Number(s.matType), materialIndex: Number(s.matIndex),
    };
    return DWFUI.iconHtml({ item: ref, cls: "stone-item", size: 44, alt: s.name });
  }
  function stoneUseMarkup(data, activeTab = "economic") {
    if (!data) return `<div class="info-message">Stone use unavailable.</div>`;
    const economic = Array.isArray(data.economic) ? data.economic : [];
    const other = Array.isArray(data.other) ? data.other : [];
    const rows = activeTab === "other"
      ? (other.length ? other.map(s => `<div class="stone-row stone-row-other"><span>${escapeHtml(s.name)}</span></div>`).join("") : `<div class="info-message">No other stone discovered.</div>`)
      : (economic.length ? economic.map(s => `<div class="stone-row" data-stone-mat="${s.matType}:${s.matIndex}">${stoneItemHtml(s)}<span class="stone-name">${escapeHtml(s.name)}</span>${stoneMagmaHtml(s.magmaSafe)}<span class="stone-uses">${escapeHtml((s.uses || []).join(", "))}</span>${stoneCheckHtml(s)}</div>`).join("") : `<div class="info-message">No economic stone discovered.</div>`);
    const tabs = DWFUI.tabsHtml({ cls: "info-detail-tabs so-cat-tabs", tabCls: "info-tab", dataAttr: "stone-tab", level: "subsubtab", ariaLabel: "Stone category", active: activeTab, tabs: [{ key: "economic", label: "Economic stone" }, { key: "other", label: "Other stone" }] });
    // The stone list is the one region in this family with a NATIVE SCROLLBAR in its oracle
    // (16d-labor-stone-use.png). scrollHtml gives it the one shared bar + scroll preservation.
    const list = DWFUI.scrollHtml({ cls: "stone-list", preserveKey: "labor-stone-list" }, rows);
    return `<div class="stone-use-screen">${tabs}${activeTab === "economic" ? `<div class="stone-head"><span>Stone type</span><span>Magma-safe</span><span>Economic uses</span><span>Select to use in non-economic jobs</span></div>` : ""}${list}</div>`;
  }

  function renderStoneUsePanel() {
    const main = clientPanel.querySelector(".info-main");
    if (!main) return;
    if (!stoneData) { main.innerHTML = `<div class="info-message">Stone use unavailable.</div>`; return; }
    const economic = Array.isArray(stoneData.economic) ? stoneData.economic : [];
    // W5: a dead second copy of every stone row (`other` + `rows`) was built here and never read --
    // stoneUseMarkup, the exported test seam, is what actually renders. Deleted. `economic` STAYS:
    // the toggle handler below does the optimistic in-place update through it.
    main.innerHTML = stoneUseMarkup(stoneData, stoneActiveTab);
    main.querySelectorAll("[data-stone-tab]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      stoneActiveTab = b.dataset.stoneTab;
      renderStoneUsePanel();
      focusPage();
    }));
    main.querySelectorAll("[data-stone-toggle]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      const mat = b.dataset.stoneToggle;
      const on = Number(b.dataset.stoneOn);
      try {
        await fetch(`/stone-use?mat=${encodeURIComponent(mat)}&value=${on}`, { method: "POST", cache: "no-store" });
        const [mt, mi] = mat.split(":").map(Number);
        const s = economic.find(x => x.matType === mt && x.matIndex === mi);
        if (s) s.selected = on !== 0;
        renderStoneUsePanel();
      } catch (_) {}
      focusPage();
    }));
  }

  // ---- Work orders (Manager), backed by /orders + /order-* endpoints ----
  let woShopCatalog = null;// [{shop, icon, items:[{key,label}]}] -- DF-style by-workshop picker
  let woSelShop = -1;      // -1 = "All tasks", else index into woShopCatalog
  let woPresets = null;    // [preset names] -- cached
  let woTargets = null;    // item condition targets
  let woWorkshops = null;  // workshop/furnace choices
  let woLastOrders = [];   // last fetched order list (for in-place re-render)
  let woHasManager = true; // /orders.hasManager -- gate the tab like native DF
  let woMode = "list";     // "list" (base orders screen) | "new" (task picker) | "conditions"
  let woSelKey = null;
  let woSelOrderId = null;
  let woAmount = 1;
  let woFreq = "OneTime";
  let woSearch = "";
  let woCreateWorkshop = "-1";
  const WORK_ORDERS_ENABLED = true;

  // ---- R1 (CIM-work orders.jpg): pure row-anatomy helpers (unit-testable, DOM-free) ----
  // Status icon: DF shows one glyph per row keyed on the served status bits --
  // clock = awaiting manager validation (validated:false), yellow dots = validated & active
  // (a worker is on it), green check = validated & idle. Keys on the STABLE /orders bits.
  function woStatusIconKey(o) {
    if (!o || o.validated === false) return "pending";   // clock
    if (o.active) return "active";                        // dots
    return "validated";                                  // check
  }
  // Any-shop orders carry no bound workshop (workshop_id < 0). Native prints "Can use any shop";
  // bound orders print the workshop's name. Never render a bound name for an any-shop order.
  function woIsAnyShop(o) { return !(o && Number(o.workshopId) >= 0); }
  function woWorkshopLabel(o) {
    return woIsAnyShop(o) ? "Can use any shop" : String(o.workshopName || "Workshop");
  }
  // W5: this rendered THREE INLINE HEX LITERALS on Unicode glyphs (&#9201; &#8943; &#10003;) for
  // three marks DF ships as real sprites. WORK_ORDERS_CHECKING / _ACTIVE / _VALIDATED are all in
  // web/interface_map.json; the colour is BAKED INTO THE SPRITE, so no module-owned hex survives.
  const WO_STATUS_SPRITE = {
    pending:   { sprite: "WORK_ORDERS_WAITING",  title: "Awaiting manager validation" },
    active:    { sprite: "WORK_ORDERS_CHECKING", title: "Active (a worker is on it)" },
    validated: { sprite: "WORK_ORDERS_ACTIVE",   title: "Validated" },
  };
  function woStatusIconHtml(o) {
    const s = WO_STATUS_SPRITE[woStatusIconKey(o)] || WO_STATUS_SPRITE.pending;
    return DWFUI.iconHtml({ sprite: s.sprite, cls: "wo-status-icon", title: s.title, alt: s.title });
  }

  const WO_FREQS = ["OneTime", "Daily", "Monthly", "Seasonally", "Yearly"];
  // B285 wave-2: the row's comparison toggle cycles DF's 6 real logic_condition_type values in
  // ENUM ORDER (df.workquota.xml:2). NONE(-1) is DF's sentinel, never an editor value; the lua
  // validator refuses it.
  const WO_COMPARE_CYCLE = ["AtLeast", "AtMost", "GreaterThan", "LessThan", "Exactly", "Not"];
  // DF "Adj" property filters for a condition. Keys must match dfcapture.lua's VALIDATED set:
  // CONDITION_ADJECTIVES plus the explicit `empty` bit (the native barrel/bin/bucket condition,
  // job_item_flags1.empty) -- an unknown key is refused server-side, never silently dropped.
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
    // Native suppresses only the suggestion's Add control. Its identity comparison covers every
    // scalar/string filter field, while deliberately ignoring operator, threshold, and contains.
    // Accept both the /orders camelCase shape and the ground-truth snake_case shape so a future
    // native snapshot provider can stay lossless without teaching the browser DF structure rules.
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

  function woWorkshopOptions(selected, includeAnyLabel) {
    const sel = String(selected == null ? -1 : selected);
    const rows = [`<option value="-1"${sel === "-1" ? " selected" : ""}>${escapeHtml(includeAnyLabel || "General manager order")}</option>`];
    (woWorkshops || []).forEach(w => {
      const label = `${w.label || w.kind || "Workshop"} (${w.x},${w.y},${w.z})`;
      rows.push(`<option value="${w.id}"${sel === String(w.id) ? " selected" : ""}>${escapeHtml(label)}</option>`);
    });
    return rows.join("");
  }

  // B261: the old flat category grid (woCatalog / woCatalogGridHtml / woWireCatalogItems /
  // woRefreshCatalogGrid, backed by /order-catalog) was dead -- no render mode emitted its #woGrid
  // element, so it was fetched and never shown. It has been removed. The live "New work order" picker
  // (woRenderNewScreen) uses woShopCatalog (/order-catalog-shops), which derives from the shared shop
  // job definitions; both order surfaces now come from one source and cannot drift.

  async function woApi(path, params = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => qs.set(k, v == null ? "" : String(v)));
    // WP-C (WT06): identify the requesting player so /order-create can attribute the order.
    if (typeof player !== "undefined" && !qs.has("player")) qs.set("player", player);
    qs.set("t", Date.now());
    const r = await fetch(`${path}?${qs.toString()}`, { method: "POST", cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok || data.ok === false) throw new Error(data.msg || text.trim() || "request failed");
    return data;
  }

  async function woFetchJson(path) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${path}${sep}t=${Date.now()}`, { cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok || data.ok === false) throw new Error(data.error || data.msg || text.trim() || `${path} failed`);
    return data;
  }

  // ---- B285 wave-2: condition editor data loads ----------------------------------------------
  // Materials for the "Mat" chooser. Fire-and-forget; when it lands and the mat picker is still
  // open on the conditions screen, re-render so the rows appear.
  async function loadWoCondMaterials(item) {
    woCondMatItem = item;
    woCondMaterials = [];
    try {
      const d = await woFetchJson(`/condition-materials?item=${encodeURIComponent(item || "")}`);
      if (woCondMatItem === item) {
        woCondMaterials = Array.isArray(d.materials) ? d.materials : [];
        if (woMode === "conditions" && woCondPicker && woCondPicker.tab === "mat") renderWorkOrders();
      }
    } catch (_) {}
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
    } catch (_) {}
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
        // WD-16 finding: this background prefetch is fire-and-forget from openWorkOrdersPanel,
        // so a fast tab switch (clicking another info tab while these are still in flight) used
        // to have a later resolve clobber whatever tab the shell had since moved to. Guard on
        // still being the active tab -- same shell instance, no visible stomp.
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
    if (!clientPanel.querySelector(".wo-cols")) {
      // WD-16: keep the shared tab row mounted during the initial load too.
      panelContent(clientPanel).innerHTML = `<div class="info-window">${infoTabRowHtml("workorders")}<div class="info-body"><div class="info-message">Loading work orders...</div></div></div>`;
      wireInfoTabRow(clientPanel);
    }
    try {
      await refreshWorkOrders();
      loadWorkOrderAuxData();
    } catch (_) {
      panelContent(clientPanel).innerHTML = `<div class="info-window">${infoTabRowHtml("workorders")}<div class="info-body"><div class="info-message">Work order data unavailable.</div></div></div>`;
      wireInfoTabRow(clientPanel);
    }
  }

  async function refreshWorkOrders() {
    // WP-C (WT06): pull /attrib alongside /orders so order rows can show their creator dot.
    // AWAITED (not fire-and-forget) -- otherwise the FIRST open renders before the attribution
    // state lands and no dot appears until a later re-render. Throttled by the module's 2s TTL
    // and graceful (never throws, dormant on the pre-WP-C DLL).
    if (typeof attribRefresh === "function") { try { await attribRefresh(); } catch (_) {} }
    const data = await woFetchJson("/orders");
    woHasManager = data.hasManager !== false;
    woLastOrders = Array.isArray(data.orders) ? data.orders : [];
    if (!woSelectedOrder()) woSelOrderId = woLastOrders.length ? woLastOrders[0].id : null;
    renderWorkOrders();
  }

  function woSetStatus(msg, isErr) {
    const el = document.getElementById("woStatus");
    if (el) { el.textContent = msg || ""; el.className = "wo-status" + (isErr ? " err" : ""); }
  }

  // ---- Base "list" screen: every order with inline quantity + reorder + conditions button ----
  // W5 anatomy (CIM-work orders.jpg): ONE table-chassis row --
  //   [status sprite] [job / amount+freq / attribution] [qty stepper] [reorder] [conditions]
  //   [workshop] [max-workshops] --- gap --- [remove]
  // THE REORDER ARROW AT A LIST EXTREME IS OMITTED, NOT BLANKED AND NOT DISABLED-IN-PLACE: native
  // leaves a GAP there ("an absent cell renders NOTHING").
  function woReorderHtml(o, index, total) {
    const items = [];
    if (index > 0) items.push({ action: "priorityUp", sprite: "WORK_ORDERS_PRIORITY_UP",
      title: "Move up", dataset: { woMove: o.id, dir: -1 } });
    if (index < total - 1) items.push({ action: "priorityDown", sprite: "WORK_ORDERS_PRIORITY_DOWN",
      title: "Move down", dataset: { woMove: o.id, dir: 1 } });
    if (!items.length) return "";
    return DWFUI.actionButtonsHtml(items, { cls: "dwfui-actions wo-reorder", ariaLabel: "Order priority" });
  }
  // PB-10: native's amount cluster is `value [#][+][-]` with the value cell BORDERLESS. Ours drew a
  // BORDERED <input> INSIDE the group -- that is the "strange box with a golden border" the owner reports.
  // stepperHtml owns the anatomy; the input stays a real <input> (the deliberate editable exception).
  // NO `label:` -- stepperHtml renders `label` as a VISIBLE flex:1 caption span, and native's row
  // carries no caption there (it is just `value [#][+][-]`). The trade-off is that the +/-/# tooltips
  // fall back to the builder's generic "value" wording; the row must not grow a word DF does not show.
  function woQtyStepperHtml(o) {
    return DWFUI.stepperHtml({
      cls: "wo-qty", art: true, hash: true,
      value: Number(o.amountTotal) || 0, min: 0, max: 9999,
      dataset: { woAmt: o.id },
      plusDataset: { woAmtInc: o.id }, minusDataset: { woAmtDec: o.id },
      hashDataset: { woAmtEnter: o.id },
      ariaLabel: "Quantity",
      // B207: a literal `title` so the hover hint survives the migration AND the ? help reference
      // (which harvests QUOTED LITERALS from source) can still see it. aria-label does neither.
      title: "Quantity (Enter to apply)",
    });
  }
  // Max-workshops keeps its `#` + value cells hand-written ON PURPOSE: 0 means UNLIMITED and native
  // prints a DASH for it, and stepperHtml has no value-text override (the foundation is LOCKED this
  // wave), so routing it through the stepper would replace the native dash with a literal "0".
  // Only the two +/- tiles migrate, onto the native WORK_ORDERS_{INCREASE,DECREASE}_AMOUNT sprites.
  function woMaxShopsHtml(o) {
    if (!woIsAnyShop(o)) return "";
    const maxN = Number(o.maxWorkshops) || 0;
    const steps = DWFUI.actionButtonsHtml([
      { action: "maxInc", sprite: "WORK_ORDERS_INCREASE_AMOUNT", title: "More workshops", dataset: { woMaxInc: o.id } },
      { action: "maxDec", sprite: "WORK_ORDERS_DECREASE_AMOUNT", title: "Fewer workshops", dataset: { woMaxDec: o.id } },
    ], { cls: "dwfui-actions wo-maxshops-steps", ariaLabel: "Max workshops" });
    return `<div class="wo-maxshops" title="Max workshops that may run this order at once (0 = any)">` +
      `<span class="wo-maxval">${maxN > 0 ? maxN : "&mdash;"}</span>` +
      `<span class="wo-hash">#</span>${steps}</div>`;
  }
  function woRenderListScreen(orders) {
    const rows = orders.length ? orders.map((o, i) => {
      const condN = (Array.isArray(o.itemConditions) ? o.itemConditions.length : 0) +
                    (Array.isArray(o.orderConditions) ? o.orderConditions.length : 0);
      // WP-C (WT06): "● player" chip, merged from /attrib by order id, toggleable. Empty on the
      // pre-WP-C DLL (no /attrib) or for native/pre-existing orders -- the row simply lacks it.
      // SUPERSET (the ruling): this is multiplayer attribution, which DF cannot have. It used to
      // live in `.wo-meta`, the exact cell the native row rewrite dissolves; it is now a THIRD LINE
      // UNDER THE JOB NAME. Native already stacks the amount under the job name, so the row grammar
      // absorbs a third line without inventing a column. It is NOT deleted and NOT hidden.
      const woAttrib = (typeof attribRowHtml === "function") ? attribRowHtml("order", o.id) : "";
      const amtTxt = Number(o.amountTotal) > 0 ? `${o.amountLeft}/${o.amountTotal}` : "repeating";
      const metaHtml = DWFUI.rawHtml(
        "the native work-order list shows the amount beneath the job name",
        `<span class="wo-amt-tag">${escapeHtml(amtTxt)}</span>`);
      const sub = [{ cls: "wo-meta", html: metaHtml }];
      if (woAttrib) sub.push({ cls: "wo-meta wo-attrib-line",
        html: DWFUI.rawHtml("multiplayer attribution chip -- a wired superset, kept as its own line", woAttrib) });
      // The conditions tile keeps its hand-built button BECAUSE OF THE COUNT BADGE: it is an
      // absolutely-positioned child of the button (`.wo-icon.has` is the positioning context) and no
      // DWFUI button builder has a children slot. The GLYPH inside it is native art now.
      const condBtn = `<button class="wo-icon wo-cond-btn${condN ? " has" : ""}" data-wo-conditions="${o.id}" title="Conditions">` +
        `${DWFUI.iconHtml({ sprite: "WORK_ORDERS_CONDITIONS", alt: "Conditions" })}` +
        `${condN ? `<span class="wo-cond-badge">${condN}</span>` : ""}</button>`;
      const removeBtn = DWFUI.artBtnHtml({
        sprite: "WORK_ORDERS_REMOVE", cls: "wo-icon danger wo-remove-btn",
        dataset: { woCancel: o.id }, title: "Remove order", ariaLabel: "Remove order",
      });
      // An ABSENT cell renders NOTHING (native omits; it does not blank). `null` is filtered by
      // rowHtml; an empty-string html would still emit an empty cell box, so it must not be used.
      const reorder = woReorderHtml(o, i, orders.length);
      const maxShops = woMaxShopsHtml(o);
      const validation = DWFUI.iconHtml({
        sprite: o.validated === false ? "WORK_ORDERS_NOT_VALIDATED" : "WORK_ORDERS_VALIDATED",
        cls: "wo-validation", alt: o.validated === false ? "Not validated" : "Manager validated",
      });
      return DWFUI.rowHtml({
        cls: "wo-order", chassis: "table",
        dataset: { woRow: o.id },
        icon: woStatusIconHtml(o),
        label: o.job, labelCls: "wo-job", copyCls: "wo-order-main", sub,
        cells: [
          { cls: "wo-validation-cell", html: validation },
          { cls: "wo-qty-cell", html: woQtyStepperHtml(o) },
          reorder ? { cls: "wo-reorder-cell", html: reorder } : null,
          { cls: "wo-cond-cell", html: condBtn },
          { cls: "wo-shop-col", html: escapeHtml(woWorkshopLabel(o)) },
          maxShops ? { cls: "wo-maxshops-cell", html: maxShops } : null,
        ],
        trailing: removeBtn,
      });
    }).join("") : `<div class="wo-empty">No work orders yet. Click "New work order" to add one.</div>`;
    const newBtn = DWFUI.artBtnHtml({
      sprite: "WORK_ORDERS_CREATE_NEW", cls: "wo-new-btn",
      dataset: { woNewscreen: "" }, title: "New work order", ariaLabel: "New work order",
    });
    const list = DWFUI.scrollHtml({ cls: "wo-list", preserveKey: "work-orders-list" }, rows);
    return `
      <div class="wo-screen">
        <div class="wo-new-slot">${newBtn}</div>
        ${list}
        <div class="wo-status" id="woStatus"></div>
      </div>`;
  }

  // The tasks shown in the right pane: filtered by search across all shops, else the selected shop.
  function woNewTaskList() {
    const shops = Array.isArray(woShopCatalog) ? woShopCatalog : [];
    const q = (woSearch || "").trim();
    const out = [], seen = new Set();
    const push = it => { if (!seen.has(it.key)) { seen.add(it.key); out.push(it); } };
    // B21: DF-style token search over the FULL label (material prefix included) across all shops.
    if (q) shops.forEach(s => (s.items || []).forEach(it => { if (dfTokenMatch(it.label, q)) push(it); }));
    else if (woSelShop < 0) shops.forEach(s => (s.items || []).forEach(push));
    else if (shops[woSelShop]) (shops[woSelShop].items || []).forEach(push);
    return out;
  }
  function woNewTasksHtml() {
    const tasks = woNewTaskList();
    if (!tasks.length) return `<div class="wo-empty">No tasks here.</div>`;
    // The catalog is large (per-metal forge rows + every raws reaction); cap the DOM and let the
    // DF-style search narrow it.
    const CAP = 300;
    const shown = tasks.slice(0, CAP);
    const rows = shown.map(it => `<button class="wo-task${it.key === woSelKey ? " selected" : ""}" data-wo-task="${escapeHtml(it.key)}">${escapeHtml(it.label)}</button>`).join("");
    return tasks.length > shown.length
      ? rows + `<div class="wo-empty">Showing ${shown.length} of ${tasks.length} &mdash; type to narrow (e.g. "iron cage").</div>`
      : rows;
  }

  // W5: every hand-built `.wo-btn` is the native TEXT PLAQUE. plaqueBtnHtml has no `id` key, so the
  // five id-addressed action buttons (woQueue / woApplyOrder / woApplyWorkshop / woAddItemCond /
  // woAddOrderCond) move from `id="..."` to an equivalent `data-wo-*` hook. Nothing else changes:
  // the same handlers fire and dispatch the same routes with the same params. Grepped: no other
  // file, test or fixture addresses those ids.
  function woBackButtonHtml() {
    return DWFUI.plaqueBtnHtml({
      label: "← Back", tone: "grey", cls: "wo-btn secondary",
      dataset: { woBacklist: "" }, title: "Back to the order list",
    });
  }

  // ---- "new" screen: DF-style picker -- workshops (with icons) on the left, their tasks on the right ----
  function woRenderNewScreen() {
    const shops = Array.isArray(woShopCatalog) ? woShopCatalog : [];
    const freqOpts = WO_FREQS.map(f => `<option value="${f}"${f === woFreq ? " selected" : ""}>${f === "OneTime" ? "One time" : f}</option>`).join("");
    const shopBtns = [`<button class="wo-shop${woSelShop < 0 ? " selected" : ""}" data-wo-shop="-1"><span class="wo-shop-icon" style="${bldIconStyle("workshops", 18)}"></span><span>All tasks</span></button>`]
      .concat(shops.map((s, i) => `<button class="wo-shop${i === woSelShop ? " selected" : ""}" data-wo-shop="${i}"><span class="wo-shop-icon" style="${bldIconStyle(s.icon, 18)}"></span><span>${escapeHtml(s.shop)}</span></button>`)).join("");
    // The task filter is the native PANE-HEADER search: it sits at the top of the list pane it
    // filters (F7 placement P2), and it carries the BUTTON_FILTER magnifier sprite, not an emoji.
    const taskSearch = DWFUI.searchHtml({
      cls: "wo-task-search", inputCls: "wo-search-input", id: "woSearch",
      placement: "pane-header", magnifier: true, preserveKey: "wo-task-search",
      value: woSearch, placeholder: "Find a task...", ariaLabel: "Find a task",
    });
    return `
      <div class="wo-screen">
        <div class="wo-screen-head">
          ${woBackButtonHtml()}
          <div class="wo-section-title">New work order</div>
        </div>
        <div class="wo-newpick">
          <div class="wo-shoplist">${shopBtns}</div>
          <div class="wo-taskpane">
            ${taskSearch}
            <div class="wo-tasks" id="woTasks">${woNewTasksHtml()}</div>
          </div>
        </div>
        <div class="wo-form-row">
          <label>Amount</label>
          <input class="wo-input" id="woAmount" type="number" min="1" max="9999" value="${woAmount}">
          <label>Repeat</label>
          <select class="wo-select" id="woFreq">${freqOpts}</select>
          <select class="wo-select wide" id="woCreateWorkshop">${woWorkshopOptions(woCreateWorkshop, "General manager order")}</select>
          ${DWFUI.plaqueBtnHtml({ label: "Queue order", tone: "green", artTone: "neutral", cls: "wo-btn", dataset: { woQueue: "" } })}
        </div>
        <div class="wo-status" id="woStatus"></div>
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
      el.querySelectorAll("[data-wo-task]").forEach(x => x.classList.toggle("selected", x.dataset.woTask === woSelKey));
    }));
  }

  // B285 wave-2: the condition row IS the editor (native edits in place -- WO-CONDITIONS-native.png
  // anatomy: [sentence][satisfied] [# + -] [<>=# toggle] [Type Mat Adj] [red X]). The read half is
  // unchanged: the sentence is the server's exact native wording, and only DF's own
  // conditions-interface result paints the row green (`false`/`null` have no invented opposite).
  // opts: {orderId, kind:'item'|'order', editable}. Without opts the row renders read-only.
  function woConditionRowHtml(condition, opts) {
    const o = opts || {};
    const kind = o.kind || "item";
    const description = condition?.description || condition?.label || "Condition";
    const satisfied = condition?.satisfied === true && condition?.satisfactionSource === "df-ui";
    const idx = Number(condition?.idx);
    const editable = o.editable !== false && o.orderId != null && Number.isFinite(idx);
    let cells = null;
    let trailing = null;
    if (editable) {
      trailing = DWFUI.artBtnHtml({
        sprite: "WORK_ORDERS_REMOVE", cls: "wo-icon danger wo-cond-remove",
        dataset: { woRemoveCond: o.orderId, kind, idx },
        title: "Remove condition", ariaLabel: "Remove condition",
      });
    }
    if (editable && kind === "item") {
      cells = [
        // native count cluster: value [#][+][-] -- same stepper anatomy as the order rows.
        { cls: "wo-cond-qty-cell", html: DWFUI.stepperHtml({
            cls: "wo-cond-qty", art: true, hash: true,
            value: Number(condition.value) || 0, min: 0, max: 999999,
            dataset: { woCondVal: idx },
            plusDataset: { woCondValInc: idx }, minusDataset: { woCondValDec: idx },
            hashDataset: { woCondValEnter: idx },
            ariaLabel: "Condition amount", title: "Condition amount (Enter to apply)",
          }) },
        // the native <>=# glyph (WORK_ORDERS_CONDITIONS is that exact cell); cycles the 6 values.
        { cls: "wo-cond-cmp-cell", html: DWFUI.artBtnHtml({
            sprite: "WORK_ORDERS_CONDITIONS", cls: "wo-icon wo-cond-cmp",
            dataset: { woCondCmp: idx },
            title: "Change comparison", ariaLabel: "Change comparison" }) },
        // DF's own boxed-text Type/Mat/Adj tiles (interface_bits_work_orders.png row 3).
        { cls: "wo-cond-tabs-cell", html: DWFUI.actionButtonsHtml([
            { action: "condType", sprite: "WORK_ORDERS_CHANGE_TYPE", title: "Change item type",
              dataset: { woCondTab: "type", idx } },
            { action: "condMat", sprite: "WORK_ORDERS_CHANGE_MAT", title: "Change material",
              dataset: { woCondTab: "mat", idx } },
            { action: "condAdj", sprite: "WORK_ORDERS_CHANGE_ADJ", title: "Change adjective",
              dataset: { woCondTab: "adj", idx } },
          ], { cls: "dwfui-actions wo-cond-tabs", ariaLabel: "Condition target" }) },
      ];
    }
    return DWFUI.rowHtml({
      chassis: "table",
      state: satisfied ? "on" : null,
      cls: `wo-condition-row${satisfied ? " is-satisfied" : ""}`,
      label: description,
      sub: satisfied ? { text: "Satisfied for next check", tone: "good" } : null,
      ariaLabel: satisfied ? `${description}. Satisfied for next check` : description,
      cells, trailing,
    });
  }

  // The Type / Mat / Adj chooser rendered under a condition row (native opens a selector; ours is
  // an inline DWFUI row list). PURE for fixtures: `data` overrides the module caches
  // ({targets, materials}); production callers omit it.
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
      cls: "wo-cond-pick", state: opt.on ? "on" : null, label: opt.label,
      dataset: { woCondPick: tab, idx: cond.idx, value: opt.value },
    })).join("");
    return `<div class="wo-cond-picker">${DWFUI.scrollHtml({ cls: "wo-cond-pick-list" }, rows)}</div>`;
  }

  // Suggested conditions. ONLY exact server-sent rows render; an empty list renders NOTHING. A
  // matching condition keeps its sentence but loses the + cell. Non-token rows are display-only:
  // the browser must never reconstruct a native filter from prose or a reduced field subset.
  function woSuggestionRowsHtml(suggestions, existingConditions) {
    const list = Array.isArray(suggestions) ? suggestions : [];
    if (!list.length) return "";
    const rows = list.map((s, i) => {
      const addAvailable = Boolean(s.token) && !woConditionDuplicate(existingConditions, s, "item");
      return DWFUI.rowHtml({
        chassis: "table", cls: "wo-suggest-row", label: s.label || "",
        trailing: addAvailable ? DWFUI.artBtnHtml({
          sprite: "WORK_ORDERS_ADD_SUGGESTED_CONDITION", cls: "wo-icon wo-suggest-add",
          dataset: { woSuggest: i }, title: "Add suggested condition",
          ariaLabel: "Add suggested condition",
        }) : null,
      });
    }).join("");
    return `<div class="wo-field wo-suggest">` +
      `<div class="wo-field-title">${DWFUI.bitmapTextHtml("Suggested conditions")}</div>` +
      `<div class="wo-cond-list">${rows}</div></div>`;
  }

  // ---- "conditions" screen: read view (wave 1) + in-place editor (wave 2) --------------------
  function woRenderConditionsScreen(selected, orders, suggestions) {
    const editFreqOpts = WO_FREQS.map(f => `<option value="${f}"${f === selected.frequency ? " selected" : ""}>${escapeHtml(woFreqLabel(f))}</option>`).join("");
    const condRows = (rows, kind) => rows && rows.length
      ? rows.map(c => woConditionRowHtml(c, { orderId: selected.id, kind }) +
          (kind === "item" && woCondPicker && Number(woCondPicker.idx) === Number(c.idx)
            ? woCondPickerHtml(woCondPicker.tab, c) : "")).join("")
      : `<div class="wo-empty">${DWFUI.bitmapTextHtml("None")}</div>`;
    const repeats = selected.frequency && selected.frequency !== "OneTime";
    const frequencyDescription = repeats ? "Restarts if completed, conditions checked daily" : "";
    // Native top-right tool cluster (WO-CONDITIONS-native.png): [clock][<>=#+][clipboard+]. The
    // clock (frequency) is deferred as art -- frequency already edits through the select below.
    const condTools = DWFUI.actionButtonsHtml([
      { action: "addItemCond", sprite: "WORK_ORDERS_ADD_ITEM_CONDITION",
        title: "New condition", dataset: { woAddItemCond: "" } },
      { action: "addOrderCond", sprite: "WORK_ORDERS_ADD_ORDER_CONDITION", active: woOrderCondAdd,
        title: "New order condition (after another order)", dataset: { woAddOrderCondOpen: "" } },
    ], { cls: "dwfui-actions wo-cond-tools", ariaLabel: "Add condition" });
    // The "new order condition" chooser: pick the other order; Completed/Activated are DF's only
    // two workquota_order_condition_type values (df.workquota.xml:37).
    let orderCondChooser = "";
    if (woOrderCondAdd) {
      const others = (orders || []).filter(x => Number(x.id) !== Number(selected.id));
      const otherRows = others.length ? others.map(x => DWFUI.rowHtml({
        cls: "wo-cond-pick", label: woOrderTitle(x), dataset: { woAddOrderCond: x.id },
      })).join("") : `<div class="wo-empty">${DWFUI.bitmapTextHtml("No other orders")}</div>`;
      orderCondChooser = `<div class="wo-cond-picker wo-ordercond-picker">` +
        DWFUI.segmentedHtml({ dataAttr: "wo-order-cond-type", active: woOrderCondType,
          ariaLabel: "Condition type", options: [
            { key: "Completed", label: "Completed", title: "Runs after that order completes" },
            { key: "Activated", label: "Activated", title: "Runs once that order activates" },
          ] }) +
        DWFUI.scrollHtml({ cls: "wo-cond-pick-list" }, otherRows) + `</div>`;
    }
    return `
      <div class="wo-screen">
        <div class="wo-screen-head">
          ${woBackButtonHtml()}
          <div class="wo-detail-title">${escapeHtml(woOrderTitle(selected))}</div>
          <div class="wo-cond-tools-slot">${condTools}</div>
        </div>
        ${frequencyDescription ? `<div class="wo-condition-frequency">${DWFUI.bitmapTextHtml(frequencyDescription)}</div>` : ""}
        <div class="wo-detail-grid">
          <div class="wo-field">
            <div class="wo-field-title">Amount and repeat</div>
            <div class="wo-form-row">
              <input class="wo-input" id="woEditAmount" type="number" min="0" max="9999" value="${Number(selected.amountTotal) || 0}">
              <select class="wo-select" id="woEditFreq">${editFreqOpts}</select>
              ${DWFUI.plaqueBtnHtml({ label: "Apply", tone: "green", artTone: "neutral", cls: "wo-btn", dataset: { woApplyOrder: "" } })}
            </div>
          </div>
          <div class="wo-field">
            <div class="wo-field-title">Workshop control</div>
            <div class="wo-form-row">
              <select class="wo-select wide" id="woEditWorkshop">${woWorkshopOptions(selected.workshopId, "Any matching workshop")}</select>
              ${DWFUI.plaqueBtnHtml({ label: "Set", tone: "green", artTone: "neutral", cls: "wo-btn", dataset: { woApplyWorkshop: "" } })}
            </div>
          </div>
        </div>
        <div class="wo-field">
          <div class="wo-field-title">${DWFUI.bitmapTextHtml("Conditions")}</div>
          <div class="wo-cond-list">${condRows(selected.itemConditions || [], "item")}</div>
        </div>
        ${orderCondChooser}
        ${selected.orderConditions?.length ? `<div class="wo-field">
          <div class="wo-field-title">${DWFUI.bitmapTextHtml("Order conditions")}</div>
          <div class="wo-cond-list">${condRows(selected.orderConditions, "order")}</div>
        </div>` : ""}
        ${woSuggestionRowsHtml(suggestions, selected.itemConditions || [])}
        <div class="wo-status" id="woStatus"></div>`;
  }

  function workOrdersMarkup(data, options = {}) {
    const orders = Array.isArray(data?.orders) ? data.orders : [];
    const hasManager = data?.hasManager !== false;
    let mode = options.mode || "list";
    const selectedId = Number(options.selectedOrderId);
    const selected = orders.find(order => Number(order.id) === selectedId) || orders[0] || null;
    if (mode === "conditions" && !selected) mode = "list";
    let body;
    if (!hasManager) body = `<div class="wo-manager-required">A manager is required to coordinate work orders.</div>`;
    else if (mode === "new") body = woRenderNewScreen();
    else if (mode === "conditions") body = woRenderConditionsScreen(selected, orders, options.suggestions);
    else body = woRenderListScreen(orders);
    // W5 DELETION (three-step proof in the closeout): the generic `infoSearchBoxHtml()` that used to
    // sit in this footer is DEAD MARKUP and NOT NATIVE.
    //   1. It is INERT: infoSearchBoxHtml emits no `data-info-search`, and the ONLY listener
    //      (dwf-build-info-panels.js:2152) queries `[data-info-search]`. No handler, no route.
    //   2. Native work orders has NO search: the only search-like thing in CIM-work orders.jpg is
    //      the DFHack `Alt+s` overlay, which is not part of the game (17-info-workorders.png, the
    //      clean vanilla capture, has no search either).
    //   3. `grep -rn "info-search" src/` -> nothing. No server wire.
    // The Work Details footer search STAYS (16-labor-workdetails.png attests it there).
    const footer = hasManager ? `<div class="info-footer wo-manager-note"><div>All work orders must be validated<br>by the manager before they become<br>active.</div></div>` : "";
    return `<div class="info-window">${infoTabRowHtml("workorders")}<div class="info-body${hasManager ? "" : " wo-empty-body"}" style="grid-template-columns:1fr;">${body}</div>${footer}</div>`;
  }

  function renderWorkOrders() {
    const orders = woLastOrders;
    let selected = woSelectedOrder();

    // If we're on the conditions screen but the order vanished (cancelled), fall back to the list.
    if (woMode === "conditions" && !selected) woMode = "list";
    // W5: a dead second copy of `body` (all four branches) and `footerHtml` was built here and never
    // read -- workOrdersMarkup, the exported test seam, renders. Deleted. The one live side-effect
    // of that block (normalising an unknown mode back to "list") is kept explicitly.
    if (woHasManager && woMode !== "new" && woMode !== "conditions") woMode = "list";

    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = workOrdersMarkup({ orders, hasManager: woHasManager },
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
    clientPanel.querySelectorAll("[data-wo-backlist]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); woMode = "list"; woCondPicker = null; woOrderCondAdd = false; renderWorkOrders(); }));
    clientPanel.querySelectorAll("[data-wo-conditions]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      woSelOrderId = Number(b.dataset.woConditions); woMode = "conditions";
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
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
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

    // new-order screen wiring (DF-style workshop picker)
    clientPanel.querySelectorAll("[data-wo-shop]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      woSelShop = Number(b.dataset.woShop);
      clientPanel.querySelectorAll("[data-wo-shop]").forEach(x => x.classList.toggle("selected", Number(x.dataset.woShop) === woSelShop));
      woRefreshTaskPane();
    }));
    const searchIn = document.getElementById("woSearch");
    if (searchIn) searchIn.addEventListener("input", () => { woSearch = searchIn.value || ""; woRefreshTaskPane(); });
    const amtIn = document.getElementById("woAmount");
    if (amtIn) amtIn.addEventListener("input", () => { woAmount = Math.max(1, Math.min(9999, Number(amtIn.value) || 1)); });
    const freqSel = document.getElementById("woFreq");
    if (freqSel) freqSel.addEventListener("change", () => { woFreq = freqSel.value; });
    const createWorkshopSel = document.getElementById("woCreateWorkshop");
    if (createWorkshopSel) createWorkshopSel.addEventListener("change", () => { woCreateWorkshop = createWorkshopSel.value; });
    if (woMode === "new") woRefreshTaskPane();
    // W5: native's `#` tile means "enter the amount". Our amount cell IS that entry field (editable
    // inputs are the deliberate DWFUI exception), so the tile focuses and selects it. No new route.
    clientPanel.querySelectorAll("[data-wo-amt-enter]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const inp = clientPanel.querySelector(`[data-wo-amt="${b.dataset.woAmtEnter}"]`);
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
        await woApi("/order-adjust", { id: selected.id, amount: Math.max(0, Math.min(9999, Number(document.getElementById("woEditAmount")?.value) || 0)), frequency: document.getElementById("woEditFreq")?.value || selected.frequency });
        await refreshWorkOrders(); woSetStatus("Order updated.", false);
      } catch (err) { woSetStatus(err.message || "Could not update order.", true); }
    });
    const applyWorkshop = clientPanel.querySelector("[data-wo-apply-workshop]");
    if (applyWorkshop && selected) applyWorkshop.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      try { await woApi("/order-workshop", { id: selected.id, workshop: document.getElementById("woEditWorkshop")?.value || -1 }); await refreshWorkOrders(); woSetStatus("Workshop updated.", false); }
      catch (err) { woSetStatus(err.message || "Could not update workshop.", true); }
    });
    // ---- B285 wave-2: condition editor wiring. NO permission gates (friends-trust model);
    // every write is strictly validated server-side against DF's real enums and refused with a
    // clear error when malformed -- the handlers surface that error in the status line.
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
    // header add tiles. The native default for a brand-new condition is unobserved (no oracle for
    // the moment after the + click), so this is a neutral placeholder the player edits in place:
    // the first condition target, at least 1. Not native-attested; revisit if the owner captures it.
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

  // Node export for the offline CIM fixture tests (harmless in the browser: `module` is undefined).
  // Exposes only the pure, DOM-free R1/R2 helpers.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      woStatusIconKey, woIsAnyShop, woWorkshopLabel,
      soRegroup, soNativeGroupOf, soNativeLabel,
      SO_NATIVE_GROUPS, SO_NATIVE_GROUP_OF, SO_NATIVE_ORDER, SO_NATIVE_LABELS,
      // R9 petitions (3-state) + R8 chores (roster model) -- pure, DOM-free helpers.
      petitionStateLabel, petitionNextRaw, petitionRowLabel, soItemIsTristate, PETITION_STATES,
      choresModel, choreToggleValue, CHORE_TYPE_ORDER,
      woConditionDuplicate, woConditionRowHtml, woCondPickerHtml, woSuggestionRowsHtml,
      laborPanelMarkup, standingOrdersMarkup, stoneUseMarkup, workOrdersMarkup,
    };
  }
