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

// wire_v1.h -- protocol v1 binary wire codec (W-A foundation spec, Part 0).
//
// PURE ENCODING. The frame-header, tile-record and BLOCK_SET assembly helpers touch
// NO DF globals -- they operate on plain structs (TileRecord / EncodedBlock) and are
// unit-testable off any DF world (that is what capture-wire-selftest exercises). The
// single DF-reading entry point is encode_block(), which takes only passed-in pointers
// (its body -- and only its body -- includes the DF map headers) so callers hold the
// CoreSuspender and this file stays cheap to include.
//
// Byte layout is the normative §0.2/§0.3 contract, little-endian, written byte-by-byte
// (no struct-cast punning -- MSVC padding safety). The reference JS decoder that mirrors
// this file is web/js/dwf-wire-v1.js (WA-8), validated against the same golden
// fixture by tools/harness/wire_decode_test.mjs.

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

// ---- §0.2 frame header -------------------------------------------------------------
constexpr uint8_t  kMagic0        = 0x44;   // 'D'
constexpr uint8_t  kMagic1        = 0x35;   // '5'
constexpr uint8_t  kVersion       = 1;
constexpr uint8_t  kTypeBlockSet  = 0x01;
constexpr uint8_t  kTypeAux       = 0x02;
constexpr uint8_t  kFlagDeflated  = 0x01;   // bit0: payload deflated (zlib/RFC1950)
constexpr size_t   kHeaderSize    = 10;

// ---- §0.3 BLOCK_SET / tile record --------------------------------------------------
constexpr size_t   kTileRecordSize = 12;
constexpr size_t   kTilesPerBlock  = 256;    // 16x16
constexpr uint16_t kVoidTt         = 0xFFFF; // void/off-map/null-block (legacy "tt":-1)
constexpr size_t   kMaxBlocksPerFrame = 24;  // frame assembly cap (§0.3)
constexpr size_t   kDeflateThreshold  = 8192; // deflate iff raw payload > this (§0.2)

// tail kinds (§0.3.2). RECONCILE-R1: the landed registry assigns ids sequentially as
// items claim them (0x01 ITEM, 0x02 PLANT, 0x03 SPATTER-mat -- W-A/WC-1), NOT the spec's
// draft 0x10+ numbering (that draft predates the landed W-A framing; ledger note: "keep
// W-C's ENTRY layouts and re-wrap"). WC-15/WC-11 claimed 0x04/0x05; WC-17/WC-18 claim the
// next two free ids (0x06/0x07), NOT the spec draft's 0x13/0x14.
constexpr uint8_t  kTailItem        = 0x01;
constexpr uint8_t  kTailPlant       = 0x02;
constexpr uint8_t  kTailSpatterMat  = 0x03;   // WC-11: extended additively with mat_state;
                                               // blood-family gap fix: optionally extended
                                               // AGAIN with a trailing resolved (r,g,b) --
                                               // see make_spatter_tail's doc in wire_v1.cpp.
constexpr uint8_t  kTailFlow        = 0x04;   // WC-15: flow_type + density
constexpr uint8_t  kTailItemSpatter = 0x05;   // WC-11: growth_class + item_type + amount
constexpr uint8_t  kTailGrass       = 0x06;   // WC-17: plant token string (idlen+bytes,
                                               // same layout as kTailPlant) + coverage
                                               // amount -- see wire_v1.cpp's make_grass_tail
                                               // doc for why this deviates from the spec
                                               // draft's fixed "plant_id u16" entry.
constexpr uint8_t  kTailEngraving   = 0x07;   // WC-18: engraving_flags (10 bits) + quality
constexpr uint8_t  kTailDesigPriority = 0x08; // WC-19: designation priority (§WC-19 wire)
constexpr uint8_t  kTailVermin       = 0x09;  // WC-21: vermin/vermin-colony race+caste+flags
constexpr uint8_t  kTailContainerPeek = 0x0A; // TX1: barrel/bin representative-content peek
                                               // (see the CONTAINER_PEEK doc block below)
