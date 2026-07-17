// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// B236 (07-14) -- the item sheet "looks nothing like native": a labelled FIELD DUMP
// (Type/Location/Position/Forbidden/Dump/Hidden rows) where native shows a PROSE SENTENCE,
// a meta line missing native's unit glyphs and carrying a `Material:` field native does not
// have, and -- "ever so important" -- the stockpile row with its green `View stockpile` plaque.
//
// ORACLES (all declared native in tools/ui-lab/reference-provenance.json):
//   * tools/orchestrator/attachments/ITEMSHEET-oracle-native.png   -- THE B236 PAIR, native half:
//       sprite + `*apricot wood bed*`; ONE gold line `Weight: 22Γ    Value: ~20☼`; the prose
//       `This is a superior quality apricot wood bed.`; [forbid][dump]..gap..[hide] + camera
//       below-right; then sprite + `Stockpile #1` + green `View stockpile`. NOTHING ELSE.
//   * Menu Oracle Screenshots/item sheets/steam single-item sheet.png -- `<tower-cap splint>`,
//       prose `This is a tower-cap splint.` (NO quality => NO adjective; affixes STRIPPED).
//   * Menu Oracle Screenshots/item sheet flags active.png -- `<<pig tail cloth>>`, prose
//       `This is pig tail cloth.` (a MASS NOUN takes NO article), weight, and -- decisive for
//       the field dump -- NO `Location:`/`Position:`/flag rows AND NO LOCATION ROW AT ALL for
//       an item that is not in a stockpile/container. The flag STATE is the _ACTIVE sprites.
//   * Menu Oracle Screenshots/item sheets/steam barrel-bin contents sheet.png -- container:
//       prose `This is a finely-crafted Fish Barrel <date palm wood> <#6>.` (quality adjective
//       from the `+..+` affix; the affix itself stripped, the rest of the title verbatim).
//
// THE WIRE, TODAY (proven, src/interaction.cpp:1094-1099 + dfhack Items.cpp:750-774):
// `description` = Items::getReadableDescription = the DECORATED DISPLAY NAME -- i.e. exactly
// `title` for anything that is not a book/artifact/unit-container. Native's sentence is NOT on
// the wire, but its INGREDIENTS are: the decorated title (quality affix -> adjective) and the
// item type. So the client BRIDGES: when description===title it composes the sentence, and the
// moment the DLL half ships a real description (composed with DF's own add_article_to_string --
// df.item.xml:897-900), description!==title and the wire text renders VERBATIM.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

const DWFUI = require(path.join(root, "web/js/dwf-ui-components.js"));
globalThis.window = globalThis;
globalThis.DWFUI = DWFUI;
globalThis.escapeHtml = v => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const { stockItemSheetMarkup } = require(path.join(root, "web/js/dwf-build-info-panels.js"));
const css = fs.readFileSync(path.join(root, "web/css/dwf.css"), "utf8");
const infoSrc = fs.readFileSync(path.join(root, "web/js/dwf-build-info-panels.js"), "utf8");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + "\n" + (err.stack || err)); }
}

