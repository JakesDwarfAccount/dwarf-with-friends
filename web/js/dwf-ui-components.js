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

// B169 DWFUI: the shared UI component layer. Every builder here is DUMB and DECLARATIVE --
// config in, HTML string out. No fetch, no DOM mutation, no listeners, no state. Consumers keep
// their own delegated [data-*] wiring; what this file deduplicates is the MARKUP GRAMMAR that
// the inventory (docs/superpowers/specs/2026-07-10-ui-component-architecture.md) found hand-built
// 24+ times: native rows, chevron tabs, action-button clusters, search fields, panel headers,
// tri-state marks, and the native-art/palette tokens.
//
// Strangler contract: every builder takes explicit class hooks (cls/tabCls/...) so a migrating
// surface KEEPS its pinned CSS and fixture-test class names while adopting the shared structure.
// The dwfui-* defaults are for new surfaces; CSS consolidation is a later wave (spec section 5).
(function (root) {
  "use strict";

  const VERSION = "2.0.0";

  // =================================================================================================
  // THE INTERFACE SCALE. (Wave 4 close-out; the binding decision, overturning D1's integer rule.)
  //
  // MEASURED off the lossless oracle (Menu Oracle Screenshots/unit profiles/Steam relations.png) by
  // least-squares fitting DF's OWN source cells back onto the capture -- see
  // docs/superpowers/analysis/wave4/FONT-SCALE-CLOSEOUT.md and INTERFACE-SCALE-CLOSEOUT.md:
  //
  //   * DF draws its interface at a NON-INTEGER, FILTERED scale (fits: 1.230 - 1.260 on that
  //     capture, 1.235 and 1.285 on two others). It is NOT a constant -- it tracks DF's window.
  //   * DF draws SPRITE ART and TEXT on ONE GRID at ONE SCALE. Its interface art is authored on the
  //     8x12 text cell (SHORT_TAB is 40x24 = 5x2 cells), so this is structural, not luck.
  //   * WE drew everything at 1.0. Our text was never wrong RELATIVE TO OUR OWN ART -- the whole
  //     interface was ~20% undersized. Scaling only the text would have made that WORSE.
  //
  // So D1's "INTEGER SCALE ONLY -- never sub-sample" is FALSE for DF's interface and is retired here.
  // (It was already being violated in practice: dwf.css applies `zoom: var(--ui-scale)` to
  // #hud/#clientPanel/..., so the instant the player moves the in-client UI-scale slider off 1.0 the
  // browser ALREADY resamples every sprite and text canvas with filtering. Integer purity only ever
  // held at exactly 1.0.)
  //
  // *** THE SCALE IS NEVER STATED IN JAVASCRIPT. *** There is exactly ONE declaration of it in the
  // whole system -- `--dwfui-interface-scale` in dwf.css :root -- and every geometry in DWFUI
  // (the text cell, the font size, tab heights, icon boxes, the scrollbar) is `native * that`. JS
  // READS it back (interfaceScale() below) and paints DF's art at it; DFBitmapText then derives the
  // text scale from the art, per its own contract, so ART AND TEXT MOVE TOGETHER BY CONSTRUCTION.
  // Anything may drive it at runtime -- DWFUI.setInterfaceScale(doc, s) -- and the whole interface,
  // art and text alike, re-lands on the new grid. That is what "derived, not hardcoded" buys.
  //
  // THE SOFTENING. The owner reviewed a rendered ladder (0% / 35% / 50% / 70% / 100% blend between nearest
  // and bilinear) and chose 50%: full bilinear was too soft "especially on straight vertical and
  // horizontal strokes"; pure nearest was too hard. SOFTEN is THE tunable -- turn this one number.
  // It is BAKED IN, once, wherever art is cropped or an atlas is scaled; nothing on a draw path or a
  // paint path ever blends. At an INTEGER scale there is no blend at all (nearest == bilinear there),
  // which is what keeps the approved 1x Foundation cards byte-exact.
  // =================================================================================================
  const SOFTEN = 0.5;
  const MIN_IFACE = 0.5, MAX_IFACE = 4;

  function _cssNumber(doc, prop, fallback) {
    const el = doc && doc.documentElement;
    const view = doc && doc.defaultView;
    if (!el || !view || typeof view.getComputedStyle !== "function") return fallback;
    let raw = null;
    try { raw = view.getComputedStyle(el).getPropertyValue(prop); } catch (_) { return fallback; }
    const n = Number(String(raw == null ? "" : raw).trim());
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
  // The scale DF's interface is drawn at on this document. ONE source of truth: the CSS token.
  function interfaceScale(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const n = _cssNumber(d, "--dwfui-interface-scale", 1);
    return Math.max(MIN_IFACE, Math.min(MAX_IFACE, n));
  }
  // The in-client UI-scale slider, which dwf.css applies as `zoom`. It MULTIPLIES on top of the
  // interface scale. We rasterise DF's art into the canvas BACKING STORE at interfaceScale x zoom and
  // pin the CSS box to the unzoomed size, so the browser's zoom scales a bitmap we already drew at
  // its target density instead of upsampling a 1x one -- the slider gets CRISPER, not blurrier.
  function uiZoom(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const n = _cssNumber(d, "--ui-scale", 1);
    return Math.max(MIN_IFACE, Math.min(MAX_IFACE, n));
  }
  // THE ONE RUNTIME KNOB. Moves DF's whole interface -- art and text -- onto a new grid in one call:
  // the CSS token drives every box, the cached art crops are re-baked at the new scale, and
  // DFBitmapText re-renders every label because its dirty key tracks the effective scale.
  function setInterfaceScale(doc, scale) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || !d.documentElement) return 1;
    const s = Math.max(MIN_IFACE, Math.min(MAX_IFACE, Number(scale) || 1));
    d.documentElement.style.setProperty("--dwfui-interface-scale", String(s));
    _publishInterfaceScale(d, s);
    // The mounts bake the scale into their crops, so they are stale the moment it moves.
    for (const marker of ["data-dwfui-tabs", "data-dwfui-plaques", "data-dwfui-scrollbar", "data-dwfui-cycler"])
      d.documentElement.removeAttribute(marker);
    try { mountScrollbarArt(d); } catch (_) {}
    try { mountTabArt(d); } catch (_) {}
    try { mountPlaqueArt(d); } catch (_) {}
    try { mountCyclerArt(d); } catch (_) {}
    try { paintSprites(d); } catch (_) {}
    const bitmap = root && root.DFBitmapText;
    if (bitmap && bitmap.configure) bitmap.configure(d, { interfaceScale: s });
    if (bitmap && bitmap.schedule) bitmap.schedule(d);
    return s;
  }
  // The contract DFBitmapText documented and this module must honour: "once the owner sets
  // data-dwfui-interface-scale (or just draws the art at DF's scale), the text follows automatically."
  // We do BOTH -- the art is painted at `s`, and `s` is stamped, so the text never has to guess.
  function _publishInterfaceScale(doc, scale) {
    const el = doc && doc.documentElement;
    if (!el || !el.setAttribute) return;
    const value = String(Number(scale.toFixed(4)));
    if (el.getAttribute("data-dwfui-interface-scale") !== value)
      el.setAttribute("data-dwfui-interface-scale", value);
  }

  // THE BLEND, baked. Draws `img`'s source rect into `ctx` at dw x dh as
  //     (1 - SOFTEN) * nearest  +  SOFTEN * bilinear
  // using globalCompositeOperation "lighter" -- additive on PREMULTIPLIED pixels, so the two layers
  // interpolate exactly, in colour AND alpha. Plain source-over would NOT interpolate: it can only
  // ADD coverage, so it would leave a haloed nearest blit rather than the blend the owner chose. Callers
  // pass a CLEARED region. At an integer scale the soft pass is skipped entirely.
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
  // Resolve the app's escapeHtml at CALL time (it lives in dwf-unit-hud-notifications.js in
  // the browser); fall back to a local copy so this module is dependency-free under node.
  function escLocal(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function esc(value) {
    try { if (typeof escapeHtml === "function") return escapeHtml(value); } catch (_) {}
    return escLocal(value);
  }
  // B55-r2 parity rule: native capitalizes display names ("Strawberry plants"); the wire keeps
  // the raw lowercase name. Display-side transform only -- never fed back into requests.
  function sentenceCase(value) {
    const s = String(value == null ? "" : value);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  function kebab(key) { return String(key).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(); }
  function datasetAttrs(dataset) {
    return Object.keys(dataset || {}).map(key =>
      ` data-${kebab(key)}="${esc(dataset[key])}"`).join("");
  }

  // The real text remains in the DOM. DFBitmapText hides this visual fallback only after every
  // character has been assembled successfully from the player's own atlas.
  function bitmapTextHtml(value, opts) {
    const o = opts || {};
    const text = String(value == null ? "" : value);
    return `<span class="dwfui-bitmap-text${o.cls ? " " + o.cls : ""}"` +
      ` data-dwfui-bitmap-text="${esc(text)}"${o.scale ? ` data-dwfui-bitmap-scale="${esc(o.scale)}"` : ""}` +
      `${o.eager ? " data-dwfui-bitmap-eager" : ""}>` +
      `<span class="dwfui-bitmap-fallback">${esc(text)}</span></span>`;
  }

  // ---- TOKENS: one import point for palette, fonts, native art, and the glyph vocabulary ------
  // palette/font: the gold-on-charcoal identity currently hand-copied across combatlog/hostpanel/
  // settings style blocks and half a dozen inline hex literals. art: the 27 oracle-extracted
  // data-URI assets already tokenized as --spa-* custom properties in web/css/dwf.css :root
  // (single copy of the base64 payloads) -- referenced here BY NAME so JS builders and future CSS
  // stop inlining copies. glyphs: the canonical action/mark vocabulary; the stock item sheet,
  // stocks panel, and farm seed rows all express the same actions and must share one set.
  const TOKENS = {
    palette: {
      // ---- LEGACY (pre-F1) approximations. Kept so unmigrated surfaces keep rendering; every
      // one of these is superseded by a `native*` key below and by a --dwfui-* custom property.
      // Do NOT reach for these in new code.
      gold: "#d89b27", goldBright: "#ffd45c", goldBorder: "#ffe26c",
      ink: "#151515", inkDeep: "#0b0a08", panel: "#242326", panelAlt: "#1d1c1f",
      parchment: "#f2e6cf", parchmentDim: "#b9ad95",
      green: "#56ce42", greenBright: "#b0ff85", greenSoft: "#7ac74f",
      red: "#d9443f", orange: "#ff8a00", offGray: "#5a5a62",
      // ---- F1 MEASURED NATIVE PALETTE (matrix F1.2/F1.3; sampled with PIL from B55-3, B174-1/2,
      // B171-2, B143-1, B128-1, CIM-justice; native has no sub-pixel AA so these are EXACT glyph
      // colours, not estimates). Every key here is mirrored as a --dwfui-* custom property in
      // dwf.css :root -- CSS and JS consume the same value, which is the whole point of F1.
      // NOTE: "parchment" is a MISNOMER -- it appears in ZERO DF menus (it is the outer game frame
      // art only). Native tabs are plum / gold / slate / silver / orange.
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
      textPrimary: "#ffffff",      // window title + primary row label (native title is NOT larger)
      textDim: "#d7d7d7",          // secondary/dimmed  (Q1: dim vs disabled is `needs the owner evidence`)
      textWarning: "#ff7f13",      // "No seeds", "Cancel", an active kill order
      textGood: "#16ff76",         // "Add new task", "View stockpile", Equip/Schedule
      textActive: "#14ffe9",       // job / in-progress -- CYAN, not green ("#55ffff" is wrong)
      glyphOnGold: "#1a1324",      // selected-tab label on the gold tab -- dark indigo, NOT #000
      subsubSelected: "#ff7f13",   // SHORT_SUBSUBTAB selected fill (orange)
      // scrollbar (E2 pixel-scan of B151-3, an ALREADY-APPROVED oracle)
      sbRail: "#c0c4d3",           // silver rails
      sbGutter: "#1c1c1c",         // the gutter IS the panel background -- no lighter track fill
      sbThumb: "#614151",          // the same plum as an unselected tab
      sbThumbEdge: "#f6b811",      // gold thumb side edges / chevron caps
      sbThumbEdgeDark: "#d08d08",
      // ---- the DF 16-colour TEXT palette (data-driven per unit/profession/status). Exposed once
      // here so no screen invents its own table (drift rule R1).
      dfBlack: "#000000", dfDarkGray: "#555555", dfBlue: "#0000aa", dfBrightBlue: "#5555ff",
      dfGreen: "#00aa00", dfBrightGreen: "#55ff55", dfCyan: "#00aaaa", dfBrightCyan: "#55ffff",
      dfRed: "#aa0000", dfBrightRed: "#ff5555", dfMagenta: "#aa00aa", dfBrightMagenta: "#ff55ff",
      dfBrown: "#aa5500", dfYellow: "#ffff55", dfGray: "#aaaaaa", dfWhite: "#ffffff",
      // The SAME 16 colors, in DF's CURSES INDEX ORDER (0..15 = fg + bright*8). This is the
      // authoritative lookup for any native color index the plugin ships (report colors, emotion
      // attrs, profession/skill colors, [C:] tokens). These hexes are the DEFAULT palette only --
      // dfColor() prefers the live per-session --df-cN custom properties (set by applyPalette from
      // the plugin's gps->uccolor handshake) so an edited data/init/colors.txt is honored.
      // Text-color spec §2.3, §3.2.
      df16: ["#000000", "#0000aa", "#00aa00", "#00aaaa", "#aa0000", "#aa00aa", "#aa5500", "#aaaaaa",
             "#555555", "#5555ff", "#55ff55", "#55ffff", "#ff5555", "#ff55ff", "#ffff55", "#ffffff"],
      // ---- B88 WORLD-MAP raster colour maps. NOT DOM chrome: these are data->colour tables the
      // world map consumes through canvas ctx.fillStyle in drawWorldCanvas (a biome/site palette,
      // not a button or a border), so they belong in the token layer, not inline in dwf-worldmap.js.
      // dwf-worldmap.js currently keeps private WORLD_SITE_COLORS / WORLD_TERRAIN_COLORS tables and
      // (per its own R1-deferral note ~line 87) wants exactly this named home under TOKENS.palette.
      // That module is a SIBLING lane; it will consume `worldMap.*` BY NAME later. Values here are
      // byte-identical to its current local tables so adoption is render-neutral (b88_worldmap_test
      // pins worldSiteColor("Town",true)==="#ff5252" and worldSiteColor("Town",false)==="#66bb6a").
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
    // ---- F1 typography. Native menu text is a FIXED-CELL CP437 BITMAP FONT, integer-scaled, with
    // NO antialiasing and NO hinting. The layout metric is the 8x12 px cell
    // (data/art/curses_640x300.png = 128x192 = a 16x16 glyph grid); every interface sprite is an
    // exact multiple of it. EXPRESS GEOMETRY IN CELLS, NOT PX.
    //
    // D1 (the BINDING decision): the plugin will mount DF's `data/art/` so the real atlas is
    // reachable at runtime. The C++ mount + the glyph loader are a SIBLING agent's slice. THIS is
    // the CSS/token half of that contract -- what the loader must provide:
    //   * an @font-face (or a canvas glyph blitter) registered under the family name that
    //     --dwfui-font-face resolves to (default: "DFCurses");
    //   * glyphs on an 8x12 design grid so `font-size: calc(cell.h * scale)` lands on cell bounds;
    //
    //   * ~~integer scale ONLY -- never sub-sample~~  *** RETIRED. THIS RULE WAS FALSE. ***
    //     MEASURED: DF draws its interface -- art AND text, one grid -- at a NON-INTEGER, FILTERED
    //     scale (~1.245 on the oracle's window; 1.235 and 1.285 on two others). Its glyph edges carry
    //     PARTIAL ALPHA in a LOSSLESS png, which nearest-neighbour cannot produce. The rule is
    //     replaced by `--dwfui-interface-scale` (see the block at the top of this file): everything
    //     geometric is `native * that`, the blit is a 50%-blended bake, and DFChrome's integer
    //     _dfChromeScaleFor is no longer on DWFUI's sprite path at all.
    // Until the loader lands, --dwfui-font-face falls back to the mono stack and every screen still
    // gets the right SIZE and CELL GRID; only the face is wrong. That is `assumed-not-oracle`.
    font: {
      mono: "ui-monospace, Consolas, monospace",   // the fallback face (pinned by ui_components_test)
      face: "var(--dwfui-font-face)",               // the D1 bitmap face, once the loader mounts it
      cell: { w: 8, h: 12 },                       // DF's AUTHORING text cell, in px. Native. Fixed.
      // The drawn cell is cell x the interface scale. On the oracle that is 10x15 -- the measured
      // glyph advance and ink height of native's tab labels. NOT a constant: read it, never state it.
      interfaceScale: "var(--dwfui-interface-scale)",
      scale: 2,                                    // legacy label multiplier ceiling; NOT the DF scale
      // Native uses ONE text size. B55-3/B143-1 confirm the window TITLE is the same size as body.
      // Sizes are expressed in CELLS; multiply by cell.h * scale for px.
      sizes: { title: 1, heading: 1, body: 1, row: 1, secondary: 1, numeric: 1 },
      weights: { normal: 400, strong: 700 },
      lineHeights: { cell: 1 },
    },
    // ---- F1 text ROLES. Every role resolves to a --dwfui-* custom property declared in
    // dwf.css :root -- so a CSS rule and a JS builder cannot drift apart. A migrated family
    // may NOT define its own colour table (spec §7 F1 acceptance; drift rule R1).
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
      check: "var(--spa-check)", dash: "var(--spa-dash)", x: "var(--spa-x)",
      frameGold: "var(--spa-frame-gold)", greenStrip: "var(--spa-green-strip)",
      iconboxes: "var(--spa-iconboxes)", winframe: "var(--spa-winframe)",
      plaqueAll: "var(--spa-plaque-all)", plaqueDone: "var(--spa-plaque-done)",
      plaqueNone: "var(--spa-plaque-none)",
      rowGreen: "var(--spa-row-green)", rowRed: "var(--spa-row-red)",
      // B217 r2: the assign-animals chooser's "assigned here" arrow tile (gold down-arrow on a
      // grass tile, Z12-jt-5 / B152-2). It has NO interface_map token -- native composites a zone
      // tile with an arrow glyph at runtime -- so, exactly like B151's 27 stockpile assets, the
      // art is ORACLE-EXTRACTED: 32x32 RGBA baked from Z12-jt-5 pixels (1092,154)-(1136,196).
      zoneAssignArrow: "var(--spa-zone-assign-arrow)",
      sptypeIcons: "var(--spa-sptype-icons)",
      tileHash: "var(--spa-tile-hash)", tileMinus: "var(--spa-tile-minus)",
      tilePlus: "var(--spa-tile-plus)", tileQuill: "var(--spa-tile-quill)",
      tileIngotOff: "var(--spa-tile-ingot-off)", tileIngotOn: "var(--spa-tile-ingot-on)",
      tilePlantOff: "var(--spa-tile-plant-off)", tilePlantOn: "var(--spa-tile-plant-on)",
      toolBarrel: "var(--spa-tool-barrel)", toolLinkadd: "var(--spa-tool-linkadd)",
      toolLinksfreeOff: "var(--spa-tool-linksfree-off)", toolLinksfreeOn: "var(--spa-tool-linksfree-on)",
      toolPaint: "var(--spa-tool-paint)", toolRemove: "var(--spa-tool-remove)",
      // B174 workshop-native set (oracle-extracted, see the css :root comment): the header's
      // linked-stockpiles opener + crossed-house remove, the links side-window give/take mode
      // buttons, and the linked-row direction icons.
      wsLinkopen: "var(--spa-ws-linkopen)", wsRemove: "var(--spa-ws-remove)",
      wsLinkgive: "var(--spa-ws-linkgive)", wsLinktake: "var(--spa-ws-linktake)",
      wsDirgive: "var(--spa-ws-dirgive)", wsDirtake: "var(--spa-ws-dirtake)",
      // F6 TOKEN GAP, closed: --spa-row-grey has been DECLARED in dwf.css since B151 and used
      // at .spe-row.some, but it was never given a TOKENS.art key -- so JS literally could not
      // render a partial-state row. rowHtml({state:'some'}) needs it.
      rowGrey: "var(--spa-row-grey)",
    },
    // ---- F4/F10 NATIVE SPRITE VOCABULARY -----------------------------------------------------
    // interface_map.json TOKEN names, for the `sprite:` key on iconHtml / actionButtonsHtml /
    // artBtnHtml / rowHtml / headerHtml. These are NOT css vars: they are resolved at paint time by
    // DWFUI.paintSprites() through window.DFChrome, which blits the cell out of DF's OWN
    // interface_bits*.png at an integer scale. 1,502 tokens are reachable; these are the ones the
    // matrix names. EVERY NAME BELOW WAS VERIFIED PRESENT IN web/interface_map.json on 2026-07-11
    // -- several agent docs quoted names that do not exist. Verify before you add one.
    sprites: {
      // header tool cluster (F2). Native ordering invariant: quill SECOND-FROM-RIGHT, remove RIGHTMOST.
      quill: "UNIT_SHEET_CUSTOMIZE",            // 32x36 -- rename. The owner asks for this BY NAME (x4).
      removeBuilding: "BUILDING_SHEET_REMOVE",  // 32x36 -- the cancelled house. The owner asks BY NAME.
      assignWorker: "BUILDING_SHEET_ASSIGN_WORKER",
      cameraOn: "UNIT_SHEET_CAMERA_ACTIVE", cameraOff: "UNIT_SHEET_CAMERA_INACTIVE",
      viewReports: "UNIT_SHEET_VIEW_REPORTS",   // action is `needs the owner evidence` E3-B9
      expel: "UNIT_SHEET_EXPEL",
      // B232 R2: the native ALERT box's top-right log button (oracle B232-oracle-native.png) --
      // DF's own "open all announcements" cell (interface_bits_announcements.png 0,0 24x36,
      // arrow + gold-framed scroll baked into the cell). Verified in interface_map.json 2026-07-14.
      openAnnouncements: "ANNOUNCEMENT_OPEN_ALL_ANNOUNCEMENTS",
      settings: "BUTTON_SETTINGS", back: "BUTTON_CLOSE_LEFT",   // back is a gold LEFT ARROW, not an X
      close: "BUILDING_JOBS_REMOVE",             // native red X tile used by shared panel headers
      // search (F7). C-7 is RESOLVED: the magnifier is NOT missing, it is UNADOPTED.
      filter: "BUTTON_FILTER",                  // 48x36 = an empty cell + the magnifier cell
      filterNoMagRight: "BUTTON_FILTER_NO_MAG_RIGHT",
      filterName: "BUTTON_FILTER_NAME",         // the quill-capped rename field
      // item / row actions (F4). These retire the TOKENS.glyphs EMOJI.
      view: "STOCKS_VIEW_ITEM", inspect: "SQUADS_INSPECT",
      forbid: "STOCKS_FORBID", forbidOn: "STOCKS_FORBID_ACTIVE",
      dump: "STOCKS_DUMP", dumpOn: "STOCKS_DUMP_ACTIVE",
      hide: "STOCKS_HIDE", hideOn: "STOCKS_HIDE_ACTIVE",
      melt: "STOCKS_MELT", meltOn: "STOCKS_MELT_ACTIVE",
      recenter: "RECENTER_RECENTER", recenterStocks: "STOCKS_RECENTER",
      // B245: the minimap recenter column + the recenter-locations panel (oracles
      // B243-oracle-native-icon.png / B243-oracle-native-panel.png). Raws citations, all verified
      // against graphics_interface.txt + interface_map.json 2026-07-14:
      //   RECENTER_HOTKEYS      [TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS_RECENTER:0:0:4:3]  32x36
      //                         interface_bits_recenter.png (0,0) -- the icon-column entry point
      //                         (arrow-into-dashed-box in DF's own gold frame).
      //   RECENTER_SURFACE      [..:INTERFACE_BITS_RECENTER:4:0:4:3]   (32,0)  surface picture cell
      //   RECENTER_DEEPEST      [..:INTERFACE_BITS_RECENTER:8:0:4:3]   (64,0)  cavern picture cell
      //   RECENTER_SET_LOCATION [..:INTERFACE_BITS_RECENTER:12:0:4:3]  (96,0)  four-arrows-inward:
      //                         the panel row's "assign current view to this slot" tile.
      //   RECENTER_REMOVE_OR_CLEAR [..:INTERFACE_BITS_SHARED:4:3:4:3] interface_bits_shared.png
      //                         (32,36) -- the plain red X (the panel row's delete tile).
      // RECENTER_RECENTER (the panel row's "recenter to this location" tile) is `recenter` above.
      recenterLocations: "RECENTER_HOTKEYS",
      recenterSurface: "RECENTER_SURFACE", recenterDeepest: "RECENTER_DEEPEST",
      recenterSet: "RECENTER_SET_LOCATION", recenterClear: "RECENTER_REMOVE_OR_CLEAR",
      // B245: the minimap display toggles are COMPLETE 16x24 native cells (frame baked into the
      // ON faces) -- interface_bits_display_toggles.png row 0.
      liquidNumbersOff: "LIQUID_NUMBERS_OFF", liquidNumbersOn: "LIQUID_NUMBERS_ON",
      rampArrowsOff: "RAMP_ARROWS_OFF", rampArrowsOn: "RAMP_ARROWS_ON",
      // task controls (F8/PB-04). "it turns GREEN when you click it" is not a colour to invent --
      // it is BUILDING_JOBS_SUSPENDED_ACTIVE, with the green baked into the sprite.
      suspend: "BUILDING_JOBS_SUSPENDED", suspendOn: "BUILDING_JOBS_SUSPENDED_ACTIVE",
      repeat: "BUILDING_JOBS_REPEAT", repeatOn: "BUILDING_JOBS_REPEAT_ACTIVE",
      cancelJob: "BUILDING_JOBS_REMOVE", jobRemoveWorker: "BUILDING_JOBS_REMOVE_WORKER",
      // WAVE-5: the workshop task row's other three states. All three are real cells in
      // interface_map.json and the workshop consumed them as RAW token strings -- which meant
      // isSelfFramedSprite() said false and the builder drew a SECOND gold border around art that
      // already carries DF's own frame. That is the S2 GAP-1 defect, and it is exactly the
      // "a self-framed native sprite gets NO generic box" invariant this programme exists to enforce.
      jobActive: "BUILDING_JOBS_ACTIVE",
      jobDoNow: "BUILDING_JOBS_DO_NOW", jobDoNowOn: "BUILDING_JOBS_DO_NOW_ACTIVE",
      // WAVE-5: the native stockpile panel's own art. All eight verified present in
      // interface_map.json and NONE was reachable from JS -- so the panel's five tool tiles were
      // still painting the frozen `--spa-tool-*` data-URIs (DF's frame BAKED IN), and .dwfui-art-btn
      // then added its own 2px gold border on top: a double frame on a APPROVED anchor. This is
      // the same class of bug as BUILDING_JOBS_* above, and PB-10's "strange box with a golden
      // border" lives in this neighbourhood.
      spRepaint: "STOCKPILE_REPAINT", spRemove: "STOCKPILE_REMOVE_EXISTING",
      spTakeAnywhere: "STOCKPILE_TAKE_FROM_ANYWHERE", spTakeLinksOnly: "STOCKPILE_TAKE_FROM_LINKS_ONLY",
      spConnections: "STOCKPILE_SET_CONNECTIONS", spToolSettings: "STOCKPILE_TOOL_SETTINGS",
      spTypeOn: "STOCKPILE_TYPE_ACTIVE", spTypeOff: "STOCKPILE_TYPE_INACTIVE",
      // worker specialization (PB-03) -- "the green hammer". Consumers: the Labor tab's roster AND
      // (B254) the Creatures -> Residents row, which is where NATIVE puts it (unit_list_options
      // SPECIALIZED, df.widgets.unit_list.xml:11).
      workerAny: "WORKER_DO_ANY_AVAILABLE_JOB",       // GREEN, OPEN padlock: does any free task
      workerOnly: "WORKER_ONLY_DO_ASSIGNED_JOBS",     // RED, CLOSED padlock: specialized. Ctrl+z.
      // B254 -- the WORK DETAIL icons. DF's `work_detail.icon` is a `work_detail_icon_type`
      // (df.plotinfo.xml:573-594): NONE plus these 19, and DF ships a 32x36 tile for every one of
      // them in interface_bits_labor.png (graphics_interface.txt:2912-2930). The residents list's
      // WORK_DETAILS column (df.widgets.unit_list.xml:12) draws one per work detail the dwarf is
      // assigned to -- the pick, the axe-in-the-stump, the bag of plants, the fish on a rod.
      // All 19 verified present in web/interface_map.json 2026-07-14; dwfui_boot_test re-verifies.
      // Resolve them through workDetailSprite() below, never by hand.
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
      // steppers + reorder (F8/PB-10). Native order is `value [#][+][-]`.
      stepHash: "WORK_ORDERS_ENTER_AMOUNT",
      stepPlus: "WORK_ORDERS_INCREASE_AMOUNT",
      stepMinus: "WORK_ORDERS_DECREASE_AMOUNT",
      priorityUp: "WORK_ORDERS_PRIORITY_UP", priorityDown: "WORK_ORDERS_PRIORITY_DOWN",
      // sort headers -- VANILLA DF, not a DFHack overlay.
      sortAsc: "SORT_ASCENDING_ACTIVE", sortAscOff: "SORT_ASCENDING_INACTIVE",
      sortDesc: "SORT_DESCENDING_ACTIVE", sortDescOff: "SORT_DESCENDING_INACTIVE",
      sortText: "SORT_TEXT_ACTIVE", sortTextOff: "SORT_TEXT_INACTIVE",
      // ---- WAVE 4 FOUNDATION: the vocabulary the four family agents each found missing ----------
      // EVERY name below was verified present in web/interface_map.json before it was added, and
      // dwfui_boot_test re-verifies all of them on every build (a token absent from the map ships as
      // an INVISIBLE HOLE, so that gate is the point -- keep it).
      //
      // S1 -- the Items-tab assignment-class INDICATORS (grey-framed: what the item is assigned as).
      // They are NOT buttons. Render them through iconHtml; leave the click handler off (Q-S1-2).
      invAssignedClothing: "INVENTORY_ASSIGNED_CLOTHING", invAssignedTool: "INVENTORY_ASSIGNED_TOOL",
      invAssignedSquad: "INVENTORY_ASSIGNED_SQUAD", invAssignedSymbol: "INVENTORY_ASSIGNED_SYMBOL",
      // S1/S2 -- THE UNIVERSAL NATIVE CHECK TILE. DF itself aliases this one 32x36 pair as
      // EMBARK_{,NOT_}SELECTED, UNIT_SELECTOR_{ASSIGNED,UNASSIGNED} and
      // WORK_ORDERS_ADJECTIVE_{,NOT_}SELECTED -- i.e. the game treats it as THE checkbox. checkHtml
      // defaults to it (blit-verified against steam labor work details.png).
      checkOn: "SQUADS_SELECTED", checkOff: "SQUADS_NOT_SELECTED",
      // S2 -- the squad order strip + row tiles. Icon-only, self-framed native control cells.
      squadsKill: "SQUADS_KILL_ORDER", squadsMove: "SQUADS_MOVE_ORDER",
      squadsPatrol: "SQUADS_PATROL_ORDER", squadsDefendBurrow: "SQUADS_DEFEND_BURROW_ORDER",
      squadsTrain: "SQUADS_TRAIN_ORDER", squadsCancelOrder: "SQUADS_CANCEL_ORDER",
      squadsChangeAlert: "SQUADS_CHANGE_ALERT", squadsPositions: "SQUADS_POSITIONS",
      squadsDisband: "SQUADS_DISBAND", squadsRecenter: "SQUADS_RECENTER",
      // S3 -- labor. The kitchen toggle is THREE-state in the art (ALLOWED/RESTRICTED/CANNOT);
      // which of the two dark states native shows for an unbrewable item is S3-1, still open --
      // do not conflate them, and do not render nothing (native renders a real CANNOT tile).
      kitchenCookAllowed: "LABOR_KITCHEN_COOK_ALLOWED", kitchenCookRestricted: "LABOR_KITCHEN_COOK_RESTRICTED",
      kitchenCookCannot: "LABOR_KITCHEN_COOK_CANNOT",
      kitchenBrewAllowed: "LABOR_KITCHEN_BREW_ALLOWED", kitchenBrewRestricted: "LABOR_KITCHEN_BREW_RESTRICTED",
      kitchenBrewCannot: "LABOR_KITCHEN_BREW_CANNOT",
      stoneAllowed: "LABOR_STONE_USE_ALLOWED", stoneRestricted: "LABOR_STONE_USE_RESTRICTED",
      magmaSafe: "LABOR_STONE_USE_MAGMA_SAFE", magmaUnsafe: "LABOR_STONE_USE_MAGMA_UNSAFE",
      laborAssigned: "LABOR_WORKER_ASSIGNED", laborUnassigned: "LABOR_WORKER_UNASSIGNED",
      laborEverybody: "LABOR_WORKER_ASSIGNED_EVERYBODY", laborNobody: "LABOR_WORKER_ASSIGNED_NOBODY",
      editWorkDetail: "LABOR_EDIT_WORK_DETAIL",   // the gear. Its ACTION is B12 -- ship it placeholder.
      selectAll: "SELECT_ALL",                    // {cx:64,cy:300} -- NOT the W8 button (see below)
      // B226 -- the trade family (barter screen + bring-goods-to-depot screen; oracles
      // B226-barter-1..4 / B226-depot-1..7). The check pair is the native trade checkbox
      // (grey tick unmarked, GREEN tick marked); IN_DEPOT / BEING_BROUGHT / PROHIBITED are the
      // three extra states of the same 24x36 cell on the move-goods rows; the 32x36 tool tiles
      // are the depot list's sort/cull buttons.
      tradeSelected: "ASSIGN_TRADE_SELECTED", tradeNotSelected: "ASSIGN_TRADE_NOT_SELECTED",
      tradeInDepot: "ASSIGN_TRADE_IN_DEPOT", tradeBeingBrought: "ASSIGN_TRADE_BEING_BROUGHT",
      tradeProhibited: "ASSIGN_TRADE_PROHIBITED",
      tradeSortDistanceOn: "ASSIGN_TRADE_SORT_BY_DISTANCE_ON",
      tradeSortDistanceOff: "ASSIGN_TRADE_SORT_BY_DISTANCE_OFF",
      tradeSortValueOn: "ASSIGN_TRADE_SORT_BY_VALUE_ON",
      tradeSortValueOff: "ASSIGN_TRADE_SORT_BY_VALUE_OFF",
      tradeCullMandatesOn: "ASSIGN_TRADE_CULLING_MANDATES_ON",
      tradeCullMandatesOff: "ASSIGN_TRADE_CULLING_MANDATES_OFF",
      // W8 -- THE KITCHEN COLUMN MASS-TOGGLE (live game: "in the kitchen tab we are missing these
      // blue arrow buttons entirely, if you click them they filter out all the gray state options,
      // from food or drink respectively"). One button above the COOK column and one above the BREW
      // column; clicking collapses the list to the rows that column can ACTUALLY act on, i.e. hides
      // its CANNOT (grey) rows. It is a VIEW filter -- it touches no game state.
      //   `kitchen all three states.png` shows BOTH buttons wearing the arrows-pointing-INWARD face:
      //   that is CONTRACT_LIST (collapse). EXPAND_LIST is its inverse, shown while collapsed.
      // An earlier reading of this control as SELECT_ALL was wrong -- SELECT_ALL is the neighbouring
      // {cx:64} tile in the same strip and means "select every row", not "hide the impossible ones".
      contractList: "CONTRACT_LIST",              // {cx:0,cy:300,w:32,h:36}  collapse -> hide CANNOT
      expandList: "EXPAND_LIST",                  // {cx:32,cy:300,w:32,h:36} expand   -> show all
      // S3 -- work orders. The six status tiles + the four row/screen actions.
      woWaiting: "WORK_ORDERS_WAITING", woChecking: "WORK_ORDERS_CHECKING",
      woValidated: "WORK_ORDERS_VALIDATED", woNotValidated: "WORK_ORDERS_NOT_VALIDATED",
      woActive: "WORK_ORDERS_ACTIVE", woReady: "WORK_ORDERS_READY",
      woConditions: "WORK_ORDERS_CONDITIONS", woCreateNew: "WORK_ORDERS_CREATE_NEW",
      woRemove: "WORK_ORDERS_REMOVE", woDetails: "WORK_ORDERS_DETAILS",
      // S3 -- the W6 kitchen cycler. THREE 24x12 COMPOSITION SLICES, not three buttons: they must
      // NOT go in SELF_FRAMED_SPRITES (same class of hazard as BUTTON_FILTER_NO_MAG_RIGHT).
      typeFilterLeft: "TYPE_FILTER_LEFT", typeFilterText: "TYPE_FILTER_TEXT",
      typeFilterRight: "TYPE_FILTER_RIGHT",
      // S3 -- the slab/plaque source art (3-slice compositions, NOT self-framed) and the mood faces
      // (16x24 glyph-like cells, NOT control frames).
      rect: "BUTTON_RECTANGLE", rectLight: "BUTTON_RECTANGLE_LIGHT", rectDark: "BUTTON_RECTANGLE_DARK",
      rectSelected: "BUTTON_RECTANGLE_SELECTED", rectDivider: "BUTTON_RECTANGLE_DIVIDER",
      stress0: "BUTTON_STRESS_0", stress1: "BUTTON_STRESS_1", stress2: "BUTTON_STRESS_2",
      stress3: "BUTTON_STRESS_3", stress4: "BUTTON_STRESS_4", stress5: "BUTTON_STRESS_5",
      stress6: "BUTTON_STRESS_6",
      // B217 r2 -- the zone panel's native control cells. Every one is a COMPLETE framed cell in
      // the native captures (B217-2, Z12-jt-1/3/4, Z11-19/20/21, LEVER-LINK-1/3, barracks zone
      // oracle), so they all also join SELF_FRAMED_SPRITES below. State mapping verified against
      // the sheets: ZONE_SUSPEND_INACTIVE is the GOLD-framed pause an ACTIVE zone shows;
      // ZONE_SUSPEND is the silver-framed suspended state.
      zoneRepaint: "ZONE_REPAINT", zoneRemove: "ZONE_REMOVE_EXISTING",
      zoneSuspend: "ZONE_SUSPEND_INACTIVE", zoneSuspendOn: "ZONE_SUSPEND",
      zonePickAnimals: "ZONE_PICK_ANIMALS", zoneAssignUnit: "ZONE_ASSIGN_UNIT",
      zoneLocationAssign: "ZONE_LOCATION_ASSIGN", zoneLocationDetails: "ZONE_LOCATION_DETAILS",
      zoneQuill: "HAULING_RENAME_ROUTE", zoneSquadList: "ZONE_SQUAD_LIST",
    },
    // Some native records are complete controls even when a specimen needs only the symbol inside
    // them. These named crops are the shared, evidence-measured glyph vocabulary for that case.
    // They do not replace the complete STOCKS_VIEW_ITEM / BUTTON_FILTER cells used by real UI.
    spriteCrops: {
      viewMagnifier: {
        sprite: "STOCKS_VIEW_ITEM", x: 7, y: 9, w: 12, h: 18,
        transparent: ["0,0,0", "28,28,28"],
      },
      filterMagnifier: {
        sprite: "BUTTON_FILTER", x: 25, y: 6, w: 17, h: 24,
        transparent: ["28,28,28"],
      },
      // BUTTON_FILTER is a 48x36 composition record. Pixels 0..15 are the field's left slice;
      // pixels 16..47 are the COMPLETE framed magnifier button. Search supplies the stretchable
      // field, so retain the full right-hand 32px cell -- x=24 discarded its silver left border.
      filterButton: {
        sprite: "BUTTON_FILTER", x: 16, y: 0, w: 32, h: 36,
        transparent: [],
      },
      // B230 BURROW SYMBOLS (burrowSymbol0 .. burrowSymbol22), appended by the loop below.
      // df::burrow.symbol_index selects one of DF's CUSTOM_SYMBOLS cells; interface_map.json
      // collapses all 23 of them onto the single CUSTOM_SYMBOL token (cx:0, cy:0 of
      // custom_symbols.png), so the individual glyphs are unreachable by token alone -- a crop is
      // exactly the escape hatch for that, and _paintSpriteCrop blits from rec.cx + crop.x.
      // Sheet geometry is DF's own, not measured guesswork (tile_page_interface.txt):
      //   [TILE_PAGE:CUSTOM_SYMBOLS][TILE_DIM:32:32][PAGE_DIM_PIXELS:384:64]  => 12 cols x 2 rows.
      // graphics_interface.txt binds 23 cells (12 on row 0, 11 on row 1) in reading order, which is
      // why the valid symbol_index range is 0..22 -- the same range DFHack's own burrow writer rolls
      // (scripts/internal/quickfort/burrow.lua: math.random(0, 22)).
    },
    // The SIX-STATE native icon-button frame (BUTTON_PICTURE_BOX*, 24x36). We do not use it at all
    // today, which is why `.dwfui-actions button:hover` and `.active` share ONE look and a LATCHED
    // button is indistinguishable from a HOVERED one. F4 splits them; this table is the split.
    frames: {
      default: "BUTTON_PICTURE_BOX",                    // plum fill, grey border
      hover: "BUTTON_PICTURE_BOX_LIGHT",                // plum fill, silver border
      disabled: "BUTTON_PICTURE_BOX_DARK",              // plum fill, near-black border
      selected: "BUTTON_PICTURE_BOX_SELECTED",          // plum fill, GOLD border
      active: "BUTTON_PICTURE_BOX_HIGHLIGHTED",         // GREEN fill, black border  <- the latch
      selectedActive: "BUTTON_PICTURE_BOX_SEL_HIGHLIGHTED",
    },
    // The four native TAB grammars (F3). We ship ONE. Every trapezoid is 3-sliced horizontally;
    // the "chevron" between two tabs is NEGATIVE SPACE, not a drawn shape.
    //
    // *** THE DECISION 3: `primary` IS `SHORT_TAB`. WE HAD THE WRONG TOKEN. ***
    // MEASURED on the oracle (Steam relations.png): the unit-profile tab band is `SHORT_TAB` --
    // a 40x24 record -- drawn at ~30px tall (a fit of 1.230). We were rendering `TAB`, the 40x36
    // TALL token, at 1:1. So our tabs were simultaneously TOO TALL (wrong token) and their labels
    // TOO SMALL (1.0 interface scale): two errors in OPPOSITE directions, which is exactly why
    // scaling the tab up without fixing the token would have made it MORE wrong, not less.
    //
    // Retargeting the `primary` LEVEL is the whole fix -- every `level: "primary"` caller (the unit
    // profile, the info shell, the stockpile/zone panels) lands on the native token with no consumer
    // edit, and `primary-short` stays as an explicit alias so any existing caller keeps working.
    // The tall `TAB` / `TAB_SELECTED` pair is deliberately NOT reachable from any level: no capture
    // in evidence shows DF using it for the surfaces we render. Add a level when one does.
    tabs: {
      primary: { off: "SHORT_TAB", on: "SHORT_TAB_SELECTED", w: 40, h: 24 },
      "primary-short": { off: "SHORT_TAB", on: "SHORT_TAB_SELECTED", w: 40, h: 24 },
      subtab: { off: "SHORT_SUBTAB", on: "SHORT_SUBTAB_SELECTED", w: 40, h: 24 },
      subsubtab: { off: "SHORT_SUBSUBTAB", on: "SHORT_SUBSUBTAB_SELECTED", w: 40, h: 24 },
    },
    // The four-tone text plaque (F4). Tone is carried by the TEXT COLOUR on a shared slab for the
    // neutral tones, and by a DIFFERENT SPRITE for destructive.
    plaques: {
      neutral: "HORIZONTAL_OPTION_INACTIVE", neutralOn: "HORIZONTAL_OPTION_ACTIVE",
      confirm: "HORIZONTAL_OPTION_CONFIRM", destructive: "HORIZONTAL_OPTION_REMOVE",
      ornamentLeft: "HORIZONTAL_OPTION_LEFT_ORNAMENT",     // the gold corner brackets =
      ornamentRight: "HORIZONTAL_OPTION_RIGHT_ORNAMENT",   // native's FOCUS affordance, not a fill
    },
    // The COMPLETE native scrollbar family (F5). VERIFIED against interface_map.json 2026-07-11.
    //
    // *** CORRECTION TO THE MATRIX AND THE HANDBACK ***: they both list the family as including
    // `SCROLLBAR_UP` and `SCROLLBAR_DOWN`. **THOSE TWO TOKENS DO NOT EXIST.** Only the _HOVER and
    // _PRESSED arrow states are tokenized. The IDLE arrows have no token of their own -- they live
    // inside the 16x36 `SCROLLBAR` token, which is three stacked 16x12 cells
    // (idle-up / track / idle-down). We slice it accordingly. That slicing is a STRUCTURAL
    // INFERENCE from the sprite geometry, not an owner verdict: it is flagged `assumed-not-oracle`.
    //
    // The sprite settles CONFLICT C-1 without a new capture, exactly as the matrix predicted:
    // the bar is 16 px = 2 CELLS wide (E1 right; E2's "17px" and E3's "~18px + orange" are
    // hand-measurement artefacts of differently-scaled captures). Minimum thumb = SMALL_SCROLLER
    // = 24 px = 2 cells (E2 guessed ~35).
    scrollbar: {
      bar: "SCROLLBAR",                                   // 16x36: idle-up | track | idle-down
      thumbTop: "SCROLLBAR_TOP_SCROLLER",                 // 16x12 -- the gold '^' chevron CAP
      thumbCenter: "SCROLLBAR_CENTER_SCROLLER",           // 16x12 -- one centred gem ornament
      thumbBottom: "SCROLLBAR_BOTTOM_SCROLLER",           // 16x12 -- the gold 'v' chevron CAP
      thumbSmall: "SCROLLBAR_SMALL_SCROLLER",             // 16x24 -- the MINIMUM thumb
      thumbBlank: "SCROLLBAR_BLANK_SCROLLER",             // 16x12 -- plain body; tile behind one gem
      thumbOffcenter: "SCROLLBAR_OFFCENTER_SCROLLER",     // 16x24 -- unadopted; role unconfirmed
      thumbBlankHover: "SCROLLBAR_BLANK_SCROLLER_HOVER",
      thumbTopHover: "SCROLLBAR_TOP_SCROLLER_HOVER",
      thumbCenterHover: "SCROLLBAR_CENTER_SCROLLER_HOVER",
      thumbBottomHover: "SCROLLBAR_BOTTOM_SCROLLER_HOVER",
      upHover: "SCROLLBAR_UP_HOVER", upPressed: "SCROLLBAR_UP_PRESSED",
      downHover: "SCROLLBAR_DOWN_HOVER", downPressed: "SCROLLBAR_DOWN_PRESSED",
      cell: { w: 16, h: 12 },      // 2 cells wide, 1 cell tall
      minThumb: 24,                // = SMALL_SCROLLER's height
    },
    // *** DEPRECATED -- TOKENS.glyphs IS THE EMOJI PROBLEM. ***
    // Spec §13 prohibits emoji outright and §7 F4 forbids a Unicode stand-in where a sprite exists.
    // EVERY entry below now HAS a real DF sprite in TOKENS.sprites. Drift rule R3 currently only
    // requires that emoji be *routed through TOKENS*, so it BLESSES the bypass; it must be re-aimed
    // at "no emoji where a sprite exists" (that WIDENS R3, so sequence the commits or R5 turns the
    // build red). Kept ONLY so the ~14 unmigrated surfaces keep rendering until the family waves
    // adopt `sprite:`. DO NOT ADD A KEY HERE. New code uses TOKENS.sprites + iconHtml.
    glyphs: {
      view: "&#128269;",     // magnifier -- DEPRECATED: TOKENS.sprites.view (STOCKS_VIEW_ITEM).
                             // NOTE: searchHtml also reused this ONE emoji as the search magnifier,
                             // i.e. one glyph doing double duty as chrome AND as a row action, where
                             // native uses two distinct sprites (BUTTON_FILTER vs STOCKS_VIEW_ITEM).
      follow: "&#127909;",   // movie camera -- "go to / follow on map"
      forbid: "&#128274;",   // padlock
      dump: "&#128465;",     // wastebasket
      hide: "&#128065;",     // eye
      close: "&#10005;",     // MULTIPLICATION X (the bld-x glyph)
      check: "&#10003;", cross: "&#10007;", back: "&#8592;",
      // B174 workshop task-row controls (native carpenter/kitchen oracles): colored via the
      // consumer's per-action glyph-span classes, the GLYPH vocabulary is canonical here.
      repeat: "&#8635;",             // clockwise open circle arrow (native green recycle)
      priority: "!",
      pause: "&#10074;&#10074;",     // two heavy vertical bars (native blue pause)
      play: "&#9654;",               // resume affordance when a task is suspended
      building: "&#127968;",         // house -- contents-row "part of this building" status
      minus: "&#8722;", plus: "+",
    },
  };

  // ---- B230: the 23 burrow symbol crops, generated ---------------------------------------------
  // Same principle as the generated families below: spelling 23 near-identical crop records by hand
  // is how a typo becomes an invisible hole. Reading order across a 12-wide, 32px sheet -- see the
  // banner on `spriteCrops` above for the DF raws this geometry is read from.
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

  // ---- WAVE 4: the two REGULAR sprite families, generated -------------------------------------
  // 33 squad equipment slots (11 slots x 3 states) and 42 NOBLES_* cells (5 room requirements x 4
  // states, 2 mandate/demand clocks x 5, the 5-step bookkeeper precision strip x 2, + ADD/CROWN).
  // Spelling 75 keys by hand is how a typo becomes an invisible hole; these are MECHANICALLY derived
  // from DF's own naming and then re-verified name-by-name against interface_map.json by
  // dwfui_boot_test on every build. The family agents render them all through iconHtml.
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

  // Explicit allowlist: these are COMPLETE native control cells (fill, bevel, border, state color,
  // and icon baked together). TOKENS.sprites is intentionally NOT used wholesale: it also contains
  // BUTTON_FILTER_NO_MAG_RIGHT, an 8x36 composition SLICE that must never be treated as a button.
  //
  // WAVE 4 -- DELIBERATELY EXCLUDED from this allowlist even though they are now in TOKENS.sprites:
  //   TYPE_FILTER_{LEFT,TEXT,RIGHT}  24x12 slices of ONE `< All >` cycler -- a composition, not 3 buttons
  //   BUTTON_RECTANGLE*              the 3-slice plaque/slab source art
  //   BUTTON_STRESS_0..6             16x24 mood FACES: glyph-like cells, not control frames
  //   CUSTOM_SYMBOL                  indexing unverified (E4-B10) -- assumed-not-oracle
  // Everything that IS listed was reported by an evidence agent as a complete native control cell.
  const SELF_FRAMED_SPRITES = new Set([
    TOKENS.sprites.quill, TOKENS.sprites.removeBuilding, TOKENS.sprites.assignWorker,
    TOKENS.sprites.cameraOn, TOKENS.sprites.cameraOff, TOKENS.sprites.viewReports,
    // B232 R2: the alert box's open-log cell carries DF's own gold frame (sheet cell 0,0) --
    // a generic button box around it would be the double-frame defect.
    TOKENS.sprites.openAnnouncements,
    TOKENS.sprites.expel, TOKENS.sprites.settings, TOKENS.sprites.back, TOKENS.sprites.close,
    TOKENS.sprites.filter, TOKENS.sprites.filterName,
    TOKENS.sprites.view, TOKENS.sprites.inspect, TOKENS.sprites.forbid, TOKENS.sprites.forbidOn,
    TOKENS.sprites.dump, TOKENS.sprites.dumpOn, TOKENS.sprites.hide, TOKENS.sprites.hideOn,
    TOKENS.sprites.melt, TOKENS.sprites.meltOn, TOKENS.sprites.recenter, TOKENS.sprites.recenterStocks,
    // B245: the minimap icon column (oracle B243-oracle-native-icon.png). Every one of these is a
    // COMPLETE native cell -- RECENTER_HOTKEYS/_SURFACE/_DEEPEST/_SET_LOCATION carry DF's own gold
    // frame inside their 32x36 record, the display toggles are complete 16x24 cells, and
    // RECENTER_REMOVE_OR_CLEAR is native's frameless red X drawn bare. The generic square-button
    // box around them was the S2 GAP-1 double-frame defect, and painting them into a 22px icon box
    // clipped the cell to its top-left corner -- the "off centre red X" (B245 defect 3).
    TOKENS.sprites.recenterLocations, TOKENS.sprites.recenterSurface,
    TOKENS.sprites.recenterDeepest, TOKENS.sprites.recenterSet, TOKENS.sprites.recenterClear,
    TOKENS.sprites.liquidNumbersOff, TOKENS.sprites.liquidNumbersOn,
    TOKENS.sprites.rampArrowsOff, TOKENS.sprites.rampArrowsOn,
    TOKENS.sprites.suspend, TOKENS.sprites.suspendOn, TOKENS.sprites.repeat, TOKENS.sprites.repeatOn,
    TOKENS.sprites.cancelJob, TOKENS.sprites.jobRemoveWorker,
    TOKENS.sprites.workerAny, TOKENS.sprites.workerOnly,
    // WAVE-5, same class as S2 GAP-1: the workshop task row's remaining three job-state cells. They
    // sat in interface_map.json, were consumed as raw token strings, and were absent here -- so each
    // one rendered DF's own frame INSIDE our gold box. Complete native control cells (B171-2).
    TOKENS.sprites.jobActive, TOKENS.sprites.jobDoNow, TOKENS.sprites.jobDoNowOn,
    // WAVE-5: the stockpile panel's five tool tiles and its type-grid cells. Complete native control
    // cells in B143-1 (a APPROVED anchor) -- each already carries DF's own gold frame, so a
    // generic .dwfui-art-btn border around them is the double-frame defect.
    TOKENS.sprites.spRepaint, TOKENS.sprites.spRemove, TOKENS.sprites.spTakeAnywhere,
    TOKENS.sprites.spTakeLinksOnly, TOKENS.sprites.spConnections, TOKENS.sprites.spToolSettings,
    TOKENS.sprites.spTypeOn, TOKENS.sprites.spTypeOff,
    TOKENS.sprites.stepHash, TOKENS.sprites.stepPlus, TOKENS.sprites.stepMinus,
    TOKENS.sprites.priorityUp, TOKENS.sprites.priorityDown,
    TOKENS.sprites.sortAsc, TOKENS.sprites.sortAscOff, TOKENS.sprites.sortDesc,
    TOKENS.sprites.sortDescOff, TOKENS.sprites.sortText, TOKENS.sprites.sortTextOff,
    // S2 GAP-1: the squads tiles were ABSENT here, so isSelfFramedSprite("SQUADS_KILL_ORDER") was
    // false and artBtnHtml drew a SECOND border around a sprite that already carries its own. Every
    // one of these is a complete control cell in the native captures (R1/R2/R3/R11).
    TOKENS.sprites.squadsKill, TOKENS.sprites.squadsMove, TOKENS.sprites.squadsPatrol,
    TOKENS.sprites.squadsDefendBurrow, TOKENS.sprites.squadsTrain, TOKENS.sprites.squadsCancelOrder,
    TOKENS.sprites.squadsChangeAlert, TOKENS.sprites.squadsPositions, TOKENS.sprites.squadsDisband,
    TOKENS.sprites.squadsRecenter, TOKENS.sprites.checkOn, TOKENS.sprites.checkOff,
    ...SQUADS_EQUIPMENT_SPRITES,
    // S1: the Items-tab assignment indicators (grey frame baked in).
    TOKENS.sprites.invAssignedClothing, TOKENS.sprites.invAssignedTool,
    TOKENS.sprites.invAssignedSquad, TOKENS.sprites.invAssignedSymbol,
    // S3: labor / work-order / nobles tiles.
    TOKENS.sprites.kitchenCookAllowed, TOKENS.sprites.kitchenCookRestricted, TOKENS.sprites.kitchenCookCannot,
    TOKENS.sprites.kitchenBrewAllowed, TOKENS.sprites.kitchenBrewRestricted, TOKENS.sprites.kitchenBrewCannot,
    TOKENS.sprites.stoneAllowed, TOKENS.sprites.stoneRestricted,
    TOKENS.sprites.magmaSafe, TOKENS.sprites.magmaUnsafe,
    TOKENS.sprites.laborAssigned, TOKENS.sprites.laborUnassigned,
    TOKENS.sprites.laborEverybody, TOKENS.sprites.laborNobody,
    TOKENS.sprites.editWorkDetail, TOKENS.sprites.selectAll,
    // B226: complete native control cells of the trade family -- the 24x36 five-state trade
    // check tile and the 32x36 depot sort/cull tool buttons all carry DF's own frame (oracle
    // B226-barter-1..4 rows / B226-depot-1 top bar); a generic border around them would be the
    // S2 GAP-1 double-frame defect.
    TOKENS.sprites.tradeSelected, TOKENS.sprites.tradeNotSelected, TOKENS.sprites.tradeInDepot,
    TOKENS.sprites.tradeBeingBrought, TOKENS.sprites.tradeProhibited,
    TOKENS.sprites.tradeSortDistanceOn, TOKENS.sprites.tradeSortDistanceOff,
    TOKENS.sprites.tradeSortValueOn, TOKENS.sprites.tradeSortValueOff,
    TOKENS.sprites.tradeCullMandatesOn, TOKENS.sprites.tradeCullMandatesOff,
    // W8: the kitchen column mass-toggle. Both faces are COMPLETE native control cells -- they carry
    // their own gold frame (see the crop, native-kitchen-mass-toggle-arrows.png). Omitting them here
    // is exactly the S2 GAP-1 bug: artBtnHtml would draw a SECOND border around DF's own.
    TOKENS.sprites.contractList, TOKENS.sprites.expandList,
    TOKENS.sprites.woWaiting, TOKENS.sprites.woChecking, TOKENS.sprites.woValidated,
    TOKENS.sprites.woNotValidated, TOKENS.sprites.woActive, TOKENS.sprites.woReady,
    TOKENS.sprites.woConditions, TOKENS.sprites.woCreateNew, TOKENS.sprites.woRemove,
    TOKENS.sprites.woDetails,
    // B217 r2: the zone panel family. Complete framed cells in every zone oracle (B217-2,
    // Z12-jt-1/3/4, Z11-19/20/21, LEVER-LINK-1/3, "barracks zone .png") -- rendering any of them
    // inside generic latch/art-btn chrome is the S2 GAP-1 double-frame defect, which is exactly
    // what round 1 shipped for the gather/pond/pit/tomb/shoot latches.
    TOKENS.sprites.zoneRepaint, TOKENS.sprites.zoneRemove,
    TOKENS.sprites.zoneSuspend, TOKENS.sprites.zoneSuspendOn,
    TOKENS.sprites.zonePickAnimals, TOKENS.sprites.zoneAssignUnit,
    TOKENS.sprites.zoneLocationAssign, TOKENS.sprites.zoneLocationDetails,
    TOKENS.sprites.zoneQuill, TOKENS.sprites.zoneSquadList,
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
    // B276: all four access-tier faces are complete 32x36 native cells from
    // interface_bits_locations.png. Selected/unselected changes the cell, not surrounding chrome.
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

  // ---- B254 workDetailSprite: work_detail.icon -> a REAL interface token, or nothing -----------
  // DF's `work_detail.icon` is `work_detail_icon_type` (df.plotinfo.xml:573). Our /labor and /info
  // wires carry it as the bare enum key ("MINERS", "PLANT_GATHERERS", "NONE", ...) because
  // src/labor.cpp resolves it with DFHack::enum_item_key(). The tile is that key prefixed with
  // WORK_DETAIL_.
  //
  // FAILS CLOSED, and that matters: `NONE` is a REAL and COMMON value -- most custom work details
  // have no icon, and DF DRAWS NOTHING for them. Returning null (not a guessed tile, not an empty
  // placeholder) is the honest answer, and it is what keeps a NONE detail from shipping as an
  // invisible hole (data-df-identity-missing) in the residents row. An unknown key -- a DF update
  // adding an icon we have not mapped -- takes the same path: draw nothing, never invent.
  const WORK_DETAIL_ICON_TOKENS = new Set(Object.values(TOKENS.sprites)
    .filter(v => typeof v === "string" && v.startsWith("WORK_DETAIL_")));
  function workDetailSprite(iconKey) {
    const key = String(iconKey == null ? "" : iconKey).trim().toUpperCase();
    if (!key || key === "NONE" || key === "WORK_DETAIL_NONE") return null;
    const token = key.startsWith("WORK_DETAIL_") ? key : `WORK_DETAIL_${key}`;
    return WORK_DETAIL_ICON_TOKENS.has(token) ? token : null;
  }

  // ---- TriStateMark: the hierarchical list derive ----------------------------------------------
  // EXACT B151 speStateFor semantics (dwf-building-zone-stockpile-panels.js:2392) --
  // 'all' | 'some' | 'none', null while the aggregate is unknown. The equivalence is pinned by
  // tools/harness/ui_components_test.mjs importing BOTH modules; migration order #2 converts the
  // stockpile editor to delegate here.
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
  // Renders the native check / grey dash / red X mark using the oracle-extracted --spa-* art.
  // null state renders nothing (loading), matching the editor's plain-green loading row.
  function triMarkHtml(state, opts) {
    const kind = TRI_MARK_CLASS[state];
    if (!kind) return "";
    const o = opts || {};
    const cls = `${o.cls || "dwfui-mark"} ${kind}`;
    return `<span class="${cls}"${datasetAttrs(o.dataset)}${o.title ? ` title="${esc(o.title)}"` : ""} aria-hidden="true"></span>`;
  }

  // ---- F10 iconHtml: THE ONE SPRITE/ART/LETTER RESOLVER ----------------------------------------
  // Four uncoordinated art channels exist today and NO builder accepted a sprite from any of them:
  //   (1) --spa-* css vars (a frozen, hand-extracted, STATE-LESS snapshot of ~34 assets)
  //   (2) window.DFChrome.icon(token) over interface_map.json -- 1,502 tokens, live from the user's
  //       own DF install, WITH hover/active/disabled variants, already loaded, cached, and
  //       integer-scaled (_dfChromeScaleFor already enforces DF's never-sub-sample rule)
  //   (3) ad-hoc JS background-position sheets (BLD_ICON_CELL, LABOR_ICON_CELL, SP_EDIT_CATS, ...)
  //   (4) TOKENS.glyphs -- emoji.
  // iconHtml is the single funnel. rowHtml.icon, actionButtonsHtml, artBtnHtml, headerHtml.icon and
  // toolButtonHtml all route through it. DECISION D-A: adopt E6's mechanism (a `sprite:` key + ONE
  // resolver) AND E1's direction (DFChrome is the art channel; --spa-* is the fallback for the
  // handful of assets with no interface_map equivalent). Rationale, recorded per the matrix's
  // request: FOUR UNCOORDINATED ART CHANNELS IS THE DISEASE. Adding a fifth cfg field (E4's
  // `chrome:`) is not the cure -- it folds into this resolver as a special case.
  //
  // Resolution order:  sprite (interface_map TOKEN) -> item (ITEM SPRITE REF) -> art (TOKENS.art
  //                    key) -> letter -> empty tile.
  //
  // *** WAVE 4 / S4 GAP-1: THE ITEM CHANNEL. THIS IS THE ROOT CAUSE OF THE "ALL ITEM ICONS ARE
  // LETTERS IN BROWSER RIGHT NOW". *** An ITEM's art does not come from interface_map at all -- it
  // comes from DF's raws-parsed item sheets, via window.DwfTiles.resolveItemSpriteRef(ref) ->
  // {sheet, col, row} -> /sprites/img/<sheet> at a 32px background-position. DWFUI contained ZERO
  // references to that resolver, so there was NO WAY TO ASK DWFUI FOR AN ITEM ICON -- which is why
  // dwf-build-info-panels.js hand-rolled itemArtTile() (:1395), a FIFTH uncoordinated art
  // channel whose fallback was A SILENT LETTER (:1400). Eight consumers need this: stocks rows,
  // stocks search member rows, the item-sheet header, container contents rows, the co-located strip,
  // the item-sheet location row, info-shell Places/Objects rows, and the unit-profile Items tab.
  //
  //   cfg.item = {itemType, itemSubtype, materialType, materialIndex, identKind?, ident?, itemToken?}
  //
  // AN UNRESOLVED ITEM FAILS LOUD, EXACTLY LIKE AN UNRESOLVED TOKEN: data-df-identity-missing +
  // the native empty tile. IT NEVER DEGRADES TO A LETTER. Passing `item` AND `letter` together
  // THROWS -- the letter path is the blocker this channel exists to retire, and quietly reinstating
  // it as a fallback is precisely the bug. A malformed/absent ref is marked at BUILD time (that is
  // dwf-build-info-panels.js:1455 -- itemArtTile() called with no spriteRef at all, so the
  // location row's stockpile icon ALWAYS degraded to the letter "F"); a well-formed ref that the
  // item map cannot resolve is marked at PAINT time by paintItemSprites().
  //
  // THE LETTER PATH IS A BLOCKER, NOT A FALLBACK. It emits an explicit `data-df-identity-missing`
  // marker so the "all item icons are letters in browser right now" is MECHANICALLY DETECTABLE
  // instead of silent (spec §7 F10 requires the screen to expose it as an evidence/data blocker).
  // Native itself NEVER substitutes a letter for missing art: in the equipment choosers a row with
  // no sprite renders an EMPTY PURPLE TILE (5.2.1 Select Bodywear Menu.PNG). That is `emptyTile`.
  //
  // cfg: {sprite, spriteCrop, item, art, letter, emptyTile, nativeCell, size (px, default 32), cls,
  // dataset, alt, title}. `spriteCrop` names a TOKENS.spriteCrops entry and renders only that
  // intrinsic glyph; `sprite` continues to render the complete source record unchanged.
  // A `sprite:`/`item:` is INERT until DWFUI.paintSprites(root) runs over the inserted markup --
  // these builders are string-only by contract, so the blit is a separate, explicit DOM pass.
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
    // PRESENCE, not truthiness: `iconHtml({item: someUndefinedRef})` MUST take the item path and
    // fail loud. Reading it as "no item channel requested" is how a missing ref silently became a
    // letter in the first place.
    const hasItem = Object.prototype.hasOwnProperty.call(c, "item");
    if (hasItem && c.letter != null && String(c.letter) !== "")
      throw new Error("DWFUI.iconHtml: `item` and `letter` are mutually exclusive. An unresolved " +
        "item sprite must FAIL LOUD (data-df-identity-missing + the native empty tile); the letter " +
        "path is the BLOCKER this channel exists to retire, not its fallback.");
    const size = Number(c.size) > 0 ? Math.round(Number(c.size)) : 32;
    const classes = ["dwfui-icon"];
    const spriteCrop = c.spriteCrop && TOKENS.spriteCrops[c.spriteCrop];
    // Some interface_map records are complete controls, not glyphs. Their own canvas must define
    // the rectangle; forcing a 24x36 native cell into the generic square icon box clips it and then
    // tempts its parent to draw a second button around it.
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
        ` style="--dwfui-icon-crop-w:${spriteCrop.w}px;--dwfui-icon-crop-h:${spriteCrop.h}px"${attrs()}></span>`;
    }
    if (c.spriteCrop) {
      classes.push("dwfui-icon--empty");
      if (c.cls) classes.push(c.cls);
      return `<span class="${classes.join(" ")}"${box} data-df-identity-missing="sprite-crop:${esc(c.spriteCrop)}"${attrs()}></span>`;
    }
    if (c.sprite) {
      if (c.cls) classes.push(c.cls);
      return `<span class="${classes.join(" ")}" data-dwfui-sprite="${esc(c.sprite)}"` +
        `${selfFramed ? ` data-dwfui-self-framed="true"` : ""}` +
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

  // The DOM half of F10/F5/F7. DWFUI builders are string-only, but three contracts genuinely need a
  // post-insert pass over the real nodes; the matrix names all three (paintSprites, restoreScroll,
  // restoreSearchCaret). They are the ONLY DOM-touching members of this module, they are idempotent,
  // and they are no-ops under node.
  //
  // paintSprites: blit every [data-dwfui-sprite] placeholder through DFChrome (integer scale,
  // nearest-neighbour, straight out of DF's own interface_bits*.png). Call it once after any
  // innerHTML assignment that may contain DWFUI icons. Returns the number of sprites painted.
  //
  // *** FB-6 (fixed here): AN UNRESOLVED `sprite:` FAILED SILENTLY. *** iconHtml marks a bad `art:`
  // or `letter:` with data-df-identity-missing, but an unknown TOKEN produced a bare span, and
  // DFChrome.updateIcon RETURNS QUIETLY when its map has no cell for the token -- so a typo'd token
  // shipped as an INVISIBLE HOLE. That is exactly the FB-2 failure mode (markup asserts true, screen
  // shows an empty box), so it gets the same treatment as the other two channels: the node is marked
  // `data-df-identity-missing="sprite:TOKEN"` and painted with the native empty-tile class, and
  // tools/harness/dwfui_boot_test.mjs fails the build on any token absent from interface_map.json.
  //
  // The audit needs the map, which may still be in flight, so it runs on loadMap()'s resolution --
  // the paint itself is issued immediately (updateIcon defers internally). Idempotent: a token that
  // later resolves has its marker cleared.
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
  function _sheetImage(name) {
    let img = _spriteCropImages[name];
    if (!img) { img = new root.Image(); img.src = "/asset/" + name; _spriteCropImages[name] = img; }
    return img;
  }
  // Explicit escape hatch for genuinely composed markup in a text slot. Normal component text is
  // bitmap-first; callers may not silently fall back to inherited DOM text. The required reason is
  // both human-readable review context and a static-ratchet marker.
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
  function _whenLoaded(img, draw) {
    if (img.complete && img.naturalWidth) draw();
    else img.addEventListener("load", draw, { once: true });
  }
  // *** THIS REPLACES DFChrome.updateIcon FOR DWFUI SPRITES, AND THAT IS THE POINT OF THE WAVE. ***
  // DFChrome._dfChromeScaleFor is the D1 integer rule in code: `Math.max(1, Math.round(target/native))`
  // -- which makes DF's real ~1.25 interface scale literally UNREPRESENTABLE and pins every DWFUI
  // control cell at 1:1. DFChrome is left alone (the top bar and the game-chrome toolbar are OUR
  // widgets, not DF's interface, and they keep the integer rule), and the interface scale lives here,
  // in the interface layer, where it belongs.
  //
  //   boxPx == 0  a COMPLETE native control cell (data-dwfui-self-framed): its record IS the
  //               rectangle, so it is drawn at rec.w x rec.h TIMES the interface scale. The oracle's
  //               UNIT_SHEET_* icons are exactly this: a 32x36 record drawn at 40x45.
  //   boxPx > 0   a glyph-like icon in a caller's box. The box is authored at DF's resolution and is
  //               itself scaled by CSS (.dwfui-icon multiplies --dwfui-icon-size by the interface
  //               scale), so the art fills it at fit x interfaceScale. NATIVE IS STILL THE FLOOR:
  //               `Math.max(1, box/native)` keeps DF's "never sub-sample BELOW native resolution"
  //               rule, which was always right. It is only the INTEGER QUANTISATION that is retired,
  //               and only that -- a caller's box can no longer silently shrink DF's art either.
  //
  // The BACKING STORE additionally carries the UI-scale slider's zoom, with the CSS box pinned to the
  // unzoomed size -- so the slider scales art we already drew at its density (see uiZoom above).
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
      ctx.clearRect(0, 0, w, h);
      _bakeBlit(ctx, img, rec.cx, rec.cy, rec.w, rec.h, 0, 0, w, h);
    });
  }
  function _paintSpriteCrop(canvas, crop, token, chrome) {
    const apply = map => {
      const rec = map && map[token];
      if (!rec || !root || !root.Image) return;
      canvas.width = crop.w;
      canvas.height = crop.h;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      let img = _spriteCropImages[rec.img];
      if (!img) {
        img = new root.Image();
        img.src = "/asset/" + rec.img;
        _spriteCropImages[rec.img] = img;
      }
      const draw = () => {
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
      if (img.complete && img.naturalWidth) draw();
      else img.addEventListener("load", draw, { once: true });
    };
    const loaded = chrome.getCell && chrome.getCell(token);
    if (loaded) apply({ [token]: loaded });
    else if (chrome.loadMap) Promise.resolve(chrome.loadMap()).then(apply);
  }
  function paintSprites(rootNode) {
    const host = rootNode || (typeof document !== "undefined" ? document : null);
    const chrome = root && root.DFChrome;
    if (!host || !host.querySelectorAll || !chrome || !chrome.getCell) return 0;
    const doc = (host.ownerDocument) || (host.nodeType === 9 ? host : null) ||
      (typeof document !== "undefined" ? document : null);
    const nodes = [];
    host.querySelectorAll("[data-dwfui-sprite]").forEach(node => nodes.push(node));
    // ONE scale for the whole document, read ONCE per pass -- exactly as DF has one interface scale.
    // Stamping it here is what makes DFBitmapText's "the text follows the art" contract true in the
    // product: whatever we just painted the art at IS what the labels will be rendered at.
    const iface = interfaceScale(doc);
    _publishInterfaceScale(doc, iface);
    let painted = 0;
    const paintOne = node => {
      const token = node.getAttribute("data-dwfui-sprite");
      // Complete controls have no caller box: their record IS the rectangle (times the interface
      // scale). A caller's `size` is for glyph-like art only.
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
        .then(map => { const r = map && map[token]; if (r) _paintSpriteScaled(canvas, r, size, doc); });
    };
    nodes.forEach(node => { paintOne(node); painted++; });
    if (nodes.length && chrome.loadMap) {
      try {
        Promise.resolve(chrome.loadMap()).then(map => nodes.forEach(node => _auditSprite(node, map)));
      } catch (_) { /* a map that cannot load is DFChrome's problem to log, not ours to throw on */ }
    }
    // B225 LightPlaque pass: nine-slice-tiled left-rail attention plaques (lightPlaqueHtml).
    host.querySelectorAll("canvas[data-dwfui-lightplaque]").forEach(canvas => {
      const token = canvas.getAttribute("data-dwfui-lightplaque");
      const rec = chrome.getCell(token);
      if (rec) { _paintLightPlaque(canvas, rec, doc); painted++; }
      else if (chrome.loadMap) Promise.resolve(chrome.loadMap())
        .then(map => { const r = map && map[token]; if (r) { _paintLightPlaque(canvas, r, doc); } });
    });
    return painted + paintItemSprites(host);
  }

  // ---- S4 GAP-1, the DOM half: paint the ITEM sprites -------------------------------------------
  // The sibling of paintSprites for the item channel. Item art lives on DF's raws-parsed item
  // SHEETS, not in interface_map, so it resolves through DwfTiles.resolveItemSpriteRef and is
  // blitted as a background-position crop of /sprites/img/<sheet> -- the same mechanism
  // dwf-build-info-panels.js hand-rolled, now owned by the one resolver.
  //
  // paintSprites() calls this, so every surface that already does the F10 DOM pass (or is under
  // mountDom's observer) gets item art for free -- no per-panel sprinkle.
  //
  // FAIL LOUD, NEVER A LETTER: a ref the item map cannot resolve -- or a page with no item map at
  // all -- is marked data-df-identity-missing="item:<ref>" and painted with the native empty tile.
  // Idempotent: a node that later resolves has its marker cleared.
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
        try { cell = resolve(JSON.parse(node.getAttribute("data-dwfui-item"))); } catch (_) { cell = null; }
      }
      const ok = !!(cell && cell.sheet &&
        Number.isFinite(Number(cell.col)) && Number.isFinite(Number(cell.row)));
      if (!ok) {
        node.setAttribute("data-df-identity-missing", "item:" + key);
        if (node.classList) node.classList.add("dwfui-icon--empty");
        if (node.style && node.__dwfuiItemPaint) { node.style.backgroundImage = ""; node.__dwfuiItemPaint = ""; }
        return;
      }
      node.removeAttribute("data-df-identity-missing");
      if (node.classList) node.classList.remove("dwfui-icon--empty");
      // Item art used to be a background-position over the COMPLETE source sheet. That only clips
      // one cell while the target box is exactly 32px: a 48px icon or any interface/UI scaling
      // exposes the neighbouring cells, producing several sprites in one box. Blit the resolved
      // 32x32 cell into its own canvas instead, exactly like the interface-token channel above.
      // The canvas backing store includes UI zoom while its CSS footprint remains on DWFUI's one
      // interface grid, so scaling cannot reveal another part of the sheet or soften a stale 1x crop.
      const d = node.ownerDocument || (typeof document !== "undefined" ? document : null);
      const iface = interfaceScale(d), zoom = uiZoom(d);
      const authored = Number(String(node.style && node.style.getPropertyValue
        ? node.style.getPropertyValue("--dwfui-icon-size") : "").replace("px", "")) || ITEM_CELL;
      const cssSize = authored * iface;
      const backing = Math.max(1, Math.round(cssSize * zoom));
      const paint = `${cell.sheet}|${cell.col}|${cell.row}|${backing}|${cssSize}`;
      if (node.__dwfuiItemPaint !== paint) {
        node.__dwfuiItemPaint = paint;
        // Retire any paint left by the old full-sheet background implementation.
        node.style.backgroundImage = "";
        node.style.backgroundPosition = "";
        node.style.backgroundSize = "";
        // Keep the pure no-DOM harness usable without restoring the unsafe full-sheet background.
        // A browser always has these APIs and therefore always takes the isolated-canvas path.
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
          ctx.clearRect(0, 0, backing, backing);
          _bakeBlit(ctx, img, Number(cell.col) * ITEM_CELL, Number(cell.row) * ITEM_CELL,
            ITEM_CELL, ITEM_CELL, 0, 0, backing, backing);
        });
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

  // ---- FB-2 mountDom: THE DOM HALF, BOOTED ------------------------------------------------------
  // *** THIS IS THE FIX FOR THE SERIOUS DEFECT. *** paintSprites / mountScrollbarArt / restoreScroll
  // / restoreSearchCaret shipped with ZERO CALLERS in web/js. The builders emitted sprite spans and
  // nothing ever painted them, so:
  //   * the search magnifier on workshop-picker/{all,filtered,no-results} -- THREE OF THE APPROVED
  //     ANCHORS -- changed from the emoji to a BUTTON_FILTER sprite span and rendered as an EMPTY BOX.
  //     A visible control became invisible on an approved screen.
  //   * the native scrollbar painted colour-correct and ART-LESS: the SCROLLBAR_* cells never blit.
  // Parity Studio called these four itself (tools/ui-lab/stories.js), which is precisely why the
  // gallery looked right while production did not.
  //
  // The cure has to be CENTRAL. A per-panel sprinkle rots the moment someone adds a panel -- and it
  // would already miss kitchen and help-panel, which emit magnifiers without going through
  // panelContent(). So the boot is ONE observer over the document:
  //   1. mountScrollbarArt once (it publishes the --dwfui-sb-* crops onto :root);
  //   2. one pass over the document as it stands;
  //   3. a MutationObserver on the whole subtree, so EVERY surface -- present and future -- gets the
  //      DOM half for free, whatever route its markup took into the page.
  // Callbacks are microtasks, so a repaint lands before the browser paints: no flash.
  //
  // Cost is bounded: the map is a <canvas>, so the 30fps render path mutates NO DOM (AGENTS.md's
  // per-frame rule is respected -- this observer is idle while the game runs). Records whose target
  // sits inside a sprite span are ignored, because paintSprites' own canvas append is itself a
  // mutation and would otherwise re-enter.
  // Returns the observer (or null), so a caller can disconnect it; idempotent per document.
  function mountDom(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || !d.querySelectorAll) return null;
    if (d.__dwfuiDomMounted) return d.__dwfuiDomObserver || null;
    d.__dwfuiDomMounted = true;
    // Publish DF's interface scale BEFORE anything paints: DFBitmapText reads
    // data-dwfui-interface-scale off <html> as its first precedence, so stamping it here means the
    // very first label pass already lands on DF's grid instead of rendering at 1x and re-rendering.
    try { _publishInterfaceScale(d, interfaceScale(d)); } catch (_) {}
    try { mountScrollbarArt(d); } catch (_) {}
    try { mountTabArt(d); } catch (_) {}
    try { mountPlaqueArt(d); } catch (_) {}
    try { mountCyclerArt(d); } catch (_) {}
    const pass = node => {
      if (!node || !node.querySelectorAll) return;
      paintSprites(node);
      paintBitmapText(node);
      restoreScroll(node);
      restoreSearchCaret(node);
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
        // Text/color/scale changes are the dirty-label path. The original observer requested
        // attributes but then discarded every attribute record because it required addedNodes;
        // dynamic task labels therefore stayed visually stale until some unrelated DOM insertion.
        //
        // *** BUT AN ATTRIBUTE RECORD IS NOT A CHANGE. *** The DOM fires one for a RE-SERIALISATION
        // even when the value is IDENTICAL -- and `DOMTokenList.remove()` re-serialises `class` even
        // when the token was never there. That is one half of the infinite repaint loop measured on
        // an IDLE page (180,720 records in 10s, ALL `class`, ALL WITH IDENTICAL OLD AND NEW VALUES;
        // long tasks doubling 361 -> 23,138 ms; any list scrolled below the fold could wedge the
        // player's tab). The other half -- the unconditional deferral writes -- is fixed in
        // dwf-bitmap-text.js's markFallback(). This is the belt to that pair of braces.
        //
        // DROPPING NO-OP RECORDS IS THE PRECISE CURE: it kills the loop without touching the
        // dirty-label path, because a real text/colour/scale change always has oldValue !== new.
        // (Blanket-skipping attribute records on [data-dwfui-bitmap-text] nodes -- i.e. reusing the
        // childList re-entry guard below -- would also kill the loop, and would silently reintroduce
        // the stale-label bug this observer exists to fix. Do not do that.)
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
    // attributeOldValue is REQUIRED, not decoration: without the old value we cannot tell a real
    // change from a no-op re-serialisation, and the no-op is what loops.
    observer.observe(d.body || d.documentElement || d, {
      childList: true, subtree: true, attributes: true, attributeOldValue: true,
      attributeFilter: ["class", "style", "data-dwfui-bitmap-text", "data-dwfui-bitmap-scale"],
    });
    d.__dwfuiDomObserver = observer;
    return observer;
  }

  // ---- F5 mountScrollbarArt: the native scrollbar, blitted --------------------------------------
  // The native scrollbar art is NOT missing -- it is DEAD CODE. `.dwfui-scroll` set BOTH the standard
  // `scrollbar-color`/`scrollbar-width` AND `::-webkit-scrollbar-*` rules; in Chromium >= 121 the
  // standard properties WIN and the hand-drawn webkit art is silently ignored. So the owner sees a default
  // bar. The fix is to DELETE the standard declarations (done in dwf.css) and to feed the
  // webkit pseudo-elements the REAL sprites.
  //
  // A ::-webkit-scrollbar-* pseudo-element cannot crop a sprite SHEET (background-repeat would tile
  // the whole sheet, not the cell), so we crop each cell ONCE, client-side, out of the sheet DFChrome
  // has already loaded, and publish the results as --dwfui-sb-* custom properties on :root. The sheet
  // is same-origin (/asset/), so the canvas is not tainted. No new served asset, no C++ change.
  //
  // The long thumb is TOP_SCROLLER + BOTTOM_SCROLLER caps over a tiled BLANK_SCROLLER body, with
  // CENTER_SCROLLER drawn ONCE in the middle. the native long-thumb capture proves the centre
  // token is the gem ornament, not a repeating body. The chevrons belong to the THUMB because the
  // caps ARE the chevrons.
  //
  // `assumed-not-oracle` (D2-EXT), stated plainly: SCROLLBAR_UP / SCROLLBAR_DOWN do NOT exist as
  // tokens. The IDLE arrows are inferred to be the top and bottom 16x12 cells of the 16x36 SCROLLBAR
  // token (with its middle cell as the track). The geometry fits exactly, but no capture proves it.
  // Render it into the Studio gallery and diff against B151-3 before anyone calls it native.
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
      // Baked at the interface scale (with the 50% blend) exactly like the tabs, so the ::-webkit-
      // scrollbar pseudo-elements -- whose boxes are `calc(<native> * var(--dwfui-interface-scale))`
      // in dwf.css -- get a slice that is already the right size. The bar grows WITH the rest
      // of the interface; it does not stay a 16px stripe beside 1.25x chrome.
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
        // The long thumb is four layers: caps, a plain tiled body, and ONE centered gem. The native
        // long-thumb capture proves CENTER_SCROLLER is an ornament, not the repeating body.
        const named = {
          "--dwfui-sb-thumb-top": SB.thumbTop, "--dwfui-sb-thumb-center": SB.thumbCenter,
          "--dwfui-sb-thumb-bottom": SB.thumbBottom, "--dwfui-sb-thumb-blank": SB.thumbBlank,
          "--dwfui-sb-thumb-small": SB.thumbSmall,
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

  // ---- F3 mountTabArt: the native tab sprites, actually used -----------------------------------
  // The first foundation pass named all eight real TAB tokens, then drew the visible components
  // with CSS colours + clip-path. The gallery showed the real sprites underneath the imitations,
  // which made a "completeness" review prove the opposite of what it claimed. Each 40px token is
  // FIVE 8px character cells: two cells make the complete left cap, ONE flat centre cell repeats,
  // and two cells make the complete right cap. The centre is TILED, never stretched. Cutting this as
  // 8|24|8 damages both bevel transitions; stretching the 24px remainder then warps them further.
  // The CSS imitation remains only as the fail-open paint before the sheet finishes loading.
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
        // DF's tab cells are stored fully opaque. The pixels outside each trapezoid use the source
        // cell's corner colour (#1c1c1c for most families, #282828 for the grey subtab family), not
        // alpha. Native composites those pixels as empty space; a browser crop otherwise exposes a
        // rectangular "bad JPEG" halo, most visibly around SHORT_SUBTAB. Key out the record's own
        // top-left pixel so every family becomes genuinely transparent outside its slopes.
        //
        // THE KEYING MUST HAPPEN AT 1:1, BEFORE THE SCALE. Keying a blended image cannot work: the
        // blend has already mixed the key colour into the trapezoid's slopes, so an exact-RGB match
        // no longer finds it and the halo comes back along every diagonal.
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
        // ...and NOW bake DF's interface scale + the 50% blend into the slice, ONCE, at mount. The
        // CSS lays these out at `calc(<native> * var(--dwfui-interface-scale))`, so the cropped slice
        // and its box are the same size and the browser never resamples a tab at paint time.
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

  // HORIZONTAL_OPTION plaques are 8|8|8 constructions: fixed caps around one tiled centre cell.
  // The four states live on two sheets, so both are loaded honestly before native paint is enabled.
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
          // Key at 1:1, THEN bake the interface scale + the 50% blend (see mountTabArt for why that
          // order is the only one that works).
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

  // B250: the cycler's middle plate, cut for a CONTENT-SIZED box. TYPE_FILTER_TEXT is one 24x12
  // gold-framed dark plate (1-native-px #ffbf01 frame around a #1c1c1c fill; columns 1..22 are
  // byte-identical -- verified against the vanilla sheet). An iconHtml cell can only ever be that
  // one rectangle, which is exactly the B250 crush. Cut 8|8|8 like the HORIZONTAL_OPTION plaques
  // -- fixed caps around one tiled centre cell -- and the plate follows any label. The fill is a
  // full opaque rectangle, so unlike tabs there is nothing to colour-key.
  function mountCyclerArt(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const chrome = root && root.DFChrome;
    if (!d || !d.documentElement || !chrome || !chrome.loadMap || typeof Image === "undefined") return false;
    if (d.documentElement.getAttribute("data-dwfui-cycler") === "native") return Promise.resolve(true);
    return chrome.loadMap().then(map => {
      const rec = map && map.TYPE_FILTER_TEXT;
      if (!rec || rec.w !== 24 || rec.h !== 12) return false;
      const sheet = new Image();
      sheet.src = "/asset/" + rec.img;
      const iface = interfaceScale(d);
      const crop = (record, sx, sw) => {
        const canvas = d.createElement("canvas");
        canvas.width = sw; canvas.height = record.h;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sheet, record.cx + sx, record.cy, sw, record.h, 0, 0, sw, record.h);
        // Bake DF's interface scale + the 50% blend ONCE at mount, exactly like tabs/plaques, so
        // the CSS box (8px * scale) and the slice are the same size and nothing resamples at paint.
        if (Math.abs(iface - 1) < 1e-6) return `url("${canvas.toDataURL("image/png")}")`;
        const scaled = d.createElement("canvas");
        scaled.width = Math.max(1, Math.round(sw * iface));
        scaled.height = Math.max(1, Math.round(record.h * iface));
        _bakeBlit(scaled.getContext("2d"), canvas, 0, 0, sw, record.h, 0, 0, scaled.width, scaled.height);
        return `url("${scaled.toDataURL("image/png")}")`;
      };
      const publish = () => {
        const style = d.documentElement.style;
        style.setProperty("--dwfui-cycler-mid-left", crop(rec, 0, 8));
        style.setProperty("--dwfui-cycler-mid-middle", crop(rec, 8, 8));
        style.setProperty("--dwfui-cycler-mid-right", crop(rec, 16, 8));
        d.documentElement.setAttribute("data-dwfui-cycler", "native");
        return true;
      };
      if (sheet.complete && sheet.naturalWidth) return publish();
      return new Promise(resolve => {
        sheet.addEventListener("load", () => resolve(publish()), { once: true });
        sheet.addEventListener("error", () => resolve(false), { once: true });
      });
    });
  }

  // ---- F5 restoreScroll / F7 restoreSearchCaret -------------------------------------------------
  // The scroll-preservation math is copy-pasted in the labor grid (B66) and the notifications panel;
  // the caret-restore logic is copy-pasted FOUR times across the info shell. One helper each,
  // keyed by markup (`preserveKey` on scrollHtml / searchHtml), so a deterministic re-render does
  // not throw the user back to the top of the list or eat the character they just typed.
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
        try { node.focus({ preventScroll: true }); node.setSelectionRange(saved, saved); } catch (_) {}
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
  // icon | copy(label + sublabel) | trailing(state mark / action cluster). cfg:
  //   tag ('div'), cls, dataset {camelCase: value}, role, checked (-> aria-checked), selected,
  //   on (true/false -> 'on'/'off' class, null -> neither), disabled, title, ariaLabel,
  //   icon (RAW html: farmCellMarkup / portrait / sprite span), copyCls, label / labelHtml,
  //   labelCls, sub {text|html, cls}, trailing (RAW html).
  // Emits exactly three top-level cells when icon+copy+trailing are present, so the existing
  // per-surface CSS grids (42px 1fr 34px etc.) keep working under their own class hooks.
  // ---- F6 REFINEMENT. Native does NOT have one row look -- it has TWO row CHASSIS, and a set of
  // CELLS that plug into them. rowHtml implemented exactly one grammar, which could express the
  // cells but could express NEITHER chassis's paint NOR either of the two selection treatments.
  // That is the mechanical reason the owner keeps writing "generic row, selection, and master/detail
  // styling". There was also no `.dwfui-row.selected` CSS rule anywhere in the codebase.
  //
  //   chassis 'slab'  -- a raised bevelled slab; state IS colour (red off / green on / grey some).
  //                      Selected = GOLD CORNER BRACKETS drawn OUTSIDE the slab.
  //   chassis 'table' -- NO slab. Transparent over the panel surface, diagonal cross-hatch filling
  //                      the unused horizontal space, hairline separator.
  //                      Selected = a 2px GOLD RECTANGLE around the whole row.
  //
  // *** IN BOTH CHASSIS THE FILL DOES NOT CHANGE ON SELECTION. *** (CONFLICT C-2, RESOLVED by the
  // coordinator in two native captures: 13-info-creatures.png and the APPROVED anchor B151-3.png --
  // the selected "Meat" row keeps its red fill and merely GAINS a gold border.) A highlighted
  // background band is the wrong answer and is what we ship today.
  //
  // Everything below is ADDITIVE: an existing caller that passes none of {chassis, state, cells}
  // gets byte-identical markup, so the pinned class strings in obligations_test / chat_client_test /
  // help_reference_test keep matching.
  //
  // cfg (new keys marked *):
  //   tag, cls, dataset, role, checked, selected, on, disabled, title, ariaLabel,
  //   icon (RAW html) | *iconCfg (an iconHtml cfg -> F10 resolver),
  //   copyCls, label / labelHtml, labelCls, sub {text|html, cls}, trailing (RAW html),
  //   *chassis: 'slab' | 'table'
  //   *state:   'on' | 'off' | 'some' | null   (native tri-state; 'some' was UNREACHABLE before --
  //             --spa-row-grey was declared in CSS but had no TOKENS.art key)
  //   *cells:   [{html, cls, width} | null]  -- an ABSENT cell renders NOTHING. Native OMITS a cell,
  //             it does not blank it: a task with no worker simply has nothing in the worker columns
  //             (tasks screen.png). A flex row that closes the gap is wrong; the columns are fixed.
  //
  // ---- THE TRAILING CLUSTER IS A RIGHT-PINNED COLUMN (row grammar; no API, no DOM change) -------
  // `trailing` is the row's LAST cell, and on either chassis it is PINNED TO THE RIGHT EDGE: the
  // slack lands BEFORE it, so a cluster sits at the same x on every row regardless of how long the
  // label is. That is native (contents tiles x=535..668 on every row of the container oracle; the
  // squads select check x=312..355 on every row of `1. Squad Menu.PNG`) and it is now the chassis's
  // job, not each consumer's -- see the `:last-child:not(.dwfui-copy):not(.dwfui-cell)` rule in css.
  // It is NOT keyed on `.dwfui-copy` on purpose: `copyCls` REPLACES that class rather than adding to
  // it (same footgun as `sub.cls` below), so any family that renamed its copy cell had silently lost
  // the chassis's flex:1 and was staggering its own trailing tiles. `cells` are exempt: those are
  // FIXED COLUMNS that butt together, and pushing the last one to the far edge would tear a task row
  // apart. Consumers: item-sheet contents rows, squads select check, justice + unit-profile tiles.
  //
  // ---- WAVE 4 / S2 GAP-2: `stacked` -- THE TWO-BAND ROW. --------------------------------------
  // Native's squad row (R1/R2) is not one flex line. It is TWO BANDS:
  //   band 1  a CONTROL STRIP  [emblem][portrait][positions][quill] ---- spacer ---- [check]
  //   band 2  a COPY BLOCK spanning the row's FULL WIDTH, *beneath* the strip: name (bright white) /
  //           order (grey, ORANGE while an order is active) / `Routine:<name>`.
  // `.dwfui-row--table` is a single flex line, so the copy sits BESIDE the tiles and no amount of JS
  // fixes it. `stacked: true` is a MODIFIER on a chassis (S2's own prescription: flex-wrap +
  // flex-basis:100% on .dwfui-copy), NOT a third chassis: the hatch, the hairline and the selection
  // paint are the table chassis's and must not be re-declared. The DOM is UNCHANGED -- the copy is
  // re-ORDERED into band 2 by CSS -- so every existing rowHtml caller is byte-identical.
  // Consumers: squads list, R11 equip member rows, R7 position rows. = 3.
  //
  // The 3-LINE copy block needs THREE lines, and `sub` was ONE line. `sub` may now be an ARRAY of
  // line specs -- {text|html, cls, tone} -- so the order line can be ORANGE (`tone:'warning'`, i.e.
  // --dwfui-text-warning) WITHOUT a consumer hand-writing an inline hex. A non-array `sub` is
  // untouched (one .dwfui-sub span, exactly as before).
  const ROW_STATE_CLASS = { on: "on", off: "off", some: "some" };
  // The text roles a copy line may take. A tone is a CLASS HOOK onto --dwfui-text-<role>; a consumer
  // may not pass a colour. An unknown tone renders with no tone class (it never throws and never
  // invents a colour).
  const SUB_TONES = new Set(["secondary", "warning", "good", "active", "numeric", "row", "disabled"]);
  function subLineHtml(line) {
    if (line == null) return "";
    const classes = [line.cls || "dwfui-sub"];
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
    // --- additive F6 vocabulary (opt-in; absent => byte-identical to the pre-F6 markup) ---
    const chassis = (c.chassis === "slab" || c.chassis === "table") ? c.chassis : null;
    if (chassis) classes.push(`dwfui-row--${chassis}`);
    const state = ROW_STATE_CLASS[c.state] || null;
    if (state) classes.push(`dwfui-row--${state}`);
    // Selection PAINTS PER CHASSIS. Neither variant changes the fill.
    if (c.selected && chassis)
      classes.push(chassis === "slab" ? "dwfui-row--sel-brackets" : "dwfui-row--sel-outline");
    // S2 GAP-2. A modifier, and only ON a chassis: `stacked` re-lays the chassis's own cells into
    // two bands. Without a chassis there is no row grammar to re-lay, so it is a no-op rather than
    // a silent half-styled row.
    if (c.stacked && chassis) classes.push("dwfui-row--stacked");
    // B270 -- CHASSIS-LESS ICON+LABEL LAYOUT. The native zone-add palette (and any plain icon+text
    // list) is a row with NO fill art: neither slab nor the table hatch. Before this, such rows had
    // to hand-roll a private CSS grid, and every one of them hardcoded the icon column as a bare
    // `NNpx` track -- which cannot hold `.dwfui-icon` (that box is `32px * --dwfui-interface-scale`, so
    // 40px at the default 1.25 scale). The 40px icon overflowed the 32px track and crushed the
    // icon->label gap to -2px (measured). `layout:'icon'` gives the row an AUTO icon column (it takes
    // the icon's own scale-derived width -- no magic number) + a scale-coupled gap, defined ONCE in
    // the CSS layer. It is fill-less on purpose, so it cannot be confused with a chassis. Opt-in:
    // absent => byte-identical to the pre-B270 markup.
    if (c.layout === "icon") classes.push("dwfui-row--icon");
    // `disabled` on a <div> is an inert HTML attribute that does nothing -- and most native rows
    // ARE divs. That was a BUG, not a gap: there was no disabled paint at all. Add the class too.
    if (c.disabled) classes.push("disabled");
    let attrs = ` class="${classes.join(" ")}"`;
    if (c.role) attrs += ` role="${esc(c.role)}"`;
    if (c.checked != null) attrs += ` aria-checked="${c.checked ? "true" : "false"}"`;
    if (c.selected) attrs += ` aria-selected="true"`;
    if (c.ariaLabel) attrs += ` aria-label="${esc(c.ariaLabel)}"`;
    if (c.title) attrs += ` title="${esc(c.title)}"`;
    if (c.disabled) attrs += " disabled";
    attrs += datasetAttrs(c.dataset);
    const icon = c.icon != null ? c.icon : (c.iconCfg ? iconHtml(c.iconCfg) : "");
    const label = c.labelHtml != null ? c.labelHtml : bitmapTextHtml(c.label == null ? "" : c.label);
    const sub = Array.isArray(c.sub)
      ? c.sub.map(subLineHtml).join("")
      : (c.sub ? subLineHtml(c.sub) : "");
    const copy = `<span class="${c.copyCls || "dwfui-copy"}"><span class="${c.labelCls || "dwfui-label"}">${label}</span>${sub}</span>`;
    // R6's multi-column table row. Omitted cells emit NOTHING (see above).
    const cells = Array.isArray(c.cells)
      ? c.cells.filter(cell => cell != null && cell.html != null).map(cell =>
        `<span class="dwfui-cell${cell.cls ? " " + cell.cls : ""}"` +
        `${Number(cell.width) > 0 ? ` style="--dwfui-cell-w:${Math.round(Number(cell.width))}px"` : ""}` +
        `>${cell.html}</span>`).join("")
      : "";
    return `<${tag}${attrs}>${icon}${copy}${cells}${c.trailing || ""}</${tag}>`;
  }

  // ---- F6 rowGroupHtml (NEW; birth rule: 3 real consumers) --------------------------------------
  // Native row variant R8, which the spec's row list did not have: how native renders SEARCH RESULTS.
  // A lighter slate GROUP-HEADER bar spanning the pane -- item-type name + a count [2] + a REDUCED
  // action set (forbid + dump + a separated eye; NO magnifier, NO recenter) and NO icon box -- with
  // its member rows BELOW it, indented, each carrying the full 5-button cluster.
  // Consumers: Stocks cross-category search (PB-02 B4), container contents, co-located items. = 3.
  // cfg: {header: {label, count, actionsHtml, cls}, rows: [RAW html], cls, dataset}
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
  // items: [{action, glyph (defaults to TOKENS.glyphs[action]), dataset, active, disabled, title,
  // gapBefore}]. opts: {cls ('dwfui-actions'), btnCls}. One implementation for the stock item flag
  // row, stocks panel actions, and farm seed rows (same actions, same /stock-item-action route).
  // ---- F4 THE KEYSTONE. actionButtonsHtml had NO `art:` key -- which is the entire reason
  // --spa-ws-remove (the crossed-out house the owner asks for BY NAME on farm) and --spa-tile-quill
  // (rename, asked BY NAME x4) were UNREACHABLE FROM JS. The art was extracted, tokenized, declared
  // in :root, and paid for -- and no builder could render it. ONE optional cfg field turns every
  // icon-only control in the product from an emoji into native art we already own.
  //
  // Items gain (all optional, all additive):
  //   sprite: an interface_map TOKEN (TOKENS.sprites.*)  -- the preferred channel (1,502 tokens)
  //   art:    a TOKENS.art key (a --spa-* data-URI)      -- the fallback channel
  //   state:  'default'|'hover'|'disabled'|'selected'|'active'|'selectedActive'
  //           -> the six-state BUTTON_PICTURE_BOX* frame. Today `.dwfui-actions button:hover` and
  //              `.active` SHARE ONE LOOK, so a LATCHED button is indistinguishable from a HOVERED
  //              one. `state` + the split CSS below fixes that.
  //   placeholder: true -> an explicitly-unverified control. REQUIRES a `title` (spec §7 F4: the
  //              tooltip must say what evidence is missing; it may not invent behavior). Throws
  //              without one, on purpose -- a silent placeholder is how fabricated UI ships.
  //
  // opts.preset: 'itemActions' -> the INVARIANT four-button cluster [magnifier][padlock][trash] ·
  //   gap · [eye], in that order with that gap, verified identical in B55-3 (farm seed rows),
  //   B174-1 (workshop contents), B171-2 (kitchen contents) and multiple items on one tile.png
  //   (container contents). A named preset, not a per-screen list.
  const BTN_STATE_CLASS = {
    default: null, hover: "dwfui-btn--hover", disabled: "dwfui-btn--disabled",
    selected: "dwfui-btn--selected", active: "dwfui-btn--active",
    selectedActive: "dwfui-btn--sel-active",
  };
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
      // NATIVE ART FIRST. A sprite/art item renders the sprite and NO glyph text -- never a silent
      // fall-back to the emoji vocabulary (that fallback is precisely the bug).
      const sprite = item.active && item.activeSprite ? item.activeSprite : item.sprite;
      const selfFramed = isSelfFramedSprite(sprite);
      const cls = classes.length ? ` class="${classes.join(" ")}"` : "";
      const content = (sprite || item.art)
        ? iconHtml({ sprite, art: item.art, size: item.size, nativeCell: selfFramed, alt: item.title || item.action })
        : (item.glyph != null ? item.glyph : (TOKENS.glyphs[item.action] || ""));
      return `<button${cls}${selfFramed ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : ""}${datasetAttrs(item.dataset)}` +
        `${item.title ? ` title="${esc(item.title)}"` : ""}${item.disabled ? " disabled" : ""}>${content}</button>`;
    }).join("");
    return `<span class="${o.cls || "dwfui-actions"}"${o.ariaLabel ? ` aria-label="${esc(o.ariaLabel)}"` : ""}>${buttons}</span>`;
  }

  // ---- F8 checkHtml (NEW; birth rule: >=10 hand-rolled consumers) -------------------------------
  // ~10 hand-rolled binary checks are live today, each with its own classname and its own CSS (the
  // `${x ? "check" : ""}` idiom): sq-rowcheck, labor-check, labor-spec, chore-check (which has NO
  // CSS AT ALL), stone-check, unit-wd-check, zone-animal-toggle, td-good-mark, farm-radio, so-toggle,
  // the kitchen row toggles. DWFUI had NO binary-check component. `switchHtml` is a WEB-STYLE PILL,
  // not a DF control, and is not what any of them want.
  // ---- WAVE 4 / S1 GAP-B REFINE: THE CHECK IS A 2-STATE SPRITE TILE, NOT A BARE MARK ------------
  // checkHtml emitted `triMarkHtml("all")` when checked and NOTHING when unchecked -- a --spa-* mark
  // on a CSS button. NATIVE'S CHECKBOX IS A COMPLETE 32x36 SPRITE IN BOTH STATES: SQUADS_SELECTED
  // (green fill + bright-green check, grey frame) / SQUADS_NOT_SELECTED (dark fill, grey frame).
  // S1 blitted both out of interface_bits_shared.png (0,72 / 32,72) and matched them pixel-for-pixel
  // against steam labor work details.png. DF itself aliases that pair as EMBARK_{,NOT_}SELECTED,
  // UNIT_SELECTOR_{ASSIGNED,UNASSIGNED} and WORK_ORDERS_ADJECTIVE_{,NOT_}SELECTED -- it is THE
  // universal check tile. An UNCHECKED check therefore renders a REAL TILE; it does not render
  // nothing.
  //
  // REFINE, NOT A BREAKING CHANGE: the cfg keys, the <button>, the classes and aria-pressed are
  // unchanged, so every existing caller keeps working (and gains the native art).
  //
  // `sprite`/`activeSprite` override the pair for the checks whose art DF varies (stone use:
  // LABOR_STONE_USE_{RESTRICTED,ALLOWED}; work details: LABOR_WORKER_{UNASSIGNED,ASSIGNED}).
  // THE LINE AGAINST latchHtml: a CHECK's two states are the same control saying yes/no. A LATCH's
  // two states are DIFFERENT ICONS saying different things (the green open padlock vs the red closed
  // one). If you are choosing between two meanings, you want latchHtml.
  // cfg: {checked, sprite, activeSprite, size, cls, dataset, title, ariaLabel, disabled}
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

  // ---- W7a sortHeaderHtml (NEW; birth rule: 4 consumers) ---------------------------------------
  // The native COLUMN SORT HEADER. Consumers (S3, all four opened): Creatures/Residents, Kitchen,
  // Labor/Work details, Justice/Convicts -- native puts it on exactly the four screens that also
  // carry the W12 footer search, because they are the four sortable+searchable lists.
  //
  // THIS IS VANILLA DF, NOT A DFHACK OVERLAY. The six tokens have sat in TOKENS.sprites since Wave 2
  // WITH ZERO CONSUMERS, while four production files hand-rolled `<span class="info-sort-caret">
  // &#9660;</span>` -- an emoji where a sprite exists.
  //
  // NATIVE ANATOMY (CIM-labor-kitchen.jpg, residents specialty.png, CIM-justice-convicts.jpg,
  // CIM-labor-work details.jpg):
  //   * one small gold trapezoid button per column;
  //   * the ACTIVE key's tile is the _ACTIVE sprite and ITS LABEL SITS ON A LIGHTER PLAQUE;
  //   * inactive labels are dim;
  //   * A COLUMN WITH NO CAPTION STILL GETS A BARE BUTTON (the count column, the mass-toggle
  //     columns) -- it is omitted-caption, not an omitted control;
  //   * ascending / descending / text are THREE DIFFERENT SPRITES, not one sprite rotated.
  // It is a radiogroup over columns: exactly one active key. That is why it is not actionButtonsHtml
  // (which has no active-key semantics and no label plaque) and not tabsHtml (which switches views).
  // cfg: {columns: [{key, label, sort: 'asc'|'desc'|'text', title, dataset, disabled}],
  //       active (a column key, or null), cls, dataAttr ('dwfui-sort'), dataset, ariaLabel}
  const SORT_SPRITE = {
    asc: { on: TOKENS.sprites.sortAsc, off: TOKENS.sprites.sortAscOff },
    desc: { on: TOKENS.sprites.sortDesc, off: TOKENS.sprites.sortDescOff },
    text: { on: TOKENS.sprites.sortText, off: TOKENS.sprites.sortTextOff },
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
      if (!SORT_SPRITE[col.sort])
        throw new Error("DWFUI.sortHeaderHtml: column " + col.key + " needs sort: 'asc' | 'desc' | " +
          "'text' -- native carries the distinction in THREE DIFFERENT SPRITES, so it cannot be defaulted");
      const active = col.key === c.active;
      const token = active ? SORT_SPRITE[col.sort].on : SORT_SPRITE[col.sort].off;
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

  // ---- F8 latchHtml (NEW; birth rule: 5 consumers) ----------------------------------------------
  // A TWO-STATE ART LATCH on the BUTTON_PICTURE_BOX_HIGHLIGHTED frame. Consumers: the task PAUSE
  // control, the task REPEAT control, the residents-row specialization hammer, the unit-profile
  // specialization hammer, and the zone suspend toggle. = 5.
  //
  // The owner, info-shell/tasks, verbatim: "The pause button suspends the current task, IT TURNS GREEN WHEN
  // YOU CLICK IT." Green is NOT a colour to invent -- it is BUILDING_JOBS_SUSPENDED_ACTIVE, which
  // ships with the green baked into the sprite. Same for the specialization hammer (PB-03), where
  // the two states are two different sprites: WORKER_DO_ANY_AVAILABLE_JOB (green, open padlock) and
  // WORKER_ONLY_DO_ASSIGNED_JOBS (red, closed padlock). Our client has neither the control nor the
  // state -- The owner: "which is not in our browser version at all".
  // cfg: {on, sprite (off-state token), activeSprite (on-state token), size, cls, dataset, title,
  //       ariaLabel, disabled, hotkey (RENDERED ONLY IF PASSED -- NEVER FABRICATE A `Hotkey:` LINE)}
  function latchHtml(cfg) {
    const c = cfg || {};
    const classes = ["dwfui-latch"];
    if (c.cls) classes.push(c.cls);
    if (c.on) classes.push("on");
    const token = c.on ? (c.activeSprite || c.sprite) : c.sprite;
    const selfFramed = isSelfFramedSprite(token);
    const title = c.hotkey ? `${c.title || ""}\nHotkey: ${c.hotkey}` : c.title;
    return `<button type="button" class="${classes.join(" ")}"${selfFramed ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : ""}${datasetAttrs(c.dataset)}` +
      ` aria-pressed="${c.on ? "true" : "false"}"` +
      `${title ? ` title="${esc(title)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}${c.disabled ? " disabled" : ""}>` +
      `${iconHtml({ sprite: token, size: c.size, nativeCell: selfFramed, alt: c.ariaLabel || c.title })}</button>`;
  }

  // ---- F4 segmentedHtml (NEW; birth rule: 4 consumers) ------------------------------------------
  // The native HORIZONTAL_OPTION_* segmented control: work details `Everybody | Only selected |
  // Nobody`, kitchen cook/brew, stone use, standing-orders petitions. = 4.
  // NOT a duplicate of switchHtml (a binary web pill) nor of triState (a MARK, not a control).
  // The selected segment carries the GOLD CORNER BRACKETS (HORIZONTAL_OPTION_{LEFT,RIGHT}_ORNAMENT)
  // -- native's focus/selection affordance is BRACKETS, not a fill.
  // cfg: {options: [{key, label, title, disabled}], active, cls, dataAttr, dataset, ariaLabel}
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

  // ---- B252 selectCellHtml / selectCellGroupHtml (NEW) -----------------------------------------
  // Native's SELECTABLE SLAB CELL: a grid cell that IS the choice and that CONTAINS its own
  // controls. The squad schedule screen (native 7) is the reference and the reason it is born: one
  // column per fort military routine, and the thing the player clicks to put the squad on that
  // routine is the CELL -- the same cell that shows the routine's order summary and carries its own
  // Edit/Clear + Copy plaques.
  //
  // It is NOT plaqueBtnHtml: a <button> may not contain buttons, and this cell must.
  // It is NOT segmentedHtml: native's segmented affordance is the GOLD CORNER BRACKETS
  // (HORIZONTAL_OPTION_*_ORNAMENT); this control's affordance is a FILL.
  //
  // The two fills are MEASURED off native, not chosen. In both captures of screen 7 --
  //   "Menu Oracle Screenshots/Squad Menu UI/7. Squad Schedule Menu.PNG" (squad on Staggered
  //   training) and "tools/orchestrator/attachments/B252-1.png" (squad on Constant training) --
  // the SELECTED cell's modal background is rgb(78,71,78) = #4e474e (== --dwfui-slab, the
  // HORIZONTAL_OPTION plaque slab) and EVERY unselected cell is rgb(46,45,47) = #2e2d2f
  // (== --dwfui-cell-dark). The owner, reporting B252: "the lightest one is the one selected."
  //
  // Radio semantics: exactly one cell in a group is checked, the cell is focusable, and the
  // consumer activates it on click + Enter/Space. Controls nested inside a cell must stop their own
  // click from bubbling (they act ON the cell, they do not select it).
  // cfg: {selected, cls, dataset, title, ariaLabel}
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
  // The radiogroup wrapper. Consumers may not hand-write role="radiogroup" (drift guard R7), and
  // the group is where the layout lives -- pass the grid class through `cls`.
  // cfg: {cls, dataset, ariaLabel}
  function selectCellGroupHtml(cfg, innerHtml) {
    const c = cfg || {};
    return `<div class="dwfui-selectcells${c.cls ? " " + c.cls : ""}" role="radiogroup"` +
      `${datasetAttrs(c.dataset)}${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `${innerHtml || ""}</div>`;
  }

  // ---- Native tool tile -----------------------------------------------------------------------
  // One semantic button host for DFChrome-backed toolbar and placement icons. The canvas sprite
  // is injected later by the shared control shell; this builder owns the stable button grammar.
  // cfg: {cls,dataset,title,ariaLabel,active,disabled,type,label,labelHtml,id}.
  function toolButtonHtml(cfg) {
    const c = cfg || {};
    const classes = ["tool-button"];
    if (c.cls) classes.push(c.cls);
    if (c.active) classes.push("active");
    const type = /^(?:button|submit|reset)$/.test(c.type || "") ? c.type : "button";
    const label = c.labelHtml != null ? c.labelHtml : bitmapTextHtml(c.label || "", { cls: "dwfui-tool-label" });
    return `<button type="${type}"${c.id ? ` id="${esc(c.id)}"` : ""} class="${classes.join(" ")}"` +
      `${datasetAttrs(c.dataset)}${c.title ? ` title="${esc(c.title)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}${c.disabled ? " disabled" : ""}>${label}</button>`;
  }

  // ---- ChevronTabs: the parchment tab row --------------------------------------------------------
  // cfg: {cls ('dwfui-tabs'), tabCls ('dwfui-tab'), activeCls ('active'), dataAttr ('dwfui-tab'), ariaLabel,
  //       tabs: [{key, label, suffixHtml, disabled, title}], active}
  // suffixHtml is a RAW slot (the farm "(now)" marker); labels are escaped.
  // ---- F3 REFINEMENT: THERE ARE FOUR NATIVE TAB GRAMMARS. WE SHIPPED ONE. -----------------------
  // This is the single most-repeated complaint (unit-profile x3 explicit + x28 family, justice x2)
  // and, verbatim: "most of the work can be done on tab standarizing". `.dwfui-tabs` and `.dwfui-tab`
  // had ZERO CSS RULES, so the complaint had nowhere to live. The four .dwfui-tabs--* rule sets are
  // net-new CSS on an existing builder -- a REFINEMENT, not a new component (spec §7 F3: "One
  // tabsHtml call does not imply one visual grammar").
  //
  //   level 'primary'        TAB / TAB_SELECTED                    40x36 (5x3 cells)  plum -> gold
  //   level 'primary-short'  SHORT_TAB / SHORT_TAB_SELECTED        40x24 (5x2 cells)  plum -> gold
  //   level 'subtab'         SHORT_SUBTAB / _SELECTED              40x24              slate -> silver
  //   level 'subsubtab'      SHORT_SUBSUBTAB / _SELECTED           40x24              plum -> ORANGE
  //
  // Every tab is a TRAPEZOID sprite, 3-sliced horizontally. THE "CHEVRON" BETWEEN TABS IS NEGATIVE
  // SPACE BETWEEN TWO TRAPEZOIDS, NOT A DRAWN SHAPE. Long labels STRETCH the trapezoid -- there is
  // no truncation and no ellipsis on a tab anywhere in native.
  //
  // OVERFLOW IS **WRAP**, NOT SCROLL, AND WRAPPING DOES NOT CHANGE THE LEVEL. The unit profile's
  // eleven primary tabs are ONE logical set wrapped onto two rows of the SAME `TAB` grammar -- not a
  // hierarchy. (Proof: `Overview` in row B is selected in B128-1 while `Personality` in row A is
  // selected in attach-7, and never both.) So `wrap` renders ONE flat tablist that wraps in CSS:
  // ONE role=tablist, ONE aria-selected=true across both rows. Any tabsHtml that renders row 2 as a
  // different LEVEL is wrong.
  //
  // `width`: 'hug' | 'fill'. B55-3's four season tabs STRETCH TO FILL the panel; B174-1's three
  // workshop tabs HUG their labels -- same panel width, same grammar, different policy, and native
  // gives us no rule. This is an EXPLICIT WORKAROUND, not a discovered rule (`needs the owner evidence` Q3):
  // expose both, set `fill` on farm plot (the approved anchor) and `hug` elsewhere. It reproduces
  // both observations without guessing.
  //
  // ---- THE API TRAP THIS BUILDER USED TO BE (Wave 4 review) ---------------------------------
  // `cls`/`tabCls` used to REPLACE `dwfui-tabs`/`dwfui-tab`, and a missing `level` SILENTLY degraded to
  // browser text in a CSS box. Result, measured live: of ~12 call sites exactly ONE passed `level`,
  // so every other tab row in the app had NO native tab art and NO DF bitmap font -- while the
  // Foundation studio card, which used the DEFAULTS, looked perfect. The API let every real consumer
  // opt out of the grammar without saying so. Two hard rules now:
  //
  //   1. `cls`/`tabCls` are ADDITIVE. The row ALWAYS carries `dwfui-tabs`; every tab ALWAYS carries
  //      `dwfui-tab`. A consumer class is an EXTRA class, never a replacement. (Same rule `rowHtml`
  //      already follows.) `activeCls` likewise ADDS to `active`, it does not replace it, so the
  //      native selected paint cannot be lost by a consumer that pinned its own name.
  //   2. `level` is REQUIRED and tabsHtml THROWS without it. A missing grammar must be mechanically
  //      detectable, never a silent fallback -- the identity rule this file already applies to
  //      sprites (`data-df-identity-missing`) and to search (F7 defect 2).
  //
  // A surface that is genuinely NOT a native DF tab row (evidence, not convenience) must not be
  // dressed as one either: it calls `nonNativeTabsHtml` and states WHY, in writing, at the call
  // site. That keeps the opt-out loud, greppable, and gate-pinned (tools/harness/tab_grammar_test).
  const TAB_LEVELS = { primary: 1, "primary-short": 1, subtab: 1, subsubtab: 1 };
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
    if (c.cls) rowClasses.push(c.cls);
    if (c.wrap) rowClasses.push("dwfui-tabs--wrap");
    if (c.width === "fill" || c.width === "hug") rowClasses.push(`dwfui-tabs--${c.width}`);
    const buttons = (c.tabs || []).map(tab => {
      const active = tab.key === c.active;
      const classes = ["dwfui-tab", `dwfui-tab--${level}`];
      if (c.tabCls) classes.push(c.tabCls);
      if (active) classes.push("active");
      if (active && activeCls) classes.push(activeCls);
      const labelText = String(tab.label == null ? "" : tab.label);
      const label = bitmapTextHtml(labelText, { cls: "dwfui-tab-label" });
      // DF's tab art stretches by repeating its centre cell. The bitmap label is painted after
      // layout, so its canvas cannot be trusted to contribute an intrinsic width. Reserve the
      // exact 8px-per-cell label width plus both 16px caps before flex wrapping decides the row.
      // max-width/overflow in CSS remain the final airbag for a pathological label wider than its
      // whole panel: text may be clipped, but it may never paint through the right cap.
      const nativeWidth = 32 + (Array.from(labelText).length * 8);
      return `<button class="${classes.join(" ")}" role="tab" aria-selected="${active}"` +
        ` data-${attr}="${esc(tab.key)}"${tab.title ? ` title="${esc(tab.title)}"` : ""}` +
        ` style="--dwfui-tab-native-width:${nativeWidth}px"` +
        `${tab.disabled ? " disabled" : ""}>${label}${tab.suffixHtml || ""}</button>`;
    }).join("");
    return `<div class="${rowClasses.join(" ")}" role="tablist"${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${buttons}</div>`;
  }

  // ---- nonNativeTabsHtml: the DECLARED, JUSTIFIED opt-out ----------------------------------------
  // Same tablist semantics, ZERO `dwfui-*` classes and NO bitmap label -- because the surface is not
  // a native DF tab row and pretending otherwise would be a fabricated grammar. `reason` is REQUIRED
  // (it throws without one) so the opt-out can never be silent, and tab_grammar_test pins the exact
  // set of call sites: a NEW caller fails the gate until it is justified in a closeout.
  function nonNativeTabsHtml(cfg) {
    const c = cfg || {};
    if (!c.reason || typeof c.reason !== "string")
      throw new Error("DWFUI.nonNativeTabsHtml: `reason` is REQUIRED -- state the evidence that this " +
        "surface is not a native DF tab row. If it IS one, call tabsHtml({level}) instead.");
    const tabCls = c.tabCls || "dwfui-nntab";
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
    return `<div class="${c.cls || "dwfui-nntabs"}" role="tablist" data-non-native-tabs="${esc(c.reason)}"` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${buttons}</div>`;
  }

  // ---- NativeCycler -------------------------------------------------------------------------------
  // TYPE_FILTER_LEFT + TYPE_FILTER_TEXT + TYPE_FILTER_RIGHT are three slices of ONE control. The
  // group owns the composition; none of the slices gets a generic button chassis. This is the same
  // fixed-caps/tiled-middle rule as tabs and plaques, expressed once so consumers cannot place the
  // label outside the middle or create the recurring box-inside-box defect.
  //
  // ---- B250: THE MIDDLE SIZES TO ITS LABEL. ----
  // The plate used to be ONE fixed 24x12 TYPE_FILTER_TEXT icon with the label clamped to that
  // single cell -- right for the kitchen's `< All >`, and wrong everywhere the middle holds real
  // text: the squads assign-a-citizen cycler wrapped a dwarf's full name into four crushed lines
  // spilling over the arrows (B250-1.png). iconHtml is the wrong tool here BY DESIGN -- its box is
  // the sprite's own rectangle, so a plate built from it can never follow its content. The middle
  // now carries the token as a data hook and mountCyclerArt/CSS lay the SAME art across whatever
  // box the label needs: fixed 8px caps, tiled 8px centre -- exactly how tabs extend for a longer
  // label. The arrows stay fixed slices flush against the plate's edges.
  // cfg: {label, cls, ariaLabel, previous:{dataset,title}, next:{dataset,title}}
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

  // Native occupant rail: a compact icon-only tab strip attached to the OUTSIDE right edge of an
  // information frame. This is deliberately separate from the horizontal text-tab grammar above.
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

  // Editable copy cannot use the bitmap canvas: the browser must own selection, the caret, IME,
  // and text entry. The native field grammar still belongs in DWFUI so consumers do not invent
  // separate borders, padding, and fallback fonts for the same control.
  function textInputHtml(cfg) {
    const c = cfg || {};
    const classes = ["dwfui-text-input", c.cls || ""].filter(Boolean).join(" ");
    const value = c.value == null ? "" : ` value="${esc(c.value)}"`;
    const placeholder = c.placeholder == null ? "" : ` placeholder="${esc(c.placeholder)}"`;
    const maxLength = Number.isFinite(Number(c.maxLength))
      ? ` maxlength="${Math.max(0, Math.floor(Number(c.maxLength)))}"` : "";
    return `<input type="text" class="${classes}"${c.id ? ` id="${esc(c.id)}"` : ""}${value}${placeholder}${maxLength}` +
      `${datasetAttrs(c.dataset)}${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}` +
      `${c.autocomplete != null ? ` autocomplete="${esc(c.autocomplete)}"` : ""}` +
      `${c.spellcheck != null ? ` spellcheck="${c.spellcheck ? "true" : "false"}"` : ""}` +
      `${c.disabled ? " disabled" : ""}${c.readOnly ? " readonly" : ""}>`;
  }

  // ---- NativeSearch -------------------------------------------------------------------------------
  // cfg: {cls ('dwfui-search'), inputCls, buttonCls, dataAttr, id, value, placeholder, type ('text'),
  //       ariaLabel, magnifier} -- covers both live variants (plain field / field + magnifier).
  // ---- F7 REFINEMENT. Native has exactly TWO search PLACEMENTS, and both are ONE box.
  //   'footer'      P1 -- pinned bottom-left below the list, magnifier abutting its right edge.
  //                 Nothing else is in the footer. (residents screen.png, CIM-labor-kitchen.jpg)
  //   'pane-header' P2 -- spanning the full width of the LIST PANE IT FILTERS, at that pane's top.
  //                 (B151-3.png, native df searching stock.png, B174-2.png)
  // In all six evidence captures there is EXACTLY ONE search field.
  //
  // THREE DEFECTS FIXED HERE:
  // 1. THE MAGNIFIER WAS AN EMOJI (TOKENS.glyphs.view = &#128269; = the 🔍 character) -- and it was
  //    the SAME glyph as the stock-item "view" ACTION. One emoji doing double duty as chrome and as
  //    a row action, where native uses two DISTINCT sprites. It is now BUTTON_FILTER, which exists
  //    (C-7 is resolved AGAINST E6's "blocked-evidence" claim: the magnifier is UNADOPTED, not
  //    missing). Native's magnifier is a SEPARATE square button ABUTTING the field's right edge.
  // 2. searchHtml SILENTLY DEGRADED TO A BARE <input> when neither `magnifier` nor `cls` was passed
  //    -- which is exactly how a screen ends up with an unstyled browser text box. THE WRAPPER IS
  //    NOW UNCONDITIONAL.
  // 3. No caret-stability contract: the caret-restore logic is copy-pasted FOUR times across the
  //    info shell. `preserveKey` + DWFUI.restoreSearchCaret(root) replaces all four.
  //
  // NO CLEAR/RESET "✕" APPEARS IN ANY NATIVE CAPTURE. In native the query is cleared by deleting the
  // text; the magnifier is decorative-or-submit, never a clear button. `clear` therefore defaults to
  // FALSE and DO NOT INVENT AN ✕.
  // cfg: {cls, inputCls, buttonCls, dataAttr, id, value, placeholder, type, ariaLabel, magnifier,
  //       placement:'footer'|'pane-header', preserveKey, clear:false, emptyHtml}
  function searchHtml(cfg) {
    const c = cfg || {};
    const input = `<input class="${c.inputCls || "dwfui-search-input"}"${c.id ? ` id="${esc(c.id)}"` : ""}` +
      ` type="${c.type || "text"}"${c.dataAttr ? ` data-${c.dataAttr}` : ""}` +
      `${c.preserveKey ? ` data-dwfui-search-key="${esc(c.preserveKey)}"` : ""}` +
      ` value="${esc(c.value || "")}" placeholder="${esc(c.placeholder || "")}"` +
      ` autocomplete="off" spellcheck="false"${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>`;
    const classes = ["dwfui-search"];
    if (c.cls) classes.push(c.cls);
    if (c.placement === "footer" || c.placement === "pane-header")
      classes.push(`dwfui-search--${c.placement}`);
    // `magnifier` stays OPT-IN. Native shows it in both placements, but turning it on by default
    // would inject a new button into the two unmigrated surfaces that pass neither flag (the
    // stockpile editor's filter and the trade-depot goods field) and disturb their grids. Wave 2
    // builds the vocabulary; the family waves adopt it. Reported, not silently defaulted.
    const mag = c.magnifier
      ? `<button type="button" class="${c.buttonCls || "dwfui-search-btn"}" data-dwfui-native-art="true" data-dwfui-self-framed="true" tabindex="-1"` +
        ` aria-label="Search">${iconHtml({ spriteCrop: "filterButton", alt: "Search" })}</button>`
      : "";
    const empty = c.emptyHtml ? `<div class="dwfui-search-empty">${c.emptyHtml}</div>` : "";
    return `<div class="${classes.join(" ")}">${input}${mag}${empty}</div>`;
  }

  // ---- FillScroll ----------------------------------------------------------------------------------
  // The B167 fill contract as a component: the wrapper participates in a flex column and takes
  // flex:1 1 auto + min-height:0 + overflow-y:auto (web/css/dwf.css .dwfui-scroll). B167's
  // systemic CSS pass owns converting EXISTING panels; this wrapper is for new/migrated markup.
  //
  // ---- F5 REFINEMENT. The owner, stocks-panel/bars: "needs to be a proper parity scroll bar element built
  // out in cui that is used for every menu scroll bar. VERY IMPORTANT."
  //
  // *** `maxPx` IS REMOVED AND NOW THROWS. *** A pixel cap is precisely the regression F5 exists to
  // kill: it MANUFACTURES A SCROLLBAR WHERE NATIVE HAS NONE. The scrollbar is a property of
  // OVERFLOW, not of the region -- in B151-3 three columns of ONE window use the same component and
  // ONLY THE OVERFLOWING ONE SHOWS A BAR (a 17-row list: none; an 18-row list: none; a ~390-item
  // list: bar). A max-height cap cannot reproduce that: native's short column simply ENDS after 17
  // rows with black beneath it and no bar. It had ZERO production consumers, so this is free.
  // `.dwfui-scroll` must also NEVER set `overflow-y: scroll` -- that forces a permanent bar. Only
  // `auto`. Every ancestor between the panel host and the scroll node needs `min-height: 0`; that is
  // B167's landed contract (`.pf-fill-chain` / `.pf-fill-host`) -- CONSUME IT, do not re-derive it.
  //
  // D-B (recorded): `.dwfui-scroll` (component-owned, opt-in at build time) and B167's
  // `.pf-fill-scroll` (framework-owned, applied at runtime by reconcileFill) DID NOT COMPOSE --
  // `.pf-fill-scroll` sets `max-height: none !important`, which defeated `--dwfui-scroll-max`. The
  // alias the architecture spec promised "at merge" WAS NEVER MADE. It is made now, in CSS: the
  // scrollbar SKIN is lifted into a `.dwfui-scrollbar` mixin applied by BOTH, so there is ONE bar.
  //
  // `preserveKey` is markup-only (data-dwfui-scroll-key); DWFUI.restoreScroll(root) reads it. That
  // deletes the scroll-preservation math copy-pasted in the labor grid and the notifications panel.
  function scrollHtml(cfg, innerHtml) {
    const c = cfg || {};
    if (c.maxPx != null)
      throw new Error("DWFUI.scrollHtml: `maxPx` is removed (F5). A pixel cap manufactures a " +
        "scrollbar where native has none. Put the region under the B167 flex-fill chain instead.");
    const cls = `dwfui-scroll${c.cls ? " " + c.cls : ""}`;
    return `<div class="${cls}"${datasetAttrs(c.dataset)}` +
      `${c.preserveKey ? ` data-dwfui-scroll-key="${esc(c.preserveKey)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>${innerHtml || ""}</div>`;
  }

  // ---- PanelChrome header ---------------------------------------------------------------------------
  // cfg: {tag, cls, icon (RAW html), title | titleHtml (RAW slot, e.g. the workshop rename input),
  //       titleTag, titleCls, tools (RAW html), close: {cls ('bld-x'), data ('bld-close'), title, glyph} | false}
  // The default close carries a SKIN_CLOSE_SEL class (.bld-x -- dwf-panelframe.js:329), so
  // the framework's one-close reconciliation (B145) removes its generated X, and a cls listed in
  // the host's adoptHeadSel (B159) makes this header the drag handle. Both contracts hold by
  // construction; pass close:false only for panels whose close lives elsewhere.
  // ---- F2 REFINEMENT: `tools` BECOMES A TYPED CLUSTER, NOT A RAW HTML SLOT ----------------------
  // `--spa-ws-remove` and `--spa-tile-quill` are declared, native, present in TOKENS.art, and were
  // UNREACHABLE FROM JS -- because actionButtonsHtml had no `art:` key AND headerHtml.tools was a
  // raw string. So farm-plot was blocked on NEITHER EVIDENCE NOR ART: it was blocked on headerHtml
  // not being given a typed `tools:` array. The owner asks for both controls BY NAME on the farm anchors:
  //   "The top right buttons need the cancled out house icon (remove building) and the quill button
  //    (rename)."
  //
  // NATIVE ORDERING INVARIANT (B55-3 vs B174-1 vs B171-2): the cluster is right-aligned; the tiles
  // sit adjacent inside ONE gold border with hairline dividers; THE QUILL IS ALWAYS
  // SECOND-FROM-RIGHT AND THE CANCELLED HOUSE IS ALWAYS RIGHTMOST. Context tools (e.g. the links
  // opener) sit to the LEFT of the quill. That ordering is ENCODED HERE -- consumers do not get to
  // order the strip, because that is how it drifted in the first place.
  //
  // `variant`: 'building' | 'unit' | 'sidepanel' | 'sidewindow' | 'back' | 'none'. Note the FULL
  // INFORMATION WINDOW HAS NO HEADER AT ALL -- the primary tab row IS the top edge, with no title
  // and no close button (every CIM-* capture). Native's BACK affordance is `BUTTON_CLOSE_LEFT`,
  // a gold LEFT-ARROW (32x36) -- IT IS NOT AN X.
  //
  // `panel_frame_test` (237 cells) is mandatory on every commit touching this: the default close
  // class `bld-x` is a CLOSE_SEL member BY CONSTRUCTION (dwf-panelframe.js), and a header
  // variant emitting a close OUTSIDE CLOSE_SEL stacks a SECOND X and breaks head adoption. That has
  // already caused a real outage (the `.spe-close` mismatch). `tools` still accepts a raw string.
  //
  // ---- WAVE 4 / S1 GAP-A REFINE: `toolRows` -- THE UNIT SHEET'S CLUSTER IS TWO ROWS -------------
  // headerToolsHtml emitted ONE flat strip, and HEADER_TOOL_ORDER ranks only quill/removeBuilding --
  // which is the BUILDING header's invariant, not the unit sheet's. Native's unit-profile header
  // (B128-1 and all 24 `steam *` profile captures) is THREE self-framed tiles butted together
  // (reports - quill - camera) with a FOURTH (expel) RIGHT-ALIGNED ON A SECOND ROW BENEATH, and the
  // unit sheet has NO close button, NO title bar and NO footer.
  //
  //   headerHtml({ variant:'unit', close:false, toolRows: [[reports, quill, camera], [expel]] })
  //
  // `toolRows` PRESERVES AUTHOR ORDER inside each row -- the building header's "quill second from
  // right, remove rightmost" ranking is NOT the unit sheet's order and must not be applied to it.
  // `close:false` already existed (:close check below); it is what native's unit sheet needs.
  // ---- WAVE 4 / S4 GAP-B: `gapBefore` REACHES THE HEADER CLUSTER -------------------------------
  // Native's item-sheet tool row is `[lock][trash] * GAP * [eye]` (item sheet flags active.png):
  // the two destructive flags are butted, then a REAL gap, then the eye. `actionButtonsHtml` has
  // carried `gapBefore` since the itemActions preset -- but the HEADER path goes
  // headerHtml -> headerToolRowsHtml -> headerToolButtonHtml -> artBtnHtml, and artBtnHtml had no
  // such key, so the header's three flag tiles shipped butted with no gap before the eye. ONE
  // optional key on artBtnHtml + one CSS rule (.dwfui-head-tools .dwfui-gap) closes it for all three
  // consumers (item-sheet header, unit-sheet header, building header). The class is the SAME
  // `.dwfui-gap` the action cluster uses -- one gap vocabulary, not two.
  const HEADER_TOOL_ORDER = { quill: 90, removeBuilding: 100 };   // quill 2nd-from-right, remove last
  function headerToolButtonHtml(t) {
    return artBtnHtml({
      sprite: t.sprite || (t.role ? TOKENS.sprites[t.role] : undefined),
      art: t.art, size: t.size, state: t.state, active: t.active, disabled: t.disabled,
      placeholder: t.placeholder, cls: t.cls, dataset: t.dataset, title: t.title,
      gapBefore: t.gapBefore, ariaLabel: t.ariaLabel || t.title,
    });
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
    // Stable sort by the native invariant: unranked context tools keep their author order, to the
    // LEFT of the quill; the quill is second-from-right; remove-building is rightmost.
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
        close = `<button class="${x.cls || "bld-x"}"${x.dataset ? datasetAttrs(x.dataset) : ` data-${x.data || "bld-close"}`}` +
          ` title="${esc(x.title || "Close")}"${x.disabled ? " disabled" : ""}>${x.glyph}</button>`;
      } else {
        const dataName = String(x.data || "bld-close").replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        close = artBtnHtml({
          sprite: TOKENS.sprites.close, cls: x.cls || "bld-x",
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
    const classes = [c.cls || "dwfui-head"];
    if (c.variant) classes.push(`dwfui-head--${esc(c.variant)}`);
    const title = Array.isArray(c.titleLines)
      ? c.titleLines.map((line, i) => bitmapTextHtml(line == null ? "" : line,
          { cls: `dwfui-head-title-text dwfui-head-title-line dwfui-head-title-line-${i}` })).join("")
      : (c.titleHtml != null ? c.titleHtml : bitmapTextHtml(c.title || "", { cls: "dwfui-head-title-text" }));
    const toolCluster = c.toolRows
      ? headerToolRowsHtml(c.toolRows, { cls: c.toolsCls })
      : headerToolsHtml(c.tools, { cls: c.toolsCls });
    return `<${tag} class="${classes.join(" ")}">${back}${c.icon || ""}` +
      `<${titleTag} class="${c.titleCls || "dwfui-head-title"}">${title}</${titleTag}>` +
      `${toolCluster}${close}</${tag}>`;
  }

  // ---- F2/F9-a modalHtml (NEW; birth rule: >=5 consumers) ---------------------------------------
  // The SMALL LEFT-DOCKED NATIVE DIALOG. Consumers: squad create step 1, squad create step 2, squad
  // rename, unit-customize, the burrow/patrol helpers, the 12+ equipment choosers.
  //
  // NATIVE SIZING IS THREE FIXED SIZES, and we get it WRONG today: squads/create returns
  // {wide:true} -- it is ~3x TOO WIDE and must be this small dialog; squads/positions returns
  // {wide:true} and is NOT A WINDOW AT ALL but a sidebar back-header view. That is the "small
  // native dialogs represented as large generic panels", quantified. With SB = the squad sidebar's
  // outer width (389-392px) and VH = viewport height:
  //     sidebar                  1.00 SB, full height
  //     small left-docked dialog 1.45 SB x 0.72 VH, top-aligned, 3px gutter left of the sidebar
  //     wide full-height window  (viewport - SB - 3px), full height
  // IT IS A FIXED FRAME, NOT CONTENT-HUGGING: the native create step-2 dialog has 4 rows and ~55%
  // empty space and is still 730px tall. Do not shrink-wrap it.
  //
  // It has NO HEADER. A white PROMPT LINE sits top-left ("Create which squad?", "Select bodywear.").
  // It has NO CLOSE BUTTON -- dismissal is the sidebar's red Cancel, or making the choice. So it
  // emits no close and cannot confuse PanelFrame's one-close reconciliation.
  // cfg: {promptHtml | prompt, cls, dataset, ariaLabel, footerHtml}
  function modalHtml(cfg, bodyHtml) {
    const c = cfg || {};
    const prompt = c.promptHtml != null ? c.promptHtml : (c.prompt ? bitmapTextHtml(c.prompt,
      { cls: "dwfui-modal-prompt-text" }) : "");
    return `<div class="dwfui-modal${c.cls ? " " + c.cls : ""}"${datasetAttrs(c.dataset)}` +
      ` role="dialog"${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `${prompt ? `<div class="dwfui-modal-prompt">${prompt}</div>` : ""}` +
      `<div class="dwfui-modal-body">${bodyHtml || ""}</div>` +
      `${c.footerHtml != null ? `<div class="dwfui-modal-footer">${c.footerHtml}</div>` : ""}</div>`;
  }

  // ---- PlaqueButton ---------------------------------------------------------------------------------
  // The native text plaque: dark slab, thin light border, colored mono label -- "Add new task"
  // (green) / "Cancel" (grey) in the workshop oracles (B174-1/2), "Done" (red slab) in the links
  // side window (B171-2). cfg: {label, tone: 'green'|'grey'|'red'|undefined, cls, dataset, title,
  // disabled, *chassis, *artTone:'neutral'|'confirm'|'destructive'}. Text tone and native art are
  // separate axes: squads use neutral grey HORIZONTAL_OPTION art with a green label.
  //
  // ---- `chassis: 'slab'` -- THE GREY SLAB WITH A COLOURED LABEL. -------------------------------
  // A SECOND native plaque paint, evidenced on two unrelated screens with the same two colours:
  //   View stockpile    (item sheets/steam barrel-bin contents sheet.png)   bg #4e474e  text #14ff6d
  //   Create new squad  (Squad Menu UI/1. Squad Menu.PNG)                   bg #4e474e  text #14ff6b
  // i.e. the slab is `--dwfui-slab` and the label is `--dwfui-text-good` -- BOTH already declared, and
  // the text token has literally named "View stockpile" as its consumer since F1.2. Neither reached
  // the screen: the plaque's native art painted the GREEN-FILLED confirm strip over the whole button.
  // `chassis:'slab'` says paint the slab, colour the LABEL, draw no plaque art. THE GREEN FILL IS THE
  // EXCEPTION (B174-1 "Add new task" is an approved anchor and is NOT touched) -- this is the rule.
  //
  // It also has NO HOVER AND NO LIT CLICK STATE. The owner, checking native live: "It has no hover state in
  // native i just checked. It just clicks and opens the right menu. right now it has a weird click
  // state that lights up, thats not native." The CONTROL and its wiring are untouched (superset
  // policy) -- the css neutralises the invented :hover/:active paint, and wave4_info_stocks_test
  // resolves the real cascade in both states and asserts they are identical.
  // An unknown chassis is IGNORED (no class, no throw): a typo must not silently restyle a button.
  // labelHtml is the explicit raw slot for a composed/compatibility label. Normal plaque copy stays
  // bitmap-first; callers must pass rawHtml(reason, ...) so the drift guard keeps exceptions loud.
  function plaqueBtnHtml(cfg) {
    const c = cfg || {};
    const classes = ["dwfui-plaque"];
    const type = /^(?:button|submit|reset)$/.test(c.type || "") ? c.type : "button";
    if (c.chassis === "slab") classes.push("dwfui-plaque--slab");
    if (c.tone) classes.push(c.tone);
    if (/^(?:neutral|confirm|destructive)$/.test(c.artTone || ""))
      classes.push(`dwfui-plaque--art-${c.artTone}`);
    if (c.cls) classes.push(c.cls);
    // F4: native's FOCUSED-SLOT affordance is the GOLD CORNER BRACKETS
    // (HORIZONTAL_OPTION_{LEFT,RIGHT}_ORNAMENT) -- DISTINCT from selection, and NOT a fill.
    // D3's squad-name word-generator needs it: the active name slot carries brackets, and its
    // `Clear` plaque is RED when the slot is populated and GREY when it is empty.
    if (c.focus) classes.push("dwfui-focus-brackets");
    const focus = c.focus ? `<span class="dwfui-plaque-focus-ornaments" aria-hidden="true"></span>` : "";
    const label = c.labelHtml != null
      ? c.labelHtml
      : bitmapTextHtml(c.label || "", { cls: "dwfui-plaque-label" });
    return `<button type="${type}" class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}${c.disabled ? " disabled" : ""}>` +
      `${label}${focus}</button>`;
  }

  // ---- LightPlaque (B225) ---------------------------------------------------------------------
  // Native's left-rail ATTENTION PLAQUE: a colored 3x3-tile nine-slice rectangle with the label
  // over it -- graphics_interface.txt [TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS:29:12:3:3:
  // DIPLOMACY_LIGHT] (blue, oracle B225-1) / [...:42:12:3:3:PETITIONS_LIGHT] (brown -- The owner:
  // "brown petitions box above announcements and below alert box") / [...:26:12:3:3:SIEGE_LIGHT]
  // (red, unconsumed here). paintSprites' [data-dwfui-lightplaque] pass composes the rectangle
  // the way TILE_GRAPHICS_RECTANGLE semantics compose it: fixed corners, TILED (not stretched)
  // edges and center, at the interface scale. Width follows the label (8px/char bitmap cells,
  // one pad tile + one corner tile each side), height is the art's native 3 rows.
  //
  // NO HOVER AND NO LIT CLICK STATE, by evidence: The owner on the petitions plaque (B188): "petitions
  // has no hover state... It just clicks and opens the right menu." The diplomacy plaque's
  // hover behavior is UNVERIFIED (screenshot-request in the DIPLO-PETITIONS closeout) -- until
  // evidence lands, both render the plain plaque in every state.
  // cfg: {token (interface_map TOKEN, required), label, cls, dataset, title, ariaLabel}.
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

  // The [data-dwfui-lightplaque] paint: nine-slice-TILE the 3x3 record across
  // (chars + 4) x 3 tiles. Corners stay 1:1; edge/center tiles REPEAT (pixel art is tiled by
  // native TILE_GRAPHICS_RECTANGLE composition, never stretched), with the last repeat clipped.
  // Same scale contract as _paintSpriteScaled boxPx==0: CSS size = native px * interface scale,
  // backing store additionally * uiZoom.
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
    });
  }

  // ---- ArtButton ------------------------------------------------------------------------------------
  // A native-art tile button: the --spa-* asset (by TOKENS.art KEY) becomes the background, the
  // button chrome comes from css (.dwfui-art-btn). One implementation for the workshop header tools
  // (link/rename/remove -- B174-1) and the links side-window give/take mode buttons (B171-2);
  // future consumer: the spn-tool tiles. cfg: {art, cls, dataset, title, ariaLabel, active,
  // disabled}. An unknown art key renders a plain tile (no style attr) rather than throwing.
  // F4 REFINEMENT: + `sprite` (an interface_map TOKEN -- the 1,502-token channel, WITH its
  // hover/active/disabled variants), + `size`, + `state` (the six-state BUTTON_PICTURE_BOX* frame),
  // + `placeholder`. A `sprite` wins over an `art` key; an `art` key still works, so B174's workshop
  // header tools are untouched. Unknown art still renders a plain tile and never throws.
  //
  // `placeholder: true` + a REQUIRED `title` is the owner's own ask on labor-work-details: "use placeholder
  // buttons that show a hoverstate of asking what it does if you don't know but get it exact." The
  // tooltip must say WHAT EVIDENCE IS MISSING; it may not invent behavior (spec §7 F4), and it must
  // NEVER FABRICATE A `Hotkey:` LINE. Throwing without a title is deliberate.
  function artBtnHtml(cfg) {
    const c = cfg || {};
    if (c.placeholder && !c.title)
      throw new Error("DWFUI.artBtnHtml: placeholder:true requires a title saying what is unverified");
    const art = TOKENS.art[c.art];
    const classes = ["dwfui-art-btn"];
    if (c.cls) classes.push(c.cls);
    if (c.active) classes.push("active");
    // S4 GAP-B: the same `.dwfui-gap` vocabulary the action cluster uses. A tool DECLARES the gap
    // that precedes it; the strip does not hard-code a position.
    if (c.gapBefore) classes.push("dwfui-gap");
    const stateCls = BTN_STATE_CLASS[c.state];
    if (stateCls) classes.push(stateCls);
    if (c.placeholder) classes.push("dwfui-btn--placeholder");
    const selfFramed = isSelfFramedSprite(c.sprite);
    // B230: + `spriteCrop` (a TOKENS.spriteCrops KEY), for the case where the glyph a button needs
    // is one cell of a record that interface_map.json exposes as a single token -- DF's 23 burrow
    // symbols all collapse onto CUSTOM_SYMBOL, so a token alone cannot address symbol #7. Same
    // precedence rule as `sprite` over `art`: a crop wins over a plain sprite. iconHtml already owns
    // both the crop lookup and the unknown-crop path (which marks data-df-identity-missing and
    // renders the native empty tile), so an unknown crop key still fails VISIBLY rather than
    // silently -- this only forwards the channel that was already there.
    const inner = c.spriteCrop
      ? iconHtml({ spriteCrop: c.spriteCrop, size: c.size, alt: c.ariaLabel || c.title })
      : (c.sprite
        ? iconHtml({ sprite: c.sprite, size: c.size, nativeCell: selfFramed, alt: c.ariaLabel || c.title })
        : "");
    // B230: + `swatch` -- a flat CSS colour as the button's face. This is the one native control
    // whose identity IS a colour and therefore has no sprite to reproduce: DF's burrow colour picker
    // is a grid of plain chips off its 16-colour curses palette. Without this channel the only way
    // to build one is a raw <button>, which is exactly what R7 (ui_drift_guard) forbids and rightly
    // so. The colour is DATA (the server reads it out of DF's live gps->uccolor), not styling, so it
    // is the caller's to supply; everything else about the chip -- chrome, states, a11y -- stays
    // here. `aria-pressed` rather than a class alone, because a chip is a latch, not a link.
    const swatch = c.swatch ? String(c.swatch) : "";
    const styleAttr = swatch
      ? ` style="background:${esc(swatch)}"`
      : (!c.sprite && !c.spriteCrop && art ? ` style="background-image:${art}"` : "");
    return `<button class="${classes.join(" ")}"${selfFramed ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : ""}${styleAttr}` +
      `${datasetAttrs(c.dataset)}${c.title ? ` title="${esc(c.title)}"` : ""}` +
      `${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}` +
      `${swatch ? ` aria-pressed="${c.active ? "true" : "false"}"` : ""}` +
      `${c.disabled ? " disabled" : ""}>${inner}</button>`;
  }

  // ---- SideWindow -----------------------------------------------------------------------------------
  // The secondary gold-framed window docked beside a panel (B171-2/3: the workshop links flow).
  // Markup only -- positioning is the consumer's job (the workshop panel mounts it body-level
  // because #selection clips overflow). cfg: {cls, dataset, ariaLabel, tools (RAW html),
  // done: {label ('Done'), cls, dataset ({dwfuiSidewinDone:""}), title} | false}, bodyHtml RAW.
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

  // ---- StatTile (WT13) -------------------------------------------------------------------------
  // A dashboard stat tile: a big value over a small caption, with an optional sub-line and a tone
  // class hook (gold/green/red -> palette in css). cfg: {label, value, valueHtml (RAW slot), sub,
  // tone, cls, dataset, title}. Born for the WT13 fortress-activity overview ("things built",
  // "busiest overseer", "master builder"); future: any KPI readout. No fetch/state -- value is
  // whatever the caller computed. Value + label + sub are escaped (a player name is user-ish).
  function statTileHtml(cfg) {
    const c = cfg || {};
    const classes = ["dwfui-stat-tile"];
    if (c.tone) classes.push(c.tone);
    if (c.cls) classes.push(c.cls);
    const value = c.valueHtml != null ? c.valueHtml : bitmapTextHtml(c.value == null ? "" : c.value);
    const sub = c.sub ? `<div class="dwfui-stat-sub">${bitmapTextHtml(c.sub)}</div>` : "";
    return `<div class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}>` +
      `<div class="dwfui-stat-value">${value}</div>` +
      `<div class="dwfui-stat-label">${bitmapTextHtml(c.label == null ? "" : c.label)}</div>${sub}</div>`;
  }

  // ---- BarRow (WT13) ---------------------------------------------------------------------------
  // A labeled proportional bar row: name + a fill bar (width = value/max, ALWAYS clamped to 0..100
  // so bad data can never overflow the track) + a numeric readout + an optional sub-line. cfg:
  // {label, value, max, pct (override 0..100), valueText (readout override), sub, tone, cls,
  // dataset, title}. Born for the WT13 per-player leaderboard; future: any count-vs-total compare.
  // The only inline style is the fill WIDTH (a number, never a color -- colors are the tone class).
  function barRowHtml(cfg) {
    const c = cfg || {};
    const max = Number(c.max) > 0 ? Number(c.max) : 0;
    const value = Number(c.value) || 0;
    let pct = (c.pct != null) ? Number(c.pct) : (max > 0 ? (value / max) * 100 : 0);
    if (!(pct >= 0)) pct = 0;
    if (pct > 100) pct = 100;
    const classes = ["dwfui-bar-row"];
    if (c.cls) classes.push(c.cls);
    const fillTone = c.tone ? ` ${c.tone}` : "";
    const readout = bitmapTextHtml((c.valueText != null) ? c.valueText : String(value));
    const sub = c.sub ? `<span class="dwfui-bar-sub">${bitmapTextHtml(c.sub)}</span>` : "";
    return `<div class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}>` +
      `<span class="dwfui-bar-label">${bitmapTextHtml(c.label == null ? "" : c.label)}</span>` +
      `<span class="dwfui-bar-value">${readout}</span>` +
      `<span class="dwfui-bar-track"><span class="dwfui-bar-fill${fillTone}" style="width:${pct.toFixed(1)}%"></span></span>` +
      `${sub}</div>`;
  }

  // ---- WindowShell --------------------------------------------------------------------------
  // The shared full information-window frame. It deliberately accepts raw slots so existing
  // production builders can migrate without losing their pinned row classes or event hooks.
  // cfg: {cls, primaryTabs, detailTabs, sectionTabs, bodyCls, sideHtml, mainHtml, footerHtml,
  // ariaLabel}. Search belongs in footerHtml exactly once; this prevents nested renderers from
  // silently growing a second search field (the Kitchen defect caught in the review export).
  // F2 REFINEMENT: + `variant` ('window'|'sidepanel'|'modal'|'secondary') and + `promptHtml` -- the
  // white instruction line native puts at the top-left of a chooser, in place of a header. With the
  // prompt slot, F9-b (wide chooser) and F9-e (nested chooser list) are just
  // windowHtml + scrollHtml + rowHtml -- so there is NO `chooserWindowHtml`, and spec §13's ban on
  // a universal mega-component holds.
  //
  // Search remains owned by `footerHtml` EXACTLY ONCE, so a nested renderer cannot silently grow a
  // second search field. That is the mechanism PB-09 (Kitchen's two search boxes) needs; the Kitchen
  // fix itself is SCREEN-OWNED (dwf-kitchen.js) and belongs to the labor family wave.
  function windowHtml(cfg) {
    const c = cfg || {};
    const tag = c.tag || "div";
    const variant = /^(?:window|sidepanel|modal|secondary)$/.test(c.variant || "") ? c.variant : null;
    const prompt = c.promptHtml != null ? c.promptHtml : (c.prompt ? bitmapTextHtml(c.prompt,
      { cls: "dwfui-window-prompt-text" }) : "");
    const body = c.bodyHtml != null ? c.bodyHtml
      : `<div class="${c.bodyCls || "info-body"}">${c.sideHtml || ""}<div class="${c.mainCls || "info-main"}">${c.mainHtml || ""}</div></div>`;
    return `<${tag}${c.id ? ` id="${esc(c.id)}"` : ""} class="dwfui-window info-window` +
      `${variant ? " dwfui-window--" + variant : ""}${c.cls ? " " + c.cls : ""}"` +
      `${c.role ? ` role="${esc(c.role)}"` : ""}${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `${prompt ? `<div class="dwfui-window-prompt">${prompt}</div>` : ""}${c.primaryTabs || ""}` +
      `${c.detailTabs || ""}${c.sectionTabs || ""}${body}` +
      `${c.footerHtml != null ? `<div class="${c.footerCls || "info-footer"}">${c.footerHtml}</div>` : ""}</${tag}>`;
  }

  // ---- Stepper ------------------------------------------------------------------------------
  // One native numeric control for storage limits, hospital supplies, and work-order amounts.
  // cfg: {label,value,valueText,min,max,cls,inputCls,inputId,dataset,stepKey,minusDataset,plusDataset,
  // editable,ariaLabel}. Consumers retain wire-specific datasets while sharing anatomy.
  // ---- F8/PB-10 REFINEMENT: NATIVE ORDER IS `value [#][+][-]`, AND THE VALUE CELL IS BORDERLESS.
  // We shipped `minus / value / plus` -- WRONG ORDER and WRONG ART. Native renders the value as
  // PLAIN RIGHT-ALIGNED WHITE TEXT, BORDERLESS, *BEFORE* the tiles, then three gold SPRITE tiles
  // (WORK_ORDERS_ENTER_AMOUNT '#', _INCREASE_AMOUNT '+', _DECREASE_AMOUNT '-') on a single black
  // group plate -- identical in B143-1.png (an approved anchor) and CIM-work orders.jpg.
  //
  // This is the root cause of PB-10's "strange box with a golden border next to the done" and the
  // "random golden box inbetween max bins and max wheelbarrows" that the owner sees: the VALUE CELL WAS
  // BEING GIVEN A BORDER. Fix the primitive and the screen stops emitting them.
  //
  // `hash` is opt-in (the '#' enter-amount tile has no meaning on a read-only stepper such as the
  // hospital supply row). `art:true` swaps the +/-/# glyphs for the native sprites.
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
    const face = (sprite, glyph) => art
      ? iconHtml({ sprite, size: c.tileSize || 24, nativeCell: true, alt: glyph === TOKENS.glyphs.plus ? "Increase" : "Decrease" })
      : glyph;
    // WAVE-5, additive: `title` is the stepper's own tooltip, carried on the editable value cell.
    // Two reasons it exists, and both are defects the migration surfaced:
    //   (1) The value cell had NO title channel, so every consumer that hand-built a stepper and put
    //       a real hint on its <input> ("Dye color (0-15, -1 none)", "Optional position slot (0-9).
    //       Slot 0 is the squad leader...") LOST that hint the moment it adopted the builder.
    //   (2) The +/-/# titles this builder generates are TEMPLATE literals (`Increase ${label}`), and
    //       the ? help reference harvests tooltips by scanning source for QUOTED LITERALS. So a
    //       builder-generated tooltip is invisible to "all the tooltips in the game" -- meaning the
    //       corpus silently erodes as the UI migrates. A literal `title:` in the consumer restores it.
    // Absent => byte-identical markup to before.
    const titleAttr = c.title ? ` title="${esc(c.title)}"` : "";
    const displayValue = c.valueText != null ? String(c.valueText) : String(value);
    const input = c.editable === false
      ? `<span class="dwfui-stepper-value" aria-live="polite"${titleAttr}>${bitmapTextHtml(displayValue)}</span>`
      : `<input class="${c.inputCls || "dwfui-stepper-input"}"${c.inputId ? ` id="${esc(c.inputId)}"` : ""} type="number" min="${min}" max="${max}" value="${value}"${titleAttr}${datasetAttrs(c.dataset)}>`;
    const hash = c.hash
      ? `<button type="button" class="dwfui-stepper-btn hash"${art ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : ""}${datasetAttrs(hashData)} title="Enter ${esc(c.label || "value")}">` +
        `${art ? iconHtml({ sprite: TOKENS.sprites.stepHash, size: c.tileSize || 24, nativeCell: true, alt: "Enter amount" }) : "#"}</button>`
      : "";
    const artAttr = art ? ` data-dwfui-native-art="true" data-dwfui-self-framed="true"` : "";
    return `<label class="dwfui-stepper${art ? " dwfui-stepper--native-art" : ""}${c.cls ? " " + c.cls : ""}"${c.ariaLabel ? ` aria-label="${esc(c.ariaLabel)}"` : ""}>` +
      `${c.label != null ? `<span class="dwfui-stepper-label">${bitmapTextHtml(c.label)}</span>` : ""}` +
      `${input}${hash}` +
      `<button type="button" class="dwfui-stepper-btn plus"${artAttr}${datasetAttrs(plusData)} title="Increase ${esc(c.label || "value")}">${face(TOKENS.sprites.stepPlus, TOKENS.glyphs.plus)}</button>` +
      `<button type="button" class="dwfui-stepper-btn minus"${artAttr}${datasetAttrs(minusData)} title="Decrease ${esc(c.label || "value")}">${face(TOKENS.sprites.stepMinus, TOKENS.glyphs.minus)}</button>` +
      `</label>`;
  }

  // ---- Switch -------------------------------------------------------------------------------
  // Shared accessible pill switch for settings, host policy, standing orders, and future binary
  // preferences. cfg: {label,checked,disabled,cls,dataset,rootDataset,name,title,sub,trackCls,
  // copyCls,labelCls,subCls,labelTag,subTag,knob}. The visible pill is CSS;
  // the semantic control remains a real checkbox.
  function switchHtml(cfg) {
    const c = cfg || {};
    const labelTag = /^(?:span|b|strong)$/.test(c.labelTag || "") ? c.labelTag : "span";
    const subTag = /^(?:span|small)$/.test(c.subTag || "") ? c.subTag : "span";
    const knob = c.knob === false ? "" : `<span class="${c.knobCls || "dwfui-switch-knob"}"></span>`;
    return `<label class="dwfui-switch${c.cls ? " " + c.cls : ""}"${datasetAttrs(c.rootDataset)}${c.title ? ` title="${esc(c.title)}"` : ""}>` +
      `<input type="checkbox" role="switch"${c.name ? ` name="${esc(c.name)}"` : ""}${datasetAttrs(c.dataset)}` +
      `${c.checked ? " checked" : ""}${c.disabled ? " disabled" : ""}>` +
      `<span class="${c.trackCls || "dwfui-switch-track"}" aria-hidden="true">${knob}</span>` +
      `<span class="${c.copyCls || "dwfui-switch-copy"}"><${labelTag} class="${c.labelCls || "dwfui-switch-label"}">${bitmapTextHtml(c.label || "")}</${labelTag}>` +
      `${c.sub ? `<${subTag} class="${c.subCls || "dwfui-switch-sub"}">${bitmapTextHtml(c.sub)}</${subTag}>` : ""}</span></label>`;
  }

  // ---- Status -------------------------------------------------------------------------------
  // Shared safe copy for transient HUD notices, save/busy banners, validation messages, and
  // compact state badges. cfg: {tag,cls,tone,text,textHtml,icon,role,live,title,dataset}.
  function statusHtml(cfg) {
    const c = cfg || {};
    const tag = /^(?:div|span|p|output)$/.test(c.tag || "") ? c.tag : "div";
    const classes = ["dwfui-status"];
    if (c.tone) classes.push(c.tone);
    if (c.cls) classes.push(c.cls);
    const copy = c.textHtml != null ? c.textHtml : bitmapTextHtml(c.text || "", { cls: "dwfui-status-text" });
    return `<${tag} class="${classes.join(" ")}"${datasetAttrs(c.dataset)}` +
      `${c.role ? ` role="${esc(c.role)}"` : ""}${c.live ? ` aria-live="${esc(c.live)}"` : ""}` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}>${c.icon || ""}<span class="dwfui-status-copy">${copy}</span></${tag}>`;
  }

  // Runtime contract: production modules call this once at load. Missing DWFUI capabilities then
  // fail loudly and locally instead of letting a page render a subtly different fallback UI.
  // ---- Grid: THE COMPOSITION RULE, MADE INTO A COMPONENT. -------------------------------------
  //
  //   *** A COMPONENT DOES NOT DRAW A FRAME IT DOES NOT OWN. CHROME BELONGS TO THE OUTERMOST OWNER. ***
  //
  // The owner, on the unit profile: "what the multiple borders tells me is that we are just vastly
  // overcomplicating things ... the components we embed seem to have their own border each so each
  // time we drop a component in its adding that". That is not a unit-sheet bug -- it is a COMPOSITION
  // DEFECT in this layer, and it reproduces on every screen that nests a bordered thing in a bordered
  // thing. The unit profile stacked THREE frames (window 3px + `.unit-sheet` 2px inset + the cell's
  // own 2px box); the item sheet stacked the same three (window + `.stock-item-sheet` + body).
  //
  // Native proves the simpler model, and the matrix recorded it (S4 S1, `unit-profile/overview`):
  // "the body is a table of cells with gold 1px dividers, 2 columns x 4 bands ... It is NOT cards and
  // NOT a flex list. The left cell of band 3 is EMPTY and the divider still draws -- the grid is
  // fixed, not content-driven." That last clause is the whole argument: a divider that draws beside
  // an EMPTY cell cannot be owned by a cell. IT IS OWNED BY THE GRID.
  //
  // So: the CELL is borderless. The GRID paints the shared 1px dividers -- as its own background,
  // showing through `gap` (see `.dwfui-grid` in css). One line between two cells, never two abutting
  // borders; a line beside an empty cell, because a gap is a property of the TRACKS, not the content.
  // The WINDOW draws the single ornate border. Nothing in between draws anything.
  //
  // Anatomy is markup-only; the TEMPLATE (columns/rows) stays with the consumer -- native's profile
  // grid and its Relations list are different shapes of the same chassis.
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
    if (missing.length) throw new Error(`DWFUI ${VERSION}: ${surface || "unknown surface"} requires ${missing.join(", ")}`);
    if (root) {
      root.__DWFUI_USAGE__ = root.__DWFUI_USAGE__ || {};
      root.__DWFUI_USAGE__[surface || "unknown"] = { version: VERSION, components: [...(names || [])] };
    }
    return true;
  }

  // ---- Native text color resolver (text-color spec §3.2) --------------------------------------
  // dfColor(index) is the ONE place a curses color index (0..15) becomes a CSS color. It returns a
  // `var(--df-cN, <default>)` reference so that:
  //   * when applyPalette() has published the live gps->uccolor palette onto :root, that wins
  //     (honors a player-edited data/init/colors.txt), and
  //   * offline / pre-handshake, the DEFAULT df16 hex is used -- never an invented color.
  // No local color table may be hand-copied elsewhere (drift rule R1); everything routes here.
  function dfColor(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i > 15) return TOKENS.palette.df16[7]; // light gray fallback
    return `var(--df-c${i}, ${TOKENS.palette.df16[i]})`;
  }

  // Publish DF's live 16-color curses palette (gps->uccolor, shipped as [[r,g,b] x16] on the
  // /version handshake) as --df-c0..--df-c15 custom properties on :root. Idempotent; a short or
  // empty palette (headless plugin, old DLL) leaves the defaults in place. No-op without a DOM.
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
    return n > 0;
  }

  // NOTE: no comments inside the object literal below. The drift guard's cross-sync cell parses the
  // exports by splitting this literal on commas and taking the first identifier of each chunk -- a
  // comment line makes it read the comment's first word as an export name and lose the real one.
  const api = {
    VERSION,
    TOKENS,
    esc, sentenceCase, bitmapTextHtml, rawHtml,
    triState: { stateFor: triStateFor, fromAgg: triStateFromAgg, markHtml: triMarkHtml },
    rowHtml, actionButtonsHtml, toolButtonHtml, tabsHtml, nonNativeTabsHtml, cyclerHtml, occupantRailHtml, textInputHtml, searchHtml, scrollHtml, headerHtml,
    plaqueBtnHtml, lightPlaqueHtml, artBtnHtml, sideWindowHtml, statTileHtml, barRowHtml,
    windowHtml, stepperHtml, switchHtml, statusHtml, require: requireComponents,
    iconHtml, rowGroupHtml, checkHtml, latchHtml, segmentedHtml, modalHtml, sortHeaderHtml,
    gridHtml, gridCellHtml, selectCellHtml, selectCellGroupHtml, workDetailSprite,
    paintSprites, paintItemSprites, paintBitmapText, mountScrollbarArt, mountTabArt, mountPlaqueArt, mountCyclerArt, restoreScroll, restoreSearchCaret, mountDom,
    SOFTEN, interfaceScale, uiZoom, setInterfaceScale,
    dfColor, applyPalette,
  };
  root.DWFUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