constexpr uint8_t  kTailFarmCrop     = 0x0B;  // TX4: planted farm crop species + growth stage

// Item identity extension (additive to the ITEM tail 0x01, WIRE-TAILS bundle 2026-07-07):
// after the 12-byte WC-1 body, an OPTIONAL identity block resolving per-species art for
// plant- and creature-derived items that the numeric (item_type, mat_type, mat_index) pair
// alone cannot map -- harvested-plant items (SEEDS/PLANT/PLANT_GROWTH/DRINK...) -> the
// plant_map species cell (closes B27's seed-placeholder half), and corpse/remains/vermin-
// item/egg items -> the creatures_map race cell. Layout, present ONLY when the server
// resolved an identity (so the tail stays 12 bytes when it did not -- old decoders / old
// clients skip by the wire's own length prefix, the same additive contract every prior
// tail extension uses):
//   ident_kind u8 (1 plant / 2 creature / 3 inorganic) | idlen u8 | id bytes
//     (plant_raw.id / creature_id / inorganic_raw.id)
// Tier-2 additions (asset/material-parity spec 2026-07-08 §4):
//   - kItemIdentInorganic (3): inorganic items (boulders/bars/rough+cut gems) carry their
//     inorganic_raw.id so material identity is order-independent (modded/generated worlds)
//     and the client can verify/replace its offline mat_index->id map.
//   - Gem shape: SMALLGEM/GEM item tails append a trailing `shape` (i16, -1 = uncut/spawned)
//     as the LAST two bytes, AFTER the optional identity block. The decoder keys presence off
//     the gem item_type + a tail length past the 12-byte body, so it carves the 2 shape bytes
//     off FIRST and parses identity only in the middle -- unambiguous even when identity is
//     absent (glass gems). Both are additive tails; a full re-golden is required (spec §4).
constexpr uint8_t  kItemIdentNone      = 0;
constexpr uint8_t  kItemIdentPlant     = 1;
constexpr uint8_t  kItemIdentCreature  = 2;
constexpr uint8_t  kItemIdentInorganic = 3;

// WC-1 iflags bits (packed into the ITEM tail's trailing iflags byte, §WC-1 wire table).
constexpr uint8_t  kItemFlagWeb    = 0x01;   // spider_web
constexpr uint8_t  kItemFlagForbid = 0x02;
constexpr uint8_t  kItemFlagDump   = 0x04;
constexpr uint8_t  kItemFlagMelt   = 0x08;
constexpr uint8_t  kItemFlagOnFire = 0x10;
// bit5 (0x20) is the ITEM quality-family presence flag (below); bits 6-7 spare.
constexpr uint8_t  kItemFlagHasQuality = 0x20;
// CORPSETEX-B195 (grep witness: CORPSETEX_B195_SKELETAL): a corpse/body-part item is drawn
// with SKELETAL art only once DF's OWN item name labels it a skeleton -- fresh corpses show
// body art and follow DF's fresh->skeletal transition over time (bug: fresh dwarf
// corpse jumped straight to a bone pile). iflags bit6, additive: the byte's low 5 flag bits
// and bit5 (quality presence) are unchanged, so old decoders (which mask `& 0x1f`) and old
// clients are byte-for-byte unaffected; a corpse on an old server keeps today's look. Set
// server-side ONLY for corpse-class items DF names "skeleton"/"skeletal", so a plain item is
// byte-identical to the pre-B195 wire (no size growth -- reuses a spare iflags bit, no new
// field, AUX-growth-policy clean).
constexpr uint8_t  kItemFlagSkeletal   = 0x40;   // CORPSETEX_B195_SKELETAL

