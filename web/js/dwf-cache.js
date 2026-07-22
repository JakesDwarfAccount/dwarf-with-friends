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

// dwf-cache.js -- WA-6/WA-7 (docs/superpowers/specs/2026-07-07-WA-foundation-spec.md).
// Main-thread-owned persistent chunked world cache. This module is the seam WA-7 (bridge
// adapter) and W-B's future GL renderer both read through -- one source of truth, diffable.
//
// Backend selection: a real dedicated Worker (dwf-cache-worker.js) is used when
// available -- ingest (the per-tile SoA scatter-write work) runs off-main-thread there, and
// results come back as `dirty` messages that this module folds into its own read-side mirror
// (`store`, a plain Map<z, Map<key, Chunk>> used synchronously by windowView/getChunk). When a
// dedicated Worker can't be constructed (very old browser, blocked, or a non-browser test
// harness), the SAME ingest core (dwf-cache-worker.js, loaded as a plain script in that
// case) is called in-process, synchronously -- so the ingest ALGORITHM is one piece of code
// either way; only whether it runs on- or off-main-thread differs.
//
// WA-6 API (transitional JSON ingest, cache runs SHADOW-ONLY -- nothing reads windowView until
// WA-7 rewires dwf-tiles.js): ingest(mapMsg), ingestBlocks(buf) [stub, WA-12],
// getChunk(z,key), onDirty(cb), stats().
// WA-7 adds: windowView(ox,oy,z,w,h) + setTiletypeMeta(list) (the reconstituted-legacy-shape
// bridge adapter that lets the UNCHANGED canvas2d draw path read from this cache).

