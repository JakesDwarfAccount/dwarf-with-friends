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

#include "art_desc.h"        // B246/B289: DF-sourced statue/figurine/slab art descriptions
#include "building_zone.h"   // B224: zone_icon_cell for /tile-occupants occupant art
#include "client_state.h"
#include "info_panel.h"      // B224: building_icon_key for /tile-occupants occupant art
#include "interaction_route.h"
#include "route_helpers.h"
#include <vector>

#include "Core.h"
#include "TileTypes.h"
#include "json_util.h"
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

// B07: is this item a storage container the DF UI opens a contents window for? Covers the
// stockpile-relevant carriers (bin/barrel/bag(BOX)/bucket/flask) plus the other item types DF
// treats as containers (cage/animal trap/quiver/backpack). Detection is by item type rather than
// by "has contained items" so an EMPTY container is still recognized as a container (the whole
// point of B07's graceful-empty case).
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

// B236 (DLL-GATED HALF) -- native's description sentence, composed as the oracles show it:
//   "This is a superior quality apricot wood bed."   (ITEMSHEET-oracle-native.png, quality 3)
//   "This is a finely-crafted Fish Barrel <date palm wood> <#6>."  (steam barrel-bin sheet, q2)
//   "This is a tower-cap splint."                    (steam single-item sheet.png, no quality)
//   "This is pig tail cloth."                        (item sheet flags active.png, mass noun)
// = "This is " + ARTICLE + [quality adjective + " "] + the UNdecorated display name + ".".
// The ARTICLE is DF'S OWN -- the item vmethod getItemDescriptionPrefix (add_article_to_string,
// df.item.xml:897-900), which is how "pig tail cloth" takes none while "tower-cap splint" takes
// "a". We never guess it. Books and artifacts are excluded: their native prose is not this
// sentence, so they keep the getReadableDescription path in the caller.
// KNOWN GAPS (uncaptured, not guessed -- screenshots requested in the B236 closeout): native's
// extra sentences for material colour and coatings ("The material is gray. It is coated with
// water." -- the flags-active oracle) and the exact sentence for a stack ("... [N]").
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
        // DF derived "a"/"an" from the NAME's first sound; the adjective now leads the noun
        // phrase, so re-derive from the adjective ("an exceptional...", never "a exceptional").
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

// W3 -- the STOCKPILE tile on the item sheet's location row (`steam single-item sheet.png`).
// A stockpile is a BUILDING, so it has no item sprite; native paints one of DF's own
// STOCKPILE_ICON_* interface cells (all 40 are already in web/interface_map.json). DF derives that
// icon from which item GROUPS the pile accepts -- df::stockpile_group_set, the 17-bit set in
// building_stockpilest.settings.flags (df/stockpile_group_set.h:10-27). One group enabled == that
// group's icon; every group == ALL; several == CUSTOM; none == BLANK. Pure bit reads on a struct
// we already hold: no scan, no extra suspension.
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

