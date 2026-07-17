// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// b217_zoneparity2_test.mjs -- B217 round 2: the zone panel family matches the NATIVE arrangement.
//
// Oracles (all native captures in this repo):
//   * tools/orchestrator/attachments/B217-2.png                  pen/pasture zone panel
//   * tools/orchestrator/attachments/captures/Z12/Z12-jt-1.png   bedroom zone panel + palette
//   * tools/orchestrator/attachments/captures/Z12/Z12-jt-3.png   bedroom with owner assigned
//   * tools/orchestrator/attachments/captures/Z12/Z12-jt-5.png   pen assign-animals chooser (assigned rows)
//   * tools/orchestrator/attachments/B152-1.png                  pen assign-animals chooser (unassigned rows)
//   * tools/orchestrator/attachments/captures/Z11/Z11-caedan-19/20/21.png  gather-fruit panel + option tooltips
//   * tools/orchestrator/attachments/LEVER-LINK-1/3.png          meeting hall + location pair + tooltips
//   * "Menu Oracle Screenshots/barracks zone .png"               barracks panel (squad-list tile in the rail)
//
// The native grammar those captures pin, top to bottom:
//   row 1  name input (black field, silver border) + quill tile flush right      -- NO close X anywhere
//   row 2  [type icon in a gold box] [type label] ......... [repaint][suspend][remove] butted, flush right
//   left   owner row (portrait + readable name) when an owner is assigned
//   rail   right-aligned column under the tool cluster: per-type option latches (gather: tree,shrub,fallen),
//          then the per-type assign tile (rabbit+ / dwarf+ / squad flag+), then -- pinned to the panel's
//          bottom-right -- the location pair (shield+ assign, shield-magnifier details when attached).
//   chooser  sort bar on top, portrait rows with [assign-arrow tile when assigned][check tile], search footer,
//            back = the native gold left arrow, never a text button.
//
//   node tools/harness/b217_zoneparity2_test.mjs

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
// Same Node bootstrap as ui_lab_test.mjs: the module reads these browser globals at render time.
globalThis.escapeHtml = value => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const DWFUI = require(path.join(root, "web/js/dwf-ui-components.js"));
globalThis.DWFUI = DWFUI;
globalThis.window = globalThis;
globalThis.document = { readyState: "loading", querySelectorAll: () => [], getElementById: () => null, addEventListener: () => {} };
globalThis.addEventListener = () => {};
globalThis.unitImagesEnabled = false;
const clientPath = path.join(root, "web/js/dwf-building-zone-stockpile-panels.js");
const clientSource = fs.readFileSync(clientPath, "utf8");
const client = require(clientPath);
const css = fs.readFileSync(path.join(root, "web/css/dwf.css"), "utf8");
const coreSource = fs.readFileSync(path.join(root, "web/js/dwf-core.js"), "utf8");
const shellSource = fs.readFileSync(path.join(root, "web/js/dwf-control-shell.js"), "utf8");

