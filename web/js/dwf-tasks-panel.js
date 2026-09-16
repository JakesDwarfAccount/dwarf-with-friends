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

  // The Tasks tab is JOB-FIRST: job name, portrait, "Name, Profession", then cancel + locate. The job
  // text is served in `row.status`; everything is graceful when a field is absent.
  function taskNameProf(row) {
    if (!row || !row.name) return "";
    return row.profession ? `${row.name}, ${row.profession}` : String(row.name);
  }

  // An absent cell renders NOTHING, but it still EXISTS: `.info-task-row` is a fixed 4-column grid, so
  // dropping the element would slide the name into the icon column.
  function taskPlaceCellHtml(row) {
    if (window.infoRowHasPlaceArt(row)) return window.infoPlaceIconMarkup(row);
    return `<span class="info-task-noicon"></span>`;
  }

  // Six job controls sit BEFORE the portrait; the recenter+magnifier pair sits after the name. An
  // ungated control is OMITTED, never greyed: a greyed tile advertises a write native does not offer.
  const TASK_CONTROL_SPRITE = {
    recenterBuilding: (S) => S.recenter,
    // INFERENCE, FLAGGED: no ledger pins this control's art, so it borrows the only decoded
    // "open the details editor" tile. The editor surface itself remains deferred under DEF-020.
    jobDetails:       (S) => S.woDetails || S.view,
    toggleRepeat:     (S, on) => (on ? S.repeatOn : S.repeat),
    removeWorker:     (S) => S.jobRemoveWorker,
    suspendJob:       (S, on) => (on ? S.suspendOn : S.suspend),
    cancelJob:        (S) => S.cancelJob,
  };
  const TASK_CONTROL_TITLE = {
    recenterBuilding: "Recenter on this job's building",
    jobDetails: "Job details",
    toggleRepeat: "Repeat this job",
    removeWorker: "Remove this job's worker",
    suspendJob: "Suspend this job",
    cancelJob: "Cancel this job",
  };
  // jobDetails is intentionally absent: its availability is served, but no browser editor exists (DEF-020).
  if (typeof window !== "undefined") window.TASK_JOB_ACTION = Object.freeze({
    recenterBuilding: "recenter",
    toggleRepeat: "repeat",
    removeWorker: "removeWorker",
    suspendJob: "suspend",
  });
  // Built defensively: a field the server does not send is left UNDEFINED rather than defaulted to
  // something truthy, which is what makes the helper suppress instead of invent.
  function taskJobModel(row) {
    if (!row) return {};
    const model = { jobId: Number(row.jobId ?? -1) };
    if (row.jobFlags && typeof row.jobFlags === "object") model.flags = row.jobFlags;
    if (row.jobHolder && typeof row.jobHolder === "object") model.holder = row.jobHolder;
    if (typeof row.hasWorker === "boolean") model.hasWorker = row.hasWorker;
    if (typeof row.detailsAvail === "boolean") model.detailsAvail = row.detailsAvail;
    if (typeof row.cancelAvail === "boolean") model.cancelAvail = row.cancelAvail;
    return model;
  }
  function taskJobControlsHtml(row) {
    const ui = window.dwfuiAccessor();
    if (!ui || typeof ui.infoTaskControls !== "function")
      return `<span class="info-task-jobctl"></span>`;
    const S = ui.TOKENS.sprites;
    const jobId = Number(row?.jobId ?? -1);
    const controls = ui.infoTaskControls(taskJobModel(row));
    // The cell still EXISTS when the cluster is empty: the row is a fixed cell-unit grid, so dropping
    // the element would slide the portrait six columns left.
    if (!controls.length) return `<span class="info-task-jobctl"></span>`;
    const items = controls.map(c => ({
      action: c.key,
      sprite: (TASK_CONTROL_SPRITE[c.key] || (() => S.view))(S, c.on),
      active: c.on === true,
      title: TASK_CONTROL_TITLE[c.key] || c.hover,
      dataset: c.key === "cancelJob"
        ? { infoCancelJob: jobId }
        : { infoJobControl: c.key, infoJobId: jobId },
    }));
    return ui.actionButtonsHtml(items,
      { cls: "info-row-actions info-task-jobctl", btnCls: "info-row-action", ariaLabel: "Job controls" });
  }
  // BOTH tiles are omitted together when no coordinate resolves, which is native's behaviour for a
  // worker it cannot place. A caged worker recenters on its own stored position: our wire serves no container.
  function taskUnitControlsHtml(row) {
    const ui = window.dwfuiAccessor();
    if (!ui || typeof ui.infoTaskRecenterTarget !== "function")
      return `<span class="info-task-unitctl"></span>`;
    const target = ui.infoTaskRecenterTarget({
      pos: window.infoRowPos(row),
      contained: row && row.workerContained === true,
      containerPos: row && row.workerContainerPos,
    });
    if (!target) return `<span class="info-task-unitctl"></span>`;
    const S = ui.TOKENS.sprites;
    return ui.actionButtonsHtml([
      { action: "recenter", sprite: S.recenter, dataset: { infoCenter: "" },
        title: "Recenter on this unit" },
      { action: "view", sprite: S.view, dataset: { infoOpen: "" },
        title: "View this unit" },
    ], { cls: "info-row-actions info-task-unitctl", btnCls: "info-row-action", ariaLabel: "Unit actions" });
  }

  function taskRowsHtml(rows) {
    if (!Array.isArray(rows) || !rows.length)
      return "";
    const ui = window.dwfuiAccessor();
    // Hard cut plus dots at native's two budgets. NOT fitNativeLabel -- abbreviate-then-cut produces a
    // different string from native for any text over the budget.
    const cut = (text, key) => (ui && typeof ui.hardCutDots === "function")
      ? ui.hardCutDots(text, ui.TASKS_TEXT_BUDGETS[key])
      : String(text == null ? "" : text);
    const rowsHtml = rows.map(row => {
          const job = cut(row.status || row.job || "", "job");
          const unitId = Number(row.unitId ?? -1);
          const pos = window.infoRowPos(row);
          const nameColor = window.professionColorStyle(row);
          const nameProf = cut(taskNameProf(row), "worker");
          return `
            <div class="info-row info-task-row${unitId >= 0 || Number(row.locationId ?? -1) >= 0 ? " clickable" : ""}${row.muted ? " info-muted" : ""}"
              data-unit-id="${escapeHtml(unitId)}"
              data-place-kind="${escapeHtml(String(row.kind || ""))}"
              data-location-id="${escapeHtml(row.locationId ?? -1)}"
              data-building-id="${escapeHtml(row.buildingId ?? -1)}"
              data-item-id="${escapeHtml(row.itemId ?? -1)}"
              ${pos ? `data-pos-x="${escapeHtml(pos.x)}" data-pos-y="${escapeHtml(pos.y)}" data-pos-z="${escapeHtml(pos.z)}"` : ""}>
              <div class="info-task-job">${DWFUI.bitmapTextHtml(job)}</div>
              ${taskJobControlsHtml(row)}
              ${unitId >= 0 ? unitPortraitMarkup(row, "info-portrait-small") : taskPlaceCellHtml(row)}
              <div class="info-task-name"${nameColor}>${DWFUI.bitmapTextHtml(nameProf)}</div>
              ${taskUnitControlsHtml(row)}
            </div>`;
        }).join("");
    return DWFUI.scrollHtml({
      cls: "info-table info-task-table", rows: ".info-task-row", ariaLabel: "Tasks",
    }, rowsHtml);
  }

  if (typeof window !== "undefined") Object.assign(window, {
    taskNameProf, taskPlaceCellHtml, taskJobModel, taskJobControlsHtml, taskUnitControlsHtml, taskRowsHtml,
  });

  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, {
    taskNameProf, taskPlaceCellHtml, taskJobModel, taskJobControlsHtml, taskUnitControlsHtml, taskRowsHtml,
  });
