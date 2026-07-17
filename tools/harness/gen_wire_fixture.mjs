// gen_wire_fixture.mjs -- WA-8 golden-fixture generator (protocol v1, Part 0).
//
// An INDEPENDENT JS encoder that reproduces src/wire_v1.cpp::build_selftest_fixture()
// byte-for-byte. Emits the committed golden artifacts consumed by wire_decode_test.mjs
// and cross-checked (by CRC32) against the C++ encoder in `dfhack-run capture-wire-selftest`:
//   tools/harness/fixtures/wire_fixture.bin           -- the framed BLOCK_SET bytes
//   tools/harness/fixtures/wire_fixture.expected.json -- decoded expectation (2x256 records + tails)
//
// Two independent encoders (C++ + this) converging on the same bytes is the byte-precise
// wire-format proof. Run: node tools/harness/gen_wire_fixture.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.resolve(__dirname, "fixtures");

// ---- little-endian byte sink ------------------------------------------------------
class Buf {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 0xff); }
  u16(v) { this.a.push(v & 0xff, (v >>> 8) & 0xff); }
  u32(v) { this.a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }
  i16(v) { this.u16(v & 0xffff); }
  i32(v) { this.u32(v >>> 0); }
  bytes(arr) { for (const b of arr) this.a.push(b & 0xff); }
  str(s) { for (let i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i) & 0xff); }
  out() { return Uint8Array.from(this.a); }
}

const packBits = (liquid, flow, hidden, outside) =>
  ((liquid & 3) | ((flow & 7) << 2) | ((hidden & 1) << 5) | ((outside & 1) << 6)) & 0xff;
const packDesig1 = (dig, smooth, marker) =>
  ((dig & 15) | ((smooth & 3) << 4) | ((marker & 1) << 6)) & 0xff;
const packDesig2 = (traffic, track) => ((traffic & 3) | ((track & 15) << 2)) & 0xff;

// A tile record; defaults = void (tt=0xFFFF, all zero).
function rec(over) {
  const r = { tt: 0xffff, base_mt: 0, base_mi: 0, bits: 0, desig1: 0, desig2: 0, spatter_amt: 0, flags2: 0 };
  return Object.assign(r, over || {});
}
const floorRec = (tt) => rec({ tt, base_mt: 0, base_mi: -1 });

const F2_ITEM = 1, F2_PLANT = 2, F2_SPATTER = 4, F2_FLOW = 8, F2_ITEM_SPATTER = 16, F2_GRASS = 32, F2_ENGRAVING = 64,
      F2_DESIG_PRIORITY = 0x80, F2_VERMIN = 0x100, F2_CONTAINER_PEEK = 0x200;
const TAIL_ITEM = 0x01, TAIL_PLANT = 0x02, TAIL_SPATTER = 0x03, TAIL_FLOW = 0x04, TAIL_ITEM_SPATTER = 0x05,
      TAIL_GRASS = 0x06, TAIL_ENGRAVING = 0x07, TAIL_DESIG_PRIORITY = 0x08, TAIL_VERMIN = 0x09,
      TAIL_CONTAINER_PEEK = 0x0A;
const VFLAG_COLONY = 0x01, VFLAG_SWARM_LARGE = 0x02;
const PART_TRUNK = 0, PART_SHRUB = 5;
const GROWTH_OTHER = 0, GROWTH_LEAVES = 1, GROWTH_FRUIT = 2, GROWTH_FRUIT_SMALL = 3, GROWTH_FRUIT_LARGE = 4;
const ITEM_TYPE_PLANT_GROWTH = 56; // synthetic test byte (mirrors src/wire_v1.cpp's fixture -- not load-bearing, see its comment)

