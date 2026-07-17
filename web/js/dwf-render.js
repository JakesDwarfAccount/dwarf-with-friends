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

// dwf-render.js -- RENDERER SEAM (WB-1, docs/superpowers/specs/
// 2026-07-07-WB-renderer-spec.md §1.1). Establishes window.DwfRender: the registry +
// selection layer choosing between "canvas2d" (dwf-tiles.js, wrapped with ZERO behavior
// change of its own) and "gl" (the real WebGL2 instanced pipeline, dwf-gl.js, WB-8/9..15).
//
// canvas2d's init() here is a pure pass-through to the already-live window.DwfTiles
// (self-booted standalone, or booted by dwf-core.js's init() call), never a re-boot --
// canvas2d keeps drawing underneath the GL canvas always, so any GL failure/demotion is a
// display toggle back to an already-rendering map, never a black screen.
//
// WB-14 (this item) flips the default: selection precedence is ?renderer=gl|canvas2d URL param
// -> localStorage['dwf.renderer'] -> default 'gl' (was 'canvas2d' through WB-1..13 --
// see requestedRenderer()'s own banner for the flip's gate evidence). Auto-fallback triggers on
// any init() throw (webgl2 unavailable), OR later via onDemote (context loss twice / atlas
// full, §1.1) -- both paths always land on canvas2d, which never itself fails to init.

