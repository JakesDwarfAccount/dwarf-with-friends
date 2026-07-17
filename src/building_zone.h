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

#include "art_desc.h"   // B246: ItemArt -- the building's contained-item art + spriteRef
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
    bool do_now = false;     // B121: any pending job carries do_now ("make priority" toggle)
    bool marked = false;
    bool removal_active = false; // DestroyBuilding job currently has an assigned worker
    std::string removal_status;
    std::string removal_activity_status;
    bool passage_control = false;
    bool passage_forbidden = false;
    bool passage_closed = false;
    bool is_depot = false;   // trade depot -> client routes the click to the depot panel
    bool is_cage = false;    // built cage/terrarium -> client exposes occupant + assignment panel
    bool is_farm_plot = false; // farm plot -> client exposes seasonal crop assignments
    int32_t barracks_zone_id = -1; // bed/armor stand/weapon rack room -> related barracks civzone
    int cage_assigned_units = 0;
    int cage_assigned_items = 0;
    // B246 (07-14): a statue building carried NO art and NO sprite in this panel because this
    // struct -- and therefore /building-info -- only ever described the BUILDING. All of a statue's
    // art (DF's `art_string` sentence) and all of its sprite identity (item type + material) live on
    // the ITEM the building was constructed out of (building_actual::contained_items[0].item ->
    // df::item_statuest). `art` carries that item's DF-authored description and the SAME `spriteRef`
    // shape the item sheet and the occupant rail already speak. art.present == false (the default)
    // for every building with no art-bearing contained item, and the panel then renders exactly as
    // it does today -- so this is additive and inert for chairs, doors and workshops.
    ItemArt art;
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
    // B251: TRUE for every zone type DF lets you assign a squad to -- barracks AND archery range
    // (df::squad_selector_context_type has exactly those two contexts). `is_barracks` stays, because
    // the client still needs to know WHICH one it is for its copy; `can_squads` is the capability.
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
    // Wave 3.3 hospital: a hospital is an abstract_building_hospitalst LOCATION attached to this
    // zone. `is_hospital` is the client's delegation signal (parallels BuildingPanelInfo::is_depot);
    // `hospital_location_id` is the location id the hospital panel reads (== location_id when set).
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
// B13-rename: set/clear a building's custom name (df::building::name); empty name clears it.
bool building_rename_on_core_thread(int32_t id, const std::string& name, std::string* err);
std::string building_info_json(const BuildingPanelInfo& b);

std::string building_cage_json_on_core_thread(int32_t building_id, std::string* err = nullptr);
bool building_cage_action_on_core_thread(int32_t building_id, int32_t target_id, bool assign,
                                         const std::string& kind, std::string* err);

// Farm plots keep one crop id per season. The state route returns the native season/biome crop
// list, including zero-stock crops so the client can show Steam's "No seeds" rows.
std::string farm_plot_json_on_core_thread(int32_t building_id, std::string* err = nullptr);
bool farm_plot_set_season_crop_on_core_thread(int32_t building_id, int season, int plant_id,
                                              std::string* err = nullptr);
bool farm_plot_set_seasonal_fertilize_on_core_thread(int32_t building_id, bool enabled,
                                                      std::string* err = nullptr);

bool zone_info_on_core_thread(int32_t id, ZonePanelInfo& out);
bool zone_action_on_core_thread(int32_t id, const std::string& action, std::string* err);
std::string zone_info_json(const ZonePanelInfo& z);

// B224: the zone-type -> activity_zones.png cell derivation (zone_type_meta) exported for
// /tile-occupants (interaction.cpp), so the occupant rail paints the same art channel as the zone
// palette / Places rows. Returns false for a non-civzone building.
bool zone_icon_cell(df::building* building, int& x, int& y);

// Barracks are civzones even when reached through a bed/armor-stand room relation. The read
// route lists the fortress entity's squads and their four native squad_use_flags bits; the
// write route changes one bit and keeps squad.rooms + zone.squad_room_info in sync through
// DFHack's Military::updateRoomAssignments helper.
std::string zone_squads_json_on_core_thread(int32_t zone_id, std::string* err = nullptr);
bool zone_squad_action_on_core_thread(int32_t zone_id, int32_t squad_id,
                                      const std::string& mode, bool enabled,
                                      std::string* err = nullptr);

std::string zone_units_json_on_core_thread(int32_t zone_id, std::string* err = nullptr);
bool zone_unit_action_on_core_thread(int32_t zone_id, int32_t unit_id, bool assign,
                                     const std::string& kind, std::string* err);

std::string zone_owners_json_on_core_thread(int32_t zone_id, std::string* err = nullptr);
bool zone_owner_action_on_core_thread(int32_t zone_id, int32_t unit_id, std::string* err);
// `req_w`/`req_h` (when > 0) are the requesting client's rendered tile-window dims (the same
// camera-relative w/h /mapdata scopes to); the zone snapshot is culled to that window + a pan
// margin. Pass 0 to fall back to DF's native viewport dims (legacy behavior).
std::string zones_json_on_core_thread(const std::string& player, const Camera& camera,
                                      int req_w = 0, int req_h = 0, std::string* err = nullptr);

// /zone-repaint (WD-14 erase/extend path). The plan is computed without mutation, then applied
// IN PLACE to the existing zone. Zone ids and pointers must remain stable: replacing and deleting
// a civzone can strand native owner/location/squad references and crash DF on the next simulation
// tick. A failed/unsupported repaint leaves the original zone untouched.
struct ZoneRepaintPlan {
    bool found = false;
    bool changed = false;   // false: the requested paint leaves every extent tile unchanged
    bool removed = false;   // true: the requested paint clears every tile (caller refuses it)
    int32_t z = 0;
    int new_x1 = 0, new_y1 = 0, new_x2 = 0, new_y2 = 0;
    // Tight row-major bitmap for the resulting footprint. Civzones use extent value 1 for a
    // present tile and 0 for a hole. Keeping this in the plan makes add/erase preserve arbitrary
    // native shapes instead of flattening the zone into one solid rectangle.
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

// Registers this module's HTTP routes (moved verbatim from http_server.cpp's
// register_routes monolith -- B212, 2026-07-13).
void register_building_zone_routes(httplib::Server& server);

} // namespace dwf