// ITEM quality-family trailing block (owner-ordered 2026-07-09). When kItemFlagHasQuality is set
// in the iflags byte, a fixed 3-byte block rides at the very END of the ITEM tail, AFTER the
// optional identity block AND the optional gem-shape i16:
//   quality u8 (0-5) | qflags u8 | wear u8 (0-3)
// The decoder carves it off the tail END FIRST (before gem-shape), so the middle identity
// region stays unambiguous -- same end-carve discipline gem-shape uses, but keyed by an
// explicit iflags presence bit rather than by item_type (quality applies to many item types,
// so type-keying like gem-shape cannot signal presence here). Emitted server-side ONLY when
// there is something to say (quality>0 OR artifact OR wear>0), so a plain item stays exactly
// 12 bytes -- byte-identical to the pre-quality wire, the same additive/optional contract every
// prior ITEM-tail extension uses. qflags bit1 = artifact; other bits reserved.
constexpr uint8_t  kItemQFlagArtifact = 0x02;   // qflags bit1

// TX1 CONTAINER_PEEK tail (0x0A, additive NEW KIND -- old decoders skip unknown kinds by
// the wire's own length prefix, so this needs no ITEM-tail end-carve gymnastics). Native
// draws a barrel/bin's contents poking out of the container's open top as a DEDICATED
// per-category overlay cell composited over the container sprite (vanilla
// graphics_containers.txt's ITEM_BARREL_TOP_MEAT/_FISH/_PLANT[_SUBTERRANEAN]/... and the
// 21 ITEM_BIN_TOP_* rows -- DF's own category taxonomy is df::item_bin_graphics_contents_type;
// verified against the TX1-1 oracle capture: the food-barrel peeks ARE those cells).
// The renderer wave that first attempted TX1 honestly refused for lack of a wire contents
// field -- this tail is that field. Emitted for a tile whose topmost ITEM is a BARREL or
// BIN with at least one contained item (DFHack Items::getContainedItems, i.e. the item's
// general_ref_contains_itemst refs); an EMPTY container emits nothing (no tail -> no peek).
// Layout (fixed 11 bytes -- the representative FIRST contained item's identity, enough for
// the client to classify a category token and resolve it through item_map.bytoken):
//   item_type i16 | mat_type i16 | mat_index i32 | subtype i16 | cflags u8
// cflags bit0 = the content's plant material is a SUBTERRANEAN crop (plant_raw
// underground_depth_min > 0, resolved server-side -- picks ITEM_BARREL_TOP_PLANT_SUBTERRANEAN
// vs _PLANT client-side). Category classification lives CLIENT-side (both renderers) so a
// mapping tweak never needs a DLL window; an unmapped content type draws a plain container,
// never a guessed cell.
constexpr uint8_t  kPeekFlagSubterranean = 0x01;

// flags2 bits (§0.3.1 off 10)
constexpr uint16_t kFlag2Item        = 0x0001;
constexpr uint16_t kFlag2Plant       = 0x0002;
constexpr uint16_t kFlag2Spatter     = 0x0004;
constexpr uint16_t kFlag2Flow        = 0x0008;   // WC-15: tile carries a FLOW tail
constexpr uint16_t kFlag2ItemSpatter = 0x0010;   // WC-11: tile carries an ITEM_SPATTER tail
constexpr uint16_t kFlag2Grass       = 0x0020;   // WC-17: tile carries a GRASS tail
constexpr uint16_t kFlag2Engraving   = 0x0040;   // WC-18: tile carries >=1 ENGRAVING tail
constexpr uint16_t kFlag2DesigPriority = 0x0080; // WC-19: tile carries a DESIG_PRIORITY tail
constexpr uint16_t kFlag2Vermin       = 0x0100;  // WC-21: tile carries >=1 VERMIN tail
constexpr uint16_t kFlag2ContainerPeek = 0x0200; // TX1: tile carries a CONTAINER_PEEK tail
constexpr uint16_t kFlag2FarmCrop     = 0x0400;  // TX4: tile carries one FARM_CROP tail
// B269 mining indicators. NOT tail-presence flags -- these two are pure per-tile STATE, the only
// two facts a client needs to draw DF's DAMP_STONE_WARNING / WARM_STONE_WARNING glyphs
// (mining_indicators.png cells (0,0)/(1,0), vanilla_interface graphics_interface.txt:3300-3301).
// DF itself stores no such marker: it derives the overlay from map state every frame. The client
// cannot derive it -- damp needs the tile at z+1 (the client only ever descends, never peeks up)
// and the aquifer `water_table` bit, and warm needs tile temperature; none crossed the wire. So
// the server evaluates DFHack's own replication of DF's cancel rule (plugins/dig.cpp is_damp:302 /
// is_warm:235) and ships the two answers. Additive: a tile that is neither damp nor warm encodes
// byte-identically to before.
constexpr uint16_t kFlag2Damp         = 0x0800;  // B269: dig here cancels -- "Damp stone located."
constexpr uint16_t kFlag2Warm         = 0x1000;  // B269: dig here cancels -- "Warm stone located."

