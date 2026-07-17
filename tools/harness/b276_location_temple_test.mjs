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
// SPDX-License-Identifier: AGPL-3.0-only

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const panelPath = join(root, "web", "js", "dwf-location-panel.js");
const panelSrc = readFileSync(panelPath, "utf8");
const hospitalSrc = readFileSync(join(root, "web", "js", "dwf-hospital-panel.js"), "utf8");
const zoneSrc = readFileSync(join(root, "web", "js", "dwf-building-zone-stockpile-panels.js"), "utf8");
const cpp = readFileSync(join(root, "src", "building_zone.cpp"), "utf8");
const bridge = readFileSync(join(root, "src", "lua_bridge.cpp"), "utf8");
const map = JSON.parse(readFileSync(join(root, "web", "interface_map.json"), "utf8"));

globalThis.DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
const M = require(panelPath);
let passed = 0, failed = 0;
function check(name, ok) {
  console.log(`  ${ok ? "ok" : "FAIL"} - ${name}`);
  ok ? passed++ : failed++;
}
function inOrder(haystack, needles) {
  let at = -1;
  for (const needle of needles) {
    at = haystack.indexOf(needle, at + 1);
    if (at < 0) return false;
  }
  return true;
}

const accessTokens = ["VISITORS", "RESIDENTS", "CITIZENS", "MEMBERS"]
  .flatMap(k => [`LOCATION_PERMISSION_ON_${k}`, `LOCATION_PERMISSION_OFF_${k}`]);
check("all eight native access-state sprite cells exist", accessTokens.every(k => map[k]));

const temple = {
  id: 7, kind: "temple", label: "Temple", name: "The Ageless Rampage",
  restriction: "visitors", tier: 0, value: 730,
  occupancy: { inhabitants: 12 }, zones: [], candidates: [], positions: [],
  occupations: [{ id: -1, typeKey: "PERFORMER", label: "Performer", holder: "", assigned: false, verified: false }],
  temple: { mode: "none", id: -1, dedicated: false, name: "", options: [] }, guild: null, rooms: null,
  native: {
    accessMode: "visitors", guards: { locationAccess: true, locationInstruments: true },
    tierName: "Shrine", nextValue: 2000,
    countInstruments: 0, desiredInstruments: 5, danceFloorKnown: false,
    worshippersVerified: false, chestsVerified: false,
  },
};
const html = M.locationPanelMarkup({ data: temple });
check("four access icons render with the native token family",
  /LOCATION_PERMISSION_ON_VISITORS/.test(html) && ["RESIDENTS", "CITIZENS", "MEMBERS"].every(k => html.includes(`LOCATION_PERMISSION_OFF_${k}`)));
check("only the one captured access-result label is rendered", /All visitors welcome/.test(html) &&
  !/Long-term residents welcome|Fortress citizens only|Members only/.test(panelSrc));
check("native header uses DF's exact dedication words", /ZONE_TEMPLE/.test(html) && /No particular deity/.test(html) && !/Dedicated to/.test(html));
check("tier uses the observed value/threshold and includes DF's value glyph", /Shrine, 36% \(next at 2000☼\)/.test(html));
check("unverified worshipper/chest derivations do not render as native counts",
  /Worshippers: unavailable/.test(html) && /Chests in common area: unavailable/.test(html) &&
  !/12 worshippers|Chests in common area: 0/.test(html));
check("stored/desired instruments use DF's exact `0 (5)` format", /data-dwfui-bitmap-text="0 \(5\)"/.test(html));
check("instrument adjustment uses DWFUI's native-art stepper", /dwfui-stepper--native-art/.test(html) && /data-loc-instruments/.test(html));
check("dance-floor absence remains explicit instead of deriving zone dimensions", /Dance floor in common area: unavailable/.test(html));
check("Performer row keeps the assign affordance visibly fail-closed", /Performer/.test(html) && /dwfui-plaque[^>]*disabled/.test(html) && /Assign/.test(html));
check("temple row order matches ZONE-TEMPLE-SHRINE-native.png", inOrder(html, [
  "ZONE_TEMPLE", "The Ageless Rampage", "Shrine", "No particular deity",
  "LOCATION_PERMISSION_ON_VISITORS", "All visitors welcome", "Shrine, 36% (next at 2000☼)",
  "Worshippers: unavailable", "Chests in common area: unavailable", "Stored Instruments (Desired):",
  "0 (5)", "Dance floor in common area: unavailable", "LOCATION_OCCUPATION_PERFORMER", "Performer",
]));
check("temple view does not append generic location sections absent from the oracle",
  !/zone-section-label[^>]*>Occupants|zone-section-label[^>]*>Occupations|zone-section-label[^>]*>Dedication/.test(html) &&
  !/No zones attached|Dedicated to/.test(html) && !/data-loc-act="deity-toggle"/.test(html));

const partialHtml = M.locationPanelMarkup({ data: {
  id: 7, kind: "temple", label: "Temple", name: "The Ageless Rampage", temple: { mode: "none" },
} });
check("partial temple response marks every absent mechanic unavailable instead of manufacturing zeroes",
  /Access unavailable/.test(partialHtml) && /Temple tier\/value: unavailable/.test(partialHtml) &&
  /Worshippers: unavailable/.test(partialHtml) && /Chests in common area: unavailable/.test(partialHtml) &&
  /Stored Instruments \(Desired\): unavailable/.test(partialHtml) &&
  /Dance floor in common area: unavailable/.test(partialHtml) && /Performer/.test(partialHtml) && /unavailable/.test(partialHtml) &&
  !/Shrine, 100%|Chests in common area: 0|Stored Instruments \(Desired\): 0/.test(partialHtml));
check("access and instrument actions are wired through one guarded native route", /\/location-native-action\?id=/.test(panelSrc) && /action=access/.test(panelSrc) && /action=instruments/.test(panelSrc));
check("hospital and zone-location surfaces reuse the shared four-icon access component",
  /DFLocationMarkup\.locationAccessHtml/.test(hospitalSrc) && /DFLocationMarkup\.locationAccessHtml/.test(zoneSrc));
check("the old unguarded three-choice restrict control is retired",
  !/dataAttr: "zone-location-restrict"/.test(zoneSrc) && !/action=restrict&location=/.test(zoneSrc));
check("C++ reads live difficulty thresholds and exact location content fields",
  /custom_difficulty/.test(cpp) && /difficulty\.temple_value/.test(cpp) && /difficulty\.temple_complex_value/.test(cpp) &&
  /count_instruments/.test(cpp) && /desired_instruments/.test(cpp));
check("C++ explicitly refuses to promote unverified worshipper/chest interpretations to observations",
  /worshippersVerified\\\":false,\\\"chestsVerified\\\":false/.test(cpp) &&
  !/countChests/.test(cpp) && !/getType\(\) == df::item_type::BOX/.test(cpp));
check("C++ models all four flag combinations", /VISITORS_ALLOWED/.test(cpp) && /NON_CITIZENS_ALLOWED/.test(cpp) && /MEMBERS_ONLY/.test(cpp));
check("writes fail closed through dfcapture-hostwrites.json", /hostwrite_flag_enabled_via_lua/.test(cpp) && /call_lua\("hw_flags"/.test(bridge));
check("dance floor is not fabricated from zone bounds", /danceFloorKnown/.test(cpp) && !/danceFloorWidth\s*=\s*zone->/.test(cpp));
check("no raw button was added to the location module", !/<button/.test(panelSrc));

console.log(`\nB276 location/temple: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
