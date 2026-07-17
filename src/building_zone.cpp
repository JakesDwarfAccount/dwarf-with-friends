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

#include "building_zone.h"
#include "fort_stock.h"

#include "client_state.h"
#include "http_server.h"
#include "lua_bridge.h"
#include "route_helpers.h"
#include "interaction.h"
#include "ui_cache_purge.h"

#include "Core.h"
#include "diagnostics.h"
#include "json_util.h"
#include "sdl_capture.h"
#include "write_guards.h"

#include "modules/Buildings.h"
#include "modules/Items.h"
#include "modules/Job.h"
#include "modules/Maps.h"
#include "modules/Military.h"
#include "modules/Translation.h"
#include "modules/Units.h"

#include "df/abstract_building.h"
#include "df/abstract_building_contents.h"
#include "df/abstract_building_flags.h"
#include "df/abstract_building_templest.h"
#include "df/abstract_building_type.h"
#include "df/building.h"
#include "df/building_cagest.h"
#include "df/building_item_role_type.h"
#include "df/buildingitemst.h"
#include "df/building_farmplotst.h"
#include "df/building_tradedepotst.h"
#include "df/building_civzonest.h"
#include "df/building_squad_infost.h"
#include "df/building_doorst.h"
#include "df/building_extents_type.h"
#include "df/building_hatchst.h"
#include "df/biome_type.h"
#include "df/civzone_interfacest.h"
#include "df/civzone_type.h"
#include "df/gamest.h"
#include "df/general_ref.h"
#include "df/main_interface.h"
#include "df/general_ref_building_civzone_assignedst.h"
#include "df/general_ref_type.h"
#include "df/global_objects.h"
#include "df/item.h"
#include "df/item_cagest.h"
#include "df/item_flags.h"
#include "df/item_petst.h"
#include "df/item_seedsst.h"
#include "df/item_verminst.h"
#include "df/items_other_id.h"
#include "df/historical_entity.h"
#include "df/map_block.h"
#include "df/plant_raw.h"
#include "df/plant_raw_flags.h"
#include "df/plotinfost.h"
#include "df/pronoun_type.h"
#include "df/squad.h"
#include "df/squad_barracks_infost.h"
#include "df/squad_use_flags.h"
#include "df/tile_building_occ.h"
#include "df/unit.h"
#include "df/unit_relationship_type.h"
#include "df/world.h"
#include "df/world_site.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <map>
#include <mutex>
#include <new>
#include <sstream>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_building_zone_mutex;

template <typename Fn>
bool run_building_zone_locked(Fn&& fn) {
    std::lock_guard<std::recursive_mutex> module_lock(g_building_zone_mutex);
    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;
    return fn();
}

struct FarmBiomeFlag {
    df::plant_raw_flags flag;
    df::biome_type biome;
};

// This is the same raw-flag-to-biome map DFHack's autofarm plugin uses. Farm plots at
// subterranean tiles are intentionally matched as SUBTERRANEAN_WATER, as the native UI does.
constexpr FarmBiomeFlag kFarmBiomeFlags[] = {
    {df::plant_raw_flags::BIOME_MOUNTAIN, df::biome_type::MOUNTAIN},
    {df::plant_raw_flags::BIOME_GLACIER, df::biome_type::GLACIER},
    {df::plant_raw_flags::BIOME_TUNDRA, df::biome_type::TUNDRA},
    {df::plant_raw_flags::BIOME_SWAMP_TEMPERATE_FRESHWATER, df::biome_type::SWAMP_TEMPERATE_FRESHWATER},
    {df::plant_raw_flags::BIOME_SWAMP_TEMPERATE_SALTWATER, df::biome_type::SWAMP_TEMPERATE_SALTWATER},
    {df::plant_raw_flags::BIOME_MARSH_TEMPERATE_FRESHWATER, df::biome_type::MARSH_TEMPERATE_FRESHWATER},
    {df::plant_raw_flags::BIOME_MARSH_TEMPERATE_SALTWATER, df::biome_type::MARSH_TEMPERATE_SALTWATER},
    {df::plant_raw_flags::BIOME_SWAMP_TROPICAL_FRESHWATER, df::biome_type::SWAMP_TROPICAL_FRESHWATER},
    {df::plant_raw_flags::BIOME_SWAMP_TROPICAL_SALTWATER, df::biome_type::SWAMP_TROPICAL_SALTWATER},
    {df::plant_raw_flags::BIOME_SWAMP_MANGROVE, df::biome_type::SWAMP_MANGROVE},
    {df::plant_raw_flags::BIOME_MARSH_TROPICAL_FRESHWATER, df::biome_type::MARSH_TROPICAL_FRESHWATER},
    {df::plant_raw_flags::BIOME_MARSH_TROPICAL_SALTWATER, df::biome_type::MARSH_TROPICAL_SALTWATER},
    {df::plant_raw_flags::BIOME_FOREST_TAIGA, df::biome_type::FOREST_TAIGA},
    {df::plant_raw_flags::BIOME_FOREST_TEMPERATE_CONIFER, df::biome_type::FOREST_TEMPERATE_CONIFER},
    {df::plant_raw_flags::BIOME_FOREST_TEMPERATE_BROADLEAF, df::biome_type::FOREST_TEMPERATE_BROADLEAF},
    {df::plant_raw_flags::BIOME_FOREST_TROPICAL_CONIFER, df::biome_type::FOREST_TROPICAL_CONIFER},
    {df::plant_raw_flags::BIOME_FOREST_TROPICAL_DRY_BROADLEAF, df::biome_type::FOREST_TROPICAL_DRY_BROADLEAF},
    {df::plant_raw_flags::BIOME_FOREST_TROPICAL_MOIST_BROADLEAF, df::biome_type::FOREST_TROPICAL_MOIST_BROADLEAF},
    {df::plant_raw_flags::BIOME_GRASSLAND_TEMPERATE, df::biome_type::GRASSLAND_TEMPERATE},
    {df::plant_raw_flags::BIOME_SAVANNA_TEMPERATE, df::biome_type::SAVANNA_TEMPERATE},
    {df::plant_raw_flags::BIOME_SHRUBLAND_TEMPERATE, df::biome_type::SHRUBLAND_TEMPERATE},
    {df::plant_raw_flags::BIOME_GRASSLAND_TROPICAL, df::biome_type::GRASSLAND_TROPICAL},
    {df::plant_raw_flags::BIOME_SAVANNA_TROPICAL, df::biome_type::SAVANNA_TROPICAL},
    {df::plant_raw_flags::BIOME_SHRUBLAND_TROPICAL, df::biome_type::SHRUBLAND_TROPICAL},
    {df::plant_raw_flags::BIOME_DESERT_BADLAND, df::biome_type::DESERT_BADLAND},
    {df::plant_raw_flags::BIOME_DESERT_ROCK, df::biome_type::DESERT_ROCK},
    {df::plant_raw_flags::BIOME_DESERT_SAND, df::biome_type::DESERT_SAND},
    {df::plant_raw_flags::BIOME_OCEAN_TROPICAL, df::biome_type::OCEAN_TROPICAL},
    {df::plant_raw_flags::BIOME_OCEAN_TEMPERATE, df::biome_type::OCEAN_TEMPERATE},
    {df::plant_raw_flags::BIOME_OCEAN_ARCTIC, df::biome_type::OCEAN_ARCTIC},
    {df::plant_raw_flags::BIOME_POOL_TEMPERATE_FRESHWATER, df::biome_type::POOL_TEMPERATE_FRESHWATER},
    {df::plant_raw_flags::BIOME_POOL_TEMPERATE_BRACKISHWATER, df::biome_type::POOL_TEMPERATE_BRACKISHWATER},
    {df::plant_raw_flags::BIOME_POOL_TEMPERATE_SALTWATER, df::biome_type::POOL_TEMPERATE_SALTWATER},
    {df::plant_raw_flags::BIOME_POOL_TROPICAL_FRESHWATER, df::biome_type::POOL_TROPICAL_FRESHWATER},
    {df::plant_raw_flags::BIOME_POOL_TROPICAL_BRACKISHWATER, df::biome_type::POOL_TROPICAL_BRACKISHWATER},
    {df::plant_raw_flags::BIOME_POOL_TROPICAL_SALTWATER, df::biome_type::POOL_TROPICAL_SALTWATER},
    {df::plant_raw_flags::BIOME_LAKE_TEMPERATE_FRESHWATER, df::biome_type::LAKE_TEMPERATE_FRESHWATER},
    {df::plant_raw_flags::BIOME_LAKE_TEMPERATE_BRACKISHWATER, df::biome_type::LAKE_TEMPERATE_BRACKISHWATER},
    {df::plant_raw_flags::BIOME_LAKE_TEMPERATE_SALTWATER, df::biome_type::LAKE_TEMPERATE_SALTWATER},
    {df::plant_raw_flags::BIOME_LAKE_TROPICAL_FRESHWATER, df::biome_type::LAKE_TROPICAL_FRESHWATER},
    {df::plant_raw_flags::BIOME_LAKE_TROPICAL_BRACKISHWATER, df::biome_type::LAKE_TROPICAL_BRACKISHWATER},
    {df::plant_raw_flags::BIOME_LAKE_TROPICAL_SALTWATER, df::biome_type::LAKE_TROPICAL_SALTWATER},
    {df::plant_raw_flags::BIOME_RIVER_TEMPERATE_FRESHWATER, df::biome_type::RIVER_TEMPERATE_FRESHWATER},
    {df::plant_raw_flags::BIOME_RIVER_TEMPERATE_BRACKISHWATER, df::biome_type::RIVER_TEMPERATE_BRACKISHWATER},
    {df::plant_raw_flags::BIOME_RIVER_TEMPERATE_SALTWATER, df::biome_type::RIVER_TEMPERATE_SALTWATER},
    {df::plant_raw_flags::BIOME_RIVER_TROPICAL_FRESHWATER, df::biome_type::RIVER_TROPICAL_FRESHWATER},
    {df::plant_raw_flags::BIOME_RIVER_TROPICAL_BRACKISHWATER, df::biome_type::RIVER_TROPICAL_BRACKISHWATER},
    {df::plant_raw_flags::BIOME_RIVER_TROPICAL_SALTWATER, df::biome_type::RIVER_TROPICAL_SALTWATER},
};

constexpr df::plant_raw_flags kFarmSeasonFlags[] = {
    df::plant_raw_flags::SPRING,
    df::plant_raw_flags::SUMMER,
    df::plant_raw_flags::AUTUMN,
    df::plant_raw_flags::WINTER,
};
constexpr const char* kFarmSeasonNames[] = {"Spring", "Summer", "Autumn", "Winter"};

struct FarmCropRow {
    int id = -1;
    std::string token;
    std::string name;
    int seed_count = 0;
};

struct FarmSeedRow {
    int id = -1;
    std::string token;
    std::string name;
    int count = 0;
    bool forbidden = false;
    bool dump = false;
    bool hidden = false;
};

bool farm_plot_location(df::building_farmplotst* farm, bool& subterranean, df::biome_type& biome) {
    auto designation = Maps::getTileDesignation(df::coord(farm->centerx, farm->centery, farm->z));
    if (!designation)
        return false;
    subterranean = designation->bits.subterranean;
    if (subterranean) {
        biome = df::biome_type::SUBTERRANEAN_WATER;
        return true;
    }
    df::coord2d region(Maps::getTileBiomeRgn(df::coord(farm->centerx, farm->centery, farm->z)));
    biome = Maps::getBiomeType(region.x, region.y);
    return true;
}

std::map<int32_t, int> farm_seed_counts() {
    std::map<int32_t, int> counts;
    auto world = df::global::world;
    if (!world)
        return counts;
    for (auto item : world->items.other[df::items_other_id::SEEDS]) {
        auto seeds = virtual_cast<df::item_seedsst>(item);
        if (seeds && is_fort_stock_item(item, FortItemPurpose::Available))
            counts[seeds->mat_index] += seeds->stack_size;
    }
    return counts;
}

bool farm_crop_matches_plot(const df::plant_raw* plant, bool subterranean, df::biome_type biome) {
    if (!plant || !plant->flags.is_set(df::plant_raw_flags::SEED) ||
        plant->flags.is_set(df::plant_raw_flags::TREE))
        return false;
    if (subterranean)
        return plant->flags.is_set(df::plant_raw_flags::BIOME_SUBTERRANEAN_WATER);
    for (const auto& entry : kFarmBiomeFlags) {
        if (entry.biome == biome)
            return plant->flags.is_set(entry.flag);
    }
    return false;
}

std::vector<FarmCropRow> farm_crops_for_season(int season, bool subterranean, df::biome_type biome,
                                                const std::map<int32_t, int>& seed_counts) {
    std::vector<FarmCropRow> crops;
    auto world = df::global::world;
    if (!world)
        return crops;
    for (auto plant : world->raws.plants.all) {
        if (season < 0 || season >= 4 || !farm_crop_matches_plot(plant, subterranean, biome) ||
            !plant->flags.is_set(kFarmSeasonFlags[season]))
            continue;
        auto found = seed_counts.find(plant->index);
        crops.push_back({plant->index, plant->id, plant->name,
                         found == seed_counts.end() ? 0 : found->second});
    }
    std::sort(crops.begin(), crops.end(), [](const FarmCropRow& a, const FarmCropRow& b) {
        return a.name < b.name;
    });
    return crops;
}

std::vector<FarmSeedRow> farm_seed_stacks() {
    std::vector<FarmSeedRow> rows;
    auto world = df::global::world;
    if (!world)
        return rows;
    for (auto item : world->items.other[df::items_other_id::SEEDS]) {
        auto seeds = virtual_cast<df::item_seedsst>(item);
        if (!seeds || !is_fort_stock_item(item, FortItemPurpose::Stocks))
            continue;
        auto plant = df::plant_raw::find(seeds->mat_index);
        std::string name = Items::getDescription(seeds, 0, false);
        if (name.empty())
            name = plant ? plant->seed_singular : "Seeds";
        rows.push_back({seeds->id, plant ? plant->id : "", name, seeds->stack_size,
                        seeds->flags.bits.forbid != 0, seeds->flags.bits.dump != 0,
                        seeds->flags.bits.hidden != 0});
    }
    std::sort(rows.begin(), rows.end(), [](const FarmSeedRow& a, const FarmSeedRow& b) {
        return a.name == b.name ? a.id < b.id : a.name < b.name;
    });
    return rows;
}

bool get_door_passage_state(df::building* b, bool& forbidden, bool& closed) {
    if (auto door = virtual_cast<df::building_doorst>(b)) {
        forbidden = door->door_flags.bits.forbidden;
        closed = door->door_flags.bits.closed;
        return true;
    }
    if (auto hatch = virtual_cast<df::building_hatchst>(b)) {
        forbidden = hatch->door_flags.bits.forbidden;
        closed = hatch->door_flags.bits.closed;
        return true;
    }
    return false;
}

