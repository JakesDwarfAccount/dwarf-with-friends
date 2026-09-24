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

// DWFUI: the shared UI component layer. Every builder is DUMB and DECLARATIVE -- config in,
// HTML string out. No fetch, no DOM mutation, no listeners, no state.
(function (root) {
  "use strict";

  const VERSION = "2.0.0";

  // THE INTERFACE SCALE IS NEVER STATED IN JAVASCRIPT: `--dwfui-interface-scale` in the stylesheet
  // :root is the one declaration, and every geometry here is `native * that`. SOFTEN is THE tunable.
  const SOFTEN = 0.5;
  const MIN_IFACE = 0.5, MAX_IFACE = 4;

  function _cssNumber(doc, prop, fallback) {
    const el = doc && doc.documentElement;
    const view = doc && doc.defaultView;
    if (!el || !view || typeof view.getComputedStyle !== "function") return fallback;
    let raw;
    try { raw = view.getComputedStyle(el).getPropertyValue(prop); } catch { return fallback; }
    const n = Number(String(raw == null ? "" : raw).trim());
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
  // The scale DF's interface is drawn at on this document. ONE source of truth: the CSS token.
  function interfaceScale(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const n = _cssNumber(d, "--dwfui-interface-scale", 1);
    return Math.max(MIN_IFACE, Math.min(MAX_IFACE, n));
  }
  // The UI-scale slider MULTIPLIES on top of the interface scale: rasterise into the BACKING STORE
  // at interfaceScale x zoom and pin the CSS box unzoomed, so the slider gets crisper, not blurrier.
  function uiZoom(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const n = _cssNumber(d, "--ui-scale", 1);
    return Math.max(MIN_IFACE, Math.min(MAX_IFACE, n));
  }
  // THE ONE RUNTIME KNOB: moves DF's whole interface -- art and text -- onto a new grid in one call.
  function setInterfaceScale(doc, scale) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || !d.documentElement) return 1;
    const s = Math.max(MIN_IFACE, Math.min(MAX_IFACE, Number(scale) || 1));
    d.documentElement.style.setProperty("--dwfui-interface-scale", String(s));
    _publishInterfaceScale(d, s);
    // The mounts bake the scale into their crops, so they are stale the moment it moves. NOT
    // data-dwfui-btn-states: that swap repaints through paintSprites, which reads the scale fresh.
    for (const marker of ["data-dwfui-tabs", "data-dwfui-plaques", "data-dwfui-scrollbar", "data-dwfui-cycler"])
      d.documentElement.removeAttribute(marker);
    try { mountScrollbarArt(d); } catch (error) { DwfErr.report("dwfui.scale-scrollbar-art", error); }
    try { mountTabArt(d); } catch (error) { DwfErr.report("dwfui.scale-tab-art", error); }
    try { mountPlaqueArt(d); } catch (error) { DwfErr.report("dwfui.scale-plaque-art", error); }
    try { mountCyclerArt(d); } catch (error) { DwfErr.report("dwfui.scale-cycler-art", error); }
    try { mountButtonStateArt(d); } catch (error) { DwfErr.report("dwfui.scale-button-art", error); }
    try { paintSprites(d); } catch (error) { DwfErr.report("dwfui.scale-sprites", error); }
    try { refitNativeLabels(d); } catch (error) { DwfErr.report("dwfui.scale-labels", error); }
    const bitmap = root && root.DFBitmapText;
    if (bitmap && bitmap.configure) bitmap.configure(d, { interfaceScale: s });
    if (bitmap && bitmap.schedule) bitmap.schedule(d);
    return s;
  }
  // The art is painted at `s` AND `s` is stamped, so DFBitmapText's text never has to guess the scale.
  function _publishInterfaceScale(doc, scale) {
    const el = doc && doc.documentElement;
    if (!el || !el.setAttribute) return;
    const value = String(Number(scale.toFixed(4)));
    if (el.getAttribute("data-dwfui-interface-scale") !== value)
      el.setAttribute("data-dwfui-interface-scale", value);
  }

  // THE BLEND, baked: (1 - SOFTEN) nearest + SOFTEN bilinear via "lighter", which is additive on
  // PREMULTIPLIED pixels so the layers interpolate. source-over would leave a haloed nearest blit.
  function _bakeBlit(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh) {
    const integral = Math.abs(dw / sw - Math.round(dw / sw)) < 1e-6 &&
      Math.abs(dh / sh - Math.round(dh / sh)) < 1e-6;
    const soften = integral ? 0 : SOFTEN;
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "lighter";
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1 - soften;
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    if (soften > 0) {
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = soften;
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = prevOp;
  }

  // ---- text utils -----------------------------------------------------------------------------
  // THE escaper: nothing resolves an escaper from global scope, so no top-level `escapeHtml` can reroute it.
  const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => HTML_ESC[ch]);
  }
  // Native capitalizes display names; the wire keeps the raw lowercase. Display-side only.
  function sentenceCase(value) {
    const s = String(value == null ? "" : value);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  // Native SQUEEZES first (drop a leading article, then delete vowels from the back) and only cuts
  // if that still does not fit. NATIVE-WIDTH SLOTS ONLY -- never prose or editable copy.
  const _VOWELS = "aeiouAEIOU";
  // Native keeps word-initial vowels, which is what stops the squeeze turning "Urist" into "rist".
  function _isWordInitial(text, i) {
    if (i === 0) return true;
    return !/[A-Za-z]/.test(text.charAt(i - 1));
  }
  // Deliberately does NOT hard-cut: the caller owns the cut, because the caller also writes the
  // three periods, and cutting in both places would chop the name twice.
  function abbreviateToCells(text, cells) {
    let value = String(text == null ? "" : text);
    const budget = Math.max(0, Math.floor(Number(cells) || 0));
    if (value.length <= budget) return value;
    // One leading article, longest form first so "an " is not read as "a " + "n ".
    const article = /^(the|an|a)\s+/i.exec(value);
    if (article) {
      value = value.slice(article[0].length);
      if (value.length <= budget) return value;
    }
    // Delete non-word-initial vowels from the BACK, stopping the instant the text fits.
    const chars = Array.from(value);
    for (let i = chars.length - 1; i >= 0 && chars.length > budget; i--) {
      if (_VOWELS.indexOf(chars[i]) < 0) continue;
      if (_isWordInitial(chars.join(""), i)) continue;
      chars.splice(i, 1);
    }
    return chars.join("");
  }
  // Squeeze first, then cut and overwrite the last three characters with three separate PERIODS --
  // never the ellipsis glyph, which does not exist in DF's CP437 atlas and would render as a hole.
  function fitNativeLabel(text, cells) {
    const budget = Math.max(0, Math.floor(Number(cells) || 0));
    const squeezed = abbreviateToCells(text, budget);
    if (squeezed.length <= budget) return squeezed;
    return budget < 4 ? squeezed.slice(0, budget) : squeezed.slice(0, budget - 3) + "...";
  }
  function kebab(key) { return String(key).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(); }
  function datasetAttrs(dataset) {
    return Object.keys(dataset || {}).map(key =>
      ` data-${kebab(key)}="${esc(dataset[key])}"`).join("");
  }

  // The real text stays in the DOM; DFBitmapText hides this fallback only once every character is drawn.
  function bitmapTextHtml(value, opts) {
    const o = opts || {};
    const text = String(value == null ? "" : value);
    const fit = o.fitNativeLabel || null;
    if (fit && fit.host && fit.host !== "parent" && fit.host !== "tab")
      throw new Error("DWFUI.bitmapTextHtml: `fitNativeLabel.host` must be parent | tab");
    const fitAttrs = fit
      ? ` data-dwfui-fit-native-label data-dwfui-fit-original="${esc(text)}"` +
        ` data-dwfui-fit-host="${esc(fit.host || "parent")}"` +
        ` data-dwfui-fit-reserve-cells="${Math.max(0, Math.floor(Number(fit.reserveCells) || 0))}"` +
        ` aria-label="${esc(text)}"`
      : "";
    return `<span class="dwfui-bitmap-text${o.cls ? " " + o.cls : ""}"` +
      `${o.id ? ` id="${esc(o.id)}"` : ""} data-dwfui-bitmap-text="${esc(text)}"${o.scale ? ` data-dwfui-bitmap-scale="${esc(o.scale)}"` : ""}` +
      `${o.eager ? " data-dwfui-bitmap-eager" : ""}${fitAttrs}>` +
      `<span class="dwfui-bitmap-fallback">${esc(text)}</span></span>`;
  }
  // Retext a bitmap label in place; `host` is the label or any wrapper around one. Writes only on a change.
  function setBitmapText(host, value) {
    const label = host && host.getAttribute("data-dwfui-bitmap-text") != null
      ? host : host && host.querySelector("[data-dwfui-bitmap-text]");
    const text = String(value == null ? "" : value);
    if (!label || label.getAttribute("data-dwfui-bitmap-text") === text) return false;
    label.setAttribute("data-dwfui-bitmap-text", text);
    const fallback = label.querySelector(".dwfui-bitmap-fallback");
    if (fallback) fallback.textContent = text;
    return true;
  }
  // A bitmap label is ONE canvas with no break opportunities, so prose must be broken to a character
  // column BEFORE rendering. A word longer than the column gets its own line, never a cut.
  function wrapToColumns(text, columns) {
    const width = Math.max(8, Number(columns) || 40);
    const out = [];
    let line = "";
    for (const word of String(text == null ? "" : text).split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  }

  // One bitmap label per wrapped line; each label's fallback text keeps the whole sentence readable.
  function bitmapProseHtml(value, columns, opts) {
    const o = opts || {};
    return wrapToColumns(value, columns)
      .map(line => `<span class="dwfui-bitmap-line${o.cls ? " " + o.cls : ""}">` +
        bitmapTextHtml(line, { scale: o.scale, eager: o.eager }) + `</span>`).join("");
  }

  // ---- TOKENS: one import point for palette, fonts, native art and the glyph vocabulary --------
  // Art keys reference the --spa-* custom properties BY NAME, so JS and CSS never inline copies.
  const TOKENS = {
    palette: {
      // LEGACY approximations, kept so unmigrated surfaces keep rendering. Each is superseded by a
      // `native*` key below; do NOT reach for these in new code.
      gold: "#d89b27", goldBright: "#ffd45c", goldBorder: "#ffe26c",
      ink: "#151515", inkDeep: "#0b0a08", panel: "#242326", panelAlt: "#1d1c1f",
      parchment: "#f2e6cf", parchmentDim: "#b9ad95",
      green: "#56ce42", greenBright: "#b0ff85", greenSoft: "#7ac74f",
      red: "#d9443f", orange: "#ff8a00", offGray: "#5a5a62",
      // Every key is mirrored as a --dwfui-* custom property, so CSS and JS consume the same value.
      // "parchment" is a MISNOMER: it is the outer game frame art and appears in zero DF menus.
      surface: "#1c1c1c",          // THE panel surface. ONE value, not our three (ink/panel/panelAlt).
      hatch: "#252525",            // the diagonal row-hatch over `surface` -- we render flat today
      goldNative: "#ffbf01",       // frame gold / numeric readout ("#d89b27" is wrong)
      goldBrightNative: "#ffc300", // frame bevel bright stop ("#ffd45c" is wrong)
      goldBevelDark: "#a46028",    // 3-stop gold bevel, dark
      goldBevelMid: "#cc8a20",     // 3-stop gold bevel, mid
      plum: "#614151",             // UNSELECTED TAB fill AND the scrollbar thumb fill
      slate: "#5c625e",            // unselected subtab
      silver: "#d8dbe4",           // selected subtab; search-field border
      slab: "#4e474e",             // the HORIZONTAL_OPTION_* text plaque slab
      destructive: "#a61f2e",      // the "Done" plaque fill (the red X glyph is SPRITE art)
      checkFill: "#206020", checkMark: "#60c800",   // checkbox on: fill / mark
      // These five are palette INDICES, spelled as such so a player-edited colors.txt wins.
      textPrimary: "var(--df-c15)",   // 15 WHITE -- window title + primary row label
      textDim: "var(--df-c7)",        // 7 LGRAY #c0c0c0 (was #d7d7d7)
      textWarning: "var(--df-c12)",   // 12 LRED = ORANGE #ff7111 (was #ff7f13)
      textGood: "var(--df-c10)",      // 10 LGREEN #13fd65 (was #16ff76)
      textActive: "var(--df-c11)",    // 11 LCYAN #12fecf -- job / in-progress (was #14ffe9)
      glyphOnGold: "#1a1324",      // selected-tab label on the gold tab -- dark indigo, NOT #000
      // UNPROVEN: the source captures are JPEG, whose filtering destroys the RGB. Value kept as-is.
      subsubSelected: "#ff7f13",
      // scrollbar (pixel-scanned from an approved oracle)
      sbRail: "#c0c4d3",           // silver rails
      sbGutter: "#1c1c1c",         // the gutter IS the panel background -- no lighter track fill
      sbThumb: "#614151",          // the same plum as an unselected tab
      sbThumbEdge: "#f6b811",      // gold thumb side edges / chevron caps
      sbThumbEdgeDark: "#d0a500",
      // Only the INDEX may be carried: a colour NAME is not a colour (DF's "bright red" is orange).
      // These are the stock defaults; applyPalette's live gps->uccolor values always win over them.
      df16: ["#000000", "#207df1", "#a2dc34", "#71bbb0", "#ff113a", "#a73cd5", "#d79b2d", "#c0c0c0",
             "#a0a0a0", "#8c66ff", "#13fd65", "#12fecf", "#ff7111", "#e811ff", "#ffe111", "#ffffff"],
      // World-map raster colour tables: data-to-colour maps the world map consumes through canvas
      // fillStyle, not DOM chrome, so they belong in the token layer.
      worldMap: {
        // site type -> marker colour (worldSiteColor lookup by site.type)
        site: {
          PlayerFortress: "#ffd54f", Fortress: "#b0bec5", DarkFortress: "#8e24aa",
          Town: "#66bb6a", MountainHalls: "#a1887f", ForestRetreat: "#43a047",
          Cave: "#6d4c41", Camp: "#bcaaa4", Monument: "#90a4ae",
        },
        siteOwn: "#ff5252",      // worldSiteColor(type, own=true) -- the player's own fort highlight
        siteUnknown: "#78909c",  // worldSiteColor fallback for a site type absent from `site`
        // biome char -> raster colour (worldTerrainColor lookup); unknown char -> "" (draws nothing)
        terrain: {
          "~": "#274b6e", "l": "#356a8a", "^": "#6b5f50", "T": "#2f5a2c",
          ".": "#4e7638", "d": "#b9a566", "n": "#6d6a53", "f": "#3f5f3a",
        },
      },
    },
    // DF's 8x12 AUTHORING text cell, in px; the drawn cell is this times the interface scale.
    font: { face: "var(--dwfui-font-face)", cell: { w: 8, h: 12 } },
    // Every text role resolves to a --dwfui-* custom property, so a CSS rule and a JS builder cannot
    // drift apart. A migrated family may NOT define its own colour table.
    text: {
      title: "var(--dwfui-text-title)",
      heading: "var(--dwfui-text-heading)",
      body: "var(--dwfui-text-body)",
      prose: "var(--dwfui-text-prose)",
      row: "var(--dwfui-text-row)",
      secondary: "var(--dwfui-text-secondary)",
      disabled: "var(--dwfui-text-disabled)",   // `needs the owner evidence` Q2 -- assumed = secondary
      warning: "var(--dwfui-text-warning)",
      good: "var(--dwfui-text-good)",
      active: "var(--dwfui-text-active)",
      selected: "var(--dwfui-text-selected)",
      numeric: "var(--dwfui-text-numeric)",
    },
    art: {
      frameGold: "var(--spa-frame-gold)", greenStrip: "var(--spa-green-strip)",
      winframe: "var(--spa-winframe)",
      plaqueAll: "var(--spa-plaque-all)", plaqueDone: "var(--spa-plaque-done)",
      plaqueNone: "var(--spa-plaque-none)",
      rowGreen: "var(--spa-row-green)", rowRed: "var(--spa-row-red)",
      rowGrey: "var(--spa-row-grey)",
    },
    // ---- native sprite vocabulary ------------------------------------------------------------
    sprites: {
      // header tool cluster. Native ordering invariant: quill SECOND-FROM-RIGHT, remove RIGHTMOST.
      quill: "UNIT_SHEET_CUSTOMIZE",            // 32x36 -- rename. The owner asks for this BY NAME (x4).
      removeBuilding: "BUILDING_SHEET_REMOVE",  // 32x36 -- the cancelled house. The owner asks BY NAME.
      assignWorker: "BUILDING_SHEET_ASSIGN_WORKER",
      cameraOn: "UNIT_SHEET_CAMERA_ACTIVE", cameraOff: "UNIT_SHEET_CAMERA_INACTIVE",
      viewReports: "UNIT_SHEET_VIEW_REPORTS",   // action is `needs the owner evidence` E3-B9
      expel: "UNIT_SHEET_EXPEL",
      openAnnouncements: "ANNOUNCEMENT_OPEN_ALL_ANNOUNCEMENTS",
      settings: "BUTTON_SETTINGS", back: "BUTTON_CLOSE_LEFT",   // back is a gold LEFT ARROW, not an X
      close: "BUILDING_JOBS_REMOVE",             // native red X tile used by shared panel headers
      // search
      filter: "BUTTON_FILTER",                  // 48x36 = an empty cell + the magnifier cell
      filterNoMagRight: "BUTTON_FILTER_NO_MAG_RIGHT",
      filterName: "BUTTON_FILTER_NAME",         // the quill-capped rename field
      // item / row actions; these retire the TOKENS.glyphs emoji.
      view: "STOCKS_VIEW_ITEM", inspect: "SQUADS_INSPECT",
      forbid: "STOCKS_FORBID", forbidOn: "STOCKS_FORBID_ACTIVE",
      dump: "STOCKS_DUMP", dumpOn: "STOCKS_DUMP_ACTIVE",
      hide: "STOCKS_HIDE", hideOn: "STOCKS_HIDE_ACTIVE",
      melt: "STOCKS_MELT", meltOn: "STOCKS_MELT_ACTIVE",
      recenter: "RECENTER_RECENTER", recenterStocks: "STOCKS_RECENTER",
      recenterLocations: "RECENTER_HOTKEYS",
      recenterSurface: "RECENTER_SURFACE", recenterDeepest: "RECENTER_DEEPEST",
      recenterSet: "RECENTER_SET_LOCATION", recenterClear: "RECENTER_REMOVE_OR_CLEAR",
      // the minimap display toggles are COMPLETE 16x24 native cells (frame baked into the
      // ON faces) -- interface_bits_display_toggles.png rows 0 and 1.
      liquidNumbersOff: "LIQUID_NUMBERS_OFF", liquidNumbersOn: "LIQUID_NUMBERS_ON",
      rampArrowsOff: "RAMP_ARROWS_OFF", rampArrowsOn: "RAMP_ARROWS_ON",
      zoomInOff: "ZOOM_IN_OFF", zoomInOn: "ZOOM_IN_ON",
      zoomOutOff: "ZOOM_OUT_OFF", zoomOutOn: "ZOOM_OUT_ON",
      // task controls. "It turns GREEN when you click it" is not a colour to invent --
      // it is BUILDING_JOBS_SUSPENDED_ACTIVE, with the green baked into the sprite.
      suspend: "BUILDING_JOBS_SUSPENDED", suspendOn: "BUILDING_JOBS_SUSPENDED_ACTIVE",
      repeat: "BUILDING_JOBS_REPEAT", repeatOn: "BUILDING_JOBS_REPEAT_ACTIVE",
      cancelJob: "BUILDING_JOBS_REMOVE", jobRemoveWorker: "BUILDING_JOBS_REMOVE_WORKER",
      // The workshop task row's remaining states. All eleven BUILDING_JOBS_* records are complete
      // 24x36 control cells that carry DF's own frame, so all eleven are self-framed below.
      jobActive: "BUILDING_JOBS_ACTIVE",
      jobDoNow: "BUILDING_JOBS_DO_NOW", jobDoNowOn: "BUILDING_JOBS_DO_NOW_ACTIVE",
      jobPriorityUp: "BUILDING_JOBS_PRIORITY_UP", jobQuota: "BUILDING_JOBS_QUOTA",
      // The stockpile panel's own art. These records carry DF's frame, so .dwfui-art-btn must not
      // add a second one -- that is the double-frame defect.
      spRepaint: "STOCKPILE_REPAINT", spRemove: "STOCKPILE_REMOVE_EXISTING",
      spTakeAnywhere: "STOCKPILE_TAKE_FROM_ANYWHERE", spTakeLinksOnly: "STOCKPILE_TAKE_FROM_LINKS_ONLY",
      spConnections: "STOCKPILE_SET_CONNECTIONS", spToolSettings: "STOCKPILE_TOOL_SETTINGS",
      spTypeOn: "STOCKPILE_TYPE_ACTIVE", spTypeOff: "STOCKPILE_TYPE_INACTIVE",
      // The workshop side of a stockpile link: the two arming tiles, then the direction each
      // established link shows. The give/take pair differs ONLY in the small arrow.
      wsLinkArmGive: "STOCKPILE_CONNECTIONS_WORKSHOP_ADD_GIVE_LINK",
      wsLinkArmTake: "STOCKPILE_CONNECTIONS_WORKSHOP_ADD_TAKE_LINK",
      wsLinkGive: "STOCKPILE_CONNECTIONS_WORKSHOP_GIVE_LINK",
      wsLinkTake: "STOCKPILE_CONNECTIONS_WORKSHOP_TAKE_LINK",
      siegeFireAtWill: "BUILDING_INFO_SIEGE_ENGINE_FIRE_AT_WILL",
      siegeFireAtWillOn: "BUILDING_INFO_SIEGE_ENGINE_FIRE_AT_WILL_ACTIVE",
      siegePracticeFire: "BUILDING_INFO_SIEGE_ENGINE_PRACTICE_FIRE",
      siegePracticeFireOn: "BUILDING_INFO_SIEGE_ENGINE_PRACTICE_FIRE_ACTIVE",
      siegePrepareToFire: "BUILDING_INFO_SIEGE_ENGINE_PREPARE_TO_FIRE",
      siegePrepareToFireOn: "BUILDING_INFO_SIEGE_ENGINE_PREPARE_TO_FIRE_ACTIVE",
      siegeKeepLoaded: "BUILDING_INFO_SIEGE_ENGINE_KEEP_LOADED",
      siegeKeepLoadedOn: "BUILDING_INFO_SIEGE_ENGINE_KEEP_LOADED_ACTIVE",
      siegeNotInUse: "BUILDING_INFO_SIEGE_ENGINE_NOT_IN_USE",
      siegeNotInUseOn: "BUILDING_INFO_SIEGE_ENGINE_NOT_IN_USE_ACTIVE",
      workerAny: "WORKER_DO_ANY_AVAILABLE_JOB",       // GREEN, OPEN padlock: does any free task
      workerOnly: "WORKER_ONLY_DO_ASSIGNED_JOBS",     // RED, CLOSED padlock: specialized. Ctrl+z.
      workDetailMiners: "WORK_DETAIL_MINERS",                   // the pick
      workDetailWoodcutters: "WORK_DETAIL_WOODCUTTERS",         // the axe in the stump
      workDetailHunters: "WORK_DETAIL_HUNTERS",                 // the bolt
      workDetailPlanters: "WORK_DETAIL_PLANTERS",               // the standing crop
      workDetailFishermen: "WORK_DETAIL_FISHERMEN",             // the fish on a rod
      workDetailStonecutters: "WORK_DETAIL_STONECUTTERS",       // the plain slab
      workDetailEngravers: "WORK_DETAIL_ENGRAVERS",             // the engraved slab
      workDetailPlantGatherers: "WORK_DETAIL_PLANT_GATHERERS",  // the bag of plants
      workDetailHaulers: "WORK_DETAIL_HAULERS",                 // the crate
      workDetailOrderlies: "WORK_DETAIL_ORDERLIES",             // the bucket + water drop
      workDetailSiegeOperators: "WORK_DETAIL_SIEGE_OPERATORS",
      workDetailCustom1: "WORK_DETAIL_CUSTOM_1", workDetailCustom2: "WORK_DETAIL_CUSTOM_2",
      workDetailCustom3: "WORK_DETAIL_CUSTOM_3", workDetailCustom4: "WORK_DETAIL_CUSTOM_4",
      workDetailCustom5: "WORK_DETAIL_CUSTOM_5", workDetailCustom6: "WORK_DETAIL_CUSTOM_6",
      workDetailCustom7: "WORK_DETAIL_CUSTOM_7", workDetailCustom8: "WORK_DETAIL_CUSTOM_8",
      // steppers + reorder. Native order is `value [#][+][-]`.
      stepHash: "WORK_ORDERS_ENTER_AMOUNT",
      stepPlus: "WORK_ORDERS_INCREASE_AMOUNT",
      stepMinus: "WORK_ORDERS_DECREASE_AMOUNT",
      priorityUp: "WORK_ORDERS_PRIORITY_UP", priorityDown: "WORK_ORDERS_PRIORITY_DOWN",
      // sort headers -- VANILLA DF, not a DFHack overlay.
      sortAsc: "SORT_ASCENDING_ACTIVE", sortAscOff: "SORT_ASCENDING_INACTIVE",
      sortDesc: "SORT_DESCENDING_ACTIVE", sortDescOff: "SORT_DESCENDING_INACTIVE",
      // Every name here is verified present in web/interface_map.json by dwfui_boot_test on every
      // build: a token absent from the map ships as an INVISIBLE HOLE, which is why that gate exists.
      invAssignedClothing: "INVENTORY_ASSIGNED_CLOTHING", invAssignedTool: "INVENTORY_ASSIGNED_TOOL",
      invAssignedSquad: "INVENTORY_ASSIGNED_SQUAD", invAssignedSymbol: "INVENTORY_ASSIGNED_SYMBOL",
      // THE universal native check tile: DF itself aliases this one 32x36 pair under three names,
      // so checkHtml defaults to it.
      checkOn: "SQUADS_SELECTED", checkOff: "SQUADS_NOT_SELECTED",
      // the squad order strip + row tiles. Icon-only, self-framed native control cells.
      squadsKill: "SQUADS_KILL_ORDER", squadsMove: "SQUADS_MOVE_ORDER",
      squadsPatrol: "SQUADS_PATROL_ORDER", squadsDefendBurrow: "SQUADS_DEFEND_BURROW_ORDER",
      squadsTrain: "SQUADS_TRAIN_ORDER", squadsCancelOrder: "SQUADS_CANCEL_ORDER",
      squadsChangeAlert: "SQUADS_CHANGE_ALERT", squadsPositions: "SQUADS_POSITIONS",
      squadsDisband: "SQUADS_DISBAND", squadsRecenter: "SQUADS_RECENTER",
      // The kitchen toggle is THREE-state in the art (allowed / restricted / cannot). Do not conflate
      // the two dark states, and never render nothing -- native renders a real CANNOT tile.
      kitchenCookAllowed: "LABOR_KITCHEN_COOK_ALLOWED", kitchenCookRestricted: "LABOR_KITCHEN_COOK_RESTRICTED",
      kitchenCookCannot: "LABOR_KITCHEN_COOK_CANNOT",
      kitchenBrewAllowed: "LABOR_KITCHEN_BREW_ALLOWED", kitchenBrewRestricted: "LABOR_KITCHEN_BREW_RESTRICTED",
      kitchenBrewCannot: "LABOR_KITCHEN_BREW_CANNOT",
      stoneAllowed: "LABOR_STONE_USE_ALLOWED", stoneRestricted: "LABOR_STONE_USE_RESTRICTED",
      magmaSafe: "LABOR_STONE_USE_MAGMA_SAFE", magmaUnsafe: "LABOR_STONE_USE_MAGMA_UNSAFE",
      laborAssigned: "LABOR_WORKER_ASSIGNED", laborUnassigned: "LABOR_WORKER_UNASSIGNED",
      laborEverybody: "LABOR_WORKER_ASSIGNED_EVERYBODY", laborNobody: "LABOR_WORKER_ASSIGNED_NOBODY",
      editWorkDetail: "LABOR_EDIT_WORK_DETAIL",   // the gear; its action ships as a placeholder
      selectAll: "SELECT_ALL",                    // "select every row" -- NOT the mass-toggle button
      tradeSelected: "ASSIGN_TRADE_SELECTED", tradeNotSelected: "ASSIGN_TRADE_NOT_SELECTED",
      tradeInDepot: "ASSIGN_TRADE_IN_DEPOT", tradeBeingBrought: "ASSIGN_TRADE_BEING_BROUGHT",
      tradeProhibited: "ASSIGN_TRADE_PROHIBITED",
      tradeSortDistanceOn: "ASSIGN_TRADE_SORT_BY_DISTANCE_ON",
      tradeSortDistanceOff: "ASSIGN_TRADE_SORT_BY_DISTANCE_OFF",
      tradeSortValueOn: "ASSIGN_TRADE_SORT_BY_VALUE_ON",
      tradeSortValueOff: "ASSIGN_TRADE_SORT_BY_VALUE_OFF",
      tradeCullMandatesOn: "ASSIGN_TRADE_CULLING_MANDATES_ON",
      tradeCullMandatesOff: "ASSIGN_TRADE_CULLING_MANDATES_OFF",
      // The kitchen column mass-toggle is a VIEW filter: it collapses the list to the rows a column
      // can act on and touches no game state. Not SELECT_ALL, which means "select every row".
      contractList: "CONTRACT_LIST",              // {cx:0,cy:300,w:32,h:36}  collapse -> hide CANNOT
      expandList: "EXPAND_LIST",                  // {cx:32,cy:300,w:32,h:36} expand   -> show all
      // work orders. The six status tiles + the four row/screen actions.
      woWaiting: "WORK_ORDERS_WAITING", woChecking: "WORK_ORDERS_CHECKING",
      woValidated: "WORK_ORDERS_VALIDATED", woNotValidated: "WORK_ORDERS_NOT_VALIDATED",
      woActive: "WORK_ORDERS_ACTIVE", woReady: "WORK_ORDERS_READY",
      woConditions: "WORK_ORDERS_CONDITIONS", woCreateNew: "WORK_ORDERS_CREATE_NEW",
      woRemove: "WORK_ORDERS_REMOVE", woDetails: "WORK_ORDERS_DETAILS",
      // THREE 24x12 COMPOSITION SLICES, not three buttons: they must NOT go in SELF_FRAMED_SPRITES.
      typeFilterLeft: "TYPE_FILTER_LEFT", typeFilterText: "TYPE_FILTER_TEXT",
      typeFilterRight: "TYPE_FILTER_RIGHT",
      // Slab/plaque source art (3-slice compositions, not self-framed) and the mood faces (glyph cells).
      rect: "BUTTON_RECTANGLE", rectLight: "BUTTON_RECTANGLE_LIGHT", rectDark: "BUTTON_RECTANGLE_DARK",
      rectSelected: "BUTTON_RECTANGLE_SELECTED", rectDivider: "BUTTON_RECTANGLE_DIVIDER",
      stress0: "BUTTON_STRESS_0", stress1: "BUTTON_STRESS_1", stress2: "BUTTON_STRESS_2",
      stress3: "BUTTON_STRESS_3", stress4: "BUTTON_STRESS_4", stress5: "BUTTON_STRESS_5",
      stress6: "BUTTON_STRESS_6",
      zoneRepaint: "ZONE_REPAINT", zoneRemove: "ZONE_REMOVE_EXISTING",
      zoneSuspend: "ZONE_SUSPEND_INACTIVE", zoneSuspendOn: "ZONE_SUSPEND",
      zonePickAnimals: "ZONE_PICK_ANIMALS", zoneAssignUnit: "ZONE_ASSIGN_UNIT",
      zoneLocationAssign: "ZONE_LOCATION_ASSIGN", zoneLocationDetails: "ZONE_LOCATION_DETAILS",
      zoneQuill: "HAULING_RENAME_ROUTE", zoneSquadList: "ZONE_SQUAD_LIST",
      // DF's own "this creature is assigned to a pasture" marker, from the unit selector.
      unitSelPasture: "UNIT_SELECTOR_PASTURE",
    },
    // The civzone type as an ART NAME, keyed by the server's own zone type key (`zone` is its
    // unnamed default). Wire payloads without a type key still position by coordinate elsewhere.
    zones: {
      meeting: "ZONE_MEETING", pen: "ZONE_PEN", pond: "ZONE_PIT", water: "ZONE_WATER_SOURCE",
      fishing: "ZONE_FISHING", sand: "ZONE_SAND", clay: "ZONE_CLAY", dump: "ZONE_DUMP",
      gather: "ZONE_GATHER", training: "ZONE_ANIMAL_TRAINING", dungeon: "ZONE_DUNGEON",
      bedroom: "ZONE_BEDROOM", dining: "ZONE_DINING_HALL", office: "ZONE_OFFICE",
      dormitory: "ZONE_DORMITORY", barracks: "ZONE_BARRACKS", archery: "ZONE_ARCHERY_RANGE",
      tomb: "ZONE_TOMB", shrine: "ZONE_SHRINE", temple: "ZONE_TEMPLE", library: "ZONE_LIBRARY",
      zone: "ZONE_MULTI",
    },
    // A crop paints at native 1:1, unscaled by --dwfui-interface-scale, so a whole-record w/h is not
    // redundant with `sprite`: it is the cell at native size inside a chassis the caller already owns.
    spriteCrops: {
      viewMagnifier: {
        sprite: "STOCKS_VIEW_ITEM", x: 7, y: 9, w: 12, h: 18,
        transparent: ["0,0,0", "28,28,28"],
      },
      filterMagnifier: {
        sprite: "BUTTON_FILTER", x: 25, y: 6, w: 17, h: 24,
        transparent: ["28,28,28"],
      },
      // BUTTON_FILTER is a 48x36 composition: pixels 0..15 are the field's left slice, 16..47 the
      // complete framed magnifier button. x=24 would discard its silver left border.
      filterButton: {
        sprite: "BUTTON_FILTER", x: 16, y: 0, w: 32, h: 36,
        transparent: [],
      },
      // The tri-state marks are the bare symbols inside DF's three stockpile state cells; the cells
      // are alpha-cut already, so no colour-keying.
      markCheck: { sprite: "STOCKPILE_ON", x: 5, y: 9, w: 23, h: 19, transparent: [] },
      markDash: { sprite: "STOCKPILE_PARTIAL", x: 6, y: 14, w: 20, h: 8, transparent: [] },
      markX: { sprite: "STOCKPILE_OFF", x: 6, y: 8, w: 21, h: 21, transparent: [] },
      // Whole cells at native size, for faces that live inside a caller's own button or slot.
      quillTile: { sprite: "BUTTON_FILTER_NAME", x: 0, y: 0, w: 32, h: 36, transparent: [] },
      stockpileOrganicOn: { sprite: "CUSTOM_STOCKPILE_ORGANIC_ON", x: 0, y: 0, w: 32, h: 36, transparent: [] },
      stockpileInorganicOn: { sprite: "CUSTOM_STOCKPILE_INORGANIC_ON", x: 0, y: 0, w: 32, h: 36, transparent: [] },
    },
    // Complete native controls already carry their own frame and must never receive this one;
    // frameless faces opt in explicitly through frameNineSlice({family:"pictureBox"}).
    frames: {
      default: "BUTTON_PICTURE_BOX",                    // plum fill, grey border
      hover: "BUTTON_PICTURE_BOX_LIGHT",                // plum fill, silver border
      disabled: "BUTTON_PICTURE_BOX_DARK",              // plum fill, near-black border
      selected: "BUTTON_PICTURE_BOX_SELECTED",          // plum fill, GOLD border
      active: "BUTTON_PICTURE_BOX_HIGHLIGHTED",         // GREEN fill, black border  <- the latch
      selectedActive: "BUTTON_PICTURE_BOX_SEL_HIGHLIGHTED",
    },
    // The chrome families are deliberately separate: the view-sheet compositor and the unit portrait
    // arm index different texpos blocks, and BORDER_* belongs to the fortress viewscreen renderer.
    frameFamilies: {
      viewSheet: {
        kind: "table3x3",
        scaleWithInterface: false, // scaling HOVER_RECTANGLE would violate its fixed 7px captured edge
        states: { default: "HOVER_RECTANGLE" },
      },
      pictureBox: {
        kind: "table3x3",
        states: {
          default: "BUTTON_PICTURE_BOX", hover: "BUTTON_PICTURE_BOX_LIGHT",
          disabled: "BUTTON_PICTURE_BOX_DARK", selected: "BUTTON_PICTURE_BOX_SELECTED",
          active: "BUTTON_PICTURE_BOX_HIGHLIGHTED",
          selectedActive: "BUTTON_PICTURE_BOX_SEL_HIGHLIGHTED",
        },
      },
      popupAcknowledge: {
        kind: "table3x3",
        states: { default: "HORIZONTAL_OPTION_CONFIRM" },
      },
      masterChrome: {
        kind: "pieces",
        minCols: 8, minRows: 6,
        tokens: {
          topLeft: "BORDER_TOP_LEFT", top: "BORDER_TOP", topRight: "BORDER_TOP_RIGHT",
          left: "BORDER_LEFT", right: "BORDER_RIGHT",
          bottomLeft: "BORDER_BOTTOM_LEFT", bottom: "BORDER_BOTTOM",
          bottomRight: "BORDER_BOTTOM_RIGHT",
        },
      },
    },
    // DF DOES NOT DIM A DISABLED CONTROL -- IT SWAPS THE SPRITE. `null` means DF ships NO art for that
    // state: fall back to `base`. Beware `_INACTIVE`: it usually means LATCHED-OFF, not unavailable.
    states: {
      add: { base: "BUTTON_ADD", hover: "BUTTON_ADD_HOVER", pressed: "BUTTON_ADD_PRESSED", disabled: "BUTTON_ADD_INVALID" },
      subtract: { base: "BUTTON_SUBTRACT", hover: "BUTTON_SUBTRACT_HOVER", pressed: "BUTTON_SUBTRACT_PRESSED", disabled: "BUTTON_SUBTRACT_INVALID" },
      // Excluded from automatic FACE inference: self-framed faces are complete opaque native cells,
      // so a second chassis would be hidden or leak around the margin.
      frame: {
        base: "BUTTON_PICTURE_BOX", hover: "BUTTON_PICTURE_BOX_LIGHT", pressed: null,
        disabled: "BUTTON_PICTURE_BOX_DARK", selected: "BUTTON_PICTURE_BOX_SELECTED",
        active: "BUTTON_PICTURE_BOX_HIGHLIGHTED", selectedActive: "BUTTON_PICTURE_BOX_SEL_HIGHLIGHTED",
      },
      qualityUp: { base: "QUALITY_UP", hover: null, pressed: null, disabled: "QUALITY_UP_INACTIVE" },
      qualityDown: { base: "QUALITY_DOWN", hover: null, pressed: null, disabled: "QUALITY_DOWN_INACTIVE" },
      // ON/OFF here means AVAILABLE / AT-THE-LIMIT, not pressed/released: the face selector tests the
      // zoom factor against its bound. No pressed or hover art exists, so both resolve to base.
      zoomIn: { base: "ZOOM_IN_ON", hover: null, pressed: null, disabled: "ZOOM_IN_OFF" },
      zoomOut: { base: "ZOOM_OUT_ON", hover: null, pressed: null, disabled: "ZOOM_OUT_OFF" },
    },
    // Every trapezoid is 3-sliced horizontally; the "chevron" between two tabs is NEGATIVE SPACE.
    // The tall `TAB` pair is deliberately unreachable from any level -- no capture shows DF using it.
    tabs: {
      primary: { off: "SHORT_TAB", on: "SHORT_TAB_SELECTED", w: 40, h: 24 },
      "primary-short": { off: "SHORT_TAB", on: "SHORT_TAB_SELECTED", w: 40, h: 24 },
      subtab: { off: "SHORT_SUBTAB", on: "SHORT_SUBTAB_SELECTED", w: 40, h: 24 },
      subsubtab: { off: "SHORT_SUBSUBTAB", on: "SHORT_SUBSUBTAB_SELECTED", w: 40, h: 24 },
    },
    // Tone is the TEXT COLOUR on a shared slab for the neutral tones, and a DIFFERENT SPRITE for destructive.
    plaques: {
      neutral: "HORIZONTAL_OPTION_INACTIVE", neutralOn: "HORIZONTAL_OPTION_ACTIVE",
      confirm: "HORIZONTAL_OPTION_CONFIRM", destructive: "HORIZONTAL_OPTION_REMOVE",
      ornamentLeft: "HORIZONTAL_OPTION_LEFT_ORNAMENT",     // the gold corner brackets =
      ornamentRight: "HORIZONTAL_OPTION_RIGHT_ORNAMENT",   // native's FOCUS affordance, not a fill
    },
    scrollbar: {
      bar: "SCROLLBAR",                                   // 16x36: idle-up | track | idle-down
      thumbTop: "SCROLLBAR_TOP_SCROLLER",                 // 16x12 -- the gold '^' chevron CAP
      thumbCenter: "SCROLLBAR_CENTER_SCROLLER",           // 16x12 -- one centred gem ornament
      thumbBottom: "SCROLLBAR_BOTTOM_SCROLLER",           // 16x12 -- the gold 'v' chevron CAP
      thumbSmall: "SCROLLBAR_SMALL_SCROLLER",             // 16x24 -- the MINIMUM thumb
      thumbBlank: "SCROLLBAR_BLANK_SCROLLER",             // 16x12 -- plain body; tile behind one gem
      thumbOffcenter: "SCROLLBAR_OFFCENTER_SCROLLER",     // 16x24 -- the gem straddling an even thumb's middle
      thumbSmallHover: "SCROLLBAR_SMALL_SCROLLER_HOVER",
      thumbOffcenterHover: "SCROLLBAR_OFFCENTER_SCROLLER_HOVER",
      thumbBlankHover: "SCROLLBAR_BLANK_SCROLLER_HOVER",
      thumbTopHover: "SCROLLBAR_TOP_SCROLLER_HOVER",
      thumbCenterHover: "SCROLLBAR_CENTER_SCROLLER_HOVER",
      thumbBottomHover: "SCROLLBAR_BOTTOM_SCROLLER_HOVER",
      upHover: "SCROLLBAR_UP_HOVER", upPressed: "SCROLLBAR_UP_PRESSED",
      downHover: "SCROLLBAR_DOWN_HOVER", downPressed: "SCROLLBAR_DOWN_PRESSED",
      cell: { w: 16, h: 12 },      // 2 cells wide, 1 cell tall
    },
    // DEPRECATED. Every entry below now has a real DF sprite in TOKENS.sprites; this is kept only so
    // unmigrated surfaces keep rendering. DO NOT ADD A KEY HERE -- new code uses sprites + iconHtml.
    glyphs: {
      view: "&#128269;",     // magnifier -- DEPRECATED: TOKENS.sprites.view (STOCKS_VIEW_ITEM).
      follow: "&#127909;",   // movie camera -- "go to / follow on map"
      forbid: "&#128274;",   // padlock
      dump: "&#128465;",     // wastebasket
      hide: "&#128065;",     // eye
      close: "&#10005;",     // MULTIPLICATION X (the building-x glyph)
      check: "&#10003;", cross: "&#10007;", back: "&#8592;",
      // Workshop task-row controls; the consumer's per-action classes colour them.
      repeat: "&#8635;",             // clockwise open circle arrow (native green recycle)
      priority: "!",
      pause: "&#10074;&#10074;",     // two heavy vertical bars (native blue pause)
      play: "&#9654;",               // resume affordance when a task is suspended
      building: "&#127968;",         // house -- contents-row "part of this building" status
      minus: "&#8722;", plus: "+",
    },
  };

  // ---- the 23 burrow symbol crops, generated ---------------------------------------------------
  const BURROW_SYMBOL_COUNT = 23;
  const BURROW_SYMBOL_COLS = 12;
  const BURROW_SYMBOL_CELL = 32;
  for (let i = 0; i < BURROW_SYMBOL_COUNT; i++) {
    TOKENS.spriteCrops[`burrowSymbol${i}`] = {
      sprite: "CUSTOM_SYMBOL",
      x: (i % BURROW_SYMBOL_COLS) * BURROW_SYMBOL_CELL,
      y: Math.floor(i / BURROW_SYMBOL_COLS) * BURROW_SYMBOL_CELL,
      w: BURROW_SYMBOL_CELL,
      h: BURROW_SYMBOL_CELL,
      // The sheet is already alpha-cut; no colour-keying (an empty list skips the getImageData pass).
      transparent: [],
    };
  }

  // Spelling 75 keys by hand is how a typo becomes an invisible hole, so these are derived
  // mechanically from DF's naming and re-verified name-by-name by dwfui_boot_test on every build.
  const cap = word => word.charAt(0) + word.slice(1).toLowerCase();
  const SQUAD_EQUIP_SLOTS = ["WEAPON", "ARMOR", "HELMET", "PANTS", "SHOES", "GLOVES", "SHIELD",
    "AMMO", "QUIVER", "BACKPACK", "FLASK"];
  const SQUAD_EQUIP_STATES = ["GOOD", "WARNING", "MISSING"];
  const NOBLE_ROOMS = ["OFFICE", "BEDROOM", "DINING", "TOMB", "FURN"];
  const NOBLE_ROOM_STATES = ["GOOD", "PARTIAL", "MISSING", "NA"];
  const NOBLE_CLOCKS = ["MANDATES", "DEMANDS"];
  const NOBLE_CLOCK_STATES = ["TIME_GOOD", "TIME_WARN_1", "TIME_WARN_2", "TIME_WARN_3", "NA"];
  const SQUADS_EQUIPMENT_SPRITES = [];
  const NOBLES_SPRITES = [];
  for (const slot of SQUAD_EQUIP_SLOTS) {
    for (const state of SQUAD_EQUIP_STATES) {
      const token = `SQUADS_EQUIPMENT_${slot}_${state}`;
      TOKENS.sprites[`squadsEquip${cap(slot)}${cap(state)}`] = token;
      SQUADS_EQUIPMENT_SPRITES.push(token);
    }
  }
  for (const room of NOBLE_ROOMS) {
    for (const state of NOBLE_ROOM_STATES) {
      const token = `NOBLES_${room}_${state}`;
      TOKENS.sprites[`nobles${cap(room)}${state === "NA" ? "Na" : cap(state)}`] = token;
      NOBLES_SPRITES.push(token);
    }
  }
  for (const clock of NOBLE_CLOCKS) {
    for (const state of NOBLE_CLOCK_STATES) {
      const token = `NOBLES_${clock}_${state}`;
      const suffix = state === "NA" ? "Na" : state.split("_").map(cap).join("");
      TOKENS.sprites[`nobles${cap(clock)}${suffix}`] = token;
      NOBLES_SPRITES.push(token);
    }
  }
  for (const step of [1, 2, 3, 4, 5]) {
    for (const state of ["ACTIVE", "INACTIVE"]) {
      const token = `NOBLES_ACCOUNTING_${step}_${state}`;
      TOKENS.sprites[`noblesAccounting${step}${cap(state)}`] = token;
      NOBLES_SPRITES.push(token);
    }
  }
  TOKENS.sprites.noblesAdd = "NOBLES_ADD";
  TOKENS.sprites.noblesCrown = "NOBLES_ASSIGN_SYMBOL";
  NOBLES_SPRITES.push("NOBLES_ADD", "NOBLES_ASSIGN_SYMBOL");

  // Explicit allowlist of COMPLETE native control cells. TOKENS.sprites is intentionally NOT used
  // wholesale: it also holds composition slices, plaque source art and glyph-like mood faces.
  const SELF_FRAMED_SPRITES = new Set([
    TOKENS.sprites.quill, TOKENS.sprites.removeBuilding, TOKENS.sprites.assignWorker,
    TOKENS.sprites.cameraOn, TOKENS.sprites.cameraOff, TOKENS.sprites.viewReports,
    // the alert box's open-log cell carries DF's own gold frame (sheet cell 0,0) --
    // a generic button box around it would be the double-frame defect.
    TOKENS.sprites.openAnnouncements,
    TOKENS.sprites.expel, TOKENS.sprites.settings, TOKENS.sprites.back, TOKENS.sprites.close,
    TOKENS.sprites.filter, TOKENS.sprites.filterName,
    TOKENS.sprites.view, TOKENS.sprites.inspect, TOKENS.sprites.forbid, TOKENS.sprites.forbidOn,
    TOKENS.sprites.dump, TOKENS.sprites.dumpOn, TOKENS.sprites.hide, TOKENS.sprites.hideOn,
    TOKENS.sprites.melt, TOKENS.sprites.meltOn, TOKENS.sprites.recenter, TOKENS.sprites.recenterStocks,
    TOKENS.sprites.recenterLocations, TOKENS.sprites.recenterSurface,
    TOKENS.sprites.recenterDeepest, TOKENS.sprites.recenterSet, TOKENS.sprites.recenterClear,
    TOKENS.sprites.liquidNumbersOff, TOKENS.sprites.liquidNumbersOn,
    TOKENS.sprites.rampArrowsOff, TOKENS.sprites.rampArrowsOn,
    TOKENS.sprites.zoomInOff, TOKENS.sprites.zoomInOn,
    TOKENS.sprites.zoomOutOff, TOKENS.sprites.zoomOutOn,
    TOKENS.sprites.suspend, TOKENS.sprites.suspendOn, TOKENS.sprites.repeat, TOKENS.sprites.repeatOn,
    TOKENS.sprites.cancelJob, TOKENS.sprites.jobRemoveWorker,
    TOKENS.sprites.workerAny, TOKENS.sprites.workerOnly,
    TOKENS.sprites.jobActive, TOKENS.sprites.jobDoNow, TOKENS.sprites.jobDoNowOn,
    TOKENS.sprites.jobPriorityUp, TOKENS.sprites.jobQuota,
    TOKENS.sprites.spRepaint, TOKENS.sprites.spRemove, TOKENS.sprites.spTakeAnywhere,
    TOKENS.sprites.spTakeLinksOnly, TOKENS.sprites.spConnections, TOKENS.sprites.spToolSettings,
    TOKENS.sprites.spTypeOn, TOKENS.sprites.spTypeOff,
    TOKENS.sprites.wsLinkArmGive, TOKENS.sprites.wsLinkArmTake,
    TOKENS.sprites.wsLinkGive, TOKENS.sprites.wsLinkTake,
    // Each siege action tile carries DF's own gold frame, and the selected one is that frame filled
    // green -- so a generic border would double-frame it and add a second selection mark.
    TOKENS.sprites.siegeFireAtWill, TOKENS.sprites.siegeFireAtWillOn,
    TOKENS.sprites.siegePracticeFire, TOKENS.sprites.siegePracticeFireOn,
    TOKENS.sprites.siegePrepareToFire, TOKENS.sprites.siegePrepareToFireOn,
    TOKENS.sprites.siegeKeepLoaded, TOKENS.sprites.siegeKeepLoadedOn,
    TOKENS.sprites.siegeNotInUse, TOKENS.sprites.siegeNotInUseOn,
    TOKENS.sprites.stepHash, TOKENS.sprites.stepPlus, TOKENS.sprites.stepMinus,
    TOKENS.sprites.priorityUp, TOKENS.sprites.priorityDown,
    TOKENS.sprites.sortAsc, TOKENS.sprites.sortAscOff, TOKENS.sprites.sortDesc,
    TOKENS.sprites.sortDescOff,
    // Every one of these is a complete control cell: omitting one makes artBtnHtml draw a SECOND
    // border around a sprite that already carries its own.
    TOKENS.sprites.squadsKill, TOKENS.sprites.squadsMove, TOKENS.sprites.squadsPatrol,
    TOKENS.sprites.squadsDefendBurrow, TOKENS.sprites.squadsTrain, TOKENS.sprites.squadsCancelOrder,
    TOKENS.sprites.squadsChangeAlert, TOKENS.sprites.squadsPositions, TOKENS.sprites.squadsDisband,
    TOKENS.sprites.squadsRecenter, TOKENS.sprites.checkOn, TOKENS.sprites.checkOff,
    ...SQUADS_EQUIPMENT_SPRITES,
    // the Items-tab assignment indicators (grey frame baked in).
    TOKENS.sprites.invAssignedClothing, TOKENS.sprites.invAssignedTool,
    TOKENS.sprites.invAssignedSquad, TOKENS.sprites.invAssignedSymbol,
    // labor / work-order / nobles tiles.
    TOKENS.sprites.kitchenCookAllowed, TOKENS.sprites.kitchenCookRestricted, TOKENS.sprites.kitchenCookCannot,
    TOKENS.sprites.kitchenBrewAllowed, TOKENS.sprites.kitchenBrewRestricted, TOKENS.sprites.kitchenBrewCannot,
    TOKENS.sprites.stoneAllowed, TOKENS.sprites.stoneRestricted,
    TOKENS.sprites.magmaSafe, TOKENS.sprites.magmaUnsafe,
    TOKENS.sprites.laborAssigned, TOKENS.sprites.laborUnassigned,
    TOKENS.sprites.laborEverybody, TOKENS.sprites.laborNobody,
    TOKENS.sprites.editWorkDetail, TOKENS.sprites.selectAll,
    TOKENS.sprites.tradeSelected, TOKENS.sprites.tradeNotSelected, TOKENS.sprites.tradeInDepot,
    TOKENS.sprites.tradeBeingBrought, TOKENS.sprites.tradeProhibited,
    TOKENS.sprites.tradeSortDistanceOn, TOKENS.sprites.tradeSortDistanceOff,
    TOKENS.sprites.tradeSortValueOn, TOKENS.sprites.tradeSortValueOff,
    TOKENS.sprites.tradeCullMandatesOn, TOKENS.sprites.tradeCullMandatesOff,
    // The kitchen mass-toggle faces are complete cells carrying their own gold frame; omitting them
    // here would double-frame them.
    TOKENS.sprites.contractList, TOKENS.sprites.expandList,
    TOKENS.sprites.woWaiting, TOKENS.sprites.woChecking, TOKENS.sprites.woValidated,
    TOKENS.sprites.woNotValidated, TOKENS.sprites.woActive, TOKENS.sprites.woReady,
    TOKENS.sprites.woConditions, TOKENS.sprites.woCreateNew, TOKENS.sprites.woRemove,
    TOKENS.sprites.woDetails,
    TOKENS.sprites.zoneRepaint, TOKENS.sprites.zoneRemove,
    TOKENS.sprites.zoneSuspend, TOKENS.sprites.zoneSuspendOn,
    TOKENS.sprites.zonePickAnimals, TOKENS.sprites.zoneAssignUnit,
    TOKENS.sprites.zoneLocationAssign, TOKENS.sprites.zoneLocationDetails,
    TOKENS.sprites.zoneQuill, TOKENS.sprites.zoneSquadList, TOKENS.sprites.unitSelPasture,
    "ZONE_GATHER_TREE_ACTIVE", "ZONE_GATHER_TREE_INACTIVE",
    "ZONE_GATHER_SHRUB_ACTIVE", "ZONE_GATHER_SHRUB_INACTIVE",
    "ZONE_GATHER_FALLEN_ACTIVE", "ZONE_GATHER_FALLEN_INACTIVE",
    "ZONE_POND_ACTIVE", "ZONE_POND_INACTIVE", "ZONE_PIT_ACTIVE", "ZONE_PIT_INACTIVE",
    "ZONE_TOMB_CITIZEN_BURIAL_ACTIVE", "ZONE_TOMB_CITIZEN_BURIAL_INACTIVE",
    "ZONE_TOMB_PET_BURIAL_ACTIVE", "ZONE_TOMB_PET_BURIAL_INACTIVE",
    "ZONE_SHOOT_LEFT_ACTIVE", "ZONE_SHOOT_LEFT_INACTIVE",
    "ZONE_SHOOT_RIGHT_ACTIVE", "ZONE_SHOOT_RIGHT_INACTIVE",
    "ZONE_SHOOT_UP_ACTIVE", "ZONE_SHOOT_UP_INACTIVE",
    "ZONE_SHOOT_DOWN_ACTIVE", "ZONE_SHOOT_DOWN_INACTIVE",
    "ZONE_PREVIOUS", "ZONE_NEXT",
    // Complete state cells: their fill, bevel and selected paint live in the sprite, so latchHtml
    // must not add a second chassis.
    "PETS_LIVESTOCK_SLAUGHTER_ACTIVE", "PETS_LIVESTOCK_SLAUGHTER_INACTIVE",
    "PETS_LIVESTOCK_GELD_ACTIVE", "PETS_LIVESTOCK_GELD_INACTIVE",
    "PETS_LIVESTOCK_HUNT_TRAINING_ACTIVE", "PETS_LIVESTOCK_HUNT_TRAINING_INACTIVE",
    "PETS_LIVESTOCK_WAR_TRAINING_ACTIVE", "PETS_LIVESTOCK_WAR_TRAINING_INACTIVE",
    "PETS_LIVESTOCK_AVAILABLE_AS_PET", "PETS_LIVESTOCK_UNAVAILABLE_AS_PET",
    "PETS_LIVESTOCK_ASSIGN_TRAINER",
    "BUTTON_DES_BLUEPRINT_ACTIVE", "BUTTON_DES_BLUEPRINT_INACTIVE",
    // Complete 32x36 native cells: selected/unselected changes the CELL, not surrounding chrome.
    "LOCATION_PERMISSION_ON_VISITORS", "LOCATION_PERMISSION_OFF_VISITORS",
    "LOCATION_PERMISSION_ON_RESIDENTS", "LOCATION_PERMISSION_OFF_RESIDENTS",
    "LOCATION_PERMISSION_ON_CITIZENS", "LOCATION_PERMISSION_OFF_CITIZENS",
    "LOCATION_PERMISSION_ON_MEMBERS", "LOCATION_PERMISSION_OFF_MEMBERS",
    ...NOBLES_SPRITES,
    ...Object.values(TOKENS.frames),
  ]);
  function isSelfFramedSprite(token) {
    return !!token && SELF_FRAMED_SPRITES.has(token);
  }

  // ---- workDetailSprite: work_detail.icon -> a real interface token, or nothing ----------------
  const WORK_DETAIL_ICON_TOKENS = new Set(Object.values(TOKENS.sprites)
    .filter(v => typeof v === "string" && v.startsWith("WORK_DETAIL_")));
  function workDetailSprite(iconKey) {
    const key = String(iconKey == null ? "" : iconKey).trim().toUpperCase();
    if (!key || key === "NONE" || key === "WORK_DETAIL_NONE") return null;
    const token = key.startsWith("WORK_DETAIL_") ? key : `WORK_DETAIL_${key}`;
    return WORK_DETAIL_ICON_TOKENS.has(token) ? token : null;
  }
  // One native cell on the interface knob's grid, for every surface that draws one. Empty means DF
  // ships no icon for this detail: the caller owns the hole, never a smaller copy of the art.
  function workDetailIconHtml(iconKey, cfg) {
    const sprite = workDetailSprite(iconKey);
    return sprite ? iconHtml({ ...(cfg || {}), sprite, size: 32 }) : "";
  }

  // stockpileIconCrop: a stockpile_icons.png ROW -> a whole-cell crop. Row i is cy 32*i on the
  // plated and the SIGNLESS sheet alike; crops, because a scaled 40px plate overflows its box.
  const STOCKPILE_ICON_ROWS = ["BLANK", "AMMO", "ANIMALS", "ARMOR", "BARS", "CLOTH", "COINS",
    "CORPSES", "FINISHED_GOODS", "FOOD", "FURNITURE", "GEMS", "LEATHER", "REFUSE", "SHEETS",
    "STONE", "WEAPONS", "WOOD", "CUSTOM", "ALL"];
  STOCKPILE_ICON_ROWS.forEach((name, row) => {
    TOKENS.spriteCrops[`spIconRow${row}`] =
      { sprite: `STOCKPILE_ICON_${name}`, x: 0, y: 0, w: 32, h: 32, transparent: [] };
    TOKENS.spriteCrops[`spIconSignlessRow${row}`] =
      { sprite: `STOCKPILE_ICON_SIGNLESS_${name}`, x: 0, y: 0, w: 32, h: 32, transparent: [] };
  });
  function stockpileIconCrop(row, opts) {
    const i = Number(row);
    if (!STOCKPILE_ICON_ROWS[i]) return null;
    return `${opts && opts.signless ? "spIconSignlessRow" : "spIconRow"}${i}`;
  }

  // ---- zoneSprite: a civzone type key -> its real interface token, or nothing -------------------
  function zoneSprite(typeKey) {
    const key = String(typeKey == null ? "" : typeKey).trim();
    return typeof TOKENS.zones[key] === "string" ? TOKENS.zones[key] : null;
  }

  // ---- TriStateMark: the hierarchical list derive ----------------------------------------------
  function triStateFor(on, total) {
    if (!(Number(total) > 0)) return null;
    if (Number(on) <= 0) return "none";
    return Number(on) >= Number(total) ? "all" : "some";
  }
  function triStateFromAgg(agg) {
    if (!agg) return null;
    return triStateFor(agg.on, agg.total);
  }
  const TRI_MARK_CLASS = { all: "check", some: "dash", none: "x" };
  const TRI_MARK_CROP = { all: "markCheck", some: "markDash", none: "markX" };
  // Renders the native check / grey dash / red X mark, cropped out of DF's own three stockpile state
  // cells. null state renders nothing (loading), matching the editor's plain-green loading row.
  function triMarkHtml(state, opts) {
    const kind = TRI_MARK_CLASS[state];
    if (!kind) return "";
    const o = opts || {};
    return iconHtml({
      spriteCrop: TRI_MARK_CROP[state], cls: `${withBaseClass("dwfui-mark", o.cls)} ${kind}`,
      dataset: o.dataset, title: o.title, cssSized: o.cssSized,
    });
  }

  // Resolution order: sprite -> item -> art -> letter -> empty tile. An unresolved item FAILS LOUD
  // and NEVER degrades to a letter; `item` plus `letter` THROWS. Inert until paintSprites() runs.
  const ITEM_CELL = 32;                 // the item sheets are a 32px grid (dwf-tiles.js)
  function itemRefKey(ref) {
    if (!ref || typeof ref !== "object" || typeof ref.itemType !== "string" || !ref.itemType) return null;
    const part = value => (value == null || value === "" ? "" : String(value));
    return [ref.itemType, part(ref.itemSubtype), part(ref.materialType), part(ref.materialIndex),
      part(ref.identKind), part(ref.ident), part(ref.itemToken)]
      .join(":").replace(/:+$/, "");
  }
  function iconHtml(cfg) {
    const c = cfg || {};
    // PRESENCE, not truthiness: `iconHtml({item: undefinedRef})` MUST take the item path and fail
    // loud. Reading it as "no item channel requested" is how a missing ref silently became a letter.
    const hasItem = Object.prototype.hasOwnProperty.call(c, "item");
    if (hasItem && c.letter != null && String(c.letter) !== "")
      throw new Error("DWFUI.iconHtml: `item` and `letter` are mutually exclusive. An unresolved " +
        "item sprite must FAIL LOUD (data-df-identity-missing + the native empty tile); the letter " +
        "path is the BLOCKER this channel exists to retire, not its fallback.");
    const size = Number(c.size) > 0 ? Math.round(Number(c.size)) : 32;
    const classes = ["dwfui-icon"];
    const spriteCrop = c.spriteCrop && TOKENS.spriteCrops[c.spriteCrop];
    // A complete control's own canvas defines the rectangle: forcing it into the square icon box
    // clips it and then tempts its parent to draw a second button around it.
    const selfFramed = c.nativeCell === true || (c.nativeCell !== false && isSelfFramedSprite(c.sprite));
    if (selfFramed) classes.push("dwfui-icon--native-cell");
    const attrs = () => `${datasetAttrs(c.dataset)}${c.title ? ` title="${esc(c.title)}"` : ""}` +
      (c.alt ? ` role="img" aria-label="${esc(c.alt)}"` : ` aria-hidden="true"`);
    const box = ` style="--dwfui-icon-size:${size}px"`;
    if (spriteCrop) {
      classes.push("dwfui-icon--sprite-crop");
      if (c.cls) classes.push(c.cls);
      return `<span class="${classes.join(" ")}" data-dwfui-sprite="${esc(spriteCrop.sprite)}"` +
        ` data-dwfui-sprite-crop="${esc(c.spriteCrop)}"` +
        `${c.cssSized ? "" : ` style="--dwfui-icon-crop-w:${spriteCrop.w}px;--dwfui-icon-crop-h:${spriteCrop.h}px"`}${attrs()}></span>`;
    }
    if (c.spriteCrop) {
      classes.push("dwfui-icon--empty");
      if (c.cls) classes.push(c.cls);
      return `<span class="${classes.join(" ")}"${box} data-df-identity-missing="sprite-crop:${esc(c.spriteCrop)}"${attrs()}></span>`;
    }
    if (c.sprite) {
      if (c.cls) classes.push(c.cls);
      // The state is stamped ONLY when the family really ships art for it: a `null` in the table keeps
      // the honest CSS dim, and `default` never opts in.
      const family = c.states && TOKENS.states[c.states] ? c.states : null;
      const state = family && c.state && c.state !== "default" && TOKENS.states[family][c.state] ? c.state : null;
      return `<span class="${classes.join(" ")}" data-dwfui-sprite="${esc(c.sprite)}"` +
        `${selfFramed ? ` data-dwfui-self-framed="true"` : ""}` +
        `${family ? ` data-dwfui-sprite-states="${esc(family)}"` : ""}` +
        `${state ? ` data-dwfui-sprite-state="${esc(state)}"` : ""}` +
        ` data-dwfui-sprite-size="${size}"${box}${attrs()}></span>`;
    }
    if (hasItem) {
      const key = itemRefKey(c.item);
      if (c.cls) classes.push(c.cls);
      // A missing or malformed spriteRef is a DATA blocker and is marked HERE, at build time.
      if (!key)
        return `<span class="${classes.join(" ")} dwfui-icon--empty"${box}` +
          ` data-df-identity-missing="item:none"${attrs()}></span>`;
      classes.push("dwfui-icon--item");
      return `<span class="${classes.join(" ")}"${box}` +
        ` data-dwfui-item="${esc(JSON.stringify(c.item))}" data-dwfui-item-key="${esc(key)}"${attrs()}></span>`;
    }
    if (c.art) {
      const art = TOKENS.art[c.art];
      classes.push("dwfui-icon--art");
      if (c.cls) classes.push(c.cls);
      // An unknown art key degrades to the native EMPTY TILE, never to a letter and never a throw.
      if (!art) return `<span class="${classes.join(" ")} dwfui-icon--empty"${box}` +
        ` data-df-identity-missing="art:${esc(c.art)}"${attrs()}></span>`;
      return `<span class="${classes.join(" ")}"${box.slice(0, -1)};background-image:${art}"${attrs()}></span>`;
    }
    if (c.letter != null && String(c.letter) !== "") {
      classes.push("dwfui-icon--letter");
      if (c.cls) classes.push(c.cls);
      return `<span class="${classes.join(" ")}"${box} data-df-identity-missing="letter"${attrs()}>` +
        `${esc(String(c.letter).slice(0, 1).toUpperCase())}</span>`;
    }
    classes.push("dwfui-icon--empty");
    if (c.cls) classes.push(c.cls);
    return `<span class="${classes.join(" ")}"${box}${c.emptyTile ? "" : ` data-df-identity-missing="none"`}${attrs()}></span>`;
  }

  // Builders are string-only by contract, so every DOM pass is a SEPARATE explicit call -- the
  // paint* and mount* families, restoreScroll and restoreSearchCaret. No builder ever invokes one.
  function _auditSprite(node, map) {
    const token = node.getAttribute("data-dwfui-sprite");
    const known = !!(map && map[token]);
    if (known) {
      node.removeAttribute("data-df-identity-missing");
      if (node.classList) node.classList.remove("dwfui-icon--empty");
    } else {
      node.setAttribute("data-df-identity-missing", "sprite:" + token);
      if (node.classList) node.classList.add("dwfui-icon--empty");
    }
    return known;
  }
  const _spriteCropImages = {};
  const _itemSheetImages = {};
  const _imageLoadStates = new WeakMap();
  const SHEET_LOAD_TIMEOUT_MS = 2000;
  const SHEET_RETRY_DELAYS_MS = [125, 500];
  function _sheetImage(name) {
    let img = _spriteCropImages[name];
    if (!img) { img = new root.Image(); img.src = "/asset/" + name; _spriteCropImages[name] = img; }
    return img;
  }
  // The declared escape hatch for genuinely composed markup in a text slot. The required reason is
  // both review context and a static-ratchet marker.
  function rawHtml(reason, html) {
    if (!String(reason || "").trim())
      throw new Error("DWFUI.rawHtml: a plain-English reason is required for bypassing bitmap text");
    return String(html == null ? "" : html);
  }
  function _itemSheetImage(name) {
    let img = _itemSheetImages[name];
    if (!img) {
      img = new root.Image();
      img.src = "/sprites/img/" + encodeURIComponent(name);
      _itemSheetImages[name] = img;
    }
    return img;
  }
  function _retrySheetUrl(url, attempt) {
    const clean = String(url || "")
      .replace(/([?&])dwfui_retry=\d+(&?)/, (_match, lead, tail) => tail ? lead : "");
    return clean + (clean.includes("?") ? "&" : "?") + "dwfui_retry=" + attempt;
  }
  function _clearImageAttempt(state) {
    if (state.timer != null) root.clearTimeout(state.timer);
    state.timer = null;
    if (state.onLoad) state.img.removeEventListener("load", state.onLoad);
    if (state.onError) state.img.removeEventListener("error", state.onError);
    state.onLoad = null;
    state.onError = null;
  }
  function _finishImageLoad(state) {
    if (state.status !== "loading") return;
    _clearImageAttempt(state);
    state.status = "loaded";
    const waiters = state.waiters.splice(0);
    for (const waiter of waiters) {
      try { waiter.draw(state.img); }
      catch (error) { console.error("DWFUI sheet draw failed", state.baseUrl, error); }
    }
  }
  function _breakImageLoad(state, reason) {
    _clearImageAttempt(state);
    state.status = "broken";
    state.reason = reason;
    const waiters = state.waiters.splice(0);
    for (const waiter of waiters) {
      if (!waiter.broken) continue;
      try { waiter.broken(state.img, reason); }
      catch (error) { console.error("DWFUI broken-art marker failed", state.baseUrl, error); }
    }
  }
  function _failImageAttempt(state, reason) {
    if (state.status !== "loading") return;
    _clearImageAttempt(state);
    const delay = SHEET_RETRY_DELAYS_MS[state.attempt];
    if (delay == null) { _breakImageLoad(state, reason); return; }
    state.status = "retry";
    state.retryTimer = root.setTimeout(() => {
      state.retryTimer = null;
      if (state.status !== "retry") return;
      if (state.img.complete && state.img.naturalWidth) {
        state.status = "loading";
        _finishImageLoad(state);
        return;
      }
      state.attempt++;
      _armImageAttempt(state);
      state.img.src = _retrySheetUrl(state.baseUrl, state.attempt);
    }, delay);
  }
  function _armImageAttempt(state) {
    state.status = "loading";
    state.onLoad = () => {
      if (state.img.naturalWidth) _finishImageLoad(state);
      else _failImageAttempt(state, "empty");
    };
    state.onError = () => _failImageAttempt(state, "error");
    state.img.addEventListener("load", state.onLoad);
    state.img.addEventListener("error", state.onError);
    state.timer = root.setTimeout(() => _failImageAttempt(state, "timeout"), SHEET_LOAD_TIMEOUT_MS);
  }
  function _whenLoaded(img, draw, broken, key) {
    if (img.complete && img.naturalWidth) { draw(img); return; }
    let state = _imageLoadStates.get(img);
    let fresh = false;
    if (!state) {
      state = {
        img,
        baseUrl: String(img.currentSrc || img.src || ""),
        attempt: 0,
        status: "idle",
        timer: null,
        retryTimer: null,
        onLoad: null,
        onError: null,
        reason: "",
        waiters: [],
      };
      _imageLoadStates.set(img, state);
      fresh = true;
    }
    if (state.status === "loaded") { draw(img); return; }
    if (state.status === "broken") { if (broken) broken(img, state.reason); return; }
    const prior = key == null ? null : state.waiters.find(waiter => waiter.key === key);
    if (prior) {
      prior.draw = draw;
      prior.broken = broken;
    } else {
      state.waiters.push({ draw, broken, key });
    }
    if (!fresh) return;
    if (img.complete && img.naturalWidth) { state.status = "loading"; _finishImageLoad(state); return; }
    _armImageAttempt(state);
    if (img.complete && !img.naturalWidth) _failImageAttempt(state, "error");
  }
  function _markBrokenArt(canvas, img) {
    if (!canvas || !canvas.setAttribute) return;
    const source = String(img && (img.currentSrc || img.src) || "unknown")
      .replace(/[?#].*$/, "").split("/").pop() || "unknown";
    canvas.setAttribute("data-dwfui-art-broken", source);
    const ctx = canvas.getContext && canvas.getContext("2d");
    const w = Math.max(1, Number(canvas.width) || 1);
    const h = Math.max(1, Number(canvas.height) || 1);
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#1c1c1c";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#ff4f5e";
    ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) / 8));
    ctx.beginPath();
    ctx.moveTo(2, 2);
    ctx.lineTo(Math.max(2, w - 2), Math.max(2, h - 2));
    ctx.moveTo(Math.max(2, w - 2), 2);
    ctx.lineTo(2, Math.max(2, h - 2));
    ctx.stroke();
  }
  function _clearBrokenArt(canvas) {
    if (canvas && canvas.removeAttribute) canvas.removeAttribute("data-dwfui-art-broken");
  }
  // boxPx == 0 means a COMPLETE native cell: its record IS the rectangle, drawn at rec.w x rec.h
  // times the interface scale. boxPx > 0 is glyph art in a caller's box, and NATIVE IS THE FLOOR.
  function _paintSpriteScaled(canvas, rec, boxPx, doc) {
    if (!canvas || !rec || !rec.w || !rec.h || !root || !root.Image) return;
    const d = doc || canvas.ownerDocument || (typeof document !== "undefined" ? document : null);
    const iface = interfaceScale(d), zoom = uiZoom(d);
    const fit = boxPx > 0 ? Math.max(1, boxPx / Math.max(rec.w, rec.h)) : 1;
    const cssW = rec.w * fit * iface, cssH = rec.h * fit * iface;
    const w = Math.max(1, Math.round(cssW * zoom)), h = Math.max(1, Math.round(cssH * zoom));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (canvas.style) {
      canvas.style.width = zoom === 1 ? "" : `${cssW}px`;
      canvas.style.height = zoom === 1 ? "" : `${cssH}px`;
    }
    const ctx = canvas.getContext("2d");
    const img = _sheetImage(rec.img);
    _whenLoaded(img, () => {
      _clearBrokenArt(canvas);
      ctx.clearRect(0, 0, w, h);
      _bakeBlit(ctx, img, rec.cx, rec.cy, rec.w, rec.h, 0, 0, w, h);
    }, () => _markBrokenArt(canvas, img), canvas);
  }
  function _paintSpriteCrop(canvas, crop, token, chrome) {
    const apply = map => {
      const rec = map && map[token];
      if (!rec || !root || !root.Image) return;
      canvas.width = crop.w;
      canvas.height = crop.h;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      const img = _sheetImage(rec.img);
      const draw = () => {
        _clearBrokenArt(canvas);
        ctx.clearRect(0, 0, crop.w, crop.h);
        ctx.drawImage(img, rec.cx + crop.x, rec.cy + crop.y, crop.w, crop.h,
          0, 0, crop.w, crop.h);
        const keyed = new Set(crop.transparent || []);
        if (!keyed.size) return;
        const pixels = ctx.getImageData(0, 0, crop.w, crop.h);
        for (let i = 0; i < pixels.data.length; i += 4) {
          if (keyed.has(`${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]}`))
            pixels.data[i + 3] = 0;
        }
        ctx.putImageData(pixels, 0, 0);
      };
      _whenLoaded(img, draw, () => _markBrokenArt(canvas, img), canvas);
    };
    const loaded = chrome.getCell && chrome.getCell(token);
    if (loaded) apply({ [token]: loaded });
    else if (chrome.loadMap) Promise.resolve(chrome.loadMap()).then(apply)
      .catch(error => DwfErr.report("dwfui.state-art-map", error));
  }
  // A `null` entry means DF ships NOTHING for that state: fall back to `base` and never invent paint.
  // This is the whole state swap -- DF replaces the sprite, it does not dim it.
  function _stateToken(node, token) {
    const family = TOKENS.states[node.getAttribute("data-dwfui-sprite-states")];
    if (!family) return token;
    const state = node.getAttribute("data-dwfui-sprite-state") || "base";
    return family[state] || family.base || token;
  }
  function _frameStateToken(family, state) {
    const table = family && family.states;
    if (!table) return null;
    return table[state] || table.default || null;
  }
  function _frameState(c) {
    if (c && c.state && TOKENS.frames[c.state]) return c.state;
    if (c && c.selected && c.current) return "selectedActive";
    if (c && c.current) return "active";
    if (c && c.selected) return "selected";
    if (c && c.disabled) return "disabled";
    return "default";
  }

  function nativeFrameHtml(familyName, cfg) {
    const c = cfg || {};
    if (typeof familyName !== "string" || !TOKENS.frameFamilies[familyName])
      throw new Error(`DWFUI.nativeFrameHtml: unknown frame family ${JSON.stringify(familyName)}`);
    const classes = ["dwfui-native-frame-art"];
    if (c.cls) classes.push(c.cls);
    return `<canvas class="${classes.join(" ")}" data-dwfui-native-frame="${esc(familyName)}"` +
      ` data-dwfui-frame-auto-size="true" data-dwfui-frame-state="${esc(c.state || "default")}"` +
      ` data-dwfui-frame-share-left="${c.shareLeft ? "true" : "false"}"` +
      ` data-dwfui-frame-share-top="${c.shareTop ? "true" : "false"}" aria-hidden="true"></canvas>`;
  }

  // PARTIAL native chrome, stamped cell by cell. Cells the runs do not name stay TRANSPARENT. Use
  // this only where a decode says native stamps cells; a whole window still takes nativeFrameHtml.
  const CELL_RUN_AXES = { x: "x", y: "y" };
  // The PAINTER re-runs this over whatever is on the canvas, because controllers may write
  // data-dwfui-cell-runs directly and skip the builder entirely.
  function _normalizeCellRun(run) {
    const grid = Array.isArray(run.grid) ? run.grid : [1, 1];
    const cell = Array.isArray(run.cell) ? run.cell : [0, 0];
    return {
      token: run.token,
      grid: [Math.max(1, Math.round(grid[0] || 1)), Math.max(1, Math.round(grid[1] || 1))],
      cell: [Math.max(0, Math.round(cell[0] || 0)), Math.max(0, Math.round(cell[1] || 0))],
      col: Math.max(0, Math.round(run.col || 0)),
      row: Math.max(0, Math.round(run.row || 0)),
      repeat: Math.max(1, Math.round(run.repeat || 1)),
      axis: CELL_RUN_AXES[run.axis] || "y",
    };
  }
  function nativeCellRunsHtml(cfg) {
    const c = cfg || {};
    const cols = Math.round(Number(c.cols));
    const rows = Math.round(Number(c.rows));
    if (!(cols > 0) || !(rows > 0))
      throw new Error("DWFUI.nativeCellRunsHtml: cols and rows are the canvas's size in native " +
        "cells and must both be positive");
    const runs = (Array.isArray(c.runs) ? c.runs : []).map(run => {
      if (!run || typeof run.token !== "string" || !run.token)
        throw new Error("DWFUI.nativeCellRunsHtml: every run needs an interface_map token");
      return _normalizeCellRun(run);
    });
    if (!runs.length)
      throw new Error("DWFUI.nativeCellRunsHtml: a canvas with no runs paints nothing");
    const classes = ["dwfui-native-cell-runs"];
    if (c.cls) classes.push(c.cls);
    return `<canvas class="${classes.join(" ")}"${c.id ? ` id="${esc(c.id)}"` : ""}` +
      datasetAttrs(c.dataset) +
      ` data-dwfui-cell-runs="${esc(JSON.stringify({ cols, rows, runs }))}" aria-hidden="true"></canvas>`;
  }

  function _paintNativeCellRuns(canvas, map, doc) {
    let spec = null;
    try { spec = JSON.parse(canvas.getAttribute("data-dwfui-cell-runs") || "null"); } catch { spec = null; }
    if (!spec || !Array.isArray(spec.runs) || !root || !root.Image) return false;
    // Validate up front and fail PER RUN: one malformed run used to throw inside draw() and take the
    // entire canvas down with it. A bad run now costs one cell and the rest still paints.
    const runs = [];
    for (const raw of spec.runs) {
      if (!raw || typeof raw.token !== "string" || !raw.token) {
        console.error("DWFUI cell runs: skipping a run with no interface_map token", raw);
        continue;
      }
      runs.push(_normalizeCellRun(raw));
    }
    spec = { cols: spec.cols, rows: spec.rows, runs };
    const d = doc || canvas.ownerDocument || (typeof document !== "undefined" ? document : null);
    const iface = interfaceScale(d), zoom = uiZoom(d);
    const cellW = TOKENS.font.cell.w * iface, cellH = TOKENS.font.cell.h * iface;
    const cssW = spec.cols * cellW, cssH = spec.rows * cellH;
    const w = Math.max(1, Math.round(cssW * zoom)), h = Math.max(1, Math.round(cssH * zoom));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (canvas.style) { canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`; }
    const ctx = canvas.getContext("2d");
    const missing = [];
    const images = new Map();
    for (const run of spec.runs) {
      const rec = map && map[run.token];
      if (!rec) { if (missing.indexOf(run.token) === -1) missing.push(run.token); continue; }
      if (!images.has(rec.img)) images.set(rec.img, _sheetImage(rec.img));
    }
    if (missing.length) canvas.setAttribute("data-df-identity-missing", "sprite:" + missing.join(","));
    else canvas.removeAttribute("data-df-identity-missing");
    const draw = () => {
      if ([...images.values()].some(img => !img.complete || !img.naturalWidth)) return;
      _clearBrokenArt(canvas);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      for (const run of spec.runs) {
        const rec = map && map[run.token];
        if (!rec) continue;
        const sw = rec.w / run.grid[0], sh = rec.h / run.grid[1];
        const sx = rec.cx + run.cell[0] * sw, sy = rec.cy + run.cell[1] * sh;
        // A sub-cell's footprint in native cells is the step between repeats.
        const stepX = run.axis === "x" ? sw / TOKENS.font.cell.w : 0;
        const stepY = run.axis === "y" ? sh / TOKENS.font.cell.h : 0;
        for (let i = 0; i < run.repeat; i++) {
          const x0 = Math.round((run.col + i * stepX) * cellW * zoom);
          const y0 = Math.round((run.row + i * stepY) * cellH * zoom);
          const x1 = Math.round((run.col + i * stepX) * cellW * zoom + sw * iface * zoom);
          const y1 = Math.round((run.row + i * stepY) * cellH * zoom + sh * iface * zoom);
          if (x1 <= x0 || y1 <= y0) continue;
          ctx.drawImage(images.get(rec.img), sx, sy, sw, sh, x0, y0, x1 - x0, y1 - y0);
        }
      }
    };
    for (const img of images.values()) {
      _whenLoaded(img, draw, () => _markBrokenArt(canvas, img), canvas);
    }
    draw();
    return true;
  }

  function _renderedFrameSize(canvas, doc) {
    const d = doc || canvas.ownerDocument || (typeof document !== "undefined" ? document : null);
    const owner = canvas.parentElement;
    const zoom = uiZoom(d);
    const rect = owner && owner.getBoundingClientRect ? owner.getBoundingClientRect() : null;
    // clientWidth/Height are the unzoomed layout box; the rect fallback is for hosts with no client
    // metrics, and getBoundingClientRect includes CSS zoom.
    const cssW = Number(owner && owner.clientWidth) || Number(rect && rect.width) / zoom || 0;
    const cssH = Number(owner && owner.clientHeight) || Number(rect && rect.height) / zoom || 0;
    return { d, cssW, cssH, zoom, iface: interfaceScale(d) };
  }
  function _autoFrameGrid(canvas, family, doc) {
    const size = _renderedFrameSize(canvas, doc);
    if (!(size.cssW > 0 && size.cssH > 0)) return null;
    const artScale = family.scaleWithInterface === false ? 1 : size.iface;
    // The painter source-crops only the final partial repeat; it never stretches every tile.
    const cols = Math.max(family.minCols || 2,
      Math.ceil(size.cssW / (TOKENS.font.cell.w * artScale)));
    const rows = Math.max(family.minRows || 2,
      Math.ceil(size.cssH / (TOKENS.font.cell.h * artScale)));
    if (canvas.getAttribute("data-dwfui-frame-cols") !== String(cols))
      canvas.setAttribute("data-dwfui-frame-cols", String(cols));
    if (canvas.getAttribute("data-dwfui-frame-rows") !== String(rows))
      canvas.setAttribute("data-dwfui-frame-rows", String(rows));
    return { ...size, cols, rows, artScale, auto: true };
  }
  function _frameCanvasSize(canvas, cols, rows, doc, renderedSize) {
    const d = doc || canvas.ownerDocument || (typeof document !== "undefined" ? document : null);
    const iface = interfaceScale(d), zoom = uiZoom(d);
    const cssW = Math.max(1, renderedSize ? renderedSize.cssW : cols * TOKENS.font.cell.w * iface);
    const cssH = Math.max(1, renderedSize ? renderedSize.cssH : rows * TOKENS.font.cell.h * iface);
    const w = Math.max(1, Math.round(cssW * zoom));
    const h = Math.max(1, Math.round(cssH * zoom));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (canvas.style && !renderedSize) {
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    return { d, iface, zoom, cssW, cssH, w, h, auto: !!renderedSize };
  }

  function _paintTable3x3Frame(canvas, rec, cols, rows, shareLeft, shareTop, doc, renderedSize) {
    if (!rec || !root || !root.Image) return false;
    const size = _frameCanvasSize(canvas, cols, rows, doc, renderedSize);
    const ctx = canvas.getContext("2d");
    const img = _sheetImage(rec.img);
    _whenLoaded(img, () => {
      _clearBrokenArt(canvas);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, size.w, size.h);
      const sw = rec.w / 3, sh = rec.h / 3;
      // Responsive hosts may end on a fractional pixel, so crop only the FINAL destination cell;
      // never stretch every cell to absorb the remainder.
      const artScale = renderedSize ? renderedSize.artScale : size.iface;
      const dw = size.auto ? sw * artScale * size.zoom : size.w / cols;
      const dh = size.auto ? sh * artScale * size.zoom : size.h / rows;
      for (let col = 0; col < cols; col++) {
        const sx = col === 0 ? 0 : (col === cols - 1 ? 2 : 1);
        for (let row = 0; row < rows; row++) {
          if ((shareLeft && col === 0) || (shareTop && row === 0)) continue;
          const sy = row === 0 ? 0 : (row === rows - 1 ? 2 : 1);
          const x0 = Math.round(col * dw), y0 = Math.round(row * dh);
          const x1 = Math.min(size.w, Math.round((col + 1) * dw));
          const y1 = Math.min(size.h, Math.round((row + 1) * dh));
          if (x1 <= x0 || y1 <= y0) continue;
          ctx.drawImage(img, rec.cx + sx * sw, rec.cy + sy * sh, sw, sh,
            x0, y0, x1 - x0, y1 - y0);
        }
      }
    }, () => _markBrokenArt(canvas, img), canvas);
    return true;
  }

  function _paintPieceFrame(canvas, family, map, cols, rows, shareLeft, shareTop, doc, renderedSize) {
    const tokens = family.tokens || {};
    const recs = Object.fromEntries(Object.entries(tokens).map(([role, token]) => [role, map[token]]));
    if (Object.values(recs).some(rec => !rec) || !root || !root.Image) return false;
    const size = _frameCanvasSize(canvas, cols, rows, doc, renderedSize);
    const ctx = canvas.getContext("2d");
    const images = new Map();
    Object.values(recs).forEach(rec => {
      if (!images.has(rec.img)) images.set(rec.img, _sheetImage(rec.img));
    });
    const draw = () => {
      if ([...images.values()].some(img => !img.complete || !img.naturalWidth)) return;
      _clearBrokenArt(canvas);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, size.w, size.h);
      // Fixed glyph boxes occupy an exact declared grid; responsive windows instead preserve the
      // pieces' aspect ratio at the live interface scale, changing only the repetition count.
      const scaleX = size.auto ? size.iface * size.zoom
        : size.w / (cols * TOKENS.font.cell.w);
      const scaleY = size.auto ? size.iface * size.zoom
        : size.h / (rows * TOKENS.font.cell.h);
      const drawRec = (rec, dx, dy, dw, dh, sw = rec.w, sh = rec.h) =>
        ctx.drawImage(images.get(rec.img), rec.cx, rec.cy, sw, sh,
          Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh));
      const tileX = (rec, x0, x1, y, h) => {
        const step = rec.w * scaleX;
        for (let x = x0; x < x1 - 0.01; x += step) {
          const span = Math.min(step, x1 - x);
          drawRec(rec, x, y, span, h, rec.w * span / step, rec.h);
        }
      };
      const tileY = (rec, y0, y1, x, w) => {
        const step = rec.h * scaleY;
        for (let y = y0; y < y1 - 0.01; y += step) {
          const span = Math.min(step, y1 - y);
          drawRec(rec, x, y, w, span, rec.w, rec.h * span / step);
        }
      };
      const tl = recs.topLeft, tr = recs.topRight, bl = recs.bottomLeft, br = recs.bottomRight;
      const leftW = tl.w * scaleX, rightW = tr.w * scaleX;
      const topH = tl.h * scaleY, bottomH = bl.h * scaleY;
      const topX = shareLeft ? 0 : leftW, bottomX = shareLeft ? 0 : bl.w * scaleX;
      const sideY = shareTop ? 0 : topH;
      if (!shareLeft) {
        if (!shareTop) drawRec(tl, 0, 0, leftW, topH);
        drawRec(bl, 0, size.h - bottomH, bl.w * scaleX, bottomH);
        tileY(recs.left, sideY, size.h - bottomH, 0, recs.left.w * scaleX);
      }
      if (!shareTop) {
        drawRec(tr, size.w - rightW, 0, rightW, tr.h * scaleY);
        tileX(recs.top, topX, size.w - rightW, 0, recs.top.h * scaleY);
      }
      drawRec(br, size.w - br.w * scaleX, size.h - br.h * scaleY,
        br.w * scaleX, br.h * scaleY);
      tileX(recs.bottom, bottomX, size.w - br.w * scaleX,
        size.h - recs.bottom.h * scaleY, recs.bottom.h * scaleY);
      tileY(recs.right, sideY, size.h - br.h * scaleY,
        size.w - recs.right.w * scaleX, recs.right.w * scaleX);
    };
    for (const img of images.values()) {
      _whenLoaded(img, draw, () => _markBrokenArt(canvas, img), canvas);
    }
    draw();
    return true;
  }

  function _paintNativeFrame(canvas, map, doc) {
    const family = TOKENS.frameFamilies[canvas.getAttribute("data-dwfui-native-frame")];
    if (!family || !map) return false;
    const auto = canvas.getAttribute("data-dwfui-frame-auto-size") === "true";
    const rendered = auto ? _autoFrameGrid(canvas, family, doc) : null;
    if (auto && !rendered) return false;
    const cols = rendered ? rendered.cols : Number(canvas.getAttribute("data-dwfui-frame-cols")) || 0;
    const rows = rendered ? rendered.rows : Number(canvas.getAttribute("data-dwfui-frame-rows")) || 0;
    const shareLeft = canvas.getAttribute("data-dwfui-frame-share-left") === "true";
    const shareTop = canvas.getAttribute("data-dwfui-frame-share-top") === "true";
    if (family.kind === "table3x3") {
      const token = _frameStateToken(family,
        canvas.getAttribute("data-dwfui-frame-state") || "default");
      return _paintTable3x3Frame(canvas, map[token], cols, rows, shareLeft, shareTop, doc, rendered);
    }
    if (family.kind === "pieces")
      return _paintPieceFrame(canvas, family, map, cols, rows, shareLeft, shareTop, doc, rendered);
    return false;
  }
  function _bindNativeFrameResize(canvas, map, doc) {
    if (canvas.__dwfuiFrameResizeBound ||
        canvas.getAttribute("data-dwfui-frame-auto-size") !== "true") return;
    const RO = (root && root.ResizeObserver) ||
      (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
    const owner = canvas.parentElement;
    if (!RO || !owner) return;
    canvas.__dwfuiFrameResizeBound = true;
    let scheduled = false;
    const observer = new RO(() => {
      if (scheduled) return;
      scheduled = true;
      const raf = (root && root.requestAnimationFrame) ||
        (typeof requestAnimationFrame === "function" ? requestAnimationFrame : fn => fn());
      raf(() => {
        scheduled = false;
        _paintNativeFrame(canvas, map, doc);
      });
    });
    observer.observe(owner);
    canvas.__dwfuiFrameResizeObserver = observer;
  }
  function paintSprites(rootNode) {
    const host = rootNode || (typeof document !== "undefined" ? document : null);
    const chrome = root && root.DFChrome;
    if (!host || !host.querySelectorAll || !chrome || !chrome.getCell) return 0;
    const doc = (host.ownerDocument) || (host.nodeType === 9 ? host : null) ||
      (typeof document !== "undefined" ? document : null);
    const nodes = [];
    host.querySelectorAll("[data-dwfui-sprite]").forEach(node => nodes.push(node));
    // ONE scale for the whole document, read ONCE per pass: what we just painted the art at IS what
    // the labels will be rendered at.
    const iface = interfaceScale(doc);
    _publishInterfaceScale(doc, iface);
    let painted = 0;
    const paintOne = node => {
      const token = _stateToken(node, node.getAttribute("data-dwfui-sprite"));
      // Complete controls have no caller box: their record IS the rectangle. `size` is for glyph art.
      const size = node.getAttribute("data-dwfui-self-framed") === "true"
        ? 0 : (Number(node.getAttribute("data-dwfui-sprite-size")) || 32);
      let canvas = node.querySelector("canvas.df-chrome-icon");
      if (!canvas) {
        canvas = doc.createElement("canvas");
        canvas.className = "df-chrome-icon";
        node.appendChild(canvas);
      }
      const crop = TOKENS.spriteCrops[node.getAttribute("data-dwfui-sprite-crop")];
      if (crop) { _paintSpriteCrop(canvas, crop, token, chrome); return; }
      const rec = chrome.getCell(token);
      if (rec) _paintSpriteScaled(canvas, rec, size, doc);
      else if (chrome.loadMap) Promise.resolve(chrome.loadMap())
        .then(map => { const r = map && map[token]; if (r) _paintSpriteScaled(canvas, r, size, doc); })
        .catch(error => DwfErr.report("dwfui.sprite-map", error));
    };
    nodes.forEach(node => { paintOne(node); painted++; });
    if (nodes.length && chrome.loadMap) {
      try {
        Promise.resolve(chrome.loadMap()).then(map => nodes.forEach(node => _auditSprite(node, map)))
          .catch(error => DwfErr.report("dwfui.sprite-audit-map", error));
      } catch { /* a map that cannot load is DFChrome's problem to log, not ours to throw on */ }
    }
    const frames = [];
    host.querySelectorAll("canvas[data-dwfui-native-frame]").forEach(canvas => frames.push(canvas));
    if (frames.length) {
      const paintFrames = map => frames.forEach(canvas => {
        if (_paintNativeFrame(canvas, map, doc)) painted++;
        _bindNativeFrameResize(canvas, map, doc);
      });
      const loaded = chrome.getCell && chrome.getCell("HOVER_RECTANGLE");
      if (loaded) {
        const map = {};
        const names = new Set();
        frames.forEach(canvas => {
          const family = TOKENS.frameFamilies[canvas.getAttribute("data-dwfui-native-frame")];
          if (!family) return;
          if (family.tokens) Object.values(family.tokens).forEach(token => names.add(token));
          if (family.states) Object.values(family.states).forEach(token => names.add(token));
        });
        names.forEach(token => { map[token] = chrome.getCell(token); });
        paintFrames(map);
      } else if (chrome.loadMap) {
        Promise.resolve(chrome.loadMap()).then(paintFrames)
          .catch(error => DwfErr.report("dwfui.frame-map", error));
      }
    }
    // 0077 cell-run pass: partial native chrome stamped cell by cell (nativeCellRunsHtml).
    const cellRuns = [];
    host.querySelectorAll("canvas[data-dwfui-cell-runs]").forEach(canvas => cellRuns.push(canvas));
    if (cellRuns.length) {
      const tokens = new Set();
      cellRuns.forEach(canvas => {
        try {
          const spec = JSON.parse(canvas.getAttribute("data-dwfui-cell-runs") || "null");
          (spec && spec.runs || []).forEach(run => tokens.add(run.token));
        } catch { /* a malformed spec is reported by the painter, not here */ }
      });
      const paintRuns = map => cellRuns.forEach(canvas => {
        if (_paintNativeCellRuns(canvas, map, doc)) painted++;
      });
      const first = [...tokens][0];
      const loaded = first && chrome.getCell && chrome.getCell(first);
      if (loaded) {
        const map = {};
        tokens.forEach(token => { map[token] = chrome.getCell(token); });
        paintRuns(map);
      } else if (chrome.loadMap) {
        Promise.resolve(chrome.loadMap()).then(paintRuns)
          .catch(error => DwfErr.report("dwfui.cell-run-map", error));
      }
    }
    // LightPlaque pass: nine-slice-tiled left-rail attention plaques (lightPlaqueHtml).
    host.querySelectorAll("canvas[data-dwfui-lightplaque]").forEach(canvas => {
      const token = canvas.getAttribute("data-dwfui-lightplaque");
      const rec = chrome.getCell(token);
      if (rec) { _paintLightPlaque(canvas, rec, doc); painted++; }
      else if (chrome.loadMap) Promise.resolve(chrome.loadMap())
        .then(map => { const r = map && map[token]; if (r) { _paintLightPlaque(canvas, r, doc); } })
        .catch(error => DwfErr.report("dwfui.plaque-map", error));
    });
    // 0081 emblem pass: the 1-bit stencil bake (see emblemHtml/paintEmblems near the api literal).
    return painted + paintEmblems(host) + paintItemSprites(host);
  }

  // Item art lives on DF's raws-parsed item sheets, not interface_map. FAIL LOUD, NEVER A LETTER: an
  // unresolvable ref is marked data-df-identity-missing and painted with the native empty tile.
  function paintItemSprites(rootNode) {
    const host = rootNode || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelectorAll) return 0;
    const tiles = root && root.DwfTiles;
    const resolve = tiles && typeof tiles.resolveItemSpriteRef === "function"
      ? tiles.resolveItemSpriteRef : null;
    let painted = 0;
    host.querySelectorAll("[data-dwfui-item]").forEach(node => {
      const key = node.getAttribute("data-dwfui-item-key") || "?";
      let cell = null;
      if (resolve) {
        try { cell = resolve(JSON.parse(node.getAttribute("data-dwfui-item"))); } catch { cell = null; }
      }
      const ok = !!(cell && cell.sheet &&
        Number.isFinite(Number(cell.col)) && Number.isFinite(Number(cell.row)));
      if (!ok) {
        node.setAttribute("data-df-identity-missing", "item:" + key);
        if (node.classList) node.classList.add("dwfui-icon--empty");
        if (node.style && node.__dwfuiItemPaint) { node.style.removeProperty("background-image"); node.__dwfuiItemPaint = ""; }
        return;
      }
      node.removeAttribute("data-df-identity-missing");
      if (node.classList) node.classList.remove("dwfui-icon--empty");
      const d = node.ownerDocument || (typeof document !== "undefined" ? document : null);
      const iface = interfaceScale(d), zoom = uiZoom(d);
      const authored = Number(String(node.style && node.style.getPropertyValue
        ? node.style.getPropertyValue("--dwfui-icon-size") : "").replace("px", "")) || ITEM_CELL;
      const cssSize = authored * iface;
      const backing = Math.max(1, Math.round(cssSize * zoom));
      const paint = `${cell.sheet}|${cell.col}|${cell.row}|${cell.palRow ?? ""}|${backing}|${cssSize}`;
      if (node.__dwfuiItemPaint !== paint) {
        node.__dwfuiItemPaint = paint;
        // Retire any paint left by the old full-sheet background implementation.
        node.style.removeProperty("background-image");
        node.style.removeProperty("background-position");
        node.style.removeProperty("background-size");
        // Keeps the no-DOM harness usable; a browser always has these APIs and takes the canvas path.
        if (!root.Image || !d || !d.createElement || !node.querySelector) { painted++; return; }
        let canvas = node.querySelector("canvas.dwfui-item-sprite");
        if (!canvas) {
          canvas = d.createElement("canvas");
          canvas.className = "dwfui-item-sprite";
          node.appendChild(canvas);
        }
        canvas.width = backing;
        canvas.height = backing;
        canvas.style.width = zoom === 1 ? "" : `${cssSize}px`;
        canvas.style.height = zoom === 1 ? "" : `${cssSize}px`;
        const ctx = canvas.getContext("2d");
        const img = _itemSheetImage(cell.sheet);
        _whenLoaded(img, () => {
          _clearBrokenArt(canvas);
          ctx.clearRect(0, 0, backing, backing);
          _bakeBlit(ctx, img, Number(cell.col) * ITEM_CELL, Number(cell.row) * ITEM_CELL,
            ITEM_CELL, ITEM_CELL, 0, 0, backing, backing);
          if (Number.isInteger(cell.palRow) && tiles &&
              typeof tiles.remapPaletteForRow === "function") {
            try {
              const id = ctx.getImageData(0, 0, backing, backing);
              tiles.remapPaletteForRow(id.data, cell.palRow);
              ctx.putImageData(id, 0, 0);
            } catch { /* decode/taint race: retain the untinted shared leaf cell */ }
          }
        }, () => _markBrokenArt(canvas, img), canvas);
      }
      painted++;
    });
    return painted;
  }

  function paintBitmapText(rootNode) {
    const renderer = root && root.DFBitmapText;
    if (!renderer) return Promise.resolve(0);
    if (renderer.schedule) return renderer.schedule(rootNode);
    return renderer.paint ? renderer.paint(rootNode) : Promise.resolve(0);
  }

  // The DOM-half boot must be CENTRAL, not a per-panel sprinkle: ONE observer over the document, so
  // every surface gets it whatever route its markup took. Targets inside a sprite span are ignored.

  // Every control is 4 columns wide, and a palette is a running `x += 4` cursor with DELIBERATE HOLES:
  // hidden conditional groups still reserve their columns. Palettes carry NO captions and never wrap.
  const _desigPriorityColumns = base =>
    [1, 2, 3, 4, 5, 6, 7].map((n, i) => [`[data-dig-prio="${n}"]`, base + i * 4]);
  // The marker group: the marker-only toggle then the two marker-conversion tools. The wire names
  // differ from native's, the geometry does not.
  const _desigMarkerColumns = base => [
    ['[data-dig-opt="marker"]', base],
    ['[data-dig-tool="convertmarker"]', base + 4],
    ['[data-dig-tool="convertstandard"]', base + 8],
  ];
  const _desigPaintColumns = base => [
    ['[data-paint-mode="rect"]', base],
    ['[data-paint-mode="free"]', base + 4],
  ];
  // Every control in the surface is 4 columns wide: the `+ 4` step above is this number, and the
  // cluster-frame pass needs it to turn a group's last column into the group's right edge.
  const DESIGNATION_CONTROL_COLS = 4;
  const DESIGNATION_PALETTES = Object.freeze({
    // Tool row ends at 20; W = 112, exactly the Dig clamp.
    digSubmenu: Object.freeze({
      cols: 112, anchor: "#bottomBar [data-dig-menu]",
      columns: Object.freeze([
        ['[data-dig-tool="dig"]', 0], ['[data-dig-tool="stairs"]', 4], ['[data-dig-tool="ramp"]', 8],
        ['[data-dig-tool="channel"]', 12], ['[data-dig-tool="remove"]', 16],
        ..._desigPaintColumns(24),
        ["[data-dig-expand]", 36],
        // The mine-mode row exists only under DIG_DIG and reserves its span otherwise.
        ['[data-dig-mode="0"]', 44], ['[data-dig-mode="1"]', 48],
        ['[data-dig-mode="2"]', 52], ['[data-dig-mode="3"]', 56],
        ..._desigPriorityColumns(64),
        ..._desigMarkerColumns(96),
        // DWF SUPERSET: dig-through-warm/damp is ours. It takes the trailing reserved cell rather than
        // displacing a decoded one -- the one place DWF adds a button, where native reserved the space.
        ['[data-dig-opt="warmdamp"]', 108],
      ]),
    }),
    // Chop and gather share one skeleton with a one-tool row; DWF shares one host and hides the
    // inactive tool, which is what native's two separate palettes look like to the player.
    plantSubmenu: Object.freeze({
      cols: 76, anchor: '#bottomBar [data-designation-tool="gather"]',
      columns: Object.freeze([
        ['[data-plant-tool="chop"]', 0], ['[data-plant-tool="gather"]', 0],
        ..._desigPaintColumns(8),
        ["[data-plant-expand]", 20],
        ..._desigPriorityColumns(28),
        ..._desigMarkerColumns(60),
      ]),
    }),
    // Store order is 9, 11, 10, 12 -- NOT enum order. Laying these out by enum value transposes
    // Track and Engrave.
    smoothSubmenu: Object.freeze({
      cols: 88, anchor: '#bottomBar [data-designation-tool="smooth"]',
      columns: Object.freeze([
        ['[data-smooth-tool="smooth"]', 0], ['[data-smooth-tool="engrave"]', 4],
        ['[data-smooth-tool="track"]', 8], ['[data-smooth-tool="fortify"]', 12],
        ..._desigPaintColumns(20),
        ["[data-smooth-expand]", 32],
        ..._desigPriorityColumns(40),
        ..._desigMarkerColumns(72),
      ]),
    }),
    // Eight tools then the paint pair and nothing else -- no advanced row, priority or marker group.
    // THE LAST PAIR IS UNHIDE BEFORE HIDE, confirmed against the store and hotkey orders.
    itemDesigSubmenu: Object.freeze({
      cols: 48, anchor: '#bottomBar [data-mode-tool="itemdesig"]',
      columns: Object.freeze([
        ['[data-itemdesig-tool="claim"]', 0], ['[data-itemdesig-tool="forbid"]', 4],
        ['[data-itemdesig-tool="dump"]', 8], ['[data-itemdesig-tool="undump"]', 12],
        ['[data-itemdesig-tool="melt"]', 16], ['[data-itemdesig-tool="unmelt"]', 20],
        ['[data-itemdesig-tool="unhide"]', 24], ['[data-itemdesig-tool="hide"]', 28],
        ..._desigPaintColumns(36),
      ]),
    }),
    // Four traffic tools, the paint pair, the expander, then the cost sub-panel. No priority row and
    // no marker group, which is what makes W 80 rather than 88.
    trafficSubmenu: Object.freeze({
      cols: 80, anchor: '#bottomBar [data-mode-tool="traffic"]',
      columns: Object.freeze([
        ['[data-traffic-level="high"]', 0], ['[data-traffic-level="normal"]', 4],
        ['[data-traffic-level="low"]', 8], ['[data-traffic-level="restricted"]', 12],
        ..._desigPaintColumns(20),
        ["[data-traffic-expand]", 32],
      ]),
    }),
    // Erase has no tool row: its lower menu is the free-paint / paint-rectangle pair sitting flush on
    // the erase button's own column, so the pair starts at 0 rather than after a gap.
    eraseSubmenu: Object.freeze({
      cols: 8, anchor: '#bottomBar [data-designation-tool="erase"]',
      columns: Object.freeze(_desigPaintColumns(0)),
    }),
  });
  // The four cost bands start at column 40, right of the collapse arrow, so the fourth sits BESIDE
  // the palette's buttons on the same row. A band is 4 + 26 + 6 = 36 columns, inside the clamp of 80.
  const DESIGNATION_TRAFFIC_BANDS = Object.freeze({
    col: 40, span: 36,
    rows: Object.freeze({ high: -9, normal: -6, low: -3, restricted: 0 }),
  });

  const DESIGNATION_TRAFFIC_DEFAULTS = Object.freeze({ high: 1, normal: 2, low: 5, restricted: 25 });

  // PASS 0 -- close the structural gaps in index.html, in the DOM: index.html is served from cache, so
  // an edit would not reach existing players. Idempotent: each gap checks for its own control first.
  function hydrateDesignationPalettes(scope, costs) {
    const host = scope || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelector) return;
    const doc = host.ownerDocument || host;
    const dig = host.querySelector("#digSubmenu");

    // Native has ONE stair tool, so the three index.html tiles collapse in place. This happens BEFORE
    // the column pass, or the two extra tiles have no decoded column and pile up at the left edge.
    const stairs = [...host.querySelectorAll('[data-dig-tool="stairup"], [data-dig-tool="stairdown"], [data-dig-tool="stairupdown"]')];
    if (stairs.length) {
      const keep = stairs.find(b => b.getAttribute("data-dig-tool") === "stairupdown") || stairs[0];
      keep.setAttribute("data-dig-tool", "stairs");
      keep.title = "Dig stairs: select both z-level endpoints";
      stairs.forEach(b => { if (b !== keep) b.remove(); });
    }

    if (dig && dig.parentNode && !host.querySelector("#eraseSubmenu")) {
      const palette = doc.createElement("div");
      palette.id = "eraseSubmenu";
      palette.className = "tool-group";
      palette.setAttribute("aria-hidden", "true");
      for (const [mode, title] of [["rect", "Paint mode: rectangle corners"],
                                   ["free", "Paint mode: free-hand paint"]]) {
        const button = doc.createElement("button");
        button.className = "tool-button";
        button.setAttribute("data-paint-mode", mode);
        button.title = title;
        palette.appendChild(button);
      }
      dig.parentNode.insertBefore(palette, dig);
    }

    const markerTrio = [
      ["data-dig-opt", "marker", "Marker mode: place designations as blueprint markers (not active until toggled live)"],
      ["data-dig-tool", "convertmarker", "Convert existing designations to marker mode"],
      ["data-dig-tool", "convertstandard", "Convert existing designations to standard mode"],
    ];
    for (const id of ["#plantSubmenu", "#smoothSubmenu"]) {
      const palette = host.querySelector(id);
      if (!palette) continue;
      const wing = palette.querySelector(".dig-adv") || palette;
      for (const [attr, value, title] of markerTrio) {
        if (palette.querySelector(`[${attr}="${value}"]`)) continue;
        const button = doc.createElement("button");
        button.className = "tool-button";
        button.setAttribute(attr, value);
        button.title = title;
        wing.appendChild(button);
      }
    }

    const wing = host.querySelector("#trafficSubmenu .traffic-adv");
    if (wing && !wing.querySelector("[data-traffic-band]")) {
      const weights = costs || DESIGNATION_TRAFFIC_DEFAULTS;
      wing.innerHTML = Object.keys(DESIGNATION_TRAFFIC_BANDS.rows).map(key => {
        const value = Number(weights[key]) || DESIGNATION_TRAFFIC_DEFAULTS[key];
        // The leading 4-column tile is the traffic level's own sprite: that is how a caption-free strip
        // says which band is which.
        return `<div class="traffic-band" data-traffic-band="${key}">` +
          `<span class="tool-button" data-traffic-band-icon="${key}" aria-hidden="true"></span>` +
          `<input type="range" min="1" max="100" step="1" value="${value}" data-traffic-weight="${key}"` +
          ` aria-label="${esc(key)} traffic path cost"` +
          ` title="Path cost of ${esc(key)} traffic. Drag to set.">` +
          // A TEXT field, not a number spinner: native feeds a string being typed into, with no stepper
          // and no arrows.
          `<input type="text" inputmode="numeric" value="${value}" data-traffic-entry="${key}"` +
          ` aria-label="${esc(key)} traffic path cost value"` +
          ` title="Path cost of ${esc(key)} traffic. Type an exact value.">` +
          `</div>`;
      }).join("") +
        // The palettes carry no caption, but a rejected write still has to be reportable: the message
        // goes to an off-screen live region, and the visible signal is the box's own state and tooltip.
        `<div class="traffic-cost-note" role="status" aria-live="polite" data-traffic-cost-note></div>`;
    }
  }

  // PASS 1 -- stamp each control's decoded column and strip the captions native does not have: the
  // digits are painted BY THE SPRITE, so text under it drew the glyph twice. Words move to aria-label.
  function mountDesignationPalettes(scope) {
    const host = scope || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelectorAll) return 0;
    let placed = 0;
    for (const [id, spec] of Object.entries(DESIGNATION_PALETTES)) {
      const palette = host.querySelector(`#${id}`);
      if (!palette) continue;
      palette.style.setProperty("--dwf-pal-cols", String(spec.cols));
      for (const [selector, column] of spec.columns) {
        palette.querySelectorAll(selector).forEach(el => {
          el.setAttribute("data-dwf-col", String(column));
          el.style.setProperty("--dwf-col", String(column));
          placed++;
        });
      }
      palette.querySelectorAll("button").forEach(button => {
        const text = (button.textContent || "").trim();
        if (!text) return;
        if (!button.getAttribute("aria-label")) button.setAttribute("aria-label", button.title || text);
        button.textContent = "";
      });
      palette.querySelectorAll("[data-traffic-band]").forEach(band => {
        band.style.setProperty("--dwf-col", String(DESIGNATION_TRAFFIC_BANDS.col));
        band.style.setProperty("--dwf-band-row",
          String(DESIGNATION_TRAFFIC_BANDS.rows[band.dataset.trafficBand] ?? 0));
        placed++;
      });
      palette.querySelectorAll(".tool-subgroup").forEach(group => {
        const columns = [...group.querySelectorAll("[data-dwf-col]")]
          .map(el => Number(el.getAttribute("data-dwf-col")))
          .filter(Number.isFinite);
        if (!columns.length) {
          // A cluster the table places nothing in gets no frame rather than a guessed one.
          group.removeAttribute("data-dwf-cols");
          group.style.removeProperty("--dwf-group-col");
          group.style.removeProperty("--dwf-group-cols");
          return;
        }
        const first = Math.min(...columns);
        const span = Math.max(...columns) + DESIGNATION_CONTROL_COLS - first;
        group.setAttribute("data-dwf-cols", String(span));
        group.style.setProperty("--dwf-group-col", String(first));
        group.style.setProperty("--dwf-group-cols", String(span));
        placed++;
      });
    }
    return placed;
  }

  // PASS 2 -- native's anchor-and-shove prologue. Y is the stylesheet's job; X is measured here,
  // because the shove depends on the DRAWN cell, which changes with the interface scale and zoom.
  function placeDesignationPalettes(scope) {
    const host = scope || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelector) return {};
    const cellW = _designationCellWidth(host);
    const out = {};
    for (const [id, spec] of Object.entries(DESIGNATION_PALETTES)) {
      const palette = host.querySelector(`#${id}`);
      if (!palette) continue;
      palette.style.setProperty("--dwf-pal-cols", String(spec.cols));
      if (!palette.classList.contains("visible")) continue;
      const anchor = host.querySelector(spec.anchor);
      const parent = palette.offsetParent || palette.parentNode;
      if (!anchor || !parent || !parent.getBoundingClientRect) continue;
      const parentRect = parent.getBoundingClientRect();
      // Our equivalent of native's map bounds is the band the bottom chrome is laid out in, which is
      // the palette's own offset parent.
      const mapLeft = 0;
      const mapRight = parentRect.width;
      const width = spec.cols * cellW;
      let x = anchor.getBoundingClientRect().left - parentRect.left;
      if (x + width > mapRight) x -= (x + width - mapRight);
      if (x < mapLeft) x = mapLeft;
      out[id] = Math.round(x);
      palette.style.setProperty("--dwf-pal-left", `${out[id]}px`);
    }
    return out;
  }
  // The drawn cell, MEASURED, not parsed: an unregistered custom property computes to its own token
  // stream, so getPropertyValue returns "calc(8px * 1.25)" and parseFloat reads NaN.
  function _designationCellWidth(host) {
    try {
      const doc = host.ownerDocument || host;
      if (!doc.createElement || !doc.body) return 8;
      const probe = doc.createElement("i");
      probe.className = "dwfui-cell-measure-probe";
      doc.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      if (Number.isFinite(width) && width > 0) return width;
    } catch { return 8; }
    return 8;
  }

  function mountDom(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || !d.querySelectorAll) return null;
    if (d.__dwfuiDomMounted) return d.__dwfuiDomObserver || null;
    d.__dwfuiDomMounted = true;
    // Publish the interface scale BEFORE anything paints: DFBitmapText reads it off <html> first, so
    // stamping it here means the very first label pass already lands on DF's grid.
    try { _publishInterfaceScale(d, interfaceScale(d)); } catch (error) { DwfErr.report("dwfui.mount-scale", error); }
    try { mountScrollbarArt(d); } catch (error) { DwfErr.report("dwfui.mount-scrollbar-art", error); }
    try { mountTabArt(d); } catch (error) { DwfErr.report("dwfui.mount-tab-art", error); }
    try { mountPlaqueArt(d); } catch (error) { DwfErr.report("dwfui.mount-plaque-art", error); }
    try { mountCyclerArt(d); } catch (error) { DwfErr.report("dwfui.mount-cycler-art", error); }
    try { mountButtonStateArt(d); } catch (error) { DwfErr.report("dwfui.mount-button-art", error); }
    const pass = node => {
      if (!node || !node.querySelectorAll) return;
      paintSprites(node);
      try { refitNativeLabels(node); } catch (error) { DwfErr.report("dwfui.mount-labels", error); }
      const labelsPainted = paintBitmapText(node);
      restoreScroll(node);
      restoreSearchCaret(node);
      // These MEASURE. Each is individually guarded, so one surface with no measurable rows cannot
      // stop the others.
      const measure = () => {
        try { mountRowScroll(node); } catch (error) { DwfErr.report("dwfui.mount-row-scroll", error); }
        try { mountLists(node); } catch (error) { DwfErr.report("dwfui.mount-lists", error); }
        try { mountTableColumns(node); } catch (error) { DwfErr.report("dwfui.mount-table-columns", error); }
      };
      measure();
      try { mountTabPromotion(node); } catch (error) { DwfErr.report("dwfui.mount-tab-promotion", error); }
      // Bitmap labels paint asynchronously and can change row heights and column widths, so measure
      // again once they land. Only when something painted: a no-op pass must not re-measure forever.
      Promise.resolve(labelsPainted).then(count => {
        if (count > 0 && node.isConnected !== false) measure();
      }).catch(error => DwfErr.report("dwfui.mount-remeasure", error));
    };
    pass(d);
    const MO = (root && root.MutationObserver) ||
      (typeof MutationObserver !== "undefined" ? MutationObserver : null);
    if (!MO) return null;
    const observer = new MO(records => {
      const targets = [];
      for (const rec of records) {
        const t = rec.target;
        if (!t || t.nodeType !== 1) continue;
        // AN ATTRIBUTE RECORD IS NOT A CHANGE: the DOM fires one for an identical re-serialisation, and
        // that is half of an infinite repaint loop. Dropping no-op records is the precise cure.
        if (rec.type === "attributes") {
          if (rec.oldValue === t.getAttribute(rec.attributeName)) continue;
          if (targets.indexOf(t) === -1) targets.push(t);
          continue;
        }
        if (!rec.addedNodes || !rec.addedNodes.length) continue;
        // our own canvas append re-enters here otherwise
        if (t.closest && (t.closest("[data-dwfui-sprite]") || t.closest("[data-dwfui-item]") ||
          t.closest("[data-dwfui-bitmap-text]"))) continue;
        if (targets.indexOf(t) === -1) targets.push(t);
      }
      targets.forEach(pass);
    });
    // attributeOldValue is REQUIRED: without the old value a real change cannot be told from a no-op
    // re-serialisation, and the no-op is what loops.
    observer.observe(d.body || d.documentElement || d, {
      childList: true, subtree: true, attributes: true, attributeOldValue: true,
      attributeFilter: ["class", "style", "data-dwfui-bitmap-text", "data-dwfui-bitmap-scale"],
    });
    d.__dwfuiDomObserver = observer;
    return observer;
  }

  // ---- mountScrollbarArt: the native scrollbar, blitted -----------------------------------------
  function mountScrollbarArt(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const chrome = root && root.DFChrome;
    if (!d || !d.documentElement || !chrome || !chrome.loadMap || typeof Image === "undefined") return false;
    const SB = TOKENS.scrollbar;
    return chrome.loadMap().then(map => {
      const bar = map && map[SB.bar];
      if (!bar) return false;
      const sheet = new Image();
      sheet.src = "/asset/" + bar.img;
      const iface = interfaceScale(d);
      // Baked at the interface scale with the blend, like the tabs, so the pseudo-element boxes get a
      // slice that is already the right size and the bar grows WITH the rest of the interface.
      const crop = (rec, sx, sy, sw, sh) => {
        const canvas = d.createElement("canvas");
        canvas.width = Math.max(1, Math.round(sw * iface));
        canvas.height = Math.max(1, Math.round(sh * iface));
        const ctx = canvas.getContext("2d");
        _bakeBlit(ctx, sheet, rec.cx + sx, rec.cy + sy, sw, sh, 0, 0, canvas.width, canvas.height);
        return `url("${canvas.toDataURL("image/png")}")`;
      };
      const publish = () => {
        const style = d.documentElement.style;
        const cell = SB.cell;
        // the 16x36 SCROLLBAR token, sliced into its three 16x12 cells
        style.setProperty("--dwfui-sb-arrow-up", crop(bar, 0, 0, cell.w, cell.h));
        style.setProperty("--dwfui-sb-track", crop(bar, 0, cell.h, cell.w, cell.h));
        style.setProperty("--dwfui-sb-arrow-down", crop(bar, 0, cell.h * 2, cell.w, cell.h));
        // The long thumb is four layers: caps, a plain tiled body, and ONE centred gem -- CENTER_SCROLLER
        // is an ornament, not the repeating body.
        const named = {
          "--dwfui-sb-thumb-top": SB.thumbTop, "--dwfui-sb-thumb-center": SB.thumbCenter,
          "--dwfui-sb-thumb-bottom": SB.thumbBottom, "--dwfui-sb-thumb-blank": SB.thumbBlank,
          "--dwfui-sb-thumb-small": SB.thumbSmall, "--dwfui-sb-thumb-offcenter": SB.thumbOffcenter,
          "--dwfui-sb-thumb-small-hover": SB.thumbSmallHover,
          "--dwfui-sb-thumb-offcenter-hover": SB.thumbOffcenterHover,
          "--dwfui-sb-thumb-top-hover": SB.thumbTopHover,
          "--dwfui-sb-thumb-center-hover": SB.thumbCenterHover,
          "--dwfui-sb-thumb-bottom-hover": SB.thumbBottomHover,
          "--dwfui-sb-thumb-blank-hover": SB.thumbBlankHover,
          "--dwfui-sb-arrow-up-hover": SB.upHover, "--dwfui-sb-arrow-up-pressed": SB.upPressed,
          "--dwfui-sb-arrow-down-hover": SB.downHover, "--dwfui-sb-arrow-down-pressed": SB.downPressed,
        };
        for (const [prop, token] of Object.entries(named)) {
          const rec = map[token];
          if (rec) style.setProperty(prop, crop(rec, 0, 0, rec.w, rec.h));
        }
        d.documentElement.setAttribute("data-dwfui-scrollbar", "native");
        return true;
      };
      if (sheet.complete && sheet.naturalWidth) return publish();
      return new Promise(resolve => {
        sheet.addEventListener("load", () => resolve(publish()), { once: true });
        sheet.addEventListener("error", () => resolve(false), { once: true });
      });
    });
  }

  // Each 40px tab token is FIVE 8px cells: two per cap, ONE flat centre that TILES. Cutting it 8|24|8
  // damages both bevel transitions, and stretching the remainder warps them further.
  function mountTabArt(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const chrome = root && root.DFChrome;
    if (!d || !d.documentElement || !chrome || !chrome.loadMap || typeof Image === "undefined") return false;
    if (d.documentElement.getAttribute("data-dwfui-tabs") === "native") return Promise.resolve(true);
    return chrome.loadMap().then(map => {
      const entries = [];
      for (const [level, pair] of Object.entries(TOKENS.tabs)) {
        entries.push([level, "off", pair.off], [level, "on", pair.on]);
      }
      const records = entries.map(([, , token]) => map && map[token]);
      if (records.some(rec => !rec || rec.w !== 40 || (rec.h !== 24 && rec.h !== 36))) return false;
      const sheetName = records[0].img;
      if (records.some(rec => rec.img !== sheetName)) return false;
      const sheet = new Image();
      sheet.src = "/asset/" + sheetName;
      const iface = interfaceScale(d);
      const crop = (rec, sx, sw) => {
        const canvas = d.createElement("canvas");
        canvas.width = sw; canvas.height = rec.h;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sheet, rec.cx + sx, rec.cy, sw, rec.h, 0, 0, sw, rec.h);
        // DF's tab cells are fully opaque and use the corner colour outside each trapezoid, so the key-out
        // MUST happen at 1:1 BEFORE the scale -- a blended image has the key mixed into the slopes.
        const keyCanvas = d.createElement("canvas");
        keyCanvas.width = 1; keyCanvas.height = 1;
        const keyCtx = keyCanvas.getContext("2d");
        keyCtx.drawImage(sheet, rec.cx, rec.cy, 1, 1, 0, 0, 1, 1);
        const key = keyCtx.getImageData(0, 0, 1, 1).data;
        const image = ctx.getImageData(0, 0, sw, rec.h);
        const kr = key[0], kg = key[1], kb = key[2];
        for (let p = 0; p < image.data.length; p += 4) {
          if (image.data[p] === kr && image.data[p + 1] === kg && image.data[p + 2] === kb)
            image.data[p + 3] = 0;
        }
        ctx.putImageData(image, 0, 0);
        // ...and NOW bake the interface scale plus the blend into the slice, ONCE, at mount, so the
        // cropped slice and its CSS box are the same size and nothing resamples at paint time.
        if (Math.abs(iface - 1) < 1e-6) return `url("${canvas.toDataURL("image/png")}")`;
        const scaled = d.createElement("canvas");
        scaled.width = Math.max(1, Math.round(sw * iface));
        scaled.height = Math.max(1, Math.round(rec.h * iface));
        const sctx = scaled.getContext("2d");
        _bakeBlit(sctx, canvas, 0, 0, sw, rec.h, 0, 0, scaled.width, scaled.height);
        return `url("${scaled.toDataURL("image/png")}")`;
      };
      const publish = () => {
        const style = d.documentElement.style;
        for (let i = 0; i < entries.length; i++) {
          const [level, state] = entries[i];
          const rec = records[i];
          const prefix = `--dwfui-tab-${level}-${state}`;
          style.setProperty(`${prefix}-left`, crop(rec, 0, 16));
          style.setProperty(`${prefix}-middle`, crop(rec, 16, 8));
          style.setProperty(`${prefix}-right`, crop(rec, 24, 16));
        }
        d.documentElement.setAttribute("data-dwfui-tabs", "native");
        return true;
      };
      if (sheet.complete && sheet.naturalWidth) return publish();
      return new Promise(resolve => {
        sheet.addEventListener("load", () => resolve(publish()), { once: true });
        sheet.addEventListener("error", () => resolve(false), { once: true });
      });
    });
  }

  // Plaques are 8|8|8 constructions: fixed caps around one tiled centre cell, over two sheets.
  function mountPlaqueArt(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const chrome = root && root.DFChrome;
    if (!d || !d.documentElement || !chrome || !chrome.loadMap || typeof Image === "undefined") return false;
    if (d.documentElement.getAttribute("data-dwfui-plaques") === "native") return Promise.resolve(true);
    const P = TOKENS.plaques;
    const entries = [["neutral", P.neutral], ["active", P.neutralOn], ["confirm", P.confirm], ["destructive", P.destructive]];
    return chrome.loadMap().then(map => {
      const records = entries.map(([, token]) => map && map[token]);
      const leftOrn = map && map[P.ornamentLeft], rightOrn = map && map[P.ornamentRight];
      if (records.some(rec => !rec || rec.w !== 24 || rec.h !== 36) ||
          !leftOrn || !rightOrn || leftOrn.w !== 32 || rightOrn.w !== 32) return false;
      const names = [...new Set([...records, leftOrn, rightOrn].map(rec => rec.img))];
      return Promise.all(names.map(name => new Promise(resolve => {
        const image = new Image(); image.src = "/asset/" + name;
        if (image.complete && image.naturalWidth) resolve([name, image]);
        else {
          image.addEventListener("load", () => resolve([name, image]), { once: true });
          image.addEventListener("error", () => resolve([name, null]), { once: true });
        }
      }))).then(pairs => {
        const sheets = Object.fromEntries(pairs);
        if (Object.values(sheets).some(image => !image)) return false;
        const iface = interfaceScale(d);
        const crop = (rec, sx, sw) => {
          const canvas = d.createElement("canvas"); canvas.width = sw; canvas.height = rec.h;
          const ctx = canvas.getContext("2d"); ctx.imageSmoothingEnabled = false;
          const sheet = sheets[rec.img];
          ctx.drawImage(sheet, rec.cx + sx, rec.cy, sw, rec.h, 0, 0, sw, rec.h);
          const image = ctx.getImageData(0, 0, sw, rec.h);
          for (let p = 0; p < image.data.length; p += 4) {
            if (image.data[p] === 28 && image.data[p + 1] === 28 && image.data[p + 2] === 28)
              image.data[p + 3] = 0;
          }
          ctx.putImageData(image, 0, 0);
          // Key at 1:1, THEN bake the scale and the blend -- see mountTabArt for why that order is the
          // only one that works.
          if (Math.abs(iface - 1) < 1e-6) return `url("${canvas.toDataURL("image/png")}")`;
          const scaled = d.createElement("canvas");
          scaled.width = Math.max(1, Math.round(sw * iface));
          scaled.height = Math.max(1, Math.round(rec.h * iface));
          _bakeBlit(scaled.getContext("2d"), canvas, 0, 0, sw, rec.h, 0, 0, scaled.width, scaled.height);
          return `url("${scaled.toDataURL("image/png")}")`;
        };
        const style = d.documentElement.style;
        for (let i = 0; i < entries.length; i++) {
          const prefix = `--dwfui-plaque-${entries[i][0]}`, rec = records[i];
          style.setProperty(`${prefix}-left`, crop(rec, 0, 8));
          style.setProperty(`${prefix}-middle`, crop(rec, 8, 8));
          style.setProperty(`${prefix}-right`, crop(rec, 16, 8));
        }
        style.setProperty("--dwfui-plaque-focus-left", crop(leftOrn, 0, 32));
        style.setProperty("--dwfui-plaque-focus-right", crop(rightOrn, 0, 32));
        d.documentElement.setAttribute("data-dwfui-plaques", "native");
        return true;
      });
    });
  }

  // One-line text plaques, all 8|8|8 cells: the cycler's middle and the sort header's label.
  const TEXT_PLAQUES = [
    ["--dwfui-cycler-mid", "TYPE_FILTER_TEXT"],
    ["--dwfui-sort-text-off", "SORT_TEXT_INACTIVE"],
    ["--dwfui-sort-text-on", "SORT_TEXT_ACTIVE"],
  ];
  function mountCyclerArt(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const chrome = root && root.DFChrome;
    if (!d || !d.documentElement || !chrome || !chrome.loadMap || typeof Image === "undefined") return false;
    if (d.documentElement.getAttribute("data-dwfui-cycler") === "native") return Promise.resolve(true);
    return chrome.loadMap().then(map => {
      const records = TEXT_PLAQUES.map(([, token]) => map && map[token]);
      if (records.some(rec => !rec || rec.w !== 24 || rec.h !== 12)) return false;
      const sheets = {};
      records.forEach(rec => {
        if (sheets[rec.img]) return;
        sheets[rec.img] = new Image();
        sheets[rec.img].src = "/asset/" + rec.img;
      });
      const iface = interfaceScale(d);
      const crop = (record, sx, sw) => {
        const canvas = d.createElement("canvas");
        canvas.width = sw; canvas.height = record.h;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sheets[record.img], record.cx + sx, record.cy, sw, record.h, 0, 0, sw, record.h);
        // Bake the scale and the blend ONCE at mount, so the CSS box and the slice match and nothing
        // resamples at paint time.
        if (Math.abs(iface - 1) < 1e-6) return `url("${canvas.toDataURL("image/png")}")`;
        const scaled = d.createElement("canvas");
        scaled.width = Math.max(1, Math.round(sw * iface));
        scaled.height = Math.max(1, Math.round(record.h * iface));
        _bakeBlit(scaled.getContext("2d"), canvas, 0, 0, sw, record.h, 0, 0, scaled.width, scaled.height);
        return `url("${scaled.toDataURL("image/png")}")`;
      };
      const publish = () => {
        const style = d.documentElement.style;
        TEXT_PLAQUES.forEach(([prefix], i) => {
          style.setProperty(`${prefix}-left`, crop(records[i], 0, 8));
          style.setProperty(`${prefix}-middle`, crop(records[i], 8, 8));
          style.setProperty(`${prefix}-right`, crop(records[i], 16, 8));
        });
        d.documentElement.setAttribute("data-dwfui-cycler", "native");
        return true;
      };
      const loaded = sheet => sheet.complete && sheet.naturalWidth ? Promise.resolve(true) : new Promise(resolve => {
        sheet.addEventListener("load", () => resolve(true), { once: true });
        sheet.addEventListener("error", () => resolve(false), { once: true });
      });
      return Promise.all(Object.values(sheets).map(loaded)).then(ok => ok.every(Boolean) && publish());
    });
  }

  // The only honest state swap is to blit a DIFFERENT CELL: a background under a self-framed face is
  // occluded and leaks out of any transparent margin. ONE delegated listener set per DOCUMENT.
  const _btnStates = new WeakMap();            // document -> the shared pre-warm promise
  function mountButtonStateArt(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const chrome = root && root.DFChrome;
    if (!d || !d.documentElement || !chrome || !chrome.loadMap) return false;
    // The stamp is set BEFORE the async pre-warm and the in-flight promise is shared, so a call
    // arriving mid-flight neither re-wires nor starts a second load.
    if (_btnStates.has(d)) return _btnStates.get(d);
    const swap = (button, state) => {
      let touched = 0;
      (button.querySelectorAll("[data-dwfui-sprite-states]") || []).forEach(face => {
        if ((face.getAttribute("data-dwfui-sprite-state") || "base") === state) return;
        // A `null` entry resolves BACK to base, so the attribute changed but the cell did not. Compare
        // the RESOLVED token, which is what paintSprites would actually draw.
        const token = face.getAttribute("data-dwfui-sprite");
        const was = _stateToken(face, token);
        face.setAttribute("data-dwfui-sprite-state", state);
        if (_stateToken(face, token) !== was) touched++;
      });
      (button.querySelectorAll('canvas[data-dwfui-native-frame="pictureBox"]') || []).forEach(frame => {
        const family = TOKENS.frameFamilies.pictureBox;
        const before = _frameStateToken(family,
          frame.getAttribute("data-dwfui-frame-state") || "default");
        frame.setAttribute("data-dwfui-frame-state", state === "base" ? "default" : state);
        const after = _frameStateToken(family,
          frame.getAttribute("data-dwfui-frame-state") || "default");
        if (after !== before) touched++;
      });
      if (touched) paintSprites(button);
    };
    const owner = event => {
      const target = event && event.target;
      const button = target && target.closest ? target.closest("button") : null;
      if (!button || !button.querySelector || button.hasAttribute("disabled")) return null;
      return (button.querySelector("[data-dwfui-sprite-states]") ||
        button.querySelector('canvas[data-dwfui-native-frame="pictureBox"]')) ? button : null;
    };
    const on = (type, state) => d.addEventListener(type, event => {
      const button = owner(event);
      if (button) swap(button, state);
    }, true);
    // pointerout fires when the pointer crosses between a button's OWN children; those are not exits,
    // so bail while the pointer is still inside the same button.
    d.addEventListener("pointerout", event => {
      const button = owner(event);
      if (!button) return;
      const to = event && event.relatedTarget;
      if (to && button.contains && button.contains(to)) return;
      swap(button, "base");
    }, true);
    on("pointerover", "hover");
    on("pointerdown", "pressed"); on("pointerup", "hover"); on("pointercancel", "base");
    d.documentElement.setAttribute("data-dwfui-btn-states", "native");
    // Pre-warm the map so the FIRST hover blits from a resolved map rather than a promise.
    const promise = Promise.resolve(chrome.loadMap()).then(() => true, () => false);
    _btnStates.set(d, promise);
    return promise;
  }

  // restoreScroll / restoreSearchCaret, keyed by markup (`preserveKey`), so a deterministic re-render
  // does not throw the player back to the top of a list or eat the character they just typed.
  const _scrollPos = Object.create(null);
  function restoreScroll(rootNode) {
    const host = rootNode || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelectorAll) return 0;
    let n = 0;
    host.querySelectorAll("[data-dwfui-scroll-key]").forEach(node => {
      const key = node.getAttribute("data-dwfui-scroll-key");
      if (_scrollPos[key] != null) node.scrollTop = _scrollPos[key];
      if (!node.__dwfuiScrollBound) {
        node.__dwfuiScrollBound = true;
        node.addEventListener("scroll", () => { _scrollPos[key] = node.scrollTop; }, { passive: true });
      }
      n++;
    });
    return n;
  }
  const _caretPos = Object.create(null);
  function restoreSearchCaret(rootNode) {
    const host = rootNode || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelectorAll) return 0;
    let n = 0;
    host.querySelectorAll("input[data-dwfui-search-key]").forEach(node => {
      const key = node.getAttribute("data-dwfui-search-key");
      const saved = _caretPos[key];
      if (saved != null && typeof node.setSelectionRange === "function") {
        try { node.focus({ preventScroll: true }); node.setSelectionRange(saved, saved); }
        catch (error) { DwfErr.report("dwfui.restore-search-caret", error); }
      }
      if (!node.__dwfuiCaretBound) {
        node.__dwfuiCaretBound = true;
        const save = () => { _caretPos[key] = node.selectionStart; };
        node.addEventListener("input", save);
        node.addEventListener("keyup", save);
        node.addEventListener("click", save);
      }
      n++;
    });
    return n;
  }

  // ---- NativeRow: the one row grammar ----------------------------------------------------------
  const ROW_STATE_CLASS = { on: "on", off: "off", some: "some" };
  // A tone is a CLASS HOOK onto --dwfui-text-<role>; a consumer may not pass a colour. An unknown
  // tone renders with no tone class -- it never throws and never invents a colour.
  const SUB_TONES = new Set(["secondary", "warning", "good", "active", "numeric", "row", "disabled",
                             "danger"]);
  function subLineHtml(line) {
    if (line == null) return "";
    const classes = [withBaseClass("dwfui-sub", line.cls)];
    if (line.tone && SUB_TONES.has(line.tone)) classes.push(`dwfui-sub--${line.tone}`);
    const body = line.html != null ? line.html : bitmapTextHtml(line.text == null ? "" : line.text);
    return `<span class="${classes.join(" ")}">${body}</span>`;
  }
  function rowHtml(cfg) {
    const c = cfg || {};
    const tag = c.tag || "div";
    const classes = ["dwfui-row"];
    if (c.cls) classes.push(c.cls);
    if (c.on === true) classes.push("on"); else if (c.on === false) classes.push("off");
    if (c.selected) classes.push("selected");
    // --- additive row vocabulary; absent means the row renders exactly as it did before ---
    const chassis = (c.chassis === "slab" || c.chassis === "table") ? c.chassis : null;
    if (chassis) classes.push(`dwfui-row--${chassis}`);
    const state = ROW_STATE_CLASS[c.state] || null;
    if (state) classes.push(`dwfui-row--${state}`);
    // Selection PAINTS PER CHASSIS. Neither variant changes the fill.
    if (c.selected && chassis)
      classes.push(chassis === "slab" ? "dwfui-row--sel-brackets" : "dwfui-row--sel-outline");
    // A modifier, and only ON a chassis: without one there is no row grammar to re-lay, so it is a
    // no-op rather than a silent half-styled row.
    if (c.stacked && chassis) classes.push("dwfui-row--stacked");
    if (c.layout === "icon") classes.push("dwfui-row--icon");
    if (c.announce) classes.push("dwfui-row--announce");
    if (c.announce && c.announceLine) classes.push("dwfui-row--announce-line");
    // `disabled` on a <div> is inert, and most native rows ARE divs -- so add the class too.
    if (c.disabled) classes.push("disabled");
    // A row tone colours the whole row except sub lines with their own tone.
    if (SUB_TONES.has(c.tone)) classes.push("dwfui-row--toned");
    let attrs = ` class="${classes.join(" ")}"`;
    if (c.role) attrs += ` role="${esc(c.role)}"`;
    if (c.checked != null) attrs += ` aria-checked="${c.checked ? "true" : "false"}"`;
    if (c.selected) attrs += ` aria-selected="true"`;
    if (c.ariaLabel) attrs += ` aria-label="${esc(c.ariaLabel)}"`;
    if (c.title) attrs += ` title="${esc(c.title)}"`;
    if (c.disabled) attrs += " disabled";
    if (SUB_TONES.has(c.tone)) attrs += ` style="--dwfui-row-tone:var(--dwfui-text-${c.tone})"`;
    attrs += datasetAttrs(c.dataset);
    const icon = c.icon != null ? c.icon : (c.iconCfg ? iconHtml(c.iconCfg) : "");
    const label = c.labelHtml != null ? c.labelHtml : bitmapTextHtml(c.label == null ? "" : c.label);
    const sub = Array.isArray(c.sub)
      ? c.sub.map(subLineHtml).join("")
      : (c.sub ? subLineHtml(c.sub) : "");
    const copy = `<span class="${withBaseClass("dwfui-copy", c.copyCls)}"><span class="${withBaseClass("dwfui-label", c.labelCls)}">${label}</span>${sub}</span>`;
    // The multi-column table row. Omitted cells emit NOTHING.
    const cells = Array.isArray(c.cells)
      ? c.cells.filter(cell => cell != null && cell.html != null).map(cell =>
        `<span class="dwfui-cell${cell.numeric ? " dwfui-cell--num" : ""}${cell.cls ? " " + cell.cls : ""}"` +
        `${Number(cell.width) > 0 ? ` style="--dwfui-cell-w:${Math.round(Number(cell.width))}px"` : ""}` +
        `>${cell.html}</span>`).join("")
      : "";
    return `<${tag}${attrs}>${icon}${copy}${cells}${c.trailing || ""}</${tag}>`;
  }

  // Native's search-result grammar: a lighter group-header bar with a REDUCED action set and no icon
  // box, over indented member rows that each carry the full cluster.
  function rowGroupHtml(cfg) {
    const c = cfg || {};
    const h = c.header || {};
    const count = (h.count != null && h.count !== "")
      ? `<span class="dwfui-group-count">[${esc(h.count)}]</span>` : "";
    return `<div class="dwfui-group${c.cls ? " " + c.cls : ""}"${datasetAttrs(c.dataset)}>` +
      `<div class="dwfui-group-head${h.cls ? " " + h.cls : ""}">` +
      `<span class="dwfui-group-label">${h.labelHtml != null ? h.labelHtml : bitmapTextHtml(h.label == null ? "" : h.label)}</span>` +
      `${count}${h.actionsHtml || ""}</div>` +
      `<div class="dwfui-group-rows">${(c.rows || []).join("")}</div></div>`;
  }

  // ---- Action-button cluster --------------------------------------------------------------------
  const BTN_STATE_CLASS = {
    default: null, hover: "dwfui-btn--hover", pressed: "dwfui-btn--pressed",
    disabled: "dwfui-btn--disabled", selected: "dwfui-btn--selected",
    active: "dwfui-btn--active", selectedActive: "dwfui-btn--sel-active",
  };
  // Which state family a base token belongs to, derived from TOKENS.states so a caller never names
  // it. FRAME is excluded: a self-framed face has nothing separable to replace.
  const STATE_FAMILY_BY_BASE = new Map(Object.entries(TOKENS.states)
    .filter(([family, table]) => family !== "frame" && table.base &&
      (table.hover || table.pressed || table.disabled))
    .map(([family, table]) => [table.base, family]));
  const stateFamilyOf = token => STATE_FAMILY_BY_BASE.get(token) || null;
  // A face with real native art for its state must NOT also be dimmed -- DF swaps the sprite. Every
  // other disabled control keeps the CSS dim, because DF ships nothing to swap in.
  const stateArtAttr = (family, state) =>
    family && state && state !== "default" && TOKENS.states[family] && TOKENS.states[family][state]
      ? ` data-dwfui-state-art="true"` : "";
  // `default` is not a state opt-in (an enabled button must stay byte-identical); pointer states are runtime.
  const knownState = c => c.disabled ? "disabled" : (c.state && c.state !== "default" ? c.state : null);
  const ITEM_ACTION_PRESET = [
    { action: "view", sprite: TOKENS.sprites.view, title: "View item" },
    { action: "forbid", sprite: TOKENS.sprites.forbid, activeSprite: TOKENS.sprites.forbidOn, title: "Forbid" },
    { action: "dump", sprite: TOKENS.sprites.dump, activeSprite: TOKENS.sprites.dumpOn, title: "Dump" },
    { action: "hide", sprite: TOKENS.sprites.hide, activeSprite: TOKENS.sprites.hideOn, gapBefore: true, title: "Hide" },
  ];
  function actionButtonsHtml(items, opts) {
    const o = opts || {};
    const list = o.preset === "itemActions"
      ? ITEM_ACTION_PRESET.map((base, i) => Object.assign({}, base, (items || [])[i] || {}))
      : (items || []);
    const buttons = list.map(item => {
      if (item.placeholder && !item.title)
        throw new Error("DWFUI.actionButtonsHtml: placeholder:true requires a title saying what is unverified");
      const classes = [];
      if (o.btnCls) classes.push(o.btnCls);
      if (item.active) classes.push("active");
      if (item.gapBefore) classes.push("dwfui-gap");
      const stateCls = BTN_STATE_CLASS[item.state];
      if (stateCls) classes.push(stateCls);
      if (item.placeholder) classes.push("dwfui-btn--placeholder");
      // NATIVE ART FIRST: a sprite item renders the sprite and NO glyph text -- never a silent fall
      // back to the emoji vocabulary.
      const sprite = item.active && item.activeSprite ? item.activeSprite : item.sprite;
      const selfFramed = isSelfFramedSprite(sprite);
      const cls = classes.length ? ` class="${classes.join(" ")}"` : "";
      const family = stateFamilyOf(sprite);
      const state = knownState(item);
      const content = (sprite || item.art)
        ? iconHtml({ sprite, art: item.art, size: item.size, nativeCell: selfFramed, states: family, state,
          alt: item.title || item.action })
        : (item.glyph != null ? item.glyph : (TOKENS.glyphs[item.action] || ""));
      return `<button${item.id ? ` id="${esc(item.id)}"` : ""}${cls}${selfFramed ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : ""}` +
        `${stateArtAttr(family, state)}${datasetAttrs(item.dataset)}` +
        `${item.title ? ` title="${esc(item.title)}"` : ""}${item.disabled ? " disabled" : ""}>${content}</button>`;
    }).join("");
    return `<span class="${withBaseClass("dwfui-actions", o.cls)}"${o.ariaLabel ? ` aria-label="${esc(o.ariaLabel)}"` : ""}>${buttons}</span>`;
  }

  // Native's checkbox is a COMPLETE sprite in BOTH states, so an UNCHECKED check renders a REAL TILE.
  // AGAINST latchHtml: a check says yes/no; a latch's two states are DIFFERENT ICONS, different things.
  function checkHtml(cfg) {
    const c = cfg || {};
    const classes = ["dwfui-check"];
    if (c.cls) classes.push(c.cls);
    if (c.checked) classes.push("on");
    if (c.disabled) classes.push("disabled");
    const token = c.checked
      ? (c.activeSprite || TOKENS.sprites.checkOn)
      : (c.sprite || TOKENS.sprites.checkOff);
    const selfFramed = isSelfFramedSprite(token);
    return `<button type="button" class="${classes.join(" ")}"` +
      `${selfFramed ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : ""}` +
      `${datasetAttrs(c.dataset)}` +
      ` aria-pressed="${c.checked ? "true" : "false"}"` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}${c.disabled ? " disabled" : ""}>` +
      `${iconHtml({ sprite: token, size: c.size, nativeCell: selfFramed, alt: c.ariaLabel || c.title })}</button>`;
  }

  // A RADIOGROUP over columns (exactly one active key). Each column is a direction arrow, then its caption,
  // if any, on the SORT_TEXT plaque that mountCyclerArt publishes.
  const SORT_SPRITE = {
    asc: { on: TOKENS.sprites.sortAsc, off: TOKENS.sprites.sortAscOff },
    desc: { on: TOKENS.sprites.sortDesc, off: TOKENS.sprites.sortDescOff },
  };
  function sortHeaderHtml(cfg) {
    const c = cfg || {};
    const columns = Array.isArray(c.columns) ? c.columns : [];
    const attr = c.dataAttr || "dwfui-sort";
    const keys = columns.map(col => col && col.key);
    if (keys.some(key => key == null || key === ""))
      throw new Error("DWFUI.sortHeaderHtml: every column needs a `key` (it is a radiogroup over columns)");
    if (c.active != null && c.active !== "" && keys.indexOf(c.active) === -1)
      throw new Error(`DWFUI.sortHeaderHtml: active key ${JSON.stringify(c.active)} names no column ` +
        `(${keys.join(", ")}) -- a header with no reachable active key is how the sort silently lies`);
    const cells = columns.map(col => {
      const active = col.key === c.active;
      const arrow = SORT_SPRITE[col.sort === "asc" ? "asc" : "desc"];
      const token = active ? arrow.on : arrow.off;
      const classes = ["dwfui-sort-col"];
      if (active) classes.push("active");
      if (!col.label) classes.push("dwfui-sort-col--bare");
      const label = col.label
        ? `<span class="dwfui-sort-label">${bitmapTextHtml(col.label, { cls: "dwfui-sort-label-text" })}</span>`
        : "";
      return `<button type="button" class="${classes.join(" ")}" role="radio"` +
        ` aria-checked="${active ? "true" : "false"}" data-${attr}="${esc(col.key)}"` +
        `${datasetAttrs(col.dataset)}${col.title ? ` title="${esc(col.title)}"` : ""}` +
        `${col.disabled ? " disabled" : ""}>` +
        `${iconHtml({ sprite: token, nativeCell: true, alt: col.label || String(col.key) })}${label}</button>`;
    }).join("");
    return `<div class="dwfui-sort-head${c.cls ? " " + c.cls : ""}" role="radiogroup"` +
      `${datasetAttrs(c.dataset)}${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${cells}</div>`;
  }

  // A two-state art latch: the two states are two different sprites with their colour BAKED IN.
  // `hotkey` renders only if passed: NEVER fabricate a `Hotkey:` line.
  function latchHtml(cfg) {
    const c = cfg || {};
    const classes = ["dwfui-latch"];
    if (c.cls) classes.push(c.cls);
    if (c.on) classes.push("on");
    const token = c.on ? (c.activeSprite || c.sprite) : c.sprite;
    const selfFramed = isSelfFramedSprite(token);
    const title = c.hotkey ? `${c.title || ""}\nHotkey: ${c.hotkey}` : c.title;
    return `<button type="button" class="${classes.join(" ")}"${selfFramed ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : ""}` +
      `${datasetAttrs(c.dataset)}` +
      ` aria-pressed="${c.on ? "true" : "false"}"` +
      `${title ? ` title="${esc(title)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}${c.disabled ? " disabled" : ""}>` +
      `${iconHtml({ sprite: token, size: c.size, nativeCell: selfFramed, alt: c.ariaLabel || c.title })}</button>`;
  }

  // The selected segment carries the GOLD CORNER BRACKETS: native's selection affordance is brackets,
  // not a fill. Not a duplicate of switchHtml (a binary pill) nor of triState (a mark, not a control).
  function segmentedHtml(cfg) {
    const c = cfg || {};
    const attr = c.dataAttr || "dwfui-seg";
    const segs = (c.options || []).map(opt => {
      const on = opt.key === c.active;
      return `<button type="button" class="dwfui-seg${on ? " active" : ""}" role="radio"` +
        ` aria-checked="${on ? "true" : "false"}" data-${attr}="${esc(opt.key)}"` +
        `${opt.title ? ` title="${esc(opt.title)}"` : ""}${opt.disabled ? " disabled" : ""}>` +
        `${bitmapTextHtml(opt.label == null ? "" : opt.label, { cls: "dwfui-seg-label" })}</button>`;
    }).join("");
    return `<div class="dwfui-segmented${c.cls ? " " + c.cls : ""}" role="radiogroup"` +
      `${datasetAttrs(c.dataset)}${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${segs}</div>`;
  }

  // ---- selectCellHtml / selectCellGroupHtml ----------------------------------------------------
  function selectCellHtml(cfg, innerHtml) {
    const c = cfg || {};
    const classes = ["dwfui-selectcell"];
    if (c.cls) classes.push(c.cls);
    if (c.selected) classes.push("active");
    return `<div class="${classes.join(" ")}" role="radio" tabindex="0"` +
      ` aria-checked="${c.selected ? "true" : "false"}"${datasetAttrs(c.dataset)}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${innerHtml || ""}</div>`;
  }
  // Consumers may not hand-write role="radiogroup"; the group owns the layout, passed through `cls`.
  function selectCellGroupHtml(cfg, innerHtml) {
    const c = cfg || {};
    return `<div class="dwfui-selectcells${c.cls ? " " + c.cls : ""}" role="radiogroup"` +
      `${datasetAttrs(c.dataset)}${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `${innerHtml || ""}</div>`;
  }

  // ---- native tool tile ------------------------------------------------------------------------
  // One semantic button host for DFChrome-backed toolbar and placement icons; the sprite is injected later.
  function toolButtonHtml(cfg) {
    const c = cfg || {};
    const classes = ["tool-button"];
    if (c.cls) classes.push(c.cls);
    if (c.active) classes.push("active");
    const type = /^(?:button|submit|reset)$/.test(c.type || "") ? c.type : "button";
    const label = c.labelHtml != null ? c.labelHtml : bitmapTextHtml(c.label || "", { cls: "dwfui-tool-label" });
    return `<button type="${type}"${c.id ? ` id="${esc(c.id)}"` : ""} class="${classes.join(" ")}"` +
      `${datasetAttrs(c.dataset)}${c.title ? ` title="${esc(c.title)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}${c.disabled ? " disabled" : ""}` +
      `${c.hidden ? " hidden" : ""}>${label}</button>`;
  }

  // ---- ChevronTabs: the parchment tab row --------------------------------------------------------
  const TAB_LEVELS = { primary: 1, "primary-short": 1, subtab: 1, subsubtab: 1 };
  // Native's tab BOX is the caption plus 3 cells and successive boxes are separated by 1 cell, giving
  // a PITCH of caption + 4. One DF cell is 8px before interface scaling.
  const TAB_CELL_PX = 8;
  const TAB_BOX_CAPS_PX = TAB_CELL_PX * 3;
  const TAB_GAP_PX = TAB_CELL_PX;
  function tabsHtml(cfg) {
    const c = cfg || {};
    const level = c.level;
    if (!TAB_LEVELS[level])
      throw new Error("DWFUI.tabsHtml: `level` is REQUIRED and must be one of " +
        Object.keys(TAB_LEVELS).join(" | ") + " (got " + JSON.stringify(c.level) + "). " +
        "A tab row with no declared native grammar renders with no tab art and no DF font -- that is " +
        "a defect, not a default (F3). If this surface is genuinely not a native tab row, call " +
        "DWFUI.nonNativeTabsHtml({reason}) and say why.");
    const attr = c.dataAttr || "dwfui-tab";
    const activeCls = c.activeCls && c.activeCls !== "active" ? c.activeCls : null;
    const rowClasses = ["dwfui-tabs", `dwfui-tabs--${level}`];
    const cellGrid = c.cellGrid && Number(c.cellGrid.cols) > 0 && Number(c.cellGrid.rows) > 0
      ? { cols: Math.round(Number(c.cellGrid.cols)), rows: Math.round(Number(c.cellGrid.rows)) }
      : null;
    if (c.cls) rowClasses.push(c.cls);
    if (cellGrid) rowClasses.push("dwfui-tabs--cell-grid");
    if (c.wrap) rowClasses.push("dwfui-tabs--wrap");
    if (c.width === "fill" || c.width === "hug") rowClasses.push(`dwfui-tabs--${c.width}`);
    const buttons = (c.tabs || []).map(tab => {
      const active = tab.key === c.active;
      const classes = ["dwfui-tab", `dwfui-tab--${level}`];
      if (c.tabCls) classes.push(c.tabCls);
      if (active) classes.push("active");
      if (active && activeCls) classes.push(activeCls);
      const labelText = String(tab.label == null ? "" : tab.label);
      const label = c.fitLabels
        ? bitmapTextHtml(labelText, {
          cls: "dwfui-tab-label",
          fitNativeLabel: { host: "tab", reserveCells: TAB_BOX_CAPS_PX / TAB_CELL_PX },
        })
        : bitmapTextHtml(labelText, { cls: "dwfui-tab-label" });
      // Reserve the exact per-cell label width plus both caps before flex wrapping decides the row:
      // the bitmap label is painted after layout, so its canvas contributes no intrinsic width.
      const nativeWidth = TAB_BOX_CAPS_PX + (Array.from(labelText).length * TAB_CELL_PX);
      // A disabled tab keeps its SHAPE: native still draws the frame and leaves the tab-shaped hole,
      // it only stops drawing the caption. Dimming the whole control is a different silhouette.
      const disabledCls = tab.disabled ? " dwfui-tab--disabled" : "";
      const cellStyle = cellGrid
        ? `;grid-column:${Math.round(Number(tab.x)) + 1} / span ${Math.round(Number(tab.w))}` +
          `;grid-row:${Math.round(Number(tab.y)) + 1} / span ${Math.round(Number(tab.h))}` +
          `;--dwfui-tab-native-width:${Math.round(Number(tab.w)) * TAB_CELL_PX}px`
        : "";
      return `<button class="${classes.join(" ")}${disabledCls}" role="tab" aria-selected="${active}"` +
        ` data-${attr}="${esc(tab.key)}"${tab.title ? ` title="${esc(tab.title)}"` : ""}` +
        ` style="--dwfui-tab-native-width:${nativeWidth}px${cellStyle}"` +
        `${tab.disabled ? " disabled aria-disabled=\"true\"" : ""}>${label}${tab.suffixHtml || ""}</button>`;
    }).join("");
    // WRAPPING AND PROMOTION ARE SEPARATE QUESTIONS: promotion belongs to DF's GENERIC tab widget, and
    // a hardcoded per-index strip still wraps but never reorders. `promote: false` opts out of the swap.
    const promote = !cellGrid && c.wrap && c.promote !== false;
    // THE PITCH IS NOT ONE RULE FOR EVERY STRIP: the unit sheet's eleven tabs measure at caption+3 with
    // NO gap, so the gap is a declared property of the strip. The default keeps the generic pitch.
    const gapPx = c.gapCells == null ? TAB_GAP_PX : Math.max(0, Number(c.gapCells)) * TAB_CELL_PX;
    const gridStyle = cellGrid
      ? `;--dwfui-tab-grid-cols:${cellGrid.cols};--dwfui-tab-grid-rows:${cellGrid.rows}`
      : "";
    return `<div class="${rowClasses.join(" ")}" role="tablist"${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}` +
      ` style="--dwfui-tab-gap:${gapPx}px${gridStyle}"${promote ? " data-dwfui-tab-promote" : ""}>${buttons}</div>`;
  }

  // When tabs wrap, the selected tab's row moves next to the content. We reproduce native's packing
  // rather than reading flex-wrap, because flex-wrap does not report WHICH row a tab landed on.
  function packTabRows(widths, containerWidth, gap) {
    const list = (widths || []).map(w => Number(w) || 0);
    const limit = Number(containerWidth) || 0;
    const g = Number(gap) || 0;
    const rows = [];
    let row = [], used = 0;
    list.forEach((w, i) => {
      const advance = row.length ? g + w : w;
      if (row.length && used + advance > limit) { rows.push(row); row = []; used = 0; }
      row.push(i);
      used += row.length === 1 ? w : g + w;
    });
    if (row.length) rows.push(row);
    return rows;
  }
  // Native draws row zero NEAREST the content. Our strips sit ABOVE their content, so "nearest" is
  // the LAST row in document order -- the one non-mechanical decision here, stated rather than hidden.
  function promoteSelectedTabRow(rows, selectedIndex) {
    const list = (rows || []).map(r => [...r]);
    const at = list.findIndex(r => r.indexOf(selectedIndex) >= 0);
    if (at < 0 || at === list.length - 1) return list;
    const [selected] = list.splice(at, 1);
    list.push(selected);
    return list;
  }
  function mountTabPromotion(rootNode) {
    const host = rootNode || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelectorAll) return 0;
    let n = 0;
    host.querySelectorAll("[data-dwfui-tab-promote]").forEach(strip => {
      const tabs = [...strip.querySelectorAll(".dwfui-tab")];
      if (tabs.length < 2) return;
      const selected = tabs.findIndex(t => t.getAttribute("aria-selected") === "true");
      if (selected < 0) return;
      const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
      const widths = tabs.map(t => t.getBoundingClientRect().width);
      const rows = packTabRows(widths, strip.clientWidth, gap);
      if (rows.length < 2) return;               // one row: nothing to promote, leave it alone
      const order = promoteSelectedTabRow(rows, selected);
      // Re-order the actual DOM children rather than using CSS `order`, so flex-wrap packs the tabs in
      // the sequence we just packed them in and the reading order matches the screen.
      order.flat().forEach(i => strip.appendChild(tabs[i]));
      n++;
    });
    return n;
  }
  // Tab-key cycling is DELIBERATELY NOT IMPLEMENTED: the decoded backward step is pointer arithmetic
  // a decompiler can read wrong, and both copying it and "fixing" it would be blind guesses.

  // The declared, justified opt-out: `reason` is REQUIRED and this throws without one, so a surface
  // can never opt out of the native tab grammar silently.
  function nonNativeTabsHtml(cfg) {
    const c = cfg || {};
    if (!c.reason || typeof c.reason !== "string")
      throw new Error("DWFUI.nonNativeTabsHtml: `reason` is REQUIRED -- state the evidence that this " +
        "surface is not a native DF tab row. If it IS one, call tabsHtml({level}) instead.");
    const tabCls = withBaseClass("dwfui-nntab", c.tabCls);
    const activeCls = c.activeCls || "active";
    const attr = c.dataAttr || "nntab";
    const buttons = (c.tabs || []).map(tab => {
      const active = tab.key === c.active;
      const classes = [tabCls];
      if (active) classes.push(activeCls);
      return `<button class="${classes.join(" ")}" role="tab" aria-selected="${active}"` +
        ` data-${attr}="${esc(tab.key)}"${tab.title ? ` title="${esc(tab.title)}"` : ""}` +
        `${tab.disabled ? " disabled" : ""}>${esc(tab.label)}${tab.suffixHtml || ""}</button>`;
    }).join("");
    return `<div class="${withBaseClass("dwfui-nntabs", c.cls)}" role="tablist" data-non-native-tabs="${esc(c.reason)}"` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${buttons}</div>`;
  }

  // ---- NativeCycler -------------------------------------------------------------------------------
  function cyclerHtml(cfg) {
    const c = cfg || {};
    const slice = (token, part, action) => `<button type="button" class="dwfui-cycler-slice dwfui-cycler-${part}"` +
      `${datasetAttrs(action?.dataset)} title="${esc(action?.title || (part === "previous" ? "Previous" : "Next"))}"` +
      ` aria-label="${esc(action?.ariaLabel || action?.title || (part === "previous" ? "Previous" : "Next"))}">` +
      `${iconHtml({ sprite: token, nativeCell: true, alt: "" })}</button>`;
    const middle = `<span class="dwfui-cycler-middle" data-dwfui-cycler-mid="TYPE_FILTER_TEXT">` +
      `${bitmapTextHtml(c.label || "", { cls: "dwfui-cycler-label" })}</span>`;
    return `<div class="dwfui-cycler${c.cls ? " " + c.cls : ""}" role="group"` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `${slice("TYPE_FILTER_LEFT", "previous", c.previous)}${middle}` +
      `${slice("TYPE_FILTER_RIGHT", "next", c.next)}</div>`;
  }

  // Each entry is exactly three interface rows tall, with a five-column art well and one truncated
  // name line. Browser-only destinations may ride this surface but must identify themselves.
  function occupantListHtml(cfg) {
    const c = cfg || {};
    const attr = c.dataAttr || "occupant-entry";
    const rows = (c.entries || []).map((entry, index) => {
      const key = entry.key == null ? String(index) : String(entry.key);
      const extension = entry.extension === true;
      const note = extension
        ? bitmapTextHtml(entry.extensionLabel || "Extra browser destination", { cls: "dwfui-occupant-list-extension" })
        : "";
      return `<button type="button" class="dwfui-occupant-list-entry${extension ? " is-extension" : ""}"` +
        ` role="listitem" data-${attr}="${esc(key)}" title="${esc(entry.name || "Open entry")}"` +
        ` aria-label="${esc(entry.name || "Open entry")}">` +
        `<span class="dwfui-occupant-list-icon">${entry.iconHtml || iconHtml({ emptyTile: true })}</span>` +
        `<span class="dwfui-occupant-list-copy">${bitmapTextHtml(entry.name || "Unnamed", { cls: "dwfui-occupant-list-name" })}${note}</span>` +
        `</button>`;
    }).join("");
    return `<section class="dwfui-occupant-list${c.cls ? " " + c.cls : ""}"` +
      ` aria-label="${esc(c.ariaLabel || "Occupants on this tile")}">` +
      scrollHtml({ cls: "dwfui-occupant-list-scroll", rows: ".dwfui-occupant-list-entry",
        preserveKey: c.preserveKey || "tile-occupants", ariaLabel: c.ariaLabel || "Occupants on this tile",
        dataset: { occupantListScroll: "" } }, rows) + `</section>`;
  }

  // A compact icon-only strip on the OUTSIDE right edge of an information frame -- deliberately
  // separate from the horizontal text-tab grammar above.
  function occupantRailHtml(cfg) {
    const c = cfg || {};
    const attr = c.dataAttr || "occupant-tab";
    const buttons = (c.tabs || []).map(tab => {
      const active = tab.key === c.active;
      return `<button type="button" class="dwfui-occupant-tab${active ? " active" : ""}"` +
        ` role="tab" aria-selected="${active}" data-${attr}="${esc(tab.key)}"` +
        ` title="${esc(tab.title || "Open occupant")}" aria-label="${esc(tab.title || "Open occupant")}">` +
        `${tab.iconHtml || iconHtml({ emptyTile: true, cls: "dwfui-occupant-icon" })}</button>`;
    }).join("");
    return `<div class="dwfui-occupant-rail${c.cls ? " " + c.cls : ""}" role="tablist"` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${buttons}</div>`;
  }

  // Editable copy cannot use the bitmap canvas: the browser must own selection, caret, IME and entry.
  // The field grammar still belongs here so consumers do not invent their own borders and fallbacks.
  function textInputHtml(cfg) {
    const c = cfg || {};
    const classes = ["dwfui-text-input", c.cls || ""].filter(Boolean).join(" ");
    const value = c.value == null ? "" : ` value="${esc(c.value)}"`;
    const placeholder = c.placeholder == null ? "" : ` placeholder="${esc(c.placeholder)}"`;
    const maxLength = Number.isFinite(Number(c.maxLength))
      ? ` maxlength="${Math.max(0, Math.floor(Number(c.maxLength)))}"` : "";
    const type = c.type === "password" ? "password" : "text";
    return `<input type="${type}" class="${classes}"${c.id ? ` id="${esc(c.id)}"` : ""}${value}${placeholder}${maxLength}` +
      `${datasetAttrs(c.dataset)}${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}` +
      `${c.autocomplete != null ? ` autocomplete="${esc(c.autocomplete)}"` : ""}` +
      `${c.spellcheck != null ? ` spellcheck="${c.spellcheck ? "true" : "false"}"` : ""}` +
      `${c.disabled ? " disabled" : ""}${c.readOnly ? " readonly" : ""}>`;
  }

  // A caller class is ADDED to a builder's base class, never swapped for it: the component rules always apply.
  function withBaseClass(base, extra) {
    return [base, ...String(extra || "").split(/\s+/).filter(cls => cls && cls !== base)].join(" ");
  }

  // ---- NativeSearch -------------------------------------------------------------------------------
  function searchHtml(cfg) {
    const c = cfg || {};
    const maxLength = Number.isFinite(Number(c.maxLength)) && Number(c.maxLength) > 0
      ? ` maxlength="${Math.floor(Number(c.maxLength))}"` : "";
    const input = `<input class="${withBaseClass("dwfui-search-input", c.inputCls)}"${c.id ? ` id="${esc(c.id)}"` : ""}` +
      ` type="${c.type || "text"}"${c.dataAttr ? ` data-${c.dataAttr}` : ""}` +
      `${c.preserveKey ? ` data-dwfui-search-key="${esc(c.preserveKey)}"` : ""}` +
      ` value="${esc(c.value || "")}" placeholder="${esc(c.placeholder || "")}"${maxLength}` +
      ` autocomplete="off" spellcheck="false"${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>`;
    const classes = ["dwfui-search"];
    if (c.cls) classes.push(c.cls);
    if (c.placement === "footer" || c.placement === "pane-header")
      classes.push(`dwfui-search--${c.placement}`);
    // `magnifier` stays OPT-IN: defaulting it on would inject a new button into the surfaces that pass
    // neither flag and disturb their grids.
    const mag = c.magnifier
      ? `<button type="button" class="${withBaseClass("dwfui-search-btn", c.buttonCls)}" data-dwfui-native-art="true" data-dwfui-self-framed="true" tabindex="-1"` +
        ` aria-label="Search">${iconHtml({ spriteCrop: "filterButton", alt: "Search" })}</button>`
      : "";
    const empty = c.emptyHtml ? `<div class="dwfui-search-empty">${c.emptyHtml}</div>` : "";
    return `<div class="${classes.join(" ")}">${input}${mag}${empty}</div>`;
  }

  // ---- FillScroll ----------------------------------------------------------------------------------
  function scrollHtml(cfg, innerHtml) {
    const c = cfg || {};
    const cls = `dwfui-scroll${c.cls ? " " + c.cls : ""}`;
    return `<div class="${cls}"${c.id ? ` id="${esc(c.id)}"` : ""}${datasetAttrs(c.dataset)}` +
      `${c.preserveKey ? ` data-dwfui-scroll-key="${esc(c.preserveKey)}"` : ""}` +
      `${c.rows ? ` data-dwfui-rows="${esc(c.rows)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${innerHtml || ""}</div>`;
  }

  // ---- Whole rows ------------------------------------------------------------------------------------
  // Shared by the row quantiser (a browser-scrolled box) and the list control (a positioned one).

  // getBoundingClientRect reports pixels AFTER an ancestor transform; offsetHeight is the same box in
  // layout pixels, so their ratio converts back.
  function _layoutScale(el) {
    const layout = el.offsetHeight;
    if (!layout) return 1;
    const scale = el.getBoundingClientRect().height / layout;
    return (isFinite(scale) && scale > 0.01) ? scale : 1;
  }

  // The rendered rows, so a row hidden by a filter is not an item.
  function _boxRows(box) {
    const selector = box.getAttribute("data-dwfui-rows");
    return selector ? [...box.querySelectorAll(selector)].filter(row => row.getClientRects().length) : [];
  }

  // Each row's top and bottom in the box's scrolled content, in layout pixels from the padding edge. A
  // row's bottom margin is part of it, or the end of the scroll range would stop inside that margin.
  function _rowExtents(box, rows) {
    const scale = _layoutScale(box);
    const origin = box.getBoundingClientRect().top + box.clientTop * scale;
    const at = y => (y - origin) / scale + box.scrollTop;
    const rects = rows.map(row => row.getBoundingClientRect());
    return { tops: rects.map(r => at(r.top)),
      bottoms: rects.map((r, i) => at(r.bottom) + (parseFloat(getComputedStyle(rows[i]).marginBottom) || 0)) };
  }

  // A row's pitch runs to the next row's top, so any gap belongs to the row above it.
  const _rowPitches = (tops, end) => tops.map((top, i) => (i + 1 < tops.length ? tops[i + 1] : end) - top);
  // How many rows the fullest last page holds: admission run backwards from `end`.
  function _lastPageSize(tops, end, available) {
    return admitRows(available, _rowPitches(tops, end).reverse(), 0);
  }

  // The browser stops scrolling where the content ends, which starts the last page mid-row whenever the
  // rows do not divide the box. A tail spacer (`.dwfui-scroll--tail`) makes `scrollTop` reachable.
  function _padTail(box, scrollTop) {
    const set = tail => {
      box.__dwfuiTail = tail;
      box.style.setProperty("--dwfui-scroll-tail", `${tail}px`);
      box.classList.toggle("dwfui-scroll--tail", tail > 0);
    };
    let tail = box.__dwfuiTail || 0;
    if (!(scrollTop > 0)) { if (tail) set(0); return; }
    // Corrected against the real reach, twice: a new spacer in a flex or grid box also brings a gap.
    for (let pass = 0; pass < 2; pass++) {
      const next = Math.max(0, tail + Math.ceil(scrollTop - (box.scrollHeight - box.clientHeight)));
      if (next === tail) break;
      set(tail = next);
    }
  }

  // A plain `.dwfui-scroll[data-dwfui-rows]` box: floored to whole rows, snapped to row starts in CSS,
  // and given a tail so its last page starts on a row too.
  function _quantiseRowScroll(box) {
    // A saved position is restored before the tail exists, so the browser clamps it: re-apply it after.
    const key = box.getAttribute("data-dwfui-scroll-key");
    const saved = key != null ? _scrollPos[key] : null;
    // Release last pass's cap first, or the box could only ever shrink.
    box.style.maxHeight = "";
    const rows = _boxRows(box);
    rows.forEach(row => row.classList.add("dwfui-row-snap"));
    if (!rows.length || !box.clientHeight) return false;
    let { tops, bottoms } = _rowExtents(box, rows);
    const overflow = bottoms[bottoms.length - 1] > box.clientHeight + 0.5;
    // Capping switches the scrollbar on, which narrows the rows and can re-wrap them taller: re-admit
    // against the settled height.
    for (let attempt = 0; overflow && attempt < 3; attempt++) {
      const available = box.clientHeight;
      const admitted = bottoms.filter(bottom => bottom <= available + 0.5).pop() || 0;
      if (admitted <= 0) break;                   // not even one row fits: leave the box alone
      // A horizontal scrollbar takes its height out of the box: add it back rather than drop a row.
      const cs = getComputedStyle(box);
      const borders = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      const hbar = Math.max(0, box.offsetHeight - box.clientHeight - borders);
      // max-height sizes the content box unless border-box: padding is inside `admitted`, borders are not.
      const frame = cs.boxSizing === "border-box" ? borders
        : -((parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0));
      box.style.maxHeight = Math.round(admitted + hbar + frame) + "px";
      ({ tops, bottoms } = _rowExtents(box, rows));
      if (box.clientHeight >= Math.round(admitted) - 0.5) break;
    }
    const lastPage = _lastPageSize(tops, bottoms[bottoms.length - 1], box.clientHeight);
    _padTail(box, overflow ? tops[rows.length - lastPage] : 0);
    if (saved != null && box.scrollTop < saved) box.scrollTop = saved;
    return true;
  }

  // Column widths are negotiated from content, never hand-picked: the widest cell sets the column.
  // Missing cells (a short row) contribute nothing rather than counting as zero width.
  function negotiateColumns(rowWidths, minimums) {
    const rows = Array.isArray(rowWidths) ? rowWidths : [];
    const mins = Array.isArray(minimums) ? minimums : [];
    const count = rows.reduce((n, row) => Math.max(n, (row || []).length), mins.length);
    const out = [];
    for (let col = 0; col < count; col++) {
      let widest = Number(mins[col]) || 0;
      for (const row of rows) {
        const cell = (row || [])[col];
        if (cell == null) continue;
        widest = Math.max(widest, Number(cell) || 0);
      }
      out.push(Math.ceil(widest));
    }
    return out;
  }
  // Every track is its measured width. `flexColumn` may grow past it; `yieldColumn` may shrink below it,
  // so a narrow pane squeezes that one track instead of pushing the others out of sight.
  function columnTemplate(widths, flexColumn, yieldColumn) {
    return (widths || []).map((w, i) =>
      i === flexColumn ? `minmax(${w}px, 1fr)` : i === yieldColumn ? `minmax(0, ${w}px)` : `${w}px`).join(" ");
  }
  // scrollWidth, not getBoundingClientRect().width: it reports the width the content WANTS even while
  // the cell is clipping it, which is precisely the state being detected. `data-dwfui-table-head` names a
  // sibling header (outside the scroll) that takes the same template, so its cells stay over their columns.
  function mountTableColumns(rootNode) {
    const host = rootNode || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelectorAll) return 0;
    let n = 0;
    host.querySelectorAll("[data-dwfui-table]").forEach(table => {
      const rowSel = table.getAttribute("data-dwfui-table");
      const rows = [...table.querySelectorAll(rowSel)];
      if (!rows.length) return;
      const measured = rows.map(row => [...row.children].map(cell => cell.scrollWidth));
      const template = columnTemplate(negotiateColumns(measured),
        parseInt(table.getAttribute("data-dwfui-table-flex"), 10),
        parseInt(table.getAttribute("data-dwfui-table-yield"), 10));
      if (!template) return;
      // Written to BOTH the table and each row, because a "table" here is sometimes one grid with
      // display:contents rows and sometimes a stack of per-row grids.
      const headSel = table.getAttribute("data-dwfui-table-head");
      const head = headSel && table.parentElement ? table.parentElement.querySelector(headSel) : null;
      [table, ...rows, head].forEach(el => { if (el) el.style.gridTemplateColumns = template; });
      n++;
    });
    return n;
  }

  function mountRowScroll(rootNode) {
    const host = rootNode || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelectorAll) return 0;
    let n = 0;
    host.querySelectorAll("[data-dwfui-rows]").forEach(container => {
      // A viewport inside a list host belongs to the list control, which owns admission, position and
      // bar. Capping here as well would be two controls arguing over one box.
      if (container.closest && container.closest("[data-dwfui-list]")) return;
      if (_quantiseRowScroll(container)) n++;
      // Re-measure when the box resizes and when its rows change (added rows, labels painting in),
      // at most once per frame.
      if (!container.__dwfuiRowsBound && typeof ResizeObserver === "function") {
        container.__dwfuiRowsBound = true;
        let scheduled = false;
        const again = () => {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(() => { scheduled = false; _quantiseRowScroll(container); });
        };
        const observer = new ResizeObserver(again);
        observer.observe(container);
        if (container.parentElement) observer.observe(container.parentElement);
        if (typeof MutationObserver === "function")
          new MutationObserver(again).observe(container, { childList: true, subtree: true });
      }
    });
    return n;
  }


  // ---- List control ----------------------------------------------------------------------------------
  // UI-DIV-015: the last page is full, where native under-fills it; list_primitive_test.mjs pins that.

  // Eight sprite bands, in paint order down the bar. `thumbCentre` carries the band's two FORMS --
  // one centred row on an odd thumb, two off-centre rows on an even one.
  const LIST_BANDS = ["up", "track", "down", "thumbSmall", "thumbTop", "thumbCentre", "thumbBlank",
    "thumbBottom"];
  // The four interface keys the control reads, and NOTHING else: arrows move a screen's SELECTION,
  // not its scrollbar, so `listKeyScroll` returns null for them.
  const LIST_KEYS = { scrollUp: -1, scrollDown: 1, pageUp: "page-", pageDown: "page+" };

  const _lInt = (v, fallback) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? n : fallback;
  };
  const _lClamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
  // C truncation toward zero, like the grid authority's. Every `/` 0089 marks INTEGER goes here.
  const _lIdiv = (a, b) => (b ? Math.trunc(a / b) : 0);

  // Native's `used + row_height < available` refuses a row that fits EXACTLY; ours admits it (`<=`).
  // `from` is the first row considered, because admission starts at the scroll position, not at zero.
  function admitRows(availablePx, rowHeights, from) {
    const heights = Array.isArray(rowHeights) ? rowHeights : [];
    const start = Math.max(0, _lInt(from, 0));
    const available = Number(availablePx) || 0;
    let used = 0, admitted = 0;
    for (let i = start; i < heights.length; i++) {
      const h = Number(heights[i]) || 0;
      if (used + h > available + 0.5) break;    // native's `<`; ours `<=`, so a snug row is drawn
      used += h;
      admitted++;
    }
    // A box too short for even one row still shows one: a zero page size would divide by zero pages.
    return Math.max(1, admitted);
  }

  // Pure -- no DOM, no units, no pixels: track bounds are ROWS of the bar and position/highestIndex/
  // pageSize are in whatever unit the caller chose. That is what makes this ONE control.
  function listGeometry(state) {
    const s = state || {};
    const min = _lInt(s.min, 0);
    const highestIndex = Math.max(min - 1, _lInt(s.highestIndex, min - 1));
    const pageSize = Math.max(1, _lInt(s.pageSize, 1));
    // Rows held by the LAST page; differs from `pageSize` only when row heights do.
    const lastPageSize = Math.max(1, _lInt(s.lastPageSize, pageSize));
    const trackTop = _lInt(s.trackTop, 0);
    const trackBottom = Math.max(trackTop, _lInt(s.trackBottom, trackTop));
    const totalItems = Math.max(1, highestIndex - min + 1);
    // *** THE IDENTITY. *** Everything else in this file is a consequence of this line.
    const bottomMost = Math.max(min, highestIndex - lastPageSize + 1);
    const position = _lClamp(_lInt(s.position, min), min, bottomMost);
    const trackLength = trackBottom - trackTop + 1;
    // The bar exists IFF the admitted rows are fewer than the eligible rows. When it does not
    // exist the container processes NO scroll input at all -- not "input that does nothing".
    const overflow = pageSize < totalItems;

    // page_size MINUS ONE is not a rounding fudge: it makes the thumb one item shorter than the
    // proportional length, which is why native's thumb looks a little small on short lists.
    let thumbLength = Math.max(1, _lIdiv((pageSize - 1) * trackLength, totalItems));
    thumbLength = Math.min(thumbLength, trackLength);
    let thumbTop = trackTop + _lIdiv(trackLength * (position - min), totalItems);
    if (position <= min) thumbTop = trackTop;                              // snap to the track top
    else if (position >= bottomMost) thumbTop = trackBottom - thumbLength + 1;  // snap to the bottom
    else {
      // Push one row off either end it touches, so a mid-list position never LOOKS like an end one --
      // it is the only way a player can tell "near the top" from "at the top".
      if (thumbTop <= trackTop) thumbTop = trackTop + 1;
      if (thumbTop + thumbLength - 1 >= trackBottom) thumbTop = trackBottom - thumbLength;
    }
    thumbTop = _lClamp(thumbTop, trackTop, Math.max(trackTop, trackBottom - thumbLength + 1));
    let thumbBottom = thumbTop + thumbLength - 1;
    // Grow a collapsed one-row thumb to two, so it is always grabbable.
    if (thumbBottom === thumbTop && trackLength >= 2) {
      thumbBottom = thumbTop + 1;
      if (thumbBottom > trackBottom) { thumbBottom = trackBottom; thumbTop = trackBottom - 1; }
    }
    return { min, position, highestIndex, pageSize, totalItems, bottomMost, trackTop, trackBottom,
      trackLength, thumbTop, thumbBottom, thumbLength: thumbBottom - thumbTop + 1, overflow };
  }

  // The bar runs one row OUTSIDE the track at each end. THE HOVER RULE: the thumb shows its hover
  // form on a drag or anywhere in the two bar columns -- hovering the TRACK lights the THUMB.
  function listBands(geom, hover) {
    const h = hover || {};
    const thumbHover = !!(h.drag || h.track);
    const out = [{ row: geom.trackTop - 1, band: "up", hover: !!h.up }];
    const len = geom.thumbLength;
    for (let row = geom.trackTop; row <= geom.trackBottom; row++) {
      if (!geom.overflow || row < geom.thumbTop || row > geom.thumbBottom) {
        out.push({ row, band: "track", hover: false });
        continue;
      }
      const i = row - geom.thumbTop;
      // A 1-2 row thumb draws as a single 2x2 SMALL block: that art is two rows for one band.
      if (len <= 2) { out.push({ row, band: "thumbSmall", form: "small", span: len, index: i, hover: thumbHover }); continue; }
      // The centre/off-centre test is evaluated BEFORE the top/bottom test. It only changes the answer
      // on a degenerate thumb, and getting the order wrong is unfindable later.
      const odd = len % 2 === 1;
      if (odd && i === (len - 1) / 2) { out.push({ row, band: "thumbCentre", form: "centre", hover: thumbHover }); continue; }
      if (!odd && (i === len / 2 - 1 || i === len / 2)) {
        out.push({ row, band: "thumbCentre", form: "offcentre", span: 2, index: i === len / 2 - 1 ? 0 : 1, hover: thumbHover });
        continue;
      }
      if (i === 0) { out.push({ row, band: "thumbTop", hover: thumbHover }); continue; }
      if (i === len - 1) { out.push({ row, band: "thumbBottom", hover: thumbHover }); continue; }
      out.push({ row, band: "thumbBlank", hover: thumbHover });
    }
    out.push({ row: geom.trackBottom + 1, band: "down", hover: !!h.down });
    return out;
  }

  // Mouse press by pointer ROW. `drag` DOES NOT MOVE THE LIST: it begins a drag and leaves the
  // position alone. The press also CONSUMES the left button, which is why the DOM half preventDefaults.
  function listPress(geom, row) {
    const r = _lInt(row, 0);
    const to = p => _lClamp(p, geom.min, geom.bottomMost);
    if (r === geom.trackTop - 1) return { action: "up", position: to(geom.position - 1) };
    if (r === geom.trackBottom + 1) return { action: "down", position: to(geom.position + 1) };
    if (r < geom.trackTop || r > geom.trackBottom) return { action: "none", position: geom.position };
    if (r >= geom.thumbTop && r <= geom.thumbBottom) return { action: "drag", position: geom.position };
    if (r < geom.thumbTop) return { action: "pageUp", position: to(geom.position - geom.pageSize) };
    return { action: "pageDown", position: to(geom.position + geom.pageSize) };
  }

  // THERE IS NO GRAB OFFSET: the thumb jumps to the pointer. The numerator is read as the range of
  // legal POSITIONS, which makes the track end reachable; both readings agree at the extremes.
  function listDragPosition(geom, row) {
    const r = _lInt(row, geom.trackTop);
    if (r <= geom.trackTop) return geom.min;
    if (r >= geom.trackBottom) return geom.bottomMost;
    const range = geom.bottomMost - geom.min;
    return _lClamp(geom.min + _lIdiv(range * (r - geom.trackTop), geom.trackLength),
      geom.min, geom.bottomMost);
  }

  // The plain wheel is one unit per notch, modifier-1 is a page. The DOM half delivers it only while
  // the pointer is inside the OWNING CONTAINER's rect -- that is the whole of context scrolling.
  function listWheel(geom, notches, modifier) {
    const step = modifier ? geom.pageSize : 1;
    return _lClamp(geom.position + _lInt(notches, 0) * step, geom.min, geom.bottomMost);
  }

  // Exactly four keys, and a handled key is ERASED. Anything else returns null and falls through.
  function listKeyScroll(geom, key) {
    const k = String(key || "");
    if (!Object.prototype.hasOwnProperty.call(LIST_KEYS, k)) return null;
    const delta = k === "scrollUp" ? -1 : k === "scrollDown" ? 1
      : k === "pageUp" ? -geom.pageSize : geom.pageSize;
    return _lClamp(geom.position + delta, geom.min, geom.bottomMost);
  }

  // Until mountLists marks the host mounted, the viewport is a plain scrolling div (a working fallback).
  // `headHtml` (a sort header) sits above the viewport, over the rows' own width, and never scrolls.
  function listHtml(cfg, innerHtml) {
    const c = cfg || {};
    const unit = c.unit == null ? "entries" : String(c.unit);
    if (unit !== "entries" && unit !== "rows")
      throw new Error("DWFUI.listHtml: `unit` is 'entries' (whole entries) or 'rows' (grid rows).");
    if (unit === "rows" && !(Number(c.pageRows) > 0))
      throw new Error("DWFUI.listHtml: unit:'rows' needs `pageRows`, the caller's page size in grid rows.");
    const view = scrollHtml({ cls: c.cls, id: c.id, rows: c.rows, preserveKey: c.preserveKey,
      ariaLabel: c.ariaLabel, dataset: c.dataset }, innerHtml || "");
    return `<div class="dwfui-list${c.hostCls ? " " + c.hostCls : ""}" data-dwfui-list="${unit}"` +
      `${c.key ? ` data-dwfui-list-key="${esc(c.key)}"` : ""}` +
      `${unit === "rows" ? ` data-dwfui-list-page-rows="${Math.max(1, _lInt(c.pageRows, 1))}"` : ""}>` +
      (c.headHtml ? `<div class="dwfui-list-head">${c.headHtml}</div>` : "") +
      view +
      `<div class="dwfui-list-bar" data-dwfui-list-bar aria-hidden="true"></div></div>`;
  }

  // Positions survive a re-render, keyed by `data-dwfui-list-key`. NOTE THE ASYMMETRY: a filter change
  // does not itself reset scroll -- it resets incidentally, and only if the list became shorter.
  const _listPositions = {};

  function _listCell(axis) {
    const grid = root && root.DwfGrid;
    // The grid authority is the ONE source of cell size; the fallbacks are for a headless call only.
    if (grid && typeof grid.cellW === "function")
      return axis === "y" ? grid.cellH() : grid.cellW();
    return axis === "y" ? 12 : 8;
  }
  function _listState(host) {
    if (!host.__dwfuiList) host.__dwfuiList = { position: 0, hover: {}, drag: false };
    const key = host.getAttribute("data-dwfui-list-key");
    if (key && Object.prototype.hasOwnProperty.call(_listPositions, key))
      host.__dwfuiList.position = _listPositions[key];
    return host.__dwfuiList;
  }
  function _listStore(host, position) {
    host.__dwfuiList.position = position;
    const key = host.getAttribute("data-dwfui-list-key");
    if (key) _listPositions[key] = position;
  }

  function announceActionFits(viewTop, viewBottom, actionTop, actionBottom) {
    return actionTop >= viewTop && actionBottom <= viewBottom;
  }

  function _admitAnnouncementActions(view) {
    if (!view || !view.querySelectorAll || !view.getBoundingClientRect) return;
    const viewport = view.getBoundingClientRect();
    view.querySelectorAll(".dwfui-announce-actions").forEach(action => {
      const rect = action.getBoundingClientRect();
      action.toggleAttribute("data-dwfui-action-clipped",
        !announceActionFits(viewport.top, viewport.bottom, rect.top, rect.bottom));
    });
  }

  // Measure, run the law, paint the bar, apply the scroll. Idempotent and cheap enough for a ResizeObserver.
  function _listArrange(host) {
    const view = host.querySelector(".dwfui-scroll");
    const bar = host.querySelector("[data-dwfui-list-bar]");
    if (!view || !bar) return null;
    const state = _listState(host);
    const cellH = _listCell("y");
    const available = view.clientHeight;
    if (!available || !cellH) return null;
    const rows = _boxRows(view);
    const { tops, bottoms } = _rowExtents(view, rows);
    const end = rows.length ? bottoms[rows.length - 1] : view.scrollHeight;

    // Entries mode: a page step moves by what the CURRENT page holds, while the bottom-most position is
    // the first row of a full LAST page; the two differ only when row heights do.
    let highestIndex, pageSize, lastPageSize, scrollTopOf;
    if (host.getAttribute("data-dwfui-list") === "rows") {
      pageSize = Math.max(1, _lInt(host.getAttribute("data-dwfui-list-page-rows"), 1));
      highestIndex = Math.max(0, Math.ceil(end / cellH) - 1);
      scrollTopOf = position => position * cellH;
    } else {
      highestIndex = rows.length - 1;
      scrollTopOf = position => tops[position] || 0;
      // The ONE clamp that fires: an index at or past the end of the eligible list resets to 0.
      if (state.position > highestIndex) _listStore(host, 0);
      lastPageSize = _lastPageSize(tops, end, available);
      const from = Math.min(state.position, Math.max(0, highestIndex - lastPageSize + 1));
      pageSize = admitRows(available, _rowPitches(tops, end), from);
    }

    // The caps sit ONE ROW OUTSIDE the track at each end, so a bar `n` rows tall has a track of `n - 2`.
    const barRows = Math.max(3, Math.floor(available / cellH));
    const geom = listGeometry({ position: state.position, min: 0, highestIndex, pageSize, lastPageSize,
      trackTop: 1, trackBottom: barRows - 2 });
    _listStore(host, geom.position);
    host.classList.toggle("dwfui-list--overflow", geom.overflow);
    _listPaintBar(bar, geom, state.hover, cellH);
    _padTail(view, geom.overflow ? scrollTopOf(geom.bottomMost) : 0);
    view.scrollTop = geom.overflow ? scrollTopOf(geom.position) : 0;
    // Native draws only the rows that fit whole; the row at the position is drawn even if it cannot.
    if (host.getAttribute("data-dwfui-list") !== "rows") {
      const pageTop = view.scrollTop, pageBottom = pageTop + available + 0.5;
      rows.forEach((row, i) => row.toggleAttribute("data-dwfui-list-unshown", i !== geom.position &&
        (tops[i] < pageTop - 0.5 || bottoms[i] > pageBottom)));
    }
    _admitAnnouncementActions(view);
    _listAlignHead(host, view);
    host.__dwfuiListGeom = geom;
    return geom;
  }

  // A head over a grid viewport takes the viewport's resolved tracks, gap and inset.
  function _listAlignHead(host, view) {
    const cs = host.querySelector(":scope > .dwfui-list-head") ? getComputedStyle(view) : null;
    const grid = !!cs && cs.display === "grid";
    host.classList.toggle("dwfui-list--columns", grid);
    if (!grid) return;
    const inset = side => `${(parseFloat(cs[`border${side}Width`]) || 0) + (parseFloat(cs[`padding${side}`]) || 0)}px`;
    host.style.setProperty("--dwfui-list-columns", cs.gridTemplateColumns);
    host.style.setProperty("--dwfui-list-column-gap", cs.columnGap);
    host.style.setProperty("--dwfui-list-inset", `${inset("Left")} ${inset("Right")}`);
  }

  function _listPaintBar(bar, geom, hover, cellH) {
    const bands = listBands(geom, hover);
    const doc = bar.ownerDocument;
    if (bar.childElementCount !== bands.length) {
      bar.textContent = "";
      bands.forEach(() => bar.appendChild(doc.createElement("div")));
    }
    bands.forEach((b, i) => {
      const cell = bar.children[i];
      cell.className = "dwfui-list-band";
      cell.setAttribute("data-dwfui-list-band", b.band);
      cell.setAttribute("data-dwfui-list-row", String(b.row));
      if (b.form) cell.setAttribute("data-dwfui-list-form", b.form);
      else cell.removeAttribute("data-dwfui-list-form");
      if (b.hover) cell.setAttribute("data-dwfui-list-hover", "1");
      else cell.removeAttribute("data-dwfui-list-hover");
      // A two-row band is one sprite across two rows, so each row shows its own half, not a squashed whole.
      if (b.span === 2) cell.setAttribute("data-dwfui-list-half", String(b.index));
      else cell.removeAttribute("data-dwfui-list-half");
      cell.style.height = `${cellH}px`;
    });
  }

  function _listRowAt(bar, clientY) {
    const rect = bar.getBoundingClientRect();
    const cellH = _listCell("y") * (rect.height / Math.max(1, bar.offsetHeight));
    return Math.floor((clientY - rect.top) / Math.max(1, cellH));
  }

  // Every move ANNOUNCES itself: the event is how a consumer reacts to a position without owning one
  // (the announcements log pages older reports in when the list reaches its top).
  function _listApply(host, position) {
    _listStore(host, position);
    const geom = _listArrange(host);
    if (geom && typeof CustomEvent === "function")
      try { host.dispatchEvent(new CustomEvent("dwfui-list-scroll", { bubbles: true, detail: geom })); }
      catch (error) { DwfErr.report("dwfui.list-scroll-event", error); }
    return geom;
  }

  // `position` may be "end" -- the bottom-most position from the identity above, NOT `highestIndex`.
  function setListPosition(target, position, rootNode) {
    const doc = rootNode || (typeof document !== "undefined" ? document : null);
    const host = (target && target.nodeType) ? target
      : (doc && doc.querySelector ? doc.querySelector(`[data-dwfui-list-key="${target}"],` +
        `[data-dwfui-scroll-key="${target}"]`) : null);
    if (!host) {
      if (typeof target === "string" && position === 0) _listPositions[target] = 0;
      return null;
    }
    if (host.matches && host.matches("[data-dwfui-scroll-key]:not([data-dwfui-list])")) {
      if (position && typeof position === "object")
        throw new Error("DWFUI.setListPosition: fill scroll does not restore rows");
      host.scrollTop = position === "end" ? host.scrollHeight : Math.max(0, _lInt(position, 0));
      return { position: host.scrollTop };
    }
    let geom = host.__dwfuiListGeom || _listArrange(host);
    if (position && typeof position === "object" && position.operation !== "restore-row")
      throw new Error("DWFUI.setListPosition: unknown operation");
    const restoreRow = position && typeof position === "object";
    const requested = restoreRow ? position.position : position;
    const want = requested == null && restoreRow ? (geom ? geom.position : 0)
      : requested === "end" ? (geom ? geom.bottomMost : 0) : Math.max(0, _lInt(requested, 0));
    _listStore(host, want);
    geom = _listArrange(host);
    if (restoreRow && geom && position.follow && !position.follow.hidden) {
      const view = host.querySelector(".dwfui-scroll");
      const rows = _boxRows(view);
      const followIndex = rows.indexOf(position.follow);
      if (followIndex >= 0) {
        for (let attempts = 0; attempts <= rows.length; attempts++) {
          const viewport = view.getBoundingClientRect();
          const followRect = position.follow.getBoundingClientRect();
          if (followRect.top >= viewport.top && followRect.bottom <= viewport.bottom) break;
          const nextPosition = followIndex < geom.position ? followIndex
            : followIndex >= geom.position + geom.pageSize ? followIndex - geom.pageSize + 1
            : followRect.top < viewport.top ? followIndex : geom.position + 1;
          if (nextPosition === geom.position) break;
          _listStore(host, nextPosition);
          geom = _listArrange(host);
          if (!geom) break;
        }
      }
    }
    return geom ? geom.position : want;
  }

  function _listHostConnected(host, doc) {
    if (!host || !doc || host.ownerDocument !== doc) return false;
    if (typeof host.isConnected === "boolean") return host.isConnected;
    const rootNode = doc && (doc.documentElement || doc.body);
    return !!(rootNode && typeof rootNode.contains === "function" && rootNode.contains(host));
  }

  // One removal watcher per document, so a detached list releases its listeners and observers at the
  // same mutation checkpoint that mounts its replacement.
  function _listLifecycle(doc) {
    if (!doc) return null;
    if (doc.__dwfuiListLifecycle) return doc.__dwfuiListLifecycle;
    const MO = (root && root.MutationObserver) ||
      (typeof MutationObserver !== "undefined" ? MutationObserver : null);
    const target = doc.documentElement || doc.body || doc;
    if (!MO || !target || typeof target.contains !== "function") return null;
    const lifecycle = { hosts: new Set(), observer: null };
    lifecycle.observer = new MO(() => {
      [...lifecycle.hosts].forEach(host => {
        if (_listHostConnected(host, doc)) return;
        const destroy = host.__dwfuiListDestroy;
        if (typeof destroy === "function") destroy();
        else lifecycle.hosts.delete(host);
      });
    });
    lifecycle.observer.observe(target, { childList: true, subtree: true });
    doc.__dwfuiListLifecycle = lifecycle;
    return lifecycle;
  }

  function _mountList(host) {
    const ownerDoc = host && host.ownerDocument;
    if (host.__dwfuiListBound) {
      const boundDoc = host.__dwfuiListOwnerDocument;
      if (boundDoc && boundDoc !== ownerDoc) {
        if (typeof host.__dwfuiListDestroy === "function") host.__dwfuiListDestroy();
        else {
          host.__dwfuiListBound = false;
          delete host.__dwfuiListOwnerDocument;
        }
      } else { _listArrange(host); return; }
    }
    host.__dwfuiListBound = true;
    // The fail-open latch: until this attribute exists the viewport is a plain browser scroll box, so a
    // script that never ran leaves a working list rather than an unreachable one.
    const view = host.querySelector(".dwfui-scroll");
    const bar = host.querySelector("[data-dwfui-list-bar]");
    if (!view || !bar) return;
    host.setAttribute("data-dwfui-list-mounted", "1");
    const doc = ownerDoc;
    host.__dwfuiListOwnerDocument = doc;
    const state = _listState(host);
    const geomOf = () => host.__dwfuiListGeom || _listArrange(host);
    const lifecycle = _listLifecycle(doc);
    let active = true, resizeObserver = null, mutationObserver = null, unsubscribeGrid = null;
    let resizeFrame = null;
    const alive = () => {
      if (!active) return false;
      if (_listHostConnected(host, doc)) return true;
      destroy();
      return false;
    };

    // The wheel reaches the control only while the pointer is inside the OWNING CONTAINER's rect, and
    // it CONSUMES the event -- so a column at its end never chains the scroll out to the map's z-wheel.
    const onWheel = event => {
      if (!alive()) return;
      const geom = geomOf();
      if (!geom || !geom.overflow) return;               // no bar, no scroll input at all
      const notches = event.deltaY > 0 ? 1 : event.deltaY < 0 ? -1 : 0;
      if (!notches) return;
      _listApply(host, listWheel(geom, notches, event.shiftKey));
      event.preventDefault();
      event.stopPropagation();
    };
    host.addEventListener("wheel", onWheel, { passive: false });

    // The hover rect for KEYS, and the two-column hover that lights the thumb.
    const onMouseEnter = () => {
      if (alive()) host.classList.add("dwfui-list--hover");
    };
    const onMouseLeave = () => {
      if (!alive()) return;
      host.classList.remove("dwfui-list--hover");
      state.hover = {};
      _listArrange(host);
    };
    const onBarMove = event => {
      if (!alive()) return;
      const geom = geomOf();
      if (!geom) return;
      const row = _listRowAt(bar, event.clientY);
      const next = { up: row === geom.trackTop - 1, down: row === geom.trackBottom + 1,
        track: row >= geom.trackTop && row <= geom.trackBottom, drag: state.drag };
      if (next.up === state.hover.up && next.down === state.hover.down && next.track === state.hover.track) return;
      state.hover = next;
      _listArrange(host);
    };
    const onBarLeave = () => {
      if (!alive()) return;
      state.hover = { drag: state.drag };
      _listArrange(host);
    };
    host.addEventListener("mouseenter", onMouseEnter);
    host.addEventListener("mouseleave", onMouseLeave);
    bar.addEventListener("mousemove", onBarMove);
    bar.addEventListener("mouseleave", onBarLeave);

    const onBarDown = event => {
      if (!alive()) return;
      if (event.button !== 0) return;
      const geom = geomOf();
      if (!geom || !geom.overflow) return;
      const press = listPress(geom, _listRowAt(bar, event.clientY));
      if (press.action === "none") return;
      // The press CONSUMES the left mouse button before anything downstream sees it.
      event.preventDefault();
      event.stopPropagation();
      if (press.action === "drag") {
        // ...and pressing the thumb DOES NOT MOVE THE LIST. It only begins the drag.
        state.drag = true;
        state.hover = Object.assign({}, state.hover, { drag: true });
        host.classList.add("dwfui-list--dragging");
        _listArrange(host);
        return;
      }
      _listApply(host, press.position);
    };
    bar.addEventListener("mousedown", onBarDown);
    // NO GRAB OFFSET: the position comes from the pointer's row alone, so the thumb jumps to match it.
    // Deliberately worse-feeling and deliberately correct.
    const move = event => {
      if (!alive() || !state.drag) return;
      const geom = geomOf();
      if (!geom) return;
      _listApply(host, listDragPosition(geom, _listRowAt(bar, event.clientY)));
    };
    const end = () => {
      if (!alive() || !state.drag) return;
      state.drag = false;                                  // the position is UNCHANGED by the end
      state.hover = Object.assign({}, state.hover, { drag: false });
      host.classList.remove("dwfui-list--dragging");
      _listArrange(host);
    };
    doc.addEventListener("mousemove", move);
    doc.addEventListener("mouseup", end);
    doc.addEventListener("mouseleave", end);
    _listInstallKeys(doc);

    const destroy = () => {
      if (!active) return;
      active = false;
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("mouseenter", onMouseEnter);
      host.removeEventListener("mouseleave", onMouseLeave);
      bar.removeEventListener("mousemove", onBarMove);
      bar.removeEventListener("mouseleave", onBarLeave);
      bar.removeEventListener("mousedown", onBarDown);
      doc.removeEventListener("mousemove", move);
      doc.removeEventListener("mouseup", end);
      doc.removeEventListener("mouseleave", end);
      if (resizeObserver) resizeObserver.disconnect();
      if (mutationObserver) mutationObserver.disconnect();
      if (unsubscribeGrid) unsubscribeGrid();
      if (resizeFrame != null) {
        const cancel = (root && root.cancelAnimationFrame) ||
          (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null);
        if (cancel) cancel(resizeFrame);
      }
      if (lifecycle) lifecycle.hosts.delete(host);
      state.drag = false;
      host.classList.remove("dwfui-list--dragging", "dwfui-list--hover");
      host.removeAttribute("data-dwfui-list-mounted");
      host.__dwfuiListBound = false;
      delete host.__dwfuiListDestroy;
      delete host.__dwfuiListOwnerDocument;
    };
    host.__dwfuiListDestroy = destroy;
    if (lifecycle) lifecycle.hosts.add(host);

    // Re-arrange on a size change, a row change, and when the grid authority republishes the cell.
    if (typeof ResizeObserver === "function") {
      let scheduled = false;
      resizeObserver = new ResizeObserver(() => {
        if (!alive() || scheduled) return;
        scheduled = true;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null;
          scheduled = false;
          if (alive()) _listArrange(host);
        });
      });
      resizeObserver.observe(view);
      if (host.parentElement) resizeObserver.observe(host.parentElement);
    }
    if (typeof MutationObserver === "function") {
      mutationObserver = new MutationObserver(() => {
        if (alive()) _listArrange(host);
      });
      mutationObserver.observe(view, { childList: true, subtree: true });
    }
    if (root && root.DwfGrid && typeof root.DwfGrid.onChange === "function")
      unsubscribeGrid = root.DwfGrid.onChange(() => {
        if (alive()) _listArrange(host);
      }, doc);
    _listArrange(host);
  }

  // ONE document listener, because the control that receives a key is chosen by the POINTER, not by
  // focus. A handled key is erased, so PageUp over a list pages it and elsewhere still steps z.
  function _listInstallKeys(doc) {
    if (doc.__dwfuiListKeys) return;
    doc.__dwfuiListKeys = true;
    doc.addEventListener("keydown", event => {
      const key = event.key === "PageUp" ? "pageUp" : event.key === "PageDown" ? "pageDown" : null;
      if (!key) return;
      if (doc.getElementById("helpPopup")?.classList.contains("open")) return;
      const host = doc.querySelector(".dwfui-list--hover");
      if (!host) return;
      const geom = host.__dwfuiListGeom;
      if (!geom || !geom.overflow) return;
      const next = listKeyScroll(geom, key);
      if (next == null) return;
      _listApply(host, next);
      event.preventDefault();          // "a handled key is erased from the event set"
      event.stopPropagation();
    }, true);
  }

  function mountLists(rootNode) {
    const host = rootNode || (typeof document !== "undefined" ? document : null);
    if (!host || !host.querySelectorAll) return 0;
    let n = 0;
    host.querySelectorAll("[data-dwfui-list]").forEach(node => { _mountList(node); n++; });
    return n;
  }

  // The caller-driven resets, as one call. `target` is a key string, an element, or a root to sweep.
  function resetList(target, rootNode) {
    const doc = rootNode || (typeof document !== "undefined" ? document : null);
    if (typeof target === "string") { _listPositions[target] = 0; setListPosition(target, 0, doc); return true; }
    if (!target || !target.querySelectorAll) return false;
    const nodes = target.matches && target.matches("[data-dwfui-list]") ? [target]
      : [...target.querySelectorAll("[data-dwfui-list]")];
    nodes.forEach(node => {
      const key = node.getAttribute("data-dwfui-list-key");
      if (key) _listPositions[key] = 0;
      setListPosition(node, 0, doc);
    });
    return nodes.length > 0;
  }

  // ---- PanelChrome header ---------------------------------------------------------------------------
  const HEADER_TOOL_ORDER = { quill: 90, removeBuilding: 100 };   // quill 2nd-from-right, remove last
  function headerToolButtonHtml(t) {
    const cfg = {
      sprite: t.sprite || (t.role ? TOKENS.sprites[t.role] : undefined),
      art: t.art, size: t.size, state: t.state, active: t.active, disabled: t.disabled,
      placeholder: t.placeholder, cls: t.cls, dataset: t.dataset, title: t.title,
      gapBefore: t.gapBefore, ariaLabel: t.ariaLabel || t.title,
    };
    return t.glyphBox ? glyphBoxButton(Object.assign(cfg, t.glyphBox)) : artBtnHtml(cfg);
  }
  function headerToolRowsHtml(rows, opts) {
    const o = opts || {};
    const list = (rows || []).filter(row => Array.isArray(row) && row.length);
    if (!list.length) return "";
    const banded = list.map(row =>
      `<span class="dwfui-head-tools-row">${row.map(headerToolButtonHtml).join("")}</span>`).join("");
    return `<span class="dwfui-head-tools dwfui-head-tools--rows${o.cls ? " " + o.cls : ""}">${banded}</span>`;
  }
  function headerToolsHtml(tools, opts) {
    if (typeof tools === "string") return tools;                  // raw slot, still supported
    if (!Array.isArray(tools) || !tools.length) return "";
    const o = opts || {};
    // Stable sort by the native invariant: unranked context tools keep author order to the LEFT of the
    // quill; the quill is second-from-right and remove-building is rightmost.
    const ranked = tools.map((t, i) => ({ t, i, rank: HEADER_TOOL_ORDER[t.role] || 0 }));
    ranked.sort((a, b) => (a.rank - b.rank) || (a.i - b.i));
    const buttons = ranked.map(({ t }) => headerToolButtonHtml(t)).join("");
    return `<span class="dwfui-head-tools${o.cls ? " " + o.cls : ""}">${buttons}</span>`;
  }
  function headerHtml(cfg) {
    const c = cfg || {};
    if (c.toolRows && c.tools)
      throw new Error("DWFUI.headerHtml: pass `tools` (one strip) or `toolRows` (native's banded " +
        "cluster), not both -- two orderings of one cluster is how the strip drifted");
    const tag = /^(?:div|header|h[1-6])$/.test(c.tag || "") ? c.tag : "div";
    const titleTag = /^(?:div|span|h[1-6])$/.test(c.titleTag || "") ? c.titleTag : "div";
    let close = "";
    if (c.close !== false) {
      const x = c.close || {};
      if (x.glyph != null) {
        close = `<button class="${x.cls || "building-x"}"${x.dataset ? datasetAttrs(x.dataset) : ` data-${x.data || "building-close"}`}` +
          ` title="${esc(x.title || "Close")}"${x.disabled ? " disabled" : ""}>${x.glyph}</button>`;
      } else {
        const dataName = String(x.data || "building-close").replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        close = artBtnHtml({
          sprite: TOKENS.sprites.close, cls: x.cls || "building-x",
          dataset: x.dataset || { [dataName]: "" }, title: x.title || "Close",
          ariaLabel: x.ariaLabel || x.title || "Close", disabled: x.disabled,
        });
      }
    }
    // The native BACK header: a gold left-arrow tile, NOT an X. Rendered BEFORE the title.
    const back = c.back
      ? artBtnHtml({
        sprite: TOKENS.sprites.back, cls: "dwfui-head-back",
        dataset: (c.back === true ? { dwfuiBack: "" } : c.back.dataset) || { dwfuiBack: "" },
        title: (c.back !== true && c.back.title) || "Back", ariaLabel: "Back",
      })
      : "";
    const classes = [withBaseClass("dwfui-head", c.cls)];
    if (c.variant) classes.push(`dwfui-head--${esc(c.variant)}`);
    const title = Array.isArray(c.titleLines)
      ? c.titleLines.map((line, i) => bitmapTextHtml(line == null ? "" : line,
          { cls: `dwfui-head-title-text dwfui-head-title-line dwfui-head-title-line-${i}` })).join("")
      : (c.titleHtml != null ? c.titleHtml : bitmapTextHtml(c.title || "", { cls: "dwfui-head-title-text" }));
    const toolCluster = c.toolRows
      ? headerToolRowsHtml(c.toolRows, { cls: c.toolsCls })
      : headerToolsHtml(c.tools, { cls: c.toolsCls });
    return `<${tag} class="${classes.join(" ")}">${back}${c.icon || ""}` +
      `<${titleTag} class="${withBaseClass("dwfui-head-title", c.titleCls)}">${title}</${titleTag}>` +
      `${toolCluster}${close}</${tag}>`;
  }

  // The small left-docked native dialog: a FIXED FRAME, not content-hugging. No header and no close
  // button -- a white prompt line sits top-left, and dismissal is the sidebar's Cancel or the choice.
  function modalHtml(cfg, bodyHtml) {
    const c = cfg || {};
    const prompt = c.promptHtml != null ? c.promptHtml : (c.prompt ? bitmapTextHtml(c.prompt,
      { cls: "dwfui-modal-prompt-text" }) : "");
    return `<div class="dwfui-modal${c.cls ? " " + c.cls : ""}"${datasetAttrs(c.dataset)}` +
      ` role="dialog"${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `${prompt ? `<div class="dwfui-modal-prompt">${prompt}</div>` : ""}` +
      `<div class="dwfui-modal-body">${bodyHtml || ""}</div>` +
      `${c.footerHtml != null ? `<div class="${withBaseClass("dwfui-modal-footer", c.footerCls)}">${c.footerHtml}</div>` : ""}</div>`;
  }

  // The real yes/no box: a centred square over the middle 40% x 40%. Built ON TOP of modalHtml so the
  // frame art, prompt slot and footer behave like every other dialog.
  function confirmHtml(cfg, bodyHtml) {
    const c = cfg || {};
    // Destructive by default: every arm-then-confirm site this replaces guards a destructive action.
    const tone = c.confirmTone === "neutral" ? "grey" : "red";
    const footer =
      plaqueBtnHtml({
        label: c.cancelLabel || "No", tone: "grey",
        // A caller may add its own class ALONGSIDE the shared one; without this channel the only way to
        // satisfy a per-screen selector was to hand-build the footer.
        cls: "dwfui-confirm-cancel" + ((c.cancel && c.cancel.cls) ? " " + c.cancel.cls : ""),
        dataset: (c.cancel && c.cancel.dataset) || { dwfuiConfirm: "cancel" },
      }) +
      plaqueBtnHtml({
        label: c.confirmLabel || "Yes", tone,
        cls: "dwfui-confirm-accept" + ((c.confirm && c.confirm.cls) ? " " + c.confirm.cls : ""),
        dataset: (c.confirm && c.confirm.dataset) || { dwfuiConfirm: "accept" },
      });
    return modalHtml({
      cls: `dwfui-modal--confirm${c.cls ? " " + c.cls : ""}`,
      prompt: c.prompt, promptHtml: c.promptHtml,
      ariaLabel: c.ariaLabel || "Confirm", dataset: c.dataset, footerHtml: footer,
    }, bodyHtml || "");
  }

  // Chips are selected BY INDEX and are mutually exclusive; selection writes an explicit art state onto EVERY chip.
  const FILTER_NONE = -1;
  // cfg: {chips: [{key, label, count, disabled}], active (index, -1 for none), dataAttr,
  //       noneLabel (omit to hide the clear-all chip), cls, ariaLabel}
  function filterChipsHtml(cfg) {
    const c = cfg || {};
    const attr = c.dataAttr || "dwfui-chip";
    const activeIndex = Number.isInteger(c.active) ? c.active : FILTER_NONE;
    const chip = (label, index, extra) => {
      const on = index === activeIndex;
      const classes = ["dwfui-chip"];
      // Selected/unselected is a CLASS carrying its own art, not a :hover or an opacity tweak.
      if (on) classes.push("dwfui-chip--on");
      if (extra && extra.disabled) classes.push("dwfui-chip--disabled");
      const count = extra && extra.count != null
        ? bitmapTextHtml(` (${extra.count})`, { cls: "dwfui-chip-count" }) : "";
      return `<button type="button" class="${classes.join(" ")}" role="radio" aria-checked="${on}"` +
        ` data-${attr}="${esc(extra && extra.key != null ? extra.key : index)}"` +
        ` data-dwfui-chip-index="${index}"${extra && extra.disabled ? " disabled" : ""}>` +
        `${bitmapTextHtml(label, { cls: "dwfui-chip-label" })}${count}</button>`;
    };
    const none = c.noneLabel ? chip(c.noneLabel, FILTER_NONE, { key: "" }) : "";
    const chips = (c.chips || []).map((t, i) => chip(String(t.label == null ? "" : t.label), i, t)).join("");
    return `<div class="dwfui-chips${c.cls ? " " + c.cls : ""}" role="radiogroup"` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${none}${chips}</div>`;
  }

  // ---- PlaqueButton ---------------------------------------------------------------------------------
  function plaqueBtnHtml(cfg) {
    const c = cfg || {};
    const classes = ["dwfui-plaque"];
    const type = /^(?:button|submit|reset)$/.test(c.type || "") ? c.type : "button";
    if (c.chassis === "slab") classes.push("dwfui-plaque--slab");
    // Only the compact variant paints `on`; pushing the class elsewhere would be a silent no-op.
    if (c.size === "compact") {
      classes.push("dwfui-plaque--compact");
      if (c.on) classes.push("dwfui-plaque--on");
    }
    if (c.tone) classes.push(c.tone);
    if (/^(?:neutral|confirm|destructive)$/.test(c.artTone || ""))
      classes.push(`dwfui-plaque--art-${c.artTone}`);
    if (c.cls) classes.push(c.cls);
    // Native's FOCUSED-SLOT affordance is the GOLD CORNER BRACKETS -- distinct from selection, and
    // NOT a fill.
    if (c.focus) classes.push("dwfui-focus-brackets");
    const focus = c.focus ? `<span class="dwfui-plaque-focus-ornaments" aria-hidden="true"></span>` : "";
    const label = c.labelHtml != null
      ? c.labelHtml
      : bitmapTextHtml(c.label || "", { cls: "dwfui-plaque-label" });
    return `<button type="${type}" class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}${c.disabled ? " disabled" : ""}>` +
      `${label}${focus}</button>`;
  }

  // Native classifies EVERY destination cell against a 3x3 table, so corners occur once and edges and
  // centre once per cell. With no `family` this keeps the audited CSS tones.
  function frameNineSlice(cfg) {
    const c = cfg || {};
    const cols = Math.max(2, Math.round(Number(c.cols) || 0));
    const rows = Math.max(2, Math.round(Number(c.rows) || 0));
    const family = c.family && TOKENS.frameFamilies[c.family] ? TOKENS.frameFamilies[c.family] : null;
    if (family && ((family.minCols && cols < family.minCols) ||
        (family.minRows && rows < family.minRows)))
      throw new Error(`DWFUI.frameNineSlice: ${c.family} requires at least ` +
        `${family.minCols || 2}x${family.minRows || 2} cells`);
    const classes = ["dwfui-glyphbox"];
    if (c.cls) classes.push(c.cls);
    if (c.shareLeft) classes.push("dwfui-frame-nine-slice--share-left", "dwfui-glyphbox--share-left");
    if (c.shareTop) classes.push("dwfui-frame-nine-slice--share-top", "dwfui-glyphbox--share-top");
    if (c.selected) classes.push("dwfui-frame-nine-slice--selected");
    if (c.current) classes.push("dwfui-frame-nine-slice--current");
    if (c.paint === false) classes.push("dwfui-frame-nine-slice--semantic");
    if (family) classes.push("dwfui-frame-nine-slice--native");
    const cells = [];
    for (let row = 0; row < rows; row++) {
      const y = row === 0 ? "top" : (row === rows - 1 ? "bottom" : "middle");
      for (let col = 0; col < cols; col++) {
        const x = col === 0 ? "left" : (col === cols - 1 ? "right" : "middle");
        const role = y + "-" + x;
        cells.push('<span class="dwfui-frame-cell dwfui-frame-cell--' + role + '"' +
          ' data-dwfui-frame-cell="' + col + ',' + row + '" data-dwfui-frame-role="' + role + '" aria-hidden="true"></span>');
      }
    }
    const native = family
      ? '<canvas class="dwfui-native-frame-art" data-dwfui-native-frame="' + esc(c.family) + '"' +
        ' data-dwfui-frame-state="' + _frameState(c) + '"' +
        ' data-dwfui-frame-cols="' + cols + '" data-dwfui-frame-rows="' + rows + '"' +
        ' data-dwfui-frame-share-left="' + (c.shareLeft ? "true" : "false") + '"' +
        ' data-dwfui-frame-share-top="' + (c.shareTop ? "true" : "false") + '" aria-hidden="true"></canvas>'
      : "";
    return '<span class="' + classes.join(" ") + '" aria-hidden="true"' +
      datasetAttrs(c.dataset) + ' data-dwfui-frame-nine-slice="' + cols + 'x' + rows + '"' +
      (c.glyphboxAttr === false ? '' : ' data-dwfui-glyphbox="' + cols + 'x' + rows + '"') +
      ' style="--dwfui-gb-cols:' + cols + ';--dwfui-gb-rows:' + rows + '">' +
      native + cells.join("") + '</span>';
  }

  // frameNineSlice owns only chrome; glyphBoxButton keeps artBtnHtml's unproven interaction states.
  // In joined strips the left button emits the only separator and the right shares that edge.
  function glyphBoxButton(cfg) {
    const c = cfg || {};
    const cols = Math.max(2, Math.round(Number(c.cols) || 0));
    const rows = Math.max(2, Math.round(Number(c.rows) || 0));
    const selected = c.selected === true;
    const current = c.current === true || c.active === true;
    const selfFramed = isSelfFramedSprite(c.sprite);
    const classes = ["dwfui-glyph-box-button"];
    if (selected) classes.push("dwfui-glyph-box-button--selected");
    if (current) classes.push("dwfui-glyph-box-button--current");
    if (c.cls) classes.push(c.cls);
    return artBtnHtml(Object.assign({}, c, {
      cls: classes.join(" "), dataset: c.dataset,
      frameNineSlice: { cols, rows, shareLeft: c.shareLeft, shareTop: c.shareTop, selected, current,
        disabled: c.disabled, state: c.state, family: selfFramed ? null : c.family,
        paint: !selfFramed, glyphboxAttr: false },
    }));
  }

  // ---- LightPlaque ----------------------------------------------------------------------------
  function lightPlaqueHtml(cfg) {
    const c = cfg || {};
    if (!c.token)
      throw new Error("DWFUI.lightPlaqueHtml: an interface_map token is required");
    const classes = ["dwfui-lightplaque"];
    if (c.cls) classes.push(c.cls);
    return `<button type="button" class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `<canvas class="dwfui-lightplaque-art" data-dwfui-lightplaque="${esc(c.token)}"` +
      ` data-dwfui-lightplaque-chars="${String(c.label == null ? "" : c.label).length}"` +
      ` aria-hidden="true"></canvas>` +
      `${bitmapTextHtml(c.label || "", { cls: "dwfui-lightplaque-label" })}</button>`;
  }

  // Nine-slice-TILE the record: corners stay 1:1 and edge/centre tiles REPEAT (native composition tiles
  // pixel art, never stretches it), with the last repeat clipped.
  function _paintLightPlaque(canvas, rec, doc) {
    if (!canvas || !rec || !rec.w || !rec.h || !root || !root.Image) return;
    const d = doc || canvas.ownerDocument || (typeof document !== "undefined" ? document : null);
    const tw = Math.max(1, Math.floor(rec.w / 3)), th = Math.max(1, Math.floor(rec.h / 3));
    const chars = Number(canvas.getAttribute("data-dwfui-lightplaque-chars")) || 0;
    const cols = Math.max(3, chars + 4);   // corner + pad + label + pad + corner
    const rows = 3;                        // the art's native height
    const iface = interfaceScale(d), zoom = uiZoom(d);
    const cssW = cols * tw * iface, cssH = rows * th * iface;
    const w = Math.max(1, Math.round(cssW * zoom)), h = Math.max(1, Math.round(cssH * zoom));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (canvas.style) {
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    const ctx = canvas.getContext("2d");
    const img = _sheetImage(rec.img);
    _whenLoaded(img, () => {
      _clearBrokenArt(canvas);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      const sx = i => rec.cx + (i === 0 ? 0 : (i === 1 ? tw : tw * 2));
      const sy = j => rec.cy + (j === 0 ? 0 : (j === 1 ? th : th * 2));
      const dw = w / cols, dh = h / rows;
      for (let col = 0; col < cols; ++col) {
        const i = col === 0 ? 0 : (col === cols - 1 ? 2 : 1);
        for (let row = 0; row < rows; ++row) {
          const j = row === 0 ? 0 : (row === rows - 1 ? 2 : 1);
          ctx.drawImage(img, sx(i), sy(j), tw, th,
            Math.round(col * dw), Math.round(row * dh),
            Math.round((col + 1) * dw) - Math.round(col * dw),
            Math.round((row + 1) * dh) - Math.round(row * dh));
        }
      }
    }, () => _markBrokenArt(canvas, img), canvas);
  }

  // ---- ArtButton ------------------------------------------------------------------------------------
  function artBtnHtml(cfg) {
    const c = cfg || {};
    if (c.placeholder && !c.title)
      throw new Error("DWFUI.artBtnHtml: placeholder:true requires a title saying what is unverified");
    const art = TOKENS.art[c.art];
    const classes = ["dwfui-art-btn"];
    if (c.cls) classes.push(c.cls);
    if (c.active) classes.push("active");
    // A tool DECLARES the gap that precedes it; the strip does not hard-code a position.
    if (c.gapBefore) classes.push("dwfui-gap");
    const stateCls = BTN_STATE_CLASS[c.state];
    if (stateCls) classes.push(stateCls);
    if (c.placeholder) classes.push("dwfui-btn--placeholder");
    const selfFramed = isSelfFramedSprite(c.sprite);
    const inner = c.spriteCrop
      ? iconHtml({ spriteCrop: c.spriteCrop, size: c.size, alt: c.ariaLabel || c.title })
      : (c.sprite
        ? iconHtml({ sprite: c.sprite, size: c.size, nativeCell: selfFramed, states: stateFamilyOf(c.sprite),
          state: knownState(c), alt: c.ariaLabel || c.title })
        : "");
    const glyph = c.glyphHtml != null ? String(c.glyphHtml) : "";
    if (glyph && (c.sprite || c.spriteCrop || c.swatch))
      throw new Error("DWFUI.artBtnHtml: `glyphHtml` is the face of LAST resort and is mutually " +
        "exclusive with `sprite`/`spriteCrop`/`swatch` -- a button with a token has no reason to " +
        "hand-roll its face, and two faces in one cell is how a sprite gets silently occluded");
    const swatch = c.swatch ? String(c.swatch) : "";
    const styleAttr = swatch
      ? ` style="background:${esc(swatch)}"`
      : (!c.sprite && !c.spriteCrop && art ? ` style="background-image:${art}"` : "");
    const frame = c.frameNineSlice ? frameNineSlice(c.frameNineSlice) : "";
    const face = frame && glyph ? `<span class="dwfui-art-btn-face">${glyph}</span>` : (glyph || inner);
    return `<button class="${classes.join(" ")}"${selfFramed ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : ""}` +
      `${stateArtAttr(stateFamilyOf(c.sprite), knownState(c))}${styleAttr}` +
      `${datasetAttrs(c.dataset)}${c.title ? ` title="${esc(c.title)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}` +
      `${swatch ? ` aria-pressed="${c.active ? "true" : "false"}"` : ""}` +
      `${c.disabled ? " disabled" : ""}>${frame}${face}</button>`;
  }

  function accessPolicyButtonsHtml(cfg) {
    const c = cfg || {};
    const options = Array.isArray(c.options) ? c.options : [];
    return options.map(option => {
      const active = option.key === c.current;
      const dataset = {};
      if (c.enabled && c.datasetKey) dataset[c.datasetKey] = option.key;
      return artBtnHtml({
        cls: "location-access-btn", active, disabled: !c.enabled,
        sprite: "LOCATION_PERMISSION_" + (active ? "ON_" : "OFF_") + option.word,
        dataset,
        title: c.enabled ? option.title : option.title + " Browser changes are locked by the host.",
        ariaLabel: option.title,
      });
    }).join("");
  }

  // ---- SideWindow -----------------------------------------------------------------------------------
  function sideWindowHtml(cfg, bodyHtml) {
    const c = cfg || {};
    const d = c.done || {};
    const done = c.done === false ? "" : plaqueBtnHtml({
      label: d.label || "Done", tone: "red", cls: d.cls,
      dataset: d.dataset || { dwfuiSidewinDone: "" }, title: d.title,
    });
    return `<div class="dwfui-sidewin${c.cls ? " " + c.cls : ""}"${datasetAttrs(c.dataset)}` +
      `${c.ariaLabel ? ` role="dialog" aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `<div class="dwfui-sidewin-bar"><span class="dwfui-sidewin-tools">${c.tools || ""}</span>${done}</div>` +
      `<div class="dwfui-sidewin-body">${bodyHtml || ""}</div></div>`;
  }

  // The native blocking announcement box: an OPAQUE BLACK centred rectangle with no title, border,
  // close X, scrim, scroll pane or queue count. Those absences are load-bearing.
  function messageBoxHtml(cfg) {
    const c = cfg || {};
    const lines = Array.isArray(c.lines) ? c.lines : [];
    const portrait = c.portraitReserved === true || c.portraitHtml != null;
    const cols = portrait ? 66 : 54;
    const textLeft = portrait ? 14 : 2;
    const textCols = cols - textLeft - 2;
    const wrapped = [];
    for (const raw of (lines.length ? lines : [""])) {
      const value = String(raw == null ? "" : raw);
      if (value === "") { wrapped.push(""); continue; }
      for (const piece of wrapToColumns(value, textCols)) wrapped.push(piece);
    }
    // An empty body still reserves one text row: native parses at least one line, and a zero-row box
    // would collapse the acknowledgement onto the top edge.
    const rows = Math.max(Math.max(1, wrapped.length) + 8, portrait ? 10 : 0);
    const colorIndex = Number.isFinite(Number(c.color))
      ? Math.max(0, Math.min(7, Number(c.color))) + (c.bright ? 8 : 0)
      : null;
    const body = wrapped.map(line => {
      const blank = line === "";
      return `<div class="dwfui-messagebox-line${blank ? " dwfui-messagebox-line--blank" : ""}` +
        `${c.lineCls ? " " + c.lineCls : ""}">` +
        (blank ? "&nbsp;" : bitmapTextHtml(String(line), { cls: "dwfui-messagebox-line-text" })) +
        "</div>";
    }).join("");
    // A reserved-but-unresolved portrait keeps the native hole rather than shrinking the box back: the
    // geometry is the evidence, and a missing painter is marked.
    const portraitSlot = portrait
      ? `<div class="dwfui-messagebox-portrait"${c.portraitHtml == null ? ' data-dwfui-portrait-unresolved="true"' : ""}` +
        ` aria-hidden="true">${c.portraitHtml == null ? "" : c.portraitHtml}</div>`
      : "";
    const ack = c.acknowledge || {};
    const label = Number(c.queued) > 0 ? "More" : "Okay";
    const button = glyphBoxButton({
      cols: 8, rows: 3, family: "popupAcknowledge",
      cls: "dwfui-messagebox-ack" + (ack.cls ? " " + ack.cls : ""),
      dataset: ack.dataset, disabled: ack.disabled,
      title: ack.title || label, ariaLabel: ack.ariaLabel || label,
      glyphHtml: rawHtml("native BOX acknowledgement copy painted over HORIZONTAL_OPTION_CONFIRM",
        bitmapTextHtml(label, { cls: "dwfui-messagebox-ack-label" })),
    });
    const frame = nativeFrameHtml("viewSheet", { cls: "dwfui-messagebox-frame" });
    return `<div class="dwfui-messagebox dwfui-messagebox--native-framed` +
      `${c.cls ? " " + c.cls : ""}" role="dialog"` +
      ` aria-label="${esc(c.ariaLabel || "Announcement")}"${datasetAttrs(c.dataset)}` +
      ` data-dwfui-messagebox="${cols}x${rows}"` +
      ` style="--dwfui-messagebox-cols:${cols};--dwfui-messagebox-rows:${rows};` +
      `--dwfui-messagebox-text-left:${textLeft}">` +
      `${frame}${portraitSlot}<div class="dwfui-messagebox-text${c.textCls ? " " + c.textCls : ""}"` +
      `${colorIndex == null ? "" : ` style="color:${dfColor(colorIndex)}"`}>${body}</div>` +
      `${button}</div>`;
  }

  // ---- statTileHtml: a dashboard stat tile -----------------------------------------------------
  // No fetch and no state -- `value` is whatever the caller computed; value, label and sub are escaped.
  function statTileHtml(cfg) {
    const c = cfg || {};
    const classes = ["dwfui-stat-tile"];
    if (c.tone) classes.push(c.tone);
    if (c.cls) classes.push(c.cls);
    // The bitmap renderer ignores `font-size`, so `scale: 2` is how CSS and canvas ask for the same
    // size -- without it the caption competes with the number it labels.
    const value = c.valueHtml != null ? c.valueHtml
      : bitmapTextHtml(c.value == null ? "" : c.value, { scale: 2 });
    const sub = c.sub ? `<div class="dwfui-stat-sub">${bitmapTextHtml(c.sub)}</div>` : "";
    return `<div class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}>` +
      `<div class="dwfui-stat-value">${value}</div>` +
      `<div class="dwfui-stat-label">${bitmapTextHtml(c.label == null ? "" : c.label)}</div>${sub}</div>`;
  }

  // The fill is ALWAYS clamped to 0..100 so bad data cannot overflow the track; `surplus` spans past
  // it, and the boundary between the two segments IS the 100% mark. The only inline style is a width.
  function barRowHtml(cfg) {
    const c = cfg || {};
    const max = Number(c.max) > 0 ? Number(c.max) : 0;
    const value = Number(c.value) || 0;
    let pct = (c.pct != null) ? Number(c.pct) : (max > 0 ? (value / max) * 100 : 0);
    if (!(pct >= 0)) pct = 0;
    if (pct > 100) pct = 100;
    const surplus = Number(c.surplus) > 0 && max > 0 ? (Number(c.surplus) / max) * 100 : 0;
    const span = 100 + surplus;
    const classes = ["dwfui-bar-row"];
    if (c.cls) classes.push(c.cls);
    const fillTone = c.tone ? ` ${c.tone}` : "";
    const readout = bitmapTextHtml((c.valueText != null) ? c.valueText : String(value));
    const sub = c.sub ? `<span class="dwfui-bar-sub">${bitmapTextHtml(c.sub)}</span>` : "";
    const spare = surplus
      ? `<span class="dwfui-bar-spare" style="width:${(surplus / span * 100).toFixed(1)}%"></span>` : "";
    return `<div class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}>` +
      `<span class="dwfui-bar-label">${bitmapTextHtml(c.label == null ? "" : c.label)}</span>` +
      `<span class="dwfui-bar-value">${readout}</span>` +
      `<span class="dwfui-bar-track"><span class="dwfui-bar-fill${fillTone}" style="width:${(pct / span * 100).toFixed(1)}%"></span>${spare}</span>` +
      `${sub}</div>`;
  }

  // Search is owned by `footerHtml` EXACTLY ONCE, so a nested renderer cannot silently grow a second
  // search field. `promptHtml` is the white instruction line native uses where a chooser has no header.
  function windowHtml(cfg) {
    const c = cfg || {};
    const tag = c.tag || "div";
    const prompt = c.promptHtml != null ? c.promptHtml : (c.prompt ? bitmapTextHtml(c.prompt,
      { cls: "dwfui-window-prompt-text" }) : "");
    const body = c.bodyHtml != null ? c.bodyHtml
      : `<div class="info-body">${c.sideHtml || ""}<div class="info-main">${c.mainHtml || ""}</div></div>`;
    // Ledger 0073 R6: the nativeFrame default must stay viewSheet, never masterChrome.
    let nativeFrame = "viewSheet";
    if (c.nativeFrame === false) nativeFrame = null;
    else if (typeof c.nativeFrame === "string" && TOKENS.frameFamilies[c.nativeFrame])
      nativeFrame = c.nativeFrame;
    const frame = nativeFrame ? nativeFrameHtml(nativeFrame, { cls: "dwfui-window-native-frame" }) : "";
    return `<${tag}${c.id ? ` id="${esc(c.id)}"` : ""} class="dwfui-window info-window` +
      `${nativeFrame ? " dwfui-window--native-framed" : ""}` +
      `${c.cls ? " " + c.cls : ""}"` +
      `${nativeFrame ? ` data-dwfui-window-native-frame="${esc(nativeFrame)}"` : ""}` +
      `${c.role ? ` role="${esc(c.role)}"` : ""}${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `${frame}${prompt ? `<div class="dwfui-window-prompt">${prompt}</div>` : ""}${c.primaryTabs || ""}` +
      `${c.detailTabs || ""}${c.sectionTabs || ""}${body}` +
      `${c.footerHtml != null ? `<div class="${withBaseClass("info-footer", c.footerCls)}">${c.footerHtml}</div>` : ""}</${tag}>`;
  }

  // ---- Stepper ------------------------------------------------------------------------------
  function stepperHtml(cfg) {
    const c = cfg || {};
    const min = Number.isFinite(Number(c.min)) ? Number(c.min) : 0;
    const max = Number.isFinite(Number(c.max)) ? Number(c.max) : 9999;
    const value = Math.max(min, Math.min(max, Number(c.value) || 0));
    const stepKey = c.stepKey || "dwfui-step";
    const minusData = c.minusDataset || { [stepKey]: c.key || "value", delta: -1 };
    const plusData = c.plusDataset || { [stepKey]: c.key || "value", delta: 1 };
    const hashData = c.hashDataset || { [stepKey]: c.key || "value", enter: 1 };
    const art = c.art === true;
    // The +/- tiles go dead at the bounds and keep the CSS dim: the increase/decrease tokens have NO
    // state variants, and substituting another family's art would be fabricated. `bounds:false` opts out.
    const bounds = c.bounds !== false;
    const atMax = bounds && value >= max;
    const atMin = bounds && value <= min;
    const face = (sprite, glyph) => art
      ? iconHtml({ sprite, size: c.tileSize || 24, nativeCell: true, alt: glyph === TOKENS.glyphs.plus ? "Increase" : "Decrease" })
      : glyph;
    // `title` is the stepper's own tooltip on the value cell. It exists because the help reference
    // harvests QUOTED LITERALS, so a builder-generated template tooltip is invisible to the corpus.
    const titleAttr = c.title ? ` title="${esc(c.title)}"` : "";
    const displayValue = c.valueText != null ? String(c.valueText) : String(value);
    const input = c.editable === false
      ? `<span class="dwfui-stepper-value" aria-live="polite"${titleAttr}>${bitmapTextHtml(displayValue)}</span>`
      : `<input class="${withBaseClass("dwfui-stepper-input", c.inputCls)}"${c.inputId ? ` id="${esc(c.inputId)}"` : ""} type="number" min="${min}" max="${max}" value="${value}"${titleAttr}${datasetAttrs(c.dataset)}>`;
    const hash = c.hash
      ? `<button type="button" class="dwfui-stepper-btn hash"${art ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : ""}${datasetAttrs(hashData)} title="Enter ${esc(c.label || "value")}">` +
        `${art ? iconHtml({ sprite: TOKENS.sprites.stepHash, size: c.tileSize || 24, nativeCell: true, alt: "Enter amount" }) : "#"}</button>`
      : "";
    const artAttr = art ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : "";
    return `<label class="dwfui-stepper${art ? " dwfui-stepper--native-art" : ""}${c.cls ? " " + c.cls : ""}"${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `${c.label != null ? `<span class="dwfui-stepper-label">${bitmapTextHtml(c.label)}</span>` : ""}` +
      `${input}${hash}` +
      `<button type="button" class="dwfui-stepper-btn plus"${artAttr}${datasetAttrs(plusData)} title="Increase ${esc(c.label || "value")}"${atMax ? " disabled" : ""}>${face(TOKENS.sprites.stepPlus, TOKENS.glyphs.plus)}</button>` +
      `<button type="button" class="dwfui-stepper-btn minus"${artAttr}${datasetAttrs(minusData)} title="Decrease ${esc(c.label || "value")}"${atMin ? " disabled" : ""}>${face(TOKENS.sprites.stepMinus, TOKENS.glyphs.minus)}</button>` +
      `</label>`;
  }

  // A STEPPER IS THE WRONG CONTROL: native's numeric fields have no increment path -- they are typed
  // digit entries. The two modes are DIFFERENT ELEMENTS: a display button, or the raw string plus a caret.
  function clampNumberEntry(raw, min, max) {
    const lo = Number.isFinite(Number(min)) ? Number(min) : 0;
    const hi = Number.isFinite(Number(max)) ? Number(max) : 9999;
    // Native clamps the PARSED value; non-numeric text (an empty field committed) parses as the floor.
    const n = Math.trunc(Number(String(raw == null ? "" : raw).trim()));
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }
  function numberEntryHtml(cfg) {
    const c = cfg || {};
    const min = Number.isFinite(Number(c.min)) ? Number(c.min) : 0;
    const max = Number.isFinite(Number(c.max)) ? Number(c.max) : 9999;
    // Max typed length is a PROPERTY OF THE FIELD, not a derivative of the clamp, so it is passed explicitly.
    const maxLength = Number.isFinite(Number(c.maxLength))
      ? Math.max(1, Math.floor(Number(c.maxLength))) : String(max).length;
    const classes = ["dwfui-number-entry", c.cls || ""].filter(Boolean).join(" ");
    const titleAttr = c.title ? ` title="${esc(c.title)}"` : "";
    const ariaAttr = c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : "";
    const labelHtml = c.label != null
      ? `<span class="dwfui-number-entry-label">${bitmapTextHtml(c.label)}</span>` : "";
    if (c.editing) {
      // `text` is the RAW TYPED STRING: native shows exactly what was typed until commit, so a half-typed
      // value must survive a re-render.
      const raw = c.text == null ? String(clampNumberEntry(c.value, min, max)) : String(c.text);
      return `<span class="${classes} dwfui-number-entry--editing"${ariaAttr}${titleAttr}` +
        ` data-dwfui-number-min="${min}" data-dwfui-number-max="${max}">` +
        labelHtml +
        `<input class="${withBaseClass("dwfui-number-entry-input", c.inputCls)}"${c.id ? ` id="${esc(c.id)}"` : ""}` +
        ` type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" spellcheck="false"` +
        ` maxlength="${maxLength}" value="${esc(raw)}"${ariaAttr}${datasetAttrs(c.dataset)}>` +
        // The caret is a separate element so the blink is CSS and needs no timer. It is decoration -- the
        // real caret is the input's own, which the field hides.
        `<span class="dwfui-number-entry-caret" aria-hidden="true"></span>` +
        `</span>`;
    }
    const shown = clampNumberEntry(c.value, min, max);
    return `<button type="button" class="${classes} dwfui-number-entry--display"` +
      `${c.id ? ` id="${esc(c.id)}"` : ""}${ariaAttr}${titleAttr}${datasetAttrs(c.enterDataset)}>` +
      labelHtml +
      `<span class="dwfui-number-entry-value">${bitmapTextHtml(String(shown))}</span>` +
      `</button>`;
  }

  // ---- switchHtml ------------------------------------------------------------------------------
  // The visible pill is CSS; the semantic control remains a real checkbox. `columns` wraps label and sub.
  function switchHtml(cfg) {
    const c = cfg || {};
    const labelTag = /^(?:span|b|strong)$/.test(c.labelTag || "") ? c.labelTag : "span";
    const subTag = /^(?:span|small)$/.test(c.subTag || "") ? c.subTag : "span";
    const knob = c.knob === false ? "" : `<span class="dwfui-switch-knob"></span>`;
    const text = value => c.columns ? bitmapProseHtml(value, c.columns) : bitmapTextHtml(value);
    return `<label class="dwfui-switch${c.cls ? " " + c.cls : ""}"${datasetAttrs(c.rootDataset)}${c.title ? ` title="${esc(c.title)}"` : ""}>` +
      `<input type="checkbox" role="switch"${c.name ? ` name="${esc(c.name)}"` : ""}${datasetAttrs(c.dataset)}` +
      `${c.checked ? " checked" : ""}${c.disabled ? " disabled" : ""}>` +
      `<span class="dwfui-switch-track" aria-hidden="true">${knob}</span>` +
      `<span class="${withBaseClass("dwfui-switch-copy", c.copyCls)}"><${labelTag} class="${withBaseClass("dwfui-switch-label", c.labelCls)}">${text(c.label || "")}</${labelTag}>` +
      `${c.sub ? `<${subTag} class="dwfui-switch-sub">${text(c.sub)}</${subTag}>` : ""}</span></label>`;
  }

  // `columns` is the WRAPPING form: the default paints the whole string as one canvas, which cannot
  // break, so a sentence-length status runs out of its panel and is cut mid-word without it.
  function statusHtml(cfg) {
    const c = cfg || {};
    const tag = /^(?:div|span|p|output)$/.test(c.tag || "") ? c.tag : "div";
    const classes = ["dwfui-status"];
    if (c.tone) classes.push(c.tone);
    if (c.cls) classes.push(c.cls);
    if (c.columns) classes.push("dwfui-status--prose");
    const copy = c.textHtml != null ? c.textHtml
      : c.columns ? bitmapProseHtml(c.text || "", c.columns, { cls: "dwfui-status-text" })
      : bitmapTextHtml(c.text || "", { cls: "dwfui-status-text" });
    return `<${tag} class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.dfColor != null ? ` style="color:${esc(dfColor(c.dfColor))}"` : ""}` +
      `${c.role ? ` role="${esc(c.role)}"` : ""}${c.live ? ` aria-live="${esc(c.live)}"` : ""}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}>${c.icon || ""}<span class="dwfui-status-copy">${copy}</span></${tag}>`;
  }

  // A COMPONENT DOES NOT DRAW A FRAME IT DOES NOT OWN: the CELL is borderless, the GRID paints the
  // shared dividers through its gap, and the WINDOW draws the single ornate border.
  function gridCellHtml(cfg, innerHtml) {
    const c = cfg || {};
    const classes = ["dwfui-cell"];
    if (c.wide) classes.push("dwfui-cell--wide");
    if (c.cls) classes.push(c.cls);
    return `<div class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}>${innerHtml != null ? innerHtml : ""}</div>`;
  }
  function gridHtml(cfg, cellsHtml) {
    const c = cfg || {};
    const classes = ["dwfui-grid"];
    if (c.cls) classes.push(c.cls);
    const cells = Array.isArray(cellsHtml)
      ? cellsHtml.map(cell => (typeof cell === "string" ? cell : gridCellHtml(cell, cell && cell.html))).join("")
      : (cellsHtml || "");
    return `<div class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.role ? ` role="${esc(c.role)}"` : ""}${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${cells}</div>`;
  }

  function requireComponents(surface, names) {
    const missing = (names || []).filter(name => {
      const parts = String(name).split(".");
      let value = api;
      for (const part of parts) value = value && value[part];
      return typeof value !== "function" && (value == null || typeof value !== "object");
    });
    // This must NOT throw: require() is called at the TOP LEVEL of ~18 panel modules, and a top-level
    // throw aborts the rest of that file, deleting a whole panel over one absent builder.
    if (missing.length) {
      const msg = `DWFUI ${VERSION}: ${surface || "unknown surface"} requires ${missing.join(", ")}`;
      try {
        if (root && root.DwfBoot && typeof root.DwfBoot.note === "function") root.DwfBoot.note("dwfui-require", msg);
        else if (typeof console !== "undefined" && console.warn) console.warn(msg);
      } catch { /* reporting must never be the thing that breaks boot */ }
      return false;
    }
    if (root) {
      root.__DWFUI_USAGE__ = root.__DWFUI_USAGE__ || {};
      root.__DWFUI_USAGE__[surface || "unknown"] = { version: VERSION, components: [...(names || [])] };
    }
    return true;
  }

  // The ONE place a curses index becomes a CSS colour. It returns `var(--df-cN, <default>)`, so the
  // live published palette wins and the stock hex is the offline floor. No local table anywhere else.
  function dfColor(index) {
    PALETTE_STATE.resolves++;                    // ordering evidence (see adoptVersionPalette)
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i > 15) return TOKENS.palette.df16[7]; // light gray fallback
    return `var(--df-c${i}, ${TOKENS.palette.df16[i]})`;
  }

  // ---- the palette must land before first paint -----------------------------------------------
  const PALETTE_STATE = { landed: false, source: "defaults", resolves: 0, paintedFirst: false };

  // Published as INLINE style on <html>, so it beats the :root defaults by specificity -- which is what
  // makes `var(--df-cN)` with no literal fallback correct everywhere. Idempotent; no-op without a DOM.
  function applyPalette(palette) {
    if (!Array.isArray(palette) || typeof document === "undefined" || !document.documentElement)
      return false;
    const rootEl = document.documentElement;
    let n = 0;
    for (let i = 0; i < 16 && i < palette.length; i++) {
      const rgb = palette[i];
      if (!Array.isArray(rgb) || rgb.length < 3) continue;
      const [r, g, b] = rgb.map(v => Math.max(0, Math.min(255, Number(v) | 0)));
      rootEl.style.setProperty(`--df-c${i}`, `rgb(${r},${g},${b})`);
      n++;
    }
    if (n > 0 && !PALETTE_STATE.landed) {
      PALETTE_STATE.landed = true;
      PALETTE_STATE.source = "handshake";
      PALETTE_STATE.paintedFirst = PALETTE_STATE.resolves > 0;
      if (PALETTE_STATE.paintedFirst) {
        try {
          const B = (root && root.DwfBoot) || (typeof window !== "undefined" && window.DwfBoot);
          if (B && B.note) B.note("palette-late",
            PALETTE_STATE.resolves + " colour(s) resolved before the gps->uccolor handshake landed; "
            + "a modded data/init/colors.txt was painted with the stock palette on those");
        } catch { /* the applied palette remains authoritative even if its late note fails */ }
      }
    }
    return n > 0;
  }

  // Safe to call again: applyPalette is idempotent and the state latches once.
  function adoptVersionPalette(sourcePromise) {
    const p = sourcePromise !== undefined ? sourcePromise
      : (typeof window !== "undefined" ? window.__dwfVersionPromise : null);
    if (!p) return false;
    if (typeof p.then !== "function") { return applyPalette(p && p.palette); }
    try {
      p.then(function (info) {
        try { applyPalette(info && info.palette); }
        catch (error) { DwfErr.report("dwfui.adopt-palette", error); }
      }, function () { /* no handshake means the stock palette remains authoritative */ })
        .catch(error => DwfErr.report("dwfui.palette-promise", error));
      return true;
    } catch { return false; }
  }

  // Self-install at module load, before every panel module. Guarded so a headless import is a no-op.
  try { adoptVersionPalette(); }
  catch (error) { DwfErr.report("dwfui.palette-boot", error); }

  // Cut to the budget, then overwrite the final three characters with dots. NOT `fitNativeLabel`:
  // there is no abbreviation pass here, and the two laws produce different strings over the budget.
  function hardCutDots(text, budget) {
    const value = String(text == null ? "" : text);
    const cells = Math.max(0, Math.floor(Number(budget) || 0));
    if (value.length <= cells) return value;
    if (cells <= 3) return ".".repeat(cells);
    return value.slice(0, cells - 3) + "...";
  }

  // The two budgets native uses on the Tasks list; the worker budget is the name-to-button gap minus 7.
  const TASKS_TEXT_BUDGETS = { job: 23, worker: 30 };

  // CONTROLS ARE OMITTED, NEVER DISABLED: a disabled control advertises a write native does not offer.
  // Pure and DOM-free; an absent wire field can only SUPPRESS a control, never invent one.
  const TASK_CONTROLS = [
    { key: "recenterBuilding", x: 0x1e, hover: "INFO_RECENTER_ON_JOB_BUILDING" },
    { key: "jobDetails", x: 0x21, hover: "INFO_JOB_DETAILS" },
    { key: "toggleRepeat", x: 0x24, hover: "INFO_TOGGLE_JOB_REPEAT", toggle: "repeat" },
    { key: "removeWorker", x: 0x27, hover: "INFO_REMOVE_JOB_WORKER" },
    { key: "suspendJob", x: 0x2a, hover: "INFO_SUSPEND_JOB", toggle: "suspend" },
    { key: "cancelJob", x: 0x2d, hover: "INFO_CANCEL_JOB" },
  ];
  function taskControlGate(key, job) {
    const f = (job && job.flags) || {};
    const holder = (job && job.holder) || null;
    // A building is a PRODUCTION HOLDER only when finished and of the right type. The wire must decide
    // this -- the browser cannot re-derive a trap_type it is never sent.
    const production = !!(holder && holder.finished && holder.productionHolder);
    switch (key) {
      case "recenterBuilding": return !!holder;
      case "jobDetails":       return job ? job.detailsAvail === true : false;
      case "toggleRepeat":     return production && !f.byManager;
      case "removeWorker":     return !!(job && job.hasWorker) && !f.special && !f.dessource && !!holder;
      case "suspendJob":       return production;
      case "cancelJob":        return job ? job.cancelAvail === true : false;
      default: return false;
    }
  }
  function infoTaskControls(job) {
    const f = (job && job.flags) || {};
    return TASK_CONTROLS
      .filter(c => taskControlGate(c.key, job))
      .map(c => ({
        key: c.key, x: c.x, hover: c.hover,
        on: c.toggle ? !!f[c.toggle] : undefined,
      }));
  }

  // The recenter coordinate comes from the worker's own position unless it is contained, in which case
  // it is the container's. If neither yields one BOTH buttons are OMITTED, not drawn disabled.
  function infoTaskRecenterTarget(worker) {
    if (!worker) return null;
    const ok = p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) &&
      Number.isFinite(Number(p.z));
    if (worker.contained === true) {
      const held = worker.containerPos;
      return ok(held) ? { x: Number(held.x), y: Number(held.y), z: Number(held.z), via: "container" } : null;
    }
    const own = worker.pos;
    return ok(own) ? { x: Number(own.x), y: Number(own.y), z: Number(own.z), via: "unit" } : null;
  }

  // A 4-way decision in ONE fixed evaluation order. The frequency test EXCLUDES OneTime and Daily: a
  // daily order's next window is always imminent and a one-time order has no next window.
  const WORK_ORDER_WAITING_FREQUENCIES = ["Monthly", "Seasonally", "Yearly"];
  const WORK_ORDER_BADGES = [
    { key: "active", sprite: "WORK_ORDERS_ACTIVE", title: "Active" },
    { key: "waiting", sprite: "WORK_ORDERS_WAITING", title: "Waiting for its next window" },
    { key: "ready", sprite: "WORK_ORDERS_READY", title: "Ready" },
    { key: "checking", sprite: "WORK_ORDERS_CHECKING", title: "Checking its conditions" },
  ];
  // `now` is the CURRENT GAME DATE, so a replayed frame's badge depends on the captured year and tick.
  // An order with no served finish date can never satisfy the waiting step and correctly falls through.
  function workOrderStatusKey(order, now) {
    if (!order) return "checking";
    if (order.active === true) return "active";
    const fy = Number(order.finishYear);
    const ft = Number(order.finishYearTick);
    const ny = Number(now && now.year);
    const nt = Number(now && now.tick);
    const dated = Number.isFinite(fy) && Number.isFinite(ny) &&
      (fy > ny || (fy === ny && Number.isFinite(ft) && Number.isFinite(nt) && ft > nt));
    if (dated && WORK_ORDER_WAITING_FREQUENCIES.indexOf(String(order.frequency)) >= 0) return "waiting";
    const items = Array.isArray(order.itemConditions) ? order.itemConditions.length : 0;
    const orders = Array.isArray(order.orderConditions) ? order.orderConditions.length : 0;
    if (!items && !orders) return "ready";
    return "checking";
  }
  function workOrderBadgeHtml(order, now, opts) {
    const o = opts || {};
    const key = workOrderStatusKey(order, now);
    const badge = WORK_ORDER_BADGES.find(b => b.key === key) || WORK_ORDER_BADGES[3];
    return iconHtml({
      sprite: badge.sprite, cls: "work-order-status-icon" + (o.cls ? " " + o.cls : ""),
      title: badge.title, alt: badge.title,
      dataset: Object.assign({ dwfuiOrderStatus: key }, o.dataset),
    });
  }

  // Text-entry cursors blink on a WALL-CLOCK period, not game ticks, so the cursor keeps blinking
  // while the game is paused.
  const TEXT_CURSOR_PERIOD_MS = 1000;
  function textCursorVisible(nowMs) {
    const t = Number(nowMs == null ? (typeof Date !== "undefined" ? Date.now() : 0) : nowMs);
    if (!Number.isFinite(t)) return true;
    return (((t % TEXT_CURSOR_PERIOD_MS) + TEXT_CURSOR_PERIOD_MS) % TEXT_CURSOR_PERIOD_MS) < TEXT_CURSOR_PERIOD_MS / 2;
  }

  // ---- the emblem channel ----------------------------------------------------------------------
  const EMBLEM_ATLAS_TOKEN = "CUSTOM_SYMBOL";
  const EMBLEM_ATLAS_COLS = 12;          // PAGE_DIM_PIXELS 384x64 over TILE_DIM 32x32
  const EMBLEM_SYMBOL_COUNT = 23;        // CUSTOM_SYMBOL declarations in graphics_interface.txt
  const EMBLEM_ALPHA_SOLID = 255;        // `solid_texpos`
  const EMBLEM_ALPHA_BLENDED = 160;      // `blended_texpos` (0xA0)

  function _emblemChannel(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(0, Math.min(255, n)) : 0;
  }
  function emblemRgb(colour) {
    return { r: _emblemChannel(colour && colour.r), g: _emblemChannel(colour && colour.g),
      b: _emblemChannel(colour && colour.b) };
  }
  // "Never drawn": native's own predicate reads host memory a browser never receives, so the served
  // halves are used -- an out-of-range symbol, or an in-range one with both colour triples still zero.
  function emblemIsUnassigned(emblem, count) {
    if (!emblem) return true;
    const total = Number(count) > 0 ? Number(count) : EMBLEM_SYMBOL_COUNT;
    const symbol = Number(emblem.symbol);
    if (!Number.isFinite(symbol) || symbol < 0 || symbol >= total) return true;
    const fg = emblemRgb(emblem.fg), bg = emblemRgb(emblem.bg);
    return !fg.r && !fg.g && !fg.b && !bg.r && !bg.g && !bg.b;
  }
  // cfg: {symbol, fg, bg, blended (bool -> alpha 160), size (px, default 32), count, cls, dataset,
  //       title, alt, unassignedTitle}
  function emblemHtml(cfg) {
    const c = cfg || {};
    const size = Number(c.size) > 0 ? Math.round(Number(c.size)) : 32;
    const classes = ["dwfui-icon", "dwfui-emblem"];
    if (c.cls) classes.push(c.cls);
    const attrs = `${datasetAttrs(c.dataset)}${c.title ? ` title="${esc(c.title)}"` : ""}` +
      (c.alt ? ` role="img" aria-label="${esc(c.alt)}"` : ` aria-hidden="true"`);
    const box = ` style="--dwfui-icon-size:${size}px"`;
    if (emblemIsUnassigned(c, c.count)) {
      // FAIL HONEST, NEVER FAKE. This is the state where native would roll; we say so.
      const title = c.unassignedTitle ||
        "No emblem assigned yet -- Dwarf Fortress picks one the first time it draws this squad";
      return `<span class="${classes.join(" ")} dwfui-emblem--unassigned dwfui-icon--empty"${box}` +
        ` data-dwfui-emblem-unassigned="true" title="${esc(title)}"` +
        (c.alt ? ` role="img" aria-label="${esc(c.alt)}"` : ` aria-hidden="true"`) +
        `${datasetAttrs(c.dataset)}></span>`;
    }
    const fg = emblemRgb(c.fg), bg = emblemRgb(c.bg);
    return `<span class="${classes.join(" ")}" data-dwfui-emblem="${Number(c.symbol)}"` +
      ` data-dwfui-emblem-fg="${fg.r},${fg.g},${fg.b}"` +
      ` data-dwfui-emblem-bg="${bg.r},${bg.g},${bg.b}"` +
      ` data-dwfui-emblem-alpha="${c.blended ? EMBLEM_ALPHA_BLENDED : EMBLEM_ALPHA_SOLID}"` +
      ` data-dwfui-emblem-size="${size}"${box}${attrs}></span>`;
  }

  // The bake, at source resolution: every pixel becomes the foreground or background rgb at one alpha.
  const _emblemBakeCache = {};
  function _emblemBake(img, rec, symbol, fg, bg, alpha, doc) {
    const key = `${symbol}|${fg.r},${fg.g},${fg.b}|${bg.r},${bg.g},${bg.b}|${alpha}`;
    if (_emblemBakeCache[key]) return _emblemBakeCache[key];
    const tw = rec.w, th = rec.h;
    const scratch = doc.createElement("canvas");
    scratch.width = tw; scratch.height = th;
    const sctx = scratch.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    const sx = rec.cx + (symbol % EMBLEM_ATLAS_COLS) * tw;
    const sy = rec.cy + Math.floor(symbol / EMBLEM_ATLAS_COLS) * th;
    sctx.clearRect(0, 0, tw, th);
    sctx.drawImage(img, sx, sy, tw, th, 0, 0, tw, th);
    const pixels = sctx.getImageData(0, 0, tw, th);
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
      const set = data[i + 3] !== 0;          // ALPHA AS BOOLEAN
      data[i] = set ? fg.r : bg.r;
      data[i + 1] = set ? fg.g : bg.g;
      data[i + 2] = set ? fg.b : bg.b;
      data[i + 3] = alpha;                    // one constant byte
    }
    sctx.putImageData(pixels, 0, 0);
    _emblemBakeCache[key] = scratch;
    return scratch;
  }
  function _paintEmblem(node, rec, doc) {
    if (!rec || !rec.w || !rec.h || !root || !root.Image) return false;
    const symbol = Number(node.getAttribute("data-dwfui-emblem"));
    if (!Number.isFinite(symbol) || symbol < 0) return false;
    const parse = name => {
      const parts = String(node.getAttribute(name) || "").split(",");
      return { r: _emblemChannel(parts[0]), g: _emblemChannel(parts[1]), b: _emblemChannel(parts[2]) };
    };
    const fg = parse("data-dwfui-emblem-fg"), bg = parse("data-dwfui-emblem-bg");
    const alpha = _emblemChannel(node.getAttribute("data-dwfui-emblem-alpha"));
    const boxPx = Number(node.getAttribute("data-dwfui-emblem-size")) || 32;
    let canvas = node.querySelector("canvas.dwfui-emblem-canvas");
    if (!canvas) {
      canvas = doc.createElement("canvas");
      canvas.className = "dwfui-emblem-canvas";
      node.appendChild(canvas);
    }
    const iface = interfaceScale(doc), zoom = uiZoom(doc);
    const fit = Math.max(1, boxPx / Math.max(rec.w, rec.h));
    const cssW = rec.w * fit * iface, cssH = rec.h * fit * iface;
    const w = Math.max(1, Math.round(cssW * zoom)), h = Math.max(1, Math.round(cssH * zoom));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (canvas.style) {
      canvas.style.width = zoom === 1 ? "" : `${cssW}px`;
      canvas.style.height = zoom === 1 ? "" : `${cssH}px`;
    }
    const ctx = canvas.getContext("2d");
    const img = _sheetImage(rec.img);
    _whenLoaded(img, () => {
      _clearBrokenArt(canvas);
      const baked = _emblemBake(img, rec, symbol, fg, bg, alpha, doc);
      ctx.clearRect(0, 0, w, h);
      // NOT _bakeBlit: native's emblem has hard edges by construction.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(baked, 0, 0, baked.width, baked.height, 0, 0, w, h);
    }, () => _markBrokenArt(canvas, img), canvas);
    return true;
  }
  // Shaped like paintSprites' other passes and called from it, so any surface already running the
  // paint pass gets emblems for free.
  function paintEmblems(rootNode) {
    const host = rootNode || (typeof document !== "undefined" ? document : null);
    const chrome = root && root.DFChrome;
    if (!host || !host.querySelectorAll || !chrome || !chrome.getCell) return 0;
    const doc = (host.ownerDocument) || (host.nodeType === 9 ? host : null) ||
      (typeof document !== "undefined" ? document : null);
    const nodes = [];
    host.querySelectorAll("[data-dwfui-emblem]").forEach(node => nodes.push(node));
    if (!nodes.length) return 0;
    let painted = 0;
    const apply = rec => nodes.forEach(node => { if (_paintEmblem(node, rec, doc)) painted++; });
    const loaded = chrome.getCell(EMBLEM_ATLAS_TOKEN);
    if (loaded) apply(loaded);
    else if (chrome.loadMap) Promise.resolve(chrome.loadMap())
      .then(map => apply(map && map[EMBLEM_ATLAS_TOKEN]))
      .catch(error => DwfErr.report("dwfui.emblem-map", error));
    return painted;
  }

  // How many whole bitmap-text cells fit in a pixel box (8px per cell before the bitmap layer loads).
  function cellsForWidth(pixels, opts) {
    const bitmap = root.DFBitmapText;
    const cw = bitmap && typeof bitmap.measure === "function" ? bitmap.measure("", opts).cellW : 8;
    const n = Math.floor(Number(pixels) / cw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function cellsForElementWidth(clientPanel, opts) {
    const o = opts || {};
    if (!clientPanel) return o.unavailable;
    const content = typeof clientPanel.querySelector === "function"
      ? clientPanel.querySelector(o.content) : null;
    const width = Number(content && content.clientWidth > 0
      ? content.clientWidth : clientPanel.clientWidth);
    if (!(width > 0)) return o.unavailable;
    return Math.floor(width / (8 * interfaceScale(o.document)));
  }

  // The source caption is immutable in data-dwfui-fit-original, so re-fitting always starts from the
  // full caption and widening restores it. DOM writes are conditional, so a same-width callback is a no-op.
  function _nativeFitNodes(scope) {
    if (!scope) return [];
    const selector = "[data-dwfui-fit-native-label]";
    const nodes = [];
    if (scope.matches && scope.matches(selector)) nodes.push(scope);
    if (scope.querySelectorAll) scope.querySelectorAll(selector).forEach(node => nodes.push(node));
    return nodes;
  }
  function _nativeFitHost(label) {
    const kind = label.getAttribute("data-dwfui-fit-host") || "parent";
    return kind === "tab" && label.closest ? label.closest(".dwfui-tab") : label.parentElement;
  }
  function refitNativeLabels(scope) {
    const labels = _nativeFitNodes(scope);
    let changed = 0;
    const budgets = [];
    for (const label of labels) {
      const host = _nativeFitHost(label);
      if (!host || !host.getBoundingClientRect) continue;
      const width = host.getBoundingClientRect().width;
      if (!(width > 0)) continue; // a closed sheet is not a zero-cell sheet
      const doc = label.ownerDocument || (typeof document !== "undefined" ? document : null);
      const reserve = Math.max(0,
        Math.floor(Number(label.getAttribute("data-dwfui-fit-reserve-cells")) || 0));
      const budget = Math.max(0, cellsForWidth(width, { doc }) - reserve);
      const original = label.getAttribute("data-dwfui-fit-original") || "";
      const fitted = fitNativeLabel(original, budget);
      budgets.push({ original, fitted, budget, width, reserve });
      if (label.getAttribute("data-dwfui-fit-budget") !== String(budget))
        label.setAttribute("data-dwfui-fit-budget", String(budget));
      if (setBitmapText(label, fitted)) changed++;
    }
    if (changed) paintBitmapText(scope);
    return { labels: labels.length, changed, budgets };
  }
  // Observe one stable surface host, not every replaceable caption: the unit sheet rebuilds its DOM on
  // refresh, so one observer on #selection keeps reopening idempotent and retains no old tab nodes.
  function mountNativeLabelFitting(scope) {
    if (!scope) return null;
    refitNativeLabels(scope);
    if (scope.__dwfuiNativeLabelFitResizeObserver)
      return scope.__dwfuiNativeLabelFitResizeObserver;
    const doc = scope.ownerDocument || (scope.nodeType === 9 ? scope : null);
    const view = doc && doc.defaultView;
    const RO = (view && view.ResizeObserver) ||
      (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
    if (!RO || !scope.getBoundingClientRect) return null;
    const observer = new RO(() => refitNativeLabels(scope));
    observer.observe(scope);
    scope.__dwfuiNativeLabelFitResizeObserver = observer;
    return observer;
  }

  const TextLaw = {
    hardCutDots, abbreviateThenCut: fitNativeLabel, fitRuntime: refitNativeLabels, mountFitting: mountNativeLabelFitting,
  };
  // ===============================================================================================

  // NO COMMENTS INSIDE THE OBJECT LITERAL BELOW: the drift guard parses the exports by splitting it
  // on commas and taking each chunk's first identifier, so a comment hides the real export name.
  const api = {
    VERSION,
    TOKENS,
    esc, sentenceCase, bitmapTextHtml, setBitmapText, wrapToColumns, bitmapProseHtml, rawHtml,
    triState: { stateFor: triStateFor, fromAgg: triStateFromAgg, markHtml: triMarkHtml },
    rowHtml, actionButtonsHtml, toolButtonHtml, tabsHtml, nonNativeTabsHtml, cyclerHtml, occupantListHtml, occupantRailHtml, textInputHtml, searchHtml, scrollHtml, headerHtml,
    plaqueBtnHtml, lightPlaqueHtml, nativeFrameHtml, nativeCellRunsHtml, frameNineSlice, glyphBoxButton, artBtnHtml, accessPolicyButtonsHtml, sideWindowHtml, messageBoxHtml, statTileHtml, barRowHtml,
    windowHtml, stepperHtml, numberEntryHtml, clampNumberEntry, switchHtml, statusHtml, require: requireComponents,
    iconHtml, rowGroupHtml, checkHtml, latchHtml, segmentedHtml, modalHtml, confirmHtml, sortHeaderHtml,
    fitNativeLabel, cellsForElementWidth,
    LIST_BANDS, LIST_KEYS,
    admitRows, listGeometry, listBands, listPress, listDragPosition, listWheel, listKeyScroll,
    listHtml, mountLists, resetList, setListPosition,
    negotiateColumns, mountTableColumns,
    mountTabPromotion,
    filterChipsHtml,
    gridHtml, gridCellHtml, selectCellHtml, selectCellGroupHtml, workDetailSprite, workDetailIconHtml,
    zoneSprite, STOCKPILE_ICON_ROWS, stockpileIconCrop,
    DESIGNATION_PALETTES, hydrateDesignationPalettes, mountDesignationPalettes, placeDesignationPalettes,
    paintSprites, paintItemSprites, paintBitmapText, mountScrollbarArt, mountTabArt, mountPlaqueArt, mountButtonStateArt, restoreScroll, restoreSearchCaret, mountDom,
    SOFTEN, interfaceScale, uiZoom, setInterfaceScale,
    dfColor, applyPalette,
    hardCutDots, TASKS_TEXT_BUDGETS, infoTaskControls, infoTaskRecenterTarget,
    TextLaw,
    workOrderStatusKey, workOrderBadgeHtml, textCursorVisible,
    emblemHtml, paintEmblems, emblemIsUnassigned, emblemRgb, EMBLEM_SYMBOL_COUNT,
  };
  root.DWFUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
