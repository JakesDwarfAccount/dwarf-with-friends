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

// dwf-cache-worker.js -- the chunked SoA world-cache ingest core. Dual-mode: a real dedicated
// Worker, or a plain script calling the identical core in-process as `DwfCacheWorkerCore`.

(function (scope) {
  "use strict";

  var _isDedicatedWorkerEarly = (typeof scope.window === "undefined") && (typeof scope.postMessage === "function");
  var _decoderReady = !_isDedicatedWorkerEarly;
  var _decoderError = "";
  if (_isDedicatedWorkerEarly && typeof scope.importScripts === "function") {
    try {
      var _selfUrl = String((scope.location && scope.location.href) || "");
      var _wireUrl = _selfUrl.indexOf("dwf-cache-worker.js") !== -1
        ? _selfUrl.replace("dwf-cache-worker.js", "dwf-wire-v1.js")
        : "/js/dwf-wire-v1.js";
      scope.importScripts(_wireUrl);
      _decoderReady = typeof scope.DwfWireV1 !== "undefined" &&
        !!scope.DwfWireV1 && typeof scope.DwfWireV1.decodeBlockSet === "function";
      if (!_decoderReady) _decoderError = "dwf-wire-v1.js loaded without a decoder";
    } catch (err) {
      _decoderError = String(err && err.message || err || "decoder import failed");
    }
  }

  // ---- local self-consistent dig-designation ordinal table (see file banner) -----------
  var DIG_NAMES = ["No", "Default", "UpDownStair", "Channel", "Ramp", "DownStair", "UpStair"];
  var DIG_INDEX = Object.create(null);
  for (var _di = 0; _di < DIG_NAMES.length; _di++) DIG_INDEX[DIG_NAMES[_di]] = _di;

  var PLANT_PART_NAMES = ["TRUNK", "BRANCH", "CANOPY", "LEAVES", "SAPLING", "SHRUB"];

  var itemTypeMeta = new Map();
  function setItemTypeMetaList(list) {
    var m = new Map();
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (Array.isArray(r) && r.length >= 2) m.set(r[0], r[1]);
      }
    }
    itemTypeMeta = m;
  }

  function packMat(mt, mi) {
    return ((mt | 0) << 16) | ((mi | 0) & 0xFFFF);
  }
  function unpackMat(v) {
    v = v | 0;
    return [v >> 16, (v << 16) >> 16];
  }

  var CHUNK_TILES = 256; // 16x16

  function makeChunk() {
    var tt = new Uint16Array(CHUNK_TILES);
    tt.fill(0xFFFF); // unwritten slots (partial-window chunks) must read as void, not tt=0
    return {
      tt: tt,
      mat: new Int32Array(CHUNK_TILES),
      bits: new Uint8Array(CHUNK_TILES),
      desig: new Uint16Array(CHUNK_TILES),
      spatterAmt: new Uint8Array(CHUNK_TILES),
      flags2: new Uint16Array(CHUNK_TILES),
      spriteCell: new Uint16Array(CHUNK_TILES),   // hook only -- not filled yet
      tint: new Uint32Array(CHUNK_TILES),          // hook only -- not filled yet
      sparse: new Map(),
      ver: 0,
      dirty: false,
      baked: true,   // legacy-JSON ingest is always the server's already-baked see-down output
    };
  }

  // Rough per-chunk byte estimate for the memory budget: fixed SoA arrays are exact;
  // sparse entries and per-chunk bookkeeping are a conservative flat estimate.
  var FIXED_CHUNK_BYTES = CHUNK_TILES * (2 + 4 + 1 + 2 + 1 + 2 + 2 + 4); // = 4608
  var SPARSE_ENTRY_BYTES = 96;
  var CHUNK_OVERHEAD_BYTES = 128;
  function chunkByteEstimate(chunk) {
    return FIXED_CHUNK_BYTES + CHUNK_OVERHEAD_BYTES + chunk.sparse.size * SPARSE_ENTRY_BYTES;
  }

  // ---- the store: Map<z, Map<key, Chunk>> ------------------------------------------------
  var store = new Map();
  var globalVer = 0;
  var camHintZ = 0;
  var evictions = 0;
  var budgetBytes = 128 * 1024 * 1024; // 128 MB default
  var v1WorldSeq = 0;

  function chunkKeyFor(x, y) {
    return (x >> 4) * 4096 + (y >> 4);
  }

  function getChunk(z, key) {
    var zMap = store.get(z);
    if (!zMap) return null;
    return zMap.get(key) || null;
  }

  function ensureChunk(z, key) {
    var zMap = store.get(z);
    if (!zMap) { zMap = new Map(); store.set(z, zMap); }
    var chunk = zMap.get(key);
    if (!chunk) { chunk = makeChunk(); zMap.set(key, chunk); }
    return chunk;
  }

  // Mirrors the field semantics of tile_map_dump.cpp's emit_tile_fields, minus the strings and wallnbr.
  function writeTileRecord(chunk, idx, t) {
    var tt = (typeof t.tt === "number") ? t.tt : -1;
    if (tt < 0) {
      chunk.tt[idx] = 0xFFFF;
      chunk.mat[idx] = 0;
      chunk.bits[idx] = 0;
      var jd = t.desig;
      if (jd) {
        var jdig = (typeof jd.dig === "string" && DIG_INDEX[jd.dig] !== undefined) ? DIG_INDEX[jd.dig] : 0;
        var jd1 = (jdig & 0xF) | (((jd.smooth | 0) & 3) << 4) |
          ((jd.marker ? 1 : 0) << 6) | ((jd.automine ? 1 : 0) << 7);
        var jd2 = (((jd.traffic | 0) & 3)) | (((jd.track | 0) & 0xF) << 2);
        chunk.desig[idx] = (jd1 & 0xFF) | ((jd2 & 0xFF) << 8);
      } else {
        chunk.desig[idx] = 0;
      }
      chunk.spatterAmt[idx] = 0;
      chunk.flags2[idx] = 0;
      chunk.sparse.delete(idx);
      return;
    }
    chunk.tt[idx] = tt;
    var bmt = (typeof t.base_mt === "number") ? t.base_mt : -1;
    var bmi = (typeof t.base_mi === "number") ? t.base_mi : -1;
    chunk.mat[idx] = packMat(bmt, bmi);

    var liquidCode = (t.liquid === "magma") ? 2 : ((t.liquid === "water") ? 1 : 0);
    var flow = (typeof t.flow === "number") ? (t.flow & 7) : 0;
    var hidden = t.hidden ? 1 : 0;
    var outside = t.outside ? 1 : 0;
    chunk.bits[idx] = (liquidCode & 3) | (flow << 2) | (hidden << 5) | (outside << 6);

    var desig1 = 0, desig2 = 0;
    var d = t.desig;
    if (d) {
      var digVal = (typeof d.dig === "string" && DIG_INDEX[d.dig] !== undefined) ? DIG_INDEX[d.dig] : 0;
      var smooth = d.smooth | 0;
      var marker = d.marker ? 1 : 0;
      var automine = d.automine ? 1 : 0;
      var traffic = d.traffic | 0;
      var track = d.track | 0;
      desig1 = (digVal & 0xF) | ((smooth & 3) << 4) | ((marker & 1) << 6) |
        ((automine & 1) << 7);
      desig2 = (traffic & 3) | ((track & 0xF) << 2);
    }
    chunk.desig[idx] = (desig1 & 0xFF) | ((desig2 & 0xFF) << 8);

    var flags2 = 0;
    var sp = null;
    if (t.item) {
      sp = sp || {};
      var itm = { type: t.item.type, mat_type: t.item.mat_type, mat_index: t.item.mat_index };
      if (typeof t.item.subtype === "number") itm.subtype = t.item.subtype;
      if (typeof t.item.iflags === "number") itm.iflags = t.item.iflags;
      if (typeof t.item.stack === "number") itm.stack = t.item.stack;
      // DF's corpse->skeleton label bit (only present on new-server wire).
      if (typeof t.item.skeletal === "boolean") itm.skeletal = t.item.skeletal;
      if (typeof t.item.grown === "boolean") itm.grown = t.item.grown;
      if (typeof t.item.artifact === "boolean") itm.artifact = t.item.artifact;
      if (typeof t.item.quality === "number") itm.quality = t.item.quality;
      if (typeof t.item.qflags === "number") itm.qflags = t.item.qflags;
      if (typeof t.item.wear === "number") itm.wear = t.item.wear;
      if (typeof t.item.shape === "number") itm.shape = t.item.shape;
      if (typeof t.item.instrumentClass === "number") itm.instrumentClass = t.item.instrumentClass;
      if (t.item.specialMaterial === true) itm.specialMaterial = true;
      if (t.item.generatedTool === true) itm.generatedTool = true;
      // Item identity extension (additive): resolved plant/creature token, only when present.
      if (typeof t.item.identKind === "number" && t.item.ident) { itm.identKind = t.item.identKind; itm.ident = t.item.ident; }
      sp.item = itm;
      flags2 |= 1;
    }
    if (t.plant) {
      sp = sp || {};
      sp.plant = { id: t.plant.id, part: t.plant.part };
      flags2 |= 2;
    }
    if (t.spatter) {
      sp = sp || {};
      var spm = { mat_type: t.spatter.mat_type, mat_index: t.spatter.mat_index, amount: t.spatter.amount };
      // `state` only when present.
      if (typeof t.spatter.state === "number") spm.state = t.spatter.state;
      sp.spatterMat = spm;
      flags2 |= 4;
      chunk.spatterAmt[idx] = Math.max(0, Math.min(255, t.spatter.amount | 0));
    } else {
      chunk.spatterAmt[idx] = 0;
    }
    if (t.item_spatter) {
      sp = sp || {};
      sp.itemSpatters = [{ growth_class: t.item_spatter.growth_class, item_type: t.item_spatter.item_type, amount: t.item_spatter.amount }];
    }
    if (t.cloud) {
      sp = sp || {};
      sp.flow = { type: t.cloud.type, density: t.cloud.density };
    }
    chunk.flags2[idx] = flags2;
    if (sp) chunk.sparse.set(idx, sp); else chunk.sparse.delete(idx);
  }

  // Every pushed tile -- keyframe or delta -- carries per-tile world x/y, so ingest needs no notion of
  // "mode": it writes whichever tiles are present, by world coordinate.
  function ingestLegacy(map) {
    if (!map || !map.origin || !Array.isArray(map.tiles)) return null;
    var z = (typeof map.z === "number") ? map.z : map.origin.z;
    var ox = map.origin.x, oy = map.origin.y;
    var w = map.width;
    camHintZ = z;
    var dirtyKeys = new Set();
    var tiles = map.tiles;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (!t) continue;
      var wx, wy;
      if (typeof t.x === "number" && typeof t.y === "number") { wx = t.x; wy = t.y; }
      else if (w > 0) { var gx = i % w, gy = (i - gx) / w; wx = ox + gx; wy = oy + gy; }
      else continue;
      var key = chunkKeyFor(wx, wy);
      var chunk = ensureChunk(z, key);
      var idx = (wy & 15) * 16 + (wx & 15);
      writeTileRecord(chunk, idx, t);
      chunk.ver = ++globalVer;
      // `ver` here is a local per-tile generation, not protocol-v1's server block version. Mark even an
      // existing raw chunk baked so the next complete BLOCK_SET replaces this necessarily partial view.
      chunk.baked = true;
      chunk.dirty = true;
      dirtyKeys.add(key);
    }
    if (dirtyKeys.size) maybeEvict();
    return { z: z, keys: Array.from(dirtyKeys), stats: stats() };
  }

  // On breach, evict the chunks farthest from the last-seen camera z first, across ALL z-levels.
  function maybeEvict() {
    var total = totalBytes();
    if (total <= budgetBytes) return;
    var all = [];
    for (var zEntry of store) {
      var z = zEntry[0], zMap = zEntry[1];
      for (var cEntry of zMap) all.push({ z: z, key: cEntry[0], chunk: cEntry[1] });
    }
    all.sort(function (a, b) { return Math.abs(b.z - camHintZ) - Math.abs(a.z - camHintZ); });
    var idx2 = 0;
    while (total > budgetBytes && idx2 < all.length) {
      var victim = all[idx2++];
      var zMap2 = store.get(victim.z);
      if (!zMap2) continue;
      var c = zMap2.get(victim.key);
      if (!c) continue;
      total -= chunkByteEstimate(c);
      zMap2.delete(victim.key);
      if (zMap2.size === 0) store.delete(victim.z);
      evictions++;
    }
  }

  function totalBytes() {
    var total = 0;
    for (var zEntry of store) {
      for (var cEntry of zEntry[1]) total += chunkByteEstimate(cEntry[1]);
    }
    return total;
  }

  function stats() {
    var chunks = 0;
    for (var zEntry of store) chunks += zEntry[1].size;
    return {
      chunks: chunks,
      zLevels: store.size,
      bytes: totalBytes(),
      evictions: evictions,
      worldSeq: v1WorldSeq,
    };
  }

  function setBudgetBytes(n) {
    if (typeof n === "number" && n > 0) budgetBytes = n;
    maybeEvict();
  }

  function reset() {
    store = new Map();
    globalVer = 0;
    evictions = 0;
    camHintZ = 0;
    v1WorldSeq = 0;
  }

  function setCamHintZ(z) {
    if (typeof z === "number") camHintZ = z;
  }

  // The wire's bit-packed sub-fields are RE-derived rather than assumed byte-identical to the SoA's own
  // packing, so the two representations can evolve independently.
  function writeBlockTile(chunk, idx, rec) {
    if (rec.tt === 0xffff) {
      chunk.tt[idx] = 0xffff;
      chunk.mat[idx] = 0;
      chunk.bits[idx] = 0;
      var vd1 = (rec.dig & 0xF) | ((rec.smooth & 3) << 4) | ((rec.marker & 1) << 6) |
        ((rec.automine & 1) << 7);
      var vd2 = (rec.traffic & 3) | ((rec.track & 0xF) << 2);
      chunk.desig[idx] = (vd1 & 0xFF) | ((vd2 & 0xFF) << 8);
      chunk.spatterAmt[idx] = 0;
      chunk.flags2[idx] = 0;
      return;
    }
    chunk.tt[idx] = rec.tt;
    chunk.mat[idx] = packMat(rec.base_mt, rec.base_mi);
    chunk.bits[idx] = (rec.liquid & 3) | ((rec.flow & 7) << 2) | ((rec.hidden & 1) << 5) | ((rec.outside & 1) << 6);
    var desig1 = (rec.dig & 0xF) | ((rec.smooth & 3) << 4) | ((rec.marker & 1) << 6) |
      ((rec.automine & 1) << 7);
    var desig2 = (rec.traffic & 3) | ((rec.track & 0xF) << 2);
    chunk.desig[idx] = (desig1 & 0xFF) | ((desig2 & 0xFF) << 8);
    chunk.spatterAmt[idx] = rec.spatter_amt & 0xFF;
    chunk.flags2[idx] = rec.flags2 & 0xFFFF;
  }

  function tailToSparseField(kind, data) {
    if (kind === 0x01 /* ITEM */) {
      return { field: "item", value: {
        type: itemTypeMeta.get(data.item_type) || String(data.item_type),
        mat_type: data.mat_type, mat_index: data.mat_index,
        subtype: data.subtype, iflags: data.iflags, stack: data.stack,
        // DF corpse->skeleton label bit (present only when DF names it a skeleton;
        // undefined for a fresh corpse / old server -> the resolver's body branch).
        skeletal: data.skeletal,
        grown: data.grown,
        artifact: data.artifact,
        quality: data.quality,
        qflags: data.qflags,
        wear: data.wear,
        // The cut-gem discriminator. The decoder already parsed it, but this bridge used to
        // drop it, collapsing all 22 authored cuts onto gem_default.
        shape: data.shape,
        // Item identity extension (additive): only present when the wire carried a token.
        identKind: data.identKind, ident: data.ident,
      } };
    }
    if (kind === 0x02 /* PLANT */) {
      return { field: "plant", value: { part: PLANT_PART_NAMES[data.part] || "SHRUB", id: data.id || "" } };
    }
    if (kind === 0x04 /* FLOW -- one densest entry per tile, single-valued */) {
      return { field: "flow", value: { type: data.flow_type, density: data.density } };
    }
    if (kind === 0x06 /* GRASS -- max-amount-wins per tile, single-valued */) {
      return { field: "grass", value: { id: data.id || "", amount: data.amount } };
    }
    if (kind === 0x08 /* DESIG_PRIORITY -- one priority per designated tile, single-valued */) {
      return { field: "desigPriority", value: { priority: data.priority } };
    }
    if (kind === 0x0A /* CONTAINER_PEEK -- one representative content per container tile */) {
      // Same itemTypeMeta numeric->string resolution the ITEM tail gets, so the renderers'
      // category classifiers can key off "MEAT"/"PLANT"/... directly.
      return { field: "peek", value: {
        type: itemTypeMeta.get(data.item_type) || String(data.item_type),
        mat_type: data.mat_type, mat_index: data.mat_index,
        subtype: data.subtype, cflags: data.cflags,
      } };
    }
    if (kind === 0x0B /* FARM_CROP -- one planted crop per farm tile */) {
      return { field: "farmCrop", value: { id: data.id || "", stage: data.stage | 0 } };
    }
    if (kind === 0x0C /* TREE-KEY -- packed wood/leaf resolver keys */) {
      return { field: "treeGraphics", value: {
        woodKey: data.woodKey >>> 0, leafKey: data.leafKey >>> 0,
        woodPresent: !!data.woodPresent, leafPresent: !!data.leafPresent,
        growthPresent: !!data.growthPresent,
      } };
    }
    if (kind === 0x0D /* ITEM_ART, ITEM-SPRITES-R2 */) {
      return { field: "itemArt", value: {
        instrumentClass: data.instrumentClass,
        specialMaterial: data.specialMaterial === true,
        generatedTool: data.generatedTool === true,
      } };
    }
    return null; // unknown/multi-valued kind -- skipped here (0x03/0x05/0x07/0x09 handled inline below)
  }

  // A fresh all-void, undesignated block is not authoritative terrain. Caching one poisons the view:
  // windowView sees a chunk, paints black and suppresses REQ_BLOCKS forever, discarding the real arrival.
  function recordsHaveTerrain(records) {
    for (var i = 0; i < records.length; i++) if (records[i] && records[i].tt !== 0xffff) return true;
    return false;
  }
  function recordsHaveDesignation(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r && (r.dig || r.smooth || r.marker || r.automine || r.traffic || r.track)) return true;
    }
    return false;
  }

  // `arrayBuffer` is the frame PAYLOAD only; the caller has already stripped the header.
  function ingestBlocks(arrayBuffer) {
    if (typeof DwfWireV1 === "undefined" || !DwfWireV1 || typeof DwfWireV1.decodeBlockSet !== "function") {
      throw new Error("DwfCache.ingestBlocks: DwfWireV1 decoder not loaded");
    }
    var bytes = (arrayBuffer instanceof Uint8Array) ? arrayBuffer : new Uint8Array(arrayBuffer);
    var decoded = DwfWireV1.decodeBlockSet(bytes);
    if (!decoded || !decoded.blocks || !decoded.blocks.length) return null;
    if (typeof decoded.world_seq === "number" && decoded.world_seq > v1WorldSeq) v1WorldSeq = decoded.world_seq;

    var dirtyByZ = new Map(); // z -> Set(key)
    for (var b = 0; b < decoded.blocks.length; b++) {
      var block = decoded.blocks[b];
      var z = block.bz;
      var key = block.bx * 4096 + block.by; // block coords are ALREADY tile_x>>4/tile_y>>4 (§0.3)
      var existing = getChunk(z, key);
      // A legacy/HTTP chunk's local `ver` is not comparable to the server's block version, so apply
      // idempotence only when the resident chunk is itself a complete v1 or raw block.
      if (existing && existing.baked === false && typeof block.ver === "number" &&
          block.ver <= existing.ver && existing.ver !== 0) continue; // idempotent skip (protocol 0.6)
      var carriesTerrain = recordsHaveTerrain(block.records);
      var carriesDesignation = recordsHaveDesignation(block.records);
      if (!existing && !carriesTerrain && !carriesDesignation) {
        // Leave the address absent. A visible window will keep it in the bounded REQ_BLOCKS
        // state machine instead of converting this suspect arrival into permanent black.
        continue;
      }
      var chunk = existing || ensureChunk(z, key);

      for (var i = 0; i < 256; i++) writeBlockTile(chunk, i, block.records[i]);
      chunk.sparse = new Map(); // whole-block current state -- stale tails must not survive
      var tails = block.tails || [];
      for (var t = 0; t < tails.length; t++) {
        var tail = tails[t];
        var sp = chunk.sparse.get(tail.tile_idx);
        if (!sp) { sp = {}; chunk.sparse.set(tail.tile_idx, sp); }
        if (tail.kind === 0x03 /* SPATTER_MAT */) {
          sp.spatters = sp.spatters || [];
          sp.spatters.push({ mat_type: tail.data.mat_type, mat_index: tail.data.mat_index,
                              amount: tail.data.amount, state: tail.data.state, rgb: tail.data.rgb });
          if (!sp.spatterMat) sp.spatterMat = sp.spatters[0]; // back-compat single-event field
          continue;
        }
        if (tail.kind === 0x05 /* ITEM_SPATTER */) {
          sp.itemSpatters = sp.itemSpatters || [];
          sp.itemSpatters.push({ growth_class: tail.data.growth_class, item_type: tail.data.item_type,
                                 amount: tail.data.amount, rgb: tail.data.rgb });
          continue;
        }
        if (tail.kind === 0x07 /* ENGRAVING */) {
          sp.engravings = sp.engravings || [];
          sp.engravings.push({ eflags: tail.data.eflags, quality: tail.data.quality });
          continue;
        }
        if (tail.kind === 0x09 /* VERMIN */) {
          sp.vermin = sp.vermin || [];
          // Vermin identity extension (WIRE-TAILS): carry the server-resolved creature token
          // so the client can resolve creatures_map directly (no runtime race-index dict).
          sp.vermin.push({ race: tail.data.race, caste: tail.data.caste, vflags: tail.data.vflags, token: tail.data.token });
          continue;
        }
        var mapped = tailToSparseField(tail.kind, tail.data);
        if (!mapped) continue; // unknown tail kind -- skipped (additive-growth surface, §0.3.2)
        sp[mapped.field] = mapped.value;
      }
      // ITEM_ART is a separate additive tail. Merge after the tail walk so ordering is irrelevant.
      for (var sparseValue of chunk.sparse.values()) {
        if (!sparseValue.item || !sparseValue.itemArt) continue;
        if (typeof sparseValue.itemArt.instrumentClass === "number")
          sparseValue.item.instrumentClass = sparseValue.itemArt.instrumentClass;
        if (sparseValue.itemArt.specialMaterial === true)
          sparseValue.item.specialMaterial = true;
        if (sparseValue.itemArt.generatedTool === true)
          sparseValue.item.generatedTool = true;
        delete sparseValue.itemArt;
      }
      chunk.ver = block.ver;
      chunk.baked = false; // raw per-z truth (the see-down composite activates)
      chunk.dirty = true;

      var zSet = dirtyByZ.get(z);
      if (!zSet) { zSet = new Set(); dirtyByZ.set(z, zSet); }
      zSet.add(key);
    }
    if (dirtyByZ.size) maybeEvict();
    var byZ = [];
    for (var zEntry2 of dirtyByZ) byZ.push({ z: zEntry2[0], keys: Array.from(zEntry2[1]) });
    return { byZ: byZ, stats: stats() };
  }

  // Packages a z/keys dirty set into the full-chunk-contents shape the main thread expects.
  function buildDirtyChunksPayload(z, keys) {
    var zMap = store.get(z);
    var chunksOut = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var c = zMap && zMap.get(key);
      if (!c) continue;
      chunksOut.push({
        key: key,
        tt: c.tt, mat: c.mat, bits: c.bits, desig: c.desig,
        spatterAmt: c.spatterAmt, flags2: c.flags2,
        spriteCell: c.spriteCell, tint: c.tint,
        sparse: Array.from(c.sparse.entries()),
        ver: c.ver, baked: c.baked,
      });
    }
    return chunksOut;
  }

  var CORE = {
    ingestLegacy: ingestLegacy,
    ingestBlocks: ingestBlocks,
    getChunk: getChunk,
    chunkKeyFor: chunkKeyFor,
    stats: stats,
    setBudgetBytes: setBudgetBytes,
    reset: reset,
    setCamHintZ: setCamHintZ,
    setItemTypeMeta: setItemTypeMetaList,
    packMat: packMat,
    unpackMat: unpackMat,
    DIG_NAMES: DIG_NAMES,
    DIG_INDEX: DIG_INDEX,
    PLANT_PART_NAMES: PLANT_PART_NAMES,
  };

  // ---- dual-mode wiring (see file banner) ------------------------------------------------
  var isDedicatedWorker = (typeof scope.window === "undefined") && (typeof scope.postMessage === "function");
  if (isDedicatedWorker) {
    scope.onmessage = function (ev) {
      var msg = ev && ev.data;
      if (!msg || typeof msg !== "object") return;
      try {
        if (msg.type === "ingest") {
          var dirty = ingestLegacy(msg.map);
          if (!dirty) { scope.postMessage({ type: "dirty", jobId: msg.jobId, z: null, keys: [], stats: stats() }); return; }
          // A structured-clone copy, never a zero-copy transfer: the worker keeps mutating these same chunks on
          // future deltas, so their buffers must stay attached on this side.
          var chunks = buildDirtyChunksPayload(dirty.z, dirty.keys);
          scope.postMessage({ type: "dirty", jobId: msg.jobId, z: dirty.z, keys: dirty.keys, chunks: chunks, stats: dirty.stats });
        } else if (msg.type === "ingestBlocks") {
          var res = ingestBlocks(msg.buffer);
          if (!res || !res.byZ.length) {
            scope.postMessage({ type: "dirty", jobId: msg.jobId, z: null, keys: [], stats: stats() });
          } else {
            for (var zi = 0; zi < res.byZ.length; zi++) {
              var zGroup = res.byZ[zi];
              var chunksV1 = buildDirtyChunksPayload(zGroup.z, zGroup.keys);
              scope.postMessage({ type: "dirty", jobId: msg.jobId, z: zGroup.z, keys: zGroup.keys, chunks: chunksV1, stats: res.stats });
            }
          }
        } else if (msg.type === "setBudget") {
          setBudgetBytes(msg.bytes);
        } else if (msg.type === "reset") {
          reset();
        } else if (msg.type === "setItemTypeMeta") {
          setItemTypeMetaList(msg.list);
        } else if (msg.type === "setCamHintZ") {
          setCamHintZ(msg.z);
        }
      } catch (err) {
        try {
          scope.postMessage({ type: "error", phase: msg.type || "message", fatal: true,
            jobId: msg.jobId, message: String(err && err.message || err) });
        } catch { /* the parent's readiness timeout demotes the unreachable worker */ }
      }
    };
    // Do not let the parent transfer BLOCK_SET buffers until the decoder import has definitely succeeded:
    // a Worker constructor can succeed while importScripts later fails, and acked frames would never land.
    if (_decoderReady) {
      scope.postMessage({ type: "ready" });
    } else {
      scope.postMessage({ type: "error", phase: "startup", fatal: true,
        message: "cache worker decoder unavailable: " + (_decoderError || "unknown error") });
    }
  } else {
    // Not a dedicated worker (plain <script> load or a Node test harness): expose the ingest
    // core directly so dwf-cache.js can run it in-process, synchronously.
    scope.DwfCacheWorkerCore = CORE;
  }
})(typeof self !== "undefined" ? self : this);
