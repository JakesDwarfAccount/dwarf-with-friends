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

// dwf-ws.js -- standalone WebSocket PUSH transport for the tile renderer.
//
// Opens ws://<host>/ws?player=NAME and receives the host's per-player /mapdata JSON
// pushed the instant the map changes -- replacing dwf-tiles.js's ~2/sec HTTP
// poll with an instant, high-FPS push (the point of moving to tiles). The pushed
// payload is byte-identical to what GET /mapdata returns, so the render client feeds
// it to the SAME draw path; nothing about rendering changes, only the delivery.
//
// This file is intentionally self-contained: it touches no global used by the JPEG
// client or the tile renderer, and it never throws out of its own callbacks. It does
// NOT auto-start; an embedder (dwf-tiles.js, via a documented hook -- see the
// bottom of this file) calls DwfWS.connect(...). If the socket never connects
// or later drops, onClose() fires and the render client simply keeps HTTP polling.
//
// Public API (window.DwfWS):
//   connect(player, onMessage, onClose) -> opens the socket; auto-reconnects on drop.
//       onMessage(mapData)  -- called with a parsed /mapdata object on every push.
//       onClose(reason)     -- called when the socket drops/errs (host should resume
//                              its HTTP-poll fallback until onMessage resumes).
//   send(obj)   -- JSON-encode + send a control object to the host (best-effort).
//   close()     -- intentional shutdown; stops reconnecting.
//   isHost()    -- WD-27 follow-up: true iff the server's most recent hello_ack marked THIS
//                  connection as host (its real TCP peer is loopback -- see websocket.cpp's
//                  socket_is_loopback_peer()). false until the first hello_ack arrives.
//
// Wire format (text frames, JSON): the host wraps each map push as
//   {"type":"map","map":{ ...the /mapdata object... }}
// A future high-FPS path will additionally send BINARY frames carrying tile deltas
// (keyframe/delta), which the host would deliver via WsConnection::send_binary; this
// module already routes binary frames to a stub (onBinary) so that upgrade is
// drop-in. Unknown text `type`s (e.g. future presence/chat) are ignored here.