// B236: the location row's pile name, exactly as native prints it -- DF's own building name
// ("Food Stockpile #6", or a custom name) with the numbered fallback stockpile_panel.cpp already
// uses for a pile whose vmethod yields nothing.
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
        // B236: native prints the BARE pile name on the location row (`Stockpile #1`,
        // `Food Stockpile #6` -- never "In Stockpile #1"), so the pile branch names itself here
        // and never falls through to the "In <building>" fallback below.
        result.location = stockpile_location_label(pile);
    }

    // W3: when the location is a CONTAINER, the tile is that container's own item sprite -- the
    // ordinary item channel, identical in shape to the sheet's own `spriteRef`. This is the half
    // of the location row the client can already paint today.
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

    // B236 (DLL-GATED HALF) -- THE STOCKPILE ROW'S MISSING DATA. An item LYING ON a stockpile tile
    // carries NO BUILDING_HOLDER ref: DF tracks pile membership POSITIONALLY (dfhack
    // Buildings.h:202-219, StockpileIterator -- "the block's items are checked for anything on the
    // ground within that stockpile"). So getHolderBuilding returns null for exactly the item the
    // B236 pair shows: native attributes the bed to `Stockpile #1`; our wire said "On map". Resolve
    // the pile by tile -- same z, footprint contains the item (room extents respected by
    // Buildings::containsTile). Click-time read over the STOCKPILE vector; not a per-frame path.
    // The unit-held case is excluded on purpose: a hauled item is WITH the unit, not in the pile
    // its carrier is standing on. The in-container case is excluded too -- the container is the
    // NEARER location (the row keeps its item-ref art channel and "In <container>" name; the
    // W4 invariant that the two art channels never both apply stays true). The pile row renders
    // on the CONTAINER'S own sheet, which is exactly what the barrel-bin oracle shows.
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

    // Native selection is exact-tile. Keep the historical 3x3 forgiveness only when the
    // clicked tile is empty, and keep every equally-near fallback in a deterministic order so
    // the unit-sheet cycle stays within this click's resolution set.
    std::vector<df::unit*> exact;
    std::vector<std::pair<int, df::unit*>> fallback;
    for (auto unit : world->units.active) {
        if (!unit || unit->pos.z != pos.z || (Units::isDead(unit) && !Units::isGhost(unit)))
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

// BUGFIX (cursor/selection misalignment, "one of the biggest bugs ... persistent since the
// original multidwarf"): this used to scale+clamp `p` against `dim` (DF's own native
// gps->main_viewport tile dims, via effective_capture_viewport_dims -- a small, zoom-driven
// quantity that has NOTHING to do with the browser client's rendered window). Since FIX 1
// (http_server.cpp's /mapdata comment), the wire's documented contract is `world = camera +
// grid_index`: px/py arriving here are ALREADY a tile-grid index into the client's own
// rendered window (0..frame-1), not a raw screen/capture pixel needing rescaling into DF's
// viewport tile count. Treating them as the latter silently CLAMPED every click whose grid
// index exceeded the (much smaller) native viewport to that viewport's edge tile -- i.e. any
// click past roughly the top-left quarter of a normally-sized/zoomed browser window resolved
// to the same wrong tile. `dim` is gone; clamp against the caller's own frame instead.
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
        if (err) *err = "bad frame dimensions";
        return false;
    }

    int tile_x = pixel_to_tile_coord(px, frame_w);
    int tile_y = pixel_to_tile_coord(py, frame_h);
    pos = df::coord(camera.x + tile_x, camera.y + tile_y, camera.z);

    // tile_px/tile_py are informational only (the JSON `tileSize` field; no client code path
    // reads it for correctness) -- best-effort from the real DF viewport, but never block the
    // actual tile resolution above on it being available.
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

// B246: defined below with the hover helpers (it predates this wave -- B24 added it for the hover's
// "Engraved " terrain qualifier). Forward-declared here so the SELECTION chain can use the very same
// lookup the HOVER already trusted, rather than growing a second, drifting one.
bool engraving_at_tile(const df::coord& pos);