bool set_door_passage_forbidden(df::building* b, bool forbidden) {
    if (auto door = virtual_cast<df::building_doorst>(b)) {
        door->door_flags.bits.forbidden = forbidden;
        return true;
    }
    if (auto hatch = virtual_cast<df::building_hatchst>(b)) {
        hatch->door_flags.bits.forbidden = forbidden;
        if (auto block = Maps::getTileBlock(df::coord(hatch->centerx, hatch->centery, hatch->z))) {
            auto& occ = block->occupancy[hatch->centerx & 15][hatch->centery & 15];
            occ.bits.building = forbidden ? df::tile_building_occ::Floored
                                          : df::tile_building_occ::Dynamic;
        }
        return true;
    }
    return false;
}

// B251 -- WHICH ZONES TAKE SQUADS. Not a guess: DF enumerates this itself.
//
//   df::squad_selector_context_type  (library/xml/df.d_interface.xml:1421,
//   bay12 original name SquadSelectorContextType) has EXACTLY TWO members:
//       ZONE_BARRACKS_ASSIGNMENT       = 0
//       ZONE_ARCHERY_RANGE_ASSIGNMENT  = 1
//   and df::squad_selector_interfacest (same file, :1427 -- reached from
//   game.main_interface.squad_selector) carries one {open, context, squad_id[], bld_id} for the
//   blue-flag squad picker. That enum IS the rule: barracks + archery range is the COMPLETE set of
//   squad-assignable zone types. There is no third one we are still missing.
//
// The storage is identical for both: building_civzonest.squad_room_info (df.building.xml:1083)
// back-to-back with squad.rooms (df.squad.xml:323), each entry one squad_use_flags bitfield
// {sleep, train, indiv_eq, squad_eq} (df.squad.xml:243). DFHack's Military::updateRoomAssignments
// (library/modules/Military.cpp:238) -- which zone_squad_action_on_core_thread already calls --
// takes a plain building_civzonest and never looks at civzone_type. DF's tooltip table agrees: one
// shared ZONE_ASSIGN_SQUAD hover instruction and one shared BARRACKS_SQUAD_{SLEEP,TRAIN,INDIV_EQ,
// SQUAD_EQ} set, with no archery-specific variants.
//
// So the ONLY thing that ever blocked archery-range squad assignment was the two `type != Barracks`
// early-returns in this file. They are now this one predicate, shared by the read route and the
// write route (the B152 lesson: a read-only fix would render the button and 400 on the click).
bool zone_accepts_squad_assignments(const df::building_civzonest* z) {
    if (!z)
        return false;
    return z->type == df::civzone_type::Barracks ||
           z->type == df::civzone_type::ArcheryRange;
}

bool zone_type_accepts_owner(df::civzone_type type) {
    return type == df::civzone_type::Bedroom ||
           type == df::civzone_type::DiningHall ||
           type == df::civzone_type::Office ||
           type == df::civzone_type::Tomb;
}

bool zone_type_accepts_location(df::civzone_type type) {
    return type == df::civzone_type::MeetingHall ||
           type == df::civzone_type::DiningHall ||
           type == df::civzone_type::Bedroom;
}

std::string abstract_location_type_label(df::abstract_building* loc) {
    if (!loc)
        return "";
    switch (loc->getType()) {
    case df::abstract_building_type::INN_TAVERN: return "Tavern";
    case df::abstract_building_type::TEMPLE: return "Temple";
    case df::abstract_building_type::LIBRARY: return "Library";
    case df::abstract_building_type::GUILDHALL: return "Guildhall";
    case df::abstract_building_type::HOSPITAL: return "Hospital";
    default: return DFHack::enum_item_key(loc->getType());
    }
}

df::abstract_building* find_site_location(int32_t site_id, int32_t location_id) {
    auto site = df::world_site::find(site_id);
    if (!site || location_id < 0)
        return nullptr;
    for (auto loc : site->buildings) {
        if (loc && loc->id == location_id)
            return loc;
    }
    return nullptr;
}

// B276 -- native location mechanics that the older Lua payload did not expose. df-structures:
// abstract_building.flags is the four-state access model; getContents() owns tier/value and the
// stored/desired instrument counters. Thresholds are fort settings, not constants
// (plotinfo.main.custom_difficulty). The structures do NOT establish that abstract_building's
// `inhabitants` vector is native's worshipper count or that BOX entries in `item_id` are native's
// "Chests in common area" count, so neither derivation is exposed as an observed number.
std::string location_native_detail_json(int32_t location_id) {
    std::string json;
    const bool access_guard = hostwrite_flag_enabled_via_lua("location_access");
    const bool instrument_guard = hostwrite_flag_enabled_via_lua("location_instruments");
    run_building_zone_locked([&]() {
        auto plotinfo = df::global::plotinfo;
        auto loc = plotinfo ? find_site_location(plotinfo->site_id, location_id) : nullptr;
        auto contents = loc ? loc->getContents() : nullptr;
        if (!loc || !contents)
            return false;

        const bool visitors = loc->flags.is_set(df::abstract_building_flags::VISITORS_ALLOWED);
        const bool noncitizens = loc->flags.is_set(df::abstract_building_flags::NON_CITIZENS_ALLOWED);
        const bool members = loc->flags.is_set(df::abstract_building_flags::MEMBERS_ONLY);
        const char* access = members ? "members" : (visitors && noncitizens ? "visitors" :
            (noncitizens ? "residents" : "citizens"));

        const bool temple = virtual_cast<df::abstract_building_templest>(loc) != nullptr;
        int32_t next_value = -1;
        std::string tier_storage = abstract_location_type_label(loc);
        if (temple && plotinfo) {
            const auto& difficulty = plotinfo->main.custom_difficulty;
            // df.agreement.xml pins the enum meaning: 1 = temple, 2 = temple complex. Zero is the
            // pre-recognition shrine shown by native. The value selects the NEXT live threshold;
            // it does not replace the authoritative location_tier field.
            if (contents->location_tier <= 0) {
                tier_storage = "Shrine";
                next_value = difficulty.temple_value;
            } else if (contents->location_tier == 1) {
                tier_storage = "Temple";
                next_value = difficulty.temple_complex_value;
            } else {
                tier_storage = "Temple Complex";
            }
        }

        std::ostringstream out;
        out << "{\"accessMode\":" << json_string(access)
            << ",\"guards\":{\"locationAccess\":" << (access_guard ? "true" : "false")
            << ",\"locationInstruments\":" << (instrument_guard ? "true" : "false") << "}"
            << ",\"tierName\":" << json_string(tier_storage)
            << ",\"nextValue\":" << next_value
            << ",\"countInstruments\":" << contents->count_instruments
            << ",\"desiredInstruments\":" << contents->desired_instruments
            << ",\"worshippersVerified\":false,\"chestsVerified\":false"
            // DFHack 53.15 exposes no saved/transient dance-floor field or native computation.
            // Do not turn a civzone bounding box into a made-up gameplay result.
            << ",\"danceFloorKnown\":false}";
        json = out.str();
        return true;
    });
    return json;
}

bool location_native_action(int32_t location_id, const std::string& action,
                            const std::string& mode, int32_t value, std::string& err) {
    const char* flag = action == "access" ? "location_access" :
        (action == "instruments" ? "location_instruments" : "");
    if (!*flag) {
        err = "unknown native location action";
        return false;
    }
    if (!hostwrite_flag_enabled_via_lua(flag)) {
        err = std::string("guarded behind host flag ") + flag + " in dfcapture-hostwrites.json";
        return false;
    }
    return run_building_zone_locked([&]() {
        auto plotinfo = df::global::plotinfo;
        auto loc = plotinfo ? find_site_location(plotinfo->site_id, location_id) : nullptr;
        auto contents = loc ? loc->getContents() : nullptr;
        if (!loc || !contents) {
            err = "location not found";
            return false;
        }
        if (action == "access") {
            const bool known = mode == "visitors" || mode == "residents" ||
                mode == "citizens" || mode == "members";
            if (!known) {
                err = "unknown location access mode";
                return false;
            }
            loc->flags.set(df::abstract_building_flags::VISITORS_ALLOWED, mode == "visitors");
            loc->flags.set(df::abstract_building_flags::NON_CITIZENS_ALLOWED,
                           mode == "visitors" || mode == "residents");
            loc->flags.set(df::abstract_building_flags::MEMBERS_ONLY, mode == "members");
            return true;
        }
        if (!virtual_cast<df::abstract_building_templest>(loc)) {
            err = "instrument storage is only available for temples";
            return false;
        }
        contents->desired_instruments = std::max(value, 0);
        contents->need_more.bits.instruments = true;
        return true;
    });
}

std::string abstract_location_name(df::abstract_building* loc) {
    if (!loc)
        return "";
    std::string name = Translation::translateName(loc->getName(), true);
    if (name.empty())
        name = abstract_location_type_label(loc);
    return name;
}

std::string archery_dir_key(const df::civzone_archery_rangest& archery) {
    if (archery.dir_x == 1 && archery.dir_y == 0)
        return "west";
    if (archery.dir_x == -1 && archery.dir_y == 0)
        return "east";
    if (archery.dir_x == 0 && archery.dir_y == 1)
        return "north";
    if (archery.dir_x == 0 && archery.dir_y == -1)
        return "south";
    return "";
}

bool zone_accepts_unit_assignments(df::building_civzonest* z) {
    return z && (z->type == df::civzone_type::Pen || z->type == df::civzone_type::Pond);
}

bool id_vector_contains(const std::vector<int32_t>& vec, int32_t id) {
    return std::find(vec.begin(), vec.end(), id) != vec.end();
}

void remove_id_from_vector(std::vector<int32_t>& vec, int32_t id) {
    vec.erase(std::remove(vec.begin(), vec.end(), id), vec.end());
}

bool unit_has_valid_map_pos(df::unit* unit) {
    auto world = df::global::world;
    if (!unit || !world)
        return false;
    return unit->pos.x >= 0 && unit->pos.y >= 0 && unit->pos.z >= 0 &&
           unit->pos.x < world->map.x_count &&
           unit->pos.y < world->map.y_count &&
           unit->pos.z < world->map.z_count;
}

bool unit_contained_in_item(df::unit* unit) {
    if (!unit)
        return false;
    for (auto ref : unit->general_refs) {
        if (ref && ref->getType() == df::general_ref_type::CONTAINED_IN_ITEM)
            return true;
    }
    return false;
}

bool unit_in_built_cage(df::unit* unit) {
    auto world = df::global::world;
    if (!unit || !world)
        return false;
    for (auto building : world->buildings.all) {
        if (!building || building->getType() != df::building_type::Cage)
            continue;
        auto cage = virtual_cast<df::building_cagest>(building);
        if (cage && id_vector_contains(cage->assigned_units, unit->id))
            return true;
    }
    return false;
}

void remove_unit_from_built_cages(df::unit* unit) {
    auto world = df::global::world;
    if (!unit || !world)
        return;
    for (auto building : world->buildings.all) {
        if (!building || building->getType() != df::building_type::Cage)
            continue;
        auto cage = virtual_cast<df::building_cagest>(building);
        if (cage)
            remove_id_from_vector(cage->assigned_units, unit->id);
    }
}

void remove_item_from_built_cages(df::item* item) {
    auto world = df::global::world;
    if (!item || !world)
        return;
    for (auto building : world->buildings.all) {
        if (!building || building->getType() != df::building_type::Cage)
            continue;
        auto cage = virtual_cast<df::building_cagest>(building);
        if (cage)
            remove_id_from_vector(cage->assigned_items, item->id);
    }
}

int32_t unit_assigned_zone_id(df::unit* unit) {
    if (!unit)
        return -1;
    for (auto ref : unit->general_refs) {
        if (!ref || ref->getType() != df::general_ref_type::BUILDING_CIVZONE_ASSIGNED)
            continue;
        auto zone_ref = strict_virtual_cast<df::general_ref_building_civzone_assignedst>(ref);
        if (zone_ref)
            return zone_ref->building_id;
    }
    return -1;
}

int32_t item_assigned_zone_id(df::item* item) {
    if (!item)
        return -1;
    for (auto ref : item->general_refs) {
        if (!ref || ref->getType() != df::general_ref_type::BUILDING_CIVZONE_ASSIGNED)
            continue;
        auto zone_ref = strict_virtual_cast<df::general_ref_building_civzone_assignedst>(ref);
        if (zone_ref)
            return zone_ref->building_id;
    }
    return -1;
}

bool remove_unit_zone_assignments(df::unit* unit, int32_t only_zone_id = -1) {
    bool removed = false;
    if (!unit)
        return false;

    for (size_t i = 0; i < unit->general_refs.size();) {
        auto ref = unit->general_refs[i];
        if (!ref || ref->getType() != df::general_ref_type::BUILDING_CIVZONE_ASSIGNED) {
            ++i;
            continue;
        }

        auto zone_ref = strict_virtual_cast<df::general_ref_building_civzone_assignedst>(ref);
        int32_t zone_id = zone_ref ? zone_ref->building_id : -1;
        if (only_zone_id >= 0 && zone_id != only_zone_id) {
            ++i;
            continue;
        }

        unit->general_refs.erase(unit->general_refs.begin() + i);
        if (auto zone = virtual_cast<df::building_civzonest>(df::building::find(zone_id)))
            remove_id_from_vector(zone->assigned_units, unit->id);
        delete ref;
        removed = true;
    }

    if (only_zone_id >= 0) {
        if (auto zone = virtual_cast<df::building_civzonest>(df::building::find(only_zone_id)))
            remove_id_from_vector(zone->assigned_units, unit->id);
    }
    return removed;
}

bool remove_item_zone_assignments(df::item* item, int32_t only_zone_id = -1) {
    bool removed = false;
    if (!item)
        return false;

    for (size_t i = 0; i < item->general_refs.size();) {
        auto ref = item->general_refs[i];
        if (!ref || ref->getType() != df::general_ref_type::BUILDING_CIVZONE_ASSIGNED) {
            ++i;
            continue;
        }

        auto zone_ref = strict_virtual_cast<df::general_ref_building_civzone_assignedst>(ref);
        int32_t zone_id = zone_ref ? zone_ref->building_id : -1;
        if (only_zone_id >= 0 && zone_id != only_zone_id) {
            ++i;
            continue;
        }

        item->general_refs.erase(item->general_refs.begin() + i);
        if (auto zone = virtual_cast<df::building_civzonest>(df::building::find(zone_id)))
            remove_id_from_vector(zone->assigned_items, item->id);
        delete ref;
        removed = true;
    }

    if (only_zone_id >= 0) {
        if (auto zone = virtual_cast<df::building_civzonest>(df::building::find(only_zone_id)))
            remove_id_from_vector(zone->assigned_items, item->id);
    }
    return removed;
}

