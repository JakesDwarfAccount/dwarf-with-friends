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

  const digSelect = document.getElementById("digSelect");
  let pdown = false;
  let downX = 0;
  let downY = 0;
  let dragAnchor = null; // image-pixel anchor of an in-progress placement drag
  let areaBuildAnchor = null; // first tile of click/click farm/construction placement
  let gatedBuildPreview = null;  // farm/road rect; drawn as FINE-only ghosts, never a wash
  let frameBuildPreview = null;  // construction rect; white frame + white size plaque
  function instantDrag() { return instantDesignate && !window.bipSelBuild(); }
  function areaBuildSelected() { return !!window.bipSelBuild()?.area; }

  const PLACEMENT_GHOST_ALPHA = 128 / 255;  // the baked surface alpha
  let placementCursorTile = null;
  // The extents are asymmetric for even dimensions.
  function placementFootprintOrigin(gx, gy, w, h) {
    const ww = Math.max(1, Number(w) || 1), hh = Math.max(1, Number(h) || 1);
    return { x: Number(gx) - Math.floor(ww / 2), y: Number(gy) - Math.floor(hh / 2), w: ww, h: hh };
  }
  function placementCursorKindFor(item) {
    if (!item) return "none";
    const type = Number(item.type);
    if (type === 34) return "frame";  // constructions
    if (type === 4 || type === 0x14 || type === 0x15) return "gated-ghost";  // farm plot, both roads
    return "ghost";  // everything else
  }
  function placementGhostSubject(item, origin) {
    return {
      type: buildingWireTypeFor(item),
      subtype: Number(item.subtype),
      dir: buildDirectionForPlacement(),
      x1: origin.x, y1: origin.y, x2: origin.x + origin.w - 1, y2: origin.y + origin.h - 1,
    };
  }
  // `buildDirection` is dwf-build-info-panels.js's, read through the same accessor idiom as
  // bipSelBuild(), because that module loads first in the product but need not exist in a fixture.
  function buildDirectionForPlacement() {
    try { return typeof buildDirection === "number" ? buildDirection : 0; } catch (_) { return 0; }
  }
  const PLACEMENT_WIRE_TYPE = {
    0: "Chair", 1: "Bed", 2: "Table", 3: "Coffin", 4: "FarmPlot", 5: "Furnace", 6: "TradeDepot",
    8: "Door", 9: "Floodgate", 10: "Box", 11: "Weaponrack", 12: "Armorstand", 13: "Workshop",
    14: "Cabinet", 15: "Statue", 16: "WindowGlass", 17: "WindowGem", 18: "Well", 19: "Bridge",
    20: "RoadDirt", 21: "RoadPaved", 22: "SiegeEngine", 23: "Trap", 24: "AnimalTrap",
    25: "Support", 26: "ArcheryTarget", 27: "Chain", 28: "Cage", 31: "Weapon", 33: "ScrewPump",
    34: "Construction", 35: "Hatch", 36: "GrateWall", 37: "GrateFloor", 38: "BarsVertical",
    39: "BarsFloor", 40: "GearAssembly", 41: "AxleHorizontal", 42: "AxleVertical",
    43: "WaterWheel", 44: "Windmill", 45: "TractionBench", 46: "Slab", 48: "NestBox",
    49: "Hive", 50: "Rollers", 51: "Instrument", 52: "Bookcase", 53: "DisplayFurniture",
    54: "OfferingPlace",
  };
  function buildingWireTypeFor(item) {
    return PLACEMENT_WIRE_TYPE[Number(item && item.type)] || "";
  }
  function placementLatestTile(gx, gy, latest) {
    const data = latest || null;
    if (!data || !Array.isArray(data.tiles) || !data.origin) return null;
    const x = Number(gx), y = Number(gy);
    if (!Number.isFinite(x) || !Number.isFinite(y) ||
        x < 0 || y < 0 || x >= Number(data.width) || y >= Number(data.height)) return null;
    return data.tiles[y * Number(data.width) + x] || null;
  }
  function placementOccupantAt(data, gx, gy) {
    if (!data || !data.origin) return false;
    const wx = Number(data.origin.x) + Number(gx);
    const wy = Number(data.origin.y) + Number(gy);
    const wz = Number(data.origin.z);
    const covers = value => value && Number(value.z ?? value.z1 ?? wz) === wz &&
      wx >= Number(value.x1 ?? value.x) && wx <= Number(value.x2 ?? value.x) &&
      wy >= Number(value.y1 ?? value.y) && wy <= Number(value.y2 ?? value.y);
    if (Array.isArray(data.buildings) && data.buildings.some(covers)) return true;
    if (Array.isArray(data.units) && data.units.some(covers)) return true;
    return false;
  }
  // Only farm plots and the two roads consult the verdict, and it gates VISIBILITY only: a tile the
  // client cannot positively confirm simply omits the ghost. There is no red/green verdict colour.
  function placementTileIsFineForGatedGhost(gx, gy, latest) {
    const data = latest || null;
    const tile = placementLatestTile(gx, gy, data);
    if (!tile || tile.hidden || String(tile.shape || "").toUpperCase() !== "FLOOR") return false;
    if ((Number(tile.flow) || 0) > 0 || tile.plant) return false;
    return !placementOccupantAt(data, gx, gy);
  }
  function placementLatest() {
    try {
      const tiles = typeof DwfTiles !== "undefined" ? DwfTiles : null;
      return tiles && typeof tiles.getLatest === "function" ? tiles.getLatest() : null;
    } catch (_) { return null; }
  }
  // DwfTiles' blitter is bound to the map canvas context, so use that as a scratch surface and copy
  // the sprite into #zoneOverlay: passing #zoneOverlay directly makes it paint a different canvas.
  const placementGhostCache = new Map();
  function paintGhostScratch(overlayCtx, bounds, cacheKey, draw) {
    let mapCtx = null;
    try { mapCtx = view && typeof view.getContext === "function" ? view.getContext("2d") : null; }
    catch (_) { mapCtx = null; }
    if (!mapCtx || !overlayCtx || !bounds || typeof draw !== "function") return 0;
    const cssRect = view.getBoundingClientRect();
    const scale = cssRect.width > 0 ? view.width / cssRect.width : 1;
    const sx = Math.max(0, Math.floor(Number(bounds.x) * scale));
    const sy = Math.max(0, Math.floor(Number(bounds.y) * scale));
    const ex = Math.min(view.width, Math.ceil((Number(bounds.x) + Number(bounds.w)) * scale));
    const ey = Math.min(view.height, Math.ceil((Number(bounds.y) + Number(bounds.h)) * scale));
    if (!(ex > sx && ey > sy)) return 0;
    const key = `${cacheKey}@${scale.toFixed(4)}:${ex - sx}x${ey - sy}`;
    const cached = placementGhostCache.get(key);
    if (cached) {
      overlayCtx.drawImage(cached.canvas, Number(bounds.x), Number(bounds.y),
        Number(bounds.w), Number(bounds.h));
      return cached.drawn;
    }
    let before = null;
    try { before = mapCtx.getImageData(sx, sy, ex - sx, ey - sy); } catch (_) { return 0; }
    let drawn = 0;
    let scratchSaved = false;
    try {
      mapCtx.save();
      scratchSaved = true;
      mapCtx.setTransform(1, 0, 0, 1, 0, 0);
      mapCtx.clearRect(sx, sy, ex - sx, ey - sy);
      // DwfTiles draws in its backing store's physical pixels while this painter receives screen-space
      // coordinates, so make CSS pixels the map context's coordinate system while the blitter stamps.
      mapCtx.setTransform(scale, 0, 0, scale, 0, 0);
      drawn = Number(draw(mapCtx)) || 0;
      mapCtx.restore();
      scratchSaved = false;
      if (drawn > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = ex - sx;
        canvas.height = ey - sy;
        const cacheCtx = canvas.getContext("2d");
        cacheCtx.imageSmoothingEnabled = false;
        cacheCtx.drawImage(view, sx, sy, ex - sx, ey - sy, 0, 0, canvas.width, canvas.height);
        placementGhostCache.set(key, { canvas, drawn });
        overlayCtx.drawImage(canvas, Number(bounds.x), Number(bounds.y),
          Number(bounds.w), Number(bounds.h));
      }
    } finally {
      if (scratchSaved) try { mapCtx.restore(); } catch (_) { /* scratch pixels are discarded after this frame */ }
      try { mapCtx.putImageData(before, sx, sy); } catch (_) { /* the retained source frame remains authoritative */ }
    }
    return drawn;
  }
  // THE PAINTER. Called by dwf-core.js's drawBuildPreview() with the live rendered-window geometry.
  function paintPlacementCursor(ctx, rendered) {
    const item = window.bipSelBuild();
    if (!item || !ctx || !rendered) return false;
    const cursor = placementCursorTile;
    if (!cursor) return false;
    const kind = placementCursorKindFor(item);
    if (kind === "none") return false;
    const cell = Number(rendered.cell) || 0;
    if (!(cell > 0)) return false;
    const size = item.size || {};
    const origin = placementFootprintOrigin(cursor.gx, cursor.gy,
      kind === "ghost" ? (size.w || 1) : 1, kind === "ghost" ? (size.h || 1) : 1);
    const sx = rendered.left + origin.x * cell;
    const sy = rendered.top + origin.y * cell;
    if (kind === "frame") {
      const rect = frameBuildPreview;
      if (!rect) return paintPlacementFrame(ctx, sx, sy, cell, origin);
      const x1 = Math.min(Number(rect.ax), Number(rect.bx));
      const y1 = Math.min(Number(rect.ay), Number(rect.by));
      const x2 = Math.max(Number(rect.ax), Number(rect.bx));
      const y2 = Math.max(Number(rect.ay), Number(rect.by));
      const framed = { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
      return paintPlacementFrame(ctx, rendered.left + x1 * cell, rendered.top + y1 * cell,
        cell, framed, rect, rendered);
    }
    // The extra art row sits ABOVE the footprint, so the stamp starts that many rows higher.
    const tiles = (typeof DwfTiles !== "undefined" && DwfTiles) ? DwfTiles : null;
    if (!tiles || typeof tiles.drawBuildingGhost !== "function")
      return paintPlacementFrame(ctx, sx, sy, cell, origin);
    if (kind === "gated-ghost") {
      const latest = placementLatest();
      const rect = gatedBuildPreview || {
        ax: cursor.gx, ay: cursor.gy, bx: cursor.gx, by: cursor.gy,
      };
      const x1 = Math.min(Number(rect.ax), Number(rect.bx));
      const y1 = Math.min(Number(rect.ay), Number(rect.by));
      const x2 = Math.max(Number(rect.ax), Number(rect.bx));
      const y2 = Math.max(Number(rect.ay), Number(rect.by));
      let drawnFine = 0;
      for (let gy = y1; gy <= y2; gy++) {
        for (let gx = x1; gx <= x2; gx++) {
          if (!placementTileIsFineForGatedGhost(gx, gy, latest)) continue;
          const tileOrigin = { x: gx, y: gy, w: 1, h: 1 };
          const subject = placementGhostSubject(item, tileOrigin);
          drawnFine += paintGhostScratch(ctx, {
            x: rendered.left + gx * cell,
            y: rendered.top + gy * cell,
            w: cell,
            h: cell,
          }, `gated:${subject.type}:${subject.subtype}:${subject.dir}:${cell}`, mapCtx =>
            tiles.drawBuildingGhost(mapCtx, subject, {
              px: rendered.left + gx * cell,
              py: rendered.top + gy * cell,
              cell,
              alpha: PLACEMENT_GHOST_ALPHA,
            }));
        }
      }
      return drawnFine > 0;
    }
    const extent = typeof tiles.buildingGhostExtent === "function"
      ? tiles.buildingGhostExtent(placementGhostSubject(item, origin)) : null;
    const lift = extent && extent.h > origin.h ? (extent.h - origin.h) : 0;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const subject = placementGhostSubject(item, origin);
    const ghostW = Math.max(origin.w, Number(extent && extent.w) || 0);
    const ghostH = Math.max(origin.h, Number(extent && extent.h) || 0);
    const drawn = paintGhostScratch(ctx,
      { x: sx, y: sy - lift * cell, w: ghostW * cell, h: ghostH * cell },
      `ghost:${subject.type}:${subject.subtype}:${subject.dir}:${origin.w}x${origin.h}:${cell}`,
      mapCtx => tiles.drawBuildingGhost(mapCtx, subject,
        { px: sx, py: sy - lift * cell, cell, alpha: PLACEMENT_GHOST_ALPHA }));
    ctx.restore();
    // A type with no authored art, or one buildingWireTypeFor() cannot name, draws zero cells --
    // the white footprint frame is the fallback.
    return drawn > 0 ? true : paintPlacementFrame(ctx, sx, sy, cell, origin);
  }
  function paintPlacementFrame(ctx, sx, sy, cell, origin, preview, rendered) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(sx) + 1, Math.round(sy) + 1,
      Math.max(1, Math.round(origin.w * cell) - 2), Math.max(1, Math.round(origin.h * cell) - 2));
    if (preview && rendered) {
      const model = window.DwfDragPreview;
      const size = model && model.dims(
        { x: Number(preview.ax), y: Number(preview.ay) },
        { x: Number(preview.bx), y: Number(preview.by) });
      const text = size && model.readout(size);
      if (text) {
        ctx.font = "600 12px ui-monospace, Consolas, monospace";
        const pad = 5;
        const boxW = Math.ceil(ctx.measureText(text).width) + pad * 2;
        const boxH = 20;
        const spot = model.labelPlacement({
          right: size.right, below: size.below,
          box: { left: sx, top: sy, right: sx + origin.w * cell,
            bottom: sy + origin.h * cell },
          size: { w: boxW, h: boxH }, pad: 6,
          clamp: { left: rendered.left, top: rendered.top,
            right: rendered.left + rendered.width, bottom: rendered.top + rendered.height },
        });
        if (spot) {
          ctx.fillStyle = "rgba(20, 20, 20, 0.9)";
          ctx.fillRect(spot.x, spot.y - boxH, boxW, boxH);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
          ctx.lineWidth = 1;
          ctx.strokeRect(spot.x + 0.5, spot.y - boxH + 0.5, boxW - 1, boxH - 1);
          ctx.fillStyle = "rgba(255, 255, 255, 1)";
          ctx.fillText(text, spot.x + pad, spot.y - 6);
        }
      }
    }
    ctx.restore();
    return true;
  }
  try {
    window.DFPlacementCursor = {
      paint: (ctx, rendered) => {
        try { return paintPlacementCursor(ctx, rendered); } catch (_) { return false; }
      },
      // Disarming drops the cursor. The build panel calls this from its two stand-down paths
      // (clearBuildPlacement, closeBuildUi) so a ghost cannot outlive the tool that armed it.
      clear: () => {
        if (!placementCursorTile && !gatedBuildPreview && !frameBuildPreview) return;
        placementCursorTile = null;
        gatedBuildPreview = null;
        frameBuildPreview = null;
        try { renderZoneOverlay(); } catch (_) { DwfErr.count("placement.zone-overlay-frame"); }
      },
      // Pure seams for the offline suite: the classification and the asymmetric extents.
      _kindFor: placementCursorKindFor,
      _originFor: placementFootprintOrigin,
      _wireTypeFor: buildingWireTypeFor,
      _fineFor: placementTileIsFineForGatedGhost,
      _modeFor: window.placementModeForActiveTool,
    };
  } catch (_) { /* non-browser context */ }
  function rectanglePaintSelected() {
    return window.paintModeOf(window.activePaintSubsystem()) === "rect" && !!(window.DFPlacementController.stockPreset || window.DFPlacementController.stockRepaintId || window.DFPlacementController.stockEraseArmed ||
      window.DFPlacementController.zonePreset || window.DFPlacementController.zoneRepaintId || window.DFPlacementController.zoneEraseArmed || window.DFPlacementController.burrowPaintId >= 0);
  }
  // Rectangle paint must not depend on the instantDesignate preference: rect-mode paint families and
  // area builds reach setDragPreview() without it.
  function localDragPreviewActive() {
    return areaBuildSelected() || rectanglePaintSelected() || instantDrag();
  }
  function setDragPreview(a, b) {
    const rect = window.designationDragRect(a, b);
    // Store the ANCHOR in ax/ay and the CURSOR in bx/by, not the normalised corners: the shared readout
    // needs the growth DIRECTION to place the numbers on the side away from the box.
    const preview = rect
      ? { ax: Number(a.x), ay: Number(a.y), bx: Number(b.x), by: Number(b.y) }
      : null;
    const item = window.bipSelBuild();
    const kind = placementCursorKindFor(item);
    if (kind === "gated-ghost") {
      gatedBuildPreview = preview;
      frameBuildPreview = null;
      dragPreview = null;
    } else if (kind === "frame") {
      gatedBuildPreview = null;
      frameBuildPreview = preview;
      dragPreview = null;
    } else if (item) {
      // dragPreview must stay null while a build item is selected: drawDragPreview() would paint the
      // green build wash under the ghost.
      gatedBuildPreview = null;
      frameBuildPreview = null;
      dragPreview = null;
    } else {
      gatedBuildPreview = null;
      frameBuildPreview = null;
      dragPreview = preview;
    }
    renderZoneOverlay();
  }
  // Remove and erase are tested BEFORE the repaint id: a repaint session can carry either flag, and
  // stageZoneRepaintDrag reads them itself.
  function currentDragIntent() {
    if (window.bipSelBuild()) return { family: "build", erasing: false, removing: false };
    if (window.DFPlacementController.zoneRemoveArmed) return { family: "zone", erasing: false, removing: true };
    if (window.DFPlacementController.zoneEraseArmed) return { family: "zone", erasing: true, removing: false };
    if (window.DFPlacementController.zoneRepaintId != null) return { family: "zone", erasing: false, removing: false };
    if (window.DFPlacementController.zonePreset) return { family: "zone", erasing: false, removing: false };
    if (window.DFPlacementController.burrowPaintId >= 0) return { family: "burrow", erasing: !!window.DFPlacementController.burrowEraseArmed, removing: false };
    if (window.DFPlacementController.stockRemoveArmed) return { family: "stockpile", erasing: false, removing: true };
    if (window.DFPlacementController.stockEraseArmed) return { family: "stockpile", erasing: true, removing: false };
    if (window.DFPlacementController.stockRepaintId != null)
      return { family: "stockpile", erasing: !!window.DFPlacementController.stockRepaintEraseArmed, removing: !!window.DFPlacementController.stockRepaintRemoveArmed };
    if (window.DFPlacementController.stockPreset) return { family: "stockpile", erasing: false, removing: false };
    if (window.DFPlacementController.currentTool)
      return { family: "designate", erasing: window.DFPlacementController.selectedDesignation === "erase", removing: false };
    return { family: "select", erasing: false, removing: false };
  }
  try { window.DFDragIntent = currentDragIntent; } catch (err) { DwfErr.report("placement.drag-intent-export", err); }
  function cancelAreaBuildAnchor() {
    if (!areaBuildAnchor) return false;
    areaBuildAnchor = null;
    dragPreview = null;
    gatedBuildPreview = null;
    frameBuildPreview = null;
    window.sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true);
    renderZoneOverlay();
    return true;
  }
  try { window.DFCancelBuildCornerAnchor = cancelAreaBuildAnchor; }
  catch (err) { DwfErr.report("placement.cancel-anchor-export", err); }
  // ONE armed-placement predicate for the two drag handlers below, exported so the touch layer can
  // pass armed-tool touches through to this designation path instead of panning the camera.
  function placementArmed() {
    return !!(window.DFPlacementController.currentTool || window.DFPlacementController.stockPreset || window.DFPlacementController.stockRepaintId || window.DFPlacementController.zoneRepaintId || window.DFPlacementController.stockEraseArmed ||
      window.DFPlacementController.stockRemoveArmed || window.bipSelBuild() || window.DFPlacementController.zonePreset || window.DFPlacementController.zoneEraseArmed || window.DFPlacementController.zoneRemoveArmed ||
      window.DFPlacementController.burrowPaintId >= 0 || window.DFPlacementController.squadMoveArmed >= 0 || window.DFPlacementController.squadKillArmed >= 0 || window.DFPlacementController.squadPatrolArmed >= 0 ||
      window.DFPlacementController.haulingStopArmedRoute >= 0 || window.DFPlacementController.haulingLinkArmed || window.DFPlacementController.leverLinkArmed);
  }
  try { window.DFPlacementArmed = placementArmed; } catch (err) { DwfErr.report("placement.armed-export", err); }

  // ---- ONE rectangle gesture, four families: press takes the anchor from the BUTTON-DOWN tile,
  // move rubber-bands with the button up, click 2 commits. The anchor is a WORLD tile. ----
  let gestureCursor = null;        // last hovered client point while an anchor is armed
  let gestureArmedBefore = false;  // was an anchor armed when THIS press landed?
  let gestureArmedThisPress = false;

  // Which family owns the pointer, or null. pointerGestureFamily() delegates straight to this, so
  // the family that arms an anchor is by construction the family that commits it.
  function paintGestureFamily() {
    if (window.bipSelBuild()) return null;                       // build placement owns its own anchor
    const rect = fam => (window.paintModeOf(fam) === "rect" ? fam : null);
    if (window.DFPlacementController.zoneRepaintId != null && !window.DFPlacementController.zoneRemoveArmed) return rect("zone");
    if (window.DFPlacementController.zoneEraseArmed) return rect("zone");
    if (window.DFPlacementController.zoneRemoveArmed) return null;                     // single click, not a rectangle
    if (window.DFPlacementController.zonePreset) return rect("zone");
    if (window.DFPlacementController.burrowPaintId >= 0) return rect("burrow");
    if (window.DFPlacementController.squadMoveArmed >= 0 || window.DFPlacementController.squadKillArmed >= 0 || window.DFPlacementController.squadPatrolArmed >= 0) return null;
    if (window.DFPlacementController.wsLinkArmed || window.DFPlacementController.leverLinkArmed || window.DFPlacementController.haulingStopArmedRoute >= 0 || window.DFPlacementController.haulingLinkArmed) return null;
    if (window.DFPlacementController.stockEraseArmed) return rect("stockpile");
    if (window.DFPlacementController.stockRemoveArmed) return null;                    // single click, not a rectangle
    if (window.DFPlacementController.stockPreset) return rect("stockpile");
    if (window.DFPlacementController.stockRepaintId != null && !window.DFPlacementController.stockRepaintRemoveArmed) return rect("stockpile");
    return null;
  }
  // The paint families first, then the designation tools -- same precedence as the dispatch chain.
  function pointerGestureFamily() {
    const paint = paintGestureFamily();
    if (paint) return paint;
    return window.twoClickEligible() ? "designation" : null;
  }
  function gestureAnchorArmed() {
    const family = pointerGestureFamily();
    return family ? window.gestureArmed(family) : null;
  }
  // One hovered tile as a world selection, through the shared spine.
  function gestureWorldPoint(clientX, clientY, family) {
    const cell = imagePixelClamped(clientX, clientY);
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!cell || !rendered || !window.DFPlacementController.GESTURE) return null;
    const sel = window.DFPlacementController.GESTURE.pointSelection(rendered, cell.x, cell.y, family);
    if (sel) { sel.w = cell.w; sel.h = cell.h; }
    return sel;
  }
  function paintGestureRubberBand(clientX, clientY) {
    const family = paintGestureFamily();
    const anchor = family && window.gestureArmed(family);
    if (!anchor) return false;
    const cur = imagePixelClamped(clientX, clientY);
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!cur || !rendered) return false;
    gestureCursor = { x: clientX, y: clientY };
    const ax = Number(anchor.x1) - Number(rendered.ox);
    const ay = Number(anchor.y1) - Number(rendered.oy);
    // The anchor MUST carry the window's tile dims: designationDragRect() reads w/h off its FIRST
    // argument and returns null unless all six numbers are finite, so a bare {x,y} anchor draws nothing.
    setDragPreview({ x: ax, y: ay, w: cur.w, h: cur.h }, cur);
    // Remote players watch the same box grow (the presence wire is window-grid, so the anchor
    // corner is clamped into the frame for THEM -- our own commit still uses the world anchor).
    window.sendPlacementUi(cur.x, cur.y, cur.w, cur.h, true,
      Math.max(0, Math.min(cur.w - 1, ax)), Math.max(0, Math.min(cur.h - 1, ay)));
    return true;
  }
  function refreshPendingGesture() {
    if (!gestureCursor) return false;
    if (window.twoClickArmed()) { window.updateTwoClickRubberBand(gestureCursor.x, gestureCursor.y); return true; }
    return paintGestureRubberBand(gestureCursor.x, gestureCursor.y);
  }
  // The pending volume's far z is the LIVE camera elevation, but only queueMove() re-derives it:
  // setZFromScrollbarEvent() and resetToHost() bypass it, so those leave the preview stale.
  try { window.DFGestureCameraMoved = () => {
    try { refreshPendingGesture(); } catch (_) { DwfErr.count("placement.gesture-refresh"); }
  }; }
  catch (err) { DwfErr.report("placement.gesture-export", err); }

  function dropPaintGestureAnchor() {
    const family = paintGestureFamily();
    if (!family || !window.gestureArmed(family)) return false;
    window.gestureClear(family);
    gestureCursor = null;
    dragPreview = null;
    window.sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true);
    renderZoneOverlay();
    return true;
  }

  // Commit: the anchor is dropped BEFORE the handler runs (the rule for every family) so
  // a server refusal can never strand a frozen box that only Escape clears.
  async function commitPointerGesture(family, clientX, clientY) {
    const anchor = window.gestureArmed(family);
    const cursor = gestureWorldPoint(clientX, clientY, family);
    const rect = (anchor && window.DFPlacementController.GESTURE) ? window.DFPlacementController.GESTURE.merge(anchor, cursor) : null;
    window.gestureClear(family);
    gestureCursor = null;
    if (family !== "designation") { dragPreview = null; renderZoneOverlay(); }
    if (!rect) return;
    if (family === "designation") await commitDesignationGesture(anchor, rect);
    else if (family === "zone") await commitZoneGesture(rect);
    else if (family === "burrow") await commitBurrowGesture(rect);
    else if (family === "stockpile") await commitStockpileGesture(rect);
  }
  async function commitDesignationGesture(anchor, rect) {
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    const pointZ = rendered ? Number(rendered.oz) : Number(anchor.z);
    // A stair designation is meaningless without a level span: a same-z second click keeps the
    // first footprint armed instead of committing a flat stairwell.
    if (window.DFPlacementController.selectedDesignation === "stairs" && Number(anchor.z) === pointZ) {
      window.gestureArm("designation", anchor);
      window.updateDesignationButtons();
      return;
    }
    rect.tool = anchor.tool || window.DFPlacementController.selectedDesignation;
    stairRangePreview = null;
    window.DFPlacementController.twoClickCursor = null;
    await window.submitDesignationRange(rect, pointZ);
    window.updateDesignationButtons();
  }
  async function commitZoneGesture(rect) {
    if (window.DFPlacementController.zoneRepaintId != null && !window.DFPlacementController.zoneRemoveArmed) {
      window.stageZoneRepaintWorld(rect.x1, rect.y1, rect.x2, rect.y2, Number(rect.z));
      return;
    }
    if (window.DFPlacementController.zoneEraseArmed) { await zoneEraseRect(rect); return; }
    if (window.DFPlacementController.zonePreset) { await zonePaintStroke(rect); }
  }
  async function commitBurrowGesture(rect) { await burrowPaintRectWorld(rect); }
  async function commitStockpileGesture(rect) {
    if (window.DFPlacementController.stockEraseArmed) { await stockEraseRect(rect); return; }
    if (window.DFPlacementController.stockPreset) { await createStockpileRect(rect); return; }
    if (window.DFPlacementController.stockRepaintId != null && !window.DFPlacementController.stockRepaintRemoveArmed) stageStockRepaintRect(rect);
  }

  // WORLD -> WINDOW for the routes still addressed in window pixels; GESTURE.toWindow clamps an
  // off-screen corner into the frame and reports it as `outside` for callers to warn on.
  function gestureWindowRect(rect) {
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!rendered || !window.DFPlacementController.GESTURE) return null;
    const win = window.DFPlacementController.GESTURE.toWindow(rect, rendered);
    if (!win) return null;
    win.cameraZ = Number(rendered.oz);
    win.offLevel = Number(rect.z) !== Number(rendered.oz);
    return win;
  }
  const CLIPPED_NOTE = "Part of that rectangle was off-screen and was trimmed to the view. " +
    "Pan so both corners are visible to paint the whole shape in one gesture.";

  // ---- burrows ------------------------------------------------------------------------------
  async function burrowPaintRectWorld(rect) {
    const win = gestureWindowRect(rect);
    if (!win) return;
    await window.burrowPaintRect(win.px1, win.py1, win.px2, win.py2, win.w, win.h);
    if (win.outside) window.setBurrowStatus(CLIPPED_NOTE, true);
    else if (win.offLevel) window.setBurrowStatus(
      "Painted on the level you are looking at. A burrow that spans levels needs one gesture per level.", true);
  }

  // ---- zones: the LIVE session -- the first committed stroke CREATES the zone and every later one
  // grows it, so multi-stroke zones union PER TILE instead of swallowing the corridor between. ----
  async function zonePaintStroke(rect) {
    if (!window.DFPlacementController.zonePreset) return;
    if (window.DFPlacementController.zoneLiveId != null) { await zoneStrokeOnto(Number(window.DFPlacementController.zoneLiveId), rect, "add"); return; }
    const win = gestureWindowRect(rect);
    if (!win) return;
    const kind = window.DFPlacementController.zonePreset;
    try {
      const url = `/zone?player=${encodeURIComponent(player)}&px=${win.px1}&py=${win.py1}` +
        `&px2=${win.px2}&py2=${win.py2}&w=${win.w}&h=${win.h}&zone=${encodeURIComponent(kind)}`;
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      const text = await r.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch (err) { DwfErr.report("placement.zone-response", err); }
      if (!r.ok) throw new Error(text.trim() || "zone failed");
      loadZones();
      const id = Number(data.id);
      if (Number.isInteger(id) && id >= 0) {
        window.DFPlacementController.zoneLiveId = id;
        // Native opens the new zone's panel and keeps painting. So do we: the session stays armed.
        if (typeof openZonePanel === "function") openZonePanel(id);
      }
      window.setZoneStatus(win.outside ? CLIPPED_NOTE : "Zone created. Keep painting to grow it.", win.outside);
      window.updateZoneButtons();
    } catch (err) {
      window.setZoneStatus(String(err.message || err || "Zone failed").replace(/^zone failed:\s*/i, ""), true);
    }
  }
  async function zoneStrokeOnto(id, rect, mode) {
    const win = gestureWindowRect(rect);
    if (!win || !(id >= 0)) return;
    const url = `/zone-repaint?player=${encodeURIComponent(player)}&id=${id}` +
      `&px=${win.px1}&py=${win.py1}&px2=${win.px2}&py2=${win.py2}` +
      `&w=${win.w}&h=${win.h}&mode=${mode === "erase" ? "erase" : "add"}`;
    const r = await window.postMaybePending(url);
    if (!r) {
      window.setZoneStatus(mode === "erase"
        ? "Zone erase-paint was refused, or the host's game is older than this client."
        : "Growing the zone was refused, or the host's game is older than this client.", true);
      return;
    }
    window.DFPlacementController.zoneRepaintDraft = null;
    loadZones();
    window.setZoneStatus(win.outside ? CLIPPED_NOTE
      : (mode === "erase" ? "Tiles erased." : "Tiles painted."), !!win.outside);
    window.updateZoneRepaintSummary();
    renderZoneOverlay();
  }
  async function zoneEraseRect(rect) {
    const sessionId = window.DFPlacementController.zoneRepaintId != null ? Number(window.DFPlacementController.zoneRepaintId)
      : (window.DFPlacementController.zoneLiveId != null ? Number(window.DFPlacementController.zoneLiveId) : null);
    if (sessionId != null) { await zoneStrokeOnto(sessionId, rect, "erase"); return; }
    const win = gestureWindowRect(rect);
    if (!win) return;
    const hits = window.zonesAtEventTile({ x: win.px1, y: win.py1, w: win.w, h: win.h });
    if (!hits.length) { window.setZoneStatus("No zone under the erase area.", true); return; }
    await zoneStrokeOnto(Number(hits[hits.length - 1].id), rect, "erase");
  }

  // ---- stockpiles ----------------------------------------------------------------------------
  // Never live-commit a stockpile stroke: the commit route deconstructs and recreates the pile,
  // cancelling its hauling jobs and un-assigning its stored items once per stroke.
  async function createStockpileRect(rect) {
    const win = gestureWindowRect(rect);
    if (!win) return;
    await window.createStockpileWindowRect(win.px1, win.py1, win.px2, win.py2, win.w, win.h);
    if (win.outside) window.setStockStatus(CLIPPED_NOTE, true);
  }
  function stageStockRepaintRect(rect) {
    window.stageStockRepaintWorld(rect.x1, rect.y1, rect.x2, rect.y2, Number(rect.z));
  }
  async function stockEraseRect(rect) {
    const win = gestureWindowRect(rect);
    if (!win) return;
    await window.stockEraseWindowRect(win.px1, win.py1, win.px2, win.py2, win.w, win.h);
  }

  view.addEventListener("pointerdown", event => {
    focusPage();
    if (event.button === 2 && cancelAreaBuildAnchor()) {
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    pdown = true;
    downX = event.clientX;
    downY = event.clientY;
    if (placementArmed()) {
      dragAnchor = imagePixelClamped(event.clientX, event.clientY);
      if (dragAnchor) {
        if (window.freePaintActive()) {
          window.DFPlacementController.freePaintCells = new Set();
          window.DFPlacementController.freePaintLastCell = null;
          window.freePaintTo(dragAnchor);
        }
        if (window.DFPlacementController.stockPreset && window.paintModeOf("stockpile") === "free") {
          window.DFPlacementController.stockFreeBBox = { x1: dragAnchor.x, y1: dragAnchor.y, x2: dragAnchor.x, y2: dragAnchor.y };
        }
        // New zones remain rectangle-backed. Existing-zone repaint has an exact per-cell stroke
        // buffer so free paint can preserve holes and disconnected shapes.
        if (window.DFPlacementController.zonePreset && !window.DFPlacementController.zoneRemoveArmed && window.paintModeOf("zone") === "free") {
          window.DFPlacementController.zoneFreeBBox = { x1: dragAnchor.x, y1: dragAnchor.y, x2: dragAnchor.x, y2: dragAnchor.y };
        }
        if (window.DFPlacementController.zoneRepaintId != null && !window.DFPlacementController.zoneRemoveArmed && window.paintModeOf("zone") === "free") {
          window.DFPlacementController.zoneRepaintFreeCells = new Set();
          window.DFPlacementController.zoneRepaintFreeLast = null;
          window.zoneRepaintFreePaintTo(dragAnchor);
        }
        if (window.DFPlacementController.stockRepaintId != null && !window.DFPlacementController.stockRepaintRemoveArmed && window.paintModeOf("stockpile") === "free") {
          window.DFPlacementController.stockRepaintFreeCells = new Set();
          window.DFPlacementController.stockRepaintFreeLast = null;
          window.stockRepaintFreePaintTo(dragAnchor);
        }
        // Burrow free-paint commits per-cell live, like the /designate free paint.
        if (window.DFPlacementController.burrowPaintId >= 0 && window.paintModeOf("burrow") === "free") {
          window.DFPlacementController.burrowFreeCells = new Set();
          window.DFPlacementController.burrowFreeLast = null;
          window.burrowFreePaintTo(dragAnchor);
        }
        if (window.DFPlacementController.zonePreset && !window.DFPlacementController.zoneEraseArmed && !window.DFPlacementController.zoneRemoveArmed && !paintGestureFamily()) {
          window.DFPlacementController.zonePaintPreview = { x1: dragAnchor.x, y1: dragAnchor.y, x2: dragAnchor.x, y2: dragAnchor.y };
          renderZoneOverlay();
        }
        const gestureFamily = pointerGestureFamily();
        gestureArmedBefore = !!(gestureFamily && window.gestureArmed(gestureFamily));
        gestureArmedThisPress = false;
        if (gestureFamily && !gestureArmedBefore) {
          const sel = gestureWorldPoint(event.clientX, event.clientY, gestureFamily);
          if (sel && window.gestureArm(gestureFamily, gestureFamily === "designation"
            ? { ...sel, tool: window.DFPlacementController.selectedDesignation } : sel)) {
            gestureArmedThisPress = true;
            gestureCursor = { x: event.clientX, y: event.clientY };
            // designationRangeWheel() rebuilds the range preview from twoClickCursor; without a seed
            // it falls back to the bare anchor until the first pointermove.
            if (gestureFamily === "designation") window.DFPlacementController.twoClickCursor = { x: event.clientX, y: event.clientY };
            if (gestureFamily === "designation") window.showDesignationRangePreview(sel, Number(sel.z));
            else paintGestureRubberBand(event.clientX, event.clientY);
          }
        }
        if (gestureFamily === "designation") {
          window.sendTwoClickPresence(dragAnchor);
        } else if (gestureFamily) {
          paintGestureRubberBand(event.clientX, event.clientY);
        } else if (localDragPreviewActive()) {
          const previewAnchor = areaBuildAnchor || dragAnchor;
          setDragPreview(previewAnchor, dragAnchor);
          window.sendPlacementUi(dragAnchor.x, dragAnchor.y, dragAnchor.w, dragAnchor.h,
            true, previewAnchor.x, previewAnchor.y);
        } else {
          window.sendPlacementUi(dragAnchor.x, dragAnchor.y, dragAnchor.w, dragAnchor.h,
                          true, dragAnchor.x, dragAnchor.y, true);
        }
      }
    }
    // A synthetic tap from the touch layer carries a pointerId that is no longer active, which makes
    // setPointerCapture throw. Harmless to skip: capture only matters for real drags.
    try { view.setPointerCapture(event.pointerId); } catch (_) { /* capture is optional for non-drag clicks */ }
  });
  view.addEventListener("pointermove", event => {
    if (window.twoClickArmed()) window.updateTwoClickRubberBand(event.clientX, event.clientY);
    // The paint families rubber-band with the button UP too: their anchor is a real armed corner.
    else if (paintGestureRubberBand(event.clientX, event.clientY)) { /* preview owned above */ }
    if (areaBuildAnchor && areaBuildSelected()) {
      const cur = imagePixelClamped(event.clientX, event.clientY);
      if (cur) {
        setDragPreview(areaBuildAnchor, cur);
        window.sendPlacementUi(cur.x, cur.y, cur.w, cur.h, true, areaBuildAnchor.x, areaBuildAnchor.y);
      }
    }
    if (!pdown || !placementArmed()) return;
    if (dragAnchor) {
      const cur = imagePixelClamped(event.clientX, event.clientY);
      if (!cur) return;
      if (window.DFPlacementController.freePaintCells) window.freePaintTo(cur);
      if (window.DFPlacementController.burrowFreeCells) window.burrowFreePaintTo(cur);
      if (window.DFPlacementController.zoneRepaintFreeCells) window.zoneRepaintFreePaintTo(cur);
      if (window.DFPlacementController.stockRepaintFreeCells) window.stockRepaintFreePaintTo(cur);
      if (window.DFPlacementController.stockFreeBBox) {
        window.DFPlacementController.stockFreeBBox.x1 = Math.min(window.DFPlacementController.stockFreeBBox.x1, cur.x);
        window.DFPlacementController.stockFreeBBox.y1 = Math.min(window.DFPlacementController.stockFreeBBox.y1, cur.y);
        window.DFPlacementController.stockFreeBBox.x2 = Math.max(window.DFPlacementController.stockFreeBBox.x2, cur.x);
        window.DFPlacementController.stockFreeBBox.y2 = Math.max(window.DFPlacementController.stockFreeBBox.y2, cur.y);
      }
      if (window.DFPlacementController.zoneFreeBBox) {
        window.DFPlacementController.zoneFreeBBox.x1 = Math.min(window.DFPlacementController.zoneFreeBBox.x1, cur.x);
        window.DFPlacementController.zoneFreeBBox.y1 = Math.min(window.DFPlacementController.zoneFreeBBox.y1, cur.y);
        window.DFPlacementController.zoneFreeBBox.x2 = Math.max(window.DFPlacementController.zoneFreeBBox.x2, cur.x);
        window.DFPlacementController.zoneFreeBBox.y2 = Math.max(window.DFPlacementController.zoneFreeBBox.y2, cur.y);
      }
      if (window.DFPlacementController.zonePreset && !window.DFPlacementController.zoneEraseArmed && !window.DFPlacementController.zoneRemoveArmed && !paintGestureFamily()) {
        window.DFPlacementController.zonePaintPreview = { x1: dragAnchor.x, y1: dragAnchor.y, x2: cur.x, y2: cur.y };
        renderZoneOverlay();
      }
      // A press-drag while a paint anchor is armed is still ONE gesture, anchored on the armed
      // world tile -- the held-drag preview below must not re-anchor it on the press point.
      if (paintGestureFamily() && gestureAnchorArmed()) {
        paintGestureRubberBand(event.clientX, event.clientY);
      } else if (window.twoClickEligible()) {
        window.sendTwoClickPresence(cur);
      } else if (localDragPreviewActive()) {
        const previewAnchor = areaBuildAnchor || dragAnchor;
        setDragPreview(previewAnchor, cur);
        // PRESENCE: broadcast the live drag rect to other players (self-preview is browser-side).
        window.sendPlacementUi(cur.x, cur.y, cur.w, cur.h, true, previewAnchor.x, previewAnchor.y);
      } else {
        window.sendPlacementUi(cur.x, cur.y, cur.w, cur.h, true, dragAnchor.x, dragAnchor.y);
      }
    }
  });
  view.addEventListener("pointerup", event => {
    if (!pdown) return;
    pdown = false;
      digSelect.hidden = true;
    let releasedDragAnchor = null;
    if (dragAnchor) {
      releasedDragAnchor = dragAnchor;
      const cur = imagePixelClamped(event.clientX, event.clientY);
      // Clear our broadcast drag rect (drag=0) in BOTH modes so other players stop seeing it.
      if (cur) window.sendPlacementUi(cur.x, cur.y, cur.w, cur.h, false, 0, 0, true);
      dragAnchor = null;
    }
    try { view.releasePointerCapture(event.pointerId); } catch (_) { /* release is harmless after lost capture */ }
    const clickDistance = Math.hypot(event.clientX - downX, event.clientY - downY);
    // ONE release leg for all four rectangle families: the spine decides, the per-family handler
    // commits. "hold" is click 1 -- the anchor stays armed with the button up.
    const gestureFamily = pointerGestureFamily();
    if (gestureFamily && window.gestureArmed(gestureFamily)) {
      const decision = window.DFPlacementController.GESTURE.step({
        armedBefore: gestureArmedBefore,
        armedThisPress: gestureArmedThisPress,
        movedPx: clickDistance,
      });
      gestureArmedBefore = false;
      gestureArmedThisPress = false;
      if (decision === "commit") commitPointerGesture(gestureFamily, event.clientX, event.clientY);
      else gestureCursor = { x: event.clientX, y: event.clientY };
      return;
    }
    gestureArmedBefore = false;
    gestureArmedThisPress = false;
    if (window.bipSelBuild()) {
      const cur = imagePixelClamped(event.clientX, event.clientY);
      if (areaBuildSelected() && cur && releasedDragAnchor) {
        if (areaBuildAnchor) {
          // Click 2 and held-drag both use placeBuildCells; only their source of corner 1 differs.
          const anchor = areaBuildAnchor;
          areaBuildAnchor = null;
          placeBuildCells(anchor, cur);
        } else if (clickDistance < 8) {
          areaBuildAnchor = releasedDragAnchor;
          setDragPreview(areaBuildAnchor, cur);
        } else {
          placeBuildCells(releasedDragAnchor, cur);
        }
      } else {
        placeBuildDrag(downX, downY, event.clientX, event.clientY);
      }
    } else if (window.DFPlacementController.zoneRepaintId != null && !window.DFPlacementController.zoneRemoveArmed) {
      window.stageZoneRepaintDrag(downX, downY, event.clientX, event.clientY);
    } else if (window.DFPlacementController.zoneEraseArmed) {
      window.zoneEraseDrag(downX, downY, event.clientX, event.clientY);
    } else if (window.DFPlacementController.zoneRemoveArmed && window.DFPlacementController.zoneRepaintId == null) {
      // Inside a repaint session the plaque reads "Accept to remove this zone", and Accept is the
      // only commit: a map click there must not delete whichever zone happens to be under it.
      window.zoneRemoveClick(event);
    } else if (window.DFPlacementController.zonePreset) {
      window.zonePaintDrag(downX, downY, event.clientX, event.clientY);
    } else if (window.DFPlacementController.burrowPaintId >= 0) {
      if (window.DFPlacementController.burrowFreeCells) { window.DFPlacementController.burrowFreeCells = null; window.DFPlacementController.burrowFreeLast = null; }
      else window.burrowPaintDrag(downX, downY, event.clientX, event.clientY);
    } else if (window.DFPlacementController.squadMoveArmed >= 0) {
      window.squadMoveClick(event);
    } else if (window.DFPlacementController.squadKillArmed >= 0) {
      window.squadKillClick(event);
    } else if (window.DFPlacementController.squadPatrolArmed >= 0) {
      window.squadPatrolClick(event);
    } else if (window.DFPlacementController.wsLinkArmed) {
      window.wsLinkClick(event);
    } else if (window.DFPlacementController.leverLinkArmed) {
      window.leverLinkClick(event);
    } else if (window.DFPlacementController.haulingLinkArmed) {
      window.haulingLinkClick(event);
    } else if (window.DFPlacementController.haulingStopArmedRoute >= 0) {
      window.haulingStopClick(event);
    } else if (window.DFPlacementController.stockEraseArmed) {
      window.stockEraseDrag(downX, downY, event.clientX, event.clientY);
    } else if (window.DFPlacementController.stockRemoveArmed) {
      window.stockRemoveClick(event);
    } else if (window.DFPlacementController.stockPreset) {
      window.createStockpileDrag(downX, downY, event.clientX, event.clientY);
    } else if (window.DFPlacementController.stockRepaintId != null && !window.DFPlacementController.stockRepaintRemoveArmed) {
      // Repaint session: strokes are STAGED (exact world tiles); Accept owns the commit.
      window.stageStockRepaintDrag(downX, downY, event.clientX, event.clientY);
    } else if (window.DFPlacementController.stockRepaintId != null) {
      // Remove is selected from the repaint session and committed by Accept; a map click
      // while it is armed changes no fortress state.
    } else if (window.DFPlacementController.zoneRepaintId != null) {
      // Deliberately empty: remove is armed from the repaint session and committed by Accept.
    } else if (window.DFPlacementController.currentTool) {
      if (window.DFPlacementController.freePaintCells) { window.DFPlacementController.freePaintCells = null; window.DFPlacementController.freePaintLastCell = null; }
      else window.designateDrag(downX, downY, event.clientX, event.clientY);
    } else if (window.DFPlacementController.chatPingArmed) {
      window.chatPingClick(event);
    } else if (clickDistance < 8) {
      if (window.DFPlacementController.zoneMode === "menu") window.zoneSelectClick(event);
      else window.inspectClick(event);
    }
    // Hold the local drag preview briefly so it does not flash out before the server frame carrying
    // the committed placement streams back.
    if (dragPreview && !areaBuildAnchor) {
      const held = dragPreview;
      setTimeout(() => { if (dragPreview === held) { dragPreview = null; renderZoneOverlay(); } }, 380);
    }
    if (gatedBuildPreview && !areaBuildAnchor) {
      const held = gatedBuildPreview;
      setTimeout(() => {
        if (gatedBuildPreview === held) { gatedBuildPreview = null; renderZoneOverlay(); }
      }, 380);
    }
    if (frameBuildPreview && !areaBuildAnchor) {
      const held = frameBuildPreview;
      setTimeout(() => {
        if (frameBuildPreview === held) { frameBuildPreview = null; renderZoneOverlay(); }
      }, 380);
    }
  });
  view.addEventListener("pointercancel", () => {
    pdown = false;
        digSelect.hidden = true;
    if (dragAnchor) {
      window.sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true); // clear presence drag in both modes
      dragAnchor = null;
    }
    stairRangePreview = window.desigAnchor() ? { ...window.desigAnchor() } : null;
    areaBuildAnchor = null;
    gatedBuildPreview = null;
    frameBuildPreview = null;
    if (dragPreview) { dragPreview = null; renderZoneOverlay(); }
    window.DFPlacementController.freePaintCells = null;
    window.DFPlacementController.freePaintLastCell = null;
    window.DFPlacementController.stockFreeBBox = null;
    // Strokes commit as they land, so a cancelled pointer leaves nothing pending to keep.
    window.DFPlacementController.zonePaintPreview = null;
    renderZoneOverlay();
  });

  // ---- hover tooltip: the cache is keyed by WORLD tile so it stays correct across pans, and only
  // ONE /hover fetch is ever in flight -- the latest wanted tile is fetched the moment it resolves. ----

  if (typeof window !== "undefined") Object.assign(window, {
    placementLatest, cancelAreaBuildAnchor, paintGestureFamily, dropPaintGestureAnchor, zonePaintStroke, zoneEraseRect,
  });

  if (typeof window !== "undefined" && window.DFPlacementController) {
    Object.defineProperties(window.DFPlacementController, {
      pdown: { get: () => pdown, set: value => { pdown = value; }, configurable: true },
      areaBuildAnchor: { get: () => areaBuildAnchor, set: value => { areaBuildAnchor = value; }, configurable: true },
      placementCursorTile: { get: () => placementCursorTile, set: value => { placementCursorTile = value; }, configurable: true }
    });
  }
