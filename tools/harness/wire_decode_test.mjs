// wire_decode_test.mjs -- WA-8 acceptance deliverable (protocol v1, Part 0).
//
// Loads the REAL client decoder web/js/dwf-wire-v1.js verbatim (vm.runInThisContext,
// the same load path WA-12's worker uses via importScripts) and decodes the committed
// golden fixture tools/harness/fixtures/wire_fixture.bin, asserting every field of every
// one of the 512 tile records + all sparse tails against fixtures/wire_fixture.expected.json.
//
// The fixture is produced by TWO independent encoders that must agree byte-for-byte:
//   - src/wire_v1.cpp::build_selftest_fixture (validated live by `capture-wire-selftest`)
//   - tools/harness/gen_wire_fixture.mjs (regenerates this .bin)
//
// Run: node tools/harness/wire_decode_test.mjs [path-to-fixture.bin]
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DECODER_PATH = path.resolve(__dirname, "../../web/js/dwf-wire-v1.js");
const FIX_BIN = process.argv[2] || path.resolve(__dirname, "fixtures/wire_fixture.bin");
const FIX_JSON = path.resolve(__dirname, "fixtures/wire_fixture.expected.json");

// ---- load the decoder module verbatim into this global scope --------------------
vm.runInThisContext(fs.readFileSync(DECODER_PATH, "utf8"), { filename: DECODER_PATH });
const W = globalThis.DwfWireV1;
assert(W && typeof W.decodeBlockSet === "function", "decoder module did not attach DwfWireV1");
assert.equal(typeof W.formatItemName, "function", "decoder exports native item-text formatter");

const bin = new Uint8Array(fs.readFileSync(FIX_BIN));
const expected = JSON.parse(fs.readFileSync(FIX_JSON, "utf8"));

// ---- header (§0.2) ---------------------------------------------------------------
const hdr = W.decodeHeader(bin);
assert(hdr, "header decode failed (magic/version)");
assert.equal(hdr.ver, expected.header.ver, "ver");
assert.equal(hdr.type, expected.header.type, "type");
assert.equal(hdr.flags, expected.header.flags, "flags");
assert.equal(hdr.seq, expected.header.seq, "seq");
assert.equal(hdr.deflated, expected.header.deflated, "deflated");

// payload is uncompressed in this fixture (< 8 KiB), so slice directly.
assert.equal(hdr.deflated, false, "golden fixture must be uncompressed");
const payload = bin.subarray(hdr.payloadOffset);
const decoded = W.decodeBlockSet(payload);

assert.equal(decoded.world_seq, expected.world_seq, "world_seq");
assert.equal(decoded.block_count, expected.block_count, "block_count");
assert.equal(decoded.consumed, payload.length, "payload fully consumed (no trailing bytes)");

let recordCount = 0;
let tailCount = 0;
for (let b = 0; b < expected.block_count; b++) {
  const eb = expected.blocks[b];
  const db = decoded.blocks[b];
  for (const k of ["bx", "by", "bz", "ver", "bflags"]) assert.equal(db[k], eb[k], `block ${b} ${k}`);
  assert.equal(db.records.length, 256, `block ${b} record count`);
  for (let i = 0; i < 256; i++) {
    const er = eb.records[i], dr = db.records[i];
    for (const k of ["tt", "base_mt", "base_mi", "liquid", "flow", "hidden", "outside",
                     "dig", "smooth", "marker", "traffic", "track", "spatter_amt", "flags2"]) {
      assert.equal(dr[k], er[k], `block ${b} rec ${i} field ${k}: got ${dr[k]} want ${er[k]}`);
    }
    recordCount++;
  }
  assert.equal(db.tails.length, eb.tails.length, `block ${b} tail count`);
  for (let t = 0; t < eb.tails.length; t++) {
    const et = eb.tails[t], dt = db.tails[t];
    assert.equal(dt.tile_idx, et.tile_idx, `block ${b} tail ${t} tile_idx`);
    assert.equal(dt.kind, et.kind, `block ${b} tail ${t} kind`);
    assert.deepEqual(dt.data, et.data, `block ${b} tail ${t} data`);
    tailCount++;
  }
}

