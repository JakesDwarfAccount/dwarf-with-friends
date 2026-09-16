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

  const zonePalette = document.createElement("div");
  zonePalette.id = "zonePalette";
  zonePalette.hidden = true;
  zonePalette.innerHTML = window.DwfControlShell.zonePaletteMarkup();
  document.body.appendChild(zonePalette);
  // openPanel()/selectBuildItem() hide this palette DIRECTLY without knowing about zoneMode, so
  // resync here or the paint submenu and Accept dialog outlive it.
  new MutationObserver(() => {
    if (window.DFPlacementController.zoneMode && window.DFPlacementController.zoneMode !== "repaint" && zonePalette.hidden) window.closeZoneMode();
  }).observe(zonePalette, { attributes: true, attributeFilter: ["hidden", "style"] });
  function registerZonePalette() {
    if (!window.DFPanelFrame || !window.DFPanelFrame.register) return;
    window.DFPanelFrame.register({
      key: "zonePalette", el: () => zonePalette, title: "Zones",
      closable: true, menu: false, zBand: false, escClosable: false, persistOpen: false,
      resizable: { minW: 260, minH: 200 },
      fillSel: ".zone-type-panel",
      isOpen: () => !zonePalette.hidden,
      open: () => { if (!window.DFPlacementController.zoneMode && typeof openPanel === "function") openPanel("zone"); },
      close: () => { if (window.DFPlacementController.zoneMode) { window.closeZoneMode(); setActiveToolbar(null); } },
    });
  }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", registerZonePalette);
  else registerZonePalette();

  // Floating paint dialog (Accept), same corner + chrome as the stockpile one (#stockPalette).
  const zonePaintFloat = document.createElement("div");
  zonePaintFloat.id = "zonePaintFloat";
    zonePaintFloat.hidden = true;
  zonePaintFloat.innerHTML = `
    <div class="stock-paint-row">
      <span class="stock-paint-text" data-zone-paint-text>Click in the play area to paint the zone.</span>
      <span class="zone-paint-actions">
        ${DWFUI.plaqueBtnHtml({ cls: "zone-paint-cancel", dataset: { zoneCancel: "" }, label: "Done", tone: "red", title: "Done painting this zone" })}
        ${DWFUI.plaqueBtnHtml({ cls: "stock-paint-accept", dataset: { zoneAccept: "" }, label: "Accept", tone: "green", title: "Accept this zone" })}
      </span>
    </div>
    <div class="zone-repaint-summary" data-zone-repaint-summary hidden>
      <span class="zone-repaint-summary-icon" data-zone-repaint-summary-icon></span>
      <span data-zone-repaint-summary-copy></span>
    </div>
    <div class="zone-repaint-tools" data-zone-repaint-tools hidden>
      ${DWFUI.artBtnHtml({ sprite: "BUTTON_PAINT_RECTANGLE_INACTIVE", dataset: { zoneRepaintTool: "rect" },
        title: "Paint a rectangle to extend this zone", ariaLabel: "Rectangle paint" })}
      ${DWFUI.artBtnHtml({ sprite: "BUTTON_FREE_PAINT_INACTIVE", dataset: { zoneRepaintTool: "free" },
        title: "Paint freehand to extend this zone", ariaLabel: "Freehand paint" })}
      ${DWFUI.artBtnHtml({ sprite: "ZONE_ERASE_INACTIVE", dataset: { zoneRepaintTool: "erase" },
        title: "Erase painted parts of this zone", ariaLabel: "Erase parts of zone" })}
      ${DWFUI.artBtnHtml({ sprite: "ZONE_REMOVE_EXISTING", dataset: { zoneRepaintTool: "remove" },
        title: "Remove this entire zone", ariaLabel: "Remove entire zone" })}
    </div>
    <div class="stock-palette-status" data-zone-status></div>
  `;
  document.body.appendChild(zonePaintFloat);
  function setZoneStatus(msg, isErr = false) {
    const el = zonePaintFloat.querySelector("[data-zone-status]");
    if (!el) return;
    el.innerHTML = DWFUI.statusHtml({ tag: "span", cls: "zone-status-copy", tone: isErr ? "danger" : "dim", text: msg || "", role: "status", live: "polite" });
    el.classList.toggle("err", !!isErr);
  }

  const zoneSubmenu = document.getElementById("zoneSubmenu");
  const zoneEraseButton = document.querySelector("[data-zone-erase]");
  const zoneRemoveButton = document.querySelector("[data-zone-remove-existing]");
  const zoneRepaintSummary = zonePaintFloat.querySelector("[data-zone-repaint-summary]");
  const zoneRepaintSummaryIcon = zonePaintFloat.querySelector("[data-zone-repaint-summary-icon]");
  const zoneRepaintSummaryCopy = zonePaintFloat.querySelector("[data-zone-repaint-summary-copy]");
  const zoneRepaintTools = zonePaintFloat.querySelector("[data-zone-repaint-tools]");
  function zoneRepaintTarget() {
    return currentZones.find(zone => Number(zone.id) === Number(window.DFPlacementController.zoneRepaintId)) || null;
  }
  function zoneTileCount(zone) {
    if (!zone) return 0;
    const ext = typeof zone.extents === "string" ? zone.extents : "";
    if (ext) return (ext.match(/1/g) || []).length;
    return Math.max(0, (Number(zone.w) || 0) * (Number(zone.h) || 0));
  }
  function zoneWorldPresent(zone, wx, wy) {
    if (!zone) return false;
    return zoneExtentAt(zone, Number(wx) - Number(zone.x), Number(wy) - Number(zone.y));
  }
  function ensureZoneRepaintDraft() {
    if (window.DFPlacementController.zoneRepaintDraft) return window.DFPlacementController.zoneRepaintDraft;
    const source = zoneRepaintTarget();
    if (!source) return null;
    const zone = { id: Number(source.id), x: Number(source.x), y: Number(source.y),
      z: Number(source.z), w: Number(source.w), h: Number(source.h),
      extents: String(source.extents || "") };
    window.DFPlacementController.zoneRepaintDraft = { zone, changes: new Map() };
    return window.DFPlacementController.zoneRepaintDraft;
  }
  function setZoneDraftTile(draft, wx, wy, present) {
    if (!draft) return;
    const key = `${wx},${wy}`;
    if (zoneWorldPresent(draft.zone, wx, wy) === !!present) draft.changes.delete(key);
    else draft.changes.set(key, !!present);
  }
  function zoneRepaintDelta() {
    const draft = window.DFPlacementController.zoneRepaintDraft;
    if (!draft) return 0;
    let delta = 0;
    draft.changes.forEach(present => { delta += present ? 1 : -1; });
    return delta;
  }
  function publishZonePaintSession() {
    const S = window.DwfPaintSession;
    if (!S) return;
    if (window.DFPlacementController.zoneRepaintId == null) { S.clear(); return; }
    const draft = window.DFPlacementController.zoneRepaintDraft;
    const shape = (draft && draft.changes && draft.changes.size) ? window.zoneRepaintFinalShape(draft) : null;
    S.publish("zone", window.DFPlacementController.zoneRepaintId, (shape && !shape.empty) ? shape : null, !!window.DFPlacementController.zoneEraseArmed);
  }
  function updateZoneRepaintSummary() {
    publishZonePaintSession();
    if (!zoneRepaintSummary) return;
    const repainting = window.DFPlacementController.zoneMode === "repaint" && window.DFPlacementController.zoneRepaintId != null;
    zoneRepaintSummary.hidden = !repainting;
    if (!repainting) {
      if (zoneRepaintSummaryIcon) zoneRepaintSummaryIcon.innerHTML = "";
      if (zoneRepaintSummaryCopy) zoneRepaintSummaryCopy.innerHTML = "";
      return;
    }
    const label = (window.DFPlacementController.zoneRepaintMeta && window.DFPlacementController.zoneRepaintMeta.label) || "Zone";
    const count = zoneTileCount(zoneRepaintTarget());
    const delta = window.DFPlacementController.zoneRemoveArmed ? -count : zoneRepaintDelta();
    if (zoneRepaintSummaryIcon) {
      const sprite = window.DFPlacementController.zoneRepaintMeta && window.DFPlacementController.zoneRepaintMeta.sprite;
      zoneRepaintSummaryIcon.innerHTML = sprite ? DWFUI.iconHtml({ sprite, size: 32, alt: "" }) : "";
      if (sprite && typeof DWFUI.paintSprites === "function") DWFUI.paintSprites(zoneRepaintSummaryIcon);
    }
    if (zoneRepaintSummaryCopy)
      zoneRepaintSummaryCopy.innerHTML = DWFUI.bitmapTextHtml(
        `${label}: ${count} ${delta < 0 ? "-" : "+"} ${Math.abs(delta)}`,
        { cls: "zone-repaint-summary-text" });
  }
  function updateZoneButtons() {
    const painting = window.DFPlacementController.zoneMode === "paint" || window.DFPlacementController.zoneMode === "repaint";
    const repainting = window.DFPlacementController.zoneMode === "repaint";
    if (zoneSubmenu) {
      zoneSubmenu.classList.toggle("visible", painting && !repainting);
      zoneSubmenu.setAttribute("aria-hidden", painting && !repainting ? "false" : "true");
    }
    document.querySelectorAll("#zoneSubmenu [data-paint-mode]").forEach(b => {
      const mode = b.dataset.paintMode;
      window.paintSprite(b, mode === "free" ? "paintFree" : "paintRect", window.paintModeOf("zone") === mode);
    });
    if (zoneEraseButton) window.paintSprite(zoneEraseButton, "zoneErase", window.DFPlacementController.zoneEraseArmed);
    if (zoneRemoveButton) window.paintSprite(zoneRemoveButton, "zoneRemoveExisting", window.DFPlacementController.zoneRemoveArmed);
    zonePaintFloat.hidden = !painting;
    // Existing-zone edits are staged and acceptZoneRepaint() is their ONLY commit path, so this plaque
    // must stay reachable; hiding it makes every non-removal draft impossible to finish.
    const zoneAcceptBtn = zonePaintFloat.querySelector("[data-zone-accept]");
    if (zoneAcceptBtn)
      zoneAcceptBtn.hidden = !(repainting || window.DFPlacementController.zoneRemoveArmed || window.DFPlacementController.zoneLiveId != null);
    if (zoneRepaintTools) zoneRepaintTools.hidden = !repainting;
    zonePaintFloat.querySelectorAll("[data-zone-repaint-tool]").forEach(button => {
      const tool = button.dataset.zoneRepaintTool;
      if (tool === "rect") window.paintSprite(button, "paintRect", !window.DFPlacementController.zoneEraseArmed && !window.DFPlacementController.zoneRemoveArmed && window.paintModeOf("zone") === "rect");
      else if (tool === "free") window.paintSprite(button, "paintFree", !window.DFPlacementController.zoneEraseArmed && !window.DFPlacementController.zoneRemoveArmed && window.paintModeOf("zone") === "free");
      else if (tool === "erase") window.paintSprite(button, "zoneErase", window.DFPlacementController.zoneEraseArmed);
      else window.paintSprite(button, "zoneRemoveExisting", window.DFPlacementController.zoneRemoveArmed);
    });
    const label = window.DFPlacementController.zonePreset && window.ZONE_TYPES.find(t => t[1] === window.DFPlacementController.zonePreset);
    const txt = zonePaintFloat.querySelector("[data-zone-paint-text]");
    if (txt) txt.textContent = repainting ? (window.DFPlacementController.zoneRemoveArmed
      ? "Accept to remove this zone."
      : window.DFPlacementController.zoneEraseArmed ? "Click in the play area to erase parts of the zone."
      : "Click in the play area to paint the zone.")
      : window.DFPlacementController.zoneRemoveArmed ? "Click an existing zone to remove it."
      : window.DFPlacementController.zoneEraseArmed ? "Paint over an existing zone to erase it."
      : `Click in the play area to paint the ${label ? label[0] : "zone"}.`;
    updateZoneRepaintSummary();
  }
  function setZonePreset(key) {
    // Two independent failures: the old zoneRepaintId can win the pointer-up branch, and a zone panel
    // left open by openZonePanel() is docked over #zonePaintFloat's Accept plaque.
    if (key) {
      if (typeof closeSelection === "function") closeSelection();
      if (window.DFPlacementController.zoneMode === "repaint") window.disarmZoneRepaint();
    }
    window.DFPlacementController.zonePreset = key;
    if (key) {  // arming paint: leave every other placement mode
      clearBuildPlacement(false);
      window.closeStockMode();
      window.closeBurrowMode();
      window.DFPlacementController.currentTool = null;
      window.DFPlacementController.selectedDesignation = null;
      window.DFPlacementController.digMenuOpen = false;
      window.DFPlacementController.plantMenuOpen = false;
      window.DFPlacementController.smoothMenuOpen = false;
      window.DFPlacementController.itemDesigMenuOpen = false;
      window.updateDesignationButtons();
      window.DFPlacementController.zoneMode = "paint";
      window.DFPlacementController.zoneEraseArmed = false;
      window.DFPlacementController.zoneRemoveArmed = false;
      window.DFPlacementController.zonePaintPreview = null;
      window.DFPlacementController.zoneFreeBBox = null;
      window.DFPlacementController.zoneLiveId = null;  // a fresh session owns no zone until its first stroke creates one
      window.gestureClear("zone");
      setZoneStatus("");
    } else if (window.DFPlacementController.zoneMode === "paint") {
      window.DFPlacementController.zoneMode = "menu"; // back to the type grid; existing zones become clickable again
      window.DFPlacementController.zoneEraseArmed = false;
      window.DFPlacementController.zoneRemoveArmed = false;
      window.DFPlacementController.zonePaintPreview = null;
      window.DFPlacementController.zoneFreeBBox = null;
    }
    zonePalette.querySelectorAll("[data-zone-type]").forEach(b =>
      b.classList.toggle("active", b.dataset.zoneType === key));
    updateZoneButtons();
    window.updateToolCursor();
    renderZoneOverlay();
  }
  function enterZoneMenu() {
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("zones");
    clearBuildPlacement(false);
    window.closeStockMode();
    window.closeBurrowMode();
    window.DFPlacementController.currentTool = null;
    window.DFPlacementController.selectedDesignation = null;
    window.DFPlacementController.digMenuOpen = false;
    window.DFPlacementController.plantMenuOpen = false;
    window.DFPlacementController.smoothMenuOpen = false;
    window.DFPlacementController.itemDesigMenuOpen = false;
    window.updateDesignationButtons();
    window.DFPlacementController.zoneMode = "menu";
    window.DFPlacementController.zonePreset = null;
    window.DFPlacementController.zoneEraseArmed = false;
    window.DFPlacementController.zoneRemoveArmed = false;
    window.DFPlacementController.zonePaintPreview = null;
    window.DFPlacementController.zoneFreeBBox = null;
    zonePalette.hidden = false;
    zoneOverlayEnabled = true; // zones show in zone mode only (DF v50)
    // restore saved geometry / clamp into the work area, and take panel focus.
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("zonePalette", true); }
    catch (err) { DwfErr.report("zone.panel-open-sync", err); }
    loadZones();
    updateZoneButtons();
    window.updateToolCursor();
  }
  function toggleZonePalette() { // name kept: called from openPanel()'s "zone" route
    // openPanel() hides the palette directly without knowing zoneMode -- resync before toggling.
    if (window.DFPlacementController.zoneMode && zonePalette.hidden) window.closeZoneMode();
    if (window.DFPlacementController.zoneMode) { window.closeZoneMode(); setActiveToolbar(null); return; }
    enterZoneMenu();
  }
  zonePalette.querySelectorAll("[data-zone-type]").forEach(b =>
    b.addEventListener("click", event => {
      event.stopPropagation();
      // Clicking the armed type again disarms back to the menu stage (same as DF's toggle).
      setZonePreset(window.DFPlacementController.zonePreset === b.dataset.zoneType ? null : b.dataset.zoneType);
      focusPage();
    }));
  if (zoneEraseButton) zoneEraseButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    window.gestureClear("zone");
    window.DFPlacementController.zoneEraseArmed = !window.DFPlacementController.zoneEraseArmed;
    window.DFPlacementController.zoneRemoveArmed = false;
    updateZoneButtons();
    window.updateToolCursor();
    focusPage();
  });
  if (zoneRemoveButton) zoneRemoveButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    window.DFPlacementController.zoneRemoveArmed = !window.DFPlacementController.zoneRemoveArmed;
    window.DFPlacementController.zoneEraseArmed = false;
    updateZoneButtons();
    window.updateToolCursor();
    focusPage();
  });
  zonePaintFloat.querySelectorAll("[data-zone-repaint-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (window.DFPlacementController.zoneMode !== "repaint") return;
      const tool = button.dataset.zoneRepaintTool;
      window.gestureClear(window.activePaintSubsystem());
      if (tool === "rect" || tool === "free") {
        window.setPaintModeOf("zone", tool);
        window.DFPlacementController.zoneEraseArmed = false;
        window.DFPlacementController.zoneRemoveArmed = false;
      } else if (tool === "erase") {
        window.DFPlacementController.zoneEraseArmed = !window.DFPlacementController.zoneEraseArmed;
        window.DFPlacementController.zoneRemoveArmed = false;
      } else if (tool === "remove") {
        window.DFPlacementController.zoneRemoveArmed = !window.DFPlacementController.zoneRemoveArmed;
        window.DFPlacementController.zoneEraseArmed = false;
      }
      setZoneStatus("");
      updateZoneButtons();
      window.updateToolCursor();
      renderZoneOverlay();
      focusPage();
    });
  });
  zonePaintFloat.querySelector("[data-zone-accept]").addEventListener("click", async event => {
    event.stopPropagation();
    // Existing-zone add/erase drafts and whole-zone removal share this one explicit commit.
    if (window.DFPlacementController.zoneMode === "repaint") await acceptZoneRepaint();
    else setZonePreset(null);
    focusPage();
  });
  zonePaintFloat.querySelector("[data-zone-cancel]").addEventListener("click", event => {
    event.stopPropagation();
    if (window.DFPlacementController.zoneMode === "repaint") window.disarmZoneRepaint();
    else setZonePreset(null);
    focusPage();
  });
  setInterval(() => { if (zoneOverlayEnabled) loadZones(); }, 1000);

  function freeTraceInto(cells, from, cell) {
    let x = from.x, y = from.y;
    const x1 = cell.x, y1 = cell.y;
    const dx = Math.abs(x1 - x), sx = x < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y), sy = y < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      cells.add(`${x},${y}`);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }
  function zoneRepaintFreePaintTo(cell) {
    if (!window.DFPlacementController.zoneRepaintFreeCells || !cell) return;
    freeTraceInto(window.DFPlacementController.zoneRepaintFreeCells, window.DFPlacementController.zoneRepaintFreeLast || cell, cell);
    window.DFPlacementController.zoneRepaintFreeLast = cell;
  }
  function stockRepaintFreePaintTo(cell) {
    if (!window.DFPlacementController.stockRepaintFreeCells || !cell) return;
    freeTraceInto(window.DFPlacementController.stockRepaintFreeCells, window.DFPlacementController.stockRepaintFreeLast || cell, cell);
    window.DFPlacementController.stockRepaintFreeLast = cell;
  }

  // Convert screen cells to world tiles immediately so panning after a stroke cannot retarget it,
  // and retain mixed add/erase changes in one draft instead of unioning strokes into a rectangle.
  function stageZoneRepaintDrag(x1, y1, x2, y2) {
    if (window.DFPlacementController.zoneRepaintId == null || window.DFPlacementController.zoneRemoveArmed) return;
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    const rendered = renderedImageRect();
    const draft = ensureZoneRepaintDraft();
    if (!a || !b || !rendered || !draft || Number(rendered.oz) !== Number(draft.zone.z)) return;
    const present = !window.DFPlacementController.zoneEraseArmed;
    if (window.paintModeOf("zone") === "free" && window.DFPlacementController.zoneRepaintFreeCells && window.DFPlacementController.zoneRepaintFreeCells.size) {
      window.DFPlacementController.zoneRepaintFreeCells.forEach(key => {
        const [gx, gy] = key.split(",").map(Number);
        setZoneDraftTile(draft, Number(rendered.ox) + gx, Number(rendered.oy) + gy, present);
      });
    } else {
      const gx1 = Math.min(a.x, b.x), gy1 = Math.min(a.y, b.y);
      const gx2 = Math.max(a.x, b.x), gy2 = Math.max(a.y, b.y);
      for (let gy = gy1; gy <= gy2; gy++)
        for (let gx = gx1; gx <= gx2; gx++)
          setZoneDraftTile(draft, Number(rendered.ox) + gx, Number(rendered.oy) + gy, present);
    }
    window.DFPlacementController.zoneRepaintFreeCells = null;
    window.DFPlacementController.zoneRepaintFreeLast = null;
    window.DFPlacementController.zonePaintPreview = null;
    noteZoneRepaintStaged();
  }
  // The shared rectangle gesture is world-addressed: stage those exact tiles into the same draft as
  // the held-drag path, or the gesture spine live-commits and clears the counter before Accept.
  function stageZoneRepaintWorld(wx1, wy1, wx2, wy2, z) {
    if (window.DFPlacementController.zoneRepaintId == null || window.DFPlacementController.zoneRemoveArmed) return;
    const draft = ensureZoneRepaintDraft();
    if (!draft || Number(z) !== Number(draft.zone.z)) return;
    const present = !window.DFPlacementController.zoneEraseArmed;
    for (let wy = Math.min(wy1, wy2); wy <= Math.max(wy1, wy2); wy++)
      for (let wx = Math.min(wx1, wx2); wx <= Math.max(wx1, wx2); wx++)
        setZoneDraftTile(draft, wx, wy, present);
    window.DFPlacementController.zoneRepaintFreeCells = null;
    window.DFPlacementController.zoneRepaintFreeLast = null;
    window.DFPlacementController.zonePaintPreview = null;
    noteZoneRepaintStaged();
  }
  function noteZoneRepaintStaged() {
    const delta = zoneRepaintDelta();
    setZoneStatus(`Pending change: ${delta < 0 ? "-" : "+"}${Math.abs(delta)} tile${Math.abs(delta) === 1 ? "" : "s"}. Click Accept to apply.`);
    updateZoneRepaintSummary();
    renderZoneOverlay();
  }

  async function acceptZoneRepaint() {
    if (window.DFPlacementController.zoneRepaintId == null) return;
    const id = Number(window.DFPlacementController.zoneRepaintId);
    if (window.DFPlacementController.zoneRemoveArmed) {
      // The server (join-auth) is the gate for zone removal; there is no client-side lock check here.
      try {
        const response = await fetch(`/zone-action?id=${id}&action=remove`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error((await response.text()).trim() || "Zone removal was refused.");
        window.disarmZoneRepaint();
        loadZones();
      } catch (err) {
        setZoneStatus(String(err.message || err || "Zone removal was refused."), true);
      }
      return;
    }
    if (!window.DFPlacementController.zoneRepaintDraft || !window.DFPlacementController.zoneRepaintDraft.changes.size) {
      window.disarmZoneRepaint();
      if (typeof openZonePanel === "function") openZonePanel(id);
      return;
    }
    await window.commitZoneRepaintDraft(id, window.DFPlacementController.zoneRepaintDraft);
  }

  // A free-paint stroke on a NEW zone collapses to its bounding rectangle (unionBBox): only the
  // existing-zone repaint session keeps exact cells, so holes here are filled in.
  async function zonePaintDrag(x1, y1, x2, y2) {
    if (!window.DFPlacementController.zonePreset) return;
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    const rendered = renderedImageRect();
    if (!a || !b || !rendered) return;
    let rect = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
    if (window.paintModeOf("zone") === "free" && window.DFPlacementController.zoneFreeBBox) {
      rect = window.unionBBox(rect, window.DFPlacementController.zoneFreeBBox);
      window.DFPlacementController.zoneFreeBBox = null;
    }
    window.DFPlacementController.zonePaintPreview = null;
    const ox = Number(rendered.ox), oy = Number(rendered.oy);
    await window.zonePaintStroke({ x1: ox + rect.x1, y1: oy + rect.y1, x2: ox + rect.x2, y2: oy + rect.y2,
      z: Number(rendered.oz) });
  }
  // Existing-zone hit test against the last /zones snapshot (world coords + extents bitmap).
  function zonesAtEventTile(pixel) {
    const rendered = renderedImageRect();
    if (!pixel || !rendered) return [];
    const wx = (Number(rendered.ox) || 0) + pixel.x;
    const wy = (Number(rendered.oy) || 0) + pixel.y;
    const wz = Number(rendered.oz);
    return currentZones.filter(zn => Number(zn.z) === wz &&
      wx >= zn.x && wy >= zn.y && wx < zn.x + zn.w && wy < zn.y + zn.h &&
      zoneExtentAt(zn, wx - zn.x, wy - zn.y));
  }
  let zoneCycle = { ids: [], idx: 0 };
  window.dfZoneCycle = zoneCycle;
  function zoneSelectClick(event) {
    const pixel = imagePixelFromEvent(event);
    const hits = zonesAtEventTile(pixel);
    if (!hits.length) { window.inspectClick(event); return; } // not a zone: normal inspect
    zoneCycle.ids = hits.map(zn => Number(zn.id));
    zoneCycle.idx = 0;
    zonePalette.hidden = true;
    openZonePanel(zoneCycle.ids[0]);
  }
  async function zoneEraseDrag(x1, y1, x2, y2) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    const rendered = renderedImageRect();
    if (!a || !b || !rendered) return;
    const ox = Number(rendered.ox), oy = Number(rendered.oy);
    await window.zoneEraseRect({
      x1: ox + Math.min(a.x, b.x), y1: oy + Math.min(a.y, b.y),
      x2: ox + Math.max(a.x, b.x), y2: oy + Math.max(a.y, b.y), z: Number(rendered.oz),
    });
  }
  // Removal has no undo, so it takes the shared two-step latch burrow delete uses: a second click
  // on the SAME zone commits, a different zone retargets. Topmost wins on overlap.
  async function zoneRemoveClick(event) {
    const pixel = imagePixelFromEvent(event);
    const hits = zonesAtEventTile(pixel);
    if (!hits.length) { setZoneStatus("No zone there.", true); return; }
    const id = Number(hits[hits.length - 1].id);
    const gate = window.DwfConfirmGate;
    if (gate && gate.press(gate.key("zone-remove", id)) !== "commit") {
      setZoneStatus("Click that zone again to remove it — this cannot be undone.");
      window.confirmGateRerender();
      return;
    }
    window.confirmGateRerender();
    try {
      const r = await fetch(`/zone-action?id=${id}&action=remove`, { method: "POST", cache: "no-store" });
      let msg = r.ok ? "Zone removed." : "Remove failed.";
      if (!r.ok) {
        try { const g = await r.json(); if (g && g.error) msg = g.error; }
        catch (err) { DwfErr.report("zone.remove-detail", err); }
      }
      setZoneStatus(msg, !r.ok);
      if (r.ok) loadZones();
    } catch (_) {
      setZoneStatus("Remove failed.", true);
    }
  }

  if (typeof window !== "undefined") Object.assign(window, {
    setZoneStatus, setZoneDraftTile, updateZoneRepaintSummary, updateZoneButtons, setZonePreset, zoneRepaintFreePaintTo, stockRepaintFreePaintTo, stageZoneRepaintDrag, stageZoneRepaintWorld, zonePaintDrag, zonesAtEventTile, zoneSelectClick, zoneEraseDrag, zoneRemoveClick,
  });

  if (typeof window !== "undefined" && window.DFPlacementController) {
    Object.defineProperties(window.DFPlacementController, {
      zonePalette: { get: () => zonePalette, configurable: true }
    });
  }