void mark_zone_occupants_dirty(df::building_civzonest* zone) {
    if (!zone)
        return;
    if (zone->type == df::civzone_type::Pen)
        zone->zone_settings.pen.flags.bits.check_occupants = 1;
    else if (zone->type == df::civzone_type::Pond)
        zone->zone_settings.pond.flag.bits.check_occupants = 1;
}

df::general_ref_building_civzone_assignedst* create_civzone_assignment_ref() {
    return strict_virtual_cast<df::general_ref_building_civzone_assignedst>(
        df::general_ref_building_civzone_assignedst::_identity.instantiate());
}

bool zone_item_is_candidate(df::building_civzonest* zone, df::item* item, bool assigned_here) {
    if (!zone || !item)
        return false;
    if (assigned_here)
        return true;
    if (zone->type != df::civzone_type::Pond)
        return false;
    return virtual_cast<df::item_verminst>(item) || virtual_cast<df::item_petst>(item);
}

bool cage_item_is_candidate(df::item* item, bool assigned_here) {
    if (!item)
        return false;
    if (assigned_here)
        return true;
    return virtual_cast<df::item_verminst>(item) || virtual_cast<df::item_petst>(item);
}

bool validate_built_cage_backing_item(df::building_cagest* cage, std::string& reason) {
    if (!cage) {
        reason = "null cage";
        return false;
    }
    if (cage->contained_items.empty() || !cage->contained_items[0]) {
        reason = "built cage has no contained building item";
        return false;
    }
    auto link = cage->contained_items[0];
    auto item = link->item;
    if (!item || !virtual_cast<df::item_cagest>(item)) {
        reason = "built cage backing item is null or not item_cagest";
        return false;
    }
    if (link->use_mode != df::building_item_role_type::PERM) {
        reason = "built cage backing item is not permanent";
        return false;
    }
    if (!item->flags.bits.in_building) {
        reason = "built cage backing item lacks in_building";
        return false;
    }
    auto holder = Items::getGeneralRef(item, df::general_ref_type::BUILDING_HOLDER);
    if (!holder || holder->getBuilding() != cage) {
        reason = "built cage backing item lacks reciprocal building holder";
        return false;
    }
    return true;
}

std::string cage_mutation_audit(df::building_cagest* cage, const std::string& phase,
                                const std::string& kind, int32_t target_id, bool assign) {
    std::ostringstream out;
    auto link = cage && !cage->contained_items.empty() ? cage->contained_items[0] : nullptr;
    auto item = link ? link->item : nullptr;
    auto holder = item ? Items::getGeneralRef(item, df::general_ref_type::BUILDING_HOLDER) : nullptr;
    out << "CAGE-AUDIT phase=" << phase
        << " cage=" << (cage ? cage->id : -1)
        << " action=" << (assign ? "assign" : "release")
        << " kind=" << kind << " target=" << target_id
        << " stage=" << (cage ? cage->getBuildStage() : -1)
        << "/" << (cage ? cage->getMaxBuildStage() : -1)
        << " contained=" << (cage ? cage->contained_items.size() : 0)
        << " backingItem=" << (item ? item->id : -1)
        << " backingType=" << (item ? static_cast<int>(item->getType()) : -1)
        << " useMode=" << (link ? static_cast<int>(link->use_mode) : -1)
        << " inBuilding=" << (item && item->flags.bits.in_building ? 1 : 0)
        << " holder=" << (holder && holder->getBuilding() ? holder->getBuilding()->id : -1)
        << " assignedUnits=" << (cage ? cage->assigned_units.size() : 0)
        << " assignedItems=" << (cage ? cage->assigned_items.size() : 0)
        << " cageFlags=" << (cage ? cage->cage_flags.whole : 0)
        << " fillTimer=" << (cage ? cage->fill_timer : 0);
    return out.str();
}

std::string zone_item_name(df::item* item) {
    if (!item)
        return "";
    std::string desc = item_display_name(item, 0, true);
    if (desc.empty())
        desc = "Item " + std::to_string(item->id);
    return desc;
}

std::vector<std::string> zone_item_flags(df::item* item, bool assigned_here,
                                         bool assigned_elsewhere) {
    std::vector<std::string> flags;
    if (!item)
        return flags;
    if (assigned_here)
        flags.push_back("assigned here");
    else if (assigned_elsewhere)
        flags.push_back("assigned elsewhere");
    if (virtual_cast<df::item_petst>(item))
        flags.push_back("small pet");
    else if (virtual_cast<df::item_verminst>(item))
        flags.push_back("vermin");
    return flags;
}

bool zone_unit_is_candidate(df::unit* unit, bool assigned_here) {
    if (!unit)
        return false;
    if (!Units::isAnimal(unit))
        return false;
    if (assigned_here)
        return true;
    if (!Units::isActive(unit) || Units::isDead(unit))
        return false;
    bool caged = unit_contained_in_item(unit) || unit_in_built_cage(unit);
    return (Units::isTame(unit) || caged) &&
           !Units::isMerchant(unit) && !Units::isForest(unit);
}

bool cage_unit_is_candidate(df::unit* unit, bool assigned_here) {
    if (!unit)
        return false;
    if (assigned_here)
        return true;
    if (!Units::isActive(unit) || Units::isDead(unit) || Units::isUndead(unit))
        return false;
    if (Units::isMerchant(unit) || Units::isForest(unit))
        return false;
    if (Units::isOwnRace(unit) || Units::isOwnCiv(unit))
        return false;
    if (unit->relationship_ids[df::unit_relationship_type::PetOwner] != -1)
        return false;
    if (!unit_contained_in_item(unit) && !unit_has_valid_map_pos(unit))
        return false;
    return Units::isTame(unit) || Units::isWar(unit) || Units::isHunter(unit) ||
           unit_contained_in_item(unit) || unit_in_built_cage(unit);
}

std::vector<std::string> zone_unit_flags(df::unit* unit, bool assigned_here,
                                         bool assigned_elsewhere) {
    std::vector<std::string> flags;
    if (!unit)
        return flags;
    if (assigned_here)
        flags.push_back("assigned here");
    else if (assigned_elsewhere)
        flags.push_back("assigned elsewhere");
    if (Units::isTame(unit))
        flags.push_back("tame");
    if (Units::isWar(unit))
        flags.push_back("war");
    if (Units::isHunter(unit))
        flags.push_back("hunting");
    if (Units::isGrazer(unit))
        flags.push_back("grazer");
    if (Units::isMilkable(unit))
        flags.push_back("milkable");
    if (unit_contained_in_item(unit))
        flags.push_back("caged");
    else if (unit_in_built_cage(unit))
        flags.push_back("built cage");
    return flags;
}

struct ZoneUnitRow {
    int32_t id = -1;
    std::string kind = "unit";
    std::string name;
    std::string race;
    std::string sex;
    int8_t profession_color = -1;
    int32_t x = -1;
    int32_t y = -1;
    int32_t z = -1;
    bool assigned = false;
    bool assigned_elsewhere = false;
    std::vector<std::string> flags;
};

using CageRow = ZoneUnitRow;

struct ZoneOwnerRow {
    int32_t id = -1;
    std::string name;
    std::string profession;
    int8_t profession_color = -1;
    bool assigned = false;
    bool dead = false;
    int same_type_rooms = 0;
};

struct ZoneTypeMeta {
    const char* key;
    const char* label;
    int icon_x;
    int icon_y;
};

ZoneTypeMeta zone_type_meta(df::civzone_type type) {
    switch (type) {
    case df::civzone_type::MeetingHall:     return {"meeting", "Meeting Area", 5, 10};
    case df::civzone_type::Pen:             return {"pen", "Pen/Pasture", 5, 6};
    case df::civzone_type::Pond:            return {"pond", "Pit/Pond", 5, 7};
    case df::civzone_type::WaterSource:     return {"water", "Water Source", 5, 2};
    case df::civzone_type::FishingArea:     return {"fishing", "Fishing", 5, 3};
    case df::civzone_type::SandCollection:  return {"sand", "Sand", 5, 8};
    case df::civzone_type::ClayCollection:  return {"clay", "Clay", 5, 9};
    case df::civzone_type::Dump:            return {"dump", "Garbage Dump", 5, 5};
    case df::civzone_type::PlantGathering:  return {"gather", "Gather Fruit", 5, 4};
    case df::civzone_type::AnimalTraining:  return {"training", "Animal Training", 5, 12};
    case df::civzone_type::Dungeon:         return {"dungeon", "Dungeon", 6, 13};
    case df::civzone_type::Bedroom:         return {"bedroom", "Bedroom", 6, 7};
    case df::civzone_type::DiningHall:      return {"dining", "Dining Hall", 6, 8};
    case df::civzone_type::Office:          return {"office", "Office", 6, 9};
    case df::civzone_type::Dormitory:       return {"dormitory", "Dormitory", 6, 12};
    case df::civzone_type::Barracks:        return {"barracks", "Barracks", 6, 11};
    case df::civzone_type::ArcheryRange:    return {"archery", "Archery Range", 6, 10};
    case df::civzone_type::Tomb:            return {"tomb", "Tomb", 6, 14};
    case df::civzone_type::Shrine:          return {"shrine", "Shrine", 6, 4};
    case df::civzone_type::Temple:          return {"temple", "Temple", 6, 5};
    case df::civzone_type::Library:         return {"library", "Library", 6, 1};
    default:                                return {"zone", "Zone", 5, 13};
    }
}

struct ZoneSnapshotItem {
    int id = -1;
    int zone_num = 0;
    std::string key;
    std::string label;
    std::string name;
    int icon_x = 5;
    int icon_y = 13;
    bool active = false;
    int x = 0;
    int y = 0;
    int z = 0;
    int w = 0;
    int h = 0;
    std::string extents;
};

struct ZoneSnapshot {
    Camera camera;
    int viewport_w = 0;
    int viewport_h = 0;
    std::vector<ZoneSnapshotItem> zones;
};

std::string zone_extent_bitmap(df::building_civzonest* zone, int x, int y, int w, int h) {
    std::string bits;
    bits.reserve(static_cast<size_t>(std::max(0, w) * std::max(0, h)));
    bool shaped = zone && zone->room.extents && zone->isExtentShaped();
    for (int yy = 0; yy < h; ++yy) {
        for (int xx = 0; xx < w; ++xx) {
            bool present = true;
            if (shaped) {
                int dx = (x + xx) - zone->room.x;
                int dy = (y + yy) - zone->room.y;
                present = dx >= 0 && dy >= 0 &&
                    dx < zone->room.width && dy < zone->room.height &&
                    zone->room.extents[dx + dy * zone->room.width] !=
                        df::building_extents_type::None;
            }
            bits.push_back(present ? '1' : '0');
        }
    }
    return bits;
}

bool build_zone_snapshot(const Camera& camera, ZoneSnapshot& snapshot, int req_w, int req_h,
                         std::string* err) {
    auto world = df::global::world;
    if (!world) {
        if (err) *err = "world unavailable";
        return false;
    }
    snapshot.camera = camera;
    // Viewport-cull scope: prefer the requesting client's rendered tile window (req_w/req_h --
    // the same camera-relative w/h /mapdata scopes its tile payload to) so the zone list is
    // scoped to what the client can actually see, matching how world_stream.cpp filters the
    // buildings/units AUX payloads to each connection's interest window. When the client is
    // zoomed in, its window is far smaller than DF's native viewport (the prior scope) -- e.g.
    // a 40x30 view inside a 130x100 native window pulled in every zone across the whole native
    // window, re-serializing each one's full extents bitmap every 1s poll. Fall back to the
    // native viewport dims when no client window is given (req_w/h <= 0).
    if (req_w > 0 && req_h > 0) {
        snapshot.viewport_w = req_w;
        snapshot.viewport_h = req_h;
    } else if (!effective_capture_viewport_dims(camera, snapshot.viewport_w, snapshot.viewport_h,
                                                err)) {
        return false;
    }

    // One block of pan slack on every side so a zone scrolling into view doesn't pop in a frame
    // late between polls (the client re-fetches /zones on every camera move AND on a 1s timer).
    constexpr int kZoneCullMargin = 16;
    int vx1 = camera.x - kZoneCullMargin;
    int vy1 = camera.y - kZoneCullMargin;
    int vx2 = camera.x + snapshot.viewport_w + kZoneCullMargin;
    int vy2 = camera.y + snapshot.viewport_h + kZoneCullMargin;
    for (auto zone : world->buildings.other.ANY_ZONE) {
        if (!zone || zone->z != camera.z || !zone->flags.bits.exists)
            continue;

        int zx = zone->room.width > 0 ? zone->room.x : zone->x1;
        int zy = zone->room.height > 0 ? zone->room.y : zone->y1;
        int zw = zone->room.width > 0 ? zone->room.width : (zone->x2 - zone->x1 + 1);
        int zh = zone->room.height > 0 ? zone->room.height : (zone->y2 - zone->y1 + 1);
        if (zw <= 0 || zh <= 0)
            continue;
        if (zx + zw <= vx1 || zy + zh <= vy1 || zx >= vx2 || zy >= vy2)
            continue;

        ZoneTypeMeta meta = zone_type_meta(zone->type);
        ZoneSnapshotItem item;
        item.id = zone->id;
        item.zone_num = zone->zone_num;
        item.key = meta.key;
        item.label = meta.label;
        item.icon_x = meta.icon_x;
        item.icon_y = meta.icon_y;
        item.active = zone->spec_sub_flag.bits.active;
        item.x = zx;
        item.y = zy;
        item.z = zone->z;
        item.w = zw;
        item.h = zh;
        item.extents = zone_extent_bitmap(zone, zx, zy, zw, zh);
        item.name = Buildings::getName(zone);
        if (item.name.empty())
            item.name = item.label;
        snapshot.zones.push_back(std::move(item));
    }
    return true;
}

bool zone_owner_candidate(df::building_civzonest* zone, df::unit* unit, bool assigned_here) {
    if (!zone || !unit)
        return false;
    if (assigned_here)
        return true;
    if (Units::isMerchant(unit) || Units::isForest(unit) || Units::isAnimal(unit))
        return false;
    if (zone->type == df::civzone_type::Tomb)
        return Units::isOwnCiv(unit) && (Units::isDead(unit) || Units::isCitizen(unit, true));
    return Units::isActive(unit) && !Units::isDead(unit) && Units::isCitizen(unit, true);
}

int count_owned_zones_of_type(df::unit* unit, df::civzone_type type, df::building_civzonest* ignore) {
    if (!unit)
        return 0;
    int count = 0;
    for (auto b : unit->owned_buildings) {
        if (!b || b == ignore)
            continue;
        if (b->type == type)
            ++count;
    }
    return count;
}

} // namespace

