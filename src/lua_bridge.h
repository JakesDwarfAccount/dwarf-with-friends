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

// B228 (missions): run DFHack's OWN scripts/fix/stuck-squad.lua to bring home squads that DF
// stranded (an army with controller_id != 0 and a null controller pointer -- dwarves that left on
// a mission and can never return). We do NOT reimplement the repair: this calls the upstream
// script through dwf.lua's missions_rescue_stuck(), which reqscript()s it. Returns the
// number of squads it rescued and the script's own console text. See src/missions.h.
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
// World-rect variant for /stockpile-repaint mode=replace (exact-mask repaint): the client sends
// the repaint footprint world-addressed, so no camera/pixel conversion is involved.
bool create_stockpile_at_world_rect_via_lua(int x1, int y1, int x2, int y2, int z,
                                            const std::string& preset, int& out_id,
                                            std::string* err = nullptr);
bool create_zone_via_lua(const Camera& camera, int px, int py, int px2, int py2,
                         int frame_w, int frame_h, const std::string& zone_type,
                         int& out_id, std::string* err = nullptr);

// Same lua-side "create_zone" as create_zone_via_lua, but takes an already-resolved WORLD tile
// rectangle directly (no pixel/viewport conversion). Used by /zone-repaint (building_zone.cpp),
// which computes the trimmed/extended footprint itself before recreating the zone there.
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

// B231 -- per-stop DESIRED ITEMS. df::hauling_stop.settings is a df::stockpile_settings (the same
// struct a pile carries), so these are the five calls above pointed at a route stop instead of a
// building. They run through the SAME dwf.lua SP_CATEGORIES machinery -- there is no second
// copy of the item filter. DFHack does exactly this in plugins/stockpiles (get_stop_settings()).
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

// B229: Places > Locations depth. `location_id` is an abstract_building id (site-local), NOT a
// zone/building id. The action's payload rides in `kind` (occupation type key or "id:<occId>",
// "hf:<id>"/"religion:<id>", or a profession key) -- see location_action() in dwf.lua.
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
bool remove_condition_via_lua(int32_t id, const std::string& kind, int32_t index,
                              std::string* err = nullptr);
bool set_order_max_workshops_via_lua(int32_t id, int32_t max_workshops,
                                     std::string* err = nullptr);
bool set_order_workshop_via_lua(int32_t id, int32_t workshop_id,
                                std::string* err = nullptr);
bool reorder_order_via_lua(int32_t id, int32_t direction, std::string* err = nullptr);

// ---- WT26 DFHack command console --------------------------------------------------------------
// Catalog: helpdb's own command list + short-help blurbs, as JSON. Read-only, no core mutation,
// static for a play session -> the client fetches it ONCE and filters client-side.
std::string console_catalog_json_via_lua(std::string* err = nullptr);

// Run one DFHack command line and return its captured console text (colored fragments flattened by
// the same lua_output_text path every other bridge fn uses) + DFHack's command_result status.
//
// *** THIS FN RE-APPLIES THE BLOCKLIST (dwf::console::command_denied, src/console_policy.h)
// BEFORE it executes anything -- the SAME table the POST /console/run handler checks. It is a
// backstop, not a duplicate: it exists so that NO future C++ caller of this bridge can reach
// dfhack.run_command_silent without passing the gate. A denied command returns false with the deny
// reason in *err and executes NOTHING. ***
//
// The command runs under a CoreSuspender for its whole duration and CANNOT be interrupted (spec
// section 7) -- containment is prevention (the table), never a timeout.
bool console_run_via_lua(const std::string& command, int& out_status, std::string& out_text,
                         std::string* err = nullptr);

// ---- HOST-WRITES (B226 browser barter / B227 justice convict) ----------------------------------
// Thin wrappers over the hw_* Lua engine (dwf.lua, "HOST-WRITES" section). All return
// self-describing JSON ({"ok":...}) or "" with *err set when the bridge itself failed. The
// action entries serialize behind a global drive mutex: one native-UI drive at a time.
std::string trade_state_json_via_lua(std::string* err = nullptr);
std::string trade_action_json_via_lua(const std::string& action, const std::string& arg1,
                                      const std::string& arg2, const std::string& arg3,
                                      std::string* err = nullptr);
std::string justice_state_json_via_lua(std::string* err = nullptr);
// Runs the multi-frame native drive loop (retry protocol) to completion or timeout.
std::string justice_action_json_via_lua(const std::string& action, int32_t crime_id,
                                        int32_t unit_id, std::string* err = nullptr);
std::string hostwrites_widgets_json_via_lua(const std::string& root, std::string* err = nullptr);
// Reads one boolean from the host-controlled dfcapture-hostwrites.json via the same Lua loader
// used by trade/justice. Missing file, invalid JSON, missing key, and non-boolean values all fail
// closed. This does not expose a way for HTTP clients to change the file.
bool hostwrite_flag_enabled_via_lua(const std::string& flag, std::string* err = nullptr);

// HTTP status for a hostwrites JSON verdict: 200 ok / 501 guarded-behind-probe (keeps the old
// clients' "host-only" handling working verbatim) / 503 retry-not-converged / 400 anything else.
inline int hostwrites_status_for(const std::string& json) {
    if (json.find("\"ok\":true") != std::string::npos) return 200;
    if (json.find("\"guarded\":true") != std::string::npos) return 501;
    if (json.find("\"retry\":true") != std::string::npos) return 503;
    return 400;
}

} // namespace dwf
