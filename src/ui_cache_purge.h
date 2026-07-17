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

// UI-cache purge -- the one place that closes the "DFHack frees a building, DF's v50 interface
// keeps a raw pointer to it, the renderer virtual-calls the freed object next frame -> AV" bug
// CLASS. Buildings::deconstruct clears only the PRE-v50 selection (world->selected_building +
// ui_look_list); it never touches game.main_interface, so every raw building* parked in a v50
// sub-interface survives the free as a dangling pointer.
//
// Proven twice against crash dumps:
//   - B34 (zones): make a zone in native DF, delete it from the browser -> DF walks a freed
//     building_civzonest on its next frame (game.main_interface.civzone.cur_bld/list/
//     zone_just_created).
//   - stockpile UAF, dump-proven 2026-07-16: a freed building_stockpilest sat in
//     game.main_interface.custom_stockpile.sp at crash time and the faulting instruction was
//     building->getName() (vmethod slot 49) in the interface renderer. Browser stockpile
//     remove AND repaint/resize both deconstruct the pile while the host may have the custom
//     stockpile-settings screen open on it.
//
// Call this from EVERY path that deconstructs/frees a building of ANY type, under the same
// CoreSuspender that guards the free, BEFORE Buildings::deconstruct. It is CONSERVATIVE: it only
// nulls/closes a cache that points AT the dying building; unrelated buildings and id-based caches
// (view_sheets viewing_*, stockpile_link/stockpile_tools bld_id, create_work_order forced_bld_id,
// squads_interfacest ids) are left untouched. See src/ui_cache_purge.cpp for the full audit of
// main_interface.h's building-pointer fields (df.d_interface.xml, build 683c721d).

#pragma once

namespace df { struct building; }

namespace dwf {

// Null/close every raw df::building* cache in game.main_interface that references `b`. Safe on a
// null `b` or a null df::global::game. MUST run under CoreSuspender, on the core thread, BEFORE
// the building is freed. Mirrors the B34 zone purge (building_zone.cpp) and is its superset.
void purge_ui_caches_for_building(df::building* b);

} // namespace dwf
