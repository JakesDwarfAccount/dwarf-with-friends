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

  // ---- burrows: the mode button opens a full-height LEFT panel (add plate + per-burrow rows) ----
  let burrowsCache = [];       // last /burrows list payload
  let burrowPalette = [];      // DF's live 16-colour curses palette, from /burrows
  let burrowsZ = null;
  let burrowsWorldRects = false;
  let burrowSeq = -1;
  let burrowWindowSig = "";
  let burrowWindowTimer = null;
  let burrowMembers = [];      // members of the burrow whose citizens sub-view is open
  let burrowCitizensFor = -1;  // burrow id the citizens sub-view is open for, or -1
  let burrowCitizenFilter = "all";
  let burrowCitizenSearch = "";
  let burrowCitizenSort = "name";
  let burrowSymbolFor = -1;    // burrow id the symbol/colour sub-view is open for, or -1
  let burrowRenamingId = -1;   // burrow id whose row is in inline-rename mode, or -1
  const burrowPanel = document.createElement("div");
  burrowPanel.id = "burrowPanel";
  burrowPanel.hidden = true;
  document.body.appendChild(burrowPanel);

  function setBurrowStatus(msg, isErr = false) {
    const el = burrowPanel.querySelector("[data-burrow-status]");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("err", !!isErr);
  }
  function updateBurrowButtons() {
    window.updateDesignationButtons(); // repaints the toolbar burrow button highlight (burrowMode)
  }

  async function fetchBurrows(detailId = -1) {
    const url = `/burrows?player=${encodeURIComponent(player)}` +
      (detailId >= 0 ? `&detail=${encodeURIComponent(detailId)}` : "") + `&t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("burrows failed");
    return r.json();
  }

  function burrowCentreOnThisLevel(id) {
    const burrow = (burrowsCache || []).find(x => Number(x.id) === id);
    const rects = burrow && Array.isArray(burrow.rects) ? burrow.rects : [];
    if (!rects.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) {
      const rx = Number(r.x), ry = Number(r.y);
      const rw = Math.max(1, Number(r.w) || 1), rh = Math.max(1, Number(r.h) || 1);
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) continue;
      x0 = Math.min(x0, rx); y0 = Math.min(y0, ry);
      x1 = Math.max(x1, rx + rw - 1); y1 = Math.max(y1, ry + rh - 1);
    }
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
    const z = Number(burrow.z ?? burrowsZ);
    if (!Number.isFinite(z)) return null;
    return { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2), z };
  }

  // Is the destructive confirm gate currently latched on this burrow?
  function burrowDeleteArmedFor(id) {
    try {
      const gate = window.DwfConfirmGate;
      return !!gate && gate.isArmed(gate.key("burrow-delete", id));
    } catch (_) { return false; }
  }

  function confirmGateRerender() {
    try { if (window.DwfConfirmGate) window.DwfConfirmGate.notifyChanged(); }
    catch (err) { DwfErr.report("burrow.confirm-gate-notify", err); }
  }
  try {
    window.DwfConfirmGate.onChange(() => {
      try { if (!burrowPanel.hidden) renderBurrowPanel(); }
      catch (err) { DwfErr.report("burrow.confirm-gate-render", err); }
    });
  } catch (err) { DwfErr.report("burrow.confirm-gate-register", err); }

  function renderBurrowPanel() {
    if (burrowCitizensFor >= 0) { renderBurrowCitizens(); return; }
    if (burrowSymbolFor >= 0) { renderBurrowSymbol(); return; }
    burrowPanel.innerHTML = window.DwfControlShell.burrowPanelMarkup({
      burrows: burrowsCache, paintId: window.DFPlacementController.burrowPaintId, renamingId: burrowRenamingId,
      paintMode: window.paintModeOf("burrow"), erase: window.DFPlacementController.burrowEraseArmed,
    });
    // Sprite art for the row tools + paint bar (real BURROW_* tokens).
    burrowPanel.querySelectorAll("[data-burrow-suspend]").forEach(b => {
      const on = b.classList.contains("on");
      window.paintSprite(b, "burrowSuspend", on);
    });
    burrowPanel.querySelectorAll("[data-burrow-citizens]").forEach(b => window.paintSprite(b, "burrowAddUnit", false));
    burrowPanel.querySelectorAll("[data-burrow-delete]").forEach(b => {
      const armed = burrowDeleteArmedFor(Number(b.dataset.burrowDelete));
      window.paintSprite(b, "burrowDelete", armed);
      b.classList.toggle("confirm-armed", armed);
      b.title = armed ? "Press again to confirm deleting this burrow" : "Delete burrow";
    });
    // limit_workshops is a genuine TWO-SPRITE toggle (DF ships art for both states), so the
    // token itself changes with the state -- unlike suspend, where one token flips active/inactive.
    burrowPanel.querySelectorAll("[data-burrow-workshops]").forEach(b => {
      const on = !!burrowsCache.find(x => x.id === Number(b.dataset.burrowWorkshops))?.limitWorkshops;
      window.paintSprite(b, on ? "burrowWorkshopsOnly" : "burrowWorkshopsAll", on);
    });
    burrowPanel.querySelectorAll("[data-burrow-symbol]").forEach(b => window.paintSprite(b, "burrowRepaint", false));
    burrowPanel.querySelectorAll("[data-burrow-recenter]").forEach(b => window.paintSprite(b, "burrowRecenter", false));
    burrowPanel.querySelectorAll("[data-paint-mode]").forEach(b => {
      const mode = b.dataset.paintMode;
      window.paintSprite(b, mode === "free" ? "paintFree" : "paintRect", window.paintModeOf("burrow") === mode);
      b.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        window.setPaintModeOf("burrow", mode === "free" ? "free" : "rect");
        window.DFPlacementController.burrowEraseArmed = false;
        renderBurrowPanel();
        focusPage();
      });
    });
    const eraseBtn = burrowPanel.querySelector("[data-burrow-erase]");
    if (eraseBtn) {
      window.paintSprite(eraseBtn, "burrowErase", window.DFPlacementController.burrowEraseArmed);
      eraseBtn.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        window.DFPlacementController.burrowEraseArmed = !window.DFPlacementController.burrowEraseArmed;
        renderBurrowPanel();
        focusPage();
      });
    }
    burrowPanel.querySelector("[data-burrow-add]")?.addEventListener("click", async event => {
      event.stopPropagation();
      try {
        const r = await fetch(`/burrow-create?player=${encodeURIComponent(player)}&name=${encodeURIComponent("New Burrow")}`, { method: "POST", cache: "no-store" });
        if (!r.ok) throw new Error("create failed");
        const data = await r.json();
        if (typeof data.id === "number") window.DFPlacementController.burrowPaintId = data.id; // arm paint immediately (DF flow)
        window.DFPlacementController.burrowEraseArmed = false;
        await refreshBurrowPanel();
        setBurrowStatus("Burrow created. Paint its tiles on the map.");
        window.updateToolCursor();
      } catch (_) { setBurrowStatus("Create failed.", true); }
      focusPage();
    });
    burrowPanel.querySelector("[data-burrow-paint-done]")?.addEventListener("click", event => {
      event.stopPropagation();
      window.DFPlacementController.burrowPaintId = -1;
      window.DFPlacementController.burrowEraseArmed = false;
      renderBurrowPanel();
      window.updateToolCursor();
      focusPage();
    });
    burrowPanel.querySelectorAll("[data-burrow-paint]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.burrowPaint);
      window.DFPlacementController.burrowPaintId = window.DFPlacementController.burrowPaintId === id ? -1 : id; // click again to disarm
      window.DFPlacementController.burrowEraseArmed = false;
      renderBurrowPanel();
      window.updateToolCursor();
      focusPage();
    }));
    // Inline rename: the pencil swaps the name for an input (live /burrow-rename endpoint).
    burrowPanel.querySelectorAll("[data-burrow-rename]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.burrowRename);
      burrowRenamingId = burrowRenamingId === id ? -1 : id;
      renderBurrowPanel();
      const input = burrowPanel.querySelector(`[data-burrow-rename-input="${id}"]`);
      if (input) { input.focus(); input.select(); }
    }));
    const saveRename = async id => {
      const input = burrowPanel.querySelector(`[data-burrow-rename-input="${id}"]`);
      const name = input ? input.value : "";
      burrowRenamingId = -1;
      try {
        const r = await fetch(`/burrow-rename?player=${encodeURIComponent(player)}&id=${id}&name=${encodeURIComponent(name)}`, { method: "POST", cache: "no-store" });
        if (!r.ok) throw new Error("rename failed");
        await refreshBurrowPanel();
        setBurrowStatus("Burrow renamed.");
      } catch (_) {
        renderBurrowPanel();
        setBurrowStatus("Rename failed.", true);
      }
    };
    burrowPanel.querySelectorAll("[data-burrow-rename-save]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      saveRename(Number(b.dataset.burrowRenameSave));
    }));
    burrowPanel.querySelectorAll("[data-burrow-rename-input]").forEach(input =>
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); saveRename(Number(input.dataset.burrowRenameInput)); }
        if (event.key === "Escape") { burrowRenamingId = -1; renderBurrowPanel(); }
        event.stopPropagation();
      }));
    const pendingAction = async (url, okMsg) => {
      const r = await window.postMaybePending(url);
      if (!r) {
        console.warn(`[WD-13] ${url.split("?")[0]}: endpoint pending (src/burrows_panel.cpp only ships create/rename/unit)`);
        setBurrowStatus("That burrow control needs a server route that hasn't landed yet.", true);
        return;
      }
      await refreshBurrowPanel();
      setBurrowStatus(okMsg);
    };
    burrowPanel.querySelectorAll("[data-burrow-suspend]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.burrowSuspend);
      const on = burrowsCache.find(x => x.id === id)?.suspended;
      pendingAction(`/burrow-action?player=${encodeURIComponent(player)}&id=${id}&action=${on ? "resume" : "suspend"}`,
        on ? "Burrow resumed." : "Burrow suspended.");
      focusPage();
    }));
    burrowPanel.querySelectorAll("[data-burrow-civalert]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.burrowCivalert);
      const on = burrowsCache.find(x => x.id === id)?.civAlert;
      pendingAction(`/burrow-action?player=${encodeURIComponent(player)}&id=${id}&action=${on ? "civalert-off" : "civalert-on"}`,
        on ? "Civilian alert cleared." : "Civilian alert set.");
      focusPage();
    }));
    burrowPanel.querySelectorAll("[data-burrow-delete]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.burrowDelete);
      // Deleting a burrow destroys its tiles, citizen assignments and alert membership with no undo,
      // so it is gated: first press arms, a second on the SAME row commits, anything else disarms.
      const gate = window.DwfConfirmGate;
      if (gate && gate.press(gate.key("burrow-delete", id)) !== "commit") {
        setBurrowStatus("Press delete again to confirm — this cannot be undone.");
        renderBurrowPanel();
        focusPage();
        return;
      }
      if (window.DFPlacementController.burrowPaintId === id) { window.DFPlacementController.burrowPaintId = -1; window.updateToolCursor(); }
      pendingAction(`/burrow-delete?player=${encodeURIComponent(player)}&id=${id}`, "Burrow deleted.");
      focusPage();
    }));
    burrowPanel.querySelectorAll("[data-burrow-citizens]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      burrowCitizensFor = Number(b.dataset.burrowCitizens);
      burrowCitizenFilter = "all";
      burrowCitizenSearch = "";
      burrowCitizenSort = "name";
      renderBurrowCitizens();
      focusPage();
    }));
    // Recenter is resolved LIVE from the rects the client holds, never a baked position. /burrows
    // serves rects for the requester's camera z only, so a burrow with no tiles here cannot be located.
    burrowPanel.querySelectorAll("[data-burrow-recenter]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.burrowRecenter);
      const pos = burrowCentreOnThisLevel(id);
      if (!pos) {
        setBurrowStatus("No tiles for this burrow on this level — change level and try again.");
        focusPage();
        return;
      }
      if (typeof centerAndFlashMapPos === "function") centerAndFlashMapPos(pos);
      focusPage();
    }));
    // limit_workshops -- the second (and only other) bit in df::burrow_flag.
    burrowPanel.querySelectorAll("[data-burrow-workshops]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.burrowWorkshops);
      const on = burrowsCache.find(x => x.id === id)?.limitWorkshops;
      pendingAction(`/burrow-action?player=${encodeURIComponent(player)}&id=${id}&action=${on ? "workshops-all" : "workshops-limit"}`,
        on ? "Workshops: everywhere." : "Workshops: burrow only.");
      focusPage();
    }));
    // symbol/colour sub-view.
    burrowPanel.querySelectorAll("[data-burrow-symbol]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      burrowSymbolFor = Number(b.dataset.burrowSymbol);
      renderBurrowSymbol();
      focusPage();
    }));
  }

  function renderBurrowSymbol() {
    const id = burrowSymbolFor;
    const burrow = burrowsCache.find(b => b.id === id);
    if (!burrow) { burrowSymbolFor = -1; renderBurrowPanel(); return; } // deleted under us
    burrowPanel.innerHTML = window.DwfControlShell.burrowSymbolMarkup({
      burrow, paletteRgb: burrowPalette,
    });
    DWFUI.paintSprites(burrowPanel); // blits the 23 CUSTOM_SYMBOLS crops + the back arrow
    burrowPanel.querySelector("[data-burrow-symbol-back]")?.addEventListener("click", event => {
      event.stopPropagation();
      burrowSymbolFor = -1;
      renderBurrowPanel();
      focusPage();
    });
    // One POST per pick, each naming ONLY the facet that changed (the route treats a missing
    // symbol/fg/bg as "leave it alone"), so picking a colour can never silently rewrite the symbol.
    const post = async (query, msg) => {
      try {
        const r = await fetch(`/burrow-symbol?player=${encodeURIComponent(player)}&id=${id}&${query}`,
          { method: "POST", cache: "no-store" });
        if (!r.ok) throw new Error("symbol failed");
        await refreshBurrowPanel();   // re-renders this sub-view with the new selection latched
        setBurrowStatus(msg);
      } catch (_) { setBurrowStatus("Symbol change failed.", true); }
      focusPage();
    };
    burrowPanel.querySelectorAll("[data-burrow-symbol-pick]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      post(`symbol=${Number(b.dataset.burrowSymbolPick)}`, "Symbol changed.");
    }));
    burrowPanel.querySelectorAll("[data-burrow-color-index]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const channel = b.dataset.burrowColorChannel === "bg" ? "bg" : "fg";
      post(`${channel}=${Number(b.dataset.burrowColorIndex)}`,
        channel === "bg" ? "Background colour changed." : "Colour changed.");
    }));
  }

  async function renderBurrowCitizens() {
    const id = burrowCitizensFor;
    const burrow = burrowsCache.find(b => b.id === id);
    // BUTTON_CLOSE_LEFT is DF's own back arrow.
    burrowPanel.innerHTML = `<div class="burrow-head">
        ${DWFUI.artBtnHtml({ cls: "burrow-add burrow-back", dataset: { burrowBack: "" }, sprite: "BUTTON_CLOSE_LEFT", title: "Back to the burrow list", ariaLabel: "Back to the burrow list" })}
        <div class="burrow-cit-title">${escapeHtml(burrow?.name || `Burrow ${id}`)}: citizens</div>
      </div>
      <div data-burrow-cit-controls></div>
      ${DWFUI.scrollHtml({ cls: "burrow-list burrow-cit-list", rows: ".burrow-cit-row",
        ariaLabel: "Burrow citizens" }, '<div class="burrow-empty">Loading...</div>')}
      <div data-burrow-cit-search></div>
      <div class="stock-palette-status" data-burrow-status></div>`;
    burrowPanel.querySelector("[data-burrow-back]").addEventListener("click", event => {
      event.stopPropagation();
      burrowCitizensFor = -1;
      renderBurrowPanel();
      focusPage();
    });
    let citizens = [];
    let militaryIds = new Set();
    let militaryKnown = true;
    try {
      const [detail, panelData, squadsData] = await Promise.all([
        fetchBurrows(id),
        fetch(`/panel?player=${encodeURIComponent(player)}&panel=citizens&t=${Date.now()}`, { cache: "no-store" })
          .then(r => (r.ok ? r.json() : null))
          .catch(err => { DwfErr.report("burrow.citizens", err); return null; }),
        fetch(`/squads?player=${encodeURIComponent(player)}&t=${Date.now()}`, { cache: "no-store" })
          .then(r => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      burrowMembers = Array.isArray(detail?.members) ? detail.members : [];
      citizens = Array.isArray(panelData?.rows)
        ? panelData.rows.filter(row => Number(row.unitId) >= 0) : [];
      if (!Array.isArray(squadsData?.squads)) {
        militaryKnown = false;
      } else {
        squadsData.squads.forEach(squad => {
          (Array.isArray(squad?.members) ? squad.members : []).forEach(member => {
            const unitId = Number(member?.unitId);
            if (member?.filled !== false && unitId >= 0) militaryIds.add(unitId);
          });
        });
      }
    } catch (_) {
      setBurrowStatus("Citizen list unavailable.", true);
    }
    if (burrowCitizensFor !== id) return; // navigated away while loading
    const memberIds = new Set(burrowMembers.map(m => Number(m.unitId)));
    const listEl = burrowPanel.querySelector(".burrow-list");
    const controlsEl = burrowPanel.querySelector("[data-burrow-cit-controls]");
    const searchEl = burrowPanel.querySelector("[data-burrow-cit-search]");
    if (!listEl || !controlsEl || !searchEl) return;

    searchEl.innerHTML = DWFUI.searchHtml({
      cls: "burrow-cit-search", inputCls: "burrow-cit-search-input",
      dataAttr: "burrow-cit-search", value: burrowCitizenSearch,
      placeholder: "Search citizens", placement: "footer", magnifier: true,
    });

    const renderRows = () => {
      const state = { filter: burrowCitizenFilter, search: burrowCitizenSearch,
        sort: burrowCitizenSort, militaryKnown };
      controlsEl.innerHTML = window.DwfControlShell.burrowMembershipControlsMarkup(
        citizens, militaryIds, state);
      const shown = window.DwfControlShell.burrowMembershipRows(
        citizens, memberIds, militaryIds, state);
      listEl.innerHTML = shown.length ? shown.map(u => {
        const uid = Number(u.unitId);
        const professionColor = Number(u.professionColor);
        const nameStyle = Number.isInteger(professionColor) && professionColor >= 0 && professionColor <= 15
        ? ` data-df-color="${professionColor}"` : "";
        return `<div class="burrow-cit-row">
          <div class="burrow-cit-name"${nameStyle}>${escapeHtml(u.name || `Unit ${uid}`)}</div>
          <div class="burrow-cit-prof">${escapeHtml(u.profession || "")}</div>
          ${DWFUI.plaqueBtnHtml({ cls: `zone-unit-act${u.assigned ? " assigned" : ""}`,
            dataset: { burrowUnit: uid, on: u.assigned ? 0 : 1 },
            label: u.assigned ? "Unassign" : "Assign", tone: u.assigned ? "red" : "green",
            title: u.assigned ? "Remove this citizen from the burrow" : "Assign this citizen to the burrow" })}
        </div>`;
      }).join("") : `<div class="burrow-empty">No citizens match these filters.</div>`;

      controlsEl.querySelectorAll("[data-burrow-cit-filter]").forEach(button =>
        button.addEventListener("click", event => {
          event.stopPropagation();
          burrowCitizenFilter = button.dataset.burrowCitFilter || "all";
          renderRows();
        }));
      controlsEl.querySelectorAll("[data-burrow-cit-sort]").forEach(button =>
        button.addEventListener("click", event => {
          event.stopPropagation();
          burrowCitizenSort = button.dataset.burrowCitSort || "name";
          renderRows();
        }));
      listEl.querySelectorAll("[data-burrow-unit]").forEach(b => b.addEventListener("click", async event => {
        event.stopPropagation();
        const uid = Number(b.dataset.burrowUnit);
        const on = Number(b.dataset.on) ? 1 : 0;
        try {
          const r = await fetch(`/burrow-unit?player=${encodeURIComponent(player)}&id=${id}&unit=${uid}&on=${on}`, { method: "POST", cache: "no-store" });
          if (!r.ok) throw new Error("membership failed");
          renderBurrowCitizens(); // re-read both membership and military classification
        } catch (_) { setBurrowStatus("Membership change failed.", true); }
        focusPage();
      }));
      try {
        DWFUI.paintSprites(controlsEl);
        DWFUI.paintBitmapText(controlsEl);
      } catch (err) { DwfErr.report("burrow.bitmap-paint", err); }
    };
    renderRows();
    searchEl.querySelector("[data-burrow-cit-search]")?.addEventListener("input", event => {
      burrowCitizenSearch = event.target.value || "";
      renderRows();
    });
  }

  async function refreshBurrowPanel() {
    try {
      const data = await fetchBurrows();
      burrowsCache = Array.isArray(data?.burrows) ? data.burrows : [];
      // A payload is only valid for the z it was built for, and only pan-free if the server shipped
      // world rects. Both absent means an older DLL, kept working on the older contract.
      burrowsZ = typeof data?.z === "number" ? data.z : null;
      burrowsWorldRects = data?.worldRects === true;
      if (typeof data?.seq === "number") burrowSeq = data.seq;
      burrowWindowSig = renderWindowSig();
      burrowPalette = Array.isArray(data?.palette) ? data.palette : [];
      if (window.DFPlacementController.burrowPaintId >= 0 && !burrowsCache.some(b => b.id === window.DFPlacementController.burrowPaintId))
        window.DFPlacementController.burrowPaintId = -1;
    } catch (_) {
      burrowsCache = [];
    }
    if (window.DwfBurrowOverlay) window.DwfBurrowOverlay.setBurrows(burrowsCache, burrowsZ);
    renderBurrowPanel();
  }

  function renderWindowSig() {
    const T = window.DwfTiles;
    const rr = T && typeof T.getRenderRect === "function" ? T.getRenderRect() : null;
    if (!rr) return "";
    return burrowsWorldRects ? `z${rr.oz}` : `${rr.ox},${rr.oy},${rr.oz},${rr.gw},${rr.gh}`;
  }
  function burrowWindowWatch() {
    if (!window.DFPlacementController.burrowMode) return;
    const sig = renderWindowSig();
    if (sig && sig !== burrowWindowSig) {
      burrowWindowSig = sig;
      scheduleBurrowRefresh();
    }
  }

  function enterBurrowMode() {
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("burrows");
    clearBuildPlacement(false);
    window.closeStockMode();
    window.closeZoneMode();
    window.DFPlacementController.currentTool = null;
    window.DFPlacementController.selectedDesignation = null;
    window.DFPlacementController.digMenuOpen = false;
    window.DFPlacementController.plantMenuOpen = false;
    window.DFPlacementController.smoothMenuOpen = false;
    window.DFPlacementController.itemDesigMenuOpen = false;
    window.DFPlacementController.burrowMode = "open";
    window.DFPlacementController.burrowPaintId = -1;
    window.DFPlacementController.burrowEraseArmed = false;
    burrowCitizensFor = -1;
    burrowSymbolFor = -1;
    burrowPanel.hidden = false;
    burrowWindowSig = "";
    if (burrowWindowTimer) clearInterval(burrowWindowTimer);
    burrowWindowTimer = setInterval(burrowWindowWatch, 250);  // pan/z staleness watch
    window.updateDesignationButtons();
    window.updateToolCursor();
    refreshBurrowPanel();
  }
  function toggleBurrowPanel() {
    if (window.DFPlacementController.burrowMode) { window.closeBurrowMode(); return; }
    enterBurrowMode();
  }

  let burrowPaintPending = false;
  let burrowRefreshTimer = null;
  function scheduleBurrowRefresh() {
    if (burrowRefreshTimer) clearTimeout(burrowRefreshTimer);
    burrowRefreshTimer = setTimeout(() => {
      burrowRefreshTimer = null;
      if (window.DFPlacementController.burrowMode) refreshBurrowPanel();
    }, 120);
  }

  window.DFBurrowSync = {
    onBurrows(msg) {
      const seq = Number(msg && msg.seq);
      if (!isFinite(seq) || seq === burrowSeq) return;
      burrowSeq = seq;
      if (window.DFPlacementController.burrowMode) scheduleBurrowRefresh();
    },
  };
  async function burrowPaintRect(x1t, y1t, x2t, y2t, w, h) {
    if (window.DFPlacementController.burrowPaintId < 0) return;
    if (burrowPaintPending) {
      setBurrowStatus("Tile painting needs the /burrow-paint server route (pending).", true);
      return;
    }
    const mode = window.DFPlacementController.burrowEraseArmed ? "erase" : "add";
    const url = `/burrow-paint?player=${encodeURIComponent(player)}&id=${window.DFPlacementController.burrowPaintId}` +
      `&px=${x1t}&py=${y1t}&px2=${x2t}&py2=${y2t}&w=${w}&h=${h}&mode=${mode}`;
    const r = await window.postMaybePending(url);
    if (!r) {
      burrowPaintPending = true;
      console.warn("[WD-13] /burrow-paint: route not answered -- the DLL is older than this client");
      setBurrowStatus("Tile painting needs the /burrow-paint server route (pending).", true);
      return;
    }
    setBurrowStatus(mode === "erase" ? "Tiles erased." : "Tiles painted.");
    scheduleBurrowRefresh(); // pull the new tile rects so the map overlay tracks the stroke
  }
  function burrowPaintDrag(x1, y1, x2, y2) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    if (!a || !b) return;
    burrowPaintRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), a.w, a.h);
  }
  function burrowFreePaintTo(cell) {
    if (!window.DFPlacementController.burrowFreeCells || !cell) return;
    const from = window.DFPlacementController.burrowFreeLast || cell;
    let x = from.x, y = from.y;
    const x1 = cell.x, y1 = cell.y;
    const dx = Math.abs(x1 - x), sx = x < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y), sy = y < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      const key = `${x},${y}`;
      if (!window.DFPlacementController.burrowFreeCells.has(key)) {
        window.DFPlacementController.burrowFreeCells.add(key);
        burrowPaintRect(x, y, x, y, cell.w, cell.h);
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    window.DFPlacementController.burrowFreeLast = cell;
  }


  if (typeof window !== "undefined") Object.assign(window, {
    setBurrowStatus, updateBurrowButtons, confirmGateRerender, toggleBurrowPanel, burrowPaintRect, burrowPaintDrag, burrowFreePaintTo,
  });

  if (typeof window !== "undefined" && window.DFPlacementController) {
    Object.defineProperties(window.DFPlacementController, {
      burrowWindowSig: { get: () => burrowWindowSig, set: value => { burrowWindowSig = value; }, configurable: true },
      burrowWindowTimer: { get: () => burrowWindowTimer, set: value => { burrowWindowTimer = value; }, configurable: true },
      burrowCitizensFor: { get: () => burrowCitizensFor, set: value => { burrowCitizensFor = value; }, configurable: true },
      burrowSymbolFor: { get: () => burrowSymbolFor, set: value => { burrowSymbolFor = value; }, configurable: true },
      burrowPanel: { get: () => burrowPanel, configurable: true }
    });
  }
