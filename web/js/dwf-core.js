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

  const params = new URLSearchParams(location.search);
  // Camera snap-back back-compat (2026-07-17): the canonical player identity is the RAW display
  // name ("Your Friend"), percent-encoded ONLY on the URL wire. A prior server bug (req_player not
  // decoding the /ws param) could round-trip a spacey/`&`/unicode name back through hello_ack in its
  // once-encoded form ("Your%20Friend"), and if any of that ever reached localStorage it would keep
  // re-encoding forever. Normalize on read: a stored value that still looks percent-encoded is decoded
  // back to raw exactly once. A genuine raw name (no %XX escape) is returned untouched.
  function normalizeStoredName(v) {
    if (typeof v !== "string" || !v) return v;
    if (!/%[0-9A-Fa-f]{2}/.test(v)) return v;   // no escape sequence -> already raw
    try { return decodeURIComponent(v); } catch (_) { return v; }
  }
  const stored = normalizeStoredName(localStorage.getItem("dwf.player"));
  const fresh = (crypto.randomUUID ? crypto.randomUUID() :
    `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`);
  // B09(a): `player` is the GLOBAL player key every non-IIFE panel (fort-admin, building/zone/
  // stockpile, labor, squads, ...) uses for its HTTP ?player=. It is `let` (not const) because
  // the server may DEDUP a colliding name at WS hello and hand back the authoritative name in
  // hello_ack.player; window.__dwfAdoptName (called from the tile client's hello_ack
  // handler) rebinds it so every subsequent HTTP request keys on the deduped name -- stopping
  // two same-named browsers from sharing one server-side camera/delta baseline. We persist the
  // ORIGINAL name (not the deduped one) so a fresh page still asks for its real name and re-derives
  // the dedup from scratch.
  // The owner 07-09: the join screen's chosen name (persisted in localStorage) OUTRANKS the ?player=
  // URL appendage -- a shared join link often carries someone else's name. The URL param now
  // only seeds first-visit names (no stored name yet). tiles.html (the sweep page) keeps
  // url-first resolution -- the harness depends on per-tab ?player=.
  //
  // Do NOT persist the fresh fallback: core loads before the join gate, so doing so turned a
  // first-visit UUID into the apparent player name for this whole page. join.js owns persistence
  // after a person has chosen a real display name; the fallback is in-memory only.
  let player = stored || params.get("player") || fresh;
  // Expose the CURRENT (possibly server-deduped) player name globally so self-contained modules
  // that aren't inside this IIFE -- WP-D chat's "(you)" marker, hospital-panel's ?player= -- read
  // one authoritative value instead of re-deriving it. Updated on dedup below.
  window.playerName = player;
  window.__dwfAdoptName = function (name) {
    if (typeof name === "string" && name && name !== player) { player = name; window.playerName = name; }
  };

  const view = document.getElementById("view");
  const zoneOverlay = document.getElementById("zoneOverlay");
  const selection = document.getElementById("selection");
  const clientPanel = document.getElementById("clientPanel");
  const tileFlash = document.getElementById("tileFlash");
  // WT07 M7/M8 content-wrapper seam. #clientPanel and #selection get a PERSISTENT framework header
  // + a `.pf-content` child; every writer that used to do `host.innerHTML = ...` now targets
  // panelContent(host) so the movable/resizable header survives a wholesale re-render. This helper
  // is the ONE shared indirection all writer modules call (shared classic-script scope). It degrades
  // to the bare host when the framework is absent (old cached page) -- identical to pre-WT07.
  function panelContent(host) {
    return (typeof window !== "undefined" && window.DFPanelFrame && window.DFPanelFrame.contentEl)
      ? window.DFPanelFrame.contentEl(host) : host;
  }
  const hudEls = {
    fortName: document.getElementById("fortName"),
    siteName: document.getElementById("siteName"),
    rankName: document.getElementById("rankName"),
    population: document.getElementById("population"),
    food: document.getElementById("food"),
    drink: document.getElementById("drink"),
    seeds: document.getElementById("seeds"),
    meat: document.getElementById("meat"),
    fish: document.getElementById("fish"),
    moon: document.getElementById("moon"),
    dateDay: document.getElementById("dateDay"),
    dateMonth: document.getElementById("dateMonth"),
    dateSeason: document.getElementById("dateSeason"),
    dateYear: document.getElementById("dateYear"),
    minimap: document.getElementById("minimapGrid"),
    elevation: document.getElementById("elevation")
  };
  const alertStack = document.getElementById("alertStack");
  const alertPopup = document.getElementById("alertPopup");

  // B21: DF-style search matching, shared by EVERY search box (work orders, workshop tasks,
  // structures, stockpile items, creatures, kitchen...). DF's filter is case-insensitive and
  // TOKEN-based over the FULL display string (material prefix included): a row matches iff every
  // whitespace-separated query token appears somewhere in the row text, in any order. So "iron
  // cage" matches "Forge iron cage" and so does "cage iron" -- unlike a naive substring which
  // fails on word order. Empty query matches everything.
  function dfTokenMatch(haystack, query) {
    const h = String(haystack == null ? "" : haystack).toLowerCase();
    const q = String(query == null ? "" : query).trim().toLowerCase();
    if (!q) return true;
    const tokens = q.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] && h.indexOf(tokens[i]) === -1) return false;
    }
    return true;
  }
  window.dfTokenMatch = dfTokenMatch;
  let currentHud = null;
  let notificationState = { alerts: [], recent: [] };
  let currentZones = [];
  let zoneSnapshotCamera = null;
  let zoneSnapshotViewport = null;
  let zoneOverlayEnabled = false;
  // Default ON in the tile-renderer client. The old JPEG path could stream the SERVER-painted
  // DF selection back inside the frame, so instant (browser-drawn) preview was optional. Now the
  // map is the /mapdata tile canvas, which carries no server-painted cursor/selection layer, so
  // the browser-side preview (drawDragPreview on #zoneOverlay) is the ONLY visible drag preview.
  // It draws in exact grid-tile space now (imagePixelClamped returns tile indices, cell size from
  // the live mapdata window), so the old sub-pixel drift that motivated defaulting OFF is gone.
  let instantDesignate = true;
  try { const v = localStorage.getItem("dfplex.instantDesignate"); if (v !== null) instantDesignate = v === "1"; } catch (_) {}
  // Live drag selection rectangle in GRID-TILE space (ax/ay/bx/by are tile indices), or null.
  // Drawn on #zoneOverlay by drawDragPreview().
  let dragPreview = null;
  // World-addressed multi-z designation rectangle, so it survives z moves/pans.
  let stairRangePreview = null;
  // Live building-placement footprint in GRID-TILE space ({gx,gy,w,h} centered on the
  // cursor), or null. The tile canvas carries no server-painted placement preview, so
  // drawBuildPreview() renders it browser-side on #zoneOverlay (green=looks placeable,
  // red=covered tile is a wall/hidden/liquid). Set by the build-tool hover in placement.js.
  let buildPreview = null;

  // --- Predictive camera panning ----------------------------------------------------------
  // The map is server-rendered, so a pan key normally waits a full round-trip before the frame
  // moves. To hide that, translate the CURRENT frame immediately in the pan direction, then let
  // it reconcile: every frame carries the camera it was rendered at (X-Dwf-Camera header),
  // so we shift the displayed frame by (frameCam - predictedCam) tiles. As real frames catch up,
  // the shift decays to 0 with no snap -- the shifted old frame and the caught-up new frame show
  // identical content at the same place. Off (or offset 0) => behaves exactly as before.
  // Default OFF: predictive pan shifts the displayed image ahead of the server via a CSS
  // transform, but over a laggy tunnel the reconcile lags, so the image the player SEES ends
  // up offset from where clicks/drag-selection map -> "selection is off from cursor" and digs
  // landing on the wrong tiles. With the MJPEG input-kick a pan already gets a near-instant
  // pushed frame, so we don't need prediction to hide latency. Opt back in via localStorage.
  let predictivePan = false;
  try { const v = localStorage.getItem("dfplex.predictivePan"); predictivePan = (v === null) ? false : (v === "1"); } catch (_) {}
  // PORTRAITS-ROOT (B128): default ON. The old default-off ("crash-prone" era) predates the
  // SEH fault guards, the per-unit/global fault caps, and the server-side portrait sweep that
  // pre-bakes every unit's native bust -- and it silently reduced EVERY portrait fix to letter
  // glyphs for any player who never found the "Unit images" toggle (the "still all just
  // letters"). The toggle stays as an explicit opt-out ("0"); any other stored value opts in.
  let unitImagesEnabled = true;
  try { unitImagesEnabled = localStorage.getItem("dfplex.unitImages") !== "0"; } catch (_) {}
  let predictedCam = null;          // where the camera "should" be from local input {x,y,z}
  let frameCam = null;              // camera the currently shown frame was rendered at {x,y,z}
  let prevFrameCam = null;
  let panStalled = 0;               // consecutive frames where frameCam didn't change
  let lastPanInputAt = 0;
  const panOffset = { x: 0, y: 0 }; // px the #view is currently translated by
  const PAN_CAP_TILES = 16;         // bound the lead so a desync can't slide the frame far off

  // The view's true (untransformed) client rect: subtract the predictive translate so all the
  // tile math stays locked to the real camera position regardless of the visual shift.
  function viewClientRect() {
    const r = view.getBoundingClientRect();
    return { left: r.left - panOffset.x, top: r.top - panOffset.y, width: r.width, height: r.height };
  }
  function setPanOffset(x, y) {
    if (x === panOffset.x && y === panOffset.y) return;
    panOffset.x = x; panOffset.y = y;
    view.style.transform = (x || y) ? `translate3d(${x}px, ${y}px, 0)` : "";
  }
  function clearPanPrediction() { setPanOffset(0, 0); }
  function resetPanPrediction() { predictedCam = null; prevFrameCam = null; panStalled = 0; clearPanPrediction(); }
  function clampPredicted() {
    if (!predictedCam) return;
    const map = currentHud && currentHud.map, vp = currentHud && currentHud.viewport;
    if (map && vp) {
      predictedCam.x = Math.max(0, Math.min(predictedCam.x, Math.max(0, (Number(map.w) || 0) - (Number(vp.w) || 0))));
      predictedCam.y = Math.max(0, Math.min(predictedCam.y, Math.max(0, (Number(map.h) || 0) - (Number(vp.h) || 0))));
    }
  }
  function applyPanPrediction() {
    if (!predictivePan || !predictedCam || !frameCam || frameCam.z !== predictedCam.z) { clearPanPrediction(); return; }
    const vp = currentHud && currentHud.viewport;
    const nw = view.naturalWidth, nh = view.naturalHeight;
    if (!vp || !nw || !nh) { clearPanPrediction(); return; }
    const rect = viewClientRect();
    const scale = Math.min(rect.width / nw, rect.height / nh);
    const tileW = (nw * scale) / Math.max(1, Number(vp.w) || 1);
    const tileH = (nh * scale) / Math.max(1, Number(vp.h) || 1);
    let dxT = predictedCam.x - frameCam.x;
    let dyT = predictedCam.y - frameCam.y;
    dxT = Math.max(-PAN_CAP_TILES, Math.min(PAN_CAP_TILES, dxT));
    dyT = Math.max(-PAN_CAP_TILES, Math.min(PAN_CAP_TILES, dyT));
    setPanOffset(-dxT * tileW, -dyT * tileH);
  }
  // Called the instant a pan key is pressed: advance the predicted camera and shift immediately.
  function notePanInput(dx, dy, dz) {
    if (!predictedCam) return;       // wait for the first frame to seed predictedCam
    predictedCam.x += dx; predictedCam.y += dy; predictedCam.z += dz;
    clampPredicted();
    lastPanInputAt = performance.now();
    applyPanPrediction();
  }
  function parseFrameCamera(headerVal) {
    if (!headerVal) return null;
    const parts = String(headerVal).split(",");
    if (parts.length < 3) return null;
    const x = Number(parts[0]), y = Number(parts[1]), z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x, y, z };
  }
  // Reconcile predicted vs the just-arrived frame camera. Adopt truth on a teleport (large jump)
  // or when we're idle and the server has clearly stalled at a different spot (a dropped move);
  // otherwise let the natural per-frame decay handle normal catch-up.
  function reconcilePredicted(fc) {
    if (!fc) return;
    if (!predictedCam) { predictedCam = { x: fc.x, y: fc.y, z: fc.z }; prevFrameCam = { x: fc.x, y: fc.y, z: fc.z }; return; }
    const dx = predictedCam.x - fc.x, dy = predictedCam.y - fc.y;
    const idle = (performance.now() - lastPanInputAt) > 250;
    const teleport = (predictedCam.z !== fc.z && idle)
                     || Math.abs(dx) > 3 * PAN_CAP_TILES || Math.abs(dy) > 3 * PAN_CAP_TILES;
    if (prevFrameCam && fc.x === prevFrameCam.x && fc.y === prevFrameCam.y && fc.z === prevFrameCam.z) panStalled++;
    else panStalled = 0;
    if (teleport || (idle && panStalled >= 2 && (dx !== 0 || dy !== 0 || predictedCam.z !== fc.z))) {
      predictedCam = { x: fc.x, y: fc.y, z: fc.z };
    }
    prevFrameCam = { x: fc.x, y: fc.y, z: fc.z };
  }
  let pinnedAlertKey = null;
  // B232 R2: notificationFilterType is gone with the dashboard -- the native alert box has no
  // filter modes. lastNotificationPanelSignature still de-dupes the box's poll re-renders.
  let lastNotificationPanelSignature = "";
  let selectedUnitData = null;
  let activeUnitTab = "Overview";
  let activeUnitDetailTab = null;
  let activeInfoPanel = null;
  let activeInfoSection = null;
  let activeInfoDetail = null;
  let activeStockCategory = "";
  let stocksSearchQuery = ""; // WD-25: Stocks window search field (filters categories + items)
  let activeWorkshopTab = "tasks";
  let workshopAddMode = false;
  let workshopOrderAddMode = false;
  let workshopTaskSearch = ""; // B06: filter box for the workshop add-task / work-order picker
  let workshopTreePath = []; // TRUEMENU WP-1: forge drill-down path [catIdx, metalIdx] (empty = root)
  // D3/D4 (shop oracles): the FLAT task picker's one-level drill. DF's flat shops still carry
  // container rows -- the carpenter's `Make instrument (opens menu)` is row 1 of its own capture, and
  // the leatherworks' `Make instrument piece (opens menu)` is row 1 of its. null = at the root; a
  // task key = that container's submenu is open.
  let workshopFlatCat = null;
  let workshopRenameMode = false; // B13-rename: inline custom-name editor open on the workshop panel
  let workshopStatusMsg = "";
  let workshopStatusIsError = false;
  // B174 links flow (B171 oracles): the linked-stockpiles side window + its armed map-click mode.
  let workshopLinksOpen = false;
  let workshopLinkArmMode = null; // null | 'take' (shop takes from clicked pile) | 'give'
  function focusPage() {
    try { view.focus({ preventScroll: true }); } catch (_) {}
  }
  setTimeout(focusPage, 0);

  // ---- MAP SURFACE: DF tile renderer (replaces the old server-rendered JPEG stream) --------
  // The map is now drawn straight to the #view canvas by dwf-tiles.js, which polls
  // GET /mapdata (origin = this player's camera, dims = the capture viewport) and blits the
  // full DF sprite-layer stack. dwf-core.js drives it: it owns camera/designation input
  // and just asks the renderer to refetch after a camera move. tileRenderer is created in
  // startFrameSource(). See renderedImageRect()/imagePixelFromEvent() below for how screen
  // input maps onto the canvas' tile grid (mapdata window == /designate viewport, so grid
  // indices go to the server verbatim).
  let tileRenderer = null;
  const ZONE_SHEET_URL = "/asset/activity_zones.png";
  const zoneSheet = new Image();
  zoneSheet.onload = () => renderZoneOverlay();
  zoneSheet.src = ZONE_SHEET_URL;

  // Force an immediate /mapdata refetch so a camera pan/zoom/reset shows the new view without
  // waiting out the renderer's ~500ms poll cadence. No-op until the renderer exists.
  function refreshMap() {
    if (tileRenderer && typeof tileRenderer.refresh === "function") tileRenderer.refresh();
  }
  // Back-compat shim: a few call sites used to nudge the JPEG loop via scheduleFrame(0). They
  // now just kick an immediate map refetch. (The predictive-JPEG path is gone.)
  function scheduleFrame() { refreshMap(); }
  const step = 10;
  const zstep = 1;
  let queued = { dx: 0, dy: 0, dz: 0 };
  let sending = false;
  let moveWaiters = [];

  // A designation released immediately after Shift+wheel must not race the camera POST that
  // establishes the range's other z endpoint. Ordinary navigation ignores this promise; the
  // designation path awaits it before sending /designate.
  function whenCameraMovesFlushed() {
    if (!sending && !queued.dx && !queued.dy && !queued.dz) return Promise.resolve();
    return new Promise(resolve => moveWaiters.push(resolve));
  }

  function resolveMoveWaiters() {
    const waiters = moveWaiters;
    moveWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function queueMove(dx, dy, dz, opts) {
    if (!opts || opts.followBreak !== false) stopPlayerFollow("manual");
    notePanInput(dx, dy, dz);   // instant predictive shift before the server round-trip
    // WA-13: on protocol v1, re-window the canvas from the world cache at the new position
    // IMMEDIATELY (no wire wait) -- a no-op under legacy (unchanged, server-push-driven).
    try { if (tileRenderer && typeof tileRenderer.noteCamDelta === "function") tileRenderer.noteCamDelta(dx, dy, dz); } catch (_) {}
    queued.dx += dx;
    queued.dy += dy;
    queued.dz += dz;
    if (sending) return;
    sending = true;
    requestAnimationFrame(flushMove);
  }

  // Camera snap-back fix (2026-07-17). PRIMARY camera transport is now the WebSocket: a cam message
  // carrying the new absolute position updates the SAME per-player camera authority the HTTP POST
  // /camera writes (see websocket.cpp's cam handler), keyed on the connection's raw registry identity
  // so it can never miss the is_safe_player_id/URL round-trip a browser-built ?player= can. We send
  // the renderer's authoritative optimistic camera (desiredCam), which the ~30Hz AUX then echoes back
  // verbatim -- reconcileAuxCam sees no divergence, so there is no feedback loop and no snap. Returns
  // true iff the socket was up and the message was sent; false means fall back to the HTTP POST.
  function sendCameraWS() {
    try {
      if (!(window.DwfWS && typeof DwfWS.isConnected === "function" && DwfWS.isConnected())) return false;
      const cam = (tileRenderer && typeof tileRenderer.getDesiredCam === "function") ? tileRenderer.getDesiredCam() : null;
      if (!cam) return false;
      return !!DwfWS.send({ type: "cam", x: cam.x | 0, y: cam.y | 0, z: cam.z | 0 });
    } catch (_) { return false; }
  }

  // STOP FAILING SILENTLY (2026-07-17): the HTTP camera/zoom writes used to swallow every failure in a
  // bare catch, so a blocked/401/phantom POST snapped the view back with zero surfaced error. Surface a
  // non-OK response (console.warn with status), and route a 401 into the SAME re-auth path the WS uses
  // (DwfAuth.onAuthFail -> clears the stale credential and re-shows the join screen) instead of eating it.
  function noteCameraHttpResult(r, label) {
    try {
      if (!r || r.ok) return;
      console.warn(`[dwf] ${label} failed: HTTP ${r.status}`);
      if (r.status === 401) {
        if (window.DwfAuth && typeof DwfAuth.onAuthFail === "function") DwfAuth.onAuthFail();
        else if (window.DwfJoin && typeof DwfJoin.onAuthFail === "function") DwfJoin.onAuthFail();
      }
    } catch (_) { /* surfacing must never itself throw into the caller */ }
  }
  function noteCameraHttpError(err, label) {
    try { console.warn(`[dwf] ${label} network error:`, err && err.message ? err.message : err); } catch (_) {}
  }

  async function flushMove() {
    const move = queued;
    queued = { dx: 0, dy: 0, dz: 0 };
    // WS primary: send the new absolute camera over the socket. Only fall back to the legacy relative
    // HTTP POST when the socket is down (keeps older/offline sessions working, per the transport seam).
    if (!sendCameraWS()) {
      const url = `/camera?player=${encodeURIComponent(player)}&dx=${move.dx}&dy=${move.dy}&dz=${move.dz}`;
      try {
        const r = await fetch(url, { method: "POST", cache: "no-store" });
        noteCameraHttpResult(r, "camera pan");
      } catch (err) { noteCameraHttpError(err, "camera pan"); }
    }
    // Pull the post-move map now instead of waiting out the renderer's poll interval.
    refreshMap();
    loadHud();
    if (zoneOverlayEnabled) loadZones();
    sending = false;
    if (queued.dx || queued.dy || queued.dz) {
      sending = true;
      requestAnimationFrame(flushMove);
    } else {
      resolveMoveWaiters();
    }
  }

  // Real per-player zoom (changes how much of the world is visible, like DF's [ ]).
  // The plugin re-renders this player's next frame at their own viewport zoom factor.
  let zoomBusy = false;
  function sendZoom(dir) {
    if (zoomBusy) return;             // coalesce rapid presses
    zoomBusy = true;
    // Zoom's recenter is computed SERVER-side (zoom_player_camera), so it stays on the HTTP /zoom
    // route rather than the WS position transport. But surface failures the same way (2026-07-17):
    // a non-OK response is logged and a 401 re-auths, instead of the old bare .catch(()=>{}) swallow.
    fetch(`/zoom?player=${encodeURIComponent(player)}&dir=${dir}`, { method: "POST", cache: "no-store" })
      .then(r => noteCameraHttpResult(r, "zoom"))
      .catch(err => noteCameraHttpError(err, "zoom"))
      .finally(() => {
        zoomBusy = false;
        refreshMap();
        loadHud();
        if (zoneOverlayEnabled) loadZones();
      });
  }

  async function resetToHost() {
    stopPlayerFollow("manual");
    resetPanPrediction();
    try {
      const r = await fetch(`/reset?player=${encodeURIComponent(player)}`, { method: "POST", cache: "no-store" });
      noteCameraHttpResult(r, "camera reset");
    } catch (err) { noteCameraHttpError(err, "camera reset"); }
    refreshMap();
    loadHud();
    if (zoneOverlayEnabled) loadZones();
  }


  // --- Spectate / follow-player camera ----------------------------------------------------
  // Presence already carries each connected player's camera window (camx/camy/camz). Follow is
  // deliberately client-only: it moves only THIS player's /camera, and any manual camera move
  // exits the lock so the view feels native instead of sticky.
  const PLAYER_FOLLOW_TICK_MS = 250;
  const PLAYER_FOLLOW_POST_MIN_MS = 250;
  const PLAYER_FOLLOW_DEADBAND_TILES = 1;

  let playerFollow = null;      // { name, label, lastSent, lastPostAt, timer, busy }
  const playerFollowSubs = [];
  let playerFollowIndicator = null;

  function finiteRosterNumber(v) {
    return (typeof v === "number" && Number.isFinite(v)) ? v : null;
  }

  function playerCameraFromPresence(p) {
    if (!p) return null;
    const hasCamShape = p.camx !== undefined || p.camy !== undefined || p.camz !== undefined;
    let x = finiteRosterNumber(p.camx), y = finiteRosterNumber(p.camy), z = finiteRosterNumber(p.camz);
    if (hasCamShape) {
      if (x === null || y === null || z === null) return null;
    } else {
      // Old/development payload fallback. Current production uses cam* for camera and x/y/z for
      // cursor, so this branch is used only if a host predates cam* and still sends camera xyz.
      x = finiteRosterNumber(p.x); y = finiteRosterNumber(p.y); z = finiteRosterNumber(p.z);
      if (x === null || y === null || z === null) return null;
    }
    return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
  }

  function findPresencePlayer(name) {
    try {
      const roster = (window.DwfPresence && Array.isArray(DwfPresence.roster)) ? DwfPresence.roster : [];
      for (let i = 0; i < roster.length; i++) {
        const p = roster[i];
        if (p && String(p.name || "") === String(name || "")) return p;
      }
    } catch (_) {}
    return null;
  }

  function shouldPlayerFollowPost(lastSent, next, now, lastPostAt) {
    if (!next) return false;
    if (!lastSent) return true;
    if (now - (lastPostAt || 0) < PLAYER_FOLLOW_POST_MIN_MS) return false;
    if (next.z !== lastSent.z) return true;
    const dxy = Math.max(Math.abs(next.x - lastSent.x), Math.abs(next.y - lastSent.y));
    return dxy > PLAYER_FOLLOW_DEADBAND_TILES;
  }

  function emitPlayerFollowChange() {
    const state = getPlayerFollowState();
    for (let i = 0; i < playerFollowSubs.length; i++) {
      try { playerFollowSubs[i](state); } catch (_) {}
    }
  }

  function ensurePlayerFollowIndicator() {
    if (playerFollowIndicator) return playerFollowIndicator;
    try {
      if (!document.getElementById("dfPlayerFollowStyle")) {
        const style = document.createElement("style");
        style.id = "dfPlayerFollowStyle";
        style.textContent =
          "#dfPlayerFollowIndicator{position:fixed;top:96px;left:50%;transform:translateX(-50%);" +
          "z-index:57;display:none;align-items:center;gap:8px;max-width:min(420px,calc(100vw - 48px));" +
          "padding:5px 9px;border:1px solid #d89b27;background:rgba(14,14,13,.94);" +
          "box-shadow:0 4px 14px rgba(0,0,0,.45);color:#f2e6cf;font:12px/1.35 ui-monospace,Consolas,monospace;" +
          "pointer-events:auto;white-space:nowrap}" +
          "#dfPlayerFollowIndicator span{overflow:hidden;text-overflow:ellipsis}" +
          "#dfPlayerFollowIndicator button{border:1px solid #6b5326;background:#1a1712;color:#ffd45c;" +
          "font:11px ui-monospace,Consolas,monospace;padding:2px 6px;cursor:pointer}" +
          "#dfPlayerFollowIndicator button:hover{border-color:#d89b27;background:#241b0d}";
        document.head.appendChild(style);
      }
      playerFollowIndicator = document.createElement("div");
      playerFollowIndicator.id = "dfPlayerFollowIndicator";
      const text = document.createElement("span");
      const stop = document.createElement("button");
      stop.type = "button";
      stop.textContent = "Stop";
      stop.addEventListener("click", event => {
        event.preventDefault();
        stopPlayerFollow("manual");
        focusPage();
      });
      playerFollowIndicator.appendChild(text);
      playerFollowIndicator.appendChild(stop);
      document.body.appendChild(playerFollowIndicator);
    } catch (_) {}
    return playerFollowIndicator;
  }

  // Placement-check finding (FAIL, 2026-07-09, tools/harness/results/spectate-placement/):
  // #hoverInfo is also top-centered (top:56px) with content-driven, unbounded height -- an
  // ordinary 2-line tooltip already reaches y=104 and overlaps a fixed top:96px indicator.
  // A fixed offset can't win, so the indicator DODGES: it sits at 96px when hover is hidden
  // and re-anchors just below hoverInfo's live bottom edge whenever it is visible. Re-run on
  // every render AND every follow tick (hover height changes between our renders).
  // Guard is getComputedStyle(hv).display, NOT offsetParent: hoverInfo is position:fixed and
  // offsetParent is spec-NULL for fixed elements even when visible (first fix attempt was a
  // no-op at scale 1 because of exactly this -- placement-checker measured it). The /zoom
  // divide maps the visual-pixel target into the indicator's zoomed coordinate space (both
  // elements share the same --ui-scale zoom, so this is exact); ceil keeps the >=8px bar.
  function positionPlayerFollowIndicator() {
    const el = playerFollowIndicator;
    if (!el || el.style.display === "none") return;
    const zoom = parseFloat(getComputedStyle(el).zoom) || 1;
    let top = 96;
    try {
      const hv = document.getElementById("hoverInfo");
      if (hv && getComputedStyle(hv).display !== "none") {
        const r = hv.getBoundingClientRect();
        if (r.height > 0) top = Math.max(top, Math.ceil((r.bottom + 8) / zoom));
      }
    } catch (_) {}
    el.style.top = top + "px";
  }

  function renderPlayerFollowIndicator() {
    const el = ensurePlayerFollowIndicator();
    if (!el) return;
    if (!playerFollow) { el.style.display = "none"; return; }
    const text = el.querySelector("span");
    if (text) text.textContent = `Following ${playerFollow.label || playerFollow.name} - move to stop`;
    el.style.display = "flex";
    positionPlayerFollowIndicator();
  }

  async function setOwnCameraAbsolute(cam) {
    if (!cam) return false;
    resetPanPrediction();
    try { if (tileRenderer && typeof tileRenderer.setCamAbsolute === "function") tileRenderer.setCamAbsolute(cam.x, cam.y, cam.z); } catch (_) {}
    // WS primary (2026-07-17): setCamAbsolute above has already set desiredCam to this absolute cam, so
    // sendCameraWS broadcasts exactly it. Only POST when the socket is down (legacy fallback).
    if (sendCameraWS()) {
      refreshMap();
      loadHud();
      if (zoneOverlayEnabled) loadZones();
      return true;
    }
    try {
      const ac = ("AbortController" in window) ? new AbortController() : null;
      const to = ac ? setTimeout(() => ac.abort(), 2500) : null;
      const r = await fetch(`/camera?player=${encodeURIComponent(player)}&x=${cam.x}&y=${cam.y}&z=${cam.z}`, {
        method: "POST",
        cache: "no-store",
        signal: ac ? ac.signal : undefined
      });
      if (to) clearTimeout(to);
      noteCameraHttpResult(r, "camera follow");
      refreshMap();
      loadHud();
      if (zoneOverlayEnabled) loadZones();
      return !r || r.ok !== false;
    } catch (err) {
      noteCameraHttpError(err, "camera follow");
      return false;
    }
  }

  async function playerFollowTick() {
    positionPlayerFollowIndicator();   // hover tooltip height changes between renders -- keep dodging
    const follow = playerFollow;
    if (!follow || follow.busy) return;
    const p = findPresencePlayer(follow.name);
    const cam = playerCameraFromPresence(p);
    if (!cam) return;
    const now = Date.now();
    if (!shouldPlayerFollowPost(follow.lastSent, cam, now, follow.lastPostAt)) return;
    follow.busy = true;
    const ok = await setOwnCameraAbsolute(cam);
    if (playerFollow !== follow) return;
    follow.busy = false;
    if (ok) {
      follow.lastSent = { x: cam.x, y: cam.y, z: cam.z };
      follow.lastPostAt = Date.now();
    }
  }

  async function jumpToPresencePlayer(name) {
    const p = findPresencePlayer(name);
    if (!p || p.self) return false;
    const cam = playerCameraFromPresence(p);
    if (!cam) return false;
    stopPlayerFollow("jump");
    return setOwnCameraAbsolute(cam);
  }

  function followPresencePlayer(name) {
    const p = findPresencePlayer(name);
    if (!p || p.self) return false;
    const cam = playerCameraFromPresence(p);
    if (!cam) return false;
    stopPlayerFollow("replace");
    const rawFollowName = String(p.name || name);
    // The banner ("Following X - move to stop") shows the anonymized display name via dwf-lobby.js's
    // ONE canonical helper, so a guest reads "Following Guest 1665" instead of a raw UUID -- matching
    // the cursor label / lobby chip. `name` stays the raw roster key (findPresencePlayer addresses it).
    const followLabel = (window.DwfLobby && typeof DwfLobby.displayName === "function")
      ? DwfLobby.displayName(rawFollowName).text : rawFollowName;
    playerFollow = {
      name: rawFollowName,
      label: followLabel,
      lastSent: null,
      lastPostAt: 0,
      timer: window.setInterval(() => { playerFollowTick(); }, PLAYER_FOLLOW_TICK_MS),
      busy: false
    };
    renderPlayerFollowIndicator();
    emitPlayerFollowChange();
    playerFollowTick();
    return true;
  }

  function stopPlayerFollow(_reason) {
    if (!playerFollow) return false;
    if (playerFollow.timer) window.clearInterval(playerFollow.timer);
    playerFollow = null;
    renderPlayerFollowIndicator();
    emitPlayerFollowChange();
    return true;
  }

  function togglePresenceFollow(name) {
    if (playerFollow && playerFollow.name === String(name || "")) return stopPlayerFollow("toggle");
    return followPresencePlayer(name);
  }

  function getPlayerFollowState() {
    return playerFollow ? { following: true, name: playerFollow.name, label: playerFollow.label } : { following: false, name: "", label: "" };
  }

  function onPlayerFollowChange(cb) {
    if (typeof cb === "function") {
      playerFollowSubs.push(cb);
      try { cb(getPlayerFollowState()); } catch (_) {}
    }
  }

  try {
    window.DwfSpectate = {
      jumpToPlayer: jumpToPresencePlayer,
      followPlayer: followPresencePlayer,
      toggleFollow: togglePresenceFollow,
      stopFollow: stopPlayerFollow,
      getState: getPlayerFollowState,
      onChange: onPlayerFollowChange,
      _test: { playerCameraFromPresence, shouldPlayerFollowPost }
    };
  } catch (_) {}

  // --- View zoom (client-side px/tile in the tile renderer) --------------------------------
  // This is the REAL "how much of the map fills the screen" zoom (DF's [ ]): the tile renderer
  // changes its target px/tile, which resizes the /mapdata window (w/h). Distinct from the
  // legacy per-player server /zoom (sendZoom, kept for compat/fallback). The renderer returns
  // the change in requested window dims; we shift the camera by -delta/2 so the CENTER of the
  // view stays fixed (center-on-view zoom) instead of the window growing off the top-left.
  function applyZoomResult(d) {
    if (d && (d.dw || d.dh)) {
      const ddx = -Math.round(d.dw / 2);
      const ddy = -Math.round(d.dh / 2);
      if (ddx || ddy) queueMove(ddx, ddy, 0, { followBreak: false });
      else refreshMap();
    } else {
      refreshMap();
    }
  }
  function zoomView(dir) {
    if (!tileRenderer || typeof tileRenderer.zoom !== "function") { sendZoom(dir); return; }
    applyZoomResult(tileRenderer.zoom(dir));
  }
  function resetZoomView() {
    if (!tileRenderer || typeof tileRenderer.zoomTo !== "function") return;
    const z = (typeof tileRenderer.getZoom === "function") ? tileRenderer.getZoom() : null;
    applyZoomResult(tileRenderer.zoomTo(z ? z.def : 24));
  }
  window.dwfZoomView = zoomView;       // shared-scope hooks for the settings UI
  window.dwfResetZoomView = resetZoomView;

  // ---- WA-13 item 4: nav debug hooks for tools/harness/gate_localnav.py -------------------
  // Drives the SAME real input pathways a human uses (queueMove for pan/z, zoomView for zoom)
  // so the gate measures genuine end-to-end behavior -- not a synthetic shortcut that could
  // pass while the real UI path still reconnects/stalls. `stats()` reports over "the last
  // gesture window": the first pan()/zoom()/zmove() call after a stats() read captures a
  // baseline (byte/reconnect counters + a cleared frame-time ring); stats() computes the
  // deltas against that baseline and resets it, so back-to-back gesture batches don't bleed
  // into each other's numbers.
  let _navBaseline = null;
  const _navFrameTimes = [];
  function _navWsStats() {
    return (window.DwfWS && typeof DwfWS.getStats === "function") ? DwfWS.getStats() : {};
  }
  function _navRecordFrame() {
    _navFrameTimes.push(performance.now());
    if (_navFrameTimes.length > 4000) _navFrameTimes.shift();
  }
  function _navEnsureBaseline() {
    if (_navBaseline) return;
    const s = _navWsStats();
    _navBaseline = { reconnects: s.socketOpens || 0, blockSetBytes: s.blockSetBytesTotal || 0 };
    _navFrameTimes.length = 0;
  }
  function _navPan(dx, dy) { _navEnsureBaseline(); queueMove(dx | 0, dy | 0, 0); }
  function _navZoom(step) {
    _navEnsureBaseline();
    const n = Math.max(1, Math.abs(step || 1));
    const dir = (step || 1) >= 0 ? "in" : "out";
    for (let i = 0; i < n; i++) zoomView(dir);
  }
  function _navZmove(dz) { _navEnsureBaseline(); queueMove(0, 0, dz | 0); }
  function _navStats() {
    const s = _navWsStats();
    const base = _navBaseline || { reconnects: s.socketOpens || 0, blockSetBytes: s.blockSetBytesTotal || 0 };
    const times = _navFrameTimes.slice().sort((a, b) => a - b);
    const deltas = [];
    for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
    deltas.sort((a, b) => a - b);
    const p95 = deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))] : 0;
    const out = {
      frameP95Ms: Math.round(p95 * 100) / 100,
      blockSetBytesWindow: Math.max(0, (s.blockSetBytesTotal || 0) - base.blockSetBytes),
      reconnects: Math.max(0, (s.socketOpens || 0) - base.reconnects),
    };
    _navBaseline = null; // next pan/zoom/zmove call starts a fresh gesture window
    return out;
  }
  try { window.__wa_nav = { pan: _navPan, zoom: _navZoom, zmove: _navZmove, stats: _navStats }; } catch (_) { /* non-browser context */ }

  // ---- WT20 (mobile): camera hooks for the touch-gesture layer ----------------------------
  // dwf-touch.js drives the SAME primitives every other input path uses -- queueMove for
  // pan/z (predictive shift + coalesced /camera POST included), tileRenderer.zoomTo +
  // applyZoomResult for continuous pinch zoom (center-on-view, exactly like [ ]/wheel zoom).
  // Additive export only; no existing code reads it, so desktop behavior is untouched.
  function zoomViewToPx(px) {
    if (!tileRenderer || typeof tileRenderer.zoomTo !== "function") return;
    // Clamp guard: a pinch held past the renderer's [min,max] px/tile keeps streaming zoomTo
    // calls that change NOTHING (zoomTo returns {0,0} without applying). Skipping the
    // applyZoomResult then avoids its else-branch refreshMap() -- which would otherwise
    // refetch /mapdata ~20x/s for the whole clamped stretch of the gesture.
    const before = getZoomPx();
    const d = tileRenderer.zoomTo(px);
    if (getZoomPx() !== before) applyZoomResult(d);
  }
  function getZoomPx() {
    try {
      const z = (tileRenderer && typeof tileRenderer.getZoom === "function") ? tileRenderer.getZoom() : null;
      return z ? z.px : 24;
    } catch (_) { return 24; }
  }
  try {
    window.DFTouchNav = {
      panTiles: (dx, dy) => queueMove(dx | 0, dy | 0, 0),
      zStep: dz => queueMove(0, 0, dz | 0),
      zoomToPx: zoomViewToPx,
      getZoomPx,
      cellPx: () => {
        const rr = renderedImageRect();
        return (rr && rr.cell > 0) ? rr.cell : 24;
      },
    };
  } catch (_) { /* non-browser context */ }

  // Center the camera window on the world tile under a screen point. The mapdata window origin
  // is the camera top-left, so to center world tile W we set origin = W - window/2. Used by a
  // middle-CLICK on the map (middle-DRAG pans instead; see the drag-pan handlers below).
  function centerOnCursor(clientX, clientY) {
    stopPlayerFollow("manual");
    if (!tileRenderer || typeof tileRenderer.screenToGrid !== "function") return;
    const g = tileRenderer.screenToGrid(clientX, clientY, true);
    const rr = tileRenderer.getRenderRect ? tileRenderer.getRenderRect() : null;
    if (!g || !rr) return;
    const worldX = Number(rr.ox) + g.gx, worldY = Number(rr.oy) + g.gy;
    const nx = Math.round(worldX - rr.gw / 2), ny = Math.round(worldY - rr.gh / 2);
    resetPanPrediction();
    try { if (tileRenderer && typeof tileRenderer.setCamAbsolute === "function") tileRenderer.setCamAbsolute(nx, ny, rr.oz); } catch (_) {}
    // WS primary (2026-07-17): setCamAbsolute set desiredCam to (nx,ny,rr.oz); broadcast it. HTTP only
    // when the socket is down.
    if (sendCameraWS()) { refreshMap(); loadHud(); if (zoneOverlayEnabled) loadZones(); return; }
    fetch(`/camera?player=${encodeURIComponent(player)}&x=${nx}&y=${ny}&z=${rr.oz}`,
          { method: "POST", cache: "no-store" })
      .then(r => { noteCameraHttpResult(r, "camera center"); refreshMap(); loadHud(); if (zoneOverlayEnabled) loadZones(); })
      .catch(err => noteCameraHttpError(err, "camera center"));
  }

  function isTextEditingTarget(target) {
    const tag = target && target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target?.isContentEditable;
  }

  // WT11 (RC-2): the 3D world viewer is a full-screen takeover with its OWN WASD / E / C / wheel
  // bindings. This module's key+wheel handlers are CAPTURE-phase on `window` and call
  // stopImmediatePropagation(), so while that overlay is up they would eat its input before it could
  // ever reach it -- and pan the 2D camera behind it, invisibly. Every control in the 3D viewer was
  // dead for exactly this reason. The handler must YIELD, the same way the wheel already yields to
  // `.dwfui-scroll` surfaces below: a listener on the overlay cannot fix it, because capture on
  // `window` runs first no matter what the overlay binds.
  function world3DOwnsInput() {
    try { return !!(window.DFWorld3D && window.DFWorld3D.isOpen && window.DFWorld3D.isOpen()); }
    catch (_) { return false; }
  }

  function handleCameraKey(event) {
    if (!event || isTextEditingTarget(event.target)) return false;
    if (world3DOwnsInput()) return false;
    // Never hijack browser shortcuts (Ctrl/Alt/Meta combos, e.g. Ctrl+Shift+R). Shift is NOT
    // excluded -- we use it for fast pan.
    if (event.altKey || event.metaKey || event.ctrlKey) return false;
    // Shift + a pan key = fast pan (bigger step). z-level / zoom / reset ignore the multiplier.
    const pan = event.shiftKey ? step * 3 : step;
    switch (event.key) {
      // WD-28 remediation (hotkey mirroring): arrow keys are DF's real STANDARDSCROLL_* pan
      // (interface.txt); Shift for a bigger step is a client-only convenience (DF's own "fast"
      // pan comes from OS key-repeat rate, it has no pan modifier key). w/a/s/d are kept as a
      // documented non-DF EXTRA -- DF's own w/a/s/d bind (CURSOR_*) drives a keyboard
      // designation-cursor this client never implements (all designation is mouse-driven), so
      // reusing the letters for pan collides with nothing real. h/j/k/l/q were DROPPED from
      // here: DF's real single-letter binds for those keys are fort-tool hotkeys
      // (D_HAULING/D_JUSTICE/D_STOCKS/D_DESIGNATE_CHOP/D_SQUADS) and now win the letter -- see
      // dwf-controls-placement.js's keydown switch.
      case "ArrowLeft": case "a": case "A":
        queueMove(-pan, 0, 0); return true;
      case "ArrowRight": case "d": case "D":
        queueMove(pan, 0, 0); return true;
      case "ArrowUp": case "w": case "W":
        queueMove(0, -pan, 0); return true;
      case "ArrowDown": case "s": case "S":
        queueMove(0, pan, 0); return true;
      // PageUp/PageDown are DF's real map z-step; e/c (E/C fast) are ALSO DF-real
      // (CURSOR_UP_Z/CURSOR_DOWN_Z in interface.txt) and don't collide with any fort-tool
      // letter, so both stay bound. `q` (the old z-down alias) is gone: DF's real q is
      // D_SQUADS -- see controls-placement.js.
      case "PageUp": case ">": case "e": case "E":
        queueMove(0, 0, zstep); return true;
      case "PageDown": case "<": case "c": case "C":
        queueMove(0, 0, -zstep); return true;
      // ZOOM (view scale) -> client px/tile in the tile renderer, centered on the view.
      // [ and ] are DF's real ZOOM_IN/ZOOM_OUT; =/+/-/_ are client-only aliases (non-DF).
      case "[": case "=": case "+":
        zoomView("in"); return true;
      case "]": case "-": case "_":
        zoomView("out"); return true;
      // Home resets the camera to the host's position -- a client-only concept (DF is
      // single-player, there's no "host" to snap back to). `r` moved to DF's real
      // D_TOGGLE_RAMP_INDICATORS (see controls-placement.js), so Home is now the only
      // keyboard way to reset the camera.
      case "Home":
        resetToHost(); return true;
      default:
        return false;
    }
  }

  if (!window.__dwfCoreCameraControlsBound) {
    window.__dwfCoreCameraControlsBound = true;
    addEventListener("keydown", event => {
      if (handleCameraKey(event)) {
        focusPage();
        event.__dwfCameraHandled = true;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, { capture: true });
    addEventListener("wheel", event => {
      // B17: Ctrl/Meta + wheel is the browser's page-zoom gesture, which distorts the game UI
      // ("disable website zoom as it affects UI size"). Intercept it everywhere in the app
      // and drive the in-client UI scale instead -- same muscle memory, but scoped to our UI so
      // the map itself never rescales/blurs. (Previously we let it through, which was the bug.)
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        try { if (window.DWFUIScale) window.DWFUIScale.adjust(event.deltaY < 0 ? 1 : -1); } catch (_) {}
        return;
      }
      // B216 defect 2: any DWFUI scroll surface owns the wheel and must scroll natively. DWFUI.scrollHtml
      // stamps `.dwfui-scroll` on EVERY scrollbox (combat log, chat, settings, squads, kitchen, stocks,
      // labor, hospital, worldmap, ...), so keying off that one class fixes every consumer at once.
      // Body-level panels (the combat log lives on document.body, not inside these id containers) fell
      // through to map-zoom, leaving their scrollbox wheel dead. A component wheel LISTENER cannot fix
      // this: this handler is capture-phase and calls stopImmediatePropagation below, so the event never
      // reaches the scrollbox -- the handler itself must YIELD instead.
      // WT28/B218: #dfPopupMirror is the native-popup mirror overlay -- while it is up, a wheel
      // anywhere over it must never fall through to map zoom (the modal-clicks-never-move-the-
      // camera rule); its text body is a .dwfui-scroll and scrolls natively via the same yield.
      // WT11: #world3dScreen is the 3D viewer's full-screen takeover -- its canvas owns the wheel
      // (orbit-camera zoom). Without this yield the wheel was swallowed here and zoomed the 2D map
      // BEHIND the overlay, which is why "wheel: zoom" was dead in the 3D view. See world3DOwnsInput.
      if (event.target.closest("#clientPanel.visible, #selection.visible, #alertPopup, #dfPopupMirror, #world3dScreen, .dwfui-scroll"))
        return;
      focusPage();
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) {
        // B186: while a volume-capable designation rectangle is held, the placement module
        // owns Shift+wheel so it can extend that one drag through z. Outside a drag the hook
        // returns false and the long-standing camera z-step below is unchanged.
        try {
          if (typeof window.DFDesignationRangeWheel === "function" &&
              window.DFDesignationRangeWheel(event)) return;
        } catch (_) {}
        // Shift + wheel = z-level (keeps DF's wheel-through-levels feel on a modifier).
        queueMove(0, 0, event.deltaY < 0 ? zstep : -zstep);
      } else {
        // Plain wheel = view zoom (px/tile), centered on the view.
        zoomView(event.deltaY < 0 ? "in" : "out");
      }
    }, { passive: false, capture: true });

    // Middle/right-drag = grab-pan the map (left-drag stays designation/inspect). A middle
    // press that DOESN'T move acts as a middle-CLICK = center the camera on that tile. Right
    // button also suppresses the context menu over the map so a right-drag pans cleanly.
    let panDrag = null;
    view.addEventListener("pointerdown", event => {
      if (event.button !== 1 && event.button !== 2) return;
      panDrag = { x: event.clientX, y: event.clientY, moved: 0, button: event.button, id: event.pointerId };
      try { view.setPointerCapture(event.pointerId); } catch (_) {}
      event.preventDefault();
    });
    view.addEventListener("pointermove", event => {
      if (!panDrag || event.pointerId !== panDrag.id) return;
      const rr = renderedImageRect();
      const cell = (rr && rr.cell) || 24;
      panDrag.moved += Math.abs(event.clientX - panDrag.x) + Math.abs(event.clientY - panDrag.y);
      const dxTiles = Math.round((panDrag.x - event.clientX) / cell);
      const dyTiles = Math.round((panDrag.y - event.clientY) / cell);
      if (dxTiles || dyTiles) {
        queueMove(dxTiles, dyTiles, 0);            // grab-pan: content follows the pointer
        panDrag.x -= dxTiles * cell;               // keep sub-tile remainder for smoothness
        panDrag.y -= dyTiles * cell;
      }
    });
    const endPanDrag = event => {
      if (!panDrag || event.pointerId !== panDrag.id) return;
      const wasMiddleClick = panDrag.button === 1 && panDrag.moved < 6;
      try { view.releasePointerCapture(event.pointerId); } catch (_) {}
      panDrag = null;
      if (wasMiddleClick) centerOnCursor(event.clientX, event.clientY);
    };
    view.addEventListener("pointerup", endPanDrag);
    view.addEventListener("pointercancel", endPanDrag);
    view.addEventListener("contextmenu", event => { event.preventDefault(); });
  }

  // Map source: the DF tile renderer (dwf-tiles.js) drawing to the #view canvas. We hand
  // it our player id (so its /mapdata poll uses the same server-side camera the designation
  // endpoints do) and tell it NOT to bind its own camera keys -- core.js owns all input. Its
  // onDraw hook repaints our zone/drag overlays right after each map frame so they stay aligned.
  function startFrameSource() {
    if (tileRenderer) return;
    const TilesApi = window.DwfTiles;
    if (TilesApi && typeof TilesApi.init === "function") {
      tileRenderer = TilesApi.init({
        canvas: view,
        player,
        manageCamera: false,
        managePoll: true,
        onDraw: () => { try { renderZoneOverlay(); } catch (_) {} try { _navRecordFrame(); } catch (_) {} },
      });
    }
    // If the tile renderer is unavailable (older bundle), the map stays black but every panel,
    // toolbar action, and server endpoint still works -- and nothing throws.
  }

  function startDwf() {
    if (window.__dwfStarted) return;
    window.__dwfStarted = true;
    startFrameSource();
    if (typeof loadHud === "function") {
      loadHud();
      setInterval(loadHud, 1000);
    }
    if (typeof loadNotifications === "function") {
      loadNotifications();
      setInterval(loadNotifications, 500);
    }
  }

  // Screen event -> map tile, expressed in the coordinate contract every server endpoint
  // (/designate, /build-place, /stockpile, /zone, /inspect, /hover) understands: {x,y,w,h}
  // where the server computes tile = camera + (x * view_w / w). The tile renderer's mapdata
  // window shares the camera and view_w with those endpoints, so we return the raw grid tile
  // index as x,y and the window's tile dims as w,h -> the server maps them back tile-exact.
  function imagePixelFromEvent(event) {
    if (!tileRenderer) return null;
    const g = tileRenderer.screenToGrid(event.clientX, event.clientY, false);
    if (!g) return null;
    return { x: g.gx, y: g.gy, w: g.gw, h: g.gh };
  }

  // The map's drawn rectangle in screen space plus its per-tile cell size and window origin.
  // `scale` is kept for callers that read it as "screen px per map unit" -- here one map unit
  // is one tile, so scale === cell.
  function renderedImageRect() {
    if (!tileRenderer) return null;
    const rr = tileRenderer.getRenderRect();
    if (!rr) return null;
    return {
      left: rr.left,
      top: rr.top,
      width: rr.width,
      height: rr.height,
      scale: rr.cell,
      cell: rr.cell,
      gw: rr.gw,
      gh: rr.gh,
      ox: rr.ox,
      oy: rr.oy,
      oz: rr.oz
    };
  }

  // World tile -> on-screen rect, using the tile renderer's live window (origin + cell). The
  // window origin is the player's camera, so (pos - origin) is the tile's grid index.
  function screenRectForMapTile(pos) {
    if (!pos) return null;
    const rendered = renderedImageRect();
    if (!rendered) return null;
    if (Number(pos.z) !== Number(rendered.oz)) return null;
    const tx = Number(pos.x) - Number(rendered.ox);
    const ty = Number(pos.y) - Number(rendered.oy);
    if (tx < 0 || ty < 0 || tx >= rendered.gw || ty >= rendered.gh) return null;
    return {
      left: rendered.left + tx * rendered.cell,
      top: rendered.top + ty * rendered.cell,
      width: Math.max(8, rendered.cell),
      height: Math.max(8, rendered.cell)
    };
  }

  function resizeZoneOverlay() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.ceil(window.innerWidth));
    const h = Math.max(1, Math.ceil(window.innerHeight));
    if (zoneOverlay.width !== Math.ceil(w * dpr) || zoneOverlay.height !== Math.ceil(h * dpr)) {
      zoneOverlay.width = Math.ceil(w * dpr);
      zoneOverlay.height = Math.ceil(h * dpr);
      zoneOverlay.style.width = `${w}px`;
      zoneOverlay.style.height = `${h}px`;
    }
    const ctx = zoneOverlay.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function zoneExtentAt(zone, lx, ly) {
    const w = Number(zone.w) || 0;
    const h = Number(zone.h) || 0;
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
    const ext = typeof zone.extents === "string" ? zone.extents : "";
    return ext.charAt(lx + ly * w) === "1";
  }

  function zoneShapeRow(zone, lx, ly) {
    const n = zoneExtentAt(zone, lx, ly - 1);
    const s = zoneExtentAt(zone, lx, ly + 1);
    const w = zoneExtentAt(zone, lx - 1, ly);
    const e = zoneExtentAt(zone, lx + 1, ly);
    // Bit set == a same-zone neighbour is PRESENT on that side (so that edge is INTERIOR and
    // must NOT be stroked). A perimeter edge = neighbour absent = bit clear = border drawn.
    const mask = (n ? 1 : 0) | (s ? 2 : 0) | (w ? 4 : 0) | (e ? 8 : 0);
    // B198: the row a mask selects must match DF's own activity_zones.png shape ordering. The
    // sheet's 16 rows were read straight off the PNG (data/vanilla/.../images/activity_zones.png,
    // alpha-255 = border line): row R strokes exactly the edges whose neighbour is absent. Mapping
    // (mask of PRESENT neighbours -> sheet row):
    //   row 0  = all 4 borders (isolated / single tile), row 15 = no borders (fully interior).
    // The prior table was scrambled -- it sent mask 15 (interior) to row 0 (the full box), so every
    // interior tile drew its own border = the "tic-tac-toe" grid. This table is the true inverse of
    // the per-row edge sets detected from the sheet.
    return ({
      0: 0,  1: 12, 2: 11, 3: 10, 4: 14, 5: 3, 6: 2,  7: 6,
      8: 13, 9: 4,  10: 1, 11: 7, 12: 9, 13: 8, 14: 5, 15: 15
    })[mask] ?? 0;
  }

  // Local drag selection: draw the tile-snapped golden rectangle directly on the overlay canvas
  // so instant designations, rectangle paint, and variable-area builds track the cursor with zero
  // server round-trips. Works in
  // natural-image-pixel space (the same coords designateDrag commits with) and snaps to
  // whole tiles using the live viewport size, so the preview lands on exactly the tiles
  // the server will designate on release.
  function stairPreviewGrid(preview, rendered) {
    if (!preview || !rendered) return null;
    const values = [preview.x1, preview.y1, preview.x2, preview.y2, rendered.ox, rendered.oy].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return { ax: values[0] - values[4], ay: values[1] - values[5],
      bx: values[2] - values[4], by: values[3] - values[5] };
  }

  function dragPreviewBounds(preview) {
    if (!preview) return null;
    const values = [preview.ax, preview.ay, preview.bx, preview.by].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return { gx0: Math.min(values[0], values[2]), gy0: Math.min(values[1], values[3]),
      gx1: Math.max(values[0], values[2]) + 1, gy1: Math.max(values[1], values[3]) + 1 };
  }

  function designationZRangeLabel(preview) {
    if (!preview) return "";
    const a = Number(preview.z1 ?? preview.z);
    const b = Number(preview.z2 ?? preview.z);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return "";
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return `Z ${lo}-${hi} (${hi - lo + 1} levels)`;
  }

  function drawDragPreview(ctx) {
    const rendered = renderedImageRect();
    const preview = dragPreview || stairPreviewGrid(stairRangePreview, rendered);
    if (!preview || !rendered) return;
    const cell = rendered.cell;
    // dragPreview ax/ay/bx/by are grid tile indices (imagePixelClamped returns grid coords),
    // so snapping is just min/max + the inclusive +1 on the far edge.
    const bounds = dragPreviewBounds(preview);
    if (!bounds) return;
    const { gx0, gy0, gx1, gy1 } = bounds;
    const sx = rendered.left + gx0 * cell;
    const sy = rendered.top + gy0 * cell;
    const sw = (gx1 - gx0) * cell;
    const sh = (gy1 - gy0) * cell;
    if (sw <= 0 || sh <= 0) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "rgba(255, 196, 64, 0.16)";
    ctx.fillRect(sx, sy, sw, sh);
    // faint per-tile separators so the selection reads as DF tiles
    const stepX = cell, stepY = cell;
    if (stepX > 3 && stepY > 3) {
      ctx.strokeStyle = "rgba(255, 210, 90, 0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = sx + stepX; gx < sx + sw - 0.5; gx += stepX) {
        const px = Math.round(gx) + 0.5; ctx.moveTo(px, sy); ctx.lineTo(px, sy + sh);
      }
      for (let gy = sy + stepY; gy < sy + sh - 0.5; gy += stepY) {
        const py = Math.round(gy) + 0.5; ctx.moveTo(sx, py); ctx.lineTo(sx + sw, py);
      }
      ctx.stroke();
    }
    // crisp gold border + corner brackets (DF selection feel)
    const L = Math.round(sx) + 1, T = Math.round(sy) + 1;
    const R = Math.round(sx + sw) - 1, B = Math.round(sy + sh) - 1;
    ctx.strokeStyle = "rgba(255, 214, 92, 0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(L, T, R - L, B - T);
    const c = Math.max(3, Math.min(10, (R - L) / 2, (B - T) / 2));
    ctx.strokeStyle = "rgba(255, 236, 150, 1)";
    ctx.beginPath();
    ctx.moveTo(L, T + c); ctx.lineTo(L, T); ctx.lineTo(L + c, T);
    ctx.moveTo(R - c, T); ctx.lineTo(R, T); ctx.lineTo(R, T + c);
    ctx.moveTo(L, B - c); ctx.lineTo(L, B); ctx.lineTo(L + c, B);
    ctx.moveTo(R - c, B); ctx.lineTo(R, B); ctx.lineTo(R, B - c);
    ctx.stroke();
    const zLabel = designationZRangeLabel(stairRangePreview);
    if (zLabel) {
      ctx.font = "600 12px ui-monospace, Consolas, monospace";
      const pad = 5;
      const tw = Math.ceil(ctx.measureText(zLabel).width);
      const bx = L, by = Math.max(18, T - 7);
      ctx.fillStyle = "rgba(20, 16, 8, 0.9)";
      ctx.fillRect(bx, by - 16, tw + pad * 2, 20);
      ctx.strokeStyle = "rgba(255, 214, 92, 0.95)";
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by - 15.5, tw + pad * 2 - 1, 19);
      ctx.fillStyle = "rgba(255, 236, 150, 1)";
      ctx.fillText(zLabel, bx + pad, by);
    }
    ctx.restore();
  }

  // Building-placement footprint preview (browser-side). Draws the selected building's
  // footprint centered on the cursor: green cells where placement looks valid, red where a
  // covered tile is a wall / hidden / empty / liquid. Validity is a cheap client heuristic
  // off the live /mapdata tiles for immediate feedback -- the server still authoritatively
  // validates on commit (placeBuildDrag). No-op unless a build tool is armed and hovering.
  // Pending zone paint is intentionally distinct from the short-lived generic drag preview:
  // a zone is not created until Accept, so its selected rectangle must remain visible after the
  // pointer is released. This shared overlay sits above both canvas and GL renderers.
  function zonePreviewBounds(preview) {
    if (!preview) return null;
    const values = [preview.x1, preview.y1, preview.x2, preview.y2].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return { x1: Math.min(values[0], values[2]), y1: Math.min(values[1], values[3]),
      x2: Math.max(values[0], values[2]), y2: Math.max(values[1], values[3]) };
  }

  function drawZonePaintPreview(ctx) {
    // Existing-zone repaint retains exact world-tile changes through Accept. Additions are cyan;
    // erasures are red, including a hole carved from the middle of the existing zone.
    if ((!zonePreset && zoneRepaintId == null) || zoneRemoveArmed) return;
    const rendered = renderedImageRect();
    if (!rendered) return;
    if (zoneRepaintId != null && zoneRepaintDraft && zoneRepaintDraft.changes) {
      ctx.save();
      zoneRepaintDraft.changes.forEach((present, key) => {
        const [wx, wy] = key.split(",").map(Number);
        const gx = wx - Number(rendered.ox), gy = wy - Number(rendered.oy);
        if (gx < 0 || gy < 0 || gx >= rendered.gw || gy >= rendered.gh) return;
        const sx = rendered.left + gx * rendered.cell;
        const sy = rendered.top + gy * rendered.cell;
        ctx.fillStyle = present ? "rgba(90, 205, 255, 0.38)" : "rgba(235, 75, 65, 0.50)";
        ctx.fillRect(sx, sy, rendered.cell, rendered.cell);
        ctx.strokeStyle = present ? "rgba(150, 235, 255, 0.98)" : "rgba(255, 115, 100, 0.98)";
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(sx) + 1, Math.round(sy) + 1,
          Math.max(1, Math.round(rendered.cell) - 2), Math.max(1, Math.round(rendered.cell) - 2));
      });
      ctx.restore();
      return;
    }

    // New-zone creation is still rectangle-backed.
    const preview = zonePreviewBounds(zonePaintPreview);
    if (!preview) return;
    const gx0 = Math.max(0, preview.x1), gy0 = Math.max(0, preview.y1);
    const gx1 = Math.min(rendered.gw - 1, preview.x2), gy1 = Math.min(rendered.gh - 1, preview.y2);
    if (gx1 < gx0 || gy1 < gy0) return;
    const cell = rendered.cell;
    const sx = rendered.left + gx0 * cell, sy = rendered.top + gy0 * cell;
    const sw = (gx1 - gx0 + 1) * cell, sh = (gy1 - gy0 + 1) * cell;
    ctx.save();
    const erasing = false;
    ctx.fillStyle = erasing ? "rgba(235, 75, 65, 0.24)" : "rgba(90, 205, 255, 0.22)";
    ctx.fillRect(sx, sy, sw, sh);
    if (cell > 3) {
      ctx.strokeStyle = erasing ? "rgba(255, 130, 115, 0.38)" : "rgba(145, 230, 255, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = sx + cell; gx < sx + sw - 0.5; gx += cell) { const x = Math.round(gx) + 0.5; ctx.moveTo(x, sy); ctx.lineTo(x, sy + sh); }
      for (let gy = sy + cell; gy < sy + sh - 0.5; gy += cell) { const y = Math.round(gy) + 0.5; ctx.moveTo(sx, y); ctx.lineTo(sx + sw, y); }
      ctx.stroke();
    }
    ctx.strokeStyle = erasing ? "rgba(255, 115, 100, 0.98)" : "rgba(150, 235, 255, 0.98)";
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(sx) + 1, Math.round(sy) + 1, Math.max(1, Math.round(sw) - 2), Math.max(1, Math.round(sh) - 2));
    ctx.restore();
  }

  // Staged exact stockpile repaint preview (the stockpile mirror of the zoneRepaintDraft branch
  // in drawZonePaintPreview above): additions cyan, erasures red, retained through Accept. The
  // session state lives in dwf-controls-placement.js, which loads AFTER this file -- read it
  // throw-safe (the B199 accessor pattern) so a missing placement module degrades to "no
  // preview", never a ReferenceError that kills the overlay.
  function drawStockRepaintPreview(ctx) {
    let draft = null;
    try {
      if (stockRepaintId == null || stockRepaintRemoveArmed) return;
      draft = stockRepaintDraft;
    } catch (_) { return; }
    if (!draft || !draft.changes || !draft.changes.size) return;
    const rendered = renderedImageRect();
    if (!rendered || Number(rendered.oz) !== Number(draft.zone.z)) return;
    ctx.save();
    draft.changes.forEach((present, key) => {
      const [wx, wy] = key.split(",").map(Number);
      const gx = wx - Number(rendered.ox), gy = wy - Number(rendered.oy);
      if (gx < 0 || gy < 0 || gx >= rendered.gw || gy >= rendered.gh) return;
      const sx = rendered.left + gx * rendered.cell;
      const sy = rendered.top + gy * rendered.cell;
      ctx.fillStyle = present ? "rgba(90, 205, 255, 0.38)" : "rgba(235, 75, 65, 0.50)";
      ctx.fillRect(sx, sy, rendered.cell, rendered.cell);
      ctx.strokeStyle = present ? "rgba(150, 235, 255, 0.98)" : "rgba(255, 115, 100, 0.98)";
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(sx) + 1, Math.round(sy) + 1,
        Math.max(1, Math.round(rendered.cell) - 2), Math.max(1, Math.round(rendered.cell) - 2));
    });
    ctx.restore();
  }

  function drawBuildPreview(ctx) {
    if (!buildPreview) return;
    const rendered = renderedImageRect();
    if (!rendered) return;
    const cell = rendered.cell;
    const w = Math.max(1, buildPreview.w | 0), h = Math.max(1, buildPreview.h | 0);
    const gx0 = buildPreview.gx - Math.floor((w - 1) / 2);
    const gy0 = buildPreview.gy - Math.floor((h - 1) / 2);
    const data = tileRenderer && tileRenderer.getLatest ? tileRenderer.getLatest() : null;
    const gw = rendered.gw, gh = rendered.gh;
    const tiles = data && Array.isArray(data.tiles) ? data.tiles : null;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.lineWidth = 2;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const gx = gx0 + dx, gy = gy0 + dy;
        const sx = rendered.left + gx * cell, sy = rendered.top + gy * cell;
        let ok = gx >= 0 && gy >= 0 && gx < gw && gy < gh;
        if (ok && tiles) {
          const t = tiles[gy * gw + gx];
          if (t) {
            const shape = t.shape || "";
            if (t.hidden || shape === "WALL" || shape === "FORTIFICATION" ||
              shape === "EMPTY" || shape === "NONE" || (t.flow > 0)) ok = false;
          }
        }
        ctx.fillStyle = ok ? "rgba(90,220,110,0.26)" : "rgba(230,70,60,0.34)";
        ctx.fillRect(sx, sy, cell, cell);
        ctx.strokeStyle = ok ? "rgba(120,240,140,0.92)" : "rgba(240,90,80,0.96)";
        ctx.strokeRect(sx + 1, sy + 1, Math.max(1, cell - 2), Math.max(1, cell - 2));
      }
    }
    ctx.restore();
  }

  function renderZoneOverlay() {
    const ctx = resizeZoneOverlay();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    drawDragPreview(ctx);   // local rectangle selection (no-op with no active drag/anchor)
    drawBuildPreview(ctx);  // building footprint preview (no-op unless a build tool is hovering)
    // Staged stockpile repaint tiles: independent of the zone-overlay gate below (the pile itself
    // is rendered in the frame by the server, so there is no client footprint layer to wait for).
    drawStockRepaintPreview(ctx);
    const rendered = renderedImageRect();
    // Drive zone placement off the tile renderer's live window (origin == this player's camera,
    // cell == its zoom-aware tile size) rather than the HUD viewport, which under per-player
    // zoom reports the raw screen grid and would misalign. Snapshot camera is only used for its
    // z-level (which must match the rendered window's z).
    const cam = zoneSnapshotCamera || currentHud?.camera;
    // B78: a pending paint/repaint preview is an ACTIVE gesture and must stay visible even when the
    // passive zone overlay is toggled OFF. When the overlay is off there are no authoritative
    // footprints to layer under, so draw the preview here -- before the zone-sheet gate below --
    // and the early-return keeps it on screen. When the overlay is ON the footprints must paint
    // first and the preview sits ABOVE them (the staged-repaint z-order), so skip this early
    // draw in that case and let the tail call at the end of the function do it. Either path draws
    // the preview exactly once (no alpha double-compositing); drawZonePaintPreview self-gates on an
    // active session, so it is a no-op when nothing is being painted.
    const overlayOff = !zoneOverlayEnabled;
    if (overlayOff) drawZonePaintPreview(ctx);
    if (!zoneOverlayEnabled || !cam || !rendered || !zoneSheet.complete)
      return;
    const camX = Number(rendered.ox) || 0;
    const camY = Number(rendered.oy) || 0;
    const camZ = Number(rendered.oz);
    const vpW = rendered.gw;
    const vpH = rendered.gh;
    const cell = rendered.cell;
    ctx.imageSmoothingEnabled = false;

    for (const zone of currentZones) {
      if (Number(zone.z) !== camZ) continue;
      const zw = Number(zone.w) || 0;
      const zh = Number(zone.h) || 0;
      const zx = Number(zone.x) || 0;
      const zy = Number(zone.y) || 0;
      const stateCol = zone.active ? 2 : 0;
      let iconDrawn = false;
      for (let ly = 0; ly < zh; ly++) {
        for (let lx = 0; lx < zw; lx++) {
          if (!zoneExtentAt(zone, lx, ly)) continue;
          const wx = zx + lx;
          const wy = zy + ly;
          const tx = wx - camX;
          const ty = wy - camY;
          if (tx < 0 || ty < 0 || tx >= vpW || ty >= vpH) continue;
          const dx = Math.round(rendered.left + tx * cell);
          const dy = Math.round(rendered.top + ty * cell);
          const dw = Math.max(1, Math.round(rendered.left + (tx + 1) * cell) - dx);
          const dh = Math.max(1, Math.round(rendered.top + (ty + 1) * cell) - dy);
          ctx.drawImage(zoneSheet, stateCol * 32, zoneShapeRow(zone, lx, ly) * 32, 32, 32,
            dx, dy, dw, dh);
          if (!iconDrawn) {
            const ix = Math.max(0, Math.min(7, Number(zone.iconX) || 0));
            const iy = Math.max(0, Math.min(15, Number(zone.iconY) || 0));
            ctx.drawImage(zoneSheet, ix * 32, iy * 32, 32, 32,
              dx, dy, dw, dh);
            iconDrawn = true;
          }
        }
      }
    }
    drawZonePaintPreview(ctx); // pending exact repaint sits above the authoritative base footprint
  }

  async function loadZones() {
    if (!zoneOverlayEnabled) {
      currentZones = [];
      zoneSnapshotCamera = null;
      zoneSnapshotViewport = null;
      renderZoneOverlay();
      return;
    }
    try {
      // Scope the zone snapshot to our rendered tile window (w/h) so the server culls it to
      // what we can see + a pan margin, instead of shipping every zone across DF's whole native
      // viewport (a big win when zoomed in). Omit w/h if the render rect isn't ready yet -- the
      // server then falls back to native-viewport culling (its prior behavior).
      const rr = renderedImageRect();
      const dims = (rr && rr.gw > 0 && rr.gh > 0) ? `&w=${Math.round(rr.gw)}&h=${Math.round(rr.gh)}` : "";
      const response = await fetch(`/zones?player=${encodeURIComponent(player)}${dims}&t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("zones failed");
      const data = await response.json();
      currentZones = Array.isArray(data.zones) ? data.zones : [];
      zoneSnapshotCamera = data.camera || currentHud?.camera || null;
      zoneSnapshotViewport = data.viewport || currentHud?.viewport || null;
      renderZoneOverlay();
    } catch (_) {}
  }
  addEventListener("resize", renderZoneOverlay);
  view.addEventListener("load", renderZoneOverlay);

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function flashMapTile(pos) {
    if (!pos) return;
    await loadHud();
    await sleep(80);
    const rect = screenRectForMapTile(pos);
    if (!rect) return;
    tileFlash.style.left = `${rect.left}px`;
    tileFlash.style.top = `${rect.top}px`;
    tileFlash.style.width = `${rect.width}px`;
    tileFlash.style.height = `${rect.height}px`;
    for (let i = 0; i < 4; i++) {
      tileFlash.style.display = "block";
      await sleep(150);
      tileFlash.style.display = "none";
      await sleep(120);
    }
  }

  // Like imagePixelFromEvent but clamps to the window edges, so a drag that ends slightly
  // off the map still yields a valid corner tile for rectangle designation/placement.
  function imagePixelClamped(clientX, clientY) {
    if (!tileRenderer) return null;
    const g = tileRenderer.screenToGrid(clientX, clientY, true);
    if (!g) return null;
    return { x: g.gx, y: g.gy, w: g.gw, h: g.gh };
  }

  function selectionBuildingId(data) {
    const direct = Number(data?.buildingId ?? data?.building_id ?? -1);
    if (Number.isInteger(direct) && direct >= 0) return direct;
    const lines = Array.isArray(data?.lines) ? data.lines : [];
    for (const line of lines) {
      const m = String(line || "").match(/\bBuilding id:\s*(\d+)/i);
      if (m) return Number(m[1]);
    }
    return -1;
  }

  function showSelection(data) {
    const kind = String(data.kind || "").toLowerCase();
    const buildingId = selectionBuildingId(data);
    if (kind === "workshop" && buildingId >= 0) {
      openWorkshopPanel(buildingId);
      return;
    }
    if (kind === "unit" && data.unit) {
      showUnitSheet(data);
      return;
    }
    if (kind === "stockpile" && buildingId >= 0) {
      openStockpilePanel(buildingId);
      return;
    }
    if (kind === "building" && buildingId >= 0) {
      openBuildingPanel(buildingId, data);
      return;
    }
    if (kind === "item" && Number(data.itemId) >= 0) {
      openItemPanel(Number(data.itemId));
      return;
    }
    if (kind === "zone" && buildingId >= 0) {
      openZonePanel(buildingId);
      return;
    }
    // B246 (07-14): "Engravings I cannot click on." The click DID land -- an engraved tile
    // just fell through to the generic tile window below, which prints a tiletype name and a
    // coordinate and nothing about the engraving. An engraving is a TILE PROPERTY (df::engraving,
    // keyed on pos), not an occupant, so it had no kind and no panel. The server now resolves
    // engraved tiles to kind:"engraving"; this dispatches them at their TILE (never a pixel, so
    // opening the panel cannot move the camera -- B216).
    if (kind === "engraving" && data.tile && typeof openEngravingPanel === "function") {
      openEngravingPanel(data.tile, data);
      return;
    }
    const lines = Array.isArray(data.lines) ? data.lines : [];
    selection.className = "";
    const inspectBody = `<div class="kind">${escapeHtml(data.kind || "tile")}</div><h1>${escapeHtml(data.title || "Selection")}</h1>` +
      `<div class="line">Tile: ${data.tile.x}, ${data.tile.y}, ${data.tile.z}</div>` +
      lines.map(line => `<div class="line">${escapeHtml(line)}</div>`).join("");
    panelContent(selection).innerHTML = DWFUI.windowHtml({ cls: "tile-inspect-window", ariaLabel: data.title || "Selection", bodyHtml: inspectBody });
    selection.classList.add("visible");
  }

  function closeSelection() {
    selectedUnitData = null;
    selection.className = "";
    panelContent(selection).innerHTML = "";
  }

  // WT07 M7/M8: register #clientPanel and #selection with the panel framework. Deferred to
  // DOMContentLoaded because dwf-panelframe.js loads AFTER core.js in index.html; by then
  // window.DFPanelFrame exists. Both are contentHost panels (persistent header + .pf-content seam),
  // movable + resizable + X. They keep their CSS z-index (zBand:false) so the zone-editor/zone-
  // palette stacking (#selection.zone-panel z75 > palette z60) is preserved, and they do NOT join
  // the Esc stack (escClosable:false) -- their Esc back-out stays in the controls-placement cascade
  // branches, unchanged. persistOpen:false: these open by content, not a single opener, so only
  // geometry persists (per VARIANT, so a moved unit sheet doesn't drag the stockpile panel). The
  // class observer inside the framework drives syncOpenState from the writers' `visible` toggles,
  // so no writer needs to call it. menu:false keeps them out of the cog Panels list (no meaningful
  // single reopen -- the toolbar buttons reopen each sub-panel as before).
  function registerContentHosts() {
    if (!window.DFPanelFrame || !window.DFPanelFrame.register) return;
    const PV = window.DFPanelFrame._pure.primaryVariant;
    const CLIENT_VARIANTS = ["build-panel", "squads-sidebar", "reports-window", "alertbox-panel", "fort-window", "info-panel"];
    const SELECTION_VARIANTS = ["tile-list-panel", "stock-item-panel", "unit-sheet-panel", "stockpile-panel",
      "zone-panel", "farm-panel", "workshop-panel", "td-depot-panel", "hosp-panel", "building-panel"];
    // ---- WAVE 4: THE CLOSE-LESS (ESC-ONLY) SELECTION VARIANTS -----------------------------------
    // Native has NO close X on the unit profile (all 24 `steam *` profile captures) or the
    // stock-item sheet (both item-sheet oracles). The player presses ESC -- and ESC already closes
    // #selection here: dwf-controls-placement.js's Esc cascade calls closeSelection().
    //
    // Until now `closable: true` applied to ALL TEN skins of this one registration, and PanelFrame's
    // head adoption is CONDITIONAL on the skin owning a close -- so a skin that DELETED its X lost
    // adoption, UN-HID the generated "Selection" title bar, and got a FRESH framework ✕ stacked on
    // it. Deleting the non-native chrome therefore ADDED non-native chrome. S1 and S4 each hit this
    // independently, and each correctly kept its X and filed the gap rather than hand-roll around it.
    //
    // `closable` is now a PREDICATE of the live element (dwf-panelframe.js closableFor), so
    // these two variants declare "no close chrome at all; ESC dismisses me" and BOTH gates agree:
    // no framework X is generated, and their headers are adopted WITHOUT a close. The end state is
    // ZERO close affordances and ZERO framework title bar.
    //
    // TEARDOWN ON THE ESC PATH IS NOT AN ASSUMPTION. closeSelection() clears #selection's class
    // list and selectedUnitData, and the unit sheet's 3s refresh tick OPENS with
    // `if (!unitSheetStillOpen(id)) { stopUnitSheetRefresh(); return; }` -- a self-terminating guard
    // that reads exactly those two things and runs BEFORE its fetch. So an ESC close issues NO
    // further /unit request and the interval clears itself on the next tick, with or without a
    // close button. (panel_frame_test pins both halves; unitsheet_live_test pins the tick guard.)
    //
    // This is INERT until a family deletes its own X: while a skin still renders one, it remains the
    // single close and nothing changes. It is the shared half of the change; the JS half is theirs.
    // B217 r2: the zone family joins them -- NO native zone panel carries a close X (B217-2,
    // Z12-jt-1/3/4, Z11-19/20/21, LEVER-LINK-1/3, the barracks oracle). The zone skins' .bld-head
    // (the native name row / back-arrow row) is still adopted as the drag handle; lever-link and
    // cage ride the zone-panel chassis with their OWN markup X, which keeps working -- this only
    // stops the framework from generating one.
    const ESC_ONLY_SELECTION_VARIANTS = ["unit-sheet-panel", "stock-item-panel", "zone-panel"];
    const selectionClosable = el =>
      !ESC_ONLY_SELECTION_VARIANTS.includes(PV(el.className, SELECTION_VARIANTS));
    const clientFillSel = el => {
      const variant = PV(el.className, CLIENT_VARIANTS);
      if (variant === "build-panel") return ".build-cats,.build-items,.build-detail";
      if (variant === "squads-sidebar") return el.classList.contains("squads-wide") ? ".sq-body" : [".sq-list", ".sq-body"];
      if (variant === "fort-window") return [
        ".kitchen-scroll,.so-list,.stone-list", ".fort-scroll", ".fort-candidate-list", ".fort-body"
      ];
      if (variant === "reports-window") return ".info-body";
      // B232 R2: the native alert box (oracle B232-oracle-native.png) -- its scroll region is the
      // announcement-lines box.
      if (variant === "alertbox-panel") return ".alertbox-lines";
      if (variant === "info-panel") return [
        ".wo-tasks", ".wo-screen", ".wo-list", ".info-main", ".stocks-detail", ".stocks-list", ".info-body"
      ];
      return null;
    };
    const selectionFillSel = el => {
      const variant = PV(el.className, SELECTION_VARIANTS);
      if (variant === "tile-list-panel") return ".pf-content";
      if (variant === "stock-item-panel") return ".stock-item-body";
      if (variant === "unit-sheet-panel") return ".unit-grid,.unit-list-grid,.unit-structured-list,.unit-text-block,.unit-prose-block,.unit-skill-list,.unit-knowledge-list";
      if (variant === "stockpile-panel") return ".sp-targets";
      if (variant === "zone-panel") return ".zone-unit-list,.sp-targets";
      if (variant === "farm-panel") return ".farm-crop-list,.farm-seed-stock";
      if (variant === "workshop-panel") return [".workshop-task-grid", ".workshop-task-list", ".workshop-list.compact", ".workshop-body"];
      if (variant === "td-depot-panel") return [".td-goods-list", ".pf-content"];
      if (variant === "hosp-panel") return [".hosp-candidate-list", ".pf-content"];
      if (variant === "building-panel") return ".pf-content";
      return null;
    };
    // B159 adoptHeadSel: when the live skin renders one of these headers, the framework ADOPTS it
    // (drag binds to the skin header; the generated bar hides) instead of stacking a "Selection"/
    // "Info" bar above it that covers the skin's host-anchored close/name. Skins WITHOUT a header
    // here (base selection, tile-list chooser, squads sidebar) keep the generated bar + X.
    // B232 R2: the native alert box has NO close X of any kind (oracle B232-oracle-native.png --
    // "Right click to close.", plus the Esc cascade). Same variant-aware close-less pattern as
    // ESC_ONLY_SELECTION_VARIANTS: no framework X is generated, and its hint line is adopted as
    // the head so the generated "Info" title bar stays hidden.
    const clientClosable = el => PV(el.className, CLIENT_VARIANTS) !== "alertbox-panel";
    // GEOMETRY-SLOT CONTRACT (movable/resizable content host): the framework persists ONE saved rect
    // per variantKey and restores it on reopen. PV(className, CLIENT_VARIANTS) deliberately collapses
    // EVERY squads view to "squads-sidebar" -- clientFillSel and clientClosable (above) DEPEND on that
    // collapse, so CLIENT_VARIANTS MUST NOT grow the wide-modifier tokens. But the ~300px root list and
    // the wide deep editors (schedule / routines / monthly / equip / candidate, up to ~2048px) are
    // DIFFERENT WIDTHS and must not share one slot: a saved narrow rect otherwise freezes an inline
    // width onto the wide editors and their multi-column grids collapse into one stacked column (the
    // reported bug). So variantKey appends a width-TIER suffix off the family's OWN host-flag classes
    // (dwf-squads.js:1729): squads-wide is the base wide flag, -contextual (side-by-side routine
    // columns) and -equipment (widest) are its tiers. A list<->wide flip now CHANGES the key, which
    // makes the observer clearRectStyles and re-clamp to the wide CSS default (dwf.css:4623), and each
    // tier persists its own move/resize geometry. One-time migration: any pre-existing
    // "clientPanel.squads-sidebar" rect becomes the LIST's slot; wide editors restart from CSS defaults
    // (desired). Non-squads client skins carry no squads-wide, so their keys are unchanged.
    window.DFPanelFrame.register({
      key: "clientPanel", el: () => clientPanel, title: "Info",
      contentHost: true, movable: true, closable: clientClosable, menu: false,
      adoptHeadSel: ".build-head,.info-header,.alertbox-hint",
      resizable: { minW: 240, minH: 140 }, zBand: false, escClosable: false, persistOpen: false,
      fillSel: clientFillSel,
      variantKey: el => {   // base variant + width-tier suffix (see GEOMETRY-SLOT CONTRACT above)
        let key = "clientPanel." + PV(el.className, CLIENT_VARIANTS);
        if (el.classList.contains("squads-wide"))
          key += el.classList.contains("squads-contextual") ? ".ctx"
               : el.classList.contains("squads-equipment") ? ".equip"
               : ".wide";
        return key;
      },
      isOpen: () => clientPanel.classList.contains("visible"),
      close: () => { if (typeof closeClientPanel === "function") closeClientPanel(); },
    });
    // Same GEOMETRY-SLOT CONTRACT as clientPanel above: PV keeps returning "zone-panel" for every zone
    // skin (selectionFillSel / selectionClosable / ESC_ONLY_SELECTION_VARIANTS depend on it, so
    // SELECTION_VARIANTS must NOT grow "zone-wide"), but the 420px zone info panel and the 620px wide
    // sub-panels (squad / animal / owner -- dwf.css:1293 vs 1310) must not share one slot. variantKey
    // appends ".wide" off the family's own zone-wide host flag so the two tiers persist independent
    // geometry and a narrow<->wide flip re-clamps to the correct CSS width. Non-zone selection skins
    // carry no zone-wide, so their keys are unchanged.
    window.DFPanelFrame.register({
      key: "selection", el: () => selection, title: "Selection",
      contentHost: true, movable: true, closable: selectionClosable, menu: false,
      adoptHeadSel: ".unit-sheet-header,.stock-item-header,.sp-header,.farm-native-head,.bld-head",
      resizable: { minW: 240, minH: 140 }, zBand: false, escClosable: false, persistOpen: false,
      fillSel: selectionFillSel,
      variantKey: el => "selection." + PV(el.className, SELECTION_VARIANTS) +
        (el.classList.contains("zone-wide") ? ".wide" : ""),
      isOpen: () => selection.classList.contains("visible"),
      close: () => { if (typeof closeSelection === "function") closeSelection(); },
    });
    // The DOM half of DWFUI boots HERE, with the panel framework, on the same ready path. See below.
    if (window.DWFUI && typeof window.DWFUI.mountDom === "function") window.DWFUI.mountDom(document);
  }
  // ---- FB-2: THE CENTRAL BOOT OF DWFUI'S DOM HALF ----------------------------------------------
  // THIS IS THE ONE SITE. DWFUI's four DOM members (paintSprites / mountScrollbarArt / restoreScroll
  // / restoreSearchCaret) shipped with ZERO CALLERS in web/js: the builders emitted sprite spans and
  // NOTHING EVER PAINTED THEM. Consequences in the live client, both real:
  //   * the BUTTON_FILTER search magnifier on workshop-picker/{all,filtered,no-results} -- THREE OF
  //     THE 13 APPROVED ANCHORS -- rendered as an EMPTY BOX. A visible control became invisible.
  //   * the native scrollbar rendered colour-correct and ART-LESS (the SCROLLBAR_* cells never blit).
  // Parity Studio called the four itself, which is exactly why the gallery looked right and the
  // product did not.
  //
  // WHY HERE, and not in each panel:
  //   * core.js already OWNS the shared render seam. `panelContent(host)` (line ~60) is the one
  //     indirection every panel writer funnels through, and registerContentHosts() is where the panel
  //     framework is brought up. This is the render/boot pipeline, so it is where the DOM half boots.
  //   * a per-panel sprinkle is a FAILED FIX: it rots the moment someone adds a panel, and it would
  //     ALREADY miss dwf-kitchen.js and dwf-help-panel.js, which emit magnifiers WITHOUT
  //     going through panelContent(). DWFUI.mountDom() installs one document-wide MutationObserver,
  //     so every surface -- present and future, whatever route its markup took -- gets it for free.
  //   * it costs nothing per frame: the map is a <canvas>, so the 30fps render path mutates no DOM
  //     and the observer sits idle while the game runs (AGENTS.md's CoreSuspender/per-frame rule).
  // DWFUI and DFChrome both load before this runs (index.html: ui-components, then core, then
  // chrome; this fires on DOMContentLoaded). If DWFUI is absent -- an old cached page -- mountDom is
  // simply not called and the client behaves exactly as it did before, which is the same graceful
  // degradation panelContent() already has.
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", registerContentHosts);
  else registerContentHosts();
