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

  function closeClientPanel() {
    // Capability declaration is deliberately adjacent to the first executable statement: a module
    // cannot silently lose its shared component contract while retaining hand-built lookalikes.
    clientPanel.className = "";
    panelContent(clientPanel).innerHTML = "";
    activeInfoPanel = null;
    activeInfoSection = null;
    activeInfoDetail = null;
  }

  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function") DWFUI.require("unit-profile-alerts", [
    "actionButtonsHtml", "artBtnHtml", "gridCellHtml", "gridHtml", "headerHtml",
    "paintSprites", "plaqueBtnHtml", "rowHtml", "scrollHtml", "statusHtml", "tabsHtml", "windowHtml", "TOKENS",
  ]);

  function notificationsPanelIsOpen() {
    return activeInfoPanel === "alerts" &&
      clientPanel.classList.contains("visible") &&
      clientPanel.classList.contains("alertbox-panel");
  }

  // Profile portrait choice survives DOM replacement and camera movement. In particular, once an
  // explicitly generated native bust has decoded, a later sheet render keeps that bust ahead of
  // the appearance-hash map composite even when the unit is no longer in the live unit snapshot.
  const __dfcPortraitSourceByUnit = new Map();

  // ---- B-PORTRAIT-FLASH: THE DECODED <img> SURVIVES THE SHEET'S 3-SECOND RE-RENDER. -------------
  // The owner (live): "character portraits are flashing between the art and the letter ... the game
  // continually checks for updated art so is it rerendering it instead of caching it after changes
  // you made". He is right, and there were TWO causes stacked on each other:
  //
  //   1. `nativePortraitMarkup` built its src as `primary + "&try=0&_=" + Date.now()` -- A CACHE
  //      BUSTER ON EVERY RENDER. The browser could not reuse the image it had fetched two seconds
  //      earlier, so it refetched. The buster exists because DF populates portrait texpos LAZILY,
  //      but that is a RETRY concern, not a FIRST-PAINT concern: dfcPortraitError already busts the
  //      cache itself (`&retry=N&_=Date.now()`) for a portrait that genuinely has not resolved. So
  //      the FIRST src is now STABLE and only the RETRY path busts. (A generated bust also changes
  //      the URL on its own: generateUnitPortrait sets portraitTexpos=1, which is IN the query.)
  //
  //   2. `renderUnitSheet` does `panelContent(selection).innerHTML = unitSheetMarkup(...)`, which
  //      DESTROYS the <img> and builds a fresh one. Even served from cache, a fresh <img> decodes
  //      ASYNCHRONOUSLY -- and `.has-native-portrait` (the class that hides the glyph) is only added
  //      in the onload. So between innerHTML and onload the LETTER paints. That is the flash, and no
  //      amount of caching removes it.
  //
  // The fix is to stop re-creating the node at all. Before the innerHTML wipe, every DECODED portrait
  // img inside the host is DETACHED and stashed by `unitId|srcBase`. The markup builder then sees the
  // stash, and for a box whose art we already hold it emits the box WITH `has-native-portrait`
  // ALREADY ON IT AND NO <img> AT ALL -- so no second request is ever issued (a fresh <img src=...>
  // starts loading the moment the parser sees it, even detached). Immediately after the assignment,
  // in the SAME synchronous task (no paint can interleave), the stashed node is re-attached.
  // Result: zero refetches, zero re-decodes, zero flash -- and the letter never gets a frame to show.
  //
  // Ownership is airtight because the stash is filled from the very container that is about to be
  // wiped, and drained in the same call: no other panel's portrait can be stolen, and any stashed
  // node the new markup does not want is simply dropped.
  //
  // THE LETTER FALLBACK IS UNTOUCHED ("I dont mind a letter fallback ... but only if that
  // fallback is flagged"). An adopted box is by definition a RESOLVED identity, so it carries no
  // data-df-identity-missing -- exactly as `dfcPortraitLoad` leaves it. Every terminal letter still
  // carries its marker; portrait_identity_test proves it.
  const __dfcPortraitStash = new Map();     // "id|srcBase" -> the decoded, detached <img>
  function portraitStashKey(id, srcBase) { return String(id) + "|" + String(srcBase || ""); }
  // An adoptable box: no <img>, so no request; the class hides the glyph from the very first frame.
  function portraitAdoptMarkup(key, className, glyphFallback) {
    const id = String(key).split("|")[0];
    return "<div class=\"" + className + " has-native-portrait\" data-unit-portrait-box=\"" +
      escapeHtml(id) + "\" data-portrait-adopt=\"" + escapeHtml(key) + "\">" + glyphFallback + "</div>";
  }
  function harvestDecodedPortraits(host) {
    __dfcPortraitStash.clear();
    if (!host || !host.querySelectorAll) return;
    host.querySelectorAll("[data-unit-portrait-box] .native-portrait-img").forEach(img => {
      const box = img.parentElement;
      if (!box || !box.classList.contains("has-native-portrait")) return;
      // Only a node that has ACTUALLY DECODED may be adopted -- a pending one still needs its
      // onload/onerror to run, and re-attaching a half-loaded img would strand the retry chain.
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) return;
      __dfcPortraitStash.set(portraitStashKey(box.dataset.unitPortraitBox, img.dataset.srcBase), img);
      img.remove();
    });
  }
  function adoptDecodedPortraits(host) {
    let adopted = 0;
    if (host && host.querySelectorAll) {
      host.querySelectorAll("[data-portrait-adopt]").forEach(box => {
        const key = box.dataset.portraitAdopt;
        const img = __dfcPortraitStash.get(key);
        box.removeAttribute("data-portrait-adopt");
        // Defensive: the stash is filled and drained in one synchronous pass, so this cannot miss.
        // If it ever did, the box would be an empty frame, so fall back to the glyph rather than lie.
        if (!img) { box.classList.remove("has-native-portrait"); return; }
        __dfcPortraitStash.delete(key);
        box.prepend(img);
        adopted++;
      });
    }
    __dfcPortraitStash.clear();
    return adopted;
  }
  // Rebuild `host`'s markup while carrying every already-decoded portrait across untouched.
  // `buildHtml` is a THUNK, not a string, and that is load-bearing: the markup builder consults the
  // stash, so the harvest MUST happen before the markup is built. Passing an already-built string
  // would evaluate the builder against an empty stash and silently re-emit the <img>.
  function renderPreservingPortraits(host, buildHtml) {
    if (!host) return 0;
    harvestDecodedPortraits(host);
    let html = "";
    try { html = buildHtml(); }
    finally { if (!html) __dfcPortraitStash.clear(); }
    host.innerHTML = html;
    return adoptDecodedPortraits(host);
  }

  function rememberPortraitSource(node, source) {
    const id = Number(node && node.dataset && node.dataset.unitId);
    if (Number.isFinite(id) && id >= 0 && source)
      __dfcPortraitSourceByUnit.set(id, source);
  }

  window.dfcPortraitLoad = function(img) {
    if (!img || !img.parentElement) return;
    // B53: only reveal the image (which hides the glyph via .has-native-portrait) once it has
    // actually decoded to real pixels. A zero-dimension "load" (an empty/blank surface that still
    // fires onload) must NOT hide the glyph -- that is exactly the "blank portrait box instead of
    // the glyph fallback" symptom for off-screen resident rows. Working portraits are ~24-37px, so
    // this never suppresses a real image; a blank one falls back to the glyph.
    if (!img.naturalWidth || !img.naturalHeight) {
      const box = img.parentElement;
      img.remove();
      if (box) {
        box.classList.remove("has-native-portrait");
        // The glyph is now the terminal answer for this box: a blank decode means no portrait is
        // coming. Flag the letter (a letter fallback is fine to LOOK at -- but only if flagged).
        box.setAttribute("data-df-identity-missing", "portrait:blank-decode");
      }
      return;
    }
    img.parentElement.classList.add("has-native-portrait");
    // A real portrait decoded, so the identity IS resolved -- the marker must not linger and lie.
    img.parentElement.removeAttribute("data-df-identity-missing");
    rememberPortraitSource(img, img.dataset && img.dataset.portraitSource);
  };

  window.dfcAuthoredPortraitLoad = function(image) {
    const box = image && image.closest ? image.closest("[data-unit-portrait-box]") : image && image.parentElement;
    if (!box) return;
    box.classList.add("has-native-portrait");
    box.removeAttribute("data-df-identity-missing");
    rememberPortraitSource(image, "authored");
  };

  window.dfcAuthoredPortraitError = function(image) {
    const box = image && image.closest ? image.closest("[data-unit-portrait-box]") : image && image.parentElement;
    if (box) {
      box.classList.remove("has-native-portrait");
      // The authored portrait is gone and this path does not retry -- the glyph is terminal. Flag it.
      box.setAttribute("data-df-identity-missing", "portrait:authored-missing");
    }
    if (image && image.remove) image.remove();
  };

  // Portrait texpos slots are populated lazily by DF. Keep the glyph visible while an
  // in-DOM portrait waits, then retry at the same slow cadence as spritefresh. Once a
  // request succeeds, no timer remains armed (the image onload is the idle guard).
  //
  // B159: a failed NATIVE portrait re-routes to the unit's WE-2 composite sprite when one is
  // known. The old loop re-fetched the SAME 404ing /unit-portrait URL every 3 s forever -- the
  // exact "human merchant shows a letter H" failure: the sheet rendered before the composite
  // snapshot was warm, fell to the pending native bust, 404'd (pending units have no portrait
  // texture until something GENERATES one), and never re-consulted the sprite sources again.
  // The swap reuses the same <img> (its onload/onerror stay bound), and a miss warms the
  // /unit-sprite snapshot so a later retry can hit.
  window.dfcPortraitError = function(img) {
    if (!img) return;
    const box = img.parentElement;
    if (!box || !box.isConnected) { img.remove(); return; }
    box.classList.remove("has-native-portrait");
    const base = img.dataset.srcBase;
    // No source to retry against: the img is discarded and the glyph is the final answer. Flag it.
    // (The RETRY path below deliberately does NOT flag -- a portrait still in flight is not a failure,
    // and marking it would make the instrument lie in the other direction.)
    if (!base) {
      img.remove();
      box.setAttribute("data-df-identity-missing", "portrait:no-source");
      return;
    }
    const unitId = Number(img.dataset.unitId);
    if (img.dataset.portraitSource === "native" && Number.isFinite(unitId) && unitId >= 0) {
      const spr = liveUnitSprite(unitId);
      if (spr && spr.ah) {
        img.dataset.portraitSource = "sprite";
        img.dataset.portraitRetry = "0";
        img.dataset.srcBase = "/unit-sprite/" + encodeURIComponent(spr.ah) + ".png";
        img.src = img.dataset.srcBase;
        return;
      }
      refreshUnitSpriteSnapshot();
    }
    const next = Number(img.dataset.portraitRetry || 0) + 1;
    img.dataset.portraitRetry = String(next);
    window.setTimeout(() => {
      if (!img.isConnected || !img.parentElement) return;
      img.src = base + "&retry=" + next + "&_=" + Date.now();
    }, 3000);
  };
  // B32: the WE-2 per-unit composite hash for a unit id, resolved the SAME way the map does --
  // first the live on-screen units array (DwfTiles carries ah/sw/sh per unit, tile_map_dump
  // emit_units), then a short-lived snapshot of /unit-sprite (covers units that just left the
  // viewport but are still cached). Returns null when the unit has no composite yet (never drawn),
  // in which case the caller falls back to the native portrait / glyph.
  function liveUnitSprite(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n < 0) return null;
    try {
      const units = (window.DwfTiles && typeof DwfTiles.getLatest === "function" &&
        (DwfTiles.getLatest() || {}).units) || [];
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u && Number(u.id) === n && u.ah) return { ah: u.ah, sw: Number(u.sw) || 1, sh: Number(u.sh) || 1 };
      }
    } catch (_) {}
    const snap = window.__dfcUnitSpriteSnap;
    if (snap && snap[n] && snap[n].ah) return snap[n];
    return null;
  }

  let unitSpriteSnapAt = 0;
  async function refreshUnitSpriteSnapshot() {
    const now = Date.now();
    if (now - unitSpriteSnapAt < 3000) return;
    unitSpriteSnapAt = now;
    try {
      const r = await fetch(`/unit-sprite?t=${now}`, { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      const src = (data && data.units) || {};
      const out = {};
      for (const k in src) {
        const v = src[k];
        if (v && v.ah) out[k] = { ah: v.ah, sw: Number(v.sw) || 1, sh: Number(v.sh) || 1 };
      }
      window.__dfcUnitSpriteSnap = out;
    } catch (_) {}
  }

  // B51: creatures_map.json (race token -> flat sprite-sheet cell) for ANIMAL portraits. Dwarves
  // and other layered races carry {layered:true} + a baked PNG and keep the native portrait
  // widget; flat races (cats/dogs/birds/...) carry a direct {sheet,col,row} cell. tiles.js loads
  // this same file for map rendering, but that copy is module-private there, so the portrait
  // widget loads its own (a small static JSON, browser-cached). Loaded once on module init.
  let __dfcCreaturesMap = null;
  (function loadCreaturesMap() {
    fetch("/creatures_map.json", { cache: "force-cache" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && d.races) __dfcCreaturesMap = d; })
      .catch(() => {});
  })();

  // Phase 2: exact 96x96 flat-animal portrait crops generated from DF's portrait raws. The JSON
  // contains metadata only; the licensed sheets remain in the user's install and flow through
  // the existing traversal-safe /sprites/img/ route.
  let __dfcPortraitsMap = null;
  (function loadPortraitsMap() {
    fetch("/portraits_map.json", { cache: "force-cache" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && d.races) __dfcPortraitsMap = d; })
      .catch(() => {});
  })();

  // B51: raw creature/caste tokens (rt/ct) for a unit id, read from the live on-screen map units
  // (the SAME source liveUnitSprite uses -- tile_map_dump emits rt/ct per unit). Off-screen units
  // are not here; once the server emits rt/ct on the info-panel creature ROW (staged C++), the row
  // itself carries them and the off-screen case is covered too.
  function liveUnitRace(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n < 0) return null;
    try {
      const units = (window.DwfTiles && typeof DwfTiles.getLatest === "function" &&
        (DwfTiles.getLatest() || {}).units) || [];
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u && Number(u.id) === n && u.rt) return { rt: u.rt, ct: u.ct || null };
      }
    } catch (_) {}
    return null;
  }

  // B51: an animal's species sprite cell cropped from the shared creatures sheet -- a clean square
  // icon, unlike the letterboxed map composite or the portrait-widget glyph (the widget only knows
  // how to draw humanoid portraits, so cats/dogs 404 -> a bare letter today). rt/ct come from the
  // info row (server-emitted, staged) or the live map unit (on-screen now). Returns null for
  // layered races (-> native portrait) and when the race/cell can't be resolved (-> caller's
  // existing composite/native/glyph fallback chain). The glyph rides along as a load fallback.
  function creatureCellMarkup(source, className, glyphFallback) {
    const cm = __dfcCreaturesMap;
    if (!cm || !cm.races) return null;
    // Scoped to the 32x32 creature-LIST box (B51 is the creature-list rows). The big unit-sheet
    // portrait box would need the cell scaled up; that is out of scope here.
    if (!String(className || "").includes("info-portrait-small")) return null;
    let rt = source && source.rt;
    let ct = source && source.ct;
    if (!rt) {
      const mu = liveUnitRace(source && (source.id ?? source.unitId ?? -1));
      if (mu) { rt = mu.rt; ct = mu.ct; }
    }
    if (!rt) return null;
    const entry = cm.races[rt];
    if (!entry || entry.layered) return null;   // layered (dwarf/human/...) -> native portrait
    let cell = entry;
    if (ct && entry.castes && entry.castes[ct]) cell = entry.castes[ct];
    if (!cell || !cell.sheet || typeof cell.col !== "number" || typeof cell.row !== "number") return null;
    const size = cm.cell || 32;
    const id = Number(source.id ?? source.unitId ?? -1);
    const url = `/sprites/img/${encodeURIComponent(cell.sheet)}`;
    const style = `background-image:url('${url}');background-position:-${cell.col * size}px -${cell.row * size}px`;
    return `<div class="${className} creature-cell-box" data-unit-portrait-box="${escapeHtml(id)}" style="${style}">${glyphFallback}</div>`;
  }

  function authoredPortraitEntry(source) {
    const races = __dfcPortraitsMap && __dfcPortraitsMap.races;
    const rt = source && source.rt;
    if (!races || !rt || !races[rt]) return null;
    const race = races[rt];
    const ct = source.ct;
    const record = ct && race.castes && race.castes[ct] ? race.castes[ct] : race;
    const age = source.ageClass === "child" || source.ageClass === "baby" ? "child" : "adult";
    return record[age] || record.adult || null;
  }

  function authoredPortraitMarkup(source, className, glyphFallback) {
    if (String(className || "").includes("info-portrait-small")) return null;
    const crop = authoredPortraitEntry(source);
    if (!crop || !crop.img || crop.w !== 96 || crop.h !== 96 || !crop.iw || !crop.ih) return null;
    const id = Number(source.id ?? source.unitId ?? -1);
    const src = `/sprites/img/${String(crop.img).split("/").map(encodeURIComponent).join("/")}`;
    return `<div class="${className} authored-portrait-box" data-unit-portrait-box="${escapeHtml(id)}">` +
      `<svg class="native-portrait-img authored-portrait-svg" viewBox="${crop.cx} ${crop.cy} ${crop.w} ${crop.h}" aria-hidden="true" preserveAspectRatio="xMidYMid slice">` +
      `<image href="${escapeHtml(src)}" width="${crop.iw}" height="${crop.ih}" data-unit-id="${escapeHtml(id)}" ` +
      `onload="window.dfcAuthoredPortraitLoad(this)" onerror="window.dfcAuthoredPortraitError(this)"></image></svg>` +
      glyphFallback + `</div>`;
  }

  function unitSpritePortraitMarkup(id, className, glyphFallback) {
    const spr = liveUnitSprite(id);
    if (!spr || !spr.ah) return null;
    const src = "/unit-sprite/" + encodeURIComponent(spr.ah) + ".png";
    const key = portraitStashKey(id, src);
    if (__dfcPortraitStash.has(key))
      return portraitAdoptMarkup(key, className + " unit-sprite-box", glyphFallback);
    return "<div class=\"" + className + " unit-sprite-box\" data-unit-portrait-box=\"" + escapeHtml(id) + "\">" +
      "<img class=\"native-portrait-img unit-sprite-portrait\" src=\"" + escapeHtml(src) + "\" data-src-base=\"" + escapeHtml(src) + "\" data-portrait-retry=\"0\" data-unit-id=\"" + escapeHtml(id) + "\" data-portrait-source=\"sprite\" alt=\"\" draggable=\"false\" decoding=\"async\" " +
      "onload=\"window.dfcPortraitLoad(this)\" onerror=\"window.dfcSpritePortraitError(this)\">" + glyphFallback + "</div>";
  }
  // B32: a composite sprite that fails to load (evicted/404) just falls back to the glyph -- drop
  // the img and clear has-native-portrait so the first-letter placeholder shows again.
  window.dfcSpritePortraitError = function(img) {
    if (img && !img.dataset.srcBase) img.dataset.srcBase = img.getAttribute("src") || "";
    window.dfcPortraitError(img);
  };

  function nativePortraitState(source) {
    if (["ready", "pending", "unavailable"].includes(source && source.portraitState))
      return source.portraitState;
    // Legacy info-row and old-server payloads have no explicit state. Preserve their established
    // behavior without making new /unit payloads infer portrait validity from texpos.
    const legacy = Number(source && source.portraitTexpos);
    return Number.isFinite(legacy) && legacy >= 0 ? (legacy > 0 ? "ready" : "pending") : "unavailable";
  }

  // B159: native DF generates a unit's portrait the moment its sheet opens; a unit whose sheet was
  // never opened natively stays portrait_texpos==0 ("pending") FOREVER on the wire -- true for
  // dwarven citizens and human visitors alike (verified live: both probe as pending). Citizens
  // usually mask this because the on-screen composite (`ah`) wins the fallback chain; a visitor
  // whose composite misses at render time fell through to a 404ing native bust and the letter
  // glyph. Parity fix: the SHEET portrait auto-generates its native bust once per unit per
  // session (the same view-sheet generate=1 the portrait click uses; server-side fault guards
  // already bound it), for every race -- authored-portrait animals excluded (their crop IS the
  // native look), ready/remembered-native units excluded (bust already exists).
  const __dfcPortraitAutoGenerated = new Set();
  function shouldAutoGeneratePortrait(unit) {
    const source = unit || {};
    const id = Number(source.id ?? source.unitId ?? -1);
    if (!unitImagesEnabled || id < 0 || __dfcPortraitAutoGenerated.has(id)) return false;
    if (authoredPortraitEntry(source)) return false;
    if (__dfcPortraitSourceByUnit.get(id) === "native") return false;
    const state = nativePortraitState(source);
    if (state === "ready") return false;
    const kind = source.portraitKind || (state !== "unavailable" ? "native" : "none");
    return kind === "native";
  }

  function nativePortraitMarkup(source, className, glyphFallback, small) {
    const id = Number(source.id ?? source.unitId ?? -1);
    const state = nativePortraitState(source);
    if (id < 0 || state === "unavailable") return null;
    const texpos = Number(source.portraitTexpos ?? -1);
    const sheetTexpos = Number(source.sheetIconTexpos ?? -1);
    const base = "/unit-portrait?id=" + encodeURIComponent(id) + "&mode=portrait&tex=" + encodeURIComponent(texpos) + "&sheet=" + encodeURIComponent(sheetTexpos);
    const icon = "/unit-portrait?id=" + encodeURIComponent(id) + "&mode=icon&tex=" + encodeURIComponent(texpos) + "&sheet=" + encodeURIComponent(sheetTexpos);
    const primary = small ? icon : base;
    const key = portraitStashKey(id, primary);
    if (__dfcPortraitStash.has(key)) return portraitAdoptMarkup(key, className, glyphFallback);
    // STABLE SRC (no Date.now cache buster -- see the B-PORTRAIT-FLASH note at __dfcPortraitStash).
    // `try=0` marks the first attempt; dfcPortraitError owns the busting for a genuine retry.
    const src = primary + "&try=0";
    return "<div class=\"" + className + "\" data-unit-portrait-box=\"" + escapeHtml(id) + "\"><img class=\"native-portrait-img\" src=\"" + escapeHtml(src) + "\" data-src-base=\"" + escapeHtml(primary) + "\" data-portrait-retry=\"0\" data-portrait-texpos=\"" + texpos + "\" data-unit-id=\"" + escapeHtml(id) + "\" data-portrait-source=\"native\" alt=\"\" draggable=\"false\" decoding=\"async\" onload=\"window.dfcPortraitLoad(this)\" onerror=\"window.dfcPortraitError(this)\">" + glyphFallback + "</div>";
  }

  // A portrait-glyph is a LETTER, and a letter is a BLOCKER, not a fallback (see the identity rule
  // at dwf-ui-components.js:403 -- native NEVER substitutes a letter for missing art). It shipped
  // SILENTLY for months: the "human merchant shows a letter H" failure logged at dfcPortraitError above
  // was invisible to dwfui_boot_test, to the drift guard, and to the Studio's unresolved-identity counter,
  // because nothing marked it. Wave 4 made a missing ITEM sprite fail loud; the PORTRAIT path was the
  // hole left behind. Every terminal glyph now carries data-df-identity-missing, so a letter on screen
  // and a green instrument can never again coexist. `reason` distinguishes a deliberately-off image
  // setting from an identity we genuinely could not resolve.
  function portraitMissingAttr(reason) {
    return " data-df-identity-missing=\"portrait:" + escapeHtml(String(reason)) + "\"";
  }

  function unitPortraitMarkup(unit, className = "unit-portrait") {
    const source = unit || {};
    const id = Number(source.id ?? source.unitId ?? -1);
    const glyphSource = source.race || source.name || source.category || "?";
    const glyph = String(glyphSource).trim().slice(0, 1).toUpperCase() || "?";
    const fallback = "<div class=\"portrait-glyph\">" + escapeHtml(glyph) + "</div>";
    if (!unitImagesEnabled)
      return "<div class=\"" + className + "\" data-unit-portrait-box=\"" + escapeHtml(id) + "\"" +
        portraitMissingAttr("images-off") + ">" + fallback + "</div>";
    // Structured relation rows can resolve an historical figure's authored rt/ct portrait even
    // when there is no live local unit id. Keep the same glyph fallback as the main portrait.
    const authoredMarkup = authoredPortraitMarkup(source, className, fallback);
    if (authoredMarkup) return authoredMarkup;
    if (id >= 0) {
      const cellMarkup = creatureCellMarkup(source, className, fallback);
      if (cellMarkup) return cellMarkup;
      const remembered = __dfcPortraitSourceByUnit.get(id);
      const state = nativePortraitState(source);
      // Identity surfaces use ONE portrait at every size: the Steam unit-sheet bust. The old
      // `!small` guard made Residents, squads, labor, justice, and assignment lists prefer the
      // map-unit composite (a tiny whole figure) even when this exact native portrait was ready.
      if (remembered === "native" || state === "ready") {
        const nativeMarkup = nativePortraitMarkup(source, className, fallback, false);
        if (nativeMarkup) return nativeMarkup;
      }
      const spriteMarkup = unitSpritePortraitMarkup(id, className, fallback);
      if (spriteMarkup) return spriteMarkup;
      // Pending list portraits use the same bust endpoint too. They can temporarily fall through
      // to the existing flagged composite while the paced portrait sweep generates the bust, but
      // they must never request the separate `mode=icon` cell and change identity by context.
      const nativeMarkup = nativePortraitMarkup(source, className, fallback, false);
      if (nativeMarkup) return nativeMarkup;
    }
    // Terminal: every portrait source is exhausted, so this letter is the final answer. Flag it.
    return "<div class=\"" + className + "\"" + portraitMissingAttr("unresolved") + ">" + fallback + "</div>";
  }
  // keepCurrent (B159 auto-generation): leave whatever the box shows (composite sprite / glyph)
  // in place until the generated bust has actually decoded, and put it back untouched on failure
  // -- the explicit click keeps its immediate "box empties while generating" feedback.
  // WD-24 retired the "generate portrait" BUTTON (the box itself is the control), so every caller
  // has passed `button = null` since. Wave 4 / S1 deletes the four unreachable `if (button)` arms
  // and the emoji they wrote (&#128444; / "Off" / "..."). The CAPABILITY is untouched: the click on
  // the portrait box and the auto-generate on open both still POST through /unit-portrait?generate=1.
  function generateUnitPortrait(unit, opts = {}) {
    const source = unit || {};
    const keepCurrent = !!opts.keepCurrent;
    const id = Number(source.id ?? source.unitId ?? -1);
    if (id < 0) return;
    if (!unitImagesEnabled) return;
    const box = selection.querySelector(`[data-unit-portrait-box="${id}"]`);
    if (!box) return;
    const texpos = Number(source.portraitTexpos ?? -1);
    const sheetTexpos = Number(source.sheetIconTexpos ?? -1);
    const src = `/unit-portrait?id=${encodeURIComponent(id)}&mode=portrait&generate=1&tex=${encodeURIComponent(texpos)}&sheet=${encodeURIComponent(sheetTexpos)}&_=${Date.now()}`;
    if (!keepCurrent) {
      box.classList.remove("has-native-portrait");
      box.querySelectorAll(".native-portrait-img").forEach(img => img.remove());
    }
    const img = document.createElement("img");
    img.className = "native-portrait-img";
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    if (keepCurrent) img.style.display = "none";
    img.onload = () => {
      source.portraitTexpos = 1;
      source.portraitState = "ready";
      img.dataset.unitId = String(id);
      img.dataset.portraitSource = "native";
      // B-PORTRAIT-FLASH: give the generated bust the SAME srcBase key nativePortraitMarkup will
      // emit on the next render (portraitTexpos is now 1, and it is IN the query), so the decoded
      // node is adoptable and the freshly-generated portrait does not immediately refetch itself.
      img.dataset.srcBase = `/unit-portrait?id=${encodeURIComponent(id)}&mode=portrait&tex=${encodeURIComponent(1)}&sheet=${encodeURIComponent(sheetTexpos)}`;
      __dfcPortraitSourceByUnit.set(id, "native");
      if (keepCurrent) {
        box.querySelectorAll(".native-portrait-img").forEach(other => { if (other !== img) other.remove(); });
        img.style.display = "";
      }
      window.dfcPortraitLoad(img);
    };
    img.onerror = () => {
      img.remove();
      if (!keepCurrent) box.classList.remove("has-native-portrait");
    };
    box.prepend(img);
    img.src = src;
  }

  function unitOverviewLines(unit, key, fallback = []) {
    const value = unit && Array.isArray(unit[key]) ? unit[key] : [];
    return value.length ? value : fallback;
  }

  // --- DF text color coding for unit text (text-color spec §1, §3.4) ---
  //
  // DELETED (text-color spec, the "big deletion"): the hand-typed EMOTION_POS/NEG/NEU word sets and
  // the level-keyed SKILL_LEVELS table, with colorizeEmotionLine()/colorizeSkillLine(). Both were
  // guesses that provably disagree with the game: the word sets contained non-DF emotions
  // ("jubilation", "optimism") and colored mild-negative emotions (brown=6 in native) like severe
  // ones; the skill colorizer keyed on the level adjective, which live screens disprove (same level
  // word, different color -- color is the SKILL's profession color, spec §2.5). Native color now
  // arrives as a per-span `color` index from the plugin and renders via renderUnitSpans/dfColor.
  //
  // Compact overview strings remain a plain fallback for old DLLs. When the structured skills,
  // relations, or thoughts payload is present, the overview helpers below use its native indices.
  function renderDfMarkup(raw) {
    const parser = typeof window !== "undefined" ? window.DwfDfMarkup : globalThis.DwfDfMarkup;
    if (!parser || typeof parser.parse !== "function") return escapeHtml(raw);
    return parser.parse(raw).spans.map(span => {
      if (span.br) return "<br>";
      if (span.blank) return "<br><br>";
      if (span.indent) return "&nbsp;&nbsp;&nbsp;&nbsp;";
      if (span.key) return ""; // key label resolution needs DF's binding table; parser keeps it typed.
      const idx = Number(span.index);
      const style = Number.isInteger(idx) && idx >= 0 && idx <= 15
        ? ` style="color:${DWFUI.dfColor(idx)}"` : "";
      return `<span${style}>${escapeHtml(span.text || "")}</span>`;
    }).join("");
  }
  function colorizeUnitLine(line, tab, detail) {
    if (typeof line === "string" && line.includes("[")) return renderDfMarkup(line);
    if (detail === "Needs" || /^Unmet need:/.test(line))
      return `<span class="unit-need-line" style="color:inherit">${escapeHtml(line)}</span>`;
    return escapeHtml(line);
  }

  function renderUnitOverviewLines(unit, lines, tab = "Overview", detail = "") {
    const list = Array.isArray(lines) ? lines : [];
    if (!list.length) return "";
    return list.map(line => `<div class="unit-cell-line${classForUnitLine(tab, detail, line)}">${colorizeUnitLine(line, tab, detail)}</div>`).join("");
  }

  function renderUnitOverviewRelations(unit) {
    if (!Array.isArray(unit && unit.relations))
      return renderUnitOverviewLines(unit, unitOverviewLines(unit, "overviewRelationLines"), "Relations");
    return structuredOrder(unit.relations).filter(record => record && record.name).slice(0, 6).map(record =>
      `<div class="unit-cell-line">${escapeHtml(record.label || "Relation")}: ` +
      `<span${unitProfessionColorStyle(record)}>${escapeHtml(record.name)}</span></div>`
    ).join("");
  }

  function renderUnitOverviewSkills(unit) {
    if (!Array.isArray(unit && unit.skills))
      return renderUnitOverviewLines(unit, unitOverviewLines(unit, "overviewSkillLines"), "Skills");
    return structuredOrder(unit.skills).filter(skill => skill && skill.caption).slice(0, 6).map(skill =>
      `<div class="unit-cell-line"><span${skillCaptionColorStyle(skill)}>` +
      `${escapeHtml(`${skill.ratingCaption || "Dabbling"} ${skill.caption}`)}</span></div>`
    ).join("");
  }

  function renderUnitOverviewThoughts(unit) {
    const records = unit && unit.thoughts && Array.isArray(unit.thoughts.recent)
      ? structuredOrder(unit.thoughts.recent) : [];
    if (!records.length)
      return renderUnitOverviewLines(unit,
        unitOverviewLines(unit, "overviewMemoryLines", unit && unit.thoughtLines || []), "Thoughts");
    return records.slice(0, 6).map(record =>
      `<div class="unit-cell-line">${renderUnitSpans(record && record.spans)}</div>`
    ).join("");
  }

  // Overview NEEDS parity (text-color spec §2.7): route the Overview cell through the SAME structured
  // `needs` records the full Personality->Needs tab uses, so the band word gets its native color from
  // the shared span index instead of the plain, always-inherit `overviewNeedLines` fallback. Shows
  // the unmet needs (focus_level < 0), worst first, matching the old overview's filter/cap. Falls back
  // to the plain lines only for a pre-color DLL that ships no structured `needs`.
  function renderUnitOverviewNeeds(unit) {
    if (!Array.isArray(unit && unit.needs))
      return renderUnitOverviewLines(unit, unitOverviewLines(unit, "overviewNeedLines"), "Personality", "Needs");
    const unmet = unit.needs
      .filter(need => need && Array.isArray(need.spans) && Number(need.focus) < 0)
      .sort((a, b) => Number(a.focus) - Number(b.focus))
      .slice(0, 7);
    return unmet.map(need =>
      `<div class="unit-cell-line">${renderUnitSpans(need.spans)}</div>`
    ).join("");
  }

  // B280 -- the Overview status box. `unit.statusWords` is DF's OWN word list for this dwarf
  // (src/unit_status_words.h, thresholds decoded from the game binary). Every word is rendered
  // as a condition line, in DF's emission order; native gives the box no title.
  //
  // The words are DF's, and this function must NEVER add one of its own -- no "Healthy", no
  // "No health problems", no invented reassurance. A dwarf DF has nothing to say about gets an
  // empty box, which is what native draws.
  function renderUnitStatusWords(unit) {
    const words = unit && unit.statusWords;
    if (!Array.isArray(words)) {
      // pre-B280 DLL: the field does not exist. Keep the old cell rather than blank the grid.
      return `<div class="unit-cell-title">Health</div>` +
        `<div class="unit-cell-line">${escapeHtml((unit && unit.bodySummary) || "No health problems")}</div>`;
    }
    return words.map(word =>
      `<div class="unit-cell-line">${escapeHtml(word)}</div>`).join("");
  }

  function showUnitSheet(data) {
    selectedUnitData = data;
    activeUnitTab = "Overview";
    activeUnitDetailTab = null;
    renderUnitSheet();
    // B136: (re)arm the live-refresh loop for the newly opened unit. startUnitSheetRefresh stops
    // any prior timer first, so opening a different unit re-targets the loop rather than leaking it.
    startUnitSheetRefresh(Number(data?.unit?.id ?? -1));
  }

  // B26 FOLLOW UNIT (supersedes WD-24's 1.5 s /unit poll): the camera tracks the unit with
  // the sheet kept open, DF-style. Live positions are already client-side at ~30 Hz --
  // DwfTiles.getLatest().units carries x/y/z+id (batchM B04) -- so we recenter off that
  // for a snappy DF-like lock, with a throttled /unit fallback only when the unit is not in
  // the live snapshot (a fresh z-level, a cage/vehicle, or a transient cull), which also tells
  // us when the unit has died / left the map. Client-side only; moves ONLY this player's
  // camera (the /camera path is per-player). Follow ends on: sheet closed/switched (incl. Esc,
  // which closes the sheet), manual pan or manual z-step, or the unit dying / going off-map.
  const FOLLOW_TICK_MS = 250;        // recenter cadence (DF-like lock without spamming /camera)
  const FOLLOW_PAN_STOP_TILES = 4;   // view-centre drift (x/y) beyond this => manual pan => stop
  const FOLLOW_SETTLE_TICKS = 2;     // skip the drift check ONLY at follow start (initial centre)
  const FOLLOW_FALLBACK_MS = 500;    // min gap between /unit fallback fetches

  let unitFollowId = -1;
  let unitFollowTimer = null;
  let unitFollowCenter = null;       // unit's last tile (drives the recenter decision)
  // B61: the view centre the camera ACTUALLY achieved after the last recenter. Near a map edge
  // DF clamps the camera, so the achieved centre != the unit's tile -- comparing the live view
  // centre against the UNIT tile there reads the clamp as a manual pan and wrongly stops follow
  // (native DF keeps following through the clamp). The manual-pan drift check must therefore be
  // measured against what the camera achieved, not against where the unit is: a clamp holds the
  // achieved centre steady (no drift => follow persists), while a real pan moves it away.
  let unitFollowViewCenter = null;
  let unitFollowSettle = 0;
  let unitFollowBusy = false;
  let unitFollowFetchAt = 0;
  let unitFollowGw = 0, unitFollowGh = 0;  // last-seen visible span; a change == a zoom/resize

  // WAVE 4 / S1: the header camera is native's 2-STATE LATCH (UNIT_SHEET_CAMERA_INACTIVE ->
  // UNIT_SHEET_CAMERA_ACTIVE, white camera on a GREEN fill). The latched state is carried by the
  // SPRITE, not by a CSS tint, so re-latching has to swap the token on the icon span and repaint it
  // -- toggling .active alone would leave the grey camera showing while follow is engaged.
  function markFollowButton(on) {
    try {
      const btn = selection && selection.querySelector("[data-unit-follow]");
      if (!btn) return;
      btn.classList.toggle("active", !!on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      const sprites = (window.DWFUI && DWFUI.TOKENS && DWFUI.TOKENS.sprites) || {};
      const token = on ? sprites.cameraOn : sprites.cameraOff;
      const icon = btn.querySelector("[data-dwfui-sprite]");
      if (token && icon && icon.getAttribute("data-dwfui-sprite") !== token) {
        icon.setAttribute("data-dwfui-sprite", token);
        if (typeof DWFUI.paintSprites === "function") DWFUI.paintSprites(btn);
      }
      btn.title = on ? "Following this unit -- camera tracks it (pan or Esc to stop)"
                     : "Follow this unit (camera tracks it until you pan or press Esc)";
    } catch (_) {}
  }

  // B233-1: the minimap's clear-tracking button (index.html #followBtn) was wired ONLY to the
  // player-follow lock (DwfSpectate) -- it stayed hidden, and did nothing, while a UNIT
  // follow (this module, B26/B60/B61) was running. That is the "structural placeholder" the B175
  // census flagged. Rather than build a second follow system, unit-follow now PUBLISHES its state
  // the same way DwfSpectate does, and controls-placement subscribes to both. One follow
  // machine per kind; one button that clears whichever is engaged.
  const unitFollowSubs = [];
  function getUnitFollowState() {
    return unitFollowId >= 0 ? { following: true, unitId: unitFollowId } : { following: false, unitId: -1 };
  }
  function emitUnitFollowChange() {
    const state = getUnitFollowState();
    for (let i = 0; i < unitFollowSubs.length; i++) {
      try { unitFollowSubs[i](state); } catch (_) {}
    }
  }
  function onUnitFollowChange(cb) {
    if (typeof cb !== "function") return;
    unitFollowSubs.push(cb);
    try { cb(getUnitFollowState()); } catch (_) {}
  }

  function stopUnitFollow() {
    const was = unitFollowId >= 0;
    unitFollowId = -1;
    unitFollowCenter = null;
    unitFollowViewCenter = null;
    unitFollowSettle = 0;
    unitFollowFetchAt = 0;
    if (unitFollowTimer) { window.clearInterval(unitFollowTimer); unitFollowTimer = null; }
    if (was) { markFollowButton(false); emitUnitFollowChange(); }
  }

  // Live client-side position of the followed unit (AUX snapshot). Returns null if absent.
  function liveUnitPos(id) {
    try {
      const units = (window.DwfTiles && typeof DwfTiles.getLatest === "function" &&
        (DwfTiles.getLatest() || {}).units) || [];
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u && Number(u.id) === id && Number.isFinite(Number(u.x)))
          return { x: Number(u.x), y: Number(u.y), z: Number(u.z) };
      }
    } catch (_) {}
    return null;
  }

  // The world tile currently at the centre of THIS player's view. Origin = the server-side
  // per-player camera (currentHud.camera), which setCameraToMapPos refreshes (via loadHud) the
  // instant we recenter AND which flushMove refreshes the instant the user pans -- so it has no
  // recenter round-trip lag (getRenderRect only re-windows on the next server push, which WOULD
  // lag a fast follow and read as a phantom pan). Half-span = the renderer's live zoom-aware
  // gw/gh, so the centre stays INVARIANT under zoom (client zoom shifts the origin by exactly
  // -gw-change/2 to hold the centre) -- only a real manual pan / z-step moves it.
  function viewCentreTile() {
    const rr = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    const cam = (typeof currentHud !== "undefined" && currentHud) ? currentHud.camera : null;
    if (rr && cam && Number.isFinite(Number(cam.x)) && rr.gw > 0 && rr.gh > 0)
      return { x: Math.round(Number(cam.x) + rr.gw / 2), y: Math.round(Number(cam.y) + rr.gh / 2), z: Number(cam.z) };
    if (rr && Number.isFinite(rr.ox) && rr.gw > 0 && rr.gh > 0)
      return { x: Math.round(rr.ox + rr.gw / 2), y: Math.round(rr.oy + rr.gh / 2), z: Number(rr.oz) };
    const vp = cam && currentHud.viewport;
    if (cam && vp)
      return { x: Math.round(Number(cam.x) + Number(vp.w) / 2), y: Math.round(Number(cam.y) + Number(vp.h) / 2), z: Number(cam.z) };
    return null;
  }

  async function unitFollowTick() {
    if (unitFollowId < 0 || unitFollowBusy) return;
    // Sheet closed (Esc/X) or switched to another unit -> stop (mirrors DF).
    const stillOpen = selection.classList.contains("visible") &&
      selection.classList.contains("unit-sheet-panel") &&
      Number(selectedUnitData?.unit?.id) === unitFollowId;
    if (!stillOpen) { stopUnitFollow(); return; }

    // Manual pan / manual z-step -> stop. viewCentreTile() (server camera + live span) equals
    // unitFollowCenter right after each recenter, so between recenters the ONLY thing that shifts
    // it is the user's own pan/z-step. EXCEPTION: a zoom or window-resize changes the visible span
    // (gw/gh) and momentarily desyncs the client span from the not-yet-round-tripped server
    // camera, which would read as a phantom pan -- so when gw/gh changed since last tick we skip
    // the drift check for this tick (a zoom must NOT end follow; DF keeps following through zoom).
    // A real pan never changes gw/gh, so it is still caught in a single tick.
    const rrNow = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    const spanChanged = rrNow && (rrNow.gw !== unitFollowGw || rrNow.gh !== unitFollowGh);
    if (rrNow) { unitFollowGw = rrNow.gw; unitFollowGh = rrNow.gh; }
    if (unitFollowSettle > 0) {
      unitFollowSettle--;
    } else if (spanChanged) {
      unitFollowSettle = 1;   // let the server camera catch up to the new zoom before checking
    } else if (unitFollowViewCenter) {
      // Drift is measured against the ACHIEVED view centre (unitFollowViewCenter), NOT the unit
      // tile. Between recenters the camera is stationary, so the live view centre equals the
      // achieved centre unless the user pans -- true at map edges too, where the achieved centre
      // is the clamped one. A clamp therefore never registers as drift (follow persists like
      // native DF), while a real manual pan/z-step moves the view centre off the baseline.
      const cc = viewCentreTile();
      if (cc) {
        const dz = Math.abs(cc.z - unitFollowViewCenter.z);
        const dxy = Math.max(Math.abs(cc.x - unitFollowViewCenter.x), Math.abs(cc.y - unitFollowViewCenter.y));
        if (dz >= 1 || dxy > FOLLOW_PAN_STOP_TILES) { stopUnitFollow(); return; }
      }
    }

    // Locate the unit: live snapshot first, then a throttled /unit fallback (fresh z-level /
    // cage / vehicle / off-screen). A dead or off-map unit yields no live entry AND no /unit
    // tile (or a dead flag) -> counts as a miss -> stop after the grace window.
    let pos = liveUnitPos(unitFollowId);
    let deadStop = false;
    if (!pos && Date.now() - unitFollowFetchAt >= FOLLOW_FALLBACK_MS) {
      unitFollowFetchAt = Date.now();
      unitFollowBusy = true;
      try {
        const ac = ("AbortController" in window) ? new AbortController() : null;   // don't hang the loop
        const to = ac ? setTimeout(() => ac.abort(), 2500) : null;
        const r = await fetch(`/unit?player=${encodeURIComponent(player)}&id=${encodeURIComponent(unitFollowId)}&t=${Date.now()}`, { cache: "no-store", signal: ac ? ac.signal : undefined });
        if (to) clearTimeout(to);
        if (r.ok) {
          const d = await r.json();
          const u = d && d.unit;
          const flags = (u && Array.isArray(u.flags)) ? u.flags.join(" ").toLowerCase() : "";
          const t = d && d.tile;
          if ((d && d.error) || (u && (u.dead || /dead|deceas|corpse/.test(flags)))) {
            deadStop = true;                       // unit died -> DF stops following
          } else if (t && Number.isFinite(Number(t.x))) {
            pos = { x: Number(t.x), y: Number(t.y), z: Number(t.z) };
          }
        } else if (r.status === 404) {
          // B61: /unit 404s ONLY when df::unit::find() returns null -> the unit no longer exists
          // in the world (permanent despawn), the one non-death case DF also stops following on.
          // A live unit is always findable regardless of z-level or viewport visibility, so 404
          // "not found" is a definitive despawn signal -- but a transient render-thread exception
          // is also 404, so require the not-found message and treat anything else as transient.
          let body = null;
          try { body = await r.json(); } catch (_) {}
          const emsg = body && body.error ? String(body.error).toLowerCase() : "";
          if (/not\s*found/.test(emsg)) deadStop = true;
        }
      } catch (_) {}
      unitFollowBusy = false;
      if (unitFollowId < 0) return;                // stopped mid-await
    }

    if (deadStop) { stopUnitFollow(); return; }
    if (!pos) {
      // B61: the unit is only TEMPORARILY unlocatable (not in the live snapshot yet AND the
      // throttled /unit fallback has not landed this tick) -- e.g. a fresh z-level, a cage, an
      // off-viewport excursion, or a briefly-failing fetch. Native DF keeps the lock through
      // this; so do we. Follow persists and re-attaches the moment the unit reappears in the
      // snapshot or the next fallback resolves. Disengage is reserved for explicit user action
      // (pan / Esc / sheet close) or a confirmed death/despawn (deadStop above) -- never a miss.
      return;
    }

    // Recenter only when the unit has actually left the tile we last centred on. We do NOT
    // re-arm the settle window here: viewCentreTile() reads the server camera (refreshed by this
    // recenter's loadHud), so between recenters the view centre equals unitFollowCenter with no
    // lag -- the ONLY thing that can move it away is a manual pan/z-step, which the drift check
    // above must stay live to catch even while chasing a walking unit.
    if (!unitFollowCenter || pos.x !== unitFollowCenter.x || pos.y !== unitFollowCenter.y || pos.z !== unitFollowCenter.z) {
      unitFollowCenter = { x: pos.x, y: pos.y, z: pos.z };
      if (selectedUnitData) selectedUnitData.tile = { x: pos.x, y: pos.y, z: pos.z };
      unitFollowBusy = true;
      // Timeout-guard the recenter: a hung /camera or /hud fetch (server busy/mid-restart) must
      // NOT wedge unitFollowBusy=true forever (that would silently freeze follow). On a failure
      // or timeout, currentHud may be stale, so skip the NEXT drift check to avoid a phantom-pan
      // stop; the recenter retries next tick.
      let ok = false;
      try { ok = await Promise.race([setCameraToMapPos(unitFollowCenter), new Promise(res => setTimeout(() => res("timeout"), 3000))]); } catch (_) {}
      unitFollowBusy = false;
      if (ok !== true) { unitFollowSettle = Math.max(unitFollowSettle, 1); }
      else {
        // Latch the drift baseline to the centre the camera ACTUALLY reached (clamped at edges).
        // setCameraToMapPos awaited loadHud, so viewCentreTile() now reads the fresh server
        // camera. This is what the next tick's manual-pan check compares against.
        const achieved = viewCentreTile();
        if (achieved) unitFollowViewCenter = achieved;
      }
    }
  }

  function startUnitFollow(unitId, initialPos) {
    stopUnitFollow();
    unitFollowId = Number(unitId);
    unitFollowFetchAt = 0;
    unitFollowSettle = FOLLOW_SETTLE_TICKS;
    unitFollowCenter = (initialPos && Number.isFinite(Number(initialPos.x)))
      ? { x: Number(initialPos.x), y: Number(initialPos.y), z: Number(initialPos.z) } : null;
    // The caller centred on initialPos (awaited) just before this, so the achieved view centre
    // is live now -- seed the drift baseline with it (clamped near an edge). Null-safe: the
    // settle window skips the drift check until the first recenter latches a real baseline.
    unitFollowViewCenter = (typeof viewCentreTile === "function") ? viewCentreTile() : null;
    const rr0 = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    unitFollowGw = rr0 ? rr0.gw : 0;
    unitFollowGh = rr0 ? rr0.gh : 0;
    markFollowButton(true);
    unitFollowTimer = window.setInterval(() => { unitFollowTick(); }, FOLLOW_TICK_MS);
    emitUnitFollowChange();   // B233-1: tell the minimap's clear-tracking button we are locked on
  }

  // B120: DFHack's readable name (server unit.name) embeds the nickname as a single-quoted token
  // ('Nick' Lastname). The unit sheet shows the nickname on its OWN line (unit.nickname), so the
  // name embedding it is a DUPLICATE -- and it's a STALE duplicate: the server's name string comes
  // from a name copy the client's nickname editor never rewrites (only unit->name.nickname, which
  // feeds the live getVisibleName -> unit.nickname line), so the two disagree after a rename
  // ('Thintownsss' vs "Thintowns"). Drop the embedded token here; unit.nickname is the one live
  // source. No-op for a unit that was never nicknamed (no quoted token in its readable name).
  function stripEmbeddedNickname(name) {
    const s = String(name || "");
    const out = s.replace(/'[^']*'/, "").replace(/\s{2,}/g, " ").replace(/^\s*,\s*/, "").trim();
    return out || s;
  }
  // Only strip when a live nickname line (unit.nickname) exists to defer to, so a unit whose only
  // nickname is the embedded one (e.g. a legends nickname with no fort nickname) never loses it.
  function unitNameLine(unit) {
    const name = String((unit && unit.name) || "");
    return (unit && unit.nickname) ? stripEmbeddedNickname(name) : name;
  }

  // DF colors the sheet's name/title line with the unit's profession colour. The plugin resolves
  // that exact 4-bit index with Units::getProfessionColor; absent/old payloads stay uncoloured.
  function unitNameColorStyle(unit) {
    const idx = unit && unit.professionColor;
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) return "";
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }
  // B159 chrome parity: native's third header line reads "No activity" when idle (26-unit-sheet /
  // B159-2). Older servers send "No job"; map the label client-side so both wire shapes match.
  function unitActivityLine(unit) {
    const job = String((unit && unit.currentJob) || "").trim();
    return (!job || job === "No job") ? "No activity" : job;
  }

  // B176: open the room a dwarf is assigned to from its Rooms row -- reuse the existing
  // camera-jump (setCameraToMapPos + flashMapTile) and the zone/building panel opener
  // (openInfoPlace -> openZonePanel), never a duplicate. Opening the zone panel replaces the unit
  // sheet in #selection, so tear down the sheet's follow + live-refresh timers first (they key off
  // the unit-sheet-panel class and would otherwise self-terminate a tick later). Camera zoom needs
  // the server room center (centerX/Y/Z on /unit); without it we still open the zone panel.
  async function openUnitRoom(buildingId, pos) {
    stopUnitFollow();
    stopUnitSheetRefresh();
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
      try { await setCameraToMapPos(pos); } catch (_) {}
      if (typeof flashMapTile === "function") flashMapTile(pos);
    }
    if (Number.isInteger(buildingId) && buildingId >= 0 && typeof openInfoPlace === "function")
      openInfoPlace("zone", buildingId);
    focusPage();
  }

  // B136: the unit sheet was a point-in-time snapshot -- the activity line (and every
  // data-driven tab) stayed frozen while the dwarf's job changed underneath it. This re-polls
  // /unit at a modest cadence, but ONLY while THIS unit's sheet is open, and tears the timer down
  // the moment the sheet closes or switches units (leaked intervals are a known bug class here).
  // A refresh must never yank the UI out from under the player: it skips while a nickname edit is
  // in progress and preserves scroll position across the re-render (the active tab/detail are
  // module-level and already survive renderUnitSheet).
  const UNIT_SHEET_REFRESH_MS = 3000;
  let unitSheetRefreshTimer = null;
  let unitSheetRefreshId = -1;
  let unitSheetRefreshBusy = false;

  function stopUnitSheetRefresh() {
    if (unitSheetRefreshTimer) { window.clearInterval(unitSheetRefreshTimer); unitSheetRefreshTimer = null; }
    unitSheetRefreshId = -1;
    unitSheetRefreshBusy = false;
  }

  function startUnitSheetRefresh(unitId) {
    stopUnitSheetRefresh();
    const id = Number(unitId);
    if (!Number.isInteger(id) || id < 0) return;
    unitSheetRefreshId = id;
    unitSheetRefreshTimer = window.setInterval(() => { unitSheetRefreshTick(); }, UNIT_SHEET_REFRESH_MS);
  }

  // True only while THIS player's unit sheet is the open panel for the unit we are refreshing.
  function unitSheetStillOpen(id) {
    return selection.classList.contains("visible") &&
      selection.classList.contains("unit-sheet-panel") &&
      Number(selectedUnitData?.unit?.id) === id;
  }

  // An in-progress interaction (the nickname editor) must survive a refresh untouched.
  function unitSheetInteractionBusy() {
    return !!selection.querySelector("[data-unit-nickname-editor]");
  }

  // Capture/restore the scroll offset of the open tab's scroll container, keyed by class list so
  // the value re-attaches after renderUnitSheet rebuilds the DOM. A refresh must not scroll the
  // player back to the top of a long Relations / Thoughts / Rooms list they were reading.
  const UNIT_SHEET_SCROLL_SEL = ".unit-structured-list,.unit-list-grid,.unit-cell.wide," +
    ".unit-text-block,.unit-prose-block,.unit-knowledge-list,.unit-skill-list,.unit-workdetails";
  function captureUnitSheetScroll() {
    const map = [];
    selection.querySelectorAll(UNIT_SHEET_SCROLL_SEL).forEach(el => {
      if (el.scrollTop > 0) map.push({ cls: el.className, top: el.scrollTop });
    });
    return map;
  }
  function restoreUnitSheetScroll(map) {
    if (!map || !map.length) return;
    const els = Array.from(selection.querySelectorAll(UNIT_SHEET_SCROLL_SEL));
    const used = new Set();
    map.forEach(rec => {
      const el = els.find((e, i) => !used.has(i) && e.className === rec.cls && (used.add(i), true));
      if (el) el.scrollTop = rec.top;
    });
  }

  async function unitSheetRefreshTick() {
    if (unitSheetRefreshId < 0 || unitSheetRefreshBusy) return;
    if (!unitSheetStillOpen(unitSheetRefreshId)) { stopUnitSheetRefresh(); return; }
    if (unitSheetInteractionBusy()) return;   // don't clobber an open nickname edit
    unitSheetRefreshBusy = true;
    try {
      const ac = ("AbortController" in window) ? new AbortController() : null;
      const to = ac ? setTimeout(() => ac.abort(), 2500) : null;
      const r = await fetch(`/unit?player=${encodeURIComponent(player)}&id=${encodeURIComponent(unitSheetRefreshId)}&t=${Date.now()}`,
        { cache: "no-store", signal: ac ? ac.signal : undefined });
      if (to) clearTimeout(to);
      if (!r.ok) return;                       // transient failure -> keep the current view, retry next tick
      const data = await r.json();
      // The sheet may have closed / switched / opened an editor during the await.
      if (unitSheetRefreshId < 0 || !unitSheetStillOpen(unitSheetRefreshId) ||
          Number(data?.unit?.id) !== unitSheetRefreshId || unitSheetInteractionBusy())
        return;
      const scroll = captureUnitSheetScroll();
      selectedUnitData = data;
      renderUnitSheet();
      restoreUnitSheetScroll(scroll);
    } catch (_) {
      // network/timeout -> leave the current (stale) view in place; the next tick retries.
    } finally {
      unitSheetRefreshBusy = false;
    }
  }

  // Pure production markup shared with Parity Studio. The live sheet keeps all of its existing
  // event wiring below; this builder owns the visible shell so offline review cannot drift.
  function unitNicknameEditorMarkup(unit, statusText = "") {
    const nickname = String(unit?.nickname || "").slice(0, 64);
    return `<form class="unit-nickname-editor" data-unit-nickname-editor>` +
      `<label class="unit-nickname-label"><span>Nickname</span><input type="text" maxlength="64" value="${escapeHtml(nickname)}" aria-label="Unit nickname" autocomplete="off" spellcheck="false"></label>` +
      DWFUI.plaqueBtnHtml({ type: "submit", cls: "unit-nickname-save", tone: "green", label: "Save" }) +
      DWFUI.plaqueBtnHtml({ type: "button", cls: "unit-nickname-cancel", label: "Cancel", dataset: { unitNicknameCancel: "" } }) +
      DWFUI.statusHtml({ tag: "span", cls: "unit-nickname-status", text: statusText, role: "status", live: "polite" }) +
      `</form>`;
  }

  // WAVE 4 / S1 -- THE SHARED PROFILE SHELL. It is byte-identical across all 24 profile states, so
  // it is built ONCE, here, out of DWFUI (matrix section 4 S1 + S1-unit-profile-evidence.md section 2.1):
  //
  //   * NO title bar, NO footer -- native's unit sheet has neither. The only close is the panel's
  //     own host-anchored .unit-close-button (see the CLOSE note below); headerHtml gets close:false
  //     so the header cannot stack a second one.
  //   * headerHtml({variant:'unit', toolRows}) -- native's BANDED tool cluster. Row 1 is three
  //     self-framed tiles butted together (reports / quill / camera). The camera is a 2-state latch.
  //   * ONE 11-item primary TAB set, WRAPPED onto two rows. Row B is NOT a sub-level: one tablist,
  //     one aria-selected across both rows. The old .unit-tabs/.unit-subtabs split encoded a
  //     hierarchy native does not have.
  //   * The SHORT_SUBTAB row is conditional (absent on Overview/Items/Rooms/Relations/Groups).
  //
  // CLOSE (the binding verdict, DELETION-LEDGER.md): the close is a WIRED capability -- it also
  // calls stopUnitSheetRefresh(), and dwf-panelframe.js:405 lists .unit-close-button in
  // CLOSE_SEL. Head ADOPTION (panelframe.js:450) is CONDITIONAL on the skin owning a close: delete
  // it and skinCloseFor() returns null, adoption fails, and the framework's generated .pf-head title
  // bar UN-HIDES with a fresh X -- i.e. a naive close:false ADDS non-native chrome and leaks the 2s
  // /unit poll. So the close STAYS as the panel's single close affordance, the header owns none, and
  // the teardown is untouched. Restyling its glyph to the native BUTTON_CLOSE tile needs a CSS rule
  // in a file S1 does not own -> COMPONENT-GAP-S1-CLOSE in the closeout.
  const UNIT_PRIMARY_TABS = [
    "Relations", "Groups", "Military", "Thoughts", "Personality",   // native row A
    "Overview", "Items", "Health", "Skills", "Rooms", "Labor",      // native row B (same level)
  ];
  function unitHeaderToolRows(unit) {
    const S = (window.DWFUI && DWFUI.TOKENS && DWFUI.TOKENS.sprites) || {};
    const following = unitFollowId >= 0 && unitFollowId === Number(unit && unit.id);
    // Native's fourth tile (row 2, right-aligned) is UNIT_SHEET_EXPEL. We have NO expel route, and a
    // tile that expels nobody is fabricated UI -- it is OMITTED, not drawn dead. toolRows already
    // renders the second band the day the capability lands.
    return [[
      // Tile 1 art is verified (UNIT_SHEET_VIEW_REPORTS); its NATIVE action is Q-S1-1 /
      // `needs the owner evidence` (nobody has hovered it). Our wired combat-log rides on it.
      { sprite: S.viewReports, dataset: { unitCombatlog: "" }, title: "Combat history" },
      { sprite: S.quill, dataset: { unitNickname: "" }, title: "Customize nickname" },
      {
        sprite: following ? S.cameraOn : S.cameraOff, active: following,
        dataset: { unitFollow: "" },
        title: following ? "Following this unit -- camera tracks it (pan or Esc to stop)"
                         : "Follow this unit (camera tracks it until you pan or press Esc)",
      },
    ]];
  }
  function unitSheetMarkup(data, options = {}) {
    const unit = data?.unit || {};
    const tab = options.tab || "Overview";
    const detailTabs = unitDetailTabs(tab);
    const detail = detailTabs.includes(options.detail) ? options.detail : (detailTabs[0] || null);
    // The flag CHIPS are gone (native shows citizenship in Overview band 2 / Groups, never as
    // badges) but the ARRAY is load-bearing: it is the fallback for the Overview "Groups" cell.
    const flags = Array.isArray(unit.flags) ? unit.flags : [];
    const statusLines = Array.isArray(unit.statusLines) && unit.statusLines.length ? unit.statusLines : [unit.status || "Healthy"];
    const sexSymbol = unit.sex === "female" ? "&#9792;" : (unit.sex === "male" ? "&#9794;" : "?");
    const training = unit.training ? `<div class="subtle">${escapeHtml(unit.training)}</div>` : "";
    const statusHtml = statusLines.map(line => `<div>${escapeHtml(line)}</div>`).join("");
    // THE BODY IS A TABLE OF CELLS, AND THE TABLE OWNS THE DIVIDERS -- `DWFUI.gridHtml`, not a stack
    // of bordered cards. (Matrix S4 S1: "2 columns x 4 bands ... the left cell of band 3 is EMPTY and
    // the divider still draws -- the grid is fixed, not content-driven." The empty band-3 cell below
    // is that cell, and it is why the grid, not the cell, must own the line.) A cell states NO
    // border; there is exactly ONE frame between it and the window, and that frame is the window.
    const cell = (cls, html) => DWFUI.gridCellHtml({ cls }, html);
    const overviewGrid = DWFUI.gridHtml({ cls: "unit-grid" }, [
      cell("unit-cell", `<div>${escapeHtml(unit.age || "Age unknown")}, ${sexSymbol}</div>${training}${renderUnitOverviewRelations(unit)}`),
      cell("unit-cell", renderUnitOverviewLines(unit, unitOverviewLines(unit, "overviewTraitLines", statusLines), "Personality", "Traits") || statusHtml),
      // B280 -- the left-middle box is DF's STATUS LIST, not a "Health" summary. In the native
      // oracle (evidence/oracles/activities/UNIT-OVERVIEW-status-needs-NATIVE.png) it holds the
      // single word `Thirsty` with NO title above it -- the box is a bare list of the conditions
      // DF itself says this dwarf is in ("Thirsty", "Starving", "Very drowsy", "Unconscious",
      // "Stressed", ...). The words come from the server's `statusWords`, computed by
      // src/unit_status_words.h from the ladder decoded out of Dwarf Fortress.exe. They are the
      // same states the overhead bubbles claim, from the same fields -- which is exactly why
      // status_truth_test.mjs can hold the two to each other.
      //
      // Fallback: a DLL that predates B280 sends no `statusWords` at all, and we keep drawing what
      // we drew before rather than blanking the cell. `statusWords: []` (present, empty) is a
      // CONTENT dwarf and renders as native does -- see the open capture request in the wave
      // report; the empty-box state is the one thing the single oracle cannot show us.
      cell("unit-cell", renderUnitStatusWords(unit)),
      cell("unit-cell", renderUnitOverviewLines(unit, unitOverviewLines(unit, "overviewPositionLines", flags), "Groups")),
      cell("unit-cell", ""),
      cell("unit-cell", renderUnitOverviewLines(unit, unitOverviewLines(unit, "overviewSquadLines"), "Military", "Squad")),
      cell("unit-cell", renderUnitOverviewSkills(unit)),
      cell("unit-cell", renderUnitOverviewNeeds(unit)),
      DWFUI.gridCellHtml({ cls: "unit-cell wide", wide: true },
        renderUnitOverviewThoughts(unit) ||
        `<div class="unit-cell-line subtle">No recent thoughts recorded.</div>`),
    ].join(""));
    const bodyHtml = tab === "Overview" ? overviewGrid : renderUnitTabBody(unit, tab, detail);
    const nicknameEditor = options.nicknameEditing ? unitNicknameEditorMarkup(unit, options.nicknameStatus || "") : "";
    // Native's customize is an IN-PLACE swap of the identity block (attach-1), so the editor lives
    // inside the identity cell -- the same host the live click handler injects into.
    const identity = `<div class="unit-name-line"${unitNameColorStyle(unit)}>${escapeHtml(unitNameLine(unit) || data?.title || "Unit")}</div>` +
      `${unit.nickname ? `<div class="unit-nickname-line">&quot;${escapeHtml(unit.nickname)}&quot;</div>` : ""}` +
      `<div class="unit-job-line">${escapeHtml(unitActivityLine(unit))}</div>${nicknameEditor}`;
    const header = DWFUI.headerHtml({
      variant: "unit",
      cls: "dwfui-head unit-sheet-header",   // .unit-sheet-header is PanelFrame's adoptHeadSel target
      close: false,
      icon: unitPortraitMarkup(unit),
      titleHtml: identity,
      toolRows: unitHeaderToolRows(unit),
    });
    const tabs = DWFUI.tabsHtml({
      level: "primary", wrap: true, width: "hug", dataAttr: "unit-tab",
      ariaLabel: "Unit profile tabs",
      tabs: UNIT_PRIMARY_TABS.map(label => ({ key: label, label })),
      active: tab,
    });
    const subtabs = detailTabs.length
      ? DWFUI.tabsHtml({
        level: "subtab", dataAttr: "unit-detail-tab", ariaLabel: "Unit profile subtabs",
        tabs: detailTabs.map(label => ({ key: label, label })),
        active: detail,
      })
      : "";
    // The normal citizen sheet keeps its close tile. Native's multi-occupant rail is the one
    // evidenced exception: that sheet is dismissed through the surrounding selection context and
    // the exact rail capture has no red X. Callers must opt out explicitly; all existing live
    // unit-sheet paths therefore keep the current control.
    const close = options.close === false ? "" : DWFUI.artBtnHtml({
      sprite: DWFUI.TOKENS.sprites.close, cls: "unit-close-button",
      dataset: { unitClose: "" }, title: "Close", ariaLabel: "Close",
    });
    return `<div class="unit-sheet">
      ${close}
      ${header}
      ${tabs}
      ${subtabs}
      ${bodyHtml}
    </div>`;
  }

  function renderUnitSheet() {
    const data = selectedUnitData || {};
    const unit = data.unit || {};
    // WAVE 4 / S1 (audit A1): ~60 lines here recomputed the ENTIRE sheet -- tabButton, detailButton,
    // flagHtml, actionHtml, overviewGrid, detailHtml, bodyHtml, and 15 more locals -- and then threw
    // every one of them away, because the line below renders unitSheetMarkup(data, ...) instead. It
    // was a verbatim second copy of the builder and the exact place the two renderers would silently
    // diverge. Deleted. The subtab NORMALISATION below is NOT dead: it mutates the module-level
    // activeUnitDetailTab that unitSheetMarkup then reads.
    const detailTabs = unitDetailTabs(activeUnitTab);
    if (detailTabs.length && !detailTabs.includes(activeUnitDetailTab))
      activeUnitDetailTab = detailTabs[0];
    if (!detailTabs.length)
      activeUnitDetailTab = null;
    selection.className = "visible unit-sheet-panel";
    // B-PORTRAIT-FLASH: NOT a bare `innerHTML =`. The 3s live refresh calls straight through here,
    // and a bare assignment destroys the decoded portrait <img> and re-requests it, which is the
    // letter/art flicker the owner is seeing. renderPreservingPortraits detaches the decoded node first and
    // re-attaches it in the same synchronous task; the markup builder, seeing the stash, emits no
    // second <img> at all. Zero refetches, and no frame in which the glyph can paint.
    renderPreservingPortraits(panelContent(selection),
      () => unitSheetMarkup(data, { tab: activeUnitTab, detail: activeUnitDetailTab }));
    selection.querySelectorAll("[data-unit-tab]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        activeUnitTab = button.dataset.unitTab || "Overview";
        activeUnitDetailTab = null;
        renderUnitSheet();
        focusPage();
      });
    });
    selection.querySelectorAll("[data-unit-detail-tab]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        activeUnitDetailTab = button.dataset.unitDetailTab || null;
        renderUnitSheet();
        focusPage();
      });
    });
    selection.querySelectorAll("[data-unit-relation-open]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(button.dataset.unitRelationOpen);
        if (Number.isInteger(id) && id >= 0 && typeof openUnitById === "function")
          openUnitById(id);
        focusPage();
      });
    });
    // WAVE 4 / S1: native's relation row carries a PAIR of trailing tiles -- STOCKS_RECENTER then
    // STOCKS_VIEW_ITEM (Steam relations.png; both gold-framed, both 24x36). We shipped only the
    // magnifier's job on a single position-indicator glyph. The recenter is the missing HALF of the
    // native control, built from machinery this file already owns (liveUnitPos + setCameraToMapPos +
    // flashMapTile) -- no new route, no new wire field, and it leaves the sheet open.
    selection.querySelectorAll("[data-unit-relation-recenter]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(button.dataset.unitRelationRecenter);
        if (!Number.isInteger(id) || id < 0) return;
        const pos = liveUnitPos(id);
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
          await setCameraToMapPos(pos);
          flashMapTile(pos);
        }
        focusPage();
      });
    });
    // B176: click an assigned Rooms row (or its zoom button) -> jump the camera to the room and
    // open its zone panel. The row and its button both carry data-unit-room-open; the row also
    // carries the optional room center (roomX/Y/Z) for the camera jump.
    selection.querySelectorAll("[data-unit-room-open]").forEach(el => {
      el.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const row = el.closest("[data-unit-room-category]") || el;
        const bid = Number(el.dataset.unitRoomOpen ?? row.dataset.unitRoomOpen ?? -1);
        const pos = {
          x: Number(row.dataset.roomX), y: Number(row.dataset.roomY), z: Number(row.dataset.roomZ),
        };
        openUnitRoom(bid, Number.isFinite(pos.x) ? pos : null);
      });
    });
    const nicknameButton = selection.querySelector("[data-unit-nickname]");
    if (nicknameButton) {
      nicknameButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (selection.querySelector("[data-unit-nickname-editor]")) return;
        const header = nicknameButton.closest(".unit-sheet-header");
        if (!header) return;
        // Native's customize is an IN-PLACE transform of the IDENTITY BLOCK (attach-1), not a
        // dialog and not a strip bolted under the header -- so the editor is injected into the
        // identity cell, the same host unitSheetMarkup renders it into.
        const identity = header.querySelector(".dwfui-head-title") || header;
        identity.insertAdjacentHTML("beforeend", unitNicknameEditorMarkup(unit));
        const editor = header.querySelector("[data-unit-nickname-editor]");
        const input = editor?.querySelector('input[aria-label="Unit nickname"]');
        const save = editor?.querySelector('.unit-nickname-save');
        const cancel = editor?.querySelector('[data-unit-nickname-cancel]');
        const status = editor?.querySelector('.unit-nickname-status');
        if (!editor || !input || !save || !cancel || !status) return;
        input.focus();
        cancel.addEventListener("click", () => editor.remove());
        editor.addEventListener("submit", async submitEvent => {
          submitEvent.preventDefault();
          const id = Number(unit.id);
          if (!Number.isInteger(id) || id < 0) return;
          save.disabled = true;
          status.textContent = "Saving…";
          try {
            const params = new URLSearchParams({ player, unit: String(id), nickname: input.value.slice(0, 64) });
            const response = await fetch(`/unit-nickname?${params}`, { method: "POST", cache: "no-store" });
            if (!response.ok) throw new Error("nickname update failed");
            const updated = await response.json();
            unit.nickname = String(updated.nickname || "");
            renderUnitSheet();
          } catch (_) {
            save.disabled = false;
            status.textContent = "Could not save nickname.";
          }
        });
      });
    }
    // B73: combat history reachable from a creature's profile (native parity: unit sheet ->
    // that unit's combat log). Opens the existing native combat-log flow straight into STATE B
    // (this unit's full combat text, /combat-reports?unit=id); it degrades gracefully to a "no
    // combat text yet" message for non-combatants or older servers (see dwf-combatlog-panel).
    const combatBtn = selection.querySelector("[data-unit-combatlog]");
    if (combatBtn) {
      combatBtn.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(unit.id);
        if (!Number.isInteger(id) || id < 0) return;
        if (typeof window !== "undefined" && typeof window.openCombatLogPanel === "function") {
          window.openCombatLogPanel({ unitId: id, unitName: unit.name || data.title || "" });
        }
        focusPage();
      });
    }
    const follow = selection.querySelector("[data-unit-follow]");
    if (follow) {
      // Re-render can blow the sheet DOM away mid-follow; restore the latched state + tooltip.
      markFollowButton(unitFollowId === Number(unit.id));
      follow.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        // Toggle FOLLOW off if already following this unit.
        if (unitFollowId === Number(unit.id)) {
          stopUnitFollow();
          focusPage();
          return;
        }
        // Prefer the live client-side position; fall back to the sheet's own tile.
        const live = liveUnitPos(Number(unit.id));
        const tile = live || data.tile || {};
        const pos = { x: Number(tile.x), y: Number(tile.y), z: Number(tile.z) };
        if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
          // Center + ENGAGE follow immediately (sheet stays OPEN, unlike the old close-and-
          // recenter); the tile flash is a fire-and-forget visual cue and must NOT delay the
          // lock (its ~1 s animation previously ran before startUnitFollow, so follow only
          // latched a second after the click).
          await setCameraToMapPos(pos);
          startUnitFollow(Number(unit.id), pos);
          flashMapTile(pos);
        }
        focusPage();
      });
    }
    // WD-24: the header icon row is now the DF-shaped quill+camera pair only (no invented
    // "generate portrait" button) -- the on-demand portrait-generation feature moves to a
    // click on the portrait itself, gated the same way the old button was.
    const portraitBox = selection.querySelector(".unit-sheet-header .unit-portrait");
    const nativePortraitCapable = unit.portraitKind === "native" ||
      (!unit.portraitKind && nativePortraitState(unit) !== "unavailable");
    if (portraitBox && unitImagesEnabled && nativePortraitCapable) {
      portraitBox.classList.add("unit-portrait-clickable");
      // B159: the sheet header doubles as the framework drag handle; the clickable portrait is a
      // div (not a button), so it opts out of drag explicitly.
      portraitBox.setAttribute("data-pf-nodrag", "1");
      portraitBox.title = "Click to generate a portrait";
      portraitBox.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        generateUnitPortrait(unit);
      });
    }
    // B159 native parity: opening the sheet generates the unit's bust (once per unit per session),
    // exactly as native does -- visitors and merchants included. A failure keeps whatever the box
    // shows (composite sprite or glyph) and un-marks the unit so a later sheet open retries.
    if (portraitBox && shouldAutoGeneratePortrait(unit)) {
      const genId = Number(unit.id);
      __dfcPortraitAutoGenerated.add(genId);
      generateUnitPortrait(unit, { keepCurrent: true });
      if (nativePortraitState(unit) !== "ready")
        window.setTimeout(() => {
          if (nativePortraitState(unit) !== "ready") __dfcPortraitAutoGenerated.delete(genId);
        }, 15000);
    }
    // B32: warm the composite-sprite snapshot for units that just left the viewport.
    refreshUnitSpriteSnapshot();
    // B34: populate the Labor > Work details sub-tab (async, over /labor*).
    const wdBox = selection.querySelector("[data-unit-workdetails]");
    if (wdBox) loadUnitWorkDetails(unit, wdBox);
    const close = selection.querySelector("[data-unit-close]");
    if (close) {
      close.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        stopUnitSheetRefresh();   // B136: tear the live-refresh timer down on explicit close
        closeSelection();
        focusPage();
      });
    }
  }

  function unitDetailTabs(tab) {
    return ({
      Skills: ["Labor", "Combat", "Social", "Other skills", "Knowledge"],
      Personality: ["Traits", "Values", "Preferences", "Needs"],
      Thoughts: ["Recent thoughts", "Memories"],
      Labor: ["Work details", "Workshops", "Locations", "Work animals"],
      Health: ["Status", "Wounds", "Treatment", "History", "Description"],
      Military: ["Squad", "Uniform", "Kills"]
    }[tab] || []);
  }

  function classForUnitLine(tab, detail, line) {
    // Native assigns these hues while drawing the screen; English adjectives are not a color
    // source. Raw [C:] tokens and structured spans are handled elsewhere. Plain strings stay plain.
    return "";
  }

  // Native's empty state is ONE plain WHITE sentence at the top-left of the content frame -- never a
  // boxed row, never a centred card, never italic grey (matrix section 4 S1).
  function isNativePlainEmpty(tab, detail, line) {
    if (tab === "Personality") return line === "No personality information.";
    return ({
      Health: {
        Status: "No health problems",
        Wounds: "No evaluated wounds",
        Treatment: "No treatment scheduled",
        History: "No medical history"
      },
      Labor: {
        Workshops: "No dedicated workshop assignments",
        Locations: "No location assignments",
        "Work animals": "No assigned or assignable work animals"
      },
      Military: { Squad: "No squad assigned" }
    }[tab] || {})[detail] === line;
  }

  function renderUnitListGrid(tab, detail, lines) {
    const values = Array.isArray(lines) ? lines : [];
    // An empty tab is a native EMPTY STATE, and native draws it as ONE plain WHITE sentence at the
    // top-left of the content frame -- never a grey boxed row (matrix S1 section 2.1). So both a
    // recognised "No X" line AND a bare-empty array take the unboxed, un-chromed white treatment; a
    // zero-length array is no less empty than a one-line "No wounds", and rendering it as a grey
    // `.unit-list-empty` cell inside the still-drawn grid chassis was the one place this contract
    // broke (a boxed grey sentence where native has a plain white one).
    const plain = values.length === 0 ||
      (values.length === 1 && isNativePlainEmpty(tab, detail, values[0]));
    // Same chassis as the Overview body -- a single-column table whose GRID owns the dividers. The
    // rows used to draw `border-right/bottom` themselves, which stacked a frame inside the sheet's
    // frame inside the window's. A row states no border now; `.dwfui-grid` draws the shared hairline.
    // `.unit-list-row-unboxed` (#f2f2f2, no border) is native's plain white empty; it out-specifies
    // the grey `.unit-list-empty`, which is kept only as a semantic hook.
    const unboxed = plain ? " unit-list-empty unit-list-row-unboxed" : "";
    const rendered = values.length ? values.map(line => {
      const cls = classForUnitLine(tab, detail, line);
      return DWFUI.gridCellHtml({ cls: `unit-list-row${cls}${unboxed}` }, colorizeUnitLine(line, tab, detail));
    }).join("") : DWFUI.gridCellHtml({ cls: `unit-list-row${unboxed}` }, "No entries.");
    return DWFUI.gridHtml({ cls: `unit-list-grid${plain ? " unit-list-grid-unboxed" : ""}` }, rendered);
  }

  function structuredOrder(records) {
    return records.map((record, index) => ({ record, index })).sort((a, b) => {
      const ao = Number(a.record && a.record.order);
      const bo = Number(b.record && b.record.order);
      const av = Number.isFinite(ao) ? ao : a.index;
      const bv = Number.isFinite(bo) ? bo : b.index;
      return av - bv || a.index - b.index;
    }).map(entry => entry.record);
  }

  function relationColorClass(role) {
    const value = String(role || "friend").toLowerCase();
    return ["family", "deity", "friend"].includes(value) ? ` unit-relation-${value}` : " unit-relation-friend";
  }

  // WAVE 4 / S1 REPRESENTATIVE -- unit-profile/relations (oracle: Steam relations.png, 16 rows).
  //
  // The native row is the TABLE chassis (rowHtml chassis:'table'): NO slab, a diagonal cross-hatch
  // filling the rail from the end of the copy to the row end, and a 1px hairline separator. We
  // rendered it flat, with a hand-rolled div and a POSITION-INDICATOR EMOJI where native has two
  // gold-framed sprite tiles.
  //
  // *** OMIT, DO NOT BLANK. *** The deity row in the oracle has NO portrait tile and NO trailing
  // controls -- not empty ones, ABSENT ones. Same rule as steam rooms.png (the unassigned rooms have
  // nothing in the trailing column). An icon box drawn empty for a god is the failure this row
  // exists to prove we do not commit.
  function renderUnitRelations(unit) {
    if (!Array.isArray(unit && unit.relations))
      return renderUnitListGrid("Relations", null, unit && unit.relationLines);
    const S = (window.DWFUI && DWFUI.TOKENS && DWFUI.TOKENS.sprites) || {};
    const rows = structuredOrder(unit.relations).filter(relation => relation && relation.name).map(relation => {
      const uid = Number(relation.unitId);
      const live = Number.isInteger(uid) && uid >= 0;
      const deity = String(relation.colorRole || "").toLowerCase() === "deity";
      // Native's trailing PAIR: STOCKS_RECENTER + STOCKS_VIEW_ITEM (gold ring, gold frame, 24x36 --
      // NOT the grey-framed SQUADS_INSPECT; blit-proved in S1-unit-profile-evidence.md section 3.1).
      // Both are self-framed, so they take no generic button chassis.
      const trailing = live
        ? DWFUI.actionButtonsHtml([
          {
            action: "recenter", sprite: S.recenterStocks,
            dataset: { unitRelationRecenter: uid },
            title: `Center the view on ${relation.name}`,
          },
          {
            action: "view", sprite: S.view,
            dataset: { unitRelationOpen: uid },
            title: "Open this unit", ariaLabel: `Open ${relation.name}`,
          },
        ], { cls: "dwfui-actions unit-relation-actions", btnCls: "unit-structured-action" })
        : "";
      return DWFUI.rowHtml({
        chassis: "table",
        cls: `unit-structured-row unit-relation-row${deity ? " unit-relation-row-deity" : ""}`,
        icon: deity
          ? ""
          : `<div class="unit-structured-portrait">${unitPortraitMarkup(relation, "unit-relation-portrait")}</div>`,
        // Both vocabularies, on purpose: the DWFUI chassis classes carry native's copy layout and
        // type, the pinned unit-structured-* names carry the semantic colour roles (and the
        // charprofile suite's selectors). Dropping either one is a regression.
        copyCls: "dwfui-copy unit-structured-copy",
        labelCls: "dwfui-label unit-structured-line",
        labelHtml: `<span class="unit-relation-name${relationColorClass(relation.colorRole)}"${unitProfessionColorStyle(relation)}>` +
          `${DWFUI.bitmapTextHtml(relation.name || "")}</span>` +
          (relation.profession ? `<span class="unit-relation-profession">` +
            `${DWFUI.bitmapTextHtml(`, ${relation.profession}`)}</span>` : ""),
        sub: { cls: "dwfui-sub unit-structured-subline", text: relation.label || "Relation" },
        trailing,
      });
    }).join("");
    return `<div class="unit-structured-list unit-relations-list">${rows || `<div class="unit-structured-empty">No relationships recorded.</div>`}</div>`;
  }

  // WAVE-5 / R2: three hand-rolled divs became ONE rowHtml on the TABLE chassis (steam groups.png:
  // a two-line copy block on the left, a RIGHT-ALIGNED gold category word on the right). The
  // category is a `cells[]` entry, not a third div in the copy block -- it is a COLUMN, and the
  // grammar for a column is the row's cell list. The pinned unit-group-* class names ride through
  // the cfg hooks so the existing CSS and the charprofile suite keep resolving.
  function renderUnitGroups(unit) {
    if (!Array.isArray(unit && unit.groups))
      return renderUnitListGrid("Groups", null, unit && unit.groupLines);
    const rows = structuredOrder(unit.groups).filter(group => group && group.entityName).map(group =>
      DWFUI.rowHtml({
        chassis: "table",
        cls: "unit-structured-row unit-group-row",
        copyCls: "dwfui-copy unit-structured-copy",
        labelCls: "dwfui-label unit-group-name",
        label: group.entityName,
        sub: { cls: "dwfui-sub unit-group-status", text: group.status || "Member" },
        cells: [{ cls: "unit-group-category",
          html: DWFUI.bitmapTextHtml(group.category || "Group") }],
      })).join("");
    return `<div class="unit-structured-list unit-groups-list">${rows || `<div class="unit-structured-empty">No group memberships.</div>`}</div>`;
  }

  const UNIT_ROOM_CATEGORIES = ["Study", "Quarters", "Dining Room", "Tomb"];

  // B176: an ASSIGNED room is click-to-view -- the whole row plus a trailing zoom button
  // (TOKENS.glyphs.follow camera) jump the camera to the room and open its zone panel. The row is
  // built through the shared DWFUI layer (rowHtml + actionButtonsHtml) while keeping the pinned
  // unit-room-* class names and the data-unit-room-category slot that the CSS + charprofile suite
  // depend on. Only assigned rows carry the buildingId + center pos; unassigned "No X" rows stay
  // inert (there is no room to view). Camera zoom needs the server room center (centerX/Y/Z, added
  // on-demand to /unit); an older server without it still opens the zone panel (fail-open).
  function renderUnitRooms(unit) {
    if (!Array.isArray(unit && unit.rooms))
      return renderUnitListGrid("Rooms", null, unit && unit.roomLines);
    const byCategory = new Map(unit.rooms.filter(Boolean).map(room => [String(room.category || ""), room]));
    const rows = UNIT_ROOM_CATEGORIES.map(category => {
      const room = byCategory.get(category) || { category, assigned: false };
      const label = room.assigned ? (room.quality || room.name || category) : `No ${category}`;
      const bid = Number(room.buildingId ?? -1);
      const clickable = !!room.assigned && Number.isInteger(bid) && bid >= 0;
      const cx = Number(room.centerX), cy = Number(room.centerY), cz = Number(room.centerZ);
      const hasPos = Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz) && cx >= 0 && cy >= 0;
      const dataset = { unitRoomCategory: category };
      if (clickable) {
        dataset.unitRoomOpen = bid;
        if (hasPos) { dataset.roomX = cx; dataset.roomY = cy; dataset.roomZ = cz; }
      }
      // WAVE-5 / R3: the trailing tile used to fall through actionButtonsHtml's glyph path to
      // TOKENS.glyphs.follow -- the MOVIE-CAMERA EMOJI (codepoint 127909). The control's actual job is
      // "recenter the camera on this room (and open it)", which is exactly RECENTER_RECENTER, a real
      // interface_map token. Never an emoji where a sprite exists. The wire (data-unit-room-open) and
      // the pinned unit-structured-action / unit-room-actions class names are untouched.
      const trailing = clickable
        ? DWFUI.actionButtonsHtml(
            [{ action: "follow", sprite: DWFUI.TOKENS.sprites.recenter,
               dataset: { unitRoomOpen: bid }, title: "Zoom to this room and open it" }],
            { cls: "unit-room-actions", btnCls: "unit-structured-action" })
        : "";
      return DWFUI.rowHtml({
        cls: `unit-structured-row unit-room-row${room.assigned ? " assigned" : " unassigned"}${clickable ? " clickable" : ""}`,
        dataset,
        role: clickable ? "button" : undefined,
        title: clickable ? "View this room" : undefined,
        label,
        copyCls: "unit-structured-copy unit-room-copy",
        labelCls: "unit-room-name",
        trailing,
      });
    }).join("");
    return `<div class="unit-structured-list unit-rooms-list">${rows}</div>`;
  }

  // WAVE-5 / R2: the raw-div item row becomes rowHtml on the TABLE chassis.
  //
  // *** THE ASSIGNMENT-CLASS INDICATOR IS NOT RENDERED, AND THAT IS DELIBERATE. *** Native's Items
  // tab carries a grey-framed INVENTORY_ASSIGNED_{CLOTHING,TOOL,SQUAD,SYMBOL} tile stating what the
  // item is ASSIGNED AS. All four tokens exist in TOKENS.sprites -- but THE WIRE DOES NOT CARRY THE
  // FIELD. `UnitInventoryRecord` (src/unit_sheet.h:86) ships {item_id, role, body_part_id,
  // body_part_name, name, color_role, quality, wear} and nothing else; `role` is the BODY-SLOT role
  // ("Worn" / "Weapon" / "Carried"), NOT the assignment class. Deriving one from the other would be
  // fabricated UI wearing native art, so the cell is OMITTED (native omits; it never blanks) and the
  // gap is reported as WIRE-GAP-W5C-ITEMS. src/ is another writer's path this wave.
  function renderUnitInventory(unit) {
    if (!Array.isArray(unit && unit.inventory))
      return renderUnitListGrid("Items", null, unit && unit.inventoryLines);
    const rows = unit.inventory.filter(record => record && record.name).map(record =>
      DWFUI.rowHtml({
        chassis: "table",
        cls: "unit-structured-row unit-inventory-row",
        copyCls: "dwfui-copy unit-structured-copy",
        labelCls: "dwfui-label unit-inventory-name",
        label: `(${record.name})`,
        sub: { cls: "dwfui-sub unit-inventory-location",
          text: record.bodyPartName || record.role || "Carried" },
      })).join("");
    return `<div class="unit-structured-list unit-inventory-list">${rows || `<div class="unit-structured-empty">No inventory items.</div>`}</div>`;
  }

  function renderUnitTextLines(unit, tab, detail, lines) {
    // Native's empty here is the same plain sentence as everywhere else -- it inherits the block's
    // own body colour (`.unit-text-block` cream), NOT the grey `.unit-list-empty`. `unit-text-empty`
    // is a colourless semantic hook so the sentence reads as native body text, never a disabled grey.
    const rendered = lines.length ? lines.map(line =>
      `<p class="unit-text-line${classForUnitLine(tab, detail, line)}">${colorizeUnitLine(line, tab, detail)}</p>`
    ).join("") : `<p class="unit-text-line unit-text-empty">No entries.</p>`;
    return `<div class="unit-text-block">${rendered}</div>`;
  }

  function unitSpanClass(role) {
    const value = String(role || "neutral").toLowerCase();
    return ({
      positive: "positive", negative: "negative", warning: "warning", attention: "attention",
      "personal-positive": "personal-positive", "personal-negative": "personal-negative",
      dream: "dream", "emotion-positive": "emotion-positive", "emotion-negative": "emotion-negative",
      "emotion-neutral": "emotion-neutral", memory: "memory", form: "form", work: "work"
    })[value] || "neutral";
  }

  // TX (text-color spec §3.1/§3.4): a span may now carry a native curses color index (0..15) the
  // plugin resolved from the game -- emotion attr color, profession/skill color, or a [C:] token.
  // When present it is AUTHORITATIVE and drives hue via DWFUI.dfColor (the live palette); the role
  // class is kept only for weight/emphasis theming. When absent (older DLL), non-neutral roles
  // explicitly inherit their parent's colour so the legacy role CSS cannot invent a hue.
  function unitSpanColorStyle(span) {
    const idx = span && span.color;
    if (!Number.isInteger(idx) || idx < 0 || idx > 15)
      return unitSpanClass(span && span.role) === "neutral" ? "" : ' style="color:inherit"';
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }
  function unitProfessionColorStyle(record) {
    const idx = record && record.professionColor;
    // Native overrides dead relations to red, but that draw-code colour is not on this payload.
    // Do not incorrectly apply the deceased dwarf's old profession hue or the legacy role CSS.
    if ((record && record.dead) || !Number.isInteger(idx) || idx < 0 || idx > 15)
      return ' style="color:inherit"';
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }
  function renderUnitSpans(spans) {
    return (Array.isArray(spans) ? spans : []).map(span =>
      `<span class="unit-prose-${unitSpanClass(span && span.role)}"${unitSpanColorStyle(span)}>${escapeHtml(span && span.text || "")}</span>`
    ).join("");
  }

  function renderUnitProse(paragraphs, emptyText = "No entries.") {
    const values = Array.isArray(paragraphs) ? paragraphs : [];
    const rendered = values.map(paragraph => {
      const spans = paragraph && Array.isArray(paragraph.spans) ? paragraph.spans : [];
      return spans.length ? `<p class="unit-prose-paragraph">${renderUnitSpans(spans)}</p>` : "";
    }).join("");
    // Empty Thoughts / Personality is a native EMPTY STATE: one plain WHITE sentence (matrix S1
    // section 2.1). It inherits `.unit-prose-block`'s #f2f2f2, so it must NOT carry the grey
    // `.unit-list-empty`; `unit-prose-empty` is a colourless hook that leaves it native-white.
    return `<div class="unit-prose-block">${rendered || `<p class="unit-prose-paragraph unit-prose-empty">${escapeHtml(emptyText)}</p>`}</div>`;
  }

  // WAVE-5 / R3 + the INERT-CONTROL ruling.
  //
  // *** THE ROW BODIES HERE ARE **NOT** MIGRATED TO rowHtml, AND THE REASON IS A GATE I DO NOT OWN.
  // tools/harness/charprofile_p2_test.mjs pins the EXACT HAND-BUILT ADJACENCY of both families:
  //     /Competent Woodcutter<\/span>\s*<span class="unit-skill-rust"> \(Rusty\)/      (:66)
  //     /unit-knowledge-subtype unit-prose-form">Poetic form/                          (:77-78)
  // Both require the copy to sit as a BARE TEXT NODE immediately after its class attribute, with no
  // intervening wrapper. rowHtml necessarily emits `.dwfui-copy` > `.dwfui-label` > `.dwfui-bitmap-text`
  // (bitmap text is the DEFAULT, and that is the whole point of the chassis), and its `cells[]` always
  // prefix `dwfui-cell`. So the assertion and the component layer are structurally incompatible: the
  // rows CANNOT be migrated without editing that test, and charprofile_p2_test.mjs is NOT one of this
  // lane's owned paths. Weakening someone else's gate to bless my own output is exactly the move this
  // programme forbids. The migration is therefore LEFT UNDONE and handed back -- see
  // BLOCKER-W5C-P2-PIN in the closeout. It is a one-line unblock for whoever owns that suite.
  //
  // What IS done here is the part that needs no structural change:
  //
  // THE KNOWLEDGE MAGNIFIER IS A DEAD AFFORDANCE, AND IT IS NOW HONEST ABOUT IT. It emitted a
  // hand-rolled BUTTON element carrying a MAGNIFIER EMOJI (codepoint 128269) and
  // `data-unit-knowledge-detail`.
  // Three-step proof, run 2026-07-12:
  //   1. grep -rn "unit-knowledge-detail" web/js/  -> 1 hit: THE MARKUP ITSELF. No listener.
  //   2. grep -rni "knowledge" src/               -> the /unit knowledge RECORDS only. No route.
  //   3. no route + no listener => NOT a wired capability. It is a button that does nothing.
  // Per the standing instruction on unverified controls ("use placeholder buttons that show a
  // hoverstate of asking what it does"), it is PRESERVED (deleting a visible affordance is the
  // deletion this programme keeps getting wrong) and rendered as an explicit placeholder on the real
  // native sprite (STOCKS_VIEW_ITEM), with a tooltip that says what is missing rather than inventing
  // behaviour. The data-attribute is kept verbatim so the day a /knowledge-detail route lands, the
  // wire is already there. Logged as INERT-W5C-KNOWLEDGE.
  function renderUnitSkills(unit, detail) {
    if (detail === "Knowledge") {
      if (!Array.isArray(unit && unit.knowledge))
        return renderUnitListGrid("Skills", detail, []);
      const rows = structuredOrder(unit.knowledge).filter(record => record && record.title).map(record => `
        <div class="unit-knowledge-row">
          <div class="unit-knowledge-copy">
            <div class="unit-knowledge-title">${escapeHtml(record.title)}</div>
            <div class="unit-knowledge-subtype unit-prose-${unitSpanClass(record.colorRole)}">${escapeHtml(record.subtype || "Knowledge")}</div>
          </div>
          ${DWFUI.artBtnHtml({
            sprite: DWFUI.TOKENS.sprites.view, cls: "unit-knowledge-action", placeholder: true,
            dataset: { unitKnowledgeDetail: record.detailTarget || `${record.type || "knowledge"}:${record.id}` },
            title: "Knowledge details are not implemented yet -- no server route exists for this " +
              "record. The control is kept so the wire is ready; it does nothing today.",
            ariaLabel: `View ${record.title}`,
          })}
        </div>`).join("");
      return `<div class="unit-knowledge-list">${rows || `<div class="unit-structured-empty">No knowledge recorded.</div>`}</div>`;
    }
    if (!Array.isArray(unit && unit.skills)) {
      const legacy = detail === "Labor" ? unit && unit.skillLines : [];
      return renderUnitListGrid("Skills", detail, legacy);
    }
    // BLOCKER-W5C-P2-PIN (see above): charprofile_p2_test.mjs:66 pins `caption</span> <span
    // class="unit-skill-rust">`, an adjacency rowHtml's copy block cannot produce. Left hand-built.
    const rows = structuredOrder(unit.skills).filter(skill => skill && skill.category === detail).map(skill => `
      <div class="unit-skill-row unit-skill-${escapeHtml(skill.colorRole || "skill-0")}">
        <span class="unit-skill-caption"${skillCaptionColorStyle(skill)}>${escapeHtml(`${skill.ratingCaption || "Dabbling"} ${skill.caption || "Skill"}`)}</span>
        ${skill.rusty ? `<span class="unit-skill-rust"> (Rusty)</span>` : ""}
      </div>`).join("");
    return `<div class="unit-skill-list">${rows || `<div class="unit-structured-empty">No ${escapeHtml(detail || "notable").toLowerCase()} skills.</div>`}</div>`;
  }

  // TX (text-color spec §2.5): a skill row is colored by the SKILL's profession color, which the
  // plugin resolves and ships as `skill.color` (0..15). Authoritative for hue via the live palette;
  // the unit-skill-<colorRole> class is kept for structure/back-compat. Absent (old DLL) -> plain.
  function skillCaptionColorStyle(skill) {
    const idx = skill && skill.color;
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) return "";
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }

  function renderUnitPersonality(unit, detail) {
    const narrative = unit && unit.personalityNarrative;
    const key = String(detail || "Traits").toLowerCase();
    if (!narrative || !Array.isArray(narrative[key]))
      return null;
    return renderUnitProse(narrative[key], `No ${key} recorded.`);
  }

  function renderUnitThoughts(unit, detail) {
    const thoughts = unit && unit.thoughts;
    if (!thoughts || typeof thoughts !== "object")
      return null;
    const key = detail === "Memories" ? "memories" : "recent";
    const records = Array.isArray(thoughts[key]) ? structuredOrder(thoughts[key]) : [];
    const paragraphs = records.map(record => ({ spans: Array.isArray(record && record.spans) ? record.spans : [] }));
    return renderUnitProse(paragraphs, key === "memories" ? "No memories recorded." : "No recent thoughts recorded.");
  }

  // B34: the individual dwarf's Labor > "Work details" sub-tab. Steam shows the full fortress
  // work-detail list with a per-detail membership checkbox (this unit in that detail's roster) and
  // a "Will do available tasks anywhere" header (the only-do-assigned-jobs / specialist toggle).
  // Fully client-side over the already-deployed /labor* endpoints: /labor gives the detail list +
  // every citizen row (each row's assignedTo is that unit's authoritative membership string, built
  // server-side from the same binary_search over each detail's assigned_units), /labor-toggle
  // round-trips a single membership change, /labor-specialist round-trips the header toggle.
  function renderUnitWorkDetailsTab(unit, detail = "Work details") {
    const uid = Number(unit && (unit.id ?? unit.unitId ?? -1));
    return `<div class="unit-workdetails" data-unit-workdetails="${escapeHtml(uid)}" data-unit-labor-detail="${escapeHtml(detail)}">` +
      `<div class="unit-list-row unit-list-empty">Loading work details&#8230;</div></div>`;
  }

  let unitLaborSnapshot = null;
  let unitLaborSnapshotPromise = null;

  async function fetchUnitLaborSnapshot() {
    if (unitLaborSnapshot) return unitLaborSnapshot;
    if (!unitLaborSnapshotPromise) {
      unitLaborSnapshotPromise = fetch(`/labor?detail=0&t=${Date.now()}`, { cache: "no-store" })
        .then(r => {
          if (!r.ok) throw new Error("labor fetch failed");
          return r.json();
        })
        .then(data => (unitLaborSnapshot = data))
        .finally(() => { unitLaborSnapshotPromise = null; });
    }
    return unitLaborSnapshotPromise;
  }

  async function loadUnitWorkDetails(unit, box) {
    if (!box) return;
    const uid = Number(unit && (unit.id ?? unit.unitId ?? -1));
    if (!Number.isFinite(uid) || uid < 0) {
      box.innerHTML = `<div class="unit-list-row unit-list-empty">No unit selected.</div>`;
      return;
    }
    try {
      renderUnitWorkDetails(unit, box, await fetchUnitLaborSnapshot());
    } catch (_) {
      box.innerHTML = `<div class="unit-list-row unit-list-empty">Work details unavailable.</div>`;
    }
  }

  // WAVE-5 / R2 + the CHECK invariant. The membership mark rendered `&#10003;` when ON and
  // *** LITERALLY NOTHING WHEN OFF ***. Native never renders nothing: its checkbox is a COMPLETE
  // 32x36 sprite in BOTH states (SQUADS_SELECTED / SQUADS_NOT_SELECTED -- the pair DF itself aliases
  // as EMBARK_{,NOT_}SELECTED and WORK_ORDERS_ADJECTIVE_{,NOT_}SELECTED, blit-verified against
  // `steam labor work details.png`). So an UNCHECKED detail now draws the real dark tile.
  //
  // The check is a CELL of the table row, not a third hand-rolled span. The row keeps
  // data-unit-wd-toggle / data-on and the .unit-wd-check class the click handler pokes; the nested
  // check BUTTON carries no dataset of its own, so a click on it bubbles to the row's single
  // handler and dispatches exactly one /labor-toggle -- the wire is unchanged.
  function unitWorkDetailCheckHtml(checked) {
    return DWFUI.checkHtml({ checked, cls: "unit-wd-check-tile", ariaLabel: checked ? "Assigned" : "Not assigned" });
  }
  function unitWorkDetailRow(d, checked) {
    const icon = (typeof laborIconMarkup === "function")
      ? (laborIconMarkup(d.iconKey, "unit-wd-icon", 28) || `<span class="unit-wd-icon-blank"></span>`)
      : `<span class="unit-wd-icon-blank"></span>`;
    return DWFUI.rowHtml({
      chassis: "table",
      cls: `unit-wd-row${checked ? " on" : ""}`,
      dataset: { unitWdToggle: Number(d.index), on: checked ? 1 : 0 },
      title: `Toggle this dwarf's membership in the ${d.name} work detail`,
      icon: `<span class="unit-wd-icon-slot">${icon}</span>`,
      copyCls: "dwfui-copy unit-wd-copy",
      labelCls: "dwfui-label unit-wd-name",
      label: d.name,
      cells: [{ cls: `unit-wd-check${checked ? " on" : ""}`, html: unitWorkDetailCheckHtml(checked) }],
    });
  }

  // ---- PB-03: THE SPECIALIZATION LATCH -----------------------------------------------------------
  // The Wave-5 matrix says of this control: "it does not exist in our client at all." *** THAT IS
  // WRONG FOR THE UNIT PROFILE. *** It exists, it is wired (data-unit-wd-spec -> POST
  // /labor-specialist), and it is correctly SHARED by all four Labor subtabs. What it did NOT have
  // was native ART: it was a text row with an empty CSS span (.unit-wd-anywhere-icon) standing in
  // for the icon, and a permanently-empty .unit-wd-check cell pretending to be a checkbox.
  //
  // It is not a CHECK -- its two states are TWO DIFFERENT ICONS saying two different things, which
  // is the exact line DWFUI draws between checkHtml and latchHtml:
  //     WORKER_DO_ANY_AVAILABLE_JOB   (GREEN) "Will do available tasks anywhere"   <- specialist OFF
  //     WORKER_ONLY_DO_ASSIGNED_JOBS  (RED)   "Will not do tasks unless assigned"  <- specialist ON
  // Both tokens are real interface_map records and both are in SELF_FRAMED_SPRITES, so the latch
  // takes NO generic button chassis.
  //
  // The Ctrl+z hotkey is passed HERE AND NOWHERE ELSE in this file: it is the one hotkey native
  // attests for a control we render (`residents specialty.png`). Never fabricate a Hotkey: line.
  const UNIT_SPECIALIST_TEXT = {
    on: "Will not do tasks unless assigned",
    off: "Will do available tasks anywhere",
  };
  function unitSpecialistText(specialist) {
    return specialist ? UNIT_SPECIALIST_TEXT.on : UNIT_SPECIALIST_TEXT.off;
  }
  function unitSpecialistLatchHtml(specialist) {
    const S = (window.DWFUI && DWFUI.TOKENS && DWFUI.TOKENS.sprites) || {};
    return DWFUI.latchHtml({
      on: !!specialist,
      cls: "unit-wd-anywhere-icon",
      sprite: S.workerAny,          // OFF -> the green "will work anywhere" tile
      activeSprite: S.workerOnly,   // ON  -> the red "only assigned jobs" tile
      hotkey: "Ctrl+z",
      title: unitSpecialistText(specialist),
      ariaLabel: unitSpecialistText(specialist),
    });
  }

  function renderUnitLaborAnimals(unit) {
    const animals = Array.isArray(unit && unit.laborWorkAnimals) ? structuredOrder(unit.laborWorkAnimals) : null;
    if (animals === null)
      return renderUnitListGrid("Labor", "Work animals", unit && unit.laborWorkAnimalLines);
    // WAVE-5 / R2: the sixth raw-div row family in this file, on the same TABLE chassis as Relations
    // (same anatomy: portrait tile + two-line copy + a right-aligned state word, which is a COLUMN
    // and therefore a `cells[]` entry). The pinned unit-labor-animal-* / unit-structured-* names ride
    // through the cfg hooks. NOTE: this is one of the eight `assumed-not-oracle` states -- every
    // capture we hold of it is EMPTY -- so its LAYOUT is inferred from the evidenced states, not read
    // off an oracle. See BLOCKER-W5C-FLAG in the closeout: this lane cannot raise that flag, because
    // the flag lives in tools/ui-lab/stories.js, which it does not own.
    // B233-2: the rows are now ACTIONABLE. Each carries the assign/remove plaque native's
    // AssignWorkAnimal screen carries (INFO_ASSIGN_WORK_ANIMAL / "Remove assignment"), driven by
    // POST /livestock-action?action=assign-work-animal&owner=<this citizen>. The server sends
    // `assignable` + `blockedReason` per animal and the button follows them EXACTLY -- when the
    // write cannot be grounded for that animal (a historical-figure animal, whose ownership DF also
    // records in the history graph), the row shows the reason instead of a button that would 400.
    const uid = Number(unit && (unit.id ?? unit.unitId ?? -1));
    const rows = animals.filter(animal => animal && animal.name).map(animal => {
      const assigned = animal.assignmentState === "assigned";
      const blocked = !animal.assignable && !!animal.blockedReason;
      const action = blocked
        ? `<span class="unit-labor-animal-blocked" title="${DWFUI.esc(animal.blockedReason)}">${DWFUI.bitmapTextHtml("Locked")}</span>`
        : DWFUI.plaqueBtnHtml({
            label: assigned ? "Remove" : "Assign",
            tone: assigned ? "red" : "green",
            chassis: "slab",
            cls: "unit-labor-animal-btn",
            dataset: { unitWorkAnimal: animal.unitId, unitWorkAnimalOwner: assigned ? -1 : uid },
            title: assigned
              ? "Remove this work-animal assignment"
              : "Assign this animal as this citizen's work animal",
          });
      return DWFUI.rowHtml({
        chassis: "table",
        cls: `unit-structured-row unit-labor-animal-row ${assigned ? "assigned" : "assignable"}${blocked ? " blocked" : ""}`,
        icon: `<div class="unit-structured-portrait">${unitPortraitMarkup(animal, "unit-relation-portrait")}</div>`,
        copyCls: "dwfui-copy unit-structured-copy",
        labelCls: "dwfui-label unit-structured-line unit-labor-animal-name",
        label: animal.name,
        sub: { cls: "dwfui-sub unit-structured-subline", text: animal.trainingType || "Animal training" },
        cells: [
          { cls: "unit-labor-animal-state",
            html: DWFUI.bitmapTextHtml(assigned ? "Assigned" : (blocked ? "Blocked" : "Assignable")) },
          { cls: "unit-labor-animal-action", html: action },
        ],
      });
    }).join("");
    const status = `<div id="unitWorkAnimalStatus" class="unit-labor-animal-status" role="status" aria-live="polite"></div>`;
    return rows ? `<div class="unit-structured-list unit-labor-animal-list">${rows}${status}</div>` :
      renderUnitListGrid("Labor", "Work animals", ["No assigned or assignable work animals"]);
  }

  function renderUnitLaborPanel(unit, detail, data) {
    const uid = Number(unit && (unit.id ?? unit.unitId ?? -1));
    const details = Array.isArray(data && data.details) ? data.details : [];
    const rows = Array.isArray(data && data.rows) ? data.rows : [];
    const myRow = rows.find(r => Number(r.id) === uid) || null;
    if (!myRow)
      return `<div class="unit-list-row unit-list-empty">Only fortress citizens can be assigned work details.</div>`;
    const membership = new Set(String(myRow.assignedTo || "").split(", ").map(s => s.trim()).filter(Boolean));
    const specialist = !!myRow.specialist;
    const headText = unitSpecialistText(specialist);
    const headRow = DWFUI.rowHtml({
      chassis: "table",
      cls: `unit-wd-row unit-wd-header${specialist ? " specialist" : ""}`,
      dataset: { unitWdSpec: uid, on: specialist ? 1 : 0 },
      title: "Toggle whether this dwarf only works its assigned work details",
      icon: `<span class="unit-wd-icon-slot">${unitSpecialistLatchHtml(specialist)}</span>`,
      copyCls: "dwfui-copy unit-wd-copy",
      labelCls: "dwfui-label unit-wd-name",
      label: headText,
    });
    let body;
    if (detail === "Work details") {
      const list = details.map(d => unitWorkDetailRow(d, membership.has(d.name))).join("");
      body = list || `<div class="unit-list-row unit-list-empty">No work details defined.</div>`;
    } else if (detail === "Work animals") {
      body = renderUnitLaborAnimals(unit);
    } else {
      const laborLines = {
        Workshops: unit.laborWorkshopLines,
        Locations: unit.laborLocationLines
      }[detail];
      body = renderUnitListGrid("Labor", detail, laborLines);
    }
    return `<div class="unit-wd-list">${headRow}${body}</div>`;
  }

  function renderUnitWorkDetails(unit, box, data) {
    const detail = box.dataset.unitLaborDetail || "Work details";
    box.innerHTML = renderUnitLaborPanel(unit, detail, data);
    wireUnitWorkDetails(unit, box);
  }

  function wireUnitWorkDetails(unit, box) {
    const uid = Number(unit && (unit.id ?? unit.unitId ?? -1));

    // B233-2: Labor > Work animals assign/remove. One route, one field
    // (unit.relationship_ids[PetOwner] on the ANIMAL -- see src/info_panel.cpp). The sheet is
    // re-fetched on success so the row moves between the assigned/assignable groups the way the
    // server sorted them, rather than the client inventing the new order.
    box.querySelectorAll("[data-unit-work-animal]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.busy === "1") return;
        const animalId = Number(button.dataset.unitWorkAnimal);
        const ownerId = Number(button.dataset.unitWorkAnimalOwner);
        const status = box.querySelector("#unitWorkAnimalStatus");
        button.dataset.busy = "1";
        button.disabled = true;
        try {
          const r = await fetch(
            `/livestock-action?unit=${animalId}&action=assign-work-animal&owner=${ownerId}&t=${Date.now()}`,
            { method: "POST", cache: "no-store" });
          const data = await r.json().catch(() => null);
          if (!r.ok || !data || data.ok === false)
            throw new Error((data && data.error) || "assignment failed");
          if (status) status.textContent = ownerId < 0 ? "Work animal removed." : "Work animal assigned.";
          // Re-read the truth through the sheet's OWN live-refresh path (B136) -- never guess the
          // new list. unitSheetRefreshTick re-fetches /unit and re-renders, preserving tab+scroll.
          unitSheetRefreshId = uid;
          await unitSheetRefreshTick();
        } catch (err) {
          if (status) status.textContent = (err && err.message) || "Could not change the work-animal assignment.";
          button.disabled = false;
          if (typeof flashStatus === "function") flashStatus("Could not change the work-animal assignment.");
        } finally {
          button.dataset.busy = "";
        }
      });
    });

    box.querySelectorAll("[data-unit-wd-toggle]").forEach(row => {
      row.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (row.dataset.busy === "1") return;
        const detail = Number(row.dataset.unitWdToggle);
        const on = row.dataset.on === "1" ? 0 : 1;
        row.dataset.busy = "1";
        try {
          const r = await fetch(`/labor-toggle?detail=${detail}&unit=${uid}&on=${on}`, { method: "POST", cache: "no-store" });
          if (!r.ok) throw new Error("toggle failed");
          unitLaborSnapshot = null;
          row.dataset.on = String(on);
          row.classList.toggle("on", !!on);
          // The optimistic repaint rebuilds the check through the SAME builder the row was rendered
          // with, so the OFF state draws the real SQUADS_NOT_SELECTED tile instead of blanking the
          // cell (the old `check.innerHTML = ""`). The route, the key and the state are unchanged.
          const check = row.querySelector(".unit-wd-check");
          if (check) { check.classList.toggle("on", !!on); check.innerHTML = unitWorkDetailCheckHtml(!!on); }
        } catch (_) {
          if (typeof flashStatus === "function") flashStatus("Could not update work detail.");
        } finally {
          row.dataset.busy = "";
        }
      });
    });
    const head = box.querySelector("[data-unit-wd-spec]");
    if (head) {
      head.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (head.dataset.busy === "1") return;
        const on = head.dataset.on === "1" ? 0 : 1;
        head.dataset.busy = "1";
        try {
          const r = await fetch(`/labor-specialist?unit=${uid}&on=${on}`, { method: "POST", cache: "no-store" });
          if (!r.ok) throw new Error("specialist failed");
          unitLaborSnapshot = null;
          head.dataset.on = String(on);
          head.classList.toggle("specialist", !!on);
          // Optimistic repaint through the builders. `name.textContent = ...` would have DESTROYED
          // the bitmap-text span the label now renders into, so the label is rebuilt, and the LATCH
          // is re-rendered so its sprite flips green <-> red with the state it just wrote.
          const name = head.querySelector(".unit-wd-name");
          if (name) name.innerHTML = DWFUI.bitmapTextHtml(unitSpecialistText(!!on));
          const slot = head.querySelector(".unit-wd-icon-slot");
          if (slot) slot.innerHTML = unitSpecialistLatchHtml(!!on);
          head.title = "Toggle whether this dwarf only works its assigned work details";
        } catch (_) {
          if (typeof flashStatus === "function") flashStatus("Could not update work preference.");
        } finally {
          head.dataset.busy = "";
        }
      });
    }
  }

  function renderUnitTabBody(unit, tab, detail) {
    if (tab === "Labor")
      return renderUnitWorkDetailsTab(unit, detail || "Work details");
    if (tab === "Relations") return renderUnitRelations(unit);
    if (tab === "Groups") return renderUnitGroups(unit);
    if (tab === "Rooms") return renderUnitRooms(unit);
    if (tab === "Items") return renderUnitInventory(unit);
    if (tab === "Skills") return renderUnitSkills(unit, detail || "Labor");
    if (tab === "Thoughts") {
      const structured = renderUnitThoughts(unit, detail || "Recent thoughts");
      if (structured !== null) return structured;
    }
    // WAVE 4 / S1: native's Personality is FOUR PROSE screens. The numeric rows ("Merriment: 4 /
    // Nature: -6") are the exact rendering the owner rejected -- and until now they were still armed as a
    // SILENT FALLBACK: renderUnitPersonality returns null whenever personalityNarrative is missing
    // (an older plugin, a /unit error, a legacy fixture), and the tab degraded straight back to them
    // with no marker. The fallback is gone; a missing narrative is now an explicit native empty
    // state. NOTE the scope: only the PERSONALITY branch dies. renderUnitListGrid and the rest of
    // the map are the ONLY renderer for Health (5 subtabs) and Military (3) -- deleting them blanks
    // 8 of the 24 profile states.
    if (tab === "Personality") {
      const structured = renderUnitPersonality(unit, detail || "Traits");
      return structured !== null
        ? structured
        : renderUnitListGrid("Personality", detail, ["No personality information."]);
    }
    const map = {
      Thoughts: unit.thoughtLines,
      Skills: unit.skillLines,
      Health: {
        Status: unit.healthStatusLines,
        Wounds: unit.healthWoundLines,
        Treatment: unit.healthTreatmentLines,
        History: unit.healthHistoryLines,
        Description: unit.healthDescriptionLines
      }[detail] || unit.healthLines,
      Labor: {
        "Work details": unit.laborWorkDetailLines,
        Workshops: unit.laborWorkshopLines,
        Locations: unit.laborLocationLines,
        "Work animals": unit.laborWorkAnimalLines
      }[detail] || unit.laborLines,
      Military: {
        Squad: unit.militarySquadLines,
        Uniform: unit.militaryUniformLines,
        Kills: unit.militaryKillLines
      }[detail] || unit.militaryLines
    };
    const lines = Array.isArray(map[tab]) ? map[tab] : [];
    if (tab === "Health" && detail === "Description")
      return renderUnitTextLines(unit, tab, detail, lines);
    return renderUnitListGrid(tab, detail, lines);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  function ordinal(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    switch (n % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  }

  async function loadHud() {
    try {
      const response = await fetch(`/hud?player=${encodeURIComponent(player)}&t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("hud failed");
      currentHud = await response.json();
      renderHud(currentHud);
      renderZoneOverlay();
    } catch (_) {}
  }

  // While the host is placing dig/build/chop orders, the plugin holds the last
  // independent frame (it can't safely re-render the map mid-interaction). Show a
  // clear banner so remote players know why their view paused, instead of a silent freeze.
  function showHostBusyBanner(show) {
    let el = document.getElementById("hostBusyBanner");
    if (!el) {
      el = document.createElement("div");
      el.id = "hostBusyBanner";
      el.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;" +
        "display:none;align-items:center;gap:9px;padding:9px 18px;color:#ffe9b0;background:rgba(21,21,21,0.94);" +
        "box-shadow:0 0 0 2px #d89b27 inset,0 4px 18px rgba(0,0,0,0.5);font:700 14px ui-monospace,Consolas,monospace;" +
        "letter-spacing:0.2px;pointer-events:none;";
      el.innerHTML = '<span style="width:9px;height:9px;border-radius:50%;background:#ffb12e;' +
        'box-shadow:0 0 7px #ffb12e;animation:hbbPulse 1s ease-in-out infinite;"></span>' +
        'Paused: Host is setting dig orders &mdash; please wait';
      document.body.appendChild(el);
      if (!document.getElementById("hbbStyle")) {
        const st = document.createElement("style");
        st.id = "hbbStyle";
        st.textContent = "@keyframes hbbPulse{0%,100%{opacity:1}50%{opacity:0.3}}";
        document.head.appendChild(st);
      }
    }
    el.style.display = show ? "flex" : "none";
  }

  const moodCounts = Array.from(document.querySelectorAll("#moods .mood-n"));
  function renderHud(hud) {
    showHostBusyBanner(!!hud.hostInteracting);
    // Shade whichever of pause (Ã¢ÂÅ¡Ã¢ÂÅ¡) / play (Ã¢â€“Â¶) matches the current game state, so it's obvious.
    const isPaused = !!hud.paused;
    // WD-5: pause/play now live inside #topbar (the old #pauseRow was merged in).
    const pauseBtn = document.querySelector('#topbar [data-action="pause"]');
    const playBtn = document.querySelector('#topbar [data-action="play"]');
    if (pauseBtn) pauseBtn.classList.toggle("sb-active", isPaused);
    if (playBtn) playBtn.classList.toggle("sb-active", !isPaused);
    if (typeof window.DFRefreshPauseIcons === "function") window.DFRefreshPauseIcons(isPaused);
    // B206 PAUSE-ANIM: seed/track the world animation clock from the SERVER's hud.paused (the
    // /hud poll reads DF's real pause state) so world animations freeze even against an old DLL
    // with no WP-B broadcast, and before the first broadcast arrives. Once broadcasts are flowing
    // they own the clock (immediate + carries who/why), same ownership handoff as the lobby line.
    try {
      if (window.DFAnimClock && !window.__dfPauseByBroadcast) window.DFAnimClock.setPaused(isPaused);
    } catch (_) {}
    // WT03(a): feed the lobby's pause line. WP-A shows a plain Running/Paused from hud.paused;
    // WP-B's {"type":"pause"} broadcast overrides this with "Paused by <actor>".
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
      el.parentElement.style.opacity = n ? "1" : "0.3";
    });
    // WD-5: Food/Drink/Seeds/Meat/Fish -- DF dims "None" (0) and brightens an actual
    // approximate reading (e.g. "~80"), per 00-base-map.png's stock-counts strip.
    const setStock = (el, n) => {
      if (!el) return;
      const count = Number(n) || 0;
      el.textContent = `~${count}`;
      el.classList.toggle("has-value", count > 0);
    };
    setStock(hudEls.food, hud.stocks?.food);
    setStock(hudEls.drink, hud.stocks?.drink);
    setStock(hudEls.seeds, hud.stocks?.seeds);
    setStock(hudEls.meat, hud.stocks?.meat);
    setStock(hudEls.fish, hud.stocks?.fish);
    hudEls.dateDay.textContent = ordinal(hud.date?.day || 1);
    hudEls.dateMonth.textContent = hud.date?.monthName || "Granite";
    hudEls.dateSeason.textContent = hud.date?.season || "Early Spring";
    hudEls.dateYear.textContent = hud.date?.year ?? 0;
    hudEls.elevation.textContent = `Elevation ${hud.elevation ?? 0}`;
    // WD-5: the "weather block" is the same moon_weather.png strip the moon icon always
    // used -- DF overrides the moon-phase cell with the Rain/Snow cell (indices 8/9) while
    // precipitating, per the interface map (MOON_* 0-7, then SNOW=8, RAIN=9).
    const moonIcon = Math.max(0, Math.min(7, Number(hud.date?.moonIcon ?? 0)));
    const weatherIcon = hud.weather === "Rain" ? 9 : hud.weather === "Snow" ? 8 : moonIcon;
    hudEls.moon.style.backgroundPosition = `-${weatherIcon * 32}px 0`;
    hudEls.moon.title = `Weather: ${hud.weather || "Clear"}`;
    // B86 (friend report: "no weather indicator like the steam version"): the moon strip already
    // swaps to the rain/snow cell while precipitating, but that alone was easy to miss. Add a small
    // always-on text readout next to it, styled to match the HUD -- dimmed for Clear, lit for
    // active precipitation. Created lazily (index.html is frozen for this wave) and reused after.
    let weatherLabel = document.getElementById("weatherLabel");
    if (!weatherLabel && hudEls.moon && hudEls.moon.parentNode) {
      weatherLabel = document.createElement("div");
      weatherLabel.id = "weatherLabel";
      weatherLabel.className = "weather-label";
      hudEls.moon.parentNode.insertBefore(weatherLabel, hudEls.moon.nextSibling);
    }
    if (weatherLabel) {
      const weatherName = hud.weather || "Clear";
      weatherLabel.textContent = weatherName;
      weatherLabel.classList.toggle("weather-active", weatherName === "Rain" || weatherName === "Snow");
    }
    renderMinimap(hud);
    if (typeof renderZScrollbar === "function") renderZScrollbar(hud);
  }

  // Minimap category colors (indices 0..14 match the backend minimap_color_for_tile buckets:
  // 0 soil 1 sand 2 rockFloor 3 darkFloor 4 stoneWall 5 conFloor 6 built 7 water 8 magma
  // 9 grass 10 trees 11 dryGrass 12 ice 13 mountain 14 sky).
  const MM_COLORS = ["#7a5a32","#c8803c","#6b6b6b","#3a3a3a","#4a4640","#8a8270","#b0a080",
    "#3b6fd4","#d8401a","#4f9a3a","#2f6b27","#9b8b3a","#e8f0f8","#9a948c","#14171c"];
  function mmDecode(ch) {
    if (ch >= 48 && ch <= 57) return ch - 48;      // '0'..'9'
    if (ch >= 97 && ch <= 101) return 10 + ch - 97; // 'a'..'e'
    return 14;
  }
  // WT05 perf gate (spec §7.1 cadence note): the terrain fill (96x96 = ~9.2k fillRects)
  // measured 3.36ms/repaint at the map size -- over the spec's 2ms threshold for the new
  // 2 Hz roster-driven redraws -- so the terrain layer is cached to an offscreen canvas
  // keyed on (dims + cells string) and the box/label passes composite over it. A repaint
  // with unchanged terrain is one drawImage + a few strokes; the terrain re-renders only
  // when /hud delivers different minimap cells (at most 1/s).
  let mmTerrainCanvas = null, mmTerrainKey = "";
  function renderMinimap(hud) {
    const mm = hud.minimap || {};
    const W = Math.max(1, mm.w | 0), H = Math.max(1, mm.h | 0);
    const cells = typeof mm.cells === "string" ? mm.cells : "";
    const cv = hudEls.minimap;
    if (!cv || !cv.getContext) return;
    // Aspect-correct: fixed display width, height follows the map aspect.
    const dispW = 164, dispH = Math.max(24, Math.round(dispW * H / W));
    if (cv.width !== dispW || cv.height !== dispH) { cv.width = dispW; cv.height = dispH; }
    cv.style.height = dispH + "px";
    const ctx = cv.getContext("2d");
    const terrainKey = dispW + "x" + dispH + ":" + cells;   // 9k-char compare ≈ µs vs 3.4ms repaint
    if (!mmTerrainCanvas || mmTerrainKey !== terrainKey) {
      if (!mmTerrainCanvas) mmTerrainCanvas = document.createElement("canvas");
      if (mmTerrainCanvas.width !== dispW || mmTerrainCanvas.height !== dispH) {
        mmTerrainCanvas.width = dispW; mmTerrainCanvas.height = dispH;
      }
      const tctx = mmTerrainCanvas.getContext("2d");
      const cw = dispW / W, ch = dispH / H;
      tctx.fillStyle = "#1b1b1b";
      tctx.fillRect(0, 0, dispW, dispH);
      for (let gy = 0; gy < H; gy++) {
        for (let gx = 0; gx < W; gx++) {
          const c = mmDecode(cells.charCodeAt(gy * W + gx));
          tctx.fillStyle = MM_COLORS[c] || "#1b1b1b";
          tctx.fillRect(Math.floor(gx * cw), Math.floor(gy * ch), Math.ceil(cw), Math.ceil(ch));
        }
      }
      mmTerrainKey = terrainKey;
    }
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.drawImage(mmTerrainCanvas, 0, 0);
    // Viewport box: where this player's camera is looking, on the whole-map minimap.
    // B25: the box origin AND size must come from the tile renderer's LIVE, zoom-aware
    // window (ox/oy = camera top-left tile, gw/gh = visible tile span) -- NOT hud.viewport,
    // which reports the server's fixed capture grid and does NOT shrink/grow as this player
    // zooms client-side. Using hud.viewport made the box the right size only at the server's
    // default zoom and wrong at every other zoom level. Fall back to hud.camera/viewport only
    // when the renderer isn't ready yet (first frames), matching the pre-B25 behavior.
    const map = hud.map || { w: 1, h: 1 };
    const mapW = Math.max(1, Number(map.w) || 1), mapH = Math.max(1, Number(map.h) || 1);
    const rr = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    let originX, originY, spanW, spanH;
    if (rr && Number.isFinite(rr.ox) && rr.gw > 0 && rr.gh > 0) {
      originX = rr.ox; originY = rr.oy; spanW = rr.gw; spanH = rr.gh;
    } else {
      const cam = hud.camera || { x: 0, y: 0 };
      const vp = hud.viewport || { w: 1, h: 1 };
      originX = Number(cam.x) || 0; originY = Number(cam.y) || 0;
      spanW = Number(vp.w) || 1; spanH = Number(vp.h) || 1;
    }
    const bx = (originX / mapW) * dispW;
    const by = (originY / mapH) * dispH;
    const bw = Math.max(3, (spanW / mapW) * dispW);
    const bh = Math.max(3, (spanH / mapH) * dispH);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    ctx.strokeStyle = "#ffdf4d";
    ctx.strokeRect(bx + 1.5, by + 1.5, bw - 2, bh - 2);

    // WT05 (spec §7): OTHER players' viewboxes, from the roster's v1 interest window
    // (camx/camy/camw/camh -- the zoom-aware window each player actually sees; NEVER
    // hud.viewport, the B25 server-capture-grid bug). Same scale transform as the owner's own box:
    // solid + alpha 0.9 on the viewer's z, dashed + faded on a different z. Name label
    // (playerColor on a dark chip) top-left, truncated at 10 chars + clamped inside the canvas;
    // overlapping labels nudge down 10px (name-sorted -> deterministic). Idle players are still
    // boxed (roster, not cursor). The own yellow/black box above stays the emphasized one.
    try {
      const P = window.DwfPresence;
      const roster = (P && Array.isArray(P.roster)) ? P.roster : [];
      const colorOf = (window.DwfTiles && typeof DwfTiles.playerColor === "function")
        ? DwfTiles.playerColor : null;
      const viewerZ = (hud.camera && typeof hud.camera.z === "number") ? hud.camera.z : null;
      const others = roster
        .filter(p => p && !p.self && typeof p.camx === "number" && typeof p.camy === "number"
                     && typeof p.camw === "number" && typeof p.camh === "number")
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const labelYUsed = [];
      ctx.save();
      for (const p of others) {
        const col = colorOf ? colorOf(p.name).fill : "#8cf";
        const obx = (p.camx / mapW) * dispW;
        const oby = (p.camy / mapH) * dispH;
        const obw = Math.max(3, (p.camw / mapW) * dispW);
        const obh = Math.max(3, (p.camh / mapH) * dispH);
        const sameZ = (viewerZ !== null && typeof p.camz === "number") ? (p.camz === viewerZ) : true;
        ctx.setLineDash(sameZ ? [] : [3, 2]);
        ctx.lineWidth = 1;
        ctx.globalAlpha = sameZ ? 0.9 : 0.4;
        ctx.strokeStyle = col;
        ctx.strokeRect(obx + 0.5, oby + 0.5, obw, obh);
        // name chip
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        // Anonymize raw session-key names via dwf-lobby.js's ONE canonical helper (a guest reads
        // "Guest 1665", not a truncated UUID) so this viewbox chip matches the cursor label / lobby
        // chip. Raw p.name stays the roster key for color/addressing; only the DISPLAY changes.
        let label = ((window.DwfLobby && typeof DwfLobby.displayName === "function")
          ? DwfLobby.displayName(p.name).text : String(p.name == null ? "" : p.name)) || "?";
        if (label.length > 10) label = label.slice(0, 10);
        ctx.font = "9px monospace";
        const tw = ctx.measureText(label).width;
        let lx = obx;
        let ly = oby - 10;
        let nudge = 0;
        for (const y of labelYUsed) if (Math.abs(y - ly) < 9) nudge += 10;
        ly += nudge;
        labelYUsed.push(ly);
        if (ly < 0) ly = oby + 1;                         // clamp top (below the box edge)
        lx = Math.max(0, Math.min(lx, dispW - tw - 4));   // clamp left/right inside the canvas
        if (ly > dispH - 10) ly = dispH - 10;             // clamp bottom
        ctx.fillStyle = "rgba(0,0,0,0.72)";
        ctx.fillRect(lx, ly, tw + 4, 10);
        ctx.fillStyle = col;
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText(label, lx + 2, ly + 1);
      }
      ctx.restore();
    } catch (_) { /* other-player viewboxes are a best-effort overlay */ }
  }
  // B25: a client-side zoom or window resize changes the visible tile span (gw/gh) without a
  // camera POST, so the /hud poll (1s) or a pan is not guaranteed to redraw the box promptly.
  // Redraw the minimap on resize immediately, cheaply (fires only on resize, no polling loop).
  if (!window.__dwfMinimapResizeBound) {
    window.__dwfMinimapResizeBound = true;
    window.addEventListener("resize", () => {
      try { if (typeof currentHud !== "undefined" && currentHud) renderMinimap(currentHud); } catch (_) {}
    });
  }
  // WT05: redraw the minimap on roster change (other players' viewboxes), throttled to ~2 Hz.
  // The roster arrives at the ~30 Hz AUX rate; the terrain fill + a few stroked boxes is cheap.
  if (!window.__dwfMinimapRosterBound && window.DwfPresence
      && typeof window.DwfPresence.onChange === "function") {
    window.__dwfMinimapRosterBound = true;
    let mmThrottle = 0;
    window.DwfPresence.onChange(() => {
      const now = Date.now();
      if (now - mmThrottle < 500) return;
      mmThrottle = now;
      try { if (typeof currentHud !== "undefined" && currentHud) renderMinimap(currentHud); } catch (_) {}
    });
  }

  const ALERT_NAMES = [
    "General", "Era Change", "Underground", "Migrants", "Monster", "Ambush",
    "Trade", "Noble", "Animal", "Birth", "Mood", "Labor Change", "Military",
    "Marriage", "Berserk", "Martial Trance", "Emotion", "Stress",
    "Art Defacement", "Masterpiece", "Job Failed", "Death", "Ghost",
    "Undead Attack", "Weather", "Vermin", "Curious Guzzler",
    "Research Breakthrough", "Guest Arrival", "Holdings", "Rumor",
    "Agreement", "Crime", "Deity Curse", "Combat", "Sparring", "Hunting"
  ];
  function alertName(alert) {
    const i = Number(alert?.type);
    if (Number.isFinite(i) && ALERT_NAMES[i]) return ALERT_NAMES[i];
    return String(alert?.typeKey || "Announcement").replace(/_/g, " ").toLowerCase()
      .replace(/\b\w/g, ch => ch.toUpperCase());
  }
  function alertIconStyle(iconIndex) {
    const i = Math.max(0, Math.min(36, Number(iconIndex) || 0));
    return `background-position:0 -${i * 32}px`;
  }
  // TX: a DF report ships { color: 0..7 (fg), bright: bool }. The native curses index is
  // fg + bright*8; DWFUI.dfColor resolves it against the live gps->uccolor palette (or the
  // default). This is the ONLY report->color path; no local 16-color table is kept here (drift
  // rule R1 / text-color spec §2.1, §3.2).
  function dfTextColor(report) {
    const fg = Math.max(0, Math.min(7, Number(report?.color) || 0));
    return DWFUI.dfColor(fg + (report?.bright ? 8 : 0));
  }
  // TX14: the ONE place this file asks "can I recenter on this report?". Routes through the shared
  // resolver, which honours DF's second location (pos2/zoom_type2) and its explicit NONE zoom type
  // (-1) -- that is what makes Center appear on far more announcements, and NEVER fabricates a
  // target for an announcement DF says has none.
  function nZoomTarget(report) {
    if (typeof DwfAnnouncementFormat !== "undefined")
      return DwfAnnouncementFormat.zoomTarget(report);
    return report && report.pos ? report.pos : null;
  }
  function reportText(report) {
    if (typeof DwfAnnouncementFormat !== "undefined")
      return DwfAnnouncementFormat.reportText(report);
    if (!report || !report.text) return "";
    const suffix = Number(report.repeatCount) > 0 ? ` x${Number(report.repeatCount) + 1}` : "";
    return `${report.text}${suffix}`;
  }
  function alertDisplayLines(alert) {
    // Native's combat-family hover is not the blow-by-blow report stream. It is the ordered
    // report-unit list, with the same composed "The <unit> is fighting!" rows that the click
    // panel expands. The detailed colored strikes only appear after selecting a fighter.
    if (typeof DwfAnnouncementFormat !== "undefined" &&
        DwfAnnouncementFormat.isCombatAlert(alert?.type)) {
      return DwfAnnouncementFormat.combatUnitRows(alert).map(row => ({
        text: row.label,
        // TX / text-color spec §3.2: this is a KNOWN stray hex on a composed (non-report) combat
        // row. Its native color is a §4 harvest item (units-list task-column category color) that
        // has not been harvested yet, so this composed line deliberately inherits. Detailed
        // df::report lines below do carry color/bright and use the live palette.
        unit: true,
        unitRef: row,
      }));
    }
    const lines = [];
    const reports = typeof DwfAnnouncementFormat !== "undefined"
      ? DwfAnnouncementFormat.groupReports(alert?.reports)
      : (Array.isArray(alert?.reports) ? alert.reports : []);
    reports.forEach(report => {
      const text = reportText(report);
      if (text) lines.push({ text, color: dfTextColor(report), report });
    });
    (Array.isArray(alert?.unitReports) ? alert.unitReports : []).forEach(ref => {
      const hasLines = Array.isArray(ref.reports) && ref.reports.some(r => r?.text);
      if (!hasLines && ref.unitName)
        lines.push({ text: `${ref.unitName} (${String(ref.categoryKey || "report").toLowerCase()})`, unit: true });
    });
    return lines;
  }
  async function loadNotifications() {
    try {
      const response = await fetch(`/notifications?player=${encodeURIComponent(player)}&t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("notifications failed");
      notificationState = await response.json();
      renderAlertStack();
      if (notificationsPanelIsOpen())
        renderAlertBox({ skipIfSame: true });
    } catch (_) {}
  }
  // The stack is rebuilt on every notification poll. Preserve the logical hover target across
  // that DOM replacement so a stationary pointer does not lose/reopen its popup every poll.
  let hoveredAlertKey = null;
  function alertStackMarkup(alerts, pinnedKey = null) {
    return (Array.isArray(alerts) ? alerts : []).map(alert => `
      <button type="button" class="alert-button${pinnedKey === alert.dismissKey ? " pinned" : ""}"
        data-alert-key="${escapeHtml(alert.dismissKey || "")}"
        aria-label="${escapeHtml(alertName(alert))}"
        title="${escapeHtml(alertName(alert))}"
        style="${alertIconStyle(alert.iconIndex)}"></button>`).join("");
  }
  function renderAlertStack() {
    const alerts = Array.isArray(notificationState?.alerts) ? notificationState.alerts : [];
    alertStack.innerHTML = alertStackMarkup(alerts, pinnedAlertKey);
    alertStack.style.display = alerts.length ? "flex" : "none";
    alertStack.querySelectorAll(".alert-button").forEach(button => {
      const alert = alerts.find(a => a.dismissKey === button.dataset.alertKey);
      if (!alert) return;
      button.addEventListener("mouseenter", () => {
        hoveredAlertKey = alert.dismissKey || null;
        if (!pinnedAlertKey) showAlertPopup(alert, button, false);
      });
      button.addEventListener("mouseleave", () => {
        if (hoveredAlertKey === alert.dismissKey) hoveredAlertKey = null;
        if (!pinnedAlertKey) hideAlertPopup();
      });
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        pinnedAlertKey = alert.dismissKey || null;
        showAlertPopup(alert, button, true);
        renderAlertStack();
      });
      button.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        dismissAlert(alert);
      });
    });
    if (pinnedAlertKey && !alerts.some(a => a.dismissKey === pinnedAlertKey))
      pinnedAlertKey = null;
    if (hoveredAlertKey && !alerts.some(a => a.dismissKey === hoveredAlertKey))
      hoveredAlertKey = null;
    const retainedKey = pinnedAlertKey || hoveredAlertKey;
    const retainedAlert = retainedKey && alerts.find(a => a.dismissKey === retainedKey);
    const retainedButton = retainedAlert && Array.from(alertStack.querySelectorAll(".alert-button"))
      .find(button => button.dataset.alertKey === retainedAlert.dismissKey);
    if (retainedAlert && retainedButton)
      showAlertPopup(retainedAlert, retainedButton, pinnedAlertKey === retainedAlert.dismissKey);
    else if (!pinnedAlertKey && !hoveredAlertKey)
      hideAlertPopup();
  }
  function popupOccupiesUi(el) {
    return !!el && el.style.display !== "none" && !(el.classList && el.classList.contains("hidden"));
  }

  function leftUiDodgeX(popupWidth) {
    const ids = ["zonePalette", "stockPalette", "burrowPanel", "haulingPanel", "clientPanel", "selection"];
    let right = 0;
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!popupOccupiesUi(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.left <= 80 && rect.right > right) right = rect.right;
    }
    return right > 0 ? Math.min(Math.max(8, right + 8), Math.max(8, window.innerWidth - popupWidth - 8)) : null;
  }
  // B197 (win30): a fort that fights all day accumulates hundreds of combat report lines in
  // one alert (screenshot: a single popup listing every previous report). Native DF's alert popup
  // shows only a recent window -- the full history lives in the announcements panel. Cap the popup
  // to the newest N lines with a "+K earlier" summary at the top so it can never become an unbounded
  // wall of text. Reports are appended oldest->newest, so the tail is the most recent. Client-only
  // (ships on web sync); prune/dismiss and the announcements panel keep the full log intact.
  const ALERT_POPUP_MAX_LINES = 24;
  function cappedAlertLines(lines) {
    const all = Array.isArray(lines) ? lines : [];
    if (all.length <= ALERT_POPUP_MAX_LINES) return { shown: all, omitted: 0 };
    return { shown: all.slice(-ALERT_POPUP_MAX_LINES), omitted: all.length - ALERT_POPUP_MAX_LINES };
  }
  // WAVE-5 / R3 + R7. The popup's two per-line controls were hand-rolled BUTTON elements wearing UNICODE
  // ARROWS: `&#8594;` (RIGHTWARDS ARROW) for recenter and `&times;` for dismiss. Both have real DF
  // sprites -- RECENTER_RECENTER and BUILDING_JOBS_REMOVE (the red X tile TOKENS.sprites.close names,
  // and the same one the profile's own close already uses). They are now actionButtonsHtml items.
  //
  // *** THE DISABLED RECENTER IS PRESERVED ON PURPOSE. *** ALERTS-2 shows one gold recenter tile per
  // TARGETABLE row and NO tile on rows with no target. `.alert-popup-action:disabled` is
  // `visibility: hidden`, so a targetless row already reserves the gap and draws nothing -- which is
  // native's omit-don't-blank rule, reached by a route the CSS already owns. Dropping the `disabled`
  // item would collapse the column and MOVE the tiles on neighbouring rows. Keep it.
  function alertPopupActionsHtml(report) {
    const S = DWFUI.TOKENS.sprites;
    return DWFUI.actionButtonsHtml([
      { action: "recenter", sprite: S.recenter, dataset: { popupCenter: report.id },
        disabled: !nZoomTarget(report), title: "Recenter" },
      { action: "dismiss", sprite: S.close, dataset: { popupDismiss: `r:${report.id}` },
        title: "Dismiss" },
    ], { cls: "dwfui-actions alert-popup-actions", btnCls: "alert-popup-action" });
  }
  function alertPopupParts(alert, pinned) {
    const allLines = alertDisplayLines(alert);
    const { shown: lines, omitted } = cappedAlertLines(allLines);
    const overflowRow = omitted > 0
      ? `<div class="alert-popup-row alert-popup-overflow"><div class="alert-line alert-overflow-line">+${omitted} earlier report${omitted === 1 ? "" : "s"} &mdash; open the announcements panel for the full log</div></div>`
      : "";
    const rows = lines.length
      ? overflowRow + lines.map(line => `<div class="alert-popup-row"><div class="alert-line${line.unit ? " alert-unit-line" : ""}" style="${line.color ? `color:${line.color}` : ""}">${escapeHtml(line.text)}</div>${pinned && line.report ? alertPopupActionsHtml(line.report) : ""}</div>`).join("")
      : `<div class="alert-line alert-unit-line">${escapeHtml(alertName(alert))}</div>`;
    // B192: the pinned (interactive) popup carries a whole-alert Dismiss control. Per-line dismiss
    // only emits `r:<id>` keys, but a combat alert also carries per-unit `u:<unit>:<cat>` keys that
    // have no dismissible line -- so without this the badge could never be cleared (win30).
    // dismissAlert(alert) forwards the full dismissKeys array so the alert clears and stays cleared
    // across polls (paused and unpaused). Hover stays read-only (this control is pinned-only).
    // The two instruction lines are VERBATIM native (ALERTS-2 / ALERTS-3) -- do not reword them.
    // The whole-alert Dismiss is OUR superset (a combat alert carries per-unit `u:` keys that have
    // no dismissible line, so without it the badge could never be cleared -- A playtester, win30). It is a
    // TEXT control, so it dresses as native's text plaque, not as an icon tile.
    const header = pinned
      ? `<div class="alert-help"><span>You can recenter on certain announcements. Right click to close.</span>` +
        DWFUI.plaqueBtnHtml({ label: "Dismiss", tone: "red", cls: "alerts-action alert-dismiss-all",
          dataset: { popupDismissAlert: "" }, title: "Dismiss this alert" }) + `</div>`
      : `<div class="alert-help">Left click for recenter and expand options. Right click to dismiss.</div>`;
    return { html: `${header}${rows}`, lines };
  }
  function alertPopupMarkup(alert, pinned = false) {
    return alertPopupParts(alert, pinned).html;
  }
  function showAlertPopup(alert, anchor, pinned) {
    const parts = alertPopupParts(alert, pinned);
    const lines = parts.lines;
    alertPopup.innerHTML = parts.html;
    alertPopup.classList.toggle("pinned", pinned);
    const rect = anchor.getBoundingClientRect();
    alertPopup.style.visibility = "hidden";
    alertPopup.style.display = "block";
    const popupWidth = alertPopup.offsetWidth || 520;
    const popupHeight = alertPopup.offsetHeight || 120;
    const dodgedLeft = leftUiDodgeX(popupWidth);
    const left = dodgedLeft == null
      ? Math.min(rect.right + 4, Math.max(8, window.innerWidth - popupWidth - 8))
      : dodgedLeft;
    alertPopup.style.left = `${left}px`;
    alertPopup.style.top = `${Math.max(58, Math.min(rect.top + 1, window.innerHeight - popupHeight - 8))}px`;
    alertPopup.style.visibility = "visible";
    if (pinned) {
      alertPopup.oncontextmenu = event => {
        event.preventDefault();
        pinnedAlertKey = null;
        hideAlertPopup();
      };
      alertPopup.querySelectorAll("[data-popup-center]").forEach(button => button.addEventListener("click", () => {
        const report = lines.map(line => line.report).find(r => r && String(r.id) === button.dataset.popupCenter);
        const target = nZoomTarget(report);
        if (target) centerAndFlashMapPos(target);
      }));
      alertPopup.querySelectorAll("[data-popup-dismiss]").forEach(button => button.addEventListener("click", () => dismissAlertKeys([button.dataset.popupDismiss])));
      alertPopup.querySelector("[data-popup-dismiss-alert]")?.addEventListener("click", () => dismissAlert(alert));
    }
  }
  function hideAlertPopup() {
    alertPopup.style.display = "none";
    alertPopup.style.visibility = "";
    alertPopup.oncontextmenu = null;
  }
  function alertTarget(alert) {
    if (alert?.target && Number.isFinite(Number(alert.target.x)) &&
        Number.isFinite(Number(alert.target.y)) && Number.isFinite(Number(alert.target.z)))
      return alert.target;
    const report = (Array.isArray(alert?.reports) ? alert.reports : []).find(r => nZoomTarget(r));
    if (report) return nZoomTarget(report);
    const ref = (Array.isArray(alert?.unitReports) ? alert.unitReports : []).find(r => r?.pos);
    return ref ? ref.pos : null;
  }
  async function setCameraToMapPos(pos) {
    if (!pos) return false;
    // B25/B26: center using the tile renderer's live zoom-aware span (gw/gh) so the target
    // tile lands at the true view centre at ANY zoom -- hud.viewport is the server's fixed
    // grid and would mis-centre a zoomed-in player. Fall back to hud.viewport pre-renderer.
    const rr = (typeof renderedImageRect === "function") ? renderedImageRect() : null;
    let halfW, halfH;
    if (rr && Number.isFinite(rr.gw) && rr.gw > 0 && rr.gh > 0) {
      halfW = rr.gw / 2; halfH = rr.gh / 2;
    } else {
      const vp = currentHud?.viewport || { w: 80, h: 50 };
      halfW = (Number(vp.w) || 80) / 2; halfH = (Number(vp.h) || 50) / 2;
    }
    const x = Math.round(Number(pos.x) - halfW);
    const y = Math.round(Number(pos.y) - halfH);
    const z = Math.round(Number(pos.z) || 0);
    resetPanPrediction();
    try {
      const ac = ("AbortController" in window) ? new AbortController() : null;   // never hang a caller
      const to = ac ? setTimeout(() => ac.abort(), 3000) : null;
      await fetch(`/camera?player=${encodeURIComponent(player)}&x=${x}&y=${y}&z=${z}`, {
        method: "POST",
        cache: "no-store",
        signal: ac ? ac.signal : undefined
      });
      if (to) clearTimeout(to);
      await loadHud();
      return true;
    } catch (_) {
      return false;
    }
  }
  async function centerAndFlashMapPos(pos) {
    if (!pos) return;
    closeClientPanel();
    closeSelection();
    pinnedAlertKey = null;
    hoveredAlertKey = null;
    hideAlertPopup();
    await setCameraToMapPos(pos);
    await flashMapTile(pos);
    focusPage();
  }
  // B216 defect 1: `recenterOnAlert` (its only caller was the combat-log open hook) is removed.
  // Opening a panel must not move the camera; recentering is an explicit affordance (the Center
  // tiles, which go through centerAndFlashMapPos). `alertTarget` stays -- it still gates those
  // tiles' enabled state and their centerAndFlashMapPos call.
  async function dismissAlert(alert) {
    const keys = Array.isArray(alert?.dismissKeys) ? alert.dismissKeys.filter(Boolean) : [];
    if (!keys.length && alert?.dismissKey) keys.push(alert.dismissKey);
    if (!keys.length) return;
    await dismissAlertKeys(keys, alert);
  }
  // B232 ROUND 2: `alertsCenterButtonHtml` and `specialAnnouncementSections` are DELETED.
  // The first served only the full-screen dashboard this reopen removes; the second was B160's
  // dead code wearing a helper's name -- it filtered on `typeKey === "SIEGE"` / `"ARTIFACT_CREATED"`,
  // tokens Dwarf Fortress does not have, so it rendered nothing, forever. The REAL siege/artifact
  // highlight strips live in dwf-announcements.js (repSpecialSections), built on the
  // raws-generated taxonomy.
  async function dismissAlertKeys(keys, alert = null) {
    try {
      await fetch(`/notification-action?player=${encodeURIComponent(player)}&action=dismiss&keys=${encodeURIComponent(keys.join(","))}`,
        { method: "POST", cache: "no-store" });
    } catch (_) {}
    // Always drop the popup for the alert we just dismissed. The pointer is on this alert
    // (we got here from its right-click / Dismiss button), so hiding its popup is always
    // correct -- and necessary: re-rendering the stack removes the hovered button from the
    // DOM, so no mouseleave ever fires to hide it. Without this the LAST dismissed alert's
    // popup stays stuck on screen until a page refresh (B12: winter/weather alert).
    if (!alert || pinnedAlertKey === alert.dismissKey) pinnedAlertKey = null;
    if (!alert || hoveredAlertKey === alert.dismissKey) hoveredAlertKey = null;
    hideAlertPopup();
    await loadNotifications();
  }
  function notificationPanelSignature() {
    const alerts = Array.isArray(notificationState?.alerts) ? notificationState.alerts : [];
    return JSON.stringify({
      alerts: alerts.map(alert => [
        alert.type,
        alert.dismissKey,
        alert.latestReportId,
        (Array.isArray(alert.reportIds) ? alert.reportIds : []).join("."),
        (Array.isArray(alert.dismissKeys) ? alert.dismissKeys : []).join(".")
      ]),
    });
  }
  // ===========================================================================================
  // B232 ROUND 2 -- THE NATIVE ALERT BOX (reopened by the friend-review, 2026-07-14).
  //
  // Round 1 wired the ALERT button to a full-screen dashboard: title, Alerts/Reports tabs,
  // "N total reports", an "Active alerts" list with big Center/red Dismiss plaques per row, then
  // a "Recent reports" feed. NATIVE HAS NONE OF THAT. The oracle
  // (tools/orchestrator/attachments/B232-oracle-native.png) shows a modest modal box over the map:
  //
  //   - a bordered panel (DF's own gold window frame), near-black interior (rgb(28,28,28) on the
  //     capture), spanning most of the width and ~71% of the height below the top bar
  //   - the hint line, white, TOP-LEFT (two spaces between the sentences, measured on the capture):
  //       "You can recenter on certain announcements.  Right click to close."
  //   - the alert announcement lines themselves, in DF's own text colour (the merchants line is
  //     yellow rgb(255,255,20) on the capture) -- BARE TEXT LINES, no icons, no row chrome
  //   - exactly TWO icon buttons at the top-right, stacked: ANNOUNCEMENT_OPEN_ALL_ANNOUNCEMENTS
  //     (the log/scroll cell -- opens the full announcements screen) above RECENTER_RECENTER
  //     (the dashed-box recenter cell). Both are DF's own interface cells, gold frame baked in,
  //     verified against web/interface_map.json + the vanilla sheets.
  //   - NOTHING ELSE: no title, no tabs, no count, no section titles, no per-row buttons, no red
  //     Dismiss, no footer, no close X. Right click closes it.
  //
  // The full log (census 76 / M27) SURVIVES -- behind the box's log icon and the world map's
  // Reports plaque (dwf-announcements.js openReportsPanel), not on this button.
  //
  // B216: the recenter ICON is the single explicit camera affordance here. The lines are inert --
  // opening the box or clicking a line never moves the camera. (Whether native's line-click also
  // recenters, and whether its recenter button also CLEARS the alert, is NOT determinable from the
  // static capture -- screenshot request filed in the closeout; until evidence lands the icon
  // recenters and does NOT destroy anything.)
  // ===========================================================================================
  function alertBoxTargetAlert(alerts) {
    // The newest alert that actually has a map target (latestReportId orders the stack).
    return (Array.isArray(alerts) ? alerts : [])
      .filter(alert => !!alertTarget(alert))
      .sort((a, b) => (Number(b.latestReportId) || 0) - (Number(a.latestReportId) || 0))[0] || null;
  }
  function alertBoxMarkup(sourceState) {
    const data = sourceState || {};
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    const lines = [];
    alerts.forEach(alert => alertDisplayLines(alert).forEach(line => lines.push(line)));
    // Bare colored text lines -- the oracle shows no icons, no rows, no per-line controls.
    const lineHtml = lines.map(line =>
      `<div class="alertbox-line"${line.color ? ` style="color:${line.color}"` : ""}>${escapeHtml(line.text)}</div>`).join("");
    const canRecenter = !!alertBoxTargetAlert(alerts);
    const tools =
      DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.openAnnouncements, cls: "alertbox-tool",
        dataset: { alertboxLog: "" }, title: "Open the announcements log",
        ariaLabel: "Open the announcements log",
      }) +
      DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.recenter, cls: "alertbox-tool",
        dataset: { alertboxRecenter: "" }, disabled: !canRecenter,
        title: canRecenter ? "Recenter on the latest announcement" : "No announcement has a map location",
        ariaLabel: "Recenter on the latest announcement",
      });
    // The hint is VERBATIM native, including the two-space sentence gap on the capture.
    return DWFUI.windowHtml({
      cls: "alertbox-window", ariaLabel: "Alerts",
      bodyHtml:
        `<div class="alertbox-hint">You can recenter on certain announcements.&nbsp; Right click to close.</div>` +
        `<div class="alertbox-tools">${tools}</div>` +
        DWFUI.scrollHtml({ cls: "alertbox-lines", ariaLabel: "Alert announcements" }, lineHtml),
    });
  }
  function renderAlertBox(options = {}) {
    activeInfoPanel = "alerts";
    const signature = notificationPanelSignature();
    if (options.skipIfSame && signature === lastNotificationPanelSignature) return;
    const alerts = Array.isArray(notificationState?.alerts) ? notificationState.alerts : [];
    clientPanel.className = "visible alertbox-panel";
    panelContent(clientPanel).innerHTML = alertBoxMarkup(notificationState);
    // "Right click to close." -- the hint line's own contract.
    clientPanel.querySelector(".alertbox-window")?.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      closeClientPanel();
    });
    clientPanel.querySelector("[data-alertbox-log]")?.addEventListener("click", () => openReportsPanel());
    // B216: THE ONLY CAMERA CALL IN THIS BOX. The lines carry no handlers at all.
    clientPanel.querySelector("[data-alertbox-recenter]")?.addEventListener("click", () => {
      const alert = alertBoxTargetAlert(alerts);
      if (alert) centerAndFlashMapPos(alertTarget(alert));
    });
    lastNotificationPanelSignature = signature;
  }
  async function openNotificationsPanel() {
    setActiveToolbar("alerts");
    clearBuildPlacement(false);
    activeInfoPanel = "alerts";
    // The stack poll keeps notificationState fresh, so the box can render immediately; the
    // await below re-renders (skipIfSame) once the open-time fetch lands.
    renderAlertBox();
    await loadNotifications();
  }

  function setActiveToolbar(name) {
    document.querySelectorAll("[data-panel].active").forEach(button => button.classList.remove("active"));
    document.querySelectorAll("[data-panel]").forEach(button => {
      if (button.dataset.panel === name)
        button.classList.add("active");
    });
    refreshToolbarSprites(name);
  }

  function defaultSectionForPanel(name) {
    return ({
      citizens: "creatures",
      labor: "labor",
      locations: "places",
      orders: "tasks",
      workorders: "workorders",
      nobles: "nobles",
      objects: "objects",
      justice: "justice",
      stocks: "stocks"
    }[name] || "creatures");
  }

  function panelForInfoSection(section, fallback = activeInfoPanel || "citizens") {
    return ({
      creatures: "citizens",
      tasks: "orders",
      places: "locations",
      labor: "labor",
      workorders: "workorders",
      nobles: "nobles",
      objects: "objects",
      justice: "justice",
      stocks: "stocks"
    }[section] || fallback);
  }

  function localPanelTitle(name) {
    return ({
      stocks: "Stocks",
      build: "Place Building",
      designate: "Designations",
      dig: "Dig",
      stockpile: "Stockpiles",
      zone: "Zones",
      objects: "Objects",
      justice: "Justice",
      search: "Search",
      alerts: "Announcements",
      hauling: "Hauling",
      settings: "Settings",
      speed: "Speed",
      map: "World Map",
      help: "Help",
      about: "DFHack"
    }[name] || name);
  }

  function renderLocalPanel(name) {
    const hud = currentHud || {};
    const title = localPanelTitle(name);
    const rows = [];
    if (name === "stocks") {
      rows.push(`Food: ~${hud.stocks?.food ?? 0}`);
      rows.push(`Drink: ~${hud.stocks?.drink ?? 0}`);
      rows.push("This is browser-owned; it does not open DF's global Stocks screen.");
    } else if (name === "designate" || name === "dig") {
      rows.push("Next layer: paint rectangles in this browser view and commit DF designations.");
    } else {
      rows.push("Panel shell is independent. Its real DF-backed controls are the next wiring step.");
    }
    panelContent(clientPanel).innerHTML = `
      <div class="kind">client ui</div>
      <h1>${escapeHtml(title)}</h1>
      ${rows.map(row => `<div class="line">${escapeHtml(row)}</div>`).join("")}
    `;
    clientPanel.classList.remove("info-panel");
    clientPanel.classList.add("visible");
  }


