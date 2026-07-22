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

// dwf-cache-worker.js -- WA-6 (docs/superpowers/specs/2026-07-07-WA-foundation-spec.md,
// "world cache module + worker ingest"). Owns the chunked SoA world-cache layout from the
// WebGL report's §2C ("W3. World cache + worker ingest") -- this is the SAME structure W-B's
// GL renderer will consume, so the layout below must not be improvised.
//
// DUAL-MODE FILE: this script is loaded TWO different ways by dwf-cache.js --
//   1. As a real dedicated Worker (`new Worker(url)`) -- the production path. There, `self`
//      has no `window` (WorkerGlobalScope), so the code below wires `self.onmessage` and does
//      the actual ingest work off the main thread.
//   2. As a plain <script> (or, in a Node unit test, via vm.runInThisContext against a
//      window-shaped global) -- the synchronous FALLBACK path for browsers/tests where a
//      dedicated Worker isn't available or didn't construct. There, `self === window`, so the
//      code below just exposes the exact same ingest core as `DwfCacheWorkerCore` for
//      dwf-cache.js to call in-process. Both modes execute the IDENTICAL ingest
//      function -- one source of truth for the chunk layout and the legacy-JSON mapping.
//
// Chunk layout (webgl-render-report.md §2C, mirrored exactly):
//   WorldCache = Map<z, Map<chunkKey = bx*4096+by, Chunk>>
//   Chunk (SoA, 256 tiles, idx = ly*16+lx):
//     raw:     tt Uint16Array(256) | mat Int32Array(256) (base_mt<<16 | base_mi&0xFFFF)
//              | bits Uint8Array(256) (liquid:2|flow:3|hidden:1|outside:1)
//              | desig Uint16Array(256) (desig1|desig2<<8) | spatterAmt Uint8Array(256)
//              | flags2 Uint16Array(256)
//     sparse:  Map<idx, {item?, plant?, spatterMat?}>  (JSON-shaped detail objects --
//              transitional legacy ingest keeps these as the wire's own object shapes; no
//              need for the v1 binary tail encoding until WA-12's ingestBlocks() lands)
//     derived: spriteCell Uint16Array(256) | tint Uint32Array(256)  (hooks only -- WA-6
//              writes 0/0 and documents the contract; W-B's W5 fills real values)
//     ver u32, dirty bool, baked bool  (baked=true always for this transitional legacy-JSON
//              ingest path; v1 raw ingest via ingestBlocks() sets false, WA-12)
//
// Legacy-JSON -> record mapping (WA-6 approach point 3): tt<0 -> 0xFFFF void (a void record
// zeroes every other field and clears any sparse entry); liquid string -> 2-bit code;
// flow/hidden/outside -> the bits byte; desig object -> desig1/desig2 (a LOCAL, self-consistent
// dig-designation ordinal table -- nothing outside this cache ever reads these numeric bits, so
// they only need to round-trip through this module's OWN decode, not match DFHack's real enum
// ordinals); strings (ttname/shape/mat/special) are NOT stored, only the numeric `tt` (the
// legacy wire already sends `tt` as the raw numeric df::tiletype value) -- dwf-cache.js's
// windowView() re-derives the strings via the WA-5 `/tiletype_meta.json` table. wallnbr is
// DISCARDED here entirely (WA-7 synthesizes it at read time from neighbor shapes).

