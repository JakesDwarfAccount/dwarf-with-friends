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

  // --- schedule editor wiring ---

  const MONTH_NAMES = ["Granite", "Slate", "Felsite", "Hematite", "Malachite", "Galena",
    "Limestone", "Sandstone", "Timber", "Moonstone", "Opal", "Obsidian"];
  const SLEEP_OPTIONS = [
    ["none", "(none)"], ["anywhere", "Anywhere at will"],
    ["barracks-will", "In barracks at will"], ["barracks-need", "In barracks at need"],
  ];
  const UNIFORM_MODE_OPTIONS = [["none", "(none)"], ["regular", "Regular"], ["civilian", "Civilian"]];
  // LEDGER 0081 R22: native's month selector carries a sentinel meaning ALL TWELVE MONTHS. -1 is
  // DWF's spelling of it -- never a real month index, so it can never collide with one.
  const ALL_MONTHS = -1;

  function sqScheduleSquadCell(squad, esc = window.sqEsc) {
    return `<section class="squad-schedule-squad-cell">
      ${DWFUI.plaqueBtnHtml({ label: "Add/edit routines (columns)", tone: "green", artTone: "neutral",
        dataset: { squadNav: "routines" }, title: "Add, rename or delete fort military routines" })}
      <div class="squad-equip-native-identity">${window.sqEmblemSwatch(squad, esc)}<span>${esc(squad.alias || squad.name || "Squad")}</span></div>
      ${DWFUI.plaqueBtnHtml({ label: "View monthly schedule", tone: "green", artTone: "neutral",
        dataset: { squadNav: "monthly" }, title: "View this squad's monthly schedule" })}
    </section>`;
  }

  // ---- routine copy ---------------------------------------------------------------------------
  function sqCopyLabel(clip, kind, squadId, routine, month) {
    if (!clip || clip.kind !== kind) return "Copy";
    const same = Number(clip.squadId) === Number(squadId) && Number(clip.routine) === Number(routine) &&
      (kind === "column" || Number(clip.month) === Number(month));
    return same ? "Copy" : "Paste";
  }
  function sqCopyDataset(label, kind, squadId, routine, month) {
    return label === "Copy"
      ? { copyKind: kind, copySquad: squadId, copyRoutine: routine, copyMonth: month }
      : { pasteKind: kind, pasteSquad: squadId, pasteRoutine: routine, pasteMonth: month };
  }

  function sqScheduleView(detail, esc = window.sqEsc, clip = null) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const routines = Array.isArray(detail.routines) ? detail.routines : [];
    const routineScheds = Array.isArray(detail.routineSchedules) ? detail.routineSchedules : [];
    const header = `<div id="squadStatus" class="info-message squad-status"></div>`;
    if (!routines.length) {
      return header + DWFUI.gridHtml({ cls: "squad-schedule-overview" },
        sqScheduleSquadCell(squad, esc) +
        `<div class="info-message">No military routines exist yet. Use ?Add/edit routines? to create this squad's first training routine.</div>`);
    }
    const routineCells = routines.map(routine => {
      const served = routineScheds.find(rs => Number(rs.idx) === Number(routine.idx));
      const month = served && Array.isArray(served.months) ? served.months[0] : null;
      const label = month ? (month.orderLabel || (month.hasTrain ? "Train" : "No orders")) :
        (Number(routine.idx) === Number(squad.routineIdx) ? "Monthly orders" : "No orders");
      const actionLabel = month && month.hasTrain ? "Clear" : "Edit";
      const active = Number(routine.idx) === Number(squad.routineIdx);
      const name = routine.name || ("Routine " + routine.idx);
      const inner = `
        ${DWFUI.plaqueBtnHtml({ label: name, artTone: "neutral", cls: "squad-schedule-routine-name" })}
        <div class="squad-schedule-routine-order${month && month.hasTrain ? " active" : ""}">${esc(label)}</div>
        <div class="squad-schedule-routine-actions">
          ${DWFUI.plaqueBtnHtml({ label: actionLabel, tone: month && month.hasTrain ? "orange" : "green",
            artTone: "neutral", cls: "squad-schedule-edit", dataset: { trainRoutine: routine.idx, trainMonth: 0 },
            title: "Edit this routine's current-month order" })}
          ${(() => {
            // R24 column flavour: the whole twelve-month routine, across squads.
            const label = sqCopyLabel(clip, "column", squad.id, routine.idx, 0);
            return DWFUI.plaqueBtnHtml({ label, tone: "green", artTone: "neutral",
              cls: "squad-schedule-copy" + (label === "Paste" ? " squad-copy-paste" : ""),
              dataset: sqCopyDataset(label, "column", squad.id, routine.idx, 0),
              title: label === "Copy"
                ? `Copy all twelve months of ${name} — then Paste it onto another squad's routine`
                : `Paste the copied twelve-month routine over ${name} (every order in it is replaced)` });
          })()}
        </div>`;
      return DWFUI.selectCellHtml({
        selected: active, cls: "squad-schedule-routine",
        dataset: { routineIdx: routine.idx, scheduleRoutine: routine.idx },
        title: active ? `${name} is this squad's active routine`
                      : `Put this squad on the ${name} routine`,
        ariaLabel: name,
      }, inner);
    }).join("");
    return header + DWFUI.gridHtml({ cls: "squad-schedule-overview" },
      sqScheduleSquadCell(squad, esc) +
      DWFUI.selectCellGroupHtml({ cls: "squad-schedule-routines",
        ariaLabel: "Training routine for this squad" }, routineCells));
  }


  // ---- Add/Edit Routines (native 7.1): fort-global routine list authoring. ----
  function sqRoutinesView(detail, esc = window.sqEsc) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const routines = Array.isArray(detail.routines) ? detail.routines : [];
    // A routine's NAME is load-bearing: squad creation seeds presets by string-comparing it, so a
    // rename silently changes what every future squad inherits.
    const PRESET_NAMES = ["Off duty", "Staggered training"];
    const preset = name => PRESET_NAMES.some(p => p === String(name || "").trim());
    const rows = routines.length
      ? routines.map(r => `<div class="squad-routine-row" data-routine-idx="${r.idx}">
          ${DWFUI.textInputHtml({ cls: "squad-input squad-routine-name", maxLength: 23,
            value: r.name || ("Routine " + r.idx),
            dataset: preset(r.name) ? { routinePreset: true } : null,
            title: preset(r.name)
              ? "Dwarf Fortress recognises this routine BY NAME and seeds new squads from it — renaming it changes what future squads inherit"
              : null })}
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.quill, cls: "squad-routine-rename",
            title: "Rename this routine", ariaLabel: "Rename this routine" })}
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump, cls: "squad-danger squad-routine-delete",
            title: "Delete this routine — every squad in the fortress loses this slot, and each squad's active routine is renumbered",
            ariaLabel: "Delete this routine" })}
        </div>`).join("")
      : `<div class="info-message">No routines.</div>`;
    return `
      <div id="squadStatus" class="info-message squad-status"></div>
      <div class="squad-routine-head"><div class="squad-section-title">Military routines</div>
        ${window.sqBackPlaque("Done")}</div>
      <div class="info-message squad-routine-note">These routines belong to the whole fortress: adding
        one gives every squad a new slot, and deleting one takes that slot away from every squad.
        Dwarf Fortress also matches the names <strong>Off duty</strong> and
        <strong>Staggered training</strong> exactly, and seeds newly created squads from them —
        renaming either changes what future squads start with.</div>
      ${window.sqListHtml({ cls: "squad-routine-list", rows: ".squad-routine-row", preserveKey: "squads:routines" }, rows)}
      <div class="squad-controls">
        ${DWFUI.textInputHtml({ cls: "squad-input squad-routine-newname", id: "routineNewName",
          maxLength: 23, placeholder: "New routine name..." })}
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Add new routine", tone: "green", artTone: "neutral",
          title: "Create a new fort military routine" }), "routineAddBtn")}
      </div>`;
  }

  // ---- View Monthly Schedule (native 7.2): a squad's months x routines grid. ----
  function sqMonthlyView(detail, esc = window.sqEsc, clip = null) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const header = `${window.sqBackHeader(squad, esc)}
      <div id="squadStatus" class="info-message squad-status"></div>`;
    const routineScheds = Array.isArray(detail.routineSchedules) ? detail.routineSchedules : [];
    if (!routineScheds.length) {
      return header + `<div class="info-message">This build does not serve the full monthly schedule.</div>`;
    }
    const headCells = routineScheds.map(rs => `<div class="squad-month-head">${esc(rs.name || ("Routine " + rs.idx))}</div>`).join("");
    const monthRows = MONTH_NAMES.map((mn, m) => {
      const cells = routineScheds.map(rs => {
        const month = Array.isArray(rs.months) ? rs.months.find(x => x.month === m) : null;
        const label = month ? esc(month.orderLabel || "No orders") : "—";
        const cls = month && month.hasTrain ? " squad-month-train" : "";
        return `<div class="squad-month-cell${cls}">
          <span class="squad-month-order">${label}</span>
          ${DWFUI.plaqueBtnHtml({ label: "Edit", tone: "green", artTone: "neutral",
            cls: "squad-month-edit", dataset: { trainRoutine: rs.idx, trainMonth: m },
            title: "Edit this routine-month's training order" })}
          ${(() => {
            // R24 cell flavour: one month cell onto another month cell of the SAME squad, so a
            // clipboard belonging to a different squad offers nothing here.
            const foreign = clip && clip.kind === "cell" && Number(clip.squadId) !== Number(squad.id);
            const label = foreign ? "Copy" : sqCopyLabel(clip, "cell", squad.id, rs.idx, m);
            return DWFUI.plaqueBtnHtml({ label, tone: "green", artTone: "neutral",
              cls: "squad-month-copy" + (label === "Paste" ? " squad-copy-paste" : ""),
              dataset: sqCopyDataset(label, "cell", squad.id, rs.idx, m),
              title: label === "Copy"
                ? "Copy this routine-month — then Paste it onto another month of this squad"
                : "Paste the copied routine-month here (this cell's orders are replaced)" });
          })()}
        </div>`;
      }).join("");
      return `<div class="squad-month-row"><div class="squad-month-name">${esc(mn)}</div>${cells}</div>`;
    }).join("");
    return `${header}
      <div class="squad-section-title">Monthly schedule</div>
      ${DWFUI.scrollHtml({ preserveKey: "squads:monthly" },
        DWFUI.gridHtml({ cls: "squad-month-grid" },
          `<div class="squad-month-row squad-month-header"><div class="squad-month-name"></div>${headCells}</div>
          ${monthRows}`))}`;
  }

  // ---- Edit Training (native 7.3): one routine-month's Equip + Sleep modes and Train order. ----
  function sqTrainingView(detail, sel, esc = window.sqEsc, draft = null) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const header = `<div class="squad-back-head">
        ${window.sqBackPlaque("Back to schedule")}
        <div class="squad-back-title">${esc(squad.alias || squad.name || ("Squad " + squad.id))}</div>
      </div>
      <div id="squadStatus" class="info-message squad-status"></div>`;
    const routineScheds = Array.isArray(detail.routineSchedules) ? detail.routineSchedules : [];
    const rs = routineScheds.find(x => x.idx === (sel && sel.routine));
    // ---- "all months" is a real state -----------------------------------------------------------
    const allMonths = Number(sel && sel.month) === ALL_MONTHS;
    // With the sentinel active the editor still needs ONE month's served values to seed its
    // controls; native seeds from the first, and so do we. The write is what differs, not the read.
    const month = rs && Array.isArray(rs.months)
      ? (allMonths ? rs.months.find(x => Number(x.month) === 0) || rs.months[0]
        : rs.months.find(x => x.month === (sel && sel.month)))
      : null;
    if (!rs || !month) {
      return header + `<div class="info-message">This build does not serve the editable schedule.</div>`;
    }
    const monthOptions = [[String(ALL_MONTHS), "All months"]]
      .concat(MONTH_NAMES.map((name, i) => [String(i), name]));
    // The draft is seeded from the SERVED routine-month, so a freshly-opened editor reads exactly as
    // the old one did. It exists because a segmented control / a check tile is stateless markup.
    const d = draft || {};
    const sleep = d.sleep != null ? d.sleep : month.sleep;
    const uniform = d.uniform != null ? d.uniform : month.uniform;
    const train = d.train != null ? !!d.train : !!month.hasTrain;
    const min = d.min != null ? Number(d.min) : (Number(month.minCount) || 0);
    const members = Array.isArray(squad.members) ? squad.members : [];
    const assignmentIds = Array.isArray(month.assignedPositions) ? month.assignedPositions.map(Number) : [];
    const assignmentServed = Array.isArray(month.assignedPositions);
    // Whole-squad IS the empty position selection, never a third stored state: selecting whole-squad
    // clears the positions, and removing the last position restores it.
    const wholeSquad = assignmentServed && assignmentIds.length === 0;
    const wholeSquadRow = `<div class="squad-training-member squad-training-whole-squad" data-training-position="whole">
        <div class="squad-training-member-who"><span>Whole squad<small>${
          assignmentServed
            ? (wholeSquad ? "Every position follows this order"
              : "Ticking this clears every position below")
            : "Per-position assignment is not served by the current game bridge"}</small></span></div>
        ${DWFUI.checkHtml({ checked: !!wholeSquad, cls: "squad-training-member-check",
          disabled: !assignmentServed, dataset: { trainingPosition: "whole" },
          title: assignmentServed
            ? "Whole squad — the state where no individual position is selected"
            : "Per-position assignment is not served by the current game bridge",
          ariaLabel: "Whole squad" })}
      </div>`;
    const roster = wholeSquadRow + members.map(member => {
      const filled = !!member.filled;
      const name = filled ? (member.name || ("Unit " + member.unitId)) : "Vacant position";
      const sub = filled ? (member.positionName || "No orders") : "No orders";
      return `<div class="squad-training-member" data-training-position="${member.idx}">
        <div class="squad-training-member-who">${filled ? window.sqUnitPortrait(member) : ""}<span>${esc(name)}<small>${esc(sub)}</small></span></div>
        ${DWFUI.checkHtml({ checked: assignmentServed && assignmentIds.includes(Number(member.idx)),
          cls: "squad-training-member-check", disabled: !assignmentServed,
          dataset: { trainingPosition: member.idx },
          title: assignmentServed ? "Include this position in the order" : "Per-position assignment is not served by the current game bridge",
          ariaLabel: `Include ${name} in the training order` })}
      </div>`;
    }).join("");
    return `${header}
      <div class="squad-section-title">Editing routine ${esc(rs.name || ("Routine " + rs.idx))} &middot; ${
        allMonths ? "all twelve months" : esc(MONTH_NAMES[month.month] || ("Month " + (month.month + 1)))}</div>
      <div class="squad-controls">
        <span class="squad-field-label">Month</span>${window.sqCyclerHtml("trainMonth", monthOptions,
          String(allMonths ? ALL_MONTHS : month.month), { cls: "squad-train-month", title: "Month",
          ariaLabel: "Month being edited" })}
      </div>
      ${allMonths ? `<div class="info-message squad-train-all-months">Saving writes this order into
        <strong>all twelve months</strong> of this routine.</div>` : ""}
      <div class="squad-controls">
        <label class="squad-ammo-flag">Equip&nbsp;${DWFUI.segmentedHtml({ cls: "squad-train-uniform",
          dataAttr: "train-uniform", active: String(uniform), ariaLabel: "Equip (uniform) mode",
          options: UNIFORM_MODE_OPTIONS.map(([v, label]) => ({ key: v, label })) })}</label>
        <label class="squad-ammo-flag">Sleep&nbsp;${DWFUI.segmentedHtml({ cls: "squad-train-sleep",
          dataAttr: "train-sleep", active: String(sleep), ariaLabel: "Sleep mode",
          options: SLEEP_OPTIONS.map(([v, label]) => ({ key: v, label })) })}</label>
      </div>
      <div class="squad-controls">
        <label class="squad-ammo-flag">${window.sqWithId(DWFUI.checkHtml({ checked: train,
          dataset: { trainOrder: "" }, title: "Train order", ariaLabel: "Train order" }), "trainOrder")}Train</label>
        <label class="squad-ammo-flag">Min soldiers&nbsp;${window.sqStepperHtml({
          cls: "squad-pos-input squad-train-min", inputCls: "squad-input squad-train-min-input",
          inputId: "trainMin", min: 0,
          max: Math.max(Number(min) || 0, Number(squad.positionCount) || 99),
          value: min, ariaLabel: "Minimum soldiers" })}</label>
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Save", tone: "green", artTone: "neutral",
          title: "Save this routine-month's schedule" }), "trainSaveBtn")}
      </div>
      <div class="squad-training-order-summary"><span>At least ${min}</span><strong>Train</strong></div>
      ${window.sqListHtml({ cls: "squad-training-roster", rows: ".squad-training-member", preserveKey: "squads:training-roster" },
        roster || `<div class="info-message">This squad has no positions.</div>`)}`;
  }

  async function squadSchedulePost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return window.squadFetchJson(`/squad-schedule?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireSquadScheduleControls(squad) {
    const pickRoutine = async raw => {
      const idx = Number(raw);
      if (!Number.isFinite(idx)) return;
      if (idx === Number(squad.routineIdx)) return;   // already the active routine -> no pointless write
      try {
        await squadSchedulePost({ squad: squad.id, action: "set-routine", routine: idx });
        window.DFSquadController.squadStatusMsg = "Active routine changed.";
      } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not change routine."; }
      await window.loadSquadDetail(squad.id);
    };
    clientPanel.querySelectorAll("[data-schedule-routine]").forEach(cell => {
      cell.addEventListener("click", () => pickRoutine(cell.dataset.scheduleRoutine));
      cell.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();                        // Space must not scroll the panel
        pickRoutine(cell.dataset.scheduleRoutine);
      });
    });
    // Stop propagation: Edit/Clear/Copy act on their own routine and must not also select it.
    clientPanel.querySelectorAll(".squad-schedule-edit, .squad-schedule-copy").forEach(btn => {
      btn.addEventListener("click", event => event.stopPropagation());
    });
    clientPanel.querySelectorAll(".squad-schedule-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        window.DFSquadController.trainingSel = { routine: Number(btn.dataset.trainRoutine), month: Number(btn.dataset.trainMonth) };
        window.goToView("training");
      });
    });
    wireScheduleCopyControls(squad);
  }

  async function scheduleCopyPost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return window.squadFetchJson(`/squad-schedule?${q}&t=${Date.now()}`, { method: "POST" });
  }
  function wireScheduleCopyControls(squad) {
    clientPanel.querySelectorAll("[data-copy-kind]").forEach(btn => {
      btn.addEventListener("click", event => {
        event.stopPropagation();
        window.DFSquadController.scheduleClipboard = {
          kind: btn.dataset.copyKind,
          squadId: Number(btn.dataset.copySquad),
          routine: Number(btn.dataset.copyRoutine),
          month: Number(btn.dataset.copyMonth),
        };
        window.DFSquadController.squadStatusMsg = window.DFSquadController.scheduleClipboard.kind === "column"
          ? "Routine copied. Open another squad's schedule and press Paste."
          : "Routine-month copied. Press Paste on another month.";
        window.renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll("[data-paste-kind]").forEach(btn => {
      btn.addEventListener("click", async event => {
        event.stopPropagation();
        const clip = window.DFSquadController.scheduleClipboard;
        if (!clip) return;
        const kind = btn.dataset.pasteKind;
        const params = kind === "column"
          ? { squad: Number(btn.dataset.pasteSquad), action: "copy-routine",
              routine: Number(btn.dataset.pasteRoutine),
              srcSquad: clip.squadId, srcRoutine: clip.routine }
          : { squad: Number(btn.dataset.pasteSquad), action: "copy-month",
              routine: Number(btn.dataset.pasteRoutine), month: Number(btn.dataset.pasteMonth),
              srcSquad: clip.squadId, srcRoutine: clip.routine, srcMonth: clip.month };
        try {
          await scheduleCopyPost(params);
          window.DFSquadController.squadStatusMsg = kind === "column" ? "Routine pasted." : "Routine-month pasted.";
        } catch (err) {
          // A bridge without the copy route says so in its own words, exactly like /routine-*.
          window.DFSquadController.squadStatusMsg = err.message || "Could not paste the copied schedule.";
        }
        await window.loadSquadDetail(squad.id);
      });
    });
  }

  // --- supplies wiring (native 5.4) ---
  async function squadSuppliesPost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return window.squadFetchJson(`/squad-supplies?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireSquadSuppliesControls(squad) {
    clientPanel.querySelectorAll("[data-supply-food]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await squadSuppliesPost({ squad: squad.id, food: Number(btn.dataset.supplyFood) });
          window.DFSquadController.squadStatusMsg = "Supplies updated.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not update supplies."; }
        await window.loadSquadDetail(squad.id);
      });
    });
    clientPanel.querySelectorAll("[data-supply-water]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await squadSuppliesPost({ squad: squad.id, water: btn.dataset.supplyWater });
          window.DFSquadController.squadStatusMsg = "Supplies updated.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not update supplies."; }
        await window.loadSquadDetail(squad.id);
      });
    });
  }

  // --- routine authoring wiring (native 7.1) ---
  async function routinePost(path, params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return window.squadFetchJson(`/${path}?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireRoutinesControls(squad) {
    clientPanel.querySelector("#routineAddBtn")?.addEventListener("click", async () => {
      const name = clientPanel.querySelector("#routineNewName")?.value || "";
      try {
        await routinePost("routine-create", name ? { name } : {});
        window.DFSquadController.squadStatusMsg = "Routine added.";
      } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not add routine (this build may not support routine authoring)."; }
      await window.loadSquadDetail(squad.id);
    });
    clientPanel.querySelectorAll(".squad-routine-row").forEach(row => {
      const idx = Number(row.dataset.routineIdx);
      row.querySelector(".squad-routine-rename")?.addEventListener("click", async () => {
        const name = row.querySelector(".squad-routine-name")?.value || "";
        try {
          await routinePost("routine-rename", { idx, name });
          window.DFSquadController.squadStatusMsg = "Routine renamed.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not rename routine."; }
        await window.loadSquadDetail(squad.id);
      });
      row.querySelector(".squad-routine-delete")?.addEventListener("click", async () => {
        try {
          await routinePost("routine-delete", { idx });
          window.DFSquadController.squadStatusMsg = "Routine deleted.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not delete routine."; }
        await window.loadSquadDetail(squad.id);
      });
    });
  }

  // --- monthly grid wiring (native 7.2): each Edit opens the training editor (7.3) ---
  function wireMonthlyControls(squad) {
    clientPanel.querySelectorAll(".squad-month-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        window.DFSquadController.trainingSel = { routine: Number(btn.dataset.trainRoutine), month: Number(btn.dataset.trainMonth) };
        window.goToView("training");
      });
    });
    wireScheduleCopyControls(squad);
  }

  // --- training editor wiring (native 7.3): Save writes sleep/uniform (set-month) + the Train
  // order toggle w/ min count (set-month-order), both scoped to the selected routine + month. ---
  function wireTrainingControls(squad) {
    // Seed the draft from the SERVED routine-month the first time the editor paints, so Save writes
    // exactly what the old #trainSleep/#trainUniform/#trainOrder/#trainMin would have written.
    const scheds = Array.isArray(window.DFSquadController.squadDetail && window.DFSquadController.squadDetail.routineSchedules) ? window.DFSquadController.squadDetail.routineSchedules : [];
    const rs = scheds.find(x => x.idx === window.DFSquadController.trainingSel.routine);
    const m = rs && Array.isArray(rs.months) ? rs.months.find(x => x.month === window.DFSquadController.trainingSel.month) : null;
    if (!window.DFSquadController.trainDraft && m) {
      window.DFSquadController.trainDraft = { sleep: m.sleep, uniform: m.uniform, train: !!m.hasTrain, min: Number(m.minCount) || 0 };
    }
    clientPanel.querySelectorAll("[data-train-sleep]").forEach(seg => {
      seg.addEventListener("click", () => {
        window.DFSquadController.trainDraft = Object.assign({}, window.DFSquadController.trainDraft, { sleep: seg.dataset.trainSleep });
        window.renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll("[data-train-uniform]").forEach(seg => {
      seg.addEventListener("click", () => {
        window.DFSquadController.trainDraft = Object.assign({}, window.DFSquadController.trainDraft, { uniform: seg.dataset.trainUniform });
        window.renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#trainOrder")?.addEventListener("click", () => {
      window.DFSquadController.trainDraft = Object.assign({}, window.DFSquadController.trainDraft, { train: !(window.DFSquadController.trainDraft && window.DFSquadController.trainDraft.train) });
      window.renderSquadsPanel();
    });
    const minInput = clientPanel.querySelector("#trainMin");
    minInput?.addEventListener("input", () => {
      window.DFSquadController.trainDraft = Object.assign({}, window.DFSquadController.trainDraft, { min: Number(minInput.value) || 0 });
    });
    clientPanel.querySelector("#trainSaveBtn")?.addEventListener("click", async () => {
      const routine = window.DFSquadController.trainingSel.routine;
      const d = window.DFSquadController.trainDraft || {};
      const sleep = d.sleep || "none";
      const uniform = d.uniform || "none";
      const train = !!d.train;
      const min = Number(minInput ? minInput.value : d.min) || 0;
      const months = window.DFSquadController.trainingSel.month === ALL_MONTHS
        ? MONTH_NAMES.map((unused, i) => i) : [window.DFSquadController.trainingSel.month];
      let written = 0;
      try {
        for (const month of months) {
          await squadSchedulePost({ squad: squad.id, action: "set-month", routine, month, sleep, uniform });
          await squadSchedulePost({ squad: squad.id, action: "set-month-order", routine, month,
            order: train ? "train" : "none", min });
          written++;
        }
        window.DFSquadController.squadStatusMsg = months.length > 1
          ? `Training schedule saved for all ${months.length} months.` : "Training schedule saved.";
      } catch (err) {
        const base = err.message || "Could not save training schedule.";
        window.DFSquadController.squadStatusMsg = months.length > 1 && written
          ? `${base} (${written} of ${months.length} months were written.)` : base;
      }
      await window.loadSquadDetail(squad.id);
    });
  }

  window.sqScheduleView = sqScheduleView;
  window.sqRoutinesView = sqRoutinesView;
  window.sqMonthlyView = sqMonthlyView;
  window.sqTrainingView = sqTrainingView;
  window.squadSchedulePost = squadSchedulePost;
  window.wireSquadScheduleControls = wireSquadScheduleControls;
  window.wireSquadSuppliesControls = wireSquadSuppliesControls;
  window.wireRoutinesControls = wireRoutinesControls;
  window.wireMonthlyControls = wireMonthlyControls;
  window.wireTrainingControls = wireTrainingControls;
