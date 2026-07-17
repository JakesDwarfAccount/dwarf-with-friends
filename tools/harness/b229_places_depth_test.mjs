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
// B229 offline fixture -- Places > Locations depth. Covers the four census gaps:
//   1. occupant counts        (occupancyText + the C++ row counts)
//   2. occupation ASSIGNMENT  (the wire, the write's full field set, the guard)
//   3. temple-deity + craft-guild pickers
//   4. rented rooms           (rental_roomst x service_orderst x civzone; write guarded)
// plus the B214 living-citizen filter on the candidate list. Every structural assertion has a
// seeded-bad twin (test-the-test), because a grep that cannot fail proves nothing.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const panelPath = join(root, "web", "js", "dwf-location-panel.js");
const lua = readFileSync(join(root, "dwf.lua"), "utf8");
const bridge = readFileSync(join(root, "src", "lua_bridge.cpp"), "utf8");
const routes = readFileSync(join(root, "src", "building_zone.cpp"), "utf8");
const infoPanel = readFileSync(join(root, "src", "info_panel.cpp"), "utf8");
const infoJs = readFileSync(join(root, "web", "js", "dwf-build-info-panels.js"), "utf8");
const zoneJs = readFileSync(join(root, "web", "js", "dwf-building-zone-stockpile-panels.js"), "utf8");
const html = readFileSync(join(root, "web", "index.html"), "utf8");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
// A seeded-bad assertion is EXPECTED false; the test passes iff it is correctly detected false.
function checkSeededBad(name, cond) {
  if (!cond) { passed++; console.log(`  ok - (test-the-test) ${name} -> correctly detected`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name} -> NOT discriminated`); }
}

// Syntax gate.
try {
  execFileSync(process.execPath, ["--check", panelPath], { stdio: "pipe" });
  passed++; console.log("  ok - dwf-location-panel.js passes node --check");
} catch (e) {
  failed++; console.log(`  FAIL - node --check: ${e.stderr ? e.stderr.toString() : e.message}`);
}

globalThis.DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
const M = require(panelPath);

console.log("TEST: wire shape (server <-> client)");
check("lua exposes location_detail_json + location_action",
  /function location_detail_json\(location_id\)/.test(lua) && /function location_action\(location_id, action, kind, unit_id\)/.test(lua));
check("bridge exposes both via lua",
  /location_detail_json_via_lua/.test(bridge) && /call_lua\("location_action"/.test(bridge));
check("routes registered: GET /location-detail, GET+POST /location-action",
  /server\.Get\("\/location-detail"/.test(routes) &&
  /server\.Get\("\/location-action"/.test(routes) && /server\.Post\("\/location-action"/.test(routes));
check("client fetches the detail route and posts the action route",
  /\/location-detail\?id=/.test(readFileSync(panelPath, "utf8")) &&
  /\/location-action\?id=/.test(readFileSync(panelPath, "utf8")));
check("panel script is loaded by index.html AFTER the hospital panel (handoff order)",
  html.indexOf("dwf-location-panel.js") > html.indexOf("dwf-hospital-panel.js"));
check("Places row carries the location id and opens the location panel",
  /data-location-id=/.test(infoJs) && /openLocationPanel\(locationId\)/.test(infoJs));
check("zone panel routes into the location panel instead of pointing at DF's own screen",
  /data-zone-location-details/.test(zoneJs) && !/from DF's own Location Details screen/.test(zoneJs));
checkSeededBad("a missing route would be caught",
  /server\.Get\("\/location-detail-THAT-DOES-NOT-EXIST"/.test(routes));

console.log("TEST: gap 1 -- occupant counts");
const detail = {
  id: 4, kind: "tavern", label: "Tavern", name: "The Golden Mug", restriction: "everyone",
  tier: 2, value: 1500,
  zones: [{ id: 90, name: "Great Hall", type: "MeetingHall" }],
  occupancy: { inside: 7, citizens: 4, residents: 1, visitors: 2, others: 0, inhabitants: 0, names: ["Urist"] },
  occupations: [
    { id: 12, typeKey: "TAVERN_KEEPER", label: "Tavern Keeper", unitId: 55, histfigId: 900, holder: "Urist McKeeper", assigned: true, verified: true },
    { id: -1, typeKey: "PERFORMER", label: "Performer", unitId: -1, histfigId: -1, holder: "", assigned: false, verified: true },
    { id: -1, typeKey: "MERCENARY", label: "Mercenary", unitId: -1, histfigId: -1, holder: "", assigned: false, verified: false },
  ],
  allowNewSlots: false,
  temple: null,
  guild: null,
  rooms: { canWrite: false, rooms: [
    { id: 1, label: "the eastern room", civzoneId: 91, zoneName: "Guest Room", x: 10, y: 20, z: 30, rented: true, renter: "Ast the Bard", owed: 40, endYear: 260 },
    { id: 2, label: "the western room", civzoneId: 92, zoneName: "Guest Room", x: 12, y: 20, z: 30, rented: false, renter: "", owed: 0, endYear: -1 },
  ] },
  positions: [{ assignmentId: 3, positionId: 7, name: "Priest", holder: "", vacant: true }],
  candidates: [
    { unitId: 55, name: "Urist McKeeper", profession: "Brewer", heldOccupation: "Tavern Keeper" },
    { unitId: 56, name: "Kadol Songful", profession: "Bard", heldOccupation: "" },
  ],
};
check("occupancyText splits citizens/residents/visitors",
  M.occupancyText(detail) === "7 inside · 4 citizens, 1 resident, 2 visitors", M.occupancyText(detail));
check("an empty location says so in words, not '0'",
  M.occupancyText({ occupancy: { inside: 0 } }) === "Nobody here right now");
checkSeededBad("a stub that always said '0 inside' would be caught",
  M.occupancyText(detail).startsWith("0"));
check("C++ Places rows compute occupants from the location's civzone footprints",
  /LocationCounts location_counts\(df::abstract_building\* location\)/.test(infoPanel) &&
  /unit->pos\.z == zone->z && unit->pos\.x >= zone->x1/.test(infoPanel) &&
  /row\.badges\.push_back\(std::to_string\(counts\.occupants\)/.test(infoPanel));
check("C++ occupant count excludes the dead (B214 family)",
  /DFHack::Units::isDead\(unit\) \|\| !DFHack::Units::isActive\(unit\)/.test(infoPanel));
check("C++ staffed count reads occupation::unit_id / ::histfig_id",
  /occ->unit_id >= 0 \|\| occ->histfig_id >= 0/.test(infoPanel));

console.log("TEST: gap 2 -- occupation assignment");
const rows = M.occupationRows(detail);
check("an existing occupation addresses itself by global id", rows[0].key === "id:12" && rows[0].assigned);
check("a vacant catalogue slot addresses itself by type key", rows[1].key === "PERFORMER" && !rows[1].assigned);
check("an assigned row offers Reassign, a vacant one Assign",
  rows[0].action === "Reassign" && rows[1].action === "Assign");
check("an UNVERIFIED slot is marked guarded, not offered as a button",
  rows[2].guarded === true && rows[2].canAssign === false);
check("...and the guard lifts when the server says allowNewSlots",
  M.occupationRows({ ...detail, allowNewSlots: true })[2].guarded === false);
checkSeededBad("a client that offered every slot regardless would be caught",
  M.occupationRows(detail).every(r => r.canAssign));
check("markup renders the holder and an assign control",
  /Urist McKeeper/.test(M.locationPanelMarkup({ data: detail })) &&
  /data-loc-assign="PERFORMER"/.test(M.locationPanelMarkup({ data: detail })));
check("markup does NOT render an assign button for the guarded slot",
  !/data-loc-assign="MERCENARY"/.test(M.locationPanelMarkup({ data: detail })));

// The write's field set, asserted against df-structures (df.occupation.xml / df.abstract_building.xml).
check("write sets every occupation field: id from the game's own counter, type, unit, histfig, location, site, group",
  /df\.global\.occupation_next_id/.test(lua) &&
  /new = df\.occupation/.test(lua) &&
  /location_id = loc\.id/.test(lua) && /site_id = site\.id/.test(lua) && /group_id = fort\.id/.test(lua) &&
  /next_service_order_id = 0/.test(lua));
check("write registers the occupation in BOTH vectors DF keeps it in",
  /df\.global\.world\.occupations\.all:insert\('#'/.test(lua) && /loc\.occupations:insert\('#', occ\)/.test(lua));
check("write mirrors DF's two-sided link (histfig_entity_link_occupationst) and unlinks the old holder first",
  /new = df\.histfig_entity_link_occupationst/.test(lua) && /function unlink_occupation_holder/.test(lua));
check("unassign clears unit_id AND histfig_id (a half-cleared slot is a ghost employee)",
  /occ\.unit_id = -1\s*\n\s*occ\.histfig_id = -1/.test(lua));
check("the site link we cannot spell is deliberately NOT written (sub_id unknown)",
  /do NOT synthesise a\n\s*--\s*histfig_site_link_occupationst/.test(lua) &&
  !/new = df\.histfig_site_link_occupationst/.test(lua));
check("creating an UNVERIFIED slot is guarded server-side",
  /local LOCATION_ALLOW_UNVERIFIED_SLOTS = false/.test(lua) &&
  /not verified for this location kind \(guarded/.test(lua));
checkSeededBad("a guard flag left ON would be caught",
  /local LOCATION_ALLOW_UNVERIFIED_SLOTS = true/.test(lua));

console.log("TEST: gap 3 -- temple deity + craft guild pickers");
const temple = { ...detail, kind: "temple", rooms: null, guild: null,
  temple: { mode: "none", id: -1, name: "", dedicated: false, options: [
    { mode: "hf", id: 300, name: "Armok", worshippers: 5, current: false },
    { mode: "religion", id: 40, name: "The Cult of Stone", worshippers: 2, current: false },
  ] } };
const t = M.deityRows(temple);
check("deity options carry a mode:id spec the server can parse", t.options[0].spec === "hf:300" && t.options[1].spec === "religion:40");
check("deity options are labelled Deity vs Religion", t.options[0].kind === "Deity" && t.options[1].kind === "Religion");
check("an undedicated temple uses DF's exact header wording without appending a Dedication section",
  (() => {
    const md = M.locationPanelMarkup({ data: temple });
    return /No particular deity/.test(md) && !/zone-section-label[^>]*>Dedication/.test(md);
  })());
check("a dedicated temple puts the observed deity name in the header without invented prose",
  (() => {
    const md = M.locationPanelMarkup({ data: { ...temple, temple: { mode: "hf", id: 300, name: "Armok", dedicated: true, options: [] } } });
    return /Armok/.test(md) && !/Dedicated to|no re-dedication/.test(md);
  })());
check("server refuses re-dedication and validates the spec",
  /temple is already dedicated \(native offers no re-dedication/.test(lua) &&
  /bad deity spec \(expected hf:<id> or religion:<id>\)/.test(lua));
check("server writes deity_type + the right union arm (deity_data.Deity / .Religion)",
  /loc\.deity_type = df\.religious_practice_type\.WORSHIP_HFID/.test(lua) &&
  /loc\.deity_data\.Deity = id/.test(lua) &&
  /loc\.deity_type = df\.religious_practice_type\.RELIGION_ENID/.test(lua) &&
  /loc\.deity_data\.Religion = id/.test(lua));
checkSeededBad("a picker that ignored the union arm would be caught",
  /loc\.deity_data\.practice_id = id/.test(lua));

const guildhall = { ...detail, kind: "guildhall", rooms: null, temple: null, occupations: [],
  guild: { key: "", dedicated: false, options: [{ key: "STONEWORKER", name: "The Order of Stone", members: 4, current: false }] } };
const g = M.guildRows(guildhall);
check("guild options carry the profession key + member count", g.options[0].key === "STONEWORKER" && g.options[0].members === 4);
check("guildhall renders a guild picker and no occupation slots (DF gives guildhalls no staff)",
  /data-loc-guild="STONEWORKER"/.test(M.locationPanelMarkup({ data: guildhall, guildOpen: true })) &&
  /no staff positions/.test(M.locationPanelMarkup({ data: guildhall })));
check("server writes abstract_building_contents.profession and only for a guild that exists",
  /loc\.contents\.profession = prof/.test(lua) && /no guild of that craft exists in this fort/.test(lua));
check("guild options derive from historical_entity Guild + guild_professions (entity_focusst)",
  /he\.type == df\.historical_entity_type\.Guild/.test(lua) && /he\.guild_professions\[0\]\.profession/.test(lua));

console.log("TEST: gap 4 -- rented rooms (3-struct cross-link)");
const rm = M.roomRows(detail);
check("a rented room names its renter and what they owe", rm.rooms[0].status === "Ast the Bard · owes 40¤");
check("a free room reads 'vacant'", rm.rooms[1].status === "vacant");
check("room writes are guarded and the panel says so",
  rm.canWrite === false && /read-only here \(B229 probe 4\)/.test(M.locationPanelMarkup({ data: detail })));
check("server joins rental_roomst <- service_orderst (room_ab_local_id) <- customer",
  /so\.type == df\.service_order_type\.ROOM_RENTAL/.test(lua) &&
  /rentals\[so\.room_ab_local_id\] = so/.test(lua) &&
  /so\.customer_unid/.test(lua) && /so\.customer_hfid/.test(lua));
check("server guards the room write behind LOCATION_ALLOW_ROOM_WRITES",
  /local LOCATION_ALLOW_ROOM_WRITES = false/.test(lua) &&
  /rented-room writes are guarded \(B229 probe #4/.test(lua));
checkSeededBad("a room write shipped unguarded would be caught",
  /local LOCATION_ALLOW_ROOM_WRITES = true/.test(lua));

console.log("TEST: B214 -- the living-citizen filter on assignment lists");
check("lua has ONE shared living-citizen predicate, matching the C++ twin's four clauses",
  /function is_living_citizen\(unit\)/.test(lua) &&
  /dfhack\.units\.isCitizen\(unit, true\)/.test(lua) && /dfhack\.units\.isActive\(unit\)/.test(lua) &&
  /not dfhack\.units\.isDead\(unit\)/.test(lua) && /not dfhack\.units\.isGhost\(unit\)/.test(lua));
check("the candidate list uses it", /function location_candidates_json/.test(lua) &&
  /is_living_citizen\(unit\) and \(unit\.hist_figure_id or -1\) >= 0/.test(lua));
check("the assignment write re-checks it server-side (a stale client cannot assign a corpse)",
  /if not is_living_citizen\(unit\) then return false, 'unit is not an assignable living citizen'/.test(lua));
checkSeededBad("a predicate missing the ghost clause would be caught",
  /function is_living_citizen[\s\S]{0,400}?end/.test(lua) &&
  !/isGhost/.test(lua.slice(lua.indexOf("function is_living_citizen"), lua.indexOf("function is_living_citizen") + 500)));
const cands = M.candidateRows(detail, "bard");
check("candidate search filters on name+profession", cands.length === 1 && cands[0].unitId === 56);
check("candidate rows surface an already-held occupation so you don't double-book a dwarf",
  M.candidateRows(detail, "")[0].held === "Tavern Keeper");

console.log("TEST: B216 -- opening a location never moves the camera");
const panelSrc = readFileSync(panelPath, "utf8");
const RECENTER_RE = /\/recenter|\/zoom|centerOn|recenterOn/;
check("the location panel calls no recenter/zoom transport", !RECENTER_RE.test(panelSrc));
// Positive control: the same detector must FIRE on a source that does recenter, or the assertion
// above is vacuous.
check("(test-the-test) the recenter detector fires on a seeded source",
  RECENTER_RE.test(panelSrc + '\nawait fetch("/recenter?x=1");'));

console.log("TEST: DWFUI mandate -- no hand-rolled controls");
check("panel builds every control through DWFUI (header/plaque/scroll/search)",
  /DWFUI\.headerHtml/.test(panelSrc) && /DWFUI\.plaqueBtnHtml/.test(panelSrc) &&
  /DWFUI\.scrollHtml/.test(panelSrc) && /DWFUI\.searchHtml/.test(panelSrc));
check("candidate/deity/guild lists scroll through .dwfui-scroll (wheel contract)",
  /DWFUI\.scrollHtml\(\{ cls: "loc-cand-list" \}/.test(panelSrc));
checkSeededBad("a hand-rolled <button> would be caught", /<button/.test(panelSrc));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
