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

#include "camera.h"
#include "unit_sheet.h"

#include <cstdint>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace df { struct item; }

namespace dwf {

// Use the harvested growth record's name for PLANT_GROWTH items while preserving DFHack's
// normal description and decorations for every other item and every unresolved growth.
std::string item_display_name(df::item* item, int type = 0, bool decorate = false);

struct InspectResult {
    Camera camera;
    int map_x = 0;
    int map_y = 0;
    int map_z = 0;
    int px = 0;
    int py = 0;
    int tile_px = 0;
    int tile_py = 0;
    std::string kind = "tile";
    std::string title;
    // B288/B289: DF-generated art prose carried by the actual /inspect click response. Empty for
    // selections with no DF prose and when an engraving's required art-image data is unavailable.
    std::string description;
    std::vector<std::string> lines;
    int32_t building_id = -1;
    int32_t item_id = -1;
    // Ordered candidates from the same exact-tile-first resolution used for this click. The
    // unit-sheet arrows must never silently broaden this into a different nearby-tile search.
    std::vector<int32_t> unit_cycle_ids;
    UnitSheet unit;
};

struct HoverResult {
    int map_x = 0;
    int map_y = 0;
    int map_z = 0;
    std::string material;
    std::vector<std::string> lines;
    // B24: per-line category, parallel to `lines` (unit/item/building/plant/terrain/liquid/
    // growth/spatter) -- drives the client's DF-style per-category line colors.
    std::vector<std::string> kinds;
};

struct StockItemActionResult {
    bool ok = false;
    bool has_camera = false;
    Camera camera;
    bool has_map_pos = false;
    int map_x = 0;
    int map_y = 0;
    int map_z = 0;
    int32_t holder_unit_id = -1;
    std::string holder_unit_name;
    int32_t owner_unit_id = -1;
    std::string owner_unit_name;
    std::string location;
    std::string description;
    std::string title;
    std::string weight;
    int32_t value = 0;
    std::string item_type;
    int32_t item_subtype = -1;
    int16_t material_type = -1;
    int32_t material_index = -1;
    int32_t location_id = -1;
    // W3 (wave-4 wire batch): the location row's art. TWO distinct native channels, and they are
    // NOT interchangeable:
    //   * a container (barrel/bin/bag) is an ITEM -> a real item sprite ref, same shape as
    //     `spriteRef` above. `location_sprite_type` empty == no item ref.
    //   * a STOCKPILE is not an item at all. `steam single-item sheet.png` shows a brown tile with
    //     the stockpile sign on it -- that is DF's own STOCKPILE_ICON_* interface art, which the
    //     item channel CANNOT resolve. It ships as an interface TOKEN instead.
    std::string location_sprite_type;      // item_type token, e.g. "BARREL"; empty when none
    int32_t location_sprite_subtype = -1;
    int16_t location_sprite_mat = -1;
    int32_t location_sprite_mat_index = -1;
    std::string location_sprite_token;     // interface token, e.g. "STOCKPILE_ICON_FOOD"
    // W2: is THIS player's camera currently following this item (see client_state.h FollowTarget)?
    bool following = false;
    bool forbidden = false;
    bool dump = false;
    bool hidden = false;
    // B07: true when this item is a storage container (bin/barrel/bag/bucket/etc.) so the client
    // can render DF's container-contents view -- including an explicit "Empty" state when a
    // container holds nothing (a normal, non-container item stays false and shows no contents box).
    bool is_container = false;
    std::vector<std::string> lines;
    struct Content {
        int32_t id = -1;
        std::string name;
        bool forbidden = false;
        bool dump = false;
        bool hidden = false;
        // W3 (S4 DATA GAP 3): the contained item's own sprite ref. The container sheet's rows have
        // always been rendered through the item channel (`iconCfg: { item: c.spriteRef }`) and the
        // wire never sent one, so every contained row painted the fail-loud empty tile.
        std::string sprite_type;
        int32_t sprite_subtype = -1;
        int16_t sprite_mat = -1;
        int32_t sprite_mat_index = -1;
    };
    std::vector<Content> contents;
    std::string err;
};

bool action_on_core_thread(const std::string& action, std::string* err = nullptr);

// Host-only web save (SAVE-ONLY, never exits/loads): sets DF's autosave-request flags on the core
// thread exactly like DFHack's quicksave.lua; the DF main loop writes the world on a later frame.
// Returns false with *err set when no world/map is loaded, not fortress mode, or a save is already
// in progress. See interaction.cpp for the busy-watchdog integration note.
bool save_world_on_core_thread(std::string* err = nullptr);

bool stock_item_action_on_core_thread(int32_t item_id,
                                      const std::string& action,
                                      StockItemActionResult& result);

bool inspect_on_core_thread(const Camera& camera,
                            int px,
                            int py,
                            int frame_w,
                            int frame_h,
                            InspectResult& result,
                            std::string* err = nullptr);

bool hover_on_core_thread(const Camera& camera,
                          int px,
                          int py,
                          int frame_w,
                          int frame_h,
                          HoverResult& result,
                          std::string* err = nullptr);

std::string inspect_json(const std::string& player, const InspectResult& result);
std::string hover_json(const std::string& player, const HoverResult& result);
std::string stock_item_action_json(int32_t item_id, const StockItemActionResult& result);

// Registers this module's HTTP routes (moved verbatim from http_server.cpp's
// register_routes monolith -- B212, 2026-07-13).
void register_interaction_routes(httplib::Server& server);

} // namespace dwf
