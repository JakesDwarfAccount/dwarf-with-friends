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

  let workshopWorkerSearch = "";
  // Native's two building-sheet numeric fields are typed digit entries, each with its own
  // "currently entering" boolean holding the RAW TYPED STRING until commit.
  let wsEnteringGenOrders = false;
  let wsGenOrdersText = "";
  let wsEnteringOrderQty = false;
  let wsOrderQtyText = "1";
  let wsOrderFrequency = "OneTime";
  function workshopIconName(info) {
    const label = `${info?.subtype || ""} ${info?.name || ""} ${info?.kind || ""}`;
    return itemIconName({ label, category: "workshops" }) || (String(info?.kind || "").toLowerCase() === "furnace" ? "workshops_furnaces" : "workshops");
  }

  function workshopItemIconName(item) {
    // itemIconName lives in dwf-build-panel.js: resolve at call time and stay icon-less under node.
    if (typeof itemIconName !== "function") return null;
    const label = String(item?.name || item?.role || "");
    return itemIconName({ label, category: "workshops" }) || null;
  }

  async function workshopPost(path, params = {}) {
    const { response: r, text, data } = await globalThis.DwfCoreTransport.queryJson(path, params, {
      player: typeof player === "undefined" ? undefined : player,
      method: "POST", bust: true, includeEmpty: true,
    });
    if (!r.ok || data.ok === false)
      throw new Error(data.error || data.msg || text.trim() || "request failed");
    return data;
  }

  // Every control is GRACEFULLY DORMANT: gated on its field being present, so an older host renders
  // nothing new and hits no route. Writes are one field per POST, then a re-read.
  const WS_SKILL_LEVEL_NAMES = ["Dabbling", "Novice", "Adequate", "Competent", "Skilled", "Proficient",
    "Talented", "Adept", "Expert", "Professional", "Accomplished", "Great", "Master", "High Master",
    "Grand Master", "Legendary", "Legendary+1", "Legendary+2", "Legendary+3", "Legendary+4", "Legendary+5"];
  const WS_NO_MAX_LEVEL = 3000;
  // Populated once from a workshop-info field or GET /labor-list. Stays null when neither exists, in
  // which case blocked-labors DEGRADES to unblock-only over the set the server serves.
  let wsLaborListCache = null;
  let wsLaborListTried = false;
  function wsProfileHasControls(profile) {
    const p = profile || {};
    return p.minLevel !== undefined || p.maxLevel !== undefined || p.maxGeneralOrders !== undefined
      || p.generalOrdersBanned !== undefined || Array.isArray(p.blockedLabors);
  }
  async function warmWorkshopLaborList(info) {
    // Prefer the workshop-info extension under either field name; fall back to /labor-list, once per session.
    if (Array.isArray(info && info.laborList)) { wsLaborListCache = info.laborList; wsLaborListTried = true; return; }
    if (Array.isArray(info && info.allLabors)) { wsLaborListCache = info.allLabors; wsLaborListTried = true; return; }
    if (wsLaborListTried) return;
    wsLaborListTried = true;
    try {
      const r = await fetch(`/labor-list?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;                       // absent route (current live DLL) -> stays null, degrade path
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { return; }
      if (Array.isArray(data)) wsLaborListCache = data;
      else if (data && Array.isArray(data.labors)) wsLaborListCache = data.labors;
    } catch { globalThis.DwfErr?.count("workshop-panel.labor-list"); }
  }
  function wsSkillLevelName(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return String(v);
    if (v >= WS_NO_MAX_LEVEL) return "No maximum";
    if (v < 0) return WS_SKILL_LEVEL_NAMES[0];
    if (v >= WS_SKILL_LEVEL_NAMES.length) return "Legendary+" + (v - 15);
    return WS_SKILL_LEVEL_NAMES[v];
  }
  function wsSkillCycler(control, current, includeNoMax) {
    const cur = Math.max(0, Number(current) || 0);
    const lastNamed = WS_SKILL_LEVEL_NAMES.length - 1;
    const previous = cur >= WS_NO_MAX_LEVEL ? lastNamed : Math.max(0, cur - 1);
    const next = includeNoMax && cur >= lastNamed ? WS_NO_MAX_LEVEL : Math.min(lastNamed, cur + 1);
    return DWFUI.cyclerHtml({
      cls: "workshop-skill-cycler", label: wsSkillLevelName(cur), ariaLabel: `${control === "min" ? "Minimum" : "Maximum"} skill`,
      previous: { dataset: { wsSkill: control, value: previous }, title: "Previous skill level" },
      next: { dataset: { wsSkill: control, value: next }, title: "Next skill level" },
    });
  }
  // Single source of truth for the /workshop-profile `field` wire values, shared by the render and the
  // handlers, so the fixture proves the exact names the server acts on. A drift here breaks the wire.
  function wsProfileField(control, opts) {
    switch (control) {
      case "min": return "minLevel";
      case "max": return "maxLevel";
      case "maxOrders": return "maxGeneralOrders";
      case "banOrders": return "banGeneralOrders";
      case "labor": return (opts && opts.blocking) ? "blockLabor" : "unblockLabor";
      default: return null;
    }
  }
  // With a labor enum, a full checkbox list (checked = blocked). Without one, DEGRADE to unblock-only
  // over the currently-blocked set. Returns "" when blockedLabors is not served at all.
  function wsBlockedLaborsHtml(blockedLabors, laborList) {
    if (!Array.isArray(blockedLabors)) return "";
    const blockedIds = new Set(blockedLabors.map(b => Number(b.id)));
    const full = Array.isArray(laborList) && laborList.length ? laborList : null;
    let laborHtml, laborNote = "";
    if (full) {
      laborHtml = full.map(l => {
        const lid = Number(l.id);
        const blocked = blockedIds.has(lid);
        return `<div class="workshop-labor-row">${DWFUI.checkHtml({ checked: blocked,
          ariaLabel: `${blocked ? "Unblock" : "Block"} ${l.name || ("Labor " + lid)}`,
          dataset: { wsLabor: lid, blocking: blocked ? 0 : 1 } })}<span>${escapeHtml(l.name || ("Labor " + lid))}</span></div>`;
      }).join("");
    } else {
      laborNote = `<div class="workshop-note">Full labor list unavailable &mdash; showing only currently-blocked labors.</div>`;
      laborHtml = blockedLabors.length
        ? blockedLabors.map(b => {
            const lid = Number(b.id);
            return DWFUI.rowHtml({ cls: "workshop-worker-row", labelCls: "workshop-name",
              label: b.name || ("Labor " + lid), trailing: DWFUI.plaqueBtnHtml({
                cls: "workshop-icon-btn", size: "compact", on: true, label: "Unblock",
                dataset: { wsLaborUnblock: lid },
              }) });
          }).join("")
        : `<div class="workshop-note">No labors are blocked at this workshop.</div>`;
    }
    return `<div class="workshop-section-title">Blocked labors (${blockedLabors.length})</div>
            ${laborNote}
            <div class="workshop-list compact workshop-labor-list">${laborHtml}</div>`;
  }
  // Pure (profile, laborList) -> HTML; every sub-control is gated on its own served field, so an older
  // host renders "".
  function wsProfileControlsHtml(profile, laborList) {
    const p = profile || {};
    if (!wsProfileHasControls(p)) return "";
    let sections = "";
    if (p.minLevel !== undefined || p.maxLevel !== undefined) {
      const minSel = p.minLevel !== undefined
        ? `<div class="workshop-profile-field"><span>Min skill</span>${wsSkillCycler("min", p.minLevel, false)}</div>` : "";
      const maxSel = p.maxLevel !== undefined
        ? `<div class="workshop-profile-field"><span>Max skill</span>${wsSkillCycler("max", p.maxLevel, true)}</div>` : "";
      sections += `<div class="workshop-section-title">Skill range</div>
        <div class="workshop-note">Only citizens whose skill in this workshop's labor is within this range may work here.</div>
        <div class="zone-btn-row">${minSel}${maxSel}</div>`;
    }
    // The general-work-orders allowance is not a Workers-tab control and is not a dropdown: it is a
    // two-character typed entry on the WORK ORDERS tab -- see wsGeneralOrdersFieldHtml.
    if (p.generalOrdersBanned !== undefined) {
      const banned = !!p.generalOrdersBanned;
      sections += `<div class="zone-btn-row">${DWFUI.plaqueBtnHtml({ cls: "building-btn", tone: banned ? "red" : undefined,
        dataset: { wsBanOrders: banned ? 0 : 1 },
        label: banned ? "General work orders banned \u2014 allow" : "Ban general work orders here" })}</div>`;
    }
    sections += wsBlockedLaborsHtml(p.blockedLabors, laborList);
    return sections;
  }

  // ---- workshop panel -------------------------------------------------------------------------

  const WS_TABS = [["tasks", "Tasks"], ["workers", "Workers"], ["orders", "Work orders"]];
  function wsNormalizeTab(tab) {
    return WS_TABS.some(([key]) => key === tab) ? tab : "tasks";
  }

  // The tabs are UNCONDITIONAL; only the BODIES are conditional. A building that cannot take workers
  // still draws a Workers tab whose body is a ONE-LINE REFUSAL. Fail-OPEN: ambiguity reads as "has one".
  function wsHasProfile(info) {
    const i = info || {};
    if (typeof i.hasProfile === "boolean") return i.hasProfile;
    const p = i.profile;
    if (!p || typeof p !== "object") return false;
    if (Number(p.minLevel) === -1 && Number(p.maxLevel) === -1) return false;
    return true;
  }
  // The refusal is ONE LINE and then the tab is abandoned. Two sentences, both BRIGHT; only the
  // manager-missing line is red.
  function wsRefusalHtml(kind) {
    const text = kind === "orders"
      ? "Work orders cannot be assigned to this building."
      : "Workers cannot be assigned to this building.";
    return `<div class="workshop-note workshop-refusal" data-ws-refusal="${kind === "orders" ? "orders" : "workers"}">${escapeHtml(text)}</div>`;
  }
  // Workshop / Kitchen row 1 is the TAB row. `width:'hug'` -- these three tabs hug their labels.
  function wsTabsHtml(active) {
    return DWFUI.tabsHtml({
      cls: "workshop-tabs", tabCls: "workshop-tab", dataAttr: "workshop-tab",
      level: "primary", width: "hug",
      ariaLabel: "Workshop sections", active,
      tabs: WS_TABS.map(([key, label]) => ({ key, label })),
    });
  }


  function wsTaskSlotActive(job) {
    const j = job || {};
    return typeof j.activeIndicator === "boolean" ? j.activeIndicator : !!j.working;
  }
  function wsTaskSlotDetails(job) {
    return (job || {}).hasDetails === true;
  }
  // The double guard, isolated so the harness can drive it: >= 2 jobs in the building AND not the first
  function wsTaskCanMoveUp(index, jobCount) {
    return Number(jobCount) >= 2 && Number(index) >= 1;
  }
  function wsTaskRowHtml(job, index, jobCount) {
    const id = Number(job.id);
    const idx = Number.isFinite(Number(index)) ? Number(index) : 0;
    const count = Number.isFinite(Number(jobCount)) ? Number(jobCount) : 1;
    const meta = [];
    if (job.worker) meta.push(`Worker: ${job.worker}`);
    else if (job.working) meta.push("Being worked");
    else meta.push("Waiting");
    if (job.byManager) meta.push("Manager order");
    if (job.suspended) meta.push("Suspended");
    if (job.repeat) meta.push("Repeating");
    if (job.doNow) meta.push("Priority");
    const S = DWFUI.TOKENS.sprites;
    const slots = [];
    // --- slot 0: active indicator (conditional, unread predicate -> `working` proxy) ---
    if (wsTaskSlotActive(job)) {
      slots.push(DWFUI.actionButtonsHtml([
        { action: "status", sprite: S.jobActive, disabled: true,
          state: job.suspended ? "disabled" : "default",
          title: job.suspended ? "Task is suspended" : "Task is active" },
      ], { cls: "workshop-actions workshop-status-cell dwfui-actions", ariaLabel: "Task status" }));
    }
    // --- slot 1: ONE slot, two meanings, chosen by the by-manager flag ---
    if (job.byManager) {
      // An INDICATOR, not a toggle: native offers no repeat control on a manager-generated row.
      slots.push(DWFUI.actionButtonsHtml([
        { action: "quota", sprite: S.jobQuota, disabled: true, state: "default",
          title: "Generated by a manager work order" },
      ], { cls: "workshop-actions workshop-slot1-cell workshop-quota-cell dwfui-actions", ariaLabel: "Quota source" }));
    } else {
      slots.push(DWFUI.latchHtml({
        on: !!job.repeat, cls: "workshop-slot1-cell workshop-repeat-latch", sprite: S.repeat, activeSprite: S.repeatOn,
        dataset: { wsJob: id, wsJobAction: "repeat" }, title: "Toggle repeat", ariaLabel: "Toggle repeat",
      }));
    }
    slots.push(DWFUI.actionButtonsHtml([
      { action: "priority", sprite: S.jobDoNow, activeSprite: S.jobDoNowOn,
        active: !!job.doNow,
        title: job.doNow ? "Remove priority (do now)" : "Make priority (do now)",
        dataset: { wsJob: id, wsJobAction: job.doNow ? "priority" : "now" } },
    ], { cls: "workshop-actions workshop-donow-cell dwfui-actions", ariaLabel: "Do now" }));
    // --- slot 3: move up one (double-guarded) ---
    if (wsTaskCanMoveUp(idx, count)) {
      const wired = job.canMoveUp === true;
      slots.push(DWFUI.actionButtonsHtml([
        { action: "moveup", sprite: S.jobPriorityUp, disabled: !wired,
          state: wired ? "default" : "disabled",
          title: wired ? "Move this task up one"
            : "Move this task up one (this server build has no reorder route)",
          dataset: wired ? { wsJob: id, wsJobAction: "moveup" } : null },
      ], { cls: "workshop-actions workshop-moveup-cell dwfui-actions", ariaLabel: "Move task up" }));
    }
    // --- slot 4: details (conditional, unread predicate -> absent unless served) ---
    if (wsTaskSlotDetails(job)) {
      slots.push(DWFUI.actionButtonsHtml([
        { action: "details", sprite: S.jobRemoveWorker,
          title: "Task details (native meaning of this slot is unread -- see ledger 0078 Q5)",
          dataset: { wsJob: id, wsJobAction: "details" } },
      ], { cls: "workshop-actions workshop-details-cell dwfui-actions", ariaLabel: "Task details" }));
    }
    // --- slot 5: suspend toggle (always) ---
    // A LATCH, not an action button: two DIFFERENT sprites, and the green is baked into the ACTIVE face.
    slots.push(DWFUI.latchHtml({
      on: !!job.suspended, cls: "workshop-suspend-latch", sprite: S.suspend, activeSprite: S.suspendOn,
      dataset: { wsJob: id, wsJobAction: job.suspended ? "resume" : "suspend" },
      title: job.suspended ? "Resume task" : "Suspend task",
      ariaLabel: job.suspended ? "Resume task" : "Suspend task",
    }));
    // --- slot 6: cancel (unconditional) ---
    slots.push(DWFUI.actionButtonsHtml([
      { action: "cancel", sprite: S.cancelJob, gapBefore: true,
        title: "Remove task", dataset: { wsJob: id, wsJobAction: "cancel" } },
    ], { cls: "workshop-actions workshop-cancel-cell dwfui-actions", ariaLabel: "Remove task" }));
    return DWFUI.rowHtml({
      cls: "workshop-row" + (job.suspended ? " suspended" : ""),
      dataset: { wsJobRow: id, wsJobIndex: idx },
      title: meta.join(" \u00b7 "),
      copyCls: "workshop-task-copy",
      labelCls: "workshop-name" + (job.suspended ? "" : " cyan"),
      label: job.name || "Workshop task",
      trailing: `<span class="workshop-task-controls">${slots.join("")}</span>`,
    });
  }

  // The master is the FRONT ELEMENT of `permitted_workers` and nothing else: length <= 1 is the only
  // meaningful state, so a client that renders it as a LIST paints a screen native cannot produce.
  function wsMasterId(info) {
    const i = info || {};
    const served = Number((i.profile || {}).masterId);
    if (Number.isFinite(served) && served >= 0) return served;
    const assigned = (Array.isArray(i.workers) ? i.workers : []).filter(u => u && u.assigned);
    return assigned.length ? Number(assigned[0].id) : -1;
  }
  // The master's job policy is read from the UNIT, not the building, so it follows the dwarf between
  // workshops. Omitted when an older host does not serve it: a guessed sentence would be worse.
  function wsMasterPolicyLine(master) {
    const flag = (master || {}).onlyAssignedJobs;
    if (typeof flag !== "boolean") return "";
    return `<div class="workshop-note workshop-master-policy">${escapeHtml(flag
      ? "This dwarf only does tasks at workshops they are assigned to."
      : "This dwarf also does tasks at workshops they are not assigned to.")}</div>`;
  }
  // Pure (info -> HTML): the one master row, the one-master rule line, and the policy line.
  function wsMasterBlockHtml(info) {
    const i = info || {};
    const masterId = wsMasterId(i);
    const workers = Array.isArray(i.workers) ? i.workers : [];
    if (masterId < 0) {
      return `<div class="workshop-note workshop-master-free">This workshop is free for anybody to use.</div>`;
    }
    const master = workers.find(u => u && Number(u.id) === masterId) || null;
    // If the id resolves to nothing the row is skipped; the one-master line still follows.
    const row = master ? window.wsWorkerRowsHtml([master]) : "";
    // A count above one is a state native's renderer CANNOT produce: say so rather than rendering one
    // of several and pretending the rest are not there.
    const extra = Number((i.profile || {}).permittedCount || 0) > 1
      ? `<div class="workshop-note err workshop-master-overfull">This workshop has more than one assigned worker, which native cannot produce. Only the first is the master.</div>`
      : "";
    return `<div class="workshop-list compact workshop-master-row">${row}</div>` +
      extra +
      `<div class="workshop-note workshop-master-rule">Only one dwarf may be the master of a workshop.</div>` +
      wsMasterPolicyLine(master);
  }

  // Three states: no profile -> refusal, tab abandoned; no MANAGE_PRODUCTION position -> a red line,
  // tab continues; otherwise bright. Fail-open: only an explicit false produces the red state.
  function wsOrdersState(info) {
    const i = info || {};
    if (!wsHasProfile(i)) return "refused";
    if (i.hasManager === false) return "no-manager";
    return "ok";
  }
  function wsOrdersStateLineHtml(info) {
    switch (wsOrdersState(info)) {
      case "refused": return wsRefusalHtml("orders");
      case "no-manager":
        return `<div class="workshop-note err workshop-orders-no-manager">${escapeHtml(
          "You need a manager to add work orders.")}</div>`;
      default:
        return `<div class="workshop-note workshop-orders-ok">${escapeHtml(
          "Work orders created here are assigned to this exact workshop.")}</div>`;
    }
  }
  // The general-work-orders allowance: TWO typed characters clamped 0..99. Not a stepper and not a
  // dropdown. An older server may clamp more narrowly; the re-read shows what it stored.
  const WS_GENERAL_ORDERS_MAX = 99;
  const WS_ORDER_QTY_MAX = 9999;
  function wsGeneralOrdersFieldHtml(profile, editing, text) {
    const p = profile || {};
    if (p.maxGeneralOrders === undefined) return "";
    return `<div class="workshop-section-title">General work orders</div>` +
      `<div class="zone-btn-row workshop-genorders-row">` +
      DWFUI.numberEntryHtml({
        cls: "workshop-genorders-entry", label: "Maximum general work orders",
        value: p.maxGeneralOrders, min: 0, max: WS_GENERAL_ORDERS_MAX, maxLength: 2,
        editing: !!editing, text,
        ariaLabel: "Maximum general work orders", title: "How many general work orders may run here (0-99)",
        dataset: { wsGenOrdersInput: "" }, enterDataset: { wsGenOrdersEnter: "" },
      }) + `</div>`;
  }

  function wsContentRowHtml(item) {
    const id = Number(item.id);
    const ic = workshopItemIconName(item);
    const st = ic && typeof bldIconStyle === "function" ? bldIconStyle(ic, 40) : "";
    const icon = item.spriteRef
      ? DWFUI.iconHtml({ item: item.spriteRef, cls: "workshop-item-ico", size: 40, alt: item.name || `Item ${id}` })
      : `<span class="workshop-item-ico"${st ? ` style="${st}"` : ""}></span>`;
    const status = String(item.role || "").toUpperCase() === "PERM"
      ? `<span class="workshop-item-status" title="Part of this building">${DWFUI.TOKENS.glyphs.building}</span>`
      : `<span class="workshop-item-status" aria-hidden="true"></span>`;
    return DWFUI.rowHtml({
      cls: "workshop-item-row", dataset: { wsItemRow: id },
      icon,
      copyCls: "workshop-item-copy", labelCls: "workshop-name",
      label: item.name || `Item ${id}`,
      trailing: status + DWFUI.actionButtonsHtml([
        { title: "Locate on the map", dataset: { wsItemAction: "locate", wsItem: id } },
        { active: !!item.forbidden, title: item.forbidden ? "Claim item" : "Forbid item",
          dataset: { wsItemAction: "forbid", wsItem: id } },
        { active: !!item.dump, title: item.dump ? "Cancel dump" : "Mark for dumping",
          dataset: { wsItemAction: "dump", wsItem: id } },
        { active: !!item.hidden, title: item.hidden ? "Show item" : "Hide item",
          dataset: { wsItemAction: "hide", wsItem: id } },
      ], { preset: "itemActions", cls: "workshop-item-actions dwfui-actions", ariaLabel: "Item actions" }),
    });
  }
  function wsContentsSectionHtml(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return `<div class="workshop-contents" aria-label="Workshop contents">${items.map(wsContentRowHtml).join("")}</div>`;
  }

  // Contents is not a Tasks-tab child: it is the fixed lower section, so changing tabs swaps only the
  // upper body and leaves the same contents rows underneath.
  function wsTabBodyHtml(tab, bodies, items) {
    const key = wsNormalizeTab(tab);
    const upper = key === "workers" ? bodies.workers : key === "orders" ? bodies.orders : bodies.tasks;
    return `${upper || ""}${wsContentsSectionHtml(items)}`;
  }

  function workshopRemovalBodyHtml(info, items) {
    return `${window.buildingRemovalSectionHtml(info, { action: "ws" })}${wsContentsSectionHtml(items)}`;
  }

  // Native header tool cluster: linked-stockpiles opener, rename quill, crossed-house remove.
  function wsHeaderToolsHtml(state) {
    const s = state || {};
    return `<div class="workshop-head-tools" aria-label="Workshop tools">` +
      DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.spConnections, cls: "workshop-tool", active: !!s.linksOpen,
        title: "Linked stockpiles (give to / take from)", dataset: { wsLinksToggle: "" } }) +
      DWFUI.artBtnHtml({ spriteCrop: "quillTile", cls: "workshop-tool", active: !!s.renaming,
        title: "Rename this workshop", dataset: { wsRename: "" } }) +
      (s.markedForRemoval ? "" : DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.removeBuilding, cls: "workshop-tool",
        title: "Remove this workshop", dataset: { wsRemove: "" } })) +
      `</div>`;
  }

  function wsPickerRowHtml(cfg) {
    const c = cfg || {};
    const unavailable = c.avail === false;
    return DWFUI.rowHtml({
      tag: "button",
      cls: "workshop-task-option" + (unavailable ? " workshop-unavailable" : ""),
      chassis: "table",
      dataset: c.dataset,
      copyCls: "workshop-option-copy", labelCls: "workshop-option-label",
      label: c.label || "Task",
      sub: unavailable && c.objection ? { text: c.objection, cls: "dwfui-sub workshop-objection" }
        : (c.subText ? { text: c.subText, cls: "dwfui-sub workshop-option-meta" } : null),
    });
  }
  function wsPickerSearchHtml() {
    // Native search field: "..." placeholder, magnifier at the right.
    return DWFUI.searchHtml({
      cls: "workshop-task-search-row", inputCls: "workshop-task-search",
      value: workshopTaskSearch || "", placeholder: "...", magnifier: true,
      ariaLabel: "Search tasks",
    });
  }
  // Native's "Cancel" label is ORANGE, not the default neutral grey; `tone` is the LABEL colour axis.
  function wsCancelRowHtml() {
    return `<div class="workshop-cancel-row">${DWFUI.plaqueBtnHtml({
      label: "Cancel", tone: "orange", cls: "workshop-cancel-plaque", dataset: { wsToggleAdd: "" },
      title: "Close the task picker" })}</div>`;
  }

  function wsPickerMatches(searchText, term) {
    return dfTokenMatch(String(searchText || ""), String(term || "").trim());
  }

  // ---- the memorial-slab subject picker --------------------------------------------------------
  const WS_UNIT_PICK_SUFFIX = { EngraveSlab: "(engrave memorial)" };

  // The server's own gate, read as served: a row opens the picker because the SERVER said it needs a
  // subject, never because the client recognised the job name.
  function wsTaskNeedsUnit(task) {
    return !!(task && task.needsUnitSelection === true);
  }
  // Rows that OPEN A MENU lead, then alphabetical within each group -- and a `needsUnitSelection` row
  // is a menu-opener too, one that drills to SUBJECTS rather than to child tasks.
  function wsRowOpensMenu(task) {
    return !!(task && (task.submenu || wsTaskNeedsUnit(task)));
  }
  // A pre-wire server, a missing key or a non-array value all degrade to "no subjects", never a throw.
  function wsUnitPickUnits(info, task) {
    const bag = (info && info.taskSelectionUnits) || {};
    const list = bag[String((task && task.job) || "")];
    return Array.isArray(list) ? list : [];
  }
  function wsUnitPickLabel(unit, job) {
    const id = Number(unit && unit.unitId);
    const name = String((unit && unit.name) || "").trim() ||
      (Number.isFinite(id) ? `Unit ${id}` : "Unknown");
    const suffix = WS_UNIT_PICK_SUFFIX[String(job || "")] || "";
    return suffix ? `${name} ${suffix}` : name;
  }
  function wsUnitPickRowsHtml(units, job) {
    const list = (Array.isArray(units) ? units : []).slice()
      .sort((a, b) => String((a && a.name) || "")
        .localeCompare(String((b && b.name) || ""), undefined, { sensitivity: "base" }));
    return list.map(u => {
      const id = Number(u && u.unitId);
      // No usable unit id means nothing can be submitted, so the row is dropped rather than drawn to fail.
      if (!Number.isFinite(id) || id < 0) return "";
      const label = wsUnitPickLabel(u, job);
      // `memorialStatus` is server-sent only -- dormant until a host serves it, never composed here.
      const status = (u && typeof u.memorialStatus === "string") ? u.memorialStatus.trim() : "";
      return wsPickerRowHtml({
        label, subText: status || null,
        dataset: { wsPickUnitId: String(id), wsSearch: String(label).toLowerCase() },
      });
    }).join("");
  }
  // The same DWFUI search component the task picker uses, so the Workers tab gains the affordance
  // without a new chooser framework.
  function wsWorkerSearchHtml() {
    return DWFUI.searchHtml({
      cls: "workshop-worker-search-row", inputCls: "workshop-worker-search",
      value: workshopWorkerSearch || "", placeholder: "...", magnifier: true,
      ariaLabel: "Search citizens",
    });
  }

  // ---- links flow: the linked-stockpiles side window -------------------------------------------
  // NO THIRD ARM: native has no exchange button on either link surface, so nothing emits mode=exchange.
  function wsLinkWireMode(panelMode) {
    return panelMode === "take" ? "give" : "take";
  }
  function wsLinkPayload(stockpileId, workshopId, panelMode, on) {
    return { id: Number(stockpileId), target: Number(workshopId), mode: wsLinkWireMode(panelMode), on: on ? 1 : 0 };
  }
  function wsLinkRowHtml(link) {
    const id = Number(link.id);
    // served dir is workshop-side: 'take' = shop takes from this pile, 'give' = shop gives to it
    const dirSprite = link.dir === "take" ? DWFUI.TOKENS.sprites.wsLinkTake : DWFUI.TOKENS.sprites.wsLinkGive;
    const dirTitle = link.dir === "take" ? "This workshop takes from this stockpile"
      : "This workshop gives to this stockpile";
    return DWFUI.rowHtml({
      cls: "workshop-link-row", dataset: { wsLinkRow: id },
      // A direction MARK, not a control: the row's own buttons live in `trailing`.
      icon: DWFUI.iconHtml({ sprite: dirSprite, cls: "workshop-link-dir", title: dirTitle, alt: dirTitle }),
      copyCls: "workshop-link-copy", labelCls: "workshop-name",
      label: link.name || `Stockpile ${id}`,
      trailing: DWFUI.actionButtonsHtml([
        { action: "view", sprite: DWFUI.TOKENS.sprites.recenter, title: "Locate on the map",
          dataset: { wsLinkLocate: id, spX: Number(link.x), spY: Number(link.y), spZ: Number(link.z) } },
        { action: "unlink", sprite: DWFUI.TOKENS.sprites.cancelJob, title: "Unlink",
          dataset: { wsLinkRemove: id, wsLinkDir: link.dir === "take" ? "take" : "give" } },
      ], { cls: "dwfui-actions", ariaLabel: "Link actions" }),
    });
  }
  function wsLinksWindowHtml(info, armMode) {
    const links = Array.isArray(info.linkedStockpiles) ? info.linkedStockpiles : [];
    const rows = links.map(wsLinkRowHtml).join("") ||
      `<div class="workshop-note">No linked stockpiles. Choose give or take above, then click a stockpile on the map.</div>`;
    return DWFUI.sideWindowHtml({
      cls: "workshop-links-win", ariaLabel: "Linked stockpiles",
      tools:
        DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.wsLinkArmGive, active: armMode === "give",
          title: "Give to a stockpile: click a stockpile on the map to link it",
          dataset: { wsLinkArm: "give" } }) +
        DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.wsLinkArmTake, active: armMode === "take",
          title: "Take from a stockpile: click a stockpile on the map to link it",
          dataset: { wsLinkArm: "take" } }),
      done: { dataset: { wsLinksDone: "" } },
    }, rows);
  }

  async function openWorkshopPanel(id, tab = activeWorkshopTab) {
    // 3 native tabs only -- a stale legacy value (contents/stockpiles) folds to tasks.
    activeWorkshopTab = wsNormalizeTab(tab);
    let info = null;
    let errMsg = "";
    try {
      const r = await fetch(`/workshop-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      const text = await r.text();
      try { info = text ? JSON.parse(text) : null; } catch { globalThis.DwfErr?.count("workshop-panel.info-response-parse"); }
      if (!r.ok) errMsg = (info && (info.error || info.msg)) || text.trim() || "workshop info failed";
    } catch (err) {
      errMsg = err.message || "workshop info failed";
    }
    if (!info || info.ok === false || Number(info.id) < 0) {
      const msg = errMsg || (info && (info.error || info.msg)) || "Workshop data unavailable.";
      window.setViewSheetPanel("building-panel workshop-panel", `
        ${DWFUI.headerHtml({ cls: "building-head", title: "Workshop", titleCls: "building-name", close: false })}
        <div class="workshop-body"><div class="workshop-status err">${escapeHtml(msg)}</div></div>
      `);
      return;
    }
    // Warm the /attrib cache before the synchronous render, so the "Ordered by" line paints on first open.
    try { if (typeof attribRefresh === "function") await attribRefresh(); } catch { globalThis.DwfErr?.count("workshop-panel.attribution"); }
    // Warm the labor enum once, and only when the host actually serves profile controls.
    if (wsProfileHasControls(info.profile)) { try { await warmWorkshopLaborList(info); } catch { globalThis.DwfErr?.count("workshop-panel.labor-list-refresh"); } }
    renderWorkshopPanel(info);
  }

  // The last sheet this module painted, so the shared back-out ladder can pop one picker level and
  // repaint without a re-fetch. Replaced by the next render.
  let wsLastRenderedInfo = null;
  try {
    window.DwfModeStack.register({
      id: "workshop-task-picker", flow: "building-interact", depth: 30,
      active: () => !!wsLastRenderedInfo && !!workshopAddMode,
      pop: () => {
        if (!wsLastRenderedInfo || !workshopAddMode) return false;
        if (workshopUnitPick) workshopUnitPick = null;
        else if (Array.isArray(workshopTreePath) && workshopTreePath.length)
          workshopTreePath = workshopTreePath.slice(0, -1);
        else if (workshopFlatCat) workshopFlatCat = null;
        else workshopAddMode = false;
        workshopTaskSearch = "";
        renderWorkshopPanel(wsLastRenderedInfo);
        return true;
      },
    });
  } catch { globalThis.DwfErr?.count("workshop-panel.mode-register"); }

  function renderWorkshopPanel(info) {
    wsLastRenderedInfo = info;
    const jobs = Array.isArray(info.jobs) ? info.jobs : [];
    const tasks = Array.isArray(info.tasks) ? info.tasks : [];
    const orders = Array.isArray(info.orders) ? info.orders : [];
    const workers = Array.isArray(info.workers) ? info.workers : [];
    const items = Array.isArray(info.items) ? info.items : [];
    const tab = wsNormalizeTab(activeWorkshopTab);
    const wsIcon = workshopIconName(info);
    const wsStyle = wsIcon ? bldIconStyle(wsIcon, 28) : "";
    const statusHtml = workshopStatusMsg
      ? `<div class="workshop-status${workshopStatusIsError ? " err" : ""}">${escapeHtml(workshopStatusMsg)}</div>`
      : "";
    // A workshop is stamped as a Building by id, so its "Ordered by" line reads from the same /attrib
    // buildings section as the plain building panel.
    const wsOrderedByChip = (typeof attribRowHtml === "function") ? attribRowHtml("building", info.id) : "";
    const wsOrderedByLine = wsOrderedByChip ? `<div class="building-note building-attrib">Ordered by ${wsOrderedByChip}</div>` : "";

    function buildTaskPicker(list, addAttr, valueOf) {
      const MTF = (typeof window !== "undefined") ? window.DwfMenuTree : null;
      const open = workshopFlatCat
        ? list.find(t => t && t.submenu && t.key === workshopFlatCat) : null;
      let backHtml = "";
      if (open) {
        const crumb = String(open.name || "").replace(/\s*\(opens menu\)\s*$/, "");
        backHtml = `<div class="workshop-tree-bar">${DWFUI.plaqueBtnHtml({ label: "← Back",
          cls: "workshop-back-plaque", dataset: { wsFlatBack: "" }, title: "Back one level" })}<span
          class="workshop-meta workshop-tree-crumb">${escapeHtml(crumb)}</span></div>`;
        list = Array.isArray(open.children) ? open.children : [];
      }
      if (MTF && MTF.sortTasksAlpha) list = MTF.sortTasksAlpha(list);
      list = list.slice().sort((a, b) => (wsRowOpensMenu(a) ? 0 : 1) - (wsRowOpensMenu(b) ? 0 : 1)
        || String(a.name || a.job || "")
          .localeCompare(String(b.name || b.job || ""), undefined, { sensitivity: "base" }));
      const dsKey = addAttr.replace(/^data-/, "").replace(/-([a-z])/g, (m, ch) => ch.toUpperCase());
      const rows = list.map(t => {
        const label = t.name || t.job || "Task";
        if (t.submenu) {
          return wsPickerRowHtml({
            label: DWFUI.sentenceCase(label),
            dataset: { wsFlatCat: t.key, wsSearch: String(label).toLowerCase() },
          });
        }
        if (wsTaskNeedsUnit(t)) {
          return wsPickerRowHtml({
            label: DWFUI.sentenceCase(label),
            avail: t.avail, objection: t.objection,
            dataset: { wsPickUnit: t.key, wsSearch: String(label).toLowerCase() },
          });
        }
        return wsPickerRowHtml({
          label: DWFUI.sentenceCase(label),
          avail: t.avail, objection: t.objection,
          dataset: { [dsKey]: valueOf(t), wsSearch: String(label).toLowerCase() },
        });
      }).join("");
      return `${backHtml}${wsPickerSearchHtml()}
        <div class="workshop-task-grid">${rows || `<div class="workshop-note">No orderable tasks reported for this station.</div>`}</div>`;
    }
    // Wired after innerHTML is set; the picker is one flat list.
    function wireTaskSearch() {
      const input = selection.querySelector(".workshop-task-search");
      if (!input) return;
      const apply = () => {
        const term = (input.value || "").trim();
        workshopTaskSearch = input.value || "";
        selection.querySelectorAll(".workshop-task-option[data-ws-search]").forEach(btn => {
          btn.classList.toggle("workshop-task-filtered", !wsPickerMatches(btn.dataset.wsSearch, term));
        });
      };
      input.addEventListener("input", apply);
      // Keep view keyboard shortcuts from swallowing typing while focused in the field.
      input.addEventListener("keydown", e => e.stopPropagation());
      if (workshopTaskSearch) apply();
    }

    function buildTreePicker(tree, MT) {
      const nav = MT.levelAt(tree, workshopTreePath);
      const crumbs = [];
      if (nav.level >= 1) { const c = tree[workshopTreePath[0]]; if (c) crumbs.push(c.label || ""); }
      // leaf-only categories set nav.node to the category itself -- don't push its label twice
      if (nav.level >= 2 && nav.node && nav.node !== tree[workshopTreePath[0]]) crumbs.push(nav.node.label || "");
      const backHtml = nav.level > 0
        ? DWFUI.plaqueBtnHtml({ label: "\u2190 Back", cls: "workshop-back-plaque",
            dataset: { wsTreeBack: "" }, title: "Back one level" }) : "";
      const crumbHtml = crumbs.length
        ? `<span class="workshop-meta workshop-tree-crumb">${escapeHtml(crumbs.join(" \u203a "))}</span>` : "";
      const orderRows = rows => (MT.orderRowsAlpha ? MT.orderRowsAlpha(rows)
        : rows.map((node, idx) => ({ node, idx })));
      let rowsHtml = "";
      if (nav.level === 0) {
        // The root can MIX submenu containers and directly-queueable leaves, so render each per its kind.
        rowsHtml = orderRows(nav.rows).map(({ node, idx }) => {
          const hay = String(node.label || "").toLowerCase();
          if (MT.rowIsContainer(node)) {
            return wsPickerRowHtml({ label: MT.categoryRowLabel(node),
              dataset: { wsTreeCat: idx, wsSearch: hay } });
          }
          const key = MT.composeTaskKey(node, null);
          if (!key) return "";
          return wsPickerRowHtml({ label: node.label || "Task", avail: node.avail,
            objection: node.objection, dataset: { wsTreeLeaf: key, wsSearch: hay } });
        }).join("");
      } else if (nav.level === 1) {
        rowsHtml = nav.rows.map((m, j) => {
          const cnt = Array.isArray(m.leaves) ? m.leaves.length : 0;
          const hay = String(m.label || "").toLowerCase();
          return wsPickerRowHtml({ label: m.label || "Material",
            subText: `${cnt} task${cnt === 1 ? "" : "s"}`,
            dataset: { wsTreeMetal: j, wsSearch: hay } });
        }).join("");
      } else {
        const metal = nav.node;
        rowsHtml = orderRows(nav.rows).map(({ node: leaf }) => {
          const key = MT.composeTaskKey(leaf, metal);
          if (!key) return "";
          const hay = String(leaf.label || "").toLowerCase();
          return wsPickerRowHtml({ label: leaf.label || "Task", avail: leaf.avail,
            objection: leaf.objection, dataset: { wsTreeLeaf: key, wsSearch: hay } });
        }).join("");
      }
      const noneMsg = nav.level === 0 ? "No forge categories available." : "Nothing here.";
      return `${backHtml || crumbHtml ? `<div class="workshop-tree-bar">${backHtml}${crumbHtml}</div>` : ""}
        ${wsPickerSearchHtml()}
        <div class="workshop-task-grid">${rowsHtml || `<div class="workshop-note">${noneMsg}</div>`}</div>`;
    }

    const tasksBody = (() => {
      const MT = (typeof window !== "undefined") ? window.DwfMenuTree : null;
      // A menu tree drives the drill-down picker; otherwise fall back to the flat task list.
      const menuTree = MT && MT.isMenuTree(info.taskTree) ? info.taskTree : null;
      if (workshopAddMode && info.canAddTasks) {
        const picker = workshopUnitPick
          ? `${wsPickerSearchHtml()}
             <div class="workshop-task-grid workshop-unit-pick-grid">${
               wsUnitPickRowsHtml(wsUnitPickUnits(info, workshopUnitPick), workshopUnitPick.job) ||
               `<div class="workshop-note">No dead or missing historical figures to memorialize.</div>`
             }</div>`
          : (menuTree
            ? buildTreePicker(menuTree, MT)
            : buildTaskPicker(tasks, "data-ws-add-task", t => t.key));
        return `${wsCancelRowHtml()}
        ${picker}`;
      }
      const rows = jobs.map((job, i) => wsTaskRowHtml(job, i, jobs.length)).join("");
      const addBtn = info.canAddTasks
        ? `<div class="workshop-add-row">${DWFUI.plaqueBtnHtml({ label: "Add new task", tone: "green",
            cls: "workshop-add-plaque", dataset: { wsToggleAdd: "" }, title: "Queue a new task" })}</div>`
        : `<div class="workshop-note">No orderable tasks reported for this station.</div>`;
      return `${addBtn}
        <div class="workshop-list workshop-task-list">${rows}</div>`;
    })();

    const workersBody = (() => {
      const profile = info.profile || {};
      // No workshop profile -> ONE refusal line, and the rest of the tab is abandoned.
      if (!wsHasProfile(info)) return wsRefusalHtml("workers");
      const hasMaster = wsMasterId(info) >= 0;
      const rows = workers.length ? window.wsWorkerRowsHtml(workers)
        : `<div class="workshop-note">No citizens available.</div>`;
      const profileControls = wsProfileControlsHtml(profile, wsLaborListCache);
      // Drawn only when there is a list to filter, so a workshop reporting no citizens shows its note alone.
      const workerSearch = workers.length ? wsWorkerSearchHtml() : "";
      // Picking a citizen REPLACES the master rather than appending, because length <= 1 is the only
      // meaningful state.
      return `${wsMasterBlockHtml(info)}
        ${hasMaster ? DWFUI.plaqueBtnHtml({ cls: "building-btn", dataset: { wsWorkersClear: "" }, label: "Let anybody use this workshop" }) : ""}
        <div class="workshop-section-title">Choose the master</div>
        ${workerSearch}
        <div class="workshop-list compact workshop-worker-list">${rows}</div>
        <div class="workshop-note workshop-worker-empty" hidden>No citizens match that search.</div>
        ${profileControls}`;
    })();

    const ordersBody = (() => {
      // No workshop profile -> ONE refusal line, tab abandoned. Tested FIRST.
      const state = wsOrdersState(info);
      if (state === "refused") return wsRefusalHtml("orders");
      const orderRows = orders.length ? orders.map(o => {
        const total = Number(o.amountTotal) || 0;
        const left = Number(o.amountLeft) || 0;
        const amount = total > 0 ? `${left}/${total} left` : "repeating";
        // Per-order attribution chip, merged from /attrib by order id; empty for pre-existing orders.
        const oAttrib = (typeof attribRowHtml === "function") ? attribRowHtml("order", o.id) : "";
        return DWFUI.rowHtml({
          cls: "workshop-order-row",
          copyCls: "workshop-order-copy", labelCls: "workshop-name",
          label: o.job || "Work order",
          sub: { cls: "dwfui-sub workshop-meta",
            html: `${escapeHtml(o.frequency === "OneTime" ? "One time" : (o.frequency || "One time"))} &middot; ${escapeHtml(amount)} &middot; ${o.active ? "Active" : "Inactive"}${o.validated ? "" : " &middot; Pending"}${oAttrib ? ` &middot; ${oAttrib}` : ""}` },
          trailing: DWFUI.plaqueBtnHtml({ cls: "workshop-icon-btn danger", size: "compact", tone: "red",
            dataset: { wsOrderCancel: Number(o.id) }, title: "Cancel order", label: "Cancel" }),
        });
      }).join("") : `<div class="workshop-note">No work orders are assigned to this workshop.</div>`;
      const orderTasks = Array.isArray(info.orderTasks)
        ? info.orderTasks.filter(t => t.orderKey)
        : tasks.filter(t => t.orderKey);
      const frequencies = typeof WO_FREQS !== "undefined" ? WO_FREQS : ["OneTime", "Daily", "Monthly", "Seasonally", "Yearly"];
      if (!frequencies.includes(wsOrderFrequency)) wsOrderFrequency = frequencies[0];
      const frequencyIndex = frequencies.indexOf(wsOrderFrequency);
      const frequencyField = DWFUI.cyclerHtml({ cls: "workshop-order-frequency",
        label: typeof woFreqLabel === "function" ? woFreqLabel(wsOrderFrequency) : wsOrderFrequency,
        ariaLabel: "Order frequency",
        previous: { dataset: { wsOrderFreq: "", delta: -1 }, title: "Previous frequency" },
        next: { dataset: { wsOrderFreq: "", delta: 1 }, title: "Next frequency" },
      });
      // An order's QUANTITY is a FOUR-character typed entry clamped 0..9999, written to BOTH int16
      // amount fields. Native has no stepper here.
      const qtyField = DWFUI.numberEntryHtml({
        cls: "workshop-order-qty-entry", id: "wsOrderAmount", label: "Amount",
        value: DWFUI.clampNumberEntry(wsOrderQtyText, 0, WS_ORDER_QTY_MAX),
        min: 0, max: WS_ORDER_QTY_MAX, maxLength: 4,
        editing: wsEnteringOrderQty, text: wsOrderQtyText,
        ariaLabel: "Order amount", title: "How many to make (0-9999)",
        dataset: { wsOrderQtyInput: "" }, enterDataset: { wsOrderQtyEnter: "" },
      });
      const picker = workshopOrderAddMode ? `
        <div class="workshop-section-title">New shop work order</div>
        <div class="zone-btn-row">
          ${qtyField}
          ${frequencyField}
        </div>
        ${buildTaskPicker(orderTasks, "data-ws-add-order", t => t.orderKey)}` : "";
      // The state line comes FIRST and, in the manager-missing state, is RED. The tab continues past it.
      return `${wsOrdersStateLineHtml(info)}
        <div class="workshop-list">${orderRows}</div>
        ${wsGeneralOrdersFieldHtml(info.profile, wsEnteringGenOrders, wsGenOrdersText)}
        ${DWFUI.plaqueBtnHtml({ cls: "building-btn", dataset: { wsToggleOrder: "" },
          label: workshopOrderAddMode ? "Hide order list" : "Add shop work order" })}
        ${DWFUI.plaqueBtnHtml({ cls: "building-btn", dataset: { wsOpenOrders: "" }, label: "Open full work orders" })}
        ${picker}`;
    })();

    const body = info.markedForRemoval
      ? workshopRemovalBodyHtml(info, items)
      : wsTabBodyHtml(tab, { tasks: tasksBody, workers: workersBody, orders: ordersBody }, items);

    // The header quill toggles an inline input seeded with the current name, so an empty save clears it.
    const titleHtml = workshopRenameMode
      ? `<div class="building-name workshop-title workshop-rename-row">
           ${DWFUI.textInputHtml({ cls: "workshop-rename-input", maxLength: 128, value: info.name || "", placeholder: "Workshop name" })}
           ${DWFUI.plaqueBtnHtml({ cls: "building-btn tiny", size: "compact", dataset: { wsRenameSave: "" }, title: "Save name", label: "Save" })}
           ${DWFUI.plaqueBtnHtml({ cls: "building-btn tiny", size: "compact", dataset: { wsRenameCancel: "" }, title: "Cancel", label: "Cancel" })}
         </div>`
      : `<div class="building-name workshop-title"><span>${DWFUI.bitmapTextHtml(info.name || "Workshop")}</span></div>`;

    window.setViewSheetPanel("building-panel workshop-panel", `
      ${DWFUI.headerHtml({
        cls: "building-head workshop-head",
        icon: `<span class="workshop-ico"${wsStyle ? ` style="${wsStyle}"` : ""}></span>`,
        titleHtml, titleCls: "workshop-head-titlebox",
        tools: wsHeaderToolsHtml({ linksOpen: workshopLinksOpen, renaming: workshopRenameMode,
                                  markedForRemoval: info.markedForRemoval }),
        close: false,
      })}
      ${info.markedForRemoval ? "" : wsTabsHtml(tab)}
      <div class="workshop-body">
        ${info.markedForRemoval ? "" : wsOrderedByLine}
        ${info.markedForRemoval ? "" : statusHtml}
        ${body}
      </div>
    `);
    selection.querySelectorAll("[data-ws-tab]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      activeWorkshopTab = wsNormalizeTab(btn.dataset.wsTab);
      workshopAddMode = false;
      workshopOrderAddMode = false;
      workshopTaskSearch = "";
      workshopTreePath = [];
      workshopFlatCat = null;
      workshopUnitPick = null;
      workshopRenameMode = false;
      workshopStatusMsg = "";
      renderWorkshopPanel(info);
      focusPage();
    }));
    selection.querySelector("[data-ws-toggle-add]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopAddMode = !workshopAddMode;
      workshopTaskSearch = "";
      workshopTreePath = [];
      workshopFlatCat = null;
      // Cancel always returns to the TASK list, never a stale subject level: native's Cancel closes the flow.
      workshopUnitPick = null;
      workshopStatusMsg = "";
      renderWorkshopPanel(info);
      focusPage();
    });
    selection.querySelectorAll("[data-ws-add-task]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/workshop-add-job", { id: info.id, task: btn.dataset.wsAddTask });
        workshopAddMode = false;
        workshopStatusMsg = "Shop task queued.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not queue shop task.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "tasks");
      focusPage();
    }));
    selection.querySelectorAll("[data-ws-pick-unit]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const key = btn.dataset.wsPickUnit;
      workshopUnitPick = tasks.find(t => t && String(t.key) === String(key)) || null;
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    }));
    selection.querySelectorAll("[data-ws-pick-unit-id]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const task = workshopUnitPick;
      try {
        await workshopPost("/workshop-add-job",
          { id: info.id, task: task && task.key, unitId: Number(btn.dataset.wsPickUnitId) });
        workshopAddMode = false;
        workshopUnitPick = null;
        workshopStatusMsg = "Shop task queued.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not queue shop task.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "tasks");
      focusPage();
    }));
    // Flat-shop container drill: same shape as the tree drill below, one level deep, children in hand.
    selection.querySelectorAll("[data-ws-flat-cat]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopFlatCat = btn.dataset.wsFlatCat;
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    }));
    selection.querySelector("[data-ws-flat-back]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopFlatCat = null;
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    });
    // Forge drill-down: change workshopTreePath, clear the per-level search, re-render. No round-trip.
    selection.querySelectorAll("[data-ws-tree-cat]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopTreePath = [Number(btn.dataset.wsTreeCat)];
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    }));
    selection.querySelectorAll("[data-ws-tree-metal]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopTreePath = [workshopTreePath[0], Number(btn.dataset.wsTreeMetal)];
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    }));
    selection.querySelector("[data-ws-tree-back]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopTreePath = workshopTreePath.slice(0, -1);
      workshopTaskSearch = "";
      renderWorkshopPanel(info);
      focusPage();
    });
    // Leaf selected: POST the composed t: key (server's add_tree_task pins per-metal material).
    selection.querySelectorAll("[data-ws-tree-leaf]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/workshop-add-job", { id: info.id, task: btn.dataset.wsTreeLeaf });
        workshopAddMode = false;
        workshopTreePath = [];
      workshopFlatCat = null;
        workshopStatusMsg = "Shop task queued.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not queue shop task.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "tasks");
      focusPage();
    }));
    selection.querySelectorAll("[data-ws-job]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/workshop-job-action", { id: info.id, job: btn.dataset.wsJob, action: btn.dataset.wsJobAction });
        workshopStatusMsg = "Task updated.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not update task.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "tasks");
      focusPage();
    }));
    // Hide/show in place, the same mechanism the task picker and both zone choosers use, so the list
    // keeps its scroll position and an assignment write does not lose the player's search.
    (() => {
      const input = selection.querySelector(".workshop-worker-search");
      if (!input) return;
      const list = selection.querySelector(".workshop-worker-list");
      const empty = selection.querySelector(".workshop-worker-empty");
      const apply = () => {
        workshopWorkerSearch = input.value || "";
        const term = workshopWorkerSearch.trim();
        let shown = 0;
        list?.querySelectorAll("[data-ws-worker-search]").forEach(row => {
          const hit = wsPickerMatches(row.dataset.wsWorkerSearch, term);
          row.hidden = !hit;
          if (hit) shown++;
        });
        if (empty) empty.hidden = shown > 0;
      };
      input.addEventListener("input", apply);
      input.addEventListener("keydown", e => e.stopPropagation());
      apply();
    })();
    selection.querySelectorAll("[data-ws-worker]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        // Assigning is a REPLACE, not an append: clear the vector first so the new pick lands at element
        // zero, the only element native's renderer ever reads.
        const assigning = btn.dataset.wsAssign === "1";
        if (assigning && wsMasterId(info) >= 0)
          await workshopPost("/workshop-workers-clear", { id: info.id });
        await workshopPost("/workshop-worker-action", { id: info.id, unit: btn.dataset.wsWorker, assign: btn.dataset.wsAssign });
        workshopStatusMsg = "Worker assignment updated.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not update workers.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "workers");
      focusPage();
    }));
    selection.querySelector("[data-ws-workers-clear]")?.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/workshop-workers-clear", { id: info.id });
        workshopStatusMsg = "Workshop is unrestricted.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not clear workers.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "workers");
      focusPage();
    });
    // One field per POST, then a re-read. On failure the status line shows a non-destructive error and
    // the panel stays usable: nothing is mutated locally.
    const wsProfilePost = async (field, value, okMsg) => {
      try {
        await workshopPost("/workshop-profile", { id: info.id, field, value });
        workshopStatusMsg = okMsg;
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not update workshop profile.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "workers");
      focusPage();
    };
    selection.querySelectorAll("[data-ws-skill]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const control = event.currentTarget.dataset.wsSkill;
      wsProfilePost(wsProfileField(control), Number(event.currentTarget.dataset.value),
        control === "min" ? "Minimum skill updated." : "Maximum skill updated.");
    }));
    // Both mirror native's feed: a display cell that arms the editor, a digit-mode input holding the
    // RAW TYPED STRING, Escape to cancel, Enter or blur to commit. Neither has an increment path.
    selection.querySelector("[data-ws-gen-orders-enter]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      wsEnteringGenOrders = true;
      wsGenOrdersText = String(Number((info.profile || {}).maxGeneralOrders) || 0);
      renderWorkshopPanel(info);
      selection.querySelector("[data-ws-gen-orders-input]")?.focus();
    });
    const genOrdersInput = selection.querySelector("[data-ws-gen-orders-input]");
    if (genOrdersInput) {
      genOrdersInput.focus();
      // Digit mode: digits only, and the max typed length is what makes the clamp nearly unreachable.
      genOrdersInput.addEventListener("input", event => {
        const cleaned = String(event.currentTarget.value || "").replace(/[^0-9]/g, "").slice(0, 2);
        event.currentTarget.value = cleaned;
        wsGenOrdersText = cleaned;
      });
      const commitGenOrders = () => {
        const value = DWFUI.clampNumberEntry(wsGenOrdersText, 0, WS_GENERAL_ORDERS_MAX);
        wsEnteringGenOrders = false;
        wsProfilePost(wsProfileField("maxOrders"), value, "Max general work orders updated.");
      };
      genOrdersInput.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key === "Escape") {            // both editors are cancelled by Escape
          event.preventDefault();
          wsEnteringGenOrders = false;
          renderWorkshopPanel(info);
          focusPage();
        } else if (event.key === "Enter") {
          event.preventDefault();
          commitGenOrders();
        }
      });
      genOrdersInput.addEventListener("blur", () => { if (wsEnteringGenOrders) commitGenOrders(); });
    }
    selection.querySelector("[data-ws-order-qty-enter]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      wsEnteringOrderQty = true;
      renderWorkshopPanel(info);
      selection.querySelector("[data-ws-order-qty-input]")?.focus();
    });
    const orderQtyInput = selection.querySelector("[data-ws-order-qty-input]");
    if (orderQtyInput) {
      orderQtyInput.focus();
      orderQtyInput.addEventListener("input", event => {
        const cleaned = String(event.currentTarget.value || "").replace(/[^0-9]/g, "").slice(0, 4);
        event.currentTarget.value = cleaned;
        wsOrderQtyText = cleaned;
      });
      orderQtyInput.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          wsEnteringOrderQty = false;
          renderWorkshopPanel(info);
          focusPage();
        } else if (event.key === "Enter") {
          event.preventDefault();
          wsEnteringOrderQty = false;
          renderWorkshopPanel(info);
        }
      });
      orderQtyInput.addEventListener("blur", () => {
        if (!wsEnteringOrderQty) return;
        wsEnteringOrderQty = false;
        renderWorkshopPanel(info);
      });
    }
    selection.querySelector("[data-ws-ban-orders]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      wsProfilePost(wsProfileField("banOrders"), Number(event.currentTarget.dataset.wsBanOrders), "General work order setting updated.");
    });
    selection.querySelectorAll("[data-ws-labor]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const lid = Number(event.currentTarget.dataset.wsLabor);
      const blocking = event.currentTarget.dataset.blocking === "1";
      wsProfilePost(wsProfileField("labor", { blocking }), lid, blocking ? "Labor blocked." : "Labor unblocked.");
    }));
    selection.querySelectorAll("[data-ws-labor-unblock]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      wsProfilePost(wsProfileField("labor", { blocking: false }), Number(event.currentTarget.dataset.wsLaborUnblock), "Labor unblocked.");
    }));
    selection.querySelectorAll("[data-ws-order-freq]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const frequencies = typeof WO_FREQS !== "undefined" ? WO_FREQS : ["OneTime", "Daily", "Monthly", "Seasonally", "Yearly"];
      const frequencyIndex = Math.max(0, frequencies.indexOf(wsOrderFrequency));
      const nextIndex = (frequencyIndex + Number(event.currentTarget.dataset.delta || 0) + frequencies.length) % frequencies.length;
      wsOrderFrequency = frequencies[nextIndex];
      renderWorkshopPanel(info);
      focusPage();
    }));
    selection.querySelector("[data-ws-toggle-order]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopOrderAddMode = !workshopOrderAddMode;
      workshopTaskSearch = "";
      workshopStatusMsg = "";
      renderWorkshopPanel(info);
      focusPage();
    });
    selection.querySelectorAll("[data-ws-add-order]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      // /order-create will not accept 0, so the floor stays 1 here: that is the ROUTE's constraint, not
      // a re-clamp of the field's own 0..9999 entry.
      const amount = Math.max(1, DWFUI.clampNumberEntry(wsOrderQtyText, 0, WS_ORDER_QTY_MAX));
      const frequency = wsOrderFrequency;
      try {
        await workshopPost("/order-create", { key: btn.dataset.wsAddOrder, amount, frequency, workshop: info.id });
        workshopOrderAddMode = false;
        workshopStatusMsg = "Shop work order queued.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not queue work order.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "orders");
      focusPage();
    }));
    selection.querySelectorAll("[data-ws-order-cancel]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/order-cancel", { id: btn.dataset.wsOrderCancel });
        workshopStatusMsg = "Work order cancelled.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not cancel work order.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, "orders");
      focusPage();
    }));
    selection.querySelector("[data-ws-open-orders]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      woCreateWorkshop = info.id;
      closeSelection();
      openWorkOrdersPanel();
      focusPage();
    });
    // Deconstruct through the existing building-action route (a DF designation, not heap surgery).
    // Confirm first, since it is destructive.
    selection.querySelector("[data-ws-remove]")?.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      if (!confirm("Remove this workshop? Its tasks are cancelled and it is deconstructed.")) { focusPage(); return; }
      try {
        await fetch(`/building-action?id=${info.id}&action=remove`, { method: "POST", cache: "no-store" });
        closeSelection();
      } catch (err) {
        workshopStatusMsg = err.message || "Could not remove workshop.";
        workshopStatusIsError = true;
        renderWorkshopPanel(info);
      }
      focusPage();
    });
    selection.querySelector("[data-ws-cancel-removal]")?.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        const r = await fetch(`/building-action?id=${info.id}&action=cancel-removal`,
                              { method: "POST", cache: "no-store" });
        if (!r.ok) throw new Error("cancel removal failed");
        await openWorkshopPanel(info.id, activeWorkshopTab);
      } catch (err) {
        workshopStatusMsg = err.message || "Could not cancel removal.";
        workshopStatusIsError = true;
        renderWorkshopPanel(info);
      }
      focusPage();
    });
    // Open the inline name editor.
    selection.querySelector("[data-ws-rename]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopRenameMode = true;
      workshopStatusMsg = "";
      renderWorkshopPanel(info);
      const inp = selection.querySelector(".workshop-rename-input");
      if (inp) { inp.focus(); inp.select(); }
    });
    selection.querySelector("[data-ws-rename-cancel]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopRenameMode = false;
      renderWorkshopPanel(info);
      focusPage();
    });
    const submitRename = async () => {
      const inp = selection.querySelector(".workshop-rename-input");
      const newName = inp ? inp.value.trim() : "";
      try {
        await workshopPost("/workshop-rename", { id: info.id, name: newName });
        workshopRenameMode = false;
        workshopStatusMsg = newName ? "Workshop renamed." : "Name cleared.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not rename workshop.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, activeWorkshopTab);
      focusPage();
    };
    selection.querySelector("[data-ws-rename-save]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); submitRename();
    });
    selection.querySelector(".workshop-rename-input")?.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); submitRename(); }
      else if (event.key === "Escape") { event.preventDefault(); workshopRenameMode = false; renderWorkshopPanel(info); focusPage(); }
    });
    selection.querySelectorAll("[data-ws-item-action]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const action = btn.dataset.wsItemAction;
      if (action === "locate") {
        const pos = { x: Number(info.x), y: Number(info.y), z: Number(info.z) };
        if (typeof centerAndFlashMapPos === "function" && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))
          centerAndFlashMapPos(pos);
        focusPage();
        return;
      }
      try {
        await window.postFarmSeedAction(Number(btn.dataset.wsItem), action);
        workshopStatusMsg = "Item updated.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not update item.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, activeWorkshopTab);
      focusPage();
    }));
    // links flow: the header opener toggles the side window (rendered body-level below).
    selection.querySelector("[data-ws-links-toggle]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopLinksOpen = !workshopLinksOpen;
      if (!workshopLinksOpen) wsLinksWinDestroy();
      renderWorkshopPanel(info);
      focusPage();
    });
    wireTaskSearch();
    wsLinksWinRender(info);
  }

  // ---- links side window runtime ---------------------------------------------------------------
  let wsLinksWinEl = null;
  let wsLinksWinTimer = null;
  function wsLinksWinDestroy() {
    if (wsLinksWinTimer) { clearInterval(wsLinksWinTimer); wsLinksWinTimer = null; }
    if (wsLinksWinEl) { wsLinksWinEl.remove(); wsLinksWinEl = null; }
    if (workshopLinkArmMode && window.DFWsLink && typeof window.DFWsLink.disarm === "function")
      window.DFWsLink.disarm();
    workshopLinkArmMode = null;
  }
  function wsLinksWinPosition() {
    if (!wsLinksWinEl) return;
    if (!selection.classList.contains("visible") || selection.className.indexOf("workshop-panel") < 0) {
      workshopLinksOpen = false;
      wsLinksWinDestroy();
      return;
    }
    const rect = selection.getBoundingClientRect();
    const w = wsLinksWinEl.offsetWidth || 300;
    wsLinksWinEl.style.left = `${Math.max(6, Math.round(rect.left - w - 10))}px`;
    wsLinksWinEl.style.top = `${Math.max(6, Math.round(rect.top))}px`;
  }
  function wsLinksWinRender(info) {
    if (!workshopLinksOpen) { wsLinksWinDestroy(); return; }
    if (!wsLinksWinEl) {
      wsLinksWinEl = document.createElement("div");
      wsLinksWinEl.className = "workshop-links-mount";
      document.body.appendChild(wsLinksWinEl);
    }
    if (!wsLinksWinTimer) wsLinksWinTimer = setInterval(wsLinksWinPosition, 300);
    wsLinksWinEl.innerHTML = wsLinksWindowHtml(info, workshopLinkArmMode);
    wsLinksWinPosition();
    const rerender = () => { wsLinksWinRender(info); };
    // The armed pick posts /stockpile-link with the WIRE mode, then re-reads the workshop -- the mode
    // STAYS armed so several piles can be linked in a row.
    wsLinksWinEl.querySelectorAll("[data-ws-link-arm]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const mode = btn.dataset.wsLinkArm === "take" ? "take" : "give";
      if (workshopLinkArmMode === mode) {
        workshopLinkArmMode = null;
        if (window.DFWsLink && typeof window.DFWsLink.disarm === "function") window.DFWsLink.disarm();
        rerender();
        return;
      }
      workshopLinkArmMode = mode;
      window.DFWsLink = window.DFWsLink || {};
      window.DFWsLink.onPick = async spId => {
        try {
          await workshopPost("/stockpile-link", wsLinkPayload(spId, info.id, workshopLinkArmMode, true));
          workshopStatusMsg = "Stockpile linked.";
          workshopStatusIsError = false;
        } catch (err) {
          workshopStatusMsg = err.message || "Could not link stockpile.";
          workshopStatusIsError = true;
        }
        await openWorkshopPanel(info.id, activeWorkshopTab);
      };
      window.DFWsLink.onFailed = msg => {
        workshopStatusMsg = msg || "Click a stockpile on the map.";
        workshopStatusIsError = true;
        renderWorkshopPanel(info);
      };
      if (typeof window.DFWsLink.arm === "function") window.DFWsLink.arm(info.id, mode);
      rerender();
    }));
    wsLinksWinEl.querySelector("[data-ws-links-done]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      workshopLinksOpen = false;
      wsLinksWinDestroy();
      renderWorkshopPanel(info);
      focusPage();
    });
    wsLinksWinEl.querySelectorAll("[data-ws-link-locate]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const pos = { x: Number(btn.dataset.spX), y: Number(btn.dataset.spY), z: Number(btn.dataset.spZ) };
      if (typeof centerAndFlashMapPos === "function" && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))
        centerAndFlashMapPos(pos);
      focusPage();
    }));
    wsLinksWinEl.querySelectorAll("[data-ws-link-remove]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      try {
        await workshopPost("/stockpile-link",
          wsLinkPayload(btn.dataset.wsLinkRemove, info.id, btn.dataset.wsLinkDir, false));
        workshopStatusMsg = "Stockpile unlinked.";
        workshopStatusIsError = false;
      } catch (err) {
        workshopStatusMsg = err.message || "Could not unlink stockpile.";
        workshopStatusIsError = true;
      }
      await openWorkshopPanel(info.id, activeWorkshopTab);
      focusPage();
    }));
  }


  if (typeof window !== "undefined") Object.assign(window, { wsPickerMatches });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { workshopIconName, workshopItemIconName, workshopPost, WS_SKILL_LEVEL_NAMES, WS_NO_MAX_LEVEL, wsProfileHasControls, warmWorkshopLaborList, wsSkillLevelName, wsSkillCycler, wsProfileField, wsBlockedLaborsHtml, wsProfileControlsHtml, WS_TABS, wsNormalizeTab, wsHasProfile, wsRefusalHtml, wsTabsHtml, wsTaskSlotActive, wsTaskSlotDetails, wsTaskCanMoveUp, wsTaskRowHtml, wsMasterId, wsMasterPolicyLine, wsMasterBlockHtml, wsOrdersState, wsOrdersStateLineHtml, WS_GENERAL_ORDERS_MAX, WS_ORDER_QTY_MAX, wsGeneralOrdersFieldHtml, wsContentRowHtml, wsContentsSectionHtml, wsTabBodyHtml, workshopRemovalBodyHtml, wsHeaderToolsHtml, wsPickerRowHtml, wsPickerSearchHtml, wsCancelRowHtml, wsPickerMatches, WS_UNIT_PICK_SUFFIX, wsTaskNeedsUnit, wsRowOpensMenu, wsUnitPickUnits, wsUnitPickLabel, wsUnitPickRowsHtml, wsWorkerSearchHtml, wsLinkWireMode, wsLinkPayload, wsLinkRowHtml, wsLinksWindowHtml, openWorkshopPanel, renderWorkshopPanel, wsLinksWinDestroy, wsLinksWinPosition, wsLinksWinRender });
