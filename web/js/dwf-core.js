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
  function normalizeStoredName(v) {
    if (typeof v !== "string" || !v) return v;
    if (!/%[0-9A-Fa-f]{2}/.test(v)) return v;   // no escape sequence -> already raw
    try { return decodeURIComponent(v); } catch { return v; }
  }
  const stored = normalizeStoredName(window.DwfUtil.lsGet("dwf.player", err => { throw err; }));
  const fresh = (crypto.randomUUID ? crypto.randomUUID() :
    `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`);
  // `let`, not const: hello_ack can hand back a server-deduped name and __dwfAdoptName rebinds it.
  // Persist only a name the player chose -- storing the fresh fallback makes a UUID the page's name.
  let player = stored || params.get("player") || fresh;
  window.playerName = player;
  window.__dwfAdoptName = function (name) {
    if (typeof name === "string" && name && name !== player) { player = name; window.playerName = name; }
  };
  function playerIdentity(mode) {
    if (player) return player;
    if (mode === "unitcycle") {
      try { if (window.DFPlayerKey) return window.DFPlayerKey; }
      catch { /* an inaccessible legacy key falls through to stored identity */ }
    }
    if (mode === "hotkeys" || mode === "unitcycle") {
      try {
        const urlPlayer = new URLSearchParams(location.search).get("player");
        if (urlPlayer) return urlPlayer;
      } catch { return ""; }
      return window.DwfUtil.lsGet("dwf.player") || "";
    }
    if (mode === "chat") {
      try { return window.playerName || ""; } catch { return ""; }
    }
    return "";
  }
  window.dwfPlayerIdentity = playerIdentity;

  async function dwfRequest(path, query = {}, options = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (options.includeEmpty || (value != null && value !== ""))
        params.set(key, value == null ? "" : String(value));
    }
    const existing = options.preserveExistingQuery === false
      ? new URLSearchParams()
      : new URLSearchParams(path.split("?", 2)[1] || "");
    if (options.player != null && !existing.has("player") && !params.has("player"))
      params.set("player", String(options.player));
    if (options.bust) params.set("t", String(Date.now()));
    const suffix = params.toString();
    const separator = options.preserveExistingQuery === false ? "?" : (path.includes("?") ? "&" : "?");
    return fetch(suffix ? `${path}${separator}${suffix}` : path,
      Object.assign({ cache: options.cache || "no-store" }, options.method ? { method: options.method } : {}));
  }
  async function dwfGetJson(path, query = {}, options = {}) {
    const response = await dwfRequest(path, query, {
      player, bust: options.bust, cache: options.cache, preserveExistingQuery: false,
    });
    if (!response.ok) throw new Error(`${path} failed (${response.status})`);
    return response.json();
  }
  async function queryJson(path, query = {}, options = {}) {
    const response = await dwfRequest(path, query, {
      player: options.player, bust: options.bust, method: options.method,
      includeEmpty: options.includeEmpty,
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch (err) { DwfErr.report("transport.response-json", err); }
    return { response, text, data };
  }
  window.DwfCoreTransport = Object.freeze({ queryJson });
  const reportTransport = Object.freeze({
    reportsPage(query = {}) {
      return dwfGetJson("/reports", query, { bust: true });
    },
    unitReportsPage(unitId, query = {}) {
      return dwfGetJson("/combat-reports", { unit: unitId, ...query }, { bust: true });
    },
  });
  window.DwfReportTransport = reportTransport;

  function finiteRosterNumber(v) {
    return (typeof v === "number" && Number.isFinite(v)) ? v : null;
  }
  function presenceCamera(p, options) {
    if (!p) return null;
    options = options || {};
    const round = !!options.round;
    const hasCamShape = p.camx !== undefined || p.camy !== undefined || p.camz !== undefined;
    let x = finiteRosterNumber(p.camx), y = finiteRosterNumber(p.camy), z = finiteRosterNumber(p.camz);
    if (hasCamShape) {
      if (x === null || y === null || z === null) return null;
    } else {
      x = finiteRosterNumber(p.x); y = finiteRosterNumber(p.y); z = finiteRosterNumber(p.z);
      if (x === null || y === null || z === null) return null;
    }
    return round ? { x: Math.round(x), y: Math.round(y), z: Math.round(z) } : { x, y, z };
  }
  function presencePlayerColor(name) {
    try {
      if (window.DwfTiles && typeof window.DwfTiles.playerColor === "function")
        return window.DwfTiles.playerColor(name).fill;
    } catch (err) { DwfErr.report("presence.player-color", err); }
    return "#8cf";
  }
  window.DwfCore = Object.freeze({ finiteRosterNumber, presenceCamera, playerColor: presencePlayerColor });

  const view = document.getElementById("view");
  const zoneOverlay = document.getElementById("zoneOverlay");
  const selection = document.getElementById("selection");
  const clientPanel = document.getElementById("clientPanel");
  const tileFlash = document.getElementById("tileFlash");
  // The ONE shared indirection every panel writer targets, so the framework header survives a re-render.
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

  // DF's search filter: case-insensitive and TOKEN-based over the FULL display string, so a row matches
  // iff every query token appears somewhere in it, in any order. Empty query matches everything.
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
  let zoneOverlayEnabled = false;
  let instantDesignate = true;
  { const v = window.DwfUtil.lsGet("dfplex.instantDesignate"); if (v !== null) instantDesignate = v === "1"; }
  // Live drag selection rectangle in GRID-TILE space (ax/ay/bx/by are tile indices), or null.
  // Drawn on #zoneOverlay by drawDragPreview().
  let dragPreview = null;
  // World-addressed multi-z designation rectangle, so it survives z moves/pans.
  let stairRangePreview = null;
  // ---- Predictive camera panning: shift the displayed frame by (frameCam - predictedCam) tiles. ----
  // Default OFF: over a laggy link the reconcile lags, and clicks stop landing where the image shows.
  let predictivePan = false;
  { const v = window.DwfUtil.lsGet("dfplex.predictivePan"); predictivePan = (v === null) ? false : (v === "1"); }
  let unitImagesEnabled = true;
  unitImagesEnabled = window.DwfUtil.lsGet("dfplex.unitImages") !== "0";
  let predictedCam = null;          // where the camera "should" be from local input {x,y,z}
  let frameCam = null;              // camera the currently shown frame was rendered at {x,y,z}
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
    view.style.setProperty("--dwf-map-pan-x", x + "px");
    view.style.setProperty("--dwf-map-pan-y", y + "px");
    view.toggleAttribute("data-dwf-map-panning", !!(x || y));
  }
  function clearPanPrediction() { setPanOffset(0, 0); }
  function resetPanPrediction() { predictedCam = null; clearPanPrediction(); }
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
    applyPanPrediction();
  }
  let pinnedAlertKey = null;
  // notificationFilterType is gone with the dashboard -- the native alert box has no
  // filter modes. lastNotificationPanelSignature still de-dupes the box's poll re-renders.
  let lastNotificationPanelSignature = "";
  let selectedUnitData = null;
  let activeUnitTab = "Overview";
  let activeUnitDetailTab = null;
  let activeInfoPanel = null;
  let activeInfoSection = null;
  let activeInfoDetail = null;
  if (typeof window !== "undefined") window.dwfInfoState =
    () => ({ panel: activeInfoPanel, section: activeInfoSection, detail: activeInfoDetail });
  let activeStockCategory = "";
  let stocksSearchQuery = ""; // Stocks window search field (filters categories + items)
  let activeWorkshopTab = "tasks";
  let workshopAddMode = false;
  let workshopOrderAddMode = false;
  let workshopTaskSearch = ""; // filter box for the workshop add-task / work-order picker
  let workshopTreePath = []; // forge drill-down path [catIdx, metalIdx] (empty = root)
  // null = at the root; a task key = that container's submenu is open.
  let workshopFlatCat = null;
  let workshopUnitPick = null;
  let workshopRenameMode = false; // inline custom-name editor open on the workshop panel
  let workshopStatusMsg = "";
  let workshopStatusIsError = false;
  // links flow: the linked-stockpiles side window + its armed map-click mode.
  let workshopLinksOpen = false;
  let workshopLinkArmMode = null; // null | 'take' (shop takes from clicked pile) | 'give'
  function focusPage() {
    try { view.focus({ preventScroll: true }); } catch (err) { DwfErr.report("core.map-focus", err); }
  }
  setTimeout(focusPage, 0);

  // ---- Map surface: dwf-tiles.js draws to #view; this file owns camera and designation input. ----
  let tileRenderer = null;
  // The zone sheet comes from DFChrome's ONE sheet cache, not a second private Image(). DFChrome
  // loads after this file, so the handle is taken on first draw rather than at parse time.
  const ZONE_SHEET = "activity_zones.png";
  let zoneSheet = null;
  function zoneSheetImage() {
    const chrome = window.DFChrome;
    if (zoneSheet || !chrome || typeof chrome.sheetImage !== "function") return zoneSheet;
    zoneSheet = chrome.sheetImage(ZONE_SHEET);
    if (!zoneSheet.complete)
      zoneSheet.addEventListener("load", () => renderZoneOverlay(), { once: true });
    return zoneSheet;
  }

  // Force an immediate /mapdata refetch so a camera pan/zoom/reset shows the new view without
  // waiting out the renderer's ~500ms poll cadence. No-op until the renderer exists.
  function refreshMap() {
    if (tileRenderer && typeof tileRenderer.refresh === "function") tileRenderer.refresh();
  }
  const step = 10;         // d_init.horizontal/vertical_scroll_speed default -- one pan key = 10 tiles
  const PAN_FAST_MULT = 2; // *_scroll_speed_fast default 20 => exactly 2x (was a client-only 3x)
  const zstep = 1;         // CURSOR_UP_Z / CURSOR_DOWN_Z
  const ZSTEP_FAST = 10;   // CURSOR_UP_Z_FAST / CURSOR_DOWN_Z_FAST -- hardcoded +-10 in DF
  let queued = { dx: 0, dy: 0, dz: 0 };
  let sending = false;
  let moveWaiters = [];

  // A designation released right after Shift+wheel must not race the camera POST that sets the range's
  // other z endpoint: the designation path awaits this, ordinary navigation ignores it.
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
    if (!opts || opts.followBreak !== false) stopPlayerFollow();
    notePanInput(dx, dy, dz);   // instant predictive shift before the server round-trip
    // on protocol v1, re-window the canvas from the world cache at the new position
    // IMMEDIATELY (no wire wait) -- a no-op under legacy (unchanged, server-push-driven).
    try { if (tileRenderer && typeof tileRenderer.noteCamDelta === "function") tileRenderer.noteCamDelta(dx, dy, dz); }
    catch (err) { DwfErr.report("camera.note-delta", err); }
    queued.dx += dx;
    queued.dy += dy;
    queued.dz += dz;
    // Re-project a pending rectangle gesture from its WORLD anchor: its far corner is the LIVE camera's.
    try { if (window.DFGestureCameraMoved) window.DFGestureCameraMoved(dx, dy, dz); }
    catch (err) { DwfErr.report("camera.gesture-notify", err); }
    if (sending) return;
    sending = true;
    requestAnimationFrame(flushMove);
  }

  function sendCameraWS() {
    try {
      if (!(window.DwfWS && typeof DwfWS.isConnected === "function" && DwfWS.isConnected())) return false;
      const cam = (tileRenderer && typeof tileRenderer.getDesiredCam === "function") ? tileRenderer.getDesiredCam() : null;
      if (!cam) return false;
      return !!DwfWS.send({ type: "cam", x: cam.x | 0, y: cam.y | 0, z: cam.z | 0 });
    } catch { return false; }
  }

  // An order the player gave that never reached the game is not telemetry: they must be told, on the
  // one shared toast host, or they re-issue it into a void. DwfErr (dwf-util.js) does the counting.
  let lostToastMessage = "";
  let lostToast = null;
  function noteOrderLost(key, err, what) {
    DwfErr.report(key, err);
    try {
      if (window.DwfPause && typeof DwfPause.toast === "function") {
        const message = `${what || "That order"} did not reach the game. Check the connection.`;
        if (message === lostToastMessage && lostToast && typeof lostToast.refresh === "function" && lostToast.refresh()) return;
        lostToastMessage = message;
        lostToast = DwfPause.toast(message);
      }
    } catch { DwfErr.count("order-lost.toast"); }
  }
  // `fetch` rejects only on a NETWORK failure, so a catch alone lets an HTTP 500 read as success.
  // The contract's one test is non-2xx OR ok:false; this is the status half, shared by every camera write.
  function noteCameraHttpResult(r, label) {
    try {
      if (!r || r.ok) return;
      DwfErr.report(`camera.${label}`, `HTTP ${r.status}`);
      if (r.status === 401) {
        if (window.DwfAuth && typeof DwfAuth.onAuthFail === "function") DwfAuth.onAuthFail();
        else if (window.DwfJoin && typeof DwfJoin.onAuthFail === "function") DwfJoin.onAuthFail();
      }
    } catch { DwfErr.count("camera.surface-failed"); }
  }
  try { window.DwfOrder = { lost: noteOrderLost, cameraHttpResult: noteCameraHttpResult }; }
  catch { /* non-browser context */ }

  function noteCameraHttpError(err, label) {
    DwfErr.report(`camera.${label}`, err);
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
        noteCameraHttpResult(r, "pan");
      } catch (err) { noteCameraHttpError(err, "pan"); }
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
    stopPlayerFollow();
    resetPanPrediction();
    try {
      const r = await fetch(`/reset?player=${encodeURIComponent(player)}`, { method: "POST", cache: "no-store" });
      noteCameraHttpResult(r, "reset");
    } catch (err) { noteCameraHttpError(err, "reset"); }
    refreshMap();
    loadHud();
    if (zoneOverlayEnabled) loadZones();
  }


  // ---- Spectate / follow-player camera: client-only, and any manual camera move exits the lock. ----
  const PLAYER_FOLLOW_TICK_MS = 250;
  const PLAYER_FOLLOW_POST_MIN_MS = 250;
  const PLAYER_FOLLOW_DEADBAND_TILES = 1;

  let playerFollow = null;      // { name, label, lastSent, lastPostAt, timer, busy }
  const playerFollowSubs = [];
  let playerFollowIndicator = null;

  function playerCameraFromPresence(p) {
    return window.DwfCore.presenceCamera(p, { round: true });
  }

  function findPresencePlayer(name) {
    try {
      const roster = (window.DwfPresence && Array.isArray(DwfPresence.roster)) ? DwfPresence.roster : [];
      for (let i = 0; i < roster.length; i++) {
        const p = roster[i];
        if (p && String(p.name || "") === String(name || "")) return p;
      }
    } catch (err) { DwfErr.report("presence.roster-read", err); }
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
      try { playerFollowSubs[i](state); } catch (err) { DwfErr.report("presence.follow-subscriber", err); }
    }
  }

  function ensurePlayerFollowIndicator() {
    if (playerFollowIndicator) return playerFollowIndicator;
    try {
      playerFollowIndicator = document.createElement("div");
      playerFollowIndicator.id = "dfPlayerFollowIndicator";
      const text = document.createElement("span");
      const stop = document.createElement("button");
      stop.type = "button";
      stop.textContent = "Stop";
      stop.addEventListener("click", event => {
        event.preventDefault();
        stopPlayerFollow();
        focusPage();
      });
      playerFollowIndicator.appendChild(text);
      playerFollowIndicator.appendChild(stop);
      document.body.appendChild(playerFollowIndicator);
    } catch (err) { DwfErr.report("presence.follow-indicator-create", err); }
    return playerFollowIndicator;
  }

  // The hoverInfo guard must read getComputedStyle(hv).display, never offsetParent: hoverInfo is
  // position:fixed, and offsetParent is spec-NULL for a fixed element even while it is visible.
  function positionPlayerFollowIndicator() {
    const el = playerFollowIndicator;
    if (!el || el.hidden) return;
    const zoom = parseFloat(getComputedStyle(el).zoom) || 1;
    let top = 96;
    try {
      const hv = document.getElementById("hoverInfo");
      if (hv && getComputedStyle(hv).display !== "none") {
        const r = hv.getBoundingClientRect();
        if (r.height > 0) top = Math.max(top, Math.ceil((r.bottom + 8) / zoom));
      }
    } catch { DwfErr.count("presence.follow-indicator-place"); }
    el.style.setProperty("--follow-indicator-top", top + "px");
  }

  function renderPlayerFollowIndicator() {
    const el = ensurePlayerFollowIndicator();
    if (!el) return;
    if (!playerFollow) { el.hidden = true; return; }
    const text = el.querySelector("span");
    if (text) text.textContent = `Following ${playerFollow.label || playerFollow.name} - move to stop`;
    el.hidden = false;
    positionPlayerFollowIndicator();
  }

  async function setOwnCameraAbsolute(cam) {
    if (!cam) return false;
    resetPanPrediction();
    try { if (tileRenderer && typeof tileRenderer.setCamAbsolute === "function") tileRenderer.setCamAbsolute(cam.x, cam.y, cam.z); }
    catch (err) { DwfErr.report("camera.set-absolute", err); }
    // WS primary: setCamAbsolute above has already set desiredCam to this absolute cam, so
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
      noteCameraHttpResult(r, "follow");
      refreshMap();
      loadHud();
      if (zoneOverlayEnabled) loadZones();
      return !r || r.ok !== false;
    } catch (err) {
      noteCameraHttpError(err, "follow");
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
    stopPlayerFollow();
    return setOwnCameraAbsolute(cam);
  }

  function followPresencePlayer(name) {
    const p = findPresencePlayer(name);
    if (!p || p.self) return false;
    const cam = playerCameraFromPresence(p);
    if (!cam) return false;
    stopPlayerFollow();
    const rawFollowName = String(p.name || name);
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

  function stopPlayerFollow() {
    if (!playerFollow) return false;
    if (playerFollow.timer) window.clearInterval(playerFollow.timer);
    playerFollow = null;
    renderPlayerFollowIndicator();
    emitPlayerFollowChange();
    return true;
  }

  function togglePresenceFollow(name) {
    if (playerFollow && playerFollow.name === String(name || "")) return stopPlayerFollow();
    return followPresencePlayer(name);
  }

  function getPlayerFollowState() {
    return playerFollow ? { following: true, name: playerFollow.name, label: playerFollow.label } : { following: false, name: "", label: "" };
  }

  function onPlayerFollowChange(cb) {
    if (typeof cb === "function") {
      playerFollowSubs.push(cb);
      try { cb(getPlayerFollowState()); } catch (err) { DwfErr.report("presence.follow-subscribe", err); }
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
  } catch (err) { DwfErr.report("core.touch-nav-export", err); }

  // ---- View zoom: the renderer's px/tile, which resizes the /mapdata window. ----
  // Shift the camera by -delta/2 so the CENTRE of the view stays fixed instead of growing off top-left.
  function applyZoomResult(d) {
    try { window.dispatchEvent(new CustomEvent("dwf-zoom-changed")); }
    catch (err) { DwfErr.report("camera.zoom-changed-event", err); }
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

  // ---- nav debug hooks --------------------------------------------------------------------
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
  try { window.__wa_nav = { pan: _navPan, zoom: _navZoom, zmove: _navZmove, stats: _navStats }; } catch { /* non-browser context */ }

  // ---- Camera hooks for the touch-gesture layer (dwf-touch.js). ----
  function zoomViewToPx(px) {
    if (!tileRenderer || typeof tileRenderer.zoomTo !== "function") return;
    // A pinch held past the renderer's clamp keeps returning {0,0}; skipping applyZoomResult avoids its
    // else-branch refreshMap(), which would refetch /mapdata ~20x/s for the whole clamped stretch.
    const before = getZoomPx();
    const d = tileRenderer.zoomTo(px);
    if (getZoomPx() !== before) applyZoomResult(d);
  }
  function getZoomPx() {
    try {
      const z = (tileRenderer && typeof tileRenderer.getZoom === "function") ? tileRenderer.getZoom() : null;
      return z ? z.px : 24;
    } catch { return 24; }
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
  } catch { /* non-browser context */ }

  function centerOnCursor(clientX, clientY) {
    stopPlayerFollow();
    if (!tileRenderer || typeof tileRenderer.screenToGrid !== "function") return;
    const g = tileRenderer.screenToGrid(clientX, clientY, true);
    const rr = tileRenderer.getRenderRect ? tileRenderer.getRenderRect() : null;
    if (!g || !rr) return;
    const worldX = Number(rr.ox) + g.gx, worldY = Number(rr.oy) + g.gy;
    const nx = Math.round(worldX - rr.gw / 2), ny = Math.round(worldY - rr.gh / 2);
    resetPanPrediction();
    try { if (tileRenderer && typeof tileRenderer.setCamAbsolute === "function") tileRenderer.setCamAbsolute(nx, ny, rr.oz); }
    catch (err) { DwfErr.report("camera.set-absolute", err); }
    // WS primary: setCamAbsolute set desiredCam to (nx,ny,rr.oz); broadcast it. HTTP only
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

  // handleCameraKey is CAPTURE-phase on `window` and stopImmediatePropagation, so it must YIELD here
  // while the 3D viewer is open; a listener on the overlay cannot fix it, because capture runs first.
  function world3DOwnsInput() {
    try { return !!(window.DFWorld3D && window.DFWorld3D.isOpen && window.DFWorld3D.isOpen()); }
    catch { return false; }
  }

  function helpModalOwnsInput() {
    try { return !!document.getElementById("helpPopup")?.classList.contains("open"); }
    catch { return false; }
  }

  // One wheel action per animation frame: DF's SDL pump honours at most one wheel event per pass, and a
  // trackpad stream would otherwise rip through ten z-levels (a hundred with Shift).
  let wheelPumpUsed = false;
  function wheelPumpAllows() {
    if (wheelPumpUsed) return false;
    wheelPumpUsed = true;
    const release = () => { wheelPumpUsed = false; };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(release);
    else setTimeout(release, 16);
    return true;
  }
  // Exported so the parity harness can drive the gate without a rAF-bearing DOM.
  try { window.__dwfWheelPumpAllows = wheelPumpAllows; } catch { /* non-browser context */ }

  function handleCameraKey(event) {
    if (!event || isTextEditingTarget(event.target)) return false;
    if (helpModalOwnsInput()) return false;
    if (world3DOwnsInput()) return false;
    // Never hijack browser shortcuts (Ctrl/Alt/Meta combos, e.g. Ctrl+Shift+R). Shift is NOT
    // excluded -- we use it for fast pan.
    if (event.altKey || event.metaKey || event.ctrlKey) return false;
    const pan = event.shiftKey ? step * PAN_FAST_MULT : step;
    switch (event.key) {
      // Arrow keys are DF's STANDARDSCROLL_*; w/a/s/d are a client-only extra that collides with nothing.
      // h/j/k/l/q are NOT pan keys here -- they are DF fort-tool hotkeys owned by dwf-controls-placement.js.
      case "ArrowLeft": case "a": case "A":
        queueMove(-pan, 0, 0); return true;
      case "ArrowRight": case "d": case "D":
        queueMove(pan, 0, 0); return true;
      case "ArrowUp": case "w": case "W":
        queueMove(0, -pan, 0); return true;
      case "ArrowDown": case "s": case "S":
        queueMove(0, pan, 0); return true;
      // e/c are CURSOR_UP_Z/DOWN_Z; E/C are DF's FAST pair (+-10 z, hardcoded), not aliases of e and c.
      case "PageUp": case ">": case "e":
        queueMove(0, 0, zstep); return true;
      case "PageDown": case "<": case "c":
        queueMove(0, 0, -zstep); return true;
      case "E":
        queueMove(0, 0, ZSTEP_FAST); return true;
      case "C":
        queueMove(0, 0, -ZSTEP_FAST); return true;
      // ZOOM (view scale) -> client px/tile in the tile renderer, centered on the view.
      // [ and ] are DF's real ZOOM_IN/ZOOM_OUT; =/+/-/_ are client-only aliases (non-DF).
      case "[": case "=": case "+":
        zoomView("in"); return true;
      case "]": case "-": case "_":
        zoomView("out"); return true;
      // Home resets to the host camera -- a client-only concept, and the only keyboard way to do it.
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
      if (helpModalOwnsInput()) {
        // Let ordinary wheel input scroll Help. Block only the browser's Ctrl/Cmd page zoom;
        // neither form may reach map zoom or z-level navigation behind the modal.
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      // Wheel parity: plain = +-1 z, Shift = +-10 z (hardcoded), Ctrl = map zoom.
      // Ctrl+wheel stays intercepted everywhere -- it is also the browser page zoom, which blurs the game UI.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!wheelPumpAllows()) return;
        zoomView(event.deltaY < 0 ? "in" : "out");
        return;
      }
      if (event.target.closest("#clientPanel.visible, #selection.visible, #alertPopup, #dfPopupMirror, #world3dScreen, .dwfui-scroll"))
        return;
      focusPage();
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!wheelPumpAllows()) return;
      // Shift picks DF's FAST z pair; no modifier is the plain +-1 pair.
      const dz = (event.shiftKey ? ZSTEP_FAST : zstep) * (event.deltaY < 0 ? 1 : -1);
      try {
        if (typeof window.DFDesignationRangeWheel === "function" &&
            window.DFDesignationRangeWheel(event, dz)) return;
      } catch { DwfErr.count("camera.designation-wheel"); }
      queueMove(0, 0, dz);
    }, { passive: false, capture: true });

    // Middle/right-drag grab-pans; a middle press that does not move centres the camera on that tile.
    let panDrag = null;
    view.addEventListener("pointerdown", event => {
      if (event.button !== 1 && event.button !== 2) return;
      panDrag = { x: event.clientX, y: event.clientY, moved: 0, button: event.button, id: event.pointerId };
      try { view.setPointerCapture(event.pointerId); } catch { /* pan continues from window events without capture */ }
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
      // A right press that did not move is a right CLICK: it pops exactly ONE rung of the shared mode stack.
      const wasRightClick = panDrag.button === 2 && panDrag.moved < 6;
      try { view.releasePointerCapture(event.pointerId); } catch { /* release is harmless after lost capture */ }
      panDrag = null;
      if (wasMiddleClick) centerOnCursor(event.clientX, event.clientY);
      else if (wasRightClick) {
        try { if (typeof window.DFBackOut === "function") window.DFBackOut("rightclick"); }
        catch (err) { DwfErr.report("input.right-click-back-out", err); }
      }
    };
    view.addEventListener("pointerup", endPanDrag);
    view.addEventListener("pointercancel", endPanDrag);
    view.addEventListener("contextmenu", event => { event.preventDefault(); });
  }

  function startFrameSource() {
    if (tileRenderer) return;
    const TilesApi = window.DwfTiles;
    if (TilesApi && typeof TilesApi.init === "function") {
      tileRenderer = TilesApi.init({
        canvas: view,
        player,
        manageCamera: false,
        managePoll: true,
        onDraw: () => {
          try { renderZoneOverlay(); } catch { DwfErr.count("render.zone-overlay-frame"); }
          try { _navRecordFrame(); } catch { DwfErr.count("render.nav-frame-record"); }
        },
      });
    }
    // If the tile renderer is unavailable (older bundle), the map stays black but every panel,
    // toolbar action, and server endpoint still works -- and nothing throws.
  }

  function startDwf() {
    if (window.__dwfStarted) return true;
    if (window.__dwfStarting) return false;
    window.__dwfStarting = true;
    try {
      startFrameSource();
      if (typeof loadHud === "function") {
        loadHud();
      }
      if (typeof loadNotifications === "function") {
        loadNotifications();
      }
      // Arm the repeaters only after every synchronous initializer above returned: a retry after a throw
      // would otherwise duplicate the interval the failed attempt left behind.
      if (typeof loadHud === "function") setInterval(loadHud, 1000);
      if (typeof loadNotifications === "function") setInterval(loadNotifications, 3000);
      window.__dwfStarted = true;
      window.__dwfStarting = false;
      try { if (window.DwfBoot && typeof window.DwfBoot.markHealthy === "function") window.DwfBoot.markHealthy(); }
      catch (err) { DwfErr.report("boot.mark-healthy", err); }
      try { if (window.DwfBoot && typeof window.DwfBoot.verify === "function") window.DwfBoot.verify(); }
      catch (err) { DwfErr.report("boot.verify", err); }
      return true;
    } catch (err) {
      window.__dwfStarting = false;
      try {
        if (window.DwfBoot) {
          window.DwfBoot.note("boot-init", (err && err.message) || err);
          window.DwfBoot.showFailure("boot initialization", (err && err.message) || String(err));
        }
      } catch (noteErr) { DwfErr.report("boot.start-failure-note", noteErr); }
      return false;
    }
  }

  // Screen event -> map tile in the coordinate contract every endpoint understands: {x,y,w,h}, where the
  // server computes tile = camera + x * view_w / w. So x,y are raw grid indices and w,h the window dims.
  function imagePixelFromEvent(event) {
    if (!tileRenderer) return null;
    const g = tileRenderer.screenToGrid(event.clientX, event.clientY, false);
    if (!g) return null;
    return { x: g.gx, y: g.gy, w: g.gw, h: g.gh };
  }

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
    zoneOverlay.style.setProperty("--zone-overlay-width", w + "px");
    zoneOverlay.style.setProperty("--zone-overlay-height", h + "px");
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
    return ({
      0: 0,  1: 12, 2: 11, 3: 10, 4: 14, 5: 3, 6: 2,  7: 6,
      8: 13, 9: 4,  10: 1, 11: 7, 12: 9, 13: 8, 14: 5, 15: 15
    })[mask] ?? 0;
  }

  function stairPreviewGrid(preview, rendered) {
    if (!preview || !rendered) return null;
    const values = [preview.x1, preview.y1, preview.x2, preview.y2, rendered.ox, rendered.oy].map(Number);
    if (!values.every(Number.isFinite)) return null;
    // Prefer the un-normalised anchor/cursor pair: x1..y2 are min/max, so deriving the corners from them
    // reports "right, below" for every drag direction and pins the readout to one corner forever.
    const corners = [preview.anchorX, preview.anchorY, preview.cursorX, preview.cursorY].map(Number);
    if (corners.every(Number.isFinite)) {
      return { ax: corners[0] - values[4], ay: corners[1] - values[5],
        bx: corners[2] - values[4], by: corners[3] - values[5] };
    }
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

  function dragPreviewIntent() {
    try {
      if (typeof window.DFDragIntent === "function") return window.DFDragIntent() || null;
    } catch { /* overlay cadence retries the optional intent on the next paint */ }
    return null;
  }

  function dragPreviewDepth(preview) {
    const a = Number(preview?.z1 ?? preview?.z);
    const b = Number(preview?.z2 ?? preview?.z);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
    return Math.abs(b - a) + 1;
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
    const model = window.DwfDragPreview;
    const visual = model ? model.visualFor(dragPreviewIntent())
      : { fill: "rgba(255, 196, 64, 0.16)", grid: "rgba(255, 210, 90, 0.22)",
          border: "rgba(255, 214, 92, 0.95)", corner: "rgba(255, 236, 150, 1)", dash: [] };
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = visual.fill;
    ctx.fillRect(sx, sy, sw, sh);
    // faint per-tile separators so the selection reads as DF tiles
    const stepX = cell, stepY = cell;
    if (stepX > 3 && stepY > 3) {
      ctx.strokeStyle = visual.grid;
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
    // crisp per-family border + corner brackets (DF selection feel). The dash pattern is the
    // non-colour channel that keeps add / erase / remove apart in a screenshot.
    const L = Math.round(sx) + 1, T = Math.round(sy) + 1;
    const R = Math.round(sx + sw) - 1, B = Math.round(sy + sh) - 1;
    ctx.strokeStyle = visual.border;
    ctx.lineWidth = 2;
    try { ctx.setLineDash(visual.dash || []); } catch { DwfErr.count("render.build-dash-set"); }
    ctx.strokeRect(L, T, R - L, B - T);
    try { ctx.setLineDash([]); } catch { DwfErr.count("render.build-dash-reset"); }
    const c = Math.max(3, Math.min(10, (R - L) / 2, (B - T) / 2));
    ctx.strokeStyle = visual.corner;
    ctx.beginPath();
    ctx.moveTo(L, T + c); ctx.lineTo(L, T); ctx.lineTo(L + c, T);
    ctx.moveTo(R - c, T); ctx.lineTo(R, T); ctx.lineTo(R, T + c);
    ctx.moveTo(L, B - c); ctx.lineTo(L, B); ctx.lineTo(L + c, B);
    ctx.moveTo(R - c, B); ctx.lineTo(R, B); ctx.lineTo(R, B - c);
    ctx.stroke();
    // The absolute z-range chip stays: it names WHICH levels the volume covers, which the
    // relative W x H x D readout below deliberately does not.
    const zLabel = designationZRangeLabel(stairRangePreview);
    if (zLabel) {
      ctx.font = "600 12px ui-monospace, Consolas, monospace";
      const pad = 5;
      const tw = Math.ceil(ctx.measureText(zLabel).width);
      const bx = L, by = Math.max(18, T - 7);
      ctx.fillStyle = "rgba(20, 16, 8, 0.9)";
      ctx.fillRect(bx, by - 16, tw + pad * 2, 20);
      ctx.strokeStyle = visual.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by - 15.5, tw + pad * 2 - 1, 19);
      ctx.fillStyle = visual.corner;
      ctx.fillText(zLabel, bx + pad, by);
    }
    const anchor = { x: Number(preview.ax), y: Number(preview.ay) };
    const cursor = { x: Number(preview.bx), y: Number(preview.by) };
    const size = model ? model.dims(anchor, cursor) : null;
    if (size) {
      size.d = dragPreviewDepth(stairRangePreview) || dragPreviewDepth(preview);
      const text = model.readout(size);
      if (text) {
        ctx.font = "600 12px ui-monospace, Consolas, monospace";
        const pad = 5;
        const tw = Math.ceil(ctx.measureText(text).width);
        const boxW = tw + pad * 2, boxH = 20;
        const spot = model.labelPlacement({
          right: size.right, below: size.below,
          box: { left: L, top: T, right: R, bottom: B },
          size: { w: boxW, h: boxH }, pad: 6,
          clamp: { left: rendered.left, top: rendered.top,
                   right: rendered.left + rendered.width, bottom: rendered.top + rendered.height },
        });
        if (spot) {
          ctx.fillStyle = "rgba(20, 16, 8, 0.9)";
          ctx.fillRect(spot.x, spot.y - boxH, boxW, boxH);
          ctx.strokeStyle = visual.border;
          ctx.lineWidth = 1;
          ctx.strokeRect(spot.x + 0.5, spot.y - boxH + 0.5, boxW - 1, boxH - 1);
          ctx.fillStyle = visual.corner;
          ctx.fillText(text, spot.x + pad, spot.y - 6);
        }
      }
    }
    ctx.restore();
  }

  // Client-side footprint validity is a cheap heuristic for immediate feedback -- the server still
  // validates authoritatively on commit. A pending zone selection must stay visible until Accept.
  function zonePreviewBounds(preview) {
    if (!preview) return null;
    const values = [preview.x1, preview.y1, preview.x2, preview.y2].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return { x1: Math.min(values[0], values[2]), y1: Math.min(values[1], values[3]),
      x2: Math.max(values[0], values[2]), y2: Math.max(values[1], values[3]) };
  }

  function czPreset() { try { return zonePreset; } catch { return null; } }
  function czRepaintId() { try { return zoneRepaintId; } catch { return null; } }
  function czEraseArmed() { try { return zoneEraseArmed; } catch { return false; } }
  function czRemoveArmed() { try { return zoneRemoveArmed; } catch { return false; } }
  function czPaintPreview() { try { return zonePaintPreview; } catch { return null; } }

  function drawZonePaintPreview(ctx) {
    // Only NEW-zone creation paints here; an existing-zone repaint is drawn by the zone overlay instead.
    if ((!czPreset() && czRepaintId() == null) || czRemoveArmed()) return;
    const rendered = renderedImageRect();
    if (!rendered) return;
    if (czRepaintId() != null) return;

    // One preview per gesture: yield while `dragPreview` is live and keep only the persistent post-release selection.
    if (dragPreview) return;
    const preview = zonePreviewBounds(czPaintPreview());
    if (!preview) return;
    const gx0 = Math.max(0, preview.x1), gy0 = Math.max(0, preview.y1);
    const gx1 = Math.min(rendered.gw - 1, preview.x2), gy1 = Math.min(rendered.gh - 1, preview.y2);
    if (gx1 < gx0 || gy1 < gy0) return;
    const cell = rendered.cell;
    const sx = rendered.left + gx0 * cell, sy = rendered.top + gy0 * cell;
    const sw = (gx1 - gx0 + 1) * cell, sh = (gy1 - gy0 + 1) * cell;
    ctx.save();
    const erasing = !!czEraseArmed();
    const model = window.DwfDragPreview;
    const visual = model ? model.visualFor({ family: "zone", erasing })
      : { fill: "rgba(90, 205, 255, 0.22)", grid: "rgba(145, 230, 255, 0.35)",
          border: "rgba(150, 235, 255, 0.98)", corner: "rgba(190, 246, 252, 1)", dash: [] };
    ctx.fillStyle = visual.fill;
    ctx.fillRect(sx, sy, sw, sh);
    if (cell > 3) {
      ctx.strokeStyle = visual.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = sx + cell; gx < sx + sw - 0.5; gx += cell) { const x = Math.round(gx) + 0.5; ctx.moveTo(x, sy); ctx.lineTo(x, sy + sh); }
      for (let gy = sy + cell; gy < sy + sh - 0.5; gy += cell) { const y = Math.round(gy) + 0.5; ctx.moveTo(sx, y); ctx.lineTo(sx + sw, y); }
      ctx.stroke();
    }
    ctx.strokeStyle = visual.border;
    ctx.lineWidth = 2;
    try { ctx.setLineDash(visual.dash || []); } catch { DwfErr.count("render.zone-dash-set"); }
    ctx.strokeRect(Math.round(sx) + 1, Math.round(sy) + 1, Math.max(1, Math.round(sw) - 2), Math.max(1, Math.round(sh) - 2));
    try { ctx.setLineDash([]); } catch { DwfErr.count("render.zone-dash-reset"); }
    // C1: the retained selection keeps its size legible, so "how big is the zone I am about to
    // Accept" is answerable without releasing and re-painting.
    if (model) {
      const text = model.readout(model.dims({ x: preview.x1, y: preview.y1 },
                                             { x: preview.x2, y: preview.y2 }));
      if (text) {
        ctx.font = "600 12px ui-monospace, Consolas, monospace";
        const pad = 5;
        const boxW = Math.ceil(ctx.measureText(text).width) + pad * 2;
        ctx.fillStyle = "rgba(20, 16, 8, 0.9)";
        ctx.fillRect(sx + sw + 6, sy + sh - 20, boxW, 20);
        ctx.fillStyle = visual.corner;
        ctx.fillText(text, sx + sw + 6 + pad, sy + sh - 6);
      }
    }
    ctx.restore();
  }

  function paintedZoneShape(zone) {
    let shape;
    try {
      if (!window.DwfPaintSession || !zone || zone.id == null) return zone;
      shape = window.DwfPaintSession.shapeFor("zone", zone.id);
    } catch { return zone; }
    if (!shape) return zone;
    return { ...zone, x: shape.x1, y: shape.y1, z: shape.z,
      w: shape.x2 - shape.x1 + 1, h: shape.y2 - shape.y1 + 1, extents: shape.extents };
  }

  function drawPaintModeWash(ctx) {
    let open;
    try { open = !!(window.DwfPaintSession && window.DwfPaintSession.modeOpen()); } catch { return; }
    if (!open) return;
    const rendered = renderedImageRect();
    if (!rendered) return;
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    ctx.fillRect(rendered.left, rendered.top, rendered.gw * rendered.cell, rendered.gh * rendered.cell);
    ctx.restore();
  }

  // The placement cursor is NOT painted here: dwf-controls-placement.js publishes the painter.
  function drawBuildPreview(ctx) {
    const rendered = renderedImageRect();
    if (!rendered) return;
    try {
      if (window.DFPlacementCursor && typeof window.DFPlacementCursor.paint === "function")
        window.DFPlacementCursor.paint(ctx, rendered);
    } catch { /* an overlay must never take the map down */ }
  }

  function drawLeverLinkTargets(ctx) {
    let targets = [];
    try {
      if (window.DFLeverLink && typeof window.DFLeverLink.overlayTargets === "function")
        targets = window.DFLeverLink.overlayTargets();
    } catch { targets = []; }
    if (!Array.isArray(targets) || !targets.length) return;
    const rendered = renderedImageRect();
    if (!rendered) return;
    const cell = Number(rendered.cell);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const target of targets) {
      if (Number(target.z) !== Number(rendered.oz)) continue;
      const gx = Number(target.x) - Number(rendered.ox);
      const gy = Number(target.y) - Number(rendered.oy);
      if (!Number.isFinite(gx) || !Number.isFinite(gy) ||
          gx < 0 || gy < 0 || gx >= Number(rendered.gw) || gy >= Number(rendered.gh)) continue;
      const sx = rendered.left + gx * cell;
      const sy = rendered.top + gy * cell;
      ctx.fillStyle = "rgba(90, 220, 110, 0.24)";
      ctx.fillRect(sx, sy, cell, cell);
      ctx.strokeStyle = "rgba(145, 245, 155, 0.98)";
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(sx) + 1, Math.round(sy) + 1,
        Math.max(1, Math.round(cell) - 2), Math.max(1, Math.round(cell) - 2));
    }
    ctx.restore();
  }

  function renderZoneOverlay() {
    // Refuse to draw before startDwf(): one cross-script read throwing here is read by boot-health
    // as "dwf-core.js never loaded".
    if (!window.__dwfStarted) return;
    const ctx = resizeZoneOverlay();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    // ledger 0069: paint mode dims the map first, exactly as native does the moment a paint or
    // designation mode opens -- the player's cue that clicks now paint instead of inspect.
    drawPaintModeWash(ctx);
    drawDragPreview(ctx);   // local rectangle selection (no-op with no active drag/anchor)
    drawBuildPreview(ctx);  // building footprint preview (no-op unless a build tool is hovering)
    drawLeverLinkTargets(ctx); // native lever/plate map picker: legal building centres only
    const rendered = renderedImageRect();
    // Drive zone placement off the tile renderer's live window; the HUD viewport misaligns under zoom.
    const cam = zoneSnapshotCamera || currentHud?.camera;
    // Draw the new-zone preview exactly once: before the zone-sheet gate when the overlay is OFF, and
    // after the footprints when it is ON, so it never double-composites.
    const overlayOff = !zoneOverlayEnabled;
    if (overlayOff) drawZonePaintPreview(ctx);
    if (!zoneOverlayEnabled || !cam || !rendered)
      return;
    const sheet = zoneSheetImage();
    if (!sheet || !sheet.complete)
      return;
    const camX = Number(rendered.ox) || 0;
    const camY = Number(rendered.oy) || 0;
    const camZ = Number(rendered.oz);
    const vpW = rendered.gw;
    const vpH = rendered.gh;
    const cell = rendered.cell;
    ctx.imageSmoothingEnabled = false;

    for (const rawZone of currentZones) {
      const zone = paintedZoneShape(rawZone);
      if (Number(zone.z) !== camZ) continue;
      const zw = Number(zone.w) || 0;
      const zh = Number(zone.h) || 0;
      const zx = Number(zone.x) || 0;
      const zy = Number(zone.y) || 0;
      const stateCol = zone.active ? 2 : 0;
      // The zone's TYPE names its icon; /zones carries that key, so no pixel address is read here.
      const iconCell = window.DFChrome?.getCell?.(window.DWFUI?.zoneSprite?.(zone.key));
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
          ctx.drawImage(sheet, stateCol * 32, zoneShapeRow(zone, lx, ly) * 32, 32, 32,
            dx, dy, dw, dh);
          if (!iconDrawn) {
            if (iconCell && iconCell.img === ZONE_SHEET)
              ctx.drawImage(sheet, iconCell.cx, iconCell.cy, iconCell.w, iconCell.h, dx, dy, dw, dh);
            iconDrawn = true;
          }
        }
      }
    }
    drawZonePaintPreview(ctx); // pending NEW-zone preview sits above the authoritative footprints
  }

  async function loadZones() {
    if (!zoneOverlayEnabled) {
      currentZones = [];
      zoneSnapshotCamera = null;
      renderZoneOverlay();
      return;
    }
    try {
      // Omit w/h if the render rect is not ready: the server then falls back to native-viewport culling.
      const rr = renderedImageRect();
      const dims = (rr && rr.gw > 0 && rr.gh > 0) ? `&w=${Math.round(rr.gw)}&h=${Math.round(rr.gh)}` : "";
      const response = await fetch(`/zones?player=${encodeURIComponent(player)}${dims}&t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("zones failed");
      const data = await response.json();
      currentZones = Array.isArray(data.zones) ? data.zones : [];
      zoneSnapshotCamera = data.camera || currentHud?.camera || null;
      renderZoneOverlay();
    } catch { DwfErr.count("render.zone-overlay-refresh"); }
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
    tileFlash.style.setProperty("--tile-flash-left", rect.left + "px");
    tileFlash.style.setProperty("--tile-flash-top", rect.top + "px");
    tileFlash.style.setProperty("--tile-flash-width", rect.width + "px");
    tileFlash.style.setProperty("--tile-flash-height", rect.height + "px");
    for (let i = 0; i < 4; i++) {
    tileFlash.hidden = false;
      await sleep(150);
      tileFlash.hidden = true;
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
    if (kind === "vermin" && typeof openVerminPanel === "function") {
      openVerminPanel(data);
      return;
    }
    if (kind === "planned-engraving" && data.tile && typeof openPlannedEngravingPanel === "function") {
      openPlannedEngravingPanel(data.tile);
      return;
    }
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

  // Deferred to DOMContentLoaded because dwf-panelframe.js loads after this file.
  // zBand:false keeps their CSS z-index; escClosable:false keeps Esc in the controls-placement cascade.
  function registerContentHosts() {
    if (!window.DFPanelFrame || !window.DFPanelFrame.register) return;
    const PV = window.DFPanelFrame._pure.primaryVariant;
    const CLIENT_VARIANTS = ["build-panel", "squads-sidebar", "reports-window", "alertbox-panel", "fort-window", "info-panel"];
    const SELECTION_VARIANTS = ["occupant-list-panel", "stock-item-panel", "unit-sheet-panel", "stockpile-panel",
      "zone-panel", "farm-panel", "workshop-panel", "trade-depot-depot-panel", "hospital-panel", "building-panel",
      "vermin-sheet-panel", "planned-engraving-panel"];
    // ---- the close-less (ESC-only) selection variants -------------------------------------------
    const ESC_ONLY_SELECTION_VARIANTS = ["unit-sheet-panel", "stock-item-panel", "zone-panel",
      "vermin-sheet-panel", "planned-engraving-panel"];
    const selectionClosable = el =>
      !el.classList.contains("view-sheet-panel") &&
      !ESC_ONLY_SELECTION_VARIANTS.includes(PV(el.className, SELECTION_VARIANTS));
    const clientFillSel = el => {
      const variant = PV(el.className, CLIENT_VARIANTS);
      // No fill designation for the build panel on purpose: the block is a fixed three-row height that hugs
      // its content, so stamping `.pf-fill-scroll` would stretch a decoded box.
      if (variant === "build-panel") return null;
      if (variant === "squads-sidebar") return el.classList.contains("squads-wide") ? ".squad-body" : [".squad-list", ".squad-body"];
      if (variant === "fort-window") return [
        ".kitchen-scroll,.standing-order-list,.stone-list", ".fort-scroll", ".fort-candidate-list", ".fort-body"
      ];
      if (variant === "reports-window") return ".reports-list";
      if (variant === "alertbox-panel") return ".alert-viewer-rows";
      // The list scrolls, not the whole main area: headers and sort bars stay put, rows snap whole.
      // Only when the list is LAST: content after it (Nobles' mandates) would squeeze the list to nothing.
      if (variant === "info-panel") return [
        ".work-order-tasks", ".work-order-screen", ".work-order-list",
        ".info-main > .dwfui-scroll[data-dwfui-rows]:last-child",
        ".info-main", ".stocks-detail", ".stocks-list", ".info-body"
      ];
      return null;
    };
    const selectionFillSel = el => {
      const variant = PV(el.className, SELECTION_VARIANTS);
      if (variant === "stock-item-panel") return ".stock-item-body";
      if (variant === "unit-sheet-panel") return [
        ".unit-tab-scroll",
        ".unit-grid,.unit-list-grid,.unit-structured-list,.unit-text-block,.unit-prose-block,.unit-skill-list,.unit-knowledge-list",
      ];
      if (variant === "zone-panel") return ".zone-unit-list";
      if (variant === "farm-panel") return ".farm-seed-stock";
      if (variant === "workshop-panel") return [".workshop-task-grid", ".workshop-task-list", ".workshop-list.compact", ".workshop-body"];
      if (variant === "trade-depot-depot-panel" || variant === "hospital-panel") return ".pf-content";
      if (variant === "building-panel") return ".pf-content";
      return null;
    };
    const CLOSELESS_CLIENT_VARIANTS = ["alertbox-panel", "reports-window", "info-panel", "build-panel", "squads-sidebar"];
    const clientClosable = el => !CLOSELESS_CLIENT_VARIANTS.includes(PV(el.className, CLIENT_VARIANTS));
    // GEOMETRY-SLOT CONTRACT: CLIENT_VARIANTS must NOT grow the squads wide-modifier tokens -- clientFillSel
    // and clientClosable depend on the collapse. variantKey appends a width TIER so each tier saves its own rect.
    window.DFPanelFrame.register({
      key: "clientPanel", el: () => clientPanel, title: "Info",
      contentHost: true, movable: true, closable: clientClosable, menu: false,
      // `.build-head` is gone with the invented build chassis (see CLOSELESS_CLIENT_VARIANTS above).
      adoptHeadSel: ".info-header",
      resizable: { minW: 240, minH: el => el.classList.contains("squads-sidebar")
        ? window.DFPanelFrame._pure.footerMinimumHeight(el, ".squad-body", ".squad-root-squad-list",
          ".squad-selected", 300, node => getComputedStyle(node))
        : 140 },
      zBand: false, escClosable: false, persistOpen: false,
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
    // Same geometry-slot contract: SELECTION_VARIANTS must not grow "zone-wide"; variantKey appends ".wide".
    window.DFPanelFrame.register({
      key: "selection", el: () => selection, title: "Selection",
      contentHost: true, movable: true, closable: selectionClosable, menu: false,
      adoptHeadSel: ".unit-sheet-header,.stock-item-header,.stockpile-header,.farm-native-head,.building-head,.engraving-window,.vermin-sheet-window,.planned-engraving-window",
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
  // THE ONE SITE that boots DWFUI's DOM half: mountDom() installs a document-wide observer, so every
  // surface gets sprite paint and scrollbar art. A per-panel call would miss panels that bypass panelContent().
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", registerContentHosts);
  else registerContentHosts();
