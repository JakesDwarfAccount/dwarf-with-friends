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

// ---- Standalone WebSocket PUSH transport for the tile renderer (window.DwfWS). ----
// Self-contained: it touches no global of the render client and never throws out of its own callbacks.

(function () {
  "use strict";

  // "Never throw out of the socket handler" must not become conditional on another file loading.
  // dwf-util.js is script #1 in both documents that load this one; the fallback covers the day it is not.
  const ERR = (typeof DwfErr !== "undefined") ? DwfErr : {
    count() {}, report() {}, wrap(fn) { return fn; }, stats() { return {}; },
  };

  // ---- connection state ----------------------------------------------------------
  let ws = null;
  let curPlayer = null;
  let curClientId = "";        // stable per-tab id sent in hello (server name-dedup)
  let onMessageCb = null;
  let onCloseCb = null;
  let onCursorsCb = null;      // smooth-cursor push handler (see setCursorHandler)
  let wantOpen = false;        // true between connect() and close(); gates reconnect
  let reconnectTimer = null;
  let backoffMs = 500;         // grows to BACKOFF_MAX on repeated failures
  const BACKOFF_MIN = 500;
  const BACKOFF_MAX = 8000;
  // Desired tile-window dims (FIX 1): sent on the /ws URL so the host sizes each pushed
  // frame to this client's canvas, matching what GET /mapdata?w=&h= would return.
  let curW = 0;
  let curH = 0;

  // ---- protocol v1 --------------------------------------------------------------------------------------
  let v1Mode = false;
  let onAuxCb = null;          // AUX frame handler (units/buildings/players/authoritative cam)
  let onHelloAckCb = null;     // hello_ack handler (map dims/limits)
  let onItemDefDictCb = null;  // ITEMDEF_DICT handler (item_type/subtype -> raw token)
  let initialCam = null;       // {x,y,z} advisory camera for the NEXT hello (§0.4)
  let v1LastAckedSeq = 0;      // highest per-connection frame `seq` this client has ACKed
  let v1LastSeenSeq = 0;       // highest per-connection frame `seq` actually observed
  let v1RttMs = 0;             // best-effort round-trip estimate (see notes at pongReceived)
  let v1PingSentAt = 0;
  let v1LastAuxArrival = 0;    // Date.now() of the most recent AUX frame (estBehindMs, §C "exact")
  let v1SnapshotDone = false;  // trickle:"end" observed (diagnostic only)
  let lastIsHost = false;      // last hello_ack's server-computed isHost: true only for a loopback peer, so a client cannot spoof it
  let helloTimeoutTimer = null; // auto-fallback-to-legacy watchdog (see sock.onopen below)
  function clearHelloTimeout() {
    if (helloTimeoutTimer !== null) { clearTimeout(helloTimeoutTimer); helloTimeoutTimer = null; }
  }
  let socketOpens = 0;         // lifetime count of real `new WebSocket(...)` constructions
  const v1ByteRing = [];       // [{t, bytes, kind:"blockset"|"aux"}] -- F3 throughput lines
  let v1BlockSetBytesTotal = 0, v1AuxBytesTotal = 0;   // lifetime counters
  function v1RecordBytes(bytes, kind) {
    v1ByteRing.push({ t: Date.now(), bytes: bytes | 0, kind: kind });
    while (v1ByteRing.length > 480) v1ByteRing.shift();
    if (kind === "blockset") v1BlockSetBytesTotal += bytes | 0; else v1AuxBytesTotal += bytes | 0;
  }
  function v1BytesPerSec(kind) {
    const now = Date.now();
    let sum = 0;
    for (let i = v1ByteRing.length - 1; i >= 0; i--) {
      const s = v1ByteRing[i];
      if (now - s.t > 1000) break;
      if (s.kind === kind) sum += s.bytes;
    }
    return sum;
  }

  // ---- drop-stale delivery -------------------------------------------------------
  const MAX_APPLY = 3;              // small-backlog ceiling: apply-all-in-order threshold
  const MAX_BEHIND_MS = 500;        // big-backlog ceiling: estimated queued-behind time
  let pend = [];                    // [{mode:"key"|"delta", map, wireBytes, t}], arrival order
  let droppedStale = 0;             // lifetime counter: messages dropped unapplied (rules 2+4)
  let v1LostBlockSets = 0;          // lifetime counter: BLOCK_SETs acked but never ingested
  let forceFreshHave = false;       // cache-backend loss: next HELLO must request a full snapshot
  let resyncs = 0;                  // lifetime counter: reqkey escapes sent
  let reqkeyLatched = false;        // don't spam reqkey while one is already in flight
  let arrivalGapEwma = 33;          // ms; seeded at the nominal 30Hz metronome cadence
  let lastArrivalTs = 0;
  let lastClientApplyMs = 0;        // most recent arrival -> applied latency sample (ms)
  // Only ONE inflate runs at a time; a newer raw buffer supersedes an older one before it is decoded.
  let inflightRaw = null;
  let queuedRaw = null;
  let _rafActive = false;
  let _rafHandle = null;
  function _now() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
  function _requestFrame(cb) {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(cb);
    return setTimeout(cb, 16);
  }
  function _cancelFrame(h) {
    if (typeof cancelAnimationFrame === "function") { cancelAnimationFrame(h); return; }
    clearTimeout(h);
  }

  function wsUrl(player) {
    // Same host/port as the page; ws:// for http, wss:// for https.
    const wsProto = (location.protocol === "https:") ? "wss:" : "ws:";
    let u = `${wsProto}//${location.host}/ws?player=${encodeURIComponent(player)}`;
    if (curW > 0 && curH > 0) u += `&w=${curW}&h=${curH}`;
    // §0.1: appending &proto=1 opts this connection into the binary protocol; dims on the URL
    // remain the pre-HELLO default (the CAM message and hello_ack.map are authoritative after).
    if (v1Mode) u += `&proto=1`;
    return u;
  }

  function clearReconnect() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  let connectionLost = false;
  let connectionNoticeTimer = null;
  function paintConnectionState(state, retryMs) {
    if (typeof document === "undefined" || !document.body) return;
    let banner = document.getElementById("dwfConnectionBanner");
    if (state === "connected" && !connectionLost && !banner) return;
    if (!banner) {
      if (!window.DWFUI || typeof window.DWFUI.statusHtml !== "function") return;
      banner = document.createElement("div");
      banner.id = "dwfConnectionBanner";
      banner.setAttribute("role", "status");
      banner.setAttribute("aria-live", "polite");
      document.body.appendChild(banner);
    }
    if (connectionNoticeTimer !== null) {
      clearTimeout(connectionNoticeTimer);
      connectionNoticeTimer = null;
    }
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    let copy = "Reconnected.";
    if (state !== "connected") {
      const retry = Number.isFinite(retryMs) && retryMs > 0
        ? ` Retrying automatically in ${Math.max(1, Math.ceil(retryMs / 1000))}s.`
        : " Retrying automatically.";
      copy = offline ? "You are offline. Reconnecting when the network returns." : "Connection lost." + retry;
    }
    banner.dataset.connectionState = state;
    banner.setAttribute("aria-label", copy);
    banner.innerHTML = window.DWFUI.statusHtml({
      tag: "span", cls: "dwf-connection-copy", text: copy, role: "status", live: "polite",
    });
    if (state === "connected") {
      connectionNoticeTimer = setTimeout(() => {
        connectionNoticeTimer = null;
        try { banner.remove(); } catch { /* already detached by a re-render; nothing to undo */ }
      }, 2400);
    }
  }

  function markConnectionRecovered() {
    lastCloseNotified = false;
    if (!connectionLost) return;
    connectionLost = false;
    paintConnectionState("connected");
  }

  // navigator.onLine can flip before Chrome dispatches WebSocket.onclose, so publish transport truth from
  // the browser event and make sure a closed socket has a retry scheduled even if onclose has not run yet.
  try {
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("offline", () => {
        if (!wantOpen) return;
        connectionLost = true;
        paintConnectionState("reconnecting");
      });
      window.addEventListener("online", () => {
        if (!wantOpen || !connectionLost) return;
        paintConnectionState("reconnecting");
        if (!isConnected()) scheduleReconnect();
      });
    }
  } catch { /* no window: nothing to listen to, and the poll fallback still runs */ }

  function scheduleReconnect() {
    if (!wantOpen) return;
    clearReconnect();
    // +-20% jitter: without it, N clients reconnecting after one shared event stampede the server with
    // simultaneous keyframe builds, i.e. N CoreSuspender spikes.
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.round(backoffMs * jitter);
    backoffMs = Math.min(BACKOFF_MAX, Math.round(backoffMs * 1.7));
    paintConnectionState("reconnecting", delay);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (wantOpen && curPlayer) open(curPlayer);
    }, delay);
  }

  // ---- Half-open staleness watchdog: a half-open socket never delivers an onclose event. ----
  // 3 s of total inbound silence forces close(), so the browser fires onclose locally and polling resumes.
  let lastInboundTime = 0;      // Date.now() of the last inbound frame of ANY kind
  let lastGoodInboundTime = 0;  // Date.now() of the last frame that dispatched without throwing
  let watchdogTimer = null;
  const STALE_MS = 3000;
  function checkStale() {
    if (typeof document !== "undefined" && document.hidden) return; // throttled tab: don't trip
    if (isConnected() && lastInboundTime && (Date.now() - lastInboundTime) > STALE_MS) {
      try { if (ws) ws.close(); } catch { /* already closing; onclose still drives the reconnect */ }
    }
  }
  function startWatchdog() {
    stopWatchdog();
    if (typeof setInterval !== "function") return;
    watchdogTimer = setInterval(checkStale, 1000);
  }
  function stopWatchdog() {
    if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null; }
  }

  // ---- Perf stats for the F3 diagnostic overlay. ----
  const statRing = [];
  let lastMsgTime = 0;
  function recordStat(bytes, mode) {
    const now = Date.now();
    statRing.push({ t: now, bytes: bytes | 0, mode: mode });
    while (statRing.length > 240) statRing.shift();
    lastMsgTime = now;
  }
  function estBehindMsNow() {
    // The stream is a ~33 ms metronome, so a gap beyond that times the backlog estimates how far behind now is.
    return Math.max(0, (arrivalGapEwma - 33) * pend.length);
  }
  function getStats() {
    const now = Date.now(), win = 1000;
    // DwfErr owns every failure count; keeping a second copy here is how two numbers drift apart.
    const errs = ERR.stats();
    let n = 0, b = 0, nk = 0, bk = 0, nd = 0, bd = 0;
    for (let i = statRing.length - 1; i >= 0; i--) {
      const s = statRing[i];
      if (now - s.t > win) break;
      n++; b += s.bytes;
      if (s.mode === "delta") { nd++; bd += s.bytes; } else { nk++; bk += s.bytes; }
    }
    const v1EstBehindMs = v1Mode
      ? Math.max(0, (v1LastAuxArrival ? now - v1LastAuxArrival : 0) + v1RttMs / 2)
      : estBehindMsNow();
    return {
      msgsPerSec: n, avgBytes: n ? Math.round(b / n) : 0,
      keyMsgs: nk, keyAvgBytes: nk ? Math.round(bk / nk) : 0,
      deltaMsgs: nd, deltaAvgBytes: nd ? Math.round(bd / nd) : 0,
      msSinceLast: lastMsgTime ? (now - lastMsgTime) : -1,
      // drop-stale stats (F3 + gate consumers):
      pendingMaps: pend.length,
      pendingInflates: (inflightRaw ? 1 : 0) + (queuedRaw ? 1 : 0),
      droppedStale: droppedStale,
      applyFailures: errs["ws.map-apply"] || 0,
      // Their DIVERGENCE is the signal: bytes keep msSinceInbound fresh, but only a dispatched frame
      // resets msSinceGoodFrame. A gap is "the connection reads fine and the world has stopped".
      frameDispatchFailures: errs["ws.frame-dispatch"] || 0,
      msSinceInbound: lastInboundTime ? (now - lastInboundTime) : -1,
      msSinceGoodFrame: lastGoodInboundTime ? (now - lastGoodInboundTime) : -1,
      resyncs: resyncs,
      estBehindMs: Math.round(v1EstBehindMs),
      clientApplyMs: Math.round(lastClientApplyMs),
      // protocol v1 diagnostics (F3 + gate_localnav + __wa_nav consumers).
      proto: v1Mode ? "v1" : "legacy",
      rttMs: v1RttMs,
      inflightAcks: Math.max(0, v1LastSeenSeq - v1LastAckedSeq),
      worldSeq: v1KnownWorldSeq,
      blockSetBytesPerSec: v1BytesPerSec("blockset"),
      auxBytesPerSec: v1BytesPerSec("aux"),
      lostBlockSets: v1LostBlockSets,
      blockSetBytesTotal: v1BlockSetBytesTotal,
      auxBytesTotal: v1AuxBytesTotal,
      socketOpens: socketOpens,
      snapshotDone: v1SnapshotDone,
    };
  }

  // A keyframe supersedes every older pending map message: it rebuilds the whole buffer.
  function enqueueMapMsg(mode, map, wireBytes) {
    const now = _now();
    if (lastArrivalTs) {
      const gap = now - lastArrivalTs;
      arrivalGapEwma = arrivalGapEwma * 0.8 + gap * 0.2;
    }
    lastArrivalTs = now;
    if (mode === "key") {
      if (pend.length) droppedStale += pend.length;
      pend = [];
      reqkeyLatched = false;
    }
    pend.push({ mode: mode, map: map, wireBytes: wireBytes, t: now });
  }

  // Map deltas are CUMULATIVE, so an abandoned one leaves the view wrong until the next keyframe.
  function noteApplyFailure(err) {
    ERR.report("ws.map-apply", err);
  }

  // Called once per animation frame, NEVER per message: a burst inside one frame must be judged as one
  // backlog, and that coalescing is what makes the drop-stale rules mean anything.
  function drainOnce() {
    if (pend.length === 0) return;
    if (pend.length > MAX_APPLY || estBehindMsNow() > MAX_BEHIND_MS) {
      // Big backlog -- drop everything unapplied, latch one reqkey, and wait.
      droppedStale += pend.length;
      pend = [];
      if (!reqkeyLatched) {
        reqkeyLatched = true;
        resyncs++;
        requestKeyframe();
      }
      return;
    }
    const batch = pend;
    pend = [];
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      // Scoped per item: a throw drops only ITS update, never the already-dequeued tail behind it.
      // Re-queueing the thrower instead would wedge the queue retrying one poisoned message forever.
      try {
        lastClientApplyMs = Math.max(0, _now() - item.t);
        if (item.mode === "key") reqkeyLatched = false;
        deliver({ mode: item.mode, map: item.map });
      } catch (err) {
        noteApplyFailure(err);
      }
    }
  }

  function rafTick() {
    if (!_rafActive) return;
    // The drain loop must never die: the next frame is scheduled in `finally`, so not even a throwing
    // failure report can end the loop.
    try { drainOnce(); }
    catch (err) { noteApplyFailure(err); }
    finally { _rafHandle = _requestFrame(rafTick); }
  }
  function startRafLoop() {
    if (_rafActive) return;
    _rafActive = true;
    _rafHandle = _requestFrame(rafTick);
  }
  function stopRafLoop() {
    _rafActive = false;
    if (_rafHandle !== null) { _cancelFrame(_rafHandle); _rafHandle = null; }
  }

  // `wireBytes` is the ACTUAL bytes on the wire -- for a binary frame the compressed size, not the
  // inflated text length -- so the stats overlay reports the real tunnel cost.
  function handleText(text, wireBytes) {
    const wb = (typeof wireBytes === "number") ? wireBytes : text.length;
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // ignore non-JSON control noise
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "map") {
      const obj = (msg.map && typeof msg.map === "object") ? msg.map : msg;
      const mode = (msg.mode === "delta") ? "delta" : "key";
      recordStat(wb, mode);
      enqueueMapMsg(mode, obj, wb);   // queued, not delivered synchronously
      return;
    }
    // Cursors are ALWAYS applied in arrival order, independent of map coalescing; they never touch pend[].
    if (msg.type === "cursors" && Array.isArray(msg.players)) {
      if (onCursorsCb) {
        try { onCursorsCb(msg.players); } catch (err) { ERR.report("ws.cursors-apply", err); }
      }
      return;
    }
    // Routed to dwf-pause.js; inert when that module is not loaded (old-client tolerance).
    if (msg.type === "pause") {
      try { if (window.DwfPause) window.DwfPause.onPause(msg); } catch (err) { ERR.report("ws.pause-apply", err); }
      return;
    }
    if (msg.type === "busy") {
      try { if (window.DwfPause) window.DwfPause.onBusy(msg); } catch (err) { ERR.report("ws.busy-apply", err); }
      return;
    }
    // Routed to dwf-chat.js; inert when that module is not loaded (old-client tolerance).
    if (msg.type === "chat") {
      try { if (window.DwfChat) window.DwfChat.onChat(msg); } catch (err) { ERR.report("ws.chat-apply", err); }
      return;
    }
    if (msg.type === "chat_rejected") {
      try { if (window.DwfChat && typeof DwfChat.onRejected === "function") DwfChat.onRejected(msg); }
      catch (err) { ERR.report("ws.chat-rejected-apply", err); }
      return;
    }
    if (msg.type === "popup") {
      try { if (window.DwfPopup) window.DwfPopup.onPopup(msg); } catch (err) { ERR.report("ws.popup-apply", err); }
      return;
    }
    if (msg.type === "burrows") {
      try { if (window.DFBurrowSync) window.DFBurrowSync.onBurrows(msg); } catch (err) { ERR.report("ws.burrows-apply", err); }
      return;
    }
    if (msg.type === "diplo") {
      try { if (window.DwfDiplo) window.DwfDiplo.onDiplo(msg); } catch (err) { ERR.report("ws.diplo-apply", err); }
      return;
    }
    // Tolerant fallback: a bare mapdata object (no envelope) -> keyframe.
    if (msg.type === undefined && Array.isArray(msg.tiles) && msg.origin) {
      recordStat(wb, "key");
      enqueueMapMsg("key", msg, wb);
      return;
    }
    // ---- protocol v1 text control messages -- only ever sent on a v1 session; a legacy
    // server never emits these types, so these branches are simply unreached there. --------
    if (msg.type === "hello_ack") {
      clearHelloTimeout(); // handshake succeeded -- cancel the auto-fallback watchdog
      markConnectionRecovered();
      lastIsHost = msg.isHost === true;
      try { if (window.DwfDigest && typeof DwfDigest.onJoinComplete === "function") DwfDigest.onJoinComplete({ player: msg.player || curPlayer }); }
      catch (err) { ERR.report("ws.join-complete", err); }
      // hello_ack carries the server build stamp, so a stale tab after a redeploy gets the refresh banner
      // here even if it never re-hit /version.
      if (msg.build && window.DwfJoin && typeof DwfJoin.checkVersion === "function") {
        try { DwfJoin.checkVersion(msg.build, msg.assets); } catch (err) { ERR.report("ws.version-check", err); }
      }
      if (onHelloAckCb) { try { onHelloAckCb(msg); } catch (err) { ERR.report("ws.hello-ack", err); } }
      return;
    }
    // JOIN SECURITY: the server rejected our hello token (no/stale credential). Stop the
    // reconnect churn and hand off to the join module to re-collect the passphrase.
    if (msg.type === "auth_fail") {
      wantOpen = false;            // don't auto-reconnect into another rejection
      clearReconnect();
      try { if (window.DwfAuth && typeof DwfAuth.onAuthFail === "function") DwfAuth.onAuthFail(); }
      catch (err) { ERR.report("ws.auth-fail-handoff", err); }
      return;
    }
    if (msg.type === "snapshot_meta") {
      if (msg.trickle === "end") v1SnapshotDone = true;
      return; // diagnostic only; no client action required
    }
    if (msg.type === "ping") {
      v1PingSentAt = _now();
      send({ type: "pong", ts: msg.ts, tc: Date.now() });
      return;
    }
    // Other control types (presence/chat/atlas, future work) are ignored here.
  }

  // A rough "how responsive does the link feel" signal, not a precise RTT -- /diag's is authoritative.
  function v1NoteRttSample(nowMs) {
    if (!v1PingSentAt) return;
    const sample = nowMs - v1PingSentAt;
    v1PingSentAt = 0;
    if (sample > 0 && sample < 30000) v1RttMs = v1RttMs ? Math.round(v1RttMs * 0.7 + sample * 0.3) : Math.round(sample);
  }

  const _hasDS = (typeof DecompressionStream === "function");
  async function inflateDeflate(arrayBuffer) {
    const ds = new DecompressionStream("deflate");
    const stream = new Response(arrayBuffer).body.pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new TextDecoder("utf-8").decode(buf);
  }
  function startInflate(arrayBuffer) {
    inflightRaw = arrayBuffer;
    const wireBytes = arrayBuffer.byteLength;   // compressed size = the real tunnel cost
    inflateDeflate(arrayBuffer)
      .then((text) => { if (text) handleText(text, wireBytes); })
      .catch((err) => { ERR.report("ws.inflate", err); })
      .then(() => {
        inflightRaw = null;
        if (queuedRaw) {
          const next = queuedRaw;
          queuedRaw = null;
          startInflate(next);
        }
      });
  }
  function handleBinary(arrayBuffer) {
    if (!_hasDS) return;   // no native inflate (ancient browser): server still text-fallbacks
    if (inflightRaw) {
      // An inflate is already running; this newer buffer supersedes anything not yet
      // started -- drop the previously-queued one unapplied, never inflate it.
      if (queuedRaw) droppedStale++;
      queuedRaw = arrayBuffer;
      return;
    }
    startInflate(arrayBuffer);
  }

  // ---- protocol v1 binary frame routing -------------------------------------------------
  async function inflateRaw(arrayBuffer) {
    const ds = new DecompressionStream("deflate");
    const stream = new Response(arrayBuffer).body.pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }
  let v1KnownWorldSeq = 0; // highest world_seq observed from a BLOCK_SET header peek (see below)
  // A BLOCK_SET acked on arrival but never reaching the cache is counted here, beside both failure paths,
  // so neither can quietly become a bare catch again.
  function v1NoteLostBlockSet() {
    v1LostBlockSets++;
    try {
      if (window.DwfCache && typeof DwfCache.noteLostDelivery === "function") DwfCache.noteLostDelivery();
    } catch (err) { ERR.report("ws.lost-blockset-notify", err); }
  }

  function v1Deliver(payloadBuffer, type, wireBytes) {
    if (type === 0x01 /* BLOCK_SET */) {
      v1RecordBytes(wireBytes, "blockset");
      // Peek world_seq (payload's first 4 LE bytes, §0.3) BEFORE handing the buffer to the
      // cache -- ingestBlocks() may TRANSFER it to a worker (detaching it on this side).
      try {
        const dv = new DataView(payloadBuffer);
        const seq = dv.getUint32(0, true);
        if (seq > v1KnownWorldSeq) v1KnownWorldSeq = seq;
      } catch { ERR.count("ws.blockset-seq-peek"); }
      try {
        if (window.DwfCache && typeof DwfCache.ingestBlocks === "function") {
          DwfCache.ingestBlocks(payloadBuffer);
        }
      } catch {
        // This frame was already acked, and the server treats an acked BLOCK_SET as delivered forever, so
        // swallowing it leaves a hole nothing will ever refill.
        v1NoteLostBlockSet();
      }
      return;
    }
    if (type === 0x02 /* AUX */) {
      v1RecordBytes(wireBytes, "aux");
      v1LastAuxArrival = Date.now();
      let obj = null;
      try { obj = JSON.parse(new TextDecoder("utf-8").decode(payloadBuffer)); }
      catch (err) { obj = null; ERR.report("ws.aux-decode", err); }
      // Phase-5 Settings Info consumes this optional, read-only AUX value. Delete it when an
      // older host omits the field so reconnecting to one restores the honest fallback.
      try {
        window.DwfSessionInfo = window.DwfSessionInfo || {};
        const autosave = obj && obj.env && typeof obj.env.autosave === "string" ? obj.env.autosave : null;
        if (autosave !== null) window.DwfSessionInfo.autosave = autosave;
        else delete window.DwfSessionInfo.autosave;
      } catch { ERR.count("ws.session-info"); }
      if (obj && onAuxCb) { try { onAuxCb(obj); } catch (err) { ERR.report("ws.aux-apply", err); } }
      return;
    }
    if (type === 0x03 /* ITEMDEF_DICT */) {
      try {
        const W = window.DwfWireV1;
        if (W && typeof W.decodeItemDefDict === "function" && onItemDefDictCb) {
          onItemDefDictCb(W.decodeItemDefDict(new Uint8Array(payloadBuffer)));
        }
      } catch (err) { ERR.report("ws.itemdef-dict", err); }
      return;
    }
    // Unknown/reserved type (e.g. the future 0x20-0x2F audio channel) -- ignored per the
    // additive-growth posture the whole wire is built on (§0.3.2's own tail-kind precedent).
  }
  function handleBinaryV1(arrayBuffer) {
    const W = window.DwfWireV1;
    if (!W) return; // decoder module failed to load -- drop the frame, never throw
    const header = W.decodeHeader(new Uint8Array(arrayBuffer));
    if (!header) return; // bad magic/version -- corrupt/foreign frame, drop it
    v1LastSeenSeq = header.seq;
    v1NoteRttSample(_now());
    v1LastAckedSeq = header.seq;
    send({ type: "ack", seq: header.seq, t: Date.now() });
    const wireBytes = arrayBuffer.byteLength;
    // Slice into its OWN ArrayBuffer: BLOCK_SET payloads are TRANSFERRED to the cache worker, which
    // requires a buffer nobody else holds a reference into.
    const payloadSlice = arrayBuffer.slice(header.payloadOffset);
    if (header.deflated) {
      if (!_hasDS) return; // no native inflate (ancient browser) -- drop; v1 is opt-in anyway
      inflateRaw(payloadSlice)
        .then((buf) => v1Deliver(buf, header.type, wireBytes))
        .catch(() => {
          // A corrupt deflate stream must not wedge the chain -- and, for a BLOCK_SET, must not
          // vanish either: it was acked above, so the server will never re-offer these blocks.
          if (header.type === 0x01 /* BLOCK_SET */) v1NoteLostBlockSet();
        });
    } else {
      v1Deliver(payloadSlice, header.type, wireBytes);
    }
  }

  function deliver(mapData) {
    try {
      if (window.DwfCache && typeof DwfCache.ingest === "function" && mapData && mapData.map) {
        DwfCache.ingest(mapData.map);
      }
    } catch (err) { ERR.report("ws.cache-ingest", err); }
    if (!onMessageCb) return;
    try {
      onMessageCb(mapData);
    } catch (err) {
      ERR.report("ws.map-render", err);
    }
  }

  function open(player) {
    // A fresh socket means fresh server-side state, so anything still queued from the old connection is
    // moot. Not counted in droppedStale -- this is a connection boundary, not a policy drop.
    pend = [];
    inflightRaw = null;
    queuedRaw = null;
    reqkeyLatched = false;
    lastArrivalTs = 0;
    clearHelloTimeout();
    // Tear down any prior socket before opening a new one.
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; } catch { /* the old socket is being discarded either way */ }
      try { ws.close(); } catch { /* the old socket is being discarded either way */ }
      ws = null;
    }

    let sock;
    try {
      sock = new WebSocket(wsUrl(player));
    } catch {
      // Construction itself can throw (bad URL, blocked). Treat as a drop.
      scheduleReconnect();
      notifyClose("ws construct failed");
      return;
    }
    sock.binaryType = "arraybuffer";
    ws = sock;
    socketOpens++;   // lifetime real-socket-construction count (localnav's "reconnects")

    sock.onopen = () => {
      backoffMs = BACKOFF_MIN; // reset backoff on a good connection
      if (!v1Mode) markConnectionRecovered();
      if (v1Mode) {
        // A v1 connection MUST send hello first (5 s server deadline). `have` is the highest world_seq this
        // cache holds; 0, or a value outside the server's changelog ring, forces a full snapshot.
        let have = 0;
        if (!forceFreshHave) {
          try {
            if (window.DwfCache && typeof DwfCache.stats === "function") {
              const s = DwfCache.stats();
              if (typeof s.worldSeq === "number") have = s.worldSeq;
            }
          } catch (err) { ERR.report("ws.hello-have", err); }
        }
        forceFreshHave = false;
        const cam = initialCam || { x: 0, y: 0, z: 0 };
        // The same shared secret the browser holds in the dfcap_auth cookie: one credential, two transports.
        var joinToken = "";
        try { if (window.DwfAuth && typeof DwfAuth.token === "function") joinToken = DwfAuth.token() || ""; }
        catch (err) { ERR.report("ws.join-token", err); }
        send({
          // `id` is a stable per-tab token, so the server can tell a refresh's own ghost from a real duplicate.
          type: "hello", proto: 1, caps: ["auxd"], player: player, id: curClientId || "", have: have,
          token: joinToken,
          cam: { x: cam.x, y: cam.y, z: cam.z, w: curW || 1, h: curH || 1 },
        });
        clearHelloTimeout();
        helloTimeoutTimer = setTimeout(() => {
          helloTimeoutTimer = null;
          if (v1Mode) { v1Mode = false; try { ws && ws.close(); } catch { /* falling back to legacy; this socket is discarded regardless */ } }
        }, 5000);
      }
    };

    sock.onmessage = (ev) => {
      lastInboundTime = Date.now();   // watchdog: any frame proves the TRANSPORT is alive
      try {
        if (typeof ev.data === "string") {
          handleText(ev.data);
        } else if (ev.data instanceof ArrayBuffer) {
          if (v1Mode) handleBinaryV1(ev.data); else handleBinary(ev.data);
        }
        lastGoodInboundTime = lastInboundTime;
      } catch (err) {
        // Bytes arriving still refresh the watchdog above, so this is the ONLY signal that frames
        // are landing and dying: without it the connection reads healthy while the world stops.
        ERR.report("ws.frame-dispatch", err);
      }
    };

    sock.onerror = () => {
      // onclose follows; let it drive reconnect/notify so we don't double-fire.
    };

    sock.onclose = () => {
      if (ws === sock) ws = null;
      notifyClose("socket closed");
      scheduleReconnect();
    };
  }

  let lastCloseNotified = false;
  function notifyClose(reason) {
    // Coalesce repeated close notifications between reconnect attempts so the host's
    // fallback logic isn't spammed.
    if (lastCloseNotified) return;
    lastCloseNotified = true;
    connectionLost = true;
    paintConnectionState("reconnecting");
    if (onCloseCb) {
      try { onCloseCb(reason); } catch (err) { ERR.report("ws.close-callback", err); }
    }
  }

  // ---- public API ----------------------------------------------------------------
  function connect(player, onMessage, onClose, dims, opts) {
    curPlayer = player;
    onMessageCb = (typeof onMessage === "function") ? onMessage : null;
    onCloseCb = (typeof onClose === "function") ? onClose : null;
    if (dims && dims.w > 0 && dims.h > 0) { curW = dims.w | 0; curH = dims.h | 0; }
    v1Mode = !!(opts && opts.proto1);
    onAuxCb = (opts && typeof opts.onAux === "function") ? opts.onAux : null;
    onHelloAckCb = (opts && typeof opts.onHelloAck === "function") ? opts.onHelloAck : null;
    if (opts && typeof opts.clientId === "string") curClientId = opts.clientId;   // stable per-tab id
    onItemDefDictCb = (opts && typeof opts.onItemDefDict === "function") ? opts.onItemDefDict : null;
    initialCam = (opts && opts.initialCam) ? opts.initialCam : null;
    wantOpen = true;
    lastCloseNotified = false;
    backoffMs = BACKOFF_MIN;
    lastInboundTime = Date.now();   // grace period before the watchdog can trip
    startWatchdog();
    startRafLoop();   // the drop-stale drain runs for the connection's lifetime; on v1 it idles
    open(player);
  }

  let _dimTimer = null;
  function updateDims(w, h, zoomPx) {
    w = w | 0; h = h | 0;
    if (w <= 0 || h <= 0) return;
    // Ignore sub-3-tile jitter (the scrollbar oscillation) — a couple tiles of window size is
    // visually irrelevant and must never churn the socket.
    if (Math.abs(w - curW) < 3 && Math.abs(h - curH) < 3) return;
    if (_dimTimer !== null) { clearTimeout(_dimTimer); _dimTimer = null; }
    _dimTimer = setTimeout(() => {
      _dimTimer = null;
      if (Math.abs(w - curW) < 3 && Math.abs(h - curH) < 3) return;   // re-check after settle
      curW = w; curH = h;
      if (isConnected()) send({ type: "cam", w: curW, h: curH, zoom: zoomPx });
    }, 350);
  }

  function updateDimsNow(w, h, zoomPx) {
    w = w | 0; h = h | 0;
    if (w <= 0 || h <= 0) return;
    if (_dimTimer !== null) { clearTimeout(_dimTimer); _dimTimer = null; }
    if (w === curW && h === curH) return;
    curW = w; curH = h;
    if (isConnected()) send({ type: "cam", w: curW, h: curH, zoom: zoomPx });
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    let text;
    try {
      text = JSON.stringify(obj);
    } catch {
      return false;
    }
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  function close() {
    wantOpen = false;
    clearReconnect();
    stopWatchdog();
    stopRafLoop();
    pend = [];
    inflightRaw = null;
    queuedRaw = null;
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; } catch { /* shutting down: nothing left to notify */ }
      try { ws.close(); } catch { /* shutting down: nothing left to notify */ }
      ws = null;
    }
    curPlayer = null;
    v1Mode = false;
    onAuxCb = null;
    onHelloAckCb = null;
    onItemDefDictCb = null;
    v1SnapshotDone = false;
    lastIsHost = false;
    clearHelloTimeout();
  }

  // True only when the most recent hello_ack marked this connection host; false before it arrives, so it
  // never defaults to "host".
  function isHost() {
    return lastIsHost;
  }

  function isConnected() {
    return !!ws && ws.readyState === 1;
  }

  // Best-effort: silently no-ops when the socket is down.
  function requestKeyframe() {
    return send({ type: "reqkey" });
  }

  // The worker's lost addresses are unknowable, so resume is unsafe: close, and force the next HELLO to
  // advertise have=0 so the server seeds a complete snapshot.
  function recoverFreshSnapshot(_reason) {
    if (!v1Mode || !wantOpen) return false;
    forceFreshHave = true;
    clearReconnect();
    if (ws) {
      try { ws.close(); return true; } catch { /* close threw: fall through to the timed reconnect below */ }
    }
    scheduleReconnect();
    return true;
  }

  // Register (or clear) the smooth-cursor push handler. Called by the render client after
  // connect(); receives the raw players[] array on every {"type":"cursors"} frame.
  function setCursorHandler(fn) {
    onCursorsCb = (typeof fn === "function") ? fn : null;
  }

  const api = { connect, send, close, isConnected, updateDims, updateDimsNow, setCursorHandler,
                requestKeyframe, recoverFreshSnapshot, getStats, isHost };
  try { window.DwfWS = api; } catch { /* non-browser context */ }

  // The watchdog is paused while hidden, so a re-foregrounded tab must check staleness immediately.
  try {
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) checkStale();
      });
    }
  } catch { /* non-browser context */ }

})();