// WC-1: appends subtype (i16, 0xFFFF sentinel for -1) + iflags (u8, bit0 web/1 forbid/
// 2 dump/3 melt/4 on_fire) + stack (u8, clamped 0..255) AFTER the original 8-byte
// (item_type, mat_type, mat_index) prefix -- extends the SAME kind (0x01), does not add
// a new tail kind. Mirrors src/wire_v1.cpp::make_item_tail byte-for-byte.
// Item identity extension (additive): after the 12-byte WC-1 body, append an OPTIONAL
// `ident_kind u8 (1 plant/2 creature) | idlen u8 | id bytes` block when an identity token is
// given -- absent identity keeps the tail at 12 bytes (old decoders skip by length). Mirrors
// src/wire_v1.cpp::make_item_tail byte-for-byte.
// Tier-2 (asset/material-parity §4): after the optional identity block, SMALLGEM/GEM items
// append a trailing `shape` (i16) as the LAST two bytes (hasShape). Mirrors
// src/wire_v1.cpp::make_item_tail's Tier-2 tail byte-for-byte.
// ITEM QUALITY FAMILY (2026-07-09): optional trailing 3-byte block [quality u8|qflags u8|
// wear u8] at the very END, AFTER identity + gem-shape, keyed by iflags bit5 (IFLAG_HAS_QUALITY).
// Mirrors src/wire_v1.cpp::make_item_tail's has_quality/quality/qflags/wear params byte-for-byte.
function itemTail(idx, item_type, mat_type, mat_index, subtype, iflags, stack, identKind, ident, hasShape, shape,
                  hasQuality, quality, qflags, wear) {
  const d = new Buf();
  d.i16(item_type); d.i16(mat_type); d.i32(mat_index);
  d.i16(subtype);
  d.u8((iflags & 0x1f) | (hasQuality ? IFLAG_HAS_QUALITY : 0));
  d.u8(Math.max(0, Math.min(255, stack)));
  if (identKind && ident && ident.length) {
    d.u8(identKind & 0xff);
    d.u8(ident.length & 0xff);
    d.str(ident);
  }
  if (hasShape) d.i16(shape);
  if (hasQuality) {
    d.u8(Math.max(0, Math.min(5, quality)));
    d.u8(qflags & 0xff);
    d.u8(Math.max(0, Math.min(3, wear)));
  }
  return { tile_idx: idx, kind: TAIL_ITEM, data: d.out() };
}
const IFLAG_WEB = 0x01, IFLAG_FORBID = 0x02, IFLAG_DUMP = 0x04, IFLAG_MELT = 0x08, IFLAG_ONFIRE = 0x10,
      IFLAG_HAS_QUALITY = 0x20, QFLAG_ARTIFACT = 0x02;