// B289 routing: B253's statue renderer puts the subject TOP one screen row above the 1x1 building
// footprint (world y1 - 1). Buildings::findAtTile() correctly returns null there because the cell is
// authored art, not footprint. Exact-tile buildings always win; only an empty clicked cell is mapped
// down one row, and only when that footprint is actually a Statue.
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

    if (auto unit = find_unit_near_tile(pos, &result.unit_cycle_ids)) {
        result.kind = "unit";
        result.title = readable_unit_name(unit);
        result.unit = build_unit_sheet(unit);
        result.lines.push_back("Profession: " + Units::getProfessionName(unit));
        result.lines.push_back("Creature: " + Units::getRaceReadableName(unit));
        result.lines.push_back("Position: " + std::to_string(unit->pos.x) + "," +
                               std::to_string(unit->pos.y) + "," + std::to_string(unit->pos.z));
        result.lines.push_back("Unit id: " + std::to_string(unit->id));
        return true;
    }

    if (auto building = find_click_building(pos)) {
        // B07: a stockpile is a floor designation that items (bins/barrels/loose items) sit ON.
        // DF's own client selects the ITEM under the cursor -- not the stockpile -- when a
        // stockpile tile holds one, so its container-contents window can open. Prefer a ground
        // item here; fall through to selecting the stockpile itself only for empty pile floor.
        // (Non-stockpile buildings keep taking precedence over ground items, as before.)
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
        // B289: a statue BUILDING has only an unused statue_flag; its full DF-generated title and
        // prose live on the contained item_statuest. Put both on the real click response, then the
        // building-info route supplies the same fields during the panel refresh.
        if (building->getType() == df::building_type::Statue) {
            ItemArt art = building_art(building);
            if (!art.title.empty())
                result.title = art.title;
            // Keep the base-name fallback out of the prose channel. openBuildingPanel merges this
            // field into artDescription during mixed deploys, so sending the subject/name here
            // would recreate the exact "name presented as body" defect when the image is unresolved.
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

    // B246 (07-14): "Engravings I cannot click on." The click ALWAYS resolved -- it just
    // resolved to `kind:"tile"`, whose generic panel (dwf-core.js showSelection's fallback)
    // renders the tiletype name and the coordinates and NOTHING ELSE. An engraving is not an item and
    // not a building; it is a TILE PROPERTY (df::engraving in world->event.engravings, keyed on pos
    // -- df.event.xml:15-27), so it never appeared in any occupant list and the selection chain had
    // nowhere to put it. The fix is a real selectable KIND at the end of the same chain: everything
    // that stands ON the tile still wins (a dwarf standing on an engraved floor still selects the
    // dwarf, exactly as in DF), and the engraving is what the tile itself resolves to.
    // B288-1/B288-2 show a standalone native engraving click-info sheet, not a zone sheet with an
    // art appendix. Resolve the tile-level engraving before the passive civzone overlay. The crops
    // do not establish whether their tiles were in civzones; the owner should still confirm that exact
    // overlap, but this preserves the native-observed standalone art surface and makes engraved
    // dining/bedroom/statue-garden floors reachable.
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

// B24: hover lines mirror DF's own tooltip box: ONE ENTRY PER LINE, each tagged with its
// category for the client's per-category colors. Capitalization follows DF's observed quirks
// (native-window captures, tools/harness/results/b24_native_compare/): qualifier tokens and
// terrain FORM words are capitalized ("rock salt Pebbles", "Muddy loam Cavern Floor", "Dense
// carpetgrass"), items/species stay lowercase ("guava seeds", "finger lime tree trunk"),
// growth-spatter and spatter sentences lead capitalized ("Finger limes", "A dusting of mud").
constexpr size_t HOVER_SEGMENT_CAP = 40;

std::string hover_capitalize(std::string s) {
    if (!s.empty() && s[0] >= 'a' && s[0] <= 'z')
        s[0] = (char)(s[0] - 'a' + 'A');
    return s;
}

// dedupe=false: DF lists every ground item individually (18 loose seed bags = 18 lines --
// verified against the native tooltip on the live fort's Food Stockpile #8 barrel tile).
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

// B24: DF's display FORM word for the tiletype shape, capitalized exactly as the native
// tooltip shows ("rock salt Pebbles", "Muddy loam Cavern Floor", "Murky Pool Upward Slope").
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
    // df-structures distinguishes the upward ramp body (RAMP) from its one-z-above
    // downward-facing proxy (RAMP_TOP). Native exposes that distinction in hover text.
    case tiletype_shape::RAMP:          return " Upward Slope";
    case tiletype_shape::BROOK_BED:     return " Brook Bed";
    default:                            return "";
    }
}

// B24: is there an engraving on this exact tile? (world->event.engravings in this structures
// version -- world->engravings does not exist; verified live via dfhack-run lua.)
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

// B24: the terrain line ("Muddy loam Cavern Floor", "rock salt Pebbles", "Murky Pool Upward Slope"
// -- all three verbatim from native-window captures of this fort). Material name resolved
// through MapCache (layer stone / soil / MINERAL veins / constructions via staticMaterialAt),
// plus DF's capitalized form word, "Cavern" for subterranean natural tiles, "Muddy" when mud
// spatter coats the tile, Smooth/Engraved qualifiers. Grass and plant-material tiles are
// named by their own sections, not here.
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
    // Grass is enumerated by name from the grass block events; standing plants (shrub/
    // sapling/tree parts) are named by the plant section with species names.
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

    // Material name: staticMaterialAt resolves constructions to the built material and
    // otherwise falls through to base (layer stone / soil / vein / lava stone / feature).
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
    // "Cavern" sits between the material and the form word for natural subterranean tiles
    // ("loam Cavern Floor" -- observed; constructions don't get it).
    std::string cavern =
        (subterranean && tmat != tiletype_material::CONSTRUCTION) ? " Cavern" : "";
    if (special == tiletype_special::TRACK)
        return prefix + mat + cavern + " Track";
    return prefix + mat + cavern + hover_shape_suffix(shape);
}

// B24: the species line for a standing plant occupying the tile, via Maps::getPlantAtTile
// (which, unlike an exact pos match, also resolves the multi-tile extent of grown trees).
// Casing per the native captures: "Dead Guava tree Sapling" (qualifier + species + form
// capitalized) vs "finger lime tree trunk" (tree parts all-lowercase -- DF's own quirk).
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

