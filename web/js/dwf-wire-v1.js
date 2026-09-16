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

// dwf-wire-v1.js -- the reference decoder for protocol v1 and the exact mirror of
// src/wire_v1.cpp. No imports/exports: it attaches DwfWireV1 to the global scope.

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
    TAIL_ITEM: 0x01, TAIL_PLANT: 0x02, TAIL_SPATTER_MAT: 0x03, TAIL_FLOW: 0x04, TAIL_ITEM_SPATTER: 0x05,
    TAIL_GRASS: 0x06, TAIL_ENGRAVING: 0x07, TAIL_DESIG_PRIORITY: 0x08, TAIL_VERMIN: 0x09,
    TAIL_CONTAINER_PEEK: 0x0A,
    TAIL_FARM_CROP: 0x0B, TAIL_TREE_GRAPHICS: 0x0C, TAIL_ITEM_ART: 0x0D,
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
      automine: (d1 >> 7) & 1,
      traffic: d2 & 3,
      track: (d2 >> 2) & 15,
      spatter_amt: dv.getUint8(o + 9),
      flags2: dv.getUint16(o + 10, true),
    };
  }

  function decodeTailData(kind, dv, o, len) {
    if (kind === C.TAIL_ITEM && len >= 8) {
      var it = { item_type: dv.getInt16(o, true), mat_type: dv.getInt16(o + 2, true),
                 mat_index: dv.getInt32(o + 4, true) };
      it.subtype = (len >= 10) ? dv.getInt16(o + 8, true) : -1;
      var rawIflags = (len >= 11) ? dv.getUint8(o + 10) : 0;
      // Expose only the 5 real flag bits (web/forbid/dump/melt/on_fire); bit5 is the internal
      // quality-family presence marker, consumed below -- keeps it.iflags semantics unchanged.
      it.iflags = rawIflags & 0x1f;
      if (rawIflags & 0x40) it.skeletal = true;
      // ITEMDEF-SPRITES: grown wooden items select the definition's WOOD_GROWN art.
      if (rawIflags & 0x80) it.grown = true;
      it.stack = (len >= 12) ? dv.getUint8(o + 11) : 1;
      var extEnd = len;
      if ((rawIflags & 0x20) && extEnd >= 15) {
        it.quality = dv.getUint8(o + extEnd - 3);
        var qf = dv.getUint8(o + extEnd - 2);
        it.wear = dv.getUint8(o + extEnd - 1);
        it.artifact = (qf & 0x02) !== 0;
        it.qflags = qf;
        extEnd -= 3;
      }
      // SMALLGEM/GEM item tails carry a trailing cut `shape` (i16, -1 = uncut) as the LAST 2 bytes, AFTER
      // the optional identity block. Carve it off first, so the identity block parses only [12, extEnd).
      if ((it.item_type === C.ITEM_TYPE_SMALLGEM || it.item_type === C.ITEM_TYPE_GEM) && extEnd >= 14) {
        it.shape = dv.getInt16(o + extEnd - 2, true);
        extEnd -= 2;
      }
      // Item identity extension: `ident_kind u8 | idlen u8 | id bytes`, present only when the server resolved
      // a token. Absent means no identKind/ident keys, and the generic fallback chain applies.
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
      // blood-family colour extension: `has_rgb u8` plus r,g,b AFTER the state byte. Omitted when unresolved
      // -- callers must fall back, never treat a missing key as black.
      if (len >= 13 && dv.getUint8(o + 9) !== 0) {
        sp.rgb = [dv.getUint8(o + 10), dv.getUint8(o + 11), dv.getUint8(o + 12)];
      }
      return sp;
    }
    // FLOW (mist/smoke/miasma/...), one densest-flow entry per tile.
    if (kind === C.TAIL_FLOW && len >= 2) {
      return { flow_type: dv.getUint8(o), density: dv.getUint8(o + 1) };
    }
    // ITEM_SPATTER (fallen-leaves/fruit litter).
    if (kind === C.TAIL_ITEM_SPATTER && len >= 3) {
      var isp = { growth_class: dv.getUint8(o), item_type: dv.getUint8(o + 1), amount: dv.getUint8(o + 2) };
      if (len >= 7 && dv.getUint8(o + 3) !== 0) {
        isp.rgb = [dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6)];
      }
      return isp;
    }
    if (kind === C.TAIL_GRASS && len >= 1) {
      var gidLen = dv.getUint8(o);
      var gid = "";
      for (var gi = 0; gi < gidLen && 1 + gi < len; gi++) gid += String.fromCharCode(dv.getUint8(o + 1 + gi));
      var gAmountOff = o + 1 + gidLen;
      return { id: gid, amount: (gAmountOff < o + len) ? dv.getUint8(gAmountOff) : 0 };
    }
    // ENGRAVING (eflags u16 LE -- 10 real bits, quality u8).
    if (kind === C.TAIL_ENGRAVING && len >= 3) {
      return { eflags: dv.getUint16(o, true), quality: dv.getUint8(o + 2) };
    }
    // DESIG_PRIORITY (priority u8, only emitted for non-default priority).
    if (kind === C.TAIL_DESIG_PRIORITY && len >= 1) {
      return { priority: dv.getUint8(o) };
    }
    if (kind === C.TAIL_CONTAINER_PEEK && len >= 8) {
      var cp = { item_type: dv.getInt16(o, true), mat_type: dv.getInt16(o + 2, true),
                 mat_index: dv.getInt32(o + 4, true) };
      cp.subtype = (len >= 10) ? dv.getInt16(o + 8, true) : -1;
      cp.cflags = (len >= 11) ? dv.getUint8(o + 10) : 0;
      return cp;
    }
    // VERMIN (race u16 LE, caste u8, vflags u8 -- bit0 colony, bit1 large swarm).
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
    // building-owned planted crop. stage 0=seed, 1=sprout, 2=grown;
    // species is the stable plant_raw.id token used directly by plant_map.json.
    if (kind === C.TAIL_FARM_CROP && len >= 2) {
      var cs = dv.getUint8(o), cl = dv.getUint8(o + 1), cid = "";
      for (var cj = 0; cj < cl && 2 + cj < len; cj++) cid += String.fromCharCode(dv.getUint8(o + 2 + cj));
      return { stage: cs, id: cid };
    }
    // TREE-KEY: packed native resolver keys. Presence bits are independent because selector/key
    // zero is valid, and growth value zero means FRUIT_1 rather than "no growth".
    if (kind === C.TAIL_TREE_GRAPHICS && len >= 7) {
      var tf = dv.getUint8(o);
      return {
        flags: tf,
        woodKey: dv.getUint16(o + 1, true),
        leafKey: dv.getUint32(o + 3, true),
        woodPresent: (tf & 0x01) !== 0,
        leafPresent: (tf & 0x02) !== 0,
        growthPresent: (tf & 0x04) !== 0,
      };
    }
    // ITEM-SPRITES-R2: 0..7 = keyboard/stringed/wind/percussion x building/handheld.
    if (kind === C.TAIL_ITEM_ART && len >= 1) {
      var ia = { flags: dv.getUint8(o) };
      if ((ia.flags & 0x01) && len >= 2) ia.instrumentClass = dv.getUint8(o + 1);
      if (ia.flags & 0x02) ia.specialMaterial = true;
      if (ia.flags & 0x04) ia.generatedTool = true;
      return ia;
    }
    return { raw: true };
  }

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

  // The map deliberately draws no quality glyphs; these marks belong only on text surfaces. Artifact
  // names are DF's own proper names, preserved verbatim. Wear encloses quality (X+steel helm+X).
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

  // `payload` is the frame body, already inflated if the header's deflated flag was set. Returns
  // { world_seq, block_count, blocks:[{ bx,by,bz,ver,bflags,records,tails }] }.
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
