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

// Protocol v1 binary wire codec, mirrored by web/js/dwf-wire-v1.js and kept honest by the golden
// fixture. Every function taking a df::world* reads live DF -- callers MUST hold CoreSuspender.

#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

// Forward declarations so callers don't drag in the DF map headers just to include this.
namespace df { struct map_block; struct world; }
namespace MapExtras { class MapCache; }

namespace dwf {
namespace wire {

// ---- frame header --------------------------------------------------------------------
constexpr uint8_t  kMagic0        = 0x44;   // 'D'
constexpr uint8_t  kMagic1        = 0x35;   // '5'
constexpr uint8_t  kVersion       = 1;
constexpr uint8_t  kTypeBlockSet  = 0x01;
constexpr uint8_t  kTypeAux       = 0x02;
constexpr uint8_t  kFlagDeflated  = 0x01;   // bit0: payload deflated (zlib/RFC1950)
constexpr size_t   kHeaderSize    = 10;

// ---- BLOCK_SET / tile record ---------------------------------------------------------
constexpr size_t   kTileRecordSize = 12;
constexpr size_t   kTilesPerBlock  = 256;    // 16x16
constexpr uint16_t kVoidTt         = 0xFFFF; // void/off-map/null-block (legacy "tt":-1)
constexpr size_t   kMaxBlocksPerFrame = 24;  // frame assembly cap
constexpr size_t   kDeflateThreshold  = 8192; // deflate iff raw payload > this

constexpr uint8_t  kTailItem        = 0x01;
constexpr uint8_t  kTailPlant       = 0x02;
constexpr uint8_t  kTailSpatterMat  = 0x03;   // mat + amount + mat_state, plus an optional
                                               // trailing resolved (r,g,b)
constexpr uint8_t  kTailFlow        = 0x04;   // flow_type + density
constexpr uint8_t  kTailItemSpatter = 0x05;   // growth_class + item_type + amount
constexpr uint8_t  kTailGrass       = 0x06;   // Plant token string (idlen+bytes, the kTailPlant
                                               // layout) + coverage amount
constexpr uint8_t  kTailEngraving   = 0x07;   // engraving_flags (10 bits) + quality
constexpr uint8_t  kTailDesigPriority = 0x08; // Designation priority
constexpr uint8_t  kTailVermin       = 0x09;  // Vermin/vermin-colony race+caste+flags
constexpr uint8_t  kTailContainerPeek = 0x0A; // Barrel/bin representative-content peek
constexpr uint8_t  kTailFarmCrop     = 0x0B;  // Planted farm crop species + growth stage
constexpr uint8_t  kTailTreeGraphics = 0x0C;  // TREE-KEY: optional packed native tree resolver keys

// TREE-KEY tail 0x0C: tflags u8 | wood_key u16 LE | leaf_key u32 LE. The growth-present bit is
// required because a leaf growth value of zero means FRUIT_1, not NONE.
constexpr uint8_t kTreeGraphicsWoodPresent   = 0x01;
constexpr uint8_t kTreeGraphicsLeafPresent   = 0x02;
constexpr uint8_t kTreeGraphicsGrowthPresent = 0x04;
constexpr uint8_t  kTailItemArt      = 0x0D;  // live item-art discriminator
constexpr uint8_t  kItemArtHasInstrument = 0x01;
constexpr uint8_t  kItemArtSpecialMaterial = 0x02;
constexpr uint8_t  kItemArtGeneratedTool = 0x04;

// Optional identity block after the ITEM tail's 12-byte body: ident_kind u8 | idlen u8 | id bytes.
// A gem's trailing shape i16 is carved off the tail END first, so identity stays unambiguous.
constexpr uint8_t  kItemIdentNone      = 0;
constexpr uint8_t  kItemIdentPlant     = 1;
constexpr uint8_t  kItemIdentCreature  = 2;
constexpr uint8_t  kItemIdentInorganic = 3;

// Iflags bits (packed into the ITEM tail's trailing iflags byte).
constexpr uint8_t  kItemFlagWeb    = 0x01;   // spider_web
constexpr uint8_t  kItemFlagForbid = 0x02;
constexpr uint8_t  kItemFlagDump   = 0x04;
constexpr uint8_t  kItemFlagMelt   = 0x08;
constexpr uint8_t  kItemFlagOnFire = 0x10;
constexpr uint8_t  kItemFlagHasQuality = 0x20;
// bit6 is set only for corpse-class items DF's OWN name labels skeletal, so a fresh corpse keeps
// body art. Old decoders mask & 0x1f and are unaffected.
constexpr uint8_t  kItemFlagSkeletal   = 0x40;
// item_flags.grown selects an itemdef's WOOD_GROWN cell instead of its ordinary WOOD cell.
constexpr uint8_t  kItemFlagGrown      = 0x80;

// The quality block rides at the very END of the ITEM tail, after identity and after gem-shape,
// and only when kItemFlagHasQuality is set: quality u8 | qflags u8 | wear u8.
constexpr uint8_t  kItemQFlagArtifact = 0x02;   // qflags bit1

// CONTAINER_PEEK 0x0A, emitted only for a BARREL/BIN holding something, and describing the FIRST
// contained item: item_type i16 | mat_type i16 | mat_index i32 | subtype i16 | cflags u8.
constexpr uint8_t  kPeekFlagSubterranean = 0x01;

// flags2 bits
constexpr uint16_t kFlag2Item        = 0x0001;
constexpr uint16_t kFlag2Plant       = 0x0002;
constexpr uint16_t kFlag2Spatter     = 0x0004;
constexpr uint16_t kFlag2Flow        = 0x0008;   // Tile carries a FLOW tail
constexpr uint16_t kFlag2ItemSpatter = 0x0010;   // Tile carries an ITEM_SPATTER tail
constexpr uint16_t kFlag2Grass       = 0x0020;   // Tile carries a GRASS tail
constexpr uint16_t kFlag2Engraving   = 0x0040;   // Tile carries >=1 ENGRAVING tail
constexpr uint16_t kFlag2DesigPriority = 0x0080; // Tile carries a DESIG_PRIORITY tail
constexpr uint16_t kFlag2Vermin       = 0x0100;  // Tile carries >=1 VERMIN tail
constexpr uint16_t kFlag2ContainerPeek = 0x0200; // Tile carries a CONTAINER_PEEK tail
constexpr uint16_t kFlag2FarmCrop     = 0x0400;  // Tile carries one FARM_CROP tail
// Damp and warm are per-tile STATE, not tail-presence flags. The client cannot derive either --
// damp needs the tile at z+1 and the aquifer bit, warm needs temperature -- so the server answers.
constexpr uint16_t kFlag2Damp         = 0x0800;  // Dig here cancels -- "Damp stone located."
constexpr uint16_t kFlag2Warm         = 0x1000;  // Dig here cancels -- "Warm stone located."

// Vermin vflags bits.
constexpr uint8_t  kVerminFlagColony     = 0x01;  // flags.bits.is_colony
constexpr uint8_t  kVerminFlagSwarmLarge = 0x02;  // amount-threshold "large swarm" hint

// item-spatter growth_class, resolved server-side from the plant's growths[] token
constexpr uint8_t  kGrowthOther      = 0;
constexpr uint8_t  kGrowthLeaves     = 1;
constexpr uint8_t  kGrowthFruit      = 2;
constexpr uint8_t  kGrowthFruitSmall = 3;
constexpr uint8_t  kGrowthFruitLarge = 4;

// PLANT part codes
constexpr uint8_t  kPartTrunk   = 0;
constexpr uint8_t  kPartBranch  = 1;
constexpr uint8_t  kPartCanopy  = 2;
constexpr uint8_t  kPartLeaves  = 3;
constexpr uint8_t  kPartSapling = 4;
constexpr uint8_t  kPartShrub   = 5;

// One 12-byte tile record, decoded into fields. A void record is tt==kVoidTt
// with every other field 0.
struct TileRecord {
    uint16_t tt         = kVoidTt;
    int16_t  base_mt    = 0;
    int16_t  base_mi    = 0;
    uint8_t  bits       = 0;   // liquid:2 flow:3 hidden:1 outside:1
    uint8_t  desig1     = 0;   // dig:4 smooth:2 marker:1 automine:1
    uint8_t  desig2     = 0;   // traffic:2 track:4
    uint8_t  spatter_amt = 0;  // clamped 0..255
    uint16_t flags2     = 0;   // bit0 item, bit1 plant, bit2 spatter-mat tail present
};

// One sparse tail entry, applying to record `tile_idx`. `data` is what follows the 3-byte
// (tile_idx, kind, len) prefix on the wire.
struct Tail {
    uint8_t tile_idx = 0;
    uint8_t kind     = 0;
    std::vector<uint8_t> data;
};

// A fully encoded block. `records` is idx-ordered (idx = ly*16 + lx); `tails` ascend by tile_idx.
struct EncodedBlock {
    uint16_t bx = 0, by = 0, bz = 0;
    uint32_t ver = 0;
    uint8_t  bflags = 0;
    std::array<TileRecord, kTilesPerBlock> records{};
    std::vector<Tail> tails;
};

// ---- little-endian primitives ------------------------------------------------------
inline void put_u16(std::vector<uint8_t>& o, uint16_t v) {
    o.push_back((uint8_t)(v & 0xFF)); o.push_back((uint8_t)((v >> 8) & 0xFF));
}
inline void put_u32(std::vector<uint8_t>& o, uint32_t v) {
    o.push_back((uint8_t)(v & 0xFF));         o.push_back((uint8_t)((v >> 8) & 0xFF));
    o.push_back((uint8_t)((v >> 16) & 0xFF)); o.push_back((uint8_t)((v >> 24) & 0xFF));
}
inline uint16_t get_u16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
inline uint32_t get_u32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// ---- bit packers (shared by encoder + selftest; decoder mirrors in JS) -------------
inline uint8_t pack_bits(int liquid, int flow, int hidden, int outside) {
    return (uint8_t)((liquid & 3) | ((flow & 7) << 2) | ((hidden & 1) << 5) | ((outside & 1) << 6));
}
inline uint8_t pack_desig1(int dig, int smooth, int marker, int automine = 0) {
    return (uint8_t)((dig & 15) | ((smooth & 3) << 4) | ((marker & 1) << 6) |
                     ((automine & 1) << 7));
}
inline uint8_t pack_desig2(int traffic, int track) {
    return (uint8_t)((traffic & 3) | ((track & 15) << 2));
}

// ---- frame header --------------------------------------------------------------------
// 10-byte header. Only BLOCK_SET/AUX get a per-connection seq; ITEMDEF_DICT ships seq=0.
std::vector<uint8_t> build_frame_header(uint8_t type, uint8_t flags, uint32_t seq);

// ---- tile record ---------------------------------------------------------------------
void write_tile_record(uint8_t out[kTileRecordSize], const TileRecord& r);

// ---- BLOCK_SET payload ---------------------------------------------------------------
// Payload only, no frame header; the caller ensures n <= kMaxBlocksPerFrame.
std::vector<uint8_t> assemble_block_set(uint32_t world_seq, const EncodedBlock* blocks, size_t n);

// ---- CRC32 (fixture integrity) -----------------------------------------------------
uint32_t crc32(const uint8_t* data, size_t len);

// ---- deterministic self-test fixture --------------------------------------------------
// The full framed message, byte-identical to the JS generator that produced the golden fixture.
std::vector<uint8_t> build_selftest_fixture(uint32_t* out_world_seq = nullptr);

// CRC32 of build_selftest_fixture()'s bytes. The C++ encoder must reproduce the JS generator's.
constexpr uint32_t kSelftestFixtureCrc = 0x73105D34u;

// Encodes ONE map block: emit_tile_fields' per-z fields MINUS the see-down descent and wallnbr.
// Caller MUST hold the CoreSuspender. A null `block` (unrevealed/off-map) gives all-void records.
EncodedBlock encode_block(df::world* world, MapExtras::MapCache& MC, df::map_block* block,
                          int bx, int by, int bz, uint32_t ver);

// world->event.engravings is a GLOBAL vector, so this keeps a position-keyed index rebuilt only
// when that vector changes SIZE; an in-place quality change is an accepted staleness residual.
struct EngravingHit {
    uint8_t  tile_idx = 0;
    uint16_t eflags   = 0;   // df::engraving_flags.whole & 0x3FF -- DF's bit layout already
                             // matches the wire's, so this is a direct copy with no remapping
    uint8_t  quality  = 0;   // df::item_quality, clamped 0..255 (practically 0..6).
};
// Rebuilds the index (if stale) then returns this block's hits, or nullptr if none.
const std::vector<EngravingHit>* engravings_for_block(df::world* world, int bx, int by, int bz);
// Cheap order-independent fold of a block's engraving hits (count + per-hit mix), for
// block_signature() to fold into its per-block change-detection signature.
uint64_t engraving_block_fold(df::world* world, int bx, int by, int bz);

// The same size-change-keyed index over world->event.vermin / vermin_colonies. df::vermin::amount
// only sets kVerminFlagSwarmLarge here; the count itself never reaches the wire.
struct VerminHit {
    uint8_t  tile_idx = 0;
    uint16_t race      = 0;
    uint8_t  caste     = 0;
    uint8_t  vflags    = 0;   // kVerminFlagColony / kVerminFlagSwarmLarge
};
const std::vector<VerminHit>* vermin_for_block(df::world* world, int bx, int by, int bz);
uint64_t vermin_block_fold(df::world* world, int bx, int by, int bz);

// Planted crops are building-owned contained_items, not map_block::items, so one position-keyed
// index per stream tick is shared by change detection and encode_block.
struct FarmCropHit {
    uint8_t tile_idx = 0;
    uint8_t stage = 0;
    std::string plant_id;
};
void refresh_farm_crop_index(df::world* world);
const std::vector<FarmCropHit>* farm_crops_for_block(int bx, int by, int bz);
uint64_t farm_crop_block_fold(int bx, int by, int bz);

// ---- ITEMDEF_DICT ---------------------------------------------------------------------
// Framed like any other v1 message: build_frame_header(kTypeItemDefDict, ...) then the payload.
constexpr uint8_t kTypeItemDefDict = 0x03;

// The 14 itemdef subcategories in the EXACT order of DFHack's ITEMDEF_VECTORS macro --
// that order IS the wire's `subcat` index.
constexpr size_t kItemDefSubcatCount = 14;

// `id` is the vector index (the item's `subtype` on the wire); `token` is itemdef.id.
struct ItemDefEntry {
    uint16_t id = 0;
    std::string token;
};
using ItemDefSubcat = std::vector<ItemDefEntry>;

// Pure serializer: subcat u8 | count u16 LE | count x (id u16 LE | len u8 | token bytes).
std::vector<uint8_t> assemble_itemdef_dict(const ItemDefSubcat subcats[kItemDefSubcatCount]);

// Reads world->raws.itemdefs.* into out[]. Caller MUST hold the CoreSuspender, and this is meant
// to run once per world epoch: raws are static after world load.
void read_itemdef_dict(df::world* world, ItemDefSubcat out[kItemDefSubcatCount]);

} // namespace wire
} // namespace dwf
