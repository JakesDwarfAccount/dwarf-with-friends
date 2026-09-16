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

(function () {
  "use strict";

  const params = new URLSearchParams(location.search);

  // select() persists the resolved renderer only when this is not "url": a one-off ?renderer= param
  // must never become the stored default.
  let requestedSource = "default";
  let requestedName = null;   // the renderer select() actually asked impls for (pre-fallback)

  function readStoredRenderer() {
    return window.DwfUtil.lsGet("dwf.renderer");
  }

  // ---- creature motion mode: native snap is the DEFAULT, as DF never draws a sub-tile offset ------
  const SMOOTH_MOTION_LS_KEY = "dwf.smoothMotion";

  function initialSmoothMotion() {
    const q = params.get("nolerp");
    if (q === "1") return false;
    if (q === "0") return true;
    return window.DwfUtil.lsGet(SMOOTH_MOTION_LS_KEY) === "1";
  }

  let smoothMotion = initialSmoothMotion();

  function requestedRenderer() {
    const q = params.get("renderer");
    if (q === "gl" || q === "canvas2d") { requestedSource = "url"; return q; }
    const stored = readStoredRenderer();
    if (stored === "gl" || stored === "canvas2d") { requestedSource = "stored"; return stored; }
    requestedSource = "default";
    return "gl";
  }

  function dataKeyComponent(latest, fallbackSeq) {
    return (latest && typeof latest.contentVersion === "number")
      ? ("v" + latest.contentVersion)
      : ("s" + fallbackSeq);
  }

  function terrainKeyComponent(renderer, latest, fallbackSeq) {
    if (renderer && renderer.usesChunkPatching) {
      // contentVersion deliberately stays out of this key: terrain arrives through cacheReader.onDirty().
      // A cold snapshot can carry the same world_seq for every block, so the chunk fingerprint covers it.
      return (latest && typeof latest.coverageVersion === "number")
        ? "r2c" + latest.coverageVersion
        : "r2";
    }
    return dataKeyComponent(latest, fallbackSeq);
  }

  // Cold snapshots install asynchronously, so a dirty notification can race the first retained scene
  // and strand a placeholder on screen. Reconcile the retained scene a few times after completion.
  const COLD_RECONCILE_DELAYS_MS = [100, 500, 1500, 4000, 8000];
  function coldReconcileStage(nowMs, armedAt, completedStage) {
    if (!(armedAt > 0) || !(nowMs >= armedAt)) return completedStage;
    let dueStage = 0;
    const elapsed = nowMs - armedAt;
    for (let i = 0; i < COLD_RECONCILE_DELAYS_MS.length; i++) {
      if (elapsed >= COLD_RECONCILE_DELAYS_MS[i]) dueStage = i + 1;
    }
    return Math.max(completedStage, dueStage);
  }

  function createGLController() {
    let glCanvas = null, gl = null, atlas = null, renderer = null, rafId = 0;
    let started = false, disposed = false, lossCount = 0;
    let glVisible = false, mapsSettled = false, mapsSettledAt = 0;
    let maps = { spriteMap: null, tokenMap: null, shadowCellMap: null };
    let lastLatest = null, lastKey = "", dataSeq = 0;
    let lastItemDefTokens = null;  // last itemDefTokens map forwarded to GL (see maybeRebuild)
    let lastItemTypeNames = null; // last item_type numeric->string table forwarded to GL
    let coldReconcileArmedAt = 0, coldSocketOpens = -1;
    let coldReconcileStageDone = 0, coldReconcileBuildCount = 0;
    // benchpan: scripted pan/zoom by uniform-only scroll, frame deltas recorded into a ring for p95.
    let bench = { on: params.get("benchpan") === "1", phase: 0, frames: [], last: 0 };
    let onDemote = null;

    function makeCanvas() {
      const c = document.createElement("canvas");
      c.id = "dwf-gl";
      c.className = "dwf-gl-canvas";
      c.width = window.innerWidth; c.height = window.innerHeight;
      document.body.appendChild(c);
      return c;
    }

    // ---- COLD-LOAD reveal gate: GL occludes canvas2d only on maybeReveal()'s terms ----------------
    function setGLVisible(on) {
      if (glVisible === on) return;
      glVisible = on;
      if (glCanvas) glCanvas.classList.toggle("is-visible", on);
      try { window.__dfcGLVisible = on; } catch { /* the local glVisible gate remains authoritative */ }
      // canvas2d's paint gate reads __dfcGLVisible; force one full repaint when GL steps aside.
      if (!on) {
        try { if (window.DwfTiles && typeof DwfTiles.draw === "function") DwfTiles.draw(); }
        catch { /* canvas2d remains eligible for its next scheduled paint */ }
      }
    }

    let revealResolvedFraction = 0.80;   // tunable; pinned by coldload_boot_test.mjs
    let revealCeilingMs = 20000;         // hard ceiling from mapsSettled (see _revealTuningForTest)

    function maybeReveal() {
      if (glVisible || !mapsSettled || !renderer || !atlas) return;
      let sheetsLoaded, gs;
      try { sheetsLoaded = (atlas.getStats() || {}).sheetsLoaded || 0; } catch { return; }
      try { gs = renderer.getStats() || {}; } catch { return; }
      const instances = gs.instanceCount || 0;
      // A renderer that does not report the split falls back to the weaker meaning: fail-open, never fail-dark.
      const hasSplit = typeof gs.staticInstanceCount === "number";
      const staticInstances = hasSplit ? gs.staticInstanceCount : instances;
      const resolved = typeof gs.staticResolvedFraction === "number" ? gs.staticResolvedFraction : 1;
      // A tt<0 placeholder hatch is a resolved static instance too, so require source-backed terrain:
      // neither units nor a hatch-only frame may satisfy the reveal.
      const hasTerrainEvidence =
        typeof gs.terrainSourceTiles === "number" && gs.terrainSourceTiles > 0;

      // Ceiling: something is genuinely stuck, so show the map we have rather than sit on canvas2d.
      if (mapsSettledAt && Date.now() - mapsSettledAt >= revealCeilingMs && hasTerrainEvidence) {
        try { if (window.DwfBoot) window.DwfBoot.note("gl-reveal-ceiling",
          "GL revealed on the " + (revealCeilingMs / 1000) + "s ceiling at resolved=" + resolved.toFixed(2)); }
        catch { /* revealing the available map is the fallback */ }
        setGLVisible(true);
        return;
      }
      if (sheetsLoaded > 0 && hasTerrainEvidence && staticInstances > 0 && resolved >= revealResolvedFraction)
        setGLVisible(true);
    }

    function init() {
      if (!window.DwfGL) throw new Error("gl: dwf-gl.js not loaded");
      if (!window.DwfGLAtlas) throw new Error("gl: dwf-gl-atlas.js not loaded");
      if (!document.body) throw new Error("gl: no document body yet");
      glCanvas = makeCanvas();
      gl = glCanvas.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
      if (!gl) { cleanupCanvas(); throw new Error("gl: WebGL2 context creation failed"); }
      glCanvas.addEventListener("webglcontextlost", onContextLost, false);
      glCanvas.addEventListener("webglcontextrestored", onContextRestored, false);
      atlas = window.DwfGLAtlas.createForGL(gl);
      atlas.onAtlasFull(() => demote("atlas allocation failure"));
      // any newly-packed sheet invalidates the last scene so it rebuilds with real cells
      atlas.onSheetReady(() => {
        if (renderer && renderer.invalidateScene) renderer.invalidateScene();
        lastKey = "";
      });
      renderer = window.DwfGL.create(gl, {
        atlas,
        adjacency: window.DwfAdjacency || null,
        cacheReader: window.DwfCache || null,
        // Default false is native snap-to-tile; runtime-switchable via setSmoothMotion(), with no reload.
        smoothMotion: smoothMotion,
        freezeAnim: params.get("freezeAnim") === "1",
        // ?nofog=1 forces the measured see-down fog off in BOTH renderers, for window-capture parity A/B.
        nofog: params.get("nofog") === "1",
        // Permits getStats(true) to read the uploaded static VBO back; absent unless ?colddiag is present.
        diagnosticReadback: params.has("colddiag"),
      });
      loadMaps();
      start();
      return renderer;
    }

    function cleanupCanvas() {
      if (glCanvas && glCanvas.parentNode) glCanvas.parentNode.removeChild(glCanvas);
      glCanvas = null;
    }

    async function loadMaps() {
      async function j(url) {
        try {
          if (window.DwfJson && typeof window.DwfJson.get === "function") return await window.DwfJson.get(url);
          const r = await fetch(url, { cache: "no-cache" });
          return r.ok ? await r.json() : null;
        } catch { return null; }
      }
      const [sm, tm, scm, ttm, im, pm, trm, spm, mm, bm, cm, gcm] = await Promise.all([
        j("/sprites/map.json"), j("/tiletype_token_map.json"), j("/shadow_cell_map.json"),
        j("/tiletype_meta.json"),
        j("/item_map.json"), j("/plant_map.json"), j("/tree_map.json"), j("/spatter_map.json"),
        // the SAME committed material_map.json dwf-tiles.js loads: inorganic identity + palette-swap rows
        j("/material_map.json?v=c3b8ef13"),
        j("/building_map.json"),
        j("/creatures_map.json"),
        j("/grass_colors.json"),
      ]);
      const tiletypeMeta = new Map();
      if (ttm && Array.isArray(ttm.tiletypes)) {
        for (const r of ttm.tiletypes) {
          if (Array.isArray(r) && r.length >= 5) {
            tiletypeMeta.set(r[0], { ttname: r[1], shape: r[2], mat: r[3], special: r[4] });
          }
        }
      }
      maps = {
        spriteMap: sm, tokenMap: tm, shadowCellMap: scm,
        itemMap: im, plantMap: pm, treeMap: trm, spatterMap: spm, materialMap: mm,
        buildingMap: bm, creaturesMap: cm, grassColors: gcm,
      };
      if (renderer) renderer.setMaps(Object.assign({}, maps, { tiletypeMeta: tiletypeMeta.size ? tiletypeMeta : null }));
      lastKey = ""; // force rebuild with maps present
      // "Settled" means the boot attempt finished, not that every fetch succeeded: gating the reveal
      // on a fully successful load would leave the client on canvas2d forever when one sheet 404s.
      try { window.__dfcMapsSettled = true; } catch { /* the local mapsSettled gate below remains authoritative */ }
      mapsSettled = true;  // reveal gate condition 1
      mapsSettledAt = Date.now();  // start of the reveal ceiling
    }

    function onContextLost(e) {
      e.preventDefault();
      lossCount++;
      // A lost context draws nothing: hide the GL canvas so canvas2d resumes full painting at once.
      setGLVisible(false);
      if (renderer) renderer.handleLost();
      // Context loss TWICE in a session -> permanent canvas2d fallback.
      if (lossCount >= 2) { demote("webgl context lost twice"); return; }
    }
    function onContextRestored() {
      if (disposed || !renderer) return;
      try { renderer.handleRestored(); lastKey = ""; }
      catch (err) { demote("context restore failed: " + (err && err.message)); }
    }

    // The backing scale is ONE contract, owned by dwf-tiles.js (DwfTiles.backingScale / cellPxFor).
    // Never give this file its own copy: a second derivation leaves the canvas upscaled by the compositor.
    function backingScale() {
      try {
        const T = window.DwfTiles;
        if (T && typeof T.backingScale === "function") return T.backingScale();
      } catch { /* the shared renderer scale falls back to 1 */ }
      return 1;
    }
    function syncSize() {
      const s = backingScale();
      const w = Math.max(1, Math.round(window.innerWidth * s));
      const h = Math.max(1, Math.round(window.innerHeight * s));
      if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
    }

    // Rebuild the instance buffer ONLY when the window content, origin or zoom changed.
    function maybeRebuild() {
      const T = window.DwfTiles;
      if (!T || typeof T.getLatest !== "function") return null;
      // The (type,subtype)->ITEMDEF token map is wire-driven and lands in dwf-tiles.js AFTER loadMaps(),
      // so forward it by reference once it changes or GL's item resolver loses its itemdef->bytoken step.
      if (renderer && typeof T.getItemDefTokens === "function") {
        const idt = T.getItemDefTokens();
        if (idt && idt !== lastItemDefTokens) {
          lastItemDefTokens = idt;
          renderer.setMaps({ itemDefTokens: idt });
          lastKey = "";
        }
      }
      if (renderer && typeof T.getItemTypeNames === "function") {
        const itn = T.getItemTypeNames();
        if (itn && itn !== lastItemTypeNames) {
          lastItemTypeNames = itn;
          renderer.setMaps({ itemTypeNames: itn });
          lastKey = "";
        }
      }
      const latest = T.getLatest();
      if (!latest || !latest.tiles || !(latest.width > 0) || !(latest.height > 0)) return null;

      let socketOpens = -1;
      try {
        if (window.DwfWS && typeof window.DwfWS.getStats === "function") {
          const wsStats = window.DwfWS.getStats();
          if (typeof wsStats.socketOpens === "number") socketOpens = wsStats.socketOpens;
        }
      } catch { /* socketOpens stays unknown and cold reconciliation continues */ }
      const nowMs = Date.now();
      if (!coldReconcileArmedAt || (socketOpens >= 0 && coldSocketOpens >= 0 &&
          socketOpens !== coldSocketOpens)) {
        coldReconcileArmedAt = nowMs;
        coldReconcileStageDone = 0;
      }
      if (socketOpens >= 0) coldSocketOpens = socketOpens;
      const dueStage = coldReconcileStage(nowMs, coldReconcileArmedAt, coldReconcileStageDone);
      if (dueStage > coldReconcileStageDone) {
        coldReconcileStageDone = dueStage;
        coldReconcileBuildCount++;
        if (renderer && renderer.invalidateScene) renderer.invalidateScene();
        lastKey = "";
      }

      const w = glCanvas.width, h = glCanvas.height;
      const renderView = latest;
      const cell = (typeof T.cellPxFor === "function")
        ? T.cellPxFor(w, h, latest.width, latest.height)
        : Math.max(1, Math.floor(Math.min(w / latest.width, h / latest.height)));
      const o = renderView.origin || { x: 0, y: 0, z: 0 };
      if (latest !== lastLatest) { lastLatest = latest; dataSeq++; }
      const dataPart = terrainKeyComponent(renderer, latest, dataSeq);
      const key = dataPart + "|" + o.x + "," + o.y + "," + o.z +
        "|" + renderView.width + "x" + renderView.height + "|" + cell.toFixed(3) +
        "|" + (maps.spriteMap ? 1 : 0);
      renderer.setCamera({ cell, canvasW: w, canvasH: h });
      if (key !== lastKey) {
        renderer.buildScene(renderView);
        lastKey = key;
      }
      return { cell, latest };
    }

    function frame(ts) {
      if (disposed) return;
      rafId = requestAnimationFrame(frame);
      try {
        syncSize();
        const mb = maybeRebuild();
        if (mb && mb.latest) {
          const latest = mb.latest;
          // Buildings and presence have independent GL segments, so folding them keeps the terrain prefix.
          if (renderer.updateSceneSegments) renderer.updateSceneSegments(latest);
          renderer.updateUnits(latest.units, Date.now());
          // Feed the projectile snapshot BEFORE tickUnits: both append into the same dynamic tail.
          if (renderer.updateProjectiles) renderer.updateProjectiles(latest.proj);
          // Flow clouds ride the same tail; updateFlows is keyed on contentVersion, so it usually no-ops.
          if (renderer.updateFlows) renderer.updateFlows(latest);
          const o = latest.origin || { x: 0, y: 0, z: 0 };
          renderer.tickUnits(ts, o.x, o.y, o.z);
        }
        // benchpan: animate uniform-only scroll, to prove pan/zoom needs no scene rebuild.
        if (bench.on) {
          bench.phase += 0.08;
          renderer.setScroll(Math.sin(bench.phase) * 4, Math.cos(bench.phase * 0.7) * 4);
        }
        renderer.render(ts);
        // Checked AFTER render(), so instanceCount reflects the frame that was just drawn.
        maybeReveal();
        if (bench.on) {
          if (bench.last) bench.frames.push(ts - bench.last);
          bench.last = ts;
          if (bench.frames.length > 240) bench.frames.shift();
        }
      } catch { /* the next animation frame retries from retained renderer state */ }
    }

    function start() {
      if (started) return;
      started = true;
      rafId = requestAnimationFrame(frame);
    }

    function demote(reason) {
      if (disposed) return;
      disposed = true;
      setGLVisible(false);   // clears __dfcGLVisible so canvas2d's F1 gate reopens at once
      if (rafId) cancelAnimationFrame(rafId);
      try { if (renderer) renderer.dispose(); }
      catch { /* canvas cleanup and renderer demotion still continue */ }
      cleanupCanvas();
      if (typeof onDemote === "function") onDemote(reason);
    }

    function getStats() {
      // The retained/cache comparison runs only through this diagnostic seam: decoding every retained
      // tile in maybeReveal()'s per-frame getStats() would perturb the cold load being observed.
      const s = renderer ? renderer.getStats(true) : { renderer: "gl" };
      s.coldReconcileBuildCount = coldReconcileBuildCount;
      s.coldReconcileStage = coldReconcileStageDone;
      s.coldReconcileStageCount = COLD_RECONCILE_DELAYS_MS.length;
      if (bench.on && bench.frames.length > 4) {
        const sorted = bench.frames.slice().sort((a, b) => a - b);
        s.benchP50 = +sorted[Math.floor(sorted.length * 0.5)].toFixed(2);
        s.benchP95 = +sorted[Math.floor(sorted.length * 0.95)].toFixed(2);
        s.benchFrames = sorted.length;
      }
      return s;
    }

    return {
      init,
      setRenderParams: (p) => { if (renderer) renderer.setRenderParams(p); },
      setSmoothMotion: (on) => { if (renderer) renderer.setSmoothMotion(on); },
      getStats,
      onDemote: (cb) => { onDemote = cb; },
      _forceLoseContext: () => {
        // test hook: drive WEBGL_lose_context so acceptance can script two losses.
        if (!gl) return false;
        const ext = gl.getExtension("WEBGL_lose_context");
        if (ext) { ext.loseContext(); return true; }
        return false;
      },
      _renderer: () => renderer,
      _atlas: () => atlas,
      _gl: () => gl,
      // Whether the GL canvas is composited yet; harnesses wait on this before screenshotting a GL frame.
      _glVisible: () => glVisible,
      // Lets the offline fixture drive the reveal thresholds instead of sleeping out the real ceiling.
      _revealTuningForTest: (fraction, ceilingMs) => {
        if (typeof fraction === "number") revealResolvedFraction = fraction;
        if (typeof ceilingMs === "number") revealCeilingMs = ceilingMs;
        return { fraction: revealResolvedFraction, ceilingMs: revealCeilingMs };
      },
    };
  }

  let glController = null;

  // ---- registered implementations -------------------------------------------------
  const impls = {
    canvas2d: {
      name: "canvas2d",
      // Pure pass-through: dwf-tiles.js self-boots or is booted by dwf-core.js, so this must not re-init.
      init() {
        if (!window.DwfTiles) throw new Error("canvas2d: DwfTiles not loaded");
        return window.DwfTiles;
      },
    },
    gl: {
      name: "gl",
      init() {
        glController = createGLController();
        glController.onDemote((reason) => {
          warnFallback("gl", new Error(reason));
          activeName = "canvas2d";
          // canvas2d's paint was gated off while GL was active, so force one full repaint on the reveal.
          try { if (window.DwfTiles && typeof DwfTiles.draw === "function") DwfTiles.draw(); }
          catch { /* canvas2d remains eligible for its next scheduled paint */ }
        });
        return glController.init();
      },
    },
  };

  let activeName = "canvas2d";
  let fallbackWarned = false;

  function warnFallback(name, err) {
    if (fallbackWarned) return;              // one console warning per session, never spam
    fallbackWarned = true;
    const msg = (err && err.message) ? err.message : String(err);
    console.warn(
      '[DwfRender] renderer "' + name + '" failed to init (' + msg + '); ' +
      "falling back to canvas2d."
    );
  }

  function select() {
    const wanted = requestedRenderer();
    requestedName = wanted;
    const impl = impls[wanted] || impls.canvas2d;
    try {
      impl.init();
      activeName = impl.name;
    } catch (err) {
      warnFallback(wanted, err);
      try {
        impls.canvas2d.init();
        activeName = "canvas2d";
      } catch (err2) {
        // DwfTiles absent (script missing, or a load-order bug): warn once, but never throw out of this IIFE.
        warnFallback("canvas2d", err2);
        activeName = "canvas2d";
      }
    }
    if (requestedSource !== "url") {
      window.DwfUtil.lsSet("dwf.renderer", wanted);
    }
  }

  select();

  // F3/gate-facing counters; the seam's `renderer` field wins, so callers see what THIS layer resolved to.
  function getStats() {
    let implStats = null;
    try {
      if (window.DwfTiles && typeof DwfTiles.getStats === "function") {
        implStats = DwfTiles.getStats();
      }
    } catch { /* the coordinator still returns its renderer identity */ }
    let glStats = null;
    if (activeName === "gl" && glController) {
      try { glStats = glController.getStats(); }
      catch { /* the coordinator still returns its renderer identity */ }
    }
    return Object.assign({}, implStats, glStats, { renderer: activeName });
  }

  function provenance() {
    return {
      active: activeName,
      requested: requestedName,
      source: requestedSource,                      // "url" | "stored" | "default"
      demoted: !!(requestedName && activeName !== requestedName),
    };
  }

  const api = {
    get active() { return activeName; },
    getStats,
    provenance,
    // Runtime RenderParams: forwards to the GL renderer with ZERO scene rebuild; a no-op on canvas2d.
    setRenderParams(p) { if (glController) glController.setRenderParams(p); },
    get smoothMotion() { return smoothMotion; },
    setSmoothMotion(on) {
      smoothMotion = !!on;
      window.DwfUtil.lsSet(SMOOTH_MOTION_LS_KEY, smoothMotion ? "1" : "0");
      if (glController) glController.setSmoothMotion(smoothMotion);
    },
    _impls: impls,   // debug/test hook only -- not part of the public contract
    _glController: () => glController,   // test hook: context-loss / stats introspection
    _dataKeyComponentForTest: dataKeyComponent,   // F3 both-directions regression test hook
    _terrainKeyComponentForTest: terrainKeyComponent,  // onDirty is the sole terrain trigger
    _coldReconcileStageForTest: coldReconcileStage,
    _coldReconcileDelaysForTest: COLD_RECONCILE_DELAYS_MS.slice(),
  };
  try { window.DwfRender = api; } catch { /* a headless harness does not consume the browser export */ }
})();