(function () {
  "use strict";

  const params = new URLSearchParams(location.search);

  // F5 (perf audit §2/F5): where the resolved renderer choice came from, so select() can
  // decide whether to PERSIST it (never from a one-off ?renderer= URL param) and the F3
  // overlay can attribute the active renderer. "url" | "stored" | "default".
  let requestedSource = "default";
  let requestedName = null;   // the renderer select() actually asked impls for (pre-fallback)

  function readStoredRenderer() {
    try { return localStorage.getItem("dwf.renderer"); } catch (_) { return null; }
  }

  function requestedRenderer() {
    const q = params.get("renderer");
    if (q === "gl" || q === "canvas2d") { requestedSource = "url"; return q; }
    const stored = readStoredRenderer();
    if (stored === "gl" || stored === "canvas2d") { requestedSource = "stored"; return stored; }
    requestedSource = "default";
    // WB-14 default-flip (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md, "Overlays,
    // final 2D split, and the default-flip decision"): every prior WB item's gate stayed
    // green (WB-8..13 dense terrain/liquids/hidden/walls/shadows/buildings/units, this item's
    // own designation+presence overlay port) and the WB-14 acceptance sweep (S1/U1/U2 raw-
    // oracle parity + gate_perf.py, both re-run before AND after this flip) was green in the
    // same session -- see the flip commit message for the evidence. `?renderer=canvas2d` /
    // `localStorage['dwf.renderer']='canvas2d'` still opt back in at any time, and the
    // auto-fallback (webgl2 unavailable / context loss twice / atlas full, §1.1) still demotes
    // to canvas2d automatically -- this is the wave's designed safety property (Rollback: one
    // revert of this line restores the pre-flip default).
    return "gl";
  }

  // =========================================================================================
  // WB-9 GL controller. The gl impl's init() creates a WebGL2 canvas STACKED OVER the map
  // canvas (pointer-events:none, so input still lands on canvas2d, whose geometry the gates +
  // smooth-cursor overlay read), builds WB-8's atlas + WB-9's instanced pipeline
  // (dwf-gl.js), fetches the sprite/token/shadow maps, and runs a rAF loop that
  // scene-builds from dwf-tiles.js's decoded window (getLatest) ONLY when it changes
  // (spec §1.7 -- never per frame), redrawing terrain every frame. Because canvas2d keeps
  // drawing underneath, GL context loss (twice, spec §1.1) / atlas-full / init failure simply
  // hides the GL canvas -> the live canvas2d map shows through instantly: the auto-fallback is
  // a display toggle, never a black screen. WB-14 made "gl" the default (requestedRenderer()'s
  // own banner has the gate evidence); `?renderer=canvas2d` / `localStorage['dwf.
  // renderer']='canvas2d'` still select this whole path off entirely.
  // =========================================================================================
  // F3 (perf audit §2/F3): the DATA component of the GL rebuild key. Prefers the cache's real
  // window CONTENT VERSION (latest.contentVersion) so the scene rebuilds only when a window-
  // intersecting terrain block ACTUALLY changed -- invariant to the ~30/s fresh-`latest` churn
  // that unit/AUX updates cause. Falls back to the identity seq for the poll/legacy path that
  // carries no version (still updates there, just per-frame -- rare, 2/s). Pure + exported as a
  // test hook (_dataKeyComponentForTest) so the both-directions regression test can assert:
  // unit-only churn (same contentVersion, new object) => same key => NO rebuild; a designation
  // (bumped contentVersion) => different key => rebuild (B29 stays covered).
  function dataKeyComponent(latest, fallbackSeq) {
    return (latest && typeof latest.contentVersion === "number")
      ? ("v" + latest.contentVersion)
      : ("s" + fallbackSeq);
  }

  function terrainKeyComponent(renderer, latest, fallbackSeq) {
    return renderer && renderer.usesChunkPatching ? "r2" : dataKeyComponent(latest, fallbackSeq);
  }

  function createGLController() {
    let glCanvas = null, gl = null, atlas = null, renderer = null, rafId = 0;
    let started = false, disposed = false, lossCount = 0;
    let maps = { spriteMap: null, tokenMap: null, shadowCellMap: null };
    let lastLatest = null, lastKey = "", dataSeq = 0;
    let lastItemDefTokens = null; // T1d: last itemDefTokens map forwarded to GL (see maybeRebuild)
    let lastItemTypeNames = null; // B256: last item_type numeric->string table forwarded to GL
    // benchpan (spec §1.7 / WB-16 hook): scripted pan/zoom via uniform-only scroll (no rebuild)
    // to prove pure pan/zoom is a uniform update. Frame deltas recorded into a ring for p95.
    let bench = { on: params.get("benchpan") === "1", phase: 0, frames: [], last: 0 };
    let onDemote = null;

    function makeCanvas() {
      const c = document.createElement("canvas");
      c.id = "dwf-gl";
      c.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;" +
        "pointer-events:none;z-index:1;";
      c.width = window.innerWidth; c.height = window.innerHeight;
      document.body.appendChild(c);
      return c;
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
        // WB-10: the SAME public read API (getChunk/chunkKeyFor) the WA-7 canvas2d bridge
        // already uses -- read-only, no coupling to dwf-cache.js internals. Absent
        // (older page, script load-order issue) simply disables the multi-z descent, same as
        // any other optional map (spec: "must land green in transitional mode alone").
        cacheReader: window.DwfCache || null,
        // WB-13 Rollback note: `?nolerp=1` is a pure view-side kill-switch for the unit
        // interpolation lerp (snap-to-latest instead of gliding), revert-safe by construction.
        nolerp: params.get("nolerp") === "1",
        // WB-15: `?freezeAnim=1` pins the GL animation clock at t=0 -- REQUIRED by every
        // parity gate from here on (spec: two captures of the "same" scene must be pixel-
        // identical, which a moving clock would break). Revert-safe view-side flag, same
        // convention as nolerp above.
        freezeAnim: params.get("freezeAnim") === "1",
        // QA-only kill switch (window-capture parity scoring, M1 closure): `?nofog=1` forces
        // the measured see-down fog off (dwf-gl.js's create() zeroes the UBO fields +
        // its FOG_DISABLED flag) so gate_parity.py --oracle window can A/B whether the fog
        // IMPROVES or WORSENS parity against the real composited window. canvas2d reads the
        // same URL param directly (dwf-tiles.js's own FOG_DISABLED), so this one flag
        // covers both renderers regardless of which is active for a given gate run.
        nofog: params.get("nofog") === "1",
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
        try { const r = await fetch(url, { cache: "no-store" }); return r.ok ? await r.json() : null; }
        catch (_) { return null; }
      }
      const [sm, tm, scm, ttm, im, pm, trm, spm, mm, bm, cm, gcm] = await Promise.all([
        j("/sprites/map.json"), j("/tiletype_token_map.json"), j("/shadow_cell_map.json"),
        // WB-10: the SAME session meta table the WA-7 canvas2d bridge resolves tt->ttname/
        // shape/mat from (WA-5, §0.7) -- dwf-gl.js keeps its OWN copy rather than
        // reaching into dwf-cache.js's private table (no cross-file coupling, same
        // convention as its already-duplicated colour tables). Needed only for the multi-z
        // descent; absent/failed fetch just means descent stays off (tiletypeMeta null).
        j("/tiletype_meta.json"),
        // WB-11: the SAME committed sparse-layer maps dwf-tiles.js's boot sequence
        // already fetches for the canvas2d path -- dwf-gl.js keeps its own copy (no
        // cross-file coupling; a failed/absent fetch just disables that one sparse layer,
        // same "layer falls back, never throws" convention as every other optional map here).
        j("/item_map.json"), j("/plant_map.json"), j("/tree_map.json"), j("/spatter_map.json"),
        // T1a/T1c/T1d: the SAME committed web/material_map.json dwf-tiles.js loads --
        // gives GL items their exact inorganic identity + palette-swap rows (absent => pre-T1).
        j("/material_map.json?v=w9"),
        // WB-12: the SAME committed web/building_map.json dwf-tiles.js already loads for
        // the canvas2d building pass -- a failed/absent fetch just means every building falls
        // back to MISSING_BUILDING (same convention as every other optional map here).
        j("/building_map.json"),
        // WB-13: the SAME committed web/creatures_map.json dwf-tiles.js already loads for
        // the canvas2d unit tier-3 flat-race-cell resolution -- a failed/absent fetch just means
        // every unit falls back to the fallback dot (same convention as every map here).
        j("/creatures_map.json"),
        // WC-17 GL parity: the SAME committed web/grass_colors.json dwf-tiles.js already
        // loads (loadGrassColors there) for its per-species grass tint -- a failed/absent fetch
        // just means grassSpeciesTintRGBA() falls back to the flat grassSummer wash (same
        // convention as every other optional map here).
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
      // T1 sweep determinism: signal that the GL map set (incl. material_map) has been handed
      // to the renderer -- tools/spriterange/range_diff.py waits on this before screenshotting
      // so gl-vs-c2d parity never compares a maps-loaded frame against a maps-racing one (the
      // 213412Z partial caught c2d swapped vs GL plain in the first windows). Set even when
      // individual fetches failed: "settled" means the boot attempt finished, not "all present".
      try { window.__dfcMapsSettled = true; } catch (_) { /* non-browser context */ }
    }

    function onContextLost(e) {
      e.preventDefault();
      lossCount++;
      if (renderer) renderer.handleLost();
      // spec §1.1: context loss TWICE in a session -> permanent canvas2d fallback.
      if (lossCount >= 2) { demote("webgl context lost twice"); return; }
    }
    function onContextRestored() {
      if (disposed || !renderer) return;
      try { renderer.handleRestored(); lastKey = ""; }
      catch (err) { demote("context restore failed: " + (err && err.message)); }
    }

    // Resize the GL canvas to the window (matching dwf-tiles.js's full-window backing).
    // WT20 (mobile): same coarse-pointer dpr scale (capped 2, same kill switch) as tiles.js's
    // resizeCanvas, so the VISIBLE GL map is native-density on phones too. The two scales are
    // computed independently but even a mismatch stays render-correct: each canvas maps its own
    // backing to the same 100vw/100vh CSS box, and GL's cell = glCanvas.width/window-tiles is
    // self-consistent per canvas. Desktop (fine pointer): scale 1, byte-identical behavior.
    function mobileBackingScale() {
      try {
        if (typeof window.matchMedia !== "function" ||
            !window.matchMedia("(pointer: coarse)").matches) return 1;
        if (localStorage.getItem("dwf.mobiledpr") === "0") return 1;
        return Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      } catch (_) { return 1; }
    }
    function syncSize() {
      const s = mobileBackingScale();
      const w = Math.max(1, Math.round(window.innerWidth * s));
      const h = Math.max(1, Math.round(window.innerHeight * s));
      if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
    }

    // Pull the decoded window + geometry from canvas2d (single source of truth) and rebuild
    // the instance buffer ONLY when the window content/origin/zoom changed (spec §1.7).
    function maybeRebuild() {
      const T = window.DwfTiles;
      if (!T || typeof T.getLatest !== "function") return null;
      // T1d: the (type,subtype)->ITEMDEF token map is wire-driven and lands in dwf-tiles.js
      // AFTER loadMaps() (once the v1 ITEMDEF_DICT message arrives). Forward it (by reference,
      // once it changes) so GL's item resolver gains the itemdef->bytoken step -- the root fix
      // for the minecart/tool/toy/weapon PARITY-MISMATCH class.
      if (renderer && typeof T.getItemDefTokens === "function") {
        const idt = T.getItemDefTokens();
        if (idt && idt !== lastItemDefTokens) {
          lastItemDefTokens = idt;
          renderer.setMaps({ itemDefTokens: idt });
          lastKey = "";
        }
      }
      // B256: same forwarding for the numeric item_type -> "TYPE" table (fetched by tiles.js from
      // /item_type_meta.json). Without it GL cannot turn the AUX projectile wire's numeric
      // item_type into item art and falls back to the white-dot marker.
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
      const w = glCanvas.width, h = glCanvas.height;
      const renderView = latest;
      const cell = Math.max(1, Math.min(w / latest.width, h / latest.height));
      const o = renderView.origin || { x: 0, y: 0, z: 0 };
      // change key: a monotonic data-change seq + window origin + dims + zoom.
      //
      // B29 ROOT-CAUSE NOTE (designations/tile changes invisible until pan/zoom/z-change):
      // this used to be a `(latest === lastLatest ? "s" : "d")` identity TOGGLE, with
      // `lastLatest` assigned only inside the rebuild branch below. That was written when
      // getLatest() returned a fresh object only per applyKeyframe/applyDelta ("identity
      // change == data change"); the WA-7/13/15 cache-fed path broke the assumption --
      // refreshFromCacheIfNeeded() rebuilds `latest` on EVERY canvas2d draw (AUX-driven,
      // ~30-40/s live). Once a rebuild landed on a changed-object frame, `lastLatest` froze
      // on a dead object, every later frame computed the same "d|..." key, and NO data
      // change could ever trigger a rebuild again -- only pan/z (origin), zoom (cell),
      // resize (dims), or a lazy sheet-ready lastKey="" reset did. Live-measured on the
      // wedged state: latest identity churning at 39.8/s, sceneBuildCount frozen for 10+s
      // while a freshly-designated tile sat undrawn (2026-07-08 desiglag ledger entry).
      // F3 (perf audit §2/F3, post-B29 over-correction): the B29 fix folded a monotonic seq
      // bumped on EVERY `latest` identity change into the key -- but refreshFromCacheIfNeeded()
      // mints a fresh `latest` on every canvas2d draw (~30/s, unit/AUX-driven), so on a busy fort
      // buildScene (a full walk of all ~23k visible tiles, up to 26 instances each) ran ~30x/s
      // even when only UNITS moved (units have their own per-rAF tickUnits path -- see below --
      // and never need a terrain rebuild). FIX: key the data component on the cache's real window
      // CONTENT VERSION (latest.contentVersion = max block world_seq over the window, stamped by
      // dwf-tiles.js) so buildScene runs ONLY when a window-intersecting terrain block
      // actually changed (a dig/designation/build/liquid/see-down move) or origin/zoom/dims
      // changed. This keeps B29 covered (a real designation DOES bump contentVersion -> rebuild;
      // that bug was the OPPOSITE failure, "never rebuilds") while killing the unit-churn rebuilds.
      // The identity seq is kept as the fallback for the poll/legacy path that carries no version.
      if (latest !== lastLatest) { lastLatest = latest; dataSeq++; }
      // R2: cache-backed GL terrain delivery is exclusively BLOCK_SET/onDirty-driven. Keeping
      // contentVersion in this key would silently retain the old full-build fallback and let a
      // suppressed/missed dirty fixture pass coincidentally. Legacy/no-cache renderers retain
      // the F3 data key; R2 uses a stable marker and patches before this frame runs.
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
        // WB-13: units interpolate on the rAF clock, INDEPENDENT of maybeRebuild's data-change
        // key (units churn every ~30Hz AUX push, which alone never flips that key -- see
        // dwf-gl.js's file banner). updateUnits() is identity-deduped internally (a no-op
        // most of these 60fps calls); tickUnits() always re-emits the interpolated tail so a
        // unit glides smoothly between two AUX snapshots instead of teleporting once per push.
        if (mb && mb.latest) {
          const latest = mb.latest;
          // H1: buildings/presence have independent GL segments. Their cheap section folds
          // update those segments without invalidating the terrain prefix.
          if (renderer.updateSceneSegments) renderer.updateSceneSegments(latest);
          renderer.updateUnits(latest.units, Date.now());
          // WC-22: feed the latest projectile snapshot BEFORE tickUnits (tickUnits appends the
          // projectile instances into the same dynamic tail it re-emits the units into).
          if (renderer.updateProjectiles) renderer.updateProjectiles(latest.proj);
          // B139: flow clouds (t.cloud, per-tile) ride the same tail; updateFlows is keyed
          // on contentVersion internally so this 60fps call is a cheap no-op most frames.
          if (renderer.updateFlows) renderer.updateFlows(latest);
          const o = latest.origin || { x: 0, y: 0, z: 0 };
          renderer.tickUnits(ts, o.x, o.y, o.z);
        }
        // benchpan: animate uniform-only scroll (+ a zoom wobble via cell) to prove pan/zoom
        // is a uniform update with NO scene rebuild between data changes.
        if (bench.on) {
          bench.phase += 0.08;
          renderer.setScroll(Math.sin(bench.phase) * 4, Math.cos(bench.phase * 0.7) * 4);
        }
        // WB-15: pass the rAF timestamp straight through so the GL renderer's animation clock
        // (u_timeMs) advances off the SAME clock this loop is already driven by -- no separate
        // Date.now()/performance.now() call needed here.
        renderer.render(ts);
        if (bench.on) {
          if (bench.last) bench.frames.push(ts - bench.last);
          bench.last = ts;
          if (bench.frames.length > 240) bench.frames.shift();
        }
      } catch (_) { /* a bad frame never kills the loop */ }
    }

    function start() {
      if (started) return;
      started = true;
      rafId = requestAnimationFrame(frame);
    }

    function demote(reason) {
      if (disposed) return;
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      try { if (renderer) renderer.dispose(); } catch (_) {}
      cleanupCanvas();
      if (typeof onDemote === "function") onDemote(reason);
    }

    function getStats() {
      const s = renderer ? renderer.getStats() : { renderer: "gl" };
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
      // WB-14 debug/test hooks (same convention as _renderer/_forceLoseContext above): the
      // live atlas instance + its GL context, so an acceptance script can readPixels the
      // ACTUAL packed cell content (framebufferTextureLayer on atlas.getTexture()) instead
      // of trusting the allocator's bookkeeping.
      _atlas: () => atlas,
      _gl: () => gl,
    };
  }

  let glController = null;

  // ---- registered implementations -------------------------------------------------
  const impls = {
    canvas2d: {
      name: "canvas2d",
      // Pure pass-through: dwf-tiles.js is either already self-booted (standalone) or
      // will be booted by dwf-core.js's own DwfTiles.init() call later in the
      // embedded page's load sequence -- either way THIS call must not re-init anything,
      // just confirm the implementation exists.
      init() {
        if (!window.DwfTiles) throw new Error("canvas2d: DwfTiles not loaded");
        return window.DwfTiles;
      },
    },
    // WB-9: the real instanced WebGL2 pipeline (web/js/dwf-gl.js), managed by the GL
    // controller above. init() fails fast (throws) on WebGL2 unavailability so the seam falls
    // back to canvas2d exactly as the WB-1 stub did; a LATER failure (context loss twice /
    // atlas full) demotes to canvas2d via onDemote without a black screen.
    gl: {
      name: "gl",
      init() {
        glController = createGLController();
        glController.onDemote((reason) => {
          warnFallback("gl", new Error(reason));
          activeName = "canvas2d";
          // The GL canvas was just removed; canvas2d is now the live display. Under F1 its
          // paint was gated off while GL was active (kept only keep-warm), so force one
          // immediate full repaint so the reveal shows a CURRENT frame, not a ~0.5s-stale one.
          try { if (window.DwfTiles && typeof DwfTiles.draw === "function") DwfTiles.draw(); } catch (_) { /* never throw out of demote */ }
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
        // DwfTiles itself isn't present (script missing/load-order bug) -- surface it
        // the same way (one warning), but never throw out of this IIFE.
        warnFallback("canvas2d", err2);
        activeName = "canvas2d";
      }
    }
    // F5 LANDMINE FIX (perf audit §2/F5 -- "potentially the whole bug, one line"): NEVER
    // persist a renderer that came from the ?renderer= URL param. A one-off QA/A-B visit to
    // `?renderer=canvas2d` (the WB-16 discrimination gate + various A/B instructions tell people
    // to load exactly that) used to write canvas2d to localStorage, silently pinning a 5090 user
    // to the 3.4fps-class fallback on EVERY plain-URL load thereafter. The URL param now wins for
    // THIS session only and does not write. We still persist the REQUESTED choice when it came
    // from a stored pref (idempotent) or the default (so a transient gl failure doesn't
    // permanently downgrade a default user once the failure clears) -- just never from the URL.
    if (requestedSource !== "url") {
      try { localStorage.setItem("dwf.renderer", wanted); } catch (_) { /* ignore */ }
    }
  }

  select();

  // getStats(): F3/gate-facing counters, merging the active implementation's own stats (if
  // any) with the renderer name this seam owns. canvas2d's DwfTiles.getStats() already
  // reports its own "renderer":"canvas2d" plus sceneBuildCount; the seam's `renderer` field
  // wins so callers always see what THIS layer resolved to.
  function getStats() {
    let implStats = null;
    try {
      if (window.DwfTiles && typeof DwfTiles.getStats === "function") {
        implStats = DwfTiles.getStats();
      }
    } catch (_) { /* stats must never throw */ }
    let glStats = null;
    if (activeName === "gl" && glController) {
      try { glStats = glController.getStats(); } catch (_) { /* never throw */ }
    }
    // gl stats (sceneBuildCount, scene-build ms, upload bytes, benchpan p95, ...) win when GL
    // is active; the seam's renderer field always wins over both.
    return Object.assign({}, implStats, glStats, { renderer: activeName });
  }

  // F5 overlay support: renderer provenance for the F3 perf overlay (dwf-tiles.js's
  // diagText). `active` is what THIS seam resolved to; `demoted` means an init failure / context
  // loss / atlas-full knocked us off the requested renderer down to canvas2d.
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
    // Runtime RenderParams (spec §1.3) -- forwards to the GL renderer with ZERO scene rebuild;
    // a no-op under canvas2d. WB-10 uses this for the designated-hidden lighten curve.
    setRenderParams(p) { if (glController) glController.setRenderParams(p); },
    _impls: impls,   // debug/test hook only -- not part of the public contract
    _glController: () => glController,   // test hook: context-loss / stats introspection
    _dataKeyComponentForTest: dataKeyComponent,   // F3 both-directions regression test hook
    _terrainKeyComponentForTest: terrainKeyComponent, // R2: onDirty is the sole terrain trigger
  };
  try { window.DwfRender = api; } catch (_) { /* non-browser context */ }
})();
