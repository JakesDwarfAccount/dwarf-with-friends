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

#include "interaction.h"

#include "art_desc.h"        // DF-sourced statue/figurine/slab art descriptions
#include "building_zone.h"   // zone_icon_cell for /tile-occupants occupant art
#include "client_state.h"
#include "info_panel.h"      // building_icon_key for /tile-occupants occupant art
#include "interaction_route.h"
#include "route_helpers.h"
#include "unit_status.h"     // unit_is_map_present -- the shared "DF draws this unit" rule
#include <vector>

#include "Core.h"
#include "TileTypes.h"
#include "json_util.h"
#include "panel_http.h"
#include "sdl_capture.h"

#include "modules/Buildings.h"
#include "modules/Items.h"
#include "modules/MapCache.h"
#include "modules/Maps.h"
#include "modules/Materials.h"
#include "modules/Units.h"
#include "modules/World.h"

#include "df/block_square_event.h"
#include "df/block_square_event_grassst.h"
#include "df/block_square_event_item_spatterst.h"
#include "df/block_square_event_material_spatterst.h"
#include "df/building.h"
#include "df/building_stockpilest.h"
#include "df/building_civzonest.h"
#include "df/building_type.h"
#include "df/caste_raw.h"
#include "df/creature_raw.h"
#include "df/engraving.h"
#include "df/event_handlerst.h"
#include "df/global_objects.h"
#include "df/graphic.h"
#include "df/graphic_viewportst.h"
#include "df/flow_info.h"
#include "df/flow_type.h"
#include "df/article_type.h"
#include "df/item.h"
#include "df/item_actual.h"
#include "df/item_plant_growthst.h"
#include "df/item_type.h"
#include "df/job.h"
#include "df/job_list_link.h"
#include "df/job_type.h"
#include "df/map_block.h"
#include "df/map_block_column.h"
#include "df/nemesis_offload.h"
#include "df/plant.h"
#include "df/plotinfost.h"
#include "df/save_substage.h"
#include "df/saverst.h"
#include "df/plant_growth.h"
#include "df/plant_raw.h"
#include "df/tiletype.h"
#include "df/unit.h"
#include "df/vermin.h"
#include "df/world.h"

#include <algorithm>
#include <cstdlib>
#include <mutex>
#include <sstream>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_interaction_mutex;

template <typename Fn>
bool run_suspended(Fn&& fn) {
    std::lock_guard<std::recursive_mutex> interaction_lock(g_interaction_mutex);
    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;
    return fn();
}

bool valid_map_pos(const df::coord& pos) {
    return pos.x >= 0 && pos.y >= 0 && pos.z >= 0;
}

df::coord building_center_pos(df::building* building) {
    if (!building)
        return df::coord();
    return df::coord(building->centerx, building->centery, building->z);
}

std::string readable_unit_name(df::unit* unit) {
    if (!unit)
        return "";
    std::string name = Units::getReadableName(unit);
    if (name.empty())
        name = Units::getRaceReadableName(unit);
    return name;
}

// Container by ITEM TYPE, never by "has contained items", so an EMPTY container is still one.
bool is_container_item(df::item* item) {
    if (!item)
        return false;
    switch (item->getType()) {
    case df::item_type::BIN:
    case df::item_type::BARREL:
    case df::item_type::BOX:      // bags and chests/coffers
    case df::item_type::BUCKET:
    case df::item_type::FLASK:
    case df::item_type::CAGE:
    case df::item_type::ANIMALTRAP:
    case df::item_type::QUIVER:
    case df::item_type::BACKPACK:
        return true;
    default:
        return false;
    }
}

df::item* outer_container(df::item* item) {
    auto cur = item;
    for (int i = 0; cur && i < 32; ++i) {
        auto next = Items::getContainer(cur);
        if (!next || next == cur)
            break;
        cur = next;
    }
    return cur;
}

std::string item_material_name(df::item* item) {
    if (!item)
        return "";
    MaterialInfo mi;
    if (mi.decode(item->getMaterial(), item->getMaterialIndex()))
        return mi.toString();
    return "";
}

std::string item_quality_name(int16_t quality) {
    switch (quality) {
    case 1: return "Well-crafted";
    case 2: return "Finely-crafted";
    case 3: return "Superior";
    case 4: return "Exceptional";
    case 5: return "Masterful";
    default: return "";
    }
}

std::string item_wear_name(int16_t wear) {
    switch (wear) {
    case 0: return "None";
    case 1: return "Worn";
    case 2: return "Very worn";
    case 3: return "Tattered";
    default:
        if (wear > 3)
            return "Rotten";
        return "None";
    }
}

// "This is " + DF's OWN article (getItemDescriptionPrefix) + an optional quality adjective + the
// UNdecorated display name. Books and artifacts keep the getReadableDescription path instead.
std::string item_native_prose(df::item* item) {
    if (!item)
        return "";
    if (item->flags.bits.artifact || !Items::getBookTitle(item).empty())
        return "";
    std::string name = item_display_name(item, 0, false);
    if (name.empty())
        return "";
    const char* adjective = nullptr;
    switch (item->getOverallQuality()) {
    case 1: adjective = "well-crafted "; break;
    case 2: adjective = "finely-crafted "; break;
    case 3: adjective = "superior quality "; break;
    case 4: adjective = "exceptional "; break;
    case 5: adjective = "masterful "; break;
    default: break;
    }
    std::string article;
    item->getItemDescriptionPrefix(&article, df::article_type::INDEFINITE);
    if (adjective && !article.empty()) {
        // The adjective now leads the noun phrase, so re-derive the article from it
        // ("an exceptional...", never "a exceptional").
        article = (adjective[0] == 'e') ? "an " : "a ";
    }
    return "This is " + article + (adjective ? adjective : "") + name + ".";
}

std::string item_weight_text(df::item* item) {
    if (!item)
        return "";
    if (item->flags.bits.weight_computed) {
        if (item->weight.whole > 0)
            return std::to_string(item->weight.whole);
        if (item->weight.fraction > 0)
            return "<1";
    }
    int32_t base = item->getBaseWeight();
    if (base > 0)
        return std::to_string(base);
    return "";
}

// A stockpile is a BUILDING and has no item sprite: DF picks a STOCKPILE_ICON_* cell from which
// item groups the pile accepts. One group = that icon, all = ALL, several = CUSTOM, none = BLANK.
std::string stockpile_icon_token(df::building_stockpilest* pile) {
    if (!pile)
        return "";
    const auto& g = pile->settings.flags.bits;
    struct GroupIcon { unsigned int on; const char* token; };
    const GroupIcon groups[] = {
        {g.animals, "STOCKPILE_ICON_ANIMALS"},   {g.food, "STOCKPILE_ICON_FOOD"},
        {g.furniture, "STOCKPILE_ICON_FURNITURE"}, {g.corpses, "STOCKPILE_ICON_CORPSES"},
        {g.refuse, "STOCKPILE_ICON_REFUSE"},     {g.stone, "STOCKPILE_ICON_STONE"},
        {g.ammo, "STOCKPILE_ICON_AMMO"},         {g.coins, "STOCKPILE_ICON_COINS"},
        {g.bars_blocks, "STOCKPILE_ICON_BARS"},  {g.gems, "STOCKPILE_ICON_GEMS"},
        {g.finished_goods, "STOCKPILE_ICON_FINISHED_GOODS"},
        {g.leather, "STOCKPILE_ICON_LEATHER"},   {g.cloth, "STOCKPILE_ICON_CLOTH"},
        {g.wood, "STOCKPILE_ICON_WOOD"},         {g.weapons, "STOCKPILE_ICON_WEAPONS"},
        {g.armor, "STOCKPILE_ICON_ARMOR"},       {g.sheet, "STOCKPILE_ICON_SHEETS"},
    };
    const size_t total = sizeof(groups) / sizeof(groups[0]);
    size_t enabled = 0;
    const char* only = nullptr;
    for (const auto& group : groups) {
        if (!group.on)
            continue;
        ++enabled;
        only = group.token;
    }
    if (enabled == 0)
        return "STOCKPILE_ICON_BLANK";
    if (enabled == total)
        return "STOCKPILE_ICON_ALL";
    if (enabled == 1)
        return only;
    return "STOCKPILE_ICON_CUSTOM";
}

// DF's own building name, with the same numbered fallback stockpile_panel.cpp uses.
std::string stockpile_location_label(df::building_stockpilest* pile) {
    if (!pile)
        return "";
    std::string name = Buildings::getName(pile);
    if (!name.empty())
        return name;
    return "Stockpile #" + std::to_string(pile->stockpile_number);
}

