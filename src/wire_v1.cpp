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

// The DF map headers are needed ONLY by encode_block(); the pure codec above it does
// not touch them. Mirrors tile_map_dump.cpp's include set (its emit_tile_fields is the
// field-source contract this encoder ports, minus descent + wallnbr).
#include "DataDefs.h"
#include "TileTypes.h"
#include "modules/Maps.h"
#include "modules/MapCache.h"
// CORPSETEX-B195: Items::getDescription reproduces DF's own in-game item-name generator, the
// authoritative "corpse" vs "skeleton" label the client must follow (see kItemFlagSkeletal).
#include "modules/Items.h"
#include <cctype>
// B47 (constructions render generic stone): baseMaterialAt() returns the tile's NATURAL
// LAYER material (the geolayer stone) for a CONSTRUCTION-material tile, never (-1,-1) -- the
// actual built-from material lives in world.constructions, resolved via
// Constructions::findAtTile (a pure read over the sorted vector).
#include "modules/Constructions.h"
#include "df/construction.h"

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
// Item identity extension: the race-bearing item classes (all int16 `race` as their first
// field, verified against df.item.xml) whose per-species art needs the resolved creature
// token on the wire -- corpse/corpsepiece (item_body_component), vermin-item/pet
// (item_critter), remains, egg, raw-fish.
#include "df/item_body_component.h"
// corpsefix window #12: real CORPSE/CORPSEPIECE items are the DERIVED item_corpsest/
// item_corpsepiecest (both inherit the int16 `race` from item_body_component). The base
// item_body_component is abstract, so strict_virtual_cast (is_direct_instance = exact type)
// NEVER matched it -- corpses shipped no creature ident and drew the generic box. Cast the
// two concrete leaf types instead.
#include "df/item_corpsest.h"
#include "df/item_corpsepiecest.h"
#include "df/item_critter.h"
#include "df/item_remainsst.h"
#include "df/item_eggst.h"
#include "df/item_fish_rawst.h"
#include "df/item_fishst.h"
// Tier-2: cut-gem shape (df::item_smallgemst / item_gemst carry an int32 `shape`) +
// inorganic identity (MaterialInfo.inorganic->id).
#include "df/item_smallgemst.h"
#include "df/item_gemst.h"
#include "df/inorganic_raw.h"
#include "df/creature_raw.h"
#include "df/plant.h"
#include "df/plant_raw.h"
#include "df/plant_growth.h"
#include "df/plant_tree_info.h"                // B83/B103: large-tree body/roots extent
#include "df/plant_tree_tile.h"                // B83/B103: per-tile trunk/branch/leaf bits (u16)
#include "df/plant_root_tile.h"                // B83/B103: per-tile root bits (u8)
#include "df/block_square_event.h"
#include "df/block_square_event_material_spatterst.h"
#include "df/block_square_event_item_spatterst.h"
#include "df/block_square_event_grassst.h"   // WC-17: grass coverage/species event
#include "df/block_square_event_designation_priorityst.h"  // WC-19: designation priority grid
#include "df/flow_info.h"
#include "df/engraving.h"                    // WC-18: world->event.engravings
// WC-21: world->event.vermin / world->event.vermin_colonies are BOTH std::vector<df::vermin*>
// (df.event.xml L222-223 -- "colonies" is a second vector of the SAME struct, not a distinct
// type; `flags.bits.is_colony` is what actually marks a colony instance, verified).
#include "df/vermin.h"

// TX1 CONTAINER_PEEK: Items::getContainedItems walks an item's general_ref_contains_itemst
// refs (the same call interaction.cpp's item sheet already uses) -- pure read, caller holds
// the CoreSuspender.
#include "modules/Items.h"

// blood-family color extension: resolve a material's Solid state_color the SAME way
// world_stream.cpp already does for BUILDINGS_DELTA's `rgb` field (Materials module +
// the 16-slot descriptor-color palette) -- reused here so the SPATTER tail can carry a
// real resolved color instead of forcing the client to guess by a stable hash.
#include "modules/Materials.h"
#include "df/material.h"
#include "df/descriptor_color.h"
#include "df/matter_state.h"

// WC-1 ITEMDEF_DICT: the 14 raw itemdef subcategories (Items.cpp ITEMDEF_VECTORS order).
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

// ---- frame header (§0.2) -----------------------------------------------------------
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

// ---- tile record (§0.3.1) ----------------------------------------------------------
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

TileRecord read_tile_record(const uint8_t in[kTileRecordSize]) {
    TileRecord r;
    r.tt      = get_u16(in);
    r.base_mt = (int16_t)get_u16(in + 2);
    r.base_mi = (int16_t)get_u16(in + 4);
    r.bits    = in[6];
    r.desig1  = in[7];
    r.desig2  = in[8];
    r.spatter_amt = in[9];
    r.flags2  = get_u16(in + 10);
    return r;
}

// ---- BLOCK_SET payload (§0.3) ------------------------------------------------------
std::vector<uint8_t> assemble_block_set(uint32_t world_seq, const EncodedBlock* blocks, size_t n) {
    std::vector<uint8_t> o;
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
        // tail_count is u16 LE (widened from u8, cachefix 2026-07-09). ROOT CAUSE of the
        // invisible-item cluster: a grass-dense block carries up to 256 GRASS tails (one per
        // grassed floor) PLUS its ITEM/SPATTER/etc tails, routinely exceeding 255; the old u8
        // clamp silently truncated every tail past the 255th -- ITEM tails at high tile_idx got
        // dropped SERVER-SIDE, so no client fix could recover bytes that never left. A block has
        // at most 256 tiles x a handful of layered tails, so u16 (65535) is ample headroom.
        uint16_t tail_count = (uint16_t)(b.tails.size() > 65535 ? 65535 : b.tails.size());
        put_u16(o, tail_count);
        for (size_t i = 0; i < kTilesPerBlock; ++i) {
            uint8_t rec[kTileRecordSize];
            write_tile_record(rec, b.records[i]);
            o.insert(o.end(), rec, rec + kTileRecordSize);
        }
        for (size_t ti = 0; ti < tail_count; ++ti) {
            const Tail& t = b.tails[ti];
            o.push_back(t.tile_idx);
            o.push_back(t.kind);
            o.push_back((uint8_t)(t.data.size() > 255 ? 255 : t.data.size()));
            o.insert(o.end(), t.data.begin(), t.data.end());
        }
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

// ---- tail builders (shared) --------------------------------------------------------
// WC-1: appends subtype/iflags/stack AFTER the original 8-byte (item_type, mat_type,
// mat_index) prefix -- an additive extension of the SAME kTailItem (0x01) tail, not a
// new tail kind (§1.1 registry: "0x01 ITEM (W-A base, W-C extends)"). This keeps the
// existing 8-byte prefix byte-for-byte unchanged so an unmodified decoder that only
// reads offsets 0-7 (web/js/dwf-wire-v1.js's decodeTailData, which advances by the
// wire's own length prefix and never asserts len==8) keeps working untouched; a decoder
// that knows about the extension reads the trailing 4 bytes. subtype is int16 (0xFFFF
// sentinel for -1, df.item.xml L492); iflags bit0 web/1 forbid/2 dump/3 melt/4 on_fire
// (spare 5-7); stack is stack_size clamped to u8 (0..255).
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
    // iflags keeps its 5 real flag bits (0x1F); bit5 (kItemFlagHasQuality) is the presence
    // marker for the trailing quality-family block appended at the very end (below); bit6
    // (kItemFlagSkeletal, CORPSETEX-B195) is a state bit consumed in-place by the client
    // resolver -- no trailing block. Both ride ABOVE the 0x1F mask so real flags are untouched.
    t.data.push_back((uint8_t)((iflags & 0x1F)
                               | (has_quality ? kItemFlagHasQuality : 0)
                               | (skeletal ? kItemFlagSkeletal : 0)));
    int st = stack < 0 ? 0 : (stack > 255 ? 255 : stack);
    t.data.push_back((uint8_t)st);
    // Item identity extension (additive, wire_v1.h doc): append the resolved species/race/
    // inorganic token ONLY when one was resolved -- absent identity keeps the tail at 12
    // bytes, so old decoders and old clients are unaffected (they skip by the length prefix).
    if (ident_kind != kItemIdentNone && !ident.empty()) {
        t.data.push_back(ident_kind);
        uint8_t idlen = (uint8_t)(ident.size() > 255 ? 255 : ident.size());
        t.data.push_back(idlen);
        t.data.insert(t.data.end(), ident.begin(), ident.begin() + idlen);
    }
    // Tier-2 gem shape (spec §4): SMALLGEM/GEM items append their cut `shape` (i16) as the
    // LAST two bytes, AFTER the optional identity block. Presence is keyed client-side off
    // the gem item_type + a tail length past the 12-byte body, so the decoder carves these
    // 2 bytes off FIRST and parses identity only in the middle -- no collision with the
    // identity block even when identity is absent (glass gems). shape==-1 (uncut/spawned)
    // round-trips as 0xFFFF. Non-gem items and pre-Tier-2 frames never carry it (additive).
    if (has_shape) put_i16(t.data, shape);
    // ITEM quality family (2026-07-09): fixed 3-byte block [quality|qflags|wear] at the very
    // END, AFTER the identity block and gem-shape. Presence is flagged by iflags bit5 (set
    // above), so the decoder carves these 3 bytes off the tail END FIRST -- unambiguous even
    // for a gem that also carries a shape (carved next) and an identity (parsed in the middle).
    if (has_quality) {
        t.data.push_back((uint8_t)(quality > 5 ? 5 : quality));
        t.data.push_back(qflags);
        t.data.push_back((uint8_t)(wear > 3 ? 3 : wear));
    }
    return t;
}

