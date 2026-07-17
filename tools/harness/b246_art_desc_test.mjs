// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// B246 (07-14) -- "Statues and engravings have no way to see their descriptions. Statues I
// can click on but there is no description and also no sprite of what the statue is. Engravings I
// cannot click on."
//
// HIS CAPTURE (tools/orchestrator/attachments/B246-1.png) shows our statue panel as EXACTLY four
// things: `limestone Statue` / `Constructed.` / `Ordered by ●a playtester` / [Remove building]. No prose
// about what the statue depicts. No statue sprite -- even though the occupant rail beside it renders
// sprites fine, which is what proves the art pipeline was never the problem.
//
// ------------------------------------------------------------------------------------------------
// WHERE THE PROSE COMES FROM (df-structures; art_desc.h carries the full citation trail)
//
//   STATUE / FIGURINE   df.item.xml:1539 / :1612
//       <stl-string name='description' original-name='art_string'/>
//     Round-3 live evidence proves a STATUE stores only the subject name there. Its completed prose
//     is composed from item_statuest.image + DF art-image vmethods. Figurines still ride the generic
//     getItemShapeDesc channel; statues use their concrete image.id/subid accessor.
//
//   ENGRAVING           df.event.xml:15-27 `struct-type engraving`
//     Has no persisted sentence, but B288 found DF's formatter vmethods on art_image elements,
//     properties, and references. The panel now renders that DF-derived sentence and stays empty
//     when a required DF-generated piece is unavailable.
//
// TEST-THE-TEST (completeness protocol rule 3): every check here was run against the PRE-FIX tree
// and FAILED. Proof is in the B246 closeout; the seeded-bad variants below (`SEEDED` checks) keep it
// honest going forward by asserting the panel REFUSES bad input rather than rendering it.

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

const panels = require(path.join(root, "web/js/dwf-building-zone-stockpile-panels.js"));
// Pre-fix these three are simply NOT EXPORTED. Binding them to a throwing stub makes each check fail
// with a real message instead of a destructuring TypeError.
const missing = name => () => { throw new Error(name + " is not exported (pre-fix tree)"); };
const buildingArtMarkup = panels.buildingArtMarkup || missing("buildingArtMarkup");
const genericBuildingPanelMarkup = panels.genericBuildingPanelMarkup || missing("genericBuildingPanelMarkup");
const engravingPanelMarkup = panels.engravingPanelMarkup || missing("engravingPanelMarkup");
// TEST-THE-TEST: a MISSING file must make the CHECKS fail one by one, not blow the harness up in
// its own preamble. On the pre-fix tree src/art_desc.* does not exist at all, and an ENOENT there
// would have "failed" for a reason that proves nothing about any single claim. Absent => "".
const read = rel => { try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch (_) { return ""; } };
const css      = read("web/css/dwf.css");
const artCpp   = read("src/art_desc.cpp");
const artH     = read("src/art_desc.h");
const bzCpp    = read("src/building_zone.cpp");
const interCpp = read("src/interaction.cpp");
const coreJs   = read("web/js/dwf-core.js");
const panelsJs = read("web/js/dwf-building-zone-stockpile-panels.js");
const popupCpp  = read("src/native_popup.cpp");
const portraitCpp = read("src/unit_portrait.cpp");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + "\n" + (err.stack || err)); }
}

// ---- FIXTURE 1: THE STATUE, as /building-info sends it AFTER this wave ----------------------
// The `artDescription` is the DLL's DF-sourced composition. The client must render the wire string
// verbatim and never attempt a second composition.
const STATUE = {
  id: 4211,
  name: "limestone Statue",
  built: true, hasJobs: false, suspended: false, doNow: false,
  artDescription: "This is a limestone statue of Urist McMason, Dwarf. The item is a masterwork " +
                  "of limestone. Urist McMason is striking down a goblin.",
  artName: "The Bronze Vault of Mining",
  artQuality: 5,
  artQualityName: "Masterful",
  artItemId: 90210,
  spriteRef: { itemType: "STATUE", itemSubtype: -1, materialType: 0, materialIndex: 27 },
};