// spot-check the flagged special cases decode to real values (readability guard).
const A = decoded.blocks[0];
assert.equal(A.records[0].tt, 0xffff, "A[0] void tt");
assert.equal(A.records[1].liquid, 1, "A[1] water"); assert.equal(A.records[1].flow, 7, "A[1] flow7");
assert.equal(A.records[2].liquid, 2, "A[2] magma"); assert.equal(A.records[2].flow, 3, "A[2] flow3");
assert.equal(A.records[3].hidden, 1, "A[3] hidden");
assert.equal(A.records[4].dig, 6, "A[4] dig"); assert.equal(A.records[4].track, 15, "A[4] track");
assert.deepEqual(A.tails.find((t) => t.tile_idx === 6).data, { part: 0, id: "OAK" }, "A[6] plant OAK");
assert.equal(A.records[8].spatter_amt, 255, "A[8] clamp");
const B = decoded.blocks[1];
assert.equal(B.tails[0].data.item_type, -1, "B[10] negative item_type");
assert.equal(B.bx, 300, "B bx u16 > 255");

// ---- WC-1: ITEM tail subtype/iflags/stack (independent re-parse, byte-precise) -------
// decodeTailData (the shared, UNMODIFIED web/js decoder) only reads the original 8-byte
// prefix -- that's intentional forward-compat (see gen_wire_fixture.mjs's NOTE), so it's
// verified above via the plain deepEqual. The WC-1 extension (subtype i16 @ +8, iflags u8
// @ +10, stack u8 @ +11) is walked here directly off the raw payload bytes, independent of
// dwf-wire-v1.js, to prove the wire's byte layout without touching that file (WC-1
// is server+fixture only; client parsing of these fields is WC-3).
function reparseItemTails(payloadBytes) {
  const dv2 = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.length);
  const blockCount = dv2.getUint16(4, true);
  let o2 = 6;
  const out = [];
  for (let b = 0; b < blockCount; b++) {
    o2 += 2 + 2 + 2 + 4;               // bx, by, bz, ver
    const tailCount = dv2.getUint16(o2 + 1, true); o2 += 3;   // bflags u8, tail_count u16 LE
    o2 += 256 * 12;                     // tile records
    const tails = [];
    for (let t = 0; t < tailCount; t++) {
      const tile_idx = dv2.getUint8(o2), kind = dv2.getUint8(o2 + 1), len = dv2.getUint8(o2 + 2);
      const off = o2 + 3;
      if (kind === 0x01 && len >= 12) {
        const rawIflags = dv2.getUint8(off + 10);
        const rec = {
          tile_idx, kind, len,
          item_type: dv2.getInt16(off, true), mat_type: dv2.getInt16(off + 2, true),
          mat_index: dv2.getInt32(off + 4, true), subtype: dv2.getInt16(off + 8, true),
          iflags: rawIflags & 0x1f, stack: dv2.getUint8(off + 11),
        };
        let extEnd = len;
        // ITEM QUALITY FAMILY: [quality|qflags|wear] carved off the END FIRST, keyed by iflags bit5.
        if ((rawIflags & 0x20) && extEnd >= 15) {
          rec.quality = dv2.getUint8(off + extEnd - 3);
          const qf = dv2.getUint8(off + extEnd - 2);
          rec.wear = dv2.getUint8(off + extEnd - 1);
          rec.artifact = (qf & 0x02) !== 0;
          extEnd -= 3;
        }
        // TIER-2 gem shape: SMALLGEM(1)/GEM(44) tails carry a trailing shape i16 as the LAST 2
        // bytes of what remains -- carve next so identity below parses only the middle [12, extEnd).
        if ((rec.item_type === 1 /*SMALLGEM*/ || rec.item_type === 44 /*GEM*/) && extEnd >= 14) {
          rec.shape = dv2.getInt16(off + extEnd - 2, true);
          extEnd -= 2;
        }
        // Item identity extension (WIRE-TAILS): `ident_kind u8 | idlen u8 | id bytes`
        // after the 12-byte body, present only when the tail extends past it.
        if (extEnd >= 14) {
          const ik = dv2.getUint8(off + 12), il = dv2.getUint8(off + 13);
          if (ik !== 0 && il > 0 && extEnd >= 14 + il) {
            let tok = ""; for (let i = 0; i < il; i++) tok += String.fromCharCode(dv2.getUint8(off + 14 + i));
            rec.identKind = ik; rec.ident = tok;
          }
        }
        tails.push(rec);
      }
      o2 += 3 + len;
    }
    out.push(tails);
  }
  return out;
}
const itemExt = reparseItemTails(payload);
assert.equal(itemExt[0].length, 16, "block A has 16 ITEM tails (2 WC-1 + 2 identity + 3 Tier-2 + 6 quality + 3 TX1 containers)");
const a5 = itemExt[0].find((t) => t.tile_idx === 5);
assert.equal(a5.subtype, 42, "A[5] subtype");
assert.equal(a5.iflags, 0x15, "A[5] iflags (web|dump|on_fire)");
assert.equal(a5.stack, 5, "A[5] stack");
assert.equal(a5.identKind, undefined, "A[5] carries NO identity (stays 12 bytes -- additive/optional)");
assert.equal(a5.len, 12, "A[5] ident-less ITEM tail is exactly 12 bytes");
const a8 = itemExt[0].find((t) => t.tile_idx === 8);
assert.equal(a8.subtype, -1, "A[8] subtype sentinel (-1)");
assert.equal(a8.iflags, 0x02, "A[8] iflags (forbid)");
assert.equal(a8.stack, 255, "A[8] stack clamp (999 -> 255)");
// Item identity extension: A[16] plant "OAK", A[17] creature "DWARF".
const a16 = itemExt[0].find((t) => t.tile_idx === 16);
assert.equal(a16.identKind, 1, "A[16] identKind = plant");
assert.equal(a16.ident, "OAK", "A[16] plant ident token");
const a17 = itemExt[0].find((t) => t.tile_idx === 17);
assert.equal(a17.identKind, 2, "A[17] identKind = creature");
assert.equal(a17.ident, "DWARF", "A[17] creature ident token");
assert.equal(itemExt[1].length, 1, "block B has 1 ITEM tail");
const b10 = itemExt[1][0];
assert.equal(b10.subtype, -1, "B[10] subtype (-1)");
assert.equal(b10.iflags, 0, "B[10] iflags (none)");
assert.equal(b10.stack, 0, "B[10] stack clamp (-5 -> 0)");
assert.equal(b10.identKind, undefined, "B[10] carries no identity");
console.log("PASS WC-1 + WIRE-TAILS ITEM identity (A[5]/A[8] ident-less, A[16] plant OAK, A[17] creature DWARF, B[10])");

