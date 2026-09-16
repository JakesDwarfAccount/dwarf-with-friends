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

  let squadMoveMembers = "";
  async function squadMoveClick(event) {
    const squadId = window.DFPlacementController.squadMoveArmed;
    const members = squadMoveMembers;
    window.DFPlacementController.squadMoveArmed = -1;
    squadMoveMembers = "";
    window.updateToolCursor();
    if (typeof window.DFSquadMove === "object" && window.DFSquadMove.onDisarmed)
      window.DFSquadMove.onDisarmed();
    const pixel = imagePixelFromEvent(event);
    if (!pixel) return;
    try {
      const url = `/squad-order?player=${encodeURIComponent(player)}&squad=${encodeURIComponent(squadId)}` +
        `&action=move&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}` +
        (members ? `&members=${encodeURIComponent(members)}` : "");
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      if (typeof window.DFSquadMove === "object" && window.DFSquadMove.onResult)
        window.DFSquadMove.onResult(r.ok && data.ok !== false, data);
    } catch (err) {
      if (typeof window.DFSquadMove === "object" && window.DFSquadMove.onResult)
        window.DFSquadMove.onResult(false, { error: err.message });
    }
  }
  window.DFSquadMove = window.DFSquadMove || {};
  window.DFSquadMove.arm = function (squadId, members) {
    window.DFPlacementController.squadMoveArmed = Number(squadId);
    squadMoveMembers = members ? String(members) : "";
    window.updateToolCursor();
  };
  window.DFSquadMove.disarm = function () {
    window.DFPlacementController.squadMoveArmed = -1;
    squadMoveMembers = "";
    window.updateToolCursor();
    // The sidebar installs onDisarmed so its order tile drops the armed styling. EVERY disarm path
    // must call it, or backing out of a squad mode leaves the panel still LOOKING armed.
    try { if (typeof window.DFSquadMove.onDisarmed === "function") window.DFSquadMove.onDisarmed(); }
    catch (err) { DwfErr.report("target-mode.squad-move-disarm", err); }
  };
  window.DFSquadMove.isArmed = function () { return window.DFPlacementController.squadMoveArmed; };

  function squadPatrolClick(event) {
    const pixel = imagePixelFromEvent(event);
    const rendered = renderedImageRect();
    if (!pixel || !rendered) return;
    const pos = { x: rendered.ox + pixel.x, y: rendered.oy + pixel.y, z: rendered.oz };
    if (typeof window.DFSquadPatrol === "object" && window.DFSquadPatrol.onPoint)
      window.DFSquadPatrol.onPoint(pos);
  }
  window.DFSquadPatrol = window.DFSquadPatrol || {};
  window.DFSquadPatrol.arm = function (squadId) {
    window.DFPlacementController.squadPatrolArmed = Number(squadId);
    window.updateToolCursor();
  };
  window.DFSquadPatrol.disarm = function () {
    window.DFPlacementController.squadPatrolArmed = -1;
    window.updateToolCursor();
    try { if (typeof window.DFSquadPatrol.onDisarmed === "function") window.DFSquadPatrol.onDisarmed(); }
    catch (err) { DwfErr.report("target-mode.squad-patrol-disarm", err); }
  };
  window.DFSquadPatrol.isArmed = function () { return window.DFPlacementController.squadPatrolArmed; };

  // Multi-target kill: an armed click marks (or unmarks) a target and stays armed, so several units
  // can be marked before one confirm sends them all. Only confirm/cancel via DFSquadKill disarms.
  async function squadKillClick(event) {
    const pixel = imagePixelFromEvent(event);
    if (!pixel) return;
    try {
      const url = `/inspect?player=${encodeURIComponent(player)}&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}`;
      const r = await fetch(url, { cache: "no-store" });
      const data = r.ok ? await r.json() : null;
      const target = Number(data && String(data.kind).toLowerCase() === "unit" && data.unit && data.unit.id);
      if (!(target >= 0)) throw new Error("Select a unit, not terrain or a building.");
      if (typeof window.DFSquadKill === "object" && window.DFSquadKill.onTarget)
        window.DFSquadKill.onTarget(target, data);
    } catch (err) {
      if (typeof window.DFSquadKill === "object" && window.DFSquadKill.onFailed)
        window.DFSquadKill.onFailed((err && err.message) || "Target selection failed.");
      else if (typeof window.DFSquadKill === "object" && window.DFSquadKill.onDisarmed)
        window.DFSquadKill.onDisarmed();
    }
  }
  async function wsLinkClick(event) {
    const pixel = imagePixelFromEvent(event);
    if (!pixel || !window.DFPlacementController.wsLinkArmed) return;
    try {
      const url = `/inspect?player=${encodeURIComponent(player)}&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}`;
      const r = await fetch(url, { cache: "no-store" });
      const data = r.ok ? await r.json() : null;
      const kind = String(data && data.kind || "").toLowerCase();
      const spId = kind === "stockpile" && typeof selectionBuildingId === "function"
        ? Number(selectionBuildingId(data)) : -1;
      if (!(spId >= 0)) throw new Error("Click a stockpile on the map to link it.");
      if (typeof window.DFWsLink === "object" && window.DFWsLink.onPick)
        window.DFWsLink.onPick(spId, data);
    } catch (err) {
      if (typeof window.DFWsLink === "object" && window.DFWsLink.onFailed)
        window.DFWsLink.onFailed((err && err.message) || "Stockpile selection failed.");
    }
  }
  window.DFWsLink = window.DFWsLink || {};
  window.DFWsLink.arm = function (wsId, mode) {
    window.DFPlacementController.wsLinkArmed = { ws: Number(wsId), mode: mode === "take" ? "take" : "give" };
    window.updateToolCursor();
  };
  window.DFWsLink.disarm = function () {
    window.DFPlacementController.wsLinkArmed = null;
    window.updateToolCursor();
  };
  window.DFWsLink.isArmed = function () { return window.DFPlacementController.wsLinkArmed; };

  async function leverLinkClick(event) {
    const armed = window.DFPlacementController.leverLinkArmed;
    const pixel = imagePixelFromEvent(event);
    if (!pixel || !armed) return;
    try {
      const url = `/inspect?player=${encodeURIComponent(player)}&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}`;
      const r = await fetch(url, { cache: "no-store" });
      const data = r.ok ? await r.json() : null;
      const buildingId = typeof selectionBuildingId === "function"
        ? Number(selectionBuildingId(data)) : -1;
      const target = armed.targets.find(row => Number(row.id) === buildingId);
      if (!target) throw new Error("That building is not a legal target for this trigger.");
      if (typeof window.DFLeverLink.onPick === "function")
        window.DFLeverLink.onPick(target.id, data);
    } catch (err) {
      if (typeof window.DFLeverLink.onFailed === "function")
        window.DFLeverLink.onFailed((err && err.message) || "Link target selection failed.");
    }
  }
  window.DFLeverLink = window.DFLeverLink || {};
  window.DFLeverLink.arm = function (sourceId, targets) {
    window.DFPlacementController.leverLinkArmed = {
      sourceId: Number(sourceId),
      targets: (Array.isArray(targets) ? targets : []).map(row => ({ ...row })),
    };
    window.updateToolCursor();
    renderZoneOverlay();
  };
  window.DFLeverLink.disarm = function (notify = true) {
    if (!window.DFPlacementController.leverLinkArmed) return false;
    window.DFPlacementController.leverLinkArmed = null;
    window.updateToolCursor();
    renderZoneOverlay();
    try {
      if (notify && typeof window.DFLeverLink.onDisarmed === "function")
        window.DFLeverLink.onDisarmed();
    } catch (err) { DwfErr.report("target-mode.lever-link-disarm", err); }
    return true;
  };
  window.DFLeverLink.isArmed = function () { return window.DFPlacementController.leverLinkArmed; };
  window.DFLeverLink.overlayTargets = function () {
    return window.DFPlacementController.leverLinkArmed ? window.DFPlacementController.leverLinkArmed.targets.map(row => ({ ...row })) : [];
  };

  async function chatPingClick(event) {
    if (!window.DFPlacementController.chatPingArmed) return;
    const pixel = imagePixelFromEvent(event);
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    window.DFChatPing.disarm();
    if (!pixel) return;
    const pos = rendered
      ? { x: Number(rendered.ox) + pixel.x, y: Number(rendered.oy) + pixel.y, z: Number(rendered.oz) }
      : null;
    let data = null;
    try {
      const url = `/inspect?player=${encodeURIComponent(player)}&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}`;
      const r = await fetch(url, { cache: "no-store" });
      data = r.ok ? await r.json() : null;
    } catch (_) {
      data = null;   // a dead /inspect degrades to a plain location ping, never to nothing
    }
    if (typeof window.DFChatPing.onPick === "function") window.DFChatPing.onPick(data, pos);
  }
  window.DFChatPing = window.DFChatPing || {};
  window.DFChatPing.arm = function () {
    if (window.DFPlacementController.chatPingArmed) return;
    window.DFPlacementController.chatPingArmed = true;
    window.updateToolCursor();
    if (typeof window.DFChatPing.onArmed === "function") window.DFChatPing.onArmed();
  };
  window.DFChatPing.disarm = function () {
    if (!window.DFPlacementController.chatPingArmed) return;
    window.DFPlacementController.chatPingArmed = false;
    window.updateToolCursor();
    // Idempotent + guarded by the flag above, so the consumer's own toggle-off (which calls
    // disarm) and the Escape path below both notify exactly once and cannot recurse.
    if (typeof window.DFChatPing.onDisarmed === "function") window.DFChatPing.onDisarmed();
  };
  window.DFChatPing.isArmed = function () { return window.DFPlacementController.chatPingArmed; };

  window.DFSquadKill = window.DFSquadKill || {};
  window.DFSquadKill.arm = function (squadId) {
    window.DFPlacementController.squadKillArmed = Number(squadId);
    window.updateToolCursor();
  };
  window.DFSquadKill.disarm = function () {
    window.DFPlacementController.squadKillArmed = -1;
    window.updateToolCursor();
    try { if (typeof window.DFSquadKill.onDisarmed === "function") window.DFSquadKill.onDisarmed(); }
    catch (err) { DwfErr.report("target-mode.squad-kill-disarm", err); }
  };
  window.DFSquadKill.isArmed = function () { return window.DFPlacementController.squadKillArmed; };


  if (typeof window !== "undefined") Object.assign(window, {
    squadMoveClick, squadPatrolClick, squadKillClick, wsLinkClick, leverLinkClick, chatPingClick,
  });