const IDENT_PLANT = 1, IDENT_CREATURE = 2, IDENT_INORGANIC = 3;
const ITEM_TYPE_SMALLGEM = 1, ITEM_TYPE_GEM = 44, ITEM_TYPE_ROUGH = 3; // df::item_type ordinals (gem shape keys off SMALLGEM/GEM)
function plantTail(idx, part, id) {
  const d = new Buf(); d.u8(part); d.u8(id.length); d.str(id);
  return { tile_idx: idx, kind: TAIL_PLANT, data: d.out() };
}
// WC-11: appends `state` (matter_state, -1 None -> 0xFF) after the original 8-byte
// (mat_type, mat_index, amount) prefix -- additive, mirrors src/wire_v1.cpp::make_spatter_tail.
// blood-family color extension: `rgb` (optional [r,g,b] array) appends a `has_rgb u8` flag
// + 3 more bytes AFTER the WC-11 state byte when present -- mirrors make_spatter_tail's
// second additive extension exactly.
function spatterTail(idx, mat_type, mat_index, amount, state, rgb) {
  const d = new Buf(); d.i16(mat_type); d.i32(mat_index);
  d.u16(Math.max(0, Math.min(65535, amount)));
  d.u8(state & 0xff);
  if (rgb) { d.u8(1); d.u8(rgb[0]); d.u8(rgb[1]); d.u8(rgb[2]); }
  return { tile_idx: idx, kind: TAIL_SPATTER, data: d.out() };
}
// WC-11: item-spatter (fallen-leaves/fruit litter). Mirrors make_item_spatter_tail.
function itemSpatterTail(idx, growth_class, item_type, amount) {
  const d = new Buf(); d.u8(growth_class); d.u8(item_type);
  d.u8(Math.max(0, Math.min(255, amount)));
  return { tile_idx: idx, kind: TAIL_ITEM_SPATTER, data: d.out() };
}
// WC-15: block flow (mist/smoke/miasma/...). Mirrors make_flow_tail.
function flowTail(idx, flow_type, density) {
  const d = new Buf(); d.u8(flow_type & 0xff);
  d.u8(Math.max(0, Math.min(255, density)));
  return { tile_idx: idx, kind: TAIL_FLOW, data: d.out() };
}
// WC-17: grass coverage -- idlen+id-bytes (same layout as plantTail) + trailing amount
// u8. Mirrors make_grass_tail (see its doc comment for why this carries a token STRING,
// not a raw numeric plant_id).
function grassTail(idx, id, amount) {
  const d = new Buf(); d.u8(id.length); d.str(id); d.u8(amount & 0xff);
  return { tile_idx: idx, kind: TAIL_GRASS, data: d.out() };
}
// WC-18: one engraved-face/floor record (eflags u16 LE masked to 10 bits, quality u8).
// Mirrors make_engraving_tail.
function engravingTail(idx, eflags, quality) {
  const d = new Buf(); d.u16(eflags & 0x03ff); d.u8(Math.max(0, Math.min(255, quality)));
  return { tile_idx: idx, kind: TAIL_ENGRAVING, data: d.out() };
}
// WC-19: designation priority (u8, clamped). Mirrors make_desig_priority_tail.
function desigPriorityTail(idx, priority) {
  const d = new Buf(); d.u8(Math.max(0, Math.min(255, priority)));
  return { tile_idx: idx, kind: TAIL_DESIG_PRIORITY, data: d.out() };
}
// TX1 CONTAINER_PEEK (0x0A): representative FIRST contained item of a BARREL/BIN --
// `item_type i16 | mat_type i16 | mat_index i32 | subtype i16 | cflags u8` (fixed 11
// bytes; cflags bit0 = subterranean plant content). Mirrors make_container_peek_tail.
function containerPeekTail(idx, item_type, mat_type, mat_index, subtype, cflags) {
  const d = new Buf();
  d.i16(item_type); d.i16(mat_type); d.i32(mat_index); d.i16(subtype); d.u8(cflags & 0xff);
  return { tile_idx: idx, kind: TAIL_CONTAINER_PEEK, data: d.out() };
}
// WC-21: vermin hit (race u16 LE, caste u8, vflags u8). Vermin identity extension
// (WIRE-TAILS): optional resolved creature token (idlen u8 + bytes) after the 4-byte body.
// Mirrors make_vermin_tail.
function verminTail(idx, race, caste, vflags, token) {
  const d = new Buf(); d.u16(race < 0 ? 0xffff : race); d.u8(caste < 0 ? 0xff : caste); d.u8(vflags & 0xff);
  if (token && token.length) { d.u8(token.length & 0xff); d.str(token); }
  return { tile_idx: idx, kind: TAIL_VERMIN, data: d.out() };
}