// B224: the zone-type -> activity_zones.png cell derivation the zone palette / Places rows already
// use (zone_type_meta), exported for /tile-occupants (interaction.cpp) so the occupant rail paints
// the same art channel. Returns false for a non-civzone building.
bool zone_icon_cell(df::building* building, int& x, int& y) {
    auto zone = virtual_cast<df::building_civzonest>(building);
    if (!zone)
        return false;
    ZoneTypeMeta meta = zone_type_meta(zone->type);
    x = meta.icon_x;
    y = meta.icon_y;
    return true;
}

bool building_info_on_core_thread(int32_t id, BuildingPanelInfo& out) {
    return run_building_zone_locked([&]() -> bool {
        auto b = df::building::find(id);
        if (!b)
            return false;
        out.id = id;
        out.exists = true;
        out.name = Buildings::getName(b);
        out.built = b->getBuildStage() >= b->getMaxBuildStage();
        out.marked = Buildings::markedForRemoval(b);
        bool suspended = false;
        bool any_job = false;
        bool do_now = false;
        for (auto* job : b->jobs) {
            if (!job)
                continue;
            // df-structures: df.job.xml declares DestroyBuilding as the building-removal job;
            // df.reference.xml declares its UNIT_WORKER general ref. Job::getWorker resolves that
            // ref, so this distinguishes queued/no-worker from assigned/active without guessing
            // from timers or UI state.
            if (job->job_type == df::job_type::DestroyBuilding) {
                out.removal_active = out.removal_active || Job::getWorker(job) != nullptr;
                out.removal_status = "Slated for removal";
            }
            any_job = true;
            if (job->flags.bits.suspend)
                suspended = true;
            if (job->flags.bits.do_now)
                do_now = true;   // B121: construction is prioritized ("make priority" state)
        }
        // B286-1 establishes this exact inactive wording. The active wording has not been
        // captured, so expose the state boolean but do not invent native copy for it.
        if (out.marked && !out.removal_active)
            out.removal_activity_status = "Removal inactive.";
        out.has_jobs = any_job;
        out.suspended = suspended;
        out.do_now = do_now;
        out.passage_control = get_door_passage_state(b, out.passage_forbidden,
                                                     out.passage_closed);
        out.is_depot = virtual_cast<df::building_tradedepotst>(b) != nullptr;
        out.is_farm_plot = virtual_cast<df::building_farmplotst>(b) != nullptr;
        auto type = b->getType();
        if (type == df::building_type::Bed || type == df::building_type::Armorstand ||
            type == df::building_type::Weaponrack) {
            for (auto relation : b->relations) {
                if (relation && relation->type == df::civzone_type::Barracks) {
                    out.barracks_zone_id = relation->id;
                    break;
                }
            }
        }
        if (auto cage = virtual_cast<df::building_cagest>(b)) {
            out.is_cage = true;
            out.cage_assigned_units = static_cast<int>(cage->assigned_units.size());
            out.cage_assigned_items = static_cast<int>(cage->assigned_items.size());
        }
        // B246: THE FIX FOR BOTH HALVES OF THE STATUE COMPLAINT, in one line. building_art()
        // walks to the contained df::item_statuest and returns its DF-sourced composed body AND the
        // item's spriteRef. Both were absent from this panel for the same reason -- nobody ever
        // looked past the building at the item it is made of. Mute (present==false) for buildings
        // whose contained item has no art, so nothing else in this panel changes.
        out.art = building_art(b);
        return true;
    });
}

bool building_action_on_core_thread(int32_t id, const std::string& action, std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto b = df::building::find(id);
        if (!b) {
            if (err) *err = "building not found";
            return false;
        }
        if (action == "cancel-removal") {
            // Resolve the job while capture_state_mutex + CoreSuspender are held. It may have
            // completed or been cancelled between the panel read and this click; in that case we
            // fail without touching the building or any stale pointer. removeJob delegates to DF's
            // own cancel_job handler and performs the required reference cleanup (DFHack
            // library/modules/Job.cpp), rather than deleting a DF-owned job directly.
            for (auto* job : b->jobs) {
                if (job && job->job_type == df::job_type::DestroyBuilding)
                    return Job::removeJob(job);
            }
            if (err) *err = "removal job no longer exists";
            return false;
        }
        if (action == "cancel" || action == "remove" || action == "deconstruct") {
            // Generic remove frees ANY building type, so any v50 interface caching THIS building
            // (job_details.bld, a trade depot in trade/assign_trade, display furniture in
            // buildjob/assign_display_item, ...) would dangle across the free exactly as the
            // stockpile/zone caches did. Purge under this CoreSuspender before Buildings::deconstruct.
            purge_ui_caches_for_building(b);
            return Buildings::deconstruct(b);
        }
        if (action == "suspend" || action == "resume") {
            bool suspend = action == "suspend";
            bool changed = false;
            for (auto* job : b->jobs) {
                if (!job)
                    continue;
                job->flags.bits.suspend = suspend;
                changed = true;
            }
            if (!changed && err)
                *err = "no construction job to " + action;
            return changed;
        }
        // B121: "make priority" on a pending construction -- toggle do_now (DF's native "do this
        // task now" flag, the same bit the workshop task "!" sets) on the building's pending jobs.
        // Additive action; suspend/resume/remove behavior is unchanged.
        if (action == "priority") {
            bool any_job = false;
            bool current = false;
            for (auto* job : b->jobs) {
                if (!job)
                    continue;
                any_job = true;
                if (job->flags.bits.do_now)
                    current = true;
            }
            if (!any_job) {
                if (err) *err = "no pending job to prioritize";
                return false;
            }
            for (auto* job : b->jobs) {
                if (job)
                    job->flags.bits.do_now = !current;
            }
            return true;
        }
        if (action == "toggle-passage" || action == "forbid-passage" ||
            action == "allow-passage") {
            bool forbidden = false;
            bool closed = false;
            if (!get_door_passage_state(b, forbidden, closed)) {
                if (err) *err = "building does not control passage";
                return false;
            }
            bool next = action == "toggle-passage" ? !forbidden : action == "forbid-passage";
            if (!set_door_passage_forbidden(b, next)) {
                if (err) *err = "failed to update passage state";
                return false;
            }
            if (df::global::world)
                df::global::world->reindex_pathfinding = true;
            return true;
        }
        if (err) *err = "unknown action: " + action;
        return false;
    });
}

// B13-rename: set (or clear, when `name` is empty) a building's custom name -- the same
// df::building::name field DF's own "rename building" writes. Buildings::getName() returns this
// custom name when non-empty, else the generated type name, so a subsequent /workshop-info reads
// it straight back. Read-modify-write of one std::string field; no allocation of DF structs.
bool building_rename_on_core_thread(int32_t id, const std::string& name, std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto b = df::building::find(id);
        if (!b) {
            if (err) *err = "building not found";
            return false;
        }
        std::string trimmed = name;
        if (trimmed.size() > 128) trimmed.resize(128);   // DF names are short; bound defensively
        b->name = trimmed;
        return true;
    });
}

std::string building_info_json(const BuildingPanelInfo& b) {
    std::ostringstream js;
    js << "{\"id\":" << b.id
       << ",\"name\":" << json_string(b.name)
       << ",\"built\":" << (b.built ? "true" : "false")
       << ",\"hasJobs\":" << (b.has_jobs ? "true" : "false")
       << ",\"suspended\":" << (b.suspended ? "true" : "false")
       << ",\"doNow\":" << (b.do_now ? "true" : "false")   // B121 additive: priority state
       << ",\"marked\":" << (b.marked ? "true" : "false")
       << ",\"markedForRemoval\":" << (b.marked ? "true" : "false")
       << ",\"removalActive\":" << (b.removal_active ? "true" : "false")
       << ",\"removalStatus\":" << json_string(b.removal_status)
       << ",\"removalActivityStatus\":" << json_string(b.removal_activity_status)
       << ",\"passageControl\":" << (b.passage_control ? "true" : "false")
       << ",\"passageForbidden\":" << (b.passage_forbidden ? "true" : "false")
       << ",\"passageClosed\":" << (b.passage_closed ? "true" : "false")
       << ",\"isDepot\":" << (b.is_depot ? "true" : "false")
       << ",\"isCage\":" << (b.is_cage ? "true" : "false")
       << ",\"isFarmPlot\":" << (b.is_farm_plot ? "true" : "false")
       << ",\"barracksZoneId\":" << b.barracks_zone_id
       << ",\"cageAssignedUnits\":" << b.cage_assigned_units
       << ",\"cageAssignedItems\":" << b.cage_assigned_items;
    // B246: appends ",\"artDescription\":...,\"artName\":...,\"spriteRef\":{...}" -- and appends
    // NOTHING when the building has no art-bearing item, so every existing /building-info consumer
    // (and every pinned fixture of one) sees a byte-identical body.
    append_item_art_json(js, b.art);
    js << "}";
    return js.str();
}

std::string building_cage_json_on_core_thread(int32_t building_id, std::string* err) {
    std::string json;
    bool ok = run_building_zone_locked([&]() -> bool {
        auto cage = virtual_cast<df::building_cagest>(df::building::find(building_id));
        if (!cage) {
            if (err) *err = "building is not a cage";
            return false;
        }
        if (cage->getBuildStage() < cage->getMaxBuildStage()) {
            if (err) *err = "cage is not built";
            return false;
        }
        auto world = df::global::world;
        if (!world) {
            if (err) *err = "world unavailable";
            return false;
        }

        std::vector<CageRow> rows;
        rows.reserve(world->units.all.size());
        for (auto unit : world->units.all) {
            if (!unit)
                continue;
            bool assigned_here = id_vector_contains(cage->assigned_units, unit->id);
            bool assigned_elsewhere = !assigned_here && unit_in_built_cage(unit);
            if (!cage_unit_is_candidate(unit, assigned_here))
                continue;
            CageRow row;
            row.id = unit->id;
            row.name = Units::getReadableName(unit);
            if (row.name.empty())
                row.name = Units::getRaceName(unit);
            row.race = Units::getRaceName(unit);
            row.profession_color = Units::getProfessionColor(unit);
            if (unit->sex == df::pronoun_type::she)
                row.sex = "female";
            else if (unit->sex == df::pronoun_type::he)
                row.sex = "male";
            row.assigned = assigned_here;
            row.assigned_elsewhere = assigned_elsewhere;
            row.flags = zone_unit_flags(unit, row.assigned, row.assigned_elsewhere);
            rows.push_back(std::move(row));
        }

        auto add_item_row = [&](df::item* item) {
            if (!item)
                return;
            bool assigned_here = id_vector_contains(cage->assigned_items, item->id);
            if (!cage_item_is_candidate(item, assigned_here))
                return;
            CageRow row;
            row.id = item->id;
            row.kind = "item";
            row.name = zone_item_name(item);
            row.race = "item";
            row.assigned = assigned_here;
            row.assigned_elsewhere = false;
            row.flags = zone_item_flags(item, row.assigned, row.assigned_elsewhere);
            rows.push_back(std::move(row));
        };
        for (auto item : world->items.other.VERMIN)
            add_item_row(item);
        for (auto item : world->items.other.PET)
            add_item_row(item);

        std::sort(rows.begin(), rows.end(), [](const CageRow& a, const CageRow& b) {
            if (a.assigned != b.assigned)
                return a.assigned > b.assigned;
            if (a.assigned_elsewhere != b.assigned_elsewhere)
                return a.assigned_elsewhere > b.assigned_elsewhere;
            if (a.kind != b.kind)
                return a.kind < b.kind;
            return a.name < b.name;
        });

        std::ostringstream js;
        js << "{\"id\":" << cage->id
           << ",\"name\":" << json_string(Buildings::getName(cage))
           << ",\"units\":[";
        for (size_t i = 0; i < rows.size(); ++i) {
            const auto& row = rows[i];
            if (i) js << ",";
            js << "{\"id\":" << row.id
               << ",\"kind\":" << json_string(row.kind)
               << ",\"name\":" << json_string(row.name)
               << ",\"race\":" << json_string(row.race)
               << ",\"sex\":" << json_string(row.sex)
               << ",\"professionColor\":" << static_cast<int>(row.profession_color)
               << ",\"assigned\":" << (row.assigned ? "true" : "false")
               << ",\"assignedElsewhere\":" << (row.assigned_elsewhere ? "true" : "false")
               << ",\"flags\":";
            append_json_string_array(js, row.flags);
            js << "}";
        }
        js << "]}";
        json = js.str();
        return true;
    });
    return ok ? json : "";
}

bool building_cage_action_on_core_thread(int32_t building_id, int32_t target_id, bool assign,
                                         const std::string& kind, std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto cage = virtual_cast<df::building_cagest>(df::building::find(building_id));
        if (!cage) {
            if (err) *err = "building is not a cage";
            return false;
        }
        if (cage->getBuildStage() < cage->getMaxBuildStage()) {
            if (err) *err = "cage is not built";
            return false;
        }
        if (kind != "unit" && kind != "item") {
            if (err) *err = "invalid cage target kind";
            return false;
        }
        std::string invalid_reason;
        if (!validate_built_cage_backing_item(cage, invalid_reason)) {
            diagnostics_log(cage_mutation_audit(cage, "reject", kind, target_id, assign) +
                            " reason=" + invalid_reason);
            if (err) *err = invalid_reason;
            return false;
        }
        diagnostics_log(cage_mutation_audit(cage, "before", kind, target_id, assign));

        if (kind == "item") {
            auto item = df::item::find(target_id);
            if (!item) {
                if (err) *err = "item not found";
                return false;
            }
            if (!assign) {
                remove_id_from_vector(cage->assigned_items, item->id);
                diagnostics_log(cage_mutation_audit(cage, "after", kind, target_id, assign));
                return true;
            }
            bool already_here = id_vector_contains(cage->assigned_items, item->id);
            if (!already_here && !cage_item_is_candidate(item, false)) {
                if (err) *err = "item is not assignable to this cage";
                return false;
            }
            remove_item_zone_assignments(item);
            remove_item_from_built_cages(item);
            if (!id_vector_contains(cage->assigned_items, item->id))
                cage->assigned_items.push_back(item->id);
            diagnostics_log(cage_mutation_audit(cage, "after", kind, target_id, assign));
            return true;
        }

        auto unit = df::unit::find(target_id);
        if (!unit) {
            if (err) *err = "unit not found";
            return false;
        }
        if (!assign) {
            remove_id_from_vector(cage->assigned_units, unit->id);
            diagnostics_log(cage_mutation_audit(cage, "after", kind, target_id, assign));
            return true;
        }
        bool already_here = id_vector_contains(cage->assigned_units, unit->id);
        if (!already_here && !cage_unit_is_candidate(unit, false)) {
            if (err) *err = "unit is not assignable to this cage";
            return false;
        }
        if (unit->relationship_ids[df::unit_relationship_type::PetOwner] != -1) {
            if (err) *err = "owned pets cannot be assigned to cages";
            return false;
        }

        remove_unit_zone_assignments(unit);
        remove_unit_from_built_cages(unit);
        if (!id_vector_contains(cage->assigned_units, unit->id))
            cage->assigned_units.push_back(unit->id);
        diagnostics_log(cage_mutation_audit(cage, "after", kind, target_id, assign));
        return true;
    });
}

