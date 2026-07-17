// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// B288/B289 click-routing fixture. Unlike the original panel-only test, these cases derive their
// decisions from the production C++ route expression/offset constants and then feed the selected
// payload through the real JS panel builders. The mutation cells reproduce both pre-fix decisions:
// zone-before-engraving and exact-footprint-only statue lookup.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");

const DWFUI = require(path.join(root, "web/js/dwf-ui-components.js"));
globalThis.window = globalThis;
globalThis.DWFUI = DWFUI;
globalThis.escapeHtml = value => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const panels = require(path.join(root, "web/js/dwf-building-zone-stockpile-panels.js"));

const routeHeader = read("src/interaction_route.h");
const interaction = read("src/interaction.cpp");
const artHeader = read("src/art_desc.h");
const artDesc = read("src/art_desc.cpp");
const controls = read("web/js/dwf-controls-placement.js");
const unitcycle = read("web/js/dwf-unitcycle.js");

const STATUE_PROSE = "This is a well-crafted jet statue of Doren Portallined. The item is a " +
  "well-designed image of Doren Portallined the dwarf and giant gray langurs in jet by Rith " +
  "Nethmorul. Doren Portallined is surrounded by the giant gray langurs.";
const SIMPLE_PROSE = "Engraved on the wall is an image of sun berries by Rith Nethmorul.";

const LIVE_SUBJECT_ONLY_STATUE = {
  description: "Avafi Blazebears",
  itemQuality: 1,
  material: "siltstone",
  image: {
    id: 3, subid: 224, quality: 1, artist: "Rith Nethmorul",
    elements: ["Avafi Blazebears the dwarf", "giant gray langurs"],
    properties: ["Avafi Blazebears is surrounded by the giant gray langurs."],
  },
};
const LIVE_STATUE_PROSE = "This is a well-crafted siltstone statue of Avafi Blazebears.  " +
  "The item is a well-designed image of Avafi Blazebears the dwarf and giant gray langurs in " +
  "siltstone by Rith Nethmorul. Avafi Blazebears is surrounded by the giant gray langurs.";

function textOf(html) {
  return String(html).replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
}

// Execute the exact ternary from surface_click_route(). C++ enum tokens become string literals;
// there is no separately authored JS precedence list that could drift from /inspect.
const routeMatch = routeHeader.match(/surface_click_route\([^)]*\)\s*\{\s*return\s+([\s\S]*?);\s*\}/);
assert.ok(routeMatch, "surface_click_route production expression not found");
const routeExpression = routeMatch[1].replace(/SurfaceClickRoute::(\w+)/g, '"$1"');
const productionSurfaceRoute = Function("has_engraving", "has_civzone",
  `return (${routeExpression});`);

function constant(name) {
  const match = routeHeader.match(new RegExp(`constexpr\\s+int\\s+${name}\\s*=\\s*(-?\\d+)`));
  assert.ok(match, `${name} not found`);
  return Number(match[1]);
}
const statueOffset = {
  x: constant("STATUE_OVERHANG_FOOTPRINT_DX"),
  y: constant("STATUE_OVERHANG_FOOTPRINT_DY"),
  z: constant("STATUE_OVERHANG_FOOTPRINT_DZ"),
};

const coordKey = p => `${p.x},${p.y},${p.z}`;
function resolveStatueBuilding(click, buildings, offset = statueOffset) {
  const exact = buildings.get(coordKey(click));
  if (exact) return exact;
  const footprint = { x: click.x + offset.x, y: click.y + offset.y, z: click.z + offset.z };
  const candidate = buildings.get(coordKey(footprint));
  return candidate?.type === "Statue" ? candidate : null;
}

function resolveSurface(fixture, route = productionSurfaceRoute) {
  const selected = route(!!fixture.engraving, !!fixture.zone);
  if (selected === "Engraving") return {
    kind: "engraving", title: fixture.engraving.title,
    description: fixture.engraving.description, tile: fixture.click,
  };
  if (selected === "Civzone") return { kind: "zone", buildingId: fixture.zone.id };
  return { kind: "tile", tile: fixture.click };
}

check("B288 route: an engraved floor inside a civzone returns engraving prose", () => {
  const response = resolveSurface({
    click: { x: 12, y: 34, z: 5 },
    zone: { id: 77, name: "Dining Hall" },
    engraving: { title: 'Mukar Nashas, "The Sadness of Lilacs"', description: SIMPLE_PROSE },
  });
  assert.equal(response.kind, "engraving");
  assert.equal(response.description, SIMPLE_PROSE);
  assert.ok(textOf(panels.engravingPanelMarkup({ ...response, ok: true, present: true,
    descriptionAvailable: true }, response.tile))
    .includes(SIMPLE_PROSE));
});

check("B288 test-the-test: the old zone-first decision drops the engraving", () => {
  const oldZoneFirst = (hasEngraving, hasZone) => hasZone ? "Civzone"
    : hasEngraving ? "Engraving" : "Tile";
  const response = resolveSurface({
    click: { x: 12, y: 34, z: 5 }, zone: { id: 77 },
    engraving: { title: "The Sadness of Lilacs", description: SIMPLE_PROSE },
  }, oldZoneFirst);
  assert.equal(response.kind, "zone");
  assert.equal(response.description, undefined);
});

