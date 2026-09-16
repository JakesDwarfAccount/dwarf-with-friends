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

  // ---- Interactive Build menu, backed by /build-catalog and /build-place ----
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function") DWFUI.require("build-info-panels", [
    "actionButtonsHtml", "artBtnHtml", "bitmapTextHtml", "checkHtml", "frameNineSlice", "glyphBoxButton", "headerHtml", "iconHtml", "latchHtml", "nonNativeTabsHtml",
    "listHtml", "plaqueBtnHtml", "rawHtml", "rowGroupHtml", "rowHtml", "scrollHtml", "searchHtml", "sortHeaderHtml", "statusHtml", "stepperHtml",
    "tabsHtml", "windowHtml", "TOKENS",
  ]);
  // The one handle on the component layer: DWFUI is a browser global, so resolve the sibling module
  // when there is none (the offline fixtures require this file directly).
  const D = () => {
    if (typeof DWFUI !== "undefined" && DWFUI) return DWFUI;
    if (typeof window !== "undefined" && window && window.DWFUI) return window.DWFUI;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try { return require("./dwf-ui-components.js"); } catch { return null; }
    }
    return null;
  };
  if (typeof window !== "undefined") window.dwfuiAccessor = D;
  let buildCatalog = null;
  let activeBuildCategory = "";
  let selectedBuild = null;
  let buildDirection = 0;
  let buildOptions = null;
  let buildStatus = "";
  let buildStatusError = false;
  const MAT_PICK_RE = /^-?\d+:-?\d+(:-?\d+)?$/;
  const matPickValue = m => (m && m.itemType !== undefined && m.itemType !== null)
    ? `${Number(m.itemType)}:${Number(m.matType)}:${Number(m.matIndex)}`
    : `${Number(m.matType)}:${Number(m.matIndex)}`;
  // Player-facing item copy: the wire carries a few df::item_type tokens, native prints plural names.
  // Convert only at the presentation edge so the value sent back to DF stays exact.
  const BUILD_ITEM_CLASS_NAMES = {
    BUCKET: "buckets",
    CHAIN: "chains",
    TRAPPARTS: "mechanisms",
  };
  function capitaliseBuildName(value) {
    const text = String(value == null ? "" : value).trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
  }
  function buildItemClassName(value, material) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
      // CHAIN is the requirement's broad item type, not the item's class: the material decides whether
      // the row prints "chain" (inorganic) or "rope" (plant/creature textile).
    if (raw.toUpperCase() === "CHAIN")
      return material && material.matType !== undefined && material.matType !== null
        ? (Number(material.matType) === 0 ? "chains" : "ropes")
        : "chains";
    return BUILD_ITEM_CLASS_NAMES[raw.toUpperCase()] ||
      raw.replace(/_/g, " ").toLowerCase();
  }
  // The item's own name wins; the slot label never renames it ("Almond wood", "Pig tail rope").
  const matPickLabel = m => {
    const name = String((m && m.name) || "").trim();
    const cls = buildItemClassName(m && m.className, m);
    const singular = cls.replace(/s$/i, "");
    const namedClass = !!name && !!cls &&
      new RegExp(`(?:^|\\s)${singular.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?$`, "i").test(name);
    return capitaliseBuildName(namedClass || !cls ? name : `${name} ${cls}`.trim());
  };
  let buildMaterials = null;       // { requirements: [{index,label,quantity,pinned,materials:[...]}] }
  let buildMatPicks = {};          // reqIndex -> "itemType:matType:matIndex" | "closest"
  let buildMaterialsToken = "";    // token buildMaterials was loaded for (guards stale responses)
  let lastBuildPicksByToken = {};  // token -> last per-requirement picks (DF-style "use last material")
  // "" is the top-level view; otherwise the subgroup id the user drilled into. Reset to "" whenever
  // the build menu re-opens or the active top category changes.
  let activeBuildGroup = "";
  // ---- the build flow is a three-node state machine over one integer ---------------------------
  // Mirror native's `bottom_mode_selected` exactly, so the three surfaces cannot drift into a fourth.
  const BUILD_MODE = { NONE: -1, MENU: 0, PLACEMENT: 1, MATERIALS: 2 };
  let buildMode = BUILD_MODE.NONE;
  // Three mutually exclusive material modes; "last" is conditional -- see buildLastMaterialOffer.
  // Native's `use_same_material` is dead in the build and is deliberately not implemented.
  let buildMaterialMode = "select"; // "select" | "closest" | "last"
  // UI-DIV-008: native zero-inits this to false, DWF ships it ON. It persists across placements and
  // across closing the build UI.
  let keepBuildingAfterPlacement = true;
  // Native stashes three placement integers; DWF's wire identity for that triple is the catalog token.
  let buildArmedToken = "";
  // `reqIndex` selects the requirement being satisfied, `selIndex` the highlighted row inside it.
  let buildPicker = null; // { item, params, requirements:[...], reqIndex, selIndex, picks:{} }
  let buildPickerSerial = 0;
  const prepareBuildPicker = picker => {
    if (picker && !picker.scrollKey) picker.scrollKey = `build-picker-${++buildPickerSerial}`;
    return picker;
  };
  // DWF's only producer is a refused POST /build-place, one stage after native fills these. Empty
  // means "the server has not objected", never "we did not ask".
  let buildPlacementErrors = [];
  let buildPlacementWarnings = [];
  // Which half of the map's column span the picker lands on; false is native's default (right-hand).
  let buildPickerFlipped = false;

  function defaultBuildOptions() {
    return {
      hollow: 0,
      weapon_count: 1,
      plate_units: 1,
      plate_water: 0,
      plate_magma: 0,
      plate_track: 0,
      plate_citizens: 0,
      plate_resets: 1,
      unit_min: 1,
      unit_max: 1000000,
      water_min: 1,
      water_max: 7,
      magma_min: 1,
      magma_max: 7,
      track_min: 1,
      track_max: 1000000,
      track_dump: 0,
      dump_x: 0,
      dump_y: 0,
      friction: 50000,
      speed: 50000
    };
  }

  // ---- the category grid is pure arithmetic ----------------------------------------------------
  // One cell size for the whole client: DwfGrid.BASE_CELL. BUILD_CELL is an alias kept for imports.
  const BUILD_PAGE_STATUS = { NONE: -1, FULL: 0, ICONS_ONLY: 1, OFF: 2 };
  // An ICONS_ONLY page costs a flat 5 columns; turning it OFF removes 6 (its 5 plus its separator).
  const BUILD_ICONS_ONLY_WIDTH = 5;

  // The block the grid is negotiated inside: rows [gridY*3/5, gridY-4], columns [mapLeft+4, mapRight-3].
  function buildBlockRect(gridX, gridY, mapLeft = 0, mapRight = null) {
    const right = mapRight == null ? Math.max(0, Number(gridX) - 1) : Number(mapRight);
    return {
      sx: Number(mapLeft) + 4, ex: right - 3,
      sy: Math.floor(Number(gridY) * 3 / 5), ey: Number(gridY) - 4,
    };
  }
  // The grid is NOT derived here: dwf-grid.js owns cells-to-pixels for the whole client -- the base
  // cell, the interface scale, the in-client zoom, the DPR, the rounding seam, and gridX/gridY.
  const G = () => {
    if (typeof DwfGrid !== "undefined" && DwfGrid) return DwfGrid;
    if (typeof window !== "undefined" && window && window.DwfGrid) return window.DwfGrid;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try { return require("./dwf-grid.js"); } catch { return null; }
    }
    return null;
  };
  // DF's authoring cell, aliased from DwfGrid; the literal is a fallback for a lost load order.
  const BUILD_CELL = (G() && G().BASE_CELL) || { w: 8, h: 12 };
  // READ THE GRID THROUGH DwfGrid, never by measuring here: `zoom:` on #clientPanel makes a raw
  // innerHeight division short by the zoom factor, and native truncates one cell pair for the screen.
  function buildGrid() {
    const g = G();
    // The minimum legal screen: a client that cannot measure still lays out against a grid native accepts.
    const floors = { gridX: 114, gridY: 46 };
    if (!g) return floors;
    try {
      const live = typeof document !== "undefined" && document && document.defaultView
        ? g.refresh(document) : g.compute(g.measure(null));
      return { gridX: live.gridX, gridY: live.gridY };
    } catch { return floors; }
  }
  // Buttons are THREE grid rows tall, so a column holds (ey-sy-1)/3 of them, floored, minimum 1.
  function buildColumnHeight(block) {
    return Math.max(1, Math.floor((Number(block.ey) - Number(block.sy) - 1) / 3));
  }
  // column_width = min(35, longest label + 6).
  function buildColumnWidth(labels) {
    let longest = 0;
    for (const label of (labels || [])) longest = Math.max(longest, String(label == null ? "" : label).length);
    return Math.min(35, longest + 6);
  }

  // Negotiate against the INTERSECTION of native's block span and the CSS clamp on `.build-block`:
  // against the span alone every page stays FULL and overflow:hidden crops the rightmost one.
  const BUILD_DOCK_PX_AT_SCALE_1 = 34;   // --panel-dock-left: a 32px alert badge + a 2px gap
  function buildPaintableCells(opts) {
    const o = opts || {};
    const cell = Math.max(1, Number(o.cellW) || 0);
    const scale = Number(o.interfaceScale) > 0 ? Number(o.interfaceScale) : 1;
    const viewport = Number(o.viewportW);
    // Headless: no painted box to intersect with, so the offline arithmetic keeps the span alone.
    if (!isFinite(viewport) || viewport <= 0) return Infinity;
    const dock = Math.max(6, BUILD_DOCK_PX_AT_SCALE_1 * scale);
    return Math.max(0, Math.floor((viewport - 2 * dock) / cell));
  }
  // The RAW viewport width, not the zoom-divided one: `100vw` inside a `zoom:`ed container still
  // resolves to the window's own width, which is the number the CSS clamp uses.
  function buildPaintableCellsLive() {
    const g = G();
    if (!g) return Infinity;
    try {
      const live = typeof document !== "undefined" && document && document.defaultView
        ? g.refresh(document) : g.get();
      return buildPaintableCells({ viewportW: live.viewportW, cellW: live.cellW,
        interfaceScale: live.interfaceScale });
    } catch { return Infinity; }
  }

  // The negotiated width must FOLLOW the window: buildMenuLayout runs only on a redraw, so without
  // this subscription a menu left open across a resize keeps the width it was born with.
  let buildGeometryWatched = false;
  let buildGeometryKey = "";
  function watchBuildGeometry() {
    if (buildGeometryWatched || typeof window === "undefined") return;
    buildGeometryWatched = true;
    const relayout = () => {
      // Mode 0 only: modes 1 and 2 are a fixed 56-cell box that scales through CSS, and re-rendering
      // them on a resize would disturb an in-flight material pick.
      if (!clientPanel || !clientPanel.classList.contains("build-panel")) return;
      if (buildMode !== BUILD_MODE.MENU && buildMode !== BUILD_MODE.NONE) return;
      const { gridX, gridY } = buildGrid();
      if (`${gridX}x${gridY}@${buildPaintableCellsLive()}` === buildGeometryKey) return;
      renderBuildPanel();
    };
    if (window.DwfGrid && typeof window.DwfGrid.onChange === "function")
      window.DwfGrid.onChange(relayout, document);
    // DwfGrid's event compares the CELL and the GRID DIMS only, and the painted box also depends on
    // the viewport and the dock -- so these two listeners are the rest of it, not redundancy.
    window.addEventListener("resize", relayout);
    if (typeof MutationObserver === "function" && document.documentElement) {
      try {
        new MutationObserver(relayout).observe(document.documentElement,
          { attributes: true, attributeFilter: ["style", "data-dwfui-interface-scale"] });
      } catch { globalThis.DwfErr?.count("build-panel.layout-observer"); }
    }
  }

  // Per-page column widths, ONE shared column height, and the FULL -> ICONS_ONLY -> OFF ladder in
  // native's own shape: ascending order, re-measured after every page, breaking at the immune page.
  function buildMenuLayout(pages, block, selectedIndex, limitCells) {
    const list = Array.isArray(pages) ? pages : [];
    const span = Math.max(0, Number(block.ex) - Number(block.sx) + 1);
    const limit = Number(limitCells);
    const available = isFinite(limit) ? Math.max(0, Math.min(span, limit)) : span;
    const baseHeight = buildColumnHeight(block);
    const plan = list.map(page => {
      const labels = Array.isArray(page.labels) ? page.labels : [];
      return {
        id: page.id, label: page.label, count: labels.length,
        // Clamped down to the button count: a page with 3 buttons is 3 rows tall, not 12.
        columnHeight: Math.max(1, Math.min(baseHeight, labels.length || 1)),
        columnWidth: buildColumnWidth(labels),
        columns: 0, status: BUILD_PAGE_STATUS.FULL,
      };
    });
    // One shared height, then every page re-columned against it: a SHORT page gets WIDE, not short.
    const maxHeight = plan.reduce((a, p) => Math.max(a, p.columnHeight), 1);
    for (const p of plan) p.columns = Math.max(1, Math.ceil(p.count / maxHeight));
    // One column of separator for every page but the immune one, which is the vector's LAST entry;
    // `selectedIndex` names it explicitly and is clamped so it can never point off the end.
    const immune = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < plan.length
      ? selectedIndex : plan.length - 1;
    const widthOf = p => {
      if (p.status === BUILD_PAGE_STATUS.OFF) return 0;
      const body = p.status === BUILD_PAGE_STATUS.ICONS_ONLY
        ? BUILD_ICONS_ONLY_WIDTH * p.columns : p.columnWidth * p.columns;
      return body + (p === plan[immune] ? 0 : 1);
    };
    const total = () => plan.reduce((a, p) => a + widthOf(p), 0);
    // Ascending page order, re-measured after every page, and BREAK at the immune page -- never step
    // past it. The same pages, block and immune index always demote the same pages in the same order.
    for (const step of [BUILD_PAGE_STATUS.ICONS_ONLY, BUILD_PAGE_STATUS.OFF]) {
      for (let i = 0; i < plan.length && total() > available; i++) {
        if (i === immune) break;
        plan[i].status = step;
      }
    }
    return { available, span, limit: isFinite(limit) ? limit : null, immune,
      maxHeight, totalWidth: total(), pages: plan, block };
  }

  // ---- the placement panel's geometry ----------------------------------------------------------
  // Top row 4, 56 columns wide, controls 3 rows tall; the +3 term is the CONDITIONAL third radio.
  const BUILD_PLACE_PANEL = { top: 4, width: 56 };
  function buildPlacementLayout(opts) {
    const o = opts || {};
    const T = BUILD_PLACE_PANEL.top;
    const L = Number(o.left) || 0;
    const R = L + BUILD_PLACE_PANEL.width - 1;
    const lastRadio = !!o.lastMaterialOffered;
    const rows = [
      { id: "material-after", x0: L + 2, x1: R - 2, y0: T + 4 },
      { id: "material-closest", x0: L + 2, x1: R - 2, y0: T + 7 },
    ];
    // When the third radio appears the panel grows by 3 rows and everything below shifts down 3.
    if (lastRadio) rows.push({ id: "material-last", x0: L + 2, x1: R - 2, y0: T + 10 });
    // The tick box is only FOUR columns wide -- a compact box, not a full-width row.
    rows.push({ id: "keep-building", x0: L + 2, x1: L + 5, y0: lastRadio ? T + 13 : T + 10 });
    const cursor = T + (Number(o.warnings) || 0) + (Number(o.errors) || 0) + 4 +
      (o.upStairAtViewZ ? 1 : 0) + 10 + (lastRadio ? 3 : 0);
    return { left: L, right: R, top: T, cursor, width: BUILD_PLACE_PANEL.width, controls: rows,
      // A catch-all rectangle over the panel keeps a click that missed a control off the map.
      catchAll: { x0: L, x1: R, y0: T, y1: cursor } };
  }

  // ---- the building-specific sub-panel and the 8-way direction picker -------------------------
  // Present only for these types, or Trap (23) with subtype 1 (weapon trap) or 5 (track stop).
  const BUILD_SUBPANEL_TYPES = new Set([19, 22, 33, 41, 43, 50]); // Bridge, SiegeEngine, ScrewPump,
                                                                  // AxleHorizontal, WaterWheel, Rollers
  function buildSubPanelRect(type, subtype, mapRight) {
    const t = Number(type), s = Number(subtype);
    const trap = t === 23 && (s === 1 || s === 5);
    if (!BUILD_SUBPANEL_TYPES.has(t) && !trap) return null;
    let left = Number(mapRight) - 0x1C - 0x2D;
    if (t === 23 && s === 1) left -= 4;
    const height = (t === 23 && s === 1) ? 0x29 : (t === 23 && s === 5) ? 0x14 : 16;
    return { left, top: 4, height, width: 0x2D + (t === 23 && s === 1 ? 4 : 0) };
  }
  // SiegeEngine (22) holds EIGHT direction buttons in a single row, 4 columns each; storing i sets
  // buildreq.direction. Type 41 (horizontal axle) gets a different, non-8-way control.
  function buildDirectionButtonRect(rect, i) {
    const n = Number(i);
    return { x0: rect.left + 4 * n + 2, x1: rect.left + 4 * n + 5, y0: rect.top + 5, y1: rect.top + 7 };
  }
  function buildDirectionRects(rect, count = 8) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(buildDirectionButtonRect(rect, i));
    return out;
  }

  // ---- the placement prompt is composed, not fixed ---------------------------------------------
  // Every fragment is a literal from .rdata; the double space in "operator.  Choose" is native.
  const BUILD_PROMPT = {
    place: "Click a tile to place the ",
    end: "Click a tile to be one end of the ",
    corner: "Click a tile to be a corner of the ",
    spansOpen: "(spans ", spansClose: " levels)",
    mustSpan: "Must span multiple elevations",
    // The two nouns the non-default heads pair with, and the stop.
    stairs: "Stairs", track: "Track", period: ".",
  };
  // Two of the three heads pair with a LITERAL noun, not the button's caption: native prints
  // "...one end of the Stairs." for every stair variant. Where the level suffix sits is not decoded.
  function buildPromptText(item, levels) {
    const label = String((item && item.label) || "building");
    const lower = label.toLowerCase();
    const stairs = /stair/.test(lower);
    const track = /^track\b/.test(lower) && lower !== "track stop";
    const head = stairs ? BUILD_PROMPT.end : track ? BUILD_PROMPT.corner : BUILD_PROMPT.place;
    const noun = stairs ? BUILD_PROMPT.stairs : track ? BUILD_PROMPT.track : buildDisplayName(item);
    const n = Number(levels);
    const span = Number.isFinite(n) && n > 1 ? ` ${BUILD_PROMPT.spansOpen}${n}${BUILD_PROMPT.spansClose}` : "";
    return `${head}${noun}${BUILD_PROMPT.period}${span}`;
  }
  // Per-building advisory blocks, verbatim, keyed by (type, subtype); each entry is its lines in order.
  const BUILD_ADVISORY = [
    { type: 22, subtype: 0, lines: ["A catapult's orientation cannot be changed", "once it is placed."] },
    { type: 22, subtype: 1, lines: ["A bolt thrower can be freely turned by the",
                                    "operator.  Choose a resting orientation."] },
    { type: 41, lines: ["Horizontal axles can vary in length.", "Set the orientation below."] },
    { type: 43, lines: ["Water wheels are 1x3 or 3x1.", "The long side should align", "with the water's flow."] },
    { type: 33, lines: ["Set the liquid flow direction below.",
                        "Water flows from the adjacent input tile",
                        "and from the tile below the input tile."] },
    { type: 50, lines: ["Minecart rollers can vary in length.", "Set the orientation and speed below."] },
  ];
  function buildAdvisoryLines(item) {
    const t = Number(item && item.type), s = Number(item && item.subtype);
    for (const entry of BUILD_ADVISORY) {
      if (entry.type !== t) continue;
      if (entry.subtype !== undefined && entry.subtype !== s) continue;
      return entry.lines;
    }
    return [];
  }

  // The conditional third radio needs all three: a remembered item search, EXACTLY ONE item
  // requirement, and a remembered filter that matches it. Null when it is not offered.
  function buildLastMaterialOffer(item, materials, remembered) {
    if (!item || !materials || !Array.isArray(materials.requirements)) return null;
    const reqs = materials.requirements.filter(r => r && !r.pinned);
    if (reqs.length !== 1) return null;
    const last = remembered && remembered[item.token];
    const value = last && last[reqs[0].index];
    if (!value) return null;
    const match = (Array.isArray(reqs[0].materials) ? reqs[0].materials : [])
      .find(m => matPickValue(m) === value);
    if (!match) return null;
    return { value, label: matPickLabel(match) || value, reqIndex: Number(reqs[0].index) };
  }

  // ---- the material picker is a tall side panel that dodges the building ----------------------
  // A full-height column over one HALF of the map, on whichever half the building is NOT on.
  function buildPickerRect(gridX, gridY, opts) {
    const o = opts || {};
    const A = Number(o.mapLeft) || 0;
    const B = o.mapRight == null ? Math.max(0, Number(gridX) - 1) : Number(o.mapRight);
    const outerLeft = A + 4;
    const outerRight = B - 28;
    const half = Math.floor(((outerRight - outerLeft) + 1) * 5 / 10);
    const mid = outerLeft + half;
    const flipped = !!o.flipped;
    const L = flipped ? outerLeft + 2 : mid + 2;
    const R = flipped ? mid - 2 : outerRight - 2;
    // The 2-column scrollbar gutter is charged out of R only once the content is taller than a page.
    const visibleRows = Math.max(1, Math.floor((Number(gridY) - 15) / 3) - 1);
    const pageRows = visibleRows * 3;
    return { outerLeft, outerRight, mid, half, flipped,
      left: L, right: R, top: 4, bottom: Number(gridY) - 4,
      // The FILL spans [L-2, R+2] x [4, gridY-4]: the panel is wider than its content column.
      fillLeft: L - 2, fillRight: R + 2,
      visibleRows, pageRows };
  }
  // Kept separate from the rect so a caller can ask the question without re-deriving the rect.
  function buildPickerScrollNeeded(rowCount, pageRows) {
    return (3 * Math.max(0, Number(rowCount) || 0)) > (Number(pageRows) || 0);
  }

  // ---- the picker header names the BUILDING, never the slot ------------------------------------
  // Two verbatim .rdata lines, both at x = L; the second is ALWAYS present.
  const BUILD_PICKER_HEAD = {
    select: "Select materials for the ", period: ".",
    amount: "Amount needed: ", to: " to ",
  };
  function buildPickerHeadLines(item, req) {
    const name = buildDisplayName(item);
    const required = buildSlotRequired(req);
    // WIRE GAP (DEF-067): count_max is not on /build-materials at all, so the " to <max>" arm can
    // never fire -- rendered honestly as the single-count form rather than guessed.
    const max = Number(req && req.countMax);
    const range = Number.isFinite(max) && max > required
      ? `${BUILD_PICKER_HEAD.to}${max}` : "";
    return [
      `${BUILD_PICKER_HEAD.select}${name}${BUILD_PICKER_HEAD.period}`,
      `${BUILD_PICKER_HEAD.amount}${required}${range}`,
    ];
  }
  // The client's -1 "area" sentinel means "as many as the dragged rectangle needs"; treat it as one.
  function buildSlotRequired(req) {
    const q = Number(req && req.quantity);
    return Number.isFinite(q) && q > 0 ? q : 1;
  }

  // Native folds the on-hand count INTO the name as a bracketed suffix and OMITS the bracket for a
  // singleton: `Bayberry wood buckets` beside `Fungiwood buckets [16]`.
  function buildPickRowName(label, count) {
    const n = Number(count);
    const text = String(label == null ? "" : label);
    return Number.isFinite(n) && n > 1 ? `${text} [${n}]` : text;
  }

  // The catalog's menu caption is not always the building's own name, which the prompt and the picker
  // header both use. Restore the repeated noun only for workshops; leave complete names untouched.
  function buildDisplayName(item) {
    const label = String((item && item.label) || "building").trim() || "building";
    if (Number(item && item.type) !== 13 || /\b(workshop|forge)\b/i.test(label)) return label;
    return `${label}${/s$/i.test(label) ? "'" : "'s"} Workshop`;
  }

  // Native prints the decorated item name -- material plus building noun in the quality grammar.
  const BUILD_QUALITY_WRAP = {
    1: ["-", "-"],
    2: ["+", "+"],
    3: ["*", "*"],
    4: ["\u2261", "\u2261"],
    5: ["\u263c", "\u263c"],
  };
  function buildCandidateName(item, candidate) {
    const base = capitaliseBuildName(
      `${String((candidate && candidate.material) || "Unknown material").trim()} ` +
      `${String((item && item.label) || "item").trim()}`);
    const wrap = BUILD_QUALITY_WRAP[Number(candidate && candidate.quality)];
    return wrap ? `${wrap[0]}${base}${wrap[1]}` : base;
  }
  // A live case-insensitive SUBSTRING hide: non-matching rows do not count toward the scroll height.
  const BUILD_PICKER_FILTER_MAX = 76;
  function buildPickerFilter(choices, needle) {
    const list = Array.isArray(choices) ? choices : [];
    const q = String(needle == null ? "" : needle).trim().toLowerCase();
    if (!q) return list;
    return list.filter(c => String((c && c.label) || "").toLowerCase().includes(q));
  }
  // Per-row column anchors in cells off the content bounds; the multi-count shape narrows the
  // clickable body to leave room for the three controls.
  function buildPickRowColumns(rect, required) {
    const R = Number(rect.right), L = Number(rect.left);
    const multi = Number(required) >= 2;
    return multi
      ? { multi: true, used: R - 30, dist: R - 22, minus: R - 12, all: R - 8, none: R - 4,
          bodyLeft: L + 2, bodyRight: R - 13 }
      : { multi: false, used: R - 22, dist: R - 14, minus: null, all: null, none: null,
          bodyLeft: L + 2, bodyRight: R };
  }

  function allBuildItems() {
    return Array.isArray(buildCatalog?.items) ? buildCatalog.items : [];
  }

  function allBuildCategories() {
    return Array.isArray(buildCatalog?.categories) ? buildCatalog.categories : [];
  }

  // Re-bucket for DISPLAY only: the server sends every item with correct placement metadata, so the
  // native Constructions grouping is a client-side re-home plus drill-down folders.
  const B79_CONSTRUCTION_REHOME = {
    "wall grate": true, "floor grate": true, "vertical bars": true, "floor bars": true, // Doors -> Constructions
    "glass window": true, "gem window": true,                                            // Furniture -> Constructions
    "support": true, "bridge": true,                                                     // Machines -> Constructions
    "track stop": true,                                                                  // Traps -> Constructions
  };
  const NATIVE_MENU_REHOME = {
    "weapon rack": "military",
    "armor stand": "military",
  };
  // Collapsible subgroups inside Constructions (native shows one row that opens a submenu).
  const B79_CONSTRUCTION_GROUPS = [
    { id: "stairs", label: "Stairs" },
    { id: "track",  label: "Track" },
  ];
  function b79ConstructionGroupFor(label) {
    const s = String(label == null ? "" : label).toLowerCase();
    if (s === "up stair" || s === "down stair" || s === "up/down stair") return "stairs";
    if (s.startsWith("track ") && s !== "track stop") return "track"; // Track N / Track ramp N-S / ...
    return ""; // direct top-level Constructions entry
  }

  // Pure and DOM-free, so the offline fixture can re-bucket a /build-catalog payload without a browser.
  function normalizeBuildCatalog(catalog) {
    if (!catalog || typeof catalog !== "object") return catalog;
    const items = Array.isArray(catalog.items) ? catalog.items : [];
    const cats = Array.isArray(catalog.categories) ? catalog.categories : [];
    // Re-home the mis-filed items into Constructions, then tag each with its drill-down subgroup.
    for (const item of items) {
      if (!item) continue;
      const label = String(item.label == null ? "" : item.label).toLowerCase();
      if (NATIVE_MENU_REHOME[label]) item.category = NATIVE_MENU_REHOME[label];
      else if (B79_CONSTRUCTION_REHOME[label]) item.category = "constructions";
      if (item.category === "constructions") item.group = b79ConstructionGroupFor(item.label);
    }
    // Recompute category totals and Construction subgroup counts.
    const catCount = {};
    const consGroupCount = {};
    for (const item of items) {
      if (!item || !item.category) continue;
      catCount[item.category] = (catCount[item.category] || 0) + 1;
      if (item.category === "constructions" && item.group)
        consGroupCount[item.group] = (consGroupCount[item.group] || 0) + 1;
    }
    for (const cat of cats) {
      if (!cat) continue;
      cat.count = catCount[cat.id] || 0;
      if (cat.id === "constructions") {
        cat.groups = B79_CONSTRUCTION_GROUPS
          .filter(g => (consGroupCount[g.id] || 0) > 0)
          .map(g => ({ id: g.id, label: g.label, count: consGroupCount[g.id] }));
      }
    }
    return catalog;
  }

  async function loadBuildMaterials(item) {
    const token = item && item.token;
    if (!token) { buildMaterials = null; buildMaterialsToken = ""; return; }
    try {
      const r = await fetch(`/build-materials?token=${encodeURIComponent(token)}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      // Ignore a stale response if the player has since picked a different building.
      if (selectedBuild && selectedBuild.token === token) {
        buildMaterials = data && data.ok ? data : null;
        buildMaterialsToken = token;
        const last = lastBuildPicksByToken[token];
        if (last && buildMaterials && Array.isArray(buildMaterials.requirements)) {
          buildMatPicks = {};
          for (const req of buildMaterials.requirements) {
            const v = last[req.index];
            if (!v || req.pinned) continue;
            const avail = Array.isArray(req.materials) &&
              req.materials.some(m => matPickValue(m) === v);
            if (avail) buildMatPicks[req.index] = v;
          }
        }
        if (clientPanel.classList.contains("build-panel")) renderBuildPanel();
      }
    } catch {
      if (selectedBuild && selectedBuild.token === token) { buildMaterials = null; buildMaterialsToken = token; }
    }
  }

  function selectBuildItem(item, preserveOptions = false) {
    if (typeof window !== "undefined" && typeof window.DFCancelBuildCornerAnchor === "function")
      window.DFCancelBuildCornerAnchor();
    selectedBuild = item || null;
    buildOptions = preserveOptions && buildOptions ? buildOptions : defaultBuildOptions();
    buildMatPicks = {};
    buildMaterials = null;
    buildMaterialsToken = "";
    if (item) loadBuildMaterials(item);
    const dirs = Array.isArray(item?.directions) ? item.directions : [];
    buildDirection = dirs.length ? Number(dirs[0].value) : 0;
    // Arming a NEW building drops any previous refusal: the errors box belongs to a placement, not
    // to the session.
    buildStatus = "";
    buildStatusError = false;
    buildPlacementErrors = [];
    buildPlacementWarnings = [];
    currentTool = null;
    selectedDesignation = null;
    digMenuOpen = false;
    plantMenuOpen = false;
    smoothMenuOpen = false;
    itemDesigMenuOpen = false; // close the item/building-designations submenu too
    stockPreset = null;
    stockRepaintId = null;
    if (typeof stockPalette !== "undefined") stockPalette.hidden = true;
    zonePreset = null;
    if (typeof zonePalette !== "undefined") zonePalette.hidden = true;
    zoneOverlayEnabled = false;
    currentZones = [];
    renderZoneOverlay();
    updateDesignationButtons();
    updateToolCursor();
  }

  // Items in view: a flyout category's top level shows direct entries only, a drilled-in subgroup
  // shows just its members, and a flat category shows everything.
  function buildItemsInView() {
    return allBuildItems().filter(item =>
      item.category === activeBuildCategory && (item.group || "") === (activeBuildGroup || ""));
  }

  // NATIVE PRE-ARMS NOTHING. Opening a level must not select an item: that paints a selection the
  // player never made, and fires loadBuildMaterials for it.
  function chooseFirstBuildInCategory() {
    const stillInView = selectedBuild && selectedBuild.category === activeBuildCategory &&
      (selectedBuild.group || "") === (activeBuildGroup || "");
    if (!stillInView) selectBuildItem(null);
  }

  async function openBuildPanel() {
    setActiveToolbar("build");
    // Installed from the one entry into the build UI, never at module init, so the listener cannot
    // depend on load order; watchBuildGeometry is idempotent, so re-opening costs nothing.
    watchBuildGeometry();
    activeBuildGroup = "";
    buildMode = BUILD_MODE.MENU;
    buildPicker = null;
    clientPanel.className = "visible build-panel build-panel-mode-0";
    // The pre-fetch placeholder wears the same chrome the loaded menu does: none.
    panelContent(clientPanel).innerHTML =
      `<div class="build-window build-mode-menu" data-build-mode="0"><div class="build-body"></div></div>`;
    try {
      const r = await fetch(`/build-catalog?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      buildCatalog = normalizeBuildCatalog(await r.json());
      const cats = allBuildCategories();
      if (!activeBuildCategory || !cats.some(c => c.id === activeBuildCategory))
        activeBuildCategory = cats[0]?.id || "";
      chooseFirstBuildInCategory();
      renderBuildPanel();
    } catch {
      buildStatus = "Building catalog unavailable";
      buildStatusError = true;
      renderBuildPanel();
    }
  }

  // The nine live DF top categories; furnaces, farming, clothing, siege and track are folded into
  // Workshops' nested flyout, Constructions or Military.
  const CAT_ICON = { workshops:"workshops", furniture:"furniture", doors:"doors_hatches",
    constructions:"walls_floors", machines:"machines_fluids", cages:"cages_restraint",
    traps:"traps", military:"military", trade:"trade_depot" };
  // Icons for the subgroup folder rows: three Workshops folders plus Stairs and Track.
  const GROUP_ICON = { clothing:"workshops_clothing", farming:"workshops_farming", furnaces:"workshops_furnaces",
    stairs:"stairs", track:"track" };
  // Ordered keyword -> icon name; first substring match on the item label wins, else the category icon.
  const ITEM_ICON_KW = [
    ["throne","chair"],["chair","chair"],["bed","bed"],["table","table"],["chest","box"],["coffer","box"],
    ["box","box"],["cabinet","cabinet"],["coffin","coffin"],["casket","coffin"],["slab","slab"],
    ["statue","statue"],["armor stand","armor_stand"],["weapon rack","weapon_rack"],["traction","traction_bench"],
    ["bookcase","bookcase"],["display","display_furniture"],["offering","offering_place"],["instrument","instrument"],
    ["hatch","hatch"],["door","door"],["floodgate","floodgate"],["floor grate","grate_floor"],["wall grate","grate_wall"],
    ["grate","grate_floor"],["vertical bars","bars_vertical"],["floor bars","bars_floors"],["bars","bars_vertical"],
    ["gem window","window_gem"],["glass window","window_glass"],["window","window_glass"],["nest","nest_box"],["hive","hive"],
    ["fortification","fortification"],["paved road","road_paved"],["dirt road","road_dirt"],["road","road_paved"],
    ["bridge","bridge"],["wall","wall"],["floor","floor"],["ramp","ramp"],["stair","stairs"],["support","support"],
    ["track stop","track_stop"],["rollers","rollers"],["track","track"],["lever","lever"],["pressure plate","pressure_plate"],
    ["well","well"],["screw pump","screw_pump"],["water wheel","water_wheel"],["windmill","windmill"],
    ["gear","gear_assembly"],["horizontal axle","axle_horizontal"],["vertical axle","axle_vertical"],["axle","axle_horizontal"],
    ["millstone","workshop_millstone"],["quern","workshop_quern"],
    ["cage trap","trap_cage"],["weapon trap","trap_weapon"],["stone-fall","trap_stone"],["stone fall","trap_stone"],
    ["animal trap","animal_trap"],["cage","cage"],["chain","restraint"],["rope","restraint"],["restraint","restraint"],
    ["archery","archery_target"],["weapon rack","weapon_rack"],["ballista","ballista"],["catapult","catapult"],
    // `stoneworker` needs its own entry: the button caption is `Stoneworker`, which no other keyword
    // here matches, so the icon would fall back to the generic Workshops tile.
    ["carpenter","workshop_carpenter"],["stoneworker","workshop_mason"],["mason","workshop_mason"],
    ["metalsmith","workshop_metalsmith"],
    ["craftsdwarf","workshop_crafts"],["craft","workshop_crafts"],["jeweler","workshop_jeweler"],
    ["clothier","workshop_clothes"],["loom","workshop_loom"],["dyer","workshop_dyer"],["leather","workshop_leather"],
    ["tanner","workshop_tanner"],["still","workshop_still"],["kitchen","workshop_kitchen"],["butcher","workshop_butcher"],
    ["fishery","workshop_fishery"],["farmer","workshop_farmer"],["kennel","workshop_kennel"],["ashery","workshop_ashery"],
    ["bowyer","workshop_bowyer"],["mechanic","workshop_mechanic"],["siege","workshop_siege"],
    ["smelter","furnace_smelter"],["glass furnace","furnace_glass"],["kiln","furnace_kiln"],["wood furnace","furnace_wood"],
    ["farm plot","farm_plot"],["depot","trade_depot"]
  ];
  // An icon name is DF's own BUILDING_ICON_* token with the prefix dropped and lowercased.
  function bldIconToken(name) {
    return name ? `BUILDING_ICON_${String(name).toUpperCase()}` : "";
  }
  // building_icons.png's page grid, from tile_page_interface.txt's [PAGE_DIM_PIXELS:256:512].
  const BLD_ICON_SHEET_COLS = 8, BLD_ICON_SHEET_ROWS = 16;
  // The window-on-the-sheet renderer, for slots whose box is SMALLER than the 32px cell: the sprite
  // painters never draw below native size. `px` is the tile size, and the caller's box must match it.
  function bldIconStyle(name, px) {
    const chrome = typeof window !== "undefined" ? window.DFChrome : null;
    const cell = chrome?.getCell?.(bldIconToken(name));
    if (!cell) return "";
    const col = cell.cx / cell.w, row = cell.cy / cell.h;
    return `background-image:url(/asset/${cell.img});` +
           `background-size:${BLD_ICON_SHEET_COLS*px}px ${BLD_ICON_SHEET_ROWS*px}px;` +
           `background-position:-${col*px}px -${row*px}px;background-repeat:no-repeat;image-rendering:auto`;
  }
  function itemIconName(item) {
    const s = String((item && item.label) || "").toLowerCase();
    for (const [kw, name] of ITEM_ICON_KW) if (s.includes(kw)) return name;
    const c = (item && item.category) ? CAT_ICON[String(item.category).toLowerCase()] : null;
    return c || null;
  }
  // The active category's subgroup metadata: Workshops' comes from the server, Constructions' is
  // added client-side by normalizeBuildCatalog. A flat category returns [].
  function currentCategoryGroups() {
    const cats = allBuildCategories();
    const cat = cats.find(c => c.id === activeBuildCategory);
    return Array.isArray(cat && cat.groups) ? cat.groups : [];
  }
  // A flat row on the block's near-black field: no plaque, no border, no bevel. `kind` is load-bearing
  // paint -- "page" opens a level (cyan caption), "item" places a building (white).
  function buildGridButtonHtml(item, selectedToken) {
    const kind = item.kind === "page" ? "page" : "item";
    const ic = kind === "page"
      ? (CAT_ICON[String(item.id || item.token || "").toLowerCase()] ||
         GROUP_ICON[String(item.id || item.token || "").toLowerCase()] || itemIconName(item))
      : itemIconName(item);
    const open = kind === "page" ? !!item.open : item.token === selectedToken;
    return DWFUI.rowHtml({
      tag: "button", layout: "icon", selected: open,
      cls: `build-btn build-btn--${kind}${open ? " active" : ""}`,
      dataset: kind === "page"
        ? (item.level === 0 ? { buildCat: item.id } : { buildGroup: item.id })
        : { buildToken: item.token },
      title: item.label || "",
      iconCfg: ic ? { sprite: bldIconToken(ic), cls: "build-btn-ico" } : null,
      copyCls: "build-btn-copy", labelCls: "build-btn-label",
      label: item.label || "Building",
    });
  }

  // A CASCADE LEVEL, not a category -- see buildCascadeLevels.
  function buildPageHtml(page, plan, items, selectedToken, maxHeight) {
    if (plan.status === BUILD_PAGE_STATUS.OFF)
      return `<div class="build-page off" data-build-page="${escapeHtml(page.id)}" data-build-page-status="off"></div>`;
    const sel = page.selected ? " active-page" : "";
    // ICONS_ONLY drops the CAPTION, not the rows, and its columns survive at five cells EACH. The
    // ladder's accounting charges a flat 5 per page, so a demoted multi-column page paints wider.
    if (plan.status === BUILD_PAGE_STATUS.ICONS_ONLY) {
      const strip = items.map(item => buildGridButtonHtml(item, selectedToken)).join("");
      const cols = Math.max(1, Number(plan.columns) || 1);
      return `<div class="build-page icons-only${sel}" data-build-page="${escapeHtml(page.id)}" ` +
        `data-build-page-status="icons-only" ` +
        `style="--build-page-cells:${BUILD_ICONS_ONLY_WIDTH * cols};` +
        `--build-col-cells:${BUILD_ICONS_ONLY_WIDTH}">` +
        `<div class="build-page-cols" style="--build-grid-rows:${maxHeight}">${strip}</div></div>`;
    }
    const body = items.map(item => buildGridButtonHtml(item, selectedToken)).join("");
    return `<div class="build-page full${sel}" data-build-page="${escapeHtml(page.id)}" data-build-page-status="full" ` +
      `style="--build-page-cells:${plan.columnWidth * plan.columns};--build-col-cells:${plan.columnWidth}">` +
      `<div class="build-page-cols" style="--build-grid-rows:${maxHeight}">${body}</div></div>`;
  }

  function buildMenuMarkup(view) {
    const v = view || {};
    const layout = v.layout || { pages: [], maxHeight: 1 };
    const pages = Array.isArray(v.pages) ? v.pages : [];
    // One column of separator per non-selected page, and it is a real element rather than a border:
    // a border cannot be one CELL wide at every interface scale.
    const sepHtml = '<div class="build-sep" aria-hidden="true"></div>';
    const body = pages.map((page, i) => {
      const plan = layout.pages[i] || { status: BUILD_PAGE_STATUS.FULL, columnWidth: 12, columns: 1 };
      const html = buildPageHtml(page, plan, page.items || [], v.selectedToken, layout.maxHeight);
      return (plan.status === BUILD_PAGE_STATUS.OFF || page.selected) ? html : html + sepHtml;
    }).join("");
    return `<div class="build-block" style="` +
      `--build-cell-w:var(--dwfui-cell-drawn-w, calc(${BUILD_CELL.w}px * var(--dwfui-interface-scale, 1)));` +
      `--build-cell-h:var(--dwfui-cell-drawn-h, calc(${BUILD_CELL.h}px * var(--dwfui-interface-scale, 1)));` +
      `--build-grid-rows:${layout.maxHeight || 1};` +
      `--build-block-cells:${layout.available || 0}">${body}</div>`;
  }

  // ---- the cascade: what a "page" actually holds -----------------------------------------------
  // Level 0 is the category list; opening one appends a block, drilling a subgroup appends a third.
  function buildCascadeLevels(opts) {
    const o = opts || {};
    const cats = Array.isArray(o.categories) ? o.categories : [];
    const activeCat = o.activeCategory || "";
    const activeGroup = o.activeGroup || "";
    const groups = Array.isArray(o.groups) ? o.groups : [];
    const levels = [];
    const asPage = (id, label, level) => ({ id, token: `page:${id}`, label, kind: "page", level });
    const allItems = Array.isArray(o.allItems) ? o.allItems : [];
    // Trade depot is native's one terminal root row: a white leaf that arms the depot directly rather
    // than promising a submenu holding the same single row.
    levels.push({
      id: "root", label: "Buildings", level: 0,
      items: cats.map(cat => {
        const terminal = cat.id === "trade"
          ? allItems.find(item => item && item.category === cat.id) : null;
        return terminal
          ? Object.assign({}, terminal, { kind: "item", level: 0 })
          : Object.assign(asPage(cat.id, cat.label || cat.id, 0),
              { open: cat.id === activeCat });
      }),
    });
    if (!activeCat) return levels;
    // Level 1: the open category -- subgroup folders (cyan) ahead of its direct entries (white).
    const catLabel = (cats.find(c => c.id === activeCat) || {}).label || activeCat;
    levels.push({
      id: activeCat, label: catLabel, level: 1,
      items: groups.map(group => Object.assign(asPage(group.id, group.label || group.id, 1),
        { open: group.id === activeGroup }))
        // Native keeps the parent page's complete button vector drawn while the child is open.
        .concat(Array.isArray(o.directItems) ? o.directItems : []),
    });
    // Level 2: the open subgroup's members. Terminal -- every button places a building.
    if (activeGroup) {
      const g = groups.find(x => x.id === activeGroup) || {};
      levels.push({ id: activeGroup, label: g.label || activeGroup, level: 2,
        items: Array.isArray(o.groupItems) ? o.groupItems : [] });
    }
    for (const level of levels) {
      level.labels = level.items.map(i => i.label);
      level.selected = false;
    }
    // The never-degraded page is the DEEPEST open level, the one the player is reading right now.
    levels[levels.length - 1].selected = true;
    return levels;
  }

  // Older callers hand this builder a flat {categories, items} view; derive the page plan for them,
  // because there must stay exactly ONE layout implementation and it is buildMenuLayout.
  function buildPanelView(view) {
    const v = Object.assign({}, view || {});
    if (v.placementHtml == null && v.detailHtml != null) v.placementHtml = v.detailHtml;
    if (v.mode == null)
      v.mode = (v.placementHtml ? BUILD_MODE.PLACEMENT : BUILD_MODE.MENU);
    if (!Array.isArray(v.pages)) {
      const cats = Array.isArray(v.categories) ? v.categories : [];
      const items = Array.isArray(v.items) ? v.items : [];
      const active = v.activeCategory || (cats[0] && cats[0].id) || "";
      const group = v.activeGroup || "";
      const groups = Array.isArray((cats.find(c => c.id === active) || {}).groups)
        ? cats.find(c => c.id === active).groups : [];
      v.pages = buildCascadeLevels({
        categories: cats, activeCategory: active, activeGroup: group, groups,
        allItems: items,
        directItems: items.filter(i => i.category === active && !(i.group || "")),
        groupItems: items.filter(i => i.category === active && (i.group || "") === group),
      });
    }
    if (!v.layout) {
      const block = v.block || buildBlockRect(160, 50);
      // `limitCells` is Infinity headless, so a fixture stating only a block negotiates against it alone.
      v.layout = buildMenuLayout(v.pages, block,
        Math.max(0, v.pages.findIndex(p => p.selected)),
        v.limitCells == null ? buildPaintableCellsLive() : v.limitCells);
    }
    return v;
  }

  function buildPanelMarkup(rawView) {
    const v = buildPanelView(rawView);
    const modeCls = v.mode === BUILD_MODE.PLACEMENT ? "build-mode-placement"
      : v.mode === BUILD_MODE.MATERIALS ? "build-mode-materials" : "build-mode-menu";
    const body = v.mode === BUILD_MODE.PLACEMENT ? (v.placementHtml || "")
      : v.mode === BUILD_MODE.MATERIALS ? (v.pickerHtml || "")
      : buildMenuMarkup(v);
  // NO title bar, search field, close tile, footer or Cancel button: none appears in any native build
  // capture. A mode-0 catalog failure is the only surviving status line; `build-panel` is closeless.
    const showStatus = v.status && v.mode === BUILD_MODE.MENU && v.statusError;
    const status = showStatus
      ? `<div class="build-status error">${escapeHtml(v.status)}</div>` : "";
    return `<div class="build-window ${modeCls}" data-build-mode="${Number(v.mode)}">` +
      `<div class="build-body">${status}${body}</div></div>`;
  }

  function renderBuildPanel() {
    const cats = allBuildCategories();
    const items = allBuildItems();
    if (!activeBuildCategory && cats.length)
      activeBuildCategory = cats[0].id;
    const shownItems = buildItemsInView();
    if (selectedBuild && !items.some(item => item.token === selectedBuild.token))
      selectedBuild = null;

    // Subgroup folders are just level-1 buttons of kind "page". Native has no back row: the parent
    // level is still on screen to the left.
    const groups = currentCategoryGroups();

    const selectedToken = selectedBuild?.token || "";
    // A CELL IS A CHARACTER and the grid is counted in SCALED cells, by DwfGrid, for every screen:
    // dividing the viewport by the unscaled cell hands buildMenuLayout more columns than exist.
    const { gridX, gridY } = buildGrid();
    const block = buildBlockRect(gridX, gridY);
    const pages = buildCascadeLevels({ categories: cats, activeCategory: activeBuildCategory,
      activeGroup: activeBuildGroup, groups, allItems: allBuildItems(),
      directItems: allBuildItems().filter(item =>
        item.category === activeBuildCategory && !(item.group || "")),
      groupItems: shownItems });
    const selectedIndex = Math.max(0, pages.findIndex(p => p.selected));
    const paintable = buildPaintableCellsLive();
    const layout = buildMenuLayout(pages, block, selectedIndex, paintable);
    // The geometry this layout was negotiated against; watchBuildGeometry re-renders when it stops holding.
    buildGeometryKey = `${gridX}x${gridY}@${paintable}`;
    // The host's anchor is MODE-dependent -- mode 0 is bottom-centred over the map, mode 1 is top-left
    // at row 4 -- and one host cannot express both from a descendant's class, so the mode is stamped here.
    const liveMode = buildMode === BUILD_MODE.NONE ? BUILD_MODE.MENU : buildMode;
    clientPanel.className = `visible build-panel build-panel-mode-${Number(liveMode)}`;
    // Mode 2's host is a full-height half-width column over the map. Its four numbers are integer
    // arithmetic over the live grid, which a stylesheet cannot do, so they are solved here and passed as cells.
    const pickerRect = buildPickerRect(gridX, gridY, { flipped: buildPickerFlipped });
    if (buildPicker) buildPicker.rect = pickerRect;
    if (liveMode === BUILD_MODE.MATERIALS) {
      clientPanel.style.setProperty("--build-picker-left-cells", String(pickerRect.fillLeft));
      clientPanel.style.setProperty("--build-picker-cells",
        String(Math.max(1, pickerRect.fillRight - pickerRect.fillLeft + 1)));
      clientPanel.style.setProperty("--build-picker-top-cells", String(pickerRect.top));
      clientPanel.style.setProperty("--build-picker-rows", String(
        Math.max(1, pickerRect.bottom - pickerRect.top)));
      clientPanel.dataset.buildPickerSide = pickerRect.flipped ? "left" : "right";
    } else {
      for (const prop of ["--build-picker-left-cells", "--build-picker-cells",
        "--build-picker-top-cells", "--build-picker-rows"])
        clientPanel.style.removeProperty(prop);
      delete clientPanel.dataset.buildPickerSide;
    }
    panelContent(clientPanel).innerHTML = buildPanelMarkup({
      mode: liveMode,
      title: buildMode === BUILD_MODE.MATERIALS ? "Choose material"
        : buildMode === BUILD_MODE.PLACEMENT ? (selectedBuild?.label || "Place") : "Build",
      pages, layout, activeCategory: activeBuildCategory,
      selectedToken,
      placementHtml: selectedBuild ? renderBuildDetail(selectedBuild) : "",
      pickerHtml: buildPickerMarkup(buildPicker),
      status: buildStatus, statusError: buildStatusError,
    });
  // Single-node wiring goes through `bindOne`: this panel renders three different bodies, and a bare
  // querySelector().addEventListener() throws mid-block and silently drops every listener after it.
    const bindOne = (selector, type, handler) => {
      const node = clientPanel.querySelector(selector);
      if (node) node.addEventListener(type, handler);
      return node;
    };
    // One close, from every mode. Not a step back.
    bindOne("[data-build-close]", "click", event => {
      event.stopPropagation();
      closeBuildUi();
      focusPage();
    });
    // "Cancel" is the mouse spelling of Escape: it closes the WHOLE build UI, it does not step back.
    bindOne("[data-build-clear]", "click", event => {
      event.stopPropagation();
      closeBuildUi();
      focusPage();
    });
    // Mode 2 only: every keystroke re-runs the filter, a live substring hide rather than a submit.
    // `Enter` confirms nothing, which is what a text input in a non-form already does.
    bindOne("[data-build-pick-filter]", "input", event => {
      const input = event.currentTarget;
      const pos = input.selectionStart || 0;
      if (buildPicker) buildPicker.filter = String(input.value || "").slice(0, BUILD_PICKER_FILTER_MAX);
      renderBuildPanel();
      const next = clientPanel.querySelector("[data-build-pick-filter]");
      if (next) {
        next.focus();
        try { next.setSelectionRange(pos, pos); } catch { globalThis.DwfErr?.count("build-panel.search-caret"); }
      }
    });
    clientPanel.querySelectorAll("[data-build-cat]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      activeBuildCategory = button.dataset.buildCat || activeBuildCategory;
      activeBuildGroup = ""; // switching top category always returns to its top-level view
      selectedBuild = null;
      chooseFirstBuildInCategory();
      renderBuildPanel();
      focusPage();
    }));
    // Flyout navigation: a subgroup folder drills in, an empty data-build-group returns to the top level.
    clientPanel.querySelectorAll("[data-build-group]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      activeBuildGroup = button.dataset.buildGroup || "";
      selectedBuild = null;
      chooseFirstBuildInCategory();
      renderBuildPanel();
      focusPage();
    }));
    // Native encodes the three-way material radio as two booleans; the client keeps the resolved
    // three-state so an impossible both-set pair cannot be represented.
    clientPanel.querySelectorAll("[data-build-matmode]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const mode = button.dataset.buildMatmode;
      buildMaterialMode = (mode === "closest" || mode === "last") ? mode : "select";
      renderBuildPanel();
      focusPage();
    }));
    // DWFUI.checkHtml is a button carrying aria-pressed, so this is a `click`, not a `change`.
    const keepBuildingCheckbox = clientPanel.querySelector("[data-build-keep]");
    if (keepBuildingCheckbox) keepBuildingCheckbox.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      keepBuildingAfterPlacement = !keepBuildingAfterPlacement;
      renderBuildPanel();
      focusPage();
    });
    // Pressing a build button is the ONLY mode 0 -> 1 transition; it stashes the token the re-arm reads back.
    clientPanel.querySelectorAll("[data-build-token]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const item = allBuildItems().find(i => i.token === button.dataset.buildToken);
      if (!item) return;
      selectBuildItem(item);
      buildArmedToken = item.token;
      buildMode = BUILD_MODE.PLACEMENT;
      renderBuildPanel();
      focusPage();
    }));
    // Confirming a row does reqIndex++, selIndex = 0, then rebuilds for the next requirement or finalizes.
    clientPanel.querySelectorAll("[data-build-pick]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      confirmBuildPick(button.dataset.buildPick, button.dataset.buildPickItem);
    }));
    clientPanel.querySelectorAll("[data-build-dir]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      buildDirection = Number(button.dataset.buildDir);
      renderBuildPanel();
      focusPage();
    }));
    clientPanel.querySelectorAll("[data-build-toggle]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const key = button.dataset.buildToggle;
      buildOptions[key] = Number(button.dataset.value || 0);
      renderBuildPanel();
      focusPage();
    }));
    clientPanel.querySelectorAll("[data-build-dump]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      buildOptions.dump_x = Number(button.dataset.dumpX || 0);
      buildOptions.dump_y = Number(button.dataset.dumpY || 0);
      renderBuildPanel();
      focusPage();
    }));
    wireBuildNumberControls(clientPanel);
  }

  // N requirements show this picker N times, each resetting to the top. No Back control: Escape from
  // mode 2 closes the whole build UI. `rows:` is deliberately not passed -- this list is not row-quantised.
  function buildPickerMarkup(picker) {
    if (!picker || !Array.isArray(picker.requirements) || !picker.requirements.length) return "";
    const idx = Math.min(picker.reqIndex || 0, picker.requirements.length - 1);
    const req = picker.requirements[idx];
    const required = buildSlotRequired(req);
    const rect = picker.rect || buildPickerRect(114, 46, {});
    const cols = buildPickRowColumns(rect, required);
    const all = Array.isArray(req.choices) ? req.choices : [];
    const shown = buildPickerFilter(all, picker.filter);
    // The `Dist: N` column is ABSENT and stays absent until the wire can carry a real pathfinder cost
    // (DEF-068): a faked distance would make "Use closest material" and the list silently disagree.
    const rows = shown.map((choice, i) => DWFUI.rowHtml({
      tag: "button", cls: `build-pick${i === (picker.selIndex || 0) ? " active" : ""}`,
      dataset: { buildPick: String(req.index), buildPickItem: String(choice.value) },
      copyCls: "build-pick-text", labelCls: "build-pick-name",
      label: buildPickRowName(choice.label || "Material", choice.count),
    })).join("");
    const head = buildPickerHeadLines(picker.item, req)
      .map(line => `<div class="build-picker-line">${DWFUI.bitmapTextHtml(line)}</div>`).join("");
    // Three rows tall, the panel's full content width, a dim `...` placeholder, and a 76-character limit.
    const search = DWFUI.searchHtml({
      cls: "build-picker-search", inputCls: "build-picker-filter", dataAttr: "build-pick-filter",
      placement: "pane-header", magnifier: true, preserveKey: "build-picker-filter",
      value: picker.filter || "", placeholder: "...", ariaLabel: "Filter materials",
      maxLength: BUILD_PICKER_FILTER_MAX,
    });
    const body = rows || `<div class="build-picker-empty">${
      DWFUI.bitmapTextHtml("Nothing on hand for this requirement.")}</div>`;
    return `<div class="build-picker" data-build-picker-side="${rect.flipped ? "left" : "right"}" ` +
      `data-build-picker-required="${required}" ` +
      `data-build-picker-cells="${Math.max(0, rect.right - rect.left + 1)}" ` +
      `data-build-picker-multi="${cols.multi ? "1" : "0"}" ` +
      `data-build-picker-scroll="${buildPickerScrollNeeded(shown.length, rect.pageRows) ? "1" : "0"}">` +
      `<div class="build-picker-head">${head}</div>` +
      search +
      // Native rebuilds the list for every slot at scroll position 0, so the restoration key carries the
      // picker instance and the requirement: filtering keeps its place, the next slot starts at top.
      DWFUI.scrollHtml({ cls: "build-picker-rows",
        preserveKey: `${picker.scrollKey || "build-picker-static"}-slot-${idx}`,
        ariaLabel: "Material choices" }, body) +
      `</div>`;
  }

  function renderBuildDetail(item, state) {
    const s = state || {};
    const materials = Object.prototype.hasOwnProperty.call(s, "materials") ? s.materials : buildMaterials;
    const materialsToken = Object.prototype.hasOwnProperty.call(s, "materialsToken") ? s.materialsToken : buildMaterialsToken;
    const matPicks = s.matPicks || buildMatPicks;
    const materialMode = s.materialMode || buildMaterialMode;
    const options = s.options || buildOptions || defaultBuildOptions();
    const direction = Object.prototype.hasOwnProperty.call(s, "direction") ? s.direction : buildDirection;
    const keepBuilding = Object.prototype.hasOwnProperty.call(s, "keepBuilding") ? !!s.keepBuilding : keepBuildingAfterPlacement;
    const dirs = Array.isArray(item.directions) ? item.directions : [];
    // Prefer the live material list when it matches this building; else the catalog's plain "Material".
    const matReqs = (materials && materialsToken === item.token && Array.isArray(materials.requirements))
      ? materials.requirements : null;
    // The placement panel's control inventory is EXHAUSTIVE -- the material radios and the keep-building
    // tick, nothing else. Requirements are surfaced where native surfaces them: mode 2, one slot at a time.
    const eightWay = Number(item.type) === 22 && dirs.length === 8;
    const directionHtml = item.direction ? `
      <div class="build-section-title">Direction</div>
      <div class="build-dir-row${eightWay ? " build-dir-8way" : ""}"${eightWay ? ` data-build-dir-row="8way"` : ""}>
        ${dirs.map(dir => DWFUI.plaqueBtnHtml({
          cls: `build-dir${Number(dir.value) === Number(direction) ? " active" : ""}`,
          dataset: { buildDir: Number(dir.value) }, label: String(dir.label || dir.value),
        })).join("")}
      </div>` : "";
    const hollowHtml = item.hollow ? `
      <div class="build-section-title">Area</div>
      <div class="build-toggle-row">
        ${toggleButton("hollow", "Hollow", options)}
      </div>` : "";
    const weaponHtml = item.weaponCount ? `
      <div class="build-section-title">Weapons</div>
      <div class="build-num-grid">
        ${numInput("weapon_count", "Count", 1, 10, options)}
      </div>` : "";
    const pressureHtml = item.pressure ? `
      <div class="build-section-title">Triggers</div>
      <div class="build-toggle-row">
        ${toggleButton("plate_units", "Units", options)}
        ${toggleButton("plate_water", "Water", options)}
        ${toggleButton("plate_magma", "Magma", options)}
        ${toggleButton("plate_track", "Minecart", options)}
        ${toggleButton("plate_citizens", "Citizens", options)}
        ${toggleButton("plate_resets", "Resets", options)}
      </div>
      <div class="build-num-grid">
        ${stepperInput("unit_min", "Unit min", 0, 1000000, options)}
        ${stepperInput("unit_max", "Unit max", 0, 1000000, options)}
        ${stepperInput("water_min", "Water min", 0, 7, options)}
        ${stepperInput("water_max", "Water max", 0, 7, options)}
        ${stepperInput("magma_min", "Magma min", 0, 7, options)}
        ${stepperInput("magma_max", "Magma max", 0, 7, options)}
        ${stepperInput("track_min", "Cart min", 0, 1000000, options)}
        ${stepperInput("track_max", "Cart max", 0, 1000000, options)}
      </div>` : "";
    const dumpDir = `${Number(options.dump_x) || 0},${Number(options.dump_y) || 0}`;
    const dumpButton = (label, dx, dy) => DWFUI.plaqueBtnHtml({
      cls: `build-dir${dumpDir === `${dx},${dy}` ? " active" : ""}`,
      dataset: { buildDump: "", dumpX: dx, dumpY: dy }, label,
    });
    const trackHtml = item.trackStop ? `
      <div class="build-section-title">Track stop</div>
      <div class="build-toggle-row">
        ${toggleButton("track_dump", "Dump", options)}
      </div>
      <div class="build-dir-row">
        ${dumpButton("None", 0, 0)}
        ${dumpButton("N", 0, -1)}
        ${dumpButton("E", 1, 0)}
        ${dumpButton("S", 0, 1)}
        ${dumpButton("W", -1, 0)}
      </div>
      <div class="build-num-grid">
        ${stepperInput("friction", "Friction", 0, 50000, options)}
      </div>` : "";
    const speedHtml = item.speed ? `
      <div class="build-section-title">Speed</div>
      <div class="build-num-grid">
        ${stepperInput("speed", "Speed", 1000, 100000, options)}
      </div>` : "";
    // ---- mode 1: the placement panel -----------------------------------------------------------
    // No confirm button (placement commits on the MAP CLICK) and no Back control (Escape closes it all).
    const lastOffer = Object.prototype.hasOwnProperty.call(s, "lastOffer")
      ? s.lastOffer
      : buildLastMaterialOffer(item, matReqs ? materials : null, lastBuildPicksByToken);
    // WIRE GAP, DECLARED (DEF-069): native writes shortfalls before the picker opens; DWF has no
    // pre-commit validation route, so this box is a stage late, fed only by a refused POST /build-place.
    const errorLines = (Array.isArray(s.errorLines) ? s.errorLines : buildPlacementErrors)
      .filter(line => String(line || "").trim().length);
    const warningLines = (Array.isArray(s.warningLines) ? s.warningLines : buildPlacementWarnings)
      .filter(line => String(line || "").trim().length);
    const noticeHtml = (errorLines.length || warningLines.length)
      ? `<div class="build-notice" data-build-notice-errors="${errorLines.length}" ` +
        `data-build-notice-warnings="${warningLines.length}" role="alert">` +
        errorLines.map(line =>
          `<div class="build-notice-line error">${DWFUI.bitmapTextHtml(String(line))}</div>`).join("") +
        warningLines.map(line =>
          `<div class="build-notice-line warning">${DWFUI.bitmapTextHtml(String(line))}</div>`).join("") +
        `</div>`
      : "";
    const geom = buildPlacementLayout({ left: 0, lastMaterialOffered: !!lastOffer,
      warnings: warningLines.length, errors: errorLines.length,
      upStairAtViewZ: Number(item.type) === 34 && Number(item.subtype) === 5 });
    const advisory = buildAdvisoryLines(item);
    const advisoryHtml = advisory.length
      ? `<div class="build-advisory">${advisory.map(line =>
          `<div class="build-advisory-line">${DWFUI.bitmapTextHtml(line)}</div>`).join("")}</div>`
      : "";
    const radio = (mode, label, on) => DWFUI.selectCellHtml({
      selected: on, cls: `build-matmode build-matmode-${mode}`,
      dataset: { buildMatmode: mode }, ariaLabel: label,
    }, DWFUI.bitmapTextHtml(label, { cls: "build-matmode-label" }));
    const radios = DWFUI.selectCellGroupHtml(
      { cls: "build-placement-toggle", ariaLabel: "Material selection mode" },
      radio("select", "Select material after placement", materialMode === "select") +
      radio("closest", "Use closest material", materialMode === "closest") +
      // The third radio appears ONLY when the remembered filter is set, the building has exactly one
      // requirement, and that filter matches it.
      (lastOffer ? radio("last", `Use last material (${lastOffer.label})`, materialMode === "last") : ""));
    const placementHtml = `
      <div class="build-placement" data-build-panel-cells="${geom.width}" data-build-panel-cursor="${geom.cursor}">
        ${noticeHtml}
        ${advisoryHtml}
        <div class="build-placement-msg">${DWFUI.bitmapTextHtml(buildPromptText(item, s.levels))}</div>
        ${radios}
        <div class="build-keep-row">
          ${DWFUI.checkHtml({ checked: !!keepBuilding, dataset: { buildKeep: "" },
            title: "Keep building after placement", ariaLabel: "Keep building after placement" })}
          ${DWFUI.bitmapTextHtml("Keep building after placement", { cls: "build-keep-label" })}
        </div>
      </div>`;
    // The building-specific controls still render INLINE in the 56-column panel rather than in their
    // own frame off the map's right edge. NOT DONE, SAY IT PLAINLY: registered as DEF-070.
    return `
      ${placementHtml}
      ${directionHtml}
      ${hollowHtml}
      ${weaponHtml}
      ${pressureHtml}
      ${trackHtml}
      ${speedHtml}
    `;
  }

  function toggleButton(key, label, values) {
    const source = values || buildOptions || defaultBuildOptions();
    const on = Number(source[key] || 0) !== 0;
    return DWFUI.plaqueBtnHtml({
      cls: `build-toggle${on ? " active" : ""}`,
      dataset: { buildToggle: key, value: on ? 0 : 1 }, label,
    });
  }

  // The weapon count is the one raw numeric field left; the rest use the editable DWFUI stepper.
  function numInput(key, label, min, max, values) {
    const source = values || buildOptions || defaultBuildOptions();
    const value = Math.max(min, Math.min(max, Math.floor(Number(source[key] ?? min))));
    return `<label class="build-num-label">${escapeHtml(label)}<input class="build-num" data-build-num="${key}" type="number" min="${min}" max="${max}" value="${value}"></label>`;
  }

  function stepperInput(key, label, min, max, values) {
    const source = values || buildOptions || defaultBuildOptions();
    const value = Math.max(min, Math.min(max, Math.floor(Number(source[key] ?? min))));
    return DWFUI.stepperHtml({
      cls: "build-num-label", inputCls: "build-num", label, key, value, min, max,
      dataset: { buildNum: key },
      plusDataset: { buildNumStep: key, delta: 1 },
      minusDataset: { buildNumStep: key, delta: -1 },
    });
  }

  // The buttons dispatch `change` on the adjacent input, so every numeric build option is clamped
  // in this one listener rather than at each control.
  function wireBuildNumberControls(scope, values = buildOptions) {
    const commit = input => {
      const key = input.dataset.buildNum;
      const min = Number(input.min || 0);
      const max = Number(input.max || 1000000);
      const val = Math.max(min, Math.min(max, Math.floor(Number(input.value || 0))));
      values[key] = val;
      input.value = String(val);
      return val;
    };
    scope.querySelectorAll("[data-build-num]").forEach(input => {
      input.addEventListener("change", () => commit(input));
    });
    scope.querySelectorAll("[data-build-num-step]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const stepper = button.closest(".dwfui-stepper");
        const input = stepper?.querySelector("[data-build-num]");
        if (!input) return;
        input.value = String(Number(input.value || 0) + Number(button.dataset.delta || 0));
        const EventCtor = input.ownerDocument?.defaultView?.Event ||
          (typeof Event === "function" ? Event : null);
        if (EventCtor && typeof input.dispatchEvent === "function")
          input.dispatchEvent(new EventCtor("change", { bubbles: true }));
        else
          commit(input);
        const value = Number(input.value);
        const plus = stepper.querySelector(".dwfui-stepper-btn.plus");
        const minus = stepper.querySelector(".dwfui-stepper-btn.minus");
        if (plus) plus.disabled = value >= Number(input.max);
        if (minus) minus.disabled = value <= Number(input.min);
      });
    });
  }

  function clearBuildPlacement(render = true) {
    if (typeof window !== "undefined" && typeof window.DFCancelBuildCornerAnchor === "function")
      window.DFCancelBuildCornerAnchor();
    selectedBuild = null;
    buildStatus = "";
    buildStatusError = false;
    buildPicker = null;
    buildPlacementErrors = [];
    buildPlacementWarnings = [];
    // Disarming drops back to the grid. It does NOT clear the keep-building tick or the stashed
    // placement identity: the close path leaves buildreq stale and re-initialises it on the next entry.
    buildMode = BUILD_MODE.MENU;
    // Drop the browser-side footprint preview so it does not linger after cancel or place.
    if (typeof window !== "undefined" && window.DFPlacementCursor) window.DFPlacementCursor.clear();
    updateToolCursor();
    if (render && clientPanel.classList.contains("build-panel"))
      renderBuildPanel();
  }

  function appendBuildOptions(params, item) {
    const add = key => params.set(key, String(Math.floor(Number(buildOptions[key] ?? 0))));
    add("hollow");
    add("weapon_count");
    add("plate_units"); add("plate_water"); add("plate_magma"); add("plate_track");
    add("plate_citizens"); add("plate_resets");
    add("unit_min"); add("unit_max"); add("water_min"); add("water_max");
    add("magma_min"); add("magma_max"); add("track_min"); add("track_max");
    add("track_dump"); add("dump_x"); add("dump_y"); add("friction"); add("speed");
    // mat0..matN per requirement, or the literal "closest" which the backend resolves at placement time.
    if (buildMaterialMode === "closest") {
      // "Use closest material" auto-satisfies the picker, so mode 2 is never displayed.
      const reqs = (buildMaterials && selectedBuild && buildMaterialsToken === selectedBuild.token &&
        Array.isArray(buildMaterials.requirements)) ? buildMaterials.requirements : [];
      for (const req of reqs) {
        if (!req.pinned) params.set(`mat${Number(req.index)}`, "closest");
      }
    } else {
      for (const [idx, val] of Object.entries(buildMatPicks)) {
        if (MAT_PICK_RE.test(val)) params.set(`mat${Number(idx)}`, val);
      }
    }
  }

  async function submitBuildPlacement(item, baseParams, itemId) {
    const params = new URLSearchParams(baseParams);
    if (Number.isInteger(itemId) && itemId >= 0) params.set("item_id", String(itemId));
    try {
      const r = await fetch("/build-place?" + params.toString(), { method: "POST", cache: "no-store" });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text.trim() || "building failed");
      }
      const data = await r.json();
      buildStatus = "";
      buildStatusError = false;
      buildPlacementErrors = [];
      buildPlacementWarnings = [];
      if (item.token) lastBuildPicksByToken[item.token] = { ...buildMatPicks };
      finishBuildPlacement(item);
      loadHud();
    } catch (err) {
      // A refusal is an ERROR LIST, drawn as a box at the panel's top -- not a status sentence above
      // the prompt, which is a region native does not have.
      buildPlacementErrors = String(err.message || err || "Building failed")
        .replace(/^building failed:\s*/i, "")
        .split("\n").map(line => line.trim()).filter(Boolean);
      buildPlacementWarnings = [];
      buildStatus = "";
      buildStatusError = false;
      // A refused placement is not a completed one: stay in mode 1 with the same building armed.
      buildMode = BUILD_MODE.PLACEMENT;
      buildPicker = null;
      renderBuildPanel();
    }
  }

  // WIRE GAP (DEF-017): the server has no re-arm route at all, so the keep-building loop is owned by
  // the CLIENT -- correct for DWF anyway, since arming is per-player and per-camera.
  function finishBuildPlacement(item) {
    buildPicker = null;
    if (keepBuildingAfterPlacement && item && item.token) {
      // Re-arm the SAME stashed token, not a fresh menu.
      buildArmedToken = item.token;
      selectedBuild = item;
      buildMode = BUILD_MODE.PLACEMENT;
      updateToolCursor();
      renderBuildPanel();
      return;
    }
    // Clear: the whole build UI closes. Not "back to the grid".
    closeBuildUi();
  }

  // The ONE close: every build-UI dismissal routes through here and lands on mode NONE. Escape over
  // an ARMED placement is the exception -- controls-placement's build-armed rung steps back instead.
  function closeBuildUi() {
    selectedBuild = null;
    buildPicker = null;
    buildMode = BUILD_MODE.NONE;
    if (typeof window !== "undefined" && window.DFPlacementCursor) window.DFPlacementCursor.clear();
    updateToolCursor();
    if (typeof closeClientPanel === "function") closeClientPanel();
    if (typeof setActiveToolbar === "function") setActiveToolbar(null);
  }

  // Confirm one requirement: reqIndex++, selIndex = 0, then rebuild for the next one or finalize.
  function confirmBuildPick(reqIndexRaw, value) {
    const picker = buildPicker;
    if (!picker) return;
    const reqIndex = Number(reqIndexRaw);
    if (picker.itemIdPick) picker.itemId = Number(value);
    else if (MAT_PICK_RE.test(String(value || ""))) buildMatPicks[reqIndex] = String(value);
    picker.reqIndex += 1;
    picker.selIndex = 0;
    if (picker.reqIndex < picker.requirements.length) { renderBuildPanel(); return; }
    // Last requirement confirmed -> finalize, then the keep-building branch inside submitBuildPlacement.
    const params = new URLSearchParams(picker.params);
    appendBuildOptions(params, picker.item);
    submitBuildPlacement(picker.item, params, picker.itemId);
  }

  function buildPlacementBounds(a, b) {
    if (!a || !b) return null;
    const values = [a.x, a.y, b.x, b.y, a.w, a.h].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return { x1: Math.min(values[0], values[2]), y1: Math.min(values[1], values[3]),
      x2: Math.max(values[0], values[2]), y2: Math.max(values[1], values[3]),
      w: values[4], h: values[5] };
  }

  function buildPickerShouldFlip(rect, mapGridWidth) {
    const width = Number(mapGridWidth);
    if (!rect || !(width > 0)) return false;
    const centre = (Number(rect.x1) + Number(rect.x2)) / 2;
    return Number.isFinite(centre) && centre > width / 2;
  }

  async function placeBuildCells(a, b) {
    const item = selectedBuild;
    if (!item) return;
    const rect = buildPlacementBounds(a, b);
    if (!rect) return;
    const params = new URLSearchParams();
    params.set("player", player);
    params.set("px", String(rect.x1));
    params.set("py", String(rect.y1));
    params.set("px2", String(rect.x2));
    params.set("py2", String(rect.y2));
    params.set("w", String(rect.w));
    params.set("h", String(rect.h));
    params.set("token", item.token);
    params.set("direction", String(buildDirection));
    // A fresh commit clears the previous refusal: the errors box describes THIS placement.
    buildPlacementErrors = [];
    buildPlacementWarnings = [];
    // The picker column flips to whichever half of the viewport the BUILDING is not on. Solved at the
    // click, the only moment the build site is known, and before mode 2 renders.
    buildPickerFlipped = (() => {
      let mapGridWidth = 0;
      try {
        const tiles = typeof DwfTiles !== "undefined" ? DwfTiles : null;
        const rendered = tiles && typeof tiles.getRenderRect === "function"
          ? tiles.getRenderRect() : null;
        mapGridWidth = Number(rendered && rendered.gw) || 0;
      } catch { mapGridWidth = 0; }
      return buildPickerShouldFlip(rect, mapGridWidth);
    })();

    // The map click is the ONLY commit. Three exits: no item requirements -> finalize; closest/last
    // -> the picker is auto-satisfied; otherwise mode 2, one pass per requirement.
    if (buildMaterialMode !== "select") {
      appendBuildOptions(params, item);
      await submitBuildPlacement(item, params);
      return;
    }

    // Native furniture placement chooses a finished ITEM after the click: the same mode-2 stage with
    // a one-entry requirement list.
    let requirements = null;
    let itemIdPick = false;
    try {
      const r = await fetch("/place-candidates?token=" + encodeURIComponent(item.token), { cache: "no-store" });
      if (r.ok) {
        const data = await r.json();
        if (selectedBuild !== item) return; // ignore a stale post-click picker response
        if (data && data.ok && data.specificItem) {
          const candidates = Array.isArray(data.candidates) ? data.candidates : [];
          itemIdPick = true;
          requirements = [{
            index: 0, label: item.label || "Item",
            choices: candidates.map(c => ({
              value: String(Number(c.id)),
              label: buildCandidateName(item, c),
              count: null,
            })),
          }];
        }
      }
    } catch { globalThis.DwfErr?.count("build-panel.candidate-info"); }
    if (!requirements) {
      const live = (buildMaterials && buildMaterialsToken === item.token &&
        Array.isArray(buildMaterials.requirements)) ? buildMaterials.requirements : [];
      requirements = live.filter(req => req && !req.pinned && Array.isArray(req.materials) && req.materials.length)
        .map(req => ({
          // `quantity` is count_required, carried through so the header can print "Amount needed: N".
          index: Number(req.index), label: req.label || "Material",
          quantity: Number(req.quantity), countMax: null,
          choices: req.materials.map(m => ({ value: matPickValue(m), label: matPickLabel(m) || matPickValue(m),
            count: Number(m.count) || 0 })),
        }));
    }
    if (!requirements.length) {
      // A building with no item requirements skips the picker: always showing one shows an EMPTY one.
      appendBuildOptions(params, item);
      await submitBuildPlacement(item, params);
      return;
    }
    // The filter box is cleared ONCE, when the picker opens, and SURVIVES across slots -- its effect
    // is recomputed against each new list. `filter: ""` is that one clear.
    buildPicker = prepareBuildPicker({ item, params, requirements, reqIndex: 0, selIndex: 0, itemIdPick,
      itemId: undefined, filter: "" });
    buildMode = BUILD_MODE.MATERIALS;
    buildStatus = "";
    buildStatusError = false;
    renderBuildPanel();
  }

  async function placeBuildDrag(x1, y1, x2, y2) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    await placeBuildCells(a, b);
  }
  const buildPanelApi = { defaultBuildOptions, buildPanelMarkup, buildPanelView, renderBuildDetail,
    normalizeBuildCatalog, b79ConstructionGroupFor, buildPlacementBounds, verminCaption: (...args) => window.verminCaption(...args), verminBodyLines: (...args) => window.verminBodyLines(...args),
    verminSheetMarkup: (...args) => window.verminSheetMarkup(...args), plannedEngravingSheetMarkup: (...args) => window.plannedEngravingSheetMarkup(...args),
    // The pure arithmetic and composition rules, exported so the offline suite can check them.
    BUILD_MODE, BUILD_CELL, BUILD_PAGE_STATUS, BUILD_PLACE_PANEL, BUILD_PROMPT,
    buildBlockRect, buildColumnHeight, buildColumnWidth, buildMenuLayout, buildMenuMarkup,
    buildCascadeLevels, buildPaintableCells, buildPaintableCellsLive,
    buildPlacementLayout, buildSubPanelRect, buildDirectionButtonRect, buildDirectionRects,
    buildPromptText, buildAdvisoryLines, buildLastMaterialOffer, buildPickerMarkup,
    BUILD_PICKER_HEAD, BUILD_PICKER_FILTER_MAX,
    buildPickerRect, buildPickerScrollNeeded, buildPickerHeadLines, buildSlotRequired,
    buildPickRowName, buildPickerFilter, buildPickRowColumns, buildPickerShouldFlip,
    buildDisplayName, buildCandidateName, capitaliseBuildName, buildItemClassName, matPickLabel,
    // TEST SEAM: put this module into a given mode and ask it to draw itself against a real DOM, so a
    // wiring defect nothing that reads markup can see is exercised. It never bypasses a code path.
    __driveBuildPanelForTests(state) {
      const s = state || {};
      if (s.catalog !== undefined) buildCatalog = normalizeBuildCatalog(s.catalog);
      if (s.activeCategory !== undefined) activeBuildCategory = s.activeCategory;
      if (s.activeGroup !== undefined) activeBuildGroup = s.activeGroup;
      if (s.selected !== undefined) {
        selectedBuild = s.selected;
        // Mirror only the PANEL half of selectBuildItem: the tool half lives on dwf-core globals. With a
        // null buildOptions the first material commit throws inside appendBuildOptions.
        buildOptions = defaultBuildOptions();
        buildMatPicks = {};
      }
      if (s.picker !== undefined) buildPicker = prepareBuildPicker(s.picker);
      // The seam may set these because otherwise the only way to see either is to make the server refuse
      // a real placement on a live fort.
      if (s.errorLines !== undefined) buildPlacementErrors = Array.isArray(s.errorLines) ? s.errorLines : [];
      if (s.warningLines !== undefined) buildPlacementWarnings = Array.isArray(s.warningLines) ? s.warningLines : [];
      if (s.pickerFlipped !== undefined) buildPickerFlipped = !!s.pickerFlipped;
      if (s.mode !== undefined) buildMode = s.mode;
      if (s.keepBuilding !== undefined) keepBuildingAfterPlacement = s.keepBuilding;
      if (s.armedToken !== undefined) buildArmedToken = s.armedToken;
      renderBuildPanel();
      return { mode: buildMode, armedToken: buildArmedToken, selectedToken: selectedBuild && selectedBuild.token,
        keepBuilding: keepBuildingAfterPlacement, hasPicker: !!buildPicker,
        errors: buildPlacementErrors.length, warnings: buildPlacementWarnings.length,
        pickerSide: buildPickerFlipped ? "left" : "right" };
    },
  };

  if (typeof window !== "undefined") Object.assign(window, {
    bldIconStyle, itemIconName, openBuildPanel, clearBuildPlacement, closeBuildUi,
    placeBuildCells, placeBuildDrag,
  });
  if (typeof window !== "undefined") window.DFBuildPanelMarkup = buildPanelApi;

  // Node export for the offline fixture test. infoFilterRows/infoRowActions look up the shared globals
  // at CALL time, so the fixture provides them before invoking.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { infoRowSearchText: (...args) => window.infoRowSearchText(...args), taskNameProf: (...args) => window.taskNameProf(...args), infoFilterRows: (...args) => window.infoFilterRows(...args), infoRowActions: (...args) => window.infoRowActions(...args), infoText: (...args) => window.infoText(...args), placeIdentity: (...args) => window.placeIdentity(...args), geldButtonSpec: (...args) => window.geldButtonSpec(...args), memorialButtonSpec: (...args) => window.memorialButtonSpec(...args), creatureSexGlyphHtml: (...args) => window.creatureSexGlyphHtml(...args), creatureRowsMarkup: (...args) => window.creatureRowsMarkup(...args), residentLaborState: (...args) => window.residentLaborState(...args), professionColorStyle: (...args) => window.professionColorStyle(...args),
      overallTrainingBarHtml: (...args) => window.overallTrainingBarHtml(...args), trainingKnowledgePageHtml: (...args) => window.trainingKnowledgePageHtml(...args), creatureRowActionsHtml: (...args) => window.creatureRowActionsHtml(...args), stockItemPileNumber: (...args) => window.stockItemPileNumber(...args), resolveStockItemPileLocation: (...args) => window.resolveStockItemPileLocation(...args), withStockItemPileLocation: (...args) => window.withStockItemPileLocation(...args), stockItemSheetMarkup: (...args) => window.stockItemSheetMarkup(...args), stocksPanelMarkup: (...args) => window.stocksPanelMarkup(...args),
      infoDetailTabRowHtml: (...args) => window.infoDetailTabRowHtml(...args), infoTabRowHtml: (...args) => window.infoTabRowHtml(...args), infoSearchInputHtml: (...args) => window.infoSearchInputHtml(...args), renderInfoRows: (...args) => window.renderInfoRows(...args), placeRowsHtml: (...args) => window.placeRowsHtml(...args), taskRowsHtml: (...args) => window.taskRowsHtml(...args),
      taskJobModel: (...args) => window.taskJobModel(...args), taskJobControlsHtml: (...args) => window.taskJobControlsHtml(...args), taskUnitControlsHtml: (...args) => window.taskUnitControlsHtml(...args),
      stocksSearchGroups: (...args) => window.stocksSearchGroups(...args), stocksGroupActionCluster: (...args) => window.stocksGroupActionCluster(...args), patchStockItemFlags: (...args) => window.patchStockItemFlags(...args), taskPlaceCellHtml: (...args) => window.taskPlaceCellHtml(...args), infoPlaceDetailWide: (...args) => window.infoPlaceDetailWide(...args), wireBuildNumberControls,
      ...buildPanelApi };
  }

// Diagnostic: proves this module executed to completion on a given page load.
if (typeof window !== "undefined") window.__BIP_OK = true;