// B24: DF phrases material spatter as a sentence -- "A dusting of mud", "A smear of gray
// langur blood" (both verbatim from native captures). Verb by matter state + amount; only
// the two observed pairings are byte-confirmed, the rest follow DF's size ladder.
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
    // Ladder calibrated on the live fort: gray langur blood amt=98 (liquid) reads "A smear
    // of" natively and mud amt=25 (solid) reads "A dusting of" -- boundary sits at 100.
    bool liquid = sp->mat_state == df::matter_state::Liquid;
    const char* verb;
    if (liquid)
        verb = amt < 100 ? "a smear of " : "a pool of ";
    else
        verb = amt < 100 ? "a dusting of " : "a pile of ";
    return hover_capitalize(verb + name);
}

// B24 ROOT CAUSE of the "Finger limes" gap: fallen growths (fruit dropped by trees, fallen
// leaves -- B05's "pomegranate leaves, pomegranate" too) are not items and not material
// spatter; they are ITEM SPATTER block events (block_square_event_item_spatterst), which the
// hover never enumerated. Verified live: tile 6,20,161 carries item_spatter PLANT_GROWTH
// mat="finger lime tree fruit" amt=10000. DF names them with the growth's plural ("finger
// limes"); seeds use the plant's seed_plural.
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

// B05/B24: coverage qualifier DF prefixes to a grass name from the per-tile grass amount
// (0..100). "Dense carpetgrass" verbatim-confirmed via native capture; DF's exact wording for
// lighter coverage isn't confirmed side-by-side, so lighter grass is named plainly rather
// than inventing an unverified adjective. Threshold ~2/3 coverage.
const char* grass_density_prefix(int amount) {
    return amount >= 67 ? "Dense " : "";
}

// DF's df::flow_type enum is the authoritative vocabulary. Unknown future values deliberately
// return empty so hover fails open instead of inventing a player-facing label.
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

// B24 COMPLETENESS PARITY: enumerate EVERYTHING DF's own hover tooltip shows for a tile, in
// DF's observed order (native-window captures of the live fort, evidence in
// tools/harness/results/b24_native_compare/):
//   units -> ground items (each individually, DF-decorated) -> building -> standing plant
//   -> terrain (grass / shape-formed material) -> liquid -> fallen-growth ITEM spatter
//   -> contaminant MATERIAL spatter sentences.
// Hidden (unrevealed) tiles report nothing -- DF shows nothing under fog, and anything else
// leaks map knowledge to remote players.
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

    // Mud spatter on the tile becomes the terrain's "Muddy" qualifier ("Muddy loam Cavern
    // Floor" -- observed) IN ADDITION to its own "A dusting of mud" line.
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

    // (1) UNITS on the tile, first -- exactly where DF puts them (skip ambush-hidden units;
    // DF doesn't reveal them either).
    for (auto unit : world->units.active) {
        if (!unit || unit->pos.x != pos.x || unit->pos.y != pos.y || unit->pos.z != pos.z)
            continue;
        if (Units::isHidden(unit))
            continue;
        hover_push(out, "unit", readable_unit_name(unit));
    }

    // (2) GROUND ITEMS -- every loose item individually, NO dedupe (DF lists 18 seed bags as
    // 18 lines), with DF's own decorations via getDescription(decorate=true): (foreign),
    // {forbidden}, wear x/X/XX, quality marks. Contained items are NOT listed (the native
    // tooltip on a full spice barrel shows only the barrel -- its contents belong to the
    // click window). in_inventory items (hauled/contained) track this pos but are not ON it.
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

    // (4) STANDING PLANT -- species-named shrub/sapling/tree part. The native tooltip shows
    // ONLY the part line ("finger lime tree trunk"), no attached-growth lines -- the growth
    // names players see ("pomegranate leaves") are FALLEN growths, i.e. item spatter below.
    if (df::plant* pl = Maps::getPlantAtTile(pos)) {
        if (df::plant_raw* pr = df::plant_raw::find(pl->material))
            hover_push(out, "plant", hover_plant_segment(tt, pr));
    }

    // (5) TERRAIN. Grass floors are named by their grass ("Dense carpetgrass"), densest
    // first; everything else gets the shape-formed material name ("rock salt Pebbles").
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

    // (6) LIQUID -- after the terrain line, DF-observed ("Murky Pool Upward Slope" then "Stagnant
    // water [7/7]").
    if (des.bits.flow_size > 0) {
        bool magma = des.bits.liquid_type == df::tile_liquid::Magma;
        std::string liq = magma ? "magma" : (des.bits.water_stagnant ? "Stagnant water"
                                                                     : "water");
        hover_push(out, "liquid", hover_capitalize(
            liq + " [" + std::to_string((int)des.bits.flow_size) + "/7]"));
    }

    // (7) FLOW CLOUD -- block->flows is separate from terrain/liquid and was therefore absent
    // from the old hover path even though the same record already rides the tile wire. Match the
    // renderer's densest-live-flow rule; expired slots remain in this vector with DEAD set.
    df::flow_info* hover_flow = nullptr;
    for (auto flow : block->flows) {
        if (!flow || flow->flags.bits.DEAD || flow->density <= 0 || flow->pos != pos)
            continue;
        if (!hover_flow || flow->density > hover_flow->density)
            hover_flow = flow;
    }
    if (hover_flow)
        hover_push(out, "flow", hover_flow_name(hover_flow->type));

    // (8) FALLEN-GROWTH ITEM SPATTER -- the B24 root cause (see item_spatter_name). Newest
    // events first (matches the native ordering observed for the two-fruit tile).
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

    // Legacy `material` footer intentionally left empty: the terrain line now lives in
    // `lines`/`kinds` (an old client shows lines-only; the new client only consults
    // `material` when talking to an old server).
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

