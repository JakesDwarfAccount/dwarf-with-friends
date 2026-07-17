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

// B04: per-tile unit selection cycling.
//
// DF lets you tab through every unit standing on one tile (the classic "dwarf standing on a
// buffalo calf" case). The browser client's /inspect only ever resolves ONE unit
// (interaction.cpp find_unit_near_tile), so the unit sheet that opens shows a single creature
// with no way to reach the others sharing that tile.
//
// The full set of units IS already on the client: the ~30Hz AUX stream carries every visible
// unit with its world x/y/z + id + name (world_stream.cpp emit_units ->
// DwfTiles.getLatest().units). So this is a pure client feature -- no wire/DLL change.
// When a unit sheet is open, we look up all units sharing that unit's tile and, if there is
// more than one, inject a small "<  n / N on tile  >" cycler into the sheet header. Prev/Next
// (and the Tab key while the sheet is focused) fetch the neighbouring unit via the existing
// /unit endpoint and re-render the sheet -- mirroring DF's own on-tile unit cycle.
//
// It runs entirely from the outside via a MutationObserver on #selection, so it needs no edit
// to the (foreign-owned, in-flight) core.js / unit-hud-notifications.js render code: it just
// re-injects its bar whenever the sheet re-renders (e.g. a tab switch blows the DOM away).
(function () {
  "use strict";

  if (window.DWFUI && typeof window.DWFUI.require === "function") window.DWFUI.require("occupant-navigation", [
    "esc", "cyclerHtml", "iconHtml", "occupantRailHtml", "rowHtml", "scrollHtml", "statusHtml",
  ]);

  // ---- self-contained styling (avoids editing the shared dwf.css) ------------------
  // LAYOUT ONLY -- colours are --dwfui-* tokens. The block STAYS because `.unit-cycle` and
  // `.tile-list*` have NO rules at all in web/css/dwf.css (locked this wave); deleting it
  // would leave the cycle bar and the retained chooser unstyled. What IS gone:
  //   * the private cycle-button / cycle-label rules -- that control is DWFUI's three-slice cycler
  //     now (.dwfui-cycler, painted by the shared sheet), so its own chrome is dead weight.
  //   * the INVENTED BLUE (rgba(115,195,255,...), rgba(180,220,255,...), #9edcff) -- DF has no such
  //     palette; it was a browser-UI tint on a native surface.
  try {
    var style = document.createElement("style");
    style.textContent =
      ".unit-cycle{display:flex;align-items:center;justify-content:center;gap:10px;" +
      "margin:2px 0 6px;padding:3px 6px;}" +
      ".tile-list{min-width:230px;max-width:360px;margin:4px 0;padding:5px;" +
      "background:var(--dwfui-surface);border:1px solid var(--dwfui-gold);border-radius:4px;}" +
      ".tile-list-title{font-size:12px;opacity:.82;padding:2px 4px 5px;}" +
      ".tile-list-row{display:flex;align-items:center;gap:7px;width:100%;padding:5px 7px;border:0;" +
      "border-top:1px solid var(--dwfui-slate);background:transparent;color:inherit;text-align:left;" +
      "cursor:pointer;}" +
      ".tile-list-row:hover,.tile-list-row:focus{background:var(--dwfui-hatch);outline:0;}" +
      ".tile-list-row:disabled{opacity:.55;cursor:help;}" +
      ".tile-list-icon{display:flex;align-items:center;justify-content:center;flex:0 0 auto;}" +
      ".tile-list-kind{margin-left:auto;font-size:10px;opacity:.62;text-transform:uppercase;}" +
      "";
    (document.head || document.documentElement).appendChild(style);
  } catch (_) { /* styling is cosmetic; a failure just means an unstyled bar */ }

  function routingPlayer() {
    // Prefer the shared core `player` binding; fall back to the URL / storage the same way
    // every module does, so this works even if load order ever shifts.
    try { if (typeof player !== "undefined" && player) return player; } catch (_) {}
    try { if (window.DFPlayerKey) return window.DFPlayerKey; } catch (_) {}
    try {
      return new URLSearchParams(location.search).get("player") ||
        localStorage.getItem("dwf.player") || "";
    } catch (_) { return ""; }
  }

  function currentSheetData() {
    try { if (typeof selectedUnitData !== "undefined" && selectedUnitData) return selectedUnitData; }
    catch (_) {}
    return null;
  }

  // All units the client currently knows to be standing on `tile` (exact x/y/z match).
  function unitsOnTile(tile) {
    if (!tile) return [];
    var tx = Number(tile.x), ty = Number(tile.y), tz = Number(tile.z);
    if (!isFinite(tx) || !isFinite(ty) || !isFinite(tz)) return [];
    var all = [];
    try {
      all = (window.DwfTiles && typeof DwfTiles.getLatest === "function" &&
        (DwfTiles.getLatest() || {}).units) || [];
    } catch (_) { all = []; }
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var u = all[i];
      if (u && Number(u.x) === tx && Number(u.y) === ty && Number(u.z) === tz) {
        out.push({ id: Number(u.id), name: String(u.name || "") });
      }
    }
    return out;
  }

  // Prefer the server's click-resolution set. This keeps arrows aligned with B49's exact-tile
  // selection and only permits the deliberate 3x3 fallback when the clicked tile was empty.
  // Older servers do not send unitCycle, so retain the AUX exact-tile fallback for compatibility.
  function cycleListFor(data) {
    var unit = (data && data.unit) || {};
    var curId = Number(unit.id);
    var ids = data && Array.isArray(data.unitCycle) ? data.unitCycle : null;
    var units = ids ? ids.map(function (id) { return { id: Number(id), name: "" }; }) : unitsOnTile(data && data.tile);
    var hasCur = false;
    for (var i = 0; i < units.length; i++) if (units[i].id === curId) { hasCur = true; break; }
    if (!hasCur && isFinite(curId)) {
      units = [{ id: curId, name: String(unit.name || data.title || "") }].concat(units);
    }
    return units;
  }

  // B64: compose a tile-wide candidate list from the existing inspect result plus the live
  // AUX/cache snapshot. Ordering is deliberately native-like and stable: units, buildings,
  // then items. The current wire carries only the top item tail and no item id, so an item is
  // selectable only when /inspect itself supplied its authoritative id; the disabled tail row
  // still tells the player why a visible stack cannot yet be opened.
  function buildCandidates(data, latest) {
    var tile = data && data.tile;
    if (!tile) return [];
    var x = Number(tile.x), y = Number(tile.y), z = Number(tile.z);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return [];
    latest = latest || {};
    var out = [], seen = {};
    function add(c) {
      var id = Number(c && c.id);
      var key = String(c && c.kind || '') + ':' + (isFinite(id) ? id : String(c && c.key || c && c.label || ''));
      if (!c || seen[key]) return;
      seen[key] = true; out.push(c);
    }
    var unitById = {};
    var rawUnits = Array.isArray(latest.units) ? latest.units : [];
    for (var i = 0; i < rawUnits.length; i++) {
      var u = rawUnits[i];
      if (u && Number(u.x) === x && Number(u.y) === y && Number(u.z) === z && isFinite(Number(u.id)) && Number(u.id) >= 0)
        unitById[Number(u.id)] = u;
    }
    var unitIds = Array.isArray(data.unitCycle) ? data.unitCycle.map(Number).filter(function (id) { return isFinite(id) && id >= 0; }) : Object.keys(unitById).map(Number).sort(function (a, b) { return a - b; });
    if (data.unit && isFinite(Number(data.unit.id)) && Number(data.unit.id) >= 0 && unitIds.indexOf(Number(data.unit.id)) < 0)
      unitIds.unshift(Number(data.unit.id));
    for (var j = 0; j < unitIds.length; j++) {
      var uid = unitIds[j], ur = unitById[uid] || (data.unit && Number(data.unit.id) === uid ? data.unit : {});
      add({ kind: 'unit', id: uid, label: String(ur.name || data.title || ('Unit ' + uid)), icon: '@' });
    }
    var rawBuildings = Array.isArray(latest.buildings) ? latest.buildings : [];
    for (var k = 0; k < rawBuildings.length; k++) {
      var b = rawBuildings[k], bid = Number(b && b.id);
      if (!b || !isFinite(bid) || bid < 0 || Number(b.z) !== z || x < Number(b.x1) || x > Number(b.x2) || y < Number(b.y1) || y > Number(b.y2)) continue;
      var type = String(b.type || 'Building');
      // B164: classify the AUX-cache building by the SAME taxonomy the server's /tile-occupants
      // route uses (http_server.cpp append_building). A stockpile arrives here as type "Stockpile"
      // and a civzone as "Civzone" (world_stream.cpp ENUM_KEY_STR); mapping them to their real
      // kinds (not the else-branch 'building') means the stockpile candidate the primary inspect
      // already added via data.buildingId DEDUPES with this one instead of producing a phantom
      // second row -- so a lone stockpile is ONE candidate and one-clicks open, no "as stockpile
      // / as building" double-ask. The owner: "the building identity is never wanted, it is not native."
      var bkind = type === 'Workshop' || type === 'Furnace' ? 'workshop'
        : type === 'Stockpile' ? 'stockpile'
        : type === 'Civzone' ? 'zone' : 'building';
      add({ kind: bkind, id: bid, label: String(b.name || type), icon: '#'});
    }
    if (isFinite(Number(data.buildingId)) && Number(data.buildingId) >= 0) {
      var selectedKind = String(data.kind || '').toLowerCase();
      if (selectedKind === 'stockpile' || selectedKind === 'zone' || selectedKind === 'workshop' || selectedKind === 'building')
        add({ kind: selectedKind, id: Number(data.buildingId), label: String(data.title || selectedKind), icon: '#' });
    }
    if (String(data.kind || '').toLowerCase() === 'item' && isFinite(Number(data.itemId)) && Number(data.itemId) >= 0)
      add({ kind: 'item', id: Number(data.itemId), label: String(data.title || ('Item ' + data.itemId)), icon: '*'});
    if (String(data.kind || '').toLowerCase() === 'engraving')
      add({ kind: 'engraving', id: -1, label: String(data.title || 'Engraving'), tile: tile });
    // B205: INVISIBLE DEGRADE for the unshipped authoritative-item-id wire capability.
    // The AUX tile stream carries only the tile's TOP-ITEM tail with no item id, so an item is
    // openable only when /inspect resolved its id (above) or the current-host /tile-occupants
    // route supplies one (routeCandidates). The old wire-tail branch used to ADD a second,
    // disabled dead-placeholder row (a "<TYPE> (host-update...)" label) for that tail. Because
    // its key was the constant 'wire-tail' (no id) it never deduped against the openable
    // /inspect item above, so EVERY lone loose item that /inspect already resolved (a corpse on
    // the floor, a coffin's interred body, a bar -- the tail is type-agnostic: it renders
    // tileItem.item.type verbatim) produced TWO rows: the working one plus a dead one, forcing
    // the >=2-candidate chooser to appear (B205: corpses AND coffins). The tail is NOT gated
    // on B195's skeletal sprite bit -- that only picks a render cell and never reaches here; it
    // is gated on the /tile-occupants server half (B80), which rides the next DLL window. Until
    // then we degrade INVISIBLY: emit no row for an id-less tail. The openable /inspect entry
    // stands alone (today's behaviour), and when the server half ships, /tile-occupants replaces
    // the cache chooser with real ids -- so the merged corpse entry is ONE row whether or not
    // the skeletal bit is present. No dead placeholder row is ever constructed anywhere.
    var rank = { unit: 0, workshop: 1, building: 1, stockpile: 1, zone: 1, item: 2,
                 engraving: 3 };
    out.sort(function (a, b) { var ar = Object.prototype.hasOwnProperty.call(rank, a.kind) ? rank[a.kind] : 9; var br = Object.prototype.hasOwnProperty.call(rank, b.kind) ? rank[b.kind] : 9; return ar - br || Number(a.id || 0) - Number(b.id || 0); });
    return out;
  }

  function routeForCandidate(candidate) {
    if (!candidate || candidate.disabled) return null;
    var kind = String(candidate.kind || '').toLowerCase();
    if (kind === 'engraving') {
      var tile = candidate.tile || {};
      if (!isFinite(Number(tile.x)) || !isFinite(Number(tile.y)) || !isFinite(Number(tile.z))) return null;
      return { flow: 'engraving', tile: { x: Number(tile.x), y: Number(tile.y), z: Number(tile.z) } };
    }
    if (!isFinite(Number(candidate.id)) || Number(candidate.id) < 0) return null;
    if (kind === 'unit') return { flow: 'unit', id: Number(candidate.id) };
    if (kind === 'item') return { flow: 'item', id: Number(candidate.id) };
    if (kind === 'workshop' || kind === 'building' || kind === 'stockpile' || kind === 'zone')
      return { flow: 'place', kind: kind, id: Number(candidate.id) };
    return null;
  }

  function nextChooserIndex(index, count, direction) {
    if (!(count > 0)) return -1;
    return ((Number(index) || 0) + (direction < 0 ? -1 : 1) + count) % count;
  }

  // The RETAINED chooser (off the live path since B208, but still wired: DFTileList.renderChooser,
  // exercised by tilelist_fixture_test). It is a SUPERSET, so it is dressed, not deleted. Its icon
  // used to be the literal letter '@' / '#' / '*' -- the identity-letter path, which iconHtml treats
  // as a BLOCKER, not a fallback. It now resolves through occupantIconHtml, the SAME icon channel the
  // native occupant rail already uses (unit portrait / item sprite / native empty tile) -- one icon
  // path for both surfaces, not a second one invented for the chooser.
  function tileListMarkup(candidates) {
    var rows = (Array.isArray(candidates) ? candidates : []).map(function (candidate, index) {
      return window.DWFUI.rowHtml({
        tag: "button", cls: "tile-list-row", dataset: { tileCandidate: index },
        icon: '<span class="tile-list-icon">' + occupantIconHtml(candidate) + '</span>',
        label: candidate.label || candidate.kind || "Occupant",
        trailing: '<span class="tile-list-kind">' + window.DWFUI.esc(candidate.kind || "unknown") + '</span>',
      });
    }).join("");
    return '<div class="tile-list">' +
      '<div class="tile-list-title">' + window.DWFUI.statusHtml({ tag: "span", cls: "tile-list-title-copy", text: "Select tile occupant" }) + '</div>' +
      window.DWFUI.scrollHtml({ cls: "tile-list-rows", ariaLabel: "Tile occupants" }, rows) + '</div>';
  }

  // Native's prev/next control is the THREE-SLICE CYCLER (TYPE_FILTER_LEFT / _TEXT / _RIGHT -- all
  // three verified in web/interface_map.json), which is also native's answer to a dropdown. This bar
  // used to hand-build two buttons carrying the Unicode left/right triangle entities -- a glyph where
  // a sprite exists. The `data-cyc` wire (-1 / +1) is IDENTICAL, so inject()'s and the Tab-key
  // handler's `[data-cyc]` lookups are untouched.
  function unitCycleMarkup(index, count) {
    var safeCount = Math.max(0, Number(count) || 0);
    var safeIndex = Math.max(0, Math.min(Math.max(0, safeCount - 1), Number(index) || 0));
    return window.DWFUI.cyclerHtml({
      cls: "unit-cycle-cycler", ariaLabel: "Units on this tile",
      label: (safeIndex + 1) + " / " + safeCount + " on this tile",
      previous: { dataset: { cyc: -1 }, title: "Previous unit on this tile (Shift+Tab)" },
      next: { dataset: { cyc: 1 }, title: "Next unit on this tile (Tab)" },
    });
  }

  var chooserState = null;
  function chooseCandidate(candidate, candidates) {
    var route = routeForCandidate(candidate);
    if (!route) return;
    chooserState = null;
    if (route.flow === 'unit') { switchTo(route.id, (candidates || []).filter(function (c) { return c.kind === 'unit'; })); return; }
    if (route.flow === 'item') {
      // ITEMSHEET-PARITY: when a map tile holds several loose items, hand the sibling item list
      // to the sheet so it renders them as co-located tabs (one sheet, tab per item) instead of
      // making the chooser the only way to reach the others. Only real, openable item ids qualify.
      var siblings = (candidates || []).filter(function (c) {
        return c.kind === 'item' && !c.disabled && isFinite(Number(c.id)) && Number(c.id) >= 0;
      }).map(function (c) {
        return { id: Number(c.id), name: String(c.label || ('Item ' + c.id)), spriteRef: c.spriteRef || null };
      });
      try { if (typeof openItemPanel === 'function') openItemPanel(route.id, siblings.length > 1 ? siblings : null); } catch (_) {}
      return;
    }
    if (route.flow === 'engraving') {
      try { if (typeof openEngravingPanel === 'function') openEngravingPanel(route.tile, null); } catch (_) {}
      return;
    }
    try { if (typeof openInfoPlace === 'function') openInfoPlace(route.kind, route.id); } catch (_) {}
  }

  // ---- B208 top-first occupant switching -------------------------------------------------------
  // Native Steam DF opens the TOP-LAYER occupant's sheet IMMEDIATELY on a multi-occupant click and
  // offers the other occupants as tabs beside the info box -- there is no intermediate chooser LIST
  // step (B208: the list "adds an additional un-needed step"; oracle B208-1.png shows the
  // Dwarven Child unit sheet opening with a Farm Plot alongside it). The priority order is exactly
  // the one buildCandidates/routeCandidates already fix -- unit > building/workshop/stockpile/zone >
  // item, then ascending id -- so candidates[0] is the top layer and opens straight away, and the
  // rest become an occupant RAIL (DWFUI.occupantRailHtml). B224: the rail is one persistent element
  // on #selection -- the host of EVERY occupant sheet, unit/item AND the four place panels -- and
  // clicking a tab switches the sheet underneath without re-clicking the map. The old chooser machinery
  // (renderChooser/chooseCandidate/chooserState) is RETAINED, not deleted -- it is still reachable
  // directly (DFTileList.renderChooser) and pins the item-sibling routing fixture -- but
  // consumeInspect no longer routes multi-occupant clicks through it.
  var occupantSession = null;   // { candidates:[{kind,id,label,icon,...art}], activeKey:'kind:id', pixel }

  function candKey(c) { return String(c && c.kind) + ':' + Number(c && c.id); }

  // B224: the rail DOM is owned by the SESSION, not by whichever sheet is up. These helpers remove
  // it explicitly; nothing else may orphan it. (#clientPanel scrub covers pre-B224 leftovers only.)
  function railWrapOf(host) {
    try {
      return host && typeof host.querySelector === 'function'
        ? host.querySelector('.occupant-tabs-wrap') : null;
    } catch (_) { return null; }
  }
  function removeRail(host) {
    var wrap = railWrapOf(host);
    if (wrap && wrap.parentNode) { try { wrap.parentNode.removeChild(wrap); } catch (_) {} }
    if (host && host.classList) { try { host.classList.remove('has-occupant-rail'); } catch (_) {} }
  }
  function scrubRails() {
    try { removeRail(document.getElementById('selection')); } catch (_) {}
    try { removeRail(document.getElementById('clientPanel')); } catch (_) {}
  }
  function clearOccupantSession() { occupantSession = null; scrubRails(); }

  // Signature of what the rail should currently show: entry set + per-entry art + active tab. The
  // injector rebuilds only when this changes, so a sheet's own periodic re-render costs a string
  // compare, and a click on the SAME tab never destroys the buttons mid-event.
  function occupantSig(session) {
    var parts = [];
    var cs = (session && session.candidates) || [];
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i] || {};
      parts.push(candKey(c) + (c.spriteRef ? '+r' : '') + (c.spriteToken ? '+t' + c.spriteToken : '') +
        (c.iconKey || (c.icon && (c.icon.key || c.icon.sheet)) ? '+i' : ''));
    }
    return parts.join('|') + '||' + String(session && session.activeKey);
  }

  // Does the sheet ON SCREEN belong to the session's active candidate? A className write by any
  // renderer wipes `has-occupant-rail`; the injector heals it only when the shown content matches,
  // so a foreign sheet (a unit opened from chat, an item opened from Stocks) never wears our rail
  // -- and an in-flight rail switch (old sheet still up) leaves the rail exactly as it is.
  function shownMatchesActive(host, cand) {
    if (!host || !host.classList || !cand) return false;
    var kind = String(cand.kind || '').toLowerCase();
    if (kind === 'unit') {
      if (!host.classList.contains('unit-sheet-panel')) return false;
      var d = currentSheetData();
      return !!(d && d.unit && Number(d.unit.id) === Number(cand.id));
    }
    if (kind === 'item') {
      if (!host.classList.contains('stock-item-panel')) return false;
      var sid = null;
      try { sid = host.dataset ? host.dataset.dfcItemId : null; } catch (_) {}
      if (sid == null) { try { sid = host.getAttribute && host.getAttribute('data-dfc-item-id'); } catch (_) {} }
      return sid != null && Number(sid) === Number(cand.id);
    }
    if (kind === 'engraving') {
      try { return !!host.querySelector('.engraving-window'); } catch (_) { return false; }
    }
    // Place kinds (workshop/building/stockpile/zone): match on the place-panel FAMILY, not the id.
    // Deliberate: openBuildingPanel legitimately DELEGATES (bed -> its barracks zone panel, depot
    // building -> the trade-depot panel), so an id-strict guard would kill the rail on exactly the
    // panels those occupants open. Every place variant carries building-panel or stockpile-panel.
    return host.classList.contains('building-panel') || host.classList.contains('stockpile-panel');
  }

  function activeCandidate() {
    if (!occupantSession) return null;
    var cs = occupantSession.candidates || [], k = occupantSession.activeKey;
    for (var i = 0; i < cs.length; i++) if (candKey(cs[i]) === k) return cs[i];
    return null;
  }

  // B224: EVERY occupant sheet renders into #selection -- unit sheets (showUnitSheet), item sheets
  // (showStockItemSheet) AND all four place panels (openBuildingPanel/openWorkshopPanel/
  // openZonePanel/openStockpilePanel all write `selection.className = "visible ..."`, verified in
  // dwf-building-zone-stockpile-panels.js). B219's kind->host mapping sent place occupants to
  // #clientPanel -- a panel that never hosts them -- so selecting a place from the rail injected the
  // strip into a hidden element and the rail VANISHED ("when you click on one it doesnt keep the
  // same side rail flow"). One host means the rail is ONE persistent element that stays put while
  // the sheet underneath swaps.
  function activeHostEl() {
    try { return document.getElementById('selection'); } catch (_) { return null; }
  }

  function contentElOf(host) {
    try {
      if (window.DFPanelFrame && typeof window.DFPanelFrame.contentEl === 'function')
        return window.DFPanelFrame.contentEl(host);
    } catch (_) {}
    return host;
  }

  // B224 SPRITES: one resolver per occupant KIND, each through the art channel its sheet already
  // uses -- never a letter, and an unresolvable identity FAILS LOUD (empty tile +
  // data-df-identity-missing), matching the F10 iconHtml doctrine.
  //   unit      -> /unit-portrait?mode=icon (the same portrait pipeline as the unit sheet; a 404 is
  //                marked by the error wiring in wireOccupantTabs).
  //   item      -> DWFUI.iconHtml({item: spriteRef}) -- the wire ref from /tile-occupants (B224
  //                server half) or backfilled by the open item sheet via noteOccupantArt.
  //   stockpile -> DWFUI.iconHtml({sprite: STOCKPILE_ICON_*}) -- the wire token (same derivation as
  //                the item sheet's location row, interaction.cpp stockpile_icon_token).
  //   zone/building/workshop -> the Places-row art channel (infoPlaceIconMarkup over
  //                activity_zones.png / building_icons.png; build-info-panels is a plain script so
  //                the builder is a global). Wire fields first; keyword fallback for buildings on
  //                old hosts; then fail-loud.
  function placeIconRow(c, kind) {
    if (c && c.icon && String(c.icon.sheet || '') === 'zone' &&
        isFinite(Number(c.icon.x)) && isFinite(Number(c.icon.y)))
      return { iconSheet: 'zone', iconX: Number(c.icon.x), iconY: Number(c.icon.y) };
    var key = c && (c.iconKey || (c.icon && c.icon.key));
    if (key) return { iconKey: String(key) };
    // Old host (no /tile-occupants art fields): derive a building icon from the label keywords,
    // the same fallback the build menu itself uses (itemIconName). Never guesses across kinds.
    if ((kind === 'workshop' || kind === 'building') && typeof itemIconName === 'function') {
      try {
        var kw = itemIconName({ label: String(c && c.label || '') });
        if (kw) return { iconKey: kw };
      } catch (_) {}
    }
    return null;
  }
  function occupantIconHtml(c) {
    // Controlled review fixtures may carry already-resolved, real DF composite markup. Production
    // wire rows never send HTML; live candidates continue through the URL/item channels below.
    if (c && typeof c.iconHtml === 'string' && c.iconHtml) return c.iconHtml;
    var kind = String(c && c.kind || '').toLowerCase();
    if (kind === 'unit') {
      return '<img class="occupant-unit-icon" src="/unit-portrait?id=' + encodeURIComponent(Number(c.id)) +
        '&mode=icon" alt="" draggable="false">';
    }
    try {
      if (window.DWFUI && typeof window.DWFUI.iconHtml === 'function') {
        if (kind === 'item') return window.DWFUI.iconHtml({ item: c && c.spriteRef,
          cls: 'dwfui-occupant-icon', size: 28, alt: String(c && c.label || 'Item') });
        if (c && c.spriteToken) return window.DWFUI.iconHtml({ sprite: String(c.spriteToken),
          cls: 'dwfui-occupant-icon', size: 28, alt: String(c.label || kind) });
        if (typeof infoPlaceIconMarkup === 'function') {
          var row = placeIconRow(c, kind);
          if (row) {
            var markup = infoPlaceIconMarkup(row);
            if (markup) return markup;
          }
        }
        return window.DWFUI.iconHtml({ emptyTile: false, cls: 'dwfui-occupant-icon', size: 28,
          alt: String(c && c.label || kind || 'Occupant') });
      }
    } catch (_) {}
    return '';
  }

  // Pure config for DWFUI's native icon-only rail. Native Steam DF attaches this vertically to the
  // OUTSIDE right edge of the information frame; it is not a horizontal text-tab family.
  function occupantTabsCfg(session) {
    session = session || occupantSession;
    if (!session || !Array.isArray(session.candidates)) return null;
    return {
      dataAttr: 'occupant-tab',
      ariaLabel: 'Occupants on this tile', active: session.activeKey,
      tabs: session.candidates.map(function (c) {
        return { key: candKey(c), title: String(c.label || c.kind), iconHtml: occupantIconHtml(c) };
      }),
    };
  }

  function occupantStripHtml(session) {
    var cfg = occupantTabsCfg(session);
    if (!cfg) return '';
    try {
      if (window.DWFUI && typeof window.DWFUI.occupantRailHtml === 'function')
        return window.DWFUI.occupantRailHtml(cfg);
    } catch (_) {}
    return '';   // DWFUI loads first in index.html; no hand-rolled fallback (drift rule R2)
  }

  function wireOccupantTabs(wrap) {
    var btns = (wrap && typeof wrap.querySelectorAll === 'function')
      ? wrap.querySelectorAll('[data-occupant-tab]') : [];
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var key = btn.getAttribute('data-occupant-tab');
        var cs = (occupantSession && occupantSession.candidates) || [];
        for (var j = 0; j < cs.length; j++) if (candKey(cs[j]) === key) { switchToOccupant(cs[j]); return; }
      });
    })(btns[i]);
    // Unit portrait 404s (portrait not yet generated) FAIL LOUD like every other channel: one
    // cache-busted retry (the portrait sweep populates texpos lazily), then the identity-missing
    // marker on the tab -- the button's native dark tile is the empty-tile look, never a letter.
    var imgs = (wrap && typeof wrap.querySelectorAll === 'function')
      ? wrap.querySelectorAll('img.occupant-unit-icon') : [];
    for (var k = 0; k < imgs.length; k++) (function (img) {
      if (!img.addEventListener) return;
      var retried = false;
      img.addEventListener('error', function () {
        if (!retried) {
          retried = true;
          try { img.src = img.src.replace(/&_=\d+$/, '') + '&_=' + Date.now(); } catch (_) {}
          return;
        }
        try {
          if (img.parentNode && img.parentNode.setAttribute)
            img.parentNode.setAttribute('data-df-identity-missing', 'unit-portrait');
          if (img.parentNode) img.parentNode.removeChild(img);
        } catch (_) {}
      });
    })(imgs[k]);
  }

  // Inject / refresh the occupant rail on #selection. Driven by the MutationObserver so it survives
  // every sheet re-render. THE LIFECYCLE CONTRACT (B224):
  //   * the wrap is a DIRECT child of #selection, a SIBLING of .pf-content -- renderers write into
  //     .pf-content, so the wrap DOM survives every sheet swap;
  //   * every renderer wipes the host's className, taking `has-occupant-rail` with it -- the
  //     injector HEALS the class on every matching render (the pre-B224 injector early-returned on
  //     "wrap exists", leaving the rail clipped invisible after the FIRST tab switch: the "when
  //     you click on the second or third item the whole rail disappears");
  //   * markup is rebuilt only when occupantSig changes (entry set / art / active tab);
  //   * a non-matching sheet gets NO heal -- the class stays off, so the rail is hidden on foreign
  //     sheets and re-appears untouched when a session sheet returns.
  function injectOccupantTabs() {
    var session = occupantSession;
    if (!session || !Array.isArray(session.candidates) || session.candidates.length < 2) return;
    var cand = activeCandidate();
    if (!cand) return;
    var host = activeHostEl();
    if (!host || !host.classList || !host.classList.contains('visible')) return;
    if (!shownMatchesActive(host, cand)) return;
    if (typeof host.querySelector !== 'function') return;
    var sig = occupantSig(session);
    var wrap = railWrapOf(host);
    if (wrap && wrap.getAttribute && wrap.getAttribute('data-occupant-sig') === sig) {
      host.classList.add('has-occupant-rail');   // heal the renderer's className wipe
      return;
    }
    var html = occupantStripHtml(session);
    if (!html) return;
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'occupant-tabs-wrap';
      host.appendChild(wrap);
    }
    try { wrap.innerHTML = html; } catch (_) { return; }
    try { if (wrap.setAttribute) wrap.setAttribute('data-occupant-sig', sig); } catch (_) {}
    host.classList.add('has-occupant-rail');
    wireOccupantTabs(wrap);
    // Item / sprite-token icons are inert strings until the explicit DOM blit pass runs (DWFUI
    // string-only contract). The pre-B224 injector NEVER ran it -- one of the two reasons every
    // rail icon rendered blank.
    try {
      if (window.DWFUI && typeof window.DWFUI.paintSprites === 'function') window.DWFUI.paintSprites(wrap);
    } catch (_) {}
  }

  // Open a candidate's sheet. All occupant sheets share #selection (see activeHostEl), and each
  // opener re-renders that host itself, so switching NEVER closes anything first: the old sheet
  // stays up until the new one's data arrives (no blank flash, no `visible` gap for the session's
  // close-observer to misread), and #clientPanel -- which hosts info/build panels, not occupants --
  // is no longer collaterally closed by a rail switch (pre-B224 openRoute closed it every time).
  function openRoute(route) {
    if (!route) return false;
    if (route.flow === 'unit') { switchTo(route.id, null); return true; }
    if (route.flow === 'item') {
      try { if (typeof openItemPanel === 'function') openItemPanel(route.id, null); } catch (_) {}
      return true;
    }
    if (route.flow === 'engraving') {
      try { if (typeof openEngravingPanel === 'function') openEngravingPanel(route.tile, null); } catch (_) {}
      return true;
    }
    try { if (typeof openInfoPlace === 'function') openInfoPlace(route.kind, route.id); } catch (_) {}
    return true;
  }

  // B208-REOPEN: CLICK-OPEN PRECEDENCE -- which occupant a multi-occupant tile-click OPENS. This is
  // DISTINCT from the strip's native DISPLAY order (units, then buildings, then stockpiles/zones,
  // then items -- the /tile-occupants construction order and buildCandidates' sort, which B80 pins
  // and the tab strip preserves). Round 1 conflated the two: it opened candidates[0], and both
  // ordering sources list a stockpile BEFORE the item resting on it, so an item click opened the
  // STOCKPILE screen. Physically a stockpile/zone is a floor DESIGNATION beneath the item; native DF
  // opens the ITEM sheet (which carries its own "view stockpile" section) and never lets the
  // designation steal the click. Precedence, top layer first: unit > building/workshop > item >
  // stockpile/zone. Ties keep native display order (first-encountered wins -> lowest-id unit, etc.).
  // A LONE stockpile is a single candidate, so it never reaches here -- it still one-clicks (B164).
  var OPEN_PRECEDENCE = { unit: 0, workshop: 1, building: 1, item: 2, engraving: 3,
                          stockpile: 4, zone: 4 };
  function openRank(c) {
    var k = String(c && c.kind);
    return Object.prototype.hasOwnProperty.call(OPEN_PRECEDENCE, k) ? OPEN_PRECEDENCE[k] : 9;
  }
  function topOccupant(candidates) {
    var best = null, bestRank = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var r = openRank(candidates[i]);
      if (r < bestRank) { bestRank = r; best = candidates[i]; }   // strict < keeps display order on ties
    }
    return best;
  }

  // Establish the session and open the TOP-layer occupant immediately. `candidates` keeps its array
  // identity so refreshTileOccupants can tell whether the world changed under the in-flight request.
  function openTopOccupant(candidates, pixel) {
    if (!Array.isArray(candidates) || candidates.length < 2) return false;
    var top = topOccupant(candidates), route = top && routeForCandidate(top);
    if (!route) return false;
    chooserState = null;
    occupantSession = { candidates: candidates, activeKey: candKey(top), pixel: pixel || null };
    openRoute(route);
    return true;
  }

  function switchToOccupant(candidate) {
    if (!occupantSession || !candidate) return;
    var route = routeForCandidate(candidate);
    if (!route) return;
    occupantSession.activeKey = candKey(candidate);
    openRoute(route);
    injectOccupantTabs();
    // B224: occupants can change while the rail is up (a unit walks off, an item is hauled away).
    // Each switch re-reads /tile-occupants at click-time cost; adoptAuthoritativeOccupants keeps
    // the shown occupant when it survives and falls back by open-precedence when it vanished.
    if (occupantSession.pixel) refreshTileOccupants(occupantSession.pixel, occupantSession.candidates);
  }

  // B224: sheets that already hold an occupant's art hand it to the session, so the rail resolves
  // on hosts that predate the /tile-occupants art fields (the item sheet's own spriteRef, and its
  // location row's STOCKPILE_ICON_* token for the pile beneath it). A merge that changes the art
  // changes occupantSig, so the observer's next pass repaints the rail.
  function noteOccupantArt(kind, id, art) {
    if (!occupantSession || !art) return;
    var key = String(kind || '').toLowerCase() + ':' + Number(id);
    var cs = occupantSession.candidates || [];
    for (var i = 0; i < cs.length; i++) {
      if (candKey(cs[i]) !== key) continue;
      if (art.spriteRef && !cs[i].spriteRef) cs[i].spriteRef = art.spriteRef;
      if (art.spriteToken && !cs[i].spriteToken) cs[i].spriteToken = art.spriteToken;
      injectOccupantTabs();
      return;
    }
  }

  // The authoritative /tile-occupants list (real item ids, native display order) refines the strip.
  // Keep the already-open occupant shown when it survives (no flicker); re-open only when it is gone.
  function adoptAuthoritativeOccupants(occ) {
    if (!occupantSession || !Array.isArray(occ) || occ.length < 2) return;
    occupantSession.candidates = occ;
    var prev = occupantSession.activeKey, stillThere = false;
    for (var i = 0; i < occ.length; i++) if (candKey(occ[i]) === prev) { stillThere = true; break; }
    if (stillThere) { injectOccupantTabs(); return; }   // sig change -> in-place rebuild, no rip-out gap
    // The shown occupant vanished (world changed): re-open by the SAME click-open precedence, never
    // occ[0] -- occ[0] is the native display top (a stockpile floor) and would re-steal the click.
    var top = topOccupant(occ) || occ[0];
    occupantSession.activeKey = candKey(top);
    openRoute(routeForCandidate(top));
  }

  function renderChooser(candidates) {
    var sel = document.getElementById('selection');
    if (!sel) return false;
    chooserState = { candidates: candidates, index: 0 };
    sel.className = 'visible tile-list-panel';
    // WT07 M8 content-wrapper seam: write into the .pf-content child so the persistent framework
    // header/grips on #selection survive this tile-occupant chooser render.
    var content = (typeof window !== "undefined" && window.DFPanelFrame && window.DFPanelFrame.contentEl)
      ? window.DFPanelFrame.contentEl(sel) : sel;
    if (typeof content.querySelectorAll === "function" && "innerHTML" in content) {
      content.innerHTML = tileListMarkup(candidates);
      var renderedRows = Array.from(content.querySelectorAll("[data-tile-candidate]"));
      renderedRows.forEach(function (row) {
        var candidate = candidates[Number(row.dataset.tileCandidate)];
        if (!candidate) return;
        row.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); chooseCandidate(candidate, candidates); });
      });
      if (renderedRows.length === candidates.length) return true;
      // Minimal fixture/legacy DOMs can expose innerHTML without parsing it into child nodes.
      // Fall through to the DOM-node builder so the retained chooser remains functional there.
    }
    content.textContent = '';
    var box = document.createElement('div'); box.className = 'tile-list';
    var title = document.createElement('div'); title.className = 'tile-list-title';
    title.innerHTML = window.DWFUI.statusHtml({ tag: 'span', cls: 'tile-list-title-copy', text: 'Select tile occupant' });
    box.appendChild(title);
    for (var i = 0; i < candidates.length; i++) (function (candidate) {
      var row = document.createElement('button'); row.type = 'button'; row.className = 'tile-list-row';
      // Same icon channel as tileListMarkup/the rail -- never the identity-LETTER path.
      var icon = document.createElement('span'); icon.className = 'tile-list-icon';
      try { icon.innerHTML = occupantIconHtml(candidate); } catch (_) { icon.textContent = ''; }
      var label = document.createElement('span'); label.textContent = candidate.label || candidate.kind;
      var kind = document.createElement('span'); kind.className = 'tile-list-kind'; kind.textContent = candidate.kind;
      row.appendChild(icon); row.appendChild(label); row.appendChild(kind);
      // B205: every candidate that reaches the chooser is openable now -- the id-less "(host
      // update needed)" placeholder that was the only source of a disabled/dead row is gone.
      row.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); chooseCandidate(candidate, candidates); });
      box.appendChild(row);
    })(candidates[i]);
    content.appendChild(box);
    return true;
  }

  // B80: a current host can resolve every exact-tile item id without widening the stream. Keep
  // the cache list visible while this click-time request runs; old hosts return 404 (or fetch can
  // fail), in which case the cache-derived chooser remains the compatibility fallback.
  function routeCandidates(payload) {
    var raw = payload && Array.isArray(payload.occupants) ? payload.occupants : [];
    var out = [], kinds = { unit: 1, workshop: 1, building: 1, stockpile: 1, zone: 1, item: 1,
                            engraving: 1 };
    for (var i = 0; i < raw.length; i++) {
      var row = raw[i] || {}, kind = String(row.kind || '').toLowerCase(), id = Number(row.id);
      if (!kinds[kind] || (kind !== 'engraving' && (!isFinite(id) || id < 0))) continue;
      out.push({ kind: kind, id: id, label: String(row.name || (kind + ' ' + id)),
        // B224 art fields (absent on pre-B224 hosts; occupantIconHtml degrades per kind):
        // spriteRef (item), spriteToken (stockpile), icon {sheet,x,y|key} (zone/building/workshop).
        spriteRef: row.spriteRef || null,
        spriteToken: row.spriteToken || null,
        tile: kind === 'engraving' && payload.tile ? payload.tile : null,
        icon: row.icon && typeof row.icon === 'object' ? row.icon
          : (kind === 'unit' ? '@' : kind === 'item' ? '*' : '#') });
    }
    return out;
  }

  // B224: which occupant did the caller's NORMAL single-occupant path just open for this inspect?
  function openedKeyFromInspect(data) {
    var kind = String(data && data.kind || '').toLowerCase();
    if (kind === 'unit' && data.unit && isFinite(Number(data.unit.id))) return 'unit:' + Number(data.unit.id);
    if (kind === 'item' && Number(data.itemId) >= 0) return 'item:' + Number(data.itemId);
    if (kind === 'engraving' && data.tile) return 'engraving:-1';
    if ((kind === 'stockpile' || kind === 'zone' || kind === 'workshop' || kind === 'building') &&
        Number(data.buildingId) >= 0) return kind + ':' + Number(data.buildingId);
    return null;
  }

  // B224 DISCOVERY: the AUX cache is BLIND to co-located loose items (the tile stream carries only
  // an id-less top-item tail -- B205), so a corpse pile / several bars on BARE floor produced ONE
  // cache candidate, consumeInspect stood aside, and the other items were unreachable: no rail, no
  // chooser, nothing. The authoritative /tile-occupants route (B80) knows all of them -- so a
  // single-candidate click still asks it, and when it reports >=2 occupants the session is created
  // AROUND the sheet the normal path already opened (activeKey = that occupant; NOTHING re-opens,
  // no flicker). A lone occupant stays lone (B164: no session), and old hosts 404 into silence.
  function discoverOccupants(data, pixel) {
    var opened = openedKeyFromInspect(data);
    if (!opened || !pixel || typeof fetch !== 'function') return;
    var px = Number(pixel.x), py = Number(pixel.y), w = Number(pixel.w), h = Number(pixel.h);
    if (!isFinite(px) || !isFinite(py) || !(w > 0) || !(h > 0)) return;
    var request = ++occupantRequest, pl = routingPlayer();
    fetch('/tile-occupants?player=' + encodeURIComponent(pl) + '&px=' + encodeURIComponent(px) +
          '&py=' + encodeURIComponent(py) + '&w=' + encodeURIComponent(w) + '&h=' + encodeURIComponent(h) +
          '&t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw new Error('tile occupants unavailable'); return response.json(); })
      .then(function (payload) {
        if (request !== occupantRequest || occupantSession) return;   // a later click owns the flow
        var occ = routeCandidates(payload);
        if (occ.length < 2) return;
        for (var i = 0; i < occ.length; i++) {
          if (candKey(occ[i]) !== opened) continue;
          occupantSession = { candidates: occ, activeKey: opened, pixel: pixel };
          injectOccupantTabs();
          return;
        }
      })
      .catch(function () { /* old host / error: single-occupant behaviour stands */ });
  }

  var occupantRequest = 0;
  function refreshTileOccupants(pixel, cached) {
    if (!pixel || typeof fetch !== 'function') return;
    var px = Number(pixel.x), py = Number(pixel.y), w = Number(pixel.w), h = Number(pixel.h);
    if (!isFinite(px) || !isFinite(py) || !(w > 0) || !(h > 0)) return;
    var request = ++occupantRequest, pl = routingPlayer();
    fetch('/tile-occupants?player=' + encodeURIComponent(pl) + '&px=' + encodeURIComponent(px) +
          '&py=' + encodeURIComponent(py) + '&w=' + encodeURIComponent(w) + '&h=' + encodeURIComponent(h) +
          '&t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw new Error('tile occupants unavailable'); return response.json(); })
      .then(function (payload) {
        var candidates = routeCandidates(payload);
        // Do not refine if the world changed while the request was in flight (the cache-derived
        // occupant session remains the graceful fallback). Old hosts 404 -> the cache list stands.
        if (request !== occupantRequest || candidates.length < 2 || !occupantSession || occupantSession.candidates !== cached) return;
        adoptAuthoritativeOccupants(candidates);
      })
      .catch(function () { /* 404/error: retain the cache-derived occupant session for older hosts. */ });
  }

  function consumeInspect(data, pixel) {
    var latest = null;
    try { latest = window.DwfTiles && typeof DwfTiles.getLatest === 'function' ? DwfTiles.getLatest() : null; } catch (_) {}
    var candidates = buildCandidates(data, latest);
    // Single occupant -> the caller's existing selection path handles it byte-for-byte. Clear any
    // stale occupant session so its strip cannot linger onto the next sheet -- but still ask the
    // authoritative route whether the tile holds MORE than the cache could see (B224 discovery:
    // corpse piles / item stacks on bare floor are invisible to the id-less AUX tail).
    if (candidates.length < 2) { clearOccupantSession(); discoverOccupants(data, pixel); return false; }
    // B208: open the TOP-layer occupant immediately (no chooser list step) and attach the tab strip.
    if (!openTopOccupant(candidates, pixel)) return false;
    refreshTileOccupants(pixel, candidates);
    return true;
  }

  window.DFTileList = { consumeInspect: consumeInspect, buildCandidates: buildCandidates,
    routeCandidates: routeCandidates, routeForCandidate: routeForCandidate,
    nextChooserIndex: nextChooserIndex, renderChooser: renderChooser,
    switchToOccupant: switchToOccupant, occupantTabsCfg: occupantTabsCfg,
    injectOccupantTabs: injectOccupantTabs, adoptAuthoritativeOccupants: adoptAuthoritativeOccupants,
    getOccupantSession: function () { return occupantSession; },
    clearOccupantSession: clearOccupantSession, noteOccupantArt: noteOccupantArt,
    tileListMarkup: tileListMarkup, unitCycleMarkup: unitCycleMarkup };

  var busy = false;
  function switchTo(id, units) {
    if (busy) return;
    busy = true;
    var pl = routingPlayer();
    fetch("/unit?player=" + encodeURIComponent(pl) + "&id=" + encodeURIComponent(id) +
          "&t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("unit fetch failed"); return r.json(); })
      .then(function (d) {
        if (d && units) d.unitCycle = units.map(function (u) { return u.id; });
        try { if (typeof showUnitSheet === "function") showUnitSheet(d); } catch (_) {}
      })
      .catch(function () { /* leave the current sheet in place on any failure */ })
      .then(function () { busy = false; });
  }

  function inject() {
    var sel = document.getElementById("selection");
    if (!sel || !sel.classList.contains("unit-sheet-panel")) return;
    var sheet = sel.querySelector(".unit-sheet");
    if (!sheet || sheet.querySelector(".unit-cycle")) return;   // already injected this render

    var data = currentSheetData();
    if (!data || !data.unit) return;
    // B208: when an occupant session owns THIS unit, the occupant tab strip is the switcher --
    // suppress the older same-tile unit-cycle bar so the two switchers never overlap.
    if (occupantSession && Array.isArray(occupantSession.candidates) && occupantSession.candidates.length >= 2) {
      var ac = activeCandidate() || {};
      if (String(ac.kind).toLowerCase() === "unit" && Number(ac.id) === Number(data.unit.id)) return;
    }
    var units = cycleListFor(data);
    if (units.length < 2) return;

    var curId = Number(data.unit.id);
    var idx = 0;
    for (var i = 0; i < units.length; i++) if (units[i].id === curId) { idx = i; break; }

    var bar = document.createElement("div");
    bar.className = "unit-cycle";
    bar.innerHTML = unitCycleMarkup(idx, units.length);

    var header = sheet.querySelector(".unit-sheet-header");
    if (header && header.nextSibling) sheet.insertBefore(bar, header.nextSibling);
    else if (header) sheet.appendChild(bar);
    else sheet.insertBefore(bar, sheet.firstChild);

    var btns = bar.querySelectorAll("[data-cyc]");
    for (var b = 0; b < btns.length; b++) {
      btns[b].addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var dir = Number(this.getAttribute("data-cyc")) || 1;
        var ni = (idx + dir + units.length) % units.length;
        if (units[ni]) switchTo(units[ni].id, units);
      });
    }
  }

  // Keyboard Tab / Shift+Tab cycles while a unit sheet is open (matches DF). Capture phase so
  // it wins over the page's own focus/keymap handling, and only when a multi-unit sheet is up.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Tab") return;
    // Never hijack Tab out of an editable control (place panels carry search fields).
    var t = e.target;
    if (t && (String(t.tagName).toUpperCase() === "INPUT" || String(t.tagName).toUpperCase() === "TEXTAREA" || t.isContentEditable)) return;
    var sel = document.getElementById("selection");
    if (sel && sel.classList.contains("tile-list-panel") && chooserState && chooserState.candidates.length) {
      e.preventDefault(); e.stopPropagation();
      chooserState.index = nextChooserIndex(chooserState.index, chooserState.candidates.length, e.shiftKey ? -1 : 1);
      chooseCandidate(chooserState.candidates[chooserState.index], chooserState.candidates);
      return;
    }
    // B224: while the occupant rail is LIVE (session sheet up, rail healed), Tab / Shift+Tab walk
    // the rail's entries in display order -- ALL kinds, matching the tab strip, not just same-tile
    // units. Pre-B224 this branch was missing, so Tab on a unit sheet cycled the unit-only list and
    // desynced the rail's active tab.
    if (occupantSession && sel && sel.classList.contains("visible") && sel.classList.contains("has-occupant-rail")) {
      var cs = occupantSession.candidates || [];
      if (cs.length >= 2) {
        e.preventDefault(); e.stopPropagation();
        var cur = 0;
        for (var ci = 0; ci < cs.length; ci++) if (candKey(cs[ci]) === occupantSession.activeKey) { cur = ci; break; }
        var nx = (cur + (e.shiftKey ? -1 : 1) + cs.length) % cs.length;
        switchToOccupant(cs[nx]);
        return;
      }
    }
    if (!sel || !sel.classList.contains("visible") || !sel.classList.contains("unit-sheet-panel")) return;
    var data = currentSheetData();
    if (!data || !data.unit) return;
    var units = cycleListFor(data);
    if (units.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    var curId = Number(data.unit.id);
    var idx = 0;
    for (var i = 0; i < units.length; i++) if (units[i].id === curId) { idx = i; break; }
    var dir = e.shiftKey ? -1 : 1;
    var ni = (idx + dir + units.length) % units.length;
    if (units[ni]) switchTo(units[ni].id, units);
  }, true);

  function start() {
    var target = document.getElementById("selection");
    if (!target) { setTimeout(start, 200); return; }   // #selection not in the DOM yet
    try {
      var obs = new MutationObserver(function () { inject(); injectOccupantTabs(); });
      obs.observe(target, { childList: true, subtree: true });
      // B224: every occupant sheet (unit/item AND place panels) renders into #selection, so this is
      // the only childList observer the rail needs. A separate ATTRIBUTE observer ends the session
      // when the host actually CLOSES (Esc / the framework X / a failed open -> `visible` removed):
      // rail switches never drop `visible` (openRoute no longer pre-closes), so a missing `visible`
      // means the flow is over and the rail must not linger or resurrect on the next unrelated sheet.
      var obsClose = new MutationObserver(function () {
        if (occupantSession && target.classList && !target.classList.contains("visible"))
          clearOccupantSession();
      });
      obsClose.observe(target, { attributes: true, attributeFilter: ["class"] });
    } catch (_) { /* no MutationObserver -> Tab-key path still works */ }
    inject();
    injectOccupantTabs();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
