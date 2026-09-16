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

  // ---- SIEGE ENGINES (ledger 0014 + 0014 addendum / Screen 2) ---------------------------------
  // FOUR THINGS THIS PANEL MUST NOT GET WRONG.
  //
  // 1. THERE ARE THREE KINDS. Catapult, ballista and bolt thrower are all live in this build; the
  //    bolt thrower is not a legacy stub. A two-kind panel is wrong.
  // 2. THE ACTION FIELD IS A THRESHOLD LADDER, NOT A MODE SWITCH. Each value permits everything
  //    the values below it permit and one thing more, so every row carries the sentence that says
  //    what it adds. The row ORDER is native's and is load-bearing for muscle memory: fire,
  //    practice, stand ready, keep loaded, idle -- not the enum order, not an intensity order.
  //    The addendum's renderer read shows the five are a HORIZONTAL strip, so that is what this
  //    draws.
  // 3. FACING IS AN ARROW, NEVER A COMPASS WORD -- but the INDEX IS DF'S ENUM. The constants
  //    advance CLOCKWISE from screen-NORTH, which is what `df::siegeengine_orientation` says.
  //    Beware ledger 0014 O4: the tiles it tabulates are where the OPERATOR STANDS, 180 degrees
  //    from the muzzle, so reading it as a muzzle table negates every arrow on this sheet. The
  //    arrow is drawn from a tile delta rather than a compass word, because "right" is the player's
  //    screen and DF's "East" is a world word; see SIEGE_RESTING_DX/DY below for the single table
  //    both ends share.
  // 4. THERE IS NO CREW. A siege engine carries no user record and no assigned-unit vector;
  //    whoever takes the load or fire job is the operator, and staffing is the fortress-wide siege
  //    operator work detail. There is no crew chooser here because there is no crew to choose.

  // The wrap budget for every wrapping status on this sheet. It is not optional: DFBitmapText paints
  // a label as ONE canvas, so an unwrapped sentence-length status is a single unbreakable run.
  const SIEGE_PROSE_COLUMNS = 52;

  // The action band's own budget, which is narrower than the panel's: the five mode tiles and their
  // insets take part of the row, so the sentence gets the rest.
  const SIEGE_BAND_COLUMNS = 41;

  // PIXEL ROUND -- THE MEASURED SHEET, in the interior coordinates every `--siege-*` custom
  // property in the production stylesheet is quoted against. Both captures are the SAME panel at the SAME interface
  // scale (the catapult sheet is the bolt-thrower sheet translated by exactly 15px on both axes),
  // so one table serves both. Interior origin is the first pixel inside the 7px gold frame:
  // (24, 27) in bolt-thrower pixels, (9, 12) in catapult pixels.
  //
  //   interior box                 718 x 1336
  //   background                   #1c1c1c
  //   header engine tile           left 4,  top 11,  50 x 54
  //   header title text            left 88, text row top 28
  //   header tool tiles            right inset 77, top 11, 48 x 52, shared border (gap 0)
  //   action sentence row          left 16, top 118
  //   action mode tiles            right inset 16, top 127, 36 x 36, pitch 36
  //   resting caption row          left 16, top 208
  //   resting arrow tiles          left 16, top 227, 48 x 54, pitch 48
  //   bolt count lines             left 16, first row top 298, pitch 22
  //   section rule                 top 666, 3px, inset 5 each side
  //   contents rows                first top 677, pitch 54
  //     hatch separator            3px at the row top
  //     item sprite tile           left 8,  46 x 46, 2px below the separator
  //     item name                  left 88, centred in the row
  //     action tiles               slots at left 474/510/546/582/618/654, 36 x 36
  //
  // Selection, sampled off both sheets, is DF's own green cell face -- rgb(95,172,20), which
  // the production stylesheet carries as `--siege-active` -- and never a border change: an unselected tile keeps the
  // sheet's #1c1c1c ground.

  // Native prints ONE status sentence for the current value and offers the choice as five icon tiles;
  // it never stacks the five descriptions as plaques. `status` ships verbatim.
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
  const SIEGE_ACTION_LABELS = SIEGE_ACTION_ROWS.reduce((map, row) => {
    map[row.mode] = row.label; return map;
  }, {});
  const SIEGE_ACTION_STATUS = SIEGE_ACTION_ROWS.reduce((map, row) => {
    map[row.mode] = row.status; return map;
  }, {});

  // Screen-relative words derived from the served delta, never from the direction enum's own labels.
  function siegeFacingWords(dx, dy) {
    const vertical = dy > 0 ? "down" : dy < 0 ? "up" : "";
    const horizontal = dx > 0 ? "right" : dx < 0 ? "left" : "";
    return [vertical, horizontal].filter(Boolean).join("-") || "nowhere";
  }
  function siegeFacingTurn(dx, dy) {
    if (!dx && !dy) return 0;
    return (Math.round(Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
  }
  // There is no eight-way arrow family in interface_map.json, so this is ordinary panel text; where
  // it enters a DWFUI slot it is wrapped in the declared rawHtml escape hatch at the call site.
  function siegeFacingArrowHtml(dx, dy, label) {
    const words = siegeFacingWords(dx, dy);
    const turn = siegeFacingTurn(dx, dy);
    const title = `${label || "Facing"}: ${words} on screen`;
    return `<span class="siege-arrow" style="--siege-turn:${turn}deg" title="${escapeHtml(title)}"` +
      ` role="img" aria-label="${escapeHtml(title)}">&#8593;</span>`;
  }

  function siegeStatusRowHtml(label, valueHtml) {
    return `<div class="siege-status-row"><span class="siege-status-label">${escapeHtml(label)}</span>` +
      `<span class="siege-status-value">${valueHtml}</span></div>`;
  }

  const SIEGE_OPERATOR_WORDS = {
    none: "No queued work",
    loading: "Loading",
    "load-unclaimed": "Load task queued, nobody on it",
    "fire-unclaimed": "Nobody is operating the engine",
    "operator-walking": "Operator walking to the engine",
    // Native's proximity box is looser than the tile a shot needs, so this is a fact about where a
    // dwarf is standing and never a prediction.
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
      // Falls back to the idle row rather than to empty text: a blank band reads as "this engine has
      // no setting", which is worse than an unknown action value.
      actionStatus: SIEGE_ACTION_STATUS[action] || SIEGE_ACTION_STATUS[0],
      rows: SIEGE_ACTION_ROWS.map(row => ({ ...row, selected: row.mode === action })),
      facing: { dx: Number(d.facingDx) || 0, dy: Number(d.facingDy) || 0 },
      resting: { dx: Number(d.restingDx) || 0, dy: Number(d.restingDy) || 0 },
      restingFacing: Number(d.restingFacing) || 0,
      // Deliberately UNKNOWN while the engine is unfinished: parts are still arriving, so nothing
      // about the contained items means what it will mean later.
      loadedChip: !built ? "unknown" : (d.loaded ? "loaded" : "empty"),
      loadedQty,
      // The trigger is action >= 3, not >= 2: at stand-ready the engine neither tops up nor shoots, so
      // telling a player it "will shoot what it has" would describe a shot that cannot happen.
      partialStackWarning: boltThrower && built && loadedQty > 0 && loadedQty < 100 && action >= 3,
      forbidden: !!d.forbidden,
      cycling: !!d.cycling,
      searching: !!d.searching,
      turning: !!d.turning,
      operatorText: SIEGE_OPERATOR_WORDS[String(d.operatorState)] || SIEGE_OPERATOR_WORDS.none,
      jobs: Array.isArray(d.jobs) ? d.jobs : [],
      // Wire-gated and fail-open: `/siege-engine` does not send this today, so an engine renders an
      // empty well. Nothing here is synthesised from the fields that ARE on the wire.
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

  // Note what is NOT here: a rotate control for a catapult or ballista. The game has no write path
  // for their facing after placement, so it is OMITTED -- a disabled control promises a future.
  function siegeBlockedControlsHtml(state) {
    const blocked = [];
    if (state.boltThrower)
      blocked.push({ label: "Aim now",
        why: "The engine turns one step every four ticks, and only while an operator is standing at it. Set the parking direction instead and let the operator turn it." });
    blocked.push({ label: "Queue a load or fire job",
      why: "The game queues these itself and prevents duplicates only by checking that the engine has no job yet. A job added from here would sit beside the game's own." });
    blocked.push({ label: "Clear the reload or search timers",
      why: "These are cadence counters the game counts down itself. Clearing one skips a lockout the game is using to rate-limit a real shot." });
    blocked.push({ label: "Change the engine type",
      why: "The type is a bare field. Switching it would leave the engine holding the wrong parts and reading the wrong slot for ammunition." });
    return blocked.map(item =>
      DWFUI.plaqueBtnHtml({ cls: "building-btn", label: item.label, disabled: true, title: item.why }) +
      `<div class="zone-note">${escapeHtml(item.why)}</div>`).join("");
  }

  // ---- the sheet header ---------------------------------------------------------------------------
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

  // The tiles are `artBtnHtml`, not `plaqueBtnHtml`: they are DF's own self-framed control cells, and
  // SELECTION IS THE SPRITE -- adding gold brackets would compete with DF's own green face.
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
    // The sentence WRAPS, so it is a status rather than a bitmap label: the longest native string is
    // longer than the band, and a bitmap label paints as one uncuttable canvas.
    return `<div class="siege-action-band">` +
      DWFUI.statusHtml({ cls: "siege-action-status", tone: state.built ? "" : "dim",
                         columns: SIEGE_BAND_COLUMNS,
                         text: state.built ? state.actionStatus : "Switched off until the engine is finished" }) +
      `<div class="siege-action-strip">${tiles}</div></div>`;
  }

  // The table IS DF's own enum, index for index: screen-UP at 0, advancing CLOCKWISE. Do NOT re-derive
  // it from the operator-standing tiles -- those are 180 degrees from the muzzle and negate all eight.
  const SIEGE_RESTING_DX = [0, 1, 1, 1, 0, -1, -1, -1];
  const SIEGE_RESTING_DY = [-1, -1, 0, 1, 1, 1, 0, -1];
  const SIEGE_RESTING_SCREEN_ORDER = [0, 1, 2, 3, 4, 5, 6, 7];
  function siegeRestingStripHtml(state) {
    const tiles = SIEGE_RESTING_SCREEN_ORDER.map(i => {
      const dx = SIEGE_RESTING_DX[i];
      const dy = SIEGE_RESTING_DY[i];
      return DWFUI.artBtnHtml({
        cls: "siege-facing",
        active: i === state.restingFacing,
        disabled: !state.built,
        glyphHtml: DWFUI.rawHtml(
          "no eight-way arrow family exists in interface_map.json, so the face is one glyph rotated by DF's own tile delta",
          siegeFacingArrowHtml(dx, dy, "Park facing")),
        dataset: { siegeResting: String(i) },
        title: `Park facing ${siegeFacingWords(dx, dy)} on screen`,
        ariaLabel: `Park facing ${siegeFacingWords(dx, dy)} on screen`,
      });
    }).join("");
    // The caption is native's own, verbatim, and DF's own bitmap text -- not our uppercase gold panel
    // heading. Never paraphrase it.
    return `<div class="siege-caption">` +
      DWFUI.bitmapTextHtml("Resting orientation") + `</div>` +
      `<div class="siege-facing-strip">${tiles}</div>`;
  }

  // `/siege-engine` sends only `loaded` and `loadedQuantity`, so the other three readouts stay ABSENT
  // rather than approximated; the block keeps four slots either way, so the layout does not collapse.
  const SIEGE_COUNT_LINES = [
    { key: "loaded", cls: "siege-count-loaded" },
    { key: "available", cls: "siege-count-available" },
    { key: "squads", cls: "siege-count-squads" },
    { key: "hunters", cls: "siege-count-hunters" },
  ];
  function siegeBoltCountsHtml(state) {
    if (!state.built) return `<div class="siege-counts" aria-hidden="true"></div>`;
    const text = {
      // Native's wording, verbatim. The other three labels stay unwritten because their NUMBERS are.
      loaded: `Bolts loaded: ${state.loadedQty}`,
      // Deliberately absent: an empty slot is not an approximation; a number would be.
      available: "", squads: "", hunters: "",
    };
    return `<div class="siege-counts">` + SIEGE_COUNT_LINES.map(line =>
      `<div class="siege-count-line ${line.cls}">` +
      (text[line.key] ? DWFUI.bitmapTextHtml(text[line.key]) : "") + `</div>`).join("") + `</div>`;
  }

  // No "Ammunition" heading: the coloured count lines ARE the block, and a gold uppercase panel
  // heading above them is our vocabulary, not DF's.
  function siegeAmmoSectionHtml(state) {
    if (state.boltThrower) {
      return siegeBoltCountsHtml(state) +
        // The warning names the threshold rather than gesturing at it. `columns` is what breaks the
        // sentence to the panel width; without it the bitmap painter runs the tail off the sheet.
        (state.partialStackWarning
          ? DWFUI.statusHtml({ cls: "zone-note", tone: "warn", columns: SIEGE_PROSE_COLUMNS,
              text: "Fewer than 100 bolts are loaded. On this setting the engine shoots the " +
                    "partial stack instead of waiting for more; only keep-loaded tops one up." })
          : "");
    }
    // Ballista and catapult contribute nothing to the sheet body: what each kind eats is a sentence,
    // not a readout, so it lives in the supplement.
    return "";
  }

  // ---- the contents list -------------------------------------------------------------------------
  function siegeContentRowHtml(item) {
    const id = Number(item.id);
    const perm = String(item.role || "").toUpperCase() === "PERM";
    const actions = [
      { title: "Locate on the map", dataset: { siegeItemAction: "locate", siegeItem: id } },
      { active: !!item.forbidden, title: item.forbidden ? "Claim item" : "Forbid item",
        dataset: { siegeItemAction: "forbid", siegeItem: id } },
      { active: !!item.dump, title: item.dump ? "Cancel dump" : "Mark for dumping",
        dataset: { siegeItemAction: "dump", siegeItem: id } },
      { active: !!item.hidden, title: item.hidden ? "Show item" : "Hide item",
        dataset: { siegeItemAction: "hide", siegeItem: id } },
    ];
    return DWFUI.rowHtml({
      cls: `siege-item-row${perm ? " is-part" : ""}`, dataset: { siegeItemRow: id },
      // The CSS builds the cell: a 4px frame, DF's own ground, and this art area inside. The cell is
      // full-bleed and its column is unbroken between rows, which is what native draws.
      icon: DWFUI.iconHtml({ item: item.spriteRef, cls: "siege-item-ico", size: 46,
                             alt: item.name || `Item ${id}` }),
      // `rowHtml` paints a plain `label` as DF bitmap text; pre-built markup would be escaped and printed.
      copyCls: "siege-item-copy", labelCls: "siege-item-name",
      label: item.name || `Item ${id}`,
      // interface_map.json ships no house cell, so this is a glyph in a grey-framed slot rather than
      // a sprite we do not have.
      trailing:
        (perm ? `<span class="siege-item-part" title="Part of this engine">` +
                `${DWFUI.TOKENS.glyphs.building}</span>`
              : `<span class="siege-item-part is-empty" aria-hidden="true"></span>`) +
        DWFUI.actionButtonsHtml(actions,
          { preset: "itemActions", cls: "siege-item-actions dwfui-actions",
            ariaLabel: "Item actions" }),
    });
  }
  function siegeContentsSectionHtml(state) {
    const rows = state.items.map(siegeContentRowHtml).join("");
    return `<div class="siege-rule" role="separator"></div>` +
      `<div class="siege-contents" aria-label="What this engine holds">${rows}</div>`;
  }

  function siegeJobsSectionHtml(state) {
    const rows = state.jobs.map(job => window.zoneUnitRowHtml({
      label: job.kind === "load" ? "Load" : job.kind === "fire" ? "Fire" : "Other task",
      // A load job off the centre tile is on the loading side; a blocked approach there is exactly
      // what stops an engine that looks fine otherwise.
      meta: job.claimed
        ? (job.atCentre ? "Claimed" : `Claimed, loading side at ${job.x}, ${job.y}`)
        : (job.atCentre ? "Waiting for a dwarf" : `Waiting for a dwarf at ${job.x}, ${job.y}`),
    }));
    return `<div class="zone-section-label">Queued work</div>` +
      window.zoneUnitListHtml(rows, "Nothing queued.");
  }

  function siegeEnginePanelMarkup(data) {
    const state = siegeEnginePanelState(data);
    const buildText = `${state.buildStage} of ${state.maxBuildStage}`;
    const loadedText = state.loadedChip === "unknown" ? "Not finished yet"
      : state.loadedChip === "loaded" ? (state.boltThrower ? `${state.loadedQty} loaded` : "Loaded") : "Empty";
    const statusRows =
      siegeStatusRowHtml("Type", escapeHtml(state.kindName)) +
      siegeStatusRowHtml("Built", escapeHtml(buildText)) +
      siegeStatusRowHtml("Pointing", siegeFacingArrowHtml(state.facing.dx, state.facing.dy, "Pointing")) +
      (state.boltThrower
        ? siegeStatusRowHtml("Parks facing",
            siegeFacingArrowHtml(state.resting.dx, state.resting.dy, "Parks facing")) : "") +
      siegeStatusRowHtml("Ammunition", escapeHtml(loadedText)) +
      (state.built ? siegeStatusRowHtml("Reload", state.cycling ? "Cycling" : "Ready") : "") +
      (state.built ? siegeStatusRowHtml("Ammunition search", state.searching ? "Waiting before it looks again" : "Idle") : "") +
      (state.boltThrower && state.built ? siegeStatusRowHtml("Turning", state.turning ? "Mid-turn" : "Settled") : "") +
      siegeStatusRowHtml("Operator", escapeHtml(state.operatorText));
    // The most confusing state a siege engine can be in: the mode reads "fire at enemies" and nothing
    // happens, because the forbidden state is the forbid flag on the item it was built from.
    const inertRow = state.forbidden
      ? DWFUI.statusHtml({ cls: "zone-note", tone: "warn", columns: SIEGE_PROSE_COLUMNS,
          text: "Inert: the item this engine was built from is forbidden, so it will not load and will not fire. Changing the setting below will not help — unforbid that item." })
      : "";
    // The other two kinds never read the facing field, so they get no control rather than a disabled
    // one: a value set there is one the game will never act on.
    const restingStrip = state.canAim ? siegeRestingStripHtml(state) : "";
    // Every DWF-only region lives BELOW the sheet in `.siege-supplement`. The two exceptions are the
    // inert row and the partial-stack warning, both conditional and both mandatory.
    const supplement =
      `<div class="siege-supplement">` +
      DWFUI.plaqueBtnHtml({ cls: "building-btn", label: "Back to building", dataset: { buildingBack: "" } }) +
      `<div class="zone-section-label">Status</div><div class="siege-status">${statusRows}</div>` +
      // The ladder in full for the live value. Native prints no such line; DWF does, because the ladder
      // is the single most misread thing about this building.
      `<div class="zone-note siege-action-note-on">${escapeHtml(state.rows.find(r => r.selected)?.note || "")}</div>` +
      // What the parking control means and, for the kinds that have none, why its absence is a game rule.
      (state.canAim
        ? `<div class="zone-note">This is where the engine points when it has nothing to shoot at. It does not aim the engine now.</div>`
        : `<div class="zone-note">This engine was aimed when it was placed and cannot be turned afterwards.</div>`) +
      (state.boltThrower
        ? `<div class="zone-note">The game also counts bolts nearby and available, nearby but assigned ` +
          `to squads, and nearby but assigned to hunters. This build does not read those, and an ` +
          `approximated one would be worse than none, so they are left out rather than guessed.</div>`
        : state.kind === 0
          ? `<div class="zone-note">Fires one boulder at a time. It will take any hard, non-economic stone, and asks for no particular one.</div>`
          : "") +
      siegeJobsSectionHtml(state) +
      `<div class="zone-section-label">Not available</div>` +
      siegeBlockedControlsHtml(state) +
      `</div>`;
    return `<div class="siege-sheet">` +
      siegeHeaderHtml(state) +
      `<div class="siege-body">` +
        siegeActionBandHtml(state) +
        restingStrip +
        siegeAmmoSectionHtml(state) +
        inertRow +
      `</div>` +
      siegeContentsSectionHtml(state) +
      `</div>` + supplement;
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

  // Re-read and render what the game reports, never what was sent: the write either took or it did not.
  async function postSiegeEngineAction(id, mode) {
    const r = await fetch(`/siege-engine/action?id=${id}&mode=${mode}&t=${Date.now()}`,
      { method: "POST", cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("siege-engine-panel.action-response-parse"); }
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "setting failed");
    return data;
  }

  async function postSiegeEngineRestingFacing(id, dir) {
    const r = await fetch(`/siege-engine/resting-facing?id=${id}&dir=${dir}&t=${Date.now()}`,
      { method: "POST", cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("siege-engine-panel.facing-response-parse"); }
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "setting failed");
    return data;
  }

  function leverLinkPickState(data, targetId) {
    const status = window.leverLinkMechanismStatus(data);
    const targets = window.leverLinkLegalTargets(data);
    const id = Number(targetId);
    const hasTarget = targets.some(t => t.id === id);
    return {
      enabled: status.canLink && hasTarget,
      reason: status.canLink ? (hasTarget ? "" : "target unavailable") : "needs mechanisms",
    };
  }
  async function fetchCoffinBurialInfo(id) {
    try {
      const r = await fetch(`/burial-coffin?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      if (data && data.ok !== false && data.isCoffin) return data;
    } catch { globalThis.DwfErr?.count("siege-engine-panel.coffin-info"); }
    return null;
  }

  async function postCoffinBurialAction(id, action) {
    const r = await fetch(`/burial-coffin-action?id=${id}&action=${encodeURIComponent(action)}&t=${Date.now()}`, {
      method: "POST", cache: "no-store"
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("siege-engine-panel.burial-response-parse"); }
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "burial action failed");
    return data;
  }


  async function openSiegeEnginePanel(id, notice) {
    const data = await fetchSiegeEngineInfo(id);
    if (!data) { window.openBuildingPanel(id); return; }
    // The notice reports work the last click DELETED -- the one effect of a setting change a player
    // cannot reconstruct from the panel. It wraps: a failed write reports the server's own sentence.
    window.setViewSheetPanel("building-panel zone-panel zone-wide siege-panel", (notice
      ? DWFUI.statusHtml({ cls: "zone-note", tone: "warn", columns: SIEGE_PROSE_COLUMNS,
          text: notice }) : "") +
      siegeEnginePanelMarkup(data));
    selection.querySelectorAll("[data-siege-action]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const mode = Number(btn.dataset.siegeAction);
      btn.disabled = true;
      let report = "";
      try {
        const result = await postSiegeEngineAction(id, mode);
        const cancelled = Number(result.cancelledFireJobs) || 0;
        if (cancelled > 0)
          report = `${cancelled} queued shot${cancelled === 1 ? "" : "s"} cancelled.`;
      } catch (e) {
        report = e && e.message ? e.message : "setting failed";
      }
      // Re-read and render what the game reports, never what was sent.
      openSiegeEnginePanel(id, report);
      focusPage();
    }));
    selection.querySelectorAll("[data-siege-resting]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      btn.disabled = true;
      let report = "";
      try { await postSiegeEngineRestingFacing(id, Number(btn.dataset.siegeResting)); }
      catch (e) { report = e && e.message ? e.message : "setting failed"; }
      openSiegeEnginePanel(id, report);
      focusPage();
    }));
    // `[data-bld-act]` is bound in window.openBuildingPanel only, so rendering the tile here without this
    // handler would ship a native-looking button that silently does nothing.
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

  if (typeof window !== "undefined") Object.assign(window, { fetchCoffinBurialInfo, fetchSiegeEngineInfo, openSiegeEnginePanel, postCoffinBurialAction, siegeEnginePanelState });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { SIEGE_PROSE_COLUMNS, SIEGE_BAND_COLUMNS, SIEGE_ACTION_ROWS, SIEGE_ACTION_LABELS, SIEGE_ACTION_STATUS, siegeFacingWords, siegeFacingTurn, siegeFacingArrowHtml, siegeStatusRowHtml, SIEGE_OPERATOR_WORDS, siegeEnginePanelState, siegeBlockedControlsHtml, siegeHeaderHtml, siegeActionBandHtml, SIEGE_RESTING_DX, SIEGE_RESTING_DY, SIEGE_RESTING_SCREEN_ORDER, siegeRestingStripHtml, SIEGE_COUNT_LINES, siegeBoltCountsHtml, siegeAmmoSectionHtml, siegeContentRowHtml, siegeContentsSectionHtml, siegeJobsSectionHtml, siegeEnginePanelMarkup, fetchSiegeEngineInfo, postSiegeEngineAction, postSiegeEngineRestingFacing, leverLinkPickState, fetchCoffinBurialInfo, postCoffinBurialAction, openSiegeEnginePanel });