// Web host-save (SAVE-ONLY, never exits): the exact autosave-request pathway DFHack's
// quicksave.lua uses -- set plotinfo.main.autosave_request plus the save_progress reset that
// script discovered from reverse-engineering. We only SET the flags here (on the core thread via
// run_suspended); DF's own main loop performs the world write on a later frame. That write BLOCKS
// world_stream_tick, which the WP-B busy watchdog (pause_arbiter) already detects and broadcasts as
// {"type":"busy"} -- so the existing saving banner appears with NO duplicate progress UI here.
//
// Guards (see the /save route's matrix): refuses when the map/world isn't loaded or we're not in
// fortress mode (world-absent / wrong-mode cells), and when a save is already queued or running
// (autosave_request already set) -- so double-fire, or a click during an in-flight autosave, can't
// stack a second world write. Never triggers a load; there is no load path.
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
        // Mirror quicksave.lua exactly (these fields were discovered from rev-eng there).
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

        // Decorated descriptions are DF's own item text: quality/wear wrappers and artifact
        // proper names must stay visible in the stock detail sheet and its tooltips.
        result.title = item_display_name(item, 0, true);
        if (result.title.empty())
            result.title = "Item " + std::to_string(item_id);
        // B236: the description is native's PROSE SENTENCE, not the decorated name again.
        // getReadableDescription (dfhack Items.cpp:750-774) is the decorated display name for
        // ordinary items -- i.e. the title, which is what rendered `*apricot wood bed*` as the
        // "description" in ITEMSHEET-broken-ours.png. Books/artifacts (where it genuinely
        // diverges) keep it as the fallback, as does anything the prose composer declines.
        // B246/B289: a STATUE body is composed from its DF subject + resolved art image; a FIGURINE
        // or SLAB carries stored text. item_native_prose() never looked at those channels, so a
        // statue clicked AS AN ITEM printed only the generic "This is a limestone statue."
        if (ItemArt art = item_art(item); !art.description.empty())
            result.description = art.description;
        if (result.description.empty())
            result.description = item_native_prose(item);
        if (result.description.empty())
            result.description = Items::getReadableDescription(item);
        if (result.description.empty())
            result.description = result.title;

        resolve_stock_item_location(item, result);

        // W2: "unfollow" is the explicit release of the follow latch. It is a pure state change
        // (the caller clears the player's FollowTarget) and must NOT move the camera, so it lands
        // here as a no-op rather than falling through to "unsupported item action".
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
            // Read-only: report current state.
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
    // B24: per-line categories (parallel to lines) for DF-style per-category colors.
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
         // W3: the location row's two art channels. `locationSpriteRef` is an ITEM ref (a container)
         // and is null when the location is not an item; `locationSpriteToken` is an INTERFACE token
         // (STOCKPILE_ICON_*) and is "" when the location is not a stockpile. They never both apply.
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
         // W2: does THIS player's camera follow this item? Drives UNIT_SHEET_CAMERA_ACTIVE.
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