// Item identity extension: resolve the per-species token an ITEM tail should carry so the
// client can pick real per-species art instead of a generic placeholder box.
//  (1) Creature-derived items (CORPSE/CORPSEPIECE/REMAINS/VERMIN-item/PET/EGG/FISH_RAW/FISH):
//      the item itself stores the creature `race` (all these classes carry an int16 `race`
//      as their first field -- df.item.xml). -> creature_raw::id, kind=creature.
//  (2) Plant-derived items (SEEDS/PLANT/PLANT_GROWTH/DRINK/POWDER milled from plants...):
//      the item's material resolves to a plant via MaterialInfo. -> plant_raw::id, kind=plant.
//  (3) Creature-material items (tallow/leather globs): MaterialInfo.creature -> creature_id,
//      kind=creature (harmless; the client only consumes identity for item types where it
//      helps -- an unused token is simply ignored).
// Returns false (identity omitted) when nothing resolves. Pure read; caller holds the
// CoreSuspender and passes `world` (same convention resolve_material_rgb uses).
static int item_identity_race(df::item* it) {
    // corpsefix window #12: corpses/corpsepieces are the concrete leaf types, not the abstract
    // item_body_component base -- strict_virtual_cast is exact-type, so cast the two leaves.
    // Both inherit the int16 `race` from item_body_component (df.item.xml).
    if (df::item_corpsest*       c = strict_virtual_cast<df::item_corpsest>(it))       return c->race;
    if (df::item_corpsepiecest*  c = strict_virtual_cast<df::item_corpsepiecest>(it))  return c->race;
    if (df::item_critter*        c = strict_virtual_cast<df::item_critter>(it))        return c->race;
    if (df::item_remainsst*      c = strict_virtual_cast<df::item_remainsst>(it))      return c->race;
    if (df::item_eggst*          c = strict_virtual_cast<df::item_eggst>(it))          return c->race;
    if (df::item_fish_rawst*     c = strict_virtual_cast<df::item_fish_rawst>(it))     return c->race;
    // meatfix window #11: prepared FISH (item_fishst) carries the same int16 `race` as
    // item_fish_rawst. Without this cast prepared fish shipped NO creature ident, so the
    // client drew the _missing teal box instead of the per-species fish cell that FISH_RAW
    // of the same species already resolved. Casting it yields identKind=2 (creature) -> the
    // shared resolver picks the right fish sprite. (df/item_fishst.h.)
    if (df::item_fishst*         c = strict_virtual_cast<df::item_fishst>(it))         return c->race;
    return -1;
}
// CORPSETEX-B195 (CORPSETEX_B195_SKELETAL): true iff DF's OWN item name labels this corpse a
// skeleton. The report keys the browser sprite on DF's label ("until it is labeled as a
// skeleton, which the game already does over time"), so we ask DF's native name generator
// (Items::getDescription) rather than guessing a rot_timer / material threshold -- getDescription
// IS the label surface. Only the corpse-derived leaf types can skeletonize; every other item
// returns false without building the string. Substring "skele" covers "skeleton"/"skeletal"/
// "partial skeleton". Pure read; the caller already holds the CoreSuspender.
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
            // Tier-2: inorganic identity (boulders/bars/gems). Ships inorganic_raw.id so the
            // client's mat_index->id map is verifiable/replaceable on modded/generated worlds
            // (spec §4). Same additive ident-block encoding as plant/creature.
            if (mi.inorganic && !mi.inorganic->id.empty()) { kind = kItemIdentInorganic; token = mi.inorganic->id; return true; }
        }
    }
    return false;
}
// TX1 CONTAINER_PEEK (0x0A): the representative FIRST contained item of a BARREL/BIN, so
// the client can composite native's per-category contents-peek overlay cell over the
// container sprite (wire_v1.h's kTailContainerPeek doc). Fixed 11 bytes:
//   item_type i16 | mat_type i16 | mat_index i32 | subtype i16 | cflags u8
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

static Tail make_plant_tail(uint8_t idx, uint8_t part, const std::string& id) {
    Tail t; t.tile_idx = idx; t.kind = kTailPlant;
    t.data.push_back(part);
    uint8_t idlen = (uint8_t)(id.size() > 255 ? 255 : id.size());
    t.data.push_back(idlen);
    t.data.insert(t.data.end(), id.begin(), id.begin() + idlen);
    return t;
}

static Tail make_farm_crop_tail(uint8_t idx, uint8_t stage, const std::string& id) {
    Tail t; t.tile_idx = idx; t.kind = kTailFarmCrop;
    t.data.push_back(stage > 2 ? 2 : stage);
    uint8_t idlen = (uint8_t)(id.size() > 255 ? 255 : id.size());
    t.data.push_back(idlen);
    t.data.insert(t.data.end(), id.begin(), id.begin() + idlen);
    return t;
}
// WC-11: appends `state` (matter_state i16 cast to a single byte, -1 None -> 0xFF) AFTER
// the original 8-byte (mat_type, mat_index, amount) prefix -- the SAME additive-tail
// pattern WC-1 used for the ITEM tail (§1.1 registry: "0x03 SPATTER... W-C extends").
// The shared JS decoder (decodeTailData, unmodified) only reads the original 8 bytes and
// advances by the wire's own length prefix, so it keeps working untouched; a decoder that
// knows about the extension reads the trailing state byte (WC-12 apply).
//
// blood-family color extension (closing a logged WC-12 gap: "creature-range
// materials get a STABLE hash pick among the 5
// blood_families since the wire carries no resolved color for spatter yet -- true hue
// classification needs that wire extension"): appends ANOTHER additive extension AFTER
// the WC-11 state byte -- a `has_rgb u8` flag followed by `r,g,b u8` (present only when
// has_rgb!=0, so the tail stays 10 bytes for materials with no resolved color, same
// "additive, old decoder unaffected" contract as every prior SPATTER extension). Color is
// resolved the SAME way BUILDINGS_DELTA's `rgb` field already is (world_stream.cpp's
// building scan): `MaterialInfo(mat_type, mat_index)`'s Solid state_color index into
// world->raws.descriptors.colors. This lets the client classify a creature blood/ichor/
// goo material by its REAL hue instead of a stable hash pick -- WC-12's own §2.7 apply
// note names this exact gap. Client consumption is wired: spatterFamilyFor()'s
// creature-range branch classifies by the wire rgb (web/js/dwf-tiles.js,
// bloodFamilyFromRgb / itemSpatterTintRgb) and the decoder ships the `rgb` key
// (web/js/dwf-wire-v1.js). The wire half is additive/back-compat, so decoders that
// predate the extension keep working with zero re-golden needed on this field.
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