std::string farm_plot_json_on_core_thread(int32_t building_id, std::string* err) {
    std::string json;
    bool ok = run_building_zone_locked([&]() -> bool {
        auto farm = virtual_cast<df::building_farmplotst>(df::building::find(building_id));
        if (!farm) {
            if (err) *err = "building is not a farm plot";
            return false;
        }
        if (farm->getBuildStage() < farm->getMaxBuildStage()) {
            if (err) *err = "farm plot is not built";
            return false;
        }
        bool subterranean = false;
        df::biome_type biome;
        if (!farm_plot_location(farm, subterranean, biome)) {
            if (err) *err = "farm plot location unavailable";
            return false;
        }
        const auto seed_counts = farm_seed_counts();
        const auto seed_stacks = farm_seed_stacks();
        std::ostringstream js;
        js << "{\"id\":" << farm->id
           << ",\"isFarmPlot\":true"
           << ",\"currentSeason\":"
           << (df::global::cur_season ? static_cast<int>(*df::global::cur_season) : 0)
           << ",\"underground\":" << (subterranean ? "true" : "false")
           << ",\"biome\":" << json_string(DFHack::enum_item_key(biome))
           << ",\"fertilize\":{\"seasonal\":"
           << (farm->farm_flags.bits.seasonal_fertilize ? "true" : "false")
           << ",\"current\":" << farm->current_fertilization
           << ",\"max\":" << farm->max_fertilization << "}"
           << ",\"seasons\":[";
        for (int season = 0; season < 4; ++season) {
            if (season) js << ",";
            const int plant_id = farm->plant_id[season];
            auto current = df::plant_raw::find(plant_id);
            const auto crops = farm_crops_for_season(season, subterranean, biome, seed_counts);
            js << "{\"season\":" << season
               << ",\"name\":" << json_string(kFarmSeasonNames[season])
               << ",\"plantId\":" << plant_id
               << ",\"plantName\":" << json_string(current ? current->name : "Fallow")
               << ",\"plantToken\":" << json_string(current ? current->id : "")
               << ",\"crops\":[";
            for (size_t i = 0; i < crops.size(); ++i) {
                if (i) js << ",";
                js << "{\"id\":" << crops[i].id
                   << ",\"token\":" << json_string(crops[i].token)
                   << ",\"name\":" << json_string(crops[i].name)
                   << ",\"seedCount\":" << crops[i].seed_count << "}";
            }
            js << "]}";
        }
        js << "],\"seedStocks\":[";
        for (size_t i = 0; i < seed_stacks.size(); ++i) {
            if (i) js << ",";
            js << "{\"id\":" << seed_stacks[i].id
               << ",\"token\":" << json_string(seed_stacks[i].token)
               << ",\"name\":" << json_string(seed_stacks[i].name)
               << ",\"count\":" << seed_stacks[i].count
               << ",\"forbidden\":" << (seed_stacks[i].forbidden ? "true" : "false")
               << ",\"dump\":" << (seed_stacks[i].dump ? "true" : "false")
               << ",\"hidden\":" << (seed_stacks[i].hidden ? "true" : "false") << "}";
        }
        js << "]}";
        json = js.str();
        return true;
    });
    return ok ? json : "";
}

bool farm_plot_set_season_crop_on_core_thread(int32_t building_id, int season, int plant_id,
                                              std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto farm = virtual_cast<df::building_farmplotst>(df::building::find(building_id));
        if (!farm) {
            if (err) *err = "building is not a farm plot";
            return false;
        }
        if (farm->getBuildStage() < farm->getMaxBuildStage()) {
            if (err) *err = "farm plot is not built";
            return false;
        }
        if (season < 0 || season >= 4) {
            if (err) *err = "invalid season";
            return false;
        }
        if (plant_id == -1) {
            farm->plant_id[season] = -1;
            return true;
        }
        auto plant = df::plant_raw::find(plant_id);
        if (!plant) {
            if (err) *err = "plant not found";
            return false;
        }
        bool subterranean = false;
        df::biome_type biome;
        if (!farm_plot_location(farm, subterranean, biome)) {
            if (err) *err = "farm plot location unavailable";
            return false;
        }
        if (!farm_crop_matches_plot(plant, subterranean, biome) ||
            !plant->flags.is_set(kFarmSeasonFlags[season])) {
            if (err) *err = "plant cannot grow in this season or biome";
            return false;
        }
        farm->plant_id[season] = static_cast<int16_t>(plant_id);
        return true;
    });
}

bool farm_plot_set_seasonal_fertilize_on_core_thread(int32_t building_id, bool enabled,
                                                      std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto farm = virtual_cast<df::building_farmplotst>(df::building::find(building_id));
        if (!farm) {
            if (err) *err = "building is not a farm plot";
            return false;
        }
        if (farm->getBuildStage() < farm->getMaxBuildStage()) {
            if (err) *err = "farm plot is not built";
            return false;
        }
        farm->farm_flags.bits.seasonal_fertilize = enabled;
        return true;
    });
}

bool zone_info_on_core_thread(int32_t id, ZonePanelInfo& out) {
    return run_building_zone_locked([&]() -> bool {
        auto z = virtual_cast<df::building_civzonest>(df::building::find(id));
        if (!z)
            return false;
        out.id = id;
        out.exists = true;
        out.name = Buildings::getName(z);
        out.type = DFHack::enum_item_key(z->type);
        out.active = z->spec_sub_flag.bits.active;
        out.assigned_units = static_cast<int>(z->assigned_units.size());
        out.is_pit_pond = z->type == df::civzone_type::Pond;
        out.is_pen = z->type == df::civzone_type::Pen;
        out.is_barracks = z->type == df::civzone_type::Barracks;
        // B251: the squad count (and the blue-flag control it feeds) belongs to EVERY zone DF lets
        // you assign squads to, not just barracks. See zone_accepts_squad_assignments above.
        out.can_squads = zone_accepts_squad_assignments(z);
        if (out.can_squads) {
            for (auto room : z->squad_room_info)
                if (room && room->mode.whole != 0)
                    ++out.assigned_squads;
        }
        out.filling_pond = z->type == df::civzone_type::Pond &&
            (z->zone_settings.pond.fill_timer > 0 || z->zone_settings.pond.flag.bits.keep_filled);
        out.can_owner = zone_type_accepts_owner(z->type);
        if (out.can_owner) {
            if (auto owner = Buildings::getOwner(z)) {
                out.owner_id = owner->id;
                out.owner_name = Units::getReadableName(owner);
                if (out.owner_name.empty())
                    out.owner_name = Units::getRaceName(owner);
            }
        }
        out.can_location = zone_type_accepts_location(z->type);
        if (out.can_location && z->site_id >= 0 && z->location_id >= 0) {
            if (auto loc = find_site_location(z->site_id, z->location_id)) {
                out.location_id = loc->id;
                out.location_name = abstract_location_name(loc);
                out.location_type = abstract_location_type_label(loc);
                // Wave 3.3: flag a hospital location so the client delegates to the hospital panel
                // (parallels isDepot on /building-info). The hospital module reads by this id.
                if (loc->getType() == df::abstract_building_type::HOSPITAL) {
                    out.is_hospital = true;
                    out.hospital_location_id = loc->id;
                }
            }
        }
        if (z->type == df::civzone_type::PlantGathering) {
            out.is_gather = true;
            out.gather_trees = z->zone_settings.gather.flags.bits.pick_trees;
            out.gather_shrubs = z->zone_settings.gather.flags.bits.pick_shrubs;
            out.gather_fallen = z->zone_settings.gather.flags.bits.gather_fallen;
        }
        if (z->type == df::civzone_type::Tomb) {
            out.is_tomb = true;
            out.tomb_pets = !z->zone_settings.tomb.flags.bits.no_pets;
            out.tomb_citizens = !z->zone_settings.tomb.flags.bits.no_citizens;
        }
        if (z->type == df::civzone_type::ArcheryRange) {
            out.is_archery = true;
            out.archery_dir = archery_dir_key(z->zone_settings.archery);
        }
        return true;
    });
}

bool zone_action_on_core_thread(int32_t id, const std::string& action, std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto z = virtual_cast<df::building_civzonest>(df::building::find(id));
        if (!z) {
            if (err) *err = "zone not found";
            return false;
        }
        if (action == "enable") {
            z->spec_sub_flag.bits.active = 1;
            return true;
        }
        if (action == "disable") {
            z->spec_sub_flag.bits.active = 0;
            return true;
        }
        if (action == "remove" || action == "cancel" || action == "deconstruct") {
            // B34 (W23), now generalized: Buildings::deconstruct frees the zone but clears only
            // the PRE-v50 selection (world->selected_building + ui_look_list). The v50 zone UI
            // keeps its own raw-pointer caches -- game.main_interface.civzone.cur_bld / .list /
            // .zone_just_created (df.d_interface.xml:464-467) -- which deconstruct never touches.
            // The B34 repro (make a zone in NATIVE DF, delete it from the browser, crash) is
            // exactly the case where the native zone UI still holds the pointer: DF then walks a
            // freed zone on its next frame. purge_ui_caches_for_building() is the shared superset
            // of the old inline civzone purge (see src/ui_cache_purge.cpp) -- it clears the same
            // three civzone fields plus every other v50 building-pointer cache, closing the whole
            // dump-proven UAF class in one place. Purge BEFORE the free, under this CoreSuspender.
            purge_ui_caches_for_building(z);
            return Buildings::deconstruct(z);
        }
        if (action == "pond") {
            if (z->type != df::civzone_type::Pond) {
                if (err) *err = "not a pit/pond zone";
                return false;
            }
            z->zone_settings.pond.flag.bits.keep_filled = 1;
            z->zone_settings.pond.fill_timer = 1;
            return true;
        }
        if (action == "pit") {
            if (z->type != df::civzone_type::Pond) {
                if (err) *err = "not a pit/pond zone";
                return false;
            }
            z->zone_settings.pond.flag.bits.keep_filled = 0;
            z->zone_settings.pond.fill_timer = 0;
            return true;
        }
        if (z->type == df::civzone_type::PlantGathering) {
            if (action == "gather-trees-on") { z->zone_settings.gather.flags.bits.pick_trees = 1; return true; }
            if (action == "gather-trees-off") { z->zone_settings.gather.flags.bits.pick_trees = 0; return true; }
            if (action == "gather-shrubs-on") { z->zone_settings.gather.flags.bits.pick_shrubs = 1; return true; }
            if (action == "gather-shrubs-off") { z->zone_settings.gather.flags.bits.pick_shrubs = 0; return true; }
            if (action == "gather-fallen-on") { z->zone_settings.gather.flags.bits.gather_fallen = 1; return true; }
            if (action == "gather-fallen-off") { z->zone_settings.gather.flags.bits.gather_fallen = 0; return true; }
        }
        if (z->type == df::civzone_type::Tomb) {
            if (action == "tomb-pets-on") { z->zone_settings.tomb.flags.bits.no_pets = 0; return true; }
            if (action == "tomb-pets-off") { z->zone_settings.tomb.flags.bits.no_pets = 1; return true; }
            if (action == "tomb-citizens-on") { z->zone_settings.tomb.flags.bits.no_citizens = 0; return true; }
            if (action == "tomb-citizens-off") { z->zone_settings.tomb.flags.bits.no_citizens = 1; return true; }
        }
        if (z->type == df::civzone_type::ArcheryRange) {
            if (action == "archery-west") { z->zone_settings.archery.dir_x = 1; z->zone_settings.archery.dir_y = 0; return true; }
            if (action == "archery-east") { z->zone_settings.archery.dir_x = -1; z->zone_settings.archery.dir_y = 0; return true; }
            if (action == "archery-north") { z->zone_settings.archery.dir_x = 0; z->zone_settings.archery.dir_y = 1; return true; }
            if (action == "archery-south") { z->zone_settings.archery.dir_x = 0; z->zone_settings.archery.dir_y = -1; return true; }
        }
        if (err) *err = "unknown zone action: " + action;
        return false;
    });
}

std::string zone_info_json(const ZonePanelInfo& z) {
    std::ostringstream js;
    js << "{\"id\":" << z.id
       << ",\"name\":" << json_string(z.name)
       << ",\"type\":" << json_string(z.type)
       << ",\"active\":" << (z.active ? "true" : "false")
       << ",\"assignedUnits\":" << z.assigned_units
       << ",\"isPitPond\":" << (z.is_pit_pond ? "true" : "false")
       << ",\"isPen\":" << (z.is_pen ? "true" : "false")
       << ",\"isBarracks\":" << (z.is_barracks ? "true" : "false")
       << ",\"canSquads\":" << (z.can_squads ? "true" : "false")
       << ",\"assignedSquads\":" << z.assigned_squads
       << ",\"fillingPond\":" << (z.filling_pond ? "true" : "false")
       << ",\"canOwner\":" << (z.can_owner ? "true" : "false")
       << ",\"owner\":{\"id\":" << z.owner_id << ",\"name\":" << json_string(z.owner_name) << "}"
       << ",\"canLocation\":" << (z.can_location ? "true" : "false")
       << ",\"location\":{\"id\":" << z.location_id
       << ",\"name\":" << json_string(z.location_name)
       << ",\"type\":" << json_string(z.location_type) << "}"
       << ",\"isHospital\":" << (z.is_hospital ? "true" : "false")
       << ",\"hospitalLocationId\":" << z.hospital_location_id
       << ",\"isGather\":" << (z.is_gather ? "true" : "false")
       << ",\"gather\":{\"trees\":" << (z.gather_trees ? "true" : "false")
       << ",\"shrubs\":" << (z.gather_shrubs ? "true" : "false")
       << ",\"fallen\":" << (z.gather_fallen ? "true" : "false") << "}"
       << ",\"isTomb\":" << (z.is_tomb ? "true" : "false")
       << ",\"tomb\":{\"pets\":" << (z.tomb_pets ? "true" : "false")
       << ",\"citizens\":" << (z.tomb_citizens ? "true" : "false") << "}"
       << ",\"isArchery\":" << (z.is_archery ? "true" : "false")
       << ",\"archery\":{\"direction\":" << json_string(z.archery_dir) << "}"
       << "}";
    return js.str();
}

