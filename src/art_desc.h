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

// B246/B288/B289 -- DWARVEN ART: statue + engraving descriptions, and the statue's own sprite.
//
// THE ONE RULE OF THIS MODULE: **WE NEVER INVENT ART FACTS.** Statue and engraving subjects,
// relations, references, artists, materials, qualities, and names come from DF fields/vmethods,
// joined only by outer grammar proven against native captures. Where required DF art data is
// missing, the art description remains EMPTY; a statue panel may separately show DF's own item name as
// an explicitly labelled base fallback. (The B236 item-sheet wave learned the cost of shipping a
// composed string as a "description": what shipped was just the decorated title. The B24
// postmortem named the deeper trap -- a wrong mechanism can still print the right string on the one
// tile you tested.)
//
// WHERE DF'S ART PROSE ACTUALLY LIVES (df-structures, cited):
//
//   STATUE   df.item.xml:1532-1543  `class-type item_statuest`
//              <stl-string name='description' original-name='art_string'/>
//            Live item 4141 proves this stores only the SUBJECT NAME ("Avafi Blazebears"), not the
//            finished sentence. DF composes the paragraph when the sheet opens. The same class owns:
//              <compound name='image'>
//                int32 id original-name='art_image_chunk_id'
//                int16 subid original-name='art_image_chunk_member'
//            Generated df/item_statuest.h names this pair item_statuest::T_image. We resolve
//            statue->image.id/subid through find_art_image(), then compose the oracle-attested
//            sentences from item quality, DFHack MaterialInfo, the stored subject, and the image's
//            quality/elements/artist/properties. If the lazy chunk is absent, round 4 checks the
//            per-world bank and then lets DF's own offscreen ITEM view sheet page+compose it.
//            The base item vmethod still exposes the art-string field generically:
//              df.item.xml:602  <vmethod name='getItemShapeDesc' original-name='get_art_string_ptr'
//                                comment='a statue/figurine of "string goes here"'>
//                                 <ret-type><pointer type-name='stl-string'/></ret-type>
//              (df/item.h:145 -- `virtual std::string* getItemShapeDesc()`, vtable slot 66.)
//            For statues that pointer is the subject input, never the completed paragraph.
//
//   FIGURINE df.item.xml:1605-1613  `class-type item_figurinest`
//              <stl-string name='description' original-name='art_string'/>   <- SAME art_string,
//            so the SAME getItemShapeDesc() vmethod covers it for free. (Audit finding: figurines
//            were equally mute before this wave.)
//
//   SLAB     df.item.xml:1545-1550  `class-type item_slabst`
//              <stl-string name='description' original-name='memorial'/>
//            A slab's prose is a DIFFERENT DF field (`memorial`, the engraved memorial text) and is
//            NOT an art_string, so DF does not route it through get_art_string_ptr. We read it
//            through its own class -- still DF's stored string, still not composed here.
//
//   ENGRAVING df.event.xml:15-27  `struct-type engraving` (original-name event_detailst)
//              int32_t art_id     original-name='image_chunk_id'    ref-target='art_image_chunk'
//              int16_t art_subid  original-name='image_chunk_member' ref-target='art_image'
//              item_quality quality, int32_t artist (hfid), skill_rating skill_rating,
//              engraving_flags flags, coord pos
//            There is no persisted sentence on df::engraving. DF builds it at display time from
//            the referenced art_image. The formatter pieces ARE exposed by df-structures:
//              df.art_image.xml:22-27  art_image_element::getName (original get_string)
//              df.art_image.xml:94-99  art_image_property::getName (original get_string)
//              df.reference.xml:217-220 general_ref::getDescription (original descriptive_string)
//            Those are DF vmethods, so subjects, relations, names, counts, and the reference clause
//            all come from DF itself. We only join them with the two native outer templates proven
//            by B288-1/B288-2 on the resident free path. A nonresident image takes the persistent
//            bank/native ENGRAVING view-sheet path; failure still stays EMPTY, never guessed.
//
//   ART IMAGE df.art_image.xml -- art_image.name (language_name), .quality, .artist, .elements,
//            .properties. Reached via world->art_image_chunks.all -> chunk(id==art_id)
//            -> images[art_subid].art_image. Chunks are lazy-loaded from art_image_*.dat, so a
//            chunk that is not resident yields nullptr on the free path; the click-time bank/native
//            sheet path handles that exact miss and degrades empty on any failure.
//            (remotefortressreader/remotefortressreader.cpp:1516-1526 walks the same path.)