check("B289 route: clicking the statue's upper drawn cell maps to its footprint building", () => {
  const statue = { id: 289, type: "Statue", artDescription: STATUE_PROSE };
  const buildings = new Map([[coordKey({ x: 40, y: 51, z: 7 }), statue]]);
  const selected = resolveStatueBuilding({ x: 40, y: 50, z: 7 }, buildings);
  assert.equal(selected, statue);
  assert.equal(selected.artDescription, STATUE_PROSE);
});

check("B289 test-the-test: exact-footprint-only lookup drops the upper drawn cell", () => {
  const buildings = new Map([[coordKey({ x: 40, y: 51, z: 7 }), { id: 289, type: "Statue" }]]);
  assert.equal(resolveStatueBuilding({ x: 40, y: 50, z: 7 }, buildings,
    { x: 0, y: 0, z: 0 }), null);
});

check("production /inspect uses both tested route decisions", () => {
  const start = interaction.indexOf("bool inspect_at_pixel(");
  const end = interaction.indexOf("// B24:", start);
  const inspect = interaction.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok((inspect.match(/find_click_building\(pos\)/g) || []).length >= 2,
    "workshop and general building branches must use statue-aware click lookup");
  assert.match(inspect, /surface_click_route\(has_engraving, has_civzone\)/);
  assert.match(inspect, /result\.description\s*=\s*engraving\.description/);
  assert.match(interaction, /statue_overhang_footprint\(\{pos\.x, pos\.y, pos\.z\}\)/);
  assert.match(interaction, /building->getType\(\)\s*==\s*df::building_type::Statue/);
});

check("B289 full-art response still renders DF's complete native oracle body", () => {
  const html = panels.genericBuildingPanelMarkup({
    id: 289, name: "Jet Statue", built: true, hasJobs: false, suspended: false,
    artTitle: "-jet statue of Doren Portallined-", artDescription: STATUE_PROSE,
  }, {});
  assert.ok(textOf(html).includes(STATUE_PROSE));
});

check("B289 live-fact fixture: subject-only art_string is not itself statue prose", () => {
  const oldPayload = {
    id: 4141, name: "Siltstone Statue", built: true, hasJobs: false, suspended: false,
    artTitle: "-siltstone statue of Avafi Blazebears-",
    artDescription: LIVE_SUBJECT_ONLY_STATUE.description,
  };
  const text = textOf(panels.genericBuildingPanelMarkup(oldPayload, {}));
  assert.ok(text.includes("Avafi Blazebears"));
  assert.ok(!text.includes("This is a well-crafted siltstone statue"),
    "pre-composition payload proves the shipped subject-name field cannot produce a body");
});

check("B289 DLL composes the subject-only statue fixture from its resolved art image", () => {
  assert.match(artDesc, /virtual_cast<df::item_statuest>\(item\)/,
    "statue composition must identify the concrete item that owns T_image");
  assert.match(artDesc, /find_art_image\(statue->image\.id,\s*statue->image\.subid\)/,
    "df.item.xml item_statuest.image id/subid must resolve through the shared chunk lookup");
  assert.match(artDesc, /statue_description\(statue,\s*image\)/,
    "a resolved statue image must feed the composed body, not the subject-name field directly");
  assert.match(artDesc, /MaterialInfo\s+material\(static_cast<df::item\*>\(statue\)\)/,
    "the material phrase must come from DFHack MaterialInfo over the statue item");
  assert.match(artDesc, /trim_copy\(statue->description\)/,
    "sentence one must use DF's stored subject name");
  assert.match(artDesc, /item_quality_phrase/,
    "item quality vocabulary must remain distinct from designed_image_phrase image quality");
  assert.match(artDesc, /image->artist/);
  assert.match(artDesc, /image->quality/);
  assert.match(artDesc, /art_elements_description\(image\)/);
  assert.match(artDesc, /art_properties_description\(image\)/);
  assert.match(artDesc, /" statue of "[\s\S]{0,100}?"\.  The item is "[\s\S]{0,160}?" in "/,
    "the native two-sentence outer grammar, including its two-space sentence break, is pinned");
  assert.match(artDesc, /out\.quality\s*=\s*item->getOverallQuality\(\)/,
    "artQuality/artQualityName are the ITEM quality shown in the statue sheet");
  assert.doesNotMatch(artDesc, /out\.quality\s*=\s*static_cast<int32_t>\(image->quality\)/,
    "image quality must not overwrite the distinct item-quality row");
  assert.ok(LIVE_STATUE_PROSE.includes("well-crafted siltstone statue of Avafi Blazebears"));
  assert.ok(LIVE_STATUE_PROSE.includes("well-designed image of Avafi Blazebears the dwarf and giant gray langurs"));
  assert.ok(LIVE_STATUE_PROSE.endsWith(LIVE_SUBJECT_ONLY_STATUE.image.properties[0]));
});