// ---- TIER-2: inorganic identity (ident_kind 3) + cut-gem shape ----------------------
// tile(18) SMALLGEM carries BOTH an inorganic ident ("GREEN_ZIRCON") AND a shape (7);
// tile(19) GEM is the ambiguity case -- shape-only (spawned -1) glass gem with NO ident,
// where the shape's 0xFFFF sits exactly where an ident_kind byte would; the decoder must
// still report NO identity and shape -1. tile(20) ROUGH carries an inorganic ident
// ("MICROCLINE") but NO shape (ROUGH has no shape field). Verified via BOTH the raw
// reparse (below) and the shared decoder (further down) -- two independent decoders.
const a18 = itemExt[0].find((t) => t.tile_idx === 18);
assert.equal(a18.item_type, 1, "A[18] item_type SMALLGEM");
assert.equal(a18.identKind, 3, "A[18] identKind = inorganic");
assert.equal(a18.ident, "GREEN_ZIRCON", "A[18] inorganic ident token");
assert.equal(a18.shape, 7, "A[18] cut-gem shape (ident + shape both present)");
const a19 = itemExt[0].find((t) => t.tile_idx === 19);
assert.equal(a19.item_type, 44, "A[19] item_type GEM");
assert.equal(a19.identKind, undefined, "A[19] shape-only glass gem carries NO identity (ambiguity resolved)");
assert.equal(a19.shape, -1, "A[19] spawned/uncut shape sentinel (-1) with no identity");
assert.equal(a19.len, 14, "A[19] tail is 12-byte body + 2-byte shape only");
const a20 = itemExt[0].find((t) => t.tile_idx === 20);
assert.equal(a20.item_type, 3, "A[20] item_type ROUGH");
assert.equal(a20.identKind, 3, "A[20] identKind = inorganic");
assert.equal(a20.ident, "MICROCLINE", "A[20] inorganic ident token");
assert.equal(a20.shape, undefined, "A[20] ROUGH has NO shape (non-gem item_type)");

