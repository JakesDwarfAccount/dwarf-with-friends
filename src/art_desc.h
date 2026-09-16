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

// Statue/figurine/slab and engraving art: DF-sourced prose, the art_image lookup, and the sprite ref.

#include "httplib.h"

#include <cstdint>
#include <sstream>
#include <string>

namespace df {
struct item;
struct building;
struct coord;
struct art_image;   // find_art_image()'s return type
}

namespace dwf {

// The one item-sprite channel: serialized as `"spriteRef"` and resolved client-side by
// DwfTiles.resolveItemSpriteRef -- do not add a second sprite shape for art.
struct ArtSpriteRef {
    std::string item_type;          // DFHack::enum_item_key(item->getType()), e.g. "STATUE"
    int32_t item_subtype = -1;
    int16_t material_type = -1;
    int32_t material_index = -1;
    bool present() const { return !item_type.empty(); }
};

struct ItemArt {
    bool present = false;
    int32_t item_id = -1;
    int32_t art_id = -1;             // Internal bank/widget identity; never serialized directly.
    int16_t art_subid = -1;
    std::string world_key;           // cur_savegame.save_dir captured with the item under suspend.
    std::string title;              // Items::getDescription(decorate) -- the decorated display name
    std::string description;        // Composed statue paragraph, or DF figurine string/slab memorial.
    std::string base_description;   // DF's undecorated item name; empty-art statue fallback only.
    std::string art_name;           // Translation::translateName(art_image.name). EMPTY when absent.
    int32_t quality = -1;           // df::item_quality (-1 == unknown)
    ArtSpriteRef sprite;
    bool has_art() const { return !description.empty() || !art_name.empty(); }
};

struct EngravingArt {
    bool present = false;
    int32_t x = 0, y = 0, z = 0;
    std::string title;              // Native name + quoted English name, as DF shows in the header.
    std::string art_name;           // English artwork name (native name fallback).
    std::string description;        // Full native engraving prose; EMPTY rather than fabricated.
    int32_t quality = -1;           // df::engraving::quality (df::item_quality)
    std::string skill;              // df::skill_rating enum key, e.g. "Proficient"
    int32_t artist_id = -1;         // historical_figure id
    std::string artist_name;        // Translation::translateName(hf->name) -- DF's own name
    bool floor = false;             // engraving_flags.bits.floor -> engraved FLOOR vs engraved WALL
    bool hidden = false;            // engraving_flags.bits.hidden ("obscured" engraving)
    int32_t art_id = -1;            // Internal bank/widget identity; never serialized directly.
    int16_t art_subid = -1;
    std::string world_key;           // cur_savegame.save_dir captured with the engraving.
};

// ---- DF-sourced reads (all callers must already hold the core suspend) ----------------------

ItemArt item_art(df::item* item);

// Art of the ITEM a building was built out of: a statue building holds none itself. A statue
// returns its contained item even with no art, so callers can fall back to DF's own item name.
ItemArt building_art(df::building* building);

bool engraving_art_at(const df::coord& pos, EngravingArt& out);

// Completes `description` via the persistent bank and DF's offscreen view sheet. Call OUTSIDE a
// CoreSuspender -- these marshal a native logic/render pass onto the render thread.
bool complete_item_art_prose(ItemArt& art);
bool complete_engraving_art_prose(EngravingArt& art);

// The art_image behind an (art_id, art_subid) pair; a non-resident chunk yields nullptr, never a
// guess. The single chunk walk -- world_stream.cpp calls this rather than keeping a second copy.
df::art_image* find_art_image(int32_t art_id, int16_t art_subid);

// ---- serializers -----------------------------------------------------------------------------

// Appends the `artTitle`/`artDescription`/`artBaseDescription`/`artName`/`artQuality`/`spriteRef`
// keys WITH a leading comma, and nothing at all when art.present is false.
void append_item_art_json(std::ostringstream& body, const ItemArt& art);
std::string engraving_art_json(const EngravingArt& art);

void register_art_desc_routes(httplib::Server& server);

} // namespace dwf
