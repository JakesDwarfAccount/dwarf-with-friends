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

  // Military / squads panel. Reads /squads and /squad?id=; mutates through the /squad-* and /uniform-* routes.
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function") DWFUI.require("squads", [
    "actionButtonsHtml", "artBtnHtml", "bitmapProseHtml", "bitmapTextHtml", "checkHtml", "cyclerHtml", "gridHtml", "iconHtml", "modalHtml", "plaqueBtnHtml", "rawHtml", "rowHtml",
    "scrollHtml", "searchHtml", "segmentedHtml", "sortHeaderHtml", "stepperHtml", "textInputHtml", "TOKENS",
  ]);

  let squadsList = null;        // last /squads payload
  let squadDetail = null;       // last /squad?id= payload
  let squadSelectedId = -1;     // currently selected squad id
  // Which squad the disband confirmation is currently open for, or -1. Native raises a centred
  // yes/no modal here (ledger 0045 Rule A); this is that modal's whole state.
  let squadDisbandPendingId = -1;
  let squadStatusMsg = "";      // transient status/error line
  let uniformCatalog = null;    // GET /uniforms (fort-wide template authoring catalog)
  let uniformSelectedId = -1;   // currently edited uniform template id (Add-uniform tab)
  let squadView = "list";       // list | create | create-uniform | positions | candidate | equip | schedule | ...
  let equipTab = "uniform";     // uniform | add | ammo | supplies (within the equip screen)
  let squadBurrows = null;      // GET /burrows list, loaded lazily for the defend-burrow picker
  let emblemDraft = null;       // in-progress emblem edit {symbol,fg{r,g,b},bg{r,g,b}} (client-side)
  // month starts at 0, never -1: -1 is ALL_MONTHS, and "all months" must not double as "unset".
  let trainingSel = { routine: -1, month: 0 };
  let scheduleClipboard = null; // {kind:"cell"|"column", squadId, routine, month}
  let squadPatrolDraft = { name: "Route 1", points: [] }; // native 2.3, world-coordinate points
  // The equipment selection is a (squad, position) PAIR: native rebuilds the row vectors while the
  // screen is open, so a bare row index applies the next write to the wrong squad.
  let equipmentSel = { squadId: -1, pos: 0 };
  function equipmentPositionFor(squadId) {
    return Number(equipmentSel.squadId) === Number(squadId) ? (Number(equipmentSel.pos) || 0) : 0;
  }
  function setEquipmentPosition(squadId, pos) {
    equipmentSel = { squadId: Number(squadId), pos: Number(pos) || 0 };
  }
  function equipmentMemberFor(squad) {
    const members = Array.isArray(squad && squad.members) ? squad.members : [];
    const want = equipmentPositionFor(squad && squad.id);
    return members.find(m => Number(m.idx) === Number(want)) || members[0] || null;
  }
  let equipmentPicker = null;   // {kind:"material"|"color",cat,index}

  // ---- Draft state: DWFUI controls are stateless markup, so in-progress values live here. ----
  let squadCandidatePos = -1;   // candidate screen: the exact native SQUAD_FILL_POSITION index
  let squadCandidateSort = "suitability"; // DF-sourced military-skill order; never labelled as a score
  let squadCandidateSortDirection = 1;
  let squadCandidateSearch = "";
  let createPending = null;     // create step 1 choice, consumed only after uniform step 2
  let uniformPick = {};         // equip/uniform: posIdx -> template id (was .squad-uniform-select)
  let uitemDrafts = {};         // equip/add: cat -> {subtype,matclass,color,choice} (was .squad-uitem-*)
  let ammoAddDraft = null;      // equip/ammo: the add row (was #squadAmmoType/Amount/Mat/Combat/Training)
  let ammoRowDrafts = {};       // equip/ammo: index -> {amount,combat,training} (was the row's inputs)
  let squadKillMarkerFrame = 0; // client-only map brackets for served kill-target coordinates
  let uniformFlagDraft = null;  // equip/add: {replaceClothing,exactMatches} (was the two checkboxes)
  let burrowChecked = null;     // burrow: Set of checked burrow ids (was .squad-burrow-check)
  let trainDraft = null;        // training: {sleep,uniform,train,min} (was #trainSleep/#trainUniform/...)

  // Every draft is screen-scoped: leaving a screen abandons the half-finished edit, exactly as the
  // old DOM controls did when their markup was replaced.
  function squadResetDrafts() {
    uniformPick = {}; uitemDrafts = {};
    ammoAddDraft = null; ammoRowDrafts = {}; uniformFlagDraft = null;
    burrowChecked = null; trainDraft = null;
  }

  // Local HTML escaper: delegates to the shared global escapeHtml in the browser, and falls
  // back to a self-contained escaper under node (fixture tests require this module directly).
  function sqEsc(s) {
    if (typeof escapeHtml === "function") return escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Every squad row list is one DWFUI list, keyed so a re-render keeps its scroll position.
  function sqListHtml(cfg, inner) {
    return DWFUI.listHtml(Object.assign({ key: cfg.preserveKey }, cfg), inner);
  }

  function squadSetStatus(msg) {
    squadStatusMsg = msg || "";
    const el = document.getElementById("squadStatus");
    if (el) {
      el.textContent = squadStatusMsg;
      el.classList.toggle("squad-status-active", !!squadStatusMsg);
    }
  }

  async function squadFetchJson(url, opts) {
    const response = await fetch(url, Object.assign({ cache: "no-store" }, opts || {}));
    let data = null;
    try { data = await response.json(); } catch { globalThis.DwfErr?.count("squad-panel.response-parse"); }
    if (!response.ok || (data && data.ok === false)) {
      const msg = (data && data.error) || ("request failed (" + response.status + ")");
      throw new Error(msg);
    }
    return data || {};
  }

  async function openSquadsPanel() {
    activeInfoPanel = "squads";
    setActiveToolbar("squads");
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    squadStatusMsg = "";
    squadView = "list";
    clientPanel.className = "visible squads-sidebar";
    panelContent(clientPanel).innerHTML = `<div class="info-window"><div class="info-body"><div class="info-message">Loading squads...</div></div></div>`;
    try {
      await loadUniformCatalog();
      await refreshSquads();
    } catch {
      clientPanel.className = "visible squads-sidebar";
      panelContent(clientPanel).innerHTML = `<div class="info-window"><div class="info-body"><div class="info-message">Squad data unavailable.</div></div></div>`;
    }
  }

  async function refreshSquads() {
    const data = await squadFetchJson(`/squads?player=${encodeURIComponent(player)}&t=${Date.now()}`);
    squadsList = data;
    const squads = Array.isArray(data.squads) ? data.squads : [];
    if (squadSelectedId >= 0 && !squads.some(s => s.id === squadSelectedId)) squadSelectedId = -1;
    if (squadSelectedId >= 0) {
      await loadSquadDetail(squadSelectedId);
    } else {
      squadDetail = null;
      squadView = "list";
      renderSquadsPanel();
    }
  }

  async function loadSquadDetail(id) {
    try {
      squadDetail = await squadFetchJson(`/squad?player=${encodeURIComponent(player)}&id=${encodeURIComponent(id)}&t=${Date.now()}`);
    } catch {
      squadDetail = null;
    }
    renderSquadsPanel();
  }

  async function loadUniformCatalog() {
    try {
      uniformCatalog = await squadFetchJson(`/uniforms?player=${encodeURIComponent(player)}&t=${Date.now()}`);
      const templates = Array.isArray(uniformCatalog.uniforms) ? uniformCatalog.uniforms : [];
      if (uniformSelectedId < 0 || !templates.some(u => u.id === uniformSelectedId)) {
        uniformSelectedId = templates.length ? templates[0].id : -1;
      }
    } catch {
      uniformCatalog = null;
    }
  }

  // ---- Pure view builders: data in, HTML string out; no module state, no DOM. ----

  window.SQUAD_SYMBOL_COUNT = DWFUI.EMBLEM_SYMBOL_COUNT;

  // Native's own "this squad has never been drawn" predicate, forwarded so every squad surface asks
  // the same question. See sqEmblemSwatch for why DWF does not roll the emblem itself.
  function sqEmblemUnassigned(emblem) {
    return DWFUI.emblemIsUnassigned(emblem, SQUAD_SYMBOL_COUNT);
  }

  // Clamp {r,g,b} -> "#rrggbb" for <input type="color"> value binding.
  function sqRgbToHex(c) {
    const n = v => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
    const h = v => n(v).toString(16).padStart(2, "0");
    return `#${h(c && c.r)}${h(c && c.g)}${h(c && c.b)}`;
  }

  // ---- The native control vocabulary (pure: no DOM, no state). ----
  // Native DF has no dropdown: every choice is a cycler, plaque, row or chooser screen, never a `select`.
  function sqCyclerHtml(key, options, current, cfg = {}) {
    const list = Array.isArray(options) ? options : [];
    const n = list.length;
    const found = list.findIndex(o => String(o[0]) === String(current));
    const at = found >= 0 ? found : 0;
    const cur = n ? list[at] : null;
    const prev = n ? list[(at - 1 + n) % n] : null;
    const next = n ? list[(at + 1) % n] : null;
    const ds = opt => Object.assign({ sqCyc: key, sqVal: opt ? opt[0] : "" }, cfg.dataset);
    return DWFUI.cyclerHtml({
      cls: cfg.cls, ariaLabel: cfg.ariaLabel || key,
      label: cur ? String(cur[1]) : (cfg.empty || "(none)"),
      previous: { dataset: ds(prev), title: cfg.title ? `${cfg.title}: previous` : "Previous" },
      next: { dataset: ds(next), title: cfg.title ? `${cfg.title}: next` : "Next" },
    });
  }

  function sqStepperHtml(cfg) {
    return DWFUI.stepperHtml(Object.assign({}, cfg, {
      art: true, hash: true,
      minusDataset: { sqStep: -1 }, plusDataset: { sqStep: 1 }, hashDataset: { sqStep: 0 },
    }));
  }

  // Never emit the amber SQUADS_EQUIPMENT_*_WARNING state: nothing on the wire distinguishes
  // "assigned but not carried" from filled, so painting it would invent a fact.
  window.UNIFORM_CAT_SLOT = { 0: "Armor", 1: "Helmet", 2: "Pants", 3: "Gloves", 4: "Shoes",
    5: "Shield", 6: "Weapon" };
  function sqEquipmentStrip(member) {
    const details = Array.isArray(member && member.uniformDetails) ? member.uniformDetails : [];
    const tiles = details.map(item => {
      const slot = UNIFORM_CAT_SLOT[Number(item.cat)];
      if (!slot) return "";
      const good = (Number(item.assignedCount) || 0) > 0;
      const sprite = DWFUI.TOKENS.sprites[`squadsEquip${slot}${good ? "Good" : "Missing"}`];
      if (!sprite) return "";
      const label = (window.UNIFORM_CATS.find(c => c[0] === Number(item.cat)) || [0, slot])[1];
      return DWFUI.iconHtml({
        sprite, nativeCell: true, cls: "squad-equip-slot",
        alt: `${label}: ${good ? "assigned" : "missing"}`,
        title: `${label} -- ${good ? `${item.assignedCount} item(s) assigned` : "MISSING (no item assigned)"}`,
      });
    }).filter(Boolean).join("");
    return tiles;
  }

  function sqEmblemSwatch(squad, esc = sqEsc) {
    const label = squad.alias || squad.name || ("Squad " + squad.id);
    const initial = esc((label.trim()[0] || "?").toUpperCase());
    const emblem = squad && squad.emblem;
    if (emblem && emblem.fg && emblem.bg) {
      const unassigned = sqEmblemUnassigned(emblem);
      return DWFUI.artBtnHtml({
        cls: "squad-emblem squad-emblem-btn", dataset: { squadEmblem: squad.id },
        title: unassigned ? "This squad has no emblem yet — choose one" : "Change squad emblem",
        ariaLabel: unassigned ? `${label}: choose an emblem` : `Change ${label} emblem`,
        glyphHtml: DWFUI.emblemHtml({ symbol: emblem.symbol, fg: emblem.fg, bg: emblem.bg, size: 32,
          count: SQUAD_SYMBOL_COUNT, cls: "squad-emblem-art",
          alt: unassigned ? `${label}: no emblem assigned yet` : `${label} emblem` }),
      });
    }
    const hue = ((Number(squad.id) || 0) * 47) % 360;
    return `<span class="squad-emblem" style="background:hsl(${hue},55%,32%)" title="Squad emblem (change unavailable — this build serves no emblem data)">${initial}</span>`;
  }

  function sqOrdersSummaryLine(squad) {
    const squadOrders = Array.isArray(squad && squad.orders) ? squad.orders : [];
    const members = Array.isArray(squad && squad.members) ? squad.members : [];
    const sources = squadOrders.slice();
    for (const m of members) {
      const mo = Array.isArray(m && m.orders) ? m.orders : [];
      for (const o of mo) sources.push(o);
    }
    if (!sources.length) return { text: "No special orders", tone: "disabled" };
    if (sources.length === 1) return sqOrderLine(sources[0]);
    return { text: "Multiple orders", tone: "warning" };
  }

  function sqLeaderPortrait(squad, esc = sqEsc) {
    const members = Array.isArray(squad && squad.members) ? squad.members : [];
    const leader = members.find(m => Number(m && m.idx) === 0 && m && m.filled !== false &&
      Number(m.unitId) >= 0);
    const texpos = Number(leader && leader.portraitTexpos);
    if (leader && Number.isFinite(texpos) && texpos >= 0) {
      const portrait = sqUnitPortrait(leader);
      if (portrait) {
        const name = leader.name || "squad leader";
        return `<span class="squad-leader-portrait" title="${esc(name)}">${portrait}</span>`;
      }
    }
    return `<span class="squad-leader-portrait squad-leader-portrait--unavailable" role="img"` +
      ` aria-label="Leader portrait unavailable" title="Leader portrait unavailable from this server"></span>`;
  }

  function sqListRows(squads, selectedId, esc = sqEsc) {
    if (!Array.isArray(squads) || !squads.length) {
      return `<div class="info-message">No squads yet.</div>`;
    }
    return squads.map(s => {
      const label = s.alias || s.name || ("Squad " + s.id);
      const selected = s.id === selectedId;
      const orderLine = sqOrdersSummaryLine(s);
      const icons = `<span class="squad-item-icons">${sqEmblemSwatch(s, esc)}${sqLeaderPortrait(s, esc)}` +
        DWFUI.artBtnHtml({
          sprite: DWFUI.TOKENS.sprites.squadsPositions, cls: "squad-rowtile",
          dataset: { squadPositions: s.id }, title: "Positions", ariaLabel: "Positions",
        }) +
        DWFUI.artBtnHtml({
          sprite: DWFUI.TOKENS.sprites.quill, cls: "squad-rowtile squad-rowtile-quill",
          dataset: { squadRenameFocus: s.id }, title: "Rename squad", ariaLabel: "Rename squad",
        }) + DWFUI.checkHtml({
          checked: selected, cls: "squad-item-check", dataset: { squadSelect: s.id },
          title: "Select squad", ariaLabel: "Select squad",
        }) + `</span>`;
      return DWFUI.rowHtml({
        tag: "div", cls: "squad-item dwf-cellbox", dataset: { squadId: s.id },
        chassis: "table", stacked: true, icon: icons,
        labelHtml: DWFUI.bitmapTextHtml(label, { cls: "squad-item-name-text" }),
        sub: [
          { html: DWFUI.bitmapTextHtml(orderLine.text, { cls: "squad-item-orders-text" }),
            cls: "squad-item-orders",
            tone: orderLine.tone },
          { html: DWFUI.bitmapTextHtml(`Routine:${s.routineName || "(none)"}`,
              { cls: "squad-item-routine-text" }),
            cls: "squad-item-sub" },
        ],
      });
    }).join("");
  }

  // DWFUI builders emit no id, so it is spliced back on: the wiring and the fixture address by id.
  // Keep the tag an alternation, never one regex literal -- ui_drift_guard's text scanner reads that as a raw control.
  function sqWithId(html, id) {
    return String(html).replace(/^<(button|input|label|div)\b/, `<$1 id="${id}"`);
  }

  function sqOrderToolbar(squad, opts = {}) {
    const orders = Array.isArray(squad && squad.orders) ? squad.orders : [];
    const picks = opts.memberPicks instanceof Set ? opts.memberPicks : new Set();
    const memberScope = picks.size
      ? `<div class="squad-order-scope">${DWFUI.bitmapTextHtml(
          `Orders apply to ${picks.size} selected soldier${picks.size === 1 ? "" : "s"}`,
          { cls: "squad-order-scope-text" })}` +
        sqWithId(DWFUI.plaqueBtnHtml({ label: "Whole squad", tone: "grey",
          title: "Clear the soldier selection so orders apply to the whole squad again" }),
          "squadMemberSelClearBtn") + `</div>`
      : "";
    const orderRows = orders.length
      ? orders.map(o => DWFUI.rowHtml({
          tag: "div", cls: "squad-order-row", chassis: "table",
          labelHtml: DWFUI.bitmapTextHtml(o.description || o.type || "", { fitNativeLabel: { host: "parent" } }),
          trailing: DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.squadsCancelOrder,
            dataset: { squadOrderCancel: o.index },
            title: "Cancel this order", ariaLabel: "Cancel this order" }),
        })).join("")
      : `<div class="info-message">${DWFUI.bitmapTextHtml("No current orders.",
          { cls: "squad-no-orders-text" })}</div>`;
    const moveArmed = !!opts.moveArmed;
    const killArmed = !!opts.killArmed;
    const killTargets = Array.isArray(opts.killTargets) ? opts.killTargets : [];
    const killMarks = killTargets.length
      ? `<div class="squad-kill-marks">${killTargets.map(t =>
          `<span class="squad-kill-mark" data-kill-unmark="${t.id}" title="Click to unmark">` +
          `${DWFUI.iconHtml({ sprite: DWFUI.TOKENS.sprites.squadsKill, size: 16, alt: "Kill target" })}` +
          `${DWFUI.bitmapTextHtml(`#${t.id} ${t.name || "unit"}` +
            (t.pos ? ` @ ${t.pos.x},${t.pos.y},${t.pos.z}` : ""),
            { cls: "squad-kill-mark-label", fitNativeLabel: { host: "parent", reserveCells: 3 } })}` +
          `${DWFUI.bitmapTextHtml("x", { cls: "squad-kill-unmark-label" })}</span>`).join("")}</div>`
      : "";
    let killControls;
    if (!killArmed) {
      killControls = "";
    } else {
      const confirmBtn = sqWithId(killTargets.length
        ? DWFUI.plaqueBtnHtml({ label: `Confirm (${killTargets.length})`, tone: "green",
            cls: "squad-kill-confirm", title: "Issue the kill order for every marked target" })
        : DWFUI.plaqueBtnHtml({ label: "Confirm", tone: "grey", disabled: true,
            title: "Select at least one unit on the map first" }), "squadOrderKillBtn");
      const state = killTargets.length
        ? `<span class="squad-kill-state">${killTargets.length} target${killTargets.length === 1 ? "" : "s"} marked. Click more, or Confirm.</span>`
        : `<span class="squad-kill-state">No target</span>`;
      const cancelBtn = sqWithId(DWFUI.plaqueBtnHtml({ label: "Cancel", tone: "red",
        title: "Abandon the kill order" }), "squadOrderKillCancelBtn");
      const markerNote = DWFUI.bitmapProseHtml(
        "Gold map brackets mark the served clicked tiles. Native kill-target marking is not decoded (DEF-113).",
        52, { cls: "squad-kill-marker-note" });
      killControls = `<div class="squad-controls squad-kill-row">${confirmBtn}${state}${cancelBtn}</div>${killMarks}${markerNote}`;
    }
    const moveControls = !moveArmed ? "" :
      `<div class="squad-controls squad-move-row">${sqWithId(DWFUI.plaqueBtnHtml({ label: "Cancel",
        tone: "red", title: "Abandon the station order" }), "squadOrderMoveCancelBtn")}</div>
      <span class="squad-move-state">Move: click on the map.</span>`;
    // Native strip order (R2): kill · station · patrol · defend · train · cancel-all.
    const tile = (id, sprite, title, extra = {}) => Object.assign({
      id, sprite, title, ariaLabel: title,
    }, extra);
    // Both armed states replace the strip entirely (oracles 2.1 + 2.2 show no tile row while an
    // order is being aimed); the armed flow's own Confirm/Cancel are the only live controls.
    const strip = (killArmed || moveArmed) ? "" : DWFUI.actionButtonsHtml([
      killArmed ? null : tile("squadOrderKillBtn", DWFUI.TOKENS.sprites.squadsKill,
        "Kill order: select one or more units on the map"),
      tile("squadOrderMoveBtn", DWFUI.TOKENS.sprites.squadsMove,
        moveArmed ? "Station: click a map tile (click again to cancel)" : "Station: click a map tile",
        { active: moveArmed }),
      tile("squadOrderPatrolBtn", DWFUI.TOKENS.sprites.squadsPatrol, "Draw a patrol route on the map"),
      tile("squadOrderBurrowBtn", DWFUI.TOKENS.sprites.squadsDefendBurrow, "Defend burrows: pick from the fort's burrows"),
      tile("squadOrderTrainBtn", DWFUI.TOKENS.sprites.squadsTrain,
        "Train at barracks (native's war-hammer tile is unverified evidence Q4 — this issues the train order directly)",
        { placeholder: true }),
      tile("squadOrderCancelAllBtn", DWFUI.TOKENS.sprites.squadsCancelOrder, "Cancel all orders",
        { disabled: !orders.length }),
    ].filter(Boolean), {
      cls: "squad-order-toolbar",
      btnCls: "squad-order-tile",
      ariaLabel: "Immediate squad orders",
    });
    return `
      <div class="squad-order-list">${orderRows}</div>
      ${memberScope}
      ${strip}
      ${moveControls}
      ${killControls}`;
  }

  function squadIsHostClient() {
    try {
      return !!(typeof window !== "undefined" && window.DwfWS &&
        typeof window.DwfWS.isHost === "function" && window.DwfWS.isHost());
    } catch { return false; }
  }

  // Is the disband confirmation open for this squad? `opts.disbandPendingId` lets the pure-builder
  // fixtures drive the modal without reaching into module state, exactly as the live panel does.
  function sqDisbandPendingFor(id, opts) {
    const pending = (opts && typeof opts.disbandPendingId === "number")
      ? opts.disbandPendingId : squadDisbandPendingId;
    return Number(pending) === Number(id);
  }

  function sqDisbandConfirmHtml(squad) {
    const displayName = squad.alias || squad.name || ("Squad " + squad.id);
    return DWFUI.confirmHtml({
      cls: "squad-disband-confirm",
      ariaLabel: "Confirm disbanding this squad",
      prompt: `Disband ${displayName}? Its members return to civilian work and this cannot be undone.`,
      confirmLabel: "Disband", cancelLabel: "Keep squad",
      confirm: { cls: "squad-disband-yes", dataset: { sqDisbandYes: squad.id } },
      cancel: { cls: "squad-disband-no", dataset: { sqDisbandNo: squad.id } },
    });
  }

  function sqSelectedActions(squad, opts = {}) {
    const nav = [
      DWFUI.plaqueBtnHtml({ label: "Positions", tone: "green", artTone: "neutral", cls: "squad-nav-btn", dataset: { squadNav: "positions" } }),
      DWFUI.plaqueBtnHtml({ label: "Equip", tone: "green", artTone: "neutral", cls: "squad-nav-btn", dataset: { squadNav: "equip" } }),
      DWFUI.plaqueBtnHtml({ label: "Schedule", tone: "green", artTone: "neutral", cls: "squad-nav-btn", dataset: { squadNav: "schedule" } }),
      opts.suppressDisband ? "" :
      sqWithId(DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.squadsDisband,
        cls: "squad-danger" + (sqDisbandPendingFor(squad.id, opts) ? " confirm-armed" : ""),
        active: sqDisbandPendingFor(squad.id, opts),
        // The tile no longer changes its meaning on press: it OPENS the question. `confirm-armed`
        // still paints it while the modal is up, so the origin of the dialog stays obvious.
        title: "Disband this squad (irreversible)",
        ariaLabel: "Disband this squad" }),
        "squadDeleteBtn"),
    ].join("");
    const disbandModal = (!opts.suppressDisband && sqDisbandPendingFor(squad.id, opts))
      ? sqDisbandConfirmHtml(squad) : "";
    return `
      <div class="dwfui-text--note squad-sel-meta">${DWFUI.bitmapTextHtml(`${squad.memberCount}/${squad.positionCount} members`)}</div>
      <div id="squadStatus" class="info-message squad-status"></div>
      ${sqOrderToolbar(squad, { moveArmed: squadMoveArmedFor.id === squad.id,
        killArmed: squadKillArmedFor.id === squad.id, killTargets: squadKillArmedFor.targets,
        memberPicks: opts.memberPicks })}
      <div class="squad-controls squad-rename-row">
        ${DWFUI.textInputHtml({ cls: "squad-input", id: "squadRenameInput", maxLength: 17,
          placeholder: "Rename squad — press Enter", value: squad.alias || "",
          title: "Type a new squad name and press Enter (the row's quill tile focuses this field)" })}
      </div>
      <div class="squad-nav-row">${nav}</div>${disbandModal}`;
  }

  // Squad routes may be older than portraitTexpos. Do not start a retry loop until the
  // additive field is present; -1 keeps the existing letter fallback for old servers.
  function sqUnitPortrait(unit) {
    if (typeof unitPortraitMarkup !== "function") return "";
    const texpos = Number(unit && unit.portraitTexpos);
    return unitPortraitMarkup({
      id: unit && unit.unitId, name: unit && unit.name, race: unit && unit.race,
      portraitTexpos: Number.isFinite(texpos) ? texpos : -1,
      sheetIconTexpos: unit && unit.sheetIconTexpos
    }, "info-portrait-small");
  }

  function sqProfessionColorStyle(unit) {
    const idx = unit && unit.professionColor;
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) return "";
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }

  function sqOrderIsKill(order) {
    return /kill/i.test(String((order && order.type) || ""));
  }
  // One order (or its absence) as a {text, tone} sub-line spec. Shared by the roster rows and the
  // squad-list summary so the two screens can never disagree about a colour.
  function sqOrderLine(order) {
    if (!order) return { text: "No orders", tone: "disabled" };
    return {
      text: String(order.description || order.type || "order"),
      tone: sqOrderIsKill(order) ? "danger" : "good",
    };
  }

  // ---- create: pick a squad-leading position, then a uniform -------------------------------------
  function sqCreateView(list, esc = sqEsc) {
    const positions = Array.isArray(list && list.freePositions) ? list.freePositions.slice() : [];
    const creatable = Array.isArray(list && list.creatablePositions) ? list.creatablePositions : [];
    const categoryOrder = { existing: 0, appoint: 1, new: 2 };
    positions.sort((a, b) => (categoryOrder[a.category] ?? 1) - (categoryOrder[b.category] ?? 1));
    const wrap = body => `<div class="squad-back-head">${window.sqBackPlaque()}</div>
      <div class="dwfui-text--section squad-section-title">Create which squad?</div>
      <div id="squadStatus" class="info-message squad-status"></div>${body}`;
    if (!positions.length && !creatable.length) {
      return wrap(`<div class="info-message">No free squad positions are available, and the fort's raws allow no further squad-leading positions.</div>`);
    }
    const positionRows = positions.map(p => {
      const category = p.category || (p.holderName ? "existing" : "appoint");
      const sub = esc(p.holderName || p.appointLabel || "available");
      const count = Number(p.squadSize) || 0;
      // Oracle 8: the create-chooser rows are PLAIN GREY SLABS -- `state:"on"` painted them with
      // the lit-green stockpile fill, a state paint native reserves for on/off toggles.
      return { category, html: DWFUI.rowHtml({
        tag: "button", cls: "squad-pos-row squad-create-row", chassis: "slab", state: "some",
        dataset: { squadCreatePosition: p.assignmentId, createCategory: category },
        label: p.title || "New squad", labelCls: "squad-create-title",
        sub: { html: DWFUI.rawHtml("create rows compose the served holder and position count into two cells",
          `<span class="squad-pos-who">${sub}</span><span class="squad-pos-actions">${count} positions</span>`), cls: "squad-create-meta" },
      }) };
    });
    const createRows = creatable.map(p => {
      const title = `New ${p.title || "position"}`;   // plain label slot: DWFUI renders bitmap text
      const held = Number(p.seats) || 0;
      const max = Number(p.maxSeats);
      const cap = Number.isFinite(max) && max >= 0 ? `${held}/${max} held` : `${held} held, unlimited`;
      const count = Number(p.squadSize) || 0;
      return DWFUI.rowHtml({
        tag: "button", cls: "squad-pos-row squad-create-row squad-create-new-position", chassis: "slab", state: "some",
        dataset: { squadCreateNewPosition: p.positionId, createCategory: "new" }, label: title, labelCls: "squad-create-title",
        sub: { html: DWFUI.rawHtml("create rows compose the served seat capacity and position count into two cells",
          `<span class="squad-pos-who">${esc(cap)}</span><span class="squad-pos-actions">${count} positions</span>`), cls: "squad-create-meta" },
      });
    }).join("");
    // Preserve native's three separate vectors without inventing visible category headings: the
    // row wording is DF-served, while the wrappers retain existing / appoint / new semantics.
    const categoryBody = ["existing", "appoint"].map(category =>
      `<div class="squad-create-category" data-create-category-group="${category}">` +
      positionRows.filter(row => row.category === category).map(row => row.html).join("") + `</div>`).join("") +
      `<div class="squad-create-category" data-create-category-group="new">${createRows}</div>`;
    return wrap(sqListHtml({ cls: "squad-pos-list squad-create-list", rows: ".squad-create-row", preserveKey: "squads:create" }, categoryBody));
  }

  function sqCreateUniformView(catalog, pending, esc = sqEsc) {
    if (!pending) return `<div class="info-message">Choose which squad first.</div>`;
    const uniforms = Array.isArray(catalog && catalog.uniforms) ? catalog.uniforms : [];
    const title = pending.title || "new squad";
    const rows = uniforms.map(uniform => DWFUI.rowHtml({
      tag: "div", role: "button", cls: "squad-create-uniform-row", chassis: "slab", state: "some",
      dataset: { squadCreateUniform: uniform.id }, label: uniform.name || `Uniform ${uniform.id}`,
      trailing: DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump,
        dataset: { createUniformDelete: uniform.id }, title: `Delete ${uniform.name || "this uniform"}`,
        ariaLabel: `Delete ${uniform.name || "this uniform"}` }),
    })).join("");
    const none = DWFUI.rowHtml({
      tag: "button", cls: "squad-create-uniform-row squad-create-no-uniform", chassis: "slab", state: "some",
      dataset: { squadCreateUniform: -1 }, label: "No uniform",
    });
    return `<div class="squad-back-head">${window.sqBackPlaque()}</div>
      <div class="dwfui-text--section squad-section-title">Choose a uniform for the ${esc(title)}.</div>
      <div id="squadStatus" class="info-message squad-status"></div>` +
      DWFUI.scrollHtml({ cls: "squad-create-uniform-list", preserveKey: "squads:create-uniform" }, rows + none);
  }

  // `opts` is forwarded verbatim to sqSelectedActions (ledger 0055 memberPicks / 0056
  // suppressDisband), so the rail's order bar can never disagree with the roster's.
  function sqRootPane(squads, selectedId, hasFree, esc = sqEsc, opts = {}) {
    const selected = squads.find(s => s.id === selectedId) || null;
    const blocking = Array.isArray(opts.blockingAppointments) ? opts.blockingAppointments : [];
    const blockedTitle = blocking.length === 1
      ? `Appoint a ${blocking[0]} first — that office commands a squad and is currently vacant`
      : blocking.length > 1
        ? `Several offices that command squads are vacant (${blocking.join(", ")}) — appoint one first`
        : "No squad position is free, and the fort's raws allow no further squad-leading positions";
    const createBtn = sqWithId(DWFUI.plaqueBtnHtml({
      label: "Create new squad", tone: "green", artTone: "neutral", disabled: !hasFree,
      title: hasFree ? "Create a new squad" : blockedTitle,
    }), "squadCreateBtn");
    const blockedNote = (!hasFree && blocking.length)
      ? DWFUI.bitmapProseHtml(blockedTitle, 56, { cls: "info-message squad-create-blocked" }) : "";
    const list = sqListHtml({
      cls: "squad-list", rows: ".squad-item", preserveKey: opts.listKey || "squads:list",
      hostCls: opts.contextOnly ? "squad-context-squad-list" : "squad-root-squad-list",
    }, sqListRows(squads, selectedId, esc));
    return `${list}
      <div class="squad-selected">
        ${createBtn}
        ${blockedNote}
        ${opts.contextOnly ? (opts.contextFooter || "") :
          selected ? sqSelectedActions(selected, opts) : `<div class="dwfui-text--note info-message squad-footer-note">Select a squad or squad member to give orders, change equipment, and assign schedules.</div>`}
      </div>`;
  }

  function sqContextLayout(body, squads, selectedId, hasFree, esc = sqEsc, opts = {}) {
    return `<div class="squad-context-layout"><main class="squad-context-main">${body}</main>
      <aside class="squad-equip-context" aria-label="Squads">${sqRootPane(squads, selectedId, hasFree, esc, opts)}</aside></div>`;
  }

  function buildSquadPanel(model, esc = sqEsc) {
    const view = model.view || "list";
    const squadsList = model.squadsList || {};
    const squads = Array.isArray(squadsList.squads) ? squadsList.squads : [];
    const creatable = Array.isArray(squadsList.creatablePositions) ? squadsList.creatablePositions : [];
    const hasFree = !!squadsList.hasFreePosition || creatable.length > 0;
    const detail = model.squadDetail || null;

    // `wide`, `equipment` and `contextual` pick the panel host's width tier.
    const sel = {
      uniformPick: model.uniformPick, uitemDrafts: model.uitemDrafts,
      uniformFlags: model.uniformFlagDraft, ammoAdd: model.ammoAddDraft,
      ammoRowDrafts: model.ammoRowDrafts,
    };
    if (view === "create") return { wide: true, html: sqCreateView(squadsList, esc) };
    if (view === "create-uniform") return { wide: true,
      html: sqCreateUniformView(model.uniformCatalog, model.createPending, esc) };
    if (view === "positions") return { wide: false, html: window.sqPositionsView(detail, esc, { memberPicks: model.memberPicks, blockingAppointments: squadsList.blockingAppointments, disbandPendingId: model.disbandPendingId }) };
    if (view === "candidate") {
      const chooser = window.sqCandidateView(detail, model.squadCandidatePos, {
        sortKey: model.squadCandidateSort, sortDirection: model.squadCandidateSortDirection,
        search: model.squadCandidateSearch, isHost: model.isHost,
      });
      return { wide: true, contextual: true,
        html: `<div class="squad-context-layout squad-candidate-layout"><main class="squad-context-main">${chooser}</main>` +
          `<aside class="squad-equip-context" aria-label="Squad positions">${window.sqPositionsView(detail, esc,
            // The candidate chooser IS the action here; a second order bar in its context rail
            // would duplicate the strip's control ids and add noise, so only the roster shows.
            { memberPicks: model.memberPicks, showOrders: false })}</aside></div>` };
    }
    if (view === "equip") {
      const currentId = Number(detail?.squad?.id ?? model.squadSelectedId);
      const editor = window.sqEquipView(detail, model.uniformCatalog, model.equipTab, model.uniformSelectedId,
        model.equipmentPosition, model.equipmentPicker, esc, sel);
      // Native keeps the ordinary squad rail on the right in every equipment capture (5.1-5.5.2).
      // Reuse the root pane so squad switching and its order/equip/schedule controls cannot drift.
      return { wide: true, equipment: true, html: `<div class="squad-equip-layout"><div class="squad-equip-main">${editor}</div>` +
        `<aside class="squad-equip-context" aria-label="Squads">${sqRootPane(squads, currentId, hasFree, esc, { memberPicks: model.memberPicks, blockingAppointments: squadsList.blockingAppointments, disbandPendingId: model.disbandPendingId })}</aside></div>` };
    }
    if (view === "schedule") return { wide: true, contextual: true,
      html: sqContextLayout(window.sqScheduleView(detail, esc, model.scheduleClipboard), squads, model.squadSelectedId, hasFree, esc, { memberPicks: model.memberPicks, blockingAppointments: squadsList.blockingAppointments, disbandPendingId: model.disbandPendingId }) };
    if (view === "routines") return { wide: true, contextual: true,
      html: sqContextLayout(window.sqRoutinesView(detail), squads, model.squadSelectedId, hasFree, esc, { memberPicks: model.memberPicks, blockingAppointments: squadsList.blockingAppointments, disbandPendingId: model.disbandPendingId }) };
    if (view === "monthly") return { wide: true, contextual: true,
      html: sqContextLayout(window.sqMonthlyView(detail, esc, model.scheduleClipboard), squads, model.squadSelectedId, hasFree, esc, { memberPicks: model.memberPicks, blockingAppointments: squadsList.blockingAppointments, disbandPendingId: model.disbandPendingId }) };
    if (view === "training") return { wide: true, html: window.sqTrainingView(detail, model.trainingSel, esc, model.trainDraft) };
    if (view === "emblem") return { wide: true, html: window.sqEmblemView(detail, model.emblemDraft, esc) };
    if (view === "burrow") return { wide: true, contextual: true,
      html: window.sqBurrowDefendView(detail && detail.squad, model.squadBurrows, esc, model.burrowChecked, {
        squads, selectedId: model.squadSelectedId, hasFree,
        blockingAppointments: squadsList.blockingAppointments,
      }) };
    if (view === "patrol") return { wide: true, html: window.sqPatrolView(detail && detail.squad, model.squadPatrolDraft, esc) };

    // list (root)
    if (!squads.length && !hasFree) {
      return { wide: false, html: `<div class="squad-empty-state">You must appoint a militia commander<br>to create a squad.</div>` };
    }
    return { wide: false, html: sqRootPane(squads, model.squadSelectedId, hasFree, esc, { memberPicks: model.memberPicks, blockingAppointments: squadsList.blockingAppointments, disbandPendingId: model.disbandPendingId }) };
  }

  // ---- Render + wiring (browser-only: reads module state, mutates the DOM). ----

  // ---- the footer is fixed and the squad list is elastic ---------------------------------------
  function sqRootListRows(availablePx, pitchPx) {
    if (!(pitchPx > 0)) return 0;
    return Math.max(0, Math.floor((availablePx + 0.5) / pitchPx));
  }

  function sqFitRootList(panel = clientPanel) {
    try {
      const host = panel.querySelector(".squad-body > .squad-root-squad-list");
      const body = panel.querySelector(".squad-body");
      const footer = panel.querySelector(".squad-body > .squad-selected");
      const row = host && host.querySelector(".squad-item");
      if (!host || !body || !footer || !row) return;
      const pitch = row.getBoundingClientRect().height;
      if (!(pitch > 1)) return;
      const hostRect = host.getBoundingClientRect();
      const footRect = footer.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const padBottom = parseFloat(getComputedStyle(body).paddingBottom) || 0;
      const gapAfter = footRect.top - hostRect.bottom;      // whatever the stylesheet puts between them
      const available = (bodyRect.bottom - padBottom) - hostRect.top - footRect.height - gapAfter;
      // At short heights the selected footer wins. A forced row would clip its controls; zero rows
      // is an honest temporary viewport state and the list returns as soon as one full row fits.
      const rows = sqRootListRows(available, pitch);
      const px = `${Math.round(rows * pitch * 100) / 100}px`;
      if (host.style.getPropertyValue("--squad-root-list-size") !== px)
        host.style.setProperty("--squad-root-list-size", px);
    } catch { globalThis.DwfErr?.count("squad-panel.root-fit"); }
  }

  // Re-point the observer after every render -- each render replaces both nodes. Neither observed
  // size depends on the list height written here, so there is no feedback loop.
  let sqRootFitObserver = null;
  function sqObserveRootFit() {
    try {
      if (typeof ResizeObserver !== "function") return;
      if (!sqRootFitObserver) sqRootFitObserver = new ResizeObserver(() => sqFitRootList());
      else sqRootFitObserver.disconnect();
      const body = clientPanel.querySelector(".squad-body");
      const footer = clientPanel.querySelector(".squad-body > .squad-selected");
      if (body) sqRootFitObserver.observe(body);
      if (footer) sqRootFitObserver.observe(footer);
    } catch { globalThis.DwfErr?.count("squad-panel.root-fit-observer"); }
  }

  // Right-click backs out exactly one level; the armed-mode rung lives in dwf-controls-placement.js.
  try {
    const onSquads = () => {
      try { return activeInfoPanel === "squads"; } catch { return false; }
    };
    window.DwfModeStack.register({
      id: "squad-subview", flow: "squads-orders", depth: 20,
      active: () => onSquads() && squadView !== "list",
      pop: () => {
        if (!onSquads() || squadView === "list") return false;
        goToView("list");
        return true;
      },
    });
    window.DwfModeStack.register({
      id: "squad-scope", flow: "squads-orders", depth: 15,
      active: () => onSquads() && squadView === "list" && squadSelectedId >= 0,
      pop: () => {
        if (!onSquads() || squadView !== "list" || squadSelectedId < 0) return false;
        squadSelectedId = -1;   // back to fort scope: the order row disappears, the list stays
        squadStatusMsg = "";
        renderSquadsPanel();
        return true;
      },
    });
  } catch { globalThis.DwfErr?.count("squad-panel.mode-register"); }

  // Re-render when the confirm latch lapses: the disband tile must not keep saying "press again".
  try {
    window.DwfConfirmGate.onChange(() => {
      try { if (activeInfoPanel === "squads") renderSquadsPanel(); } catch { globalThis.DwfErr?.count("squad-panel.confirm-render"); }
    });
  } catch { globalThis.DwfErr?.count("squad-panel.confirm-observer"); }

  function goToView(view) {
    if (squadView === "patrol" && view !== "patrol" && window.DFSquadPatrol) window.DFSquadPatrol.disarm();
    if (view !== squadView) squadResetDrafts();   // a half-typed form does not survive leaving its screen
    squadView = view;
    squadStatusMsg = "";
    renderSquadsPanel();
  }

  // DEF-113: native kill-target marking art is not decoded. The gold bracket on each served tile is
  // a client marker, drawn from the browser camera only -- no DF polling.
  function clearSquadKillMapMarkers() {
    if (squadKillMarkerFrame && typeof cancelAnimationFrame === "function")
      cancelAnimationFrame(squadKillMarkerFrame);
    squadKillMarkerFrame = 0;
    document.getElementById("squadKillMapMarkers")?.remove();
  }

  function paintSquadKillMapMarkers() {
    squadKillMarkerFrame = 0;
    let panelActive = false;
    try {
      panelActive = activeInfoPanel === "squads" && clientPanel.classList.contains("visible");
    } catch { globalThis.DwfErr?.count("squad-panel.kill-markers"); }
    const targets = squadKillArmedFor.id >= 0 && panelActive
      ? squadKillArmedFor.targets.filter(t => t.pos) : [];
    if (!targets.length) { clearSquadKillMapMarkers(); return; }

    let layer = document.getElementById("squadKillMapMarkers");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "squadKillMapMarkers";
      layer.className = "squad-kill-map-markers";
      layer.setAttribute("aria-hidden", "true");
      document.body.appendChild(layer);
    }
    const keep = new Set(targets.map(t => String(t.id)));
    for (const old of [...layer.children]) {
      if (!keep.has(old.dataset.killMarker)) old.remove();
    }
    for (const target of targets) {
      let marker = [...layer.children].find(node => node.dataset.killMarker === String(target.id));
      if (!marker) {
        marker = document.createElement("div");
        marker.className = "squad-kill-map-marker";
        marker.dataset.killMarker = String(target.id);
        layer.appendChild(marker);
      }
      const rect = typeof screenRectForMapTile === "function" ? screenRectForMapTile(target.pos) : null;
      marker.hidden = !rect;
      if (!rect) continue;
      marker.style.left = `${rect.left}px`;
      marker.style.top = `${rect.top}px`;
      marker.style.width = `${rect.width}px`;
      marker.style.height = `${rect.height}px`;
    }
    if (typeof requestAnimationFrame === "function")
      squadKillMarkerFrame = requestAnimationFrame(paintSquadKillMapMarkers);
  }

  function renderSquadsPanel() {
    // A pending disband belongs to ONE squad. Selecting a different squad abandons the question,
    // so it must not lie in wait and reappear if the player selects the first squad again.
    if (squadDisbandPendingId !== squadSelectedId) squadDisbandPendingId = -1;
    const model = {
      view: squadView,
      squadsList,
      squadDetail,
      uniformCatalog,
      squadSelectedId,
      uniformSelectedId,
      equipTab,
      squadBurrows,
      emblemDraft,
      trainingSel,
      scheduleClipboard,
      squadPatrolDraft,
      equipmentPosition: equipmentPositionFor(squadSelectedId),
      equipmentPicker,
      squadCandidatePos,
      squadCandidateSort,
      squadCandidateSortDirection,
      squadCandidateSearch,
      createPending,
      isHost: squadIsHostClient(),
      disbandPendingId: squadDisbandPendingId,
      uniformPick,
      uitemDrafts,
      uniformFlagDraft,
      ammoAddDraft,
      ammoRowDrafts,
      burrowChecked,
      trainDraft,
      memberPicks: squadMemberPicks(squadSelectedId),
    };
    const { wide, equipment, contextual, html } = buildSquadPanel(model, sqEsc);
    clientPanel.className = "visible squads-sidebar" + (wide ? " squads-wide" : "") +
      (equipment ? " squads-equipment" : "") + (contextual ? " squads-contextual" : "");
    panelContent(clientPanel).innerHTML = `<div class="info-window"><div class="info-body squad-body">${html}</div></div>`;
    clearSquadKillMapMarkers();
    paintSquadKillMapMarkers();
    sqObserveRootFit();
    sqFitRootList();

    // --- shared wiring: squad selection + unit links ---
    clientPanel.querySelectorAll("[data-squad-id]").forEach(el => {
      el.addEventListener("click", async () => {
        squadSelectedId = Number(el.dataset.squadId);
        squadStatusMsg = "";
        await loadSquadDetail(squadSelectedId);
      });
    });
    clientPanel.querySelectorAll("[data-squad-select]").forEach(el => {
      el.addEventListener("click", async event => {
        event.stopPropagation();
        const id = Number(el.dataset.squadSelect);
        if (squadSelectedId === id) {
          squadSelectedId = -1;
          squadDetail = null;
          squadStatusMsg = "";
          renderSquadsPanel();
          return;
        }
        squadSelectedId = id;
        squadStatusMsg = "";
        await loadSquadDetail(squadSelectedId);
      });
    });
    // The row's quill tile (native R1) targets the free-text rename field, which is the client's
    // ONLY rename path. It selects the squad and focuses the input -- it does not replace it.
    clientPanel.querySelectorAll("[data-squad-rename-focus]").forEach(el => {
      el.addEventListener("click", async event => {
        event.stopPropagation();
        const id = Number(el.dataset.squadRenameFocus);
        if (squadSelectedId !== id) {
          squadSelectedId = id;
          squadStatusMsg = "";
          await loadSquadDetail(id);
        }
        const input = clientPanel.querySelector("#squadRenameInput");
        if (input) { input.focus(); input.select(); }
      });
    });
    clientPanel.querySelectorAll("[data-squad-positions]").forEach(el => {
      el.addEventListener("click", async event => {
        event.stopPropagation();
        squadSelectedId = Number(el.dataset.squadPositions);
        squadStatusMsg = "";
        squadView = "positions";
        await loadSquadDetail(squadSelectedId);
      });
    });
    // Emblem badge (list row) -> emblem edit screen. Only rendered when emblem data is present.
    clientPanel.querySelectorAll("[data-squad-emblem]").forEach(el => {
      el.addEventListener("click", async event => {
        event.stopPropagation();
        squadSelectedId = Number(el.dataset.squadEmblem);
        squadStatusMsg = "";
        squadView = "emblem";
        emblemDraft = null;
        await loadSquadDetail(squadSelectedId);
      });
    });
    clientPanel.querySelectorAll("[data-unit-id]").forEach(el => {
      el.addEventListener("click", event => {
        event.stopPropagation();
        const id = Number(el.dataset.unitId);
        if (id >= 0 && typeof openUnitById === "function") openUnitById(id);
      });
    });
    clientPanel.querySelectorAll("[data-squad-nav]").forEach(el => {
      el.addEventListener("click", event => { event.stopPropagation(); goToView(el.dataset.squadNav); });
    });
    // Back navigates to the current view's PARENT (routines/monthly return to schedule; the
    // training editor returns to the monthly grid); every other screen returns to the list.
    clientPanel.querySelector("#squadBackBtn")?.addEventListener("click", () => {
      const parent = { routines: "schedule", monthly: "schedule", training: "monthly",
        create: "list", "create-uniform": "create", candidate: "positions" }[squadView] || "list";
      goToView(parent);
    });

    wireCyclers();
    wireStepperTiles();

    // --- list view controls ---
    clientPanel.querySelector("#squadCreateBtn")?.addEventListener("click", () => {
      const free = squadsList && Array.isArray(squadsList.freePositions) ? squadsList.freePositions : null;
      const creatable = squadsList && Array.isArray(squadsList.creatablePositions)
        ? squadsList.creatablePositions : null;
      if ((free && free.length) || (creatable && creatable.length)) {
        squadView = "create"; squadStatusMsg = ""; renderSquadsPanel(); return;
      }
      squadCreate();
    });
    clientPanel.querySelectorAll("[data-squad-create-position]").forEach(button => {
      button.addEventListener("click", () => {
        createPending = { kind: "assignment", id: Number(button.dataset.squadCreatePosition),
          title: button.querySelector(".squad-create-title")?.textContent?.trim() || "new squad" };
        squadView = "create-uniform";
        renderSquadsPanel();
      });
    });
    // remember the requested new seat, but make it only after native's uniform step.
    clientPanel.querySelectorAll("[data-squad-create-new-position]").forEach(button => {
      button.addEventListener("click", () => {
        createPending = { kind: "position", id: Number(button.dataset.squadCreateNewPosition),
          title: button.querySelector(".squad-create-title")?.textContent?.trim() || "new squad" };
        squadView = "create-uniform";
        renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll("[data-squad-create-uniform]").forEach(button => {
      button.addEventListener("click", () => {
        if (!createPending) return;
        const uniformId = Number(button.dataset.squadCreateUniform);
        if (createPending.kind === "position") squadCreateNewPosition(createPending.id, uniformId);
        else squadCreate(createPending.id, uniformId);
      });
    });
    clientPanel.querySelectorAll("[data-create-uniform-delete]").forEach(button => {
      button.addEventListener("click", async event => {
        event.stopPropagation();
        try {
          await window.uniformPost("uniform-delete", { id: Number(button.dataset.createUniformDelete) });
          squadStatusMsg = "Uniform deleted.";
          await loadUniformCatalog();
        } catch (err) { squadStatusMsg = err.message || "Could not delete uniform."; }
        renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#squadRenameInput")?.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      squadRename(squadSelectedId, event.currentTarget.value);
    });
    clientPanel.querySelector("#squadDeleteBtn")?.addEventListener("click", () => {
      if (squadSelectedId < 0) return;   // native raises no prompt with nothing selected
      squadDisbandPendingId = squadSelectedId;
      renderSquadsPanel();
    });
    // "Keep squad" -- and any re-press of the tile while the modal is up -- backs out unchanged.
    clientPanel.querySelectorAll("[data-sq-disband-no]").forEach(b => b.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      squadDisbandPendingId = -1;
      renderSquadsPanel();
    }));
    clientPanel.querySelectorAll("[data-sq-disband-yes]").forEach(b => b.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      const id = Number(b.dataset.sqDisbandYes);
      squadDisbandPendingId = -1;
      if (id >= 0) squadDelete(id);
    }));

    // Bound before the row handler and stopping propagation: a tick must not also navigate.
    clientPanel.querySelectorAll("[data-squad-member-select]").forEach(box => {
      box.addEventListener("click", event => {
        event.stopPropagation();
        event.preventDefault();
        squadMemberToggle(squadSelectedId, Number(box.dataset.squadMemberSelect));
        renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#squadMemberSelClearBtn")?.addEventListener("click", () => {
      squadMemberClear();
      renderSquadsPanel();
    });

    // --- position roster -> dedicated native candidate screen ---
    clientPanel.querySelectorAll("[data-squad-pick-pos]").forEach(button => {
      button.addEventListener("click", event => {
        // The roster row is a div now (it contains the tick-box), so a click that landed on the
        // tick-box must not fall through to the navigate-to-candidate action.
        if (event.target && event.target.closest && event.target.closest("[data-squad-member-select]")) return;
        squadCandidatePos = Number(button.dataset.squadPickPos);
        squadCandidateSort = "suitability";
        squadCandidateSortDirection = 1;
        squadCandidateSearch = "";
        squadView = "candidate";
        renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll("[data-squad-assign-unit]").forEach(button => {
      button.addEventListener("click", () => {
        squadAssign(squadSelectedId, Number(button.dataset.squadAssignUnit),
          Number(button.dataset.squadAssignPos));
      });
    });
    clientPanel.querySelectorAll("[data-squad-remove-assignment]").forEach(button => {
      button.addEventListener("click", () => squadRemove(Number(button.dataset.squadRemoveAssignment)));
    });
    clientPanel.querySelectorAll("[data-squad-candidate-sort]:not([disabled])").forEach(button => {
      button.addEventListener("click", () => {
        const key = button.dataset.squadCandidateSort || "suitability";
        if (key === squadCandidateSort) squadCandidateSortDirection *= -1;
        else { squadCandidateSort = key; squadCandidateSortDirection = 1; }
        renderSquadsPanel();
      });
    });
    const candidateList = clientPanel.querySelector(".squad-candidate-list");
    const applyCandidateSearch = () => candidateList?.querySelectorAll("[data-candidate-search]").forEach(row => {
      const query = squadCandidateSearch.trim().toLowerCase();
      row.hidden = query && typeof dfTokenMatch === "function"
        ? !dfTokenMatch(row.dataset.candidateSearch || "", query)
        : !String(row.dataset.candidateSearch || "").includes(query);
    });
    applyCandidateSearch();
    clientPanel.querySelector("[data-squad-candidate-search]")?.addEventListener("input", event => {
      squadCandidateSearch = event.target.value || "";
      applyCandidateSearch();
    });

    // --- equip view: sub-nav switching (the four green plaques, native 5) ---
    clientPanel.querySelectorAll("[data-equip-tab]").forEach(button => {
      button.addEventListener("click", () => {
        equipTab = button.dataset.equipTab; equipmentPicker = null;
        squadResetDrafts();                      // a new sub-screen starts with a clean form
        renderSquadsPanel();
      });
    });

    // --- per-view detail wiring ---
    if (squadDetail && squadDetail.squad) {
      const squad = squadDetail.squad;
      wireSquadOrderControls(squad);
      if (squadView === "schedule") window.wireSquadScheduleControls(squad);
      if (squadView === "routines") window.wireRoutinesControls(squad);
      if (squadView === "monthly") window.wireMonthlyControls(squad);
      if (squadView === "training") window.wireTrainingControls(squad);
      if (squadView === "emblem") window.wireEmblemControls(squad);
      if (squadView === "burrow") window.wireBurrowDefendControls(squad);
      if (squadView === "patrol") window.wirePatrolControls(squad);
      if (squadView === "equip") {
        if (equipTab === "uniform") window.wireSquadUniformControls(squad);
        if (equipTab === "ammo") window.wireSquadAmmoControls(squad);
        if (equipTab === "add") window.wireUniformEditorControls();
        if (equipTab === "supplies") window.wireSquadSuppliesControls(squad);
        if (equipTab === "details") window.wireSquadEquipmentControls(squad);
      }
    }

    squadSetStatus(squadStatusMsg);
  }

  // ---- Generic control wiring: one handler per native control family. ----
  function wireCyclers() {
    clientPanel.querySelectorAll("[data-sq-cyc]").forEach(slice => {
      slice.addEventListener("click", async event => {
        event.stopPropagation();
        const key = slice.dataset.sqCyc;
        const raw = slice.dataset.sqVal;
        if (raw === "" || raw == null) return;              // an empty chooser is inert, not broken
        const squad = squadDetail && squadDetail.squad;
        switch (key) {
          case "uniformPick":                                // was .squad-uniform-select[data-uniform-pos]
            uniformPick[Number(slice.dataset.uniformPos)] = Number(raw); renderSquadsPanel(); return;
          case "uniformSelect":                              // was #uniformSelect
            // A DIFFERENT template has DIFFERENT flags: drop the drafts so they re-seed from it,
            // exactly as the old checkboxes re-rendered with the new template's `checked` state.
            uniformSelectedId = Number(raw);
            uniformFlagDraft = null; uitemDrafts = {};
            renderSquadsPanel(); return;
          case "uitemSubtype": {                             // was .squad-uitem-subtype
            const cat = Number(slice.dataset.ucat);
            uitemDrafts[cat] = Object.assign({}, uitemDrafts[cat], { subtype: Number(raw) });
            renderSquadsPanel(); return;
          }
          case "uitemMat": {                                 // was .squad-uitem-mat
            const cat = Number(slice.dataset.ucat);
            uitemDrafts[cat] = Object.assign({}, uitemDrafts[cat], { matclass: Number(raw) });
            renderSquadsPanel(); return;
          }
          case "ammoType":                                   // was #squadAmmoType
            ammoAddDraft = Object.assign({}, ammoAddDraft, { subtype: Number(raw) });
            renderSquadsPanel(); return;
          case "ammoMat":                                    // was #squadAmmoMat
            ammoAddDraft = Object.assign({}, ammoAddDraft, { matclass: Number(raw) });
            renderSquadsPanel(); return;
          case "trainMonth":                                 // 0081 R22: -1 is the all-months sentinel
            trainingSel = { routine: trainingSel.routine, month: Number(raw) };
            renderSquadsPanel(); return;
          case "equipPos":                                   // was #equipmentPositionSelect
            setEquipmentPosition(squad && squad.id, Number(raw) || 0); equipmentPicker = null;
            renderSquadsPanel(); return;
          case "routine": {                                  // was #squadRoutineSelect (posts on change)
            if (!squad) return;
            try {
              await window.squadSchedulePost({ squad: squad.id, action: "set-routine", routine: Number(raw) });
              squadStatusMsg = "Active routine changed.";
            } catch (err) { squadStatusMsg = err.message || "Could not change routine."; }
            await loadSquadDetail(squad.id); return;
          }
          default: return;
        }
      });
    });
  }

  function wireStepperTiles() {
    clientPanel.querySelectorAll("[data-sq-step]").forEach(tile => {
      tile.addEventListener("click", event => {
        event.stopPropagation();
        const host = tile.closest(".dwfui-stepper");
        const input = host && host.querySelector("input");
        if (!input) return;
        const delta = Number(tile.dataset.sqStep) || 0;
        if (!delta) { input.focus(); input.select(); return; }      // the '#' enter-amount tile
        const min = Number(input.min), max = Number(input.max);
        let next = (Number(input.value) || 0) + delta;
        if (Number.isFinite(min)) next = Math.max(min, next);
        if (Number.isFinite(max)) next = Math.min(max, next);
        input.value = String(next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
  }

  // --- squad orders (move/kill/train/cancel) ---
  const squadMoveArmedFor = { id: -1 };
  const squadKillArmedFor = { id: -1, targets: [] };

  // The ticked roster subset, held per squad id so switching squads cannot leak a stale selection.
  const squadMemberSel = { id: -1, picks: new Set() };
  function squadMemberPicks(squadId) {
    return squadMemberSel.id === Number(squadId) ? squadMemberSel.picks : new Set();
  }
  function squadMemberToggle(squadId, idx) {
    if (squadMemberSel.id !== Number(squadId)) {
      squadMemberSel.id = Number(squadId);
      squadMemberSel.picks = new Set();
    }
    const key = Number(idx);
    if (squadMemberSel.picks.has(key)) squadMemberSel.picks.delete(key);
    else squadMemberSel.picks.add(key);
  }
  function squadMemberClear() { squadMemberSel.id = -1; squadMemberSel.picks = new Set(); }
  // The CSV the server parses into position indices; empty means the whole squad.
  function squadMemberParam(squadId) {
    return [...squadMemberPicks(squadId)].sort((a, b) => a - b).join(",");
  }

  // The one chokepoint for every /squad-order POST: member targeting is appended here, never per call site.
  async function squadOrderPost(params) {
    const members = squadMemberParam(params && params.squad);
    const full = Object.assign({ player }, params);
    if (members) full.members = members;
    const q = new URLSearchParams(full).toString();
    return squadFetchJson(`/squad-order?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireSquadOrderControls(squad) {
    const moveBtn = clientPanel.querySelector("#squadOrderMoveBtn");
    if (moveBtn) {
      moveBtn.addEventListener("click", () => {
        if (squadMoveArmedFor.id === squad.id) {
          squadMoveArmedFor.id = -1;
          if (window.DFSquadMove) window.DFSquadMove.disarm();
          renderSquadsPanel();
          return;
        }
        squadMoveArmedFor.id = squad.id;
        if (window.DFSquadMove) {
          window.DFSquadMove.onResult = (ok, data) => {
            squadMoveArmedFor.id = -1;
            squadStatusMsg = ok ? "Station order issued." : ((data && data.error) || "Station order failed.");
            refreshSquads();
          };
          window.DFSquadMove.onDisarmed = () => { squadMoveArmedFor.id = -1; renderSquadsPanel(); };
          // Ledger 0055: the station order is issued by the map-click handler, so the ticked
          // subset has to travel with the arm call rather than through squadOrderPost.
          window.DFSquadMove.arm(squad.id, squadMemberParam(squad.id));
        }
        renderSquadsPanel();
      });
    }
    // Armed-station Cancel (the strip is hidden while armed, so the move tile cannot disarm it).
    clientPanel.querySelector("#squadOrderMoveCancelBtn")?.addEventListener("click", () => {
      squadMoveArmedFor.id = -1;
      if (window.DFSquadMove) window.DFSquadMove.disarm();
      renderSquadsPanel();
    });
    clientPanel.querySelector("#squadOrderTrainBtn")?.addEventListener("click", async () => {
      try {
        await squadOrderPost({ squad: squad.id, action: "train" });
        squadStatusMsg = "Train order issued.";
      } catch (err) { squadStatusMsg = err.message || "Train order failed."; }
      await refreshSquads();
    });
    clientPanel.querySelector("#squadOrderKillBtn")?.addEventListener("click", async () => {
      // First press arms multi-select; subsequent presses (while armed) Confirm the marked set.
      if (squadKillArmedFor.id !== squad.id) {
        squadKillArmedFor.id = squad.id;
        squadKillArmedFor.targets = [];
        if (window.DFSquadKill) {
          window.DFSquadKill.onTarget = (target, data) => {
            squadKillArmedFor.id = squad.id;
            const id = Number(target);
            if (!(id >= 0)) return;
            const name = (data && data.unit && (data.unit.name || data.unit.readableName)) || null;
            const tile = data && data.tile;
            const pos = tile && [tile.x, tile.y, tile.z].every(Number.isFinite)
              ? { x: Number(tile.x), y: Number(tile.y), z: Number(tile.z) } : null;
            const at = squadKillArmedFor.targets.findIndex(t => t.id === id);
            if (at >= 0) squadKillArmedFor.targets.splice(at, 1);   // click again to unmark
            else squadKillArmedFor.targets.push({ id, name, pos });
            squadStatusMsg = squadKillArmedFor.targets.length
              ? `${squadKillArmedFor.targets.length} target${squadKillArmedFor.targets.length === 1 ? "" : "s"} marked. Confirm to send.`
              : "No targets marked.";
            renderSquadsPanel();
          };
          window.DFSquadKill.onDisarmed = () => {
            squadKillArmedFor.id = -1;
            squadKillArmedFor.targets = [];
            renderSquadsPanel();
          };
          window.DFSquadKill.onFailed = message => {
            squadKillArmedFor.id = squad.id;
            squadStatusMsg = message || "Select a unit on the map.";
            window.DFSquadKill.arm(squad.id);
            renderSquadsPanel();
          };
          window.DFSquadKill.arm(squad.id);
        }
        renderSquadsPanel();
        return;
      }
      const targets = squadKillArmedFor.targets.map(t => t.id).filter(id => id >= 0);
      if (!targets.length) return;
      try {
        await squadOrderPost({ squad: squad.id, action: "kill", targets: targets.join(",") });
        squadStatusMsg = targets.length === 1 ? "Kill order issued." : `Kill order issued (${targets.length} targets).`;
      } catch (err) { squadStatusMsg = err.message || "Kill order failed."; }
      squadKillArmedFor.id = -1;
      squadKillArmedFor.targets = [];
      if (window.DFSquadKill) window.DFSquadKill.disarm();
      await refreshSquads();
    });
    clientPanel.querySelector("#squadOrderKillCancelBtn")?.addEventListener("click", () => {
      squadKillArmedFor.id = -1;
      squadKillArmedFor.targets = [];
      squadStatusMsg = "";
      if (window.DFSquadKill) window.DFSquadKill.disarm();
      renderSquadsPanel();
    });
    // Click a marked chip to unmark that single target (keeps the flow armed).
    clientPanel.querySelectorAll("[data-kill-unmark]").forEach(el => {
      el.addEventListener("click", () => {
        const id = Number(el.dataset.killUnmark);
        const at = squadKillArmedFor.targets.findIndex(t => t.id === id);
        if (at >= 0) squadKillArmedFor.targets.splice(at, 1);
        renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#squadOrderCancelAllBtn")?.addEventListener("click", async () => {
      try {
        await squadOrderPost({ squad: squad.id, action: "cancel", all: 1 });
        squadStatusMsg = "Orders cancelled.";
      } catch (err) { squadStatusMsg = err.message || "Cancel failed."; }
      await refreshSquads();
    });
    // Defend-burrow -> open the burrow checklist screen (native 2.4). Loads /burrows lazily,
    // then paints once (avoids flashing the "unavailable" state while the fetch is in flight).
    clientPanel.querySelector("#squadOrderBurrowBtn")?.addEventListener("click", async () => {
      squadStatusMsg = "";
      await window.squadLoadBurrows();
      squadView = "burrow";
      renderSquadsPanel();
    });
    clientPanel.querySelector("#squadOrderPatrolBtn")?.addEventListener("click", () => {
      squadPatrolDraft = { name: "Route 1", points: [] };
      squadStatusMsg = "";
      squadView = "patrol";
      renderSquadsPanel();
    });
    clientPanel.querySelectorAll("[data-squad-order-cancel]").forEach(b => {
      b.addEventListener("click", async () => {
        try {
          await squadOrderPost({ squad: squad.id, action: "cancel", index: Number(b.dataset.squadOrderCancel) });
          squadStatusMsg = "Order cancelled.";
        } catch (err) { squadStatusMsg = err.message || "Cancel failed."; }
        await refreshSquads();
      });
    });
  }

  // --- squad-level mutations (create/rename/delete/assign/remove) ---

  async function squadCreate(positionAssignmentId, uniformId = -1) {
    try {
      let url = `/squad-create?player=${encodeURIComponent(player)}`;
      if (Number.isFinite(positionAssignmentId) && positionAssignmentId >= 0) {
        url += `&position=${encodeURIComponent(positionAssignmentId)}`;
      }
      if (Number.isFinite(uniformId) && uniformId >= 0) {
        url += `&uniform=${encodeURIComponent(uniformId)}`;
      }
      url += `&t=${Date.now()}`;
      const data = await squadFetchJson(url, { method: "POST" });
      if (data && typeof data.id === "number") squadSelectedId = data.id;
      squadStatusMsg = "Squad created.";
      createPending = null;
      squadView = "positions";
      await refreshSquads();
    } catch (err) {
      squadStatusMsg = err.message || "Could not create squad.";
      renderSquadsPanel();
    }
  }

  async function squadCreateNewPosition(positionId, uniformId = -1) {
    try {
      const data = await squadFetchJson(
        `/position-create?player=${encodeURIComponent(player)}&position=${encodeURIComponent(positionId)}&t=${Date.now()}`,
        { method: "POST" });
      const assignmentId = Number(data && data.assignmentId);
      if (!Number.isFinite(assignmentId) || assignmentId < 0)
        throw new Error("the new position did not come back with an id");
      await squadCreate(assignmentId, uniformId);
    } catch (err) {
      squadStatusMsg = err.message || "Could not create the position.";
      renderSquadsPanel();
    }
  }

  async function squadRename(id, name) {
    if (id < 0) return;
    try {
      await squadFetchJson(`/squad-rename?player=${encodeURIComponent(player)}&id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}&t=${Date.now()}`, { method: "POST" });
      squadStatusMsg = "Squad renamed.";
      await refreshSquads();
    } catch (err) {
      squadStatusMsg = err.message || "Could not rename squad.";
      renderSquadsPanel();
    }
  }

  async function squadDelete(id) {
    if (id < 0) return;
    // Disband is open to every authenticated player (owner policy); server is the gate.
    try {
      await squadFetchJson(`/squad-delete?player=${encodeURIComponent(player)}&squad=${encodeURIComponent(id)}&t=${Date.now()}`, { method: "POST" });
      squadStatusMsg = "Squad disbanded.";
      squadSelectedId = -1;
      squadView = "list";
      await refreshSquads();
    } catch (err) {
      squadStatusMsg = err.message || "Could not disband squad.";
      renderSquadsPanel();
    }
  }

  async function squadAssign(squadId, unitId, pos) {
    if (squadId < 0 || unitId < 0) return;
    // slot 0 carries the commander appointment (noble records), and it is assigned like any
    // other slot -- no client-side lock.
    try {
      let url = `/squad-assign?player=${encodeURIComponent(player)}&squad=${encodeURIComponent(squadId)}&unit=${encodeURIComponent(unitId)}`;
      if (Number.isFinite(pos) && pos >= 0) url += `&pos=${encodeURIComponent(pos)}`;
      url += `&t=${Date.now()}`;
      await squadFetchJson(url, { method: "POST" });
      squadStatusMsg = "Member assigned.";
      squadView = "positions";
      await loadSquadDetail(squadId);
    } catch (err) {
      squadStatusMsg = err.message || "Could not assign member.";
      renderSquadsPanel();
    }
  }

  async function squadRemove(unitId) {
    if (!(unitId >= 0)) return;
    try {
      await squadFetchJson(`/squad-remove?player=${encodeURIComponent(player)}&unit=${encodeURIComponent(unitId)}&t=${Date.now()}`, { method: "POST" });
      squadStatusMsg = "Member removed.";
      squadView = "positions";
      await loadSquadDetail(squadSelectedId);
    } catch (err) {
      squadStatusMsg = err.message || "Could not remove member.";
      renderSquadsPanel();
    }
  }

  // Fixture-test surface: the pure view builders (no DOM, no module state, no server). See
  // tools/harness/squads_view_fixture_test.mjs. Guarded so the browser <script> load is a no-op.
  if (typeof window !== "undefined") {
    window.DFSquadMarkup = {
      buildSquadPanel, sqListRows, sqOrdersSummaryLine, sqOrderLine, sqEmblemSwatch, sqOrderToolbar,
      sqPositionsView: window.sqPositionsView, sqPositionRows: window.sqPositionRows, sqCandidateRows: window.sqCandidateRows, sqCandidateView: window.sqCandidateView, sqCandidateSortedRows: window.sqCandidateSortedRows,
      sqCreateView, sqCreateUniformView, sqEquipView: window.sqEquipView,
      sqUniformAssignRows: window.sqUniformAssignRows, sqUniformEditor: window.sqUniformEditor, sqAmmoSection: window.sqAmmoSection, sqScheduleView: window.sqScheduleView, sqBackHeader: window.sqBackHeader,
      sqEmblemView: window.sqEmblemView, sqBurrowDefendView: window.sqBurrowDefendView, sqPatrolView: window.sqPatrolView, sqRoutinesView: window.sqRoutinesView, sqMonthlyView: window.sqMonthlyView, sqTrainingView: window.sqTrainingView,
      sqSuppliesSection: window.sqSuppliesSection, sqEquipmentDetails: window.sqEquipmentDetails, sqEquipmentPickerView: window.sqEquipmentPickerView, EQUIP_TABS: window.EQUIP_TABS, EQUIP_VIEWS: window.EQUIP_VIEWS,
    };
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      buildSquadPanel, sqListRows, sqOrdersSummaryLine, sqOrderLine, sqEmblemSwatch, sqOrderToolbar,
      sqPositionsView: window.sqPositionsView, sqPositionRows: window.sqPositionRows, sqCandidateRows: window.sqCandidateRows, sqCandidateView: window.sqCandidateView, sqCandidateSortedRows: window.sqCandidateSortedRows,
      sqCreateView, sqCreateUniformView, sqEquipView: window.sqEquipView, sqUniformAssignRows: window.sqUniformAssignRows, sqUniformEditor: window.sqUniformEditor,
      sqAmmoSection: window.sqAmmoSection, sqScheduleView: window.sqScheduleView, sqMaterialClassOptions: window.sqMaterialClassOptions, sqBackHeader: window.sqBackHeader, EQUIP_TABS: window.EQUIP_TABS, EQUIP_VIEWS: window.EQUIP_VIEWS, sqRootPane,
      sqRootListRows, sqFitRootList,
      sqEmblemView: window.sqEmblemView, sqBurrowDefendView: window.sqBurrowDefendView, sqPatrolView: window.sqPatrolView, sqRgbToHex, SQUAD_SYMBOL_COUNT, sqEmblemUnassigned,
      sqSuppliesSection: window.sqSuppliesSection, sqEquipmentDetails: window.sqEquipmentDetails, sqEquipmentPickerView: window.sqEquipmentPickerView, sqRoutinesView: window.sqRoutinesView, sqMonthlyView: window.sqMonthlyView, sqTrainingView: window.sqTrainingView,
    };
  }

  window.sqListHtml = sqListHtml;
  window.sqOrderToolbar = sqOrderToolbar;
  window.sqUnitPortrait = sqUnitPortrait;
  window.sqProfessionColorStyle = sqProfessionColorStyle;
  window.sqOrderLine = sqOrderLine;
  window.setEquipmentPosition = setEquipmentPosition;
  window.equipmentMemberFor = equipmentMemberFor;
  window.squadSetStatus = squadSetStatus;
  window.squadFetchJson = squadFetchJson;
  window.loadSquadDetail = loadSquadDetail;
  window.loadUniformCatalog = loadUniformCatalog;
  window.sqCyclerHtml = sqCyclerHtml;
  window.sqStepperHtml = sqStepperHtml;
  window.sqEquipmentStrip = sqEquipmentStrip;
  window.sqEmblemSwatch = sqEmblemSwatch;
  window.sqWithId = sqWithId;
  window.renderSquadsPanel = renderSquadsPanel;
  window.goToView = goToView;
  window.refreshSquads = refreshSquads;
  window.sqEmblemUnassigned = sqEmblemUnassigned;
  window.sqRgbToHex = sqRgbToHex;
  window.sqRootPane = sqRootPane;
  window.squadOrderPost = squadOrderPost;

  window.DFSquadController = window.DFSquadController || {};
  Object.defineProperties(window.DFSquadController, {
    squadDetail: { get: () => squadDetail, set: value => { squadDetail = value; } },
    squadSelectedId: { get: () => squadSelectedId, set: value => { squadSelectedId = value; } },
    squadStatusMsg: { get: () => squadStatusMsg, set: value => { squadStatusMsg = value; } },
    uniformCatalog: { get: () => uniformCatalog, set: value => { uniformCatalog = value; } },
    uniformSelectedId: { get: () => uniformSelectedId, set: value => { uniformSelectedId = value; } },
    squadView: { get: () => squadView, set: value => { squadView = value; } },
    equipTab: { get: () => equipTab, set: value => { equipTab = value; } },
    squadBurrows: { get: () => squadBurrows, set: value => { squadBurrows = value; } },
    emblemDraft: { get: () => emblemDraft, set: value => { emblemDraft = value; } },
    trainingSel: { get: () => trainingSel, set: value => { trainingSel = value; } },
    scheduleClipboard: { get: () => scheduleClipboard, set: value => { scheduleClipboard = value; } },
    squadPatrolDraft: { get: () => squadPatrolDraft, set: value => { squadPatrolDraft = value; } },
    equipmentPicker: { get: () => equipmentPicker, set: value => { equipmentPicker = value; } },
    uniformPick: { get: () => uniformPick, set: value => { uniformPick = value; } },
    uitemDrafts: { get: () => uitemDrafts, set: value => { uitemDrafts = value; } },
    ammoAddDraft: { get: () => ammoAddDraft, set: value => { ammoAddDraft = value; } },
    ammoRowDrafts: { get: () => ammoRowDrafts, set: value => { ammoRowDrafts = value; } },
    uniformFlagDraft: { get: () => uniformFlagDraft, set: value => { uniformFlagDraft = value; } },
    burrowChecked: { get: () => burrowChecked, set: value => { burrowChecked = value; } },
    trainDraft: { get: () => trainDraft, set: value => { trainDraft = value; } },
    squadMoveArmedFor: { get: () => squadMoveArmedFor },
    squadKillArmedFor: { get: () => squadKillArmedFor }
  });


  window.sqEsc = sqEsc;