// TEST-THE-TEST (completeness protocol rule 3): the shape assertions must be reading the
// REAL wire byte, not a constant. Mutate tile(18)'s shape byte in a payload copy, re-parse,
// and assert the decoded shape CHANGED and the (later-positioned) ident is unaffected.
{
  const mutated = Uint8Array.from(payload);
  const dvm = new DataView(mutated.buffer, mutated.byteOffset, mutated.length);
  // Walk block A's tails to locate tile(18)'s shape bytes (= last 2 bytes of its tail).
  // Mirrors reparseItemTails' offset math: payload = world_seq(4)+block_count(2), then per
  // block bx+by+bz+ver (2+2+2+4=10) -> bflags -> tail_count -> 256*12 record bytes.
  let oScan = 6 + 10;                      // start of block A's (bflags, tail_count)
  const tailCountA = dvm.getUint16(oScan + 1, true); oScan += 3 + 256 * 12;  // bflags u8 + tail_count u16
  let shapeOff = -1;
  for (let t = 0; t < tailCountA; t++) {
    const tIdx = dvm.getUint8(oScan), tLen = dvm.getUint8(oScan + 2);
    if (tIdx === 18) { shapeOff = oScan + 3 + tLen - 2; }
    oScan += 3 + tLen;
  }
  assert(shapeOff > 0, "test-the-test located tile(18) shape offset");
  dvm.setInt16(shapeOff, 21, true);        // 7 -> 21
  const mutExt = reparseItemTails(mutated);
  const m18 = mutExt[0].find((t) => t.tile_idx === 18);
  assert.equal(m18.shape, 21, "TEST-THE-TEST: mutated shape byte flips the decode 7 -> 21 (assertion is live)");
  assert.equal(m18.ident, "GREEN_ZIRCON", "TEST-THE-TEST: ident (parsed from the MIDDLE) survives a shape-byte mutation");
  assert.notEqual(m18.shape, a18.shape, "TEST-THE-TEST: a wrong-encode shape would FAIL the golden assertion");
}
console.log("PASS TIER-2 inorganic ident (A[18]/A[20]) + cut-gem shape (A[18]=7, A[19]=-1 glass, A[20] none) + test-the-test");

// ---- ITEM QUALITY FAMILY (2026-07-09): quality/artifact/wear additive block ------
// Verified via BOTH the raw reparse (itemExt, quality-aware above) AND the shared decoder
// (W.decodeBlockSet -> A.tails, which now parses quality/wear/artifact). The block rides at the
// tail END (after identity + gem-shape), keyed by iflags bit5; a plain item omits it entirely.
const q21 = itemExt[0].find((t) => t.tile_idx === 21);
assert.equal(q21.quality, 3, "A[21] quality 3 (fine)");
assert.equal(q21.artifact, false, "A[21] not an artifact");
assert.equal(q21.wear, 0, "A[21] wear 0");
const q22 = itemExt[0].find((t) => t.tile_idx === 22);
assert.equal(q22.quality, 5, "A[22] quality 5 (masterwork)");
const q23 = itemExt[0].find((t) => t.tile_idx === 23);
assert.equal(q23.quality, 5, "A[23] quality 5"); assert.equal(q23.artifact, true, "A[23] ARTIFACT flag set");
const q24 = itemExt[0].find((t) => t.tile_idx === 24);
assert.equal(q24.quality, 0, "A[24] quality 0 (base-q0 row, block still present)");
assert.equal(q24.wear, 1, "A[24] wear 1");
const q25 = itemExt[0].find((t) => t.tile_idx === 25);
assert.equal(q25.quality, 4, "A[25] quality 4"); assert.equal(q25.wear, 3, "A[25] wear 3 (worn)");
// tile 26: ALL extensions on one gem tail -- inorganic ident + shape + quality(+artifact).
const q26 = itemExt[0].find((t) => t.tile_idx === 26);
assert.equal(q26.item_type, 1, "A[26] SMALLGEM");
assert.equal(q26.quality, 5, "A[26] quality 5"); assert.equal(q26.artifact, true, "A[26] artifact");
assert.equal(q26.shape, 3, "A[26] gem shape 3 (carved between quality and identity)");
assert.equal(q26.identKind, 3, "A[26] inorganic identKind"); assert.equal(q26.ident, "RUBY", "A[26] ident RUBY");
// Preserved old-format cell: A[5] carries NO quality block (stays 12 bytes -- additive/optional).
assert.equal(itemExt[0].find((t) => t.tile_idx === 5).quality, undefined, "A[5] has NO quality block (back-compat 12-byte tail)");
// Shared decoder agrees on the quality fields (two independent decoders).
const s23 = A.tails.find((t) => t.tile_idx === 23 && t.kind === W.C.TAIL_ITEM);
assert.equal(s23.data.quality, 5, "shared decoder A[23] quality 5");
assert.equal(s23.data.artifact, true, "shared decoder A[23] artifact");
assert.equal(A.tails.find((t) => t.tile_idx === 5 && t.kind === W.C.TAIL_ITEM).data.quality, undefined,
  "shared decoder A[5] carries NO quality (additive back-compat)");
