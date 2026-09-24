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
//
// dwf-location-panel.js -- Location Details (Places > Locations) for a df::abstract_building.

  function _locEsc(s) {
    if (typeof DWFUI !== "undefined" && DWFUI && typeof DWFUI.esc === "function") return DWFUI.esc(s);
    if (typeof escapeHtml === "function") return escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function _locOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function _locNumber(obj, key) {
    if (!_locOwn(obj, key) || obj[key] == null || obj[key] === "") return null;
    var n = Number(obj[key]);
    return Number.isFinite(n) ? n : null;
  }

  var _locState = {
    id: -1, data: null, busy: false,
    pickerFor: null,   // occupation typeKey|id:<n> whose citizen picker is open
    deityOpen: false,
    guildOpen: false,
    search: "",
  };

  // ---- pure data-shapers (node-testable) ------------------------------------------------

  // Occupant counts (census gap 1). "inside" is a live footprint count over the location's civzones,
  // split the way DF splits people: your citizens, your long-term residents, and visitors.
  function occupancyText(data) {
    var o = data && data.occupancy;
    var inside = _locNumber(o, "inside");
    if (inside == null) return "Occupancy unavailable";
    inside = Math.max(0, inside);
    var parts = [];
    if (Number(o.citizens) > 0) parts.push(Number(o.citizens) + " citizen" + (Number(o.citizens) === 1 ? "" : "s"));
    if (Number(o.residents) > 0) parts.push(Number(o.residents) + " resident" + (Number(o.residents) === 1 ? "" : "s"));
    if (Number(o.visitors) > 0) parts.push(Number(o.visitors) + " visitor" + (Number(o.visitors) === 1 ? "" : "s"));
    if (Number(o.others) > 0) parts.push(Number(o.others) + " other");
    var head = inside === 0 ? "Nobody here right now" : (inside + " inside");
    return parts.length ? head + " · " + parts.join(", ") : head;
  }

  // A row with id < 0 is a VACANT catalogue slot. `verified:false` marks a slot we could not establish
  // for this location kind; the server refuses to create those, so the row says so rather than failing.
  function occupationRows(data) {
    var list = (data && Array.isArray(data.occupations)) ? data.occupations.filter(Boolean) : [];
    var allowNew = !!(data && data.allowNewSlots);
    return list.map(function (o) {
      var id = Number(o.id);
      var exists = Number.isFinite(id) && id >= 0;
      var verified = o.verified !== false;
      var canAssign = exists || verified || allowNew;
      return {
        key: exists ? ("id:" + id) : String(o.typeKey || ""),
        id: exists ? id : -1,
        label: String(o.label || o.typeKey || "Occupation"),
        holder: String(o.holder || ""),
        professionColor: Number(o.professionColor),
        assigned: !!o.assigned,
        unitId: Number(o.unitId) >= 0 ? Number(o.unitId) : -1,
        canAssign: canAssign,
        guarded: !canAssign,
        action: o.assigned ? "Reassign" : "Assign",
        typeKey: String(o.typeKey || ""),
      };
    });
  }

  // Temple-deity picker (census gap 3). Options are the deities/religions the fort's own living
  // citizens worship -- the same derivation native uses to fill its list.
  function deityRows(data) {
    var t = (data && data.temple) || null;
    if (!t) return null;
    var opts = Array.isArray(t.options) ? t.options.filter(Boolean) : [];
    return {
      dedicated: !!t.dedicated,
      name: String(t.name || ""),
      options: opts.map(function (o) {
        return {
          spec: String(o.mode || "") + ":" + Number(o.id),
          name: String(o.name || "Unknown"),
          worshippers: _locNumber(o, "worshippers"),
          current: !!o.current,
          kind: o.mode === "religion" ? "Religion" : "Deity",
        };
      }),
    };
  }

  // Craft-guild picker (census gap 3). abstract_building_contents.profession.
  function guildRows(data) {
    var g = (data && data.guild) || null;
    if (!g) return null;
    var opts = Array.isArray(g.options) ? g.options.filter(Boolean) : [];
    return {
      dedicated: !!g.dedicated,
      key: String(g.key || ""),
      options: opts.map(function (o) {
        return {
          key: String(o.key || ""),
          name: String(o.name || o.key || "Guild"),
          members: _locNumber(o, "members"),
          current: !!o.current,
        };
      }),
    };
  }

  // Rented rooms (census gap 4): the rental_roomst x service_orderst x civzone join.
  function roomRows(data) {
    var r = (data && data.rooms) || null;
    if (!r) return null;
    var roomsKnown = Array.isArray(r.rooms);
    var rooms = roomsKnown ? r.rooms.filter(Boolean) : [];
    return {
      canWrite: !!r.canWrite,
      roomsKnown: roomsKnown,
      rooms: rooms.map(function (m) {
        var owed = Math.max(0, Number(m.owed) || 0);
        return {
          id: Number(m.id),
          label: String(m.label || m.zoneName || ("Room " + m.id)),
          zoneName: String(m.zoneName || ""),
          rented: !!m.rented,
          renter: String(m.renter || ""),
          renterProfessionColor: Number(m.renterProfessionColor),
          owed: owed,
          status: m.rented
            ? (String(m.renter || "someone") + (owed > 0 ? " · owes " + owed + "¤" : " · paid up"))
            : "vacant",
        };
      }),
    };
  }

  // Appointed positions bound to this location (temple priests, guild reps): entity_position_
  // assignment.ab_id == location id. Read-only here; the write is the existing /noble-assign.
  function positionRows(data) {
    var list = (data && Array.isArray(data.positions)) ? data.positions.filter(Boolean) : [];
    return list.map(function (p) {
      return {
        positionId: Number(p.positionId),
        name: String(p.name || "Position"),
        holder: String(p.holder || ""),
        professionColor: Number(p.professionColor),
        vacant: !!p.vacant,
      };
    });
  }

  var LOCATION_ACCESS = [
    { key: "visitors", word: "VISITORS", label: "All visitors welcome", title: "This option allows visitors from outside the fortress to enter this location." },
    { key: "residents", word: "RESIDENTS", label: "", title: "This option allows long-term residents of the fortress to enter this location." },
    { key: "citizens", word: "CITIZENS", label: "", title: "This option indicates that the location is only open to fortress citizens." },
    { key: "members", word: "MEMBERS", label: "", title: "This option indicates the location is only open to members." },
  ];

  function locationAccessHtml(data) {
    var native = (data && data.native) || {};
    var rawCurrent = _locOwn(native, "accessMode") ? native.accessMode
      : (_locOwn(data, "restriction") ? data.restriction : null);
    var current = rawCurrent == null ? "" : String(rawCurrent);
    if (current === "everyone") current = "visitors";
    var enabled = !!(native.guards && native.guards.locationAccess);
    var selected = LOCATION_ACCESS.find(function (a) { return a.key === current; }) || null;
    var buttons = DWFUI.accessPolicyButtonsHtml({
      options: LOCATION_ACCESS, current: current, enabled: enabled, datasetKey: "locAccess",
    });
    var status = !selected
      ? DWFUI.statusHtml({ tag: "span", cls: "location-access-state", tone: "dim", text: "Access unavailable" })
      : (selected.label
        ? DWFUI.statusHtml({ tag: "span", cls: "location-access-state", tone: "good", text: selected.label })
        : "");
    var guard = enabled ? "" : DWFUI.statusHtml({
      tag: "span", cls: "location-access-guard", tone: "dim",
      text: "Read-only: the host has not enabled location access changes.",
    });
    return '<div class="location-access" aria-label="Location access">' + buttons + status + guard + '</div>';
  }

  function _locUnavailable(label, cls, reason) {
    return DWFUI.statusHtml({ cls: "location-mechanic " + (cls || ""), tone: "dim",
      text: label + ": unavailable" + (reason ? " (" + reason + ")" : "") });
  }

  function _locPerformerHtml(data, state) {
    var row = occupationRows(data).find(function (r) { return r.typeKey === "PERFORMER"; }) || null;
    var trailing = row && !row.guarded
      ? DWFUI.plaqueBtnHtml({ cls: "zone-mini-btn", tone: state.pickerFor === row.key ? "green" : "gold",
          dataset: { locAssign: row.key }, label: state.pickerFor === row.key ? "Close" : row.action })
      : DWFUI.plaqueBtnHtml({ cls: "zone-mini-btn", tone: "grey", disabled: true,
          title: row ? "This occupation slot is guarded until its native write is verified." : "Performer availability was not returned by the server.",
          label: "Assign" });
    return DWFUI.rowHtml({ chassis: "table", cls: "location-performer", dataset: { templeRow: "performer" },
      iconCfg: { sprite: "LOCATION_OCCUPATION_PERFORMER", size: 32, nativeCell: true, alt: "" },
      label: "Performer", sub: row ? null : { text: "unavailable", tone: "disabled" }, trailing: trailing }) +
      (row && state.pickerFor === row.key ? '<div class="location-picker">' + _locPickerHtml(state, row) + '</div>' : "");
  }

  function templeMechanicsHtml(data, state) {
    if (!data || data.kind !== "temple") return "";
    var native = data.native || {};
    var value = _locNumber(data, "value");
    var next = _locNumber(native, "nextValue");
    var tierName = _locOwn(native, "tierName") && native.tierName ? String(native.tierName) : "";
    var tierText = tierName && value != null && next != null && next > 0
      ? tierName + ", " + Math.floor(Math.max(0, value) * 100 / next) + "% (next at " + next + "☼)"
      : "Temple tier/value: unavailable";
    var stored = _locNumber(native, "countInstruments");
    var desired = _locNumber(native, "desiredInstruments");
    if (stored != null) stored = Math.max(0, stored);
    if (desired != null) desired = Math.max(0, desired);
    var instruments;
    if (stored == null || desired == null) {
      instruments = _locUnavailable("Stored Instruments (Desired)", "location-instrument-stepper");
    } else if (native.guards && native.guards.locationInstruments) {
      instruments = DWFUI.stepperHtml({ cls: "location-instrument-stepper", label: "Stored Instruments (Desired):",
        value: desired, valueText: stored + " (" + desired + ")", min: 0, max: 100, editable: false, art: true, hash: true,
        hashDataset: { locInstrumentEnter: desired }, plusDataset: { locInstruments: desired + 1 },
        minusDataset: { locInstruments: Math.max(0, desired - 1) } });
    } else {
      instruments = DWFUI.statusHtml({ cls: "location-mechanic location-instruments-guarded", tone: "dim",
        text: "Stored Instruments (Desired): " + stored + " (" + desired + ") — host-guarded" });
    }
    var danceWidth = _locNumber(native, "danceFloorWidth");
    var danceHeight = _locNumber(native, "danceFloorHeight");
    var dance = native.danceFloorKnown === true && danceWidth != null && danceHeight != null
      ? danceWidth + "x" + danceHeight : "unavailable";
    return '<div class="location-temple-mechanics">' +
      DWFUI.statusHtml({ cls: "location-mechanic location-tier", tone: "good", text: tierText }) +
      _locUnavailable("Worshippers", "location-worshippers", "interpretation unverified") +
      _locUnavailable("Chests in common area", "location-full", "interpretation unverified") +
      instruments +
      DWFUI.statusHtml({ cls: "location-mechanic location-full", text: "Dance floor in common area: " + dance }) +
      _locPerformerHtml(data, state || {}) + '</div>';
  }

  function tavernMechanicsHtml(data) {
    if (!data || data.kind !== "tavern") return "";
    var native = data.native || {};
    var stored = _locNumber(native, "countInstruments");
    var desired = _locNumber(native, "desiredInstruments");
    var instruments = (stored == null || desired == null)
      ? _locUnavailable("Stored Instruments (Desired)", "location-full location-instrument-stepper")
      : DWFUI.statusHtml({ cls: "location-mechanic location-full location-instruments-ro", tone: "dim",
          text: "Stored Instruments (Desired): " + Math.max(0, stored) + " (" + Math.max(0, desired) + ")" });
    // Reuses the existing location-mechanics grid, so tavern rows inherit the same full-width layout with
    // no new CSS.
    return '<div class="location-temple-mechanics location-tavern-mechanics">' +
      _locUnavailable("Chests in common area", "location-full", "interpretation unverified") +
      _locUnavailable("Goblets (Desired)", "location-full location-goblet", "host wire pending") +
      instruments +
      DWFUI.statusHtml({ cls: "location-mechanic location-full", text: "Dance floor in common area: unavailable" }) +
      '</div>';
  }

  // ---- markup -----------------------------------------------------------------------------

  // The rename quill is fail-closed: DF exposes no abstract_building rename route to the plugin, so the
  // affordance sits where native puts it, disabled, with a tooltip pointing at the Steam host.
  function _locHeader(title) {
    return DWFUI.headerHtml({
      cls: "building-head", title: title || "Location", titleCls: "building-name",
      tools: [{ role: "quill", disabled: true, cls: "location-rename",
        title: "Renaming a location isn't available in the browser yet — the host can rename it in the Steam client.",
        ariaLabel: "Rename location (host only)" }],
      close: { data: "location-close" },
    });
  }

  function _locTempleHeader(data) {
    var native = data.native || {};
    var lines = [String(data.name || data.label || "Location")];
    if (_locOwn(native, "tierName") && native.tierName) lines.push(String(native.tierName));
    var temple = data.temple;
    if (temple && _locOwn(temple, "mode")) {
      if (temple.mode === "none") lines.push("No particular deity");
      else if (temple.name) lines.push(String(temple.name));
      else lines.push("Dedication unavailable");
    }
    return DWFUI.headerHtml({ cls: "building-head location-temple-head",
      icon: DWFUI.iconHtml({ sprite: "ZONE_TEMPLE", size: 32, nativeCell: true, alt: "" }),
      titleLines: lines, titleCls: "building-name location-temple-head-copy", close: { data: "location-close" } });
  }

  function _locPickerHtml(state, row) {
    var cands = window.DwfLocationModel.candidateRows(state.data, state.search).rows;
    var rows = [
      '<div class="location-cand" data-loc-pick="-1" data-loc-slot="' + _locEsc(row.key) + '">— Vacant —</div>',
    ].concat(cands.map(function (c) {
      return '<div class="location-cand' + (c.unitId === row.unitId ? " current" : "") + '"' +
        ' data-loc-pick="' + c.unitId + '" data-loc-slot="' + _locEsc(row.key) + '">' +
        locationCandidateNameHtml(c) +
        (c.profession ? ' <span class="location-dim">' + DWFUI.bitmapTextHtml(c.profession) + '</span>' : "") +
        (c.held ? ' <span class="location-dim">' + DWFUI.bitmapTextHtml("(" + c.held + ")") + '</span>' : "") +
        '</div>';
    }));
    var body = cands.length ? rows.join("")
      : rows[0] + '<div class="dwfui-text--note building-note">No eligible living citizens.</div>';
    return DWFUI.searchHtml({ cls: "location-cand-search", dataAttr: "location-search", value: state.search,
      placeholder: "Search citizens" }) +
      DWFUI.scrollHtml({ cls: "location-cand-list" }, body);
  }

  function locationCandidateNameHtml(c) {
    var idx = Number(c && c.professionColor);
    var style = Number.isInteger(idx) && idx >= 0 && idx <= 15
      ? ' style="color:' + DWFUI.dfColor(idx) + '"' : '';
    return '<span class="location-cand-name"' + style + '>' + _locEsc(c && c.name) + '</span>';
  }

  function locationColoredNameHtml(record, name, cls) {
    var idx = Number(record && record.professionColor);
    var style = Number.isInteger(idx) && idx >= 0 && idx <= 15
      ? ' style="color:' + DWFUI.dfColor(idx) + '"' : '';
    return '<span' + (cls ? ' class="' + _locEsc(cls) + '"' : '') + style + '>' +
      _locEsc(name) + '</span>';
  }

  function locationDedicationHtml(data, state) {
    var s = state || {};
    var t = deityRows(data);
    if (!t) return "";
    var html = '<div class="dwfui-text--section zone-section-label">Dedication</div>';
    if (t.dedicated) {
      return html + '<div class="dwfui-text--note building-note">Dedicated to ' +
        _locEsc(t.name || "an unknown power") + '.</div>' +
        '<div class="dwfui-text--note building-note location-dim">Dwarf Fortress has no re-dedication: retire this temple and make a new one to change it.</div>';
    }
    if (!t.options.length) {
      return html +
        '<div class="dwfui-text--note building-note">A generic temple. Nobody in the fort worships anyone yet, so there is nothing to dedicate it to.</div>';
    }
    html += '<div class="dwfui-text--note building-note">A generic temple — any worshipper may use it. Dedicating it is permanent.</div>' +
      DWFUI.plaqueBtnHtml({ cls: "building-btn", tone: s.deityOpen ? "green" : "gold",
        dataset: { locAct: "deity-toggle" },
        label: s.deityOpen ? "Close" : "Dedicate to a deity or religion" });
    if (s.deityOpen) {
      html += DWFUI.scrollHtml({ cls: "location-cand-list" },
        t.options.map(function (o) {
          return '<div class="location-cand" data-loc-deity="' + _locEsc(o.spec) + '">' +
            '<span class="location-cand-name">' + _locEsc(o.name) + '</span>' +
            ' <span class="location-dim">' + DWFUI.bitmapTextHtml(o.kind + " · " + o.worshippers +
            " worshipper" + (o.worshippers === 1 ? "" : "s")) + '</span></div>';
        }).join(""));
    }
    return html;
  }

  function locationPanelMarkup(state) {
    var s = state || {};
    var d = s.data;
    if (!d) return _locHeader("Location") + '<div class="building-status">Loading location…</div>';
    if (d.ok === false)
      return _locHeader("Location") + '<div class="building-status err">' + _locEsc(d.error || "Location unavailable.") + '</div>';

    // A failed write must be SURFACED: it used to set s.error and vanish, so the panel re-rendered
    // unchanged and the player never learned the action was rejected. Every action clears it before retrying.
    var errHtml = s.error
      ? DWFUI.statusHtml({ cls: "location-action-error", tone: "danger", role: "alert", live: "assertive",
          text: String(s.error) })
      : "";

    // The temple sheet is dedicated, not the generic summary with rows prepended -- but an un-dedicated
    // temple with served options must keep its dedication picker rather than lose it at this early return.
    if (d.kind === "temple") {
      return _locTempleHeader(d) + errHtml + locationAccessHtml(d) + templeMechanicsHtml(d, s) +
        locationDedicationHtml(d, s);
    }

    // DEF-080 WIRE GAP: distinct location ids can arrive with the same server-resolved name. Render the
    // served name verbatim -- a client-side suffix would hide the bad payload and drift between surfaces.
    var head = _locHeader(d.name || d.label || "Location");
    var accessHtml = locationAccessHtml(d);
    var status = '<div class="building-status">' + _locEsc(d.label || "Location") +
      (Number(d.tier) > 0 ? " · tier " + Number(d.tier) : "") +
      (Number(d.value) > 0 ? " · value " + Number(d.value) : "") + '</div>';

    // Occupants.
    var zonesKnown = Array.isArray(d.zones);
    var zones = zonesKnown ? d.zones : [];
    var occHtml = '<div class="dwfui-text--section zone-section-label">Occupants</div>' +
      '<div class="dwfui-text--note building-note">' + _locEsc(occupancyText(d)) + '</div>' +
      '<div class="dwfui-text--note building-note location-dim">' +
        (!zonesKnown ? "Zone information unavailable."
        : zones.length ? _locEsc(zones.length + " zone" + (zones.length === 1 ? "" : "s") + ": " +
          zones.map(function (z) { return z.name || z.type; }).join(", "))
        : "No zones attached — this location has no floor space yet.") + '</div>';

    // Occupations + citizen picker.
    var occupationsKnown = Array.isArray(d.occupations);
    var rows = occupationRows(d);
    var occListHtml = !occupationsKnown ? '<div class="dwfui-text--note building-note">Occupation information unavailable.</div>'
      : rows.length ? rows.map(function (r) {
      var right = r.guarded
        ? DWFUI.plaqueBtnHtml({ cls: "zone-mini-btn", tone: "grey", disabled: true,
            title: "This occupation slot is guarded until its native write is verified.", label: r.action })
        : DWFUI.plaqueBtnHtml({ cls: "zone-mini-btn", tone: s.pickerFor === r.key ? "green" : "gold",
            dataset: { locAssign: r.key }, label: s.pickerFor === r.key ? "Close" : r.action });
      return '<div class="location-occ" data-loc-occ="' + _locEsc(r.key) + '">' +
        '<span class="location-occ-label">' + _locEsc(r.label) + '</span>' +
        (r.assigned ? locationColoredNameHtml(r, r.holder || "assigned", "location-occ-holder")
          : '<span class="location-occ-holder"><em>open</em></span>') +
        right + '</div>' +
        (s.pickerFor === r.key ? '<div class="location-picker">' + _locPickerHtml(s, r) + '</div>' : "");
    }).join("") : '<div class="dwfui-text--note building-note">This kind of location has no staff positions.</div>';
    var occupationsHtml = '<div class="dwfui-text--section zone-section-label">Occupations</div>' + occListHtml;

    // Temple deity (kept for defensive partial payloads whose kind is not normalized yet).
    var templeHtml = locationDedicationHtml(d, s);

    // Craft guild.
    var guildHtml = "";
    var g = guildRows(d);
    if (g) {
      guildHtml = '<div class="dwfui-text--section zone-section-label">Guild</div>';
      if (g.dedicated) {
        guildHtml += '<div class="dwfui-text--note building-note">Serves the ' + _locEsc(g.key) + ' guild.</div>';
      } else if (!g.options.length) {
        guildHtml += '<div class="dwfui-text--note building-note">No guild has formed in this fort yet. Guilds petition you once enough citizens share a craft.</div>';
      } else {
        guildHtml += DWFUI.plaqueBtnHtml({ cls: "building-btn", tone: s.guildOpen ? "green" : "gold",
          dataset: { locAct: "guild-toggle" }, label: s.guildOpen ? "Close" : "Assign this hall to a guild" });
        if (s.guildOpen) {
          guildHtml += DWFUI.scrollHtml({ cls: "location-cand-list" },
            g.options.map(function (o) {
              return '<div class="location-cand" data-loc-guild="' + _locEsc(o.key) + '">' +
                '<span class="location-cand-name">' + _locEsc(o.name) + '</span>' +
                ' <span class="location-dim">' + _locEsc(o.key) + " · " + o.members +
                " member" + (o.members === 1 ? "" : "s") + '</span></div>';
            }).join(""));
        }
      }
    }

    // Rented rooms.
    var roomsHtml = "";
    var rm = roomRows(d);
    if (rm) {
      // Native shows an inline "Rented rooms (Total): <rented> (<total>)" count (LEVER-LINK-2). We
      // keep the richer per-room list below it, but honor the native header count when rooms are known.
      var rentedNow = rm.roomsKnown ? rm.rooms.filter(function (m) { return m.rented; }).length : 0;
      roomsHtml = '<div class="dwfui-text--section zone-section-label">' +
        (rm.roomsKnown ? 'Rented rooms (Total): ' + rentedNow + ' (' + rm.rooms.length + ')' : 'Rented rooms') +
        '</div>';
      roomsHtml += !rm.roomsKnown ? '<div class="dwfui-text--note building-note">Rented-room information unavailable.</div>'
        : rm.rooms.length ? rm.rooms.map(function (m) {
        var renterHtml = m.rented
          ? locationColoredNameHtml({ professionColor: m.renterProfessionColor }, m.renter || "someone", "location-room-renter") +
            '<span class="location-dim">' + _locEsc(m.owed > 0 ? " - owes " + m.owed : " - paid up") + '</span>'
          : '<span class="location-dim">vacant</span>';
        return '<div class="location-room"><span class="location-occ-label">' + _locEsc(m.label) + '</span>' + renterHtml + '</div>';
      }).join("") : '<div class="dwfui-text--note building-note">No rentable rooms. DF makes one when a bedroom zone belongs to this tavern and a guest pays for it.</div>';
      if (!rm.canWrite)
        roomsHtml += '<div class="dwfui-text--note building-note location-dim">Rooms are read-only here (B229 probe 4).</div>';
    }

    // Appointed positions.
    var pos = positionRows(d);
    var posHtml = pos.length ? '<div class="dwfui-text--section zone-section-label">Appointed positions</div>' +
      pos.map(function (p) {
        return '<div class="location-occ"><span class="location-occ-label">' + _locEsc(p.name) + '</span>' +
          (p.vacant ? '<span class="location-occ-holder"><em>vacant</em></span>'
            : locationColoredNameHtml(p, p.holder, "location-occ-holder")) + '</div>';
      }).join("") : "";

    // tavernMechanicsHtml is inert ("") for library and guildhall kinds, which native gives no such cluster.
    return head + errHtml + accessHtml + tavernMechanicsHtml(d) + status + occHtml + occupationsHtml +
      templeHtml + guildHtml + roomsHtml + posHtml;
  }

  // ---- transport + wiring -----------------------------------------------------------------

  async function _locFetch(path) {
    var r = await fetch(path, { cache: "no-store" });
    var text = await r.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("location-panel.response-parse"); }
    if (!r.ok) throw new Error(text.trim() || "request failed");
    return data;
  }

  async function _locPost(path) {
    var r = await fetch(path, { method: "POST", cache: "no-store" });
    var text = await r.text();
    if (!r.ok) throw new Error(text.trim() || "request failed");
    return text;
  }

  async function _locReload() {
    try {
      _locState.data = await _locFetch("/location-detail?id=" + _locState.id + "&t=" + Date.now());
    } catch (err) {
      _locState.data = { ok: false, error: (err && err.message) || "location unavailable" };
    }
  }

  function _locRender() {
    if (typeof selection === "undefined") return;
    selection.className = "visible building-panel zone-panel zone-wide";
    panelContent(selection).innerHTML = locationPanelMarkup(_locState);
    if (DWFUI.mountScrollbarArt) DWFUI.mountScrollbarArt(selection);
    _locWire();
  }

  async function openLocationPanel(locationId) {
    var id = Number(locationId);
    if (!Number.isFinite(id) || id < 0) return;
    _locState = { id: id, data: null, busy: false, pickerFor: null, deityOpen: false, guildOpen: false, search: "" };
    _locRender();
    await _locReload();
    // A hospital has its native one-page facility panel (supplies, posts, doctors) -- hand off.
    if (_locState.data && _locState.data.kind === "hospital" && typeof openHospitalPanel === "function") {
      openHospitalPanel(id, { name: _locState.data.name, locationData: _locState.data });
      return;
    }
    _locRender();
  }

  async function _locDo(query) {
    if (_locState.busy) return;
    _locState.busy = true;
    _locState.error = null;
    try { await _locPost("/location-action?id=" + _locState.id + "&" + query + "&t=" + Date.now()); }
    catch (err) { _locState.error = (err && err.message) || "action failed"; }
    await _locReload();
    _locState.busy = false;
    _locRender();
    if (typeof focusPage === "function") focusPage();
  }

  async function _locNativeDo(query) {
    if (_locState.busy) return;
    _locState.busy = true;
    _locState.error = null;
    try { await _locPost("/location-native-action?id=" + _locState.id + "&" + query + "&t=" + Date.now()); }
    catch (err) { _locState.error = (err && err.message) || "native location action failed"; }
    await _locReload();
    _locState.busy = false;
    _locRender();
    if (typeof focusPage === "function") focusPage();
  }

  function _locWire() {
    if (typeof selection === "undefined") return;
    var s = _locState;
    var close = selection.querySelector("[data-location-close]");
    if (close) close.addEventListener("click", function (e) {
      e.stopPropagation();
      if (typeof closeSelection === "function") closeSelection();
      if (typeof focusPage === "function") focusPage();
    });

    selection.querySelectorAll("[data-loc-assign]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var key = btn.getAttribute("data-loc-assign");
        s.pickerFor = (s.pickerFor === key) ? null : key;
        s.search = "";
        _locRender();
      });
    });

    selection.querySelectorAll("[data-loc-act]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var act = btn.getAttribute("data-loc-act");
        if (act === "deity-toggle") s.deityOpen = !s.deityOpen;
        if (act === "guild-toggle") s.guildOpen = !s.guildOpen;
        _locRender();
      });
    });

    selection.querySelectorAll("[data-loc-access]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        await _locNativeDo("action=access&mode=" + encodeURIComponent(btn.getAttribute("data-loc-access") || ""));
      });
    });

    selection.querySelectorAll("[data-loc-instruments]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        await _locNativeDo("action=instruments&value=" + encodeURIComponent(btn.getAttribute("data-loc-instruments") || "0"));
      });
    });
    selection.querySelectorAll("[data-loc-instrument-enter]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        var current = btn.getAttribute("data-loc-instrument-enter") || "0";
        var entered = window.prompt("Desired stored instruments", current);
        if (entered == null || !/^\d+$/.test(entered.trim())) return;
        await _locNativeDo("action=instruments&value=" + encodeURIComponent(entered.trim()));
      });
    });

    // Occupation assignment (the write). slot is either a typeKey (vacant catalogue row) or
    // "id:<occupationId>" (a slot DF already made); unit -1 vacates.
    selection.querySelectorAll("[data-loc-pick]").forEach(function (el) {
      el.addEventListener("click", async function (e) {
        e.stopPropagation();
        var unit = el.getAttribute("data-loc-pick");
        var slot = el.getAttribute("data-loc-slot") || "";
        s.pickerFor = null;
        await _locDo("action=occupation-assign&kind=" + encodeURIComponent(slot) + "&unit=" + encodeURIComponent(unit));
      });
    });

    selection.querySelectorAll("[data-loc-deity]").forEach(function (el) {
      el.addEventListener("click", async function (e) {
        e.stopPropagation();
        s.deityOpen = false;
        await _locDo("action=deity&kind=" + encodeURIComponent(el.getAttribute("data-loc-deity") || ""));
      });
    });

    selection.querySelectorAll("[data-loc-guild]").forEach(function (el) {
      el.addEventListener("click", async function (e) {
        e.stopPropagation();
        s.guildOpen = false;
        await _locDo("action=guild&kind=" + encodeURIComponent(el.getAttribute("data-loc-guild") || ""));
      });
    });

    var search = selection.querySelector("[data-location-search]");
    if (search) search.addEventListener("input", function () {
      s.search = search.value || "";
      _locRender();
      var next = selection.querySelector("[data-location-search]");
      if (next) { next.focus(); try { next.setSelectionRange(next.value.length, next.value.length); } catch { globalThis.DwfErr?.count("location-panel.search-caret"); } }
    });
  }

  if (typeof window !== "undefined") {
    window.openLocationPanel = openLocationPanel;
    window.DFLocationMarkup = { locationPanelMarkup: locationPanelMarkup, locationAccessHtml: locationAccessHtml };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      occupancyText, occupationRows, deityRows, guildRows, roomRows, positionRows,
      candidateRows: DwfLocationModel.candidateRows,
      locationCandidateNameHtml,
      locationColoredNameHtml,
      locationAccessHtml, templeMechanicsHtml, tavernMechanicsHtml, locationDedicationHtml,
      locationPanelMarkup,
    };
  }