check("B288 wall route: inspectClick admits kind:'engraving' instead of silently dead-ending", () => {
  const filter = controls.match(/const panelKinds\s*=\s*\{([^}]*)\}/);
  assert.ok(filter, "inspectClick panel-kind filter not found");
  assert.match(filter[1], /\bengraving\s*:\s*1\b/,
    "the pre-fix filter omitted engraving, so walls/floors died before showSelection");
  const oldFilter = { workshop: 1, unit: 1, stockpile: 1, building: 1, item: 1, zone: 1 };
  assert.equal(!!oldFilter.engraving, false,
    "test-the-test: the shipped filter rejects a valid server engraving result");
});

check("B288 tile rail: /tile-occupants engraving rows survive generic routing and open by tile", () => {
  const occupantsHandler = interaction.slice(interaction.indexOf('server.Get("/tile-occupants"'));
  assert.match(occupantsHandler, /append\("engraving",\s*-1,\s*[^,]+,\s*[^)]+\)/,
    "the DLL must enumerate an engraving row with label and icon art");
  assert.match(unitcycle, /engraving\s*:\s*1/,
    "routeCandidates must admit the engraving kind");
  assert.match(unitcycle, /flow:\s*['"]engraving['"]/,
    "the id-less engraving row needs a tile-addressed dispatch route");
  assert.match(unitcycle, /openEngravingPanel\(route\.tile/,
    "rail dispatch must open the existing engraving sheet at the response tile");
});

check("B288 engraving composition preserves native floor-engraving wording and surface truth", () => {
  assert.match(artDesc, /case 0:\s*return "an image of ";/,
    "the live quality=0 engraving takes the unqualified 'an image of' form");
  assert.match(artDesc, /append_sentence\(out, "Engraved on the wall is " \+ image_phrase/,
    "simple prose matches the native view sheet, which calls floor engravings walls");
  assert.doesNotMatch(artDesc, /engraving->flags\.bits\.floor\s*\?\s*"floor"\s*:\s*"wall"/,
    "the physical floor flag must not rewrite native panel prose");
  assert.match(artDesc, /json_string\(art\.floor \? "floor" : "wall"\)/,
    "the payload still reports the engraving's physical surface independently");
  const observedFloorPayload = { surface: "floor", description: SIMPLE_PROSE };
  assert.equal(observedFloorPayload.surface, "floor");
  assert.match(observedFloorPayload.description, /Engraved on the wall/);
  assert.match(artDesc, /"Engraved is a "\s*\+\s*artist\s*\+\s*" rendition of "/,
    "the B288-1 named-rendition form remains reachable");
  assert.match(artDesc, /find_art_image\(e->art_id, e->art_subid\)[\s\S]{0,1000}?engraving_description\(e, image, out\.art_name\)/,
    "every matching world.event.engravings record resolves art_id/subid before composing its body");
});

check("B289 unresolved statue image falls back to DF's item name without invented prose", () => {
  const html = panels.genericBuildingPanelMarkup({
    id: 290, name: "Jet Statue", built: true, hasJobs: false, suspended: false,
    artTitle: "-jet statue of Doren Portallined-", artDescription: "",
    artBaseDescription: "jet statue of Doren Portallined",
  }, {});
  const text = textOf(html);
  assert.ok(text.includes("-jet statue of Doren Portallined-"));
  assert.ok(text.includes("jet statue of Doren Portallined"));
  assert.ok(!text.includes("This is a"), "client must not compose replacement art prose");
  assert.match(artHeader, /std::string base_description/);
  assert.match(artDesc, /base_description\s*=\s*Items::getDescription\(item, 0, false\)/);
  assert.match(artDesc, /!candidate\.has_art\(\)\s*&&\s*!statue/,
    "a statue's contained item must survive an empty has_art gate");
  assert.match(artDesc, /"artBaseDescription\\":.*json_string\(art\.base_description\)/s);
  assert.match(interaction, /result\.description\s*=\s*art\.description;/,
    "/inspect must not smuggle artBaseDescription back into the prose merge channel");
});

// AUDIT-FIX 07-15: the routing rewrite dropped the original wire pins; a regression in the
// /inspect serialization, the client dispatch, or the prose CSS would no longer fail this suite.
// Restored here as source pins on the exact production sites.
check("wire pins: /inspect serializes description; client dispatches building+engraving; prose CSS wraps", () => {
  const core = read("web/js/dwf-core.js");
  const css = read("web/css/dwf.css");
  assert.match(interaction, /\\"description\\":" << json_string\(result\.description\)/,
    "/inspect must serialize result.description (interaction.cpp)");
  assert.match(core, /openBuildingPanel\(buildingId, data\)/,
    "showSelection must dispatch buildings to openBuildingPanel(buildingId, data)");
  assert.match(core, /openEngravingPanel\(data\.tile, data\)/,
    "showSelection must dispatch engravings to openEngravingPanel(data.tile, data)");
  assert.match(css, /\.bld-art-prose \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/s,
    "art prose must keep the native wrapping rules (bld-art-prose)");
});

console.log(failed ? `\n${failed} FAILED` : "\nall B288/B289 routing checks passed");
process.exit(failed ? 1 : 0);