// ---------------------------------------------------------------------------------------------
// HTTP routes, extracted from http_server.cpp's register_routes():
// that function had grown to ~2,750 lines / ~150 inline registrations and was the repo's #1
// merge-conflict site (49 of the last 200 commits). This finishes the register_*_routes() split
// the other 18 modules already used. Handler bodies are unchanged; route behavior is identical.
void register_interaction_routes(httplib::Server& server) {
    // B80: exact-tile occupant identities for the chooser. This deliberately reads only stable
    // sim structures (world units, Buildings/Maps, and map-block item ids), never render arrays.
    // Its order is the native display traversal: visible units, physical/zone buildings, then
    // each loose ground item in the map block's stored order. This is a click-time read, not a
    // stream field, so it adds no per-tick AUX payload or polling pressure.
    server.Get("/tile-occupants", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int px = 0, py = 0, frame_w = 0, frame_h = 0;
        if (!query_int(req, "px", px) || !query_int(req, "py", py) ||
            !query_int(req, "w", frame_w) || !query_int(req, "h", frame_h)) {
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
        // B224: `art` is an optional pre-serialized JSON fragment carrying the occupant's icon
        // identity, one field per kind (the client's occupant rail resolves each through the art
        // channel its sheet already uses -- dwf-unitcycle.js occupantIconHtml):
        //   item      -> "spriteRef":{itemType,itemSubtype,materialType,materialIndex}
        //   stockpile -> "spriteToken":"STOCKPILE_ICON_*"        (stockpile_icon_token, W3)
        //   zone      -> "icon":{"sheet":"zone","x":N,"y":N}     (zone_icon_cell, activity_zones.png)
        //   building/workshop -> "icon":{"sheet":"building","key":"..."} (building_icon_key)
        // Units carry none: the client paints /unit-portrait?mode=icon. Absent fields degrade on
        // the client (label-keyword fallback for buildings, then the fail-loud empty tile).
        auto append = [&](const char* kind, int32_t id, const std::string& name,
                          const std::string& art = std::string()) {
            if (!first) out << ",";
            first = false;
            out << "{\"kind\":" << json_string(kind) << ",\"id\":" << id
                << ",\"name\":" << json_string(name);
            if (!art.empty()) out << "," << art;
            out << "}";
        };

        // Match interaction.cpp's proven lock order: capture-state mutex before CoreSuspender.
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
                if (!unit || unit->pos.x != pos.x || unit->pos.y != pos.y || unit->pos.z != pos.z ||
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
                // B224: per-kind icon identity (see the `append` contract above).
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
                    // B224: the same four-field spriteRef the item sheet's wire ships (B184/W3);
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

            // B246: the engraving is the LAST occupant, after everything that stands on the tile --
            // the same precedence the click chain uses (inspect_at_pixel), so the rail's order and
            // the direct-click winner never disagree. Without this row an engraved floor under a
            // dwarf or a statue was UNREACHABLE even through the chooser: the chooser only ever
            // listed units, buildings and ground items, and an engraving is none of the three.
            // It carries no id of its own (df::engraving has no id field -- df.event.xml:15-27), so
            // the client addresses it by the TILE, which this response already carries at the top.
            // Use the resolved DF artwork title when available, and the existing native engraving
            // designation sprite for the generic rail icon channel.
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
        // The item sheet's first read is also an art-prose cache trigger. Do this before
        // stock_item_action_on_core_thread acquires CoreSuspender; its later item_art() call then
        // sees either resident prose or the freshly banked native view-sheet composition.
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

        // W2: the camera tool on the item sheet is a native LATCH, not a one-shot button (`item
        // sheet flags active.png` shows the green UNIT_SHEET_CAMERA_ACTIVE face). `follow` toggles
        // this player's FollowTarget -- and it must run AFTER the block above, because that block
        // calls set_player_camera(), which is the very thing that CLEARS a follow (a pan breaks the
        // lock). Ordering it the other way round would cancel the latch on the click that sets it.
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
    server.Get("/stock-item-action", stock_item_action_handler);
    server.Post("/stock-item-action", stock_item_action_handler);

    server.Get("/inspect", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int px = 0;
        int py = 0;
        int frame_w = 0;
        int frame_h = 0;
        if (!query_int(req, "px", px) || !query_int(req, "py", py) ||
            !query_int(req, "w", frame_w) || !query_int(req, "h", frame_h)) {
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
        if (!query_int(req, "px", px) || !query_int(req, "py", py) ||
            !query_int(req, "w", frame_w) || !query_int(req, "h", frame_h)) {
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