// TEST-THE-TEST (rule 3): mutate A[23]'s qflags byte and A[26]'s quality byte; assert the
// decode tracks the wire and the OTHER extensions survive (proves live reads, not constants).
{
  const mutated = Uint8Array.from(payload);
  const dvm = new DataView(mutated.buffer, mutated.byteOffset, mutated.length);
  let oScan = 6 + 10;
  const tcA = dvm.getUint16(oScan + 1, true); oScan += 3 + 256 * 12;
  let q23qfOff = -1, q26qOff = -1;
  for (let t = 0; t < tcA; t++) {
    const tIdx = dvm.getUint8(oScan), tLen = dvm.getUint8(oScan + 2);
    if (tIdx === 23) q23qfOff = oScan + 3 + tLen - 2;   // qflags = 2nd-from-last byte
    if (tIdx === 26) q26qOff  = oScan + 3 + tLen - 3;   // quality = 3rd-from-last byte
    oScan += 3 + tLen;
  }
  assert(q23qfOff > 0 && q26qOff > 0, "test-the-test located quality byte offsets");
  dvm.setUint8(q23qfOff, 0);   // clear the artifact bit
  dvm.setUint8(q26qOff, 2);    // 5 -> 2
  const m = reparseItemTails(mutated);
  assert.equal(m[0].find((t) => t.tile_idx === 23).artifact, false, "TEST-THE-TEST: cleared qflags byte flips artifact true->false");
  const m26 = m[0].find((t) => t.tile_idx === 26);
  assert.equal(m26.quality, 2, "TEST-THE-TEST: mutated quality byte flips 5->2 (live read)");
  assert.equal(m26.shape, 3, "TEST-THE-TEST: gem shape survives a quality-byte mutation");
  assert.equal(m26.ident, "RUBY", "TEST-THE-TEST: identity survives a quality-byte mutation");
}
console.log("PASS ITEM QUALITY FAMILY (A[21-26] quality/artifact/wear, gem-combined A[26], back-compat A[5]) + test-the-test");

// ---- ITEM QUALITY TEXT: native wrappers belong on names, never map sprites ---------------
// Quality zero deliberately has no wrapper. Wear encloses the quality wrapper, and artifact
// names remain their real proper names instead of getting a synthetic masterwork mark.
const qualityNames = [
  [0, "steel helm"],
  [1, "-steel helm-"],
  [2, "+steel helm+"],
  [3, "*steel helm*"],
  [4, "≡steel helm≡"],
  [5, "☼steel helm☼"],
];
for (const [quality, want] of qualityNames) {
  assert.equal(W.formatItemName("steel helm", { quality, wear: 0 }), want,
    `quality ${quality} renders the native wrapper`);
}
assert.equal(W.formatItemName("linen dress", { quality: 2, wear: 1 }), "x+linen dress+x",
  "wear 1 encloses quality with x");
assert.equal(W.formatItemName("linen dress", { quality: 3, wear: 2 }), "X*linen dress*X",
  "wear 2 encloses quality with X");
