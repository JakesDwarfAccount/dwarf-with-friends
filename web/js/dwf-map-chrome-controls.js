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

  function bipSelBuild() { try { return selectedBuild; } catch (_) { return null; } }
  function minimapElement() { return document.getElementById("minimap"); }

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
      if (!res.ok) {
        const reason = (await res.text().catch(() => "")).replace(/^action failed:\s*/i, "").trim();
        try {
          if (reason && window.DwfPause && typeof DwfPause.toast === "function")
            DwfPause.toast(reason);
        } catch (_) { DwfErr.count("placement.action-toast"); }
      }
    } catch (err) { DwfOrder.lost("placement.action", err, `"${action}"`); }
    loadHud();
  }

  function centerFromMinimap(event) {
    if (!currentHud) return;
    const minimap = minimapElement();
    if (!minimap) return;
    const rect = minimap.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const fy = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const map = currentHud.map || { w: 1, h: 1 };
    const vp = currentHud.viewport || { w: 80, h: 50 };
    const x = Math.round(fx * map.w - vp.w / 2);
    const y = Math.round(fy * map.h - vp.h / 2);
    const z = currentHud.camera?.z ?? 0;
    resetPanPrediction();
    fetch(`/camera?player=${encodeURIComponent(player)}&x=${x}&y=${y}&z=${z}`, { method: "POST", cache: "no-store" })
      .then(r => { DwfOrder.cameraHttpResult(r, "minimap-jump"); return loadHud(); })
      .catch((err) => DwfErr.report("camera.minimap-jump", err));
  }
  function recenterZ(which) {
    if (!currentHud) return;
    const mm = currentHud.minimap || {};
    const cam = currentHud.camera || { x: 0, y: 0, z: 0 };
    const z = which === "deepest" ? (mm.deepestZ ?? cam.z) : (mm.surfaceZ ?? cam.z);
    resetPanPrediction();
    fetch(`/camera?player=${encodeURIComponent(player)}&x=${cam.x}&y=${cam.y}&z=${z}`, { method: "POST", cache: "no-store" })
      .then(r => { DwfOrder.cameraHttpResult(r, "recenter-z"); return loadHud(); })
      .catch((err) => DwfErr.report("camera.recenter-z", err));
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

  const topbarPauseBtn = document.querySelector('#topbar [data-action="pause"]');
  const topbarPlayBtn = document.querySelector('#topbar [data-action="play"]');
  const topbarHelpBtn = document.getElementById("helpBtn");
  function paintTopbarGlyphIcon(button, initialToken) {
    if (!button) return null;
    const chrome = window.DFChrome;
    if (!chrome || typeof chrome.icon !== "function") return null;
    button.textContent = "";
    const icon = chrome.icon(initialToken, 22);
    button.appendChild(icon);
    return icon;
  }
  const topbarPauseIcon = paintTopbarGlyphIcon(topbarPauseBtn, "BUTTON_PAUSE_INACTIVE");
  const topbarPlayIcon = paintTopbarGlyphIcon(topbarPlayBtn, "BUTTON_PLAY_ACTIVE");
  window.DFRefreshPauseIcons = isPaused => {
    const chrome = window.DFChrome;
    if (!chrome || typeof chrome.updateIcon !== "function") return;
    if (topbarPauseIcon) chrome.updateIcon(topbarPauseIcon,
      isPaused ? "BUTTON_PAUSE_ACTIVE" : "BUTTON_PAUSE_INACTIVE", 22);
    if (topbarPlayIcon) chrome.updateIcon(topbarPlayIcon,
      isPaused ? "BUTTON_PLAY_INACTIVE" : "BUTTON_PLAY_ACTIVE", 22);
  };

  // --- Settings cog: the full Settings panel is the single settings entry point. ---
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsMenu = document.getElementById("settingsMenu");
  // index.html ships the legacy cog popover as static markup; remove it or DFSettings gets a
  // second, divergent surface for the same preferences.
  if (settingsMenu) settingsMenu.remove();
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
    window.DwfUtil.lsSet("dfplex.instantDesignate", instantDesignate ? "1" : "0");
    if (instantDesignate) {
      // entering instant mode: drop any server-painted cursor so it doesn't linger in the frame
      if (window.placementActive()) window.sendPlacementUi(-1, -1, 0, 0, false, 0, 0, true);
    } else {
      // leaving instant mode: drop the browser preview; the server cursor resumes on next move
      dragPreview = null;
      renderZoneOverlay();
    }
    refreshSettingsUi();
  }
  function setPredictivePan(on) {
    predictivePan = !!on;
    window.DwfUtil.lsSet("dfplex.predictivePan", predictivePan ? "1" : "0");
    if (predictivePan) applyPanPrediction(); else clearPanPrediction();
    refreshSettingsUi();
  }
  function setUnitImagesEnabled(on) {
    unitImagesEnabled = !!on;
    window.DwfUtil.lsSet("dfplex.unitImages", unitImagesEnabled ? "1" : "0");
    if (selection.classList.contains("unit-sheet-panel") && selectedUnitData)
      renderUnitSheet();
    if (activeInfoPanel && clientPanel.classList.contains("visible"))
      openPanel(activeInfoPanel, activeInfoSection || "", activeInfoDetail || "");
    refreshSettingsUi();
  }
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
    document.addEventListener("pointerdown", event => {
      if (!settingsMenu.classList.contains("open")) return;
      if (event.target.closest("#settingsMenu, #settingsBtn")) return;
      settingsMenu.classList.remove("open");
      refreshSettingsUi();
    });
  }
  if (topbarHelpBtn) topbarHelpBtn.addEventListener("click", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (window.DFHelpPanel && typeof window.DFHelpPanel.toggle === "function") window.DFHelpPanel.toggle();
    else if (window.DFSettings && typeof window.DFSettings.open === "function") window.DFSettings.open("keybinds");
    focusPage();
  });
  refreshSettingsUi();

  // dwf-settings.js's Interface panel renders and toggles these rows off DFClientPrefs.list(), so
  // a client pref missing from this list gets no row there.
  window.DFClientPrefs = {
    list() {
      return [
        { id: "instantDesignate", label: "Instant designations", get: () => instantDesignate, set: setInstantDesignate },
        { id: "predictivePan",    label: "Predictive panning",    get: () => predictivePan,    set: setPredictivePan },
        { id: "unitImages",       label: "Unit images",           get: () => unitImagesEnabled, set: setUnitImagesEnabled },
        { id: "showAttribution",  label: "Show attribution",
          get: () => (typeof attribShowEnabled === "function" ? attribShowEnabled() : true),
          set: setShowAttributionEnabled },
        { id: "weatherParticles", label: "Weather particles (rain/snow overlay)",
          get: () => (window.DwfWeather && typeof window.DwfWeather.isEnabled === "function" ? window.DwfWeather.isEnabled() : true),
          set: (on) => { try { if (window.DwfWeather && typeof window.DwfWeather.setEnabled === "function") window.DwfWeather.setEnabled(!!on); }
            catch (err) { DwfErr.report("chrome.weather-toggle", err); } } },
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

  const UI_SCALE_MIN = 0.7, UI_SCALE_MAX = 1.6, UI_SCALE_STEP = 0.1;
  let uiScale = 1;
  {
    const saved = parseFloat(window.DwfUtil.lsGet("dfplex.uiScale"));
    if (Number.isFinite(saved)) uiScale = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, saved));
  }
  const uiScaleReadout = document.getElementById("uiScaleReadout");
  function applyUiScale() {
    document.documentElement.style.setProperty("--ui-scale", String(uiScale));
    if (uiScaleReadout) uiScaleReadout.textContent = Math.round(uiScale * 100) + "%";
  }
  function setUiScale(v) {
    uiScale = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(v * 100) / 100));
    window.DwfUtil.lsSet("dfplex.uiScale", String(uiScale));
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
    if (document.getElementById("helpPopup")?.classList.contains("open")) {
      if (["=", "+", "Add", "-", "_", "Subtract", "0"].includes(k)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (k === "=" || k === "+" || k === "Add") { event.preventDefault(); adjustUiScale(1); }
    else if (k === "-" || k === "_" || k === "Subtract") { event.preventDefault(); adjustUiScale(-1); }
    else if (k === "0") { event.preventDefault(); resetUiScale(); }
  }, { capture: true });

  function refreshZoomLimitFaces() {
    const zoom = (tileRenderer && typeof tileRenderer.getZoom === "function")
      ? tileRenderer.getZoom() : null;
    if (!zoom) return;
    const atLimit = { in: zoom.px >= zoom.max, out: zoom.px <= zoom.min };
    document.querySelectorAll("[data-map-zoom]").forEach(button => {
      const direction = button.dataset.mapZoom;
      if (direction !== "in" && direction !== "out") return;
      const icon = button.querySelector("[data-dwfui-sprite-states]");
      if (!icon) return;
      const state = atLimit[direction] ? "disabled" : "base";
      // Never set a real `disabled` attribute here: the face changes but the control must stay hittable,
      // or this cluster loses the hover-help it is the tooltip surface for.
      button.setAttribute("aria-disabled", atLimit[direction] ? "true" : "false");
      if (icon.getAttribute("data-dwfui-sprite-state") === state) return;
      icon.setAttribute("data-dwfui-sprite-state", state);
      try {
        if (window.DWFUI && typeof window.DWFUI.paintSprites === "function")
          window.DWFUI.paintSprites(button);
      } catch (_) { /* zoom remains usable when optional sprite art cannot paint */ }
    });
  }
  document.querySelectorAll("[data-map-zoom]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const direction = button.dataset.mapZoom;
      if (direction !== "in" && direction !== "out") return;
      zoomView(direction);
      updateZoomReadout();
      refreshZoomLimitFaces();
      focusPage();
    });
  });
  refreshZoomLimitFaces();
  window.addEventListener("dwf-zoom-changed", refreshZoomLimitFaces);

  const RIGHT_CHROME_HOVER_DELAY_MS = 500;
  const RIGHT_CHROME_HOVER_STALE_MS = 1000;
  const rightChromeHoverOverlay = document.getElementById("minimapToolHover");
  const rightChromeMinimap = minimapElement();
  const rightChromeHoverTools = document.querySelectorAll(
    '#minimapToolCol [data-dwf-hover-id][data-dwf-hover-replace-minimap="true"]');
  if (rightChromeHoverOverlay && rightChromeMinimap) {
    let rightChromeShowTimer = null;
    let rightChromeStaleTimer = null;
    let rightChromeHoverTarget = null;
    const clearRightChromeTimer = timer => {
      if (timer !== null) clearTimeout(timer);
      return null;
    };
    const resetRightChromeHover = () => {
      rightChromeHoverOverlay.hidden = true;
      rightChromeHoverOverlay.textContent = "";
      delete rightChromeHoverOverlay.dataset.dwfHoverId;
      rightChromeMinimap.removeAttribute("data-dwf-hover-replaced");
    };
    rightChromeHoverTools.forEach(button => {
      const hoverText = button.getAttribute("data-dwf-hover-text") ||
        button.getAttribute("data-df-title") || button.getAttribute("title") ||
        button.getAttribute("aria-label") || "";
      if (hoverText) button.setAttribute("data-dwf-hover-text", hoverText);
      button.removeAttribute("title");
      button.removeAttribute("data-df-title");
      button.addEventListener("pointerenter", () => {
        rightChromeHoverTarget = button;
        rightChromeShowTimer = clearRightChromeTimer(rightChromeShowTimer);
        rightChromeStaleTimer = clearRightChromeTimer(rightChromeStaleTimer);
        rightChromeShowTimer = setTimeout(() => {
          if (rightChromeHoverTarget !== button) return;
          rightChromeHoverOverlay.textContent = hoverText;
          rightChromeHoverOverlay.dataset.dwfHoverId = button.dataset.dwfHoverId;
          rightChromeHoverOverlay.hidden = false;
          rightChromeMinimap.setAttribute("data-dwf-hover-replaced", "true");
        }, RIGHT_CHROME_HOVER_DELAY_MS);
      });
      button.addEventListener("pointerleave", () => {
        if (rightChromeHoverTarget !== button) return;
        rightChromeHoverTarget = null;
        rightChromeShowTimer = clearRightChromeTimer(rightChromeShowTimer);
        rightChromeStaleTimer = clearRightChromeTimer(rightChromeStaleTimer);
        rightChromeStaleTimer = setTimeout(resetRightChromeHover, RIGHT_CHROME_HOVER_STALE_MS);
      });
    });
  }

  document.querySelectorAll("[data-recenter]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      recenterZ(button.dataset.recenter);
      focusPage();
    });
  });

  const minimapControl = minimapElement();
  if (minimapControl) {
    minimapControl.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      centerFromMinimap(event);
      focusPage();
    });
  }

  const followBtn = document.getElementById("followBtn");
  const followLocks = [];   // [{ label, api }] -- filled below from whichever modules are present
  function followingLabels() {
    return followLocks
      .filter(l => { try { return !!(l.api.getState() || {}).following; }
        catch (err) { DwfErr.report("chrome.follow-state", err); return false; } })
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
      followLocks.forEach(lock => {
        try { if (typeof lock.api.stopFollow === "function") lock.api.stopFollow("top-right"); }
        catch (err) { DwfErr.report("chrome.follow-stop", err); }
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

  let displayToggles = { liquidNumbers: false, rampArrows: false };
  try {
    const saved = JSON.parse(window.DwfUtil.lsGet("dfplex.displayToggles") || "null");
    if (saved && typeof saved === "object") displayToggles = { ...displayToggles, ...saved };
  } catch (err) { DwfErr.report("chrome.display-toggles-read", err); }
  function persistDisplayToggles() {
    window.DwfUtil.lsSet("dfplex.displayToggles", JSON.stringify(displayToggles));
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
  function setDisplayToggleSprite(btn, token) {
    if (!btn) return;
    const icon = btn.querySelector("[data-dwfui-sprite]");
    if (!icon || icon.getAttribute("data-dwfui-sprite") === token) return;
    icon.setAttribute("data-dwfui-sprite", token);
    try {
      if (window.DWFUI && typeof window.DWFUI.paintSprites === "function") window.DWFUI.paintSprites(btn);
    } catch (_) { DwfErr.count("chrome.display-toggle-paint"); }
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
  let zbMaxZ = 1;  // latest max-z from hud.map.z; reused when the roster drives a repaint
  let zbCamZ = 0, zbSurfZ = 0;
  // The sizing law lives with the markup builder in dwf-interface-shell.js, so the strip the player
  // sees and the strip a test measures cannot disagree about it.
  function zStripRowCount() {
    const shell = window.DwfInterfaceShell;
    const track = zScrollTrack && zScrollTrack.getBoundingClientRect();
    if (!track || !shell || typeof shell.zStripRowsForHeight !== "function") return 0;
    return shell.zStripRowsForHeight(track.height, document);
  }
  function renderZStripBands() {
    const canvas = document.getElementById("zScrollBands");
    const shell = window.DwfInterfaceShell;
    if (!canvas || !shell || typeof shell.zStripSpecJson !== "function") return;
    const rows = zStripRowCount();
    if (!rows) return;
    const spec = shell.zStripSpecJson(rows, zbCamZ, zbSurfZ);
    if (canvas.getAttribute("data-dwfui-cell-runs") === spec) return;
    canvas.setAttribute("data-dwfui-cell-runs", spec);
    try {
      if (window.DWFUI && typeof window.DWFUI.paintSprites === "function")
        window.DWFUI.paintSprites(zScrollTrack);
    } catch (_) { /* z navigation remains usable when optional band art cannot paint */ }
  }
  function renderZScrollbar(hud) {
    if (!zScrollTrack) return;
    const maxZ = Math.max(1, (hud.map?.z || 1) - 1);
    zbMaxZ = maxZ;
    const camZ = hud.camera?.z ?? 0;
    const surfZ = hud.minimap?.surfaceZ ?? camZ;
    zbCamZ = camZ;
    zbSurfZ = surfZ;
    if (zScrollCamMarker) zScrollCamMarker.style.setProperty("--z-marker-frac", (fracFromZ(camZ, maxZ) * 100).toFixed(2) + "%");
    if (zScrollSurfaceTick) zScrollSurfaceTick.style.setProperty("--z-marker-frac", (fracFromZ(surfZ, maxZ) * 100).toFixed(2) + "%");
    zScrollbar.dataset.maxZ = String(maxZ);
    renderZStripBands();
    renderOtherElevations();   // repaint other players' triangles against the fresh maxZ
  }
  if (zScrollTrack) {
    window.addEventListener("resize", () => renderZStripBands());
    renderZStripBands();
  }

  function renderOtherElevations() {
    if (!zScrollTrack) return;
    try {
      const P = window.DwfPresence;
      const roster = (P && Array.isArray(P.roster)) ? P.roster : [];
      const colorOf = (window.DwfTiles && typeof DwfTiles.playerColor === "function")
        ? DwfTiles.playerColor : null;
      if (zScrollCamMarker && colorOf) {
        const me = roster.find(p => p && p.self);
        const myName = me ? me.name : (typeof player !== "undefined" ? player : null);
        if (myName) zScrollCamMarker.style.setProperty("--z-marker-color", colorOf(myName).fill);
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
        tri.style.setProperty("--z-peer-frac", (frac * 100).toFixed(2) + "%");
        tri.style.setProperty("--z-peer-collision", String(collisions));
        if (colorOf) tri.style.setProperty("--z-peer-color", colorOf(p.name).fill);
        // p.name stays the RAW roster key because playerColor() is keyed on it; only the rendered
        // label goes through DwfLobby.displayName.
        const triName = (window.DwfLobby && typeof DwfLobby.displayName === "function")
          ? DwfLobby.displayName(p.name).text : String(p.name == null ? "" : p.name);
        tri.title = `${triName} — z ${p.camz}`;
        zScrollTrack.appendChild(tri);
      }
    } catch (_) { /* player elevation remains readable from the primary marker list */ }
  }
  function setZFromScrollbarEvent(event) {
    if (!currentHud) return;
    const maxZ = Number(zScrollbar.dataset.maxZ || ((currentHud.map?.z || 1) - 1));
    const frac = zFracFromClientY(event.clientY);
    const z = Math.round((1 - frac) * maxZ);
    resetPanPrediction();
    fetch(`/camera?player=${encodeURIComponent(player)}&z=${z}`, { method: "POST", cache: "no-store" })
      .then(loadHud).catch(err => DwfErr.report("chrome.z-scroll", err));
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
    const endZDrag = event => { zDragging = false;
      try { zScrollbar.releasePointerCapture(event.pointerId); }
      catch (_) { /* release is harmless after lost capture */ }
    };
    zScrollbar.addEventListener("pointerup", endZDrag);
    zScrollbar.addEventListener("pointercancel", endZDrag);
  }
  // Repaint on roster change, throttled to ~4 Hz: the roster itself arrives at the ~30 Hz AUX rate.
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
      const kind = String(data.kind || "").toLowerCase();
      // An engraving is a tile property, not an occupant, so "engraving" must stay in this list or
      // no engraved tile opens a panel.
      const panelKinds = { workshop: 1, unit: 1, stockpile: 1, building: 1, item: 1, zone: 1,
                           engraving: 1, vermin: 1, "planned-engraving": 1 };
      if (!panelKinds[kind]) return;
      if (window.DFTileList && typeof window.DFTileList.consumeInspect === "function" &&
          window.DFTileList.consumeInspect(data, pixel)) return;
      showSelection(data);
    } catch (_) {
      // Failure to inspect a tile is silent too: DF shows no "Nothing selected" box.
    }
  }


  if (typeof window !== "undefined") Object.assign(window, {
    bipSelBuild, performAction, setDisplayToggle, inspectClick,
  });

  if (typeof window !== "undefined") {
    window.DFPlacementController = window.DFPlacementController || {};
    Object.defineProperties(window.DFPlacementController, {
      displayToggles: { get: () => displayToggles, set: value => { displayToggles = value; }, configurable: true }
    });
  }
