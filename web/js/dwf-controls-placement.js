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

  // B199: selectedBuild lives in dwf-build-info-panels.js. On the 07-11 win31 outage
  // that module intermittently never executed, and every bare cross-script read here threw a
  // ReferenceError -- killing all selection input. Read it through a throw-safe accessor so a
  // missing build module degrades to "build menu dead" instead of "game dead".
  function bipSelBuild() { try { return selectedBuild; } catch (_) { return null; } }

  async function performAction(action) {
    if (action === "reset") {
      await resetToHost();
      return;
    }
    try {
      const res = await fetch(`/action?player=${encodeURIComponent(player)}&action=${encodeURIComponent(action)}`, {
        method: "POST",
        cache: "no-store"
      });
      // WT28/B218: a refused pause action used to fail SILENTLY (the button just looked dead).
      // The one non-silent refusal the server issues is the popup gate ("a native announcement
      // popup is open - dismiss it first") -- surface the server's own reason as a toast so the
      // player is told WHY unpause did nothing instead of assuming the game broke.
      if (!res.ok) {
        const reason = (await res.text().catch(() => "")).replace(/^action failed:\s*/i, "").trim();
        try {
          if (reason && window.DwfPause && typeof DwfPause.toast === "function")
            DwfPause.toast(reason);
        } catch (_) {}
      }
    } catch (_) {}
    loadHud();
  }

  function centerFromMinimap(event) {
    if (!currentHud) return;
    const rect = hudEls.minimap.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const fy = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const map = currentHud.map || { w: 1, h: 1 };
    const vp = currentHud.viewport || { w: 80, h: 50 };
    const x = Math.round(fx * map.w - vp.w / 2);
    const y = Math.round(fy * map.h - vp.h / 2);
    const z = currentHud.camera?.z ?? 0;
    resetPanPrediction();
    fetch(`/camera?player=${encodeURIComponent(player)}&x=${x}&y=${y}&z=${z}`, { method: "POST", cache: "no-store" })
      .then(loadHud).catch(() => {});
  }
  // Recenter z to the surface / deepest-discovered level at the camera's location (backend-computed).
  function recenterZ(which) {
    if (!currentHud) return;
    const mm = currentHud.minimap || {};
    const cam = currentHud.camera || { x: 0, y: 0, z: 0 };
    const z = which === "deepest" ? (mm.deepestZ ?? cam.z) : (mm.surfaceZ ?? cam.z);
    resetPanPrediction();
    fetch(`/camera?player=${encodeURIComponent(player)}&x=${cam.x}&y=${cam.y}&z=${z}`, { method: "POST", cache: "no-store" })
      .then(loadHud).catch(() => {});
  }

  document.querySelectorAll("[data-panel]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openPanel(button.dataset.panel);
      focusPage();
    });
  });

  document.querySelectorAll("[data-action]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      performAction(button.dataset.action);
      focusPage();
    });
  });

  // --- WD-5: pause/play/settings-gear/help real DF sprite icons (were unicode glyphs) --
  // BUTTON_PAUSE_ACTIVE/_INACTIVE + BUTTON_PLAY_ACTIVE/_INACTIVE swap with the game-speed
  // state (see DFRefreshPauseIcons, called from renderHud); settings/help are single-state.
  const topbarPauseBtn = document.querySelector('#topbar [data-action="pause"]');
  const topbarPlayBtn = document.querySelector('#topbar [data-action="play"]');
  const topbarHelpBtn = document.getElementById("helpBtn");
  function paintTopbarGlyphIcon(button, initialToken) {
    if (!button) return null;
    button.textContent = "";
    const icon = window.DFChrome.icon(initialToken, 22);
    button.appendChild(icon);
    return icon;
  }
  const topbarPauseIcon = paintTopbarGlyphIcon(topbarPauseBtn, "BUTTON_PAUSE_INACTIVE");
  const topbarPlayIcon = paintTopbarGlyphIcon(topbarPlayBtn, "BUTTON_PLAY_ACTIVE");
  window.DFRefreshPauseIcons = isPaused => {
    if (topbarPauseIcon) window.DFChrome.updateIcon(topbarPauseIcon,
      isPaused ? "BUTTON_PAUSE_ACTIVE" : "BUTTON_PAUSE_INACTIVE", 22);
    if (topbarPlayIcon) window.DFChrome.updateIcon(topbarPlayIcon,
      isPaused ? "BUTTON_PLAY_INACTIVE" : "BUTTON_PLAY_ACTIVE", 22);
  };

  // --- Settings cog: the full Settings panel is the single settings entry point. ---
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsMenu = document.getElementById("settingsMenu");
  // The legacy small cog popover is static markup for old cached clients. Remove it before it
  // can become a second, divergent settings surface; DFSettings owns these preferences now.
  if (settingsMenu) settingsMenu.remove();
  // W5C: BUTTON_SETTINGS / BUTTON_HELP are single-state, so their art is now born with the host in
  // dwf-interface-shell.js (DWFUI iconHtml + paintSprites). Only the STATEFUL pause/play pair
  // is still stamped from here, because the controller owns the game-speed swap.
  const setInstantRow = document.getElementById("setInstantDig");
  const setPredictiveRow = document.getElementById("setPredictivePan");
  const setUnitImagesRow = document.getElementById("setUnitImages");
  const setShowAttributionRow = document.getElementById("setShowAttribution");
  function refreshSettingsUi() {
    if (setInstantRow) setInstantRow.classList.toggle("on", instantDesignate);
    if (setPredictiveRow) setPredictiveRow.classList.toggle("on", predictivePan);
    if (setUnitImagesRow) setUnitImagesRow.classList.toggle("on", unitImagesEnabled);
    if (setShowAttributionRow) setShowAttributionRow.classList.toggle("on",
      typeof attribShowEnabled === "function" ? attribShowEnabled() : true);
    if (settingsBtn) settingsBtn.classList.toggle("sb-active", !!settingsMenu && settingsMenu.classList.contains("open"));
  }
  function setInstantDesignate(on) {
    instantDesignate = !!on;
    try { localStorage.setItem("dfplex.instantDesignate", instantDesignate ? "1" : "0"); } catch (_) {}
    if (instantDesignate) {
      // entering instant mode: drop any server-painted cursor so it doesn't linger in the frame
      if (placementActive()) sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true);
    } else {
      // leaving instant mode: drop the browser preview; the server cursor resumes on next move
      dragPreview = null;
      renderZoneOverlay();
    }
    refreshSettingsUi();
  }
  function setPredictivePan(on) {
    predictivePan = !!on;
    try { localStorage.setItem("dfplex.predictivePan", predictivePan ? "1" : "0"); } catch (_) {}
    if (predictivePan) applyPanPrediction(); else clearPanPrediction();
    refreshSettingsUi();
  }
  function setUnitImagesEnabled(on) {
    unitImagesEnabled = !!on;
    try { localStorage.setItem("dfplex.unitImages", unitImagesEnabled ? "1" : "0"); } catch (_) {}
    if (selection.classList.contains("unit-sheet-panel") && selectedUnitData)
      renderUnitSheet();
    if (activeInfoPanel && clientPanel.classList.contains("visible"))
      openPanel(activeInfoPanel, activeInfoSection || "", activeInfoDetail || "");
    refreshSettingsUi();
  }
  // WP-C: flip the "Show attribution" display toggle (state lives in dwf-attribution.js);
  // re-render an open work-orders / inspect panel so dots appear/disappear immediately.
  function setShowAttributionEnabled(on) {
    if (typeof attribSetShow === "function") attribSetShow(!!on);
    if (activeInfoPanel && clientPanel.classList.contains("visible"))
      openPanel(activeInfoPanel, activeInfoSection || "", activeInfoDetail || "");
    refreshSettingsUi();
  }
  if (settingsBtn) {
    settingsBtn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (window.DFSettings && typeof window.DFSettings.open === "function") window.DFSettings.open();
      refreshSettingsUi();
      focusPage();
    });
  }
  if (settingsMenu) {
    if (setInstantRow) setInstantRow.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      setInstantDesignate(!instantDesignate);
    });
    if (setPredictiveRow) setPredictiveRow.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      setPredictivePan(!predictivePan);
    });
    if (setUnitImagesRow) setUnitImagesRow.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      setUnitImagesEnabled(!unitImagesEnabled);
    });
    if (setShowAttributionRow) setShowAttributionRow.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      setShowAttributionEnabled(!(typeof attribShowEnabled === "function" ? attribShowEnabled() : true));
    });
    // close the menu when clicking anywhere outside it
    document.addEventListener("pointerdown", event => {
      if (!settingsMenu.classList.contains("open")) return;
      if (event.target.closest("#settingsMenu, #settingsBtn")) return;
      settingsMenu.classList.remove("open");
      refreshSettingsUi();
    });
  }
  if (topbarHelpBtn) topbarHelpBtn.addEventListener("click", event => {
    // B207: the "?" button opens the FULL help reference -- every tooltip/guide/shortcut, not just
    // the keybinds. (Before this it opened Settings > Keybinds, which is why the owner reported it "just
    // opens up the hotkeys".) stopImmediatePropagation keeps this the ONE source of truth for the
    // button so no later-registered listener double-fires. Falls back to the keybinds settings only
    // if the help panel module somehow failed to load.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (window.DFHelpPanel && typeof window.DFHelpPanel.toggle === "function") window.DFHelpPanel.toggle();
    else if (window.DFSettings && typeof window.DFSettings.open === "function") window.DFSettings.open("keybinds");
    focusPage();
  });
  refreshSettingsUi();

  // Phase-5: expose the interface prefs so the full Settings panel (dwf-settings.js) can
  // present the SAME four toggles the cog does, driven through these EXACT setters -- one source
  // of truth (the cog and the panel are two views of one state). Additive + dormant-safe: the cog
  // is unchanged and works with or without this export.
  window.DFClientPrefs = {
    list() {
      return [
        { id: "instantDesignate", label: "Instant designations", get: () => instantDesignate, set: setInstantDesignate },
        { id: "predictivePan",    label: "Predictive panning",    get: () => predictivePan,    set: setPredictivePan },
        { id: "unitImages",       label: "Unit images",           get: () => unitImagesEnabled, set: setUnitImagesEnabled },
        { id: "showAttribution",  label: "Show attribution",
          get: () => (typeof attribShowEnabled === "function" ? attribShowEnabled() : true),
          set: setShowAttributionEnabled },
        // WTHR-1: the invented rain/snow precipitation overlay (dwf-weather.js) -- ambience DF has
        // no counterpart for, so it defaults ON and this row exists only for players who prefer it
        // off. State/persistence/live-apply all live in DwfWeather (same delegation shape as
        // showAttribution -> dwf-attribution.js); this just presents it as the SAME DWFUI switch row
        // the other prefs use. Gates the draw only -- native snow/spatter tiles are untouched.
        { id: "weatherParticles", label: "Weather particles (rain/snow overlay)",
          get: () => (window.DwfWeather && typeof window.DwfWeather.isEnabled === "function" ? window.DwfWeather.isEnabled() : true),
          set: (on) => { try { if (window.DwfWeather && typeof window.DwfWeather.setEnabled === "function") window.DwfWeather.setEnabled(!!on); } catch (_) {} } },
      ];
    },
    get(id) { const p = this.list().find(x => x.id === id); return p ? !!p.get() : undefined; },
    set(id, on) { const p = this.list().find(x => x.id === id); if (p) p.set(!!on); },
  };

  // --- Zoom controls in the settings menu (UI mirror of the wheel / [ ] zoom) ---
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomResetBtn = document.getElementById("zoomResetBtn");
  const zoomReadout = document.getElementById("zoomReadout");
  function updateZoomReadout() {
    if (!zoomReadout) return;
    if (!tileRenderer || typeof tileRenderer.getZoom !== "function") return;
    const z = tileRenderer.getZoom();
    if (z && z.def) zoomReadout.textContent = Math.round((z.px / z.def) * 100) + "%";
  }
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation(); zoomView("out"); updateZoomReadout(); focusPage();
  });
  if (zoomInBtn) zoomInBtn.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation(); zoomView("in"); updateZoomReadout(); focusPage();
  });
  if (zoomResetBtn) zoomResetBtn.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation(); resetZoomView(); updateZoomReadout(); focusPage();
  });

  // --- B17: in-client UI scale (the sanctioned way to resize the interface, replacing the
  // browser page-zoom that distorts the game UI). Scales the HUD/panels via a `--ui-scale`
  // CSS var (consumed by `zoom:` rules in the stylesheet) -- the map canvas is deliberately
  // left out so it never rescales/blurs. Driven from this settings row, Ctrl+wheel (see
  // dwf-core.js), and Ctrl +/-/0. Persisted per browser. ---
  const UI_SCALE_MIN = 0.7, UI_SCALE_MAX = 1.6, UI_SCALE_STEP = 0.1;
  let uiScale = 1;
  try {
    const saved = parseFloat(localStorage.getItem("dfplex.uiScale"));
    if (Number.isFinite(saved)) uiScale = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, saved));
  } catch (_) {}
  const uiScaleReadout = document.getElementById("uiScaleReadout");
  function applyUiScale() {
    document.documentElement.style.setProperty("--ui-scale", String(uiScale));
    if (uiScaleReadout) uiScaleReadout.textContent = Math.round(uiScale * 100) + "%";
  }
  function setUiScale(v) {
    uiScale = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(v * 100) / 100));
    try { localStorage.setItem("dfplex.uiScale", String(uiScale)); } catch (_) {}
    applyUiScale();
  }
  function adjustUiScale(dir) { setUiScale(uiScale + (dir > 0 ? UI_SCALE_STEP : -UI_SCALE_STEP)); }
  function resetUiScale() { setUiScale(1); }
  window.DWFUIScale = { adjust: adjustUiScale, set: setUiScale, reset: resetUiScale, get: () => uiScale };
  applyUiScale();
  const uiScaleOutBtn = document.getElementById("uiScaleOutBtn");
  const uiScaleInBtn = document.getElementById("uiScaleInBtn");
  const uiScaleResetBtn = document.getElementById("uiScaleResetBtn");
  if (uiScaleOutBtn) uiScaleOutBtn.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation(); adjustUiScale(-1); focusPage();
  });
  if (uiScaleInBtn) uiScaleInBtn.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation(); adjustUiScale(1); focusPage();
  });
  if (uiScaleResetBtn) uiScaleResetBtn.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation(); resetUiScale(); focusPage();
  });
  // Ctrl/Cmd +/-/0: block the browser's own page zoom and drive UI scale instead.
  window.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const k = event.key;
    if (k === "=" || k === "+" || k === "Add") { event.preventDefault(); adjustUiScale(1); }
    else if (k === "-" || k === "_" || k === "Subtract") { event.preventDefault(); adjustUiScale(-1); }
    else if (k === "0") { event.preventDefault(); resetUiScale(); }
  }, { capture: true });

  document.querySelectorAll("[data-move-z]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      queueMove(0, 0, Number(button.dataset.moveZ || 0));
      focusPage();
    });
  });

  document.querySelectorAll("[data-recenter]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      recenterZ(button.dataset.recenter);
      focusPage();
    });
  });

  hudEls.minimap.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    centerFromMinimap(event);
    focusPage();
  });

  // W5C: the 7 stress faces (BUTTON_STRESS_0..6) and the recenter/clear-tracking art are
  // SINGLE-STATE, so they are now born with their hosts in dwf-interface-shell.js through
  // DWFUI's sprite channel. Stamping them over the markup from here was the controller doing the
  // builder's job.
  // B233-1 (census #2 / M25: "the minimap follow-a-unit button is a structural placeholder").
  // It was NOT dead art -- it was HALF-wired: it listened to the PLAYER-follow lock
  // (DwfSpectate, core.js) only, so it stayed hidden and inert while the UNIT-follow lock
  // (dwf-unit-hud-notifications.js, B26/B60/B61 -- the unit sheet's camera latch) was
  // tracking a dwarf, which is the follow a player actually notices. There is no need for a second
  // follow system and no reason to delete the button: both locks now publish the same
  // {following} state (getState/stopFollow/onChange), and this ONE button reflects and clears
  // whichever is engaged. It stays hidden while nothing is followed -- native's clear-tracking art
  // is only present when there is tracking to clear -- so it is never a button that does nothing.
  const followBtn = document.getElementById("followBtn");
  const followLocks = [];   // [{ label, api }] -- filled below from whichever modules are present
  function followingLabels() {
    return followLocks
      .filter(l => { try { return !!(l.api.getState() || {}).following; } catch (_) { return false; } })
      .map(l => l.label);
  }
  function setFollowButtonVisibility(button) {
    if (!button) return;
    const active = followingLabels();
    button.hidden = active.length === 0;
    button.title = active.length
      ? `Stop following ${active.join(" + ")} / clear camera lock`
      : "";
  }
  if (followBtn) {
    const spectate = window.DwfSpectate;
    const unitFollow = window.DwfUnitFollow;
    if (spectate && typeof spectate.getState === "function")
      followLocks.push({ label: "player", api: spectate });
    if (unitFollow && typeof unitFollow.getState === "function")
      followLocks.push({ label: "unit", api: unitFollow });
    followBtn.addEventListener("click", event => {
      event.preventDefault();
      // Clear EVERY engaged lock (they are independent: a player-follow and a unit-follow can both
      // be running, and native's clear-tracking button clears the tracking, not one kind of it).
      followLocks.forEach(lock => {
        try { if (typeof lock.api.stopFollow === "function") lock.api.stopFollow("top-right"); } catch (_) {}
      });
      setFollowButtonVisibility(followBtn);
      focusPage();
    });
    followLocks.forEach(lock => {
      if (typeof lock.api.onChange === "function")
        lock.api.onChange(() => setFollowButtonVisibility(followBtn));
    });
    setFollowButtonVisibility(followBtn);
  }

  // --- WD-6: display toggles (DISPLAY_TOGGLE_LIQUID_NUMBERS / DISPLAY_TOGGLE_RAMP_ARROWS).
  // W-D's job is the buttons + flag plumbing (spec RECONCILE note); the actual map-layer
  // drawing is W-B/W-C territory once it lands on dwf-tiles.js/-render.js (foreign
  // WIP tonight -- not touched here). We augment window.DwfTiles with a no-op-safe
  // setDisplayToggles/getDisplayToggles pair ONLY if it doesn't already define one, so a
  // later real implementation there always wins once it ships.
  let displayToggles = { liquidNumbers: false, rampArrows: false };
  try {
    const saved = JSON.parse(localStorage.getItem("dfplex.displayToggles") || "null");
    if (saved && typeof saved === "object") displayToggles = { ...displayToggles, ...saved };
  } catch (_) {}
  function persistDisplayToggles() {
    try { localStorage.setItem("dfplex.displayToggles", JSON.stringify(displayToggles)); } catch (_) {}
  }
  if (window.DwfTiles && typeof window.DwfTiles.setDisplayToggles !== "function") {
    window.DwfTiles.setDisplayToggles = next => {
      displayToggles = { ...displayToggles, ...(next || {}) };
      persistDisplayToggles();
      refreshDisplayToggleButtons();
    };
    window.DwfTiles.getDisplayToggles = () => ({ ...displayToggles });
  }
  const liquidNumbersBtn = document.getElementById("liquidNumbersBtn");
  const rampArrowsBtn = document.getElementById("rampArrowsBtn");
  // B245: these cells are COMPLETE 16x24 native controls born with their hosts in
  // dwf-interface-shell.js through DWFUI's sprite channel (the ON faces carry DF's own
  // frame). State toggling swaps the DWFUI sprite token in place -- the same pattern the unit
  // sheet's camera latch uses -- instead of stamping a second, DFChrome-scaled canvas over the
  // builder's (which shipped an 18px integer-scaled tile clipped inside the old bordered box).
  function setDisplayToggleSprite(btn, token) {
    if (!btn) return;
    const icon = btn.querySelector("[data-dwfui-sprite]");
    if (!icon || icon.getAttribute("data-dwfui-sprite") === token) return;
    icon.setAttribute("data-dwfui-sprite", token);
    try {
      if (window.DWFUI && typeof window.DWFUI.paintSprites === "function") window.DWFUI.paintSprites(btn);
    } catch (_) {}
  }
  function refreshDisplayToggleButtons() {
    if (liquidNumbersBtn) {
      liquidNumbersBtn.classList.toggle("on", displayToggles.liquidNumbers);
      setDisplayToggleSprite(liquidNumbersBtn,
        displayToggles.liquidNumbers ? "LIQUID_NUMBERS_ON" : "LIQUID_NUMBERS_OFF");
    }
    if (rampArrowsBtn) {
      rampArrowsBtn.classList.toggle("on", displayToggles.rampArrows);
      setDisplayToggleSprite(rampArrowsBtn,
        displayToggles.rampArrows ? "RAMP_ARROWS_ON" : "RAMP_ARROWS_OFF");
    }
  }
  function setDisplayToggle(key, on) {
    displayToggles = { ...displayToggles, [key]: !!on };
    persistDisplayToggles();
    refreshDisplayToggleButtons();
    if (window.DwfTiles && typeof window.DwfTiles.setDisplayToggles === "function")
      window.DwfTiles.setDisplayToggles({ ...displayToggles });
  }
  if (liquidNumbersBtn) liquidNumbersBtn.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation();
    setDisplayToggle("liquidNumbers", !displayToggles.liquidNumbers);
    focusPage();
  });
  if (rampArrowsBtn) rampArrowsBtn.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation();
    setDisplayToggle("rampArrows", !displayToggles.rampArrows);
    focusPage();
  });
  refreshDisplayToggleButtons();
  if (window.DwfTiles && typeof window.DwfTiles.setDisplayToggles === "function")
    window.DwfTiles.setDisplayToggles({ ...displayToggles });

  // --- WD-6: z scrollbar along the map's right edge -- drag/click sets the absolute
  // camera z via the existing `/camera?z=` param; two ticks (surface, camera) per the
  // acceptance ("marker ticks at surface + camera z"); sky/ground/underground shading is
  // explicitly not required by the spec.
  const zScrollbar = document.getElementById("zScrollbar");
  const zScrollTrack = document.getElementById("zScrollTrack");
  const zScrollSurfaceTick = document.getElementById("zScrollSurfaceTick");
  const zScrollCamMarker = document.getElementById("zScrollCamMarker");
  function zFracFromClientY(clientY) {
    const rect = zScrollTrack.getBoundingClientRect();
    if (!rect.height) return 0;
    return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  }
  function fracFromZ(z, maxZ) {
    if (maxZ <= 0) return 0;
    return 1 - Math.max(0, Math.min(maxZ, z)) / maxZ;
  }
  let zbMaxZ = 1;   // WT02: latest max-z (from hud.map.z), reused when the roster (not /hud) drives a repaint
  function renderZScrollbar(hud) {
    if (!zScrollTrack) return;
    const maxZ = Math.max(1, (hud.map?.z || 1) - 1);
    zbMaxZ = maxZ;
    const camZ = hud.camera?.z ?? 0;
    const surfZ = hud.minimap?.surfaceZ ?? camZ;
    if (zScrollCamMarker) zScrollCamMarker.style.top = `${(fracFromZ(camZ, maxZ) * 100).toFixed(2)}%`;
    if (zScrollSurfaceTick) zScrollSurfaceTick.style.top = `${(fracFromZ(surfZ, maxZ) * 100).toFixed(2)}%`;
    zScrollbar.dataset.maxZ = String(maxZ);
    renderOtherElevations();   // repaint other players' triangles against the fresh maxZ
  }

  // WT02 (spec §3): one colored triangle per OTHER player on the existing elevation bar, at
  // their camera z (roster `camz`, present even for idle players -- this is the roster-not-cursor
  // change). Own marker is recolored to own playerColor (Q6 default) + keeps its larger size +
  // shadow = the "emphasized" affordance. Triangles hang off the LEFT edge pointing inward, in
  // playerColor(name); name + z on hover; within-6px collisions stagger 3px/each (name-sorted,
  // deterministic) so stacked players stay hit-testable. Disconnected players fall out of the
  // roster -> their triangle is removed on the next repaint (<=1s via the /hud pass).
  function renderOtherElevations() {
    if (!zScrollTrack) return;
    try {
      const P = window.DwfPresence;
      const roster = (P && Array.isArray(P.roster)) ? P.roster : [];
      const colorOf = (window.DwfTiles && typeof DwfTiles.playerColor === "function")
        ? DwfTiles.playerColor : null;
      // Own marker recolor (Q6): red "you" triangle -> own playerColor.
      if (zScrollCamMarker && colorOf) {
        const me = roster.find(p => p && p.self);
        const myName = me ? me.name : (typeof player !== "undefined" ? player : null);
        if (myName) zScrollCamMarker.style.borderTopColor = colorOf(myName).fill;
      }
      // Rebuild the other-player triangles (few players; a full rebuild is cheapest + leak-free).
      zScrollTrack.querySelectorAll(".z-other-marker").forEach(el => el.remove());
      const maxZ = zbMaxZ;
      const trackH = zScrollTrack.getBoundingClientRect().height || 0;
      const others = roster
        .filter(p => p && !p.self && typeof p.camz === "number")
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const placedPx = [];
      for (const p of others) {
        const frac = Math.max(0, Math.min(1, fracFromZ(p.camz, maxZ)));   // clamp inside the track
        const topPx = frac * trackH;
        let collisions = 0;
        for (const y of placedPx) if (Math.abs(y - topPx) < 6) collisions++;
        placedPx.push(topPx);
        const tri = document.createElement("div");
        tri.className = "z-other-marker";
        tri.style.top = `${(frac * 100).toFixed(2)}%`;
        tri.style.left = `${collisions * 3}px`;
        if (colorOf) tri.style.borderLeftColor = colorOf(p.name).fill;
        // Tooltip shows the anonymized display name (raw session keys -> "Guest 1665") via
        // dwf-lobby.js's ONE canonical helper, matching the cursor label / minimap chip; p.name
        // stays the raw roster key for color + the fracFromZ lookup.
        const triName = (window.DwfLobby && typeof DwfLobby.displayName === "function")
          ? DwfLobby.displayName(p.name).text : String(p.name == null ? "" : p.name);
        tri.title = `${triName} — z ${p.camz}`;
        zScrollTrack.appendChild(tri);
      }
    } catch (_) { /* elevation triangles are best-effort overlay */ }
  }
  function setZFromScrollbarEvent(event) {
    if (!currentHud) return;
    const maxZ = Number(zScrollbar.dataset.maxZ || ((currentHud.map?.z || 1) - 1));
    const frac = zFracFromClientY(event.clientY);
    const z = Math.round((1 - frac) * maxZ);
    resetPanPrediction();
    fetch(`/camera?player=${encodeURIComponent(player)}&z=${z}`, { method: "POST", cache: "no-store" })
      .then(loadHud).catch(() => {});
  }
  if (zScrollbar) {
    let zDragging = false;
    zScrollbar.addEventListener("pointerdown", event => {
      event.preventDefault();
      event.stopPropagation();
      zDragging = true;
      zScrollbar.setPointerCapture(event.pointerId);
      setZFromScrollbarEvent(event);
      focusPage();
    });
    zScrollbar.addEventListener("pointermove", event => {
      if (!zDragging) return;
      setZFromScrollbarEvent(event);
    });
    const endZDrag = event => { zDragging = false; try { zScrollbar.releasePointerCapture(event.pointerId); } catch (_) {} };
    zScrollbar.addEventListener("pointerup", endZDrag);
    zScrollbar.addEventListener("pointercancel", endZDrag);
  }
  // WT02: repaint the other-player triangles on roster change, throttled to ~4 Hz (the roster
  // arrives at the ~30 Hz AUX rate). maxZ still comes from the /hud pass's renderZScrollbar.
  if (window.DwfPresence && typeof window.DwfPresence.onChange === "function") {
    let zbThrottle = 0;
    window.DwfPresence.onChange(() => {
      const now = Date.now();
      if (now - zbThrottle < 250) return;
      zbThrottle = now;
      renderOtherElevations();
    });
  }

  async function inspectClick(event) {
    const pixel = imagePixelFromEvent(event);
    if (!pixel) return;
    try {
      const url = `/inspect?player=${encodeURIComponent(player)}&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("inspect failed");
      const data = await response.json();
      // B24: the lower-left coordinates/name box for bare-terrain clicks was a browser-only
      // invention ("not a DF feature" -- The owner); DF does nothing when you click empty ground
      // (the top hover strip already reports what's on the tile). Only the click-throughs DF
      // itself has still open their real panels/sheets.
      const kind = String(data.kind || "").toLowerCase();
      // Engravings are tile properties, including solid WALL tiles. /inspect has already resolved
      // the clicked screen cell to that exact world tile; admitting the kind here is what lets the
      // existing showSelection -> openEngravingPanel dispatch run. The old filter silently returned
      // for kind:"engraving", which made every engraved wall look unclickable.
      const panelKinds = { workshop: 1, unit: 1, stockpile: 1, building: 1, item: 1, zone: 1,
                           engraving: 1 };
      if (!panelKinds[kind]) return;
      // B64: when the cache can identify more than one occupant, the loaded tile-list module
      // takes this inspect result and presents the native-style chooser. Older cached clients
      // (or a single occupant) retain the existing selection path unchanged.
      if (window.DFTileList && typeof window.DFTileList.consumeInspect === "function" &&
          window.DFTileList.consumeInspect(data, pixel)) return;
      showSelection(data);
    } catch (_) {
      // B24: failure to inspect a tile is also silent -- no "Nothing selected" box (DF-parity).
    }
  }

  // --- DF-style toolbar sprites and designation menu ---
  // WD-12: stockPreset is now just a boolean "new-pile rect/free paint armed" flag (no
  // longer a category key -- see the stockpile placement section below for the full
  // paint-first rewrite). stockRepaintId is unchanged (existing-pile repaint, armed from a
  // stockpile detail panel's "Repaint" button).
  let stockPreset = null;
  let stockRepaintId = null;
  // Native stockpile repaint session (same staged shape as the zone one below): edits are held
  // in an exact per-world-tile draft and committed only by Accept, as ONE mode=replace bitmap to
  // /stockpile-repaint. The base footprint comes from /stockpile-info's extents bitmap, so an
  // existing interior hole survives the round trip honestly.
  let stockRepaintMeta = null;        // {label}: session heading for the selected pile
  let stockRepaintDraft = null;       // {zone:{x,y,z,w,h,extents}, changes: Map<string,bool>}
  let stockRepaintFreeCells = null;   // per-drag free-paint stroke cells, or null when idle
  let stockRepaintFreeLast = null;
  let stockRepaintEraseArmed = false; // session erase tool (distinct from stockEraseArmed below,
  let stockRepaintRemoveArmed = false;// which drives the new-pile submenu's immediate trim)
  // B117: an existing zone armed for extend-paint from its detail panel's "Repaint area" button
  // (the zone-panel parallel of stockRepaintId). A following map drag paints a rect that
  // /zone-repaint (mode=add) merges into this zone's footprint. null = not armed.
  let zoneRepaintId = null;
  let zoneRepaintMeta = null;    // {label}: native repaint-session heading for the selected zone
  // Exact pending world-tile edits. The source zone remains untouched until Accept; each map
  // entry is the desired final membership for "worldX,worldY", so mixed add/erase strokes and
  // an interior hole are representable without flattening the shape to a bounding rectangle.
  let zoneRepaintDraft = null;   // {zone, changes: Map<string,bool>}, committed only by Accept
  let zoneRepaintFreeCells = null;
  let zoneRepaintFreeLast = null;
  // WD-12 paint-first submenu state (07-stockpile-mode.png / 07b-stockpile-paint.png):
  // stockMode is null (closed), "menu" (entry stage -- just the "+ new" button; a plain map
  // click still falls through to inspectClick so existing piles stay click-through to their
  // detail panel), or "paint" (the 4-tool row + the floating Accept dialog are shown).
  let stockMode = null;
  let stockEraseArmed = false;  // erase tool armed: drag re-paints (trims) an EXISTING pile
  let stockRemoveArmed = false; // remove-existing tool armed: click a pile to delete it
  let stockPileId = -1;         // id of the in-progress NEW pile this paint session, or -1
  let stockPileBBox = null;     // running world-tile bbox {x1,y1,x2,y2} painted so far
  let stockFreeBBox = null;     // bbox accumulated during one in-progress free-paint drag
  // WD-14: zone paint-first state, same shape as stockMode above (08-zones.png). zoneMode is
  // null (closed), "menu" (type grid open, no type armed -- plain clicks fall through to the
  // overlap-cycling / inspectClick path below so existing zones stay click-through, DF's
  // "existing-zones context") or "paint" (a type is armed: rect/free paint + erase +
  // remove-existing are live, the floating Accept dialog shows). zonePreset is the armed type
  // key. NEW-zone paint still accumulates a union bbox CLIENT-side (zonePaintBBox) and submits ONE
  // POST /zone on Accept (a deliberate create-once flow: for a contiguous paint it is exact). The
  // /zone-repaint route that grows/trims an EXISTING zone landed later (src/building_zone.cpp:2338+,
  // registered 2423-2424, mode=add|erase) and is what the detail-panel extend (repaintZoneDrag) and
  // erase-paint (zoneEraseDrag) drive; a host DLL older than that route degrades gracefully (no
  // response -> one honest status line, never a crash or a silent no-op).
  let zonePreset = null;
  let zoneMode = null;
  let zoneEraseArmed = false;    // erase tool armed: drag trims an EXISTING zone (/zone-repaint mode=erase)
  let zoneRemoveArmed = false;   // remove-existing tool armed: click a zone to delete it
  let zonePaintBBox = null;      // union world-tile bbox painted so far this session
  let zonePaintPreview = null;   // live + retained grid rect rendered by core's shared overlay
  let zoneFreeBBox = null;       // bbox accumulated during one in-progress free-paint drag
  // WD-13: burrow paint mode (09-burrows.png). burrowMode is null (closed) or "open" (the
  // full-height left panel is visible); burrowPaintId is the burrow armed for tile painting
  // (>= 0 once "Add new burrow" or an existing row's paint button is clicked);
  // burrowEraseArmed flips /burrow-paint between mode=add and mode=erase. DF ships no
  // distinct burrow-erase icon in interface_map.json -- the generic BUTTON_DES_ERASE glyph
  // is reused, a documented substitution same convention as WD-8.2's stair-split.
  let burrowMode = null;
  let burrowPaintId = -1;
  let burrowEraseArmed = false;
  let burrowFreeCells = null;    // per-drag dedup set for burrow free-paint, or null when idle
  let burrowFreeLast = null;
  // WD-30: squad "Move" order is map-click driven, like zoneRemoveArmed/stockRemoveArmed --
  // squadMoveArmed holds the squad id while armed (-1 = not armed); the squads sidebar (a
  // DF-chrome window, not one of the placement "modes" above) arms/disarms it directly via
  // window.DFSquadMove, so it does NOT participate in updateToolCursor's mutual-exclusion
  // auto-close (the sidebar stays open while you click the map, matching DF's own flow).
  let squadMoveArmed = -1;
  // Kill follows the native two-step order flow: inspect one map unit, then let the squad panel
  // submit its existing target=<unit id> request only after the user confirms it.
  let squadKillArmed = -1;
  // Patrol stays armed across map clicks; every click sends a world coordinate back to the
  // route editor, which owns Confirm/Cancel and the persistent POST.
  let squadPatrolArmed = -1;
  // B174 links flow (B171 oracles): the workshop links side window arms a map-click stockpile
  // pick -- { ws, mode: 'give'|'take' } while armed, null otherwise. Like squad-kill, a pick
  // does NOT disarm (several piles can be linked in a row); the side window's Done/toggle
  // disarms through window.DFWsLink. The panel owns the /stockpile-link POST via onPick.
  let wsLinkArmed = null;
  // B223 CHAT PING TARGETING (WT10's original intent, restored). The chat composer's ping button
  // no longer stamps the CAMERA into the composer -- it ARMS a one-shot map pick, exactly the
  // shape wsLinkArmed above uses: a boolean armed flag, a crosshair via updateToolCursor(), a
  // click resolved through the SAME /inspect pipeline squad-kill/ws-link use, and a consumer
  // (dwf-chat.js) that owns the outcome through window.DFChatPing.onPick.
  //
  // Two deliberate differences from wsLink, both of them the bug report:
  //   * SINGLE-SHOT. chatPingClick() disarms BEFORE it awaits, so an in-flight /inspect can never
  //     leave the mode wedged, and a second click cannot queue a second ping.
  //   * LAST IN THE DISPATCH CHAIN (below `currentTool`). A ping is the lowest-stakes pick in the
  //     client; if a designation tool is somehow also armed, the designation wins and the ping is
  //     simply not consumed. It stays armed and is still cancellable (Esc / the button).
  // A click that lands on a PANEL never reaches #view at all, so it is IGNORED (the mode stays
  // armed). That is the documented choice: chat itself is a panel, and a mode that self-cancelled
  // on any UI click could not survive the player scrolling the chat log before picking.
  let chatPingArmed = false;
  // WD-29: hauling routes mode (10-hauling.png). Same full-height LEFT panel shape as
  // burrows (WD-13) above -- haulingMode is null (closed) or "open"; haulingStopArmedRoute
  // (>= 0) is the route currently accepting single-tile "add stop" clicks (stays armed across
  // multiple clicks, like burrowPaintId, until "Done placing stops" is clicked).
  let haulingMode = null;
  let haulingStopArmedRoute = -1;
  let currentTool = null; // backend-supported paint tool, or null for inspect/pan mode
  let selectedDesignation = null; // visual selection, including tools not wired yet
  // B193: pending first corner of a two-click rectangle designation (ALL rect designation tools
  // since B193; the name predates that -- stairs pioneered the gesture in B58/B106).
  let stairRangeStart = null;
  // B196: client coords of the cursor while a two-click anchor is armed but no button is held,
  // so a mid-flow Shift+wheel z-change can re-extend the pending preview from the last hovered
  // tile without waiting for the next pointermove.
  let twoClickCursor = null;
  let digMenuOpen = false;
  let plantMenuOpen = false;
  let smoothMenuOpen = false;
  // WD-10: item/building designations submenu (claim/forbid/dump/undump/melt/unmelt/hide/unhide).
  let itemDesigMenuOpen = false;
  // Dig-menu options (DF parity): priority 1-7 (default 4), marker mode, dig-through-warm/damp,
  // mine mode (0=all,1=automine,2=ore,3=gems), and whether the advanced options are expanded.
  let digPriority = 4;
  let markerMode = false;
  let warmDampMode = false;
  let digMineMode = 0;
  let digAdvOpen = false;
  // WD-9: unlike dig, DF's own chop/gather/smooth captures (02/03/04) show the priority row
  // already visible (no click needed) -- these two default open instead of collapsed.
  let plantAdvOpen = true;
  let smoothAdvOpen = true;
  // WD-8.4: paint mode for the dig submenu -- "rect" (drag two corners, DF's default,
  // existing designateDrag behavior) or "free" (paint every tile the drag passes over,
  // like a brush). Free-paint sends per-cell 1x1 /designate calls (no endpoint change).
  let paintMode = "rect";
  let trafficLevel = "high";
  function placementActive() {
    return !!(currentTool || selectedDesignation || stockPreset || stockRepaintId ||
              zoneRepaintId || stockEraseArmed || stockRemoveArmed || bipSelBuild() || zonePreset ||
              zoneEraseArmed || zoneRemoveArmed || (burrowPaintId >= 0) ||
              (haulingStopArmedRoute >= 0) || squadMoveArmed >= 0 || squadKillArmed >= 0 || squadPatrolArmed >= 0 ||
              !!wsLinkArmed);
  }
  let lastPlacementActive = null;
  function updatePlacementMode() {
    // Tell the backend whether this player has any placement tool active, so their captured
    // frames get DF's designation grid painted in. selectedDesignation covers visually-selected
    // tools (chop/gather/smooth) that aren't backend paint tools yet -- the grid should still show.
    const active = placementActive();
    if (active === lastPlacementActive) return;
    lastPlacementActive = active;
    fetch(`/placement-mode?player=${encodeURIComponent(player)}&mode=${active ? "dig" : "none"}`,
          { method: "POST", cache: "no-store" }).catch(() => {});
    if (!active) sendPlacementUi(-1, -1, 0, 0, false, 0, 0); // clear cursor/rect on deselect
  }
  // Send the player's hover tile (and drag anchor while dragging) so the backend paints the
  // cursor / rectangle preview into this player's interface layer. Throttled.
  let lastUiSend = 0;
  function sendPlacementUi(hx, hy, w, h, drag, dx, dy, force) {
    const now = performance.now();
    if (!force && now - lastUiSend < 55) return;
    lastUiSend = now;
    // A selected building carries its footprint size; the backend previews the whole footprint
    // (e.g. 3x3 workshop) centered on the cursor instead of a single tile.
    const bw = (bipSelBuild() && bipSelBuild().size && bipSelBuild().size.w) || 0;
    const bh = (bipSelBuild() && bipSelBuild().size && bipSelBuild().size.h) || 0;
    const q = `player=${encodeURIComponent(player)}&hx=${hx}&hy=${hy}&w=${w}&h=${h}` +
              `&drag=${drag ? 1 : 0}&dx=${dx}&dy=${dy}&bw=${bw}&bh=${bh}`;
    fetch(`/placement-cursor?${q}`, { method: "POST", cache: "no-store" }).catch(() => {});
  }
  // -drag1 (owner regression report 2026-07-16): B193's two-click conversion silently STOPPED
  // broadcasting the in-progress designation box. Pre-B193 the held drag sent
  // sendPlacementUi(..., drag=1, anchor) on every move, the server relayed it in world coords
  // (http_server.cpp presence_json's drag/dx/dy), and both renderers drew the growing
  // rectangle for everyone else (dwf-tiles.js drawPresence, dwf-gl.js emitPresence). B193
  // downgraded every rect-designation presence send to a bare cursor (drag=0) and gave the new
  // rubber band no presence send at all, so remote players saw the cursor + committed tiles
  // but never the live box. This helper restores the broadcast over the SAME wire fields:
  // while a two-click anchor is armed, presence carries drag=1 plus the armed-footprint corner
  // FARTHEST from the cursor (window-grid coords, clamped into the window because the server
  // drops negative drag indices -- presence_json requires drag_px/py >= 0), so bbox(cursor,
  // corner) spans exactly the rubber-banded box other players should watch grow. Unarmed it
  // degrades to the plain presence cursor B193 left behind. The broadcast clears through the
  // existing paths: pointerup's forced drag=0 on commit, the Esc back-out's forced clear
  // (added with this helper), pointerleave's forced clear, updatePlacementMode's deselect clear.
  function sendTwoClickPresence(cur, force) {
    if (!cur) return;
    const rendered = twoClickArmed() && (typeof renderedImageRect === "function")
      ? renderedImageRect() : null;
    if (!rendered || !stairRangeStart) {
      sendPlacementUi(cur.x, cur.y, cur.w, cur.h, false, 0, 0, force);
      return;
    }
    const ox = Number(rendered.ox), oy = Number(rendered.oy);
    const cwx = ox + cur.x, cwy = oy + cur.y;               // cursor in world coords
    const a = stairRangeStart;
    const awx = Math.abs(cwx - a.x1) >= Math.abs(cwx - a.x2) ? a.x1 : a.x2;
    const awy = Math.abs(cwy - a.y1) >= Math.abs(cwy - a.y2) ? a.y1 : a.y2;
    const ax = Math.max(0, Math.min(cur.w - 1, awx - ox));
    const ay = Math.max(0, Math.min(cur.h - 1, awy - oy));
    sendPlacementUi(cur.x, cur.y, cur.w, cur.h, true, ax, ay, force);
  }
  function updateToolCursor() {
    // WD-12: entering any OTHER placement tool auto-closes stockpile mode. The other
    // families (dig/plant/smooth/build/zone) already funnel every mutual-exclusion reset
    // through this function (selectDesignation -> updateDesignationButtons -> here;
    // selectBuildItem and setZonePreset call it directly) -- stockMode has no reset hook in
    // those other files, so it's driven from the one function they all already call on the
    // way out instead.
    if (stockMode && (currentTool || selectedDesignation || bipSelBuild() || zonePreset)) {
      closeStockMode();
    }
    // WD-13/WD-14: same one-way auto-close for zone/burrow modes when any OTHER placement
    // tool activates (selectBuildItem, in build-info-panels.js outside this item's territory,
    // has no reset hook for these modes either -- driven from here, the one function every
    // entry point already calls, exactly like stockMode above).
    if (zoneMode && (currentTool || selectedDesignation || bipSelBuild() || stockMode ||
                     stockRepaintId)) {
      closeZoneMode();
    }
    if (burrowMode && (currentTool || selectedDesignation || bipSelBuild() || stockMode ||
                       stockRepaintId || zoneMode || haulingMode)) {
      closeBurrowMode();
    }
    // WD-29: hauling mode closes for the same reasons burrow mode does above, plus entering
    // burrow mode itself (the two full-height left panels are mutually exclusive).
    if (haulingMode && (currentTool || selectedDesignation || bipSelBuild() || stockMode ||
                        stockRepaintId || zoneMode || burrowMode)) {
      closeHaulingMode();
    }
    view.style.cursor = (currentTool || stockPreset || stockRepaintId || zoneRepaintId || stockEraseArmed ||
                          stockRemoveArmed || bipSelBuild() || zonePreset || zoneEraseArmed ||
                          zoneRemoveArmed || burrowPaintId >= 0 || squadMoveArmed >= 0 || squadKillArmed >= 0 || squadPatrolArmed >= 0 ||
                          haulingStopArmedRoute >= 0 || wsLinkArmed || chatPingArmed) ? "crosshair" : "";
    updatePlacementMode();
  }
  // WD-3/WD-4: blit via the DFChrome helper (dwf-chrome.js) + interface_map.json
  // instead of the old hardcoded per-cell pixel table. SPRITE_TOKENS below is
  // verified cell-for-cell against tools/ws2/build_interface_map.py's output --
  // every button in the bottom toolbar is now a real DF BUTTON_*_INACTIVE/
  // _ACTIVE (or single-state) composite token.
  // WD-4 finding (supersedes the WD-3-era comment that used to be here): the
  // info-window cluster (citizens/tasks/places/labor/workorders/nobles/
  // objects/justice) + squads/world + stockpile DO resolve to real tokens --
  // BUTTON_INFO_CREATURES/_TASKS/_PLACES/_LABOR/_WORK_ORDERS/_NOBLES/_OBJECTS/
  // _JUSTICE (+ _ACTIVE pairs), BUTTON_SQUADS, BUTTON_WORLD,
  // BUTTON_STOCKPILE_INACTIVE/_ACTIVE. WD-3's generator only parsed
  // `[TILE_GRAPHICS:...]` lines; these 742 tokens are bound via the separate
  // `[TILE_GRAPHICS_RECTANGLE:page:col:row:w:h:TOKEN]` grammar the generator's
  // regex never matched (fixed in tools/ws2/build_interface_map.py this
  // session -- see its module docstring shape (e)). The raw sheet-cell pixel
  // coordinates the pre-WD-3 table hardcoded for this cluster were, it turns
  // out, already pixel-identical to these real tokens (independently
  // reverse-engineered correctly) -- so nothing LOOKED wrong, but the
  // SPRITE_FALLBACK_CELLS indirection this comment used to describe is now
  // gone in favor of real token names, and every info-window button now also
  // gets its real _ACTIVE highlight art (only justice had one before).
  // Historical inventory retained temporarily for diff archaeology only; the live controller and
  // Parity Studio both consume DwfControlShell.SPRITE_TOKENS below.
  const LEGACY_SPRITE_TOKENS = {
    lowerMenu:{normal:"BUTTON_LOWER_MENU"},
    digMenu:{normal:"BUTTON_DIG"},
    dig:{normal:"BUTTON_DIG_DIG_INACTIVE", active:"BUTTON_DIG_DIG_ACTIVE"},
    // Native DF has one stairs tool. The range request chooses Up/Down/UpDown per z level.
    stairs:{normal:"BUTTON_DIG_STAIRS_INACTIVE", active:"BUTTON_DIG_STAIRS_ACTIVE"},
    ramp:{normal:"BUTTON_DIG_RAMP_INACTIVE", active:"BUTTON_DIG_RAMP_ACTIVE"},
    channel:{normal:"BUTTON_DIG_CHANNEL_INACTIVE", active:"BUTTON_DIG_CHANNEL_ACTIVE"},
    remove:{normal:"BUTTON_DIG_REMOVE_STAIRS_RAMPS_INACTIVE", active:"BUTTON_DIG_REMOVE_STAIRS_RAMPS_ACTIVE"},
    chop:{normal:"BUTTON_DES_CHOP_INACTIVE", active:"BUTTON_DES_CHOP_ACTIVE"},
    gather:{normal:"BUTTON_DES_GATHER_INACTIVE", active:"BUTTON_DES_GATHER_ACTIVE"},
    smooth:{normal:"BUTTON_DES_SMOOTH_INACTIVE", active:"BUTTON_DES_SMOOTH_ACTIVE"},
    engrave:{normal:"BUTTON_DES_SMOOTH_ENGRAVE_INACTIVE", active:"BUTTON_DES_SMOOTH_ENGRAVE_ACTIVE"},
    track:{normal:"BUTTON_DES_SMOOTH_TRACK_INACTIVE", active:"BUTTON_DES_SMOOTH_TRACK_ACTIVE"},
    fortify:{normal:"BUTTON_DES_SMOOTH_FORTIFY_INACTIVE", active:"BUTTON_DES_SMOOTH_FORTIFY_ACTIVE"},
    erase:{normal:"BUTTON_DES_ERASE", active:"BUTTON_DES_ERASE"},
    build:{normal:"BUTTON_BUILDING_INACTIVE", active:"BUTTON_BUILDING_ACTIVE"},
    zone:{normal:"BUTTON_ZONE_INACTIVE", active:"BUTTON_ZONE_ACTIVE"},
    stockpile:{normal:"BUTTON_STOCKPILE_INACTIVE", active:"BUTTON_STOCKPILE_ACTIVE"},
    // Bottom-LEFT info-window openers (order per 00-base-map.png / audit §2).
    citizens:{normal:"BUTTON_INFO_CREATURES", active:"BUTTON_INFO_CREATURES_ACTIVE"},
    orders:{normal:"BUTTON_INFO_TASKS", active:"BUTTON_INFO_TASKS_ACTIVE"},
    locations:{normal:"BUTTON_INFO_PLACES", active:"BUTTON_INFO_PLACES_ACTIVE"},
    labor:{normal:"BUTTON_INFO_LABOR", active:"BUTTON_INFO_LABOR_ACTIVE"},
    workorders:{normal:"BUTTON_INFO_WORK_ORDERS", active:"BUTTON_INFO_WORK_ORDERS_ACTIVE"},
    nobles:{normal:"BUTTON_INFO_NOBLES", active:"BUTTON_INFO_NOBLES_ACTIVE"},
    objects:{normal:"BUTTON_INFO_OBJECTS", active:"BUTTON_INFO_OBJECTS_ACTIVE"},
    justice:{normal:"BUTTON_INFO_JUSTICE", active:"BUTTON_INFO_JUSTICE_ACTIVE"},
    // Bottom-RIGHT (no _ACTIVE token in the raws for either -- these two open
    // their own screen rather than toggling a persistent mode, so DF doesn't
    // ship a pressed-state variant; the CSS .active border still applies).
    squads:{normal:"BUTTON_SQUADS"},
    worldmap:{normal:"BUTTON_WORLD"},
    // Bottom-CENTER "modes" + item/building-designations groups (WD-4 new).
    burrow:{normal:"BUTTON_BURROW_INACTIVE", active:"BUTTON_BURROW_ACTIVE"},
    hauling:{normal:"BUTTON_HAULING_INACTIVE", active:"BUTTON_HAULING_ACTIVE"},
    traffic:{normal:"BUTTON_DES_TRAFFIC", active:"BUTTON_DES_TRAFFIC"},
    itemdesig:{normal:"BUTTON_DES_ITEM_BUILDING", active:"BUTTON_DES_ITEM_BUILDING"},
    // WD-8.1/8.4: base-row paint-mode pair (rectangle-corners vs free-hand paint).
    paintRect:{normal:"BUTTON_PAINT_RECTANGLE_INACTIVE", active:"BUTTON_PAINT_RECTANGLE_ACTIVE"},
    paintFree:{normal:"BUTTON_FREE_PAINT_INACTIVE", active:"BUTTON_FREE_PAINT_ACTIVE"},
    // WD-8.3: the marker toggle (big blueprint plate) + convert-to-marker/-standard
    // trio (01b-dig-expanded.png right end).
    markerToggle:{normal:"BUTTON_DES_BLUEPRINT_INACTIVE", active:"BUTTON_DES_BLUEPRINT_ACTIVE"},
    convertmarker:{normal:"BUTTON_DES_TO_BLUEPRINT_INACTIVE", active:"BUTTON_DES_TO_BLUEPRINT_ACTIVE"},
    convertstandard:{normal:"BUTTON_DES_FROM_BLUEPRINT_INACTIVE", active:"BUTTON_DES_FROM_BLUEPRINT_ACTIVE"},
    // WD-10: item/building designations 8-mode submenu (12-item-designations.png order).
    // Real DF tokens (interface_map.json) -- note DF's own verbs are claim/forbid/dump/
    // undump/melt/unmelt/hide/unhide, not the spec prose's "no-dump"/"no-melt"/"visible"
    // shorthand, so those are the wire tool= values this item sends (see backendToolFor).
    claim:{normal:"BUTTON_DES_CLAIM_INACTIVE", active:"BUTTON_DES_CLAIM_ACTIVE"},
    forbid:{normal:"BUTTON_DES_FORBID_INACTIVE", active:"BUTTON_DES_FORBID_ACTIVE"},
    dump:{normal:"BUTTON_DES_DUMP_INACTIVE", active:"BUTTON_DES_DUMP_ACTIVE"},
    undump:{normal:"BUTTON_DES_UNDUMP_INACTIVE", active:"BUTTON_DES_UNDUMP_ACTIVE"},
    melt:{normal:"BUTTON_DES_MELT_INACTIVE", active:"BUTTON_DES_MELT_ACTIVE"},
    unmelt:{normal:"BUTTON_DES_UNMELT_INACTIVE", active:"BUTTON_DES_UNMELT_ACTIVE"},
    unhide:{normal:"BUTTON_DES_UNHIDE_INACTIVE", active:"BUTTON_DES_UNHIDE_ACTIVE"},
    hide:{normal:"BUTTON_DES_HIDE_INACTIVE", active:"BUTTON_DES_HIDE_ACTIVE"},
    // WD-12: stockpile paint-first submenu (07-stockpile-mode.png entry "+" / 07b-stockpile-
    // paint.png's 4-tool row -- paintRect/paintFree above are reused as-is). Real tokens
    // verified against interface_map.json: BUTTON_STOCKPILE_NEW (single-state, the "+" over a
    // goods stack), STOCKPILE_ERASE_ACTIVE/_INACTIVE (the eraser icon), STOCKPILE_REMOVE_
    // EXISTING (single-state -- same cell as BUTTON_STOCKPILE_REMOVE, the red no-entry-over-
    // stack icon; DF ships no separate active variant for it either).
    stockNew:{normal:"BUTTON_STOCKPILE_NEW"},
    stockErase:{normal:"STOCKPILE_ERASE_INACTIVE", active:"STOCKPILE_ERASE_ACTIVE"},
    stockRemoveExisting:{normal:"STOCKPILE_REMOVE_EXISTING"},
    // WD-14: zone paint-first submenu (08-zones.png entry grid; paintRect/paintFree above are
    // reused as-is for the rect/free pair). Real tokens verified against interface_map.json:
    // ZONE_ERASE_ACTIVE/_INACTIVE, ZONE_REMOVE_EXISTING (single-state), ZONE_REPAINT (used on
    // the detail panel's "Repaint" button, dwf-building-zone-stockpile-panels.js), and
    // ZONE_PREVIOUS/ZONE_NEXT for the overlap-cycling pair when a clicked tile has >1 zone.
    zoneErase:{normal:"ZONE_ERASE_INACTIVE", active:"ZONE_ERASE_ACTIVE"},
    zoneRemoveExisting:{normal:"ZONE_REMOVE_EXISTING"},
    zoneRepaint:{normal:"ZONE_REPAINT"},
    zonePrevious:{normal:"ZONE_PREVIOUS"},
    zoneNext:{normal:"ZONE_NEXT"},
    // WD-13: burrow left panel (09-burrows.png). BURROW_REPAINT is unused for now (no
    // per-burrow "Repaint" affordance in the empty-list capture to restyle against); erase
    // reuses the generic designation-erase glyph (see the burrowEraseArmed comment above).
    burrowErase:{normal:"BUTTON_DES_ERASE", active:"BUTTON_DES_ERASE"},
    burrowSuspend:{normal:"BURROW_SUSPEND_INACTIVE", active:"BURROW_SUSPEND_ACTIVE"},
    burrowDelete:{normal:"BURROW_DELETE"},
    burrowRepaint:{normal:"BURROW_REPAINT"},                                    // B230 symbol picker
    burrowWorkshopsAll:{normal:"BURROW_WORKSHOPS_EVERYWHERE", active:"BURROW_WORKSHOPS_EVERYWHERE"},
    burrowWorkshopsOnly:{normal:"BURROW_WORKSHOPS_BURROW_ONLY", active:"BURROW_WORKSHOPS_BURROW_ONLY"},
    burrowAddUnit:{normal:"BURROW_ADD_UNIT"}
  };
  const SPRITE_TOKENS = window.DwfControlShell.SPRITE_TOKENS;
  // Semantic control-shell keys for the tiles whose selected state now lives in a DF _ACTIVE sprite.
  const DIG_MODE_SPRITES = ["digModeAll", "digModeAuto", "digModeOre", "digModeGem"];
  const TRAFFIC_SPRITES = { high:"trafficHigh", normal:"trafficNormal", low:"trafficLow", restricted:"trafficRestricted" };
  let submenuAlignmentScheduled = false;
  function paintSprite(button, key, active = false) {
    const painted = window.DwfControlShell.paintSprite(button, key, active);
    if (!submenuAlignmentScheduled) {
      submenuAlignmentScheduled = true;
      requestAnimationFrame(() => {
        submenuAlignmentScheduled = false;
        window.DwfControlShell.alignControlSubmenus(document);
      });
    }
    return painted;
  }
  const TBICON = {
    citizens:"citizens", labor:"labor", locations:"locations", orders:"orders",
    workorders:"workorders", nobles:"nobles", objects:"objects", justice:"justice",
    build:"build", stockpile:"stockpile", zone:"zone", squads:"squads", worldmap:"worldmap"
  };
  // Native replaces the ACTIVE toolbar button's art with the yellow down-arrow (BUTTON_LOWER_MENU)
  // for EVERY mode that opens a submenu -- verified by A/B against 00-base-map.png:
  //   07b-stockpile-paint.png (stockpile), 08-zones.png (zone), 09-burrows.png (burrow),
  //   10-hauling.png (hauling), 11-traffic.png (traffic).
  // dig/chop/gather/smooth/itemdesig already did this in updateDesignationButtons(); these five did
  // not, so half the toolbar told the player "a menu is open below" and half did not.
  function submenuOpenFor(key) {
    if (key === "stockpile") return !!stockMode;
    if (key === "zone") return !!zoneMode;
    return false;
  }
  let toolbarActiveName = "";
  function refreshToolbarSprites(activeName = "") {
    toolbarActiveName = activeName || "";
    repaintToolbarSprites();
  }
  // The mode flags flip AFTER setActiveToolbar() has already run (openPanel calls it first), so the
  // lowered-menu art has to be repaintable without re-deciding which panel is active.
  function repaintToolbarSprites() {
    document.querySelectorAll("#bottomBar [data-panel], #bottomBar [data-action]").forEach(button => {
      const key = button.dataset.panel || button.dataset.action;
      if (!TBICON[key]) return;
      const lowered = submenuOpenFor(key);
      paintSprite(button, lowered ? "lowerMenu" : TBICON[key], lowered || key === toolbarActiveName);
    });
  }
  refreshToolbarSprites();

  // WD-4: per-button hover text + "Hotkey: X" line, one exported table (spec:
  // "store the strings in one exported table now" -- the tooltip *component*
  // itself is WD-26; until then this just drives plain `title=`). Text marked
  // "verified" is copied word-for-word from a ui-truth capture's own tooltip
  // box (tools/spikes/ui-truth/MANIFEST.md); the rest is a short functional
  // description (DF's exact copy for that button wasn't captured live) --
  // flagged per-entry so a future pass knows which ones still need a
  // live-DF tooltip capture instead of guessing further.
  // `hotkey` is the single character DF's OWN tooltip prints -- verified
  // captures show a bare letter with case carrying the shift state (e.g.
  // 09-burrows.png reads "Hotkey: U", not "Hotkey: Shift+U"), so entries here
  // do the same instead of a "Shift+X" label of our own invention; the
  // in-client keyboard binding for an uppercase entry is still Shift+<letter>.
  const TOOLBAR_TOOLTIPS = {
    citizens: { text: "Citizen and creature information.", hotkey: "u", verified: true },
    orders: { text: "Fortress job list.", hotkey: "t", verified: true },
    locations: { text: "Place information.", hotkey: "P", verified: false },
    labor: { text: "Labor management.", hotkey: "y", verified: false },
    workorders: { text: "Open the work orders menu.", hotkey: "o", verified: true },
    nobles: { text: "Nobles and administrators.", hotkey: "n", verified: false },
    objects: { text: "Objects: artifacts, symbols, named items, written content.", hotkey: "O", verified: false },
    justice: { text: "Justice.", hotkey: "j", verified: false }, // WD-28: freed from camera pan-down, now DF's real D_JUSTICE key.
    digMenu: { text: "Finish setting dig orders.", hotkey: "m", verified: true },
    chop: { text: "Set tree chopping orders.", hotkey: "l", verified: false }, // WD-28: moved off `f` (now the real fluid-numbers toggle) onto DF's real D_DESIGNATE_CHOP key.
    gather: { text: "Set plant gathering orders.", hotkey: "g", verified: false },
    smooth: { text: "Finish setting wall orders.", hotkey: "v", verified: true },
    erase: { text: "Erase designations.", hotkey: "x", verified: false },
    build: { text: "Finish placing structures.", hotkey: "b", verified: true },
    stockpile: { text: "Finish placing stockpiles.", hotkey: "p", verified: true },
    zone: { text: "Designate a zone.", hotkey: "z", verified: false },
    burrow: { text: "Finish establishing burrows.", hotkey: "U", verified: true },
    hauling: { text: "Finish setting hauling routes.", hotkey: "h", verified: false }, // WD-28: freed from camera pan-left, now DF's real D_HAULING key.
    traffic: { text: "Set traffic designations.", hotkey: "T", verified: false }, // hotkey line verified ("...Hotkey: T"); descriptive text not fully captured.
    itemdesig: { text: "Designate items for dumping and melting, claim forbidden items and buildings, and set item visibility.", hotkey: "i", verified: true }, // exact text per 12b-itemdesig-tooltip.png
    squads: { text: "Military and squads.", hotkey: "q", verified: false }, // WD-28: freed from camera z-down, now DF's real D_SQUADS key (retires the old Shift+M fallback).
    worldmap: { text: "World and civilizations.", hotkey: "Y", verified: false }
    // NOTE: "stocks" (D_STOCKS, hotkey k) isn't in this table -- its button lives in #topbar
    // (a plain .top-button, not #bottomBar [data-df-btn]), see its own `title` attribute in
    // index.html instead of TOOLBAR_TOOLTIPS/applyToolbarTooltips() above.
  };
  window.DFToolbarTooltips = TOOLBAR_TOOLTIPS;
  function applyToolbarTooltips() {
    document.querySelectorAll("#bottomBar [data-df-btn]").forEach(button => {
      const key = button.dataset.panel || button.dataset.modeTool ||
                   (button.hasAttribute("data-dig-menu") ? "digMenu" : button.dataset.designationTool);
      const entry = key && TOOLBAR_TOOLTIPS[key];
      if (!entry) return;
      button.title = entry.hotkey ? `${entry.text}\nHotkey: ${entry.hotkey}` : entry.text;
    });
  }
  applyToolbarTooltips();

  const digSubmenu = document.getElementById("digSubmenu");
  const plantSubmenu = document.getElementById("plantSubmenu");
  const smoothSubmenu = document.getElementById("smoothSubmenu");
  const itemDesigSubmenu = document.getElementById("itemDesigSubmenu");
  const trafficSubmenu = document.getElementById("trafficSubmenu");

  // B233-4: #trafficSubmenu shipped EMPTY in the live client. Its contents -- the four
  // High/Normal/Low/Restricted paint tiles, the paint-mode pair, and the 1/2/5/25 cost panel --
  // existed only in DwfControlShell.trafficSubmenuMarkup, which nothing but the UI-lab
  // stories ever called. So traffic mode was stuck on whatever `trafficLevel` defaulted to ("high")
  // with no way to pick another level and no cost panel at all. Mount the SHARED builder (no
  // hand-rolled markup, per the DWFUI mandate) into the real DOM here -- BEFORE the
  // [data-traffic-level] / [data-paint-mode] listeners below run, so the tiles get their handlers
  // like every other submenu's.
  const TRAFFIC_COST_DEFAULTS = { high: 1, normal: 2, low: 5, restricted: 25 };
  const trafficCosts = { ...TRAFFIC_COST_DEFAULTS };
  let trafficCostsLoaded = false;   // lazy: read DF's live costs the first time traffic mode opens
  if (trafficSubmenu && window.DwfControlShell &&
      typeof window.DwfControlShell.trafficSubmenuMarkup === "function" &&
      !trafficSubmenu.querySelector("[data-traffic-level]")) {
    trafficSubmenu.innerHTML = window.DwfControlShell.trafficSubmenuMarkup({
      level: "high", paintMode: "rect", weights: trafficCosts,
    });
  }

  const digMenuButton = document.querySelector("[data-dig-menu]");
  // Old markup contains the former three-way client split. Collapse it in place so cached
  // HTML gets the native single tool without an index.html change.
  function collapseStairTools() {
    const old = [...document.querySelectorAll('[data-dig-tool="stairup"], [data-dig-tool="stairdown"], [data-dig-tool="stairupdown"]')];
    if (!old.length) return;
    const button = old.find(b => b.dataset.digTool === "stairupdown") || old[0];
    button.dataset.digTool = "stairs";
    button.title = "Dig stairs: select both z-level endpoints";
    old.forEach(b => { if (b !== button) b.remove(); });
  }
  collapseStairTools();
  // The existing designation route accepts tool=stairs and turns a nonzero zlevels range into
  // the correct top Down / middle UpDown / bottom Up stair designations server-side.
  // WD-8.3: convertmarker/convertstandard are wired the same way as erase (a
  // drag-selectable tool); the server recognizes their tool= value now (convert-to-marker/
  // -standard landed in src/placement.cpp, round-trip verified live 2026-07-07), so a
  // successful click flips DES_MARKER_ONLY on already-designated tiles.
  const digTools = new Set(["dig", "stairs", "ramp", "channel", "remove",
                             "convertmarker", "convertstandard"]);
  // Complete rectangle-designation matrix supported by /designate's z loop. Mining/removal and
  // erase were the reported cells, but smooth/carve, plant, marker-conversion, and item-flag
  // rectangles use the same server volume walk and must not silently remain single-plane.
  const rangeDesignationTools = new Set([
    "dig", "stairs", "ramp", "channel", "remove", "erase",
    "convertmarker", "convertstandard", "chop", "gather",
    "smooth", "engrave", "track", "fortify", "traffic",
    "claim", "forbid", "dump", "undump", "melt", "unmelt", "hide", "unhide"
  ]);
  const plantTools = new Set(["chop", "gather"]);
  const smoothTools = new Set(["smooth", "engrave", "track", "fortify"]);
  // WD-10: item/building designations 8-mode family (12-item-designations.png order). Wire
  // names follow DF's own raw token verbs (BUTTON_DES_CLAIM/_FORBID/_DUMP/_UNDUMP/_MELT/
  // _UNMELT/_UNHIDE/_HIDE in interface_map.json), not the spec prose's "no-dump"/"no-melt"/
  // "visible" shorthand. All eight landed server-side (ENDPOINT-ADD, src/placement.cpp;
  // verified in results/wd910-live-verify.txt), same as WD-8.3's convert-to-marker/-standard.
  const itemDesigTools = new Set(["claim", "forbid", "dump", "undump", "melt", "unmelt", "hide", "unhide"]);
  function backendToolFor(tool) {
    if (tool === "traffic") return `traffic-${trafficLevel}`;
    return ({ dig:"dig", stairs:"stairs",
              // B268 REGRESSION FIX (2026-07-14): the client must send the LEGACY spelling.
              // `remove-stairs-ramps` is the canonical name on the NEW server, but the server that
              // is actually RUNNING on a given host may predate it -- and a client that sends an
              // action the server has never heard of does not fail loudly, it silently DOES NOTHING.
              // That is exactly what happened: a web deploy shipped the new name while the old DLL
              // was still loaded, and the owner could no longer remove a wall.
              // `placement.cpp` accepts BOTH spellings (`tool == "remove-stairs-ramps" || tool ==
              // "remove-construction"`), so sending the legacy name works on EVERY server, old and
              // new. Do not "modernise" this to the canonical name: the client is deployed
              // independently of the DLL, so it must speak the dialect the oldest server understands.
              ramp:"ramp", channel:"channel", remove:"remove-construction",
              erase:"clear", chop:"chop", gather:"gather", smooth:"smooth",
              engrave:"engrave", track:"track", fortify:"fortify",
              "convertmarker":"convert-to-marker", "convertstandard":"convert-to-standard",
              claim:"claim", forbid:"forbid", dump:"dump", undump:"undump",
              melt:"melt", unmelt:"unmelt", hide:"hide", unhide:"unhide" })[tool] || null;
  }
  // WD-8.5: status plate text per active dig-family tool (01-dig.png: "Regular mining").
  // No live captures exist for the other tool labels; these are short, functionally
  // accurate descriptions rather than guessed DF copy -- flagged here for a future
  // live-tooltip pass, same convention as TOOLBAR_TOOLTIPS' `verified` flags above.
  const TOOL_MODE_LABELS = {
    // B193: every rectangle designation is two-click now, so the dig-family labels guide the
    // first CORNER (stairs stays z-phrased: its whole point is the level span).
    dig: "Regular mining: click the first corner",
    stairs: "Dig stairs: select the first z-level",
    ramp: "Dig ramps: click the first corner",
    channel: "Dig channels: click the first corner",
    remove: "Remove constructions: click the first corner",
    convertmarker: "Converting to marker mode",
    convertstandard: "Converting to standard mode",
    // B187: erase uses the two-click z-range gesture (like stairs). The label guides the
    // second click; the pending-state variant is chosen in updateToolModeLabel().
    erase: "Erase designations: click the first corner",
    // WD-9: exact text per 02-chop.png / 03-gather.png / 04-smooth.png. engrave/track/fortify
    // weren't captured individually (04-smooth.png only shows the family's "smooth" label) --
    // short functional descriptions, same convention as the unverified TOOLBAR_TOOLTIPS entries.
    chop: "Chopping trees",
    gather: "Gathering fruit and leaves",
    smooth: "Smoothing rough floors and walls",
    engrave: "Engraving smooth walls",
    track: "Carving minecart tracks",
    fortify: "Carving fortifications",
    // WD-10: exact text per 12-item-designations.png ("Claiming forbidden items and
    // buildings"); the other 7 modes weren't individually captured -- short functional
    // descriptions, same convention as above.
    claim: "Claiming forbidden items and buildings",
    forbid: "Forbidding items and buildings",
    dump: "Designating items for dumping",
    undump: "Cancelling dump designations",
    melt: "Designating items for melting",
    unmelt: "Cancelling melt designations",
    unhide: "Setting items visible",
    hide: "Hiding items",
    traffic: "Designating high traffic area"
  };
  const toolModeLabel = document.getElementById("toolModeLabel");
  function updateToolModeLabel() {
    if (!toolModeLabel) return;
    // B187: erase lives in the always-visible designation row (no submenu of its own), so it must
    // be added to the gate explicitly to surface its z-range guidance the way stairs does.
    const rangePending = rangeDesignationTools.has(selectedDesignation) && stairRangeStart;
    const baseLabel = TOOL_MODE_LABELS[selectedDesignation];
    // B193: two-click guidance -- corner 1 armed => guide the closing corner (stairs stays
    // z-phrased); nothing armed => guide the first click. Held-drag labels are gone with the
    // gesture itself.
    const label = (digMenuOpen || plantMenuOpen || smoothMenuOpen || itemDesigMenuOpen ||
                   selectedDesignation === "erase" || selectedDesignation === "traffic")
      ? (rangePending
          ? (selectedDesignation === "stairs"
              ? "Dig stairs: select the other z-level"
              : `${baseLabel.split(":")[0]}: click the opposite corner (Shift+wheel spans z-levels)`)
          : `${baseLabel}. Shift+wheel changes elevation`) : null;
    toolModeLabel.textContent = label || "";
    toolModeLabel.classList.toggle("visible", !!label);
  }
  function updateDesignationButtons() {
    // B269: push mining-designation mode into both renderers. DF only shows the damp/warm stone
    // indicators (mining_indicators.png) while the mining tool is up -- that gate is what keeps a
    // riverside fort from being permanently speckled with drops. This is the SAME expression the
    // dig-menu button already uses below to paint itself active, so "mine mode" in the overlay and
    // "the dig button looks selected" can never disagree. updateDesignationButtons is the single
    // funnel every selection path (selectDesignation, the dig-menu toggle, tool deselect) already
    // calls, so there is no second place to keep in sync.
    const inMineMode = digMenuOpen || digTools.has(selectedDesignation);
    try { if (window.DwfTiles && window.DwfTiles.setMineMode) window.DwfTiles.setMineMode(inMineMode); } catch (_) {}
    try { if (window.DwfGL && window.DwfGL.setMineMode) window.DwfGL.setMineMode(inMineMode); } catch (_) {}

    digSubmenu.classList.toggle("visible", digMenuOpen);
    digSubmenu.setAttribute("aria-hidden", digMenuOpen ? "false" : "true");
    plantSubmenu.classList.toggle("visible", plantMenuOpen);
    plantSubmenu.setAttribute("aria-hidden", plantMenuOpen ? "false" : "true");
    smoothSubmenu.classList.toggle("visible", smoothMenuOpen);
    smoothSubmenu.setAttribute("aria-hidden", smoothMenuOpen ? "false" : "true");
    itemDesigSubmenu.classList.toggle("visible", itemDesigMenuOpen);
    itemDesigSubmenu.setAttribute("aria-hidden", itemDesigMenuOpen ? "false" : "true");
    if (trafficSubmenu) {
      const open = selectedDesignation === "traffic";
      // B216: opening a mode must not write anything. This is a READ of DF's four cost fields, done
      // once, the first time the player actually opens traffic mode (no request at page load).
      if (open && !trafficCostsLoaded) { trafficCostsLoaded = true; loadTrafficCosts(); }
      trafficSubmenu.classList.toggle("visible", open);
      trafficSubmenu.setAttribute("aria-hidden", open ? "false" : "true");
      // 11-traffic.png: each level is a real DF sprite whose _ACTIVE variant carries the selection.
      trafficSubmenu.querySelectorAll("[data-traffic-level]").forEach(button =>
        paintSprite(button, TRAFFIC_SPRITES[button.dataset.trafficLevel] || "trafficHigh",
                    button.dataset.trafficLevel === trafficLevel));
    }
    paintSprite(digMenuButton, digMenuOpen ? "lowerMenu" : "digMenu", digMenuOpen || digTools.has(selectedDesignation));
    document.querySelectorAll("[data-dig-tool]").forEach(button => {
      const tool = button.dataset.digTool;
      paintSprite(button, tool, selectedDesignation === tool);
    });
    document.querySelectorAll("[data-plant-tool]").forEach(button => {
      const tool = button.dataset.plantTool;
      button.style.display = (plantMenuOpen && selectedDesignation !== tool) ? "none" : "";
      paintSprite(button, tool, selectedDesignation === tool);
    });
    document.querySelectorAll("[data-smooth-tool]").forEach(button => {
      const tool = button.dataset.smoothTool;
      paintSprite(button, tool, selectedDesignation === tool);
    });
    // WD-10: all 8 item-designation buttons stay visible together (12-item-designations.png
    // shows the full row at once, one highlighted), same shape as the smooth-tool row above.
    document.querySelectorAll("[data-itemdesig-tool]").forEach(button => {
      const tool = button.dataset.itemdesigTool;
      paintSprite(button, tool, selectedDesignation === tool);
    });
    document.querySelectorAll("[data-designation-tool]").forEach(button => {
      const tool = button.dataset.designationTool;
      if (tool === "chop" || tool === "gather") {
        const openForTool = plantMenuOpen && selectedDesignation === tool;
        paintSprite(button, openForTool ? "lowerMenu" : tool, openForTool || selectedDesignation === tool);
        return;
      }
      if (tool === "smooth") {
        paintSprite(button, smoothMenuOpen ? "lowerMenu" : "smooth",
                    smoothMenuOpen || smoothTools.has(selectedDesignation));
        return;
      }
      let active = selectedDesignation === tool;
      paintSprite(button, tool, active);
    });
    // WD-4/WD-10: bottom-center "modes" group (Burrow/Hauling/Traffic) + the
    // item/building-designations button. Burrow/Hauling/Traffic real submenus/endpoints
    // land in WD-11/WD-13/WD-29; for now selecting one just shows DF's selected-button
    // highlight (selectDesignation already no-ops the backend for tool names
    // backendToolFor() doesn't recognize -- see selectDesignation below). Item-designations
    // (WD-10) now opens a real submenu with its own tool family, so it needs the same
    // "lowerMenu" swap the dig/chop/gather/smooth main buttons get while their submenu is open.
    document.querySelectorAll("[data-mode-tool]").forEach(button => {
      const tool = button.dataset.modeTool;
      if (tool === "itemdesig") {
        const openForTool = itemDesigMenuOpen && itemDesigTools.has(selectedDesignation);
        paintSprite(button, openForTool ? "lowerMenu" : "itemdesig", openForTool || itemDesigTools.has(selectedDesignation));
        return;
      }
      // WD-13: the burrow button highlights while burrow MODE is open (it is a mode, not a
      // selectable designation tool anymore). W5C: and it lowers, exactly like dig (09-burrows.png).
      if (tool === "burrow") {
        const open = !!burrowMode;
        paintSprite(button, open ? "lowerMenu" : "burrow", open);
        return;
      }
      if (tool === "hauling") {
        const open = !!haulingMode;                       // 10-hauling.png
        paintSprite(button, open ? "lowerMenu" : "hauling", open);
        return;
      }
      if (tool === "traffic") {
        const open = selectedDesignation === "traffic";   // 11-traffic.png
        paintSprite(button, open ? "lowerMenu" : "traffic", open);
        return;
      }
      paintSprite(button, tool, selectedDesignation === tool);
    });
    repaintToolbarSprites();   // stockpile/zone lower to BUTTON_LOWER_MENU while their menu is open
    // Priority / dig-mode selection is carried by the SPRITE's _ACTIVE variant now
    // (BUTTON_PRIORITY_n_ACTIVE, BUTTON_DIG_MODE_*_ACTIVE) -- not by an invented green fill.
    document.querySelectorAll("[data-dig-prio]").forEach(b =>
      paintSprite(b, `prio${Number(b.dataset.digPrio)}`, Number(b.dataset.digPrio) === digPriority));
    document.querySelectorAll("[data-dig-opt]").forEach(b => {
      if (b.dataset.digOpt === "marker") {
        // WD-8.3: real BUTTON_DES_BLUEPRINT plate instead of the old unicode glyph.
        paintSprite(b, "markerToggle", markerMode);
        return;
      }
      // warm/damp is our superset: no DF token exists, so it keeps the placeholder tile and takes
      // the shared .tool-button.active outline.
      b.classList.toggle("active", warmDampMode);
    });
    document.querySelectorAll("[data-dig-mode]").forEach(b =>
      paintSprite(b, DIG_MODE_SPRITES[Number(b.dataset.digMode)] || "digModeAll",
                  Number(b.dataset.digMode) === digMineMode));
    // WD-8.1/8.4: base-row paint-mode pair (rectangle-corners vs free-hand paint).
    document.querySelectorAll("[data-paint-mode]").forEach(b => {
      const mode = b.dataset.paintMode;
      paintSprite(b, mode === "free" ? "paintFree" : "paintRect", paintMode === mode);
    });
    updateToolModeLabel();
    // 01b-dig-expanded.png: the expander is BUTTON_EXPANDER_CLOSED (gold ->) / _OPEN (gold <-),
    // not a play glyph rotated 90deg in CSS. `.open` stays as the class the CSS/tests pin.
    const setExpander = (button, open) => {
      if (!button) return;
      button.classList.toggle("open", open);
      paintSprite(button, "expander", open);
    };
    const adv = document.querySelector(".dig-adv");
    if (adv) adv.classList.toggle("open", digAdvOpen);
    setExpander(document.querySelector("[data-dig-expand]"), digAdvOpen);
    const plantAdv = document.querySelector(".plant-adv");
    if (plantAdv) plantAdv.classList.toggle("open", plantAdvOpen);
    setExpander(document.querySelector("[data-plant-expand]"), plantAdvOpen);
    const smoothAdv = document.querySelector(".smooth-adv");
    if (smoothAdv) smoothAdv.classList.toggle("open", smoothAdvOpen);
    setExpander(document.querySelector("[data-smooth-expand]"), smoothAdvOpen);
    updateToolCursor();
  }
  function selectDesignation(tool) {
    clearBuildPlacement(false);
    closeStockMode(); // WD-12: also cancels any armed existing-pile repaint (stockRepaintId)
    closeZoneMode();  // WD-14
    closeBurrowMode(); // WD-13
    // B187/B193: the pending two-click corner belongs to the tool that started it. Switching to
    // a DIFFERENT tool (selectedDesignation is still the previous tool here) must drop the
    // pending footprint -- otherwise a dig-captured corner could be committed as an erase (or
    // vice versa). Re-selecting the same range tool keeps it.
    if (tool !== selectedDesignation) {
      stairRangeStart = null;
      stairRangePreview = null;
      twoClickCursor = null;
      renderZoneOverlay();
    }
    selectedDesignation = tool;
    currentTool = backendToolFor(tool);
    digMenuOpen = digMenuOpen && digTools.has(tool);
    plantMenuOpen = plantMenuOpen && plantTools.has(tool);
    smoothMenuOpen = smoothMenuOpen && smoothTools.has(tool);
    itemDesigMenuOpen = itemDesigMenuOpen && itemDesigTools.has(tool);
    updateDesignationButtons();
  }
  digMenuButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (digMenuOpen) {
      // Closing the dig menu also deselects the tool (so the designation grid clears).
      digMenuOpen = false;
      selectedDesignation = null;
      currentTool = null;
      stairRangeStart = null;
      stairRangePreview = null;
      twoClickCursor = null;
      renderZoneOverlay();
    } else {
      digMenuOpen = true;
      plantMenuOpen = false;
      smoothMenuOpen = false;
      itemDesigMenuOpen = false;
      if (!digTools.has(selectedDesignation))
        selectedDesignation = "dig";
      currentTool = backendToolFor(selectedDesignation);
    }
    updateDesignationButtons();
    focusPage();
  });
  document.querySelectorAll("[data-dig-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      digMenuOpen = true;
      plantMenuOpen = false;
      smoothMenuOpen = false;
      itemDesigMenuOpen = false;
      selectDesignation(button.dataset.digTool);
      focusPage();
    });
  });
  // WD-8.1/8.4: paint-mode pair -- picks how the NEXT drag on the map is interpreted;
  // doesn't change the selected tool or close the menu (mirrors the priority/marker
  // toggles above it).
  document.querySelectorAll("[data-paint-mode]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      paintMode = button.dataset.paintMode === "free" ? "free" : "rect";
      // WD-12: clicking rect/free inside the stockpile paint submenu re-arms new-pile paint
      // (in case erase/remove-existing was armed) -- shared button, shared listener, same
      // pattern as the dig/plant/smooth/item-desig families above.
      if (stockMode === "paint") {
        stockEraseArmed = false;
        stockRemoveArmed = false;
        stockPreset = true;
        updateStockButtons();
      }
      // WD-14: same re-arm inside the zone paint submenu (shared button, shared listener).
      if (zoneMode === "paint") {
        zoneEraseArmed = false;
        zoneRemoveArmed = false;
        updateZoneButtons();
      }
      updateDesignationButtons();
      focusPage();
    });
  });
  document.querySelectorAll("[data-plant-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      digMenuOpen = false;
      plantMenuOpen = true;
      smoothMenuOpen = false;
      itemDesigMenuOpen = false;
      selectDesignation(button.dataset.plantTool);
      focusPage();
    });
  });
  document.querySelectorAll("[data-smooth-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      digMenuOpen = false;
      plantMenuOpen = false;
      smoothMenuOpen = true;
      itemDesigMenuOpen = false;
      selectDesignation(button.dataset.smoothTool);
      focusPage();
    });
  });
  // WD-10: item/building designations submenu tool buttons -- same shape as the
  // dig/plant/smooth tool rows above (armDesignation opens the menu + closes the others).
  document.querySelectorAll("[data-itemdesig-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      armDesignation("itemdesig", button.dataset.itemdesigTool);
      focusPage();
    });
  });
  document.querySelectorAll("[data-traffic-level]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      trafficLevel = ["high", "normal", "low", "restricted"].includes(button.dataset.trafficLevel)
        ? button.dataset.trafficLevel : "high";
      selectedDesignation = "traffic";
      currentTool = backendToolFor("traffic");
      updateDesignationButtons();
      focusPage();
    });
  });

  // B233-4: the four cost sliders. GET /traffic-costs seeds them with DF's LIVE values (so a fort
  // whose costs were changed in DF shows the real numbers, not the 1/2/5/25 defaults); dragging
  // one writes that single field back (POST sends only the slider that moved -- the route leaves
  // every unsent field alone, so two players sliding different levels cannot clobber each other).
  // `input` repaints the <output> locally; the POST goes on `change` (pointer released), so a drag
  // is one write, not fifty.
  function paintTrafficCostOutputs() {
    if (!trafficSubmenu) return;
    trafficSubmenu.querySelectorAll("[data-traffic-weight]").forEach(input => {
      const key = input.dataset.trafficWeight;
      const value = Number(trafficCosts[key]);
      if (!Number.isFinite(value)) return;
      // A live value can exceed the slider's max (DF accepts bigger costs); widen rather than lie.
      if (value > Number(input.max || 50)) input.max = String(value);
      input.value = String(value);
      const out = input.parentElement && input.parentElement.querySelector("output");
      if (out) out.textContent = String(value);
    });
  }
  function setTrafficCostNote(text, isError) {
    const note = trafficSubmenu && trafficSubmenu.querySelector("[data-traffic-cost-note]");
    if (!note) return;
    note.textContent = text;
    note.classList.toggle("traffic-weight-note-error", !!isError);
  }
  async function loadTrafficCosts() {
    if (!trafficSubmenu) return;
    try {
      const res = await fetch(`/traffic-costs?t=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      if (!data || !data.costs) return;   // old DLL without the route: keep the defaults, stay quiet
      Object.assign(trafficCosts, data.costs);
      paintTrafficCostOutputs();
    } catch (_) { /* offline/older host: the sliders keep DF's documented defaults */ }
  }
  async function postTrafficCost(key, value) {
    try {
      const res = await fetch(
        `/traffic-costs?${encodeURIComponent(key)}=${encodeURIComponent(value)}&t=${Date.now()}`,
        { method: "POST", cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || "write failed");
      if (data.costs) Object.assign(trafficCosts, data.costs);
      paintTrafficCostOutputs();
      setTrafficCostNote("Costs are DF's live pathfinding weights (defaults 1/2/5/25).", false);
    } catch (err) {
      setTrafficCostNote(`Could not set the ${key} cost: ${err.message || err}`, true);
      loadTrafficCosts();   // re-read the truth rather than leave the slider showing a lie
    }
  }
  if (trafficSubmenu) {
    trafficSubmenu.querySelectorAll("[data-traffic-weight]").forEach(input => {
      input.addEventListener("input", () => {
        const out = input.parentElement && input.parentElement.querySelector("output");
        if (out) out.textContent = input.value;
      });
      input.addEventListener("change", () => {
        postTrafficCost(input.dataset.trafficWeight, Number(input.value));
        focusPage();
      });
    });
  }

  document.querySelectorAll("[data-designation-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const tool = button.dataset.designationTool;
      if (plantTools.has(tool)) {
        if (plantMenuOpen && selectedDesignation === tool) {
          plantMenuOpen = false;
          selectedDesignation = null;
          currentTool = null;
        } else {
          digMenuOpen = false;
          plantMenuOpen = true;
          smoothMenuOpen = false;
          itemDesigMenuOpen = false;
          selectDesignation(tool);
        }
      } else if (tool === "smooth") {
        if (smoothMenuOpen && selectedDesignation === "smooth") {
          smoothMenuOpen = false;
          selectedDesignation = null;
          currentTool = null;
        } else {
          digMenuOpen = false;
          plantMenuOpen = false;
          smoothMenuOpen = true;
          itemDesigMenuOpen = false;
          selectDesignation("smooth");
        }
      } else {
        digMenuOpen = false;
        plantMenuOpen = false;
        smoothMenuOpen = false;
        itemDesigMenuOpen = false;
        selectDesignation(tool);
      }
      updateDesignationButtons();
      focusPage();
    });
  });
  // WD-4/WD-10/WD-13: Traffic (modes group) still toggles arm/disarm exactly like erase
  // (selectDesignation + a plain click-to-toggle-off), giving DF's selected-button
  // highlight; its real submenu lands in WD-11. backendToolFor() has no entry for that tool
  // name, so currentTool stays null and no /designate request is ever sent for it -- selecting
  // it is a pure UI no-op until that item lands. Item-designations (WD-10) opens its own
  // submenu (armDesignation). Burrow (WD-13) and Hauling (WD-29) each open their own real DF
  // mode: a full-height left panel + tile/stop placement (toggleBurrowPanel /
  // toggleHaulingPanel below, handled in the early-return branches above), replacing the old
  // highlight-only stub both used to share.
  document.querySelectorAll("[data-mode-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const tool = button.dataset.modeTool;
      if (tool === "burrow") {
        toggleBurrowPanel();
        focusPage();
        return;
      }
      if (tool === "hauling") {
        // WD-26 first-time help (10-hauling.png) fires on arming, same as the other modes.
        if (!haulingMode && window.DFHelpPopup) DFHelpPopup.maybeShow("hauling");
        toggleHaulingPanel();
        focusPage();
        return;
      }
      if (tool === "itemdesig") {
        if (itemDesigMenuOpen) {
          itemDesigMenuOpen = false;
          selectedDesignation = null;
          currentTool = null;
          updateDesignationButtons();
        } else {
          // armDesignation() calls selectDesignation() internally, which already ends
          // in updateDesignationButtons() -- no extra call needed on this branch.
          armDesignation("itemdesig", itemDesigTools.has(selectedDesignation) ? selectedDesignation : "claim");
        }
      } else if (selectedDesignation === tool) {
        selectedDesignation = null;
        currentTool = null;
        updateDesignationButtons();
      } else {
        digMenuOpen = false;
        plantMenuOpen = false;
        smoothMenuOpen = false;
        itemDesigMenuOpen = false;
        selectDesignation(tool); // ends in updateDesignationButtons()
      }
      focusPage();
    });
  });
  // Dig-menu options: priority 1-7 + marker / warm-damp toggles. These tweak the NEXT designation;
  // they don't change the selected tool, so the dig menu stays open.
  document.querySelectorAll("[data-dig-prio]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      digPriority = Number(button.dataset.digPrio) || 4;
      updateDesignationButtons();
      focusPage();
    });
  });
  document.querySelectorAll("[data-dig-opt]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.digOpt === "marker") markerMode = !markerMode;
      else warmDampMode = !warmDampMode;
      updateDesignationButtons();
      focusPage();
    });
  });
  document.querySelectorAll("[data-dig-mode]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      digMineMode = Number(button.dataset.digMode) || 0;
      updateDesignationButtons();
      focusPage();
    });
  });
  document.querySelector("[data-dig-expand]").addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    digAdvOpen = !digAdvOpen;
    updateDesignationButtons();
    focusPage();
  });
  document.querySelector("[data-plant-expand]").addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    plantAdvOpen = !plantAdvOpen;
    updateDesignationButtons();
    focusPage();
  });
  document.querySelector("[data-smooth-expand]").addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    smoothAdvOpen = !smoothAdvOpen;
    updateDesignationButtons();
    focusPage();
  });
  // B199 GUARD: this init-time call reaches across scripts (selectedBuild/zonePreset live in
  // dwf-build-info-panels.js). If that module was skipped/late for ANY reason, an
  // uncaught throw HERE kills every pointer handler below -- nobody can select anything
  // (the 07-11 win31 outage). Degrade to a console tag instead: toolbar state repaints on
  // the next user action; the input handlers MUST always attach.
  try { updateDesignationButtons(); }
  catch (e) { console.error("B199: init updateDesignationButtons failed (cross-script module missing?)", e); }

  // Z-range is selected directly in the play area; no numeric control.
  // Dig-menu options applied to every designation request (priority/marker/warm-damp).
  function digOptsQuery() {
    return `&priority=${digPriority}&marker=${markerMode ? 1 : 0}&warmdamp=${warmDampMode ? 1 : 0}&minemode=${digMineMode}`;
  }
  // WD-8.3/WD-10: the marker-convert trio and the item-designation family ALL landed
  // server-side (src/placement.cpp) -- convert-to-marker/-standard round-trip verified live
  // 2026-07-07, item designations in results/wd910-live-verify.txt -- so none are pending
  // anymore. A !ok response now just means "no valid tiles under the cursor" (a normal no-op
  // click), which must NOT log a misleading "endpoint pending" warning. The set is kept empty
  // so the guard below is a no-op today but remains available if a genuinely-unlanded tool is
  // wired up before its server pass.
  const PENDING_DESIGNATE_TOOLS = new Set([]);
  function warnIfPendingEndpoint(ok, tool) {
    if (!ok && PENDING_DESIGNATE_TOOLS.has(tool))
      console.warn(`[designate] /designate tool=${tool}: server endpoint pending (src/placement.cpp)`);
  }
  // WD-13/WD-14: POST to a ROUTE that may not exist server-side yet. A missing route
  // surfaces two ways (verified live): GETs get httplib's plain 404, but unmatched POSTs get
  // NO response at all (the server never answers; the connection eventually dies) -- so both
  // a !ok response AND a network error/abort count as "endpoint pending". The 4s abort keeps
  // a hanging fetch from dangling. Returns the Response on success, null when pending/failed
  // (the caller owns the console.warn/status so each pending route is individually visible).
  async function postMaybePending(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(url, { method: "POST", cache: "no-store", signal: ctl.signal });
      return r.ok ? r : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function designateClick(event) {
    const pixel = imagePixelFromEvent(event);
    if (!pixel) return;
    try {
      const url = `/designate?player=${encodeURIComponent(player)}&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}&tool=${encodeURIComponent(currentTool)}` + digOptsQuery();
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      warnIfPendingEndpoint(r.ok, currentTool);
    } catch (_) {}
  }

  // B133: one unclamped grid rectangle drives the POST, browser preview, and targeted block
  // refill. Loaded cache extents are deliberately absent: only the rendered viewport bounds
  // (already enforced by imagePixelClamped) limit a drag.
  function designationDragRect(a, b) {
    if (!a || !b) return null;
    const values = [a.x, a.y, b.x, b.y, a.w, a.h].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return { x1: Math.min(values[0], values[2]), y1: Math.min(values[1], values[3]),
      x2: Math.max(values[0], values[2]), y2: Math.max(values[1], values[3]),
      w: values[4], h: values[5] };
  }

  function requestDesignationBlocks(rect) {
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!rect || !rendered) return;
    requestDesignationWorldBlocks({
      x1: Number(rendered.ox) + rect.x1, y1: Number(rendered.oy) + rect.y1,
      x2: Number(rendered.ox) + rect.x2, y2: Number(rendered.oy) + rect.y2,
      z: Number(rendered.oz)
    }, Number(rendered.oz));
  }

  function requestDesignationWorldBlocks(selection, endZ) {
    const cache = window.DwfCache;
    if (!selection || !cache || typeof cache.requestBlockRect !== "function") return;
    const values = [selection.x1, selection.y1, selection.x2, selection.y2,
      selection.z, endZ].map(Number);
    if (!values.every(Number.isFinite)) return;
    const z1 = Math.min(values[4], values[5]), z2 = Math.max(values[4], values[5]);
    for (let z = z1; z <= z2; z++)
      cache.requestBlockRect(values[0], values[1], values[2], values[3], z);
  }

  // Designate a rectangle from one screen corner to another (a single click is just
  // a 1x1 rectangle). The backend maps both corners to world tiles.
  async function designateDrag(x1, y1, x2, y2) {
    if (!currentTool) return;
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    const rect = designationDragRect(a, b);
    if (!rect) return;
    try {
      const url = `/designate?player=${encodeURIComponent(player)}&px=${rect.x1}&py=${rect.y1}` +
        `&px2=${rect.x2}&py2=${rect.y2}&w=${rect.w}&h=${rect.h}&tool=${encodeURIComponent(currentTool)}` + digOptsQuery();
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      warnIfPendingEndpoint(r.ok, currentTool);
      if (r.ok) requestDesignationBlocks(rect);
    } catch (_) {}
  }

  function designationWorldSelection(x1, y1, x2, y2) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    const rect = designationDragRect(a, b);
    if (!rect || !rendered) return null;
    return { x1: Number(rendered.ox) + rect.x1, y1: Number(rendered.oy) + rect.y1,
      x2: Number(rendered.ox) + rect.x2, y2: Number(rendered.oy) + rect.y2,
      z: Number(rendered.oz), w: rect.w, h: rect.h, tool: selectedDesignation };
  }

  function showDesignationRangePreview(selection, endZ) {
    if (!selection) return;
    stairRangePreview = { ...selection, z1: Number(selection.z), z2: Number(endZ) };
    dragPreview = null;
    renderZoneOverlay();
  }

  function clearTransientDesignationRangePreview() {
    if (stairRangeStart) return; // an armed two-click first corner remains retryable
    stairRangePreview = null;
    renderZoneOverlay();
  }

  async function submitDesignationRange(selection, endZ) {
    if (!selection) return false;
    // Shift+wheel moves the camera through the normal queue. Await it so camera_for_player()
    // sees the active release level instead of racing a still-pending /camera request.
    if (typeof whenCameraMovesFlushed === "function") await whenCameraMovesFlushed();
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!rendered) return false;
    const pointZ = Number(rendered.oz);
    const values = [selection.x1, selection.y1, selection.x2, selection.y2,
      selection.z, pointZ, rendered.ox, rendered.oy, rendered.gw, rendered.gh].map(Number);
    if (!values.every(Number.isFinite)) return false;
    const px1 = values[0] - values[6], py1 = values[1] - values[7];
    const px2 = values[2] - values[6], py2 = values[3] - values[7];
    const designationTool = selection.tool || selectedDesignation;
    const rangeTool = designationTool === "stairs" ? "stairs" : backendToolFor(designationTool);
    if (!rangeTool) return false;
    try {
      const url = `/designate?player=${encodeURIComponent(player)}&px=${px1}&py=${py1}` +
        `&px2=${px2}&py2=${py2}&w=${values[8]}&h=${values[9]}&tool=${encodeURIComponent(rangeTool)}` +
        `&priority=${digPriority}&marker=${markerMode ? 1 : 0}&warmdamp=${warmDampMode ? 1 : 0}` +
        `&minemode=${digMineMode}&zlevels=${values[4] - values[5]}`;
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      warnIfPendingEndpoint(r.ok, rangeTool);
      if (!r.ok) { clearTransientDesignationRangePreview(); return false; }
      requestDesignationWorldBlocks(selection, pointZ);
      if (!stairRangeStart || stairRangeStart.tool === designationTool) stairRangeStart = null;
      stairRangePreview = null;
      twoClickCursor = null;
      renderZoneOverlay();
      updateDesignationButtons();
      return true;
    } catch (_) {
      clearTransientDesignationRangePreview();
      return false;
    }
  }

  // B193 (native DF check 2026-07-10): "in native df you click once to start the designation
  // then move your mouse or change elevations with the scroll ... then click again to end it,
  // click drag is not a native thing." EVERY rectangle designation tool uses this two-click
  // gesture now -- click one corner, the box rubber-bands to the cursor with the button UP
  // (Shift+wheel mid-flow spans z, the B186 semantics in two-click form), click again to commit
  // exactly the previewed volume through the shared submitter. This function is the click
  // handler for both legs (name note: `stairRangeStart` predates B193 -- stairs pioneered the
  // gesture in B58/B106, erase joined in B187, everything else in B193).
  async function designateTwoClickRange(x1, y1, x2, y2) {
    const selection = designationWorldSelection(x1, y1, x2, y2);
    if (!selection) return;
    if (!stairRangeStart) {
      stairRangeStart = selection;
      twoClickCursor = { x: x1, y: y1 };
      showDesignationRangePreview(selection, selection.z);
      updateDesignationButtons();
      return;
    }
    const start = stairRangeStart;
    const pointZ = Number(selection.z);
    // Same-z stairs retain their first footprint (a stair designation is meaningless without a
    // level span); every other tool's second click commits, including the common same-z rect.
    const isStairs = selectedDesignation === "stairs";
    if (start.z === pointZ && isStairs) { updateDesignationButtons(); return; }
    // B196: the second click completes the rubber-banded box. Commit bbox(anchor, this click) so
    // the committed rect equals exactly the previewed rect the cursor was tracking -- NOT the
    // frozen first-click footprint (the pre-B196 bug where the second corner never counted).
    const rect = twoClickRangeMerge(start, selection);
    // B209: the second click ALWAYS closes the two-click gesture -- native DF ends the designation
    // on that click whether or not any tile was valid. Disarm the anchor BEFORE awaiting the POST
    // so a server rejection can't strand the pending box requiring Esc. This is the eraser
    // "second click does nothing / hit Esc to cancel" regression: erase resolves to tool=clear,
    // and clearing an area with no live designation (the common eraser case -- and every re-erase
    // of a tile whose glyph the un-ship staleness bug left on screen) makes the server return
    // "no valid tiles" (non-ok); the old failure path left stairRangeStart set, so the box froze
    // armed and the tool never released. submitDesignationRange's own success-path reset is now
    // redundant; on the failure path clearTransientDesignationRangePreview (no longer suppressed by
    // a live anchor) drops the frozen preview so the box closes exactly like a committed dig.
    stairRangeStart = null;
    twoClickCursor = null;
    await submitDesignationRange(rect, pointZ);
    updateDesignationButtons();
  }

  // B196/B193: rubber-band a two-click range between the two clicks. Native DF places the first
  // corner on click 1, then the box FOLLOWS THE CURSOR with no button held until click 2
  // completes it. `twoClickEligible()` = the selected tool takes the two-click gesture at all
  // (any rectangle-designation tool in rect paint mode -- free paint keeps its drag stroke);
  // `twoClickArmed()` = its first corner is placed; `twoClickRangeMerge` grows the anchor
  // footprint out to the current cursor tile (for a plain first click the anchor is 1x1, so the
  // box is exactly anchor->cursor); `updateTwoClickRubberBand` repaints the preview each
  // pointermove at the live camera z.
  function twoClickEligible() {
    return !!currentTool && rangeDesignationTools.has(selectedDesignation) &&
      paintMode === "rect";
  }
  function twoClickArmed() {
    return !!stairRangeStart && stairRangeStart.tool === selectedDesignation && twoClickEligible();
  }
  function twoClickRangeMerge(anchor, cursorSel) {
    return {
      x1: Math.min(anchor.x1, cursorSel.x1), y1: Math.min(anchor.y1, cursorSel.y1),
      x2: Math.max(anchor.x2, cursorSel.x2), y2: Math.max(anchor.y2, cursorSel.y2),
      z: Number(anchor.z), w: cursorSel.w, h: cursorSel.h,
      tool: anchor.tool || selectedDesignation
    };
  }
  function updateTwoClickRubberBand(clientX, clientY) {
    if (!twoClickArmed()) return;
    const cursorSel = designationWorldSelection(clientX, clientY, clientX, clientY);
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!cursorSel || !rendered) return;
    twoClickCursor = { x: clientX, y: clientY };
    // z1 = the anchor's z (click 1); z2 = the live camera z, so shift-scrolling between the two
    // clicks keeps the previewed volume's z-extent honest.
    showDesignationRangePreview(twoClickRangeMerge(stairRangeStart, cursorSel), Number(rendered.oz));
    // -drag1: mirror the local rubber band to everyone else over the presence channel
    // (throttled inside sendPlacementUi). The hover heartbeat's drag=0 send fires later in the
    // SAME pointermove and always lands inside the 55ms throttle window this send just opened,
    // so the armed box never flickers off for remote viewers.
    sendTwoClickPresence(imagePixelClamped(clientX, clientY));
  }

  // B196/B193: between the two clicks of a rectangle designation, Shift+wheel steps the camera
  // z AND re-extends the pending range's z-extent, so the previewed volume stays honest before
  // the second click commits it. Rebuilds from the last hovered tile at the new camera z. With
  // no anchor armed the hook declines (returns false) and core's plain Shift+wheel camera
  // z-step runs instead. (The B186 held-drag branch is gone with the held-drag gesture itself
  // -- B193: "click drag is not a native thing".)
  function designationRangeWheel(event) {
    if (!event || !event.shiftKey || !twoClickArmed()) return false;
    const dz = event.deltaY < 0 ? zstep : -zstep;
    queueMove(0, 0, dz);
    const rendered = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    const endZ = rendered && Number.isFinite(Number(rendered.oz))
      ? Number(rendered.oz)
      : Number((stairRangePreview && stairRangePreview.z2) ?? stairRangeStart.z) + dz;
    const cursorSel = twoClickCursor
      ? designationWorldSelection(twoClickCursor.x, twoClickCursor.y, twoClickCursor.x, twoClickCursor.y)
      : null;
    showDesignationRangePreview(
      cursorSel ? twoClickRangeMerge(stairRangeStart, cursorSel) : stairRangeStart, endZ);
    updateToolModeLabel();
    return true;
  }
  window.DFDesignationRangeWheel = designationRangeWheel;

  // WD-8.4/WD-9/WD-10: free-paint -- while paintMode==="free" and a dig/plant/smooth/
  // item-desig-family tool is armed, every pointermove during a drag commits 1x1 /designate
  // calls for each cell the cursor crosses (Bresenham-interpolated so a fast drag doesn't
  // skip tiles), deduped per-drag so a stationary cursor doesn't resend the same cell. No
  // endpoint change -- reuses the existing 1x1 rect shape (px==px2, py==py2). Naturally
  // throttled to the browser's pointermove rate, comfortably under the spec's
  // ">=20Hz, coalesce runs" floor for any real mouse/trackpad. WD-9 extends this from
  // dig-only to every family that now has its own paint-mode pair (plant/smooth submenus);
  // WD-10 extends it again to the item-designation family.
  let freePaintCells = null; // Set of "x,y" keys already committed this drag, or null when idle
  let freePaintLastCell = null;
  function freePaintActive() {
    return paintMode === "free" && !!currentTool &&
      (digTools.has(selectedDesignation) || plantTools.has(selectedDesignation) ||
       smoothTools.has(selectedDesignation) || itemDesigTools.has(selectedDesignation));
  }
  async function designateCell(x, y, w, h) {
    try {
      const url = `/designate?player=${encodeURIComponent(player)}&px=${x}&py=${y}&px2=${x}&py2=${y}&w=${w}&h=${h}&tool=${encodeURIComponent(currentTool)}` + digOptsQuery();
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      warnIfPendingEndpoint(r.ok, currentTool);
    } catch (_) {}
  }
  function freePaintTo(cell) {
    if (!freePaintCells || !cell) return;
    const from = freePaintLastCell || cell;
    let x = from.x, y = from.y;
    const x1 = cell.x, y1 = cell.y;
    const dx = Math.abs(x1 - x), sx = x < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y), sy = y < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      const key = `${x},${y}`;
      if (!freePaintCells.has(key)) {
        freePaintCells.add(key);
        designateCell(x, y, cell.w, cell.h);
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    freePaintLastCell = cell;
  }

  // --- Stockpile placement (WD-12): paint-first, matching 07-stockpile-mode.png (entry --
  // single "+ new stockpile" button; a plain click on an existing pile still opens its detail
  // panel via inspectClick, DF's "existing-stockpiles context") / 07b-stockpile-paint.png
  // (paint stage -- rect/free paint pair + erase + remove-existing, then Accept). The category
  // picker this replaces (STOCK_PRESETS/"pick what it stores, then drag") is gone: DF doesn't
  // ask for a category before painting either -- the config panel that opens after Accept
  // (renderStockpilePanel, dwf-building-zone-stockpile-panels.js) already has the same
  // category presets + custom item editor, which is what the spec means by "the client
  // already has" it. stockPreset is therefore just a boolean "new-pile paint armed" flag now.
  // B137: createStockpileDrag creates with preset=none -- native new-pile semantics. Steam DF
  // places a stockpile INERT ("Click an icon to set stockpile type.") and dwarves haul nothing
  // until the player picks what it stores; the old preset=all made new piles instantly accept
  // EVERYTHING, so dwarves filled them with junk before the player finished configuring in the
  // panel that Accept opens. The pile only goes live once a category / custom items are chosen.
  const stockPalette = document.createElement("div");
  stockPalette.id = "stockPalette";
  stockPalette.style.display = "none";
  // The float serves BOTH stockpile paint flows: the new-pile Accept dialog (07b) and the native
  // existing-pile repaint session (armed from the detail panel's paint latch). The repaint rows
  // mirror the zone repaint float exactly -- summary line + the four-tool row (rect/free paint,
  // erase, remove-existing, on DF's own STOCKPILE_* art) + Cancel -- and stay hidden outside a
  // repaint session so the pinned new-pile dialog is unchanged.
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
    stockPreset = null;
    stockPileId = -1;
    stockPileBBox = null;
    stockFreeBBox = null;
    stockEraseArmed = false;
    stockRemoveArmed = false;
  }
  // Fully leave stockpile mode: closes the submenu + Accept dialog and cancels any in-progress
  // new-pile session AND any armed existing-pile repaint. Called by every other placement
  // tool's mutual-exclusion reset (via updateToolCursor()/selectDesignation/setZonePreset), by
  // Escape, and by Accept/Done.
  function resetStockRepaintSession() {
    stockRepaintId = null;
    stockRepaintMeta = null;
    stockRepaintDraft = null;
    stockRepaintFreeCells = null;
    stockRepaintFreeLast = null;
    stockRepaintEraseArmed = false;
    stockRepaintRemoveArmed = false;
  }
  function closeStockMode() {
    stockMode = null;
    resetStockRepaintSession();
    resetStockPaintSession();
    stockPalette.style.display = "none";
    updateStockButtons();
  }
  // WD-14: fully close zone mode (hide the palette) -- the cross-tool mutual-exclusion reset
  // every other placement tool's entry point calls, same shape as closeStockMode above.
  function closeZoneMode() {
    zoneMode = null;
    zoneRepaintId = null;
    zoneRepaintMeta = null;
    zoneRepaintDraft = null;
    zoneRepaintFreeCells = null;
    zoneRepaintFreeLast = null;
    zonePreset = null;
    zoneEraseArmed = false;
    zoneRemoveArmed = false;
    zonePaintBBox = null;
    zonePaintPreview = null;
    zoneFreeBBox = null;
    if (window.dfZoneCycle) { window.dfZoneCycle.ids = []; window.dfZoneCycle.idx = 0; }
    if (typeof zonePalette !== "undefined") zonePalette.style.display = "none";
    zoneOverlayEnabled = false;
    currentZones = [];
    renderZoneOverlay();
    if (typeof updateZoneButtons === "function") updateZoneButtons();
    // B146: keep the framework's geometry persistence/bookkeeping in sync (registered below).
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("zonePalette", false); } catch (_) {}
  }
  // WD-13: fully close burrow mode (hide the left panel) -- same shape as closeStockMode/
  // closeZoneMode above.
  function closeBurrowMode() {
    burrowMode = null;
    burrowPaintId = -1;
    burrowEraseArmed = false;
    burrowFreeCells = null;
    burrowFreeLast = null;
    burrowSymbolFor = -1;
    burrowCitizensFor = -1;
    // B230: burrow tiles are shown INSIDE burrow mode only (DF does the same). Leaving the wash on
    // the map after the panel closes would be a permanent tint nobody asked for.
    if (burrowWindowTimer) { clearInterval(burrowWindowTimer); burrowWindowTimer = null; }
    burrowWindowSig = "";
    if (window.DwfBurrowOverlay) window.DwfBurrowOverlay.setBurrows([]);
    if (typeof burrowPanel !== "undefined") burrowPanel.style.display = "none";
    if (typeof updateBurrowButtons === "function") updateBurrowButtons();
  }
  // Arms the native repaint SESSION for an EXISTING pile (from its detail panel's paint
  // latch) -- the stockpile mirror of setZoneRepaint below: the pile stays visible in the
  // rendered frame, the float shows its label/tile count with the rect/free/erase/remove
  // tools, map edits are STAGED as exact world tiles, and only Accept commits (one
  // mode=replace bitmap to /stockpile-repaint). Unrelated to the stockMode paint-first
  // submenu above except that it must close it first, same as every other placement tool's
  // mutual-exclusion reset.
  function setStockRepaint(id, meta) {
    if (id == null) { disarmStockRepaint(); return; }
    closeStockMode();
    closeZoneMode();
    closeBurrowMode();
    stockRepaintId = id;
    stockRepaintMeta = meta || null;
    clearBuildPlacement(false);
    currentTool = null;
    selectedDesignation = null;
    digMenuOpen = false;
    plantMenuOpen = false;
    smoothMenuOpen = false;
    itemDesigMenuOpen = false;
    updateDesignationButtons();
    setStockStatus("");
    updateStockButtons();
    updateToolCursor();
    loadStockRepaintBase(id);
  }
  function disarmStockRepaint() {
    resetStockRepaintSession();
    setStockStatus("");
    updateStockButtons();
    updateToolCursor();
    renderZoneOverlay();
  }
  window.DFStockRepaint = {
    arm: setStockRepaint,
    disarm: disarmStockRepaint,
  };
  // Seed the session draft from the pile's AUTHORITATIVE current shape (/stockpile-info's
  // extents bitmap), so an existing interior hole or construct-time exclusion survives the
  // round trip. A pre-extents host DLL sends no bitmap -- degrade to the full rectangle,
  // which is exactly what such a host stores for every pile (honest, not invented).
  async function loadStockRepaintBase(id) {
    try {
      const r = await fetch(`/stockpile-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error("info failed");
      const sp = await r.json();
      if (Number(stockRepaintId) !== Number(id)) return; // session moved on meanwhile
      const w = Number(sp?.size?.w) || 0;
      const h = Number(sp?.size?.h) || 0;
      const ext = (typeof sp?.extents === "string" && sp.extents.length === w * h)
        ? sp.extents : "1".repeat(Math.max(0, w * h));
      stockRepaintDraft = {
        zone: { id: Number(id), x: Number(sp?.pos?.x) || 0, y: Number(sp?.pos?.y) || 0,
          z: Number(sp?.pos?.z) || 0, w, h, extents: ext },
        changes: new Map(),
      };
      updateStockButtons();
      renderZoneOverlay();
    } catch (_) {
      if (Number(stockRepaintId) !== Number(id)) return;
      setStockStatus("Stockpile unavailable -- the pile may have been removed.", true);
    }
  }
  function stockRepaintTileCount() {
    const zone = stockRepaintDraft && stockRepaintDraft.zone;
    if (!zone) return 0;
    return (String(zone.extents).match(/1/g) || []).length;
  }
  function stockRepaintDelta() {
    if (!stockRepaintDraft) return 0;
    let delta = 0;
    stockRepaintDraft.changes.forEach(present => { delta += present ? 1 : -1; });
    return delta;
  }
  // Strokes become exact world tiles immediately (same rule as stageZoneRepaintDrag: panning
  // after a stroke cannot retarget it), reusing the zone draft's setZoneDraftTile membership
  // helper -- the draft shape is identical.
  function stageStockRepaintDrag(x1, y1, x2, y2) {
    if (stockRepaintId == null || stockRepaintRemoveArmed) return;
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    const rendered = renderedImageRect();
    if (!a || !b || !rendered) return;
    const draft = stockRepaintDraft;
    if (!draft) {
      setStockStatus("Loading the stockpile's current shape -- paint again in a moment.", true);
      return;
    }
    if (Number(rendered.oz) !== Number(draft.zone.z)) return;
    const present = !stockRepaintEraseArmed;
    if (paintMode === "free" && stockRepaintFreeCells && stockRepaintFreeCells.size) {
      stockRepaintFreeCells.forEach(key => {
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
    stockRepaintFreeCells = null;
    stockRepaintFreeLast = null;
    const delta = stockRepaintDelta();
    setStockStatus(`Pending change: ${delta < 0 ? "-" : "+"}${Math.abs(delta)} tile${Math.abs(delta) === 1 ? "" : "s"}. Click Accept to apply.`);
    updateStockButtons();
    renderZoneOverlay();
  }
  // Commit the staged session as one exact, world-addressed extent bitmap -- the same wire
  // contract as commitZoneRepaintDraft (mode=replace, row-major '0'/'1' body, 4s abort). On a
  // refusal the SESSION stays open with the server's own reason in the status line, so the
  // player can adjust or Cancel; nothing is silently dropped. Success reopens the detail panel
  // on the REPLACEMENT pile's id (repaint replaces the building -- the old id is gone).
  async function acceptStockRepaint() {
    if (stockRepaintId == null) return;
    const id = Number(stockRepaintId);
    if (stockRepaintRemoveArmed) {
      // Same honest remove contract as the detail panel's [data-sp-remove]: HTTP 200
      // {"ok":false} is a refusal, and the pile must visibly survive one.
      let removed = false;
      try {
        const r = await fetch(`/stockpile-remove?id=${id}`, { method: "POST", cache: "no-store" });
        if (r.ok) { const d = await r.json().catch(() => ({})); removed = !d || d.ok !== false; }
      } catch (_) {}
      if (removed) { disarmStockRepaint(); setActiveToolbar(null); }
      else setStockStatus("Remove failed -- the stockpile is unchanged.", true);
      return;
    }
    const draft = stockRepaintDraft;
    if (!draft || !draft.changes.size) {
      disarmStockRepaint();
      setActiveToolbar(null);
      if (typeof openStockpilePanel === "function") openStockpilePanel(id);
      return;
    }
    const shape = zoneRepaintFinalShape(draft);
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
      try { data = text ? JSON.parse(text) : {}; } catch (_) {}
      if (!r.ok) {
        // Refusal body is plain text ("stockpile-repaint failed/refused: ..."). A host DLL
        // older than mode=replace parses the query as the legacy rectangle route and answers
        // 400 "missing id/px/py/w/h" -- name that old-DLL shape honestly.
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
    } catch (_) {
      setStockStatus("The stockpile-repaint route did not respond -- the host's game may be older than this client.", true);
    } finally {
      clearTimeout(timer);
    }
  }
  // Existing-zone repaint is a SUBMODE of Zones, not a reason to leave Zones. The old shortcut
  // called closeZoneMode(), which disabled the overlay and emptied currentZones; that is why the
  // selected zone vanished until the player closed and reopened Zones. Native keeps the zone
  // painted and opens a staged repaint session (paint/free/erase/remove + Accept).
  function setZoneRepaint(id, meta) {
    closeStockMode();
    closeBurrowMode();
    stockRepaintId = null;
    zoneRepaintId = id;
    zoneRepaintMeta = meta || null;
    zoneRepaintDraft = null;
    zoneRepaintFreeCells = null;
    zoneRepaintFreeLast = null;
    zoneMode = "repaint";
    zonePreset = null;
    zoneEraseArmed = false;
    zoneRemoveArmed = false;
    zonePaintBBox = null;
    zonePaintPreview = null;
    zoneFreeBBox = null;
    zoneOverlayEnabled = true;
    // The type chooser is not part of repainting one existing zone. Keep it hidden without
    // destroying the shared zone context or its cached overlay records.
    if (typeof zonePalette !== "undefined") zonePalette.style.display = "none";
    clearBuildPlacement(false);
    currentTool = null;
    selectedDesignation = null;
    digMenuOpen = false;
    plantMenuOpen = false;
    smoothMenuOpen = false;
    itemDesigMenuOpen = false;
    updateDesignationButtons();
    updateZoneButtons();
    updateToolCursor();
    loadZones().then(updateZoneRepaintSummary);
  }
  function disarmZoneRepaint() {
    zoneRepaintId = null;
    zoneRepaintMeta = null;
    zoneRepaintDraft = null;
    zoneRepaintFreeCells = null;
    zoneRepaintFreeLast = null;
    zoneEraseArmed = false;
    zoneRemoveArmed = false;
    zonePaintPreview = null;
    zoneFreeBBox = null;
    if (zoneMode === "repaint") zoneMode = "menu";
    updateZoneButtons();
    updateToolCursor();
    renderZoneOverlay();
  }
  window.DFZoneRepaint = {
    arm: setZoneRepaint,
    disarm: disarmZoneRepaint,
  };
  function updateStockButtons() {
    if (stockSubmenu) {
      stockSubmenu.classList.toggle("visible", !!stockMode);
      stockSubmenu.setAttribute("aria-hidden", stockMode ? "false" : "true");
    }
    const painting = stockMode === "paint";
    if (stockNewButton) {
      stockNewButton.style.display = painting ? "none" : "";
      paintSprite(stockNewButton, "stockNew", false);
    }
    document.querySelectorAll("#stockSubmenu [data-paint-mode]").forEach(b => {
      b.style.display = painting ? "" : "none";
      const mode = b.dataset.paintMode;
      paintSprite(b, mode === "free" ? "paintFree" : "paintRect", paintMode === mode);
    });
    if (stockEraseButton) {
      stockEraseButton.style.display = painting ? "" : "none";
      paintSprite(stockEraseButton, "stockErase", stockEraseArmed);
    }
    if (stockRemoveButton) {
      stockRemoveButton.style.display = painting ? "" : "none";
      paintSprite(stockRemoveButton, "stockRemoveExisting", stockRemoveArmed);
    }
    // Native existing-pile repaint session chrome (mirror of updateZoneButtons' repaint float):
    // the float shows for BOTH flows; the summary line, four-tool row and Cancel only in a
    // repaint session, so the pinned new-pile Accept dialog is unchanged.
    const repainting = stockRepaintId != null;
    stockPalette.style.display = (painting || repainting) ? "block" : "none";
    const stockCancelBtn = stockPalette.querySelector("[data-stock-cancel]");
    if (stockCancelBtn) stockCancelBtn.style.display = repainting ? "" : "none";
    const stockSummary = stockPalette.querySelector("[data-stock-repaint-summary]");
    if (stockSummary) stockSummary.hidden = !repainting;
    const stockSummaryCopy = stockPalette.querySelector("[data-stock-repaint-summary-copy]");
    if (stockSummaryCopy) {
      if (repainting) {
        const label = (stockRepaintMeta && stockRepaintMeta.label) || "Stockpile";
        const count = stockRepaintTileCount();
        const delta = stockRepaintRemoveArmed ? -count : stockRepaintDelta();
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
      if (tool === "rect") paintSprite(button, "paintRect", !stockRepaintEraseArmed && !stockRepaintRemoveArmed && paintMode === "rect");
      else if (tool === "free") paintSprite(button, "paintFree", !stockRepaintEraseArmed && !stockRepaintRemoveArmed && paintMode === "free");
      else if (tool === "erase") paintSprite(button, "stockErase", stockRepaintEraseArmed);
      else paintSprite(button, "stockRemoveExisting", stockRepaintRemoveArmed);
    });
    const stockTxt = stockPalette.querySelector("[data-stock-paint-text]");
    if (stockTxt) stockTxt.textContent = repainting ? (stockRepaintRemoveArmed
      ? "Accept to remove this stockpile."
      : stockRepaintEraseArmed ? "Click in the play area to erase parts of the stockpile."
      : "Click in the play area to paint the stockpile.")
      : "Click in the play area to paint the stockpile.";
  }
  // Entry stage (07-stockpile-mode.png): stockPreset/stockRepaintId both stay null, so a plain
  // map click still falls through to inspectClick -- clicking an existing pile opens its
  // detail panel exactly as it does outside stockpile mode.
  function enterStockMenu() {
    clearBuildPlacement(false);
    closeZoneMode();
    closeBurrowMode();
    currentTool = null;
    selectedDesignation = null;
    digMenuOpen = false;
    plantMenuOpen = false;
    smoothMenuOpen = false;
    itemDesigMenuOpen = false;
    updateDesignationButtons();
    stockMode = "menu";
    resetStockPaintSession();
    resetStockRepaintSession();
    updateStockButtons();
    updateToolCursor();
  }
  function toggleStockPalette() { // name kept: called from openPanel()'s "stockpile" route
    if (stockMode) { closeStockMode(); setActiveToolbar(null); return; }
    enterStockMenu();
  }
  // Paint stage (07b-stockpile-paint.png): arms rect-paint by default (paintMode already
  // defaults "rect", shared with the dig/plant/smooth/item-desig submenus).
  function enterStockPaint() {
    stockMode = "paint";
    resetStockPaintSession();
    stockPreset = true;
    setStockStatus("");
    updateStockButtons();
    updateToolCursor();
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
    stockEraseArmed = !stockEraseArmed;
    stockRemoveArmed = false;
    stockPreset = !stockEraseArmed;
    updateStockButtons();
    updateToolCursor();
    focusPage();
  });
  if (stockRemoveButton) stockRemoveButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    stockRemoveArmed = !stockRemoveArmed;
    stockEraseArmed = false;
    stockPreset = !stockRemoveArmed;
    updateStockButtons();
    updateToolCursor();
    focusPage();
  });
  stockPalette.querySelector("[data-stock-accept]").addEventListener("click", async event => {
    event.stopPropagation();
    if (stockRepaintId != null) {
      // Repaint session: Accept is the one commit point (stageStockRepaintDrag only stages).
      await acceptStockRepaint();
      focusPage();
      return;
    }
    const id = stockPileId;
    closeStockMode();
    setActiveToolbar(null);
    if (id >= 0) openStockpilePanel(id);
    focusPage();
  });
  stockPalette.querySelector("[data-stock-cancel]").addEventListener("click", event => {
    event.stopPropagation();
    const id = stockRepaintId;
    disarmStockRepaint();
    // Cancel returns to where the session was armed from: the pile's detail panel.
    if (id != null && typeof openStockpilePanel === "function") openStockpilePanel(Number(id));
    focusPage();
  });
  stockPalette.querySelectorAll("[data-stock-repaint-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (stockRepaintId == null) return;
      const tool = button.dataset.stockRepaintTool;
      if (tool === "rect" || tool === "free") {
        paintMode = tool;
        stockRepaintEraseArmed = false;
        stockRepaintRemoveArmed = false;
      } else if (tool === "erase") {
        stockRepaintEraseArmed = !stockRepaintEraseArmed;
        stockRepaintRemoveArmed = false;
      } else if (tool === "remove") {
        stockRepaintRemoveArmed = !stockRepaintRemoveArmed;
        stockRepaintEraseArmed = false;
      }
      setStockStatus("");
      updateStockButtons();
      updateToolCursor();
      focusPage();
    });
  });

  function unionBBox(a, b) {
    return { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
  }
  // Create (first paint) or extend (every later paint) the in-progress NEW pile. The backend
  // only stores stockpiles as a single rectangle (dfcapture.lua create_stockpile constructs a
  // plain width/height building) with no additive tile-set merge -- verified against
  // src/stockpile_panel.cpp:450 finish_stockpile_repaint_on_core_thread, which REPLACES old_sp
  // with new_sp wholesale rather than unioning their tiles. So "extend" here reuses the two
  // EXISTING endpoints only (no ENDPOINT-EXTEND, per the item's file territory): the first
  // painted rect POSTs /stockpile, every later one POSTs /stockpile-repaint with the UNION
  // bounding box of everything painted so far. For a normal contiguous paint (the only shape
  // 07b's capture demonstrates) this is exact; for disjoint rects it fills the gap between
  // them into one rectangle -- a scope limit inherent to the rectangle-only backend, flagged
  // in the completion report, not something a client-only file can lift.
  async function createStockpileDrag(x1, y1, x2, y2) {
    if (!stockPreset) return;
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    if (!a || !b) return;
    let rect = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
    if (paintMode === "free" && stockFreeBBox) {
      rect = unionBBox(rect, stockFreeBBox);
      stockFreeBBox = null;
    }
    const bbox = stockPileBBox ? unionBBox(stockPileBBox, rect) : rect;
    setStockStatus(stockPileId >= 0 ? "Extending stockpile..." : "Creating stockpile...");
    try {
      const url = stockPileId < 0
        ? `/stockpile?player=${encodeURIComponent(player)}&px=${bbox.x1}&py=${bbox.y1}` +
          `&px2=${bbox.x2}&py2=${bbox.y2}&w=${a.w}&h=${a.h}&preset=none`
        : `/stockpile-repaint?player=${encodeURIComponent(player)}&id=${stockPileId}` +
          `&px=${bbox.x1}&py=${bbox.y1}&px2=${bbox.x2}&py2=${bbox.y2}&w=${a.w}&h=${a.h}`;
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      const text = await r.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (_) {}
      if (!r.ok) throw new Error(text.trim() || "stockpile request failed");
      if (Number(data.id) >= 0) stockPileId = Number(data.id);
      stockPileBBox = bbox;
      const w = bbox.x2 - bbox.x1 + 1, h = bbox.y2 - bbox.y1 + 1;
      // B137: the new pile accepts NOTHING yet (preset=none above); Accept opens the panel
      // where the player picks what it stores -- say so, matching the actual flow.
      setStockStatus(`Painted ${w}x${h}. Paint more, or click Accept to choose what it stores.`);
    } catch (err) {
      setStockStatus(String(err.message || err || "Stockpile failed").replace(/^stockpile failed:\s*/i, ""), true);
    }
  }
  // Erase tool (armed via stockEraseArmed): re-paints (trims) an EXISTING pile under the drag.
  // The backend's rectangle-only representation (see createStockpileDrag above) means only an
  // edge-aligned trim is representable -- an interior erase has no representable result and is
  // reported, not silently dropped.
  function trimEdge(pile, erase) {
    const fullWidth = erase.x1 <= pile.x1 && erase.x2 >= pile.x2;
    const fullHeight = erase.y1 <= pile.y1 && erase.y2 >= pile.y2;
    if (fullWidth && erase.y1 <= pile.y1 && erase.y2 < pile.y2)
      return { x1: pile.x1, y1: erase.y2 + 1, x2: pile.x2, y2: pile.y2 }; // trims top rows
    if (fullWidth && erase.y2 >= pile.y2 && erase.y1 > pile.y1)
      return { x1: pile.x1, y1: pile.y1, x2: pile.x2, y2: erase.y1 - 1 }; // trims bottom rows
    if (fullHeight && erase.x1 <= pile.x1 && erase.x2 < pile.x2)
      return { x1: erase.x2 + 1, y1: pile.y1, x2: pile.x2, y2: pile.y2 }; // trims left columns
    if (fullHeight && erase.x2 >= pile.x2 && erase.x1 > pile.x1)
      return { x1: pile.x1, y1: pile.y1, x2: erase.x1 - 1, y2: pile.y2 }; // trims right columns
    return null;
  }
  async function stockEraseDrag(x1, y1, x2, y2) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    if (!a || !b) return;
    const erase = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
    try {
      const insp = await fetch(`/inspect?player=${encodeURIComponent(player)}&px=${erase.x1}&py=${erase.y1}&w=${a.w}&h=${a.h}`, { cache: "no-store" });
      const info = insp.ok ? await insp.json() : null;
      const id = info && String(info.kind || "").toLowerCase() === "stockpile" ? selectionBuildingId(info) : -1;
      if (!(id >= 0)) { setStockStatus("No stockpile under the erase area.", true); return; }
      const spr = await fetch(`/stockpile-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      const sp = spr.ok ? await spr.json() : null;
      const pos = sp?.pos, sz = sp?.size;
      if (!pos || !sz) { setStockStatus("Stockpile info unavailable.", true); return; }
      const pile = { x1: pos.x, y1: pos.y, x2: pos.x + sz.w - 1, y2: pos.y + sz.h - 1 };
      const trimmed = trimEdge(pile, erase);
      if (!trimmed) {
        setStockStatus("Can't erase an interior region from a rectangular stockpile -- trim from an edge, or remove and repaint.", true);
        return;
      }
      const url = `/stockpile-repaint?player=${encodeURIComponent(player)}&id=${id}` +
        `&px=${trimmed.x1}&py=${trimmed.y1}&px2=${trimmed.x2}&py2=${trimmed.y2}&w=${a.w}&h=${a.h}`;
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      setStockStatus(r.ok ? "Stockpile trimmed." : "Erase failed.", !r.ok);
    } catch (_) {
      setStockStatus("Erase failed.", true);
    }
  }
  // Remove-existing tool (armed via stockRemoveArmed): a plain click deletes the pile at the
  // clicked tile outright (no drag needed -- matches the single red no-entry icon in 07b).
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
    } catch (_) {
      setStockStatus("Remove failed.", true);
    }
  }

  // --- Zone placement (WD-14): DF's real zone flow, 08-zones.png ground truth. Entry shows
  // the two-plate left palette (top plate "Select a type below to add a zone.", bottom panel
  // "Click an icon to add a new zone." + the 2-column 18-type icon grid in DF's exact order);
  // picking a type arms PAINT (rect/free + erase + remove-existing in #zoneSubmenu, floating
  // Accept dialog), matching the stockpile paint-first shape WD-12 established. While no type
  // is armed, clicking the map hits existing zones (overlap cycling below) or falls through
  // to inspectClick.
  const ZONE_TYPES = window.DwfControlShell.ZONE_TYPES;
  const zonePalette = document.createElement("div");
  zonePalette.id = "zonePalette";
  zonePalette.style.display = "none";
  zonePalette.innerHTML = window.DwfControlShell.zonePaletteMarkup();
  document.body.appendChild(zonePalette);
  // openPanel()/selectBuildItem() (build-info-panels.js, outside this item's territory) hide
  // the palette DIRECTLY without knowing about zoneMode -- resync so the paint submenu +
  // Accept dialog never outlive it. closeZoneMode() re-setting display:none is a no-op
  // second pass (zoneMode is already null).
  new MutationObserver(() => {
    if (zoneMode && zoneMode !== "repaint" && zonePalette.style.display === "none") closeZoneMode();
  }).observe(zonePalette, { attributes: true, attributeFilter: ["style"] });
  // B146: the zone palette joins the panel framework like its peers -- framework header, X,
  // drag-to-move, corner/edge resize, persisted geometry. Deferred to DOMContentLoaded because
  // dwf-panelframe.js loads AFTER this file (index.html), same as core.js's content hosts.
  // zBand:false keeps its CSS z-index 60 so the placed-zone editor (#selection.zone-panel, z75)
  // stays above the open palette, the contract dwf.css:858 documents. escClosable:false:
  // the Esc cascade below already owns zone-mode back-out (paint -> menu -> closed), one stage
  // per press. persistOpen:false: opening zone mode is a toolbar action, not a restorable panel
  // state -- only geometry persists. menu:false: reopening from the cog would arm a placement
  // tool as a side effect, which no other Panels-menu row does.
  function registerZonePalette() {
    if (!window.DFPanelFrame || !window.DFPanelFrame.register) return;
    window.DFPanelFrame.register({
      key: "zonePalette", el: () => zonePalette, title: "Zones",
      closable: true, menu: false, zBand: false, escClosable: false, persistOpen: false,
      resizable: { minW: 260, minH: 200 },
      fillSel: ".zone-type-panel",
      isOpen: () => zonePalette.style.display !== "none",
      open: () => { if (!zoneMode && typeof openPanel === "function") openPanel("zone"); },
      close: () => { if (zoneMode) { closeZoneMode(); setActiveToolbar(null); } },
    });
  }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", registerZonePalette);
  else registerZonePalette();

  // Floating paint dialog (Accept), same corner + chrome as the stockpile one (#stockPalette).
  const zonePaintFloat = document.createElement("div");
  zonePaintFloat.id = "zonePaintFloat";
  zonePaintFloat.style.display = "none";
  zonePaintFloat.innerHTML = `
    <div class="stock-paint-row">
      <span class="stock-paint-text" data-zone-paint-text>Click in the play area to paint the zone.</span>
      <span class="zone-paint-actions">
        ${DWFUI.plaqueBtnHtml({ cls: "zone-paint-cancel", dataset: { zoneCancel: "" }, label: "Cancel", tone: "red", title: "Discard this zone paint" })}
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
    return currentZones.find(zone => Number(zone.id) === Number(zoneRepaintId)) || null;
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
    if (zoneRepaintDraft) return zoneRepaintDraft;
    const source = zoneRepaintTarget();
    if (!source) return null;
    const zone = { id: Number(source.id), x: Number(source.x), y: Number(source.y),
      z: Number(source.z), w: Number(source.w), h: Number(source.h),
      extents: String(source.extents || "") };
    zoneRepaintDraft = { zone, changes: new Map() };
    return zoneRepaintDraft;
  }
  function setZoneDraftTile(draft, wx, wy, present) {
    if (!draft) return;
    const key = `${wx},${wy}`;
    if (zoneWorldPresent(draft.zone, wx, wy) === !!present) draft.changes.delete(key);
    else draft.changes.set(key, !!present);
  }
  function zoneRepaintDelta() {
    const draft = zoneRepaintDraft;
    if (!draft) return 0;
    let delta = 0;
    draft.changes.forEach(present => { delta += present ? 1 : -1; });
    return delta;
  }
  function updateZoneRepaintSummary() {
    if (!zoneRepaintSummary) return;
    const repainting = zoneMode === "repaint" && zoneRepaintId != null;
    zoneRepaintSummary.hidden = !repainting;
    if (!repainting) {
      if (zoneRepaintSummaryIcon) zoneRepaintSummaryIcon.innerHTML = "";
      if (zoneRepaintSummaryCopy) zoneRepaintSummaryCopy.innerHTML = "";
      return;
    }
    const label = (zoneRepaintMeta && zoneRepaintMeta.label) || "Zone";
    const count = zoneTileCount(zoneRepaintTarget());
    const delta = zoneRemoveArmed ? -count : zoneRepaintDelta();
    if (zoneRepaintSummaryIcon) {
      const sprite = zoneRepaintMeta && zoneRepaintMeta.sprite;
      zoneRepaintSummaryIcon.innerHTML = sprite ? DWFUI.iconHtml({ sprite, size: 32, alt: "" }) : "";
      if (sprite && typeof DWFUI.paintSprites === "function") DWFUI.paintSprites(zoneRepaintSummaryIcon);
    }
    if (zoneRepaintSummaryCopy)
      zoneRepaintSummaryCopy.innerHTML = DWFUI.bitmapTextHtml(
        `${label}: ${count} ${delta < 0 ? "-" : "+"} ${Math.abs(delta)}`,
        { cls: "zone-repaint-summary-text" });
  }
  function updateZoneButtons() {
    const painting = zoneMode === "paint" || zoneMode === "repaint";
    const repainting = zoneMode === "repaint";
    if (zoneSubmenu) {
      // Native's selected-zone repaint tools live in the floating repaint session itself (the
      // four-icon row under the zone count), not as a duplicate toolbar submenu.
      zoneSubmenu.classList.toggle("visible", painting && !repainting);
      zoneSubmenu.setAttribute("aria-hidden", painting && !repainting ? "false" : "true");
    }
    document.querySelectorAll("#zoneSubmenu [data-paint-mode]").forEach(b => {
      const mode = b.dataset.paintMode;
      paintSprite(b, mode === "free" ? "paintFree" : "paintRect", paintMode === mode);
    });
    if (zoneEraseButton) paintSprite(zoneEraseButton, "zoneErase", zoneEraseArmed);
    if (zoneRemoveButton) paintSprite(zoneRemoveButton, "zoneRemoveExisting", zoneRemoveArmed);
    zonePaintFloat.style.display = painting ? "block" : "none";
    if (zoneRepaintTools) zoneRepaintTools.hidden = !repainting;
    zonePaintFloat.querySelectorAll("[data-zone-repaint-tool]").forEach(button => {
      const tool = button.dataset.zoneRepaintTool;
      if (tool === "rect") paintSprite(button, "paintRect", !zoneEraseArmed && !zoneRemoveArmed && paintMode === "rect");
      else if (tool === "free") paintSprite(button, "paintFree", !zoneEraseArmed && !zoneRemoveArmed && paintMode === "free");
      else if (tool === "erase") paintSprite(button, "zoneErase", zoneEraseArmed);
      else paintSprite(button, "zoneRemoveExisting", zoneRemoveArmed);
    });
    const label = zonePreset && ZONE_TYPES.find(t => t[1] === zonePreset);
    const txt = zonePaintFloat.querySelector("[data-zone-paint-text]");
    if (txt) txt.textContent = repainting ? (zoneRemoveArmed
      ? "Accept to remove this zone."
      : zoneEraseArmed ? "Click in the play area to erase parts of the zone."
      : "Click in the play area to paint the zone.")
      : zoneRemoveArmed ? "Click an existing zone to remove it."
      : zoneEraseArmed ? "Paint over an existing zone to erase it."
      : `Click in the play area to paint the ${label ? label[0] : "zone"}.`;
    updateZoneRepaintSummary();
  }
  function setZonePreset(key) {
    // A new-zone choice supersedes the whole existing-zone editor. Without this transition the
    // old zoneRepaintId can win the pointer-up branch below, and even a non-repaint detail panel
    // physically covers the new zone's Accept button. One choice should produce one clear mode:
    // dismiss the old detail, leave repaint state, then arm the new-zone paint session.
    if (key) {
      if (typeof closeSelection === "function") closeSelection();
      if (zoneMode === "repaint") disarmZoneRepaint();
    }
    zonePreset = key;
    if (key) { // arming paint: leave every other placement mode (same order as WD-12)
      clearBuildPlacement(false);
      closeStockMode();
      closeBurrowMode();
      currentTool = null;
      selectedDesignation = null;
      digMenuOpen = false;
      plantMenuOpen = false;
      smoothMenuOpen = false;
      itemDesigMenuOpen = false;
      updateDesignationButtons();
      zoneMode = "paint";
      zoneEraseArmed = false;
      zoneRemoveArmed = false;
      zonePaintBBox = null;
      zonePaintPreview = null;
      zoneFreeBBox = null;
      setZoneStatus("");
    } else if (zoneMode === "paint") {
      zoneMode = "menu"; // back to the type grid; existing zones become clickable again
      zoneEraseArmed = false;
      zoneRemoveArmed = false;
      zonePaintBBox = null;
      zonePaintPreview = null;
      zoneFreeBBox = null;
    }
    zonePalette.querySelectorAll("[data-zone-type]").forEach(b =>
      b.classList.toggle("active", b.dataset.zoneType === key));
    updateZoneButtons();
    updateToolCursor();
    renderZoneOverlay();
  }
  function enterZoneMenu() {
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("zones"); // WD-26 first-time help (08b-zones-helppopup.png)
    clearBuildPlacement(false);
    closeStockMode();
    closeBurrowMode();
    currentTool = null;
    selectedDesignation = null;
    digMenuOpen = false;
    plantMenuOpen = false;
    smoothMenuOpen = false;
    itemDesigMenuOpen = false;
    updateDesignationButtons();
    zoneMode = "menu";
    zonePreset = null;
    zoneEraseArmed = false;
    zoneRemoveArmed = false;
    zonePaintBBox = null;
    zonePaintPreview = null;
    zoneFreeBBox = null;
    zonePalette.style.display = "block";
    zoneOverlayEnabled = true; // zones show in zone mode only (DF v50; RECONCILE WC-7)
    // B146: restore saved geometry / clamp into the work area, and take panel focus.
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("zonePalette", true); } catch (_) {}
    loadZones();
    updateZoneButtons();
    updateToolCursor();
  }
  function toggleZonePalette() { // name kept: called from openPanel()'s "zone" route
    // openPanel() (build-info-panels.js, other territory) hides the palette directly when
    // another panel opens without knowing zoneMode -- resync before deciding to toggle.
    if (zoneMode && zonePalette.style.display === "none") closeZoneMode();
    if (zoneMode) { closeZoneMode(); setActiveToolbar(null); return; }
    enterZoneMenu();
  }
  zonePalette.querySelectorAll("[data-zone-type]").forEach(b =>
    b.addEventListener("click", event => {
      event.stopPropagation();
      // Clicking the armed type again disarms back to the menu stage (same as DF's toggle).
      setZonePreset(zonePreset === b.dataset.zoneType ? null : b.dataset.zoneType);
      focusPage();
    }));
  if (zoneEraseButton) zoneEraseButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    zoneEraseArmed = !zoneEraseArmed;
    zoneRemoveArmed = false;
    updateZoneButtons();
    updateToolCursor();
    focusPage();
  });
  if (zoneRemoveButton) zoneRemoveButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    zoneRemoveArmed = !zoneRemoveArmed;
    zoneEraseArmed = false;
    updateZoneButtons();
    updateToolCursor();
    focusPage();
  });
  zonePaintFloat.querySelectorAll("[data-zone-repaint-tool]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (zoneMode !== "repaint") return;
      const tool = button.dataset.zoneRepaintTool;
      if (tool === "rect" || tool === "free") {
        paintMode = tool;
        zoneEraseArmed = false;
        zoneRemoveArmed = false;
      } else if (tool === "erase") {
        zoneEraseArmed = !zoneEraseArmed;
        zoneRemoveArmed = false;
      } else if (tool === "remove") {
        zoneRemoveArmed = !zoneRemoveArmed;
        zoneEraseArmed = false;
      }
      setZoneStatus("");
      updateZoneButtons();
      updateToolCursor();
      renderZoneOverlay();
      focusPage();
    });
  });
  zonePaintFloat.querySelector("[data-zone-accept]").addEventListener("click", async event => {
    event.stopPropagation();
    if (zoneMode === "repaint") await acceptZoneRepaint();
    else await acceptZonePaint();
    focusPage();
  });
  zonePaintFloat.querySelector("[data-zone-cancel]").addEventListener("click", event => {
    event.stopPropagation();
    if (zoneMode === "repaint") disarmZoneRepaint();
    else setZonePreset(null);
    focusPage();
  });
  setInterval(() => { if (zoneOverlayEnabled) loadZones(); }, 1000);

  function zoneRepaintDraftFromDrag(x1, y1, x2, y2, mode) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    if (!a || !b) return null;
    let rect = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y),
      x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y), w: a.w, h: a.h,
      mode: mode === "erase" ? "erase" : "add" };
    if (paintMode === "free" && zoneFreeBBox) {
      rect = { ...unionBBox(rect, zoneFreeBBox), w: a.w, h: a.h, mode: rect.mode };
      zoneFreeBBox = null;
    }
    return rect;
  }

  // Shared Bresenham stroke tracer for the staged repaint sessions (zone + stockpile): adds
  // every grid cell on the segment from -> cell into the given Set.
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
    if (!zoneRepaintFreeCells || !cell) return;
    freeTraceInto(zoneRepaintFreeCells, zoneRepaintFreeLast || cell, cell);
    zoneRepaintFreeLast = cell;
  }
  function stockRepaintFreePaintTo(cell) {
    if (!stockRepaintFreeCells || !cell) return;
    freeTraceInto(stockRepaintFreeCells, stockRepaintFreeLast || cell, cell);
    stockRepaintFreeLast = cell;
  }

  // Native stages exact tile membership and waits for Accept. Convert screen cells to world tiles
  // immediately so panning after a stroke cannot retarget it, and retain mixed add/erase changes
  // in one draft instead of unioning strokes into a gap-filling rectangle.
  function stageZoneRepaintDrag(x1, y1, x2, y2) {
    if (zoneRepaintId == null || zoneRemoveArmed) return;
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    const rendered = renderedImageRect();
    const draft = ensureZoneRepaintDraft();
    if (!a || !b || !rendered || !draft || Number(rendered.oz) !== Number(draft.zone.z)) return;
    const present = !zoneEraseArmed;
    if (paintMode === "free" && zoneRepaintFreeCells && zoneRepaintFreeCells.size) {
      zoneRepaintFreeCells.forEach(key => {
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
    zoneRepaintFreeCells = null;
    zoneRepaintFreeLast = null;
    zonePaintPreview = null;
    const delta = zoneRepaintDelta();
    setZoneStatus(`Pending change: ${delta < 0 ? "-" : "+"}${Math.abs(delta)} tile${Math.abs(delta) === 1 ? "" : "s"}. Click Accept to apply.`);
    updateZoneRepaintSummary();
    renderZoneOverlay();
  }

  async function acceptZoneRepaint() {
    if (zoneRepaintId == null) return;
    const id = Number(zoneRepaintId);
    if (zoneRemoveArmed) {
      // Zone removal is open to every authenticated player (owner policy 2026-07-16); the server
      // is the gate (join-auth), so there is no client-side lock check here anymore.
      try {
        const response = await fetch(`/zone-action?id=${id}&action=remove`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error((await response.text()).trim() || "Zone removal was refused.");
        disarmZoneRepaint();
        loadZones();
      } catch (err) {
        setZoneStatus(String(err.message || err || "Zone removal was refused."), true);
      }
      return;
    }
    if (!zoneRepaintDraft || !zoneRepaintDraft.changes.size) {
      disarmZoneRepaint();
      if (typeof openZonePanel === "function") openZonePanel(id);
      return;
    }
    await commitZoneRepaintDraft(id, zoneRepaintDraft);
  }

  // Paint drags accumulate a union bbox client-side; a NEW zone is created ONCE on Accept (a
  // deliberate create-once flow -- see the WD-14 state comment above; growing an EXISTING zone is
  // the separate /zone-repaint mode=add path, repaintZoneDrag). For a contiguous paint this is
  // exact; disjoint rects gap-fill into one rectangle, the same rectangle-only scope limit WD-12
  // documented for stockpiles.
  function zonePaintDrag(x1, y1, x2, y2) {
    if (!zonePreset) return;
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    if (!a || !b) return;
    let rect = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
    if (paintMode === "free" && zoneFreeBBox) {
      rect = unionBBox(rect, zoneFreeBBox);
      zoneFreeBBox = null;
    }
    zonePaintBBox = zonePaintBBox ? unionBBox(zonePaintBBox, rect) : rect;
    // Retain the committed selection until Accept; cloning avoids later bbox mutation making
    // the visual state differ from the POST /zone payload.
    zonePaintPreview = { ...zonePaintBBox };
    renderZoneOverlay();
    const w = zonePaintBBox.x2 - zonePaintBBox.x1 + 1, h = zonePaintBBox.y2 - zonePaintBBox.y1 + 1;
    setZoneStatus(`Painted ${w}x${h}. Paint more, or click Accept.`);
  }
  async function acceptZonePaint() {
    if (!zonePreset || !zonePaintBBox) { setZonePreset(null); return; }
    const bbox = zonePaintBBox;
    const kind = zonePreset;
    const probe = imagePixelClamped(0, 0); // just for the viewport frame size (w/h params)
    try {
      const url = `/zone?player=${encodeURIComponent(player)}&px=${bbox.x1}&py=${bbox.y1}` +
        `&px2=${bbox.x2}&py2=${bbox.y2}&w=${probe ? probe.w : 0}&h=${probe ? probe.h : 0}` +
        `&zone=${encodeURIComponent(kind)}`;
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      const text = await r.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (_) {}
      if (!r.ok) throw new Error(text.trim() || "zone failed");
      setZonePreset(null); // back to the menu stage; palette + overlay stay up (DF keeps zone mode open)
      loadZones();
      if (Number(data.id) >= 0) openZonePanel(Number(data.id));
    } catch (err) {
      setZoneStatus(String(err.message || err || "Zone failed").replace(/^zone failed:\s*/i, ""), true);
    }
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
  // WD-14: overlap cycling -- multiple zones may cover one tile; clicking such a tile opens
  // the first and the detail panel (openZonePanel, building-zone-stockpile-panels.js) shows
  // PREVIOUS/NEXT buttons cycling through zoneCycle.ids client-side.
  let zoneCycle = { ids: [], idx: 0 };
  window.dfZoneCycle = zoneCycle;
  function zoneSelectClick(event) {
    const pixel = imagePixelFromEvent(event);
    const hits = zonesAtEventTile(pixel);
    if (!hits.length) { inspectClick(event); return; } // not a zone: normal inspect
    zoneCycle.ids = hits.map(zn => Number(zn.id));
    zoneCycle.idx = 0;
    // B42: once an existing zone is selected, the create-zone palette should not cover
    // that zone on the map; the toolbar can reopen the palette when the player wants it.
    zonePalette.style.display = "none";
    openZonePanel(zoneCycle.ids[0]);
  }
  // Erase-paint over an existing zone drives /zone-repaint mode=erase, which IS live
  // (src/building_zone.cpp:2338+, registered 2423-2424). postMaybePending returns null on ANY
  // failure -- a genuine server refusal (409 "cannot erase an entire zone", 400 footprint out of
  // range) OR the no-response-at-all shape of a host DLL too old to serve the route -- and cannot
  // tell them apart (it discards the body). So the status line below names BOTH possibilities
  // honestly and points at Remove for deleting a whole zone; it no longer claims the route is
  // missing. (Threading the server's exact reason here, like repaintZoneDrag does, is a follow-up.)
  async function zoneEraseDrag(x1, y1, x2, y2) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    if (!a || !b) return;
    const hits = zonesAtEventTile({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: a.w, h: a.h });
    if (!hits.length) { setZoneStatus("No zone under the erase area.", true); return; }
    const id = Number(hits[hits.length - 1].id);
    const url = `/zone-repaint?player=${encodeURIComponent(player)}&id=${id}` +
      `&px=${Math.min(a.x, b.x)}&py=${Math.min(a.y, b.y)}&px2=${Math.max(a.x, b.x)}&py2=${Math.max(a.y, b.y)}` +
      `&w=${a.w}&h=${a.h}&mode=erase`;
    const r = await postMaybePending(url);
    if (!r) {
      console.warn("[WD-14] /zone-repaint mode=erase returned no usable response (server refusal, or a host DLL older than this client)");
      setZoneStatus("Zone erase-paint was refused, or the host's game is older than this client -- use Remove to delete a whole zone.", true);
      return;
    }
    setZoneStatus("Zone trimmed.");
    loadZones();
  }
  // Remove-existing tool: a plain click deletes the zone at the clicked tile outright via the
  // EXISTING /zone-action?action=remove (live). Topmost (most recent) zone wins on overlap.
  async function zoneRemoveClick(event) {
    const pixel = imagePixelFromEvent(event);
    const hits = zonesAtEventTile(pixel);
    if (!hits.length) { setZoneStatus("No zone there.", true); return; }
    const id = Number(hits[hits.length - 1].id);
    // Zone removal is open to every authenticated player (owner policy 2026-07-16); no client lock.
    try {
      const r = await fetch(`/zone-action?id=${id}&action=remove`, { method: "POST", cache: "no-store" });
      let msg = r.ok ? "Zone removed." : "Remove failed.";
      if (!r.ok) { try { const g = await r.json(); if (g && g.error) msg = g.error; } catch (_) {} }
      setZoneStatus(msg, !r.ok);
      if (r.ok) loadZones();
    } catch (_) {
      setZoneStatus("Remove failed.", true);
    }
  }
  // --- Burrows (WD-13): DF's real burrows mode, 09-burrows.png ground truth. Mode button
  // (toolbar, hotkey U) opens a full-height LEFT panel: "Add new burrow" plate at the top +
  // the burrow list (per-burrow paint/rename/suspend/civ-alert/citizens/delete controls) --
  // this REPLACES the old invented add-unit-by-id window (now removed; audit flag row 5).
  // Painting add/erase goes through ENDPOINT-ADD
  // /burrow-paint?id=&px=&py=&px2=&py2=&w=&h=&mode=add|erase (spec contract) -- the server
  // half is NOT landed yet, so every paint call degrades gracefully (console.warn
  // "[WD-13] endpoint pending", one status line, no crash). /burrows (list) /burrow-create
  // /burrow-rename /burrow-unit are live today (src/burrows_panel.cpp) and drive everything
  // else. NOTE: the capture pins the panel frame + "Add new burrow" only (its list is
  // empty); row anatomy uses the real BURROW_* art tokens (interface_map.json) but the exact
  // live row layout is flagged for a future capture with burrows present.
  let burrowsCache = [];       // last /burrows list payload
  let burrowPalette = [];      // DF's live 16-colour curses palette, from /burrows (B230)
  // B238. /burrows builds each burrow's `rects` for ONE z (the camera's), in WORLD coords.
  //   burrowsZ         -- the z that payload was built for (null on a pre-B238 DLL, which sends none)
  //   burrowsWorldRects-- true when the server did NOT clip the rects to a window. A pre-B238 DLL
  //                       clipped them to DF's NATIVE viewport (gps->main_viewport), which is not
  //                       the browser's window at all -- the bug the owner hit: paint across your view and
  //                       only the part inside DF's smaller native rectangle came back. With such a
  //                       DLL the client must refetch on every pan to re-window the rects; with a
  //                       B238 DLL a pan needs no fetch, because the overlay culls world rects
  //                       itself.
  //   burrowSeq        -- server's burrow revision, from the {"type":"burrows"} broadcast; a change
  //                       means SOMEBODY (possibly another player) edited a burrow.
  let burrowsZ = null;
  let burrowsWorldRects = false;
  let burrowSeq = -1;
  let burrowWindowSig = "";
  let burrowWindowTimer = null;
  let burrowMembers = [];      // members of the burrow whose citizens sub-view is open
  let burrowCitizensFor = -1;  // burrow id the citizens sub-view is open for, or -1
  let burrowSymbolFor = -1;    // burrow id the symbol/colour sub-view is open for, or -1 (B230)
  let burrowRenamingId = -1;   // burrow id whose row is in inline-rename mode, or -1
  const burrowPanel = document.createElement("div");
  burrowPanel.id = "burrowPanel";
  burrowPanel.style.display = "none";
  document.body.appendChild(burrowPanel);

  function setBurrowStatus(msg, isErr = false) {
    const el = burrowPanel.querySelector("[data-burrow-status]");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("err", !!isErr);
  }
  function updateBurrowButtons() {
    updateDesignationButtons(); // repaints the toolbar burrow button highlight (burrowMode)
  }

  async function fetchBurrows(detailId = -1) {
    const url = `/burrows?player=${encodeURIComponent(player)}` +
      (detailId >= 0 ? `&detail=${encodeURIComponent(detailId)}` : "") + `&t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("burrows failed");
    return r.json();
  }

  function renderBurrowPanel() {
    if (burrowCitizensFor >= 0) { renderBurrowCitizens(); return; }
    if (burrowSymbolFor >= 0) { renderBurrowSymbol(); return; }
    burrowPanel.innerHTML = window.DwfControlShell.burrowPanelMarkup({
      burrows: burrowsCache, paintId: burrowPaintId, renamingId: burrowRenamingId,
      paintMode, erase: burrowEraseArmed,
    });
    // Sprite art for the row tools + paint bar (real BURROW_* tokens).
    burrowPanel.querySelectorAll("[data-burrow-suspend]").forEach(b => {
      const on = b.classList.contains("on");
      paintSprite(b, "burrowSuspend", on);
    });
    burrowPanel.querySelectorAll("[data-burrow-citizens]").forEach(b => paintSprite(b, "burrowAddUnit", false));
    burrowPanel.querySelectorAll("[data-burrow-delete]").forEach(b => paintSprite(b, "burrowDelete", false));
    // B230: limit_workshops is a genuine TWO-SPRITE toggle (DF ships art for both states), so the
    // token itself changes with the state -- unlike suspend, where one token flips active/inactive.
    burrowPanel.querySelectorAll("[data-burrow-workshops]").forEach(b => {
      const on = !!burrowsCache.find(x => x.id === Number(b.dataset.burrowWorkshops))?.limitWorkshops;
      paintSprite(b, on ? "burrowWorkshopsOnly" : "burrowWorkshopsAll", on);
    });
    burrowPanel.querySelectorAll("[data-burrow-symbol]").forEach(b => paintSprite(b, "burrowRepaint", false));
    burrowPanel.querySelectorAll("[data-paint-mode]").forEach(b => {
      const mode = b.dataset.paintMode;
      paintSprite(b, mode === "free" ? "paintFree" : "paintRect", paintMode === mode);
      b.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        paintMode = mode === "free" ? "free" : "rect";
        burrowEraseArmed = false;
        renderBurrowPanel();
        focusPage();
      });
    });
    const eraseBtn = burrowPanel.querySelector("[data-burrow-erase]");
    if (eraseBtn) {
      paintSprite(eraseBtn, "burrowErase", burrowEraseArmed);
      eraseBtn.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        burrowEraseArmed = !burrowEraseArmed;
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
        if (typeof data.id === "number") burrowPaintId = data.id; // arm paint immediately (DF flow)
        burrowEraseArmed = false;
        await refreshBurrowPanel();
        setBurrowStatus("Burrow created. Paint its tiles on the map.");
        updateToolCursor();
      } catch (_) { setBurrowStatus("Create failed.", true); }
      focusPage();
    });
    burrowPanel.querySelector("[data-burrow-paint-done]")?.addEventListener("click", event => {
      event.stopPropagation();
      burrowPaintId = -1;
      burrowEraseArmed = false;
      renderBurrowPanel();
      updateToolCursor();
      focusPage();
    });
    burrowPanel.querySelectorAll("[data-burrow-paint]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.burrowPaint);
      burrowPaintId = burrowPaintId === id ? -1 : id; // click again to disarm
      burrowEraseArmed = false;
      renderBurrowPanel();
      updateToolCursor();
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
    // Suspend / civilian-alert / delete: no server routes exist for these yet (only
    // create/rename/unit landed in src/burrows_panel.cpp) -- same graceful-degradation
    // pattern as /burrow-paint below (postMaybePending covers 404 AND the
    // no-response-at-all shape unmatched POSTs actually get).
    const pendingAction = async (url, okMsg) => {
      const r = await postMaybePending(url);
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
      if (burrowPaintId === id) { burrowPaintId = -1; updateToolCursor(); }
      pendingAction(`/burrow-delete?player=${encodeURIComponent(player)}&id=${id}`, "Burrow deleted.");
      focusPage();
    }));
    burrowPanel.querySelectorAll("[data-burrow-citizens]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      burrowCitizensFor = Number(b.dataset.burrowCitizens);
      renderBurrowCitizens();
      focusPage();
    }));
    // B230: limit_workshops -- the second (and only other) bit in df::burrow_flag.
    burrowPanel.querySelectorAll("[data-burrow-workshops]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.burrowWorkshops);
      const on = burrowsCache.find(x => x.id === id)?.limitWorkshops;
      pendingAction(`/burrow-action?player=${encodeURIComponent(player)}&id=${id}&action=${on ? "workshops-all" : "workshops-limit"}`,
        on ? "Workshops: everywhere." : "Workshops: burrow only.");
      focusPage();
    }));
    // B230: symbol/colour sub-view.
    burrowPanel.querySelectorAll("[data-burrow-symbol]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      burrowSymbolFor = Number(b.dataset.burrowSymbol);
      renderBurrowSymbol();
      focusPage();
    }));
  }

  // B230 symbol/colour sub-view. Unlike the citizens sub-view this needs no second fetch: /burrows
  // already carries every burrow's symbolIndex/fgColor/bgColor AND the live DF palette, so the view
  // renders straight out of burrowsCache and a pick is a single POST + refresh.
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

  // Citizens sub-view: restyles the EXISTING /burrow-unit flow as an assign/unassign list
  // (citizen names from /panel?panel=citizens; members from /burrows?detail=id). The old
  // type-a-unit-id-into-a-number-input interaction is gone (audit flag row 5).
  async function renderBurrowCitizens() {
    const id = burrowCitizensFor;
    const burrow = burrowsCache.find(b => b.id === id);
    // BUTTON_CLOSE_LEFT is DF's own back arrow; the "<- Back" text arrow was a stand-in for it.
    burrowPanel.innerHTML = `<div class="burrow-head">
        ${DWFUI.artBtnHtml({ cls: "burrow-add burrow-back", dataset: { burrowBack: "" }, sprite: "BUTTON_CLOSE_LEFT", title: "Back to the burrow list", ariaLabel: "Back to the burrow list" })}
        <div class="burrow-cit-title">${escapeHtml(burrow?.name || `Burrow ${id}`)}: citizens</div>
      </div>
      <div class="burrow-list"><div class="burrow-empty">Loading...</div></div>
      <div class="stock-palette-status" data-burrow-status></div>`;
    burrowPanel.querySelector("[data-burrow-back]").addEventListener("click", event => {
      event.stopPropagation();
      burrowCitizensFor = -1;
      renderBurrowPanel();
      focusPage();
    });
    let citizens = [];
    try {
      const [detail, panelData] = await Promise.all([
        fetchBurrows(id),
        fetch(`/panel?player=${encodeURIComponent(player)}&panel=citizens&t=${Date.now()}`, { cache: "no-store" })
          .then(r => (r.ok ? r.json() : null))
      ]);
      burrowMembers = Array.isArray(detail?.members) ? detail.members : [];
      citizens = Array.isArray(panelData?.rows)
        ? panelData.rows.filter(row => Number(row.unitId) >= 0) : [];
    } catch (_) {
      setBurrowStatus("Citizen list unavailable.", true);
    }
    if (burrowCitizensFor !== id) return; // navigated away while loading
    const memberIds = new Set(burrowMembers.map(m => Number(m.unitId)));
    const listEl = burrowPanel.querySelector(".burrow-list");
    if (!listEl) return;
    listEl.innerHTML = citizens.length ? citizens.map(u => {
      const uid = Number(u.unitId);
      const assigned = memberIds.has(uid);
      const professionColor = Number(u.professionColor);
      const nameStyle = Number.isInteger(professionColor) && professionColor >= 0 && professionColor <= 15
        ? ` style="color:${DWFUI.dfColor(professionColor)}"` : "";
      return `<div class="burrow-cit-row">
        <div class="burrow-cit-name"${nameStyle}>${escapeHtml(u.name || `Unit ${uid}`)}</div>
        <div class="burrow-cit-prof">${escapeHtml(u.profession || "")}</div>
        ${DWFUI.plaqueBtnHtml({ cls: `zone-unit-act${assigned ? " assigned" : ""}`, dataset: { burrowUnit: uid, on: assigned ? 0 : 1 }, label: assigned ? "Unassign" : "Assign", tone: assigned ? "red" : "green", title: assigned ? "Remove this citizen from the burrow" : "Assign this citizen to the burrow" })}
      </div>`;
    }).join("") : `<div class="burrow-empty">No citizens found.</div>`;
    listEl.querySelectorAll("[data-burrow-unit]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const uid = Number(b.dataset.burrowUnit);
      const on = Number(b.dataset.on) ? 1 : 0;
      try {
        const r = await fetch(`/burrow-unit?player=${encodeURIComponent(player)}&id=${id}&unit=${uid}&on=${on}`, { method: "POST", cache: "no-store" });
        if (!r.ok) throw new Error("membership failed");
        renderBurrowCitizens(); // re-render with the new membership
      } catch (_) { setBurrowStatus("Membership change failed.", true); }
      focusPage();
    }));
  }

  async function refreshBurrowPanel() {
    try {
      const data = await fetchBurrows();
      burrowsCache = Array.isArray(data?.burrows) ? data.burrows : [];
      // B238: a payload is only valid for the z it was built for, and only pan-free if the server
      // shipped world rects. Both absent => an old DLL => the pre-B238 contract, kept working.
      burrowsZ = typeof data?.z === "number" ? data.z : null;
      burrowsWorldRects = data?.worldRects === true;
      if (typeof data?.seq === "number") burrowSeq = data.seq;
      burrowWindowSig = renderWindowSig();
      // B230: DF's live curses palette, for the symbol/colour picker's swatches. Absent only when
      // gps is unavailable server-side, in which case the picker draws no chips (never fake ones).
      burrowPalette = Array.isArray(data?.palette) ? data.palette : [];
      if (burrowPaintId >= 0 && !burrowsCache.some(b => b.id === burrowPaintId))
        burrowPaintId = -1;
    } catch (_) {
      burrowsCache = [];
    }
    // B230: hand the burrows (each carrying its window-clipped `rects` + its DF colour) to the tile
    // overlay, so painted tiles are actually VISIBLE on the map. /burrows has shipped these rects
    // since WD-13 and nothing drew them -- the client's only response was a console.warn claiming
    // the endpoint was pending, which it was not. The warn is gone; the tiles are drawn.
    // B238: the z rides along, so a stale-z payload draws nothing instead of washing the old
    // level's tiles over the new one while the refetch is in flight.
    if (window.DwfBurrowOverlay) window.DwfBurrowOverlay.setBurrows(burrowsCache, burrowsZ);
    renderBurrowPanel();
  }

  // B238. The rects in burrowsCache were built for ONE camera z, and (on a pre-B238 DLL) for one
  // camera WINDOW. Both go stale when the player moves, and nothing was watching -- so panning or
  // changing z under an open burrow panel left the overlay showing the wrong tiles until the next
  // panel action. Sample the renderer's own geometry and refetch when the thing the payload was
  // built for actually changed:
  //   z changed        -> always refetch (the payload is for the other level, whatever the DLL)
  //   x/y/window moved -> refetch ONLY on a pre-B238 DLL (world rects need no re-windowing; the
  //                       overlay planner culls them itself, so a pan is free)
  function renderWindowSig() {
    const T = window.DwfTiles;
    const rr = T && typeof T.getRenderRect === "function" ? T.getRenderRect() : null;
    if (!rr) return "";
    return burrowsWorldRects ? `z${rr.oz}` : `${rr.ox},${rr.oy},${rr.oz},${rr.gw},${rr.gh}`;
  }
  function burrowWindowWatch() {
    if (!burrowMode) return;
    const sig = renderWindowSig();
    if (sig && sig !== burrowWindowSig) {
      burrowWindowSig = sig;
      scheduleBurrowRefresh();
    }
  }

  function enterBurrowMode() {
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("burrows"); // WD-26 first-time help (09-burrows.png)
    clearBuildPlacement(false);
    closeStockMode();
    closeZoneMode();
    currentTool = null;
    selectedDesignation = null;
    digMenuOpen = false;
    plantMenuOpen = false;
    smoothMenuOpen = false;
    itemDesigMenuOpen = false;
    burrowMode = "open";
    burrowPaintId = -1;
    burrowEraseArmed = false;
    burrowCitizensFor = -1;
    burrowSymbolFor = -1;
    burrowPanel.style.display = "block";
    burrowWindowSig = "";
    if (burrowWindowTimer) clearInterval(burrowWindowTimer);
    burrowWindowTimer = setInterval(burrowWindowWatch, 250);  // B238: pan/z staleness watch
    updateDesignationButtons();
    updateToolCursor();
    refreshBurrowPanel();
  }
  function toggleBurrowPanel() {
    if (burrowMode) { closeBurrowMode(); return; }
    enterBurrowMode();
  }

  // /burrow-paint?id=&px=&py=&px2=&py2=&w=&h=&mode=add|erase (spec contract). The server half IS
  // LANDED (src/burrows_panel.cpp do_burrow_paint -> DFHack::Burrows::setAssignedTile); the
  // graceful-degradation path below is retained for an OLD DLL, since the browser can be newer than
  // the plugin. A missing route (404, or the no-response shape unmatched POSTs actually get) becomes
  // ONE console.warn + a status line, never a crash, and the session then stops re-sending paint
  // calls (a free-paint stroke would otherwise fire dozens of doomed fetches).
  let burrowPaintPending = false;
  // B230: a paint stroke changes the burrow's tiles, so the overlay's `rects` are now stale. Free
  // paint fires one call PER CELL, so refetching per call would be a fetch storm -- coalesce into a
  // single refresh once the stroke settles.
  let burrowRefreshTimer = null;
  function scheduleBurrowRefresh() {
    if (burrowRefreshTimer) clearTimeout(burrowRefreshTimer);
    burrowRefreshTimer = setTimeout(() => {
      burrowRefreshTimer = null;
      if (burrowMode) refreshBurrowPanel();
    }, 120);
  }

  // B238 MULTIPLAYER. Burrow state had no push at all before this: /burrows was fetched on panel
  // open and after YOUR OWN mutations, so another player's paint never reached your map -- you had
  // to close and reopen the panel to see the burrow they were standing in. The server now bumps a
  // revision on every burrow write route and broadcasts {"type":"burrows","seq":N} (sticky, change-
  // only, late-join-synced -- the vote/popup pattern); dwf-ws.js routes it here. A seq we have
  // not seen means SOMEONE changed a burrow: pull the new rects. Only while burrow mode is open --
  // the overlay is dormant otherwise (DF shows burrow tiles inside the mode only), and reopening it
  // refetches anyway.
  window.DFBurrowSync = {
    onBurrows(msg) {
      const seq = Number(msg && msg.seq);
      if (!isFinite(seq) || seq === burrowSeq) return;
      burrowSeq = seq;
      if (burrowMode) scheduleBurrowRefresh();
    },
  };
  async function burrowPaintRect(x1t, y1t, x2t, y2t, w, h) {
    if (burrowPaintId < 0) return;
    if (burrowPaintPending) {
      setBurrowStatus("Tile painting needs the /burrow-paint server route (pending).", true);
      return;
    }
    const mode = burrowEraseArmed ? "erase" : "add";
    const url = `/burrow-paint?player=${encodeURIComponent(player)}&id=${burrowPaintId}` +
      `&px=${x1t}&py=${y1t}&px2=${x2t}&py2=${y2t}&w=${w}&h=${h}&mode=${mode}`;
    const r = await postMaybePending(url);
    if (!r) {
      burrowPaintPending = true;
      console.warn("[WD-13] /burrow-paint: route not answered -- the DLL is older than this client");
      setBurrowStatus("Tile painting needs the /burrow-paint server route (pending).", true);
      return;
    }
    setBurrowStatus(mode === "erase" ? "Tiles erased." : "Tiles painted.");
    scheduleBurrowRefresh(); // B230: pull the new tile rects so the map overlay tracks the stroke
  }
  function burrowPaintDrag(x1, y1, x2, y2) {
    const a = imagePixelClamped(x1, y1);
    const b = imagePixelClamped(x2, y2);
    if (!a || !b) return;
    burrowPaintRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), a.w, a.h);
  }
  // Free-paint: per-cell 1x1 /burrow-paint calls, Bresenham-interpolated + per-drag dedup --
  // the same shape as the /designate free paint above (freePaintTo).
  function burrowFreePaintTo(cell) {
    if (!burrowFreeCells || !cell) return;
    const from = burrowFreeLast || cell;
    let x = from.x, y = from.y;
    const x1 = cell.x, y1 = cell.y;
    const dx = Math.abs(x1 - x), sx = x < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y), sy = y < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      const key = `${x},${y}`;
      if (!burrowFreeCells.has(key)) {
        burrowFreeCells.add(key);
        burrowPaintRect(x, y, x, y, cell.w, cell.h);
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    burrowFreeLast = cell;
  }

  // --- Hauling routes (WD-29): DF's real hauling mode, 10-hauling.png ground truth. Mode
  // button (hotkey h, toolbar bottom-center "modes" group) opens a full-height LEFT panel:
  // "Add new route" plate + per-route rows (name, stop count, vehicle count). Same
  // panel/list/row shape as burrows above (.burrow-* classes reused, per WD-29's spec note
  // that this shares chrome with the burrow left panel) -- stops are placed with single map
  // clicks (not rect painting, since a hauling stop is one tile) via /hauling-stop-add.
  let haulingRoutesCache = [];   // last /hauling routes payload
  let haulingSelectedRouteId = -1;
  // B231 (hauling depth). The route panel used to expose only create/remove + a raw item-id box.
  // These carry the three surfaces that make a route do anything: which stop is expanded, the
  // draft departure condition being composed for it, and the free-minecart pool for the picker.
  let haulingOpenStopKey = "";     // "<routeId>:<stopId>" of the expanded stop, or ""
  let haulingCondDraft = {};       // in-progress depart condition: {mode,direction,loadPercent,atMost,desired}
  let haulingFreeVehicles = [];    // /hauling-vehicles -- df::vehicle with route_id == -1
  const haulingPanel = document.createElement("div");
  haulingPanel.id = "haulingPanel";
  haulingPanel.style.display = "none";
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
    } catch (_) {
      haulingRoutesCache = [];
    }
    // Free-cart pool for the picker. A failure here must not blank the routes, so it is caught
    // separately and simply yields an empty pool ("No free minecarts").
    try {
      const r = await fetch(`/hauling-vehicles?t=${Date.now()}`, { cache: "no-store" });
      const data = r.ok ? await r.json() : {};
      haulingFreeVehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    } catch (_) {
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
      routes: haulingRoutesCache, armedRouteId: haulingStopArmedRoute,
      selectedRouteId: haulingSelectedRouteId,
      openStopKey: haulingOpenStopKey, condDraft: haulingCondDraft,
      freeVehicles: haulingFreeVehicles,
    });
    window.DwfControlShell.paintControlIcons(haulingPanel);
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
      } catch (_) { setHaulingStatus("Create failed.", true); }
      focusPage();
    });
    haulingPanel.querySelectorAll("[data-hauling-stop-arm]").forEach(b => b.addEventListener("click", event => {
      event.stopPropagation();
      const id = Number(b.dataset.haulingStopArm);
      haulingStopArmedRoute = haulingStopArmedRoute === id ? -1 : id;
      updateToolCursor();
      renderHaulingPanel();
      focusPage();
    }));
    haulingPanel.querySelector("[data-hauling-stop-done]")?.addEventListener("click", event => {
      event.stopPropagation();
      haulingStopArmedRoute = -1;
      updateToolCursor();
      renderHaulingPanel();
      focusPage();
    });
    haulingPanel.querySelectorAll("[data-hauling-route-remove]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const id = Number(b.dataset.haulingRouteRemove);
      try {
        const r = await fetch(`/hauling-route-remove?player=${encodeURIComponent(player)}&id=${id}`, { method: "POST", cache: "no-store" });
        if (!r.ok) {
          // W23: a 501 {"guarded":true} carries the host-guard sentence -- show it verbatim.
          let msg = "Remove failed.";
          try { const g = await r.json(); if (g && g.guarded && g.error) msg = g.error; } catch (_) {}
          throw new Error(msg);
        }
        if (haulingSelectedRouteId === id) haulingSelectedRouteId = -1;
        if (haulingStopArmedRoute === id) { haulingStopArmedRoute = -1; updateToolCursor(); }
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
          try { const g = await r.json(); if (g && g.guarded && g.error) msg = g.error; } catch (_) {}
          throw new Error(msg);
        }
        await refreshHaulingPanel();
        setHaulingStatus("Stop removed.");
      } catch (err) { setHaulingStatus(err && err.message ? err.message : "Stop remove failed.", true); }
    }));
    // ---- B231 handlers -----------------------------------------------------------------------
    // Assign / release a minecart. The id in the dataset is the cart's ITEM id (what the player
    // sees in stocks); the server resolves it to the df::vehicle and writes vehicle_ids +
    // vehicle_stops + vehicle.route_id together -- see src/hauling.cpp's banner.
    const postHauling = async (url, okMsg, failMsg) => {
      try {
        const r = await fetch(url, { method: "POST", cache: "no-store" });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || failMsg); }
        await refreshHaulingPanel();
        setHaulingStatus(okMsg);
        return true;
      } catch (err) {
        setHaulingStatus(err.message || failMsg, true);
        return false;
      }
    };

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

    // The draft departure condition. These only mutate local state and re-render; nothing is
    // written to the save until "Add condition".
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
      if (await postHauling(`/hauling-stop-conditions?${q}`, "Departure condition added.", "Add condition failed."))
        haulingCondDraft = {};
    }));
    haulingPanel.querySelectorAll("[data-hauling-cond-remove]").forEach(b => b.addEventListener("click", async event => {
      event.stopPropagation();
      const [routeId, stopId, index] = b.dataset.haulingCondRemove.split(":").map(Number);
      await postHauling(
        `/hauling-stop-conditions-remove?player=${encodeURIComponent(player)}&route=${routeId}&stop=${stopId}&index=${index}`,
        "Condition removed.", "Remove failed.");
    }));

    // "Choose items" -> the SHARED stockpile item editor, pointed at this stop. A hauling stop's
    // `settings` is a df::stockpile_settings (the same struct a pile carries), which is exactly
    // why the stop can reuse the pile's editor rather than grow a second one. The editor is owned
    // by the stockpile panel module; if it is not present we say so instead of failing silently.
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

  // One plain click while a route is armed for stop-placement sends /hauling-stop-add with
  // the clicked tile (same px/py/w/h contract as /burrow-paint's single-cell calls). Stays
  // armed afterward (unlike squad Move) so several stops can be placed in a row, matching
  // DF's own "add stop" flow -- "Done placing stops" (or re-clicking the route's Add-stop
  // button) disarms it.
  async function haulingStopClick(event) {
    const routeId = haulingStopArmedRoute;
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

  function closeHaulingMode() {
    haulingMode = null;
    haulingStopArmedRoute = -1;
    haulingPanel.style.display = "none";
    if (typeof updateDesignationButtons === "function") updateDesignationButtons();
  }
  function enterHaulingMode() {
    clearBuildPlacement(false);
    closeStockMode();
    closeZoneMode();
    closeBurrowMode();
    currentTool = null;
    selectedDesignation = null;
    digMenuOpen = false;
    plantMenuOpen = false;
    smoothMenuOpen = false;
    itemDesigMenuOpen = false;
    haulingMode = "open";
    haulingStopArmedRoute = -1;
    haulingPanel.style.display = "block";
    updateDesignationButtons();
    updateToolCursor();
    refreshHaulingPanel();
  }
  function toggleHaulingPanel() {
    if (haulingMode) { closeHaulingMode(); return; }
    enterHaulingMode();
  }

  // WD-30: squad "Move" order -- one plain click while armed sends /squad-order?action=move
  // with the clicked tile (same px/py/w/h contract as /burrow-paint's single-cell calls
  // above). window.DFSquadMove is the squads-sidebar's (dwf-squads.js) only hook into
  // the map/pointer system; it does not touch any other placement mode.
  async function squadMoveClick(event) {
    const squadId = squadMoveArmed;
    squadMoveArmed = -1;
    updateToolCursor();
    if (typeof window.DFSquadMove === "object" && window.DFSquadMove.onDisarmed)
      window.DFSquadMove.onDisarmed();
    const pixel = imagePixelFromEvent(event);
    if (!pixel) return;
    try {
      const url = `/squad-order?player=${encodeURIComponent(player)}&squad=${encodeURIComponent(squadId)}` +
        `&action=move&px=${pixel.x}&py=${pixel.y}&w=${pixel.w}&h=${pixel.h}`;
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
  window.DFSquadMove.arm = function (squadId) {
    squadMoveArmed = Number(squadId);
    updateToolCursor();
  };
  window.DFSquadMove.disarm = function () {
    squadMoveArmed = -1;
    updateToolCursor();
  };
  window.DFSquadMove.isArmed = function () { return squadMoveArmed; };

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
    squadPatrolArmed = Number(squadId);
    updateToolCursor();
  };
  window.DFSquadPatrol.disarm = function () {
    squadPatrolArmed = -1;
    updateToolCursor();
  };
  window.DFSquadPatrol.isArmed = function () { return squadPatrolArmed; };

  // B70: multi-target kill. Each armed click ADDS a target to the sidebar's selection set and
  // stays armed (squadKillArmed is left set) so the player can mark several units before one
  // confirm sends them all. Disarming happens only on explicit confirm/cancel via DFSquadKill.
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
  // B174 links flow: while armed, a map click resolves the tile through /inspect (the same
  // pipeline squad-kill uses); a stockpile hit hands its id to the workshop panel's onPick
  // (which POSTs /stockpile-link and re-reads the workshop). Non-stockpile hits report through
  // onFailed. The mode STAYS armed across picks -- Done/toggle in the side window disarms.
  async function wsLinkClick(event) {
    const pixel = imagePixelFromEvent(event);
    if (!pixel || !wsLinkArmed) return;
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
    wsLinkArmed = { ws: Number(wsId), mode: mode === "take" ? "take" : "give" };
    updateToolCursor();
  };
  window.DFWsLink.disarm = function () {
    wsLinkArmed = null;
    updateToolCursor();
  };
  window.DFWsLink.isArmed = function () { return wsLinkArmed; };

  // B223: the armed chat-ping pick. Resolves the clicked tile through the SAME /inspect route the
  // squad-kill and ws-link picks use, and hands BOTH halves to chat:
  //   * `data`  -- the raw /inspect result. chat runs it through DFTileList.buildCandidates (the
  //                B208/B219 precedence) so a ping picks THE SAME unit a plain click would open --
  //                no parallel hit-test.
  //   * `pos`   -- the clicked WORLD tile, computed client-side from renderedImageRect() exactly as
  //                squadPatrolClick does. This is the fallback the location token is built from,
  //                and it means a ping on bare ground (or with /inspect down) still resolves --
  //                unlike inspectClick, which deliberately ignores empty terrain.
  // Disarm happens FIRST, before the await: the mode is one-shot and must never be left wedged by
  // a slow or failing /inspect.
  async function chatPingClick(event) {
    if (!chatPingArmed) return;
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
    if (chatPingArmed) return;
    chatPingArmed = true;
    updateToolCursor();
    if (typeof window.DFChatPing.onArmed === "function") window.DFChatPing.onArmed();
  };
  window.DFChatPing.disarm = function () {
    if (!chatPingArmed) return;
    chatPingArmed = false;
    updateToolCursor();
    // Idempotent + guarded by the flag above, so the consumer's own toggle-off (which calls
    // disarm) and the Escape path below both notify exactly once and cannot recurse.
    if (typeof window.DFChatPing.onDisarmed === "function") window.DFChatPing.onDisarmed();
  };
  window.DFChatPing.isArmed = function () { return chatPingArmed; };

  window.DFSquadKill = window.DFSquadKill || {};
  window.DFSquadKill.arm = function (squadId) {
    squadKillArmed = Number(squadId);
    updateToolCursor();
  };
  window.DFSquadKill.disarm = function () {
    squadKillArmed = -1;
    updateToolCursor();
  };
  window.DFSquadKill.isArmed = function () { return squadKillArmed; };

  // (Removed 2026-07-17, stockpile repaint session) The former repaintStockpileDrag() committed a
  // camera-relative RECTANGLE to /stockpile-repaint on the first pointer-up, with no erase, no
  // freehand and no staging. The existing-pile repaint now stages exact world tiles through
  // stageStockRepaintDrag() and commits on Accept via acceptStockRepaint() (mode=replace bitmap),
  // matching the zone repaint session and native DF's stockpile paint controls.

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

  // Commit the staged native repaint session as one exact, world-addressed extent bitmap. No
  // request fires until Accept, and a camera pan between painting and Accept cannot move the edit.
  // Success answers {"ok":true,"id":...} JSON;
  // a refusal arrives as a NON-2xx plain-text body -- 400 (bad/too-large/OOM footprint), 409
  // ("repaint cannot erase an entire zone; zone left unchanged"), or 503 (camera/viewport). Either
  // outcome must be VISIBLE: on refusal we reopen the panel carrying the server's own reason through
  // s5's status sink (openZonePanel opts.status), instead of the old silent reopen that looked
  // exactly like a successful no-op. A route that never answers at all (a host DLL older than this
  // client -- an unmatched POST is never replied to) is the one genuine old-DLL degradation; the 4s
  // abort turns that would-be hang into a plain status line rather than a wedged drag.
  async function commitZoneRepaintDraft(id, draft) {
    if (!draft) return;
    const reopen = (zoneId, status) => {
      if (typeof openZonePanel === "function") openZonePanel(zoneId, status ? { status } : undefined);
    };
    const shape = zoneRepaintFinalShape(draft);
    if (!shape || shape.empty) {
      setZoneStatus("A zone cannot be repainted to zero tiles. Use Remove Zone instead.", true);
      return;
    }
    const url = `/zone-repaint?player=${encodeURIComponent(player)}&id=${id}&mode=replace` +
      `&x1=${shape.x1}&y1=${shape.y1}&x2=${shape.x2}&y2=${shape.y2}&z=${shape.z}`;
    disarmZoneRepaint();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(url, { method: "POST", cache: "no-store", signal: ctl.signal,
        headers: { "Content-Type": "text/plain; charset=utf-8" }, body: shape.extents });
      const text = (await r.text()) || "";
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (_) {}
      loadZones();
      if (!r.ok) {
        // Refusal body is plain text ("zone-repaint refused: ..." / "zone-repaint failed: ...").
        // Show the server's reason, stripped of its wire prefix and trailing newline, on the
        // reopened panel so the player learns WHY the extend did not take.
        const reason = String(data.error || text || "").replace(/\s+$/, "")
          .replace(/^zone-repaint (?:failed|refused):\s*/i, "");
        reopen(id, { text: reason || "Zone repaint was refused.", isError: true });
        return;
      }
      const finalId = Number(data.id);
      reopen(Number.isInteger(finalId) && finalId >= 0 ? finalId : id);
    } catch (_) {
      // No response at all (old-DLL /zone-repaint absence, or the 4s abort above). Reopen with a
      // status line rather than the pre-s5 silent catch that left the drag looking like a no-op.
      loadZones();
      reopen(id, { text: "The zone-repaint route did not respond -- the host's game may be older than this client.", isError: true });
    } finally {
      clearTimeout(timer);
    }
  }

  // (Removed 2026-07-16, cleanup pack) The former repaintZoneDrag() helper was a dead thin wrapper
  // over stageZoneRepaintDrag() + commitZoneRepaintDraft(). The live pointer path stages through
  // stageZoneRepaintDrag() and Accept owns the production commit (see commitZoneRepaintDraft, which
  // carries the no-silent-failure refusal wiring via openZonePanel(id, {status})). It had zero
  // callers in src/ or the harnesses.

  // Open a designation menu + arm one of its tools, mirroring the toolbar button clicks so the
  // keyboard shortcuts behave exactly like clicking (menu opens, tool selected, grid paints).
  function armDesignation(menu, tool) {
    digMenuOpen = menu === "dig";
    plantMenuOpen = menu === "plant";
    smoothMenuOpen = menu === "smooth";
    itemDesigMenuOpen = menu === "itemdesig";
    selectDesignation(tool);
  }

  // Keyboard equivalent of clicking a bottom-center "mode" tool button (hauling/traffic):
  // arm it (clearing any open designation submenu flags first) or disarm it if it's already
  // the active tool -- exactly mirrors the [data-mode-tool] click handler further below, so
  // `h`/`T` behave identically whether pressed or clicked. WD-28 remediation item.
  function armModeTool(tool) {
    if (selectedDesignation === tool) {
      selectedDesignation = null;
      currentTool = null;
      updateDesignationButtons();
    } else {
      digMenuOpen = false;
      plantMenuOpen = false;
      smoothMenuOpen = false;
      itemDesigMenuOpen = false;
      selectDesignation(tool);
    }
  }

  addEventListener("keydown", event => {
    // Let text inputs (stockpile rename, search) receive keys without panning the map.
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (event.key === "Escape") event.target.blur();
      return;
    }
    // WT11: while the 3D viewer owns the screen it owns the keyboard too -- its slab keys (E/Q/C/Z)
    // and camera keys (WASD) collide head-on with this cascade's fort-tool letters. Yield rather
    // than firing a designation tool the player cannot even see. (Escape is handled by the viewer.)
    try { if (window.DFWorld3D && window.DFWorld3D.isOpen()) return; } catch (_) {}
    // Never intercept browser shortcuts (Ctrl/Alt/Meta combos -- e.g. Ctrl+Shift+R reload,
    // Ctrl+A, Ctrl+C). Past bug: the map keydown swallowed these. Shift is intentionally allowed
    // -- it drives fast pan (core.js) and the Shift+letter panel hotkeys in the switch below.
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    // WD-27: this listener is on `window`, which the bubble phase reaches LAST -- any earlier
    // `document`-level Escape handler (e.g. dwf-keymap.js's hotkey-overlay close) has
    // already run and called preventDefault() by the time we get here. Bail out on Escape in
    // that case so this cascade's own fallback (opening the Esc menu when "nothing else is
    // open") doesn't ALSO fire in the same keypress that just closed a different overlay.
    if (event.key === "Escape" && event.defaultPrevented) return;
    focusPage();
    if (event.key === "Escape") {
      let handledEscape = false;
      // B223: an armed chat ping is a TRANSIENT one-shot pick the player explicitly entered a
      // moment ago, and it is checked FIRST so a mistaken ping is always one Escape away from
      // gone -- no panel or screen has to be closed to get out of it. disarm() notifies chat
      // (onDisarmed), which drops the button's armed styling; nothing is sent.
      if (chatPingArmed) {
        window.DFChatPing.disarm();
        handledEscape = true;
      } else
      // WD-27: the World screen and the Esc menu are the OUTERMOST layers (DF's own screen
      // stack, not a client tool/panel) -- checked first so Escape closes whichever of them is
      // open before anything below ever runs, and so the Esc-menu's own re-open (the final
      // `else` at the bottom of this cascade) never fires while one of them is still up.
      if (typeof worldScreenOpen === "function" && worldScreenOpen()) {
        closeWorldScreen();
        handledEscape = true;
      } else if (typeof escMenuOpen === "function" && escMenuOpen()) {
        closeEscMenu();
        handledEscape = true;
      } else if (stockRepaintId) {
        setStockRepaint(null);
        handledEscape = true;
      } else if (zoneRepaintId != null) {
        // First Escape leaves the repaint session but keeps Zones and its overlay alive; a second
        // Escape reaches the zoneMode branch below and actually closes Zones.
        disarmZoneRepaint();
        handledEscape = true;
      } else if (areaBuildAnchor) {
        // First Escape cancels only the pending corner; the area building remains armed.
        cancelAreaBuildAnchor();
        handledEscape = true;
      } else if (clientPanel.classList.contains("visible") && clientPanel.classList.contains("build-panel")) {
        // Build menu open: ONE Escape closes the whole window (same as its X button). Without this,
        // the auto-selected building's detail panel eats the first Escape, so it would take two
        // presses to leave the build menu.
        clearBuildPlacement(false);
        closeClientPanel();
        setActiveToolbar(null);
        handledEscape = true;
      } else if (bipSelBuild()) {
        // Build placement active with the menu already closed (placing on the map) -> cancel it.
        clearBuildPlacement(true);
        handledEscape = true;
      } else if (selection.classList.contains("visible")) {
        closeSelection();
        handledEscape = true;
      } else if (clientPanel.classList.contains("visible")) {
        closeClientPanel();
        handledEscape = true;
      } else if (zoneMode === "paint") {
        // WD-14: first Escape leaves the paint stage back to the type grid (drops any
        // unaccepted paint); a second Escape (branch below) closes zone mode entirely.
        setZonePreset(null);
        handledEscape = true;
      } else if (zoneMode || (typeof zonePalette !== "undefined" && zonePalette.style.display !== "none")) {
        closeZoneMode();
        setActiveToolbar(null);
        handledEscape = true;
      } else if (burrowMode) {
        // WD-13: Escape leaves burrow mode (disarming any active paint with it).
        closeBurrowMode();
        handledEscape = true;
      } else if (haulingMode) {
        // S7 shell: hauling is a mode panel exactly like burrow/stock/zone above, and Escape must
        // dismiss it the same way -- otherwise it is the ONE mode panel Escape cannot close, which
        // reads as inconsistent navigation (open hauling, press Esc, and the Esc MENU would pop over
        // it instead). closeHaulingMode() also disarms any in-progress stop placement, matching the
        // "Escape leaves the mode, dropping its armed sub-action with it" shape burrow uses. The
        // toolbar hauling button de-highlights itself (closeHaulingMode -> updateDesignationButtons),
        // so no setActiveToolbar(null) is needed here (hauling is a mode-tool, not a data-panel).
        closeHaulingMode();
        handledEscape = true;
      } else if (stockMode) {
        closeStockMode();
        setActiveToolbar(null);
        handledEscape = true;
      } else if (twoClickArmed()) {
        // B196: a two-click range is mid-placement (first corner set, box rubber-banding to the
        // cursor). Escape backs out just the pending box like native DF, leaving the tool armed
        // for a fresh first click -- a second Escape (branch below) then drops the tool.
        stairRangeStart = null;
        stairRangePreview = null;
        twoClickCursor = null;
        // -drag1: drop our broadcast pending box for other players immediately (the tool stays
        // armed, so updatePlacementMode's deselect clear never fires on this branch, and a
        // motionless mouse would otherwise leave the stale rect on every remote view).
        sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true);
        renderZoneOverlay();
        updateDesignationButtons();
        updateToolModeLabel();
        handledEscape = true;
      } else if (digMenuOpen || plantMenuOpen || smoothMenuOpen || itemDesigMenuOpen || selectedDesignation || currentTool) {
        digMenuOpen = false;
        plantMenuOpen = false;
        smoothMenuOpen = false;
        itemDesigMenuOpen = false;
        selectedDesignation = null;
        currentTool = null;
        stairRangeStart = null;
        stairRangePreview = null;
        twoClickCursor = null;
        renderZoneOverlay();
        updateDesignationButtons();
        handledEscape = true;
      // WT07 M1 Esc-cascade hunk: framework panels close one topmost layer before the Esc menu.
      } else if (window.DFPanelFrame && window.DFPanelFrame.escCloseTopmost()) {
        handledEscape = true;
      } else if (typeof openEscMenu === "function") {
        // WD-27: nothing else was open -- this is DF's real behavior of backing out one UI
        // layer at a time (tool -> panel -> menu) finally reaching "menu".
        openEscMenu();
        handledEscape = true;
      }
      if (handledEscape) {
        event.preventDefault();
        return;
      }
    }
    let handled = true;
    // Phase-5 keybind remapping: the semantic hotkey switch reads the REMAPPED canonical key
    // (dwf-settings.js's DFKeybinds.resolve) instead of the raw event.key. With no user
    // overrides this is the identity function, so behavior is byte-unchanged; if the settings
    // module never loaded, we fall straight back to event.key. Camera keys aren't managed by the
    // resolver (they belong to core.js's capture handler), so they pass through untouched here too.
    switch (window.DFKeybinds ? window.DFKeybinds.resolve(event) : event.key) {
      // --- Camera (these normally never reach here: core.js's capture-phase handler owns them
      // and stops propagation; kept as a fallback if that handler is ever absent). WD-28
      // remediation: h/H, j/J, k/K, l/L, q/Q are deliberately ABSENT from this fallback (not
      // just core.js) -- those letters now belong to the fort-tool cases below (hauling/
      // justice/stocks/chop/squads); leaving them here would shadow those cases as dead code
      // (first matching `case` in a switch wins). ---
      case "ArrowLeft": case "a": case "A":
        queueMove(-step, 0, 0); break;
      case "ArrowRight": case "d": case "D":
        queueMove(step, 0, 0); break;
      case "ArrowUp": case "w": case "W":
        queueMove(0, -step, 0); break;
      case "ArrowDown": case "s": case "S":
        queueMove(0, step, 0); break;
      case "PageUp": case ">":
        queueMove(0, 0, zstep); break;
      case "PageDown": case "<":
        queueMove(0, 0, -zstep); break;
      case "[":
        zoomView("in"); break;
      case "]":
        zoomView("out"); break;
      case "Home":
        resetToHost(); break;

      // --- DF's REAL canonical hotkeys (WD-4, remediated WD-28: source: live-confirmed
      // tooltips in tools/spikes/ui-truth/MANIFEST.md §0.1(8) + <DF_ROOT>\data\init\interface.txt
      // D_* binds, cross-checked directly against that file's [BIND:D_*]/[KEY:...] pairs).
      // Each opens the same menu + arms the same tool/panel as clicking its toolbar button.
      //
      // WD-28 remediation freed h/j/k/l/q from the vim-style camera-pan/z bindings above
      // (dwf-core.js + the fallback switch above) so they can carry their REAL DF
      // meaning here, per the decision (2026-07-07): mirror DF's originals as closely as
      // possible; only keep a deviation where one is unavoidable, and document it.
      case "m": armDesignation("dig", "dig"); break;
      case "g": armDesignation("plant", "gather"); break;
      case "l": armDesignation("plant", "chop"); break;        // D_DESIGNATE_CHOP (was on `f`; `f` is real DF fluid-numbers toggle, see below)
      case "v": armDesignation("smooth", "smooth"); break;
      case "x": selectDesignation("erase"); break;

      // Placement menus (DF: build=b, stockpile=p, zone=z). openPanel toggles the palette.
      case "b": openPanel("build"); break;
      case "p": openPanel("stockpile"); break;
      case "z": openPanel("zone"); break;

      // Bottom-center "modes" + item/building-designations (WD-4 new toolbar buttons).
      // WD-10: opens the item/building-designations submenu (re-selects the last-active
      // mode in that family, defaulting to "claim" like DF's own default -- same pattern
      // as "m"/"v" arming dig/smooth above).
      case "i": armDesignation("itemdesig", itemDesigTools.has(selectedDesignation) ? selectedDesignation : "claim"); break;
      case "U": toggleBurrowPanel(); break;                    // D_BURROWS (Shift+U) -- WD-13 real burrows mode
      case "h": armModeTool("hauling"); break;                 // D_HAULING -- freed from camera pan-left (WD-28)
      case "T": armModeTool("traffic"); break;                 // D_DESIGNATE_TRAFFIC (Shift+T)

      // Fort info panels (bottom-left cluster, DF's real D_* binds).
      case "u": openPanel("citizens"); break;      // D_UNITLIST
      case "t": openPanel("orders"); break;        // D_JOBLIST (tasks)
      case "y": openPanel("labor"); break;         // D_LABOR
      case "o": openPanel("workorders"); break;    // D_ORDERS
      case "n": openPanel("nobles"); break;        // D_NOBLES (DF also reuses lowercase `n` for the
                                                    // dig-submenu's DESIGNATE_TOGGLE_ADVANCED_OPTIONS;
                                                    // this client has no advanced-dig-options UI yet,
                                                    // so there's no context to shadow -- N/A, not a conflict)
      case "O": openPanel("objects"); break;       // D_ARTLIST (Shift+O)
      case "N": openPanel("alerts"); break;        // D_ANNOUNCE (Shift+N)
      case "P": openPanel("locations"); break;     // D_LOCATIONS (Shift+P)
      case "q": openPanel("squads"); break;        // D_SQUADS -- freed from camera z-down (WD-28); retires the old Shift+M fallback
      case "j": openPanel("justice"); break;        // D_JUSTICE -- freed from camera pan-down (WD-28)
      case "k": openPanel("stocks"); break;         // D_STOCKS -- freed from camera pan-up (WD-28)
      case "Y": openPanel("worldmap"); break;       // D_WORLD (Shift+Y)
      case "F": openPanel("kitchen"); break;       // not a DF main-toolbar key; WD-2 relocation
      case "G": openPanel("petitions"); break;     // not a DF main-toolbar key; WD-1 relocation
      case "B": openPanel("obligations"); break;   // WT15 Obligations board (client-only aggregate; no DF key)

      // Display toggles (DF: r=ramp indicators, f=liquid/fluid numerals). Both already had a
      // working click-through button + setDisplayToggle() state; WD-28 just wires the keys.
      // `r` gives up its former "reset camera" duty here (Home is the only keyboard reset now,
      // see dwf-core.js) and `f` gives up its former "chop" duty (moved to `l` above).
      case "r": setDisplayToggle("rampArrows", !displayToggles.rampArrows); break;   // D_TOGGLE_RAMP_INDICATORS
      case "f": setDisplayToggle("liquidNumbers", !displayToggles.liquidNumbers); break; // D_TOGGLE_FLUID_NUMBERS

      // Pause / unpause (DF: Space). Server toggles df pause_state via the WP-B arbiter.
      // WT01 cell 8: ignore auto-repeat (held Space) so a key-repeat storm can't strobe the sim
      // -- the arbiter's rule 3 deliberately lets the SAME actor alternate, so this keydown-side
      // debounce is the required second layer.
      case " ": if (!event.repeat) performAction("toggle-pause"); break;

      // Help. B207: `?` and F1 open the FULL help reference (every tooltip/guide/shortcut --
      // window.DFHelpPanel, dwf-help-panel.js), matching the top-bar "?" button. Shift+H
      // keeps DF's D_HOT_KEYS behavior: the compact keyboard-shortcut overlay on its own
      // (window.DwfKeymap, dwf-keymap.js). (F1 is also DF's D_HOTKEY1 fort-bookmark
      // slot, unimplemented here, so reusing it collides with nothing real.)
      case "?": case "F1": window.DFHelpPanel?.toggle(); break;
      case "H": window.DwfKeymap?.toggleOverlay(); break;

      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  });

  addEventListener("wheel", event => {
    // Leave Ctrl/Meta + wheel to the browser (page zoom); core.js owns map wheel-zoom in the
    // capture phase and stops propagation, so this bubble handler is only a rare fallback.
    if (event.ctrlKey || event.metaKey) return;
    // B216 defect 2: mirror core.js's capture-phase yield -- any `.dwfui-scroll` surface owns the wheel
    // so scrollboxes (combat log & every other DWFUI scrollbox) scroll natively instead of zooming the map.
    if (event.target.closest("#clientPanel.visible, #selection.visible, #alertPopup, .dwfui-scroll"))
      return;
    focusPage();
    event.preventDefault();
    if (event.shiftKey && designationRangeWheel(event)) return;
    if (event.shiftKey) queueMove(0, 0, event.deltaY < 0 ? zstep : -zstep); // shift+wheel = z
    else zoomView(event.deltaY < 0 ? "in" : "out");                         // wheel = zoom
  }, { passive: false });

  // Camera panning is keyboard-only (WASD / arrows / PgUp-PgDn), like DF. With a rectangle
  // designation tool active, TWO CLICKS place a box (B193 -- click, rubber-band, click; drag
  // is not a designation gesture); paint-family tools (free paint, stockpile/zone/burrow
  // painting) still drag; with no tool active a plain click inspects the tile.
  const digSelect = document.getElementById("digSelect");
  let pdown = false;
  let downX = 0;
  let downY = 0;
  let dragAnchor = null; // image-pixel anchor of an in-progress placement drag
  let areaBuildAnchor = null; // first tile of click/click farm/construction placement (B291)
  // Instant browser-side preview applies to rectangle designations. Rectangle paint and
  // variable-area buildings always preview locally; fixed buildings keep the centered footprint.
  function instantDrag() { return instantDesignate && !bipSelBuild(); }
  function areaBuildSelected() { return !!bipSelBuild()?.area; }
  function rectanglePaintSelected() {
    return paintMode === "rect" && !!(stockPreset || stockRepaintId || stockEraseArmed ||
      zonePreset || zoneRepaintId || zoneEraseArmed || burrowPaintId >= 0);
  }
  // Rectangle paint must never depend on the optional instant-designation preference for local
  // feedback. The preference still governs designation previews; area buildings and paint-family
  // rectangles always use the same dragPreview canvas path.
  function localDragPreviewActive() {
    return areaBuildSelected() || rectanglePaintSelected() || instantDrag();
  }
  function setDragPreview(a, b) {
    const rect = designationDragRect(a, b);
    dragPreview = rect ? { ax: rect.x1, ay: rect.y1, bx: rect.x2, by: rect.y2 } : null;
    renderZoneOverlay();
  }
  function cancelAreaBuildAnchor() {
    if (!areaBuildAnchor) return false;
    areaBuildAnchor = null;
    dragPreview = null;
    sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true);
    renderZoneOverlay();
    return true;
  }
  try { window.DFCancelBuildCornerAnchor = cancelAreaBuildAnchor; } catch (_) {}
  function updateDigSelect(curX, curY) {
    digSelect.style.left = Math.min(downX, curX) + "px";
    digSelect.style.top = Math.min(downY, curY) + "px";
    digSelect.style.width = Math.abs(curX - downX) + "px";
    digSelect.style.height = Math.abs(curY - downY) + "px";
  }
  // WT20 (mobile): ONE armed-placement predicate for the two drag handlers below, exported so
  // the touch layer (dwf-touch.js) can pass armed-tool touches through to this existing
  // designation path instead of intercepting them for camera panning. Same condition the two
  // handlers previously inlined (kept in exact sync by extraction).
  function placementArmed() {
    return !!(currentTool || stockPreset || stockRepaintId || zoneRepaintId || stockEraseArmed ||
      stockRemoveArmed || bipSelBuild() || zonePreset || zoneEraseArmed || zoneRemoveArmed ||
      burrowPaintId >= 0 || squadMoveArmed >= 0 || squadKillArmed >= 0 || squadPatrolArmed >= 0 || haulingStopArmedRoute >= 0);
  }
  try { window.DFPlacementArmed = placementArmed; } catch (_) {}
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
      // The backend paints the real, tile-snapped DF selection rectangle into the frame; in
      // instant mode we draw it browser-side instead (no per-move round-trip) and skip the send.
      dragAnchor = imagePixelClamped(event.clientX, event.clientY);
      if (dragAnchor) {
        if (freePaintActive()) {
          freePaintCells = new Set();
          freePaintLastCell = null;
          freePaintTo(dragAnchor);
        }
        // WD-12: track the bbox of a stockpile free-paint stroke (createStockpileDrag uses it
        // instead of the plain down/up corners once the drag ends).
        if (stockPreset && paintMode === "free") {
          stockFreeBBox = { x1: dragAnchor.x, y1: dragAnchor.y, x2: dragAnchor.x, y2: dragAnchor.y };
        }
        // New zones remain rectangle-backed. Existing-zone repaint has an exact per-cell stroke
        // buffer so free paint can preserve holes and disconnected shapes.
        if (zonePreset && !zoneRemoveArmed && paintMode === "free") {
          zoneFreeBBox = { x1: dragAnchor.x, y1: dragAnchor.y, x2: dragAnchor.x, y2: dragAnchor.y };
        }
        if (zoneRepaintId != null && !zoneRemoveArmed && paintMode === "free") {
          zoneRepaintFreeCells = new Set();
          zoneRepaintFreeLast = null;
          zoneRepaintFreePaintTo(dragAnchor);
        }
        // Existing-pile repaint session mirrors the zone one: an exact per-cell stroke buffer
        // so free paint preserves holes and disconnected shapes.
        if (stockRepaintId != null && !stockRepaintRemoveArmed && paintMode === "free") {
          stockRepaintFreeCells = new Set();
          stockRepaintFreeLast = null;
          stockRepaintFreePaintTo(dragAnchor);
        }
        // WD-13: burrow free-paint commits per-cell live (like /designate free paint).
        if (burrowPaintId >= 0 && paintMode === "free") {
          burrowFreeCells = new Set();
          burrowFreeLast = null;
          burrowFreePaintTo(dragAnchor);
        }
        if (zonePreset && !zoneEraseArmed && !zoneRemoveArmed) {
          zonePaintPreview = { x1: dragAnchor.x, y1: dragAnchor.y, x2: dragAnchor.x, y2: dragAnchor.y };
          renderZoneOverlay();
        }
        if (twoClickEligible()) {
          // B193: rectangle designations are two-click -- a press starts NO held-drag preview or
          // server drag rect (the rubber band + click legs live on pointermove/pointerup).
          // -drag1: but when the anchor is ALREADY armed this press is the second click (or a
          // held second press), and remote viewers must keep seeing the pending box, not a
          // downgraded bare cursor.
          sendTwoClickPresence(dragAnchor);
        } else if (localDragPreviewActive()) {
          const previewAnchor = areaBuildAnchor || dragAnchor;
          setDragPreview(previewAnchor, dragAnchor);
          // PRESENCE: broadcast the drag even in instant mode (self-preview stays browser-side)
          // so other players see our selection rectangle live.
          sendPlacementUi(dragAnchor.x, dragAnchor.y, dragAnchor.w, dragAnchor.h,
            true, previewAnchor.x, previewAnchor.y);
        } else {
          sendPlacementUi(dragAnchor.x, dragAnchor.y, dragAnchor.w, dragAnchor.h,
                          true, dragAnchor.x, dragAnchor.y, true);
        }
      }
    }
    // try/catch: a synthetic tap from the touch layer (dwf-touch.js) carries a pointerId
    // that is no longer active, which makes setPointerCapture throw NotFoundError. Harmless to
    // skip -- capture only matters for real drags, and those always carry live pointer ids.
    try { view.setPointerCapture(event.pointerId); } catch (_) {}
  });
  view.addEventListener("pointermove", event => {
    // B196/B193: an armed two-click range rubber-bands the selection box to the cursor. Normally
    // the button is UP between the clicks (so this runs before the pdown gate below); it also
    // tracks through a held second press, since that press commits bbox(anchor, release point).
    if (twoClickArmed()) updateTwoClickRubberBand(event.clientX, event.clientY);
    // B291: after click 1, keep the farm/construction rectangle rubber-banded while the button is
    // up. This is the same dragPreview object the held gesture updates below.
    if (areaBuildAnchor && areaBuildSelected()) {
      const cur = imagePixelClamped(event.clientX, event.clientY);
      if (cur) {
        setDragPreview(areaBuildAnchor, cur);
        sendPlacementUi(cur.x, cur.y, cur.w, cur.h, true, areaBuildAnchor.x, areaBuildAnchor.y);
      }
    }
    if (!pdown || !placementArmed()) return;
    if (dragAnchor) {
      const cur = imagePixelClamped(event.clientX, event.clientY);
      if (!cur) return;
      if (freePaintCells) freePaintTo(cur);
      if (burrowFreeCells) burrowFreePaintTo(cur);
      if (zoneRepaintFreeCells) zoneRepaintFreePaintTo(cur);
      if (stockRepaintFreeCells) stockRepaintFreePaintTo(cur);
      if (stockFreeBBox) {
        stockFreeBBox.x1 = Math.min(stockFreeBBox.x1, cur.x);
        stockFreeBBox.y1 = Math.min(stockFreeBBox.y1, cur.y);
        stockFreeBBox.x2 = Math.max(stockFreeBBox.x2, cur.x);
        stockFreeBBox.y2 = Math.max(stockFreeBBox.y2, cur.y);
      }
      if (zoneFreeBBox) {
        zoneFreeBBox.x1 = Math.min(zoneFreeBBox.x1, cur.x);
        zoneFreeBBox.y1 = Math.min(zoneFreeBBox.y1, cur.y);
        zoneFreeBBox.x2 = Math.max(zoneFreeBBox.x2, cur.x);
        zoneFreeBBox.y2 = Math.max(zoneFreeBBox.y2, cur.y);
      }
      if (zonePreset && !zoneEraseArmed && !zoneRemoveArmed) {
        zonePaintPreview = { x1: dragAnchor.x, y1: dragAnchor.y, x2: cur.x, y2: cur.y };
        renderZoneOverlay();
      }
      if (twoClickEligible()) {
        // B193: no held-drag COMMIT for rectangle designations (the rubber band + click legs
        // own the gesture). -drag1: presence still broadcasts the pending box while the anchor
        // is armed -- a held second press must keep the remote rectangle alive and growing.
        sendTwoClickPresence(cur);
      } else if (localDragPreviewActive()) {
        const previewAnchor = areaBuildAnchor || dragAnchor;
        setDragPreview(previewAnchor, cur);
        // PRESENCE: broadcast the live drag rect to other players (self-preview is browser-side).
        sendPlacementUi(cur.x, cur.y, cur.w, cur.h, true, previewAnchor.x, previewAnchor.y);
      } else {
        sendPlacementUi(cur.x, cur.y, cur.w, cur.h, true, dragAnchor.x, dragAnchor.y);
      }
    }
  });
  view.addEventListener("pointerup", event => {
    if (!pdown) return;
    pdown = false;
    digSelect.style.display = "none";
    let releasedDragAnchor = null;
    if (dragAnchor) {
      releasedDragAnchor = dragAnchor;
      const cur = imagePixelClamped(event.clientX, event.clientY);
      // Clear our broadcast drag rect (drag=0) in BOTH modes so other players stop seeing it.
      if (cur) sendPlacementUi(cur.x, cur.y, cur.w, cur.h, false, 0, 0, true);
      dragAnchor = null;
    }
    try { view.releasePointerCapture(event.pointerId); } catch (_) {}
    const clickDistance = Math.hypot(event.clientX - downX, event.clientY - downY);
    if (bipSelBuild()) {
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
    } else if (zoneRepaintId != null && !zoneRemoveArmed) {
      stageZoneRepaintDrag(downX, downY, event.clientX, event.clientY);
    } else if (zoneEraseArmed) {
      zoneEraseDrag(downX, downY, event.clientX, event.clientY);
    } else if (zoneRemoveArmed) {
      zoneRemoveClick(event);
    } else if (zonePreset) {
      zonePaintDrag(downX, downY, event.clientX, event.clientY);
    } else if (burrowPaintId >= 0) {
      // Free-paint already committed each cell live during the drag; only rect mode
      // commits here (same rule as the /designate free-paint above).
      if (burrowFreeCells) { burrowFreeCells = null; burrowFreeLast = null; }
      else burrowPaintDrag(downX, downY, event.clientX, event.clientY);
    } else if (squadMoveArmed >= 0) {
      squadMoveClick(event);
    } else if (squadKillArmed >= 0) {
      squadKillClick(event);
    } else if (squadPatrolArmed >= 0) {
      squadPatrolClick(event);
    } else if (wsLinkArmed) {
      wsLinkClick(event);
    } else if (haulingStopArmedRoute >= 0) {
      haulingStopClick(event);
    } else if (stockEraseArmed) {
      stockEraseDrag(downX, downY, event.clientX, event.clientY);
    } else if (stockRemoveArmed) {
      stockRemoveClick(event);
    } else if (stockPreset) {
      createStockpileDrag(downX, downY, event.clientX, event.clientY);
    } else if (stockRepaintId != null && !stockRepaintRemoveArmed) {
      // Repaint session: strokes are STAGED (exact world tiles); Accept owns the commit.
      stageStockRepaintDrag(downX, downY, event.clientX, event.clientY);
    } else if (stockRepaintId != null) {
      // Remove is selected from the repaint session and committed by Accept; a map click
      // while it is armed changes no fortress state.
    } else if (zoneRepaintId != null) {
      // Remove is selected from the native repaint session and committed by Accept; a map click
      // while it is armed changes no fortress state.
    } else if (currentTool) {
      // B193: every rectangle designation tool is two-click (native DF) -- the first click arms
      // the anchor, the second commits the previewed volume through the shared submitter.
      // Click-drag no longer commits a designation (a press-move-release just arms/closes with
      // the release point's bbox); free paint keeps its per-cell drag stroke -- that family is
      // legitimately drag-driven.
      if (rangeDesignationTools.has(selectedDesignation) && paintMode === "rect") {
        designateTwoClickRange(downX, downY, event.clientX, event.clientY);
      } else {
        // Free-paint already committed each cell live during the drag (freePaintTo); a
        // rect commit here would double-designate the same tiles, so only rect mode
        // (the plain, pre-existing tool=dig behavior) calls designateDrag.
        if (freePaintCells) { freePaintCells = null; freePaintLastCell = null; }
        else designateDrag(downX, downY, event.clientX, event.clientY);
      }
    } else if (chatPingArmed) {
      // B223: the armed chat ping consumes this click INSTEAD of the inspect fall-through below,
      // so picking a ping target never also opens a unit sheet. Placed after `currentTool` on
      // purpose (see the chatPingArmed declaration): a live designation tool outranks a ping.
      chatPingClick(event);
    } else if (clickDistance < 8) {
      // WD-14: in zone mode with no type armed, a plain click hits existing zones first
      // (with overlap cycling when the tile has >1 zone); non-zone tiles fall through to
      // the normal inspect.
      if (zoneMode === "menu") zoneSelectClick(event);
      else inspectClick(event);
    }
    // Hold the instant-mode preview briefly so it doesn't flash out before the server frame
    // (now carrying the committed designation) streams back, then clear it.
    if (dragPreview && !areaBuildAnchor) {
      const held = dragPreview;
      setTimeout(() => { if (dragPreview === held) { dragPreview = null; renderZoneOverlay(); } }, 380);
    }
  });
  view.addEventListener("pointercancel", () => {
    pdown = false;
    digSelect.style.display = "none";
    if (dragAnchor) {
      sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true); // clear presence drag in both modes
      dragAnchor = null;
    }
    stairRangePreview = stairRangeStart ? { ...stairRangeStart } : null;
    areaBuildAnchor = null;
    if (dragPreview) { dragPreview = null; renderZoneOverlay(); }
    freePaintCells = null;
    freePaintLastCell = null;
    stockFreeBBox = null;
    // Keep a previous completed selection, but discard the canceled in-progress drag preview.
    zonePaintPreview = zonePaintBBox ? { ...zonePaintBBox } : null;
    renderZoneOverlay();
  });

  // --- DF-style hover tooltip: shows what's on the tile under the cursor ---
  // B05c (responsiveness -- The owner: "very important ... panning over items to feel responsive and
  // smooth and contain all information"). Three mechanisms make the tooltip keep up with
  // continuous cursor movement without lag or flicker:
  //   (1) CACHE: a short-TTL map keyed by WORLD tile (camera origin + grid index), so
  //       re-hovering a tile we saw recently paints INSTANTLY with zero round-trip. Keying by
  //       world tile means the cache stays correct across camera pans/zooms automatically (the
  //       same screen cell maps to a new key after a pan; stale entries just age out by TTL).
  //   (2) COALESCING: only ONE /hover fetch is ever in flight. The old code's `hoverBusy`
  //       early-return silently DROPPED every move while a request was pending, so the tooltip
  //       stalled on a stale tile whenever the cursor outran the network. Now we remember the
  //       latest desired tile and, the moment the in-flight fetch resolves, immediately fetch
  //       that tile -- the tooltip always converges to where the cursor actually is.
  //   (3) tighter sampling: a 1-tile deadband (any tile change updates) + a short throttle,
  //       vs the old 80ms + 3-tile deadband that felt sluggish.
  const hoverInfo = document.getElementById("hoverInfo");
  const HOVER_CACHE_TTL_MS = 2500;   // tile contents change slowly; re-hover within this is instant
  const HOVER_THROTTLE_MS = 45;      // coalesce pointermove bursts to ~22/s of tile sampling
  const hoverCache = new Map();      // "wx,wy,wz" -> { data, ts }
  let hoverTileKey = "";             // world-tile key currently displayed
  let hoverAt = 0;
  let hoverInFlight = false;         // single-flight guard
  let hoverWant = null;              // latest desired { key, px, py, w, h } queued behind a fetch
  // Latency/effectiveness instrumentation for before/after evidence (window.__hoverStats).
  const hoverStats = { fetches: 0, cacheHits: 0, lastMs: 0, totalMs: 0, maxMs: 0,
    get avgMs() { return this.fetches ? this.totalMs / this.fetches : 0; } };
  try { window.__hoverStats = hoverStats; } catch (_) {}

  function renderHover(d) {
    if (!d) { hoverInfo.style.display = "none"; hoverTileKey = ""; return; }
    // B24: DF's real tooltip (native-window captures, results/b24_native_compare/) is a box
    // at the top of the screen with ONE ENTRY PER LINE, colored per category: units white,
    // items white, buildings green, plant/terrain purple, water blue, fallen growths green,
    // spatter red-brown. The server tags each line via the parallel `kinds` array; `material`
    // is only consulted for an old (pre-B24) server that reported the terrain there.
    const lines = (Array.isArray(d.lines) ? d.lines : []).filter(Boolean);
    const kinds = Array.isArray(d.kinds) ? d.kinds : [];
    let html = lines.map((l, i) =>
      `<div class="hv-line hv-${escapeHtml(String(kinds[i] || "unit"))}">${escapeHtml(l)}</div>`).join("");
    if (d.material && lines.indexOf(d.material) < 0)
      html += `<div class="hv-line hv-terrain">${escapeHtml(d.material)}</div>`;
    if (!html) { hoverInfo.style.display = "none"; hoverTileKey = ""; return; }
    hoverInfo.innerHTML = html;
    hoverInfo.style.display = "block";
  }
  function worldTileKey(px, py) {
    const rr = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    if (!rr) return `${px},${py},g`;   // geometry unknown -> fall back to grid-index key
    return `${rr.ox + px},${rr.oy + py},${rr.oz}`;
  }
  function paintFromCache(key) {
    const cached = hoverCache.get(key);
    if (!cached || (performance.now() - cached.ts) >= HOVER_CACHE_TTL_MS) return false;
    hoverStats.cacheHits++;
    hoverTileKey = key;
    renderHover(cached.data);
    return true;
  }
  function pumpHover() {
    if (hoverInFlight || !hoverWant) return;
    const want = hoverWant;
    hoverWant = null;
    if (paintFromCache(want.key)) return;               // fresh in cache -> no network
    hoverInFlight = true;
    const t0 = performance.now();
    const url = `/hover?player=${encodeURIComponent(player)}&px=${want.px}&py=${want.py}&w=${want.w}&h=${want.h}`;
    fetch(url, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        const ms = performance.now() - t0;
        hoverStats.fetches++; hoverStats.lastMs = ms; hoverStats.totalMs += ms;
        if (ms > hoverStats.maxMs) hoverStats.maxMs = ms;
        if (data) hoverCache.set(want.key, { data, ts: performance.now() });
        // Only paint if the cursor is still on this tile (no queued newer want) -- avoids
        // a stale reply overwriting a fresher tile the cursor already moved onto (flicker).
        if (!hoverWant || hoverWant.key === want.key) {
          hoverTileKey = want.key;
          renderHover(data);
        }
      })
      .catch(() => {})
      .finally(() => {
        hoverInFlight = false;
        if (hoverWant) pumpHover();                     // chase the latest tile immediately
      });
  }
  function requestHover(px, py, w, h) {
    const key = worldTileKey(px, py);
    if (key === hoverTileKey) return;                   // already showing this exact tile
    if (paintFromCache(key)) return;                    // instant paint entering a cached tile
    hoverWant = { key, px, py, w, h };
    pumpHover();
  }
  view.addEventListener("pointermove", event => {
    if (pdown) return; // suppressed while click-dragging a designation
    const pixel = imagePixelFromEvent(event);
    if (!pixel) { hoverInfo.style.display = "none"; return; }
    // PRESENCE: always report our hovered tile so other players see our live cursor,
    // independent of tool/instant mode (throttled inside sendPlacementUi). With no tool
    // selected this is a pure presence heartbeat (drag=0, no footprint).
    sendPlacementUi(pixel.x, pixel.y, pixel.w, pixel.h, false, 0, 0);
    // BUILD PREVIEW: track the footprint under the cursor for the browser-side green/red
    // placement overlay (drawBuildPreview). Cleared as soon as no build tool is armed.
    if (bipSelBuild() && !areaBuildSelected()) {
      const bw = (bipSelBuild().size && bipSelBuild().size.w) || 1;
      const bh = (bipSelBuild().size && bipSelBuild().size.h) || 1;
      buildPreview = { gx: pixel.x, gy: pixel.y, w: bw, h: bh };
      renderZoneOverlay();
    } else if (buildPreview) {
      buildPreview = null;
      renderZoneOverlay();
    }
    const now = performance.now();
    if (now - hoverAt < HOVER_THROTTLE_MS) return;
    hoverAt = now;
    requestHover(pixel.x, pixel.y, pixel.w, pixel.h);
  });
  view.addEventListener("pointerleave", () => {
    hoverInfo.style.display = "none";
    hoverTileKey = "";
    hoverWant = null;
    // PRESENCE: clear our cursor for other players when the pointer leaves the map.
    if (!pdown) sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true);
    if (buildPreview) { buildPreview = null; renderZoneOverlay(); } // drop build footprint
  });
  view.addEventListener("pointerdown", () => { hoverInfo.style.display = "none"; hoverTileKey = ""; });
