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
//
// B114 offline fixture: candidate fetch, rendered chooser, selected-id payload, generic
// fallback, and empty stock state. It validates its own omissions with seeded-bad variants.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const js = readFileSync(join(root, "web", "js", "dwf-build-info-panels.js"), "utf8");
const lua = readFileSync(join(root, "dwf.lua"), "utf8");
// B212: /place-candidates lives in register_placement_routes (src/placement.cpp) now.
const http = readFileSync(join(root, "src", "placement.cpp"), "utf8");
const bridge = readFileSync(join(root, "src", "lua_bridge.cpp"), "utf8");

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

const fixtures = {
  candidateFetch: ["/place-candidates?token=", "data.specificItem", "data.candidates"],
  chooserRender: ["pendingPlaceCandidateHtml", "data-place-candidate", "Choose the"],
  chosenIdPayload: ['params.set("item_id", String(itemId))', "info.items = {selected_item}"],
  explicitItemWins: ["apply_material_picks ~= false", "not (selected_item_id and selected_item_id >= 0)"],
  noChoiceFallback: ["data-place-fallback", "submitBuildPlacement(pending.item, pending.params)"],
  emptyStock: ["No free", "items are currently available.", '"candidates":[]'],
};

function valid(jsText, luaText, httpText, bridgeText) {
  return fixtures.candidateFetch.every(s => jsText.includes(s)) &&
    fixtures.chooserRender.every(s => jsText.includes(s)) &&
    fixtures.chosenIdPayload.every(s => jsText.includes(s) || luaText.includes(s)) &&
    fixtures.explicitItemWins.every(s => luaText.includes(s)) &&
    fixtures.noChoiceFallback.every(s => jsText.includes(s)) &&
    fixtures.emptyStock.every(s => jsText.includes(s) || luaText.includes(s)) &&
    httpText.includes('server.Get("/place-candidates"') &&
    bridgeText.includes('call_lua("place_candidates"') &&
    luaText.includes("function place_candidates(token") &&
    luaText.includes("item_buildable(item)") &&
    luaText.includes("item_matches_filter(filters[1], item)") &&
    luaText.includes("info.filters = filters");
}

console.log("# B114 place-candidate fixtures");
check("candidate fetch is post-click and recognizes the specific-item response", fixtures.candidateFetch.every(s => js.includes(s)));
check("chooser renders candidate buttons", fixtures.chooserRender.every(s => js.includes(s)));
check("chosen id reaches explicit-item construction", fixtures.chosenIdPayload.every(s => js.includes(s) || lua.includes(s)));
check("explicit item overrides generic/closest material picks", fixtures.explicitItemWins.every(s => lua.includes(s)));
check("no-choice fallback omits item_id", fixtures.noChoiceFallback.every(s => js.includes(s)));
check("empty stock has an honest chooser state", fixtures.emptyStock.every(s => js.includes(s) || lua.includes(s)));
check("candidate endpoint filters free matching stock", http.includes('server.Get("/place-candidates"') &&
  bridge.includes('call_lua("place_candidates"') && lua.includes("item_buildable(item)") &&
  lua.includes("item_matches_filter(filters[1], item)"));
check("legacy generic construction is preserved", lua.includes("info.filters = filters") &&
  js.includes("await submitBuildPlacement(item, params);"));

console.log("\n# TEST-THE-TEST seeded-bad variants");
check("missing chosen-id payload fails", !valid(js.replace('params.set("item_id", String(itemId))', "removed-item-id"), lua, http, bridge));
check("missing explicit-item precedence fails", !valid(js,
  lua.replace("not (selected_item_id and selected_item_id >= 0)", "true"), http, bridge));
check("missing empty-stock copy fails", !valid(js.replace("items are currently available.", "removed-empty-state"), lua, http, bridge));
check("missing free-item filter fails", !valid(js, lua.replaceAll("item_buildable(item)", "removed-buildable(item)"), http, bridge));
check("missing generic fallback fails", !valid(js, lua.replace("info.filters = filters", "removed-filters = filters"), http, bridge));

console.log("\n" + passed + " passed, " + failed + " failed.");
process.exit(failed ? 1 : 0);