std::string zone_squads_json_on_core_thread(int32_t zone_id, std::string* err) {
    std::string json;
    bool ok = run_building_zone_locked([&]() -> bool {
        auto zone = virtual_cast<df::building_civzonest>(df::building::find(zone_id));
        if (!zone || !zone_accepts_squad_assignments(zone)) {
            if (err) *err = "zone does not accept squad assignments";
            return false;
        }
        auto plotinfo = df::global::plotinfo;
        auto fort = plotinfo ? df::historical_entity::find(plotinfo->group_id) : nullptr;
        if (!fort) {
            if (err) *err = "fort entity unavailable";
            return false;
        }

        std::ostringstream js;
        js << "{\"id\":" << zone->id
           << ",\"type\":" << json_string(DFHack::enum_item_key(zone->type))
           << ",\"name\":" << json_string(Buildings::getName(zone))
           << ",\"squads\":[";
        bool first = true;
        for (int32_t squad_id : fort->squads) {
            auto squad = df::squad::find(squad_id);
            if (!squad)
                continue;
            df::squad_use_flags flags;
            bool found = false;
            // squad.rooms is the authoritative forward link. The building-side fallback keeps
            // a partially repaired/native zero-mode backref visible without mutating on read.
            for (auto room : squad->rooms) {
                if (room && room->building_id == zone->id) {
                    flags = room->mode;
                    found = true;
                    break;
                }
            }
            if (!found) {
                for (auto room : zone->squad_room_info) {
                    if (room && room->squad_id == squad->id) {
                        flags = room->mode;
                        break;
                    }
                }
            }
            std::string name = Military::getSquadName(squad->id);
            if (name.empty())
                name = !squad->alias.empty() ? squad->alias
                                             : Translation::translateName(&squad->name, true);
            if (!first)
                js << ",";
            first = false;
            js << "{\"id\":" << squad->id
               << ",\"name\":" << json_string(name)
               << ",\"alias\":" << json_string(squad->alias)
               << ",\"assigned\":" << (flags.whole != 0 ? "true" : "false")
               << ",\"sleep\":" << (flags.bits.sleep ? "true" : "false")
               << ",\"train\":" << (flags.bits.train ? "true" : "false")
               << ",\"individualEquipment\":" << (flags.bits.indiv_eq ? "true" : "false")
               << ",\"squadEquipment\":" << (flags.bits.squad_eq ? "true" : "false")
               << ",\"emblem\":{\"symbol\":" << static_cast<int>(squad->symbol)
               << ",\"fg\":{\"r\":" << static_cast<int>(squad->foreground_r)
               << ",\"g\":" << static_cast<int>(squad->foreground_g)
               << ",\"b\":" << static_cast<int>(squad->foreground_b) << "}"
               << ",\"bg\":{\"r\":" << static_cast<int>(squad->background_r)
               << ",\"g\":" << static_cast<int>(squad->background_g)
               << ",\"b\":" << static_cast<int>(squad->background_b) << "}}}";
        }
        js << "]}";
        json = js.str();
        return true;
    });
    return ok ? json : "";
}

bool zone_squad_action_on_core_thread(int32_t zone_id, int32_t squad_id,
                                      const std::string& mode, bool enabled,
                                      std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto zone = virtual_cast<df::building_civzonest>(df::building::find(zone_id));
        if (!zone || !zone_accepts_squad_assignments(zone)) {
            if (err) *err = "zone does not accept squad assignments";
            return false;
        }
        auto plotinfo = df::global::plotinfo;
        auto fort = plotinfo ? df::historical_entity::find(plotinfo->group_id) : nullptr;
        if (!fort || std::find(fort->squads.begin(), fort->squads.end(), squad_id) == fort->squads.end()) {
            if (err) *err = "squad is not part of this fortress";
            return false;
        }
        auto squad = df::squad::find(squad_id);
        if (!squad) {
            if (err) *err = "squad not found";
            return false;
        }

        df::squad_use_flags flags;
        bool found = false;
        for (auto room : squad->rooms) {
            if (room && room->building_id == zone->id) {
                flags = room->mode;
                found = true;
                break;
            }
        }
        if (!found) {
            for (auto room : zone->squad_room_info) {
                if (room && room->squad_id == squad->id) {
                    flags = room->mode;
                    break;
                }
            }
        }

        if (mode == "sleep")
            flags.bits.sleep = enabled;
        else if (mode == "train")
            flags.bits.train = enabled;
        else if (mode == "individual-equipment")
            flags.bits.indiv_eq = enabled;
        else if (mode == "squad-equipment")
            flags.bits.squad_eq = enabled;
        else {
            if (err) *err = "invalid barracks mode";
            return false;
        }
        Military::updateRoomAssignments(squad_id, zone_id, flags);
        return true;
    });
}

std::string zone_units_json_on_core_thread(int32_t zone_id, std::string* err) {
    std::string json;
    bool ok = run_building_zone_locked([&]() -> bool {
        auto zone = virtual_cast<df::building_civzonest>(df::building::find(zone_id));
        if (!zone || !zone_accepts_unit_assignments(zone)) {
            if (err) *err = "zone does not accept unit assignments";
            return false;
        }
        auto world = df::global::world;
        if (!world) {
            if (err) *err = "world unavailable";
            return false;
        }

        std::vector<ZoneUnitRow> rows;
        rows.reserve(world->units.all.size());
        for (auto unit : world->units.all) {
            if (!unit)
                continue;
            int32_t assigned_zone = unit_assigned_zone_id(unit);
            bool assigned_here = assigned_zone == zone->id ||
                                 id_vector_contains(zone->assigned_units, unit->id);
            if (!zone_unit_is_candidate(unit, assigned_here))
                continue;
            ZoneUnitRow row;
            row.id = unit->id;
            row.name = Units::getReadableName(unit);
            if (row.name.empty())
                row.name = Units::getRaceName(unit);
            row.race = Units::getRaceName(unit);
            row.profession_color = Units::getProfessionColor(unit);
            if (unit->sex == df::pronoun_type::she)
                row.sex = "female";
            else if (unit->sex == df::pronoun_type::he)
                row.sex = "male";
            row.x = unit->pos.x;
            row.y = unit->pos.y;
            row.z = unit->pos.z;
            row.assigned = assigned_here;
            row.assigned_elsewhere = assigned_zone >= 0 && assigned_zone != zone->id;
            row.flags = zone_unit_flags(unit, row.assigned, row.assigned_elsewhere);
            rows.push_back(std::move(row));
        }

        if (zone->type == df::civzone_type::Pond) {
            auto add_item_row = [&](df::item* item) {
                if (!item)
                    return;
                int32_t assigned_zone = item_assigned_zone_id(item);
                bool assigned_here = assigned_zone == zone->id ||
                                     id_vector_contains(zone->assigned_items, item->id);
                if (!zone_item_is_candidate(zone, item, assigned_here))
                    return;
                ZoneUnitRow row;
                row.id = item->id;
                row.kind = "item";
                row.name = zone_item_name(item);
                row.race = "item";
                row.assigned = assigned_here;
                row.assigned_elsewhere = assigned_zone >= 0 && assigned_zone != zone->id;
                row.flags = zone_item_flags(item, row.assigned, row.assigned_elsewhere);
                rows.push_back(std::move(row));
            };
            for (auto item : world->items.other.VERMIN)
                add_item_row(item);
            for (auto item : world->items.other.PET)
                add_item_row(item);
        }

        std::sort(rows.begin(), rows.end(), [](const ZoneUnitRow& a, const ZoneUnitRow& b) {
            if (a.assigned != b.assigned)
                return a.assigned > b.assigned;
            if (a.assigned_elsewhere != b.assigned_elsewhere)
                return a.assigned_elsewhere > b.assigned_elsewhere;
            if (a.kind != b.kind)
                return a.kind < b.kind;
            return a.name < b.name;
        });

        std::ostringstream js;
        js << "{\"id\":" << zone->id
           << ",\"type\":" << json_string(DFHack::enum_item_key(zone->type))
           << ",\"name\":" << json_string(Buildings::getName(zone))
           << ",\"units\":[";
        for (size_t i = 0; i < rows.size(); ++i) {
            const auto& row = rows[i];
            if (i) js << ",";
            js << "{\"id\":" << row.id
               << ",\"kind\":" << json_string(row.kind)
               << ",\"name\":" << json_string(row.name)
               << ",\"race\":" << json_string(row.race)
               << ",\"sex\":" << json_string(row.sex)
               << ",\"professionColor\":" << static_cast<int>(row.profession_color)
               << ",\"x\":" << row.x
               << ",\"y\":" << row.y
               << ",\"z\":" << row.z
               << ",\"assigned\":" << (row.assigned ? "true" : "false")
               << ",\"assignedElsewhere\":" << (row.assigned_elsewhere ? "true" : "false")
               << ",\"flags\":";
            append_json_string_array(js, row.flags);
            js << "}";
        }
        js << "]}";
        json = js.str();
        return true;
    });
    return ok ? json : "";
}

bool zone_unit_action_on_core_thread(int32_t zone_id, int32_t unit_id, bool assign,
                                     const std::string& kind, std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto zone = virtual_cast<df::building_civzonest>(df::building::find(zone_id));
        if (!zone || !zone_accepts_unit_assignments(zone)) {
            if (err) *err = "zone does not accept unit assignments";
            return false;
        }
        if (kind == "item") {
            auto item = df::item::find(unit_id);
            if (!item) {
                if (err) *err = "item not found";
                return false;
            }

            if (!assign) {
                remove_item_zone_assignments(item, zone->id);
                mark_zone_occupants_dirty(zone);
                return true;
            }

            bool already_here = id_vector_contains(zone->assigned_items, item->id);
            if (already_here && item_assigned_zone_id(item) == zone->id)
                return true;
            if (!zone_item_is_candidate(zone, item, false) && !already_here) {
                if (err) *err = "item is not assignable to this zone";
                return false;
            }

            remove_item_zone_assignments(item);
            auto ref = create_civzone_assignment_ref();
            if (!ref) {
                if (err) *err = "could not create civzone assignment ref";
                return false;
            }
            ref->building_id = zone->id;
            item->general_refs.push_back(ref);
            if (!id_vector_contains(zone->assigned_items, item->id))
                zone->assigned_items.push_back(item->id);
            mark_zone_occupants_dirty(zone);
            return true;
        }

        auto unit = df::unit::find(unit_id);
        if (!unit) {
            if (err) *err = "unit not found";
            return false;
        }
        if (!assign) {
            remove_unit_zone_assignments(unit, zone->id);
            mark_zone_occupants_dirty(zone);
            return true;
        }

        bool already_here = id_vector_contains(zone->assigned_units, unit->id);
        if (already_here && unit_assigned_zone_id(unit) == zone->id)
            return true;
        if (!zone_unit_is_candidate(unit, false) && !already_here) {
            if (err) *err = "unit is not assignable to this zone";
            return false;
        }

        remove_unit_zone_assignments(unit);
        remove_unit_from_built_cages(unit);

        auto ref = create_civzone_assignment_ref();
        if (!ref) {
            if (err) *err = "could not create civzone assignment ref";
            return false;
        }
        ref->building_id = zone->id;
        unit->general_refs.push_back(ref);
        if (!id_vector_contains(zone->assigned_units, unit->id))
            zone->assigned_units.push_back(unit->id);
        mark_zone_occupants_dirty(zone);
        return true;
    });
}

std::string zone_owners_json_on_core_thread(int32_t zone_id, std::string* err) {
    std::string json;
    bool ok = run_building_zone_locked([&]() -> bool {
        auto zone = virtual_cast<df::building_civzonest>(df::building::find(zone_id));
        if (!zone || !zone_type_accepts_owner(zone->type)) {
            if (err) *err = "zone does not accept owner assignment";
            return false;
        }
        auto world = df::global::world;
        if (!world) {
            if (err) *err = "world unavailable";
            return false;
        }

        std::vector<ZoneOwnerRow> rows;
        for (auto unit : world->units.all) {
            if (!unit)
                continue;
            bool assigned_here = zone->assigned_unit_id == unit->id;
            if (!zone_owner_candidate(zone, unit, assigned_here))
                continue;
            ZoneOwnerRow row;
            row.id = unit->id;
            row.name = Units::getReadableName(unit);
            if (row.name.empty())
                row.name = Units::getRaceName(unit);
            row.profession = Units::getProfessionName(unit);
            row.profession_color = Units::getProfessionColor(unit);
            row.assigned = assigned_here;
            row.dead = Units::isDead(unit);
            row.same_type_rooms = count_owned_zones_of_type(unit, zone->type, zone);
            rows.push_back(std::move(row));
        }

        std::sort(rows.begin(), rows.end(), [](const ZoneOwnerRow& a, const ZoneOwnerRow& b) {
            if (a.assigned != b.assigned)
                return a.assigned > b.assigned;
            if (a.dead != b.dead)
                return a.dead < b.dead;
            if (a.same_type_rooms != b.same_type_rooms)
                return a.same_type_rooms < b.same_type_rooms;
            return a.name < b.name;
        });

        std::ostringstream js;
        js << "{\"id\":" << zone->id
           << ",\"type\":" << json_string(DFHack::enum_item_key(zone->type))
           << ",\"name\":" << json_string(Buildings::getName(zone))
           << ",\"ownerId\":" << zone->assigned_unit_id
           << ",\"owners\":[";
        for (size_t i = 0; i < rows.size(); ++i) {
            const auto& row = rows[i];
            if (i) js << ",";
            js << "{\"id\":" << row.id
               << ",\"name\":" << json_string(row.name)
               << ",\"profession\":" << json_string(row.profession)
               << ",\"professionColor\":" << static_cast<int>(row.profession_color)
               << ",\"assigned\":" << (row.assigned ? "true" : "false")
               << ",\"dead\":" << (row.dead ? "true" : "false")
               << ",\"sameTypeRooms\":" << row.same_type_rooms
               << "}";
        }
        js << "]}";
        json = js.str();
        return true;
    });
    return ok ? json : "";
}

bool zone_owner_action_on_core_thread(int32_t zone_id, int32_t unit_id, std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto zone = virtual_cast<df::building_civzonest>(df::building::find(zone_id));
        if (!zone || !zone_type_accepts_owner(zone->type)) {
            if (err) *err = "zone does not accept owner assignment";
            return false;
        }
        if (unit_id < 0)
            return Buildings::setOwner(zone, nullptr);

        auto unit = df::unit::find(unit_id);
        if (!unit) {
            if (err) *err = "unit not found";
            return false;
        }
        if (!zone_owner_candidate(zone, unit, false) && zone->assigned_unit_id != unit_id) {
            if (err) *err = "unit is not assignable to this zone";
            return false;
        }
        bool ok = Buildings::setOwner(zone, unit);
        if (ok && zone->type == df::civzone_type::Tomb) {
            zone->zone_settings.tomb.flags.bits.no_pets = 1;
            zone->zone_settings.tomb.flags.bits.no_citizens = 1;
        }
        return ok;
    });
}

