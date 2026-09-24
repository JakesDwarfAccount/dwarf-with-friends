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

  function zoneRepaintFinalShape(draft) {
    if (!draft || !draft.zone || !draft.changes) return null;
    const zone = draft.zone;
    const cells = new Set();
    for (let ly = 0; ly < Number(zone.h); ly++)
      for (let lx = 0; lx < Number(zone.w); lx++)
        if (zoneExtentAt(zone, lx, ly)) cells.add(`${Number(zone.x) + lx},${Number(zone.y) + ly}`);
    draft.changes.forEach((present, key) => { if (present) cells.add(key); else cells.delete(key); });
    if (!cells.size) return { empty: true };
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    cells.forEach(key => {
      const [x, y] = key.split(",").map(Number);
      x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
    });
    let extents = "";
    for (let y = y1; y <= y2; y++)
      for (let x = x1; x <= x2; x++) extents += cells.has(`${x},${y}`) ? "1" : "0";
    return { x1, y1, x2, y2, z: Number(zone.z), extents };
  }

  // Nothing is sent until Accept, so a camera pan between painting and Accept cannot move the edit.
  // A refusal must reopen the panel carrying the server's own reason.
  async function commitZoneRepaintDraft(id, draft) {
    if (!draft) return;
    const reopen = (zoneId, status) => {
      if (typeof openZonePanel === "function") openZonePanel(zoneId, status ? { status } : undefined);
    };
    const shape = zoneRepaintFinalShape(draft);
    if (!shape || shape.empty) {
      window.setZoneStatus("A zone cannot be repainted to zero tiles. Use Remove Zone instead.", true);
      return;
    }
    const url = `/zone-repaint?player=${encodeURIComponent(player)}&id=${id}&mode=replace` +
      `&x1=${shape.x1}&y1=${shape.y1}&x2=${shape.x2}&y2=${shape.y2}&z=${shape.z}`;
    window.disarmZoneRepaint();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(url, { method: "POST", cache: "no-store", signal: ctl.signal,
        headers: { "Content-Type": "text/plain; charset=utf-8" }, body: shape.extents });
      const text = (await r.text()) || "";
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch (err) { DwfErr.report("tool-mode.zone-response", err); }
      loadZones();
      if (!r.ok) {
        // Show the server's reason, stripped of its wire prefix and trailing newline, on the reopened panel.
        const reason = String(data.error || text || "").replace(/\s+$/, "")
          .replace(/^zone-repaint (?:failed|refused):\s*/i, "");
        reopen(id, { text: reason || "Zone repaint was refused.", isError: true });
        return;
      }
      const finalId = Number(data.id);
      reopen(Number.isInteger(finalId) && finalId >= 0 ? finalId : id);
    } catch {
      loadZones();
      reopen(id, { text: "The zone-repaint route did not respond -- the host's game may be older than this client.", isError: true });
    } finally {
      clearTimeout(timer);
    }
  }

  function armDesignation(menu, tool) {
    window.DFPlacementController.digMenuOpen = menu === "dig";
    window.DFPlacementController.plantMenuOpen = menu === "plant";
    window.DFPlacementController.smoothMenuOpen = menu === "smooth";
    window.DFPlacementController.itemDesigMenuOpen = menu === "itemdesig";
    window.selectDesignation(tool);
  }

  // Keyboard equivalent of clicking a bottom-center mode tool button: arm it, or disarm it if it is
  // already the active tool. Mirrors only the [data-mode-tool] handler's plain-designation branch.
  function armModeTool(tool) {
    if (window.DFPlacementController.selectedDesignation === tool) {
      window.DFPlacementController.selectedDesignation = null;
      window.DFPlacementController.currentTool = null;
      window.updateDesignationButtons();
    } else {
      window.DFPlacementController.digMenuOpen = false;
      window.DFPlacementController.plantMenuOpen = false;
      window.DFPlacementController.smoothMenuOpen = false;
      window.DFPlacementController.itemDesigMenuOpen = false;
      window.selectDesignation(tool);
    }
  }

  // ---- the close law's ladder: one rung per "how deep am I", each with a DEPTH on one shared scale
  // so a pending anchor outranks the panel it started from. The law lives in dwf-mode-stack.js. ----
  if (typeof window !== "undefined") window.MODE_STACK = window.DwfModeStack || null;
  function registerBackOutLevel(level) {
    try { if (window.MODE_STACK) window.MODE_STACK.register(level); } catch (err) { DwfErr.report("mode-stack.register", err); }
  }
  // Escape must never leave a map targeting mode armed with the squads sidebar closed: the next map
  // click would issue a station order with no squads UI on screen.
  function squadOrderModeArmed() {
    return window.DFPlacementController.squadMoveArmed >= 0 || window.DFPlacementController.squadKillArmed >= 0 || window.DFPlacementController.squadPatrolArmed >= 0;
  }
  function disarmSquadOrderModes() {
    if (!squadOrderModeArmed()) return false;
    try { if (window.DFSquadMove && window.DFPlacementController.squadMoveArmed >= 0) window.DFSquadMove.disarm(); }
    catch (err) { DwfErr.report("tool-mode.squad-move-disarm", err); }
    try { if (window.DFSquadKill && window.DFPlacementController.squadKillArmed >= 0) window.DFSquadKill.disarm(); }
    catch (err) { DwfErr.report("tool-mode.squad-kill-disarm", err); }
    try { if (window.DFSquadPatrol && window.DFPlacementController.squadPatrolArmed >= 0) window.DFSquadPatrol.disarm(); }
    catch (err) { DwfErr.report("tool-mode.squad-patrol-disarm", err); }
    window.DFPlacementController.squadMoveArmed = -1;
    window.DFPlacementController.squadKillArmed = -1;
    window.DFPlacementController.squadPatrolArmed = -1;
    window.updateToolCursor();
    return true;
  }
  function dropDesignationAnchor() {
    if (!window.twoClickArmed()) return false;
    window.gestureClear("designation");
    stairRangePreview = null;
    window.DFPlacementController.twoClickCursor = null;
    window.sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true);
    renderZoneOverlay();
    window.updateDesignationButtons();
    window.updateToolModeLabel();
    return true;
  }
  function dropDesignationTool() {
    if (!(window.DFPlacementController.digMenuOpen || window.DFPlacementController.plantMenuOpen || window.DFPlacementController.smoothMenuOpen || window.DFPlacementController.itemDesigMenuOpen ||
          window.DFPlacementController.selectedDesignation || window.DFPlacementController.currentTool)) return false;
    window.DFPlacementController.digMenuOpen = false;
    window.DFPlacementController.plantMenuOpen = false;
    window.DFPlacementController.smoothMenuOpen = false;
    window.DFPlacementController.itemDesigMenuOpen = false;
    window.DFPlacementController.selectedDesignation = null;
    window.DFPlacementController.currentTool = null;
    window.gestureClear("designation");
    stairRangePreview = null;
    window.DFPlacementController.twoClickCursor = null;
    renderZoneOverlay();
    window.updateDesignationButtons();
    return true;
  }
  const buildMenuOpen = () => clientPanel.classList.contains("visible") &&
    clientPanel.classList.contains("build-panel");
  [
    { id: "chat-ping", flow: "camera-selection", depth: 40,
      active: () => !!window.DFPlacementController.chatPingArmed,
      pop: () => { try { window.DFChatPing.disarm(); }
        catch (err) { DwfErr.report("tool-mode.chat-ping-disarm", err); } return true; } },
    { id: "world-screen", flow: "screen-stack", depth: 38,
      active: () => typeof worldScreenOpen === "function" && worldScreenOpen(),
      pop: () => { closeWorldScreen(); return true; } },
    { id: "esc-menu", flow: "screen-stack", depth: 36,
      active: () => typeof escMenuOpen === "function" && escMenuOpen(),
      pop: () => { closeEscMenu(); return true; } },
    // A pending paint corner is a level of its own, ABOVE the session it was started from: one press
    // drops the corner and leaves the tool armed and the session live; the next one leaves the session.
    { id: "paint-anchor", flow: "paint-gesture", depth: 32,
      active: () => { const f = window.paintGestureFamily(); return !!(f && window.gestureArmed(f)); },
      pop: window.dropPaintGestureAnchor },
    { id: "stock-repaint", flow: "stockpile-paint", depth: 30,
      active: () => window.DFPlacementController.stockRepaintId != null,
      pop: () => { window.setStockRepaint(null); return true; } },
    { id: "zone-repaint", flow: "zones", depth: 30,
      active: () => window.DFPlacementController.zoneRepaintId != null,
      pop: () => { window.disarmZoneRepaint(); return true; } },
    // This array is the only order there is: build-anchor is checked before lever-link on a tie.
    { id: "build-anchor", flow: "building-placement", depth: 30,
      active: () => !!window.DFPlacementController.areaBuildAnchor,
      pop: () => window.cancelAreaBuildAnchor() },
    { id: "lever-link-target", flow: "building-interact", depth: 30,
      active: () => !!window.DFPlacementController.leverLinkArmed,
      pop: () => window.DFLeverLink.disarm() },
    { id: "squad-order-mode", flow: "squads-orders", depth: 30,
      active: squadOrderModeArmed,
      pop: disarmSquadOrderModes },
    { id: "designation-anchor", flow: "designations", depth: 30,
      active: () => window.twoClickArmed(),
      pop: dropDesignationAnchor },
    // A pending build corner is the one licensed divergence (UI-DIV-009): build-anchor sits at
    // depth 30, so it pops on its own press before this rung closes the whole build UI.
    { id: "build-menu", flow: "building-placement", depth: 20,
      active: buildMenuOpen,
      pop: () => {
        if (typeof closeBuildUi === "function") closeBuildUi();
        else { closeClientPanel(); setActiveToolbar(null); }
        return true;
      } },
    { id: "build-armed", flow: "building-placement", depth: 20,
      active: () => !buildMenuOpen() && !!window.bipSelBuild(),
      pop: () => { clearBuildPlacement(true); return true; } },
    { id: "zone-paint", flow: "zones", depth: 20,
      active: () => window.DFPlacementController.zoneMode === "paint",
      pop: () => { window.setZonePreset(null); return true; } },
    { id: "designation-tool", flow: "designations", depth: 20,
      active: () => !!(window.DFPlacementController.digMenuOpen || window.DFPlacementController.plantMenuOpen || window.DFPlacementController.smoothMenuOpen || window.DFPlacementController.itemDesigMenuOpen ||
                       window.DFPlacementController.selectedDesignation || window.DFPlacementController.currentTool),
      pop: dropDesignationTool },
    { id: "selection-sheet", flow: "camera-selection", depth: 10,
      active: () => selection.classList.contains("visible"),
      pop: () => {
        closeSelection();
        return true;
      } },
    { id: "zone-mode", flow: "zones", depth: 10,
      active: () => !!window.DFPlacementController.zoneMode ||
      (typeof window.DFPlacementController.zonePalette !== "undefined" && !window.DFPlacementController.zonePalette.hidden),
      pop: () => { window.closeZoneMode(); setActiveToolbar(null); return true; } },
    { id: "burrow-mode", flow: "burrows-alerts", depth: 10,
      active: () => !!window.DFPlacementController.burrowMode,
      pop: () => { window.closeBurrowMode(); return true; } },
    { id: "hauling-mode", flow: "hauling", depth: 10,
      active: () => !!window.DFPlacementController.haulingMode,
      pop: () => { window.closeHaulingMode(); return true; } },
    { id: "stock-mode", flow: "stockpile-paint", depth: 10,
      active: () => !!window.DFPlacementController.stockMode,
      pop: () => { window.closeStockMode(); setActiveToolbar(null); return true; } },
    { id: "client-panel", flow: "camera-selection", depth: 5,
      active: () => clientPanel.classList.contains("visible"),
      pop: () => { closeClientPanel(); return true; } },
  ].forEach(registerBackOutLevel);

  // THE ONE DOOR to the close law: every back-out verb lands here. Returns true when the press was
  // consumed (a rung popped or a confirm disarmed), the caller's cue to swallow the whole event.
  function backOutOneLevel(reason, flow) {
    // Backing out must disarm a pending destructive confirm -- and defusing one IS the level this
    // press backs out of, so a press that disarms consumes itself and does NOT also pop a rung.
    let disarmed = false;
    try { if (window.DwfConfirmGate) disarmed = !!window.DwfConfirmGate.disarm(); }
    catch (err) { DwfErr.report("tool-mode.confirm-gate-disarm", err); }
    if (disarmed) { window.confirmGateRerender(); return true; }
    try {
      if (!window.MODE_STACK) return false;
      const why = reason || "rightclick";
      if (flow && window.MODE_STACK.popOne(why, flow)) return true;
      return !!window.MODE_STACK.popOne(why);
    } catch { return false; }
  }
  try { window.DFBackOut = backOutOneLevel; } catch (err) { DwfErr.report("tool-mode.back-out-export", err); }

  // dwf-core.js owns right-click over the MAP: the right button is also grab-pan there, so only a
  // non-moving press counts. Over a panel a plain contextmenu is the click; text inputs keep theirs.
  addEventListener("contextmenu", event => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    if (target.closest("input, textarea, [contenteditable='true']")) return;
    if (!target.closest("#clientPanel, #selection")) return;
    event.preventDefault();
    // With the squads sidebar up we KNOW the player means a squads rung, so pass the flow:
    // popOne(flow) then pops the deepest squads-orders level, ignoring every other flow's depth.
    let flow = null;
    try { if (activeInfoPanel === "squads" && target.closest("#clientPanel")) flow = "squads-orders"; }
    catch (err) { DwfErr.report("tool-mode.right-click-flow", err); }
    backOutOneLevel("rightclick", flow);
  });

  addEventListener("keydown", event => {
    // Let text inputs (stockpile rename, search) receive keys without panning the map.
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (event.key !== "Escape") return;
      const editorOwnsEscape = !!event.target.closest?.("#spEditorPanel");
      const overlayOwnsEscape = !!window.MODE_STACK?.top("global-overlays");
      event.target.blur();
      // The stockpile settings search is an editor control, not a close rung of its own.
      if (!editorOwnsEscape && !overlayOwnsEscape) return;
    }
    // Semantic controls own their native activation keys. In particular, the help popup's shared
    // DWFUI check is a button; stealing Space here both paused the fort and prevented its click.
    if ((event.key === " " || event.key === "Enter") &&
        event.target?.closest?.("button, select, a[href], [role='button'], [role='checkbox'], [role='tab']"))
      return;
    // A modal help story owns the whole keyboard, not just the focused control's activation keys.
    // Escape still reaches the shared overlay stack so the usual back-out law can close it.
    if (event.key !== "Escape" && document.getElementById("helpPopup")?.classList.contains("open"))
      return;
    // While the 3D viewer owns the screen it owns the keyboard too: keys it does not itself handle
    // would otherwise fire an invisible fort tool from this cascade, so yield on DFWorld3D.isOpen().
    try { if (window.DFWorld3D && window.DFWorld3D.isOpen()) return; }
    catch (err) { DwfErr.report("tool-mode.world3d-state", err); }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    // This listener is on `window`, which the bubble phase reaches LAST, so an earlier document-level
    // Escape handler has already run: bail on a defaultPrevented Escape or the fallback double-fires.
    if (event.key === "Escape" && event.defaultPrevented) return;
    focusPage();
    if (event.key === "Escape") {
      // Escape and right-click are ONE code path: this branch calls the SAME backOutOneLevel() the
      // right-click handlers call. Never re-state the ladder's order here.
      let handledEscape = backOutOneLevel("escape");
      if (!handledEscape && window.DFPanelFrame && window.DFPanelFrame.escCloseTopmost())
        handledEscape = true;
      if (!handledEscape && typeof openEscMenu === "function") {
        openEscMenu();
        handledEscape = true;
      }
      if (handledEscape) {
        // A handled close swallows the entire event: the hotkey switch below never sees it.
        event.preventDefault();
        return;
      }
    }
    let handled = true;
    // The hotkey switch reads the REMAPPED canonical key (DFKeybinds.resolve), falling back to
    // event.key when that module never loaded. dwf-core.js already ate the camera keys in capture.
    switch (window.DFKeybinds ? window.DFKeybinds.resolve(event) : event.key) {

      case "m": armDesignation("dig", "dig"); break;
      case "g": armDesignation("plant", "gather"); break;
      case "l": armDesignation("plant", "chop"); break;  // D_DESIGNATE_CHOP
      case "v": armDesignation("smooth", "smooth"); break;
      case "x": window.selectDesignation("erase"); break;

      // Placement menus (DF: build=b, stockpile=p, zone=z). openPanel toggles the palette.
      case "b": openPanel("build"); break;
      case "p": openPanel("stockpile"); break;
      case "z": openPanel("zone"); break;

      case "i": armDesignation("itemdesig", window.DFPlacementController.itemDesigTools.has(window.DFPlacementController.selectedDesignation) ? window.DFPlacementController.selectedDesignation : "claim"); break;
      case "U": window.toggleBurrowPanel(); break;  // D_BURROWS (Shift+U)
      case "h": window.toggleHaulingPanel(); break;  // D_HAULING
      case "T": armModeTool("traffic"); break;                 // D_DESIGNATE_TRAFFIC (Shift+T)

      // Fort info panels (bottom-left cluster, DF's real D_* binds).
      case "u": openPanel("citizens"); break;      // D_UNITLIST
      case "t": openPanel("orders"); break;        // D_JOBLIST (tasks)
      case "y": openPanel("labor"); break;         // D_LABOR
      case "o": openPanel("workorders"); break;    // D_ORDERS
      // DF binds `n` to D_NOBLES and also to the palettes' toggle-advanced-options. Native resolves the
      // collision by context -- the key belongs to an open palette -- so this does the same.
      case "n":
        if (window.designationPaletteOpen()) { window.DFPlacementController.advOpen = !window.DFPlacementController.advOpen; window.updateDesignationButtons(); }
        else openPanel("nobles");
        break;
      case "O": openPanel("objects"); break;       // D_ARTLIST (Shift+O)
      case "N": openPanel("alerts"); break;        // D_ANNOUNCE (Shift+N)
      case "P": openPanel("locations"); break;     // D_LOCATIONS (Shift+P)
      case "q": openPanel("squads"); break;  // D_SQUADS
      case "j": openPanel("justice"); break;  // D_JUSTICE
      case "k": openPanel("stocks"); break;  // D_STOCKS
      case "Y": openPanel("worldmap"); break;       // D_WORLD (Shift+Y)
      case "F": openPanel("kitchen"); break;  // not a DF main-toolbar key
      case "G": openPanel("petitions"); break;  // not a DF main-toolbar key
      case "B": openPanel("obligations"); break;  // Obligations board: a client-only aggregate, so DF has no key for it

      // Display toggles (DF: r=ramp indicators, f=liquid/fluid numerals).
      case "r": window.setDisplayToggle("rampArrows", !window.DFPlacementController.displayToggles.rampArrows); break;   // D_TOGGLE_RAMP_INDICATORS
      case "f": window.setDisplayToggle("liquidNumbers", !window.DFPlacementController.displayToggles.liquidNumbers); break; // D_TOGGLE_FLUID_NUMBERS

      // Pause / unpause (DF: Space). Ignore auto-repeat: a held Space would strobe the sim, because the
      // server-side arbiter deliberately lets the SAME actor alternate.
      case " ": if (!event.repeat) window.performAction("toggle-pause"); break;

      case "?": case "F1": window.DFHelpPanel?.toggle(); break;
      case "H": window.DwfKeymap?.toggleOverlay(); break;

      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  });


  if (typeof window !== "undefined") Object.assign(window, {
    zoneRepaintFinalShape, commitZoneRepaintDraft, armDesignation,
  });