// blood-family color extension: resolve (mat_type, mat_index)'s Solid state_color to an
// (r,g,b) triple, mirroring world_stream.cpp's BUILDINGS_DELTA `rgb` resolution exactly
// (MaterialInfo -> descriptor_color palette lookup). Returns false (no color) for
// unresolvable pairs (builtin/negative mat_type, out-of-range descriptor index, etc.) --
// callers fall back to omitting the extension bytes entirely. Takes `world` explicitly
// (same pure-function convention classify_growth already uses) rather than reaching for
// df::global::world, since the caller (encode_block) already holds the pointer.
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
// WC-11: item-spatter (fallen leaves/fruit litter). `growth_class` is resolved server-
// side (kGrowth* in wire_v1.h); `item_type` is the raw df::item_type of the spattered
// item (u8 -- every item_type value fits). `amount` is the per-tile int32 amount grid
// value, clamped to u8 (§1.1 "amount clamped u8").
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
// WC-15: block flows (mist/smoke/miasma/dragonfire/...). One entry per tile -- the
// DENSEST flow wins (§WC-15 wire: "keep the densest flow, one entry/tile; DF draws one
// cloud cell"). `density` is the flow_info::density i16 clamped to u8.
static Tail make_flow_tail(uint8_t idx, int flow_type, int density) {
    Tail t; t.tile_idx = idx; t.kind = kTailFlow;
    t.data.push_back((uint8_t)(flow_type & 0xFF));
    int d = density < 0 ? 0 : (density > 255 ? 255 : density);
    t.data.push_back((uint8_t)d);
    return t;
}
// WC-17: grass coverage. DEVIATION from the spec draft's "plant_id u16" entry layout:
// a raw numeric plant_index is USELESS to the client without a dictionary translating it
// back to a species token (world->raws.plants.all's index assignment is not offline-
// reproducible the way ITEMDEF_DICT's static itemdef vectors are, and building a whole
// new PLANT_DICT wire message purely to carry a lookup table is disproportionate scope
// for this item) -- so this carries the resolved TOKEN STRING directly, in the SAME
// `idlen u8 | id bytes` layout the pre-existing PLANT tail (kind 0x02) already uses for
// exactly this purpose (df::plant_raw::find(...)->id), just with a trailing `amount u8`
// appended (additive-tail-growth convention: stable core fields first, extension after).
// `amount` is already a u8 in DF's own grid (block_square_event_grassst::amount is
// uint8_t[16][16], NOT int32 -- verified against df.block.xml directly; the spec draft's
// "int32" claim was stale), so no clamp needed on it.
static Tail make_grass_tail(uint8_t idx, const std::string& plant_id, uint8_t amount) {
    Tail t; t.tile_idx = idx; t.kind = kTailGrass;
    uint8_t idlen = (uint8_t)(plant_id.size() > 255 ? 255 : plant_id.size());
    t.data.push_back(idlen);
    t.data.insert(t.data.end(), plant_id.begin(), plant_id.begin() + idlen);
    t.data.push_back(amount);
    return t;
}
// WC-18: one engraved face/floor record. `eflags` is df::engraving_flags.whole masked to
// the 10 real bits (§1.1 wire table order: floor=0,W=1,E=2,N=3,S=4,hidden=5,NW=6,NE=7,
// SW=8,SE=9 -- this IS the engine's own bitfield layout, verified against
// df/engraving_flags.h, so no remapping is needed). `quality` is df::item_quality (i16),
// clamped to u8 (practical range 0..6 -- Ordinary..Masterpiece).
static Tail make_engraving_tail(uint8_t idx, uint16_t eflags, int quality) {
    Tail t; t.tile_idx = idx; t.kind = kTailEngraving;
    put_u16(t.data, (uint16_t)(eflags & 0x03FF));
    int q = quality < 0 ? 0 : (quality > 255 ? 255 : quality);
    t.data.push_back((uint8_t)q);
    return t;
}
// WC-19: one designation-priority hit. `priority` is the dig priority LEVEL (1-7, §WC-19
// sprite source: designation_priority.png rows 0-6) -- the CALLER converts DF's raw
// block_square_event_designation_priorityst::priority (int32[16][16], stored as level*1000,
// df.block.xml L206-210) to a level and gates out the default (see the encode-block scan);
// the earlier version passed the raw level*1000 here and the u8 clamp destroyed it (every
// tail shipped 255). The u8 clamp below is now harmless (levels are 1-7). Only emitted for
// non-default priority per the wire's own scoping rule (§WC-19 wire).
static Tail make_desig_priority_tail(uint8_t idx, int priority) {
    Tail t; t.tile_idx = idx; t.kind = kTailDesigPriority;
    int p = priority < 0 ? 0 : (priority > 255 ? 255 : priority);
    t.data.push_back((uint8_t)p);
    return t;
}
// WC-21: one vermin/vermin-colony hit. `race`/`caste` are the raw df::vermin fields;
// `vflags` bit0 = is_colony, bit1 = a size-threshold "large swarm" hint (amount>=the
// generator's own SWARM_LARGE cutoff -- calibrated client-side against the art, per
// §WC-21 apply's "colonies/swarms pick SWARM_* by amount" note; the caller passes the
// already-classified bit, this function just packs it).
static Tail make_vermin_tail(uint8_t idx, int race, int caste, uint8_t vflags,
                             const std::string& token = std::string()) {
    Tail t; t.tile_idx = idx; t.kind = kTailVermin;
    put_u16(t.data, (uint16_t)(race < 0 ? 0xFFFF : race));
    t.data.push_back((uint8_t)(caste < 0 ? 0xFF : caste));
    t.data.push_back(vflags);
    // Vermin identity extension (WIRE-TAILS): append the resolved creature token
    // (`idlen u8 | id bytes`) after the 4-byte body, ONLY when resolvable. The `race` field
    // is a raws INDEX not offline-reproducible into a creatures_map key (the wcclient handoff's
    // core blocker), so -- exactly like the ITEM identity extension and the GRASS token -- the
    // server resolves it here (world->raws.creatures.all[race]->creature_id). Absent token keeps
    // the tail at 4 bytes; old decoders skip by length.
    if (!token.empty()) {
        uint8_t idlen = (uint8_t)(token.size() > 255 ? 255 : token.size());
        t.data.push_back(idlen);
        t.data.insert(t.data.end(), token.begin(), token.begin() + idlen);
    }
    return t;
}

// WC-11: classify a PLANT_GROWTH item-spatter's growth into kGrowth* by its raw token
// (world.raws.plants.all[matindex].growths[growth_index].id, e.g. "LEAVES"/"FRUIT1") --
// substring match per §WC-11 wire ("LEAF->1, FRUIT->2 with size from the growth's item
// tile family"; SMALL/LARGE substrings refine size). Non-PLANT_GROWTH item-spatter (rare
// -- DF's only item-spatter events observed are leaf/fruit litter) classifies OTHER.
// Memoized per (mat_index, growth_index) pair (§1.5 "a cheap memo" convention, mirrors
// RFR's isEngravingNew pattern) since the token lookup walks a raws vector.
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

// ---- WC-18: engraving world-vector index -------------------------------------------
// world->event.engravings has no per-block index of its own (unlike block->block_events/
// block->flows, which the SPATTER/ITEM_SPATTER/GRASS/FLOW readers above iterate directly,
// already scoped to the block being encoded) -- §wire_v1.h's engravings_for_block doc
// comment explains why a position-keyed cache is built instead of a per-block linear scan.
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
    uint64_t h = 1469598103934665603ull ^ (uint64_t)hits->size();
    for (const EngravingHit& hh : *hits) {
        uint64_t v = ((uint64_t)hh.tile_idx << 24) | ((uint64_t)hh.eflags << 8) | (uint64_t)hh.quality;
        h ^= v; h *= 1099511628211ull;
    }
    return h;
}

