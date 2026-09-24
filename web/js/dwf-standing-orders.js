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

  // ---- Labor -> Standing orders, backed by /standing-orders ----
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
    } catch {
      soData = null;
    }
    if (token !== soLoadToken) return;
    renderStandingOrdersPanel();
  }

  function soGroups() { return Array.isArray(soData?.groups) ? soData.groups : []; }

  // Keyed on the STABLE server keys, never on display strings.
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
    petition_citizenship: "petitions",
    petition_resident_performer: "petitions",
    petition_resident_monster_hunter: "petitions",
    petition_resident_mercenary: "petitions",
    petition_resident_scholar: "petitions",
    petition_resident_sanctuary: "petitions",
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
    petitions: ["petition_citizenship", "petition_resident_performer",
                "petition_resident_monster_hunter", "petition_resident_mercenary",
                "petition_resident_scholar", "petition_resident_sanctuary"],
    other: ["job_cancel_announce", "ignore_damp_stone", "ignore_warm_stone", "farmer_harvest",
            "mix_food", "zoneonly_drink", "zoneonly_fish"],
  };
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
        // New DLLs describe every native byte as stateCount + exact labels. Old DLLs only mark
        // petitions/loom as tristate, so retain that payload and the keyed label fallback.
        items: items.map(it => ({
          key: it.key, value: !!it.value, raw: it.raw, tristate: !!it.tristate,
          stateCount: it.stateCount,
          states: Array.isArray(it.states) ? it.states : undefined,
          label: soItemHasGenericStates(it)
            ? soStateLabel(it)
            : soNativeLabel(it.key, !!it.value, it.label),
        })),
      });
    }
    return out;
  }

  // ---- R9 (CIM-labor-standing-orders-petitions.jpg): 3-state prompt/accept/reject cycle --------
  // Pure, DOM-free (unit-tested). raw is the server byte (0/1/2); the label suffix is client-side.
  const PETITION_STATES = ["reject", "prompt", "accept"];
  const LOOM_STATES = [
    "No automatic weaving",
    "Automatically weave dyed thread",
    "Automatically weave all thread",
  ];
  function petitionStateLabel(raw) {
    const n = Number(raw);
    return Number.isFinite(n) ? (PETITION_STATES[((n % 3) + 3) % 3] || PETITION_STATES[0]) : PETITION_STATES[0];
  }
  function petitionNextRaw(raw) { return (((Number(raw) || 0) % 3) + 1) % 3; }
  function soServedStateCount(item) {
    const count = Number(item && item.stateCount);
    return Number.isInteger(count) && count >= 2 && count <= 4 ? count : null;
  }
  function soItemStateCount(item) {
    return soServedStateCount(item) || (item && item.tristate ? 3 : 2);
  }
  function soItemHasGenericStates(item) {
    const count = soServedStateCount(item);
    return !!(count && Array.isArray(item.states) && item.states.length >= count);
  }
  function soItemRaw(item) {
    const count = soItemStateCount(item);
    const raw = Number(item && item.raw);
    if (Number.isInteger(raw) && raw >= 0 && raw < count) return raw;
    return item && item.value ? 1 : 0;
  }
  function soItemNextRaw(item) {
    return (soItemRaw(item) + 1) % soItemStateCount(item);
  }
  function soItemUsesRaw(item) {
    return soServedStateCount(item) !== null || !!(item && item.tristate);
  }
  // New payloads carry complete native row labels. The keyed loom path remains solely for the old
  // DLL, whose three placeholder words were not suitable player-facing copy.
  function soStateLabel(item) {
    if (item && item.key === "auto_loom") {
      const raw = Number(item.raw);
      return LOOM_STATES[Number.isFinite(raw) ? ((raw % 3) + 3) % 3 : 0];
    }
    if (soItemHasGenericStates(item))
      return item.states[soItemRaw(item)];
    return petitionStateLabel(item && item.raw);
  }
  function petitionRowLabel(item) {
    if (soItemHasGenericStates(item) || (item && item.key === "auto_loom"))
      return soStateLabel(item);
    return `${item && item.label ? item.label : ""}: ${soStateLabel(item)}`;
  }
  function soItemIsTristate(item) {
    return soServedStateCount(item) === 3 || !!(item && item.tristate);
  }

  // ---- R8 (CIM-labor-standing-orders-chores.jpg): children roster + chore-type flags -----------
  // Native chore-type order (matches /chores + the oracle left-to-right/top-to-bottom).
  const CHORE_TYPE_ORDER = [
    "feed_patients_prisoners", "milking", "stone_hauling", "wood_hauling", "item_hauling",
    "burial", "food_hauling", "refuse_hauling", "furniture_hauling", "animal_hauling",
    "trade_good_hauling", "water_hauling", "cleaning", "lever_operation",
  ];
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

  let choresLoadToken = 0;

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
            ? unitPortraitMarkup({ unitId: k.unitId, name: k.name, portraitTexpos: k.portraitTexpos }, "info-portrait-small")
            : `<span class="info-portrait-small" data-parity-missing="portrait-helper"></span>`}
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
      cls: "chores-children", rows: ".chore-child-row",
      preserveKey: "labor-chores-children", ariaLabel: "Children",
    }, kids);
    return `
      ${head}
      <div class="chores-panes">
        ${children}
        ${DWFUI.listHtml({
          hostCls: "chores-types-list", cls: "chores-types", rows: ".chore-type-row",
          preserveKey: "labor-chores-types", ariaLabel: "Chore types",
        }, types)}
      </div>`;
  }

  async function loadChoresBody() {
    const body = clientPanel.querySelector(".standing-order-chores-body");
    if (!body) return;
    const token = ++choresLoadToken;
    try {
      const r = await fetch(`/chores?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error("chores route absent");
      const data = await r.json();
      if (token !== choresLoadToken) return;
      if (!data || data.ok === false) throw new Error("chores unavailable");
      body.innerHTML = choresRosterHtml(data);
      wireChoresBody(body);
    } catch {
      if (token !== choresLoadToken) return;
      // Graceful-dormant on a host without the R8 route (old DLL): no errors, a plain message.
      body.innerHTML = `<div class="info-message">Children's chores need an updated host.</div>`;
    }
  }

  function wireChoresBody(body) {
    const post = async (qs) => {
      try { await window.laborPost(`/chores?${qs}`, "Chores change"); }
      catch (err) { DwfOrder.lost("labor.chores", err, "That chores change"); }
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

  // One native list button per order; the label itself names the current state.
  function soItemButtonHtml(item) {
    const row = (label, cls, dataset) => DWFUI.rowHtml({
      tag: "button", chassis: "slab", cls: `standing-order-toggle ${cls}`, label, dataset,
      disabled: !!item.disabled,
    });
    if (soItemUsesRaw(item)) {
      const count = soItemStateCount(item);
      const raw = soItemRaw(item);
      const petition = count === 3 && String(item.key || "").startsWith("petition_");
      const label = count > 2 || soItemHasGenericStates(item) ? petitionRowLabel(item) : item.label;
      return row(label,
        count === 2 ? (raw ? "on" : "off") : (petition ? "standing-order-petition" : "standing-order-tristate"),
        { soKey: item.key, soRaw: soItemNextRaw(item) });
    }
    return row(item.label, item.value ? "on" : "off", { soKey: item.key, soOn: item.value ? 0 : 1 });
  }

  function standingOrdersMarkup(data, activeGroup = "workshops", options = {}) {
    const sourceGroups = Array.isArray(data?.groups) ? data.groups : [];
    const groups = soRegroup(sourceGroups);
    if (!groups.length || !groups.some(g => (g.items || []).length)) return `<div class="info-message">Standing orders unavailable.</div>`;
    if (!groups.some(g => g.id === "chores")) groups.splice(5, 0, { id: "chores", label: "Chores", items: [] });
    const selectedGroup = groups.some(g => g.id === activeGroup) ? activeGroup : groups[0].id;
    const group = groups.find(g => g.id === selectedGroup) || groups[0];
    let items = Array.isArray(group?.items) ? group.items : [];
    if (selectedGroup === "refuse") {
      const gather = items.find(item => item.key === "gather_refuse");
      if (gather && !gather.value) {
        items = [gather];
      } else {
        const outside = items.find(item => item.key === "gather_refuse_outside");
        if (outside && !outside.value)
          items = items.map(item => item.key === "gather_vermin_remains"
            ? { ...item, disabled: true } : item);
      }
    }
    const tabs = DWFUI.tabsHtml({ cls: "info-detail-tabs standing-order-cat-tabs", tabCls: "info-tab", dataAttr: "standing-order-group", level: "subsubtab", ariaLabel: "Standing order category", active: selectedGroup, tabs: groups.map(g => ({ key: g.id, label: g.label })) });
    if (selectedGroup === "chores") {
      const chores = options.choresData ? choresRosterHtml(options.choresData) : `<div class="info-message">Loading chores...</div>`;
      return `<div class="standing-orders-screen">${tabs}<div class="standing-order-chores"><div class="standing-order-chores-body">${chores}</div></div></div>`;
    }
    const footnote = selectedGroup === "forbidding" ? `<div class="info-message standing-order-footnote">Forbidding of death objects occurs at time of death.</div>` : "";
    const list = DWFUI.scrollHtml({
      cls: "standing-order-list", rows: ".standing-order-toggle",
      preserveKey: `standing-orders-${selectedGroup}`, ariaLabel: "Standing orders",
    }, items.length ? items.map(soItemButtonHtml).join("") : `<div class="info-message">No standing orders in this category.</div>`);
    return `<div class="standing-orders-screen">${tabs}${list}${footnote}</div>`;
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
    const wireTabs = () => main.querySelectorAll("[data-standing-order-group]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      soActiveGroup = b.dataset.standingOrderGroup;
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

    main.innerHTML = standingOrdersMarkup(soData, soActiveGroup);
    wireTabs();
    main.querySelectorAll("[data-so-key]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      const key = b.dataset.soKey;
      const usesRaw = b.dataset.soRaw !== undefined;
      const value = usesRaw ? Number(b.dataset.soRaw) : Number(b.dataset.soOn);
      try {
        await window.laborPost(`/standing-orders?key=${encodeURIComponent(key)}&value=${value}`, "Standing order");
        // Optimistic update on the RAW server cache (soRegroup rebuilds fresh objects each render,
        // so mutate the source of truth, then re-render recomputes membership + the {on,off} label).
        for (const g of soGroups()) {
          const raw = (g.items || []).find(i => i.key === key);
          if (raw) { raw.value = value !== 0; if (usesRaw) raw.raw = value; break; }
        }
        renderStandingOrdersPanel();
      } catch (err) { DwfOrder.lost("labor.standing-order", err, "That standing order"); }
      focusPage();
    }));
  }


  window.openStandingOrdersPanel = openStandingOrdersPanel;

  if (typeof module !== "undefined" && module.exports) {
    Object.assign(module.exports, {
      soRegroup, soNativeGroupOf, soNativeLabel,
      SO_NATIVE_GROUPS, SO_NATIVE_GROUP_OF, SO_NATIVE_ORDER, SO_NATIVE_LABELS,
      petitionStateLabel, petitionNextRaw, petitionRowLabel, soItemIsTristate, PETITION_STATES,
      soServedStateCount, soItemStateCount, soItemHasGenericStates, soItemRaw, soItemNextRaw,
      soStateLabel, soItemButtonHtml,
      choresModel, choresRosterHtml, choreToggleValue, CHORE_TYPE_ORDER,
      standingOrdersMarkup,
    });
  }