// ---- The B236 bed, AS THE LIVE SERVER ACTUALLY SENDS IT (transcribed from the broken-ours
// capture + the serialiser at src/interaction.cpp:1140-1167). description === title (the
// getReadableDescription echo), weight WITHOUT the Γ, the full labelled-lines dump, and NO
// stockpile resolution: the bed sits ON a pile's tile, which carries no BUILDING_HOLDER ref,
// so resolve_stock_item_location (interaction.cpp:238-301) reports plain "On map" -- that
// half of B236 is DLL-GATED and pinned below as such.
const LIVE_BED = {
  id: 4242,
  title: "*apricot wood bed*",
  description: "*apricot wood bed*",
  lines: [
    "*apricot wood bed*", "Type: BED", "Material: apricot wood", "Quality: Superior",
    "Weight: 22", "Wear: None", "Location: On map", "Position: 101,101,165",
    "Forbidden: No", "Dump: No", "Hidden: No",
  ],
  weight: "22", value: 23,
  location: "On map", locationId: -1, locationSpriteToken: "", locationSpriteRef: null,
  following: false, mapPos: { x: 101, y: 101, z: 165 },
  forbidden: false, dump: false, hidden: false, isContainer: false,
  spriteRef: { itemType: "BED", itemSubtype: -1, materialType: 420, materialIndex: 100 },
  contents: [],
};
// ...and the SAME bed as the DLL half will send it (native description + resolved stockpile).
const WIRED_BED = Object.assign({}, LIVE_BED, {
  description: "This is a superior quality apricot wood bed.",
  lines: ["This is a superior quality apricot wood bed."],
  location: "Stockpile #1", locationId: 91,
  locationSpriteToken: "STOCKPILE_ICON_FURNITURE",
});

const live = stockItemSheetMarkup(LIVE_BED, {}).html;
const wired = stockItemSheetMarkup(WIRED_BED, {}).html;

// =================================================================================================
// 1. THE FIELD DUMP IS DEAD. Native expresses every one of those rows elsewhere: the flags are the
//    icon buttons (already _ACTIVE-sprite-stateful + wired), the position is the camera tool, the
//    location is the stockpile row. The labelled rows exist on NO native sheet.
// =================================================================================================
check("B236: the labelled field dump does not render -- on either wire shape", () => {
  for (const [name, html] of [["live", live], ["wired", wired]]) {
    for (const label of ["Type:", "Location:", "Position:", "Forbidden:", "Dump:", "Hidden:",
      "Quality:", "Wear:", "Material:", "Container:", "Owner:"])
      assert.ok(!html.includes(label), `${name}: native has no '${label}' row`);
    assert.ok(!html.includes("stock-item-line"), `${name}: the detail-line element is retired`);
  }
  // ...and the state those rows carried still reaches the screen: the flag buttons reflect it.
  const latched = stockItemSheetMarkup(Object.assign({}, LIVE_BED,
    { forbidden: true, dump: true, hidden: true }), {}).html;
  for (const t of ["STOCKS_FORBID_ACTIVE", "STOCKS_DUMP_ACTIVE", "STOCKS_HIDE_ACTIVE"])
    assert.match(latched, new RegExp(`data-dwfui-sprite="${t}"`), `flag state now lives in ${t}`);
  for (const a of ["forbid", "dump", "hide"])
    assert.match(latched, new RegExp(`data-item-toggle="${a}"`), `and ${a} stays a wired toggle`);
});

check("B236: the detail-line machinery is deleted from the source, not just skipped", () => {
  const code = infoSrc.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /REDUNDANT_DETAIL|MOVED_TO_META|detailBlock|detailLines/,
    "the line-dump renderer must not survive as dead code");
  assert.ok(!/\.stock-item-line \{/.test(css), "its CSS rule goes with it");
});

// =================================================================================================
// 2. META LINE -- `Weight: 22Γ    Value: ~23☼`, gold, native unit glyphs, NO Material field.
//    Γ (U+0393) and ☼ (U+263C) are DF's weight/value glyphs -- glyph_font_test:380-381 pins both
//    to the traced face's CP437 cells, so they render as the oracle's exact marks.
// =================================================================================================
check("B236: weight takes the Γ unit glyph -- appended for the live wire, never doubled", () => {
  assert.match(live, /Weight: 22Γ/, "the live wire sends '22'; the sheet renders native '22Γ'");
  const suffixed = stockItemSheetMarkup(Object.assign({}, LIVE_BED, { weight: "22Γ" }), {}).html;
  assert.match(suffixed, /Weight: 22Γ/);
  assert.doesNotMatch(suffixed, /ΓΓ/, "a wire that already carries the glyph is not doubled");
  const fraction = stockItemSheetMarkup(Object.assign({}, LIVE_BED, { weight: "<1" }), {}).html;
  assert.match(fraction, /Weight: &lt;1Γ/, "the flags-active oracle's '<1Γ' form");
});