(function () {
  "use strict";

  // ---- connection state ----------------------------------------------------------
  let ws = null;
  let curPlayer = null;
  let curClientId = "";        // B09(a): stable per-tab id sent in hello (server name-dedup)
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

  // ---- WA-12/13/14: protocol v1 (docs/superpowers/specs/2026-07-07-WA-foundation-spec.md) ----
  // v1 is the DEFAULT wire as of WA-14 (connect()'s `opts.proto1`, gated on dwf-tiles.js's
  // `v1Active()` which is true unless `?proto=0` opts a session back to legacy). A v1 session
  // speaks an entirely different wire (binary
  // BLOCK_SET/AUX frames + a small JSON control set, §0) instead of the legacy per-player JSON
  // map push -- so `pend[]`/drainOnce/the whole WA-4 drop-stale apparatus above is a LEGACY-ONLY
  // concern: v1 map data (BLOCK_SET) is idempotent + order-free by construction (§0.6) and goes
  // STRAIGHT into the world cache (never through `pend[]`), which is exactly how rules 1-4
  // "collapse to no-ops" per the spec -- there is no v1 code path through them at all.
  let v1Mode = false;
  let onAuxCb = null;          // AUX frame handler (units/buildings/players/authoritative cam)
  let onHelloAckCb = null;     // hello_ack handler (map dims/limits)
  let onItemDefDictCb = null;  // WC-1/WC-3: ITEMDEF_DICT handler (item_type/subtype -> raw token)
  let initialCam = null;       // {x,y,z} advisory camera for the NEXT hello (§0.4)
  let v1LastAckedSeq = 0;      // highest per-connection frame `seq` this client has ACKed
  let v1LastSeenSeq = 0;       // highest per-connection frame `seq` actually observed
  let v1RttMs = 0;             // best-effort round-trip estimate (see notes at pongReceived)
  let v1PingSentAt = 0;
  let v1LastAuxArrival = 0;    // Date.now() of the most recent AUX frame (estBehindMs, §C "exact")
  let v1SnapshotDone = false;  // trickle:"end" observed (diagnostic only)
  let lastIsHost = false;      // isHostClient() hook (WD-27 follow-up): last hello_ack's
                                // server-computed `isHost` flag -- true only for the connection
                                // whose real TCP peer address is loopback (see websocket.cpp's
                                // socket_is_loopback_peer()). A tunnel/LAN client's peer is never
                                // loopback, so this can't be spoofed by anything the client sends.
  let helloTimeoutTimer = null; // auto-fallback-to-legacy watchdog (see sock.onopen below)
  function clearHelloTimeout() {
    if (helloTimeoutTimer !== null) { clearTimeout(helloTimeoutTimer); helloTimeoutTimer = null; }
  }
  let socketOpens = 0;         // lifetime count of real `new WebSocket(...)` constructions --
                                // WA-13's headline "zero reconnects on zoom" is measured as a
                                // DELTA of this counter across a gesture window (dwf-core.js).
  const v1ByteRing = [];       // [{t, bytes, kind:"blockset"|"aux"}] -- F3 throughput lines
  let v1BlockSetBytesTotal = 0, v1AuxBytesTotal = 0;   // lifetime counters -- WA-13's __wa_nav
                                                        // hook (dwf-core.js) computes a
                                                        // gesture-window DELTA against these.
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

  // ---- WA-4: drop-stale delivery (transport report §C, implemented verbatim) -----
  // The client must never process a backlog serially: under burst/stall delivery, naive
  // synchronous apply-and-draw-per-message turns a network hiccup into a multi-second
  // client-side replay (lab-proven: 982ms -> 89ms median display lag, 11x, see
  // specs/2026-07-06-ws-transport-report.md §C/§evidence). Every decoded-but-unapplied map
  // message lands in `pend[]` first; a persistent rAF loop (`drainOnce`, started in
  // connect()/open(), stopped in close()) evaluates the policy once per animation frame:
  //   - a keyframe supersedes every OLDER pending map message (rule 2) -- applied at
  //     ENQUEUE time, so a superseded delta is never even considered by drainOnce.
  //   - small backlog (<= MAX_APPLY pending): apply ALL in arrival order (deltas are
  //     cumulative -- ground truth §1.6 -- so skipping one leaves stale tiles), but this
  //     whole loop only ever calls draw() (via dwf-tiles.js's own rAF, decoupled
  //     from this one) once per frame regardless of how many messages were applied.
  //   - big backlog (> MAX_APPLY, or the arrival-cadence model estimates > MAX_BEHIND_MS
  //     of backlog): drop the WHOLE pending queue unapplied, request a fresh keyframe
  //     once (latched until the next keyframe arrives), and wait -- the bounded,
  //     always-correct resync escape hatch.
  const MAX_APPLY = 3;              // small-backlog ceiling: apply-all-in-order threshold
  const MAX_BEHIND_MS = 500;        // big-backlog ceiling: estimated queued-behind time
  let pend = [];                    // [{mode:"key"|"delta", map, wireBytes, t}], arrival order
  let droppedStale = 0;             // lifetime counter: messages dropped unapplied (rules 2+4)
  let resyncs = 0;                  // lifetime counter: reqkey escapes sent (rule 4)
  let reqkeyLatched = false;        // rule 4: don't spam reqkey while one is already in flight
  let arrivalGapEwma = 33;          // ms; seeded at the nominal 30Hz metronome cadence
  let lastArrivalTs = 0;
  let lastClientApplyMs = 0;        // most recent arrival -> applied latency sample (ms)
  // Raw (still-compressed) binary frames: only ONE inflate runs at a time; a newer raw
  // buffer arriving while an older one is still inflating supersedes it WITHOUT ever
  // spending CPU on the inflate we'd only discard (item 6: "never inflate bytes rule 4
  // will discard" -- the keyframe-supersedes-keyframe case, at the pre-decode stage).
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

  function scheduleReconnect() {
    if (!wantOpen) return;
    clearReconnect();
    // ±20% jitter (A4/§G): when N clients all reconnect after a shared event (server restart,
    // tunnel flap) an un-jittered fixed backoff makes them stampede the server with
    // simultaneous keyframe builds (N CoreSuspender spikes). Spread them out.
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.round(backoffMs * jitter);
    backoffMs = Math.min(BACKOFF_MAX, Math.round(backoffMs * 1.7));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (wantOpen && curPlayer) open(curPlayer);
    }, delay);
  }

  // ---- half-open staleness watchdog (A4) -----------------------------------------
  // A half-open socket (laptop sleep/wake, tunnel path death, edge black-hole) never delivers
  // an onclose event, so wsAlive stays true forever: HTTP polling stays suppressed and the view
  // freezes with no reconnect. The map stream is a 30 Hz metronome, so 3 s of total inbound
  // silence is hard evidence of a dead path. Forcing ws.close() here makes the browser fire
  // onclose LOCALLY -> reconnect + the host's poll fallback resume.
  let lastInboundTime = 0;      // Date.now() of the last inbound frame of ANY kind
  let watchdogTimer = null;
  const STALE_MS = 3000;
  function checkStale() {
    if (typeof document !== "undefined" && document.hidden) return; // throttled tab: don't trip
    if (isConnected() && lastInboundTime && (Date.now() - lastInboundTime) > STALE_MS) {
      try { if (ws) ws.close(); } catch (_) {}   // -> onclose -> reconnect + poll fallback
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

  // ---- perf stats (for the client F3 diag overlay) -------------------------------
  // Rolling ring of recent map messages so getStats() can report msgs/sec + avg bytes,
  // broken down keyframe vs delta. Cheap: a bounded array of {t,bytes,mode}.
  const statRing = [];
  let lastMsgTime = 0;
  function recordStat(bytes, mode) {
    const now = Date.now();
    statRing.push({ t: now, bytes: bytes | 0, mode: mode });
    while (statRing.length > 240) statRing.shift();
    lastMsgTime = now;
  }
  function estBehindMsNow() {
    // Arrival-cadence model (§C): the stream is a ~33ms metronome, so any gap beyond that,
    // multiplied by how many map messages are backed up, estimates how far behind "now" the
    // oldest pending message already is.
    return Math.max(0, (arrivalGapEwma - 33) * pend.length);
  }
  function getStats() {
    const now = Date.now(), win = 1000;
    let n = 0, b = 0, nk = 0, bk = 0, nd = 0, bd = 0;
    for (let i = statRing.length - 1; i >= 0; i--) {
      const s = statRing[i];
      if (now - s.t > win) break;
      n++; b += s.bytes;
      if (s.mode === "delta") { nd++; bd += s.bytes; } else { nk++; bk += s.bytes; }
    }
    // WA-12 item 3: on v1, drop-stale rules 1-4 are structural no-ops (v1 map data never
    // touches `pend[]`), so `estBehindMs` uses the §C "exact" formula instead of the
    // arrival-cadence model: time since the last AUX + half the best-effort RTT.
    const v1EstBehindMs = v1Mode
      ? Math.max(0, (v1LastAuxArrival ? now - v1LastAuxArrival : 0) + v1RttMs / 2)
      : estBehindMsNow();
    return {
      msgsPerSec: n, avgBytes: n ? Math.round(b / n) : 0,
      keyMsgs: nk, keyAvgBytes: nk ? Math.round(bk / nk) : 0,
      deltaMsgs: nd, deltaAvgBytes: nd ? Math.round(bd / nd) : 0,
      msSinceLast: lastMsgTime ? (now - lastMsgTime) : -1,
      // WA-4 drop-stale stats (F3 + gate consumers, transport report §C):
      pendingMaps: pend.length,
      pendingInflates: (inflightRaw ? 1 : 0) + (queuedRaw ? 1 : 0),
      droppedStale: droppedStale,
      resyncs: resyncs,
      estBehindMs: Math.round(v1EstBehindMs),
      clientApplyMs: Math.round(lastClientApplyMs),
      // WA-12/13: protocol v1 diagnostics (F3 + gate_localnav + __wa_nav consumers).
      proto: v1Mode ? "v1" : "legacy",
      rttMs: v1RttMs,
      inflightAcks: Math.max(0, v1LastSeenSeq - v1LastAckedSeq),
      worldSeq: v1KnownWorldSeq,
      blockSetBytesPerSec: v1BytesPerSec("blockset"),
      auxBytesPerSec: v1BytesPerSec("aux"),
      blockSetBytesTotal: v1BlockSetBytesTotal,
      auxBytesTotal: v1AuxBytesTotal,
      socketOpens: socketOpens,
      snapshotDone: v1SnapshotDone,
    };
  }

  // Queue a decoded map message (rule 1). A keyframe supersedes every older pending map
  // message unapplied (rule 2) -- it rebuilds the whole buffer, so anything still queued
  // ahead of it is moot; this also clears the reqkey latch (rule 4's escape hatch is
  // satisfied the instant a keyframe is next in line, whether or not it survives drainOnce).
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

  // Evaluate the drop-stale policy against the current backlog. Called once per animation
  // frame by the persistent raf loop below -- NEVER per-message -- so a burst of messages
  // arriving within one frame interval is judged as a single backlog, not N sequential
  // decisions (that coalescing is what makes rules 3/4 meaningful).
  function drainOnce() {
    if (pend.length === 0) return;
    if (pend.length > MAX_APPLY || estBehindMsNow() > MAX_BEHIND_MS) {
      // Rule 4: big backlog -- drop everything unapplied, latch one reqkey, wait.
      droppedStale += pend.length;
      pend = [];
      if (!reqkeyLatched) {
        reqkeyLatched = true;
        resyncs++;
        requestKeyframe();
      }
      return;
    }
    // Rule 3: small backlog -- apply ALL pending in arrival order (cheap array writes;
    // correctness preserved because deltas are cumulative). Each apply is a synchronous
    // call into the render client's onMessage, which itself no longer draws synchronously
    // (WA-4 item 5) -- so this loop draws at most once per frame no matter the batch size.
    const batch = pend;
    pend = [];
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      lastClientApplyMs = Math.max(0, _now() - item.t);
      if (item.mode === "key") reqkeyLatched = false;
      deliver({ mode: item.mode, map: item.map });
    }
  }

  function rafTick() {
    if (!_rafActive) return;
    try { drainOnce(); } catch (_) { /* the drain loop must never die */ }
    _rafHandle = _requestFrame(rafTick);
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

  // Route a decoded text message. Map pushes arrive as {"type":"map","mode":"key"|"delta",
  // "map":{...}} (delta transport); older enveloped or bare objects are treated as keyframes.
  // The render client receives {mode, map} and applies it into its persistent tile buffer.
  // `wireBytes` (optional) is the ACTUAL bytes-on-the-wire for the stats overlay: for a
  // binary frame that's the compressed size, not text.length (the inflated size), so F3
  // reports the real tunnel cost. Defaults to text.length for uncompressed text frames.
  function handleText(text, wireBytes) {
    const wb = (typeof wireBytes === "number") ? wireBytes : text.length;
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      return; // ignore non-JSON control noise
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "map") {
      const obj = (msg.map && typeof msg.map === "object") ? msg.map : msg;
      const mode = (msg.mode === "delta") ? "delta" : "key";
      recordStat(wb, mode);
      enqueueMapMsg(mode, obj, wb);   // WA-4: queued, not delivered synchronously (§C)
      return;
    }
    // Smooth sub-tile cursor push ({"type":"cursors","players":[{name,x,y,z,fx,fy,drag?}]}).
    // Tiny + high-rate (~25/s); routed to the render client via setCursorHandler. Cursors
    // are ALWAYS applied in arrival order, independent of map coalescing (§C rule 7) --
    // they never touch pend[].
    if (msg.type === "cursors" && Array.isArray(msg.players)) {
      if (onCursorsCb) {
        try { onCursorsCb(msg.players); } catch (_) { /* render error must not kill socket */ }
      }
      return;
    }
    // WP-B pause arbiter broadcasts: {"type":"pause",...} (who paused + reason) and
    // {"type":"busy",...} (saving / world-busy indicator). Routed to the self-contained
    // dwf-pause.js consumer; inert if that module isn't loaded (old-client tolerance).
    if (msg.type === "pause") {
      try { if (window.DwfPause) window.DwfPause.onPause(msg); } catch (_) {}
      return;
    }
    if (msg.type === "busy") {
      try { if (window.DwfPause) window.DwfPause.onBusy(msg); } catch (_) {}
      return;
    }
    // WP-D multiplayer chat: {"type":"chat","seq":N,"from"|"system","text","ts"} live relay.
    // Routed to the self-contained dwf-chat.js consumer; inert if that module isn't loaded
    // (old-client tolerance, same posture as pause/busy above).
    if (msg.type === "chat") {
      try { if (window.DwfChat) window.DwfChat.onChat(msg); } catch (_) {}
      return;
    }
    if (msg.type === "chat_rejected") {
      try { if (window.DwfChat && typeof DwfChat.onRejected === "function") DwfChat.onRejected(msg); } catch (_) {}
      return;
    }
    // WT14 fortress vote: {"type":"vote",seq,active,lastResult,detection} state pushes (vote
    // open / cast / close + late-join sync). Routed to the self-contained dwf-vote.js
    // consumer; inert if that module isn't loaded. An old server never emits this type, so the
    // vote module's feature detection rides entirely on this frame's existence.
    if (msg.type === "vote") {
      try { if (window.DwfVote) window.DwfVote.onVote(msg); } catch (_) {}
      return;
    }
    // WT28/B218 native popup mirror: {"type":"popup",seq,blocked,popups:[...]} state pushes
    // (native modal opened / dismissed + sticky late-join sync). Routed to the self-contained
    // dwf-popup.js consumer; inert if that module isn't loaded (old-client tolerance,
    // same posture as pause/vote above).
    if (msg.type === "popup") {
      try { if (window.DwfPopup) window.DwfPopup.onPopup(msg); } catch (_) {}
      return;
    }
    // B238 burrow change poke: {"type":"burrows","seq":N} -- a burrow was created/painted/erased/
    // deleted by SOMEBODY (possibly another player). Not state: each player's burrow rects are built
    // for their own camera z, so the frame only says "your burrow snapshot is behind" and the burrow
    // panel refetches its own /burrows. Routed to the burrow panel's sync hook (controls-placement);
    // inert if that module isn't loaded, and an old server simply never emits the type.
    if (msg.type === "burrows") {
      try { if (window.DFBurrowSync) window.DFBurrowSync.onBurrows(msg); } catch (_) {}
      return;
    }
    // B225 petitions/diplomacy detector + meeting mirror: {"type":"diplo",seq,
    // petitionsPending,meetingsQueued,open,meeting} state pushes (change-only + sticky
    // late-join sync). Routed to the self-contained dwf-diplo.js consumer; inert if
    // that module isn't loaded (old-client tolerance, same posture as pause/vote/popup above).
    if (msg.type === "diplo") {
      try { if (window.DwfDiplo) window.DwfDiplo.onDiplo(msg); } catch (_) {}
      return;
    }
    // Tolerant fallback: a bare mapdata object (no envelope) -> keyframe.
    if (msg.type === undefined && Array.isArray(msg.tiles) && msg.origin) {
      recordStat(wb, "key");
      enqueueMapMsg("key", msg, wb);
      return;
    }
    // ---- WA-12 protocol v1 text control messages (§0.5) -- only ever sent on a v1 session; a
    // legacy server never emits these types, so these branches are simply unreached there. ----
    if (msg.type === "hello_ack") {
      clearHelloTimeout(); // handshake succeeded -- cancel the auto-fallback watchdog
      lastIsHost = msg.isHost === true;
      try { if (window.DwfDigest && typeof DwfDigest.onJoinComplete === "function") DwfDigest.onJoinComplete({ player: msg.player || curPlayer }); } catch (_) {}
      // VERSION-MISMATCH GATE: hello_ack carries the server build stamp; re-check against the
      // client's baked stamp (also checked on boot via /version). A stale tab after a redeploy
      // gets the blocking refresh banner here even if it never re-hit /version.
      if (msg.build && window.DwfJoin && typeof DwfJoin.checkVersion === "function") {
        try { DwfJoin.checkVersion(msg.build, msg.assets); } catch (_) {}
      }
      if (onHelloAckCb) { try { onHelloAckCb(msg); } catch (_) { /* host callback is best-effort */ } }
      return;
    }
    // JOIN SECURITY: the server rejected our hello token (no/stale credential). Stop the
    // reconnect churn and hand off to the join module to re-collect the passphrase.
    if (msg.type === "auth_fail") {
      wantOpen = false;            // don't auto-reconnect into another rejection
      clearReconnect();
      try { if (window.DwfAuth && typeof DwfAuth.onAuthFail === "function") DwfAuth.onAuthFail(); } catch (_) {}
      return;
    }
    if (msg.type === "snapshot_meta") {
      if (msg.trickle === "end") v1SnapshotDone = true;
      return; // diagnostic only in this wave; no client action required (WA-11 is server-side)
    }
    if (msg.type === "ping") {
      // App-level ping/pong (§0.4/§0.5, WA-10) -- distinct from the WS protocol-level ping
      // WA-3 already answers automatically at the browser level. Reply immediately so the
      // server's rtt/clock-offset math (its own /diag concern) sees a prompt echo; the CLIENT's
      // own rttMs (F3) is a best-effort estimate from this same round trip (see below).
      v1PingSentAt = _now();
      send({ type: "pong", ts: msg.ts, tc: Date.now() });
      return;
    }
    // Other control types (presence/chat/atlas, future work) are ignored here.
  }

  // Best-effort client-visible RTT estimate (F3 diagnostic only -- the server computes the
  // authoritative rtt from ACK timestamps for /diag, §0.6). Approximated as the gap between
  // answering the server's last app-level ping and the next sequenced frame's arrival, EWMA'd;
  // this is a rough "how responsive does the link feel right now" signal, not a precise RTT.
  function v1NoteRttSample(nowMs) {
    if (!v1PingSentAt) return;
    const sample = nowMs - v1PingSentAt;
    v1PingSentAt = 0;
    if (sample > 0 && sample < 30000) v1RttMs = v1RttMs ? Math.round(v1RttMs * 0.7 + sample * 0.3) : Math.round(sample);
  }

  // Binary frames carry a DEFLATE-compressed map envelope (the exact JSON text the server
  // would otherwise send) -- and per the server's compression rule, ONLY keyframes are ever
  // compressed (deltas ship as plain text), so every binary frame here is a keyframe
  // candidate. The per-tile JSON is ~30x compressible, so this is what keeps a full keyframe
  // small enough to cross the tunnel instantly instead of backing up. We inflate with the
  // browser-native DecompressionStream('deflate') (matches zlib/RFC1950), then hand the text
  // to the SAME handleText path -- so binary and text frames are identical downstream.
  //
  // WA-4 item 6 (inflate discipline): only ONE inflate runs at a time. If a newer raw buffer
  // arrives while an older one is still inflating, the newer one supersedes it (keyframe
  // supersedes keyframe, same as rule 2, applied one stage earlier) -- the superseded raw
  // bytes are NEVER inflated, so a burst of keyframes never wastes CPU decompressing ones
  // we'd only throw away.
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
      .catch(() => { /* a corrupt frame must not wedge the chain */ })
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
      // started (item 6) -- drop the previously-queued one unapplied, never inflate it.
      if (queuedRaw) droppedStale++;
      queuedRaw = arrayBuffer;
      return;
    }
    startInflate(arrayBuffer);
  }

  // ---- WA-12: protocol v1 binary frame routing (§0.2/§0.3/§0.5) -------------------------
  // Every binary frame on a v1 session is a 10-byte header + payload (§0.2) -- NEVER the
  // legacy deflated-JSON-keyframe shape handleBinary() above decodes. The two are mutually
  // exclusive per connection (a session is either legacy or v1, decided at HELLO time), so
  // sock.onmessage picks exactly one of these two binary paths for its whole lifetime.
  async function inflateRaw(arrayBuffer) {
    const ds = new DecompressionStream("deflate");
    const stream = new Response(arrayBuffer).body.pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }
  let v1KnownWorldSeq = 0; // highest world_seq observed from a BLOCK_SET header peek (see below)
  function v1Deliver(payloadBuffer, type, wireBytes) {
    if (type === 0x01 /* BLOCK_SET */) {
      v1RecordBytes(wireBytes, "blockset");
      // Peek world_seq (payload's first 4 LE bytes, §0.3) BEFORE handing the buffer to the
      // cache -- ingestBlocks() may TRANSFER it to a worker (detaching it on this side).
      try {
        const dv = new DataView(payloadBuffer);
        const seq = dv.getUint32(0, true);
        if (seq > v1KnownWorldSeq) v1KnownWorldSeq = seq;
      } catch (_) { /* too short / malformed -- ingestBlocks below will no-op safely */ }
      try {
        if (window.DwfCache && typeof DwfCache.ingestBlocks === "function") {
          DwfCache.ingestBlocks(payloadBuffer);
        }
      } catch (_) { /* a bad/short frame must never kill the socket */ }
      return;
    }
    if (type === 0x02 /* AUX */) {
      v1RecordBytes(wireBytes, "aux");
      v1LastAuxArrival = Date.now();
      let obj = null;
      try { obj = JSON.parse(new TextDecoder("utf-8").decode(payloadBuffer)); } catch (_) { obj = null; }
      // Phase-5 Settings Info consumes this optional, read-only AUX value. Delete it when an
      // older host omits the field so reconnecting to one restores the honest fallback.
      try {
        window.DwfSessionInfo = window.DwfSessionInfo || {};
        const autosave = obj && obj.env && typeof obj.env.autosave === "string" ? obj.env.autosave : null;
        if (autosave !== null) window.DwfSessionInfo.autosave = autosave;
        else delete window.DwfSessionInfo.autosave;
      } catch (_) { /* Settings is optional; AUX delivery must remain unaffected. */ }
      if (obj && onAuxCb) { try { onAuxCb(obj); } catch (_) { /* render error must not kill socket */ } }
      return;
    }
    // WC-1/WC-3 (RECONCILE-R2): ITEMDEF_DICT -- sent once per connection (world epoch), a
    // one-shot dictionary, not part of the ack-tracked BLOCK_SET/AUX ordering. Decoded via
    // the shared reference decoder (dwf-wire-v1.js) so the byte layout lives in exactly
    // one place, same as every other kind on this wire.
    if (type === 0x03 /* ITEMDEF_DICT */) {
      try {
        const W = window.DwfWireV1;
        if (W && typeof W.decodeItemDefDict === "function" && onItemDefDictCb) {
          onItemDefDictCb(W.decodeItemDefDict(new Uint8Array(payloadBuffer)));
        }
      } catch (_) { /* a bad/short dict frame must never kill the socket */ }
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
    // §0.2/§0.4: ACK EVERY binary frame immediately on arrival, BEFORE inflate/decode -- the
    // ack measures the network, not client-side processing time (WA-10's pacing window is
    // clocked off this).
    v1LastAckedSeq = header.seq;
    send({ type: "ack", seq: header.seq, t: Date.now() });
    const wireBytes = arrayBuffer.byteLength;
    // Slice the payload into its OWN ArrayBuffer (cheap local copy) rather than a view over
    // the shared frame buffer -- BLOCK_SET payloads get TRANSFERRED to the cache worker
    // (WebGL ASSUMES-8), which requires a buffer nobody else holds a reference into.
    const payloadSlice = arrayBuffer.slice(header.payloadOffset);
    if (header.deflated) {
      if (!_hasDS) return; // no native inflate (ancient browser) -- drop; v1 is opt-in anyway
      inflateRaw(payloadSlice)
        .then((buf) => v1Deliver(buf, header.type, wireBytes))
        .catch(() => { /* a corrupt deflate stream must not wedge the chain */ });
    } else {
      v1Deliver(payloadSlice, header.type, wireBytes);
    }
  }

  // WA-6 (world cache module + worker ingest, transport report §C companion): every map
  // message that SURVIVES the drop-stale policy above gets posted into the persistent world
  // cache here -- "policy order: drop-check -> worker post" (WA-6 acceptance). The cache runs
  // SHADOW-ONLY in this wave (nothing reads it yet; WA-7 rewires dwf-tiles.js to draw
  // from it) so a missing DwfCache global or an ingest failure must never perturb this
  // callback's real job of feeding the render client -- hence the standalone try/catch BEFORE
  // onMessageCb, not folded into its own guard.
  function deliver(mapData) {
    try {
      if (window.DwfCache && typeof DwfCache.ingest === "function" && mapData && mapData.map) {
        DwfCache.ingest(mapData.map);
      }
    } catch (_) { /* shadow cache: never affect the render callback */ }
    if (!onMessageCb) return;
    try {
      onMessageCb(mapData);
    } catch (_) {
      // A render error must never kill the socket.
    }
  }

  function open(player) {
    // A fresh socket means fresh server-side state (the server re-seeds a keyframe on
    // connect -- A6): any content still sitting in the drop-stale queue from the OLD
    // connection is now moot, and an in-flight inflate would only decode bytes that
    // belong to a stream we've already abandoned. Drop it all unconditionally (not
    // counted in the lifetime droppedStale total -- this is a connection boundary, not
    // a policy drop).
    pend = [];
    inflightRaw = null;
    queuedRaw = null;
    reqkeyLatched = false;
    lastArrivalTs = 0;
    clearHelloTimeout();
    // Tear down any prior socket before opening a new one.
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; } catch (_) {}
      try { ws.close(); } catch (_) {}
      ws = null;
    }

    let sock;
    try {
      sock = new WebSocket(wsUrl(player));
    } catch (_) {
      // Construction itself can throw (bad URL, blocked). Treat as a drop.
      scheduleReconnect();
      notifyClose("ws construct failed");
      return;
    }
    sock.binaryType = "arraybuffer";
    ws = sock;
    socketOpens++;   // WA-13: lifetime real-socket-construction count (localnav's "reconnects")

    sock.onopen = () => {
      backoffMs = BACKOFF_MIN; // reset backoff on a good connection
      if (v1Mode) {
        // §0.1: a v1 connection MUST send hello as its first message (5s server deadline).
        // `have` = the highest world_seq this client's cache already holds -- 0 (or a value
        // outside the server's ~30s changelog ring) triggers a full snapshot; otherwise the
        // server answers with just what changed since (§0.6 resume) -- this is what makes a
        // WS drop+reconnect cost one dirty-set instead of re-downloading the whole cache.
        let have = 0;
        try {
          if (window.DwfCache && typeof DwfCache.stats === "function") {
            const s = DwfCache.stats();
            if (typeof s.worldSeq === "number") have = s.worldSeq;
          }
        } catch (_) { /* have=0 -- worst case is a fresh snapshot, never incorrect */ }
        const cam = initialCam || { x: 0, y: 0, z: 0 };
        // JOIN SECURITY: the shared passphrase (from the join screen). When the host set no
        // passphrase this is "" and the server ignores it; when set, the server rejects a hello
        // whose token doesn't match (auth_fail -> close). Same secret the browser also holds in
        // the dfcap_auth cookie for HTTP -- one shared credential, two transports.
        var joinToken = "";
        try { if (window.DwfAuth && typeof DwfAuth.token === "function") joinToken = DwfAuth.token() || ""; } catch (_) {}
        send({
          // B09(a): `id` is a stable per-tab token so the server can tell a page-refresh's own
          // ghost (same id -> keep name) from a real duplicate on the same invite link (different
          // id -> renamed to name-2). hello_ack.player returns the authoritative deduped name.
          type: "hello", proto: 1, caps: ["auxd"], player: player, id: curClientId || "", have: have,
          token: joinToken,
          cam: { x: cam.x, y: cam.y, z: cam.z, w: curW || 1, h: curH || 1 },
        });
        // Auto-fallback (the seam pattern used everywhere else in this wave -- WA-7's
        // ?cachedraw=0, the render seam's canvas2d/gl selection): a v1 session that never
        // gets a hello_ack within the server's own 5s HELLO deadline (§0.1) is a v1 FAILURE
        // (server doesn't speak v1 / a proxy ate the frame / a bug) -- permanently drop back
        // to the legacy wire for the rest of this page session rather than sitting mute
        // forever. Flipping v1Mode false here means the NEXT open() (this reconnect) builds
        // a legacy wsUrl and skips the hello-send above -- a normal legacy connection.
        clearHelloTimeout();
        helloTimeoutTimer = setTimeout(() => {
          helloTimeoutTimer = null;
          if (v1Mode) { v1Mode = false; try { ws && ws.close(); } catch (_) {} }
        }, 5000);
      }
    };

    sock.onmessage = (ev) => {
      try {
        lastInboundTime = Date.now();   // WA-3 watchdog: any frame proves the path is alive
        if (typeof ev.data === "string") {
          handleText(ev.data);
        } else if (ev.data instanceof ArrayBuffer) {
          if (v1Mode) handleBinaryV1(ev.data); else handleBinary(ev.data);
        }
      } catch (_) {
        // never throw out of the socket handler
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
    if (onCloseCb) {
      try { onCloseCb(reason); } catch (_) { /* host fallback is best-effort */ }
    }
  }

  // ---- public API ----------------------------------------------------------------
  // opts (WA-12/13, all optional): {proto1: bool, onAux(auxObj), onHelloAck(helloAckObj),
  // initialCam:{x,y,z}}. `onMessage` (legacy per-player map push) is unused on a v1 session --
  // v1 map data goes straight into DwfCache via handleBinaryV1/v1Deliver above, never
  // through this callback -- so a caller may pass a no-op there when opts.proto1 is true.
  function connect(player, onMessage, onClose, dims, opts) {
    curPlayer = player;
    onMessageCb = (typeof onMessage === "function") ? onMessage : null;
    onCloseCb = (typeof onClose === "function") ? onClose : null;
    if (dims && dims.w > 0 && dims.h > 0) { curW = dims.w | 0; curH = dims.h | 0; }
    v1Mode = !!(opts && opts.proto1);
    onAuxCb = (opts && typeof opts.onAux === "function") ? opts.onAux : null;
    onHelloAckCb = (opts && typeof opts.onHelloAck === "function") ? opts.onHelloAck : null;
    if (opts && typeof opts.clientId === "string") curClientId = opts.clientId;   // B09(a)
    onItemDefDictCb = (opts && typeof opts.onItemDefDict === "function") ? opts.onItemDefDict : null;
    initialCam = (opts && opts.initialCam) ? opts.initialCam : null;
    wantOpen = true;
    lastCloseNotified = false;
    backoffMs = BACKOFF_MIN;
    lastInboundTime = Date.now();   // grace period before the watchdog can trip
    startWatchdog();
    startRafLoop();   // WA-4: the drop-stale drain runs for the lifetime of the connection (legacy-only work in v1 mode -- see the top-of-file note)
    open(player);
  }

  // Update the desired tile-window dims (call on canvas resize / zoom).
  // Reopening the socket on every dim change used to cause a RECONNECT STORM (pre-WA-13):
  // rendering the map toggles a page scrollbar, which flips window.innerHeight by ~1-2
  // tiles, which changed the requested dims, which reopened the socket, which re-sent a
  // keyframe, which re-rendered... forever. Fix: DEADBAND small jitter (<3 tiles) and
  // DEBOUNCE the settle so only a real, settled resize triggers anything.
  //
  // WA-13 item 1 (WA-15: the only behavior left -- the legacy reconnect-on-resize branch
  // this used to fall back to is gone): the settled action is a `{"type":"cam"}` message
  // over the EXISTING socket, never a reconnect (§0.4 -- dims/zoom are authoritative for the
  // interest window; hello's cam re-syncs a fresh connection). This is the "zero reconnects
  // on zoom" headline: zoom/resize NEVER reopens the socket, full stop.
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

  // B263: the ZOOM path's dims send — IMMEDIATE, no debounce, no deadband. The 350ms debounce
  // above exists for RESIZE jitter (scrollbar oscillation); routing zoom through it opened a
  // >=350ms window where the server had already applied the zoom's /camera center-shift but
  // still clipped AUX to the OLD (smaller) dims — every building in the abandoned right/bottom
  // band got rm'd and visibly blinked out of the client's (already-grown) view until the
  // debounced cam landed and the server re-upped them. A zoom step is a deliberate, discrete
  // gesture: send the new interest dims on the same tick, BEFORE core's next-rAF /camera POST
  // can move the window's position, so the server's interim window only ever GROWS (a superset
  // clips nothing that was visible). Cancels any pending debounced send so a stale-dims echo
  // can never fire afterwards. Same-dims calls are a no-op (clamped zoom steps at the caps).
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
    } catch (_) {
      return false;
    }
    try {
      ws.send(text);
      return true;
    } catch (_) {
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
      try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; } catch (_) {}
      try { ws.close(); } catch (_) {}
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

  // isHostClient() hook (WD-27 follow-up): true iff the most recent hello_ack marked this
  // connection as the host (server-side loopback-peer check, websocket.cpp). false before the
  // first hello_ack arrives (fail-closed -- never defaults to "host").
  function isHost() {
    return lastIsHost;
  }

  function isConnected() {
    return !!ws && ws.readyState === 1;
  }

  // Ask the host for a fresh KEYFRAME (full window). The render client calls this when it
  // detects a desync -- a delta arrived for a window it has no matching buffer for -- so it
  // never leaves stale tiles. Best-effort: silently no-ops if the socket is down.
  function requestKeyframe() {
    return send({ type: "reqkey" });
  }

  // Register (or clear) the smooth-cursor push handler. Called by the render client after
  // connect(); receives the raw players[] array on every {"type":"cursors"} frame.
  function setCursorHandler(fn) {
    onCursorsCb = (typeof fn === "function") ? fn : null;
  }

  const api = { connect, send, close, isConnected, updateDims, updateDimsNow, setCursorHandler,
                requestKeyframe, getStats, isHost };
  try { window.DwfWS = api; } catch (_) { /* non-browser context */ }

  // On tab re-foreground: the watchdog is paused while hidden, and a throttled tab may have
  // missed the death of its socket -- so check staleness immediately (closing a dead socket
  // resumes reconnect + the host's poll path, which already polls whenever !wsAlive).
  try {
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) checkStale();
      });
    }
  } catch (_) { /* non-browser context */ }

  // ---- documented integration hook (no edits to dwf-tiles.js in this task) --
  // The render client wires WS push -> its existing draw path like so (see
  // docs/superpowers/analysis/websocket-integration.md for the exact diff):
  //
  //   if (window.DwfWS) {
  //     let wsAlive = false;
  //     DwfWS.connect(player,
  //       (map) => {                       // push: feed the SAME render path as polling
  //         wsAlive = true;
  //         if (isValidMapData(map)) { latest = map; connected = true; draw(); }
  //       },
  //       () => { wsAlive = false; });     // drop: HTTP poll keeps running as fallback
  //     // In pollLoop(), skip the fetch while wsAlive so we don't double-load.
  //   }
  //
  // Because connect() auto-reconnects and onClose() flips wsAlive false, the poll
  // fallback resumes automatically whenever the socket is down, and yields back to
  // push the moment it recovers -- the client is never blank and never double-fetches.
})();