// ---- FIXTURE 2: a DOOR -- the same panel, NO art. Proves the block is inert for everything else --
const DOOR = { id: 55, name: "granite Door", built: true, hasJobs: false, suspended: false,
               passageControl: true, passageForbidden: false, passageClosed: false };

// ---- FIXTURE 3: an ENGRAVING, as /engraving-info sends it after B288 --------------------------
const ENGRAVING = {
  ok: true, present: true,
  tile: { x: 71, y: 118, z: 132 },
  title: 'Mukar Nashas, "The Sadness of Lilacs"',
  artName: "The Bronze Vault of Mining",
  quality: 4, qualityName: "Exceptional",
  skill: "Proficient",
  artistId: 331, artistName: "Urist McEngraver",
  surface: "wall",
  obscured: false,
  descriptionAvailable: true,
  description: "Engraved on the wall is an image of sun berries by Rith Nethmorul.",
};

// ---- FIXTURE 4: a relation-bearing engraving with a longer DF sentence -----------------------
const ENGRAVING_WITH_PROSE = Object.assign({}, ENGRAVING, {
  descriptionAvailable: true,
  description: "On the wall is an exceptionally designed image of a dwarf and a goblin in " +
               "limestone. The dwarf is striking down the goblin.",
});

// ================================================================================================
// 1. THE STATUE'S DESCRIPTION IS ON SCREEN, AND IT IS DF'S OWN STRING
// ================================================================================================

check("statue panel renders the DLL's composed statue prose VERBATIM (the #1 complaint)", () => {
  const html = genericBuildingPanelMarkup(STATUE, {});
  assert.ok(html.includes("Urist McMason is striking down a goblin."),
    "DF's own art sentence must appear in the statue panel");
  assert.ok(html.includes("This is a limestone statue of Urist McMason"),
    "the WHOLE wire sentence renders, not a truncated head");
});

check("statue prose is rendered VERBATIM, never re-composed from the title", () => {
  // The B236 defect in one assertion: a panel that "has a description" because it echoed the name.
  // NOTE this check is written POSITIVE-FIRST on purpose. Written as a bare negative
  // ("the prose slot does not contain the title") it PASSED on the pre-fix tree -- vacuously, because
  // there was no prose slot at all. A test that a broken build passes is not a test. So: the slot
  // must EXIST, and its contents must be the wire's sentence and not the name.
  const html = genericBuildingPanelMarkup(STATUE, {});
  const m = /<div class="bld-art-prose">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(m, "the prose slot must EXIST (the pre-fix panel had none -- that was the bug)");
  const text = m[1].trim();
  assert.equal(text, STATUE.artDescription,
    "the prose slot holds the WIRE'S string, byte-for-byte -- not the building name, not a " +
    "sentence composed on the client");
  assert.notEqual(text, STATUE.name,
    "and never the building NAME wearing a description's clothes (that is exactly B236)");
});

check("SEEDED-BAD: empty artDescription renders NO prose slot at all (never invents one)", () => {
  const mute = Object.assign({}, STATUE, { artDescription: "" });
  const html = genericBuildingPanelMarkup(mute, {});
  assert.ok(!html.includes("bld-art-prose"),
    "no DF prose on the wire => NO prose element. Composing a sentence here is the whole bug class.");
  // ...but the sprite and the artwork name it DOES have must still show.
  assert.ok(html.includes("data-dwfui-item"), "the sprite still renders when only the prose is absent");
});

check("prose is a DWFUI scrollbox, not a clipped div (component-architecture spec)", () => {
  const html = genericBuildingPanelMarkup(STATUE, {});
  assert.ok(html.includes("dwfui-scroll"), "art prose must ride DWFUI.scrollHtml");
  assert.ok(css.includes(".building-panel .bld-art-prose"), "the prose has a real style");
});

// ================================================================================================
// 2. THE STATUE'S SPRITE IS IN THE PANEL, THROUGH THE EXISTING ITEM CHANNEL
// ================================================================================================

check("statue panel emits an ITEM spriteRef (the #2 complaint)", () => {
  const html = genericBuildingPanelMarkup(STATUE, {});
  assert.ok(html.includes("data-dwfui-item"),
    "the statue's sprite must ride DWFUI's item channel");
  assert.ok(html.includes("&quot;itemType&quot;:&quot;STATUE&quot;") || html.includes('"itemType":"STATUE"'),
    "and it must carry the STATUE item ref the server now sends");
});

