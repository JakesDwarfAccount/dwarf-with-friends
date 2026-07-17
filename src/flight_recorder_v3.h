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

#include <cstdint>
#include <string>
#include <vector>

namespace dwf::recorder_v3 {

inline constexpr const char* kExecutableSha256 =
    "683C721D1261E77FF862A2E01DFE3FF93D107AB7B1C92B5A3B6F313CCC8FC284";
inline constexpr const char* kDfStructuresCommit =
    "80a6267faddb7aa99759c9df94186de3f873dd97";
inline constexpr const char* kSlicePlanId = "df-flight-recorder-v3-combined-slices";

enum class SliceStatus { ok, not_applicable, unsupported, busy, invalid_identity, fault };

struct SliceMeta {
    SliceStatus status = SliceStatus::not_applicable;
    std::string reason = "focus";
};

struct RouteContext {
    SliceMeta meta;
    std::vector<std::string> focus;
    std::vector<std::string> surface_families;
    uint64_t ui_hash = 0;
    uint64_t route_stamp = 0;
    std::string primary_kind = "unmatched";
    int32_t primary_id = -1;
    int32_t tab = -1;
    int32_t mode = -1;
    int32_t scroll = -1;
    bool input_active = false;
    int32_t dim_x = 0, dim_y = 0, gps_top_in_use = 0;
};

struct UnitInventoryRow { int32_t item_id = -1, mode = -1; };
struct UnitSkillRow { int32_t id = -1, rating = -1, experience = 0, rust = 0; };
struct UnitSelected {
    SliceMeta meta;
    int32_t unit_id = -1, active_sheet = -1, active_sub_tab = -1, scroll_position = -1;
    int32_t race = -1, caste = -1, profession = -1;
    uint32_t flags1 = 0, flags2 = 0, flags3 = 0;
    int32_t x = -1, y = -1, z = -1, current_job_id = -1, current_job_type = -1;
    int32_t hunger = 0, thirst = 0, sleepiness = 0, longterm_stress = 0;
    std::vector<UnitInventoryRow> inventory;
    std::vector<UnitSkillRow> skills;
};

struct TypedId { std::string type; int32_t id = -1; };
struct StockItemSelected {
    SliceMeta meta;
    std::string surface = "none";
    int32_t item_id = -1, stock_category = -1;
    int32_t category_scroll = -1, item_scroll = -1;
    bool filter_active = false, filter_nonempty = false;
    int32_t type = -1, subtype = -1, mat_type = -1, mat_index = -1;
    int32_t stack_size = -1, quality = -1, wear = -1;
    uint32_t flags = 0;
    std::vector<TypedId> holder_refs;
    std::vector<int32_t> contained_item_ids;
};

struct PlaceSelected {
    SliceMeta meta;
    std::string place_kind = "none";
    int32_t building_id = -1, location_id = -1, site_id = -1;
    int32_t zone_type = -1, location_type = -1;
    int32_t x1 = -1, y1 = -1, x2 = -1, y2 = -1, z = -1;
    uint32_t flags = 0;
    std::vector<int32_t> assigned_unit_ids;
    std::vector<int32_t> assigned_squad_ids;
    std::vector<int32_t> contained_item_ids;
    bool remove = false, rectangle = false, multizone = false, erase = false, repaint = false;
    int32_t context = -1, scroll = -1;
};

struct BuildingSelected {
    SliceMeta meta;
    int32_t building_id = -1, building_type = -1, picker_stage = -1, selected_job_id = -1;
    int32_t building_subtype = -1, building_custom = -1, mat_type = -1, mat_index = -1;
    int32_t x1 = -1, y1 = -1, x2 = -1, y2 = -1, z = -1, view_tab = -1;
    int32_t picker_category = -1, picker_selected = -1, picker_job_type = -1;
    int32_t picker_mat_type = -1, picker_mat_index = -1;
    int32_t selected_job_type = -1;
    uint32_t selected_job_flags = 0;
    std::vector<int32_t> selected_job_item_types;
    std::vector<int32_t> job_ids;
    std::vector<int32_t> contained_item_ids;
    bool contained_items_supported = false;
};

struct SquadUi {
    SliceMeta meta;
    int32_t mode = -1, squad_id = -1, schedule_month = -1, schedule_routine = -1;
    int32_t viewing_squad_index = -1, scroll = -1, order_scroll = -1;
    bool selected_identity_complete = false;
    bool move_order = false, kill_order = false, patrol_order = false, burrow_order = false;
    bool disband_confirmation = false, schedule_whole_squad = false;
    int32_t entity_id = -1, leader_assignment = -1;
    std::vector<int32_t> position_hf_ids;
    int32_t active_order_count = 0, schedule_order_count = 0;
};

struct WorldUi {
    SliceMeta meta;
    std::vector<std::string> focus;
    std::string viewscreen_type = "world";
    int32_t tab = -1, selected_index = -1, scroll = -1;
    std::string selection_kind = "none";
    int32_t selection_id = -1;
    bool identity_complete = false;
};

struct ControlPalette {
    SliceMeta meta;
    std::string tool_family = "none";
    int32_t mode = -1, stage = -1;
    bool marker_only = false, show_priorities = false, advanced = false;
    int32_t priority = 0, mine_mode = -1;
    int32_t build_category = -1, build_selected = -1, build_material = -1;
    int32_t build_matgloss = -1, build_job = -1;
    uint32_t build_item_flags = 0;
    bool zone_remove = false, zone_rectangle = false, zone_multizone = false;
    bool zone_erase = false, zone_repaint = false;
    int32_t zone_type = -1, zone_flow_shape = -1, zone_building_id = -1;
    bool stockpile_rectangle = false, stockpile_erase = false, stockpile_repaint = false;
    int32_t stockpile_building_id = -1;
    bool burrow_rectangle = false, burrow_erase = false;
    int32_t burrow_id = -1, burrow_scroll = -1;
    int32_t hauling_route_id = -1, hauling_stop_id = -1, hauling_scroll = -1;
};

struct State {
    RouteContext route;
    UnitSelected unit;
    StockItemSelected stock_item;
    PlaceSelected place;
    BuildingSelected building;
    SquadUi squad;
    WorldUi world;
    ControlPalette palette;
};

const char* status_name(SliceStatus status);
std::string uint64_hex(uint64_t value);
std::string enabled_slices_json();
void capture_render(State& state, const std::vector<std::string>& focus, uint64_t ui_hash,
                    int32_t dim_x, int32_t dim_y, int32_t gps_top_in_use);
bool enrich_core(State& state);
void mark_core_busy(State& state);
void mark_core_fault(State& state);
void mark_render_mismatch(State& state);
bool has_applicable_slice(const State& state);
bool route_equal(const RouteContext& left, const RouteContext& right);
bool route_equal(const State& left, const State& right);
std::string serialize_slices(const State& state);

} // namespace dwf::recorder_v3
