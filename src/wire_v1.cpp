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

#include "wire_v1.h"
#include "diagnostics.h"
#include "fnv.h"
#include "tile_material.h"

// The DF map headers are needed ONLY by encode_block(); the pure codec above it never touches them.
#include "DataDefs.h"
#include "TileTypes.h"
#include "modules/Maps.h"
#include "modules/MapCache.h"
// Items::getDescription reproduces DF's own item-name generator -- the authoritative
// "corpse" vs "skeleton" label the client must follow.
#include "modules/Items.h"
#include <cctype>
#include "df/world.h"
#include "df/map_block.h"
#include "df/map_block_column.h"
#include "df/tile_designation.h"
#include "df/tile_occupancy.h"
#include "df/tile_dig_designation.h"
#include "df/tile_traffic.h"
#include "df/tiletype.h"
#include "df/tiletype_shape.h"
#include "df/tiletype_material.h"
#include "df/item.h"
#include "df/item_type.h"
#include "df/item_actual.h"
#include "df/item_seedsst.h"
#include "df/item_plantst.h"
#include "df/building_farmplotst.h"
#include "df/buildingitemst.h"
#include "df/building_item_role_type.h"
// The race-bearing item classes: corpse/corpsepiece, vermin-item/pet, remains, egg, raw fish.
#include "df/item_body_component.h"
// Corpses and corpsepieces are the CONCRETE leaf types; item_body_component is abstract, and
// strict_virtual_cast matches the exact type only.
#include "df/item_corpsest.h"
#include "df/item_corpsepiecest.h"
#include "df/item_critter.h"
#include "df/item_remainsst.h"
#include "df/item_eggst.h"
#include "df/item_fish_rawst.h"
#include "df/item_fishst.h"
// Cut-gem shape (item_smallgemst / item_gemst carry an int32 `shape`) + inorganic identity.
#include "df/item_smallgemst.h"
#include "df/item_gemst.h"
#include "df/item_instrumentst.h"
#include "df/item_toolst.h"
#include "df/inorganic_raw.h"
#include "df/inorganic_flags.h"
#include "df/creature_raw.h"
#include "df/plant.h"
#include "df/plant_raw.h"
#include "df/plant_growth.h"
#include "df/plant_growth_print.h"
#include "df/global_objects.h"
#include "df/plant_tree_info.h"                // large-tree body/roots extent
#include "df/plant_tree_tile.h"                // per-tile trunk/branch/leaf bits (u16)
#include "df/plant_root_tile.h"                // per-tile root bits (u8)
#include "df/block_square_event.h"
#include "df/block_square_event_material_spatterst.h"
#include "df/block_square_event_item_spatterst.h"
#include "df/block_square_event_grassst.h"   // Grass coverage/species event
#include "df/block_square_event_designation_priorityst.h"  // Designation priority grid
#include "df/flow_info.h"
#include "df/engraving.h"                    // world->event.engravings
// world->event.vermin and vermin_colonies are BOTH std::vector<df::vermin*>; flags.bits.is_colony
// is what actually marks a colony instance.
#include "df/vermin.h"

// Items::getContainedItems walks an item's contained-item refs. Pure read; caller holds the
// CoreSuspender.
#include "modules/Items.h"

// Resolves a material's Solid state_color the same way world_stream.cpp does for BUILDINGS_DELTA,
// so the SPATTER tail can carry a real colour instead of making the client guess by hash.
#include "modules/Materials.h"
#include "df/material.h"
#include "df/descriptor_color.h"
#include "df/matter_state.h"

// ITEMDEF_DICT: the 14 raw itemdef subcategories, in DFHack's ITEMDEF_VECTORS order.
#include "df/itemdef.h"
#include "df/itemdef_handlerst.h"
#include "df/itemdef_weaponst.h"
#include "df/itemdef_trapcompst.h"
#include "df/itemdef_toyst.h"
#include "df/itemdef_toolst.h"
#include "df/itemdef_instrumentst.h"
#include "df/itemdef_armorst.h"
#include "df/itemdef_ammost.h"
#include "df/itemdef_siegeammost.h"
#include "df/itemdef_glovesst.h"
#include "df/itemdef_shoesst.h"
#include "df/itemdef_shieldst.h"
#include "df/itemdef_helmst.h"
#include "df/itemdef_pantsst.h"
#include "df/itemdef_foodst.h"

#include <algorithm>
#include <cstring>
#include <unordered_map>

using namespace DFHack;

