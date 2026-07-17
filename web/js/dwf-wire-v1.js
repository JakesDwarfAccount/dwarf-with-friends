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

// dwf-wire-v1.js -- reference decoder for protocol v1 (W-A foundation spec Part 0).
//
// The exact mirror of src/wire_v1.cpp. WA-8 ships + tests it via tools/harness/
// wire_decode_test.mjs (loaded verbatim through vm.runInThisContext, attaches to the
// global). WA-12's cache worker importScripts()es the same file to decode BLOCK_SET
// frames off the wire -- so this is the single source of truth for the client decode.
//
// No imports/exports (worker/importScripts + node-vm compatible): it attaches an API
// object to the global scope as DwfWireV1.

(function (root) {
  "use strict";

  var C = {
    MAGIC0: 0x44, MAGIC1: 0x35, VERSION: 1,
    TYPE_BLOCK_SET: 0x01, TYPE_AUX: 0x02, TYPE_ITEMDEF_DICT: 0x03,
    FLAG_DEFLATED: 0x01,
    HEADER_SIZE: 10,
    TILE_RECORD_SIZE: 12,
    TILES_PER_BLOCK: 256,
    VOID_TT: 0xffff,
    // WC-11/WC-15/WC-17/WC-18/WC-19/WC-21: FLOW (0x04), ITEM_SPATTER (0x05), GRASS (0x06),
    // ENGRAVING (0x07), DESIG_PRIORITY (0x08) and VERMIN (0x09) join the pre-existing
    // ITEM/PLANT/SPATTER_MAT kinds (src/wire_v1.h's landed kTail* registry -- see its
    // RECONCILE-R1 note: sequential ids as items claimed them, NOT the WC spec draft's
    // 0x10+ numbering).
    // TX1: CONTAINER_PEEK (0x0A) joins the registry -- a BARREL/BIN's representative
    // contained item, so the renderers can composite native's contents-peek overlay.
    TAIL_ITEM: 0x01, TAIL_PLANT: 0x02, TAIL_SPATTER_MAT: 0x03, TAIL_FLOW: 0x04, TAIL_ITEM_SPATTER: 0x05,
    TAIL_GRASS: 0x06, TAIL_ENGRAVING: 0x07, TAIL_DESIG_PRIORITY: 0x08, TAIL_VERMIN: 0x09,
    TAIL_CONTAINER_PEEK: 0x0A,
    TAIL_FARM_CROP: 0x0B,
    F2_ITEM: 0x0001, F2_PLANT: 0x0002, F2_SPATTER: 0x0004, F2_FLOW: 0x0008, F2_ITEM_SPATTER: 0x0010,
    F2_GRASS: 0x0020, F2_ENGRAVING: 0x0040, F2_DESIG_PRIORITY: 0x0080, F2_VERMIN: 0x0100,
    F2_CONTAINER_PEEK: 0x0200,
    F2_FARM_CROP: 0x0400,
    VFLAG_COLONY: 0x01, VFLAG_SWARM_LARGE: 0x02,
    // TIER-2: item identity kinds (3 = inorganic) + the df::item_type ordinals the gem-shape
    // ITEM-tail extension keys off (SMALLGEM=1, GEM=44 carry a trailing cut `shape`).
    IDENT_PLANT: 1, IDENT_CREATURE: 2, IDENT_INORGANIC: 3,
    ITEM_TYPE_SMALLGEM: 1, ITEM_TYPE_GEM: 44,
  };

  // Decode the 10-byte frame header (§0.2). Returns null if magic/version mismatch.
  function decodeHeader(bytes) {
    if (bytes.length < C.HEADER_SIZE) return null;
    if (bytes[0] !== C.MAGIC0 || bytes[1] !== C.MAGIC1) return null;
    if (bytes[2] !== C.VERSION) return null;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    return {
      ver: bytes[2],
      type: bytes[3],
      flags: bytes[4],
      deflated: (bytes[4] & C.FLAG_DEFLATED) !== 0,
      seq: dv.getUint32(6, true),
      payloadOffset: C.HEADER_SIZE,
    };
  }

  // Decode one 12-byte tile record (§0.3.1) at byte offset `o` of DataView `dv`.
  function decodeTileRecord(dv, o) {
    var bits = dv.getUint8(o + 6);
    var d1 = dv.getUint8(o + 7);
    var d2 = dv.getUint8(o + 8);
    return {
      tt: dv.getUint16(o + 0, true),
      base_mt: dv.getInt16(o + 2, true),
      base_mi: dv.getInt16(o + 4, true),
      liquid: bits & 3,
      flow: (bits >> 2) & 7,
      hidden: (bits >> 5) & 1,
      outside: (bits >> 6) & 1,
      dig: d1 & 15,
      smooth: (d1 >> 4) & 3,
      marker: (d1 >> 6) & 1,
      traffic: d2 & 3,
      track: (d2 >> 2) & 15,
      spatter_amt: dv.getUint8(o + 9),
      flags2: dv.getUint16(o + 10, true),
    };
  }

  // Decode one sparse tail's kind-specific data (§0.3.2). Unknown kinds -> raw bytes.
  //
  // WC-1/WC-11/WC-15: the ITEM and SPATTER_MAT kinds grew additional trailing bytes after
  // this decoder's original 8-byte reads (src/wire_v1.cpp's make_item_tail/make_spatter_tail
  // -- ITEM is now 12 bytes with subtype/iflags/stack appended, SPATTER_MAT is now 9 bytes
  // with a matter_state byte appended). Read defensively by `len` so an older/shorter frame
  // still decodes its base fields; the extension fields default to their "none" sentinel
  // when the frame is too short to carry them (never guessed as 0, which is a REAL value
  // for iflags/state).
  function decodeTailData(kind, dv, o, len) {
    if (kind === C.TAIL_ITEM && len >= 8) {
      var it = { item_type: dv.getInt16(o, true), mat_type: dv.getInt16(o + 2, true),
                 mat_index: dv.getInt32(o + 4, true) };
      it.subtype = (len >= 10) ? dv.getInt16(o + 8, true) : -1;
      var rawIflags = (len >= 11) ? dv.getUint8(o + 10) : 0;
      // Expose only the 5 real flag bits (web/forbid/dump/melt/on_fire); bit5 is the internal
      // quality-family presence marker, consumed below -- keeps it.iflags semantics unchanged.
      it.iflags = rawIflags & 0x1f;
      // CORPSETEX-B195 (CORPSETEX_B195_SKELETAL): iflags bit6 = DF labels this corpse a skeleton.
      // Kept OUT of it.iflags (whose semantics stay the 5 real flag bits) and exposed as its own
      // key ONLY when set -- a fresh corpse and an OLD server (which never sends the bit) both
      // leave it.skeletal UNDEFINED, exactly the additive/optional shape identity+quality use, so
      // a plain item's decoded shape is byte-for-byte the pre-B195 shape (golden fixtures untouched).
      // The resolver reads `if (it.skeletal)`: undefined -> the "fresh corpse" body branch (today's
      // behaviour, never a regression); true -> the skeletal branch.
      if (rawIflags & 0x40) it.skeletal = true;
      it.stack = (len >= 12) ? dv.getUint8(o + 11) : 1;
      var extEnd = len;
      // ITEM QUALITY FAMILY (2026-07-09): a fixed 3-byte block [quality u8|qflags u8|wear u8]
      // rides at the very END of the tail when iflags bit5 (kItemFlagHasQuality) is set. Carve
      // it off FIRST (before gem-shape), presence keyed by the explicit flag bit (quality
      // applies to many item types, so type-keying like gem-shape cannot signal it). Exposes
      // it.quality (0-5), it.wear (0-3), it.artifact (bool). Absent when the server had nothing
      // to say (plain items stay 12 bytes) -- old/plain tails leave these keys undefined.
      if ((rawIflags & 0x20) && extEnd >= 15) {
        it.quality = dv.getUint8(o + extEnd - 3);
        var qf = dv.getUint8(o + extEnd - 2);
        it.wear = dv.getUint8(o + extEnd - 1);
        it.artifact = (qf & 0x02) !== 0;
        it.qflags = qf;
        extEnd -= 3;
      }
      // TIER-2 gem shape (asset/material-parity §4): SMALLGEM(1)/GEM(44) item tails carry a
      // trailing cut `shape` (i16, -1 = uncut/spawned) as the LAST 2 bytes of what remains after
      // the quality carve, AFTER the optional identity block. Carve it off (keyed off the gem
      // item_type + a tail extending past the 12-byte body) so the identity block below parses
      // only the middle region [12, extEnd) -- unambiguous even for glass gems that carry a shape
      // but no identity. Old (pre-Tier-2) gem tails were always exactly 12 bytes.
      if ((it.item_type === C.ITEM_TYPE_SMALLGEM || it.item_type === C.ITEM_TYPE_GEM) && extEnd >= 14) {
        it.shape = dv.getInt16(o + extEnd - 2, true);
        extEnd -= 2;
      }
      // Item identity extension (WIRE-TAILS): `ident_kind u8 (1 plant/2 creature/3 inorganic)
      // | idlen u8 | id bytes`, present only when the server resolved a token. Absent -> no
      // identKind/ident keys (client falls back to the generic bytype/matvariant chain,
      // exactly today's behaviour). src/wire_v1.h doc.
      if (extEnd >= 14) {
        var ik = dv.getUint8(o + 12), il = dv.getUint8(o + 13);
        if (ik !== 0 && il > 0 && extEnd >= 14 + il) {
          var tok = "";
          for (var ci = 0; ci < il; ci++) tok += String.fromCharCode(dv.getUint8(o + 14 + ci));
          it.identKind = ik; it.ident = tok;
        }
      }
      return it;
    }
    if (kind === C.TAIL_PLANT && len >= 2) {
      var part = dv.getUint8(o);
      var idLen = dv.getUint8(o + 1);
      var id = "";
      for (var i = 0; i < idLen && 2 + i < len; i++) id += String.fromCharCode(dv.getUint8(o + 2 + i));
      return { part: part, id: id };
    }
    if (kind === C.TAIL_SPATTER_MAT && len >= 8) {
      var sp = { mat_type: dv.getInt16(o, true), mat_index: dv.getInt32(o + 2, true),
                 amount: dv.getUint16(o + 6, true) };
      sp.state = (len >= 9) ? dv.getInt8(o + 8) : -1;
      // blood-family color extension: `has_rgb u8` + (r,g,b u8) AFTER the state byte,
      // present only when len>=13 AND has_rgb!=0 (src/wire_v1.cpp::make_spatter_tail's
      // second additive extension). Omitted (no `rgb` key) when unresolved -- callers must
      // fall back (hash pick/default family), never treat a missing key as black.
      if (len >= 13 && dv.getUint8(o + 9) !== 0) {
        sp.rgb = [dv.getUint8(o + 10), dv.getUint8(o + 11), dv.getUint8(o + 12)];
      }
      return sp;
    }
    // WC-15: FLOW (mist/smoke/miasma/...), one densest-flow entry per tile.
    if (kind === C.TAIL_FLOW && len >= 2) {
      return { flow_type: dv.getUint8(o), density: dv.getUint8(o + 1) };
    }
    // WC-11: ITEM_SPATTER (fallen-leaves/fruit litter).
    if (kind === C.TAIL_ITEM_SPATTER && len >= 3) {
      var isp = { growth_class: dv.getUint8(o), item_type: dv.getUint8(o + 1), amount: dv.getUint8(o + 2) };
      if (len >= 7 && dv.getUint8(o + 3) !== 0) {
        isp.rgb = [dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6)];
      }
      return isp;
    }
    // WC-17: GRASS coverage. Same idlen+id-bytes layout as TAIL_PLANT (a resolved plant
    // token STRING, not a raw numeric plant_id -- see src/wire_v1.cpp::make_grass_tail's
    // doc for why), with a trailing amount (u8) byte.
    if (kind === C.TAIL_GRASS && len >= 1) {
      var gidLen = dv.getUint8(o);
      var gid = "";
      for (var gi = 0; gi < gidLen && 1 + gi < len; gi++) gid += String.fromCharCode(dv.getUint8(o + 1 + gi));
      var gAmountOff = o + 1 + gidLen;
      return { id: gid, amount: (gAmountOff < o + len) ? dv.getUint8(gAmountOff) : 0 };
    }
    // WC-18: ENGRAVING (eflags u16 LE -- 10 real bits, quality u8).
    if (kind === C.TAIL_ENGRAVING && len >= 3) {
      return { eflags: dv.getUint16(o, true), quality: dv.getUint8(o + 2) };
    }
    // WC-19: DESIG_PRIORITY (priority u8, only emitted for non-default priority).
    if (kind === C.TAIL_DESIG_PRIORITY && len >= 1) {
      return { priority: dv.getUint8(o) };
    }
    // TX1: CONTAINER_PEEK -- representative FIRST contained item of a BARREL/BIN (fixed 11
    // bytes: item_type i16 | mat_type i16 | mat_index i32 | subtype i16 | cflags u8; cflags
    // bit0 = subterranean plant content). Read defensively by len like ITEM above.
    if (kind === C.TAIL_CONTAINER_PEEK && len >= 8) {
      var cp = { item_type: dv.getInt16(o, true), mat_type: dv.getInt16(o + 2, true),
                 mat_index: dv.getInt32(o + 4, true) };
      cp.subtype = (len >= 10) ? dv.getInt16(o + 8, true) : -1;
      cp.cflags = (len >= 11) ? dv.getUint8(o + 10) : 0;
      return cp;
    }
    // WC-21: VERMIN (race u16 LE, caste u8, vflags u8 -- bit0 colony, bit1 large swarm).
    if (kind === C.TAIL_VERMIN && len >= 4) {
      var vm = { race: dv.getUint16(o, true), caste: dv.getUint8(o + 2), vflags: dv.getUint8(o + 3) };
      // Vermin identity extension (WIRE-TAILS): resolved creature token (idlen u8 + bytes)
      // after the 4-byte body, present when the server resolved the race index -> token.
      if (len >= 6) {
        var vl = dv.getUint8(o + 4);
        if (vl > 0 && len >= 5 + vl) {
          var vtok = "";
          for (var vi = 0; vi < vl; vi++) vtok += String.fromCharCode(dv.getUint8(o + 5 + vi));
          vm.token = vtok;
        }
      }
      return vm;
    }
    // TX4: building-owned planted crop. stage 0=seed, 1=sprout, 2=grown;
    // species is the stable plant_raw.id token used directly by plant_map.json.
    if (kind === C.TAIL_FARM_CROP && len >= 2) {
      var cs = dv.getUint8(o), cl = dv.getUint8(o + 1), cid = "";
      for (var cj = 0; cj < cl && 2 + cj < len; cj++) cid += String.fromCharCode(dv.getUint8(o + 2 + cj));
      return { stage: cs, id: cid };
    }
    return { raw: true };
  }

  // WC-1/RECONCILE-R2: decode an ITEMDEF_DICT message payload (header already stripped by
  // the caller) -- `subcat u8 | count u16 LE | count x (id u16 LE | len u8 | token bytes)`
  // for each of the 14 itemdef subcategories, in Items.cpp's ITEMDEF_VECTORS order (src/
  // wire_v1.cpp::assemble_itemdef_dict). Returns `[{subcat, entries:[{id, token}, ...]}, ...]`.
  // Bounded to 14 subcats and to the payload length so a malformed/truncated frame can never
  // spin an infinite loop -- worst case it just returns fewer subcats than expected.
  function decodeItemDefDict(payload) {
    var dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
    var o = 0;
    var subcats = [];
    for (var sc = 0; sc < 14 && o + 3 <= payload.length; sc++) {
      var subcat = dv.getUint8(o); o += 1;
      var count = dv.getUint16(o, true); o += 2;
      var entries = [];
      for (var i = 0; i < count && o + 3 <= payload.length; i++) {
        var id = dv.getUint16(o, true); o += 2;
        var len = dv.getUint8(o); o += 1;
        if (o + len > payload.length) break;
        var tok = "";
        for (var c = 0; c < len; c++) tok += String.fromCharCode(dv.getUint8(o + c));
        o += len;
        entries.push({ id: id, token: tok });
      }
      subcats.push({ subcat: subcat, entries: entries });
    }
    return subcats;
  }

  // Native text treatment for an item name. The map deliberately draws no quality glyphs; these
  // marks belong only on text surfaces. Artifact names are already proper names from DF, so they
  // are preserved verbatim rather than given an invented quality wrapper. Wear encloses quality,
  // matching the native x/X/XX nesting (e.g. X+steel helm+X).
  function formatItemName(name, item) {
    var text = String(name == null ? "" : name);
    if (!text) return text;
    item = item || {};
    var q = Number(item.quality);
    var marks = ["", "-", "+", "*", "≡", "☼"];
    if (!item.artifact && q >= 1 && q <= 5)
      text = marks[q] + text + marks[q];
    var wear = Number(item.wear);
    var wearMark = wear === 1 ? "x" : wear === 2 ? "X" : wear >= 3 ? "XX" : "";
    return wearMark ? wearMark + text + wearMark : text;
  }

  // Decode a BLOCK_SET payload (§0.3). `payload` is a Uint8Array of the frame body
  // (already inflated if the header's deflated flag was set). Returns
  // { world_seq, block_count, blocks:[{ bx,by,bz,ver,bflags,records:[256],tails:[...] }] }.
  function decodeBlockSet(payload) {
    var dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
    var o = 0;
    var world_seq = dv.getUint32(o, true); o += 4;
    var block_count = dv.getUint16(o, true); o += 2;
    var blocks = [];
    for (var b = 0; b < block_count; b++) {
      var bx = dv.getUint16(o, true); o += 2;
      var by = dv.getUint16(o, true); o += 2;
      var bz = dv.getUint16(o, true); o += 2;
      var ver = dv.getUint32(o, true); o += 4;
      var bflags = dv.getUint8(o); o += 1;
      // tail_count widened u8->u16 LE (cachefix 2026-07-09): a grass-dense block carries up to
      // 256 GRASS tails plus its ITEM/etc tails, exceeding the old 255 cap that silently
      // truncated high-tile_idx ITEM tails server-side (the invisible-item cluster). Mirror of
      // src/wire_v1.cpp::assemble_block_set.
      var tail_count = dv.getUint16(o, true); o += 2;
      var records = new Array(C.TILES_PER_BLOCK);
      for (var i = 0; i < C.TILES_PER_BLOCK; i++) {
        records[i] = decodeTileRecord(dv, o);
        o += C.TILE_RECORD_SIZE;
      }
      var tails = [];
      for (var t = 0; t < tail_count; t++) {
        var tile_idx = dv.getUint8(o); o += 1;
        var kind = dv.getUint8(o); o += 1;
        var len = dv.getUint8(o); o += 1;
        var data = decodeTailData(kind, dv, o, len);
        o += len;
        tails.push({ tile_idx: tile_idx, kind: kind, len: len, data: data });
      }
      blocks.push({ bx: bx, by: by, bz: bz, ver: ver, bflags: bflags, records: records, tails: tails });
    }
    return { world_seq: world_seq, block_count: block_count, blocks: blocks, consumed: o };
  }

  root.DwfWireV1 = {
    C: C,
    decodeHeader: decodeHeader,
    decodeTileRecord: decodeTileRecord,
    decodeBlockSet: decodeBlockSet,
    decodeTailData: decodeTailData,
    decodeItemDefDict: decodeItemDefDict,
    formatItemName: formatItemName,
  };
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