void resolve_stock_item_location(df::item* item, StockItemActionResult& result) {
    if (!item)
        return;

    auto outer = outer_container(item);
    auto building = Items::getHolderBuilding(item);
    if (!building && outer && outer != item)
        building = Items::getHolderBuilding(outer);
    auto holder = Items::getHolderUnit(item);
    if (!holder && outer && outer != item)
        holder = Items::getHolderUnit(outer);

    if (auto pile = building ? virtual_cast<df::building_stockpilest>(building) : nullptr) {
        result.location_id = building->id;
        result.location_sprite_token = stockpile_icon_token(pile);
        // Native prints the BARE pile name on the location row, never "In Stockpile #1", so this
        // branch names itself and never reaches the "In <building>" fallback below.
        result.location = stockpile_location_label(pile);
    }

    // A CONTAINER location uses that container's own item sprite -- the ordinary item channel,
    // identical in shape to the sheet's own spriteRef.
    if (outer && outer != item) {
        result.location_sprite_type = DFHack::enum_item_key(outer->getType());
        result.location_sprite_subtype = outer->getSubtype();
        result.location_sprite_mat = outer->getMaterial();
        result.location_sprite_mat_index = outer->getMaterialIndex();
    }

    if (holder) {
        result.holder_unit_id = holder->id;
        result.holder_unit_name = readable_unit_name(holder);
        result.location = "With " + result.holder_unit_name;
    }

    if (auto owner = Items::getOwner(item)) {
        result.owner_unit_id = owner->id;
        result.owner_unit_name = readable_unit_name(owner);
    }

    df::coord pos = Items::getPosition(item);
    if (!valid_map_pos(pos) && outer && outer != item)
        pos = Items::getPosition(outer);
    if (!valid_map_pos(pos) && holder)
        pos = Units::getPosition(holder);
    if (!valid_map_pos(pos) && building)
        pos = building_center_pos(building);

    // An item lying ON a stockpile tile carries NO building holder: DF tracks pile membership
    // POSITIONALLY, so resolve the pile by tile. Held and contained items are excluded on purpose.
    if (result.location_id < 0 && !holder && !(outer && outer != item) && valid_map_pos(pos)) {
        if (auto world = df::global::world) {
            for (auto pile : world->buildings.other.STOCKPILE) {
                if (!pile || pile->z != pos.z)
                    continue;
                if (!Buildings::containsTile(pile, df::coord2d(pos.x, pos.y)))
                    continue;
                result.location_id = pile->id;
                result.location_sprite_token = stockpile_icon_token(pile);
                if (result.location.empty())
                    result.location = stockpile_location_label(pile);
                break;
            }
        }
    }

    if (valid_map_pos(pos)) {
        result.has_map_pos = true;
        result.map_x = pos.x;
        result.map_y = pos.y;
        result.map_z = pos.z;
        if (result.location.empty()) {
            if (outer && outer != item) {
                std::string container = item_display_name(outer, 0, true);
                result.location = container.empty() ? "In container" : ("In " + container);
            } else if (building) {
                std::string bname = Buildings::getName(building);
                result.location = bname.empty() ? "In building" : ("In " + bname);
            } else {
                result.location = "On map";
            }
        }
    }
}

bool is_workshop_like_building(df::building* building) {
    if (!building)
        return false;
    auto type = building->getType();
    return type == df::building_type::Workshop || type == df::building_type::Furnace;
}

df::item* find_ground_item_at_tile(const df::coord& pos) {
    auto world = df::global::world;
    if (!world)
        return nullptr;
    df::item* best = nullptr;
    for (auto item : world->items.all) {
        if (!item || !item->flags.bits.on_ground)
            continue;
        if (item->pos.x == pos.x && item->pos.y == pos.y && item->pos.z == pos.z) {
            if (!best || item->id > best->id)
                best = item;
        }
    }
    return best;
}

std::vector<df::unit*> find_units_for_tile_click(const df::coord& pos) {
    auto world = df::global::world;
    if (!world)
        return {};

    // Native selection is exact-tile, so exact units are the first result set and the 3x3
    // candidates are only a fallback, in deterministic order.
    std::vector<df::unit*> exact;
    std::vector<std::pair<int, df::unit*>> fallback;
    for (auto unit : world->units.active) {
        // Filter BEFORE the dx/dy computation so a caged unit can enter neither set: clicking the
        // trap tile must not select the creature DF stopped drawing there.
        if (!unit_is_map_present(unit))
            continue;
        if (unit->pos.z != pos.z || (Units::isDead(unit) && !Units::isGhost(unit)))
            continue;
        int dx = std::abs(unit->pos.x - pos.x);
        int dy = std::abs(unit->pos.y - pos.y);
        if (dx > 1 || dy > 1)
            continue;
        if (dx == 0 && dy == 0)
            exact.push_back(unit);
        else
            fallback.emplace_back(dx + dy, unit);
    }
    auto by_id = [](df::unit* a, df::unit* b) { return a->id < b->id; };
    if (!exact.empty()) {
        std::sort(exact.begin(), exact.end(), by_id);
        return exact;
    }
    std::sort(fallback.begin(), fallback.end(), [](const auto& a, const auto& b) {
        return a.first != b.first ? a.first < b.first : a.second->id < b.second->id;
    });
    std::vector<df::unit*> result;
    for (const auto& candidate : fallback)
        result.push_back(candidate.second);
    return result;
}

df::unit* find_unit_near_tile(const df::coord& pos, std::vector<int32_t>* cycle_ids = nullptr) {
    auto candidates = find_units_for_tile_click(pos);
    if (cycle_ids) {
        cycle_ids->clear();
        for (auto unit : candidates)
            cycle_ids->push_back(unit->id);
    }
    return candidates.empty() ? nullptr : candidates.front();
}


// Click-time surfaces, not stream scans: the caller already holds CoreSuspender.
df::vermin* visible_vermin_at(const df::coord& pos) {
    auto world = df::global::world;
    if (!world)
        return nullptr;
    auto at = [&](const std::vector<df::vermin*>& entries) -> df::vermin* {
        for (auto vermin : entries) {
            if (vermin && vermin->visible && vermin->pos.x == pos.x && vermin->pos.y == pos.y &&
                vermin->pos.z == pos.z)
                return vermin;
        }
        return nullptr;
    };
    if (auto vermin = at(world->event.vermin))
        return vermin;
    return at(world->event.vermin_colonies);
}

bool fill_vermin_sheet(const df::coord& pos, InspectResult& result) {
    auto world = df::global::world;
    auto vermin = visible_vermin_at(pos);
    if (!world || !vermin || vermin->race < 0 ||
        vermin->race >= static_cast<int32_t>(world->raws.creatures.all.size()))
        return false;
    auto creature = world->raws.creatures.all[vermin->race];
    if (!creature)
        return false;
    df::caste_raw* caste = nullptr;
    if (vermin->caste >= 0 && vermin->caste < static_cast<int32_t>(creature->caste.size()))
        caste = creature->caste[vermin->caste];

    result.kind = "vermin";
    result.vermin_token = creature->creature_id;
    result.vermin_caste_token = caste ? caste->caste_id : std::string();
    result.title = caste && !caste->caste_name[0].empty() ? caste->caste_name[0] : creature->name[0];
    if (result.title.empty())
        result.title = creature->creature_id;
    if (caste)
        result.description = caste->description;
    return true;
}

bool planned_engraving_at(const df::coord& pos) {
    auto world = df::global::world;
    if (!world)
        return false;
    if (auto block = Maps::getTileBlock(pos)) {
        // smooth==2 is the unclaimed engrave designation. Once claimed DF clears it and the live
        // DetailWall/DetailFloor job below becomes the authoritative marker.
        if (block->designation[pos.x & 15][pos.y & 15].bits.smooth == 2)
            return true;
    }
    for (df::job_list_link* node = world->jobs.list.next; node; node = node->next) {
        auto job = node->item;
        if (!job || job->pos.x != pos.x || job->pos.y != pos.y || job->pos.z != pos.z)
            continue;
        if (job->job_type == df::job_type::DetailWall || job->job_type == df::job_type::DetailFloor)
            return true;
    }
    return false;
}

// px/py are ALREADY a tile-grid index into the client's own rendered window (world = camera +
// grid_index), so clamp against the caller's frame -- never against DF's native viewport dims.
int pixel_to_tile_coord(int p, int frame) {
    if (frame <= 0)
        return 0;
    return std::max(0, std::min(frame - 1, p));
}