namespace dwf {
namespace wire {

// ---- little-endian signed helpers --------------------------------------------------
static inline void put_i16(std::vector<uint8_t>& o, int v) { put_u16(o, (uint16_t)(int16_t)v); }
static inline void put_i32(std::vector<uint8_t>& o, int v) { put_u32(o, (uint32_t)(int32_t)v); }

// ---- frame header ------------------------------------------------------------------
std::vector<uint8_t> build_frame_header(uint8_t type, uint8_t flags, uint32_t seq) {
    std::vector<uint8_t> h;
    h.reserve(kHeaderSize);
    h.push_back(kMagic0);
    h.push_back(kMagic1);
    h.push_back(kVersion);
    h.push_back(type);
    h.push_back(flags);
    h.push_back(0);          // rsvd
    put_u32(h, seq);
    return h;
}

// ---- tile record -------------------------------------------------------------------
void write_tile_record(uint8_t out[kTileRecordSize], const TileRecord& r) {
    out[0] = (uint8_t)(r.tt & 0xFF);
    out[1] = (uint8_t)((r.tt >> 8) & 0xFF);
    uint16_t mt = (uint16_t)r.base_mt, mi = (uint16_t)r.base_mi;
    out[2] = (uint8_t)(mt & 0xFF);      out[3] = (uint8_t)((mt >> 8) & 0xFF);
    out[4] = (uint8_t)(mi & 0xFF);      out[5] = (uint8_t)((mi >> 8) & 0xFF);
    out[6] = r.bits;
    out[7] = r.desig1;
    out[8] = r.desig2;
    out[9] = r.spatter_amt;
    out[10] = (uint8_t)(r.flags2 & 0xFF);
    out[11] = (uint8_t)((r.flags2 >> 8) & 0xFF);
}

// ---- BLOCK_SET payload -------------------------------------------------------------
std::vector<uint8_t> assemble_block_set(uint32_t world_seq, const EncodedBlock* blocks, size_t n) {
    std::vector<uint8_t> o;
    size_t dropped_oversized_tails = 0;
    uint8_t first_dropped_kind = 0;
    size_t first_dropped_size = 0;
    o.reserve(6 + n * (13 + kTilesPerBlock * kTileRecordSize + 16));
    put_u32(o, world_seq);
    put_u16(o, (uint16_t)n);
    for (size_t bi = 0; bi < n; ++bi) {
        const EncodedBlock& b = blocks[bi];
        put_u16(o, b.bx);
        put_u16(o, b.by);
        put_u16(o, b.bz);
        put_u32(o, b.ver);
        o.push_back(b.bflags);
        // tail_count is u16: a grass-dense block carries up to 256 GRASS tails plus its item and
        // spatter tails, so a u8 count silently truncated everything past the 255th, server-side.
        uint16_t tail_count = 0;
        for (const Tail& t : b.tails) {
            if (t.data.size() > 255) {
                if (dropped_oversized_tails == 0) {
                    first_dropped_kind = t.kind;
                    first_dropped_size = t.data.size();
                }
                ++dropped_oversized_tails;
                continue;
            }
            if (tail_count == 65535) break;
            ++tail_count;
        }
        put_u16(o, tail_count);
        for (size_t i = 0; i < kTilesPerBlock; ++i) {
            uint8_t rec[kTileRecordSize];
            write_tile_record(rec, b.records[i]);
            o.insert(o.end(), rec, rec + kTileRecordSize);
        }
        uint16_t emitted_tails = 0;
        for (const Tail& t : b.tails) {
            if (t.data.size() > 255) continue;
            if (emitted_tails == tail_count) break;
            o.push_back(t.tile_idx);
            o.push_back(t.kind);
            o.push_back((uint8_t)t.data.size());
            o.insert(o.end(), t.data.begin(), t.data.end());
            ++emitted_tails;
        }
    }
    if (dropped_oversized_tails != 0) {
        diagnostics_log("wire-v1: dropped " + std::to_string(dropped_oversized_tails) +
                        " oversized tail(s); first kind=" + std::to_string(first_dropped_kind) +
                        " size=" + std::to_string(first_dropped_size));
    }
    return o;
}

// ---- CRC32 (IEEE, reflected) -------------------------------------------------------
uint32_t crc32(const uint8_t* data, size_t len) {
    static uint32_t table[256];
    static bool init = false;
    if (!init) {
        for (uint32_t i = 0; i < 256; ++i) {
            uint32_t c = i;
            for (int k = 0; k < 8; ++k) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
            table[i] = c;
        }
        init = true;
    }
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; ++i) c = table[(c ^ data[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

// Appends subtype/iflags/stack AFTER the original 8-byte prefix, additively on the SAME kTailItem
// kind, so a decoder that reads only offsets 0-7 and advances by the length prefix still works.
static Tail make_item_tail(uint8_t idx, int item_type, int mat_type, int mat_index,
                            int subtype, uint8_t iflags, int stack,
                            uint8_t ident_kind = kItemIdentNone,
                            const std::string& ident = std::string(),
                            bool has_shape = false, int shape = 0,
                            bool has_quality = false, uint8_t quality = 0,
                            uint8_t qflags = 0, uint8_t wear = 0,
                            bool skeletal = false) {
    Tail t; t.tile_idx = idx; t.kind = kTailItem;
    put_i16(t.data, item_type);
    put_i16(t.data, mat_type);
    put_i32(t.data, mat_index);
    put_i16(t.data, subtype);
    // iflags keeps its 5 real flag bits (0x1F). kItemFlagHasQuality and kItemFlagSkeletal ride
    // ABOVE that mask, so an old decoder masking & 0x1f is untouched.
    t.data.push_back((uint8_t)((iflags & (0x1F | kItemFlagGrown))
                               | (has_quality ? kItemFlagHasQuality : 0)
                               | (skeletal ? kItemFlagSkeletal : 0)));
    int st = stack < 0 ? 0 : (stack > 255 ? 255 : stack);
    t.data.push_back((uint8_t)st);
    // Append the resolved identity ONLY when one was resolved: absent identity keeps the tail at
    // 12 bytes, which old decoders skip by the wire's own length prefix.
    if (ident_kind != kItemIdentNone && !ident.empty()) {
        t.data.push_back(ident_kind);
        uint8_t idlen = (uint8_t)(ident.size() > 255 ? 255 : ident.size());
        t.data.push_back(idlen);
        t.data.insert(t.data.end(), ident.begin(), ident.begin() + idlen);
    }
    // A gem's cut `shape` is the LAST two bytes, AFTER any identity block, and the decoder carves
    // it off the END first -- so identity stays unambiguous even when it is absent (glass gems).
    if (has_shape) put_i16(t.data, shape);
    // The quality block sits at the very END, after identity and after gem-shape, and its presence
    // is flagged by iflags bit5, so the decoder carves it off the tail END before anything else.
    if (has_quality) {
        t.data.push_back((uint8_t)(quality > 5 ? 5 : quality));
        t.data.push_back(qflags);
        t.data.push_back((uint8_t)(wear > 3 ? 3 : wear));
    }
    return t;
}

// Resolves the per-species token an ITEM tail should carry, so the client can draw real art rather
// than a placeholder box. Returns false when nothing resolves. Caller holds the CoreSuspender.
static int item_identity_race(df::item* it) {
    // Corpses and corpsepieces are the concrete leaf types; strict_virtual_cast is exact-type, so
    // the abstract item_body_component base never matches.
    if (df::item_corpsest*       c = strict_virtual_cast<df::item_corpsest>(it))       return c->race;
    if (df::item_corpsepiecest*  c = strict_virtual_cast<df::item_corpsepiecest>(it))  return c->race;
    if (df::item_critter*        c = strict_virtual_cast<df::item_critter>(it))        return c->race;
    if (df::item_remainsst*      c = strict_virtual_cast<df::item_remainsst>(it))      return c->race;
    if (df::item_eggst*          c = strict_virtual_cast<df::item_eggst>(it))          return c->race;
    if (df::item_fish_rawst*     c = strict_virtual_cast<df::item_fish_rawst>(it))     return c->race;
    // Prepared FISH carries the same int16 `race` as raw fish, so it resolves to the same
    // per-species creature token.
    if (df::item_fishst*         c = strict_virtual_cast<df::item_fishst>(it))         return c->race;
    return -1;
}
// True iff DF's OWN item name labels this corpse a skeleton: getDescription IS the label surface,
// so ask it rather than guessing from a rot timer. Only corpse-derived types can skeletonize.
static bool item_is_skeletal(df::item* it) {
    if (!it) return false;
    bool corpse_class = strict_virtual_cast<df::item_corpsest>(it)
                     || strict_virtual_cast<df::item_corpsepiecest>(it)
                     || strict_virtual_cast<df::item_remainsst>(it);
    if (!corpse_class) return false;
    std::string desc = Items::getDescription(it, 0, false);
    for (char& ch : desc) ch = (char)std::tolower((unsigned char)ch);
    return desc.find("skele") != std::string::npos;
}
static bool resolve_item_identity(df::world* world, df::item* it, int mat_type, int mat_index,
                                  uint8_t& kind, std::string& token) {
    if (!world || !it) return false;
    int race = item_identity_race(it);
    if (race >= 0 && (size_t)race < world->raws.creatures.all.size()) {
        df::creature_raw* cr = world->raws.creatures.all[race];
        if (cr && !cr->creature_id.empty()) { kind = kItemIdentCreature; token = cr->creature_id; return true; }
    }
    if (mat_type >= 0) {
        MaterialInfo mi(mat_type, mat_index);
        if (mi.isValid()) {
            if (mi.plant && !mi.plant->id.empty())    { kind = kItemIdentPlant;    token = mi.plant->id;              return true; }
            if (mi.creature && !mi.creature->creature_id.empty()) { kind = kItemIdentCreature; token = mi.creature->creature_id; return true; }
            // Inorganic identity ships inorganic_raw.id, so the client's mat_index -> id map stays
            // verifiable on modded or generated worlds.
            if (mi.inorganic && !mi.inorganic->id.empty()) { kind = kItemIdentInorganic; token = mi.inorganic->id; return true; }
        }
    }
    return false;
}
// The representative FIRST contained item of a BARREL/BIN, so the client can composite native's
// per-category contents-peek cell: item_type i16 | mat_type i16 | mat_index i32 | subtype i16 | cflags u8.
static Tail make_container_peek_tail(uint8_t idx, int item_type, int mat_type, int mat_index,
                                     int subtype, uint8_t cflags) {
    Tail t; t.tile_idx = idx; t.kind = kTailContainerPeek;
    put_i16(t.data, item_type);
    put_i16(t.data, mat_type);
    put_i32(t.data, mat_index);
    put_i16(t.data, subtype);
    t.data.push_back(cflags);
    return t;
}

static Tail make_item_art_tail(uint8_t idx, bool has_instrument, uint8_t instrument_class,
                               bool special_material, bool generated_tool) {
    Tail t; t.tile_idx = idx; t.kind = kTailItemArt;
    uint8_t flags = 0;
    if (has_instrument) flags |= kItemArtHasInstrument;
    if (special_material) flags |= kItemArtSpecialMaterial;
    if (generated_tool) flags |= kItemArtGeneratedTool;
    t.data.push_back(flags);
    if (has_instrument) t.data.push_back(instrument_class);
    return t;
}

// Native prefers SPECIAL_MAT immediately after ARTIFACT, and sets that bit from inorganic_flags
// SPECIAL. Material family or identity alone cannot reconstruct it.
static bool item_uses_special_material(df::world* world, df::item* it) {
    if (!it || it->getMaterial() != 0 || !world) return false;
    int index = (int)it->getMaterialIndex();
    if (index < 0 || (size_t)index >= world->raws.inorganics.all.size()) return false;
    df::inorganic_raw* raw = world->raws.inorganics.all[index];
    return raw && raw->flags.is_set(df::inorganic_flags::SPECIAL);
}

// A completed loose INSTRUMENT uses one of eight music-skill/building cells. Generated instrument
// PIECES are TOOL items with no texpos_item, so they draw the single generated-tool pile instead.
static bool instrument_art_class(df::item* it, uint8_t& out) {
    df::item_instrumentst* inst = strict_virtual_cast<df::item_instrumentst>(it);
    if (!inst || !inst->subtype) return false;
    uint8_t family = 0;
    switch (inst->subtype->music_skill) {
        case df::enums::job_skill::PLAY_KEYBOARD_INSTRUMENT:   family = 0; break;
        case df::enums::job_skill::PLAY_STRINGED_INSTRUMENT:   family = 1; break;
        case df::enums::job_skill::PLAY_WIND_INSTRUMENT:       family = 2; break;
        case df::enums::job_skill::PLAY_PERCUSSION_INSTRUMENT: family = 3; break;
        default: return false;
    }
    bool building = inst->subtype->flags.is_set(df::enums::instrument_flags::PLACED_AS_BUILDING);
    out = (uint8_t)(family * 2 + (building ? 0 : 1));
    return true;
}

static bool generated_tool_art(df::item* it) {
    df::item_toolst* tool = strict_virtual_cast<df::item_toolst>(it);
    return tool && tool->subtype && tool->subtype->texpos_item == 0 &&
           tool->subtype->flags.is_set(df::enums::tool_flags::HARD_MAT);
}

static Tail make_plant_tail(uint8_t idx, uint8_t part, const std::string& id) {
    Tail t; t.tile_idx = idx; t.kind = kTailPlant;
    t.data.push_back(part);
    uint8_t idlen = (uint8_t)(id.size() > 255 ? 255 : id.size());
    t.data.push_back(idlen);
    t.data.insert(t.data.end(), id.begin(), id.begin() + idlen);
    return t;
}


// A key value of zero is valid, so tflags carries independent presence bits: growth selector zero
// is FRUIT_1, not NONE.
static Tail make_tree_graphics_tail(uint8_t idx, uint8_t tflags,
                                    uint16_t wood_key, uint32_t leaf_key) {
    Tail t; t.tile_idx = idx; t.kind = kTailTreeGraphics;
    t.data.push_back(tflags);
    put_u16(t.data, wood_key);
    put_u32(t.data, leaf_key);
    return t;
}

struct TreeGraphicsState {
    uint8_t flags = 0;
    uint16_t wood_key = 0;
    uint32_t leaf_key = 0;
};

static const char* const kTreeWoodTokens[216] = { "TREE_TRUNK_THICK_NW", "TREE_TRUNK_THICK_N", "TREE_TRUNK_THICK_NE", "TREE_TRUNK_THICK_W", "TREE_TRUNK_THICK_INTERIOR", "TREE_TRUNK_THICK_E", "TREE_TRUNK_THICK_SW", "TREE_TRUNK_THICK_S", "TREE_TRUNK_THICK_SE", "TREE_TRUNK_S", "TREE_TRUNK_W", "TREE_TRUNK_N", "TREE_TRUNK_E", "TREE_TRUNK_S_nwe", "TREE_TRUNK_N_swe", "TREE_TRUNK_E_nsw", "TREE_TRUNK_W_nse", "TREE_TRUNK_SE_nw", "TREE_TRUNK_SW_ne", "TREE_TRUNK_NW_se", "TREE_TRUNK_NE_sw", "TREE_TRUNK_NSW_e", "TREE_TRUNK_SWE_n", "TREE_TRUNK_NWE_s", "TREE_TRUNK_NSE_w", "TREE_TRUNK_WE_ns", "TREE_TRUNK_NS_we", "TREE_TRUNK_NSWE", "TREE_TRUNK_PILLAR", "TREE_TRUNK_S_ne", "TREE_TRUNK_N_sw", "TREE_TRUNK_E_nw", "TREE_TRUNK_W_se", "TREE_TRUNK_SE_n", "TREE_TRUNK_NW_s", "TREE_TRUNK_NE_w", "TREE_TRUNK_SW_e", "TREE_TRUNK_NS_e", "TREE_TRUNK_NS_w", "TREE_TRUNK_WE_n", "TREE_TRUNK_WE_s", "TREE_TRUNK_E_ns", "TREE_TRUNK_W_ns", "TREE_TRUNK_N_we", "TREE_TRUNK_S_we", "TREE_TRUNK_NSE", "TREE_TRUNK_NSW", "TREE_TRUNK_NWE", "TREE_TRUNK_SWE", "TREE_TRUNK_S_nw", "TREE_TRUNK_N_se", "TREE_TRUNK_E_sw", "TREE_TRUNK_W_ne", "TREE_TRUNK_SW_n", "TREE_TRUNK_NE_s", "TREE_TRUNK_SE_w", "TREE_TRUNK_NW_e", "TREE_TRUNK_SW", "TREE_TRUNK_NE", "TREE_TRUNK_SE", "TREE_TRUNK_NW", "TREE_TRUNK_NS", "TREE_TRUNK_WE", "TREE_TRUNK_S_n", "TREE_TRUNK_W_e", "TREE_TRUNK_N_s", "TREE_TRUNK_E_w", "TREE_TRUNK_E_n", "TREE_TRUNK_S_e", "TREE_TRUNK_W_s", "TREE_TRUNK_N_w", "TREE_TRUNK_W_n", "TREE_TRUNK_N_e", "TREE_TRUNK_E_s", "TREE_TRUNK_S_w", "TREE_TRUNK_SLOPE_TO_W", "TREE_TRUNK_SLOPE_TO_N", "TREE_TRUNK_SLOPE_TO_E", "TREE_TRUNK_SLOPE_TO_S", "TREE_TRUNK_SLOPE_E", "TREE_TRUNK_SLOPE_S", "TREE_TRUNK_SLOPE_W", "TREE_TRUNK_SLOPE_N", "TREE_TRUNK_SLOPE_NSW", "TREE_TRUNK_SLOPE_NWE", "TREE_TRUNK_SLOPE_NSE", "TREE_TRUNK_SLOPE_SWE", "TREE_TRUNK_SLOPE_NS", "TREE_TRUNK_SLOPE_WE", "TREE_TRUNK_SLOPE_NSWE", "TREE_TRUNK_SLOPE_TOP", "TREE_TRUNK_SLOPE_SE", "TREE_TRUNK_SLOPE_SW", "TREE_TRUNK_SLOPE_NW", "TREE_TRUNK_SLOPE_NE", "TREE_HEAVY_BRANCH_S_nwe", "TREE_HEAVY_BRANCH_N_swe", "TREE_HEAVY_BRANCH_E_nsw", "TREE_HEAVY_BRANCH_W_nse", "TREE_HEAVY_BRANCH_SE_nw", "TREE_HEAVY_BRANCH_SW_ne", "TREE_HEAVY_BRANCH_NW_se", "TREE_HEAVY_BRANCH_NE_sw", "TREE_HEAVY_BRANCH_NSW_e", "TREE_HEAVY_BRANCH_SWE_n", "TREE_HEAVY_BRANCH_NWE_s", "TREE_HEAVY_BRANCH_NSE_w", "TREE_HEAVY_BRANCH_WE_ns", "TREE_HEAVY_BRANCH_NS_we", "TREE_HEAVY_BRANCH_NSWE", "TREE_HEAVY_BRANCH", "TREE_HEAVY_BRANCH_s", "TREE_HEAVY_BRANCH_n", "TREE_HEAVY_BRANCH_e", "TREE_HEAVY_BRANCH_w", "TREE_HEAVY_BRANCH_se", "TREE_HEAVY_BRANCH_sw", "TREE_HEAVY_BRANCH_nw", "TREE_HEAVY_BRANCH_ne", "TREE_HEAVY_BRANCH_nse", "TREE_HEAVY_BRANCH_swe", "TREE_HEAVY_BRANCH_nwe", "TREE_HEAVY_BRANCH_nsw", "TREE_HEAVY_BRANCH_we", "TREE_HEAVY_BRANCH_ns", "TREE_HEAVY_BRANCH_nswe", "TREE_HEAVY_BRANCH_S", "TREE_HEAVY_BRANCH_W", "TREE_HEAVY_BRANCH_N", "TREE_HEAVY_BRANCH_E", "TREE_HEAVY_BRANCH_S_ne", "TREE_HEAVY_BRANCH_N_sw", "TREE_HEAVY_BRANCH_E_nw", "TREE_HEAVY_BRANCH_W_se", "TREE_HEAVY_BRANCH_SE_n", "TREE_HEAVY_BRANCH_NW_s", "TREE_HEAVY_BRANCH_NE_w", "TREE_HEAVY_BRANCH_SW_e", "TREE_HEAVY_BRANCH_NS_e", "TREE_HEAVY_BRANCH_NS_w", "TREE_HEAVY_BRANCH_WE_n", "TREE_HEAVY_BRANCH_WE_s", "TREE_HEAVY_BRANCH_E_ns", "TREE_HEAVY_BRANCH_W_ns", "TREE_HEAVY_BRANCH_N_we", "TREE_HEAVY_BRANCH_S_we", "TREE_HEAVY_BRANCH_NSE", "TREE_HEAVY_BRANCH_NSW", "TREE_HEAVY_BRANCH_NWE", "TREE_HEAVY_BRANCH_SWE", "TREE_HEAVY_BRANCH_S_nw", "TREE_HEAVY_BRANCH_N_se", "TREE_HEAVY_BRANCH_E_sw", "TREE_HEAVY_BRANCH_W_ne", "TREE_HEAVY_BRANCH_SW_n", "TREE_HEAVY_BRANCH_NE_s", "TREE_HEAVY_BRANCH_SE_w", "TREE_HEAVY_BRANCH_NW_e", "TREE_HEAVY_BRANCH_SW", "TREE_HEAVY_BRANCH_NE", "TREE_HEAVY_BRANCH_SE", "TREE_HEAVY_BRANCH_NW", "TREE_HEAVY_BRANCH_NS", "TREE_HEAVY_BRANCH_WE", "TREE_HEAVY_BRANCH_S_n", "TREE_HEAVY_BRANCH_W_e", "TREE_HEAVY_BRANCH_N_s", "TREE_HEAVY_BRANCH_E_w", "TREE_HEAVY_BRANCH_E_n", "TREE_HEAVY_BRANCH_S_e", "TREE_HEAVY_BRANCH_W_s", "TREE_HEAVY_BRANCH_N_w", "TREE_HEAVY_BRANCH_W_n", "TREE_HEAVY_BRANCH_N_e", "TREE_HEAVY_BRANCH_E_s", "TREE_HEAVY_BRANCH_S_w", "TREE_BRANCH_S", "TREE_BRANCH_N", "TREE_BRANCH_E", "TREE_BRANCH_W", "TREE_BRANCH_SE", "TREE_BRANCH_SW", "TREE_BRANCH_NW", "TREE_BRANCH_NE", "TREE_BRANCH_NSE", "TREE_BRANCH_SWE", "TREE_BRANCH_NWE", "TREE_BRANCH_NSW", "TREE_BRANCH_WE", "TREE_BRANCH_NS", "TREE_BRANCH_NSWE", "TREE_BRANCH", "TREE_LEAFLESS_TWIGS_N", "TREE_LEAFLESS_TWIGS_S", "TREE_LEAFLESS_TWIGS_W", "TREE_LEAFLESS_TWIGS_E", "TREE_LEAFLESS_TWIGS", "TREE_LEAFLESS_TWIGS_WE", "TREE_LEAFLESS_TWIGS_NS", "TREE_LEAFLESS_TWIGS_NSWE", "TREE_LEAFLESS_TWIGS_FULL_N", "TREE_LEAFLESS_TWIGS_FULL_S", "TREE_LEAFLESS_TWIGS_FULL_E", "TREE_LEAFLESS_TWIGS_FULL_W", "TREE_LEAFLESS_TWIGS_FULL_SE", "TREE_LEAFLESS_TWIGS_FULL_SW", "TREE_LEAFLESS_TWIGS_FULL_NE", "TREE_LEAFLESS_TWIGS_FULL_NW", "TREE_LEAFLESS_TWIGS_SW", "TREE_LEAFLESS_TWIGS_SE", "TREE_LEAFLESS_TWIGS_NW", "TREE_LEAFLESS_TWIGS_NE", "TREE_LEAFLESS_TWIGS_SWE", "TREE_LEAFLESS_TWIGS_NSW", "TREE_LEAFLESS_TWIGS_NWE", "TREE_LEAFLESS_TWIGS_NSE" };
static const char* const kTreeLeafTokens[58] = { "TREE_TWIGS_FULL1", "TREE_TWIGS_FULL2", "TREE_TWIGS_FULL3", "TREE_TWIGS_FULL4", "TREE_TWIGS_N", "TREE_TWIGS_S", "TREE_TWIGS_W", "TREE_TWIGS_E", "TREE_TWIGS", "TREE_TWIGS_WE", "TREE_TWIGS_NS", "TREE_TWIGS_NSWE", "TREE_TWIGS_FULL_N", "TREE_TWIGS_FULL_S", "TREE_TWIGS_FULL_E", "TREE_TWIGS_FULL_W", "TREE_TWIGS_FULL_SE", "TREE_TWIGS_FULL_SW", "TREE_TWIGS_FULL_NE", "TREE_TWIGS_FULL_NW", "TREE_TWIGS_SW", "TREE_TWIGS_SE", "TREE_TWIGS_NW", "TREE_TWIGS_NE", "TREE_TWIGS_SWE", "TREE_TWIGS_NSW", "TREE_TWIGS_NWE", "TREE_TWIGS_NSE", "TREE_OVERLEAVES_TRUNK_S", "TREE_OVERLEAVES_TRUNK_N", "TREE_OVERLEAVES_TRUNK_E", "TREE_OVERLEAVES_TRUNK_W", "TREE_OVERLEAVES_TRUNK_SE", "TREE_OVERLEAVES_TRUNK_SW", "TREE_OVERLEAVES_TRUNK_NW", "TREE_OVERLEAVES_TRUNK_NE", "TREE_OVERLEAVES_TRUNK_NSW", "TREE_OVERLEAVES_TRUNK_SWE", "TREE_OVERLEAVES_TRUNK_NWE", "TREE_OVERLEAVES_TRUNK_NSE", "TREE_OVERLEAVES_TRUNK_WE", "TREE_OVERLEAVES_TRUNK_NS", "TREE_OVERLEAVES_TRUNK_NSWE", "TREE_OVERLEAVES_HEAVY_BRANCH_S", "TREE_OVERLEAVES_HEAVY_BRANCH_N", "TREE_OVERLEAVES_HEAVY_BRANCH_E", "TREE_OVERLEAVES_HEAVY_BRANCH_W", "TREE_OVERLEAVES_HEAVY_BRANCH_SE", "TREE_OVERLEAVES_HEAVY_BRANCH_SW", "TREE_OVERLEAVES_HEAVY_BRANCH_NW", "TREE_OVERLEAVES_HEAVY_BRANCH_NE", "TREE_OVERLEAVES_HEAVY_BRANCH_NSW", "TREE_OVERLEAVES_HEAVY_BRANCH_SWE", "TREE_OVERLEAVES_HEAVY_BRANCH_NWE", "TREE_OVERLEAVES_HEAVY_BRANCH_NSE", "TREE_OVERLEAVES_HEAVY_BRANCH_WE", "TREE_OVERLEAVES_HEAVY_BRANCH_NS", "TREE_OVERLEAVES_HEAVY_BRANCH_NSWE" };

static int tree_token_index(const char* const* tokens, size_t count, const std::string& token) {
    for (size_t i = 0; i < count; ++i)
        if (token == tokens[i]) return (int)i;
    return -1;
}

static std::string canonical_tree_dirs(std::string dirs) {
    std::string out;
    for (char c : std::string("NSWE")) if (dirs.find(c) != std::string::npos) out.push_back(c);
    return out;
}

static std::string tree_enum_suffix(std::string key, const std::string& prefix) {
    if (key.compare(0, prefix.size(), prefix) != 0) return std::string();
    return canonical_tree_dirs(key.substr(prefix.size()));
}

// Selector transcription for the tiletype-explicit arms; parent-direction refinements are NOT
// guessed. With no exact token, no key is emitted and the species/tiletype fallback art stands.
static int tree_wood_selector(df::tiletype tt) {
    std::string key = ENUM_KEY_STR(tiletype, tt);
    size_t dead = key.find("Dead");
    if (dead != std::string::npos) key.erase(dead, 4);
    std::string token;
    if (key == "TreeTrunkPillar") token = "TREE_TRUNK_PILLAR";
    else if (key == "TreeTrunkInterior") token = "TREE_TRUNK_THICK_INTERIOR";
    else if (key == "TreeTrunkSloping") token = "TREE_TRUNK_SLOPE_TOP";
    else if (key.compare(0, 14, "TreeTrunkThick") == 0)
        token = "TREE_TRUNK_THICK_" + tree_enum_suffix(key, "TreeTrunkThick");
    else if (key.compare(0, 15, "TreeTrunkBranch") == 0)
        token = "TREE_TRUNK_" + tree_enum_suffix(key, "TreeTrunkBranch");
    else if (key.compare(0, 9, "TreeTrunk") == 0) {
        std::string d = tree_enum_suffix(key, "TreeTrunk");
        if (!d.empty()) token = "TREE_TRUNK_" + d;
    } else if (key == "TreeBranches" || key == "TreeBranchesSmooth") token = "TREE_BRANCH";
    else if (key.compare(0, 10, "TreeBranch") == 0) {
        std::string d = tree_enum_suffix(key, "TreeBranch");
        token = d.empty() ? "TREE_BRANCH" : "TREE_BRANCH_" + d;
    }
    return token.empty() ? -1 : tree_token_index(kTreeWoodTokens, 216, token);
}

static int tree_leaf_selector(df::tiletype tt, const df::plant_tree_info* ti,
                              int dx, int dy, int zb) {
    std::string key = ENUM_KEY_STR(tiletype, tt);
    if (key.find("Dead") != std::string::npos) return -1;
    std::string token;
    if (key == "TreeTwigs" && ti && ti->body && zb >= 0 && zb < ti->body_height && ti->body[zb]) {
        std::string d;
        auto occupied = [&](int x, int y) {
            if (x < 0 || y < 0 || x >= ti->dim_x || y >= ti->dim_y) return false;
            return (ti->body[zb][x + y * ti->dim_x].whole & 0xff7f) != 0;
        };
        if (occupied(dx, dy - 1)) d += 'N';
        if (occupied(dx, dy + 1)) d += 'S';
        if (occupied(dx - 1, dy)) d += 'W';
        if (occupied(dx + 1, dy)) d += 'E';
        token = d.empty() ? "TREE_TWIGS" : "TREE_TWIGS_" + d;
    } else if (key.compare(0, 9, "TreeTrunk") == 0) {
        std::string d = tree_enum_suffix(key, "TreeTrunk");
        if (!d.empty()) token = "TREE_OVERLEAVES_TRUNK_" + d;
    } else if (key.compare(0, 10, "TreeBranch") == 0) {
        std::string d = tree_enum_suffix(key, "TreeBranch");
        if (!d.empty()) token = "TREE_OVERLEAVES_HEAVY_BRANCH_" + d;
    }
    return token.empty() ? -1 : tree_token_index(kTreeLeafTokens, 58, token);
}

static bool tree_timing_active(int phase, int start, int end) {
    if (start == -1) return true;
    return start <= end ? (phase >= start && phase <= end) : (phase >= start || phase <= end);
}

static uint32_t tree_growth_host(df::tiletype tt) {
    df::tiletype_shape shp = tileShape(tt);
    std::string key = ENUM_KEY_STR(tiletype, tt);
    if (key.find("Root") != std::string::npos) return 0x10;
    if (key.find("Cap") != std::string::npos) return 0x20;
    if (shp == df::tiletype_shape::TWIG) return 0x01;
    if (shp == df::tiletype_shape::BRANCH)
        return key.find("Smooth") != std::string::npos ? 0x02 : 0x04;
    if (shp == df::tiletype_shape::TRUNK_BRANCH || shp == df::tiletype_shape::WALL) return 0x08;
    if (shp == df::tiletype_shape::SAPLING) return 0x40;
    return 0;
}

static int tree_growth_selector(df::pmd_growth_flag_graphics_type gt) {
    switch ((int)gt) {
    case 2: return 0; // STANDARD_FRUIT_1
    case 4: return 1; // STANDARD_FRUIT_2
    case 8: return 2; // STANDARD_FRUIT_3
    case 5: return 3; // STANDARD_FLOWERS_2 (native reversal)
    case 3: return 4; // STANDARD_FLOWERS_1
    default: return -1;
    }
}

static TreeGraphicsState compute_tree_graphics(df::plant* plant, df::tiletype tt,
                                               int tx, int ty, int bz) {
    TreeGraphicsState out;
    if (!plant || !plant->tree_info) return out;
    df::plant_tree_info* ti = plant->tree_info;
    int dx = tx - (plant->pos.x - ti->dim_x / 2);
    int dy = ty - (plant->pos.y - ti->dim_y / 2);
    int zb = bz - plant->pos.z;
    if (dx < 0 || dy < 0 || dx >= ti->dim_x || dy >= ti->dim_y) return out;

    int wood = tree_wood_selector(tt);
    if (wood >= 0 && wood < 216) {
        out.flags |= kTreeGraphicsWoodPresent;
        out.wood_key = (uint16_t)(wood << 8); // palette-vector field is not typed by df-structures
    }

    int leaf = tree_leaf_selector(tt, ti, dx, dy, zb);
    if (leaf < 0 || leaf >= 58) return out;
    df::plant_raw* raw = df::plant_raw::find(plant->material);
    if (!raw) return out;

    // Native adds a coordinate hash before the annual modulo that DFHack does not expose, so this
    // uses the unjittered phase; print ordering, wrapping and the winner law below are exact.
    int phase = (df::global::cur_year_tick ? *df::global::cur_year_tick : 0) % 403200;
    if (phase < 0) phase += 403200;
    int height = ti->body_height > 1 ? (zb * 100) / (ti->body_height - 1) : 0;
    uint32_t host = tree_growth_host(tt);
    bool foliage = false;
    int autumn = 0, best_priority = 0, best_growth = -1;
    for (size_t gi = 0; gi < raw->growths.size(); ++gi) {
        df::plant_growth* growth = raw->growths[gi];
        if (!growth || !(growth->locations.whole & host)) continue;
        if (height < growth->trunk_height_perc_1 || height > growth->trunk_height_perc_2) continue;
        // timing_1 == -1 is native's persistent-suppression arm. The six vectors it consults are
        // not named in current df-structures, so this read-only port cannot inspect them.
        if (growth->timing_1 != -1 && !tree_timing_active(phase, growth->timing_1, growth->timing_2)) continue;
        for (df::plant_growth_print* print : growth->prints) {
            if (!print || print->priority == 0 || !tree_timing_active(phase, print->timing_start, print->timing_end)) continue;
            int gt = (int)growth->behavior.bits.graphics_type;
            if (gt == 1) {
                foliage = true;
                if (print->color[0] == 6 && print->color[2] == 1) autumn = 1;
                else if (print->color[0] == 4 && print->color[2] == 1) autumn = 2;
                else if (print->color[0] == 4) autumn = 3;
            } else {
                int converted = tree_growth_selector(growth->behavior.bits.graphics_type);
                if (converted >= 0 && print->priority > best_priority) {
                    best_priority = print->priority;
                    best_growth = converted; // strict > preserves first raw-order tie
                }
            }
        }
    }
    if (!foliage) return out;
    out.flags |= kTreeGraphicsLeafPresent;
    if (best_growth >= 0) out.flags |= kTreeGraphicsGrowthPresent;
    out.leaf_key = (uint32_t)(leaf << 8) | (uint32_t)(autumn << 19);
    if (best_growth >= 0) out.leaf_key |= (uint32_t)best_growth << 16;
    return out;
}

static Tail make_farm_crop_tail(uint8_t idx, uint8_t stage, const std::string& id) {
    Tail t; t.tile_idx = idx; t.kind = kTailFarmCrop;
    t.data.push_back(stage > 2 ? 2 : stage);
    uint8_t idlen = (uint8_t)(id.size() > 255 ? 255 : id.size());
    t.data.push_back(idlen);
    t.data.insert(t.data.end(), id.begin(), id.begin() + idlen);
    return t;
}
// Appends `state` after the original 8-byte prefix, then an optional has_rgb + (r,g,b). Both are
// additive: a decoder that reads only the first 8 bytes advances by the wire's own length prefix.
static Tail make_spatter_tail(uint8_t idx, int mat_type, int mat_index, int amount, int state,
                               bool has_rgb = false, uint8_t r = 0, uint8_t g = 0, uint8_t b = 0) {
    Tail t; t.tile_idx = idx; t.kind = kTailSpatterMat;
    put_i16(t.data, mat_type);
    put_i32(t.data, mat_index);
    if (amount < 0) amount = 0; if (amount > 65535) amount = 65535;
    put_u16(t.data, (uint16_t)amount);
    t.data.push_back((uint8_t)(int8_t)state);
    if (has_rgb) {
        t.data.push_back(1);
        t.data.push_back(r); t.data.push_back(g); t.data.push_back(b);
    }
    return t;
}

// Resolves (mat_type, mat_index)'s Solid state_color to an (r,g,b), mirroring BUILDINGS_DELTA's
// `rgb`. False for an unresolvable pair, and the caller then omits the extension bytes entirely.
static bool resolve_material_rgb(df::world* world, int mat_type, int mat_index,
                                  uint8_t& r, uint8_t& g, uint8_t& b) {
    if (mat_type < 0 || !world) return false;
    MaterialInfo mi(mat_type, mat_index);
    if (!mi.isValid() || !mi.material) return false;
    int cidx = mi.material->state_color[df::matter_state::Solid];
    if (cidx < 0 || (size_t)cidx >= world->raws.descriptors.colors.size()) return false;
    df::descriptor_color* col = world->raws.descriptors.colors[cidx];
    if (!col) return false;
    r = (uint8_t)std::min(255, std::max(0, (int)(col->red   * 255.0f + 0.5f)));
    g = (uint8_t)std::min(255, std::max(0, (int)(col->green * 255.0f + 0.5f)));
    b = (uint8_t)std::min(255, std::max(0, (int)(col->blue  * 255.0f + 0.5f)));
    return true;
}
// Fallen leaf/fruit litter. growth_class is resolved server-side, item_type is the raw
// df::item_type, and amount is the per-tile grid value clamped to u8.
static Tail make_item_spatter_tail(uint8_t idx, uint8_t growth_class, uint8_t item_type, int amount,
                                    bool has_rgb = false, uint8_t r = 0, uint8_t g = 0, uint8_t b = 0) {
    Tail t; t.tile_idx = idx; t.kind = kTailItemSpatter;
    t.data.push_back(growth_class);
    t.data.push_back(item_type);
    int amt = amount < 0 ? 0 : (amount > 255 ? 255 : amount);
    t.data.push_back((uint8_t)amt);
    if (has_rgb) {
        t.data.push_back(1);
        t.data.push_back(r); t.data.push_back(g); t.data.push_back(b);
    }
    return t;
}
// Block flows. One entry per tile -- the DENSEST wins, because DF draws one cloud cell.
static Tail make_flow_tail(uint8_t idx, int flow_type, int density) {
    Tail t; t.tile_idx = idx; t.kind = kTailFlow;
    t.data.push_back((uint8_t)(flow_type & 0xFF));
    int d = density < 0 ? 0 : (density > 255 ? 255 : density);
    t.data.push_back((uint8_t)d);
    return t;
}
// Carries the resolved TOKEN STRING, not a plant index: a raw index is useless to the client
// without a dictionary, and world->raws.plants order is not offline-reproducible.
static Tail make_grass_tail(uint8_t idx, const std::string& plant_id, uint8_t amount) {
    Tail t; t.tile_idx = idx; t.kind = kTailGrass;
    uint8_t idlen = (uint8_t)(plant_id.size() > 255 ? 255 : plant_id.size());
    t.data.push_back(idlen);
    t.data.insert(t.data.end(), plant_id.begin(), plant_id.begin() + idlen);
    t.data.push_back(amount);
    return t;
}
// `eflags` is df::engraving_flags.whole masked to its 10 real bits -- DF's own layout IS the
// wire's, so no remapping. `quality` is df::item_quality clamped to u8.
static Tail make_engraving_tail(uint8_t idx, uint16_t eflags, int quality) {
    Tail t; t.tile_idx = idx; t.kind = kTailEngraving;
    put_u16(t.data, (uint16_t)(eflags & 0x03FF));
    int q = quality < 0 ? 0 : (quality > 255 ? 255 : quality);
    t.data.push_back((uint8_t)q);
    return t;
}
// `priority` is the dig priority LEVEL (1-7). The CALLER converts DF's raw level*1000 and gates
// out the default: passing the raw value here would saturate the u8 clamp at 255.
static Tail make_desig_priority_tail(uint8_t idx, int priority) {
    Tail t; t.tile_idx = idx; t.kind = kTailDesigPriority;
    int p = priority < 0 ? 0 : (priority > 255 ? 255 : priority);
    t.data.push_back((uint8_t)p);
    return t;
}
// `vflags` bit0 is is_colony, bit1 a size-threshold large-swarm hint. The caller passes the
// already-classified bit; this only packs it.
static Tail make_vermin_tail(uint8_t idx, int race, int caste, uint8_t vflags,
                             const std::string& token = std::string()) {
    Tail t; t.tile_idx = idx; t.kind = kTailVermin;
    put_u16(t.data, (uint16_t)(race < 0 ? 0xFFFF : race));
    t.data.push_back((uint8_t)(caste < 0 ? 0xFF : caste));
    t.data.push_back(vflags);
    // Append the resolved creature token only when resolvable: `race` is a raws INDEX that the
    // client cannot map offline. An absent token keeps the tail at 4 bytes.
    if (!token.empty()) {
        uint8_t idlen = (uint8_t)(token.size() > 255 ? 255 : token.size());
        t.data.push_back(idlen);
        t.data.insert(t.data.end(), token.begin(), token.begin() + idlen);
    }
    return t;
}

// Classifies a PLANT_GROWTH item-spatter into kGrowth* by substring match on its raw growth token.
// Memoized per (mat_index, growth_index), since the lookup walks a raws vector.
static uint8_t classify_growth(df::world* world, df::item_type item_type,
                                int32_t mat_index, int16_t growth_index) {
    if (item_type != df::item_type::PLANT_GROWTH) return kGrowthOther;
    static std::unordered_map<int64_t, uint8_t> cache;
    int64_t key = ((int64_t)mat_index << 20) ^ (int64_t)(uint16_t)growth_index;
    auto it = cache.find(key);
    if (it != cache.end()) return it->second;
    uint8_t cls = kGrowthOther;
    if (world && mat_index >= 0 && mat_index < (int32_t)world->raws.plants.all.size()) {
        df::plant_raw* pr = world->raws.plants.all[mat_index];
        if (pr && growth_index >= 0 && growth_index < (int16_t)pr->growths.size()) {
            df::plant_growth* pg = pr->growths[growth_index];
            if (pg) {
                const std::string& tok = pg->id;
                if (tok.find("LEA") != std::string::npos) {
                    cls = kGrowthLeaves;
                } else if (tok.find("FRUIT") != std::string::npos) {
                    if (tok.find("SMALL") != std::string::npos)      cls = kGrowthFruitSmall;
                    else if (tok.find("LARGE") != std::string::npos) cls = kGrowthFruitLarge;
                    else                                             cls = kGrowthFruit;
                }
            }
        }
    }
    cache[key] = cls;
    return cls;
}

// ---- engraving world-vector index ---------------------------------------------------
// world->event.engravings has no per-block storage, unlike block->block_events and block->flows.
namespace {
inline uint64_t eng_bkey(int bx, int by, int bz) {
    return ((uint64_t)(uint32_t)bz << 40) | ((uint64_t)(uint32_t)by << 20) | (uint64_t)(uint32_t)bx;
}
struct EngravingIndex {
    size_t last_count = (size_t)-1;
    std::unordered_map<uint64_t, std::vector<EngravingHit>> by_block;
};
EngravingIndex& engraving_index() {
    static EngravingIndex idx;
    return idx;
}
void rebuild_engraving_index(df::world* world) {
    EngravingIndex& idx = engraving_index();
    idx.by_block.clear();
    if (!world) { idx.last_count = 0; return; }
    const auto& engs = world->event.engravings;
    for (size_t i = 0; i < engs.size(); ++i) {
        df::engraving* e = engs[i];
        if (!e) continue;
        int bx = e->pos.x >> 4, by = e->pos.y >> 4, bz = e->pos.z;
        int lx = e->pos.x & 15, ly = e->pos.y & 15;
        EngravingHit hit;
        hit.tile_idx = (uint8_t)(ly * 16 + lx);
        hit.eflags = (uint16_t)(e->flags.whole & 0x03FF);
        int q = (int)e->quality;
        hit.quality = (uint8_t)(q < 0 ? 0 : (q > 255 ? 255 : q));
        idx.by_block[eng_bkey(bx, by, bz)].push_back(hit);
    }
    idx.last_count = engs.size();
}
} // anonymous namespace

const std::vector<EngravingHit>* engravings_for_block(df::world* world, int bx, int by, int bz) {
    EngravingIndex& idx = engraving_index();
    if (world && world->event.engravings.size() != idx.last_count) rebuild_engraving_index(world);
    auto it = idx.by_block.find(eng_bkey(bx, by, bz));
    if (it == idx.by_block.end() || it->second.empty()) return nullptr;
    return &it->second;
}

uint64_t engraving_block_fold(df::world* world, int bx, int by, int bz) {
    const std::vector<EngravingHit>* hits = engravings_for_block(world, bx, by, bz);
    if (!hits) return 0;
    uint64_t h = kFnvOffsetBasis ^ (uint64_t)hits->size();
    for (const EngravingHit& hh : *hits) {
        uint64_t v = ((uint64_t)hh.tile_idx << 24) | ((uint64_t)hh.eflags << 8) | (uint64_t)hh.quality;
        h ^= v; h *= kFnvPrime;
    }
    return h;
}

// ---- vermin world-vector index ------------------------------------------------------
// Same size-change memo as the engraving index, over TWO vectors. `visible` gates emission.
namespace {
constexpr int32_t kVerminSwarmLargeAmount = 100;
struct VerminIndex {
    size_t last_vermin_count = (size_t)-1;
    size_t last_colony_count = (size_t)-1;
    std::unordered_map<uint64_t, std::vector<VerminHit>> by_block;
};
VerminIndex& vermin_index() {
    static VerminIndex idx;
    return idx;
}
void add_vermin_vec(VerminIndex& idx, const std::vector<df::vermin*>& vec, bool force_colony) {
    for (size_t i = 0; i < vec.size(); ++i) {
        df::vermin* v = vec[i];
        if (!v || !v->visible) continue;
        int bx = v->pos.x >> 4, by = v->pos.y >> 4, bz = v->pos.z;
        int lx = v->pos.x & 15, ly = v->pos.y & 15;
        VerminHit hit;
        hit.tile_idx = (uint8_t)(ly * 16 + lx);
        hit.race  = (uint16_t)(v->race < 0 ? 0xFFFF : v->race);
        hit.caste = (uint8_t)(v->caste < 0 ? 0xFF : v->caste);
        hit.vflags = 0;
        if (force_colony || v->flags.bits.is_colony) hit.vflags |= kVerminFlagColony;
        if (v->amount >= kVerminSwarmLargeAmount)     hit.vflags |= kVerminFlagSwarmLarge;
        idx.by_block[eng_bkey(bx, by, bz)].push_back(hit);
    }
}
void rebuild_vermin_index(df::world* world) {
    VerminIndex& idx = vermin_index();
    idx.by_block.clear();
    if (!world) { idx.last_vermin_count = 0; idx.last_colony_count = 0; return; }
    add_vermin_vec(idx, world->event.vermin, /*force_colony=*/false);
    add_vermin_vec(idx, world->event.vermin_colonies, /*force_colony=*/true);
    idx.last_vermin_count = world->event.vermin.size();
    idx.last_colony_count = world->event.vermin_colonies.size();
}
} // anonymous namespace

const std::vector<VerminHit>* vermin_for_block(df::world* world, int bx, int by, int bz) {
    VerminIndex& idx = vermin_index();
    if (world && (world->event.vermin.size() != idx.last_vermin_count ||
                  world->event.vermin_colonies.size() != idx.last_colony_count))
        rebuild_vermin_index(world);
    auto it = idx.by_block.find(eng_bkey(bx, by, bz));
    if (it == idx.by_block.end() || it->second.empty()) return nullptr;
    return &it->second;
}

uint64_t vermin_block_fold(df::world* world, int bx, int by, int bz) {
    const std::vector<VerminHit>* hits = vermin_for_block(world, bx, by, bz);
    if (!hits) return 0;
    uint64_t h = 12638153115695167455ull ^ (uint64_t)hits->size();
    for (const VerminHit& hh : *hits) {
        uint64_t v = ((uint64_t)hh.tile_idx << 24) | ((uint64_t)hh.race << 8) |
                     ((uint64_t)hh.caste << 4) | (uint64_t)hh.vflags;
        h ^= v; h *= kFnvPrime;
    }
    return h;
}

// ---- planted farm crops -------------------------------------------------------------
// The actual per-tile crop is a building-owned contained item, so the ordinary ITEM scan misses it.
namespace {
struct FarmCropIndex {
    std::unordered_map<uint64_t, std::vector<FarmCropHit>> by_block;
};
FarmCropIndex& farm_crop_index() {
    static FarmCropIndex idx;
    return idx;
}
}

void refresh_farm_crop_index(df::world* world) {
    FarmCropIndex& idx = farm_crop_index();
    idx.by_block.clear();
    if (!world) return;
    for (df::building_farmplotst* farm : world->buildings.other.FARM_PLOT) {
        if (!farm) continue;
        for (df::buildingitemst* bi : farm->contained_items) {
            if (!bi || bi->use_mode != df::building_item_role_type::PERM || !bi->item) continue;
            df::item* item = bi->item;
            uint8_t stage = 2;
            if (df::item_seedsst* seed = strict_virtual_cast<df::item_seedsst>(item)) {
                df::plant_raw* raw = df::plant_raw::find(seed->mat_index);
                if (!raw) continue;
                stage = seed->grow_counter <= 0 ? 0 : (seed->grow_counter < raw->growdur ? 1 : 2);
            } else if (!strict_virtual_cast<df::item_plantst>(item)) {
                continue;
            }
            df::plant_raw* raw = df::plant_raw::find(item->getMaterialIndex());
            if (!raw || raw->id.empty()) continue;
            const df::coord& pos = item->pos;
            int bx = pos.x >> 4, by = pos.y >> 4, bz = pos.z;
            FarmCropHit hit;
            hit.tile_idx = (uint8_t)(((pos.y & 15) * 16) + (pos.x & 15));
            hit.stage = stage;
            hit.plant_id = raw->id;
            auto& hits = idx.by_block[eng_bkey(bx, by, bz)];
            auto existing = std::find_if(hits.begin(), hits.end(), [&](const FarmCropHit& h) {
                return h.tile_idx == hit.tile_idx;
            });
            if (existing == hits.end()) hits.push_back(std::move(hit));
            else if (hit.stage >= existing->stage) *existing = std::move(hit);
        }
    }
}

const std::vector<FarmCropHit>* farm_crops_for_block(int bx, int by, int bz) {
    FarmCropIndex& idx = farm_crop_index();
    auto it = idx.by_block.find(eng_bkey(bx, by, bz));
    if (it == idx.by_block.end() || it->second.empty()) return nullptr;
    return &it->second;
}

uint64_t farm_crop_block_fold(int bx, int by, int bz) {
    const std::vector<FarmCropHit>* hits = farm_crops_for_block(bx, by, bz);
    if (!hits) return 0;
    uint64_t h = 7809847782465536322ull ^ (uint64_t)hits->size();
    for (const FarmCropHit& hit : *hits) {
        h ^= ((uint64_t)hit.tile_idx << 8) | hit.stage;
        h *= kFnvPrime;
        h = fnv1a(h, hit.plant_id.data(), hit.plant_id.size());
    }
    return h;
}

// ---- deterministic self-test fixture ------------------------------------------------
// MUST stay byte-identical to the golden JS generator.
std::vector<uint8_t> build_selftest_fixture(uint32_t* out_world_seq) {
    const uint32_t world_seq = 42;
    if (out_world_seq) *out_world_seq = world_seq;

    EncodedBlock A;
    A.bx = 1; A.by = 2; A.bz = 3; A.ver = 100; A.bflags = 0;
    // default record for block A: plain floor tt=1, base_mi=-1
    for (auto& r : A.records) { r = TileRecord{}; r.tt = 1; r.base_mt = 0; r.base_mi = -1; }
    A.records[0] = TileRecord{};                                   // void (tt=0xFFFF, all 0)
    { auto& r = A.records[1]; r.tt = 100; r.base_mt = 5; r.base_mi = 6;  r.bits = pack_bits(1,7,0,1); }
    { auto& r = A.records[2]; r.tt = 101; r.base_mt = 7; r.base_mi = 8;  r.bits = pack_bits(2,3,0,0); }
    { auto& r = A.records[3]; r.tt = 102; r.base_mt = -1; r.base_mi = -1; r.bits = pack_bits(0,0,1,0); }
    { auto& r = A.records[4]; r.tt = 103; r.base_mt = 1; r.base_mi = 2;  r.desig1 = pack_desig1(6,2,1); r.desig2 = pack_desig2(3,15); }
    { auto& r = A.records[5]; r.tt = 104; r.base_mt = 3; r.base_mi = 4;  r.flags2 = kFlag2Item; }
    { auto& r = A.records[6]; r.tt = 105; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Plant; }
    { auto& r = A.records[7]; r.tt = 106; r.base_mt = 0; r.base_mi = -1; r.spatter_amt = 200; r.flags2 = kFlag2Spatter; }
    { auto& r = A.records[8]; r.tt = 107; r.base_mt = 11; r.base_mi = 12; r.bits = pack_bits(1,4,0,0);
      r.desig1 = pack_desig1(1,1,0); r.desig2 = pack_desig2(1,1); r.spatter_amt = 255;
      r.flags2 = (uint16_t)(kFlag2Item | kFlag2Plant | kFlag2Spatter); }
    // tile(9) two ITEM_SPATTER entries; tile(10) a mist flow; tile(11) two layered material
    // spatters -- kept off tiles 7 and 8, whose single-event values a golden test pins.
    { auto& r = A.records[9];  r.tt = 108; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2ItemSpatter; }
    { auto& r = A.records[10]; r.tt = 109; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Flow; }
    { auto& r = A.records[11]; r.tt = 110; r.base_mt = 0; r.base_mi = -1; r.spatter_amt = 255; r.flags2 = kFlag2Spatter; }
    // tile(12) a grass-floor tile carrying one GRASS tail (plant_id/amount).
    { auto& r = A.records[12]; r.tt = 111; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Grass; }
    // tile(13) TWO layered ENGRAVING records, proving the client must OR multiple records at one
    // tile_idx into a combined wall-face mask rather than decode only the last.
    { auto& r = A.records[13]; r.tt = 112; r.base_mt = 11; r.base_mi = 12; r.flags2 = kFlag2Engraving; }
    // tile(14) a priority-5 dig designation.
    { auto& r = A.records[14]; r.tt = 113; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2DesigPriority; }
    // tile(15) TWO layered VERMIN hits, proving >=1 hit per tile, as ENGRAVING does.
    { auto& r = A.records[15]; r.tt = 114; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Vermin; }
    // tile(16) a plant-identity item and tile(17) a creature-identity item, on fresh tiles so the
    // ident-less items stay 12 bytes and prove the extension is optional.
    { auto& r = A.records[16]; r.tt = 115; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[17]; r.tt = 116; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    // tile(18) inorganic ident + shape; tile(19) shape only, where 0xFFFF sits where an ident_kind
    // byte would; tile(20) inorganic ident on a non-shape item.
    { auto& r = A.records[18]; r.tt = 117; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[19]; r.tt = 118; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[20]; r.tt = 119; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    // Quality-block tiles: (21) q3, (22) q5, (23) q5+artifact, (24) q0 with wear, (25) q4 wear 3,
    // and (26) ident + shape + quality on ONE tail -- the end-carve stress case.
    { auto& r = A.records[21]; r.tt = 120; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[22]; r.tt = 121; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[23]; r.tt = 122; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[24]; r.tt = 123; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[25]; r.tt = 124; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[26]; r.tt = 125; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    // CONTAINER_PEEK on tiles 27-29, each an ITEM tail plus a peek tail at the same tile_idx.
    // The item_type ordinals here are the REAL df::item_type values and are load-bearing.
    { auto& r = A.records[27]; r.tt = 126; r.base_mt = 0; r.base_mi = -1; r.flags2 = (uint16_t)(kFlag2Item | kFlag2ContainerPeek); }
    { auto& r = A.records[28]; r.tt = 127; r.base_mt = 0; r.base_mi = -1; r.flags2 = (uint16_t)(kFlag2Item | kFlag2ContainerPeek); }
    { auto& r = A.records[29]; r.tt = 128; r.base_mt = 0; r.base_mi = -1; r.flags2 = (uint16_t)(kFlag2Item | kFlag2ContainerPeek); }
    // item(5) exercises a normal subtype + a 3-bit iflags combo + a plain stack;
    // item(8) exercises the subtype==-1 sentinel + a single iflags bit + a stack>255 clamp.
    A.tails.push_back(make_item_tail(5, 12, 34, 5678, 42,
                                      kItemFlagWeb | kItemFlagDump | kItemFlagOnFire, 5));
    A.tails.push_back(make_plant_tail(6, kPartTrunk, "OAK"));
    // tile(7)'s spatter now carries a mat_state byte (Liquid) -- amount/mat_type
    // unchanged from the earlier fixture (cache_test.mjs pins amount==5000/mat_type==9).
    A.tails.push_back(make_spatter_tail(7, 9, 10, 5000, 1 /*Liquid*/));
    A.tails.push_back(make_item_tail(8, 1, 2, 3, -1, kItemFlagForbid, 999));
    A.tails.push_back(make_plant_tail(8, kPartShrub, ""));
    // tile(8)'s spatter now exercises the matter_state==-1 (None) sentinel byte
    // (encoded 0xFF), on top of the pre-existing amount>65535 clamp.
    A.tails.push_back(make_spatter_tail(8, 13, 14, 65535, -1 /*None sentinel*/));
    // tile(9) LEAVES then FRUIT_LARGE. The item_type byte is synthetic and not load-bearing here;
    // encode_block's real read uses the runtime enum.
    A.tails.push_back(make_item_spatter_tail(9, kGrowthLeaves, 56, 60));
    A.tails.push_back(make_item_spatter_tail(9, kGrowthFruitLarge, 56, 12));
    // tile(10) a dense waterfall mist (flow_type=2 Mist).
    A.tails.push_back(make_flow_tail(10, 2 /*Mist*/, 180));
    // tile(11) two layered spatters, Solid then Paste; the second also exercises the optional
    // (r,g,b) bytes, with a synthetic colour.
    A.tails.push_back(make_spatter_tail(11, 30, 31, 4000, 0 /*Solid*/));
    A.tails.push_back(make_spatter_tail(11, 40, 41, 1500, 4 /*Paste*/,
                                         /*has_rgb=*/true, 180, 20, 20 /*resolved blood-red*/));
    // tile(12) grass coverage with a real vanilla grass token.
    A.tails.push_back(make_grass_tail(12, "MEADOW-GRASS", 45));
    // tile(13) a north then a south wall face: the client OR-combines eflags across records at one
    // tile and takes the max quality.
    A.tails.push_back(make_engraving_tail(13, 0x0008 /*north*/, 3));
    A.tails.push_back(make_engraving_tail(13, 0x0010 /*south*/, 5));
    // tile(14) priority 5.
    A.tails.push_back(make_desig_priority_tail(14, 5));
    // tile(15) a lone vermin then a colony, each carrying a resolved creature token.
    A.tails.push_back(make_vermin_tail(15, 200, 0, 0, "HONEY_BEE"));
    A.tails.push_back(make_vermin_tail(15, 210, 1, kVerminFlagColony | kVerminFlagSwarmLarge, "ANT"));
    // tile(16) a plant identity token, tile(17) a creature one. The item_type bytes are synthetic.
    A.tails.push_back(make_item_tail(16, 40, 0, 0, -1, 0, 3, kItemIdentPlant, "OAK"));
    A.tails.push_back(make_item_tail(17, 41, 0, 0, -1, 0, 1, kItemIdentCreature, "DWARF"));
    // The item_type bytes here ARE load-bearing: the decoder keys gem shape off SMALLGEM/GEM/ROUGH.
    A.tails.push_back(make_item_tail(18, /*SMALLGEM*/1, 0, 97, -1, 0, 1,
                                      kItemIdentInorganic, "GREEN_ZIRCON", /*has_shape*/true, 7));
    A.tails.push_back(make_item_tail(19, /*GEM*/44, 3 /*GLASS_GREEN*/, 0, -1, 0, 1,
                                      kItemIdentNone, std::string(), /*has_shape*/true, -1));
    A.tails.push_back(make_item_tail(20, /*ROUGH*/3, 0, 100, -1, 0, 1,
                                      kItemIdentInorganic, "MICROCLINE"));
    // Quality tails: (21) q3, (22) q5, (23) q5+artifact, (24) q0 wear1, (25) q4 wear3, and (26)
    // ident + shape + quality + artifact on one tail.
    A.tails.push_back(make_item_tail(21, 12, 34, 5678, -1, 0, 1, kItemIdentNone, std::string(),
                                      /*has_shape*/false, 0, /*has_quality*/true, 3, 0, 0));
    A.tails.push_back(make_item_tail(22, 12, 34, 5678, -1, 0, 1, kItemIdentNone, std::string(),
                                      false, 0, true, 5, 0, 0));
    A.tails.push_back(make_item_tail(23, 12, 34, 5678, -1, 0, 1, kItemIdentNone, std::string(),
                                      false, 0, true, 5, kItemQFlagArtifact, 0));
    A.tails.push_back(make_item_tail(24, 12, 34, 5678, -1, 0, 1, kItemIdentNone, std::string(),
                                      false, 0, true, 0, 0, 1));
    A.tails.push_back(make_item_tail(25, 12, 34, 5678, -1, 0, 1, kItemIdentNone, std::string(),
                                      false, 0, true, 4, 0, 3));
    A.tails.push_back(make_item_tail(26, /*SMALLGEM*/1, 0, 55, -1, 0, 1,
                                      kItemIdentInorganic, "RUBY", /*has_shape*/true, 3,
                                      /*has_quality*/true, 5, kItemQFlagArtifact, 0));
    // CONTAINER_PEEK tails (see the tile 27-29 comment above).
    A.tails.push_back(make_item_tail(27, /*BARREL*/17, 420, 30, -1, 0, 1));
    A.tails.push_back(make_container_peek_tail(27, /*MEAT*/48, 19, 5, -1, 0));
    A.tails.push_back(make_item_tail(28, /*BARREL*/17, 420, 30, -1, 0, 1));
    A.tails.push_back(make_container_peek_tail(28, /*PLANT*/54, 419, 12, -1, kPeekFlagSubterranean));
    A.tails.push_back(make_item_tail(29, /*BIN*/32, 420, 30, -1, 0, 1));
    A.tails.push_back(make_container_peek_tail(29, /*BAR*/0, 7 /*builtin COAL*/, 0, -1, 0));

    EncodedBlock B;
    B.bx = 300; B.by = 50; B.bz = 7; B.ver = 200; B.bflags = 0;
    for (auto& r : B.records) { r = TileRecord{}; r.tt = 2; r.base_mt = 0; r.base_mi = -1; }
    B.records[0]   = TileRecord{};                                 // void
    B.records[255] = TileRecord{};                                 // void (edge)
    { auto& r = B.records[10];  r.tt = 201; r.base_mt = -1; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = B.records[128]; r.tt = 200; r.base_mt = 100; r.base_mi = 200; r.bits = pack_bits(2,7,1,1); }
    // all-negative mats + subtype -1 + zero iflags + a negative stack (clamps to 0).
    B.tails.push_back(make_item_tail(10, -1, -1, -1, -1, 0, -5));

    // BLOCK C pins the u16 tail_count: 256 GRASS tails plus 4 ITEM tails at high tile_idx. Under a
    // u8 count the four items were truncated server-side. Their mat_index (700+k) identifies each.
    EncodedBlock C;
    C.bx = 500; C.by = 60; C.bz = 9; C.ver = 300; C.bflags = 0;
    for (int i = 0; i < 256; ++i) {
        auto& r = C.records[i];
        r.tt = 300; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Grass;
        if (i >= 250 && i <= 253) r.flags2 |= kFlag2Item;   // these 4 also carry an ITEM tail
    }
    for (int i = 0; i < 256; ++i)
        C.tails.push_back(make_grass_tail((uint8_t)i, "MEADOW-GRASS", (uint8_t)(i & 0x3F)));
    for (int k = 0; k < 4; ++k)                              // items AFTER the 256 grass tails
        C.tails.push_back(make_item_tail((uint8_t)(250 + k), /*AMULET-ish*/62, 0, 700 + k, -1, 0, 1));

    EncodedBlock blocks[3] = { A, B, C };
    std::vector<uint8_t> payload = assemble_block_set(world_seq, blocks, 3);
    std::vector<uint8_t> frame = build_frame_header(kTypeBlockSet, 0, 1);
    frame.insert(frame.end(), payload.begin(), payload.end());
    return frame;
}

// ---- DF-reading encoder -------------------------------------------------------------
// A raw per-z port of emit_tile_fields: no see-down descent, no wallnbr, no enum strings.
EncodedBlock encode_block(df::world* world, MapExtras::MapCache& MC, df::map_block* block,
                          int bx, int by, int bz, uint32_t ver) {
    EncodedBlock eb;
    eb.bx = (uint16_t)bx; eb.by = (uint16_t)by; eb.bz = (uint16_t)bz;
    eb.ver = ver; eb.bflags = 0;

    // Null/unrevealed/off-map block: all-void records, no tails.
    if (!block) return eb;

    const int base_tx = bx * 16, base_ty = by * 16;

    // Pre-scan block->flows ONCE into a per-tile "densest flow wins" table. DF RETAINS expired
    // flow_info records with flags.DEAD and re-uses the slots, so skip DEAD and density<=0.
    int8_t  flow_type_at[kTilesPerBlock];
    uint8_t flow_density_at[kTilesPerBlock];
    std::fill(std::begin(flow_type_at), std::end(flow_type_at), (int8_t)-1);
    std::fill(std::begin(flow_density_at), std::end(flow_density_at), (uint8_t)0);
    for (size_t fi = 0; fi < block->flows.size(); ++fi) {
        df::flow_info* fl = block->flows[fi];
        if (!fl || (int)fl->type < 0) continue;
        if (fl->flags.bits.DEAD || fl->density <= 0) continue;   // Zombie slots
        if (fl->pos.z != bz) continue;
        int flx = fl->pos.x - base_tx, fly = fl->pos.y - base_ty;
        if (flx < 0 || flx >= 16 || fly < 0 || fly >= 16) continue;
        int fidx = fly * 16 + flx;
        int dens = fl->density; if (dens > 255) dens = 255;
        if (flow_type_at[fidx] < 0 || (uint8_t)dens > flow_density_at[fidx]) {
            flow_type_at[fidx] = (int8_t)(int)fl->type;
            flow_density_at[fidx] = (uint8_t)dens;
        }
    }

    // DF stores no per-tile damp/warm marker: it derives the overlay from map state each frame.
    // The client cannot -- it never receives z+1, the water_table bit, or tile temperature.
    bool block_has_wall = false;
    for (int wy = 0; wy < 16 && !block_has_wall; ++wy)
        for (int wx = 0; wx < 16; ++wx)
            if (tileShape(block->tiletype[wx][wy]) == df::tiletype_shape::WALL) { block_has_wall = true; break; }

    // wet_here is an 18x18 grid (this block plus a 1-tile border); wet_above is 16x16 for z+1.
    // Zero-initialized so a wall-less block, which skips the fill, can never read stale.
    bool wet_here[18 * 18] = { false };
    bool wet_above[16 * 16] = { false };
    if (block_has_wall) {
        auto tile_is_wet = [](int wx, int wy, int wz) -> bool {
            df::tile_designation* d = DFHack::Maps::getTileDesignation(wx, wy, wz);
            if (!d) return false;
            if (d->bits.flow_size >= 1 && d->bits.liquid_type == df::enums::tile_liquid::Water)
                return true;
            if (!d->bits.water_table) return false;            // the aquifer bit
            df::tiletype* tt2 = DFHack::Maps::getTileType(wx, wy, wz);
            return tt2 && tileShape(*tt2) == df::tiletype_shape::WALL
                       && tileSpecial(*tt2) != df::tiletype_special::SMOOTH;
        };
        for (int gy = -1; gy <= 16; ++gy)
            for (int gx = -1; gx <= 16; ++gx)
                wet_here[(gy + 1) * 18 + (gx + 1)] = tile_is_wet(base_tx + gx, base_ty + gy, bz);
        for (int gy = 0; gy < 16; ++gy)
            for (int gx = 0; gx < 16; ++gx)
                wet_above[gy * 16 + gx] = tile_is_wet(base_tx + gx, base_ty + gy, bz + 1);
    }

    // ONE index lookup for the whole block (not per-tile -- engravings_for_block's
    // hash lookup by (bx,by,bz) returns the same small vector for all 256 tiles here).
    const std::vector<EngravingHit>* engraving_hits = engravings_for_block(world, bx, by, bz);
    // Same one-lookup-per-block pattern for vermin/vermin-colonies.
    const std::vector<VerminHit>* vermin_hits = vermin_for_block(world, bx, by, bz);
    // building-owned planted crops, indexed once per stream tick.
    const std::vector<FarmCropHit>* farm_crop_hits = farm_crops_for_block(bx, by, bz);

    // A fully-hidden block only reaches encode_block when it carries a live designation the player
    // must see over the black, so ship the designation ONLY and leak nothing else through the fog.
    bool block_fully_hidden = true;
    for (int hy = 0; hy < 16 && block_fully_hidden; ++hy)
        for (int hx = 0; hx < 16; ++hx)
            if (!block->designation[hx][hy].bits.hidden) { block_fully_hidden = false; break; }

    for (int ly = 0; ly < 16; ++ly) {
        for (int lx = 0; lx < 16; ++lx) {
            const int idx = ly * 16 + lx;
            const int tx = base_tx + lx, ty = base_ty + ly;
            TileRecord& r = eb.records[idx];

            df::tiletype tt = block->tiletype[lx][ly];
            df::tiletype_shape    shp  = tileShape(tt);
            df::tiletype_material tmat = tileMaterial(tt);

            df::tile_designation des = block->designation[lx][ly];
            df::tile_occupancy   occ = block->occupancy[lx][ly];
            int flow = des.bits.flow_size;
            int liquid = 0;
            if (flow > 0)
                liquid = (des.bits.liquid_type == df::enums::tile_liquid::Magma) ? 2 : 1;

            r.tt   = (uint16_t)(int)tt;
            r.bits = pack_bits(liquid, flow, des.bits.hidden ? 1 : 0, des.bits.outside ? 1 : 0);

            // Construction records own their built-from material; natural tiles use MapCache.
            int base_mt = -1, base_mi = -1;
            resolve_tile_material(MC, df::coord(tx, ty, bz), tmat, base_mt, base_mi);
            r.base_mt = (int16_t)base_mt;
            r.base_mi = (int16_t)base_mi;

            // designation bytes (dig/smooth/marker/automine; traffic/track) -- emitter parity.
            {
                int dig     = (int)des.bits.dig;
                int smooth  = (int)des.bits.smooth;
                int marker  = occ.bits.dig_marked ? 1 : 0;
                int automine = occ.bits.dig_auto ? 1 : 0;
                int traffic = (int)des.bits.traffic;
                int track = 0;
                if (occ.bits.carve_track_north) track |= 1;
                if (occ.bits.carve_track_south) track |= 2;
                if (occ.bits.carve_track_east)  track |= 4;
                if (occ.bits.carve_track_west)  track |= 8;
                r.desig1 = pack_desig1(dig, smooth, marker, automine);
                r.desig2 = pack_desig2(traffic, track);
            }

            // Void the tiletype, material and bits so an undiscovered tile crosses the wire
            // carrying nothing but its designation; undesignated tiles here stay pure void.
            if (block_fully_hidden) {
                r.tt = 0xFFFF; r.base_mt = -1; r.base_mi = -1;
                r.bits = 0; r.spatter_amt = 0; r.flags2 = 0;
                continue;   // skip all sparse-tail scans for an undiscovered tile
            }

            uint16_t flags2 = 0;

            // WALL tiles only -- nothing else is mineable -- and revealed tiles only: an
            // undiscovered tile must not advertise the water behind it.
            if (block_has_wall && shp == df::tiletype_shape::WALL && !des.bits.hidden) {
                const int gx = lx + 1, gy = ly + 1;   // wet_here is the 18x18 bordered grid
                bool damp = wet_here[(gy - 1) * 18 + (gx - 1)] || wet_here[(gy - 1) * 18 + gx]
                         || wet_here[(gy - 1) * 18 + (gx + 1)] || wet_here[gy * 18 + (gx - 1)]
                         || wet_here[gy * 18 + (gx + 1)]       || wet_here[(gy + 1) * 18 + (gx - 1)]
                         || wet_here[(gy + 1) * 18 + gx]       || wet_here[(gy + 1) * 18 + (gx + 1)]
                         || wet_above[ly * 16 + lx];
                if (damp) flags2 |= kFlag2Damp;
                // is_warm reads the tile's OWN temperature, not a neighbourhood: that is what
                // lets DF warn about magma you cannot see yet.
                if (block->temperature_1[lx][ly] >= 10075) flags2 |= kFlag2Warm;
            }

            // ITEM tail: topmost item on this tile. Items flagged hidden are skipped from
            // candidacy -- DF never draws them -- so the topmost VISIBLE item wins.
            {
                df::item* top = nullptr;
                const size_t ITEM_SCAN_CAP = 512;
                size_t scanned = 0;
                for (size_t ii = 0; ii < block->items.size() && scanned < ITEM_SCAN_CAP; ++ii, ++scanned) {
                    df::item* it = df::item::find(block->items[ii]);
                    if (!it) continue;
                    if (it->flags.bits.hidden) continue;
                    if (it->pos.x == tx && it->pos.y == ty && it->pos.z == bz) top = it;
                }
                if (top) {
                    // stack_size comes off item_actual, and is 1 when the item is not
                    // item_actual-derived.
                    int subtype = (int)top->getSubtype();
                    uint8_t iflags = 0;
                    if (top->flags.bits.spider_web) iflags |= kItemFlagWeb;
                    if (top->flags.bits.forbid)     iflags |= kItemFlagForbid;
                    if (top->flags.bits.dump)       iflags |= kItemFlagDump;
                    if (top->flags.bits.melt)       iflags |= kItemFlagMelt;
                    if (top->flags.bits.on_fire)    iflags |= kItemFlagOnFire;
                    // GROWN lives on flags2 in this DF build (df::item_flags2::grown), not flags.
                    if (top->flags2.bits.grown)     iflags |= kItemFlagGrown;
                    VIRTUAL_CAST_VAR(actual, df::item_actual, top);
                    int stack = actual ? actual->stack_size : 1;
                    int mt = (int)top->getMaterial(), mi_ = (int)top->getMaterialIndex();
                    // Resolve the per-species token so the client draws real art, not a box.
                    uint8_t ident_kind = kItemIdentNone; std::string ident;
                    resolve_item_identity(world, top, mt, mi_, ident_kind, ident);
                    // Only SMALLGEM and GEM carry a `shape` field; -1 means uncut or spawned.
                    // Non-gem items ship no shape at all.
                    bool has_shape = false; int gem_shape = -1;
                    if (df::item_smallgemst* sg = strict_virtual_cast<df::item_smallgemst>(top)) {
                        gem_shape = sg->shape; has_shape = true;
                    } else if (df::item_gemst* lg = strict_virtual_cast<df::item_gemst>(top)) {
                        gem_shape = lg->shape; has_shape = true;
                    }
                    // Emit the quality block ONLY when there is something to say: a plain,
                    // undamaged, non-artifact item stays byte-identical to the 12-byte tail.
                    int qv = (int)top->getQuality();
                    uint8_t quality = (uint8_t)(qv < 0 ? 0 : (qv > 5 ? 5 : qv));
                    uint8_t qflags = top->flags.bits.artifact ? kItemQFlagArtifact : 0;
                    int wv = actual ? actual->wear : 0;
                    uint8_t wear = (uint8_t)(wv < 0 ? 0 : (wv > 3 ? 3 : wv));
                    bool has_quality = (quality > 0 || qflags != 0 || wear > 0);
                    // Follow DF's OWN corpse-to-skeleton label, so a fresh corpse keeps body art
                    // until the game itself names it a skeleton.
                    bool skeletal = item_is_skeletal(top);
                    eb.tails.push_back(make_item_tail((uint8_t)idx, (int)top->getType(),
                                                      mt, mi_, subtype, iflags, stack,
                                                      ident_kind, ident, has_shape, gem_shape,
                                                      has_quality, quality, qflags, wear, skeletal));
                    uint8_t instrument_class = 0;
                    bool has_instrument_art = instrument_art_class(top, instrument_class);
                    bool special_material = item_uses_special_material(world, top);
                    bool generated_tool = generated_tool_art(top);
                    if (has_instrument_art || special_material || generated_tool)
                        eb.tails.push_back(make_item_art_tail((uint8_t)idx, has_instrument_art,
                                                             instrument_class, special_material,
                                                             generated_tool));
                    flags2 |= kFlag2Item;
                    // A BARREL or BIN with contents renders them poking out of its open top in
                    // native. Ship the FIRST contained item; an empty container gets no tail.
                    df::item_type tty = top->getType();
                    if (tty == df::item_type::BARREL || tty == df::item_type::BIN) {
                        std::vector<df::item*> contained;
                        Items::getContainedItems(top, &contained);
                        df::item* rep = nullptr;
                        for (size_t ci = 0; ci < contained.size(); ++ci)
                            if (contained[ci]) { rep = contained[ci]; break; }
                        if (rep) {
                            int rmt = (int)rep->getMaterial(), rmi = (int)rep->getMaterialIndex();
                            uint8_t cflags = 0;
                            // Subterranean crops pick a dedicated cell, and plant_raw's
                            // underground_depth_min > 0 is what identifies them.
                            if (rmt >= 0) {
                                MaterialInfo rmat(rmt, rmi);
                                if (rmat.isValid() && rmat.plant
                                    && rmat.plant->underground_depth_min > 0)
                                    cflags |= kPeekFlagSubterranean;
                            }
                            eb.tails.push_back(make_container_peek_tail((uint8_t)idx,
                                (int)rep->getType(), rmt, rmi, (int)rep->getSubtype(), cflags));
                            flags2 |= kFlag2ContainerPeek;
                        }
                    }
                }
            }

            // PLANT tail: a map column spans every z at this x/y, so matching only x/y selects a
            // plant above or below the rendered tile. Keep the z match.
            {
                int part = -1;
                if      (shp == df::tiletype_shape::SAPLING)      part = kPartSapling;
                else if (shp == df::tiletype_shape::SHRUB)        part = kPartShrub;
                else if (shp == df::tiletype_shape::TWIG)         part = kPartLeaves;
                else if (shp == df::tiletype_shape::BRANCH)       part = kPartBranch;
                else if (shp == df::tiletype_shape::TRUNK_BRANCH) part = kPartTrunk;
                else if (tmat == df::tiletype_material::TREE)
                    part = (shp == df::tiletype_shape::WALL) ? kPartTrunk : kPartCanopy;
                else if (tmat == df::tiletype_material::MUSHROOM) part = kPartTrunk;
                if (part >= 0) {
                    std::string pid;
                    df::plant* tree_owner = nullptr;
                    int colx = (tx / 48) * 3, coly = (ty / 48) * 3;
                    if (world->map.column_index && colx >= 0 && coly >= 0
                        && colx < world->map.x_count_block && coly < world->map.y_count_block) {
                        df::map_block_column* col = world->map.column_index[colx][coly];
                        if (col) {
                            const size_t PLANT_CAP = 4096;
                            // A large tree's body tiles sit above and around the plant's single
                            // root pos, so resolve them through the owning plant's tree_info extent.
                            df::plant* body_match = nullptr;
                            for (size_t pi = 0; pi < col->plants.size() && pi < PLANT_CAP; ++pi) {
                                df::plant* pl = col->plants[pi];
                                if (!pl) continue;
                                if (pl->pos.x == tx && pl->pos.y == ty && pl->pos.z == bz) {
                                    df::plant_raw* pr = df::plant_raw::find(pl->material);
                                    if (pr) pid = pr->id;
                                    tree_owner = pl;
                                    body_match = nullptr;
                                    break;
                                }
                                if (!body_match && pl->tree_info) {
                                    df::plant_tree_info* ti = pl->tree_info;
                                    int x_nw = pl->pos.x - (ti->dim_x / 2);
                                    int y_nw = pl->pos.y - (ti->dim_y / 2);
                                    int dx = tx - x_nw, dy = ty - y_nw;
                                    if (dx >= 0 && dy >= 0 && dx < ti->dim_x && dy < ti->dim_y) {
                                        int xy = dx + dy * ti->dim_x;
                                        int zb = bz - pl->pos.z;   // >=0 body, <0 roots
                                        if (zb >= 0 && zb < ti->body_height
                                            && ti->body && ti->body[zb]) {
                                            uint16_t w = ti->body[zb][xy].whole;
                                            if ((w & 0x7F) && !(w & 0x80)) body_match = pl;
                                        } else if (zb < 0) {
                                            int rd = -zb - 1;      // roots[0] == one z below pos
                                            if (rd >= 0 && rd < ti->roots_depth
                                                && ti->roots && ti->roots[rd]) {
                                                uint8_t w = ti->roots[rd][xy].whole;
                                                if ((w & 0x7F) && !(w & 0x80)) body_match = pl;
                                            }
                                        }
                                    }
                                }
                            }
                            if (pid.empty() && body_match) {
                                df::plant_raw* pr = df::plant_raw::find(body_match->material);
                                if (pr) pid = pr->id;
                                tree_owner = body_match;
                            }
                        }
                    }
                    if (tree_owner && tree_owner->tree_info) {
                        TreeGraphicsState tg = compute_tree_graphics(tree_owner, tt, tx, ty, bz);
                        if (tg.flags)
                            eb.tails.push_back(make_tree_graphics_tail((uint8_t)idx, tg.flags,
                                                                       tg.wood_key, tg.leaf_key));
                    }
                    eb.tails.push_back(make_plant_tail((uint8_t)idx, (uint8_t)part, pid));
                    flags2 |= kFlag2Plant;
                }
            }

            // SPATTER + ITEM_SPATTER: ALL events at this tile, ordered by amount descending and
            // capped at 4, since DF layers several observed decals.
            {
                struct SpEv { int amt; int16_t mt; int32_t mi; int8_t state; };
                struct IspEv { int amt; uint8_t growth_class; uint8_t item_type; bool has_rgb; uint8_t r, g, b; };
                std::vector<SpEv> spevs;
                std::vector<IspEv> ispevs;
                // Grass species is the FIRST event in block-vector order whose amount here is
                // non-zero. Tracked, not pushed, so the gate below decides whether a tail is added.
                int grass_amt = -1; int32_t grass_plant = -1;
                // designation-priority grid, same "track then gate" pattern as grass
                // above -- only emitted for non-default (non-zero) priority.
                int desig_priority = -1;
                for (size_t ei = 0; ei < block->block_events.size(); ++ei) {
                    STRICT_VIRTUAL_CAST_VAR(sp, df::block_square_event_material_spatterst, block->block_events[ei]);
                    if (sp) {
                        int amt = sp->amount[lx][ly];
                        if (amt > 0)
                            spevs.push_back(SpEv{amt, sp->mat_type, sp->mat_index, (int8_t)(int)sp->mat_state});
                        continue;
                    }
                    STRICT_VIRTUAL_CAST_VAR(isp, df::block_square_event_item_spatterst, block->block_events[ei]);
                    if (isp) {
                        int amt = isp->amount[lx][ly];
                        if (amt > 0) {
                            uint8_t gclass = classify_growth(world, isp->item_type, isp->matindex, isp->item_subtype);
                            uint8_t cr = 0, cg = 0, cb = 0;
                            bool has_rgb = resolve_material_rgb(world, isp->mattype, isp->matindex, cr, cg, cb);
                            ispevs.push_back(IspEv{amt, gclass, (uint8_t)(int)isp->item_type,
                                                     has_rgb, cr, cg, cb});
                        }
                        continue;
                    }
                    STRICT_VIRTUAL_CAST_VAR(gr, df::block_square_event_grassst, block->block_events[ei]);
                    if (gr) {
                        int amt = (int)gr->amount[lx][ly];
                        if (grass_amt < 0) {
                            grass_amt = 0;
                            grass_plant = gr->plant_index;
                        }
                        if (grass_amt == 0 && amt > 0) {
                            grass_amt = amt;
                            grass_plant = gr->plant_index;
                        }
                        continue;
                    }
                    STRICT_VIRTUAL_CAST_VAR(dp, df::block_square_event_designation_priorityst, block->block_events[ei]);
                    if (dp) {
                        // DF stores dig priority as level*1000; ship the LEVEL. The default is
                        // level 4, so the gate must exclude 4000, not merely zero.
                        int p = dp->priority[lx][ly];
                        if (p > 0 && p != 4000) desig_priority = p / 1000;
                    }
                }
                if (!spevs.empty()) {
                    std::sort(spevs.begin(), spevs.end(),
                              [](const SpEv& a, const SpEv& b) { return a.amt > b.amt; });
                    r.spatter_amt = (uint8_t)(spevs[0].amt > 255 ? 255 : spevs[0].amt);
                    size_t cap = spevs.size() > 4 ? 4 : spevs.size();
                    for (size_t si = 0; si < cap; ++si) {
                        // blood-family color extension: resolve a real color for this
                        // spatter's material where possible (see make_spatter_tail's doc).
                        uint8_t cr = 0, cg = 0, cb = 0;
                        bool has_rgb = resolve_material_rgb(world, spevs[si].mt, spevs[si].mi, cr, cg, cb);
                        eb.tails.push_back(make_spatter_tail((uint8_t)idx, spevs[si].mt, spevs[si].mi,
                                                             spevs[si].amt, spevs[si].state,
                                                             has_rgb, cr, cg, cb));
                    }
                    flags2 |= kFlag2Spatter;
                }
                // DESIG_PRIORITY tail, gated to non-default priority per the wire's
                // own scoping rule.
                if (desig_priority > 0) {
                    eb.tails.push_back(make_desig_priority_tail((uint8_t)idx, desig_priority));
                    flags2 |= kFlag2DesigPriority;
                }
                if (!ispevs.empty()) {
                    std::sort(ispevs.begin(), ispevs.end(),
                              [](const IspEv& a, const IspEv& b) { return a.amt > b.amt; });
                    size_t cap = ispevs.size() > 4 ? 4 : ispevs.size();
                    for (size_t si = 0; si < cap; ++si)
                        eb.tails.push_back(make_item_spatter_tail((uint8_t)idx, ispevs[si].growth_class,
                                                                  ispevs[si].item_type, ispevs[si].amt,
                                                                  ispevs[si].has_rgb, ispevs[si].r,
                                                                  ispevs[si].g, ispevs[si].b));
                    flags2 |= kFlag2ItemSpatter;
                }
                // Grass-material tiles keep the amount>=0 tail, including the amount==0 worn-bare
                // signal; other tiles get one only for a positive event on a floor that is OUTSIDE.
                bool is_grass_mat = (tmat == df::tiletype_material::GRASS_LIGHT ||
                                     tmat == df::tiletype_material::GRASS_DARK  ||
                                     tmat == df::tiletype_material::GRASS_DRY   ||
                                     tmat == df::tiletype_material::GRASS_DEAD);
                // PEBBLES and BOULDER are floor-LIKE shapes DF also draws grass coverage on, but
                // they are distinct tiletype_shape values, so a shape==FLOOR gate excludes them.
                bool floor_like = (shp == df::tiletype_shape::FLOOR ||
                                   shp == df::tiletype_shape::PEBBLES ||
                                   shp == df::tiletype_shape::BOULDER);
                bool grass_under_floor = (grass_amt > 0 &&
                                          floor_like &&
                                          des.bits.outside);
                // A shrub, sapling, mushroom or tree does not replace the ground plane: native
                // still resolves the grass event underneath. Deliberately not outside-gated.
                bool grass_under_plant = (grass_amt > 0 && (flags2 & kFlag2Plant) != 0);
                if ((is_grass_mat && grass_amt >= 0) ||
                    (!is_grass_mat && (grass_under_floor || grass_under_plant))) {
                    std::string gpid;
                    df::plant_raw* gpr = df::plant_raw::find(grass_plant);
                    if (gpr) gpid = gpr->id;
                    eb.tails.push_back(make_grass_tail((uint8_t)idx, gpid, (uint8_t)grass_amt));
                    flags2 |= kFlag2Grass;
                }
            }

            // FLOW: the pre-scanned densest flow at this tile, if any.
            if (flow_type_at[idx] >= 0) {
                eb.tails.push_back(make_flow_tail((uint8_t)idx, flow_type_at[idx], flow_density_at[idx]));
                flags2 |= kFlag2Flow;
            }

            // Every engraving hit at this tile is emitted as a SEPARATE tail, not merged
            // server-side, so the client can apply its own combined mask whatever the order.
            if (engraving_hits) {
                for (const EngravingHit& hh : *engraving_hits) {
                    if (hh.tile_idx != idx) continue;
                    eb.tails.push_back(make_engraving_tail((uint8_t)idx, hh.eflags, (int)hh.quality));
                    flags2 |= kFlag2Engraving;
                }
            }

            // VERMIN: every hit at this tile from the pre-fetched block index (same
            // shape as ENGRAVING above -- usually 0, occasionally several vermin on one tile).
            if (vermin_hits) {
                for (const VerminHit& vh : *vermin_hits) {
                    if (vh.tile_idx != idx) continue;
                    // Resolve the race INDEX -> creature token server-side (the wcclient
                    // handoff's blocker) so the client can look up creatures_map directly.
                    std::string vtok;
                    if (vh.race >= 0 && (size_t)vh.race < world->raws.creatures.all.size()) {
                        df::creature_raw* vcr = world->raws.creatures.all[vh.race];
                        if (vcr) vtok = vcr->creature_id;
                    }
                    eb.tails.push_back(make_vermin_tail((uint8_t)idx, vh.race, vh.caste, vh.vflags, vtok));
                    flags2 |= kFlag2Vermin;
                }
            }

            // One planted crop per farm tile, deliberately separate from ITEM: native renders
            // these as crop stages, not as loose inventory sprites.
            if (farm_crop_hits) {
                for (const FarmCropHit& hit : *farm_crop_hits) {
                    if (hit.tile_idx != idx) continue;
                    eb.tails.push_back(make_farm_crop_tail((uint8_t)idx, hit.stage, hit.plant_id));
                    flags2 |= kFlag2FarmCrop;
                    break;
                }
            }

            r.flags2 = flags2;
        }
    }
    return eb;
}

// ---- ITEMDEF_DICT --------------------------------------------------------------------
std::vector<uint8_t> assemble_itemdef_dict(const ItemDefSubcat subcats[kItemDefSubcatCount]) {
    std::vector<uint8_t> o;
    for (size_t sc = 0; sc < kItemDefSubcatCount; ++sc) {
        o.push_back((uint8_t)sc);
        const ItemDefSubcat& v = subcats[sc];
        uint16_t count = (uint16_t)(v.size() > 0xFFFF ? 0xFFFF : v.size());
        put_u16(o, count);
        for (uint16_t i = 0; i < count; ++i) {
            const ItemDefEntry& e = v[i];
            put_u16(o, e.id);
            uint8_t len = (uint8_t)(e.token.size() > 255 ? 255 : e.token.size());
            o.push_back(len);
            o.insert(o.end(), e.token.begin(), e.token.begin() + len);
        }
    }
    return o;
}

// Reads the 14 ITEMDEF_VECTORS in the same order. Caller holds the CoreSuspender, and this is
// meant to run once per world.
void read_itemdef_dict(df::world* world, ItemDefSubcat out[kItemDefSubcatCount]) {
    if (!world) return;
    auto& d = world->raws.itemdefs;
    auto fill = [](ItemDefSubcat& s, const auto& vec) {
        s.clear(); s.reserve(vec.size());
        for (size_t i = 0; i < vec.size(); ++i) {
            if (!vec[i]) continue;
            ItemDefEntry e;
            e.id = (uint16_t)(i > 0xFFFF ? 0xFFFF : i);
            e.token = vec[i]->id;
            s.push_back(std::move(e));
        }
    };
    fill(out[0],  d.weapons);
    fill(out[1],  d.trapcomps);
    fill(out[2],  d.toys);
    // Preserve each tool's raw identity: generated-art selection travels independently in
    // kItemArtGeneratedTool, and replacing this token would hide authored tool art.
    fill(out[3],  d.tools);
    fill(out[4],  d.instruments);
    // Generated instrument ids do not match the eight graphics tokens: native selects the cell
    // from the definition's performance skill plus its building flag.
    for (ItemDefEntry& e : out[4]) {
        if (e.id >= d.instruments.size() || !d.instruments[e.id]) continue;
        df::itemdef_instrumentst* def = d.instruments[e.id];
        const char* family = nullptr;
        switch (def->music_skill) {
            case df::enums::job_skill::PLAY_KEYBOARD_INSTRUMENT:   family = "KEYBOARD"; break;
            case df::enums::job_skill::PLAY_STRINGED_INSTRUMENT:   family = "STRINGED"; break;
            case df::enums::job_skill::PLAY_WIND_INSTRUMENT:       family = "WIND"; break;
            case df::enums::job_skill::PLAY_PERCUSSION_INSTRUMENT: family = "PERCUSSION"; break;
            default: break;
        }
        if (!family) continue;
        bool building = def->flags.is_set(df::enums::instrument_flags::PLACED_AS_BUILDING);
        e.token = std::string("ITEM_INSTRUMENT_") + family +
                  (building ? "_BUILDING" : "_HANDHELD");
    }
    fill(out[5],  d.armor);
    fill(out[6],  d.ammo);
    fill(out[7],  d.siege_ammo);
    fill(out[8],  d.gloves);
    fill(out[9],  d.shoes);
    fill(out[10], d.shields);
    fill(out[11], d.helms);
    fill(out[12], d.pants);
    fill(out[13], d.food);
}

} // namespace wire
} // namespace dwf