if (typeof window !== "undefined") {
  window.DFUnitProfileMarkup = { unitSheetMarkup, unitNicknameEditorMarkup };
  // B233-1: the unit-follow lock, published with the SAME shape as window.DwfSpectate
  // (getState/stopFollow/onChange) so one subscriber can treat both follow kinds alike.
  window.DwfUnitFollow = {
    getState: getUnitFollowState,
    stopFollow: stopUnitFollow,
    onChange: onUnitFollowChange,
  };
  window.DFAnnouncementMarkup = { alertBoxMarkup, alertStackMarkup, alertPopupMarkup };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    unitPortraitMarkup,
    renderUnitTabBody,
    renderUnitLaborPanel,
    renderUnitRelations,
    renderUnitGroups,
    renderUnitRooms,
    renderUnitInventory,
    unitSheetMarkup,
    renderUnitStatusWords,   // B280 -- exported so status_truth_test can render the real status cell
    unitNicknameEditorMarkup,
    alertBoxMarkup,
    alertStackMarkup,
    alertPopupMarkup,
    alertIconStyle,
    dfTextColor,
    reportText,
    shouldAutoGeneratePortrait,
    // B-PORTRAIT-FLASH: exported so portrait_identity_test can drive the REAL harvest/adopt cycle
    // against a DOM double and COUNT the <img> elements the sheet emits per refresh tick. An <img>
    // in the markup IS an HTTP request; zero <img> for an already-decoded portrait is zero refetches.
    harvestDecodedPortraits,
    adoptDecodedPortraits,
    unitPortraitMarkup,
    __setPortraitMapsForTest(portraits, creatures = null) {
      __dfcPortraitsMap = portraits;
      if (creatures) __dfcCreaturesMap = creatures;
      __dfcPortraitSourceByUnit.clear();
      __dfcPortraitAutoGenerated.clear();
    }
  };
}