// ---- build the two blocks (mirror of build_selftest_fixture) ----------------------
function buildBlockA() {
  const records = [];
  for (let i = 0; i < 256; i++) records[i] = floorRec(1);
  records[0] = rec({});                                          // void
  records[1] = rec({ tt: 100, base_mt: 5, base_mi: 6, bits: packBits(1, 7, 0, 1) });
  records[2] = rec({ tt: 101, base_mt: 7, base_mi: 8, bits: packBits(2, 3, 0, 0) });
  records[3] = rec({ tt: 102, base_mt: -1, base_mi: -1, bits: packBits(0, 0, 1, 0) });
  records[4] = rec({ tt: 103, base_mt: 1, base_mi: 2, desig1: packDesig1(6, 2, 1), desig2: packDesig2(3, 15) });
  records[5] = rec({ tt: 104, base_mt: 3, base_mi: 4, flags2: F2_ITEM });
  records[6] = rec({ tt: 105, base_mt: 0, base_mi: -1, flags2: F2_PLANT });
  records[7] = rec({ tt: 106, base_mt: 0, base_mi: -1, spatter_amt: 200, flags2: F2_SPATTER });
  records[8] = rec({ tt: 107, base_mt: 11, base_mi: 12, bits: packBits(1, 4, 0, 0),
    desig1: packDesig1(1, 1, 0), desig2: packDesig2(1, 1), spatter_amt: 255,
    flags2: F2_ITEM | F2_PLANT | F2_SPATTER });
  // WC-11: tile(9) fallen-leaves/fruit litter (2 ITEM_SPATTER entries); tile(10) a mist
  // flow (WC-15); tile(11) TWO layered material-spatter events (kept off tiles 7/8
  // deliberately -- cache_test.mjs's pre-existing golden-fixture assertions pin
  // single-event spatterMat values there; client "merge layered decals" is WC-12 apply
  // work, not landed, so a fresh tile proves the wire grammar without touching those).
  records[9] = rec({ tt: 108, base_mt: 0, base_mi: -1, flags2: F2_ITEM_SPATTER });
  records[10] = rec({ tt: 109, base_mt: 0, base_mi: -1, flags2: F2_FLOW });
  records[11] = rec({ tt: 110, base_mt: 0, base_mi: -1, spatter_amt: 255, flags2: F2_SPATTER });
  // WC-17: tile(12) grass-floor tile carrying one GRASS tail.
  records[12] = rec({ tt: 111, base_mt: 0, base_mi: -1, flags2: F2_GRASS });
  // WC-18: tile(13) TWO layered ENGRAVING records (north wall + south wall).
  records[13] = rec({ tt: 112, base_mt: 11, base_mi: 12, flags2: F2_ENGRAVING });
  // WC-19: tile(14) a priority-5 dig designation.
  records[14] = rec({ tt: 113, base_mt: 0, base_mi: -1, flags2: F2_DESIG_PRIORITY });
  // WC-21: tile(15) TWO layered VERMIN hits (a lone vermin + a colony on the same tile --
  // proves the client must handle >=1 hit per tile, same multi-record convention ENGRAVING
  // established).
  records[15] = rec({ tt: 114, base_mt: 0, base_mi: -1, flags2: F2_VERMIN });
  // WIRE-TAILS: tile(16) plant-identity SEEDS item ("OAK"); tile(17) creature-identity
  // CORPSE item ("DWARF") -- fresh tiles proving the additive ITEM-tail identity extension.
  records[16] = rec({ tt: 115, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  records[17] = rec({ tt: 116, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  // TIER-2 (asset/material-parity §4): tile(18) SMALLGEM inorganic-ident + shape; tile(19)
  // GEM shape-only (glass, no ident, spawned shape -1 -- the ambiguity case); tile(20) ROUGH
  // inorganic-ident, no shape. Mirrors src/wire_v1.cpp::build_selftest_fixture.
  records[18] = rec({ tt: 117, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  records[19] = rec({ tt: 118, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  records[20] = rec({ tt: 119, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  // ITEM QUALITY FAMILY (2026-07-09): tiles 21-26 exercise the additive quality block.
  records[21] = rec({ tt: 120, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  records[22] = rec({ tt: 121, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  records[23] = rec({ tt: 122, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  records[24] = rec({ tt: 123, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  records[25] = rec({ tt: 124, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  records[26] = rec({ tt: 125, base_mt: 0, base_mi: -1, flags2: F2_ITEM });
  // TX1 CONTAINER_PEEK: tile(27) wood BARREL + MEAT content; tile(28) wood BARREL + PLANT
  // content with cflags bit0 (subterranean); tile(29) BIN + BAR content mat_type 7 (COAL).
  // Real df::item_type ordinals (BARREL=17, BIN=32, MEAT=48, PLANT=54, BAR=0) -- load-
  // bearing for the client classifier. Mirrors src/wire_v1.cpp::build_selftest_fixture.
  records[27] = rec({ tt: 126, base_mt: 0, base_mi: -1, flags2: F2_ITEM | F2_CONTAINER_PEEK });
  records[28] = rec({ tt: 127, base_mt: 0, base_mi: -1, flags2: F2_ITEM | F2_CONTAINER_PEEK });
  records[29] = rec({ tt: 128, base_mt: 0, base_mi: -1, flags2: F2_ITEM | F2_CONTAINER_PEEK });
  const tails = [
    // WC-1: item(5) normal subtype + 3-bit iflags combo + plain stack; item(8) the
    // subtype==-1 sentinel + a single iflags bit + a stack>255 clamp (mirrors
    // src/wire_v1.cpp::build_selftest_fixture exactly).
    itemTail(5, 12, 34, 5678, 42, IFLAG_WEB | IFLAG_DUMP | IFLAG_ONFIRE, 5),
    plantTail(6, PART_TRUNK, "OAK"),
    // WC-11: tile(7)'s spatter now carries a mat_state byte (Liquid) -- amount/mat_type
    // unchanged (cache_test.mjs pins amount==5000/mat_type==9).
    spatterTail(7, 9, 10, 5000, 1 /*Liquid*/),
    itemTail(8, 1, 2, 3, -1, IFLAG_FORBID, 999),
    plantTail(8, PART_SHRUB, ""),
    // WC-11: tile(8) spatter's matter_state==-1 (None) sentinel byte, atop the pre-
    // existing amount>65535 clamp.
    spatterTail(8, 13, 14, 65535, -1 /*None sentinel*/),
    // WC-11: tile(9) two ITEM_SPATTER entries -- LEAVES then FRUIT_LARGE.
    itemSpatterTail(9, GROWTH_LEAVES, ITEM_TYPE_PLANT_GROWTH, 60),
    itemSpatterTail(9, GROWTH_FRUIT_LARGE, ITEM_TYPE_PLANT_GROWTH, 12),
    // WC-15: tile(10) a dense waterfall mist (flow_type=2 Mist).
    flowTail(10, 2 /*Mist*/, 180),
    // WC-11: tile(11) TWO layered material-spatter events -- Solid then Paste. The SECOND
    // (Paste) event also exercises the blood-family color extension's rgb bytes (a
    // synthetic resolved color -- the real encoder resolves this from MaterialInfo, this
    // fixture only proves the byte layout round-trips).
    spatterTail(11, 30, 31, 4000, 0 /*Solid*/),
    spatterTail(11, 40, 41, 1500, 4 /*Paste*/, [180, 20, 20] /*resolved blood-red*/),
    // WC-17: tile(12) grass coverage -- token "MEADOW-GRASS" (a real vanilla grass raw
    // id), amount=45.
    grassTail(12, "MEADOW-GRASS", 45),
    // WC-18: tile(13) north wall face (quality 3) then south wall face (quality 5) --
    // the client OR-combines eflags across records at one tile into a combined mask.
    engravingTail(13, 0x0008 /*north*/, 3),
    engravingTail(13, 0x0010 /*south*/, 5),
    // WC-19: tile(14) priority 5.
    desigPriorityTail(14, 5),
    // WC-21: tile(15) a lone vermin (race 200, caste 0, not a colony) then a colony hit
    // (race 210, caste 1, is_colony + large-swarm bits both set).
    verminTail(15, 200, 0, 0, "HONEY_BEE"),
    verminTail(15, 210, 1, VFLAG_COLONY | VFLAG_SWARM_LARGE, "ANT"),
    // WIRE-TAILS: tile(16) SEEDS item + PLANT identity "OAK"; tile(17) CORPSE item +
    // CREATURE identity "DWARF" (synthetic item_type bytes, mirrors src/wire_v1.cpp).
    itemTail(16, 40, 0, 0, -1, 0, 3, IDENT_PLANT, "OAK"),
    itemTail(17, 41, 0, 0, -1, 0, 1, IDENT_CREATURE, "DWARF"),
    // TIER-2: item_type ordinals here ARE load-bearing (the decoder keys gem shape off
    // SMALLGEM=1 / GEM=44). tile(18) ident+shape; tile(19) shape-only spawned glass gem;
    // tile(20) inorganic ident, no shape.
    itemTail(18, ITEM_TYPE_SMALLGEM, 0, 97, -1, 0, 1, IDENT_INORGANIC, "GREEN_ZIRCON", true, 7),
    itemTail(19, ITEM_TYPE_GEM, 3 /*GLASS_GREEN*/, 0, -1, 0, 1, 0, "", true, -1),
    itemTail(20, ITEM_TYPE_ROUGH, 0, 100, -1, 0, 1, IDENT_INORGANIC, "MICROCLINE"),
    // ITEM QUALITY FAMILY: q3; q5; q5+artifact; q0+wear1 (base-q0 row); q4+wear3; and
    // SMALLGEM ident "RUBY" + shape 3 + q5 + artifact (all extensions on one tail).
    itemTail(21, 12, 34, 5678, -1, 0, 1, 0, "", false, 0, true, 3, 0, 0),
    itemTail(22, 12, 34, 5678, -1, 0, 1, 0, "", false, 0, true, 5, 0, 0),
    itemTail(23, 12, 34, 5678, -1, 0, 1, 0, "", false, 0, true, 5, QFLAG_ARTIFACT, 0),
    itemTail(24, 12, 34, 5678, -1, 0, 1, 0, "", false, 0, true, 0, 0, 1),
    itemTail(25, 12, 34, 5678, -1, 0, 1, 0, "", false, 0, true, 4, 0, 3),
    itemTail(26, ITEM_TYPE_SMALLGEM, 0, 55, -1, 0, 1, IDENT_INORGANIC, "RUBY", true, 3, true, 5, QFLAG_ARTIFACT, 0),
    // TX1 CONTAINER_PEEK tails (see the tile 27-29 records comment above).
    itemTail(27, 17 /*BARREL*/, 420, 30, -1, 0, 1),
    containerPeekTail(27, 48 /*MEAT*/, 19, 5, -1, 0),
    itemTail(28, 17 /*BARREL*/, 420, 30, -1, 0, 1),
    containerPeekTail(28, 54 /*PLANT*/, 419, 12, -1, 0x01 /*subterranean*/),
    itemTail(29, 32 /*BIN*/, 420, 30, -1, 0, 1),
    containerPeekTail(29, 0 /*BAR*/, 7 /*builtin COAL*/, 0, -1, 0),
  ];
  return { bx: 1, by: 2, bz: 3, ver: 100, bflags: 0, records, tails };
}
// BLOCK C -- tail_count u16 regression proof (cachefix 2026-07-09). 256 GRASS tails + 4 ITEM
// tails at high tile_idx (250-253) = 260 tails; under the old u8 clamp every tail past 255 was
// truncated (the 4 items dropped server-side = the invisible-item cluster). Mirrors
// src/wire_v1.cpp::build_selftest_fixture's Block C.
function buildBlockC() {
  const records = [];
  for (let i = 0; i < 256; i++) {
    const over = { tt: 300, base_mt: 0, base_mi: -1, flags2: F2_GRASS };
    if (i >= 250 && i <= 253) over.flags2 |= F2_ITEM;
    records[i] = rec(over);
  }
  const tails = [];
  for (let i = 0; i < 256; i++) tails.push(grassTail(i, "MEADOW-GRASS", i & 0x3f));
  for (let k = 0; k < 4; k++) tails.push(itemTail(250 + k, 62 /*AMULET-ish*/, 0, 700 + k, -1, 0, 1));
  return { bx: 500, by: 60, bz: 9, ver: 300, bflags: 0, records, tails };
}
function buildBlockB() {
  const records = [];
  for (let i = 0; i < 256; i++) records[i] = floorRec(2);
  records[0] = rec({});                                          // void
  records[255] = rec({});                                        // void (edge)
  records[10] = rec({ tt: 201, base_mt: -1, base_mi: -1, flags2: F2_ITEM });
  records[128] = rec({ tt: 200, base_mt: 100, base_mi: 200, bits: packBits(2, 7, 1, 1) });
  // WC-1: all-negative mats + subtype -1 + zero iflags + a negative stack (clamps to 0).
  const tails = [itemTail(10, -1, -1, -1, -1, 0, -5)];
  return { bx: 300, by: 50, bz: 7, ver: 200, bflags: 0, records, tails };
}

function encodeBlock(b, buf) {
  buf.u16(b.bx); buf.u16(b.by); buf.u16(b.bz); buf.u32(b.ver);
  // tail_count is u16 LE (widened from u8, cachefix 2026-07-09).
  buf.u8(b.bflags); buf.u16(b.tails.length);
  for (const r of b.records) {
    buf.u16(r.tt); buf.i16(r.base_mt); buf.i16(r.base_mi);
    buf.u8(r.bits); buf.u8(r.desig1); buf.u8(r.desig2); buf.u8(r.spatter_amt); buf.u16(r.flags2);
  }
  for (const t of b.tails) { buf.u8(t.tile_idx); buf.u8(t.kind); buf.u8(t.data.length); buf.bytes(t.data); }
}

const WORLD_SEQ = 42;
const A = buildBlockA(), B = buildBlockB(), Cblk = buildBlockC();

const payload = new Buf();
payload.u32(WORLD_SEQ);
payload.u16(3);
encodeBlock(A, payload);
encodeBlock(B, payload);
encodeBlock(Cblk, payload);
const payloadBytes = payload.out();

const frame = new Buf();
frame.bytes([0x44, 0x35, 1, 0x01, 0x00, 0x00]); // magic 'D5', ver1, BLOCK_SET, flags0, rsvd0
frame.u32(1);                                    // seq
frame.bytes(payloadBytes);
const frameBytes = frame.out();

// Portable CRC32 (IEEE, reflected) -- matches src/wire_v1.cpp::crc32.
function crc32(u8) {
  let c, table = crc32.t;
  if (!table) {
    table = crc32.t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = table[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const crcVal = crc32(frameBytes) >>> 0;

// ---- expected decoded structure (language-agnostic reference) ---------------------
function expectedBlock(b) {
  const records = b.records.map((r) => ({
    tt: r.tt, base_mt: r.base_mt, base_mi: r.base_mi,
    liquid: r.bits & 3, flow: (r.bits >> 2) & 7, hidden: (r.bits >> 5) & 1, outside: (r.bits >> 6) & 1,
    dig: r.desig1 & 15, smooth: (r.desig1 >> 4) & 3, marker: (r.desig1 >> 6) & 1,
    traffic: r.desig2 & 3, track: (r.desig2 >> 2) & 15,
    spatter_amt: r.spatter_amt, flags2: r.flags2,
  }));
  const tails = b.tails.map((t) => {
    const dv = new DataView(t.data.buffer, t.data.byteOffset, t.data.length);
    let data;
    const len = t.data.length;
    // WC-3: decodeTailData (web/js/dwf-wire-v1.js) now reads the FULL extended byte
    // layout for ITEM (12 bytes: +subtype/iflags/stack) and SPATTER (9 bytes: +state), and
    // recognizes the two new kinds (FLOW, ITEM_SPATTER) WC-11/WC-15 added -- this
    // expectation is updated alongside it (same convention the prior NOTE here documented:
    // "WC-3/WC-12/WC-16 extend decodeTailData AND this expectation together").
    if (t.kind === TAIL_ITEM) {
      data = { item_type: dv.getInt16(0, true), mat_type: dv.getInt16(2, true), mat_index: dv.getInt32(4, true) };
      data.subtype = (len >= 10) ? dv.getInt16(8, true) : -1;
      const rawIflags = (len >= 11) ? dv.getUint8(10) : 0;
      data.iflags = rawIflags & 0x1f;   // mirror decoder: expose only the 5 real flag bits
      data.stack = (len >= 12) ? dv.getUint8(11) : 1;
      let extEnd = len;
      // ITEM QUALITY FAMILY: [quality|qflags|wear] carved off the END FIRST, keyed by iflags bit5.
      if ((rawIflags & 0x20) && extEnd >= 15) {
        data.quality = dv.getUint8(extEnd - 3);
        const qf = dv.getUint8(extEnd - 2);
        data.wear = dv.getUint8(extEnd - 1);
        data.artifact = (qf & 0x02) !== 0;
        data.qflags = qf;
        extEnd -= 3;
      }
      // TIER-2 gem shape: SMALLGEM/GEM tails carry a trailing shape i16 as the LAST 2 bytes of
      // what remains after the quality carve. Carve it next so identity parses only [12, extEnd).
      if ((data.item_type === ITEM_TYPE_SMALLGEM || data.item_type === ITEM_TYPE_GEM) && extEnd >= 14) {
        data.shape = dv.getInt16(extEnd - 2, true);
        extEnd -= 2;
      }
      // Item identity extension: `ident_kind u8 | idlen u8 | id bytes` after the 12-byte
      // body (present only when the middle region extends past it).
      if (extEnd >= 14) {
        const ik = dv.getUint8(12), il = dv.getUint8(13);
        if (ik !== 0 && il > 0 && extEnd >= 14 + il) {
          let tok = ""; for (let i = 0; i < il; i++) tok += String.fromCharCode(dv.getUint8(14 + i));
          data.identKind = ik; data.ident = tok;
        }
      }
    } else if (t.kind === TAIL_PLANT) {
      const idLen = dv.getUint8(1); let id = ""; for (let i = 0; i < idLen; i++) id += String.fromCharCode(dv.getUint8(2 + i)); data = { part: dv.getUint8(0), id };
    } else if (t.kind === TAIL_SPATTER) {
      data = { mat_type: dv.getInt16(0, true), mat_index: dv.getInt32(2, true), amount: dv.getUint16(6, true) };
      data.state = (len >= 9) ? dv.getInt8(8) : -1;
      // blood-family color extension: `has_rgb u8` + (r,g,b u8) AFTER the state byte,
      // present only when len>=13.
      if (len >= 13 && dv.getUint8(9) !== 0) {
        data.rgb = [dv.getUint8(10), dv.getUint8(11), dv.getUint8(12)];
      }
    } else if (t.kind === TAIL_FLOW && len >= 2) {
      data = { flow_type: dv.getUint8(0), density: dv.getUint8(1) };
    } else if (t.kind === TAIL_ITEM_SPATTER && len >= 3) {
      data = { growth_class: dv.getUint8(0), item_type: dv.getUint8(1), amount: dv.getUint8(2) };
    } else if (t.kind === TAIL_GRASS && len >= 1) {
      const gidLen = dv.getUint8(0); let gid = ""; for (let gi = 0; gi < gidLen; gi++) gid += String.fromCharCode(dv.getUint8(1 + gi));
      data = { id: gid, amount: dv.getUint8(1 + gidLen) };
    } else if (t.kind === TAIL_ENGRAVING && len >= 3) {
      data = { eflags: dv.getUint16(0, true), quality: dv.getUint8(2) };
    } else if (t.kind === TAIL_DESIG_PRIORITY && len >= 1) {
      data = { priority: dv.getUint8(0) };
    } else if (t.kind === TAIL_CONTAINER_PEEK && len >= 8) {
      // TX1: same defensive-by-len read the decoder uses (subtype/cflags optional).
      data = { item_type: dv.getInt16(0, true), mat_type: dv.getInt16(2, true), mat_index: dv.getInt32(4, true) };
      data.subtype = (len >= 10) ? dv.getInt16(8, true) : -1;
      data.cflags = (len >= 11) ? dv.getUint8(10) : 0;
    } else if (t.kind === TAIL_VERMIN && len >= 4) {
      data = { race: dv.getUint16(0, true), caste: dv.getUint8(2), vflags: dv.getUint8(3) };
      // Vermin identity extension: resolved creature token (idlen u8 + bytes) after 4 bytes.
      if (len >= 6) {
        const vl = dv.getUint8(4);
        if (vl > 0 && len >= 5 + vl) {
          let vtok = ""; for (let i = 0; i < vl; i++) vtok += String.fromCharCode(dv.getUint8(5 + i));
          data.token = vtok;
        }
      }
    } else {
      data = { raw: true };
    }
    return { tile_idx: t.tile_idx, kind: t.kind, len: t.data.length, data };
  });
  return { bx: b.bx, by: b.by, bz: b.bz, ver: b.ver, bflags: b.bflags, records, tails };
}
const expected = {
  header: { ver: 1, type: 0x01, flags: 0, seq: 1, deflated: false },
  world_seq: WORLD_SEQ, block_count: 3,
  blocks: [expectedBlock(A), expectedBlock(B), expectedBlock(Cblk)],
};

fs.mkdirSync(FIX_DIR, { recursive: true });
fs.writeFileSync(path.join(FIX_DIR, "wire_fixture.bin"), Buffer.from(frameBytes));
fs.writeFileSync(path.join(FIX_DIR, "wire_fixture.expected.json"), JSON.stringify(expected, null, 1));

console.log(`wrote wire_fixture.bin  ${frameBytes.length} bytes (payload ${payloadBytes.length})`);
console.log(`records=${(A.records.length + B.records.length + Cblk.records.length)} tails=${A.tails.length + B.tails.length + Cblk.tails.length} (A=${A.tails.length} B=${B.tails.length} C=${Cblk.tails.length})`);
console.log(`CRC32 = 0x${crcVal.toString(16).toUpperCase().padStart(8, "0")}`);