assert.equal(W.formatItemName("linen dress", { quality: 4, wear: 3 }), "XX≡linen dress≡XX",
  "wear 3 encloses quality with XX");
assert.equal(W.formatItemName("The Gleaming Cudgel", { quality: 5, artifact: true, wear: 0 }),
  "The Gleaming Cudgel", "artifact proper name remains unwrapped");
console.log("PASS ITEM QUALITY TEXT (0-5 wrappers, artifact proper name, wear x/X/XX)");

// ---- ITEM 1 REGRESSION: tail_count u16 kills the invisible-item cluster --------------
// Block C carries 256 GRASS tails (one per tile) + 4 ITEM tails at high tile_idx (250-253) =
// 260 tails. Under the OLD u8 tail_count clamp only the first 255 rode the wire; grass[255] and
// ALL FOUR items (positions 256-259) were truncated SERVER-SIDE -- exactly the invisible-item
// symptom. The widened u16 count carries all 260; each item's unique mat_index (700+k) confirms
// it survived past the old cap.
assert.equal(decoded.block_count, 3, "fixture now carries 3 blocks (Block C added for the u16 proof)");
const Cblk = decoded.blocks[2];
assert.equal(Cblk.bx, 500, "Block C bx"); assert.equal(Cblk.bz, 9, "Block C bz");
assert.equal(Cblk.tails.length, 260, "Block C decodes ALL 260 tails (256 grass + 4 high-idx items)");
assert(Cblk.tails.length > 255, "Block C exceeds the OLD u8 cap -- the 4 items live PAST position 255");
const cGrass = Cblk.tails.filter((t) => t.kind === W.C.TAIL_GRASS);
assert.equal(cGrass.length, 256, "Block C has 256 GRASS tails");
for (let k = 0; k < 4; k++) {
  const cItem = Cblk.tails.find((t) => t.tile_idx === 250 + k && t.kind === W.C.TAIL_ITEM);
  assert(cItem, `Block C item at tile ${250 + k} present (would be truncated under u8)`);
  assert.equal(cItem.data.mat_index, 700 + k, `Block C item ${250 + k} mat_index ${700 + k} (byte-verified survival)`);
}
// TEST-THE-TEST (rule 3): the 4 items sit at tail positions 256-259. Prove that a u8-clamped
// re-encode (only the first 255 tails) would DROP every one of them -- i.e. the assertions above
// depend on the u16 width, not on the items happening to be early in the array.
{
  const itemPositions = Cblk.tails
    .map((t, i) => ({ i, t }))
    .filter((e) => e.t.kind === W.C.TAIL_ITEM && e.t.tile_idx >= 250 && e.t.tile_idx <= 253)
    .map((e) => e.i);
  assert.equal(itemPositions.length, 4, "test-the-test located the 4 Block C item positions");
  assert(itemPositions.every((p) => p >= 255), "TEST-THE-TEST: all 4 items sit at/after position 255 -> a u8 (255) clamp truncates every one");
}
console.log("PASS tail_count u16 regression (Block C 260 tails, 4 high-idx items survive the old 255 cap) + test-the-test");