// WC-21 vermin vflags bits (§WC-21 wire table).
constexpr uint8_t  kVerminFlagColony     = 0x01;  // flags.bits.is_colony
constexpr uint8_t  kVerminFlagSwarmLarge = 0x02;  // amount-threshold "large swarm" hint

// WC-11 item-spatter growth_class (resolved server-side from plant_raw.growths[idx].id
// token substring match; memoized per (plant,growth) pair -- §WC-11 wire table).
constexpr uint8_t  kGrowthOther      = 0;
constexpr uint8_t  kGrowthLeaves     = 1;
constexpr uint8_t  kGrowthFruit      = 2;
constexpr uint8_t  kGrowthFruitSmall = 3;
constexpr uint8_t  kGrowthFruitLarge = 4;

// PLANT part codes (§0.3.2)
constexpr uint8_t  kPartTrunk   = 0;
constexpr uint8_t  kPartBranch  = 1;
constexpr uint8_t  kPartCanopy  = 2;
constexpr uint8_t  kPartLeaves  = 3;
constexpr uint8_t  kPartSapling = 4;
constexpr uint8_t  kPartShrub   = 5;

// One 12-byte tile record (§0.3.1), decoded into fields. A void record is tt==kVoidTt
// with every other field 0.
struct TileRecord {
    uint16_t tt         = kVoidTt;
    int16_t  base_mt    = 0;
    int16_t  base_mi    = 0;
    uint8_t  bits       = 0;   // liquid:2 flow:3 hidden:1 outside:1
    uint8_t  desig1     = 0;   // dig:4 smooth:2 marker:1
    uint8_t  desig2     = 0;   // traffic:2 track:4
    uint8_t  spatter_amt = 0;  // clamped 0..255
    uint16_t flags2     = 0;   // bit0 item, bit1 plant, bit2 spatter-mat tail present
};

// One sparse tail entry: applies to record `tile_idx`. `data` is the kind-specific
// payload (§0.3.2), i.e. what follows the (tile_idx,kind,len) 3-byte prefix on the wire.
struct Tail {
    uint8_t tile_idx = 0;
    uint8_t kind     = 0;
    std::vector<uint8_t> data;
};

// A fully-encoded block ready for BLOCK_SET assembly. `records` is idx-ordered
// (idx = ly*16 + lx). `tails` are emitted in ascending (tile_idx, then item/plant/
// spatter) order by the encoder.
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
inline uint8_t pack_desig1(int dig, int smooth, int marker) {
    return (uint8_t)((dig & 15) | ((smooth & 3) << 4) | ((marker & 1) << 6));
}
inline uint8_t pack_desig2(int traffic, int track) {
    return (uint8_t)((traffic & 3) | ((track & 15) << 2));
}

