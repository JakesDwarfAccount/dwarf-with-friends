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

#pragma once

#include "httplib.h"

#include <string>

namespace dwf {

// B228 -- the missions/raids domain. Splits the mission surface out of worldmap_panel.cpp (which
// keeps emitting its small `missions` array for the world-map overlay; this module is the deep
// screen behind the "Missions" plaque).
//
// ===========================================================================================
// THE WRITE PATH, AS FOUND. READ THIS BEFORE ADDING A "SEND SQUAD" BUTTON.
// ===========================================================================================
// Every claim below is cited against the df-structures checkout at <DFHACK_ROOT>.
//
// WHAT A NATIVE MISSION IS. DF's fortress mission is not one record, it is a five-way linked
// object graph, and DF ships a plugin whose entire job is to notice when those links rot:
//   * df::army_controller (df.army_controller.xml) -- the order. Carries entity_id, site_id,
//     pos_x/pos_y (abs_smm), year/year_tick, master_id, assigned_squads[], a mission_report*,
//     and a `data` UNION whose active member is selected by `goal`
//     (army_controller_goal_type: SITE_INVASION / RECOVER_ARTIFACT / RESCUE_HF / MAKE_REQUEST /
//     DIPLOMACY / ...). Ids come from the *army_controller_next_id GLOBAL.
//   * df::army (df.army.xml) -- the travelling body. Carries controller/controller_id, a
//     members[] vector of army_nemesisst (one PER DWARF: nemesis_id, hunger/thirst/sleepiness
//     timers, stored_fat, abs_x/y/z, tracking_rating, sneak_rating, travel_rate, smell_trigger,
//     low_light_vision, odor_level, can_sense_by_class...), a path, a tent item, and the
//     army_flags bitfield including `dwarf_mode_preparing`.
//   * df::historical_entity::army_controllers (historical_entity.h:321) -- the fort government's
//     own back-reference list.
//   * df::squad::assigned_army_controller_id (squad.h:36) -- the squad's forward reference.
//   * df::historical_figure -> info -> whereabouts (state_profilest) -> army_id -- each dwarf's
//     "I am with this army" pointer, and unit::enemy::army_controller(_id) on the map side.
// DFHack's plugins/army-controller-sanity.cpp validates FIVE of those cross-links every tick and
// warns on mismatch; scripts/fix/stuck-squad.lua exists purely because DF ITSELF corrupts them
// (an army whose controller_id != 0 but whose controller pointer is null = dwarves stranded off
// the map forever). That is the blast radius of getting this wrong: not a bad UI state, a save.
//
// WHAT DFHACK OFFERS. Nothing. `grep -rn 'army_controllers.all.push_back|new df::army|
// army_controller_next_id' library/ plugins/ scripts/` over the whole DFHack tree returns exactly
// one file -- army-controller-sanity.cpp, which only READS the global to detect that DF bumped it.
// modules/Military.h exposes getSquadName / makeSquad / addToSquad / removeFromSquad /
// updateRoomAssignments and nothing else. There is no createMission, no sendArmy, no
// allocate<army_controller>. fix/stuck-squad only ever MOVES members between armies that DF
// already built. So a mission create would be a from-scratch reimplementation of DF's own
// allocator, with no reference implementation anywhere to check it against.
//
// WHERE DF ACTUALLY DOES IT. df::viewscreen_worldst (df.d_interface.xml:6989). Its fields ARE the
// mission-creation form: `view_mode` (world_view_mode_type, whose members include MISSIONS_LIST,
// MISSION_DETAILS and NEW_MISSION), `focus_site` (the target), `focus_site_artifact[]` /
// `focus_site_prisoner[]` / `focus_site_requestable_worker[]` (what is recoverable THERE),
// `squad[]` + `squad_flag[]` (civlist_squad_flag::LOCKED_IN -- the squad picker's checkboxes),
// `military_goals_hf` (the noble who must exist to authorise it), and the killer:
//   static-array new_mission[army_controller_goal_type] of world_new_mission_type
// -- DF's OWN per-goal eligibility verdict for the focused site: OKAY, or a refusal reason
// (NOT_DISPLAYED / OWN_SITE / OWN_CIV / NOT_UNDER_YOUR_CONTROL / NO_CIV / INACCESSIBLE /
// NO_MILITARY_GOALS_HF / NOT_IN_CONTACT / ...). Those verdicts are COMPUTED BY THE VIEWSCREEN and
// exist nowhere in world state, so even the *eligibility* half cannot be read without that screen
// being open and focused; and the commit half lives inside its native feed() handler, which v50
// drives by MOUSE (df.g_src.keybindings.xml has D_WORLD to open the screen and no world-screen
// interface_key for select-site / lock-squad / confirm) -- so there is not even a synthetic
// keypress to forward. dwf never pushes native viewscreens (sdl_capture.cpp renders whatever
// is on top; a pushed viewscreen_worldst would hijack every player's stream), so that door is shut
// at the architecture level too, not just the API level.
//
// THE DOCTRINE, AND WHY WE OBEY IT. trade_depot.h says it plainly: every mechanism copied from
// DFHack's own scripts, "not guessed"; the barter confirm is host-native and stays host-native.
// native_popup.h dismisses a popup by "the same state transition DF's own dismissal performs --
// never a blanket ESC injection". A mission create has no DF-own transition to copy and no
// DFHack primitive to lean on. Guessing one and getting the army_nemesisst init or the
// dwarf_mode_preparing handoff subtly wrong does not throw -- it writes a plausible-looking save
// that strands dwarves or corrupts on load. So:
//
//   POST /mission-create IS IMPLEMENTED UP TO, AND STOPS AT, THE COMMIT.
//
// It resolves and validates the whole order the way DF would (target known? squad ours? squad
// free? goal legal for that target?), returns the fully-staged plan as JSON, and then refuses with
// 501 + `"blocked":"native-only"` + the reason above. It NEVER partially writes. The guard is a
// single constant (kMissionCommitEnabled) so the day a live probe pins the field-for-field
// departure, the commit slots in behind an already-tested validator. See the numbered probe list
// in the .cpp banner over do_mission_create().
//
// ===========================================================================================
// WHAT IS A REAL WRITE HERE
// ===========================================================================================
// POST /mission-rescue. DF strands squads: an army with controller_id != 0 and a null controller
// pointer is a squad that left on a mission and can never come home. Those dwarves are gone --
// not dead, just permanently absent, and the fort keeps counting them. DFHack ships the repair
// (scripts/fix/stuck-squad.lua, module=true), and it is the ONE mission-domain mutation that has a
// tested upstream implementation. /mission-rescue runs THAT SCRIPT (via the lua bridge -- we do
// not reimplement it) and reports what it did. GET /missions surfaces the stranded squads and
// whether a returning army/messenger is available to carry the rescue, so the button is only ever
// live when DFHack would actually succeed.
//
// Routes: GET /missions, POST /mission-create (validated, native-blocked), POST /mission-rescue.
void register_mission_routes(httplib::Server& server);

} // namespace dwf
