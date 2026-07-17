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

// dwf-weather.js -- WC-20 weather ambience overlay (rain / snow).
//
// Self-contained, renderer-agnostic, ADDITIVE-ONLY module (same posture as
// dwf-unitcycle.js): it owns its OWN fixed full-viewport canvas layered ABOVE both the
// GL and canvas2d map canvases (pointer-events:none), and animates DF's coarse weather
// (None/Rain/Snow) as screen-space particles -- NOT part of either renderer's tile scene, so
// it can never regress parity (the parity gate screenshots the map canvas; this layer is a
// separate element the gate never captures, and it is off by default under ?weatherfx=0).
//
// Data source: DwfTiles.getLatest().env = { weather: 0 None / 1 Rain / 2 Snow, season,
// year_tick } -- the WC-20 AUX field the server piggybacks onto the ~30Hz stream. Particles
// only fall while weather != None AND the current view actually shows the sky (>=1 `outside`
// tile in getLatest().tiles) -- DF draws no rain over a fully-underground view.
//
// Kill switch: ?weatherfx=0 (spec-required for parity runs) disables the layer entirely.

(function (root) {
  "use strict";

  var params = (function () {
    try { return new URLSearchParams(root.location && root.location.search || ""); }
    catch (_) { return { get: function () { return null; }, has: function () { return false; } }; }
  })();
  // Off when explicitly disabled; also inert if there's no DOM (node harness) -- guarded below.
  var DISABLED = params.get("weatherfx") === "0" || !!root.__DWF_STORY_MODE;

  var canvas = null, ctx = null, rafId = 0, running = false;
  var particles = [];
  var lastT = 0;
  var curWeather = 0;     // 0 none / 1 rain / 2 snow -- last applied state (for pool resizing)

  // WTHR-1: user setting -- "Weather particles (rain/snow overlay)". Gates the DRAW ONLY (this
  // invented ambience layer that native DF has no counterpart for); the weather DATA stream
  // (DwfTiles.getLatest().env / .tiles) is never touched, so nothing that reads weather state
  // breaks and re-enabling is instant (the pool + live state keep flowing while it is off).
  // Distinct from the ?weatherfx=0 parity kill switch (DISABLED) above: this is a persisted
  // player preference, default ON, driven from the Settings > Interface panel via DFClientPrefs.
  // Persisted per browser under the family's dfplex.* localStorage convention.
  var LS_ENABLED = "dfplex.weatherParticles";
  function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (_) { return null; } }
  function lsSet(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, v); } catch (_) {} }
  var enabled = lsGet(LS_ENABLED) !== "0";   // default ON; only an explicit stored "0" disables

  // Fixed densities/speeds (DF-like ambience, not physically tuned). Rain: fast thin diagonal
  // streaks; snow: slow drifting dots. Count scales with viewport area, capped.
  var RAIN = { count: 260, vy: 900, vx: -120, len: 14, w: 1.1, color: "rgba(150,170,205,0.45)" };
  var SNOW = { count: 170, vy: 90,  vx: 18,   r: 1.6, sway: 26, color: "rgba(240,244,250,0.85)" };

  function vw() { return (root.innerWidth || (canvas && canvas.width) || 1280); }
  function vh() { return (root.innerHeight || (canvas && canvas.height) || 800); }

  function ensureCanvas() {
    if (canvas || DISABLED || typeof root.document === "undefined" || !root.document.body) return canvas;
    var c = root.document.createElement("canvas");
    c.id = "dwf-weather-overlay";
    var s = c.style;
    s.position = "fixed"; s.left = "0"; s.top = "0"; s.width = "100%"; s.height = "100%";
    s.pointerEvents = "none"; s.zIndex = "40"; // above the map canvases, below HUD panels/menus
    root.document.body.appendChild(c);
    canvas = c; ctx = c.getContext("2d");
    resize();
    root.addEventListener("resize", resize);
    return canvas;
  }

  function resize() {
    if (!canvas) return;
    var dpr = Math.min(2, root.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(vw() * dpr));
    canvas.height = Math.max(1, Math.round(vh() * dpr));
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function targetCount(weather) {
    if (weather === 0) return 0;
    var base = (weather === 2) ? SNOW.count : RAIN.count;
    var scale = Math.min(1.6, Math.max(0.4, (vw() * vh()) / (1280 * 800)));
    return Math.round(base * scale);
  }

  // Deterministic review model for Parity Studio. It shares the live overlay's exact particle
  // styles and speed geometry but uses a fixed distribution so approvals do not change on every
  // render. Production animation remains driven by the same RAIN/SNOW constants below.
  function previewModel(weather, width, height, count) {
    var W = Math.max(1, Number(width) || 960), H = Math.max(1, Number(height) || 540);
    var kind = Number(weather) === 2 ? "snow" : Number(weather) === 1 ? "rain" : "none";
    var want = Math.max(0, Number(count) || (kind === "snow" ? 70 : kind === "rain" ? 90 : 0));
    var out = [];
    for (var i = 0; i < want; i++) {
      var x = ((i * 73 + 29) % 997) / 997 * W;
      var y = ((i * 151 + 61) % 991) / 991 * H;
      out.push(kind === "snow"
        ? { x: x, y: y, r: SNOW.r, color: SNOW.color }
        : { x: x, y: y, dx: RAIN.vx / RAIN.vy * RAIN.len, dy: -RAIN.len, width: RAIN.w, color: RAIN.color });
    }
    return { kind: kind, width: W, height: H, particles: out };
  }

  function seedParticle(p) {
    p.x = Math.random() * vw();
    p.y = Math.random() * vh();
    p.phase = Math.random() * Math.PI * 2;
    // A shared velocity plus exact y=-len resets eventually quantizes every drop onto a few
    // frame-spaced rows. Stable per-drop jitter preserves an organic distribution at no extra
    // allocation or particle-count cost.
    p.rainVy = RAIN.vy * (0.86 + Math.random() * 0.28);
    return p;
  }

  function advanceRainParticle(p, dt, W, H) {
    var vy = p.rainVy || RAIN.vy;
    p.y += vy * dt;
    p.x += RAIN.vx * dt;
    if (p.y > H + RAIN.len) {
      // Preserve overshoot instead of snapping every recycled drop to one shared row.
      p.y -= H + RAIN.len * 2;
      p.x = Math.random() * (W + 120);
    }
    if (p.x < -20) p.x += W + 140;
  }

  function resizePool(weather) {
    var want = targetCount(weather);
    if (particles.length > want) particles.length = want;
    while (particles.length < want) particles.push(seedParticle({}));
    curWeather = weather;
  }

  // Is the sky visible in the current view? (any discovered `outside` tile on screen). Absent
  // tile data (transport not up yet) -> treat as NOT visible so we don't rain over a blank
  // connecting screen.
  function skyVisible() {
    try {
      var T = root.DwfTiles;
      var latest = T && typeof T.getLatest === "function" && T.getLatest();
      var tiles = latest && latest.tiles;
      if (!tiles || !tiles.length) return false;
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        if (t && t.outside) return true;
      }
      return false;
    } catch (_) { return false; }
  }

  function currentWeather() {
    try {
      var T = root.DwfTiles;
      var latest = T && typeof T.getLatest === "function" && T.getLatest();
      var env = latest && latest.env;
      var w = env && typeof env.weather === "number" ? env.weather : 0;
      return (w === 1 || w === 2) ? w : 0;
    } catch (_) { return 0; }
  }

  function step(ts) {
    rafId = root.requestAnimationFrame(step);
    if (!ctx) return;
    var dt = lastT ? Math.min(0.05, (ts - lastT) / 1000) : 0.016;
    lastT = ts;

    var weather = currentWeather();
    // WTHR-1: `enabled` gates the DRAW only. `weather`/skyVisible() are still evaluated (and the
    // pool still tracks weather below) so the moment the setting flips back on the overlay resumes
    // the live storm with no reload -- only the pixels are suppressed while off.
    var draw = enabled && weather !== 0 && skyVisible();
    if (!draw) {
      // Nothing to show -- clear once and idle cheaply (pool kept for instant resume).
      if (particles.length) { ctx.clearRect(0, 0, vw(), vh()); }
      if (curWeather !== weather) resizePool(weather);
      return;
    }
    if (curWeather !== weather) resizePool(weather);

    var W = vw(), H = vh();
    ctx.clearRect(0, 0, W, H);
    if (weather === 2) {
      // SNOW: slow drifting dots with a horizontal sway.
      ctx.fillStyle = SNOW.color;
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.phase += dt * 1.4;
        p.y += SNOW.vy * dt;
        p.x += (SNOW.vx + Math.sin(p.phase) * SNOW.sway) * dt;
        if (p.y > H + 4) { p.y = -4; p.x = Math.random() * W; }
        if (p.x < -8) p.x += W + 16; else if (p.x > W + 8) p.x -= W + 16;
        ctx.beginPath();
        ctx.arc(p.x, p.y, SNOW.r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // RAIN: fast diagonal streaks.
      ctx.strokeStyle = RAIN.color;
      ctx.lineWidth = RAIN.w;
      ctx.beginPath();
      for (var j = 0; j < particles.length; j++) {
        var q = particles[j];
        advanceRainParticle(q, dt, W, H);
        var dx = RAIN.vx / RAIN.vy * RAIN.len;
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q.x - dx, q.y - RAIN.len);
      }
      ctx.stroke();
    }
  }

  function start() {
    if (running || DISABLED) return;
    if (!ensureCanvas()) return;
    running = true; lastT = 0;
    rafId = root.requestAnimationFrame(step);
  }
  function stop() {
    running = false;
    if (rafId) { root.cancelAnimationFrame(rafId); rafId = 0; }
    if (ctx) ctx.clearRect(0, 0, vw(), vh());
  }

  // WTHR-1: live-applied setter for the "Weather particles" preference. Flips the draw gate,
  // persists it, and on OFF clears the overlay immediately (no wait for the next frame) so the
  // storm visibly stops mid-fall. The rAF loop keeps running either way -- it just paints nothing
  // while off -- which is why re-enabling resumes the current weather instantly, without a reload.
  function setEnabled(on) {
    enabled = !!on;
    lsSet(LS_ENABLED, enabled ? "1" : "0");
    if (!enabled && ctx) ctx.clearRect(0, 0, vw(), vh());
  }
  function isEnabled() { return enabled; }

  root.DwfWeather = {
    init: start,
    stop: stop,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    // test/diagnostic hooks
    _targetCountForTest: targetCount,
    _seedParticleForTest: seedParticle,
    _advanceRainForTest: advanceRainParticle,
    previewModel: previewModel,
    _isDisabled: function () { return DISABLED; },
  };

  // Auto-start once the DOM is ready (unless disabled). getLatest() safely returns null until
  // the transport is up, so an early start just idles until env/tiles arrive.
  if (!DISABLED && typeof root.document !== "undefined") {
    if (root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