// ---- frame header (§0.2) -----------------------------------------------------------
// Build the 10-byte header for a server->client frame. `type` = kTypeBlockSet/kTypeAux;
// `flags` carries kFlagDeflated when the payload was deflated; `seq` is the
// per-connection monotonic sequence (>=1).
std::vector<uint8_t> build_frame_header(uint8_t type, uint8_t flags, uint32_t seq);

// ---- tile record (§0.3.1) ----------------------------------------------------------
void write_tile_record(uint8_t out[kTileRecordSize], const TileRecord& r);
TileRecord read_tile_record(const uint8_t in[kTileRecordSize]);

// ---- BLOCK_SET payload (§0.3) ------------------------------------------------------
// Assemble the BLOCK_SET *payload* (no frame header) for `n` blocks (caller ensures
// n <= kMaxBlocksPerFrame). world_seq is the global state version at encode time.
std::vector<uint8_t> assemble_block_set(uint32_t world_seq, const EncodedBlock* blocks, size_t n);

// ---- CRC32 (fixture integrity) -----------------------------------------------------
uint32_t crc32(const uint8_t* data, size_t len);

// ---- deterministic self-test fixture (§WA-8.4, extended WC-1/WC-11/WC-15/WC-17/WC-18/
// WC-19/WC-21 + the blood-family color extension + the WIRE-TAILS item identity extension) --
// Build the hardcoded synthetic 2-block fixture (void tiles, water 7, magma 3, hidden,
// all desig bits, item/plant/spatter tails, plant id "OAK"/"", clamp, negative mats,
// u16 bx>255, WC-1 item subtype/iflags/stack incl. the -1 subtype sentinel and the
// stack>255 clamp; WC-11 multi-event SPATTER w/ mat_state + ITEM_SPATTER growth_class;
// WC-15 FLOW type/density; WC-17 GRASS plant_id/amount; WC-18 two layered ENGRAVING
// entries on one tile, exercising the multi-record-per-tile OR-combination the client
// must do; WC-19 DESIG_PRIORITY; WC-21 two layered VERMIN hits (lone + colony); the
// blood-family color extension's optional resolved-rgb SPATTER bytes; WIRE-TAILS tile(16)
// PLANT-identity item "OAK" + tile(17) CREATURE-identity item "DWARF" on the ITEM tail;
// TX1 tiles(27-29) BARREL/BIN ITEM tails paired with CONTAINER_PEEK tails -- MEAT,
// subterranean-PLANT (cflags bit0), coal-BAR).
// Returns the full
// framed message bytes: header (BLOCK_SET, uncompressed, seq=1) + payload. Identical
// byte-for-byte to the JS generator that produced the committed golden fixture
// (tools/harness/fixtures/wire_fixture.bin).
std::vector<uint8_t> build_selftest_fixture(uint32_t* out_world_seq = nullptr);

// CRC32 of build_selftest_fixture() bytes, computed offline from the golden JS
// generator (tools/harness/gen_wire_fixture.mjs). The C++ encoder must reproduce it.
// Re-golden history: 0x051CBDCB (pre-WC-19/21/blood-family) -> 0x0BBDDC0D (WC-19/21 +
// blood-family: tile(14) DESIG_PRIORITY, tile(15) two-hit VERMIN, resolved-rgb SPATTER on
// tile(11)) -> 0x448B4F1B (WIRE-TAILS bundle: item identity ITEM-tail extension -- tile(16)
// PLANT-ident "OAK" + tile(17) CREATURE-ident "DWARF" -- AND the VERMIN-tail creature-token
// extension -- tile(15)'s two vermin now carry "HONEY_BEE"/"ANT")
// -> 0xA6F1DC0F (TIER-2 asset/material-parity §4: inorganic identity ident_kind 3 + cut-gem
// `shape` ITEM-tail extension -- three fresh item tiles: tile(18) SMALLGEM ident
// "GREEN_ZIRCON"+shape 7, tile(19) GEM shape-only glass spawned -1, tile(20) ROUGH ident
// "MICROCLINE" no shape). See gen_wire_fixture.mjs.
// -> 0x538DEA9C (WINDOW #10: tail_count u8->u16 + ITEM quality-family tail [quality|qflags|wear]
// keyed on iflags bit5 -- fixture tiles 21-26 + >255-tail Block C proving the truncation
// class dead. JS generator reconfirmed 0x538DEA9C at deploy.)
// -> 0x73105D34 (TX1 barrel/bin contents-peek: NEW tail kind CONTAINER_PEEK 0x0A -- fixture
// tiles 27-29: wood BARREL + MEAT content, wood BARREL + subterranean-PLANT content
// (cflags bit0), BIN + coal-BAR content. gen_wire_fixture.mjs regenerated 0x73105D34.)
constexpr uint32_t kSelftestFixtureCrc = 0x73105D34u;