// ---- WC-11/WC-15: SPATTER-state / ITEM_SPATTER / FLOW (independent re-parse) --------
// Same convention as WC-1 above: decodeTailData is left UNMODIFIED (client apply is
// WC-12/WC-16, not this item), so kinds 0x04 (FLOW) and 0x05 (ITEM_SPATTER) come back as
// {raw:true} from the shared decoder (asserted already via the plain deepEqual loop
// above), and the extra 9th SPATTER byte (mat_state) is invisible to it too. This walks
// the raw payload bytes directly to prove the wire's byte layout for all three additions.
const TAIL_SPATTER = 0x03, TAIL_FLOW = 0x04, TAIL_ITEM_SPATTER = 0x05;
function reparseAllTails(payloadBytes) {
  const dv2 = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.length);
  const blockCount = dv2.getUint16(4, true);
  let o2 = 6;
  const out = [];
  for (let b = 0; b < blockCount; b++) {
    o2 += 2 + 2 + 2 + 4;               // bx, by, bz, ver
    const tailCount = dv2.getUint16(o2 + 1, true); o2 += 3;   // bflags u8, tail_count u16 LE
    o2 += 256 * 12;                     // tile records
    const tails = [];
    for (let t = 0; t < tailCount; t++) {
      const tile_idx = dv2.getUint8(o2), kind = dv2.getUint8(o2 + 1), len = dv2.getUint8(o2 + 2);
      const off = o2 + 3;
      if (kind === TAIL_SPATTER && len >= 9) {
        tails.push({ tile_idx, kind, len,
          mat_type: dv2.getInt16(off, true), mat_index: dv2.getInt32(off + 2, true),
          amount: dv2.getUint16(off + 6, true), state: dv2.getInt8(off + 8) });
      } else if (kind === TAIL_ITEM_SPATTER && len >= 3) {
        tails.push({ tile_idx, kind, len,
          growth_class: dv2.getUint8(off), item_type: dv2.getUint8(off + 1), amount: dv2.getUint8(off + 2) });
      } else if (kind === TAIL_FLOW && len >= 2) {
        tails.push({ tile_idx, kind, len, flow_type: dv2.getUint8(off), density: dv2.getUint8(off + 1) });
      }
      o2 += 3 + len;
    }
    out.push(tails);
  }
  return out;
}
const allExt = reparseAllTails(payload);
const A_ext = allExt[0];

// SPATTER: tile(7) carries a single event now extended with a mat_state byte (Liquid);
// tile(8) exercises the matter_state==-1 (None) sentinel byte (0xFF decoded back to -1);
// tile(11) (kept off 7/8 so the pre-existing cache_test.mjs single-event pins survive)
// carries 2 layered events (Solid then Paste).
const spatterAt7 = A_ext.find((t) => t.tile_idx === 7 && t.kind === TAIL_SPATTER);
assert.equal(spatterAt7.mat_type, 9, "A[7] mat_type"); assert.equal(spatterAt7.amount, 5000, "A[7] amount");
assert.equal(spatterAt7.state, 1, "A[7] state Liquid");
const spatterAt8 = A_ext.find((t) => t.tile_idx === 8 && t.kind === TAIL_SPATTER);
assert.equal(spatterAt8.amount, 65535, "A[8] spatter amount clamp");
assert.equal(spatterAt8.state, -1, "A[8] spatter state None sentinel (0xFF -> -1)");
const spatterAt11 = A_ext.filter((t) => t.tile_idx === 11 && t.kind === TAIL_SPATTER);
assert.equal(spatterAt11.length, 2, "A[11] has 2 SPATTER tails");
assert.equal(spatterAt11[0].mat_type, 30, "A[11][0] mat_type"); assert.equal(spatterAt11[0].state, 0, "A[11][0] state Solid");
assert.equal(spatterAt11[1].mat_type, 40, "A[11][1] mat_type"); assert.equal(spatterAt11[1].state, 4, "A[11][1] state Paste");

// ITEM_SPATTER: tile(9) carries 2 entries (LEAVES then FRUIT_LARGE growth_class).
const ispAt9 = A_ext.filter((t) => t.tile_idx === 9 && t.kind === TAIL_ITEM_SPATTER);
assert.equal(ispAt9.length, 2, "A[9] has 2 ITEM_SPATTER tails");
assert.equal(ispAt9[0].growth_class, 1, "A[9][0] growth_class LEAVES");
assert.equal(ispAt9[0].amount, 60, "A[9][0] amount");
assert.equal(ispAt9[1].growth_class, 4, "A[9][1] growth_class FRUIT_LARGE");
assert.equal(ispAt9[1].amount, 12, "A[9][1] amount");

// FLOW: tile(10) carries one Mist (flow_type=2) entry at density=180.
const flowAt10 = A_ext.find((t) => t.tile_idx === 10 && t.kind === TAIL_FLOW);
assert(flowAt10, "A[10] has a FLOW tail");
assert.equal(flowAt10.flow_type, 2, "A[10] flow_type Mist");
assert.equal(flowAt10.density, 180, "A[10] density");

console.log("PASS WC-11 SPATTER state + ITEM_SPATTER growth_class + WC-15 FLOW (raw re-parse)");