bool pixel_to_map_pos(const Camera& camera,
                      int px,
                      int py,
                      int frame_w,
                      int frame_h,
                      df::coord& pos,
                      int& tile_px,
                      int& tile_py,
                      std::string* err) {
    if (frame_w <= 0 || frame_h <= 0) {
        if (err) *err = "inspect exact-tile-empty-fallback-v1: bad frame dimensions";
        return false;
    }

    int tile_x = pixel_to_tile_coord(px, frame_w);
    int tile_y = pixel_to_tile_coord(py, frame_h);
    pos = df::coord(camera.x + tile_x, camera.y + tile_y, camera.z);

    // tile_px/tile_py are informational only (the JSON tileSize field), so never block the real
    // tile resolution on the DF viewport being available.
    int view_w = 0, view_h = 0;
    if (effective_capture_viewport_dims(camera, view_w, view_h, nullptr) && view_w > 0 && view_h > 0) {
        tile_px = std::max(1, view_w / frame_w);
        tile_py = std::max(1, view_h / frame_h);
    } else {
        tile_px = 1;
        tile_py = 1;
    }
    return true;
}

// Forward-declared so the SELECTION chain uses the very same lookup the HOVER already trusts.
bool engraving_at_tile(const df::coord& pos);

// The statue renderer paints the subject one screen row above the 1x1 footprint, where
// findAtTile() returns null. Only an empty clicked cell maps down, and only onto a Statue.
df::building* find_click_building(const df::coord& pos) {
    if (auto building = Buildings::findAtTile(pos))
        return building;
    RouteCoord mapped = statue_overhang_footprint({pos.x, pos.y, pos.z});
    df::coord footprint(mapped.x, mapped.y, mapped.z);
    auto building = Buildings::findAtTile(footprint);
    return building && building->getType() == df::building_type::Statue ? building : nullptr;
}

bool inspect_at_pixel(const Camera& camera,
                      int px,
                      int py,
                      int frame_w,
                      int frame_h,
                      InspectResult& result,
                      std::string* err) {
    df::coord pos;
    int tile_px = 0;
    int tile_py = 0;
    if (!pixel_to_map_pos(camera, px, py, frame_w, frame_h, pos, tile_px, tile_py, err))
        return false;

    result.camera = camera;
    result.px = px;
    result.py = py;
    result.tile_px = tile_px;
    result.tile_py = tile_py;
    result.map_x = pos.x;
    result.map_y = pos.y;
    result.map_z = pos.z;

    if (auto building = find_click_building(pos)) {
        if (is_workshop_like_building(building)) {
            result.kind = "workshop";
            result.building_id = building->id;
            result.title = Buildings::getName(building);
            if (result.title.empty())
                result.title = "Workshop";
            result.lines.push_back("Position: " + std::to_string(pos.x) + "," +
                                   std::to_string(pos.y) + "," + std::to_string(pos.z));
            result.lines.push_back("Building id: " + std::to_string(building->id));
            return true;
        }
    }

    std::vector<int32_t> nearby_unit_cycle_ids;
    df::unit* nearby_unit = find_unit_near_tile(pos, &nearby_unit_cycle_ids);
    auto select_unit = [&](df::unit* unit) {
        result.unit_cycle_ids = nearby_unit_cycle_ids;
        result.kind = "unit";
        result.title = readable_unit_name(unit);
        result.unit = build_unit_sheet(unit);
        result.lines.push_back("Profession: " + Units::getProfessionName(unit));
        result.lines.push_back("Creature: " + Units::getRaceReadableName(unit));
        result.lines.push_back("Position: " + std::to_string(unit->pos.x) + "," +
                               std::to_string(unit->pos.y) + "," + std::to_string(unit->pos.z));
        result.lines.push_back("Unit id: " + std::to_string(unit->id));
        return true;
    };
    if (nearby_unit && nearby_unit->pos.x == pos.x && nearby_unit->pos.y == pos.y &&
        nearby_unit->pos.z == pos.z)
        return select_unit(nearby_unit);

    if (auto building = find_click_building(pos)) {
        // DF selects the ITEM under the cursor rather than the stockpile when a pile tile holds
        // one. Non-stockpile buildings still take precedence over ground items.
        if (building->getType() == df::building_type::Stockpile) {
            if (auto item = find_ground_item_at_tile(pos)) {
                result.kind = "item";
                result.item_id = item->id;
                result.title = item_display_name(item, 0, true);
                if (result.title.empty())
                    result.title = "Item " + std::to_string(item->id);
                result.lines.push_back("Position: " + std::to_string(pos.x) + "," +
                                       std::to_string(pos.y) + "," + std::to_string(pos.z));
                return true;
            }
            result.kind = "stockpile";
        } else {
            result.kind = "building";
        }
        result.building_id = building->id;
        result.title = Buildings::getName(building);
        if (result.title.empty())
            result.title = "Building";
        // A statue BUILDING holds only an unused statue_flag; its title and prose live on the
        // contained item_statuest.
        if (building->getType() == df::building_type::Statue) {
            ItemArt art = building_art(building);
            if (!art.title.empty())
                result.title = art.title;
            // Keep the base-name fallback out of the prose channel: the client merges this field
            // into artDescription, so a name sent here would be served as body text.
            result.description = art.description;
        }
        result.lines.push_back("Position: " + std::to_string(pos.x) + "," +
                               std::to_string(pos.y) + "," + std::to_string(pos.z));
        result.lines.push_back("Building id: " + std::to_string(building->id));
        return true;
    }

    if (auto item = find_ground_item_at_tile(pos)) {
        result.kind = "item";
        result.item_id = item->id;
        result.title = item_display_name(item, 0, true);
        if (result.title.empty())
            result.title = "Item " + std::to_string(item->id);
        result.lines.push_back("Position: " + std::to_string(pos.x) + "," +
                               std::to_string(pos.y) + "," + std::to_string(pos.z));
        return true;
    }

    // Native reaches vermin after every unit/building/item occupant. The tail wire carries only
    // raws indices, so /inspect adds the DF caste name and body rather than let the browser guess.
    if (fill_vermin_sheet(pos, result))
        return true;

    // The tiny planned-engraving sheet, reachable from both the map designation bit and a claimed
    // DetailWall/DetailFloor job.
    if (planned_engraving_at(pos)) {
        result.kind = "planned-engraving";
        result.title = "Planned engraving";
        return true;
    }

    // An engraving is a TILE PROPERTY, not an occupant, so it resolves LAST: anything standing on
    // the tile still wins, and the engraving is what the bare tile resolves to.
    EngravingArt engraving;
    bool has_engraving = engraving_art_at(pos, engraving);
    std::vector<df::building_civzonest*> zones;
    bool has_civzone = Buildings::findCivzonesAt(&zones, pos) && !zones.empty();
    switch (surface_click_route(has_engraving, has_civzone)) {
    case SurfaceClickRoute::Engraving:
        result.kind = "engraving";
        result.title = !engraving.title.empty() ? engraving.title : "Engraving";
        result.description = engraving.description;
        result.lines.push_back("Position: " + std::to_string(pos.x) + "," +
                               std::to_string(pos.y) + "," + std::to_string(pos.z));
        return true;
    case SurfaceClickRoute::Civzone: {
        auto zone = zones.front();
        result.kind = "zone";
        result.building_id = zone->id;
        result.title = Buildings::getName(zone);
        if (result.title.empty())
            result.title = "Zone";
        result.lines.push_back("Position: " + std::to_string(pos.x) + "," +
                               std::to_string(pos.y) + "," + std::to_string(pos.z));
        return true;
    }
    case SurfaceClickRoute::Tile:
        // UI-DIV-016: the one-tile unit forgiveness is a browser divergence, allowed only after
        // every exact-tile occupant route above has declined the click.
        if (nearby_unit)
            return select_unit(nearby_unit);
        result.kind = "tile";
        if (auto tt = Maps::getTileType(pos))
            result.title = tileName(*tt);
        else
            result.title = "Unknown tile";
        result.lines.push_back("Position: " + std::to_string(pos.x) + "," +
                               std::to_string(pos.y) + "," + std::to_string(pos.z));
        return true;
    }
    return false;
}

// Hover lines mirror DF's own tooltip: ONE ENTRY PER LINE, each tagged with its category. DF's
// capitalization quirks are preserved -- qualifiers and form words up, items and species down.
constexpr size_t HOVER_SEGMENT_CAP = 40;