// ---- DF-reading encoder (§0.3.1 field sources) -------------------------------------
// Encode ONE map block into an EncodedBlock: the raw per-z fields of emit_tile_fields
// MINUS the see-down descent and MINUS wallnbr (client derivations). Caller MUST hold
// the CoreSuspender. `block` may be null (unrevealed/off-map) -> all-void records.
EncodedBlock encode_block(df::world* world, MapExtras::MapCache& MC, df::map_block* block,
                          int bx, int by, int bz, uint32_t ver);

// ---- WC-18 engraving world-vector index ---------------------------------------------
// world->event.engravings (df::engraving, df.event.xml) is a GLOBAL vector, not a
// per-block one (unlike SPATTER/FLOW/GRASS, which ride block->block_events / block->flows
// already scoped to the block being encoded). Walking the whole vector on every encoded
// block would multiply cost by (blocks-in-view x engravings) -- so this keeps a
// position-keyed index (block key -> hits) rebuilt only when world->event.engravings
// changes SIZE (the RFR isEngravingNew memo pattern, §1.5 "world-vector data... a cheap
// memo"). Quality/flags mutation without a size change (rare -- an existing engraving
// upgraded in place) is a known, accepted residual of this cheap memo.
struct EngravingHit {
    uint8_t  tile_idx = 0;
    uint16_t eflags   = 0;   // df::engraving_flags.whole & 0x3FF -- bit layout already
                             // matches the wire's (floor=0,W=1,E=2,N=3,S=4,hidden=5,
                             // NW=6,NE=7,SW=8,SE=9), a direct copy, no remapping needed.
    uint8_t  quality  = 0;   // df::item_quality, clamped 0..255 (practically 0..6).
};
// Rebuilds the index (if stale) then returns this block's hits, or nullptr if none.
const std::vector<EngravingHit>* engravings_for_block(df::world* world, int bx, int by, int bz);
// Cheap order-independent fold of a block's engraving hits (count + per-hit mix), for
// hash_block()/block_signature() to fold into their per-block change-detection signature.
uint64_t engraving_block_fold(df::world* world, int bx, int by, int bz);

// ---- WC-21 vermin world-vector index --------------------------------------------------
// world->event.vermin / world->event.vermin_colonies (df.event.xml L113-130, L222-223) are
// GLOBAL vectors, same shape problem WC-18's engravings hit -- so this reuses the EXACT
// same position-keyed-index-rebuilt-on-size-change pattern (rebuild only when either
// vector's SIZE changes; a vermin wandering to a new tile without the vector growing/
// shrinking is a known, accepted residual of this cheap memo, same posture as WC-18's own
// "quality mutation without a size change" note -- vermin wander slowly, §WC-21's own "1 Hz
// refresh cadence" tolerance already assumes some staleness). `caste` and `amount` come
// straight off the event; `vflags` bit0 = `flags.bits.is_colony`, bit1 = a size-threshold
// "large swarm" hint (client picks SWARM_LARGE vs SWARM_MEDIUM/SMALL art from this + amount
// carried separately would be nicer, but the wire table pins `vflags u8` with no amount
// field -- WC-21's own apply note "colonies/swarms pick SWARM_* by amount" needs amount on
// the wire too, so this index ALSO exposes `amount` even though the tail's byte layout
// below only carries race/caste/vflags: RECONCILE note left in the .cpp for whichever
// client-apply executor lands the swarm-size art, same "documented residual" convention
// used throughout this spec.
struct VerminHit {
    uint8_t  tile_idx = 0;
    uint16_t race      = 0;
    uint8_t  caste     = 0;
    uint8_t  vflags    = 0;   // kVerminFlagColony / kVerminFlagSwarmLarge
};
const std::vector<VerminHit>* vermin_for_block(df::world* world, int bx, int by, int bz);
uint64_t vermin_block_fold(df::world* world, int bx, int by, int bz);

