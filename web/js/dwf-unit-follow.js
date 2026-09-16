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
  const FOLLOW_TICK_MS = 250;        // recenter cadence (DF-like lock without spamming /camera)
  const FOLLOW_PAN_STOP_TILES = 4;   // view-centre drift (x/y) beyond this => manual pan => stop
  const FOLLOW_SETTLE_TICKS = 2;     // skip the drift check ONLY at follow start (initial centre)
  const FOLLOW_FALLBACK_MS = 500;    // min gap between /unit fallback fetches

  let unitFollowId = -1;
  let unitFollowTimer = null;
  let unitFollowCenter = null;       // unit's last tile (drives the recenter decision)
  // Drift is measured against the centre the camera ACHIEVED, not the unit tile: near a map edge DF
  // clamps, and comparing against the unit reads that clamp as a manual pan and stops follow.
  let unitFollowViewCenter = null;
  let unitFollowSettle = 0;
  let unitFollowBusy = false;
  let unitFollowFetchAt = 0;
  let unitFollowGw = 0, unitFollowGh = 0;  // last-seen visible span; a change == a zoom/resize

  // The latched camera state is carried by the SPRITE, not by a CSS tint, so re-latching must swap
  // the token on the icon span and repaint it.
  function markFollowButton(on) {
    try {
      const btn = selection && selection.querySelector("[data-unit-follow]");
      if (!btn) return;
      btn.classList.toggle("active", !!on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      const sprites = (window.DWFUI && DWFUI.TOKENS && DWFUI.TOKENS.sprites) || {};
      const token = on ? sprites.cameraOn : sprites.cameraOff;
      const icon = btn.querySelector("[data-dwfui-sprite]");
      if (token && icon && icon.getAttribute("data-dwfui-sprite") !== token) {
        icon.setAttribute("data-dwfui-sprite", token);
        if (typeof DWFUI.paintSprites === "function") DWFUI.paintSprites(btn);
      }
      btn.title = on ? "Following this unit -- camera tracks it (pan or Esc to stop)"
                     : "Follow this unit (camera tracks it until you pan or press Esc)";
    } catch (err) { DwfErr.report("unit-follow.icon", err); }
  }

  const unitFollowSubs = [];
  function getUnitFollowState() {
    return unitFollowId >= 0 ? { following: true, unitId: unitFollowId } : { following: false, unitId: -1 };
  }
  function emitUnitFollowChange() {
    const state = getUnitFollowState();
    for (let i = 0; i < unitFollowSubs.length; i++) {
      try { unitFollowSubs[i](state); }
      catch (err) { DwfErr.report("unit-follow.subscriber", err); }
    }
  }
  function onUnitFollowChange(cb) {
    if (typeof cb !== "function") return;
    unitFollowSubs.push(cb);
    try { cb(getUnitFollowState()); }
    catch (err) { DwfErr.report("unit-follow.subscriber-initial", err); }
  }

  function stopUnitFollow() {
    const was = unitFollowId >= 0;
    unitFollowId = -1;
    unitFollowCenter = null;
    unitFollowViewCenter = null;
    unitFollowSettle = 0;
    unitFollowFetchAt = 0;
    if (unitFollowTimer) { window.clearInterval(unitFollowTimer); unitFollowTimer = null; }
    if (was) { markFollowButton(false); emitUnitFollowChange(); }
  }

  // Live client-side position of the followed unit (AUX snapshot). Returns null if absent.
  function liveUnitPos(id) {
    try {
      const units = (window.DwfTiles && typeof DwfTiles.getLatest === "function" &&
        (DwfTiles.getLatest() || {}).units) || [];
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u && Number(u.id) === id && Number.isFinite(Number(u.x)))
          return { x: Number(u.x), y: Number(u.y), z: Number(u.z) };
      }
    } catch { /* the throttled /unit fallback supplies positions absent from the live snapshot */ }
    return null;
  }

  // Origin is the server-side per-player camera, which has no recenter round-trip lag; half-span is
  // the renderer's live zoom-aware gw/gh, so the centre stays invariant under zoom.
  function viewCentreTile() {
    const rr = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    const cam = (typeof currentHud !== "undefined" && currentHud) ? currentHud.camera : null;
    if (rr && cam && Number.isFinite(Number(cam.x)) && rr.gw > 0 && rr.gh > 0)
      return { x: Math.round(Number(cam.x) + rr.gw / 2), y: Math.round(Number(cam.y) + rr.gh / 2), z: Number(cam.z) };
    if (rr && Number.isFinite(rr.ox) && rr.gw > 0 && rr.gh > 0)
      return { x: Math.round(rr.ox + rr.gw / 2), y: Math.round(rr.oy + rr.gh / 2), z: Number(rr.oz) };
    const vp = cam && currentHud.viewport;
    if (cam && vp)
      return { x: Math.round(Number(cam.x) + Number(vp.w) / 2), y: Math.round(Number(cam.y) + Number(vp.h) / 2), z: Number(cam.z) };
    return null;
  }

  async function unitFollowTick() {
    if (unitFollowId < 0 || unitFollowBusy) return;
    // Sheet closed (Esc/X) or switched to another unit -> stop (mirrors DF).
    const stillOpen = selection.classList.contains("visible") &&
      selection.classList.contains("unit-sheet-panel") &&
      Number(selectedUnitData?.unit?.id) === unitFollowId;
    if (!stillOpen) { stopUnitFollow(); return; }

    // A zoom or resize changes gw/gh and momentarily desyncs the client span from the server camera,
    // which would read as a phantom pan -- skip the drift check that tick. A real pan never does.
    const rrNow = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    const spanChanged = rrNow && (rrNow.gw !== unitFollowGw || rrNow.gh !== unitFollowGh);
    if (rrNow) { unitFollowGw = rrNow.gw; unitFollowGh = rrNow.gh; }
    if (unitFollowSettle > 0) {
      unitFollowSettle--;
    } else if (spanChanged) {
      unitFollowSettle = 1;   // let the server camera catch up to the new zoom before checking
    } else if (unitFollowViewCenter) {
      const cc = viewCentreTile();
      if (cc) {
        const dz = Math.abs(cc.z - unitFollowViewCenter.z);
        const dxy = Math.max(Math.abs(cc.x - unitFollowViewCenter.x), Math.abs(cc.y - unitFollowViewCenter.y));
        if (dz >= 1 || dxy > FOLLOW_PAN_STOP_TILES) { stopUnitFollow(); return; }
      }
    }

    // Live snapshot first, then a throttled /unit fallback; a miss only stops follow after the grace window.
    let pos = liveUnitPos(unitFollowId);
    let deadStop = false;
    if (!pos && Date.now() - unitFollowFetchAt >= FOLLOW_FALLBACK_MS) {
      unitFollowFetchAt = Date.now();
      unitFollowBusy = true;
      try {
        const ac = ("AbortController" in window) ? new AbortController() : null;   // don't hang the loop
        const to = ac ? setTimeout(() => ac.abort(), 2500) : null;
        const r = await fetch(`/unit?player=${encodeURIComponent(player)}&id=${encodeURIComponent(unitFollowId)}&t=${Date.now()}`, { cache: "no-store", signal: ac ? ac.signal : undefined });
        if (to) clearTimeout(to);
        if (r.ok) {
          const d = await r.json();
          const u = d && d.unit;
          const flags = (u && Array.isArray(u.flags)) ? u.flags.join(" ").toLowerCase() : "";
          const t = d && d.tile;
          if ((d && d.error) || (u && (u.dead || /dead|deceas|corpse/.test(flags)))) {
            deadStop = true;                       // unit died -> DF stops following
          } else if (t && Number.isFinite(Number(t.x))) {
            pos = { x: Number(t.x), y: Number(t.y), z: Number(t.z) };
          }
        } else if (r.status === 404) {
          // /unit 404s both on a genuine despawn and on a transient render-thread exception, so require
          // the not-found message before treating it as permanent.
          let body = null;
          try { body = await r.json(); }
          catch { /* a malformed 404 is transient and must not end follow */ }
          const emsg = body && body.error ? String(body.error).toLowerCase() : "";
          if (/not\s*found/.test(emsg)) deadStop = true;
        }
      } catch { /* the next throttled fallback retries without ending follow */ }
      unitFollowBusy = false;
      if (unitFollowId < 0) return;                // stopped mid-await
    }

    if (deadStop) { stopUnitFollow(); return; }
    if (!pos) {
      // A temporarily unlocatable unit does NOT end follow -- native keeps the lock. Disengage is for
      // explicit user action or a confirmed death/despawn only.
      return;
    }

    // Do NOT re-arm the settle window here: the drift check must stay live to catch a manual pan even
    // while chasing a walking unit.
    if (!unitFollowCenter || pos.x !== unitFollowCenter.x || pos.y !== unitFollowCenter.y || pos.z !== unitFollowCenter.z) {
      unitFollowCenter = { x: pos.x, y: pos.y, z: pos.z };
      if (selectedUnitData) selectedUnitData.tile = { x: pos.x, y: pos.y, z: pos.z };
      unitFollowBusy = true;
      // Timeout-guard the recenter: a hung /camera or /hud would wedge unitFollowBusy and freeze
      // follow. On failure currentHud may be stale, so skip the next drift check.
      const ok = await Promise.race([setCameraToMapPos(unitFollowCenter), new Promise(res => setTimeout(() => res("timeout"), 3000))]);
      unitFollowBusy = false;
      if (ok !== true) { unitFollowSettle = Math.max(unitFollowSettle, 1); }
      else {
        // Latch the drift baseline to the centre the camera ACTUALLY reached (clamped at map edges).
        const achieved = viewCentreTile();
        if (achieved) unitFollowViewCenter = achieved;
      }
    }
  }

  function startUnitFollow(unitId, initialPos) {
    stopUnitFollow();
    unitFollowId = Number(unitId);
    unitFollowFetchAt = 0;
    unitFollowSettle = FOLLOW_SETTLE_TICKS;
    unitFollowCenter = (initialPos && Number.isFinite(Number(initialPos.x)))
      ? { x: Number(initialPos.x), y: Number(initialPos.y), z: Number(initialPos.z) } : null;
    // Seed the drift baseline with the achieved centre; the settle window covers the null case.
    unitFollowViewCenter = (typeof viewCentreTile === "function") ? viewCentreTile() : null;
    const rr0 = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    unitFollowGw = rr0 ? rr0.gw : 0;
    unitFollowGh = rr0 ? rr0.gh : 0;
    markFollowButton(true);
    unitFollowTimer = window.setInterval(() => { unitFollowTick(); }, FOLLOW_TICK_MS);
    emitUnitFollowChange();   // tell the minimap's clear-tracking button we are locked on
  }


  async function setCameraToMapPos(pos) {
    if (!pos) return false;
    // Centre using the renderer's live zoom-aware span, never hud.viewport -- that is the server's
    // fixed grid and mis-centres a zoomed-in player.
    const rr = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    let halfW, halfH;
    if (rr && Number.isFinite(rr.gw) && rr.gw > 0 && rr.gh > 0) {
      halfW = rr.gw / 2; halfH = rr.gh / 2;
    } else {
      const vp = currentHud?.viewport || { w: 80, h: 50 };
      halfW = (Number(vp.w) || 80) / 2; halfH = (Number(vp.h) || 50) / 2;
    }
    const x = Math.round(Number(pos.x) - halfW);
    const y = Math.round(Number(pos.y) - halfH);
    const z = Math.round(Number(pos.z) || 0);
    resetPanPrediction();
    try {
      const ac = ("AbortController" in window) ? new AbortController() : null;   // never hang a caller
      const to = ac ? setTimeout(() => ac.abort(), 3000) : null;
      await fetch(`/camera?player=${encodeURIComponent(player)}&x=${x}&y=${y}&z=${z}`, {
        method: "POST",
        cache: "no-store",
        signal: ac ? ac.signal : undefined
      });
      if (to) clearTimeout(to);
      await window.loadHud();
      return true;
    } catch {
      return false;
    }
  }
  async function centerAndFlashMapPos(pos) {
    if (!pos) return;
    window.closeClientPanel();
    closeSelection();
    pinnedAlertKey = null;
    hoveredAlertKey = null;
    hideAlertPopup();
    await setCameraToMapPos(pos);
    await flashMapTile(pos);
    focusPage();
  }

  if (typeof window !== "undefined") Object.assign(window, {
    getUnitFollowState, markFollowButton, startUnitFollow, stopUnitFollow, liveUnitPos,
    setCameraToMapPos, centerAndFlashMapPos,
  });
  if (typeof window !== "undefined") window.DwfUnitFollow = {
    getState: getUnitFollowState, stopFollow: stopUnitFollow, onChange: onUnitFollowChange, liveUnitPos,
  };
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, {
    getUnitFollowState, markFollowButton, startUnitFollow, stopUnitFollow, liveUnitPos,
    setCameraToMapPos, centerAndFlashMapPos, onUnitFollowChange, unitFollowTick,
  });