check("B236: value takes the ☼ glyph, and the pair sits on ONE gold line, Weight first", () => {
  assert.match(live, /Value: ~23☼/, "native: `Value: ~20☼` (ITEMSHEET-oracle-native.png)");
  const meta = /<div class="unit-meta-line stock-item-weight">([\s\S]*?)<\/div>/.exec(live);
  assert.ok(meta, "one meta line");
  assert.ok(meta[1].indexOf("Weight:") < meta[1].indexOf("Value:"), "Weight precedes Value");
  assert.ok(!/Material:/.test(meta[1]),
    "the bed oracle shows Weight+Value ONLY -- the material lives in the title and the prose");
});

check("B236: Material appears NOWHERE as a field -- conveyed by title + prose, as native does", () => {
  // Supersedes the W4-R2 fallback placement ("move it next to weight and value"): B236's oracle
  // shows the meta line withOUT it, and the same information is on the sheet twice already --
  // `*apricot wood bed*` and `This is a superior quality apricot wood bed.` No data is lost.
  assert.equal((live.match(/Material/g) || []).length, 0);
  assert.match(live, /apricot wood bed/, "the material is still legible on the sheet");
});

// =================================================================================================
// 3. PROSE -- the client bridge. description===title (today's wire) => compose the native
//    sentence from the pieces already on the wire; a real server description renders VERBATIM.
// =================================================================================================
check("B236: the live bed composes `This is a superior quality apricot wood bed.`", () => {
  assert.match(live, /class="stock-item-description">This is a superior quality apricot wood bed\.</,
    "quality affix *..* => 'superior quality', affix stripped, article 'a', full stop");
  assert.ok(!/stock-item-description">\*apricot wood bed\*/.test(live),
    "the decorated title must not render as the description (that IS the B236 defect)");
});

check("B236: quality affixes map to native adjectives (oracle-pinned: + and *)", () => {
  const prose = (title, extra) => {
    const r = stockItemSheetMarkup(Object.assign({}, LIVE_BED,
      { title, description: title }, extra || {}), {}).html;
    return /class="stock-item-description">([^<]*)</.exec(r)[1];
  };
  // steam barrel-bin contents sheet.png: `+Fish Barrel (date palm wood) <#6>+` =>
  // "This is a finely-crafted Fish Barrel (date palm wood) <#6>."
  assert.equal(prose("+Fish Barrel (date palm wood) &lt;#6&gt;+".replace(/&lt;/g, "<").replace(/&gt;/g, ">")),
    "This is a finely-crafted Fish Barrel (date palm wood) &lt;#6&gt;.");
  // steam single-item sheet.png: `<tower-cap splint>` => "This is a tower-cap splint."
  assert.equal(prose("<tower-cap splint>"), "This is a tower-cap splint.");
  assert.equal(prose("-oak bed-"), "This is a well-crafted oak bed.");
  assert.equal(prose("≡iron anvil≡"), "This is an exceptional iron anvil.");
  assert.equal(prose("☼steel battle axe☼"), "This is a masterful steel battle axe.");
  assert.equal(prose("*apricot wood bed*"), "This is a superior quality apricot wood bed.");
});

check("B236: mass nouns take no article; vowel-initial names take 'an'", () => {
  const prose = (title, itemType) => {
    const r = stockItemSheetMarkup(Object.assign({}, LIVE_BED, { title, description: title,
      spriteRef: { itemType, itemSubtype: -1, materialType: -1, materialIndex: -1 } }), {}).html;
    return /class="stock-item-description">([^<]*)</.exec(r)[1];
  };
  // item sheet flags active.png: `<<pig tail cloth>>` => "This is pig tail cloth."
  assert.equal(prose("<<pig tail cloth>>", "CLOTH"), "This is pig tail cloth.");
  assert.equal(prose("apricot wood bin", "BIN"), "This is an apricot wood bin.");
});

