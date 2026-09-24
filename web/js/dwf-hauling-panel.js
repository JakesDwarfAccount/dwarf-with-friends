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

  // ---- hauling routes: a full-height LEFT panel, same chrome as burrows above -----------------
  let haulingRoutesCache = [];   // last /hauling routes payload
  let haulingSelectedRouteId = -1;
  let haulingOpenStopKey = "";     // "<routeId>:<stopId>" of the expanded stop, or ""
  let haulingCondDraft = {};       // in-progress depart condition: {mode,direction,loadPercent,atMost,desired}
  let haulingFreeVehicles = [];    // /hauling-vehicles -- df::vehicle with route_id == -1
  const haulingPanel = document.createElement("div");
  haulingPanel.id = "haulingPanel";
  haulingPanel.className = "df-panel";
  haulingPanel.hidden = true;
  document.body.appendChild(haulingPanel);

  function setHaulingStatus(msg, isErr = false) {
    const el = haulingPanel.querySelector("[data-hauling-status]");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("err", !!isErr);
  }

  async function fetchHauling() {
    const r = await fetch(`/hauling?player=${encodeURIComponent(player)}&t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("hauling fetch failed");
    return r.json();
  }

  async function refreshHaulingPanel() {
    try {
      const data = await fetchHauling();
      haulingRoutesCache = Array.isArray(data.routes) ? data.routes : [];
      if (haulingSelectedRouteId >= 0 && !haulingRoutesCache.some(r => r.id === haulingSelectedRouteId))
        haulingSelectedRouteId = -1;
    } catch {
      haulingRoutesCache = [];
    }
    // Free-cart pool for the picker. A failure here must not blank the routes, so it is caught
    // separately and simply yields an empty pool ("No free minecarts").
    try {
      const r = await fetch(`/hauling-vehicles?t=${Date.now()}`, { cache: "no-store" });
      const data = r.ok ? await r.json() : {};
      haulingFreeVehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    } catch {
      haulingFreeVehicles = [];
    }
    // Drop the expanded-stop selection if that stop went away underneath us.
    if (haulingOpenStopKey) {
      const [rid, sid] = haulingOpenStopKey.split(":").map(Number);
      const route = haulingRoutesCache.find(x => x.id === rid);
      if (!route || !(route.stops || []).some(x => x.id === sid)) haulingOpenStopKey = "";
    }
    renderHaulingPanel();
  }

  function renderHaulingPanel() {
    haulingPanel.innerHTML = window.DwfControlShell.haulingPanelMarkup({
      routes: haulingRoutesCache, armedRouteId: window.DFPlacementController.haulingStopArmedRoute,
      selectedRouteId: haulingSelectedRouteId,
      openStopKey: haulingOpenStopKey, condDraft: haulingCondDraft,
      linkArmed: window.DFPlacementController.haulingLinkArmed,
      freeVehicles: haulingFreeVehicles,
      renamingRouteId: window.DFPlacementController.haulingRenamingRouteId, renamingStopKey: window.DFPlacementController.haulingRenamingStopKey,
    });
    window.DwfControlShell.paintControlIcons(haulingPanel);
    // ---- rename: routes (live) and stops (needs the newer server; the tile greys itself) -------
    const haulingRenameSave = async (url, okMsg) => {
      try {
        const r = await fetch(url, { method: "POST", cache: "no-store" });
        if (!r.ok) throw new Error("rename failed");
        await refreshHaulingPanel();
        setHaulingStatus(okMsg);
      } catch { renderHaulingPanel(); setHaulingStatus("Rename failed.", true); }
    };
    haulingPanel.querySelectorAll("[data-hauling-route-rename]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.haulingRouteRename);
      window.DFPlacementController.haulingRenamingRouteId = window.DFPlacementController.haulingRenamingRouteId === id ? -1 : id;
      window.DFPlacementController.haulingRenamingStopKey = "";
      renderHaulingPanel();
      const input = haulingPanel.querySelector(`[data-hauling-route-rename-input="${id}"]`);
      if (input) { input.focus(); input.select(); }
    }));
    const saveRouteRename = id => {
      const input = haulingPanel.querySelector(`[data-hauling-route-rename-input="${id}"]`);
      const name = input ? input.value : "";
      window.DFPlacementController.haulingRenamingRouteId = -1;
      return haulingRenameSave(
        `/hauling-route-rename?player=${encodeURIComponent(player)}&id=${id}&name=${encodeURIComponent(name)}`,
        "Route renamed.");
    };
    haulingPanel.querySelectorAll("[data-hauling-route-rename-save]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      saveRouteRename(Number(b.dataset.haulingRouteRenameSave));
    }));
    haulingPanel.querySelectorAll("[data-hauling-route-rename-input]").forEach(input =>
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); saveRouteRename(Number(input.dataset.haulingRouteRenameInput)); }
        if (event.key === "Escape") { window.DFPlacementController.haulingRenamingRouteId = -1; renderHaulingPanel(); }
        event.stopPropagation();
      }));
    haulingPanel.querySelectorAll("[data-hauling-stop-rename]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      // The tile is drawn even when this server cannot rename a stop, so a click on the disabled
      // face must say so rather than open a field whose Save would 404.
      if (!(typeof window.dwfHasServerFeature === "function" &&
            window.dwfHasServerFeature("hauling-stop-rename"))) {
        setHaulingStatus("This server cannot rename a stop yet.", true);
        return;
      }
      const key = String(b.dataset.haulingStopRename || "");
      window.DFPlacementController.haulingRenamingStopKey = window.DFPlacementController.haulingRenamingStopKey === key ? "" : key;
      window.DFPlacementController.haulingRenamingRouteId = -1;
      renderHaulingPanel();
      const input = haulingPanel.querySelector(`[data-hauling-stop-rename-input="${key}"]`);
      if (input) { input.focus(); input.select(); }
    }));
    const saveStopRename = key => {
      const input = haulingPanel.querySelector(`[data-hauling-stop-rename-input="${key}"]`);
      const name = input ? input.value : "";
      const [routeId, stopId] = String(key).split(":").map(Number);
      window.DFPlacementController.haulingRenamingStopKey = "";
      return haulingRenameSave(
        `/hauling-stop-rename?player=${encodeURIComponent(player)}&route=${routeId}&stop=${stopId}&name=${encodeURIComponent(name)}`,
        "Stop renamed.");
    };
    haulingPanel.querySelectorAll("[data-hauling-stop-rename-save]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      saveStopRename(String(b.dataset.haulingStopRenameSave || ""));
    }));
    haulingPanel.querySelectorAll("[data-hauling-stop-rename-input]").forEach(input =>
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); saveStopRename(String(input.dataset.haulingStopRenameInput || "")); }
        if (event.key === "Escape") { window.DFPlacementController.haulingRenamingStopKey = ""; renderHaulingPanel(); }
        event.stopPropagation();
      }));
    haulingPanel.querySelectorAll("[data-hauling-select]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.haulingSelect);
      haulingSelectedRouteId = haulingSelectedRouteId === id ? -1 : id;
      renderHaulingPanel();
    }));
    haulingPanel.querySelector("[data-hauling-add]")?.addEventListener("click", async event => {
      event.stopPropagation();
      try {
        const r = await fetch(`/hauling-route-create?player=${encodeURIComponent(player)}&name=${encodeURIComponent("New Route")}`, { method: "POST", cache: "no-store" });
        if (!r.ok) throw new Error("create failed");
        const data = await r.json();
        await refreshHaulingPanel();
        if (typeof data.id === "number") { haulingSelectedRouteId = data.id; renderHaulingPanel(); }
        setHaulingStatus("Route created.");
      } catch { setHaulingStatus("Create failed.", true); }
      focusPage();
    });
    haulingPanel.querySelectorAll("[data-hauling-stop-arm]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.haulingStopArm);
      window.DFPlacementController.haulingStopArmedRoute = window.DFPlacementController.haulingStopArmedRoute === id ? -1 : id;
      window.DFPlacementController.haulingLinkArmed = null;
      window.updateToolCursor();
      renderHaulingPanel();
      focusPage();
    }));
    haulingPanel.querySelector("[data-hauling-stop-done]")?.addEventListener("click", event => {
      event.stopPropagation();
      window.DFPlacementController.haulingStopArmedRoute = -1;
      window.updateToolCursor();
      renderHaulingPanel();
      focusPage();
    });
    haulingPanel.querySelectorAll("[data-hauling-route-remove]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const id = Number(b.dataset.haulingRouteRemove);
      try {
        const r = await fetch(`/hauling-route-remove?player=${encodeURIComponent(player)}&id=${id}`, { method: "POST", cache: "no-store" });
        if (!r.ok) {
          // A 501 {"guarded":true} carries the host-guard sentence -- show it verbatim.
          let msg = "Remove failed.";
          try { const g = await r.json(); if (g && g.guarded && g.error) msg = g.error; }
          catch (err) { DwfErr.report("hauling.remove-detail", err); }
          throw new Error(msg);
        }
        if (haulingSelectedRouteId === id) haulingSelectedRouteId = -1;
        if (window.DFPlacementController.haulingStopArmedRoute === id) { window.DFPlacementController.haulingStopArmedRoute = -1; window.updateToolCursor(); }
        if (window.DFPlacementController.haulingLinkArmed && window.DFPlacementController.haulingLinkArmed.route === id) {
          window.DFPlacementController.haulingLinkArmed = null;
          window.updateToolCursor();
        }
        await refreshHaulingPanel();
        setHaulingStatus("Route removed.");
      } catch (err) { setHaulingStatus(err && err.message ? err.message : "Remove failed.", true); }
    }));
    haulingPanel.querySelectorAll("[data-hauling-stop-remove]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const [routeId, stopId] = b.dataset.haulingStopRemove.split(":").map(Number);
      try {
        const r = await fetch(`/hauling-stop-remove?player=${encodeURIComponent(player)}&route=${routeId}&stop=${stopId}`, { method: "POST", cache: "no-store" });
        if (!r.ok) {
          let msg = "Stop remove failed.";
          try { const g = await r.json(); if (g && g.guarded && g.error) msg = g.error; }
          catch (err) { DwfErr.report("hauling.stop-remove-detail", err); }
          throw new Error(msg);
        }
        if (window.DFPlacementController.haulingLinkArmed && window.DFPlacementController.haulingLinkArmed.route === routeId &&
            window.DFPlacementController.haulingLinkArmed.stop === stopId) {
          window.DFPlacementController.haulingLinkArmed = null;
          window.updateToolCursor();
        }
        await refreshHaulingPanel();
        setHaulingStatus("Stop removed.");
      } catch (err) { setHaulingStatus(err && err.message ? err.message : "Stop remove failed.", true); }
    }));
    // ---- hauling handlers --------------------------------------------------------------------
    const postHauling = async (url, okMsg, failMsg, beforeRefresh = null) => {
      try {
        const r = await fetch(url, { method: "POST", cache: "no-store" });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || failMsg); }
        if (typeof beforeRefresh === "function") beforeRefresh();
        await refreshHaulingPanel();
        setHaulingStatus(okMsg);
        return true;
      } catch (err) {
        setHaulingStatus(err.message || failMsg, true);
        return false;
      }
    };

    const haulingStopFromCache = (routeId, stopId) => {
      const route = haulingRoutesCache.find(row => Number(row.id) === Number(routeId));
      return route && (route.stops || []).find(row => Number(row.id) === Number(stopId));
    };

    haulingPanel.querySelectorAll("[data-hauling-link-arm]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const [route, stop, mode] = String(b.dataset.haulingLinkArm || "").split(":");
      const next = { route: Number(route), stop: Number(stop), mode: mode === "give" ? "give" : "take" };
      window.DFPlacementController.haulingLinkArmed = window.DFPlacementController.haulingLinkArmed &&
        window.DFPlacementController.haulingLinkArmed.route === next.route && window.DFPlacementController.haulingLinkArmed.stop === next.stop &&
        window.DFPlacementController.haulingLinkArmed.mode === next.mode ? null : next;
      window.DFPlacementController.haulingStopArmedRoute = -1;
      window.updateToolCursor();
      renderHaulingPanel();
    }));
    haulingPanel.querySelectorAll("[data-hauling-link-done]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      window.DFPlacementController.haulingLinkArmed = null;
      window.updateToolCursor();
      renderHaulingPanel();
    }));
    haulingPanel.querySelectorAll("[data-hauling-link-toggle]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const [routeId, stopId, buildingId, field] =
        String(b.dataset.haulingLinkToggle || "").split(":");
      const stop = haulingStopFromCache(Number(routeId), Number(stopId));
      const link = stop && (stop.stockpiles || []).find(row => Number(row.buildingId) === Number(buildingId));
      if (!link) { setHaulingStatus("That stockpile link no longer exists.", true); return; }
      const take = field === "take" ? !link.take : !!link.take;
      const give = field === "give" ? !link.give : !!link.give;
      const url = take || give
        ? `/hauling-stop-link?player=${encodeURIComponent(player)}&route=${routeId}&stop=${stopId}` +
          `&building=${buildingId}&take=${take ? 1 : 0}&give=${give ? 1 : 0}`
        : `/hauling-stop-link-remove?player=${encodeURIComponent(player)}&route=${routeId}` +
          `&stop=${stopId}&building=${buildingId}`;
      await postHauling(url, take || give ? "Stockpile link updated." : "Stockpile link removed.",
        "Stockpile link update failed.");
    }));
    haulingPanel.querySelectorAll("[data-hauling-link-remove]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const [routeId, stopId, buildingId] = String(b.dataset.haulingLinkRemove || "").split(":");
      await postHauling(
        `/hauling-stop-link-remove?player=${encodeURIComponent(player)}&route=${routeId}` +
          `&stop=${stopId}&building=${buildingId}`,
        "Stockpile link removed.", "Stockpile link remove failed.");
    }));

    haulingPanel.querySelectorAll("[data-hauling-vehicle-add]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const [routeId, itemId] = b.dataset.haulingVehicleAdd.split(":").map(Number);
      await postHauling(
        `/hauling-vehicle-assign?player=${encodeURIComponent(player)}&route=${routeId}&item=${itemId}&on=1`,
        "Minecart assigned.", "Assign failed.");
    }));
    haulingPanel.querySelectorAll("[data-hauling-vehicle-remove]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const [routeId, itemId] = b.dataset.haulingVehicleRemove.split(":").map(Number);
      await postHauling(
        `/hauling-vehicle-assign?player=${encodeURIComponent(player)}&route=${routeId}&item=${itemId}&on=0`,
        "Minecart released.", "Release failed.");
    }));

    // Expand a stop -> its desired-items summary + departure-condition editor.
    haulingPanel.querySelectorAll("[data-hauling-stop-open]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const key = b.dataset.haulingStopOpen;
      haulingOpenStopKey = haulingOpenStopKey === key ? "" : key;
      haulingCondDraft = {};      // a fresh stop gets a fresh draft condition
      renderHaulingPanel();
    }));

    haulingPanel.querySelectorAll("[data-hauling-cond-mode]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      haulingCondDraft = { ...haulingCondDraft, mode: b.dataset.haulingCondMode };
      renderHaulingPanel();
    }));
    haulingPanel.querySelectorAll("[data-hauling-cond-dir]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      haulingCondDraft = { ...haulingCondDraft, direction: b.dataset.haulingCondDir };
      renderHaulingPanel();
    }));
    haulingPanel.querySelectorAll("[data-hauling-cond-load]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      haulingCondDraft = { ...haulingCondDraft, loadPercent: Number(b.dataset.haulingCondLoad) };
      renderHaulingPanel();
    }));
    haulingPanel.querySelectorAll("[data-hauling-cond-atmost]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      haulingCondDraft = { ...haulingCondDraft, atMost: !haulingCondDraft.atMost };
      renderHaulingPanel();
    }));
    haulingPanel.querySelectorAll("[data-hauling-cond-desired]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      haulingCondDraft = { ...haulingCondDraft, desired: !haulingCondDraft.desired };
      renderHaulingPanel();
    }));

    haulingPanel.querySelectorAll("[data-hauling-cond-add]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const [routeId, stopId] = b.dataset.haulingCondAdd.split(":").map(Number);
      const d = haulingCondDraft || {};
      const q = new URLSearchParams({
        player, route: String(routeId), stop: String(stopId),
        mode: d.mode || "push", direction: d.direction || "north",
        load: String(d.loadPercent == null ? 100 : d.loadPercent),
        atmost: d.atMost ? "1" : "0", desired: d.desired ? "1" : "0",
        timeout: "0",
      });
      await postHauling(`/hauling-stop-conditions?${q}`, "Departure condition added.",
        "Add condition failed.", () => { haulingCondDraft = {}; });
    }));
    haulingPanel.querySelectorAll("[data-hauling-cond-remove]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const [routeId, stopId, index] = b.dataset.haulingCondRemove.split(":").map(Number);
      await postHauling(
        `/hauling-stop-conditions-remove?player=${encodeURIComponent(player)}&route=${routeId}&stop=${stopId}&index=${index}`,
        "Condition removed.", "Remove failed.");
    }));

    // A hauling stop's `settings` is a df::stockpile_settings -- the same struct a pile carries --
    // which is why the stop reuses the stockpile panel's item editor instead of growing a second one.
    haulingPanel.querySelectorAll("[data-hauling-desired-edit]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const [routeId, stopId] = b.dataset.haulingDesiredEdit.split(":").map(Number);
      const opener = window.DFStockpileSettings && window.DFStockpileSettings.openForHaulingStop;
      if (typeof opener !== "function") {
        setHaulingStatus("The item editor is unavailable in this build.", true);
        return;
      }
      opener(routeId, stopId, () => refreshHaulingPanel());
    }));
  }

  async function haulingStopClick(event) {
    const routeId = window.DFPlacementController.haulingStopArmedRoute;
    const pixel = imagePixelFromEvent(event);
    if (!pixel) return;
    try {
      const url = `/hauling-stop-add?player=${encodeURIComponent(player)}&route=${routeId}` +
        `&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}&name=${encodeURIComponent("Stop")}`;
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "add failed"); }
      await refreshHaulingPanel();
      setHaulingStatus("Stop added.");
    } catch (err) {
      setHaulingStatus(err.message || "Add stop failed.", true);
    }
  }

  async function haulingLinkClick(event) {
    const armed = window.DFPlacementController.haulingLinkArmed;
    const pixel = imagePixelFromEvent(event);
    if (!pixel || !armed) return;
    try {
      const rendered = renderedImageRect();
      const latest = window.placementLatest();
      const worldX = rendered ? Number(rendered.ox) + Number(pixel.x) : NaN;
      const worldY = rendered ? Number(rendered.oy) + Number(pixel.y) : NaN;
      const worldZ = rendered ? Number(rendered.oz) : NaN;
      let buildingId = DwfControlShell.stockpileBuildingAt(
        latest && latest.buildings, worldX, worldY, worldZ);
      if (!(buildingId >= 0)) {
        const inspectUrl = `/inspect?player=${encodeURIComponent(player)}&px=${pixel.x}&py=${pixel.y}` +
          `&w=${pixel.w}&h=${pixel.h}`;
        const r = await fetch(inspectUrl, { cache: "no-store" });
        const data = r.ok ? await r.json() : null;
        const kind = String(data && data.kind || "").toLowerCase();
        buildingId = kind === "stockpile" && typeof selectionBuildingId === "function"
          ? Number(selectionBuildingId(data)) : -1;
      }
      if (!(buildingId >= 0)) throw new Error("Click a stockpile on the map to link it.");
      const route = haulingRoutesCache.find(row => Number(row.id) === armed.route);
      const stop = route && (route.stops || []).find(row => Number(row.id) === armed.stop);
      const existing = stop && (stop.stockpiles || [])
        .find(row => Number(row.buildingId) === buildingId);
      const take = !!(existing && existing.take) || armed.mode === "take";
      const give = !!(existing && existing.give) || armed.mode === "give";
      const linkUrl = `/hauling-stop-link?player=${encodeURIComponent(player)}&route=${armed.route}` +
        `&stop=${armed.stop}&building=${buildingId}&take=${take ? 1 : 0}&give=${give ? 1 : 0}`;
      const linked = await fetch(linkUrl, { method: "POST", cache: "no-store" });
      if (!linked.ok) {
        const detail = await linked.json().catch(() => ({}));
        throw new Error(detail.error || "Stockpile link failed.");
      }
      await refreshHaulingPanel();
      setHaulingStatus(`Stockpile #${buildingId} linked.`);
    } catch (err) {
      setHaulingStatus((err && err.message) || "Stockpile link failed.", true);
    }
  }

  function closeHaulingMode() {
    window.DFPlacementController.haulingMode = null;
    window.DFPlacementController.haulingStopArmedRoute = -1;
    window.DFPlacementController.haulingLinkArmed = null;
    haulingPanel.hidden = true;
    if (typeof window.updateDesignationButtons === "function") window.updateDesignationButtons();
  }
  function enterHaulingMode() {
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("hauling");
    clearBuildPlacement(false);
    window.closeStockMode();
    window.closeZoneMode();
    window.closeBurrowMode();
    window.DFPlacementController.currentTool = null;
    window.DFPlacementController.selectedDesignation = null;
    window.DFPlacementController.digMenuOpen = false;
    window.DFPlacementController.plantMenuOpen = false;
    window.DFPlacementController.smoothMenuOpen = false;
    window.DFPlacementController.itemDesigMenuOpen = false;
    window.DFPlacementController.haulingMode = "open";
    window.DFPlacementController.haulingStopArmedRoute = -1;
    window.DFPlacementController.haulingLinkArmed = null;
    haulingPanel.hidden = false;
    window.updateDesignationButtons();
    window.updateToolCursor();
    refreshHaulingPanel();
  }
  function toggleHaulingPanel() {
    if (window.DFPlacementController.haulingMode) { closeHaulingMode(); return; }
    enterHaulingMode();
  }

  // Squad Move: one plain click while armed sends /squad-order?action=move for the clicked tile.
  // squadMoveMembers is the ticked roster subset, a CSV of position indices, empty for the squad.

  if (typeof window !== "undefined") Object.assign(window, {
    haulingStopClick, haulingLinkClick, closeHaulingMode, toggleHaulingPanel,
  });