#include "httplib.h"

#include <cstdint>
#include <sstream>
#include <string>

namespace df {
struct item;
struct building;
struct coord;
struct art_image;   // B253: find_art_image()'s return type
}

namespace dwf {

// The ITEM art channel, byte-identical in shape to the one the item sheet and the occupant rail
// already speak (StockItemActionResult::item_type/.../material_index -> `"spriteRef"` JSON, resolved
// client-side by DWFUI.iconHtml({item: ref}) -> DwfTiles.resolveItemSpriteRef). B246 does NOT
// introduce a second sprite mechanism: the statue panel was mute because /building-info never sent a
// ref at all, not because the ref shape was wrong.
struct ArtSpriteRef {
    std::string item_type;          // DFHack::enum_item_key(item->getType()), e.g. "STATUE"
    int32_t item_subtype = -1;
    int16_t material_type = -1;
    int32_t material_index = -1;
    bool present() const { return !item_type.empty(); }
};

// DF-sourced art text/facts for one ITEM. Statue `description` uses the native captured outer
// grammar around DF fields; figurine/slab text remains DF-stored text.
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

// DF's own facts for ONE ENGRAVING on ONE TILE. `description` is assembled only from DF vmethod
// output plus the native B288 outer templates; it stays empty when a required DF piece is absent.
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

// DF-sourced art description for an item. Statues resolve item_statuest.image and compose the
// native paragraph; other art strings use getItemShapeDesc(), and slabs use `memorial`.
ItemArt item_art(df::item* item);

// The art carried by a BUILDING -- i.e. by the item DF built it out of. A statue building
// (df::building_statuest) is a df::building_actual whose contained_items[0].item is the
// df::item_statuest; the ART and the SPRITE both belong to that ITEM, which is precisely why a panel
// that only ever looked at the BUILDING had neither. A statue returns its contained item even when
// art_string/art_image are unavailable, so callers can show DF's item title/base name rather than a
// mute click. Other buildings still return present==false when no contained item has art.
ItemArt building_art(df::building* building);

// The engraving on this exact tile, if any. Mirrors interaction.cpp's engraving_at_tile() lookup
// (world->event.engravings, matched on pos) and then resolves the art_image.
bool engraving_art_at(const df::coord& pos, EngravingArt& out);

// Complete a resident-chunk miss through the persistent bank and then DF's native offscreen view
// sheet. Call outside a CoreSuspender: these functions marshal the native logic/render pass to the
// render thread, serialize all compositions, and degrade to the already-populated fallback on any
// failure. Returns true only when `description` is available after the call.
bool complete_item_art_prose(ItemArt& art);
bool complete_engraving_art_prose(EngravingArt& art);

// B253: the art_image behind an (art_id, art_subid) pair. Chunks are lazily paged in from
// art_image_*.dat, so an unloaded chunk is simply ABSENT -> nullptr (never a guess). Already the
// engine behind every art lookup in this file; now also world_stream.cpp's, which needs the CASTE
// of a creature statue's subject (art_image_element_creaturest.caste) and must not grow a second,
// divergent copy of the chunk walk.
df::art_image* find_art_image(int32_t art_id, int16_t art_subid);

// ---- serializers -----------------------------------------------------------------------------

// Emits `"artTitle":...,"artDescription":...,"artBaseDescription":...,"artName":...,
// "artQuality":...,"spriteRef":{...}`
// (leading comma included, nothing at all when art.present is false) for an existing JSON object.
void append_item_art_json(std::ostringstream& body, const ItemArt& art);
std::string engraving_art_json(const EngravingArt& art);

void register_art_desc_routes(httplib::Server& server);

} // namespace dwf