(function () {
  "use strict";

  // ---- worker/fallback backend -----------------------------------------------------------
  var worker = null;
  var core = null;          // synchronous fallback core (DwfCacheWorkerCore)
  var useWorker = false;
  var nextJobId = 1;
  var dirtyCbs = [];

  // P1: window assembly is the one place that knows a cache hole is actually visible. Keep
  // request state here: this side owns windowView(), and a BLOCK_SET answer arrives via dirty.
  var reqBlocks = new Map(); // "bx,by,bz" -> { inFlight, dueAt, attempts }
  var reqBlocksWanted = new Set(); // pending visible/explicit block ids not yet put on the wire
  var reqBlocksTimer = null;
  var lastReqBlocksAt = -Infinity;
  var reqBlocksEnabled = true;
  var REQ_BLOCKS_MIN_MS = 250;
  var REQ_BLOCKS_RESPONSE_MS = 1000;
  var REQ_BLOCKS_BACKOFF_MIN_MS = 500;
  var REQ_BLOCKS_BACKOFF_MAX_MS = 8000;
  var REQ_BLOCKS_MAX_PER_MESSAGE = 64;

  // The main-thread READ-SIDE mirror of the world cache. In fallback mode this Map IS the
  // authoritative store (same object the core mutates in-process). In worker mode this Map is
  // populated from `dirty` messages -- a synchronous, drawable snapshot of whatever the worker
  // has most recently reported, which is exactly what windowView()/getChunk() read.
  var mirror = new Map(); // z -> Map<key, Chunk-shaped plain object>
  var mirrorStats = { chunks: 0, zLevels: 0, bytes: 0, evictions: 0 };
  // Discovered-block index. The ingest backend deliberately keeps its store private, so retain
  // only the world-addressed keys announced by dirty notifications. Read by windowView()'s
  // REQ_BLOCKS suppression (a key that was never announced is undiscovered, not a hole to
  // refetch); getChunk() remains the authority for content. Adds no tile copy.
  var knownKeysByZ = new Map(); // z -> Set<packed bx*4096+by>
  // WT25: the world footprint from hello_ack (`map.{w,h,z}`), fed by dwf-tiles.js's
  // handleHelloAckV1. Read by the GL renderer (via cacheReader.mapDims()) to decide whether an
  // uncached tt<0 tile is in-bounds undiscovered rock (paint the base-hatch) or genuinely
  // off-map (paint black). windowView() itself does NOT need it -- its REQ_BLOCKS suppression
  // keys on knownKeysByZ membership (positive discovered-evidence), which is strictly correct
  // for both in-bounds-undiscovered and out-of-bounds void (neither is ever known).
  var worldMapDims = null; // {w,h,z} or null until hello_ack

  function resolveWorkerUrl() {
    // dwf-cache.js itself is served from /js/dwf-cache.js (or with a ?v= cache
    // buster) -- the worker script lives alongside it.
    try {
      var scripts = document.getElementsByTagName("script");
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].src || "";
        if (src.indexOf("dwf-cache.js") !== -1) {
          return src.replace("dwf-cache.js", "dwf-cache-worker.js");
        }
      }
    } catch (_) { /* fall through to the fixed path */ }
    return "/js/dwf-cache-worker.js";
  }

  function installMirrorChunk(z, entry) {
    var zMap = mirror.get(z);
    if (!zMap) { zMap = new Map(); mirror.set(z, zMap); }
    var sparse = new Map(entry.sparse || []);
    zMap.set(entry.key, {
      tt: entry.tt, mat: entry.mat, bits: entry.bits, desig: entry.desig,
      spatterAmt: entry.spatterAmt, flags2: entry.flags2,
      spriteCell: entry.spriteCell, tint: entry.tint,
      sparse: sparse, ver: entry.ver, baked: entry.baked,
    });
  }

  function handleWorkerMessage(ev) {
    var msg = ev && ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "dirty") {
      var chunks = msg.chunks || [];
      for (var i = 0; i < chunks.length; i++) installMirrorChunk(msg.z, chunks[i]);
      if (msg.stats) mirrorStats = msg.stats;
      fireDirty(msg.z, msg.keys || [], mirrorStats);
    }
    // "error" messages are swallowed here (shadow-only cache; ingest failures must never
    // affect the render/transport path) -- surfaced only via stats staying stale.
  }

  function ensureBackend() {
    if (worker || core) return;
    if (typeof Worker === "function") {
      try {
        var w = new Worker(resolveWorkerUrl());
        w.onmessage = handleWorkerMessage;
        w.onerror = function () { /* worker crash: fall through to no-op ingest, never throw */ };
        worker = w;
        useWorker = true;
        return;
      } catch (_) { /* fall through to the synchronous fallback */ }
    }
    if (typeof DwfCacheWorkerCore === "object" && DwfCacheWorkerCore) {
      core = DwfCacheWorkerCore;
      mirror = null; // fallback mode: the core's OWN store is authoritative, no mirroring needed
    }
  }

  function fireDirty(z, keys, statsObj) {
    if (typeof z === "number") {
      var known = knownKeysByZ.get(z);
      if (!known) { known = new Set(); knownKeysByZ.set(z, known); }
      for (var kk = 0; kk < keys.length; kk++) known.add(Number(keys[kk]));
    }
    // A newly applied block answers any outstanding request for the same world address.
    for (var rk = 0; rk < keys.length; rk++) {
      // Worker dirty keys use the cache's packed bx*4096+by form, while REQ_BLOCKS ids use
      // "bx,by,bz". P1 previously concatenated the packed key directly ("4097,20"), which
      // never matched an in-flight request such as "1,1,20" and left the refill stale.
      var packed = Number(keys[rk]);
      var bx = Math.floor(packed / 4096);
      var by = packed - bx * 4096;
      var answered = reqBlockId(bx, by, z);
      reqBlocks.delete(answered);
      reqBlocksWanted.delete(answered);
    }
    if (reqBlocksWanted.size) scheduleReqBlocksPump(0);
    for (var i = 0; i < dirtyCbs.length; i++) {
      try { dirtyCbs[i](z, keys, statsObj); } catch (_) { /* a bad subscriber must never break ingest */ }
    }
  }

  // ---- public API: ingest ----------------------------------------------------------------
  // Transitional legacy-JSON ingest (WA-6 approach point 3). `mapMsg` is the "map" object of
  // a WS push ({origin,width,height,z,tiles:[...]}) -- mode (key vs delta) doesn't matter here
  // since both carry per-tile world x/y on the push path (ground truth §1.2 DOC-DRIFT).
  function ingest(mapMsg) {
    ensureBackend();
    if (useWorker) {
      try { worker.postMessage({ type: "ingest", jobId: nextJobId++, map: mapMsg }); }
      catch (_) { /* shadow-only: a post failure must never affect the caller */ }
      return;
    }
    if (core) {
      try {
        var dirty = core.ingestLegacy(mapMsg);
        if (dirty) fireDirty(dirty.z, dirty.keys, dirty.stats);
      } catch (_) { /* shadow-only */ }
    }
    // Neither backend available (e.g. a non-browser context with no DwfCacheWorkerCore
    // loaded either): ingest is a documented, silent no-op.
  }

  // WA-12: ingest one protocol-v1 BLOCK_SET frame PAYLOAD (header already stripped by the
  // caller, dwf-ws.js). In worker mode the buffer is handed over TRANSFERRED (WebGL
  // ASSUMES-8 -- zero-copy across the postMessage boundary); in fallback/sync mode the same
  // ingest core runs in-process and this function fires `dirty` synchronously, exactly
  // mirroring how `ingest()` (legacy JSON) already behaves in both modes.
  function ingestBlocks(arrayBuffer) {
    ensureBackend();
    if (useWorker) {
      try { worker.postMessage({ type: "ingestBlocks", jobId: nextJobId++, buffer: arrayBuffer }, [arrayBuffer]); }
      catch (_) { /* a post/transfer failure must never throw out to the caller (ws.js) */ }
      return;
    }
    if (core) {
      var res = core.ingestBlocks(arrayBuffer); // throws if the wire-v1 decoder never loaded
      if (res && res.byZ) {
        for (var i = 0; i < res.byZ.length; i++) fireDirty(res.byZ[i].z, res.byZ[i].keys, res.stats);
      }
      return res; // sync-mode callers (tests) can inspect what changed; worker mode has no sync return
    }
    throw new Error("DwfCache.ingestBlocks: no ingest backend available");
  }

  function getChunk(z, key) {
    ensureBackend();
    if (!useWorker && core) return core.getChunk(z, key);
    var zMap = mirror.get(z);
    return (zMap && zMap.get(key)) || null;
  }

  function chunkKeyFor(x, y) {
    return (x >> 4) * 4096 + (y >> 4);
  }

  function onDirty(cb) {
    if (typeof cb === "function") dirtyCbs.push(cb);
    return function unsubscribe() {
      var i = dirtyCbs.indexOf(cb);
      if (i >= 0) dirtyCbs.splice(i, 1);
    };
  }

  function stats() {
    ensureBackend();
    if (!useWorker && core) return core.stats();
    return mirrorStats;
  }

  // Test/debug hook (WA-6 acceptance: "eviction fires on a synthetic over-budget load").
  function _setBudgetForTest(bytes) {
    ensureBackend();
    if (!useWorker && core) { core.setBudgetBytes(bytes); return; }
    if (useWorker) worker.postMessage({ type: "setBudget", bytes: bytes });
  }

  function _resetForTest() {
    ensureBackend();
    reqBlocks.clear();
    reqBlocksWanted.clear();
    if (reqBlocksTimer !== null) clearTimeout(reqBlocksTimer);
    reqBlocksTimer = null;
    lastReqBlocksAt = -Infinity;
    reqBlocksEnabled = true;
    knownKeysByZ.clear();
    worldMapDims = null;
    if (!useWorker && core) { core.reset(); return; }
    mirror = new Map();
    mirrorStats = { chunks: 0, zLevels: 0, bytes: 0, evictions: 0 };
    if (useWorker) worker.postMessage({ type: "reset" });
  }

  function reqBlockId(bx, by, bz) { return bx + "," + by + "," + bz; }

  function requestBackoffMs(attempts) {
    return Math.min(REQ_BLOCKS_BACKOFF_MAX_MS,
      REQ_BLOCKS_BACKOFF_MIN_MS * Math.pow(2, Math.max(0, attempts - 1)));
  }

  function scheduleReqBlocksPump(delay) {
    if (reqBlocksTimer !== null || !reqBlocksWanted.size) return;
    reqBlocksTimer = setTimeout(function () {
      reqBlocksTimer = null;
      pumpRequestedBlocks();
    }, Math.max(0, delay | 0));
  }

  // All cache-hole and explicit designation refills share this queue, so ranges larger than the
  // wire's 64-block cap drain over several >=250ms messages. reqBlocks retains the original
  // in-flight/backoff state; a still-visible hole re-enters this pending set from windowView().
  function pumpRequestedBlocks() {
    if (!reqBlocksEnabled || !reqBlocksWanted.size) return;
    var now = Date.now();
    var rateWait = REQ_BLOCKS_MIN_MS - (now - lastReqBlocksAt);
    if (rateWait > 0) { scheduleReqBlocksPump(rateWait); return; }

    var blocks = [];
    for (var id of reqBlocksWanted) {
      var state = reqBlocks.get(id);
      if (state) {
        if (state.inFlight) {
          if (now < state.dueAt) { reqBlocksWanted.delete(id); continue; }
          state.inFlight = false;
          state.dueAt = now + requestBackoffMs(state.attempts);
          reqBlocksWanted.delete(id);
          continue;
        }
        if (now < state.dueAt) { reqBlocksWanted.delete(id); continue; }
      }
      var parts = id.split(",");
      blocks.push([Number(parts[0]), Number(parts[1]), Number(parts[2])]);
      if (blocks.length >= REQ_BLOCKS_MAX_PER_MESSAGE) break;
    }
    if (!blocks.length) return;

    var sent = false;
    try {
      sent = !!(window.DwfWS && typeof window.DwfWS.send === "function" &&
        window.DwfWS.send({ type: "reqblocks", blocks: blocks }));
    } catch (_) { sent = false; }
    if (!sent) return; // the next window/explicit request or socket lifecycle will retry

    lastReqBlocksAt = now;
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi], bid = reqBlockId(b[0], b[1], b[2]);
      var prior = reqBlocks.get(bid);
      reqBlocksWanted.delete(bid);
      reqBlocks.set(bid, {
        inFlight: true,
        dueAt: now + REQ_BLOCKS_RESPONSE_MS,
        attempts: (prior ? prior.attempts : 0) + 1,
      });
    }
    // Unsent ids are immediately eligible after the protocol rate limit.
    if (reqBlocksWanted.size) scheduleReqBlocksPump(REQ_BLOCKS_MIN_MS);
  }

  // `missing` holds world block triples whose absence made a decoded camera tile void.
  function requestMissingBlocks(missing) {
    if (!reqBlocksEnabled || !missing.size) return;
    for (var id of missing) reqBlocksWanted.add(id);
    pumpRequestedBlocks();
  }

  // B133: explicitly refill only the map blocks covered by a successful world-tile rectangle.
  // This does not widen the camera interest window or load the map wholesale; it merely feeds
  // the same bounded REQ_BLOCKS queue used by visible cache holes.
  function requestBlockRect(x1, y1, x2, y2, z) {
    var values = [x1, y1, x2, y2, z].map(Number);
    if (!values.every(Number.isFinite)) return 0;
    var bx0 = Math.min(values[0], values[2]) >> 4;
    var by0 = Math.min(values[1], values[3]) >> 4;
    var bx1 = Math.max(values[0], values[2]) >> 4;
    var by1 = Math.max(values[1], values[3]) >> 4;
    var bz = values[4] | 0;
    var count = 0;
    for (var bx = bx0; bx <= bx1; bx++) {
      for (var by = by0; by <= by1; by++) {
        reqBlocksWanted.add(reqBlockId(bx, by, bz));
        count++;
      }
    }
    pumpRequestedBlocks();
    return count;
  }

  // =========================================================================================
  // WA-7 -- bridge adapter: windowView() + client-side see-down composite + wallnbr synthesis.
  // This is the migration keystone: from here the canvas2d renderer is cache-fed, so protocol
  // v1 (WA-8+) can swap the wire underneath without touching dwf-tiles.js's draw path.
  // =========================================================================================

  // Local, self-consistent dig-designation ordinal table -- MUST match the one in
  // dwf-cache-worker.js bit-for-bit (both are intentionally-local decode tables that
  // never leave this cache, so they only need to agree with EACH OTHER, not with any real
  // DFHack enum; duplicated rather than shared because the worker and main-thread files run
  // in genuinely separate global scopes when a real dedicated Worker is in use).
  var DIG_NAMES = ["No", "Default", "UpDownStair", "Channel", "Ramp", "DownStair", "UpStair"];

  // Decode a packed designation halfword (desig1 in the low byte, desig2 in the high byte, the
  // SoA layout writeTileRecord/writeBlockTile pack into) to the legacy `{dig,smooth,traffic,
  // track,marker,automine}` object the renderers consume -- or null when no designation is active. Shared
  // by the normal decodeTile path and the BLACK-GLYPHS/B204 void-with-designation path below so
  // both derive `active` and the string dig name IDENTICALLY.
  function decodeDesigObj(dv) {
    var desig1 = dv & 0xFF, desig2 = (dv >> 8) & 0xFF;
    var digName = DIG_NAMES[desig1 & 0xF] || "No";
    var smooth = (desig1 >> 4) & 3, marker = (desig1 >> 6) & 1;
    var automine = (desig1 >> 7) & 1;
    var traffic = desig2 & 3, track = (desig2 >> 2) & 0xF;
    if (digName === "No" && smooth === 0 && traffic === 0 && track === 0) return null;
    return { dig: digName, smooth: smooth, traffic: traffic, track: track, marker: marker,
      automine: automine };
  }

  var tiletypeMeta = new Map(); // tt(number) -> {ttname,shape,mat,special}

  // WA-7 item 1 (§0.7 session meta table): tt -> {ttname,shape,mat,special} lookup, fed once
  // at boot from GET /tiletype_meta.json's `tiletypes` array ([tt,"TTNAME","SHAPE","MAT",
  // "SPECIAL"], ...]) by the render client. Everything windowView() reconstitutes for a tile
  // resolves through this table -- the cache itself only ever stores the numeric `tt`.
  function setTiletypeMeta(list) {
    var m = new Map();
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (!Array.isArray(r) || r.length < 5) continue;
        m.set(r[0], { ttname: r[1], shape: r[2], mat: r[3], special: r[4] });
      }
    }
    tiletypeMeta = m;
  }

  function metaFor(tt) {
    return tiletypeMeta.get(tt) || null;
  }

  // WA-12: forward the WA-5 /item_type_meta.json table to the ingest backend -- unlike
  // tiletypeMeta (resolved at READ time by windowView, main-thread-resident only), item-type
  // resolution happens at INGEST time (v1's ITEM tail carries a numeric enum value, §0.3.2) so
  // both the v1-raw and legacy-JSON sparse.item shapes end up identically string-keyed by the
  // time anything reads them -- the backend (worker or in-process core) needs its own copy.
  function setItemTypeMeta(list) {
    ensureBackend();
    if (useWorker) { try { worker.postMessage({ type: "setItemTypeMeta", list: list }); } catch (_) {} return; }
    if (core && typeof core.setItemTypeMeta === "function") core.setItemTypeMeta(list);
  }

  // WA-12/13: feed the current camera z to the ingest backend's eviction heuristic (item 4) --
  // v1 BLOCK_SETs can span many z-levels per payload, so (unlike legacy ingest, which infers
  // camHintZ from the single-z map message) there's no per-ingest signal to derive it from;
  // the AUX handler (WA-13's authoritative cam) calls this directly instead.
  function setCamHintZ(z) {
    ensureBackend();
    if (useWorker) { try { worker.postMessage({ type: "setCamHintZ", z: z }); } catch (_) {} return; }
    if (core && typeof core.setCamHintZ === "function") core.setCamHintZ(z);
  }

  function isOpenShapeMat(shape, mat) {
    return shape === "EMPTY" || shape === "RAMP_TOP" || mat === "AIR";
  }

  // B269: the two per-tile STATE bits in flags2 (every other flags2 bit is a tail-presence
  // marker). Must byte-match src/wire_v1.h's kFlag2Damp / kFlag2Warm.
  var FLAG2_DAMP = 0x0800;
  var FLAG2_WARM = 0x1000;

  // Decode the raw numeric fields of one SoA slot (no strings, no sparse, no wallnbr) --
  // shared by the primary read and the descent scan below.
  function decodeRaw(chunk, idx) {
    var tt = chunk.tt[idx];
    var m = chunk.mat[idx] | 0;
    var mt = m >> 16, mi = (m << 16) >> 16;
    var b = chunk.bits[idx];
    return {
      tt: tt, mt: mt, mi: mi,
      liquidCode: b & 3, flow: (b >> 2) & 7, hidden: (b >> 5) & 1, outside: (b >> 6) & 1,
    };
  }

  // wallnbr synthesis (tile_map_dump.cpp:281-288 semantics, WA-7 item 1/2): 4-bit N=1 S=2 E=4
  // W=8 mask of same-z neighbor tiles whose shape resolves to "WALL". Reads directly from the
  // cache rather than live DF state; an unknown/void neighbor (off-map, undiscovered chunk,
  // or a genuinely void record) reads as "not a wall", matching the server's out-of-bounds /
  // null-block behavior.
  function neighborIsWall(x, y, z) {
    var chunk = getChunk(z, chunkKeyFor(x, y));
    if (!chunk) return false;
    var idx = (y & 15) * 16 + (x & 15);
    var tt = chunk.tt[idx];
    if (tt === 0xFFFF) return false;
    var meta = metaFor(tt);
    return !!meta && meta.shape === "WALL";
  }
  function computeWallNbr(x, y, z) {
    var m = 0;
    if (neighborIsWall(x, y - 1, z)) m |= 1; // N
    if (neighborIsWall(x, y + 1, z)) m |= 2; // S
    if (neighborIsWall(x + 1, y, z)) m |= 4; // E
    if (neighborIsWall(x - 1, y, z)) m |= 8; // W
    return m;
  }

  // Reconstitute ONE legacy-shaped tile object at world (wx,wy,z). Unknown chunk / void
  // record -> `{x,y,tt:-1}` (matches the legacy wire's own void shape on the include_xy=true
  // push path, ground truth §1.3 lines 213-219).
  function decodeTile(z, wx, wy) {
    var chunk = getChunk(z, chunkKeyFor(wx, wy));
    var idx = (wy & 15) * 16 + (wx & 15);
    if (!chunk) return { x: wx, y: wy, tt: -1 };
    if (chunk.tt[idx] === 0xFFFF) {
      // BLACK-GLYPHS/B204 (RENDER half of B133): a FULLY-hidden/undiscovered block that carries
      // a live designation ships its designation bytes with a VOID tiletype -- the server emits
      // tt=void (no real tiletype/base material) so fog-of-war leaks nothing past what the player
      // already designated. The tile has no terrain to draw, but the designation must still surface
      // so both renderers draw the glyph OVER BLACK (native DF's "pick over undiscovered rock"),
      // with NO terrain invented under it. An undesignated void tile (desig==0) stays the bare void
      // record and renders pure black, exactly as before. `hidden:1` gives the grey glyph the same
      // additive-lighten backdrop drawDesignation/buildTile already apply to hidden designated tiles.
      var vdes = decodeDesigObj(chunk.desig[idx]);
      if (!vdes) return { x: wx, y: wy, tt: -1 };
      return { x: wx, y: wy, tt: -1, hidden: 1, desig: vdes };
    }

    var useChunk = chunk, useIdx = idx, useZ = z;
    var raw = decodeRaw(chunk, idx);
    var meta = metaFor(raw.tt);
    var shape = meta ? meta.shape : "";
    var mat = meta ? meta.mat : "";

    // WA-7 item 2: client-side see-down composite, verbatim port of tile_map_dump.cpp:244-277
    // -- ONLY for chunks ingested raw (baked===false, i.e. after WA-12's v1 ingest lands).
    // Baked chunks (always true this wave -- the legacy server already baked the descent
    // before it ever reached the wire) pass through UNCHANGED to avoid double-descent.
    if (!chunk.baked && !raw.hidden && isOpenShapeMat(shape, mat)) {
      for (var dz = 1; dz <= 10; dz++) {
        var lz = z - dz;
        if (lz < 0) break;
        var lchunk = getChunk(lz, chunkKeyFor(wx, wy));
        if (!lchunk) continue; // missing lower chunk -> `continue`, matches the server's null-block continue
        var lidx = (wy & 15) * 16 + (wx & 15);
        if (lchunk.tt[lidx] === 0xFFFF) continue; // null-block equivalent
        var lraw = decodeRaw(lchunk, lidx);
        var lmeta = metaFor(lraw.tt);
        var lshape = lmeta ? lmeta.shape : "", lmat = lmeta ? lmeta.mat : "";
        if (isOpenShapeMat(lshape, lmat) && lraw.flow === 0) continue; // still open air: go deeper
        useChunk = lchunk; useIdx = lidx; useZ = lz;
        raw = lraw; meta = lmeta; shape = lshape; mat = lmat;
        break;
      }
    }

    var liquid = raw.flow > 0 ? (raw.liquidCode === 2 ? "magma" : "water") : "none";
    var desigObj = decodeDesigObj(useChunk.desig[useIdx]);

    var out = {
      x: wx, y: wy, tt: raw.tt,
      ttname: meta ? meta.ttname : "",
      shape: shape, mat: mat, special: meta ? meta.special : "",
      flow: raw.flow, liquid: liquid, hidden: raw.hidden, outside: raw.outside,
      base_mt: raw.mt, base_mi: raw.mi,
    };
    // B269 (additive): DF's two mining-cancellation states, evaluated server-side (the client
    // cannot -- damp needs the tile at z+1 and the aquifer bit, warm needs tile temperature; see
    // src/wire_v1.cpp's B269 banner). Set only on revealed WALL tiles, so `out.damp` on anything
    // else is impossible by construction. Both renderers turn these into DF's own
    // DAMP_STONE_WARNING / WARM_STONE_WARNING glyphs while the mining tool is up.
    var f2 = useChunk.flags2 ? (useChunk.flags2[useIdx] | 0) : 0;
    if (f2 & FLAG2_DAMP) out.damp = true;
    if (f2 & FLAG2_WARM) out.warm = true;
    // B139 (additive): how many z the see-down composite above descended (0 = camera
    // plane) -- same semantics as the legacy /mapdata JSON's own `depth` field, which the
    // renderers already consume (terrain fog at tiles.js drawTileComposite; flow-cloud
    // depth dim in both renderers' B139 passes).
    if (useZ !== z) out.depth = z - useZ;
    if (desigObj) out.desig = desigObj;
    var sp = useChunk.sparse.get(useIdx);
    if (sp) {
      if (sp.item) out.item = sp.item;
      if (sp.plant) out.plant = sp.plant;
      if (sp.farmCrop) out.farmCrop = sp.farmCrop;
      if (sp.spatterMat) out.spatter = sp.spatterMat;   // back-compat single-event field
      // WC-12 (additive): a uniform ALL-EVENTS array for the layered-decal apply, regardless
      // of which ingest path produced it -- v1 already accumulates one entry per SPATTER
      // tail (up to 4, amount-desc); legacy JSON is first-event-only, so its single
      // `spatterMat` gets wrapped. Same normalization for item-spatter litter and flow.
      if (sp.spatters && sp.spatters.length) out.spatters = sp.spatters;
      else if (sp.spatterMat) out.spatters = [sp.spatterMat];
      if (sp.itemSpatters && sp.itemSpatters.length) out.itemSpatters = sp.itemSpatters;
      if (sp.flow) out.cloud = sp.flow;
      // WC-17/WC-18 (additive): grass coverage (single-valued -- max-amount-wins is
      // already resolved server-side) and the engraving-hit array (multi-valued -- one
      // entry per engraved face/floor at this tile; combined client-side, see
      // dwf-tiles.js's engraving overlay).
      if (sp.grass) out.grass = sp.grass;
      if (sp.engravings && sp.engravings.length) out.engravings = sp.engravings;
      // WC-19 (additive): designation dig-priority (single-valued) -- the glyph overlay
      // renders it, mode-gated, in dwf-tiles.js/-gl.js. WC-21: vermin (multi-valued,
      // one entry per bug/colony on the tile) -- sparse sprite instances.
      if (sp.desigPriority) out.desigPriority = sp.desigPriority;
      if (sp.vermin && sp.vermin.length) out.vermin = sp.vermin;
      // TX1 (additive): the container's representative-content descriptor -- both renderers
      // composite the native contents-peek overlay over the BARREL/BIN item sprite from it.
      if (sp.peek) out.peek = sp.peek;
    }
    if (shape === "WALL") out.wallnbr = computeWallNbr(wx, wy, useZ);
    return out;
  }

  // The bridge adapter itself (WA-7 item 1): returns an object shaped EXACTLY like today's
  // keyframe `map` ({origin,width,height,z,tiles:[...]} row-major, y-outer x-inner -- same
  // convention dwf-tiles.js's tileBuf already uses), so applyKeyframe/applyDelta can
  // reduce to thin calls into this cache without dwf-tiles.js's draw() changing at all.
  // F3 (perf audit §2/F3): the max block version over the blocks intersecting this window across
  // the see-down z-range decodeTile() can read (z down to z-10). This is the cache's real CONTENT
  // VERSION for the window -- it advances iff a window-intersecting terrain block was re-ingested
  // (a dig/designation/build/liquid/see-down change; block.ver = the v1 world_seq, or the legacy
  // monotonic ++globalVer), and is INVARIANT to unit/AUX churn (units/buildings are never ingested
  // into this tiles-only cache). windowView() stamps it onto the returned view; dwf-tiles.js
  // forwards it as `latest.contentVersion` and the GL controller keys its scene rebuild on it
  // instead of `latest` object identity -- so a busy fort no longer rebuilds the whole visible
  // scene ~30x/s just because a unit moved (F3), while a REAL terrain change still bumps it and
  // rebuilds (keeps B29 -- the opposite "never rebuilds" bug -- covered).
  function windowMaxVer(ox, oy, z, w, h) {
    var maxv = 0;
    var bx0 = ox >> 4, bx1 = (ox + w - 1) >> 4;
    var by0 = oy >> 4, by1 = (oy + h - 1) >> 4;
    var zlo = z - 10; if (zlo < 0) zlo = 0;
    for (var zz = zlo; zz <= z; zz++) {
      for (var bx = bx0; bx <= bx1; bx++) {
        for (var by = by0; by <= by1; by++) {
          var c = getChunk(zz, bx * 4096 + by);
          if (c && c.ver > maxv) maxv = c.ver;
        }
      }
    }
    return maxv;
  }

  function windowView(ox, oy, z, w, h) {
    var tiles = new Array(w * h);
    var missing = new Set();
    var zlo = z - 10; if (zlo < 0) zlo = 0;
    for (var gy = 0; gy < h; gy++) {
      for (var gx = 0; gx < w; gx++) {
        var wx = ox + gx, wy = oy + gy;
        var tile = decodeTile(z, wx, wy);
        tiles[gy * w + gx] = tile;
        // Known void records are not holes. For a decoded void, request only absent chunks in
        // the same 10-level see-down range decodeTile() examined.
        //
        // WT25 Phase 2 (the "power trap" fix): request a missing block ONLY if it was previously
        // received, i.e. its key is in knownKeysByZ for that z. knownKeysByZ accumulates every
        // ingested block and is NEVER pruned on eviction, so membership means "discovered-but-
        // evicted" (positive evidence) -> a legitimate B133/P1 gap-fill refill when it scrolls
        // back into view. A block that was never known is undiscovered rock the server will never
        // ship (non-shippable); the renderers now paint it as the base-hatch, so requesting it
        // would be perpetual dead REQ_BLOCKS churn against blocks that never answer. This also
        // suppresses genuinely off-map void (never known either) -- an additional, correct win.
        if (tile.tt < 0) {
          var key = chunkKeyFor(wx, wy);
          for (var zz = z; zz >= zlo; zz--) {
            if (getChunk(zz, key)) continue;
            var knownZ = knownKeysByZ.get(zz);
            if (knownZ && knownZ.has(key)) missing.add(reqBlockId(wx >> 4, wy >> 4, zz));
          }
        }
      }
    }
    requestMissingBlocks(missing);
    return { origin: { x: ox, y: oy, z: z }, width: w, height: h, z: z, tiles: tiles,
             version: windowMaxVer(ox, oy, z, w, h) };
  }

  // WT25: world footprint accessors. setMapDims is fed from hello_ack; mapDims() is read by the
  // GL renderer's in-bounds base-hatch decision (cacheReader.mapDims()). Returns null pre-hello.
  function setMapDims(w, h, zc) {
    if (typeof w === "number" && typeof h === "number") {
      worldMapDims = { w: w, h: h, z: (typeof zc === "number") ? zc : 0 };
    }
  }
  function mapDims() { return worldMapDims; }

  var api = {
    ingest: ingest,
    ingestBlocks: ingestBlocks,
    getChunk: getChunk,
    chunkKeyFor: chunkKeyFor,
    setMapDims: setMapDims,
    mapDims: mapDims,
    onDirty: onDirty,
    stats: stats,
    setTiletypeMeta: setTiletypeMeta,
    setItemTypeMeta: setItemTypeMeta,
    setCamHintZ: setCamHintZ,
    windowView: windowView,
    requestBlockRect: requestBlockRect,
    _setBudgetForTest: _setBudgetForTest,
    _resetForTest: _resetForTest,
    _setReqBlocksEnabledForTest: function (enabled) { reqBlocksEnabled = enabled !== false; },
    _backend: function () { ensureBackend(); return useWorker ? "worker" : (core ? "sync" : "none"); },
  };
  try { window.DwfCache = api; } catch (_) { /* non-browser context */ }
})();
