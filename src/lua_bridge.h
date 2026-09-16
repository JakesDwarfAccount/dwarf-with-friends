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

#include "camera.h"

#include <cstdint>
#include <string>
#include <vector>

namespace dwf {

struct LuaBridgeHealth {
    uint64_t calls = 0;
    uint64_t successes = 0;
    uint64_t call_failures = 0;
    uint64_t signature_failures = 0;
};

LuaBridgeHealth lua_bridge_health_snapshot();

// Calls DFHack's own scripts/fix/stuck-squad.lua through dwf.lua's missions_rescue_stuck();
// the repair itself is never reimplemented here.
bool mission_rescue_stuck_via_lua(int& out_rescued, std::string& out_text, std::string* err = nullptr);

std::string building_catalog_json_via_lua(std::string* err = nullptr);
std::string build_materials_json_via_lua(const std::string& token, std::string* err = nullptr);
std::string place_candidates_json_via_lua(const std::string& token, std::string* err = nullptr);
bool place_building_via_lua(const Camera& camera, int px, int py, int px2, int py2,
                            int frame_w, int frame_h, const std::string& token,
                            int direction, const std::string& options, int selected_item_id,
                            int& out_count, int& out_id, std::string* err = nullptr,
                            std::vector<int32_t>* out_ids = nullptr);

bool create_stockpile_via_lua(const Camera& camera, int px, int py, int px2, int py2,
                              int frame_w, int frame_h, const std::string& preset,
                              int& out_id, std::string* err = nullptr);
bool create_stockpile_at_world_rect_via_lua(int x1, int y1, int x2, int y2, int z,
                                            const std::string& preset, int& out_id,
                                            std::string* err = nullptr);
bool create_zone_via_lua(const Camera& camera, int px, int py, int px2, int py2,
                         int frame_w, int frame_h, const std::string& zone_type,
                         int& out_id, std::string* err = nullptr);

bool create_zone_at_world_rect_via_lua(int x1, int y1, int x2, int y2, int z,
                                       const std::string& zone_type, int& out_id,
                                       std::string* err = nullptr);

std::string stockpile_groups_via_lua(const std::string& cat, std::string* err = nullptr);
std::string stockpile_items_via_lua(int32_t id, const std::string& cat,
                                    const std::string& group, std::string* err = nullptr);
std::string stockpile_settings_snapshot_via_lua(int32_t id, std::string* err = nullptr);
bool stockpile_toggle_item_via_lua(int32_t id, const std::string& cat,
                                   const std::string& group, int idx, bool on,
                                   std::string* err = nullptr);
bool stockpile_toggle_all_via_lua(int32_t id, const std::string& cat,
                                  const std::string& group, bool on,
                                  std::string* err = nullptr);
bool stockpile_set_preset_via_lua(int32_t id, const std::string& preset,
                                  const std::string& mode, std::string* err = nullptr);

// per-stop DESIRED ITEMS: df::hauling_stop.settings IS a df::stockpile_settings, so these are the
// five calls above pointed at a route stop. Same SP_CATEGORIES machinery -- no second item filter.
std::string hauling_stop_settings_snapshot_via_lua(int32_t route_id, int32_t stop_id,
                                                   std::string* err = nullptr);
std::string hauling_stop_items_via_lua(int32_t route_id, int32_t stop_id, const std::string& cat,
                                       const std::string& group, std::string* err = nullptr);
bool hauling_stop_toggle_item_via_lua(int32_t route_id, int32_t stop_id, const std::string& cat,
                                      const std::string& group, int idx, bool on,
                                      std::string* err = nullptr);
bool hauling_stop_toggle_all_via_lua(int32_t route_id, int32_t stop_id, const std::string& cat,
                                     const std::string& group, bool on, std::string* err = nullptr);
bool hauling_stop_set_preset_via_lua(int32_t route_id, int32_t stop_id, const std::string& preset,
                                     const std::string& mode, std::string* err = nullptr);

// One-shot save healing at SC_WORLD_LOADED: old saves can carry enabled stockpile categories with
// under-sized material lists, which DF's item matching dereferences blind.
bool repair_stockpile_settings_via_lua(int& out_holders, int& out_categories,
                                       std::string* err = nullptr);

std::string workshop_info_json_via_lua(int32_t id, std::string* err = nullptr);
bool workshop_add_job_via_lua(int32_t id, const std::string& task, int32_t unit_id = -1,
                              std::string* err = nullptr);
bool workshop_job_action_via_lua(int32_t id, int32_t job_id, const std::string& action,
                                 std::string* err = nullptr);
bool workshop_worker_action_via_lua(int32_t id, int32_t unit_id, bool assign,
                                    std::string* err = nullptr);
bool workshop_workers_clear_via_lua(int32_t id, std::string* err = nullptr);
bool workshop_profile_set_via_lua(int32_t id, const std::string& field, int32_t value,
                                  std::string* err = nullptr);

std::string burial_coffin_info_json_via_lua(int32_t id, std::string* err = nullptr);
bool burial_coffin_action_via_lua(int32_t id, const std::string& action,
                                  std::string* err = nullptr);
bool queue_memorial_slab_via_lua(int32_t unit_id, std::string* err = nullptr);

std::string zone_locations_json_via_lua(int32_t zone_id, std::string* err = nullptr);
bool zone_location_action_via_lua(int32_t zone_id, const std::string& action,
                                  const std::string& kind, int32_t location_id,
                                  std::string* err = nullptr);

// `location_id` is an abstract_building id (site-local), NOT a zone/building id. The action's
// payload rides in `kind` -- see location_action() in dwf.lua.
std::string location_detail_json_via_lua(int32_t location_id, std::string* err = nullptr);
bool location_action_via_lua(int32_t location_id, const std::string& action,
                             const std::string& kind, int32_t unit_id,
                             std::string* err = nullptr);

std::string order_json_via_lua(const char* function_name, std::string* err = nullptr);
std::string order_json_via_lua_str(const char* function_name, const std::string& arg,
                                   std::string* err = nullptr);
bool create_order_via_lua(const std::string& key, int32_t amount, const std::string& frequency,
                          int32_t workshop_id, std::string* msg = nullptr,
                          std::string* err = nullptr, std::vector<int32_t>* out_ids = nullptr);
bool import_order_preset_via_lua(const std::string& name, std::string* msg = nullptr,
                                 std::string* err = nullptr);
bool cancel_order_via_lua(int32_t id, std::string* err = nullptr);
bool adjust_order_via_lua(int32_t id, int32_t amount, const std::string& frequency,
                          std::string* err = nullptr);
bool add_item_condition_via_lua(int32_t id, const std::string& compare, int32_t value,
                                const std::string& item, const std::string& material,
                                const std::string& adjective, std::string* err = nullptr);
bool edit_item_condition_via_lua(int32_t id, int32_t index, const std::string& compare,
                                 int32_t value, const std::string& item,
                                 const std::string& material, const std::string& adjective,
                                 std::string* err = nullptr);
bool add_order_condition_via_lua(int32_t id, int32_t other_id, const std::string& type,
                                 std::string* err = nullptr);
bool edit_order_condition_via_lua(int32_t id, int32_t index, const std::string& type,
                                  std::string* err = nullptr);
bool remove_condition_via_lua(int32_t id, const std::string& kind, int32_t index,
                              std::string* err = nullptr);
bool set_order_max_workshops_via_lua(int32_t id, int32_t max_workshops,
                                     std::string* err = nullptr);
bool set_order_workshop_via_lua(int32_t id, int32_t workshop_id,
                                std::string* err = nullptr);
bool reorder_order_via_lua(int32_t id, int32_t direction, std::string* err = nullptr);

// ---- DFHack command console --------------------------------------------------------------
std::string console_catalog_json_via_lua(std::string* err = nullptr);

// Re-applies dwf::console::command_denied itself, so no C++ caller of this bridge can reach
// dfhack.run_command_silent ungated. A denied command returns false and executes nothing.
bool console_run_via_lua(const std::string& command, int& out_status, std::string& out_text,
                         std::string* err = nullptr);

// ---- HOST-WRITES (browser barter / justice convict) --------------------------------------------
// Thin wrappers over dwf.lua's hw_* engine: self-describing JSON, or "" with *err set on failure.
std::string trade_state_json_via_lua(std::string* err = nullptr);
std::string trade_action_json_via_lua(const std::string& action, const std::string& arg1,
                                      const std::string& arg2, const std::string& arg3,
                                      std::string* err = nullptr);
std::string justice_state_json_via_lua(std::string* err = nullptr);
// Runs the multi-frame native drive loop (retry protocol) to completion or timeout.
std::string justice_action_json_via_lua(const std::string& action, int32_t crime_id,
                                        int32_t unit_id, std::string* err = nullptr);
std::string hostwrites_widgets_json_via_lua(const std::string& root, std::string* err = nullptr);
// Reads one flag from dfcapture-hostwrites.json. Missing file, invalid JSON, missing key and
// non-boolean values all FAIL CLOSED.
bool hostwrite_flag_enabled_via_lua(const std::string& flag, std::string* err = nullptr);

inline int hostwrites_status_for(const std::string& json) {
    if (json.find("\"ok\":true") != std::string::npos) return 200;
    if (json.find("\"guarded\":true") != std::string::npos) return 501;
    if (json.find("\"retry\":true") != std::string::npos) return 503;
    return 400;
}

} // namespace dwf