(function (scope) {
  "use strict";

  // WA-12: in a real dedicated Worker, self-load the reference v1 decoder (dwf-wire-v1.js,
  // WA-8) via importScripts BEFORE anything below runs -- ingestBlocks() needs
  // DwfWireV1.decodeHeader/decodeBlockSet. Derived from this worker's OWN script URL (same
  // directory, same ?v= query the page used to load it) so no caller wiring is needed. In the
  // dual-mode fallback (plain <script> or a Node harness), the decoder is expected to already be
  // a global -- either loaded as a sibling <script> tag or attached directly onto the shared vm
  // context by the test (see tools/harness/cache_test.mjs's v1 section) -- so importScripts is
  // skipped there (it doesn't exist outside a dedicated worker anyway).
  var _isDedicatedWorkerEarly = (typeof scope.window === "undefined") && (typeof scope.postMessage === "function");
  if (_isDedicatedWorkerEarly && typeof scope.importScripts === "function") {
    try {
      var _selfUrl = String((scope.location && scope.location.href) || "");
      var _wireUrl = _selfUrl.indexOf("dwf-cache-worker.js") !== -1
        ? _selfUrl.replace("dwf-cache-worker.js", "dwf-wire-v1.js")
        : "/js/dwf-wire-v1.js";
      scope.importScripts(_wireUrl);
    } catch (_) { /* ingestBlocks() below throws a clear error if the decoder never loaded */ }
  }

  // ---- local self-consistent dig-designation ordinal table (see file banner) -----------
  var DIG_NAMES = ["No", "Default", "UpDownStair", "Channel", "Ramp", "DownStair", "UpStair"];
  var DIG_INDEX = Object.create(null);
  for (var _di = 0; _di < DIG_NAMES.length; _di++) DIG_INDEX[DIG_NAMES[_di]] = _di;

  // WA-12: local numeric->string table for the wire's PLANT tail `part` field (§0.3.2) -- a
  // fixed 6-value enum defined directly in the wire spec, so (like DIG_NAMES) this only needs
  // to be self-consistent, not sourced from a server table.
  var PLANT_PART_NAMES = ["TRUNK", "BRANCH", "CANOPY", "LEAVES", "SAPLING", "SHRUB"];

  // WA-12: item_type enum resolution (numeric wire value -> string key, §0.7). Populated via a
  // "setItemTypeMeta" message from the main thread (fed from GET /item_type_meta.json, WA-5) --
  // needed so v1-ingested sparse `item` entries carry the SAME string-keyed shape the legacy
  // JSON ingest path already produces (dwf-tiles.js's itemMap lookup expects a string).
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
      spriteCell: new Uint16Array(CHUNK_TILES),   // hook only -- W-B (W5) fills real values
      tint: new Uint32Array(CHUNK_TILES),          // hook only -- W-B (W5) fills real values
      sparse: new Map(),
      ver: 0,
      dirty: false,
      baked: true,   // legacy-JSON ingest is always the server's already-baked see-down output
    };
  }

  // Rough per-chunk byte estimate for the memory budget (item 4): fixed SoA arrays are exact;
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
  var budgetBytes = 128 * 1024 * 1024; // 128 MB default (item 4)
  // WA-12: highest protocol-v1 world_seq observed across every ingested BLOCK_SET payload --
  // this is what the client hands back as `hello.have` on (re)connect (§0.6 resume). Legacy-
  // JSON ingest never touches this (it has no notion of world_seq).
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

  // Write one legacy-JSON tile object into the chunk's SoA slot `idx`. Mirrors the exact
  // field semantics of tile_map_dump.cpp's emit_tile_fields (ground truth §1.3), minus the
  // strings and minus wallnbr (both discarded per the file banner).
  function writeTileRecord(chunk, idx, t) {
    var tt = (typeof t.tt === "number") ? t.tt : -1;
    if (tt < 0) {
      chunk.tt[idx] = 0xFFFF;
      chunk.mat[idx] = 0;
      chunk.bits[idx] = 0;
      // BLACK-GLYPHS/B204: a void tile keeps its designation (see writeBlockTile) so a designation
      // dropped into fully-hidden rock still surfaces as a glyph over black. Undesignated void tiles
      // carry no t.desig, so this stays 0 (pure black) -- unchanged from before.
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
      // WC-1 (additive): subtype/iflags/stack only added when the legacy JSON actually
      // carries them (older fixtures/frames without them keep the original 3-key shape --
      // never fabricated defaults, so a byte-for-byte fixture comparison upstream still
      // matches exactly what it always matched).
      if (typeof t.item.subtype === "number") itm.subtype = t.item.subtype;
      if (typeof t.item.iflags === "number") itm.iflags = t.item.iflags;
      if (typeof t.item.stack === "number") itm.stack = t.item.stack;
      // CORPSETEX-B195: DF's corpse->skeleton label bit (only present on new-server wire).
      if (typeof t.item.skeletal === "boolean") itm.skeletal = t.item.skeletal;
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
      // WC-11 (additive, same rule as item.subtype above): `state` only when present.
      if (typeof t.spatter.state === "number") spm.state = t.spatter.state;
      sp.spatterMat = spm;
      flags2 |= 4;
      chunk.spatterAmt[idx] = Math.max(0, Math.min(255, t.spatter.amount | 0));
    } else {
      chunk.spatterAmt[idx] = 0;
    }
    // WC-11 (additive, legacy is first-event-only per tile_map_dump.cpp's own comment --
    // this JSON path is "scheduled for deletion once the client migrates" to the wire_v1
    // SPATTER tail's multi-event ordering): fallen-leaves/fruit litter + block flow. Only
    // added when the field is actually present, so tiles/fixtures without it are byte-for-
    // byte unchanged from before this item.
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

  // Ingest one legacy WS map payload ({origin,width,height,z,tiles:[...]}). Both keyframe
  // and delta pushes carry per-tile world x/y (ground truth §1.2 DOC-DRIFT: "every pushed
  // tile -- keyframe or delta -- carries per-tile world x/y"), so ingest needs no notion of
  // "mode" at all: it just writes whichever tiles are present by world coordinate. Returns
  // {z, keys[], stats} describing what changed, or null if the payload was unusable.
  function ingestLegacy(map) {
    if (!map || !map.origin || !Array.isArray(map.tiles)) return null;
    var z = (typeof map.z === "number") ? map.z : map.origin.z;
    var ox = map.origin.x, oy = map.origin.y;
    var w = map.width, h = map.height;
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
      chunk.dirty = true;
      dirtyKeys.add(key);
    }
    if (dirtyKeys.size) maybeEvict();
    return { z: z, keys: Array.from(dirtyKeys), stats: stats() };
  }

  // Item 4 (memory budget): on breach, evict the chunks farthest from the last-seen camera z
  // first (across ALL z-levels), until back under budget. `evictions` is a lifetime counter
  // surfaced on the F3 line.
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

  // WA-12: camera-z hint for the eviction heuristic (item 4), fed explicitly from AUX's
  // authoritative cam on the v1 path (legacy ingestLegacy self-derives it from map.z; v1
  // BLOCK_SETs can span many z-levels around the camera in one payload, so there's no single
  // "this payload's z" to infer it from).
  function setCamHintZ(z) {
    if (typeof z === "number") camHintZ = z;
  }

  // Write one decoded wire-v1 tile record (DwfWireV1.decodeTileRecord's shape) into the
  // chunk's SoA slot `idx`. The wire's bit-packed sub-fields (liquid/flow/hidden/outside,
  // dig/smooth/marker/automine, traffic/track) are RE-derived rather than assumed byte-identical to the
  // SoA's own packing (even though the two layouts happen to coincide by construction) -- this
  // keeps the two representations decoupled so either can evolve independently.
  function writeBlockTile(chunk, idx, rec) {
    if (rec.tt === 0xffff) {
      chunk.tt[idx] = 0xffff;
      chunk.mat[idx] = 0;
      chunk.bits[idx] = 0;
      // BLACK-GLYPHS/B204: a VOID tile still preserves its packed designation. A fully-hidden block
      // shipped only to carry designations (src/wire_v1.cpp encode_block) sends void tiletypes with
      // live desig bytes; zeroing desig here would drop the very payload the block was shipped for.
      // Undesignated void tiles decode to 0, so this stays 0 for them (pure black) -- unchanged.
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

  // Build the sparse detail object for one SINGLE-valued tail entry (already kind-decoded by
  // DwfWireV1.decodeTailData) into the SAME shape the legacy JSON ingest path produces
  // (dwf-tiles.js's draw layers read `t.item.type` (string), `t.plant.part`/`.id`
  // (strings) -- see writeTileRecord's sp.* shapes above). ITEM tail also carries WC-1's
  // subtype/iflags/stack (always present on the v1 wire's 12-byte ITEM tail -- the decoder
  // defaults them to -1/0/1 for a hypothetical shorter/older frame, so they're always numbers
  // here). SPATTER_MAT (0x03) and ITEM_SPATTER (0x05) are handled separately in the ingest
  // loop below since a tile can carry MULTIPLE of each (WC-11 layered events) -- this helper
  // only covers the single-value kinds.
  function tailToSparseField(kind, data) {
    if (kind === 0x01 /* ITEM */) {
      return { field: "item", value: {
        type: itemTypeMeta.get(data.item_type) || String(data.item_type),
        mat_type: data.mat_type, mat_index: data.mat_index,
        subtype: data.subtype, iflags: data.iflags, stack: data.stack,
        // CORPSETEX-B195: DF corpse->skeleton label bit (present only when DF names it a skeleton;
        // undefined for a fresh corpse / old server -> the resolver's body branch).
        skeletal: data.skeletal,
        // Item identity extension (additive): only present when the wire carried a token.
        identKind: data.identKind, ident: data.ident,
      } };
    }
    if (kind === 0x02 /* PLANT */) {
      return { field: "plant", value: { part: PLANT_PART_NAMES[data.part] || "SHRUB", id: data.id || "" } };
    }
    if (kind === 0x04 /* FLOW, WC-15 -- one densest entry per tile, single-valued */) {
      return { field: "flow", value: { type: data.flow_type, density: data.density } };
    }
    if (kind === 0x06 /* GRASS, WC-17 -- max-amount-wins per tile, single-valued */) {
      return { field: "grass", value: { id: data.id || "", amount: data.amount } };
    }
    if (kind === 0x08 /* DESIG_PRIORITY, WC-19 -- one priority per designated tile, single-valued */) {
      return { field: "desigPriority", value: { priority: data.priority } };
    }
    if (kind === 0x0A /* CONTAINER_PEEK, TX1 -- one representative content per container tile */) {
      // Same itemTypeMeta numeric->string resolution the ITEM tail gets, so the renderers'
      // category classifiers can key off "MEAT"/"PLANT"/... directly.
      return { field: "peek", value: {
        type: itemTypeMeta.get(data.item_type) || String(data.item_type),
        mat_type: data.mat_type, mat_index: data.mat_index,
        subtype: data.subtype, cflags: data.cflags,
      } };
    }
    if (kind === 0x0B /* FARM_CROP, TX4 -- one planted crop per farm tile */) {
      return { field: "farmCrop", value: { id: data.id || "", stage: data.stage | 0 } };
    }
    return null; // unknown/multi-valued kind -- skipped here (0x03/0x05/0x07/0x09 handled inline below)
  }

  // WA-12 core: decode + apply one protocol-v1 BLOCK_SET binary frame payload (the wire's OWN
  // current-STATE-not-diff record set, §0.3). Idempotent per §0.6: a block is applied ONLY if
  // its `ver` is strictly newer than the chunk's currently-stored `ver` -- an equal-or-stale
  // resend (duplicate delivery, resume overlap) is a silent no-op. Every touched chunk is
  // marked `baked=false` (raw per-z truth -- WA-7's client-side see-down composite activates
  // for these chunks) and has its ENTIRE sparse map replaced (the block carries the tile's
  // complete current tail set, not a diff, so a tail that no longer appears must be cleared).
  // `arrayBuffer` is the frame's PAYLOAD ONLY (header already stripped by the caller). Returns
  // `{byZ:[{z,keys[]}...], stats}` describing what changed, or null if the frame wasn't a
  // (recognized, block-count>0) BLOCK_SET.
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
      var chunk = ensureChunk(z, key);
      if (typeof block.ver === "number" && block.ver <= chunk.ver && chunk.ver !== 0) continue; // idempotent skip (§0.6)

      for (var i = 0; i < 256; i++) writeBlockTile(chunk, i, block.records[i]);
      chunk.sparse = new Map(); // whole-block current state -- stale tails must not survive
      var tails = block.tails || [];
      for (var t = 0; t < tails.length; t++) {
        var tail = tails[t];
        var sp = chunk.sparse.get(tail.tile_idx);
        if (!sp) { sp = {}; chunk.sparse.set(tail.tile_idx, sp); }
        // WC-11: SPATTER_MAT (0x03) and ITEM_SPATTER (0x05) are MULTI-valued -- the server
        // now emits up to 4 layered material-spatter events (amount-desc) and any number of
        // fallen-leaves/fruit litter events per tile, so these two kinds accumulate into
        // arrays instead of overwriting a single field (the pre-WC-11 behavior, which only
        // ever saw one event per tile, so `sp.field = value` was never observably lossy).
        if (tail.kind === 0x03 /* SPATTER_MAT */) {
          sp.spatters = sp.spatters || [];
          // blood-family color extension (WC-22 gap): the decoder attaches an optional
          // resolved `rgb` [r,g,b] (server-side MaterialInfo->descriptor_color) when the
          // wire carried it; kept verbatim (undefined when absent) so the client apply can
          // hue-classify blood/ichor/goo families instead of the stable-hash pick.
          sp.spatters.push({ mat_type: tail.data.mat_type, mat_index: tail.data.mat_index,
                              amount: tail.data.amount, state: tail.data.state, rgb: tail.data.rgb });
          if (!sp.spatterMat) sp.spatterMat = sp.spatters[0]; // back-compat single-event field
          continue;
        }
        if (tail.kind === 0x05 /* ITEM_SPATTER */) {
          sp.itemSpatters = sp.itemSpatters || [];
          // TX6-SPECIES-TINT root cause (window #23): this rebuild used to keep only
          // {growth_class,item_type,amount}, silently DROPPING the decoder's optional per-
          // species `rgb` -- so every fruit/leaf litter tile fell back to the one family tint
          // (uniform brown) even though the server resolved and shipped distinct colors, the
          // wire decoded them, and both renderers prefer isp.rgb. Keep it verbatim (undefined
          // when absent), exactly like the SPATTER_MAT branch above keeps its rgb.
          sp.itemSpatters.push({ growth_class: tail.data.growth_class, item_type: tail.data.item_type,
                                 amount: tail.data.amount, rgb: tail.data.rgb });
          continue;
        }
        // WC-18: ENGRAVING (0x07) is MULTI-valued -- a tile can carry one record per
        // engraved face (north wall + south wall + floor all independently), so these
        // accumulate into an array like SPATTER_MAT/ITEM_SPATTER above; the client apply
        // (dwf-tiles.js) OR-combines every record's eflags into one wall-face mask.
        if (tail.kind === 0x07 /* ENGRAVING */) {
          sp.engravings = sp.engravings || [];
          sp.engravings.push({ eflags: tail.data.eflags, quality: tail.data.quality });
          continue;
        }
        // WC-21: VERMIN (0x09) is MULTI-valued -- a tile can hold several distinct vermin
        // (a lone bug + a colony, the golden fixture's tile 15 case), so these accumulate
        // into an array like ENGRAVING/SPATTER above; the client apply picks a sprite per
        // entry (VERMIN cell for lone, SWARM_* for colonies) from creatures_map.
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
      chunk.ver = block.ver;
      chunk.baked = false; // raw per-z truth (WA-7 item 2's see-down composite activates)
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

  // Shared by both the "ingest" (legacy) and "ingestBlocks" (v1) dedicated-worker message
  // handlers below: package a z/keys dirty set into the full-chunk-contents wire shape the
  // main thread's handleWorkerMessage()/installMirrorChunk() expect.
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
          // Ship back the FULL updated chunk contents for every dirtied key (structured-clone
          // copy, not a zero-copy transfer -- the worker keeps mutating these same chunks on
          // future deltas, so their buffers must stay attached on this side).
          var chunks = buildDirtyChunksPayload(dirty.z, dirty.keys);
          scope.postMessage({ type: "dirty", jobId: msg.jobId, z: dirty.z, keys: dirty.keys, chunks: chunks, stats: dirty.stats });
        } else if (msg.type === "ingestBlocks") {
          // WA-12: `msg.buffer` is the frame's PAYLOAD ONLY, TRANSFERRED from the main thread
          // (dwf-ws.js strips + peeks the 10-byte header before handing it off). One
          // BLOCK_SET can span multiple z-levels (raw multi-z truth, §0.8) -- post one "dirty"
          // message PER z group so the main-thread mirror (which expects a single z per
          // message, same shape the legacy "ingest" branch above already produces) needs no
          // format change at all.
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
        try { scope.postMessage({ type: "error", jobId: msg.jobId, message: String(err && err.message || err) }); } catch (_) { /* ignore */ }
      }
    };
  } else {
    // Not a dedicated worker (plain <script> load or a Node test harness): expose the ingest
    // core directly so dwf-cache.js can run it in-process, synchronously.
    scope.DwfCacheWorkerCore = CORE;
  }
})(typeof self !== "undefined" ? self : this);
