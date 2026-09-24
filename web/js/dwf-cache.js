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

/* global DwfCacheWorkerCore */

// dwf-cache.js -- the main-thread persistent chunked world cache and its read-side window view.

(function () {
  "use strict";

  // ---- worker/fallback backend -----------------------------------------------------------
  var worker = null;
  var core = null;          // synchronous fallback core (DwfCacheWorkerCore)
  var useWorker = false;
  var workerReady = false;
  var workerQueue = [];
  var workerReadyTimer = null;
  var workerErrors = 0;
  var backendDemotions = 0;
  var latestItemTypeMeta = null;
  var hasItemTypeMeta = false;
  var latestCamHintZ = 0;
  var hasCamHintZ = false;
  var nextJobId = 1;
  var dirtyCbs = [];

  // P1: window assembly is the one place that knows a cache hole is actually visible. Keep
  // request state here: this side owns windowView(), and a BLOCK_SET answer arrives via dirty.
  var reqBlocks = new Map(); // "bx,by,bz" -> { inFlight, dueAt, attempts }
  var reqBlocksWanted = new Set(); // pending visible/explicit block ids not yet put on the wire
  var reqBlocksVisibleAt = new Map(); // "bx,by,bz" -> last Date.now() observed missing
  var reqBlocksTimer = null;
  var reqBlocksTimerAt = Infinity;
  var lastReqBlocksAt = -Infinity;
  var reqBlocksEnabled = true;
  var REQ_BLOCKS_MIN_MS = 300;
  var REQ_BLOCKS_RESPONSE_MS = 1000;
  var REQ_BLOCKS_BACKOFF_MIN_MS = 500;
  var REQ_BLOCKS_BACKOFF_MAX_MS = 8000;
  // The staleness horizon for visible demand, not a retry budget: windowView runs every rendered frame.
  var REQ_BLOCKS_VISIBLE_LEASE_MS = 1500;
  var REQ_BLOCKS_MAX_PER_MESSAGE = 64;
  // The attempt cap and windowView's coldAsked terminator are ONE mechanism. Without the cap,
  // reqBlocks.has(id) stays true forever for unshippable rock and every visible hole re-asks at the cap.
  var REQ_BLOCKS_MAX_ATTEMPTS = 3;

  // The main-thread READ-SIDE mirror, WORKER MODE ONLY: a synchronous, drawable snapshot fed by
  // `dirty` messages. Fallback mode nulls it and getChunk reads the core's own store instead.
  var mirror = new Map(); // z -> Map<key, Chunk-shaped plain object>
  var mirrorStats = { chunks: 0, zLevels: 0, bytes: 0, evictions: 0 };
  // A main-thread ingest generation, independent of the server's world_seq: a cold snapshot can replace
  // a placeholder at the SAME world_seq, and nothing else would mark that visually meaningful change.
  var chunkRevisionByZ = new Map(); // z -> Map<packed key, local generation>
  var nextChunkRevision = 1;
  // Keys announced by dirty notifications. A key never announced is undiscovered, not a hole to refetch;
  // getChunk() remains the authority for content.
  var knownKeysByZ = new Map(); // z -> Set<packed bx*4096+by>
  // The world footprint from hello_ack; null pre-hello, which disables the cold ask until the world's
  // shape is known. Read by the GL renderer to tell in-bounds undiscovered rock from off-map void.
  var worldMapDims = null; // {w,h,z} or null until hello_ack
  // Addresses asked for cold ONCE. Membership is recorded when the address reaches the WIRE, not when
  // windowView queues one: the pump legitimately drops ids, and a queue-time record would mark those asked.
  var coldAsked = new Set();
  function coldKey(z, packedChunkKey) { return z + "|" + packedChunkKey; }

  // True when this world tile is inside the footprint hello_ack announced. Pre-hello -> false.
  function coldAskInBounds(wx, wy) {
    if (!worldMapDims) return false;
    return wx >= 0 && wy >= 0 && wx < worldMapDims.w && wy < worldMapDims.h;
  }

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
    } catch { /* the fixed worker path below remains valid */ }
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
    if (msg.type === "ready") {
      if (!useWorker || !worker) return;
      workerReady = true;
      if (workerReadyTimer !== null) clearTimeout(workerReadyTimer);
      workerReadyTimer = null;
      var queued = workerQueue; workerQueue = [];
      for (var qi = 0; qi < queued.length; qi++) {
        try {
          var q = queued[qi];
          if (q.transfer) worker.postMessage(q.message, q.transfer);
          else worker.postMessage(q.message);
        } catch (err) {
          demoteWorker("queued worker post failed: " + String(err && err.message || err));
          return;
        }
      }
      return;
    }
    if (msg.type === "error") {
      demoteWorker((msg.phase ? msg.phase + ": " : "") + String(msg.message || "cache worker error"));
      return;
    }
    if (msg.type === "dirty") {
      var chunks = msg.chunks || [];
      for (var i = 0; i < chunks.length; i++) installMirrorChunk(msg.z, chunks[i]);
      if (msg.stats) mirrorStats = msg.stats;
      fireDirty(msg.z, msg.keys || [], mirrorStats);
    }
  }

  function demoteWorker(reason) {
    if (!useWorker) return;
    workerErrors++;
    backendDemotions++;
    var dims = worldMapDims;
    if (workerReadyTimer !== null) clearTimeout(workerReadyTimer);
    workerReadyTimer = null;
    workerReady = false;
    workerQueue = [];
    try { if (worker) worker.terminate(); } catch { /* already dead; demotion continues below */ }
    worker = null;
    useWorker = false;
    core = (typeof DwfCacheWorkerCore === "object" && DwfCacheWorkerCore) ?
      DwfCacheWorkerCore : null;
    mirror = null;
    if (core && typeof core.reset === "function") core.reset();
    // Replay the latest control values into the fallback core after reset -- they may still be waiting
    // behind the worker's ready handshake when startup fails.
    if (core && hasItemTypeMeta && typeof core.setItemTypeMeta === "function")
      core.setItemTypeMeta(latestItemTypeMeta);
    if (core && hasCamHintZ && typeof core.setCamHintZ === "function")
      core.setCamHintZ(latestCamHintZ);
    reqBlocks.clear();
    reqBlocksWanted.clear();
    reqBlocksVisibleAt.clear();
    if (reqBlocksTimer !== null) clearTimeout(reqBlocksTimer);
    reqBlocksTimer = null;
    reqBlocksTimerAt = Infinity;
    lastReqBlocksAt = -Infinity;
    coldAsked.clear();
    knownKeysByZ.clear();
    worldMapDims = dims;
    try {
      if (window.DwfBoot && typeof window.DwfBoot.note === "function")
        window.DwfBoot.note("cache-worker-demoted", String(reason || "worker failure"));
    } catch (err) { DwfErr.report("cache.demote-note", err); }
    // Every frame transferred to the failed worker was already ACKed, so reconnect with have=0 for an
    // authoritative snapshot; merely retrying the broken worker would churn forever.
    try {
      if (window.DwfWS && typeof window.DwfWS.recoverFreshSnapshot === "function")
        window.DwfWS.recoverFreshSnapshot();
    } catch (err) { DwfErr.report("cache.demote-resync", err); }
  }

  function postWorker(message, transfer) {
    if (!useWorker || !worker) return false;
    if (!workerReady) {
      workerQueue.push({ message: message, transfer: transfer || null });
      return true;
    }
    try {
      if (transfer) worker.postMessage(message, transfer);
      else worker.postMessage(message);
      return true;
    } catch (err) {
      demoteWorker("worker post failed: " + String(err && err.message || err));
      return false;
    }
  }

  function ensureBackend() {
    if (worker || core) return;
    if (typeof Worker === "function") {
      try {
        var w = new Worker(resolveWorkerUrl());
        w.onmessage = handleWorkerMessage;
        w.onerror = function (ev) {
          demoteWorker("worker runtime error: " + String(ev && ev.message || "unknown error"));
        };
        worker = w;
        useWorker = true;
        workerReady = false;
        workerQueue = [];
        workerReadyTimer = setTimeout(function () {
          demoteWorker("worker readiness timeout");
        }, 5000);
        return;
      } catch { /* the synchronous core below owns the same cache state */ }
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
      var revisions = chunkRevisionByZ.get(z);
      if (!revisions) { revisions = new Map(); chunkRevisionByZ.set(z, revisions); }
      for (var kk = 0; kk < keys.length; kk++) {
        var dirtyKey = Number(keys[kk]);
        known.add(dirtyKey);
        revisions.set(dirtyKey, nextChunkRevision++);
      }
    }
    // A newly applied block answers any outstanding request for the same world address.
    for (var rk = 0; rk < keys.length; rk++) {
      // Worker dirty keys are the packed bx*4096+by form and REQ_BLOCKS ids are "bx,by,bz": convert, never
      // concatenate, or nothing ever matches an in-flight request.
      var packed = Number(keys[rk]);
      var bx = Math.floor(packed / 4096);
      var by = packed - bx * 4096;
      var answered = reqBlockId(bx, by, z);
      reqBlocks.delete(answered);
      reqBlocksWanted.delete(answered);
      reqBlocksVisibleAt.delete(answered);
    }
    if (reqBlocksWanted.size) scheduleReqBlocksPump(0);
    for (var i = 0; i < dirtyCbs.length; i++) {
      try { dirtyCbs[i](z, keys, statsObj); } catch (err) { DwfErr.report("cache.dirty-subscriber", err); }
    }
  }

  // ---- public API: ingest ----------------------------------------------------------------
  function ingest(mapMsg) {
    ensureBackend();
    if (useWorker) {
      if (postWorker({ type: "ingest", jobId: nextJobId++, map: mapMsg })) return;
    }
    if (core) {
      try {
        var dirty = core.ingestLegacy(mapMsg);
        if (dirty) fireDirty(dirty.z, dirty.keys, dirty.stats);
      } catch (err) { DwfErr.report("cache.ingest-legacy", err); }
    }
    // Neither backend available (e.g. a non-browser context with no DwfCacheWorkerCore
    // loaded either): ingest is a documented, silent no-op.
  }

  function ingestBlocks(arrayBuffer) {
    ensureBackend();
    if (useWorker) {
      if (postWorker({ type: "ingestBlocks", jobId: nextJobId++, buffer: arrayBuffer }, [arrayBuffer]))
        return;
      // A synchronous fallback was installed by postWorker's failure path. The original buffer
      // was not transferred when postMessage threw, so it is safe to ingest immediately.
      if (core) {
        var recovered = core.ingestBlocks(arrayBuffer);
        if (recovered && recovered.byZ) {
          for (var ri = 0; ri < recovered.byZ.length; ri++)
            fireDirty(recovered.byZ[ri].z, recovered.byZ[ri].keys, recovered.stats);
        }
        return recovered;
      }
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

  function chunkRevision(z, key) {
    var revisions = chunkRevisionByZ.get(z);
    return (revisions && revisions.get(Number(key))) || 0;
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
    var s = (!useWorker && core) ? core.stats() : mirrorStats;
    return Object.assign({}, s || {}, {
      workerReady: useWorker ? workerReady : false,
      workerErrors: workerErrors,
      backendDemotions: backendDemotions,
      backend: useWorker ? (workerReady ? "worker" : "worker-starting") : (core ? "sync" : "none"),
    });
  }

  // Test/debug hook (acceptance: "eviction fires on a synthetic over-budget load").
  function _setBudgetForTest(bytes) {
    ensureBackend();
    if (!useWorker && core) { core.setBudgetBytes(bytes); return; }
    if (useWorker) postWorker({ type: "setBudget", bytes: bytes });
  }

  // Forget everything about the previous world. knownKeysByZ is never pruned on eviction, but that only
  // holds WITHIN one world: carrying it across a save load authorizes REQ_BLOCKS for addresses now gone.
  function reset() {
    ensureBackend();
    reqBlocks.clear();
    reqBlocksWanted.clear();
    reqBlocksVisibleAt.clear();
    if (reqBlocksTimer !== null) clearTimeout(reqBlocksTimer);
    reqBlocksTimer = null;
    reqBlocksTimerAt = Infinity;
    lastReqBlocksAt = -Infinity;
    reqBlocksEnabled = true;
    knownKeysByZ.clear();
    chunkRevisionByZ.clear();
    nextChunkRevision = 1;
    coldAsked.clear();
    worldMapDims = null;
    latestCamHintZ = 0;
    hasCamHintZ = true;
    if (!useWorker && core) { core.reset(); return; }
    mirror = new Map();
    mirrorStats = { chunks: 0, zLevels: 0, bytes: 0, evictions: 0 };
    if (useWorker) postWorker({ type: "reset" });
  }

  function reqBlockId(bx, by, bz) { return bx + "," + by + "," + bz; }

  function requestBackoffMs(attempts) {
    return Math.min(REQ_BLOCKS_BACKOFF_MAX_MS,
      REQ_BLOCKS_BACKOFF_MIN_MS * Math.pow(2, Math.max(0, attempts - 1)));
  }

  function scheduleReqBlocksPump(delay) {
    var wait = Math.max(0, delay | 0);
    var dueAt = Date.now() + wait;
    // A response-timeout wakeup must not delay a newly queued pan burst. Keep whichever wakeup is
    // earlier; otherwise the retry timer would accidentally turn the 300 ms drain into 1+ seconds.
    if (reqBlocksTimer !== null) {
      if (dueAt >= reqBlocksTimerAt) return;
      clearTimeout(reqBlocksTimer);
    }
    reqBlocksTimerAt = dueAt;
    reqBlocksTimer = setTimeout(function () {
      reqBlocksTimer = null;
      reqBlocksTimerAt = Infinity;
      pumpRequestedBlocks();
    }, wait);
  }

  function requestStillVisible(id, now) {
    var seenAt = reqBlocksVisibleAt.get(id);
    return typeof seenAt === "number" && now - seenAt <= REQ_BLOCKS_VISIBLE_LEASE_MS;
  }

  function scheduleNextVisibleRetry(now) {
    var wait = Infinity;
    reqBlocks.forEach(function (state, id) {
      if (!requestStillVisible(id, now)) return;
      wait = Math.min(wait, Math.max(0, state.dueAt - now));
    });
    if (wait < Infinity) scheduleReqBlocksPump(wait);
  }

  // One queue for every refill, so a range larger than the wire's 64-block cap drains over several messages.
  function pumpRequestedBlocks() {
    if (!reqBlocksEnabled) return;
    var now = Date.now();
    // A timeout must wake itself even when the original send drained reqBlocksWanted. Re-offer
    // only blocks whose holes windowView has observed recently; panning away lets the lease expire.
    reqBlocks.forEach(function (state, id) {
      if (state.inFlight && now < state.dueAt) return;   // still inside the response window
      // Retiring the state is what re-arms windowView's coldAsked terminator for rock that will never answer.
      if (!requestStillVisible(id, now) || state.attempts >= REQ_BLOCKS_MAX_ATTEMPTS) {
        reqBlocks.delete(id);
        reqBlocksVisibleAt.delete(id);
        reqBlocksWanted.delete(id);
        return;
      }
      if (now >= state.dueAt) reqBlocksWanted.add(id);
    });
    // Only VISIBILITY-sourced ids age out: an explicit requestBlockRect refill carries no observation
    // timestamp and must survive until it is actually sent.
    reqBlocksWanted.forEach(function (id) {
      var seenAt = reqBlocksVisibleAt.get(id);
      if (typeof seenAt === "number" && now - seenAt > REQ_BLOCKS_VISIBLE_LEASE_MS)
        reqBlocksWanted.delete(id);
    });
    if (!reqBlocksWanted.size) { scheduleNextVisibleRetry(now); return; }
    var rateWait = REQ_BLOCKS_MIN_MS - (now - lastReqBlocksAt);
    if (rateWait > 0) { scheduleReqBlocksPump(rateWait); return; }

    var blocks = [];
    var retries = [];
    var pushId = function (id) {
      var parts = id.split(",");
      blocks.push([Number(parts[0]), Number(parts[1]), Number(parts[2])]);
    };
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
        // A re-ask yields to demand that has never been asked at all.
        if (retries.length < REQ_BLOCKS_MAX_PER_MESSAGE) retries.push(id);
        continue;
      }
      pushId(id);
      if (blocks.length >= REQ_BLOCKS_MAX_PER_MESSAGE) break;
    }
    for (var ri = 0; ri < retries.length && blocks.length < REQ_BLOCKS_MAX_PER_MESSAGE; ri++)
      pushId(retries[ri]);
    if (!blocks.length) { scheduleNextVisibleRetry(now); return; }

    var sent;
    try {
      sent = !!(window.DwfWS && typeof window.DwfWS.send === "function" &&
        window.DwfWS.send({ type: "reqblocks", blocks: blocks }));
    } catch { sent = false; }
    if (!sent) return; // the next window/explicit request or socket lifecycle will retry

    lastReqBlocksAt = now;
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi], bid = reqBlockId(b[0], b[1], b[2]);
      var prior = reqBlocks.get(bid);
      reqBlocksWanted.delete(bid);
      // Reaching the wire is what retires the one-shot cold ask for this address.
      coldAsked.add(coldKey(b[2], b[0] * 4096 + b[1]));
      reqBlocks.set(bid, {
        inFlight: true,
        dueAt: now + REQ_BLOCKS_RESPONSE_MS,
        attempts: (prior ? prior.attempts : 0) + 1,
      });
    }
    // Unsent ids are immediately eligible after the protocol rate limit.
    if (reqBlocksWanted.size) scheduleReqBlocksPump(REQ_BLOCKS_MIN_MS);
    else scheduleNextVisibleRetry(now);
  }

  // `missing` holds world block triples whose absence made a decoded camera tile void.
  function requestMissingBlocks(missing) {
    if (!reqBlocksEnabled || !missing.size) return;
    var now = Date.now();
    for (var id of missing) {
      reqBlocksVisibleAt.set(id, now);
      reqBlocksWanted.add(id);
    }
    pumpRequestedBlocks();
  }

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

  // MUST match dwf-cache-worker.js bit for bit: both are local decode tables living in genuinely
  // separate global scopes, so they only have to agree with each other, not with any DFHack enum.
  var DIG_NAMES = ["No", "Default", "UpDownStair", "Channel", "Ramp", "DownStair", "UpStair"];

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

  function setItemTypeMeta(list) {
    latestItemTypeMeta = list;
    hasItemTypeMeta = true;
    ensureBackend();
    if (useWorker) { postWorker({ type: "setItemTypeMeta", list: list }); return; }
    if (core && typeof core.setItemTypeMeta === "function") core.setItemTypeMeta(list);
  }

  function setCamHintZ(z) {
    if (typeof z === "number") {
      latestCamHintZ = z;
      hasCamHintZ = true;
    }
    ensureBackend();
    if (useWorker) { postWorker({ type: "setCamHintZ", z: z }); return; }
    if (core && typeof core.setCamHintZ === "function") core.setCamHintZ(z);
  }

  function isOpenShapeMat(shape, mat) {
    return shape === "EMPTY" || shape === "RAMP_TOP" || mat === "AIR";
  }

  // the two per-tile STATE bits in flags2 (every other flags2 bit is a tail-presence
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

  // Unknown chunk or void record -> {x,y,tt:-1}, which is the legacy wire's own void shape.
  function decodeTile(z, wx, wy) {
    var chunk = getChunk(z, chunkKeyFor(wx, wy));
    var idx = (wy & 15) * 16 + (wx & 15);
    if (!chunk) return { x: wx, y: wy, tt: -1 };
    if (chunk.tt[idx] === 0xFFFF) {
      var vdes = decodeDesigObj(chunk.desig[idx]);
      if (!vdes) return { x: wx, y: wy, tt: -1 };
      return { x: wx, y: wy, tt: -1, hidden: 1, desig: vdes };
    }

    var useChunk = chunk, useIdx = idx, useZ = z;
    var raw = decodeRaw(chunk, idx);
    var meta = metaFor(raw.tt);
    var shape = meta ? meta.shape : "";
    var mat = meta ? meta.mat : "";

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
    var f2 = useChunk.flags2 ? (useChunk.flags2[useIdx] | 0) : 0;
    if (f2 & FLAG2_DAMP) out.damp = true;
    if (f2 & FLAG2_WARM) out.warm = true;
    if (useZ !== z) out.depth = z - useZ;
    if (desigObj) out.desig = desigObj;
    var sp = useChunk.sparse.get(useIdx);
    if (sp) {
      if (sp.item) out.item = sp.item;
      if (sp.plant) out.plant = sp.plant;
      if (sp.treeGraphics) out.treeGraphics = sp.treeGraphics;
      if (sp.farmCrop) out.farmCrop = sp.farmCrop;
      if (sp.spatterMat) out.spatter = sp.spatterMat;   // back-compat single-event field
      if (sp.spatters && sp.spatters.length) out.spatters = sp.spatters;
      else if (sp.spatterMat) out.spatters = [sp.spatterMat];
      if (sp.itemSpatters && sp.itemSpatters.length) out.itemSpatters = sp.itemSpatters;
      if (sp.flow) out.cloud = sp.flow;
      if (sp.grass) out.grass = sp.grass;
      if (sp.engravings && sp.engravings.length) out.engravings = sp.engravings;
      if (sp.desigPriority) out.desigPriority = sp.desigPriority;
      if (sp.vermin && sp.vermin.length) out.vermin = sp.vermin;
      // the container's representative-content descriptor -- both renderers
      // composite the native contents-peek overlay over the BARREL/BIN item sprite from it.
      if (sp.peek) out.peek = sp.peek;
    }
    if (shape === "WALL") out.wallnbr = computeWallNbr(wx, wy, useZ);
    return out;
  }

  // The window version advances only when a window-intersecting terrain block is re-ingested:
  // units and buildings are never ingested into this tiles-only cache, so it ignores AUX churn.
  function windowVersions(ox, oy, z, w, h) {
    var maxv = 0;
    var coverage = 2166136261 >>> 0; // FNV-1a over the fixed-order presence bitmap
    var bx0 = ox >> 4, bx1 = (ox + w - 1) >> 4;
    var by0 = oy >> 4, by1 = (oy + h - 1) >> 4;
    var zlo = z - 10; if (zlo < 0) zlo = 0;
    for (var zz = zlo; zz <= z; zz++) {
      for (var bx = bx0; bx <= bx1; bx++) {
        for (var by = by0; by <= by1; by++) {
          var key = bx * 4096 + by;
          var c = getChunk(zz, key);
          // Hash the local ingest generation, not only presence: a placeholder and its replacement share a
          // world_seq, so a presence-only hash keeps the placeholder forever.
          coverage = Math.imul(coverage ^ (c ? chunkRevision(zz, key) : 0), 16777619) >>> 0;
          if (c && c.ver > maxv) maxv = c.ver;
        }
      }
    }
    return { version: maxv, coverageVersion: coverage };
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
        if (tile.tt < 0) {
          var key = chunkKeyFor(wx, wy);
          var inWorld = coldAskInBounds(wx, wy);
          for (var zz = z; zz >= zlo; zz--) {
            if (getChunk(zz, key)) continue;
            var knownZ = knownKeysByZ.get(zz);
            if (knownZ && knownZ.has(key)) { missing.add(reqBlockId(wx >> 4, wy >> 4, zz)); continue; }
            if (!inWorld) continue;
            var missingId = reqBlockId(wx >> 4, wy >> 4, zz);
            // A sent-but-unanswered cold ask stays eligible for retries while the hole is visible; with no
            // reqBlocks state, coldAsked enforces the one bounded question for genuinely undiscovered rock.
            if (coldAsked.has(coldKey(zz, key)) && !reqBlocks.has(missingId)) continue;
            missing.add(missingId);
          }
        }
      }
    }
    requestMissingBlocks(missing);
    var versions = windowVersions(ox, oy, z, w, h);
    return { origin: { x: ox, y: oy, z: z }, width: w, height: h, z: z, tiles: tiles,
             version: versions.version, coverageVersion: versions.coverageVersion };
  }

  // One tile at a world address, with none of windowView's per-window machinery: the 3D viewer's sparse
  // scan already knows which handful of slots are worth decoding.
  function tileAt(z, wx, wy) { return decodeTile(z, wx, wy); }

  // Membership in knownKeysByZ is positive evidence the server once shipped the block, so this is a
  // legitimate gap-fill, not the perpetual churn that asking for never-discovered rock would be.
  function requestKnownBlocksIn(x1, y1, x2, y2, zBot, zTop) {
    var values = [x1, y1, x2, y2, zBot, zTop].map(Number);
    if (!values.every(Number.isFinite)) return 0;
    var bx0 = Math.min(values[0], values[2]) >> 4, bx1 = Math.max(values[0], values[2]) >> 4;
    var by0 = Math.min(values[1], values[3]) >> 4, by1 = Math.max(values[1], values[3]) >> 4;
    var z0 = Math.min(values[4], values[5]) | 0, z1 = Math.max(values[4], values[5]) | 0;
    var count = 0;
    for (var z = z0; z <= z1; z++) {
      var known = knownKeysByZ.get(z);
      if (!known || !known.size) continue;
      for (var bx = bx0; bx <= bx1; bx++) {
        for (var by = by0; by <= by1; by++) {
          var kk = bx * 4096 + by;
          if (!known.has(kk)) continue;
          if (getChunk(z, kk)) continue;      // still cached: nothing to refill
          reqBlocksWanted.add(reqBlockId(bx, by, z));
          count++;
        }
      }
    }
    if (count) pumpRequestedBlocks();
    return count;
  }

  // Visits only addresses the server announced, so pathological map dimensions cannot turn a rebuild
  // into an embark-width scan.
  function requestAllKnownBlocks(zBot, zTop) {
    var z0 = Number(zBot), z1 = Number(zTop);
    if (!Number.isFinite(z0) || !Number.isFinite(z1)) return 0;
    z0 |= 0; z1 |= 0;
    if (z0 > z1) { var t = z0; z0 = z1; z1 = t; }
    var count = 0;
    for (var z = z0; z <= z1; z++) {
      var known = knownKeysByZ.get(z);
      if (!known) continue;
      known.forEach(function (key) {
        if (getChunk(z, key)) return;
        var bx = Math.floor(key / 4096), by = key - bx * 4096;
        reqBlocksWanted.add(reqBlockId(bx, by, z));
        count++;
      });
    }
    if (count) pumpRequestedBlocks();
    return count;
  }

  // setMapDims is fed from hello_ack; mapDims() returns null pre-hello.
  function setMapDims(w, h, zc) {
    if (typeof w === "number" && typeof h === "number") {
      worldMapDims = { w: w, h: h, z: (typeof zc === "number") ? zc : 0 };
    }
  }
  function mapDims() { return worldMapDims; }

  // A BLOCK_SET acked but never ingested is unrecoverable: the transport cannot say which blocks it held
  // and the server will not re-offer them, so forget coldAsked and allow each block one more cold ask.
  function noteLostDelivery() { coldAsked.clear(); }

  // Read-only and pull-based on purpose: it hands out the stored chunks so a caller can measure them
  // without this module growing an opinion about what a fort is. Evicted keys return null and are skipped.
  function forEachChunk(cb) {
    if (typeof cb !== "function") return;
    ensureBackend();
    knownKeysByZ.forEach(function (keys, z) {
      keys.forEach(function (key) {
        var chunk = getChunk(z, key);
        if (chunk) cb(z, chunk, key);
      });
    });
  }

  var api = {
    ingest: ingest,
    ingestBlocks: ingestBlocks,
    getChunk: getChunk,
    chunkRevision: chunkRevision,
    chunkKeyFor: chunkKeyFor,
    setMapDims: setMapDims,
    mapDims: mapDims,
    noteLostDelivery: noteLostDelivery,
    onDirty: onDirty,
    stats: stats,
    setTiletypeMeta: setTiletypeMeta,
    setItemTypeMeta: setItemTypeMeta,
    setCamHintZ: setCamHintZ,
    windowView: windowView,
    tileAt: tileAt,
    forEachChunk: forEachChunk,
    reset: reset,
    requestBlockRect: requestBlockRect,
    requestKnownBlocksIn: requestKnownBlocksIn,
    requestAllKnownBlocks: requestAllKnownBlocks,
    _setBudgetForTest: _setBudgetForTest,
    _resetForTest: reset,
    _setReqBlocksEnabledForTest: function (enabled) { reqBlocksEnabled = enabled !== false; },
    _backend: function () { ensureBackend(); return useWorker ? "worker" : (core ? "sync" : "none"); },
  };
  try { window.DwfCache = api; } catch { /* headless contexts leave the browser API unattached */ }
})();
