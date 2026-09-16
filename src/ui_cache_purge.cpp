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

#include "ui_cache_purge.h"

#include "DataDefs.h"

#include "df/building.h"
#include "df/building_civzonest.h"
#include "df/building_display_furniturest.h"
#include "df/building_stockpilest.h"
#include "df/building_tradedepotst.h"
#include "df/buildings_interfacest.h"
#include "df/gamest.h"
#include "df/global_objects.h"
#include "df/info_interfacest.h"
#include "df/location_selector_interfacest.h"
#include "df/main_interface.h"
#include "df/stockpile_settings.h"

using namespace DFHack;

namespace dwf {

// Nulls every main_interface raw building* cache that names the dying building. id-based caches
// are left alone: DFHack reindexes those on free.

// Deconstruct never frees an abstract_building, so selected_ab/valid_ab are absent by design; a
// location-removal path needs its own purge for those or it reopens this bug class.
void purge_ui_caches_for_building(df::building* b) {
    if (!b)
        return;
    auto game = df::global::game;
    if (!game)
        return;
    auto& mi = game->main_interface;

    // --- zones (B34, W23): dump-proven UAF. Buildings::deconstruct frees the building_civzonest
    //     but never clears civzone.cur_bld / .list / .zone_just_created. Comparing the typed
    //     caches against the base building* upcasts the cache (single inheritance, offset 0), so
    //     the match is exact. This block IS the former inline B34 purge (building_zone.cpp), moved
    //     here verbatim so every deconstruct path -- not only zone remove -- gets it. ---
    {
        auto& civ = mi.civzone;
        if (civ.cur_bld == b) {
            civ.cur_bld = nullptr;
            // Never null cur_bld without closing this picker: while open it reads
            // cur_bld->location_id unguarded, so a bare null crashes the next render frame.
            auto& ls = mi.location_selector;
            if (ls.open && ls.context ==
                    df::location_selector_context_type::ZONE_MEETING_AREA_ASSIGNMENT) {
                ls.open = false;
                ls.context = df::location_selector_context_type::NONE;
            }
        }
        for (size_t i = civ.list.size(); i-- > 0;)
            if (civ.list[i] == b)
                civ.list.erase(civ.list.begin() + i);
        for (size_t i = civ.zone_just_created.size(); i-- > 0;)
            if (civ.zone_just_created[i] == b)
                civ.zone_just_created.erase(civ.zone_just_created.begin() + i);
    }

    // --- info Buildings tab: main_interface.info.buildings.list is a static-array indexed by
    //     buildings_mode_type of stl-vector<building*> -- the per-mode inventory the tab renders
    //     every frame (drawing each building's name), so a freed building left here is the same
    //     render-thread UAF. Every mode's list holds the exact types our four deconstruct paths
    //     free (ZONES/STOCKPILES/WORKSHOPS/FARMPLOTS/...); iterate ALL modes and erase identity
    //     matches, mirroring the civzone.list block above. ---
    for (auto& mode_list : mi.info.buildings.list)
        for (size_t i = mode_list.size(); i-- > 0;)
            if (mode_list[i] == b)
                mode_list.erase(mode_list.begin() + i);

    // --- stockpiles: dump-proven UAF. custom_stockpile.sp is a stockpile_settings*
    //     pointing INTO the pile (&bld->settings), so freeing the pile dangles it even though it
    //     is not itself a building pointer; abd + stockpile.cur_bld are building_stockpilest*.
    //     Close custom_stockpile (open=false) as native DF does on dismiss -- the renderer reads
    //     these fields in interface states we have not fully mapped, so belt-and-braces. ---
    if (auto sp = virtual_cast<df::building_stockpilest>(b)) {
        auto& cs = mi.custom_stockpile;
        if (cs.abd == sp || cs.sp == &sp->settings) {
            cs.open = false;
            cs.abd = nullptr;
            cs.sp = nullptr;
        }
        if (mi.stockpile.cur_bld == sp)
            mi.stockpile.cur_bld = nullptr;
    }

    // --- generic building panels: the /building-action remove route frees ANY building type, so
    //     the inspected-building caches on the generic panels can dangle too. The
    //     location_selector crash taught us that nulling a cache is only half the
    //     contract when an OPEN sub-interface's renderer treats that cache as its non-null subject.
    //     Each interface below that carries its own `open` flag AND whose subject is the dying
    //     building is therefore CLOSED, not merely nulled -- guarded by pointer identity so only the
    //     panel pointed at THIS building is dismissed. Closing is provably safe by construction: it
    //     runs only in the exact race where the panel's subject building is being freed this frame,
    //     it cannot happen to an unrelated panel, and it mirrors DF's own dismiss + the dump-proven
    //     custom_stockpile.open/location_selector.open precedents. Interfaces with NO open flag are
    //     nulled only (nothing to close). ---
    if (mi.job_details.bld == b) {
        mi.job_details.bld = nullptr;
        mi.job_details.open = false;  // job_details_interfacest has `open`; its subject building died.
    }

    if (auto furn = virtual_cast<df::building_display_furniturest>(b)) {
        // buildjob_interfacest has NO open flag (just display_furniture_bld + selected_item) -> null only.
        if (mi.buildjob.display_furniture_bld == furn)
            mi.buildjob.display_furniture_bld = nullptr;
        // assign_display_item_interfacest DOES have `open` and its subject is display_bld -> close it.
        if (mi.assign_display_item.display_bld == furn) {
            mi.assign_display_item.display_bld = nullptr;
            mi.assign_display_item.open = false;
        }
    }

    if (auto depot = virtual_cast<df::building_tradedepotst>(b)) {
        // trade_interfacest and assign_trade_interfacest both carry `open` with the depot as subject.
        if (mi.trade.bld == depot) {
            mi.trade.bld = nullptr;
            mi.trade.open = false;
        }
        if (mi.assign_trade.trade_depot_bld == depot) {
            mi.assign_trade.trade_depot_bld = nullptr;
            mi.assign_trade.open = false;
        }
    }
}

} // namespace dwf