check("B236: a REAL server description renders verbatim -- the bridge never second-guesses it", () => {
  assert.match(wired, /class="stock-item-description">This is a superior quality apricot wood bed\.</);
  const cloth = stockItemSheetMarkup({ id: 9, title: "<<pig tail cloth>>",
    description: "This is pig tail cloth. The material is gray. It is coated with water.",
    contents: [] }, {}).html;
  assert.match(cloth, /This is pig tail cloth\. The material is gray\. It is coated with water\./,
    "the DLL's fuller sentence (flags-active oracle) must pass through untouched");
});

check("B236: unknown prose states FAIL SAFE -- a stack's [N] name is not force-articled", () => {
  // No oracle shows a stack's sheet; until the owner captures one, the bridge composes withOUT inventing
  // an article for a plural ("This is a prickle berries [2]" is a fabrication we refuse).
  const r = stockItemSheetMarkup(Object.assign({}, LIVE_BED,
    { title: "prickle berries [2]", description: "prickle berries [2]" }), {}).html;
  const text = /class="stock-item-description">([^<]*)</.exec(r)[1];
  assert.equal(text, "This is prickle berries [2].");
});

// =================================================================================================
// 4. THE STOCKPILE ROW -- the headline. When the wire carries the pile, the row renders sprite +
//    bare name + the green slab `View stockpile`; when it does not (today's "On map"), native
//    shows NO location row at all (flags-active oracle), and neither do we.
// =================================================================================================
check("B236: the wired bed renders `Stockpile #1` + View stockpile, exactly the oracle row", () => {
  const loc = /<div class="dwfui-row stock-item-loc-row"[\s\S]*?<\/button>\s*<\/div>/.exec(wired);
  assert.ok(loc, "the location row renders with its button");
  assert.match(loc[0], /data-dwfui-sprite="STOCKPILE_ICON_FURNITURE"/, "the pile's own sign art");
  assert.match(loc[0], /Stockpile #1/);
  assert.match(loc[0], /data-stock-item-place="91"/, "the plaque opens THAT stockpile");
  assert.match(loc[0], /View stockpile/);
});

check("B236: `On map` renders NO location row -- the debug row with the blank tile is dead", () => {
  // ITEMSHEET-broken-ours.png shows a blank sprite + "On map" row; item sheet flags active.png
  // (an item in no stockpile/container) shows NO row in that region. The camera tool already
  // carries the go-to-position capability, so nothing wired is lost.
  assert.ok(!/stock-item-loc-row/.test(live), "no locationId + no art channel => no row");
  assert.ok(!/On map/.test(live), "'On map' is a debug string, not a native location");
  // ...but a CONTAINER location (its item-ref art channel) still renders even without an id.
  const inBin = stockItemSheetMarkup(Object.assign({}, LIVE_BED, { location: "In iron bin",
    locationSpriteRef: { itemType: "BIN", itemSubtype: -1, materialType: 0, materialIndex: -1 },
  }), {}).html;
  assert.match(inBin, /stock-item-loc-row/, "a real container location keeps its row");
  assert.match(inBin, /data-dwfui-item-key="BIN:/);
  assert.ok(!/data-stock-item-place/.test(inBin), "no pile id => no View-stockpile plaque");
});

check("B236: a holder-building location loses the invented 'In ' prefix on the pile row", () => {
  // Native prints the bare name (`Stockpile #1`, `Food Stockpile #6`); today's holder-building
  // path (interaction.cpp:293-295) sends "In <name>". Strip it ONLY when the row is a stockpile
  // (the token channel) -- container rows have no bare-name oracle yet.
  const inPile = stockItemSheetMarkup(Object.assign({}, WIRED_BED,
    { location: "In Stockpile #1" }), {}).html;
  const row = /<div class="dwfui-row stock-item-loc-row"[\s\S]*?<\/button>\s*<\/div>/.exec(inPile)[0];
  assert.match(row, /Stockpile #1/);
  assert.doesNotMatch(row, /In Stockpile/, "the pile row prints the bare native name");
});

// =================================================================================================
// 5. HEADER -- [forbid][dump] .. gap .. [hide]; camera below-right (already banded). The bed
//    oracle separates the eye from the two destructive flags, exactly like the contents preset.
// =================================================================================================
check("B236: the hide tool is set apart by the native gap in the header cluster", () => {
  const cluster = /<span class="dwfui-head-tools dwfui-head-tools--rows">([\s\S]*?)<\/span><\/div>/.exec(live);
  assert.ok(cluster, "the banded cluster renders");
  const rows = cluster[1].split('<span class="dwfui-head-tools-row">').slice(1);
  assert.match(rows[0], /dwfui-gap[^>]*data-item-toggle="hide"|class="[^"]*dwfui-gap[^"]*"[^>]*data-item-toggle="hide"/,
    "the eye carries .dwfui-gap (ITEMSHEET-oracle-native.png: [forbid][dump] .. [hide])");
  assert.doesNotMatch(rows[0], /dwfui-gap[^>]*data-item-toggle="forbid"/, "the gap is the eye's alone");
  assert.match(css, /\.dwfui-head-tools \.dwfui-gap \{ margin-left:10px; \}/, "and the gap is styled");
});

// =================================================================================================
// 6. THE FACE -- every native sheet is set in DF's traced face. The sheet opts into the token
//    (font: var(--dwfui-font)), and the title drops its synthetic-bold request (the traced face
//    ships ONE weight; native 'bold' is a colour, not a smear -- see the D1-FONT rule).
// =================================================================================================
check("B236: the sheet adopts the DF face token, and the title stops asking for synthetic bold", () => {
  assert.match(css, /\.stock-item-sheet \{[^}]*font: var\(--dwfui-font\)/,
    "the sheet region takes the traced face + crisp 12px + weight 400, as one token");
  const title = /\.stock-item-title \{([^}]*)\}/.exec(css);
  assert.ok(title, ".stock-item-title is styled");
  assert.ok(!/font-weight/.test(title[1]), "no synthetic bold on the traced face");
});

// =================================================================================================
// 7. SEEDED-BAD -- the shipped B236 defect is DISTINGUISHABLE (test-the-test)
// =================================================================================================
check("seeded-bad: the shipped field-dump sheet FAILS these gates", () => {
  const shipped = LIVE_BED.lines.slice(1)
    .filter(l => !/^\s*(?:Quality|Wear|Material)\s*:/i.test(l))
    .map(l => `<div class="stock-item-line"><span class="stock-item-label">${l.split(":")[0]}:</span>${l.split(":")[1]}</div>`)
    .join("");
  assert.match(shipped, /Position:/, "the old sheet really did print the dump");
  assert.match(shipped, /Forbidden:/);
  assert.ok(!/Position:|Forbidden:/.test(live), "...and the new one really does not");
  const oldMeta = `<div class="unit-meta-line stock-item-weight">Weight: 22&nbsp;&nbsp;&nbsp;Value: ~23&nbsp;&nbsp;&nbsp;Material: apricot wood</div>`;
  assert.ok(!/Γ/.test(oldMeta) && /Material:/.test(oldMeta), "the old meta line: no glyphs, a Material field");
  assert.ok(/Weight: 22Γ/.test(live) && !/Material:/.test(live), "the new one is the oracle's");
});

if (failed) { console.error(`\nb236_itemsheet_native_test: ${failed} FAILED`); process.exit(1); }
console.log("\nb236_itemsheet_native_test: PASS");