// ---- WC-17/WC-18: GRASS + ENGRAVING -------------------------------------------------
// Unlike WC-11/WC-15 above, these two kinds ARE already recognized by the shared
// decodeTailData (this item ships full client apply, not just the wire half), so the
// plain deepEqual loop at the top already proved their byte layout via W.decodeBlockSet.
// These are readability spot-checks on top of that, same convention as the WC-1 section.
const grassAt12 = A.tails.find((t) => t.tile_idx === 12 && t.kind === W.C.TAIL_GRASS);
assert(grassAt12, "A[12] has a GRASS tail");
assert.equal(grassAt12.data.id, "MEADOW-GRASS", "A[12] grass token id");
assert.equal(grassAt12.data.amount, 45, "A[12] grass amount");

const engravingsAt13 = A.tails.filter((t) => t.tile_idx === 13 && t.kind === W.C.TAIL_ENGRAVING);
assert.equal(engravingsAt13.length, 2, "A[13] has 2 ENGRAVING tails (north + south wall faces)");
assert.equal(engravingsAt13[0].data.eflags, 0x0008, "A[13][0] eflags north");
assert.equal(engravingsAt13[0].data.quality, 3, "A[13][0] quality");
assert.equal(engravingsAt13[1].data.eflags, 0x0010, "A[13][1] eflags south");
assert.equal(engravingsAt13[1].data.quality, 5, "A[13][1] quality");

console.log("PASS WC-17 GRASS + WC-18 ENGRAVING (shared decoder, multi-record-per-tile)");

// ---- WC-19/WC-21/blood-family: DESIG_PRIORITY + VERMIN + resolved-rgb SPATTER --------
// All three are recognized by the shared decodeTailData (updated this commit), so these
// are shared-decoder spot-checks, same convention as the WC-17/18 section above.
const prioAt14 = A.tails.find((t) => t.tile_idx === 14 && t.kind === W.C.TAIL_DESIG_PRIORITY);
assert(prioAt14, "A[14] has a DESIG_PRIORITY tail");
assert.equal(prioAt14.data.priority, 5, "A[14] priority");

const verminAt15 = A.tails.filter((t) => t.tile_idx === 15 && t.kind === W.C.TAIL_VERMIN);
assert.equal(verminAt15.length, 2, "A[15] has 2 VERMIN tails (lone + colony)");
assert.equal(verminAt15[0].data.race, 200, "A[15][0] race"); assert.equal(verminAt15[0].data.caste, 0, "A[15][0] caste");
assert.equal(verminAt15[0].data.vflags, 0, "A[15][0] vflags (not a colony)");
assert.equal(verminAt15[1].data.race, 210, "A[15][1] race");
assert.equal(verminAt15[1].data.vflags, W.C.VFLAG_COLONY | W.C.VFLAG_SWARM_LARGE, "A[15][1] vflags (colony+large swarm)");
// Vermin identity extension (WIRE-TAILS): the server-resolved creature token rides after
// the 4-byte body -- the wcclient handoff's race-index->token blocker, closed on the wire.
assert.equal(verminAt15[0].data.token, "HONEY_BEE", "A[15][0] resolved vermin token");
assert.equal(verminAt15[1].data.token, "ANT", "A[15][1] resolved colony token");

// blood-family color extension: A[11]'s SECOND spatter event (Paste) carries a resolved
// rgb; the FIRST (Solid) does not -- proves the `has_rgb` flag byte correctly gates
// presence/absence, not just decodes when present.
const spatterAt11Shared = A.tails.filter((t) => t.tile_idx === 11 && t.kind === W.C.TAIL_SPATTER_MAT);
assert.equal(spatterAt11Shared.length, 2, "A[11] 2 shared-decoded SPATTER tails");
assert.equal(spatterAt11Shared[0].data.rgb, undefined, "A[11][0] (Solid) has NO rgb");
assert.deepEqual(spatterAt11Shared[1].data.rgb, [180, 20, 20], "A[11][1] (Paste) resolved blood-red rgb");

console.log("PASS WC-19 DESIG_PRIORITY + WC-21 VERMIN + blood-family SPATTER rgb (shared decoder)");

console.log(`PASS ${recordCount} records, ${tailCount} tails, ${decoded.block_count} blocks (${bin.length} bytes)`);
