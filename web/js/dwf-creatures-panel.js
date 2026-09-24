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

  // ---- the Creatures tab's row anatomy ---------------------------------------------------------
  let creatureSearch = "";
  let creatureSortKey = "name"; // native unit_list always has one active sort column
  let creatureSortDir = 1;    // 1 = ascending, -1 = descending
  let creatureRowsRaw = [];   // last-fetched rows for the active sub-tab (sort/search are local)
  let creatureTrainers = [];  // trainer-capable dwarves for the Pets tab's assign-trainer picker
  let creatureTrainerChooserUnitId = null;
  // One row per race the fort holds training knowledge about, already sorted server-side by raw name.
  let creatureTrainingKnowledge = [];
  let creatureLabor = null;
  let creatureMessageHtml = "";

  // One resolver for every unit row in the Information family; an absent byte produces no colour hook.
  function professionColorStyle(record) {
    const idx = record && record.professionColor;
    if (Number.isInteger(idx) && idx >= 0 && idx <= 15)
      return ` data-df-color="${idx}"`;
    return "";
  }

  function residentJobColorStyle(record) {
    const idx = record && record.jobColor;
    if (Number.isInteger(idx) && idx >= 0 && idx <= 15)
      return ` data-df-color="${idx}"`;
    return "";
  }

  // "Name, Profession" as two labels, so a narrow column wraps the profession under the name.
  function residentIdentityParts(row) {
    const name = String(row?.name || "");
    const profession = String(row?.profession || "");
    return name && profession ? [`${name},`, profession] : [name || profession];
  }

  // Newer hosts serve the need state independently of DF's rendered punctuation; older ones omit the
  // key, so their already-composed string is left untouched.
  function residentJobText(row) {
    const raw = String(row?.status || row?.job || "");
    if (!Object.prototype.hasOwnProperty.call(row || {}, "jobNeedDriven")) return raw;
    const base = raw.endsWith("!") ? raw.slice(0, -1) : raw;
    return row.jobNeedDriven && base ? `${base}!` : base;
  }

  function creatureRowSearchText(row) {
    return `${row.name || ""} ${row.profession || ""} ${row.category || ""} ${row.status || row.job || ""}`.toLowerCase();
  }

  function compareCreatureRows(a, b, key, dir) {
    if (key === "moodCategory") {
      const av = Number(a?.moodCategory ?? -1);
      const bv = Number(b?.moodCategory ?? -1);
      return (av - bv) * dir;
    }
    const av = String(a?.[key] || "").toLowerCase();
    const bv = String(b?.[key] || "").toLowerCase();
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * dir;
  }

  // WIRE GAP, REPORTED NOT FAKED (DEF-018): `row.heldItem` is a NAME STRING with no spriteRef, so
  // iconHtml renders the honest empty tile rather than inventing art. The tooltip keeps the real name.
  function creatureHeldItemHtml(row) {
    const name = String(row.heldItem || "");
    if (!name) return "";
    const ui = window.dwfuiAccessor();
    if (!ui) return "";
    return ui.iconHtml({ cls: "info-held-item", size: 22, title: name, alt: name });
  }

  function creatureSexGlyphHtml(row) {
    const raw = String(row?.sex || row?.gender || row?.ct || row?.casteToken || "").toLowerCase();
    if (raw === "female") return `<span class="creature-sex-glyph" title="Female">&#9792;</span>`;
    if (raw === "male") return `<span class="creature-sex-glyph" title="Male">&#9794;</span>`;
    return `<span class="creature-sex-glyph" aria-hidden="true"></span>`;
  }

  // Pure (no DOM, no globals) so the offline husbandry test can exercise the gate. Null when the animal
  // is not geldable -- a non-GELDABLE caste, an already-gelded one, and an older host all collapse to that.
  function geldButtonSpec(ls) {
    if (!ls || !ls.geldable) return null;
    return {
      action: "geld",
      active: !!ls.geld,
      label: "Geld",
      title: ls.geld ? "Marked for gelding (click to cancel)" : "Mark for gelding",
    };
  }

  function memorialButtonSpec(row, detail) {
    const unitId = Number((row && row.unitId) ?? -1);
    if (detail !== "dead" || !Number.isInteger(unitId) || unitId < 0) return null;
    return { unitId, label: "Slab", title: "Engrave memorial slab" };
  }

  // The colour goes through DWFUI.dfColor so it honours a player-edited colors.txt, never a hex.
  // `statusExact:false` means the selecting predicate is DWF's reconstruction, and the tooltip says so.
  function livestockStatusHtml(row, detail = activeInfoDetail) {
    if (detail !== "pets") return "";
    const ls = row && row.livestock;
    const text = ls && typeof ls.status === "string" ? ls.status : "";
    if (!text) return "";   // older host: no key, no column
    const ui = window.dwfuiAccessor();
    const idx = Number(ls.statusColor);
    // Native's bright flag is the high-intensity half of the 16-colour palette: index + 8.
    const paletteIndex = Number.isInteger(idx) && idx >= 0 && idx <= 7
      ? (ls.statusBright ? idx + 8 : idx) : idx;
    const hasColor = ui && Number.isInteger(paletteIndex) && paletteIndex >= 0 && paletteIndex <= 15;
    const title = ls.statusExact
      ? "This animal's slaughter status, read from DF's own flag"
      : "This animal's slaughter status. The wording and colour are DF's; which one applies is " +
        "Dwarf With Friends' reconstruction of DF's test, not a verified copy of it.";
    return DWFUI.statusHtml({
      cls: `livestock-status${ls.statusExact ? "" : " livestock-status-approx"}`,
      dfColor: hasColor ? paletteIndex : null, title, text,
    });
  }

  function livestockActionsHtml(row, detail = window.dwfInfoState().detail) {
    if (detail !== "pets") return "";
    const ls = row && row.livestock;
    if (!ls) return "";
    const unitId = Number(row.unitId ?? -1);
    if (!(unitId >= 0)) return "";
    const ui = window.dwfuiAccessor();
    if (!ui) return "";
    // Native owns these six state tiles as art latches: route state, disabled law, tooltip and pressed
    // semantics through the shared component, keeping the existing action/unit hooks.
    const btn = (action, on, label, title, sprite, activeSprite = sprite) => DWFUI.latchHtml({
      on: !!on, cls: "livestock-btn", sprite, activeSprite, title, ariaLabel: label,
      dataset: { livestockAction: action, livestockUnit: unitId },
    });
    let out = "";
    out += btn("slaughter", ls.slaughter, "Slaughter", ls.slaughter ? "Marked for slaughter (click to cancel)" : "Mark for slaughter",
      "PETS_LIVESTOCK_SLAUGHTER_INACTIVE", "PETS_LIVESTOCK_SLAUGHTER_ACTIVE");
    // Geld sits immediately after Slaughter; an older host omits `geldable`, so no button.
    const geld = geldButtonSpec(ls);
    if (geld) out += btn(geld.action, geld.active, geld.label, geld.title,
      "PETS_LIVESTOCK_GELD_INACTIVE", "PETS_LIVESTOCK_GELD_ACTIVE");
    if (ls.trainableWar)
      out += btn("war", ls.war, "War", ls.war ? "War training assigned (click to cancel)" : "Train for war",
        "PETS_LIVESTOCK_WAR_TRAINING_INACTIVE", "PETS_LIVESTOCK_WAR_TRAINING_ACTIVE");
    if (ls.trainableHunt)
      out += btn("hunt", ls.hunt, "Hunt", ls.hunt ? "Hunt training assigned (click to cancel)" : "Train for hunting",
        "PETS_LIVESTOCK_HUNT_TRAINING_INACTIVE", "PETS_LIVESTOCK_HUNT_TRAINING_ACTIVE");
    if (!ls.pet)
      out += btn("pet", ls.adoption, "Make pet", ls.adoption ? "Available for adoption (click to cancel)" : "Make available for adoption",
        "PETS_LIVESTOCK_UNAVAILABLE_AS_PET", "PETS_LIVESTOCK_AVAILABLE_AS_PET");
    if (ls.tamable) {
      out += DWFUI.latchHtml({
        on: !!ls.training, cls: "livestock-btn", sprite: "PETS_LIVESTOCK_ASSIGN_TRAINER",
        activeSprite: "PETS_LIVESTOCK_ASSIGN_TRAINER", title: "Choose this animal's trainer",
        ariaLabel: "Choose trainer", dataset: { trainerChooserOpen: unitId },
      });
    }
    return `<div class="livestock-actions">${out}</div>`;
  }

  function creatureSortHead(sortKey = creatureSortKey, sortDir = creatureSortDir, residents = false) {
    const ui = window.dwfuiAccessor();
    if (!ui) return "";
    const col = (key, label, title = `Sort by ${label}`) => ({
      key, label,
      sort: sortKey === key && Number(sortDir) !== -1 ? "asc" : "desc",
      title,
    });
    const columns = [col("name", "Name"), col("category", "Cat"), col("profession", "Prof")];
    if (residents) columns.push(
      col("status", "", "Sort by current job"),
      col("moodCategory", "", "Sort by happiness"));
    return ui.sortHeaderHtml({
      cls: residents ? "info-sort-head-row resident-sort-head-row" : "info-sort-head-row creature-sort-head-row",
      dataAttr: "creature-sort",
      ariaLabel: "Sort creatures", active: sortKey || null,
      columns,
    });
  }

  // SUPERSET KEPT: the memorial-slab shortcut is ours, not DF's. It keeps a TEXT label because no DF
  // tile attests the action, and inventing a sprite for a control DF lacks is the fabrication we forbid.
  function creatureRowActionsHtml(row, memorial, pos) {
    const ui = window.dwfuiAccessor();
    if (!ui) return "";
    const S = ui.TOKENS.sprites;
    const items = [];
    if (memorial) items.push({ action: "memorial", glyph: escapeHtml(memorial.label),
      dataset: { memorialSlab: memorial.unitId }, title: memorial.title });
    if (pos) items.push({ action: "recenter", sprite: S.recenter,
      dataset: { infoCenter: "" }, title: "Locate on the map" });
    items.push({ action: "view", sprite: S.view, dataset: { infoOpen: "" }, title: "View" });
    return ui.actionButtonsHtml(items, { cls: "info-row-actions creature-actions",
      btnCls: "info-row-action", ariaLabel: "Creature actions" });
  }

  // ---- the resident row's two native columns ---------------------------------------------------
  function residentLaborState(row, labor) {
    const empty = { known: false, specialized: false, details: [] };
    const unitId = Number(row?.unitId ?? -1);
    if (!row || !Number.isInteger(unitId) || unitId < 0) return empty;

    if (Object.prototype.hasOwnProperty.call(row, "specialized") && Array.isArray(row.workDetails)) {
      return {
        known: true,
        specialized: !!row.specialized,
        details: row.workDetails
          .filter(d => d && d.name != null)
          .map(d => ({ name: String(d.name), icon: String(d.icon || "NONE") })),
      };
    }

    // Detail names are user-editable and CAN contain a comma, so never blind-split `assignedTo`: match
    // the pieces against details[], longest first. Anything left over is reported by name with no icon.
    const laborRows = Array.isArray(labor?.rows) ? labor.rows : null;
    const laborDetails = Array.isArray(labor?.details) ? labor.details : [];
    if (!laborRows) return empty;
    const mine = laborRows.find(r => Number(r?.id ?? -1) === unitId);
    if (!mine) return empty;   // not an assignable citizen (a long-term resident) -> unknown

    const assigned = String(mine.assignedTo || "").trim();
    const details = [];
    if (assigned) {
      const vocab = laborDetails
        .filter(d => d && d.name)
        .slice()
        .sort((a, b) => String(b.name).length - String(a.name).length);
      let rest = assigned;
      let guard = 0;
      while (rest && guard++ < 64) {
        const hit = vocab.find(d => rest === String(d.name) || rest.startsWith(String(d.name) + ", "));
        if (!hit) {
          const piece = rest.split(", ")[0];
          if (piece) details.push({ name: piece, icon: "NONE" });
          rest = rest.slice(piece.length).replace(/^, /, "");
          continue;
        }
        details.push({ name: String(hit.name), icon: String(hit.iconKey || "NONE") });
        rest = rest.slice(String(hit.name).length).replace(/^, /, "");
      }
    }
    return { known: true, specialized: !!mine.specialist, details };
  }

  // Two states, two different sprites, so this is a latch. The captions are NAMED CONSTANTS assigned
  // straight to `title:` -- the help-corpus extractor cannot see a title built by a ternary.
  const SPEC_TIP_SPECIALIZED = "This worker is specialized and will only do tasks that match their workshop assignments, work details, and occupations. Click to toggle.";
  const SPEC_TIP_NOT_SPECIALIZED = "This worker is not specialized and will do any free tasks that become available. Click to toggle.";
  function residentSpecLatchHtml(unitId, state) {
    const ui = window.dwfuiAccessor();
    if (!ui || !state.known) return "";
    const cfg = {
      cls: "creature-spec", on: state.specialized, size: 22,
      sprite: ui.TOKENS.sprites.workerAny, activeSprite: ui.TOKENS.sprites.workerOnly,
      dataset: { residentSpec: unitId, spec: state.specialized ? 1 : 0 }, hotkey: "Ctrl+z",
      title: SPEC_TIP_NOT_SPECIALIZED,
    };
    if (state.specialized) cfg.title = SPEC_TIP_SPECIALIZED;
    return ui.latchHtml(cfg);
  }

  // A detail whose icon is NONE draws NOTHING, as DF does, but still names itself in the cell's
  // tooltip; a dwarf on no detail gets an empty cell.
  function creatureWorkDetailsHtml(state) {
    const ui = window.dwfuiAccessor();
    if (!ui || !state.known || !state.details.length) return "";
    const tiles = state.details
      .map(d => ({ d, token: ui.workDetailSprite(d.icon) }))
      .filter(x => x.token)
      .map(x => ui.iconHtml({ sprite: x.token, size: 22, cls: "creature-workdetail-icon",
        title: x.d.name, alt: x.d.name }))
      .join("");
    const title = state.details.map(d => d.name).join(", ");
    return `<span class="creature-workdetails" title="${escapeHtml(title)}">${tiles}</span>`;
  }

  function residentJobControlsHtml(row) {
    const ui = window.dwfuiAccessor();
    const jobId = Number(row?.jobId ?? -1);
    if (!ui || !Number.isInteger(jobId) || jobId < 0)
      return `<span class="creature-job-controls" aria-hidden="true"></span>`;
    const buildingId = Number(row?.jobBuildingId ?? -1);
    const S = ui.TOKENS.sprites;
    if (!Number.isInteger(buildingId) || buildingId < 0) {
      const label = residentJobText(row);
      const pos = {
        x: Number(row?.jobX), y: Number(row?.jobY), z: Number(row?.jobZ),
      };
      const hasJobPos = row?.jobHasPos === true && Object.values(pos).every(Number.isFinite);
      if (label !== "Store item in stockpile" || !hasJobPos)
        return `<span class="creature-job-controls" aria-hidden="true"></span>`;
      return `<span class="creature-job-controls">` +
        ui.actionButtonsHtml([
          { action: "recenterJob", sprite: S.recenter,
            dataset: { residentJobCenter: "", residentJobX: pos.x,
              residentJobY: pos.y, residentJobZ: pos.z },
            title: "Recenter on the task's building" },
          { action: "cancel", sprite: S.jobRemoveWorker,
            dataset: { infoCancelJob: jobId }, title: "Cancel this task" },
        ], { cls: "resident-job-actions resident-hauling-actions",
          ariaLabel: "Stockpile hauling task actions" }) + `</span>`;
    }
    const data = action => ({ residentJob: jobId, residentJobBuilding: buildingId,
      residentJobAction: action });
    return `<span class="creature-job-controls">` +
      ui.actionButtonsHtml([{ action: "status", sprite: S.jobActive, disabled: true,
        title: row.jobSuspended ? "Task is suspended" : "Task is active" }],
        { cls: "resident-job-actions resident-job-status", ariaLabel: "Current job status" }) +
      ui.latchHtml({ on: !!row.jobRepeat, cls: "resident-job-repeat", sprite: S.repeat,
        activeSprite: S.repeatOn, dataset: data("repeat"), title: "Toggle repeat", ariaLabel: "Toggle repeat" }) +
      ui.actionButtonsHtml([{ action: "priority", sprite: S.jobDoNow,
        activeSprite: S.jobDoNowOn, active: !!row.jobDoNow,
        dataset: data("priority"), title: row.jobDoNow ? "Remove priority (do now)" : "Make priority (do now)" }],
        { cls: "resident-job-actions", ariaLabel: "Current job priority" }) +
      ui.latchHtml({ on: !!row.jobSuspended, cls: "resident-job-suspend", sprite: S.suspend,
        activeSprite: S.suspendOn, dataset: data(row.jobSuspended ? "resume" : "suspend"),
        title: row.jobSuspended ? "Resume task" : "Suspend task",
        ariaLabel: row.jobSuspended ? "Resume task" : "Suspend task" }) +
      ui.actionButtonsHtml([{ action: "cancel", sprite: S.cancelJob,
        dataset: { infoCancelJob: jobId }, title: "Remove task" }],
        { cls: "resident-job-actions", ariaLabel: "Remove current job" }) + `</span>`;
  }

  // The roster is a MOUNTED DWFUI list, so `preserveKey` does not hold its position: `key` is the one
  // the component reads, and it is the whole of the preservation. renderInfoPanel resets it on a nav.
  if (typeof window !== "undefined") window.CREATURE_LIST_KEY = "info-creatures";
  let lastInfoNavKey = "";

  function creatureRowsMarkup(rows, options = {}) {
    const source = Array.isArray(rows) ? rows : [];
    const needle = String(options.search || "").trim();
    const filtered = needle ? source.filter(row => dfTokenMatch(creatureRowSearchText(row), needle)) : source;
    const sortKey = options.sortKey || "name";
    const sortDir = Number(options.sortDir) === -1 ? -1 : 1;
    const shown = sortKey ? filtered.slice().sort((a, b) => compareCreatureRows(a, b, sortKey, sortDir)) : filtered;
    const tableCls = (options.detail || "") === "residents"
      ? "info-table creature-table creature-table--residents" : "info-table creature-table";
    if (!shown.length)
      return DWFUI.listHtml({
        hostCls: "creature-info-list", cls: tableCls, rows: ".info-row",
        preserveKey: "info-creatures", ariaLabel: "Creatures",
      }, `<div class="info-message">${source.length ? "No matches." : ""}</div>`);
    const isResidentsList = (options.detail || "") === "residents";
    const rowsHtml = shown.map(row => {
          const isResidents = (options.detail || "") === "residents";
          const jobText = isResidents ? residentJobText(row) : (row.status || row.job || "");
          const pos = window.infoRowPos(row);
          const nameColor = professionColorStyle(row);
          const unitId = Number(row.unitId ?? -1);
          const memorial = memorialButtonSpec(row, options.detail || "");
          const labor = isResidents ? residentLaborState(row, options.labor || null) : null;
          if (isResidents) {
            const ui = window.dwfuiAccessor();
            const identityHtml = residentIdentityParts(row)
              .map(part => ui ? ui.bitmapTextHtml(part) : escapeHtml(part)).join(" ");
            const jobHtml = ui ? ui.bitmapTextHtml(jobText, { cls: "creature-job-bitmap" }) : escapeHtml(jobText);
            return `
              <div class="info-row creature-row resident-row${unitId >= 0 ? " clickable" : ""}${row.muted ? " info-muted" : ""}"
                data-unit-id="${escapeHtml(unitId)}"
                ${pos ? `data-pos-x="${escapeHtml(pos.x)}" data-pos-y="${escapeHtml(pos.y)}" data-pos-z="${escapeHtml(pos.z)}"` : ""}>
                ${unitPortraitMarkup(row, "info-portrait-small")}
                <div class="creature-identity"${nameColor}>${identityHtml}</div>
                ${creatureRowActionsHtml(row, memorial, pos)}
                <div class="creature-job-text"${residentJobColorStyle(row)}>${jobHtml}</div>
                ${residentJobControlsHtml(row)}
                <span class="creature-activity-details" aria-hidden="true"></span>
                <span class="creature-mood-slot" data-mood-slot="${Number(row.moodCategory ?? -1)}"></span>
                ${residentSpecLatchHtml(unitId, labor)}
                ${creatureWorkDetailsHtml(labor)}
              </div>`;
          }
          return `
            <div class="info-row creature-row${unitId >= 0 ? " clickable" : ""}${row.muted ? " info-muted" : ""}"
              data-unit-id="${escapeHtml(unitId)}"
              ${pos ? `data-pos-x="${escapeHtml(pos.x)}" data-pos-y="${escapeHtml(pos.y)}" data-pos-z="${escapeHtml(pos.z)}"` : ""}>
              ${unitPortraitMarkup(row, "info-portrait-small")}
              <div class="info-name-main"${nameColor}>${escapeHtml(row.name || "")}</div>
              ${creatureSexGlyphHtml(row)}
              ${creatureRowActionsHtml(row, memorial, pos)}
              <div>${escapeHtml(row.category || "")}</div>
              <div>${escapeHtml(row.profession || "")}</div>
              <div class="creature-job-cell">
                ${jobText ? `<div class="info-status">${escapeHtml(jobText)}</div>` : ""}
                <span class="creature-mood-slot" data-mood-slot="${Number(row.moodCategory ?? -1)}"></span>
                ${labor ? residentSpecLatchHtml(unitId, labor) : ""}
                ${labor ? creatureWorkDetailsHtml(labor) : creatureHeldItemHtml(row)}
              </div>
              ${livestockStatusHtml(row, options.detail || "")}
              ${livestockActionsHtml(row, options.detail || "", options.trainers || [])}
            </div>`;
        }).join("");
    return DWFUI.listHtml({
      hostCls: "creature-info-list", cls: tableCls, rows: ".info-row",
      preserveKey: "info-creatures", key: CREATURE_LIST_KEY, ariaLabel: "Creatures",
      headHtml: creatureSortHead(sortKey, sortDir, isResidentsList),
    }, rowsHtml);
  }

  // ---- overall training page ------------------------------------------------------------------
  let creatureTrainingPageOpen = false;

  function trainerChooserRowsHtml(unitId, trainers = creatureTrainers, currentTrainer = -1) {
    const ui = window.dwfuiAccessor();
    if (!ui) return "";
    const choice = (label, value) => ui.rowHtml({
      tag: "button", chassis: "slab", cls: "trainer-choice-row trainer-choice-wildcard",
      label, selected: String(currentTrainer) === String(value),
      ariaLabel: label, dataset: { trainerChoice: value, livestockUnit: unitId },
    });
    const wildcardRows = [
      choice("Any trainer", -1),
      choice("Any unassigned trainer", -2),
      choice("None", "none"),
    ];
    const namedRows = (Array.isArray(trainers) ? trainers : []).map(trainer => {
      const id = Number(trainer && trainer.id);
      if (!Number.isInteger(id) || id < 0) return "";
      const name = String(trainer.name || ("Unit " + id));
      return ui.rowHtml({
        tag: "button", chassis: "slab", layout: "icon",
        cls: "trainer-choice-row trainer-choice-named", copyCls: "trainer-choice-copy",
        icon: unitPortraitMarkup({ id, name }, "trainer-choice-portrait"),
        label: name, selected: Number(currentTrainer) === id, ariaLabel: name,
        dataset: { trainerChoice: id, livestockUnit: unitId },
      });
    });
    return wildcardRows.concat(namedRows).join("");
  }

  function trainerChooserPageHtml(unitId = creatureTrainerChooserUnitId, trainers = creatureTrainers) {
    const id = Number(unitId);
    if (!Number.isInteger(id) || id < 0) return "";
    const animal = creatureRowsRaw.find(row => Number(row?.unitId ?? -1) === id);
    const current = animal?.livestock?.training ? Number(animal.livestock.trainerId ?? -1) : "none";
    return `<div class="trainer-chooser-page" aria-label="Choose trainer">` +
      DWFUI.scrollHtml({ cls: "trainer-chooser-scroll", preserveKey: `trainer-chooser:${id}`,
        rows: ".trainer-choice-row", ariaLabel: "Eligible trainers" },
        trainerChooserRowsHtml(id, trainers, current)) + `</div>`;
  }

  function openTrainerChooser(unitId) {
    const id = Number(unitId);
    if (!Number.isInteger(id) || id < 0) return false;
    creatureTrainingPageOpen = false;
    creatureTrainerChooserUnitId = id;
    renderCreatureBody();
    focusPage();
    return true;
  }

  function closeTrainerChooser() {
    if (creatureTrainerChooserUnitId == null) return false;
    creatureTrainerChooserUnitId = null;
    renderCreatureBody();
    focusPage();
    return true;
  }

  async function applyTrainerChoice(unitId, choice) {
    const id = Number(unitId);
    const none = String(choice) === "none";
    const trainer = Number(choice);
    if (!Number.isInteger(id) || id < 0 || (!none && !Number.isInteger(trainer))) return false;
    const url = none
      ? `/livestock-action?player=${encodeURIComponent(window.playerName)}&unit=${id}&action=unassign-trainer&t=${Date.now()}`
      : `/livestock-action?player=${encodeURIComponent(window.playerName)}&unit=${id}&action=assign-trainer&trainer=${trainer}&t=${Date.now()}`;
    try {
      const response = await fetch(url, { method: "POST", cache: "no-store" });
      if (!response.ok) return false;
      const result = await response.json();
      const row = creatureRowsRaw.find(candidate => Number(candidate?.unitId ?? -1) === id);
      if (row && result?.livestock) row.livestock = result.livestock;
      creatureTrainerChooserUnitId = null;
      renderCreatureBody();
      focusPage();
      return true;
    } catch {
      return false;
    }
  }

  function trainingKnowledgeRows(rows = creatureTrainingKnowledge) {
    return Array.isArray(rows) ? rows.filter(r => r && r.race) : [];
  }

  // Livestock sub-list only, and only when the fortress knows something: an empty page behind a live
  // button is a dead control.
  function overallTrainingBarHtml(rows = creatureTrainingKnowledge, detail = activeInfoDetail,
      open = creatureTrainingPageOpen) {
    const ui = window.dwfuiAccessor();
    if (!ui || detail !== "pets" || !trainingKnowledgeRows(rows).length) return "";
    return `<div class="overall-training-bar-well">` + ui.plaqueBtnHtml({
      cls: "overall-training-bar",
      label: open ? "Back" : "Overall training",
      dataset: { overallTraining: open ? "close" : "open" },
      title: open
        ? "Return to the livestock list"
        : "Open the fortress's overall picture of what it knows about training animals",
    }) + `</div>`;
  }

  // The page fills the livestock area; the bar comes with it so the player can pop it.
  function trainingKnowledgePageHtml(rows = creatureTrainingKnowledge, detail = activeInfoDetail) {
    const ui = window.dwfuiAccessor();
    const shown = trainingKnowledgeRows(rows);
    if (!ui || detail !== "pets" || !shown.length) return "";
    const body = shown.map(r => {
      const idx = Number(r && r.color);
      const color = (Number.isInteger(idx) && idx >= 0 && idx <= 15)
        ? ` data-df-color="${idx}"` : "";
      const race = String((r && r.race) || "");
      return `<div class="training-knowledge-row">` +
        ui.iconHtml({ cls: "training-knowledge-portrait", size: 32, alt: race }) +
        `<span class="training-knowledge-race">${escapeHtml(race)}</span>` +
        `<span class="training-knowledge-level"${color}>${escapeHtml(String((r && r.label) || ""))}</span>` +
        `</div>`;
    }).join("");
    return `<div class="training-knowledge-panel" aria-label="Animal training knowledge">` +
      `<div class="training-knowledge-title">Animal training knowledge</div>` +
      DWFUI.listHtml({
        hostCls: "training-knowledge-list", cls: "info-table",
        rows: ".training-knowledge-row", preserveKey: "info-creatures-training",
        ariaLabel: "Animal training knowledge",
      }, body) +
      overallTrainingBarHtml(rows, detail, true) +
      `</div>`;
  }

  function creatureRowsHtml() {
    if (window.dwfInfoState().detail !== "pets") creatureTrainerChooserUnitId = null;
    if (creatureTrainerChooserUnitId != null) {
      const page = trainerChooserPageHtml();
      if (page) return page;
      creatureTrainerChooserUnitId = null;
    }
    if (creatureTrainingPageOpen && activeInfoDetail === "pets") {
      const page = trainingKnowledgePageHtml();
      if (page) return page;
      creatureTrainingPageOpen = false;   // data went away underneath us -- fail back to the list
    }
    return creatureRowsMarkup(creatureRowsRaw, {
      search: creatureSearch, sortKey: creatureSortKey, sortDir: creatureSortDir,
      detail: activeInfoDetail, trainers: creatureTrainers, labor: creatureLabor,
    }) + overallTrainingBarHtml();
  }

  // Older-host fallback fetch, at most one in flight. A failure leaves creatureLabor null, which makes
  // residentLaborState report known:false and the row render no padlock.
  let creatureLaborInFlight = false;
  async function fetchCreatureLaborFallback() {
    if (creatureLaborInFlight) return;
    creatureLaborInFlight = true;
    try {
      const res = await fetch("/labor", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      creatureLabor = (Array.isArray(data?.rows) && Array.isArray(data?.details)) ? data : null;
    } catch {
      creatureLabor = null;
    }
    creatureLaborInFlight = false;
    if (activeInfoPanel === "citizens" && activeInfoDetail === "residents") renderCreatureBody();
  }

  function renderCreatureBody() {
    const main = clientPanel.querySelector(".info-main");
    if (!main) return;
    // Warm the composite-sprite snapshot so on- and just-off-screen creature rows show sprites.
    if (typeof refreshUnitSpriteSnapshot === "function") refreshUnitSpriteSnapshot();
    main.innerHTML = `${creatureMessageHtml}${creatureRowsHtml()}`;
    wireCreatureBody(main);
  }

  // A per-row map action must resolve the unit's position at CLICK time: the rows bake data-pos-* at
  // render time, so a dwarf who has walked across the fort would send the camera to empty floor.
  function livePosForRow(row) {
    const baked = {
      x: Number(row?.dataset.posX), y: Number(row?.dataset.posY), z: Number(row?.dataset.posZ),
    };
    const id = Number(row?.dataset.unitId ?? NaN);
    if (Number.isInteger(id) && id >= 0) {
      try {
        const live = window.DwfUnitFollow?.liveUnitPos?.(id);
        if (live && Number.isFinite(live.x) && Number.isFinite(live.y) && Number.isFinite(live.z))
          return live;
      } catch { globalThis.DwfErr?.count("creatures-panel.live-position"); }
    }
    return baked;
  }

  function wireCreatureBody(root) {
    const scope = root || clientPanel;
    scope.querySelectorAll("[data-mood-slot]").forEach(slot => {
      const cat = Number(slot.dataset.moodSlot);
      if (!Number.isFinite(cat) || cat < 0 || !window.DFChrome) return;
      const icon = window.DFChrome.icon(`BUTTON_STRESS_${cat}`, 18);
      icon.className = "creature-mood-icon";
      slot.replaceWith(icon);
    });
    // Pure browser state: it reads the /info payload the tab already fetched and writes nothing to the game.
    scope.querySelectorAll("[data-overall-training]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      creatureTrainingPageOpen = button.dataset.overallTraining === "open";
      renderCreatureBody();
      focusPage();
    }));
    scope.querySelectorAll("[data-trainer-chooser-open]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      openTrainerChooser(button.dataset.trainerChooserOpen);
    }));
    scope.querySelectorAll("[data-trainer-choice]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      await applyTrainerChoice(button.dataset.livestockUnit, button.dataset.trainerChoice);
      if (button.isConnected) button.disabled = false;
    }));
    scope.querySelectorAll("[data-creature-sort]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const key = button.dataset.creatureSort;
      if (creatureSortKey === key) creatureSortDir = -creatureSortDir; else { creatureSortKey = key; creatureSortDir = 1; }
      renderCreatureBody();
      focusPage();
    }));
    scope.querySelectorAll("[data-unit-id]").forEach(row => row.addEventListener("click", event => {
      if (event.target.closest("[data-info-open], [data-info-center], [data-info-cancel-job], [data-resident-job-center], [data-resident-job], [data-resident-spec], [data-memorial-slab]")) return;
      event.preventDefault(); event.stopPropagation();
      const id = Number(row.dataset.unitId);
      if (Number.isInteger(id) && id >= 0) window.openUnitById(id);
    }));
    scope.querySelectorAll("[data-info-open]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const row = button.closest(".info-row");
      const id = Number(row?.dataset.unitId ?? -1);
      if (Number.isInteger(id) && id >= 0) window.openUnitById(id);
    }));
    scope.querySelectorAll("[data-info-center]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const row = button.closest(".info-row");
      const pos = livePosForRow(row);
      if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))
        await centerAndFlashMapPos(pos);
    }));
    scope.querySelectorAll("[data-resident-job-center]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const pos = { x: Number(button.dataset.residentJobX), y: Number(button.dataset.residentJobY),
        z: Number(button.dataset.residentJobZ) };
      if (Object.values(pos).every(Number.isFinite))
        await centerAndFlashMapPos(pos);
    }));
    scope.querySelectorAll("[data-info-cancel-job]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const jobId = Number(button.dataset.infoCancelJob);
      if (!Number.isInteger(jobId) || jobId < 0 || button.disabled) return;
      button.disabled = true;
      try {
        const response = await fetch(`/task-cancel?player=${encodeURIComponent(player)}&job=${jobId}&t=${Date.now()}`,
          { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(`task cancellation failed (${response.status})`);
      } catch (err) { globalThis.DwfOrder.lost("tasks.cancel", err, "That task cancellation"); }
      window.openPanel(activeInfoPanel || "citizens", activeInfoSection || "creatures", activeInfoDetail || "residents");
    }));
    scope.querySelectorAll("[data-resident-job]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const jobId = Number(button.dataset.residentJob);
      const buildingId = Number(button.dataset.residentJobBuilding);
      const action = String(button.dataset.residentJobAction || "");
      if (!Number.isInteger(jobId) || jobId < 0 || !Number.isInteger(buildingId) || buildingId < 0 || !action || button.disabled) return;
      button.disabled = true;
      const query = new URLSearchParams({ id: String(buildingId), job: String(jobId), action });
      try {
        const response = await fetch(`/workshop-job-action?${query}`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(`workshop job action failed (${response.status})`);
      } catch (err) { globalThis.DwfOrder.lost("workshop.job-action", err, "That workshop job change"); }
      window.openPanel(activeInfoPanel || "citizens", activeInfoSection || "creatures", activeInfoDetail || "residents");
    }));
    scope.querySelectorAll("[data-memorial-slab]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const id = Number(button.dataset.memorialSlab);
      if (!Number.isInteger(id) || id < 0) return;
      button.disabled = true;
      try {
        const r = await fetch(`/memorial-slab?player=${encodeURIComponent(player)}&unit=${id}&t=${Date.now()}`, {
          method: "POST", cache: "no-store"
        });
        const text = await r.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("creatures-panel.memorial-response-parse"); }
        if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "Could not queue memorial slab.");
        creatureMessageHtml = `<div class="info-message">Memorial slab order queued.</div>`;
      } catch (err) {
        creatureMessageHtml = `<div class="info-message">${escapeHtml(err.message || "Could not queue memorial slab.")}</div>`;
      }
      renderCreatureBody();
      focusPage();
    }));
    scope.querySelectorAll("[data-resident-spec]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      if (button.disabled) return;
      const id = Number(button.dataset.residentSpec);
      if (!Number.isInteger(id) || id < 0) return;
      const next = button.dataset.spec === "1" ? 0 : 1;
      button.disabled = true;
      try {
        const res = await fetch(`/labor-specialist?unit=${id}&on=${next}`, { method: "POST", cache: "no-store" });
        if (!res.ok) throw new Error((await res.text()).trim() || "the game refused the change");
        // Patch BOTH sources of truth so the repaint agrees with the server whichever wire fed it.
        const row = creatureRowsRaw.find(rw => Number(rw.unitId ?? -1) === id);
        if (row && Object.prototype.hasOwnProperty.call(row, "specialized")) row.specialized = !!next;
        const lrow = Array.isArray(creatureLabor?.rows)
          ? creatureLabor.rows.find(r => Number(r?.id ?? -1) === id) : null;
        if (lrow) lrow.specialist = !!next;
        creatureMessageHtml = "";
      } catch (err) {
        creatureMessageHtml = `<div class="info-message">${escapeHtml(err.message || "Could not change specialization.")}</div>`;
      }
      renderCreatureBody();
    }));
    // Patch the row's cached livestock state from the response and re-render in place: a full panel
    // re-fetch would reset scroll and search.
    scope.querySelectorAll("[data-livestock-action]").forEach(button => button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const id = Number(button.dataset.livestockUnit);
      const action = button.dataset.livestockAction;
      if (!Number.isInteger(id) || id < 0 || !action) return;
      button.disabled = true;
      try {
        const r = await fetch(`/livestock-action?player=${encodeURIComponent(player)}&unit=${id}&action=${encodeURIComponent(action)}&t=${Date.now()}`,
          { method: "POST", cache: "no-store" });
        if (!r.ok) throw new Error(`livestock action failed (${r.status})`);
        const res = await r.json();
        if (res && res.livestock) {
          const row = creatureRowsRaw.find(rw => Number(rw.unitId ?? -1) === id);
          if (row) row.livestock = res.livestock;
          renderCreatureBody();
        }
      } catch (err) { globalThis.DwfOrder.lost("creatures.action", err, "That creature change"); }
      focusPage();
    }));

  }

  try {
    window.DwfModeStack.register({
      id: "trainer-chooser", flow: "creatures", depth: 20,
      active: () => {
        const info = window.dwfInfoState();
        return info.panel === "citizens" && info.detail === "pets" && creatureTrainerChooserUnitId != null;
      },
      pop: () => closeTrainerChooser(),
    });
  } catch (err) { globalThis.DwfErr.report("mode-stack.register", err); }

  if (typeof window !== "undefined") {
    const controller = {};
    Object.defineProperties(controller, {
      creatureSearch: { get: () => creatureSearch, set: value => { creatureSearch = value; } },
      creatureRowsRaw: { get: () => creatureRowsRaw, set: value => { creatureRowsRaw = value; } },
      creatureTrainers: { get: () => creatureTrainers, set: value => { creatureTrainers = value; } },
      creatureTrainingKnowledge: { get: () => creatureTrainingKnowledge, set: value => { creatureTrainingKnowledge = value; } },
      creatureLabor: { get: () => creatureLabor, set: value => { creatureLabor = value; } },
      creatureMessageHtml: { get: () => creatureMessageHtml, set: value => { creatureMessageHtml = value; } },
      lastInfoNavKey: { get: () => lastInfoNavKey, set: value => { lastInfoNavKey = value; } },
      creatureTrainingPageOpen: { get: () => creatureTrainingPageOpen, set: value => { creatureTrainingPageOpen = value; } },
    });
    window.DFBuildInfoController = controller;
    Object.assign(window, {
      professionColorStyle, creatureSexGlyphHtml, geldButtonSpec, memorialButtonSpec,
      creatureRowActionsHtml, residentLaborState, creatureRowsMarkup, overallTrainingBarHtml,
      trainingKnowledgePageHtml, trainerChooserRowsHtml, trainerChooserPageHtml, openTrainerChooser,
      closeTrainerChooser, applyTrainerChoice, creatureRowsHtml, fetchCreatureLaborFallback, renderCreatureBody,
      livePosForRow, wireCreatureBody,
    });
  }

  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, {
    professionColorStyle, creatureSexGlyphHtml, geldButtonSpec, memorialButtonSpec,
    creatureRowActionsHtml, residentLaborState, creatureRowsMarkup, overallTrainingBarHtml,
    trainingKnowledgePageHtml, trainerChooserRowsHtml, trainerChooserPageHtml, applyTrainerChoice,
  });