// ---- WC-21: vermin world-vector index -----------------------------------------------
// Exact same shape as the WC-18 engraving index above (world->event.vermin/
// vermin_colonies have no per-block storage of their own, unlike SPATTER/FLOW/GRASS which
// ride block->block_events/block->flows) -- reuses the same "rebuild the whole index only
// when a tracked vector's SIZE changes" memo, now over TWO vectors (a vermin count OR a
// colony count change invalidates the index). "Large swarm" is a fixed, provisionally
// pinned amount threshold (100 -- a starting value, NOT calibrated against the
// SWARM_LARGE art yet; the client apply/generator work that would calibrate it is
// deferred) so the bit is at least present on the wire for whoever lands the
// apply side. `visible` (df::vermin::visible) gates emission -- invisible vermin
// (underground/hidden) never reach the wire, matching §WC-21's own "keep the... visible
// filter" note.
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
        h ^= v; h *= 1099511628211ull;
    }
    return h;
}

// ---- TX4: planted farm crops -------------------------------------------------------
// building_farmplotst only stores the four seasonal crop assignments. The ACTUAL per-tile
// crop is a PERM contained item: item_seedsst while growing (grow_counter/growdur), then an
// item_plantst when ripe. These items have flags.in_building and do not ride map_block::items,
// which is why the ordinary ITEM scan above cannot see them.
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
        h *= 1099511628211ull;
        for (unsigned char c : hit.plant_id) { h ^= c; h *= 1099511628211ull; }
    }
    return h;
}