std::string zones_json_on_core_thread(const std::string& player, const Camera& camera,
                                      int req_w, int req_h, std::string* err) {
    ZoneSnapshot snapshot;
    bool ok = run_building_zone_locked([&]() -> bool {
        return build_zone_snapshot(camera, snapshot, req_w, req_h, err);
    });
    if (!ok)
        return "";

    std::ostringstream body;
    body << "{\"player\":" << json_string(player)
         << ",\"camera\":{\"x\":" << snapshot.camera.x << ",\"y\":" << snapshot.camera.y
         << ",\"z\":" << snapshot.camera.z << "}"
         << ",\"viewport\":{\"w\":" << snapshot.viewport_w
         << ",\"h\":" << snapshot.viewport_h << "}"
         << ",\"zones\":[";
    for (size_t i = 0; i < snapshot.zones.size(); ++i) {
        const auto& z = snapshot.zones[i];
        if (i)
            body << ",";
        body << "{\"id\":" << z.id
             << ",\"zoneNum\":" << z.zone_num
             << ",\"key\":" << json_string(z.key)
             << ",\"label\":" << json_string(z.label)
             << ",\"name\":" << json_string(z.name)
             << ",\"iconX\":" << z.icon_x
             << ",\"iconY\":" << z.icon_y
             << ",\"active\":" << (z.active ? "true" : "false")
             << ",\"x\":" << z.x
             << ",\"y\":" << z.y
             << ",\"z\":" << z.z
             << ",\"w\":" << z.w
             << ",\"h\":" << z.h
             << ",\"extents\":" << json_string(z.extents)
             << "}";
    }
    body << "]}\n";
    return body.str();
}

namespace {

constexpr int64_t kMaxZoneRepaintTiles = 1024 * 1024;

bool zone_extent_present(df::building_civzonest* zone, int x, int y) {
    if (!zone)
        return false;
    const int ox1 = zone->room.width > 0 ? zone->room.x : zone->x1;
    const int oy1 = zone->room.height > 0 ? zone->room.y : zone->y1;
    const int ow = zone->room.width > 0 ? zone->room.width : (zone->x2 - zone->x1 + 1);
    const int oh = zone->room.height > 0 ? zone->room.height : (zone->y2 - zone->y1 + 1);
    if (x < ox1 || x >= ox1 + ow || y < oy1 || y >= oy1 + oh)
        return false;
    if (!zone->room.extents || !zone->isExtentShaped())
        return true;
    int dx = x - zone->room.x;
    int dy = y - zone->room.y;
    return dx >= 0 && dy >= 0 && dx < zone->room.width && dy < zone->room.height &&
        zone->room.extents[dx + dy * zone->room.width] != df::building_extents_type::None;
}

bool validate_zone_bitmap(int x1, int y1, int x2, int y2, const std::string* mask,
                          std::string* err) {
    int64_t width = static_cast<int64_t>(x2) - x1 + 1;
    int64_t height = static_cast<int64_t>(y2) - y1 + 1;
    int64_t cells = width * height;
    if (width <= 0 || height <= 0 || cells <= 0 || cells > kMaxZoneRepaintTiles) {
        if (err) *err = "repaint footprint is too large";
        return false;
    }
    if (mask && static_cast<int64_t>(mask->size()) != cells) {
        if (err) *err = "repaint bitmap size does not match its bounds";
        return false;
    }
    if (mask && std::any_of(mask->begin(), mask->end(), [](char c) { return c != '0' && c != '1'; })) {
        if (err) *err = "repaint bitmap contains an invalid tile value";
        return false;
    }
    return true;
}

bool build_zone_repaint_plan(df::building_civzonest* zone,
                             int paint_x1, int paint_y1, int paint_x2, int paint_y2,
                             const std::string& mode, const std::string* paint_mask,
                             ZoneRepaintPlan& out, std::string* err) {
    out = ZoneRepaintPlan{};
    if (!zone) {
        if (err) *err = "zone not found";
        return false;
    }
    if (mode != "add" && mode != "extend" && mode != "erase" && mode != "replace") {
        if (err) *err = "unknown repaint mode";
        return false;
    }

    const int px1 = std::min(paint_x1, paint_x2);
    const int py1 = std::min(paint_y1, paint_y2);
    const int px2 = std::max(paint_x1, paint_x2);
    const int py2 = std::max(paint_y1, paint_y2);
    if (!validate_zone_bitmap(px1, py1, px2, py2, paint_mask, err))
        return false;

    const int ox1 = zone->room.width > 0 ? zone->room.x : zone->x1;
    const int oy1 = zone->room.height > 0 ? zone->room.y : zone->y1;
    const int ow = zone->room.width > 0 ? zone->room.width : (zone->x2 - zone->x1 + 1);
    const int oh = zone->room.height > 0 ? zone->room.height : (zone->y2 - zone->y1 + 1);
    if (ow <= 0 || oh <= 0) {
        if (err) *err = "zone has an invalid existing footprint";
        return false;
    }
    const int ox2 = ox1 + ow - 1;
    const int oy2 = oy1 + oh - 1;
    const bool replace = mode == "replace";
    const int cx1 = replace ? px1 : (mode == "erase" ? ox1 : std::min(ox1, px1));
    const int cy1 = replace ? py1 : (mode == "erase" ? oy1 : std::min(oy1, py1));
    const int cx2 = replace ? px2 : (mode == "erase" ? ox2 : std::max(ox2, px2));
    const int cy2 = replace ? py2 : (mode == "erase" ? oy2 : std::max(oy2, py2));
    if (!validate_zone_bitmap(cx1, cy1, cx2, cy2, nullptr, err))
        return false;
    if (!Maps::isValidTilePos(cx1, cy1, zone->z) ||
            !Maps::isValidTilePos(cx2, cy2, zone->z)) {
        if (err) *err = "repaint footprint is outside the loaded map";
        return false;
    }

    const int cw = cx2 - cx1 + 1, ch = cy2 - cy1 + 1;
    const int opw = px2 - px1 + 1;
    std::vector<uint8_t> canvas(static_cast<size_t>(cw) * ch, 0);
    bool changed = replace && (cx1 != ox1 || cy1 != oy1 || cx2 != ox2 || cy2 != oy2);
    int nx1 = cx2 + 1, ny1 = cy2 + 1, nx2 = cx1 - 1, ny2 = cy1 - 1;
    for (int y = cy1; y <= cy2; ++y) {
        for (int x = cx1; x <= cx2; ++x) {
            const bool old_present = zone_extent_present(zone, x, y);
            bool selected = x >= px1 && x <= px2 && y >= py1 && y <= py2;
            if (selected && paint_mask)
                selected = (*paint_mask)[static_cast<size_t>(x - px1) +
                    static_cast<size_t>(y - py1) * opw] == '1';
            bool present;
            if (replace)
                present = selected;
            else if (mode == "erase")
                present = old_present && !selected;
            else
                present = old_present || selected;
            canvas[static_cast<size_t>(x - cx1) + static_cast<size_t>(y - cy1) * cw] =
                present ? 1 : 0;
            changed = changed || present != old_present;
            if (present) {
                nx1 = std::min(nx1, x); ny1 = std::min(ny1, y);
                nx2 = std::max(nx2, x); ny2 = std::max(ny2, y);
            }
        }
    }

    out.found = true;
    out.changed = changed;
    out.z = zone->z;
    if (nx2 < nx1 || ny2 < ny1) {
        out.removed = changed;
        return true;
    }
    out.new_x1 = nx1; out.new_y1 = ny1; out.new_x2 = nx2; out.new_y2 = ny2;
    const int nw = nx2 - nx1 + 1, nh = ny2 - ny1 + 1;
    out.extents.assign(static_cast<size_t>(nw) * nh, 0);
    for (int y = ny1; y <= ny2; ++y)
        for (int x = nx1; x <= nx2; ++x)
            out.extents[static_cast<size_t>(x - nx1) + static_cast<size_t>(y - ny1) * nw] =
                canvas[static_cast<size_t>(x - cx1) + static_cast<size_t>(y - cy1) * cw];
    return true;
}

} // namespace

bool plan_zone_repaint_on_core_thread(int32_t id, int x1, int y1, int x2, int y2,
                                      const std::string& mode,
                                      ZoneRepaintPlan& out, std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        return build_zone_repaint_plan(
            virtual_cast<df::building_civzonest>(df::building::find(id)),
            x1, y1, x2, y2, mode, nullptr, out, err);
    });
}

bool plan_zone_repaint_shape_on_core_thread(int32_t id, int x1, int y1, int x2, int y2, int z,
                                            const std::string& extents,
                                            ZoneRepaintPlan& out, std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto zone = virtual_cast<df::building_civzonest>(df::building::find(id));
        if (zone && zone->z != z) {
            if (err) *err = "repaint footprint is on a different z-level than the zone";
            return false;
        }
        return build_zone_repaint_plan(zone, x1, y1, x2, y2, "replace", &extents,
                                       out, err);
    });
}

bool apply_zone_repaint_in_place_on_core_thread(int32_t id, const ZoneRepaintPlan& plan,
                                                std::string* err) {
    return run_building_zone_locked([&]() -> bool {
        auto zone = virtual_cast<df::building_civzonest>(df::building::find(id));
        if (!zone) {
            if (err) *err = "zone not found";
            return false;
        }
        if (!plan.found || !plan.changed) {
            if (err) *err = "invalid or unchanged repaint plan";
            return false;
        }
        if (plan.removed) {
            if (err) *err = "repaint would erase the entire zone; zone left unchanged";
            return false;
        }
        if (zone->z != plan.z || plan.new_x2 < plan.new_x1 || plan.new_y2 < plan.new_y1 ||
                !Maps::isValidTilePos(plan.new_x1, plan.new_y1, plan.z) ||
                !Maps::isValidTilePos(plan.new_x2, plan.new_y2, plan.z)) {
            if (err) *err = "repaint footprint is outside the loaded map";
            return false;
        }
        const int width = plan.new_x2 - plan.new_x1 + 1;
        const int height = plan.new_y2 - plan.new_y1 + 1;
        const int64_t cells = static_cast<int64_t>(width) * height;
        if (width <= 0 || height <= 0 || cells <= 0 || cells > kMaxZoneRepaintTiles) {
            if (err) *err = "repaint footprint is too large";
            return false;
        }
        if (plan.extents.size() != static_cast<size_t>(cells)) {
            if (err) *err = "repaint extent bitmap is incomplete";
            return false;
        }

        // Allocate and fully initialize before touching DF state. Allocation failure propagates
        // without changing the zone; zero entries deliberately preserve native-shaped holes.
        std::unique_ptr<df::building_extents_type[]> next(
            new (std::nothrow) df::building_extents_type[static_cast<size_t>(cells)]);
        if (!next) {
            if (err) *err = "not enough memory to repaint zone safely";
            return false;
        }
        // DFHack's abstract-building initializer uses extent value 1 for every included tile;
        // the generated enum calls that value Stockpile even though civzones use it too.
        for (size_t i = 0; i < static_cast<size_t>(cells); ++i)
            next[i] = plan.extents[i] ? df::building_extents_type::Stockpile
                                      : df::building_extents_type::None;

        auto old_extents = zone->room.extents;
        zone->room.extents = next.release();
        zone->room.x = plan.new_x1;
        zone->room.y = plan.new_y1;
        zone->room.width = width;
        zone->room.height = height;
        zone->x1 = plan.new_x1;
        zone->y1 = plan.new_y1;
        zone->x2 = plan.new_x2;
        zone->y2 = plan.new_y2;
        zone->centerx = plan.new_x1 + width / 2;
        zone->centery = plan.new_y1 + height / 2;
        delete[] old_extents;

        // The zone object, id and every assignment/link remain stable. Refresh the building-zone
        // relation cache against the new shaped footprint, then the occupant/pathing caches.
        Buildings::notifyCivzoneModified(zone);
        mark_zone_occupants_dirty(zone);
        if (df::global::world)
            df::global::world->reindex_pathfinding = true;
        return true;
    });
}