std::string hover_capitalize(std::string s) {
    if (!s.empty() && s[0] >= 'a' && s[0] <= 'z')
        s[0] = (char)(s[0] - 'a' + 'A');
    return s;
}

// dedupe=false: DF lists every ground item individually (18 loose seed bags = 18 lines).
void hover_push(HoverResult& out,
                const char* kind,
                const std::string& seg,
                bool dedupe = true) {
    if (seg.empty() || out.lines.size() >= HOVER_SEGMENT_CAP)
        return;
    if (dedupe) {
        for (const auto& l : out.lines)
            if (l == seg)
                return;
    }
    out.lines.push_back(seg);
    out.kinds.push_back(kind);
}

// DF's display FORM word for the tiletype shape, capitalized exactly as the native tooltip shows.
const char* hover_shape_suffix(df::tiletype_shape shape) {
    using df::tiletype_shape;
    switch (shape) {
    case tiletype_shape::FLOOR:         return " Floor";
    case tiletype_shape::PEBBLES:       return " Pebbles";
    case tiletype_shape::BOULDER:       return " Boulder";
    case tiletype_shape::WALL:          return " Wall";
    case tiletype_shape::FORTIFICATION: return " Fortification";
    case tiletype_shape::STAIR_UP:      return " Upward Staircase";
    case tiletype_shape::STAIR_DOWN:    return " Downward Staircase";
    case tiletype_shape::STAIR_UPDOWN:  return " Up/Down Staircase";
    // RAMP is the upward ramp body; RAMP_TOP is its one-z-above proxy, and native distinguishes them.
    case tiletype_shape::RAMP:          return " Upward Slope";
    case tiletype_shape::BROOK_BED:     return " Brook Bed";
    default:                            return "";
    }
}

// world->event.engravings is the vector in this structures version -- there is no world->engravings.
bool engraving_at_tile(const df::coord& pos) {
    auto world = df::global::world;
    if (!world)
        return false;
    for (auto e : world->event.engravings) {
        if (e && e->pos.x == pos.x && e->pos.y == pos.y && e->pos.z == pos.z)
            return true;
    }
    return false;
}

// The terrain line: material through MapCache (layer stone / soil / veins / constructions), DF's
// capitalized form word, "Cavern" underground, "Muddy" under mud. Grass and plants name themselves.
std::string hover_terrain_segment(const df::coord& pos,
                                  df::tiletype tt,
                                  bool subterranean,
                                  bool muddy,
                                  MapExtras::MapCache& mc) {
    using namespace df::enums;
    auto shape = tileShape(tt);
    auto tmat = tileMaterial(tt);
    auto special = tileSpecial(tt);

    if (shape == tiletype_shape::EMPTY)
        return "open space";
    if (shape == tiletype_shape::RAMP_TOP)
        return "Downward Slope";

    std::string muddy_prefix = muddy ? "Muddy " : "";

    switch (tmat) {
    case tiletype_material::AIR:
        return "open space";
    case tiletype_material::FROZEN_LIQUID:
        return muddy_prefix + "ice" + hover_shape_suffix(shape);
    case tiletype_material::MAGMA:
        return "semi-molten rock";
    case tiletype_material::FIRE:
        return "fire";
    case tiletype_material::CAMPFIRE:
        return "campfire";
    case tiletype_material::ASHES:
        return "ashes";
    case tiletype_material::POOL:
        return muddy_prefix + "Murky Pool" + hover_shape_suffix(shape);
    case tiletype_material::RIVER:
        return muddy_prefix + "River" + hover_shape_suffix(shape);
    case tiletype_material::BROOK:
        return muddy_prefix + "Brook" + hover_shape_suffix(shape);
    // Grass is enumerated by name from the grass block events; standing plants are named by the
    // plant section instead.
    case tiletype_material::GRASS_LIGHT:
    case tiletype_material::GRASS_DARK:
    case tiletype_material::GRASS_DRY:
    case tiletype_material::GRASS_DEAD:
    case tiletype_material::PLANT:
    case tiletype_material::TREE:
    case tiletype_material::ROOT:
    case tiletype_material::MUSHROOM:
        return "";
    default:
        break;
    }

    // staticMaterialAt resolves a construction to its built material, otherwise the base layer,
    // soil, vein, lava stone or feature.
    std::string mat;
    if (auto* b = mc.BlockAtTile(pos)) {
        df::coord2d rel(pos.x & 15, pos.y & 15);
        auto mp = b->staticMaterialAt(rel);
        MaterialInfo mi;
        if (mp.mat_index >= 0 && mi.decode(mp.mat_type, mp.mat_index))
            mat = mi.toString();
    }
    if (mat.empty()) {
        // Fall back to DFHack's own tiletype caption ("murky pool", "waterfall", ...).
        const char* cap = tileName(tt);
        return cap ? std::string(cap) : std::string();
    }

    std::string prefix = muddy_prefix;
    if (special == tiletype_special::SMOOTH || special == tiletype_special::SMOOTH_DEAD)
        prefix += engraving_at_tile(pos) ? "Engraved " : "Smooth ";
    // "Cavern" sits between the material and the form word for natural subterranean tiles;
    // constructions never get it.
    std::string cavern =
        (subterranean && tmat != tiletype_material::CONSTRUCTION) ? " Cavern" : "";
    if (special == tiletype_special::TRACK)
        return prefix + mat + cavern + " Track";
    return prefix + mat + cavern + hover_shape_suffix(shape);
}

// Species line via Maps::getPlantAtTile, which also resolves a grown tree's multi-tile extent.
// Casing follows DF's own quirk: "Dead Guava tree Sapling" but "finger lime tree trunk".
std::string hover_plant_segment(df::tiletype tt, df::plant_raw* pr) {
    using namespace df::enums;
    if (!pr || pr->name.empty())
        return "";
    auto shape = tileShape(tt);
    auto tmat = tileMaterial(tt);
    auto special = tileSpecial(tt);
    bool is_dead =
        special == tiletype_special::DEAD || special == tiletype_special::SMOOTH_DEAD;
    std::string dead = is_dead ? "Dead " : "";
    if (shape == tiletype_shape::SAPLING)
        return dead + (is_dead ? hover_capitalize(pr->name) : pr->name) + " Sapling";
    if (shape == tiletype_shape::SHRUB)
        return dead + pr->name;
    if (shape == tiletype_shape::TWIG)
        return dead + pr->name + " twigs";
    if (shape == tiletype_shape::BRANCH || shape == tiletype_shape::TRUNK_BRANCH)
        return dead + pr->name + " branches";
    if (tmat == tiletype_material::ROOT)
        return dead + pr->name + " roots";
    if (tmat == tiletype_material::TREE || tmat == tiletype_material::MUSHROOM ||
        tmat == tiletype_material::PLANT)
        return dead + pr->name + " trunk";
    return dead + pr->name;
}

// DF phrases material spatter as a sentence ("A dusting of mud"), with the verb chosen by matter
// state and amount.
std::string material_spatter_sentence(df::block_square_event_material_spatterst* sp, int amt) {
    if (!sp)
        return "";
    MaterialInfo smi;
    if (!smi.decode(sp->mat_type, sp->mat_index))
        return "";
    std::string name = smi.toString();
    if (name.empty())
        return "";
    // DF names frozen water spatter "snow".
    if (smi.isBuiltin() && name == "water" && sp->mat_state == df::matter_state::Powder)
        name = "snow";
    // The liquid/solid verb boundary sits at amount 100.
    bool liquid = sp->mat_state == df::matter_state::Liquid;
    const char* verb;
    if (liquid)
        verb = amt < 100 ? "a smear of " : "a pool of ";
    else
        verb = amt < 100 ? "a dusting of " : "a pile of ";
    return hover_capitalize(verb + name);
}

// Fallen growths are neither items nor material spatter -- they are item-spatter block events.
// DF names them with the growth's plural; seeds use the plant's seed_plural.
std::string item_spatter_name(df::block_square_event_item_spatterst* sp) {
    if (!sp)
        return "";
    MaterialInfo mi;
    if (!mi.decode(sp->mattype, sp->matindex))
        return "";
    if (mi.plant) {
        if (sp->item_type == df::item_type::PLANT_GROWTH) {
            for (auto g : mi.plant->growths) {
                if (!g)
                    continue;
                if (g->mat_type == sp->mattype && g->mat_index == sp->matindex) {
                    if (!g->name_plural.empty())
                        return g->name_plural;
                    return g->name;
                }
            }
        }
        if (sp->item_type == df::item_type::SEEDS && !mi.plant->seed_plural.empty())
            return mi.plant->seed_plural;
    }
    return mi.toString();
}

