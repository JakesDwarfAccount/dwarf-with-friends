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

  async function loadHud() {
    try {
      const response = await fetch(`/hud?player=${encodeURIComponent(player)}&t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("hud failed");
      currentHud = await response.json();
      renderHud(currentHud);
      renderZoneOverlay();
    } catch { /* the one-second HUD cadence retries while the current HUD remains visible */ }
  }

  // While the host places dig/build/chop orders the plugin holds the last frame; the banner says why
  // the view paused instead of leaving a silent freeze.
  function showHostBusyBanner(show) {
    let el = document.getElementById("hostBusyBanner");
    if (!el) {
      el = document.createElement("div");
      el.id = "hostBusyBanner";
      el.className = "host-busy-banner";
      el.innerHTML = '<span class="host-busy-indicator"></span>' +
        'Paused: Host is setting dig orders &mdash; please wait';
      document.body.appendChild(el);
    }
    el.classList.toggle("is-visible", show);
  }

  const moodCounts = Array.from(document.querySelectorAll("#moods .mood-n"));
  const TOP_STOCK_KEYS = ["food", "drink", "seeds", "meat", "fish", "plant", "other"];
  const topStockEls = Object.fromEntries(TOP_STOCK_KEYS.map(key => [key, document.getElementById(key)]));
  // The wire ships `moonIcon` as a column of the moon_weather page (src/hud.cpp), so the index has
  // to be named before a painter can draw it; the cell itself comes from the sprite map.
  const MOON_WEATHER_TOKENS = [
    "MOON_WAXING_CRESCENT", "MOON_WAXING_HALF_MOON", "MOON_WAXING_GIBBOUS", "MOON_FULL_MOON",
    "MOON_WANING_GIBBOUS", "MOON_WANING_HALF_MOON", "MOON_WANING_CRESCENT", "MOON_NEW_MOON",
    "MOON_SNOW", "MOON_RAIN",
  ];
  function ordinal(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    switch (n % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  }

  function renderHud(hud) {
    showHostBusyBanner(!!hud.hostInteracting);
    const isPaused = !!hud.paused;
    const pauseBtn = document.querySelector('#topbar [data-action="pause"]');
    const playBtn = document.querySelector('#topbar [data-action="play"]');
    if (pauseBtn) pauseBtn.classList.toggle("sb-active", isPaused);
    if (playBtn) playBtn.classList.toggle("sb-active", !isPaused);
    if (typeof window.DFRefreshPauseIcons === "function") window.DFRefreshPauseIcons(isPaused);
    try {
      if (window.DFAnimClock && !window.__dfPauseByBroadcast) window.DFAnimClock.setPaused(isPaused);
    } catch { /* animation-clock failure must not interrupt the HUD cadence */ }
    // Feed the lobby's pause line; a {"type":"pause"} broadcast overrides it with "Paused by <actor>".
    if (window.DwfLobby && typeof DwfLobby.setPauseText === "function"
        && !window.__dfPauseByBroadcast) DwfLobby.setPauseText(isPaused ? "Paused" : "Running");
    hudEls.fortName.textContent = hud.fort?.name || "Fortress";
    hudEls.siteName.textContent = hud.fort?.site || "Site";
    hudEls.rankName.textContent = hud.fort?.rank || "Outpost";
    hudEls.population.textContent = hud.population?.total ?? 0;
    const happ = Array.isArray(hud.happiness) ? hud.happiness : [];
    moodCounts.forEach((el, i) => {
      const n = happ[i] || 0;
      el.textContent = n;
      el.parentElement.classList.toggle("is-empty", !n);
    });
    // Native dims "None" (0) and brightens an approximate reading; a narrow frame clips the tail.
    const setStock = (el, n) => {
      if (!el) return;
      const count = Math.max(0, Number(n) || 0);
      el.textContent = count > 0 ? `~${count}` : "None";
      el.classList.toggle("has-value", count > 0);
    };
    TOP_STOCK_KEYS.forEach(key => setStock(topStockEls[key], hud.stocks?.[key]));
    const setBitmapHudText = (node, text) => {
      if (!node) return;
      const value = String(text == null ? "" : text);
      node.setAttribute("data-dwfui-bitmap-text", value);
      const fallback = node.querySelector(".dwfui-bitmap-fallback");
      if (fallback) fallback.textContent = value;
    };
    setBitmapHudText(hudEls.dateDay, ordinal(hud.date?.day || 1));
    setBitmapHudText(hudEls.dateMonth, hud.date?.monthName || "Granite");
    setBitmapHudText(hudEls.dateSeason, hud.date?.season || "Early Spring");
    setBitmapHudText(hudEls.dateYear, `Year ${hud.date?.year ?? 0}`);
    setBitmapHudText(hudEls.elevation, `Elevation ${hud.elevation ?? 0}`);
    // The weather block is the moon_weather strip: DF overrides the moon-phase cell with the Rain or
    // Snow cell (indices 8/9) while precipitating.
    const moonIcon = Math.max(0, Math.min(7, Number(hud.date?.moonIcon ?? 0)));
    const weatherIcon = hud.weather === "Rain" ? 9 : hud.weather === "Snow" ? 8 : moonIcon;
    if (hudEls.moon) {
      // Rebuilt only when the phase or weather actually turns over: this runs on every HUD tick.
      const token = MOON_WEATHER_TOKENS[weatherIcon];
      if (hudEls.moon.dataset.moonToken !== token) {
        hudEls.moon.dataset.moonToken = token;
        hudEls.moon.innerHTML = DWFUI.iconHtml({ sprite: token });
        DWFUI.paintSprites(hudEls.moon);
      }
      hudEls.moon.title = `Weather: ${hud.weather || "Clear"}`;
      hudEls.moon.setAttribute("aria-label", hudEls.moon.title);
    }
    window.renderMinimap(hud);
    if (typeof renderZScrollbar === "function") renderZScrollbar(hud);
  }


  if (typeof window !== "undefined") Object.assign(window, { loadHud, renderHud });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { loadHud, renderHud, ordinal });
