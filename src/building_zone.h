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

#include "art_desc.h"   // ItemArt -- the building's contained-item art + spriteRef
#include "camera.h"

#include <cstdint>
#include <string>
#include <vector>

namespace df { struct building; }

namespace dwf {

struct BuildingPanelInfo {
    int32_t id = -1;
    std::string name;
    bool exists = false;
    bool built = false;
    bool has_jobs = false;
    bool suspended = false;
    bool do_now = false;     // Any pending job carries do_now ("make priority" toggle)
    bool marked = false;
    bool removal_active = false; // DestroyBuilding job currently has an assigned worker
    std::string removal_status;
    std::string removal_activity_status;
    bool passage_control = false;
    bool passage_forbidden = false;
    bool passage_closed = false;
    bool is_depot = false;   // trade depot -> client routes the click to the depot panel
    bool is_cage = false;    // built cage/terrarium -> client exposes occupant + assignment panel
    bool is_restraint = false; // built chain/restraint -> client exposes read-only creature picker
    bool is_farm_plot = false; // farm plot -> client exposes seasonal crop assignments
    int32_t barracks_zone_id = -1; // bed/armor stand/weapon rack room -> related barracks civzone
    int cage_assigned_units = 0;
    int cage_assigned_items = 0;
    ItemArt art;   // art of the contained item: a statue's art lives on the item, not the building
};

struct ZonePanelInfo {
    int32_t id = -1;
    bool exists = false;
    std::string name;
    std::string type;
    bool active = false;
    int assigned_units = 0;
    bool is_pit_pond = false;
    bool is_pen = false;
    bool is_barracks = false;
    // True for both zone types DF lets you assign a squad to: barracks and archery range.
    bool can_squads = false;
    int assigned_squads = 0;
    bool filling_pond = false;
    bool can_owner = false;
    int32_t owner_id = -1;
    std::string owner_name;
    bool can_location = false;
    int32_t location_id = -1;
    std::string location_name;
    std::string location_type;
    bool is_hospital = false;
    int32_t hospital_location_id = -1;
    bool is_gather = false;
    bool gather_trees = false;
    bool gather_shrubs = false;
    bool gather_fallen = false;
    bool is_tomb = false;
    bool tomb_pets = false;
    bool tomb_citizens = false;
    bool is_archery = false;
    std::string archery_dir;
};

bool building_info_on_core_thread(int32_t id, BuildingPanelInfo& out);
bool building_action_on_core_thread(int32_t id, const std::string& action, std::string* err);
// Set/clear a building's custom name (df::building::name); empty name clears it.
bool building_rename_on_core_thread(int32_t id, const std::string& name, std::string* err);
std::string building_info_json(const BuildingPanelInfo& b);

std::string building_cage_json_on_core_thread(int32_t building_id, std::string* err = nullptr);
bool building_cage_action_on_core_thread(int32_t building_id, int32_t target_id, bool assign,
                                         const std::string& kind, std::string* err);

std::string building_restraint_json_on_core_thread(int32_t building_id,
                                                   std::string* err = nullptr);

// A full cleanup transaction, not a pointer write: storing building_chainst::assigned alone
// leaves the animal both pastured and chained, with stale jobs against its old restraint.
bool building_restraint_action_on_core_thread(int32_t building_id, int32_t unit_id,
                                              std::string* err = nullptr);

// The crop list includes zero-stock crops, so the client can render native's "No seeds" rows.
std::string farm_plot_json_on_core_thread(int32_t building_id, std::string* err = nullptr);
bool farm_plot_set_season_crop_on_core_thread(int32_t building_id, int season, int plant_id,
                                              std::string* err = nullptr);
bool farm_plot_set_seasonal_fertilize_on_core_thread(int32_t building_id, bool enabled,
                                                      std::string* err = nullptr);

bool zone_info_on_core_thread(int32_t id, ZonePanelInfo& out);
bool zone_action_on_core_thread(int32_t id, const std::string& action, std::string* err);
std::string zone_info_json(const ZonePanelInfo& z);

// Zone type -> its activity_zones.png cell; false for a non-civzone building.
bool zone_icon_cell(df::building* building, int& x, int& y);

std::string zone_squads_json_on_core_thread(int32_t zone_id, std::string* err = nullptr);
bool zone_squad_action_on_core_thread(int32_t zone_id, int32_t squad_id,
                                      const std::string& mode, bool enabled,
                                      std::string* err = nullptr);

std::string zone_units_json_on_core_thread(int32_t zone_id, std::string* err = nullptr);
bool zone_unit_action_on_core_thread(int32_t zone_id, int32_t unit_id, bool assign,
                                     const std::string& kind, std::string* err);

std::string zone_owners_json_on_core_thread(int32_t zone_id, std::string* err = nullptr);
bool zone_owner_action_on_core_thread(int32_t zone_id, int32_t unit_id, std::string* err);
// req_w/req_h are the client's rendered tile-window dims; 0 falls back to DF's native viewport.
std::string zones_json_on_core_thread(const std::string& player, const Camera& camera,
                                      int req_w = 0, int req_h = 0, std::string* err = nullptr);

// A repaint must be applied in place: deleting and re-creating a civzone strands native
// owner/location/squad references and crashes DF on the next simulation tick.
struct ZoneRepaintPlan {
    bool found = false;
    bool changed = false;   // false: the requested paint leaves every extent tile unchanged
    bool removed = false;   // true: the requested paint clears every tile (caller refuses it)
    int32_t z = 0;
    int new_x1 = 0, new_y1 = 0, new_x2 = 0, new_y2 = 0;
    // Tight row-major footprint bitmap: civzone extent value 1 = tile present, 0 = hole.
    std::vector<uint8_t> extents;
};

bool plan_zone_repaint_on_core_thread(int32_t id, int erase_x1, int erase_y1, int erase_x2,
                                      int erase_y2, const std::string& mode,
                                      ZoneRepaintPlan& out, std::string* err);
bool plan_zone_repaint_shape_on_core_thread(int32_t id, int x1, int y1, int x2, int y2, int z,
                                            const std::string& extents,
                                            ZoneRepaintPlan& out, std::string* err);
bool apply_zone_repaint_in_place_on_core_thread(int32_t id, const ZoneRepaintPlan& plan,
                                                std::string* err);

void register_building_zone_routes(httplib::Server& server);

} // namespace dwf