std::string item_display_name_impl(df::item* item, int type, bool decorate) {
    if (!item || item->getType() != df::item_type::PLANT_GROWTH)
        return item ? Items::getDescription(item, type, decorate) : "";
    auto growth_item = virtual_cast<df::item_plant_growthst>(item);
    MaterialInfo mi;
    if (!growth_item || !mi.decode(growth_item->mat_type, growth_item->mat_index) || !mi.plant ||
        growth_item->subtype < 0 || (size_t)growth_item->subtype >= mi.plant->growths.size() ||
        !mi.plant->growths[growth_item->subtype])
        return Items::getDescription(item, type, decorate);

    auto growth = mi.plant->growths[growth_item->subtype];
    const bool plural = item->getStackSize() > 1;
    const std::string& growth_name = plural && !growth->name_plural.empty()
        ? growth->name_plural : growth->name;
    if (growth_name.empty())
        return Items::getDescription(item, type, decorate);
    if (!decorate)
        return growth_name;

    std::string base = Items::getDescription(item, type, false);
    std::string decorated = Items::getDescription(item, type, true);
    size_t at = base.empty() ? std::string::npos : decorated.find(base);
    if (at == std::string::npos)
        return growth_name;
    decorated.replace(at, base.size(), growth_name);
    return decorated;
}

// Coverage qualifier from the per-tile grass amount. Only "Dense" is confirmed against native, so
// lighter coverage is named plainly rather than given an invented adjective.
const char* grass_density_prefix(int amount) {
    return amount >= 67 ? "Dense " : "";
}

// Unknown future flow types deliberately return empty, so hover fails open instead of inventing
// a player-facing label.
const char* hover_flow_name(df::flow_type type) {
    using df::flow_type;
    switch (type) {
    case flow_type::Miasma:       return "Miasma";
    case flow_type::Steam:        return "Steam";
    case flow_type::Mist:         return "Mist";
    case flow_type::MaterialDust: return "Material dust";
    case flow_type::MagmaMist:    return "Magma mist";
    case flow_type::Smoke:        return "Smoke";
    case flow_type::Dragonfire:   return "Dragonfire";
    case flow_type::Fire:         return "Fire";
    case flow_type::Web:          return "Web";
    case flow_type::MaterialGas:  return "Material gas";
    case flow_type::MaterialVapor:return "Material vapor";
    case flow_type::OceanWave:    return "Ocean wave";
    case flow_type::SeaFoam:      return "Sea foam";
    case flow_type::ItemCloud:    return "Item cloud";
    default:                      return "";
    }
}

// DF's own hover order: units -> ground items -> building -> standing plant -> terrain -> liquid
// -> item spatter -> material spatter. A hidden tile reports nothing, or it leaks map knowledge.
bool hover_at_pixel(const Camera& camera,
                    int px,
                    int py,
                    int frame_w,
                    int frame_h,
                    HoverResult& out,
                    std::string* err) {
    df::coord pos;
    int tile_px = 0;
    int tile_py = 0;
    if (!pixel_to_map_pos(camera, px, py, frame_w, frame_h, pos, tile_px, tile_py, err))
        return false;

    out.map_x = pos.x;
    out.map_y = pos.y;
    out.map_z = pos.z;

    auto world = df::global::world;
    auto block = Maps::getTileBlock(pos);
    if (!world || !block)
        return true;   // off-map: empty hover, like DF

    int lx = pos.x & 15;
    int ly = pos.y & 15;
    auto des = block->designation[lx][ly];
    if (des.bits.hidden)
        return true;   // fog: reveal nothing

    df::tiletype tt = block->tiletype[lx][ly];

    // Mud spatter also becomes the terrain's "Muddy" qualifier, on top of its own spatter line.
    bool muddy = false;
    for (size_t ei = 0; ei < block->block_events.size(); ++ei) {
        auto sp = virtual_cast<df::block_square_event_material_spatterst>(block->block_events[ei]);
        if (!sp || sp->amount[lx][ly] <= 0)
            continue;
        MaterialInfo smi;
        if (smi.decode(sp->mat_type, sp->mat_index) && smi.isBuiltin() &&
            smi.toString() == "mud") {
            muddy = true;
            break;
        }
    }

    // (1) UNITS. unit_is_map_present also drops caged units, whose pos is frozen at the trap tile
    // -- hovering the trap must not list a creature DF draws nowhere.
    for (auto unit : world->units.active) {
        if (!unit_is_map_present(unit))
            continue;
        if (unit->pos.x != pos.x || unit->pos.y != pos.y || unit->pos.z != pos.z)
            continue;
        if (Units::isHidden(unit))
            continue;
        hover_push(out, "unit", readable_unit_name(unit));
    }

    // (2) GROUND ITEMS, each one individually and carrying DF's own decorations. Contained items
    // are NOT listed: the native tooltip on a full barrel shows only the barrel.
    for (int32_t id : block->items) {
        if (out.lines.size() >= HOVER_SEGMENT_CAP)
            break;
        auto item = df::item::find(id);
        if (!item || item->pos.x != pos.x || item->pos.y != pos.y || item->pos.z != pos.z)
            continue;
        if (!item->flags.bits.on_ground || item->flags.bits.hidden ||
            item->flags.bits.garbage_collect)
            continue;
        hover_push(out, "item", item_display_name(item, 0, true), /*dedupe=*/false);
    }

    // (3) BUILDING on the tile (stockpile, workshop, furniture, ...).
    if (auto building = Buildings::findAtTile(pos))
        hover_push(out, "building", Buildings::getName(building));

    // (4) STANDING PLANT -- the part line only. The growth names players see are FALLEN growths,
    // i.e. the item spatter below.
    if (df::plant* pl = Maps::getPlantAtTile(pos)) {
        if (df::plant_raw* pr = df::plant_raw::find(pl->material))
            hover_push(out, "plant", hover_plant_segment(tt, pr));
    }

    // (5) TERRAIN. Grass floors are named by their grass, densest first; everything else gets the
    // shape-formed material name.
    {
        auto tmat = tileMaterial(tt);
        bool grass_tile = tmat == df::tiletype_material::GRASS_LIGHT ||
                          tmat == df::tiletype_material::GRASS_DARK ||
                          tmat == df::tiletype_material::GRASS_DRY ||
                          tmat == df::tiletype_material::GRASS_DEAD;
        if (grass_tile) {
            const char* qual = tmat == df::tiletype_material::GRASS_DEAD ? "Dead "
                             : tmat == df::tiletype_material::GRASS_DRY  ? "Dry "
                                                                         : nullptr;
            std::vector<std::pair<int, std::string>> grasses;
            for (size_t ei = 0; ei < block->block_events.size(); ++ei) {
                auto ev = virtual_cast<df::block_square_event_grassst>(block->block_events[ei]);
                if (!ev)
                    continue;
                int amt = ev->amount[lx][ly];
                if (amt <= 0)
                    continue;
                if (ev->plant_index < 0 ||
                    ev->plant_index >= (int32_t)world->raws.plants.all.size())
                    continue;
                df::plant_raw* pr = world->raws.plants.all[ev->plant_index];
                if (!pr || pr->name.empty())
                    continue;
                grasses.emplace_back(amt, std::string(qual ? qual : grass_density_prefix(amt)) +
                                              pr->name);
            }
            std::sort(grasses.begin(), grasses.end(),
                      [](const std::pair<int, std::string>& a,
                         const std::pair<int, std::string>& b) { return a.first > b.first; });
            for (auto& gr : grasses)
                hover_push(out, "terrain", gr.second);
        } else {
            MapExtras::MapCache mc;
            hover_push(out, "terrain",
                       hover_terrain_segment(pos, tt, des.bits.subterranean, muddy, mc));
        }
    }

    // (6) LIQUID, after the terrain line, in DF's own order.
    if (des.bits.flow_size > 0) {
        bool magma = des.bits.liquid_type == df::tile_liquid::Magma;
        std::string liq = magma ? "magma" : (des.bits.water_stagnant ? "Stagnant water"
                                                                     : "water");
        hover_push(out, "liquid", hover_capitalize(
            liq + " [" + std::to_string((int)des.bits.flow_size) + "/7]"));
    }

    // (7) FLOW CLOUD, on the renderer's densest-live-flow rule. Expired slots stay in this vector
    // with DEAD set.
    df::flow_info* hover_flow = nullptr;
    for (auto flow : block->flows) {
        if (!flow || flow->flags.bits.DEAD || flow->density <= 0 || flow->pos != pos)
            continue;
        if (!hover_flow || flow->density > hover_flow->density)
            hover_flow = flow;
    }
    if (hover_flow)
        hover_push(out, "flow", hover_flow_name(hover_flow->type));

    // (8) FALLEN-GROWTH ITEM SPATTER, newest events first.
    for (size_t ei = block->block_events.size(); ei-- > 0;) {
        auto sp = virtual_cast<df::block_square_event_item_spatterst>(block->block_events[ei]);
        if (!sp || sp->amount[lx][ly] <= 0)
            continue;
        hover_push(out, "growth", hover_capitalize(item_spatter_name(sp)));
    }

    // (9) CONTAMINANT MATERIAL SPATTER as DF's sentences ("A dusting of mud").
    for (size_t ei = 0; ei < block->block_events.size(); ++ei) {
        auto sp = virtual_cast<df::block_square_event_material_spatterst>(block->block_events[ei]);
        if (!sp || sp->amount[lx][ly] <= 0)
            continue;
        hover_push(out, "spatter", material_spatter_sentence(sp, sp->amount[lx][ly]));
    }

    // The legacy `material` footer stays empty: the terrain line lives in lines/kinds now, and a
    // new client consults `material` only when talking to an old server.
    out.material.clear();
    return true;
}

} // namespace

