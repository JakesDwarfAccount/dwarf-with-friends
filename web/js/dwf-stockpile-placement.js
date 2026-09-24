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

  const stockPalette = document.createElement("div");
  stockPalette.id = "stockPalette";
  stockPalette.hidden = true;
  stockPalette.innerHTML = `
    <div class="stock-paint-row">
      <span class="stock-paint-text" data-stock-paint-text>Click in the play area to paint the stockpile.</span>
      <span class="zone-paint-actions">
        ${DWFUI.plaqueBtnHtml({ cls: "zone-paint-cancel", dataset: { stockCancel: "" }, label: "Cancel", tone: "red", title: "Discard this stockpile repaint" })}
        ${DWFUI.plaqueBtnHtml({ cls: "stock-paint-accept", dataset: { stockAccept: "" }, label: "Accept", tone: "green", title: "Accept this stockpile" })}
      </span>
    </div>
    <div class="stock-repaint-summary" data-stock-repaint-summary hidden>
      <span data-stock-repaint-summary-copy></span>
    </div>
    <div class="stock-repaint-tools" data-stock-repaint-tools hidden>
      ${DWFUI.artBtnHtml({ sprite: "BUTTON_PAINT_RECTANGLE_INACTIVE", dataset: { stockRepaintTool: "rect" },
        title: "Paint a rectangle to extend this stockpile", ariaLabel: "Rectangle paint" })}
      ${DWFUI.artBtnHtml({ sprite: "BUTTON_FREE_PAINT_INACTIVE", dataset: { stockRepaintTool: "free" },
        title: "Paint freehand to extend this stockpile", ariaLabel: "Freehand paint" })}
      ${DWFUI.artBtnHtml({ sprite: "STOCKPILE_ERASE_INACTIVE", dataset: { stockRepaintTool: "erase" },
        title: "Erase painted parts of this stockpile", ariaLabel: "Erase parts of stockpile" })}
      ${DWFUI.artBtnHtml({ sprite: "STOCKPILE_REMOVE_EXISTING", dataset: { stockRepaintTool: "remove" },
        title: "Remove this entire stockpile", ariaLabel: "Remove entire stockpile" })}
    </div>
    <div class="stock-palette-status" data-stock-status></div>
  `;
  document.body.appendChild(stockPalette);

  function setStockStatus(msg, isErr = false) {
    const el = stockPalette.querySelector("[data-stock-status]");
    if (!el) return;
    el.innerHTML = DWFUI.statusHtml({ tag: "span", cls: "stock-status-copy", tone: isErr ? "danger" : "dim", text: msg || "", role: "status", live: "polite" });
    el.classList.toggle("err", !!isErr);
  }

  const stockSubmenu = document.getElementById("stockSubmenu");
  const stockNewButton = document.querySelector("[data-stock-new]");
  const stockEraseButton = document.querySelector("[data-stock-erase]");
  const stockRemoveButton = document.querySelector("[data-stock-remove-existing]");

  function resetStockPaintSession() {
    window.DFPlacementController.stockPreset = null;
    window.DFPlacementController.stockPileId = -1;
    window.DFPlacementController.stockPileBBox = null;
    window.DFPlacementController.stockFreeBBox = null;
    window.DFPlacementController.stockEraseArmed = false;
    window.DFPlacementController.stockRemoveArmed = false;
    window.gestureClear("stockpile");
  }
  function resetStockRepaintSession() {
    window.DFPlacementController.stockRepaintId = null;
    window.DFPlacementController.stockRepaintMeta = null;
    window.DFPlacementController.stockRepaintDraft = null;
    window.DFPlacementController.stockRepaintFreeCells = null;
    window.DFPlacementController.stockRepaintFreeLast = null;
    window.DFPlacementController.stockRepaintEraseArmed = false;
    window.DFPlacementController.stockRepaintRemoveArmed = false;
    window.gestureClear("stockpile");
    // Drop the shared session too, or the overlays would keep drawing the staged shape over a
    // pile nobody is editing any more.
    try { if (window.DwfPaintSession) window.DwfPaintSession.clear(); }
    catch (err) { DwfErr.report("stockpile.paint-session-clear", err); }
  }
  function closeStockMode() {
    window.DFPlacementController.stockMode = null;
    resetStockRepaintSession();
    resetStockPaintSession();
    stockPalette.hidden = true;
    updateStockButtons();
  }
  // Fully close zone mode: the cross-tool mutual-exclusion reset every other placement tool calls.
  function closeZoneMode() {
    window.DFPlacementController.zoneMode = null;
    window.DFPlacementController.zoneRepaintId = null;
    window.DFPlacementController.zoneRepaintMeta = null;
    window.DFPlacementController.zoneRepaintDraft = null;
    window.DFPlacementController.zoneRepaintFreeCells = null;
    window.DFPlacementController.zoneRepaintFreeLast = null;
    window.DFPlacementController.zonePreset = null;
    window.DFPlacementController.zoneEraseArmed = false;
    window.DFPlacementController.zoneRemoveArmed = false;
    window.DFPlacementController.zonePaintPreview = null;
    window.DFPlacementController.zoneFreeBBox = null;
    window.DFPlacementController.zoneLiveId = null;
    window.gestureClear("zone");
    try { if (window.DwfPaintSession) window.DwfPaintSession.clear(); }
    catch (err) { DwfErr.report("stockpile.zone-paint-session-clear", err); }
    if (window.dfZoneCycle) { window.dfZoneCycle.ids = []; window.dfZoneCycle.idx = 0; }
    if (typeof window.DFPlacementController.zonePalette !== "undefined") window.DFPlacementController.zonePalette.hidden = true;
    zoneOverlayEnabled = false;
    currentZones = [];
    renderZoneOverlay();
    if (typeof window.updateZoneButtons === "function") window.updateZoneButtons();
    // keep the framework's geometry persistence/bookkeeping in sync (registered below).
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("zonePalette", false); }
    catch (err) { DwfErr.report("stockpile.zone-panel-close-sync", err); }
  }
  // Fully close burrow mode (hide the left panel).
  function closeBurrowMode() {
    window.DFPlacementController.burrowMode = null;
    window.DFPlacementController.burrowPaintId = -1;
    window.DFPlacementController.burrowEraseArmed = false;
    window.DFPlacementController.burrowFreeCells = null;
    window.DFPlacementController.burrowFreeLast = null;
    window.gestureClear("burrow");
    window.DFPlacementController.burrowSymbolFor = -1;
    window.DFPlacementController.burrowCitizensFor = -1;
    if (window.DFPlacementController.burrowWindowTimer) { clearInterval(window.DFPlacementController.burrowWindowTimer); window.DFPlacementController.burrowWindowTimer = null; }
    window.DFPlacementController.burrowWindowSig = "";
    if (window.DwfBurrowOverlay) window.DwfBurrowOverlay.setBurrows([]);
    if (typeof window.DFPlacementController.burrowPanel !== "undefined") window.DFPlacementController.burrowPanel.hidden = true;
    if (typeof window.updateBurrowButtons === "function") window.updateBurrowButtons();
  }
  // Arms the repaint SESSION for an EXISTING pile: the pile stays visible, map edits are STAGED as
  // exact world tiles, and only Accept commits (one mode=replace bitmap to /stockpile-repaint).
  function setStockRepaint(id, meta) {
    if (id == null) { disarmStockRepaint(); return; }
    closeStockMode();
    closeZoneMode();
    closeBurrowMode();
    window.DFPlacementController.stockRepaintId = id;
    window.DFPlacementController.stockRepaintMeta = meta || null;
    clearBuildPlacement(false);
    window.DFPlacementController.currentTool = null;
    window.DFPlacementController.selectedDesignation = null;
    window.DFPlacementController.digMenuOpen = false;
    window.DFPlacementController.plantMenuOpen = false;
    window.DFPlacementController.smoothMenuOpen = false;
    window.DFPlacementController.itemDesigMenuOpen = false;
    window.updateDesignationButtons();
    setStockStatus("");
    updateStockButtons();
    window.updateToolCursor();
    // Announce the session BEFORE the base shape arrives: that is what puts the viewport into
    // paint mode (native dims it the moment the mode opens, not when the data lands).
    publishStockPaintSession();
    loadStockRepaintBase(id);
  }
  function disarmStockRepaint() {
    resetStockRepaintSession();
    setStockStatus("");
    updateStockButtons();
    window.updateToolCursor();
    renderZoneOverlay();
  }
  window.DFStockRepaint = {
    arm: setStockRepaint,
    disarm: disarmStockRepaint,
  };
  async function loadStockRepaintBase(id) {
    try {
      const r = await fetch(`/stockpile-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error("info failed");
      const sp = await r.json();
      if (Number(window.DFPlacementController.stockRepaintId) !== Number(id)) return; // session moved on meanwhile
      const w = Number(sp?.size?.w) || 0;
      const h = Number(sp?.size?.h) || 0;
      // Never fall back to a solid all-ones bitmap when the host sends no usable extents: on a pile with
      // a hole, the next Accept would commit the bounding box and fill it. No exact base, no editing.
      const ext = (typeof sp?.extents === "string" && sp.extents.length === w * h) ? sp.extents : null;
      if (!ext) {
        setStockStatus("The host's game did not report this stockpile's exact shape, so it cannot be " +
          "repainted safely. Nothing was changed.", true);
        window.DFPlacementController.stockRepaintDraft = null;
        updateStockButtons();
        return;
      }
      window.DFPlacementController.stockRepaintDraft = {
        zone: { id: Number(id), x: Number(sp?.pos?.x) || 0, y: Number(sp?.pos?.y) || 0,
          z: Number(sp?.pos?.z) || 0, w, h, extents: ext },
        changes: new Map(),
      };
      updateStockButtons();
      publishStockPaintSession();
      renderZoneOverlay();
    } catch {
      if (Number(window.DFPlacementController.stockRepaintId) !== Number(id)) return;
      setStockStatus("Stockpile unavailable -- the pile may have been removed.", true);
    }
  }
  function stockRepaintTileCount() {
    const zone = window.DFPlacementController.stockRepaintDraft && window.DFPlacementController.stockRepaintDraft.zone;
    if (!zone) return 0;
    return (String(zone.extents).match(/1/g) || []).length;
  }
  function stockRepaintDelta() {
    if (!window.DFPlacementController.stockRepaintDraft) return 0;
    let delta = 0;
    window.DFPlacementController.stockRepaintDraft.changes.forEach(present => { delta += present ? 1 : -1; });
    return delta;
  }
  function stageStockRepaintDrag(x1, y1, x2, y2) {
    if (window.DFPlacementController.stockRepaintId == null || window.DFPlacementController.stockRepaintRemoveArmed) return;
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    const rendered = renderedImageRect();
    if (!a || !b || !rendered) return;
    const draft = window.DFPlacementController.stockRepaintDraft;
    if (!draft) {
      setStockStatus("Loading the stockpile's current shape -- paint again in a moment.", true);
      return;
    }
    const present = !window.DFPlacementController.stockRepaintEraseArmed;
    if (window.paintModeOf("stockpile") === "free" && window.DFPlacementController.stockRepaintFreeCells && window.DFPlacementController.stockRepaintFreeCells.size) {
      if (Number(rendered.oz) !== Number(draft.zone.z)) return;
      window.DFPlacementController.stockRepaintFreeCells.forEach(key => {
        const [gx, gy] = key.split(",").map(Number);
        window.setZoneDraftTile(draft, Number(rendered.ox) + gx, Number(rendered.oy) + gy, present);
      });
      window.DFPlacementController.stockRepaintFreeCells = null;
      window.DFPlacementController.stockRepaintFreeLast = null;
      noteStockRepaintStaged();
      return;
    }
    stageStockRepaintWorld(
      Number(rendered.ox) + Math.min(a.x, b.x), Number(rendered.oy) + Math.min(a.y, b.y),
      Number(rendered.ox) + Math.max(a.x, b.x), Number(rendered.oy) + Math.max(a.y, b.y),
      Number(rendered.oz));
  }
  function stageStockRepaintWorld(wx1, wy1, wx2, wy2, z) {
    if (window.DFPlacementController.stockRepaintId == null || window.DFPlacementController.stockRepaintRemoveArmed) return;
    const draft = window.DFPlacementController.stockRepaintDraft;
    if (!draft) {
      setStockStatus("Loading the stockpile's current shape -- paint again in a moment.", true);
      return;
    }
    if (Number(z) !== Number(draft.zone.z)) {
      setStockStatus("That stroke was on a different level than the stockpile, so nothing changed.", true);
      return;
    }
    const present = !window.DFPlacementController.stockRepaintEraseArmed;
    for (let wy = Math.min(wy1, wy2); wy <= Math.max(wy1, wy2); wy++)
      for (let wx = Math.min(wx1, wx2); wx <= Math.max(wx1, wx2); wx++)
        window.setZoneDraftTile(draft, wx, wy, present);
    window.DFPlacementController.stockRepaintFreeCells = null;
    window.DFPlacementController.stockRepaintFreeLast = null;
    noteStockRepaintStaged();
  }
  function noteStockRepaintStaged() {
    const delta = stockRepaintDelta();
    setStockStatus(`Pending change: ${delta < 0 ? "-" : "+"}${Math.abs(delta)} tile${Math.abs(delta) === 1 ? "" : "s"}. Click Accept to apply.`);
    updateStockButtons();
    publishStockPaintSession();
    renderZoneOverlay();
  }
  function publishStockPaintSession() {
    const S = window.DwfPaintSession;
    if (!S) return;
    if (window.DFPlacementController.stockRepaintId == null) { S.clear(); return; }
    const draft = window.DFPlacementController.stockRepaintDraft;
    const shape = draft ? window.zoneRepaintFinalShape(draft) : null;
    S.publish("stockpile", window.DFPlacementController.stockRepaintId,
      (shape && !shape.empty) ? shape : null, !!window.DFPlacementController.stockRepaintEraseArmed);
  }
  // Commit the staged session as ONE exact, world-addressed extent bitmap. On a refusal the SESSION
  // stays open carrying the server's reason; mode=replace edits in place, so the id is unchanged.
  async function acceptStockRepaint() {
    if (window.DFPlacementController.stockRepaintId == null) return;
    const id = Number(window.DFPlacementController.stockRepaintId);
    if (window.DFPlacementController.stockRepaintRemoveArmed) {
      // Same honest remove contract as the detail panel's [data-sp-remove]: HTTP 200
      // {"ok":false} is a refusal, and the pile must visibly survive one.
      let removed = false;
      try {
        const r = await fetch(`/stockpile-remove?id=${id}`, { method: "POST", cache: "no-store" });
        if (r.ok) { const d = await r.json().catch(() => ({})); removed = !d || d.ok !== false; }
      } catch (err) { DwfErr.report("stockpile.repaint-remove", err); }
      if (removed) { disarmStockRepaint(); setActiveToolbar(null); }
      else setStockStatus("Remove failed -- the stockpile is unchanged.", true);
      return;
    }
    const draft = window.DFPlacementController.stockRepaintDraft;
    if (!draft || !draft.changes.size) {
      disarmStockRepaint();
      setActiveToolbar(null);
      if (typeof openStockpilePanel === "function") openStockpilePanel(id);
      return;
    }
    const shape = window.zoneRepaintFinalShape(draft);
    if (!shape || shape.empty) {
      setStockStatus("A stockpile cannot be repainted to zero tiles. Use Remove stockpile instead.", true);
      return;
    }
    const url = `/stockpile-repaint?player=${encodeURIComponent(player)}&id=${id}&mode=replace` +
      `&x1=${shape.x1}&y1=${shape.y1}&x2=${shape.x2}&y2=${shape.y2}&z=${shape.z}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(url, { method: "POST", cache: "no-store", signal: ctl.signal,
        headers: { "Content-Type": "text/plain; charset=utf-8" }, body: shape.extents });
      const text = (await r.text()) || "";
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch (err) { DwfErr.report("stockpile.repaint-response", err); }
      if (!r.ok) {
        // Refusal bodies are plain text. A host DLL older than mode=replace parses the query as the legacy
        // rectangle route and answers 400 "missing id/px/py/w/h" -- name that old-DLL shape honestly.
        let reason = String(data.error || text || "").replace(/\s+$/, "")
          .replace(/^stockpile-repaint (?:failed|refused):\s*/i, "")
          .replace(/^repaint failed:\s*/i, "");
        if (/missing id\/px\/py\/w\/h/.test(reason))
          reason = "The host's game is older than this client and cannot repaint an exact stockpile shape.";
        setStockStatus(reason || "Stockpile repaint was refused.", true);
        return;
      }
      const finalId = Number(data.id);
      disarmStockRepaint();
      setActiveToolbar(null);
      if (typeof openStockpilePanel === "function")
        openStockpilePanel(Number.isInteger(finalId) && finalId >= 0 ? finalId : id);
    } catch {
      setStockStatus("The stockpile-repaint route did not respond -- the host's game may be older than this client.", true);
    } finally {
      clearTimeout(timer);
    }
  }
  // Existing-zone repaint is a SUBMODE of Zones: never call closeZoneMode() here, because that
  // disables the overlay and empties currentZones, and the selected zone vanishes off the map.
  function setZoneRepaint(id, meta) {
    closeStockMode();
    closeBurrowMode();
    window.DFPlacementController.stockRepaintId = null;
    window.DFPlacementController.zoneRepaintId = id;
    window.DFPlacementController.zoneRepaintMeta = meta || null;
    window.DFPlacementController.zoneRepaintDraft = null;
    window.DFPlacementController.zoneRepaintFreeCells = null;
    window.DFPlacementController.zoneRepaintFreeLast = null;
    window.DFPlacementController.zoneMode = "repaint";
    window.DFPlacementController.zonePreset = null;
    window.DFPlacementController.zoneEraseArmed = false;
    window.DFPlacementController.zoneRemoveArmed = false;
    window.DFPlacementController.zonePaintPreview = null;
    window.DFPlacementController.zoneFreeBBox = null;
    zoneOverlayEnabled = true;
    if (typeof window.DFPlacementController.zonePalette !== "undefined") window.DFPlacementController.zonePalette.hidden = true;
    clearBuildPlacement(false);
    window.DFPlacementController.currentTool = null;
    window.DFPlacementController.selectedDesignation = null;
    window.DFPlacementController.digMenuOpen = false;
    window.DFPlacementController.plantMenuOpen = false;
    window.DFPlacementController.smoothMenuOpen = false;
    window.DFPlacementController.itemDesigMenuOpen = false;
    window.updateDesignationButtons();
    window.updateZoneButtons();
    window.updateToolCursor();
    loadZones().then(window.updateZoneRepaintSummary)
      .catch(err => DwfErr.report("stockpile.zone-summary", err));
  }
  function disarmZoneRepaint() {
    window.DFPlacementController.zoneRepaintId = null;
    window.DFPlacementController.zoneRepaintMeta = null;
    window.DFPlacementController.zoneRepaintDraft = null;
    window.DFPlacementController.zoneRepaintFreeCells = null;
    window.DFPlacementController.zoneRepaintFreeLast = null;
    window.DFPlacementController.zoneEraseArmed = false;
    window.DFPlacementController.zoneRemoveArmed = false;
    window.DFPlacementController.zonePaintPreview = null;
    window.DFPlacementController.zoneFreeBBox = null;
    if (window.DFPlacementController.zoneMode === "repaint") window.DFPlacementController.zoneMode = "menu";
    window.updateZoneButtons();
    window.updateToolCursor();
    renderZoneOverlay();
  }
  window.DFZoneRepaint = {
    arm: setZoneRepaint,
    disarm: disarmZoneRepaint,
  };
  function updateStockButtons() {
    if (stockSubmenu) {
      stockSubmenu.classList.toggle("visible", !!window.DFPlacementController.stockMode);
      stockSubmenu.setAttribute("aria-hidden", window.DFPlacementController.stockMode ? "false" : "true");
    }
    const painting = window.DFPlacementController.stockMode === "paint";
    if (stockNewButton) {
    stockNewButton.hidden = painting;
      window.paintSprite(stockNewButton, "stockNew", false);
    }
    document.querySelectorAll("#stockSubmenu [data-paint-mode]").forEach(b => {
      b.hidden = !painting;
      const mode = b.dataset.paintMode;
      window.paintSprite(b, mode === "free" ? "paintFree" : "paintRect", window.paintModeOf("stockpile") === mode);
    });
    if (stockEraseButton) {
    stockEraseButton.hidden = !painting;
      window.paintSprite(stockEraseButton, "stockErase", window.DFPlacementController.stockEraseArmed);
    }
    if (stockRemoveButton) {
    stockRemoveButton.hidden = !painting;
      window.paintSprite(stockRemoveButton, "stockRemoveExisting", window.DFPlacementController.stockRemoveArmed);
    }
    // The float shows for BOTH flows; the summary line, four-tool row and Cancel only in a session.
    const repainting = window.DFPlacementController.stockRepaintId != null;
    stockPalette.hidden = !(painting || repainting);
    const stockCancelBtn = stockPalette.querySelector("[data-stock-cancel]");
    if (stockCancelBtn) stockCancelBtn.hidden = !repainting;
    const stockSummary = stockPalette.querySelector("[data-stock-repaint-summary]");
    if (stockSummary) stockSummary.hidden = !repainting;
    const stockSummaryCopy = stockPalette.querySelector("[data-stock-repaint-summary-copy]");
    if (stockSummaryCopy) {
      if (repainting) {
        const label = (window.DFPlacementController.stockRepaintMeta && window.DFPlacementController.stockRepaintMeta.label) || "Stockpile";
        const count = stockRepaintTileCount();
        const delta = window.DFPlacementController.stockRepaintRemoveArmed ? -count : stockRepaintDelta();
        stockSummaryCopy.innerHTML = DWFUI.bitmapTextHtml(
          `${label}: ${count} ${delta < 0 ? "-" : "+"} ${Math.abs(delta)}`,
          { cls: "zone-repaint-summary-text" });
      } else {
        stockSummaryCopy.innerHTML = "";
      }
    }
    const stockTools = stockPalette.querySelector("[data-stock-repaint-tools]");
    if (stockTools) stockTools.hidden = !repainting;
    stockPalette.querySelectorAll("[data-stock-repaint-tool]").forEach(button => {
      const tool = button.dataset.stockRepaintTool;
      if (tool === "rect") window.paintSprite(button, "paintRect", !window.DFPlacementController.stockRepaintEraseArmed && !window.DFPlacementController.stockRepaintRemoveArmed && window.paintModeOf("stockpile") === "rect");
      else if (tool === "free") window.paintSprite(button, "paintFree", !window.DFPlacementController.stockRepaintEraseArmed && !window.DFPlacementController.stockRepaintRemoveArmed && window.paintModeOf("stockpile") === "free");
      else if (tool === "erase") window.paintSprite(button, "stockErase", window.DFPlacementController.stockRepaintEraseArmed);
      else window.paintSprite(button, "stockRemoveExisting", window.DFPlacementController.stockRepaintRemoveArmed);
    });
    const stockTxt = stockPalette.querySelector("[data-stock-paint-text]");
    if (stockTxt) stockTxt.textContent = repainting ? (window.DFPlacementController.stockRepaintRemoveArmed
      ? "Accept to remove this stockpile."
      : window.DFPlacementController.stockRepaintEraseArmed ? "Click in the play area to erase parts of the stockpile."
      : "Click in the play area to paint the stockpile.")
      : "Click in the play area to paint the stockpile.";
  }
  // Entry stage: stockPreset and stockRepaintId both stay null, so a plain map click still falls
  // through to inspectClick and an existing pile opens its detail panel.
  function enterStockMenu() {
    clearBuildPlacement(false);
    closeZoneMode();
    closeBurrowMode();
    window.DFPlacementController.currentTool = null;
    window.DFPlacementController.selectedDesignation = null;
    window.DFPlacementController.digMenuOpen = false;
    window.DFPlacementController.plantMenuOpen = false;
    window.DFPlacementController.smoothMenuOpen = false;
    window.DFPlacementController.itemDesigMenuOpen = false;
    window.updateDesignationButtons();
    window.DFPlacementController.stockMode = "menu";
    resetStockPaintSession();
    resetStockRepaintSession();
    updateStockButtons();
    window.updateToolCursor();
  }
  function toggleStockPalette() { // name kept: called from openPanel()'s "stockpile" route
    if (window.DFPlacementController.stockMode) { closeStockMode(); setActiveToolbar(null); return; }
    enterStockMenu();
  }
  // Paint stage: arms rect-paint by default (paintMode's shared default).
  function enterStockPaint() {
    window.DFPlacementController.stockMode = "paint";
    resetStockPaintSession();
    window.DFPlacementController.stockPreset = true;
    setStockStatus("");
    updateStockButtons();
    window.updateToolCursor();
  }
  if (stockNewButton) stockNewButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    enterStockPaint();
    focusPage();
  });
  if (stockEraseButton) stockEraseButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    window.DFPlacementController.stockEraseArmed = !window.DFPlacementController.stockEraseArmed;
    window.DFPlacementController.stockRemoveArmed = false;
    window.DFPlacementController.stockPreset = !window.DFPlacementController.stockEraseArmed;
    updateStockButtons();
    window.updateToolCursor();
    focusPage();
  });
  if (stockRemoveButton) stockRemoveButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    window.DFPlacementController.stockRemoveArmed = !window.DFPlacementController.stockRemoveArmed;
    window.DFPlacementController.stockEraseArmed = false;
    window.DFPlacementController.stockPreset = !window.DFPlacementController.stockRemoveArmed;
    updateStockButtons();
    window.updateToolCursor();
    focusPage();
  });
  stockPalette.querySelector("[data-stock-accept]").addEventListener("click", async event => {
    event.stopPropagation();
    if (window.DFPlacementController.stockRepaintId != null) {
      // Repaint session: Accept is the one commit point (stageStockRepaintDrag only stages).
      await acceptStockRepaint();
      focusPage();
      return;
    }
    const id = window.DFPlacementController.stockPileId;
    closeStockMode();
    setActiveToolbar(null);
    if (id >= 0) openStockpilePanel(id);
    focusPage();
  });
  stockPalette.querySelector("[data-stock-cancel]").addEventListener("click", event => {
    event.stopPropagation();
    const id = window.DFPlacementController.stockRepaintId;
    disarmStockRepaint();
    // Cancel returns to where the session was armed from: the pile's detail panel.
    if (id != null && typeof openStockpilePanel === "function") openStockpilePanel(Number(id));
    focusPage();
  });
  stockPalette.querySelectorAll("[data-stock-repaint-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (window.DFPlacementController.stockRepaintId == null) return;
      const tool = button.dataset.stockRepaintTool;
      if (tool === "rect" || tool === "free") {
        window.setPaintModeOf("stockpile", tool);
        window.DFPlacementController.stockRepaintEraseArmed = false;
        window.DFPlacementController.stockRepaintRemoveArmed = false;
      } else if (tool === "erase") {
        window.DFPlacementController.stockRepaintEraseArmed = !window.DFPlacementController.stockRepaintEraseArmed;
        window.DFPlacementController.stockRepaintRemoveArmed = false;
      } else if (tool === "remove") {
        window.DFPlacementController.stockRepaintRemoveArmed = !window.DFPlacementController.stockRepaintRemoveArmed;
        window.DFPlacementController.stockRepaintEraseArmed = false;
      }
      setStockStatus("");
      updateStockButtons();
      window.updateToolCursor();
      focusPage();
    });
  });

  function unionBBox(a, b) {
    return { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
  }
  async function createStockpileDrag(x1, y1, x2, y2) {
    if (!window.DFPlacementController.stockPreset) return;
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    if (!a || !b) return;
    let rect = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
    if (window.paintModeOf("stockpile") === "free" && window.DFPlacementController.stockFreeBBox) {
      rect = unionBBox(rect, window.DFPlacementController.stockFreeBBox);
      window.DFPlacementController.stockFreeBBox = null;
    }
    await createStockpileWindowRect(rect.x1, rect.y1, rect.x2, rect.y2, a.w, a.h);
  }
  async function createStockpileWindowRect(px1, py1, px2, py2, frameW, frameH) {
    if (!window.DFPlacementController.stockPreset) return;
    const rect = { x1: px1, y1: py1, x2: px2, y2: py2 };
    const a = { w: frameW, h: frameH };
    const bbox = window.DFPlacementController.stockPileBBox ? unionBBox(window.DFPlacementController.stockPileBBox, rect) : rect;
    setStockStatus(window.DFPlacementController.stockPileId >= 0 ? "Extending stockpile..." : "Creating stockpile...");
    try {
      const url = window.DFPlacementController.stockPileId < 0
        ? `/stockpile?player=${encodeURIComponent(player)}&px=${bbox.x1}&py=${bbox.y1}` +
          `&px2=${bbox.x2}&py2=${bbox.y2}&w=${a.w}&h=${a.h}&preset=none`
        : `/stockpile-repaint?player=${encodeURIComponent(player)}&id=${window.DFPlacementController.stockPileId}` +
          `&px=${bbox.x1}&py=${bbox.y1}&px2=${bbox.x2}&py2=${bbox.y2}&w=${a.w}&h=${a.h}`;
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      const text = await r.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch (err) { DwfErr.report("stockpile.paint-response", err); }
      if (!r.ok) throw new Error(text.trim() || "stockpile request failed");
      if (Number(data.id) >= 0) window.DFPlacementController.stockPileId = Number(data.id);
      window.DFPlacementController.stockPileBBox = bbox;
      const w = bbox.x2 - bbox.x1 + 1, h = bbox.y2 - bbox.y1 + 1;
      setStockStatus(`Painted ${w}x${h}. Paint more, or click Accept to choose what it stores.`);
    } catch (err) {
      setStockStatus(String(err.message || err || "Stockpile failed").replace(/^stockpile failed:\s*/i, ""), true);
    }
  }
  async function stockEraseDrag(x1, y1, x2, y2) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    if (!a || !b) return;
    await stockEraseWindowRect(Math.min(a.x, b.x), Math.min(a.y, b.y),
      Math.max(a.x, b.x), Math.max(a.y, b.y), a.w, a.h);
  }
  async function stockEraseWindowRect(px1, py1, px2, py2, frameW, frameH) {
    const a = { w: frameW, h: frameH };
    const erase = { x1: px1, y1: py1, x2: px2, y2: py2 };
    try {
      const insp = await fetch(`/inspect?player=${encodeURIComponent(player)}&px=${erase.x1}&py=${erase.y1}&w=${a.w}&h=${a.h}`, { cache: "no-store" });
      const info = insp.ok ? await insp.json() : null;
      const id = info && String(info.kind || "").toLowerCase() === "stockpile" ? selectionBuildingId(info) : -1;
      if (!(id >= 0)) { setStockStatus("No stockpile under the erase area.", true); return; }
      const spr = await fetch(`/stockpile-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      const sp = spr.ok ? await spr.json() : null;
      const pos = sp?.pos, sz = sp?.size;
      if (!pos || !sz) { setStockStatus("Stockpile info unavailable.", true); return; }
      // NEVER derive the pile from pos+size alone (that is its BOUNDING BOX): an erase must ship the
      // exact extents to /stockpile-repaint mode=replace, or the legacy rect squares off a holed pile.
      const rendered = renderedImageRect();
      if (!rendered) { setStockStatus("The map view is not ready yet -- try that erase again.", true); return; }
      const w = Number(sz.w) || 0, h = Number(sz.h) || 0;
      const ext = (typeof sp?.extents === "string" && sp.extents.length === w * h) ? sp.extents : null;
      if (!ext) {
        setStockStatus("The host's game did not report this stockpile's exact shape, so it cannot be " +
          "erased safely. Nothing was changed.", true);
        return;
      }
      const draft = { zone: { id, x: Number(pos.x), y: Number(pos.y), z: Number(pos.z), w, h, extents: ext },
        changes: new Map() };
      const ox = Number(rendered.ox), oy = Number(rendered.oy);
      for (let wy = oy + erase.y1; wy <= oy + erase.y2; wy++)
        for (let wx = ox + erase.x1; wx <= ox + erase.x2; wx++)
          window.setZoneDraftTile(draft, wx, wy, false);
      if (!draft.changes.size) { setStockStatus("That area is not part of the stockpile -- nothing changed."); return; }
      const shape = window.zoneRepaintFinalShape(draft);
      if (!shape || shape.empty) {
        setStockStatus("That would erase the whole stockpile. Use Remove stockpile instead.", true);
        return;
      }
      const url = `/stockpile-repaint?player=${encodeURIComponent(player)}&id=${id}&mode=replace` +
        `&x1=${shape.x1}&y1=${shape.y1}&x2=${shape.x2}&y2=${shape.y2}&z=${shape.z}`;
      const r = await fetch(url, { method: "POST", cache: "no-store",
        headers: { "Content-Type": "text/plain; charset=utf-8" }, body: shape.extents });
      setStockStatus(r.ok ? "Stockpile trimmed." : "Erase failed.", !r.ok);
    } catch {
      setStockStatus("Erase failed.", true);
    }
  }
  // Remove-existing: a plain click deletes the pile at the clicked tile outright, no drag needed.
  async function stockRemoveClick(event) {
    const pixel = imagePixelFromEvent(event);
    if (!pixel) return;
    try {
      const insp = await fetch(`/inspect?player=${encodeURIComponent(player)}&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}`, { cache: "no-store" });
      const info = insp.ok ? await insp.json() : null;
      const id = info && String(info.kind || "").toLowerCase() === "stockpile" ? selectionBuildingId(info) : -1;
      if (!(id >= 0)) { setStockStatus("No stockpile there.", true); return; }
      const r = await fetch(`/stockpile-remove?id=${id}`, { method: "POST", cache: "no-store" });
      setStockStatus(r.ok ? "Stockpile removed." : "Remove failed.", !r.ok);
    } catch {
      setStockStatus("Remove failed.", true);
    }
  }

  // ---- zone placement: entry shows the type palette, picking a type arms paint ----------------
  if (typeof window !== "undefined") window.ZONE_TYPES = window.DwfControlShell.ZONE_TYPES;

  if (typeof window !== "undefined") Object.assign(window, {
    setStockStatus, closeStockMode, closeZoneMode, closeBurrowMode, setStockRepaint, stageStockRepaintDrag, stageStockRepaintWorld, disarmZoneRepaint, updateStockButtons, unionBBox, createStockpileDrag, createStockpileWindowRect, stockEraseDrag, stockEraseWindowRect, stockRemoveClick,
  });
