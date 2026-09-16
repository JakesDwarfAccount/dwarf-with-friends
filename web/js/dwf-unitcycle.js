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

// Tile-occupant cycling: the occupant rail, its overflow list sheets, and the unit-sheet Tab cycle.
(function () {
  "use strict";

  if (window.DWFUI && typeof window.DWFUI.require === "function") window.DWFUI.require("occupant-navigation", [
    "esc", "cyclerHtml", "iconHtml", "occupantListHtml", "occupantRailHtml", "rowHtml", "scrollHtml", "statusHtml",
  ]);

  function currentSheetData() {
    try { if (typeof selectedUnitData !== "undefined" && selectedUnitData) return selectedUnitData; }
    catch (err) { DwfErr.report("unitcycle.current-sheet", err); }
    return null;
  }

  function unitsOnTile(tile) {
    if (!tile) return [];
    var tx = Number(tile.x), ty = Number(tile.y), tz = Number(tile.z);
    if (!isFinite(tx) || !isFinite(ty) || !isFinite(tz)) return [];
    var all = [];
    try {
      all = (window.DwfTiles && typeof DwfTiles.getLatest === "function" &&
        (DwfTiles.getLatest() || {}).units) || [];
    } catch (err) { DwfErr.report("unitcycle.live-units", err); all = []; }
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var u = all[i];
      if (u && Number(u.x) === tx && Number(u.y) === ty && Number(u.z) === tz) {
        out.push({ id: Number(u.id), name: String(u.name || "") });
      }
    }
    return out;
  }

  // Older hosts send no unitCycle, so the AUX exact-tile fallback must stay; the 3x3 widening is
  // only for a clicked tile that resolved nothing.
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

  // The wire carries only a tile's top item and no item id, so an item is selectable only when
  // /inspect supplied an authoritative id; the rest render as a disabled tail row.
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
      var uid = unitIds[j];
      var isOpened = !!(data.unit && Number(data.unit.id) === uid);
      var ur = unitById[uid] || (isOpened ? data.unit : {});
      add({ kind: 'unit', id: uid, icon: '@',
        label: String(ur.name || (isOpened && data.title) || ('Unit ' + uid)) });
    }
    var rawBuildings = Array.isArray(latest.buildings) ? latest.buildings : [];
    for (var k = 0; k < rawBuildings.length; k++) {
      var b = rawBuildings[k], bid = Number(b && b.id);
      if (!b || !isFinite(bid) || bid < 0 || Number(b.z) !== z || x < Number(b.x1) || x > Number(b.x2) || y < Number(b.y1) || y > Number(b.y2)) continue;
      var type = String(b.type || 'Building');
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
    if (String(data.kind || '').toLowerCase() === 'vermin')
      add({ kind: 'vermin', id: -1, label: String(data.title || 'Vermin'), tile: tile,
        creatureToken: data.verminToken || '', casteToken: data.verminCasteToken || '',
        description: data.description || '' });
    if (String(data.kind || '').toLowerCase() === 'planned-engraving')
      add({ kind: 'planned-engraving', id: -1, label: String(data.title || 'Planned engraving'), tile: tile,
        spriteToken: 'DESIGNATION_ENGRAVE' });
    var rank = { unit: 0, workshop: 1, building: 1, stockpile: 1, zone: 1, item: 2,
                 vermin: 3, 'planned-engraving': 4, engraving: 5 };
    out.sort(function (a, b) { var ar = Object.prototype.hasOwnProperty.call(rank, a.kind) ? rank[a.kind] : 9; var br = Object.prototype.hasOwnProperty.call(rank, b.kind) ? rank[b.kind] : 9; return ar - br || Number(a.id || 0) - Number(b.id || 0); });
    return out;
  }

  function routeForCandidate(candidate) {
    if (!candidate || candidate.disabled) return null;
    var kind = String(candidate.kind || '').toLowerCase();
      // An overflow cell carries no entity id (-1); its sheet is the full-panel list over the members.
    if (kind === 'unit-list' || kind === 'item-list') {
      if (!Array.isArray(candidate.entries) || !candidate.entries.length) return null;
      return { flow: 'list', cell: candidate };
    }
    if (kind === 'engraving') {
      var engravingTile = candidate.tile || {};
      if (!isFinite(Number(engravingTile.x)) || !isFinite(Number(engravingTile.y)) || !isFinite(Number(engravingTile.z))) return null;
      return { flow: 'engraving', tile: { x: Number(engravingTile.x), y: Number(engravingTile.y), z: Number(engravingTile.z) } };
    }
    if (kind === 'vermin' || kind === 'planned-engraving') {
      var tile = candidate.tile || {};
      if (!isFinite(Number(tile.x)) || !isFinite(Number(tile.y)) || !isFinite(Number(tile.z))) return null;
      var mapped = { flow: kind, tile: { x: Number(tile.x), y: Number(tile.y), z: Number(tile.z) } };
      if (kind === 'vermin') mapped.data = candidate;
      return mapped;
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
      window.DWFUI.scrollHtml({ cls: "tile-list-rows", rows: ".tile-list-row", ariaLabel: "Tile occupants" }, rows) + '</div>';
  }

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
      var siblings = (candidates || []).filter(function (c) {
        return c.kind === 'item' && !c.disabled && isFinite(Number(c.id)) && Number(c.id) >= 0;
      }).map(function (c) {
        return { id: Number(c.id), name: String(c.label || ('Item ' + c.id)), spriteRef: c.spriteRef || null };
      });
      try { if (typeof openItemPanel === 'function') openItemPanel(route.id, siblings.length > 1 ? siblings : null); }
      catch (err) { DwfErr.report("unitcycle.open-item", err); }
      return;
    }
    if (route.flow === 'engraving') {
      try { if (typeof openEngravingPanel === 'function') openEngravingPanel(route.tile, null); }
      catch (err) { DwfErr.report("unitcycle.open-engraving", err); }
      return;
    }
    try { if (typeof openInfoPlace === 'function') openInfoPlace(route.kind, route.id); }
    catch (err) { DwfErr.report("unitcycle.open-place", err); }
  }

  // ---- the tile-occupant rail, and the list sheets as its overflow -------------------------------
  var occupantSession = null;   // { candidates:[...], cells:[...], law:{...}, active, activeKey, pixel }

  function candKey(c) { return String(c && c.kind) + ':' + Number(c && c.id); }
  function kindOf(c) { return String(c && c.kind || '').toLowerCase(); }
  function isPlaceExtension(c) {
    var kind = kindOf(c);
    return kind === 'workshop' || kind === 'building' || kind === 'stockpile' || kind === 'zone';
  }
  function isUnitCand(c) { return kindOf(c) === 'unit'; }
  function isItemCand(c) { return kindOf(c) === 'item'; }
  function isBuildingCand(c) { var k = kindOf(c); return k === 'workshop' || k === 'building'; }
  function isListCell(c) { var k = kindOf(c); return k === 'unit-list' || k === 'item-list'; }
  // A rail cell is a native occupant kind: native's building scan excludes stockpiles and civzones.
  function isRailKind(c) { var k = kindOf(c); return k !== 'stockpile' && k !== 'zone'; }

  var UNIT_OVERFLOW = 6;     // U >= 6  -> one UNIT_LIST cell
  var BUDGET_BASE = 6;       // the item budget's starting value
  var BUDGET_FLOOR = 2;      // ...clamped here, never lower

  // Vermin are excluded from every count: native pushes one cell per vermin with no budget at all.
  function occupantLaw(candidates) {
    var cs = Array.isArray(candidates) ? candidates : [];
    var units = 0, items = 0, building = false;
    for (var i = 0; i < cs.length; i++) {
      if (isUnitCand(cs[i])) units++;
      else if (isItemCand(cs[i])) items++;
      else if (isBuildingCand(cs[i])) building = true;
    }
    var budget = units < UNIT_OVERFLOW ? BUDGET_BASE - units : BUDGET_BASE;
    if (building) budget -= 1;
    if (budget < BUDGET_FLOOR) budget = BUDGET_FLOOR;
    return { unitCount: units, itemCount: items, hasBuilding: building, budget: budget,
      unitsOverflow: units >= UNIT_OVERFLOW, itemsOverflow: items >= budget };
  }

  function overflowCell(kind, candidates) {
    var want = kind === 'unit-list' ? isUnitCand : isItemCand;
    return { kind: kind, id: -1,
      label: kind === 'unit-list' ? 'Units on this tile' : 'Items on this tile',
      entries: (Array.isArray(candidates) ? candidates : []).filter(want) };
  }

  // At most ONE building cell -- native stores a tile's building in a scalar -- and the FIRST
  // match wins, so a second building on a tile never repoints an already-opened click.
  function railCells(candidates, law) {
    var cs = Array.isArray(candidates) ? candidates : [];
    law = law || occupantLaw(cs);
    var out = [], unitsDone = false, itemsDone = false, buildingDone = false;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (!isRailKind(c)) continue;                       // never a stockpile, never a civzone
      if (isUnitCand(c) && law.unitsOverflow) {
        if (!unitsDone) { unitsDone = true; out.push(overflowCell('unit-list', cs)); }
        continue;
      }
      if (isItemCand(c) && law.itemsOverflow) {
        if (!itemsDone) { itemsDone = true; out.push(overflowCell('item-list', cs)); }
        continue;
      }
      if (isBuildingCand(c)) {                            // the building is a SCALAR
        if (buildingDone) continue;
        buildingDone = true;
      }
      out.push(c);
    }
    return out;
  }

  // A lone OVERFLOW cell survives suppression: it exists only because a category overflowed, so that
  // category's count is >= 2 and the tests below fail rather than never running.
  function railSuppressed(cells, law) {
    if (!cells.length) return true;
    return cells.length === 1 && law.unitCount < 2 && law.itemCount < 2;
  }

  // Which sheet a tile click OPENS -- distinct from the rail's display order, and why an item
  // resting on a stockpile opens the ITEM sheet.
  function initialCell(cells, law) {
    var i;
    if (law.unitsOverflow) for (i = 0; i < cells.length; i++) if (kindOf(cells[i]) === 'unit-list') return cells[i];
    for (i = 0; i < cells.length; i++) if (isUnitCand(cells[i])) return cells[i];
    for (i = 0; i < cells.length; i++) if (isBuildingCand(cells[i])) return cells[i];
    if (law.itemsOverflow) for (i = 0; i < cells.length; i++) if (kindOf(cells[i]) === 'item-list') return cells[i];
    for (i = 0; i < cells.length; i++) if (isItemCand(cells[i])) return cells[i];
    for (i = 0; i < cells.length; i++) if (kindOf(cells[i]) === 'vermin') return cells[i];
    for (i = 0; i < cells.length; i++)
      if (kindOf(cells[i]) === 'engraving' || kindOf(cells[i]) === 'planned-engraving') return cells[i];
    return cells[0] || null;   // defensive floor: every kind a cell can be is named above
  }

  // The rail DOM belongs to the session, not to whichever sheet is up: remove it only through
  // these helpers, or it is orphaned.
  function railWrapOf(host) {
    try {
      return host && typeof host.querySelector === 'function'
        ? host.querySelector('.occupant-tabs-wrap') : null;
    } catch (err) { DwfErr.report("unitcycle.find-rail", err); return null; }
  }
  function removeRail(host) {
    var wrap = railWrapOf(host);
    if (wrap && wrap.parentNode) {
      try { wrap.parentNode.removeChild(wrap); }
      catch (err) { DwfErr.report("unitcycle.remove-rail", err); }
    }
    if (host && host.classList) {
      try { host.classList.remove('has-occupant-rail'); }
      catch (err) { DwfErr.report("unitcycle.clear-rail-state", err); }
    }
  }
  function scrubRails() {
    try { removeRail(document.getElementById('selection')); }
    catch (err) { DwfErr.report("unitcycle.scrub-selection", err); }
    try { removeRail(document.getElementById('clientPanel')); }
    catch (err) { DwfErr.report("unitcycle.scrub-client-panel", err); }
  }
  function clearOccupantSession() { occupantSession = null; scrubRails(); }

  // Rebuild only when this signature changes: destroying the buttons mid-event would kill a click
  // on the tab that is already active.
  function occupantSig(session) {
    var parts = [];
    var cs = (session && session.cells) || [];
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i] || {};
      parts.push(candKey(c) + (c.spriteRef ? '+r' : '') + (c.spriteToken ? '+t' + c.spriteToken : '') +
        (c.iconKey || (c.icon && (c.icon.key || c.icon.sheet)) ? '+i' : ''));
    }
    return parts.join('|') + '||' + String(session && session.activeKey);
  }

  // A className write by any renderer wipes `has-occupant-rail`; heal it only when the sheet on
  // screen really is the active candidate's, or a foreign sheet wears the rail.
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
      try { sid = host.dataset ? host.dataset.dfcItemId : null; }
      catch (err) { DwfErr.report("unitcycle.item-dataset", err); }
      if (sid == null) {
        try { sid = host.getAttribute && host.getAttribute('data-dfc-item-id'); }
        catch (err) { DwfErr.report("unitcycle.item-attribute", err); }
      }
      return sid != null && Number(sid) === Number(cand.id);
    }
    if (kind === 'engraving') {
      try { return !!host.querySelector('.engraving-window'); }
      catch (err) { DwfErr.report("unitcycle.engraving-host", err); return false; }
    }
    if (kind === 'vermin') return host.classList.contains('vermin-sheet-panel');
    if (kind === 'planned-engraving') return host.classList.contains('planned-engraving-panel');
    if (isListCell(cand)) return host.classList.contains('occupant-list-panel');
    // Match place kinds on the panel FAMILY, not the id: openBuildingPanel delegates (a bed opens
    // its barracks zone panel), and an id-strict guard would kill the rail on those panels.
    return host.classList.contains('building-panel') || host.classList.contains('stockpile-panel');
  }

  // After a list drill-in the active occupant is not a rail cell, so no cell draws selected.
  function activeCandidate() { return (occupantSession && occupantSession.active) || null; }

  function activeHostEl() {
    try { return document.getElementById('selection'); }
    catch (err) { DwfErr.report("unitcycle.active-host", err); return null; }
  }

  function placeIconRow(c, kind) {
    if (c && c.icon && String(c.icon.sheet || '') === 'zone' &&
        isFinite(Number(c.icon.x)) && isFinite(Number(c.icon.y)))
      return { iconSheet: 'zone', iconX: Number(c.icon.x), iconY: Number(c.icon.y) };
    var key = c && (c.iconKey || (c.icon && c.icon.key));
    if (key) return { iconKey: String(key) };
    if ((kind === 'workshop' || kind === 'building') && typeof itemIconName === 'function') {
      try {
        var kw = itemIconName({ label: String(c && c.label || '') });
        if (kw) return { iconKey: kw };
      } catch (err) { DwfErr.report("unitcycle.item-icon", err); }
    }
    return null;
  }

  function occupantIconHtml(c, size) {
    if (c && typeof c.iconHtml === 'string' && c.iconHtml) return c.iconHtml;
    var px = Number(size) > 0 ? Number(size) : 40;
    var kind = String(c && c.kind || '').toLowerCase();
    if (isListCell(c)) {
      var members = Array.isArray(c.entries) ? c.entries : [];
      return members.length ? occupantIconHtml(members[0], px) : '';
    }
    if (kind === 'unit') {
      return '<img class="occupant-unit-icon" src="/unit-portrait?id=' + encodeURIComponent(Number(c.id)) +
        '&mode=icon" alt="" draggable="false">';
    }
    try {
      if (window.DWFUI && typeof window.DWFUI.iconHtml === 'function') {
        if (kind === 'item') return window.DWFUI.iconHtml({ item: c && c.spriteRef,
          cls: 'dwfui-occupant-icon', size: px, alt: String(c && c.label || 'Item') });
        if (c && c.spriteToken) return window.DWFUI.iconHtml({ sprite: String(c.spriteToken),
          cls: 'dwfui-occupant-icon', size: px, alt: String(c.label || kind) });
        if (typeof infoPlaceIconMarkup === 'function') {
          var row = placeIconRow(c, kind);
          if (row) {
            var markup = infoPlaceIconMarkup(row);
            if (markup) return markup;
          }
        }
        return window.DWFUI.iconHtml({ emptyTile: false, cls: 'dwfui-occupant-icon', size: px,
          alt: String(c && c.label || kind || 'Occupant') });
      }
    } catch { /* a failed sprite leaves an empty icon slot without dropping the chooser row */ }
    return '';
  }

  function occupantTabsCfg(session) {
    session = session || occupantSession;
    if (!session) return null;
    var cells = Array.isArray(session.cells) ? session.cells
      : (Array.isArray(session.candidates) ? railCells(session.candidates) : null);
    if (!cells) return null;
    return {
      dataAttr: 'occupant-tab',
      ariaLabel: 'Occupants on this tile', active: session.activeKey,
      tabs: cells.map(function (c) {
        return { key: candKey(c), title: String(c.label || c.kind), iconHtml: occupantIconHtml(c, 28) };
      }),
    };
  }

  function occupantStripHtml(session) {
    var cfg = occupantTabsCfg(session);
    if (!cfg) return '';
    try {
      if (window.DWFUI && typeof window.DWFUI.occupantRailHtml === 'function')
        return window.DWFUI.occupantRailHtml(cfg);
    } catch (err) { DwfErr.report("unitcycle.rail-markup", err); }
    return '';   // DWFUI loads first in index.html; never hand-roll a fallback
  }

  function occupantListCfg(candidates) {
    return { dataAttr: 'occupant-entry', ariaLabel: 'Occupants on this tile',
      entries: (Array.isArray(candidates) ? candidates : []).map(function (c) {
        return { key: candKey(c), name: String(c.label || c.kind || 'Occupant'),
          iconHtml: occupantIconHtml(c), extension: isPlaceExtension(c),
          extensionLabel: 'Extra browser destination' };
      }) };
  }

  function occupantListMarkup(candidates) {
    try {
      if (window.DWFUI && typeof window.DWFUI.occupantListHtml === 'function')
        return window.DWFUI.occupantListHtml(occupantListCfg(candidates));
    } catch (err) { DwfErr.report("unitcycle.list-markup", err); }
    return '';
  }

  function wireUnitPortraitErrors(content) {
    var imgs = content && typeof content.querySelectorAll === 'function'
      ? content.querySelectorAll('img.occupant-unit-icon') : [];
    for (var i = 0; i < imgs.length; i++) (function (img) {
      if (!img.addEventListener) return;
      var retried = false;
      img.addEventListener('error', function () {
        if (!retried) {
          retried = true;
          try { img.src = img.src.replace(/&_=/, '&old_=') + '&_=' + Date.now(); }
          catch (err) { DwfErr.report("unitcycle.portrait-retry", err); }
          return;
        }
        try {
          var well = img.parentNode;
          if (well && well.setAttribute) well.setAttribute('data-df-identity-missing', 'unit-portrait');
          if (well) well.removeChild(img);
        } catch (err) { DwfErr.report("unitcycle.portrait-fallback", err); }
      });
    })(imgs[i]);
  }

  function wireOccupantTabs(wrap) {
    var btns = (wrap && typeof wrap.querySelectorAll === 'function')
      ? wrap.querySelectorAll('[data-occupant-tab]') : [];
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var key = btn.getAttribute('data-occupant-tab');
        var cs = (occupantSession && occupantSession.cells) || [];
        // Clicking the already-active cell is a deliberate no-op, as in native.
        if (occupantSession && key === occupantSession.activeKey) return;
        for (var j = 0; j < cs.length; j++) if (candKey(cs[j]) === key) { switchToOccupant(cs[j]); return; }
      });
    })(btns[i]);
    wireUnitPortraitErrors(wrap);
  }

  function injectOccupantTabs() {
    var session = occupantSession;
    // A one-cell rail is legal; the fewer-than-two suppression happens in railSuppressed.
    if (!session || !Array.isArray(session.cells) || !session.cells.length) return;
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
    try { wrap.innerHTML = html; }
    catch (err) { DwfErr.report("unitcycle.rail-render", err); return; }
    try { if (wrap.setAttribute) wrap.setAttribute('data-occupant-sig', sig); }
    catch (err) { DwfErr.report("unitcycle.rail-signature", err); }
    host.classList.add('has-occupant-rail');
    wireOccupantTabs(wrap);
    try {
      if (window.DWFUI && typeof window.DWFUI.paintSprites === 'function') window.DWFUI.paintSprites(wrap);
    } catch (err) { DwfErr.report("unitcycle.rail-sprites", err); }
  }

  // The rail COEXISTS with this sheet: never scrub the rail here, or it vanishes under the list.
  function renderOccupantListSheet(cell) {
    var candidates = (cell && Array.isArray(cell.entries)) ? cell.entries : [];
    if (!candidates.length) return false;
    var sel = document.getElementById('selection');
    if (!sel) return false;
    chooserState = null;
    sel.className = 'visible occupant-list-panel';
    var content = (window.DFPanelFrame && typeof window.DFPanelFrame.contentEl === 'function')
      ? window.DFPanelFrame.contentEl(sel) : sel;
    var html = occupantListMarkup(candidates);
    if (!html || !(content && 'innerHTML' in content)) return false;
    content.innerHTML = html;
    var rows = typeof content.querySelectorAll === 'function'
      ? Array.from(content.querySelectorAll('[data-occupant-entry]')) : [];
    rows.forEach(function (row) {
      var key = row.getAttribute ? row.getAttribute('data-occupant-entry')
        : (row.dataset && row.dataset.occupantEntry);
      for (var i = 0; i < candidates.length; i++) {
        if (candKey(candidates[i]) !== key) continue;
        (function (candidate) {
          row.addEventListener('click', function (event) {
            event.preventDefault(); event.stopPropagation();
            switchToOccupant(candidate);
          });
        })(candidates[i]);
        break;
      }
    });
    wireUnitPortraitErrors(content);
    try { if (window.DWFUI && typeof window.DWFUI.mountDom === 'function') window.DWFUI.mountDom(content); }
    catch (err) { DwfErr.report("unitcycle.list-mount", err); }
    injectOccupantTabs();   // the rail rides on top of the list, like any other sheet
    return true;
  }

  function itemSiblingsOf(candidates) {
    var out = (candidates || []).filter(function (c) {
      return String(c.kind).toLowerCase() === 'item' && !c.disabled &&
        isFinite(Number(c.id)) && Number(c.id) >= 0;
    }).map(function (c) {
      return { id: Number(c.id), name: String(c.label || ('Item ' + c.id)), spriteRef: c.spriteRef || null };
    });
    return out.length > 1 ? out : null;
  }

  function openRoute(route, siblings) {
    if (!route) return false;
    if (route.flow === 'list') return renderOccupantListSheet(route.cell);
    if (route.flow === 'unit') { switchTo(route.id, null); return true; }
    if (route.flow === 'item') {
      try { if (typeof openItemPanel === 'function') openItemPanel(route.id, siblings || null); }
      catch (err) { DwfErr.report("unitcycle.open-item", err); }
      return true;
    }
    if (route.flow === 'engraving') {
      try { if (typeof openEngravingPanel === 'function') openEngravingPanel(route.tile, null); }
      catch (err) { DwfErr.report("unitcycle.open-engraving", err); }
      return true;
    }
    if (route.flow === 'vermin') {
      try { if (typeof openVerminPanel === 'function') openVerminPanel(route.data); }
      catch (err) { DwfErr.report("unitcycle.open-vermin", err); }
      return true;
    }
    if (route.flow === 'planned-engraving') {
      try { if (typeof openPlannedEngravingPanel === 'function') openPlannedEngravingPanel(route.tile); }
      catch (err) { DwfErr.report("unitcycle.open-planned-engraving", err); }
      return true;
    }
    try { if (typeof openInfoPlace === 'function') openInfoPlace(route.kind, route.id); }
    catch (err) { DwfErr.report("unitcycle.open-place", err); }
    return true;
  }

  // `candidates` must keep its array identity: refreshTileOccupants compares it by reference to
  // tell whether the world changed under an in-flight request.
  function openOccupants(candidates, pixel) {
    if (!Array.isArray(candidates) || !candidates.length) return false;
    var law = occupantLaw(candidates), cells = railCells(candidates, law);
    if (railSuppressed(cells, law)) return false;
    var first = initialCell(cells, law), route = first && routeForCandidate(first);
    if (!route) return false;
    chooserState = null;
    occupantSession = { candidates: candidates, cells: cells, law: law,
      active: first, activeKey: candKey(first), pixel: pixel || null };
    openRoute(route, itemSiblingsOf(candidates));
    return true;
  }

  function switchToOccupant(candidate) {
    if (!occupantSession || !candidate) return;
    var route = routeForCandidate(candidate);
    if (!route) return;
    occupantSession.active = candidate;
    occupantSession.activeKey = candKey(candidate);
    openRoute(route, itemSiblingsOf(occupantSession.candidates));
    injectOccupantTabs();
    if (occupantSession.pixel) refreshTileOccupants(occupantSession.pixel, occupantSession.candidates);
  }

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

  // The authoritative list can change the rail's SHAPE (the cache is blind to co-located items),
  // so re-run the whole law over it rather than trusting the rail already up.
  function adoptAuthoritativeOccupants(occ) {
    if (!occupantSession || !Array.isArray(occ) || occ.length < 2) return;
    var law = occupantLaw(occ), cells = railCells(occ, law);
    if (railSuppressed(cells, law)) { clearOccupantSession(); return; }
    occupantSession.candidates = occ;
    occupantSession.law = law;
    occupantSession.cells = cells;
    var prev = occupantSession.activeKey, i, still = null;
    for (i = 0; i < cells.length; i++) if (candKey(cells[i]) === prev) { still = cells[i]; break; }
    if (!still) for (i = 0; i < occ.length; i++) if (candKey(occ[i]) === prev) { still = occ[i]; break; }
    if (still) { occupantSession.active = still; injectOccupantTabs(); return; }
    // Re-open through initialCell, never occ[0]: occ[0] is the display top (a stockpile floor).
    var first = initialCell(cells, law) || cells[0];
    occupantSession.active = first;
    occupantSession.activeKey = candKey(first);
    openRoute(routeForCandidate(first), itemSiblingsOf(occ));
  }

  function renderChooser(candidates) {
    var sel = document.getElementById('selection');
    if (!sel) return false;
    chooserState = { candidates: candidates, index: 0 };
    sel.className = 'visible tile-list-panel';
    // Write into the .pf-content child, or this render destroys the panel framework's persistent
    // header and grips on #selection.
    var content = (typeof window !== "undefined" && window.DFPanelFrame && window.DFPanelFrame.contentEl)
      ? window.DFPanelFrame.contentEl(sel) : sel;
    var renderedRows = [];
    if (typeof content.querySelectorAll === "function" && "innerHTML" in content) {
      content.innerHTML = tileListMarkup(candidates);
      renderedRows = Array.from(content.querySelectorAll("[data-tile-candidate]"));
      renderedRows.forEach(function (row) {
        var candidate = candidates[Number(row.dataset.tileCandidate)];
        if (!candidate) return;
        row.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); chooseCandidate(candidate, candidates); });
      });
      if (renderedRows.length === candidates.length) return true;
    }
    DwfErr.report("tile-list.render-mismatch", new Error(
      "expected " + candidates.length + " rows, rendered " + renderedRows.length));
    if (content && "innerHTML" in content) content.innerHTML = window.DWFUI.statusHtml({
      cls: "tile-list-error", tone: "danger", role: "alert", text: "Tile occupant list unavailable",
    });
    return false;
  }

  // Old hosts 404 this route, so the cache-derived chooser stays as the fallback; keep the cache
  // list visible while the click-time request runs.
  function routeCandidates(payload) {
    var raw = payload && Array.isArray(payload.occupants) ? payload.occupants : [];
    var out = [], kinds = { unit: 1, workshop: 1, building: 1, stockpile: 1, zone: 1, item: 1,
                            engraving: 1 };
    for (var i = 0; i < raw.length; i++) {
      var row = raw[i] || {}, kind = String(row.kind || '').toLowerCase(), id = Number(row.id);
      if (!kinds[kind] || (kind !== 'engraving' && (!isFinite(id) || id < 0))) continue;
      out.push({ kind: kind, id: id, label: String(row.name || (kind + ' ' + id)),
        // Art fields, absent on older hosts; occupantIconHtml degrades per kind.
        spriteRef: row.spriteRef || null,
        spriteToken: row.spriteToken || null,
        tile: kind === 'engraving' && payload.tile ? payload.tile : null,
        icon: row.icon && typeof row.icon === 'object' ? row.icon
          : (kind === 'unit' ? '@' : kind === 'item' ? '*' : '#') });
    }
    return out;
  }

  function openedKeyFromInspect(data) {
    var kind = String(data && data.kind || '').toLowerCase();
    if (kind === 'unit' && data.unit && isFinite(Number(data.unit.id))) return 'unit:' + Number(data.unit.id);
    if (kind === 'item' && Number(data.itemId) >= 0) return 'item:' + Number(data.itemId);
    if (kind === 'engraving' && data.tile) return 'engraving:-1';
    if ((kind === 'stockpile' || kind === 'zone' || kind === 'workshop' || kind === 'building') &&
        Number(data.buildingId) >= 0) return kind + ':' + Number(data.buildingId);
    return null;
  }

  function discoverOccupants(data, pixel) {
    var opened = openedKeyFromInspect(data);
    if (!opened || !pixel || typeof fetch !== 'function') return;
    var px = Number(pixel.x), py = Number(pixel.y), w = Number(pixel.w), h = Number(pixel.h);
    if (!isFinite(px) || !isFinite(py) || !(w > 0) || !(h > 0)) return;
    var request = ++occupantRequest, pl = window.dwfPlayerIdentity("unitcycle");
    fetch('/tile-occupants?player=' + encodeURIComponent(pl) + '&px=' + encodeURIComponent(px) +
          '&py=' + encodeURIComponent(py) + '&w=' + encodeURIComponent(w) + '&h=' + encodeURIComponent(h) +
          '&t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw new Error('tile occupants unavailable'); return response.json(); })
      .then(function (payload) {
        if (request !== occupantRequest || occupantSession) return;   // a later click owns the flow
        var occ = routeCandidates(payload);
        if (!occ.length) return;
        var law = occupantLaw(occ), cells = railCells(occ, law);
        var onTile = false;
        for (var k = 0; k < occ.length; k++) if (candKey(occ[k]) === opened) { onTile = true; break; }
        if (!onTile) {
          // Deliberately NOT gated on occupant count: a lone item under a neighbouring dwarf gets no
          // rail and must still be the sheet that opens.
          var fixed = initialCell(cells, law) || cells[0] || occ[0];
          var fixedRoute = fixed && routeForCandidate(fixed);
          if (!fixedRoute) return;
          if (railSuppressed(cells, law)) { openRoute(fixedRoute, itemSiblingsOf(occ)); return; }
          occupantSession = { candidates: occ, cells: cells, law: law,
            active: fixed, activeKey: candKey(fixed), pixel: pixel };
          openRoute(fixedRoute, itemSiblingsOf(occ));
          injectOccupantTabs();
          return;
        }
        if (occ.length < 2) return;
        if (railSuppressed(cells, law)) return;
        for (var i = 0; i < occ.length; i++) {
          if (candKey(occ[i]) !== opened) continue;   // the payload must describe the clicked tile
          var start = initialCell(cells, law);
          if (!start) return;
          occupantSession = { candidates: occ, cells: cells, law: law,
            active: start, activeKey: candKey(start), pixel: pixel };
          if (candKey(start) !== opened) openRoute(routeForCandidate(start), itemSiblingsOf(occ));
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
    var request = ++occupantRequest, pl = window.dwfPlayerIdentity("unitcycle");
    fetch('/tile-occupants?player=' + encodeURIComponent(pl) + '&px=' + encodeURIComponent(px) +
          '&py=' + encodeURIComponent(py) + '&w=' + encodeURIComponent(w) + '&h=' + encodeURIComponent(h) +
          '&t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw new Error('tile occupants unavailable'); return response.json(); })
      .then(function (payload) {
        var candidates = routeCandidates(payload);
        if (request !== occupantRequest || candidates.length < 2 || !occupantSession || occupantSession.candidates !== cached) return;
        adoptAuthoritativeOccupants(candidates);
      })
      .catch(function () { /* 404/error: retain the cache-derived occupant session for older hosts. */ });
  }

  function consumeInspect(data, pixel) {
    var latest = null;
    try { latest = window.DwfTiles && typeof DwfTiles.getLatest === 'function' ? DwfTiles.getLatest() : null; }
    catch (err) { DwfErr.report("unitcycle.inspect-snapshot", err); }
    var candidates = buildCandidates(data, latest);
    if (candidates.length < 2) { clearOccupantSession(); discoverOccupants(data, pixel); return false; }
    if (!openOccupants(candidates, pixel)) {
      clearOccupantSession();
      discoverOccupants(data, pixel);
      return false;
    }
    refreshTileOccupants(pixel, candidates);
    return true;
  }

  window.DFTileList = { consumeInspect: consumeInspect, buildCandidates: buildCandidates,
    routeCandidates: routeCandidates, routeForCandidate: routeForCandidate,
    nextChooserIndex: nextChooserIndex, renderChooser: renderChooser,
    switchToOccupant: switchToOccupant, occupantListCfg: occupantListCfg,
    occupantTabsCfg: occupantTabsCfg, injectOccupantTabs: injectOccupantTabs,
    occupantLaw: occupantLaw, railCells: railCells, initialCell: initialCell,
    railSuppressed: railSuppressed, openOccupants: openOccupants,
    renderOccupantListSheet: renderOccupantListSheet, adoptAuthoritativeOccupants: adoptAuthoritativeOccupants,
    getOccupantSession: function () { return occupantSession; },
    clearOccupantSession: clearOccupantSession, noteOccupantArt: noteOccupantArt,
    tileListMarkup: tileListMarkup, occupantListMarkup: occupantListMarkup, unitCycleMarkup: unitCycleMarkup };

  var busy = false;
  function switchTo(id, units) {
    if (busy) return;
    busy = true;
    var pl = window.dwfPlayerIdentity("unitcycle");
    fetch("/unit?player=" + encodeURIComponent(pl) + "&id=" + encodeURIComponent(id) +
          "&t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("unit fetch failed"); return r.json(); })
      .then(function (d) {
        if (d && units) d.unitCycle = units.map(function (u) { return u.id; });
        try { if (typeof showUnitSheet === "function") showUnitSheet(d); }
        catch (err) { DwfErr.report("unitcycle.show-unit", err); }
      })
      .catch(function (err) { DwfErr.report("unitcycle.fetch-unit", err); })
      .then(function () { busy = false; });
  }

  function inject() {
    var sel = document.getElementById("selection");
    if (!sel || !sel.classList.contains("unit-sheet-panel")) return;
    var sheet = sel.querySelector(".unit-sheet");
    if (!sheet || sheet.querySelector(".unit-cycle")) return;   // already injected this render

    var data = currentSheetData();
    if (!data || !data.unit) return;
      // The rail is the switcher when it owns this unit: suppress the older unit-cycle bar so the
      // two never overlap.
    if (occupantSession && Array.isArray(occupantSession.cells) && occupantSession.cells.length) {
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

  // Capture phase, so Tab cycling wins over the page's own focus and keymap handling.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Tab") return;
    // A modal owns Tab completely. The chooser must yield before changing the hidden selection
    // behind it; the dialog's own bubble handler then performs its focus cycle.
    var help = document.getElementById("helpPopup");
    if (help && help.classList.contains("open")) return;
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
    if (occupantSession && sel &&
        sel.classList.contains("visible") && sel.classList.contains("has-occupant-rail")) {
      var cs = occupantSession.cells || [];
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
      var obsClose = new MutationObserver(function () {
        if (occupantSession && target.classList && !target.classList.contains("visible"))
          clearOccupantSession();
      });
      obsClose.observe(target, { attributes: true, attributeFilter: ["class"] });
    } catch { /* without MutationObserver, the Tab-key refresh path still injects the rail */ }
    inject();
    injectOccupantTabs();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