std::string item_display_name(df::item* item, int type, bool decorate) {
    return item_display_name_impl(item, type, decorate);
}

bool action_on_core_thread(const std::string& action, std::string* err) {
    return run_suspended([&]() {
        if (action == "pause") {
            World::SetPauseState(true);
            return true;
        }
        if (action == "play" || action == "resume" || action == "unpause") {
            World::SetPauseState(false);
            return true;
        }
        if (action == "toggle-pause") {
            if (!df::global::pause_state) {
                if (err) *err = "pause state unavailable";
                return false;
            }
            World::SetPauseState(!*df::global::pause_state);
            return true;
        }
        if (err) *err = "unsupported action";
        return false;
    });
}

// Save only, never exits: it sets DF's own autosave-request flags on the core thread and DF's main
// loop performs the world write. Refuses with no world, outside fortress mode, or mid-save.
bool save_world_on_core_thread(std::string* err) {
    return run_suspended([&]() -> bool {
        if (!DFHack::Maps::IsValid()) {
            if (err) *err = "world and map aren't loaded";
            return false;
        }
        if (!DFHack::World::isFortressMode()) {
            if (err) *err = "only fortress mode can be saved this way";
            return false;
        }
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) {
            if (err) *err = "world not loaded";
            return false;
        }
        auto& m = plotinfo->main;
        if (m.autosave_request) {
            if (err) *err = "save already in progress";
            return false;
        }
        // Mirror DFHack's own quicksave script exactly.
        m.autosave_request = true;
        m.autosave_timer = 5;
        m.save_progress.substage = df::save_substage::Initializing;  // 0
        m.save_progress.stage = 0;
        m.save_progress.info.nemesis_save_file_id.resize(0);
        m.save_progress.info.nemesis_member_idx.resize(0);
        m.save_progress.info.units.resize(0);
        m.save_progress.info.cur_unit_chunk = nullptr;
        m.save_progress.info.cur_unit_chunk_num = -1;
        m.save_progress.info.units_offloaded = -1;
        return true;
    });
}

bool stock_item_action_on_core_thread(int32_t item_id,
                                      const std::string& action,
                                      StockItemActionResult& result) {
    return run_suspended([&]() {
        auto item = df::item::find(item_id);
        if (!item) {
            result.err = "item not found";
            return false;
        }

        // Decorated descriptions are DF's own item text: quality/wear wrappers and artifact proper
        // names must stay visible in the stock detail sheet.
        result.title = item_display_name(item, 0, true);
        if (result.title.empty())
            result.title = "Item " + std::to_string(item_id);
        // The description is native's PROSE SENTENCE, not the decorated name again --
        // getReadableDescription IS the title for ordinary items, so it stays only as a fallback.
        if (ItemArt art = item_art(item); !art.description.empty())
            result.description = art.description;
        if (result.description.empty())
            result.description = item_native_prose(item);
        if (result.description.empty())
            result.description = Items::getReadableDescription(item);
        if (result.description.empty())
            result.description = result.title;

        resolve_stock_item_location(item, result);

        if (action == "zoom" || action == "view" || action == "follow") {
            if (result.has_map_pos) {
                int half_w = 40;
                int half_h = 25;
                if (auto gps = df::global::gps; gps && gps->main_viewport) {
                    half_w = std::max(1, gps->main_viewport->dim_x / 2);
                    half_h = std::max(1, gps->main_viewport->dim_y / 2);
                }
                result.camera = {result.map_x - half_w, result.map_y - half_h, result.map_z};
                result.has_camera = true;
            }
        } else if (action == "info" || action == "unfollow") {
            // Read-only. `unfollow` releases the latch and must NOT move the camera.
        } else if (action == "forbid") {
            item->flags.bits.forbid = !item->flags.bits.forbid;
        } else if (action == "dump") {
            item->flags.bits.dump = !item->flags.bits.dump;
        } else if (action == "hide") {
            item->flags.bits.hidden = !item->flags.bits.hidden;
        } else {
            result.err = "unsupported item action";
            return false;
        }

        result.forbidden = item->flags.bits.forbid;
        result.dump = item->flags.bits.dump;
        result.hidden = item->flags.bits.hidden;
        result.weight = item_weight_text(item);
        result.value = Items::getValue(item);
        result.item_type = DFHack::enum_item_key(item->getType());
        result.item_subtype = item->getSubtype();
        result.material_type = item->getMaterial();
        result.material_index = item->getMaterialIndex();

        result.lines.push_back(result.description);
        result.lines.push_back("Type: " + DFHack::enum_item_key(item->getType()));
        if (auto mat = item_material_name(item); !mat.empty())
            result.lines.push_back("Material: " + mat);
        if (auto quality = item_quality_name(item->getOverallQuality()); !quality.empty())
            result.lines.push_back("Quality: " + quality);
        if (auto weight = item_weight_text(item); !weight.empty())
            result.lines.push_back("Weight: " + weight);
        if (auto actual = virtual_cast<df::item_actual>(item))
            result.lines.push_back("Wear: " + item_wear_name(actual->wear));
        if (auto container = Items::getContainer(item)) {
            std::string desc = item_display_name(container, 0, true);
            result.lines.push_back("Container: " +
                (desc.empty() ? ("Item " + std::to_string(container->id)) : desc));
        }
        if (!result.location.empty())
            result.lines.push_back("Location: " + result.location);
        if (result.has_map_pos) {
            result.lines.push_back("Position: " + std::to_string(result.map_x) + "," +
                                   std::to_string(result.map_y) + "," + std::to_string(result.map_z));
        } else {
            result.lines.push_back("Position: Unknown");
        }
        if (!result.owner_unit_name.empty())
            result.lines.push_back("Owner: " + result.owner_unit_name);
        result.lines.push_back(std::string("Forbidden: ") + (item->flags.bits.forbid ? "Yes" : "No"));
        result.lines.push_back(std::string("Dump: ") + (item->flags.bits.dump ? "Yes" : "No"));
        result.lines.push_back(std::string("Hidden: ") + (item->flags.bits.hidden ? "Yes" : "No"));

        result.is_container = is_container_item(item);

        std::vector<df::item*> contained;
        Items::getContainedItems(item, &contained);
        for (auto child : contained) {
            if (!child)
                continue;
            std::string desc = item_display_name(child, 0, true);
            StockItemActionResult::Content row;
            row.id = child->id;
            row.name = desc.empty() ? ("Item " + std::to_string(child->id)) : desc;
            row.forbidden = child->flags.bits.forbid != 0;
            row.dump = child->flags.bits.dump != 0;
            row.hidden = child->flags.bits.hidden != 0;
            row.sprite_type = DFHack::enum_item_key(child->getType());
            row.sprite_subtype = child->getSubtype();
            row.sprite_mat = child->getMaterial();
            row.sprite_mat_index = child->getMaterialIndex();
            result.contents.push_back(std::move(row));
            if (result.contents.size() >= 40)
                break;
        }

        result.ok = true;
        return true;
    });
}

