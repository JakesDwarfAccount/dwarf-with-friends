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

  // WS3.2 Military / squads panel. Reads /squads (list) + /squad?id= (detail);
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function") DWFUI.require("squads", [
    "artBtnHtml", "checkHtml", "cyclerHtml", "iconHtml", "modalHtml", "plaqueBtnHtml", "rawHtml", "rowHtml",
    "scrollHtml", "searchHtml", "segmentedHtml", "sortHeaderHtml", "stepperHtml", "textInputHtml", "TOKENS",
  ]);
  // mutates via /squad-create, /squad-rename, /squad-assign, /squad-remove, /squad-delete,
  // /squad-order, /squad-schedule, /squad-uniform, /squad-ammo, /uniforms + /uniform-*.
  //
  // B60 (2026-07-09-squad-ui-parity-spec.md): the prior client crammed the entire per-squad
  // detail (Positions + Orders + Schedule + Ammunition + Uniform-template editor) into DF's
  // narrow 208px full-height RIGHT sidebar, so the multi-column editor grids overflowed and
  // overlapped ("box way too thin, components overlap"). Native does NOT cram: it is
  // screen-per-screen -- the sidebar root shows only a squad LIST + (when selected) an order
  // toolbar + Equip/Schedule buttons; Positions, Equip and Schedule each open as their own
  // WIDER screen with a "Back to squads" header. This module mirrors that navigation model.
  //
  // squadView selects which screen renders:
  //   list       -- root sidebar: squad list + (selected squad) order toolbar + Equip/Schedule
  //   positions  -- narrow position roster (native screen 4)
  //   candidate  -- wide dedicated candidate selector for one exact position (native screen 4.1)
  //   equip      -- wide: sub-tabs [Assign uniform | Add uniform | Ammo] (native 5/5.1/5.2/5.3)
  //   schedule   -- wide: routine picker + 12-month sleep/uniform grid (native screen 7)
  //   emblem     -- wide: symbol grid + fg/bg colour pickers (native screen 3) -- only reachable
  //                 when /squads carries the additive `emblem` object (graceful on old DLLs)
  //   create     -- choose the native leader/position category (native 8 step 1)
  //   create-uniform -- choose the new squad's uniform (native 8 step 2)
  //   burrow     -- wide: burrow checklist for a defend-burrow order (native screen 2.4)
  //   patrol     -- wide: route name + map-click waypoint editor (native screen 2.3)
  // squads-client2 (2026-07-09-cpp-batch-notes.md): the server now serves an additive
  //   emblem:{symbol,fg{r,g,b},bg{r,g,b}} per squad and accepts POST /squad-emblem +
  //   /squad-order action=defend-burrow&burrows=<csv> and patrol&points=x:y:z;... .
  // Absent additive fields on an older DLL degrade to labelled empty states rather than errors.

  let squadsList = null;        // last /squads payload
  let squadDetail = null;       // last /squad?id= payload
  let squadSelectedId = -1;     // currently selected squad id
  let squadStatusMsg = "";      // transient status/error line
  let uniformCatalog = null;    // GET /uniforms (fort-wide template authoring catalog)
  let uniformSelectedId = -1;   // currently edited uniform template id (Add-uniform tab)
  let squadView = "list";       // list | create | create-uniform | positions | candidate | equip | schedule | ...
  let equipTab = "uniform";     // uniform | add | ammo | supplies (within the equip screen)
  let squadBurrows = null;      // GET /burrows list, loaded lazily for the defend-burrow picker
  let emblemDraft = null;       // in-progress emblem edit {symbol,fg{r,g,b},bg{r,g,b}} (client-side)
  let trainingSel = { routine: -1, month: -1 }; // 7.3 Edit Training: which routine+month is open
  let squadPatrolDraft = { name: "Route 1", points: [] }; // native 2.3, world-coordinate points
  let equipmentPosition = 0;    // native 5.5: selected squad position
  let equipmentPicker = null;   // {kind:"material"|"color",cat,index}

  // ---- WAVE 5 / GATE C: DRAFT STATE ------------------------------------------------------------
  // The DWFUI controls are STATELESS MARKUP by contract (they are strings; the DOM half only paints
  // them). A native cycler/segment/check therefore cannot hold an in-progress edit the way a DOM
  // `select`/`checkbox` DOM controls did -- the value has to live in the module and be re-rendered.
  // Every field below is EXACTLY the value the old DOM control held, read at exactly the same
  // moment by exactly the same POST. No new semantics: the drafts are where the browser used to
  // keep the half-typed form, made explicit. Each seeds itself from the SERVED value on first
  // paint, so a fresh screen reads identically to the old one.
  let squadCandidatePos = -1;   // candidate screen: the exact native SQUAD_FILL_POSITION index
  let squadCandidateSort = "suitability"; // DF-sourced military-skill order; never labelled as a score
  let squadCandidateSortDirection = 1;
  let squadCandidateSearch = "";
  let createPending = null;     // create step 1 choice, consumed only after uniform step 2
  let uniformPick = {};         // equip/uniform: posIdx -> template id (was .sq-uniform-select)
  let uitemDrafts = {};         // equip/add: cat -> {subtype,matclass,color,choice} (was .sq-uitem-*)
  let ammoAddDraft = null;      // equip/ammo: the add row (was #squadAmmoType/Amount/Mat/Combat/Training)
  let ammoRowDrafts = {};       // equip/ammo: index -> {amount,combat,training} (was the row's inputs)
  let uniformFlagDraft = null;  // equip/add: {replaceClothing,exactMatches} (was the two checkboxes)
  let burrowChecked = null;     // burrow: Set of checked burrow ids (was .sq-burrow-check)
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

  function squadSetStatus(msg) {
    squadStatusMsg = msg || "";
    const el = document.getElementById("squadStatus");
    if (el) {
      el.textContent = squadStatusMsg;
      el.style.display = squadStatusMsg ? "block" : "none";
    }
  }

  async function squadFetchJson(url, opts) {
    const response = await fetch(url, Object.assign({ cache: "no-store" }, opts || {}));
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || (data && data.ok === false)) {
      const msg = (data && data.error) || ("request failed (" + response.status + ")");
      throw new Error(msg);
    }
    return data || {};
  }

  // WD-23: squads is DF's full-height RIGHT sidebar, not a centered modal. Closes via the same
  // q hotkey / toolbar button or Esc (the generic "clientPanel visible" Escape handler covers
  // it since this still IS clientPanel, just a different chrome class).
  async function openSquadsPanel() {
    setActiveToolbar("squads");
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    squadStatusMsg = "";
    squadView = "list";
    clientPanel.className = "visible squads-sidebar";
    panelContent(clientPanel).innerHTML = `<div class="info-window"><div class="info-body"><div class="info-message">Loading squads...</div></div></div>`;
    try {
      await loadUniformCatalog();
      await refreshSquads();
    } catch (_) {
      clientPanel.className = "visible squads-sidebar";
      panelContent(clientPanel).innerHTML = `<div class="info-window"><div class="info-body"><div class="info-message">Squad data unavailable.</div></div></div>`;
    }
  }

  async function refreshSquads() {
    const data = await squadFetchJson(`/squads?player=${encodeURIComponent(player)}&t=${Date.now()}`);
    squadsList = data;
    const squads = Array.isArray(data.squads) ? data.squads : [];
    // PB-05 / R1: native opens the squad list with NOTHING selected -- no order strip, no
    // Equip/Schedule/trash, just the hint line. The client used to auto-select squads[0], so the
    // unselected half of the pair was UNREACHABLE. A selection that no longer exists still clears.
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
    } catch (_) {
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
    } catch (_) {
      uniformCatalog = null;
    }
  }

  // ===========================================================================
  // PURE VIEW BUILDERS  (data in, HTML string out -- exported for fixture tests)
  // Every builder takes an explicit `esc` (defaulting to sqEsc) and never touches
  // module-scoped state or the DOM, so the offline harness can seed payloads.
  // ===========================================================================

  // DF squad emblem symbols are indices 0..22 into the graphics-mode tileset (df.squad.xml
  // symbol_index). The tileset sprites live behind the off-limits renderer/atlas files, so we
  // render a best-effort UNICODE stand-in per index (row-wise to match native screen 3's grid).
  // These approximate the shapes; TRUE tileset-sprite rendering is a documented handoff. Out of
  // range -> the squad initial. The two emblem COLOURS are always applied faithfully.
  const SQUAD_SYMBOL_GLYPHS = [
    "●", "■", "◆", "✚", "⇕", "∩", "★", "♥", // 0-7
    "◫", "≣", "◣", "┐", "▨", "↑", "⧖", "═", // 8-15
    "⫴", "◉", "⁙", "≈", "♠", "▲", "Ω",            // 16-22
  ];

  // Clamp {r,g,b} -> "rgb(r,g,b)". Tolerant of missing / out-of-range channels (old DLL safety).
  function sqRgbCss(c) {
    const n = v => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
    return `rgb(${n(c && c.r)},${n(c && c.g)},${n(c && c.b)})`;
  }
  // Clamp {r,g,b} -> "#rrggbb" for <input type="color"> value binding.
  function sqRgbToHex(c) {
    const n = v => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
    const h = v => n(v).toString(16).padStart(2, "0");
    return `#${h(c && c.r)}${h(c && c.g)}${h(c && c.b)}`;
  }

  // ===========================================================================
  // WAVE 5 / GATE C -- THE NATIVE CONTROL VOCABULARY (pure; no DOM, no state)
  // ===========================================================================
  //
  // *** NATIVE DF HAS NO DROPDOWN (`select`) IN ANY OF THE 36 SQUAD CAPTURES. *** Every choice there is a
  // plaque, a row, a CYCLER (`< value >`), or a chooser screen. This file shipped 14 of them.
  //
  // sqCyclerHtml is native's dropdown: DWFUI.cyclerHtml's three-slice TYPE_FILTER_{LEFT,TEXT,RIGHT}
  // composition. It is rendered PURE -- the prev/next VALUES are computed at build time and carried
  // on the slices as `data-sq-cyc` (which chooser) + `data-sq-val` (the value to jump to), so the
  // builder needs no registry, no module state and no DOM read, and the fixture harness can drive
  // it with a seeded model exactly like the old `select`. An EMPTY option set renders the cycler
  // with its "(none)" label and NO value on either slice -- the click handler no-ops -- which is the
  // native shape of a disabled chooser (an absent cell renders nothing; it does not blank).
  // `options` is [[value, label], ...]; `current` is the selected VALUE (compared as a string).
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

  // Native's numeric control: `value [#][+][-]` with the three gold WORK_ORDERS_* sprite tiles and a
  // BORDERLESS value cell (F8/PB-10). The `<input type=number>` inside is the DELIBERATE editable
  // exception -- it keeps its old class so its CSS and its readers are untouched -- and the tiles
  // carry `data-sq-step` (-1 / +1 / 0 = focus-and-select), wired once in wireStepperTiles().
  function sqStepperHtml(cfg) {
    return DWFUI.stepperHtml(Object.assign({}, cfg, {
      art: true, hash: true,
      minusDataset: { sqStep: -1 }, plusDataset: { sqStep: 1 }, hashDataset: { sqStep: 0 },
    }));
  }

  // ---- THE 33 SQUADS_EQUIPMENT_* SPRITES: 11 slots x 3 states, ALL present in interface_map.json,
  // ALL registered in TOKENS.sprites since Wave 4, and ALL WITH ZERO CONSUMERS until now. Native's
  // equip screen (`Squad Menu UI/5. Equip Squad Menu.PNG`) draws one slot tile per member row --
  // GREEN when the dwarf has the item, RED-with-`!` when the requirement is unfilled. We rendered
  // `"${m.uniformItems} items"` as PLAIN TEXT. This is the largest paid-for-but-unused art in the
  // program, and it is wired here.
  //
  // *** THE STATE IS SERVED, NOT INVENTED. *** `uniformDetails[].assignedCount` is
  // `spec->assigned.size()` (src/squads.cpp:697) -- the number of REAL ITEMS DF has matched to that
  // uniform requirement. `>= 1` means the dwarf has it (GOOD); `0` means the requirement stands
  // unfilled (MISSING). That is exactly what native's green/red pair says.
  //
  // *** THE THIRD STATE IS NOT DERIVABLE AND IS THEREFORE NEVER EMITTED. *** `_WARNING` (native's
  // amber "assigned but not carried / wrong material") has no field behind it in anything the server
  // sends. Painting it from a guess is precisely the substitution the rules forbid, so the amber
  // tile stays unused and is reported as a SERVER-DATA GAP.
  //
  // Four of the eleven slots (AMMO, QUIVER, BACKPACK, FLASK) have no `uniform_category` in DF's
  // per-position uniform at all, so they have no row to render on and stay unused -- an ABSENT cell
  // renders NOTHING (native omits; it does not blank).
  const UNIFORM_CAT_SLOT = { 0: "Armor", 1: "Helmet", 2: "Pants", 3: "Gloves", 4: "Shoes",
    5: "Shield", 6: "Weapon" };
  function sqEquipmentStrip(member) {
    const details = Array.isArray(member && member.uniformDetails) ? member.uniformDetails : [];
    const tiles = details.map(item => {
      const slot = UNIFORM_CAT_SLOT[Number(item.cat)];
      if (!slot) return "";
      const good = (Number(item.assignedCount) || 0) > 0;
      const sprite = DWFUI.TOKENS.sprites[`squadsEquip${slot}${good ? "Good" : "Missing"}`];
      if (!sprite) return "";
      const label = (UNIFORM_CATS.find(c => c[0] === Number(item.cat)) || [0, slot])[1];
      return DWFUI.iconHtml({
        sprite, nativeCell: true, cls: "sq-equip-slot",
        alt: `${label}: ${good ? "assigned" : "missing"}`,
        title: `${label} -- ${good ? `${item.assignedCount} item(s) assigned` : "MISSING (no item assigned)"}`,
      });
    }).filter(Boolean).join("");
    return tiles;
  }

  // Emblem: when /squads serves the additive `emblem` object we render a faithful TWO-COLOUR
  // badge (bg colour + fg-coloured symbol glyph) and make it a click target that opens the
  // emblem edit screen (native 3). When `emblem` is ABSENT (old DLL) we fall back to the prior
  // deterministic placeholder swatch, which is a plain <span> with NO edit entry -- so the row
  // still reads as "this squad's badge" and native list order (emblem is column 1) is preserved.
  function sqEmblemSwatch(squad, esc = sqEsc) {
    const label = squad.alias || squad.name || ("Squad " + squad.id);
    const initial = esc((label.trim()[0] || "?").toUpperCase());
    const emblem = squad && squad.emblem;
    if (emblem && emblem.fg && emblem.bg) {
      const sym = Number(emblem.symbol);
      const glyph = (sym >= 0 && sym < SQUAD_SYMBOL_GLYPHS.length)
        ? esc(SQUAD_SYMBOL_GLYPHS[sym]) : initial;
      return `<button class="sq-emblem sq-emblem-btn" data-squad-emblem="${squad.id}" style="background:${sqRgbCss(emblem.bg)};color:${sqRgbCss(emblem.fg)};cursor:pointer;padding:0" title="Change squad emblem">${glyph}</button>`;
    }
    const hue = ((Number(squad.id) || 0) * 47) % 360;
    return `<span class="sq-emblem" style="background:hsl(${hue},55%,32%)" title="Squad emblem (change unavailable — this build serves no emblem data)">${initial}</span>`;
  }

  function sqOrdersSummary(squad) {
    const orders = Array.isArray(squad && squad.orders) ? squad.orders : [];
    if (!orders.length) return "No special orders";
    return orders.map(o => String(o.description || o.type || "order")).join(", ");
  }

  // Native squad-list row (R1 unselected / R2+R3 selected, Wave 4 S2). The row is the `table`
  // chassis -- flat, hatched, hairline-separated -- and *** SELECTION DOES NOT REPAINT THE ROW ***:
  // native draws no outline, no bracket and no fill change on a selected squad. The GREEN CHECK
  // TILE **IS** the affordance (S2-squads-evidence CORRECTION-2), so no `selected`/`state` is
  // passed to rowHtml (either would add a gold rect / a red-green slab that native does not have).
  //
  // ---- WAVE 4 S2 / DEFECT S1: THE ROW IS **TWO BANDS**, NOT ONE FLEX LINE. --------------------
  // The owner: "the rows are collapsed". Measured: our row was 19px tall; native's pitch is ~126px, and the
  // card was a sliver of row over empty black. `1. Squad Menu.PNG`:
  //   band 1 (control strip)  [emblem][leader portrait][positions][quill GOLD] --- spacer --- [check]
  //   band 2 (copy block)     name (bright white) / order (grey; ORANGE when active) / Routine:<name>
  // `.dwfui-row--table` is ONE flex line, so the copy sat BESIDE the tiles and the row collapsed to
  // the tallest tile. The Foundation shipped `rowHtml({chassis, stacked:true})` -- flex-wrap +
  // `.dwfui-copy{order:2;flex:1 0 100%}` + `min-height:126px` -- for exactly this row, AFTER this
  // file had already shipped, so it was never adopted. It is adopted here. No squads-local CSS.
  //
  // *** copyCls / labelCls / sub.cls ARE DELIBERATELY NOT PASSED. *** (DEFECT S3, and the root
  // cause of it.) rowHtml's `copyCls` REPLACES `.dwfui-copy` instead of adding to it, so passing
  // `sq-item-main` silently dropped the chassis's `flex:1 1 auto` -- which is why the select
  // checkbox landed wherever the squad name happened to end instead of in native's fixed
  // x=312..355 column -- and it would ALSO drop `.dwfui-row--stacked > .dwfui-copy`'s band-2 rules.
  // The chassis pins the row's LAST cell right (`:last-child:not(.dwfui-copy)`); the check IS that
  // cell. The line COLOURS come from `sub` tones (`--dwfui-text-*`), never a squads-local hex.
  //
  // The leader PORTRAIT (native band-1 cell 2) is not renderable here: GET /squads serves no
  // portraitTexpos for a squad's leader (only GET /squad?id= does, per member). Inventing a glyph
  // for it would be exactly the substitution the rules forbid, so the cell is OMITTED and logged as
  // a SERVER-DATA GAP in the closeout rather than faked.
  //
  // Control band: [emblem][positions tile][rename quill] ... [select check]. Every tile is a real
  // self-framed DF sprite (SQUADS_POSITIONS / UNIT_SHEET_CUSTOMIZE / SQUADS_{,NOT_}SELECTED) --
  // the chess pawn and the tri-state mark are gone. The quill is THE rename affordance (S5): it
  // focuses the free-text rename field, which is the client's ONLY rename path (2026-07-12).
  function sqListRows(squads, selectedId, esc = sqEsc) {
    if (!Array.isArray(squads) || !squads.length) {
      return `<div class="info-message">No squads yet.</div>`;
    }
    return squads.map(s => {
      const label = s.alias || s.name || ("Squad " + s.id);
      const selected = s.id === selectedId;
      const hasOrder = Array.isArray(s.orders) && s.orders.length > 0;
      const icons = `<span class="sq-item-icons">${sqEmblemSwatch(s, esc)}` +
        DWFUI.artBtnHtml({
          sprite: DWFUI.TOKENS.sprites.squadsPositions, cls: "sq-rowtile",
          dataset: { squadPositions: s.id }, title: "Positions", ariaLabel: "Positions",
        }) +
        DWFUI.artBtnHtml({
          sprite: DWFUI.TOKENS.sprites.quill, cls: "sq-rowtile sq-rowtile-quill",
          dataset: { squadRenameFocus: s.id }, title: "Rename squad", ariaLabel: "Rename squad",
        }) + `</span>`;
      return DWFUI.rowHtml({
        tag: "div", cls: "sq-item", dataset: { squadId: s.id },
        chassis: "table", stacked: true, icon: icons,
        labelHtml: DWFUI.bitmapTextHtml(label, { cls: "sq-item-name-text" }),
        // Native's order line goes ORANGE while an order is active (R2). `tone:'warning'` IS
        // --dwfui-text-warning (#ff7f13) -- the state comes from the token layer, not from a hex.
        // The consumer classes ride ALONGSIDE `.dwfui-sub` (they carry the ellipsis, not the colour).
        sub: [
          { html: DWFUI.bitmapTextHtml(sqOrdersSummary(s), { cls: "sq-item-orders-text" }),
            cls: "dwfui-sub sq-item-orders",
            tone: hasOrder ? "warning" : "secondary" },
          { html: DWFUI.bitmapTextHtml(`Routine:${s.routineName || "(none)"} · ${s.memberCount}/${s.positionCount} members`,
              { cls: "sq-item-routine-text" }),
            cls: "dwfui-sub sq-item-sub" },
        ],
        trailing: DWFUI.checkHtml({
          checked: selected, cls: "sq-item-check", dataset: { squadSelect: s.id },
          title: "Select squad", ariaLabel: "Select squad",
        }),
      });
    }).join("");
  }

  // Order toolbar for the SELECTED squad (native screen 2). Move==Station and Kill are map-click
  // flows; Kill keeps the selected unit visible until its explicit confirmation. Patrol + Defend-burrow are server-501 -> disabled +
  // labelled (never hidden, per WD-30). Current orders list + per-order Cancel shown above.
  // DWFUI's art/plaque builders are id-less by contract (they address controls through `dataset`).
  // The squads wiring -- and squads_view_fixture_test -- have addressed these controls by their
  // long-standing #ids since B60, and a RESTYLE must not change behaviour or identity. So the id is
  // spliced back onto the button the builder returned: one splice, no re-implementation, no
  // hand-rolled look-alike of the component.
  //
  // R7 NOTE: the old body spelled the open tag as a bare REGEX LITERAL, and the drift guard's
  // open-tag scanner is a TEXT scanner, not a parser -- so it matched that regex literal and ran on
  // into the following comment. One of this file's baselined raw-button findings was therefore this
  // helper's OWN SOURCE TEXT, not a control at all. Spelling the tag as an alternation removes the
  // false positive without changing what the helper does to a single byte of emitted markup.
  function sqWithId(html, id) {
    return String(html).replace(/^<(button|input|label|div)\b/, `<$1 id="${id}"`);
  }

  // WAVE 4 S2: the strip is ICON-ONLY native tiles (verbatim: "the buttons are just icons").
  // Every glyph here was an emoji or a Unicode stand-in for a sprite we already own -- Kill and
  // Station even shared the SAME &#9876;. The CONTROLS are untouched: the ids, the per-order
  // Cancel (data-squad-order-cancel -> do_squad_order_cancel(id, index), the ONLY way to drop a
  // single order) and the whole multi-target kill arm/mark/Confirm flow all survive verbatim.
  function sqOrderToolbar(squad, opts = {}, esc = sqEsc) {
    const orders = Array.isArray(squad && squad.orders) ? squad.orders : [];
    const orderRows = orders.length
      ? orders.map(o => `<div class="sq-order-row">
          <span class="sq-order-type">${DWFUI.bitmapTextHtml(o.type || "")}</span>
          <span class="sq-order-desc">${DWFUI.bitmapTextHtml(o.description || "")}</span>
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.squadsCancelOrder,
            dataset: { squadOrderCancel: o.index },
            title: "Cancel this order", ariaLabel: "Cancel this order" })}
        </div>`).join("")
      : `<div class="info-message">${DWFUI.bitmapTextHtml("No current orders.",
          { cls: "sq-no-orders-text" })}</div>`;
    const moveArmed = !!opts.moveArmed;
    const killArmed = !!opts.killArmed;
    // B70: multi-target kill. killTargets is the marked selection set ([{id,name}]); the flow
    // stays armed while marking, then one Confirm sends every target as a CSV.
    const killTargets = Array.isArray(opts.killTargets) ? opts.killTargets : [];
    const killMarks = killTargets.length
      ? `<div class="sq-kill-marks">${killTargets.map(t =>
          `<span class="sq-kill-mark" data-kill-unmark="${t.id}" title="Click to unmark">` +
          `${DWFUI.iconHtml({ sprite: DWFUI.TOKENS.sprites.squadsKill, size: 16, alt: "Kill target" })}` +
          ` ${esc(t.name || ("unit " + t.id))} &times;</span>`).join("")}</div>`
      : "";
    const killTile = sqWithId(DWFUI.artBtnHtml({
      sprite: DWFUI.TOKENS.sprites.squadsKill, cls: "sq-order-tile",
      title: "Kill order: select one or more units on the map", ariaLabel: "Kill order",
    }), "squadOrderKillBtn");
    let killControls;
    if (!killArmed) {
      killControls = "";
    } else {
      const confirmBtn = sqWithId(killTargets.length
        ? DWFUI.plaqueBtnHtml({ label: `Confirm (${killTargets.length})`, tone: "green",
            cls: "sq-kill-confirm", title: "Issue the kill order for every marked target" })
        : DWFUI.plaqueBtnHtml({ label: "Select targets on map", tone: "grey", disabled: true,
            title: "Select at least one unit" }), "squadOrderKillBtn");
      const state = killTargets.length
        ? `<span class="sq-kill-state">${killTargets.length} target${killTargets.length === 1 ? "" : "s"} marked. Click more, or Confirm.</span>`
        : `<span class="sq-kill-state">Select targets on the map, then Confirm.</span>`;
      const cancelBtn = sqWithId(DWFUI.plaqueBtnHtml({ label: "Cancel", tone: "red",
        title: "Abandon the kill order" }), "squadOrderKillCancelBtn");
      killControls = `<div class="sq-controls sq-kill-row">${confirmBtn}${state}${cancelBtn}</div>${killMarks}`;
    }
    // Native strip order (R2): kill · station · patrol · defend · train · cancel-all.
    const tile = (id, sprite, title, extra = {}) => sqWithId(DWFUI.artBtnHtml(Object.assign({
      sprite, cls: "sq-order-tile", title, ariaLabel: title,
    }, extra)), id);
    const strip = [
      killArmed ? "" : killTile,
      tile("squadOrderMoveBtn", DWFUI.TOKENS.sprites.squadsMove,
        moveArmed ? "Station: click a map tile (click again to cancel)" : "Station: click a map tile",
        { active: moveArmed }),
      tile("squadOrderPatrolBtn", DWFUI.TOKENS.sprites.squadsPatrol, "Draw a patrol route on the map"),
      tile("squadOrderBurrowBtn", DWFUI.TOKENS.sprites.squadsDefendBurrow, "Defend burrows: pick from the fort's burrows"),
      // Q4/E4-B6: nobody has opened the native war-hammer tile, so what it OPENS is unverified.
      // It ships as the real sprite behind a placeholder hover that says exactly that -- it never
      // invents behaviour, and the wired /squad-order action=train POST is unchanged.
      tile("squadOrderTrainBtn", DWFUI.TOKENS.sprites.squadsTrain,
        "Train at barracks (native's war-hammer tile is unverified evidence Q4 — this issues the train order directly)",
        { placeholder: true }),
      tile("squadOrderCancelAllBtn", DWFUI.TOKENS.sprites.squadsCancelOrder, "Cancel all orders",
        { disabled: !orders.length }),
    ].join("");
    return `
      <div class="sq-order-list">${orderRows}</div>
      <div class="sq-order-toolbar">${strip}</div>
      ${killControls}`;
  }

  // Bottom action cluster for the selected squad (native screen 2: Equip / Schedule / trash),
  // plus rename (native screen 6 is the DF word-generator; free-text rename covers it here).
  // *** THE FREE-TEXT RENAME INPUT STAYS. *** (binding, 2026-07-12 -- DELETION-LEDGER.)
  // #squadRenameInput -> squadRename() -> POST /squad-rename -> squads.cpp -> do_squad_rename()
  // -> squad->alias = name. An exhaustive grep of web/ + tools/ finds NO other rename path in the
  // client, and the C++ accepts ANY 64-char string, so free text is a SUPERSET of native's word
  // generator (which cannot produce "The Copper Picks"). The matrix's D3 "DROP our free-text rename" is
  // SUPERSEDED: the word generator is its own later piece.
  //
  // ---- DEFECT S5: THE BOTTOM `Rename` BUTTON IS DELETED. ---------------------------------------
  // The owner: "there needs no rename button at the bottom, thats for when you click the arrow. having it
  // there is non native and redundant." Native reaches rename through the ROW'S QUILL TILE, and we
  // already ship that tile (data-squad-rename-focus -> selects the squad + focuses this input). The
  // `Rename` plaque was a second, non-native affordance for the same route.
  // THE CAPABILITY SURVIVES, and is proven in wave4_squads_parity_test: the quill focuses the input
  // and the input COMMITS ON ENTER (keydown -> squadRename), so #squadRenameInput -> /squad-rename
  // -> squad->alias is intact end to end. A BUTTON was deleted, not a capability.
  // Same authoritative signal as the host panel and pause gate. Fail closed: merely being on
  // localhost is not host authority, and a remote client must never see the guard-enable action.
  function squadIsHostClient() {
    try {
      return !!(typeof window !== "undefined" && window.DwfWS &&
        typeof window.DwfWS.isHost === "function" && window.DwfWS.isHost());
    } catch (_) { return false; }
  }

  function sqSelectedActions(squad, esc = sqEsc) {
    const displayName = squad.alias || squad.name || ("Squad " + squad.id);
    const nav = [
      DWFUI.plaqueBtnHtml({ label: "Positions", tone: "green", artTone: "neutral", dataset: { squadNav: "positions" } }),
      DWFUI.plaqueBtnHtml({ label: "Equip", tone: "green", artTone: "neutral", dataset: { squadNav: "equip" } }),
      DWFUI.plaqueBtnHtml({ label: "Schedule", tone: "green", artTone: "neutral", dataset: { squadNav: "schedule" } }),
      sqWithId(DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.squadsDisband, cls: "sq-danger",
        title: "Disband this squad (irreversible)", ariaLabel: "Disband this squad" }),
        "squadDeleteBtn"),
    ].join("");
    return `
      <div class="sq-sel-head">
        <div class="sq-sel-name">${DWFUI.bitmapTextHtml(displayName, { cls: "sq-sel-name-text" })}</div>
        <div class="sq-sel-meta">${DWFUI.bitmapTextHtml(`${squad.memberCount}/${squad.positionCount} members`,
          { cls: "sq-sel-meta-text" })}</div>
      </div>
      <div id="squadStatus" class="info-message sq-status" style="display:none"></div>
      ${sqOrderToolbar(squad, { moveArmed: squadMoveArmedFor.id === squad.id,
        killArmed: squadKillArmedFor.id === squad.id, killTargets: squadKillArmedFor.targets }, esc)}
      <div class="sq-controls sq-rename-row">
        <input class="sq-input" id="squadRenameInput" type="text" maxlength="64" placeholder="Rename squad — press Enter" value="${esc(squad.alias || "")}" title="Type a new squad name and press Enter (the row's quill tile focuses this field)">
      </div>
      <div class="sq-nav-row">${nav}</div>`;
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

  // --- Positions screen (native 4): roster only. Choosing a row transitions to screen 4.1. ---
  function sqPositionRows(members, esc = sqEsc) {
    if (!Array.isArray(members) || !members.length) {
      return `<div class="info-message">This squad has no positions.</div>`;
    }
    return members.map(m => {
      if (!m.filled) {
        return DWFUI.plaqueBtnHtml({ label: `Assign position ${m.idx}`, tone: "green",
          artTone: "neutral", cls: "sq-position-assign", dataset: { squadPickPos: m.idx },
          title: `Choose a citizen for position ${m.idx}` });
      }
      const name = m.name || ("Unit " + m.unitId);
      const sub = [m.positionName || "", ...(Array.isArray(m.topSkills) ? m.topSkills : [])]
        .filter(Boolean).join(" - ");
      // B294 parity: the occupant name carries the DF profession colour, same as the candidate rows.
      const labelHtml = DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered squad member name",
        `<span${sqProfessionColorStyle(m)}>${DWFUI.bitmapTextHtml(name)}</span>`);
      return DWFUI.rowHtml({
        tag: "button", cls: "sq-position-row", chassis: "table",
        dataset: { squadPickPos: m.idx }, icon: sqUnitPortrait(m),
        labelHtml, labelCls: "sq-pos-who", sub: sub ? { text: sub, cls: "sq-pos-role" } : null,
        title: `Choose a citizen for position ${m.idx}`,
      });
    }).join("");
  }

  function sqCandidateSortedRows(candidates, sortKey = "suitability", direction = 1) {
    const rows = Array.isArray(candidates) ? candidates.slice() : [];
    if (sortKey === "suitability") return direction < 0 ? rows.reverse() : rows;
    const value = candidate => sortKey === "profession"
      ? String(candidate.profession || candidate.job || "") : String(candidate.name || "");
    rows.sort((a, b) => value(a).localeCompare(value(b)) * direction ||
      String(a.name || "").localeCompare(String(b.name || "")));
    return rows;
  }

  function sqCandidateRows(candidates, pos, esc = sqEsc) {
    if (!Array.isArray(candidates) || !candidates.length) {
      return `<div class="info-message">No available citizens.</div>`;
    }
    return candidates.map(c => {
      const name = c.name || ("Unit " + c.unitId);
      const meta = [c.profession || c.job || "Citizen",
        ...(Array.isArray(c.topSkills) ? c.topSkills : [])].filter(Boolean).join(" - ");
      const labelHtml = DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered squad candidate name",
        `<span${sqProfessionColorStyle(c)}>${DWFUI.bitmapTextHtml(name)}</span>`);
      return DWFUI.rowHtml({
        tag: "button", cls: "sq-candidate-row", chassis: "table",
        dataset: { squadAssignUnit: c.unitId, squadAssignPos: pos,
          candidateSearch: `${name} ${meta}`.toLowerCase() },
        icon: sqUnitPortrait(c), labelHtml, labelCls: "sq-pos-who",
        sub: { text: meta, cls: "sq-pos-role" }, title: `Assign ${name} to position ${pos}`,
      });
    }).join("");
  }

  function sqPositionsView(detail, esc = sqEsc) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const members = Array.isArray(squad.members) ? squad.members : [];
    return `
      ${sqBackHeader(squad, esc)}
      <div id="squadStatus" class="info-message sq-status" style="display:none"></div>
      <div class="sq-section-title">Positions</div>
      ${DWFUI.scrollHtml({ cls: "sq-pos-list", preserveKey: "squads:positions" },
        sqPositionRows(members, esc))}`;
  }

  // Native screen 4.1: one exact SQUAD_FILL_POSITION target, never a roster+slot-stepper mashup.
  function sqCandidateView(detail, pos, options = {}, esc = sqEsc) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const members = Array.isArray(squad.members) ? squad.members : [];
    const member = members.find(row => Number(row.idx) === Number(pos));
    if (!member) return `<div class="info-message">Position unavailable.</div>`;
    // Position 0 (the squad commander) is assigned like any other slot. Its former probe guard was
    // verified live 2026-07-17 and removed; there is no locked pos-0 branch anymore.
    const candidates = sqCandidateSortedRows(detail.candidates, options.sortKey, options.sortDirection);
    const sort = DWFUI.sortHeaderHtml({
      cls: "sq-candidate-sort", dataAttr: "squad-candidate-sort", ariaLabel: "Sort citizens",
      active: options.sortKey || "suitability",
      columns: [
        { key: "name", label: "Name", sort: options.sortDirection < 0 ? "desc" : "asc" },
        { key: "category", label: "Cat", sort: "asc", disabled: true,
          title: "The squad payload does not expose native's category field" },
        { key: "profession", label: "Prof", sort: options.sortDirection < 0 ? "desc" : "asc" },
        { key: "suitability", label: "", sort: options.sortDirection < 0 ? "desc" : "asc",
          title: "DF effective military-skill order (exact native squad suitability is not exposed)" },
      ],
    });
    const remove = member.filled ? DWFUI.rowHtml({
      tag: "button", cls: "sq-candidate-remove", chassis: "table",
      dataset: { squadRemoveAssignment: member.unitId }, label: "Remove assignment",
      title: `Remove ${member.name || "this citizen"} from position ${pos}`,
    }) : "";
    return `<div class="sq-candidate-screen" data-candidate-position="${Number(pos)}">
      ${sort}${remove}
      ${DWFUI.scrollHtml({ cls: "sq-candidate-list", preserveKey: `squads:candidates:${pos}` },
        sqCandidateRows(candidates, pos, esc))}
      ${DWFUI.searchHtml({ cls: "sq-candidate-search", placement: "footer", magnifier: true,
        dataAttr: "squad-candidate-search", type: "search", value: options.search || "",
        preserveKey: `squads:candidates:${pos}`, ariaLabel: "Search citizens" })}
    </div>`;
  }

  // --- Equip screen (native 5): sub-tabs Assign-uniform / Add-uniform / Ammo. ---
  const UNIFORM_CATS = [
    [0, "Body armor"], [1, "Helm"], [2, "Legwear"], [3, "Gloves"],
    [4, "Footwear"], [5, "Shield"], [6, "Weapon"],
  ];
  const CHOICE_OPTIONS = [[0, "(none)"], [1, "any"], [2, "melee"], [4, "ranged"]];

  // Kept (and still exported) as the OPTION-LIST source of truth, now returning [value,label] pairs
  // for the cyclers instead of <option> markup. Its two consumers (the uniform editor and the ammo
  // add-row) previously rendered it into a `select`; both now cycle it.
  function sqMaterialClassOptions(catalog, selected, esc = sqEsc) {
    const classes = Array.isArray(catalog && catalog.materialClasses) ? catalog.materialClasses : [];
    if (!classes.length) return [[-1, "any"]];
    return classes.map(mc => [mc.value, mc.value === -1 ? "any material" : String(mc.name || "")]);
  }

  function sqSubtypeName(catalog, cat, subtype, esc = sqEsc) {
    if (subtype < 0) return "any";
    const list = catalog && catalog.subtypes && catalog.subtypes[cat];
    if (Array.isArray(list)) {
      const hit = list.find(s => s.subtype === subtype);
      if (hit) return esc(hit.name);
    }
    return "subtype " + subtype;
  }

  // Assign-uniform tab (native 5.1): per-position, apply an EXISTING fort template or clear it.
  // The `${m.uniformItems} items` TEXT cell is replaced by native's SLOT-SPRITE STRIP (see
  // sqEquipmentStrip): the 33 SQUADS_EQUIPMENT_* tiles finally reach the screen. The count is not
  // lost -- it is the strip's title, and no cell of the row lost a wire.
  function sqUniformAssignRows(members, uniforms, esc = sqEsc, picks = {}) {
    if (!Array.isArray(members) || !members.length) {
      return `<div class="info-message">This squad has no positions.</div>`;
    }
    const templates = Array.isArray(uniforms) ? uniforms : [];
    const options = templates.map(u => [u.id, u.name || ("Uniform " + u.id)]);
    return members.map(m => {
      const portrait = m.filled ? sqUnitPortrait(m) : "";
      const who = m.filled ? portrait + `<span${sqProfessionColorStyle(m)}>${esc(m.name || ("Unit " + m.unitId))}</span>` : "(empty)";
      const pick = picks[m.idx] != null ? picks[m.idx] : (templates.length ? templates[0].id : -1);
      const strip = sqEquipmentStrip(m);
      const items = Number(m.uniformItems) || 0;
      return `<div class="sq-uassign-row sq-uassign-matrix-row">
        <div class="sq-uassign-pos">${m.idx} &middot; ${esc(m.positionName || "")}</div>
        <div class="sq-uassign-who">${who}</div>
        <div class="sq-uassign-items" title="${items} uniform item${items === 1 ? "" : "s"} required">${strip ||
          DWFUI.bitmapTextHtml(items ? `${items} items` : "no uniform", { cls: "sq-uassign-items-text" })}</div>
        ${sqCyclerHtml("uniformPick", options, pick, { cls: "sq-uniform-select",
          dataset: { uniformPos: m.idx }, title: "Uniform template", empty: "No uniform templates",
          ariaLabel: "Uniform template for this position" })}
        ${DWFUI.plaqueBtnHtml({ label: "Apply", tone: "green", artTone: "neutral",
          dataset: { uniformApply: m.idx }, disabled: !templates.length,
          title: "Apply the cycled template to this position" })}
        ${DWFUI.plaqueBtnHtml({ label: "Clear", tone: "red", dataset: { uniformClear: m.idx },
          title: "Clear this position's uniform" })}
        ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.inspect, cls: "sq-uassign-inspect",
          dataset: { equipmentInspect: m.idx }, title: "Inspect this position's equipment", ariaLabel: "Inspect equipment" })}
        ${DWFUI.plaqueBtnHtml({ label: "Details", tone: "green", artTone: "neutral",
          dataset: { equipmentDetails: m.idx }, title: "Open equipment details" })}
      </div>`;
    }).join("");
  }

  function sqUniformTemplatePane(uniforms, esc = sqEsc) {
    const templates = Array.isArray(uniforms) ? uniforms : [];
    const rows = templates.map(u => DWFUI.rowHtml({
      tag: "div", cls: "sq-uniform-template-row", chassis: "slab", state: "on",
      dataset: { uniformTemplate: u.id }, label: u.name || ("Uniform " + u.id),
      trailingHtml: DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump,
        dataset: { uniformTemplateDelete: u.id }, title: "Delete uniform template", ariaLabel: "Delete uniform template" }),
    })).join("");
    return `<aside class="sq-uniform-template-pane">
      <div class="sq-uniform-template-prompt">Choose a uniform for the selected squads.</div>
      ${DWFUI.scrollHtml({ cls: "sq-uniform-template-list", preserveKey: "squads:uniform-templates" },
        rows || `<div class="info-message">No uniform templates.</div>`)}</aside>`;
  }

  // Add-uniform tab (native 5.2 + 5.2.1-5.2.7): fort-wide template authoring. The 7 categories
  // map to the native "New bodywear/headwear/legwear/handwear/footwear/shield/weapon" buttons.
  function sqUniformEditor(catalog, uniformSelId, esc = sqEsc, sel = {}) {
    if (!catalog) return `<div class="info-message">Uniform catalog unavailable.</div>`;
    const templates = Array.isArray(catalog.uniforms) ? catalog.uniforms : [];
    const tplOptions = templates.map(u => [u.id, u.name || ("Uniform " + u.id)]);
    const selected = templates.find(u => u.id === uniformSelId) || null;
    if (!selected) {
      const addButtons = UNIFORM_CATS.map(([, label]) => DWFUI.plaqueBtnHtml({
        label: `New ${String(label).toLowerCase()}`, tone: "green", artTone: "neutral",
        cls: "sq-uniform-blank-category", disabled: true,
        title: "Name and save the uniform before adding equipment requirements",
      })).join("");
      return `<div class="sq-uniform-blank-head">
          ${DWFUI.textInputHtml({ cls: "sq-input sq-uniform-newname", id: "uniformNewName", maxLength: 64,
            placeholder: "<enter name here>" })}
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.quill, title: "Name this uniform", ariaLabel: "Name this uniform" })}
          ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Confirm and save uniform", tone: "green", artTone: "neutral",
            disabled: true, title: "Enter a name to save this uniform" }), "uniformCreateBtn")}
        </div>
        <div class="sq-controls sq-uniform-blank-categories">${addButtons}</div>
        <div class="sq-equipment-policy">
          ${DWFUI.plaqueBtnHtml({ label: "Uniform worn over clothing", tone: "green", artTone: "neutral", disabled: true })}
          ${DWFUI.plaqueBtnHtml({ label: "Partial matches okay", tone: "green", artTone: "neutral", disabled: true })}
        </div>`;
    }
    const body = sqUniformTemplateBody(catalog, selected, esc, sel);
    return `
      <div class="sq-controls">
        ${sqCyclerHtml("uniformSelect", tplOptions, uniformSelId, { cls: "sq-uniform-cycler",
          title: "Uniform template", empty: "No templates", ariaLabel: "Uniform template" })}
        ${DWFUI.textInputHtml({ cls: "sq-input sq-uniform-newname", id: "uniformNewName", maxLength: 64,
          placeholder: "New template name..." })}
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Create", tone: "green", artTone: "neutral",
          title: "Create a new fort uniform template" }), "uniformCreateBtn")}
      </div>
      ${body}`;
  }

  function sqUniformTemplateBody(catalog, u, esc = sqEsc, sel = {}) {
    const items = Array.isArray(u.items) ? u.items : [];
    const subtypesByCat = catalog.subtypes || {};
    const drafts = sel.uitemDrafts || {};
    const flags = sel.uniformFlags || { replaceClothing: !!u.replaceClothing, exactMatches: !!u.exactMatches };
    const matOptions = sqMaterialClassOptions(catalog, -1, esc);
    const catRows = UNIFORM_CATS.map(([cat, label]) => {
      const catItems = items.filter(it => it.cat === cat);
      const itemRows = catItems.map(it => {
        const subName = sqSubtypeName(catalog, cat, it.subtype, esc);
        const mat = it.materialClass !== -1 ? esc(it.materialName || "") : "any";
        const choice = (CHOICE_OPTIONS.find(c => c[0] === it.choice) || [0, ""])[1];
        const bits = [subName, mat, it.color >= 0 ? ("color " + it.color) : "", cat === 6 && choice ? choice : ""].filter(Boolean).join(" &middot; ");
        return `<div class="sq-uitem-row">
          <span class="sq-uitem-desc">${bits}</span>
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump, cls: "sq-danger sq-uitem-remove",
            dataset: { ucat: cat, uindex: catItems.indexOf(it) },
            title: "Remove item", ariaLabel: "Remove item" })}
        </div>`;
      }).join("");
      const subOptions = [[-1, "any subtype"]].concat(
        (Array.isArray(subtypesByCat[cat]) ? subtypesByCat[cat] : [])
          .map(s => [s.subtype, s.name || ("subtype " + s.subtype)]));
      const d = drafts[cat] || {};
      const subtype = d.subtype != null ? d.subtype : -1;
      // The DISPLAYED default must be the value that gets POSTED. The old `select`'s implicit default
      // was its FIRST option, so the cycler's is too -- otherwise the label would say one material and
      // the wire would carry another.
      const matclass = d.matclass != null ? d.matclass
        : (matOptions.length ? matOptions[0][0] : -1);
      const color = d.color != null ? d.color : -1;
      const choice = d.choice != null ? d.choice : 0;
      // B158: the add-item choosers sit on the SAME row as the "Helm"-like category title
      // (a left label column), not stacked below it, so the editor scans horizontally. Existing items
      // list below the row. The three `select` controls are now native CYCLERS and the dye number a STEPPER;
      // the per-category draft carries what the DOM controls used to carry.
      return `<div class="sq-ucat">
        <div class="sq-ucat-top">
          <div class="sq-ucat-head">${esc(label)}</div>
          <div class="sq-controls sq-uitem-add" data-ucat="${cat}">
            ${sqCyclerHtml("uitemSubtype", subOptions, subtype, { cls: "sq-uitem-subtype",
              dataset: { ucat: cat }, title: "Subtype", ariaLabel: `${label} subtype` })}
            ${sqCyclerHtml("uitemMat", matOptions, matclass, { cls: "sq-uitem-mat",
              dataset: { ucat: cat }, title: "Material", ariaLabel: `${label} material` })}
            ${sqStepperHtml({ cls: "sq-pos-input sq-uitem-color", inputCls: "sq-input sq-uitem-color-input",
              dataset: { uitemColor: cat }, label: "Dye", min: -1, max: 15, value: color,
              ariaLabel: "Dye color (0-15, -1 none)", title: "Dye color (0-15, -1 none)" })}
            ${cat === 6 ? DWFUI.segmentedHtml({ cls: "sq-uitem-choice", dataAttr: "uitem-choice",
              dataset: { ucat: cat }, ariaLabel: "Individual weapon choice", active: String(choice),
              options: CHOICE_OPTIONS.map(([v, l]) => ({ key: String(v), label: l })) }) : ""}
            ${DWFUI.plaqueBtnHtml({ label: "Add", tone: "green", artTone: "neutral",
              cls: "sq-uitem-addbtn", dataset: { uitemAdd: cat },
              title: `Add this ${String(label).toLowerCase()} requirement to the template` })}
          </div>
        </div>
        <div class="sq-uitem-list">${itemRows || `<span class="sq-empty">(none)</span>`}</div>
      </div>`;
    }).join("");
    return `
      <div class="sq-controls">
        <input class="sq-input" id="uniformRenameInput" type="text" maxlength="64" value="${esc(u.name || "")}">
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Rename template", tone: "green", artTone: "neutral",
          title: "Rename this template" }), "uniformRenameBtn")}
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Delete", tone: "red", cls: "sq-danger",
          title: "Delete this template (irreversible; squads that already applied it keep their copy)" }), "uniformDeleteBtn")}
      </div>
      <div class="sq-controls">
        <label class="sq-ammo-flag">${DWFUI.checkHtml({ checked: !!flags.replaceClothing,
          dataset: { uniformFlag: "replaceClothing" }, title: "Worn over clothing",
          ariaLabel: "Worn over clothing" })}Worn over clothing</label>
        <label class="sq-ammo-flag">${DWFUI.checkHtml({ checked: !!flags.exactMatches,
          dataset: { uniformFlag: "exactMatches" }, title: "Partial matches okay",
          ariaLabel: "Partial matches okay" })}Partial matches okay</label>
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Save flags", tone: "green", artTone: "neutral",
          title: "Save the two template flags" }), "uniformFlagsBtn")}
      </div>
      <div class="sq-ucat-grid">${catRows}</div>`;
  }

  // Ammo tab (native 5.3): squad ammunition specs (subtype + material + amount + combat/train).
  function sqAmmoSection(detail, catalog, esc = sqEsc, sel = {}) {
    const specs = Array.isArray(detail && detail.ammo) ? detail.ammo : [];
    const defs = Array.isArray(detail && detail.ammoDefs) ? detail.ammoDefs : [];
    const rowDrafts = sel.ammoRowDrafts || {};
    const add = sel.ammoAdd || {};
    const rows = specs.length
      ? specs.map(a => {
          const name = esc(a.ammoName || ("Ammo #" + a.subtype));
          const mat = esc(a.materialName && a.materialClass !== -1 ? a.materialName : "any");
          const d = rowDrafts[a.index] || {};
          const amount = d.amount != null ? Number(d.amount) : (Number(a.amount) || 0);
          const combat = d.combat != null ? !!d.combat : !!a.combat;
          const training = d.training != null ? !!d.training : !!a.training;
          return `<div class="sq-ammo-row" data-ammo-index="${a.index}">
            <span class="sq-ammo-name">${name}</span>
            ${sqStepperHtml({ cls: "sq-ammo-amount", inputCls: "sq-input sq-ammo-amount-input",
              dataset: { ammoAmount: a.index }, min: 0, max: 9999, value: amount, ariaLabel: "Amount" })}
            <span class="sq-ammo-mat">${mat}</span>
            <label class="sq-ammo-flag">${DWFUI.checkHtml({ checked: combat, cls: "sq-ammo-combat",
              dataset: { ammoFlag: "combat", ammoIndex: a.index }, title: "Combat ammunition",
              ariaLabel: "Combat ammunition" })}C</label>
            <label class="sq-ammo-flag">${DWFUI.checkHtml({ checked: training, cls: "sq-ammo-training",
              dataset: { ammoFlag: "training", ammoIndex: a.index }, title: "Training ammunition",
              ariaLabel: "Training ammunition" })}T</label>
            ${DWFUI.plaqueBtnHtml({ label: "Save", tone: "green", artTone: "neutral",
              cls: "sq-ammo-update", dataset: { ammoSave: a.index }, title: "Save this row" })}
            ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump, cls: "sq-danger sq-ammo-remove",
              dataset: { ammoRemove: a.index }, title: "Remove", ariaLabel: "Remove this ammunition" })}
          </div>`;
        }).join("")
      : `<div class="info-message">No ammunition assigned. (${defs.length ? "add bolts/arrows below" : "ammo catalog unavailable"})</div>`;
    const defOptions = defs.map(d =>
      [d.subtype, (d.name || ("ammo " + d.subtype)) + (d.ammoClass ? " (" + d.ammoClass + ")" : "")]);
    const matOptions = sqMaterialClassOptions(catalog, -1, esc);
    const addSubtype = add.subtype != null ? add.subtype : (defs.length ? defs[0].subtype : -1);
    const addAmount = add.amount != null ? Number(add.amount) : 100;
    // Same rule as the uniform editor: the displayed default IS the posted default (the old
    // `select`'s first option), never a silent -1 behind a label saying something else.
    const addMat = add.matclass != null ? add.matclass : (matOptions.length ? matOptions[0][0] : -1);
    const addCombat = add.combat != null ? !!add.combat : true;
    const addTraining = !!add.training;
    return `
      ${DWFUI.scrollHtml({ cls: "sq-ammo-list", preserveKey: "squads:ammo" }, rows)}
      <div class="sq-controls sq-ammo-add">
        ${sqCyclerHtml("ammoType", defOptions, addSubtype, { cls: "sq-ammo-type", title: "Ammo type",
          empty: "No ammo types", ariaLabel: "Ammunition type" })}
        ${sqStepperHtml({ cls: "sq-pos-input sq-ammo-add-amount", inputCls: "sq-input sq-ammo-add-amount-input",
          dataset: { ammoAddAmount: "" }, label: "Amount", min: 0, max: 9999, value: addAmount,
          ariaLabel: "Amount" })}
        ${sqCyclerHtml("ammoMat", matOptions, addMat,
          { cls: "sq-ammo-matclass", title: "Material", ariaLabel: "Ammunition material" })}
        <label class="sq-ammo-flag">${DWFUI.checkHtml({ checked: addCombat,
          dataset: { ammoAddFlag: "combat" }, title: "Combat", ariaLabel: "Combat" })}Combat</label>
        <label class="sq-ammo-flag">${DWFUI.checkHtml({ checked: addTraining,
          dataset: { ammoAddFlag: "training" }, title: "Train", ariaLabel: "Train" })}Train</label>
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Add", tone: "green", artTone: "neutral",
          disabled: !defs.length, title: "Add this ammunition spec" }), "squadAmmoAddBtn")}
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Clear all", tone: "red", disabled: !specs.length,
          title: "Remove every ammunition spec" }), "squadAmmoClearBtn")}
      </div>`;
  }

  // Supplies tab (native 5.4): per-squad food/water each member carries. Food is a 0..3 count
  // ("No food".."3 food"); water is Drink/Water/No water. Served on /squad detail as
  // detail.supplies={food,water}. Absent (old DLL) -> graceful message, no controls.
  const SUPPLY_FOOD_OPTIONS = [[3, "3 food"], [2, "2 food"], [1, "1 food"], [0, "No food"]];
  const SUPPLY_WATER_OPTIONS = [["drink", "Drink"], ["water", "Water"], ["nowater", "No water"]];

  function sqSuppliesSection(detail, esc = sqEsc) {
    const supplies = detail && detail.supplies;
    if (!supplies) {
      return `<div class="info-message">This build does not serve squad supplies, so they cannot be edited here.</div>`;
    }
    const food = Number(supplies.food);
    const water = String(supplies.water || "none");
    // Native's food/water rows are a 4-way and a 3-way exclusive choice on the HORIZONTAL_OPTION_*
    // segmented control (gold corner brackets on the selected segment -- never a fill). The seven
    // hand-rolled `.sq-supply-btn` buttons were that control, re-drawn in CSS.
    return `
      <div class="sq-section-title">Supplies carried by each squad member</div>
      <div class="sq-controls sq-supply-row">${DWFUI.segmentedHtml({
        cls: "sq-supply-food", dataAttr: "supply-food", active: String(food),
        ariaLabel: "Food carried by each squad member",
        options: SUPPLY_FOOD_OPTIONS.map(([v, label]) => ({ key: String(v), label })),
      })}</div>
      <div class="sq-controls sq-supply-row">${DWFUI.segmentedHtml({
        cls: "sq-supply-water", dataAttr: "supply-water", active: water,
        ariaLabel: "Water carried by each squad member",
        options: SUPPLY_WATER_OPTIONS.map(([v, label]) => ({ key: String(v), label })),
      })}</div>`;
  }

  function sqEquipmentItemLabel(item, cat, esc = sqEsc) {
    const assigned = Number(item.assignedCount) || 0;
    if (assigned > 1) return `${assigned} assigned items`;
    const material = item.materialName || (item.materialClass >= 0 ? item.materialClassName : "any");
    const name = item.itemName || (UNIFORM_CATS.find(c => c[0] === cat) || [0, "item"])[1];
    return esc(`${material && material !== "any" ? material + " " : ""}${name}`);
  }

  function sqEquipmentPickerView(detail, catalog, posIndex, picker, esc = sqEsc) {
    const squad = detail && detail.squad;
    const members = Array.isArray(squad && squad.members) ? squad.members : [];
    const member = members.find(m => Number(m.idx) === Number(posIndex));
    if (!member || !picker) return `<div class="info-message">Equipment item unavailable.</div>`;
    const title = picker.kind === "color" ? "Select color." : "Select material.";
    // Native's chooser (5.2.x / 5.3.x) is a LIST OF ROWS, not a wall of buttons: the slab chassis.
    // `sq-create-row` is carried so the EXISTING `.sq-create-row.dwfui-row--slab { display:flex }`
    // override applies -- the same chooser-row paint the create screen already uses. (`sq-pos-row`
    // is DELIBERATELY not carried here: it is a 4-column CSS grid, and a one-cell row inside it
    // would be squashed into its 28px first track. Its only other job was the slab look, which the
    // chassis now owns.)
    const pickerRow = (dataset, label) => DWFUI.rowHtml({
      tag: "button", cls: "sq-create-row sq-picker-row", chassis: "slab", state: "on",
      dataset, labelHtml: DWFUI.bitmapTextHtml(String(label), { cls: "sq-picker-row-text" }),
      labelCls: "sq-pos-role",
    });
    let rows = "";
    if (picker.kind === "color") {
      const colors = Array.isArray(catalog && catalog.colors) ? catalog.colors : [];
      rows = pickerRow({ equipmentPickColor: -1 }, "any color") +
        colors.map(color => pickerRow({ equipmentPickColor: color.value },
          color.name || ("color " + color.value))).join("");
    } else {
      const classes = Array.isArray(catalog && catalog.materialClasses) ? catalog.materialClasses : [];
      const materials = Array.isArray(catalog && catalog.materials) ? catalog.materials : [];
      rows = pickerRow({ equipmentPickMaterial: "class:-1" }, "any material") +
        classes.filter(mc => Number(mc.value) >= 0)
          .map(mc => pickerRow({ equipmentPickMaterial: `class:${mc.value}` }, mc.name)).join("") +
        materials.map(mat => pickerRow(
          { equipmentPickMaterial: `material:${mat.mattype}:${mat.matindex}` }, mat.name)).join("");
    }
    return `${sqBackHeader(squad, esc)}
      <div class="sq-back-head">${sqWithId(DWFUI.plaqueBtnHtml({ label: "Equipment details",
        tone: "green", cls: "sq-back-plaque" }), "equipmentPickerBackBtn")}<div class="sq-back-title">${title}</div></div>
      ${DWFUI.scrollHtml({ cls: "sq-picker-list", preserveKey: `squads:picker:${picker.kind}` },
        rows || `<div class="info-message">No choices were served by this build.</div>`)}`;
  }

  function sqEquipmentDetails(detail, catalog, posIndex, picker, esc = sqEsc) {
    if (picker) return sqEquipmentPickerView(detail, catalog, posIndex, picker, esc);
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const members = Array.isArray(squad.members) ? squad.members : [];
    const member = members.find(m => Number(m.idx) === Number(posIndex)) || members[0];
    if (!member) return `<div class="info-message">This squad has no positions.</div>`;
    const posOptions = members.map(m =>
      [m.idx, `Position ${Number(m.idx) + 1}${m.name ? " - " + m.name : ""}`]);
    const items = Array.isArray(member.uniformDetails) ? member.uniformDetails : [];
    const rows = items.map(item => {
      const cat = Number(item.cat);
      const label = (UNIFORM_CATS.find(c => c[0] === cat) || [0, "Equipment"])[1];
      const classLabel = item.materialClass >= 0 ? item.materialClassName : (item.materialName || "any material");
      const slot = UNIFORM_CAT_SLOT[cat];
      const good = (Number(item.assignedCount) || 0) > 0;
      const slotSprite = slot && DWFUI.TOKENS.sprites[`squadsEquip${slot}${good ? "Good" : "Missing"}`];
      return `<div class="sq-uassign-row sq-equipment-row">
        <div class="sq-uassign-pos">${slotSprite ? DWFUI.iconHtml({ sprite: slotSprite,
          nativeCell: true, cls: "sq-equip-slot", alt: `${label}: ${good ? "assigned" : "missing"}`,
          title: good ? `${label} -- ${item.assignedCount} item(s) assigned` : `${label} -- MISSING (no item assigned)` }) : ""
        }${esc(String(classLabel || "any"))} ${esc(label.toLowerCase())}</div>
        <div class="sq-uassign-who">${sqEquipmentItemLabel(item, cat, esc)}</div>
        ${DWFUI.plaqueBtnHtml({ label: "Mat", tone: "green", artTone: "neutral",
          dataset: { equipmentMaterial: `${cat}:${item.index}` }, title: "Choose the material" })}
        ${DWFUI.plaqueBtnHtml({ label: "Color", tone: "green", artTone: "neutral",
          dataset: { equipmentColor: `${cat}:${item.index}` }, title: "Choose the dye colour" })}
        ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump, cls: "sq-danger",
          dataset: { equipmentRemove: `${cat}:${item.index}` },
          title: "Remove this equipment requirement", ariaLabel: "Remove this equipment requirement" })}
      </div>`;
    }).join("");
    const add = UNIFORM_CATS.map(([cat, label]) => DWFUI.plaqueBtnHtml({
      label: `New ${String(label).toLowerCase()}`, tone: "green", artTone: "neutral",
      dataset: { equipmentAdd: cat }, title: `Add a ${String(label).toLowerCase()} requirement` })).join("");
    return `<div class="sq-section-title">${esc(squad.alias || squad.name || "Squad")} · Position ${Number(member.idx) + 1}</div>
      <div class="sq-controls"><span class="sq-field-label">Edit position</span>${
        sqCyclerHtml("equipPos", posOptions, member.idx, { cls: "sq-equipment-pos",
          title: "Position", ariaLabel: "Position being edited" })}</div>
      ${DWFUI.scrollHtml({ cls: "sq-equipment-list", preserveKey: "squads:equipment" },
        rows || `<div class="info-message">No equipment requirements for this position.</div>`)}
      <div class="sq-controls sq-equipment-add">${add}</div>
      <div class="sq-equipment-policy" aria-label="Uniform policy">
        ${DWFUI.plaqueBtnHtml({ label: "Uniform worn over clothing", tone: "green", artTone: "neutral",
          cls: "sq-equipment-policy-btn", disabled: true,
          title: "This squad-position policy is not served by the current game bridge" })}
        ${DWFUI.plaqueBtnHtml({ label: "Exact matches only", tone: "green", artTone: "neutral",
          cls: "sq-equipment-policy-btn", disabled: true,
          title: "This squad-position policy is not served by the current game bridge" })}
      </div>`;
  }

  const EQUIP_TABS = [["uniform", "Assign uniform"], ["add", "Add uniform"], ["ammo", "Ammo"],
    ["supplies", "Supplies"], ["details", "Details"]];

  function sqEquipView(detail, catalog, tab, uniformSelId, posIndex = 0, picker = null, esc = sqEsc, sel = {}) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const active = EQUIP_TABS.some(t => t[0] === tab) ? tab : "uniform";
    // ---- THE FILE'S OWN FOLLOW-UP, DONE. --------------------------------------------------------
    // This nav was `nonNativeTabsHtml` with the declared reason: "native squad equip nav is a GREEN
    // PLAQUE BUTTON row (Squad Menu UI/5. Equip Squad Menu.PNG), not a tab row", plus the note
    // "FOLLOW-UP (not this defect's scope): re-dress them as plaqueBtnHtml + drop the tablist role."
    // The oracle shows FOUR GREEN PLAQUES and NO tab shape anywhere on the squad screens, so the
    // opt-out was correct about the evidence and wrong about the paint: a declared non-native tab row
    // is still a TAB ROW (a tablist ARIA role, trapezoid CSS, an aria-selected key). It is now the plaque row
    // the oracle actually shows -- which also retires this file's only nonNativeTabsHtml call site.
    // The `data-equip-tab` attribute is UNCHANGED, so the switching handler binds exactly as before.
    // Native's fifth, RIGHT-ALIGNED `Update equipment` plaque is NOT added: we have no route behind
    // it, and a button that does nothing is worse than an absent one (an absent cell renders nothing).
    const nav = EQUIP_TABS.map(([key, label]) => DWFUI.plaqueBtnHtml({
      label, tone: "green", artTone: "neutral", cls: "sq-tab" + (key === active ? " active" : ""),
      dataset: { equipTab: key }, focus: key === active,
      title: `Equip: ${label}`,
    })).join("");
    let body;
    if (active === "add") {
      body = sqUniformEditor(catalog, uniformSelId, esc, sel);
    } else if (active === "ammo") {
      body = sqAmmoSection(detail, catalog, esc, sel);
    } else if (active === "supplies") {
      body = sqSuppliesSection(detail, esc);
    } else if (active === "details") {
      body = sqEquipmentDetails(detail, catalog, posIndex, picker, esc);
    } else {
      const uniforms = Array.isArray(detail.uniforms) ? detail.uniforms : [];
      const members = Array.isArray(squad.members) ? squad.members : [];
      body = `<div class="sq-uniform-assign-layout">${sqUniformTemplatePane(uniforms, esc)}
        ${DWFUI.scrollHtml({ cls: "sq-uassign-list", preserveKey: "squads:uassign" },
          sqUniformAssignRows(members, uniforms, esc, sel.uniformPick || {}))}</div>`;
    }
    const squadName = esc(squad.alias || squad.name || ("Squad " + squad.id));
    const confirm = DWFUI.plaqueBtnHtml({ label: "Confirm", tone: "green", artTone: "neutral",
      dataset: { equipTab: "uniform" }, title: "Return to squad equipment" });
    let header;
    if (active === "uniform") {
      header = `<div class="sq-tabbar sq-equip-native-nav">${nav}<span class="sq-equip-nav-spacer"></span>${
        DWFUI.plaqueBtnHtml({ label: "Update equipment", tone: "green", artTone: "neutral",
          disabled: true, title: "Native equipment refresh; automatic in Dwarf With Friends" })}</div>`;
    } else if (active === "add") {
      header = `<div class="sq-equip-native-head"><div class="sq-equip-native-title">Adding uniform</div>
        <div class="sq-equip-native-head-actions">${confirm}</div></div>`;
    } else if (active === "ammo") {
      header = `<div class="sq-equip-native-head"><div class="sq-equip-native-identity">${sqEmblemSwatch(squad, esc)}<span>${squadName}</span></div>
        <div class="sq-equip-native-head-actions">${DWFUI.plaqueBtnHtml({ label: "Add ammunition", tone: "green", artTone: "neutral",
          title: "Add ammunition below" })}${confirm}</div></div>`;
    } else if (active === "supplies") {
      header = `<div class="sq-equip-native-head"><div class="sq-equip-native-title">Supplies carried by each squad member</div>
        <div class="sq-equip-native-head-actions">${confirm}</div></div>
        <div class="sq-equip-native-identity sq-equip-supply-identity">${sqEmblemSwatch(squad, esc)}<span>${squadName}</span></div>`;
    } else {
      const member = (Array.isArray(squad.members) ? squad.members : []).find(m => Number(m.idx) === Number(posIndex));
      header = `<div class="sq-equip-native-head"><div class="sq-equip-native-identity">${sqEmblemSwatch(squad, esc)}
          <span>${squadName}<br>Position ${Number(member?.idx ?? posIndex) + 1}</span></div>
        <div class="sq-equip-native-head-actions">${confirm}${DWFUI.textInputHtml({ cls: "sq-input sq-equip-name",
          placeholder: "<enter name here>", ariaLabel: "Uniform name" })}
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.quill, title: "Name this uniform", ariaLabel: "Name this uniform" })}
          ${DWFUI.plaqueBtnHtml({ label: "Confirm and save uniform", tone: "green", artTone: "neutral", disabled: true,
            title: "Save becomes available after naming the uniform" })}</div></div>`;
    }
    return `${header}
      <div id="squadStatus" class="info-message sq-status" style="display:none"></div>
      <div class="sq-tab-body sq-equip-native-body">${body}</div>`;
  }

  // --- Schedule screen (native 7): one selected squad across routine columns. ---
  const MONTH_NAMES = ["Granite", "Slate", "Felsite", "Hematite", "Malachite", "Galena",
    "Limestone", "Sandstone", "Timber", "Moonstone", "Opal", "Obsidian"];
  const SLEEP_OPTIONS = [
    ["none", "(none)"], ["anywhere", "Anywhere at will"],
    ["barracks-will", "In barracks at will"], ["barracks-need", "In barracks at need"],
  ];
  const UNIFORM_MODE_OPTIONS = [["none", "(none)"], ["regular", "Regular"], ["civilian", "Civilian"]];

  // The routine overview's left cell: Add/edit routines · squad identity · View monthly. Shared by
  // the populated grid and the empty state, so a squad with no routines still reaches routine
  // authoring (the ONLY way to create its first routine) instead of dead-ending on a message.
  function sqScheduleSquadCell(squad, esc = sqEsc) {
    return `<section class="sq-schedule-squad-cell">
      ${DWFUI.plaqueBtnHtml({ label: "Add/edit routines (columns)", tone: "green", artTone: "neutral",
        dataset: { squadNav: "routines" }, title: "Add, rename or delete fort military routines" })}
      <div class="sq-equip-native-identity">${sqEmblemSwatch(squad, esc)}<span>${esc(squad.alias || squad.name || "Squad")}</span></div>
      ${DWFUI.plaqueBtnHtml({ label: "View monthly schedule", tone: "green", artTone: "neutral",
        dataset: { squadNav: "monthly" }, title: "View this squad's monthly schedule" })}
    </section>`;
  }

  function sqScheduleView(detail, esc = sqEsc) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const routines = Array.isArray(detail.routines) ? detail.routines : [];
    const routineScheds = Array.isArray(detail.routineSchedules) ? detail.routineSchedules : [];
    const header = `<div id="squadStatus" class="info-message sq-status" style="display:none"></div>`;
    if (!routines.length) {
      // Empty/degraded: no fort military routines are served. Keep the squad cell so the player can
      // still open "Add/edit routines" and author the first one (routine-create is a fort-global
      // route, independent of this squad having any). An old DLL that serves no routines surfaces
      // the POST error there rather than silently offering nothing.
      return `${header}
        <div class="sq-schedule-overview">
          ${sqScheduleSquadCell(squad, esc)}
          <div class="info-message">No military routines exist yet. Use “Add/edit routines” to create this squad's first training routine.</div>
        </div>`;
    }
    // B252. The COLUMN is the control. In DF, "how often this squad trains" is exactly
    // `squad.cur_routine_idx` (df.squad.xml:321, bay12 `current_routine_index`) -- the index into
    // squad.schedule.routine, which runs parallel to plotinfo.alerts.routines (the fort-wide named
    // routines that ARE these columns, df.alert_state.xml `alert_state_infost.routines`). Clicking
    // a column moves that one int32 and nothing else.
    //
    // Before this fix the only thing carrying the click was the little name plaque at the top of
    // the column; the CELL -- which is what a DF player clicks, because in native the header is a
    // label and the cell in the squad's row is the target -- was an inert <section>. And every cell
    // was painted at --dwfui-slab, native's SELECTED fill, so all four columns read as selected.
    // Now: the cell is a DWFUI selectCell (radio semantics, measured selected/unselected fills), and
    // the Edit/Copy plaques inside it stop their own clicks (they act on the cell, they do not pick
    // it -- see wireSquadScheduleControls).
    const routineCells = routines.map(routine => {
      const served = routineScheds.find(rs => Number(rs.idx) === Number(routine.idx));
      const month = served && Array.isArray(served.months) ? served.months[0] : null;
      const label = month ? (month.orderLabel || (month.hasTrain ? "Train" : "No orders")) :
        (Number(routine.idx) === Number(squad.routineIdx) ? "Monthly orders" : "No orders");
      const actionLabel = month && month.hasTrain ? "Clear" : "Edit";
      const active = Number(routine.idx) === Number(squad.routineIdx);
      const name = routine.name || ("Routine " + routine.idx);
      const inner = `
        ${DWFUI.plaqueBtnHtml({ label: name, artTone: "neutral", cls: "sq-schedule-routine-name" })}
        <div class="sq-schedule-routine-order${month && month.hasTrain ? " active" : ""}">${esc(label)}</div>
        <div class="sq-schedule-routine-actions">
          ${DWFUI.plaqueBtnHtml({ label: actionLabel, tone: month && month.hasTrain ? "orange" : "green",
            artTone: "neutral", cls: "sq-schedule-edit", dataset: { trainRoutine: routine.idx, trainMonth: 0 },
            title: "Edit this routine's current-month order" })}
          ${DWFUI.plaqueBtnHtml({ label: "Copy", tone: "green", artTone: "neutral", cls: "sq-schedule-copy",
            dataset: { copyRoutine: routine.idx, copyMonth: 0 }, disabled: true,
            title: "Copying routine orders is not served by the current game bridge" })}
        </div>`;
      return DWFUI.selectCellHtml({
        selected: active, cls: "sq-schedule-routine",
        dataset: { routineIdx: routine.idx, scheduleRoutine: routine.idx },
        title: active ? `${name} is this squad's active routine`
                      : `Put this squad on the ${name} routine`,
        ariaLabel: name,
      }, inner);
    }).join("");
    return `${header}
      <div class="sq-schedule-overview">
        ${sqScheduleSquadCell(squad, esc)}
        ${DWFUI.selectCellGroupHtml({ cls: "sq-schedule-routines",
          ariaLabel: "Training routine for this squad" }, routineCells)}
      </div>`;
  }

  // --- Add/Edit Routines (native 7.1): fort-global routine list authoring. Reached from the
  // schedule screen. Routines come from detail.routines (idx+name). create/rename/delete post to
  // /routine-* (graceful: a build without the routes surfaces the POST error, no console error). ---
  function sqRoutinesView(detail, esc = sqEsc) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const routines = Array.isArray(detail.routines) ? detail.routines : [];
    const rows = routines.length
      ? routines.map(r => `<div class="sq-routine-row" data-routine-idx="${r.idx}">
          <input class="sq-input sq-routine-name" type="text" maxlength="64" value="${esc(r.name || ("Routine " + r.idx))}">
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.quill, cls: "sq-routine-rename",
            title: "Rename this routine", ariaLabel: "Rename this routine" })}
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump, cls: "sq-danger sq-routine-delete",
            title: "Delete this routine (all squads lose it)", ariaLabel: "Delete this routine" })}
        </div>`).join("")
      : `<div class="info-message">No routines.</div>`;
    return `
      <div id="squadStatus" class="info-message sq-status" style="display:none"></div>
      <div class="sq-routine-head"><div class="sq-section-title">Military routines</div>
        ${sqBackPlaque("Done")}</div>
      ${DWFUI.scrollHtml({ cls: "sq-routine-list", preserveKey: "squads:routines" }, rows)}
      <div class="sq-controls">
        <input class="sq-input sq-routine-newname" id="routineNewName" type="text" maxlength="64" placeholder="New routine name...">
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Add new routine", tone: "green", artTone: "neutral",
          title: "Create a new fort military routine" }), "routineAddBtn")}
      </div>`;
  }

  // --- View Monthly Schedule (native 7.2): a squad's full months x routines grid. Each cell shows
  // that routine-month's order label; Edit opens the training editor (7.3). Data =
  // detail.routineSchedules[] (absent on old DLL -> graceful message). ---
  function sqMonthlyView(detail, esc = sqEsc) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const header = `${sqBackHeader(squad, esc)}
      <div id="squadStatus" class="info-message sq-status" style="display:none"></div>`;
    const routineScheds = Array.isArray(detail.routineSchedules) ? detail.routineSchedules : [];
    if (!routineScheds.length) {
      return header + `<div class="info-message">This build does not serve the full monthly schedule.</div>`;
    }
    const headCells = routineScheds.map(rs => `<div class="sq-month-head">${esc(rs.name || ("Routine " + rs.idx))}</div>`).join("");
    const monthRows = MONTH_NAMES.map((mn, m) => {
      const cells = routineScheds.map(rs => {
        const month = Array.isArray(rs.months) ? rs.months.find(x => x.month === m) : null;
        const label = month ? esc(month.orderLabel || "No orders") : "—";
        const cls = month && month.hasTrain ? " sq-month-train" : "";
        return `<div class="sq-month-cell${cls}">
          <span class="sq-month-order">${label}</span>
          ${DWFUI.plaqueBtnHtml({ label: "Edit", tone: "green", artTone: "neutral",
            cls: "sq-month-edit", dataset: { trainRoutine: rs.idx, trainMonth: m },
            title: "Edit this routine-month's training order" })}
          ${DWFUI.plaqueBtnHtml({ label: "Copy", tone: "green", artTone: "neutral",
            cls: "sq-month-copy", dataset: { copyRoutine: rs.idx, copyMonth: m }, disabled: true,
            title: "Copying routine-month orders is not served by the current game bridge" })}
        </div>`;
      }).join("");
      return `<div class="sq-month-row"><div class="sq-month-name">${esc(mn)}</div>${cells}</div>`;
    }).join("");
    return `${header}
      <div class="sq-section-title">Monthly schedule</div>
      ${DWFUI.scrollHtml({ cls: "sq-month-grid", preserveKey: "squads:monthly" },
        `<div class="sq-month-row sq-month-header"><div class="sq-month-name"></div>${headCells}</div>
        ${monthRows}`)}`;
  }

  // --- Edit Training (native 7.3): edit ONE routine-month -- its Equip (uniform) + Sleep modes,
  // plus a Train order toggle with a minimum-soldier count ("At least N / Train"). `sel` =
  // {routine,month}. Data from detail.routineSchedules; Save posts /squad-schedule set-month +
  // set-month-order. Native also shows the full per-position assignment roster below the order. ---
  function sqTrainingView(detail, sel, esc = sqEsc, draft = null) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const header = `<div class="sq-back-head">
        ${sqBackPlaque("Back to schedule")}
        <div class="sq-back-title">${esc(squad.alias || squad.name || ("Squad " + squad.id))}</div>
      </div>
      <div id="squadStatus" class="info-message sq-status" style="display:none"></div>`;
    const routineScheds = Array.isArray(detail.routineSchedules) ? detail.routineSchedules : [];
    const rs = routineScheds.find(x => x.idx === (sel && sel.routine));
    const month = rs && Array.isArray(rs.months) ? rs.months.find(x => x.month === (sel && sel.month)) : null;
    if (!rs || !month) {
      return header + `<div class="info-message">This build does not serve the editable schedule.</div>`;
    }
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
    const roster = members.map(member => {
      const filled = !!member.filled;
      const name = filled ? (member.name || ("Unit " + member.unitId)) : "Vacant position";
      const sub = filled ? (member.positionName || "No orders") : "No orders";
      return `<div class="sq-training-member" data-training-position="${member.idx}">
        <div class="sq-training-member-who">${filled ? sqUnitPortrait(member) : ""}<span>${esc(name)}<small>${esc(sub)}</small></span></div>
        ${DWFUI.checkHtml({ checked: assignmentServed && assignmentIds.includes(Number(member.idx)),
          cls: "sq-training-member-check", disabled: !assignmentServed,
          dataset: { trainingPosition: member.idx },
          title: assignmentServed ? "Include this position in the order" : "Per-position assignment is not served by the current game bridge",
          ariaLabel: `Include ${name} in the training order` })}
      </div>`;
    }).join("");
    return `${header}
      <div class="sq-section-title">Editing routine ${esc(rs.name || ("Routine " + rs.idx))} &middot; ${esc(MONTH_NAMES[month.month] || ("Month " + (month.month + 1)))}</div>
      <div class="sq-controls">
        <label class="sq-ammo-flag">Equip&nbsp;${DWFUI.segmentedHtml({ cls: "sq-train-uniform",
          dataAttr: "train-uniform", active: String(uniform), ariaLabel: "Equip (uniform) mode",
          options: UNIFORM_MODE_OPTIONS.map(([v, label]) => ({ key: v, label })) })}</label>
        <label class="sq-ammo-flag">Sleep&nbsp;${DWFUI.segmentedHtml({ cls: "sq-train-sleep",
          dataAttr: "train-sleep", active: String(sleep), ariaLabel: "Sleep mode",
          options: SLEEP_OPTIONS.map(([v, label]) => ({ key: v, label })) })}</label>
      </div>
      <div class="sq-controls">
        <label class="sq-ammo-flag">${sqWithId(DWFUI.checkHtml({ checked: train,
          dataset: { trainOrder: "" }, title: "Train order", ariaLabel: "Train order" }), "trainOrder")}Train</label>
        <label class="sq-ammo-flag">Min soldiers&nbsp;${sqStepperHtml({
          cls: "sq-pos-input sq-train-min", inputCls: "sq-input sq-train-min-input",
          inputId: "trainMin", min: 0, max: 99, value: min, ariaLabel: "Minimum soldiers" })}</label>
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Save", tone: "green", artTone: "neutral",
          title: "Save this routine-month's schedule" }), "trainSaveBtn")}
      </div>
      <div class="sq-training-order-summary"><span>At least ${min}</span><strong>Train</strong></div>
      ${DWFUI.scrollHtml({ cls: "sq-training-roster", preserveKey: "squads:training-roster" },
        roster || `<div class="info-message">This squad has no positions.</div>`)}`;
  }

  // --- Emblem edit screen (native 3): symbol grid + fg/bg colour pickers. ---
  // Reached only when the squad carries an `emblem` object. `draft` is the client-side working
  // copy (symbol + fg + bg), so the preview updates live before the single POST on Done.
  function sqEmblemView(detail, draft, esc = sqEsc) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const emblem = draft || squad.emblem;
    if (!emblem) {
      return sqBackHeader(squad, esc) +
        `<div class="info-message">This build does not serve squad-emblem data, so it cannot be edited here.</div>`;
    }
    const sym = Number(emblem.symbol) || 0;
    const previewGlyph = (sym >= 0 && sym < SQUAD_SYMBOL_GLYPHS.length)
      ? esc(SQUAD_SYMBOL_GLYPHS[sym]) : "?";
    // ---- EVIDENCE-BLOCKED, DELIBERATELY LEFT (Gate C) --------------------------------------------
    // The 23 symbol tiles CANNOT be migrated onto a DWFUI builder honestly:
    //   * their TRUE art is DF's graphics-mode tileset (df.squad.xml symbol_index 0..22), which lives
    //     behind the off-limits renderer/atlas files -- there is NO interface_map token for them, so
    //     `iconHtml({sprite})` has nothing to name and `artBtnHtml` renders an EMPTY tile;
    //   * `plaqueBtnHtml` paints its label through the DF BITMAP font, which has no glyph for `★`/`◆`
    //     -- a symbol grid drawn with it would come out BLANK.
    // A blank grid is worse than the Unicode stand-in the file already documents as a handoff, so
    // these 23 buttons stay hand-built and are reported as an ART GAP, not migrated into a lie.
    // They are therefore left BYTE-IDENTICAL (their selection paint is already a gold OUTLINE, not a
    // fill, so it does not violate the selection invariant either).
    const grid = SQUAD_SYMBOL_GLYPHS.map((g, i) =>
      `<button class="sq-rowicon sq-symbol-btn" data-emblem-symbol="${i}" title="Symbol ${i}" style="width:26px;height:26px;font-size:15px${i === sym ? ";border-color:#ffb74d;color:#ffd97a" : ""}">${esc(g)}</button>`).join("");
    return `
      ${sqBackHeader(squad, esc)}
      <div id="squadStatus" class="info-message sq-status" style="display:none"></div>
      <div class="sq-controls" style="align-items:center">
        <span class="sq-emblem" id="emblemPreview" style="background:${sqRgbCss(emblem.bg)};color:${sqRgbCss(emblem.fg)}">${previewGlyph}</span>
        <span>Choose a symbol for the squad.</span>
      </div>
      <div class="sq-section-title">Symbol</div>
      <div class="sq-emblem-grid" style="display:flex;flex-wrap:wrap;gap:4px">${grid}</div>
      <div class="sq-section-title">Colours</div>
      <div class="sq-controls">
        ${/* WIRED SUPERSET, NO BUILDER EXISTS. `<input type=color>` is the OS colour dialog, which is
             not DF chrome -- but DWFUI ships NO colour component, and the Foundation is LOCKED this
             wave. Deleting these two inputs would amputate /squad-emblem's fg+bg (squads.cpp). They
             STAY, and the missing native picker is reported as a FOUNDATION GAP. */""}
        <label class="sq-ammo-flag">Symbol&nbsp;<input type="color" id="emblemFg" value="${sqRgbToHex(emblem.fg)}"></label>
        <label class="sq-ammo-flag">Background&nbsp;<input type="color" id="emblemBg" value="${sqRgbToHex(emblem.bg)}"></label>
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Done", tone: "green", artTone: "confirm",
          title: "Save this emblem" }), "emblemDoneBtn")}
      </div>`;
  }

  // --- Defend-burrow order (native 2.4): a burrow checklist + Confirm/Cancel. Server now
  // accepts /squad-order action=defend-burrow&burrows=<csv ids>. `burrows` is the GET /burrows
  // list (null = fetch failed/unavailable, [] = fort has no burrows yet). ---
  function sqBurrowDefendView(squad, burrows, esc = sqEsc, checked = null) {
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const on = id => !!(checked && typeof checked.has === "function" && checked.has(String(id)));
    const header = `<div id="squadStatus" class="info-message sq-status" style="display:none"></div>
      <div class="sq-section-title">Select which burrows to defend.</div>`;
    // PB-06 / F9-a: this is the SMALL LEFT-DOCKED NATIVE DIALOG (`2.4`, 968x988 = 1.45 SB x 0.72 VH),
    // not a wide window. It has NO header and NO close: a white PROMPT LINE, then the choice.
    const wrap = body => `${sqBackHeader(squad, esc)}${DWFUI.modalHtml({
      cls: "sq-modal sq-burrow-modal", prompt: "Select which burrows to defend.",
      ariaLabel: "Select which burrows to defend",
    }, body)}`;
    if (burrows === null) {
      return wrap(header + `<div class="info-message">Burrows unavailable (this build may not support the defend-burrow order).</div>`);
    }
    if (!burrows.length) {
      return wrap(header + `<div class="info-message">No burrows exist yet. Create one in the Burrows panel first.</div>`);
    }
    const rows = burrows.map(b => {
      const name = esc(b.name || ("Burrow " + b.id));
      const count = Number(b.memberCount) || 0;
      return `<div class="sq-pos-row">
        <label class="sq-ammo-flag">${DWFUI.checkHtml({ checked: on(b.id), cls: "sq-burrow-check",
          dataset: { burrowId: b.id }, title: `Defend ${b.name || ("Burrow " + b.id)}`,
          ariaLabel: `Defend ${b.name || ("Burrow " + b.id)}` })}${name}</label>
        <span class="sq-skill-hint">${count} member${count === 1 ? "" : "s"}</span>
      </div>`;
    }).join("");
    return wrap(`${header}
      ${DWFUI.scrollHtml({ cls: "sq-burrow-list", preserveKey: "squads:burrows" }, rows)}
      <div class="sq-controls">
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Confirm", tone: "green", artTone: "confirm",
          title: "Issue defend order for the checked burrows" }), "burrowDefendConfirmBtn")}
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Cancel", tone: "grey",
          title: "Abandon the defend-burrow order" }), "burrowDefendCancelBtn")}
      </div>`);
  }

  // Patrol route editor (native 2.3). The view is pure so Parity Studio can render the exact
  // production component with seeded points. The browser wiring below owns map clicks and POST.
  function sqPatrolView(squad, draft, esc = sqEsc) {
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const route = draft || { name: "Route 1", points: [] };
    const points = Array.isArray(route.points) ? route.points : [];
    const hasDistinctPair = points.some((p, i) => i > 0 &&
      (Number(p.x) !== Number(points[0].x) || Number(p.y) !== Number(points[0].y) || Number(p.z) !== Number(points[0].z)));
    // R9: a native patrol row is a plain `Point N` + a trash tile. The `x N, y N, z N` span was
    // computed and thrown away -- no handler, no route, no selector reads it (the ONLY control on
    // the row is the sibling data-patrol-remove button, which carries its own index). It is the one
    // TRUE deletion in this file (S2-deletion-audit A14); the draft's points are untouched.
    const rows = points.length ? points.map((p, index) => `<div class="sq-pos-row sq-patrol-point">
      <span class="sq-pos-role">Point ${index + 1}</span>
      ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump, dataset: { patrolRemove: index },
        title: `Remove point ${index + 1}`, ariaLabel: `Remove point ${index + 1}` })}
    </div>`).join("") : `<div class="info-message">No points yet. Click the map to add the first point.</div>`;
    // PB-06 / F9-a: native `2.3` is 967x991 -- the SAME small left-docked dialog as create and
    // defend-burrow, NOT a wide window. Confirm's TWO-DISTINCT-POINT rule is DELIBERATELY UNCHANGED:
    // native's PB-08(f) only attests "disabled at 0 points", so our rule may be STRICTER than native's
    // and loosening it on no evidence would be an invention. It stays exactly as it shipped.
    return `${sqBackHeader(squad, esc)}${DWFUI.modalHtml({
      cls: "sq-modal sq-patrol-modal", prompt: "Assign patrol route",
      ariaLabel: "Assign patrol route",
    }, `
      <div id="squadStatus" class="info-message sq-status" style="display:none"></div>
      <label class="sq-field-label" for="patrolRouteName">Route name</label>
      <input class="sq-text-input" id="patrolRouteName" maxlength="80" value="${esc(route.name || "Route 1")}" aria-label="Patrol route name">
      <div class="info-message">Click the map to add points. Change floors between clicks if the route uses stairs.</div>
      ${DWFUI.scrollHtml({ cls: "sq-patrol-list", preserveKey: "squads:patrol" }, rows)}
      <div class="sq-controls">
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Confirm", tone: "green", artTone: "confirm",
          disabled: !hasDistinctPair, title: "A patrol route needs two different points" }), "patrolConfirmBtn")}
        ${sqWithId(DWFUI.plaqueBtnHtml({ label: "Cancel", tone: "grey",
          title: "Abandon the patrol route" }), "patrolCancelBtn")}
      </div>`)}`;
  }

  // R7: native's back affordance is a CENTRED GREEN PLAQUE reading "Back to squads" -- not a "←"
  // arrow (TOKENS.sprites.back is the BUILDING-header arrow and squads does not use it).
  function sqBackPlaque(label = "Back to squads") {
    return sqWithId(DWFUI.plaqueBtnHtml({ label, tone: "green", cls: "sq-back-plaque" }), "squadBackBtn");
  }

  function sqBackHeader(squad, esc = sqEsc) {
    const displayName = esc(squad.alias || squad.name || ("Squad " + squad.id));
    return `<div class="sq-back-head">
      ${sqBackPlaque()}
      <div class="sq-back-title">${displayName}</div>
    </div>`;
  }

  // ---- PB-06 / F9-a: CREATE IS THE SMALL LEFT-DOCKED DIALOG, NOT A WIDE WINDOW. ------------------
  // MEASURED on the oracle `Menu Oracle Screenshots/Squad Menu UI/8. Create New Squad Menu.PNG`:
  // 967x990 = a 565px dialog + a 3px gutter + the 391px sidebar. We shipped it at `.squads-wide`
  // (880px) -- roughly THREE TIMES too wide. That is the "small native dialogs represented as large
  // generic panels", quantified. `modalHtml` IS that dialog: 1.45 SB x 0.72 VH, top-aligned, a white
  // PROMPT LINE instead of a header, and NO close button (dismissal is Back, or making the choice).
  //
  // Native's create STEP 2 is the separate uniform chooser built immediately below this screen.
  // B233-3 (census #70 / M3 remainder): the chooser used to list ONLY the squad seats that already
  // existed (freePositions). Native's chooser also offers to MAKE one -- "a new militia captain" --
  // because MILITIA_CAPTAIN's raw is [NUMBER:AS_NEEDED] (entity_default.txt:546), i.e. the fort may
  // hold unlimited captains. The server now sends `creatablePositions` (squads.cpp: squad-capable
  // positions whose entity_position.number still allows another holder), and picking one POSTs
  // /position-create (making the vacant seat) and then /squad-create with the new assignment id --
  // the same two steps DF performs internally.
  function sqCreateView(list, esc = sqEsc) {
    const positions = Array.isArray(list && list.freePositions) ? list.freePositions.slice() : [];
    const creatable = Array.isArray(list && list.creatablePositions) ? list.creatablePositions : [];
    const categoryOrder = { existing: 0, appoint: 1, new: 2 };
    positions.sort((a, b) => (categoryOrder[a.category] ?? 1) - (categoryOrder[b.category] ?? 1));
    const header = `<div class="sq-back-head">
      ${sqBackPlaque()}
      <div class="sq-back-title">Create which squad?</div>
    </div>`;
    const wrap = body => `${header}${DWFUI.modalHtml({
      cls: "sq-modal sq-create-modal", prompt: "Create which squad?",
      ariaLabel: "Create which squad?",
    }, `<div id="squadStatus" class="info-message sq-status" style="display:none"></div>${body}`)}`;
    if (!positions.length && !creatable.length) {
      return wrap(`<div class="info-message">No free squad positions are available, and the fort's raws allow no further squad-leading positions.</div>`);
    }
    const positionRows = positions.map(p => {
      const category = p.category || (p.holderName ? "existing" : "appoint");
      const sub = esc(p.holderName || p.appointLabel || "available");
      const count = Number(p.squadSize) || 0;
      return { category, html: DWFUI.rowHtml({
        tag: "button", cls: "sq-pos-row sq-create-row", chassis: "slab", state: "on",
        dataset: { squadCreatePosition: p.assignmentId, createCategory: category },
        label: p.title || "New squad", labelCls: "sq-pos-role",
        sub: { html: DWFUI.rawHtml("create rows compose the served holder and position count into two cells",
          `<span class="sq-pos-who">${sub}</span><span class="sq-pos-actions">${count} positions</span>`), cls: "sq-create-meta" },
      }) };
    });
    const createRows = creatable.map(p => {
      const title = `New ${p.title || "position"}`;   // plain label slot: DWFUI renders bitmap text
      const held = Number(p.seats) || 0;
      const max = Number(p.maxSeats);
      const cap = Number.isFinite(max) && max >= 0 ? `${held}/${max} held` : `${held} held, unlimited`;
      const count = Number(p.squadSize) || 0;
      return DWFUI.rowHtml({
        tag: "button", cls: "sq-pos-row sq-create-row sq-create-new-position", chassis: "slab", state: "on",
        dataset: { squadCreateNewPosition: p.positionId, createCategory: "new" }, label: title, labelCls: "sq-pos-role",
        sub: { html: DWFUI.rawHtml("create rows compose the served seat capacity and position count into two cells",
          `<span class="sq-pos-who">${esc(cap)}</span><span class="sq-pos-actions">${count} positions</span>`), cls: "sq-create-meta" },
      });
    }).join("");
    // Preserve native's three separate vectors without inventing visible category headings: the
    // row wording is DF-served, while the wrappers retain existing / appoint / new semantics.
    const categoryBody = ["existing", "appoint"].map(category =>
      `<div class="sq-create-category" data-create-category-group="${category}">` +
      positionRows.filter(row => row.category === category).map(row => row.html).join("") + `</div>`).join("") +
      `<div class="sq-create-category" data-create-category-group="new">${createRows}</div>`;
    return wrap(DWFUI.scrollHtml({ cls: "sq-pos-list sq-create-list", preserveKey: "squads:create" }, categoryBody));
  }

  function sqCreateUniformView(catalog, pending, esc = sqEsc) {
    if (!pending) return `<div class="info-message">Choose which squad first.</div>`;
    const uniforms = Array.isArray(catalog && catalog.uniforms) ? catalog.uniforms : [];
    const title = pending.title || "new squad";
    const rows = uniforms.map(uniform => DWFUI.rowHtml({
      tag: "div", role: "button", cls: "sq-create-uniform-row", chassis: "slab", state: "on",
      dataset: { squadCreateUniform: uniform.id }, label: uniform.name || `Uniform ${uniform.id}`,
      trailing: DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump,
        dataset: { createUniformDelete: uniform.id }, title: `Delete ${uniform.name || "this uniform"}`,
        ariaLabel: `Delete ${uniform.name || "this uniform"}` }),
    })).join("");
    const none = DWFUI.rowHtml({
      tag: "button", cls: "sq-create-uniform-row sq-create-no-uniform", chassis: "slab", state: "on",
      dataset: { squadCreateUniform: -1 }, label: "No uniform",
    });
    return `${sqBackHeader({ name: title }, esc)}${DWFUI.modalHtml({
      cls: "sq-modal sq-create-uniform-modal", prompt: `Choose a uniform for the ${title}.`,
      ariaLabel: `Choose a uniform for the ${title}.`,
    }, `<div id="squadStatus" class="info-message sq-status" style="display:none"></div>` +
      DWFUI.scrollHtml({ cls: "sq-create-uniform-list", preserveKey: "squads:create-uniform" }, rows + none))}`;
  }

  function sqRootPane(squads, selectedId, hasFree, esc = sqEsc) {
    const selected = squads.find(s => s.id === selectedId) || null;
    const createBtn = sqWithId(DWFUI.plaqueBtnHtml({
      label: "Create new squad", tone: "green", artTone: "neutral", disabled: !hasFree,
      title: hasFree ? "Create a new squad"
                     : "No squad position is free, and the fort's raws allow no further squad-leading positions",
    }), "squadCreateBtn");
    return `<div class="sq-list">${sqListRows(squads, selectedId, esc)}</div>
      <div class="sq-selected">
        ${createBtn}
        ${selected ? sqSelectedActions(selected, esc) : `<div class="info-message sq-footer-note">Select a squad or squad member to give orders, change equipment, and assign schedules.</div>`}
      </div>`;
  }

  function sqContextLayout(body, squads, selectedId, hasFree, esc = sqEsc) {
    return `<div class="sq-context-layout"><main class="sq-context-main">${body}</main>
      <aside class="sq-equip-context" aria-label="Squads">${sqRootPane(squads, selectedId, hasFree, esc)}</aside></div>`;
  }

  // Top-level dispatcher: returns { wide, html } for the current model. `wide` drives the
  // .squads-wide CSS modifier so the dense editors get room (the B60 fix) while the root list
  // stays a slim 208px sidebar. Pure -> the fixture harness drives it with seeded models.
  function buildSquadPanel(model, esc = sqEsc) {
    const view = model.view || "list";
    const squadsList = model.squadsList || {};
    const squads = Array.isArray(squadsList.squads) ? squadsList.squads : [];
    // B233-3: "can we create a squad" is now free seats OR a position the raws let us add a seat to
    // (the create chooser offers both). The old gate said "appoint a militia captain in DF first"
    // even when the fort could simply be given another captain -- which is what native does for you.
    const creatable = Array.isArray(squadsList.creatablePositions) ? squadsList.creatablePositions : [];
    const hasFree = !!squadsList.hasFreePosition || creatable.length > 0;
    const detail = model.squadDetail || null;

    // `wide` drives `.squads-wide` on the panel HOST. `dialog` says the BODY is native's small
    // left-docked `modalHtml` frame (create / patrol / burrow -- the three 1.45 SB x 0.72 VH oracles).
    //
    // *** THE HOST STAYS WIDE ON A DIALOG VIEW, AND THAT IS A CSS-BLOCKED RESIDUE, NOT A CHOICE. ***
    // `.dwfui-modal` is 565px and absolutely positioned; `#clientPanel.squads-sidebar` is 300px with
    // `overflow:hidden`, so a dialog rendered into the NARROW host would be CLIPPED to half its width
    // -- strictly worse than the bug it fixes. Native docks the dialog OUTSIDE the sidebar (a 3px
    // gutter, `right:100%`), which is a POSITIONING property of `.dwfui-modal` and therefore CSS --
    // and CSS is LOCKED this wave (arch-spec §5/§7.4: migrate STRUCTURE first). So Gate C lands the
    // correct COMPONENT and the correct 565x72vh FRAME, and the dock offset is handed to the CSS
    // consolidation wave. Reported, not silently half-done.
    const sel = {
      uniformPick: model.uniformPick, uitemDrafts: model.uitemDrafts,
      uniformFlags: model.uniformFlagDraft, ammoAdd: model.ammoAddDraft,
      ammoRowDrafts: model.ammoRowDrafts,
    };
    if (view === "create") return { wide: true, dialog: true, html: sqCreateView(squadsList, esc) };
    if (view === "create-uniform") return { wide: true, dialog: true,
      html: sqCreateUniformView(model.uniformCatalog, model.createPending, esc) };
    if (view === "positions") return { wide: false, html: sqPositionsView(detail, esc) };
    if (view === "candidate") {
      const currentId = Number(detail?.squad?.id ?? model.squadSelectedId);
      const chooser = sqCandidateView(detail, model.squadCandidatePos, {
        sortKey: model.squadCandidateSort, sortDirection: model.squadCandidateSortDirection,
        search: model.squadCandidateSearch, isHost: model.isHost,
      }, esc);
      return { wide: true, contextual: true,
        html: `<div class="sq-context-layout sq-candidate-layout"><main class="sq-context-main">${chooser}</main>` +
          `<aside class="sq-equip-context" aria-label="Squad positions">${sqPositionsView(detail, esc)}</aside></div>` };
    }
    if (view === "equip") {
      const currentId = Number(detail?.squad?.id ?? model.squadSelectedId);
      const editor = sqEquipView(detail, model.uniformCatalog, model.equipTab, model.uniformSelectedId,
        model.equipmentPosition, model.equipmentPicker, esc, sel);
      // Native keeps the ordinary squad rail on the right in every equipment capture (5.1-5.5.2).
      // Reuse the root pane so squad switching and its order/equip/schedule controls cannot drift.
      return { wide: true, equipment: true, html: `<div class="sq-equip-layout"><div class="sq-equip-main">${editor}</div>` +
        `<aside class="sq-equip-context" aria-label="Squads">${sqRootPane(squads, currentId, hasFree, esc)}</aside></div>` };
    }
    if (view === "schedule") return { wide: true, contextual: true,
      html: sqContextLayout(sqScheduleView(detail, esc), squads, model.squadSelectedId, hasFree, esc) };
    if (view === "routines") return { wide: true, contextual: true,
      html: sqContextLayout(sqRoutinesView(detail, esc), squads, model.squadSelectedId, hasFree, esc) };
    if (view === "monthly") return { wide: true, contextual: true,
      html: sqContextLayout(sqMonthlyView(detail, esc), squads, model.squadSelectedId, hasFree, esc) };
    if (view === "training") return { wide: true, html: sqTrainingView(detail, model.trainingSel, esc, model.trainDraft) };
    if (view === "emblem") return { wide: true, html: sqEmblemView(detail, model.emblemDraft, esc) };
    if (view === "burrow") return { wide: true, dialog: true, html: sqBurrowDefendView(detail && detail.squad, model.squadBurrows, esc, model.burrowChecked) };
    if (view === "patrol") return { wide: true, dialog: true, html: sqPatrolView(detail && detail.squad, model.squadPatrolDraft, esc) };

    // list (root)
    if (!squads.length && !hasFree) {
      return { wide: false, html: `<div class="sq-empty-state">You must appoint a militia commander<br>to create a squad.</div>` };
    }
    // ---- DEFECT S2: "3 horizontal lines across the bottom for no reason". ------------------
    // Two causes, both fixed here. (1) The rows were 19px, so their hairline bottom borders stacked
    // up as three lines under a sliver of content -- S1's real row height disperses them into the
    // native BETWEEN-squads separators. (2) `.sq-list-pane`'s `border-bottom` sat DIRECTLY on top of
    // `.sq-selected`'s `border-top`: a doubled 2px rule that native does not have. The pane was a
    // pure wrapper (its only job was `flex:1 1 auto`, which `.sq-list` already declares), so it is
    // removed rather than restyled -- no CSS change, one hairline instead of two.
    return { wide: false, html: sqRootPane(squads, model.squadSelectedId, hasFree, esc) };
  }

  // ===========================================================================
  // RENDER + WIRING  (browser-only: reads module state, mutates the DOM)
  // ===========================================================================

  function goToView(view) {
    if (squadView === "patrol" && view !== "patrol" && window.DFSquadPatrol) window.DFSquadPatrol.disarm();
    if (view !== squadView) squadResetDrafts();   // a half-typed form does not survive leaving its screen
    squadView = view;
    squadStatusMsg = "";
    renderSquadsPanel();
  }

  function renderSquadsPanel() {
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
      squadPatrolDraft,
      equipmentPosition,
      equipmentPicker,
      squadCandidatePos,
      squadCandidateSort,
      squadCandidateSortDirection,
      squadCandidateSearch,
      createPending,
      isHost: squadIsHostClient(),
      uniformPick,
      uitemDrafts,
      uniformFlagDraft,
      ammoAddDraft,
      ammoRowDrafts,
      burrowChecked,
      trainDraft,
    };
    const { wide, equipment, contextual, html } = buildSquadPanel(model, sqEsc);
    clientPanel.className = "visible squads-sidebar" + (wide ? " squads-wide" : "") +
      (equipment ? " squads-equipment" : "") + (contextual ? " squads-contextual" : "");
    panelContent(clientPanel).innerHTML = `<div class="info-window"><div class="info-body sq-body">${html}</div></div>`;

    // --- shared wiring: squad selection + unit links ---
    clientPanel.querySelectorAll("[data-squad-id]").forEach(el => {
      el.addEventListener("click", async () => {
        squadSelectedId = Number(el.dataset.squadId);
        squadStatusMsg = "";
        await loadSquadDetail(squadSelectedId);
      });
    });
    // PB-05: the check tile IS the selection affordance, and it TOGGLES -- clicking a checked squad
    // deselects it, which is how the player gets back to the native unselected list (hint line, no
    // order strip). Before Wave 4 the client had no way to reach that state at all.
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
      // B233-3: the chooser also opens when the only option is CREATING a position (a fort with no
      // free captain seat but AS_NEEDED captains in its raws) -- that case used to skip the chooser
      // and call squadCreate(), which then failed with "no free squad position".
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
          title: button.querySelector(".sq-pos-role")?.textContent?.trim() || "new squad" };
        squadView = "create-uniform";
        renderSquadsPanel();
      });
    });
    // B233-3: remember the requested new seat, but make it only after native's uniform step.
    clientPanel.querySelectorAll("[data-squad-create-new-position]").forEach(button => {
      button.addEventListener("click", () => {
        createPending = { kind: "position", id: Number(button.dataset.squadCreateNewPosition),
          title: button.querySelector(".sq-pos-role")?.textContent?.trim() || "new squad" };
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
          await uniformPost("uniform-delete", { id: Number(button.dataset.createUniformDelete) });
          squadStatusMsg = "Uniform deleted.";
          await loadUniformCatalog();
        } catch (err) { squadStatusMsg = err.message || "Could not delete uniform."; }
        renderSquadsPanel();
      });
    });
    // S5: the redundant `Rename` plaque is gone (native reaches rename via the row's quill tile).
    // The INPUT is the rename control and it COMMITS ON ENTER -- the same squadRename() call the
    // deleted button made, so /squad-rename is reached with one fewer non-native affordance.
    clientPanel.querySelector("#squadRenameInput")?.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      squadRename(squadSelectedId, event.currentTarget.value);
    });
    clientPanel.querySelector("#squadDeleteBtn")?.addEventListener("click", () => squadDelete(squadSelectedId));

    // --- position roster -> dedicated native candidate screen ---
    clientPanel.querySelectorAll("[data-squad-pick-pos]").forEach(button => {
      button.addEventListener("click", () => {
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
    const candidateList = clientPanel.querySelector(".sq-candidate-list");
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
        if (equipTab === "add") uniformSelectedId = -1;
        squadResetDrafts();                      // a new sub-screen starts with a clean form
        renderSquadsPanel();
      });
    });

    // --- per-view detail wiring ---
    if (squadDetail && squadDetail.squad) {
      const squad = squadDetail.squad;
      // The selected-squad order toolbar (Kill/Station/Patrol/Defend/Train/Cancel) renders in the
      // ROOT list AND in the squad rail that equip/schedule/routines/monthly keep on the right
      // (sqRootPane). Wiring it only for `list` left those rail tiles dead. It is a safe no-op on the
      // views whose rail is not sqRootPane (positions/candidate/training/emblem/burrow/patrol): the
      // querySelectors simply find nothing.
      wireSquadOrderControls(squad);
      if (squadView === "schedule") wireSquadScheduleControls(squad);
      if (squadView === "routines") wireRoutinesControls(squad);
      if (squadView === "monthly") wireMonthlyControls(squad);
      if (squadView === "training") wireTrainingControls(squad);
      if (squadView === "emblem") wireEmblemControls(squad);
      if (squadView === "burrow") wireBurrowDefendControls(squad);
      if (squadView === "patrol") wirePatrolControls(squad);
      if (squadView === "equip") {
        if (equipTab === "uniform") wireSquadUniformControls(squad);
        if (equipTab === "ammo") wireSquadAmmoControls(squad);
        if (equipTab === "add") wireUniformEditorControls();
        if (equipTab === "supplies") wireSquadSuppliesControls(squad);
        if (equipTab === "details") wireSquadEquipmentControls(squad);
      }
    }

    squadSetStatus(squadStatusMsg);
  }

  // ---------------------------------------------------------------------------
  // GENERIC CONTROL WIRING: one handler per native control family.
  // Each cycler slice carries `data-sq-cyc` (which chooser) + `data-sq-val` (the value that slice
  // jumps to, computed at BUILD time). So this is a pure dispatch: no index maths, no DOM read of a
  // `select`, and the exact same value the removed `select`.value carried reaches the exact same POST.
  // ---------------------------------------------------------------------------
  function wireCyclers() {
    clientPanel.querySelectorAll("[data-sq-cyc]").forEach(slice => {
      slice.addEventListener("click", async event => {
        event.stopPropagation();
        const key = slice.dataset.sqCyc;
        const raw = slice.dataset.sqVal;
        if (raw === "" || raw == null) return;              // an empty chooser is inert, not broken
        const squad = squadDetail && squadDetail.squad;
        switch (key) {
          case "uniformPick":                                // was .sq-uniform-select[data-uniform-pos]
            uniformPick[Number(slice.dataset.uniformPos)] = Number(raw); renderSquadsPanel(); return;
          case "uniformSelect":                              // was #uniformSelect
            // A DIFFERENT template has DIFFERENT flags: drop the drafts so they re-seed from it,
            // exactly as the old checkboxes re-rendered with the new template's `checked` state.
            uniformSelectedId = Number(raw);
            uniformFlagDraft = null; uitemDrafts = {};
            renderSquadsPanel(); return;
          case "uitemSubtype": {                             // was .sq-uitem-subtype
            const cat = Number(slice.dataset.ucat);
            uitemDrafts[cat] = Object.assign({}, uitemDrafts[cat], { subtype: Number(raw) });
            renderSquadsPanel(); return;
          }
          case "uitemMat": {                                 // was .sq-uitem-mat
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
          case "equipPos":                                   // was #equipmentPositionSelect
            equipmentPosition = Number(raw) || 0; equipmentPicker = null;
            renderSquadsPanel(); return;
          case "routine": {                                  // was #squadRoutineSelect (posts on change)
            if (!squad) return;
            try {
              await squadSchedulePost({ squad: squad.id, action: "set-routine", routine: Number(raw) });
              squadStatusMsg = "Active routine changed.";
            } catch (err) { squadStatusMsg = err.message || "Could not change routine."; }
            await loadSquadDetail(squad.id); return;
          }
          default: return;
        }
      });
    });
  }

  // The native stepper's three gold tiles (`#`, `+`, `-`). They edit the SIBLING <input> -- the
  // deliberate editable exception, which is still the control every submit handler reads -- so no
  // POST fires here and no behaviour changed: `+` is a keystroke the player did not have to type.
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
  // B70: targets is the marked selection set ([{id,name}]); the kill flow stays armed while the
  // player clicks several units, then one Confirm sends them all.
  const squadKillArmedFor = { id: -1, targets: [] };
  async function squadOrderPost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
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
            loadSquadDetail(squad.id);
          };
          window.DFSquadMove.onDisarmed = () => { squadMoveArmedFor.id = -1; renderSquadsPanel(); };
          window.DFSquadMove.arm(squad.id);
        }
        renderSquadsPanel();
      });
    }
    clientPanel.querySelector("#squadOrderTrainBtn")?.addEventListener("click", async () => {
      try {
        await squadOrderPost({ squad: squad.id, action: "train" });
        squadStatusMsg = "Train order issued.";
      } catch (err) { squadStatusMsg = err.message || "Train order failed."; }
      await loadSquadDetail(squad.id);
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
            const at = squadKillArmedFor.targets.findIndex(t => t.id === id);
            if (at >= 0) squadKillArmedFor.targets.splice(at, 1);   // click again to unmark
            else squadKillArmedFor.targets.push({ id, name });
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
      await loadSquadDetail(squad.id);
    });
    clientPanel.querySelector("#squadOrderKillCancelBtn")?.addEventListener("click", () => {
      squadKillArmedFor.id = -1;
      squadKillArmedFor.targets = [];
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
      await loadSquadDetail(squad.id);
    });
    // Defend-burrow -> open the burrow checklist screen (native 2.4). Loads /burrows lazily,
    // then paints once (avoids flashing the "unavailable" state while the fetch is in flight).
    clientPanel.querySelector("#squadOrderBurrowBtn")?.addEventListener("click", async () => {
      squadStatusMsg = "";
      await squadLoadBurrows();
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
        await loadSquadDetail(squad.id);
      });
    });
  }

  // Native patrol flow: the editor remains open and map selection remains armed until Confirm,
  // Cancel, or Back. Map clicks arrive as persistent world coordinates from controls-placement.
  function wirePatrolControls(squad) {
    const nameInput = clientPanel.querySelector("#patrolRouteName");
    nameInput?.addEventListener("input", () => { squadPatrolDraft.name = nameInput.value; });
    clientPanel.querySelectorAll("[data-patrol-remove]").forEach(button => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.patrolRemove);
        if (index >= 0) squadPatrolDraft.points.splice(index, 1);
        renderSquadsPanel();
      });
    });
    if (window.DFSquadPatrol) {
      window.DFSquadPatrol.onPoint = pos => {
        if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return;
        const last = squadPatrolDraft.points[squadPatrolDraft.points.length - 1];
        if (!last || last.x !== pos.x || last.y !== pos.y || last.z !== pos.z)
          squadPatrolDraft.points.push({ x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) });
        squadStatusMsg = `${squadPatrolDraft.points.length} route point${squadPatrolDraft.points.length === 1 ? "" : "s"}.`;
        renderSquadsPanel();
      };
      window.DFSquadPatrol.arm(squad.id);
    }
    clientPanel.querySelector("#patrolConfirmBtn")?.addEventListener("click", async () => {
      squadPatrolDraft.name = nameInput ? nameInput.value : squadPatrolDraft.name;
      const points = squadPatrolDraft.points.map(p => `${p.x}:${p.y}:${p.z}`).join(";");
      try {
        await squadOrderPost({ squad: squad.id, action: "patrol", name: squadPatrolDraft.name, points });
        squadStatusMsg = "Patrol order issued.";
        if (window.DFSquadPatrol) window.DFSquadPatrol.disarm();
        squadView = "list";
        await loadSquadDetail(squad.id);
      } catch (err) {
        squadStatusMsg = err.message || "Patrol order failed.";
        renderSquadsPanel();
      }
    });
    clientPanel.querySelector("#patrolCancelBtn")?.addEventListener("click", () => goToView("list"));
  }

  // --- emblem edit wiring (native screen 3) ---
  // Live client-side draft; a single POST /squad-emblem on Done writes all fields, then /squads
  // is re-read. hex "#rrggbb" -> {r,g,b}.
  function sqHexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
    if (!m) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  async function squadEmblemPost(squadId, e) {
    const q = new URLSearchParams({
      player, squad: squadId, symbol: e.symbol,
      fgR: e.fg.r, fgG: e.fg.g, fgB: e.fg.b,
      bgR: e.bg.r, bgG: e.bg.g, bgB: e.bg.b,
    }).toString();
    return squadFetchJson(`/squad-emblem?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireEmblemControls(squad) {
    // Seed the draft from the served emblem the first time we enter the screen.
    if (!emblemDraft) {
      const base = squad.emblem;
      if (!base) return;   // no emblem data -> the view already shows the graceful message
      emblemDraft = { symbol: Number(base.symbol) || 0, fg: Object.assign({}, base.fg), bg: Object.assign({}, base.bg) };
    }
    const preview = clientPanel.querySelector("#emblemPreview");
    const repaintPreview = () => {
      if (!preview) return;
      preview.style.background = sqRgbCss(emblemDraft.bg);
      preview.style.color = sqRgbCss(emblemDraft.fg);
      const s = emblemDraft.symbol;
      preview.textContent = (s >= 0 && s < SQUAD_SYMBOL_GLYPHS.length) ? SQUAD_SYMBOL_GLYPHS[s] : "?";
    };
    clientPanel.querySelectorAll("[data-emblem-symbol]").forEach(btn => {
      btn.addEventListener("click", () => {
        emblemDraft.symbol = Number(btn.dataset.emblemSymbol);
        // Re-render so the grid highlight + preview reflect the new selection.
        renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#emblemFg")?.addEventListener("input", event => {
      emblemDraft.fg = sqHexToRgb(event.target.value); repaintPreview();
    });
    clientPanel.querySelector("#emblemBg")?.addEventListener("input", event => {
      emblemDraft.bg = sqHexToRgb(event.target.value); repaintPreview();
    });
    clientPanel.querySelector("#emblemDoneBtn")?.addEventListener("click", async () => {
      const draft = emblemDraft;
      try {
        await squadEmblemPost(squad.id, draft);
        squadStatusMsg = "Emblem saved.";
        emblemDraft = null;
        squadView = "list";
        await refreshSquads();       // re-read /squads so the row badge reflects the write
      } catch (err) {
        squadStatusMsg = err.message || "Could not save emblem.";
        renderSquadsPanel();         // stay on the editor; draft preserved
      }
    });
  }

  // --- defend-burrow wiring (native screen 2.4) ---
  // Local /burrows fetch (the retired standalone panel was read-only, so this owns its fetch).
  // null on failure so the view degrades gracefully.
  async function squadLoadBurrows() {
    try {
      const data = await squadFetchJson(`/burrows?player=${encodeURIComponent(player)}&t=${Date.now()}`);
      squadBurrows = Array.isArray(data.burrows) ? data.burrows : [];
    } catch (_) {
      squadBurrows = null;
    }
  }

  // The burrow checklist is now the native 2-state check TILE. `burrowChecked` holds what the DOM
  // checkboxes' `.checked` held; Confirm still sends the SAME comma-separated id list.
  function wireBurrowDefendControls(squad) {
    if (!burrowChecked) burrowChecked = new Set();
    clientPanel.querySelectorAll("[data-burrow-id]").forEach(tile => {
      tile.addEventListener("click", event => {
        event.preventDefault();
        const id = String(tile.dataset.burrowId);
        if (burrowChecked.has(id)) burrowChecked.delete(id); else burrowChecked.add(id);
        renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#burrowDefendCancelBtn")?.addEventListener("click", () => goToView("list"));
    clientPanel.querySelector("#burrowDefendConfirmBtn")?.addEventListener("click", async () => {
      const ids = Array.from(burrowChecked || []);
      if (!ids.length) { squadStatusMsg = "Check at least one burrow."; renderSquadsPanel(); return; }
      try {
        await squadOrderPost({ squad: squad.id, action: "defend-burrow", burrows: ids.join(",") });
        squadStatusMsg = "Defend-burrow order issued.";
        squadView = "list";
        await loadSquadDetail(squad.id);   // re-read detail so the new order surfaces
      } catch (err) {
        // 501 (old DLL) / 400 -> show the error and stay on the picker (control reverts).
        squadStatusMsg = err.message || "Could not issue defend-burrow order.";
        renderSquadsPanel();
      }
    });
  }

  // --- schedule editor wiring ---
  async function squadSchedulePost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return squadFetchJson(`/squad-schedule?${q}&t=${Date.now()}`, { method: "POST" });
  }

  // Native chooses the active routine from the routine columns, not from a separate browser dropdown.
  // Per-month Sleep/Uniform editing lives in the monthly -> training flow below, matching screens 7.2/7.3.
  //
  // B252: the click target is the whole COLUMN CELL (DWFUI.selectCellHtml -> role=radio, focusable),
  // so a player clicking anywhere on "Constant training" -- its header, its order line, its dead
  // space -- puts the squad on that routine. POST /squad-schedule?action=set-routine writes
  // squad.cur_routine_idx (bounds-checked in do_squad_set_routine, src/squads.cpp); a rejected write
  // is surfaced, never swallowed.
  function wireSquadScheduleControls(squad) {
    const pickRoutine = async raw => {
      const idx = Number(raw);
      if (!Number.isFinite(idx)) return;
      if (idx === Number(squad.routineIdx)) return;   // already the active routine -> no pointless write
      try {
        await squadSchedulePost({ squad: squad.id, action: "set-routine", routine: idx });
        squadStatusMsg = "Active routine changed.";
      } catch (err) { squadStatusMsg = err.message || "Could not change routine."; }
      await loadSquadDetail(squad.id);
    };
    clientPanel.querySelectorAll("[data-schedule-routine]").forEach(cell => {
      cell.addEventListener("click", () => pickRoutine(cell.dataset.scheduleRoutine));
      cell.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();                        // Space must not scroll the panel
        pickRoutine(cell.dataset.scheduleRoutine);
      });
    });
    // The Edit/Clear and Copy plaques sit INSIDE the cell. They act on the routine they belong to;
    // they must not also select it (clicking "Edit" on Off duty while the squad trains constantly
    // would otherwise silently take the squad off duty).
    clientPanel.querySelectorAll(".sq-schedule-edit, .sq-schedule-copy").forEach(btn => {
      btn.addEventListener("click", event => event.stopPropagation());
    });
    clientPanel.querySelectorAll(".sq-schedule-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        trainingSel = { routine: Number(btn.dataset.trainRoutine), month: Number(btn.dataset.trainMonth) };
        goToView("training");
      });
    });
  }

  // --- supplies wiring (native 5.4) ---
  async function squadSuppliesPost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return squadFetchJson(`/squad-supplies?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireSquadSuppliesControls(squad) {
    clientPanel.querySelectorAll("[data-supply-food]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await squadSuppliesPost({ squad: squad.id, food: Number(btn.dataset.supplyFood) });
          squadStatusMsg = "Supplies updated.";
        } catch (err) { squadStatusMsg = err.message || "Could not update supplies."; }
        await loadSquadDetail(squad.id);
      });
    });
    clientPanel.querySelectorAll("[data-supply-water]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await squadSuppliesPost({ squad: squad.id, water: btn.dataset.supplyWater });
          squadStatusMsg = "Supplies updated.";
        } catch (err) { squadStatusMsg = err.message || "Could not update supplies."; }
        await loadSquadDetail(squad.id);
      });
    });
  }

  // --- routine authoring wiring (native 7.1) ---
  async function routinePost(path, params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return squadFetchJson(`/${path}?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireRoutinesControls(squad) {
    clientPanel.querySelector("#routineAddBtn")?.addEventListener("click", async () => {
      const name = clientPanel.querySelector("#routineNewName")?.value || "";
      try {
        await routinePost("routine-create", name ? { name } : {});
        squadStatusMsg = "Routine added.";
      } catch (err) { squadStatusMsg = err.message || "Could not add routine (this build may not support routine authoring)."; }
      await loadSquadDetail(squad.id);
    });
    clientPanel.querySelectorAll(".sq-routine-row").forEach(row => {
      const idx = Number(row.dataset.routineIdx);
      row.querySelector(".sq-routine-rename")?.addEventListener("click", async () => {
        const name = row.querySelector(".sq-routine-name")?.value || "";
        try {
          await routinePost("routine-rename", { idx, name });
          squadStatusMsg = "Routine renamed.";
        } catch (err) { squadStatusMsg = err.message || "Could not rename routine."; }
        await loadSquadDetail(squad.id);
      });
      row.querySelector(".sq-routine-delete")?.addEventListener("click", async () => {
        try {
          await routinePost("routine-delete", { idx });
          squadStatusMsg = "Routine deleted.";
        } catch (err) { squadStatusMsg = err.message || "Could not delete routine."; }
        await loadSquadDetail(squad.id);
      });
    });
  }

  // --- monthly grid wiring (native 7.2): each Edit opens the training editor (7.3) ---
  function wireMonthlyControls(_squad) {
    clientPanel.querySelectorAll(".sq-month-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        trainingSel = { routine: Number(btn.dataset.trainRoutine), month: Number(btn.dataset.trainMonth) };
        goToView("training");
      });
    });
  }

  // --- training editor wiring (native 7.3): Save writes sleep/uniform (set-month) + the Train
  // order toggle w/ min count (set-month-order), both scoped to the selected routine + month. ---
  function wireTrainingControls(squad) {
    // Seed the draft from the SERVED routine-month the first time the editor paints, so Save writes
    // exactly what the old #trainSleep/#trainUniform/#trainOrder/#trainMin would have written.
    const scheds = Array.isArray(squadDetail && squadDetail.routineSchedules) ? squadDetail.routineSchedules : [];
    const rs = scheds.find(x => x.idx === trainingSel.routine);
    const m = rs && Array.isArray(rs.months) ? rs.months.find(x => x.month === trainingSel.month) : null;
    if (!trainDraft && m) {
      trainDraft = { sleep: m.sleep, uniform: m.uniform, train: !!m.hasTrain, min: Number(m.minCount) || 0 };
    }
    clientPanel.querySelectorAll("[data-train-sleep]").forEach(seg => {
      seg.addEventListener("click", () => {
        trainDraft = Object.assign({}, trainDraft, { sleep: seg.dataset.trainSleep });
        renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll("[data-train-uniform]").forEach(seg => {
      seg.addEventListener("click", () => {
        trainDraft = Object.assign({}, trainDraft, { uniform: seg.dataset.trainUniform });
        renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#trainOrder")?.addEventListener("click", () => {
      trainDraft = Object.assign({}, trainDraft, { train: !(trainDraft && trainDraft.train) });
      renderSquadsPanel();
    });
    const minInput = clientPanel.querySelector("#trainMin");
    minInput?.addEventListener("input", () => {
      trainDraft = Object.assign({}, trainDraft, { min: Number(minInput.value) || 0 });
    });
    clientPanel.querySelector("#trainSaveBtn")?.addEventListener("click", async () => {
      const routine = trainingSel.routine, month = trainingSel.month;
      const d = trainDraft || {};
      const sleep = d.sleep || "none";
      const uniform = d.uniform || "none";
      const train = !!d.train;
      const min = Number(minInput ? minInput.value : d.min) || 0;
      try {
        await squadSchedulePost({ squad: squad.id, action: "set-month", routine, month, sleep, uniform });
        await squadSchedulePost({ squad: squad.id, action: "set-month-order", routine, month,
          order: train ? "train" : "none", min });
        squadStatusMsg = "Training schedule saved.";
      } catch (err) { squadStatusMsg = err.message || "Could not save training schedule."; }
      await loadSquadDetail(squad.id);
    });
  }

  // --- uniform assignment wiring (existing templates only) ---
  async function squadUniformPost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return squadFetchJson(`/squad-uniform?${q}&t=${Date.now()}`, { method: "POST" });
  }

  // The per-position template chooser is now a CYCLER; its value lives in `uniformPick` (seeded, like
  // the old `select`'s first option, from the first served template). Apply POSTs the same uniform id.
  function wireSquadUniformControls(squad) {
    clientPanel.querySelectorAll("[data-equipment-details],[data-equipment-inspect]").forEach(button => {
      button.addEventListener("click", () => {
        equipmentPosition = Number(button.dataset.equipmentDetails ?? button.dataset.equipmentInspect);
        equipTab = "details";
        equipmentPicker = null;
        renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll("[data-uniform-template-delete]").forEach(button => {
      button.addEventListener("click", async event => {
        event.stopPropagation();
        try {
          await uniformPost("uniform-delete", { id: Number(button.dataset.uniformTemplateDelete) });
          squadStatusMsg = "Uniform template deleted.";
        } catch (err) { squadStatusMsg = err.message || "Could not delete template."; }
        await refreshAfterUniformEdit();
      });
    });
    clientPanel.querySelectorAll("[data-uniform-apply]").forEach(button => {
      button.addEventListener("click", async () => {
        const pos = Number(button.dataset.uniformApply);
        const templates = Array.isArray(squadDetail && squadDetail.uniforms) ? squadDetail.uniforms : [];
        const uniform = uniformPick[pos] != null ? Number(uniformPick[pos])
          : (templates.length ? Number(templates[0].id) : -1);
        if (!(uniform >= 0)) { squadStatusMsg = "No uniform template selected."; renderSquadsPanel(); return; }
        try {
          await squadUniformPost({ squad: squad.id, pos, action: "apply", uniform });
          squadStatusMsg = "Uniform applied.";
        } catch (err) { squadStatusMsg = err.message || "Could not apply uniform."; }
        await loadSquadDetail(squad.id);
      });
    });
    clientPanel.querySelectorAll("[data-uniform-clear]").forEach(button => {
      button.addEventListener("click", async () => {
        const pos = Number(button.dataset.uniformClear);
        try {
          await squadUniformPost({ squad: squad.id, pos, action: "clear" });
          squadStatusMsg = "Uniform cleared.";
        } catch (err) { squadStatusMsg = err.message || "Could not clear uniform."; }
        await loadSquadDetail(squad.id);
      });
    });
  }

  async function squadEquipmentPost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return squadFetchJson(`/squad-equipment?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireSquadEquipmentControls(squad) {
    const currentItem = () => {
      if (!equipmentPicker) return null;
      const members = Array.isArray(squad.members) ? squad.members : [];
      const member = members.find(m => Number(m.idx) === Number(equipmentPosition));
      const details = Array.isArray(member && member.uniformDetails) ? member.uniformDetails : [];
      return details.find(item => Number(item.cat) === Number(equipmentPicker.cat) && Number(item.index) === Number(equipmentPicker.index)) || null;
    };
    const saveItem = async (item, changes) => {
      const next = Object.assign({
        squad: squad.id, pos: equipmentPosition, action: "update", cat: item.cat, index: item.index,
        subtype: item.subtype, matclass: item.materialClass, mattype: item.mattype,
        matindex: item.matindex, color: item.color, choice: item.choice,
      }, changes || {});
      await squadEquipmentPost(next);
      equipmentPicker = null;
      await loadSquadDetail(squad.id);
    };

    // The position chooser is the CYCLER (wireCyclers key "equipPos"); it writes the same
    // `equipmentPosition` the `select`'s change handler wrote.
    clientPanel.querySelectorAll("[data-equipment-material], [data-equipment-color]").forEach(button => {
      button.addEventListener("click", () => {
        const encoded = button.dataset.equipmentMaterial || button.dataset.equipmentColor;
        const [cat, index] = String(encoded).split(":").map(Number);
        equipmentPicker = { kind: button.dataset.equipmentColor != null ? "color" : "material", cat, index };
        renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#equipmentPickerBackBtn")?.addEventListener("click", () => {
      equipmentPicker = null;
      renderSquadsPanel();
    });
    clientPanel.querySelectorAll("[data-equipment-remove]").forEach(button => {
      button.addEventListener("click", async () => {
        const [cat, index] = String(button.dataset.equipmentRemove).split(":").map(Number);
        try {
          await squadEquipmentPost({ squad: squad.id, pos: equipmentPosition, action: "remove", cat, index });
          squadStatusMsg = "Equipment requirement removed.";
        } catch (err) { squadStatusMsg = err.message || "Could not remove equipment requirement."; }
        await loadSquadDetail(squad.id);
      });
    });
    clientPanel.querySelectorAll("[data-equipment-add]").forEach(button => {
      button.addEventListener("click", async () => {
        const cat = Number(button.dataset.equipmentAdd);
        try {
          await squadEquipmentPost({ squad: squad.id, pos: equipmentPosition, action: "add", cat,
            subtype: -1, matclass: -1, mattype: -1, matindex: -1, color: -1, choice: cat === 6 ? 2 : 0 });
          squadStatusMsg = "Equipment requirement added.";
        } catch (err) { squadStatusMsg = err.message || "Could not add equipment requirement."; }
        await loadSquadDetail(squad.id);
      });
    });
    clientPanel.querySelectorAll("[data-equipment-pick-material]").forEach(button => {
      button.addEventListener("click", async () => {
        const item = currentItem();
        if (!item) return;
        const parts = String(button.dataset.equipmentPickMaterial).split(":");
        try {
          if (parts[0] === "class") await saveItem(item, { matclass: Number(parts[1]), mattype: -1, matindex: -1 });
          else await saveItem(item, { matclass: -1, mattype: Number(parts[1]), matindex: Number(parts[2]) });
          squadStatusMsg = "Equipment material saved.";
        } catch (err) { squadStatusMsg = err.message || "Could not save equipment material."; renderSquadsPanel(); }
      });
    });
    clientPanel.querySelectorAll("[data-equipment-pick-color]").forEach(button => {
      button.addEventListener("click", async () => {
        const item = currentItem();
        if (!item) return;
        try {
          await saveItem(item, { color: Number(button.dataset.equipmentPickColor) });
          squadStatusMsg = "Equipment color saved.";
        } catch (err) { squadStatusMsg = err.message || "Could not save equipment color."; renderSquadsPanel(); }
      });
    });
  }

  // --- squad ammunition editor wiring ---
  async function squadAmmoPost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return squadFetchJson(`/squad-ammo?${q}&t=${Date.now()}`, { method: "POST" });
  }

  // Every ammo value the DOM used to hold (type / amount / material / C / T, per row AND on the add
  // row) now lives in `ammoAddDraft` + `ammoRowDrafts`, seeded from the SERVED spec. The five POSTs
  // (add / clear / update / remove) are byte-for-byte the same requests with the same arguments.
  function wireSquadAmmoControls(squad) {
    const defs = Array.isArray(squadDetail && squadDetail.ammoDefs) ? squadDetail.ammoDefs : [];
    const specs = Array.isArray(squadDetail && squadDetail.ammo) ? squadDetail.ammo : [];
    const matOptions = sqMaterialClassOptions(uniformCatalog, -1);
    const addDraft = () => Object.assign({
      subtype: defs.length ? Number(defs[0].subtype) : -1, amount: 100,
      matclass: matOptions.length ? Number(matOptions[0][0]) : -1,
      combat: true, training: false,
    }, ammoAddDraft || {});
    const rowDraft = index => {
      const served = specs.find(a => Number(a.index) === Number(index)) || {};
      return Object.assign({
        amount: Number(served.amount) || 0, combat: !!served.combat, training: !!served.training,
      }, ammoRowDrafts[index] || {});
    };

    // add-row amount (the stepper's editable input) + the two add-row check tiles
    const addAmountInput = clientPanel.querySelector(".sq-ammo-add-amount-input");
    addAmountInput?.addEventListener("input", () => {
      ammoAddDraft = Object.assign(addDraft(), { amount: Number(addAmountInput.value) || 0 });
    });
    clientPanel.querySelectorAll("[data-ammo-add-flag]").forEach(tile => {
      tile.addEventListener("click", () => {
        const flag = tile.dataset.ammoAddFlag;
        const d = addDraft();
        ammoAddDraft = Object.assign(d, { [flag]: !d[flag] });
        renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#squadAmmoAddBtn")?.addEventListener("click", async () => {
      const d = addDraft();
      const subtype = Number(d.subtype);
      if (!(subtype >= 0)) { squadStatusMsg = "Pick an ammo type."; renderSquadsPanel(); return; }
      const amount = Number(addAmountInput ? addAmountInput.value : d.amount) || 0;
      const matclass = Number(d.matclass ?? -1);
      const combat = d.combat ? 1 : 0;
      const training = d.training ? 1 : 0;
      try {
        await squadAmmoPost({ squad: squad.id, action: "add", subtype, amount, matclass, combat, training });
        squadStatusMsg = "Ammunition added.";
      } catch (err) { squadStatusMsg = err.message || "Could not add ammunition."; }
      ammoAddDraft = null;
      await loadSquadDetail(squad.id);
    });
    clientPanel.querySelector("#squadAmmoClearBtn")?.addEventListener("click", async () => {
      try {
        await squadAmmoPost({ squad: squad.id, action: "clear" });
        squadStatusMsg = "Ammunition cleared.";
      } catch (err) { squadStatusMsg = err.message || "Could not clear ammunition."; }
      ammoRowDrafts = {};
      await loadSquadDetail(squad.id);
    });
    clientPanel.querySelectorAll("[data-ammo-flag]").forEach(tile => {
      tile.addEventListener("click", () => {
        const index = Number(tile.dataset.ammoIndex);
        const flag = tile.dataset.ammoFlag;
        const d = rowDraft(index);
        ammoRowDrafts[index] = Object.assign(d, { [flag]: !d[flag] });
        renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll(".sq-ammo-row").forEach(row => {
      const index = Number(row.dataset.ammoIndex);
      const amountInput = row.querySelector(".sq-ammo-amount-input");
      amountInput?.addEventListener("input", () => {
        ammoRowDrafts[index] = Object.assign(rowDraft(index), { amount: Number(amountInput.value) || 0 });
      });
      row.querySelector("[data-ammo-save]")?.addEventListener("click", async () => {
        const d = rowDraft(index);
        const amount = Number(amountInput ? amountInput.value : d.amount) || 0;
        const combat = d.combat ? 1 : 0;
        const training = d.training ? 1 : 0;
        try {
          await squadAmmoPost({ squad: squad.id, action: "update", index, amount, combat, training });
          squadStatusMsg = "Ammunition updated.";
        } catch (err) { squadStatusMsg = err.message || "Could not update ammunition."; }
        delete ammoRowDrafts[index];
        await loadSquadDetail(squad.id);
      });
      row.querySelector("[data-ammo-remove]")?.addEventListener("click", async () => {
        try {
          await squadAmmoPost({ squad: squad.id, action: "remove", index });
          squadStatusMsg = "Ammunition removed.";
        } catch (err) { squadStatusMsg = err.message || "Could not remove ammunition."; }
        ammoRowDrafts = {};
        await loadSquadDetail(squad.id);
      });
    });
  }

  // --- uniform-template editor wiring (fort-wide /uniform-*) ---
  async function uniformPost(path, params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return squadFetchJson(`/${path}?${q}&t=${Date.now()}`, { method: "POST" });
  }

  async function refreshAfterUniformEdit() {
    await loadUniformCatalog();
    if (squadSelectedId >= 0) { await loadSquadDetail(squadSelectedId); }
    else { renderSquadsPanel(); }
  }

  // The template chooser is the CYCLER (wireCyclers key "uniformSelect"); it writes the same
  // `uniformSelectedId` the `select`'s change handler wrote.
  function wireUniformEditorControls() {
    const templates = Array.isArray(uniformCatalog && uniformCatalog.uniforms) ? uniformCatalog.uniforms : [];
    const selected = templates.find(u => u.id === uniformSelectedId) || null;
    if (!uniformFlagDraft && selected) {
      uniformFlagDraft = { replaceClothing: !!selected.replaceClothing, exactMatches: !!selected.exactMatches };
    }
    const newNameInput = clientPanel.querySelector("#uniformNewName");
    const createButton = clientPanel.querySelector("#uniformCreateBtn");
    newNameInput?.addEventListener("input", () => {
      if (createButton) createButton.disabled = !newNameInput.value.trim();
    });
    clientPanel.querySelectorAll("[data-uniform-flag]").forEach(tile => {
      tile.addEventListener("click", event => {
        event.preventDefault();
        const flag = tile.dataset.uniformFlag;
        uniformFlagDraft = Object.assign({ replaceClothing: false, exactMatches: false }, uniformFlagDraft);
        uniformFlagDraft[flag] = !uniformFlagDraft[flag];
        renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#uniformCreateBtn")?.addEventListener("click", async () => {
      const name = clientPanel.querySelector("#uniformNewName")?.value || "";
      try {
        const data = await uniformPost("uniform-create", name ? { name } : {});
        if (data && typeof data.id === "number") uniformSelectedId = data.id;
        squadStatusMsg = "Uniform template created.";
      } catch (err) { squadStatusMsg = err.message || "Could not create template."; }
      await refreshAfterUniformEdit();
    });
    clientPanel.querySelector("#uniformRenameBtn")?.addEventListener("click", async () => {
      const name = clientPanel.querySelector("#uniformRenameInput")?.value || "";
      try {
        await uniformPost("uniform-rename", { id: uniformSelectedId, name });
        squadStatusMsg = "Template renamed.";
      } catch (err) { squadStatusMsg = err.message || "Could not rename template."; }
      await refreshAfterUniformEdit();
    });
    clientPanel.querySelector("#uniformDeleteBtn")?.addEventListener("click", async () => {
      try {
        await uniformPost("uniform-delete", { id: uniformSelectedId });
        uniformSelectedId = -1;
        squadStatusMsg = "Template deleted.";
      } catch (err) { squadStatusMsg = err.message || "Could not delete template."; }
      await refreshAfterUniformEdit();
    });
    clientPanel.querySelector("#uniformFlagsBtn")?.addEventListener("click", async () => {
      const f = uniformFlagDraft || {};
      const replaceClothing = f.replaceClothing ? 1 : 0;
      const exactMatches = f.exactMatches ? 1 : 0;
      try {
        await uniformPost("uniform-flags", { id: uniformSelectedId, replaceClothing, exactMatches });
        squadStatusMsg = "Flags saved.";
      } catch (err) { squadStatusMsg = err.message || "Could not save flags."; }
      uniformFlagDraft = null;
      await refreshAfterUniformEdit();
    });
    // The three add-item choosers are cyclers/segments/steppers now; the per-category draft holds
    // exactly what the three `select` + numeric DOM controls held, and Add POSTs the same six params.
    clientPanel.querySelectorAll("[data-uitem-choice]").forEach(seg => {
      seg.addEventListener("click", () => {
        const cat = Number(seg.closest(".sq-uitem-add")?.dataset.ucat);
        uitemDrafts[cat] = Object.assign({}, uitemDrafts[cat], { choice: Number(seg.dataset.uitemChoice) });
        renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll("[data-uitem-color]").forEach(input => {
      input.addEventListener("input", () => {
        const cat = Number(input.dataset.uitemColor);
        uitemDrafts[cat] = Object.assign({}, uitemDrafts[cat], { color: Number(input.value) });
      });
    });
    clientPanel.querySelectorAll("[data-uitem-add]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const cat = Number(btn.dataset.uitemAdd);
        const box = clientPanel.querySelector(`.sq-uitem-add[data-ucat="${cat}"]`);
        const colorInput = box && box.querySelector(".sq-uitem-color-input");
        const matOptions = sqMaterialClassOptions(uniformCatalog, -1);
        const d = uitemDrafts[cat] || {};
        const subtype = Number(d.subtype ?? -1);
        const matclass = Number(d.matclass ?? (matOptions.length ? matOptions[0][0] : -1));
        const color = Number(colorInput ? colorInput.value : (d.color ?? -1));
        const choice = cat === 6 ? Number(d.choice ?? 0) : 0;
        try {
          await uniformPost("uniform-item-add", { id: uniformSelectedId, cat, subtype, matclass, color, choice });
          squadStatusMsg = "Item added.";
        } catch (err) { squadStatusMsg = err.message || "Could not add item."; }
        delete uitemDrafts[cat];
        await refreshAfterUniformEdit();
      });
    });
    clientPanel.querySelectorAll(".sq-uitem-remove").forEach(btn => {
      btn.addEventListener("click", async () => {
        const cat = Number(btn.dataset.ucat);
        const index = Number(btn.dataset.uindex);
        try {
          await uniformPost("uniform-item-remove", { id: uniformSelectedId, cat, index });
          squadStatusMsg = "Item removed.";
        } catch (err) { squadStatusMsg = err.message || "Could not remove item."; }
        await refreshAfterUniformEdit();
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

  // B233-3: create a NEW SEAT for a squad-capable position the raws still allow (POST
  // /position-create -> a vacant df::entity_position_assignment), then create the squad under it.
  // If the seat lands but the squad create fails, the seat REMAINS -- that is not a half-write: a
  // vacant militia-captain seat is a legal DF state (it is exactly what native leaves behind when
  // you back out), and it simply shows up as a free position on the next open.
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
    // Disband is open to every authenticated player (owner policy 2026-07-16); server is the gate.
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
    // B249: slot 0 carries the commander appointment (noble records). Verified live 2026-07-17 and
    // its probe guard removed, so pos 0 is assigned like any other slot -- no client-side lock.
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
      buildSquadPanel, sqListRows, sqOrdersSummary, sqEmblemSwatch, sqOrderToolbar,
      sqPositionsView, sqPositionRows, sqCandidateRows, sqCandidateView, sqCandidateSortedRows,
      sqCreateView, sqCreateUniformView, sqEquipView,
      sqUniformAssignRows, sqUniformEditor, sqAmmoSection, sqScheduleView, sqBackHeader,
      sqEmblemView, sqBurrowDefendView, sqPatrolView, sqRoutinesView, sqMonthlyView, sqTrainingView,
      sqSuppliesSection, sqEquipmentDetails, sqEquipmentPickerView, EQUIP_TABS,
    };
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      buildSquadPanel, sqListRows, sqOrdersSummary, sqEmblemSwatch, sqOrderToolbar,
      sqPositionsView, sqPositionRows, sqCandidateRows, sqCandidateView, sqCandidateSortedRows,
      sqCreateView, sqCreateUniformView, sqEquipView, sqUniformAssignRows, sqUniformEditor,
      sqAmmoSection, sqScheduleView, sqMaterialClassOptions, sqBackHeader, EQUIP_TABS,
      sqEmblemView, sqBurrowDefendView, sqPatrolView, sqRgbToHex, SQUAD_SYMBOL_GLYPHS,
      sqSuppliesSection, sqEquipmentDetails, sqEquipmentPickerView, sqRoutinesView, sqMonthlyView, sqTrainingView,
    };
  }