// ---- TX4 planted farm-crop index ---------------------------------------------------
// Planted crops are building-owned PERM contained_items, not map_block::items. Build one
// position-keyed index per stream tick, then share it between block change detection and
// encode_block so both see the same snapshot without scanning every farm for every tile.
// stage: 0 planted seed, 1 growing sprout, 2 fully grown crop.
struct FarmCropHit {
    uint8_t tile_idx = 0;
    uint8_t stage = 0;
    std::string plant_id;
};
void refresh_farm_crop_index(df::world* world);
const std::vector<FarmCropHit>* farm_crops_for_block(int bx, int by, int bz);
uint64_t farm_crop_block_fold(int bx, int by, int bz);

// ---- ITEMDEF_DICT (WC-1 §2/Chunk A) ------------------------------------------------
// Provisional message type byte -- RECONCILE-R2 leaves final s->c message-type
// assignment to W-A; re-wrap onto whatever byte W-A lands if it differs. Framed the
// same way as any other v1 message: build_frame_header(kTypeItemDefDict, flags, seq)
// followed by assemble_itemdef_dict()'s payload.
constexpr uint8_t kTypeItemDefDict = 0x03;

// The 14 itemdef subcategories, in the EXACT order of DFHack's Items.cpp
// ITEMDEF_VECTORS macro (Items.cpp:122-136) -- this order IS the wire's `subcat` index.
// The corresponding df::item_type enum value for each subcat index (needed by any
// consumer resolving an ITEM tail's `type` byte against a dictionary entry):
//   0 WEAPON(24)  1 TRAPCOMP(68)  2 TOY(14)    3 TOOL(86)      4 INSTRUMENT(13)
//   5 ARMOR(25)   6 AMMO(39)     7 SIEGEAMMO(65) 8 GLOVES(29) 9 SHOES(26)
//   10 SHIELD(27) 11 HELM(28)    12 PANTS(60)  13 FOOD(72)
constexpr size_t kItemDefSubcatCount = 14;

// One raw itemdef: `id` = the vector index (== the item's `subtype` field on the wire),
// `token` = itemdef.id (df.item.xml L14, e.g. "ITEM_WEAPON_PICK").
struct ItemDefEntry {
    uint16_t id = 0;
    std::string token;
};
using ItemDefSubcat = std::vector<ItemDefEntry>;

// Pure serializer: `subcat u8 | count u16 LE | count x (id u16 LE | len u8 | token bytes)`
// for each of the 14 subcats in order (§1.1 message table). No frame header included.
std::vector<uint8_t> assemble_itemdef_dict(const ItemDefSubcat subcats[kItemDefSubcatCount]);

// DF-reading builder: reads world->raws.itemdefs.* (the 14 ITEMDEF_VECTORS, Items.cpp
// order) into `out[kItemDefSubcatCount]`. Caller MUST hold the CoreSuspender. Cheap:
// intended to run ONCE per world epoch (raws are static after world/fort load), not
// per-tick (§1.5 "dict build is one-time").
void read_itemdef_dict(df::world* world, ItemDefSubcat out[kItemDefSubcatCount]);

} // namespace wire
} // namespace dwf