check("the sprite reuses the EXISTING spriteRef mechanism -- no second one was invented", () => {
  // The item sheet (B236/W3) and the occupant rail (B224) both speak
  // {itemType,itemSubtype,materialType,materialIndex} through DWFUI.iconHtml({item}). The statue
  // panel must speak the SAME one. If a wave ever hand-rolls a rival item-art path, this fails.
  assert.ok(/DWFUI\.iconHtml\(\{\s*item:\s*info\.spriteRef/.test(panelsJs),
    "buildingArtMarkup must call DWFUI.iconHtml({item: info.spriteRef}) -- the established channel");
  assert.ok(/append_item_art_json/.test(bzCpp),
    "/building-info must serialize the art through the shared serializer, not a bespoke one");
});

check("the ref is PAINTED -- an unpainted data-dwfui-item is an invisible sprite", () => {
  // A correct ref that nobody blits looks EXACTLY like the reported bug, one layer down.
  // The paint pass must be INSIDE openBuildingPanel and AFTER the markup is assigned -- a paint that
  // runs before innerHTML, or in some other function, blits nothing.
  const start = panelsJs.indexOf("async function openBuildingPanel");
  assert.ok(start >= 0, "openBuildingPanel exists");
  const open = panelsJs.slice(start, panelsJs.indexOf("\n  async function", start + 40));
  const assign = open.indexOf("genericBuildingPanelMarkup(info,");
  const paint = open.indexOf("DWFUI.paintSprites(panelContent(selection))");
  assert.ok(paint > 0, "openBuildingPanel must run the DWFUI paint pass over its rendered markup");
  assert.ok(paint > assign, "and it must run AFTER the markup is assigned, or it blits nothing");
});

check("SEEDED-BAD: a malformed spriteRef FAILS LOUD, it never degrades to a letter", () => {
  const bad = Object.assign({}, STATUE, { spriteRef: { itemType: "" } });
  const html = buildingArtMarkup(bad);
  assert.ok(!/dwfui-icon--letter/.test(html),
    "the letter path is the blocker the item channel exists to retire, not its fallback");
});

// ================================================================================================
// 3. A DOOR IS UNCHANGED -- the art block is inert for buildings with no art
// ================================================================================================

check("a building with no art renders NO art block (additive, zero blast radius)", () => {
  const html = genericBuildingPanelMarkup(DOOR, {});
  assert.equal(buildingArtMarkup(DOOR), "", "no art => empty string, not an empty box");
  assert.ok(!html.includes("bld-art"), "the door panel is byte-identical to before this wave");
  assert.ok(html.includes("Remove building"), "and still has everything it had");
});

// ================================================================================================
// 4. ENGRAVINGS ARE SELECTABLE AT ALL (the #3 complaint)
// ================================================================================================

check("the server resolves an engraved tile to kind:'engraving', not the generic tile panel", () => {
  assert.ok(/result\.kind = "engraving"/.test(interCpp),
    "inspect_at_pixel must have an engraving kind -- WHY the click 'did nothing' before: it always " +
    "landed, but an engraved tile fell through to kind:'tile', whose panel shows a tiletype name " +
    "and a coordinate and nothing about the engraving");
  // ...and it must sit AFTER everything that stands on the tile, so a dwarf on an engraved floor
  // still selects the dwarf (DF's own precedence).
  assert.ok(interCpp.indexOf('result.kind = "engraving"') > interCpp.indexOf('result.kind = "unit"'),
    "occupants still win over the tile property");
});

check("the client dispatches kind:'engraving' to a real panel", () => {
  assert.ok(/kind === "engraving"[\s\S]{0,200}openEngravingPanel/.test(coreJs),
    "showSelection must route engravings to openEngravingPanel");
});

check("opening the engraving panel cannot move the camera (B216)", () => {
  assert.ok(/\/engraving-info\?x=\$\{tile\.x\}&y=\$\{tile\.y\}&z=\$\{tile\.z\}/.test(panelsJs),
    "the panel opens on an explicit TILE, never on a pixel -- a pixel would re-derive the viewport");
  assert.ok(/query_int\(req, "x", x\)/.test(artCpp), "and the route takes x/y/z, not px/py/w/h");
});

// ================================================================================================
// 5. THE ENGRAVING PANEL SHOWS DF'S DATA -- AND REFUSES TO INVENT PROSE
// ================================================================================================

check("engraving panel shows DF's own title and generated prose", () => {
  const html = engravingPanelMarkup(ENGRAVING, ENGRAVING.tile);
  assert.ok(html.includes("Mukar Nashas"), "DF's own generated artwork title");
  assert.ok(html.includes("sun berries by Rith Nethmorul"), "DF's generated body");
});

check("*** engraving panel INVENTS NO PROSE when the wire has none ***", () => {
  const html = engravingPanelMarkup(Object.assign({}, ENGRAVING, {
    descriptionAvailable: false, description: "",
  }), ENGRAVING.tile);
  assert.ok(!html.includes("engrave-prose"),
    "descriptionAvailable:false MUST render no prose element");
  assert.ok(!/This is an engraving of/i.test(html),
    "and above all: NO FABRICATED SENTENCE. df::engraving has no description field; a plausible " +
    "invented string is the exact failure mode the B24 postmortem was written about.");
  assert.ok(!/does not store a written description|composes one only/i.test(html),
    "absence stays empty; the client must not replace it with its own explanatory prose");
});

check("engraving panel renders DF's REAL sentence verbatim the moment one is available", () => {
  const html = engravingPanelMarkup(ENGRAVING_WITH_PROSE, ENGRAVING.tile);
  assert.ok(html.includes("The dwarf is striking down the goblin."),
    "descriptionAvailable:true => the wire's sentence renders VERBATIM");
  assert.ok(html.includes("dwfui-scroll"), "and it rides a DWFUI scrollbox");
  assert.ok(!/does not store a written description/i.test(html),
    "and the honest note disappears, because it is no longer true");
});

check("engraving panel is never an empty shell when prose is still loading", () => {
  // Today's live failure shape: the engraving and its resident metadata are present, but the art
  // chunk is not, so title/artName/prose are empty while artistName + qualityName are non-empty.
  const html = engravingPanelMarkup({
    ok: true, present: true, title: "", artName: "",
    artistName: "Urist McEngraver", qualityName: "Exceptional",
    descriptionAvailable: false, description: "",
  }, ENGRAVING.tile);
  assert.ok(html.includes("Engraving"), "an absent art title falls back to Engraving");
  assert.ok(html.includes("Artist") && html.includes("Urist McEngraver"),
    "artist metadata remains visible on an empty-prose payload");
  assert.ok(html.includes("Quality") && html.includes("Exceptional"),
    "quality metadata remains visible on an empty-prose payload");
  assert.ok(html.includes("engrave-row"), "the body has native fact rows, never a bare shell");
});

check("engraving panel handles an un-engraved tile without pretending", () => {
  const html = engravingPanelMarkup({ ok: true, present: false }, { x: 1, y: 2, z: 3 });
  assert.ok(html.includes("No engraving on this tile."));
  assert.ok(!html.includes("engrave-prose"));
});

// ================================================================================================
// 6. ROUND-4 RESIDENCY MODEL + PERSISTENT BANK
// ================================================================================================

function modeledArtResolve({ chunks, artId, subid, bank, widget }) {
  // Mirrors production order exactly: resident round-3 composition, bank, native sheet on miss.
  const chunk = chunks.find(c => c && c.id === artId);
  const resident = chunk && chunk.images && chunk.images[subid];
  if (resident && resident.prose) return { source: "resident", prose: resident.prose };
  const key = `${artId}:${subid}`;
  if (bank.has(key)) return { source: "bank", prose: bank.get(key).plain };
  const composed = widget();
  if (!composed || !composed.plain) return { source: "fallback", prose: "" };
  bank.set(key, composed);
  return { source: "widget", prose: composed.plain };
}

check("EMPTY art_image_chunks takes the bank/widget path instead of fixture-resident prose", () => {
  const bank = new Map();
  let widgetCalls = 0;
  const first = modeledArtResolve({
    chunks: [], artId: 3, subid: 224, bank,
    widget: () => {
      widgetCalls++;
      return { raw: "[C:7:0:1]This is DF-composed prose.[C:7:0:0]", plain: "This is DF-composed prose." };
    },
  });
  assert.deepEqual(first, { source: "widget", prose: "This is DF-composed prose." });
  assert.equal(widgetCalls, 1, "a nonresident image must invoke DF's native sheet exactly once");
  const second = modeledArtResolve({
    chunks: [], artId: 3, subid: 224, bank,
    widget: () => { widgetCalls++; return null; },
  });
  assert.deepEqual(second, { source: "bank", prose: "This is DF-composed prose." });
  assert.equal(widgetCalls, 1, "the immutable bank suppresses every later composition");
});

function encodeBankRecord(record) {
  const hex = value => Buffer.from(String(value), "utf8").toString("hex").toUpperCase();
  return ["DWF_ART_PROSE_V1", hex(record.world), record.kind, record.artId, record.subid,
          record.x, record.y, record.z, hex(record.raw), hex(record.plain)].join("\t") + "\n";
}
function decodeBankRecord(line) {
  const f = line.trimEnd().split("\t");
  assert.equal(f.length, 10);
  assert.equal(f[0], "DWF_ART_PROSE_V1");
  const text = value => Buffer.from(value, "hex").toString("utf8");
  return { world: text(f[1]), kind: f[2], artId: Number(f[3]), subid: Number(f[4]),
           x: Number(f[5]), y: Number(f[6]), z: Number(f[7]),
           raw: text(f[8]), plain: text(f[9]) };
}

check("art bank round-trip preserves world/key/position, plain text, and [C:] tokens", () => {
  const record = {
    world: "region1", kind: "E", artId: 1, subid: 225, x: 84, y: 115, z: 176,
    raw: "[C:2:0:1]Engraved is a rendition.[C:7:0:0]",
    plain: "Engraved is a rendition.",
  };
  assert.deepEqual(decodeBankRecord(encodeBankRecord(record)), record);
});

check("production path pins resident -> bank -> native sheet and serializes compositions", () => {
  assert.match(artCpp, /dfcapture-art-prose\.bank/);
  assert.match(artCpp, /DWF_ART_PROSE_V1/);
  assert.match(artCpp, /std::mutex g_art_compose_queue/,
    "one mutex owns the in-flight native sheet; waiters form the queue");
  assert.match(artCpp, /native_viewscreen_logic_render_isolated/,
    "art reuses the portrait module's isolated render rail");
  assert.match(portraitCpp, /bool native_viewscreen_logic_render_isolated/);
  assert.match(artCpp, /entry\.raw_markup = sheets\.raw_description/,
    "DF's raw [C:] markup is banked beside plain text");
  assert.match(artCpp, /native_markup_plain_text\(entry\.raw_markup\)/,
    "plain text comes from the popup module's shared native token parser");
  assert.match(popupCpp, /std::string native_markup_plain_text/);
  assert.match(artCpp, /NativeSheetIdentitySnapshot/);
  assert.match(bzCpp, /complete_item_art_prose\(info\.art\)/,
    "statue building clicks trigger a cold composition");
  assert.match(artCpp, /complete_engraving_art_prose\(art\)/,
    "engraving-info clicks trigger a cold composition");
  assert.match(interCpp, /action == "info"[\s\S]{0,500}complete_item_art_prose\(art\)/,
    "statues opened through the item sheet trigger the same cache path");
});

// ================================================================================================
// 7. THE SERVER'S CONTRACT -- the citations must stay true, and the prose must stay DF's
// ================================================================================================

check("statue prose resolves item_statuest.image and composes from DF-sourced parts", () => {
  assert.ok(/find_art_image\(statue->image\.id, statue->image\.subid\)/.test(artCpp),
    "statue image uses df.item.xml's exact image.id/subid accessor");
  assert.ok(/statue_description\(statue, image\)/.test(artCpp));
  assert.ok(/MaterialInfo material\(static_cast<df::item\*>\(statue\)\)/.test(artCpp));
  assert.ok(/art_elements_description\(image\)/.test(artCpp));
  assert.ok(/art_properties_description\(image\)/.test(artCpp));
  assert.ok(/item_slabst/.test(artCpp), "slabs read DF's own `memorial` field");
  assert.ok(/Translation::translateName/.test(artCpp),
    "artwork names come from DF's own name generator, never from string-building here");
});

check("the statue's art comes from the CONTAINED ITEM -- the actual root cause", () => {
  assert.ok(/contained_items/.test(artCpp),
    "building_art must walk building_actual::contained_items. A statue BUILDING holds no art at " +
    "all (df::building_statuest has ONE field, an unused statue_flag); the art and the sprite BOTH " +
    "live on the df::item_statuest it was built from. A panel that only read the BUILDING was " +
    "always going to show neither -- that is the whole bug, in one sentence.");
  assert.ok(/out\.art = building_art\(b\)/.test(bzCpp), "/building-info must actually call it");
});

check("the engraving wire serializes only the DF-derived description", () => {
  assert.ok(/json_string\(art\.description\)/.test(artCpp),
    "engraving_art_json must serialize EngravingArt.description, not a client placeholder");
  assert.ok(/art_image_element::getName/.test(artH) && /art_image_property::getName/.test(artH),
    "the header cites DF's own element/property formatter vmethods");
});

check("the item sheet also shows the shared composed statue body", () => {
  assert.ok(/ItemArt art = item_art\(item\)[\s\S]{0,120}result\.description = art\.description/.test(interCpp),
    "a statue clicked AS AN ITEM must use the same item_art composition as its building sheet");
});

// ================================================================================================
// 8. THE ART-CLASS AUDIT (completeness protocol rule 1: fix the CATEGORY, not the reported cell)
//
// Enumerated from df.item.xml -- EVERY class that carries an art description or an art_image ref:
//
//   item_statuest      subject + image ref          -> SHIPPED composition (building + item sheet)
//   item_figurinest    description = `art_string`   -> SHIPPED FOR FREE. Same DF vmethod
//                                                      (getItemShapeDesc), so figurines -- equally
//                                                      mute before this wave -- now speak too.
//   item_slabst        description = `memorial`     -> SHIPPED. And a BUILT slab
//                                                      (building_slabst, df.building.xml:1524) is a
//                                                      building_actual with a contained item exactly
//                                                      like a statue, so building_art() gives a
//                                                      memorial slab its engraved text with no extra
//                                                      code. Verified structurally, NOT live.
//   item_bookst        title       = `title_string` -> already handled pre-B246 (getBookTitle).
//
//   df::engraving      no persisted sentence        -> SHIPPED from DF's element/property/reference
//                                                      formatter vmethods + native outer templates.
//   itemimprovement_art_imagest   NO TEXT FIELD     -> GAP, REGISTERED, NOT FIXED HERE. Decorated
//                                                      /masterwork items carry an art_image REF but
//                                                      no stored prose, exactly like an engraving --
//                                                      DF composes "On the item is an image of..."
//                                                      at display time. Same blocker, same honest
//                                                      answer, and the same native capture unblocks
//                                                      both. Out of scope for B246; not silently
//                                                      papered over.
// ================================================================================================

check("AUDIT: figurines keep the DF vmethod; statues and slabs use their concrete storage", () => {
  assert.ok(/getItemShapeDesc\(\)/.test(artCpp), "figurines retain DF's generic art-string vmethod");
  assert.ok(/item_statuest/.test(artCpp), "statues resolve their concrete subject + image pair");
  assert.ok(/item_slabst/.test(artCpp), "slabs: DF's `memorial` field, which is NOT an art_string");
  assert.ok(/art_desc\.h/.test(fs.readFileSync(path.join(root, "src/building_zone.h"), "utf8")),
    "and /building-info reaches all of them through the one shared module");
});

check("AUDIT: engraving formatting and the remaining decorated-item gap are documented", () => {
  assert.ok(/general_ref::getDescription/.test(artH),
    "engraving prose documents DF's reference formatter vmethod");
  assert.ok(/art_image_chunk/.test(artH),
    "and the art_image path is documented for whoever picks up decorated-item prose next");
});

console.log(failed ? `\n${failed} FAILED` : "\nall B246 art-description checks passed");
process.exit(failed ? 1 : 0);