bool inspect_on_core_thread(const Camera& camera,
                            int px,
                            int py,
                            int frame_w,
                            int frame_h,
                            InspectResult& result,
                            std::string* err) {
    return run_suspended([&]() {
        return inspect_at_pixel(camera, px, py, frame_w, frame_h, result, err);
    });
}

bool hover_on_core_thread(const Camera& camera,
                          int px,
                          int py,
                          int frame_w,
                          int frame_h,
                          HoverResult& result,
                          std::string* err) {
    return run_suspended([&]() {
        return hover_at_pixel(camera, px, py, frame_w, frame_h, result, err);
    });
}

std::string inspect_json(const std::string& player, const InspectResult& result) {
    std::ostringstream body;
    body << "{"
         << "\"player\":" << json_string(player) << ","
         << "\"kind\":" << json_string(result.kind) << ","
         << "\"title\":" << json_string(result.title) << ","
         << "\"description\":" << json_string(result.description) << ","
         << "\"verminToken\":" << json_string(result.vermin_token) << ","
         << "\"verminCasteToken\":" << json_string(result.vermin_caste_token) << ","
         << "\"buildingId\":" << result.building_id << ","
         << "\"itemId\":" << result.item_id << ","
         << "\"camera\":{\"x\":" << result.camera.x
         << ",\"y\":" << result.camera.y
         << ",\"z\":" << result.camera.z << "},"
         << "\"tile\":{\"x\":" << result.map_x
         << ",\"y\":" << result.map_y
         << ",\"z\":" << result.map_z << "},"
         << "\"pixel\":{\"x\":" << result.px << ",\"y\":" << result.py << "},"
         << "\"tileSize\":{\"x\":" << result.tile_px << ",\"y\":" << result.tile_py << "},"
         << "\"lines\":";
    append_json_string_array(body, result.lines);
    if (!result.unit_cycle_ids.empty()) {
        body << ",\"unitCycle\":[";
        for (size_t i = 0; i < result.unit_cycle_ids.size(); ++i) {
            if (i) body << ",";
            body << result.unit_cycle_ids[i];
        }
        body << "]";
    }
    if (result.unit.present) {
        body << ",\"unit\":";
        append_unit_sheet_json(body, result.unit);
    }
    body << "}\n";
    return body.str();
}

std::string hover_json(const std::string& player, const HoverResult& h) {
    std::ostringstream body;
    body << "{"
         << "\"player\":" << json_string(player) << ","
         << "\"tile\":{\"x\":" << h.map_x << ",\"y\":" << h.map_y << ",\"z\":" << h.map_z << "},"
         << "\"material\":" << json_string(h.material) << ","
         << "\"lines\":";
    append_json_string_array(body, h.lines);
    // per-line categories (parallel to lines) for DF-style per-category colors.
    body << ",\"kinds\":";
    append_json_string_array(body, h.kinds);
    body << "}\n";
    return body.str();
}

std::string stock_item_action_json(int32_t item_id, const StockItemActionResult& result) {
    std::ostringstream body;
    body << "{\"ok\":true,"
         << "\"id\":" << item_id << ","
         << "\"title\":" << json_string(result.title) << ","
         << "\"description\":" << json_string(result.description) << ","
         << "\"weight\":" << json_string(result.weight) << ","
         << "\"value\":" << result.value << ","
         << "\"spriteRef\":{\"itemType\":" << json_string(result.item_type)
         << ",\"itemSubtype\":" << result.item_subtype
         << ",\"materialType\":" << result.material_type
         << ",\"materialIndex\":" << result.material_index << "},"
         << "\"locationId\":" << result.location_id << ","
         // locationSpriteRef is an ITEM ref (a container), locationSpriteToken an INTERFACE token
         // (STOCKPILE_ICON_*). They never both apply.
         << "\"locationSpriteRef\":";
    if (!result.location_sprite_type.empty()) {
        body << "{\"itemType\":" << json_string(result.location_sprite_type)
             << ",\"itemSubtype\":" << result.location_sprite_subtype
             << ",\"materialType\":" << result.location_sprite_mat
             << ",\"materialIndex\":" << result.location_sprite_mat_index << "}";
    } else {
        body << "null";
    }
    body << ",\"locationSpriteToken\":" << json_string(result.location_sprite_token) << ","
         // does THIS player's camera follow this item? Drives UNIT_SHEET_CAMERA_ACTIVE.
         << "\"following\":" << (result.following ? "true" : "false") << ","
         << "\"wireBatch\":" << json_string(kWireBatchMarker) << ","
         << "\"forbidden\":" << (result.forbidden ? "true" : "false") << ","
         << "\"dump\":" << (result.dump ? "true" : "false") << ","
         << "\"hidden\":" << (result.hidden ? "true" : "false") << ","
         << "\"isContainer\":" << (result.is_container ? "true" : "false") << ","
         << "\"camera\":";
    if (result.has_camera) {
        body << "{\"x\":" << result.camera.x
             << ",\"y\":" << result.camera.y
             << ",\"z\":" << result.camera.z << "}";
    } else {
        body << "null";
    }
    body << ",\"mapPos\":";
    if (result.has_map_pos) {
        body << "{\"x\":" << result.map_x
             << ",\"y\":" << result.map_y
             << ",\"z\":" << result.map_z << "}";
    } else {
        body << "null";
    }
    body << ",\"holderUnit\":";
    if (result.holder_unit_id >= 0) {
        body << "{\"id\":" << result.holder_unit_id
             << ",\"name\":" << json_string(result.holder_unit_name) << "}";
    } else {
        body << "null";
    }
    body << ",\"ownerUnit\":";
    if (result.owner_unit_id >= 0) {
        body << "{\"id\":" << result.owner_unit_id
             << ",\"name\":" << json_string(result.owner_unit_name) << "}";
    } else {
        body << "null";
    }
    body << ",\"location\":" << json_string(result.location)
         << ",\"contents\":[";
    for (size_t i = 0; i < result.contents.size(); ++i) {
        if (i)
            body << ",";
        const auto& child = result.contents[i];
        body << "{\"id\":" << child.id
             << ",\"name\":" << json_string(child.name)
             << ",\"forbidden\":" << (child.forbidden ? "true" : "false")
             << ",\"dump\":" << (child.dump ? "true" : "false")
             << ",\"hidden\":" << (child.hidden ? "true" : "false")
             << ",\"spriteRef\":{\"itemType\":" << json_string(child.sprite_type)
             << ",\"itemSubtype\":" << child.sprite_subtype
             << ",\"materialType\":" << child.sprite_mat
             << ",\"materialIndex\":" << child.sprite_mat_index << "}}";
    }
    body << "],\"lines\":";
    append_json_string_array(body, result.lines);
    body << "}\n";
    return body.str();
}

