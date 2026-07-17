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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = relative => readFileSync(join(root, relative), "utf8");

const workshop = read("web/js/dwf-building-zone-stockpile-panels.js");
const css = read("web/css/dwf.css");
const controls = read("web/js/dwf-controls-placement.js");
const notifications = read("web/js/dwf-unit-hud-notifications.js");
const stockPanels = read("web/js/dwf-build-info-panels.js");
const unitCycle = read("web/js/dwf-unitcycle.js");
const interaction = read("src/interaction.cpp");
const infoPanel = read("src/info_panel.cpp");
// B212: /unit-nickname lives in register_unit_routes (src/unit_sheet.cpp) now.
const httpServer = read("src/unit_sheet.cpp");
const buildingZone = read("src/building_zone.cpp");
const kitchenPanel = read("src/kitchen_panel.cpp");
const tradeDepot = read("src/trade_depot.cpp");
const unitSheet = read("src/unit_sheet.cpp");

assert.match(workshop, /workshop-task-list/, "B41 task list has its own scroll class");
// B41 -> B174: the task list stays internally scrollable; its height bound now lives in the
// B167 dormant-framework cap (`:not(.pf-fill-scroll)`), and the B41 contents FOOTER is retired
// entirely (B174-1 oracle: contents render at the bottom of the Tasks tab in .ws-contents,
// itself height-bounded + scrollable).
assert.match(css, /\.workshop-task-list\s*\{[\s\S]*?overflow:\s*auto;/,
  "B41/B174 task list is internally scrollable");
assert.match(css, /\.workshop-task-list:not\(\.pf-fill-scroll\)\s*\{\s*max-height:/,
  "B41/B167 task list keeps its dormant height bound");
assert.match(css, /\.ws-contents\s*\{[\s\S]*?max-height:[\s\S]*?overflow-y:\s*auto;/,
  "B174 contents section (footer's successor) is height bounded and scrollable");
assert.match(controls, /function zoneSelectClick[\s\S]*?zonePalette\.style\.display = "none";[\s\S]*?openZonePanel\(/,
  "B42 hides the create palette before opening the selected-zone panel");
assert.match(notifications, /function leftUiDodgeX\(popupWidth\)[\s\S]*?"selection"/,
  "B47a considers selected-zone UI when positioning alert bubbles");
assert.match(notifications, /const popupWidth = alertPopup\.offsetWidth \|\| 520;[\s\S]*?leftUiDodgeX\(popupWidth\)/,
  "B47a measures the bubble before applying the dodge");
assert.match(stockPanels, /DwfWireV1\.formatItemName\(item\.name \|\| "", item\)/,
  "B05/B24 stocks rows use the decoded quality-family text formatter");
assert.match(buildingZone, /item_display_name\(item, 0, true\)/,
  "B05/B24/B123 cage/building contents keep decorations and growth identity");
assert.match(kitchenPanel, /item_display_name\(item, 0, true\)/,
  "B05/B24/B123 kitchen rows keep decorations and growth identity");
assert.match(tradeDepot, /item_display_name\(item, 0, true\)/,
  "B05/B24/B123 trade rows keep decorations and growth identity");
assert.match(unitSheet, /item_display_name\(inv->item, 0, true\)/,
  "B05/B24/B123 unit inventory rows keep decorations and growth identity");
assert.match(unitCycle, /Array\.isArray\(data\.unitCycle\)[\s\S]*?data\.unitCycle/,
  "WT08 uses the server's exact-tile-first click-resolution candidates");
assert.match(unitCycle, /switchTo\(units\[ni\]\.id, units\)/,
  "WT08 preserves the candidate set while fetching the next unit sheet");
assert.match(interaction, /find_units_for_tile_click[\s\S]*?if \(!exact\.empty\(\)\)[\s\S]*?return exact;[\s\S]*?std::sort\(fallback\.begin\(\)/,
  "B49 resolves exact-tile units before deterministically ordered 3x3 fallback units");
assert.match(interaction, /\\\"unitCycle\\\"/,
  "WT08 inspect response carries the resolved candidate ids");
assert.match(notifications, /data-unit-nickname(?! disabled)[\s\S]*?unit-nickname-editor[\s\S]*?status\.textContent/,
  "B7 enables a bounded DOM-built nickname editor with textContent status updates");
assert.match(infoPanel, /set_unit_nickname_on_render_thread[\s\S]*?unit->name\.nickname/,
  "B7 writes only df::unit::name.nickname on the render thread");
assert.match(httpServer, /server\.Post\("\/unit-nickname", unit_nickname_handler\)/,
  "B7 exposes the nickname mutation as POST /unit-nickname");

console.log("small_ui_wavec_test: PASS");