// ---------------------------------------------------------------------------------------------
// HTTP routes, extracted from http_server.cpp's register_routes():
// that function had grown to ~2,750 lines / ~150 inline registrations and was the repo's #1
// merge-conflict site (49 of the last 200 commits). This finishes the register_*_routes() split
// the other 18 modules already used. Handler bodies are unchanged; route behavior is identical.
void register_building_zone_routes(httplib::Server& server) {
    // POST /zone-repaint supports the exact world-addressed mode=replace bitmap used by the
    // staged native client, plus legacy camera-relative mode=erase|add rectangles. Figure out the
    // resulting footprint, then apply it IN PLACE. Never replace/delete the zone: native DF retains
    // owner/location/squad references to civzone objects, and deleting one during repaint can
    // leave a dangling reference that crashes the simulation after this request returns.
    auto zone_repaint_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "erase";
        ZoneRepaintPlan plan;
        std::string err;

        if (mode == "replace") {
            int x1 = 0, y1 = 0, x2 = 0, y2 = 0, z = 0;
            if (!query_int(req, "x1", x1) || !query_int(req, "y1", y1) ||
                    !query_int(req, "x2", x2) || !query_int(req, "y2", y2) ||
                    !query_int(req, "z", z)) {
                res.status = 400;
                res.set_content("missing x1/y1/x2/y2/z\n", "text/plain; charset=utf-8");
                return;
            }
            if (!plan_zone_repaint_shape_on_core_thread(
                    id, x1, y1, x2, y2, z, req.body, plan, &err)) {
                res.status = 400;
                res.set_content("zone-repaint failed: " + err + "\n",
                                "text/plain; charset=utf-8");
                return;
            }
        } else {
            int px = 0, py = 0, frame_w = 0, frame_h = 0;
            if (!query_int(req, "px", px) || !query_int(req, "py", py) ||
                    !query_int(req, "w", frame_w) || !query_int(req, "h", frame_h)) {
                res.status = 400;
                res.set_content("missing px/py/w/h\n", "text/plain; charset=utf-8");
                return;
            }
            int px2 = px, py2 = py;
            query_int(req, "px2", px2);
            query_int(req, "py2", py2);

            Camera camera;
            if (!camera_for_player(player, camera, &err)) {
                res.status = 503;
                res.set_content("camera failed: " + err + "\n", "text/plain; charset=utf-8");
                return;
            }
            normalize_frame_to_viewport(camera, frame_w, frame_h);   // no-op -- see its own banner

            // Legacy camera-relative rectangle route. The native staged client uses the exact
            // world-addressed bitmap route above; this stays for older clients.
            {
                int probe_w = 0, probe_h = 0;
                std::string probe_err;
                if (!effective_capture_viewport_dims(camera, probe_w, probe_h, &probe_err) ||
                        frame_w <= 0 || frame_h <= 0) {
                    res.status = 503;
                    res.set_content("viewport failed: " +
                                    (probe_err.empty() ? std::string("unavailable") : probe_err) +
                                    "\n", "text/plain; charset=utf-8");
                    return;
                }
            }
            int tx1 = pixel_to_tile_index(std::min(px, px2), frame_w);
            int ty1 = pixel_to_tile_index(std::min(py, py2), frame_h);
            int tx2 = pixel_to_tile_index(std::max(px, px2), frame_w);
            int ty2 = pixel_to_tile_index(std::max(py, py2), frame_h);
            int ex1 = camera.x + tx1, ey1 = camera.y + ty1;
            int ex2 = camera.x + tx2, ey2 = camera.y + ty2;
            if (!plan_zone_repaint_on_core_thread(id, ex1, ey1, ex2, ey2, mode, plan, &err)) {
                res.status = 400;
                res.set_content("zone-repaint failed: " + err + "\n",
                                "text/plain; charset=utf-8");
                return;
            }
        }

        if (plan.removed) {
            res.status = 409;
            res.set_content("zone-repaint refused: repaint cannot erase an entire zone; "
                            "zone left unchanged\n", "text/plain; charset=utf-8");
            return;
        }
        if (!plan.changed) {
            res.set_header("Cache-Control", "no-store");
            res.set_content("{\"ok\":true,\"id\":" + std::to_string(id) + ",\"unchanged\":true}\n",
                            "application/json; charset=utf-8");
            return;
        }

        if (!apply_zone_repaint_in_place_on_core_thread(id, plan, &err)) {
            res.status = 400;
            res.set_content("zone-repaint failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"id\":" + std::to_string(id) + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/zone-repaint", zone_repaint_handler);
    server.Post("/zone-repaint", zone_repaint_handler);

    server.Get("/zones", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("camera failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        // WD/zone-cull: honor the client's rendered tile-window dims (same &w=&h= contract as
        // /mapdata) so the zone snapshot is scoped to the requesting viewport + margin instead
        // of DF's whole native viewport. Absent/invalid -> 0 -> server falls back to native dims.
        int req_w = 0, req_h = 0;
        query_int(req, "w", req_w);
        query_int(req, "h", req_h);
        if (req_w > 0) req_w = clamp_window_dim(req_w);
        if (req_h > 0) req_h = clamp_window_dim(req_h);
        std::string json = zones_json_on_core_thread(player, camera, req_w, req_h, &err);
        if (json.empty()) {
            res.status = 500;
            res.set_content("zones failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    server.Get("/building-info", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        BuildingPanelInfo info;
        if (!building_info_on_core_thread(id, info)) {
            res.status = 404;
            res.set_content("{\"error\":\"building not found\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        // B288/B289 round 4: resident art and in-memory bank hits were resolved under the normal
        // core-thread snapshot. A cold miss lets DF compose its own item sheet offscreen here,
        // outside CoreSuspender; failure leaves today's title/base-name/sprite fallback untouched.
        if (info.art.present && info.art.description.empty())
            complete_item_art_prose(info.art);
        res.set_header("Cache-Control", "no-store");
        res.set_content(building_info_json(info) + "\n", "application/json; charset=utf-8");
    });

    auto building_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string action = req.has_param("action") ? req.get_param_value("action") : "";
        std::string err;
        if (!building_action_on_core_thread(id, action, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/building-action", building_action_handler);
    server.Post("/building-action", building_action_handler);

    server.Get("/building-cage", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = building_cage_json_on_core_thread(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("building cage failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json + "\n", "application/json; charset=utf-8");
    });

    auto building_cage_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int unit = -1;
        int assign = 0;
        if (!query_int(req, "id", id) || !query_int(req, "unit", unit)) {
            res.status = 400;
            res.set_content("missing id/unit\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "assign", assign);
        std::string kind = req.has_param("kind") ? req.get_param_value("kind") : "unit";
        std::string err;
        if (!building_cage_action_on_core_thread(id, unit, assign != 0, kind, &err)) {
            res.status = 400;
            res.set_content("building cage action failed: " + err + "\n",
                            "text/plain; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/building-cage-action", building_cage_action_handler);
    server.Post("/building-cage-action", building_cage_action_handler);

    server.Get("/farm-plot", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = farm_plot_json_on_core_thread(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("farm plot info failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json + "\n", "application/json; charset=utf-8");
    });

    auto farm_plot_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int season = -1;
        int plant = -2;
        if (!query_int(req, "id", id) || !query_int(req, "season", season) ||
            !query_int(req, "plant", plant)) {
            res.status = 400;
            res.set_content("missing id/season/plant\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        if (!farm_plot_set_season_crop_on_core_thread(id, season, plant, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Post("/farm-plot-action", farm_plot_action_handler);

    server.Post("/farm-plot-fertilize-action", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int seasonal = -1;
        if (!query_int(req, "id", id) || !query_int(req, "seasonal", seasonal) ||
            (seasonal != 0 && seasonal != 1)) {
            res.status = 400;
            res.set_content("missing/invalid id/seasonal\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        if (!farm_plot_set_seasonal_fertilize_on_core_thread(id, seasonal != 0, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    });

    server.Get("/burial-coffin", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = burial_coffin_info_json_via_lua(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("burial coffin info failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    auto burial_coffin_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || !req.has_param("action")) {
            res.status = 400;
            res.set_content("missing id/action\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        if (!burial_coffin_action_via_lua(id, req.get_param_value("action"), &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/burial-coffin-action", burial_coffin_action_handler);
    server.Post("/burial-coffin-action", burial_coffin_action_handler);

    auto memorial_slab_handler = [](const httplib::Request& req, httplib::Response& res) {
        int unit = -1;
        if (!query_int(req, "unit", unit)) {
            res.status = 400;
            res.set_content("missing unit\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        if (!queue_memorial_slab_via_lua(unit, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/memorial-slab", memorial_slab_handler);
    server.Post("/memorial-slab", memorial_slab_handler);

    // B13-rename: set a building's custom name (df::building::name -- same field DF's own rename
    // writes; empty `name` clears it back to the generated type name). Additive JSON route.
    auto workshop_rename_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string name = req.has_param("name") ? req.get_param_value("name") : "";
        std::string err;
        if (!building_rename_on_core_thread(id, name, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"name\":" + json_string(name) + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/workshop-rename", workshop_rename_handler);
    server.Post("/workshop-rename", workshop_rename_handler);
    // B166: civzones use the same df::building::name field; keep a semantic additive alias so
    // the barracks room's native quill does not depend on a workshop-named endpoint.
    server.Get("/zone-rename", workshop_rename_handler);
    server.Post("/zone-rename", workshop_rename_handler);

    server.Get("/workshop-info", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = workshop_info_json_via_lua(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("workshop info failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    auto workshop_add_job_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || !req.has_param("task")) {
            res.status = 400;
            res.set_content("missing id/task\n", "text/plain; charset=utf-8");
            return;
        }
        int unit_id = -1;
        if (req.has_param("unitId") && !query_int(req, "unitId", unit_id)) {
            res.status = 400;
            res.set_content("invalid unitId\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        if (!workshop_add_job_via_lua(id, req.get_param_value("task"), unit_id, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/workshop-add-job", workshop_add_job_handler);
    server.Post("/workshop-add-job", workshop_add_job_handler);

    auto workshop_job_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int job_id = -1;
        if (!query_int(req, "id", id) || !query_int(req, "job", job_id) ||
                !req.has_param("action")) {
            res.status = 400;
            res.set_content("missing id/job/action\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        if (!workshop_job_action_via_lua(id, job_id, req.get_param_value("action"), &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/workshop-job-action", workshop_job_action_handler);
    server.Post("/workshop-job-action", workshop_job_action_handler);

    auto workshop_worker_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int unit = -1;
        int assign = 0;
        if (!query_int(req, "id", id) || !query_int(req, "unit", unit)) {
            res.status = 400;
            res.set_content("missing id/unit\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "assign", assign);
        std::string err;
        if (!workshop_worker_action_via_lua(id, unit, assign != 0, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/workshop-worker-action", workshop_worker_action_handler);
    server.Post("/workshop-worker-action", workshop_worker_action_handler);

    auto workshop_workers_clear_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        if (!workshop_workers_clear_via_lua(id, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/workshop-workers-clear", workshop_workers_clear_handler);
    server.Post("/workshop-workers-clear", workshop_workers_clear_handler);

    // TRUEMENU WP-3: write one Workers-tab profile control (skill min/max, max general orders,
    // blocked labors, general-order ban). ONE field per call; the lua clamps every value to a legal
    // range, so an out-of-range field/value returns 400 rather than corrupting the profile.
    auto workshop_profile_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int value = 0;
        if (!query_int(req, "id", id) || !req.has_param("field")) {
            res.status = 400;
            res.set_content("missing id/field\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "value", value);
        std::string err;
        if (!workshop_profile_set_via_lua(id, req.get_param_value("field"), value, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/workshop-profile", workshop_profile_handler);
    server.Post("/workshop-profile", workshop_profile_handler);

    server.Get("/zone-info", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        ZonePanelInfo info;
        if (!zone_info_on_core_thread(id, info)) {
            res.status = 404;
            res.set_content("{\"error\":\"zone not found\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(zone_info_json(info) + "\n", "application/json; charset=utf-8");
    });

    auto zone_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string action = req.has_param("action") ? req.get_param_value("action") : "";
        // Zone removal is OPEN TO EVERY AUTHENTICATED PLAYER (owner policy 2026-07-16: this is a
        // small-group co-op product on private links, not an anti-griefing surface -- there is no
        // host-only gate on destructive play actions). The old `zone_remove` fail-closed guard was
        // a griefing-protection gate and has been removed. What made removal SAFE is retained and
        // is the reason it can ship to everyone: zone_action_on_core_thread runs under CoreSuspender,
        // purges the v50 zone-UI pointer caches (game.main_interface.civzone cur_bld/list/
        // zone_just_created -- the B34 dangling-pointer fix) BEFORE the free, and frees the zone via
        // Buildings::deconstruct (the native/DFHack civzone destructor that clears assignments and
        // location links the native way). Unauthenticated callers are still refused upstream by the
        // join-auth catch-all, exactly like every other mutation route.
        std::string err;
        if (!zone_action_on_core_thread(id, action, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/zone-action", zone_action_handler);
    server.Post("/zone-action", zone_action_handler);

    server.Get("/zone-squads", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = zone_squads_json_on_core_thread(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("zone squads failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json + "\n", "application/json; charset=utf-8");
    });

    auto zone_squad_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int squad = -1;
        int enabled = 0;
        if (!query_int(req, "id", id) || !query_int(req, "squad", squad) ||
            !query_int(req, "enabled", enabled) || !req.has_param("mode")) {
            res.status = 400;
            res.set_content("missing id/squad/mode/enabled\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        if (!zone_squad_action_on_core_thread(id, squad, req.get_param_value("mode"),
                                              enabled != 0, &err)) {
            res.status = 400;
            res.set_content("zone squad action failed: " + err + "\n",
                            "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/zone-squad-action", zone_squad_action_handler);
    server.Post("/zone-squad-action", zone_squad_action_handler);

    server.Get("/zone-units", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = zone_units_json_on_core_thread(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("zone units failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json + "\n", "application/json; charset=utf-8");
    });

    auto zone_unit_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int unit = -1;
        int assign = 0;
        if (!query_int(req, "id", id) || !query_int(req, "unit", unit)) {
            res.status = 400;
            res.set_content("missing id/unit\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "assign", assign);
        std::string kind = req.has_param("kind") ? req.get_param_value("kind") : "unit";
        std::string err;
        if (!zone_unit_action_on_core_thread(id, unit, assign != 0, kind, &err)) {
            res.status = 400;
            res.set_content("zone unit action failed: " + err + "\n",
                            "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/zone-unit-action", zone_unit_action_handler);
    server.Post("/zone-unit-action", zone_unit_action_handler);

    server.Get("/zone-owners", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = zone_owners_json_on_core_thread(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("zone owners failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json + "\n", "application/json; charset=utf-8");
    });

    auto zone_owner_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int unit = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "unit", unit);
        std::string err;
        if (!zone_owner_action_on_core_thread(id, unit, &err)) {
            res.status = 400;
            res.set_content("zone owner action failed: " + err + "\n",
                            "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/zone-owner-action", zone_owner_action_handler);
    server.Post("/zone-owner-action", zone_owner_action_handler);

    server.Get("/zone-locations", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = zone_locations_json_via_lua(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("zone locations failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json + "\n", "application/json; charset=utf-8");
    });

    auto zone_location_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int location = -1;
        if (!query_int(req, "id", id) || !req.has_param("action")) {
            res.status = 400;
            res.set_content("missing id/action\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "location", location);
        std::string kind = req.has_param("kind") ? req.get_param_value("kind") : "";
        std::string err;
        if (!zone_location_action_via_lua(id, req.get_param_value("action"), kind,
                                          location, &err)) {
            res.status = 400;
            res.set_content("zone location action failed: " + err + "\n",
                            "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/zone-location-action", zone_location_action_handler);
    server.Post("/zone-location-action", zone_location_action_handler);

    // B229 -- Places > Locations depth. Both take a LOCATION id (df::abstract_building::id,
    // site-local), not a zone id: the detail panel is reachable from the Places > Locations tab,
    // where the row has no zone. All logic is in dwf.lua (location_detail_json /
    // location_action); this is only the transport.
    server.Get("/location-detail", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = location_detail_json_via_lua(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("location detail failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        // Additive B276 payload: preserve B229's Lua-owned shape and append the fields whose source
        // of truth is the generated C++ structures. A missing native fragment is an honest partial
        // response; the established location panel still remains usable.
        std::string native = location_native_detail_json(id);
        if (!native.empty() && !json.empty() && json.back() == '}') {
            json.pop_back();
            json += ",\"native\":" + native + "}";
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json + "\n", "application/json; charset=utf-8");
    });

    auto location_native_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int value = 0;
        if (!query_int(req, "id", id) || !req.has_param("action")) {
            res.status = 400;
            res.set_content("missing id/action\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "value", value);
        const std::string action = req.get_param_value("action");
        const std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "";
        std::string err;
        if (!location_native_action(id, action, mode, value, err)) {
            const bool guarded = err.find("guarded behind host flag") != std::string::npos;
            res.status = guarded ? 501 : 400;
            std::ostringstream body;
            body << "{\"ok\":false" << (guarded ? ",\"guarded\":true" : "")
                 << ",\"error\":" << json_string(err) << "}\n";
            res.set_content(body.str(), "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Post("/location-native-action", location_native_action_handler);

    auto location_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int unit = -1;
        if (!query_int(req, "id", id) || !req.has_param("action")) {
            res.status = 400;
            res.set_content("missing id/action\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "unit", unit);
        std::string kind = req.has_param("kind") ? req.get_param_value("kind") : "";
        std::string err;
        if (!location_action_via_lua(id, req.get_param_value("action"), kind, unit, &err)) {
            res.status = 400;
            res.set_content("location action failed: " + err + "\n",
                            "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/location-action", location_action_handler);
    server.Post("/location-action", location_action_handler);
}

} // namespace dwf
