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


  // The siege engine sheet: header, the action strip, the bolt thrower's parking arrows and count, then
  // DWF's own status readout, all above native's contents list. Three kinds are live: catapult,
  // ballista and bolt thrower. There is no crew: whoever takes the load or fire job operates it.

  // Wrap widths for a status sentence across the sheet, and beside the five action tiles.
  const SIEGE_PROSE_COLUMNS = 52;
  const SIEGE_BAND_COLUMNS = 36;

  // Native's order, which is not the enum order: each value permits everything below it and one more
  // thing. `status` is native's sentence for the current value, verbatim.
  const SIEGE_ACTION_ROWS = [
    { mode: 3, label: "Fire at enemies",
      spriteKey: "siegeFireAtWill", spriteOnKey: "siegeFireAtWillOn",
      status: "Fire at enemies",
      note: "Loads, posts an operator, and shoots." },
    { mode: 4, label: "Practice fire",
      spriteKey: "siegePracticeFire", spriteOnKey: "siegePracticeFireOn",
      status: "Practice fire with a warning about ammunition consumption",
      note: "Everything above, and it also shoots at archery targets when no enemy is in the cone. It spends real ammunition to do it." },
    { mode: 2, label: "Stand ready",
      spriteKey: "siegePrepareToFire", spriteOnKey: "siegePrepareToFireOn",
      status: "Stand ready but do not fire",
      note: "Loads and posts an operator, but never shoots. A dwarf will stand at the engine indefinitely; that is what this setting means, not a stall." },
    { mode: 1, label: "Keep loaded",
      spriteKey: "siegeKeepLoaded", spriteOnKey: "siegeKeepLoadedOn",
      status: "Keep loaded but do not stand ready",
      note: "Loads, then walks away. Choosing this cancels a shot already queued." },
    { mode: 0, label: "Idle",
      spriteKey: "siegeNotInUse", spriteOnKey: "siegeNotInUseOn",
      status: "Idle",
      note: "Nothing happens at all. Choosing this cancels a shot already queued." },
  ];
  const SIEGE_ACTION_LABELS = Object.fromEntries(SIEGE_ACTION_ROWS.map(row => [row.mode, row.label]));
  const SIEGE_ACTION_STATUS = Object.fromEntries(SIEGE_ACTION_ROWS.map(row => [row.mode, row.status]));

  // Facing is drawn from the served tile delta, in screen words: DF's "East" is a world word.
  function siegeFacingWords(dx, dy) {
    const vertical = dy > 0 ? "down" : dy < 0 ? "up" : "";
    const horizontal = dx > 0 ? "right" : dx < 0 ? "left" : "";
    return [vertical, horizontal].filter(Boolean).join("-") || "nowhere";
  }
  function siegeFacingTurn(dx, dy) {
    if (!dx && !dy) return 0;
    return (Math.round(Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
  }
  // interface_map.json has no eight-way arrow family, so the arrow is one glyph rotated by the delta.
  function siegeFacingArrowHtml(dx, dy, label) {
    const title = `${label || "Facing"}: ${siegeFacingWords(dx, dy)} on screen`;
    return `<span class="siege-arrow" style="--siege-turn:${siegeFacingTurn(dx, dy)}deg" title="${escapeHtml(title)}"` +
      ` role="img" aria-label="${escapeHtml(title)}">&#8593;</span>`;
  }

  const SIEGE_OPERATOR_WORDS = {
    none: "No queued work",
    loading: "Loading",
    "load-unclaimed": "Load task queued, nobody on it",
    "fire-unclaimed": "Nobody is operating the engine",
    "operator-walking": "Operator walking to the engine",
    "operator-present": "Operator at the engine",
    other: "Busy with another task",
  };

  function siegeEnginePanelState(data) {
    const d = data || {};
    const kind = Number(d.kind);
    const built = !!d.built;
    const action = Number(d.action) || 0;
    const boltThrower = kind === 2;
    const loadedQty = Number(d.loadedQuantity) || 0;
    return {
      id: Number(d.id),
      name: d.name || d.kindName || "Siege engine",
      kind, kindName: d.kindName || "siege engine", boltThrower,
      canAim: !!d.canAim,
      built,
      buildStage: Number(d.buildStage) || 0,
      maxBuildStage: Number(d.maxBuildStage) || 0,
      action,
      actionLabel: SIEGE_ACTION_LABELS[action] || "Idle",
      actionStatus: SIEGE_ACTION_STATUS[action] || SIEGE_ACTION_STATUS[0],
      rows: SIEGE_ACTION_ROWS.map(row => ({ ...row, selected: row.mode === action })),
      facing: { dx: Number(d.facingDx) || 0, dy: Number(d.facingDy) || 0 },
      resting: { dx: Number(d.restingDx) || 0, dy: Number(d.restingDy) || 0 },
      restingFacing: Number(d.restingFacing) || 0,
      // Unknown while unfinished: the parts still arriving are not ammunition.
      loadedChip: !built ? "unknown" : (d.loaded ? "loaded" : "empty"),
      loadedQty,
      // At stand-ready (2) the engine neither tops up nor shoots, so the warning starts at fire (3).
      partialStackWarning: boltThrower && built && loadedQty > 0 && loadedQty < 100 && action >= 3,
      forbidden: !!d.forbidden,
      cycling: !!d.cycling,
      searching: !!d.searching,
      turning: !!d.turning,
      operatorText: SIEGE_OPERATOR_WORDS[String(d.operatorState)] || SIEGE_OPERATOR_WORDS.none,
      jobs: Array.isArray(d.jobs) ? d.jobs : [],
      items: (Array.isArray(d.items) ? d.items : []).map(item => ({
        id: Number(item && item.id),
        name: String((item && item.name) || ""),
        role: String((item && item.role) || ""),
        spriteRef: (item && item.spriteRef) || null,
        forbidden: !!(item && item.forbidden),
        dump: !!(item && item.dump),
        hidden: !!(item && item.hidden),
      })).filter(item => Number.isInteger(item.id)),
    };
  }

  function siegeHeaderHtml(state) {
    return DWFUI.headerHtml({
      cls: "building-head siege-head",
      icon: DWFUI.iconHtml({ cls: "siege-head-icon", alt: `${state.kindName} sprite` }),
      title: state.name, titleCls: "building-name",
      tools: [
        { role: "quill", placeholder: true, dataset: { siegeRename: "" },
          title: "Rename this engine -- UNVERIFIED: the server exposes no siege-engine rename route" },
        { role: "removeBuilding", dataset: { bldAct: "cancel" },
          title: "Remove this siege engine", ariaLabel: "Remove this siege engine" },
      ],
      close: false,
    });
  }

  // DF's own self-framed cells: selection IS the sprite, so no bracket or outline is added.
  function siegeActionBandHtml(state) {
    const S = DWFUI.TOKENS.sprites;
    const tiles = state.rows.map(row => DWFUI.artBtnHtml({
      cls: "siege-action",
      sprite: row.selected ? S[row.spriteOnKey] : S[row.spriteKey],
      active: row.selected,
      disabled: !state.built,
      dataset: { siegeAction: String(row.mode) },
      title: state.built ? `${row.label} — ${row.note}` : "The engine is not finished yet.",
      ariaLabel: row.label,
    })).join("");
    return `<div class="siege-action-band">` +
      DWFUI.statusHtml({ cls: "siege-action-status", tone: state.built ? "" : "dim",
                         columns: SIEGE_BAND_COLUMNS,
                         text: state.built ? state.actionStatus : "Switched off until the engine is finished" }) +
      `<div class="siege-action-strip">${tiles}</div></div>`;
  }

  // DF's own enum, index for index: screen-up at 0, then clockwise.
  const SIEGE_RESTING_DX = [0, 1, 1, 1, 0, -1, -1, -1];
  const SIEGE_RESTING_DY = [-1, -1, 0, 1, 1, 1, 0, -1];
  function siegeRestingStripHtml(state) {
    const tiles = SIEGE_RESTING_DX.map((dx, i) => {
      const dy = SIEGE_RESTING_DY[i];
      const words = `Park facing ${siegeFacingWords(dx, dy)} on screen`;
      return DWFUI.artBtnHtml({
        cls: "siege-facing", active: i === state.restingFacing, disabled: !state.built,
        glyphHtml: DWFUI.rawHtml("no eight-way arrow sprite exists, so the face is one rotated glyph",
          siegeFacingArrowHtml(dx, dy, "Park facing")),
        dataset: { siegeResting: String(i) }, title: words, ariaLabel: words,
      });
    }).join("");
    return `<div class="siege-caption">${DWFUI.bitmapTextHtml("Resting orientation")}</div>` +
      `<div class="siege-facing-strip">${tiles}</div>`;
  }

  // `/siege-engine` serves only the loaded count; native's other three bolt counts are left out.
  function siegeAmmoSectionHtml(state) {
    if (!state.boltThrower || !state.built) return "";
    return `<div class="siege-count-loaded">${DWFUI.bitmapTextHtml(`Bolts loaded: ${state.loadedQty}`)}</div>` +
      (state.partialStackWarning
        ? DWFUI.statusHtml({ cls: "siege-line", tone: "warn", columns: SIEGE_PROSE_COLUMNS,
            text: "Fewer than 100 bolts are loaded. On this setting the engine shoots the " +
                  "partial stack instead of waiting for more; only keep-loaded tops one up." })
        : "");
  }

  function siegeContentRowHtml(item) {
    const id = Number(item.id);
    const part = String(item.role || "").toUpperCase() === "PERM"
      ? DWFUI.iconHtml({ sprite: "BUILDING_ITEM_INCORPORATED", nativeCell: true, cls: "siege-item-part",
          title: "Part of this engine", alt: "Part of this engine" })
      : `<span class="siege-item-part" aria-hidden="true"></span>`;
    return DWFUI.rowHtml({
      cls: "siege-item-row", chassis: "table", dataset: { siegeItemRow: id },
      icon: DWFUI.iconHtml({ item: item.spriteRef, cls: "siege-item-ico", size: 40,
                             alt: item.name || `Item ${id}` }),
      labelHtml: DWFUI.bitmapTextHtml(item.name || `Item ${id}`, { fitNativeLabel: { host: "parent" } }),
      trailing: part + DWFUI.actionButtonsHtml([
        { title: "Locate on the map", dataset: { siegeItemAction: "locate", siegeItem: id } },
        { active: item.forbidden, title: item.forbidden ? "Claim item" : "Forbid item",
          dataset: { siegeItemAction: "forbid", siegeItem: id } },
        { active: item.dump, title: item.dump ? "Cancel dump" : "Mark for dumping",
          dataset: { siegeItemAction: "dump", siegeItem: id } },
        { active: item.hidden, title: item.hidden ? "Show item" : "Hide item",
          dataset: { siegeItemAction: "hide", siegeItem: id } },
      ], { preset: "itemActions", cls: "siege-item-actions", ariaLabel: "Item actions" }),
    });
  }

  function siegeStatusRowHtml(label, valueHtml) {
    return DWFUI.rowHtml({ cls: "siege-status-row", label,
      cells: [{ html: valueHtml, numeric: true, cls: "siege-status-value" }] });
  }

  function siegeStatusHtml(state) {
    const text = value => DWFUI.bitmapTextHtml(value);
    const arrow = (facing, label) => DWFUI.rawHtml("a facing is a rotated arrow glyph",
      siegeFacingArrowHtml(facing.dx, facing.dy, label));
    const ammo = state.loadedChip === "unknown" ? "Not finished yet"
      : state.loadedChip === "empty" ? "Empty"
      : state.boltThrower ? `${state.loadedQty} loaded` : "Loaded";
    return [
      siegeStatusRowHtml("Type", text(state.kindName)),
      siegeStatusRowHtml("Built", text(`${state.buildStage} of ${state.maxBuildStage}`)),
      siegeStatusRowHtml("Pointing", arrow(state.facing, "Pointing")),
      state.boltThrower ? siegeStatusRowHtml("Parks facing", arrow(state.resting, "Parks facing")) : "",
      siegeStatusRowHtml("Ammunition", text(ammo)),
      state.built ? siegeStatusRowHtml("Reload", text(state.cycling ? "Cycling" : "Ready")) : "",
      state.built ? siegeStatusRowHtml("Ammunition search",
        text(state.searching ? "Waiting before it looks again" : "Idle")) : "",
      state.boltThrower && state.built
        ? siegeStatusRowHtml("Turning", text(state.turning ? "Mid-turn" : "Settled")) : "",
      siegeStatusRowHtml("Operator", text(state.operatorText)),
    ].join("");
  }

  function siegeJobsHtml(state) {
    const rows = state.jobs.map(job => window.zoneUnitRowHtml({
      label: job.kind === "load" ? "Load" : job.kind === "fire" ? "Fire" : "Other task",
      // A load job off the centre tile waits on the loading side, where a blocked approach stalls it.
      meta: job.claimed
        ? (job.atCentre ? "Claimed" : `Claimed, loading side at ${job.x}, ${job.y}`)
        : (job.atCentre ? "Waiting for a dwarf" : `Waiting for a dwarf at ${job.x}, ${job.y}`),
    }));
    return `<div class="dwfui-text--section siege-line">Queued work</div>` +
      (rows.length ? rows.join("") : `<div class="dwfui-text--empty siege-line">Nothing queued.</div>`);
  }

  function siegeNote(text, cls) {
    return `<div class="dwfui-text--note siege-line siege-note${cls ? " " + cls : ""}">${escapeHtml(text)}</div>`;
  }

  function siegeEnginePanelMarkup(data, notice) {
    const state = siegeEnginePanelState(data);
    const warn = text => DWFUI.statusHtml({ cls: "siege-line", tone: "warn", columns: SIEGE_PROSE_COLUMNS, text });
    // The engine was built from a forbidden item: it reads "fire at enemies" and does nothing.
    const inert = state.forbidden
      ? warn("Inert: the item this engine was built from is forbidden, so it will not load and will not fire. " +
             "Changing the setting will not help — unforbid that item.")
      : "";
    const body =
      (notice ? warn(notice) : "") +
      siegeActionBandHtml(state) +
      (state.canAim ? siegeRestingStripHtml(state) : "") +
      siegeAmmoSectionHtml(state) +
      inert +
      DWFUI.plaqueBtnHtml({ cls: "building-btn", label: "Back to building", dataset: { buildingBack: "" } }) +
      `<div class="dwfui-text--section siege-line">Status</div>` +
      siegeStatusHtml(state) +
      siegeNote(state.rows.find(r => r.selected)?.note || "", "siege-action-note-on") +
      siegeNote(state.canAim
        ? "This is where the engine points when it has nothing to shoot at. It does not aim the engine now."
        : "This engine was aimed when it was placed and cannot be turned afterwards.") +
      (state.kind === 0
        ? siegeNote("Fires one boulder at a time. It will take any hard, non-economic stone.") : "") +
      siegeJobsHtml(state);
    return `<div class="siege-sheet">` +
      siegeHeaderHtml(state) +
      DWFUI.scrollHtml({ cls: "siege-body", rows: ".siege-body > *", ariaLabel: "Siege engine" }, body) +
      DWFUI.scrollHtml({ cls: "siege-contents", rows: ".siege-item-row", ariaLabel: "What this engine holds" },
        state.items.map(siegeContentRowHtml).join("")) +
      `</div>`;
  }

  async function fetchSiegeEngineInfo(id) {
    try {
      const r = await fetch(`/siege-engine?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      if (data && data.ok !== false && data.isSiegeEngine) return data;
    } catch { globalThis.DwfErr?.count("siege-engine-panel.info"); }
    return null;
  }

  // The panel re-reads what the game reports after a write, never what was sent.
  async function postSiegeEngine(path) {
    const r = await fetch(`${path}&t=${Date.now()}`, { method: "POST", cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("siege-engine-panel.response-parse"); }
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "setting failed");
    return data;
  }

  async function openSiegeEnginePanel(id, notice) {
    const data = await fetchSiegeEngineInfo(id);
    if (!data) { window.openBuildingPanel(id); return; }
    // The notice reports queued work the last click cancelled, or the server's refusal.
    window.setViewSheetPanel("building-panel siege-panel", siegeEnginePanelMarkup(data, notice));
    selection.querySelectorAll("[data-siege-action]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      btn.disabled = true;
      let report = "";
      try {
        const result = await postSiegeEngine(`/siege-engine/action?id=${id}&mode=${Number(btn.dataset.siegeAction)}`);
        const cancelled = Number(result.cancelledFireJobs) || 0;
        if (cancelled > 0) report = `${cancelled} queued shot${cancelled === 1 ? "" : "s"} cancelled.`;
      } catch (e) { report = e && e.message ? e.message : "setting failed"; }
      openSiegeEnginePanel(id, report);
      focusPage();
    }));
    selection.querySelectorAll("[data-siege-resting]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      btn.disabled = true;
      let report = "";
      try { await postSiegeEngine(`/siege-engine/resting-facing?id=${id}&dir=${Number(btn.dataset.siegeResting)}`); }
      catch (e) { report = e && e.message ? e.message : "setting failed"; }
      openSiegeEnginePanel(id, report);
      focusPage();
    }));
    // The remove tile needs its own handler: `[data-bld-act]` is bound only in openBuildingPanel.
    selection.querySelectorAll("[data-bld-act]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const action = btn.dataset.bldAct;
      try {
        const response = await fetch(`/building-action?id=${id}&action=${action}`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(`building action failed (${response.status})`);
      } catch (err) { globalThis.DwfOrder.lost("building.action", err, "That building change"); }
      if (action === "cancel") closeSelection(); else openSiegeEnginePanel(id);
      focusPage();
    }));
    selection.querySelector("[data-building-back]").addEventListener("click", event => {
      event.stopPropagation(); window.openBuildingPanel(id); focusPage();
    });
  }

  if (typeof window !== "undefined") Object.assign(window.DFBuildingOperationsMarkup ||= {}, { siegeEnginePanelMarkup });

  if (typeof window !== "undefined") Object.assign(window, { fetchSiegeEngineInfo, openSiegeEnginePanel, siegeEnginePanelState });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { SIEGE_PROSE_COLUMNS, SIEGE_BAND_COLUMNS, SIEGE_ACTION_ROWS, SIEGE_ACTION_LABELS, SIEGE_ACTION_STATUS, siegeFacingWords, siegeFacingTurn, siegeFacingArrowHtml, SIEGE_OPERATOR_WORDS, siegeEnginePanelState, siegeHeaderHtml, siegeActionBandHtml, SIEGE_RESTING_DX, SIEGE_RESTING_DY, siegeRestingStripHtml, siegeAmmoSectionHtml, siegeContentRowHtml, siegeStatusHtml, siegeJobsHtml, siegeEnginePanelMarkup, fetchSiegeEngineInfo, openSiegeEnginePanel });
