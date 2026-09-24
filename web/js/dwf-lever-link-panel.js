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

  // The wrap width of a status sentence in the wide trigger and restraint panels.
  const WIDE_PANEL_COLUMNS = 56;

  async function fetchLeverLinkInfo(id) {
    try {
      const r = await fetch(`/trigger-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      // isTrigger covers levers AND pressure plates.
      if (data && data.ok !== false && data.isTrigger) return data;
    } catch { globalThis.DwfErr?.count("lever-link-panel.info"); }
    return null;
  }

  async function postLeverPull(id) {
    const r = await fetch(`/lever-pull?id=${id}&t=${Date.now()}`, { method: "POST", cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("lever-link-panel.pull-response-parse"); }
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "pull failed");
    return data;
  }

  async function postLeverLink(id, target) {
    const r = await fetch(`/lever-link?id=${id}&target=${target}&t=${Date.now()}`, {
      method: "POST", cache: "no-store"
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("lever-link-panel.link-response-parse"); }
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "link failed");
    return data;
  }

  function leverLinkMechanismStatus(data) {
    const count = Math.max(0, Number(data && data.mechanismCount) || 0);
    const needs = !!(data && data.needsMechanisms) || count < 2;
    return {
      count,
      needs,
      canLink: !needs,
      label: needs ? `Needs mechanisms (${count}/2)` : `${count} mechanisms available`,
    };
  }

  // Native linking is a map picker, not a candidate list: these rows are map-overlay data only,
  // and `legalTargets` deliberately breaks the old payload shape so no client rebuilds the list UI.
  function leverLinkLegalTargets(data) {
    const rows = Array.isArray(data && data.legalTargets) ? data.legalTargets : [];
    return rows.map(t => ({
      id: Number(t.id),
      name: t.name || t.type || `Building ${t.id}`,
      type: t.type || "Building",
      x: Number(t.x), y: Number(t.y), z: Number(t.z),
      distance: Math.max(0, Number(t.distance) || 0),
      effect: String(t.effect || ""),
      danger: !!t.danger,
    })).filter(t => Number.isInteger(t.id) && t.id >= 0)
      .sort((a, b) => (a.distance - b.distance) || (a.id - b.id));
  // Distance order is for deterministic overlay and test data only; the panel has no list order.
  }

  // built:false is kept, not filtered: an unfinished target is silently SKIPPED by the pulse, which
  // is exactly the fact a player needs when nothing moved.
  function leverLinkedTargetRows(data) {
    const rows = Array.isArray(data && data.linkedTargets) ? data.linkedTargets : [];
    return rows.map(t => ({
      id: Number(t.id),
      name: t.name || t.type || `Building ${t.id}`,
      type: t.type || "Building",
      built: t.built !== false,
      effect: String(t.effect || ""),
      respondsToState: !!t.respondsToState,
    })).filter(t => Number.isInteger(t.id) && t.id >= 0);
  }

  // Short lines, because a meta line is bitmap text and cannot wrap or ellipsise. The "still being
  // built" clause gets its own warn line rather than trailing off the end of a sentence.
  function linkedTargetMetaLines(target, noEffectText) {
    const lines = [{ text: target.type }, { text: target.effect || noEffectText }];
    if (!target.built) lines.push({ text: "Still being built - this pulse skips it", tone: "warning" });
    return lines;
  }

  // The next pull delivers the lever's CURRENT state byte and only then flips it. Suppressed when
  // nothing linked cares about the byte -- promising "will open" there is a lie.
  function leverPulseSentence(data) {
    if (!data || !data.isLever) return "";
    const linked = leverLinkedTargetRows(data);
    if (!linked.some(t => t.respondsToState)) return "";
    return Number(data.state) === 0
      ? "Next pull opens: gates open, bridges raise, spikes retract."
      : "Next pull closes: gates shut, bridges lower, spikes extend.";
  }

  // ---- machines & power ------------------------------------------------------------------------

  function leverLinkPanelMarkup(data, pickerState = null, notice = null) {
    const status = leverLinkMechanismStatus(data);
    const targets = leverLinkLegalTargets(data);
    const picking = !!(pickerState && pickerState.armed);
    const linked = leverLinkedTargetRows(data);
    const linkedRows = linked.map(t => window.zoneUnitRowHtml({
      label: t.name, metaLines: linkedTargetMetaLines(t, "no effect when pulled"),
      trailing: DWFUI.plaqueBtnHtml({
        cls: "zone-unit-act", size: "compact", label: "Remove", disabled: true,
        dataset: { leverUnlink: t.id },
        title: "Unavailable: a safe native unlink operation has not been verified.",
        ariaLabel: `Remove link to ${t.name} (unavailable)`,
      }),
    }));
    const pulse = leverPulseSentence(data);
    // The pull is a queued job a dwarf must walk to, so the button reports "queued" and never pretends
    // the lever has already moved.
    const pullBtn = data.isLever
      ? DWFUI.plaqueBtnHtml({
          cls: "building-btn", label: data.pullQueued ? "Pull already queued" : "Pull this lever",
          dataset: { leverPull: "" }, disabled: !!data.pullQueued,
          title: data.pullQueued ? "A dwarf is already on the way to pull this lever"
                                 : "Queues a job; a dwarf walks over and pulls it",
        })
      : "";
    const note = notice && notice.text
      ? DWFUI.statusHtml({ cls: "zone-note", tone: notice.error ? "warn" : "dim",
          columns: WIDE_PANEL_COLUMNS, text: notice.text })
      : "";
    const noTargets = targets.length === 0;
    const pickDisabled = !picking && (!status.canLink || noTargets);
    const pickTitle = picking
      ? "Cancel map selection"
      : !status.canLink
        ? "Two accessible mechanisms are required."
        : noTargets
          ? "No legal target buildings are currently available."
          : "Choose the building to link by clicking it on the map.";
    const pickButton = DWFUI.plaqueBtnHtml({
      cls: "building-btn", label: picking ? "Cancel link selection" : "Link to a building",
      dataset: { leverLinkPick: "" }, disabled: pickDisabled, title: pickTitle,
    });
    const pickerNote = picking
      ? DWFUI.statusHtml({
          cls: "zone-note", tone: "dim", columns: WIDE_PANEL_COLUMNS,
          text: "Choose a highlighted building on the map. Escape or right-click cancels.",
        })
      : "";
    return `${DWFUI.headerHtml({ cls:"building-head", title:data.name || "Lever", titleCls:"building-name", close:false })}` +
      `<div class="building-status">${escapeHtml(data.sourceType || "Lever")} &middot; trigger controls</div>` +
      DWFUI.plaqueBtnHtml({ cls: "building-btn", label: "Back to building", dataset: { buildingBack: "" } }) +
      (pulse ? DWFUI.statusHtml({ cls: "zone-note", tone: "dim", columns: WIDE_PANEL_COLUMNS, text: pulse }) : "") +
      pullBtn + note +
      `<div class="dwfui-text--section zone-section-label">Existing links</div>${window.zoneUnitListHtml(linkedRows, "Nothing linked yet.")}` +
      `<div class="dwfui-text--section zone-section-label">Mechanisms</div><div class="dwfui-text--note zone-note">${escapeHtml(status.label)}</div>` +
      pickButton + pickerNote;
  }

  // Race and flags join the name in the haystack, because "assigned elsewhere dog" is how a player
  // finds a stray to move here.
  function buildingCageSearchText(unit) {
    const u = unit || {};
    const flags = Array.isArray(u.flags) ? u.flags.join(" ") : "";
    return `${u.name || u.race || ("Unit " + Number(u.id))} ${u.race || ""} ${flags}`.trim().toLowerCase();
  }
  function buildingCagePanelMarkup(data, options) {
    const units = Array.isArray(data?.units) ? data.units : [];
    const rows = units.map(unit => {
      const flags = Array.isArray(unit.flags) ? unit.flags.join(" | ") : "";
      const kind = unit.kind || "unit";
      const name = unit.name || unit.race || `Unit ${unit.id}`;
      return window.zoneUnitRowHtml({
        label: name,
        dataset: { cageRow: Number(unit.id), cageSearch: buildingCageSearchText(unit) },
        inkColor: kind === "unit" ? unit.professionColor : null,
        meta: flags || unit.race || "",
        trailing: DWFUI.plaqueBtnHtml({
          cls: "zone-unit-act" + (unit.assigned ? " assigned" : ""), size: "compact",
          label: window.buildingCageActionLabel(unit), on: unit.assigned,
          dataset: { cageUnit: Number(unit.id), cageKind: kind, cageAssign: unit.assigned ? "0" : "1" },
        }),
      });
    });
    // Footer search with the magnifier, the placement all three unit_selector surfaces use. Drawn only
    // when there is a list.
    const search = units.length ? DWFUI.searchHtml({
      cls: "cage-unit-search", placement: "footer", magnifier: true,
      dataAttr: "cage-search", type: "search", value: (options && options.search) || "",
      preserveKey: "building-cage", ariaLabel: "Search occupants",
    }) : "";
    return `${DWFUI.headerHtml({ cls:"building-head", title:data?.name || "Cage", titleCls:"building-name", close:false })}<div class="building-status">Cage / Terrarium &middot; occupant assignment</div>${DWFUI.plaqueBtnHtml({ cls: "building-btn", dataset: { buildingBack: "" }, label: "Back to building" })}${window.zoneUnitListHtml(rows, "No assignable occupants found.")}<div class="dwfui-text--note zone-note cage-unit-empty" hidden>No occupants match that search.</div>${search}`;
  }

  // `assignmentWriteEnabled` comes from the read route, so an older host served to a newer page renders
  // disabled plaques instead of buttons that post into a route that is not there.
  function buildingRestraintPanelMarkup(data, options) {
    const opts = options || {};
    const units = window.zoneAnimalSortedRows(data?.units, opts.sortKey || "name",
      Number(opts.sortDirection) < 0 ? -1 : 1);
    const writeEnabled = data?.assignmentWriteEnabled === true;
    const reason = String(data?.assignmentWriteReason ||
      "Assignment unavailable: the native cleanup sequence has not been live-verified.");
    const notice = opts.notice;
    const rows = units.map(unit => {
      const name = unit.name || unit.race || `Unit ${unit.id}`;
      const flags = Array.isArray(unit.flags) ? unit.flags.join(" | ") : "";
      // The already-assigned row is a no-op, so it stays a disabled plaque even when the write is live.
      const isAssigned = !!unit.assigned;
      const action = DWFUI.plaqueBtnHtml({
        cls: "zone-unit-act" + (isAssigned ? " assigned" : ""), size: "compact",
        label: isAssigned ? "Assigned" : (writeEnabled ? "Assign" : "Unavailable"),
        on: isAssigned,
        disabled: isAssigned || !writeEnabled,
        title: isAssigned ? "This creature is already assigned to this restraint" : reason,
        ariaLabel: isAssigned ? `${name} is already assigned` : `Assign ${name} to this restraint`,
        dataset: { restraintId: Number(data?.id), restraintUnit: Number(unit.id) },
      });
      return window.zoneUnitRowHtml({
        label: window.zoneAnimalNativeLabel(unit),
        inkColor: unit.professionColor,
        dataset: {
          restraintRow: Number(unit.id),
          restraintSearch: buildingCageSearchText(unit),
        },
        icon: window.zoneCreaturePortraitHtml(unit, name),
        meta: flags || unit.race || "",
        trailing: action,
      });
    });
    const search = units.length ? DWFUI.searchHtml({
      cls: "restraint-unit-search", placement: "footer", magnifier: true,
      dataAttr: "restraint-search", type: "search", value: opts.search || "",
      preserveKey: "building-restraint", ariaLabel: "Search eligible creatures",
    }) : "";
    // A refusal must survive the re-render that redraws the list, so it is panel state passed back in,
    // not a title on a button about to be thrown away.
    const noticeHtml = notice && notice.text
      ? DWFUI.statusHtml({ cls: "zone-note restraint-notice", tone: notice.error ? "warn" : "dim",
          live: "polite", columns: WIDE_PANEL_COLUMNS, text: notice.text })
      : "";
    return `${DWFUI.headerHtml({ cls:"building-head", title:data?.name || "Chain / Restraint",
      titleCls:"building-name", close:false })}` +
      `<div class="building-status">Chain / Restraint &middot; creature assignment</div>` +
      DWFUI.plaqueBtnHtml({ cls: "building-btn", label: "Back to building",
        dataset: { buildingBack: "" } }) +
      DWFUI.statusHtml({ cls: "zone-note", tone: writeEnabled ? "dim" : "warn",
        columns: WIDE_PANEL_COLUMNS, text: reason }) +
      noticeHtml +
      window.zoneAnimalSortBarHtml(opts.sortKey || "name", Number(opts.sortDirection) < 0 ? -1 : 1) +
      window.zoneUnitListHtml(rows, "No eligible creatures found.") +
      `<div class="dwfui-text--note zone-note restraint-unit-empty" hidden>No creatures match that search.</div>` +
      search;
  }


  let leverLinkCommitPending = false;
  async function openLeverLinkPanel(id, notice = null) {
    const data = await window.fetchLeverLinkInfo(id);
    if (!data) { window.openBuildingPanel(id); return; }
    const armed = window.DFLeverLink && window.DFLeverLink.isArmed
      ? window.DFLeverLink.isArmed() : null;
    const picking = !!(armed && Number(armed.sourceId) === Number(data.id));
    window.setSelectionPanel("building-panel zone-panel zone-wide",
      leverLinkPanelMarkup(data, { armed: picking }, notice));
    selection.querySelector("[data-building-back]").addEventListener("click", event => {
      event.stopPropagation();
      if (picking && window.DFLeverLink) window.DFLeverLink.disarm(false);
      window.openBuildingPanel(data.id); focusPage();
    });
    selection.querySelector("[data-lever-pull]")?.addEventListener("click", async event => {
      event.stopPropagation();
      const btn = event.currentTarget;
      btn.disabled = true;
      let result = { text: "Pull job queued." };
      try { await window.postLeverPull(data.id); }
      catch (e) { result = { text: `Could not queue the pull: ${(e && e.message) || "pull failed"}`, error: true }; }
      openLeverLinkPanel(data.id, result);
      focusPage();
    });
    selection.querySelector("[data-lever-link-pick]")?.addEventListener("click", event => {
      event.stopPropagation();
      if (!window.DFLeverLink) return;
      if (picking) {
        window.DFLeverLink.disarm();
        return;
      }
      window.DFLeverLink.onFailed = message =>
        openLeverLinkPanel(data.id, { text: message || "That building cannot be linked.", error: true });
      window.DFLeverLink.onDisarmed = () => {
        if (!leverLinkCommitPending)
          openLeverLinkPanel(data.id, { text: "Link selection cancelled." });
      };
      window.DFLeverLink.onPick = async target => {
        leverLinkCommitPending = true;
        window.DFLeverLink.disarm();
        let result = { text: "Link job queued. A dwarf must install both mechanisms." };
        try { await window.postLeverLink(data.id, target); }
        catch (e) { result = { text: `Could not queue the link: ${(e && e.message) || "link failed"}`, error: true }; }
        leverLinkCommitPending = false;
        openLeverLinkPanel(data.id, result);
      };
      window.DFLeverLink.arm(data.id, leverLinkLegalTargets(data));
      focusPage();
      openLeverLinkPanel(data.id);
    });
  }

  if (typeof window !== "undefined") Object.assign(window.DFBuildingOperationsMarkup ||= {}, { leverLinkPanelMarkup, buildingCagePanelMarkup, buildingRestraintPanelMarkup });

  if (typeof window !== "undefined") Object.assign(window, { buildingCagePanelMarkup, buildingRestraintPanelMarkup, fetchLeverLinkInfo, leverLinkLegalTargets, leverLinkMechanismStatus, openLeverLinkPanel, postLeverLink, postLeverPull });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { leverLinkMechanismStatus, leverLinkLegalTargets, leverLinkedTargetRows, linkedTargetMetaLines, leverPulseSentence, leverLinkPanelMarkup, buildingCageSearchText, buildingCagePanelMarkup, buildingRestraintPanelMarkup, openLeverLinkPanel });