// ---- interaction HTTP routes --------------------------------------------------------------------
void register_interaction_routes(httplib::Server& server) {
    // Exact-tile occupant identities for the chooser, in native display order: visible units, then
    // buildings, then each loose ground item in the block's stored order. A click-time read only.
    server.Get("/tile-occupants", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int px = 0, py = 0, frame_w = 0, frame_h = 0;
        if (!parse_frame_point(req, px, py, frame_w, frame_h)) {
            res.status = 400;
            res.set_content("missing px/py/w/h\n", "text/plain; charset=utf-8");
            return;
        }

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        normalize_frame_to_viewport(camera, frame_w, frame_h);
        if (frame_w <= 0 || frame_h <= 0) {
            res.status = 400;
            res.set_content("bad frame dimensions\n", "text/plain; charset=utf-8");
            return;
        }

        const df::coord pos(camera.x + pixel_to_tile_index(px, frame_w),
                            camera.y + pixel_to_tile_index(py, frame_h), camera.z);
        std::ostringstream out;
        out << "{\"player\":" << json_string(player)
            << ",\"tile\":{\"x\":" << pos.x << ",\"y\":" << pos.y
            << ",\"z\":" << pos.z << "},\"occupants\":[";
        bool first = true;
        // `art` is an optional pre-serialized JSON fragment carrying the occupant's icon identity,
        // one field per kind. Units carry none: the client paints /unit-portrait?mode=icon.
        auto append = [&](const char* kind, int32_t id, const std::string& name,
                          const std::string& art = std::string()) {
            if (!first) out << ",";
            first = false;
            out << "{\"kind\":" << json_string(kind) << ",\"id\":" << id
                << ",\"name\":" << json_string(name);
            if (!art.empty()) out << "," << art;
            out << "}";
        };

        // Lock order: capture_state_mutex() before CoreSuspender.
        {
            using namespace DFHack;
            std::lock_guard<std::recursive_mutex> lock(capture_state_mutex());
            DFHack::CoreSuspender suspend;
            auto world = df::global::world;
            if (!world) {
                res.status = 503;
                res.set_content("{\"ok\":false,\"error\":\"world unavailable\"}\n",
                                "application/json; charset=utf-8");
                return;
            }

            for (auto unit : world->units.active) {
                // unit_is_map_present drops caged (frozen pos) and ambush-hidden units.
                if (!unit_is_map_present(unit))
                    continue;
                if (unit->pos.x != pos.x || unit->pos.y != pos.y || unit->pos.z != pos.z ||
                    (Units::isDead(unit) && !Units::isGhost(unit)) || Units::isHidden(unit))
                    continue;
                std::string name = Units::getReadableName(unit);
                if (name.empty()) name = Units::getRaceReadableName(unit);
                if (name.empty()) name = "Unit " + std::to_string(unit->id);
                append("unit", unit->id, name);
            }

            std::vector<int32_t> building_ids;
            auto append_building = [&](df::building* building) {
                if (!building || std::find(building_ids.begin(), building_ids.end(), building->id) != building_ids.end())
                    return;
                building_ids.push_back(building->id);
                const char* kind = "building";
                switch (building->getType()) {
                case df::building_type::Workshop:
                case df::building_type::Furnace: kind = "workshop"; break;
                case df::building_type::Stockpile: kind = "stockpile"; break;
                case df::building_type::Civzone: kind = "zone"; break;
                default: break;
                }
                std::string name = Buildings::getName(building);
                if (name.empty()) name = std::string(kind) + " " + std::to_string(building->id);
                // Per-kind icon identity (see the `append` contract above).
                std::string art;
                if (building->getType() == df::building_type::Stockpile) {
                    std::string token =
                        stockpile_icon_token(virtual_cast<df::building_stockpilest>(building));
                    if (!token.empty()) art = "\"spriteToken\":" + json_string(token);
                } else if (building->getType() == df::building_type::Civzone) {
                    int zx = -1, zy = -1;
                    if (zone_icon_cell(building, zx, zy))
                        art = "\"icon\":{\"sheet\":\"zone\",\"x\":" + std::to_string(zx) +
                              ",\"y\":" + std::to_string(zy) + "}";
                } else {
                    std::string key = building_icon_key(building);
                    if (!key.empty())
                        art = "\"icon\":{\"sheet\":\"building\",\"key\":" + json_string(key) + "}";
                }
                append(kind, building->id, name, art);
            };
            append_building(Buildings::findAtTile(pos));
            std::vector<df::building_civzonest*> zones;
            if (Buildings::findCivzonesAt(&zones, pos))
                for (auto zone : zones) append_building(zone);

            if (auto block = Maps::getTileBlock(pos)) {
                for (int32_t item_id : block->items) {
                    auto item = df::item::find(item_id);
                    if (!item || item->pos.x != pos.x || item->pos.y != pos.y || item->pos.z != pos.z ||
                        !item->flags.bits.on_ground || item->flags.bits.hidden || item->flags.bits.garbage_collect)
                        continue;
                    std::string name = item_display_name(item, 0, true);
                    if (name.empty()) name = "Item " + std::to_string(item->id);
                    // The same four-field spriteRef the item sheet's wire ships;
                    // DWFUI.iconHtml({item}) + paintSprites resolve it through the raws sheets.
                    std::string art =
                        "\"spriteRef\":{\"itemType\":" +
                        json_string(DFHack::enum_item_key(item->getType())) +
                        ",\"itemSubtype\":" + std::to_string(item->getSubtype()) +
                        ",\"materialType\":" + std::to_string(item->getMaterial()) +
                        ",\"materialIndex\":" + std::to_string(item->getMaterialIndex()) + "}";
                    append("item", item->id, name, art);
                }
            }

            // The two id-less occupants keep their art on this authoritative rail, so switching
            // tabs never depends on a stale map-tail snapshot.
            InspectResult vermin_sheet;
            if (fill_vermin_sheet(pos, vermin_sheet)) {
                append("vermin", -1, vermin_sheet.title,
                       "\"creatureToken\":" + json_string(vermin_sheet.vermin_token) +
                       ",\"casteToken\":" + json_string(vermin_sheet.vermin_caste_token) +
                       ",\"description\":" + json_string(vermin_sheet.description));
            }
            if (planned_engraving_at(pos))
                append("planned-engraving", -1, "Planned engraving",
                       "\"spriteToken\":\"DESIGNATION_ENGRAVE\"");

            // The engraving is the LAST occupant, the same precedence the click chain uses.
            // df::engraving has no id, so the client addresses it by the TILE carried above.
            EngravingArt engraving;
            if (engraving_art_at(pos, engraving)) {
                std::string name = engraving.title.empty() ? "Engraving" : engraving.title;
                append("engraving", -1, name,
                       "\"spriteToken\":\"DESIGNATION_ENGRAVE\"");
            }
        }

        out << "]}\n";
        res.set_header("Cache-Control", "no-store");
        res.set_content(out.str(), "application/json; charset=utf-8");
    });

    auto stock_item_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int item_id = -1;
        if (!query_int(req, "id", item_id) || !req.has_param("action")) {
            res.status = 400;
            res.set_content("missing id/action\n", "text/plain; charset=utf-8");
            return;
        }

        StockItemActionResult result;
        const std::string action = req.get_param_value("action");
        // The item sheet's first read also primes the art-prose bank, before the action path takes
        // CoreSuspender; its later item_art() then sees resident or freshly banked prose.
        if (action == "info") {
            ItemArt art;
            {
                std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
                DFHack::CoreSuspender suspend;
                art = item_art(df::item::find(item_id));
            }
            if (art.present && art.description.empty())
                complete_item_art_prose(art);
        }
        if (!stock_item_action_on_core_thread(item_id, action, result)) {
            res.status = 400;
            res.set_content("item action failed: " + result.err + "\n", "text/plain; charset=utf-8");
            return;
        }

        if (result.has_camera) {
            Camera camera = result.camera;
            std::string err;
            if (clamp_camera(camera, &err)) {
                result.camera = camera;
                set_player_camera(player, camera);
            }
        }

        // The camera tool is a native LATCH, not a one-shot. `follow` must run AFTER the block
        // above, which calls set_player_camera() -- and a pan is exactly what CLEARS a follow.
        if (action == "follow") {
            if (player_is_following(player, "item", item_id))
                forget_player_follow(player);
            else
                set_player_follow(player, "item", item_id);
        } else if (action == "unfollow") {
            forget_player_follow(player);
        }
        result.following = player_is_following(player, "item", item_id);

        res.set_header("Cache-Control", "no-store");
        res.set_content(stock_item_action_json(item_id, result), "application/json; charset=utf-8");
    };
    server.Post("/stock-item-action", stock_item_action_handler);

    server.Get("/inspect", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int px = 0;
        int py = 0;
        int frame_w = 0;
        int frame_h = 0;
        if (!parse_frame_point(req, px, py, frame_w, frame_h)) {
            res.status = 400;
            res.set_content("missing px/py/w/h\n", "text/plain; charset=utf-8");
            return;
        }

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("camera failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        normalize_frame_to_viewport(camera, frame_w, frame_h);
        InspectResult result;
        if (!inspect_on_core_thread(camera, px, py, frame_w, frame_h, result, &err)) {
            res.status = 503;
            res.set_content("inspect failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        res.set_header("Cache-Control", "no-store");
        res.set_content(inspect_json(player, result), "application/json; charset=utf-8");
    });

    server.Get("/hover", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int px = 0;
        int py = 0;
        int frame_w = 0;
        int frame_h = 0;
        if (!parse_frame_point(req, px, py, frame_w, frame_h)) {
            res.status = 400;
            res.set_content("missing px/py/w/h\n", "text/plain; charset=utf-8");
            return;
        }

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("camera failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        normalize_frame_to_viewport(camera, frame_w, frame_h);
        HoverResult result;
        if (!hover_on_core_thread(camera, px, py, frame_w, frame_h, result, &err)) {
            res.status = 503;
            res.set_content("hover failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        res.set_header("Cache-Control", "no-store");
        res.set_content(hover_json(player, result), "application/json; charset=utf-8");
    });
}

} // namespace dwf
