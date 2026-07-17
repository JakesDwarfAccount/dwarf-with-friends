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

// The complete audit of main_interface.h (df.d_interface.xml, DF 683c721d / v0.53.15) for raw
// building-pointer caches. A "*" row is a df::building* (subtype) our deconstruct paths can free
// and so is purged here; an "id" row is a bld_id/int reference DFHack reindexes on free and is
// therefore SAFE and deliberately left alone.
//
//   sub-interface                     field                         type                       purge?
//   --------------------------------- ----------------------------- -------------------------- ------
//   civzone_interfacest               cur_bld                       building_civzonest*        YES (B34)
//   civzone_interfacest               list[]                        building_civzonest*        YES (B34)
//   civzone_interfacest               zone_just_created[]           building_civzonest*        YES (B34)
//   custom_stockpile_interfacest      abd                           building_stockpilest*      YES (dump 2026-07-16)
//   custom_stockpile_interfacest      sp                            stockpile_settings*        YES -- &bld->settings, dangles on free
//       [offset correction 2026-07-17: the 2026-07-16 dump analysis cited custom_stockpile.sp at
//        gamest+0x2c10 via the STALE typed-Ghidra layout; an MSVC offsetof probe against the dfhack
//        headers this plugin compiles against puts it at gamest+0x2cb0. Nothing here depends on the
//        raw number -- this file purges cs.abd / cs.sp / stockpile.cur_bld BY FIELD NAME, so the
//        compiler resolves the true offsets; the correction matters only to dump forensics.]
//   stockpile_interfacest             cur_bld                       building_stockpilest*      YES
//   info_interfacest.buildings        list[mode][]                  building*                  YES (render-UAF; see below)
//   job_details_interfacest           bld                           building*                  YES
//   buildjob_interfacest              display_furniture_bld         building_display_furniturest* YES
//   assign_display_item_interfacest   display_bld                   building_display_furniturest* YES
//   trade_interfacest                 bld                           building_tradedepotst*     YES
//   assign_trade_interfacest          trade_depot_bld               building_tradedepotst*     YES
//   ----------------------------------------------------------------------------------------- SAFE
//   building_interfacest              button/press_button/          interface_button* whose    no -- SAFE (see below)
//                                     filtered_button[] -> .bd       subclass holds building* bd
//   view_sheets_interfacest           viewing_unid/itid/...         int32_t id                 no (id)
//   stockpile_link_interfacest        (bld_id ints only)            int32_t id                 no (id)
//   stockpile_tools_interfacest       (bld_id ints only)            int32_t id                 no (id)
//   create_work_order_interfacest     forced_bld_id / building[]    int32_t id / cwo_buildingst* no (id; cwo_buildingst is a template, not a building)
//   squads_interfacest                (squad/bld ids)               int32_t id                 no (id)
//   location_list/details/selector    valid_ab/selected_ab          abstract_building*         no (own cache) -- BUT see dependent-view sweep: location_selector is a dependent VIEW of civzone.cur_bld and IS closed
//
// DEPENDENT-VIEW SWEEP (2026-07-16, dump 97692). The rows above classify each field by its OWN
// cached pointer. That is necessary but not sufficient: a sub-interface can hold NO building
// pointer of its own yet still assume, in its per-frame renderer, that ANOTHER purged cache is
// non-null -- it is a *dependent view* of that cache. The location_selector proved this class:
// context ZONE_MEETING_AREA_ASSIGNMENT holds no zone pointer, but FUN_1403b7cf0 dereferences
// civzone.cur_bld->location_id unguarded while open, so nulling cur_bld without closing the picker
// turned the freed-zone UAF into a null-deref crash (exe+0x3b9bc1). Rule adopted here: for every
// purged building* cache, if a sub-interface with an `open` flag treats that cache (or its own
// same-building cache) as a non-null subject, CLOSE it (open=false) when -- and only when -- that
// subject IS the dying building. Sweep result:
//   interface (open flag?)      subject cache            decision
//   --------------------------- ------------------------ --------------------------------------------
//   location_selector (open)    civzone.cur_bld          CLOSE (+context=NONE) -- dump-proven crash
//   custom_stockpile  (open)    abd / &bld->settings     CLOSE -- pre-existing, dump-proven 2026-07-16
//   assign_display_item (open)  display_bld              CLOSE -- dependent view, subject building freed
//   trade             (open)    bld (depot)              CLOSE -- subject depot freed under an open trade
//   assign_trade      (open)    trade_depot_bld          CLOSE -- subject depot freed under an open picker
//   job_details       (open)    bld                      CLOSE -- subject building freed under an open panel
//   stockpile         (no open) cur_bld                  null only -- stockpile_interfacest is the paint-mode
//                                                        struct {doing_rectangle,box_on_left,erasing,repainting,
//                                                        cur_bld} with NO open flag, so there is no dependent
//                                                        view to close; nulling is the pre-existing, already-
//                                                        shipped treatment and unchanged here. (The analogous
//                                                        civzone ZONE_PAINT per-frame consumer null-checks its
//                                                        cur_bld -- FUN_1403bafd0 case 4 `if (cur_bld && ...)`.)
//   buildjob          (no open) display_furniture_bld    null only -- no open flag; its sibling picker
//                                                        (assign_display_item) is the open view and IS closed above
//   info.buildings    (no open) list[mode][]             list fully erased; struct has no cur_bld/selected pointer,
//                                                        only mode + per-mode scrolling_position (clamped), so
//                                                        erasing the vectors is the complete fix
// Closing is safe by construction: each close is guarded by identity against the dying building, so
// it can fire only in the precise remote-delete-while-locally-open race and never dismisses an
// unrelated panel; a spurious dismissal in that race is strictly better than a render-thread crash.
// The 5 squad interfaces (squads.cpp) are out of this helper's scope: they cache squad*/unit*/
// assignment ids around squad lifecycle, not building* our deconstruct paths free, so a building
// deconstruct cannot dangle them.
//
// info_interfacest.buildings.list (df.d_interface.xml:2009-2012, verified against the crash build
// 683c721d AND b12f73a) is a static-array[buildings_mode_type] of stl-vector<building*> -- the
// per-mode (ZONES/LOCATIONS/STOCKPILES/WORKSHOPS/FARMPLOTS/SIEGE_ENGINES) Buildings-tab inventory,
// reached via main_interface.info.buildings (xml:2448/5500). It persists across frames (each mode
// keeps a sibling scrolling_position) and the info-tab RENDERER walks it every frame drawing each
// building's name -> the exact dump-proven render-thread UAF. Purged below over ALL modes.
//
// building_interfacest.button/press_button/filtered_button (xml:5464 building_interfacest) are
// vectors of interface_button*, and the interface_button_buildingst subclass (xml:295-297) carries
// a raw `building* bd`. Classified SAFE for the RELEASE-BLOCKER (render-thread) UAF class with
// direct decomp evidence from 683c721d: bd is set to a real in-world building by
// building_workshopst::fillSidebarMenu (FUN_1408c3a60: `*(bd_off)=this`), and it IS reachable in
// principle via /building-action remove -- BUT the build-sidebar RENDER function (FUN_1408d7ae0)
// iterates these vectors through the buttons' OWN text/render vmethods and never dereferences
// ->bd; ->bd is touched ONLY inside the press handlers (FUN_1408c0d20 / 1408c0c40 / 1408c2200),
// i.e. on a user CLICK, not on the render thread. So it is not the dump's mechanism. We do NOT
// mutate it here on purpose: the same button object is push_back'd into BOTH button and
// press_button (FUN_1407c3f60), so a naive erase/delete would dangle or double-free the shared
// object, and nulling ->bd would only convert a stale-menu click from a possible UAF into a
// guaranteed null-deref -- strictly not safer, and building_interfacest has no `open` flag to
// gate cleanly. The residual (clicking a material/color selector in a build sidebar whose target
// building was remotely removed mid-placement) is user-input-gated, off the render thread, and
// needs a live DF build to fix correctly (reset the build interface as DF does on cancel); logged
// as a follow-up rather than blind-patched.
//
// abstract_building* caches are intentionally excluded: abstract_building (temple/hospital/guild
// location) is a distinct object DFHack's building deconstruct never frees. If a location-removal
// path is ever added it needs its OWN purge (selected_ab/valid_ab) -- flagged here so that future
// path does not silently reopen this bug class for locations.
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
            // DEPENDENT VIEW (dump-proven 2026-07-16 22:25, dump 97692): the zone sheet's
            // location-assignment picker (main_interface.location_selector, context
            // ZONE_MEETING_AREA_ASSIGNMENT) holds NO zone pointer of its own -- its contract is
            // "civzone.cur_bld is the zone I'm assigning a location to". Its renderer FUN_1403b7cf0
            // (@ exe+0x3b9bc1) reads civzone.cur_bld->location_id (+0x118) UNGUARDED whenever it is
            // open with context==0, so nulling cur_bld above without closing the picker converts a
            // freed-zone UAF into a guaranteed null-deref the very next render frame. Close it, as
            // native DF's own dismiss path does. Guarded by cur_bld identity + the exact context, so
            // only the picker that was pointed at THIS dying zone is dismissed.
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

    // --- stockpiles: dump-proven UAF 2026-07-16. custom_stockpile.sp is a stockpile_settings*
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
    //     the inspected-building caches on the generic panels can dangle too. DEPENDENT-VIEW SWEEP
    //     (2026-07-16): the location_selector crash taught us that nulling a cache is only half the
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