// ---- deterministic self-test fixture (§WA-8.4) -------------------------------------
// MUST stay byte-identical to tools/harness/gen_wire_fixture.mjs (the golden generator).
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
    // WC-11: tile(9) fallen-leaves/fruit litter (2 ITEM_SPATTER entries, same tile);
    // tile(10) a mist flow (WC-15); tile(11) TWO layered material-spatter events (kept
    // off tile 7/8 deliberately -- the pre-existing WA-12 cache_test.mjs golden-fixture
    // assertions for tiles 7/8 pin single-event spatterMat values; client "merge multiple
    // layered decals" support is WC-12 apply work, not landed yet, so a fresh tile proves
    // the wire's multi-tail-per-tile-idx grammar without touching those assertions).
    { auto& r = A.records[9];  r.tt = 108; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2ItemSpatter; }
    { auto& r = A.records[10]; r.tt = 109; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Flow; }
    { auto& r = A.records[11]; r.tt = 110; r.base_mt = 0; r.base_mi = -1; r.spatter_amt = 255; r.flags2 = kFlag2Spatter; }
    // WC-17: tile(12) a grass-floor tile carrying one GRASS tail (plant_id/amount).
    { auto& r = A.records[12]; r.tt = 111; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Grass; }
    // WC-18: tile(13) TWO layered ENGRAVING records (a north wall face + a south wall
    // face, both engraved) -- proves the client must OR multiple records at one tile_idx
    // into a combined wall-face mask, not just decode the last one.
    { auto& r = A.records[13]; r.tt = 112; r.base_mt = 11; r.base_mi = 12; r.flags2 = kFlag2Engraving; }
    // WC-19: tile(14) a priority-5 dig designation.
    { auto& r = A.records[14]; r.tt = 113; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2DesigPriority; }
    // WC-21: tile(15) TWO layered VERMIN hits (a lone vermin + a colony) -- proves the
    // client must handle >=1 hit per tile, same multi-record convention as ENGRAVING.
    { auto& r = A.records[15]; r.tt = 114; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Vermin; }
    // WIRE-TAILS: tile(16) a plant-identity item (a SEEDS item whose ITEM tail carries the
    // plant species token "OAK") and tile(17) a creature-identity item (a CORPSE carrying the
    // race token "DWARF") -- fresh tiles proving the additive ITEM-tail identity extension
    // WITHOUT disturbing the ident-less items 5/8/B10 (which stay 12 bytes, proving the
    // extension is optional/back-compatible). Kept as new tiles per the same "fresh tile
    // proves the grammar, pinned tiles untouched" convention WC-11/WC-17/WC-21 established.
    { auto& r = A.records[16]; r.tt = 115; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[17]; r.tt = 116; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    // TIER-2 (asset/material-parity §4): three fresh item tiles proving the two additive
    // ITEM-tail extensions -- inorganic identity (ident_kind 3) and cut-gem `shape`.
    //   tile(18) SMALLGEM  : inorganic ident "GREEN_ZIRCON" + shape 7 (ident AND shape both).
    //   tile(19) GEM (large): NO ident (a glass gem) + shape -1 (shape-only; the ambiguity
    //                         case -- 0xFFFF sits where an ident_kind byte would; the decoder
    //                         carves shape off the tail END first, so identity stays absent).
    //   tile(20) ROUGH gem : inorganic ident "MICROCLINE", NO shape (ROUGH carries no shape
    //                        field -- inorganic ident on a non-shape item).
    { auto& r = A.records[18]; r.tt = 117; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[19]; r.tt = 118; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[20]; r.tt = 119; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    // ITEM QUALITY FAMILY (2026-07-09): fresh item tiles proving the additive quality block.
    //   tile(21) q3 fine, no artifact, no wear;  tile(22) q5 masterwork;
    //   tile(23) q5 + ARTIFACT flag;             tile(24) q0 but wear 1 (proves quality==0 with
    //                                            a block present -- the "base q0" matrix row);
    //   tile(25) q4 + wear 3 (worn, second wear level);
    //   tile(26) SMALLGEM combining inorganic IDENT + gem SHAPE + QUALITY(+artifact) on ONE tail
    //            (the end-carve stress case: quality carved off the end, then shape, then ident
    //            in the middle).
    { auto& r = A.records[21]; r.tt = 120; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[22]; r.tt = 121; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[23]; r.tt = 122; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[24]; r.tt = 123; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[25]; r.tt = 124; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    { auto& r = A.records[26]; r.tt = 125; r.base_mt = 0; r.base_mi = -1; r.flags2 = kFlag2Item; }
    // TX1 CONTAINER_PEEK: three fresh container tiles proving the new 0x0A tail kind
    // (ITEM tail + CONTAINER_PEEK tail on the SAME tile_idx -- the multi-tail-per-tile
    // grammar every multi-kind tile already uses). item_type ordinals are the REAL
    // df::item_type values (BARREL=17, BIN=32; contents MEAT=48, PLANT=54, BAR=0) --
    // load-bearing for the client classifier, verified against df/item_type.h.
    //   tile(27) wood BARREL + MEAT content (creature mat 19)      -> ITEM_BARREL_TOP_MEAT
    //   tile(28) wood BARREL + PLANT content, cflags bit0 SET      -> ..._PLANT_SUBTERRANEAN
    //   tile(29) BIN + BAR content, mat_type 7 (builtin COAL)      -> ITEM_BIN_TOP_COAL
    { auto& r = A.records[27]; r.tt = 126; r.base_mt = 0; r.base_mi = -1; r.flags2 = (uint16_t)(kFlag2Item | kFlag2ContainerPeek); }
    { auto& r = A.records[28]; r.tt = 127; r.base_mt = 0; r.base_mi = -1; r.flags2 = (uint16_t)(kFlag2Item | kFlag2ContainerPeek); }
    { auto& r = A.records[29]; r.tt = 128; r.base_mt = 0; r.base_mi = -1; r.flags2 = (uint16_t)(kFlag2Item | kFlag2ContainerPeek); }
    // WC-1: item(5) exercises a normal subtype + a 3-bit iflags combo + a plain stack;
    // item(8) exercises the subtype==-1 sentinel + a single iflags bit + a stack>255 clamp.
    A.tails.push_back(make_item_tail(5, 12, 34, 5678, 42,
                                      kItemFlagWeb | kItemFlagDump | kItemFlagOnFire, 5));
    A.tails.push_back(make_plant_tail(6, kPartTrunk, "OAK"));
    // WC-11: tile(7)'s spatter now carries a mat_state byte (Liquid) -- amount/mat_type
    // unchanged from the pre-WC-11 fixture (cache_test.mjs pins amount==5000/mat_type==9).
    A.tails.push_back(make_spatter_tail(7, 9, 10, 5000, 1 /*Liquid*/));
    A.tails.push_back(make_item_tail(8, 1, 2, 3, -1, kItemFlagForbid, 999));
    A.tails.push_back(make_plant_tail(8, kPartShrub, ""));
    // WC-11: tile(8)'s spatter now exercises the matter_state==-1 (None) sentinel byte
    // (encoded 0xFF), on top of the pre-existing amount>65535 clamp.
    A.tails.push_back(make_spatter_tail(8, 13, 14, 65535, -1 /*None sentinel*/));
    // WC-11: tile(9) two ITEM_SPATTER entries -- LEAVES then FRUIT_LARGE. The item_type
    // byte is a synthetic test value (56, matching PLANT_GROWTH's ordinal at the time of
    // writing -- NOT load-bearing here; encode_block's real read uses the true runtime
    // enum, this fixture only proves the byte layout round-trips).
    A.tails.push_back(make_item_spatter_tail(9, kGrowthLeaves, 56, 60));
    A.tails.push_back(make_item_spatter_tail(9, kGrowthFruitLarge, 56, 12));
    // WC-15: tile(10) a dense waterfall mist (flow_type=2 Mist).
    A.tails.push_back(make_flow_tail(10, 2 /*Mist*/, 180));
    // WC-11: tile(11) TWO layered material-spatter events -- Solid then Paste. The SECOND
    // event also exercises the blood-family color extension's has_rgb/(r,g,b) bytes (a
    // synthetic resolved color here -- encode_block's real call site resolves this from
    // MaterialInfo via resolve_material_rgb).
    A.tails.push_back(make_spatter_tail(11, 30, 31, 4000, 0 /*Solid*/));
    A.tails.push_back(make_spatter_tail(11, 40, 41, 1500, 4 /*Paste*/,
                                         /*has_rgb=*/true, 180, 20, 20 /*resolved blood-red*/));
    // WC-17: tile(12) grass coverage -- token "MEADOW-GRASS" (a real vanilla grass raw
    // id, plant_grasses.txt), amount=45 (falls in the PARTIAL_2/GRASS_2 tier per §WC-17
    // apply thresholds).
    A.tails.push_back(make_grass_tail(12, "MEADOW-GRASS", 45));
    // WC-18: tile(13) two ENGRAVING records -- north wall face (eflags bit3=0x0008,
    // quality=3 Fine) then south wall face (bit4=0x0010, quality=5 Masterpiece). The
    // client OR-combines eflags across all records at one tile to get the combined
    // ENGRAVED_STONE_WALL_N_S mask and takes the max quality (5) for hover.
    A.tails.push_back(make_engraving_tail(13, 0x0008 /*north*/, 3));
    A.tails.push_back(make_engraving_tail(13, 0x0010 /*south*/, 5));
    // WC-19: tile(14) priority 5.
    A.tails.push_back(make_desig_priority_tail(14, 5));
    // WC-21: tile(15) a lone vermin (race 200, caste 0, not a colony) then a colony hit
    // (race 210, caste 1, is_colony + large-swarm bits both set).
    // Vermin identity extension: lone vermin (race 200) carries token "HONEY_BEE"; the
    // colony (race 210) carries "ANT" -- proving the resolved-token extension round-trips.
    A.tails.push_back(make_vermin_tail(15, 200, 0, 0, "HONEY_BEE"));
    A.tails.push_back(make_vermin_tail(15, 210, 1, kVerminFlagColony | kVerminFlagSwarmLarge, "ANT"));
    // WIRE-TAILS: tile(16) SEEDS item (type 40 synthetic) carrying a PLANT identity token
    // "OAK"; tile(17) CORPSE item (type 41 synthetic) carrying a CREATURE identity token
    // "DWARF". The item_type bytes are synthetic (like the ITEM_SPATTER fixture's) -- not
    // load-bearing; encode_block's real reads use the true runtime enum + resolve_item_identity.
    A.tails.push_back(make_item_tail(16, 40, 0, 0, -1, 0, 3, kItemIdentPlant, "OAK"));
    A.tails.push_back(make_item_tail(17, 41, 0, 0, -1, 0, 1, kItemIdentCreature, "DWARF"));
    // TIER-2: item_type bytes here are the REAL df::item_type ordinals the decoder keys gem
    // shape off (SMALLGEM=1, GEM=44, ROUGH=3), so they ARE load-bearing (unlike the synthetic
    // bytes above). tile(18) ident+shape; tile(19) shape-only spawned (-1) glass gem;
    // tile(20) inorganic ident, no shape.
    A.tails.push_back(make_item_tail(18, /*SMALLGEM*/1, 0, 97, -1, 0, 1,
                                      kItemIdentInorganic, "GREEN_ZIRCON", /*has_shape*/true, 7));
    A.tails.push_back(make_item_tail(19, /*GEM*/44, 3 /*GLASS_GREEN*/, 0, -1, 0, 1,
                                      kItemIdentNone, std::string(), /*has_shape*/true, -1));
    A.tails.push_back(make_item_tail(20, /*ROUGH*/3, 0, 100, -1, 0, 1,
                                      kItemIdentInorganic, "MICROCLINE"));
    // ITEM QUALITY FAMILY tails (make_item_tail's has_quality/quality/qflags/wear params).
    // tile(21) q3; tile(22) q5; tile(23) q5+artifact; tile(24) q0 wear1; tile(25) q4 wear3;
    // tile(26) SMALLGEM inorganic ident "RUBY" + shape 3 + q5 + artifact (all extensions on one).
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
    // TX1 CONTAINER_PEEK tails (see the tile 27-29 comment above).
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
    // WC-1: all-negative mats + subtype -1 + zero iflags + a negative stack (clamps to 0).
    B.tails.push_back(make_item_tail(10, -1, -1, -1, -1, 0, -5));

    // BLOCK C -- tail_count u16 regression proof (cachefix 2026-07-09). A grass-dense block
    // carrying 256 GRASS tails (one per tile) PLUS 4 ITEM tails at HIGH tile_idx (250-253) =
    // 260 tails. Under the OLD u8 clamp only the first 255 tails survived -- grass[255] and ALL
    // FOUR items were truncated off the wire server-side (exactly the invisible-item cluster:
    // the items sit past position 255). With the u16 count all 260 ride, proving the class is
    // dead. The items carry unique mat_index (700+k) so the decoder can confirm each survived.
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

// ---- DF-reading encoder (§0.3.1) ---------------------------------------------------
// Raw per-z port of emit_tile_fields' reads: NO see-down descent, NO wallnbr, NO enum
// strings (client resolves via §0.7 meta). Caller holds the CoreSuspender.
EncodedBlock encode_block(df::world* world, MapExtras::MapCache& MC, df::map_block* block,
                          int bx, int by, int bz, uint32_t ver) {
    EncodedBlock eb;
    eb.bx = (uint16_t)bx; eb.by = (uint16_t)by; eb.bz = (uint16_t)bz;
    eb.ver = ver; eb.bflags = 0;

    // Null/unrevealed/off-map block: all-void records, no tails (§0.3.1).
    if (!block) return eb;

    const int base_tx = bx * 16, base_ty = by * 16;

    // WC-15: pre-scan block->flows ONCE (per-block vector, usually empty -- §1.5 budget)
    // into a per-tile "densest flow wins" table (§WC-15 wire: "keep the densest flow, one
    // entry/tile"). flow_info::pos is a world coord; NONE-typed entries (defensive) and
    // any flow outside this block's 16x16 (defensive -- flows are block-owned in
    // practice) are skipped.
    // B139: DEAD and density<=0 flows are skipped too. DF RETAINS expired flow_info
    // records in block->flows (flags.DEAD=1, density decayed to <=0) and re-uses the
    // slots for later spawns, so without this gate a tile whose miasma just died kept
    // emitting a zombie density-0 tail forever -- and worse, a tile whose slot was still
    // dead at encode time shipped density 0 while the oracle showed a LIVE flow (seen
    // live 2026-07-10: 19 flow tails all density=0 over a refuse pile with live densities
    // 5..25; block_signature() couldn't see the dead->alive flip, see world_stream.cpp).
    int8_t  flow_type_at[kTilesPerBlock];
    uint8_t flow_density_at[kTilesPerBlock];
    std::fill(std::begin(flow_type_at), std::end(flow_type_at), (int8_t)-1);
    std::fill(std::begin(flow_density_at), std::end(flow_density_at), (uint8_t)0);
    for (size_t fi = 0; fi < block->flows.size(); ++fi) {
        df::flow_info* fl = block->flows[fi];
        if (!fl || (int)fl->type < 0) continue;
        if (fl->flags.bits.DEAD || fl->density <= 0) continue;   // B139: zombie slots
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

    // ---- B269 MINING INDICATORS (damp / warm stone) -----------------------------------------
    // DF cancels a dig with "Damp stone located." / "Warm stone located." (announcement enum
    // DIG_CANCEL_DAMP/DIG_CANCEL_WARM, src/announce_taxonomy.gen.h:134-135) and paints
    // DAMP_STONE_WARNING / WARM_STONE_WARNING on the tile in mining mode. It stores no per-tile
    // marker for this -- there is no such bit anywhere in df-structures -- so the overlay is
    // DERIVED from map state each frame, which is why it survives the designation being cleared.
    //
    // We evaluate DFHack's own replication of DF's rule (dfhack/plugins/dig.cpp):
    //   is_wet(x,y,z) := (liquid_type==Water && flow_size>=1) || is_aquifer(x,y,z)   [dig.cpp:291]
    //   is_aquifer    := designation.water_table && a ROUGH (non-smooth) WALL tiletype [dig.cpp:262]
    //   is_damp(pos)  := is_wet over the 8 HORIZONTAL neighbours at z + the tile at z+1 [dig.cpp:302]
    //   is_warm(pos)  := block->temperature_1[x&15][y&15] >= 10075  (the tile ITSELF)   [dig.cpp:235]
    // The client cannot do this: it never receives z+1 (see-down only descends) and neither the
    // water_table bit nor tile temperature was ever on the wire.
    //
    // PERF (AGENTS.md hard rule 5 -- CoreSuspender starves the sim): the naive form is 9
    // Maps::getTileDesignation() calls per tile = 2304 block-hash lookups per block. Instead we
    // build the wet mask ONCE per block: an 18x18 grid covering this block plus its 1-tile border,
    // plus a 16x16 grid for z+1. That is 324+256 = 580 lookups per block regardless of tile count,
    // and per-tile damp is then 9 array reads. Only WALL tiles are ever asked (a floor cannot be
    // mined, so DF never warns about one), and the whole precompute is skipped for a block with no
    // walls at all.
    bool block_has_wall = false;
    for (int wy = 0; wy < 16 && !block_has_wall; ++wy)
        for (int wx = 0; wx < 16; ++wx)
            if (tileShape(block->tiletype[wx][wy]) == df::tiletype_shape::WALL) { block_has_wall = true; break; }

    // wet_here[(ly+1)*18 + (lx+1)] for lx,ly in [-1..16]; wet_above[ly*16+lx] for the z+1 tile.
    // Zero-initialized so a wall-less block (which skips the fill) can never be read stale, and so
    // no compiler can flag a may-be-uninitialized path.
    bool wet_here[18 * 18] = { false };
    bool wet_above[16 * 16] = { false };
    if (block_has_wall) {
        auto tile_is_wet = [](int wx, int wy, int wz) -> bool {
            df::tile_designation* d = DFHack::Maps::getTileDesignation(wx, wy, wz);
            if (!d) return false;
            if (d->bits.flow_size >= 1 && d->bits.liquid_type == df::enums::tile_liquid::Water)
                return true;
            if (!d->bits.water_table) return false;            // aquifer bit (dig.cpp is_aquifer)
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

    // WC-18: ONE index lookup for the whole block (not per-tile -- engravings_for_block's
    // hash lookup by (bx,by,bz) returns the same small vector for all 256 tiles here).
    const std::vector<EngravingHit>* engraving_hits = engravings_for_block(world, bx, by, bz);
    // WC-21: same one-lookup-per-block pattern for vermin/vermin-colonies.
    const std::vector<VerminHit>* vermin_hits = vermin_for_block(world, bx, by, bz);
    // TX4: building-owned planted crops, indexed once per stream tick.
    const std::vector<FarmCropHit>* farm_crop_hits = farm_crops_for_block(bx, by, bz);

    // BLACK-GLYPHS/B204: is EVERY tile in this block hidden? Such a block only reaches encode_block
    // when world_stream's block_shippable let it through because it carries a live designation the
    // player must see over the black (B133's render half). For those blocks we ship ONLY the
    // designation -- each tile emits a VOID tiletype (no real tiletype/base material, no sparse
    // tails), so fog-of-war leaks nothing beyond what the player already designated. Discovered
    // blocks (>=1 visible tile) are untouched: the whole normal per-tile emission runs, byte-for-
    // byte as before (golden fixtures unaffected -- they are all discovered blocks).
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

            // base material (MapCache), -1 when unavailable (§0.3.1).
            int base_mt = -1, base_mi = -1;
            MapExtras::Block* mcb = MC.BlockAtTile(df::coord(tx, ty, bz));
            if (mcb) {
                t_matpair bm = mcb->baseMaterialAt(df::coord2d(lx, ly));
                base_mt = bm.mat_type; base_mi = bm.mat_index;
            }
            // B47 ("constructions show as generic stone, not the construction material"):
            // baseMaterialAt() resolves the tile's NATURAL layer material -- for a
            // CONSTRUCTION-material tiletype it returns the GEOLAYER stone under the
            // construction, NOT (-1,-1). So the old `&& base_mt < 0` guard NEVER fired and
            // every constructed wall/floor shipped the geolayer stone instead of the
            // built-from material. The built-from material lives in the construction record
            // itself (world.constructions, mat_type/mat_index of the component item), so the
            // findAtTile override must win UNCONDITIONALLY for CONSTRUCTION tiles.
            // Constructions::findAtTile is a pure read (binary search over the sorted
            // vector, no map/tile writes -- crash-safe under the same CoreSuspender this
            // whole scan already holds). Only fires for CONSTRUCTION tiles, so natural
            // terrain wire bytes are unchanged (no re-golden needed for non-construction
            // fixtures; the golden fort has no constructions on captured cameras --
            // verify wire-selftest after deploy regardless).
            if (tmat == df::tiletype_material::CONSTRUCTION) {
                if (df::construction* con = DFHack::Constructions::findAtTile(df::coord(tx, ty, bz))) {
                    base_mt = con->mat_type; base_mi = con->mat_index;
                }
            }
            r.base_mt = (int16_t)base_mt;
            r.base_mi = (int16_t)base_mi;

            // designation bytes (dig/smooth/marker; traffic/track) -- emitter parity.
            {
                int dig     = (int)des.bits.dig;
                int smooth  = (int)des.bits.smooth;
                int marker  = occ.bits.dig_marked ? 1 : 0;
                int traffic = (int)des.bits.traffic;
                int track = 0;
                if (occ.bits.carve_track_north) track |= 1;
                if (occ.bits.carve_track_south) track |= 2;
                if (occ.bits.carve_track_east)  track |= 4;
                if (occ.bits.carve_track_west)  track |= 8;
                r.desig1 = pack_desig1(dig, smooth, marker);
                r.desig2 = pack_desig2(traffic, track);
            }

            // BLACK-GLYPHS/B204: fully-hidden shippable block -> ship the designation ONLY. Void the
            // tiletype + base material + liquid/flow/hidden bits and emit no sparse tails, so an
            // undiscovered tile crosses the wire carrying nothing but its designation. The client's
            // decodeTile reconstitutes a {tt:-1, hidden:1, desig} tile from the surviving desig bytes
            // and both renderers draw the glyph over black. Undesignated tiles here have desig1==
            // desig2==0, so they stay pure-void (pure black) on the client -- identical to never
            // shipping them, but now the block as a whole can carry its designated tiles.
            if (block_fully_hidden) {
                r.tt = 0xFFFF; r.base_mt = -1; r.base_mi = -1;
                r.bits = 0; r.spatter_amt = 0; r.flags2 = 0;
                continue;   // skip all sparse-tail scans for an undiscovered tile
            }

            uint16_t flags2 = 0;

            // B269: damp/warm mining indicators. WALL tiles only (nothing else is mineable, so DF
            // never warns about one) and revealed tiles only -- an undiscovered tile must not
            // advertise the water behind it (the client also re-gates on `hidden`, but not shipping
            // the bit at all is the honest fog-of-war answer). See the precompute above for the
            // DFHack citations and the perf shape.
            if (block_has_wall && shp == df::tiletype_shape::WALL && !des.bits.hidden) {
                const int gx = lx + 1, gy = ly + 1;   // wet_here is the 18x18 bordered grid
                bool damp = wet_here[(gy - 1) * 18 + (gx - 1)] || wet_here[(gy - 1) * 18 + gx]
                         || wet_here[(gy - 1) * 18 + (gx + 1)] || wet_here[gy * 18 + (gx - 1)]
                         || wet_here[gy * 18 + (gx + 1)]       || wet_here[(gy + 1) * 18 + (gx - 1)]
                         || wet_here[(gy + 1) * 18 + gx]       || wet_here[(gy + 1) * 18 + (gx + 1)]
                         || wet_above[ly * 16 + lx];
                if (damp) flags2 |= kFlag2Damp;
                // is_warm: the tile's OWN current temperature (dig.cpp:235), not a neighbourhood --
                // that is what lets DF warn about magma you cannot see yet.
                if (block->temperature_1[lx][ly] >= 10075) flags2 |= kFlag2Warm;
            }

            // ITEM tail: topmost item on this tile (same 512-cap scan as the emitter).
            // WC-1: items with the `hidden` flag (INTERFACE_INVISIBLE, df.item.xml L416)
            // are skipped from candidacy -- DF never draws them -- so the topmost VISIBLE
            // item still wins (last-match-wins semantics unchanged for the rest).
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
                    // WC-1: subtype (0xFFFF sentinel handled by put_i16 casting through
                    // int16_t), iflags (web/forbid/dump/melt/on_fire), stack_size via
                    // item_actual (RFR item_reader.cpp:435-439 pattern; 1 when not
                    // item_actual-derived -- practically never for concrete DF items).
                    int subtype = (int)top->getSubtype();
                    uint8_t iflags = 0;
                    if (top->flags.bits.spider_web) iflags |= kItemFlagWeb;
                    if (top->flags.bits.forbid)     iflags |= kItemFlagForbid;
                    if (top->flags.bits.dump)       iflags |= kItemFlagDump;
                    if (top->flags.bits.melt)       iflags |= kItemFlagMelt;
                    if (top->flags.bits.on_fire)    iflags |= kItemFlagOnFire;
                    VIRTUAL_CAST_VAR(actual, df::item_actual, top);
                    int stack = actual ? actual->stack_size : 1;
                    int mt = (int)top->getMaterial(), mi_ = (int)top->getMaterialIndex();
                    // Item identity extension: resolve per-species token (plant seeds/growths,
                    // creature corpses/vermin-items) so the client draws real art, not a box.
                    uint8_t ident_kind = kItemIdentNone; std::string ident;
                    resolve_item_identity(world, top, mt, mi_, ident_kind, ident);
                    // Tier-2: cut-gem shape -> per-cut art on the client. Only SMALLGEM/GEM
                    // items carry a `shape` field (df::item_smallgemst / item_gemst); -1 =
                    // uncut/spawned. Non-gem items ship no shape (has_shape stays false).
                    bool has_shape = false; int gem_shape = -1;
                    if (df::item_smallgemst* sg = strict_virtual_cast<df::item_smallgemst>(top)) {
                        gem_shape = sg->shape; has_shape = true;
                    } else if (df::item_gemst* lg = strict_virtual_cast<df::item_gemst>(top)) {
                        gem_shape = lg->shape; has_shape = true;
                    }
                    // ITEM QUALITY FAMILY (2026-07-09): quality (0-5 via getQuality()),
                    // artifact (flags.bits.artifact), wear (0-3 via item_actual::wear, reusing
                    // the `actual` cast made above for stack_size). Emit the trailing block ONLY
                    // when there is something to say -- a plain q0/undamaged/non-artifact item
                    // stays byte-identical to the pre-quality 12-byte tail (additive/optional).
                    int qv = (int)top->getQuality();
                    uint8_t quality = (uint8_t)(qv < 0 ? 0 : (qv > 5 ? 5 : qv));
                    uint8_t qflags = top->flags.bits.artifact ? kItemQFlagArtifact : 0;
                    int wv = actual ? actual->wear : 0;
                    uint8_t wear = (uint8_t)(wv < 0 ? 0 : (wv > 3 ? 3 : wv));
                    bool has_quality = (quality > 0 || qflags != 0 || wear > 0);
                    // CORPSETEX-B195: follow DF's OWN corpse->skeleton label so the client draws
                    // body art for a fresh corpse and switches to skeletal art only when the game
                    // itself names it a skeleton. False (the default) keeps the tail byte-identical.
                    bool skeletal = item_is_skeletal(top);
                    eb.tails.push_back(make_item_tail((uint8_t)idx, (int)top->getType(),
                                                      mt, mi_, subtype, iflags, stack,
                                                      ident_kind, ident, has_shape, gem_shape,
                                                      has_quality, quality, qflags, wear, skeletal));
                    flags2 |= kFlag2Item;
                    // TX1 CONTAINER_PEEK: a BARREL/BIN with contents renders those contents
                    // poking out of its open top in native (per-category ITEM_BARREL_TOP_* /
                    // ITEM_BIN_TOP_* overlay cells -- kTailContainerPeek doc in wire_v1.h).
                    // Ship the representative FIRST contained item's identity; the client
                    // classifies the category token. Empty container -> no tail -> no peek.
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
                            // Subterranean-crop flag (plump helmets & co pick the dedicated
                            // ITEM_BARREL_TOP_PLANT_SUBTERRANEAN cell): plant_raw's
                            // underground_depth_min > 0 -- surface crops are 0:0.
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

            // PLANT tail: part from shape/material, id from the exact world plant. A map
            // column spans every z-level at this x/y; matching only x/y can select a different
            // plant above or below the rendered tile, producing B90's apparently random plant
            // swaps. Keep the z match in lockstep with tile_map_dump.cpp's legacy emitter.
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
                    int colx = (tx / 48) * 3, coly = (ty / 48) * 3;
                    if (world->map.column_index && colx >= 0 && coly >= 0
                        && colx < world->map.x_count_block && coly < world->map.y_count_block) {
                        df::map_block_column* col = world->map.column_index[colx][coly];
                        if (col) {
                            const size_t PLANT_CAP = 4096;
                            // B83/B103: a large tree's trunk/branch/canopy/leaf tiles sit ABOVE
                            // and AROUND the plant's single root pos (col->plants stores only
                            // pos, the base of the trunk). The pre-fix exact-pos match therefore
                            // resolved ONLY the base tile; every other tree-body tile shipped an
                            // empty species id and fell to tree_map._default on the client --
                            // willow trunks read as a foreign species (B83), upper canopies read
                            // as mushrooms/wrong bark (B103). Resolve body/root tiles through the
                            // owning plant's tree_info extent, mapped to world coords EXACTLY as
                            // DFHack's own plant.cpp (x_NW = pos.x - dim_x/2, body[z] where
                            // z = bz - pos.z, present iff (whole & 0x7F) && !blocked) and
                            // RemoteFortressReader do. Exact-pos still wins (preserves B90's
                            // exact-z identity for the base tile, saplings, and shrubs -- which
                            // have no tree_info at all); the body scan is the fallback for tiles
                            // that never match a root pos.
                            df::plant* body_match = nullptr;
                            for (size_t pi = 0; pi < col->plants.size() && pi < PLANT_CAP; ++pi) {
                                df::plant* pl = col->plants[pi];
                                if (!pl) continue;
                                if (pl->pos.x == tx && pl->pos.y == ty && pl->pos.z == bz) {
                                    df::plant_raw* pr = df::plant_raw::find(pl->material);
                                    if (pr) pid = pr->id;
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
                            }
                        }
                    }
                    eb.tails.push_back(make_plant_tail((uint8_t)idx, (uint8_t)part, pid));
                    flags2 |= kFlag2Plant;
                }
            }

            // SPATTER + ITEM_SPATTER (WC-11): ALL events at this tile (not first-only),
            // ordered by amount desc, capped at 4 (DF layers several observed decals --
            // §WC-11 wire "4 covers observed stacks"). Material spatter's mat_state rides
            // along (blood/mud/snow/paste read differently). Item-spatter (fallen leaves/
            // fruit litter) resolves growth_class at emission via classify_growth's memo.
            {
                struct SpEv { int amt; int16_t mt; int32_t mi; int8_t state; };
                struct IspEv { int amt; uint8_t growth_class; uint8_t item_type; bool has_rgb; uint8_t r, g, b; };
                std::vector<SpEv> spevs;
                std::vector<IspEv> ispevs;
                // WC-17: grass coverage -- max-amount-wins per tile (RFR's own rule for this
                // event type, rfr:1307-1314), only tracked here (not pushed) so it can be
                // gated below by "is this tile actually a grass-material tile" before adding
                // a tail (§WC-17 wire: "only for tiles whose tiletype material is GRASS_*").
                int grass_amt = -1; int32_t grass_plant = -1;
                // WC-19: designation-priority grid, same "track then gate" pattern as grass
                // above -- only emitted for non-default (non-zero) priority (§WC-19 wire).
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
                        if (amt > grass_amt) { grass_amt = amt; grass_plant = gr->plant_index; }
                        continue;
                    }
                    STRICT_VIRTUAL_CAST_VAR(dp, df::block_square_event_designation_priorityst, block->block_events[ei]);
                    if (dp) {
                        // WC-19 encode fix: DF stores dig priority as level*1000 (our own
                        // placement.cpp writes clamp(priority,1,7)*1000). Ship the LEVEL (1..7)
                        // -- the old code shipped the raw level*1000, which the u8 clamp in
                        // make_desig_priority_tail saturated to 255 on every live tail (badge
                        // feature inert on the wire). Gate to genuinely non-default priority:
                        // DF's default is level 4 (4000), so the old `p > 0` gate also fired
                        // for every default-priority tile, contradicting the wire's own
                        // "non-default only" scoping. (§WC-19 wire; ledger 2026-07-07.)
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
                // WC-19: DESIG_PRIORITY tail, gated to non-default priority per the wire's
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
                // WC-17: GRASS tail. Originally gated to grass-material tiles only, on the
                // ASSUMPTION that "DF only draws grass texture on the 4 GRASS_LIGHT/DARK/
                // DRY/DEAD tiletype_material variants" -- DISPROVED 2026-07-07 by the
                // grass-escalation's raw-oracle ground truth (the "phantom stone" report):
                // DF's own render draws grass coverage OVER non-grass surface floors too
                // (StonePebbles* STONE floors render as sparse pebble clusters on grass;
                // SoilFloor* SOIL floors render as grass), so the old gate made the client
                // draw bare dense gravel / bare dirt where the native window shows lawn.
                // Widened rule: grass-material tiles keep the original amount>=0 tail
                // (including the amount==0 "worn bare" signal); OTHER tiles get a tail only
                // when a real positive-amount grass event covers a FLOOR that is OUTSIDE
                // (keeps stale/edge-case events in dug-out interior rooms from grassifying
                // them; cavern moss is grass-material and therefore unaffected). The client
                // whitelists which non-grass ttnames it actually composites grass under
                // (SoilFloor*/StonePebbles*), so an unknown-shaped tail is simply ignored.
                bool is_grass_mat = (tmat == df::tiletype_material::GRASS_LIGHT ||
                                     tmat == df::tiletype_material::GRASS_DARK  ||
                                     tmat == df::tiletype_material::GRASS_DRY   ||
                                     tmat == df::tiletype_material::GRASS_DEAD);
                // B241: PEBBLES and BOULDER are floor-LIKE shapes that DF also draws grass
                // coverage on (the B241 native oracle shows a boulder sitting directly on
                // grass; StonePebbles*'s grass composite was the B37/B92 oracle evidence) --
                // but they are distinct df::tiletype_shape values, so the original
                // shape==FLOOR gate silently excluded them and the client could never know
                // whether grass covers a pebble/boulder tile. The client backs boulders with
                // this tail (dwf-*'s groundBackingCell) and composites grass under
                // pebbles (the B92 arm) once it arrives; until this DLL ships, it falls back
                // to ring-1 borrowed grass / dense pebble art.
                bool floor_like = (shp == df::tiletype_shape::FLOOR ||
                                   shp == df::tiletype_shape::PEBBLES ||
                                   shp == df::tiletype_shape::BOULDER);
                bool grass_under_floor = (grass_amt > 0 &&
                                          floor_like &&
                                          des.bits.outside);
                if ((is_grass_mat && grass_amt >= 0) || (!is_grass_mat && grass_under_floor)) {
                    std::string gpid;
                    df::plant_raw* gpr = df::plant_raw::find(grass_plant);
                    if (gpr) gpid = gpr->id;
                    eb.tails.push_back(make_grass_tail((uint8_t)idx, gpid, (uint8_t)grass_amt));
                    flags2 |= kFlag2Grass;
                }
            }

            // FLOW (WC-15): the pre-scanned densest flow at this tile, if any.
            if (flow_type_at[idx] >= 0) {
                eb.tails.push_back(make_flow_tail((uint8_t)idx, flow_type_at[idx], flow_density_at[idx]));
                flags2 |= kFlag2Flow;
            }

            // ENGRAVING (WC-18): every hit at this tile from the pre-fetched block index
            // (usually 0; a tile can carry several -- one per engraved face, §wire_v1.h
            // doc). Emitted as separate tail entries (not merged server-side) so the client
            // can apply its own combined-mask lookup independent of hit order/count.
            if (engraving_hits) {
                for (const EngravingHit& hh : *engraving_hits) {
                    if (hh.tile_idx != idx) continue;
                    eb.tails.push_back(make_engraving_tail((uint8_t)idx, hh.eflags, (int)hh.quality));
                    flags2 |= kFlag2Engraving;
                }
            }

            // VERMIN (WC-21): every hit at this tile from the pre-fetched block index (same
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

            // TX4: one planted crop per farm tile. This is deliberately separate from ITEM:
            // planted seed items are building-owned and native renders them as crop stages,
            // not as loose inventory sprites.
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

// ---- ITEMDEF_DICT (WC-1) ------------------------------------------------------------
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

// Reads world->raws.itemdefs.* -- the 14 ITEMDEF_VECTORS (Items.cpp:122-136), same order.
// Caller holds the CoreSuspender; this is intended as a ONE-TIME build (§1.5).
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
    fill(out[3],  d.tools);
    fill(out[4],  d.instruments);
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
