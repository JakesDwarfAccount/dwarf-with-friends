// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// Census Wave 3 acceptance -- ITEMSHEET-PARITY + B164 chooser double-ask + glyph unification.
// Oracle-derived cells (Menu Oracle Screenshots/item sheets/*.png):
//   * element enumeration of the rebuilt stock item sheet (DWFUI header/rows/actions)
//   * co-located side-tab plumbing with a multi-item tile fixture
//   * ONE action-glyph vocabulary shared by the stocks panel and the item sheet (TOKENS.glyphs)
//   * B164: a lone stockpile is a single candidate -- no "as stockpile / as building" double-ask
// No browser or Dwarf Fortress process is required. Loads unitcycle.js in a VM (like
// tilelist_fixture_test) for the chooser cells, and asserts the sheet/stocks MARKUP against source
// (repo convention: b55_farmplot_client_test / ui_components_test drive the pure builders + regex).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const DWFUI = require(path.join(root, "web/js/dwf-ui-components.js"));

const infoSrc = fs.readFileSync(path.join(root, "web/js/dwf-build-info-panels.js"), "utf8");
const uiSource = fs.readFileSync(path.join(root, "web/js/dwf-ui-components.js"), "utf8");
const cycleSrc = fs.readFileSync(path.join(root, "web/js/dwf-unitcycle.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/dwf.css"), "utf8");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + "\n" + (err.stack || err)); }
}
const rx = glyph => glyph.replace(/[&#;]/g, m => "\\" + m); // escape an HTML entity for a RegExp

// ---- unitcycle.js in a VM (self-contained DFTileList API) -----------------------------------
function loadTileList(sourceOverride) {
  const selection = (() => {
    const el = { tag: "selection", children: [], className: "", listeners: {} };
    let text = "";
    Object.defineProperty(el, "textContent", { get: () => text, set: v => { text = String(v); if (text === "") el.children = []; } });
    el.classList = { contains: n => el.className.split(/\s+/).includes(n) };
    el.appendChild = c => { el.children.push(c); return c; };
    el.addEventListener = (n, fn) => { el.listeners[n] = fn; };
    return el;
  })();
  const documentStub = {
    readyState: "complete", head: { appendChild() {} }, documentElement: { appendChild() {} },
    createElement() {
      const e = { children: [], className: "", style: {}, listeners: {}, disabled: false };
      let t = ""; Object.defineProperty(e, "textContent", { get: () => t, set: v => { t = String(v); } });
      e.appendChild = c => { e.children.push(c); return c; };
      e.addEventListener = (n, fn) => { e.listeners[n] = fn; };
      return e;
    },
    getElementById: id => (id === "selection" ? selection : null),
    addEventListener() {},
  };
  const sandbox = { window: null, document: documentStub, location: { search: "" },
    DWFUI,
    localStorage: { getItem: () => "" }, URLSearchParams, Date, Number, String, Array, Object,
    isFinite, console, setTimeout: () => 0, clearTimeout: () => {},
    MutationObserver: function () { this.observe = () => {}; } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sourceOverride || cycleSrc, sandbox, { filename: "dwf-unitcycle.js" });
  return { api: sandbox.DFTileList, sandbox, selection };
}

// =============================================================================================
// 1. GLYPH VOCABULARY -- one canonical set, shared by both surfaces (census #40 / B169 2c.4)
// =============================================================================================
check("TOKENS.glyphs are the oracle vocabulary: magnifier/camera/lock/trash/eye", () => {
  const g = DWFUI.TOKENS.glyphs;
  assert.equal(g.view, "&#128269;", "view = magnifier");
  assert.equal(g.follow, "&#127909;", "follow = movie camera");
  assert.equal(g.forbid, "&#128274;", "forbid = padlock");
  assert.equal(g.dump, "&#128465;", "dump = wastebasket");
  assert.equal(g.hide, "&#128065;", "hide = eye");
});

// WAVE 4 / S4: the stocks cluster moved OFF the emoji vocabulary onto the native sprites. The
// ORDER and every data-stock-action hook are unchanged; only the paint is.
check("stocks panel routes its 5 actions through DWFUI.actionButtonsHtml + NATIVE SPRITES", () => {
  // The cluster builder exists and carries all five data-stock-action hooks (wiring preserved).
  assert.match(infoSrc, /function stocksActionCluster\(item\)/, "stocksActionCluster builder present");
  for (const action of ["zoom", "view", "forbid", "dump", "hide"])
    assert.match(infoSrc, new RegExp(`stockAction: "${action}"`), `stocks keeps data-stock-action=${action}`);
  // The two divergent one-offs are gone: a literal "X" zoom and the black-circle hide.
  assert.doesNotMatch(infoSrc, /data-stock-action="zoom" title="Zoom to item">X</, "literal-X zoom retired");
  assert.doesNotMatch(infoSrc, /data-stock-action="hide"[^>]*>&#9679;/, "black-circle hide retired");
  // W4: the leading tile was the movie-camera EMOJI. Native's leading stocks tile is STOCKS_RECENTER.
  assert.doesNotMatch(infoSrc, /action: "zoom", glyph: g\.follow/, "the camera-emoji zoom is retired");
  assert.match(infoSrc, /action: "zoom", sprite: S\.recenterStocks/, "stocks zoom == STOCKS_RECENTER sprite");
  assert.match(infoSrc, /activeSprite: S\.forbidOn/, "latched forbid takes its _ACTIVE sprite variant");
});

check("functional: the stocks cluster renders NATIVE SPRITE tiles, hide set apart, no emoji", () => {
  const S = DWFUI.TOKENS.sprites;
  const g = DWFUI.TOKENS.glyphs;
  const html = DWFUI.actionButtonsHtml([
    { action: "zoom", sprite: S.recenterStocks, dataset: { stockAction: "zoom" }, title: "Zoom to item" },
    { action: "view", sprite: S.view, dataset: { stockAction: "view" }, title: "View item" },
    { action: "forbid", sprite: S.forbid, activeSprite: S.forbidOn, active: true, dataset: { stockAction: "forbid" }, title: "Forbid / unforbid" },
    { action: "dump", sprite: S.dump, activeSprite: S.dumpOn, dataset: { stockAction: "dump" }, title: "Mark / cancel dump" },
    { action: "hide", sprite: S.hide, activeSprite: S.hideOn, gapBefore: true, dataset: { stockAction: "hide" }, title: "Hide / show" },
  ], { cls: "stocks-item-actions", btnCls: "stocks-item-action", ariaLabel: "Item actions" });
  assert.match(html, /data-stock-action="zoom"[\s\S]*?data-dwfui-sprite="STOCKS_RECENTER"/);
  assert.match(html, /data-stock-action="view"[\s\S]*?data-dwfui-sprite="STOCKS_VIEW_ITEM"/);
  assert.match(html, /data-stock-action="hide"[\s\S]*?data-dwfui-sprite="STOCKS_HIDE"/);   // eye tile
  // ACTIVE IS THE SPRITE VARIANT, not a colour we invent: a latched forbid renders _ACTIVE.
  assert.match(html, /data-stock-action="forbid"[\s\S]*?data-dwfui-sprite="STOCKS_FORBID_ACTIVE"/);
  assert.match(html, /class="stocks-item-action dwfui-gap"[\s\S]*?data-stock-action="hide"/); // eye set apart
  // A self-framed native cell gets NO generic box and NO CSS "active" fill -- css:6336-6343.
  assert.match(html, /data-stock-action="forbid"[^>]*/); // (the button carries the self-framed marker)
  assert.match(html, /data-dwfui-native-art="true" data-dwfui-self-framed="true"/);
  assert.match(css, /button\[data-dwfui-native-art="true"\]\[data-dwfui-self-framed="true"\][\s\S]{0,200}?border:0/);
  // NOT ONE emoji survives in the cluster.
  for (const glyph of [g.view, g.follow, g.forbid, g.dump, g.hide])
    assert.doesNotMatch(html, new RegExp(rx(glyph)), `emoji ${glyph} must not survive a sprite cluster`);
  assert.doesNotMatch(html, />X</); assert.doesNotMatch(html, new RegExp(rx("&#9679;")));
});

// =============================================================================================
// 2. ITEM SHEET -- oracle element enumeration (rebuilt on DWFUI)
// =============================================================================================
check("sheet header: ITEM-SPRITE tile + title + ONE variable meta line via DWFUI.headerHtml", () => {
  assert.match(infoSrc, /ui\.headerHtml\(\{[\s\S]*?cls: "stock-item-header",\s*\n\s*icon: ui\.iconHtml\(\{ item: result\?\.spriteRef/);
  assert.match(infoSrc, /<div class="stock-item-title">\$\{escapeHtml\(title\)\}<\/div>\$\{itemMetaLine\(result\)\}/);
  // The meta row is a VARIABLE FIELD LIST on ONE gold line, WEIGHT FIRST -- `item sheet flags
  // active.png` shows Weight with NO Value at all, so the pair may never be hard-coded.
  assert.match(infoSrc, /function itemMetaLine\(result\)[\s\S]*?fields\.push\(`Weight: [\s\S]*?fields\.push\(`Value: ~/);
  assert.doesNotMatch(infoSrc, /stock-item-value/, "the separate second Value line is retired");
});

check("sheet header actions: NATIVE SPRITES via headerHtml({toolRows}), camera on line 2", () => {
  // The SPRITE is the state (`_ACTIVE` variant), never a CSS tint. Every toggle hook is preserved.
  assert.match(infoSrc, /sprite: result\?\.forbidden \? S\.forbidOn : S\.forbid, active: !!result\?\.forbidden,\s*\n\s*dataset: \{ itemToggle: "forbid" \}/);
  assert.match(infoSrc, /sprite: result\?\.dump \? S\.dumpOn : S\.dump[\s\S]{0,60}?dataset: \{ itemToggle: "dump" \}/);
  assert.match(infoSrc, /sprite: result\?\.hidden \? S\.hideOn : S\.hide[\s\S]{0,60}?dataset: \{ itemToggle: "hide" \}/);
  // Delta 4: the camera is NOT inline with forbid/dump/hide -- it is its OWN right-aligned second row.
  assert.match(infoSrc, /const toolRows = ui \? \[\s*\n\s*\[[\s\S]*?itemToggle: "hide"[\s\S]*?\],\s*\n\s*\[\s*\n\s*\{ sprite: result\?\.following \? S\.cameraOn : S\.cameraOff/);
  assert.match(infoSrc, /dataset: \{ itemFollow: "" \}/);
  assert.match(infoSrc, /^\s*toolRows,$/m, "the cluster is built by the FACTORY, not hand-rolled");
  assert.doesNotMatch(infoSrc, /action: "follow", gapBefore: true/, "the inline camera-before-hide is retired");
  // R2: string-writing DWFUI's own structural markup is drift -- the guard rejects it.
  assert.doesNotMatch(infoSrc, /class="dwfui-head[w-]*"/, "never hand-write DWFUI structural markup (R2)");
});

check("functional: the header cluster renders sprites, and ACTIVE is the _ACTIVE SPRITE VARIANT", () => {
  const S = DWFUI.TOKENS.sprites;
  const g = DWFUI.TOKENS.glyphs;
  const html = DWFUI.actionButtonsHtml([
    { action: "forbid", sprite: S.forbid, activeSprite: S.forbidOn, active: true, dataset: { itemToggle: "forbid" }, title: "Unforbid item" },
    { action: "dump", sprite: S.dump, activeSprite: S.dumpOn, active: false, dataset: { itemToggle: "dump" }, title: "Mark for dumping" },
    { action: "hide", sprite: S.hide, activeSprite: S.hideOn, active: true, gapBefore: true, dataset: { itemToggle: "hide" }, title: "Show item" },
  ], { cls: "dwfui-actions dwfui-head-tools-row" });
  assert.match(html, /data-item-toggle="forbid"[\s\S]*?data-dwfui-sprite="STOCKS_FORBID_ACTIVE"/);
  assert.match(html, /data-item-toggle="dump"[\s\S]*?data-dwfui-sprite="STOCKS_DUMP"/);   // resting
  assert.match(html, /data-item-toggle="hide"[\s\S]*?data-dwfui-sprite="STOCKS_HIDE_ACTIVE"/);
  for (const glyph of [g.forbid, g.dump, g.hide])
    assert.doesNotMatch(html, new RegExp(rx(glyph)), "no emoji may survive where a sprite exists");
  // The green camera in `item sheet flags active.png` IS UNIT_SHEET_CAMERA_ACTIVE -- not CSS.
  const cam = DWFUI.actionButtonsHtml([{ action: "follow", sprite: S.cameraOff, activeSprite: S.cameraOn, active: true, dataset: { itemFollow: "" } }], {});
  assert.match(cam, /data-dwfui-sprite="UNIT_SHEET_CAMERA_ACTIVE"/);
});

check("sheet body: prose description + gated location row (View stockpile plaque), NO detail lines", () => {
  assert.match(infoSrc, /class="stock-item-description">\$\{escapeHtml\(description\)\}/);
  assert.match(infoSrc, /cls: "stock-item-loc-row",/);
  // W4 ROUND 2: the location tile has TWO art channels, and the WIRE picks which one applies
  // (src/interaction.cpp:1276-1288): `locationSpriteToken` (a STOCKPILE_ICON_* INTERFACE token) for a
  // stockpile, `locationSpriteRef` (an ITEM ref) for a container. They never both apply. This used to
  // pin the single-channel form `iconCfg: { item: result?.locationSpriteRef }`, which could never
  // resolve a stockpile sign -- a stockpile's sign is interface art, not item art -- and that is why
  // the tile read MISSING SPRITE. Both channels are pinned now; wave4_info_stocks_test R3 renders it.
  assert.match(infoSrc, /iconCfg: locToken\s*\n\s*\? Object\.assign\(\{ sprite: locToken \}, locIcon\)/);
  assert.match(infoSrc, /: Object\.assign\(\{ item: result\?\.locationSpriteRef \}, locIcon\)/);
  assert.match(infoSrc, /ui\.plaqueBtnHtml\(\{ label: "View stockpile", tone: "green"/);
  // B236 (ITEMSHEET-oracle-native.png + item sheet flags active.png): the labelled detail rows
  // (Type/Location/Position/Forbidden/Dump/Hidden -- the "field dump") exist on NO native sheet and
  // are DELETED, machinery and all. The former W4-R2 rulings they encoded are superseded by the
  // paired B236 oracle: the flags live in the _ACTIVE toggle sprites, the position in the camera
  // tool, the location in the (now gated) location row, and Material in the title + prose sentence.
  // b236_itemsheet_native_test carries the full deletion ledger and the rendered-output gates.
  assert.doesNotMatch(infoSrc, /class="stock-item-line"/);
  assert.doesNotMatch(infoSrc, /REDUNDANT_DETAIL|MOVED_TO_META/);
  assert.doesNotMatch(infoSrc, /fields\.push\(`Material:/);
  // ...and the prose bridge composes native's sentence from today's wire (description === title).
  assert.match(infoSrc, /function nativeItemProse\(result, title\)/);
});

check("contents rows: item sprite + name + preset:'itemActions' on the TABLE chassis", () => {
  assert.match(infoSrc, /const contentRow = c => ui\.rowHtml\(\{/);
  assert.match(infoSrc, /chassis: "table"/, "native contents rows are the hatched table chassis");
  assert.match(infoSrc, /iconCfg: \{ item: c\.spriteRef, cls: "stock-item-content-icon"/);
  for (const action of ["view", "forbid", "dump", "hide"])
    assert.match(infoSrc, new RegExp(`stockContentAction: "${action}"`), `contents row keeps ${action}`);
  // ITEM_ACTION_PRESET is byte-for-byte the native order+gap; it is never re-listed by hand.
  assert.match(infoSrc, /preset: "itemActions", cls: "dwfui-actions", ariaLabel: "Contained item actions"/);
});

// ============================================================================================
// W4 GAP-1 -- THE HAND-ROLLED FIFTH ART CHANNEL IS GONE. This cell REJECTS the old path.
// ============================================================================================
const infoCode = infoSrc.replace(/\/\/[^\n]*/g, "");    // strip comments: the history is documented there
check("W4 GAP-1: itemArtTile() and its SILENT LETTER FALLBACK are DELETED from the panel", () => {
  assert.doesNotMatch(infoCode, /itemArtTile/, "the fifth art channel must not exist in code");
  assert.doesNotMatch(infoCode, /resolveItemSpriteRef/, "the panel must not re-implement the resolver");
  assert.doesNotMatch(infoCode, /sprites\/img\//, "the panel must not hand-blit an item sheet");
  assert.doesNotMatch(infoCode, /stock-item-sprite/, "the hand-rolled sprite class is retired");
  // EVERY item icon on both surfaces now goes through the ONE channel.
  //
  // WAVE-5: the stocks ROW's icon used to be a bare `ui.iconHtml({ item: item.spriteRef ...})` sitting
  // inside hand-written row markup. The row is now DWFUI.rowHtml({chassis:'table'}), so its icon is
  // declared as `iconCfg` and rowHtml calls iconHtml itself -- the SAME single channel, one builder
  // further in. That is exactly the shape the contents row (right above) already used, so this pin
  // adopts the identical pattern. THE GUARANTEE IS UNCHANGED and it is not asserted on source alone:
  // the rendered-output cell below proves the item channel actually reaches the DOM.
  for (const call of [/icon: ui\.iconHtml\(\{ item: result\?\.spriteRef/, /iconCfg: \{ item: c\.spriteRef/,
    /Object\.assign\(\{ item: result\?\.locationSpriteRef \}, locIcon\)/, /iconCfg: \{ item: item\.spriteRef/])
    assert.match(infoCode, call, `an item icon bypasses DWFUI: ${call}`);
  // ...and the location row's OTHER channel (a stockpile's INTERFACE sign) rides DWFUI too.
  assert.match(infoCode, /Object\.assign\(\{ sprite: locToken \}, locIcon\)/);
});

check("W4 GAP-1 functional: a MISSING item ref fails LOUD -- an empty tile, NEVER a letter", () => {
  const missing = DWFUI.iconHtml({ item: undefined, cls: "stock-item-loc-icon", size: 30 });
  assert.match(missing, /data-df-identity-missing="item:none"/, "a blocker, and a VISIBLE one");
  assert.match(missing, /dwfui-icon--empty/, "native paints an EMPTY TILE for missing art");
  assert.doesNotMatch(missing, /dwfui-icon--letter/);
  assert.doesNotMatch(missing, />[A-Za-z]</, 'the location row must never print the letter "F" again');
  // and the letter path cannot be quietly reinstated as a fallback
  assert.throws(() => DWFUI.iconHtml({ item: { itemType: "BAR" }, letter: "B" }), /mutually exclusive/);
});

check("W4 GAP-1 functional: a RESOLVABLE item ref paints the real sheet crop (a sprite, not a letter)", () => {
  const node = (() => {
    const attrs = { "data-dwfui-item": JSON.stringify({ itemType: "BAR" }), "data-dwfui-item-key": "BAR" };
    const classes = new Set(["dwfui-icon", "dwfui-icon--item"]);
    return { style: {}, attrs, classes,
      getAttribute: n => (n in attrs ? attrs[n] : null),
      setAttribute: (n, v) => { attrs[n] = v; }, removeAttribute: n => { delete attrs[n]; },
      classList: { add: c => classes.add(c), remove: c => classes.delete(c) } };
  })();
  const prior = globalThis.DwfTiles;
  globalThis.DwfTiles = { resolveItemSpriteRef: r => (r.itemType === "BAR" ? { sheet: "item_construction.png", col: 1, row: 4 } : null) };
  try {
    assert.equal(DWFUI.paintItemSprites({ querySelectorAll: () => [node] }), 1);
    assert.equal(node.style.backgroundImage, "", "the old full-sheet background path is retired");
    assert.equal(node.style.backgroundPosition, "", "scaled item art must not expose adjacent cells");
    assert.match(uiSource, /canvas\.dwfui-item-sprite[\s\S]{0,1800}?_bakeBlit\(ctx, img/,
      "the browser path isolates the resolved cell in a private canvas");
    assert.equal(node.attrs["data-df-identity-missing"], undefined, "a resolved item carries NO blocker");
  } finally { if (prior === undefined) delete globalThis.DwfTiles; else globalThis.DwfTiles = prior; }
});

check("W4 seeded-bad: the OLD hand-rolled tile is distinguishable from the channel", () => {
  const old = (name, cls, cell) => (cell ? `<div class="${cls} stock-item-sprite"></div>`
    : `<div class="${cls}">${String(name || "?").slice(0, 1).toUpperCase()}</div>`);
  const degraded = old("Food Stockpile #6", "stock-item-loc-icon", null);
  assert.match(degraded, />F</, "the shipped fallback really was a letter");
  assert.doesNotMatch(degraded, /data-df-identity-missing/, "and it was SILENT -- that was the bug");
  assert.notEqual(degraded, DWFUI.iconHtml({ item: undefined, cls: "stock-item-loc-icon" }));
});

check("DEAD MARKUP deleted: no 'Contains N' heading, no '(empty)' row, no duplicate unit triangle", () => {
  assert.doesNotMatch(infoCode, /Contains \$\{contents\.length\}/, "native has NO contents heading");
  assert.doesNotMatch(infoCode, /stock-item-empty/, "native shows an empty container as an EMPTY AREA");
  assert.doesNotMatch(infoCode, /unit-icon-button/, "the duplicate ► unit triangle is deleted");
  // ...but the item -> holder/owner CAPABILITY survives it (superset policy: delete AT MOST ONE).
  assert.match(infoCode, /stockItemUnit: unit\.id/, "item -> holder navigation must survive");
  assert.match(infoCode, /holder \? "With" : "Owned by"/, "who holds/owns the item must still be shown");
  assert.match(infoCode, /querySelectorAll\("\[data-stock-item-unit\]"\)/, "and stay wired to openUnitById");
});

check("native item sheet owns no close; PanelFrame declares this variant ESC-only", () => {
  // panelframe.js:405 CLOSE_SEL matches `.unit-close-button`; :450 makes head adoption CONDITIONAL on
  // the skin owning a close. Removing this X un-hides the generated "Selection" title bar WITH a
  // fresh framework X -- non-native chrome ADDED by a diff that reads as parity compliance.
  const panelframe = fs.readFileSync(path.join(root, "web/js/dwf-panelframe.js"), "utf8");
  assert.match(panelframe, /CLOSE_SEL = [\s\S]*?\.unit-close-button/);
  // WAVE 4 FOUNDATION: this used to pin the gate's LITERAL SOURCE LINE
  // (`if (!head || (spec.closable && !skinCloseFor(spec, el))) return null;`) -- which pinned the
  // BUG S4 filed as GAP-A and forbade the fix S4 asked for. The CONTRACT is unchanged and is what
  // is asserted now: adoption is gated on the skin owning a close ONLY WHERE THE VARIANT IS
  // CLOSABLE. The sheet still ships its one X below, so it still adopts either way; the rendered
  // outcome this cell guards (one close, no un-hidden bar) is identical.
  assert.match(panelframe, /if \(!head \|\| \(closableFor\(spec, el\) && !skinCloseFor\(spec, el\)\)\) return null;/);
  // Scope the count to the SHEET's own builder -- the info shell lives in the same file.
  const sheet = /function stockItemSheetMarkup\(result, opts\) \{[\s\S]*?\n  \}\n/.exec(infoCode);
  assert.ok(sheet, "stockItemSheetMarkup found");
  const closes = sheet[0].match(/unit-close-button|data-pf-close|aria-label="Close"|\bbld-x\b|\binfo-close\b|build-close|dfchat-close|dfchat-x|hk-x|cl-close/g) || [];
  assert.equal(closes.length, 0, `the sheet must declare no inner close, found ${closes.length}`);
  assert.match(sheet[0], /close: false/);
  assert.doesNotMatch(sheet[0], /close: \{ cls: "unit-close-button", data: "stock-item-close"/);
  // And the skin header PanelFrame adopts is still declared, so the generated bar stays hidden.
  assert.match(sheet[0], /cls: "stock-item-header"/);
  const core = fs.readFileSync(path.join(root, "web/js/dwf-core.js"), "utf8");
  assert.match(core, /adoptHeadSel: "\.unit-sheet-header,\.stock-item-header/);
  assert.match(core, /ESC_ONLY_SELECTION_VARIANTS = \[[^\]]*"stock-item-panel"[^\]]*\]/);
});

// =============================================================================================
// 3. DATA GAPS -- fail-open, never guessed (no invented value; button gated on host id)
// =============================================================================================
check("'Value:' subtitle renders ONLY from a server-supplied value (B184 fail-open)", () => {
  // B184 server half now emits `value`; the sheet renders it gated on Number.isFinite and
  // must never invent one when the field is absent.
  const code = infoSrc.replace(/\/\/[^\n]*/g, "");
  assert.match(code, /Number\.isFinite\(Number\(result\?\.value\)\)[\s\S]{0,200}?Value: ~\$\{escapeHtml\(result\.value\)\}/,
    "value line must be gated on the server-supplied field");
  const gated = code.match(/Value: ~/g) || [];
  assert.equal(gated.length, 1, "exactly one value renderer, no hardcoded/fabricated copies");
});

check("View stockpile button gated on a host-supplied locationId (fail-open otherwise)", () => {
  assert.match(infoSrc, /const locId = Number\(result\?\.locationId \?\? -1\);/);
  assert.match(infoSrc, /Number\.isFinite\(locId\) && locId >= 0[\s\S]*?ui\.plaqueBtnHtml/);
});

// =============================================================================================
// 4. CO-LOCATED SIDE-TABS -- multi-item tile fixture (plumbing is functional; chrome pending oracle)
// =============================================================================================
// WAVE 4 (matrix §3 F9): the co-located strip is NOT a native tab row -- native's control is an ICON
// STRIP (`multiple items on one tile.png`), so the strip must emit "ZERO dwfui-tab markup". It is
// therefore a DECLARED, justified opt-out (nonNativeTabsHtml + a written reason), not a silent one:
// dressing it in the trapezoid TAB grammar would be a fabricated grammar. The CAPABILITY is
// unchanged -- same data attribute, same click wiring.
check("openItemPanel forwards siblings into DWFUI's native icon rail (no text-tab grammar)", () => {
  assert.match(infoSrc, /async function openItemPanel\(id, siblings\)/);
  assert.match(infoSrc, /showStockItemSheet\(await r\.json\(\), \{ siblings:/);
  assert.match(infoSrc, /railSiblings\.length > 1[\s\S]*?ui\.occupantRailHtml\(\{/);
  assert.doesNotMatch(infoSrc, /railSiblings\.length > 1[\s\S]{0,800}?ui\.(?:nonNativeTabsHtml|tabsHtml)\(\{/);   // seeded-bad
  assert.match(infoSrc, /dataAttr: "stock-item-sibling"/);
  assert.match(infoSrc, /data-stock-item-sibling/); // the click wiring
});

check("chooser hands the item-sibling list to the sheet (multi-item tile -> side-tabs)", () => {
  const { api, sandbox, selection } = loadTileList();
  let opened = null;
  sandbox.openItemPanel = (id, siblings) => { opened = { id, siblings }; };
  // Two loose items (real ids) co-located on one tile, delivered by the /tile-occupants route.
  const candidates = api.routeCandidates({ occupants: [
    { kind: "item", id: 71, name: "copper battle axe", spriteRef: { itemType: "WEAPON", itemSubtype: -1, materialType: 0, materialIndex: -1 } },
    { kind: "item", id: 72, name: "dwarf corpse", spriteRef: { itemType: "CORPSE", itemSubtype: -1, materialType: -1, materialIndex: -1 } },
  ] });
  assert.equal(candidates.length, 2);
  api.renderChooser(candidates);
  // The rendered chooser rows carry the chooseCandidate click handler; click the first item.
  const rows = selection.children[0].children.filter(c => c.listeners && c.listeners.click);
  assert.equal(rows.length, 2, "two item rows rendered");
  rows[0].listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.ok(opened, "opening an item on a crowded tile calls openItemPanel");
  assert.equal(opened.id, 71);
  assert.equal(Array.isArray(opened.siblings) ? opened.siblings.length : 0, 2,
    "both co-located items handed over as siblings");
  assert.equal(opened.siblings[0].spriteRef.itemType, "WEAPON",
    "the native sibling rail receives the server's item identity, not just text");
});

check("a lone item among mixed occupants passes NO siblings (no side-tabs)", () => {
  const { api, sandbox, selection } = loadTileList();
  let opened = null;
  sandbox.openItemPanel = (id, siblings) => { opened = { id, siblings }; };
  // A unit + a single item share the tile: the item has no item-siblings, so no tab strip.
  const candidates = api.routeCandidates({ occupants: [
    { kind: "unit", id: 9, name: "Urist" },
    { kind: "item", id: 71, name: "sock" },
  ] });
  api.renderChooser(candidates);
  const rows = selection.children[0].children.filter(c => c.listeners && c.listeners.click);
  const itemRow = rows.find(r => /sock/.test(JSON.stringify(r.children.map(c => c.textContent))));
  itemRow.listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(opened.id, 71);
  assert.equal(opened.siblings, null, "a single co-located item yields null siblings (no tabs)");
});

// =============================================================================================
// 5. B164 -- lone stockpile is ONE candidate: no "as stockpile / as building" double-ask
// =============================================================================================
const stockpileLatest = {
  origin: { x: 0, y: 0, z: 100 }, width: 20, height: 20,
  units: [],
  buildings: [{ id: 55, type: "Stockpile", x1: 5, y1: 5, x2: 8, y2: 8, z: 100 }],
  tiles: Array.from({ length: 400 }, () => null),
};
const stockpileClick = { kind: "stockpile", title: "Stockpile #3", buildingId: 55, itemId: -1,
  tile: { x: 6, y: 6, z: 100 } };

check("B164: clicking a lone stockpile yields exactly one 'stockpile' candidate", () => {
  const { api } = loadTileList();
  const rows = api.buildCandidates(stockpileClick, stockpileLatest);
  assert.equal(rows.length, 1, "no phantom second row");
  assert.equal(rows[0].kind, "stockpile");
  assert.equal(rows[0].id, 55);
  assert.ok(!rows.some(r => r.kind === "building"), "the 'stockpile as building' row is gone");
});

check("B164: lone stockpile bypasses the chooser entirely (one-click opens)", () => {
  const { api, sandbox } = loadTileList();
  sandbox.DwfTiles = { getLatest: () => stockpileLatest };
  assert.equal(api.consumeInspect(stockpileClick, { x: 6, y: 6, w: 20, h: 20 }), false,
    "a single candidate must not render the chooser");
});

check("B164 sibling fix: a lone civzone classifies as 'zone', never 'building'", () => {
  const { api } = loadTileList();
  const latest = { origin: { x: 0, y: 0, z: 100 }, width: 20, height: 20, units: [],
    buildings: [{ id: 77, type: "Civzone", x1: 5, y1: 5, x2: 8, y2: 8, z: 100 }],
    tiles: Array.from({ length: 400 }, () => null) };
  const rows = api.buildCandidates({ kind: "zone", title: "Meeting Area", buildingId: 77, itemId: -1,
    tile: { x: 6, y: 6, z: 100 } }, latest);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "zone");
  assert.ok(!rows.some(r => r.kind === "building"));
});

check("B164 preserves genuine multi-occupant: unit + stockpile still a 2-row chooser", () => {
  const { api } = loadTileList();
  const latest = { origin: { x: 0, y: 0, z: 100 }, width: 20, height: 20,
    units: [{ id: 9, name: "Urist", x: 6, y: 6, z: 100 }],
    buildings: [{ id: 55, type: "Stockpile", x1: 5, y1: 5, x2: 8, y2: 8, z: 100 }],
    tiles: Array.from({ length: 400 }, () => null) };
  const rows = api.buildCandidates(stockpileClick, latest);
  const kinds = rows.map(r => r.kind);
  assert.equal(rows.length, 2, "unit + stockpile = two rows");
  assert.ok(kinds.includes("unit"), "the unit standing on the stockpile is still offered");
  assert.ok(kinds.includes("stockpile"), "the stockpile is still offered");
  assert.ok(!kinds.includes("building"), "no phantom building row");
});

check("workshops/furnaces still classify correctly (mapping change is stockpile/zone-only)", () => {
  const { api } = loadTileList();
  const latest = { origin: { x: 0, y: 0, z: 100 }, width: 20, height: 20, units: [],
    buildings: [{ id: 41, type: "Workshop", x1: 6, y1: 6, x2: 6, y2: 6, z: 100 }],
    tiles: Array.from({ length: 400 }, () => null) };
  const rows = api.buildCandidates({ kind: "workshop", title: "Mason", buildingId: 41, itemId: -1,
    tile: { x: 6, y: 6, z: 100 } }, latest);
  assert.equal(rows[0].kind, "workshop");
});

// =============================================================================================
// 6. SEEDED-BAD (test-the-test): the fixes are the reason these fixtures pass
// =============================================================================================
check("seeded-bad: the OLD type->kind mapping would reintroduce the double-ask", () => {
  // Re-run buildCandidates against a mutated source where Stockpile falls to the else 'building'.
  const mutated = cycleSrc.replace(
    /: type === 'Stockpile' \? 'stockpile'\s*\n\s*: type === 'Civzone' \? 'zone' : 'building';/,
    ": 'building';");
  assert.notEqual(mutated, cycleSrc, "mutation must actually change the source");
  const { api } = loadTileList(mutated);
  const rows = api.buildCandidates(stockpileClick, stockpileLatest);
  assert.equal(rows.length, 2, "the pre-fix mapping DOES double-ask (stockpile + building)");
  assert.ok(rows.some(r => r.kind === "building"), "mutant reintroduces the phantom building row");
});

check("seeded-bad: a mutant stocks cluster keeping the black-circle hide is distinguishable", () => {
  const g = DWFUI.TOKENS.glyphs;
  const mutant = DWFUI.actionButtonsHtml([{ action: "hide", glyph: "&#9679;", dataset: { stockAction: "hide" } }],
    { btnCls: "stocks-item-action" });
  assert.doesNotMatch(mutant, new RegExp(rx(g.hide)), "the mutant must NOT carry the canonical eye");
});

// =============================================================================================
// 7. CSS -- the rebuilt structure has real styling (not orphaned class hooks)
// =============================================================================================
check("CSS: side-tab strip, flex header, location + contents rows are styled", () => {
  assert.match(css, /\.stock-item-sidetabs \{/);
  assert.match(css, /\.stock-item-sidetabs \.dwfui-occupant-tab \{/);
  assert.doesNotMatch(css, /\.stock-item-sidetab\.active \{/);
  assert.match(css, /\.stock-item-header \{[\s\S]*?display: flex;/);
  assert.match(css, /\.stock-item-loc-row \{/);
  assert.match(css, /\.stock-item-content-row \{[\s\S]*?grid-template-columns:/);
});

// =============================================================================================
// 8. WAVE-5 GATE C -- PB-02 (grouped stock search), PB-04 (an absent cell renders NOTHING), and
//    the last two silent-letter art fallbacks. These cells assert RENDERED MARKUP, not source
//    regexes: a green `assert.match(source, /DWFUI/)` once reported "0 queued" while 467 controls
//    bypassed the layer, so every claim below is made against the string the panel actually emits.
// =============================================================================================
globalThis.escapeHtml = value => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
globalThis.window = globalThis;
globalThis.DWFUI = DWFUI;
// Cross-module globals the info rows resolve at CALL time (dwf-unit-hud-notifications.js /
// dwf-building-zone-stockpile-panels.js). Faithful, minimal stand-ins: the cells below assert
// the ART CHANNEL, not the portrait sheet, and a stub keeps that boundary honest.
globalThis.unitPortraitMarkup = (row, cls) => `<span class="${cls}" data-stub-portrait="${row.unitId}"></span>`;
globalThis.spIconStyle = (rowIdx, px) => `background-position:0px -${rowIdx * px}px`;
globalThis.dfTokenMatch = (haystack, query) => {
  const h = String(haystack == null ? "" : haystack).toLowerCase();
  const q = String(query == null ? "" : query).trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every(t => !t || h.includes(t));
};
const infoPanel = require(path.join(root, "web/js/dwf-build-info-panels.js"));

// A SERVER search payload. The server (info_panel.cpp add_stock_items_for_search) has ALREADY applied
// the query -- it walks world->items.all with no category filter and sorts by base name. Note the
// third row: its name does NOT contain the raw query token. That is deliberate. It stands for any row
// the C++ `stock_search_matches` accepts but the client's own `dfTokenMatch` would not, and it must
// still reach the screen -- the panel may not second-guess the server with a different matcher.
const searchPayload = {
  detail: "", footer: "", rows: [
    { job: "bars", name: "Bars", status: "182" },
    { job: "weapons", name: "Weapons", status: "5" },
  ],
  stockItems: [
    { itemId: 1, name: "alpaca wool tunic", count: 1, status: "", subtitle: "ARMOR",
      spriteRef: { itemType: "ARMOR", itemSubtype: 3, materialType: 12, materialIndex: 4 } },
    { itemId: 2, name: "alpaca wool tunic", count: 1, status: "", forbidden: true, subtitle: "ARMOR",
      spriteRef: { itemType: "ARMOR", itemSubtype: 3, materialType: 12, materialIndex: 4 } },
    { itemId: 3, name: "llama wool shirt", count: 1, status: "", subtitle: "ARMOR",
      spriteRef: { itemType: "ARMOR", itemSubtype: 2, materialType: 12, materialIndex: 5 } },
  ],
};

check("PB-02/B4: a stock SEARCH renders native GROUP HEADERS with member rows beneath (rowGroupHtml)", () => {
  const html = infoPanel.stocksPanelMarkup(searchPayload, { activeCategory: "bars", query: "wool" }).html;
  // native df searching stock.png: `Alpaca wool tunics [2]` is a GROUP HEAD, its two items sit under it.
  assert.match(html, /class="dwfui-group stocks-search-group"/, "search results are grouped by item type");
  assert.match(html, /class="dwfui-group-head"/, "each group carries a header bar");
  assert.match(html, /class="dwfui-group-count">\[2\]/, "a 2-member group prints its [N] count");
  assert.match(html, /class="dwfui-group-rows"/, "members are nested BELOW the header, indented");
  // A one-member group gets a header too, and NO count -- native prints `Llama wool shirt`, not `[1]`.
  assert.doesNotMatch(html, /\[1\]/, "native does not print a [1] on a single-member group");
  const groups = html.match(/class="dwfui-group stocks-search-group"/g) || [];
  assert.equal(groups.length, 2, "two distinct item types => two groups");
});

check("PB-02: the client does NOT re-filter the server's results with a second matcher", () => {
  // The query is `wool`. Row 3 ("llama wool shirt") matches; but the point of the cell is that EVERY
  // row the server returned survives -- the panel forwards, it does not re-adjudicate.
  const html = infoPanel.stocksPanelMarkup(searchPayload, { query: "alpaca" }).html;
  for (const id of [1, 2, 3])
    assert.match(html, new RegExp(`data-stock-item-id="${id}"`),
      `the panel dropped item ${id}, which the SERVER had already accepted for this query`);
  assert.match(html, /Count: <strong>3<\/strong>/, "the count reports what the server sent");
});

check("PB-02: stock item rows are DWFUI rows on the native TABLE chassis, wires intact", () => {
  const html = infoPanel.stocksPanelMarkup(searchPayload, { query: "wool" }).html;
  assert.match(html, /class="dwfui-row stocks-item-row dwfui-row--table"/, "the hatched native row chassis");
  // The item art reaches the DOM through the ONE item channel -- a real placeholder, not a letter.
  assert.match(html, /class="dwfui-icon stocks-item-icon dwfui-icon--item"[^>]*data-dwfui-item=/,
    "the row's item sprite is declared for paintItemSprites");
  assert.doesNotMatch(html, /dwfui-icon--letter/, "an item icon NEVER degrades to a letter");
  // Every one of the five action hooks still dispatches exactly what it dispatched before.
  for (const action of ["zoom", "view", "forbid", "dump", "hide"])
    assert.match(html, new RegExp(`data-stock-action="${action}"`), `stocks row keeps its ${action} wire`);
  assert.match(html, /data-dwfui-sprite="STOCKS_RECENTER"/, "native art, not an emoji");
});

check("PB-02: the stocks search is a PANE-HEADER search (F7 P2), magnifier + caret preserved", () => {
  const html = infoPanel.stocksPanelMarkup(searchPayload, { query: "wool" }).html;
  assert.match(html, /class="dwfui-search stocks-search-row dwfui-search--pane-header"/);
  assert.match(html, /data-stocks-search/, "the live search hook is unchanged");
  assert.match(html, /data-dwfui-search-key="stocks-search"/, "caret survives a re-render");
  assert.doesNotMatch(html, /&#128269;|🔍/, "the magnifier is BUTTON_FILTER art, never the emoji");
});

check("PB-04: a task row that names NO entity renders an EMPTY cell -- not a lettered box", () => {
  // tasks screen.png: the `Dump item` rows carry a job name and nothing else. Their columns are EMPTY.
  const dump = { unitId: -1, name: "", status: "Dump item", jobId: -1, hasPos: false, kind: "" };
  const cell = infoPanel.taskPlaceCellHtml(dump);
  assert.doesNotMatch(cell, /dwfui-icon--letter/, "no letter");
  assert.doesNotMatch(cell, /info-place-icon/, "and no bordered place tile either -- native draws NOTHING");
  assert.ok(/^<span [^>]*><\/span>$/.test(cell), `the cell must still EXIST to hold its grid column: ${cell}`);
  // ...while a row that DOES name a place still gets its real art.
  const pile = { unitId: -1, name: "Food Stockpile #13", kind: "stockpile", iconSheet: "stockpile", iconRow: 2 };
  assert.match(infoPanel.taskPlaceCellHtml(pile), /class="info-place-icon"/);
});

check("WAVE-5: the info-row action cluster is three NATIVE SPRITES, and zero emoji", () => {
  const row = { kind: "stockpile", buildingId: 4, jobId: 10, hasPos: true, x: 1, y: 2, z: 3 };
  const html = infoPanel.infoRowActions(row);
  assert.match(html, /data-dwfui-sprite="BUILDING_JOBS_REMOVE"/, "cancel job");
  assert.match(html, /data-dwfui-sprite="STOCKS_VIEW_ITEM"/, "open / manage");
  assert.match(html, /data-dwfui-sprite="RECENTER_RECENTER"/, "center and flash -- NOT a movie camera");
  for (const emoji of ["&#10006;", "&#128269;", "&#127909;"])
    assert.doesNotMatch(html, new RegExp(rx(emoji)), `the ${emoji} glyph is retired`);
  // The wires are the contract.
  assert.match(html, /data-info-cancel-job="10"/);
  assert.match(html, /data-info-open/);
  assert.match(html, /data-info-center/);
  assert.match(html, /class="info-row-actions"/, "the pinned classname survives the migration");
});

check("WAVE-5: the Creatures sort header is DF's own SORT_* art, not a ▼ character", () => {
  const html = infoPanel.creatureRowsMarkup(
    [{ unitId: 1, name: "Urist", profession: "Miner", category: "Dwarf" }],
    { sortKey: "name", sortDir: -1 });
  assert.match(html, /class="dwfui-sort-head info-sort-head-row"/, "the native column header strip");
  assert.match(html, /data-dwfui-sprite="SORT_DESCENDING_ACTIVE"/, "the ACTIVE column reports its direction");
  assert.match(html, /data-dwfui-sprite="SORT_TEXT_INACTIVE"/, "inactive columns are dim text-sort tiles");
  assert.doesNotMatch(html, /&#9660;|▼/, "the hand-rolled caret character is gone");
  assert.match(html, /data-creature-sort="name"/, "the sort wire is unchanged");
  // ...and the row's own action pair is native art too.
  assert.match(html, /data-dwfui-sprite="STOCKS_VIEW_ITEM"/);
  assert.doesNotMatch(html, /&#8618;/, "the curly-arrow locate glyph is retired for RECENTER_RECENTER");
});

check("WAVE-5: the LAST silent letter fallbacks (place icon, held item) fail LOUD instead", () => {
  // An unresolvable place: no zone sheet, no stockpile sheet, no building icon key.
  const orphan = infoPanel.renderInfoRows([{ name: "Mystery", kind: "building", buildingId: 7, category: "Other" }]);
  assert.doesNotMatch(orphan, /dwfui-icon--letter/, "never a letter");
  assert.match(orphan, /data-df-identity-missing="none"/, "a VISIBLE, mechanically detectable blocker");
  assert.match(orphan, /dwfui-icon--empty/, "native paints an EMPTY TILE for missing art");
  // The held-item tile: the wire sends a NAME but no spriteRef, so it must fail loud, not print "D".
  const held = infoPanel.creatureRowsMarkup([{ unitId: 2, name: "Urist", heldItem: "iron dagger" }], {});
  assert.match(held, /class="dwfui-icon dwfui-icon--empty info-held-item"/);
  assert.doesNotMatch(held, /class="info-held-item"[^>]*>D</, "the first-letter tile is gone");
  assert.match(held, /title="iron dagger"/, "the item's real name survives in the tooltip -- no data lost");
});

check("seeded-bad: a flat, ungrouped search result set is discriminated from the native grouping", () => {
  // The mutant is what we shipped before: every hit as a peer row, no group heads at all.
  const mutant = searchPayload.stockItems
    .map(i => `<div class="stocks-item-row" data-stock-item-id="${i.itemId}"></div>`).join("");
  assert.doesNotMatch(mutant, /dwfui-group/, "the pre-fix flat list has NO group headers...");
  const real = infoPanel.stocksPanelMarkup(searchPayload, { query: "wool" }).html;
  assert.match(real, /dwfui-group-head/, "...and the real one does, so this cell can tell them apart");
});

if (failed) { console.error(`\nw3_itemsheet_test: ${failed} FAILED`); process.exit(1); }
console.log("\nw3_itemsheet_test: PASS");
