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

#include "flight_recorder_v3.h"

#include <algorithm>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

#ifdef _MSC_VER
#include <excpt.h>
#endif

#include "DataDefs.h"
#include "json_util.h"
#include "modules/Gui.h"

#include "df/abstract_building.h"
#include "df/building.h"
#include "df/building_actual.h"
#include "df/building_civzonest.h"
#include "df/building_squad_infost.h"
#include "df/building_stockpilest.h"
#include "df/buildingitemst.h"
#include "df/burrow.h"
#include "df/general_ref.h"
#include "df/gamest.h"
#include "df/global_objects.h"
#include "df/item.h"
#include "df/job.h"
#include "df/job_item.h"
#include "df/main_interface.h"
#include "df/squad.h"
#include "df/squad_position.h"
#include "df/squad_routine_schedulest.h"
#include "df/unit.h"
#include "df/unit_inventory_item.h"
#include "df/unit_skill.h"
#include "df/unit_soul.h"
#include "df/viewscreen_worldst.h"
#include "df/world_site.h"

namespace dwf::recorder_v3 {
namespace {

constexpr size_t kUnitInventoryCap = 256;
constexpr size_t kUnitSkillCap = 256;
constexpr size_t kItemRefCap = 64;
constexpr size_t kItemGeneralRefCap = 512;
constexpr size_t kItemContainedCap = 256;
constexpr size_t kPlaceUnitCap = 256;
constexpr size_t kPlaceSquadCap = 64;
constexpr size_t kPlaceItemCap = 512;
constexpr size_t kBuildingJobCap = 256;
constexpr size_t kBuildingItemCap = 512;
constexpr size_t kJobItemCap = 64;
constexpr size_t kSquadPositionCap = 64;
constexpr size_t kSquadOrderCap = 256;
constexpr size_t kSquadRoutineCap = 64;

template <typename T>
int32_t integer(T value) {
    return static_cast<int32_t>(value);
}

bool matches(const std::string& focus, const char* selector) {
    const std::string value(selector);
    return focus == value ||
           (focus.size() > value.size() && focus.compare(0, value.size(), value) == 0 &&
            focus[value.size()] == '/');
}

bool any_matches(const std::vector<std::string>& focus, const char* selector) {
    return std::any_of(focus.begin(), focus.end(),
                       [selector](const std::string& value) { return matches(value, selector); });
}

void set_ok(SliceMeta& meta) {
    meta.status = SliceStatus::ok;
    meta.reason.clear();
}

void fail(SliceMeta& meta, SliceStatus status, const char* reason) {
    meta.status = status;
    meta.reason = reason;
}

void fnv_bytes(uint64_t& hash, const void* data, size_t size) {
    const auto* bytes = static_cast<const uint8_t*>(data);
    for (size_t i = 0; i < size; ++i) {
        hash ^= bytes[i];
        hash *= 1099511628211ULL;
    }
}

void fnv_i32(uint64_t& hash, int32_t value) {
    const uint32_t stable = static_cast<uint32_t>(value);
    const uint8_t bytes[4] = {
        static_cast<uint8_t>(stable), static_cast<uint8_t>(stable >> 8),
        static_cast<uint8_t>(stable >> 16), static_cast<uint8_t>(stable >> 24)};
    fnv_bytes(hash, bytes, sizeof(bytes));
}

void fnv_bool(uint64_t& hash, bool value) {
    const uint8_t byte = value ? 1 : 0;
    fnv_bytes(hash, &byte, 1);
}

void fnv_string(uint64_t& hash, const std::string& value) {
    fnv_i32(hash, static_cast<int32_t>(value.size()));
    fnv_bytes(hash, value.data(), value.size());
}

void add_family(RouteContext& route, const char* family) {
    if (std::find(route.surface_families.begin(), route.surface_families.end(), family) ==
        route.surface_families.end())
        route.surface_families.emplace_back(family);
}

int32_t selected_unit_scroll(const df::view_sheets_interfacest& sheets) {
    switch (sheets.active_sub_tab) {
    case 0: return sheets.scroll_position;
    case 1: return sheets.scroll_position_inventory;
    case 2: return sheets.scroll_position_unit_health;
    case 3: return sheets.scroll_position_unit_skill;
    case 4: return sheets.scroll_position_unit_room;
    case 5: return sheets.scroll_position_unit_labor;
    case 6: return sheets.scroll_position_relations;
    case 7: return sheets.scroll_position_groups;
    case 8: return sheets.unit_military_active_tab == 1
                       ? sheets.scroll_position_unit_military_kills
                       : sheets.scroll_position_unit_military_assigned;
    case 9: return sheets.scroll_position_thoughts;
    case 10: return sheets.scroll_position_personality;
    default: return sheets.scroll_position;
    }
}

df::abstract_building* find_site_location(int32_t site_id, int32_t location_id) {
    if (site_id < 0 || location_id < 0)
        return nullptr;
    auto* site = df::world_site::find(site_id);
    if (!site)
        return nullptr;
    const int index = df::abstract_building::binsearch_index(site->buildings, location_id, true);
    return index >= 0 && static_cast<size_t>(index) < site->buildings.size()
               ? site->buildings[static_cast<size_t>(index)] : nullptr;
}

uint64_t make_route_stamp(const State& state) {
    uint64_t hash = 1469598103934665603ULL;
    for (const auto& value : state.route.focus)
        fnv_string(hash, value);
    for (const auto& value : state.route.surface_families)
        fnv_string(hash, value);
    fnv_string(hash, state.route.primary_kind);
    fnv_i32(hash, state.route.primary_id);
    fnv_i32(hash, state.route.tab);
    fnv_i32(hash, state.route.mode);
    fnv_i32(hash, state.route.scroll);
    fnv_bool(hash, state.route.input_active);
    fnv_i32(hash, state.route.dim_x);
    fnv_i32(hash, state.route.dim_y);
    fnv_i32(hash, state.route.gps_top_in_use);

    fnv_i32(hash, state.unit.unit_id);
    fnv_i32(hash, state.unit.active_sheet);
    fnv_i32(hash, state.unit.active_sub_tab);
    fnv_i32(hash, state.unit.scroll_position);
    fnv_i32(hash, state.stock_item.item_id);
    fnv_i32(hash, state.stock_item.stock_category);
    fnv_i32(hash, state.stock_item.category_scroll);
    fnv_i32(hash, state.stock_item.item_scroll);
    fnv_bool(hash, state.stock_item.filter_active);
    fnv_bool(hash, state.stock_item.filter_nonempty);
    fnv_string(hash, state.place.place_kind);
    fnv_i32(hash, state.place.building_id);
    fnv_i32(hash, state.place.location_id);
    fnv_i32(hash, state.place.site_id);
    fnv_i32(hash, state.place.context);
    fnv_i32(hash, state.place.scroll);
    fnv_bool(hash, state.place.remove);
    fnv_bool(hash, state.place.rectangle);
    fnv_bool(hash, state.place.multizone);
    fnv_bool(hash, state.place.erase);
    fnv_bool(hash, state.place.repaint);
    fnv_i32(hash, state.building.building_id);
    fnv_i32(hash, state.building.selected_job_id);
    fnv_i32(hash, state.building.picker_stage);
    fnv_i32(hash, state.building.view_tab);
    fnv_i32(hash, state.building.picker_category);
    fnv_i32(hash, state.building.picker_selected);
    fnv_i32(hash, state.building.picker_job_type);
    fnv_i32(hash, state.building.picker_mat_type);
    fnv_i32(hash, state.building.picker_mat_index);
    fnv_i32(hash, state.squad.squad_id);
    fnv_i32(hash, state.squad.schedule_month);
    fnv_i32(hash, state.squad.schedule_routine);
    fnv_i32(hash, state.squad.viewing_squad_index);
    fnv_i32(hash, state.squad.scroll);
    fnv_i32(hash, state.squad.order_scroll);
    fnv_bool(hash, state.squad.move_order);
    fnv_bool(hash, state.squad.kill_order);
    fnv_bool(hash, state.squad.patrol_order);
    fnv_bool(hash, state.squad.burrow_order);
    fnv_bool(hash, state.squad.disband_confirmation);
    fnv_bool(hash, state.squad.schedule_whole_squad);
    fnv_i32(hash, state.world.tab);
    fnv_i32(hash, state.world.selected_index);
    fnv_i32(hash, state.world.scroll);
    fnv_i32(hash, state.world.selection_id);
    fnv_string(hash, state.palette.tool_family);
    fnv_i32(hash, state.palette.mode);
    fnv_i32(hash, state.palette.stage);
    fnv_bool(hash, state.palette.marker_only);
    fnv_bool(hash, state.palette.show_priorities);
    fnv_bool(hash, state.palette.advanced);
    fnv_i32(hash, state.palette.priority);
    fnv_i32(hash, state.palette.mine_mode);
    fnv_i32(hash, state.palette.build_category);
    fnv_i32(hash, state.palette.build_selected);
    fnv_i32(hash, state.palette.build_material);
    fnv_i32(hash, state.palette.build_matgloss);
    fnv_i32(hash, state.palette.build_job);
    fnv_i32(hash, static_cast<int32_t>(state.palette.build_item_flags));
    fnv_bool(hash, state.palette.zone_remove);
    fnv_bool(hash, state.palette.zone_rectangle);
    fnv_bool(hash, state.palette.zone_multizone);
    fnv_bool(hash, state.palette.zone_erase);
    fnv_bool(hash, state.palette.zone_repaint);
    fnv_i32(hash, state.palette.zone_type);
    fnv_i32(hash, state.palette.zone_flow_shape);
    fnv_i32(hash, state.palette.zone_building_id);
    fnv_bool(hash, state.palette.stockpile_rectangle);
    fnv_bool(hash, state.palette.stockpile_erase);
    fnv_bool(hash, state.palette.stockpile_repaint);
    fnv_i32(hash, state.palette.stockpile_building_id);
    fnv_bool(hash, state.palette.burrow_rectangle);
    fnv_bool(hash, state.palette.burrow_erase);
    fnv_i32(hash, state.palette.burrow_id);
    fnv_i32(hash, state.palette.burrow_scroll);
    fnv_i32(hash, state.palette.hauling_route_id);
    fnv_i32(hash, state.palette.hauling_stop_id);
    fnv_i32(hash, state.palette.hauling_scroll);
    return hash;
}

void capture_route_primary(State& state) {
    auto& route = state.route;
    if (state.unit.meta.status != SliceStatus::not_applicable) {
        route.primary_kind = "unit";
        route.primary_id = state.unit.unit_id;
        route.tab = state.unit.active_sub_tab;
        route.mode = state.unit.active_sheet;
        route.scroll = state.unit.scroll_position;
    } else if (state.stock_item.meta.status != SliceStatus::not_applicable) {
        route.primary_kind = "stock_item";
        route.primary_id = state.stock_item.item_id;
        route.tab = state.stock_item.stock_category;
        route.scroll = state.stock_item.item_scroll;
        route.input_active = state.stock_item.filter_active;
    } else if (state.place.meta.status != SliceStatus::not_applicable) {
        route.primary_kind = "place";
        route.primary_id = state.place.building_id >= 0 ? state.place.building_id
                                                       : state.place.location_id;
        route.mode = state.place.context;
        route.scroll = state.place.scroll;
    } else if (state.building.meta.status != SliceStatus::not_applicable) {
        route.primary_kind = "building";
        route.primary_id = state.building.building_id;
        route.tab = state.building.view_tab;
        route.mode = state.building.picker_stage;
    } else if (state.squad.meta.status != SliceStatus::not_applicable) {
        route.primary_kind = "squad";
        route.primary_id = state.squad.squad_id;
        route.tab = state.squad.schedule_month;
        route.mode = state.squad.mode;
        route.scroll = state.squad.scroll;
    } else if (state.world.meta.status != SliceStatus::not_applicable) {
        route.primary_kind = "world";
        route.primary_id = state.world.selection_id;
        route.tab = state.world.tab;
        route.scroll = state.world.scroll;
    } else if (state.palette.meta.status != SliceStatus::not_applicable) {
        route.primary_kind = "control_palette";
        route.primary_id = state.palette.zone_building_id >= 0
                               ? state.palette.zone_building_id
                               : state.palette.stockpile_building_id;
        route.mode = state.palette.mode;
        route.tab = state.palette.stage;
    }
}

void capture_unit(State& state, df::main_interface& ui) {
    if (!any_matches(state.route.focus, "dwarfmode/ViewSheets/UNIT"))
        return;
    auto& out = state.unit;
    auto& sheets = ui.view_sheets;
    if (integer(sheets.active_sheet) != integer(df::view_sheet_type::UNIT)) {
        fail(out.meta, SliceStatus::unsupported, "sheet_mismatch");
        return;
    }
    set_ok(out.meta);
    out.unit_id = sheets.active_id;
    out.active_sheet = integer(sheets.active_sheet);
    out.active_sub_tab = sheets.active_sub_tab;
    out.scroll_position = selected_unit_scroll(sheets);
    state.route.input_active = sheets.unit_overview_entering_nickname ||
                               sheets.unit_overview_entering_profession_nickname;
}

void capture_stock_item(State& state, df::main_interface& ui) {
    const bool stocks = any_matches(state.route.focus, "dwarfmode/Stocks");
    const bool item_sheet = any_matches(state.route.focus, "dwarfmode/ViewSheets/ITEM");
    if (!stocks && !item_sheet)
        return;
    auto& out = state.stock_item;
    set_ok(out.meta);
    if (item_sheet && integer(ui.view_sheets.active_sheet) == integer(df::view_sheet_type::ITEM)) {
        out.surface = "item_sheet";
        out.item_id = ui.view_sheets.active_id;
        out.item_scroll = ui.view_sheets.scroll_position_item;
    } else if (stocks) {
        out.surface = "stocks";
        out.item_id = -1;
        out.item_scroll = ui.stocks.scroll_position_item;
    } else {
        fail(out.meta, SliceStatus::unsupported, "sheet_mismatch");
        return;
    }
    out.stock_category = integer(ui.stocks.current_type);
    out.category_scroll = ui.stocks.scroll_position_type;
    out.filter_active = ui.stocks.entering_item_filter;
    out.filter_nonempty = !ui.stocks.item_filter.empty();
}

void capture_place(State& state, df::main_interface& ui) {
    const bool zone = any_matches(state.route.focus, "dwarfmode/Zone");
    const bool stockpile = any_matches(state.route.focus, "dwarfmode/Stockpile");
    const bool location_details = any_matches(state.route.focus, "dwarfmode/LocationDetails");
    const bool location_selector = any_matches(state.route.focus, "dwarfmode/LocationSelector");
    const bool info = any_matches(state.route.focus, "dwarfmode/Info/BUILDINGS");
    if (!zone && !stockpile && !location_details && !location_selector && !info)
        return;

    auto& out = state.place;
    set_ok(out.meta);
    if (location_details) {
        out.place_kind = "location";
        if (!ui.location_details.open) {
            fail(out.meta, SliceStatus::unsupported, "focus_state_mismatch");
            return;
        }
        if (!ui.location_details.selected_ab) {
            fail(out.meta, SliceStatus::unsupported, "direct_identity_unavailable");
            return;
        }
        out.location_id = ui.location_details.selected_ab->id;
        out.site_id = ui.location_details.selected_ab->site_id;
        out.context = integer(ui.location_details.context);
        out.scroll = ui.location_details.scroll_position_occupation;
    } else if (location_selector) {
        out.place_kind = "location_selector";
        if (!ui.location_selector.open) {
            fail(out.meta, SliceStatus::unsupported, "focus_state_mismatch");
            return;
        }
        fail(out.meta, SliceStatus::unsupported, "direct_identity_unavailable");
    } else if (zone) {
        out.place_kind = "zone";
        out.building_id = ui.civzone.cur_bld ? ui.civzone.cur_bld->id : -1;
        out.remove = ui.civzone.remove;
        out.rectangle = ui.civzone.doing_rectangle;
        out.multizone = ui.civzone.doing_multizone;
        out.erase = ui.civzone.erasing;
        out.repaint = ui.civzone.repainting;
        out.zone_type = integer(ui.civzone.adding_new_type);
        out.context = integer(ui.civzone.flow_shape);
    } else if (stockpile) {
        out.place_kind = "stockpile";
        out.building_id = ui.stockpile.cur_bld ? ui.stockpile.cur_bld->id : -1;
        out.rectangle = ui.stockpile.doing_rectangle;
        out.erase = ui.stockpile.erasing;
        out.repaint = ui.stockpile.repainting;
    } else {
        out.place_kind = "info_buildings";
        fail(out.meta, SliceStatus::unsupported, "direct_identity_unavailable");
    }
}

void capture_building(State& state, df::main_interface& ui) {
    const bool sheet = any_matches(state.route.focus, "dwarfmode/ViewSheets/BUILDING");
    const bool picker = any_matches(state.route.focus, "dwarfmode/Building");
    const bool info = any_matches(state.route.focus, "dwarfmode/Info/BUILDINGS");
    if (!sheet && !picker && !info)
        return;

    auto& out = state.building;
    set_ok(out.meta);
    if (sheet && integer(ui.view_sheets.active_sheet) == integer(df::view_sheet_type::BUILDING)) {
        out.building_id = ui.view_sheets.viewing_bldid;
        out.view_tab = ui.view_sheets.active_sub_tab;
        out.picker_stage = 0;
    } else if (picker) {
        out.picker_stage = 1;
        out.picker_category = integer(ui.building.category);
        out.picker_selected = ui.building.selected;
        out.picker_job_type = integer(ui.building.job);
        out.picker_mat_type = ui.building.material;
        out.picker_mat_index = ui.building.matgloss;
    } else {
        out.picker_stage = 0;
        fail(out.meta, SliceStatus::unsupported, "direct_identity_unavailable");
    }

    if (ui.job_details.open) {
        out.picker_stage = 10 + integer(ui.job_details.current_option);
        out.picker_selected = ui.job_details.current_option_index;
        if (ui.job_details.bld)
            out.building_id = ui.job_details.bld->id;
        if (ui.job_details.jb)
            out.selected_job_id = ui.job_details.jb->id;
    }
}

void capture_squad(State& state, df::main_interface& ui) {
    if (!any_matches(state.route.focus, "dwarfmode/Squads") &&
        !any_matches(state.route.focus, "dwarfmode/SquadSelector") &&
        !any_matches(state.route.focus, "dwarfmode/AssignUniform"))
        return;
    auto& out = state.squad;
    set_ok(out.meta);
    auto& squads = ui.squads;
    out.mode = any_matches(state.route.focus, "dwarfmode/Squads") ? 0
               : any_matches(state.route.focus, "dwarfmode/SquadSelector") ? 1 : 2;
    out.viewing_squad_index = squads.viewing_squad_index;
    out.scroll = squads.scroll_position;
    out.order_scroll = squads.scroll_position_orderp;
    out.move_order = squads.giving_move_order;
    out.kill_order = squads.giving_kill_order;
    out.patrol_order = squads.giving_patrol_order;
    out.burrow_order = squads.giving_burrow_order;
    out.disband_confirmation = squads.disband_confirmation;
    out.schedule_month = squads.editing_squad_schedule_month;
    out.schedule_routine = squads.editing_squad_schedule_routine_index;
    out.schedule_whole_squad = squads.editing_squad_schedule_whole_squad_selected;
    if (squads.editing_squad_schedule_id >= 0) {
        out.squad_id = squads.editing_squad_schedule_id;
        out.selected_identity_complete = true;
    } else if (ui.squad_schedule.open && ui.squad_schedule.viewing_months_squad_id >= 0) {
        out.squad_id = ui.squad_schedule.viewing_months_squad_id;
        out.selected_identity_complete = true;
        out.mode = 3;
        out.scroll = ui.squad_schedule.scroll_position;
        out.order_scroll = ui.squad_schedule.scroll_position_month;
    } else if (ui.squad_equipment.open && ui.squad_equipment.setting_ammo &&
               ui.squad_equipment.setting_ammo_squad_id >= 0) {
        out.squad_id = ui.squad_equipment.setting_ammo_squad_id;
        out.selected_identity_complete = true;
        out.mode = 4;
        out.scroll = ui.squad_equipment.setting_ammo_scroll_position;
    } else if (ui.squad_equipment.open && ui.squad_equipment.customizing_equipment &&
               ui.squad_equipment.customizing_squad_id >= 0) {
        out.squad_id = ui.squad_equipment.customizing_squad_id;
        out.selected_identity_complete = true;
        out.mode = 5;
        out.scroll = ui.squad_equipment.scroll_position_cs;
        out.order_scroll = ui.squad_equipment.scroll_position_cssub;
    } else if (ui.custom_symbol.open &&
               ui.custom_symbol.context == df::custom_symbol_context_type::SQUAD_MENU &&
               ui.custom_symbol.squad_id >= 0) {
        out.squad_id = ui.custom_symbol.squad_id;
        out.selected_identity_complete = true;
        out.mode = 6;
        out.scroll = ui.custom_symbol.scroll_position;
    }
    state.route.input_active = squads.entering_squad_nickname || squads.entering_cell_nickname;
}

void capture_world(State& state) {
    if (!any_matches(state.route.focus, "world"))
        return;
    auto& out = state.world;
    out.focus = state.route.focus;
    out.viewscreen_type = "viewscreen_worldst";
    out.selection_kind = "none";
    out.identity_complete = false;
    auto* screen = strict_virtual_cast<df::viewscreen_worldst>(DFHack::Gui::getCurViewscreen(true));
    if (!screen) {
        fail(out.meta, SliceStatus::unsupported, "viewscreen_mismatch");
        return;
    }
    set_ok(out.meta);
    out.tab = integer(screen->view_mode);
    switch (screen->view_mode) {
    case df::world_view_mode_type::CIVILIZATIONS:
        out.scroll = screen->scroll_position_civlist;
        out.selection_kind = "civilization";
        break;
    case df::world_view_mode_type::MISSIONS_LIST:
        out.scroll = screen->scroll_position_ac;
        out.selection_kind = "mission";
        break;
    case df::world_view_mode_type::MISSION_DETAILS:
        out.scroll = screen->scroll_position_mission;
        out.selection_kind = "mission_detail";
        break;
    case df::world_view_mode_type::NEWS:
        out.scroll = screen->scroll_position_rumor;
        out.selection_kind = "news";
        break;
    case df::world_view_mode_type::REPORTS:
        out.scroll = screen->scroll_position_report;
        out.selection_kind = "report";
        break;
    case df::world_view_mode_type::CITIZENS:
        out.scroll = screen->scroll_position_citizens;
        out.selection_kind = "citizen";
        break;
    case df::world_view_mode_type::ARTIFACTS:
        out.scroll = screen->scroll_position_artifacts;
        out.selection_kind = "artifact";
        break;
    default:
        out.scroll = -1;
        break;
    }
}

void capture_palette(State& state, df::main_interface& ui) {
    const bool designation = any_matches(state.route.focus, "dwarfmode/Designate");
    const bool build = any_matches(state.route.focus, "dwarfmode/Building");
    const bool zone = any_matches(state.route.focus, "dwarfmode/Zone");
    const bool stockpile = any_matches(state.route.focus, "dwarfmode/Stockpile");
    const bool burrow = any_matches(state.route.focus, "dwarfmode/Burrow");
    const bool hauling = any_matches(state.route.focus, "dwarfmode/Hauling");
    if (!designation && !build && !zone && !stockpile && !burrow && !hauling)
        return;

    auto& out = state.palette;
    set_ok(out.meta);
    if (designation) {
        out.tool_family = "designation";
        out.mode = integer(ui.main_designation_selected);
        out.stage = ui.main_designation_doing_rectangles ? 4 : 0;
        out.marker_only = ui.designation.marker_only;
        out.show_priorities = ui.designation.show_priorities;
        out.priority = ui.designation.priority;
        out.mine_mode = integer(ui.designation.mine_mode);
        out.advanced = ui.designation.show_advanced_options;
    } else if (build) {
        out.tool_family = "build";
        out.mode = integer(ui.building.job);
        out.stage = ui.building.material >= 0 ? 2 : 1;
        out.build_category = integer(ui.building.category);
        out.build_selected = ui.building.selected;
        out.build_material = ui.building.material;
        out.build_matgloss = ui.building.matgloss;
        out.build_job = integer(ui.building.job);
        out.build_item_flags = ui.building.job_item_flag.whole;
    } else if (zone) {
        out.tool_family = "zone";
        out.mode = integer(ui.civzone.adding_new_type);
        out.stage = ui.civzone.erasing ? 5 : ui.civzone.repainting ? 6
                    : ui.civzone.doing_rectangle ? 4 : 3;
        out.zone_remove = ui.civzone.remove;
        out.zone_rectangle = ui.civzone.doing_rectangle;
        out.zone_multizone = ui.civzone.doing_multizone;
        out.zone_erase = ui.civzone.erasing;
        out.zone_repaint = ui.civzone.repainting;
        out.zone_type = integer(ui.civzone.adding_new_type);
        out.zone_flow_shape = integer(ui.civzone.flow_shape);
        out.zone_building_id = ui.civzone.cur_bld ? ui.civzone.cur_bld->id : -1;
    } else if (stockpile) {
        out.tool_family = "stockpile";
        out.stage = ui.stockpile.erasing ? 5 : ui.stockpile.repainting ? 6
                    : ui.stockpile.doing_rectangle ? 4 : 3;
        out.stockpile_rectangle = ui.stockpile.doing_rectangle;
        out.stockpile_erase = ui.stockpile.erasing;
        out.stockpile_repaint = ui.stockpile.repainting;
        out.stockpile_building_id = ui.stockpile.cur_bld ? ui.stockpile.cur_bld->id : -1;
    } else if (burrow) {
        out.tool_family = "burrow";
        out.stage = ui.burrow.erasing ? 5 : ui.burrow.doing_rectangle ? 4 : 3;
        out.burrow_rectangle = ui.burrow.doing_rectangle;
        out.burrow_erase = ui.burrow.erasing;
        out.burrow_id = ui.burrow.painting_burrow ? ui.burrow.painting_burrow->id : -1;
        out.burrow_scroll = ui.burrow.scroll_position;
    } else {
        out.tool_family = "hauling";
        out.stage = 0;
        if (ui.hauling_stop_conditions.open) {
            out.stage = 1;
            out.mode = integer(ui.hauling_stop_conditions.context);
            out.hauling_route_id = ui.hauling_stop_conditions.route_id;
            out.hauling_stop_id = ui.hauling_stop_conditions.stop_id;
            out.hauling_scroll = ui.hauling_stop_conditions.scroll_position;
        } else if (ui.assign_vehicle.open) {
            out.stage = 2;
            out.mode = integer(ui.assign_vehicle.context);
            out.hauling_route_id = ui.assign_vehicle.route_id;
            out.hauling_scroll = ui.assign_vehicle.scroll_position;
        }
    }
}

bool enrich_unit(UnitSelected& out) {
    if (out.meta.status != SliceStatus::ok)
        return true;
    if (out.unit_id < 0) {
        fail(out.meta, SliceStatus::invalid_identity, "unit_id_missing");
        return true;
    }
    auto* unit = df::unit::find(out.unit_id);
    if (!unit || unit->id != out.unit_id) {
        fail(out.meta, SliceStatus::invalid_identity, "unit_not_found");
        return true;
    }
    if (unit->inventory.size() > kUnitInventoryCap ||
        (unit->status.current_soul && unit->status.current_soul->skills.size() > kUnitSkillCap)) {
        fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
        return true;
    }
    out.race = unit->race;
    out.caste = unit->caste;
    out.profession = integer(unit->profession);
    out.flags1 = unit->flags1.whole;
    out.flags2 = unit->flags2.whole;
    out.flags3 = unit->flags3.whole;
    out.x = unit->pos.x;
    out.y = unit->pos.y;
    out.z = unit->pos.z;
    if (unit->job.current_job) {
        out.current_job_id = unit->job.current_job->id;
        out.current_job_type = integer(unit->job.current_job->job_type);
    }
    out.hunger = unit->counters2.hunger_timer;
    out.thirst = unit->counters2.thirst_timer;
    out.sleepiness = unit->counters2.sleepiness_timer;
    if (unit->status.current_soul)
        out.longterm_stress = unit->status.current_soul->personality.longterm_stress;
    out.inventory.reserve(unit->inventory.size());
    for (auto* row : unit->inventory) {
        if (row && row->item)
            out.inventory.push_back({row->item->id, integer(row->mode)});
    }
    if (unit->status.current_soul) {
        out.skills.reserve(unit->status.current_soul->skills.size());
        for (auto* skill : unit->status.current_soul->skills) {
            if (skill)
                out.skills.push_back({integer(skill->id), integer(skill->rating), skill->experience,
                                      skill->rusty});
        }
    }
    return true;
}

bool enrich_stock_item(StockItemSelected& out) {
    if (out.meta.status != SliceStatus::ok || out.item_id < 0)
        return true;
    auto* item = df::item::find(out.item_id);
    if (!item || item->id != out.item_id) {
        fail(out.meta, SliceStatus::invalid_identity, "item_not_found");
        return true;
    }
    if (item->general_refs.size() > kItemGeneralRefCap) {
        fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
        return true;
    }
    out.type = integer(item->getType());
    out.subtype = item->getSubtype();
    out.mat_type = item->getMaterial();
    out.mat_index = item->getMaterialIndex();
    out.stack_size = item->getStackSize();
    out.quality = item->getQuality();
    out.wear = item->getWear();
    out.flags = item->flags.whole;
    out.holder_refs.reserve(std::min(item->general_refs.size(), kItemRefCap));
    for (auto* ref : item->general_refs) {
        if (!ref)
            continue;
        const auto type = ref->getType();
        if (type == df::general_ref_type::CONTAINS_ITEM) {
            if (out.contained_item_ids.size() == kItemContainedCap) {
                fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
                out.holder_refs.clear();
                out.contained_item_ids.clear();
                return true;
            }
            out.contained_item_ids.push_back(ref->getID());
            continue;
        }
        if (type != df::general_ref_type::CONTAINED_IN_ITEM &&
            type != df::general_ref_type::UNIT_HOLDER &&
            type != df::general_ref_type::BUILDING_HOLDER)
            continue;
        if (out.holder_refs.size() == kItemRefCap) {
            fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
            out.holder_refs.clear();
            out.contained_item_ids.clear();
            return true;
        }
        std::string key = DFHack::enum_item_key(ref->getType());
        out.holder_refs.push_back({key.empty() ? "UNKNOWN" : key, ref->getID()});
    }
    return true;
}

bool enrich_place(PlaceSelected& out) {
    if (out.meta.status != SliceStatus::ok)
        return true;
    if (out.location_id >= 0) {
        auto* location = find_site_location(out.site_id, out.location_id);
        if (!location || location->id != out.location_id) {
            fail(out.meta, SliceStatus::invalid_identity, "location_not_found");
            return true;
        }
        out.location_type = integer(location->getType());
    }
    if (out.building_id < 0)
        return true;
    auto* building = df::building::find(out.building_id);
    if (!building || building->id != out.building_id) {
        fail(out.meta, SliceStatus::invalid_identity, "building_not_found");
        return true;
    }
    if (out.place_kind == "zone") {
        auto* zone = virtual_cast<df::building_civzonest>(building);
        if (!zone) {
            fail(out.meta, SliceStatus::invalid_identity, "place_kind_mismatch");
            return true;
        }
        if (zone->assigned_units.size() > kPlaceUnitCap ||
            zone->squad_room_info.size() > kPlaceSquadCap) {
            fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
            return true;
        }
        out.zone_type = integer(zone->type);
        out.assigned_unit_ids.assign(zone->assigned_units.begin(), zone->assigned_units.end());
        out.assigned_squad_ids.reserve(zone->squad_room_info.size());
        for (auto* info : zone->squad_room_info) {
            if (info)
                out.assigned_squad_ids.push_back(info->squad_id);
        }
    }
    out.x1 = building->x1;
    out.y1 = building->y1;
    out.x2 = building->x2;
    out.y2 = building->y2;
    out.z = building->z;
    out.flags = building->flags.whole;
    if (auto* actual = virtual_cast<df::building_actual>(building)) {
        if (actual->contained_items.size() > kPlaceItemCap) {
            fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
            out.contained_item_ids.clear();
            return true;
        }
        out.contained_item_ids.clear();
        out.contained_item_ids.reserve(actual->contained_items.size());
        for (auto* row : actual->contained_items) {
            if (row && row->item)
                out.contained_item_ids.push_back(row->item->id);
        }
    }
    return true;
}

bool enrich_building(BuildingSelected& out) {
    if (out.meta.status != SliceStatus::ok)
        return true;
    df::building* building = nullptr;
    if (out.building_id >= 0) {
        building = df::building::find(out.building_id);
        if (!building || building->id != out.building_id) {
            fail(out.meta, SliceStatus::invalid_identity, "building_not_found");
            return true;
        }
        if (building->jobs.size() > kBuildingJobCap) {
            fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
            return true;
        }
        out.building_type = integer(building->getType());
        out.building_subtype = building->getSubtype();
        out.building_custom = building->getCustomType();
        out.mat_type = building->mat_type;
        out.mat_index = building->mat_index;
        out.x1 = building->x1;
        out.y1 = building->y1;
        out.x2 = building->x2;
        out.y2 = building->y2;
        out.z = building->z;
        out.job_ids.reserve(building->jobs.size());
        for (auto* job : building->jobs) {
            if (job)
                out.job_ids.push_back(job->id);
        }
        if (auto* actual = virtual_cast<df::building_actual>(building)) {
            if (actual->contained_items.size() > kBuildingItemCap) {
                fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
                out.job_ids.clear();
                return true;
            }
            out.contained_item_ids.reserve(actual->contained_items.size());
            out.contained_items_supported = true;
            for (auto* row : actual->contained_items) {
                if (row && row->item)
                    out.contained_item_ids.push_back(row->item->id);
            }
        }
    }
    if (out.selected_job_id < 0)
        return true;
    if (!building) {
        fail(out.meta, SliceStatus::invalid_identity, "job_parent_missing");
        return true;
    }
    df::job* selected = nullptr;
    for (auto* job : building->jobs) {
        if (job && job->id == out.selected_job_id) {
            selected = job;
            break;
        }
    }
    if (!selected) {
        fail(out.meta, SliceStatus::invalid_identity, "job_not_found");
        return true;
    }
    if (selected->job_items.elements.size() > kJobItemCap) {
        fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
        return true;
    }
    out.selected_job_type = integer(selected->job_type);
    out.selected_job_flags = selected->flags.whole;
    out.selected_job_item_types.reserve(selected->job_items.elements.size());
    for (auto* item : selected->job_items.elements) {
        if (item)
            out.selected_job_item_types.push_back(integer(item->item_type));
    }
    return true;
}

bool enrich_squad(SquadUi& out) {
    if (out.meta.status != SliceStatus::ok || out.squad_id < 0)
        return true;
    auto* squad = df::squad::find(out.squad_id);
    if (!squad || squad->id != out.squad_id) {
        fail(out.meta, SliceStatus::invalid_identity, "squad_not_found");
        out.selected_identity_complete = false;
        return true;
    }
    if (squad->positions.size() > kSquadPositionCap || squad->orders.size() > kSquadOrderCap ||
        squad->schedule.routine.size() > kSquadRoutineCap) {
        fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
        return true;
    }
    size_t schedule_orders = 0;
    for (auto* routine : squad->schedule.routine) {
        if (!routine)
            continue;
        for (const auto& month : routine->month) {
            schedule_orders += month.orders.size();
            if (schedule_orders > kSquadOrderCap) {
                fail(out.meta, SliceStatus::unsupported, "cap_exceeded");
                return true;
            }
        }
    }
    out.entity_id = squad->entity_id;
    out.leader_assignment = squad->leader_assignment;
    out.position_hf_ids.reserve(squad->positions.size());
    for (auto* position : squad->positions) {
        if (position)
            out.position_hf_ids.push_back(position->occupant);
    }
    out.active_order_count = static_cast<int32_t>(squad->orders.size());
    out.schedule_order_count = static_cast<int32_t>(schedule_orders);
    return true;
}

bool enrich_core_impl(State& state) {
    enrich_unit(state.unit);
    enrich_stock_item(state.stock_item);
    enrich_place(state.place);
    enrich_building(state.building);
    enrich_squad(state.squad);
    return true;
}

void append_nullable(std::ostringstream& out, int32_t value) {
    if (value < 0)
        out << "null";
    else
        out << value;
}

void append_bool(std::ostringstream& out, bool value) {
    out << (value ? "true" : "false");
}

void append_string_array(std::ostringstream& out, const std::vector<std::string>& values) {
    out << '[';
    for (size_t i = 0; i < values.size(); ++i) {
        if (i)
            out << ',';
        out << json_string(values[i]);
    }
    out << ']';
}

void append_int_array(std::ostringstream& out, const std::vector<int32_t>& values) {
    out << '[';
    for (size_t i = 0; i < values.size(); ++i) {
        if (i)
            out << ',';
        out << values[i];
    }
    out << ']';
}

void envelope_begin(std::ostringstream& out, const char* id, const SliceMeta& meta) {
    out << "{\"id\":" << json_string(id) << ",\"version\":1,\"status\":"
        << json_string(status_name(meta.status)) << ",\"identity\":";
}

void envelope_end(std::ostringstream& out, const SliceMeta& meta) {
    if (meta.status != SliceStatus::ok)
        out << ",\"reason\":" << json_string(meta.reason.empty() ? "unspecified" : meta.reason);
    out << '}';
}

void serialize_route(std::ostringstream& out, const RouteContext& value) {
    envelope_begin(out, "route_context.v1", value.meta);
    out << "{\"focus\":";
    append_string_array(out, value.focus);
    out << ",\"surface_families\":";
    append_string_array(out, value.surface_families);
    out << ",\"ui_hash\":" << json_string(uint64_hex(value.ui_hash))
        << ",\"route_stamp\":" << json_string(uint64_hex(value.route_stamp)) << '}';
    out << ",\"payload\":";
    if (value.meta.status == SliceStatus::ok) {
        out << "{\"primary_kind\":" << json_string(value.primary_kind) << ",\"primary_id\":";
        append_nullable(out, value.primary_id);
        out << ",\"tab\":";
        append_nullable(out, value.tab);
        out << ",\"mode\":";
        append_nullable(out, value.mode);
        out << ",\"scroll\":";
        append_nullable(out, value.scroll);
        out << ",\"input_active\":";
        append_bool(out, value.input_active);
        out << '}';
    } else {
        out << "{}";
    }
    envelope_end(out, value.meta);
}

void serialize_unit(std::ostringstream& out, const UnitSelected& value) {
    envelope_begin(out, "unit_selected.v1", value.meta);
    out << "{\"unit_id\":";
    append_nullable(out, value.unit_id);
    out << ",\"active_sheet\":";
    append_nullable(out, value.active_sheet);
    out << ",\"active_sub_tab\":";
    append_nullable(out, value.active_sub_tab);
    out << "},\"payload\":";
    if (value.meta.status != SliceStatus::ok) {
        out << "{}";
        envelope_end(out, value.meta);
        return;
    }
    out << "{\"scroll_position\":" << value.scroll_position << ",\"race\":" << value.race
        << ",\"caste\":" << value.caste << ",\"profession\":" << value.profession
        << ",\"flags\":{\"flags1\":" << value.flags1 << ",\"flags2\":" << value.flags2
        << ",\"flags3\":" << value.flags3 << "},\"position\":{\"x\":" << value.x
        << ",\"y\":" << value.y << ",\"z\":" << value.z << "},\"current_job_id\":";
    append_nullable(out, value.current_job_id);
    out << ",\"current_job_type\":";
    append_nullable(out, value.current_job_type);
    out << ",\"counters\":{\"hunger\":" << value.hunger << ",\"thirst\":" << value.thirst
        << ",\"sleepiness\":" << value.sleepiness << ",\"longterm_stress\":"
        << value.longterm_stress << "},\"inventory\":[";
    for (size_t i = 0; i < value.inventory.size(); ++i) {
        if (i) out << ',';
        out << "{\"item_id\":" << value.inventory[i].item_id << ",\"mode\":"
            << value.inventory[i].mode << '}';
    }
    out << "],\"skills\":[";
    for (size_t i = 0; i < value.skills.size(); ++i) {
        if (i) out << ',';
        const auto& row = value.skills[i];
        out << "{\"id\":" << row.id << ",\"rating\":" << row.rating
            << ",\"experience\":" << row.experience << ",\"rust\":" << row.rust << '}';
    }
    out << "]}";
    envelope_end(out, value.meta);
}

void serialize_stock(std::ostringstream& out, const StockItemSelected& value) {
    envelope_begin(out, "stock_item_selected.v1", value.meta);
    out << "{\"surface\":" << json_string(value.surface) << ",\"item_id\":";
    append_nullable(out, value.item_id);
    out << ",\"stock_category\":";
    append_nullable(out, value.stock_category);
    out << "},\"payload\":";
    if (value.meta.status != SliceStatus::ok) {
        out << "{}";
        envelope_end(out, value.meta);
        return;
    }
    out << "{\"category_scroll\":" << value.category_scroll << ",\"item_scroll\":"
        << value.item_scroll << ",\"filter_active\":";
    append_bool(out, value.filter_active);
    out << ",\"filter_nonempty\":";
    append_bool(out, value.filter_nonempty);
    out << ",\"type\":";
    append_nullable(out, value.type);
    out << ",\"subtype\":";
    append_nullable(out, value.subtype);
    out << ",\"material\":";
    if (value.mat_type < 0) out << "null";
    else out << "{\"type\":" << value.mat_type << ",\"index\":" << value.mat_index << '}';
    out << ",\"stack_size\":";
    append_nullable(out, value.stack_size);
    out << ",\"quality\":";
    append_nullable(out, value.quality);
    out << ",\"wear\":";
    append_nullable(out, value.wear);
    out << ",\"flags\":";
    if (value.item_id < 0) out << "null"; else out << value.flags;
    out << ",\"holder_refs\":[";
    for (size_t i = 0; i < value.holder_refs.size(); ++i) {
        if (i) out << ',';
        out << "{\"type\":" << json_string(value.holder_refs[i].type) << ",\"id\":"
            << value.holder_refs[i].id << '}';
    }
    out << "],\"contained_item_ids\":";
    append_int_array(out, value.contained_item_ids);
    out << '}';
    envelope_end(out, value.meta);
}

void serialize_place(std::ostringstream& out, const PlaceSelected& value) {
    envelope_begin(out, "place_selected.v1", value.meta);
    out << "{\"place_kind\":" << json_string(value.place_kind) << ",\"building_id\":";
    append_nullable(out, value.building_id);
    out << ",\"location_id\":";
    append_nullable(out, value.location_id);
    out << ",\"site_id\":";
    append_nullable(out, value.site_id);
    out << "},\"payload\":";
    if (value.meta.status != SliceStatus::ok) {
        out << "{}";
        envelope_end(out, value.meta);
        return;
    }
    out << "{\"zone_type\":";
    append_nullable(out, value.zone_type);
    out << ",\"bounds\":";
    if (value.building_id < 0) out << "null";
    else out << "{\"x1\":" << value.x1 << ",\"y1\":" << value.y1 << ",\"x2\":"
             << value.x2 << ",\"y2\":" << value.y2 << ",\"z\":" << value.z << '}';
    out << ",\"flags\":";
    if (value.building_id < 0) out << "null"; else out << value.flags;
    out << ",\"location_type\":";
    append_nullable(out, value.location_type);
    out << ",\"assigned_unit_ids\":";
    if (value.place_kind == "zone") append_int_array(out, value.assigned_unit_ids);
    else out << "null";
    out << ",\"assigned_squad_ids\":";
    if (value.place_kind == "zone") append_int_array(out, value.assigned_squad_ids);
    else out << "null";
    out << ",\"contained_item_ids\":null";
    out << ",\"ui_flags\":{\"remove\":";
    append_bool(out, value.remove);
    out << ",\"rectangle\":";
    append_bool(out, value.rectangle);
    out << ",\"multizone\":";
    append_bool(out, value.multizone);
    out << ",\"erase\":";
    append_bool(out, value.erase);
    out << ",\"repaint\":";
    append_bool(out, value.repaint);
    out << ",\"context\":" << value.context << ",\"scroll\":" << value.scroll << "}}";
    envelope_end(out, value.meta);
}

void serialize_building(std::ostringstream& out, const BuildingSelected& value) {
    envelope_begin(out, "building_selected.v1", value.meta);
    out << "{\"building_id\":";
    append_nullable(out, value.building_id);
    out << ",\"building_type\":";
    append_nullable(out, value.building_type);
    out << ",\"picker_stage\":" << value.picker_stage << ",\"selected_job_id\":";
    append_nullable(out, value.selected_job_id);
    out << "},\"payload\":";
    if (value.meta.status != SliceStatus::ok) {
        out << "{}";
        envelope_end(out, value.meta);
        return;
    }
    out << "{\"building_subtype\":";
    append_nullable(out, value.building_subtype);
    out << ",\"building_custom\":";
    append_nullable(out, value.building_custom);
    out << ",\"material\":";
    if (value.mat_type < 0) out << "null";
    else out << "{\"type\":" << value.mat_type << ",\"index\":" << value.mat_index << '}';
    out << ",\"bounds\":";
    if (value.building_id < 0) out << "null";
    else out << "{\"x1\":" << value.x1 << ",\"y1\":" << value.y1 << ",\"x2\":"
             << value.x2 << ",\"y2\":" << value.y2 << ",\"z\":" << value.z << '}';
    out << ",\"view_tab\":" << value.view_tab << ",\"picker_category\":";
    append_nullable(out, value.picker_category);
    out << ",\"picker_selected\":";
    append_nullable(out, value.picker_selected);
    out << ",\"picker_job_type\":";
    append_nullable(out, value.picker_job_type);
    out << ",\"picker_material\":";
    if (value.picker_mat_type < 0) out << "null";
    else out << "{\"type\":" << value.picker_mat_type << ",\"index\":"
             << value.picker_mat_index << '}';
    out << ",\"selected_job\":";
    if (value.selected_job_id < 0) out << "null";
    else {
        out << "{\"type\":" << value.selected_job_type << ",\"flags\":"
            << value.selected_job_flags << ",\"item_types\":";
        append_int_array(out, value.selected_job_item_types);
        out << '}';
    }
    out << ",\"job_ids\":";
    append_int_array(out, value.job_ids);
    out << ",\"contained_item_ids\":";
    if (value.contained_items_supported) append_int_array(out, value.contained_item_ids);
    else out << "null";
    out << '}';
    envelope_end(out, value.meta);
}

void serialize_squad(std::ostringstream& out, const SquadUi& value) {
    envelope_begin(out, "squad_ui.v1", value.meta);
    out << "{\"mode\":" << value.mode << ",\"squad_id\":";
    append_nullable(out, value.squad_id);
    out << ",\"schedule_month\":";
    append_nullable(out, value.schedule_month);
    out << ",\"schedule_routine\":";
    append_nullable(out, value.schedule_routine);
    out << "},\"payload\":";
    if (value.meta.status != SliceStatus::ok) {
        out << "{}";
        envelope_end(out, value.meta);
        return;
    }
    out << "{\"viewing_squad_index\":";
    append_nullable(out, value.viewing_squad_index);
    out << ",\"selected_identity_complete\":";
    append_bool(out, value.selected_identity_complete);
    out << ",\"order_mode_flags\":{\"move\":";
    append_bool(out, value.move_order);
    out << ",\"kill\":";
    append_bool(out, value.kill_order);
    out << ",\"patrol\":";
    append_bool(out, value.patrol_order);
    out << ",\"burrow\":";
    append_bool(out, value.burrow_order);
    out << ",\"disband_confirmation\":";
    append_bool(out, value.disband_confirmation);
    out << "},\"schedule_whole_squad\":";
    append_bool(out, value.schedule_whole_squad);
    out << ",\"scrolls\":{\"main\":" << value.scroll << ",\"orders\":" << value.order_scroll
        << "},\"squad\":";
    if (!value.selected_identity_complete) out << "null";
    else {
        out << "{\"entity_id\":" << value.entity_id << ",\"leader_assignment\":"
            << value.leader_assignment << ",\"position_hf_ids\":";
        append_int_array(out, value.position_hf_ids);
        out << ",\"active_order_count\":" << value.active_order_count
            << ",\"schedule_order_count\":" << value.schedule_order_count << '}';
    }
    out << '}';
    envelope_end(out, value.meta);
}

void serialize_world(std::ostringstream& out, const WorldUi& value) {
    envelope_begin(out, "world_ui.v1", value.meta);
    out << "{\"focus\":";
    append_string_array(out, value.focus);
    out << ",\"viewscreen_type\":" << json_string(value.viewscreen_type) << ",\"tab\":";
    append_nullable(out, value.tab);
    out << ",\"selected_index\":";
    append_nullable(out, value.selected_index);
    out << "},\"payload\":";
    if (value.meta.status != SliceStatus::ok) {
        out << "{}";
        envelope_end(out, value.meta);
        return;
    }
    out << "{\"scroll\":";
    append_nullable(out, value.scroll);
    out << ",\"selection_kind\":" << json_string(value.selection_kind)
        << ",\"selection_id\":";
    append_nullable(out, value.selection_id);
    out << ",\"identity_complete\":";
    append_bool(out, value.identity_complete);
    out << '}';
    envelope_end(out, value.meta);
}

void serialize_palette(std::ostringstream& out, const ControlPalette& value) {
    envelope_begin(out, "control_palette.v1", value.meta);
    out << "{\"tool_family\":" << json_string(value.tool_family) << ",\"mode\":";
    append_nullable(out, value.mode);
    out << ",\"stage\":" << value.stage << "},\"payload\":";
    if (value.meta.status != SliceStatus::ok) {
        out << "{}";
        envelope_end(out, value.meta);
        return;
    }
    out << '{';
    if (value.tool_family == "designation") {
        out << "\"designation\":{\"marker_only\":";
        append_bool(out, value.marker_only);
        out << ",\"show_priorities\":";
        append_bool(out, value.show_priorities);
        out << ",\"priority\":" << value.priority << ",\"mine_mode\":" << value.mine_mode
            << ",\"advanced\":";
        append_bool(out, value.advanced);
        out << '}';
    } else if (value.tool_family == "build") {
        out << "\"build\":{\"category\":" << value.build_category << ",\"selected\":"
            << value.build_selected << ",\"material\":" << value.build_material
            << ",\"matgloss\":" << value.build_matgloss << ",\"job\":" << value.build_job
            << ",\"item_flags\":" << value.build_item_flags << '}';
    } else if (value.tool_family == "zone") {
        out << "\"zone\":{\"remove\":";
        append_bool(out, value.zone_remove);
        out << ",\"rectangle\":";
        append_bool(out, value.zone_rectangle);
        out << ",\"multizone\":";
        append_bool(out, value.zone_multizone);
        out << ",\"erase\":";
        append_bool(out, value.zone_erase);
        out << ",\"repaint\":";
        append_bool(out, value.zone_repaint);
        out << ",\"type\":" << value.zone_type << ",\"flow_shape\":" << value.zone_flow_shape
            << ",\"building_id\":";
        append_nullable(out, value.zone_building_id);
        out << '}';
    } else if (value.tool_family == "stockpile") {
        out << "\"stockpile\":{\"rectangle\":";
        append_bool(out, value.stockpile_rectangle);
        out << ",\"erase\":";
        append_bool(out, value.stockpile_erase);
        out << ",\"repaint\":";
        append_bool(out, value.stockpile_repaint);
        out << ",\"building_id\":";
        append_nullable(out, value.stockpile_building_id);
        out << '}';
    } else if (value.tool_family == "burrow") {
        out << "\"burrow\":{\"rectangle\":";
        append_bool(out, value.burrow_rectangle);
        out << ",\"erase\":";
        append_bool(out, value.burrow_erase);
        out << ",\"burrow_id\":";
        append_nullable(out, value.burrow_id);
        out << ",\"scroll\":" << value.burrow_scroll << '}';
    } else if (value.tool_family == "hauling") {
        out << "\"hauling\":{\"route_id\":";
        append_nullable(out, value.hauling_route_id);
        out << ",\"stop_id\":";
        append_nullable(out, value.hauling_stop_id);
        out << ",\"scroll\":";
        append_nullable(out, value.hauling_scroll);
        out << '}';
    }
    out << '}';
    envelope_end(out, value.meta);
}

} // namespace

const char* status_name(SliceStatus status) {
    switch (status) {
    case SliceStatus::ok: return "ok";
    case SliceStatus::not_applicable: return "not_applicable";
    case SliceStatus::unsupported: return "unsupported";
    case SliceStatus::busy: return "busy";
    case SliceStatus::invalid_identity: return "invalid_identity";
    case SliceStatus::fault: return "fault";
    }
    return "fault";
}

std::string uint64_hex(uint64_t value) {
    std::ostringstream out;
    out << std::hex << std::nouppercase << std::setfill('0') << std::setw(16) << value;
    return out.str();
}

std::string enabled_slices_json() {
    return "[{\"id\":\"route_context.v1\",\"version\":1},"
           "{\"id\":\"unit_selected.v1\",\"version\":1},"
           "{\"id\":\"stock_item_selected.v1\",\"version\":1},"
           "{\"id\":\"place_selected.v1\",\"version\":1},"
           "{\"id\":\"building_selected.v1\",\"version\":1},"
           "{\"id\":\"squad_ui.v1\",\"version\":1},"
           "{\"id\":\"world_ui.v1\",\"version\":1},"
           "{\"id\":\"control_palette.v1\",\"version\":1}]";
}

void capture_render(State& state, const std::vector<std::string>& focus, uint64_t ui_hash,
                    int32_t dim_x, int32_t dim_y, int32_t gps_top_in_use) {
    state = State{};
    set_ok(state.route.meta);
    state.route.focus = focus;
    state.route.ui_hash = ui_hash;
    state.route.dim_x = dim_x;
    state.route.dim_y = dim_y;
    state.route.gps_top_in_use = gps_top_in_use;

    if (any_matches(focus, "dwarfmode/ViewSheets/UNIT")) add_family(state.route, "unit_sheets");
    if (any_matches(focus, "dwarfmode/Stocks") || any_matches(focus, "dwarfmode/ViewSheets/ITEM"))
        add_family(state.route, "stocks_items");
    if (any_matches(focus, "dwarfmode/Zone") || any_matches(focus, "dwarfmode/Stockpile") ||
        any_matches(focus, "dwarfmode/LocationDetails") ||
        any_matches(focus, "dwarfmode/LocationSelector") ||
        any_matches(focus, "dwarfmode/Info/BUILDINGS"))
        add_family(state.route, "zones_locations");
    if (any_matches(focus, "dwarfmode/ViewSheets/BUILDING") ||
        any_matches(focus, "dwarfmode/Building") || any_matches(focus, "dwarfmode/Info/BUILDINGS"))
        add_family(state.route, "buildings_workshops");
    if (any_matches(focus, "dwarfmode/Squads") || any_matches(focus, "dwarfmode/SquadSelector") ||
        any_matches(focus, "dwarfmode/AssignUniform"))
        add_family(state.route, "squads");
    if (any_matches(focus, "world")) add_family(state.route, "world");
    if (any_matches(focus, "dwarfmode/Designate") || any_matches(focus, "dwarfmode/Building") ||
        any_matches(focus, "dwarfmode/Zone") || any_matches(focus, "dwarfmode/Stockpile") ||
        any_matches(focus, "dwarfmode/Burrow") || any_matches(focus, "dwarfmode/Hauling"))
        add_family(state.route, "palettes_controls");
    if (state.route.surface_families.empty())
        state.route.surface_families.emplace_back("unmatched");

    if (!df::global::game) {
        fail(state.route.meta, SliceStatus::fault, "game_unavailable");
        state.route.route_stamp = make_route_stamp(state);
        return;
    }
    auto& ui = df::global::game->main_interface;
    capture_unit(state, ui);
    capture_stock_item(state, ui);
    capture_place(state, ui);
    capture_building(state, ui);
    capture_squad(state, ui);
    capture_world(state);
    capture_palette(state, ui);
    capture_route_primary(state);
    state.route.route_stamp = make_route_stamp(state);
}

bool enrich_core(State& state) {
#ifdef _MSC_VER
    __try {
        return enrich_core_impl(state);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        mark_core_fault(state);
        return false;
    }
#else
    return enrich_core_impl(state);
#endif
}

void mark_core_busy(State& state) {
    auto mark = [](SliceMeta& meta, bool needs_core) {
        if (needs_core && meta.status == SliceStatus::ok)
            fail(meta, SliceStatus::busy, "core_busy");
    };
    mark(state.unit.meta, state.unit.unit_id >= 0);
    mark(state.stock_item.meta, state.stock_item.item_id >= 0);
    mark(state.place.meta, state.place.building_id >= 0 || state.place.location_id >= 0);
    mark(state.building.meta,
         state.building.building_id >= 0 || state.building.selected_job_id >= 0);
    mark(state.squad.meta, state.squad.squad_id >= 0);
}

void mark_core_fault(State& state) {
    auto mark = [](SliceMeta& meta, bool needs_core) {
        if (needs_core && meta.status != SliceStatus::not_applicable)
            fail(meta, SliceStatus::fault, "core_fault");
    };
    mark(state.unit.meta, state.unit.unit_id >= 0);
    mark(state.stock_item.meta, state.stock_item.item_id >= 0);
    mark(state.place.meta, state.place.building_id >= 0 || state.place.location_id >= 0);
    mark(state.building.meta,
         state.building.building_id >= 0 || state.building.selected_job_id >= 0);
    mark(state.squad.meta, state.squad.squad_id >= 0);
}

void mark_render_mismatch(State& state) {
    auto mark = [](SliceMeta& meta) {
        if (meta.status == SliceStatus::ok)
            fail(meta, SliceStatus::invalid_identity, "render_mismatch");
    };
    mark(state.route.meta);
    mark(state.unit.meta);
    mark(state.stock_item.meta);
    mark(state.place.meta);
    mark(state.building.meta);
    mark(state.squad.meta);
    mark(state.world.meta);
    mark(state.palette.meta);
}

bool has_applicable_slice(const State& state) {
    return state.unit.meta.status != SliceStatus::not_applicable ||
           state.stock_item.meta.status != SliceStatus::not_applicable ||
           state.place.meta.status != SliceStatus::not_applicable ||
           state.building.meta.status != SliceStatus::not_applicable ||
           state.squad.meta.status != SliceStatus::not_applicable ||
           state.world.meta.status != SliceStatus::not_applicable ||
           state.palette.meta.status != SliceStatus::not_applicable;
}

bool route_equal(const RouteContext& left, const RouteContext& right) {
    return left.ui_hash == right.ui_hash && left.route_stamp == right.route_stamp &&
           left.focus == right.focus && left.dim_x == right.dim_x && left.dim_y == right.dim_y &&
           left.gps_top_in_use == right.gps_top_in_use;
}

bool route_equal(const State& left, const State& right) {
    return route_equal(left.route, right.route) && left.unit.unit_id == right.unit.unit_id &&
           left.unit.active_sheet == right.unit.active_sheet &&
           left.unit.active_sub_tab == right.unit.active_sub_tab &&
           left.stock_item.item_id == right.stock_item.item_id &&
           left.stock_item.stock_category == right.stock_item.stock_category &&
           left.place.building_id == right.place.building_id &&
           left.place.location_id == right.place.location_id &&
           left.place.site_id == right.place.site_id &&
           left.building.building_id == right.building.building_id &&
           left.building.selected_job_id == right.building.selected_job_id &&
           left.squad.squad_id == right.squad.squad_id &&
           left.squad.schedule_month == right.squad.schedule_month &&
           left.squad.schedule_routine == right.squad.schedule_routine &&
           left.world.selection_id == right.world.selection_id &&
           left.palette.tool_family == right.palette.tool_family &&
           left.palette.mode == right.palette.mode && left.palette.stage == right.palette.stage;
}

std::string serialize_slices(const State& state) {
    std::ostringstream out;
    out << '[';
    serialize_route(out, state.route);
    out << ',';
    serialize_unit(out, state.unit);
    out << ',';
    serialize_stock(out, state.stock_item);
    out << ',';
    serialize_place(out, state.place);
    out << ',';
    serialize_building(out, state.building);
    out << ',';
    serialize_squad(out, state.squad);
    out << ',';
    serialize_world(out, state.world);
    out << ',';
    serialize_palette(out, state.palette);
    out << ']';
    return out.str();
}

} // namespace dwf::recorder_v3