let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}`); }
}
// "a appears before b" -- the oracle pins ORDER, not just presence.
function before(html, a, b) {
  const ia = html.indexOf(a), ib = html.indexOf(b);
  return ia >= 0 && ib >= 0 && ia < ib;
}

const zonePanelMarkup = client.zonePanelMarkup;
check("zonePanelMarkup is exported for fixtures", typeof zonePanelMarkup === "function");

// ---- 1. pen/pasture (B217-2: the reopened bug's own oracle) -----------------------------------
const pen = zonePanelMarkup({
  id: 5, name: "Activity Zone #3", type: "Pen", active: true, isPen: true,
  assignedUnits: 6, canLocation: true, location: { id: -1 }, owner: {},
}, {});

console.log("# pen/pasture panel vs B217-2");
check("row 1 is a name input, not a title span", /zone-name-input/.test(pen));
check("unnamed pen placeholder matches native ('Unnamed pen/pasture')",
  /placeholder="Unnamed pen\/pasture"/.test(pen));
check("the quill rename tile sits at the end of the name row (HAULING_RENAME_ROUTE)",
  before(pen, "zone-name-input", "HAULING_RENAME_ROUTE"));
check("NO close X: native zone panels have none (ESC / map click dismiss)",
  !/bld-x/.test(pen) && !/&#10005;/.test(pen));
check("type row leads with the zone-type icon in its box", /zone-type-icon/.test(pen) && /ZONE_PEN/.test(pen));
check("type label is native's 'Pen/Pasture' (no spaced slashes)",
  /Pen\/Pasture/.test(pen) && !/Pen \/ Pasture/.test(pen));
check("tool cluster order is repaint, suspend, remove (left to right)",
  before(pen, "ZONE_REPAINT", "ZONE_SUSPEND_INACTIVE") && before(pen, "ZONE_SUSPEND_INACTIVE", "ZONE_REMOVE_EXISTING"));
check("cluster tiles live in one .zone-core-tools strip on the type row",
  /zone-core-tools/.test(pen) && before(pen, "zone-type-icon", "zone-core-tools"));
check("active zone shows the gold-framed suspend tile and dispatches 'disable'",
  /ZONE_SUSPEND_INACTIVE/.test(pen) && /data-zone-act="disable"/.test(pen));
check("remove is the circle-slash tile in the cluster, not a bottom stray",
  /data-zone-act="remove"/.test(pen) && before(pen, "ZONE_REMOVE_EXISTING", "zone-rail"));
check("repaint is the paintbrush+ tile (keeps the data-zone-repaint wire)",
  /ZONE_REPAINT/.test(pen) && /data-zone-repaint/.test(pen));
check("assign-animals is the rabbit+ rail tile with the count folded into its tooltip",
  /ZONE_PICK_ANIMALS/.test(pen) && /data-zone-units/.test(pen) && /6 assigned/.test(pen));
check("location assign is the shield+ tile, below the per-type tile",
  /ZONE_LOCATION_ASSIGN/.test(pen) && before(pen, "ZONE_PICK_ANIMALS", "ZONE_LOCATION_ASSIGN"));
check("location assign carries native's own tooltip copy (LEVER-LINK-3)",
  /Assign a new or existing location to this zone\./.test(pen));
check("no location attached -> no details magnifier", !/ZONE_LOCATION_DETAILS/.test(pen));
check("no web text buttons remain in the info panel (native has none)", !/bld-btn/.test(pen));
check("no green status line: native shows no 'N assigned' row", !/bld-status/.test(pen));

// ---- 2. bedroom with an owner (Z12-jt-1 / Z12-jt-3) -------------------------------------------
console.log("\n# bedroom panel vs Z12-jt-1/3");
const bedroom = zonePanelMarkup({
  id: 7, name: "Activity Zone #9", type: "Bedroom", active: true,
  canOwner: true, owner: { id: 12, name: "Ast Durmedtob, Farmer" },
  canLocation: true, location: { id: -1 },
}, {});
check("unnamed bedroom placeholder matches native", /placeholder="Unnamed bedroom"/.test(bedroom));
check("assign-owner is the dwarf+ rail tile (ZONE_ASSIGN_UNIT)",
  /ZONE_ASSIGN_UNIT/.test(bedroom) && /data-zone-owner/.test(bedroom));
check("assigned owner renders as a left-hand owner row with the readable name",
  /zone-owner-row/.test(bedroom) && /Ast Durmedtob, Farmer/.test(bedroom));
check("owner row sits left of the rail (native puts it under the type row)",
  before(bedroom, "zone-owner-row", "zone-rail"));

// ---- 3. gather fruit options (Z11-caedan-19/20/21) --------------------------------------------
console.log("\n# gather-fruit options vs Z11-19/20/21");
const gather = zonePanelMarkup({
  id: 9, name: "Activity Zone #2", type: "PlantGathering", active: true,
  isGather: true, gather: { trees: true, shrubs: true, fallen: true },
  canLocation: true, location: { id: -1 },
}, {});
check("gather latch order matches native: trees, shrubs, fallen",
  before(gather, "ZONE_GATHER_TREE_ACTIVE", "ZONE_GATHER_SHRUB_ACTIVE") &&
  before(gather, "ZONE_GATHER_SHRUB_ACTIVE", "ZONE_GATHER_FALLEN_ACTIVE"));
check("tree tooltip is native's own copy",
  gather.includes("Gather fruit in trees in and just above this zone. Requires a stepladder."));
check("shrub tooltip is native's own copy",
  gather.includes("Gather fruit and vegetables from shrubs in this zone."));
check("fallen tooltip is native's own copy",
  gather.includes("Gather fallen fruit in this zone."));
check("gather latches live in the rail under the cluster",
  before(gather, "zone-core-tools", "ZONE_GATHER_TREE_ACTIVE") &&
  before(gather, "zone-rail", "ZONE_GATHER_TREE_ACTIVE"));
check("unnamed gather placeholder matches native ('Unnamed plant gathering area')",
  /placeholder="Unnamed plant gathering area"/.test(gather));

// ---- 4. location attached (LEVER-LINK-1, Z13-caedan-3) ----------------------------------------
console.log("\n# attached location vs LEVER-LINK-1 / Z13-3");
const hall = zonePanelMarkup({
  id: 11, name: "Activity Zone #4", type: "MeetingHall", active: true,
  canLocation: true, location: { id: 3, name: "The Ageless Rampage", type: "Tavern" },
}, {});
check("type icon becomes the location icon (tavern mug)", /ZONE_TAVERN/.test(hall));
check("label shows the location name over its type, two lines",
  before(hall, "The Ageless Rampage", "Tavern") && /zone-type-sub/.test(hall));
check("details magnifier appears next to the shield+ when a location is attached",
  /ZONE_LOCATION_DETAILS/.test(hall) && before(hall, "ZONE_LOCATION_ASSIGN", "ZONE_LOCATION_DETAILS"));
check("details tooltip is native's own copy (LEVER-LINK-1)",
  hall.includes("Set details for the assigned location."));
check("unnamed meeting hall placeholder matches native", /placeholder="Unnamed meeting hall"/.test(hall));

// ---- 5. barracks (Menu Oracle Screenshots/barracks zone .png) ---------------------------------
console.log("\n# barracks panel vs the barracks oracle");
const barracks = zonePanelMarkup({
  id: 13, name: "Activity Zone #6", type: "Barracks", active: true,
  isBarracks: true, assignedSquads: 2, canLocation: true, location: { id: -1 },
}, {});
check("squad assignment is the flag+ rail tile (ZONE_SQUAD_LIST), not a wide text button",
  /ZONE_SQUAD_LIST/.test(barracks) && /data-zone-squads/.test(barracks) && !/zone-squad-launch/.test(barracks));
check("squad count remains reachable (tooltip carries '2 squads assigned')",
  /2 squads assigned/.test(barracks));
check("unnamed barracks placeholder matches native", /placeholder="Unnamed barracks"/.test(barracks));

// ---- 6. the assign-animals chooser (Z12-jt-5 / B152-1) ----------------------------------------
console.log("\n# assign-animals chooser vs Z12-jt-5 / B152-1");
const chooser = client.zoneAnimalsPanelMarkup({
  id: 5, name: "Activity Zone #3", type: "Pen",
  units: [
    { id: 21, name: "Dog (tame)", race: "DOG", sex: "male", assigned: true, flags: ["tame"], x: 1, y: 2, z: 3 },
    { id: 22, name: "Cat (tame)", race: "CAT", sex: "female", flags: ["tame"], x: 4, y: 5, z: 6 },
  ],
}, {});
check("no 'Back to zone' text button: back is the native gold left arrow",
  !/Back to zone<\/button>/.test(chooser) && /data-zone-back/.test(chooser) && /BUTTON_CLOSE_LEFT/.test(chooser));
check("no zone-type status line in the chooser", !/bld-status/.test(chooser));
check("assigned row carries the oracle-extracted assign-arrow tile",
  /--spa-zone-assign-arrow/.test(chooser) || /zoneAssignArrow/.test(chooser));
check("unassigned row keeps the empty locate slot so the check column stays aligned",
  /zone-animal-locate-slot/.test(chooser));
check("sort bar and footer search survive", /zone-animal-sortbar/.test(chooser) && /zone-animal-search/.test(chooser));
check("assigned rows keep the pressed check; unassigned keep the real empty tile",
  /aria-pressed="true"/.test(chooser) && /aria-pressed="false"/.test(chooser));

// the arrow art itself: baked from Z12-jt-5, declared like the other --spa-* oracle assets
check("the assign-arrow art is declared as --spa-zone-assign-arrow in :root",
  /--spa-zone-assign-arrow:\s*url\("data:image\/png;base64,/.test(css));
check("DWFUI exposes the arrow through TOKENS.art.zoneAssignArrow",
  DWFUI.TOKENS.art.zoneAssignArrow === "var(--spa-zone-assign-arrow)");

// ---- 7. owners / locations sub-panels (Z12-jt-2 grammar, client-side reachable half) ----------
console.log("\n# owners/locations panels vs Z12-jt-2");
check("owners panel renders the native sort header",
  /zone-owner-sortbar/.test(clientSource) && /data-zone-owner-sort/.test(clientSource));
check("'Remove assignment' is a top list row, not a red web button",
  /zone-owner-clear-row/.test(clientSource) && !/bld-btn danger" data-zone-owner-clear/.test(clientSource));
check("owner rows are click-to-assign rows (native chooser grammar), not text buttons",
  !/data-zone-owner-unit="\$\{Number\(u\.id\)\}">\$\{u\.assigned \? "Assigned" : "Assign"\}/.test(clientSource));
check("owners panel gains the native footer search", /zone-owner-search/.test(clientSource));
check("owners and locations panels use the native back arrow",
  (clientSource.match(/back: \{ dataset: \{ zoneBack: "" \}/g) || []).length >= 3);

// ---- 8. panel chrome: the zone family is close-less (ESC/native affordances only) -------------
console.log("\n# framework chrome");
check("zone-panel joins the ESC-only selection variants (no framework X, no generated bar)",
  /ESC_ONLY_SELECTION_VARIANTS = \[[^\]]*"zone-panel"/.test(coreSource));
check("the zone info panel body still scrolls on the DWFUI bar (round-1 fix kept)",
  /DWFUI\.scrollHtml\(\{ cls: "zone-info-body" \}/.test(clientSource));

// ---- 9. sprite vocabulary: complete native cells are self-framed ------------------------------
console.log("\n# DWFUI sprite vocabulary");
const repaintBtn = DWFUI.artBtnHtml({ sprite: "ZONE_REPAINT", title: "x" });
check("ZONE_REPAINT renders self-framed (no second gold box)", /data-dwfui-self-framed="true"/.test(repaintBtn));
const pickBtn = DWFUI.artBtnHtml({ sprite: "ZONE_PICK_ANIMALS", title: "x" });
check("ZONE_PICK_ANIMALS renders self-framed", /data-dwfui-self-framed="true"/.test(pickBtn));
const latch = DWFUI.latchHtml({ on: true, sprite: "ZONE_GATHER_TREE_INACTIVE", activeSprite: "ZONE_GATHER_TREE_ACTIVE" });
check("gather latch tiles render self-framed", /data-dwfui-self-framed="true"/.test(latch));
check("TOKENS.sprites names the zone cells (boot test then proves them against interface_map)",
  DWFUI.TOKENS.sprites.zoneRepaint === "ZONE_REPAINT" &&
  DWFUI.TOKENS.sprites.zonePickAnimals === "ZONE_PICK_ANIMALS" &&
  DWFUI.TOKENS.sprites.zoneLocationAssign === "ZONE_LOCATION_ASSIGN" &&
  DWFUI.TOKENS.sprites.zoneLocationDetails === "ZONE_LOCATION_DETAILS" &&
  DWFUI.TOKENS.sprites.zoneQuill === "HAULING_RENAME_ROUTE" &&
  DWFUI.TOKENS.sprites.zoneSquadList === "ZONE_SQUAD_LIST");

// ---- 10. layout CSS: the arrangement, not just the pieces -------------------------------------
console.log("\n# layout css");
check("name row is a grid of input + quill", /\.zone-head\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/.test(css));
check("type row is icon | label | cluster", /\.zone-type-row\s*\{[\s\S]*?grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/.test(css));
check("the rail is a right-aligned column", /\.zone-rail\s*\{[\s\S]*?align-items:\s*flex-end/.test(css));
check("the location row pins to the panel's bottom-right (margin-top auto)",
  /\.zone-rail-location\s*\{[\s\S]*?margin-top:\s*auto/.test(css));
check("cluster tiles butt together like native's shared frame", /\.zone-core-tools\s*\{[\s\S]*?display:\s*flex/.test(css));
check("palette icons get native's gold icon box", /\.zone-type-btn\s+\.zone-type-iconbox\s*\{[\s\S]*?border:\s*2px solid/.test(css));
check("palette rows reserve the native 40px box height", /\.zone-type-btn\s*\{[\s\S]*?min-height:\s*40px/.test(css));
check("palette icon markup asks for the boxed icon class", /zone-type-iconbox/.test(shellSource));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
